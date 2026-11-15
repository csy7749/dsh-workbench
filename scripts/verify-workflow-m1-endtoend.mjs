// B5 / W1-08 端到端假服务闭环专项验证（happy-4.1）。
// 全程临时 SQLite + 临时对象目录 + 进程内假执行器；不监听端口、不发真实 HTTP、不注册任何宿主工具。
// 两份固定模板来自 scripts/fixtures/workflow/human-runs.json（four-step-with-human / four-step-auto），
// 断言的是真实数据流：下游拿到的是上游已采用快照的磁盘内容，不是结构占位。
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../src/workflow/m1-fake-service.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PRODUCT = 'fixture-product-alpha'
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'scripts/fixtures/workflow/human-runs.json'), 'utf8'))

const template = (name) => {
  const run = FIXTURE.runs.find(item => item.template === name)
  if (!run) throw new Error(`fixture template ${name} missing`)
  return run
}
// 模板直接映射成内核步骤定义：kind=human 走人工节点，其余按自动节点。
const definitionsFor = run => run.steps.map(step => ({
  nodeId: step.id,
  nodeKind: step.kind === 'human' ? 'human' : 'automatic',
  outputs: [{ name: 'content', artifactType: 'text', schemaVersion: 1, editable: true, multiplicity: 'one' }],
  requiredChecks: [],
  publishTargets: run.adoptions.filter(item => item.stepId === step.id).flatMap(item => (item.publishTargets ?? []).map(target => ({ target: target.docKey, required: true }))),
}))
// 发布目标取自模板自身的 adoptions[].publishTargets[].docKey，避免测试私自扩大发布范围。
const targetsFor = (run) => {
  const map = new Map()
  for (const adoption of run.adoptions) {
    const target = adoption.publishTargets?.[0]?.docKey
    if (target) map.set(adoption.stepId, target)
  }
  return map
}

// 夹具目标适配器：目标版本与原文都由夹具持有，publish 的 observe 读夹具，
// 不回读 workflow_outbox.base_revision（步进的 adopt 缺省 baseRevision=1，夹具同起点）。
// 08:109 之后采用前要采集基准：适配器 read/kindOf 报的就是夹具里这份「采用那一刻的目标」。
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const fixtureTargets = new Map()
const fixtureTarget = (name) => {
  if (!fixtureTargets.has(name)) {
    const state = { name, revision: 1, content: '' }
    const read = () => ({ content: state.content, revision: state.revision })
    state.read = read
    state.observe = (asked) => {
      const value = read()
      return { target: asked, revision: value.revision, contentHash: sha256(value.content) }
    }
    fixtureTargets.set(name, state)
  }
  return fixtureTargets.get(name)
}
// 构造期注册的可信目标适配器：类别固定为原文目标（E2E 夹具都是原文文档）。
const targetAdapter = {
  read: (target) => fixtureTarget(target).read(),
  kindOf: () => 'raw_text',
  write: (target, content, options) => {
    const state = fixtureTarget(target)
    if (state.failNext) { state.failNext = false; return { status: 'failed' } }
    if (sha256(state.content) !== options.expectedHash) return { status: 'conflict' }
    state.content = content
    state.revision += 1
    return { status: 'succeeded' }
  },
}

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
    if (detail) {
      const actual = String(error.detail ?? error.message)
      need(actual.includes(detail), `expected detail to include ${detail} but got ${actual}`)
    }
    return error
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

const check = (id, title, fn) => {
  const root = mkdtempSync(join(tmpdir(), `m1-e2e-${id}-`))
  let world = null
  try {
    world = openWorld(root)
    const detail = fn(world)
    results.push({ id, title, status: 'pass', detail })
  } catch (error) {
    results.push({ id, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    try { world?.kernel?.db?.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
}

const registerPrincipals = (service) => {
  service.registerPrincipal({ id: 'ui-1', kind: 'ui', productId: PRODUCT })
  service.registerPrincipal({ id: 'sched-1', kind: 'scheduler', productId: PRODUCT })
  service.registerPrincipal({ id: 'other-1', kind: 'other-agent', productId: 'fixture-product-beta' })
}

// 一个「世界」= 临时库 + 临时对象根 + 假服务；restart() 模拟关页/重启：只有磁盘活着。
const openWorld = (root) => {
  const world = {
    root,
    dbPath: join(root, 'workflow.sqlite'),
    objectRoot: join(root, 'objects'),
    kernel: null,
    service: null,
    restart() {
      try { world.kernel?.db?.close() } catch {}
      world.kernel = openWorkflowKernel(world.dbPath, world.objectRoot)
      world.service = createFakeBusinessService({ kernel: world.kernel, targetAdapter, clock: () => '2026-11-14T00:00:00.000Z' })
      registerPrincipals(world.service)
      for (const runId of world.runs ?? []) world.service.host.registerRunProduct(runId, PRODUCT)
    },
    // 假服务的产品归属表在内存里，重启后要按磁盘上的 run 重新登记（真实服务会从库里读）。
    runs: [],
  }
  world.restart()
  return world
}

const attachRun = (world, runId) => {
  world.runs.push(runId)
  world.service.host.registerRunProduct(runId, PRODUCT)
}

const runRow = (kernel, runId) => kernel.one('SELECT status,pause_reason,revision,budget_used,budget_total FROM workflow_runs WHERE id=?', runId)
const adoptionsFor = (kernel, runId) => kernel.query(`
  SELECT a.id, a.snapshot_id, a.actor_type, a.reason, s.node_id FROM workflow_adoptions a
  JOIN workflow_steps s ON s.id = a.step_id WHERE s.run_id=? ORDER BY a.rowid`, runId)
const outboxFor = (kernel, runId) => kernel.query(`
  SELECT o.* FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id
  JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? ORDER BY o.rowid`, runId)
const snapshotOf = (kernel, snapshotId) => kernel.one('SELECT * FROM workflow_snapshots WHERE id=?', snapshotId)
const humanTasksFor = (kernel, runId) => kernel.query(`
  SELECT t.* FROM workflow_human_tasks t JOIN workflow_steps s ON s.id=t.step_id
  WHERE s.run_id=? ORDER BY t.rowid`, runId)

// 一次完整自动步骤：领取 → 节点读输入并据此算出输出（测试不提供 content）→ 宿主执行。
const runAutomaticStep = (world, { runId, target, nodeId = 'node-1', pad = 0 }) => {
  const claim = world.service.host.claimRun(runId)
  need(claim.kind === 'automatic', `expected an automatic claim, got ${claim.kind}`)
  world.service.registerPrincipal({ id: nodeId, kind: 'node-agent', productId: PRODUCT, runIds: [runId], attemptIds: [claim.attemptId] })
  const ran = world.service.host.runNode(claim.attemptId, { principal: nodeId, target, pad })
  return { claim, input: ran.input, content: ran.content, submit: { jobRef: ran.jobRef }, executed: ran.executed }
}

// 把某个 Attempt 的租约拨到过去，验证「到期」也救不回一条已记录原因的暂停运行。
const expireLease = (kernel, attemptId) => {
  kernel.db.prepare('UPDATE workflow_attempts SET lease_until=? WHERE id=?').run('2020-01-01T00:00:00.000Z', attemptId)
}

// 必需发布由 scheduler 通道完成（ui 与节点都没有发布权）。
const publishRequired = (world, runId) => {
  const pending = world.service.host.outboxFor(runId).filter(row => row.status === 'pending' && Number(row.required) === 1)
  for (const row of pending) world.service.host.publish({ principal: 'sched-1', outboxId: row.id, status: 'succeeded', observe: fixtureTarget(row.target).observe })
  return pending
}

const humanTemplate = template('four-step-with-human')
const autoTemplate = template('four-step-auto')
const humanTargets = targetsFor(humanTemplate)
const autoTargets = targetsFor(autoTemplate)

// --- E2E-01 无人工节点模板：不等待、无隐式内容审批，自动推进到 completed（A34 无人工节点侧）
check('E2E-01', 'auto template runs to completed with no human task and a real parent chain', (world) => {
  const runId = 'e2e-auto'
  attachRun(world, runId)
  world.service.startRun({
    principal: 'ui-1', idempotencyKey: 'start-auto', runId, productId: PRODUCT,
    steps: definitionsFor(autoTemplate), input: { fixture: true },
    inputSchema: { type: 'object', required: ['fixture'], properties: { fixture: { type: 'boolean' } } },
  })

  const step1 = runAutomaticStep(world, { runId, target: autoTargets.get('fixture-auto-step-modules') })
  need(step1.input.snapshotId === null, 'the first step must start without an upstream snapshot')
  need(step1.content.includes('(no upstream snapshot)'), 'the node output must be derived from the empty input, not preset by the test')
  publishRequired(world, runId)

  const step2 = runAutomaticStep(world, { runId, target: autoTargets.get('fixture-auto-step-structure') })
  need(step2.input.content === step1.content, `step2 must consume the adopted upstream content, got ${JSON.stringify(step2.input.content)}`)
  need(step2.content.startsWith('[fixture-auto-step-structure]'), 'the downstream output must be produced by that node, not by the test')
  need(step2.content.includes(step1.content), 'the downstream output must carry the upstream bytes it actually read')
  publishRequired(world, runId)

  const step3 = runAutomaticStep(world, { runId, target: autoTargets.get('fixture-auto-step-report') })
  need(step3.input.content === step2.content, 'step3 must consume what step2 actually adopted')
  publishRequired(world, runId)

  const kernel = world.kernel
  const row = runRow(kernel, runId)
  need(row.status === 'completed', `run must complete automatically, got ${row.status}`)
  need(humanTasksFor(kernel, runId).length === 0, 'an auto-only template must not create a human task')
  const adoptions = adoptionsFor(kernel, runId)
  need(adoptions.length === 3, `expected 3 adoptions, got ${adoptions.length}`)
  need(adoptions.every(item => item.actor_type === 'system'), 'every auto adoption must be authored by the system')
  need(adoptions.every(item => item.reason === 'validated'), 'auto adoptions must be recorded as validated, not as human content approval')
  const arts = world.service.listArtifacts({ principal: 'ui-1', runId }).artifacts
  need(arts.length === 3, `expected 3 artifacts, got ${arts.length}`)
  need(arts[1].parentId === arts[0].snapshotId, 'the second snapshot must point at the first adoption')
  need(arts[2].parentId === arts[1].snapshotId, 'the third snapshot must point at the second adoption')
  const outbox = outboxFor(kernel, runId)
  need(outbox.length === 3, `expected 3 publish items, got ${outbox.length}`)
  need(outbox.every(item => item.status === 'succeeded'), 'every required publish must succeed')
  need(new Set(outbox.map(item => item.target)).size === 3, 'publish targets must stay within the three declared doc keys')
  const events = world.service.listEvents({ principal: 'ui-1', runId, limit: 100 }).events.map(event => event.type)
  need(events.includes('run.completed'), 'the run completion event must be recorded')
  return { status: row.status, adoptions: adoptions.length, publishes: outbox.length }
})

// --- E2E-02 有人工节点模板：等待 → 存草稿 → 重启恢复 → 手改被下游真实消费（A01/A34/A35）
check('E2E-02', 'human template waits, a draft survives restart, and the edit is what downstream consumes', (world) => {
  const runId = 'e2e-human'
  attachRun(world, runId)
  world.service.startRun({
    principal: 'ui-1', idempotencyKey: 'start-human', runId, productId: PRODUCT,
    steps: definitionsFor(humanTemplate), input: { fixture: true },
  })

  const step1 = runAutomaticStep(world, { runId, target: humanTargets.get('fixture-step-modules') })
  publishRequired(world, runId)
  const step1Adoption = adoptionsFor(world.kernel, runId)[0]
  need(Boolean(step1Adoption?.snapshot_id), 'the generated snapshot must be adopted')

  const humanClaim = world.service.host.claimRun(runId)
  need(humanClaim.kind === 'human', `expected a human claim, got ${humanClaim.kind}`)
  need(runRow(world.kernel, runId).status === 'waiting_review', 'the run must wait at the human node')
  expectError(() => world.service.host.claimRun(runId), 'run_waiting_review')
  const humanStepId = humanTemplate.steps[1].id
  need(world.kernel.query('SELECT id FROM workflow_attempts WHERE step_id=?', humanStepId).length === 0, 'a human claim must not create an execution attempt')
  need(adoptionsFor(world.kernel, runId).length === 1, 'no adoption may exist for the human step before confirmation')

  const draftContent = `${step1.content}+ 手工补充：归档前先确认目录为空。\n`
  const draft = world.kernel.saveDraft({ taskId: humanClaim.taskId, content: draftContent, expectedTaskRevision: 1, expectedBindingVersion: world.kernel.inputBindingFor(humanClaim.taskId).version })
  need(draft.revision === 2, `draft revision must advance to 2, got ${draft.revision}`)
  need(runRow(world.kernel, runId).status === 'waiting_review', 'saving a draft must not advance the run')
  need(adoptionsFor(world.kernel, runId).length === 1, 'saving a draft must not adopt anything')

  // 关页/重启：同一待办、同一草稿、仍是等待态，且不重复派发
  world.restart()
  const tasks = world.service.listHumanTasks({ principal: 'ui-1' }).tasks.filter(task => task.run_id === runId)
  need(tasks.length === 1, `restart must restore exactly one open task, got ${tasks.length}`)
  need(tasks[0].id === humanClaim.taskId, 'restart must restore the same human task id')
  need(tasks[0].status === 'open', `the restored task must still be open, got ${tasks[0].status}`)
  need(tasks[0].task_revision === 2, `the restored task must keep revision 2, got ${tasks[0].task_revision}`)
  need(tasks[0].draft_id === draft.draftId, 'restart must point at the same draft id')
  const restoredDraft = world.kernel.one('SELECT content FROM workflow_drafts WHERE id=?', draft.draftId)
  need(restoredDraft?.content === draftContent, 'restart must restore the same draft content')
  need(runRow(world.kernel, runId).status === 'waiting_review', 'restart must not advance past the human node')
  expectError(() => world.service.host.claimRun(runId), 'run_waiting_review')

  // 确认手改内容（不是原文）：human 采用，父指针指向上一步快照
  const beforeConfirm = runRow(world.kernel, runId)
  const confirm = world.service.confirmHumanTask({
    principal: 'ui-1', taskId: humanClaim.taskId, content: draftContent,
    inputFingerprint: tasks[0].input_hash, expectedRunRevision: beforeConfirm.revision,
    expectedTaskRevision: 2, expectedBindingVersion: tasks[0].bindingVersion,
    idempotencyKey: 'confirm-human-step', target: humanTargets.get('fixture-step-human'),
    required: true,
  })
  need(confirm.status === 'completed', 'the human confirmation must be committed')
  const humanAdoption = adoptionsFor(world.kernel, runId)[1]
  need(humanAdoption.actor_type === 'human', `the human step must be adopted by human, got ${humanAdoption.actor_type}`)
  need(humanAdoption.reason === 'human.edit-confirm', 'the adoption reason must record human.edit-confirm')
  const humanSnapshot = snapshotOf(world.kernel, humanAdoption.snapshot_id)
  need(humanSnapshot.parent_id === step1Adoption.snapshot_id, 'the human snapshot must point at the generated snapshot')
  need(world.service.readArtifact({ principal: 'ui-1', runId, snapshotId: humanAdoption.snapshot_id }).artifact.content === draftContent, 'the human snapshot must hold the edited text')
  // 原生成快照仍可读（A01：原生成可读）
  need(world.service.readArtifact({ principal: 'ui-1', runId, snapshotId: step1Adoption.snapshot_id }).artifact.content === step1.content, 'the original generated snapshot must stay readable and unchanged')
  publishRequired(world, runId)

  // 第 3 步：下游真实消费手改内容（输出由读到的输入算出，不是测试拼的字符串）
  const step3 = runAutomaticStep(world, { runId, target: humanTargets.get('fixture-step-structure') })
  need(step3.input.content === draftContent, `downstream must consume the hand-edited snapshot, got ${JSON.stringify(step3.input.content)}`)
  need(step3.input.snapshotId === humanAdoption.snapshot_id, 'downstream input must resolve to the human adoption snapshot')
  need(step3.input.authorType === 'human', 'downstream input must be attributed to the human snapshot')
  need(step3.content.includes(draftContent), 'the downstream output must be derived from the hand-edited snapshot bytes')
  publishRequired(world, runId)

  const step4 = runAutomaticStep(world, { runId, target: humanTargets.get('fixture-step-report') })
  need(step4.input.content === step3.content, 'the report step must consume what step3 adopted (still containing the human edit)')
  publishRequired(world, runId)

  const row = runRow(world.kernel, runId)
  need(row.status === 'completed', `the human template must complete after confirmation, got ${row.status}`)
  need(adoptionsFor(world.kernel, runId).length === 4, 'all four steps must be adopted exactly once')
  const report = world.service.listArtifacts({ principal: 'ui-1', runId }).artifacts.at(-1)
  const reportContent = world.service.readArtifact({ principal: 'ui-1', runId, snapshotId: report.snapshotId }).artifact.content
  need(reportContent.includes('归档前先确认目录为空'), 'the human edit must survive to the final artifact')
  return { status: row.status, humanSnapshot: humanAdoption.snapshot_id, draft: draft.draftId }
})

// --- E2E-03 原文直接确认：内容与上游一致也须留 human 采用与父指针（A35）
check('E2E-03', 'confirming the unchanged original text still records a human adoption', (world) => {
  const runId = 'e2e-human-same'
  attachRun(world, runId)
  world.service.startRun({
    principal: 'ui-1', idempotencyKey: 'start-human-same', runId, productId: PRODUCT,
    steps: definitionsFor(humanTemplate), input: { fixture: true },
  })
  const step1 = runAutomaticStep(world, { runId, target: humanTargets.get('fixture-step-modules') })
  publishRequired(world, runId)
  const upstream = adoptionsFor(world.kernel, runId)[0]

  const humanClaim = world.service.host.claimRun(runId)
  need(humanClaim.kind === 'human', 'the human node must claim as a task')
  const task = humanTasksFor(world.kernel, runId)[0]
  const before = runRow(world.kernel, runId)
  world.service.confirmHumanTask({
    principal: 'ui-1', taskId: humanClaim.taskId, content: step1.content,
    inputFingerprint: task.input_hash, expectedRunRevision: before.revision,
    expectedTaskRevision: 1, expectedBindingVersion: world.kernel.inputBindingFor(humanClaim.taskId).version,
    idempotencyKey: 'confirm-same', target: humanTargets.get('fixture-step-human'),
  })
  const adoption = adoptionsFor(world.kernel, runId)[1]
  need(adoption.actor_type === 'human', 'an unchanged confirmation is still a human adoption')
  const snapshot = snapshotOf(world.kernel, adoption.snapshot_id)
  need(snapshot.parent_id === upstream.snapshot_id, 'the unchanged human snapshot must still point at the upstream snapshot')
  need(snapshot.content_hash === snapshotOf(world.kernel, upstream.snapshot_id).content_hash, 'unchanged text must reuse the same content hash')
  need(snapshot.id !== upstream.snapshot_id, 'the human adoption must still be its own snapshot')
  return { sameContentAsParent: true, actor: adoption.actor_type }
})

// --- E2E-04 A37 硬校验失败：节点产出超限被服务硬拒，原因写进内核并停止，租约到期也救不回来
check('E2E-04', 'a hard validation failure records its reason and stops the run before any retry', (world) => {
  const runId = 'e2e-hard-check'
  attachRun(world, runId)
  world.service.startRun({
    principal: 'ui-1', idempotencyKey: 'start-hard-check', runId, productId: PRODUCT,
    steps: definitionsFor(autoTemplate), input: { fixture: true },
  })
  const claim = world.service.host.claimRun(runId)
  world.service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId: PRODUCT, runIds: [runId], attemptIds: [claim.attemptId] })
  const budgetBefore = runRow(world.kernel, runId).budget_used

  // 硬校验：节点实际产出的字节超过契约上限，服务当场拒绝，作业根本不会产生。
  // 停机不是测试发起的 pause——由假执行器把失败原因写回内核。
  const error = expectError(
    () => world.service.host.runNode(claim.attemptId, { principal: 'node-1', target: autoTargets.get('fixture-auto-step-modules'), pad: 512 * 1024 }),
    'schema_invalid', 'content_too_large',
  )
  const row = runRow(world.kernel, runId)
  need(row.status === 'paused', `a hard validation failure must stop the run, got ${row.status}`)
  need(String(row.pause_reason).includes('content_too_large'), `the stop reason must be recorded on the run, got ${row.pause_reason}`)
  const attempt = world.kernel.one('SELECT status,outcome FROM workflow_attempts WHERE id=?', claim.attemptId)
  need(attempt.status === 'failed', `the failed attempt must be terminated, got ${attempt.status}`)
  need(String(attempt.outcome).includes('content_too_large'), 'the attempt must keep the failure outcome')
  const step = world.kernel.one('SELECT state FROM workflow_steps WHERE id=?', claim.attemptId.replace(/:attempt:\d+$/, ''))
  need(step.state === 'paused', `the failed step must stop, got ${step.state}`)
  const failures = world.service.listEvents({ principal: 'ui-1', runId, limit: 100 }).events.filter(event => event.type === 'attempt.failed')
  need(failures.length === 1 && String(failures[0].payload?.reason).includes('content_too_large'), 'the failure must be recorded as an attempt.failed event with its reason')

  need(row.budget_used === budgetBefore, 'a rejected output must not charge extra budget')
  need(adoptionsFor(world.kernel, runId).length === 0, 'a rejected output must not be adopted')
  need(world.kernel.query('SELECT id FROM workflow_snapshots').length === 0, 'a rejected output must not create a snapshot')
  need(world.kernel.query('SELECT id FROM workflow_outbox').length === 0, 'a rejected output must not create a publish item')
  need(row.status !== 'completed', 'a hard validation failure must never auto-pass the run')

  // 租约到期：Attempt 已终结，回收不会把它重启；运行仍是暂停，claim 不会自己续跑
  expireLease(world.kernel, claim.attemptId)
  expectError(() => world.service.host.claimRun(runId), 'run_paused')
  const afterExpiry = world.kernel.one('SELECT status FROM workflow_attempts WHERE id=?', claim.attemptId)
  need(afterExpiry.status === 'failed', `lease expiry must not revive a failed attempt, got ${afterExpiry.status}`)
  need(world.kernel.query('SELECT id FROM workflow_attempts WHERE step_id=?', claim.attemptId.replace(/:attempt:\d+$/, '')).length === 1, 'lease expiry must not auto-dispatch a second attempt')
  // 只有显式继续才会重派：停止是明确的，不是死锁，也不是自动重试
  world.service.commandRun({ principal: 'ui-1', runId, command: 'resume', expectedRevision: runRow(world.kernel, runId).revision, idempotencyKey: 'resume-hard-check' })
  const retry = world.service.host.claimRun(runId)
  need(retry.kind === 'automatic', 'an explicit resume is what allows a retry')
  need(world.kernel.query('SELECT id FROM workflow_attempts WHERE step_id=?', claim.attemptId.replace(/:attempt:\d+$/, '')).length === 2, 'the retry must happen only after the explicit resume')
  return { code: error.code, runStatus: row.status, pauseReason: row.pause_reason, budgetUsed: row.budget_used }
})

// --- E2E-05 A37 必需检查未评估：必需发布未完成时不得 completed，也不自动恢复
check('E2E-05', 'an unassessed required publish keeps the run incomplete until it is resolved', (world) => {
  const runId = 'e2e-check-missing'
  attachRun(world, runId)
  world.service.startRun({
    principal: 'ui-1', idempotencyKey: 'start-check-missing', runId, productId: PRODUCT,
    steps: [definitionsFor(autoTemplate)[0]], input: { fixture: true },
  })
  // 第 1 步只声明必需发布，不执行发布：检查项等于「未评估」
  runAutomaticStep(world, { runId, target: autoTargets.get('fixture-auto-step-modules') })
  const outbox = outboxFor(world.kernel, runId)
  need(outbox.length === 1 && outbox[0].status === 'pending' && Number(outbox[0].required) === 1, 'the required publish must be pending')
  const row = runRow(world.kernel, runId)
  need(row.status !== 'completed', `an unassessed required publish must block completion, got ${row.status}`)
  expectError(() => world.service.host.claimRun(runId), 'step_not_claimable')

  // 检查失败：运行暂停并记录结构化原因，claim 不会把它拉回来
  fixtureTarget(outbox[0].target).failNext = true
  world.service.host.publish({ principal: 'sched-1', outboxId: outbox[0].id })
  const paused = runRow(world.kernel, runId)
  need(paused.status === 'paused' && paused.pause_reason === 'publish_failed', `expected paused/publish_failed, got ${paused.status}/${paused.pause_reason}`)
  expectError(() => world.service.host.claimRun(runId), 'run_paused')
  // 未解决前 resume 也必须被拒（不能靠继续按钮绕过未评估的检查）
  expectError(() => world.service.commandRun({ principal: 'ui-1', runId, command: 'resume', expectedRevision: paused.revision, idempotencyKey: 'resume-blocked' }), 'publish_conflict')
  const events = world.service.listEvents({ principal: 'ui-1', runId, limit: 100 }).events.map(event => event.type)
  need(!events.includes('run.completed'), 'a blocked run must not record completion')
  return { status: paused.status, pauseReason: paused.pause_reason }
})

// --- E2E-06 A37 输出缺失：上游对象被删 → 记录原因并停止，租约到期也不自动重派
check('E2E-06', 'a missing upstream artifact records its reason and stops instead of silently continuing', (world) => {
  const runId = 'e2e-output-missing'
  attachRun(world, runId)
  world.service.startRun({
    principal: 'ui-1', idempotencyKey: 'start-output-missing', runId, productId: PRODUCT,
    steps: definitionsFor(autoTemplate), input: { fixture: true },
  })
  const first = runAutomaticStep(world, { runId, target: autoTargets.get('fixture-auto-step-modules') })
  publishRequired(world, runId)
  const upstream = adoptionsFor(world.kernel, runId)[0]
  const upstreamSnapshot = snapshotOf(world.kernel, upstream.snapshot_id)

  const claim = world.service.host.claimRun(runId)
  need(claim.kind === 'automatic', 'the downstream step must be claimable before the file disappears')
  world.service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId: PRODUCT, runIds: [runId], attemptIds: [claim.attemptId] })

  // 模拟输出对象在磁盘上缺失（不是改库、不是结构断言）
  const objectPath = join(world.kernel.root, 'objects', upstreamSnapshot.content_hash.slice(0, 2), upstreamSnapshot.content_hash)
  unlinkSync(objectPath)
  const error = expectError(() => world.service.host.runNode(claim.attemptId, { principal: 'node-1', target: autoTargets.get('fixture-auto-step-structure') }), 'artifact_missing', 'parent_object_missing')
  need(error.code === 'artifact_missing', 'a missing artifact must surface as artifact_missing')

  const row = runRow(world.kernel, runId)
  need(row.status === 'paused', `a missing upstream artifact must stop the run, got ${row.status}`)
  need(String(row.pause_reason).includes('parent_object_missing'), `the stop reason must be recorded on the run, got ${row.pause_reason}`)
  const attempt = world.kernel.one('SELECT status,outcome FROM workflow_attempts WHERE id=?', claim.attemptId)
  need(attempt.status === 'failed', `the broken attempt must be terminated, got ${attempt.status}`)
  need(String(attempt.outcome).includes('parent_object_missing'), 'the attempt must keep the failure outcome')
  const stepId = claim.attemptId.replace(/:attempt:\d+$/, '')
  need(world.kernel.one('SELECT state FROM workflow_steps WHERE id=?', stepId).state === 'paused', 'the broken step must stop')
  // 非运行中 Attempt 不再提供输入：受理已终结的执行属于契约外调用
  expectError(() => world.service.host.inputFor(claim.attemptId), 'attempt_invalid', 'attempt_failed')

  // 孤儿快照：快照主键是 `${attemptId}:snapshot`，行里还记 source_attempt_id。
  // 只拿 Attempt ID 当快照 ID 查会恒为空（老大退回的恒真断言），必须按来源尝试查，
  // 并用一条已知能命中的正控证明这个查询形状本身有效，否则「查不到」可能只是查法写错。
  const upstreamSourceAttemptId = snapshotOf(world.kernel, upstream.snapshot_id).source_attempt_id
  const control = world.kernel.query('SELECT id FROM workflow_snapshots WHERE source_attempt_id=?', upstreamSourceAttemptId)
  need(control.length === 1 && control[0].id === upstream.snapshot_id, 'the orphan query must be able to hit a real snapshot of its source attempt')
  const orphanBySource = world.kernel.query('SELECT id FROM workflow_snapshots WHERE source_attempt_id=?', claim.attemptId)
  need(orphanBySource.length === 0, `a failed attempt must not leave an orphan snapshot, found ${JSON.stringify(orphanBySource.map(item => item.id))}`)
  need(!world.kernel.one('SELECT id FROM workflow_snapshots WHERE id=?', `${claim.attemptId}:snapshot`), 'a failed attempt must not leave the snapshot row keyed by its own attempt id')
  need(world.kernel.query('SELECT id FROM workflow_snapshots').length === 1, 'the only snapshot in the run must be the upstream one')
  need(adoptionsFor(world.kernel, runId).length === 1, 'the downstream step must not adopt anything')
  need(outboxFor(world.kernel, runId).length === 1, 'a missing artifact must not add publish items')
  need(world.kernel.query('SELECT id FROM workflow_attempts WHERE step_id=?', stepId).length === 1, 'the missing artifact must not trigger a second attempt')

  // 租约到期：已终结的 Attempt 不会被回收成可重派，运行仍是暂停
  expireLease(world.kernel, claim.attemptId)
  expectError(() => world.service.host.claimRun(runId), 'run_paused')
  need(world.kernel.one('SELECT status FROM workflow_attempts WHERE id=?', claim.attemptId).status === 'failed', 'lease expiry must not revive the failed attempt')
  need(world.kernel.query('SELECT id FROM workflow_attempts WHERE step_id=?', stepId).length === 1, 'lease expiry must not auto-dispatch a second attempt')
  // 上游对象真的缺失时，连读回都不该成功（防止「只读库」蒙混过关）
  expectError(() => world.service.readArtifact({ principal: 'ui-1', runId, snapshotId: upstream.snapshot_id }), 'artifact_missing', 'object_not_on_disk')
  return { code: error.code, runStatus: row.status, pauseReason: row.pause_reason, firstStepOutput: first.content.length }
})

// --- E2E-07 A37 越权副作用：节点不能发布/确认，发布范围不变
check('E2E-07', 'a node agent cannot publish or confirm, and the publish scope stays unchanged', (world) => {
  const runId = 'e2e-privilege'
  attachRun(world, runId)
  world.service.startRun({
    principal: 'ui-1', idempotencyKey: 'start-privilege', runId, productId: PRODUCT,
    steps: definitionsFor(autoTemplate), input: { fixture: true },
  })
  runAutomaticStep(world, { runId, target: autoTargets.get('fixture-auto-step-modules') })
  const outbox = outboxFor(world.kernel, runId)
  need(outbox.length === 1, 'exactly one publish item must exist before the privilege probe')

  const nodeId = 'node-1'
  expectError(() => world.service.host.publish({ principal: nodeId, outboxId: outbox[0].id, status: 'succeeded', observe: fixtureTarget(outbox[0].target).observe }), 'capability_unavailable', 'node-agent_may_not_publish.official')
  const after = outboxFor(world.kernel, runId)
  need(after.length === 1, 'a denied publish must not create new publish items')
  need(after[0].status === 'pending', 'a denied publish must not change the publish status')
  need(after[0].target === outbox[0].target, 'a denied publish must not change the publish target')

  world.kernel.createRun({ id: 'e2e-privilege-human', steps: [{ nodeId: humanTemplate.steps[1].id, nodeKind: 'human' }] })
  world.service.host.registerRunProduct('e2e-privilege-human', PRODUCT)
  const humanClaim = world.service.host.claimRun('e2e-privilege-human')
  expectError(() => world.service.confirmHumanTask({
    principal: nodeId, taskId: humanClaim.taskId, content: 'agent forge',
    inputFingerprint: world.kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', humanClaim.taskId).input_hash,
    expectedRunRevision: runRow(world.kernel, 'e2e-privilege-human').revision, idempotencyKey: 'agent-confirm',
  }), 'capability_unavailable', 'node-agent_may_not_confirm.human')
  need(humanTasksFor(world.kernel, 'e2e-privilege-human').every(task => task.status === 'open'), 'a denied confirmation must leave the task open')
  return { deniedPublish: true, deniedConfirm: true, publishes: after.length }
})

// --- E2E-08 A01 输入链完整性：上游对象被同长度篡改 → 读回校验失败，下游绝不产出脏内容
check('E2E-08', 'a tampered upstream object breaks the input chain instead of leaking into downstream output', (world) => {
  const runId = 'e2e-tampered-input'
  attachRun(world, runId)
  world.service.startRun({
    principal: 'ui-1', idempotencyKey: 'start-tampered', runId, productId: PRODUCT,
    steps: definitionsFor(autoTemplate), input: { fixture: true },
  })
  const first = runAutomaticStep(world, { runId, target: autoTargets.get('fixture-auto-step-modules') })
  publishRequired(world, runId)
  const upstream = adoptionsFor(world.kernel, runId)[0]
  const upstreamSnapshot = snapshotOf(world.kernel, upstream.snapshot_id)

  const claim = world.service.host.claimRun(runId)
  world.service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId: PRODUCT, runIds: [runId], attemptIds: [claim.attemptId] })
  // 同长度改写：字节数校验照样通过，只有内容哈希能抓住（否则等于没验完整性）
  const objectPath = join(world.kernel.root, 'objects', upstreamSnapshot.content_hash.slice(0, 2), upstreamSnapshot.content_hash)
  const tampered = `${first.content.slice(0, -1)}!`
  need(Buffer.byteLength(tampered) === Buffer.byteLength(first.content), 'the tamper must keep the byte length so only the content hash can catch it')
  writeFileSync(objectPath, tampered, 'utf8')

  const error = expectError(() => world.service.host.runNode(claim.attemptId, { principal: 'node-1', target: autoTargets.get('fixture-auto-step-structure') }), 'artifact_missing', 'parent_content_mismatch')
  need(error.code === 'artifact_missing', 'a tampered parent object must fail as artifact_missing')

  const row = runRow(world.kernel, runId)
  need(row.status === 'paused', `a tampered input must stop the run, got ${row.status}`)
  need(String(row.pause_reason).includes('parent_content_mismatch'), `the stop reason must be recorded, got ${row.pause_reason}`)
  need(adoptionsFor(world.kernel, runId).length === 1, 'the broken step must not adopt anything')
  // 脏内容一次都没进过对象库的采用记录：采用内容哈希仍是原来那份
  const adopted = world.kernel.query('SELECT content_hash FROM workflow_snapshots')
  need(adopted.length === 1 && adopted[0].content_hash === upstreamSnapshot.content_hash, 'the tampered bytes must never become an adopted snapshot')
  expectError(() => world.service.readArtifact({ principal: 'ui-1', runId, snapshotId: upstream.snapshot_id }), 'artifact_missing', 'content_hash_mismatch')
  return { code: error.code, runStatus: row.status, pauseReason: row.pause_reason }
})

for (const mode of ['missing', 'digest', 'hash', 'foreign']) check(`BIND-${mode}`, 'invalid binding stops before execution', world => {
  const k = world.kernel
  for (const id of ['bound', 'foreign']) {
    k.createRun({ id, steps: ['a', 'b'].map(nodeId => ({ nodeId, nodeKind: 'automatic', outputs: [{ name: 'content', artifactType: 'text', schemaVersion: 1, editable: true, multiplicity: 'one' }], requiredChecks: [], publishTargets: [] })) })
    const a = k.claim(id)
    k.adopt({ ...a, candidate: k.storeCandidate({ ...a, content: `${id} data` }) })
  }
  const a = k.claim('bound')
  if (mode === 'missing') k.db.prepare('DELETE FROM workflow_input_bindings WHERE owner_id=?').run(a.attemptId)
  else {
    const binding = k.inputBindingFor(a.attemptId)
    const inputs = binding.inputs
    if (mode === 'hash') inputs[0].contentHash = 'bad'
    else if (mode === 'foreign') {
      const s = k.one("SELECT * FROM workflow_snapshots WHERE source_attempt_id='foreign:step:1:attempt:1'")
      const adoption = k.one('SELECT * FROM workflow_adoptions WHERE snapshot_id=?', s.id)
      inputs[0] = { stepId: 'foreign:step:1', adoptionId: adoption.id, snapshotId: s.id, contentHash: s.content_hash }
    }
    // Isolate digest validation from content/ownership validation.
    k.db.prepare('UPDATE workflow_input_bindings SET binding_json=?,integrity_hash=? WHERE owner_id=?').run(JSON.stringify(inputs), mode === 'digest' ? 'bad' : k.hash({ ownerId: a.attemptId, version: binding.version, inputs }), a.attemptId)
  }
  expectError(() => world.service.host.runNode(a.attemptId), 'artifact_missing', mode === 'missing' ? 'attempt_input_unbound' : 'attempt_input_invalid')
  need(runRow(k, 'bound').status === 'paused', 'invalid binding pauses run')
  need(k.one('SELECT status FROM workflow_attempts WHERE id=?', a.attemptId).status !== 'running', 'invalid binding ends attempt')
  need(String(runRow(k, 'bound').pause_reason).includes('attempt_input_'), 'binding failure reason retained')
  return { mode }
})

const failed = results.filter(item => item.status === 'fail')
console.log(JSON.stringify({ checks: results.length, passed: results.length - failed.length, assertions, results }, null, 2))
if (failed.length > 0) process.exitCode = 1
