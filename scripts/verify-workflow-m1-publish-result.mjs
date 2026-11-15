// W1 发布结果显式化契约专项（happy-4.1 独立复核，2026-11-14）。
// 全程临时 SQLite + 临时根目录，不碰生产库、不发 HTTP、不调真实模型。
//
// 本批范围（老大 2026-11-14 指派）：只固化"发布结果必须显式提供"，不改源码。
// 租约（outbox 的 claimed_at / lease）与服务层 outbox 对账入口**不在本批**，
// 本文件不为它们提供任何证据，也不得据此宣称 running 恢复已解决。
//
// 契约（依据 08-storage-migration.md:75「发布任务按 pending/running/succeeded/conflict/failed/
// outcome_unknown/superseded/cancelled 分别记录」与 :77「崩溃后目标仍为基准才可继续，
// 已是预期结果则补记成功，出现第三种内容即冲突」）：
//   A. 服务层（host.publish）必须先校验发布结果，再领取：
//      缺失结果（不传 status / 显式 undefined）与非法结果（不在上面七种之外的四个终态）一律拒绝，
//      且拒绝发生在 claim 之前 —— outbox 仍 pending、适配器被问 0 次、无 claimed/settled 事件、
//      全库用户表与对象树逐字节不变。
//   B. 内核（completeOutbox）若在领取之后才拿到缺失或非法结果，既不许记为成功，
//      也不许把已领取项留在 running：必须转 outcome_unknown（效果未知），运行暂停在
//      publish_outcome_unknown，并留下可对账的记录。
//   C. 显式成功/失败/冲突/未知四个终态必须照常工作（正控），不能把整条发布路径打死。
//
// 「尚未发生效果」与「效果未知」的分界就是本轮的全部意义：
//   - 服务层在领取前拒绝 → 效果尚未发生，项仍是 pending，可以安全重试；
//   - 领取后才发现结果无效 → 效果未知，只能 outcome_unknown 后对账，不许当成功、不许当没发生。
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

// 四个终态是内核目前接受的集合（completeOutbox 的白名单）；缺失、以及集合外的值都不算结果。
const TERMINAL = ['succeeded', 'failed', 'conflict', 'outcome_unknown']

const check = (id, title, fn, kind = 'spec') => {
  const root = mkdtempSync(join(tmpdir(), `m1-pres-${id}-`))
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

// 零副作用指纹：动态发现全库用户表（新增表自动纳入，避免漏掉结算期间的新写入），
// 加上 objects/、manifests/、staging/ 下每个文件的路径、字节数与内容 sha256。
const tablesOf = (kernel) => kernel.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name)
const fingerprint = (kernel) => kernel.hash(JSON.stringify(tablesOf(kernel).map((table) => ({ table, rows: kernel.query(`SELECT * FROM ${table} ORDER BY rowid`) }))))
const objectTree = (root) => {
  const out = []
  const walk = (dir, prefix) => {
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

// 08:109 之后，发布必须携带采用时的完整内容证据：本文件统一用一份独立的目标原文
// （BASE_CONTENT，不经过内核 hash），adapter 默认回报"目标仍是这份基准"，
// 需要别的观测的用例显式覆盖 contentHash/revision。
const BASE_CONTENT = 'pres base'
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

// content 是"目标此刻的真实正文"：默认仍是基准，因此默认观测等于 absent；
// 需要"发布真的落地了"的用例显式把 content 传成该条发布的预期正文。
const adapter = (revision, { fail = null, content = BASE_CONTENT } = {}) => {
  const calls = []
  return {
    calls,
    observeTarget: (target) => {
      calls.push(target)
      if (fail) throw Object.assign(new Error(fail), { code: fail })
      return { target, revision, ...(content === null ? {} : { contentHash: sha256(content) }) }
    },
  }
}

// 服务层发布改由受信目标适配器读回证明效果（roadmap 11「发布读回」段）：
// 调用方不再传 status/observe，服务自己 read → write → read 读回判定。
// 这里给服务一份可变的假目标：正文与版本由夹具控制，写入真的改字节，读回真的算摘要。
const targetStore = ({ revision = 1, content = BASE_CONTENT } = {}) => {
  const world = { revision, content, writePlan: null }
  const calls = { read: 0, write: 0 }
  return {
    calls,
    world,
    adapter: {
      read: (target, relativePath = null) => {
        calls.read += 1
        if (relativePath !== null) throw new Error('target_observation_invalid')
        return { target, revision: world.revision, content: world.content }
      },
      write: (target, payload, options) => {
        calls.write += 1
        const plan = world.writePlan
        if (plan) {
          const decision = plan({ target, payload, options })
          if (decision?.throw) throw decision.throw
          if (decision?.status !== undefined) return decision
          if (decision?.content !== undefined) { world.content = decision.content; world.revision += 1; return { status: 'ok' } }
        }
        world.content = payload
        world.revision += 1
        return { status: 'ok' }
      },
      kindOf: () => 'raw_text',
    },
  }
}

// 单步自动 run：从独立目标夹具取得基准，采用目标，留下一条必需的 pending 发布。
const publishRun = (kernel, { runId = 'run-pres', target = 'pd:pres', baseRevision = 1, content = 'pres body', baseContent = BASE_CONTENT } = {}) => {
  kernel.createRun({ id: runId, steps: [{ nodeId: 'fake.transform', nodeKind: 'automatic', requiredChecks: [], publishTargets: [{ target, required: true }] }], input: { fixture: true } })
  const attempt = kernel.claim(runId)
  const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content })
  const adoption = kernel.adopt({
    attemptId: attempt.attemptId, token: attempt.token, candidate, target, baseRevision,
    baseContentHash: sha256(baseContent), targetKind: 'raw_text',
  })
  return { runId, target, baseRevision, baseContentHash: sha256(baseContent), outboxId: `${adoption.adoptionId}:publish`, adoptionId: adoption.adoptionId }
}

const outboxRow = (kernel, id) => kernel.one('SELECT status, reason FROM workflow_outbox WHERE id=?', id)
const runRow = (kernel, id) => kernel.one('SELECT status, pause_reason FROM workflow_runs WHERE id=?', id)
const eventsOf = (kernel, type) => kernel.query('SELECT * FROM workflow_events WHERE type=?', type)

// PRR-00 自检：本文件的"零观测"证据依赖适配器计数器真的会计数。
// 用一个显式成功的发布证明计数器在成功路径上读到 1 次——否则"被问 0 次"永远成立、毫无证据力。
check('PRR-00', 'the observation counter really counts, so "observed zero times" means something', ({ kernel, root }) => {
  const item = publishRun(kernel, { runId: 'run-pres-self', target: 'pd:pres-self' })
  const store = targetStore({ revision: item.baseRevision })
  const svc = createFakeBusinessService({ kernel, targetAdapter: store.adapter })
  svc.registerPrincipal({ id: 'sched-self', kind: 'scheduler' })
  const published = svc.host.publish({ principal: 'sched-self', outboxId: item.outboxId })
  need(store.calls.read >= 1, `a real publish must observe the target through the adapter, got ${store.calls.read} read(s)`)
  need(store.calls.write === 1, `a real publish writes the target exactly once, got ${store.calls.write}`)
  need(published.status === 'succeeded', `a write whose readback matches the adoption must report succeeded, got ${published.status}`)
  need(outboxRow(kernel, item.outboxId).status === 'succeeded', 'the row reflects the verified success')
  return { readCalls: store.calls.read, runStatus: published.runStatus }
}, 'selfcheck')

// PRR-01 服务层缺证据：没有受信目标适配器时必须在领取之前拒绝，项仍是 pending（效果尚未发生）。
// 03:114 之后调用方不再能自报发布结果，结果只能来自适配器读回；缺读回能力等于缺证据。
check('PRR-01', 'the service refuses a publish with no readback evidence before claiming, leaving the item pending', ({ kernel, root }) => {
  const item = publishRun(kernel, { runId: 'run-pres-missing', target: 'pd:pres-missing' })
  const runBefore = runRow(kernel, item.runId)
  const claimsBefore = eventsOf(kernel, 'outbox.claimed').length
  const settlesBefore = eventsOf(kernel, 'outbox.settled').length

  const shapes = [
    ['no target adapter at all', undefined],
    ['a reader without a writer', { read: () => ({ target: 'pd:pres-missing', revision: 1, content: BASE_CONTENT }) }],
    ['a writer without a reader', { write: () => ({ status: 'ok' }) }],
  ]
  // 身份注册属于夹具准备，必须落在"零副作用"观测之外，否则会把自己的写入算进来。
  const services = shapes.map(([label, targetAdapter]) => {
    const svc = createFakeBusinessService({ kernel, ...(targetAdapter ? { targetAdapter } : {}) })
    svc.registerPrincipal({ id: 'sched-missing', kind: 'scheduler' })
    return { label, svc }
  })
  const before = state(kernel, root)
  for (const { label, svc } of services) {
    let error = null
    try { svc.host.publish({ principal: 'sched-missing', outboxId: item.outboxId }) } catch (caught) { error = caught }
    need(error !== null, `${label} must be refused, it was accepted`)
    need(error.code === 'capability_unavailable', `${label} must surface as capability_unavailable, got ${error.code} (detail ${error.detail})`)
    need(error.detail === 'target_adapter_unavailable', `${label} must name the missing adapter, got ${error.detail}`)
    need(outboxRow(kernel, item.outboxId).status === 'pending', `${label}: the item must stay pending (no effect yet), got ${outboxRow(kernel, item.outboxId).status}`)
  }
  need(eventsOf(kernel, 'outbox.claimed').length === claimsBefore, 'no claim is recorded for a refused publish')
  need(eventsOf(kernel, 'outbox.settled').length === settlesBefore, 'no settlement is recorded for a refused publish')
  need(state(kernel, root) === before, 'a refused publish changes nothing in the database or the content tree')
  need(JSON.stringify(runRow(kernel, item.runId)) === JSON.stringify(runBefore), 'the run status is untouched by the refusal')

  // 调用方自报的结果不再有权威：即使传了 status:'succeeded'，也必须由读回证明，不能凭参数成功。
  const liar = targetStore({ revision: item.baseRevision })
  liar.world.writePlan = () => ({ content: 'a third party rewrote the target mid-publish' })
  const lying = createFakeBusinessService({ kernel, targetAdapter: liar.adapter })
  lying.registerPrincipal({ id: 'sched-missing', kind: 'scheduler' })
  const selfReported = lying.host.publish({ principal: 'sched-missing', outboxId: item.outboxId, status: 'succeeded' })
  need(selfReported.status !== 'succeeded', `a self-reported status must never settle the item as succeeded, got ${selfReported.status}`)
  need(outboxRow(kernel, item.outboxId).status === 'conflict', `a readback of a third content is a conflict, got ${outboxRow(kernel, item.outboxId).status}`)
  return { status: outboxRow(kernel, item.outboxId).status, readbackRefused: shapes.length }
})

// PRR-02 服务层非法结果：适配器自报的结果不在冻结集合内时，一律不得成功、不得留 running。
// 每一次都用**全新**的目标与条目：共用一个条目时只有第一种值真正走首次结算，其余只是撞 cas_conflict。
check('PRR-02', 'an illegal adapter result never settles a publish as a success and never strands it in running', ({ kernel, root }) => {
  const illegalValues = ['partial', 'done', 'cancelled', 'pending', 'running', 'succeeded ', 'SUCCEEDED', '', ' ', null, 7, 0, {}, [], true]
  const seen = []
  for (const [index, value] of illegalValues.entries()) {
    const item = publishRun(kernel, { runId: `run-pres-illegal-${index}`, target: `pd:pres-illegal-${index}`, content: `illegal body ${index}` })
    const store = targetStore({ revision: item.baseRevision })
    store.world.writePlan = () => ({ status: value })
    const svc = createFakeBusinessService({ kernel, targetAdapter: store.adapter })
    svc.registerPrincipal({ id: 'sched-illegal', kind: 'scheduler' })
    const published = svc.host.publish({ principal: 'sched-illegal', outboxId: item.outboxId })
    const label = `an adapter result of ${JSON.stringify(value) ?? String(value)}`
    const row = outboxRow(kernel, item.outboxId)
    need(published.status !== 'succeeded', `${label} must never be reported as succeeded`)
    need(row.status !== 'succeeded', `${label} must never be recorded as a success, got ${row.status}`)
    need(row.status !== 'running', `${label} must not leave the item stranded in running, got ${row.status}`)
    need(['conflict', 'failed', 'outcome_unknown'].includes(row.status), `${label} resolves to a non-success terminal state, got ${row.status}`)
    const run = runRow(kernel, item.runId)
    need(run.status === 'paused', `${label} pauses its own run, got ${run.status}`)
    need(typeof row.reason === 'string' && row.reason.length > 0, `${label} records why it is not a success`)
    seen.push(value === '' ? '(empty)' : String(value))
  }

  // 正控：同一个条目用真实写入仍然发得出去——拒绝的是坏结果，不是把这一格打死。
  const good = publishRun(kernel, { runId: 'run-pres-illegal-good', target: 'pd:pres-illegal-good', content: 'legal body' })
  const store = targetStore({ revision: good.baseRevision })
  const svc = createFakeBusinessService({ kernel, targetAdapter: store.adapter })
  svc.registerPrincipal({ id: 'sched-illegal', kind: 'scheduler' })
  const published = svc.host.publish({ principal: 'sched-illegal', outboxId: good.outboxId })
  need(published.status === 'succeeded', `a verified write still publishes, got ${published.status}`)
  return { refused: seen.length, values: seen.join('|') }
})

// PRR-03 内核：已领取后才拿到缺失结果 → 不得成功，也不得留在 running，必须 outcome_unknown。
check('PRR-03', 'a claimed publish with no result becomes outcome_unknown, never a success and never a stranded running item', ({ kernel, root }) => {
  const item = publishRun(kernel, { runId: 'run-pres-kernel-missing', target: 'pd:pres-kernel-missing' })
  const itemClaim = kernel.claimOutbox(item.outboxId, { observe: adapter(item.baseRevision).observeTarget })
  need(outboxRow(kernel, item.outboxId).status === 'running', 'precondition: the item is claimed and running')

  const settlesBefore = eventsOf(kernel, 'outbox.settled').length
  let raised = null
  try { kernel.completeOutbox(item.outboxId, undefined, null, itemClaim.claimGeneration) } catch (error) { raised = { code: error.code ?? null, message: String(error.message ?? '') } }

  const row = outboxRow(kernel, item.outboxId)
  need(row.status !== 'succeeded', `a missing result must never be recorded as a success, got ${row.status}`)
  need(row.status !== 'running', `a missing result must not leave the item stranded in running (that is the effect-unknown case), got ${row.status}`)
  need(row.status === 'outcome_unknown', `a missing result means the effect is unknown, got ${row.status}`)
  need(typeof row.reason === 'string' && row.reason.length > 0, 'the unknown outcome must carry a reason, not a bare state')

  const run = runRow(kernel, item.runId)
  need(run.status === 'paused', `the run must pause on an unknown publish result, got ${run.status}`)
  need(run.pause_reason === 'publish_outcome_unknown', `the pause reason must be publish_outcome_unknown, got ${run.pause_reason}`)
  need(eventsOf(kernel, 'outbox.settled').length === settlesBefore + 1, 'the unknown outcome is recorded as one settlement event')
  const settled = eventsOf(kernel, 'outbox.settled').at(-1)
  const payload = JSON.parse(settled.payload)
  need(payload.status === 'outcome_unknown', `the settlement event records outcome_unknown, got ${payload.status}`)

  // 不滞留：未知必须能接着对账（08:77 的三态），而不是卡死在 running。
  // 对账必须给真实观测：这里让目标持有这条发布的预期正文，才允许补记成功。
  const reconciled = kernel.reconcilePublishEffect(item.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: itemClaim.claimGeneration,
    observe: adapter(item.baseRevision + 1, { content: 'pres body' }).observeTarget,
  })
  need(reconciled.decision === 'applied', `an observed expected content reconciles as applied, got ${reconciled.decision}`)
  need(outboxRow(kernel, item.outboxId).status === 'succeeded', `reconciling an applied effect records the success, got ${outboxRow(kernel, item.outboxId).status}`)
  return { afterMissing: row.status, raised, runStatus: run.status, reconciled: reconciled.decision }
})

// PRR-04 内核：已领取后才拿到非法结果 → 与缺失同路：outcome_unknown，不许成功、不许留 running。
// 每个非法值都从**全新**的 running 项开始。共用一个条目时只有第一种值真正走首次结算，
// 其余只是撞上 outcome_unknown 的 cas_conflict，等于没测——这里刻意不省这次开销。
check('PRR-04', 'a claimed publish with any illegal result becomes outcome_unknown, each value from a fresh running item', ({ kernel, root }) => {
  const illegal = ['partial', 'done', 'cancelled', 'pending', 'running', 'superseded', '', ' ', 'succeeded ', 'SUCCEEDED', null, 7, 0, {}, [], true, false]
  const observed = []
  for (const [index, value] of illegal.entries()) {
    const item = publishRun(kernel, {
      runId: `run-pres-illegal-${index}`,
      target: `pd:pres-illegal-${index}`,
      content: `illegal body ${index}`,
    })
    const itemClaim = kernel.claimOutbox(item.outboxId, { observe: adapter(item.baseRevision).observeTarget })
    need(outboxRow(kernel, item.outboxId).status === 'running', `precondition ${index}: the item is claimed and running`)

    const label = `status ${JSON.stringify(value)}`
    let raised = null
    try { kernel.completeOutbox(item.outboxId, value, null, itemClaim.claimGeneration) } catch (error) { raised = error.code ?? String(error.message ?? '') }

    const row = outboxRow(kernel, item.outboxId)
    need(row.status !== 'succeeded', `${label} must never be recorded as a success, got ${row.status}`)
    need(row.status !== 'running', `${label} must not leave the item stranded in running (from a fresh claim, raised ${raised}), got ${row.status}`)
    need(row.status === 'outcome_unknown', `${label} means the effect is unknown, got ${row.status} (raised ${raised})`)
    need(row.reason === 'publish_result_invalid', `${label} must record why it is unknown, got ${row.reason}`)
    need(eventsOf(kernel, 'outbox.claimed').length === index + 1, `${label} must not re-claim the item`)
    const settled = eventsOf(kernel, 'outbox.settled').at(-1)
    need(settled && JSON.parse(settled.payload).status === 'outcome_unknown', `${label} settles as outcome_unknown`)
    need(JSON.parse(settled.payload).outboxId === item.outboxId, `${label} records the settlement against this very item`)

    const run = runRow(kernel, item.runId)
    need(run.status === 'paused', `${label} must pause its own run, got ${run.status}`)
    need(run.pause_reason === 'publish_outcome_unknown', `${label} must pause with publish_outcome_unknown, got ${run.pause_reason}`)

    // 不滞留：未知必须能接着对账成未发布，回到「尚未发生效果」的候选状态。
    // 目标此刻仍是基准正文 → absent，这是唯一允许回到 pending 的观测定论。
    const reconciled = kernel.reconcilePublishEffect(item.outboxId, {
      actorId: 'fixture-reconciler',
      claimGeneration: itemClaim.claimGeneration,
      observe: adapter(item.baseRevision).observeTarget,
    })
    need(reconciled.decision === 'absent', `${label} must reconcile as absent, got ${reconciled.decision}`)
    need(outboxRow(kernel, item.outboxId).status === 'pending', `${label} reconciled-not-published returns to pending, got ${outboxRow(kernel, item.outboxId).status}`)
    observed.push(value === '' ? '(empty)' : String(value))
  }

  // 缺失与非法必须留下不同原因，否则对账时无法区分"没给结果"和"给了个假结果"。
  const missingItem = publishRun(kernel, { runId: 'run-pres-reason-missing', target: 'pd:pres-reason-missing' })
  const missingClaim = kernel.claimOutbox(missingItem.outboxId, { observe: adapter(missingItem.baseRevision).observeTarget })
  kernel.completeOutbox(missingItem.outboxId, undefined, null, missingClaim.claimGeneration)
  need(outboxRow(kernel, missingItem.outboxId).reason === 'publish_result_missing', `a missing result records publish_result_missing, got ${outboxRow(kernel, missingItem.outboxId).reason}`)
  return { tried: illegal.length, reasons: ['publish_result_missing', 'publish_result_invalid'], first: observed[0] }
})

// PRR-06 授权优先：读回证据不得先于身份/授权判定泄漏出去。
// 无权身份即使目标可读可写，也必须是权限码——否则读回路径会变成"这个 outbox 存在"的预言机。
check('PRR-06', 'authorization is decided before any target readback', ({ kernel, root }) => {
  const item = publishRun(kernel, { runId: 'run-pres-auth', target: 'pd:pres-auth' })
  const store = targetStore({ revision: item.baseRevision })
  const svc = createFakeBusinessService({ kernel, targetAdapter: store.adapter })
  svc.registerPrincipal({ id: 'ui-nopublish', kind: 'ui' })
  svc.registerPrincipal({ id: 'agent-scoped', kind: 'node-agent' })
  svc.registerPrincipal({ id: 'sched-auth', kind: 'scheduler' })
  const before = state(kernel, root)

  const denied = [
    { label: 'a UI principal (publish.official is deny)', principal: 'ui-nopublish' },
    { label: 'an unregistered principal', principal: 'ghost-no-such-principal' },
    { label: 'a scoped agent not granted this run', principal: 'agent-scoped' },
  ]
  let refused = 0
  for (const { label, principal } of denied) {
    let error = null
    try { svc.host.publish({ principal, outboxId: item.outboxId }) } catch (caught) { error = caught }
    need(error !== null, `${label} must be refused`)
    need(error.code === 'capability_unavailable', `${label} must fail on permission, got ${error.code} (detail ${error.detail})`)
    need(!String(error.detail).startsWith('outbox_status'), `${label} must not report the publish result as the problem, got detail ${error.detail}`)
    refused += 1
  }
  need(store.calls.read === 0 && store.calls.write === 0, `no refused principal may read or write the target, got ${store.calls.read} read(s) / ${store.calls.write} write(s)`)
  need(outboxRow(kernel, item.outboxId).status === 'pending', 'no refused principal may claim or settle the item')
  need(state(kernel, root) === before, 'unauthorized attempts change nothing')

  // 正控：有权限的同一身份 → 现在真的会读回并结算，证明上面的权限码不是恒真。
  const published = svc.host.publish({ principal: 'sched-auth', outboxId: item.outboxId })
  need(store.calls.write === 1, 'the authorized principal actually publishes')
  need(published.status === 'succeeded', `the authorized publish succeeds by readback, got ${published.status}`)
  return { refused, positiveControl: 'succeeded' }
})

// PRR-07 未领取与已终结项不得被无效结果改写。
check('PRR-07', 'an unclaimed item and already-settled items are never rewritten by an invalid result', ({ kernel, root }) => {
  // 1) 未领取：仍是"尚未发生效果"。必须拒绝，且不得被悄悄改成 outcome_unknown。
  const unclaimed = publishRun(kernel, { runId: 'run-pres-unclaimed', target: 'pd:pres-unclaimed' })
  const before = state(kernel, root)
  for (const status of [undefined, 'partial', 'done', '']) {
    let raised = null
    try { kernel.completeOutbox(unclaimed.outboxId, status) } catch (error) { raised = error.code }
    need(raised === 'outbox_not_claimed', `an unclaimed item must be refused with outbox_not_claimed for ${JSON.stringify(status)}, got ${raised}`)
  }
  need(outboxRow(kernel, unclaimed.outboxId).status === 'pending', `an unclaimed item stays pending, got ${outboxRow(kernel, unclaimed.outboxId).status}`)
  need(state(kernel, root) === before, 'refusing an unclaimed item changes nothing')

  // 2) 已终结：四个终态各造一条，再用无效结果去撞，一律不改写。
  const settledCases = ['succeeded', 'failed', 'conflict', 'outcome_unknown']
  const seen = {}
  for (const [index, terminal] of settledCases.entries()) {
    const item = publishRun(kernel, { runId: `run-pres-settled-${index}`, target: `pd:pres-settled-${index}`, content: `settled body ${index}` })
    const itemClaim = kernel.claimOutbox(item.outboxId, { observe: adapter(item.baseRevision).observeTarget })
    kernel.completeOutbox(item.outboxId, terminal, 'settled_on_purpose', itemClaim.claimGeneration)
    const snapshot = { outbox: outboxRow(kernel, item.outboxId), run: runRow(kernel, item.runId) }
    need(snapshot.outbox.status === terminal, `precondition ${index}: settled as ${terminal}`)
    const settlesBefore = eventsOf(kernel, 'outbox.settled').length

    for (const invalid of [undefined, 'partial', null, 'done']) {
      let raised = null
      try { kernel.completeOutbox(item.outboxId, invalid, null, itemClaim.claimGeneration) } catch (error) { raised = error.code }
      need(raised === 'cas_conflict', `a settled ${terminal} item must refuse ${JSON.stringify(invalid)} with cas_conflict, got ${raised}`)
      need(JSON.stringify(outboxRow(kernel, item.outboxId)) === JSON.stringify(snapshot.outbox), `a settled ${terminal} item must not be rewritten by ${JSON.stringify(invalid)}`)
      need(JSON.stringify(runRow(kernel, item.runId)) === JSON.stringify(snapshot.run), `the run of a settled ${terminal} item must not move`)
    }
    need(eventsOf(kernel, 'outbox.settled').length === settlesBefore, `a settled ${terminal} item must not gain settlements`)
    seen[terminal] = snapshot.outbox.status
  }

  // 3) 被同目标新采用替换的旧项：对账回 pending 后仍未被领取，无效结果不得把它改成 unknown。
  const oldItem = publishRun(kernel, { runId: 'run-pres-sup-old', target: 'pd:pres-sup', content: 'old body' })
  const supClaim = kernel.claimOutbox(oldItem.outboxId, { observe: adapter(oldItem.baseRevision).observeTarget })
  const newItem = publishRun(kernel, { runId: 'run-pres-sup-new', target: 'pd:pres-sup', baseRevision: 2, content: 'new body' })
  const oldRow = outboxRow(kernel, oldItem.outboxId)
  need(oldRow.status === 'outcome_unknown', `precondition: the superseded claim is outcome_unknown, got ${oldRow.status}`)
  // 08:110 之后：被更晚采用接管的旧项，absent 对账也落 superseded，不再回 pending。
  kernel.reconcilePublishEffect(oldItem.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: supClaim.claimGeneration,
    observe: adapter(oldItem.baseRevision).observeTarget,
  })
  need(outboxRow(kernel, oldItem.outboxId).status === 'superseded', `precondition: reconciled old item is superseded, got ${outboxRow(kernel, oldItem.outboxId).status}`)
  let raised = null
  try { kernel.completeOutbox(oldItem.outboxId, 'partial') } catch (error) { raised = error.code }
  need(raised === 'cas_conflict', `a superseded old item refuses settlement with cas_conflict, got ${raised}`)
  need(outboxRow(kernel, oldItem.outboxId).status === 'superseded', 'the old item stays superseded, not silently unknown')
  need(outboxRow(kernel, newItem.outboxId).status === 'pending', 'the new item is untouched by the old item attempts')
  return { settled: seen, oldAfter: outboxRow(kernel, oldItem.outboxId).status }
})

// PRR-05 正控：四种终态必须照常工作（证明上面的红测不是把整条发布路径锁死）。
// 终态由读回决定：写入落地且读回等于采纳内容 = succeeded；写入自报失败且目标仍是基准 = failed；
// 读回是第三种内容 = conflict；写入或读回抛错 = outcome_unknown。
check('PRR-05', 'the four terminal outcomes keep working end to end', ({ kernel, root }) => {
  const expectation = {
    succeeded: { outbox: 'succeeded', run: 'completed', pause: null },
    failed: { outbox: 'failed', run: 'paused', pause: 'publish_failed' },
    conflict: { outbox: 'conflict', run: 'paused', pause: 'publish_conflict' },
    outcome_unknown: { outbox: 'outcome_unknown', run: 'paused', pause: 'publish_outcome_unknown' },
  }
  const behaviour = {
    succeeded: () => null,
    failed: () => ({ status: 'failed' }),
    conflict: () => ({ content: 'a third party rewrote the target' }),
    outcome_unknown: () => ({ throw: new Error('adapter crashed mid-write') }),
  }
  const seen = {}
  let unknownClaim
  for (const [status, want] of Object.entries(expectation)) {
    const item = publishRun(kernel, { runId: `run-pres-ok-${status}`, target: `pd:pres-ok-${status}` })
    const store = targetStore({ revision: item.baseRevision })
    store.world.writePlan = behaviour[status]
    const svc = createFakeBusinessService({ kernel, targetAdapter: store.adapter })
    svc.registerPrincipal({ id: 'sched-positive', kind: 'scheduler' })
    let published = null
    let raised = null
    try { published = svc.host.publish({ principal: 'sched-positive', outboxId: item.outboxId }) } catch (caught) { raised = caught }
    need(store.calls.write === 1, `a ${status} publish writes the target exactly once, got ${store.calls.write}`)
    const row = outboxRow(kernel, item.outboxId)
    need(row.status === want.outbox, `a ${status} readback settles the row as ${want.outbox}, got ${row.status}`)
    const run = runRow(kernel, item.runId)
    need(run.status === want.run, `a ${status} readback leaves the run ${want.run}, got ${run.status}`)
    if (want.pause !== null) need(run.pause_reason === want.pause, `a ${status} readback pauses with ${want.pause}, got ${run.pause_reason}`)
    if (status === 'outcome_unknown') {
      need(raised !== null && raised.code === 'outcome_unknown', `an ambiguous effect surfaces as outcome_unknown, got ${raised?.code ?? 'no error'}`)
      const settled = eventsOf(kernel, 'outbox.settled').filter((event) => JSON.parse(event.payload).outboxId === item.outboxId).at(-1)
      unknownClaim = { id: item.outboxId, generation: JSON.parse(settled.payload).claimGeneration ?? kernel.one('SELECT claim_generation FROM workflow_outbox WHERE id=?', item.outboxId).claim_generation }
    } else {
      need(raised === null, `a ${status} publish must not throw, got ${raised?.code}`)
      need(Number.isSafeInteger(published.claimGeneration) && published.claimGeneration >= 1, `a ${status} publish reports its claim identity`)
    }
    seen[status] = { outbox: row.status, run: run.status }
  }
  // outcome_unknown 必须能被对账收尾；其它三个不可再对账（已是终态）。
  // 对账显式使用本次领取身份，不从当前行补齐。
  const reconciled = kernel.reconcilePublishEffect(unknownClaim.id, {
    actorId: 'fixture-reconciler',
    claimGeneration: unknownClaim.generation,
    observe: adapter(2, { content: 'pres body' }).observeTarget,
  })
  need(reconciled.decision === 'applied', `the unknown outcome is reconcilable when the write is observed, got ${reconciled.decision}`)
  let refused = null
  const succeededItem = kernel.query("SELECT id FROM workflow_outbox WHERE status='succeeded'")[0]
  try { kernel.reconcilePublishEffect(succeededItem.id, { actorId: 'fixture-reconciler', claimGeneration: unknownClaim.generation }) } catch (error) { refused = error.code }
  need(refused === 'outbox_not_reconcilable', `a settled success is not reconcilable again, got ${refused}`)
  return seen
})

// PRR-08 代次透传：服务必须把**本次领取**的代次交回调用方，不能写死、不能算错。
// 前面各项都是首次领取（代次必然是 1），只断言"是 ≥1 的整数"分不出透传与硬编码；
// 这里让同一条目走完 failed → retryOutbox → succeeded，代次必须是 1 然后是 2。
check('PRR-08', 'the service returns the generation of this very claim, not a constant', ({ kernel, root }) => {
  const item = publishRun(kernel, { runId: 'run-pres-regen', target: 'pd:pres-regen' })
  const store = targetStore({ revision: item.baseRevision })
  const svc = createFakeBusinessService({ kernel, targetAdapter: store.adapter })
  svc.registerPrincipal({ id: 'sched-regen', kind: 'scheduler' })
  const claimedOf = () => kernel.query("SELECT payload FROM workflow_events WHERE type='outbox.claimed' AND payload LIKE ? ORDER BY seq", `%${item.outboxId}%`)
    .map((row) => JSON.parse(row.payload))

  // 第一代：适配器自报失败且目标仍是基准（真实终态，不是异常路径），条目回到可重试。
  store.world.writePlan = () => ({ status: 'failed' })
  const first = svc.host.publish({ principal: 'sched-regen', outboxId: item.outboxId })
  need(first.status === 'failed', `the first publish settles failed, got ${first.status}`)
  need(first.claimGeneration === 1, `the first publish must return generation 1, got ${JSON.stringify(first.claimGeneration)}`)
  need(outboxRow(kernel, item.outboxId).status === 'failed', 'the first publish leaves the row failed')

  // 重试把条目放回 pending；再发布就是第二代，这次写入真的落地。
  need(kernel.retryOutbox(item.outboxId) === 'pending', 'retryOutbox returns the failed publish to pending')
  need(outboxRow(kernel, item.outboxId).status === 'pending', 'the retried item is pending before the second publish')
  store.world.writePlan = null
  const second = svc.host.publish({ principal: 'sched-regen', outboxId: item.outboxId })
  need(second.status === 'succeeded', `the second publish settles succeeded, got ${second.status}`)
  need(second.claimGeneration === 2, `the second publish must return generation 2 (a constant or a wrong value fails here), got ${JSON.stringify(second.claimGeneration)}`)

  // 事件流里的代次序列必须是 [1,2]：两次领取都是真实发生、且单调递增。
  const claims = claimedOf()
  need(claims.length === 2, `exactly two claims are recorded for this item, got ${claims.length}`)
  need(JSON.stringify(claims.map((payload) => payload.claimGeneration)) === '[1,2]', `the claim events carry generations [1,2], got ${JSON.stringify(claims.map((payload) => payload.claimGeneration))}`)
  need(claims.every((payload) => payload.outboxId === item.outboxId), 'both claim events belong to this very item')

  const row = kernel.one('SELECT claim_generation, status FROM workflow_outbox WHERE id=?', item.outboxId)
  need(row.claim_generation === 2 && row.status === 'succeeded', `the row ends at generation 2 / succeeded, got ${JSON.stringify(row)}`)
  return { first: first.claimGeneration, second: second.claimGeneration, claimed: claims.map((payload) => payload.claimGeneration), final: row.status }
})

const spec = results.filter((result) => result.kind === 'spec')
const specFailed = spec.filter((result) => result.status !== 'pass')
const selfcheck = results.filter((result) => result.kind === 'selfcheck')
const selfcheckFailed = selfcheck.filter((result) => result.status !== 'pass')
process.stdout.write(`${JSON.stringify({
  checks: results.length,
  passed: results.length - specFailed.length - selfcheckFailed.length,
  assertions,
  specChecks: spec.length,
  specFailed: specFailed.length,
  selfcheckChecks: selfcheck.length,
  selfcheckFailed: selfcheckFailed.length,
  results,
}, null, 2)}\n`)
// 自检项若红，说明"零观测/零写入"的证据本身失效，必须与非红测一样失败。
process.exitCode = specFailed.length === 0 && selfcheckFailed.length === 0 ? 0 : 1
