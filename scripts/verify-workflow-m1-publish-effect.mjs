// W1「凭实际效果对账」判定反例专项（happy-4.1 独立复核，2026-11-14）。
// 全程临时 SQLite + 临时根目录 + 假服务 + 纯文本假目标，不碰生产库、不发 HTTP、不调真实模型、不写真实文件。
//
// 本批边界（老大 m01483 口径）：只新增本文件，不改实现；只覆盖本批红测，不导致真实文件发布或自动重试。
//
// 文档依据：
//   08-storage-migration.md:77  「发布记录同时保存原基准和预期结果 hash；崩溃后目标仍为基准才可继续，
//                                已是预期结果则补记成功，出现第三种内容即冲突。」
//   08-storage-migration.md:79  「发布冲突以目标真实字段 / 文件 hash 或新建的领域 revision 比较；
//                                现有全局 revision 和秒级 updated_at 不足以单独识别所有同秒修改。」
//   01-domain-model.md:62       「无法确认外部结果时进入 outcome_unknown……对账后按已验证结果进入上述终态，
//                                记录独立 reconciliation 事件。」
//
// 判定口径（本批冻结，老大 m01483 纠正后的三态）——**内容优先，revision 只作辅助**：
//   读目标真实内容 → H = sha256(原文)
//     H === expected_hash          → 已生效：补记成功，不得再次发布（即便 revision 未变）
//     H === base_hash              → 目标仍是基准：可以继续发布
//     其他（含 H ≠ base 但 H ≠ expected）→ 第三种内容：冲突，拒绝且不覆盖
//   revision 相同不构成「仍需发布」的理由；revision 变化也不构成「必须重发」的理由。
//
// 同一条三态在两个入口上的落点（本批冻结，老大 m00006）：
//   claim    遇到第三种内容 → 固定抛 `publish_base_mismatch`，零写入，行留 pending（PRE-06 锁死）。
//   reconcile 遇到第三种内容 → 固定把行落 `conflict`，并与观测审计事件同事务写入，不自动重发、
//                              不改写用户内容（PRE-08 锁死）；审计写失败必须整条回滚（PRE-13 锁死）。
//
// 数据来源（本批冻结）：
//   expected_hash = 将要写入目标的内容的 hash。原文写入场景下，取**已校验快照正文**的 content_hash 是正确口径。
//   base_hash     = **发布前目标真实内容**的 hash，由调用方在读取目标后随 adopt 传入（baseContentHash）。
//   错误做法是**把 base_hash 也取成快照 hash**——那样「目标已经被别人改成第三种内容」会被误判成基准未变；
//   PRE-10 锁死两者来源不同，PRE-01/PRE-06 锁死误判的后果。
//
// 服务侧证据（本批冻结）：
//   假服务构造时注入只读适配器 targetAdapter = { read(target) → { content, revision } }；
//   服务自己调用 read 并自己计算 hash，**不采信请求里的 outcome / observedContentHash / operator**。
//   适配器缺失或读取失败时不得推断成功，必须拒绝。
//
// 建议实现形状（若实施方改名，需同步改本文件对应断言）：
//   A. workflow_outbox 增列 base_hash TEXT、expected_hash TEXT；adopt 增参 baseContentHash。
//   B. kernel.claimOutbox(id, { observe })：observe 返回 { target, revision, contentHash? }；
//      带 contentHash 时按上面三态判定：已生效则返回 { status:'succeeded', effect:'already_applied' }
//      并把行置 succeeded（不置 running、不发 outbox.claimed、代次不递增）；
//      第三种内容抛 publish_base_mismatch 且不写任何东西。
//   C. service.reconcilePublishEffect({ principal, outboxId, claimGeneration })：
//      仅 ui / scheduler（与 declarePublishUnknown 同一档，PRE-12）；先验身份、再验运行与产品归属、
//      最后校验参数（PRE-12），node-agent 即便获授该 run 也拒绝——它正是执行这次发布的一方，
//      不能自己给自己开「效果已确认」的证明。
//      服务自读自算 hash，三态判为 applied / absent / diverged：
//        applied  → succeeded
//        absent   → 回 pending（基准内容未变，不自动重发；PRE-11a 锁死审计内容）
//        diverged → 行落 `conflict` + 同事务写 `outbox.effect_conflict` 审计（PRE-08/PRE-13）
//      缺证据 → 拒绝；旧代次 / 缺失代次 → publish_conflict / outbox_claim_mismatch。
//      审计事件（建议命名，改名需同步本文件 effectEventsOf / conflictEventsOf）：
//        `outbox.effect_reconciled`（applied / absent）与 `outbox.effect_conflict`（diverged），
//        payload 至少含 { outboxId, decision, claimGeneration, observedHash, observedRevision,
//        actorId（取授权记录，不取请求）, observedAt }。
//
// 错误码折叠（不新增 SERVICE_ERROR_CODES）：publish_base_mismatch → publish_conflict；
//   target_unavailable → capability_unavailable；outbox_claim_mismatch → publish_conflict。
//
// 复核补充（2026-11-14 第2轮，老大 m00162 指定三项）：
//   PRE-14 缺基准摘要（base_hash IS NULL）的记录不得靠「revision 相等」被当成内容已核对；
//          官方发布入口遇到这种记录必须拒绝，不能记成功。
//   PRE-15 已按类别契约收窄为原文目标（raw_text）：基准内容未变、revision 推进仍可发布；
//          内容确实变成第三种仍必须拒。领域 revision 的门见 PRE-18。
//   PRE-16 取消后 / 被同目标新采用取代后在途项的对账：不复活作废项、不因作废项暂停运行。
//   PRE-17 PRE-14 的孪生反例：适配器只报 revision、不报内容摘要（旧夹具形状）时，缺基准记录
//          同样必须拒绝。「服务端没有内容证据」不等于「目标没有内容变化」。
//
// 目标类别契约（2026-11-14 第3轮；依据 08「M1 实际效果证据与目标类别」:105-113）：
//   发布意图在采用事务内持久化 target_kind ∈ {raw_text, domain_revision} 与 base_hash /
//   expected_hash / base_revision。类别只能取自构造时注册的可信适配器；发布/对账请求携带的
//   targetKind / kind / target_kind 一律不参与决策（PRE-19）。缺类别或缺摘要的记录不得发布，
//   不得按 revision 或按请求临时推断、也不自动回填旧基准。
//   两类都先比预期摘要：已是预期 → 补记成功、不领取、不重发（PRE-03/04/18）。
//   否则 raw_text 只按完整原文字节摘要判断是否仍为基准，revision 仅入审计（PRE-15）；
//        domain_revision 要求基准摘要与领域 revision 同时匹配（PRE-18 反向正控）。
//   PRE-19 锁「请求不能选类别」与「无类别记录不可发布」，PRE-20 锁被取代后实际成功的原因语义。
//
// 夹具契约（本文件对目标适配器的最小假设；实现若改用别的访问器名，须同步 08 并只在此一处更新）：
//   targetAdapter = { read(target) -> { content, revision },
//                     kindOf(target) -> 'raw_text' | 'domain_revision' | null }
//   内核层 adopt 直接传 targetKind（测试是可信调用方）；服务层类别应来自构造时注入的适配器。
//   本批夹具仅原文假目标；领域投影的完整字段摘要仍须另验（08:107）。
//
// 口径更正（2026-11-14 第3轮，老大指出）：假服务目前没有实际目标写入，所以「误记成功」是可证
// 事实，「覆盖了用户内容」不成立。本文件只断言假服务不写目标、行状态与全库指纹变化，不宣称覆盖。
//
// 明确不覆盖（不得据此宣称已解决）：
//   - 真实文件 / 外部系统发布（多文件非原子、镜像对账）仍在 08:77 与 W1 其它条目下。
//   - 服务采用链路（submitOutput / confirmHumanTask / executeJob）采集基准与类别仍在迁移，本批不验。
//   - 领域投影的完整字段摘要与领域 revision 的产生规则另验；本文件只用假 revision 表达推进。
//   - 自动重发与超时推断：absent 只回到 pending，重发仍须显式动作。
//   - 租约、服务层带证据的发布执行、旧库零代次修复均另批。
//   - 旧未决记录（无类别/无基准摘要）的迁移与处置：无证据终结入口已删除，这类行继续隔离，本批只证不放开。
//
// 本文件刻意红（契约未实现）：PRE-00 自检应始终为绿，其余 spec 项在实现落地前应全红。
// 若为了「先证明可满足」临时实现过契约，那只是可满足性证据：通过≠验收，正式验收必须对当时的
// 正式源码重跑本文件。

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

// 独立计算的原文 hash：不经过内核的 hash()，避免"实现和测试共用同一个错误"。
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

const expectGenerationMismatch = (fn) => {
  const error = expectCode(fn, 'publish_conflict')
  need(error.detail === 'outbox_claim_mismatch', `a generation mismatch must report detail outbox_claim_mismatch, got ${JSON.stringify(error.detail)}`)
  return error
}

const check = (id, title, fn, kind = 'spec') => {
  const root = mkdtempSync(join(tmpdir(), `m1-eff-${id}-`))
  try {
    const kernel = createWorkflowKernel(new DatabaseSync(join(root, 'workflow.sqlite')), root)
    try {
      const detail = fn({ kernel, root })
      results.push({ id, kind, title, status: 'pass', detail: detail ?? null })
    } finally {
      try { kernel.db.close() } catch {}
    }
  } catch (error) {
    results.push({ id, kind, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// 零副作用指纹：动态发现全库用户表，加 objects/、manifests/、staging/ 的路径与内容 hash。
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

// 纯文本假目标：原文 + 单调 revision。read 是服务唯一能拿到的入口（只读视图），
// 真正的"发布写入"在本批不模拟，所以任何"重发"都只能通过领取/事件观察出来。
const textTargets = () => {
  const entries = new Map()
  const kinds = new Map()
  const reads = []
  const target = {
    seed(name, content, revision = 1) { entries.set(name, { content, revision }); return target },
    externalChange(name, content) {
      const current = entries.get(name)
      entries.set(name, { content, revision: (current?.revision ?? 0) + 1 })
      return target
    },
    remove(name) { entries.delete(name); return target },
    raw(name) { return entries.get(name) ?? null },
    read(name) {
      reads.push(name)
      const current = entries.get(name)
      if (!current) throw new Error(`target ${name} is unavailable`)
      return { content: current.content, revision: current.revision }
    },
    get readCount() { return reads.length },
    get reads() { return [...reads] },
    // 目标类别由构造时注册的适配器声明；服务不能从请求里选类别（PRE-19）。
    setKind(name, kind) { kinds.set(name, kind); return target },
    // 只读视图：服务拿不到写入入口，因此"重发"不可能被服务偷偷完成。
    readonlyView() { return { read: (name) => target.read(name), kindOf: (name) => kinds.get(name) ?? null, write: () => { throw new Error('unexpected_target_write') } } },
    // 完整视图（read + write）：用于把"缺证据被拒"与"适配器能力不足被拒"分开。
    // 两个门都折成 capability_unavailable，只有 detail 与门顺序能区分；用完整适配器时
    // target_adapter_unavailable 不可能出现，拒绝就只能来自证据门。
    fullView() {
      return {
        read: (name) => target.read(name),
        kindOf: (name) => kinds.get(name) ?? null,
        write: (name, payload, options = {}) => {
          const current = target.read(name)
          if (options.expectedHash && sha256(current.content) !== options.expectedHash) return { status: 'conflict' }
          target.seed(name, String(payload), current.revision + 1)
          return { status: 'succeeded' }
        },
      }
    },
  }
  return target
}

const publicationSteps = (target, required = true) => [{ nodeId: 'fake.transform', nodeKind: 'automatic', outputs: [{ name: 'content', artifactType: 'text', schemaVersion: 1, editable: true, multiplicity: 'one' }], requiredChecks: [], publishTargets: [{ target, required }] }]

// 造一次「采用并声明发布」：目标当前内容是 baseContent，采用内容是 content。
const adoptTarget = (kernel, targets, { runId, target, baseContent, content, baseRevision = 1, required = true, targetKind = 'raw_text' }) => {
  targets.seed(target, baseContent, baseRevision)
  targets.setKind(target, targetKind)
  kernel.createRun({ id: runId, input: { fixture: true }, steps: [{ nodeId: 'fake.transform', nodeKind: 'automatic', outputs: [{ name: 'content', artifactType: 'text', schemaVersion: 1, editable: true, multiplicity: 'one' }], requiredChecks: [], publishTargets: [{ target, required }] }] })
  const attempt = kernel.claim(runId)
  const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content })
  const adoption = kernel.adopt({
    attemptId: attempt.attemptId,
    token: attempt.token,
    candidate,
    target,
    baseRevision,
    required,
    baseContentHash: sha256(baseContent),
    targetKind,
  })
  const row = kernel.one('SELECT * FROM workflow_outbox WHERE adoption_id=?', adoption.adoptionId)
  return { runId, target, attempt, adoption, candidate, outboxId: row.id, baseContent, content }
}

const rowOf = (kernel, outboxId) => kernel.one('SELECT * FROM workflow_outbox WHERE id=?', outboxId)
const runOf = (kernel, runId) => kernel.one('SELECT status, pause_reason FROM workflow_runs WHERE id=?', runId)
const claimedEventsOf = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type='outbox.claimed' AND payload LIKE ?", `%${outboxId}%`)
const settledEventsOf = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type='outbox.settled' AND payload LIKE ?", `%${outboxId}%`)
const effectEventsOf = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type IN ('outbox.effect_reconciled','outbox.effect_already_applied','outbox.effect_conflict') AND payload LIKE ?", `%${outboxId}%`)
const conflictEventsOf = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type='outbox.effect_conflict' AND payload LIKE ?", `%${outboxId}%`)
const parsePayload = (row) => { try { return JSON.parse(row.payload) } catch { return null } }

const needOutboxKindColumn = (kernel) => {
  const columns = kernel.query('PRAGMA table_info(workflow_outbox)').map((column) => column.name)
  need(columns.includes('target_kind'), `the outbox must persist target_kind (raw_text / domain_revision chosen by the trusted adapter at adoption time), got columns ${columns.join(',')}`)
}

const needOutboxHashColumns = (kernel) => {
  const columns = kernel.query('PRAGMA table_info(workflow_outbox)').map((column) => column.name)
  need(columns.includes('base_hash'), `the outbox must record base_hash (the pre-publish target content hash), got columns ${columns.join(',')}`)
  need(columns.includes('expected_hash'), `the outbox must record expected_hash (the content to be written), got columns ${columns.join(',')}`)
}

// 观测入口：内核层由测试提供观测；服务层由服务自读自算（PRE-07/08 专门验证）。
const observeOf = (targets, override = null) => (asked) => {
  if (override) return override(asked)
  const { content, revision } = targets.read(asked)
  return { target: asked, revision, contentHash: sha256(content) }
}

// ---------------------------------------------------------------------------------------------
// PRE-00 自检（应始终为绿）：场景可达、两种 hash 口径确实不同、指纹能检出一次真实写入。
check('PRE-00', 'the fixture can express all three target states, and the fingerprint detects a real write', ({ kernel, root }) => {
  const targets = textTargets()
  targets.seed('pd:base', 'content-alpha', 1)
  const observed = targets.read('pd:base')
  need(observed.content === 'content-alpha' && observed.revision === 1, 'the read-only adapter returns the actual content and revision')
  need(sha256(observed.content) === kernel.hash(observed.content), 'the independent sha256 agrees with the kernel hash on plain text')
  need(sha256('content-alpha') !== sha256('content-beta'), 'two different contents hash differently')
  need(targets.reads.length === 1, 'the adapter records that it was really read')

  // 三种状态在夹具上都能造出来
  targets.externalChange('pd:base', 'content-beta')
  need(targets.raw('pd:base').revision === 2, 'an external change bumps the revision')
  need(targets.read('pd:base').content === 'content-beta', 'the external change is visible to the adapter')
  targets.remove('pd:missing')
  let unavailable = null
  try { targets.read('pd:missing') } catch (error) { unavailable = String(error.message) }
  need(/unavailable/.test(String(unavailable)), 'a missing target is an explicit adapter failure, not empty content')

  // 反向对照：一次真实写入必须改变指纹，否则后面所有"零写入"都是恒真。
  const before = state(kernel, root)
  kernel.createRun({ id: 'run-eff-control', input: { fixture: true } })
  const after = state(kernel, root)
  need(before !== after, 'a real write must change the state fingerprint')
  return { hash: sha256('content-alpha').slice(0, 12), states: ['base', 'expected', 'third', 'missing'], mutationDetected: true }
}, 'selfcheck')

// ---------------------------------------------------------------------------------------------
// PRE-01 同版本内容被改：revision 与基准相同，但内容 hash 不是基准 —— 必须拒绝，不能因为"版本没变"就当基准。
check('PRE-01', 'a same-revision content change is not the base, so the claim is refused', ({ kernel }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-same-rev', target: 'pd:same-rev', baseContent: 'base-content', content: 'expected-content' })
  need(rowOf(kernel, item.outboxId).base_hash === sha256('base-content'), 'the outbox records the pre-publish target hash')
  // 别人在同一 revision 上改了内容（例如旧 UI 同秒写入）：revision 仍是 1，内容已经不同。
  targets.seed('pd:same-rev', 'someone-else-content', 1)
  const before = state(kernel, kernel.root)
  expectCode(() => kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }), 'publish_base_mismatch')
  need(state(kernel, kernel.root) === before, 'a same-revision divergence writes nothing')
  need(rowOf(kernel, item.outboxId).status === 'pending', 'the item stays pending')
  need(claimedEventsOf(kernel, item.outboxId).length === 0, 'no claim event is recorded')
  return { revision: 1, observedHash: sha256('someone-else-content').slice(0, 12), baseHash: sha256('base-content').slice(0, 12) }
})

// PRE-02 **正控**（不是反例）：内容仍是基准（hash 相同、revision 相同）→ 可以继续发布。
// 这条的存在是为了防止「一律判冲突」的假实现；它证明的是「基准内容未变」这一支必须放行。
check('PRE-02', 'a positive control: the item is claimable while the target still holds the base content', ({ kernel }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-base', target: 'pd:base-ok', baseContent: 'base-content', content: 'expected-content' })
  const claimed = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) })
  need(claimed && claimed.status === 'running', `a base-matching target is claimable, got ${JSON.stringify(claimed?.status)}`)
  need(Number.isSafeInteger(claimed.claimGeneration) && claimed.claimGeneration >= 1, 'the claim reports its generation')
  need(claimed.effect !== 'already_applied', 'a base-matching target is not reported as already applied')
  need(claimedEventsOf(kernel, item.outboxId).length === 1, 'exactly one claim event is recorded')
  return { status: claimed.status, claimGeneration: claimed.claimGeneration }
})

// PRE-03 已是预期内容（revision 变了）：必须补记成功，不能因为"目标是别的版本"再发一次。
check('PRE-03', 'content that already equals the expected result is recorded as applied, never resent', ({ kernel }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-applied', target: 'pd:applied', baseContent: 'base-content', content: 'expected-content' })
  // 上一次发布其实成功了，只是回调丢了：目标已经是预期内容，revision 也被推到 2。
  targets.externalChange('pd:applied', 'expected-content')
  const before = state(kernel, kernel.root)
  const claimed = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) })
  need(claimed && claimed.status === 'succeeded', `an already-applied effect must be recorded as succeeded, got ${JSON.stringify(claimed?.status)}`)
  need(claimed.effect === 'already_applied', `the decision must say already_applied, got ${JSON.stringify(claimed?.effect)}`)
  need(rowOf(kernel, item.outboxId).status === 'succeeded', 'the row is succeeded')
  need(claimedEventsOf(kernel, item.outboxId).length === 0, 'nothing is re-claimed, so no claim event appears')
  need(rowOf(kernel, item.outboxId).claim_generation === 0, 'no claim generation is consumed by a no-op')
  need(before !== state(kernel, kernel.root), 'recording the decision does write the success state')
  need(targets.raw('pd:applied').content === 'expected-content', 'the target is untouched by the decision')
  return { status: claimed.status, effect: claimed.effect, targetRevision: targets.raw('pd:applied').revision }
})

// PRE-04 revision 未变但内容已是预期（例如别人先写入了同样的内容，或 base 与 expected 本来就相同）。
check('PRE-04', 'an unchanged revision is not a reason to publish again when the content already matches', ({ kernel }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-same-rev-applied', target: 'pd:same-rev-applied', baseContent: 'base-content', content: 'expected-content' })
  // revision 仍是 1，但内容已经等于预期（同秒被别的写入方改成一样的内容）。
  targets.seed('pd:same-rev-applied', 'expected-content', 1)
  const claimed = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) })
  need(claimed && claimed.status === 'succeeded', `already-matching content must not be published again, got ${JSON.stringify(claimed?.status)}`)
  need(claimed.effect === 'already_applied', `the decision must say already_applied, got ${JSON.stringify(claimed?.effect)}`)
  need(claimedEventsOf(kernel, item.outboxId).length === 0, 'no claim happens when nothing needs publishing')
  need(rowOf(kernel, item.outboxId).status === 'succeeded', 'the row is succeeded')
  return { revision: 1, effect: claimed.effect }
})

// PRE-05 基准与预期相同：目标本来就放着即将写入的内容 —— 没有效果可做，直接补记成功。
check('PRE-05', 'a no-op publish (base equals expected) is recorded as applied without publishing', ({ kernel }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-noop', target: 'pd:noop', baseContent: 'same-content', content: 'same-content' })
  const row = rowOf(kernel, item.outboxId)
  need(row.base_hash === row.expected_hash, `base and expected hashes coincide for a no-op publish, got ${row.base_hash} vs ${row.expected_hash}`)
  const before = state(kernel, kernel.root)
  const claimed = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) })
  need(claimed && claimed.status === 'succeeded', `a no-op publish is already applied, got ${JSON.stringify(claimed?.status)}`)
  need(claimed.effect === 'already_applied', `the decision must say already_applied, got ${JSON.stringify(claimed?.effect)}`)
  need(claimedEventsOf(kernel, item.outboxId).length === 0, 'a no-op publish consumes no claim')
  need(before !== state(kernel, kernel.root), 'the success decision is persisted')
  need(targets.raw('pd:noop').content === 'same-content', 'the target keeps its content')
  return { baseEqualsExpected: true, effect: claimed.effect }
})

// PRE-06 领取前第三种内容：固定 `publish_base_mismatch`，零写入，行留 pending，用户内容不被覆盖。
check('PRE-06', 'a third content before the claim is a conflict code, and nothing is written', ({ kernel }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-third', target: 'pd:third', baseContent: 'base-content', content: 'expected-content' })
  targets.externalChange('pd:third', 'user-edited-content')
  const before = state(kernel, kernel.root)
  const error = expectCode(() => kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }), 'publish_base_mismatch')
  need(state(kernel, kernel.root) === before, 'a third content writes nothing at all')
  const row = rowOf(kernel, item.outboxId)
  need(row.status === 'pending', 'the item is not silently advanced')
  need(row.claim_generation === 0, 'a refused claim consumes no generation')
  need(claimedEventsOf(kernel, item.outboxId).length === 0, 'no claim is recorded for a conflict')
  need(settledEventsOf(kernel, item.outboxId).length === 0, 'no settlement is recorded for a refused claim')
  need(effectEventsOf(kernel, item.outboxId).length === 0, 'a pre-claim conflict is not a reconciliation, so no audit event')
  need(runOf(kernel, item.runId).status !== 'completed', 'a conflicting publish must not let the run complete')
  need(targets.raw('pd:third').content === 'user-edited-content', 'the user content is preserved')

  // 服务层把同一个领域码折成冻结码；detail 保留领域码字面量（translate 的既有行为，PRE-09/13 同样依赖）。
  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.readonlyView() })
  svc.registerPrincipal({ id: 'sched-third', kind: 'scheduler' })
  const beforeService = state(kernel, kernel.root)
  const folded = expectCode(
    () => svc.host.publish({ principal: 'sched-third', outboxId: item.outboxId, status: 'succeeded', observe: observeOf(targets) }),
    'publish_conflict',
  )
  need(folded.detail === 'publish_base_mismatch', `the frozen code must keep the domain detail, got ${JSON.stringify(folded.detail)}`)
  need(state(kernel, kernel.root) === beforeService, 'the service-level refusal writes nothing either')
  need(rowOf(kernel, item.outboxId).status === 'pending', 'the item is still pending after the service attempt')
  return { domainCode: error.code, serviceDetail: folded.detail, targetContent: targets.raw('pd:third').content, status: rowOf(kernel, item.outboxId).status }
})

// PRE-07 缺证据：服务读不到目标内容时不得推断成功（适配器缺失 / 读取失败都要拒绝）。
check('PRE-07', 'the service refuses to conclude anything without reading the target', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-noev', target: 'pd:noev', baseContent: 'base-content', content: 'expected-content' })
  // 先把这条推到 outcome_unknown（模拟回调丢失），对账才有事可做。
  const generation = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.markOutboxUnknown(item.outboxId, { actorId: 'op-fixture', reason: 'callback_lost', claimGeneration: generation })
  need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', 'the fixture holds an unknown-outcome item')

  // (a) 服务没有注入适配器：不能对账，也不能声称成功。
  const noAdapter = createFakeBusinessService({ kernel })
  noAdapter.registerPrincipal({ id: 'ui-noev', kind: 'ui' })
  const before = state(kernel, root)
  const missing = expectCode(
    () => noAdapter.reconcilePublishEffect({ principal: 'ui-noev', outboxId: item.outboxId, claimGeneration: generation }),
    'capability_unavailable',
  )
  need(!/succeeded|applied/i.test(String(missing.detail ?? '')), `a missing adapter must not describe success, got ${missing.detail}`)
  need(state(kernel, root) === before, 'a missing adapter writes nothing')
  need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', 'the item stays unknown without evidence')

  // (b) 适配器读取失败：同样拒绝，不推断"未发布"也不推断"已发布"。
  const broken = createFakeBusinessService({ kernel, targetAdapter: { read: () => { throw new Error('target offline') } } })
  broken.registerPrincipal({ id: 'ui-broken', kind: 'ui' })
  const beforeBroken = state(kernel, root)
  expectCode(
    () => broken.reconcilePublishEffect({ principal: 'ui-broken', outboxId: item.outboxId, claimGeneration: generation }),
    'capability_unavailable',
  )
  need(state(kernel, root) === beforeBroken, 'a failing adapter writes nothing')
  need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', 'the item is still unknown after a failed read')
  return { withoutAdapter: missing.detail, rowStatus: rowOf(kernel, item.outboxId).status }
})

// PRE-08 对账遇到第三种内容：固定落 `conflict` + 同事务写观测审计；请求里的 outcome / hash / operator 都不作证据。
check('PRE-08', 'a third content at reconciliation lands on conflict with an audit, never on success', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-forged', target: 'pd:forged', baseContent: 'base-content', content: 'expected-content' })
  const generation = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.markOutboxUnknown(item.outboxId, { actorId: 'op-fixture', reason: 'callback_lost', claimGeneration: generation })
  // 目标真实内容既不是基准也不是预期（用户后来改过）。
  targets.externalChange('pd:forged', 'user-edited-content')

  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.readonlyView() })
  svc.registerPrincipal({ id: 'ui-forged', kind: 'ui' })
  // 请求里塞满伪造证据：一条都不得采信。
  const forged = {
    principal: 'ui-forged',
    outboxId: item.outboxId,
    claimGeneration: generation,
    outcome: 'published',
    status: 'succeeded',
    decision: 'applied',
    observedContentHash: sha256('expected-content'),
    contentHash: sha256('expected-content'),
    observedRevision: 1,
    operator: 'admin',
    actorId: 'admin',
    reason: 'trust me',
    observe: () => ({ target: 'pd:forged', revision: 1, contentHash: sha256('expected-content') }),
  }
  const readsBefore = targets.readCount
  const result = svc.reconcilePublishEffect(forged)
  // 落点固定为 conflict：不接受「抛错或落 conflict」两可，也绝不能是任何形式的成功。
  need(result && result.status === 'conflict', `a third content must be recorded as conflict, got ${JSON.stringify(result?.status)}`)
  need(result.decision === 'diverged', `the decision must be diverged, got ${JSON.stringify(result?.decision)}`)
  need(targets.readCount > readsBefore, 'the service really reads the target instead of trusting the request')
  const rowAfterForged = rowOf(kernel, item.outboxId)
  need(rowAfterForged.status === 'conflict', `the outbox row must be conflict, got ${rowAfterForged.status}`)

  // 观测审计与状态同事务写入：一条 conflict 事件，内容取真实观测，身份取授权记录。
  const conflicts = conflictEventsOf(kernel, item.outboxId).map(parsePayload)
  need(conflicts.length === 1, `exactly one conflict audit is expected, got ${conflicts.length}`)
  const audit = conflicts[0]
  need(audit.actorId === 'ui-forged', `the audit must use the authenticated identity, got ${JSON.stringify(audit.actorId)}`)
  need(audit.claimGeneration === generation, `the audit records the generation it reconciled, got ${JSON.stringify(audit.claimGeneration)}`)
  need(audit.observedHash === sha256('user-edited-content'), `the audit records the real observation, got ${JSON.stringify(audit.observedHash)}`)
  need(audit.observedHash !== sha256('expected-content'), 'the request-supplied hash is not what the audit recorded')
  need(audit.observedRevision === targets.raw('pd:forged').revision, 'the audit records the observed revision')
  need(audit.decision === 'diverged', 'the audit records the diverged decision')
  need(typeof audit.observedAt === 'string' && audit.observedAt.length >= 10, 'the audit records when the observation was made')

  // 不自动重发、不改写用户内容、运行按冲突暂停。
  need(claimedEventsOf(kernel, item.outboxId).length === 1, 'the original claim stays the only claim; reconciliation claims nothing')
  need(targets.raw('pd:forged').content === 'user-edited-content', 'the user content is never overwritten by reconciliation')
  const run = runOf(kernel, item.runId)
  need(run.status === 'paused' && run.pause_reason === 'publish_conflict', `a conflict pauses the run on publish_conflict, got ${JSON.stringify(run)}`)

  // 冲突落定后不得再被当作可对账：沿用现有折叠 outbox_not_reconcilable → outcome_unknown，不新增服务码。
  const beforeRepeat = state(kernel, root)
  expectCode(() => svc.reconcilePublishEffect({ principal: 'ui-forged', outboxId: item.outboxId, claimGeneration: generation }), 'outcome_unknown')
  need(state(kernel, root) === beforeRepeat, 'a repeated reconciliation of a conflict writes nothing')
  need(rowOf(kernel, item.outboxId).status === 'conflict', 'the row keeps conflict')
  need(conflictEventsOf(kernel, item.outboxId).length === 1, 'no second conflict audit appears')
  need(targets.raw('pd:forged').content === 'user-edited-content', 'the user content is still untouched')

  // 成功路径同样不采信请求里的 operator / actorId：审计的操作者取授权记录。
  const okTargets = textTargets()
  const okItem = adoptTarget(kernel, okTargets, { runId: 'run-eff-actor', target: 'pd:actor', baseContent: 'base-content', content: 'expected-content' })
  const okGeneration = kernel.claimOutbox(okItem.outboxId, { observe: observeOf(okTargets) }).claimGeneration
  kernel.markOutboxUnknown(okItem.outboxId, { actorId: 'op-fixture', reason: 'callback_lost', claimGeneration: okGeneration })
  okTargets.externalChange('pd:actor', 'expected-content')
  const okSvc = createFakeBusinessService({ kernel, targetAdapter: okTargets.readonlyView() })
  okSvc.registerPrincipal({ id: 'ui-actor', kind: 'ui' })
  okSvc.reconcilePublishEffect({ principal: 'ui-actor', outboxId: okItem.outboxId, claimGeneration: okGeneration, operator: 'admin', actorId: 'admin' })
  const audits = effectEventsOf(kernel, okItem.outboxId).map(parsePayload)
  need(audits.length >= 1, 'a successful effect reconciliation is audited')
  need(audits.every((payload) => payload?.actorId === 'ui-actor'), `the audit must use the authenticated identity, got ${JSON.stringify(audits.map((p) => p?.actorId))}`)
  return {
    rowStatus: rowAfterForged.status,
    run: `${run.status}/${run.pause_reason}`,
    audit: { actorId: audit.actorId, claimGeneration: audit.claimGeneration, decision: audit.decision },
    successAuditActor: audits.at(-1)?.actorId,
  }
})

// PRE-09 旧代次拒绝：对账同样必须出示当前正整数代次。
check('PRE-09', 'effect reconciliation requires the current positive claim generation', ({ kernel }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-gen', target: 'pd:gen', baseContent: 'base-content', content: 'expected-content' })
  const first = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.markOutboxUnknown(item.outboxId, { actorId: 'op-fixture', reason: 'callback_lost', claimGeneration: first })
  // 让别人先对账回 pending 并重新领取，制造一个"旧代次"。
  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.readonlyView() })
  svc.registerPrincipal({ id: 'ui-gen', kind: 'ui' })
  svc.reconcilePublishEffect({ principal: 'ui-gen', outboxId: item.outboxId, claimGeneration: first })
  need(rowOf(kernel, item.outboxId).status === 'pending', 'reconciling an absent effect returns the item to pending')
  const second = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }).claimGeneration
  need(second === first + 1, `the second claim advances the generation, got ${second}`)
  kernel.markOutboxUnknown(item.outboxId, { actorId: 'op-fixture', reason: 'callback_lost_again', claimGeneration: second })

  const rejectedGenerations = [first, 0, undefined, null, '2', 2.5, -1, Number.NaN, false, [], {}, second + 1]
  for (const claimGeneration of rejectedGenerations) {
    const before = state(kernel, kernel.root)
    expectGenerationMismatch(() => svc.reconcilePublishEffect({ principal: 'ui-gen', outboxId: item.outboxId, claimGeneration }))
    need(state(kernel, kernel.root) === before, `a rejected generation ${JSON.stringify(claimGeneration)} writes nothing`)
    need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', 'the item keeps its unknown status')
  }
  need(effectEventsOf(kernel, item.outboxId).length === 1, 'only the one accepted reconciliation is audited')
  return { first, second, rejected: rejectedGenerations.length }
})

// PRE-10 两个 hash 的来源不同：base 来自发布前的目标内容，expected 来自将要写入的内容，不能都取快照 hash。
check('PRE-10', 'base_hash comes from the target, expected_hash from the content to be written', ({ kernel }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-src', target: 'pd:src', baseContent: 'target-before', content: 'content-to-write' })
  const row = rowOf(kernel, item.outboxId)
  const snapshotHash = sha256('content-to-write')
  const targetHash = sha256('target-before')
  need(row.base_hash === targetHash, `base_hash must be the pre-publish target hash, got ${row.base_hash}`)
  need(row.expected_hash === snapshotHash, `expected_hash must be the content to be written, got ${row.expected_hash}`)
  need(row.base_hash !== row.expected_hash, 'the two hashes must not be the same source')
  need(row.expected_hash === kernel.one('SELECT content_hash AS h FROM workflow_snapshots WHERE id=?', item.adoption.snapshotId).h, 'expected_hash matches the adopted snapshot content')
  // base 记录的是发布前的目标内容：之后目标再被别人改，也不影响已记录的基准。
  targets.externalChange('pd:src', 'later-user-edit')
  need(rowOf(kernel, item.outboxId).base_hash === targetHash, 'the recorded base is a snapshot of the pre-publish target, not a live read')
  return { baseHash: row.base_hash.slice(0, 12), expectedHash: row.expected_hash.slice(0, 12) }
})

// PRE-11 对账三态与去重：applied → succeeded；absent → 回 pending 但不自动重发；重复对账只生效一次。
check('PRE-11', 'effect reconciliation records the observed result once and never resends on its own', ({ kernel }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-recon', target: 'pd:recon', baseContent: 'base-content', content: 'expected-content' })
  const generation = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.markOutboxUnknown(item.outboxId, { actorId: 'op-fixture', reason: 'callback_lost', claimGeneration: generation })
  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.readonlyView() })
  svc.registerPrincipal({ id: 'ui-recon', kind: 'ui' })

  // (a) absent：目标仍是基准（基准内容未变）→ 回 pending，且不得自动重发。
  const absent = svc.reconcilePublishEffect({ principal: 'ui-recon', outboxId: item.outboxId, claimGeneration: generation })
  need(absent && absent.status === 'pending', `an absent effect returns the item to pending, got ${JSON.stringify(absent?.status)}`)
  need(absent.decision === 'absent', `the decision must be absent, got ${JSON.stringify(absent?.decision)}`)
  // 这一支同样要留观测审计：观测 hash 必须就是 base_hash，而且没有被记成任何形式的成功。
  const absentAudit = effectEventsOf(kernel, item.outboxId).map(parsePayload).at(-1)
  need(absentAudit && absentAudit.decision === 'absent', `the absent branch is audited, got ${JSON.stringify(absentAudit?.decision)}`)
  need(absentAudit.observedHash === sha256('base-content'), `the audit records the observed base hash, got ${JSON.stringify(absentAudit?.observedHash)}`)
  need(absentAudit.claimGeneration === generation, 'the absent audit records the generation it reconciled')
  need(absentAudit.actorId === 'ui-recon', `the absent audit records the authenticated identity, got ${JSON.stringify(absentAudit?.actorId)}`)
  need(claimedEventsOf(kernel, item.outboxId).length === 1, 'reconciliation itself claims nothing')
  need(rowOf(kernel, item.outboxId).status === 'pending', 'the row is back to pending')
  need(rowOf(kernel, item.outboxId).status !== 'succeeded', 'an absent effect is never recorded as success')
  need(targets.raw('pd:recon').content === 'base-content', 'an absent effect rewrites nothing')
  const run = runOf(kernel, item.runId)
  need(['running', 'paused'].includes(run.status), `the run is not completed by an absent effect, got ${run.status}`)

  // (b) 二次对账（同代次、已是 pending）：只生效一次。既有冻结折叠把 outbox_not_reconcilable 折成
  //     outcome_unknown（DOMAIN_TO_SERVICE），这里沿用现有口径，不新增服务码。
  const before = state(kernel, kernel.root)
  expectCode(() => svc.reconcilePublishEffect({ principal: 'ui-recon', outboxId: item.outboxId, claimGeneration: generation }), 'outcome_unknown')
  need(state(kernel, kernel.root) === before, 'a repeated reconciliation writes nothing')
  need(rowOf(kernel, item.outboxId).status === 'pending', 'the row keeps its state')

  // (c) applied：重新领取、再丢回调，目标被改成预期内容 → 记成功。
  const second = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.markOutboxUnknown(item.outboxId, { actorId: 'op-fixture', reason: 'callback_lost_again', claimGeneration: second })
  targets.externalChange('pd:recon', 'expected-content')
  const applied = svc.reconcilePublishEffect({ principal: 'ui-recon', outboxId: item.outboxId, claimGeneration: second })
  need(applied && applied.status === 'succeeded', `an applied effect is recorded as succeeded, got ${JSON.stringify(applied?.status)}`)
  need(applied.decision === 'applied', `the decision must be applied, got ${JSON.stringify(applied?.decision)}`)
  need(rowOf(kernel, item.outboxId).status === 'succeeded', 'the row is succeeded')
  need(claimedEventsOf(kernel, item.outboxId).length === 2, 'no extra claim happens for a reconciled success')
  const audit = effectEventsOf(kernel, item.outboxId).map(parsePayload).at(-1)
  need(audit && audit.claimGeneration === second, 'the audit records the generation it reconciled')
  need(audit.observedHash === sha256('expected-content'), `the audit records the observed content hash, got ${JSON.stringify(audit?.observedHash)}`)
  return { absentDecision: absent.decision, appliedDecision: applied.decision, final: rowOf(kernel, item.outboxId).status }
})

// PRE-12 对账的权限边界：只有 ui / scheduler 能对账；执行这次发布的一方（node-agent）不能自证效果。
// 顺序固定：先身份，再运行与产品归属，最后参数——无权身份配坏参数时必须报权限错。
check('PRE-12', 'reconciliation is limited to ui and scheduler, and checks identity before ownership before arguments', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-perm', target: 'pd:perm', baseContent: 'base-content', content: 'expected-content' })
  const generation = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.markOutboxUnknown(item.outboxId, { actorId: 'op-fixture', reason: 'callback_lost', claimGeneration: generation })
  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.readonlyView() })
  svc.host.registerRunProduct(item.runId, 'product-a')
  svc.registerPrincipal({ id: 'ui-perm', kind: 'ui', productId: 'product-a' })
  svc.registerPrincipal({ id: 'sched-perm', kind: 'scheduler' })
  // node-agent 正是这次发布的执行方：即便被授予该 run 与 attempt，也不能给自己开"效果已确认"的证明。
  svc.registerPrincipal({ id: 'agent-perm', kind: 'node-agent', runIds: [item.runId], attemptIds: [item.attempt.attemptId] })
  svc.registerPrincipal({ id: 'other-perm', kind: 'other-agent' })
  svc.registerPrincipal({ id: 'http-perm', kind: 'http-client', credential: 'perm-token' })

  const before = state(kernel, root)
  for (const [principal, credential] of [['agent-perm', null], ['other-perm', null], ['http-perm', 'perm-token']]) {
    const refused = expectCode(
      () => svc.reconcilePublishEffect({ principal, outboxId: item.outboxId, claimGeneration: generation, credential }),
      'capability_unavailable',
    )
    need(!/applied|succeeded|absent/i.test(String(refused.detail ?? '')), `a refused principal must not describe an outcome, got ${refused.detail}`)
    need(state(kernel, root) === before, `a refused principal ${principal} writes nothing`)
    need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', 'the item stays unknown for a refused principal')
    need(effectEventsOf(kernel, item.outboxId).length === 0, 'a refused principal produces no reconciliation audit')
  }

  // 先身份：无权身份 + 坏代次必须报权限错，不能靠错误码探测代次或 outbox 是否存在。
  const orderProbe = expectCode(
    () => svc.reconcilePublishEffect({ principal: 'agent-perm', outboxId: item.outboxId, claimGeneration: -1 }),
    'capability_unavailable',
  )
  need(orderProbe.detail !== 'outbox_claim_mismatch', 'the permission check must precede parameter validation')
  // 同样地，无权身份配一个不存在的 outbox 也必须得到与"存在但无权"完全相同的响应：
  // 否则 outboxId 就成了存在性预言机。
  for (const principal of ['agent-perm', 'http-perm']) {
    const existing = expectCode(
      () => svc.reconcilePublishEffect({ principal, outboxId: item.outboxId, claimGeneration: generation, credential: principal === 'http-perm' ? 'perm-token' : null }),
      'capability_unavailable',
    )
    const absent = expectCode(
      () => svc.reconcilePublishEffect({ principal, outboxId: 'outbox-does-not-exist', claimGeneration: generation, credential: principal === 'http-perm' ? 'perm-token' : null }),
      'capability_unavailable',
    )
    need(existing.detail === absent.detail, `an unauthorized principal must not probe existence: ${principal} got ${existing.detail} vs ${absent.detail}`)
  }

  // 再产品归属：跨产品与"不存在"对外同一响应，不泄露 outbox 是否存在。
  svc.registerPrincipal({ id: 'ui-other-product', kind: 'ui', productId: 'product-b' })
  const cross = expectCode(
    () => svc.reconcilePublishEffect({ principal: 'ui-other-product', outboxId: item.outboxId, claimGeneration: generation }),
    'artifact_missing',
  )
  const missing = expectCode(
    () => svc.reconcilePublishEffect({ principal: 'ui-perm', outboxId: 'outbox-does-not-exist', claimGeneration: generation }),
    'artifact_missing',
  )
  need(cross.code === missing.code && cross.detail === missing.detail, `cross-product and missing must be indistinguishable, got ${cross.detail} vs ${missing.detail}`)
  need(state(kernel, root) === before, 'an ownership refusal writes nothing')

  // 放行集合的正控：同产品 ui 与 scheduler 都能对账（此处目标仍是基准 → absent）。
  const byUi = svc.reconcilePublishEffect({ principal: 'ui-perm', outboxId: item.outboxId, claimGeneration: generation })
  need(byUi && byUi.decision === 'absent', `an authorized ui reconciles, got ${JSON.stringify(byUi?.decision)}`)
  const schedItem = adoptTarget(kernel, targets, { runId: 'run-eff-perm-sched', target: 'pd:perm-sched', baseContent: 'base-content', content: 'expected-content' })
  const schedGeneration = kernel.claimOutbox(schedItem.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.markOutboxUnknown(schedItem.outboxId, { actorId: 'op-fixture', reason: 'callback_lost', claimGeneration: schedGeneration })
  const byScheduler = svc.reconcilePublishEffect({ principal: 'sched-perm', outboxId: schedItem.outboxId, claimGeneration: schedGeneration })
  need(byScheduler && byScheduler.decision === 'absent', `an authorized scheduler reconciles, got ${JSON.stringify(byScheduler?.decision)}`)
  return { refused: ['node-agent', 'other-agent', 'http-client'], allowed: ['ui', 'scheduler'], hiddenDetail: cross.detail }
})

// PRE-13 观测审计写失败必须整条回滚：不得先落 conflict 再补审计。
check('PRE-13', 'a failed conflict audit rolls the status back atomically', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-rollback', target: 'pd:rollback', baseContent: 'base-content', content: 'expected-content' })
  const generation = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.markOutboxUnknown(item.outboxId, { actorId: 'op-fixture', reason: 'callback_lost', claimGeneration: generation })
  targets.externalChange('pd:rollback', 'user-edited-content')
  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.readonlyView() })
  svc.registerPrincipal({ id: 'ui-rollback', kind: 'ui' })

  // 只打断 conflict 审计本身，其它事件照常：确保测的是"状态与审计同事务"，不是把整条路径砸坏。
  kernel.db.exec("CREATE TRIGGER m1_effect_conflict_audit_guard BEFORE INSERT ON workflow_events WHEN NEW.type='outbox.effect_conflict' BEGIN SELECT RAISE(ABORT, 'effect conflict audit unavailable'); END")
  const before = state(kernel, root)
  let failure = null
  try { svc.reconcilePublishEffect({ principal: 'ui-rollback', outboxId: item.outboxId, claimGeneration: generation }) } catch (error) { failure = error }
  need(failure !== null, 'a failing audit must fail the whole reconciliation instead of half-committing')
  need(state(kernel, root) === before, 'a failed audit leaves no status change and no event behind')
  need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', `the row is still outcome_unknown, got ${rowOf(kernel, item.outboxId).status}`)
  const runAfterFailure = runOf(kernel, item.runId)
  need(runAfterFailure.pause_reason !== 'publish_conflict', `the run must not be paused on publish_conflict, got ${JSON.stringify(runAfterFailure)}`)
  need(conflictEventsOf(kernel, item.outboxId).length === 0, 'no conflict audit is left behind')
  need(targets.raw('pd:rollback').content === 'user-edited-content', 'the failed attempt rewrites nothing')

  // 移除障碍后同一次调用必须成功：证明刚才的失败确实来自审计，不是别的分支顺手失败。
  kernel.db.exec('DROP TRIGGER m1_effect_conflict_audit_guard')
  const retried = svc.reconcilePublishEffect({ principal: 'ui-rollback', outboxId: item.outboxId, claimGeneration: generation })
  need(retried && retried.status === 'conflict', `after the audit works again the call succeeds, got ${JSON.stringify(retried?.status)}`)
  need(conflictEventsOf(kernel, item.outboxId).length === 1, 'exactly one conflict audit after the retry')
  need(rowOf(kernel, item.outboxId).status === 'conflict', 'the row is conflict now')
  return { failure: String(failure?.code ?? failure?.message).slice(0, 40), rolledBack: true, finalStatus: rowOf(kernel, item.outboxId).status }
})

// PRE-14 缺基准摘要不得让内容校验失效：没有 base_hash 的记录不是"内容已核对"，只是"只核过 revision"。
// 这里造的是最危险的一格：内容已被别人改掉，但 revision 没变（例如磁盘文件被直接改写）。
check('PRE-14', 'a record without a base digest is never published on revision evidence alone', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  // 采用时不给 baseContentHash：这正是旧无基准发布路径（服务层 submitOutput / executeJob 目前就走这条）。
  targets.seed('pd:nodigest', 'base-content', 1)
  kernel.createRun({ id: 'run-eff-nodigest', input: { fixture: true }, steps: publicationSteps('pd:nodigest') })
  const attempt = kernel.claim('run-eff-nodigest')
  const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content: 'expected-content' })
  const adoption = kernel.adopt({ attemptId: attempt.attemptId, token: attempt.token, candidate, target: 'pd:nodigest', baseRevision: 1 })
  const row = kernel.one('SELECT * FROM workflow_outbox WHERE adoption_id=?', adoption.adoptionId)
  need(row.base_hash === null, `the fixture must produce a digest-less publish record, got ${JSON.stringify(row.base_hash)}`)
  // 内容被换成用户自己的内容，revision 保持 1：只比 revision 的判定会以为"基准没变"。
  targets.seed('pd:nodigest', 'user-edited-content', 1)
  need(targets.read('pd:nodigest').revision === 1, 'the revision is deliberately unchanged')

  // 完整适配器：排除「适配器能力检查提前挡住」这一解释——缺 write 的服务会在 :1264 抛
  // target_adapter_unavailable，同样折成 capability_unavailable，把本条测试变成空过。
  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.fullView() })
  svc.registerPrincipal({ id: 'sched-nodigest', kind: 'scheduler' })
  const before = state(kernel, root)
  let error = null
  let outcome = null
  try {
    outcome = svc.host.publish({ principal: 'sched-nodigest', outboxId: row.id, status: 'succeeded', observe: observeOf(targets) })
  } catch (thrown) { error = thrown }
  // 没有基准摘要就没有可比对的内容基准：不得据 revision 相等放行，更不得记成功。
  need(outcome?.status !== 'succeeded', `a digest-less record must not be published as success, got ${JSON.stringify(outcome?.status)}`)
  need(error !== null, 'the official publish entry must refuse a record it cannot content-verify')
  // 必须由证据门拒绝（publish_evidence_required），不能是适配器门（target_adapter_unavailable）。
  need(error?.detail === 'publish_evidence_required', `the refusal must come from the evidence gate, got ${JSON.stringify(error?.detail)}`)
  need(state(kernel, root) === before, 'a refused digest-less publish writes nothing')
  need(rowOf(kernel, row.id).status === 'pending', `the item stays pending, got ${rowOf(kernel, row.id).status}`)
  need(claimedEventsOf(kernel, row.id).length === 0, 'nothing is claimed without a comparable base')
  need(targets.raw('pd:nodigest').content === 'user-edited-content', 'the user content is preserved')
  need(runOf(kernel, 'run-eff-nodigest').status !== 'completed', 'a digest-less publish must not let the run complete')
  return { baseHash: row.base_hash, refused: error?.code ?? outcome?.status, detail: error?.detail ?? null, status: rowOf(kernel, row.id).status }
})

// PRE-15 原文目标（raw_text）：基准内容未变、revision 推进 → 仍可发布；真的变成第三种内容仍必须拒。
// 收到「域」上：08:109 规定 raw_text 只按完整原文字节摘要判断，revision 只入审计。
check('PRE-15', 'a raw_text target with unchanged base content stays publishable when the revision moved', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  needOutboxKindColumn(kernel)
  const targets = textTargets()
  const item = adoptTarget(kernel, targets, { runId: 'run-eff-base-rev', target: 'pd:base-rev', baseContent: 'base-content', content: 'expected-content', targetKind: 'raw_text' })
  need(rowOf(kernel, item.outboxId).target_kind === 'raw_text', `the adoption must persist the adapter-declared kind, got ${JSON.stringify(rowOf(kernel, item.outboxId).target_kind)}`)
  // 别人把同样的内容又写了一遍（或只改了元数据）：内容仍是基准，revision 变成 2。
  targets.externalChange('pd:base-rev', 'base-content')
  need(targets.read('pd:base-rev').revision === 2 && sha256('base-content') === rowOf(kernel, item.outboxId).base_hash, 'the fixture keeps the base content with a newer revision')
  const claimed = kernel.claimOutbox(item.outboxId, { observe: observeOf(targets) })
  need(claimed && claimed.status === 'running', `a raw_text target is judged by content, so the claim must proceed, got ${JSON.stringify(claimed?.status)}`)
  need(claimed.claimGeneration === 1, 'the claim consumes the first generation')
  need(claimedEventsOf(kernel, item.outboxId).length === 1, 'the claim is recorded')
  need(rowOf(kernel, item.outboxId).status === 'running', 'the item is running')
  need(targets.raw('pd:base-rev').content === 'base-content', 'the claim itself writes nothing')
  // revision 只入审计（08:109）：审计里必须留下实际观测到的 revision，供人判断是否只是元数据变化。
  const observedRevision = claimedEventsOf(kernel, item.outboxId).map(parsePayload).filter(Boolean)
    .map((payload) => payload.observedRevision ?? payload.observed_revision).filter((value) => value !== undefined)
  if (observedRevision.length > 0) need(observedRevision.includes(2), `the observed revision is recorded for audit, got ${JSON.stringify(observedRevision)}`)

  // 反向正控：内容真的变成第三种（revision 也变了）必须拒，且零写入。
  const other = adoptTarget(kernel, targets, { runId: 'run-eff-base-rev-third', target: 'pd:base-rev-third', baseContent: 'base-content', content: 'expected-content', targetKind: 'raw_text' })
  targets.externalChange('pd:base-rev-third', 'user-edited-content')
  const before = state(kernel, root)
  expectCode(() => kernel.claimOutbox(other.outboxId, { observe: observeOf(targets) }), 'publish_base_mismatch')
  need(state(kernel, root) === before, 'a real third content still writes nothing')
  need(rowOf(kernel, other.outboxId).status === 'pending', 'the refused raw_text item stays pending')
  return { kind: rowOf(kernel, item.outboxId).target_kind, claimedWithRevision2: claimed.status, rejectedThird: true }
})

// PRE-16 取消 / 被同目标新采用取代后的对账：不得复活作废项，也不得因作废项暂停运行。
check('PRE-16', 'reconciliation never revives a superseded item nor blocks the run for one', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()

  // (a) 取消后在途项：目标确实是预期内容 → 记成功是对的，运行仍是 cancelled，不重发。
  const cancelled = adoptTarget(kernel, targets, { runId: 'run-eff-cancel', target: 'pd:cancel', baseContent: 'base-content', content: 'expected-content' })
  const cancelGeneration = kernel.claimOutbox(cancelled.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.cancelRun('run-eff-cancel')
  need(rowOf(kernel, cancelled.outboxId).status === 'outcome_unknown', 'cancelling turns the in-flight item into unknown')
  targets.externalChange('pd:cancel', 'expected-content')
  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.readonlyView() })
  svc.registerPrincipal({ id: 'ui-cancel', kind: 'ui' })
  const applied = svc.reconcilePublishEffect({ principal: 'ui-cancel', outboxId: cancelled.outboxId, claimGeneration: cancelGeneration })
  need(applied?.status === 'succeeded', `a cancelled run's concrete success is still recorded, got ${JSON.stringify(applied?.status)}`)
  need(applied.decision === 'applied', 'the decision is applied')
  need(runOf(kernel, 'run-eff-cancel').status === 'cancelled', 'the run stays cancelled; a late success does not revive it')
  need(claimedEventsOf(kernel, cancelled.outboxId).length === 1, 'reconciliation claims nothing')

  // (b) 同目标被另一个 run 重新采用：旧在途项转 unknown(superseded_while_running)，owner 已换人。
  const old = adoptTarget(kernel, targets, { runId: 'run-eff-sup-a', target: 'pd:sup', baseContent: 'base-content', content: 'expected-a' })
  const oldGeneration = kernel.claimOutbox(old.outboxId, { observe: observeOf(targets) }).claimGeneration
  targets.seed('pd:sup', 'base-content', 1)
  kernel.createRun({ id: 'run-eff-sup-b', input: { fixture: true }, steps: publicationSteps('pd:sup') })
  const attemptB = kernel.claim('run-eff-sup-b')
  const candidateB = kernel.storeCandidate({ attemptId: attemptB.attemptId, token: attemptB.token, content: 'expected-b' })
  const adoptionB = kernel.adopt({ attemptId: attemptB.attemptId, token: attemptB.token, candidate: candidateB, target: 'pd:sup', baseRevision: 1, baseContentHash: sha256('base-content') })
  const ownerId = kernel.one('SELECT outbox_id FROM workflow_publish_owners WHERE target=?', 'pd:sup').outbox_id
  need(ownerId !== old.outboxId, 'the target ownership moved to the newer adoption')
  need(rowOf(kernel, old.outboxId).status === 'outcome_unknown', 'the superseded in-flight item is left for reconciliation')
  const supersededRow = rowOf(kernel, old.outboxId)
  need(String(supersededRow.reason).includes('superseded'), `the supersession evidence is recorded, got ${supersededRow.reason}`)

  // (b1) 目标仍是基准：作废项不得回到 pending（否则运行永远等一个领不到的项）。
  const absent = svc.reconcilePublishEffect({ principal: 'ui-cancel', outboxId: old.outboxId, claimGeneration: oldGeneration })
  need(absent?.status === 'superseded', `a superseded item is recorded as superseded, got ${JSON.stringify(absent?.status)}`)
  need(rowOf(kernel, old.outboxId).status !== 'pending', 'a superseded item is never put back to pending')
  need(String(rowOf(kernel, old.outboxId).reason).includes('superseded'), `the audit keeps the supersession reason, got ${rowOf(kernel, old.outboxId).reason}`)
  need(runOf(kernel, 'run-eff-sup-a').pause_reason !== 'publish_conflict', `the superseded item must not pause the old run on a conflict, got ${JSON.stringify(runOf(kernel, 'run-eff-sup-a'))}`)
  need(runOf(kernel, 'run-eff-sup-a').status !== 'running', `the old run must not be left waiting on an item it can never claim, got ${runOf(kernel, 'run-eff-sup-a').status}`)
  need(claimedEventsOf(kernel, old.outboxId).length === 1, 'reconciliation claims nothing')

  // (b2) 目标被改成第三种内容：作废项的冲突同样不得暂停旧运行。
  const old2 = adoptTarget(kernel, targets, { runId: 'run-eff-sup-c', target: 'pd:sup2', baseContent: 'base-content', content: 'expected-c' })
  const old2Generation = kernel.claimOutbox(old2.outboxId, { observe: observeOf(targets) }).claimGeneration
  targets.seed('pd:sup2', 'base-content', 1)
  kernel.createRun({ id: 'run-eff-sup-d', input: { fixture: true }, steps: publicationSteps('pd:sup2') })
  const attemptD = kernel.claim('run-eff-sup-d')
  const candidateD = kernel.storeCandidate({ attemptId: attemptD.attemptId, token: attemptD.token, content: 'expected-d' })
  kernel.adopt({ attemptId: attemptD.attemptId, token: attemptD.token, candidate: candidateD, target: 'pd:sup2', baseRevision: 1, baseContentHash: sha256('base-content') })
  targets.externalChange('pd:sup2', 'user-edited-content')
  const diverged = svc.reconcilePublishEffect({ principal: 'ui-cancel', outboxId: old2.outboxId, claimGeneration: old2Generation })
  need(diverged?.status === 'superseded', `a superseded item stays superseded even when the target moved, got ${JSON.stringify(diverged?.status)}`)
  const oldRun2 = runOf(kernel, 'run-eff-sup-c')
  need(oldRun2.pause_reason !== 'publish_conflict', `the obsolete item must not pause the old run, got ${JSON.stringify(oldRun2)}`)
  need(rowOf(kernel, old2.outboxId).status !== 'conflict', 'the obsolete item never becomes a conflict of its own')
  need(targets.raw('pd:sup2').content === 'user-edited-content', 'the user content is preserved')
  return {
    cancelled: `${applied.status}/${runOf(kernel, 'run-eff-cancel').status}`,
    supersededAbsent: absent.status,
    supersededDiverged: diverged.status,
    ownerMoved: ownerId === adoptionB.adoptionId + ':publish',
  }
})

// PRE-17 上一格的孪生反例：不携带内容基准的记录，无论适配器报不报摘要、无论类别是否已持久化，
// 都只能拒绝。08:109「缺类别、缺摘要…服务发布拒绝，旧记录不得自动推断类别或回填基准」。
// 这里刻意造三种形状，避免"只挡住已有测试"：
//   (i)   旧记录：无类别、无基准，适配器只报 revision（verify-workflow-m1-endtoend.mjs:41 的旧夹具形状）；
//   (ii)  类别已持久化为 raw_text，但采用时没给基准摘要，适配器只报 revision；
//   (iii) 类别为 raw_text、无基准摘要，适配器诚实报出内容摘要——但库里没有可比对的基准，仍必须拒。
check('PRE-17', 'a record without a content baseline is never published on revision evidence alone', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  // 完整适配器：缺 write 会让服务在 :1264 抛 target_adapter_unavailable，与证据门同码，测试会空过。
  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.fullView() })
  svc.registerPrincipal({ id: 'sched-nobase', kind: 'scheduler' })

  const digestOnly = (asked) => { const { revision } = targets.read(asked); return { target: asked, revision } }
  const digestOf = (asked) => { const { content, revision } = targets.read(asked); return { target: asked, revision, contentHash: sha256(content) } }

  // 造一条无基准摘要的记录：adopt 不传 baseContentHash；targetKind 由形状决定。
  const seedRecord = (target, targetKind) => {
    targets.seed(target, 'base-content', 1)
    targets.setKind(target, targetKind)
    kernel.createRun({ id: `run-${target.replace(/[^a-z0-9]/gi, '-')}`, input: { fixture: true }, steps: publicationSteps(target) })
    const attempt = kernel.claim(`run-${target.replace(/[^a-z0-9]/gi, '-')}`)
    const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content: 'expected-content' })
    const adoption = kernel.adopt({ attemptId: attempt.attemptId, token: attempt.token, candidate, target, baseRevision: 1, targetKind })
    const row = kernel.one('SELECT * FROM workflow_outbox WHERE adoption_id=?', adoption.adoptionId)
    need(row.base_hash === null, `the fixture must produce a record without a base digest, got ${JSON.stringify(row.base_hash)}`)
    // 内容被换成用户自己的内容，revision 保持 1：只比 revision 的判定会以为「基准没变」。
    targets.seed(target, 'user-edited-content', 1)
    need(targets.read(target).revision === 1, 'the revision is deliberately unchanged so only content would tell')
    return row
  }

  const cases = [
    ['legacy-kindless', seedRecord('pd:nobase-legacy', null), digestOnly],
    ['raw-text-revision-only', seedRecord('pd:nobase-raw', 'raw_text'), digestOnly],
    ['raw-text-with-digest', seedRecord('pd:nobase-digest', 'raw_text'), digestOf],
  ]
  const refused = []
  for (const [label, row, observe] of cases) {
    const before = state(kernel, root)
    let error = null
    let outcome = null
    try {
      outcome = svc.host.publish({ principal: 'sched-nobase', outboxId: row.id, status: 'succeeded', observe })
    } catch (thrown) { error = thrown }
    // 「服务端没有内容基准」和「目标没有内容变化」是两件事：前者必须拒绝，不能当成后者。
    need(error !== null, `${label}: a record without a content baseline must be refused, got ${JSON.stringify(outcome)}`)
    need(error?.detail === 'publish_evidence_required', `${label}: the refusal must come from the evidence gate, got ${JSON.stringify(error?.detail)}`)
    need(outcome?.status !== 'succeeded', `${label}: a baseline-less record must never be published as success, got ${JSON.stringify(outcome?.status)}`)
    need(state(kernel, root) === before, `${label}: a refused publish writes nothing`)
    need(rowOf(kernel, row.id).status === 'pending', `${label}: the item stays pending, got ${rowOf(kernel, row.id).status}`)
    need(claimedEventsOf(kernel, row.id).length === 0, `${label}: nothing is claimed without a comparable baseline`)
    need(targets.raw(row.target).content === 'user-edited-content', `${label}: the user content is preserved (nothing is written)`)
    refused.push(`${label}:${error?.code ?? outcome?.status ?? 'unknown'}/${error?.detail ?? '-'}`)
  }
  // 指纹零变化已经证明没有写入，但假服务本来也不写目标；这里只断言「误记成功」没有发生，
  // 不宣称覆盖了用户文件（见头部口径更正）。
  return { refused }
})

// PRE-18 领域 revision 目标的反向正控：08:109 要求基准摘要与领域 revision 同时匹配。
// 内容仍是基准但领域 revision 已推进时必须拒——这正是 raw_text 放行、domain_revision 拒绝的分界。
check('PRE-18', 'a domain_revision target must match the revision it was adopted against', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  needOutboxKindColumn(kernel)
  const targets = textTargets()

  // 两类共用：已是预期内容 → 补记成功，不领取、不重发，与类别无关（08:109）。
  const applied = adoptTarget(kernel, targets, { runId: 'run-eff-dom-applied', target: 'pd:dom-applied', baseContent: 'base-content', content: 'expected-content', targetKind: 'domain_revision' })
  need(rowOf(kernel, applied.outboxId).target_kind === 'domain_revision', 'the domain kind is persisted at adoption')
  targets.externalChange('pd:dom-applied', 'expected-content')
  const recorded = kernel.claimOutbox(applied.outboxId, { observe: observeOf(targets) })
  need(recorded?.status === 'succeeded' && recorded.effect === 'already_applied', `the expected content wins before any kind rule, got ${JSON.stringify(recorded)}`)
  need(claimedEventsOf(kernel, applied.outboxId).length === 0, 'the expected-content branch claims nothing')

  // 正控：内容与领域 revision 都仍是基准 → 可领取。
  const intact = adoptTarget(kernel, targets, { runId: 'run-eff-dom-intact', target: 'pd:dom-intact', baseContent: 'base-content', content: 'expected-content', targetKind: 'domain_revision' })
  const claimed = kernel.claimOutbox(intact.outboxId, { observe: observeOf(targets) })
  need(claimed?.status === 'running', `both the digest and the domain revision match, so the claim must proceed, got ${JSON.stringify(claimed?.status)}`)
  need(claimed.claimGeneration === 1, 'the matching domain claim consumes the first generation')

  // 反向正控：内容仍是基准，但领域 revision 推进了 → 必须拒，零写入，留 pending。
  const moved = adoptTarget(kernel, targets, { runId: 'run-eff-dom-moved', target: 'pd:dom-moved', baseContent: 'base-content', content: 'expected-content', targetKind: 'domain_revision' })
  targets.externalChange('pd:dom-moved', 'base-content')
  need(targets.read('pd:dom-moved').revision === 2 && targets.read('pd:dom-moved').content === 'base-content', 'the fixture keeps the base content with a newer domain revision')
  const before = state(kernel, root)
  expectCode(() => kernel.claimOutbox(moved.outboxId, { observe: observeOf(targets) }), 'publish_base_mismatch')
  need(state(kernel, root) === before, 'a moved domain revision writes nothing')
  need(rowOf(kernel, moved.outboxId).status === 'pending', `the refused domain item stays pending, got ${rowOf(kernel, moved.outboxId).status}`)
  need(claimedEventsOf(kernel, moved.outboxId).length === 0, 'nothing is claimed when the domain revision moved')
  return { applied: recorded.status, intact: claimed.status, moved: rowOf(kernel, moved.outboxId).status }
})

// PRE-19 类别不能由请求选择（08:107）：发布与对账都必须认采用时持久化的类别，
// 旧记录缺类别时拒绝发布，不得按 revision 或按请求临时推断。
check('PRE-19', 'a request cannot pick the target kind, and a kind-less record is not publishable', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  needOutboxKindColumn(kernel)
  const targets = textTargets()
  const svc = createFakeBusinessService({ kernel, targetAdapter: {
    ...targets.readonlyView(),
    write: (name, content, options) => {
      const current = targets.read(name)
      if (sha256(current.content) !== options.expectedHash) return { status: 'conflict' }
      targets.seed(name, content, current.revision + 1)
      return { status: 'succeeded' }
    },
  } })
  svc.registerPrincipal({ id: 'sched-kind', kind: 'scheduler' })
  svc.registerPrincipal({ id: 'ui-kind', kind: 'ui' })

  // (a) 持久化类别是 domain_revision；请求自称 raw_text，不能因此跳过领域 revision 门。
  const dom = adoptTarget(kernel, targets, { runId: 'run-eff-kind-dom', target: 'pd:kind-dom', baseContent: 'base-content', content: 'expected-content', targetKind: 'domain_revision' })
  targets.externalChange('pd:kind-dom', 'base-content')
  const beforeA = state(kernel, root)
  let errorA = null
  let outcomeA = null
  try {
    outcomeA = svc.host.publish({
      principal: 'sched-kind', outboxId: dom.outboxId, status: 'succeeded',
      targetKind: 'raw_text', kind: 'raw_text', target_kind: 'raw_text',
      observe: observeOf(targets),
    })
  } catch (thrown) { errorA = thrown }
  need(outcomeA?.status !== 'succeeded', `forging targetKind=raw_text must not bypass the domain revision gate, got ${JSON.stringify(outcomeA)}`)
  need(errorA !== null, 'the forged-kind publish is refused')
  need(errorA?.detail === 'publish_base_mismatch', `the refusal must still be the base mismatch, got ${JSON.stringify(errorA?.detail)}`)
  need(state(kernel, root) === beforeA, 'a forged-kind publish writes nothing')
  need(rowOf(kernel, dom.outboxId).status === 'pending', 'the domain item stays pending after the forged request')
  need(rowOf(kernel, dom.outboxId).target_kind === 'domain_revision', 'the persisted kind is untouched by the request')

  // (b) 持久化类别是 raw_text；请求自称 domain_revision，也不能改变判定（请求不参与决策）。
  const raw = adoptTarget(kernel, targets, { runId: 'run-eff-kind-raw', target: 'pd:kind-raw', baseContent: 'base-content', content: 'expected-content', targetKind: 'raw_text' })
  targets.externalChange('pd:kind-raw', 'base-content')
  const outcomeB = svc.host.publish({
    principal: 'sched-kind', outboxId: raw.outboxId, status: 'succeeded',
    targetKind: 'domain_revision', kind: 'domain_revision', target_kind: 'domain_revision',
    observe: observeOf(targets),
  })
  need(outcomeB?.status === 'succeeded', `a raw_text item is still judged by content only, got ${JSON.stringify(outcomeB?.status)}`)
  need(claimedEventsOf(kernel, raw.outboxId).length === 1, 'the raw_text item is claimed exactly once')

  // (c) 旧记录没有类别：服务必须拒绝，不能按 revision 相等或按请求推断成 raw_text。
  const legacy = adoptTarget(kernel, targets, { runId: 'run-eff-kind-legacy', target: 'pd:kind-legacy', baseContent: 'base-content', content: 'expected-content', targetKind: null })
  need(rowOf(kernel, legacy.outboxId).target_kind === null, `the fixture must produce a kind-less record, got ${JSON.stringify(rowOf(kernel, legacy.outboxId).target_kind)}`)
  const beforeC = state(kernel, root)
  let errorC = null
  let outcomeC = null
  try {
    outcomeC = svc.host.publish({ principal: 'sched-kind', outboxId: legacy.outboxId, status: 'succeeded', targetKind: 'raw_text', observe: observeOf(targets) })
  } catch (thrown) { errorC = thrown }
  need(errorC !== null, `a kind-less record must not be published, got ${JSON.stringify(outcomeC)}`)
  need(errorC?.detail === 'publish_evidence_required', `a kind-less record must be refused by the evidence gate, got ${JSON.stringify(errorC?.detail)}`)
  need(outcomeC?.status !== 'succeeded', 'a kind-less record never becomes success')
  need(state(kernel, root) === beforeC, 'a refused kind-less publish writes nothing')
  need(rowOf(kernel, legacy.outboxId).status === 'pending', 'the kind-less item stays pending')

  // (d) 对账入口同规矩：持久化 domain_revision、内容回到基准但领域 revision 推进，
  //     请求自称 raw_text 不得把 diverged 说成 absent。
  const recon = adoptTarget(kernel, targets, { runId: 'run-eff-kind-recon', target: 'pd:kind-recon', baseContent: 'base-content', content: 'expected-content', targetKind: 'domain_revision' })
  const generation = kernel.claimOutbox(recon.outboxId, { observe: observeOf(targets) }).claimGeneration
  kernel.markOutboxUnknown(recon.outboxId, { actorId: 'ui-kind', reason: 'adapter timed out', claimGeneration: generation })
  targets.externalChange('pd:kind-recon', 'base-content')
  const decided = svc.reconcilePublishEffect({
    principal: 'ui-kind', outboxId: recon.outboxId, claimGeneration: generation,
    targetKind: 'raw_text', kind: 'raw_text',
  })
  need(decided?.decision === 'diverged', `a forged raw_text must not turn a moved domain revision into absent, got ${JSON.stringify(decided?.decision)}`)
  need(decided?.status === 'conflict', `the moved domain revision is a conflict, got ${JSON.stringify(decided?.status)}`)
  const audit = conflictEventsOf(kernel, recon.outboxId)
  need(audit.length === 1, `the diverged decision leaves exactly one audit event, got ${audit.length}`)
  return { forgedDomain: errorA?.detail, forgedRaw: outcomeB?.status, kindless: errorC?.code, forgedReconcile: decided?.decision }
})

// PRE-20 被取代后实际成功（08:111）：applied 仍记实际成功，但原因须是成功语义；
// 原取代原因保留在审计里，不能被覆盖掉。
check('PRE-20', 'a superseded item that really landed reports success and keeps the old reason in the audit', ({ kernel, root }) => {
  needOutboxHashColumns(kernel)
  const targets = textTargets()
  const old = adoptTarget(kernel, targets, { runId: 'run-eff-sup-land', target: 'pd:sup-land', baseContent: 'base-content', content: 'expected-old' })
  const generation = kernel.claimOutbox(old.outboxId, { observe: observeOf(targets) }).claimGeneration
  // 效果确实落地了：目标已经是旧采用的预期内容。
  targets.externalChange('pd:sup-land', 'expected-old')
  // 同目标被另一个 run 重新采用 → 旧在途项转 unknown，原因带 superseded。
  kernel.createRun({ id: 'run-eff-sup-land-2', input: { fixture: true }, steps: publicationSteps('pd:sup-land') })
  const attempt = kernel.claim('run-eff-sup-land-2')
  const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content: 'expected-new' })
  kernel.adopt({ attemptId: attempt.attemptId, token: attempt.token, candidate, target: 'pd:sup-land', baseRevision: 2, baseContentHash: sha256('expected-old'), targetKind: 'raw_text' })
  const supersededRow = rowOf(kernel, old.outboxId)
  need(supersededRow.status === 'outcome_unknown', `the superseded in-flight item becomes unknown, got ${supersededRow.status}`)
  need(/superseded/.test(String(supersededRow.reason)), `the superseded reason is recorded first, got ${JSON.stringify(supersededRow.reason)}`)

  const svc = createFakeBusinessService({ kernel, targetAdapter: targets.readonlyView() })
  svc.registerPrincipal({ id: 'ui-sup-land', kind: 'ui' })
  const result = svc.reconcilePublishEffect({ principal: 'ui-sup-land', outboxId: old.outboxId, claimGeneration: generation })
  need(result?.status === 'succeeded', `the landed effect is recorded as success, got ${JSON.stringify(result?.status)}`)
  need(result?.decision === 'applied', `the decision is applied, got ${JSON.stringify(result?.decision)}`)

  const row = rowOf(kernel, old.outboxId)
  need(row.status === 'succeeded', 'the row records the real success')
  // 成功状态必须配成功语义的原因：不能停在 superseded_while_running 这种失败/隔离语义上。
  need(!/superseded/i.test(String(row.reason)), `a succeeded item must not keep a superseded reason, got ${JSON.stringify(row.reason)}`)
  need(/applied|reconciled|success/i.test(String(row.reason)), `expected a success-semantic reason, got ${JSON.stringify(row.reason)}`)

  // 原取代原因不能丢：必须保留在本次对账审计里。
  const events = effectEventsOf(kernel, old.outboxId)
  need(events.length === 1, `the reconciliation writes exactly one effect audit event, got ${events.length}`)
  const payload = parsePayload(events[0])
  need(payload && payload.decision === 'applied', `the audit carries the decision, got ${JSON.stringify(payload?.decision)}`)
  need(/superseded_while_running/.test(JSON.stringify(payload)), `the original superseded reason must survive in the audit, got ${JSON.stringify(payload)}`)
  // 真实成功也让旧运行收尾：完成且不留在发布暂停里。
  const oldRun = runOf(kernel, 'run-eff-sup-land')
  need(oldRun.status === 'completed', `a landed effect completes the old run, got ${oldRun.status}`)
  need(oldRun.pause_reason === null, `the old run is not left in a publish pause, got ${JSON.stringify(oldRun.pause_reason)}`)
  return { status: row.status, reason: row.reason, decision: payload?.decision }
})

// ---------------------------------------------------------------------------------------------
const specChecks = results.filter((entry) => entry.kind === 'spec')
const selfcheck = results.filter((entry) => entry.kind === 'selfcheck')
const specFailed = specChecks.filter((entry) => entry.status !== 'pass').length
const selfcheckFailed = selfcheck.filter((entry) => entry.status !== 'pass').length
console.log(JSON.stringify({
  checks: results.length,
  passed: results.filter((entry) => entry.status === 'pass').length,
  assertions,
  specChecks: specChecks.length,
  specFailed,
  selfcheckChecks: selfcheck.length,
  selfcheckFailed,
  results,
}, null, 2))
process.exitCode = specFailed > 0 || selfcheckFailed > 0 ? 1 : 0
