// W1「无回调发布转待核验」入口专项（happy-4.1 独立复核，2026-11-14）。
// 全程临时 SQLite + 临时根目录 + 假服务，不碰生产库、不发 HTTP、不调真实模型。
//
// 本批边界（老大 m01244 口径）：仅新增本文件，不改实现；权限收窄属新增约束，由老大同步文档与实现。
//
// 为什么需要这个入口（可复现反例，来自 m01243 的只读核对）：
//   发布被领取后、结果回来之前，进程崩溃或适配器失联，就会留下 row=running / claim_generation=1，
//   而 Attempt 早已 succeeded、run 仍 running。此时：
//     - reapExpiredLeases 只看 workflow_attempts.status='running'，这类项永久免疫；
//     - scanRecoverable 只发现（outbox_running），不改变任何状态；
//     - resume 回 publish_unresolved；retryOutbox 回 outbox_requires_reconcile；
//       claimOutbox 回 outbox_not_claimable；下一步 claim 回 run_paused；
//     - cancelRun 能把运行整条取消，但那等于放弃（之后对账 not_published 直接 superseded），
//       不是「先承认不知道、再等人核验」；
//     - host.publish 对已领取项只能报 outbox_already_claimed，因为它在同一次调用里先 claim 再 settle。
//   于是"承认这次发布结果未知"这件事，今天没有任何可复用的调用路径。
//
// 本批冻结的契约形状（建议；若实施方改名，需同时改本文件对应断言）：
//   A. 内核 markOutboxUnknown(id, { actorId, reason, claimGeneration })：
//        - 行不存在 → outbox_not_found
//        - actorId 非非空字符串 → schema_invalid（detail publish_actor_required）
//        - reason 非非空字符串 / 超长 → schema_invalid（detail publish_reason_required / publish_reason_too_long）
//        - 行仍 pending → outbox_not_claimed（没领取就没有"结果未知"可声明）
//        - 行非 running（已终结）→ cas_conflict
//        - 代次缺失 / 非正整数 / 不等于当前代次 → outbox_claim_mismatch（复用 assertClaimGeneration）
//        - 通过后：同事务把行置 outcome_unknown、reason=调用方给的原因、settleRun，
//          并写一条审计事件 outbox.unknown_declared，payload 至少含
//          { outboxId, claimGeneration, reason, actorId, declaredAt }。
//        - 不入参 status：本入口只表达"结果未知"，不能拿它记成功。
//   B. 服务 declarePublishUnknown({ principal, outboxId, claimGeneration, reason, credential }):
//        - 只允许 ui / scheduler（node-agent 虽有 control.run=scoped 也必须拒绝：它没执行这次发布）
//        - 顺序 = 身份档位 → 反查 outbox 所属 run 并做产品归属（对外不可区分）→ 参数校验
//        - 记入的 actorId 只取已授权身份记录的 id，请求里带的 actorId 一律不采信
//        - 服务不返回、也不接受"发布成功"的语义
//
// 错误码折叠（不新增 SERVICE_ERROR_CODES）：outbox_not_found → artifact_missing；
//   outbox_not_claimed / outbox_claim_mismatch / cas_conflict → publish_conflict / schema_invalid（按既有映射）；
//   schema_invalid 与 capability_unavailable、artifact_missing 保持既有语义。
//   本文件按"服务出口码"断言，因此不依赖 detail 文案，唯一例外是 reason/actor 的 detail（见上）。
//
// 明确不覆盖（不得据此宣称已解决）：
//   - 自动恢复：本入口是**人/适配器主动声明**，不是超时推断，不做 running→unknown 的自动转换。
//   - 租约与心跳默认值（03-node-contract-runtime.md:111 留给 W0）。
//   - 服务层带证据的 reconcile 入口（另有批次）；本文件只用内核 reconcilePublishEffect 构造前置状态，
//     且每次对账都提供来自独立夹具的真实观测。
//   - 真实宿主"领取→异步→回调"窗口；假服务同步，跨代回调只在调用次序上可复现。
//
// 本文件刻意红（入口尚未实现）：MRU-00 自检应始终为绿，其余 spec 项在实现落地前应全红。

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

const expectCode = (fn, code) => {
  try {
    fn()
  } catch (error) {
    need(error.code === code, `expected ${code} but got ${error.code ?? error.message} (${error.detail ?? ''} ${error.message ?? ''})`)
    return error
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

const expectAnyThrow = (fn) => {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to fail, but it succeeded')
}

// 本批冻结的服务出口码：代次不符固定折成 publish_conflict / outbox_claim_mismatch。
// 不写在 DOMAIN_TO_SERVICE 之外的任何地方；detail 必须就是领域码本身，不能用别的说明顶替。
const expectGenerationMismatch = (fn) => {
  const error = expectCode(fn, 'publish_conflict')
  need(error.detail === 'outbox_claim_mismatch', `the service must report detail outbox_claim_mismatch, got ${JSON.stringify(error.detail)}`)
  return error
}

const check = (id, title, fn, kind = 'spec') => {
  const root = mkdtempSync(join(tmpdir(), `m1-unk-${id}-`))
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

// 零副作用指纹：动态发现全库用户表（新增表/列自动纳入），加上 objects/、manifests/、staging/
// 下每个文件的路径、字节数与内容 sha256 —— 只比路径无法证明逐字节不变。
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

// 独立摘要：与内核同口径，但自己算，不借内核函数。
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

// content 是目标此刻的真实正文；给了才回报 contentHash（需要内容证据的项一律给）。
const adapter = (revision, { content = null } = {}) => ({
  observeTarget: (target) => ({ target, revision, ...(content === null ? {} : { contentHash: sha256(content) }), observedAt: '2026-11-14T00:00:00.000Z' }),
})

// 造一个"已采用、必需发布仍待发"的运行：采用后 run 不会自行终结，可以领取。
// 基准正文来自独立夹具（按 target 生成），不取自候选、不取自 outbox；对账因此有真实观测可给。
const baseOf = (target) => `unknown base of ${target}`
const pendingRun = (kernel, { runId = 'run-unk', content = 'unknown fixture', target = 'pd:unk', baseRevision = 1, baseContent = null, targetKind = 'raw_text' } = {}) => {
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
const runOf = (kernel, runId) => kernel.one('SELECT status, pause_reason FROM workflow_runs WHERE id=?', runId)
const eventsOf = (kernel, runId) => kernel.query('SELECT id,type,payload,created_at FROM workflow_events WHERE run_id=? ORDER BY seq', runId)
const eventsByType = (kernel, runId, type) => eventsOf(kernel, runId).filter((row) => row.type === type)
const claimedEventsOf = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type='outbox.claimed' AND payload LIKE ?", `%${outboxId}%`)
const declaredEventsOf = (kernel, outboxId) => kernel.query("SELECT id,payload FROM workflow_events WHERE type='outbox.unknown_declared' AND payload LIKE ?", `%${outboxId}%`)

const claimOf = (kernel, item) => {
  const claimed = kernel.claimOutbox(item.outboxId, { observe: adapter(item.baseRevision, { content: item.baseContent }).observeTarget })
  need(claimed && claimed.status === 'running', 'claim reports the item as running')
  need(Number.isSafeInteger(claimed.claimGeneration) && claimed.claimGeneration >= 1, `claim must report a positive integer claimGeneration, got ${JSON.stringify(claimed.claimGeneration)}`)
  return claimed.claimGeneration
}

// 待实现的入口：缺函数就红在"入口不存在"上，不让 TypeError 混进断言里看不出结论。
// 注意这里**不给 reason 兜默认值**，否则 MRU-06 的缺失场景会被测试自己补上，永远抓不到。
const declareUnknown = (kernel, outboxId, { actorId = 'operator-fixture', reason, claimGeneration } = {}) => {
  need(typeof kernel.markOutboxUnknown === 'function', 'the kernel must expose markOutboxUnknown(id, { actorId, reason, claimGeneration })')
  return kernel.markOutboxUnknown(outboxId, { actorId, reason, claimGeneration })
}

const declareViaService = (svc, request) => {
  need(typeof svc.declarePublishUnknown === 'function', 'the service must expose declarePublishUnknown({ principal, outboxId, claimGeneration, reason, credential })')
  return svc.declarePublishUnknown(request)
}

const parsePayload = (row) => {
  try { return JSON.parse(row.payload) } catch { return null }
}

// ---------------------------------------------------------------------------------------------
// MRU-00 自检（应始终为绿）：场景真实可达、指纹能检出一次真实写入，且"领取后无回调"确实是死角。
// 刻意不引用待实现的入口，否则会和红测一起红、失去防恒真的作用。
check('MRU-00', 'a claimed publish really is a dead end today, and the fingerprint detects a real write', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-unk-reach', target: 'pd:unk-reach' })
  const generation = claimOf(kernel, item)
  const claimed = rowOf(kernel, item.outboxId)
  need(claimed.status === 'running', 'the claimed row is running')
  need(claimed.claim_generation === generation, 'the persisted generation equals the one claim reported')
  const attempt = kernel.one('SELECT status FROM workflow_attempts WHERE id=?', item.attempt.attemptId)
  need(attempt.status === 'succeeded', 'the attempt has already succeeded, so lease reaping can never see this item')
  need(runOf(kernel, item.runId).status === 'running', 'the run is still running, so it is not discoverable as paused either')

  // 现有三条路都走不通（这是"需要新入口"的实证，不是新契约）。
  expectCode(() => kernel.claimOutbox(item.outboxId, { observe: adapter(item.baseRevision).observeTarget }), 'outbox_already_claimed')
  expectCode(() => kernel.retryOutbox(item.outboxId), 'cas_conflict')
  const scan = kernel.scanRecoverable({ at: '2026-11-14T00:00:00.000Z' }).items.filter((entry) => entry.outboxId === item.outboxId)
  need(scan.length === 1 && scan[0].kind === 'outbox_running', `the scan only reports the item (${scan.map((entry) => entry.kind).join(',')})`)
  need(scan[0].claimGeneration === generation, 'the scan exposes the persisted generation')
  need(rowOf(kernel, item.outboxId).status === 'running', 'none of the discovery paths changed the row')

  // 反向对照：一次真实写入必须改变指纹，否则后面所有"指纹不变"都是恒真。
  const before = state(kernel, root)
  kernel.completeOutbox(item.outboxId, 'failed', 'real_write_control', generation)
  const after = state(kernel, root)
  need(before !== after, 'a real settlement must change the state fingerprint')
  return { generation, scanKind: scan[0].kind, mutationDetected: true }
}, 'selfcheck')

// ---------------------------------------------------------------------------------------------
// MRU-01 内核 happy path：只记"结果未知"，并留下可用于审计的记录。
check('MRU-01', 'the kernel records an unknown publish outcome with its generation and audit trail', ({ kernel }) => {
  const item = pendingRun(kernel, { runId: 'run-unk-kernel', target: 'pd:unk-kernel' })
  const generation = claimOf(kernel, item)

  const declared = declareUnknown(kernel, item.outboxId, { actorId: 'operator-kernel', reason: 'adapter_unreachable', claimGeneration: generation })
  need(declared && declared.outboxId === item.outboxId, 'the declaration reports the outbox id it changed')
  need(declared.status === 'outcome_unknown', `the declaration reports outcome_unknown, got ${JSON.stringify(declared.status)}`)

  const row = rowOf(kernel, item.outboxId)
  need(row.status === 'outcome_unknown', `the row becomes outcome_unknown, got ${row.status}`)
  need(row.reason === 'adapter_unreachable', `the caller reason is preserved, got ${JSON.stringify(row.reason)}`)
  need(row.claim_generation === generation, 'the generation is unchanged by the declaration')

  const run = runOf(kernel, item.runId)
  need(run.status === 'paused', `the run pauses instead of completing, got ${run.status}`)
  need(run.pause_reason === 'publish_outcome_unknown', `the pause reason names the unknown publish, got ${JSON.stringify(run.pause_reason)}`)

  const audits = declaredEventsOf(kernel, item.outboxId)
  need(audits.length === 1, `exactly one outbox.unknown_declared event is recorded, got ${audits.length}`)
  const payload = parsePayload(audits[0])
  need(payload && payload.outboxId === item.outboxId, 'the audit event names the outbox')
  need(payload.claimGeneration === generation, `the audit event records the generation, got ${JSON.stringify(payload?.claimGeneration)}`)
  need(payload.reason === 'adapter_unreachable', 'the audit event records the reason')
  need(payload.actorId === 'operator-kernel', `the audit event records the actor, got ${JSON.stringify(payload?.actorId)}`)
  need(typeof payload.declaredAt === 'string' && payload.declaredAt.length > 0, 'the audit event records when the declaration happened')

  // 「未知」不是「成功」：不得记成 succeeded，也不得留下自定义成功语义。
  need(row.status !== 'succeeded', 'an unknown declaration is never recorded as success')
  const settled = eventsByType(kernel, item.runId, 'outbox.settled')
  need(!settled.some((event) => parsePayload(event)?.status === 'succeeded'), 'no settlement event claims success')

  return { generation, rowStatus: row.status, runStatus: run.status, pauseReason: run.pause_reason, auditPayload: payload }
})

// MRU-02 服务层：ui 与 scheduler 都能声明；记入的操作者来自身份记录。
check('MRU-02', 'the service lets ui and scheduler declare, and records the identity as the actor', ({ kernel, root }) => {
  const svc = createFakeBusinessService({ kernel })
  svc.registerPrincipal({ id: 'ui-op', kind: 'ui' })
  svc.registerPrincipal({ id: 'sched-op', kind: 'scheduler' })

  const first = pendingRun(kernel, { runId: 'run-unk-ui', target: 'pd:unk-ui' })
  const firstGeneration = claimOf(kernel, first)
  const byUi = declareViaService(svc, { principal: 'ui-op', outboxId: first.outboxId, claimGeneration: firstGeneration, reason: 'no_callback_from_adapter' })
  need(byUi && byUi.status === 'outcome_unknown', `the ui declaration reports outcome_unknown, got ${JSON.stringify(byUi?.status)}`)
  need(rowOf(kernel, first.outboxId).status === 'outcome_unknown', 'the ui declaration changes the row')
  const uiAudit = parsePayload(declaredEventsOf(kernel, first.outboxId)[0])
  need(uiAudit && uiAudit.actorId === 'ui-op', `the ui identity is recorded as the actor, got ${JSON.stringify(uiAudit?.actorId)}`)

  const second = pendingRun(kernel, { runId: 'run-unk-sched', target: 'pd:unk-sched' })
  const secondGeneration = claimOf(kernel, second)
  const byScheduler = declareViaService(svc, { principal: 'sched-op', outboxId: second.outboxId, claimGeneration: secondGeneration, reason: 'adapter_timeout_unknown' })
  need(byScheduler && byScheduler.status === 'outcome_unknown', `the scheduler declaration reports outcome_unknown, got ${JSON.stringify(byScheduler?.status)}`)
  const schedAudit = parsePayload(declaredEventsOf(kernel, second.outboxId)[0])
  need(schedAudit && schedAudit.actorId === 'sched-op', `the scheduler identity is recorded as the actor, got ${JSON.stringify(schedAudit?.actorId)}`)

  return { uiStatus: rowOf(kernel, first.outboxId).status, schedStatus: rowOf(kernel, second.outboxId).status, uiActor: uiAudit?.actorId, schedActor: schedAudit?.actorId }
})

// MRU-03 操作者不可伪造：请求里带的 actorId 一律不采信。
check('MRU-03', 'a caller-supplied actorId is never trusted as the operator', ({ kernel }) => {
  const svc = createFakeBusinessService({ kernel })
  svc.registerPrincipal({ id: 'ui-real', kind: 'ui' })

  const item = pendingRun(kernel, { runId: 'run-unk-forge', target: 'pd:unk-forge' })
  let generation = claimOf(kernel, item)

  for (const forged of ['sched-op', 'admin', '', null, { id: 'object-actor' }, 42]) {
    const before = state(kernel, kernel.root)
    declareViaService(svc, { principal: 'ui-real', outboxId: item.outboxId, claimGeneration: generation, reason: 'forged_actor_probe', actorId: forged })
    const payload = parsePayload(declaredEventsOf(kernel, item.outboxId).at(-1))
    need(payload && payload.actorId === 'ui-real', `a forged actorId ${JSON.stringify(forged)} must not be recorded (got ${JSON.stringify(payload?.actorId)})`)
    need(before !== state(kernel, kernel.root), 'the declaration really wrote something, so the actor check is meaningful')
    // 复位成可再次声明的状态：unknown → 对账 not_published → pending → 重新领取（代次递增）。
    const current = rowOf(kernel, item.outboxId)
    // 目标仍是基准正文 → absent，这是唯一允许回到 pending 的观测定论。
    const reset = kernel.reconcilePublishEffect(item.outboxId, {
      actorId: 'fixture-reconciler',
      claimGeneration: current.claim_generation,
      observe: adapter(item.baseRevision, { content: item.baseContent }).observeTarget,
    })
    need(reset.decision === 'absent', `the fixture reset must observe an untouched base, got ${reset.decision}`)
    generation = claimOf(kernel, item)
    need(generation === current.claim_generation + 1, 'the fixture re-claims with an advanced generation')
  }

  const payloads = declaredEventsOf(kernel, item.outboxId).map(parsePayload)
  need(payloads.every((payload) => payload?.actorId === 'ui-real'), 'every recorded actor is the authenticated identity')
  return { declarations: payloads.length, actors: payloads.map((payload) => payload.actorId) }
})

// MRU-04 其他身份拒绝：node-agent 即便被授予该 run 也必须拒绝；拒绝时零写入。
check('MRU-04', 'identities other than ui and scheduler are refused without any effect', ({ kernel, root }) => {
  const svc = createFakeBusinessService({ kernel })
  svc.registerPrincipal({ id: 'agent-scoped', kind: 'node-agent', runIds: ['run-unk-deny', 'run-unk-deny-2', 'run-unk-deny-3'] })
  svc.registerPrincipal({ id: 'agent-other', kind: 'other-agent' })
  svc.registerPrincipal({ id: 'http-client-1', kind: 'http-client', credential: 'cred-1' })

  const item = pendingRun(kernel, { runId: 'run-unk-deny', target: 'pd:unk-deny' })
  const generation = claimOf(kernel, item)
  const before = state(kernel, root)

  for (const principal of ['agent-scoped', 'agent-other', 'http-client-1', 'nobody-registered']) {
    const error = expectCode(
      () => declareViaService(svc, { principal, outboxId: item.outboxId, claimGeneration: generation, reason: 'unauthorized_probe' }),
      'capability_unavailable',
    )
    need(!String(error.detail ?? '').startsWith('outbox'), `a refused identity must not learn the outbox state, got ${error.detail}`)
  }

  need(state(kernel, root) === before, 'no refused identity left any trace')
  need(rowOf(kernel, item.outboxId).status === 'running', 'the item is still running')
  need(declaredEventsOf(kernel, item.outboxId).length === 0, 'no audit event is written for refused identities')
  return { refused: 4, rowStatus: rowOf(kernel, item.outboxId).status }
})

// MRU-05 产品归属：跨产品的声明对外不可区分，且零写入；同产品正控成功。
check('MRU-05', 'a declaration from another product cannot tell the run exists', ({ kernel, root }) => {
  const svc = createFakeBusinessService({ kernel })
  svc.registerPrincipal({ id: 'ui-p1', kind: 'ui', productId: 'p1' })
  svc.registerPrincipal({ id: 'ui-p2', kind: 'ui', productId: 'p2' })

  const item = pendingRun(kernel, { runId: 'run-unk-product', target: 'pd:unk-product' })
  svc.host.registerRunProduct(item.runId, 'p1')
  const generation = claimOf(kernel, item)
  const before = state(kernel, root)

  expectCode(
    () => declareViaService(svc, { principal: 'ui-p2', outboxId: item.outboxId, claimGeneration: generation, reason: 'cross_product_probe' }),
    'artifact_missing',
  )
  // 同一路径下，不存在的 outbox 也必须给出同一个码，否则 outboxId 成了存在性预言机。
  expectCode(
    () => declareViaService(svc, { principal: 'ui-p2', outboxId: 'run-does-not-exist:publish', claimGeneration: generation, reason: 'cross_product_probe' }),
    'artifact_missing',
  )
  need(state(kernel, root) === before, 'a cross-product declaration writes nothing')
  need(rowOf(kernel, item.outboxId).status === 'running', 'the item is still running after the cross-product attempt')

  const own = declareViaService(svc, { principal: 'ui-p1', outboxId: item.outboxId, claimGeneration: generation, reason: 'own_product_ok' })
  need(own && own.status === 'outcome_unknown', 'the owning product can declare')
  need(declaredEventsOf(kernel, item.outboxId).length === 1, 'exactly the accepted declaration is recorded')
  return { crossProductCode: 'artifact_missing', ownStatus: rowOf(kernel, item.outboxId).status }
})

// MRU-06 原因必填：缺失、空白、非字符串、过长都不许被默认值顶替；
// 上限按本批新增约束固定为 500 个 JavaScript 字符串长度单位（UTF-16 单元），恰好 500 必须放行且原文保留。
check('MRU-06', 'a reason is required, capped at 500 units and kept verbatim', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-unk-reason', target: 'pd:unk-reason' })
  const generation = claimOf(kernel, item)

  const cases = [
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['tab-only', '\t\n'],
    ['number', 42],
    ['object', { reason: 'x' }],
    ['array', ['x']],
    ['null', null],
    ['too-long', 'x'.repeat(501)],
  ]
  for (const [label, reason] of cases) {
    const before = state(kernel, kernel.root)
    const request = { actorId: 'operator-fixture', claimGeneration: generation }
    if (label !== 'missing') request.reason = reason
    const error = expectCode(() => declareUnknown(kernel, item.outboxId, request), 'schema_invalid')
    // 内核的 fail(code, message) 把说明放在 message 上，服务层才放 detail；两边都接受。
    const described = String(error.detail ?? error.message ?? '')
    need(/reason/i.test(described), `the ${label} reason must be named in the error, got ${described}`)
    need(state(kernel, kernel.root) === before, `a ${label} reason changes nothing`)
    need(rowOf(kernel, item.outboxId).status === 'running', `the item stays running after a ${label} reason`)
  }
  need(declaredEventsOf(kernel, item.outboxId).length === 0, 'no audit event is written for a rejected reason')

  // 边界正控：恰好 500 个单元必须放行，并且不得被裁剪、去空白或改写。用一个含首尾空格与中文的原文，
  // 这样"trim 后再存"或"按字节截断"都会被抓到。
  const boundaryItem = pendingRun(kernel, { runId: 'run-unk-reason-boundary', target: 'pd:unk-reason-boundary' })
  const boundaryGeneration = claimOf(kernel, boundaryItem)
  const head = '  无法确认发布结果 '
  const tail = ' 保留原文 '
  const exact = `${head}${'缺'.repeat(500 - head.length - tail.length)}${tail}`
  need(exact.length === 500, `the fixture reason is exactly 500 length units, got ${exact.length}`)
  declareUnknown(kernel, boundaryItem.outboxId, { actorId: 'operator-boundary', reason: exact, claimGeneration: boundaryGeneration })
  const boundaryRow = rowOf(kernel, boundaryItem.outboxId)
  need(boundaryRow.status === 'outcome_unknown', 'a 500-unit reason is accepted')
  need(boundaryRow.reason === exact, 'a 500-unit reason is kept verbatim, not trimmed or truncated')
  const boundaryAudit = parsePayload(declaredEventsOf(kernel, boundaryItem.outboxId)[0])
  need(boundaryAudit && boundaryAudit.reason === exact, 'the audit event keeps the reason verbatim too')

  return { rejectedReasons: cases.length, boundaryAccepted: boundaryRow.reason.length, boundaryKeptVerbatim: boundaryRow.reason === exact }
})

// MRU-07 代次：缺失、非法、零、负数、旧代次、超前代次都必须拒绝；当前代次才放行。
check('MRU-07', 'the generation must be the current positive claim generation', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-unk-gen', target: 'pd:unk-gen' })
  const first = claimOf(kernel, item)
  need(first === 1, `the fixture starts at generation 1, got ${first}`)

  const bad = [undefined, null, '1', 1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, false, [], {}, first + 1, first - 1]
  for (const generation of bad) {
    if (generation === 0) continue // 0 单列在 MRU-12 的旧库场景里
    const before = state(kernel, kernel.root)
    expectCode(() => declareUnknown(kernel, item.outboxId, { actorId: 'operator-fixture', reason: 'generation_probe', claimGeneration: generation }), 'outbox_claim_mismatch')
    need(state(kernel, kernel.root) === before, `a rejected generation ${JSON.stringify(generation)} changes nothing`)
    need(rowOf(kernel, item.outboxId).status === 'running', 'the item stays running')
  }

  // 旧的、但仍合法的正整数代次：重领一次后旧代必须被拒。
  kernel.completeOutbox(item.outboxId, undefined, null, first)
  need(rowOf(kernel, item.outboxId).status === 'outcome_unknown', 'no result means outcome_unknown')
  kernel.reconcilePublishEffect(item.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: first,
    observe: adapter(item.baseRevision, { content: item.baseContent }).observeTarget,
  })
  const second = claimOf(kernel, item)
  need(second === first + 1, 'the second claim advances the generation')

  const before = state(kernel, kernel.root)
  expectCode(() => declareUnknown(kernel, item.outboxId, { actorId: 'operator-fixture', reason: 'stale_generation', claimGeneration: first }), 'outbox_claim_mismatch')
  need(state(kernel, kernel.root) === before, 'a stale generation changes nothing')
  const row = rowOf(kernel, item.outboxId)
  need(row.status === 'running' && row.claim_generation === second, 'the row still belongs to the current generation')

  const accepted = declareUnknown(kernel, item.outboxId, { actorId: 'operator-fixture', reason: 'current_generation', claimGeneration: second })
  need(accepted.status === 'outcome_unknown', 'the current generation can declare')
  return { first, second, rejected: bad.filter((generation) => generation !== 0).length + 1 }
})

// MRU-08 状态门槛：未领取 → outbox_not_claimed；已终结 → cas_conflict。
check('MRU-08', 'only a running item can be declared unknown', ({ kernel, root }) => {
  // 未领取
  const pending = pendingRun(kernel, { runId: 'run-unk-state-pending', target: 'pd:unk-state-pending' })
  const pendingBefore = state(kernel, root)
  expectCode(() => declareUnknown(kernel, pending.outboxId, { actorId: 'operator-fixture', reason: 'not_claimed_probe', claimGeneration: 1 }), 'outbox_not_claimed')
  need(state(kernel, root) === pendingBefore, 'declaring over a pending item changes nothing')
  need(rowOf(kernel, pending.outboxId).status === 'pending', 'the pending item stays pending')

  // 已终结的四个终态 + superseded
  const terminals = ['succeeded', 'failed', 'conflict', 'outcome_unknown']
  const observed = []
  for (const status of terminals) {
    const item = pendingRun(kernel, { runId: `run-unk-state-${status}`, target: `pd:unk-state-${status}`, content: `fixture-${status}` })
    const generation = claimOf(kernel, item)
    kernel.completeOutbox(item.outboxId, status, `${status}_reason`, generation)
    const before = state(kernel, kernel.root)
    expectCode(() => declareUnknown(kernel, item.outboxId, { actorId: 'operator-fixture', reason: 'terminal_probe', claimGeneration: generation }), 'cas_conflict')
    need(state(kernel, kernel.root) === before, `a ${status} item is untouched`)
    need(rowOf(kernel, item.outboxId).status === status, `the ${status} item keeps its status`)
    observed.push(status)
  }

  const superseded = pendingRun(kernel, { runId: 'run-unk-state-superseded', target: 'pd:unk-state-superseded' })
  kernel.cancelRun(superseded.runId)
  need(rowOf(kernel, superseded.outboxId).status === 'superseded', 'cancelling before claim supersedes the item')
  const before = state(kernel, root)
  expectCode(() => declareUnknown(kernel, superseded.outboxId, { actorId: 'operator-fixture', reason: 'superseded_probe', claimGeneration: 1 }), 'cas_conflict')
  need(state(kernel, root) === before, 'a superseded item is untouched')
  need(rowOf(kernel, superseded.outboxId).status === 'superseded', 'the superseded item keeps its status')

  return { pending: 'outbox_not_claimed', terminals: observed, superseded: 'cas_conflict' }
})

// MRU-09 顺序：身份与产品归属先于参数；参数错误不得先于授权泄露。
check('MRU-09', 'identity and product ownership are checked before the parameters', ({ kernel, root }) => {
  const svc = createFakeBusinessService({ kernel })
  svc.registerPrincipal({ id: 'agent-ordered', kind: 'node-agent', runIds: ['run-unk-order'] })
  svc.registerPrincipal({ id: 'ui-ord-p1', kind: 'ui', productId: 'p1' })
  svc.registerPrincipal({ id: 'ui-ord-p2', kind: 'ui', productId: 'p2' })
  svc.registerPrincipal({ id: 'ui-ord', kind: 'ui' })

  const item = pendingRun(kernel, { runId: 'run-unk-order', target: 'pd:unk-order' })
  svc.host.registerRunProduct(item.runId, 'p1')
  const generation = claimOf(kernel, item)
  const before = state(kernel, root)

  // 无权身份 + 坏参数：必须报权限，不许报参数错（否则等于确认了参数校验路径存在）。
  const denied = expectCode(
    () => declareViaService(svc, { principal: 'agent-ordered', outboxId: item.outboxId, claimGeneration: 'not-a-generation', reason: '   ' }),
    'capability_unavailable',
  )
  need(!/reason|generation|claim/i.test(String(denied.detail ?? '')), `the refusal must not describe the parameters, got ${denied.detail}`)

  // 跨产品 + 坏参数：必须报不可区分，不许报参数错。
  expectCode(
    () => declareViaService(svc, { principal: 'ui-ord-p2', outboxId: item.outboxId, claimGeneration: 'not-a-generation', reason: '   ' }),
    'artifact_missing',
  )

  need(state(kernel, root) === before, 'no ordered rejection wrote anything')

  // 有权身份才轮到参数校验：reason → schema_invalid；代次不符 → 本批已冻结的服务出口码
  // publish_conflict / outbox_claim_mismatch（精确断言见 MRU-13）。
  expectCode(
    () => declareViaService(svc, { principal: 'ui-ord', outboxId: item.outboxId, claimGeneration: generation, reason: '   ' }),
    'schema_invalid',
  )
  expectGenerationMismatch(() => declareViaService(svc, { principal: 'ui-ord', outboxId: item.outboxId, claimGeneration: 'not-a-generation', reason: 'reason_ok' }))
  need(state(kernel, root) === before, 'the ordered rejections wrote nothing at all')
  need(rowOf(kernel, item.outboxId).status === 'running', 'the item is still running after the parameter probes')
  return { deniedFirst: denied.detail, crossProductFirst: 'artifact_missing', generationMismatch: 'publish_conflict/outbox_claim_mismatch' }
})

// MRU-10 同事务：状态与审计事件一起成功或一起回滚。
check('MRU-10', 'the status change and its audit event are in one transaction', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-unk-tx', target: 'pd:unk-tx' })
  const generation = claimOf(kernel, item)
  // 只让**声明自己的审计事件**写失败：若触发器按 run_id 拦截，结算事件（outbox.settled）会先失败，
  // 于是"先提交状态、再补写审计"的错误实现也会因为状态被连带回滚而蒙混过关（实测如此）。
  kernel.db.exec(`CREATE TRIGGER mru_tx_boom BEFORE INSERT ON workflow_events WHEN NEW.type='outbox.unknown_declared' AND NEW.run_id='${item.runId}' BEGIN SELECT RAISE(ABORT, 'audit_unavailable'); END`)

  const before = state(kernel, root)
  expectAnyThrow(() => declareUnknown(kernel, item.outboxId, { actorId: 'operator-tx', reason: 'audit_write_fails', claimGeneration: generation }))

  need(state(kernel, root) === before, 'an aborted audit write must roll the status change back')
  const row = rowOf(kernel, item.outboxId)
  need(row.status === 'running', `the row must stay running when the audit write fails, got ${row.status}`)
  need(row.reason === null, `the reason must not be left behind, got ${JSON.stringify(row.reason)}`)
  need(runOf(kernel, item.runId).status === 'running', 'the run must not be paused by a rolled-back declaration')
  need(eventsByType(kernel, item.runId, 'outbox.unknown_declared').length === 0, 'no audit event survived')
  need(eventsByType(kernel, item.runId, 'outbox.settled').length === 0, 'the settlement event is rolled back together with the audit, proving one transaction')

  kernel.db.exec('DROP TRIGGER mru_tx_boom')
  const after = declareUnknown(kernel, item.outboxId, { actorId: 'operator-tx', reason: 'audit_write_ok', claimGeneration: generation })
  need(after.status === 'outcome_unknown', 'once the audit write works again the declaration succeeds')
  need(declaredEventsOf(kernel, item.outboxId).length === 1, 'exactly one audit event is recorded')
  return { rolledBack: true, recovered: rowOf(kernel, item.outboxId).status }
})

// MRU-11 声明之后仍然禁止重发：既不能重试、重领，也不能让运行自己继续。
check('MRU-11', 'an unknown publish can never be resent', ({ kernel }) => {
  const item = pendingRun(kernel, { runId: 'run-unk-norepeat', target: 'pd:unk-norepeat' })
  const generation = claimOf(kernel, item)
  declareUnknown(kernel, item.outboxId, { actorId: 'operator-fixture', reason: 'no_callback', claimGeneration: generation })

  const claimsBefore = claimedEventsOf(kernel, item.outboxId).length
  expectCode(() => kernel.retryOutbox(item.outboxId), 'outbox_requires_reconcile')
  expectCode(() => kernel.claimOutbox(item.outboxId, { observe: adapter(item.baseRevision).observeTarget }), 'outbox_not_claimable')
  expectCode(() => kernel.resume(item.runId), 'publish_unresolved')
  expectCode(() => kernel.claim(item.runId), 'run_paused')
  expectCode(() => declareUnknown(kernel, item.outboxId, { actorId: 'operator-fixture', reason: 'second_declaration', claimGeneration: generation }), 'cas_conflict')

  need(claimedEventsOf(kernel, item.outboxId).length === claimsBefore, 'no additional claim happens after the declaration')
  const row = rowOf(kernel, item.outboxId)
  need(row.status === 'outcome_unknown', `the item stays outcome_unknown, got ${row.status}`)
  need(row.claim_generation === generation, 'the generation is unchanged')
  need(rowOf(kernel, item.outboxId).status !== 'succeeded', 'nothing turns the unknown item into a success')
  need(declaredEventsOf(kernel, item.outboxId).length === 1, 'only the first declaration is recorded')

  // 唯一允许的下一步是对账，且必须带真实观测：目标已是这条发布的预期正文才允许记成功。
  const reconciled = kernel.reconcilePublishEffect(item.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: generation,
    observe: adapter(item.baseRevision + 1, { content: item.content }).observeTarget,
  })
  need(reconciled.decision === 'applied', `observing the expected content reconciles as applied, got ${reconciled.decision}`)
  need(rowOf(kernel, item.outboxId).status === 'succeeded', 'reconciling an applied effect is the only way forward')
  return { refused: ['retryOutbox', 'claimOutbox', 'resume', 'claim', 'secondDeclaration'], afterReconcile: rowOf(kernel, item.outboxId).status }
})

// MRU-12 旧库零代次：0 不是可用身份，running 的历史行不能被"0 也算整数"放过。
check('MRU-12', 'a legacy zero generation can never be used to declare', ({ kernel, root }) => {
  const item = pendingRun(kernel, { runId: 'run-unk-legacy', target: 'pd:unk-legacy' })
  const generation = claimOf(kernel, item)
  // 模拟旧库：ALTER 补出的列在运行中的历史行上为 0（真实现场的造法见 08-storage-migration.md:91）。
  kernel.db.prepare("UPDATE workflow_outbox SET status='running', claim_generation=0 WHERE id=?").run(item.outboxId)
  need(rowOf(kernel, item.outboxId).claim_generation === 0, 'the fixture really holds a zero generation')

  for (const claimedGeneration of [0, 1, generation + 1]) {
    const before = state(kernel, root)
    expectCode(() => declareUnknown(kernel, item.outboxId, { actorId: 'operator-fixture', reason: 'legacy_probe', claimGeneration: claimedGeneration }), 'outbox_claim_mismatch')
    need(state(kernel, root) === before, `a legacy declaration with generation ${claimedGeneration} writes nothing`)
    need(rowOf(kernel, item.outboxId).status === 'running', 'the legacy row keeps its status')
    need(rowOf(kernel, item.outboxId).claim_generation === 0, 'the legacy row keeps its generation')
  }
  need(declaredEventsOf(kernel, item.outboxId).length === 0, 'no audit event is written for a legacy row')
  const scan = kernel.scanRecoverable({ at: '2026-11-14T00:00:00.000Z' }).items.filter((entry) => entry.outboxId === item.outboxId)
  need(scan.length === 1 && scan[0].claimGeneration === 0, 'diagnostics still expose the legacy row')
  return { refusedGenerations: [0, 1, generation + 1], scanKind: scan[0].kind, scanGeneration: scan[0].claimGeneration }
})

// MRU-13 服务出口码：代次不符固定折成 publish_conflict / outbox_claim_mismatch，零写入，
// 且不能把"别的冲突"也折成这个 detail（用 superseded 行做反面对照）。
check('MRU-13', 'a service generation mismatch is exactly publish_conflict / outbox_claim_mismatch', ({ kernel, root }) => {
  const svc = createFakeBusinessService({ kernel })
  svc.registerPrincipal({ id: 'ui-gen', kind: 'ui' })

  const item = pendingRun(kernel, { runId: 'run-unk-svcgen', target: 'pd:unk-svcgen' })
  const first = claimOf(kernel, item)
  // 造出代次 2：无结果结算 → 对账 not_published → 重领。
  kernel.completeOutbox(item.outboxId, undefined, null, first)
  kernel.reconcilePublishEffect(item.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: first,
    observe: adapter(item.baseRevision, { content: item.baseContent }).observeTarget,
  })
  const current = claimOf(kernel, item)
  need(current === first + 1, `the fixture holds generation ${current} after a re-claim`)

  const bad = [undefined, null, '2', 2.5, 0, -1, Number.NaN, false, [], {}, first, current + 1]
  for (const claimGeneration of bad) {
    const before = state(kernel, root)
    const error = expectGenerationMismatch(() => declareViaService(svc, { principal: 'ui-gen', outboxId: item.outboxId, claimGeneration, reason: 'service_generation_probe' }))
    need(error.code === 'publish_conflict', `the code must be publish_conflict, got ${error.code}`)
    need(state(kernel, root) === before, `a rejected service generation ${JSON.stringify(claimGeneration)} writes nothing`)
    const row = rowOf(kernel, item.outboxId)
    need(row.status === 'running' && row.claim_generation === current, 'the row keeps its status and generation')
  }
  need(declaredEventsOf(kernel, item.outboxId).length === 0, 'no audit event for a rejected service generation')

  // 反面对照：别的冲突（未领取）不得借用 outbox_claim_mismatch 这个 detail，否则 MRU-13 可能恒真。
  const pending = pendingRun(kernel, { runId: 'run-unk-svcgen-pending', target: 'pd:unk-svcgen-pending' })
  const notClaimed = expectCode(
    () => declareViaService(svc, { principal: 'ui-gen', outboxId: pending.outboxId, claimGeneration: 1, reason: 'not_claimed_probe' }),
    'publish_conflict',
  )
  need(notClaimed.detail !== 'outbox_claim_mismatch', `a state conflict must not masquerade as a generation mismatch, got ${JSON.stringify(notClaimed.detail)}`)

  // 正控：当前代次经服务层可以声明。
  const accepted = declareViaService(svc, { principal: 'ui-gen', outboxId: item.outboxId, claimGeneration: current, reason: 'service_current_generation' })
  need(accepted && accepted.status === 'outcome_unknown', 'the current generation can be declared through the service')
  const audit = parsePayload(declaredEventsOf(kernel, item.outboxId).at(-1))
  need(audit && audit.claimGeneration === current && audit.actorId === 'ui-gen', 'the accepted declaration records the generation and the identity')
  return { rejectedGenerations: bad.length, code: 'publish_conflict', detail: 'outbox_claim_mismatch', stateConflictDetail: notClaimed.detail, acceptedGeneration: current }
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
