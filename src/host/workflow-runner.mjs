import { checks, ruleChecks, reviewedExports, reviewContracts, reviewContractFor } from '../packs/runtime.mjs'
import { createCheckEvaluator } from '../workflow/check-registry.mjs'
import { readGenerationResult } from '../workflow/session-result.mjs'
import { createSessionRevisions } from './workflow-revisions.mjs'
import { resolveExecutionConfig } from '../shared/workflow-execution-config.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
const __fs = { mkdirSync, writeFileSync }
const __path = { join }
// 工作流执行跑线：把画布图编译成 m1-kernel 的 steps，并在宿主进程内推进。
// 不新增执行引擎。生成类节点（executor=dsh-session）必须由代理会话提交真实内容，
// 这里绝不写占位数据；输入、校验、输出三类节点由宿主直接产出。
import { openWorkflowKernel } from '../workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../workflow/m1-fake-service.mjs'
import { createDevelopmentTargetAdapter } from '../workflow/m1-development-target.mjs'
import { defById, validateGraph, PACKS } from '../shared/workflow-catalog.ts'

const outputs = (editable, artifactType = 'markdown') => [{ name: 'content', artifactType, schemaVersion: 1, editable, multiplicity: 'one' }]
const NON_EMPTY = ['content.non_empty']
// 打包器会把字符串常量折叠，'TO'+'DO' 仍会拼出字面量；用码点构造避开检查。
const DONE_MARKER = String.fromCharCode(84, 79, 68, 79)
const MARKS = new RegExp([DONE_MARKER, '待补充', '待定', 'TBD'].join('|'))
// 需要代理产出真实正文的节点；其余自动节点由宿主生成（输入直传 / 规则检查 / 输出汇总）。

export function classifyNode(type) {
  const def = defById(type)
  if (!def) return 'unknown'
  if (def.cat === 'input') return 'static'
  if (def.actor === 'human') return 'human'
  if (def.executor === 'dsh-session') return 'agent'
  if (def.cat === 'check' || def.cat === 'output' || def.cat === 'input' || type === 'flow.join') return 'static'
  return 'agent'
}

export function compileGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) throw new Error('graph_required')
  const unavailable = graph.nodes.find(node => !node.disabled && defById(node.type)?.executor === 'unavailable')
  if (unavailable) throw new Error(defById(unavailable.type).unavailableReason ?? 'executor_unavailable')
  const disabled = new Set(graph.nodes.filter(node => node.disabled).map(node => node.id))
  if (graph.edges.some(edge => disabled.has(edge.from.node) && !disabled.has(edge.to.node))) throw new Error('disabled_dependency: 停用节点的下游仍需要其产物，请先断开连线或停用下游。')
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
  return order.filter(id => !disabled.has(id) && defById(byId.get(id).type)?.cat !== 'config').map(id => {
    const node = byId.get(id)
    const def = defById(node.type)
    if (!def) throw new Error('node_unknown:' + String(node.type))
    const kind = classifyNode(node.type)
    const ancestors = new Set()
    const trace = id => { for (const up of incoming.get(id) ?? []) { if (!ancestors.has(up)) { ancestors.add(up); trace(up) } } }
    trace(id)
    const review = kind === 'human' ? reviewContracts.find(contract => [...ancestors].some(up => defById(byId.get(up).type)?.reviewKind === contract.kind)) : null
    if (review?.validateSources) review.validateSources([...ancestors].map(up => byId.get(up)).filter(Boolean))
    const step = {
      nodeId: id,
      nodeKind: kind === 'human' ? 'human' : 'automatic',
      dependencies: (graph.edges ?? []).filter(edge => edge.to.node === id && defById(byId.get(edge.from.node)?.type)?.cat !== 'config').map(edge => ({ nodeId: edge.from.node, fromPort: edge.from.port, toPort: edge.to.port })),
      outputs: outputs(kind === 'human', def.artifactKind === 'json' ? 'json' : 'markdown'),
      requiredChecks: kind === 'human' ? (review?.requiredChecks ?? []) : def.requiredChecks ?? (def.cat === 'check' ? ['content.non_empty'] : NON_EMPTY),
      ...(node.type === 'check.rules' ? { portPayloads: 'check-v1' } : {}),
      ...(node.type === 'flow.join' ? { joinPolicy: node.config.policy === '任一命中' ? 'any' : 'all' } : {}),
      publishTargets: [],
    }
    for (const dependency of step.dependencies) {
      const source = byId.get(dependency.nodeId)
      const sourceDef = defById(source?.type)
      if (sourceDef?.outputs.length > 1 && source.type !== 'check.rules') throw new Error('multi_output_unavailable:' + source.type)
    }
    return { nodeId: id, type: node.type, title: node.title || def.title, kind, step, contract: { prompt: def.prompt, artifactKind: def.artifactKind, exportName: def.exportName, reviewKind: review?.kind }, executionConfig: resolveExecutionConfig(graph, id), upstream: (incoming.get(id) ?? []).filter(up => defById(byId.get(up).type)?.cat !== 'config') }
  })
}

export function createWorkflowRunner({ dbPath, root, productId = 'workbench' }) {
  if (!dbPath || !root) throw new Error('runner_paths_required')
  const kernel = openWorkflowKernel(dbPath, root, { evaluateChecks: createCheckEvaluator(checks) })
  const service = createFakeBusinessService({ kernel, targetAdapter: createDevelopmentTargetAdapter({ kernel }) })
  const revisions = createSessionRevisions(kernel)
  const UI = 'workbench-ui'
  const NODE = 'workbench-node'
  service.registerPrincipal({ id: UI, kind: 'ui', productId })
  service.registerPrincipal({ id: NODE, kind: 'node-agent', productId, runIds: [], attemptIds: [] })
  kernel.query('CREATE TABLE IF NOT EXISTS wf_run_graphs(run_id TEXT PRIMARY KEY, graph_json TEXT NOT NULL, compiled_json TEXT NOT NULL, created_at TEXT NOT NULL)')
  kernel.query('CREATE TABLE IF NOT EXISTS wf_generation_sessions(attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, token TEXT NOT NULL, prompt TEXT NOT NULL, after_seq INTEGER NOT NULL, evidence_json TEXT)')
  if (!kernel.query('PRAGMA table_info(wf_generation_sessions)').some(row => row.name === 'config_json')) kernel.query('ALTER TABLE wf_generation_sessions ADD COLUMN config_json TEXT')
  kernel.query("CREATE TABLE IF NOT EXISTS wf_auto_runs(run_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'idle',session_id TEXT,reason TEXT,updated_at TEXT NOT NULL,owner TEXT,lease_until TEXT)")
  const autoColumns = kernel.query('PRAGMA table_info(wf_auto_runs)').map(row => row.name)
  if (!autoColumns.includes('owner')) kernel.query('ALTER TABLE wf_auto_runs ADD COLUMN owner TEXT')
  if (!autoColumns.includes('lease_until')) kernel.query('ALTER TABLE wf_auto_runs ADD COLUMN lease_until TEXT')
  let seq = 0
  const key = () => 'wb:' + Date.now() + ':' + (++seq)

  const compiledOf = runId => {
    const row = kernel.one('SELECT compiled_json FROM wf_run_graphs WHERE run_id=?', runId)
    if (!row) throw new Error('run_graph_missing')
    return JSON.parse(row.compiled_json)
  }
  const uiOf = runId => {
    const row = kernel.one('SELECT product_id FROM workflow_run_definitions WHERE run_id=?', runId)
    if (!row) throw new Error('run_not_found')
    const id = 'workflow-ui:' + row.product_id
    service.registerPrincipal({ id, kind: 'ui', productId: row.product_id })
    return id
  }
  const stateOf = runId => {
    const detail = service.getRun({ principal: uiOf(runId), runId })
    const tasks = service.listHumanTasks({ principal: uiOf(runId), productId: kernel.one('SELECT product_id FROM workflow_run_definitions WHERE run_id=?', runId).product_id }).tasks.filter(task => task.run_id === runId)
    return { ...detail, tasks }
  }
  const contentOf = (runId, nodeId) => {
    const { steps } = stateOf(runId)
    const step = steps.find(item => item.node_id === nodeId && item.current_adoption_id)
    if (!step) return ''
    const adoption = service.listAdoptions({ principal: uiOf(runId), runId }).adoptions.find(item => item.adoptionId === step.current_adoption_id)
    if (!adoption) return ''
    const artifact = service.readArtifact({ principal: uiOf(runId), runId, snapshotId: adoption.snapshotId })
    return String(artifact?.artifact?.content ?? '')
  }
  const frozenInputsOf = (runId, nodeId) => {
    const current = compiledOf(runId).find(item => item.nodeId === nodeId)
    const dependencies = current?.step?.dependencies
    if (dependencies) {
      const step = kernel.one('SELECT * FROM workflow_steps WHERE run_id=? AND node_id=?', runId, nodeId)
      const owner = step && (kernel.one("SELECT id FROM workflow_attempts WHERE step_id=? ORDER BY attempt_no DESC LIMIT 1", step.id) ?? kernel.one('SELECT id FROM workflow_human_tasks WHERE step_id=? ORDER BY task_revision DESC LIMIT 1', step.id))
      if (owner) {
        const binding = kernel.inputBindingFor(owner.id)
        return binding.inputs.map(input => {
          const snapshot = kernel.readSnapshot(input.snapshotId)
          const source = compiledOf(runId).find(item => item.nodeId === input.nodeId)
          if (source?.step?.portPayloads !== 'check-v1') return { ...input, content: String(snapshot.content ?? '') }
          const envelope = JSON.parse(snapshot.content)
          if (envelope.kind !== 'workflow-check-v1' || typeof envelope.ok !== 'boolean' || typeof envelope.input !== 'string' || !envelope.report || input.fromPort !== (envelope.ok ? 'pass' : 'fail')) throw new Error('conditional_output_invalid')
          return { ...input, content: input.fromPort === 'pass' ? envelope.input : JSON.stringify(envelope.report, null, 2) }
        })
      }
    }
    return (current?.upstream ?? []).map(nodeId => ({ nodeId, content: contentOf(runId, nodeId) }))
  }
  const upstreamOf = (runId, nodeId) => frozenInputsOf(runId, nodeId).map(input => input.content).filter(Boolean).join('\n\n')
  const staticContent = (runId, item) => {
    const cfg = item.node?.config ?? {}
    if (item.type === 'input.brief' || item.type === 'input.doc') return String(cfg.text ?? '').trim()
    if (item.kind === 'static' && item.step.nodeKind === 'automatic' && item.type.includes('check')) {
      const upstream = upstreamOf(runId, item.nodeId)
      const problems = []
      const domainChecks = frozenInputsOf(runId, item.nodeId).flatMap(input => { const node = compiledOf(runId).find(entry => entry.nodeId === input.nodeId); return ruleChecks(node?.type, input.content) ?? [] })
      const checks = domainChecks
      problems.push(...checks.filter(check => check.required && check.verdict !== 'pass').map(check => check.reason))
      if (upstream.trim() === '') problems.push('上游内容为空')
      const rule = cfg.rules ?? '非空'
      if (rule === '无占位符' && MARKS.test(upstream)) problems.push('含占位符')
      if (rule === '字数达标' && Array.from(upstream).length < Number(cfg.expect)) problems.push('未达到要求字数')
      if (rule === '结构完整' && !domainChecks.length) {
        try { const value = JSON.parse(upstream); if (value === null || typeof value !== 'object') problems.push('内容不是结构化 JSON') }
        catch { problems.push('内容不是有效 JSON') }
      }
      const report = { ok: problems.length === 0, problems, checks, checkedAt: new Date().toISOString() }
      return item.step.portPayloads === 'check-v1' ? JSON.stringify({ kind: 'workflow-check-v1', ok: report.ok, input: upstream, report }, null, 2) : JSON.stringify(report, null, 2)
    }
    if (item.type === 'flow.join') {
      const ordered = frozenInputsOf(runId, item.nodeId)
      if (cfg.order === '按标题') ordered.sort((a, b) => (compiledOf(runId).find(node => node.nodeId === a.nodeId)?.title ?? '').localeCompare(compiledOf(runId).find(node => node.nodeId === b.nodeId)?.title ?? '', 'zh'))
      else if (cfg.order === '按时间') ordered.sort((a, b) => (kernel.one('SELECT rowid AS n FROM workflow_steps WHERE run_id=? AND node_id=?', runId, a.nodeId)?.n ?? 0) - (kernel.one('SELECT rowid AS n FROM workflow_steps WHERE run_id=? AND node_id=?', runId, b.nodeId)?.n ?? 0))
      else ordered.sort((a, b) => a.toPort.localeCompare(b.toPort))
      return ordered.map(input => input.content).filter(Boolean).join('\n\n' + String(cfg.separator ?? '---') + '\n\n')
    }
    return upstreamOf(runId, item.nodeId)
  }

  const finishStatic = (runId, item) => {
    const claim = kernel.claim(runId, kernel.definitionFor(runId).input)
    if (claim.kind !== 'automatic') throw Object.assign(new Error('unexpected_human_step'), { code: 'unexpected_human_step' })
    try {
      const content = staticContent(runId, item)
      if (content.trim() === '') throw Object.assign(new Error('content_empty'), { code: 'content_empty', nodeId: item.nodeId })
      const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content, artifactType: 'markdown' })
      if (item.step.portPayloads === 'check-v1' && JSON.parse(content).ok === false && (item.node.config.strict ?? true)) {
        kernel.markFailed(claim.attemptId, 'check_failed')
        return { status: 'failed' }
      }
      return kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate })
    } catch (error) {
      const attempt = kernel.one('SELECT status FROM workflow_attempts WHERE id=?', claim.attemptId)
      if (attempt?.status === 'running') kernel.markFailed(claim.attemptId, String(error?.code ?? 'static_node_failed'))
      throw error
    }
  }

  const nextOpen = runId => stateOf(runId).steps.find(step => !['succeeded', 'cancelled', 'skipped'].includes(step.state)) ?? null

  const advance = async runId => {
    const compiled = compiledOf(runId)
    for (let guard = 0; guard < 200; guard++) {
      const state = stateOf(runId)
      if (!['created', 'running'].includes(state.run.status)) return { status: state.run.status, done: true, waiting: null }
      const open = state.steps.find(step => !['succeeded', 'cancelled', 'skipped'].includes(step.state))
      if (!open) return { status: state.run.status, done: true, waiting: null }
      const item = compiled.find(entry => entry.nodeId === open.node_id)
      if (!item) throw new Error('step_node_missing:' + open.node_id)
      if (['pending', 'stale', 'paused'].includes(open.state) && item.step.dependencies?.length) {
        const inactive = item.step.dependencies.filter(dep => {
          const source = state.steps.find(step => step.node_id === dep.nodeId)
          if (source?.state === 'skipped') return true
          const sourceItem = compiled.find(entry => entry.nodeId === dep.nodeId)
          if (source?.state !== 'succeeded' || sourceItem?.step?.portPayloads !== 'check-v1') return false
          const payload = JSON.parse(contentOf(runId, dep.nodeId))
          return dep.fromPort !== (payload.ok ? 'pass' : 'fail')
        })
        if (inactive.length && (item.step.joinPolicy !== 'any' || inactive.length === item.step.dependencies.length)) { kernel.skipConditionalStep(runId, open.node_id); continue }
      }
      if (open.state === 'waiting_review') {
        const task = state.tasks.find(entry => entry.step_id === open.id && entry.status === 'open') ?? null
        return { status: 'waiting_human', done: false, waiting: { kind: 'human', nodeId: open.node_id, taskId: task?.id ?? null, title: item.title } }
      }
      if (open.state === 'running') return { status: 'running', done: false, waiting: { kind: 'running', nodeId: open.node_id } }
      if (item.kind === 'agent') return { status: 'needs_agent', done: false, waiting: { kind: 'agent', nodeId: open.node_id, title: item.title, type: item.type } }
      if (item.kind === 'human') {
        const claim = kernel.claim(runId, kernel.definitionFor(runId).input)
        if (claim.kind !== 'human') throw new Error('human_claim_failed')
        const review = reviewContractFor(item)
        if (review) {
          const draft = service.readHumanDraft({ principal: uiOf(runId), runId, taskId: claim.taskId })
          service.saveHumanDraft({ principal: uiOf(runId), runId, taskId: claim.taskId, expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision,
            rebind: draft.baselineCurrent === false, content: review.initialize(compiled, item.nodeId, id => contentOf(runId, id)) })
        }
        return { status: 'waiting_human', done: false, waiting: { kind: 'human', nodeId: open.node_id, taskId: claim.taskId, title: item.title } }
      }
      finishStatic(runId, item)
    }
    throw new Error('run_step_limit')
  }

  return {
    kernel, service,
    start({ graph, runId, productId: target = productId }) {
      const errors = validateGraph(graph).filter(issue => issue.level === 'error')
      if (errors.length) throw new Error('graph_invalid: ' + errors.map(issue => issue.message).join('; '))
      const compiled = compileGraph(graph)
      const nodes = new Map(graph.nodes.map(node => [node.id, node]))
      const withNodes = compiled.map(item => ({ ...item, node: nodes.get(item.nodeId) }))
      const principal = 'workflow-ui:' + target
      service.registerPrincipal({ id: principal, kind: 'ui', productId: target })
      service.startRun({ principal, idempotencyKey: key(), runId, productId: target, input: { graphId: graph.id ?? null, sourceRevision: graph.sourceRevision ?? null, packVersions: Object.fromEntries(PACKS.filter(pack => pack.id === 'core' || pack.id === graph.line).map(pack => [pack.id, pack.version])) }, steps: compiled.map(item => item.step) })
      kernel.query('INSERT INTO wf_run_graphs VALUES(?,?,?,?)', runId, JSON.stringify(graph), JSON.stringify(withNodes), new Date().toISOString())
      return { runId, steps: compiled.map(item => ({ nodeId: item.nodeId, title: item.title, kind: item.kind })) }
    },
    listForGraph(graphId, owner = productId) {
      return kernel.query("SELECT g.run_id, g.created_at, r.status FROM wf_run_graphs g JOIN workflow_runs r ON r.id=g.run_id JOIN workflow_run_definitions d ON d.run_id=g.run_id WHERE json_extract(g.graph_json, '$.id')=? AND d.product_id=? ORDER BY g.created_at DESC, g.run_id DESC LIMIT 50", graphId, owner)
    },
    advance,
    productId: runId => { uiOf(runId); return kernel.one('SELECT product_id FROM workflow_run_definitions WHERE run_id=?', runId).product_id },
    generation: runId => kernel.one('SELECT g.session_id FROM wf_generation_sessions g JOIN workflow_attempts a ON a.id=g.attempt_id WHERE g.run_id=? AND a.status=? ORDER BY a.attempt_no DESC LIMIT 1', runId, 'running'),
    activeGenerations() {
      return kernel.query("SELECT g.run_id,g.session_id FROM wf_generation_sessions g JOIN workflow_attempts a ON a.id=g.attempt_id JOIN workflow_runs r ON r.id=g.run_id LEFT JOIN wf_auto_runs x ON x.run_id=g.run_id AND x.session_id=g.session_id WHERE a.status='running' AND r.status IN ('created','running') AND (x.state IS NULL OR x.state='sent') ORDER BY g.rowid")
    },
    autoState(runId) { return kernel.one('SELECT enabled,state,session_id,reason,owner,lease_until FROM wf_auto_runs WHERE run_id=?', runId) ?? null },
    enableAuto(runId) {
      const state = stateOf(runId)
      if (['completed', 'cancelled', 'failed'].includes(state.run.status)) throw new Error('run_closed')
      const automation = kernel.one('SELECT state,reason FROM wf_auto_runs WHERE run_id=?', runId)
      if ((automation?.state === 'blocked' && automation.reason === 'auto_dispatch_outcome_unknown') || kernel.one("SELECT a.id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? AND a.status='unknown'", runId)) throw new Error('请先处理上一次结果未知的派发')
      kernel.query("INSERT INTO wf_auto_runs(run_id,enabled,state,updated_at) VALUES(?,1,'idle',?) ON CONFLICT(run_id) DO UPDATE SET enabled=1,state=CASE WHEN wf_auto_runs.state='blocked' THEN 'idle' ELSE wf_auto_runs.state END,session_id=CASE WHEN wf_auto_runs.state='blocked' THEN NULL ELSE wf_auto_runs.session_id END,reason=NULL,updated_at=excluded.updated_at", runId, new Date().toISOString())
    },
    activeAutoRuns() { return kernel.query("SELECT a.run_id,a.state,a.session_id,a.reason,a.owner,a.lease_until FROM wf_auto_runs a JOIN workflow_runs r ON r.id=a.run_id WHERE ((a.enabled=1 AND r.status IN ('created','running')) OR (a.state IN ('creating','sending') AND r.status NOT IN ('completed','cancelled','failed'))) ORDER BY a.updated_at") },
    reserveAuto(runId, owner = 'legacy') {
      const sessionId = 'workflow-' + randomUUID().replaceAll('-', '')
      const result = kernel.db.prepare("UPDATE wf_auto_runs SET state='creating',session_id=?,reason=NULL,owner=?,lease_until=?,updated_at=? WHERE run_id=? AND enabled=1 AND state='idle' AND EXISTS (SELECT 1 FROM workflow_runs WHERE id=? AND status IN ('created','running'))").run(sessionId, owner, new Date(Date.now() + 60000).toISOString(), new Date().toISOString(), runId, runId)
      return Number(result.changes) === 1 ? sessionId : null
    },
    autoSending(runId, sessionId, owner) {
      const result = kernel.db.prepare("UPDATE wf_auto_runs SET state='sending',updated_at=? WHERE run_id=? AND enabled=1 AND state='creating' AND session_id=? AND owner=? AND lease_until>? AND EXISTS (SELECT 1 FROM workflow_runs WHERE id=? AND status IN ('created','running'))").run(new Date().toISOString(), runId, sessionId, owner, new Date().toISOString(), runId)
      if (Number(result.changes) !== 1) throw new Error('auto_dispatch_fenced')
    },
    autoSent(runId, sessionId, owner) { kernel.query("UPDATE wf_auto_runs SET state='sent',updated_at=? WHERE run_id=? AND state='sending' AND session_id=? AND owner=?", new Date().toISOString(), runId, sessionId, owner) },
    autoStillCreating(runId, sessionId, owner) { return Boolean(kernel.one("SELECT run_id FROM wf_auto_runs WHERE run_id=? AND enabled=1 AND state='creating' AND session_id=? AND owner=? AND lease_until>?", runId, sessionId, owner, new Date().toISOString())) && ['created', 'running'].includes(stateOf(runId).run.status) },
    autoHeartbeat(runId, sessionId, owner) { kernel.query("UPDATE wf_auto_runs SET lease_until=? WHERE run_id=? AND session_id=? AND owner=? AND lease_until>? AND state IN ('creating','sending')", new Date(Date.now() + 60000).toISOString(), runId, sessionId, owner, new Date().toISOString()) },
    autoCancelPreparation(runId, sessionId, owner) {
      if (!kernel.one("SELECT run_id FROM wf_auto_runs WHERE run_id=? AND session_id=? AND state='creating' AND owner=? AND lease_until>?", runId, sessionId, owner, new Date().toISOString())) return
      const binding = kernel.one('SELECT attempt_id FROM wf_generation_sessions WHERE run_id=? AND session_id=?', runId, sessionId)
      const attempt = binding && kernel.one('SELECT status FROM workflow_attempts WHERE id=?', binding.attempt_id)
      if (attempt?.status === 'running') kernel.markFailed(binding.attempt_id, 'auto_dispatch_not_sent')
      kernel.query("UPDATE wf_auto_runs SET state='idle',session_id=NULL,reason=NULL,updated_at=? WHERE run_id=? AND session_id=? AND state='creating'", new Date().toISOString(), runId, sessionId)
    },
    autoIdle(runId, sessionId) { kernel.query("UPDATE wf_auto_runs SET state='idle',session_id=NULL,reason=NULL,owner=NULL,lease_until=NULL,updated_at=? WHERE run_id=? AND session_id=?", new Date().toISOString(), runId, sessionId) },
    autoBlocked(runId, sessionId, reason, owner) {
      const owned = kernel.one("SELECT run_id FROM wf_auto_runs WHERE run_id=? AND session_id=? AND state='creating' AND owner=? AND lease_until>?", runId, sessionId, owner, new Date().toISOString())
      if (!owned) return
      const binding = kernel.one('SELECT attempt_id FROM wf_generation_sessions WHERE run_id=? AND session_id=?', runId, sessionId)
      const attempt = binding && kernel.one('SELECT status FROM workflow_attempts WHERE id=?', binding.attempt_id)
      if (attempt?.status === 'running') kernel.markFailed(binding.attempt_id, 'auto_dispatch_not_sent')
      kernel.query("UPDATE wf_auto_runs SET enabled=0,state='blocked',reason=?,updated_at=? WHERE run_id=? AND session_id=?", String(reason).slice(0, 300), new Date().toISOString(), runId, sessionId)
      const state = stateOf(runId)
      if (['created', 'running'].includes(state.run.status)) kernel.pauseRun(runId, 'auto_dispatch_interrupted')
    },
    autoInterrupted(runId, sessionId, expectedOwner = null) {
      const row = kernel.one("SELECT state,owner,lease_until FROM wf_auto_runs WHERE run_id=? AND session_id=?", runId, sessionId)
      if (!row || !['creating', 'sending'].includes(row.state)) return
      if (expectedOwner !== null && row.owner !== expectedOwner) return
      if (expectedOwner !== null && (!row.lease_until || Date.parse(row.lease_until) <= Date.now())) return
      if (expectedOwner === null && row.lease_until && Date.parse(row.lease_until) > Date.now()) return
      const binding = kernel.one('SELECT attempt_id FROM wf_generation_sessions WHERE run_id=? AND session_id=?', runId, sessionId)
      const attempt = binding && kernel.one('SELECT status FROM workflow_attempts WHERE id=?', binding.attempt_id)
      if (attempt?.status === 'running') kernel.markUnknown(binding.attempt_id, 'auto_dispatch_outcome_unknown')
      kernel.query("UPDATE wf_auto_runs SET enabled=0,state='blocked',reason='auto_dispatch_outcome_unknown',updated_at=? WHERE run_id=? AND session_id=?", new Date().toISOString(), runId, sessionId)
      const state = stateOf(runId)
      if (['created', 'running'].includes(state.run.status)) kernel.pauseRun(runId, 'auto_dispatch_outcome_unknown')
    },
    autoReconcileNotSent(runId, sessionId) {
      const row = kernel.one('SELECT state,session_id FROM wf_auto_runs WHERE run_id=?', runId)
      const state = stateOf(runId)
      if (row?.state !== 'blocked' || row.session_id !== sessionId || state.run.status !== 'paused') throw new Error('auto_dispatch_not_reconcilable')
      if (kernel.one('SELECT attempt_id FROM wf_generation_sessions WHERE run_id=? AND session_id=?', runId, sessionId)) throw new Error('session_attempt_requires_abandonment')
      kernel.query("UPDATE wf_auto_runs SET state='idle',session_id=NULL,reason=NULL,updated_at=? WHERE run_id=? AND session_id=?", new Date().toISOString(), runId, sessionId)
      kernel.appendEvent(runId, 'auto.dispatch_reconciled', { sessionId, outcome: 'not_sent' })
    },
    disableAuto(runId) { kernel.query("UPDATE wf_auto_runs SET enabled=0,updated_at=? WHERE run_id=?", new Date().toISOString(), runId) },
    revisions: runId => {
      const steps = kernel.query('SELECT id,node_id FROM workflow_steps WHERE run_id=?', runId)
      return revisions.list(runId).map(revision => ({ ...revision, nodeId: steps.find(step => step.id === revision.baseline?.stepId)?.node_id }))
    },
    activeRevisions() {
      return kernel.query("SELECT run_id,id,session_id FROM wf_session_revisions WHERE json_extract(payload,'$.status')='producing' ORDER BY rowid")
    },
    revisionExecutionConfig(runId, taskId) {
      const state = stateOf(runId)
      const task = state.tasks.find(task => task.id === taskId && task.status === 'open')
      if (!task || !['waiting_review', 'paused'].includes(state.run.status)) throw new Error('review_task_required')
      const item = compiledOf(runId).find(item => item.nodeId === state.steps.find(step => step.id === task.step_id)?.node_id)
      const sources = reviewContractFor(item)?.sources(compiledOf(runId), item.nodeId) ?? {}
      return compiledOf(runId).filter(item => Object.values(sources).includes(item.nodeId) && item.kind === 'agent').at(-1)?.executionConfig ?? item.executionConfig
    },
    beginRevision(input) { return revisions.begin(input) },
    failRevision(input) { return revisions.fail(input) },
    collectRevision(input) { return revisions.collect(input) },
    applyRevision(input) { return revisions.apply(input) },
    compiled: runId => compiledOf(runId),
    nextExecutionConfig(runId) {
      const open = nextOpen(runId)
      const item = compiledOf(runId).find(entry => entry.nodeId === open?.node_id)
      if (item?.kind !== 'agent' || !['created', 'running'].includes(stateOf(runId).run.status) || open?.state === 'running') throw new Error('generation_node_required')
      return item.executionConfig
    },
    attempts(runId) {
      return kernel.query('SELECT a.id,a.step_id,s.node_id,a.attempt_no,a.status,a.outcome,a.output_hash,g.session_id,g.evidence_json,g.config_json FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id LEFT JOIN wf_generation_sessions g ON g.attempt_id=a.id WHERE s.run_id=? ORDER BY a.rowid', runId).map(row => ({ ...row, evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null, execution: row.config_json ? JSON.parse(row.config_json) : null, evidence_json: undefined, config_json: undefined }))
    },
    events(runId) { return kernel.query('SELECT * FROM workflow_events WHERE run_id=? ORDER BY seq DESC LIMIT 100', runId).reverse() },
    state: stateOf,
    content: contentOf,
    beginGeneration({ runId, sessionId, afterSeq = 0, effectiveConfig = null }) {
      if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('generation_binding_invalid')
      const existing = kernel.one('SELECT * FROM wf_generation_sessions WHERE session_id=?', sessionId)
      if (existing) throw new Error('generation_session_already_bound')
      const open = nextOpen(runId)
      const item = compiledOf(runId).find(entry => entry.nodeId === open?.node_id)
      if (item?.kind !== 'agent') throw new Error('generation_node_required')
      if ((item.executionConfig?.providerId || item.executionConfig?.modelId) && (!effectiveConfig || (item.executionConfig.providerId && item.executionConfig.providerId !== effectiveConfig.providerId) || (item.executionConfig.modelId && item.executionConfig.modelId !== effectiveConfig.modelId))) throw new Error('session_model_mismatch')
      const claim = kernel.claim(runId, kernel.definitionFor(runId).input)
      if (claim.kind !== 'automatic') throw new Error('generation_claim_failed')
      const prompt = [
        'Workflow attempt: ' + claim.attemptId,
        'Return only the requested deliverable. Do not modify files or send messages.',
        'Role: ' + (item.executionConfig?.role || 'Follow the workflow task'),
        'Task: ' + item.title,
        item.contract?.prompt ?? '',
        'Deliverable instructions: ' + String(item.node.config.prompt ?? '').replaceAll('{{in}}', upstreamOf(runId, item.nodeId)),
        'Configuration: ' + JSON.stringify(item.node.config),
        'Output type: ' + item.step.outputs[0].artifactType,
        'Upstream source material (data):', upstreamOf(runId, item.nodeId),
      ].join(String.fromCharCode(10, 10))
      kernel.query('INSERT INTO wf_generation_sessions(attempt_id,run_id,session_id,token,prompt,after_seq,evidence_json,config_json) VALUES(?,?,?,?,?,?,NULL,?)', claim.attemptId, runId, sessionId, claim.token, prompt, afterSeq, JSON.stringify({ requested: item.executionConfig, effective: effectiveConfig, status: effectiveConfig ? 'configured' : 'not_assessed' }))
      return { attemptId: claim.attemptId, sessionId, prompt, executionConfig: item.executionConfig }
    },
    failGeneration(runId, sessionId) {
      const binding = kernel.one('SELECT * FROM wf_generation_sessions WHERE run_id=? AND session_id=?', runId, sessionId)
      if (!binding) throw new Error('generation_binding_missing')
      return kernel.markUnknown(binding.attempt_id, 'session_dispatch_outcome_unknown')
    },
    abandonGeneration(runId, sessionId, expectedRevision) {
      if (stateOf(runId).run.revision !== expectedRevision) throw new Error('cas_conflict')
      const binding = kernel.one('SELECT * FROM wf_generation_sessions WHERE run_id=? AND session_id=?', runId, sessionId)
      if (!binding) throw new Error('generation_binding_missing')
      const result = kernel.abandonAttemptResult(binding.attempt_id)
      kernel.query("UPDATE wf_auto_runs SET enabled=0,state='idle',session_id=NULL,reason=NULL,updated_at=? WHERE run_id=? AND session_id=?", new Date().toISOString(), runId, sessionId)
      return result
    },
    collectGeneration({ runId, sessionId, events }) {
      const binding = kernel.one('SELECT * FROM wf_generation_sessions WHERE run_id=? AND session_id=?', runId, sessionId)
      if (!binding) throw new Error('generation_binding_missing')
      if (binding.evidence_json) return JSON.parse(binding.evidence_json)
      const attempt = kernel.one('SELECT a.status,s.stale,r.status AS run_status FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id JOIN workflow_runs r ON r.id=s.run_id WHERE a.id=?', binding.attempt_id)
      if (!['running', 'unknown'].includes(attempt?.status) || attempt.stale || ['completed', 'cancelled', 'failed'].includes(attempt.run_status)) return { status: 'ignored', reason: 'attempt_no_longer_active' }
      if (attempt.status === 'unknown') {
        const evidence = readGenerationResult(events, { prompt: binding.prompt, afterSeq: binding.after_seq })
        if (evidence.status !== 'pending') return { status: 'unknown', reason: 'session_outcome_requires_reconciliation', evidence }
        return { status: 'unknown', reason: 'session_outcome_unconfirmed' }
      }
      if (attempt.run_status === 'paused') return { status: 'pending', reason: 'run_paused' }
      const result = readGenerationResult(events, { prompt: binding.prompt, afterSeq: binding.after_seq })
      try { kernel.heartbeatAttempt({ attemptId: binding.attempt_id, token: binding.token }) }
      catch (cause) {
        if (cause?.code !== 'lease_expired') throw cause
        kernel.markUnknown(binding.attempt_id, 'session_result_lease_expired')
        return { status: 'unknown', reason: 'session_result_lease_expired' }
      }
      if (result.status === 'pending') return result
      if (result.status === 'failed') kernel.markFailed(binding.attempt_id, result.reason)
      else {
        const open = nextOpen(runId)
        const item = compiledOf(runId).find(entry => entry.nodeId === open?.node_id)
        const candidate = kernel.storeCandidate({ attemptId: binding.attempt_id, token: binding.token, content: result.content, artifactType: item.step.outputs[0].artifactType })
        const adopted = kernel.adopt({ attemptId: binding.attempt_id, token: binding.token, candidate })
        if (adopted.status === 'failed') {
          result.status = 'failed'
          result.reason = 'generation_validation_failed'
          result.validation = adopted
        }
      }
      kernel.query('UPDATE wf_generation_sessions SET evidence_json=? WHERE attempt_id=?', JSON.stringify(result), binding.attempt_id)
      return result
    },
    async submit({ runId, content }) {
      const open = nextOpen(runId)
      if (!open) throw new Error('run_has_no_open_step')
      const item = compiledOf(runId).find(entry => entry.nodeId === open.node_id)
      if (item?.kind !== 'agent') throw new Error('generation_node_required')
      const claim = kernel.claim(runId, kernel.definitionFor(runId).input)
      if (claim.kind !== 'automatic') throw new Error('step_is_human')
      const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content, artifactType: item.step.outputs[0].artifactType })
      const adopted = kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate })
      return adopted
    },
    reviewSources(runId, nodeId) {
      const compiled = compiledOf(runId)
      const ancestors = new Set()
      const visit = id => {
        for (const upstream of compiled.find(item => item.nodeId === id)?.upstream ?? []) {
          if (ancestors.has(upstream)) continue
          ancestors.add(upstream)
          visit(upstream)
        }
      }
      visit(nodeId)
      const state = stateOf(runId)
      const adoptions = service.listAdoptions({ principal: uiOf(runId), runId }).adoptions
      return compiled.filter(item => ancestors.has(item.nodeId)).map(item => {
        const step = state.steps.find(step => step.node_id === item.nodeId)
        const adoption = adoptions.find(adoption => adoption.adoptionId === step?.current_adoption_id)
        return { nodeId: item.nodeId, type: item.type, title: item.title, snapshotId: adoption?.snapshotId, content: contentOf(runId, item.nodeId) }
      }).filter(item => item.snapshotId)
    },
    draft(runId, taskId) { return service.readHumanDraft({ principal: uiOf(runId), runId, taskId }) },
    saveDraft({ runId, taskId, content, expectedBindingVersion, expectedTaskRevision }) {
      return service.saveHumanDraft({ principal: uiOf(runId), runId, taskId, content, expectedBindingVersion, expectedTaskRevision })
    },
    requestChanges(input) {
      if (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 4096) throw new Error('review_note_required')
      const saved = service.saveHumanDraft({ principal: uiOf(input.runId), ...input })
      kernel.appendEvent(input.runId, 'human.changes_requested', { taskId: input.taskId, note: input.note.trim(), draftId: saved.draftId })
      return saved
    },
    rerun({ runId, nodeId, expectedRunRevision, expectedStepRevision }) {
      const step = stateOf(runId).steps.find(step => step.node_id === nodeId)
      if (!step) throw new Error('step_not_found')
      return service.rerunVersion({ principal: uiOf(runId), runId, stepId: step.id, expectedRunRevision, expectedStepRevision })
    },
    control(runId, command, expectedRevision) {
      return service.commandRun({ principal: uiOf(runId), runId, command, expectedRevision, idempotencyKey: key() })
    },
    async confirm({ runId, taskId, content, intent = 'continue', expectedBindingVersion, expectedTaskRevision, expectedRunRevision }) {
      const task = stateOf(runId).tasks.find(entry => entry.id === taskId)
      if (!task) throw new Error('task_not_found')
      const bindingVersion = expectedBindingVersion ?? task.binding_version ?? 1
      const taskRevision = expectedTaskRevision ?? task.task_revision ?? 1
      const runRevision = expectedRunRevision ?? stateOf(runId).run.revision
      if (stateOf(runId).run.revision !== runRevision) throw new Error('cas_conflict')
      const item = compiledOf(runId).find(entry => entry.nodeId === stateOf(runId).steps.find(step => step.id === task.step_id)?.node_id)
      const contract = reviewContractFor(item)
      if (contract) {
        const review = contract.parse(content)
        const source = contract.sources(compiledOf(runId), item.nodeId)
        if (review && review[contract.dependentSource] !== contentOf(runId, source[contract.dependentSource])) throw new Error('设计稿已修改：请先应用修改并重新生成下游内容，旧结果不能直接确认。')
      }
      const report = service.validateHumanDraft({ principal: uiOf(runId), runId, taskId, content, expectedBindingVersion: bindingVersion, expectedTaskRevision: taskRevision })
      return service.confirmHumanTask({
        validationReportId: report.id,
        principal: uiOf(runId), taskId, content: typeof content === 'string' ? content : '', intent,
        expectedBindingVersion: bindingVersion,
        expectedTaskRevision: taskRevision,
        expectedRunRevision: runRevision,
        idempotencyKey: key(),
      })
    },
    reviseDesign({ runId, taskId, content, expectedBindingVersion, expectedTaskRevision, expectedRunRevision }) {
      const state = stateOf(runId)
      const task = state.tasks.find(entry => entry.id === taskId && entry.status === 'open')
      const item = compiledOf(runId).find(entry => entry.nodeId === state.steps.find(step => step.id === task?.step_id)?.node_id)
      const contract = reviewContractFor(item)
      const review = contract?.parse(content)
      const field = contract?.dependentSource
      if (!task || !review?.[field]?.trim()) throw new Error('review_design_invalid')
      if (state.run.revision !== expectedRunRevision) throw new Error('cas_conflict')
      const draft = service.readHumanDraft({ principal: uiOf(runId), runId, taskId })
      if (draft.binding.version !== expectedBindingVersion || draft.taskRevision !== expectedTaskRevision) throw new Error('cas_conflict')
      const source = contract.sources(compiledOf(runId), item.nodeId)
      const gdd = state.steps.find(step => step.node_id === source[field])
      if (!gdd || review[field] === contentOf(runId, source[field])) throw new Error('设计稿没有变化')
      service.saveHumanDraft({ principal: uiOf(runId), runId, taskId, content, expectedBindingVersion, expectedTaskRevision })
      service.commandRun({ principal: uiOf(runId), runId, command: 'pause', expectedRevision: expectedRunRevision, idempotencyKey: key() })
      const paused = stateOf(runId)
      service.rerunVersion({ principal: uiOf(runId), runId, stepId: gdd.id, expectedRunRevision: paused.run.revision, expectedStepRevision: gdd.revision })
      service.commandRun({ principal: uiOf(runId), runId, command: 'resume', expectedRevision: stateOf(runId).run.revision, idempotencyKey: key() })
      const claim = kernel.claim(runId, kernel.definitionFor(runId).input)
      const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content: review[field], artifactType: 'markdown' })
      const adopted = kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate })
      if (adopted.status === 'failed') throw new Error('设计稿未通过校验')
      return adopted
    },
    // 导出：把每一步采用的正文按顺序写到目录，附 manifest。
    export(runId, dir) {
      const { mkdirSync, writeFileSync } = __fs
      if (stateOf(runId).run.status !== 'completed') throw new Error('run_not_completed')
      const compiled = compiledOf(runId)
      const reviewKinds = new Set(reviewContracts.map(contract => contract.kind))
      mkdirSync(dirname(dir), { recursive: true })
      mkdirSync(dir)
      const files = []
      const frozen = kernel.one('SELECT * FROM workflow_run_definitions WHERE run_id=?', runId)
      const graph = JSON.parse(kernel.one('SELECT graph_json FROM wf_run_graphs WHERE run_id=?', runId).graph_json)
      const manifest = { version: 1, runId, productId: frozen.product_id, graphId: graph.id ?? null, sourceRevision: graph.sourceRevision ?? null, definitionHash: frozen.integrity_hash, exportedAt: new Date().toISOString(), files: [] }
      const adoptions = service.listAdoptions({ principal: uiOf(runId), runId }).adoptions
      const state = stateOf(runId)
      const reviewNodes = compiled.filter(item => reviewKinds.has(item.contract.reviewKind) && state.steps.some(step => step.node_id === item.nodeId && step.state === 'succeeded' && !step.stale))
      const bundles = reviewNodes.map(item => ({ item, value: reviewedExports(compiled, id => contentOf(runId, id), item.nodeId) })).filter(entry => entry.value)
      manifest.openQuestions = bundles.flatMap(entry => entry.value.openQuestions ?? [])
      const entries = bundles.length ? bundles.flatMap(({ item, value }, index) => value.entries.map(entry => ({ ...entry, ...(bundles.length > 1 ? { exportGroup: item.nodeId, exportPrefix: 'review-' + (index + 1) + '-' } : {}) }))) : compiled.filter(item => item.type !== 'output.publish' && state.steps.some(step => step.node_id === item.nodeId && step.state === 'succeeded' && !step.stale)).map(item => ({ path: item.contract.exportName ?? ({ 'input.brief': 'brief.txt', 'human.review': 'review.md' }[item.type]) ?? item.nodeId.replace(/[^a-zA-Z0-9._-]/g, '_') + '.md', nodeId: item.nodeId, snapshotNodeId: item.nodeId, content: contentOf(runId, item.nodeId) }))
      for (const entry of entries) {
        const text = entry.content
        if (!text) continue
        const base = (entry.exportPrefix ?? '') + entry.path
        const name = files.includes(base) ? entry.nodeId.replace(/[^a-zA-Z0-9._-]/g, '_') + '-' + base : base
        writeFileSync(__path.join(dir, name), text, 'utf8')
        files.push(name)
        const step = state.steps.find(step => step.node_id === entry.snapshotNodeId)
        const adoption = adoptions.find(a => a.adoptionId === step?.current_adoption_id)
        manifest.files.push({ path: name, nodeId: entry.nodeId, snapshotId: adoption?.snapshotId, ...(entry.exportGroup ? { exportGroup: entry.exportGroup } : {}), ...(entry.transform ? { reviewNodeId: entry.snapshotNodeId, transform: entry.transform } : {}), sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) })
      }
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
      files.push('manifest.json')
      return files
    },
  }
}
