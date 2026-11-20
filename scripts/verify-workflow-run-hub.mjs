/** Isolated read-model, shared polling, rendering and navigation checks; no DSH/model sessions. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'
import { runCounts, runNeedsAttention, sortRunSummaries } from '../src/shared/workflow-run-summary.ts'
import { createRunMonitor } from '../src/client/workflow/run-monitor.ts'
import { renderRunHub } from '../src/client/workflow/run-hub.ts'
import { requestWorkflowNavigation, takeWorkflowNavigation, WORKFLOW_NAVIGATION_EVENT } from '../src/client/workflow/run-navigation.ts'
import { groupRunNodes } from '../src/client/workflow/run-node-summary.ts'

const root = mkdtempSync(join(tmpdir(), 'wf-hub-'))
const runner = createWorkflowRunner({ dbPath: join(root, 'runs.sqlite'), root: join(root, 'content'), productId: 'product-a' })
const graph = {
  version: 1, id: 'graph-a', name: 'Frozen flow', line: 'game', nodes: [
    { id: 'brief', type: 'input.brief', x: 0, y: 0, config: { text: 'private input, never shown in hub' } },
    { id: 'generate', type: 'dsh.generate', title: 'Generate deliverable', x: 250, y: 0, config: { prompt: 'private prompt' } },
    { id: 'review', type: 'human.review', x: 500, y: 0, config: {} },
    { id: 'output', type: 'output.publish', x: 750, y: 0, config: { target: '文件导出' } },
  ], edges: [
    { from: { node: 'brief', port: 'out' }, to: { node: 'generate', port: 'in' } },
    { from: { node: 'generate', port: 'out' }, to: { node: 'review', port: 'in' } },
    { from: { node: 'review', port: 'out' }, to: { node: 'output', port: 'in' } },
  ],
}
try {
  runner.start({ graph, runId: 'old' })
  await runner.advance('old')
  runner.start({ graph, runId: 'new', productId: 'product-b' })
  await runner.advance('new')
  const summaries = runner.listSummaries()
  assert.equal(summaries.length, 2)
  assert.deepEqual(new Set(summaries.map(run => run.productId)), new Set(['product-a', 'product-b']))
  assert.equal(summaries[0].stepsJson.includes('private prompt'), false)
  assert.equal(summaries[0].stepsJson.includes('private input'), false)
  assert(JSON.parse(summaries[0].stepsJson).some(step => step.title === 'Generate deliverable'))
  assert.equal(runner.frozenGraph('old').name, 'Frozen flow')
  runner.kernel.query("UPDATE workflow_steps SET state='succeeded',stale=1 WHERE run_id='old' AND node_id='generate'")
  runner.kernel.query("UPDATE workflow_steps SET state='skipped' WHERE run_id='old' AND node_id='output'")
  const steps = JSON.parse(runner.listSummaries().find(run => run.runId === 'old').stepsJson)
  assert.equal(steps.filter(step => step.state === 'succeeded' && !step.stale).length, 1)
  assert.equal(steps.filter(step => step.state === 'skipped' && !step.stale).length, 1)
  for (let i = 0; i < 22; i++) {
    const runId = 'closed-' + String(i).padStart(2, '0')
    runner.start({ graph, runId })
    runner.control(runId, 'cancel', runner.state(runId).run.revision)
  }
  assert.equal(runner.listSummaries().filter(run => run.status === 'cancelled').length, 20)
  assert.equal(runner.listSummaries().filter(run => run.status !== 'cancelled').length, 2, 'recent-history cap never hides active runs')
} finally { runner.kernel.db.close() }

const row = {
  runId: 'old', graphId: 'graph-a', graphName: '<img src=x onerror=alert(1)>', productId: 'a',
  productName: 'Product A', projectName: 'Project', workspacePath: 'D:/project', status: 'running',
  pauseReason: null, autoState: null, autoReason: null, createdAt: '2026-11-19T01:00:00Z', updatedAt: '2026-11-19T01:10:00Z',
  completedSteps: 1, totalSteps: 4, skippedSteps: 1, currentNodeId: 'generate', currentNodeTitle: 'Generate', needsAttention: false,
}
assert.equal(runNeedsAttention({ ...row, status: 'paused', pauseReason: 'user_paused' }), false)
assert.equal(runNeedsAttention({ ...row, status: 'paused', pauseReason: 'validation_failed' }), true)
assert.equal(runNeedsAttention({ ...row, status: 'completed', autoState: 'blocked' }), false)
assert.equal(runNeedsAttention({ ...row, status: 'failed' }), true)
assert.equal(runNeedsAttention({ ...row, status: 'waiting_review' }), true)
assert.equal(runNeedsAttention({ ...row, autoState: 'blocked' }), true)
assert.equal(sortRunSummaries([row, { ...row, runId: 'review', needsAttention: true, status: 'waiting_review' }])[0].runId, 'review')
assert.deepEqual(runCounts([row, { ...row, status: 'waiting_review', needsAttention: true }]), { active: 2, running: 1, attention: 1 })

let answer
let requests = 0
const monitor = createRunMonitor(async () => {
  requests++
  return await new Promise(resolve => { answer = resolve })
})
let sidebar, portal
const stopSidebar = monitor.subscribe(state => { sidebar = state })
const stopPortal = monitor.subscribe(state => { portal = state })
const first = monitor.refresh()
assert.equal(requests, 1, 'all subscribers and concurrent refresh share one request')
answer({ ok: true, json: async () => ({ ok: true, runs: [row], fetchedAt: '2026-11-19T01:10:00Z' }) })
await first
assert.equal(sidebar, portal)
assert.equal(sidebar.runs[0].runId, 'old')
const failure = monitor.refresh()
answer({ ok: false, status: 503, json: async () => ({ ok: false, error: 'offline' }) })
await failure
assert.equal(monitor.snapshot().runs[0].runId, 'old', 'read failures preserve previous runs')
assert.match(monitor.snapshot().error, /offline/)
const malformed = monitor.refresh()
answer({ ok: true, json: async () => ({ ok: true, runs: [null] }) })
await malformed
assert.equal(monitor.snapshot().runs[0].runId, 'old')
assert.match(monitor.snapshot().error, /格式不完整/)
const html = renderRunHub(monitor.snapshot())
assert.match(html, /保留上次读取结果/)
assert.match(html, /&lt;img/)
assert(!html.includes('<img'), 'untrusted names are escaped')
assert.match(html, /跳过 1/)
assert(!renderRunHub(monitor.snapshot(), { project: 'D:/other' }).includes('data-wf-open="old"'))
assert(renderRunHub(monitor.snapshot(), { project: 'd:/PROJECT' }).includes('data-wf-open="old"'))
assert(!renderRunHub({ ...monitor.snapshot(), loaded: false, runs: [] }).includes('暂无运行'), 'initial errors do not claim zero runs')
const restored = monitor.refresh()
answer({ ok: true, json: async () => ({ ok: true, runs: [row] }) })
await restored
assert.equal(monitor.snapshot().error, '')
const late = monitor.refresh()
stopSidebar()
stopPortal()
answer({ ok: true, json: async () => ({ ok: true, runs: [] }) })
await late
assert.equal(monitor.snapshot().runs.length, 1, 'late results cannot replace state after the last unsubscribe')
const stopAgain = monitor.subscribe(() => {})
const again = monitor.refresh()
answer({ ok: true, json: async () => ({ ok: true, runs: [row] }) })
await again
stopAgain()

const oldDocument = globalThis.document
const testDocument = new EventTarget()
testDocument.visibilityState = 'hidden'
globalThis.document = testDocument
let visibleRequests = 0
const visibilityMonitor = createRunMonitor(async () => {
  visibleRequests++
  return { ok: true, json: async () => ({ ok: true, runs: [] }) }
})
const stopVisibility = visibilityMonitor.subscribe(() => {})
await visibilityMonitor.refresh()
testDocument.dispatchEvent(new Event('visibilitychange'))
assert.equal(visibleRequests, 1, 'hiding does not start extra requests')
testDocument.visibilityState = 'visible'
testDocument.dispatchEvent(new Event('visibilitychange'))
await visibilityMonitor.refresh()
assert.equal(visibleRequests, 2, 'returning to the visible page refreshes immediately')
stopVisibility()
testDocument.dispatchEvent(new Event('visibilitychange'))
assert.equal(visibleRequests, 2, 'last unsubscribe removes the visibility listener')
globalThis.document = oldDocument

const oldWindow = globalThis.window
globalThis.window = new EventTarget()
let navigationEvents = 0, selectedPanel
window.addEventListener(WORKFLOW_NAVIGATION_EVENT, () => { navigationEvents++ })
requestWorkflowNavigation({ view: 'run', run: row }, key => { selectedPanel = key })
assert.equal(selectedPanel, 'workbench')
assert.equal(navigationEvents, 1)
assert.equal(takeWorkflowNavigation().run.runId, 'old', 'navigation survives before the workbench is mounted')
assert.equal(takeWorkflowNavigation(), null, 'navigation is consumed exactly once')
globalThis.window = oldWindow

// Execute the actual component with a small hook host, as in the existing drawer regression.
// This checks loading/navigation/editor behavior, not a substitute for desktop React acceptance.
const canvasSource = readFileSync(new URL('../src/client/workflow/canvas-panel.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('canvas.tsx', canvasSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'CanvasPanel').getText(parsed).replace(/^export /, '')
const compiled = ts.transpileModule(component + '\nCanvasPanel', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const fakeRun = {
  runId: 'old', revision: 3, status: 'waiting_review', auto: null, attempts: [], revisions: [], validations: [], events: [],
  steps: [{ stepId: 'review-step', nodeId: 'review', title: 'Human review', state: 'waiting_review', type: 'human.review', kind: 'human', revision: 1, stale: false, content: '' }],
  waiting: { kind: 'human', nodeId: 'review', taskId: 'review-task', content: 'server draft' },
}
async function inspectorHarness(owner = 'a') {
  const hooks = [], effects = [], cleanups = [], requests = []
  let cursor = 0, dirty = false, tree
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) })
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const useMemo = (factory, deps) => {
    const index = cursor++
    if (!hooks[index] || !equal(hooks[index].deps, deps)) hooks[index] = { deps, value: factory() }
    return hooks[index].value
  }
  let draftReads = 0
  const drafts = new Map([['a', { id: 'unrelated-unsaved-graph' }]])
  const globals = {
    h, PRODUCT_LINES: [{ id: 'game' }], groupRunNodes, RUN_STATUS: { waiting_review: '等待确认' }, STEP_STATUS: {},
    historyStack: () => ({}), canvasDrafts: drafts, installDraftWarning() {},
    readCanvasDraft: () => { draftReads++; return null }, ArtifactViewer() {},
    workflowRunMonitor: { refresh: async () => {} },
    document: { addEventListener() {}, removeEventListener() {} }, window: {},
    setTimeout: () => 1, clearTimeout() {}, useMemo,
    useCallback: (fn, deps) => useMemo(() => fn, deps),
    useRef: value => { const index = cursor++; return hooks[index] ??= { current: value } },
    useState: initial => {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, update => {
        const value = typeof update === 'function' ? update(hooks[index].value) : update
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true }
      }]
    },
    useEffect: (fn, deps) => {
      const index = cursor++
      if (hooks[index] && equal(hooks[index].deps, deps)) return
      hooks[index] = { deps }
      effects.push(() => { cleanups[index]?.(); cleanups[index] = fn() })
    },
    call: async path => {
      requests.push(path)
      assert(path === '/runs/old/context' || path === '/runs/old', 'inspector must never load newest history, live graphs or catalog')
      return { ok: true, data: { graph: { name: 'Frozen flow', sourceRevision: 1 }, productId: owner, view: fakeRun } }
    },
  }
  const Panel = vm.runInNewContext(compiled, globals)
  const props = { initialRunId: 'old', initialNodeId: 'review', productId: 'a', productPath: 'D:/project' }
  const render = async () => {
    for (let i = 0; i < 12; i++) {
      cursor = 0; dirty = false; tree = Panel(props)
      while (effects.length) effects.shift()()
      await new Promise(resolve => setImmediate(resolve))
      if (!dirty) break
    }
    return tree
  }
  await render()
  assert.equal(draftReads, 0, 'opening a run never restores or consumes another graph draft')
  assert.equal(drafts.get('a').id, 'unrelated-unsaved-graph')
  return { render, requests, get tree() { return tree }, dispose: () => cleanups.forEach(fn => fn?.()) }
}
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : []
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node.children.map(text).join(' ')
const inspector = await inspectorHarness()
assert.equal(inspector.tree.props['data-dsh-workflow-run'], 'old')
assert.equal(walk(inspector.tree).filter(node => node.props.className === 'wf-run-node-card').length, 1)
assert(!text(inspector.tree).includes('新建运行'), 'frozen inspector never presents live-graph editing controls')
walk(inspector.tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'unsaved human edits' } })
await inspector.render()
await walk(inspector.tree).find(node => node.type === 'button' && text(node) === '重新读取').props.onClick()
await inspector.render()
assert.equal(walk(inspector.tree).find(node => node.type === 'textarea').props.value, 'unsaved human edits', 'refresh preserves unsaved human edits')
inspector.dispose()
const mismatch = await inspectorHarness('other-product')
assert.match(text(mismatch.tree), /产品归属不匹配/)
assert.equal(walk(mismatch.tree).filter(node => node.props.className === 'wf-run-node-card').length, 0)
mismatch.dispose()
console.log('PASS workflow hub: bounded history, product identity, frozen runs, state classification, stale/skipped steps, shared polling, failure/recovery/unsubscribe, escaped rendering and exact pending navigation')
