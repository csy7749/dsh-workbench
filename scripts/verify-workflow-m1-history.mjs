// Temporary SQLite only: W1-04 rerun prerequisite, not complete history acceptance.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
const step = (nodeId, nodeKind = 'automatic', publishTargets = []) => ({ nodeId, nodeKind, requiredChecks: [], publishTargets })
let checks = 0
const test = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'm1-history-'))
  const k = createWorkflowKernel(new DatabaseSync(join(root, 'db.sqlite')), root)
  try { fn(k, root); checks++ } finally { k.db.close(); rmSync(root, { recursive: true, force: true }) }
}
const setup = k => {
  k.createRun({ id: 'r', steps: [step('a', 'automatic', [{ target: 'pd:test', required: true }]), step('b')] })
  const a = k.claim('r')
  const adopted = k.adopt({ ...a, candidate: k.storeCandidate({ ...a, content: 'first' }), target: 'pd:test' })
  return { a, adopted }
}
const args = k => ({ stepId: 'r:step:1', expectedRunRevision: k.one('SELECT revision FROM workflow_runs WHERE id=?', 'r').revision, expectedStepRevision: k.one('SELECT revision FROM workflow_steps WHERE id=?', 'r:step:1').revision })
const fingerprint = k => JSON.stringify(['workflow_runs','workflow_steps','workflow_attempts','workflow_adoptions','workflow_outbox','workflow_events','workflow_snapshots','workflow_human_tasks','workflow_drafts','workflow_requests','workflow_input_bindings'].map(t => k.query(`SELECT * FROM ${t} ORDER BY rowid`)))
const reject = (k, input, code) => {
  const before = fingerprint(k)
  assert.throws(() => k.rerunStep(input), e => e.code === code)
  assert.equal(fingerprint(k), before)
}
test(k => {
  const { adopted } = setup(k)
  reject(k, args(k), 'run_not_paused')
  k.pauseRun('r')
  reject(k, { ...args(k), expectedStepRevision: -1 }, 'cas_conflict')
  const oldAttempts = JSON.stringify(k.query('SELECT * FROM workflow_attempts'))
  k.rerunStep(args(k))
  assert.equal(JSON.stringify(k.query('SELECT * FROM workflow_attempts')), oldAttempts)
  assert.equal(k.one('SELECT status FROM workflow_runs').status, 'paused')
  assert.equal(k.one('SELECT status FROM workflow_outbox').status, 'superseded')
  k.resume('r')
  const a = k.claim('r')
  const second = k.adopt({ ...a, candidate: k.storeCandidate({ ...a, content: 'second' }), target: 'pd:test' })
  assert.equal(k.query('SELECT * FROM workflow_adoptions WHERE step_id=?', 'r:step:1').length, 2)
  assert.equal(k.one('SELECT previous_id FROM workflow_adoptions WHERE id=?', second.adoptionId).previous_id, adopted.adoptionId)
  assert.equal(k.readSnapshot(second.snapshotId).parentId, adopted.snapshotId)
  assert.equal(k.readSnapshot(adopted.snapshotId).content, 'first')
})
for (const unknown of [false, true]) test(k => {
  setup(k)
  const next = k.claim('r')
  if (unknown) k.markUnknown(next.attemptId)
  else k.pauseRun('r')
  reject(k, args(k), unknown ? 'attempt_outcome_unknown' : 'attempt_in_flight')
})
for (const status of ['running', 'outcome_unknown', 'failed', 'conflict']) test(k => {
  setup(k)
  // Fixture for publisher states (no real publisher).
  k.db.prepare('UPDATE workflow_outbox SET status=?').run(status)
  k.pauseRun('r')
  reject(k, args(k), 'publish_unresolved')
})
test(k => {
  setup(k)
  k.cancelRun('r')
  reject(k, args(k), 'run_closed')
})
// H9: changed human input creates a distinct task without damaging old history.
test(k => {
  k.createRun({ id: 'r', human: true, steps: [step('human.edit-confirm', 'human')] })
  const first = k.claim('r', { value: 1 })
  const task = k.one('SELECT * FROM workflow_human_tasks WHERE id=?', first.taskId)
  k.confirmHuman({ taskId: first.taskId, content: 'human v1', actorId: 'fixture', inputFingerprint: task.input_hash, expectedRunRevision: args(k).expectedRunRevision, expectedTaskRevision: 1, intent: 'pause', expectedBindingVersion: k.inputBindingFor(first.taskId).version })
  const original = JSON.stringify(k.one('SELECT * FROM workflow_human_tasks WHERE id=?', first.taskId))
  k.rerunStep(args(k)); k.resume('r')
  const next = k.claim('r', { value: 2 })
  assert.notEqual(next.taskId, first.taskId)
  assert.equal(JSON.stringify(k.one('SELECT * FROM workflow_human_tasks WHERE id=?', first.taskId)), original)
  const secondTask = k.one('SELECT * FROM workflow_human_tasks WHERE id=?', next.taskId)
  k.confirmHuman({ taskId: next.taskId, content: 'human v2', actorId: 'fixture', inputFingerprint: secondTask.input_hash, expectedRunRevision: args(k).expectedRunRevision, expectedTaskRevision: secondTask.task_revision, intent: 'pause', expectedBindingVersion: k.inputBindingFor(next.taskId).version })
  assert.equal(k.query('SELECT * FROM workflow_adoptions').length, 2)
})
// H10: only target and downstream pending publications are superseded, with event IDs.
test(k => {
  k.createRun({ id: 'r', steps: ['a', 'b', 'c'].map((id, index) => step(id, 'automatic', [{ target: `pd:${['one', 'two', 'three'][index]}`, required: true }])) })
  for (const name of ['one','two','three']) {
    const a = k.claim('r')
    k.adopt({ ...a, candidate: k.storeCandidate({ ...a, content: name }), target: `pd:${name}` })
  }
  k.pauseRun('r')
  k.rerunStep({ ...args(k), stepId: 'r:step:2', expectedStepRevision: k.one('SELECT revision FROM workflow_steps WHERE id=?', 'r:step:2').revision })
  const items = k.query('SELECT * FROM workflow_outbox ORDER BY rowid')
  assert.equal(items[0].status, 'pending')
  assert.deepEqual(items.slice(1).map(i => [i.status, i.reason]), [['superseded','step_rerun'],['superseded','step_rerun']])
  assert.equal(k.one('SELECT stale FROM workflow_steps WHERE id=?', 'r:step:3').stale, 1)
  const payload = JSON.parse(k.one("SELECT payload FROM workflow_events WHERE type='step.rerun_requested'").payload)
  assert.deepEqual(payload.supersededOutboxIds, items.slice(1).map(i => i.id))
})
// H11: shelved downstream human task reopens with its draft intact.
test(k => {
  k.createRun({ id: 'r', steps: [step('a'), step('human', 'human')] })
  const a = k.claim('r')
  k.adopt({ ...a, candidate: k.storeCandidate({ ...a, content: 'upstream' }) })
  const human = k.claim('r')
  const draft = k.saveDraft({ taskId: human.taskId, content: 'keep draft', expectedBindingVersion: k.inputBindingFor(human.taskId).version })
  k.pauseRun('r'); k.rerunStep(args(k))
  assert.equal(k.one('SELECT status FROM workflow_human_tasks').status, 'stale')
  k.resume('r')
  const retry = k.claim('r')
  k.adopt({ ...retry, candidate: k.storeCandidate({ ...retry, content: 'upstream v2' }) })
  const reopened = k.claim('r')
  assert.equal(reopened.taskId, human.taskId)
  const task = k.one('SELECT * FROM workflow_human_tasks')
  assert.equal(task.status, 'open'); assert.equal(task.task_revision, 3)
  assert.equal(task.draft_id, draft.draftId)
  assert.equal(k.query('SELECT * FROM workflow_drafts').length, 1)
  const before = fingerprint(k)
  assert.throws(() => k.confirmHuman({ taskId: human.taskId, content: 'keep draft', actorId: 'fixture', expectedTaskRevision: 3, expectedBindingVersion: k.inputBindingFor(human.taskId).version }), e => e.code === 'input_fingerprint_conflict')
  assert.equal(fingerprint(k), before)
  k.saveDraft({ taskId: human.taskId, content: 'reviewed against new input', expectedTaskRevision: 3, expectedBindingVersion: k.inputBindingFor(human.taskId).version, rebind: true })
  k.confirmHuman({ taskId: human.taskId, content: 'reviewed against new input', actorId: 'fixture', expectedTaskRevision: 4, intent: 'pause', expectedBindingVersion: k.inputBindingFor(human.taskId).version })
})
// H12: expired execution still needs explicit reconciliation, without a surprise claim.
test(k => {
  setup(k)
  k.claim('r')
  k.db.prepare("UPDATE workflow_attempts SET lease_until='2000-01-01T00:00:00.000Z' WHERE status='running'").run()
  k.pauseRun('r')
  reject(k, args(k), 'attempt_lease_expired')
})
// H13: fail after candidate durability; rollback cleans its manifest and permits retry.
test((k, root) => {
  k.createRun({ id: 'r', human: true, steps: [step('human.edit-confirm', 'human')] })
  const task = k.claim('r')
  const input = { taskId: task.taskId, content: 'retry unchanged', actorId: 'fixture', intent: 'pause', expectedBindingVersion: k.inputBindingFor(task.taskId).version }
  // Synthetic stale flag reaches adoptTx after storeCandidate, without production hooks.
  k.db.prepare('UPDATE workflow_steps SET stale=1 WHERE id=?').run('r:step:1')
  const before = fingerprint(k)
  assert.throws(() => k.confirmHuman(input), e => e.code === 'step_stale')
  assert.equal(fingerprint(k), before)
  assert.deepEqual(readdirSync(join(root, 'manifests')), [])
  assert.equal(k.query('SELECT * FROM workflow_attempts').length, 0)
  const pending = k.one('SELECT * FROM workflow_human_tasks WHERE id=?', task.taskId)
  assert.equal(pending.status, 'open'); assert.equal(pending.task_revision, 1)
  k.db.prepare('UPDATE workflow_steps SET stale=0 WHERE id=?').run('r:step:1')
  const result = k.confirmHuman(input)
  assert.equal(k.readSnapshot(result.snapshotId).content, input.content)
  assert.equal(k.query('SELECT * FROM workflow_attempts').length, 1)
  assert.equal(readdirSync(join(root, 'manifests')).length, 1)
})
// B1/B2/B3/B5: input excludes own prior output and old bindings survive rerun.
test(k => {
  const { a, adopted } = setup(k)
  assert.deepEqual(k.inputBindingFor(a.attemptId).inputs, [])
  const b = k.claim('r')
  const old = k.inputBindingFor(b.attemptId)
  assert.equal(old.inputs[0].snapshotId, adopted.snapshotId)
  k.adopt({ ...b, candidate: k.storeCandidate({ ...b, content: 'second step' }) })
  k.pauseRun('r'); k.rerunStep(args(k)); k.resume('r')
  const again = k.claim('r')
  assert.deepEqual(k.inputBindingFor(again.attemptId).inputs, [])
  const updated = k.adopt({ ...again, candidate: k.storeCandidate({ ...again, content: 'updated upstream' }), target: 'pd:test' })
  const next = k.claim('r')
  assert.equal(k.inputBindingFor(next.attemptId).inputs[0].snapshotId, updated.snapshotId)
  assert.deepEqual(k.inputBindingFor(b.attemptId), old)
  assert.notEqual(k.one('SELECT input_hash FROM workflow_attempts WHERE id=?', b.attemptId).input_hash, k.one('SELECT input_hash FROM workflow_attempts WHERE id=?', next.attemptId).input_hash)
  k.db.prepare('DELETE FROM workflow_input_bindings WHERE owner_id=?').run(next.attemptId)
  assert.throws(() => k.inputBindingFor(next.attemptId), e => e.code === 'attempt_input_unbound')
})
console.log(JSON.stringify({ checks, passed: checks, scope: 'W1-04 rerun and input binding prerequisite; temporary SQLite' }))
