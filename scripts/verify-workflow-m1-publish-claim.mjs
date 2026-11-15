// W1 发布领取（claim）契约专项（happy-4.1 独立复核，2026-11-14）。
// 全程临时 SQLite + 临时根目录，不碰生产库、不发 HTTP、不调真实模型。
//
// 本文件先是"契约先行"的红测（claimOutbox 不存在时 PCB-01…09 全红），领取阶段落地后转为回归基线；
// PCB-10/PCB-11 是 2026-11-14 独立评审查出的两处缺口，落地前应保持红。
//
// 契约（本批冻结的范围，来自 08-storage-migration.md:66-77 与 :116）：
//   claimOutbox(outboxId, { observe }) 在任何写盘之前复核三件事：
//     1) 采用仍是当前、步骤未 stale、run 未终结/未取消（否则拒绝，不写盘）
//     2) 目标基准仍等于 base_revision —— 基准值必须来自适配器实际观测（observe 端口），
//        不接受调用方直接传数字，否则等于拿请求参数和请求参数比。
//     3) 状态只能 pending → running；重复领取拒绝。
//   结算侧同样要关门：未经领取的 pending 行不得被 completeOutbox 记成功（PCB-09）。
//   拒绝一律零副作用：全库用户表指纹 + objects/、manifests/、staging/ 下每一条相对路径、
//   字节数、文件内容 sha256 全部不变。只比路径不算证据，PCB-00 对这份指纹做
//   "同路径、同字节数、改一个字节"的篡改自检。
//
// 范围边界（不得据此宣称竞态已解决）：observe 是本批同步假适配器的观测端口，只覆盖
// "领取前读一次基准"。"读取基准 → 写入目标"之间目标被第三方改写的竞态不在本专项内，
// 属 M0-B 真宿主门，本文件不提供任何证据。
//
// observe 契约（2026-11-14 冻结）：同步、只读、无副作用的适配器钩子。它跑在领取事务里，
// 因此回调中若调用内核写接口，会与领取同事务提交 / 随领取失败一起回滚；回调只应做一次外部读取。
// baseRevision 取值范围：03-node-contract-runtime.md:20 只写"可选，显式声明"，实现 adopt 缺省 1；
// 本专项不锁定下界（0 / 负数现状可通过），待契约澄清后再补断言。

// 领域码提案（全部走 DOMAIN_TO_SERVICE 折叠到冻结的 SERVICE_ERROR_CODES，不新增服务码）：
//   outbox_not_found            → artifact_missing
//   outbox_not_claimable        → publish_conflict   （状态不是 pending，无法领取）
//   outbox_already_claimed      → publish_conflict   （已是 running，重复领取）
//   outbox_superseded           → publish_conflict   （采用已非当前 / 步骤已 stale / 同目标已有更新的声明）
//   outbox_not_claimed          → publish_conflict   （结算侧：未经领取不得登记结果）
//   publish_observation_required→ schema_invalid     （观测端口缺失或观测值无效：这是调用方给错了东西）
//   publish_base_mismatch       → publish_conflict   （观测到目标已偏离基准）
//   target_unavailable          → capability_unavailable（适配器异常 / 读不到目标：外部故障，不是输入错）
//   run_not_claimable 已由既有表覆盖。PCB-12 在服务出口锁住这条分界，实现里漏映射会转红。
//
// 目标资格（2026-11-14 第三轮复核）：旧项在对账回 pending 后不得重新获得发布资格（PCB-13）。
// 实现当前用"同目标按 rowid 最后一条发布声明持有资格"来判定，这等价于要求 outbox 是只增账本：
// rowid 一旦被删除或重排，判定就会翻转，旧内容可能被写到新采用已经占用的目标上。
// PCB-14 因此不检查源码有没有删除语句，而是真的按 id 重建 outbox 表（备份恢复 / schema 迁移的
// 常见写法：行内容完全一致、只有物理顺序变），再要求旧项仍被拒绝、新项仍可领取。
// 正确的修法是显式归属记录（每 target 一行持有者，随采用写入、不随行顺序变化），
// 而不是从 rowid 反推历史；PCB-14 转为绿即表示资格不再依赖物理顺序。
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkflowKernel, RECOVERY_KINDS } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../src/workflow/m1-fake-service.mjs'

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

const RED_REASON = 'claim phase missing: kernel.claimOutbox is not implemented (发布路径没有领取阶段，本项必红)'
const claimPhase = () => globalThis.__claimPhase ?? 'missing'
// 独立计算的原文摘要：不经过内核 hash()，避免实现与测试共用同一个错误。
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const specGuard = (kernel) => {
  const implemented = typeof kernel.claimOutbox === 'function'
  globalThis.__claimPhase = implemented ? 'implemented' : 'missing'
  need(implemented, RED_REASON)
}
const claimOutbox = (kernel, id, options) => {
  need(typeof kernel.claimOutbox === 'function', RED_REASON)
  return kernel.claimOutbox(id, options)
}

const check = (id, title, fn, kind = 'spec') => {
  const root = mkdtempSync(join(tmpdir(), `m1-pub-${id}-`))
  const handles = []
  try {
    const kernel = createWorkflowKernel(new DatabaseSync(join(root, 'workflow.sqlite')), root)
    handles.push(kernel)
    const detail = fn({ kernel, root })
    results.push({ id, kind, title, status: 'pass', detail: detail ?? null })
  } catch (error) {
    results.push({ id, kind, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    for (const item of handles) { try { item.db.close() } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
}

// 零副作用指纹覆盖库里所有用户表（动态发现，新增表自动纳入，不靠手工维护清单）。
const tablesOf = (kernel) => kernel.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name)
const fingerprint = (kernel) => kernel.hash(JSON.stringify(tablesOf(kernel).map((table) => ({ table, rows: kernel.query(`SELECT * FROM ${table} ORDER BY rowid`) }))))
// 目录指纹 = 每条相对路径 + 字节数 + 内容 sha256。只用路径无法证明"逐字节不变"，
// PCB-00 用同路径同长度的字节篡改自检这份指纹确实能检出内容改动。
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
const pathsOf = (tree) => tree.map((entry) => entry.path)
const state = (kernel, root) => `${fingerprint(kernel)}|${JSON.stringify(objectTree(root))}`

// 假适配器：目标基准由它实际观测，claim 只能通过这个端口取值。
// content 是"目标此刻的真实正文"，不传就退化成旧 revision-only 观测（旧夹具语义不变）；
// 需要内容证据的项一律显式给 content，摘要由夹具自己算，绝不从 outbox 反填。
const adapter = (revision, { fail = null, content = null } = {}) => {
  const calls = []
  return {
    calls,
    observeTarget: (target) => {
      calls.push(target)
      if (fail) throw Object.assign(new Error(fail), { code: fail })
      return { target, revision, ...(content === null ? {} : { contentHash: sha256(content) }), observedAt: new Date().toISOString() }
    },
  }
}

// 一个单步自动 run：采用 + 带 target 的 pending outbox，run 因必需发布未终结而保持未完成。
const pendingRun = (kernel, { runId = 'run-claim', content = 'claim fixture', target = 'file:claim', baseRevision = 7, required = true, baseContent = null, targetKind = null } = {}) => {
  // 冻结契约要求节点显式声明发布目标与校验检查；本夹具的 run 只有这一步、只发这一个目标。
  kernel.createRun({ id: runId, steps: [{ nodeId: 'fake.transform', nodeKind: 'automatic', requiredChecks: [], publishTargets: [{ target, required }] }], input: { fixture: true } })
  const attempt = kernel.claim(runId)
  const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content })
  // baseContent 来自独立目标夹具（不是从 outbox 反填）：给需要完整内容证据的用例用。
  const adoption = kernel.adopt({
    attemptId: attempt.attemptId, token: attempt.token, candidate, target, baseRevision, required,
    ...(baseContent === null ? {} : { baseContentHash: sha256(baseContent), targetKind }),
  })
  const row = kernel.one('SELECT * FROM workflow_outbox WHERE adoption_id=?', adoption.adoptionId)
  return { runId, attempt, candidate, adoption, outboxId: row.id, target, baseRevision }
}

// PCB-00 自检（本项应始终为绿）：目录指纹必须检出"同路径、同字节数、只改内容"的篡改。
// 篡改对象用 adopt 真实写出的对象文件，不是随手造的临时文件，保证测的是实际发布产物。
check('PCB-00', 'the directory fingerprint detects same-path same-length content tampering', ({ kernel, root }) => {
  pendingRun(kernel, { runId: 'run-claim-detect' })
  const before = objectTree(root)
  need(pathsOf(before).some((path) => path.startsWith('objects/')), 'the fixture wrote a real object file worth fingerprinting')
  const victim = before.find((entry) => entry.path.startsWith('objects/'))
  const absolute = join(root, victim.path)
  const original = readFileSync(absolute)
  need(original.length === victim.bytes, 'the recorded byte count matches the file on disk')

  // 同路径、同长度：翻转首字节（可打印 ASCII，不会因编码或长度差异被顺带发现）。
  const tampered = Buffer.from(original)
  tampered[0] = tampered[0] === 0x41 ? 0x42 : 0x41
  need(tampered.length === original.length, 'the tampered copy keeps the same byte length')
  writeFileSync(absolute, tampered)
  const after = objectTree(root)
  need(JSON.stringify(pathsOf(after)) === JSON.stringify(pathsOf(before)), 'the tamper keeps every path identical')
  need(after.find((entry) => entry.path === victim.path).bytes === victim.bytes, 'the tamper keeps the byte count identical')
  need(JSON.stringify(after) !== JSON.stringify(before), 'the fingerprint changes when one byte changes in place')
  need(after.find((entry) => entry.path === victim.path).sha256 !== victim.sha256, 'the per-file content hash is what changed')

  // 复原同一批字节必须回到原指纹：证明比较是逐字节的，不是 mtime/随机噪声。
  writeFileSync(absolute, original)
  need(JSON.stringify(objectTree(root)) === JSON.stringify(before), 'restoring the exact bytes restores the fingerprint')
  return { victim: victim.path, bytes: victim.bytes }
}, 'selfcheck')

// PCB-01 当前采用 + 观测基准一致：允许领取，且必须真的问过适配器。
check('PCB-01', 'current adoption with matching observed base may be claimed exactly once', ({ kernel, root }) => {
  specGuard(kernel)
  const item = pendingRun(kernel)
  const observe = adapter(item.baseRevision)
  const treeBefore = objectTree(root)
  const claimed = claimOutbox(kernel, item.outboxId, { observe: observe.observeTarget })
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'running', 'claim moves the item from pending to running')
  need(observe.calls.length === 1 && observe.calls[0] === item.target, 'claim asks the adapter to observe the declared target, exactly once')
  // 领取只是许可，不是执行：不写盘、不建 attempt/snapshot/adoption。
  need(JSON.stringify(objectTree(root)) === JSON.stringify(treeBefore), 'claim writes no object, manifest or staging file (content-hashed, not just paths)')
  need(kernel.query('SELECT id FROM workflow_attempts').length === 1, 'claim creates no additional attempt')
  need(kernel.query('SELECT id FROM workflow_snapshots').length === 1, 'claim creates no additional snapshot')
  need(kernel.query('SELECT id FROM workflow_adoptions').length === 1, 'claim creates no additional adoption')
  need(claimed && claimed.status === 'running', 'claim reports the item as running')
  return { outboxId: item.outboxId }
})

// PCB-02 步骤 stale（恢复/上游变更把 pending 留在原地）：不得领取。
check('PCB-02', 'a stale step must not claim its pending publish', ({ kernel, root }) => {
  specGuard(kernel)
  const item = pendingRun(kernel)
  // 这是 markDownstreamStale 留下的可达状态：步骤 stale、outbox 仍 pending（08:116 的断点）。
  kernel.db.exec(`UPDATE workflow_steps SET stale=1, state='stale' WHERE id='${item.attempt.stepId ?? `${item.runId}:step:1`}'`)
  const observe = adapter(item.baseRevision)
  const before = state(kernel, root)
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: observe.observeTarget }), 'outbox_superseded')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'pending', 'a refused claim leaves the item pending')
  need(state(kernel, root) === before, 'a refused claim on a stale step changes nothing')
})

// PCB-03 取消失败面：cancelRun 把 pending 作废后不得再领取；把行强行改回 pending 也必须被拦。
check('PCB-03', 'a cancelled run must not claim, even if a pending row survives', ({ kernel, root }) => {
  specGuard(kernel)
  const item = pendingRun(kernel)
  kernel.cancelRun(item.runId)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'superseded', 'cancelRun supersedes the unclaimed publish')
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: adapter(item.baseRevision).observeTarget }), 'outbox_not_claimable')

  // 防御性：竞态/恢复可能留下 pending 行，run 状态本身必须是第二道门。
  kernel.db.prepare("UPDATE workflow_outbox SET status='pending' WHERE id=?").run(item.outboxId)
  const observe = adapter(item.baseRevision)
  const before = state(kernel, root)
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: observe.observeTarget }), 'run_not_claimable')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'pending', 'the guard refuses without rewriting the row')
  need(state(kernel, root) === before, 'refusing a cancelled run changes nothing')
})

// PCB-04 领取后取消：已发起的发布不能假设撤销成功，转 outcome_unknown，且不能再次领取。
check('PCB-04', 'cancelling after a claim turns the item into outcome_unknown, not pending', ({ kernel, root }) => {
  specGuard(kernel)
  const item = pendingRun(kernel, { runId: 'run-claim-cancel' })
  claimOutbox(kernel, item.outboxId, { observe: adapter(item.baseRevision).observeTarget })
  kernel.cancelRun(item.runId)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'outcome_unknown', 'a claimed publish becomes outcome_unknown on cancel')
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: adapter(item.baseRevision).observeTarget }), 'outbox_not_claimable')
  const before = state(kernel, root)
  expectError(() => kernel.retryOutbox(item.outboxId), 'outbox_requires_reconcile')
  need(state(kernel, root) === before, 'retrying an unknown publish is refused with no side effects')
})

// PCB-05 重复领取：第二次必须拒绝，running 行数恰为 1。
check('PCB-05', 'a second claim is refused and exactly one row is running', ({ kernel, root }) => {
  specGuard(kernel)
  const item = pendingRun(kernel, { runId: 'run-claim-twice' })
  const firstClaim = claimOutbox(kernel, item.outboxId, { observe: adapter(item.baseRevision).observeTarget })
  const before = state(kernel, root)
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: adapter(item.baseRevision).observeTarget }), 'outbox_already_claimed')
  need(state(kernel, root) === before, 'the duplicate claim changes nothing')
  need(Number(kernel.one("SELECT COUNT(*) AS n FROM workflow_outbox WHERE status='running'").n) === 1, 'exactly one running publish exists')
  // 领取后可结算：running 属可结算状态，登记不得因为多了领取阶段而拒绝。
  kernel.completeOutbox(item.outboxId, 'succeeded', null, firstClaim.claimGeneration)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'succeeded', 'a claimed publish can still be settled')
})

// PCB-06 观测端口：必须由适配器实际观测；缺观测、观测值无效或适配器失败都拒绝，且零副作用。
check('PCB-06', 'claim requires a real adapter observation, never the request parameters alone', ({ kernel, root }) => {
  specGuard(kernel)
  const item = pendingRun(kernel, { runId: 'run-claim-observe' })
  const before = state(kernel, root)
  expectError(() => claimOutbox(kernel, item.outboxId, {}), 'publish_observation_required')
  // 直接传数字等于拿请求参数和自己比，必须同样拒绝。
  expectError(() => claimOutbox(kernel, item.outboxId, { observedBase: item.baseRevision }), 'publish_observation_required')
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: adapter(item.baseRevision, { fail: 'target_unavailable' }).observeTarget }), 'target_unavailable')
  // 观测必须点名本次发布的那个目标：返回别处的版本等于没观测到目标。
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: () => ({ target: 'pd:some-other-target', revision: item.baseRevision }) }), 'publish_observation_required')
  // 版本必须是可比较的安全整数：字符串、小数、NaN、null、缺失都不算"有效版本"。
  for (const bad of ['7', 7.5, Number.NaN, null, undefined]) {
    expectError(() => claimOutbox(kernel, item.outboxId, { observe: () => ({ target: item.target, revision: bad }) }), 'publish_observation_required')
  }
  // 观测端口返回空对象（既无目标也无版本）同样拒绝。
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: () => ({}) }), 'publish_observation_required')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'pending', 'refusals leave the item pending')
  need(state(kernel, root) === before, 'all observation refusals change nothing')
})

// PCB-12 适配器故障必须归到"目标不可用"，不能折叠成输入非法。
// observe 是只读钩子：它抛错意味着读不到目标，不是调用方填错了参数。混成 schema_invalid
// 会让界面把外部故障显示成用户错误，也会让人误以为重试请求参数就能好。
check('PCB-12', 'an adapter failure surfaces as target_unavailable, never as an input error', ({ kernel, root }) => {
  specGuard(kernel)
  // 服务出口现在要求完整内容证据（08:109）：给该用例一条带基准的记录，
  // 否则会先被证据守卫拒绝，测不到适配器故障的映射。
  const item = pendingRun(kernel, { runId: 'run-claim-adapter-fail', baseContent: 'claim base', targetKind: 'raw_text' })
  const before = state(kernel, root)
  // 普通 Error（适配器离线、超时）必须被折叠成领域码 target_unavailable。
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: () => { throw new Error('adapter offline') } }), 'target_unavailable')
  // 适配器自带领域码时原样透出，不被覆盖。
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: adapter(item.baseRevision, { fail: 'target_unavailable' }).observeTarget }), 'target_unavailable')
  // 非同 Error 的抛出（字符串）也不能裸奔成内核异常。
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: () => { throw 'adapter offline' } }), 'target_unavailable')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'pending', 'an adapter failure leaves the item pending')
  need(state(kernel, root) === before, 'an adapter failure changes nothing')

  // 出口侧：工具面看到的原因码必须是"能力不可用"，不能与"参数非法"同码。
  // 内核码正确但服务层漏映射时，界面仍会把外部故障显示成用户填错了东西。
  // 适配器故障现在只能由服务自己的目标适配器产生（host.publish 不再接收调用方观测）。
  const serviceFailure = (thrown) => {
    const service = createFakeBusinessService({ kernel, targetAdapter: { read: () => { throw thrown }, write: () => ({ status: 'failed' }) } })
    service.registerPrincipal({ id: 'sched-claim', kind: 'scheduler' })
    try {
      service.host.publish({ principal: 'sched-claim', outboxId: item.outboxId })
      return null
    } catch (error) {
      return error
    }
  }
  for (const [label, thrown] of [
    ['a plain Error', new Error('adapter offline')],
    ['a bare string throw', 'adapter offline'],
    ['a domain code', Object.assign(new Error('offline'), { code: 'target_unavailable' })],
  ]) {
    const failure = serviceFailure(thrown)
    need(failure !== null, `publishing must fail when the adapter throws ${label}`)
    need(failure.code === 'capability_unavailable', `an adapter failure must surface as capability_unavailable at the service exit, got ${failure.code} (detail ${failure.detail})`)
    need(failure.detail === 'target_unavailable', `the service exit keeps the domain reason for ${label}, got ${failure.detail}`)
  }
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'pending', 'service-level adapter failures leave the item pending')
})

// PCB-07 基准不符：拒绝，行留 pending 供重试，零副作用。
check('PCB-07', 'a drifted target base refuses the claim and keeps the row pending', ({ kernel, root }) => {
  specGuard(kernel)
  // 基准是内容证据（08:109）：漂移必须表现为目标内容不再是采用的基准正文。
  const item = pendingRun(kernel, { runId: 'run-claim-drift', baseContent: 'claim drift base', targetKind: 'raw_text' })
  const before = state(kernel, root)
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: adapter(item.baseRevision, { content: 'drifted body' }).observeTarget }), 'publish_base_mismatch')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'pending', 'a base mismatch leaves the item pending')
  need(state(kernel, root) === before, 'a base mismatch changes nothing')
  // 观测回到基准后仍可领取（拒绝不能把行锁死）。
  claimOutbox(kernel, item.outboxId, { observe: adapter(item.baseRevision, { content: 'claim drift base' }).observeTarget })
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'running', 'the same row can be claimed once the base matches again')
})

// PCB-08 采用不再是当前（恢复/竞态的防御面）：不得领取。
check('PCB-08', 'a superseded current adoption refuses the claim', ({ kernel, root }) => {
  specGuard(kernel)
  const item = pendingRun(kernel, { runId: 'run-claim-current' })
  // 防御性构造：正常路径里同 target 新采用会把旧项置 superseded，这里模拟"行仍是 pending、
  // 但 current_adoption_id 已指向别处"的残留状态（恢复路径的已知缺口）。
  kernel.db.prepare("UPDATE workflow_steps SET current_adoption_id='run-claim-current:step:1:adoption:99' WHERE id=?").run(`${item.runId}:step:1`)
  const observe = adapter(item.baseRevision)
  const before = state(kernel, root)
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: observe.observeTarget }), 'outbox_superseded')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'pending', 'the refusal does not rewrite the row')
  need(state(kernel, root) === before, 'a superseded current adoption changes nothing')
  need(observe.calls.length === 0, 'ownership is checked before touching the target')
})

// PCB-09 绕过领取的直接结算必须被结算路径自己拒绝。
// 这里刻意不写"claimOutbox 存在就算缺口已关闭"——加一个函数不会让本项转绿；
// 只有 completeOutbox 对未经领取的 pending 行关门，本项才会转绿。
check('PCB-09', 'settling a publish that was never claimed is refused by the settle path itself', ({ kernel, root }) => {
  // 场景一：健康步骤、行仍 pending（正常发布路径未经领取就登记结果）。
  const healthy = pendingRun(kernel, { runId: 'run-claim-bypass', content: 'bypass fixture' })
  const beforeHealthy = state(kernel, root)
  expectError(() => kernel.completeOutbox(healthy.outboxId, 'succeeded'), 'outbox_not_claimed')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', healthy.outboxId).status === 'pending', 'the refused bypass leaves the row pending')
  need(state(kernel, root) === beforeHealthy, 'the refused healthy bypass writes nothing (content-hashed tree)')

  // 场景二：步骤已 stale（markDownstreamStale 留下的断点，08-storage-migration.md:116）。
  // 现状是这条过期采用会被直接记成 succeeded，这正是缺口本身。
  const stale = pendingRun(kernel, { runId: 'run-claim-bypass-stale', content: 'bypass fixture 2', target: 'file:claim-stale' })
  kernel.db.exec("UPDATE workflow_steps SET stale=1, state='stale' WHERE run_id='run-claim-bypass-stale'")
  const beforeStale = state(kernel, root)
  expectError(() => kernel.completeOutbox(stale.outboxId, 'succeeded'), 'outbox_not_claimed')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', stale.outboxId).status === 'pending', 'no guard exists before the result is registered')
  need(state(kernel, root) === beforeStale, 'the refused stale bypass writes nothing (content-hashed tree)')
  const events = kernel.query('SELECT type FROM workflow_events WHERE run_id=? ORDER BY seq', stale.runId).map((row) => row.type)
  need(!events.some((type) => type === 'outbox.settled'), 'an unclaimed publish is never recorded as settled')
  need(!events.some((type) => type === 'outbox.claimed'), 'and nothing claims it implicitly on the way in')
  return { bypassVectors: ['healthy pending', 'stale pending'] }
})

// PCB-10 已领取的发布会话不得被同目标的新采用静默作废。
// 08-storage-migration.md:75：「被替换的旧采用将未执行任务记 superseded…已发起的文件 / 外部操作
// 先对账，不能假设撤销成功」。取消路径（cancelRun）已经是 pending→superseded / running→
// outcome_unknown，本项要求 adoptTx 的 supersede 分支与之同构。
// 注意本项不只断言"没有变成 superseded"：旧项必须落在可对账状态，并且真的能被
// reconcilePublishEffect 收口——扫得到但收不了口属于另一个缺口（PCB-11 只管发现）。
check('PCB-10', 'a claimed publish is quarantined for reconciliation, not silently superseded', ({ kernel, root }) => {
  specGuard(kernel)
  const shared = 'pd:claim-shared'
  const first = pendingRun(kernel, { runId: 'run-claim-a', content: 'run a body', target: shared, baseRevision: 1, baseContent: 'run a base', targetKind: 'raw_text' })
  const firstClaim = claimOutbox(kernel, first.outboxId, { observe: adapter(first.baseRevision, { content: 'run a base' }).observeTarget })
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', first.outboxId).status === 'running', 'the first run holds a claimed publish')

  // 第二个运行对同一目标键采用：旧项已发起，不能被当成"未执行"直接抹掉。
  const second = pendingRun(kernel, { runId: 'run-claim-b', content: 'run b body', target: shared, baseRevision: 1 })
  const oldRow = kernel.one('SELECT status,reason FROM workflow_outbox WHERE id=?', first.outboxId)
  need(oldRow.status === 'outcome_unknown', `a claimed publish must be quarantined for reconciliation, got ${oldRow.status}`)
  need(typeof oldRow.reason === 'string' && oldRow.reason.length > 0, 'the quarantine records why the item is unresolved')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', second.outboxId).status === 'pending', 'the newer adoption still gets its own pending publish')

  // 已发起 = 外部可能已经写入：观测到目标已是这条发布的预期正文，才允许补记成功，且不能再发一次。
  // 注意这是"实际成功"，与"被取代"并不互斥：applied 一律记成功，取代事实留在审计里。
  const reconciled = kernel.reconcilePublishEffect(first.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: firstClaim.claimGeneration,
    observe: adapter(first.baseRevision + 1, { content: 'run a body' }).observeTarget,
  })
  need(reconciled.decision === 'applied', `the quarantined item reconciles as applied when the write is observed, got ${reconciled.decision}`)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', first.outboxId).status === 'succeeded', 'an applied reconciliation records the write as done')
  need(kernel.one('SELECT reason FROM workflow_outbox WHERE id=?', first.outboxId).reason === 'effect_applied', `an applied reconciliation carries a success reason, got ${kernel.one('SELECT reason FROM workflow_outbox WHERE id=?', first.outboxId).reason}`)
  const events = kernel.query('SELECT type FROM workflow_events WHERE run_id=? ORDER BY seq', first.runId).map((row) => row.type)
  need(events.includes('outbox.effect_reconciled'), 'the observation and the decision are recorded as one event')

  // 反例：对账为 not_published 时绝不能记成功，且对账入口只能开一次。
  const third = pendingRun(kernel, { runId: 'run-claim-c', content: 'run c body', target: 'pd:claim-shared-2', baseRevision: 1, baseContent: 'run c base', targetKind: 'raw_text' })
  const thirdClaim = claimOutbox(kernel, third.outboxId, { observe: adapter(third.baseRevision, { content: 'run c base' }).observeTarget })
  pendingRun(kernel, { runId: 'run-claim-d', content: 'run d body', target: 'pd:claim-shared-2', baseRevision: 1 })
  const quarantined = kernel.one('SELECT status FROM workflow_outbox WHERE id=?', third.outboxId).status
  need(quarantined === 'outcome_unknown', `a claimed publish must be quarantined before reconciliation, got ${quarantined}`)
  // 目标仍是基准 → absent；但这一项已被 run-d 接管，absent 也不许回 pending（08:110）。
  kernel.reconcilePublishEffect(third.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: thirdClaim.claimGeneration,
    observe: adapter(third.baseRevision, { content: 'run c base' }).observeTarget,
  })
  const afterRetract = kernel.one('SELECT status FROM workflow_outbox WHERE id=?', third.outboxId).status
  need(afterRetract === 'superseded', `an absent reconciliation of a superseded item lands on superseded, got ${afterRetract}`)
  need(afterRetract !== 'succeeded', 'a retracted publish is never recorded as done')
  expectError(() => kernel.reconcilePublishEffect(third.outboxId, { actorId: 'fixture-reconciler', claimGeneration: thirdClaim.claimGeneration }), 'outbox_not_reconcilable')
  return { firstRunQuarantine: oldRow.status, retractedStatus: afterRetract }
})

// PCB-11 领取后崩溃 / 被作废的 running 项必须能被发现。
// 08-storage-migration.md:81：「宿主启动扫描 staging、未引用对象、未结 Attempt 和 outbox」。
// 本项只要求"扫得到、ID 准确、扫描是纯读"——发现机制不等于恢复闭环，
// 明确的恢复对账入口另行排期，不得用本项通过来宣称恢复已可用。
check('PCB-11', 'the recovery scan reports a claimed running item by its own id without mutating state', ({ kernel, root }) => {
  specGuard(kernel)
  const running = pendingRun(kernel, { runId: 'run-scan-running', target: 'pd:scan-running', baseRevision: 1 })
  claimOutbox(kernel, running.outboxId, { observe: adapter(running.baseRevision).observeTarget })
  const idle = pendingRun(kernel, { runId: 'run-scan-pending', target: 'pd:scan-pending', baseRevision: 1 })

  const before = state(kernel, root)
  const scanClock = '2026-11-14T00:00:00.000Z'
  const scan = kernel.scanRecoverable({ now: scanClock })
  const snapshot = JSON.stringify(scan)
  const entries = scan.items.filter((item) => item.outboxId === running.outboxId)
  need(entries.length === 1, `the scan must report the running publish exactly once, got ${entries.length}`)
  const [entry] = entries
  need(entry.target === running.target, 'the reported entry names the real target')
  need(entry.runId === running.runId, 'the reported entry names the owning run')
  need(entry.kind !== 'outbox_pending', `a claimed publish must not be reported as pending, got ${entry.kind}`)
  // 扫得出不够：扫描结果必须是导出契约里声明过的 kind，否则消费方按 RECOVERY_KINDS 过滤时
  // 这条 running 记录会被静默丢掉，等于"扫到了但用不上"。
  need(RECOVERY_KINDS.includes(entry.kind), `the reported kind must be declared in RECOVERY_KINDS, got ${entry.kind}`)

  // 未领取的必需发布仍按 pending 报：两种生命周期不能共用同一个标签。
  const pendingEntries = scan.items.filter((item) => item.outboxId === idle.outboxId)
  need(pendingEntries.length === 1, 'the unclaimed required publish is still reported once')
  need(pendingEntries[0].kind !== entry.kind, 'claimed and unclaimed publishes carry distinct labels')

  // 扫描是纯读：同一时钟再扫一次结果一模一样，全库用户表与对象树逐字节不变。
  // 时钟必须钉住，否则 scannedAt 跨毫秒就会让这条断言随机红（本文件早期版本就栽在这）。
  need(JSON.stringify(kernel.scanRecoverable({ now: scanClock })) === snapshot, 'a second scan with the same clock returns the same list')
  need(kernel.scanRecoverable({ now: scanClock }).scannedAt === scanClock, 'the scan echoes the clock it was given')
  need(state(kernel, root) === before, 'scanning changes no row and no file (content-hashed tree)')
  return { runningKind: entry.kind, pendingKind: pendingEntries[0].kind }
})

// PCB-13 目标被新采用接管后，旧项不能再获得发布资格。
// absent 对账的语义是"外部确认没写出去"，它只让这一条结论落定；08:110 之后它也不再是
// "放回 pending 的窗口"，而是直接落 superseded。本项因此锁两件事：
//   1) 主线：被接管项 absent 对账落 superseded，不再回 pending；
//   2) 归属反例：即使把行**强制构造成旧的 pending 形状**（历史库/旧版本遗留，本批之前唯一
//      可能的形态），领取也必须在观测端口之前就以 outbox_superseded 拒绝——资格来自归属，
//      不来自该行当前的 status，也不来自目标版本恰好等于旧基准。
check('PCB-13', 'a reconciled item cannot regain publish rights over a target a newer adoption took', ({ kernel, root }) => {
  specGuard(kernel)
  const shared = 'pd:claim-takeover'
  const stale = pendingRun(kernel, { runId: 'run-takeover-old', content: 'old body', target: shared, baseRevision: 1, baseContent: 'old base', targetKind: 'raw_text' })
  const staleClaim = claimOutbox(kernel, stale.outboxId, { observe: adapter(stale.baseRevision, { content: 'old base' }).observeTarget })
  // 新 run 在同一目标上采用并发布：旧项被隔离（PCB-10 已锁），这里只作为前因。
  const fresh = pendingRun(kernel, { runId: 'run-takeover-new', content: 'new body', target: shared, baseRevision: 2 })
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', stale.outboxId).status === 'outcome_unknown', 'the superseded item starts quarantined')
  // 归属反例先做：强制构造旧 pending 形状（本批之前的唯一形态，历史库与旧会话行都可能长这样）。
  // 这一步是场景构造，不是实现能力——本批没有任何入口能把已隔离的项改回 pending。
  // 此时旧 run 仍是 paused（publish_outcome_unknown），所以拒绝只能来自归属而不是"运行已关闭"。
  kernel.db.prepare("UPDATE workflow_outbox SET status='pending', reason=NULL WHERE id=?").run(stale.outboxId)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', stale.outboxId).status === 'pending', 'the fixture really reconstructed the legacy pending shape')
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-takeover-old').status === 'running', 'the legacy-shaped item still belongs to an open run, so run closure cannot explain a refusal')

  // 关键场景：目标被回滚到旧基准（版本又变回 1）。只比版本的话这里会放行。
  const watch = adapter(stale.baseRevision)
  const before = state(kernel, root)
  const eventsBefore = kernel.query("SELECT id FROM workflow_events WHERE type='outbox.claimed'").length
  expectError(() => claimOutbox(kernel, stale.outboxId, { observe: watch.observeTarget }), 'outbox_superseded')
  need(watch.calls.length === 0, `the takeover refusal must be decided before the target is observed, adapter was asked ${watch.calls.length} time(s)`)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', stale.outboxId).status === 'pending', 'the refused item stays pending, not running')
  need(kernel.query("SELECT id FROM workflow_events WHERE type='outbox.claimed'").length === eventsBefore, 'no claim is recorded for the refused item')
  need(state(kernel, root) === before, 'refusing the stale item changes nothing')

  // 正向对照：接管者本身仍能正常领取——拒绝的是旧项，不是把这一格一起打死。
  const claimed = claimOutbox(kernel, fresh.outboxId, { observe: adapter(2).observeTarget })
  need(claimed.status === 'running', 'the newer adoption keeps its own publish rights')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', stale.outboxId).status === 'pending', 'claiming the newer item does not revive the older one')

  // 主线：把行还原成被隔离的形状，absent 对账也不许回 pending，必须直接落 superseded（08:110）。
  kernel.db.prepare("UPDATE workflow_outbox SET status='outcome_unknown', reason='superseded_while_running' WHERE id=?").run(stale.outboxId)
  kernel.reconcilePublishEffect(stale.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: staleClaim.claimGeneration,
    observe: adapter(stale.baseRevision, { content: 'old base' }).observeTarget,
  })
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', stale.outboxId).status === 'superseded', `an absent reconciliation of a superseded item lands on superseded, got ${kernel.one('SELECT status FROM workflow_outbox WHERE id=?', stale.outboxId).status}`)

  // 接管者自己被取消：资格仍然留在它那条记录上，旧项不得因此复活。
  // 判定只看"同目标最后一条声明"，不看那条声明现在什么状态——这是有意的：
  // 按状态放开等于让"新采用被取消"变成旧内容重新发布的跳板。
  const taken = 'pd:claim-takeover-cancelled'
  const oldOne = pendingRun(kernel, { runId: 'run-gate-old', content: 'old gate body', target: taken, baseRevision: 1, baseContent: 'old gate base', targetKind: 'raw_text' })
  const oldOneClaim = claimOutbox(kernel, oldOne.outboxId, { observe: adapter(1, { content: 'old gate base' }).observeTarget })
  pendingRun(kernel, { runId: 'run-gate-new', content: 'new gate body', target: taken, baseRevision: 2 })
  kernel.cancelRun('run-gate-new')
  kernel.db.prepare("UPDATE workflow_outbox SET status='pending', reason=NULL WHERE id=?").run(oldOne.outboxId)
  const afterCancel = adapter(1)
  expectError(() => claimOutbox(kernel, oldOne.outboxId, { observe: afterCancel.observeTarget }), 'outbox_superseded')
  need(afterCancel.calls.length === 0, `a cancelled takeover still blocks before observation, adapter was asked ${afterCancel.calls.length} time(s)`)

  // 旧运行没有被对账收口，因此仍停在 running——它不会因为"目标被别人接管"就自动结束。
  const oldRun = kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-gate-old')
  need(oldRun.status === 'running', `an un-reconciled takeover keeps its run open, got ${oldRun.status}`)
  // 但那一行仍被发现（强制构造成 pending 后）：扫描按状态照实报告，不替它猜归属。
  const visible = kernel.scanRecoverable().items.filter((entry) => entry.outboxId === oldOne.outboxId)
  need(visible.length === 1 && visible[0].kind === 'outbox_pending', 'the reconstructed legacy pending row is still discoverable by the recovery scan')
  return { staleCalls: watch.calls.length, fresh: claimed.status, cancelledGateCalls: afterCancel.calls.length, oldRun: oldRun.status, blockedKind: visible[0].kind }
})

// PCB-14 行为红测：目标资格不能挂在 outbox 的物理行序上。
// 场景是真的按 id 重建 workflow_outbox（备份恢复 / schema 迁移常见写法）：行内容逐字段不变，
// 只有 rowid 顺序翻转。重建前旧项被拒（基线），重建后必须仍然被拒；新项必须仍能领取。
// 如果资格是从"同目标最后一行"反推的，重建后旧项就复活了——本项在这个点上转红。
check('PCB-14', 'rebuilding the outbox in id order must not hand publish rights back to a reconciled item', ({ kernel, root }) => {
  specGuard(kernel)
  const shared = 'pd:rebuild-order'
  // run id 刻意与插入顺序相反：按 id 排序会得到与 rowid 相反的物理顺序。
  const oldItem = pendingRun(kernel, { runId: 'zzz-run-old', content: 'old rebuild body', target: shared, baseRevision: 1, baseContent: 'old rebuild base', targetKind: 'raw_text' })
  const oldItemClaim = claimOutbox(kernel, oldItem.outboxId, { observe: adapter(1, { content: 'old rebuild base' }).observeTarget })
  const fresh = pendingRun(kernel, { runId: 'aaa-run-new', content: 'new rebuild body', target: shared, baseRevision: 2 })
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', oldItem.outboxId).status === 'outcome_unknown', 'the takeover quarantine is the precondition here')
  // 本项测的是"物理行序"，因此先把行强制构造成旧 pending 形状（本批之前对账会得到这个形态）。
  // 这不是实现能力：本批 absent 对账只落 superseded，构造出来的正是要否掉的假想形态。
  kernel.db.prepare("UPDATE workflow_outbox SET status='pending', reason=NULL WHERE id=?").run(oldItem.outboxId)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', oldItem.outboxId).status === 'pending', 'the fixture reconstructed the legacy pending shape this check needs')

  // 基线：重建之前旧项就已经被拒（拒绝发生在观测之前）。
  const baseline = adapter(1)
  expectError(() => claimOutbox(kernel, oldItem.outboxId, { observe: baseline.observeTarget }), 'outbox_superseded')
  need(baseline.calls.length === 0, `the refusal must precede observation, adapter was asked ${baseline.calls.length} time(s)`)

  const orderOf = () => kernel.query('SELECT id FROM workflow_outbox WHERE target=? ORDER BY rowid', shared).map((row) => row.id)
  const orderBefore = orderOf()
  need(orderBefore[orderBefore.length - 1] === fresh.outboxId, `the newer adoption starts as the last physical row, got ${orderBefore.join(' <- ')}`)

  // 真重建：按 id 取行、原名改成备份、用**库里现成的 DDL** 建表、原样写回、删掉备份。
  // DDL 和列清单都从 sqlite_master / PRAGMA 读，不写死列——否则契约加一列（例如领取代次）
  // 这条重建就不再忠实，红测会以"行值变了"失败，看上去像实现问题而其实是测试自己写死了 schema。
  const rows = kernel.query('SELECT * FROM workflow_outbox ORDER BY id')
  const ddl = kernel.one("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_outbox'").sql
  const columns = kernel.query('PRAGMA table_info(workflow_outbox)').map((column) => column.name)
  kernel.db.exec('ALTER TABLE workflow_outbox RENAME TO workflow_outbox_rebuild_backup')
  kernel.db.exec(ddl)
  const insert = kernel.db.prepare(`INSERT INTO workflow_outbox (${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
  for (const row of rows) insert.run(...columns.map((column) => row[column]))
  kernel.db.exec('DROP TABLE workflow_outbox_rebuild_backup')

  // 重建本身必须是忠实的：行集合逐字段一致，只有物理顺序变了（否则这条断言没有意义）。
  need(JSON.stringify(kernel.query('SELECT * FROM workflow_outbox ORDER BY id')) === JSON.stringify(rows), 'the rebuild keeps every row value, only the physical order changes')
  const orderAfter = orderOf()
  need(orderAfter[orderAfter.length - 1] === oldItem.outboxId, `the rebuild really did flip the physical order, got ${orderAfter.join(' <- ')}`)
  need(JSON.stringify(orderAfter) !== JSON.stringify(orderBefore), 'the rebuild really did change the rowid order, this check is not vacuous')

  // 关键断言：物理顺序翻了，资格不能跟着翻。
  const after = adapter(1)
  const before = state(kernel, root)
  const eventsBefore = kernel.query("SELECT id FROM workflow_events WHERE type='outbox.claimed'").length
  expectError(() => claimOutbox(kernel, oldItem.outboxId, { observe: after.observeTarget }), 'outbox_superseded')
  need(after.calls.length === 0, `the refusal must still precede observation, adapter was asked ${after.calls.length} time(s)`)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', oldItem.outboxId).status === 'pending', 'the revived-looking item stays pending, not running')
  need(kernel.query("SELECT id FROM workflow_events WHERE type='outbox.claimed'").length === eventsBefore, 'no claim is recorded for the rebuilt-order item')
  need(state(kernel, root) === before, 'refusing after the rebuild changes nothing')

  // 正向对照：新项在基准 2 上仍能正常领取，说明重建没有把整个目标锁死。
  const claimedNew = claimOutbox(kernel, fresh.outboxId, { observe: adapter(2).observeTarget })
  need(claimedNew.status === 'running', 'the newer adoption keeps its publish rights across the rebuild')
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', oldItem.outboxId).status === 'pending', 'claiming the newer item does not revive the older one')
  return { orderBefore, orderAfter, baselineCalls: baseline.calls.length, afterRebuildCalls: after.calls.length, newer: claimedNew.status }
})

// PCB-15：目标归属只能来自显式归属记录。记录缺失（旧库升级 / 行丢失）或指向别处时，
// 领取必须拒绝——不能"没有记录就等于没人占用"，那等于把旧内容放回已被占用的目标。
// 正向对照：把正确的归属记录补回去，同一个条目就能正常领取，说明拒绝的是归属，不是这一格。
check('PCB-15', 'a publish item without its own ownership record must not be claimable', ({ kernel, root }) => {
  specGuard(kernel)
  const target = 'pd:claim-owner-missing'
  const item = pendingRun(kernel, { runId: 'run-owner-missing', content: 'owner record body', target, baseRevision: 3 })
  const ownersQuery = 'SELECT target, outbox_id FROM workflow_publish_owners WHERE target=?'
  need(kernel.one(ownersQuery, target)?.outbox_id === item.outboxId, 'adopting with a target writes the ownership record in the same transaction')

  // 1) 记录整行缺失：旧版本写下的 pending outbox 就是这种形状，不得因此变成"目标无人占用"。
  kernel.db.exec(`DELETE FROM workflow_publish_owners WHERE target='${target}'`)
  const missing = adapter(item.baseRevision)
  const before = state(kernel, root)
  const eventsBefore = kernel.query("SELECT id FROM workflow_events WHERE type='outbox.claimed'").length
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: missing.observeTarget }), 'outbox_superseded')
  need(missing.calls.length === 0, `a missing record must be refused before the target is observed, adapter was asked ${missing.calls.length} time(s)`)
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', item.outboxId).status === 'pending', 'the refused item stays pending')
  need(kernel.query("SELECT id FROM workflow_events WHERE type='outbox.claimed'").length === eventsBefore, 'no claim is recorded without an ownership record')
  need(state(kernel, root) === before, 'refusing for a missing record changes nothing')

  // 2) 记录指向别的条目：同样不是本条的资格。
  const other = pendingRun(kernel, { runId: 'run-owner-other', content: 'other body', target: 'pd:claim-owner-other', baseRevision: 3 })
  kernel.db.exec(`INSERT INTO workflow_publish_owners(target,outbox_id,adopted_at) VALUES('${target}','${other.outboxId}','2026-11-14T00:00:00.000Z')`)
  const wrong = adapter(item.baseRevision)
  expectError(() => claimOutbox(kernel, item.outboxId, { observe: wrong.observeTarget }), 'outbox_superseded')
  need(wrong.calls.length === 0, `a record pointing elsewhere must be refused before observation, adapter was asked ${wrong.calls.length} time(s)`)

  // 3) 正向对照：记录写回自己的条目，立刻可以领取。
  kernel.db.exec(`UPDATE workflow_publish_owners SET outbox_id='${item.outboxId}' WHERE target='${target}'`)
  const good = adapter(item.baseRevision)
  const claimed = claimOutbox(kernel, item.outboxId, { observe: good.observeTarget })
  need(claimed.status === 'running', 'restoring the correct ownership record makes the item claimable again')
  need(good.calls.length === 1, 'the positive control really observed the target once')
  return { missingCalls: missing.calls.length, wrongCalls: wrong.calls.length, restored: claimed.status }
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
  claimPhase: claimPhase(),
  results,
}, null, 2)}\n`)
// 自检项若红，说明"零副作用"的证据本身失效，必须与非红测一样失败。
process.exitCode = specFailed.length === 0 && selfcheckFailed.length === 0 ? 0 : 1
