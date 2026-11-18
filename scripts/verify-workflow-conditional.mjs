import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'

const root = mkdtempSync(join(tmpdir(), 'workflow-conditional-'))
const runner = createWorkflowRunner({ dbPath: join(root, 'db.sqlite'), root: join(root, 'objects') })
const graph = (text, strict = false) => ({ version: 1, line: 'game', name: 'conditional', nodes: [
  { id: 'brief', type: 'input.brief', x: 0, y: 0, config: { text } },
  { id: 'check', type: 'check.rules', x: 300, y: 0, config: { rules: '无占位符', strict } },
  { id: 'pass', type: 'human.review', x: 600, y: 0, config: {} },
  { id: 'fail', type: 'human.review', x: 600, y: 300, config: {} },
], edges: [
  { from: { node: 'brief', port: 'out' }, to: { node: 'check', port: 'in' } },
  { from: { node: 'check', port: 'pass' }, to: { node: 'pass', port: 'in' } },
  { from: { node: 'check', port: 'fail' }, to: { node: 'fail', port: 'in' } },
] })
try {
  runner.start({ graph: graph('Ready for review'), runId: 'pass' })
  let step = await runner.advance('pass')
  assert.equal(step.waiting.nodeId, 'pass')
  let draft = runner.draft('pass', step.waiting.taskId)
  assert.equal(draft.currentInput.content, 'Ready for review')
  await runner.confirm({ runId: 'pass', taskId: step.waiting.taskId, content: 'Approved', expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision, expectedRunRevision: runner.state('pass').run.revision })
  await runner.advance('pass')
  assert.equal(runner.state('pass').run.status, 'completed')
  assert.equal(runner.state('pass').steps.find(item => item.node_id === 'fail').state, 'skipped')

  runner.start({ graph: graph('待补充'), runId: 'fail' })
  step = await runner.advance('fail')
  assert.equal(step.waiting.nodeId, 'fail')
  assert.equal(runner.state('fail').steps.find(item => item.node_id === 'pass').state, 'skipped')
  draft = runner.draft('fail', step.waiting.taskId)
  assert.equal(JSON.parse(draft.currentInput.content).ok, false)
  assert.deepEqual(JSON.parse(draft.currentInput.content).problems, ['含占位符'])
  const binding = runner.kernel.inputBindingFor(step.waiting.taskId)
  assert.equal(binding.inputs[0].fromPort, 'fail')
  assert.equal(JSON.parse(runner.kernel.readSnapshot(binding.inputs[0].snapshotId).content).kind, 'workflow-check-v1')

  const before = runner.state('fail')
  runner.control('fail', 'pause', before.run.revision)
  const paused = runner.state('fail')
  const check = paused.steps.find(item => item.node_id === 'check')
  runner.rerun({ runId: 'fail', nodeId: 'check', expectedRunRevision: paused.run.revision, expectedStepRevision: check.revision })
  assert.equal(runner.state('fail').steps.find(item => item.node_id === 'pass').state, 'stale')
  runner.control('fail', 'resume', runner.state('fail').run.revision)
  const reentered = await runner.advance('fail')
  assert.equal(reentered.waiting.nodeId, 'fail')
  assert.equal(runner.state('fail').steps.find(item => item.node_id === 'pass').state, 'skipped')
  assert.notEqual(runner.kernel.inputBindingFor(reentered.waiting.taskId).inputs[0].snapshotId, binding.inputs[0].snapshotId)

  runner.start({ graph: graph('待补充', true), runId: 'strict' })
  await runner.advance('strict')
  assert.equal(runner.state('strict').run.status, 'paused')
  assert.equal(runner.state('strict').run.pause_reason, 'check_failed')
  const mixed = graph('Ready for merge')
  mixed.nodes.push({ id: 'independent', type: 'input.brief', x: 0, y: 600, config: { text: 'other branch' } })
  mixed.nodes.push({ id: 'join', type: 'flow.join', x: 900, y: 400, config: { order: '按端口' } })
  mixed.edges.push({ from: { node: 'pass', port: 'out' }, to: { node: 'join', port: 'a' } })
  mixed.edges.push({ from: { node: 'fail', port: 'out' }, to: { node: 'join', port: 'b' } })
  mixed.edges.push({ from: { node: 'independent', port: 'out' }, to: { node: 'join', port: 'c' } })
  runner.start({ graph: mixed, runId: 'merge' })
  const review = await runner.advance('merge')
  const mergedDraft = runner.draft('merge', review.waiting.taskId)
  await runner.confirm({ runId: 'merge', taskId: review.waiting.taskId, content: 'Approved', expectedBindingVersion: mergedDraft.binding.version, expectedTaskRevision: mergedDraft.taskRevision, expectedRunRevision: runner.state('merge').run.revision })
  await runner.advance('merge')
  assert.equal(runner.state('merge').steps.find(item => item.node_id === 'join').state, 'skipped')
  assert.equal(runner.state('merge').steps.find(item => item.node_id === 'independent').state, 'succeeded')
  assert.equal(runner.state('merge').run.status, 'completed')
  mixed.nodes.find(node => node.id === 'join').config.policy = '任一命中'
  runner.start({ graph: mixed, runId: 'merge-any' })
  const anyReview = await runner.advance('merge-any')
  const anyDraft = runner.draft('merge-any', anyReview.waiting.taskId)
  await runner.confirm({ runId: 'merge-any', taskId: anyReview.waiting.taskId, content: 'Approved', expectedBindingVersion: anyDraft.binding.version, expectedTaskRevision: anyDraft.taskRevision, expectedRunRevision: runner.state('merge-any').run.revision })
  await runner.advance('merge-any')
  assert.equal(runner.state('merge-any').run.status, 'completed')
  assert.equal(runner.content('merge-any', 'join'), 'Approved\n\n---\n\nother branch')
  const joinAttempt = runner.kernel.one("SELECT a.id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id='merge-any' AND s.node_id='join'")
  const anyBinding = runner.kernel.inputBindingFor(joinAttempt.id)
  assert.deepEqual(anyBinding.inputs.map(input => input.nodeId), ['pass', 'independent'])
  assert.equal(anyBinding.omissions[0].reason, 'upstream_skipped')
  assert.equal(anyBinding.omissions[0].nodeId, 'fail')
  const reopened = createWorkflowRunner({ dbPath: join(root, 'db.sqlite'), root: join(root, 'objects') })
  try { assert.deepEqual(reopened.kernel.inputBindingFor(joinAttempt.id), anyBinding) } finally { reopened.kernel.db.close() }

  const direct = graph('Ready')
  direct.nodes = direct.nodes.filter(node => !['pass', 'fail'].includes(node.id))
  direct.nodes.push({ id: 'join', type: 'flow.join', x: 600, y: 0, config: { policy: '任一命中' } })
  direct.edges = [direct.edges[0], ...['pass', 'fail'].map((port, index) => ({ from: { node: 'check', port }, to: { node: 'join', port: index ? 'b' : 'a' } }))]
  runner.start({ graph: direct, runId: 'direct-any' })
  await runner.advance('direct-any')
  assert.equal(runner.content('direct-any', 'join'), 'Ready')
  const directAttempt = runner.kernel.one("SELECT a.id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id='direct-any' AND s.node_id='join'")
  const directBinding = runner.kernel.inputBindingFor(directAttempt.id)
  assert.equal(directBinding.omissions[0].reason, 'port_inactive')
  assert.equal(directBinding.omissions[0].fromPort, 'fail')
  assert.equal(directBinding.omissions[0].snapshotId, directBinding.inputs[0].snapshotId)
  const skipAll = graph('Ready')
  skipAll.nodes = skipAll.nodes.filter(node => node.id !== 'pass')
  skipAll.nodes.push({ id: 'join', type: 'flow.join', x: 900, y: 300, config: { policy: '任一命中' } })
  skipAll.edges = skipAll.edges.filter(edge => edge.to.node !== 'pass')
  skipAll.edges.push({ from: { node: 'fail', port: 'out' }, to: { node: 'join', port: 'a' } })
  runner.start({ graph: skipAll, runId: 'skip-all' })
  await runner.advance('skip-all')
  assert.equal(runner.state('skip-all').run.status, 'completed')
  assert.equal(runner.state('skip-all').steps.find(item => item.node_id === 'join').state, 'skipped')
  assert.equal(runner.content('skip-all', 'join'), '')

  const reroute = structuredClone(direct)
  reroute.nodes.splice(1, 0, { id: 'gen', type: 'dsh.generate', x: 200, y: 0, config: { prompt: 'Write' } })
  reroute.edges[0].to = { node: 'gen', port: 'in' }
  reroute.edges.push({ from: { node: 'gen', port: 'out' }, to: { node: 'check', port: 'in' } })
  reroute.nodes.push({ id: 'review', type: 'human.review', x: 900, y: 0, config: {} })
  reroute.edges.push({ from: { node: 'join', port: 'out' }, to: { node: 'review', port: 'in' } })
  runner.start({ graph: reroute, runId: 'reroute' })
  await runner.advance('reroute')
  await runner.submit({ runId: 'reroute', content: 'Ready' })
  await runner.advance('reroute')
  const oldJoin = runner.kernel.one("SELECT a.id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id='reroute' AND s.node_id='join'")
  const oldBinding = runner.kernel.inputBindingFor(oldJoin.id)
  runner.control('reroute', 'pause', runner.state('reroute').run.revision)
  const oldState = runner.state('reroute')
  runner.rerun({ runId: 'reroute', nodeId: 'gen', expectedRunRevision: oldState.run.revision, expectedStepRevision: oldState.steps.find(item => item.node_id === 'gen').revision })
  runner.control('reroute', 'resume', runner.state('reroute').run.revision)
  await runner.advance('reroute')
  await runner.submit({ runId: 'reroute', content: '待补充' })
  const rerouted = await runner.advance('reroute')
  assert.equal(rerouted.waiting.nodeId, 'review')
  assert.equal(JSON.parse(runner.content('reroute', 'join')).ok, false)
  const newJoin = runner.kernel.one("SELECT a.id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id='reroute' AND s.node_id='join' ORDER BY a.attempt_no DESC LIMIT 1")
  assert.equal(runner.kernel.inputBindingFor(newJoin.id).inputs[0].fromPort, 'fail')
  assert.deepEqual(runner.kernel.inputBindingFor(oldJoin.id), oldBinding)
  console.log('PASS conditional pass/fail payloads, skipped branches, frozen snapshot and strict pause')
} finally {
  runner.kernel.db.close()
  rmSync(root, { recursive: true, force: true })
}
