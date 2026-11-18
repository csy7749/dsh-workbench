// W1-11 人工草稿的机器检查器：把「人工节点当前要确认的内容」跑成一份验证报告。
//
// 为什么单独成模块：
// - 报告的形状与放行口径已经由 m1-validation.mjs 固定；这里只负责「算出检查项」，
//   不重复实现规范化、摘要和放行判定。
// - 报告生成要独立于确认事务（失败的报告也要留下，01:64），所以它必须是一个
//   可单独调用、不写库、不碰事务的纯函数；内核在 confirmHuman 里先跑它、再决定放行。
// - 假执行器能判的东西很有限（内容非空、UTF-8 往返、JSON 可解析）。把这份能力边界
//   写成一份明确的清单，比让每个调用点自行猜测「假校验器会检查什么」可靠。
//
// 边界：
// - 纯函数：不读文件、不访问数据库、不发网络请求，也不写任何东西。
// - 不把调用方给的集合描述当成已核验字节的证据：file-set 的每个文件字节只有两条
//   可信来源——调用方把字节一起递进来（本模块自己算摘要），或者没人递（那就
//   一律 not_assessed）。只凭 {hash, bytes} 就宣称「文件已校验」等于把证据换成声明。
// - 字节证据不完整或不匹配时，内容检查（非空 / UTF-8 / JSON）一律 not_assessed，
//   只有 set.file_bytes_hashed 判 fail：缺了某个文件却拿剩下的文件判「全部非空」，
//   是让一部分证据替整组作证，比不给结论更危险。
// - 未实现的检查名保持 not_assessed（01:66 / A37：未知检查不得默认通过）。
// - 必需检查清单必须由调用方显式给出（取自冻结定义）。缺失时直接拒绝，不当作空清单：
//   「节点没有声明必需检查」和「声明了空清单」是两件事，前者要页面提示，后者不用。
// - 不改写输入：所有返回值都是新对象。
import {
  definitionDigestFor,
  normalizeInputSnapshotIds,
  normalizeValidationReport,
  normalizeValidationSubject,
} from './m1-validation.mjs'
import { OUTPUT_ARTIFACT_TYPES, fileBytesDigest, outputSetDigest } from './m1-output-set.mjs'

/** 检查名。名字是契约的一部分：冻结定义里的 requiredChecks 要按这些名字声明。 */
export const DRAFT_CHECK_NAMES = Object.freeze({
  NON_EMPTY: 'content.non_empty',
  UTF8: 'content.utf8_roundtrip',
  JSON: 'content.json_parsable',
  FILE_BYTES: 'set.file_bytes_hashed',
})

const fail = (code, detail = code) => Object.assign(new Error(`${code}:${detail}`), { code, detail })

const MAX_NAME = 120

/** 与 m1-validation.mjs 的 normalizeRequired 同口径；那个函数没有导出，这里保持同规则。 */
const normalizeRequiredNames = (requiredChecks) => {
  if (requiredChecks === undefined || requiredChecks === null) {
    throw fail('validation_definition_invalid', 'required_checks_required')
  }
  if (!Array.isArray(requiredChecks)) throw fail('validation_checks_invalid', 'required_not_an_array')
  const seen = new Set()
  return requiredChecks.map((value) => {
    if (typeof value !== 'string') throw fail('validation_checks_invalid', 'required_not_a_string')
    const name = value.trim()
    if (!name) throw fail('validation_checks_invalid', 'required_empty')
    if (name.length > MAX_NAME) throw fail('validation_checks_invalid', `required_too_long:${name.length}`)
    if (seen.has(name)) throw fail('validation_checks_invalid', `required_duplicate:${name}`)
    seen.add(name)
    return name
  })
}

const check = (name, verdict, reason, evidence = [], required = false) => ({
  name, verdict, reason, evidence, required,
})

/**
 * UTF-8 往返判定。
 *
 * 输入是字符串时，检验它能不能原样编码回来（孤立代理项会变成替换字符，因此失败）；
 * 输入是字节时，必须检验「这些字节本身是不是合法 UTF-8」——
 * 不能先 toString 再编码，那样非法序列已被替换成 U+FFFD，往返永远成立，等于放行坏字节。
 */
const utf8RoundtripString = value => Buffer.from(value, 'utf8').toString('utf8') === value
const utf8RoundtripBytes = bytes => Buffer.from(bytes.toString('utf8'), 'utf8').equals(Buffer.from(bytes))

/** 单文件（text/markdown/json/report）：字节就在手上，三项都能真判。 */
const singleFileChecks = (content, artifactType) => {
  const bytes = Buffer.from(content, 'utf8')
  const roundtrips = utf8RoundtripString(content)
  const list = []
  list.push(check(DRAFT_CHECK_NAMES.NON_EMPTY,
    bytes.length > 0 ? 'pass' : 'fail',
    bytes.length > 0 ? `bytes:${bytes.length}` : 'empty_content'))
  list.push(check(DRAFT_CHECK_NAMES.UTF8,
    roundtrips ? 'pass' : 'fail',
    roundtrips ? 'utf8_roundtrip_ok' : 'invalid_utf16_sequence'))
  if (artifactType === 'json') {
    let parsed = true
    try { JSON.parse(content) } catch { parsed = false }
    list.push(check(DRAFT_CHECK_NAMES.JSON, parsed ? 'pass' : 'fail', parsed ? 'json_parsable' : 'json_parse_failed'))
  } else {
    // 非 JSON 产物没有这项可判：显式 not_applicable（并给原因），不是通过。
    list.push(check(DRAFT_CHECK_NAMES.JSON, 'not_applicable', `artifact_type:${artifactType}`))
  }
  return list
}

/**
 * 文件集：集合描述只用来绑定（digest + 逐文件 hash/bytes），不作为字节已核验的证据。
 * 只有调用方把 contents 一路递进来时，才由本模块自己算摘要、自己比对。
 */
const fileSetChecks = (set, contents, fileReadIssues = []) => {
  const files = set.files
  if (contents !== undefined && contents !== null && !(contents instanceof Map)
    && (typeof contents !== 'object' || Array.isArray(contents) || Buffer.isBuffer(contents) || contents instanceof Uint8Array)) {
    throw fail('validation_input_invalid', 'contents_not_a_mapping')
  }
  const provided = contents instanceof Map
    ? contents
    : (contents && typeof contents === 'object' ? new Map(Object.entries(contents)) : null)

  if (!provided) {
    // 没有字节就没有证据：三项一律未评估，绝不因为描述里写了 hash 就当它已校验。
    const hasJson = files.some(file => file.mediaType === 'application/json')
    const unknownType = files.some(file => typeof file.mediaType !== 'string' || !file.mediaType)
    return [
      check(DRAFT_CHECK_NAMES.NON_EMPTY, 'not_assessed', 'file_bytes_not_provided'),
      check(DRAFT_CHECK_NAMES.UTF8, 'not_assessed', 'file_bytes_not_provided'),
      hasJson
        ? check(DRAFT_CHECK_NAMES.JSON, 'not_assessed', 'file_bytes_not_provided')
        : check(DRAFT_CHECK_NAMES.JSON, unknownType ? 'not_assessed' : 'not_applicable',
          unknownType ? 'file_media_type_unknown' : 'no_json_file'),
      check(DRAFT_CHECK_NAMES.FILE_BYTES, 'not_assessed', 'file_bytes_not_provided'),
    ]
  }

  const empty = []
  const badUtf8 = []
  const badJson = []
  const mismatched = fileReadIssues.map(issue => `${issue.relativePath}:${issue.code}${issue.detail ? `:${issue.detail}` : ''}`)
  const declared = new Map(files.map(file => [file.relativePath, file]))
  for (const [relativePath, value] of provided) {
    if (!declared.has(relativePath)) { mismatched.push(`${relativePath}:undeclared`); continue }
    // 只接受字符串或字节缓冲：其他类型无法代表文件内容，不能当成「已提供」。
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      mismatched.push(`${relativePath}:not_bytes`)
      continue
    }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    const file = declared.get(relativePath)
    if (bytes.length === 0) empty.push(relativePath)
    if (fileBytesDigest(bytes) !== file.hash) mismatched.push(`${relativePath}:hash`)
    if (bytes.length !== file.bytes) mismatched.push(`${relativePath}:bytes`)
    if (!utf8RoundtripBytes(bytes)) badUtf8.push(relativePath)
    if (file.mediaType === 'application/json') {
      try { JSON.parse(bytes.toString('utf8')) } catch { badJson.push(relativePath) }
    }
  }
  // 声明了却没给字节：不能算「通过」，也不能算「未评估」——是明确的缺失。
  for (const file of files) {
    if (!provided.has(file.relativePath) && !fileReadIssues.some(issue => issue.relativePath === file.relativePath)) mismatched.push(`${file.relativePath}:missing`)
  }

  // 字节证据不完整（缺文件、多给未声明路径、给了非字节值）或不匹配（hash/bytes 不符）时，
  // 内容检查一律不得给 pass：此时看到的字节根本不是这份集合声明的那份。
  // 部分字节仍可能「恰好非空、恰好是合法 UTF-8、恰好能解析 JSON」，据此判通过等于
  // 用别的文件的内容给这份文件作证。只有 FILE_BYTES 一项能表达这个失败，它判 fail。
  const unverified = mismatched.length > 0
  const verdictOf = (verdict, reason) => ({ verdict, reason })
  const contentVerdict = (badItems, failReason, passReason) => {
    if (unverified) return verdictOf('not_assessed', 'file_bytes_unverified')
    return badItems.length ? verdictOf('fail', failReason) : verdictOf('pass', passReason)
  }
  const hasJson = files.some(file => file.mediaType === 'application/json')
  const unknownType = files.some(file => typeof file.mediaType !== 'string' || !file.mediaType)
  const nonEmpty = contentVerdict(empty, `empty_files:${empty.join(',')}`, 'all_files_non_empty')
  const utf8 = contentVerdict(badUtf8, `invalid_utf8:${badUtf8.join(',')}`, 'utf8_roundtrip_ok')
  const json = hasJson
    ? contentVerdict(badJson, `json_parse_failed:${badJson.join(',')}`, 'json_parsable')
    : verdictOf(unknownType ? 'not_assessed' : 'not_applicable', unknownType ? 'file_media_type_unknown' : 'no_json_file')

  return [
    check(DRAFT_CHECK_NAMES.NON_EMPTY, nonEmpty.verdict, nonEmpty.reason),
    check(DRAFT_CHECK_NAMES.UTF8, utf8.verdict, utf8.reason),
    check(DRAFT_CHECK_NAMES.JSON, json.verdict, json.reason),
    check(DRAFT_CHECK_NAMES.FILE_BYTES,
      mismatched.length ? 'fail' : 'pass',
      mismatched.length ? `file_bytes_mismatch:${mismatched.join(',')}` : 'file_bytes_match'),
  ]
}

/**
 * 校验调用方给的集合是否是「自洽的」集合描述。
 * 只做结构一致性：重算 digest 必须与声明一致。字节是否存在不在这里判（见上）。
 */
const normalizeVerifiedSet = (outputSet) => {
  if (!outputSet || typeof outputSet !== 'object' || Array.isArray(outputSet)) {
    throw fail('validation_subject_invalid', 'output_set_not_an_object')
  }
  if (!Array.isArray(outputSet.outputs) || outputSet.outputs.length === 0) {
    throw fail('validation_subject_invalid', 'output_set_outputs_missing')
  }
  const recomputed = outputSetDigest(outputSet)
  if (outputSet.digest !== recomputed) throw fail('validation_subject_digest_invalid', 'digest_recomputed_mismatch')
  return outputSet
}

/**
 * 生成一份人工草稿的验证报告。
 *
 * @param {{
 *   content?: string,                       单文件产物：待确认的文本
 *   artifactType?: string,                  单文件产物类型（text/markdown/json/report）
 *   outputSet?: object,                     文件集产物：已规范化的集合描述（含 digest）
 *   contents?: Map<string, string|Buffer> | Record<string, string|Buffer>,  可选：已读取文件字节
 *   fileReadIssues?: Array<{relativePath: string, code: string, detail?: string}>, 对象缺失/损坏
 *   definition: object,                     冻结定义（definitionFor(runId) 的整份结果）
 *   inputSnapshotIds?: Array<string|object>,冻结输入快照 id
 *   requiredChecks: string[],               冻结定义里这一步的必需检查（必填，可为空数组）
 *   producedBy?: string, producedAt?: string,
 * }} input
 * @returns {object} normalizeValidationReport 的返回值（含 reportDigest）
 */
export const validateDraft = (input = {}, evaluateChecks = () => []) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('validation_input_invalid', 'not_an_object')
  const requiredNames = normalizeRequiredNames(input.requiredChecks)
  // 定义摘要用整份冻结定义：任何一个节点或输入契约变化都要让旧报告失效（01:47）。
  const definitionDigest = definitionDigestFor(input.definition)
  const inputSnapshotIds = normalizeInputSnapshotIds(input.inputSnapshotIds)

  const isSet = input.outputSet !== undefined && input.outputSet !== null
  if (isSet && input.artifactType !== undefined && input.artifactType !== 'file-set') {
    throw fail('validation_subject_invalid', 'ambiguous_subject')
  }

  let subject
  let computed
  if (isSet) {
    const set = normalizeVerifiedSet(input.outputSet)
    subject = normalizeValidationSubject({
      artifactType: 'file-set',
      outputSetDigest: set.digest,
      files: set.files.map(file => ({ relativePath: file.relativePath, hash: file.hash, bytes: file.bytes })),
    })
    computed = fileSetChecks(set, input.contents, input.fileReadIssues ?? [])
  } else {
    const artifactType = input.artifactType
    if (!OUTPUT_ARTIFACT_TYPES.includes(artifactType) || artifactType === 'file-set') {
      throw fail('validation_subject_invalid', `artifact_type:${String(artifactType)}`)
    }
    if (typeof input.content !== 'string') throw fail('validation_input_invalid', 'content_required')
    // 内容地址由本模块按实际字节算出，不接受调用方自带摘要。
    subject = normalizeValidationSubject({
      artifactType, contentHash: fileBytesDigest(Buffer.from(input.content, 'utf8')),
    })
    computed = singleFileChecks(input.content, artifactType)
    computed.push(...evaluateChecks(input.content, requiredNames))
    if (requiredNames.includes('check.report_pass')) {
      let report
      try { report = JSON.parse(input.content) } catch {}
      computed.push(check('check.report_pass', report?.ok === true ? 'pass' : 'fail', report?.ok === true ? 'checks_passed' : 'checks_failed'))
    }
  }

  // 必需检查名必须都出现在报告里：缺项会被 statusFor 判成 missing，
  // 这里显式列出未实现的名字，让页面能看出「这项没人能判」而不是「没有这项」。
  const implemented = new Map(computed.map(item => [item.name, item]))
  const checks = requiredNames.map((name) => {
    const found = implemented.get(name)
    if (found) return { ...found, required: true }
    // 声明了但本模块没实现：保持未评估并说明原因，不得默认通过。
    return check(name, 'not_assessed', 'check_not_implemented_by_draft_validator', [], true)
  })
  // 非必需的补充检查：只作为诊断，不参与放行（required=false 且不在 requiredChecks 里）。
  for (const item of computed) {
    if (!requiredNames.includes(item.name)) checks.push({ ...item, required: false })
  }

  return normalizeValidationReport({
    subject,
    definitionDigest,
    inputSnapshotIds,
    checks,
    requiredChecks: requiredNames,
    producedBy: input.producedBy ?? undefined,
    producedAt: input.producedAt ?? undefined,
  })
}
