// W1 发布领取代次（fencing）契约专项（happy-4.1 独立复核，2026-11-14）。
// 全程临时 SQLite + 临时根目录，不碰生产库、不发 HTTP、不调真实模型。
//
// 为什么需要这一层（可复现反例，来自 m00623 的只读核对）：
//   claimOutbox 只把 pending 改成 running，不记录"这是第几次领取"；completeOutbox 的 CAS 只判
//   status='running'。于是"领取 → 崩溃/无回调 → 对账 not_published → 重新领取"之后，
//   上一代的迟到回调仍能结算，把旧结果写到当前代上：
//     claim(1) → outcome_unknown → reconcile(not_published) → pending → claim(2)
//     → completeOutbox(id,'succeeded','stale_from_attempt_1')  ← 现状成功（误结算）
//   两次 outbox.claimed 事件的 payload 完全相同（{outboxId,target,observedRevision}），
//   没有任何字段能让结算方证明"我是当前这一代"。
//
// 本批冻结的契约形状（老大 m00632 口径）：
//   1) claimOutbox(id, { observe }) 成功时返回 { outboxId, status:'running', claimGeneration }。
//      claimGeneration 是从 1 起的正整数、每次成功领取 +1、持久化在库里（重启后仍然有效）。
//   2) completeOutbox(id, status, reason = null, claimGeneration)：第四位是代次本身。
//   3) reconcilePublishEffect(id, { actorId, claimGeneration, observe })：代次在参数对象里，
//      且必须先过代次、再要求内容观测（无证据不得记成功）。
//   4) 两条写路径都必须校验"正整数 + 等于当前代次"；缺失或不等一律
//      outbox_claim_mismatch，且不写盘。不得从库里替调用方补缺失的代次。
//   5) 拒绝一律零副作用：全库用户表指纹 + objects/、manifests/、staging/ 逐字节指纹都不变；
//      不许"先落 running 再回滚"、不许留半条事件。
//
// 错误码折叠（不新增 SERVICE_ERROR_CODES，走 DOMAIN_TO_SERVICE）：
//   outbox_claim_mismatch → publish_conflict（不是当前持有者 / 没出示代次，属冲突）
//   注意与先例的不一致：publish_observation_required 缺失归 schema_invalid（调用方输入错）。
//   本批按老大口径把"缺失"和"不匹配"合并成一个码，因此归 publish_conflict。若之后要区分，
//   需要同时改本文件的 PFR-03 / PFR-04 与服务映射。
//
// 校验顺序（我作为复核方固定的判定，理由如下，请实施方确认）：
//   两条写路径都必须在"类型/状态门槛"之后、cas 之前校验代次，且顺序为
//     completeOutbox：行存在 → 结果归一化 → pending 守卫(outbox_not_claimed) → 代次 → cas(running)
//     reconcilePublishEffect：行存在 → 必须是 outcome_unknown(outbox_not_reconcilable) → 代次 → 观测/证据门槛 → 写
//   理由：既有断言依赖这两个码的优先级——PCB-09 断言"未领取的 pending 项结算"得
//   outbox_not_claimed、PCB-10 与 PRR-07 断言"已终结项再结算/再对账"得 cas_conflict /
//   outbox_not_reconcilable。若代次校验抢先，这些格子会统一退化成 outbox_claim_mismatch，
//   调用方就分不清"状态不对"和"代次不对"。PFR-08 把这条优先级锁住。
//
// 范围边界（不得据此宣称竞态已解决）：
//   - 只锁内核结算/对账侧的代次。真实宿主"领取 → 异步执行 → 回调"的窗口不存在于本批同步假服务里，
//     服务层 host.publish 在同一次调用内 claim+settle，跨代回调在服务出口不可复现，
//     因此本专项不加服务层用例（服务透传代次列入后续批次）。
//   - 不引入自动恢复：不对 running 做任何"超时转 unknown"。重启扫描仍只读（既有契约）。
//   - 不引入租约时长 / 心跳默认值（03-node-contract-runtime.md:111 明确留给 W0 冻结）。
//
// 升级风险（需写进 08-storage-migration.md，未做前不得宣称旧库兼容）：
//   代次只能落在 workflow_outbox 的新列上。旧库 ALTER TABLE 加列的默认值会让**正在 running 的
//   历史行**持有 0 代，而契约只接受 ≥1 的正整数 —— 这些行再也无法用自己的代次结算，只能走对账。
//   这是失败关闭（不误写），但升级处置与诊断必须成文，否则等同不可运维。
//
// 破坏性提示（本文件故意红）：契约 4) 生效后，现有不带代次的调用点全部转红，
// 必须与内核改动同批迁移。迁移面清单（本文件写就时实测）：
//   completeOutbox 35 处，分布于 scripts/verify-workflow-m1.mjs、
//   verify-workflow-m1-independent.mjs、verify-workflow-m1-recovery.mjs、
//   verify-workflow-m1-publish-claim.mjs、verify-workflow-m1-publish-result.mjs、
//   verify-workflow-m1-human-confirm.mjs；
//   reconcilePublishEffect 见 verify-workflow-m1-publish-claim.mjs 的 PCB-10/PCB-13。
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkflowKernel, openWorkflowKernel } from '../src/workflow/m1-kernel.mjs'

const results = []
let assertions = 0

const need = (condition, message) => {
  assertions += 1
  if (!condition) throw new Error(message)
}

const expectError = (fn, code) => {
  try {
    fn()
  } catch (error) {
    need(error.code === code, `expected ${code} but got ${error.code ?? error.message} (${error.message ?? ''})`)
    return error
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

const check = (id, title, fn, kind = 'spec') => {
  const root = mkdtempSync(join(tmpdir(), `m1-fence-${id}-`))
  const handles = []
  try {
    const dbPath = join(root, 'workflow.sqlite')
    const kernel = createWorkflowKernel(new DatabaseSync(dbPath), root)
    handles.push({ db: kernel.db })
    const detail = fn({ kernel, root, dbPath, handles })
    results.push({ id, kind, title, status: 'pass', detail: detail ?? null })
  } catch (error) {
    results.push({ id, kind, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    for (const item of handles) { try { item.db.close() } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
}

// 零副作用指纹：动态发现全部用户表，新增列 / 新增表自动纳入，不靠手工清单。
const tablesOf = (kernel) => kernel.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name)
const fingerprint = (kernel) => kernel.hash(JSON.stringify(tablesOf(kernel).map((table) => ({ table, rows: kernel.query(`SELECT * FROM ${table} ORDER BY rowid`) }))))
// 目录指纹 = 相对路径 + 字节数 + 内容 sha256（只比路径不能证明逐字节不变）。
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

// 独立摘要：与内核同口径，但这里自己算，不借用内核函数（避免"用被测对象证明被测对象"）。
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

// content 是目标此刻的真实正文；给了才回报 contentHash（需要内容证据的项一律给）。
const adapter = (revision, { content = null } = {}) => {
  const calls = []
  return {
    calls,
    observeTarget: (target) => {
      calls.push(target)
      return { target, revision, ...(content === null ? {} : { contentHash: sha256(content) }), observedAt: new Date().toISOString() }
    },
  }
}

// 单步自动 run：采用 + 带 target 的必需发布（run 因发布未终结而不终结）。
// 基准正文由本次采用的独立目标夹具给出（默认按 target 生成一份），不取自候选、不取自 outbox。
const baseOf = (target) => `fence base of ${target}`
const pendingRun = (kernel, { runId = 'run-fence', content = 'fence fixture', target = 'pd:fence', baseRevision = 4, baseContent = null, targetKind = 'raw_text' } = {}) => {
  const base = baseContent ?? baseOf(target)
  kernel.createRun({ id: runId, steps: [{ nodeId: 'fake.transform', nodeKind: 'automatic', requiredChecks: [], publishTargets: [{ target, required: true }] }], input: { fixture: true } })
  const attempt = kernel.claim(runId)
  const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content })
  const adoption = kernel.adopt({
    attemptId: attempt.attemptId, token: attempt.token, candidate, target, baseRevision, required: true,
    baseContentHash: kernel.hash(base), targetKind,
  })
  const row = kernel.one('SELECT * FROM workflow_outbox WHERE adoption_id=?', adoption.adoptionId)
  return { runId, attempt, adoption, outboxId: row.id, target, baseRevision, baseContent: base, content }
}

const rowOf = (kernel, outboxId) => kernel.one('SELECT * FROM workflow_outbox WHERE id=?', outboxId)
const settledEvents = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type='outbox.settled' AND payload LIKE ?", `%${outboxId}%`)
const claimedEvents = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type='outbox.claimed' AND payload LIKE ?", `%${outboxId}%`)
// 对账审计在 08:110 之后分成两种落点：applied/absent 记 effect_reconciled，diverged 记 effect_conflict。
// 这里把两者合并计数，用于"一次真实对账必须留下且只留下一条审计"的断言。
const reconciledEvents = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type IN ('outbox.effect_reconciled','outbox.effect_conflict') AND payload LIKE ?", `%${outboxId}%`)

// 领取并取出代次；代次是契约的一部分，取不到就红在这里，不静默降级成 1 或从库里补。
const claimGeneration = (kernel, item) => {
  const claimed = kernel.claimOutbox(item.outboxId, { observe: adapter(item.baseRevision, { content: item.baseContent }).observeTarget })
  need(claimed && claimed.status === 'running', 'claim reports the item as running')
  need(
    Number.isSafeInteger(claimed.claimGeneration) && claimed.claimGeneration >= 1,
    `claim must report claimGeneration as a positive integer, got ${JSON.stringify(claimed.claimGeneration)}`,
  )
  return claimed.claimGeneration
}

// 把一条领取过的发布转回"可重领"：unknown → 观测到目标仍是基准（absent）→ pending。
// 只有 absent 允许回 pending；观测到预期正文是 applied，观测到第三种内容是 diverged（落 conflict）。
const makeReclaimable = (kernel, item) => {
  const first = claimGeneration(kernel, item)
  kernel.completeOutbox(item.outboxId, undefined, null, first)
  need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', 'a claim with no result becomes outcome_unknown')
  const reconciled = kernel.reconcilePublishEffect(item.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: first,
    observe: adapter(item.baseRevision, { content: item.baseContent }).observeTarget,
  })
  need(reconciled.decision === 'absent', `an untouched base reconciles as absent, got ${reconciled.decision}`)
  need(rowOf(kernel, item.outboxId).status === 'pending', 'an absent reconciliation returns the item to pending')
  return first
}

// PFR-00 自检（应始终为绿）：证明这个场景真实可达，且指纹能检出一次真实写入。
// 它刻意在"契约未实现"与"契约已实现"两种世界里都能跑：领取代次取得到就用四位签名，
// 取不到就用现行的三位签名。否则本项会跟着红测一起红，失去"防恒真"的作用。
// 若本项红，说明"旧代被拒后无写入"的后半句证据本身失效（恒真断言）。
const claimAny = (kernel, item) => {
  const claimed = kernel.claimOutbox(item.outboxId, { observe: adapter(item.baseRevision, { content: item.baseContent }).observeTarget })
  need(claimed && claimed.status === 'running', 'claim reports the item as running')
  return Number.isSafeInteger(claimed.claimGeneration) && claimed.claimGeneration >= 1 ? claimed.claimGeneration : null
}
const settleAny = (kernel, id, status, reason, generation) =>
  generation === null ? kernel.completeOutbox(id, status, reason) : kernel.completeOutbox(id, status, reason, generation)
// 对账没有"无观测"的退路：必须给真实观测。这里固定观测到目标仍是基准（absent）。
const reconcileAbsent = (kernel, item, generation) => kernel.reconcilePublishEffect(item.outboxId, {
  actorId: 'fixture-reconciler',
  claimGeneration: generation,
  observe: adapter(item.baseRevision, { content: item.baseContent }).observeTarget,
})

check('PFR-00', 'the reclaim scenario is reachable and the fingerprint detects a real write', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-fence-reach', target: 'pd:fence-reach' })
  const first = claimAny(kernel, item)
  settleAny(kernel, item.outboxId, undefined, null, first)
  need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', 'a claim with no result becomes outcome_unknown')
  reconcileAbsent(kernel, item, first)
  need(rowOf(kernel, item.outboxId).status === 'pending', 'reconcile(not_published) really returns the item to pending')
  const second = claimAny(kernel, item)
  need(rowOf(kernel, item.outboxId).status === 'running', 'the item can genuinely be claimed a second time')
  need(claimedEvents(kernel, item.outboxId).length === 2, 'the scenario produces exactly two outbox.claimed events for the same outbox id')
  // 契约已实现时顺带证明单调递增；未实现时（两者都是 null）这条不参与判定。
  if (first !== null && second !== null) {
    need(second === first + 1, `each successful claim advances the generation by one (${first} → ${second})`)
  }

  // 反向对照：一次真实结算必须让指纹变化，否则后面的"指纹不变"是恒真。
  const other = pendingRun(kernel, { runId: 'run-fence-write', content: 'write body', target: 'pd:fence-write', baseRevision: 2 })
  const otherGeneration = claimAny(kernel, other)
  const before = state(kernel, root)
  settleAny(kernel, other.outboxId, 'succeeded', 'real_write', otherGeneration)
  need(state(kernel, root) !== before, 'a real settlement must change the fingerprint (otherwise "no write" proves nothing)')
  return { first, second, claimedEvents: 2, reclaimedTo: rowOf(kernel, item.outboxId).status }
}, 'selfcheck')

// PFR-01 旧代回调：重新领取后，上一代的迟到回调不得结算，且必须零写入。
check('PFR-01', 'a stale generation callback must be refused with no write at all', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-fence-stale', target: 'pd:fence-stale' })
  const stale = makeReclaimable(kernel, item)
  const current = claimGeneration(kernel, item)
  need(current > stale, `the second claim must advance the generation (first=${stale}, second=${current})`)

  const before = state(kernel, root)
  const rowBefore = JSON.stringify(rowOf(kernel, item.outboxId))
  const settledBefore = settledEvents(kernel, item.outboxId).length
  const runBefore = JSON.stringify(kernel.one('SELECT status,pause_reason FROM workflow_runs WHERE id=?', item.runId))

  // 这正是 m00623 里能成功的那个调用形状：同一个 outbox id，上一代的代次。
  expectError(() => kernel.completeOutbox(item.outboxId, 'succeeded', 'stale_from_attempt_1', stale), 'outbox_claim_mismatch')

  need(JSON.stringify(rowOf(kernel, item.outboxId)) === rowBefore, 'the refused settlement must not rewrite the outbox row')
  need(settledEvents(kernel, item.outboxId).length === settledBefore, 'the refused settlement records no outbox.settled event')
  need(JSON.stringify(kernel.one('SELECT status,pause_reason FROM workflow_runs WHERE id=?', item.runId)) === runBefore, 'the refused settlement must not touch the run')
  need(state(kernel, root) === before, 'the refused stale settlement changes nothing anywhere (tables and object tree, byte for byte)')
  return { stale, current, status: rowOf(kernel, item.outboxId).status }
})

// PFR-02 当前代：同一场景用当前代次必须正常结算（证明 PFR-01 不是"一律拒绝"）。
check('PFR-02', 'the current generation still settles normally', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-fence-current', target: 'pd:fence-current' })
  makeReclaimable(kernel, item)
  const current = claimGeneration(kernel, item)
  const settledBefore = settledEvents(kernel, item.outboxId).length
  const settled = kernel.completeOutbox(item.outboxId, 'succeeded', 'current_claim', current)
  need(settled && settled.status === 'succeeded', `the current generation must settle as succeeded, got ${settled?.status}`)
  need(rowOf(kernel, item.outboxId).status === 'succeeded', 'the row records succeeded')
  need(rowOf(kernel, item.outboxId).reason === 'current_claim', `the row keeps the reason it was given, got ${rowOf(kernel, item.outboxId).reason}`)
  need(settledEvents(kernel, item.outboxId).length === settledBefore + 1, 'exactly one outbox.settled event is recorded')
  return { current, status: 'succeeded', reason: rowOf(kernel, item.outboxId).reason }
})

// PFR-03 缺失代次：失败关闭，不得默认成"当前代"，也不得从库里补。
check('PFR-03', 'settling without a generation fails closed instead of assuming the current one', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-fence-missing', target: 'pd:fence-missing' })
  claimGeneration(kernel, item)
  const before = state(kernel, root)
  const rowBefore = JSON.stringify(rowOf(kernel, item.outboxId))
  const settledBefore = settledEvents(kernel, item.outboxId).length

  // 三种缺失形状：只给三个参数、第四位 undefined、显式 null。
  for (const call of [
    () => kernel.completeOutbox(item.outboxId, 'succeeded'),
    () => kernel.completeOutbox(item.outboxId, 'succeeded', null, undefined),
    () => kernel.completeOutbox(item.outboxId, 'succeeded', null, null),
  ]) {
    expectError(call, 'outbox_claim_mismatch')
  }

  need(JSON.stringify(rowOf(kernel, item.outboxId)) === rowBefore, 'a settlement without a generation must not rewrite the row')
  need(settledEvents(kernel, item.outboxId).length === settledBefore, 'a settlement without a generation records no outbox.settled event')
  need(state(kernel, root) === before, 'a settlement without a generation changes nothing')
  return { status: rowOf(kernel, item.outboxId).status }
})

// PFR-04 非法 / 伪造代次：类型不对与超前伪造都必须失败关闭。
check('PFR-04', 'malformed and forged generations fail closed', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-fence-invalid', target: 'pd:fence-invalid' })
  const current = claimGeneration(kernel, item)
  const before = state(kernel, root)

  // 非正整数：字符串、小数、0、负数、NaN、null、布尔、数组、对象。
  for (const bad of ['2', 2.5, 0, -1, NaN, null, false, [], {}]) {
    expectError(() => kernel.completeOutbox(item.outboxId, 'succeeded', null, bad), 'outbox_claim_mismatch')
  }
  // 合法整数但不是当前代次：旧代、超前伪造。
  for (const wrong of [current - 1, current + 1, current + 1000].filter((value) => value >= 1)) {
    expectError(() => kernel.completeOutbox(item.outboxId, 'succeeded', null, wrong), 'outbox_claim_mismatch')
  }

  need(rowOf(kernel, item.outboxId).status === 'running', 'the item is still running after every refusal')
  need(state(kernel, root) === before, 'no refusal writes anything')
  return { current, status: rowOf(kernel, item.outboxId).status }
})

// PFR-05 跨 run 接管：旧项被新采用改成 outcome_unknown 后，它的代次仍在行上。
check('PFR-05', 'a superseded item settles only down to cas_conflict, never to success', ({ kernel, root }) => {
  const old = pendingRun(kernel, { runId: 'run-fence-old', content: 'old body', target: 'pd:fence-shared', baseRevision: 1 })
  const stale = claimGeneration(kernel, old)
  // 新采用接管同一目标：旧项按契约转为 outcome_unknown（待对账，不假设撤销成功）。
  const fresh = pendingRun(kernel, { runId: 'run-fence-new', content: 'new body', target: 'pd:fence-shared', baseRevision: 2 })
  need(rowOf(kernel, old.outboxId).status === 'outcome_unknown', `the taken-over item must become outcome_unknown, got ${rowOf(kernel, old.outboxId).status}`)

  const before = state(kernel, root)
  // 代次匹配：走到 cas，状态不是 running 所以是 cas_conflict（这是既有语义，不能被代次守卫改写）。
  expectError(() => kernel.completeOutbox(old.outboxId, 'succeeded', 'late', stale), 'cas_conflict')
  // 状态门槛优先：即使代次不匹配，非 running 项仍按既有状态错误拒绝。
  expectError(() => kernel.completeOutbox(old.outboxId, 'succeeded', 'late', stale + 1), 'cas_conflict')
  need(rowOf(kernel, old.outboxId).status === 'outcome_unknown', 'the superseded item stays outcome_unknown for reconciliation')
  need(state(kernel, root) === before, 'refusing a superseded settlement writes nothing')

  // 正控：新项用自己那一代可以正常结算，证明守卫只挡旧项。
  const freshGeneration = claimGeneration(kernel, fresh)
  const settled = kernel.completeOutbox(fresh.outboxId, 'succeeded', 'new_claim', freshGeneration)
  need(settled.status === 'succeeded', 'the fresh item settles with its own generation')
  return { staleStatus: rowOf(kernel, old.outboxId).status, freshGeneration }
})

// PFR-06 持久化：代次不能只活在内存里，关库重开后旧代仍被拒、当前代仍可结算。
check('PFR-06', 'the generation survives a restart', ({ kernel, root, dbPath, handles }) => {
  const item = pendingRun(kernel, { runId: 'run-fence-restart', target: 'pd:fence-restart' })
  const stale = makeReclaimable(kernel, item)
  const current = claimGeneration(kernel, item)
  kernel.db.close()
  handles.length = 0

  const reopened = openWorkflowKernel(dbPath, root)
  handles.push({ db: reopened.db })
  need(rowOf(reopened, item.outboxId).status === 'running', 'the running claim survives the restart')

  const before = state(reopened, root)
  expectError(() => reopened.completeOutbox(item.outboxId, 'succeeded', 'stale_after_restart', stale), 'outbox_claim_mismatch')
  need(state(reopened, root) === before, 'the stale generation is refused after a restart with no write')

  const settled = reopened.completeOutbox(item.outboxId, 'succeeded', 'current_after_restart', current)
  need(settled.status === 'succeeded', 'the current generation still settles after a restart')
  return { stale, current, status: rowOf(reopened, item.outboxId).status }
})

// PFR-07 对账侧代次：reconcilePublishEffect 也是一条写路径（applied 记成功 / absent 回 pending），
// 旧代迟到对账同样不得改写任何东西。
check('PFR-07', 'reconciliation also requires the current generation', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-fence-reconcile', target: 'pd:fence-reconcile' })
  const generation = claimGeneration(kernel, item)
  kernel.completeOutbox(item.outboxId, undefined, null, generation)
  need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', 'the item waits for reconciliation')

  const before = state(kernel, root)
  const rowBefore = JSON.stringify(rowOf(kernel, item.outboxId))
  const reconciledBefore = reconciledEvents(kernel, item.outboxId).length

  // 缺失 / 非法 / 非当前代次：全部失败关闭，不写盘。
  // 代次门槛在观测与证据门槛之前，所以这里不提供观测也能测到代次本身。
  for (const bad of [undefined, null, 0, '1', 1.5, generation + 1]) {
    expectError(() => kernel.reconcilePublishEffect(item.outboxId, { actorId: 'fixture-reconciler', claimGeneration: bad }), 'outbox_claim_mismatch')
  }
  need(JSON.stringify(rowOf(kernel, item.outboxId)) === rowBefore, 'a refused reconciliation must not rewrite the outbox row')
  need(reconciledEvents(kernel, item.outboxId).length === reconciledBefore, 'a refused reconciliation records no outbox.reconciled event')
  need(state(kernel, root) === before, 'a refused reconciliation changes nothing')

  // 正控：自己的代次 + 真实观测（目标已是这条发布的预期正文）可以完成对账。
  const reconciled = kernel.reconcilePublishEffect(item.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: generation,
    observe: adapter(item.baseRevision + 1, { content: item.content }).observeTarget,
  })
  need(reconciled.decision === 'applied', `observing the expected content reconciles as applied, got ${reconciled.decision}`)
  need(rowOf(kernel, item.outboxId).status === 'succeeded', 'reconciling an applied effect records succeeded with its own generation')
  return { generation, status: rowOf(kernel, item.outboxId).status }
})

// PFR-08 错误优先级：状态门槛必须早于代次门槛，否则调用方分不清"状态不对"和"代次不对"。
// 这条直接锁住 PFR-01 的拒绝理由是真的因为代次，而不是因为顺带的状态不对。
check('PFR-08', 'state gates keep priority over the generation gate', ({ kernel, root }) => {
  // 1) 未领取的 pending 项：结算报 outbox_not_claimed（PCB-09 的既有语义），不是 mismatch。
  const unclaimed = pendingRun(kernel, { runId: 'run-fence-pri-unclaimed', target: 'pd:fence-pri-unclaimed' })
  expectError(() => kernel.completeOutbox(unclaimed.outboxId, 'succeeded'), 'outbox_not_claimed')
  expectError(() => kernel.completeOutbox(unclaimed.outboxId, 'succeeded', null, 1), 'outbox_not_claimed')

  // 2) 已终结项：再用正确代次结算，报 cas_conflict（不是 mismatch）。
  const done = pendingRun(kernel, { runId: 'run-fence-pri-done', target: 'pd:fence-pri-done' })
  const doneGeneration = claimGeneration(kernel, done)
  kernel.completeOutbox(done.outboxId, 'succeeded', 'first', doneGeneration)
  expectError(() => kernel.completeOutbox(done.outboxId, 'succeeded', 'again', doneGeneration), 'cas_conflict')

  // 3) 非 unknown 项对账：报 outbox_not_reconcilable（PCB-10 的既有语义），不是 mismatch。
  expectError(() => kernel.reconcilePublishEffect(done.outboxId, { actorId: 'fixture-reconciler', claimGeneration: doneGeneration }), 'outbox_not_reconcilable')

  // 4) 已被接管的旧项：absent 对账直接落 superseded（08:110），再结算只能是 cas_conflict，
  //    且不能退化成 mismatch。
  const taken = pendingRun(kernel, { runId: 'run-fence-pri-taken', content: 'taken body', target: 'pd:fence-pri-taken', baseRevision: 1 })
  const takenGeneration = claimGeneration(kernel, taken)
  pendingRun(kernel, { runId: 'run-fence-pri-taker', content: 'taker body', target: 'pd:fence-pri-taken', baseRevision: 2 })
  need(rowOf(kernel, taken.outboxId).status === 'outcome_unknown', 'the taken-over item is outcome_unknown')
  kernel.reconcilePublishEffect(taken.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: takenGeneration,
    observe: adapter(taken.baseRevision, { content: taken.baseContent }).observeTarget,
  })
  need(rowOf(kernel, taken.outboxId).status === 'superseded', `reconciling the taken-over item lands on superseded, got ${rowOf(kernel, taken.outboxId).status}`)
  // 已落 superseded 后它仍不是当前持有者，结算必须失败关闭（状态门槛先于代次门槛）。
  expectError(() => kernel.completeOutbox(taken.outboxId, 'succeeded', 'revived', takenGeneration), 'cas_conflict')
  return { unclaimedGate: 'outbox_not_claimed', settledGate: 'cas_conflict', reconcileGate: 'outbox_not_reconcilable' }
})

const failed = results.filter((result) => result.status !== 'pass')
const spec = results.filter((result) => result.kind === 'spec')
const specFailed = spec.filter((result) => result.status !== 'pass')
const selfcheck = results.filter((result) => result.kind === 'selfcheck')
const selfcheckFailed = selfcheck.filter((result) => result.status !== 'pass')
process.stdout.write(`${JSON.stringify({
  checks: results.length,
  passed: results.length - failed.length,
  assertions,
  specChecks: spec.length,
  specFailed: specFailed.length,
  selfcheckChecks: selfcheck.length,
  selfcheckFailed: selfcheckFailed.length,
  results,
}, null, 2)}\n`)
// 自检项若红，说明"零副作用"的证据本身失效，必须与非红测一样失败。
process.exitCode = specFailed.length === 0 && selfcheckFailed.length === 0 ? 0 : 1
