// B1 / W1-10 假业务服务专项验证（happy-4.1）。
// 全程临时 SQLite + 临时对象目录 + 假宿主执行；不监听端口、不发真实 HTTP、不注册任何宿主工具。
// 每项检查独立临时库，失败报具体期望；exit 1 表示工具面契约仍有缺口。
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkflowKernel, openWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService, PERMISSIONS, PRINCIPAL_KINDS, SERVICE_ERROR_CODES } from '../src/workflow/m1-fake-service.mjs'

const MAX = 512 * 1024
const results = []
let assertions = 0

const need = (condition, message) => {
  assertions += 1
  if (!condition) throw new Error(message)
}

const expectError = (fn, code, detail = null) => {
  try {
    fn()
  } catch (error) {
    need(error.code === code, `expected ${code} but got ${error.code ?? error.message} (${error.detail ?? ''})`)
    if (detail) need(error.detail === detail, `expected detail ${detail} but got ${error.detail}`)
    return error
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

const check = (id, title, fn) => {
  const root = mkdtempSync(join(tmpdir(), `m1-svc-${id}-`))
  let kernel
  try {
    kernel = createWorkflowKernel(new DatabaseSync(join(root, 'p.sqlite')), root)
    const service = createFakeBusinessService({ kernel, targetAdapter, clock: () => '2026-11-14T00:00:00.000Z' })
    const detail = fn({ kernel, service, root })
    results.push({ id, title, status: 'pass', detail })
  } catch (error) {
    results.push({ id, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    try { kernel?.db?.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
}

const auto = (nodeId, publishTargets = []) => ({ nodeId, nodeKind: 'automatic', requiredChecks: [], publishTargets })
const human = nodeId => ({ nodeId, nodeKind: 'human', requiredChecks: [], publishTargets: [] })

const revision = (kernel, runId) => Number(kernel.one('SELECT revision FROM workflow_runs WHERE id=?', runId).revision)
const runStatus = (kernel, runId) => kernel.one('SELECT status,pause_reason FROM workflow_runs WHERE id=?', runId)

// 夹具目标适配器：目标版本与原文都由夹具持有，observe 读夹具而不是待测 outbox 的 base_revision。
// 08:109 之后采用前要采集基准：构造期注册的 targetAdapter 报的就是夹具里这份「采用那一刻的目标」。
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const fixtureTargets = new Map()
const fixtureTarget = (name, revision = 1) => {
  if (fixtureTargets.has(name)) return fixtureTargets.get(name)
  const state = { name, revision, content: '' }
  const handle = {
    name,
    get revision() { return state.revision },
    get content() { return state.content },
    read() { return { content: state.content, revision: state.revision } },
    setContent(next) { state.content = next },
    advanceTo(next) { state.revision = next },
    observe: () => ({ target: name, revision: state.revision, contentHash: sha256(state.content) }),
  }
  fixtureTargets.set(name, handle)
  return handle
}
// 构造期注册的可信目标适配器：service 专项的夹具都是原文文档。
const targetAdapter = {
  write: (target, content, options) => {
    const fixture = fixtureTarget(target)
    if (sha256(fixture.content) !== options.expectedHash) return { status: 'conflict' }
    if (target === 'pd:fixture-svc-2') return { status: 'failed' }
    fixture.setContent(content)
    fixture.advanceTo(fixture.revision + 1)
    return { status: 'succeeded' }
  },
  read: (target) => fixtureTarget(target).read(),
  kindOf: () => 'raw_text',
}

// 标准场景：ui 建运行，宿主领取自动步骤，节点 Agent 被授予该 run 与该 attempt。
const scene = ({ kernel, service, runId = 'run-svc', nodeId = 'fake.transform', productId = 'p1', target = null }) => {
  service.registerPrincipal({ id: 'ui-1', kind: 'ui', productId })
  service.registerPrincipal({ id: 'other-1', kind: 'other-agent', productId: 'p2' })
  service.registerPrincipal({ id: 'sched-1', kind: 'scheduler', productId })
  service.registerPrincipal({ id: 'http-1', kind: 'http-client', productId, credential: 'sess-1' })
  service.startRun({ principal: 'ui-1', idempotencyKey: `start-${runId}`, runId, productId, steps: [auto(nodeId, target ? [{ target, required: true }] : [])] })
  const claim = service.host.claimRun(runId)
  need(claim.kind === 'automatic', `expected automatic claim, got ${claim.kind}`)
  service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId, runIds: [runId], attemptIds: [claim.attemptId] })
  return claim
}

// S1 权限矩阵的关键格：Agent 无确认、无发布、无直写；scheduler 不能提交；ui 不能直接发布。
check('S1', 'permission matrix denies agent confirm/publish and scheduler submit', ({ kernel, service }) => {
  service.registerPrincipal({ id: 'ui-1', kind: 'ui', productId: 'p1' })
  service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId: 'p1' })
  service.registerPrincipal({ id: 'sched-1', kind: 'scheduler', productId: 'p1' })
  service.startRun({ principal: 'ui-1', idempotencyKey: 'start-s1', runId: 'run-s1', productId: 'p1', steps: [human('human.edit-confirm')] })
  const claim = service.host.claimRun('run-s1')
  need(claim.kind === 'human', 'expected a human task claim')
  service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId: 'p1', runIds: ['run-s1'], attemptIds: [] })
  expectError(() => service.confirmHumanTask({
    principal: 'node-1', taskId: claim.taskId, content: 'agent tries to confirm',
    inputFingerprint: kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claim.taskId).input_hash,
    expectedRunRevision: revision(kernel, 'run-s1'), idempotencyKey: 'agent-confirm',
  }), 'capability_unavailable', 'node-agent_may_not_confirm.human')
  expectError(() => service.host.publish({ principal: 'ui-1', outboxId: 'nope' }), 'capability_unavailable', 'ui_may_not_publish.official')
  expectError(() => service.submitOutput({ principal: 'sched-1', attemptId: 'x', token: 'y', content: 'z', idempotencyKey: 'k' }), 'capability_unavailable', 'scheduler_may_not_submit.output')
  need(Object.keys(PERMISSIONS).length === PRINCIPAL_KINDS.length, 'permission table must cover every principal kind')
  for (const kind of PRINCIPAL_KINDS) {
    need(PERMISSIONS[kind]['confirm.human'] === 'deny' || kind === 'ui', `${kind} must not confirm human tasks`)
    need(PERMISSIONS[kind]['write.direct'] === 'deny', `${kind} must not write notes/modules directly`)
    need(PERMISSIONS[kind]['publish.official'] !== 'allow' || kind === 'scheduler', `${kind} must not publish official outputs`)
  }
  // 负例：另一个产品的 UI 会话用同一台服务，也必须读不到、确认不了本产品的 run（G-01 本产品本会话可见）。
  service.registerPrincipal({ id: 'ui-2', kind: 'ui', productId: 'p2' })
  // 跨产品对象与不存在的对象对外同一结果（第十四轮统一口径）：run 级 -> run_not_found，task 级 -> human_task_not_found。
  expectError(() => service.getRun({ principal: 'ui-2', runId: 'run-s1' }), 'artifact_missing', 'run_not_found')
  expectError(() => service.listArtifacts({ principal: 'ui-2', runId: 'run-s1' }), 'artifact_missing', 'run_not_found')
  expectError(() => service.listEvents({ principal: 'ui-2', runId: 'run-s1' }), 'artifact_missing', 'run_not_found')
  expectError(() => service.commandRun({ principal: 'ui-2', runId: 'run-s1', command: 'pause', expectedRevision: revision(kernel, 'run-s1'), idempotencyKey: 'ui2-pause' }), 'artifact_missing', 'run_not_found')
  expectError(() => service.confirmHumanTask({
    principal: 'ui-2', taskId: claim.taskId, content: 'other product tries to confirm',
    inputFingerprint: kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claim.taskId).input_hash,
    expectedRunRevision: revision(kernel, 'run-s1'), idempotencyKey: 'ui2-confirm',
  }), 'human_confirm_required', 'human_task_not_found')
  need(kernel.one('SELECT status FROM workflow_human_tasks WHERE id=?', claim.taskId).status === 'open', 'a rejected cross-product confirm must not close the task')
  need(kernel.query('SELECT id FROM workflow_snapshots').length === 0, 'a rejected cross-product confirm must not adopt anything')

  const confirmed = service.confirmHumanTask({
    principal: 'ui-1', taskId: claim.taskId, content: 'human confirmed text',
    inputFingerprint: kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claim.taskId).input_hash,
    expectedRunRevision: revision(kernel, 'run-s1'), expectedBindingVersion: kernel.inputBindingFor(claim.taskId).version,
    idempotencyKey: 'ui-confirm',
  })
  need(confirmed.status === 'completed', `ui confirmation should complete, got ${confirmed.status}`)
  need(kernel.one('SELECT confirmed_by FROM workflow_human_tasks WHERE id=?', claim.taskId).confirmed_by === 'ui-1', 'confirmed_by must record the human principal')
  return { runStatus: runStatus(kernel, 'run-s1') }
})

// S2 输入与凭证：缺幂等键、空内容、超长内容、越界分页、无凭证的 http 客户端都要被挡在副作用之前。
check('S2', 'input and credential validation rejects before side effects', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s2' })
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'x' }), 'schema_invalid', 'idempotency_key_required')
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: '', idempotencyKey: 'k1' }), 'schema_invalid', 'content_required')
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'x'.repeat(MAX + 1), idempotencyKey: 'k2' }), 'schema_invalid', 'content_too_large')
  expectError(() => service.reportProgress({ principal: 'node-1', attemptId: claim.attemptId, idempotencyKey: 'k3', percent: 101 }), 'schema_invalid', 'percent_out_of_range')
  expectError(() => service.listEvents({ principal: 'ui-1', runId: 'run-s2', limit: 101 }), 'schema_invalid', 'limit_out_of_range')
  expectError(() => service.startRun({ principal: 'ui-1', idempotencyKey: 'k4', runId: 'run-s2b', steps: [auto('a')] }), 'schema_invalid', 'product_id_required')
  expectError(() => service.commandRun({ principal: 'ui-1', runId: 'run-s2', command: 'pause', idempotencyKey: 'k5' }), 'schema_invalid', 'expected_revision_required')
  expectError(() => service.getRun({ principal: 'http-1', runId: 'run-s2' }), 'capability_unavailable', 'credential_required')
  const withCredential = service.getRun({ principal: 'http-1', runId: 'run-s2', credential: 'sess-1' })
  need(withCredential.status === 'completed', 'http client with the session credential may read')
  need(service.state().jobs.length === 0, 'rejected calls must not create jobs')
  return { jobs: 0 }
})

// S3 归属：节点 Agent 只能用自己被派发的 attempt；跨 attempt 与其他 run 一律拒绝。
check('S3', 'a node agent may only submit for its dispatched attempt', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s3', nodeId: 'a' })
  service.startRun({ principal: 'ui-1', idempotencyKey: 'start-s3b', runId: 'run-s3b', productId: 'p1', steps: [auto('b')] })
  const foreign = service.host.claimRun('run-s3b')
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: foreign.attemptId, token: foreign.token, content: 'x', idempotencyKey: 'k1' }), 'capability_unavailable', 'attempt_not_authorized')
  expectError(() => service.getRun({ principal: 'node-1', runId: 'run-s3b' }), 'capability_unavailable', 'run_not_authorized')
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: 'forged-token', content: 'x', idempotencyKey: 'k2' }), 'attempt_invalid', 'attempt_token_mismatch')
  // 负例：未授权者不得靠错误码差异探测凭证——对同一外来 attempt，猜错的 token 与真实 token
  // 必须得到完全相同的拒绝（同一 code、同一 detail），都不能是 attempt_token_mismatch。
  const deniedWith = token => {
    try {
      service.submitOutput({ principal: 'node-1', attemptId: foreign.attemptId, token, content: 'x', idempotencyKey: `probe-${token}` })
    } catch (error) { return { code: error.code, detail: error.detail } }
    return null
  }
  const deniedWith2 = attemptId => {
    try {
      service.submitOutput({ principal: 'node-1', attemptId, token: 'any-token', content: 'x', idempotencyKey: `probe-${attemptId}` })
    } catch (error) { return { code: error.code, detail: error.detail } }
    return null
  }
  const wrongProbe = deniedWith('definitely-wrong-token')
  const rightProbe = deniedWith(foreign.token)
  need(wrongProbe && wrongProbe.code === 'capability_unavailable' && wrongProbe.detail === 'attempt_not_authorized',
    `a wrong token on a foreign attempt must be rejected as unauthorized, got ${JSON.stringify(wrongProbe)}`)
  need(JSON.stringify(wrongProbe) === JSON.stringify(rightProbe),
    `authorization must come before credential checks: ${JSON.stringify(wrongProbe)} vs ${JSON.stringify(rightProbe)}`)
  need(service.state().jobs.length === 0, 'a probing submit must not create a job')
  // 同级边界：未授权者也不能靠「attempt 存不存在」区分对象，不存在的 attemptId 与别人的 attempt
  // 得到同一拒绝。
  const missingProbe = deniedWith2('no-such-attempt')
  need(JSON.stringify(missingProbe) === JSON.stringify(wrongProbe),
    `a nonexistent attempt must look like a foreign one to an unauthorized caller: ${JSON.stringify(missingProbe)} vs ${JSON.stringify(wrongProbe)}`)
  // 授权者：错 token 仍是 attempt_token_mismatch（不是被吞成授权错误），正确凭证可正常重放。
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: 'wrong-but-authorized', content: 'x', idempotencyKey: 'k3' }), 'attempt_invalid', 'attempt_token_mismatch')
  const authorized = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'authorized body', idempotencyKey: 'authorized-key' })
  const replayed = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'authorized body', idempotencyKey: 'authorized-key' })
  need(replayed.replayed === true && replayed.jobRef === authorized.jobRef, 'an authorized replay must return the original jobRef')
  return {}
})

// S4 稳定 jobRef：同一 attempt 反复提交只绑定一个 jobRef，不会二次派发。
check('S4', 'repeated submits on one attempt reuse a single stable jobRef', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s4' })
  const first = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'v1', idempotencyKey: 'submit-1' })
  const second = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'v2-different-body', idempotencyKey: 'submit-2' })
  need(first.jobRef === second.jobRef, `jobRef changed: ${first.jobRef} vs ${second.jobRef}`)
  need(second.reused === true, 'the second submit must report reuse')
  need(service.state().jobs.length === 1, `expected 1 job, got ${service.state().jobs.length}`)
  need(service.state().metrics.hostExecutions === 0, 'submit must not execute the job itself')
  // 负例：attempt 已绑定 jobRef 后，错凭证不能把这份作业取回去（G-04 attempt 凭证边界）。
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: 'wrong-token', content: 'v1', idempotencyKey: 'submit-3' }), 'attempt_invalid', 'attempt_token_mismatch')
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: '', content: 'v1', idempotencyKey: 'submit-4' }), 'schema_invalid', 'attempt_token_required')
  // 负例：幂等键必须与凭证绑定——同 key、同请求体、只换错 token 也不能命中缓存结果。
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: 'wrong-token', content: 'v1', idempotencyKey: 'submit-1' }), 'attempt_invalid', 'attempt_token_mismatch')
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: 'wrong-token', content: 'v2-different-body', idempotencyKey: 'submit-2' }), 'attempt_invalid', 'attempt_token_mismatch')
  need(service.state().jobs.length === 1, `a rejected submit must not create a job, got ${service.state().jobs.length}`)
  need(service.state().jobs[0].jobRef === first.jobRef, 'the bound job must stay bound to the same attempt')
  return { jobRef: first.jobRef }
})

// S5 调用重放：同 key 同请求返回原结果，同 key 不同请求拒绝。
check('S5', 'idempotency replays the same request and rejects a different body', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s5' })
  const first = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'same', idempotencyKey: 'replay-key' })
  const replay = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'same', idempotencyKey: 'replay-key' })
  need(replay.replayed === true, 'the replay must be marked replayed')
  need(replay.jobRef === first.jobRef, 'the replay must return the original jobRef')
  need(replay.operationId === first.operationId, 'the replay must return the original operationId')
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'changed', idempotencyKey: 'replay-key' }), 'schema_invalid', 'idempotency_conflict')
  // 重放路径同样不能绕过凭证：同 key 同请求体、只换错 token，必须拒绝而不是回放。
  expectError(() => service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: 'wrong-token', content: 'same', idempotencyKey: 'replay-key' }), 'attempt_invalid', 'attempt_token_mismatch')
  need(service.state().jobs.length === 1, 'conflicting replay must not create a second job')
  return {}
})

// S6 受理不明先对账：未知期间再提交只拿回原 jobRef；对账为未执行后才允许新的 attempt/job。
check('S6', 'an unknown acceptance must be reconciled before any retry', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s6' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'maybe executed', idempotencyKey: 'submit-1' })
  const executed = service.host.executeJob(submitted.jobRef, { outcome: 'outcome_unknown' })
  need(executed.status === 'outcome_unknown', `expected outcome_unknown, got ${executed.status}`)
  const job = service.getJob({ principal: 'node-1', jobRef: submitted.jobRef })
  need(job.status === 'outcome_unknown', 'job_get must surface outcome_unknown')
  need(job.nextAction === 'reconcile', `nextAction should be reconcile, got ${job.nextAction}`)
  const retried = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'retry', idempotencyKey: 'submit-2' })
  need(retried.jobRef === submitted.jobRef, 'retry before reconcile must reuse the same jobRef')
  need(retried.nextAction === 'reconcile', 'retry before reconcile must ask for reconciliation')
  need(service.state().metrics.hostExecutions === 1, 'no second execution before reconciliation')
  const reconciled = service.host.reconcileJob(submitted.jobRef, 'not_executed')
  need(reconciled.status === 'cancelled', `not_executed should close the job, got ${reconciled.status}`)
  const afterReconcile = service.getJob({ principal: 'node-1', jobRef: submitted.jobRef })
  need(afterReconcile.nextAction === 'none', 'a reconciled job must not keep asking for reconciliation')
  need(runStatus(kernel, 'run-s6').status === 'paused', 'not_executed must leave the run paused for an explicit resume')
  service.commandRun({ principal: 'ui-1', runId: 'run-s6', command: 'resume', expectedRevision: revision(kernel, 'run-s6'), idempotencyKey: 'resume-1' })
  const next = service.host.claimRun('run-s6')
  need(next.attemptId !== claim.attemptId, 'resume must start a fresh attempt')
  service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId: 'p1', runIds: ['run-s6'], attemptIds: [next.attemptId] })
  const fresh = service.submitOutput({ principal: 'node-1', attemptId: next.attemptId, token: next.token, content: 'fresh', idempotencyKey: 'submit-3' })
  need(fresh.jobRef !== submitted.jobRef, 'a new attempt must get a new jobRef')
  return { oldJob: submitted.jobRef, newJob: fresh.jobRef }
})

// S7 对账为已执行：补采用产物，不重复执行；产物缺失时拒绝冒充成功。
check('S7', 'reconciling as executed adopts the produced artifact without re-executing', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s7' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'produced but ack lost', idempotencyKey: 'submit-1' })
  service.host.executeJob(submitted.jobRef, { outcome: 'outcome_unknown', withArtifact: true })
  const reconciled = service.host.reconcileJob(submitted.jobRef, 'executed')
  need(reconciled.status === 'succeeded', `expected succeeded, got ${reconciled.status}`)
  need(service.state().metrics.hostExecutions === 1, `reconciliation must not execute again, hostExecutions=${service.state().metrics.hostExecutions}`)
  need(kernel.query('SELECT id FROM workflow_snapshots').length === 1, 'the produced artifact must be adopted exactly once')
  need(runStatus(kernel, 'run-s7').status === 'paused', 'a reconciled unknown still waits for an explicit resume')
  service.commandRun({ principal: 'ui-1', runId: 'run-s7', command: 'resume', expectedRevision: revision(kernel, 'run-s7'), idempotencyKey: 'resume-s7' })
  need(runStatus(kernel, 'run-s7').status === 'completed', 'explicit resume converges the reconciled run')

  const claim2 = scene({ kernel, service, runId: 'run-s7b', productId: 'p1' })
  const second = service.submitOutput({ principal: 'node-1', attemptId: claim2.attemptId, token: claim2.token, content: 'lost', idempotencyKey: 'submit-7b' })
  service.host.executeJob(second.jobRef, { outcome: 'outcome_unknown' })
  expectError(() => service.host.reconcileJob(second.jobRef, 'executed'), 'artifact_missing', 'reconcile_artifact_missing')
  need(service.getJob({ principal: 'node-1', jobRef: second.jobRef }).status === 'outcome_unknown', 'a failed reconciliation must not claim success')
  return {}
})

// S8 下载失败不重复提交：取件失败只影响这次取件，作业与产物不变。
check('S8', 'a failed download never resubmits the generation job', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s8' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'artifact body', idempotencyKey: 'submit-1' })
  service.host.executeJob(submitted.jobRef)
  const failed = service.downloadArtifact({ principal: 'node-1', jobRef: submitted.jobRef, failOnce: true })
  need(failed.status === 'failed', `first download should fail, got ${failed.status}`)
  need(failed.nextAction === 'retry_download', `expected retry_download, got ${failed.nextAction}`)
  const retried = service.downloadArtifact({ principal: 'node-1', jobRef: submitted.jobRef })
  need(retried.status === 'completed', `retry download should succeed, got ${retried.status}`)
  need(retried.artifact.content === 'artifact body', 'retry download must return the same artifact')
  need(service.state().metrics.hostExecutions === 1, `download retry must not re-execute, hostExecutions=${service.state().metrics.hostExecutions}`)
  need(service.state().jobs.length === 1, 'download retry must not create a job')
  need(service.state().jobs[0].downloads === 2, `expected 2 download attempts, got ${service.state().jobs[0].downloads}`)
  return { contentHash: retried.artifact.contentHash }
})

// S9 取消以宿主确认为准：受理后是 cancelling，未确认不能当已取消；重复取消不再请求宿主。
check('S9', 'cancellation is only final after host confirmation', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s9' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'to cancel', idempotencyKey: 'submit-1' })
  const requested = service.cancelJob({ principal: 'node-1', jobRef: submitted.jobRef, idempotencyKey: 'cancel-1' })
  need(requested.status === 'cancelling', `expected cancelling, got ${requested.status}`)
  need(requested.nextAction === 'await_host_confirmation', 'cancel must wait for host confirmation')
  const pending = service.getJob({ principal: 'node-1', jobRef: submitted.jobRef })
  need(pending.status === 'cancelling', `job_get should show cancelling, got ${pending.status}`)
  const repeated = service.cancelJob({ principal: 'node-1', jobRef: submitted.jobRef, idempotencyKey: 'cancel-1' })
  need(repeated.replayed === true, 'repeating the same cancel must replay')
  need(service.state().jobs[0].cancelRequests === 1, `duplicate cancel must not re-request, got ${service.state().jobs[0].cancelRequests}`)
  const confirmed = service.host.confirmJobCancel(submitted.jobRef, true)
  need(confirmed.status === 'cancelled', `expected cancelled, got ${confirmed.status}`)
  need(service.state().metrics.hostExecutions === 0, 'a cancelled job must never execute')
  const late = service.host.executeJob(submitted.jobRef)
  need(late.status === 'cancelled', 'executing a cancelled job must not succeed')
  need(service.state().metrics.hostExecutions === 0, 'late execution after cancel must not count')
  return {}
})

// S10 取消未确认 → 未知，不能当失败或成功；对账后才收敛；成功后取消不得回退。
check('S10', 'an unconfirmed cancel becomes unknown and a succeeded job cannot be cancelled', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s10' })
  const first = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'x', idempotencyKey: 'submit-1' })
  service.cancelJob({ principal: 'node-1', jobRef: first.jobRef, idempotencyKey: 'cancel-1' })
  const unconfirmed = service.host.confirmJobCancel(first.jobRef, false)
  need(unconfirmed.status === 'outcome_unknown', `host refusal should leave outcome_unknown, got ${unconfirmed.status}`)
  expectError(() => service.host.reconcileJob(first.jobRef, 'bogus'), 'schema_invalid', 'reconcile_outcome_invalid')
  service.host.reconcileJob(first.jobRef, 'not_executed')

  const claim2 = scene({ kernel, service, runId: 'run-s10b', productId: 'p1' })
  const second = service.submitOutput({ principal: 'node-1', attemptId: claim2.attemptId, token: claim2.token, content: 'done', idempotencyKey: 'submit-10b' })
  service.host.executeJob(second.jobRef)
  const afterSuccess = service.cancelJob({ principal: 'node-1', jobRef: second.jobRef, idempotencyKey: 'cancel-2' })
  need(afterSuccess.status === 'succeeded', `cancelling a succeeded job must not downgrade it, got ${afterSuccess.status}`)
  need(service.downloadArtifact({ principal: 'node-1', jobRef: second.jobRef }).status === 'completed', 'the succeeded artifact stays downloadable')
  return {}
})

// S11 运行取消边界：未开始的作业作废、已发起的转未知待对账；迟到成功不复活运行。
check('S11', 'run cancellation settles queued and in-flight jobs without reviving the run', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s11' })
  const queued = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'queued', idempotencyKey: 'submit-1' })
  service.commandRun({ principal: 'ui-1', runId: 'run-s11', command: 'cancel', expectedRevision: revision(kernel, 'run-s11'), idempotencyKey: 'cancel-run' })
  need(runStatus(kernel, 'run-s11').status === 'cancelled', 'the run must be cancelled')
  need(service.getJob({ principal: 'node-1', jobRef: queued.jobRef }).status === 'cancelled', 'a queued job must be voided')
  const late = service.host.executeJob(queued.jobRef)
  need(late.status === 'cancelled', 'executing after run cancellation must not succeed')
  need(service.state().metrics.hostExecutions === 0, 'no host execution after cancellation')

  const claim2 = scene({ kernel, service, runId: 'run-s11b', productId: 'p1' })
  const inflight = service.submitOutput({ principal: 'node-1', attemptId: claim2.attemptId, token: claim2.token, content: 'inflight', idempotencyKey: 'submit-11b' })
  service.host.executeJob(inflight.jobRef, { outcome: 'outcome_unknown', withArtifact: true })
  service.commandRun({ principal: 'ui-1', runId: 'run-s11b', command: 'cancel', expectedRevision: revision(kernel, 'run-s11b'), idempotencyKey: 'cancel-run-11b' })
  need(runStatus(kernel, 'run-s11b').status === 'cancelled', 'the run with an unknown in-flight job must be cancelled')
  const reconciled = service.host.reconcileJob(inflight.jobRef, 'executed')
  need(reconciled.status !== 'succeeded', `a late success must not be adopted, got ${reconciled.status}`)
  need(kernel.query('SELECT id FROM workflow_snapshots').length === 0, 'a cancelled run must not gain a snapshot from a late success')
  need(runStatus(kernel, 'run-s11b').status === 'cancelled', 'the cancelled run must stay cancelled')
  return {}
})

// S12 运行控制：pause 需 expectedRevision；暂停中不能再领；resume 才恢复；重复命令幂等。
check('S12', 'run commands require expectedRevision and pause blocks claiming', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s12', nodeId: 'a' })
  expectError(() => service.commandRun({ principal: 'ui-1', runId: 'run-s12', command: 'pause', expectedRevision: revision(kernel, 'run-s12') + 5, idempotencyKey: 'p1' }), 'schema_invalid', 'expected_revision_mismatch')
  const pauseRevision = revision(kernel, 'run-s12')
  const paused = service.commandRun({ principal: 'ui-1', runId: 'run-s12', command: 'pause', expectedRevision: pauseRevision, idempotencyKey: 'p2' })
  need(paused.status === 'paused', `expected paused, got ${paused.status}`)
  let blocked = null
  try { service.host.claimRun('run-s12') } catch (error) { blocked = error.code }
  need(blocked === 'run_paused', `claim during a pause must fail with run_paused, got ${blocked}`)
  const repeated = service.commandRun({ principal: 'ui-1', runId: 'run-s12', command: 'pause', expectedRevision: pauseRevision, idempotencyKey: 'p2' })
  need(repeated.status === 'paused', 'pausing twice must stay paused')
  need(repeated.replayed === true, 'repeating the same pause request replays the previous operation')
  const resumed = service.commandRun({ principal: 'ui-1', runId: 'run-s12', command: 'resume', expectedRevision: revision(kernel, 'run-s12'), idempotencyKey: 'p4' })
  need(['running', 'created'].includes(resumed.status), `resume should return running, got ${resumed.status}`)
  return {}
})

// S13 人工等待：节点 Agent 只能看不能确认；ui 确认后运行回到 running；待办列表按 run 过滤。
check('S13', 'human waiting is read-only for agents and resolves on the ui channel', ({ kernel, service }) => {
  service.registerPrincipal({ id: 'ui-1', kind: 'ui', productId: 'p1' })
  service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId: 'p1' })
  service.startRun({ principal: 'ui-1', idempotencyKey: 'start-s13', runId: 'run-s13', productId: 'p1', steps: [human('human.edit-confirm'), auto('b')] })
  const claim = service.host.claimRun('run-s13')
  service.registerPrincipal({ id: 'node-1b', kind: 'node-agent', productId: 'p1', runIds: ['run-s13'], attemptIds: [] })
  const listed = service.listHumanTasks({ principal: 'node-1b' })
  need(listed.tasks.length === 1, `agent should see one authorized task, got ${listed.tasks.length}`)
  need(listed.tasks[0].status === 'open', 'the task must be open')
  const before = service.getRun({ principal: 'ui-1', runId: 'run-s13' })
  need(before.run.status === 'waiting_review', `expected waiting_review, got ${before.run.status}`)
  let blocked = null
  try { service.host.claimRun('run-s13') } catch (error) { blocked = error.code }
  need(blocked === 'run_waiting_review', `claim during a human wait must fail with run_waiting_review, got ${blocked}`)
  service.confirmHumanTask({
    principal: 'ui-1', taskId: claim.taskId, content: 'edited by human',
    inputFingerprint: kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claim.taskId).input_hash,
    expectedRunRevision: revision(kernel, 'run-s13'), expectedBindingVersion: kernel.inputBindingFor(claim.taskId).version,
    idempotencyKey: 'confirm-s13',
  })
  const after = service.getRun({ principal: 'ui-1', runId: 'run-s13' })
  need(['running', 'completed'].includes(after.run.status), `expected running/completed after confirmation, got ${after.run.status}`)
  const next = service.host.claimRun('run-s13')
  need(next.kind === 'automatic', 'the following step must be claimable after confirmation')
  return {}
})

// S14 产品隔离与只读：其它产品的 Agent 看不到本 run；写能力一律拒绝。
check('S14', 'product isolation and read-only access for other agents', ({ kernel, service }) => {
  scene({ kernel, service, runId: 'run-s14', productId: 'p1' })
  const foreign = service.registerPrincipal({ id: 'other-2', kind: 'other-agent', productId: 'p2' })
  need(foreign.kind === 'other-agent', 'registering another product agent should succeed')
  expectError(() => service.getRun({ principal: 'other-2', runId: 'run-s14' }), 'artifact_missing', 'run_not_found')
  service.registerPrincipal({ id: 'other-3', kind: 'other-agent', productId: 'p1' })
  const sameProduct = service.getRun({ principal: 'other-3', runId: 'run-s14' })
  need(sameProduct.run.id === 'run-s14', 'same-product agent may read the run')
  expectError(() => service.listArtifacts({ principal: 'other-3', runId: 'run-s14' }), 'capability_unavailable', 'other-agent_may_not_read.artifact')
  return {}
})

// S15 事件分页：cursor 有界、seq 单调、不重复、不遗漏。
check('S15', 'events page with a bounded cursor without duplicates', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s15' })
  for (let index = 1; index <= 5; index += 1) {
    service.reportProgress({ principal: 'node-1', attemptId: claim.attemptId, idempotencyKey: `progress-${index}`, percent: index * 10, note: `step ${index}` })
  }
  const first = service.listEvents({ principal: 'ui-1', runId: 'run-s15', cursor: 0, limit: 3 })
  need(first.events.length === 3, `expected 3 events, got ${first.events.length}`)
  need(first.hasMore === true, 'the first page must report more events')
  need(Number.isInteger(first.nextCursor), 'the first page must return an explicit cursor')
  const second = service.listEvents({ principal: 'ui-1', runId: 'run-s15', cursor: first.nextCursor, limit: 50 })
  need(second.hasMore === false, 'the second page must be the tail')
  const seqs = [...first.events, ...second.events].map(event => event.seq)
  need(seqs.length === new Set(seqs).size, `duplicate seq in pages: ${seqs.join(',')}`)
  need(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]), `seq must be strictly increasing: ${seqs.join(',')}`)
  const progressEvents = [...first.events, ...second.events].filter(event => event.type === 'attempt.progress')
  need(progressEvents.length === 5, `expected 5 progress events, got ${progressEvents.length}`)
  const replay = service.reportProgress({ principal: 'node-1', attemptId: claim.attemptId, idempotencyKey: 'progress-1', percent: 10, note: 'step 1' })
  need(replay.replayed === true, 'a repeated progress report must replay')
  const afterReplay = service.listEvents({ principal: 'ui-1', runId: 'run-s15', cursor: 0, limit: 100 })
  need(afterReplay.events.filter(event => event.type === 'attempt.progress').length === 5, 'a replayed progress report must not append a duplicate event')
  return { pages: [first.events.length, second.events.length] }
})

// S16 必需发布：发布未完成时运行不能完成；发布失败暂停；scheduler 发布成功后收敛。
check('S16', 'required publish gates run completion through the fake service', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s16', target: 'pd:fixture-svc' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'published candidate', target: 'pd:fixture-svc', idempotencyKey: 'submit-1' })
  const executed = service.host.executeJob(submitted.jobRef)
  need(typeof executed.outboxId === 'string', 'a targeted adoption must create an outbox item')
  const waiting = service.getRun({ principal: 'ui-1', runId: 'run-s16' })
  need(waiting.run.status === 'running', `a pending required publish must keep the run running, got ${waiting.run.status}`)
  const publishTarget = fixtureTarget('pd:fixture-svc')
  const published = service.host.publish({ principal: 'sched-1', outboxId: executed.outboxId, status: 'succeeded', observe: publishTarget.observe })
  need(published.runStatus === 'completed', `expected completed after publish, got ${published.runStatus}`)

  const claim2 = scene({ kernel, service, runId: 'run-s16b', productId: 'p1', target: 'pd:fixture-svc-2' })
  const second = service.submitOutput({ principal: 'node-1', attemptId: claim2.attemptId, token: claim2.token, content: 'publish will fail', target: 'pd:fixture-svc-2', idempotencyKey: 'submit-16b' })
  const executed2 = service.host.executeJob(second.jobRef)
  const failed = service.host.publish({ principal: 'sched-1', outboxId: executed2.outboxId, status: 'failed', reason: 'fake writer rejected', observe: fixtureTarget('pd:fixture-svc-2').observe })
  need(failed.runStatus === 'paused', `expected paused after a failed publish, got ${failed.runStatus}`)
  need(runStatus(kernel, 'run-s16b').pause_reason === 'publish_failed', 'the pause reason must be publish_failed')
  return {}
})

// S17 结构性边界：Agent 侧没有对账 / 确认 / 发布入口，只有宿主对象持有（G-10）。
check('S17', 'host-only operations are absent from the tool surface', ({ kernel, service }) => {
  for (const name of ['reconcileJob', 'confirmJobCancel', 'executeJob', 'publish']) {
    need(typeof service[name] === 'undefined', `${name} must not exist on the tool surface`)
    need(typeof service.host[name] === 'function', `${name} must exist on the host-side object`)
  }
  for (const code of ['attempt_invalid', 'schema_invalid', 'artifact_missing', 'outcome_unknown', 'capability_unavailable']) {
    need(SERVICE_ERROR_CODES.includes(code), `${code} must be in the frozen code list`)
  }
  service.registerPrincipal({ id: 'ui-1', kind: 'ui', productId: 'p1' })
  expectError(() => service.getJob({ principal: 'ui-1', jobRef: 'job-unknown' }), 'attempt_invalid', 'job_not_found')
  return { frozenCodes: SERVICE_ERROR_CODES.length }
})

// S18 权限矩阵自检：所有 deny 格必须真的被拒绝（逐格用一次性 principal 验证）。
check('S18', 'every deny cell in the permission matrix is enforced', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s18' })
  const probes = {
    'read.run': principal => service.getRun({ principal, runId: 'run-s18' }),
    'read.artifact': principal => service.listArtifacts({ principal, runId: 'run-s18' }),
    'read.events': principal => service.listEvents({ principal, runId: 'run-s18' }),
    'submit.output': principal => service.submitOutput({ principal, attemptId: claim.attemptId, token: claim.token, content: 'x', idempotencyKey: `k-${principal}` }),
    'report.progress': principal => service.reportProgress({ principal, attemptId: claim.attemptId, idempotencyKey: `p-${principal}`, percent: 1 }),
    'control.run': principal => service.commandRun({ principal, runId: 'run-s18', command: 'pause', expectedRevision: revision(kernel, 'run-s18'), idempotencyKey: `c-${principal}` }),
    'confirm.human': principal => service.confirmHumanTask({ principal, taskId: 'x', content: 'y', idempotencyKey: `h-${principal}` }),
    'read.job': principal => service.getJob({ principal, jobRef: 'job-unknown' }),
    'publish.official': principal => service.host.publish({ principal, outboxId: 'x' }),
    'write.direct': () => {
      need(typeof service.writeDirect !== 'function', 'the tool surface must not offer a direct notes write')
      throw Object.assign(new Error('capability_unavailable:write_direct_absent'), { code: 'capability_unavailable' })
    },
  }
  let deniedCells = 0
  for (const [kind, table] of Object.entries(PERMISSIONS)) {
    for (const [capability, level] of Object.entries(table)) {
      if (level !== 'deny') continue
      const principal = `probe-${kind}-${capability}`
      service.registerPrincipal({ id: principal, kind, productId: 'p1', runIds: ['run-s18'], attemptIds: [claim.attemptId] })
      const probe = probes[capability]
      need(typeof probe === 'function', `missing probe for ${capability}`)
      let rejected = null
      try {
        probe(principal)
      } catch (error) {
        rejected = error.code
      }
      need(rejected === 'capability_unavailable', `${kind}:${capability} is marked deny but was allowed (${rejected})`)
      deniedCells += 1
    }
  }
  need(deniedCells > 0, 'the matrix must contain deny cells')
  return { deniedCells }
})

// S19 读接口的凭证先于对象解析：未认证的 http-client 不能用 run/job 是否存在去探测对象。
check('S19', 'read endpoints check the session credential before resolving the object', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s19' })
  service.registerPrincipal({ id: 'ui-2', kind: 'ui', productId: 'p2' })
  service.startRun({ principal: 'ui-2', idempotencyKey: 'start-s19b', runId: 'run-s19b', productId: 'p2', steps: [auto('b')] })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'for job probe', idempotencyKey: 'submit-s19' })
  const probe = fn => {
    try { fn() } catch (error) { return { code: error.code, detail: error.detail } }
    return { ok: true }
  }
  const unauthorizedReads = [
    ['getRun', runId => probe(() => service.getRun({ principal: 'http-1', runId, credential: null }))],
    ['listArtifacts', runId => probe(() => service.listArtifacts({ principal: 'http-1', runId, credential: null }))],
    ['listEvents', runId => probe(() => service.listEvents({ principal: 'http-1', runId, credential: null }))],
    ['readArtifact', runId => probe(() => service.readArtifact({ principal: 'http-1', runId, snapshotId: 'snap-x', credential: null }))],
  ]
  const sameRejection = []
  for (const [name, read] of unauthorizedReads) {
    // 同产品已存在 run、跨产品已存在 run、完全不存在的 run，未认证时必须得到同一拒绝。
    const existing = read('run-s19')
    const absent = read('run-s19-absent')
    const otherProduct = read('run-s19b')
    need(existing.code === 'capability_unavailable' && existing.detail === 'credential_required',
      `${name} on an existing run must be rejected as credential_required, got ${JSON.stringify(existing)}`)
    need(JSON.stringify(existing) === JSON.stringify(absent),
      `${name} must not reveal whether a run exists: ${JSON.stringify(existing)} vs ${JSON.stringify(absent)}`)
    need(JSON.stringify(existing) === JSON.stringify(otherProduct),
      `${name} must not reveal another product's run either: ${JSON.stringify(existing)} vs ${JSON.stringify(otherProduct)}`)
    // 错凭证与缺凭证同一拒绝，不能区分“猜中了会话凭证”。
    const wrong = probe(() => service.getRun({ principal: 'http-1', runId: 'run-s19', credential: 'wrong-session' }))
    need(JSON.stringify(wrong) === JSON.stringify(existing), `${name} must treat a wrong credential like a missing one`)
    sameRejection.push(name)
  }
  need(sameRejection.length === unauthorizedReads.length, 'every read endpoint must be covered')
  // 作业读取同理：jobRef 不存在与存在，对未认证者一致。
  const jobMissing = probe(() => service.getJob({ principal: 'http-1', jobRef: 'job-unknown', credential: null }))
  const jobExisting = probe(() => service.getJob({ principal: 'http-1', jobRef: submitted.jobRef, credential: null }))
  need(JSON.stringify(jobMissing) === JSON.stringify(jobExisting), `job reads must not reveal existence: ${JSON.stringify(jobMissing)} vs ${JSON.stringify(jobExisting)}`)
  need(jobMissing.detail === 'credential_required', `expected credential_required, got ${JSON.stringify(jobMissing)}`)
  // 控制命令同样先认证再解析 run。
  const commandProbe = probe(() => service.commandRun({ principal: 'http-1', runId: 'run-s19-absent', command: 'pause', expectedRevision: 1, idempotencyKey: 'k-s19', credential: null }))
  need(commandProbe.detail === 'credential_required', `control must require the credential before resolving the run, got ${JSON.stringify(commandProbe)}`)
  // 认证通过后：本产品可读；缺失 run 与跨产品 run 同码（第十四轮统一口径）。
  const authorized = service.getRun({ principal: 'http-1', runId: 'run-s19', credential: 'sess-1' })
  need(authorized.run.id === 'run-s19', 'an authenticated session must still read its own product run')
  expectError(() => service.getRun({ principal: 'http-1', runId: 'run-s19-absent', credential: 'sess-1' }), 'artifact_missing', 'run_not_found')
  expectError(() => service.getRun({ principal: 'http-1', runId: 'run-s19b', credential: 'sess-1' }), 'artifact_missing', 'run_not_found')
  need(service.getJob({ principal: 'http-1', jobRef: submitted.jobRef, credential: 'sess-1' }).jobRef === submitted.jobRef, 'an authenticated session must still read its job')
  return { endpoints: unauthorizedReads.length }
})

// S20 受限身份与待办列表不得泄露对象存在性：scoped 的 node-agent 对「未授权但存在」与
// 「不存在」必须同一拒绝；p2 的 UI 不得从 listHumanTasks 拿到 p1 的待办（G-01）。
check('S20', 'scoped identities and the task list never reveal another product or a missing object', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s20' })
  // p1 另有一个 node-1 未被授权的 run，以及一个跨产品的 run。
  service.startRun({ principal: 'ui-1', idempotencyKey: 'start-s20b', runId: 'run-s20-foreign', productId: 'p1', steps: [auto('b')] })
  // 跨产品 run 必须由 p2 自己的 UI 建，任何产品都不能替别的产品建运行。
  service.registerPrincipal({ id: 'ui-2', kind: 'ui', productId: 'p2' })
  service.startRun({ principal: 'ui-2', idempotencyKey: 'start-s20c', runId: 'run-s20-other', productId: 'p2', steps: [auto('c')] })
  // p1 的人工待办，p2 的 UI 绝不能看见。
  service.startRun({ principal: 'ui-1', idempotencyKey: 'start-s20d', runId: 'run-s20-human', productId: 'p1', steps: [human('human.edit-confirm')] })
  service.host.claimRun('run-s20-human')

  // (1) 待办列表：产品边界对所有身份生效，不只在 other-agent 上。
  const p1Tasks = service.listHumanTasks({ principal: 'ui-1' })
  need(p1Tasks.tasks.length === 1, `p1 ui must see exactly its own human task, got ${JSON.stringify(p1Tasks.tasks)}`)
  need(p1Tasks.tasks[0].run_id === 'run-s20-human', `p1 ui must see run-s20-human, got ${p1Tasks.tasks[0].run_id}`)
  const p2Tasks = service.listHumanTasks({ principal: 'ui-2', productId: 'p2' })
  need(p2Tasks.tasks.length === 0, `p2 ui must not see p1 tasks, got ${JSON.stringify(p2Tasks.tasks)}`)
  const p2TasksIgnoringParam = service.listHumanTasks({ principal: 'ui-2' })
  need(p2TasksIgnoringParam.tasks.length === 0, `p2 ui must not see p1 tasks without an explicit productId either`)

  // (2) scoped node-agent：未授权但存在的 run 与不存在的 run，五个入口同一拒绝。
  const probe = (fn) => { try { fn() } catch (error) { return { code: error.code, detail: error.detail } } return { ok: true } }
  const entries = [
    ['getRun', runId => probe(() => service.getRun({ principal: 'node-1', runId }))],
    ['listArtifacts', runId => probe(() => service.listArtifacts({ principal: 'node-1', runId }))],
    ['readArtifact', runId => probe(() => service.readArtifact({ principal: 'node-1', runId, snapshotId: 'snap-x' }))],
    ['listEvents', runId => probe(() => service.listEvents({ principal: 'node-1', runId }))],
    ['commandRun', runId => probe(() => service.commandRun({ principal: 'node-1', runId, command: 'pause', expectedRevision: 1, idempotencyKey: `p-${runId}` }))],
  ]
  for (const [name, entry] of entries) {
    const foreign = entry('run-s20-foreign')
    const absent = entry('run-s20-absent')
    const otherProduct = entry('run-s20-other')
    need(foreign.code === 'capability_unavailable' && foreign.detail === 'run_not_authorized',
      `${name} on an ungranted run must be run_not_authorized, got ${JSON.stringify(foreign)}`)
    need(JSON.stringify(foreign) === JSON.stringify(absent),
      `${name} must not distinguish an ungranted run from a missing one: ${JSON.stringify(foreign)} vs ${JSON.stringify(absent)}`)
    need(JSON.stringify(foreign) === JSON.stringify(otherProduct),
      `${name} must reject a foreign product's run the same way: ${JSON.stringify(foreign)} vs ${JSON.stringify(otherProduct)}`)
  }

  // (3) 作业读取与取消：未知 jobRef 与别人的 jobRef 同一拒绝，不能当存在性预言机。
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'mine', idempotencyKey: 'submit-s20' })

  const jobUnknown = probe(() => service.getJob({ principal: 'node-1', jobRef: 'job-does-not-exist' }))
  const jobMine = probe(() => service.getJob({ principal: 'node-1', jobRef: submitted.jobRef }))
  need(jobMine.ok === true, `an authorized agent must still read its own job, got ${JSON.stringify(jobMine)}`)
  need(jobUnknown.code === 'capability_unavailable' && jobUnknown.detail === 'run_not_authorized',
    `an unknown jobRef must look unauthorized to a scoped caller, got ${JSON.stringify(jobUnknown)}`)
  const cancelUnknown = probe(() => service.cancelJob({ principal: 'node-1', jobRef: 'job-does-not-exist', idempotencyKey: 'k-s20' }))
  const cancelMine = probe(() => service.cancelJob({ principal: 'node-1', jobRef: submitted.jobRef, idempotencyKey: 'k-s20b' }))
  need(cancelMine.ok === true, `an authorized agent must still cancel its own job, got ${JSON.stringify(cancelMine)}`)
  need(JSON.stringify(cancelUnknown) === JSON.stringify(jobUnknown),
    `cancel must reject an unknown jobRef exactly like get does: ${JSON.stringify(cancelUnknown)} vs ${JSON.stringify(jobUnknown)}`)

  // (4) 授权路径不受影响：自己的 run / 自己的待办仍可读写。
  need(service.getRun({ principal: 'node-1', runId: 'run-s20' }).run.id === 'run-s20', 'the granted run stays readable')
  need(service.listArtifacts({ principal: 'node-1', runId: 'run-s20' }).artifacts.length >= 0, 'the granted run stays listable')
  return { entries: entries.length }
})

// S21 会话凭证必须在控制入口同样透传：能读自己 job 的 http-client，必须能用同一凭证取消它。
// 缺/错凭证、未知 jobRef 一律先被凭证边界挡住，node-agent 的 scoped 路径不退化。
check('S21', 'cancelJob carries the session credential on every path', ({ kernel, service }) => {
  const claim = scene({ kernel, service, runId: 'run-s21' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'cancel me', idempotencyKey: 'submit-s21' })
  const jobRef = submitted.jobRef
  const probe = (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { code: error.code, detail: error.detail } } }

  // (1) 正常路径：同一凭证能读就能取消，没有被自己的前置判定挡住。
  need(service.getJob({ principal: 'http-1', jobRef, credential: 'sess-1' }).jobRef === jobRef, 'the authenticated session must read its job')
  const cancelled = service.cancelJob({ principal: 'http-1', jobRef, idempotencyKey: 'cancel-s21', credential: 'sess-1' })
  need(cancelled.status === 'cancelling', `an authenticated session must be able to cancel, got ${JSON.stringify(cancelled)}`)
  need(cancelled.nextAction === 'await_host_confirmation', 'cancellation must wait for the host confirmation')

  // (2) 缺/错凭证：已存在与未知 jobRef 返回同一拒绝，jobRef 不能当存在性预言机。
  const noCredentialExisting = probe(() => service.cancelJob({ principal: 'http-1', jobRef, idempotencyKey: 'cancel-s21b' }))
  const noCredentialUnknown = probe(() => service.cancelJob({ principal: 'http-1', jobRef: 'job-unknown-s21', idempotencyKey: 'cancel-s21c' }))
  const wrongCredentialExisting = probe(() => service.cancelJob({ principal: 'http-1', jobRef, idempotencyKey: 'cancel-s21d', credential: 'wrong-session' }))
  const wrongCredentialUnknown = probe(() => service.cancelJob({ principal: 'http-1', jobRef: 'job-unknown-s21', idempotencyKey: 'cancel-s21e', credential: 'wrong-session' }))
  for (const [name, result] of [['missing', noCredentialExisting], ['wrong', wrongCredentialExisting]]) {
    need(result.code === 'capability_unavailable' && result.detail === 'credential_required',
      `a ${name} credential must be credential_required, got ${JSON.stringify(result)}`)
  }
  need(JSON.stringify(noCredentialExisting) === JSON.stringify(noCredentialUnknown),
    `cancelJob must not reveal whether a jobRef exists without a credential: ${JSON.stringify(noCredentialExisting)} vs ${JSON.stringify(noCredentialUnknown)}`)
  need(JSON.stringify(wrongCredentialExisting) === JSON.stringify(wrongCredentialUnknown),
    `cancelJob must not reveal whether a jobRef exists with a wrong credential either`)
  need(JSON.stringify(noCredentialExisting) === JSON.stringify(wrongCredentialExisting),
    'missing and wrong credentials must look identical')

  // (3) 带正确凭证但 jobRef 未知：认证后的正常诊断，不影响也已认证的读取行为。
  const authenticatedUnknown = probe(() => service.cancelJob({ principal: 'http-1', jobRef: 'job-unknown-s21', idempotencyKey: 'cancel-s21f', credential: 'sess-1' }))
  need(authenticatedUnknown.code === 'attempt_invalid' && authenticatedUnknown.detail === 'job_not_found',
    `an authenticated unknown jobRef is a plain not-found, got ${JSON.stringify(authenticatedUnknown)}`)

  // (4) node-agent 的 scoped 路径不退化：授权作业可取消，未授权与未知同一拒绝。
  const second = scene({ kernel, service, runId: 'run-s21b' })
  const mine = service.submitOutput({ principal: 'node-1', attemptId: second.attemptId, token: second.token, content: 'mine', idempotencyKey: 'submit-s21b' })
  const agentCancel = service.cancelJob({ principal: 'node-1', jobRef: mine.jobRef, idempotencyKey: 'cancel-s21g' })
  need(agentCancel.status === 'cancelling', `a granted node-agent must still cancel its job, got ${JSON.stringify(agentCancel)}`)
  const agentUnknown = probe(() => service.cancelJob({ principal: 'node-1', jobRef: 'job-unknown-s21', idempotencyKey: 'cancel-s21h' }))
  need(agentUnknown.code === 'capability_unavailable' && agentUnknown.detail === 'run_not_authorized',
    `a scoped agent must get run_not_authorized for an unknown jobRef, got ${JSON.stringify(agentUnknown)}`)

  // (5) 受理只到 cancelling；作业状态仍待宿主确认，不在工具面直接翻成 cancelled。
  need(service.getJob({ principal: 'http-1', jobRef, credential: 'sess-1' }).status === 'cancelling',
    'after acceptance the job must remain cancelling until the host confirms')
  return { cancelled: cancelled.status }
})

// S22 控制入口共用同一条凭证边界：能读的会话也必须能启动/控制运行，缺凭证一律先被挡。
// 与 S21 同类：startRun 曾把 credential 吞掉，使受认证的 HTTP 会话永远报 credential_required。
check('S22', 'startRun and commandRun share the same session credential boundary', ({ kernel, service }) => {
  const probe = (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { code: error.code, detail: error.detail } } }
  service.registerPrincipal({ id: 'ui-1', kind: 'ui', productId: 'p1' })
  service.registerPrincipal({ id: 'http-1', kind: 'http-client', productId: 'p1', credential: 'sess-1' })
  const steps = [auto('fake.transform')]

  // (1) 缺/错凭证：启动被凭证边界挡住，不产生任何运行。
  const before = kernel.query('SELECT id FROM workflow_runs').length
  const noCredential = probe(() => service.startRun({ principal: 'http-1', idempotencyKey: 'start-s22a', runId: 'run-s22a', productId: 'p1', steps }))
  const wrongCredential = probe(() => service.startRun({ principal: 'http-1', idempotencyKey: 'start-s22b', runId: 'run-s22b', productId: 'p1', steps, credential: 'wrong-session' }))
  need(noCredential.code === 'capability_unavailable' && noCredential.detail === 'credential_required',
    `starting without a credential must be credential_required, got ${JSON.stringify(noCredential)}`)
  need(JSON.stringify(noCredential) === JSON.stringify(wrongCredential), 'missing and wrong credentials must look identical when starting')
  need(kernel.query('SELECT id FROM workflow_runs').length === before, 'a rejected start must not create a run')

  // (2) 正确凭证：能建运行，也能用同一凭证控制它。
  const started = service.startRun({ principal: 'http-1', idempotencyKey: 'start-s22c', runId: 'run-s22', productId: 'p1', steps, credential: 'sess-1' })
  need(started.status === 'accepted' && started.stepCount === 1, `an authenticated session must be able to start, got ${JSON.stringify(started)}`)
  const paused = service.commandRun({ principal: 'http-1', runId: 'run-s22', command: 'pause', expectedRevision: revision(kernel, 'run-s22'), idempotencyKey: 'pause-s22', credential: 'sess-1' })
  need(paused.status === 'paused', `an authenticated session must be able to pause, got ${JSON.stringify(paused)}`)
  const noCredentialPause = probe(() => service.commandRun({ principal: 'http-1', runId: 'run-s22', command: 'resume', expectedRevision: revision(kernel, 'run-s22'), idempotencyKey: 'resume-s22' }))
  need(noCredentialPause.detail === 'credential_required', `commandRun without a credential must be credential_required, got ${JSON.stringify(noCredentialPause)}`)
  const resumed = service.commandRun({ principal: 'http-1', runId: 'run-s22', command: 'resume', expectedRevision: revision(kernel, 'run-s22'), idempotencyKey: 'resume-s22b', credential: 'sess-1' })
  need(resumed.status === 'running', `an authenticated session must be able to resume, got ${JSON.stringify(resumed)}`)

  // (3) 产品边界仍在：p2 的 HTTP 会话不能替 p1 建运行（凭证有效也不行）。
  service.registerPrincipal({ id: 'http-2', kind: 'http-client', productId: 'p2', credential: 'sess-2' })
  const foreign = probe(() => service.startRun({ principal: 'http-2', idempotencyKey: 'start-s22d', runId: 'run-s22-foreign', productId: 'p1', steps, credential: 'sess-2' }))
  need(foreign.code === 'capability_unavailable' && foreign.detail === 'product_not_authorized',
    `a p2 session must not start a p1 run, got ${JSON.stringify(foreign)}`)

  // (4) 未被授予该 run 的节点 Agent 仍不能靠启动入口绕过 scoped 授权。
  service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId: 'p1', runIds: [], attemptIds: [] })
  const agentStart = probe(() => service.startRun({ principal: 'node-1', idempotencyKey: 'start-s22e', runId: 'run-s22b', productId: 'p1', steps }))
  need(agentStart.code === 'capability_unavailable', `a scoped agent must not start an unbounded run, got ${JSON.stringify(agentStart)}`)
  return { started: started.runId, resumed: resumed.status }
})

// S23 会话凭证在提交路径同样生效；jobRef 不能作跨产品存在性预言机（getJob/cancelJob/downloadArtifact 同一拒绝）。
check('S23', 'submitOutput honors the session credential and jobRef never reveals a foreign product', ({ kernel, service }) => {
  const probe = (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { code: error.code, detail: error.detail } } }
  const p1 = scene({ kernel, service, runId: 'run-s23' })
  service.registerPrincipal({ id: 'http-2', kind: 'http-client', productId: 'p2', credential: 'sess-2' })

  // (1) 正常路径：受认证的 HTTP 会话用正确凭证提交必须被受理，而不是被当成未认证。
  const submitted = service.submitOutput({
    principal: 'http-1', attemptId: p1.attemptId, token: p1.token,
    content: 'http session output', idempotencyKey: 'submit-s23', credential: 'sess-1',
  })
  need(submitted.status === 'accepted' && typeof submitted.jobRef === 'string',
    `an authenticated http session must be able to submit, got ${JSON.stringify(submitted)}`)
  const noCredentialSubmit = probe(() => service.submitOutput({
    principal: 'http-1', attemptId: p1.attemptId, token: p1.token, content: 'x', idempotencyKey: 'submit-s23b',
  }))
  need(noCredentialSubmit.code === 'capability_unavailable' && noCredentialSubmit.detail === 'credential_required',
    `submitting without the session credential must be credential_required, got ${JSON.stringify(noCredentialSubmit)}`)

  // 让作业产出物，后续下载路径可测。
  service.host.executeJob(submitted.jobRef)
  const jobRef = submitted.jobRef

  // (2) 跨产品存在性：p2 的已认证会话对 p1 现存 job 与未知 job，三条路径必须同一结果。
  const paths = [
    ['getJob', ref => probe(() => service.getJob({ principal: 'http-2', jobRef: ref, credential: 'sess-2' }))],
    ['cancelJob', ref => probe(() => service.cancelJob({ principal: 'http-2', jobRef: ref, idempotencyKey: `cancel-s23-${ref}`, credential: 'sess-2' }))],
    ['downloadArtifact', ref => probe(() => service.downloadArtifact({ principal: 'http-2', jobRef: ref, credential: 'sess-2' }))],
  ]
  for (const [name, path] of paths) {
    const foreign = path(jobRef)
    const absent = path('job-unknown-s23')
    need(foreign.code === absent.code && foreign.detail === absent.detail,
      `${name} must not distinguish a foreign job from a missing one: ${JSON.stringify(foreign)} vs ${JSON.stringify(absent)}`)
    need(!foreign.ok, `${name} on a foreign product's job must be rejected, got ${JSON.stringify(foreign)}`)
  }

  // (3) 本产品正常路径不变：读、取消、下载都通。
  const own = service.getJob({ principal: 'http-1', jobRef, credential: 'sess-1' })
  need(own.jobRef === jobRef && own.status === 'succeeded', `the owning session must still read its job, got ${JSON.stringify(own)}`)
  const download = service.downloadArtifact({ principal: 'http-1', jobRef, credential: 'sess-1' })
  need(download.status === 'completed' && download.artifact?.content === 'http session output', `the owning session must still download, got ${JSON.stringify(download)}`)
  const cancelOwn = service.cancelJob({ principal: 'http-1', jobRef, idempotencyKey: 'cancel-s23-own', credential: 'sess-1' })
  need(cancelOwn.status === 'succeeded', `cancelling an already finished job reports its state, got ${JSON.stringify(cancelOwn)}`)
  // 无凭证仍先被挡，且与未知 jobRef 同码，不会因产品不同而泄露。
  const noCredForeign = probe(() => service.getJob({ principal: 'http-2', jobRef, credential: null }))
  const noCredAbsent = probe(() => service.getJob({ principal: 'http-2', jobRef: 'job-unknown-s23', credential: null }))
  need(noCredForeign.detail === 'credential_required', `an unauthenticated caller must be credential_required, got ${JSON.stringify(noCredForeign)}`)
  need(JSON.stringify(noCredForeign) === JSON.stringify(noCredAbsent), 'unauthenticated lookups must be indistinguishable')

  // (4) scoped 边界不变：本 run 的作业可读，别的作业与未知作业同为 run_not_authorized。
  const mine = service.getJob({ principal: 'node-1', jobRef, credential: null })
  need(mine.jobRef === jobRef, `a granted node-agent must still read its job, got ${JSON.stringify(mine)}`)
  const agentForeign = probe(() => service.getJob({ principal: 'node-1', jobRef: 'job-unknown-s23' }))
  need(agentForeign.code === 'capability_unavailable' && agentForeign.detail === 'run_not_authorized',
    `a scoped agent must get run_not_authorized, got ${JSON.stringify(agentForeign)}`)
  return { jobRef }
})

// S24 G-01/G-04/G-08 目标对象入口的授权/缺失对照矩阵：对每一类身份、每一个以对象 ID 为入参的入口，
// 「跨产品现存」与「不存在」的外部响应必须完全一致；本产品正常路径、无凭证拒绝、scoped 拒绝不变，
// 真正的内部错误（越界快照、版本不符、未成功作业）不得被伪装成 404。
check('S24', 'every object entry point hides unauthorized existence behind the same response', ({ kernel, service }) => {
  const probe = (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { code: error.code, detail: error.detail } } }
  const p1 = scene({ kernel, service, runId: 'run-s24', productId: 'p1' })
  service.registerPrincipal({ id: 'ui-2', kind: 'ui', productId: 'p2' })
  service.registerPrincipal({ id: 'other-2', kind: 'other-agent', productId: 'p2' })
  service.registerPrincipal({ id: 'http-2', kind: 'http-client', productId: 'p2', credential: 'sess-2' })
  service.registerPrincipal({ id: 'sched-2', kind: 'scheduler', productId: 'p2' })
  // 一个未被授予 run-s24 的节点 Agent：它的「未授权但存在」与「不存在」也必须同码。
  service.registerPrincipal({ id: 'node-x', kind: 'node-agent', productId: 'p1', runIds: [], attemptIds: [] })

  const submitted = service.submitOutput({ principal: 'node-1', attemptId: p1.attemptId, token: p1.token, content: 'matrix', idempotencyKey: 'submit-s24' })
  service.host.executeJob(submitted.jobRef)
  const jobRef = submitted.jobRef
  // 一个跨产品的人工待办：p1 的运行停在人工节点，p2 的 UI 不能确认它，也不能凭报错判断它存在。
  service.startRun({ principal: 'ui-1', idempotencyKey: 'start-s24h', runId: 'run-s24-human', productId: 'p1', steps: [human('human.edit-confirm')] })
  const humanClaim = service.host.claimRun('run-s24-human')

  const matrix = []
  const assertHidden = (name, existing, missing, expectDetail) => {
    need(!existing.ok && !missing.ok, `${name} must reject in both cases`)
    need(existing.code === missing.code && existing.detail === missing.detail,
      `${name} must not distinguish an unauthorized object from a missing one: ${JSON.stringify(existing)} vs ${JSON.stringify(missing)}`)
    need(existing.detail === expectDetail, `${name} must use ${expectDetail}, got ${JSON.stringify(existing)}`)
    matrix.push({ entry: name, response: `${existing.code}:${existing.detail}` })
  }

  // (1) run 级入口：跨产品现存 run 与不存在 run。
  const runEntries = [
    ['getRun/ui', id => probe(() => service.getRun({ principal: 'ui-2', runId: id }))],
    ['getRun/other-agent', id => probe(() => service.getRun({ principal: 'other-2', runId: id }))],
    ['getRun/http', id => probe(() => service.getRun({ principal: 'http-2', runId: id, credential: 'sess-2' }))],
    ['getRun/scheduler', id => probe(() => service.getRun({ principal: 'sched-2', runId: id }))],
    ['listArtifacts/ui', id => probe(() => service.listArtifacts({ principal: 'ui-2', runId: id }))],
    ['listArtifacts/http', id => probe(() => service.listArtifacts({ principal: 'http-2', runId: id, credential: 'sess-2' }))],
    ['readArtifact/ui', id => probe(() => service.readArtifact({ principal: 'ui-2', runId: id, snapshotId: 'snap-x' }))],
    ['readArtifact/http', id => probe(() => service.readArtifact({ principal: 'http-2', runId: id, snapshotId: 'snap-x', credential: 'sess-2' }))],
    ['listEvents/ui', id => probe(() => service.listEvents({ principal: 'ui-2', runId: id }))],
    ['listEvents/http', id => probe(() => service.listEvents({ principal: 'http-2', runId: id, credential: 'sess-2' }))],
    ['commandRun/ui', id => probe(() => service.commandRun({ principal: 'ui-2', runId: id, command: 'pause', expectedRevision: 1, idempotencyKey: `ui-${id}` }))],
    ['commandRun/http', id => probe(() => service.commandRun({ principal: 'http-2', runId: id, command: 'pause', expectedRevision: 1, idempotencyKey: `http-${id}`, credential: 'sess-2' }))],
    ['commandRun/scheduler', id => probe(() => service.commandRun({ principal: 'sched-2', runId: id, command: 'pause', expectedRevision: 1, idempotencyKey: `sched-${id}` }))],
  ]
  for (const [name, entry] of runEntries) assertHidden(name, entry('run-s24'), entry('run-s24-absent'), 'run_not_found')

  // (2) scoped 节点 Agent：未授权但存在 与 不存在 同为 run_not_authorized。
  for (const [name, entry] of [
    ['getRun/scoped', id => probe(() => service.getRun({ principal: 'node-x', runId: id }))],
    ['listArtifacts/scoped', id => probe(() => service.listArtifacts({ principal: 'node-x', runId: id }))],
    ['readArtifact/scoped', id => probe(() => service.readArtifact({ principal: 'node-x', runId: id, snapshotId: 'snap-x' }))],
    ['listEvents/scoped', id => probe(() => service.listEvents({ principal: 'node-x', runId: id }))],
    ['commandRun/scoped', id => probe(() => service.commandRun({ principal: 'node-x', runId: id, command: 'pause', expectedRevision: 1, idempotencyKey: `nx-${id}` }))],
  ]) assertHidden(name, entry('run-s24'), entry('run-s24-absent'), 'run_not_authorized')

  // (3) job 级入口：跨产品现存 job 与未知 job。
  for (const [name, entry] of [
    ['getJob/ui', id => probe(() => service.getJob({ principal: 'ui-2', jobRef: id }))],
    ['getJob/http', id => probe(() => service.getJob({ principal: 'http-2', jobRef: id, credential: 'sess-2' }))],
    ['cancelJob/http', id => probe(() => service.cancelJob({ principal: 'http-2', jobRef: id, idempotencyKey: `c-${id}`, credential: 'sess-2' }))],
    ['downloadArtifact/http', id => probe(() => service.downloadArtifact({ principal: 'http-2', jobRef: id, credential: 'sess-2' }))],
    ['getJob/scoped', id => probe(() => service.getJob({ principal: 'node-x', jobRef: id }))],
    ['cancelJob/scoped', id => probe(() => service.cancelJob({ principal: 'node-x', jobRef: id, idempotencyKey: `cn-${id}` }))],
  ]) assertHidden(name, entry(jobRef), entry('job-absent-s24'), name.endsWith('scoped') ? 'run_not_authorized' : 'job_not_found')

  // (3b) attempt 级入口（G-04/G-05）：跨产品现存 attempt 与不存在 attempt 必须同一响应，
  //      且被拒的调用不产生作业、不写事件（无副作用）。
  // state().jobs 是数组：必须比较 length。同时做一次正向对照，证明这个计数对「新建作业」是敏感的，
  // 否则拒绝路径的断言可能因为取错字段而恒真（老大第十六轮退回点）。
  need(Array.isArray(service.state().jobs), 'state().jobs must be an array for the no-side-effect check to be meaningful')
  const jobsBefore = service.state().jobs.length
  const eventsBefore = kernel.one('SELECT COUNT(*) AS n FROM workflow_events WHERE run_id=?', 'run-s24').n
  const attemptEntries = [
    ['submitOutput/ui', id => probe(() => service.submitOutput({ principal: 'ui-2', attemptId: id, token: p1.token, content: 'alien', idempotencyKey: `ui-submit-${id}` }))],
    ['reportProgress/ui', id => probe(() => service.reportProgress({ principal: 'ui-2', attemptId: id, percent: 10, idempotencyKey: `ui-progress-${id}` }))],
    ['submitOutput/http', id => probe(() => service.submitOutput({ principal: 'http-2', attemptId: id, token: p1.token, content: 'alien', idempotencyKey: `http-submit-${id}`, credential: 'sess-2' }))],
    ['reportProgress/http', id => probe(() => service.reportProgress({ principal: 'http-2', attemptId: id, percent: 10, idempotencyKey: `http-progress-${id}`, credential: 'sess-2' }))],
  ]
  for (const [name, entry] of attemptEntries) assertHidden(name, entry(p1.attemptId), entry('attempt-absent-s24'), 'attempt_not_found')
  // 节点 Agent 的派发授权仍先于解析：未授权的现存 attempt 与不存在的 attempt 同为 attempt_not_authorized。
  for (const [name, entry] of [
    ['submitOutput/scoped', id => probe(() => service.submitOutput({ principal: 'node-x', attemptId: id, token: 'wrong-token', content: 'alien', idempotencyKey: `nx-submit-${id}` }))],
    ['reportProgress/scoped', id => probe(() => service.reportProgress({ principal: 'node-x', attemptId: id, percent: 10, idempotencyKey: `nx-progress-${id}` }))],
  ]) assertHidden(name, entry(p1.attemptId), entry('attempt-absent-s24'), 'attempt_not_authorized')
  need(service.state().jobs.length === jobsBefore, `rejected submissions must not create jobs, ${jobsBefore} -> ${service.state().jobs.length}`)
  need(kernel.one('SELECT COUNT(*) AS n FROM workflow_events WHERE run_id=?', 'run-s24').n === eventsBefore,
    'rejected progress reports must not append events')
  // 正向对照：同一个计数在合法提交后必须 +1（证明上面的「不变」不是因为计数器失效）。
  // 必须在全新 attempt 上做对照：p1 的 attempt 已在前面绑定过作业，重复提交只会复用原 jobRef。
  service.startRun({ principal: 'ui-1', idempotencyKey: 'start-s24pc', runId: 'run-s24-positive', productId: 'p1', steps: [auto('pc')] })
  const positiveClaim = service.host.claimRun('run-s24-positive')
  service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId: 'p1', runIds: ['run-s24-positive'], attemptIds: [positiveClaim.attemptId] })
  const positiveJob = service.submitOutput({ principal: 'node-1', attemptId: positiveClaim.attemptId, token: positiveClaim.token, content: 'positive-control', idempotencyKey: 'positive-s24' })
  need(service.state().jobs.length === jobsBefore + 1, `an accepted submit must be counted, ${jobsBefore} -> ${service.state().jobs.length}`)
  // 事件计数同样要有灵敏的正向对照：claimRun 已经写过 attempt.claimed，所以「总数 > 0」是空验证。
  // 必须在同一 run 上前后各取一次计数，断言恰好 +1，并且新增的那条就是 attempt.progress。
  const eventsBeforeProgress = kernel.one('SELECT COUNT(*) AS n FROM workflow_events WHERE run_id=?', 'run-s24-positive').n
  service.reportProgress({ principal: 'node-1', attemptId: positiveClaim.attemptId, percent: 5, idempotencyKey: 'positive-progress-s24' })
  const eventsAfterProgress = kernel.one('SELECT COUNT(*) AS n FROM workflow_events WHERE run_id=?', 'run-s24-positive').n
  need(eventsAfterProgress === eventsBeforeProgress + 1,
    `an accepted progress report must add exactly one event, ${eventsBeforeProgress} -> ${eventsAfterProgress}`)
  const progressEvent = kernel.one("SELECT type,payload FROM workflow_events WHERE run_id=? ORDER BY seq DESC LIMIT 1", 'run-s24-positive')
  need(progressEvent?.type === 'attempt.progress', `the new event must be attempt.progress, got ${progressEvent?.type}`)
  need(JSON.parse(progressEvent.payload).percent === 5, 'the progress event must carry the reported percent')
  need(typeof positiveJob.jobRef === 'string' && positiveJob.jobRef.length > 0, 'the positive control must return a jobRef')

  // (4) 人工待办：跨产品现存 task 与不存在 task。
  const confirmArgs = (taskId) => ({
    principal: 'ui-2', taskId, content: 'p2 tries to confirm p1 task',
    inputFingerprint: 'whatever', expectedRunRevision: 1, idempotencyKey: `confirm-${taskId}`,
  })
  assertHidden('confirmHumanTask/ui', probe(() => service.confirmHumanTask(confirmArgs(humanClaim.taskId))),
    probe(() => service.confirmHumanTask(confirmArgs('task-absent-s24'))), 'human_task_not_found')

  // (5) 本产品正常路径不变。
  need(service.getRun({ principal: 'ui-1', runId: 'run-s24' }).run.id === 'run-s24', 'the owning product must still read its run')
  need(service.getJob({ principal: 'ui-1', jobRef }).jobRef === jobRef, 'the owning product must still read its job')
  need(service.downloadArtifact({ principal: 'ui-1', jobRef }).artifact.content === 'matrix', 'the owning product must still download')
  need(service.listHumanTasks({ principal: 'ui-1' }).tasks.some(task => task.id === humanClaim.taskId), 'the owning product must still list its task')

  // (6) 无凭证仍然先被挡住，且与未知对象同码（不会因为对象存在与否而变化）。
  const noCredExisting = probe(() => service.getRun({ principal: 'http-2', runId: 'run-s24' }))
  const noCredAbsent = probe(() => service.getRun({ principal: 'http-2', runId: 'run-s24-absent' }))
  need(noCredExisting.detail === 'credential_required' && JSON.stringify(noCredExisting) === JSON.stringify(noCredAbsent),
    'unauthenticated run reads must be indistinguishable')

  // (7) 真实内部错误不被伪装成 404：越界快照、版本不符、未成功作业各自保留原码。
  const ownArtifacts = service.listArtifacts({ principal: 'ui-1', runId: 'run-s24' }).artifacts
  expectError(() => service.readArtifact({ principal: 'ui-1', runId: 'run-s24', snapshotId: 'snapshot-bogus' }), 'artifact_missing', 'snapshot_not_in_run')
  expectError(() => service.commandRun({ principal: 'ui-1', runId: 'run-s24', command: 'pause', expectedRevision: 999, idempotencyKey: 'bad-rev' }), 'schema_invalid', 'expected_revision_mismatch')
  need(ownArtifacts.length >= 1, `the owning run must expose its artifact, got ${JSON.stringify(ownArtifacts)}`)
  return { entries: matrix.length, matrix }
})

const failed = results.filter(result => result.status === 'fail')
const output = {
  checks: results.length,
  assertions,
  passed: results.length - failed.length,
  failed: failed.map(result => ({ id: result.id, detail: result.detail })),
  scope: 'fake business service only; temporary SQLite, temporary object root, no real HTTP, no host tool registration',
}
if (failed.length === 0) {
  for (const result of results) console.log(`ok   ${result.id} ${result.title}`)
}
console.log(JSON.stringify(output))
process.exit(failed.length === 0 ? 0 : 1)
