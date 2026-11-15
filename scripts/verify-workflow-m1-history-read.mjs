import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../src/workflow/m1-fake-service.mjs'
const step = nodeId => ({ nodeId, nodeKind: 'automatic', requiredChecks: [], publishTargets: [] })
const root = mkdtempSync(join(tmpdir(), 'm1-history-read-'))
const k = createWorkflowKernel(new DatabaseSync(join(root, 'db.sqlite')), root)
let checks = 0
// 每条反例都带标签，变异验证时能直接看出坏在哪个断言上。
const reject = (fn, code, detail, label) => assert.throws(fn, e => e.code === code && e.detail === detail, label)
try {
  const s = createFakeBusinessService({ kernel: k })
  s.registerPrincipal({ id: 'ui', kind: 'ui', productId: 'p' })
  s.registerPrincipal({ id: 'foreign', kind: 'ui', productId: 'other' })
  k.createRun({ id: 'r', steps: [step('fake.transform')] }); s.host.registerRunProduct('r', 'p')
  const a = k.claim('r')
  k.adopt({ ...a, candidate: k.storeCandidate({ ...a, content: 'verified content' }) })
  const snapshotId = `${a.attemptId}:snapshot`
  const read = () => s.readArtifact({ principal: 'ui', runId: 'r', snapshotId })
  const fingerprint = () => JSON.stringify(k.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%' ORDER BY name").map(({name}) => k.query(`SELECT * FROM ${name} ORDER BY rowid`)))
  const tree = () => JSON.stringify({ objects: readdirSync(join(root, 'objects'), { recursive: true }).sort(), manifests: readdirSync(join(root, 'manifests')).sort().map(name => [name, readFileSync(join(root, 'manifests', name), 'utf8').length]) })
  const manifestDir = join(root, 'manifests')
  const matches = readdirSync(manifestDir).filter(name => JSON.parse(readFileSync(join(manifestDir, name), 'utf8')).snapshotId === snapshotId)
  assert.equal(matches.length, 1)
  const manifestPath = join(manifestDir, matches[0])
  const original = readFileSync(manifestPath, 'utf8')
  const before = fingerprint()
  for (const field of ['artifactType', 'bytes']) {
    const bad = JSON.parse(original)
    bad[field] = field === 'artifactType' ? 'markdown' : bad.bytes + 5
    const bytes = JSON.stringify(bad)
    writeFileSync(manifestPath, bytes)
    assert.throws(read, e => e.code === 'artifact_missing' && e.detail === 'snapshot_manifest_mismatch')
    for (const runId of ['r', 'missing-run']) {
      assert.throws(() => s.readArtifact({ principal: 'foreign', runId, snapshotId }), e => e.code === 'artifact_missing' && e.detail === 'run_not_found')
    }
    assert.equal(readFileSync(manifestPath, 'utf8'), bytes)
    assert.equal(fingerprint(), before)
    checks++
    writeFileSync(manifestPath, original)
  }
  assert.deepEqual(read().artifact, k.readSnapshot(snapshotId)); checks++
  assert.equal(fingerprint(), before)
  assert.deepEqual(s.readAttemptInput({ principal: 'ui', runId: 'r', attemptId: a.attemptId }).binding, k.inputBindingFor(a.attemptId))
  assert.deepEqual(s.readAttemptInput({ principal: 'ui', runId: 'r', attemptId: a.attemptId }).binding.inputs, [])
  const chain = s.listAdoptions({ principal: 'ui', runId: 'r' }).adoptions
  assert.equal(chain.length, 1)
  assert.equal(chain[0].snapshotId, snapshotId)
  assert.equal(chain[0].previousId, null)
  for (const runId of ['r', 'missing-run']) {
    for (const fn of [() => s.listAdoptions({ principal: 'foreign', runId }), () => s.readAttemptInput({ principal: 'foreign', runId, attemptId: a.attemptId })]) {
      assert.throws(fn, e => e.code === 'artifact_missing' && e.detail === 'run_not_found')
    }
  }
  assert.throws(() => s.readAttemptInput({ principal: 'ui', runId: 'r', attemptId: 'missing' }), e => e.code === 'artifact_missing' && e.detail === 'attempt_not_in_run')
  assert.equal(fingerprint(), before)
  checks++

  // --- 多步夹具：重跑、历史非空绑定、多次采用链 ---
  const revisions = (runId) => ({
    run: k.one('SELECT revision FROM workflow_runs WHERE id=?', runId).revision,
    step: (stepId) => k.one('SELECT revision FROM workflow_steps WHERE id=?', stepId).revision,
  })
  const auto = (runId, content) => {
    const claimed = k.claim(runId)
    const stepId = k.one('SELECT step_id FROM workflow_attempts WHERE id=?', claimed.attemptId).step_id
    const adoption = k.adopt({ ...claimed, candidate: k.storeCandidate({ ...claimed, content }), expectedStepRevision: revisions(runId).step(stepId) })
    return { attemptId: claimed.attemptId, stepId, adoptionId: adoption.adoptionId, snapshotId: adoption.snapshotId }
  }

  // 历史非空绑定：第 3 步冻结输入指向第 2 步采用，重跑第 2 步后逐字节不变
  k.createRun({ id: 'h1', steps: ['n1', 'n2', 'n3', 'n4'].map(step) })
  s.host.registerRunProduct('h1', 'p')
  auto('h1', 'one'); auto('h1', 'two')
  const third = auto('h1', 'three')
  const thirdBinding = JSON.stringify(s.readAttemptInput({ principal: 'ui', runId: 'h1', attemptId: third.attemptId }).binding)
  assert.equal(JSON.parse(thirdBinding).inputs.length, 1)
  assert.equal(JSON.parse(thirdBinding).inputs[0].stepId, third.stepId.replace(/:step:3$/, ':step:2'))
  k.pauseRun('h1')
  k.rerunStep({ stepId: 'h1:step:2', expectedRunRevision: revisions('h1').run, expectedStepRevision: revisions('h1').step('h1:step:2') })
  k.resume('h1')
  const afterSecond = auto('h1', 'two-again')
  assert.equal(JSON.stringify(s.readAttemptInput({ principal: 'ui', runId: 'h1', attemptId: third.attemptId }).binding), thirdBinding)
  assert.equal(k.one('SELECT stale FROM workflow_steps WHERE id=?', 'h1:step:3').stale, 1)
  checks++

  // 多次采用链：同一步第二采用 previous_id 指向同一步上一采用，链只连本步
  const chainH1 = s.listAdoptions({ principal: 'ui', runId: 'h1' }).adoptions
  const step2 = chainH1.filter(x => x.stepId === 'h1:step:2')
  assert.equal(step2.length, 2)
  assert.equal(step2[1].previousId, step2[0].adoptionId)
  assert.ok(chainH1.every(x => x.previousId === null || x.previousId.startsWith(`${x.stepId}:`)))
  assert.ok(chainH1.every(x => Object.keys(x).join(',') === 'adoptionId,stepId,snapshotId,previousId,actorType,reason,createdAt'))
  checks++

  // 顺序语义：按步骤优先序（step rowid + adoption rowid），不是时间序
  const ordered = s.listAdoptions({ principal: 'ui', runId: 'h1' }).adoptions
  assert.deepEqual(ordered.map(x => x.stepId), [...ordered.map(x => x.stepId)].sort((l, r) => Number(l.split(':').pop()) - Number(r.split(':').pop())))
  const byStep = ordered.filter(x => x.stepId === 'h1:step:2').map(x => x.adoptionId)
  assert.deepEqual(byStep, [step2[0].adoptionId, step2[1].adoptionId])
  assert.equal(byStep[1], afterSecond.adoptionId)
  checks++

  // 同产品跨 run 的 attempt 不可读；本 run 可读
  k.createRun({ id: 'h2', steps: [step('fake.transform')] }); s.host.registerRunProduct('h2', 'p')
  const foreignAttempt = k.claim('h2')
  k.adopt({ ...foreignAttempt, candidate: k.storeCandidate({ ...foreignAttempt, content: 'other run' }) })
  reject(() => s.readAttemptInput({ principal: 'ui', runId: 'h1', attemptId: foreignAttempt.attemptId }), 'artifact_missing', 'attempt_not_in_run', 'cross-run attempt is not readable')
  assert.equal(s.readAttemptInput({ principal: 'ui', runId: 'h2', attemptId: foreignAttempt.attemptId }).binding.version, 1)
  checks++

  // 角色与凭据边界：未注册、窗口授权、http 凭据、跨产品、受限代理
  k.createRun({ id: 'h3', steps: ['n1', 'n2'].map(step) }); s.host.registerRunProduct('h3', 'p')
  const h3 = auto('h3', 'auth')
  s.registerPrincipal({ id: 'ui2', kind: 'ui', productId: 'p' })
  s.registerPrincipal({ id: 'agentOk', kind: 'node-agent', runIds: ['h3'] })
  s.registerPrincipal({ id: 'agentNo', kind: 'node-agent', runIds: ['h2'] })
  s.registerPrincipal({ id: 'http', kind: 'http-client', credential: 'sess-1', productId: 'p' })
  s.registerPrincipal({ id: 'httpForeign', kind: 'http-client', credential: 'sess-2', productId: 'other' })
  s.registerPrincipal({ id: 'otherAgent', kind: 'other-agent', productId: 'p' })
  reject(() => s.listAdoptions({ principal: 'ghost', runId: 'h3' }), 'capability_unavailable', 'unknown_principal', 'unregistered principal')
  reject(() => s.listAdoptions({ principal: 'foreign', runId: 'h3' }), 'artifact_missing', 'run_not_found', 'cross-product listAdoptions')
  reject(() => s.readAttemptInput({ principal: 'foreign', runId: 'h3', attemptId: h3.attemptId }), 'artifact_missing', 'run_not_found', 'cross-product readAttemptInput')
  assert.equal(s.listAdoptions({ principal: 'ui2', runId: 'h3' }).adoptions.length, 1)
  assert.equal(s.readAttemptInput({ principal: 'agentOk', runId: 'h3', attemptId: h3.attemptId }).binding.version, 1)
  reject(() => s.listAdoptions({ principal: 'agentNo', runId: 'h3' }), 'capability_unavailable', 'run_not_authorized', 'agent without run grant')
  reject(() => s.readAttemptInput({ principal: 'http', runId: 'h3', attemptId: h3.attemptId }), 'capability_unavailable', 'credential_required', 'http client without credential')
  assert.equal(s.readAttemptInput({ principal: 'http', runId: 'h3', attemptId: h3.attemptId, credential: 'sess-1' }).binding.version, 1)
  reject(() => s.readAttemptInput({ principal: 'httpForeign', runId: 'h3', attemptId: h3.attemptId, credential: 'sess-2' }), 'artifact_missing', 'run_not_found', 'cross-product http credential')
  reject(() => s.readAttemptInput({ principal: 'http', runId: 'h3', attemptId: h3.attemptId, credential: 'sess-2' }), 'capability_unavailable', 'credential_required', 'wrong http credential value')
  // other-agent 可读运行元数据与采用链，但不可读冻结输入（权限矩阵按 capability 区分）
  assert.equal(s.listAdoptions({ principal: 'otherAgent', runId: 'h3' }).adoptions.length, 1)
  reject(() => s.readAttemptInput({ principal: 'otherAgent', runId: 'h3', attemptId: h3.attemptId }), 'capability_unavailable', 'other-agent_may_not_read.artifact', 'other-agent cannot read frozen input')
  reject(() => s.readAttemptInput({ principal: 'ui', runId: 'h3', attemptId: '' }), 'artifact_missing', 'attempt_not_in_run', 'empty attemptId')
  checks++

  // 缺绑定与坏绑定：冻结错误映射稳定，且不污染同 run 其他读取
  const keep = k.one('SELECT * FROM workflow_input_bindings WHERE owner_id=?', h3.attemptId)
  k.db.prepare('DELETE FROM workflow_input_bindings WHERE owner_id=?').run(h3.attemptId)
  reject(() => s.readAttemptInput({ principal: 'ui', runId: 'h3', attemptId: h3.attemptId }), 'artifact_missing', 'attempt_input_unbound', 'missing binding row')
  assert.equal(s.listAdoptions({ principal: 'ui', runId: 'h3' }).adoptions.length, 1)
  k.db.prepare('INSERT INTO workflow_input_bindings VALUES(?,?,?,?,?)').run(keep.owner_id, keep.version, keep.binding_json, keep.frozen_at, 'bad')
  reject(() => s.readAttemptInput({ principal: 'ui', runId: 'h3', attemptId: h3.attemptId }), 'artifact_missing', 'attempt_input_invalid', 'broken integrity')
  k.db.prepare('UPDATE workflow_input_bindings SET integrity_hash=? WHERE owner_id=?').run(keep.integrity_hash, h3.attemptId)
  assert.equal(s.readAttemptInput({ principal: 'ui', runId: 'h3', attemptId: h3.attemptId }).binding.version, 1)
  checks++

  // 伪造冻结输入：指向下游采用或 stepId 撒谎都会被拒
  const source = k.one('SELECT a.id, a.snapshot_id, s.content_hash FROM workflow_adoptions a JOIN workflow_snapshots s ON s.id=a.snapshot_id WHERE a.step_id=?', 'h1:step:3')
  const forged = [{ stepId: 'h1:step:3', adoptionId: source.id, snapshotId: source.snapshot_id, contentHash: source.content_hash }]
  const put = inputs => k.db.prepare('UPDATE workflow_input_bindings SET binding_json=?, integrity_hash=? WHERE owner_id=?').run(JSON.stringify(inputs), k.hash({ ownerId: third.attemptId, version: 1, inputs }), third.attemptId)
  put(forged)
  reject(() => s.readAttemptInput({ principal: 'ui', runId: 'h1', attemptId: third.attemptId }), 'artifact_missing', 'attempt_input_invalid', 'forged input pointing at downstream adoption')
  put([{ ...forged[0], stepId: 'h1:step:1' }])
  reject(() => s.readAttemptInput({ principal: 'ui', runId: 'h1', attemptId: third.attemptId }), 'artifact_missing', 'attempt_input_invalid', 'forged input with lying stepId')
  put(JSON.parse(thirdBinding).inputs)
  assert.equal(JSON.stringify(s.readAttemptInput({ principal: 'ui', runId: 'h1', attemptId: third.attemptId }).binding), thirdBinding)
  checks++

  // 对象缺失：冻结绑定仍可读，内容读取必须拒绝
  const lost = JSON.parse(thirdBinding).inputs[0]
  const objectPath = join(root, 'objects', lost.contentHash.slice(0, 2), lost.contentHash)
  assert.ok(existsSync(objectPath))
  renameSync(objectPath, `${objectPath}.bak`)
  try {
    assert.equal(s.readAttemptInput({ principal: 'ui', runId: 'h1', attemptId: third.attemptId }).binding.version, 1)
    reject(() => s.readArtifact({ principal: 'ui', runId: 'h1', snapshotId: lost.snapshotId }), 'artifact_missing', 'object_not_on_disk', 'content read when object file is gone')
    assert.equal(s.listAdoptions({ principal: 'ui', runId: 'h1' }).adoptions.length, ordered.length)
  } finally { renameSync(`${objectPath}.bak`, objectPath) }
  checks++

  // 已终结 run 的历史读取不另设门；空 run 返回空链
  k.createRun({ id: 'h4' }); s.host.registerRunProduct('h4', 'p')
  assert.deepEqual(s.listAdoptions({ principal: 'ui', runId: 'h4' }).adoptions, [])
  k.cancelRun('h3')
  assert.equal(k.one('SELECT status FROM workflow_runs WHERE id=?', 'h3').status, 'cancelled')
  assert.equal(s.readAttemptInput({ principal: 'ui', runId: 'h3', attemptId: h3.attemptId }).binding.version, 1)
  assert.equal(s.listAdoptions({ principal: 'ui', runId: 'h3' }).adoptions.length, 1)
  checks++

  // 只读性：连续两轮历史读取不改变十一表与 objects/manifests
  const pass = () => {
    s.listAdoptions({ principal: 'ui', runId: 'h1' })
    s.readAttemptInput({ principal: 'ui', runId: 'h1', attemptId: third.attemptId })
    s.readArtifact({ principal: 'ui', runId: 'r', snapshotId })
    s.listAdoptions({ principal: 'ui', runId: 'h3' })
  }
  pass()
  const snapBefore = fingerprint(); const treeBefore = tree()
  pass()
  assert.equal(fingerprint(), snapBefore)
  assert.equal(tree(), treeBefore)
  checks++
  console.log(JSON.stringify({ checks, passed: checks, scope: 'temporary SQLite fake service historical reads' }))
} finally { k.db.close(); rmSync(root, { recursive: true, force: true }) }
