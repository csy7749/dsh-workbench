import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWorkflowKernel, WorkflowRequiresSqliteError } from '../src/workflow/m1-kernel.mjs'
import { createFakeExecutor } from './fake-workflow-executor.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-workflow-m1-'))
const dbPath = join(root, 'workflow.sqlite')
const kernel = createWorkflowKernel(new DatabaseSync(dbPath), root)
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks++ }
const expectCode = (fn, code) => { assert.throws(fn, error => (error.code ?? error.message) === code); checks++ }
// 冻结声明：节点必须显式声明 requiredChecks（自动步骤 adopt 与人工确认都要求数组）与
// publishTargets（缺省即 publish_declaration_missing）。本脚本只对真正要发布的步骤声明目标。
const auto = (nodeId, target = null, required = true) => ({ nodeId, nodeKind: 'automatic', requiredChecks: [], publishTargets: target ? [{ target, required }] : [] })
const humanStep = (nodeId) => ({ nodeId, nodeKind: 'human', requiredChecks: [], publishTargets: [] })

// 夹具目标适配器：目标当前版本与正文都由夹具自己持有，adopt 的 baseRevision/baseContentHash
// 与 claim 的 observe 都取自它，绝不回读 workflow_outbox（否则等于拿请求参数和请求参数比）。
// 默认 1 与 adopt 的缺省 baseRevision 一致，所以老用例的采用语义不变。
const fakeTarget = (target, revision = 1) => {
  const state = { target, revision, content: `fixture base of ${target}` }
  const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
  return {
    target,
    get revision() { return state.revision },
    get content() { return state.content },
    get contentHash() { return sha256(state.content) },
    // 模拟目标被外部改写：之后 observe 立即反映新版本（漂移反例用）。
    advanceTo(next) { state.revision = next },
    setContent(next) { state.content = next },
    // 采用参数：基准版本 + 基准正文摘要 + 类别，成对取自夹具。
    baseline() { return { baseRevision: state.revision, baseContentHash: sha256(state.content), targetKind: 'raw_text' } },
    observe: (asked) => ({ target: asked, revision: state.revision, contentHash: sha256(state.content) }),
  }
}

// --- 单步自动流程与 outbox -------------------------------------------------
const automatic = kernel.createRun({ id: 'run-auto', input: { product: 'alpha' }, steps: [auto('fake.transform', 'pd:fixture-product-alpha')] })
ok(automatic.stepCount === 1, 'run reports its step count')
const attempt = kernel.claim(automatic.runId, { product: 'alpha' })
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', automatic.runId).status === 'running', 'automatic run claimed')
ok(kernel.one('SELECT budget_used FROM workflow_runs WHERE id=?', automatic.runId).budget_used === 1, 'claim charges budget')
const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content: 'synthetic output' })
ok(candidate.contentHash === kernel.hash('synthetic output'), 'content hash is stable')
const productAlphaTarget = fakeTarget('pd:fixture-product-alpha')
const adoption = kernel.adopt({ attemptId: attempt.attemptId, token: attempt.token, candidate, target: productAlphaTarget.target, ...productAlphaTarget.baseline() })
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', automatic.runId).status === 'running', 'run waits for the required publish instead of completing')
ok(kernel.one('SELECT status FROM workflow_outbox WHERE adoption_id=?', adoption.adoptionId).status === 'pending', 'publish remains pending in outbox')
ok(kernel.one('SELECT parent_id FROM workflow_snapshots WHERE id=?', adoption.snapshotId).parent_id === null, 'first snapshot has no parent')
expectCode(() => kernel.adopt({ attemptId: 'missing', token: 'bad', candidate: { snapshotId: 'fake', contentHash: 'ffff', manifestHash: 'ffff', content: 'fake' } }), 'attempt_token_invalid')
// 假发布成功后才允许完成（A06）：先领取（基准由夹具观测），再登记结果。
const autoOutbox = kernel.one('SELECT id FROM workflow_outbox WHERE adoption_id=?', adoption.adoptionId).id
expectCode(() => kernel.completeOutbox(autoOutbox, 'succeeded'), 'outbox_not_claimed')
const autoClaim = kernel.claimOutbox(autoOutbox, { observe: productAlphaTarget.observe })
ok(kernel.completeOutbox(autoOutbox, 'succeeded', null, autoClaim.claimGeneration).runStatus === 'completed', 'run completes once the required publish succeeds')
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', automatic.runId).status === 'completed', 'completed status is persisted')
// 可选发布失败不阻断完成，但必须单列（01：可选发布失败不能默认为必需成功）。
const optionalRun = kernel.createRun({ id: 'run-optional', steps: [auto('fake.transform', 'ui:fixture-product-alpha', false)] })
const optionalClaim = kernel.claim(optionalRun.runId)
const optionalCandidate = kernel.storeCandidate({ attemptId: optionalClaim.attemptId, token: optionalClaim.token, content: 'optional publish' })
const optionalAdoption = kernel.adopt({ attemptId: optionalClaim.attemptId, token: optionalClaim.token, candidate: optionalCandidate, target: 'ui:fixture-product-alpha', required: false })
ok(kernel.one('SELECT required FROM workflow_outbox WHERE adoption_id=?', optionalAdoption.adoptionId).required === 0, 'optional publish is marked not required')
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', optionalRun.runId).status === 'completed', 'optional publish does not block completion')
ok(kernel.one('SELECT status FROM workflow_outbox WHERE adoption_id=?', optionalAdoption.adoptionId).status === 'pending', 'optional publish stays listed after completion')

// --- 多步推进 -------------------------------------------------------------
const multi = kernel.createRun({ id: 'run-multi', steps: [auto('one'), auto('two')] })
const first = kernel.claim(multi.runId)
const firstCandidate = kernel.storeCandidate({ attemptId: first.attemptId, token: first.token, content: 'one' })
const firstAdoption = kernel.adopt({ attemptId: first.attemptId, token: first.token, candidate: firstCandidate })
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', multi.runId).status === 'running', 'multi-step run continues')
const second = kernel.claim(multi.runId)
const secondCandidate = kernel.storeCandidate({ attemptId: second.attemptId, token: second.token, content: 'two' })
const secondAdoption = kernel.adopt({ attemptId: second.attemptId, token: second.token, candidate: secondCandidate })
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', multi.runId).status === 'completed', 'multi-step run completes at final step')
ok(kernel.one('SELECT parent_id FROM workflow_snapshots WHERE id=?', secondAdoption.snapshotId).parent_id === firstAdoption.snapshotId, 'step 2 snapshot chains to upstream snapshot')
expectCode(() => kernel.adopt({ attemptId: attempt.attemptId, token: attempt.token, candidate }), 'attempt_token_invalid')
expectCode(() => kernel.claim('run-multi'), 'run_not_claimable')

// --- 线性调度：前面的步骤在途时不得越过它领取后继步骤（CTX-06 无双派发）------
const linear = kernel.createRun({ id: 'run-linear', steps: [auto('one'), auto('two')] })
const linearFirst = kernel.claim(linear.runId)
ok(linearFirst.kind === 'automatic', 'linear run hands out the first step')
expectCode(() => kernel.claim(linear.runId), 'step_not_claimable')
ok(kernel.query('SELECT COUNT(*) AS n FROM workflow_attempts WHERE step_id=?', `${linear.runId}:step:2`)[0].n === 0, 'no attempt is created for the second step while the first is in flight')
const linearCandidate = kernel.storeCandidate({ attemptId: linearFirst.attemptId, token: linearFirst.token, content: 'linear one' })
kernel.adopt({ attemptId: linearFirst.attemptId, token: linearFirst.token, candidate: linearCandidate })
const linearSecond = kernel.claim(linear.runId)
ok(linearSecond.kind === 'automatic', 'the second step becomes claimable only after the first succeeds')
ok(kernel.one('SELECT id FROM workflow_attempts WHERE id=?', linearSecond.attemptId).id === `${linear.runId}:step:2:attempt:1`, 'the second claim binds the second step')

// --- 幂等：同一 idempotencyKey 重放，不同输入冲突 ---------------------------
const replay = kernel.createRun({ id: 'run-idempotent', idempotencyKey: 'same', input: { x: 1 } })
ok(replay.replayed !== true, 'first request is new')
const same = kernel.createRun({ id: 'run-idempotent', idempotencyKey: 'same', input: { x: 1 } })
ok(same.replayed === true, 'same request replays')
expectCode(() => kernel.createRun({ id: 'run-idempotent', idempotencyKey: 'same', input: { x: 2 } }), 'idempotency_conflict')

// --- 人工节点：草稿、指纹、run revision、幂等重放 --------------------------
const human = kernel.createRun({ id: 'run-human', human: true, steps: [humanStep('human.edit-confirm')] })
const task = kernel.claim(human.runId)
ok(task.kind === 'human', 'human node creates task')
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', human.runId).status === 'waiting_review', 'human run waits')
// 绑定版本由夹具从服务端读取（不自行推算），后续确认沿用同一版本。
const draft = kernel.saveDraft({ taskId: task.taskId, content: 'edited draft', expectedBindingVersion: kernel.inputBindingFor(task.taskId).version })
ok(draft.revision === 2, 'draft revision increments')
expectCode(() => kernel.saveDraft({ taskId: task.taskId, content: 'stale draft', expectedTaskRevision: 1, expectedBindingVersion: kernel.inputBindingFor(task.taskId).version }), 'cas_conflict')
const humanRunRevision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', human.runId).revision
const humanInput = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', task.taskId).input_hash
const humanBindingVersion = kernel.inputBindingFor(task.taskId).version
expectCode(() => kernel.confirmHuman({ taskId: task.taskId, content: 'bad', actorId: 'fixture-human', inputFingerprint: 'wrong', expectedRunRevision: humanRunRevision, expectedTaskRevision: 2, expectedBindingVersion: humanBindingVersion }), 'input_fingerprint_conflict')
expectCode(() => kernel.confirmHuman({ taskId: task.taskId, content: 'bad', actorId: 'fixture-human', inputFingerprint: humanInput, expectedRunRevision: humanRunRevision + 99, expectedTaskRevision: 2, expectedBindingVersion: humanBindingVersion }), 'cas_conflict')
expectCode(() => kernel.confirmHuman({ taskId: task.taskId, content: 'bad', inputFingerprint: humanInput, expectedRunRevision: humanRunRevision, expectedTaskRevision: 2, expectedBindingVersion: humanBindingVersion }), 'human_identity_required')
const confirmArgs = { taskId: task.taskId, content: 'edited output', actorId: 'fixture-human', inputFingerprint: humanInput, expectedRunRevision: humanRunRevision, expectedAdoptionId: null, idempotencyKey: 'human-confirm-1', expectedTaskRevision: 2, expectedBindingVersion: humanBindingVersion }
const humanAdoption = kernel.confirmHuman({ ...confirmArgs })
ok(kernel.one('SELECT actor_type FROM workflow_adoptions WHERE id=?', humanAdoption.adoptionId).actor_type === 'human', 'human adoption has human actor')
const snapshotsBeforeReplay = kernel.one('SELECT COUNT(*) AS n FROM workflow_snapshots').n
const replayAdoption = kernel.confirmHuman({ ...confirmArgs })
ok(replayAdoption.adoptionId === humanAdoption.adoptionId, 'same idempotency key replays the original adoption')
ok(replayAdoption.replayed === true, 'replay is flagged')
ok(kernel.one('SELECT COUNT(*) AS n FROM workflow_snapshots').n === snapshotsBeforeReplay, 'replay adds no snapshot')
ok(kernel.one('SELECT confirmed_by FROM workflow_human_tasks WHERE id=?', task.taskId).confirmed_by === 'fixture-human', 'confirmation records the actor')

// --- 未知结果对账 + 恢复 ---------------------------------------------------
const unknownRun = kernel.createRun({ id: 'run-unknown', steps: [auto('fake.transform')] })
const unknownAttempt = kernel.claim(unknownRun.runId)
kernel.markUnknown(unknownAttempt.attemptId)
ok(kernel.one('SELECT pause_reason FROM workflow_runs WHERE id=?', unknownRun.runId).pause_reason === 'outcome_unknown', 'unknown outcome pauses run')
ok(kernel.reconcileUnknown(unknownAttempt.attemptId, 'not_executed') === 'not_executed', 'unknown outcome reconciles')
ok(kernel.resume(unknownRun.runId).runId === unknownRun.runId, 'reconciled run can resume')
const resumedAttempt = kernel.claim(unknownRun.runId)
ok(kernel.one('SELECT attempt_no FROM workflow_attempts WHERE id=?', resumedAttempt.attemptId).attempt_no === 2, 'resumed run claims a fresh attempt')
expectCode(() => kernel.reconcileUnknown(unknownAttempt.attemptId, 'not_executed'), 'unknown_not_reconcilable')

// --- outbox 生命周期：必需发布四种边界 -------------------------------------
// 1) pending 不算完成（上面 run-auto 已覆盖）；2) 失败/冲突 → 暂停；
const publishRun = kernel.createRun({ id: 'run-publish', steps: [auto('a', 'pd:fixture-product-beta')] })
const publishClaim = kernel.claim(publishRun.runId)
const publishCandidate = kernel.storeCandidate({ attemptId: publishClaim.attemptId, token: publishClaim.token, content: 'publish me' })
const productBetaTarget = fakeTarget('pd:fixture-product-beta')
const publishAdoption = kernel.adopt({ attemptId: publishClaim.attemptId, token: publishClaim.token, candidate: publishCandidate, target: productBetaTarget.target, ...productBetaTarget.baseline() })
const publishId = `${publishAdoption.adoptionId}:publish`
// 领取通过只保证"领取前"基准正确；写入阶段仍可能被写入方判失败，所以结算侧四种结果
// 照旧单独覆盖。显式领取，不包自动领取辅助函数。
const failedClaim = kernel.claimOutbox(publishId, { observe: productBetaTarget.observe })
const failedPublish = kernel.completeOutbox(publishId, 'failed', 'fixture offset rejected', failedClaim.claimGeneration)
ok(failedPublish.status === 'failed', 'outbox records a failed publish')
ok(failedPublish.runStatus === 'paused', 'required publish failure pauses the run')
ok(kernel.one('SELECT pause_reason FROM workflow_runs WHERE id=?', publishRun.runId).pause_reason === 'publish_failed', 'pause reason names the publish failure')
expectCode(() => kernel.resume(publishRun.runId), 'publish_unresolved')
ok(kernel.retryOutbox(publishId) === 'pending', 'failed publish can be retried')
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', publishRun.runId).status === 'paused', 'run stays paused until it is resumed explicitly')
ok(kernel.resume(publishRun.runId).status === 'running', 'resume after a retried publish returns to running')
const retriedClaim = kernel.claimOutbox(publishId, { observe: productBetaTarget.observe })
ok(kernel.completeOutbox(publishId, 'succeeded', null, retriedClaim.claimGeneration).runStatus === 'completed', 'run completes after the retried publish succeeds')
expectCode(() => kernel.completeOutbox(publishId, 'succeeded', null, retriedClaim.claimGeneration), 'cas_conflict')
expectCode(() => kernel.completeOutbox('missing-outbox'), 'outbox_not_found')
// 已结算的发布不得重试。终态用 run_not_claimable（与 claim 的既有码一致），且必须不改状态。
expectCode(() => kernel.retryOutbox(publishId), 'run_not_claimable')
ok(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', publishId).status === 'succeeded', 'a rejected retry leaves the settled publish untouched')

// 3) 冲突 → 暂停（A11/A36：必需发布冲突不记成功）
const conflictRun = kernel.createRun({ id: 'run-conflict', steps: [auto('a', 'pd:fixture-product-alpha')] })
const conflictClaim = kernel.claim(conflictRun.runId)
const conflictCandidate = kernel.storeCandidate({ attemptId: conflictClaim.attemptId, token: conflictClaim.token, content: 'conflict content' })
const conflictAdoption = kernel.adopt({ attemptId: conflictClaim.attemptId, token: conflictClaim.token, candidate: conflictCandidate, target: productAlphaTarget.target, ...productAlphaTarget.baseline() })
const conflictId = `${conflictAdoption.adoptionId}:publish`
const conflictPublishClaim = kernel.claimOutbox(conflictId, { observe: productAlphaTarget.observe })
ok(kernel.completeOutbox(conflictId, 'conflict', 'base revision changed', conflictPublishClaim.claimGeneration).runStatus === 'paused', 'publish conflict pauses the run')
ok(kernel.one('SELECT pause_reason FROM workflow_runs WHERE id=?', conflictRun.runId).pause_reason === 'publish_conflict', 'conflict pause reason is structured')
expectCode(() => kernel.resume(conflictRun.runId), 'publish_unresolved')
ok(kernel.retryOutbox(conflictId) === 'pending', 'conflict can be retried against a fresh baseline')
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', conflictRun.runId).status === 'paused', 'retrying keeps the run paused')

// 4) 结果未知 → 先对账，不允许直接重试
const unknownPublishRun = kernel.createRun({ id: 'run-publish-unknown', steps: [auto('a', 'md:fixture-module-books')] })
const unknownPublishClaim = kernel.claim(unknownPublishRun.runId)
const unknownPublishCandidate = kernel.storeCandidate({ attemptId: unknownPublishClaim.attemptId, token: unknownPublishClaim.token, content: 'unknown content' })
const moduleBooksTarget = fakeTarget('md:fixture-module-books')
const unknownPublishAdoption = kernel.adopt({ attemptId: unknownPublishClaim.attemptId, token: unknownPublishClaim.token, candidate: unknownPublishCandidate, target: moduleBooksTarget.target, ...moduleBooksTarget.baseline() })
const unknownPublishId = `${unknownPublishAdoption.adoptionId}:publish`
const unknownClaim = kernel.claimOutbox(unknownPublishId, { observe: moduleBooksTarget.observe })
ok(kernel.completeOutbox(unknownPublishId, 'outcome_unknown', null, unknownClaim.claimGeneration).runStatus === 'paused', 'unknown publish outcome pauses the run')
ok(kernel.one('SELECT pause_reason FROM workflow_runs WHERE id=?', unknownPublishRun.runId).pause_reason === 'publish_outcome_unknown', 'unknown pause reason is structured')
expectCode(() => kernel.retryOutbox(unknownPublishId), 'outbox_requires_reconcile')
// 对账必须带真实观测：目标此刻已是这条发布的预期正文，才允许记成功。
const unknownReconciled = kernel.reconcilePublishEffect(unknownPublishId, {
  actorId: 'fixture-reconciler',
  claimGeneration: unknownClaim.claimGeneration,
  observe: (asked) => ({ target: asked, revision: moduleBooksTarget.revision + 1, contentHash: kernel.hash('unknown content') }),
})
ok(unknownReconciled.decision === 'applied', `observing the expected content reconciles as applied, got ${unknownReconciled.decision}`)
ok(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', unknownPublishId).status === 'succeeded', 'reconciled publish is recorded as succeeded')
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', unknownPublishRun.runId).status === 'paused', 'reconciled publish keeps the run paused until resume')
ok(kernel.resume(unknownPublishRun.runId).status === 'completed', 'resume converges an all-adopted run to completed')

// --- 显式继续门：暂停/等待不能被 claim 绕过（A36） --------------------------
const gateRun = kernel.createRun({ id: 'run-gate', steps: [auto('a', 'pd:fixture-gate'), auto('b')] })
const gateClaim = kernel.claim(gateRun.runId)
const gateCandidate = kernel.storeCandidate({ attemptId: gateClaim.attemptId, token: gateClaim.token, content: 'gate one' })
const gateTarget = fakeTarget('pd:fixture-gate')
const gateAdoption = kernel.adopt({ attemptId: gateClaim.attemptId, token: gateClaim.token, candidate: gateCandidate, target: gateTarget.target, ...gateTarget.baseline() })
const gateOutboxId = `${gateAdoption.adoptionId}:publish`
const gatePublishClaim = kernel.claimOutbox(gateOutboxId, { observe: gateTarget.observe })
kernel.completeOutbox(gateOutboxId, 'failed', 'fixture writer rejected', gatePublishClaim.claimGeneration)
expectCode(() => kernel.claim(gateRun.runId), 'run_paused')
ok(kernel.one('SELECT pause_reason FROM workflow_runs WHERE id=?', gateRun.runId).pause_reason === 'publish_failed', 'claim did not clear the pause reason')
ok(kernel.one('SELECT state FROM workflow_steps WHERE id=?', 'run-gate:step:2').state === 'pending', 'blocked claim did not advance the next step')
expectCode(() => kernel.resume(gateRun.runId), 'publish_unresolved')
kernel.retryOutbox(gateOutboxId)
const gateRetryPublishClaim = kernel.claimOutbox(gateOutboxId, { observe: gateTarget.observe })
kernel.completeOutbox(gateOutboxId, 'succeeded', null, gateRetryPublishClaim.claimGeneration)
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', gateRun.runId).status === 'paused', 'run keeps waiting for an explicit resume after the block is resolved')
expectCode(() => kernel.claim(gateRun.runId), 'run_paused')
ok(kernel.resume(gateRun.runId).status === 'running', 'explicit resume returns the run to running')
const gateNext = kernel.claim(gateRun.runId)
ok(gateNext.kind === 'automatic', 'the next step is claimable after the explicit resume')
const gateNextCandidate = kernel.storeCandidate({ attemptId: gateNext.attemptId, token: gateNext.token, content: 'gate two' })
kernel.adopt({ attemptId: gateNext.attemptId, token: gateNext.token, candidate: gateNextCandidate })
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', gateRun.runId).status === 'completed', 'run completes after the explicit resume')

// Attempt 失败同样需要显式继续才能重领。
const failRun = kernel.createRun({ id: 'run-fail', steps: [auto('fake.transform')] })
const failClaim = kernel.claim(failRun.runId)
kernel.markFailed(failClaim.attemptId, 'fake_executor_failed')
expectCode(() => kernel.claim(failRun.runId), 'run_paused')
kernel.resume(failRun.runId)
ok(kernel.claim(failRun.runId).attemptId === 'run-fail:step:1:attempt:2', 'resume after a failure starts attempt 2')

// 人工等待期间不能越过待办领取后续步骤。
const waitRun = kernel.createRun({ id: 'run-wait', steps: [humanStep('human.edit-confirm'), auto('b')] })
const waitTask = kernel.claim(waitRun.runId)
expectCode(() => kernel.claim(waitRun.runId), 'run_waiting_review')
ok(kernel.one('SELECT state FROM workflow_steps WHERE id=?', 'run-wait:step:2').state === 'pending', 'step 2 was claimed before the human confirmed')
const waitInput = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', waitTask.taskId).input_hash
const waitRunRevision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', waitRun.runId).revision
kernel.confirmHuman({ taskId: waitTask.taskId, content: 'confirmed', actorId: 'fixture-human', inputFingerprint: waitInput, expectedRunRevision: waitRunRevision, expectedTaskRevision: 1, idempotencyKey: 'wait-confirm', expectedBindingVersion: kernel.inputBindingFor(waitTask.taskId).version })
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', waitRun.runId).status === 'running', 'confirmation returns the run to running')
ok(kernel.claim(waitRun.runId).kind === 'automatic', 'step 2 is claimable after the confirmation')

// --- 租约、取消、预算 -----------------------------------------------------
const leaseRun = kernel.createRun({ id: 'run-lease', steps: [auto('fake.transform')] })
const leaseClaim = kernel.claim(leaseRun.runId)
kernel.query('UPDATE workflow_attempts SET lease_until=? WHERE id=?', '2000-01-01T00:00:00.000Z', leaseClaim.attemptId)
const leaseCandidate = kernel.storeCandidate({ attemptId: leaseClaim.attemptId, token: leaseClaim.token, content: 'late' })
expectCode(() => kernel.adopt({ attemptId: leaseClaim.attemptId, token: leaseClaim.token, candidate: leaseCandidate }), 'lease_expired')
const reclaimed = kernel.claim(leaseRun.runId)
ok(reclaimed.attemptId !== leaseClaim.attemptId, 'expired attempt is replaced by a fresh one')

const cancelRun = kernel.createRun({ id: 'run-cancel', steps: [auto('a'), auto('b')] })
const cancelClaim = kernel.claim(cancelRun.runId)
kernel.cancelRun(cancelRun.runId)
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', cancelRun.runId).status === 'cancelled', 'run is cancelled')
ok(kernel.one('SELECT status FROM workflow_attempts WHERE id=?', cancelClaim.attemptId).status === 'cancelled', 'running attempt is cancelled')
expectCode(() => kernel.claim(cancelRun.runId), 'run_not_claimable')
expectCode(() => kernel.cancelRun(cancelRun.runId), 'run_not_cancellable')

const budgetRun = kernel.createRun({ id: 'run-budget', steps: [auto('a')] })
kernel.query('UPDATE workflow_runs SET budget_total=1 WHERE id=?', budgetRun.runId)
kernel.claim(budgetRun.runId)
kernel.query("UPDATE workflow_steps SET state='paused' WHERE id=?", 'run-budget:step:1')
expectCode(() => kernel.claim(budgetRun.runId), 'budget_exhausted')

// --- stale 传播 -----------------------------------------------------------
const staleRun = kernel.createRun({ id: 'run-stale', steps: [auto('a'), auto('b'), auto('c')] })
const upstream = kernel.claim(staleRun.runId)
const upstreamCandidate = kernel.storeCandidate({ attemptId: upstream.attemptId, token: upstream.token, content: 'upstream v1' })
kernel.adopt({ attemptId: upstream.attemptId, token: upstream.token, candidate: upstreamCandidate })
const downstream = kernel.claim(staleRun.runId)
const downstreamCandidate = kernel.storeCandidate({ attemptId: downstream.attemptId, token: downstream.token, content: 'downstream v1' })
kernel.adopt({ attemptId: downstream.attemptId, token: downstream.token, candidate: downstreamCandidate })
kernel.query("UPDATE workflow_steps SET state='paused' WHERE id=?", 'run-stale:step:1')
const rework = kernel.claim(staleRun.runId)
const reworkCandidate = kernel.storeCandidate({ attemptId: rework.attemptId, token: rework.token, content: 'upstream v2' })
kernel.adopt({ attemptId: rework.attemptId, token: rework.token, candidate: reworkCandidate })
ok(kernel.one('SELECT state,stale FROM workflow_steps WHERE id=?', 'run-stale:step:2').state === 'stale', 'downstream step is marked stale')
ok(kernel.one('SELECT parent_id FROM workflow_snapshots WHERE id=?', kernel.one("SELECT id FROM workflow_snapshots WHERE content_hash=? ", kernel.hash('upstream v2')).id).parent_id === kernel.one("SELECT snapshot_id FROM workflow_adoptions WHERE step_id=? ORDER BY rowid LIMIT 1", 'run-stale:step:1').snapshot_id, 'rework snapshot chains to the previous snapshot')

// --- 上游变更后，在途下游 Attempt 不得采用（A03） ---------------------------
const inFlightRun = kernel.createRun({ id: 'run-inflight', steps: [auto('a'), auto('b'), auto('c')] })
const inFlightUpstream = kernel.claim(inFlightRun.runId)
const inFlightUpstreamCandidate = kernel.storeCandidate({ attemptId: inFlightUpstream.attemptId, token: inFlightUpstream.token, content: 'up v1' })
kernel.adopt({ attemptId: inFlightUpstream.attemptId, token: inFlightUpstream.token, candidate: inFlightUpstreamCandidate })
const inFlightDownstream = kernel.claim(inFlightRun.runId)
const inFlightDownstreamCandidate = kernel.storeCandidate({ attemptId: inFlightDownstream.attemptId, token: inFlightDownstream.token, content: 'down stale' })
kernel.query("UPDATE workflow_steps SET state='paused' WHERE id=?", 'run-inflight:step:1')
const inFlightRework = kernel.claim(inFlightRun.runId)
const inFlightReworkCandidate = kernel.storeCandidate({ attemptId: inFlightRework.attemptId, token: inFlightRework.token, content: 'up v2' })
kernel.adopt({ attemptId: inFlightRework.attemptId, token: inFlightRework.token, candidate: inFlightReworkCandidate })
ok(kernel.one('SELECT status FROM workflow_attempts WHERE id=?', inFlightDownstream.attemptId).status === 'superseded', 'in-flight downstream attempt is superseded by the upstream change')
expectCode(() => kernel.adopt({ attemptId: inFlightDownstream.attemptId, token: inFlightDownstream.token, candidate: inFlightDownstreamCandidate }), 'attempt_token_invalid')
ok(kernel.one('SELECT state FROM workflow_steps WHERE id=?', 'run-inflight:step:2').state === 'stale', 'late adoption cannot clear the stale marker')

// --- 取消是终态：迟到的人工确认不得复活运行（A07） --------------------------
const cancelledHuman = kernel.createRun({ id: 'run-cancel-human', human: true, steps: [humanStep('human.edit-confirm')] })
const cancelledTask = kernel.claim(cancelledHuman.runId)
const cancelledFingerprint = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', cancelledTask.taskId).input_hash
const cancelledRunRevision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', cancelledHuman.runId).revision
kernel.cancelRun(cancelledHuman.runId)
expectCode(() => kernel.confirmHuman({ taskId: cancelledTask.taskId, content: 'late', actorId: 'fixture-human', inputFingerprint: cancelledFingerprint, expectedRunRevision: cancelledRunRevision, expectedTaskRevision: 1, idempotencyKey: 'late', expectedBindingVersion: kernel.inputBindingFor(cancelledTask.taskId).version }), 'cas_conflict')
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', cancelledHuman.runId).status === 'cancelled', 'cancelled run stays cancelled after a late confirmation')
ok(kernel.one('SELECT status FROM workflow_human_tasks WHERE id=?', cancelledTask.taskId).status === 'cancelled', 'cancelRun closes the open human task')

// --- 持久化与指纹校验 -----------------------------------------------------
const tamperRun = kernel.createRun({ id: 'run-tamper', steps: [auto('fake.transform')] })
const tamperClaim = kernel.claim(tamperRun.runId)
const tamperCandidate = kernel.storeCandidate({ attemptId: tamperClaim.attemptId, token: tamperClaim.token, content: 'tamper target' })
const manifestPath = join(root, 'manifests', `${String(tamperClaim.attemptId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
ok(existsSync(manifestPath), 'manifest is written to disk')
writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), contentHash: 'f'.repeat(64) }), 'utf8')
expectCode(() => kernel.adopt({ attemptId: tamperClaim.attemptId, token: tamperClaim.token, candidate: tamperCandidate }), 'manifest_mismatch')

const rollbackRun = kernel.createRun({ id: 'run-rollback', steps: [auto('fake.transform')] })
const rollbackClaim = kernel.claim(rollbackRun.runId)
const rollbackCandidate = kernel.storeCandidate({ attemptId: rollbackClaim.attemptId, token: rollbackClaim.token, content: 'rollback target' })
const snapshotsBeforeFailure = kernel.one('SELECT COUNT(*) AS n FROM workflow_snapshots').n
expectCode(() => kernel.adopt({ attemptId: rollbackClaim.attemptId, token: rollbackClaim.token, candidate: rollbackCandidate, expectedStepRevision: 99 }), 'cas_conflict')
ok(kernel.one('SELECT COUNT(*) AS n FROM workflow_snapshots').n === snapshotsBeforeFailure, 'failed adoption leaves no snapshot')
ok(existsSync(join(root, 'objects', rollbackCandidate.contentHash.slice(0, 2), rollbackCandidate.contentHash)), 'failed adoption conservatively retains the object for possible in-flight consumers; GC is not implemented')
ok(!existsSync(join(root, 'manifests', `${String(rollbackClaim.attemptId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`)), 'failed adoption removes the orphan manifest')

// --- 假执行器 -------------------------------------------------------------
const executorRoot = kernel.createRun({ id: 'run-fake', steps: [auto('fake.transform')] })
const executor = createFakeExecutor({ kernel, outcomes: { 'run-fake': 'duplicate' } })
const fakeResult = await executor.execute({ runId: executorRoot.runId, content: 'fake executor output' })
ok(fakeResult.duplicateIgnored === true, 'duplicate fake callback is idempotently ignored')

const failureRoot = kernel.createRun({ id: 'run-fake-failure', steps: [auto('fake.transform')] })
const failing = createFakeExecutor({ kernel, outcomes: { 'run-fake-failure': 'failure' } })
const failureResult = await failing.execute({ runId: failureRoot.runId, content: 'x' })
ok(failureResult.outcome === 'failed', 'fake executor surfaces failure')
ok(kernel.one('SELECT status FROM workflow_runs WHERE id=?', failureRoot.runId).status === 'paused', 'failure pauses the run through the kernel API')

// --- 存储边界 -------------------------------------------------------------
expectCode(() => createWorkflowKernel({}, join(root, 'nosqlite')), 'workflow_requires_sqlite')
ok(new WorkflowRequiresSqliteError().code === 'workflow_requires_sqlite', 'kernel exports the storage error code')

const tables = kernel.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%' ORDER BY name").map(row => row.name)
ok(tables.length >= 10, 'workflow tables are sqlite-backed')
console.log(JSON.stringify({ checks, tables, scope: 'temporary SQLite, synthetic fixtures and fake executor only' }))
kernel.db.close()
rmSync(root, { recursive: true, force: true })
