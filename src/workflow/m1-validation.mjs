// W1-11 验证报告（ValidationReport）的规范化与适用性核对：纯函数，不读盘、不写盘、不碰数据库。
//
// 为什么单独成模块：契约里「验证报告」是候选的机器校验记录——
// 04:22（04-human-review-editor.md:22）审核页验证区要求每项给出
// pass / fail / not_assessed / not_applicable、原因与证据；
// 04:37「原验证报告只有在绑定内容 hash 仍一致时有效；对新内容重新运行必要检查」；
// 01:66「不能因没有人工节点而将失败或必需的 not_assessed 当成 pass」；
// 03:45（03-node-contract-runtime.md:45）把「必需校验」写进 human.edit-confirm 的节点配置。
// 这四条目前在内核里都没有实现（scripts/verify-workflow-m1-endtoend.mjs:378 的 E2E-05
// 只是用「必需发布未完成」近似），接入前先把判定口径固化成纯函数，
// 让内核、服务、页面和离线备份读同一套规则，避免各写一遍。
//
// 边界：
// - 纯函数：不读文件、不写文件、不建库、不依赖内核模块；只做结构校验与摘要计算。
// - 不新增服务错误码：本模块的错误码是内核内部码，服务侧应映射到已冻结的
//   human_confirm_required（m1-fake-service.mjs 的 SERVICE_ERROR_CODES 固定 10 项）。
// - 机器证据与人工意见是两份数据：机器部分的结论不可由人工意见改写；
//   本模块只提供「拼装」与「拒绝改写」两个动作，不合成一个结论字段。
// - 必需检查只认明确的 `pass`。`not_applicable` 是合法结论（04:22 要展示），
//   但它不能豁免必需检查——是否适用由冻结定义决定，不接受跑检查一方自报豁免。
// - 核对入口不信任传入对象：先重新规范化检查项、重算摘要，再用调用方显式给出的
//   必需清单判定，绝不回退信任报告自报的 requiredChecks。
// - 本模块不生成报告：谁跑检查、何时跑，是内核的职责；这里只定义形状与放行条件。
// - 不改写调用方给的输入：所有返回值都是新对象，输入不被修改。

import { createHash } from 'node:crypto'
import { OUTPUT_ARTIFACT_TYPES, DIGEST_PATTERN, normalizeRelativePath } from './m1-output-set.mjs'

/** 报告结构版本。进摘要，保证口径变更时摘要跟着变。 */
export const VALIDATION_SCHEMA_VERSION = 1

/** 检查项结论。四个都来自 04:22，不允许第五种；未知结论一律拒绝，不默认通过。 */
export const CHECK_VERDICTS = Object.freeze(['pass', 'fail', 'not_assessed', 'not_applicable'])

/** 报告的整体状态。incomplete = 有必需检查没有明确结论；只在 pass 时放行。 */
export const REPORT_STATUSES = Object.freeze(['pass', 'fail', 'incomplete'])

/** 人工意见的处理决定。与机器的 pass/fail 分开存放，不互相覆盖。 */
export const HUMAN_DISPOSITIONS = Object.freeze(['confirm', 'request_revision', 'note'])

/** 不能由人工意见携带的字段：出现即视为改写机器证据。 */
const MACHINE_ONLY_FIELDS = Object.freeze(['checks', 'verdicts', 'verdict', 'status', 'summary', 'failures', 'subjectDigest', 'reportDigest', 'requiredChecks'])

/** 单个检查名、原因、证据条目的长度上限，挡住刻意构造的超长文本。 */
const MAX_NAME = 120
const MAX_REASON = 800
const MAX_EVIDENCE = 800
const MAX_EVIDENCE_ITEMS = 32
const MAX_INPUTS = 64

export const VALIDATION_ERROR_CODES = Object.freeze([
  'validation_input_invalid',
  'validation_subject_invalid',
  'validation_subject_digest_invalid',
  'validation_definition_invalid',
  'validation_inputs_invalid',
  'validation_check_invalid',
  'validation_checks_invalid',
  'validation_verdict_invalid',
  'validation_report_invalid',
  'validation_schema_mismatch',
  'validation_report_unavailable',
  'validation_report_failed',
  'validation_report_incomplete',
  'validation_opinion_invalid',
  'validation_evidence_override',
])

const fail = (code, detail = code) => Object.assign(new Error(`${code}:${detail}`), { code, detail })
const digestOf = value => createHash('sha256').update(value).digest('hex')

// ---------------------------------------------------------------------------
// 规范化 JSON 与摘要
// ---------------------------------------------------------------------------

/**
 * 规范化 JSON 序列化：对象键按字典序，数组保持顺序，undefined 成员按 JSON 语义省略/置空。
 *
 * 为什么不用 JSON.stringify：对象键顺序取决于构造方，同一份逻辑定义换个字段顺序就会得到
 * 不同摘要，报告会平白失效。注意这**不等于**内核 workflow_run_definitions.integrity_hash
 * （内核用 JSON.stringify，顺序敏感）；本模块的摘要只用于绑定验证范围。
 */
export const canonicalJson = (value) => {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string' || type === 'boolean') return JSON.stringify(value)
  if (type === 'number') {
    if (!Number.isFinite(value)) throw fail('validation_input_invalid', 'non_finite_number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`
  if (type === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw fail('validation_input_invalid', `unsupported_value:${type}`)
}

const assertDigest = (value, code = 'validation_subject_digest_invalid') => {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw fail(code)
  return value
}

const text = (value, code, limit) => {
  if (typeof value !== 'string') throw fail(code, 'not_a_string')
  const trimmed = value.trim()
  if (!trimmed) throw fail(code, 'empty')
  if (trimmed.length > limit) throw fail(code, `too_long:${trimmed.length}`)
  return trimmed
}

// ---------------------------------------------------------------------------
// 绑定：内容摘要、冻结定义摘要、输入快照
// ---------------------------------------------------------------------------

const SINGLE_FILE_TYPES = Object.freeze(['text', 'markdown', 'json', 'report'])

/**
 * 规范化被验证对象的绑定信息，并算出 subjectDigest。
 *
 * 单文件产物按内容摘要绑定（就是对象库的内容地址）；file-set 按
 * outputSetDigest + 逐文件 {relativePath, hash, bytes} 绑定。
 * 为什么文件集不直接用描述字节摘要：同一份描述可以指向不同的对象组合，
 * 描述摘要相同不代表内容相同（02:34「缺一文件不能半套采用」）。
 *
 * @param {{ artifactType: string, contentHash?: string, outputSetDigest?: string, files?: Array<{relativePath: string, hash: string, bytes: number}> }} subject
 * @returns {{ artifactType: string, kind: 'content' | 'file-set', contentHash?: string, outputSetDigest?: string, files?: Array<object>, subjectDigest: string }}
 */
export const normalizeValidationSubject = (subject = {}) => {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) throw fail('validation_subject_invalid', 'not_an_object')
  const artifactType = subject.artifactType
  if (!OUTPUT_ARTIFACT_TYPES.includes(artifactType)) throw fail('validation_subject_invalid', `artifact_type:${String(artifactType)}`)

  if (artifactType === 'file-set') {
    const outputSetDigest = assertDigest(subject.outputSetDigest)
    if (!Array.isArray(subject.files) || subject.files.length === 0) throw fail('validation_subject_invalid', 'files_missing')
    const files = subject.files.map((file) => {
      if (!file || typeof file !== 'object') throw fail('validation_subject_invalid', 'file_not_an_object')
      const relativePath = normalizeRelativePath(file.relativePath)
      const hash = assertDigest(file.hash)
      const bytes = file.bytes
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw fail('validation_subject_invalid', `file_bytes:${String(bytes)}`)
      return { relativePath, hash, bytes }
    })
    // 路径与内容都要唯一：同一路径两次出现、或同一份字节冒充两份文件，都不能算完整集合。
    const paths = new Set()
    for (const file of files) {
      const key = file.relativePath.toLowerCase()
      if (paths.has(key)) throw fail('validation_subject_invalid', `duplicate_path:${file.relativePath}`)
      paths.add(key)
    }
    const sorted = [...files].sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0))
    const subjectDigest = digestOf(canonicalJson({
      schemaVersion: VALIDATION_SCHEMA_VERSION, kind: 'file-set', artifactType, outputSetDigest, files: sorted,
    }))
    // 调用方若自己带了摘要，必须与重算一致：摘要写错比没有摘要更危险。
    if (subject.subjectDigest !== undefined && subject.subjectDigest !== subjectDigest) throw fail('validation_subject_digest_invalid', 'recomputed_mismatch')
    return Object.freeze({ artifactType, kind: 'file-set', outputSetDigest, files: Object.freeze(sorted.map(file => Object.freeze(file))), subjectDigest })
  }

  if (!SINGLE_FILE_TYPES.includes(artifactType)) throw fail('validation_subject_invalid', `unexpected:${artifactType}`)
  const contentHash = assertDigest(subject.contentHash)
  if (subject.outputSetDigest !== undefined || subject.files !== undefined) throw fail('validation_subject_invalid', 'single_file_carries_set_binding')
  const subjectDigest = digestOf(canonicalJson({ schemaVersion: VALIDATION_SCHEMA_VERSION, kind: 'content', artifactType, contentHash }))
  if (subject.subjectDigest !== undefined && subject.subjectDigest !== subjectDigest) throw fail('validation_subject_digest_invalid', 'recomputed_mismatch')
  return Object.freeze({ artifactType, kind: 'content', contentHash, subjectDigest })
}

/**
 * 冻结定义的摘要。definition 是「这一步要执行什么」的完整节点定义
 * （03 §1 的 node 契约：nodeId / capabilityId / inputs / outputs / publishTargets 等）。
 * 定义一变，旧报告就不再适用（01:47：固定资料、定义、配置、权限变化要派生新 run）。
 *
 * @param {object} definition
 * @returns {string} 64 位十六进制摘要
 */
export const definitionDigestFor = (definition) => {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw fail('validation_definition_invalid', 'not_an_object')
  return digestOf(canonicalJson({ schemaVersion: VALIDATION_SCHEMA_VERSION, definition }))
}

/**
 * 规范化输入快照绑定：有序的 snapshotId 列表（与内核 manifest.inputSnapshotIds 同序同形）。
 *
 * 为什么只绑 snapshotId：快照本身不可变，一个 id 就足够钉住内容；顺序敏感是因为
 * 内核 verifySnapshot 就是按 json(manifest.inputSnapshotIds) 与绑定的 inputs 顺序比较的。
 * 也接受内核 binding.inputs 的原样对象（{stepId, adoptionId, snapshotId, contentHash}）。
 */
export const normalizeInputSnapshotIds = (inputs) => {
  if (inputs === undefined || inputs === null) return Object.freeze([])
  if (!Array.isArray(inputs)) throw fail('validation_inputs_invalid', 'not_an_array')
  if (inputs.length > MAX_INPUTS) throw fail('validation_inputs_invalid', `too_many:${inputs.length}`)
  const ids = inputs.map((input, index) => {
    if (typeof input === 'string') return text(input, 'validation_inputs_invalid', 4096)
    if (!input || typeof input !== 'object') throw fail('validation_inputs_invalid', `item:${index}`)
    return text(input.snapshotId, 'validation_inputs_invalid', 4096)
  })
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) throw fail('validation_inputs_invalid', `duplicate:${id}`)
    seen.add(id)
  }
  return Object.freeze(ids)
}

// ---------------------------------------------------------------------------
// 检查项
// ---------------------------------------------------------------------------

/**
 * 规范化一个机器检查项。结论必须显式给出，且必须是四个之一；
 * 没有结论、或写了个没登记的词（例如 'ok'、'skipped'、'unknown'）一律拒绝——
 * 未知检查不得默认通过（01:66 / A37）。
 *
 * 注意 `not_applicable` 是合法结论但不是通行证：它只说明这项检查对当前产物不适用，
 * 是否算满足必需检查由冻结定义判定（见 statusFor / assessValidationReport），
 * 不需要、也不允许在这里给它任何豁免标记。
 *
 * @param {{ name: string, verdict: string, reason?: string, evidence?: string[], required?: boolean }} check
 */
export const normalizeCheck = (check = {}) => {
  if (!check || typeof check !== 'object' || Array.isArray(check)) throw fail('validation_check_invalid', 'not_an_object')
  const name = text(check.name, 'validation_check_invalid', MAX_NAME)
  if (!CHECK_VERDICTS.includes(check.verdict)) throw fail('validation_verdict_invalid', `${name}:${String(check.verdict)}`)

  // 非 pass 的结论必须说明原因：只说「没通过」无法让人判断该修什么（04:22 的「原因」）。
  const needsReason = check.verdict !== 'pass'
  const reason = check.reason === undefined || check.reason === null || check.reason === ''
    ? ''
    : text(check.reason, 'validation_check_invalid', MAX_REASON)
  if (needsReason && !reason) throw fail('validation_check_invalid', `${name}:reason_required`)

  const rawEvidence = check.evidence === undefined || check.evidence === null ? [] : check.evidence
  if (!Array.isArray(rawEvidence)) throw fail('validation_check_invalid', `${name}:evidence_not_an_array`)
  if (rawEvidence.length > MAX_EVIDENCE_ITEMS) throw fail('validation_check_invalid', `${name}:too_many_evidence`)
  const evidence = rawEvidence.map(item => text(item, 'validation_check_invalid', MAX_EVIDENCE))

  if (check.required !== undefined && typeof check.required !== 'boolean') throw fail('validation_check_invalid', `${name}:required_not_boolean`)

  return Object.freeze({
    name,
    verdict: check.verdict,
    reason: reason || null,
    evidence: Object.freeze(evidence),
    required: check.required === true,
  })
}

/**
 * 规范化检查项列表：按名称排序后去重（名字重复无法判断该信哪一条），
 * 并保证输出顺序与输入顺序无关——摘要因此稳定。
 */
export const normalizeChecks = (checks) => {
  if (!Array.isArray(checks)) throw fail('validation_checks_invalid', 'not_an_array')
  const normalized = checks.map(normalizeCheck)
  const byName = new Map()
  for (const check of normalized) {
    if (byName.has(check.name)) throw fail('validation_checks_invalid', `duplicate:${check.name}`)
    byName.set(check.name, check)
  }
  return Object.freeze([...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)))
}

/** 按结论计数，供页面显示与摘要使用。 */
export const summarizeChecks = (checks = []) => {
  const summary = { pass: 0, fail: 0, not_assessed: 0, not_applicable: 0 }
  for (const check of checks) {
    if (Object.prototype.hasOwnProperty.call(summary, check?.verdict)) summary[check.verdict] += 1
  }
  return Object.freeze({ ...summary, total: checks.length })
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

/**
 * 报告整体状态：必需检查全部明确 pass 才是 pass；
 * 任一必需检查 fail 就是 fail；其余（缺项、未评估、不适用）都是 incomplete。
 * 必需检查只认 `pass`：`not_applicable` 同样不算通过——是否适用由冻结定义决定，
 * 不能由跑检查的一方自己声明豁免（否则报告只要自称「不适用」就能绕过必需检查）。
 * 非必需检查的 fail 只作为提示，不改变状态，但会留在 advisoryFailures 里。
 */
const statusFor = (checks, requiredNames) => {
  const byName = new Map(checks.map(check => [check.name, check]))
  const missing = []
  const notAssessed = []
  const notApplicable = []
  const failed = []
  for (const name of requiredNames) {
    const check = byName.get(name)
    if (!check) { missing.push(name); continue }
    if (check.verdict === 'pass') continue
    if (check.verdict === 'fail') { failed.push(name); continue }
    if (check.verdict === 'not_applicable') { notApplicable.push(name); continue }
    notAssessed.push(name)
  }
  const advisoryFailures = checks.filter(check => check.verdict === 'fail' && !requiredNames.includes(check.name)).map(check => check.name)
  if (failed.length) return { status: 'fail', missing, notAssessed, notApplicable, failed, advisoryFailures }
  if (missing.length || notAssessed.length || notApplicable.length) return { status: 'incomplete', missing, notAssessed, notApplicable, failed, advisoryFailures }
  return { status: 'pass', missing, notAssessed, notApplicable, failed, advisoryFailures }
}

const normalizeRequired = (requiredChecks) => {
  if (requiredChecks === undefined || requiredChecks === null) return null
  if (!Array.isArray(requiredChecks)) throw fail('validation_checks_invalid', 'required_not_an_array')
  const names = requiredChecks.map(name => text(name, 'validation_checks_invalid', MAX_NAME))
  const seen = new Set()
  for (const name of names) {
    if (seen.has(name)) throw fail('validation_checks_invalid', `required_duplicate:${name}`)
    seen.add(name)
  }
  return Object.freeze(names)
}

/**
 * 规范化一份验证报告。
 *
 * requiredChecks 只从调用方显式传入的清单来（应取自冻结定义的「必需校验」，03:45）；
 * 检查项自带的 required 标记只是提示，不能决定必需集合。没有显式清单时按「无必需检查」
 * 记录，报告自身状态因此仅供参考——能否放行一律由 assessValidationReport 用
 * expected.requiredChecks 重算，绝不回退信任报告自报的清单。
 *
 * @param {{ subject: object, definitionDigest: string, inputSnapshotIds?: Array<string|object>, checks: Array<object>, requiredChecks?: string[], producedBy?: string, producedAt?: string }} input
 */
export const normalizeValidationReport = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('validation_report_invalid', 'not_an_object')
  if (input.schemaVersion !== undefined && input.schemaVersion !== VALIDATION_SCHEMA_VERSION) {
    throw fail('validation_schema_mismatch', `report:${String(input.schemaVersion)}`)
  }
  const subject = normalizeValidationSubject(input.subject)
  const definitionDigest = assertDigest(input.definitionDigest, 'validation_definition_invalid')
  const inputSnapshotIds = normalizeInputSnapshotIds(input.inputSnapshotIds)
  const checks = normalizeChecks(input.checks ?? [])
  const requiredNames = normalizeRequired(input.requiredChecks) ?? Object.freeze([])
  const { status, missing, notAssessed, notApplicable, failed, advisoryFailures } = statusFor(checks, requiredNames)

  const producedBy = input.producedBy == null ? null : text(input.producedBy, 'validation_report_invalid', MAX_NAME)
  const producedAt = input.producedAt == null ? null : text(input.producedAt, 'validation_report_invalid', MAX_NAME)

  const report = {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    subject,
    definitionDigest,
    inputSnapshotIds,
    checks,
    requiredChecks: requiredNames,
    status,
    summary: summarizeChecks(checks),
    failures: Object.freeze({
      missing: Object.freeze(missing),
      notAssessed: Object.freeze(notAssessed),
      notApplicable: Object.freeze(notApplicable),
      failed: Object.freeze(failed),
      advisory: Object.freeze(advisoryFailures),
    }),
    producedBy,
    producedAt,
  }
  return Object.freeze({ ...report, reportDigest: reportDigest(report) })
}

/**
 * 报告摘要：对机器部分做规范化摘要（不含人工意见，也不含自身 reportDigest 字段）。
 * 用途：落库做完整性校验、比较两份机器证据是否一致。
 */
export const reportDigest = (report = {}) => digestOf(canonicalJson({
  schemaVersion: VALIDATION_SCHEMA_VERSION,
  subjectDigest: report.subject?.subjectDigest ?? null,
  definitionDigest: report.definitionDigest ?? null,
  inputSnapshotIds: report.inputSnapshotIds ?? [],
  checks: (report.checks ?? []).map(check => ({
    name: check?.name ?? null,
    verdict: check?.verdict ?? null,
    reason: check?.reason ?? null,
    evidence: check?.evidence ?? [],
    required: check?.required === true,
  })),
  requiredChecks: report.requiredChecks ?? [],
  producedBy: report.producedBy ?? null,
}))

// ---------------------------------------------------------------------------
// 适用性核对
// ---------------------------------------------------------------------------

/**
 * 核对一份报告是否仍然适用于某个「现在要采用的内容 + 现在的冻结定义 + 现在的输入」。
 *
 * 四条失效条件（04:37 / 04:33 / 04:39 / 01:47）在这里逐条对应：
 * 内容变 → subject_changed；定义变 → definition_changed；输入变 → input_changed；
 * schema 变 → schema_mismatch。
 *
 * 本函数不信任传入的报告对象，先做三件事再判断：
 * 1. 重新规范化检查项：重复名称（validation_checks_invalid）、非法结论
 *    （validation_verdict_invalid）、非法字段一律拒绝，不静默丢弃；
 * 2. 重算报告摘要并与报告自带摘要比对，不一致即 validation_report_invalid，
 *    防止「改了检查项但沿用旧摘要」；
 * 3. 必需检查清单必须由调用方显式给出（应取自冻结定义），缺失即
 *    validation_definition_invalid —— 允许显式空数组表示确实没有必需检查，
 *    但绝不回退信任报告自报的清单。
 *
 * 只有 status === 'pass' 才放行；必需检查只认明确的 `pass`。
 *
 * @param {object} report 报告（normalizeValidationReport 的返回值，也接受同形的外部对象）
 * @param {{ subject?: object, subjectDigest?: string, definitionDigest: string, inputSnapshotIds?: Array<string|object>, requiredChecks: string[] }} expected requiredChecks 必填
 */
export const assessValidationReport = (report, expected = {}) => {
  if (!report || typeof report !== 'object') throw fail('validation_report_unavailable', 'missing')
  if (report.schemaVersion !== VALIDATION_SCHEMA_VERSION) throw fail('validation_schema_mismatch', `report:${String(report.schemaVersion)}`)

  // 重新规范化，任何一步不合规都直接抛错，不做「尽力而为」的降级。
  const subject = normalizeValidationSubject(report.subject)
  const inputSnapshotIds = normalizeInputSnapshotIds(report.inputSnapshotIds)
  const checks = normalizeChecks(report.checks)
  const declaredRequired = normalizeRequired(report.requiredChecks)
  const definitionDigest = assertDigest(report.definitionDigest, 'validation_definition_invalid')
  const producedBy = report.producedBy === undefined || report.producedBy === null ? null : report.producedBy

  const recomputed = reportDigest({ subject, definitionDigest, inputSnapshotIds, checks, requiredChecks: declaredRequired ?? [], producedBy })
  if (report.reportDigest !== recomputed) throw fail('validation_report_invalid', 'report_digest_mismatch')

  if (expected.requiredChecks === undefined || expected.requiredChecks === null) throw fail('validation_definition_invalid', 'required_checks_required')
  const requiredNames = normalizeRequired(expected.requiredChecks)

  const reasons = []
  const expectedSubjectDigest = expected.subjectDigest !== undefined
    ? assertDigest(expected.subjectDigest)
    : normalizeValidationSubject(expected.subject).subjectDigest
  if (subject.subjectDigest !== expectedSubjectDigest) reasons.push('subject_changed')
  const expectedDefinitionDigest = assertDigest(expected.definitionDigest, 'validation_definition_invalid')
  if (definitionDigest !== expectedDefinitionDigest) reasons.push('definition_changed')
  const expectedInputs = normalizeInputSnapshotIds(expected.inputSnapshotIds)
  if (canonicalJson(inputSnapshotIds) !== canonicalJson(expectedInputs)) reasons.push('input_changed')

  // 报告若声明了非空必需清单却与冻结定义不同，说明它是在另一份契约下生成的，不能沿用。
  // 空清单视为「生产方未声明」，只作诊断：放行仍完全由 expected 决定，不因此放宽。
  const sameSet = (left, right) => canonicalJson([...left].sort()) === canonicalJson([...right].sort())
  const requiredSetMismatch = declaredRequired !== null && declaredRequired.length > 0 && !sameSet(declaredRequired, requiredNames)
  if (requiredSetMismatch) reasons.push('required_set_mismatch')

  const byName = new Map(checks.map(check => [check.name, check]))
  const requiredChecks = requiredNames.map((name) => {
    const check = byName.get(name)
    const verdict = check?.verdict ?? null
    // 必需检查只认明确的 pass：not_applicable 不豁免，not_assessed 不通过。
    return Object.freeze({ name, verdict, ok: verdict === 'pass', reason: check?.reason ?? null })
  })
  for (const entry of requiredChecks) {
    if (entry.verdict === null) reasons.push(`required_missing:${entry.name}`)
    else if (entry.verdict === 'pass') continue
    else if (entry.verdict === 'fail') reasons.push(`required_failed:${entry.name}`)
    else if (entry.verdict === 'not_assessed') reasons.push(`required_not_assessed:${entry.name}`)
    else reasons.push(`required_not_applicable:${entry.name}`)
  }

  // 报告里多出来的检查项（名字不在必需清单里）单独列出：它们是诊断信息，
  // 永远不能顶替某个必需检查，也不会因为存在就被当成「已评估」。
  const requiredSet = new Set(requiredNames)
  const unknownChecks = checks.filter(check => !requiredSet.has(check.name)).map(check => check.name)

  const current = statusFor(checks, requiredNames)
  // 绑定类原因（不带冒号的 subject_changed / definition_changed / input_changed /
  // required_set_mismatch）否掉适用性；required_*:name 类原因否掉放行结论。
  const applicable = !reasons.some(reason => !reason.includes(':'))

  return Object.freeze({
    applicable,
    status: current.status,
    reasons: Object.freeze(reasons),
    requiredChecks: Object.freeze(requiredChecks),
    advisoryFailures: current.advisoryFailures,
    unknownChecks: Object.freeze(unknownChecks),
    requiredSetMismatch,
  })
}

/**
 * 放行断言：报告必须适用且必需检查全部明确 pass，否则抛错。
 * 服务侧把这个内部码映射到已冻结的 human_confirm_required，不新增错误码。
 */
export const assertValidationReport = (report, expected = {}) => {
  const assessment = assessValidationReport(report, expected)
  if (!assessment.applicable) throw fail('validation_report_unavailable', assessment.reasons.join(','))
  if (assessment.status === 'fail') throw fail('validation_report_failed', assessment.reasons.join(','))
  if (assessment.status !== 'pass') throw fail('validation_report_incomplete', assessment.reasons.join(','))
  return assessment
}

// ---------------------------------------------------------------------------
// 机器证据与人工意见
// ---------------------------------------------------------------------------

/**
 * 规范化人工意见。人工意见只能有这些字段：谁、什么时候、说了什么、处理决定、保留项。
 * 一旦出现 checks / verdict / status / subjectDigest 这类机器字段，就是试图改写机器证据
 * （04:37「用户改报告文字不能改机器结论」、07:40「只编辑意见/处理决定，不改原始证据」），直接拒绝。
 *
 * @param {{ by: string, at?: string, note?: string, disposition?: 'confirm'|'request_revision'|'note', retained?: string[] }} opinion
 */
export const normalizeHumanOpinion = (opinion = {}) => {
  if (!opinion || typeof opinion !== 'object' || Array.isArray(opinion)) throw fail('validation_opinion_invalid', 'not_an_object')
  for (const field of MACHINE_ONLY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(opinion, field)) throw fail('validation_evidence_override', field)
  }
  const by = text(opinion.by, 'validation_opinion_invalid', MAX_NAME)
  const disposition = opinion.disposition ?? 'note'
  if (!HUMAN_DISPOSITIONS.includes(disposition)) throw fail('validation_opinion_invalid', `disposition:${String(disposition)}`)
  const note = opinion.note === undefined || opinion.note === null || opinion.note === ''
    ? null
    : text(opinion.note, 'validation_opinion_invalid', MAX_REASON)
  const at = opinion.at === undefined ? null : text(opinion.at, 'validation_opinion_invalid', MAX_NAME)
  const retained = opinion.retained === undefined || opinion.retained === null ? [] : opinion.retained
  if (!Array.isArray(retained)) throw fail('validation_opinion_invalid', 'retained_not_an_array')
  return Object.freeze({
    by,
    at,
    note,
    disposition,
    retained: Object.freeze(retained.map(item => text(item, 'validation_opinion_invalid', MAX_NAME))),
  })
}

/**
 * 把机器报告与人工意见拼成一份审核记录：两部分并列存放，机器部分带自己的摘要。
 * 返回值里没有「合并结论」字段——放行与否只由 assertValidationReport 判，人工意见不参与。
 */
export const assembleValidationRecord = ({ report, opinion = null } = {}) => {
  if (!report || typeof report !== 'object') throw fail('validation_report_unavailable', 'missing')
  if (!Array.isArray(report.checks ?? [])) throw fail('validation_checks_invalid', 'not_an_array')
  const machineDigest = reportDigest(report)
  if (report.reportDigest !== undefined && report.reportDigest !== machineDigest) throw fail('validation_evidence_override', 'report_digest_mismatch')
  return Object.freeze({
    machine: report,
    machineDigest,
    human: opinion ? normalizeHumanOpinion(opinion) : null,
  })
}

/**
 * 人工侧提交回来的记录必须原样保留机器部分：机器摘要不变才算「只改了意见」。
 * 机器摘要变了说明机器证据被改写，拒绝并指出具体哪一份。
 */
export const assertMachineUnchanged = (original = {}, incoming = {}) => {
  if (!original || typeof original !== 'object') throw fail('validation_report_unavailable', 'missing_original')
  if (!incoming || typeof incoming !== 'object') throw fail('validation_report_unavailable', 'missing_incoming')
  const originalDigest = original.machineDigest ?? reportDigest(original.machine ?? original)
  const incomingDigest = incoming.machineDigest ?? reportDigest(incoming.machine ?? incoming)
  if (originalDigest !== incomingDigest) throw fail('validation_evidence_override', 'machine_digest_changed')
  return originalDigest
}
