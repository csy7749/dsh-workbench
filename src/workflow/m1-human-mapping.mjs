// W1-10 人工节点的具名输入映射（human input mapping）：纯函数，不读盘、不写盘、不建库、不发网络。
//
// 为什么单独成模块：
// - 03 §1 把 inputs[] 与 outputs[] 都列为节点契约必备字段（03-node-contract-runtime.md:11-12），
//   并给了 multiplicity；03:45 要求 human.edit-confirm「接受一个或一组显式绑定的产物，
//   输出同类型的完整集合」。但当前人工链路是单输入单输出（m1-kernel.mjs:993、:1015、:1090
//   三处直接抛 human_output_mapping_required），「从上游完整集合里按实例名挑几项」这件事
//   没有地方表达，也没有地方校验。
// - 这条规则必须先固化，再由内核接线。映射错了的后果不是报错，而是让用户改了一份本该只读的
//   产物，或让下游拿到类型不符的输入。放在内核里各写一遍，早晚出现两种口径。
// - 结果必须能直接进现有 OutputSet：集合摘要覆盖 name / artifactType / editable /
//   multiplicity / 逐文件 hash（m1-output-set.mjs:325-335），所以映射只选实例、只改实例名，
//   绝不改写文件字节摘要。
//
// 边界：
// - 纯函数：不改调用方传入的任何对象；返回值都是新对象或冻结字面量。
// - 不新增服务错误码：这里的码是内核内部码，服务侧应映射到已冻结的
//   human_output_mapping_required / output_contract_mismatch / artifact_not_editable
//   （m1-fake-service.mjs 的 SERVICE_ERROR_CODES 固定 10 项）。
// - 只解决「同一上游 OutputSet 内按实例名取多份」。M1 是线性调度，没有多前驱；
//   跨快照聚合不在本模块能力内，也不假装支持。
// - 只接受文件集（file-set）上游：单文件产物沿用现有单 blob 基线（m1-kernel.mjs:742-773
//   的 storeCandidate 路径），走本函数会直接报 source_files_required，不做隐式转换。
// - 只读结论只来自上游实例自己的 editable：只在它明确为 false 时压成 false，绝不把它变成
//   可编辑。上游未声明 editable（undefined）时保留输出声明的取值并在注释中说明这层取舍；
//   本函数不推断权限，也不提供「强制可编辑」的开关。
// - 不做实例增删：many 的多个上游实例按原样完整保留，每个改名后各成一条映射结果；
//   新增实例会牵动冻结的逐文件发布目标（m1-kernel.mjs:853-880 的 enqueueTargets /
//   validateTargets），那件事另定，本模块不预判发布是否还能通过。

import { normalizeOutputSet, validateOutputDeclarations } from './m1-output-set.mjs'

/** 映射结构版本。与 OutputSet 一样带版本，便于口径变更时判断。 */
export const HUMAN_MAPPING_SCHEMA_VERSION = 1

/** 本模块使用的内部错误码。服务侧不暴露这些名字，只用于诊断与断言。 */
export const HUMAN_MAPPING_ERROR_CODES = Object.freeze([
  'human_mapping_invalid',
  'human_mapping_incomplete',
  'human_mapping_undeclared',
  'human_mapping_source_missing',
  'human_mapping_from_unknown',
  'human_mapping_type_mismatch',
  'human_mapping_schema_mismatch',
  'human_mapping_count_invalid',
  'human_mapping_editable_conflict',
])

/** 名字长度上限，与 m1-validation.mjs 的 MAX_NAME 同口径。 */
const MAX_NAME = 120
/** 一次映射最多多少条。线性模板用不到这么多，超了先当错误看。 */
const MAX_ENTRIES = 64

/**
 * 映射条目里不允许出现的字段。
 *
 * 映射只回答「哪个输出取哪个上游实例」。一旦允许它带 artifactType / hash / files，
 * 调用方就能用映射改写节点契约，或把一份未经核验的内容说成某个实例。
 */
const FORBIDDEN_FIELDS = Object.freeze([
  'artifactType', 'schemaVersion', 'editable', 'multiplicity', 'files', 'hash', 'contentHash',
  'path', 'objectPath', 'storagePath', 'absolutePath', 'realPath', 'bytes', 'mediaType',
])

const fail = (code, detail = code) => Object.assign(new Error(`${code}:${detail}`), { code, detail })

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

const readName = (value, label) => {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) throw fail('human_mapping_invalid', `${label}_invalid`)
  if (value.length > MAX_NAME) throw fail('human_mapping_invalid', `${label}_too_long`)
  return value
}

// ---------------------------------------------------------------------------
// 映射本身
// ---------------------------------------------------------------------------

/**
 * 校验映射并给出规范化列表。
 *
 * 接受两种等价写法：`[{name, from}]` 或 `{name: from}`。前者保留顺序，后者方便写在定义里。
 * 缺省（undefined / null）与空列表都表示「没有映射」，此时由 mapHumanInputSet 按同名直连。
 *
 * 三类错误分开报，因为修法完全不同：结构错（字段名/机器字段）、同名重复、抢同一个上游实例。
 *
 * @param {unknown} mapping node.inputMapping
 * @returns {ReadonlyArray<{name: string, from: string}>} 按传入顺序冻结返回
 */
export const validateHumanInputMapping = (mapping) => {
  if (mapping === undefined || mapping === null) return Object.freeze([])
  let items
  if (Array.isArray(mapping)) items = mapping
  else if (isPlainObject(mapping)) items = Object.entries(mapping).map(([name, from]) => ({ name, from }))
  else throw fail('human_mapping_invalid', 'not_a_list_or_object')
  if (!items.length) return Object.freeze([])
  if (items.length > MAX_ENTRIES) throw fail('human_mapping_invalid', `too_many:${items.length}`)

  const seenName = new Set()
  const seenFrom = new Set()
  const out = []
  for (const item of items) {
    if (!isPlainObject(item)) throw fail('human_mapping_invalid', 'not_an_object')
    for (const key of FORBIDDEN_FIELDS) {
      if (hasOwn(item, key)) throw fail('human_mapping_invalid', `injected_field:${key}`)
    }
    const unknown = Object.keys(item).filter(key => key !== 'name' && key !== 'from')
    if (unknown.length) throw fail('human_mapping_invalid', `unknown_field:${unknown.sort()[0]}`)
    const name = readName(item.name, 'name')
    const from = readName(item.from, 'from')
    if (seenName.has(name)) throw fail('human_mapping_invalid', `duplicate_name:${name}`)
    // 两个输出指向同一个上游实例会让同一批文件被两条实例引用，
    // 而 OutputSet 明确禁止跨实例共享文件（m1-output-set.mjs:301-319）。
    if (seenFrom.has(from)) throw fail('human_mapping_invalid', `duplicate_from:${from}`)
    seenName.add(name)
    seenFrom.add(from)
    out.push(Object.freeze({ name, from }))
  }
  return Object.freeze(out)
}

// ---------------------------------------------------------------------------
// 上游集合
// ---------------------------------------------------------------------------

/**
 * 把已核验的上游 OutputSet 整理成「实例名 → 实例组」与「相对路径 → 清单项」。
 *
 * 文件只从清单取，不从实例自述取：实例里的 files 只是相对路径列表，
 * 真正的 hash / bytes / mediaType 由清单负责，必须一致才认。
 */
const requireSourceSet = (sourceSet) => {
  if (!isPlainObject(sourceSet)) throw fail('human_mapping_source_missing', 'source_set_required')
  const outputs = sourceSet.outputs
  if (!Array.isArray(outputs) || outputs.length === 0) throw fail('human_mapping_source_missing', 'source_outputs_required')
  const manifest = Array.isArray(sourceSet.files) ? sourceSet.files : []
  if (manifest.length === 0) throw fail('human_mapping_source_missing', 'source_files_required')

  const files = new Map()
  for (const entry of manifest) {
    if (!isPlainObject(entry) || typeof entry.relativePath !== 'string' || entry.relativePath === '') {
      throw fail('human_mapping_source_missing', 'source_file_entry_invalid')
    }
    if (typeof entry.hash !== 'string' || !Number.isSafeInteger(entry.bytes)) {
      throw fail('human_mapping_source_missing', `source_file_entry_incomplete:${entry.relativePath}`)
    }
    // mediaType 是集合摘要覆盖范围的一部分（output-set.mjs:325-335），缺了它连规范化都过不去。
    if (typeof entry.mediaType !== 'string' || entry.mediaType === '') {
      throw fail('human_mapping_source_missing', `source_file_media_type_required:${entry.relativePath}`)
    }
    if (files.has(entry.relativePath)) throw fail('human_mapping_source_missing', `source_file_duplicate:${entry.relativePath}`)
    files.set(entry.relativePath, Object.freeze({
      relativePath: entry.relativePath,
      hash: entry.hash,
      bytes: entry.bytes,
      mediaType: entry.mediaType,
    }))
  }

  const byName = new Map()
  for (const instance of outputs) {
    if (!isPlainObject(instance) || typeof instance.name !== 'string' || instance.name === '') {
      throw fail('human_mapping_source_missing', 'source_instance_invalid')
    }
    if (!byName.has(instance.name)) byName.set(instance.name, [])
    byName.get(instance.name).push(instance)
  }
  return { byName, files }
}

// ---------------------------------------------------------------------------
// 映射成完整集合
// ---------------------------------------------------------------------------

/**
 * 按映射把上游集合改写成人工节点的输出基准集合。
 *
 * 输出是 normalizeOutputSet 的规范化结果（含 digest），可直接当人工节点的原始基准内容：
 * 它的 outputs 用输出声明的名字，files 只含被映射到的文件，摘要由规范化重算。
 * 原上游快照不在这里出现，由内核保留作证据输入。
 *
 * 规则：
 * - inputMapping 缺省时按同名直连（输出声明 name 直接对照上游实例 name）。
 * - 映射必须覆盖全部输出声明，且不得有未声明的名字——映射不能凭空造输出。
 * - 类型 / schemaVersion 以「输出声明 == 上游实例」为准，任何一边不符都拒。
 * - multiplicity 为 one 时上游实例组必须恰好 1 个；many 则整组原样保留，各改名成一条。
 * - 上游 editable 明确为 false 时结果一定不可编辑；否则沿用输出声明的 editable。
 *   即上游未声明 editable 时不因未知而擅自放宽或收紧，权限仍以引用方声明为准。
 *
 * @param {{sourceSet?: unknown, outputs?: unknown, inputMapping?: unknown}} input
 *   sourceSet: 已核验的上游 OutputSet（含 outputs[] 与 files[]）；
 *   outputs: 人工节点的 outputs[] 冻结声明；
 *   inputMapping: 定义里的 node.inputMapping（可选）。
 * @returns 规范化后的 OutputSet：`{schemaVersion, outputs, files, digest}`
 */
export const mapHumanInputSet = ({ sourceSet, outputs, inputMapping } = {}) => {
  const declarations = validateOutputDeclarations(outputs)
  const mapping = validateHumanInputMapping(inputMapping)
  const source = requireSourceSet(sourceSet)

  // 未传映射时按同名直连：不做任何猜测，名字对不上就是映射缺失。
  const entries = mapping.length
    ? mapping
    : Object.freeze(declarations.map(declaration => Object.freeze({ name: declaration.name, from: declaration.name })))

  const declaredNames = new Set(declarations.map(declaration => declaration.name))
  const mappedNames = new Set(entries.map(entry => entry.name))
  const missing = declarations.filter(declaration => !mappedNames.has(declaration.name)).map(declaration => declaration.name)
  if (missing.length) throw fail('human_mapping_incomplete', missing.sort().join(','))
  const undeclared = entries.filter(entry => !declaredNames.has(entry.name)).map(entry => entry.name)
  if (undeclared.length) throw fail('human_mapping_undeclared', undeclared.sort().join(','))

  const instances = []
  const files = new Map()
  for (const declaration of declarations) {
    const entry = entries.find(item => item.name === declaration.name)
    const group = source.byName.get(entry.from)
    if (!group) throw fail('human_mapping_from_unknown', `${entry.name}:${entry.from}`)
    if (declaration.multiplicity === 'one' && group.length !== 1) {
      throw fail('human_mapping_count_invalid', `${entry.name}:expected_1_got_${group.length}`)
    }
    for (const instance of group) {
      if (instance.artifactType !== declaration.artifactType) {
        throw fail('human_mapping_type_mismatch', `${entry.name}:expected_${declaration.artifactType}_got_${instance.artifactType}`)
      }
      if (instance.schemaVersion !== declaration.schemaVersion) {
        throw fail('human_mapping_schema_mismatch', `${entry.name}:expected_${declaration.schemaVersion}_got_${instance.schemaVersion}`)
      }
      // 上游明确只读、而输出声明要求可编辑，是定义层面的矛盾：不能靠「结果保留只读」蒙过去
      // （用户会以为能改），也不能靠「提升成可编辑」越过上游（那是越权）。
      if (declaration.editable === true && instance.editable === false) {
        throw fail('human_mapping_editable_conflict', `${entry.name}:from_${entry.from}_readonly`)
      }
      const paths = Array.isArray(instance.files) ? instance.files : []
      if (paths.length === 0) throw fail('human_mapping_source_missing', `instance_files_required:${entry.from}`)
      const mappedFiles = []
      for (const relativePath of paths) {
        const file = source.files.get(relativePath)
        if (!file) throw fail('human_mapping_source_missing', `file_not_in_source:${relativePath}`)
        mappedFiles.push(file)
        files.set(file.relativePath, file)
      }
      instances.push({
        name: declaration.name,
        artifactType: declaration.artifactType,
        schemaVersion: declaration.schemaVersion,
        // 只压不放：上游明确只读时结果必须只读；上游未表态时以引用方声明为准。
        editable: declaration.editable === true && instance.editable !== false,
        multiplicity: declaration.multiplicity,
        files: mappedFiles.map(file => file.relativePath).sort(),
      })
    }
  }

  // 交给 OutputSet 规范化：排序、去重、双向覆盖校验与摘要重算都由既有实现负责，
  // 本模块不自行定义集合摘要。
  return normalizeOutputSet({
    instances,
    files: [...files.values()],
    declarations,
  })
}
