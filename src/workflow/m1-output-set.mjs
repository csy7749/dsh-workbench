// W1-10 产物集合（OutputSet）的规范化与摘要：纯函数，不读盘、不写盘、不碰数据库。
//
// 为什么单独成模块：02 §1（02-snapshot-versioning.md:15）要求快照清单带 blobs[]，
// 02:34 要求「多文件输出以 OutputSet 作为完整性边界，缺一文件不能半套采用」，
// 03 §1（03-node-contract-runtime.md:9-26）的 outputs[] 声明带 multiplicity。
// 这三条在内核里目前都由单 blob 写死，接入前先把「集合」的判定口径固化成纯函数，
// 让存储、人工确认、发布对账和离线备份四处调用同一套规则，避免各写一遍。
//
// 边界：
// - 纯函数：不读文件、不写文件、不建库、不依赖内核模块；只做结构校验与摘要计算。
// - 不替换现有文本摘要语义：text / markdown / json 候选仍按单文件字节摘要记账
//   （内核 storeCandidate 的 contentHash 不变）。只有真正多文件的产物才使用集合摘要，
//   两者在本模块里是两个不同的函数，名字上不复用。
// - multiplicity 约束的是输出实例数量，不约束文件数：一个 file-set 实例可以包含多份文件。
// - 不改写调用方给的内容：所有返回值都是新对象，输入不被修改。

import { createHash } from 'node:crypto'

/** 集合清单的结构版本。进摘要，保证口径变更时摘要跟着变。 */
export const OUTPUT_SET_SCHEMA_VERSION = 1

/** 输出实例数量约束。'one' = 恰好 1 个实例；'many' = 至少 1 个实例。与文件数无关。 */
export const MULTIPLICITIES = Object.freeze(['one', 'many'])
export const OUTPUT_ARTIFACT_TYPES = Object.freeze(['text', 'markdown', 'json', 'file-set', 'report'])

/** 内容摘要 / 文件摘要的形态：sha256 十六进制。 */
export const DIGEST_PATTERN = /^[a-f0-9]{64}$/

/** 相对路径长度上限：给对象库前缀留余量，同时挡住刻意构造的超长路径。 */
const MAX_RELATIVE_PATH = 240

/** Windows 上不允许出现在文件名里的字符。跨平台确定性优先，逐平台放行会埋不一致。 */
const WINDOWS_RESERVED = /[<>:"|?*]/
/** 控制字符（含 NUL）。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
/** 单段盘符前缀，例如 "C:"。 */
const DRIVE_LETTER = /^[A-Za-z]:$/

const fail = (code, detail = code) => Object.assign(new Error(`${code}:${detail}`), { code, detail })
const digestOf = value => createHash('sha256').update(value).digest('hex')

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

/**
 * 文件字节摘要。**这是单个文件的**摘要，等于对象库中的内容地址。
 *
 * 相同字节永远得到相同摘要，因此「是否复用对象」由写入端的对象存在性判断决定，
 * 与本函数是否重新计算无关。本函数不判断复用。
 *
 * @param {string | Buffer | Uint8Array} bytes 文件内容（UTF-8 字符串按 UTF-8 计入）。
 * @returns {string} 64 位十六进制 sha256。
 */
export const fileBytesDigest = (bytes) => {
  if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw fail('output_file_digest_input_invalid')
  }
  return digestOf(bytes)
}

/**
 * 集合清单摘要。**这是整组产物的**摘要，不是任何单个文件的。
 *
 * 只覆盖规范化后的结构（见 normalizeOutputSet），因此：
 * - 与输入顺序无关（同名实例与文件都排序）；
 * - 与对象的物理存放方式无关；
 * - 文件字节本身不在摘要里，只以其 hash / bytes / mediaType 参与，字节层已由 hash 承诺。
 *
 * @param {object} set normalizeOutputSet 的返回值，或同形状对象。
 * @returns {string} 64 位十六进制 sha256。
 */
export const outputSetDigest = (set) => {
  const files = indexFiles(set?.files)
  const outputs = (set?.outputs ?? []).map(item => canonicalInstance(item, files)).sort(compareCanonical)
  return digestOf(JSON.stringify({ schemaVersion: OUTPUT_SET_SCHEMA_VERSION, outputs }))
}

// ---------------------------------------------------------------------------
// 相对路径
// ---------------------------------------------------------------------------

/**
 * 校验并规范化一个相对路径。
 *
 * 接受 `a/b/c.txt` 与 `a\b\c.txt`（反斜杠统一成正斜杠），拒绝：
 * 绝对路径、盘符、`..`、`.`、空段、控制字符、Windows 保留字符、结尾空格或点、超长。
 *
 * @param {unknown} value
 * @returns {string} 以 `/` 分隔的规范相对路径。
 */
export const normalizeRelativePath = (value) => {
  if (typeof value !== 'string') throw fail('output_path_invalid', 'not_a_string')
  if (value === '') throw fail('output_path_invalid', 'empty')
  if (CONTROL_CHARACTERS.test(value)) throw fail('output_path_invalid', 'control_character')
  const unified = value.replace(/\\/g, '/')
  if (unified.startsWith('/')) throw fail('output_path_invalid', 'absolute')
  if (/^[A-Za-z]:/.test(unified)) throw fail('output_path_invalid', 'drive_letter')
  const segments = unified.split('/')
  const kept = []
  for (const segment of segments) {
    if (segment === '') throw fail('output_path_invalid', 'empty_segment')
    if (segment === '.') throw fail('output_path_invalid', 'dot_segment')
    if (segment === '..') throw fail('output_path_invalid', 'parent_segment')
    if (DRIVE_LETTER.test(segment)) throw fail('output_path_invalid', 'drive_letter')
    if (WINDOWS_RESERVED.test(segment)) throw fail('output_path_invalid', 'reserved_character')
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) throw fail('output_path_invalid', 'reserved_device')
    if (segment.endsWith(' ') || segment.endsWith('.')) throw fail('output_path_invalid', 'trailing_space_or_dot')
    kept.push(segment)
  }
  const normalized = kept.join('/')
  if (normalized.length > MAX_RELATIVE_PATH) throw fail('output_path_invalid', 'too_long')
  return normalized
}

/**
 * 校验一批相对路径：逐个规范化、批内唯一。
 *
 * 唯一性按规范化结果判断；另外单独挡「仅大小写不同」的碰撞，
 * 因为对象库落在 Windows 上时两者会指向同一文件，摘要却把它们当两份。
 *
 * @param {unknown} paths
 * @returns {string[]} 规范化后的路径，保持输入顺序。
 */
export const normalizeRelativePaths = (paths) => {
  if (!Array.isArray(paths)) throw fail('output_paths_invalid', 'not_an_array')
  const seen = new Set()
  const folded = new Set()
  const normalized = []
  for (const value of paths) {
    const path = normalizeRelativePath(value)
    if (seen.has(path)) throw fail('output_path_duplicate', path)
    const key = path.toLowerCase()
    if (folded.has(key)) throw fail('output_path_case_collision', path)
    // a 与 a/b 不能同时作为文件，大小写折叠后同样检查。
    const parts = key.split('/')
    for (let index = 1; index < parts.length; index++) {
      if (folded.has(parts.slice(0, index).join('/'))) throw fail('output_path_invalid', 'file_directory_collision')
    }
    for (const prior of folded) if (prior.startsWith(`${key}/`)) throw fail('output_path_invalid', 'file_directory_collision')
    seen.add(path)
    folded.add(key)
    normalized.push(path)
  }
  return normalized
}

// ---------------------------------------------------------------------------
// 声明（节点 outputs[]）
// ---------------------------------------------------------------------------

/**
 * 校验节点声明。声明描述「允许有哪些具名输出实例」，不描述实例本身。
 *
 * @param {unknown} outputs
 * @returns {ReadonlyArray<{name: string, artifactType: string, schemaVersion: number, editable: boolean, multiplicity: string}>}
 */
export const validateOutputDeclarations = (outputs) => {
  if (!Array.isArray(outputs) || outputs.length === 0) throw fail('output_declaration_invalid', 'not_a_nonempty_array')
  const names = new Set()
  const declarations = []
  for (const item of outputs) {
    if (!item || typeof item !== 'object') throw fail('output_declaration_invalid', 'not_an_object')
    if (typeof item.name !== 'string' || item.name === '') throw fail('output_declaration_invalid', 'name_required')
    if (names.has(item.name)) throw fail('output_declaration_invalid', `duplicate_name:${item.name}`)
    if (!OUTPUT_ARTIFACT_TYPES.includes(item.artifactType)) throw fail('output_declaration_invalid', `artifact_type_required:${item.name}`)
    if (!Number.isSafeInteger(item.schemaVersion) || item.schemaVersion < 1) throw fail('output_declaration_invalid', `schema_version_invalid:${item.name}`)
    if (typeof item.editable !== 'boolean') throw fail('output_declaration_invalid', `editable_invalid:${item.name}`)
    const multiplicity = item.multiplicity ?? 'one'
    if (!MULTIPLICITIES.includes(multiplicity)) throw fail('output_declaration_invalid', `multiplicity_invalid:${item.name}`)
    names.add(item.name)
    declarations.push(Object.freeze({
      name: item.name,
      artifactType: item.artifactType,
      schemaVersion: item.schemaVersion,
      editable: item.editable,
      multiplicity,
    }))
  }
  return Object.freeze(declarations)
}

// ---------------------------------------------------------------------------
// 实例
// ---------------------------------------------------------------------------

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const normalizeInstance = (item, index) => {
  if (!isPlainObject(item)) throw fail('output_instance_invalid', `not_an_object:${index}`)
  if (typeof item.name !== 'string' || item.name === '') throw fail('output_instance_invalid', `name_required:${index}`)
  if (!OUTPUT_ARTIFACT_TYPES.includes(item.artifactType)) throw fail('output_instance_invalid', `artifact_type_required:${item.name}`)
  if (!Number.isSafeInteger(item.schemaVersion) || item.schemaVersion < 1) throw fail('output_instance_invalid', `schema_version_invalid:${item.name}`)
  if (!Array.isArray(item.files) || item.files.length === 0) throw fail('output_instance_invalid', `files_required:${item.name}`)
  const files = normalizeRelativePaths(item.files).sort()
  return {
    name: item.name,
    artifactType: item.artifactType,
    schemaVersion: item.schemaVersion,
    editable: typeof item.editable === 'boolean' ? item.editable : undefined,
    multiplicity: item.multiplicity,
    files,
  }
}

/**
 * 校验具名输出实例与声明一一对应。
 *
 * - 每个实例的 name 必须被声明覆盖，否则实例无处归属；
 * - 每个声明的 name 都必须出现，且实例数量符合 multiplicity（one = 1，many >= 1）；
 * - 实例的 artifactType / schemaVersion / editable（若给出）必须与声明一致：
 *   实例不能自己改写节点声明的契约。
 *
 * @param {{declarations: unknown, instances: unknown}} input
 * @returns {{name: string, artifactType: string, schemaVersion: number, editable: boolean, multiplicity: string, files: string[]}[]}
 *   按声明顺序返回，同名多实例时按文件列表排序。
 */
export const matchOutputInstances = ({ declarations, instances } = {}) => {
  const declared = validateOutputDeclarations(declarations)
  if (!Array.isArray(instances) || instances.length === 0) throw fail('output_instance_invalid', 'not_a_nonempty_array')
  const normalized = instances.map(normalizeInstance)
  const byName = new Map()
  for (const item of normalized) {
    if (!byName.has(item.name)) byName.set(item.name, [])
    byName.get(item.name).push(item)
  }
  const matched = []
  for (const declaration of declared) {
    const group = byName.get(declaration.name)
    if (!group) throw fail('output_instance_missing', declaration.name)
    const expected = declaration.multiplicity === 'one' ? 1 : null
    if (expected !== null && group.length !== expected) {
      throw fail('output_instance_count_invalid', `${declaration.name}:expected_1_got_${group.length}`)
    }
    // 'many' 的下界由上面的 !group 覆盖：出现在这里的组至少有一个实例。
    group.sort((a, b) => a.files.join('\u0000').localeCompare(b.files.join('\u0000')))
    for (const item of group) {
      if (item.artifactType !== declaration.artifactType) throw fail('output_instance_type_mismatch', `${declaration.name}:expected_${declaration.artifactType}_got_${item.artifactType}`)
      if (item.schemaVersion !== declaration.schemaVersion) throw fail('output_instance_schema_mismatch', `${declaration.name}:expected_${declaration.schemaVersion}_got_${item.schemaVersion}`)
      if (item.editable !== undefined && item.editable !== declaration.editable) throw fail('output_instance_editable_mismatch', `${declaration.name}:expected_${declaration.editable}_got_${item.editable}`)
      matched.push({
        name: declaration.name,
        artifactType: declaration.artifactType,
        schemaVersion: declaration.schemaVersion,
        editable: declaration.editable,
        multiplicity: declaration.multiplicity,
        files: item.files,
      })
    }
  }
  const declaredNames = new Set(declared.map(item => item.name))
  for (const name of byName.keys()) {
    if (!declaredNames.has(name)) throw fail('output_instance_undeclared', name)
  }
  return matched
}

// ---------------------------------------------------------------------------
// 文件清单
// ---------------------------------------------------------------------------

const normalizeFile = (item, index) => {
  if (!isPlainObject(item)) throw fail('output_file_invalid', `not_an_object:${index}`)
  const relativePath = normalizeRelativePath(item.relativePath)
  if (typeof item.hash !== 'string' || !DIGEST_PATTERN.test(item.hash)) throw fail('output_file_invalid', `hash_invalid:${relativePath}`)
  if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) throw fail('output_file_invalid', `bytes_invalid:${relativePath}`)
  if (typeof item.mediaType !== 'string' || item.mediaType === '') throw fail('output_file_invalid', `media_type_required:${relativePath}`)
  return { relativePath, hash: item.hash, bytes: item.bytes, mediaType: item.mediaType }
}

const indexFiles = (files) => {
  const index = new Map()
  for (const file of files ?? []) {
    if (isPlainObject(file) && typeof file.relativePath === 'string') index.set(file.relativePath, file)
  }
  return index
}

/**
 * 文件清单的规范形式：逐项校验、路径唯一、按路径排序。
 *
 * @param {unknown} files
 * @returns {{relativePath: string, hash: string, bytes: number, mediaType: string}[]}
 */
export const normalizeFileManifest = (files) => {
  if (!Array.isArray(files) || files.length === 0) throw fail('output_files_invalid', 'not_a_nonempty_array')
  const normalized = files.map(normalizeFile)
  normalizeRelativePaths(normalized.map(item => item.relativePath))
  return normalized.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

/**
 * 文件引用双向覆盖：清单里每个文件都被某个实例引用，实例里每个引用都在清单里。
 *
 * 只查一个方向会留下「孤儿文件」——它进了对象库、进了摘要覆盖范围之外，
 * 备份校验与集合摘要都会与磁盘不一致。
 *
 * @param {{instances: unknown, files: unknown}} input 已规范化的实例与文件清单。
 * @returns {{referenced: string[], files: string[]}}
 */
export const assertFileCoverage = ({ instances, files } = {}) => {
  const manifest = normalizeFileManifest(files)
  const known = new Set(manifest.map(item => item.relativePath))
  const referenced = new Set()
  const owner = new Map()
  for (const instance of instances ?? []) {
    if (!isPlainObject(instance) || !Array.isArray(instance.files)) throw fail('output_instance_invalid', 'files_required')
    for (const path of normalizeRelativePaths(instance.files)) {
      if (!known.has(path)) throw fail('output_file_missing', path)
      if (owner.has(path)) throw fail('output_file_shared', `${path}:owned_by_${owner.get(path)}`)
      owner.set(path, instance.name)
      referenced.add(path)
    }
  }
  for (const file of manifest) {
    if (!referenced.has(file.relativePath)) throw fail('output_file_orphan', file.relativePath)
  }
  return { referenced: [...referenced].sort(), files: manifest.map(item => item.relativePath) }
}

// ---------------------------------------------------------------------------
// 规范化总入口
// ---------------------------------------------------------------------------

const canonicalInstance = (item, files) => [
  item.name,
  item.artifactType,
  item.schemaVersion,
  item.editable === true ? 'true' : item.editable === false ? 'false' : 'unknown',
  item.multiplicity ?? 'one',
  [...(item.files ?? [])].sort().map((path) => {
    const file = files.get(path)
    return [path, file?.hash ?? null, file?.bytes ?? null, file?.mediaType ?? null]
  }),
]

const compareCanonical = (left, right) => {
  const a = JSON.stringify(left)
  const b = JSON.stringify(right)
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 规范化一整组产物并给出集合摘要。
 *
 * 数据形状（返回值）：
 * {
 *   schemaVersion: 1,
 *   outputs: [{ name, artifactType, schemaVersion, editable, multiplicity, files: string[] }],
 *   files:   [{ relativePath, hash, bytes, mediaType }],
 *   digest:  <集合摘要，等于 outputSetDigest(规范化结果)>,
 * }
 *
 * 传入 declarations 时执行「声明 ↔ 实例」一一对应；不传则只校验实例自身的结构完整性。
 *
 * @param {{instances: unknown, files: unknown, declarations?: unknown}} input
 */
export const normalizeOutputSet = ({ instances, files, declarations = null } = {}) => {
  const manifest = normalizeFileManifest(files)
  const normalizedInstances = (Array.isArray(instances) ? instances : []).map(normalizeInstance)
  const outputs = declarations === null
    ? normalizedInstances
    : matchOutputInstances({ declarations, instances })
  const merged = mergeInstances(outputs, normalizedInstances, declarations === null)
  assertFileCoverage({ instances: merged, files: manifest })
  const set = { schemaVersion: OUTPUT_SET_SCHEMA_VERSION, outputs: merged, files: manifest }
  set.digest = outputSetDigest(set)
  return set
}

/**
 * 有声明时 matchOutputInstances 已按声明顺序产出实例，顺序直接沿用（不再重排，
 * 否则调用方拿到的顺序会与声明不一致）；无声明时实例自述，按 name + 文件列表排序。
 */
const mergeInstances = (outputs, instances, selfDescribed) => {
  if (!selfDescribed) return outputs
  const names = new Set()
  for (const item of instances) {
    const key = `${item.name}\u0000${item.files.join('\u0000')}`
    if (names.has(key)) throw fail('output_instance_duplicate', item.name)
    names.add(key)
  }
  return [...instances].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return a.files.join('\u0000').localeCompare(b.files.join('\u0000'))
  }).map(item => ({
    name: item.name,
    artifactType: item.artifactType,
    schemaVersion: item.schemaVersion,
    // 无声明时 editable 没有权威来源，保留「未知」而不是宣称只读。
    editable: item.editable === true ? true : item.editable === false ? false : undefined,
    multiplicity: item.multiplicity ?? 'one',
    files: item.files,
  }))
}

// ---------------------------------------------------------------------------
// 便捷判定
// ---------------------------------------------------------------------------

/** 集合是否只有单个文件——用于「沿用既有单文件内容摘要语义」的分支判断。 */
export const isSingleFileSet = (set) => Array.isArray(set?.files) && set.files.length === 1

/**
 * 集合内所有文件字节摘要的排序清单。
 *
 * 这是「集合由哪些内容地址组成」的视图，供发布对账比较目标现状与预期结果使用；
 * 它不是集合摘要，也不要与 outputSetDigest 混用。
 */
export const fileDigestList = (set) => (set?.files ?? [])
  .map(item => ({ relativePath: item.relativePath, hash: item.hash }))
  .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
