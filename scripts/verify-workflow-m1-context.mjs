// B2 / K1-01–K1-03 上下文组装专项验证（happy-4.1）。
// 全程临时目录 + 临时 SQLite；不读生产资料、不调模型、不注册宿主工具、不碰旧工作台入口。
// 每项检查独立临时根；失败报具体期望；exit 1 表示上下文契约仍有缺口。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
import {
  ASSEMBLY_VERSION, SLOT_ORDER, assembleContext, assertUpstreamFresh, captureContext, estimateTokens,
  hashBytes, payloadTokens, readCaptured, renderEntry, sortEntries,
} from '../src/workflow/m1-context.mjs'

const results = []
let assertions = 0

const need = (condition, message) => {
  assertions += 1
  if (!condition) throw new Error(message)
}

const expectError = (fn, code, detailIncludes = null) => {
  try {
    fn()
  } catch (error) {
    need(error.code === code, `expected ${code} but got ${error.code ?? error.message} (${error.detail ?? ''})`)
    if (detailIncludes) need(String(error.detail ?? '').includes(detailIncludes), `expected detail to include ${detailIncludes} but got ${error.detail}`)
    return error
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

const check = (id, title, fn) => {
  const root = mkdtempSync(join(tmpdir(), `m1-ctx-${id}-`))
  try {
    const detail = fn({ root })
    results.push({ id, title, status: 'pass', detail })
  } catch (error) {
    results.push({ id, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const write = (root, name, text) => {
  const path = join(root, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

// 每次捕获前的新鲜 spec；capture 会写入 <root>/context 的不可变 blob。
// 授权目录必须带产品归属：未绑定的父目录不足以授权产品资料（见 CTX-08B）。
const spec = ({ root, productId = 'p1', entries, allowPrivate = false, allowedRoots = [{ path: root, productId, allowPrivate: true }] }) =>
  captureContext({ root, projectId: 'proj-1', productId, allowedRoots, allowPrivate, entries })

const fact = (root, name, text, extra = {}) => ({
  sourceId: name, slot: 'fact', scope: 'product', productId: 'p1',
  path: write(root, name, text), required: true, ...extra,
})

const assemble = ({ spec: s, runId = 'run-a', attemptId = 'att-1', budget = { totalTokens: 8000 }, upstream = [], policyVersion = 'policy/1' }) =>
  assembleContext({ spec: s, runId, attemptId, budget, upstream, policyVersion })

// ---------------------------------------------------------------- CTX-01
check('CTX-01', 'same input / config / assembly version => same payload and fingerprint', ({ root }) => {
  const build = () => spec({ root, entries: [fact(root, 'a.md', '# A\n\nalpha body\n'), fact(root, 'b.md', '# B\n\nbeta body\n', { slot: 'reference', required: false })] })
  const one = assemble({ spec: build(), runId: 'run-1', attemptId: 'att-1' })
  const two = assemble({ spec: build(), runId: 'run-2', attemptId: 'att-2' })
  need(one.fingerprint === two.fingerprint, `fingerprint must be stable, ${one.fingerprint} !== ${two.fingerprint}`)
  need(one.payload === two.payload, 'payload must be byte-identical for the same inputs')
  need(one.receipt.payloadHash === two.receipt.payloadHash, 'payloadHash must match')
  // 执行关联另存：manifestHash 覆盖 runId / attemptId，允许不同。
  need(one.manifest.manifestHash !== two.manifest.manifestHash, 'manifestHash covers execution ids, so it may differ')
  need(one.manifest.runId === 'run-1' && two.manifest.runId === 'run-2', 'manifest must record its own run')
  // 传入顺序不影响结果：稳定排序后才拼装。
  const shuffled = spec({ root, entries: [fact(root, 'b.md', '# B\n\nbeta body\n', { slot: 'reference', required: false }), fact(root, 'a.md', '# A\n\nalpha body\n')] })
  const three = assemble({ spec: shuffled, runId: 'run-3', attemptId: 'att-3' })
  need(three.fingerprint === one.fingerprint, 'entry input order must not change the fingerprint')
  need(three.payload === one.payload, 'entry input order must not change the payload')
  need(one.manifest.entries.map(e => e.sourceId).join(',') === 'a.md,b.md', `slot order wrong: ${one.manifest.entries.map(e => e.sourceId)}`)
  need(one.manifest.assemblyVersion === ASSEMBLY_VERSION, 'assembly version recorded')
  return { fingerprint: one.fingerprint.slice(0, 12), entries: one.manifest.entries.length }
})

// ---------------------------------------------------------------- CTX-02
check('CTX-02', 'missing required / out-of-scope path / required over budget block before dispatch', ({ root }) => {
  // 缺必需资料：捕获阶段只记录，拼装阶段阻止，并指名来源。
  const missingSpec = captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: [{ path: root, productId: 'p1' }],
    entries: [fact(root, 'present.md', '# P\n\nok\n'), {
      sourceId: 'vanished.md', slot: 'fact', scope: 'product', productId: 'p1',
      path: join(root, 'never-written.md'), required: true,
    }],
  })
  need(missingSpec.missing.length === 1 && missingSpec.missing[0].sourceId === 'vanished.md', 'missing source recorded')
  expectError(() => assemble({ spec: missingSpec }), 'context_missing_required', 'vanished.md')

  // 可选资料缺失不阻止执行，但必须留在 missing 里可见。
  const optionalMissing = captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: [{ path: root, productId: 'p1' }],
    entries: [{ sourceId: 'opt.md', slot: 'reference', scope: 'product', productId: 'p1', path: join(root, 'nope.md'), required: false }],
  })
  const okRun = assemble({ spec: optionalMissing })
  need(optionalMissing.missing.length === 1, 'optional missing is still reported')
  need(okRun.manifest.entries.length === 0, 'optional missing entry is not delivered')

  // 越界路径：白名单之外必须拒绝，且发生在读取之前。
  const outside = mkdtempSync(join(tmpdir(), 'm1-ctx-outside-'))
  try {
    const outsideFile = write(outside, 'secret.txt', 'not yours\n')
    expectError(() => captureContext({
      root, projectId: 'proj-1', productId: 'p1', allowedRoots: [{ path: root, productId: 'p1' }],
      entries: [{ sourceId: 'escape.txt', slot: 'fact', scope: 'product', productId: 'p1', path: outsideFile, required: true }],
    }), 'context_path_out_of_scope', 'escape.txt')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }

  // 点段穿越同样被 realpath 挡住（目标文件存在，只因为落在白名单目录之外被拒）。
  writeFileSync(join(root, 'a.md'), 'alpha\n')
  mkdirSync(join(root, 'sub'), { recursive: true })
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: [{ path: join(root, 'sub'), productId: 'p1' }],
    entries: [{ sourceId: 'dot.md', slot: 'fact', scope: 'product', productId: 'p1', path: join(root, 'sub', '..', 'a.md'), required: true }],
  }), 'context_path_out_of_scope', 'dot.md')

  // 必需内容超预算：停止派发，报来源与所需/可用，不静默截断。
  const big = spec({ root, entries: [fact(root, 'big.md', '# Big\n\n' + 'x'.repeat(4000))] })
  const error = expectError(() => assemble({ spec: big, budget: { totalTokens: 10 } }), 'context_budget_exceeded', 'big.md')
  need(String(error.detail).startsWith('required:'), 'budget error must say required > total')
  need(!error.detail.includes('truncated'), 'must not emulate truncation')
  return { missingBlocked: true, outOfScopeBlocked: true }
})

// ---------------------------------------------------------------- CTX-02B
check('CTX-02B', 'budget is charged for the delivered payload, not for the bare fragments', ({ root }) => {
  const captured = spec({ root, entries: [fact(root, 'a.md', 'A')] })
  const fragment = captured.entries[0].estimatedTokens
  need(fragment === 1, `1-byte fragment estimates 1 token, got ${fragment}`)
  // 退回反例：内容只有 1 字节、预算 1 token，旧实现报 used=1 却交付 16 字节正文。
  const error = expectError(() => assemble({ spec: captured, budget: { totalTokens: 1 } }), 'context_budget_exceeded', 'a.md')
  need(error.detail === 'required:4>1:a.md', `error must report payload tokens (16 bytes => 4), got ${error.detail}`)
  const ok = assemble({ spec: captured, budget: { totalTokens: 4 } })
  need(ok.payload === '## [fact] a.md\nA', `payload must be the rendered block, got ${JSON.stringify(ok.payload)}`)
  need(ok.manifest.budget.usedTokens === 4, `used tokens must charge the payload, got ${ok.manifest.budget.usedTokens}`)
  need(ok.receipt.deliveredBytes === 16, `delivered bytes must count the rendered block, got ${ok.receipt.deliveredBytes}`)
  need(ok.receipt.entryDelivery[0].deliveredBytes === 16, 'per-entry delivery counts the rendered block')
  need(ok.manifest.budget.basis === 'delivered-payload', 'budget must record which basis it charges')
  // 可选资料同口径：1 字节的可选条目在“只剩片段预算”时也必须整条省略，而不是塞进正文。
  const withOptional = spec({ root, entries: [
    fact(root, 'a.md', 'A'),
    fact(root, 'b.md', 'B', { slot: 'reference', required: false }),
  ] })
  const squeezed = assemble({ spec: withOptional, budget: { totalTokens: 4 } })
  need(squeezed.receipt.omittedEntries.length === 1 && squeezed.receipt.omittedEntries[0].sourceId === 'b.md',
    `optional must be omitted when only the payload-exact budget is available, got ${JSON.stringify(squeezed.receipt.omittedEntries)}`)
  need(!squeezed.payload.includes('## [reference] b.md'), 'omitted optional must not leak into payload')
  need(squeezed.receipt.omittedEntries[0].renderedBytes === '## [reference] b.md\nB'.length,
    `omission receipt must keep the rendered bytes, got ${squeezed.receipt.omittedEntries[0].renderedBytes}`)
  return { requiredPayloadTokens: 4, fragmentTokens: fragment }
})

// ---------------------------------------------------------------- CTX-03
check('CTX-03', 'optional references over budget are omitted by fixed policy with reasons', ({ root }) => {
  const entries = [
    fact(root, 'required.md', '# R\n\n' + 'r'.repeat(200)),
    fact(root, 'low.md', '# L\n\n' + 'l'.repeat(400), { slot: 'reference', required: false, priority: 10 }),
    fact(root, 'mid.md', '# M\n\n' + 'm'.repeat(400), { slot: 'reference', required: false, priority: 20 }),
    fact(root, 'high.md', '# H\n\n' + 'h'.repeat(400), { slot: 'reference', required: false, priority: 30 }),
  ]
  const captured = spec({ root, entries })
  // 预算按实际交付载荷算：标题行、换行与段间分隔符都计入（退回反例的判据）。
  const requiredRender = renderEntry({ slot: 'fact', sourceId: 'required.md', capturedText: '# R\n\n' + 'r'.repeat(200) })
  const highRender = renderEntry({ slot: 'reference', sourceId: 'high.md', capturedText: '# H\n\n' + 'h'.repeat(400) })
  const budget = { totalTokens: payloadTokens(`${requiredRender}\n\n${highRender}`) }
  need(payloadTokens(requiredRender) > captured.entries.find(e => e.sourceId === 'required.md').estimatedTokens,
    'required payload must cost more than the bare fragment estimate (标题与换行也要计入)')
  const run = assemble({ spec: captured, budget })
  need(run.manifest.entries.some(e => e.sourceId === 'required.md'), 'required entry must survive any omission')
  need(run.receipt.omittedEntries.length === 2, `expected exactly two omissions, got ${run.receipt.omittedEntries.length}`)
  need(run.receipt.omittedEntries.every(o => o.reason === 'budget_exceeded'), 'every omission needs a reason')
  need(run.receipt.omittedEntries.every(o => typeof o.estimatedTokens === 'number' && o.estimatedTokens > 0), 'omission receipt keeps sizes')
  need(!run.receipt.omittedEntries.some(o => o.required === true), 'required entries are never omitted')
  need(run.manifest.budget.usedTokens <= budget.totalTokens, 'used tokens must respect the budget')
  need(run.manifest.budget.usedTokens === budget.totalTokens, `budget must be charged by the delivered payload, used=${run.manifest.budget.usedTokens}`)
  // 固定策略：同样的输入得到同样的省略集合，且优先舍低 priority、保留高 priority。
  const again = assemble({ spec: spec({ root, entries }), budget })
  need(again.receipt.omittedEntries.map(o => o.sourceId).join(',') === run.receipt.omittedEntries.map(o => o.sourceId).join(','), 'omission set must be deterministic')
  const droppedIds = run.receipt.omittedEntries.map(o => o.sourceId)
  need(droppedIds.includes('low.md') && droppedIds.includes('mid.md'), `lowest priority drops first, dropped=${droppedIds.join('|')}`)
  need(!droppedIds.includes('high.md'), `highest priority optional survives, dropped=${droppedIds.join('|')}`)
  need(!run.payload.includes('l'.repeat(400)) && !run.payload.includes('m'.repeat(400)), 'omitted content must not appear in payload')
  need(run.payload.includes('h'.repeat(400)), 'the kept optional entry is delivered in full')
  need(run.payload.includes('r'.repeat(200)), 'required content stays complete')
  return { dropped: droppedIds, used: run.manifest.budget.usedTokens }
})

// ---------------------------------------------------------------- CTX-04
check('CTX-04', 'frozen capture survives source edit / delete and does not silently re-version', ({ root }) => {
  const keep = write(root, 'keep.md', '# Keep\n\noriginal\n')
  const gone = write(root, 'gone.md', '# Gone\n\nwill be deleted\n')
  const captured = spec({
    root,
    entries: [
      { sourceId: 'keep.md', slot: 'fact', scope: 'product', productId: 'p1', path: keep, required: true },
      { sourceId: 'gone.md', slot: 'fact', scope: 'product', productId: 'p1', path: gone, required: true },
    ],
  })
  const before = assemble({ spec: captured })
  const keepHash = captured.entries[0].sourceHash
  const goneHash = captured.entries[1].sourceHash
  const bySource = (run, sourceId) => run.manifest.entries.find(entry => entry.sourceId === sourceId)

  writeFileSync(keep, '# Keep\n\nREWRITTEN\n')
  unlinkSync(gone)

  // 已捕获内容按 blob 读，源改动/删除都不影响，hash 仍一致。
  const reread = readCaptured({ root, blobRef: captured.entries[0].capturedBlobRef })
  need(hashBytes(reread.bytes) === captured.entries[0].capturedHash, 'frozen blob hash must stay valid')
  need(reread.text.includes('original') && !reread.text.includes('REWRITTEN'), 'frozen blob must keep the original bytes')
  const goneRead = readCaptured({ root, blobRef: captured.entries[1].capturedBlobRef })
  need(goneRead.text.includes('will be deleted'), 'deleted source is still readable from the capture')
  const after = assemble({ spec: captured })
  need(after.payload === before.payload, 'reassembling a frozen capture must not pick up source edits')
  need(after.fingerprint === before.fingerprint, 'fingerprint must not change after source edit')
  need(bySource(after, 'keep.md').sourceHash === keepHash && bySource(after, 'gone.md').sourceHash === goneHash, 'recorded source hashes unchanged')
  // 新捕获才看到新内容；版本切换必须显式，不热替换。
  const recaptured = spec({ root, entries: [{ sourceId: 'keep.md', slot: 'fact', scope: 'product', productId: 'p1', path: keep, required: true }] })
  need(recaptured.entries[0].sourceHash !== keepHash, 'a new capture sees the new bytes')
  need(assemble({ spec: recaptured }).fingerprint !== before.fingerprint, 'new capture produces a different fingerprint')
  return { frozen: keepHash.slice(0, 12) }
})

// ---------------------------------------------------------------- CTX-05
check('CTX-05', 'upstream adoption change makes the old binding stale; late old attempt does not advance', ({ root }) => {
  const captured = spec({ root, entries: [fact(root, 'u.md', '# U\n\nupstream input\n')] })
  const oldBinding = [{ key: 'md:fixture-module-books', revision: 1, snapshotId: 'snap-v1' }]
  const staleAttempt = assemble({ spec: captured, runId: 'run-d', attemptId: 'att-old', upstream: oldBinding })
  // 人工改上游并确认：当前采用变成 revision 2。
  const current = [{ key: 'md:fixture-module-books', revision: 2, snapshotId: 'snap-v2' }]
  expectError(() => assertUpstreamFresh({ binding: oldBinding, current }), 'context_stale', '1->2')
  // 旧 Attempt 自己重拼仍是旧指纹（内容不热替换），但不得被当成新采用推进。
  const staleAgain = assemble({ spec: captured, runId: 'run-d', attemptId: 'att-old', upstream: oldBinding })
  need(staleAgain.fingerprint === staleAttempt.fingerprint, 'old attempt must not silently rebind to the new upstream version')
  const fresh = assemble({ spec: captured, runId: 'run-d', attemptId: 'att-new', upstream: current })
  need(fresh.fingerprint !== staleAttempt.fingerprint, 'new attempt on the new upstream revision gets a new fingerprint')
  need(assertUpstreamFresh({ binding: current, current }) === true, 'matching binding is fresh')
  expectError(() => assertUpstreamFresh({ binding: [{ key: 'pd:removed', revision: 1, snapshotId: 'x' }], current }), 'context_stale', 'upstream_missing')
  // 内核侧 stale 拒绝已由 C13/C19–C22 覆盖；这里只断言上下文绑定层不热替换。
  return { staleFingerprint: staleAttempt.fingerprint.slice(0, 12), freshFingerprint: fresh.fingerprint.slice(0, 12) }
})

// ---------------------------------------------------------------- CTX-06
check('CTX-06', 'repeat assembly / repeat claim / two windows keep one stable input, no double dispatch', ({ root }) => {
  const captured = spec({ root, entries: [fact(root, 'x.md', '# X\n\nbody\n')] })
  const first = assemble({ spec: captured, runId: 'run-6', attemptId: 'att-1' })
  const again = assemble({ spec: captured, runId: 'run-6', attemptId: 'att-1' })
  need(again.payload === first.payload && again.fingerprint === first.fingerprint, 'repeat assembly is idempotent')
  need(again.receipt.payloadHash === first.receipt.payloadHash, 'payloadHash stable on replay')
  // assemble 不得修改调用方传入的 spec（否则第二次组装会被上一次污染）。
  const snapshot = JSON.stringify(captured)
  assemble({ spec: captured, runId: 'run-6', attemptId: 'att-2' })
  need(JSON.stringify(captured) === snapshot, 'assemble must not mutate the captured spec')

  // 内核：同一 run 重复领取只产生一个 running 步骤；恢复扫描后仍只有一个在途 Attempt。
  const db = new DatabaseSync(join(root, 'k.sqlite'))
  const kernel = createWorkflowKernel(db, root)
  try {
    kernel.createRun({ id: 'run-6', human: false, input: {}, steps: [{ nodeId: 'n1', nodeKind: 'automatic' }, { nodeId: 'n2', nodeKind: 'automatic' }] })
    const claim1 = kernel.claim('run-6', { fixture: true })
    need(claim1.kind === 'automatic', `first claim must hand out an automatic attempt, got ${claim1.kind}`)
    const attemptId = claim1.attemptId
    const att = assemble({ spec: captured, runId: 'run-6', attemptId })
    need(att.manifest.attemptId === attemptId, 'manifest records the bound attempt')
    // 双窗口：两个窗口用同一 attempt 各自组装，正文与指纹一致，不会因为窗口不同而分叉。
    const windowB = assemble({ spec: captured, runId: 'run-6', attemptId })
    need(windowB.fingerprint === att.fingerprint && windowB.payload === att.payload, 'two windows must assemble identical input')
    // 重复回调：步骤仍在途时再领取必须被拒，不会出现第二个在途 Attempt。
    expectError(() => kernel.claim('run-6', { fixture: true }), 'step_not_claimable')
    const running = kernel.query('SELECT COUNT(*) AS n FROM workflow_steps WHERE run_id=? AND state=?', 'run-6', 'running')[0].n
    need(running === 1, `exactly one running step expected, got ${running}`)
  } finally {
    try { kernel.db.close() } catch {}
  }
  return { attemptId: first.manifest.attemptId, fingerprint: first.fingerprint.slice(0, 12) }
})

// ---------------------------------------------------------------- CTX-08
check('CTX-08', 'two products in one workspace: cross-product and private content never enters the input', ({ root }) => {
  const p1Dir = join(root, 'p1')
  const p2Dir = join(root, 'p2')
  const p1File = write(p1Dir, 'spec.md', '# p1\n\nalpha only\n')
  const p2File = write(p2Dir, 'spec.md', '# p2\n\nbeta only\n')
  const privateDir = join(root, 'memory', 'p1')
  const privateFile = write(privateDir, 'private.md', '# private\n\nmy own notes\n')

  // 同工作区两产品：p2 的上下文不得引用 p1 的资料。
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: [{ path: p1Dir, productId: 'p1' }, { path: p2Dir, productId: 'p2' }],
    entries: [{ sourceId: 'p1-spec.md', slot: 'fact', scope: 'product', productId: 'p1', path: p1File, required: true }],
  }), 'context_scope_denied', 'other_product')
  // 产品目录白名单：p1 只授权自己的目录，读不到 p2 的文件。
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: [{ path: p1Dir, productId: 'p1' }],
    entries: [{ sourceId: 'p2-spec.md', slot: 'fact', scope: 'product', productId: 'p1', path: p2File, required: true }],
  }), 'context_path_out_of_scope', 'p2-spec.md')

  // 私人记忆默认不进新工作流输入；显式授权后才进入，并体现在指纹里。
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: [{ path: root }, { path: p1Dir, productId: 'p1' }],
    entries: [{ sourceId: 'private.md', slot: 'reference', scope: 'private', required: false, path: privateFile }],
  }), 'context_scope_denied', 'private_not_allowed')
  const withPrivate = captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: [{ path: root }, { path: p1Dir, productId: 'p1' }, { path: privateDir, productId: 'p1', allowPrivate: true }], allowPrivate: true,
    entries: [{ sourceId: 'private.md', slot: 'reference', scope: 'private', required: false, path: privateFile }],
  })
  const withMemory = assemble({ spec: withPrivate })
  need(withMemory.payload.includes('my own notes'), 'explicitly authorized private note is delivered')
  const without = assemble({ spec: captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: [{ path: root }, { path: p1Dir, productId: 'p1' }],
    entries: [{ sourceId: 'p1-spec.md', slot: 'fact', scope: 'product', productId: 'p1', path: p1File, required: true }],
  }) })
  need(!without.payload.includes('my own notes'), 'default input must not inject private memory')
  need(without.fingerprint !== withMemory.fingerprint, 'authorized memory must change the fingerprint')

  // 产品范围资料可读，且 hash 只对应本产品内容。
  const own = captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: [{ path: p1Dir, productId: 'p1' }],
    entries: [{ sourceId: 'p1-spec.md', slot: 'fact', scope: 'product', productId: 'p1', path: p1File, required: true }],
  })
  const ownRun = assemble({ spec: own })
  need(ownRun.payload.includes('alpha only') && !ownRun.payload.includes('beta only'), 'only the authorized product content is delivered')
  return { crossProductBlocked: true, privateDefaultBlocked: true }
})

// ---------------------------------------------------------------- CTX-08B
check('CTX-08B', 'a shared unbound root never authorizes product content from another product directory', ({ root }) => {
  const p1Dir = join(root, 'p1')
  const p2Dir = join(root, 'p2')
  const p1File = write(p1Dir, 'secret.md', '# p1\n\nalpha secret\n')
  write(p2Dir, 'spec.md', '# p2\n\nbeta only\n')

  // 退回反例：只授权整个 workspace，p2 条目自报 productId=p2 却指向 p1 的文件。
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: [{ path: root }],
    entries: [{ sourceId: 'borrowed.md', slot: 'fact', scope: 'product', productId: 'p2', path: p1File, required: true }],
  }), 'context_scope_denied', 'product_path_unbound')
  // 更宽的未绑定目录 + 更窄的 p1 授权目录：文件归属按最具体的目录判定，仍不是 p2 的。
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: [{ path: root }, { path: p1Dir, productId: 'p1' }],
    entries: [{ sourceId: 'borrowed.md', slot: 'fact', scope: 'product', productId: 'p2', path: p1File, required: true }],
  }), 'context_scope_denied', 'product_path_mismatch')
  // 正例：同一 workspace 下各自绑定，才能各读各的。
  const p2 = captureContext({
    root, projectId: 'proj-1', productId: 'p2',
    allowedRoots: [{ path: p1Dir, productId: 'p1' }, { path: p2Dir, productId: 'p2' }],
    entries: [{ sourceId: 'p2-spec.md', slot: 'fact', scope: 'product', productId: 'p2', path: join(p2Dir, 'spec.md'), required: true }],
  })
  const run = assemble({ spec: p2 })
  need(run.payload.includes('beta only') && !run.payload.includes('alpha secret'), 'only the bound product content is delivered')
  return { unboundBlocked: true, mismatchBlocked: true }
})

// ---------------------------------------------------------------- CTX-08C
check('CTX-08C', 'a directory bound to another product is unreadable under every scope, not just scope=product', ({ root }) => {
  const p1Dir = join(root, 'p1')
  const p2Dir = join(root, 'p2')
  const p1PrivateDir = join(root, 'memory', 'p1')
  const p2PrivateDir = join(root, 'memory', 'p2')
  const p1File = write(p1Dir, 'secret.md', '# p1\n\nP1-ONLY-SECRET\n')
  const p2File = write(p2Dir, 'spec.md', '# p2\n\nbeta only\n')
  const projectFile = write(root, 'project-brief.md', '# brief\n\nshared project text\n')
  const p1PrivateFile = write(p1PrivateDir, 'secret.md', '# private\n\nP1-PRIVATE-ONLY\n')
  const p2PrivateFile = write(p2PrivateDir, 'private.md', '# private\n\nmy own notes\n')

  // 退回反例的完整授权拓扑：共享根未绑定 + p1 专属根 + p2 专属根，当前身份是 p2。
  // 私人资料另有各自独立且绑定归属的目录（未绑定根不能靠 allowPrivate 覆盖它们）。
  const roots = () => ([
    { path: root },
    { path: p1Dir, productId: 'p1', allowPrivate: true },
    { path: p2Dir, productId: 'p2', allowPrivate: true },
    { path: p1PrivateDir, productId: 'p1', allowPrivate: true },
    { path: p2PrivateDir, productId: 'p2', allowPrivate: true },
  ])

  // 反例 1：把 p1 文件改标 scope=project，归属仍是 p1 的专属目录。
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: roots(),
    entries: [{ sourceId: 'p1-as-project.md', slot: 'fact', scope: 'project', path: p1File, required: true }],
  }), 'context_scope_denied', 'product_path_mismatch')

  // 反例 2：改标 scope=private，且捕获层与目录层都开了 allowPrivate。
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: roots(), allowPrivate: true,
    entries: [{ sourceId: 'p1-as-private.md', slot: 'reference', scope: 'private', path: p1File, required: false }],
  }), 'context_scope_denied', 'product_path_mismatch')

  // 反例 3（老大第三次复现的原拓扑）：只给共享未绑定根且开了 allowPrivate，
  // 其下 memory/p1/secret.md 标成 p2 的 scope=private 不得交付 ——
  // 未绑定根不能一次批准它下面所有私人文件。
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: [{ path: root, allowPrivate: true }], allowPrivate: true,
    entries: [{ sourceId: 'stolen-private.md', slot: 'reference', scope: 'private', path: p1PrivateFile, required: false }],
  }), 'context_scope_denied', 'private_path_unbound')

  // 反例 3b：即使共享根之外还授了 p1 的独立私人目录（绑定 p1），p2 也读不到。
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: roots(), allowPrivate: true,
    entries: [{ sourceId: 'stolen-private-2.md', slot: 'reference', scope: 'private', path: p1PrivateFile, required: false }],
  }), 'context_scope_denied', 'product_path_mismatch')

  // 反例 3c：共享未绑定根承载项目内散落笔记，即使开 allowPrivate 也不放行。
  const privateFromShared = write(root, 'notes-inside-shared.md', '# n\n\nloose notes\n')
  expectError(() => captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: [{ path: root, allowPrivate: true }], allowPrivate: true,
    entries: [{ sourceId: 'shared-private.md', slot: 'reference', scope: 'private', path: privateFromShared, required: false }],
  }), 'context_scope_denied', 'private_path_unbound')

  // 正例 1：项目级资料走共享未绑定根，p2 可读（项目级不等于产品级）。
  const projectScope = captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: roots(),
    entries: [{ sourceId: 'project-brief.md', slot: 'contract', scope: 'project', path: projectFile, required: true }],
  })
  const projectRun = assemble({ spec: projectScope })
  need(projectRun.payload.includes('shared project text'), 'project-scope material from the shared root is delivered')
  need(!projectRun.payload.includes('P1-ONLY-SECRET'), 'project-scope delivery must not pull in p1 content')

  // 正例 2：私人资料走**自己独立且绑定归属**的目录；p1 身份读自己的私人笔记。
  const ownPrivate = captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: roots(), allowPrivate: true,
    entries: [{ sourceId: 'p1-private.md', slot: 'reference', scope: 'private', path: p1PrivateFile, required: false }],
  })
  const ownPrivateRun = assemble({ spec: ownPrivate })
  need(ownPrivateRun.payload.includes('P1-PRIVATE-ONLY'), 'explicitly authorized private directory delivers to its own identity')

  // 正例 2b：p2 读自己独立绑定的私人目录也成立（授权是按目录逐条生效的）。
  const ownPrivate2 = captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: roots(), allowPrivate: true,
    entries: [{ sourceId: 'p2-private.md', slot: 'reference', scope: 'private', path: p2PrivateFile, required: false }],
  })
  need(assemble({ spec: ownPrivate2 }).payload.includes('my own notes'), 'each identity has its own private directory')

  // 正例 3：p1 用 project 范围读自己的专属目录（归属相符，允许）。
  const ownProject = captureContext({
    root, projectId: 'proj-1', productId: 'p1', allowedRoots: roots(),
    entries: [{ sourceId: 'p1-spec.md', slot: 'fact', scope: 'project', path: p1File, required: true }],
  })
  need(assemble({ spec: ownProject }).payload.includes('P1-ONLY-SECRET'), 'the owning product may read its own directory under any scope')

  // p2 仍只能读到自己绑定的产品资料。
  const ownProduct = captureContext({
    root, projectId: 'proj-1', productId: 'p2', allowedRoots: roots(),
    entries: [{ sourceId: 'p2-spec.md', slot: 'fact', scope: 'product', productId: 'p2', path: p2File, required: true }],
  })
  const ownProductRun = assemble({ spec: ownProduct })
  need(ownProductRun.payload.includes('beta only') && !ownProductRun.payload.includes('P1-ONLY-SECRET'), 'own product content stays isolated')
  return { projectBypassBlocked: true, privateBypassBlocked: true, unboundPrivateBlocked: true }
})


check('SORT-01', 'slot precedence and token estimate are explicit', ({ root }) => {
  const entries = [
    fact(root, 'ref.md', 'ref\n', { slot: 'reference', required: false, order: 1 }),
    fact(root, 'contract.md', 'contract\n', { slot: 'contract', order: 9 }),
    fact(root, 'fact.md', 'fact\n', { slot: 'fact', order: 5 }),
    fact(root, 'role.md', 'role\n', { slot: 'role', order: 3 }),
  ]
  const captured = spec({ root, entries })
  const sorted = sortEntries(captured.entries).map(e => e.slot)
  need(JSON.stringify(sorted) === JSON.stringify(SLOT_ORDER.filter(slot => sorted.includes(slot))), `slot order wrong: ${sorted}`)
  need(estimateTokens(8) === 2 && estimateTokens(9) === 3, 'token estimate is ceil(bytes/4)')
  const run = assemble({ spec: captured })
  need(run.manifest.tokenEstimate === undefined || run.receipt.tokenEstimate === 'approximate', 'token estimate is marked approximate')
  need(run.manifest.budget.tokenEstimate === 'approximate', 'budget marks token estimates as approximate')
  return { order: sorted.join('>') }
})

const passed = results.filter(r => r.status === 'pass').length
const failed = results.filter(r => r.status === 'fail')
console.log(JSON.stringify({
  checks: results.length,
  passed,
  assertions,
  results,
  scope: 'temporary directories and fake identity only; not real context delivery or M1 acceptance',
}, null, 2))
if (failed.length > 0) process.exitCode = 1
