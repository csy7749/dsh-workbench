// W1-04 服务采用前基准采集专项验证（happy-4.1，2026-11-14）。
//
// 依据 docs/workflow-plan/08-storage-migration.md:105-113「M1 实际效果证据与目标类别」：
//   · 发布意图在**采用事务**内持久化 target_kind / base_hash / expected_hash / base_revision；
//   · 类别取自**构造时注册的可信适配器**，不接受发布/对账请求临时选类别；
//   · 读取基准应在**采用前**完成，不得在准备发布时重新取当前值冒充原基准。
//
// 本文件只锁服务采用入口（自动节点 executeJob、人工确认 confirmHumanTask）的采集行为，
// 不重复 publish-effect 专项已覆盖的内核判定（PRE-01..PRE-20 在 verify-workflow-m1-publish-effect.mjs）。
//
// 证据口径：
//   · base_hash 必须等于**采用那一刻目标的真实内容**，不能等于候选内容（M1 变异：把 expected 当 base）；
//   · 请求体里的 baseRevision / baseContentHash / targetKind / kind 一律不作为证据；
//   · 采集失败必须 fail-closed：零采用、零 outbox、零快照，且作业不能停在一个既不能对账也不能确认的运行态；
//   · 采用后目标变化只影响发布时的观测，**不得**被写回成新的基准。
//
// 明确不覆盖：真实文件目标与真实发布写入、领域投影字段摘要（本批仍只有原文假目标）、
// 租约与旧库零代次迁移；旧未决记录的迁移/处置能力（无证据终结入口已删除，旧行继续隔离）。
// 假服务不写目标，因此任何"用户内容被保留"只能由目标夹具自身状态证明，不宣称服务具备写入路径。
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../src/workflow/m1-fake-service.mjs'

const results = []
let assertions = 0

const need = (condition, message) => {
  assertions += 1
  if (!condition) throw new Error(message)
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const expectCode = (fn, code) => {
  try {
    fn()
  } catch (error) {
    need(error.code === code, `expected ${code} but got ${error.code ?? error.message} (${error.detail ?? ''} ${error.message ?? ''})`)
    return error
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

// 每个用例独立临时库 + 独立对象目录。
const check = (id, title, fn) => {
  const root = mkdtempSync(join(tmpdir(), `m1-sbb-${id}-`))
  let kernel = null
  try {
    kernel = createWorkflowKernel(new DatabaseSync(join(root, 'workflow.sqlite')), root)
    const detail = fn({ kernel, root })
    results.push({ id, title, status: 'pass', detail: detail ?? null })
  } catch (error) {
    results.push({ id, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    try { kernel?.db?.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
}

const tablesOf = (kernel) => kernel.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name)
const fingerprint = (kernel) => kernel.hash(JSON.stringify(tablesOf(kernel).map((table) => ({ table, rows: kernel.query(`SELECT * FROM ${table} ORDER BY rowid`) }))))
const objectTree = (root) => {
  const out = []
  const walk = (dir, prefix = '') => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`)
      else {
        const bytes = readFileSync(join(dir, entry.name))
        out.push({ path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  walk(join(root, 'objects'), 'objects/')
  walk(join(root, 'manifests'), 'manifests/')
  walk(join(root, 'staging'), 'staging/')
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
const state = (kernel, root) => `${fingerprint(kernel)}|${JSON.stringify(objectTree(root))}`

// 假目标：原文 + 单调 revision + 类别的可写夹具。
// read() 记录每一次读取，用来证明「采集只发生一次、且早于采用」；
// observe() 不经过 read()，这样"发布时服务有没有再读一次"可以被观察出来。
const fakeTargets = () => {
  const entries = new Map()
  const kinds = new Map()
  const reads = []
  const kindReads = []
  const target = {
    seed(name, content, revision = 1) { entries.set(name, { content, revision }); return target },
    change(name, content) {
      const current = entries.get(name)
      entries.set(name, { content, revision: (current?.revision ?? 0) + 1 })
      return target
    },
    bumpRevision(name) {
      const current = entries.get(name)
      entries.set(name, { content: current.content, revision: current.revision + 1 })
      return target
    },
    setKind(name, kind) { kinds.set(name, kind); return target },
    peek(name) { return entries.get(name) ?? null },
    read(name) {
      reads.push(name)
      const current = entries.get(name)
      if (!current) throw new Error(`target ${name} is unavailable`)
      return { content: current.content, revision: current.revision }
    },
    // 供内核观测定子使用：不记入 reads，避免把内核的观测误当成服务采集。
    observe(name) {
      const current = entries.get(name)
      return { target: name, revision: current.revision, contentHash: sha256(current.content) }
    },
    get reads() { return [...reads] },
    get readCount() { return reads.length },
    // 类别问询单独计数：发布阶段是否重新向适配器询问类别，是"持久化类别唯一权威"的可观测证据。
    get kindReadCount() { return kindReads.length },
    adapter() {
      return {
        read: (name) => target.read(name),
        // 发布读回契约要求受信适配器同时能写：写入真的改夹具字节并推进版本。
        write: (name, payload) => {
          const current = entries.get(name)
          if (!current) throw new Error(`target ${name} is unavailable`)
          entries.set(name, { content: typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'), revision: current.revision + 1 })
          return { status: 'ok' }
        },
        kindOf: (name) => { kindReads.push(name); return kinds.get(name) ?? null },
      }
    },
  }
  return target
}

// 冻结契约要求节点显式声明发布目标与校验检查：本文件的场景各发一个目标、不做额外校验。
const auto = (nodeId, declarations = {}) => ({ nodeId, nodeKind: 'automatic', requiredChecks: [], publishTargets: [], ...declarations })
const humanStep = (nodeId, declarations = {}) => ({ nodeId, nodeKind: 'human', requiredChecks: [], publishTargets: [], ...declarations })
const declares = (target) => (target ? { publishTargets: [{ target, required: true }] } : {})
const runRevision = (kernel, runId) => Number(kernel.one('SELECT revision FROM workflow_runs WHERE id=?', runId).revision)
const rowOf = (kernel, outboxId) => kernel.one('SELECT * FROM workflow_outbox WHERE id=?', outboxId)
const claimedEventsOf = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type='outbox.claimed' AND payload LIKE ?", `%${outboxId}%`)
const adoptionCount = (kernel) => kernel.query('SELECT id FROM workflow_adoptions').length
const outboxCount = (kernel) => kernel.query('SELECT id FROM workflow_outbox').length
const snapshotCount = (kernel) => kernel.query('SELECT id FROM workflow_snapshots').length

// 自动节点场景：ui 建运行，宿主领取，节点 Agent 被授予该 attempt。
const autoScene = ({ service, runId, productId = 'p1', target = null }) => {
  service.registerPrincipal({ id: 'ui-1', kind: 'ui', productId })
  service.registerPrincipal({ id: 'sched-1', kind: 'scheduler', productId })
  service.startRun({ principal: 'ui-1', idempotencyKey: `start-${runId}`, runId, productId, steps: [auto('fake.transform', declares(target))], input: { fixture: true } })
  const claim = service.host.claimRun(runId)
  need(claim.kind === 'automatic', `expected an automatic claim, got ${claim.kind}`)
  service.registerPrincipal({ id: 'node-1', kind: 'node-agent', productId, runIds: [runId], attemptIds: [claim.attemptId] })
  return claim
}

// 人工确认场景：human 步骤领取后得到待确认任务。
const humanScene = ({ kernel, service, runId, productId = 'p1', target = null }) => {
  service.registerPrincipal({ id: 'ui-1', kind: 'ui', productId })
  service.registerPrincipal({ id: 'sched-1', kind: 'scheduler', productId })
  service.startRun({ principal: 'ui-1', idempotencyKey: `start-${runId}`, runId, productId, steps: [humanStep('human.edit-confirm', declares(target))], input: { fixture: true } })
  const claim = service.host.claimRun(runId)
  need(claim.kind === 'human', `expected a human claim, got ${claim.kind}`)
  const confirmArgs = {
    principal: 'ui-1',
    taskId: claim.taskId,
    inputFingerprint: kernel.one('SELECT input_hash FROM workflow_human_tasks WHERE id=?', claim.taskId).input_hash,
    expectedRunRevision: runRevision(kernel, runId),
    expectedBindingVersion: kernel.inputBindingFor(claim.taskId).version,
  }
  return { claim, confirmArgs }
}

// ---------------------------------------------------------------------------------------------
// SB-00 自检：夹具可达、独立摘要与内核摘要同口径、指纹能检出一条真实写入。
check('SB-00', 'the fixture can reach both adoption entrances and the fingerprint detects a write', ({ kernel, root }) => {
  const targets = fakeTargets()
  targets.seed('pd:self', 'base-A', 1).setKind('pd:self', 'raw_text')
  need(sha256('base-A') === kernel.hash('base-A'), 'the independent digest must agree with the kernel digest for raw text')
  const service = createFakeBusinessService({ kernel, targetAdapter: targets.adapter() })
  const claim = autoScene({ service, runId: 'run-sb-self', target: 'pd:self' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'expected-B', target: 'pd:self', idempotencyKey: 'k-self' })
  const executed = service.host.executeJob(submitted.jobRef)
  const row = rowOf(kernel, executed.outboxId)
  need(row.target_kind === 'raw_text' && row.base_hash === sha256('base-A'), 'the automatic adoption captures the baseline')
  const before = fingerprint(kernel)
  kernel.appendEvent('run-sb-self', 'fixture.probe', { note: 'sensitivity' })
  need(fingerprint(kernel) !== before, 'the fingerprint must change after a real write, otherwise zero-write assertions are vacuous')
  return { targetKind: row.target_kind, reads: targets.readCount }
})

// SB-01 自动采用（executeJob）：基准来自采用前的真实目标，请求里的摘要/类别/revision 一律不算证据。
check('SB-01', 'the automatic adoption captures the real pre-publish target, not the request', ({ kernel, root }) => {
  const targets = fakeTargets()
  targets.seed('pd:auto', 'base-A', 1).setKind('pd:auto', 'raw_text')
  const service = createFakeBusinessService({ kernel, targetAdapter: targets.adapter() })
  const claim = autoScene({ service, runId: 'run-sb-auto', target: 'pd:auto' })

  const submitted = service.submitOutput({
    principal: 'node-1', attemptId: claim.attemptId, token: claim.token,
    content: 'expected-B', target: 'pd:auto', idempotencyKey: 'k-auto',
    // 请求体的"证据"全部是伪造的：任何一条被采信都会让基准变成可注入的。
    baseRevision: 99, baseContentHash: sha256('forged-base'), targetKind: 'domain_revision', kind: 'domain_revision', target_kind: 'domain_revision',
  })
  const executed = service.host.executeJob(submitted.jobRef)
  const row = rowOf(kernel, executed.outboxId)

  need(row.target_kind === 'raw_text', `the kind must come from the trusted adapter, got ${JSON.stringify(row.target_kind)}`)
  need(row.base_revision === 1, `the baseline revision must be the observed one, got ${JSON.stringify(row.base_revision)}`)
  need(row.base_hash === sha256('base-A'), `base_hash must be the pre-publish target content, got ${JSON.stringify(row.base_hash)}`)
  need(row.expected_hash === sha256('expected-B'), `expected_hash must be the adopted content, got ${JSON.stringify(row.expected_hash)}`)
  // 最关键的一条：基准不是候选内容。基准取错会让发布在真正发生冲突时"A 写入 A"地成功。
  need(row.base_hash !== row.expected_hash, 'the baseline must not be the candidate content')
  need(row.base_hash !== sha256('forged-base'), 'a request-supplied baseline digest is never evidence')
  need(row.target_kind !== 'domain_revision', 'a request-supplied kind is never evidence')

  // 采集只读一次，且发生在采用之前（采用之后到执行结束不应再读目标）。
  need(targets.readCount === 1, `the baseline is read exactly once, got ${targets.readCount}`)
  return { baseHash: row.base_hash, expectedHash: row.expected_hash, kind: row.target_kind, reads: targets.readCount }
})

// SB-02 人工确认（confirmHumanTask）：同一条采集规则，人工入口也不例外。
check('SB-02', 'the human confirmation captures the same baseline from the target', ({ kernel, root }) => {
  const targets = fakeTargets()
  targets.seed('pd:human', 'base-A', 1).setKind('pd:human', 'raw_text')
  const service = createFakeBusinessService({ kernel, targetAdapter: targets.adapter() })
  const { confirmArgs } = humanScene({ kernel, service, runId: 'run-sb-human', target: 'pd:human' })

  const confirmed = service.confirmHumanTask({
    ...confirmArgs,
    content: 'expected-B',
    target: 'pd:human',
    required: true,
    // 人工入口同样不能自带基准。
    baseRevision: 99, baseContentHash: sha256('forged-base'), targetKind: 'domain_revision',
    idempotencyKey: 'confirm-human',
  })
  need(confirmed.status === 'completed', `the confirmation should complete, got ${confirmed.status}`)
  const row = rowOf(kernel, `${confirmed.adoptionId}:publish`)
  need(row.target_kind === 'raw_text', `the kind must come from the adapter on the human path too, got ${JSON.stringify(row.target_kind)}`)
  need(row.base_revision === 1, `the human baseline revision must be observed, got ${JSON.stringify(row.base_revision)}`)
  need(row.base_hash === sha256('base-A'), `the human baseline must be the target content, got ${JSON.stringify(row.base_hash)}`)
  need(row.expected_hash === sha256('expected-B'), `the human expected hash must be the confirmed content, got ${JSON.stringify(row.expected_hash)}`)
  need(row.base_hash !== sha256('forged-base'), 'a request-supplied digest is never evidence on the human path')
  return { baseHash: row.base_hash, kind: row.target_kind }
})

// SB-03 采集失败必须 fail-closed：零采用、零 outbox、零快照；且作业不能停在既不能对账也不能确认的运行态。
check('SB-03', 'a failing baseline capture refuses the adoption and leaves a recoverable job', ({ kernel, root }) => {
  const targets = fakeTargets()
  targets.seed('pd:noadapter', 'base-A', 1).setKind('pd:noadapter', 'raw_text')

  // (a) 完全没有适配器：自动入口。
  const noAdapter = createFakeBusinessService({ kernel })
  const claim = autoScene({ service: noAdapter, runId: 'run-sb-noadapter', target: 'pd:noadapter' })
  const submitted = noAdapter.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'expected-B', target: 'pd:noadapter', idempotencyKey: 'k-noadapter' })
  const refused = expectCode(() => noAdapter.host.executeJob(submitted.jobRef), 'capability_unavailable')
  need(!/succeeded|applied/i.test(String(refused.detail ?? '')), `a missing adapter must not describe success, got ${refused.detail}`)
  // 失败允许写"这次作业被隔离"的簿记（否则作业无处可去），但不得产生任何业务副作用：
  // 没有采用、没有 outbox、没有候选快照，目标内容也一个字节没动。
  need(adoptionCount(kernel) === 0 && outboxCount(kernel) === 0 && snapshotCount(kernel) === 0, 'nothing is adopted without a baseline')
  need(kernel.query("SELECT id FROM workflow_events WHERE type LIKE '%publish%'").length === 0, 'a refused capture emits no publish event')
  need(targets.peek('pd:noadapter').content === 'base-A', 'the target content is untouched by a refused capture')

  // 失败后作业必须留在可恢复的状态：running 既不对账（reconcileJob 要求 outcome_unknown）也不能确认，
  // 用户只能去取消一个从未执行的作业——那是把配置错误变成用户可见的取消流程。
  const job = noAdapter.getJob({ principal: 'ui-1', jobRef: submitted.jobRef })
  need(['failed', 'outcome_unknown'].includes(job.status), `a job whose baseline capture failed must be recoverable (failed / outcome_unknown), got ${JSON.stringify(job.status)}`)
  // 持久化与内存必须一致：作业对外报的"未知"要真的落成库里可对账的尝试状态，
  // 不能只在内存里改了个字符串——否则重启后作业状态和对账入口对不上。
  const isolatedAttempt = kernel.one('SELECT status, outcome FROM workflow_attempts WHERE id=?', claim.attemptId)
  need(isolatedAttempt.status === 'unknown', `the isolation must be persisted on the attempt, got ${JSON.stringify(isolatedAttempt)}`)
  need(isolatedAttempt.outcome === 'baseline_unavailable', `the persisted outcome must name the cause, got ${JSON.stringify(isolatedAttempt.outcome)}`)
  const isolatedRun = kernel.one('SELECT status, pause_reason FROM workflow_runs WHERE id=?', 'run-sb-noadapter')
  need(isolatedRun.status === 'paused', `the run must stop rather than keep running, got ${JSON.stringify(isolatedRun)}`)
  need(isolatedRun.pause_reason === 'baseline_unavailable', `the pause must name the cause, got ${JSON.stringify(isolatedRun.pause_reason)}`)
  const isolationEvents = kernel.query("SELECT payload FROM workflow_events WHERE type='attempt.outcome_unknown' AND payload LIKE ?", `%${claim.attemptId}%`)
  need(isolationEvents.length === 1, `the isolation is recorded exactly once, got ${isolationEvents.length}`)
  need(JSON.parse(isolationEvents[0].payload).reason === 'baseline_unavailable', 'the isolation event carries the cause')

  // 可恢复要真能走通：隔离状态必须能被既有对账入口接手（不是只改了个 string）。
  const reconciled = noAdapter.host.reconcileJob(submitted.jobRef, 'not_executed')
  need(reconciled.status === 'cancelled', `the isolated job must be reconcilable, got ${JSON.stringify(reconciled.status)}`)
  need(kernel.one('SELECT status FROM workflow_attempts WHERE id=?', claim.attemptId).status !== 'running', 'the attempt must not stay running after the isolation')
  need(adoptionCount(kernel) === 0 && outboxCount(kernel) === 0, 'reconciling the isolation adopts nothing')
  // 收尾之后还得能重新干一次（配置问题修好后不该只能用取消收场）。
  const runBeforeResume = noAdapter.getRun({ principal: 'ui-1', runId: 'run-sb-noadapter' }).run
  noAdapter.commandRun({ principal: 'ui-1', runId: 'run-sb-noadapter', command: 'resume', expectedRevision: runBeforeResume.revision, idempotencyKey: 'resume-after-isolation' })
  const secondClaim = noAdapter.host.claimRun('run-sb-noadapter')
  need(secondClaim.attemptId !== claim.attemptId, 'the run can be claimed again after reconciling the isolation')

  // (b) 适配器读取抛错：人工入口同样拒绝，任务保持待确认（可重试）。
  const broken = createFakeBusinessService({ kernel, targetAdapter: { read: () => { throw new Error('target offline') }, kindOf: () => 'raw_text' } })
  const human = humanScene({ kernel, service: broken, runId: 'run-sb-broken', target: 'pd:noadapter' })
  const beforeHuman = state(kernel, root)
  expectCode(() => broken.confirmHumanTask({ ...human.confirmArgs, content: 'expected-B', target: 'pd:noadapter', required: true, idempotencyKey: 'confirm-broken' }), 'capability_unavailable')
  need(state(kernel, root) === beforeHuman, 'a failing read on the human path writes nothing')
  need(kernel.one('SELECT status FROM workflow_human_tasks WHERE id=?', human.claim.taskId).status === 'open', 'the human task stays open for a retry')

  // (c) 适配器读取抛错：自动入口同样要「隔离 + 可对账」，不能只覆盖缺适配器一种失败形状。
  //     缺适配器是配置缺失，抛错是目标暂时不可读——两者都必须在作业上留下可对账的状态。
  const throwingTargets = fakeTargets()
  throwingTargets.seed('pd:throws', 'base-A', 1).setKind('pd:throws', 'raw_text')
  const throwing = createFakeBusinessService({ kernel, targetAdapter: { read: () => { throw new Error('target offline') }, kindOf: () => 'raw_text' } })
  const throwClaim = autoScene({ service: throwing, runId: 'run-sb-broken-auto', productId: 'p2', target: 'pd:throws' })
  const throwSubmitted = throwing.submitOutput({ principal: 'node-1', attemptId: throwClaim.attemptId, token: throwClaim.token, content: 'expected-B', target: 'pd:throws', idempotencyKey: 'k-broken-auto' })
  const throwRefused = expectCode(() => throwing.host.executeJob(throwSubmitted.jobRef), 'capability_unavailable')
  need(!/succeeded|applied/i.test(String(throwRefused.detail ?? '')), `a throwing adapter must not describe success, got ${throwRefused.detail}`)
  need(adoptionCount(kernel) === 0 && outboxCount(kernel) === 0 && snapshotCount(kernel) === 0, 'a throwing adapter adopts, publishes and stores nothing')
  need(throwing.getJob({ principal: 'ui-1', jobRef: throwSubmitted.jobRef }).status === 'outcome_unknown', 'a throwing adapter leaves a recoverable job too')
  const throwAttempt = kernel.one('SELECT status, outcome FROM workflow_attempts WHERE id=?', throwClaim.attemptId)
  need(throwAttempt.status === 'unknown' && throwAttempt.outcome === 'baseline_unavailable', `the throwing path persists the same isolation, got ${JSON.stringify(throwAttempt)}`)
  const throwReconciled = throwing.host.reconcileJob(throwSubmitted.jobRef, 'not_executed')
  need(throwReconciled.status === 'cancelled', `the throwing path must be reconcilable, got ${JSON.stringify(throwReconciled.status)}`)
  return { refused: refused.detail, jobStatus: job.status, throwRefused: throwRefused.detail }
})

// SB-04 采用后目标变化：只影响发布观测，不能被写回成新的基准；也不能因此永久卡死。
check('SB-04', 'a target changed after adoption is never re-captured as the baseline', ({ kernel, root }) => {
  const targets = fakeTargets()
  targets.seed('pd:changed', 'base-A', 1).setKind('pd:changed', 'raw_text')
  const service = createFakeBusinessService({ kernel, targetAdapter: targets.adapter() })
  const claim = autoScene({ service, runId: 'run-sb-changed', target: 'pd:changed' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'expected-B', target: 'pd:changed', idempotencyKey: 'k-changed' })
  const executed = service.host.executeJob(submitted.jobRef)
  const adoptedHash = rowOf(kernel, executed.outboxId).base_hash
  need(adoptedHash === sha256('base-A'), 'the adopted baseline is the content at adoption time')

  // 采用之后用户改了目标：发布时必须按冲突处理，且不能把新内容写回基准。
  targets.change('pd:changed', 'user-C')
  const before = state(kernel, root)
  const refused = expectCode(
    () => service.host.publish({ principal: 'sched-1', outboxId: executed.outboxId }),
    'publish_conflict',
  )
  need(refused.detail === 'publish_base_mismatch', `a changed target is a base mismatch, got ${JSON.stringify(refused.detail)}`)
  need(state(kernel, root) === before, 'a refused publish writes nothing')
  const row = rowOf(kernel, executed.outboxId)
  need(row.status === 'pending', `the item stays pending, got ${row.status}`)
  need(row.base_hash === adoptedHash, `the baseline must not be overwritten by the newer content, got ${JSON.stringify(row.base_hash)}`)
  need(row.base_hash !== sha256('user-C'), 'the post-adoption content never becomes the baseline')
  need(claimedEventsOf(kernel, executed.outboxId).length === 0, 'a base mismatch claims nothing')
  need(targets.peek('pd:changed').content === 'user-C', 'the user content is preserved (nothing is written)')

  // 反向正控：用户把内容改回原样（revision 已推进），原文目标按内容判定必须还能发布——
  // 否则一次外部改动就等于永久卡死。
  targets.change('pd:changed', 'base-A')
  const published = service.host.publish({ principal: 'sched-1', outboxId: executed.outboxId })
  need(published.status === 'succeeded', `an unchanged base content must still be publishable, got ${JSON.stringify(published.status)}`)
  need(rowOf(kernel, executed.outboxId).base_hash === adoptedHash, 'the baseline is still the adoption-time content after publishing')
  need(claimedEventsOf(kernel, executed.outboxId).length === 1, 'the recovered item is claimed exactly once')
  return { adoptedHash, conflict: refused.detail, published: published.status }
})

// SB-05 采用时目标已是预期内容：基准与预期相同，发布应补记成功，不领取、不重发。
check('SB-05', 'an already-applied target at adoption time yields an already-applied publish', ({ kernel, root }) => {
  const targets = fakeTargets()
  targets.seed('pd:applied', 'expected-B', 1).setKind('pd:applied', 'raw_text')
  const service = createFakeBusinessService({ kernel, targetAdapter: targets.adapter() })
  const claim = autoScene({ service, runId: 'run-sb-applied', target: 'pd:applied' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'expected-B', target: 'pd:applied', idempotencyKey: 'k-applied' })
  const executed = service.host.executeJob(submitted.jobRef)
  const row = rowOf(kernel, executed.outboxId)
  need(row.base_hash === sha256('expected-B'), 'the baseline is the target content, which already is the expected one')
  need(row.base_hash === row.expected_hash, 'both digests coincide for an already-applied target')

  const before = state(kernel, root)
  const published = service.host.publish({ principal: 'sched-1', outboxId: executed.outboxId })
  need(published.status === 'succeeded', `the expected content is recorded as success, got ${JSON.stringify(published.status)}`)
  need(published.effect === 'already_applied', `the effect must be already_applied, got ${JSON.stringify(published.effect)}`)
  need(claimedEventsOf(kernel, executed.outboxId).length === 0, 'an already-applied item is never claimed')
  need(rowOf(kernel, executed.outboxId).claim_generation === 0, 'an already-applied item consumes no generation')
  need(fingerprint(kernel) !== before.split('|')[0], 'the success is recorded (the row changed)')
  return { effect: published.effect, generation: rowOf(kernel, executed.outboxId).claim_generation }
})

// SB-06 发布时不重读类别：类别以采用时持久化的为准，适配器后来改口不能放松也不能收紧判定。
check('SB-06', 'the persisted kind wins over a later adapter answer', ({ kernel, root }) => {
  const targets = fakeTargets()
  targets.seed('pd:rekind', 'base-A', 1).setKind('pd:rekind', 'raw_text')
  const service = createFakeBusinessService({ kernel, targetAdapter: targets.adapter() })
  const claim = autoScene({ service, runId: 'run-sb-rekind', target: 'pd:rekind' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'expected-B', target: 'pd:rekind', idempotencyKey: 'k-rekind' })
  const executed = service.host.executeJob(submitted.jobRef)
  need(rowOf(kernel, executed.outboxId).target_kind === 'raw_text', 'the fixture persists the raw_text kind')

  // 适配器后来宣称这是领域目标，且目标 revision 推进（内容仍是基准）：
  // 若发布时重读 kindOf，这里会被误判成冲突；持久化类别应仍然按内容放行。
  targets.change('pd:rekind', 'base-A')
  targets.setKind('pd:rekind', 'domain_revision')
  const published = service.host.publish({ principal: 'sched-1', outboxId: executed.outboxId })
  need(published.status === 'succeeded', `the persisted raw_text kind must still judge by content only, got ${JSON.stringify(published.status)}`)
  need(rowOf(kernel, executed.outboxId).target_kind === 'raw_text', 'the persisted kind is untouched by the later adapter answer')

  // 反向：采用时是领域目标，适配器后来改口成原文，且 revision 推进——不能因此放松。
  targets.seed('pd:rekind-dom', 'base-A', 1).setKind('pd:rekind-dom', 'domain_revision')
  const claim2 = autoScene({ service, runId: 'run-sb-rekind-dom', target: 'pd:rekind-dom' })
  const submitted2 = service.submitOutput({ principal: 'node-1', attemptId: claim2.attemptId, token: claim2.token, content: 'expected-B', target: 'pd:rekind-dom', idempotencyKey: 'k-rekind-dom' })
  const executed2 = service.host.executeJob(submitted2.jobRef)
  need(rowOf(kernel, executed2.outboxId).target_kind === 'domain_revision', 'the fixture persists the domain kind')
  targets.change('pd:rekind-dom', 'base-A')
  targets.setKind('pd:rekind-dom', 'raw_text')
  const kindsAskedAtAccept = targets.kindReadCount
  const refused = expectCode(
    () => service.host.publish({ principal: 'sched-1', outboxId: executed2.outboxId }),
    'publish_conflict',
  )
  // 发布阶段不得再向适配器询问类别：否则"适配器后来改口"会成为判定路径上的输入。
  need(targets.kindReadCount === kindsAskedAtAccept, `publishing must not re-interrogate the adapter about the kind, got ${targets.kindReadCount - kindsAskedAtAccept} extra asks`)
  need(refused.detail === 'publish_base_mismatch', `a moved domain revision must not be relaxed by a later adapter answer, got ${JSON.stringify(refused.detail)}`)
  need(rowOf(kernel, executed2.outboxId).status === 'pending', 'the domain item stays pending')
  return { rawText: published.status, domain: refused.detail }
})

// SB-07 同一采用只采集一次、且不产生第二份证据：采集成功后不再读取目标，
// 也不允许把 expected/候选当作基准再记一遍。
check('SB-07', 'the baseline is captured once and never re-derived from the candidate', ({ kernel, root }) => {
  const targets = fakeTargets()
  targets.seed('pd:once', 'base-A', 3).setKind('pd:once', 'raw_text')
  const service = createFakeBusinessService({ kernel, targetAdapter: targets.adapter() })
  const claim = autoScene({ service, runId: 'run-sb-once', target: 'pd:once' })
  const submitted = service.submitOutput({ principal: 'node-1', attemptId: claim.attemptId, token: claim.token, content: 'expected-B', target: 'pd:once', idempotencyKey: 'k-once' })
  const executed = service.host.executeJob(submitted.jobRef)
  const row = rowOf(kernel, executed.outboxId)
  need(row.base_revision === 3, `the baseline revision must be the observed revision, got ${JSON.stringify(row.base_revision)}`)
  need(row.base_hash === sha256('base-A'), 'the baseline hash is the observed content')
  const readsAfterAdoption = targets.readCount
  need(readsAfterAdoption === 1, `adoption reads the target exactly once, got ${readsAfterAdoption}`)

  // 发布阶段必然读目标（领取前观测 + 写入后读回），但这些读取只用于判定本次效果，不得写回基准。
  const published = service.host.publish({ principal: 'sched-1', outboxId: executed.outboxId })
  need(published.status === 'succeeded', `the verified publish succeeds, got ${JSON.stringify(published.status)}`)
  need(targets.readCount > readsAfterAdoption, 'publishing must observe the target to verify the effect, otherwise it settles on the adapter self-report')
  const afterPublish = rowOf(kernel, executed.outboxId)
  need(afterPublish.base_hash === sha256('base-A'), 'the baseline is unchanged after publishing')
  need(afterPublish.base_revision === 3, `the baseline revision is unchanged after publishing, got ${JSON.stringify(afterPublish.base_revision)}`)
  need(afterPublish.base_hash !== sha256('expected-B'), 'the published content never becomes the baseline')
  return { revision: row.base_revision, reads: targets.readCount }
})

// ---------------------------------------------------------------------------------------------
const specChecks = results.length
const specFailed = results.filter((row) => row.status === 'fail').length
console.log(JSON.stringify({
  checks: results.length,
  passed: results.length - specFailed,
  assertions,
  specChecks,
  specFailed,
  results,
}))
process.exitCode = specFailed > 0 ? 1 : 0
