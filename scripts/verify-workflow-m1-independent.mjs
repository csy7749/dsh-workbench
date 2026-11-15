// Independent M1 acceptance checks (happy-4.1). Reads the kernel as a black box;
// every check runs in its own temp SQLite + temp work root, synthetic content only.
// Exit 0 = all contract boundaries observed; exit 1 = at least one gap remains.
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const repo = 'D:/AI/dsh-workbench'
const { createWorkflowKernel, openWorkflowKernel } = await import(new URL(`file:///${repo}/src/workflow/m1-kernel.mjs`).href)

const results = []
const check = async (id, title, fn) => {
  const root = mkdtempSync(join(tmpdir(), `m1-ind-${id}-`))
  let kernel
  try {
    kernel = createWorkflowKernel(new DatabaseSync(join(root, 'p.sqlite')), root)
    const detail = await fn(kernel, root)
    results.push({ id, title, status: 'pass', detail })
  } catch (error) {
    results.push({ id, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    try { kernel?.db?.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
}
const need = (condition, message) => { if (!condition) throw new Error(message) }
const auto = (nodeId, target = null) => ({ nodeId, nodeKind: 'automatic', requiredChecks: [], publishTargets: target ? [{ target, required: true }] : [] })
const human = nodeId => ({ nodeId, nodeKind: 'human', requiredChecks: [], publishTargets: [] })
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
// 夹具目标适配器：目标版本与正文都由夹具持有，adopt 的 baseRevision/baseContentHash 与
// claim/对账的 observe 都取自它，绝不回读 workflow_outbox（否则等于拿请求参数和请求参数比）。
const targets = new Map()
const fixtureTarget = (name) => {
  if (!targets.has(name)) {
    const state = { name, revision: 1, content: `fixture base of ${name}` }
    state.contentHash = () => sha256(state.content)
    state.observe = (asked) => ({ target: asked, revision: state.revision, contentHash: state.contentHash() })
    state.advanceTo = (next) => { state.revision = next }
    state.setContent = (next) => { state.content = next }
    targets.set(name, state)
  }
  return targets.get(name)
}
// adopt 参数：目标名 + 夹具当前版本 + 基准正文摘要 + 类别，全部取自夹具而不是取自 outbox。
const at = (name) => {
  const fixture = fixtureTarget(name)
  return { target: name, baseRevision: fixture.revision, baseContentHash: fixture.contentHash(), targetKind: 'raw_text' }
}
const claimPublish = (kernel, outboxId, name) => kernel.claimOutbox(outboxId, { observe: fixtureTarget(name).observe })
const adoptNext = (kernel, runId, content, options = {}) => {
  const claim = kernel.claim(runId)
  need(claim.kind === 'automatic', `expected automatic step, got ${claim.kind}`)
  const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content })
  const adopted = kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate, ...options })
  return { claim, candidate, adopted }
}

// C1 cross-step parent chain must reference the upstream snapshot id
await check('C1', 'parent snapshot points to upstream snapshot across steps', (kernel) => {
  kernel.createRun({ id: 'r1', steps: [auto('a'), auto('b')] })
  const first = adoptNext(kernel, 'r1', 'step one output')
  const second = adoptNext(kernel, 'r1', 'step two output')
  const rows = kernel.query('SELECT id,parent_id FROM workflow_snapshots ORDER BY rowid')
  const [s1, s2] = rows
  need(s1.id === first.adopted.snapshotId, 'first snapshot id mismatch')
  need(s2.parent_id === s1.id, `step2 parent_id=${JSON.stringify(s2.parent_id)} should be upstream snapshot ${s1.id}`)
  return { snapshots: rows }
})

// C2 re-adoption of the same step must chain to the previous snapshot, not an adoption id
await check('C2', 're-adoption parent is a snapshot id, not an adoption id', (kernel) => {
  kernel.createRun({ id: 'r2', steps: [auto('a'), auto('b')] })
  const first = adoptNext(kernel, 'r2', 'v1')
  kernel.query("UPDATE workflow_steps SET state='paused' WHERE id=?", 'r2:step:1')
  const second = adoptNext(kernel, 'r2', 'v2')
  const row = kernel.one('SELECT parent_id FROM workflow_snapshots WHERE id=?', second.adopted.snapshotId)
  const snapshotIds = kernel.query('SELECT id FROM workflow_snapshots').map(r => r.id)
  const adoptionIds = kernel.query('SELECT id FROM workflow_adoptions').map(r => r.id)
  need(row.parent_id === first.adopted.snapshotId, `parent_id=${JSON.stringify(row.parent_id)} should be previous snapshot ${first.adopted.snapshotId}`)
  need(!adoptionIds.includes(row.parent_id), 'parent_id must not be an adoption id')
  need(snapshotIds.includes(row.parent_id), 'parent_id does not resolve to a snapshot row')
  return { first: first.adopted, second: second.adopted, parent: row.parent_id }
})

// C3 confirmHuman idempotent replay returns the original adoption and adds no rows
await check('C3', 'confirmHuman replays the same idempotency key without duplicating rows', (kernel) => {
  kernel.createRun({ id: 'r3', human: true, steps: [human('human.edit-confirm')] })
  const task = kernel.claim('r3')
  const fingerprint = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', task.taskId).input_hash
  const runRevision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'r3').revision
  const args = { taskId: task.taskId, content: 'edited once', actorId: 'fixture-human', inputFingerprint: fingerprint, expectedRunRevision: runRevision, idempotencyKey: 'confirm-1', expectedBindingVersion: kernel.inputBindingFor(task.taskId).version }
  const first = kernel.confirmHuman({ ...args })
  const snapshotsAfterFirst = kernel.one('SELECT COUNT(*) AS n FROM workflow_snapshots').n
  const adoptionsAfterFirst = kernel.one('SELECT COUNT(*) AS n FROM workflow_adoptions').n
  const replay = kernel.confirmHuman({ ...args })
  need(replay.adoptionId === first.adoptionId, `replay adoptionId=${JSON.stringify(replay.adoptionId)} should equal ${first.adoptionId}`)
  need(replay.replayed === true, 'replay must be flagged replayed:true')
  need(kernel.one('SELECT COUNT(*) AS n FROM workflow_snapshots').n === snapshotsAfterFirst, 'replay created another snapshot')
  need(kernel.one('SELECT COUNT(*) AS n FROM workflow_adoptions').n === adoptionsAfterFirst, 'replay created another adoption')
  return { first, replay }
})

// C4 an expired lease must not be adopted, and the step must be re-claimable
await check('C4', 'expired lease rejects adoption and re-claims as a new attempt', (kernel) => {
  kernel.createRun({ id: 'r4', steps: [auto('a')] })
  const claim = kernel.claim('r4')
  kernel.query('UPDATE workflow_attempts SET lease_until=? WHERE id=?', '2000-01-01T00:00:00.000Z', claim.attemptId)
  const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content: 'late output' })
  let lateError = null
  try { kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate }) } catch (error) { lateError = error.code ?? error.message }
  need(lateError !== null, 'expired attempt was adopted; expected lease_expired')
  need(/lease/i.test(String(lateError)), `expected a lease error, got ${lateError}`)
  const reclaimed = kernel.claim('r4')
  need(reclaimed.kind === 'automatic', 'step not re-claimable after lease expiry')
  const attemptNo = kernel.one('SELECT attempt_no FROM workflow_attempts WHERE id=?', reclaimed.attemptId).attempt_no
  need(attemptNo >= 2, `expected a fresh attempt number, got ${attemptNo}`)
  return { lateError, attemptNo }
})

// C5 a cancelled run must not hand out attempts
await check('C5', 'cancelled run rejects claim', (kernel) => {
  kernel.createRun({ id: 'r5', steps: [auto('a'), auto('b')] })
  adoptNext(kernel, 'r5', 'first')
  kernel.query("UPDATE workflow_runs SET status='cancelled' WHERE id=?", 'r5')
  let error = null
  try { kernel.claim('r5') } catch (caught) { error = caught.code ?? caught.message }
  need(error !== null, 'cancelled run still produced a claimable attempt')
  return { error }
})

// C6 re-adopting upstream must mark dependent downstream work stale
await check('C6', 'upstream re-adoption marks downstream step stale', (kernel) => {
  // 三步：上游重跑发生在这条 run 还没走完的时候，run 保持 running 才有资格重新领取。
  kernel.createRun({ id: 'r6', steps: [auto('a'), auto('b'), auto('c')] })
  adoptNext(kernel, 'r6', 'upstream v1')
  adoptNext(kernel, 'r6', 'downstream v1')
  kernel.query("UPDATE workflow_steps SET state='paused' WHERE id=?", 'r6:step:1')
  adoptNext(kernel, 'r6', 'upstream v2')
  const downstream = kernel.one('SELECT state,stale FROM workflow_steps WHERE id=?', 'r6:step:2')
  need(Number(downstream.stale) === 1 || downstream.state === 'stale', `downstream step not marked stale: ${JSON.stringify(downstream)}`)
  return { downstream }
})

// C7 attempts accumulate budget and stop at the ceiling
await check('C7', 'attempts accumulate budget_used and block when exhausted', (kernel) => {
  kernel.createRun({ id: 'r7', steps: [auto('a')] })
  kernel.query('UPDATE workflow_runs SET budget_total=1 WHERE id=?', 'r7')
  const claim = kernel.claim('r7')
  const usedAfterClaim = kernel.one('SELECT budget_used FROM workflow_runs WHERE id=?', 'r7').budget_used
  need(Number(usedAfterClaim) > 0, `budget_used stayed ${usedAfterClaim} after a claim`)
  kernel.query('UPDATE workflow_attempts SET status=?,outcome=? WHERE id=?', 'failed', 'fake_failure', claim.attemptId)
  kernel.query("UPDATE workflow_steps SET state='paused' WHERE id=?", 'r7:step:1')
  let error = null
  try { kernel.claim('r7') } catch (caught) { error = caught.code ?? caught.message }
  need(error !== null, 'run claimed past budget_total=1')
  need(/budget/i.test(String(error)), `expected budget_exhausted, got ${error}`)
  return { usedAfterClaim, error }
})

// C8 outbox: pending item superseded by a newer adoption of the same target, failure retryable
await check('C8', 'outbox supersedes pending items and supports retry', (kernel) => {
  // 两步：第一次采用后 run 仍在 running，后续重采用才落在同一条 run 内。
  kernel.createRun({ id: 'r8', steps: [auto('a', 'pd:fixture-product-alpha'), auto('b')] })
  const first = adoptNext(kernel, 'r8', 'v1', at('pd:fixture-product-alpha'))
  const firstRow = kernel.one('SELECT * FROM workflow_outbox WHERE adoption_id=?', first.adopted.adoptionId)
  need(firstRow && firstRow.status === 'pending', 'publish item not queued as pending')
  reAdopt(kernel, 'r8', 'v2', 'pd:fixture-product-alpha')
  const afterReAdopt = kernel.query('SELECT id,adoption_id,status FROM workflow_outbox ORDER BY rowid')
  need(afterReAdopt.length >= 2, `expected a second publish item, got ${JSON.stringify(afterReAdopt)}`)
  need(afterReAdopt[0].status === 'superseded', `old pending item status=${afterReAdopt[0].status}, expected superseded`)
  const newest = afterReAdopt[afterReAdopt.length - 1]
  need(newest.status === 'pending', 'new publish item not pending')
  const newestClaim = claimPublish(kernel, newest.id, 'pd:fixture-product-alpha')
  kernel.completeOutbox(newest.id, 'failed', null, newestClaim.claimGeneration)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', newest.id).status === 'failed', 'failure not recorded')
  const retried = kernel.retryOutbox ? kernel.retryOutbox(newest.id) : null
  need(retried === 'pending' || kernel.one('SELECT status FROM workflow_outbox WHERE id=?', newest.id).status === 'pending', 'no retry path from failed back to pending')
  return { outbox: kernel.query('SELECT id,status FROM workflow_outbox ORDER BY rowid') }
})

function reAdopt(kernel, runId, content, target) {
  kernel.query("UPDATE workflow_steps SET state='paused' WHERE id=?", `${runId}:step:1`)
  const claim = kernel.claim(runId)
  const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content })
  return { claim, candidate, adopted: kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate, ...at(target) }) }
}

// C9 manifest tampering on disk must be detected before adoption
await check('C9', 'adopt verifies the manifest on disk', (kernel, root) => {
  kernel.createRun({ id: 'r9', steps: [auto('a')] })
  const claim = kernel.claim('r9')
  const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content: 'tamper target' })
  const fileSafe = String(claim.attemptId).replace(/[^A-Za-z0-9._-]/g, '_')
  const manifestPath = join(root, 'manifests', `${fileSafe}.json`)
  need(existsSync(manifestPath), 'manifest file not found on disk')
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), contentHash: 'f'.repeat(64) }), 'utf8')
  let error = null
  try { kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate }) } catch (caught) { error = caught.code ?? caught.message }
  need(error !== null, 'tampered manifest was accepted')
  return { error }
})

// C10 failed adoption leaves no snapshot behind; drafts are atomic under CAS
await check('C10', 'failed adoption rolls back and stale draft revision is rejected', (kernel) => {
  kernel.createRun({ id: 'r10', steps: [auto('a')] })
  const claim = kernel.claim('r10')
  const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content: 'rollback target' })
  let error = null
  try { kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate, expectedStepRevision: 99 }) } catch (caught) { error = caught.code ?? caught.message }
  need(error !== null, 'adoption with a wrong step revision was accepted')
  need(kernel.one('SELECT COUNT(*) AS n FROM workflow_snapshots').n === 0, 'failed adoption left a snapshot row')
  kernel.createRun({ id: 'r10h', human: true, steps: [human('human.edit-confirm')] })
  const task = kernel.claim('r10h')
  kernel.saveDraft({ taskId: task.taskId, content: 'draft one', expectedTaskRevision: 1, expectedBindingVersion: kernel.inputBindingFor(task.taskId).version })
  let draftError = null
  try { kernel.saveDraft({ taskId: task.taskId, content: 'draft two', expectedTaskRevision: 1, expectedBindingVersion: kernel.inputBindingFor(task.taskId).version }) } catch (caught) { draftError = caught.code ?? caught.message }
  need(draftError !== null, 'stale draft revision was accepted')
  need(kernel.one('SELECT task_revision FROM workflow_human_tasks WHERE id=?', task.taskId).task_revision === 2, 'task revision changed by the rejected draft')
  return { error, draftError }
})

// C11 kernel refuses non-SQLite handles instead of silently degrading to JSON
await check('C11', 'kernel refuses non-SQLite storage', () => {
  let error = null
  try { createWorkflowKernel({}, mkdtempSync(join(tmpdir(), 'm1-ind-nosql-'))) } catch (caught) { error = caught.code ?? caught.message }
  need(error === 'workflow_requires_sqlite', `expected workflow_requires_sqlite, got ${error}`)
  void openWorkflowKernel
  return { error }
})

// C12 cancellation is terminal: a late human confirmation must not revive the run
await check('C12', 'cancelled run rejects a late human confirmation and stays cancelled', (kernel) => {
  kernel.createRun({ id: 'r12', human: true, steps: [human('human.edit-confirm')] })
  const task = kernel.claim('r12')
  const fingerprint = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', task.taskId).input_hash
  const runRevision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'r12').revision
  kernel.cancelRun('r12')
  let error = null
  try {
    kernel.confirmHuman({ taskId: task.taskId, content: 'late confirmation', actorId: 'fixture-human', inputFingerprint: fingerprint, expectedRunRevision: runRevision, expectedTaskRevision: 1, idempotencyKey: 'late-confirm', expectedBindingVersion: kernel.inputBindingFor(task.taskId).version })
  } catch (caught) { error = caught.code ?? caught.message }
  need(error !== null, 'cancelled run accepted a human confirmation')
  need(kernel.one("SELECT status FROM workflow_runs WHERE id='r12'").status === 'cancelled', 'run status left cancelled')
  need(kernel.one('SELECT COUNT(*) AS n FROM workflow_adoptions').n === 0, 'cancelled run produced an adoption')
  return { error }
})

// C13 an in-flight downstream attempt must not land after the upstream changed
await check('C13', 'stale downstream rejects its pre-change attempt', (kernel) => {
  kernel.createRun({ id: 'r13', steps: [auto('a'), auto('b'), auto('c')] })
  const upstream = adoptNext(kernel, 'r13', 'upstream v1')
  // 下游 Attempt 已领取但还没采用，此时上游被重新采用。
  const inflight = kernel.claim('r13')
  const inflightCandidate = kernel.storeCandidate({ attemptId: inflight.attemptId, token: inflight.token, content: 'downstream stale output' })
  kernel.query("UPDATE workflow_steps SET state='paused' WHERE id=?", 'r13:step:1')
  adoptNext(kernel, 'r13', 'upstream v2')
  const downstream = kernel.one('SELECT state,stale FROM workflow_steps WHERE id=?', 'r13:step:2')
  need(Number(downstream.stale) === 1 && downstream.state === 'stale', `downstream not stale before late adopt: ${JSON.stringify(downstream)}`)
  let error = null
  try { kernel.adopt({ attemptId: inflight.attemptId, token: inflight.token, candidate: inflightCandidate }) } catch (caught) { error = caught.code ?? caught.message }
  need(error !== null, 'pre-change downstream attempt was adopted after staleness')
  need(kernel.one('SELECT state FROM workflow_steps WHERE id=?', 'r13:step:2').state === 'stale', 'late adoption cleared the stale marker')
  need(kernel.one('SELECT COUNT(*) AS n FROM workflow_adoptions WHERE step_id=?', 'r13:step:2').n === 0, 'late adoption created an adoption')
  return { error, upstream: upstream.adopted.adoptionId, downstream }
})

// C14 a required publish still pending must keep the run from completing (A06)
await check('C14', 'required publish pending blocks completion', (kernel) => {
  kernel.createRun({ id: 'r14', steps: [auto('a', 'pd:fixture-product-alpha')] })
  const adopted = adoptNext(kernel, 'r14', 'publish me', at('pd:fixture-product-alpha'))
  const run = kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r14')
  const item = kernel.one('SELECT status FROM workflow_outbox WHERE adoption_id=?', adopted.adopted.adoptionId)
  need(run.status === 'running', `run status=${run.status} but the required publish is still ${item?.status}`)
  need(item?.status === 'pending', `expected a pending publish item, got ${JSON.stringify(item)}`)
  const c14Claim = claimPublish(kernel, `${adopted.adopted.adoptionId}:publish`, 'pd:fixture-product-alpha')
  const settled = kernel.completeOutbox(`${adopted.adopted.adoptionId}:publish`, 'succeeded', null, c14Claim.claimGeneration)
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r14').status === 'completed', 'run did not complete after the publish succeeded')
  return { beforePublish: run.status, publish: item.status, afterPublish: settled.runStatus }
})

// C15 publish failure and conflict pause the run with a structured reason instead of succeeding
await check('C15', 'publish failure or conflict pauses the run', (kernel) => {
  kernel.createRun({ id: 'r15', steps: [auto('a', 'audit:fixture-product-alpha')] })
  const adopted = adoptNext(kernel, 'r15', 'conflict target', at('audit:fixture-product-alpha'))
  const outboxId = `${adopted.adopted.adoptionId}:publish`
  const c15Claim = claimPublish(kernel, outboxId, 'audit:fixture-product-alpha')
  const failed = kernel.completeOutbox(outboxId, 'failed', 'fixture writer rejected', c15Claim.claimGeneration)
  need(failed.runStatus === 'paused', `run status=${failed.runStatus}, expected paused on publish failure`)
  const reason = kernel.one('SELECT pause_reason FROM workflow_runs WHERE id=?', 'r15').pause_reason
  need(reason === 'publish_failed', `pause_reason=${JSON.stringify(reason)}, expected publish_failed`)
  let resumeError = null
  try { kernel.resume('r15') } catch (caught) { resumeError = caught.code ?? caught.message }
  need(resumeError === 'publish_unresolved', `resume on an unresolved publish returned ${JSON.stringify(resumeError)}`)
  kernel.retryOutbox(outboxId)
  const c15Reclaim = claimPublish(kernel, outboxId, 'audit:fixture-product-alpha')
  const conflicted = kernel.completeOutbox(outboxId, 'conflict', 'base revision moved', c15Reclaim.claimGeneration)
  need(conflicted.runStatus === 'paused', 'publish conflict did not pause the run')
  need(kernel.one('SELECT pause_reason FROM workflow_runs WHERE id=?', 'r15').pause_reason === 'publish_conflict', 'conflict pause reason not structured')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r15').status !== 'completed', 'publish conflict was recorded as success')
  return { failed: failed.runStatus, reason, resumeError, conflicted: conflicted.runStatus }
})

// C16 unknown publish outcome must be reconciled, and reconciliation alone must not fake success
await check('C16', 'unknown publish outcome requires reconciliation', (kernel) => {
  kernel.createRun({ id: 'r16', steps: [auto('a', 'md:fixture-module-books')] })
  const adopted = adoptNext(kernel, 'r16', 'unknown publish', at('md:fixture-module-books'))
  const outboxId = `${adopted.adopted.adoptionId}:publish`
  const c16Claim = claimPublish(kernel, outboxId, 'md:fixture-module-books')
  const unknown = kernel.completeOutbox(outboxId, 'outcome_unknown', null, c16Claim.claimGeneration)
  need(unknown.runStatus === 'paused', 'unknown publish outcome did not pause the run')
  need(kernel.one('SELECT pause_reason FROM workflow_runs WHERE id=?', 'r16').pause_reason === 'publish_outcome_unknown', 'unknown pause reason not structured')
  let retryError = null
  try { kernel.retryOutbox(outboxId) } catch (caught) { retryError = caught.code ?? caught.message }
  need(retryError === 'outbox_requires_reconcile', `retry on an unknown publish returned ${JSON.stringify(retryError)}`)
  // 对账必须带真实观测：目标此刻已是这条发布的预期正文。
  const reconciled = kernel.reconcilePublishEffect(outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: c16Claim.claimGeneration,
    observe: (asked) => ({ target: asked, revision: 2, contentHash: sha256('unknown publish') }),
  })
  need(reconciled.decision === 'applied', `reconciliation of a published item decided ${reconciled.decision}`)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', outboxId).status === 'succeeded', 'reconciled publish not marked succeeded')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r16').status === 'paused', 'reconciliation completed the run without an explicit resume')
  const resumed = kernel.resume('r16')
  need(resumed.status === 'completed', `resume after reconciliation returned ${resumed.status}, expected completed`)
  return { paused: unknown.runStatus, retryError, reconciled: reconciled.outcome, resumed: resumed.status }
})

// C17 cancellation: queued publishes are superseded, in-flight ones wait for reconciliation
await check('C17', 'cancellation settles queued and in-flight publishes', (kernel) => {
  kernel.createRun({ id: 'r17', steps: [auto('a', 'pd:fixture-product-alpha'), auto('b', 'pd:fixture-product-beta')] })
  const first = adoptNext(kernel, 'r17', 'queued publish', at('pd:fixture-product-alpha'))
  const second = adoptNext(kernel, 'r17', 'in-flight publish', at('pd:fixture-product-beta'))
  const queuedId = `${first.adopted.adoptionId}:publish`
  const inflightId = `${second.adopted.adoptionId}:publish`
  const c17Claim = claimPublish(kernel, inflightId, 'pd:fixture-product-beta')
  kernel.completeOutbox(inflightId, 'outcome_unknown', null, c17Claim.claimGeneration)
  kernel.cancelRun('r17')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', queuedId).status === 'superseded', 'queued publish was not superseded by cancellation')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', inflightId).status === 'outcome_unknown', 'in-flight publish was assumed cancelled')
  // 观测到目标仍是基准正文 → absent；运行已取消，故落 superseded 而不是回到 pending。
  const reconciled = kernel.reconcilePublishEffect(inflightId, {
    actorId: 'fixture-reconciler',
    claimGeneration: c17Claim.claimGeneration,
    observe: fixtureTarget('pd:fixture-product-beta').observe,
  })
  need(reconciled.decision === 'absent', `an untouched target reconciled as ${reconciled.decision}`)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', inflightId).status === 'superseded', 'reconciled not-published item on a cancelled run was requeued')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r17').status === 'cancelled', 'reconciliation revived a cancelled run')
  need(reconciled.runStatus === 'cancelled', `reconcile after cancel returned ${reconciled.runStatus}`)
  return { queued: 'superseded', reconciled: reconciled.runStatus }
})

// C18 cancellation plus an unknown outcome: reconcile records it, never revives the run
await check('C18', 'cancel then reconcile never revives the run', (kernel) => {
  kernel.createRun({ id: 'r18', steps: [auto('a')] })
  const claim = kernel.claim('r18')
  kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content: 'late artifact' })
  kernel.markUnknown(claim.attemptId)
  kernel.cancelRun('r18')
  // 先对账为未执行：不得把取消改写成 paused。
  const notExecuted = kernel.reconcileUnknown(claim.attemptId, 'not_executed')
  need(notExecuted === 'not_executed', `reconcile after cancel returned ${JSON.stringify(notExecuted)}`)
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r18').status === 'cancelled', 'reconcile after cancel revived the run')
  need(kernel.one('SELECT COUNT(*) AS n FROM workflow_adoptions').n === 0, 'reconcile after cancel produced an adoption')
  // 再验已执行分支：产物存在也不得采用。
  kernel.createRun({ id: 'r18b', steps: [auto('a')] })
  const claimB = kernel.claim('r18b')
  kernel.storeCandidate({ attemptId: claimB.attemptId, token: claimB.token, content: 'executed artifact' })
  kernel.markUnknown(claimB.attemptId)
  kernel.cancelRun('r18b')
  const executed = kernel.reconcileUnknown(claimB.attemptId, 'executed')
  need(executed === 'executed', `reconcile executed after cancel returned ${JSON.stringify(executed)}`)
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r18b').status === 'cancelled', 'executed reconcile after cancel revived the run')
  need(kernel.one('SELECT status FROM workflow_attempts WHERE id=?', claimB.attemptId).status === 'reconciled', 'attempt was left in unknown state after reconcile')
  need(kernel.one('SELECT COUNT(*) AS n FROM workflow_adoptions').n === 0, 'executed reconcile adopted content into a cancelled run')
  return { notExecuted, executed }
})

// C19 a publish-blocked pause must not be bypassed by claim; only resume may continue
await check('C19', 'claim cannot bypass a publish-blocked pause', (kernel) => {
  kernel.createRun({ id: 'r19', steps: [auto('a', 'pd:fixture-product-alpha'), auto('b')] })
  const adopted = adoptNext(kernel, 'r19', 'step one', at('pd:fixture-product-alpha'))
  const outboxId = `${adopted.adopted.adoptionId}:publish`
  const c19Claim = claimPublish(kernel, outboxId, 'pd:fixture-product-alpha')
  kernel.completeOutbox(outboxId, 'failed', 'fixture writer rejected', c19Claim.claimGeneration)
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r19').status === 'paused', 'publish failure did not pause the run')
  let claimError = null
  try { kernel.claim('r19') } catch (caught) { claimError = caught.code ?? caught.message }
  need(claimError === 'run_paused', `claim on a paused run returned ${JSON.stringify(claimError)}`)
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r19').status === 'paused', 'claim changed the paused status')
  need(kernel.one('SELECT pause_reason FROM workflow_runs WHERE id=?', 'r19').pause_reason === 'publish_failed', 'claim cleared the pause reason')
  need(kernel.one('SELECT state FROM workflow_steps WHERE id=?', 'r19:step:2').state === 'pending', 'blocked claim still advanced the next step')
  // 阻塞解除后仍须显式继续：resume 之前不推进。
  kernel.retryOutbox(outboxId)
  const c19RetryClaim = claimPublish(kernel, outboxId, 'pd:fixture-product-alpha')
  kernel.completeOutbox(outboxId, 'succeeded', null, c19RetryClaim.claimGeneration)
  const afterPublish = kernel.one('SELECT status,pause_reason FROM workflow_runs WHERE id=?', 'r19')
  need(afterPublish.status === 'paused', `run left paused requirement: status=${afterPublish.status}`)
  need(afterPublish.pause_reason === null, `pause reason not cleared after the block resolved: ${JSON.stringify(afterPublish.pause_reason)}`)
  let claimAfterResolve = null
  try { kernel.claim('r19') } catch (caught) { claimAfterResolve = caught.code ?? caught.message }
  need(claimAfterResolve === 'run_paused', `claim after the block resolved returned ${JSON.stringify(claimAfterResolve)}`)
  const resumed = kernel.resume('r19')
  need(resumed.status === 'running', `resume returned ${JSON.stringify(resumed.status)}, expected running`)
  const next = kernel.claim('r19')
  need(next.kind === 'automatic', `claim after resume returned ${JSON.stringify(next.kind)}`)
  const candidate = kernel.storeCandidate({ attemptId: next.attemptId, token: next.token, content: 'step two' })
  kernel.adopt({ attemptId: next.attemptId, token: next.token, candidate })
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r19').status === 'completed', 'run did not complete after the explicit resume')
  return { claimError, afterPublish, claimAfterResolve, resumed: resumed.status }
})

// C20 an executor failure pauses the run; the step is only claimed again after resume
await check('C20', 'attempt failure needs an explicit resume', (kernel) => {
  kernel.createRun({ id: 'r20', steps: [auto('a')] })
  const claim = kernel.claim('r20')
  kernel.markFailed(claim.attemptId, 'fake_executor_failed')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r20').status === 'paused', 'executor failure did not pause the run')
  need(kernel.one('SELECT state FROM workflow_steps WHERE id=?', 'r20:step:1').state === 'paused', 'failed step did not return to a claimable state')
  let claimError = null
  try { kernel.claim('r20') } catch (caught) { claimError = caught.code ?? caught.message }
  need(claimError === 'run_paused', `claim after a failure returned ${JSON.stringify(claimError)}`)
  kernel.resume('r20')
  const retried = kernel.claim('r20')
  need(retried.attemptId !== claim.attemptId, 'resume did not start a fresh attempt')
  need(kernel.one('SELECT attempt_no FROM workflow_attempts WHERE id=?', retried.attemptId).attempt_no === 2, 'retry did not increment the attempt number')
  return { claimError, attemptNo: 2 }
})

// C21 a human wait blocks later steps and clears once the confirmation lands
await check('C21', 'human waiting blocks later steps until confirmed', (kernel) => {
  kernel.createRun({ id: 'r21', steps: [human('human.edit-confirm'), auto('b')] })
  const task = kernel.claim('r21')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r21').status === 'waiting_review', 'run did not enter waiting_review')
  let claimError = null
  try { kernel.claim('r21') } catch (caught) { claimError = caught.code ?? caught.message }
  need(claimError === 'run_waiting_review', `claim during a human wait returned ${JSON.stringify(claimError)}`)
  need(kernel.one('SELECT state FROM workflow_steps WHERE id=?', 'r21:step:2').state === 'pending', 'step 2 was claimed before the human confirmed')
  const inputHash = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', task.taskId).input_hash
  const runRevision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'r21').revision
  kernel.confirmHuman({ taskId: task.taskId, content: 'confirmed by human', actorId: 'fixture-human', inputFingerprint: inputHash, expectedRunRevision: runRevision, expectedTaskRevision: 1, idempotencyKey: 'c21', expectedBindingVersion: kernel.inputBindingFor(task.taskId).version })
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r21').status === 'running', 'run stayed in waiting_review after the confirmation')
  const next = kernel.claim('r21')
  need(next.kind === 'automatic', 'step 2 was not claimable after the confirmation')
  const candidate = kernel.storeCandidate({ attemptId: next.attemptId, token: next.token, content: 'after human' })
  kernel.adopt({ attemptId: next.attemptId, token: next.token, candidate })
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r21').status === 'completed', 'run did not complete after the human step')
  return { claimError, status: 'completed' }
})

// C22 unknown outcome reconciliation still needs an explicit resume before any claim
await check('C22', 'reconciled unknown outcome still needs an explicit resume', (kernel) => {
  kernel.createRun({ id: 'r22', steps: [auto('a')] })
  const claim = kernel.claim('r22')
  kernel.markUnknown(claim.attemptId)
  kernel.reconcileUnknown(claim.attemptId, 'not_executed')
  const reconciled = kernel.one('SELECT status,pause_reason FROM workflow_runs WHERE id=?', 'r22')
  need(reconciled.status === 'paused', `reconciled run status=${reconciled.status}, expected paused`)
  let claimError = null
  try { kernel.claim('r22') } catch (caught) { claimError = caught.code ?? caught.message }
  need(claimError === 'run_paused', `claim after reconciliation returned ${JSON.stringify(claimError)}`)
  kernel.resume('r22')
  const next = kernel.claim('r22')
  need(next.attemptId !== claim.attemptId, 'resume after reconciliation did not re-claim')
  // 已执行分支：对账补采用后仍保持 paused，必须显式继续才收敛。
  kernel.createRun({ id: 'r22b', steps: [auto('a')] })
  const claimB = kernel.claim('r22b')
  kernel.storeCandidate({ attemptId: claimB.attemptId, token: claimB.token, content: 'executed output' })
  kernel.markUnknown(claimB.attemptId)
  kernel.reconcileUnknown(claimB.attemptId, 'executed')
  need(kernel.one('SELECT COUNT(*) AS n FROM workflow_adoptions WHERE step_id=?', 'r22b:step:1').n === 1, 'executed reconciliation did not adopt the artifact')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'r22b').status === 'paused', 'executed reconciliation completed the run without resume')
  const resumed = kernel.resume('r22b')
  need(resumed.status === 'completed', `resume after executed reconciliation returned ${JSON.stringify(resumed.status)}`)
  return { claimError, resumed: resumed.status }
})

const failed = results.filter(r => r.status === 'fail')
for (const r of results) console.log(`${r.status === 'pass' ? 'ok  ' : 'FAIL'} ${r.id} ${r.title}${r.status === 'fail' ? `\n     -> ${r.detail}` : ''}`)
console.log(JSON.stringify({ checks: results.length, passed: results.length - failed.length, failed: failed.map(r => r.id), scope: 'independent M1 acceptance; temporary SQLite, synthetic content, fake executor only' }))
process.exit(failed.length === 0 ? 0 : 1)
