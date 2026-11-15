/**
 * 工作流画布 · 宿主半侧：节点目录 + 画布 CRUD + 校验/预演
 *
 * 路由挂在 /workbench-api 下（/workflow/...），和灵感、智能体同一套前缀与鉴权。
 * 全部只做「读目录 / 存图 / 算计划」，不派 Agent、不写工作区文件：
 * 真正执行留给执行器，这样画布面板本身永远不会因为跑流程而卡死。
 */
import { join } from 'node:path'
import { WorkflowCanvasStore, type GraphRow } from './workflow-canvas-store.js'
import { createWorkflowRunner } from './workflow-runner.mjs'
import {
  CATEGORIES, NODE_DEFS, PRODUCT_LINES, TYPE_COLOR, TYPE_LABEL, templateList,
  type GraphIssue, type WorkflowGraph,
} from '../shared/workflow-canvas-model.js'

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
}

export interface WorkflowCanvasModule {
  store: WorkflowCanvasStore
  handle(req: RouteRequest, res: RouteResponse, path: string, method: string, url: URL): Promise<boolean>
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
      return {
        nodeId: row.node_id,
        title: item?.title ?? row.node_id,
        type: item?.type ?? '',
        kind: item?.kind ?? 'static',
        state: row.state,
        stale: row.stale === 1,
        content: runs.content(runId, row.node_id),
      }
    })
    const open = steps.find(step => !['succeeded', 'cancelled'].includes(step.state)) ?? null
    let waiting = null
    if (state.run.status === 'waiting_review') {
      const task = state.tasks.find((entry: any) => entry.status === 'open')
      waiting = { kind: 'human', nodeId: open?.nodeId ?? null, title: open?.title ?? '', taskId: task?.id ?? null, content: open?.content ?? '' }
    } else if (open !== null && (state.run.status === 'created' || state.run.status === 'running')) {
      waiting = { kind: open.kind, nodeId: open.nodeId, title: open.title, taskId: null, content: open.content }
    }
    return { runId, status: state.run.status, steps, waiting }
  }

  const runnerStart = (runId: string, graph: any): any => runs!.start({ graph, runId })
  const runnerAdvance = async (runId: string): Promise<any> => runs!.advance(runId)
  const runnerSubmit = async (runId: string, content: string): Promise<any> => runs!.submit({ runId, content })
  const runnerConfirm = async (runId: string, taskId: string, content: string): Promise<any> => runs!.confirm({ runId, taskId, content })
  const runnerExport = (runId: string, dir: string): string[] => runs!.export(runId, dir)

  async function handle(req: RouteRequest, res: RouteResponse, path: string, method: string, url: URL): Promise<boolean> {
    if (!path.startsWith('/workflow')) return false
    const rest = path.slice('/workflow'.length)
    const parts = rest.split('/').filter(part => part !== '')

    if (parts.length === 0 || (parts.length === 1 && parts[0] === 'catalog')) {
      if (method !== 'GET') { fail(res, 405, '只支持 GET'); return true }
      send(res, 200, catalog())
      return true
    }

    if (parts[0] === 'templates') {
      if (method !== 'GET') { fail(res, 405, '只支持 GET'); return true }
      send(res, 200, { ok: true, templates: templateList() })
      return true
    }

    /* 运行：把存好的图画布编译成步骤后逐步推进。生成类节点等外部提交真实内容，
       输入/校验/输出三类节点由宿主产出，保证「一条流程」不会因为没人写内容而空转。 */
    if (parts[0] === 'runs') {
      if (runs === null) { fail(res, 503, '运行需要 SQLite'); return true }

      if (parts.length === 1 && method === 'POST') {
        const body = await readJson(req)
        const found = typeof body.graphId === 'string' && body.graphId !== '' ? store.get(body.graphId) : null
        if (found === null) { fail(res, 404, '画布不存在'); return true }
        const runId = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
        try {
          runnerStart(runId, found.graph)
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

      if (parts.length === 3) {
        const runId = decodeURIComponent(parts[1])
        const action = parts[2]
        const body = await readJson(req)
        try {
          if (action === 'advance' && method === 'POST') {
            const step = await runnerAdvance(runId)
            send(res, 200, { ok: true, step, view: viewOf(runId) })
            return true
          }
          if (action === 'submit' && method === 'POST') {
            if (typeof body.content !== 'string' || body.content.trim() === '') { fail(res, 400, '内容不能为空'); return true }
            await runnerSubmit(runId, body.content)
            const step = await runnerAdvance(runId)
            send(res, 200, { ok: true, step, view: viewOf(runId) })
            return true
          }
          if (action === 'confirm' && method === 'POST') {
            const view = viewOf(runId)
            const taskId = typeof body.taskId === 'string' && body.taskId !== '' ? body.taskId : view.waiting?.taskId
            if (typeof taskId !== 'string' || taskId === '') { fail(res, 400, '没有待确认项'); return true }
            await runnerConfirm(runId, taskId, typeof body.content === 'string' ? body.content : '')
            const step = await runnerAdvance(runId)
            send(res, 200, { ok: true, step, view: viewOf(runId) })
            return true
          }
          if (action === 'export' && method === 'POST') {
            const dir = join(runnerRoot, 'out', runId + '-' + Date.now().toString(36))
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
        send(res, 200, { ok: true, graphs: store.list() })
        return true
      }
      if (method === 'POST') {
        const body = await readJson(req)
        if (typeof body.templateId === 'string' && body.templateId !== '') {
          const result = store.createFromTemplate(body.templateId)
          if (!result.ok) { fail(res, 400, result.error ?? '新建失败'); return true }
          send(res, 201, { ok: true, row: result.row, graph: result.graph, issues: result.issues ?? [] })
          return true
        }
        const result = store.create({ name: body.name, line: body.line, graph: body.graph })
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

  return { store, handle }
}
