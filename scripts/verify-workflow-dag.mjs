import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'
import { normalizeGraph, validateGraph } from '../src/shared/workflow-catalog.ts'

const root = mkdtempSync(join(tmpdir(), 'workflow-dag-'))
const runner = createWorkflowRunner({ dbPath: join(root, 'db.sqlite'), root: join(root, 'objects') })
try {
  const graph = { version: 1, name: 'branch', line: 'game', nodes: [
    { id: 'a', type: 'input.brief', x: 0, y: 0, config: { text: 'A' } },
    { id: 'b', type: 'input.brief', x: 0, y: 0, config: { text: 'B' } },
    { id: 'join', type: 'flow.join', x: 0, y: 0, config: { order: '按端口', separator: '|' } },
    { id: 'review', type: 'human.review', x: 0, y: 0, config: {} },
  ], edges: [
    { from: { node: 'b', port: 'out' }, to: { node: 'join', port: 'b' } },
    { from: { node: 'a', port: 'out' }, to: { node: 'join', port: 'a' } },
    { from: { node: 'join', port: 'out' }, to: { node: 'review', port: 'in' } },
  ] }
  runner.start({ graph, runId: 'dag' })
  assert.equal((await runner.advance('dag')).status, 'waiting_human')
  assert.equal(runner.content('dag', 'join'), 'A\n\n|\n\nB')
  const joinStep = runner.kernel.one("SELECT * FROM workflow_steps WHERE run_id='dag' AND node_id='join'")
  const attempt = runner.kernel.one('SELECT id FROM workflow_attempts WHERE step_id=?', joinStep.id)
  const inputs = runner.kernel.inputBindingFor(attempt.id).inputs
  assert.deepEqual(inputs.map(item => [item.nodeId, item.toPort]), [['b', 'b'], ['a', 'a']])
  assert.deepEqual(inputs.map(item => runner.kernel.readSnapshot(item.snapshotId).content), ['B', 'A'])
  runner.kernel.pauseRun('dag')
  const a = runner.kernel.one("SELECT * FROM workflow_steps WHERE run_id='dag' AND node_id='a'")
  runner.kernel.rerunStep({ stepId: a.id, expectedStepRevision: a.revision, expectedRunRevision: runner.kernel.one("SELECT revision FROM workflow_runs WHERE id='dag'").revision })
  const state = runner.kernel.query("SELECT node_id,state FROM workflow_steps WHERE run_id='dag' ORDER BY rowid")
  assert.equal(state.find(step => step.node_id === 'b').state, 'succeeded')
  assert.equal(state.find(step => step.node_id === 'join').state, 'stale')
  assert.equal(state.find(step => step.node_id === 'review').state, 'stale')
  assert.deepEqual(runner.kernel.inputBindingFor(attempt.id).inputs, inputs)
  runner.kernel.resume('dag')
  assert.equal((await runner.advance('dag')).status, 'waiting_human')
  const nextAttempt = runner.kernel.one('SELECT id FROM workflow_attempts WHERE step_id=? ORDER BY attempt_no DESC LIMIT 1', joinStep.id)
  const rebound = runner.kernel.inputBindingFor(nextAttempt.id).inputs
  assert.notEqual(rebound.find(input => input.nodeId === 'a').snapshotId, inputs.find(input => input.nodeId === 'a').snapshotId)
  assert.equal(rebound.find(input => input.nodeId === 'b').snapshotId, inputs.find(input => input.nodeId === 'b').snapshotId)
  assert.equal(runner.content('dag', 'join'), 'A\n\n|\n\nB')
  const unknown = normalizeGraph({ ...graph, nodes: [...graph.nodes, { id: 'missing', type: 'external.missing', x: 1, y: 2, config: { nested: { keep: true } } }], edges: [...graph.edges, { from: { node: 'missing', port: 'out' }, to: { node: 'a', port: 'unknown' } }] }, 'game')
  assert.deepEqual(unknown.graph.nodes.find(node => node.id === 'missing').config.nested, { keep: true })
  assert(unknown.graph.edges.some(edge => edge.from.node === 'missing'))
  const missingLine = normalizeGraph({ ...graph, line: 'missing-pack', nodes: [{ ...graph.nodes[0], config: { ...graph.nodes[0].config, futureField: { retain: true } } }] }, 'game')
  assert.equal(missingLine.graph.line, 'missing-pack')
  assert.deepEqual(missingLine.graph.nodes[0].config.futureField, { retain: true })
  assert(validateGraph(missingLine.graph).some(issue => issue.code === 'line_unknown'))
  const agentGraph = { version: 1, name: 'unknown session', line: 'game', nodes: [
    { id: 'source', type: 'input.brief', x: 0, y: 0, config: { text: 'brief' } },
    { id: 'agent', type: 'dsh.generate', x: 300, y: 0, config: { prompt: 'write' } },
  ], edges: [{ from: { node: 'source', port: 'out' }, to: { node: 'agent', port: 'in' } }] }
  runner.start({ graph: agentGraph, runId: 'abandon' })
  await runner.advance('abandon')
  const generation = runner.beginGeneration({ runId: 'abandon', sessionId: 'uncertain' })
  assert.deepEqual(runner.activeGenerations().filter(item => item.run_id === 'abandon').map(item => [item.run_id, item.session_id]), [['abandon', 'uncertain']])
  runner.kernel.markUnknown(generation.attemptId, 'dispatch_unknown')
  const revision = runner.state('abandon').run.revision
  assert.equal(runner.abandonGeneration('abandon', 'uncertain', revision).remoteOutcome, 'unknown')
  assert.equal(runner.kernel.one('SELECT outcome FROM workflow_attempts WHERE id=?', generation.attemptId).outcome, 'result_abandoned_remote_outcome_unknown')
  assert.equal(runner.collectGeneration({ runId: 'abandon', sessionId: 'uncertain', events: [] }).status, 'ignored')
  console.log('PASS DAG frozen inputs, join order, descendant invalidation, unknown-node preservation')
} finally {
  runner.kernel.db.close()
  rmSync(root, { recursive: true, force: true })
}
