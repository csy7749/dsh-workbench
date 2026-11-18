/**
 * 工作流画布 · 宿主半侧：节点目录 + 画布 CRUD + 校验/预演
 *
 * 路由挂在 /workbench-api 下（/workflow/...），和灵感、智能体同一套前缀与鉴权。
 * 全部只做「读目录 / 存图 / 算计划」，不派 Agent、不写工作区文件：
 * 真正执行留给执行器，这样画布面板本身永远不会因为跑流程而卡死。
 */
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { WorkflowCanvasStore, type GraphRow } from './workflow-canvas-store.js'
import { createWorkflowRunner } from './workflow-runner.mjs'
import { reviewContractFor } from '../packs/runtime.mjs'
import { createWorkflowScheduler } from './workflow-scheduler.mjs'
import {
  CATEGORIES, NODE_DEFS, PRODUCT_LINES, TYPE_COLOR, TYPE_LABEL, templateList,
  type GraphIssue, type WorkflowGraph,
} from '../shared/workflow-catalog.ts'

interface RouteRequest { url?: string; method?: string; on?: Function; json?: Function; headers?: Record<string, string> }
interface RouteResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: unknown): void
}

export interface WorkflowCanvasModuleOptions {
  db: any
  prefix: string
  /** 运行库与产物根目录；不给则禁用「运行」路由，画布本身不受影响。 */
  runsDbPath?: string
  runsRoot?: string
  products?: () => { id: string; workspacePath: string }[]
  sessionEvents?: (sessionId: string) => any[]
  prepareSession?: (sessionId: string, config: any) => Promise<any>
  sessionAdapter?: { create(sessionId: string, cwd: string): Promise<void>; prepare(sessionId: string, config: any): Promise<any>; send(sessionId: string, prompt: string): Promise<void> }
  intervalMs?: number
}

export interface WorkflowCanvasModule {
  store: WorkflowCanvasStore
  handle(req: RouteRequest, res: RouteResponse, path: string, method: string, url: URL): Promise<boolean>
  dispose(): void
}

function send(res: RouteResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function fail(res: RouteResponse, status: number, message: string): void {
  send(res, status, { ok: false, error: message, message })
}

async function readJson(req: RouteRequest, limit = 1024 * 1024): Promise<any> {
  if (typeof req.json === 'function') {
    try {
      return await req.json()
    } catch {
      return {}
    }
  }
  return await new Promise(resolve => {
    let size = 0
    const chunks: Buffer[] = []
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > limit) { resolve({}); return }
      chunks.push(chunk)
    }
    const done = (): void => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch { resolve({}) }
    }
    req.on?.('data', onData)
    req.on?.('end', done)
    req.on?.('error', done)
  })
}

/** 目录：前端靠它渲染节点库，避免两侧各维护一份节点表。 */
function catalog(): unknown {
  return {
    ok: true,
    lines: PRODUCT_LINES,
    categories: CATEGORIES,
    defs: NODE_DEFS,
    typeColor: TYPE_COLOR,
    typeLabel: TYPE_LABEL,
    templates: templateList(),
  }
}

export function createWorkflowCanvasModule(options: WorkflowCanvasModuleOptions): WorkflowCanvasModule {
  const store = new WorkflowCanvasStore(options.db)
  const ownerOf = (value: string): string => {
    if (!value) return ''
    const products = options.products?.() ?? []
    const exact = products.find(p => p.id === value)
    if (exact) return exact.id
    throw new Error('product_not_found: 请使用独立产品 ID，不能使用项目目录')
  }
  const prefix = options.prefix
  const runnerRoot = options.runsRoot ?? 'workflow-runs'
  let runs: ReturnType<typeof createWorkflowRunner> | null = null
  if (typeof options.runsDbPath === 'string' && options.runsDbPath !== '') {
    try {
      runs = createWorkflowRunner({ dbPath: options.runsDbPath, root: runnerRoot, productId: 'workbench' })
    } catch (cause) {
      console.warn('[dsh-workbench] 工作流运行库初始化失败（画布仍可用）：', String(cause))
      runs = null
    }
  }
  const message = (cause: any): string => String(cause?.code ?? cause?.message ?? cause)

  function viewOf(runId: string): any {
    if (runs === null) throw new Error('runner_unavailable')
    const compiled = runs.compiled(runId)
    const state = runs.state(runId)
    const byNode = new Map(compiled.map(item => [item.nodeId, item]))
    const steps = state.steps.map((row: any) => {
      const item = byNode.get(row.node_id)
      const owner = runs.kernel.one('SELECT id FROM workflow_attempts WHERE step_id=? ORDER BY attempt_no DESC LIMIT 1', row.id) ?? runs.kernel.one('SELECT id FROM workflow_human_tasks WHERE step_id=? ORDER BY task_revision DESC LIMIT 1', row.id)
      let inputs: any[] = []
      let omittedInputs: any[] = []
      if (owner) {
        try {
          const binding = runs.kernel.inputBindingFor(owner.id)
          inputs = binding.inputs.map((input: any) => ({ nodeId: input.nodeId ?? null, fromPort: input.fromPort ?? null, toPort: input.toPort ?? null, snapshotId: input.snapshotId }))
          omittedInputs = (binding.omissions ?? []).map((input: any) => ({ nodeId: input.nodeId, fromPort: input.fromPort, toPort: input.toPort, reason: input.reason, snapshotId: input.snapshotId ?? null, eventSeq: input.eventSeq ?? null }))
        } catch { /* Older or incomplete attempts have no readable binding. */ }
      }
      const content = runs.content(runId, row.node_id)
      let displayContent = content
      if (item?.step?.portPayloads === 'check-v1' && content) {
        try { displayContent = JSON.stringify(JSON.parse(content).report, null, 2) } catch { /* preserve readable raw data */ }
      }
      return {
        nodeId: row.node_id,
        revision: row.revision,
        title: item?.title ?? row.node_id,
        type: item?.type ?? '',
        kind: item?.kind ?? 'static',
        state: row.state,
        stale: row.stale === 1,
        content: displayContent,
        inputs,
        omittedInputs,
        executionConfig: item?.executionConfig,
      }
    })
    const open = steps.find(step => !['succeeded', 'cancelled', 'skipped'].includes(step.state)) ?? null
    let waiting = null
    if (state.run.status === 'waiting_review' || (state.run.status === 'paused' && open?.state === 'waiting_review')) {
      const task = state.tasks.find((entry: any) => entry.status === 'open')
      const draft = task ? runs.draft(runId, task.id) : null
      const editor = reviewContractFor(byNode.get(open?.nodeId))
      waiting = { editor: editor ? { kind: editor.kind, fields: editor.fields, regenerateLabel: editor.regenerateLabel } : null, sources: runs.reviewSources(runId, open?.nodeId), kind: 'human', nodeId: open?.nodeId ?? null, title: open?.title ?? '', taskId: task?.id ?? null, content: draft?.draft?.content ?? draft?.currentInput?.content ?? '', bindingVersion: draft?.binding?.version, taskRevision: draft?.taskRevision, revisions: runs.revisions(runId) }
    } else if (open !== null && (state.run.status === 'created' || state.run.status === 'running')) {
      waiting = { kind: open.kind, nodeId: open.nodeId, title: open.title, taskId: null, content: open.content }
    }
    return { runId, status: state.run.status, revision: state.run.revision, pauseReason: state.run.pause_reason, steps, waiting, auto: runs.autoState(runId), generation: runs.generation(runId), attempts: runs.attempts(runId), validations: runs.kernel.listValidations(runId), events: runs.events(runId) }
  }

  const runnerStart = (runId: string, graph: any, productId: string): any => runs!.start({ graph, runId, productId: productId || 'workbench' })
  const runnerAdvance = async (runId: string): Promise<any> => runs!.advance(runId)
  const runnerSubmit = async (runId: string, content: string): Promise<any> => runs!.submit({ runId, content })
  const runnerConfirm = async (runId: string, taskId: string, content: string): Promise<any> => runs!.confirm({ runId, taskId, content })
  const runnerExport = (runId: string, dir: string): string[] => runs!.export(runId, dir)

  const scheduler = createWorkflowScheduler({
    runs, sessionEvents: options.sessionEvents, sessionAdapter: options.sessionAdapter,
    workspaceOf: productId => options.products?.().find(product => product.id === productId)?.workspacePath ?? '',
    advance: runnerAdvance,
    intervalMs: options.intervalMs,
    onError: cause => console.warn('[dsh-workbench] 工作流宿主收集失败：', String(cause?.message ?? cause)),
  })

  async function handle(req: RouteRequest, res: RouteResponse, path: string, method: string, url: URL): Promise<boolean> {
    if (!path.startsWith('/workflow')) return false
    const rest = path.slice('/workflow'.length)
    const parts = rest.split('/').filter(part => part !== '')

    if (parts.length === 0 || (parts.length === 1 && parts[0] === 'catalog')) {
      if (method !== 'GET') { fail(res, 405, '只支持 GET'); return true }
      send(res, 200, { ...(catalog() as object), templates: [...templateList(), ...store.listTemplates()] })
      return true
    }

    if (parts[0] === 'templates') {
      if (parts.length === 1 && method === 'GET') send(res, 200, { ok: true, templates: [...templateList(), ...store.listTemplates()] })
      else if (parts.length === 2 && method === 'GET') {
        const template = store.template(decodeURIComponent(parts[1]))
        if (template) send(res, 200, { ok: true, template }); else fail(res, 404, '模板不存在')
      } else if (parts.length === 3 && parts[2] === 'versions' && method === 'GET') send(res, 200, { ok: true, versions: store.templateVersions(decodeURIComponent(parts[1])) })
      else if (parts.length === 3 && parts[2] === 'fork' && method === 'POST') {
        try {
          const body = await readJson(req)
          const productId = ownerOf(body.productId)
          if (!productId) throw new Error('product_required')
          const result = store.createFromTemplate(decodeURIComponent(parts[1]), productId)
          if (!result.ok) fail(res, 400, result.error ?? '复制失败'); else send(res, 201, result)
        } catch (cause) { fail(res, 400, message(cause)) }
      } else fail(res, 405, '不支持的方法')
      return true
    }

    /* 运行：把存好的图画布编译成步骤后逐步推进。生成类节点等外部提交真实内容，
       输入/校验/输出三类节点由宿主产出，保证「一条流程」不会因为没人写内容而空转。 */
    if (parts[0] === 'runs') {
      if (runs === null) { fail(res, 503, '运行需要 SQLite'); return true }

      if (parts.length === 1 && method === 'GET') {
        const found = store.get(url.searchParams.get('graphId') ?? '')
        if (!found) { fail(res, 404, '画布不存在'); return true }
        send(res, 200, { ok: true, runs: runs.listForGraph(found.row.id, found.row.product_id || 'workbench') })
        return true
      }
      if (parts.length === 1 && method === 'POST') {
        const body = await readJson(req)
        const found = typeof body.graphId === 'string' && body.graphId !== '' ? store.get(body.graphId) : null
        if (found === null) { fail(res, 404, '画布不存在'); return true }
        if (!found.row.product_id) { fail(res, 400, '运行前请将全局草稿复制到独立产品'); return true }
        if (body.automatic === true && (!options.sessionAdapter || !options.sessionEvents)) { fail(res, 503, '宿主自动执行不可用'); return true }
        const runId = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
        try {
          ownerOf(found.row.product_id)
          runnerStart(runId, { ...found.graph, id: found.row.id, sourceRevision: found.row.revision }, found.row.product_id)
          if (body.automatic === true) {
            runs.enableAuto(runId)
          }
          await runnerAdvance(runId)
          send(res, 201, { ok: true, runId, view: viewOf(runId) })
        } catch (cause) {
          fail(res, 400, message(cause))
        }
        return true
      }

      if (parts.length === 2 && method === 'GET') {
        const runId = decodeURIComponent(parts[1])
        try {
          send(res, 200, { ok: true, view: viewOf(runId) })
        } catch (cause) {
          fail(res, 404, message(cause))
        }
        return true
      }

      if (parts.length >= 3 && parts.length <= 4) {
        const runId = decodeURIComponent(parts[1])
        const action = parts[2]
        const body = await readJson(req)
        try {
          if (action === 'auto' && method === 'POST') {
            if (body.enabled === true) {
              if (!options.sessionAdapter || !options.sessionEvents) throw new Error('host_auto_unavailable')
              runs.enableAuto(runId)
            } else runs.disableAuto(runId)
            send(res, 200, { ok: true, view: viewOf(runId) })
            return true
          }
          if (action === 'auto-reconcile' && method === 'POST') {
            runs.autoReconcileNotSent(runId, body.sessionId)
            send(res, 200, { ok: true, view: viewOf(runId) })
            return true
          }
          if (action === 'revisions' && parts.length === 3 && method === 'GET') {
            send(res, 200, { ok: true, revisions: runs.revisions(runId) })
            return true
          }
          if (action === 'revisions' && parts.length === 3 && method === 'POST') {
            if (!options.sessionEvents) throw new Error('session_events_unavailable')
            if (!options.prepareSession) throw new Error('session_model_adapter_unavailable')
            const config = runs.revisionExecutionConfig(runId, body.taskId)
            const effectiveConfig = await options.prepareSession(body.sessionId, config)
            const events = options.sessionEvents(body.sessionId)
            const afterSeq = events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0)
            const revision = runs.beginRevision({ runId, taskId: body.taskId, expectedBindingVersion: body.expectedBindingVersion, expectedTaskRevision: body.expectedTaskRevision, note: body.note, sessionId: body.sessionId, afterSeq, execution: { requested: config, effective: effectiveConfig, status: 'configured' } })
            send(res, 200, { ok: true, revision, view: viewOf(runId) })
            return true
          }
          if (action === 'revisions' && parts[3] === 'collect' && method === 'POST') {
            if (!options.sessionEvents) throw new Error('session_events_unavailable')
            const revision = runs.collectRevision({ runId, id: body.revisionId, sessionId: body.sessionId, events: options.sessionEvents(body.sessionId) })
            send(res, 200, { ok: true, revision, view: viewOf(runId) })
            return true
          }
          if (action === 'revisions' && parts[3] === 'fail' && method === 'POST') {
            const revision = runs.failRevision({ runId, id: body.revisionId, reason: body.reason })
            send(res, 200, { ok: true, revision, view: viewOf(runId) })
            return true
          }
          if (action === 'revisions' && parts[3] === 'apply' && method === 'POST') {
            const revision = runs.applyRevision({ runId, id: body.revisionId })
            send(res, 200, { ok: true, revision, view: viewOf(runId) })
            return true
          }
          if (action === 'generation' && method === 'POST') {
            const auto = runs.autoState(runId)
            if (auto?.enabled || ['creating', 'sending'].includes(auto?.state)) throw new Error('自动派发进行中，请先关闭自动并等待准备结束')
            if (!options.sessionEvents) throw new Error('session_events_unavailable')
            const events = options.sessionEvents(body.sessionId)
            const afterSeq = events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0)
            const config = runs.nextExecutionConfig(runId)
            if (!options.prepareSession) throw new Error('session_model_adapter_unavailable')
            const effectiveConfig = await options.prepareSession(body.sessionId, config)
            const generation = runs.beginGeneration({ runId, sessionId: body.sessionId, afterSeq, effectiveConfig })
            send(res, 200, { ok: true, generation, view: viewOf(runId) })
            return true
          }
          if (action === 'generation-failed' && method === 'POST') {
            runs.failGeneration(runId, body.sessionId)
            send(res, 200, { ok: true, view: viewOf(runId) })
            return true
          }
          if (action === 'generation-abandon' && method === 'POST') {
            runs.abandonGeneration(runId, body.sessionId, body.expectedRevision)
            send(res, 200, { ok: true, view: viewOf(runId) })
            return true
          }
          if (action === 'collect' && method === 'POST') {
            if (!options.sessionEvents) throw new Error('session_events_unavailable')
            const result = runs.collectGeneration({ runId, sessionId: body.sessionId, events: options.sessionEvents(body.sessionId) })
            if (result.status === 'completed') await runnerAdvance(runId)
            send(res, 200, { ok: true, result, view: viewOf(runId) })
            return true
          }
          if (['pause', 'resume', 'cancel'].includes(action) && method === 'POST') {
            runs.control(runId, action, body.expectedRevision)
            if (action === 'resume') await runnerAdvance(runId)
            send(res, 200, { ok: true, view: viewOf(runId) })
            return true
          }
          if (action === 'rerun' && method === 'POST') {
            runs.rerun({ runId, nodeId: body.nodeId, expectedRunRevision: body.expectedRunRevision, expectedStepRevision: body.expectedStepRevision })
            send(res, 200, { ok: true, view: viewOf(runId) })
            return true
          }
          if (action === 'draft' && method === 'POST') {
            runs.saveDraft({ runId, taskId: body.taskId, content: body.content, expectedBindingVersion: body.expectedBindingVersion, expectedTaskRevision: body.expectedTaskRevision })
            send(res, 200, { ok: true, view: viewOf(runId) })
            return true
          }
          if (action === 'request-changes' && method === 'POST') {
            runs.requestChanges({ runId, taskId: body.taskId, content: body.content, note: body.note, expectedBindingVersion: body.expectedBindingVersion, expectedTaskRevision: body.expectedTaskRevision })
            send(res, 200, { ok: true, view: viewOf(runId) })
            return true
          }
          if (action === 'revise-design' && method === 'POST') {
            runs.reviseDesign({ runId, taskId: body.taskId, content: body.content, expectedBindingVersion: body.expectedBindingVersion, expectedTaskRevision: body.expectedTaskRevision, expectedRunRevision: body.expectedRunRevision })
            await runnerAdvance(runId)
            send(res, 200, { ok: true, view: viewOf(runId) })
            return true
          }
          if (action === 'advance' && method === 'POST') {
            const step = await runnerAdvance(runId)
            send(res, 200, { ok: true, step, view: viewOf(runId) })
            return true
          }
          if (action === 'submit' && method === 'POST') {
            const auto = runs.autoState(runId)
            if (auto?.enabled || ['creating', 'sending'].includes(auto?.state)) throw new Error('自动派发进行中，请先关闭自动并等待准备结束')
            if (typeof body.content !== 'string' || body.content.trim() === '') { fail(res, 400, '内容不能为空'); return true }
            const adopted = await runnerSubmit(runId, body.content)
            const step = await runnerAdvance(runId)
            send(res, 200, { ok: true, adopted, step, view: viewOf(runId) })
            return true
          }
          if (action === 'confirm' && method === 'POST') {
            if (![body.expectedBindingVersion, body.expectedTaskRevision, body.expectedRunRevision].every(value => Number.isSafeInteger(value) && value > 0)) { fail(res, 400, 'confirmation_versions_required'); return true }
            const view = viewOf(runId)
            const taskId = typeof body.taskId === 'string' && body.taskId !== '' ? body.taskId : view.waiting?.taskId
            if (typeof taskId !== 'string' || taskId === '') { fail(res, 400, '没有待确认项'); return true }
            await runs.confirm({ runId, taskId, content: typeof body.content === 'string' ? body.content : '', intent: body.intent ?? 'continue', expectedBindingVersion: body.expectedBindingVersion, expectedTaskRevision: body.expectedTaskRevision, expectedRunRevision: body.expectedRunRevision ?? view.revision })
            const step = await runnerAdvance(runId)
            send(res, 200, { ok: true, step, view: viewOf(runId) })
            return true
          }
          if (action === 'export' && method === 'POST') {
            const product = options.products?.().find(product => product.id === runs.productId(runId))
            if (!product?.workspacePath || !isAbsolute(product.workspacePath) || !statSync(product.workspacePath).isDirectory()) throw new Error('导出需要所属产品的有效项目目录')
            const dir = join(product.workspacePath, 'workflow-out', randomUUID())
            const files = runnerExport(runId, dir)
            send(res, 200, { ok: true, dir, files })
            return true
          }
        } catch (cause) {
          fail(res, 400, message(cause))
          return true
        }
        fail(res, 405, '不支持的方法')
        return true
      }

      return false
    }

    if (parts[0] !== 'graphs') return false

    if (parts.length === 1) {
      if (method === 'GET') {
        const product = url.searchParams.get('product')
        try { send(res, 200, { ok: true, graphs: store.list(product === null ? '' : ownerOf(product)) }) }
        catch (cause) { fail(res, 400, message(cause)) }
        return true
      }
      if (method === 'POST') {
        const body = await readJson(req)
        let productId = ''
        try { productId = typeof body.productId === 'string' ? ownerOf(body.productId) : '' } catch (cause) { fail(res, 400, message(cause)); return true }
        if (typeof body.templateId === 'string' && body.templateId !== '') {
          const result = store.createFromTemplate(body.templateId, productId)
          if (!result.ok) { fail(res, 400, result.error ?? '新建失败'); return true }
          send(res, 201, { ok: true, row: result.row, graph: result.graph, issues: result.issues ?? [] })
          return true
        }
        const result = store.create({ name: body.name, line: body.line, graph: body.graph, productId })
        if (!result.ok) { fail(res, 400, result.error ?? '新建失败'); return true }
        send(res, 201, { ok: true, row: result.row, graph: result.graph, issues: result.issues ?? [] })
        return true
      }
      fail(res, 405, '不支持的方法')
      return true
    }

    const id = decodeURIComponent(parts[1])
    if (parts.length === 2) {
      if (method === 'GET') {
        const found = store.get(id)
        if (found === null) { fail(res, 404, '画布不存在'); return true }
        send(res, 200, { ok: true, row: found.row, graph: found.graph, issues: found.issues })
        return true
      }
      if (method === 'PUT' || method === 'POST') {
        const body = await readJson(req)
        const result = store.save(id, { name: body.name, line: body.line, graph: body.graph, baseRevision: body.baseRevision })
        if (!result.ok) {
          fail(res, result.conflict === true ? 409 : 400, result.error ?? '保存失败')
          return true
        }
        send(res, 200, { ok: true, row: result.row, graph: result.graph, issues: result.issues ?? [] })
        return true
      }
      if (method === 'DELETE') {
        const removed = store.remove(id)
        send(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: '画布不存在' })
        return true
      }
      fail(res, 405, '不支持的方法')
      return true
    }

    if (parts.length === 3 && parts[2] === 'template') {
      try {
        if (method === 'GET') send(res, 200, { ok: true, ...store.templatePreview(id) })
        else if (method === 'POST') {
          const body = await readJson(req)
          send(res, 201, { ok: true, template: store.saveTemplate(id, body.name, body.summary, body.keep) })
        } else fail(res, 405, '不支持的方法')
      } catch (cause) { fail(res, 400, message(cause)) }
      return true
    }

    if (parts.length === 3 && parts[2] === 'plan') {
      if (method !== 'POST' && method !== 'GET') { fail(res, 405, '不支持的方法'); return true }
      const result = store.plan(id)
      if (result.ok !== true) { fail(res, 404, result.error ?? '画布不存在'); return true }
      send(res, 200, { ok: true, plan: result.plan, issues: result.issues ?? [] })
      return true
    }

    if (parts.length === 3 && parts[2] === 'validate') {
      const result = store.validate(id)
      if (result.ok !== true) { fail(res, 404, result.error ?? '画布不存在'); return true }
      const issues = result.issues ?? ([] as GraphIssue[])
      send(res, 200, { ok: true, issues, errors: issues.filter(issue => issue.level === 'error').length })
      return true
    }

    if (parts.length === 3 && parts[2] === 'graph' && method === 'GET') {
      const found = store.get(id)
      if (found === null) { fail(res, 404, '画布不存在'); return true }
      send(res, 200, { ok: true, graph: found.graph as WorkflowGraph, row: found.row as GraphRow })
      return true
    }

    void url
    void prefix
    return false
  }

  return { store, handle, dispose() { scheduler.dispose(); runs?.kernel.db.close() } }
}
