// M1 / K1-01–K1-03 上下文组装（happy-4.1）。
// 设计原则：捕获（capture）与拼装（assemble）分离。
//   - 捕获阶段把外部资料读成不可变 blob（内容寻址），此后源文件改动/删除都不影响已捕获内容。
//   - 拼装阶段是纯函数：同一份捕获 + 同一策略/版本/预算 => 同一个正文与同一个稳定内容指纹。
// 指纹口径（docs/workflow-plan/17 §5.1）：只覆盖有序捕获内容、绑定、策略/拼装版本与有效配置；
// runId / attemptId / 时间 / 收据 / 凭证属于执行关联，另存，不进跨 Attempt 的相等比较。
// 本文件不读生产资料、不调模型、不写旧工作台表。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const CONTEXT_SCHEMA_VERSION = 'context-manifest/1'
export const ASSEMBLY_VERSION = 'assembly/1'
export const DEFAULT_BUDGET = { totalTokens: 8000 }

// 17 §5.2 第 2 条规定的装配顺序。
export const SLOT_ORDER = Object.freeze(['contract', 'role', 'constraint', 'fact', 'upstream', 'reference'])

export const CONTEXT_ERROR_CODES = Object.freeze([
  'context_invalid', 'context_path_out_of_scope', 'context_scope_denied', 'context_selection_invalid',
  'context_missing_required', 'context_budget_exceeded', 'context_stale', 'context_blob_corrupt',
])

const fail = (code, detail) => Object.assign(new Error(`${code}:${detail ?? ''}`), { code, detail })

export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')
export const hashJson = value => hashBytes(Buffer.from(stableStringify(value), 'utf8'))

/** 键排序序列化：指纹不能依赖对象字面量的插入顺序。 */
const stableStringify = value => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// token 只是估算：17 §5.2 第 4 条要求“仅估算时明确标记”。
export const estimateTokens = bytes => Math.ceil(bytes / 4)

/**
 * 可信目录授权：allowedRoots 的每一项是一条授权记录，可带 productId 绑定归属。
 * 字符串形式等价于不带 productId 的未绑定目录——它只授权项目级资料，
 * 不能凭「文件在这个目录下」就当作某产品的资料（17 §7.1：不能仅凭 projectPath 判断可以跨产品读取）。
 */
const normalizeRoots = allowedRoots => {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) throw fail('context_invalid', 'allowed_roots_required')
  return allowedRoots.map((item, index) => {
    const spec = typeof item === 'string' ? { path: item } : item
    if (!spec || typeof spec.path !== 'string' || spec.path === '') throw fail('context_invalid', `allowed_root_${index}:path_required`)
    let real
    try { real = realpathSync(resolve(spec.path)) } catch { throw fail('context_invalid', `allowed_root_${index}:unreadable`) }
    const productId = spec.productId ?? null
    if (productId !== null && (typeof productId !== 'string' || productId === '')) throw fail('context_invalid', `allowed_root_${index}:product_id_invalid`)
    // allowPrivate 必须逐条显式声明：私人资料不能靠“某个祖先目录恰好被授权”顺带放行。
    return { path: real, productId, allowProject: spec.allowProject !== false, allowPrivate: spec.allowPrivate === true }
  })
}

/** 命中多个授权目录时取最具体（路径最长）的一条，避免宽的未绑定目录盖过窄的产品目录。 */
const pickRoot = (target, roots) => roots
  .filter(root => target === root.path || target.startsWith(root.path.endsWith(sep) ? root.path : `${root.path}${sep}`))
  .sort((a, b) => b.path.length - a.path.length)[0] ?? null

/** 从整份内容里按选择器切出实际选取的字节；选择器越界要显式失败，不截断。 */
const applySelection = ({ sourceId, bytes, selection }) => {
  if (!selection || selection.kind === 'whole') return bytes
  if (selection.kind === 'range') {
    const { from, to } = selection
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > bytes.length || from >= to) {
      throw fail('context_selection_invalid', `${sourceId}:range_out_of_bounds`)
    }
    return bytes.subarray(from, to)
  }
  if (selection.kind === 'section') {
    const heading = String(selection.heading ?? '')
    if (heading === '') throw fail('context_selection_invalid', `${sourceId}:heading_required`)
    const text = bytes.toString('utf8')
    const start = text.indexOf(heading)
    if (start < 0) throw fail('context_selection_invalid', `${sourceId}:section_not_found`)
    // 到下一个同级或更高级标题为止；找不到下一个标题就取到文末。
    const level = (heading.match(/^#+/)?.[0] ?? '#').length
    const rest = text.slice(start + heading.length)
    const next = rest.search(new RegExp(`\\n#{1,${level}} `))
    const body = next < 0 ? rest : rest.slice(0, next)
    return Buffer.from(body, 'utf8')
  }
  throw fail('context_invalid', `${sourceId}:selection_kind_unknown`)
}

/**
 * 捕获外部资料为不可变 blob。
 * 返回 { entries, missing, dropped }：missing 是“文件不在/读不到”，由 assemble 决定是否阻止；
 * 越界路径、范围不符、选择器非法属于安全问题，直接抛错。
 */
export const captureContext = ({
  root, projectId = null, productId = null, allowedRoots = [], entries = [],
  allowPrivate = false, now = () => '2026-11-14T00:00:00.000Z',
}) => {
  if (!Array.isArray(entries) || entries.length === 0) throw fail('context_invalid', 'entries_required')
  const roots = normalizeRoots(allowedRoots)
  const captured = []
  const missing = []
  const seen = new Set()
  for (const entry of entries) {
    const { sourceId, path: filePath, scope = 'product', slot = 'fact', required = false } = entry
    if (typeof sourceId !== 'string' || sourceId === '') throw fail('context_invalid', 'source_id_required')
    if (seen.has(sourceId)) throw fail('context_invalid', `${sourceId}:duplicate_source_id`)
    seen.add(sourceId)
    if (!SLOT_ORDER.includes(slot)) throw fail('context_invalid', `${sourceId}:slot_unknown`)
    if (!['project', 'product', 'private'].includes(scope)) throw fail('context_invalid', `${sourceId}:scope_unknown`)
    // 范围隔离：产品范围只能读本产品；私人范围必须显式授权（CTX-08）。
    if (scope === 'product' && entry.productId !== productId) throw fail('context_scope_denied', `${sourceId}:other_product`)
    if (scope === 'private' && allowPrivate !== true) throw fail('context_scope_denied', `${sourceId}:private_not_allowed`)
    if (scope === 'project' && projectId === null) throw fail('context_scope_denied', `${sourceId}:project_unknown`)
    if (typeof filePath !== 'string' || filePath === '') throw fail('context_invalid', `${sourceId}:path_required`)

    let real
    try { real = realpathSync(resolve(filePath)) } catch {
      // 读不到（不存在 / 无权限）先记录来源，不在这里替调用方决定是否阻止。
      missing.push({ sourceId, required, reason: 'source_unreadable' })
      continue
    }
    // 可信目录授权：真实路径必须落在某条授权目录内，且该目录的产品归属要与条目声明一致。
    // 只给一个未绑定的父目录（例如整个 workspace）不足以授权任何产品资料：
    // 否则 p2 条目只要自报 productId 就能把 p1 的文件当作本产品资料（CTX-08 反例）。
    const rootEntry = pickRoot(real, roots)
    if (!rootEntry) throw fail('context_path_out_of_scope', sourceId)
    // 归属判定对所有 scope 生效：绑定了 p1 的目录，不论条目自称 product / project / private，
    // 都不能被 p2 读取。否则改个 scope 标签就能绕过隔离（CTX-08C 反例）。
    if (rootEntry.productId !== null && rootEntry.productId !== productId) {
      throw fail('context_scope_denied', `${sourceId}:product_path_mismatch`)
    }
    if (scope === 'project' && rootEntry.allowProject !== true) throw fail('context_scope_denied', `${sourceId}:project_not_allowed`)
    // 私人资料要满足三件事，缺一不可：
    //   1) 该目录逐条显式 allowPrivate（不能靠祖先目录顺带放行）；
    //   2) 该目录绑定 productId（未绑定的共享根一次放行会把其下所有私人文件交给任一产品，
    //      老大第三次复验的反例就是 {path:root, allowPrivate:true} 读到 memory/p1/secret.md）；
    //   3) 上面已校验绑定归属与当前身份一致——所以私人资料必须有自己的独立授权目录。
    if (scope === 'private') {
      if (rootEntry.productId === null) throw fail('context_scope_denied', `${sourceId}:private_path_unbound`)
      if (rootEntry.allowPrivate !== true) throw fail('context_scope_denied', `${sourceId}:private_not_allowed`)
    }
    if (scope === 'product' && rootEntry.productId === null) throw fail('context_scope_denied', `${sourceId}:product_path_unbound`)

    let bytes
    try { bytes = readFileSync(real) } catch { missing.push({ sourceId, required, reason: 'source_unreadable' }); continue }
    const capturedBytes = applySelection({ sourceId, bytes, selection: entry.selection })
    const sourceHash = hashBytes(bytes)
    const capturedHash = hashBytes(capturedBytes)
    const blobRef = storeBlob({ root, bytes: capturedBytes })
    captured.push({
      sourceId,
      sourceKind: entry.sourceKind ?? 'file',
      sourceUri: entry.sourceUri ?? filePath,
      scope,
      slot,
      sourceVersion: entry.sourceVersion ?? null,
      sourceHash,
      capturedHash,
      capturedBlobRef: blobRef,
      capturedBytes: capturedBytes.length,
      estimatedTokens: estimateTokens(capturedBytes.length),
      tokenEstimate: 'approximate',
      selection: entry.selection ?? { kind: 'whole' },
      required: required === true,
      authority: entry.authority ?? (required === true ? 'authoritative' : 'reference'),
      priority: Number.isInteger(entry.priority) ? entry.priority : (required === true ? 100 : 50),
      order: Number.isInteger(entry.order) ? entry.order : 0,
    })
  }
  return { root, projectId, productId, entries: captured, missing, capturedAt: now() }
}

/** 内容寻址写入：同一 hash 只存一份；先写临时文件再 rename，避免半截 blob 被读到。 */
const storeBlob = ({ root, bytes }) => {
  const hash = hashBytes(bytes)
  const target = join(root, 'context', hash.slice(0, 2), hash)
  if (existsSync(target)) {
    if (readFileSync(target).length !== bytes.length || hashBytes(readFileSync(target)) !== hash) {
      throw fail('context_blob_corrupt', hash)
    }
    return `context:${hash}`
  }
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, bytes)
  renameSync(temp, target)
  return `context:${hash}`
}

/** 只读取回已捕获字节；源文件改了或删了都不影响（CTX-04）。 */
export const readCaptured = ({ root, blobRef }) => {
  if (typeof blobRef !== 'string' || !blobRef.startsWith('context:')) throw fail('context_invalid', 'blob_ref_required')
  const hash = blobRef.slice('context:'.length)
  if (!/^[a-f0-9]{64}$/.test(hash)) throw fail('context_invalid', 'blob_hash_invalid')
  const file = join(root, 'context', hash.slice(0, 2), hash)
  if (!existsSync(file)) throw fail('context_blob_corrupt', `${hash}:missing`)
  const bytes = readFileSync(file)
  if (hashBytes(bytes) !== hash) throw fail('context_blob_corrupt', `${hash}:hash_mismatch`)
  return { bytes, hash, text: bytes.toString('utf8') }
}

const slotIndex = slot => {
  const index = SLOT_ORDER.indexOf(slot)
  return index < 0 ? SLOT_ORDER.length : index
}

/** 稳定装配顺序：槽位 → order → sourceId。任何人传同样的条目都得到同样顺序。 */
export const sortEntries = entries => [...entries].sort((a, b) =>
  slotIndex(a.slot) - slotIndex(b.slot)
  || a.order - b.order
  || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))

/**
 * 可选条目在预算内的落位顺序：priority 大者先占预算，同 priority 取靠前槽位，再按 order、sourceId。
 * 占不到预算的按同一顺序被省略并记收据；必需条目永不进入这个序列（CTX-03）。
 */
export const optionalKeepOrder = entries => entries
  .filter(entry => entry.required !== true)
  .sort((a, b) =>
    b.priority - a.priority
    || slotIndex(a.slot) - slotIndex(b.slot)
    || a.order - b.order
    || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))

/** 一条资料在交付正文里的完整渲染（标题行 + 正文），预算按这个字节数算，不按片段算。 */
export const renderEntry = entry => `## [${entry.slot}] ${entry.sourceId}\n${entry.capturedText}`
const renderPayload = entries => entries.map(renderEntry).join('\n\n')
/** 预算口径 = 实际交付载荷的字节数（含标题、换行与段间分隔符），不是各片段字节之和。 */
export const payloadTokens = text => (text === '' ? 0 : estimateTokens(Buffer.byteLength(text, 'utf8')))

/**
 * 拼装一个 Attempt 的上下文。纯函数：不读磁盘（已捕获内容随 entries 传入 capturedText）。
 * 返回 { manifest, receipt, payload, fingerprint, entries }。
 */
export const assembleContext = ({
  spec, runId, attemptId, nodeId = null, upstream = [], budget = DEFAULT_BUDGET,
  policyVersion = 'policy/1', assemblyVersion = ASSEMBLY_VERSION, dispatchId = null, adapterVersion = 'fake/1',
}) => {
  const { entries = [], missing = [], projectId = null, productId = null } = spec ?? {}
  const requiredMissing = missing.filter(item => item.required === true)
  if (requiredMissing.length > 0) {
    throw fail('context_missing_required', requiredMissing.map(item => `${item.sourceId}:${item.reason}`).join(','))
  }
  const withText = entries.map(entry => {
    // blob 里已经是裁剪后的实际选取字节，这里不能再套一次 selection。
    const { text } = readCaptured({ root: spec.root, blobRef: entry.capturedBlobRef })
    return { ...entry, capturedText: text }
  })
  const ordered = sortEntries(withText)
  const totalTokens = Number(budget?.totalTokens)
  if (!Number.isInteger(totalTokens) || totalTokens <= 0) throw fail('context_invalid', 'budget_invalid')
  const renderedBytesOf = entry => Buffer.byteLength(renderEntry(entry), 'utf8')

  // 必需内容超限 => 阻止执行，逐项报来源；不静默截断、不自动摘要（CTX-02）。
  // 用量按实际交付正文计算，所以短内容也会因标题与分隔符而超限。
  const requiredEntries = ordered.filter(entry => entry.required === true)
  const requiredPayload = renderPayload(requiredEntries)
  const requiredTokens = payloadTokens(requiredPayload)
  if (requiredTokens > totalTokens) {
    throw fail('context_budget_exceeded', `required:${requiredTokens}>${totalTokens}:${requiredEntries.map(entry => entry.sourceId).join(',')}`)
  }

  const dropped = []
  let keptEntries = requiredEntries
  let payload = requiredPayload
  // 按「先占预算」的固定顺序放可选条目：放不下的整条省略，记原因与大小，不截断内容。
  for (const candidate of optionalKeepOrder(ordered)) {
    const next = sortEntries([...keptEntries, candidate])
    const nextPayload = renderPayload(next)
    if (payloadTokens(nextPayload) <= totalTokens) {
      keptEntries = next
      payload = nextPayload
      continue
    }
    dropped.push({
      sourceId: candidate.sourceId, slot: candidate.slot, required: false,
      reason: 'budget_exceeded', estimatedTokens: payloadTokens(renderEntry(candidate)),
      renderedBytes: renderedBytesOf(candidate), capturedBytes: candidate.capturedBytes,
      priority: candidate.priority,
    })
  }
  const kept = keptEntries
  const used = payloadTokens(payload)

  // 稳定内容指纹：只覆盖内容/绑定/策略/版本/预算，排除 runId、attemptId、时间、收据、凭证。
  const fingerprint = hashJson({
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    policyVersion,
    assemblyVersion,
    budget: { totalTokens },
    projectId,
    productId,
    entries: kept.map(({ sourceId, slot, scope, sourceHash, capturedHash, selection, required, priority, order, capturedBytes }) =>
      ({ sourceId, slot, scope, sourceHash, capturedHash, selection, required, priority, order, capturedBytes })),
    omitted: dropped.map(({ sourceId, reason }) => ({ sourceId, reason })),
    upstream: [...upstream].map(({ key, revision, snapshotId }) => ({ key, revision, snapshotId }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  })

  const manifest = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    manifestHash: null,
    projectId, productId, runId, nodeId, attemptId,
    policyVersion, assemblyVersion,
    budget: { totalTokens, usedTokens: used, tokenEstimate: 'approximate', basis: 'delivered-payload' },
    entries: kept.map(({ capturedText, ...entry }) => ({ ...entry, renderedBytes: renderedBytesOf(entry) })),
    omittedEntries: dropped,
    upstream: [...upstream],
    contentFingerprint: fingerprint,
  }
  // manifestHash 覆盖执行关联，因此跨 Attempt 允许不同；跨 Attempt 相等性看 contentFingerprint。
  manifest.manifestHash = hashJson({ ...manifest, manifestHash: null })

  const receipt = {
    manifestHash: manifest.manifestHash,
    contentFingerprint: fingerprint,
    payloadHash: hashBytes(Buffer.from(payload, 'utf8')),
    adapterVersion,
    dispatchId,
    entryDelivery: kept.map(entry => ({ sourceId: entry.sourceId, capturedHash: entry.capturedHash, deliveredBytes: renderedBytesOf(entry), capturedBytes: entry.capturedBytes })),
    deliveredBytes: Buffer.byteLength(payload, 'utf8'),
    deliveredTokens: used,
    tokenEstimate: 'approximate',
    // 本批只到「已捕获」：没有真实宿主确认，不能声称模型已阅读（CTX-07 属 M2）。
    verification: 'captured',
    omittedEntries: dropped,
    errors: [],
  }
  return { manifest, receipt, payload, fingerprint, entries: kept }
}

/** 上游采用变化后，绑定旧版本的 Attempt 必须显式失效，而不是悄悄用新内容重拼（CTX-05）。 */
export const assertUpstreamFresh = ({ binding = [], current = [] }) => {
  const currentByKey = new Map(current.map(item => [item.key, item]))
  for (const item of binding) {
    const now = currentByKey.get(item.key)
    if (!now) throw fail('context_stale', `${item.key}:upstream_missing`)
    if (now.revision !== item.revision || now.snapshotId !== item.snapshotId) {
      throw fail('context_stale', `${item.key}:${item.revision}->${now.revision}`)
    }
  }
  return true
}
