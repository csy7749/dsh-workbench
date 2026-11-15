// B4-2 / A10 执行前校验 + A36 人工确认语义专项验证（happy-4.1）。
// 全程临时 SQLite + 临时根目录 + 假业务服务，不碰生产库、不发 HTTP、不调真实模型、不接主运行时。
// 覆盖：schema 不兼容/越界在领取前被拒（不扣预算、不建 Attempt、不建人工待办）、重启后仍按同一 schema 校验、
//       确认继续、确认并暂停原子提交、暂停后不抢跑、暂停中确认、双窗口 CAS、幂等重放与冲突、
//       旧上游基准拒绝且草稿保留、人工步骤被上游作废后不死锁。
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkflowKernel, openWorkflowKernel, INPUT_SCHEMA_INVALID, validateInputSchema } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../src/workflow/m1-fake-service.mjs'

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
    need(error.code === code, `expected ${code} but got ${error.code ?? error.message} (${error.detail ?? error.message ?? ''})`)
    if (detail) {
      const actual = error.detail ?? error.message
      need(actual === detail, `expected detail ${detail} but got ${actual}`)
    }
    return error
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

// 夹具目标适配器：目标版本由夹具持有，领取时 observe 读夹具而不是待测 outbox 的 base_revision。
const fixtureTarget = (name, revision = 1) => {
  const state = { name, revision }
  return {
    name,
    get revision() { return state.revision },
    observe: (asked) => ({ target: asked, revision: state.revision }),
  }
}

const check = (id, title, fn) => {
  const root = mkdtempSync(join(tmpdir(), `m1-hc-${id}-`))
  const handles = []
  try {
    const dbPath = join(root, 'workflow.sqlite')
    const open = (path = dbPath) => {
      const kernel = createWorkflowKernel(new DatabaseSync(path), root)
      handles.push(kernel)
      return kernel
    }
    const openFile = (path = dbPath) => {
      const kernel = openWorkflowKernel(path, root)
      handles.push(kernel)
      return kernel
    }
    const detail = fn({ root, dbPath, open, openFile })
    results.push({ id, title, status: 'pass', detail: detail ?? null })
  } catch (error) {
    results.push({ id, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    for (const kernel of handles) { try { kernel.db.close() } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
}

const countOf = (kernel, sql, ...args) => Number(kernel.one(sql, ...args).n)

// A10 用的输入 schema：必填字符串、整数区间、禁止多余字段。越界/类型/缺字段/多余字段四类都能触发。
// 数值边界用标准关键字 minimum/maximum —— 自造的 min/max 会被方言校验拒绝（HC-11 有反例）。
const SCHEMA = {
  type: 'object',
  properties: {
    plan: { type: 'string', minLength: 1, maxLength: 40 },
    rounds: { type: 'integer', minimum: 1, maximum: 5 },
    channel: { type: 'string', enum: ['web', 'app'] },
  },
  required: ['plan'],
  additionalProperties: false,
}

// 冻结契约要求每个节点显式声明它的校验检查与发布目标：缺省空数组即「本步不发布、免检」，
// 与「没声明」是两件事（内核把后者判成 publish_declaration_missing / validation_declaration_missing）。
const AUTO = (nodeId, declarations = {}) => ({ nodeId, nodeKind: 'automatic', requiredChecks: [], publishTargets: [], ...declarations })
const HUMAN = (nodeId, declarations = {}) => ({ nodeId, nodeKind: 'human', requiredChecks: [], publishTargets: [], ...declarations })

// 领取并把整条自动步骤走完（content 决定内容，target 为空则不发发布项）。
const adoptNext = (kernel, runId, content, { target = null, required = true } = {}) => {
  const attempt = kernel.claim(runId)
  const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content })
  return kernel.adopt({ attemptId: attempt.attemptId, token: attempt.token, candidate, target, required })
}

// ---------------------------------------------------------------------------
// HC-01：A10 在领取前拒绝无效输入——预算、Attempt、人工待办都不许动
// ---------------------------------------------------------------------------
check('HC-01', 'invalid input is rejected before claim and moves nothing', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-a10', steps: [AUTO('fake.transform')], inputSchema: SCHEMA })
  const budgetBefore = Number(kernel.one('SELECT budget_used FROM workflow_runs WHERE id=?', 'run-a10').budget_used)
  const revisionBefore = Number(kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'run-a10').revision)

  expectError(() => kernel.claim('run-a10', {}), INPUT_SCHEMA_INVALID, 'plan:required')
  expectError(() => kernel.claim('run-a10', { plan: '' }), INPUT_SCHEMA_INVALID, 'plan:too_short')
  expectError(() => kernel.claim('run-a10', { plan: 'x'.repeat(41) }), INPUT_SCHEMA_INVALID, 'plan:too_long')
  expectError(() => kernel.claim('run-a10', { plan: 'ok', rounds: 9 }), INPUT_SCHEMA_INVALID, 'rounds:above_maximum')
  expectError(() => kernel.claim('run-a10', { plan: 'ok', rounds: 0 }), INPUT_SCHEMA_INVALID, 'rounds:below_minimum')
  expectError(() => kernel.claim('run-a10', { plan: 'ok', rounds: 2.5 }), INPUT_SCHEMA_INVALID, 'rounds:wrong_type')
  expectError(() => kernel.claim('run-a10', { plan: 'ok', channel: 'tv' }), INPUT_SCHEMA_INVALID, 'channel:not_in_enum')
  expectError(() => kernel.claim('run-a10', { plan: 'ok', extra: true }), INPUT_SCHEMA_INVALID, 'extra:unexpected')
  expectError(() => kernel.claim('run-a10', 'not-an-object'), INPUT_SCHEMA_INVALID, '$:not_object')

  // 八次被拒之后：预算没扣、没有 Attempt、运行状态与修订号都没动。
  need(Number(kernel.one('SELECT budget_used FROM workflow_runs WHERE id=?', 'run-a10').budget_used) === budgetBefore, 'a rejected claim must not charge budget')
  need(Number(kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'run-a10').revision) === revisionBefore, 'a rejected claim must not bump the run revision')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-a10').status === 'created', 'a rejected claim must leave the run created')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_attempts') === 0, 'a rejected claim must not create an attempt')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_human_tasks') === 0, 'a rejected claim must not create a human task')
  // 拒绝要留可审计证据，但不能因此产生预算或 Attempt。
  need(countOf(kernel, "SELECT COUNT(*) AS n FROM workflow_events WHERE type='input.rejected'") === 9, 'every rejection is recorded as an input.rejected event')
  need(countOf(kernel, "SELECT COUNT(*) AS n FROM workflow_events WHERE type='attempt.claimed'") === 0, 'no attempt event was written for a rejected claim')

  // 合法输入照常领取，且此时才开始扣预算。
  const attempt = kernel.claim('run-a10', { plan: 'launch plan', rounds: 2, channel: 'web' })
  need(attempt.kind === 'automatic', 'a valid input is claimed normally')
  need(Number(kernel.one('SELECT budget_used FROM workflow_runs WHERE id=?', 'run-a10').budget_used) === budgetBefore + 1, 'a valid claim charges exactly one budget unit')
  return { rejections: 9 }
})

// ---------------------------------------------------------------------------
// HC-02：人工步骤同样先校验——无效输入不得凭空造出人工待办
// ---------------------------------------------------------------------------
check('HC-02', 'an invalid input cannot create a human task', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-a10-human', steps: [HUMAN('human.edit-confirm')], human: true, inputSchema: SCHEMA })
  expectError(() => kernel.claim('run-a10-human', { rounds: 3 }), INPUT_SCHEMA_INVALID, 'plan:required')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_human_tasks') === 0, 'no human task may exist after a rejected claim')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-a10-human').status === 'created', 'the run stays created after a rejected human claim')
  need(Number(kernel.one('SELECT budget_used FROM workflow_runs WHERE id=?', 'run-a10-human').budget_used) === 0, 'a rejected human claim charges no budget')
  const claimed = kernel.claim('run-a10-human', { plan: 'draft copy' })
  need(claimed.kind === 'human', 'the valid input opens the human task')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_human_tasks') === 1, 'exactly one human task exists after the valid claim')
  return { taskId: claimed.taskId }
})

// ---------------------------------------------------------------------------
// HC-03：schema 跟 run 一起落库，进程重启后仍按同一份校验
// ---------------------------------------------------------------------------
check('HC-03', 'the input schema survives a restart and still gates the claim', ({ dbPath, open, openFile }) => {
  const first = open()
  first.createRun({ id: 'run-restart', steps: [AUTO('fake.transform')], inputSchema: SCHEMA })
  first.db.close()
  const second = openFile(dbPath)
  expectError(() => second.claim('run-restart', { plan: 'ok', rounds: 99 }), INPUT_SCHEMA_INVALID, 'rounds:above_maximum')
  need(second.one('SELECT status FROM workflow_runs WHERE id=?', 'run-restart').status === 'created', 'the reopened kernel still refuses the invalid input')
  const attempt = second.claim('run-restart', { plan: 'after restart' })
  need(attempt.kind === 'automatic', 'the valid input claims after a restart')
  return { status: 'ok' }
})

// ---------------------------------------------------------------------------
// HC-04：确认继续——采用与推进在同一事务，之后可正常领取后继步骤
// ---------------------------------------------------------------------------
check('HC-04', 'confirm continue adopts and lets the run continue', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-continue', steps: [HUMAN('human.edit-confirm'), AUTO('fake.transform')] })
  const claimed = kernel.claim('run-continue')
  const fingerprint = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claimed.taskId).input_hash
  const runRevision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'run-continue').revision
  const result = kernel.confirmHuman({
    taskId: claimed.taskId, content: 'human accepted copy', actorId: 'fixture-human',
    inputFingerprint: fingerprint, expectedRunRevision: runRevision, expectedTaskRevision: 1,
    expectedBindingVersion: kernel.inputBindingFor(claimed.taskId).version,
    idempotencyKey: 'confirm-continue', intent: 'continue',
  })
  need(typeof result.adoptionId === 'string', 'confirm returns the adoption id')
  need(kernel.one('SELECT status FROM workflow_human_tasks WHERE id=?', claimed.taskId).status === 'confirmed', 'the task is confirmed in the same transaction')
  need(kernel.one('SELECT confirmed_by FROM workflow_human_tasks WHERE id=?', claimed.taskId).confirmed_by === 'fixture-human', 'the confirmed actor is recorded')
  need(kernel.one('SELECT author_type FROM workflow_snapshots WHERE id=?', result.snapshotId).author_type === 'human', 'the snapshot is authored by the human')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-continue').status === 'running', 'confirm continue keeps the run running')
  const next = kernel.claim('run-continue')
  need(next.kind === 'automatic', 'the next step is claimable after a continue confirmation')
  return { adoptionId: result.adoptionId }
})

// ---------------------------------------------------------------------------
// HC-05：确认并暂停——同一事务落采用与暂停，且不自动变成功、不抢跑
// ---------------------------------------------------------------------------
check('HC-05', 'confirm and pause commits atomically and never auto-completes', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-pause', steps: [HUMAN('human.edit-confirm', { publishTargets: [{ target: 'pd:fixture-pause', required: true }] })] })
  const claimed = kernel.claim('run-pause')
  const fingerprint = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claimed.taskId).input_hash
  const runRevision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'run-pause').revision
  const result = kernel.confirmHuman({
    taskId: claimed.taskId, content: 'confirmed then paused', actorId: 'fixture-human',
    inputFingerprint: fingerprint, expectedRunRevision: runRevision, expectedTaskRevision: 1,
    expectedBindingVersion: kernel.inputBindingFor(claimed.taskId).version,
    idempotencyKey: 'confirm-pause', intent: 'pause', target: 'pd:fixture-pause',
  })
  // 采用与暂停同时存在，才叫原子提交。
  need(typeof result.adoptionId === 'string', 'the adoption is committed')
  need(kernel.one('SELECT status FROM workflow_human_tasks WHERE id=?', claimed.taskId).status === 'confirmed', 'the task is confirmed')
  const pausedRun = kernel.one('SELECT status,pause_reason FROM workflow_runs WHERE id=?', 'run-pause')
  need(pausedRun.status === 'paused', `expected paused after confirm-and-pause, got ${pausedRun.status}`)
  need(pausedRun.pause_reason === 'user_paused', 'the pause carries the explicit user reason')
  // 暂停后不得抢跑：领取被拒，且不产生新 Attempt。
  const attemptsBefore = countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_attempts')
  expectError(() => kernel.claim('run-pause'), 'run_paused')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_attempts') === attemptsBefore, 'a paused run dispatches no new attempt')
  // 必需发布随后成功，也不能把暂停中的运行改成成功（A06/A11/A36）。
  const outboxId = kernel.one('SELECT id FROM workflow_outbox WHERE adoption_id=?', result.adoptionId).id
  // 先领取再登记：结算路径拒绝未经领取的发布项，这里顺带固化该前置条件。
  const pauseTarget = fixtureTarget('pd:fixture-pause')
  expectError(() => kernel.completeOutbox(outboxId, 'succeeded'), 'outbox_not_claimed')
  const pauseClaim = kernel.claimOutbox(outboxId, { observe: pauseTarget.observe })
  kernel.completeOutbox(outboxId, 'succeeded', null, pauseClaim.claimGeneration)
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-pause').status === 'paused', 'a successful publish must not complete a user-paused run')
  // 只有显式 resume 才继续，并在此时收敛为 completed。
  const resumed = kernel.resume('run-pause')
  need(resumed.status === 'completed', `expected completed after an explicit resume, got ${resumed.status}`)
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-pause').status === 'completed', 'completion happens only after the explicit resume')
  return { adoptionId: result.adoptionId, outboxId }
})

// ---------------------------------------------------------------------------
// HC-06：暂停中确认——采用落地但运行保持暂停；双窗口只有一个赢家
// ---------------------------------------------------------------------------
check('HC-06', 'confirming while paused keeps the run paused and two windows cannot both confirm', ({ open }) => {
  const kernelA = open()
  kernelA.createRun({ id: 'run-two', steps: [HUMAN('human.edit-confirm')] })
  const claimed = kernelA.claim('run-two')
  const fingerprint = kernelA.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claimed.taskId).input_hash
  // 先显式暂停，再在两个窗口里各确认一次。
  kernelA.pauseRun('run-two')
  const kernelB = open()
  const revisionA = kernelA.one('SELECT revision FROM workflow_runs WHERE id=?', 'run-two').revision
  const first = kernelA.confirmHuman({
    taskId: claimed.taskId, content: 'window A content', actorId: 'fixture-human',
    inputFingerprint: fingerprint, expectedRunRevision: revisionA, expectedTaskRevision: 1,
    expectedBindingVersion: kernelA.inputBindingFor(claimed.taskId).version,
    idempotencyKey: 'two-a', intent: 'continue',
  })
  need(typeof first.adoptionId === 'string', 'the first window adopts')
  need(kernelA.one('SELECT status FROM workflow_runs WHERE id=?', 'run-two').status === 'paused', 'confirming while paused must not resume the run')
  // 第二个窗口拿旧修订确认：必须被 CAS 挡住，且不能再产生采用。
  expectError(() => kernelB.confirmHuman({
    taskId: claimed.taskId, content: 'window B content', actorId: 'fixture-human',
    inputFingerprint: fingerprint, expectedRunRevision: revisionA, expectedTaskRevision: 1,
    expectedBindingVersion: kernelB.inputBindingFor(claimed.taskId).version,
    idempotencyKey: 'two-b', intent: 'continue',
  }), 'cas_conflict')
  need(countOf(kernelB, 'SELECT COUNT(*) AS n FROM workflow_adoptions') === 1, 'the losing window wrote no adoption')
  need(countOf(kernelB, 'SELECT COUNT(*) AS n FROM workflow_snapshots') === 1, 'the losing window wrote no snapshot')
  need(kernelB.one('SELECT status FROM workflow_human_tasks WHERE id=?', claimed.taskId).status === 'confirmed', 'the task stays confirmed by the winning window')
  // 另一个窗口看到的仍是暂停：任何一侧都不能替用户继续。
  expectError(() => kernelB.claim('run-two'), 'run_paused')
  return { adoptionId: first.adoptionId }
})

// ---------------------------------------------------------------------------
// HC-07：幂等——同请求重放返回原采用；同 key 不同请求直接冲突
// ---------------------------------------------------------------------------
check('HC-07', 'a replayed confirmation reuses the adoption while a changed body conflicts', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-idem', steps: [HUMAN('human.edit-confirm')] })
  const claimed = kernel.claim('run-idem')
  const fingerprint = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claimed.taskId).input_hash
  const runRevision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'run-idem').revision
  const args = {
    taskId: claimed.taskId, content: 'idempotent content', actorId: 'fixture-human',
    inputFingerprint: fingerprint, expectedRunRevision: runRevision, expectedTaskRevision: 1,
    expectedBindingVersion: kernel.inputBindingFor(claimed.taskId).version,
    idempotencyKey: 'idem-1', intent: 'continue',
  }
  const first = kernel.confirmHuman(args)
  const replay = kernel.confirmHuman(args)
  need(replay.replayed === true, 'the replay is marked as replayed')
  need(replay.adoptionId === first.adoptionId, 'the replay returns the original adoption id')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_adoptions') === 1, 'the replay created no second adoption')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_snapshots') === 1, 'the replay created no second snapshot')
  // 同一个 key 换了正文就是另一个请求：必须冲突，不能当成重放。
  expectError(() => kernel.confirmHuman({ ...args, content: 'different content' }), 'idempotency_conflict')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_adoptions') === 1, 'a conflicting request still wrote no adoption')
  return { adoptionId: first.adoptionId }
})

// ---------------------------------------------------------------------------
// HC-08：旧上游基准被拒且草稿保留；被作废的人工步骤重新领取不死锁
// ---------------------------------------------------------------------------
check('HC-08', 'a stale upstream baseline rejects the old confirmation and keeps the draft', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-baseline', steps: [AUTO('fake.transform'), HUMAN('human.edit-confirm')] })
  adoptNext(kernel, 'run-baseline', 'upstream v1')
  const human = kernel.claim('run-baseline')
  const fingerprint = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', human.taskId).input_hash
  const draft = kernel.saveDraft({ taskId: human.taskId, content: 'draft kept across upstream change', expectedBindingVersion: kernel.inputBindingFor(human.taskId).version })
  need(draft.revision === 2, 'the draft bumps the task revision')

  // 模拟上游在别处重跑完成：把上游步骤退回可领取、运行回到可推进，再领取并重新采用。
  kernel.query("UPDATE workflow_steps SET state='paused' WHERE id=?", 'run-baseline:step:1')
  kernel.query("UPDATE workflow_runs SET status='running' WHERE id=?", 'run-baseline')
  adoptNext(kernel, 'run-baseline', 'upstream v2')

  // 下游人工步骤被标 stale，它挂着的待办被搁置——否则运行卡在 waiting_review 永远动不了。
  const staleStep = kernel.one('SELECT state,stale FROM workflow_steps WHERE id=?', 'run-baseline:step:2')
  need(staleStep.state === 'stale' && Number(staleStep.stale) === 1, 'the downstream human step is marked stale')
  need(kernel.one('SELECT status FROM workflow_human_tasks WHERE id=?', human.taskId).status === 'stale', 'the open task of the voided step is shelved')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-baseline').status === 'running', 'the run is not stuck in waiting_review after the upstream change')

  // 旧基准的确认必须被拒；草稿仍在、内容未变。
  const revisionNow = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'run-baseline').revision
  expectError(() => kernel.confirmHuman({
    taskId: human.taskId, content: 'late confirmation on old baseline', actorId: 'fixture-human',
    inputFingerprint: fingerprint, expectedRunRevision: revisionNow, expectedTaskRevision: 1,
    expectedBindingVersion: kernel.inputBindingFor(human.taskId).version,
    idempotencyKey: 'baseline-late', intent: 'continue',
  }), 'cas_conflict')
  const keptDraft = kernel.one('SELECT * FROM workflow_drafts WHERE id=?', draft.draftId)
  need(keptDraft.content === 'draft kept across upstream change', 'the draft content survives the rejected confirmation')
  need(kernel.one('SELECT draft_id FROM workflow_human_tasks WHERE id=?', human.taskId).draft_id === draft.draftId, 'the task still points at the kept draft')

  // 重新领取该步骤：同一待办以新修订重开，草稿仍可继续编辑。
  const reopened = kernel.claim('run-baseline')
  need(reopened.kind === 'human', 'the stale human step is claimable again')
  const reopenedTask = kernel.one('SELECT * FROM workflow_human_tasks WHERE id=?', reopened.taskId)
  need(reopenedTask.status === 'open', 'the shelved task is reopened')
  need(Number(reopenedTask.task_revision) > 2, 'the reopened task carries a newer revision')
  need(reopenedTask.draft_id === draft.draftId, 'the reopened task keeps the previous draft')
  return { taskId: reopened.taskId, taskRevision: Number(reopenedTask.task_revision) }
})

// ---------------------------------------------------------------------------
// HC-09：服务边界——schema、意图与伪造身份都在进入内核之前被拒
// ---------------------------------------------------------------------------
check('HC-09', 'the service rejects bad schema, bad intent and forged human identity', ({ open }) => {
  const kernel = open()
  const service = createFakeBusinessService({ kernel })
  service.registerPrincipal({ id: 'ui-p1', kind: 'ui', productId: 'p1' })
  service.registerPrincipal({ id: 'agent-p1', kind: 'node-agent', productId: 'p1', runIds: ['run-svc'], attemptIds: [] })

  // A10：启动阶段就用字段级 detail 拒绝越界输入，而且不留下 run 行。
  const badStart = expectError(() => service.startRun({
    principal: 'ui-p1', idempotencyKey: 'start-bad', runId: 'run-svc', productId: 'p1',
    steps: [AUTO('fake.transform')], inputSchema: SCHEMA, input: { plan: 'ok', rounds: 9 },
  }), 'schema_invalid')
  need(/rounds/.test(badStart.detail), `expected the field name in the detail, got ${badStart.detail}`)
  need(countOf(kernel, "SELECT COUNT(*) AS n FROM workflow_runs WHERE id='run-svc'") === 0, 'a rejected start creates no run')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_attempts') === 0, 'a rejected start creates no attempt')

  // A36：意图值域先于任何对象解析。
  expectError(() => service.confirmHumanTask({ principal: 'ui-p1', taskId: 'x', content: 'y', intent: 'later' }), 'schema_invalid', 'intent_invalid')
  // A10：方言错误也要在服务层就拒——值本身合法（rounds:3），错的是 schema 用了不认识的关键字。
  expectError(() => service.startRun({
    principal: 'ui-p1', idempotencyKey: 'start-dialect', runId: 'run-svc-dialect', productId: 'p1',
    steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { rounds: { type: 'integer', min: 2 } } }, input: { rounds: 3 },
  }), 'schema_invalid', 'input_schema:properties.rounds:unsupported_keyword:min')
  need(countOf(kernel, "SELECT COUNT(*) AS n FROM workflow_runs WHERE id='run-svc-dialect'") === 0, 'an off-dialect start creates no run')
  // 伪造人工身份：请求体里的 actorId 不是认证身份，一律拒绝。
  expectError(() => service.confirmHumanTask({ principal: 'ui-p1', taskId: 'x', content: 'y', actorId: 'someone-else' }), 'schema_invalid', 'actor_id_not_authenticated')
  // Agent 通道本来就没有 confirm.human 权限，不能靠伪造 human 字段绕过。
  expectError(() => service.confirmHumanTask({ principal: 'agent-p1', taskId: 'x', content: 'y' }), 'capability_unavailable')

  // 正例：同一个已认证会话可以确认，且 confirmed_by 就是该会话身份。
  service.startRun({ principal: 'ui-p1', idempotencyKey: 'start-ok', runId: 'run-svc', productId: 'p1', steps: [HUMAN('human.edit-confirm')], human: true, inputSchema: SCHEMA, input: { plan: 'service plan' } })
  const claimed = service.host.claimRun('run-svc', { plan: 'service plan' })
  const fingerprint = kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claimed.taskId).input_hash
  const revision = kernel.one('SELECT revision FROM workflow_runs WHERE id=?', 'run-svc').revision
  const confirmed = service.confirmHumanTask({
    principal: 'ui-p1', taskId: claimed.taskId, content: 'service confirmed copy',
    inputFingerprint: fingerprint, expectedRunRevision: revision, expectedTaskRevision: 1,
    expectedBindingVersion: kernel.inputBindingFor(claimed.taskId).version,
    idempotencyKey: 'svc-confirm', intent: 'pause',
  })
  need(confirmed.status === 'completed', 'the service reports the confirmation as completed')
  need(confirmed.nextAction === 'resume', 'confirm-and-pause points the caller at resume')
  need(kernel.one('SELECT confirmed_by FROM workflow_human_tasks WHERE id=?', claimed.taskId).confirmed_by === 'ui-p1', 'the actor is the authenticated principal, not the request body')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-svc').status === 'paused', 'the service-level pause intent reaches the run')
  return { detail: badStart.detail }
})

// ---------------------------------------------------------------------------
// HC-10：旧库（没有 input_schema 列）打开后自动迁移，旧 run 仍可推进
// ---------------------------------------------------------------------------
check('HC-10', 'an older database is migrated in place and keeps working', ({ dbPath, openFile }) => {
  // 手工造一个 B4-2 之前的库：workflow_runs 没有 input_schema 列，也没有任何 schema 约束。
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      budget_total INTEGER NOT NULL DEFAULT 900, budget_used INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO workflow_runs VALUES('run-legacy','created',1,900,0,NULL,'t','t');
  `)
  legacy.close()
  const kernel = openFile(dbPath)
  const columns = kernel.query('PRAGMA table_info(workflow_runs)').map((column) => column.name)
  need(columns.includes('input_schema'), 'the missing column is added on open')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-legacy').status === 'created', 'the old run row is preserved by the migration')
  // 旧 run 没有 schema：任何输入都放行，不会因为迁移而突然被拒。
  kernel.query("INSERT INTO workflow_steps VALUES('run-legacy:step:1','run-legacy','fake.transform','automatic','pending',1,NULL,0)")
  const attempt = kernel.claim('run-legacy', { anything: 'goes' })
  need(attempt.kind === 'automatic', 'a run without a stored schema accepts any input')
  return { columns: columns.length }
})

// ---------------------------------------------------------------------------
// HC-11：schema 方言——写错的约束和不认识的关键字一律在创建运行时拒绝，绝不静默忽略
// 这一项直接对应老大复核时给出的两个反例：
//   validateInputSchema({type:'object', required:'plan'}, {})  曾经返回 true（required 不是数组被跳过）
//   {minimum:2} 下 rounds:1 曾经返回 true（不认识 minimum 被忽略，而自造的 min 才有用）
// ---------------------------------------------------------------------------
check('HC-11', 'a malformed or unsupported constraint is rejected at creation, never ignored', ({ open }) => {
  const kernel = open()
  // 反例 1：required 写成字符串。以前 Array.isArray 判断为假 → 当空数组 → 必填校验形同不存在。
  expectError(
    () => kernel.createRun({ id: 'run-dialect-1', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', required: 'plan' } }),
    'schema_invalid',
    'input_schema:required_not_array',
  )
  need(countOf(kernel, "SELECT COUNT(*) AS n FROM workflow_runs WHERE id='run-dialect-1'") === 0, 'a run with a malformed schema is not created')

  // 反例 2：自造的关键字（min/max 这类）不再被当成约束，也不允许悄悄留着。
  expectError(
    () => kernel.createRun({ id: 'run-dialect-2', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { rounds: { type: 'integer', min: 2 } } } }),
    'schema_invalid',
    'input_schema:properties.rounds:unsupported_keyword:min',
  )
  // 方言也不接受把 minimum 写成字符串之类的错误形态。
  expectError(
    () => kernel.createRun({ id: 'run-dialect-3', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { rounds: { type: 'integer', minimum: '2' } } } }),
    'schema_invalid',
    'input_schema:properties.rounds:minimum_malformed',
  )
  // required 指向没声明过的字段，等于让「必填」永远满足，同样拒绝。
  expectError(
    () => kernel.createRun({ id: 'run-dialect-4', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plann'] } }),
    'schema_invalid',
    'input_schema:required_undefined:plann',
  )
  // 不支持的嵌套/数组类型：本方言只覆盖扁平字段，声明了也没法校验。
  expectError(
    () => kernel.createRun({ id: 'run-dialect-5', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { tags: { type: 'array' } } } }),
    'schema_invalid',
    'input_schema:properties.tags:unsupported_type:array',
  )
  // 写坏的 pattern 不能在每次领取时才炸。
  expectError(
    () => kernel.createRun({ id: 'run-dialect-6', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { plan: { type: 'string', pattern: '([' } } } }),
    'schema_invalid',
    'input_schema:properties.plan:pattern_invalid',
  )
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_runs') === 0, 'not one of the rejected schemas created a run')

  // 正例：标准关键字 minimum:2 真的生效——1 被拒、2 通过（老大复核用的正是这一组）。
  kernel.createRun({ id: 'run-standard', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { rounds: { type: 'integer', minimum: 2 } } } })
  expectError(() => kernel.claim('run-standard', { rounds: 1 }), INPUT_SCHEMA_INVALID, 'rounds:below_minimum')
  const attempt = kernel.claim('run-standard', { rounds: 2 })
  need(attempt.kind === 'automatic', 'the boundary value itself is accepted')
  // 直接调导出函数也一样：两个反例都被挡住。
  expectError(() => validateInputSchema({ type: 'object', required: 'plan' }, {}), 'schema_invalid', 'input_schema:required_not_array')
  need(validateInputSchema(null, { any: 'thing' }) === true, 'no schema still means no constraint')
  return { rejected: 6 }
})

// ---------------------------------------------------------------------------
// HC-12：库里存着的旧 schema 若不符合方言，领取时按失败关闭处理，不当成没有约束
// ---------------------------------------------------------------------------
check('HC-12', 'an off-dialect schema already in the database fails closed on claim', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-stored', steps: [AUTO('fake.transform')] })
  // 绕过 createRun 直接写库，模拟「旧版本存进去的 schema」。
  kernel.query(
    "UPDATE workflow_runs SET input_schema=? WHERE id=?",
    JSON.stringify({ type: 'object', properties: { rounds: { type: 'integer', min: 2 } } }),
    'run-stored',
  )
  expectError(() => kernel.claim('run-stored', { rounds: 1 }), 'schema_invalid', 'input_schema:properties.rounds:unsupported_keyword:min')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_attempts') === 0, 'a fail-closed schema check creates no attempt')
  return { status: 'fail_closed' }
})

// ---------------------------------------------------------------------------
// HC-13：约束必须与字段类型相容
// 老大第三轮复核的三个反例（白名单过了关键字，却没校验「约束能不能作用在这个类型上」）：
//   validateInputSchema({type:'object',properties:{rounds:{minimum:2}}}, {rounds:'not-a-number'}) → true（缺 type，区间校验被跳过）
//   {type:'string', minimum:2} 配 'x' → true（字符串字段上的数值约束永远不生效）
//   {type:'number', minLength:3} 配 0 → true（数值字段上的长度约束永远不生效）
// 这类 schema 看着有约束、实际裸奔，比写错关键字更危险，所以创建运行时就拒。
// ---------------------------------------------------------------------------
check('HC-13', 'a constraint that cannot apply to its field type is rejected at creation', ({ open }) => {
  const kernel = open()
  const reject = (id, properties, detail) => {
    expectError(
      () => kernel.createRun({ id, steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties } }),
      'schema_invalid',
      `input_schema:${detail}`,
    )
  }
  // 反例 1：只写 minimum 不给 type —— 值校验器不知道按什么类型比，区间判定被装死。
  reject('run-compat-1', { rounds: { minimum: 2 } }, 'properties.rounds:constraint_without_type:minimum')
  // 反例 2：字符串字段配数值约束。
  reject('run-compat-2', { plan: { type: 'string', minimum: 2 } }, 'properties.plan:constraint_type_mismatch:minimum:string')
  // 反例 3：数值字段配长度约束。
  reject('run-compat-3', { rounds: { type: 'number', minLength: 3 } }, 'properties.rounds:constraint_type_mismatch:minLength:number')
  // 同类组合换方向也一样：字符串配 maximum、布尔配区间、没有 type 的 enum。
  reject('run-compat-4', { plan: { type: 'string', maximum: 5 } }, 'properties.plan:constraint_type_mismatch:maximum:string')
  reject('run-compat-5', { flag: { type: 'boolean', minimum: 0 } }, 'properties.flag:constraint_type_mismatch:minimum:boolean')
  reject('run-compat-6', { channel: { enum: ['web', 'app'] } }, 'properties.channel:constraint_without_type:enum')
  // enum 的值本身也要是声明的类型，否则那条分支永远不会命中。
  reject('run-compat-7', { flag: { type: 'boolean', enum: [true, 'yes'] } }, 'properties.flag:enum_type_mismatch:string')
  reject('run-compat-8', { channel: { type: 'string', enum: ['web', 1] } }, 'properties.channel:enum_type_mismatch:integer')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_runs') === 0, 'not one of the incompatible schemas created a run')
  // 直接调导出函数（老大探针就是直接调的）同样被拦，且报的是一类独立原因。
  const direct = expectError(
    () => validateInputSchema({ type: 'object', properties: { rounds: { minimum: 2 } } }, { rounds: 'not-a-number' }),
    'schema_invalid',
    'input_schema:properties.rounds:constraint_without_type:minimum',
  )
  need(direct.code === 'schema_invalid', 'the direct probe fails on the schema, not on the value')

  // 正例：类型相容的约束照常生效（不是把所有约束都一刀切拒掉）。
  kernel.createRun({ id: 'run-compat-ok', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: {
    plan: { type: 'string', minLength: 3 },
    rounds: { type: 'number', minimum: 2, maximum: 4 },
    attempts: { type: 'integer', maximum: 5 },
  } } })
  expectError(() => kernel.claim('run-compat-ok', { plan: 'ab' }), INPUT_SCHEMA_INVALID, 'plan:too_short')
  expectError(() => kernel.claim('run-compat-ok', { plan: 'abc', rounds: 1 }), INPUT_SCHEMA_INVALID, 'rounds:below_minimum')
  expectError(() => kernel.claim('run-compat-ok', { plan: 'abc', rounds: 9 }), INPUT_SCHEMA_INVALID, 'rounds:above_maximum')
  expectError(() => kernel.claim('run-compat-ok', { plan: 'abc', attempts: 6 }), INPUT_SCHEMA_INVALID, 'attempts:above_maximum')
  const ok = kernel.claim('run-compat-ok', { plan: 'abc', rounds: 3, attempts: 5 })
  need(ok.kind === 'automatic', 'a compatible schema still lets a valid input through')
  return { rejected: 8 }
})

// ---------------------------------------------------------------------------
// HC-14：库里旧 schema 用了「类型不相容的约束」时，领取也必须失败关闭
// 旧版本可能已经存过 {minimum:2} 这种 schema；不能因为「它已经在库里」就当成没有约束。
// ---------------------------------------------------------------------------
check('HC-14', 'an incompatible constraint already stored in the database fails closed on claim', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-stored-compat', steps: [AUTO('fake.transform')] })
  kernel.query(
    'UPDATE workflow_runs SET input_schema=? WHERE id=?',
    JSON.stringify({ type: 'object', properties: { rounds: { minimum: 2 } } }),
    'run-stored-compat',
  )
  const before = kernel.one("SELECT budget_used AS used, revision FROM workflow_runs WHERE id='run-stored-compat'")
  // 老大探针用的正是这个值：以前它会一路放行并真的被领取。
  expectError(
    () => kernel.claim('run-stored-compat', { rounds: 'not-a-number' }),
    'schema_invalid',
    'input_schema:properties.rounds:constraint_without_type:minimum',
  )
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_attempts') === 0, 'a fail-closed compatibility check creates no attempt')
  const after = kernel.one("SELECT budget_used AS used, revision FROM workflow_runs WHERE id='run-stored-compat'")
  need(after.used === before.used && after.revision === before.revision, 'a rejected claim does not touch budget or revision')

  // 服务入口同样失败关闭：不在服务层就把这份 schema 当合法。
  const service = createFakeBusinessService({ kernel })
  service.registerPrincipal({ id: 'ui-compat', kind: 'ui', productId: 'p1' })
  expectError(() => service.startRun({
    principal: 'ui-compat', idempotencyKey: 'start-compat', runId: 'run-svc-compat', productId: 'p1',
    steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { rounds: { type: 'string', minimum: 2 } } }, input: { rounds: 'x' },
  }), 'schema_invalid', 'input_schema:properties.rounds:constraint_type_mismatch:minimum:string')
  need(countOf(kernel, "SELECT COUNT(*) AS n FROM workflow_runs WHERE id='run-svc-compat'") === 0, 'an incompatible start creates no run')
  return { status: 'fail_closed' }
})

// ---------------------------------------------------------------------------
// HC-15：字段存在性只认自有键，显式 properties:null 不当成空对象
// 老大第四轮复核的两个反例：
//   {type:'object',properties:{},required:['toString']} 配 {} → 曾经 true（`in` 顺着原型链找到 Object.prototype.toString）
//   {type:'object',properties:null} → 曾经 true（`?? {}` 把显式 null 当成"没写 properties"）
// 原型链成员既不是声明字段也不是输入字段；显式 null 是写错的 schema，不是空 schema。
// ---------------------------------------------------------------------------
check('HC-15', 'field existence uses own keys only and explicit properties:null is rejected', ({ open }) => {
  const kernel = open()
  const reject = (id, schema, detail) => {
    expectError(
      () => kernel.createRun({ id, steps: [AUTO('fake.transform')], inputSchema: schema }),
      'schema_invalid',
      `input_schema:${detail}`,
    )
  }
  // 反例 1：required 指向原型链成员，properties 里并没有声明它。
  reject('run-own-1', { type: 'object', properties: {}, required: ['toString'] }, 'required_undefined:toString')
  reject('run-own-2', { type: 'object', properties: {}, required: ['constructor'] }, 'required_undefined:constructor')
  reject('run-own-3', { type: 'object', properties: {}, required: ['valueOf'] }, 'required_undefined:valueOf')
  reject('run-own-4', { type: 'object', properties: { plan: { type: 'string' } }, required: ['__proto__'] }, 'required_undefined:__proto__')
  // 反例 2：声明被藏在原型上——看着"声明过"，其实没有自有键。
  const inherited = Object.create({ plan: { type: 'string' } })
  expectError(
    () => kernel.createRun({ id: 'run-own-5', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: inherited, required: ['plan'] } }),
    'schema_invalid',
    'input_schema:required_undefined:plan',
  )
  // 反例 3：显式 properties:null / 数组 / 标量都不是"没有 properties"。
  reject('run-own-6', { type: 'object', properties: null }, 'properties_null')
  reject('run-own-7', { type: 'object', properties: [] }, 'properties_not_object')
  reject('run-own-8', { type: 'object', properties: 'plan' }, 'properties_not_object')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_runs') === 0, 'not one of the own-key violations created a run')

  // 值侧同样只认自有键：原型上的 plan 不算"已提供"。
  expectError(
    () => validateInputSchema({ type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] }, Object.create({ plan: 'inherited' })),
    INPUT_SCHEMA_INVALID,
    'plan:required',
  )
  // 显式写 undefined 的属性同样不算提供（JSON 里根本不会有这个键）。
  expectError(
    () => validateInputSchema({ type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] }, { plan: undefined }),
    INPUT_SCHEMA_INVALID,
    'plan:required',
  )
  // 直接调导出函数：两个反例在 schema 阶段就被拦，不会走到取值校验。
  expectError(() => validateInputSchema({ type: 'object', properties: {}, required: ['toString'] }, {}), 'schema_invalid', 'input_schema:required_undefined:toString')
  expectError(() => validateInputSchema({ type: 'object', properties: null }, {}), 'schema_invalid', 'input_schema:properties_null')

  // 正例：真的自有键照常工作——声明过、提供过就通过；同名但类型不符仍按类型拒。
  kernel.createRun({ id: 'run-own-ok', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } })
  const attempt = kernel.claim('run-own-ok', { plan: 'own key' })
  need(attempt.kind === 'automatic', 'a genuinely own required key still passes')
  // 字段名恰好叫 toString 但真的声明并提供了，也不能被一刀切拒掉。
  expectError(
    () => validateInputSchema({ type: 'object', properties: { toString: { type: 'string' } }, required: ['toString'] }, {}),
    INPUT_SCHEMA_INVALID,
    'toString:required',
  )
  const ownSpecial = validateInputSchema({ type: 'object', properties: { toString: { type: 'string' } }, required: ['toString'] }, { toString: 'declared value' })
  need(ownSpecial === true, 'an explicitly declared property named toString works like any other field')
  return { rejected: 8 }
})

// ---------------------------------------------------------------------------
// HC-16：旧库里已存的原型链绕过 schema / 显式 null schema，领取时也必须失败关闭
// 这些 schema 在旧版本里能被写进库；不能因为"已经在库里"就当成没有约束。
// ---------------------------------------------------------------------------
check('HC-16', 'a stored schema that relies on the prototype chain fails closed on claim', ({ open }) => {
  const kernel = open()
  const store = (id, schema) => {
    kernel.createRun({ id, steps: [AUTO('fake.transform')] })
    kernel.query('UPDATE workflow_runs SET input_schema=? WHERE id=?', JSON.stringify(schema), id)
    return kernel.one('SELECT budget_used AS used, revision FROM workflow_runs WHERE id=?', id)
  }

  // 老大探针原样：required 只有原型链成员，输入给空对象。
  const before = store('run-stored-proto', { type: 'object', properties: {}, required: ['toString'] })
  expectError(
    () => kernel.claim('run-stored-proto', {}),
    'schema_invalid',
    'input_schema:required_undefined:toString',
  )
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_attempts') === 0, 'a fail-closed prototype schema creates no attempt')
  const after = kernel.one('SELECT budget_used AS used, revision FROM workflow_runs WHERE id=?', 'run-stored-proto')
  need(after.used === before.used && after.revision === before.revision, 'a rejected claim does not touch budget or revision')

  // 显式 properties:null 的旧 schema 同样失败关闭。
  store('run-stored-null', { type: 'object', properties: null })
  expectError(() => kernel.claim('run-stored-null', {}), 'schema_invalid', 'input_schema:properties_null')
  need(countOf(kernel, 'SELECT COUNT(*) AS n FROM workflow_attempts') === 0, 'a null-properties schema creates no attempt')

  // 合法 schema + 原型链上的值：不是"没提供"，是拒绝了继承来的字段。
  kernel.createRun({ id: 'run-stored-value', steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } })
  expectError(() => kernel.claim('run-stored-value', Object.create({ plan: 'inherited' })), INPUT_SCHEMA_INVALID, 'plan:required')

  // 服务入口也失败关闭：不在服务层把这类 schema 当合法。
  const service = createFakeBusinessService({ kernel })
  service.registerPrincipal({ id: 'ui-own', kind: 'ui', productId: 'p1' })
  expectError(() => service.startRun({
    principal: 'ui-own', idempotencyKey: 'start-own', runId: 'run-svc-own', productId: 'p1',
    steps: [AUTO('fake.transform')], inputSchema: { type: 'object', properties: null }, input: {},
  }), 'schema_invalid', 'input_schema:properties_null')
  need(countOf(kernel, "SELECT COUNT(*) AS n FROM workflow_runs WHERE id='run-svc-own'") === 0, 'a null-properties start creates no run')
  return { status: 'fail_closed' }
})

const failed = results.filter((result) => result.status === 'fail')
const summary = { checks: results.length, passed: results.length - failed.length, assertions, results }
if (failed.length > 0) process.exitCode = 1
console.log(JSON.stringify(summary, null, 2))
