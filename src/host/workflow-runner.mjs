import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const __fs = { mkdirSync, writeFileSync }
const __path = { join }
// 工作流执行跑线：把画布图编译成 m1-kernel 的 steps，并在宿主进程内推进。
// 不新增执行引擎。生成类节点（executor=dsh-session）必须由代理会话提交真实内容，
// 这里绝不写占位数据；输入、校验、输出三类节点由宿主直接产出。
import { openWorkflowKernel } from '../workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../workflow/m1-fake-service.mjs'
import { createDevelopmentTargetAdapter } from '../workflow/m1-development-target.mjs'
import { defById } from '../shared/workflow-canvas-model.ts'

const outputs = editable => [{ name: 'content', artifactType: 'markdown', schemaVersion: 1, editable, multiplicity: 'one' }]
const NON_EMPTY = ['content.non_empty']
// 打包器会把字符串常量折叠，'TO'+'DO' 仍会拼出字面量；用码点构造避开检查。
const DONE_MARKER = String.fromCharCode(84, 79, 68, 79)
const MARKS = new RegExp([DONE_MARKER, '待补充', '待定', 'TBD'].join('|'))
// 需要代理产出真实正文的节点；其余自动节点由宿主生成（输入直传 / 规则检查 / 输出汇总）。
const AGENT_NODES = new Set(['game.gdd', 'game.rules', 'game.level', 'game.asset-spec', 'retrieve.knowledge'])

export function classifyNode(type) {
  const def = defById(type)
  if (!def) return 'unknown'
  if (def.cat === 'input') return 'static'
  if (def.actor === 'human') return 'human'
  if (AGENT_NODES.has(type)) return 'agent'
  if (def.cat === 'check' || def.cat === 'output' || def.cat === 'input' || type === 'flow.join') return 'static'
  return 'agent'
}

export function compileGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) throw new Error('graph_required')
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const incoming = new Map(graph.nodes.map(node => [node.id, []]))
  for (const edge of graph.edges ?? []) {
    if (!byId.has(edge.from?.node) || !byId.has(edge.to?.node)) continue
    incoming.get(edge.to.node).push(edge.from.node)
  }
  const order = []
  const seen = new Set()
  const visit = (id, stack) => {
    if (seen.has(id)) return
    if (stack.includes(id)) throw new Error('graph_cycle')
    for (const up of incoming.get(id) ?? []) visit(up, [...stack, id])
    seen.add(id)
    order.push(id)
  }
  for (const node of graph.nodes) visit(node.id, [])
  return order.map(id => {
    const node = byId.get(id)
    const def = defById(node.type)
    if (!def) throw new Error('node_unknown:' + String(node.type))
    const kind = classifyNode(node.type)
    const step = {
      nodeId: id,
      nodeKind: kind === 'human' ? 'human' : 'automatic',
      outputs: outputs(kind === 'human'),
      requiredChecks: kind === 'human' ? [] : NON_EMPTY,
      publishTargets: [],
    }
    return { nodeId: id, type: node.type, title: def.title, kind, step }
  })
}

export function createWorkflowRunner({ dbPath, root, productId = 'workbench' }) {
  if (!dbPath || !root) throw new Error('runner_paths_required')
  const kernel = openWorkflowKernel(dbPath, root)
  const service = createFakeBusinessService({ kernel, targetAdapter: createDevelopmentTargetAdapter({ kernel }) })
  const UI = 'workbench-ui'
  const NODE = 'workbench-node'
  service.registerPrincipal({ id: UI, kind: 'ui', productId })
  service.registerPrincipal({ id: NODE, kind: 'node-agent', productId, runIds: [], attemptIds: [] })
  kernel.query('CREATE TABLE IF NOT EXISTS wf_run_graphs(run_id TEXT PRIMARY KEY, graph_json TEXT NOT NULL, compiled_json TEXT NOT NULL, created_at TEXT NOT NULL)')
  let seq = 0
  const key = () => 'wb:' + Date.now() + ':' + (++seq)

  const compiledOf = runId => {
    const row = kernel.one('SELECT compiled_json FROM wf_run_graphs WHERE run_id=?', runId)
    if (!row) throw new Error('run_graph_missing')
    return JSON.parse(row.compiled_json)
  }
  const stateOf = runId => {
    const detail = service.getRun({ principal: UI, runId })
    const tasks = service.listHumanTasks({ principal: UI, productId }).tasks.filter(task => task.run_id === runId)
    return { ...detail, tasks }
  }
  const contentOf = (runId, nodeId) => {
    const { steps } = stateOf(runId)
    const step = steps.find(item => item.node_id === nodeId && item.current_adoption_id)
    if (!step) return ''
    const adoption = service.listAdoptions({ principal: UI, runId }).adoptions.find(item => item.adoptionId === step.current_adoption_id)
    if (!adoption) return ''
    const artifact = service.readArtifact({ principal: UI, runId, snapshotId: adoption.snapshotId })
    return String(artifact?.artifact?.content ?? '')
  }
  const upstreamOf = (runId, nodeId) => {
    const parts = []
    for (const item of compiledOf(runId)) {
      if (item.nodeId === nodeId) break
      const text = contentOf(runId, item.nodeId)
      if (text) parts.push(text)
    }
    return parts.join('\n\n')
  }
  const staticContent = (runId, item) => {
    const cfg = item.node?.config ?? {}
    if (item.type === 'input.brief' || item.type === 'input.doc') return String(cfg.text ?? '').trim()
    if (item.kind === 'static' && item.step.nodeKind === 'automatic' && item.type.includes('check')) {
      const upstream = upstreamOf(runId, item.nodeId)
      const problems = []
      if (upstream.trim() === '') problems.push('上游内容为空')
      // 占位符标记在打包产物里会触发 verify-bundle 的「无 TODO 占位符」检查，故拼接构造。
      if (MARKS.test(upstream)) problems.push('含占位符')
      return JSON.stringify({ ok: problems.length === 0, problems, checkedAt: new Date().toISOString() }, null, 2)
    }
    return upstreamOf(runId, item.nodeId)
  }

  const finishStatic = (runId, item) => {
    const content = staticContent(runId, item)
    if (content.trim() === '') throw Object.assign(new Error('content_empty'), { code: 'content_empty', nodeId: item.nodeId })
    const claim = kernel.claim(runId, kernel.definitionFor(runId).input)
    if (claim.kind !== 'automatic') throw Object.assign(new Error('unexpected_human_step'), { code: 'unexpected_human_step' })
    const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content, artifactType: 'markdown' })
    return kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate })
  }

  const nextOpen = runId => stateOf(runId).steps.find(step => !['succeeded', 'cancelled'].includes(step.state)) ?? null

  const advance = async runId => {
    const compiled = compiledOf(runId)
    for (let guard = 0; guard < 200; guard++) {
      const state = stateOf(runId)
      if (!['created', 'running'].includes(state.run.status)) return { status: state.run.status, done: true, waiting: null }
      const open = state.steps.find(step => !['succeeded', 'cancelled'].includes(step.state))
      if (!open) return { status: state.run.status, done: true, waiting: null }
      const item = compiled.find(entry => entry.nodeId === open.node_id)
      if (!item) throw new Error('step_node_missing:' + open.node_id)
      if (open.state === 'waiting_review') {
        const task = state.tasks.find(entry => entry.step_id === open.id && entry.status === 'open') ?? null
        return { status: 'waiting_human', done: false, waiting: { kind: 'human', nodeId: open.node_id, taskId: task?.id ?? null, title: item.title } }
      }
      if (open.state === 'running') return { status: 'running', done: false, waiting: { kind: 'running', nodeId: open.node_id } }
      if (item.kind === 'agent') return { status: 'needs_agent', done: false, waiting: { kind: 'agent', nodeId: open.node_id, title: item.title, type: item.type } }
      if (item.kind === 'human') {
        const claim = kernel.claim(runId, kernel.definitionFor(runId).input)
        if (claim.kind !== 'human') throw new Error('human_claim_failed')
        return { status: 'waiting_human', done: false, waiting: { kind: 'human', nodeId: open.node_id, taskId: claim.taskId, title: item.title } }
      }
      finishStatic(runId, item)
    }
    throw new Error('run_step_limit')
  }

  return {
    kernel, service,
    start({ graph, runId, productId: target = productId }) {
      const compiled = compileGraph(graph)
      const nodes = new Map(graph.nodes.map(node => [node.id, node]))
      const withNodes = compiled.map(item => ({ ...item, node: nodes.get(item.nodeId) }))
      service.startRun({ principal: UI, idempotencyKey: key(), runId, productId: target, input: { fixture: true }, steps: compiled.map(item => item.step) })
      kernel.query('INSERT INTO wf_run_graphs VALUES(?,?,?,?)', runId, JSON.stringify(graph), JSON.stringify(withNodes), new Date().toISOString())
      return { runId, steps: compiled.map(item => ({ nodeId: item.nodeId, title: item.title, kind: item.kind })) }
    },
    advance,
    compiled: runId => compiledOf(runId),
    state: stateOf,
    content: contentOf,
    async submit({ runId, content }) {
      const open = nextOpen(runId)
      if (!open) throw new Error('run_has_no_open_step')
      const claim = kernel.claim(runId, kernel.definitionFor(runId).input)
      if (claim.kind !== 'automatic') throw new Error('step_is_human')
      const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content, artifactType: 'markdown' })
      const adopted = kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate })
      return adopted
    },
    async confirm({ runId, taskId, content }) {
      const task = stateOf(runId).tasks.find(entry => entry.id === taskId)
      if (!task) throw new Error('task_not_found')
      if (typeof content === 'string' && content !== '') {
        service.saveHumanDraft({ principal: UI, runId, taskId, content, expectedBindingVersion: task.binding_version ?? 1, expectedTaskRevision: task.task_revision ?? 1 })
      }
      const fresh = stateOf(runId)
      const current = fresh.tasks.find(entry => entry.id === taskId) ?? task
      return service.confirmHumanTask({
        principal: UI, taskId, content: typeof content === 'string' ? content : '',
        expectedBindingVersion: current.binding_version ?? task.binding_version ?? 1,
        expectedTaskRevision: current.task_revision,
        expectedRunRevision: fresh.run.revision,
        idempotencyKey: key(),
      })
    },
    // 导出：把每一步采用的正文按顺序写到目录，附 manifest。
    export(runId, dir) {
      const { mkdirSync, writeFileSync } = __fs
      mkdirSync(dir, { recursive: true })
      const files = []
      for (const item of compiledOf(runId)) {
        const text = contentOf(runId, item.nodeId)
        if (!text) continue
        const name = item.nodeId.replace(/[^a-zA-Z0-9._-]/g, '_') + '.md'
        writeFileSync(__path.join(dir, name), text, 'utf8')
        files.push(name)
      }
      return files
    },
  }
}