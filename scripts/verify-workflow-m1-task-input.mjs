import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../src/workflow/m1-fake-service.mjs'
const step = (nodeId, nodeKind = 'automatic') => ({ nodeId, nodeKind, requiredChecks: [], publishTargets: [] })
const root = mkdtempSync(join(tmpdir(), 'task-input-'))
const k = createWorkflowKernel(new DatabaseSync(join(root, 'db')), root)
let checks = 0
try {
  const s = createFakeBusinessService({ kernel: k })
  s.registerPrincipal({ id: 'ui', kind: 'ui', productId: 'p' })
  s.registerPrincipal({ id: 'foreign', kind: 'ui', productId: 'q' })
  k.createRun({ id: 'r', steps: [step('a'), step('b', 'human'), step('c')] })
  s.host.registerRunProduct('r', 'p')
  const auto = text => { const a = k.claim('r'); k.adopt({ ...a, candidate: k.storeCandidate({ ...a, content: text }) }) }
  auto('v1'); const taskId = k.claim('r').taskId
  const read = (extra = {}) => s.readTaskInput({ principal: 'ui', runId: 'r', taskId, ...extra }).taskInput
  const fp = () => JSON.stringify(k.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%' ORDER BY name").map(({ name }) => k.query(`SELECT * FROM ${name} ORDER BY rowid`)))
  const reject = (fn, code, detail, label) => { const before = fp(); assert.throws(fn, e => e.code === code && e.detail === detail, label); assert.equal(fp(), before, label); checks++ }
  const original = read()
  assert.deepEqual(original.inputs, k.inputBindingFor(taskId).inputs)
  assert.equal(original.isCurrent, true)
  assert.equal(k.one('SELECT COUNT(*) AS n FROM workflow_attempts WHERE step_id=?', original.stepId).n, 0); checks++
  for (const version of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) reject(() => read({ version }), 'schema_invalid', 'input_binding_version_invalid', `version ${version} is rejected before any binding lookup`)
  reject(() => read({ version: 999 }), 'artifact_missing', 'attempt_input_unbound', 'version above the frozen range')
  reject(() => read({ taskId: 'missing' }), 'artifact_missing', 'task_not_in_run', 'unknown task in the same run')
  for (const runId of ['r', 'missing']) reject(() => read({ principal: 'foreign', runId }), 'artifact_missing', 'run_not_found', 'cross-product read never confirms a run exists')
  k.pauseRun('r')
  k.rerunStep({ stepId: 'r:step:1', expectedRunRevision: k.one('SELECT revision FROM workflow_runs WHERE id=?', 'r').revision, expectedStepRevision: k.one('SELECT revision FROM workflow_steps WHERE id=?', 'r:step:1').revision })
  assert.equal(read().status, 'stale'); assert.equal(read().isCurrent, true); assert.equal(read().stepStale, true); checks++
  k.resume('r'); auto('v2'); k.claim('r')
  const before = fp()
  const current = read(); const historical = read({ version: original.version })
  assert.ok(current.version > original.version); assert.equal(current.isCurrent, true)
  assert.equal(historical.isCurrent, false); assert.deepEqual(historical.inputs, original.inputs)
  assert.equal(historical.currentVersion, current.version); assert.equal(historical.frozenAt, original.frozenAt)
  assert.equal(fp(), before); checks++
  const currentRow = k.one('SELECT * FROM workflow_input_bindings WHERE owner_id=? AND version=?', taskId, current.version)
  k.db.prepare("UPDATE workflow_input_bindings SET integrity_hash='bad' WHERE owner_id=? AND version=?").run(taskId, current.version)
  reject(() => read(), 'artifact_missing', 'attempt_input_invalid', 'corrupted digest stops the current version only')
  assert.deepEqual(read({ version: original.version }).inputs, original.inputs); checks++
  k.db.prepare('UPDATE workflow_input_bindings SET integrity_hash=? WHERE owner_id=? AND version=?').run(currentRow.integrity_hash, taskId, current.version)

  // 同产品跨 run：任务不属于该 run 时必须拒绝，用自己的 runId 才能读到。
  k.createRun({ id: 'r2', steps: [step('x'), step('y', 'human')] })
  s.host.registerRunProduct('r2', 'p')
  const x = k.claim('r2'); k.adopt({ ...x, candidate: k.storeCandidate({ ...x, content: 'other run' }) })
  const taskId2 = k.claim('r2').taskId
  reject(() => read({ taskId: taskId2 }), 'artifact_missing', 'task_not_in_run', 'same-product task of another run is not readable')
  const own = s.readTaskInput({ principal: 'ui', runId: 'r2', taskId: taskId2 }).taskInput
  assert.equal(own.taskId, taskId2); assert.equal(own.version, 1); assert.equal(own.inputs.length, 1); checks++

  // 角色与凭据边界：能力仍是 read.artifact，权限矩阵不变。
  s.registerPrincipal({ id: 'agentOk', kind: 'node-agent', runIds: ['r'] })
  s.registerPrincipal({ id: 'agentNo', kind: 'node-agent', runIds: ['zzz'] })
  s.registerPrincipal({ id: 'other', kind: 'other-agent', productId: 'p' })
  s.registerPrincipal({ id: 'http', kind: 'http-client', credential: 'c1', productId: 'p' })
  reject(() => read({ principal: 'ghost' }), 'capability_unavailable', 'unknown_principal', 'unregistered principal')
  reject(() => read({ principal: 'agentNo' }), 'capability_unavailable', 'run_not_authorized', 'agent without a grant for this run')
  assert.deepEqual(read({ principal: 'agentOk' }).inputs, current.inputs); checks++
  reject(() => read({ principal: 'other' }), 'capability_unavailable', 'other-agent_may_not_read.artifact', 'other-agent may never read artifact content')
  reject(() => read({ principal: 'http' }), 'capability_unavailable', 'credential_required', 'http client without a credential')
  reject(() => read({ principal: 'http', credential: 'wrong' }), 'capability_unavailable', 'credential_required', 'http client with a foreign credential value')
  assert.equal(read({ principal: 'http', credential: 'c1' }).taskId, taskId); checks++

  // 自洽的跨 run 伪造绑定（摘要按伪造内容重算）不能被当成合法输入。
  const foreignAdoption = k.one('SELECT a.id, a.snapshot_id, s.content_hash FROM workflow_adoptions a JOIN workflow_snapshots s ON s.id=a.snapshot_id WHERE a.step_id=?', 'r2:step:1')
  const forge = inputs => k.db.prepare('UPDATE workflow_input_bindings SET binding_json=?, integrity_hash=? WHERE owner_id=? AND version=?')
    .run(JSON.stringify(inputs), k.hash({ ownerId: taskId, version: current.version, inputs }), taskId, current.version)
  forge([{ stepId: 'r2:step:1', adoptionId: foreignAdoption.id, snapshotId: foreignAdoption.snapshot_id, contentHash: foreignAdoption.content_hash }])
  reject(() => read(), 'artifact_missing', 'attempt_input_invalid', 'self-consistent cross-run binding is rejected')
  forge([{ stepId: current.stepId, adoptionId: foreignAdoption.id, snapshotId: foreignAdoption.snapshot_id, contentHash: foreignAdoption.content_hash }])
  reject(() => read(), 'artifact_missing', 'attempt_input_invalid', 'cross-run adoption behind a truthful-looking stepId is rejected')
  k.db.prepare('UPDATE workflow_input_bindings SET binding_json=?, integrity_hash=? WHERE owner_id=? AND version=?').run(currentRow.binding_json, currentRow.integrity_hash, taskId, current.version)
  assert.deepEqual(read().inputs, current.inputs); checks++

  // 对象缺失：冻结绑定仍可读，内容读取必须拒绝；还原后两者都正常。
  const lost = current.inputs[0]
  const objectPath = join(root, 'objects', lost.contentHash.slice(0, 2), lost.contentHash)
  assert.ok(existsSync(objectPath))
  renameSync(objectPath, `${objectPath}.bak`)
  try {
    assert.deepEqual(read().inputs, current.inputs)
    assert.throws(() => s.readArtifact({ principal: 'ui', runId: 'r', snapshotId: lost.snapshotId }), e => e.code === 'artifact_missing' && e.detail === 'object_not_on_disk', 'content read must fail when the object file is gone')
    checks++
  } finally { renameSync(`${objectPath}.bak`, objectPath) }
  assert.equal(s.readArtifact({ principal: 'ui', runId: 'r', snapshotId: lost.snapshotId }).artifact.snapshotId, lost.snapshotId); checks++

  // 已确认待办：绑定与它生成的 human attempt 输入逐字节一致，证明「当时审的是哪一版」。
  const task = k.one('SELECT task_revision FROM workflow_human_tasks WHERE id=?', taskId)
  k.confirmHuman({ taskId, content: 'done', actorId: 'u', expectedTaskRevision: task.task_revision, expectedBindingVersion: current.version, intent: 'continue' })
  const confirmed = read()
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.isCurrent, true); checks++
  const humanAttempt = k.one('SELECT id FROM workflow_attempts WHERE step_id=?', confirmed.stepId).id
  assert.deepEqual(k.inputBindingFor(humanAttempt).inputs, confirmed.inputs)
  assert.deepEqual(confirmed.inputs, current.inputs); checks++

  assert.equal(confirmed.stepStale, false)
  k.pauseRun('r')
  k.rerunStep({ stepId: 'r:step:1', expectedRunRevision: k.one('SELECT revision FROM workflow_runs WHERE id=?', 'r').revision, expectedStepRevision: k.one('SELECT revision FROM workflow_steps WHERE id=?', 'r:step:1').revision })
  const staleBefore = fp()
  const invalidated = read()
  assert.equal(invalidated.status, 'confirmed')
  assert.equal(invalidated.isCurrent, true)
  assert.equal(invalidated.stepStale, true)
  assert.deepEqual(invalidated.inputs, confirmed.inputs)
  assert.equal(fp(), staleBefore); checks++
  console.log(JSON.stringify({ checks, passed: checks, scope: 'temporary SQLite fake task input reads' }))
} finally { k.db.close(); rmSync(root, { recursive: true, force: true }) }
