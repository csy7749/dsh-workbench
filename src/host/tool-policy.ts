/**
 * 工具策略 · 宿主层
 *
 * 三件事：
 *  1. 持久化：<dataDir>/dsh-workbench/tool-policy.json（只存偏离默认值的覆盖，天然可回退）；
 *  2. 判定：把「哪个会话属于哪次派发」解析出来，再按该次派发的工具档位求值；
 *  3. 拦截：挂 `tools/pre-execute` 全局闸门。这是唯一能同时挡住
 *     DSH 内建工具（bash/read/write/web_fetch）与工作台自己工具的位置；
 *     run_code 里的子调用同样会经过这里（exec.parent 非空），无法绕过。
 *
 * 会话归属：派发会话由前端创建后写回 agent_dispatches.session_id；
 * 主理人派生的下属会话带 session.header.parentSession，向上走最多 8 层即可命中。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_TOOL_POLICY, buildToolPolicyView, describePolicyForPrompt, mergeToolPolicy, normalizeToolPolicy,
  normalizeProfile, profileForFeature, resolveTool,
  type ToolPolicy, type ToolPolicyView,
} from '../shared/tool-policy.js'

const MAX_SESSION_HOPS = 8
const PROFILE_CACHE_MS = 5000
const MAX_BLOCKED = 50
/* 没有归属到团队派发的会话（含用户自己的会话）一律不受限。 */
const FULL_PROFILE = 'full'

export interface ToolPolicyHostOptions {
  dataDir: string
  /** 当前已注册的工具名（由 ctx.tools.schemas() 提供；不可用时返回空数组） */
  listTools?: () => string[]
  /** AgentStore：用来按 sessionId 查派发（含 toolProfile） */
  dispatchBySession?: (sessionId: string) => { id: string; toolProfile: string; feature: string } | null
  log?: (message: string) => void
}

export interface BlockedCall {
  at: string
  tool: string
  code: string
  reason: string
  profile: string
  sessionId: string
}

function nowText(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export class ToolPolicyStore {
  readonly file: string
  private cache: ToolPolicy | null = null
  private readonly log: (message: string) => void

  constructor(dataDir: string, log?: (message: string) => void) {
    this.file = join(dataDir, 'dsh-workbench', 'tool-policy.json')
    this.log = log ?? (() => undefined)
  }

  read(): ToolPolicy {
    if (this.cache !== null) return this.cache
    try {
      if (existsSync(this.file)) {
        this.cache = normalizeToolPolicy(JSON.parse(readFileSync(this.file, 'utf8')))
        return this.cache
      }
    } catch (cause) {
      this.log(`[dsh-workbench] 工具策略读取失败，回落到默认：${String(cause)}`)
    }
    this.cache = normalizeToolPolicy(DEFAULT_TOOL_POLICY)
    return this.cache
  }

  write(next: ToolPolicy): ToolPolicy {
    const policy = normalizeToolPolicy(next)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(policy, null, 2), 'utf8')
      renameSync(tmp, this.file)
      this.cache = policy
    } catch (cause) {
      this.log(`[dsh-workbench] 工具策略写入失败：${String(cause)}`)
      throw new Error(`工具策略写入失败：${String(cause)}`)
    }
    return policy
  }

  merge(patch: unknown): ToolPolicy {
    return this.write(mergeToolPolicy(this.read(), patch))
  }

  reset(): ToolPolicy {
    return this.write(normalizeToolPolicy(DEFAULT_TOOL_POLICY))
  }

  /** 单个工具开关：与默认值相同就删掉条目，避免存一堆无意义的 true。 */
  setToolEnabled(name: string, enabled: boolean): ToolPolicy {
    const current = this.read()
    const overrides = { ...current.overrides }
    if (enabled) delete overrides[name]
    else overrides[name] = false
    return this.write({ ...current, overrides })
  }

  setCapability(capability: string, enabled: boolean): ToolPolicy {
    const current = this.read()
    const capabilities = { ...current.capabilities }
    if (enabled) delete capabilities[capability]
    else capabilities[capability] = false
    return this.write({ ...current, capabilities })
  }

  /**
   * 按功能指定档位。空字符串 = 跟随默认档（删掉这条覆盖）。
   * 注意 'full' 是要**显式存下来**的：默认档可能是 read-only，此时「这个功能全开」必须能表达，
   * 不能把它当成「没配置」。
   */
  setFeatureProfile(feature: string, profile: string): ToolPolicy {
    const current = this.read()
    const featureProfiles = { ...current.featureProfiles }
    const raw = String(profile ?? '').trim()
    if (raw === '') delete featureProfiles[feature]
    else featureProfiles[feature] = normalizeProfile(raw)
    return this.write({ ...current, featureProfiles })
  }

  profileFor(feature: string): string {
    return profileForFeature(this.read(), feature)
  }

  describeForPrompt(names: readonly string[], profile: string): string {
    return describePolicyForPrompt(names, this.read(), profile)
  }
}

/**
 * 从子会话向上找会话链（含自身），用于把工具调用归属到某次派发。
 * parentSession 只给 id，要继续上溯得借 ctx.agents.get(id) 拿回会话对象；
 * 拿不到就保留已收集的 id 后停止（至少能覆盖「主理人 → 下属」这一层）。
 */
export function sessionChain(ctx: any, agent: any): string[] {
  const chain: string[] = []
  let current: any = agent
  for (let hop = 0; hop < MAX_SESSION_HOPS; hop++) {
    let id = ''
    let parent = ''
    try {
      id = String(current?.session?.header?.id ?? current?.id ?? '')
      parent = String(current?.session?.header?.parentSession ?? '')
    } catch { break }
    if (id !== '' && !chain.includes(id)) chain.push(id)
    if (parent === '' || chain.includes(parent)) break
    chain.push(parent)
    let next: any = null
    try { next = ctx?.agents?.get?.(parent) ?? null } catch { next = null }
    if (next === null || next === undefined) break
    current = next
  }
  return chain
}

export interface ToolGateDeps {
  store: ToolPolicyStore
  resolveProfileForAgent: (agent: any, ctx?: any) => string
  onBlocked?: (call: BlockedCall) => void
}

/**
 * 安装全局工具闸门。返回卸载函数。
 * 只做「拒绝」，不改参数、不弹审批——审批是宿主 approval 的职责。
 */
export function installToolGate(ctx: any, deps: ToolGateDeps): () => void {
  if (typeof ctx?.on !== 'function') return () => undefined
  const listener = (exec: any, next: () => Promise<any>): any => {
    if (exec === undefined || typeof next !== 'function') return next()
    const name = String(exec.name ?? '')
    if (name === '') return next()
    let agent: any
    try { agent = exec.agent } catch { agent = undefined }
    /* 没有 agent（宿主内部调用）不做限制：这不是模型发起的调用。 */
    if (agent === undefined || agent === null) return next()
    let profile = 'full'
    try { profile = deps.resolveProfileForAgent(agent, ctx) } catch { profile = 'full' }
    let decision
    try { decision = resolveTool(name, deps.store.read(), profile) } catch { return next() }
    if (decision.allowed) return next()
    let sessionId = ''
    try { sessionId = String(agent?.session?.header?.id ?? agent?.id ?? '') } catch { sessionId = '' }
    try {
      deps.onBlocked?.({
        at: nowText(), tool: name, code: decision.code, reason: decision.reason, profile, sessionId,
      })
    } catch { /* 记录失败不影响拒绝 */ }
    return Promise.resolve({
      kind: 'deny',
      reason: `工具 ${name} 本次不可用：${decision.reason}。改用可用工具，或请用户在工作台「工具」里放开。`,
      info: { name: 'tool_policy', code: decision.code },
    })
  }
  const install = (): (() => void) => ctx.on('tools/pre-execute', listener)
  if (typeof ctx.effect === 'function') return ctx.effect(install) ?? (() => undefined)
  return install()
}

/* ------------------------------------------------------------------ */
/* 注册期守卫：让被禁用的工具连「模型可见的工具声明」都不出现              */
/* ------------------------------------------------------------------ */

interface ActivePolicy {
  allow: (name: string, agent: any, ctx?: any) => { allowed: boolean; reason: string }
}

let activePolicy: ActivePolicy | null = null

/** 由 createToolPolicyModule 在创建时安装；未安装时所有工具照旧注册。 */
export function setActiveToolPolicy(impl: ActivePolicy | null): void {
  activePolicy = impl
}

/**
 * 注册工具时统一走这里：登记 definition，并挂一个 `when`，
 * 使「当前会话所属派发的档位不允许」的工具既不进模型声明也不进 dispatch。
 * `when` 里现查 activePolicy（而不是注册时捕获），这样工具注册顺序不影响生效；
 * 拿不到策略或 agent 上下文时一律放行（宁可漏挡，不可误挡——真正的兜底是 pre-execute 闸门）。
 */
export function registerGuardedTool(ctx: any, definition: any, label: string): void {
  const register = (): any => {
    const name = typeof definition === 'object' && definition !== null ? String(definition.name ?? '') : ''
    if (name === '') return ctx.tools.register(definition)
    return ctx.tools.register(definition, {
      when: (context: any): boolean => {
        const policy = activePolicy
        if (policy === null) return true
        try { return policy.allow(name, context?.agent, ctx).allowed } catch { return true }
      },
    })
  }
  if (typeof ctx.effect === 'function') ctx.effect(register, label)
  else register()
}

/** 给「一个工具注册了多次」的函数用：返回绑定好的注册函数。 */
export function guardedRegister(ctx: any): (definition: any, label: string) => void {
  return (definition: any, label: string) => registerGuardedTool(ctx, definition, label)
}

export interface ToolPolicyModule {
  store: ToolPolicyStore
  view: (profile?: string) => ToolPolicyView
  profileForFeature: (feature: string) => string
  describeForPrompt: (profile: string) => string
  installGate: (ctx: any) => () => void
  handle: (req: any, res: any, path: string, method: string, url: URL) => Promise<boolean>
  blocked: () => BlockedCall[]
}

export function createToolPolicyModule(options: ToolPolicyHostOptions): ToolPolicyModule {
  const store = new ToolPolicyStore(options.dataDir, options.log)
  const cache = new Map<string, { at: number; profile: string }>()
  const blocked: BlockedCall[] = []
  const listTools = (): string[] => {
    try {
      const names = options.listTools?.() ?? []
      return [...new Set(names.filter(name => typeof name === 'string' && name !== ''))].sort()
    } catch { return [] }
  }

  /**
   * 会话 → 派发 → 工具档。
   * 只有「归属到某次团队派发」的会话才受限；用户自己那个会话、以及任何非工作台派发的会话一律 full。
   * 这是刻意的：用户在工作台里把默认档调成 read-only，意思是「派出去的团队收窄」，
   * 不是「把我自己这个会话的 bash 也锁掉」——把自己锁住是回不来的危险默认。
   */
  function profileForSession(sessionId: string): string {
    if (sessionId === '') return FULL_PROFILE
    const hit = cache.get(sessionId)
    if (hit !== undefined && Date.now() - hit.at < PROFILE_CACHE_MS) return hit.profile
    let profile = FULL_PROFILE
    try {
      const dispatch = options.dispatchBySession?.(sessionId) ?? null
      if (dispatch !== null && dispatch.toolProfile !== '') profile = normalizeProfile(dispatch.toolProfile)
    } catch { /* 查不到就不限制 */ }
    cache.set(sessionId, { at: Date.now(), profile })
    if (cache.size > 500) {
      const cutoff = Date.now() - PROFILE_CACHE_MS
      for (const [key, value] of cache) if (value.at < cutoff) cache.delete(key)
    }
    return profile
  }

  function resolveProfileForAgent(agent: any, ctx?: any): string {
    for (const sessionId of sessionChain(ctx, agent)) {
      try {
        const dispatch = options.dispatchBySession?.(sessionId) ?? null
        if (dispatch !== null && dispatch.toolProfile !== '') return normalizeProfile(dispatch.toolProfile)
      } catch { /* 继续往上找 */ }
    }
    let own = ''
    try { own = String(agent?.session?.header?.id ?? agent?.id ?? '') } catch { own = '' }
    return profileForSession(own)
  }

  /* 注册期守卫：与闸门同源，保证「模型看不到」与「调不动」判定一致。 */
  setActiveToolPolicy({
    allow: (name: string, agent: any) => {
      try {
        const decision = resolveTool(name, store.read(), resolveProfileForAgent(agent))
        return { allowed: decision.allowed, reason: decision.reason }
      } catch { return { allowed: true, reason: '' } }
    },
  })

  function view(profile?: string): ToolPolicyView {
    const names = listTools()
    const active = profile ?? normalizeProfile(store.read().defaultProfile)
    return buildToolPolicyView(names, store.read(), active)
  }

  function handle(req: any, res: any, path: string, method: string, url: URL): Promise<boolean> {
    if (path !== '/tools' && !path.startsWith('/tools/')) return Promise.resolve(false)
    const rest = path.slice('/tools'.length).split('/').filter(Boolean)
    const [a] = rest
    const json = (status: number, body: unknown): void => {
      const text = JSON.stringify(body)
      res.statusCode = status
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end?.(text)
    }
    const readBody = async (): Promise<any> => {
      if (req?.body !== undefined) return req.body
      /* 与其它模块的 readJson 保持一致：宿主可能给的是已解析好的 RouteRequest。 */
      if (typeof req?.json === 'function') { try { return await req.json() } catch { return {} } }
      if (typeof req?.on !== 'function') return {}
      const chunks: Buffer[] = []
      await new Promise<void>((resolve) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        req.on('end', () => resolve())
        req.on('error', () => resolve())
      })
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return {}
      try { return JSON.parse(raw) } catch { return {} }
    }

    if (a === 'policy') {
      if (method === 'GET') {
        const profile = url.searchParams.get('profile') ?? undefined
        json(200, { ok: true, ...view(profile), recentBlocked: blocked.slice(0, 20) })
        return Promise.resolve(true)
      }
      if (method === 'PATCH' || method === 'POST') {
        return readBody().then(body => {
          try {
            /* 单工具/单能力/单功能的快捷写法，避免前端拼整份策略 */
            if (typeof body?.tool === 'string' && typeof body?.enabled === 'boolean') {
              store.setToolEnabled(body.tool, body.enabled)
            } else if (typeof body?.capability === 'string' && typeof body?.enabled === 'boolean') {
              store.setCapability(body.capability, body.enabled)
            } else if (typeof body?.feature === 'string' && typeof body?.profile === 'string') {
              store.setFeatureProfile(body.feature, body.profile)
            } else if (body?.reset === true) {
              store.reset()
            } else {
              store.merge(body)
            }
            cache.clear()
            json(200, { ok: true, ...view() })
          } catch (cause) {
            json(500, { ok: false, error: cause instanceof Error ? cause.message : String(cause) })
          }
          return true
        })
      }
      json(405, { ok: false, error: '不支持的方法' })
      return Promise.resolve(true)
    }
    if (a === 'blocked') {
      if (method === 'GET') { json(200, { ok: true, blocked }); return Promise.resolve(true) }
      if (method === 'DELETE') { blocked.length = 0; json(200, { ok: true }); return Promise.resolve(true) }
      json(405, { ok: false, error: '不支持的方法' })
      return Promise.resolve(true)
    }
    if (a === 'preview') {
      /* 给未来的工具流/节点用：给一组工具名 + 档位，直接问「哪些能用」。 */
      if (method !== 'POST') { json(405, { ok: false, error: '不支持的方法' }); return Promise.resolve(true) }
      return readBody().then(body => {
        const names = Array.isArray(body?.tools) ? body.tools.map((item: unknown) => String(item)) : listTools()
        const profile = String(body?.profile ?? store.read().defaultProfile)
        json(200, { ok: true, ...buildToolPolicyView(names, store.read(), profile) })
        return true
      })
    }
    json(404, { ok: false, error: '未知接口' })
    return Promise.resolve(true)
  }

  return {
    store,
    view,
    profileForFeature: (feature: string) => store.profileFor(feature),
    describeForPrompt: (profile: string) => store.describeForPrompt(listTools(), profile),
    installGate: (ctx: any) => installToolGate(ctx, {
      store,
      resolveProfileForAgent,
      onBlocked: (call: BlockedCall) => {
        blocked.unshift(call)
        if (blocked.length > MAX_BLOCKED) blocked.length = MAX_BLOCKED
      },
    }),
    handle,
    blocked: () => blocked,
  }
}
