import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { groupRunNodes } from '../src/client/workflow/run-node-summary.ts'
import { artifactPreviewFormat } from '../src/shared/workflow-artifact-format.ts'

assert.equal(artifactPreviewFormat('# GDD', { nodeType: 'game.gdd', artifactKind: 'markdown' }), 'markdown')
assert.equal(artifactPreviewFormat('{"buildId":"b1"}', { nodeType: 'game.package', artifactKind: 'json' }), 'json')
assert.equal(artifactPreviewFormat('{bad', { nodeType: 'check.rules', artifactKind: 'markdown' }), 'json', 'invalid JSON remains in JSON preview with a raw fallback')
assert.equal(artifactPreviewFormat('plain input', { nodeType: 'input.brief' }), 'text')

const step = (nodeId, sourceAttemptId = null) => ({
  stepId: 'step:' + nodeId, nodeId, sourceAttemptId, title: 'Same task name',
  revision: 1, type: 'dsh.generate', kind: 'agent', state: 'succeeded', stale: false, content: 'output:' + nodeId,
})
const attempt = (id, nodeId, overrides = {}) => ({
  id, node_id: nodeId, step_id: 'step:' + nodeId, attempt_no: 1,
  session_id: 'session:' + id, status: 'succeeded', outcome: 'accepted', ...overrides,
})
const revision = (id, stepId, status = 'ready') => ({
  id, sessionId: 'revision-session:' + id, status, note: 'Review request', prompt: '',
  baseline: { stepId, taskId: 'task:' + stepId },
})
const run = {
  steps: [step('a', 'a2'), step('b', 'b1'), { ...step('review'), kind: 'human' }, step('empty')],
  // Deliberately interleaved: neither display order nor title establishes ownership.
  attempts: [
    attempt('b1', 'b', { execution: { effective: { providerId: 'actual', modelId: 'model-b' } } }),
    attempt('a1', 'a', { execution: { requested: { modelId: 'model-a' } } }),
    attempt('a2', 'a', { attempt_no: 2 }),
    attempt('manual-review', 'review', { session_id: null }),
    attempt('a3', 'a', { attempt_no: 3, status: 'failed', outcome: 'validation_failed' }),
    attempt('unbound', 'missing'),
  ],
  // Closed reviews retain their sessions even without a current waiting task.
  revisions: [revision('r1', 'step:review', 'applied'), revision('r2', 'step:review'), revision('orphan', 'step:missing')],
  waiting: null,
}
const before = JSON.stringify(run)
const grouped = groupRunNodes(run)
assert.equal(JSON.stringify(run), before, 'grouping must not mutate run records')
assert.deepEqual(grouped.nodes.map(node => node.step.nodeId), ['a', 'b', 'review', 'empty'])
assert.deepEqual(grouped.nodes.map(node => node.sessions.map(session => session.sessionId)), [
  ['session:a1', 'session:a2', 'session:a3'], ['session:b1'], ['revision-session:r1', 'revision-session:r2'], [],
])
assert.deepEqual(grouped.unassigned.map(session => session.sessionId), ['session:unbound', 'revision-session:orphan'])
const [old, current, failed] = grouped.nodes[0].sessions
assert.equal(old.result, '已被后续产物替代')
assert.equal(current.result, '当前产物来源')
assert.equal(current.purpose, '第 2 次尝试')
assert.equal(failed.result, '未采用')
assert.equal(failed.reason, 'validation_failed')
assert.match(old.model, /请求模型.*未确认生效/)
assert.equal(grouped.nodes[1].sessions[0].model, '实际模型：actual / model-b')
assert.equal(grouped.nodes[2].sessions[0].result, '已应用到草稿，人工确认另行记录')
assert.equal(grouped.nodes[2].sessions[1].result, '候选待应用')
assert.equal(groupRunNodes({ ...run, steps: [{ ...run.steps[0], stale: true }] }).nodes[0].sessions[1].result, '历史产物来源 · 已失效')

// A same-numbered successful attempt is not enough to claim the current artifact.
assert.equal(groupRunNodes({ steps: [step('a')], attempts: [attempt('a1', 'a')] }).nodes[0].sessions[0].result, '曾采用 · 当前来源未核实')
const legacy = groupRunNodes({
  steps: [step('a')], attempts: [attempt('legacy', undefined, { step_id: 'step:a' })],
  waiting: { nodeId: 'a', taskId: 'task:a', revisions: [{ ...revision('legacy-r', undefined), baseline: { taskId: 'task:a' } }] },
})
assert.equal(legacy.nodes[0].sessions.length, 2, 'explicit legacy step/task bindings remain usable')
assert.equal(legacy.unassigned.length, 0)
const unknown = groupRunNodes({ steps: [step('a')], attempts: [attempt('unknown', undefined, { step_id: undefined })] })
assert.equal(unknown.nodes[0].sessions.length, 0)
assert.equal(unknown.unassigned.length, 1, 'unknown ownership must not be guessed')

// Exercise the actual run drawer with lightweight elements; no DSH/model calls.
const source = readFileSync(new URL('../src/client/workflow/canvas-panel.tsx', import.meta.url), 'utf8')
const viewer = source.slice(source.indexOf('function artifactEsc'), source.indexOf('\nexport function CanvasPanel'))
const drawer = source.slice(source.indexOf('  const runDrawer ='), source.indexOf("\n  return h('div', { className: 'wf dsh-wf-root'"))
assert(drawer.includes('groupRunNodes(run)'), 'render the production drawer, not copied markup')
const compiled = ts.transpileModule(viewer + '\n(() => {\n' + drawer + '\nreturn { tree: runDrawer(), viewer: ArtifactViewer, markdown: markdownPreviewHtml }\n})()', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
let expanded = {}
const opened = []
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) })
const { nativeGameLinks } = await import('../src/shared/native-game-links.ts')
const globals = {
  nativeGameLinks,
  run: { ...run, runId: 'test', status: 'completed', validations: [], events: [] },
  runDetailsOpen: true, displayMode: 'progress', runBusy: false, groupRunNodes, h, focusRunNodeId: '',
  setFocusRunNodeId: id => { globals.focusRunNodeId = id },
  useState: value => [value, () => {}],
  props: { openSession: id => opened.push(id) }, expandedRunNodes: expanded,
  setExpandedRunNodes: update => { expanded = update(expanded); globals.expandedRunNodes = expanded },
  RUN_STATUS: { completed: 'complete' }, STEP_STATUS: { succeeded: 'done' },
}
const evaluate = () => vm.runInNewContext(compiled, globals)
const render = () => evaluate().tree
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : []
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node.children.map(text).join(' ')
const byClass = (root, name) => walk(root).filter(node => node.props.className === name)
let tree = render()
assert.equal(byClass(tree, 'wf-run-node-card').length, 4)
assert.equal(byClass(tree, 'wf-run-node-body').length, 0, 'completed nodes start collapsed')
assert.equal(byClass(tree, 'wf-run-overview').length, 1, 'overall progress remains visible')
walk(tree).find(node => node.type === 'button' && text(node) === '展开全部').props.onClick()
tree = render()
assert.equal(byClass(tree, 'wf-run-node-body').length, 4)
const cards = byClass(tree, 'wf-run-node-card')
assert.equal(byClass(cards[0], 'wf-run-session').length, 3)
assert.equal(byClass(cards[1], 'wf-run-session').length, 1)
assert.equal(byClass(cards[2], 'wf-run-session').length, 2)
for (const card of cards.slice(0, 3)) {
  for (const button of walk(card).filter(node => node.type === 'button' && text(node) === '打开会话')) button.props.onClick()
}
assert.deepEqual(opened, ['session:a1', 'session:a2', 'session:a3', 'session:b1', 'revision-session:r1', 'revision-session:r2'])
assert(walk(cards[0]).some(node => node.type === 'summary' && text(node) === '查看完整产物'))
const api = evaluate()
const markdown = api.viewer({ content: '# GDD\n\n| 名称 | 值 |\n| --- | --- |\n| 分数 | **10** |\n\n```js\nalert(1)\n```', format: 'markdown' })
assert.match(markdown.children[1].props.dangerouslySetInnerHTML.__html, /<table>/)
assert.match(markdown.children[1].props.dangerouslySetInnerHTML.__html, /<strong>10<\/strong>/)
assert.match(markdown.children[1].props.dangerouslySetInnerHTML.__html, /<pre><code>alert\(1\)<\/code><\/pre>/)
assert.match(api.markdown('# <img src=x onerror=alert(1)>'), /&lt;img/)
const json = api.viewer({ content: '{"buildId":"b1"}', format: 'json' })
assert.equal(json.children[1].children[0], '{\n  "buildId": "b1"\n}')
const malformed = api.viewer({ content: '{bad', format: 'json' })
assert.equal(malformed.children[1].children[0], 'JSON 无法解析，已保留原文供检查。')
assert.equal(malformed.children[2].children[0], '{bad')
walk(tree).find(node => node.type === 'button' && text(node) === '收起全部').props.onClick()
assert.equal(byClass(render(), 'wf-run-node-body').length, 0)
globals.expandedRunNodes = {}
globals.run = { ...globals.run, status: 'running', steps: [{ ...run.steps[0], state: 'running' }, ...run.steps.slice(1)] }
assert.equal(byClass(render(), 'wf-run-node-body').length, 1, 'active nodes expand automatically')
globals.run = { ...globals.run, status: 'paused', pauseReason: 'validation failed', steps: [{ ...run.steps[0], state: 'paused' }, ...run.steps.slice(1)] }
tree = render()
assert.equal(byClass(tree, 'wf-run-node-body').length, 1, 'paused nodes expand automatically')
assert.match(text(byClass(tree, 'wf-run-attention')[0]), /validation failed/)
walk(byClass(tree, 'wf-run-attention')[0]).find(node => node.type === 'button').props.onClick()
assert.equal(globals.focusRunNodeId, 'a', 'attention action targets the exact node id')
assert.equal(globals.expandedRunNodes['test:a'], true, 'attention action reopens its node details')
console.log('PASS node grouping: interleaved attempts, retries, closed revisions, current artifact source, legacy bindings and unassigned sessions')
