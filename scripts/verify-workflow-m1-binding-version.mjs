import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../src/workflow/m1-fake-service.mjs'
let checks = 0
for (const withDraft of [false, true]) {
  const root = mkdtempSync(join(tmpdir(), 'm1-binding-version-'))
  const k = createWorkflowKernel(new DatabaseSync(join(root, 'db.sqlite')), root)
  try {
    const service = createFakeBusinessService({ kernel: k })
    service.registerPrincipal({ id: 'ui', kind: 'ui', productId: 'p' })
    k.createRun({ id: 'r', steps: [{ nodeId: 'a', nodeKind: 'automatic', requiredChecks: [], publishTargets: [] }, { nodeId: 'b', nodeKind: 'human', requiredChecks: [], publishTargets: [] }] })
    service.host.registerRunProduct('r', 'p')
    const produce = content => { const a = k.claim('r'); k.adopt({ ...a, candidate: k.storeCandidate({ ...a, content }) }) }
    produce('upstream v1')
    const taskId = k.claim('r').taskId
    const version = service.listHumanTasks({ principal: 'ui' }).tasks[0].bindingVersion
    assert.equal(version, k.inputBindingFor(taskId).version)
    const fingerprint = () => JSON.stringify(k.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%' ORDER BY name").map(({name}) => k.query(`SELECT * FROM ${name} ORDER BY rowid`)))
    const reject = (fn, code) => { const before = fingerprint(); assert.throws(fn, e => e.code === code); assert.equal(fingerprint(), before); checks++ }
    for (const invalid of [undefined, null, '1', -1, 1.5]) {
      reject(() => k.saveDraft({ taskId, content: 'bad', expectedBindingVersion: invalid }), 'input_binding_stale')
      reject(() => k.confirmHuman({ taskId, content: 'bad', actorId: 'ui', expectedBindingVersion: invalid }), 'input_binding_stale')
    }
    if (withDraft) {
      k.saveDraft({ taskId, content: 'draft v1', expectedBindingVersion: version })
      assert.equal(k.inputBindingFor(taskId).version, version)
    }
    const old = { principal: 'ui', taskId, content: 'accepted', expectedBindingVersion: version, expectedTaskRevision: withDraft ? 2 : 1, idempotencyKey: 'same-request', intent: 'pause' }
    const first = service.confirmHumanTask(old)
    assert.equal(service.confirmHumanTask(old).adoptionId, first.adoptionId)
    const kernelReplay = { ...old, actorId: 'ui', idempotencyKey: `confirm:${taskId}:${old.expectedTaskRevision}` }
    const replay = k.confirmHuman(kernelReplay)
    assert.equal(replay.replayed, true)
    assert.equal(replay.adoptionId, first.adoptionId)
    checks++
    k.rerunStep({ stepId: 'r:step:1', expectedRunRevision: k.one('SELECT revision FROM workflow_runs').revision, expectedStepRevision: k.one("SELECT revision FROM workflow_steps WHERE id='r:step:1'").revision })
    k.resume('r'); produce('upstream v2'); assert.equal(k.claim('r').taskId, taskId)
    const current = k.inputBindingFor(taskId).version
    assert.notEqual(current, version)
    reject(() => service.confirmHumanTask(old), 'schema_invalid')
    reject(() => k.confirmHuman(kernelReplay), 'input_binding_stale')
    reject(() => k.saveDraft({ taskId, content: 'late draft', expectedTaskRevision: current, expectedBindingVersion: version }), 'input_binding_stale')
    reject(() => k.confirmHuman({ taskId, content: 'late original', actorId: 'ui', expectedTaskRevision: current, expectedBindingVersion: version }), 'input_binding_stale')
    if (withDraft) {
      reject(() => k.saveDraft({ taskId, content: 'reviewed v2', expectedTaskRevision: current, expectedBindingVersion: current }), 'input_fingerprint_conflict')
      k.saveDraft({ taskId, content: 'reviewed v2', expectedTaskRevision: current, expectedBindingVersion: current, rebind: true })
    }
    const accepted = service.confirmHumanTask({ ...old, idempotencyKey: 'new-request', expectedTaskRevision: withDraft ? current + 1 : current, expectedBindingVersion: current })
    const snapshot = k.one('SELECT source_attempt_id FROM workflow_snapshots WHERE id=?', accepted.snapshotId)
    assert.equal(k.inputBindingFor(snapshot.source_attempt_id).version, current)
    checks++
  } finally { k.db.close(); rmSync(root, { recursive: true, force: true }) }
}
for (const damage of ['missing', 'digest']) {
  const root = mkdtempSync(join(tmpdir(), 'm1-binding-list-'))
  const k = createWorkflowKernel(new DatabaseSync(join(root, 'db.sqlite')), root)
  try {
    const s = createFakeBusinessService({ kernel: k })
    s.registerPrincipal({ id: 'ui', kind: 'ui', productId: 'p' })
    s.registerPrincipal({ id: 'other', kind: 'ui', productId: 'other' })
    const tasks = []
    for (const id of ['healthy', 'broken']) {
      k.createRun({ id, human: true }); s.host.registerRunProduct(id, 'p')
      tasks.push(k.claim(id).taskId)
    }
    if (damage === 'missing') k.db.prepare('DELETE FROM workflow_input_bindings WHERE owner_id=?').run(tasks[1])
    else k.db.prepare("UPDATE workflow_input_bindings SET integrity_hash='bad' WHERE owner_id=?").run(tasks[1])
    const fingerprint = () => JSON.stringify(k.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%' ORDER BY name").map(({name}) => k.query(`SELECT * FROM ${name} ORDER BY rowid`)))
    const before = fingerprint()
    const rows = s.listHumanTasks({ principal: 'ui' }).tasks
    assert.equal(rows.length, 2)
    assert.equal(rows[0].bindingVersion, k.inputBindingFor(tasks[0]).version)
    assert.equal(rows[0].bindingUsable, true)
    assert.equal(rows[1].bindingVersion, null)
    assert.equal(rows[1].bindingUsable, false)
    assert.deepEqual(rows[1].bindingError, { code: 'artifact_missing', detail: damage === 'missing' ? 'attempt_input_unbound' : 'attempt_input_invalid' })
    assert.deepEqual(s.listHumanTasks({ principal: 'other' }).tasks, [])
    assert.throws(() => s.confirmHumanTask({ principal: 'ui', taskId: tasks[1], content: 'blocked', expectedBindingVersion: 1, idempotencyKey: 'blocked' }), e => e.code === 'schema_invalid' && e.detail === (damage === 'missing' ? 'attempt_input_unbound' : 'attempt_input_invalid'))
    assert.equal(fingerprint(), before)
    checks++
  } finally { k.db.close(); rmSync(root, { recursive: true, force: true }) }
}
console.log(JSON.stringify({ checks, passed: checks, scope: 'temporary SQLite, fake service; explicit binding version' }))
