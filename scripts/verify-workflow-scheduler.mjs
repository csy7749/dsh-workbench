import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'
import { createWorkflowScheduler } from '../src/host/workflow-scheduler.mjs'
const log = []
let generations = [{ run_id: 'run-a', session_id: 'session-a' }]
let revisions = [{ run_id: 'run-b', id: 'revision-b', session_id: 'session-b' }]
const runs = {
  activeGenerations: () => generations,
  activeRevisions: () => revisions,
  collectGeneration: input => { log.push(['collect', input.runId, input.events[0]]); generations = []; return { status: 'completed' } },
  collectRevision: input => { log.push(['revision', input.runId, input.events[0]]) },
}
const scheduler = createWorkflowScheduler({ runs, sessionEvents: id => ['events:' + id], advance: async id => { log.push(['advance', id]) } })
try {
  await scheduler.tick()
  assert.deepEqual(log, [['collect', 'run-a', 'events:session-a'], ['advance', 'run-a'], ['revision', 'run-b', 'events:session-b']])
  scheduler.dispose()
  revisions = [{ run_id: 'run-c', id: 'revision-c', session_id: 'session-c' }]
  await scheduler.tick()
  assert.equal(log.length, 3)
  console.log('PASS durable scheduler: collects after client disconnect, advances, collects revisions, disposes cleanly')
} finally { scheduler.dispose() }

const root = mkdtempSync(join(tmpdir(), 'workflow-scheduler-runner-'))
const runner = createWorkflowRunner({ dbPath: join(root, 'db.sqlite'), root: join(root, 'objects') })
const graph = { version: 1, name: 'recover', line: 'game', nodes: [
  { id: 'brief', type: 'input.brief', x: 0, y: 0, config: { text: 'write a design' } },
  { id: 'draft', type: 'dsh.generate', x: 300, y: 0, config: { prompt: 'Create a concrete design' } },
  { id: 'publish', type: 'output.publish', x: 600, y: 0, config: { target: '文件导出' } },
], edges: [
  { from: { node: 'brief', port: 'out' }, to: { node: 'draft', port: 'in' } },
  { from: { node: 'draft', port: 'out' }, to: { node: 'publish', port: 'in' } },
] }
try {
  runner.start({ graph, runId: 'recovered' })
  assert.equal((await runner.advance('recovered')).status, 'needs_agent')
  const binding = runner.beginGeneration({ runId: 'recovered', sessionId: 'session-recovered' })
  const events = [
    { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: binding.prompt }] } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '# Concrete design' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const recovery = createWorkflowScheduler({ runs: runner, sessionEvents: () => events, advance: id => runner.advance(id) })
  try {
    await recovery.tick()
    assert.equal(runner.state('recovered').run.status, 'completed')
    assert.equal(runner.content('recovered', 'draft'), '# Concrete design')
    assert.equal(runner.activeGenerations().length, 0)
  } finally { recovery.dispose() }
  runner.start({ graph, runId: 'expired' })
  await runner.advance('expired')
  const expired = runner.beginGeneration({ runId: 'expired', sessionId: 'session-expired' })
  runner.kernel.query("UPDATE workflow_attempts SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?", expired.attemptId)
  const uncertain = runner.collectGeneration({ runId: 'expired', sessionId: 'session-expired', events: [] })
  assert.equal(uncertain.status, 'unknown')
  assert.equal(runner.state('expired').run.pause_reason, 'session_result_lease_expired')
  assert.equal(runner.activeGenerations().some(item => item.run_id === 'expired'), false)
  console.log('PASS workflow restart recovery: persisted session result is adopted and downstream steps advance without a client')
} finally {
  runner.kernel.db.close()
  rmSync(root, { recursive: true, force: true })
}
