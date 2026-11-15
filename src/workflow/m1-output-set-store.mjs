// W1-10 产物集合（OutputSet）的对象存储层。
//
// 为什么单独成模块：规范化模块（m1-output-set.mjs）只判定「集合长什么样」，
// 不碰磁盘；而 02 §1（02-snapshot-versioning.md:15）要求快照清单带 blobs[]，
// 02:34 要求「多文件输出以 OutputSet 作为完整性边界，缺一文件不能半套采用」，
// 所以「字节怎么落、复用怎么判、读回怎么验」必须有独立一层，供内核候选存储、
// 人工确认、离线备份三处共用同一口径，避免各写一遍。
//
// 三条不可让步的边界：
// - **对象位置只由 hash 推导**（objects/<前两位>/<hash>），与内核 storeCandidate 的
//   对象库布局一致，因此本模块写下的对象后续可被内核直接复用。
//   清单里的 relativePath 是**集合内的逻辑文件名**，永远不参与定位；
//   任何由清单提供的对象路径（path/objectPath/absolutePath…）直接报错，而不是静默忽略——
//   静默忽略会造成「清单写着 A、实际用了 B」的认知差。
// - **拒绝符号链接**：从 objects 目录、两级前缀一直到对象文件，逐段 lstat 检查。
//   Windows 的 junction/挂载点同样按符号链接处理。root 自身允许是链接（调用方指定的
//   基准目录，先 realpath 再往里查），但其下任何一段都不允许。
// - **复用即校验**：命中已存在的对象必须回读、核对长度与内容地址；
//   内容地址对不上就不是「同一个对象」，报错而不是覆盖。
//
// 不替换现有文本摘要语义：单文件 text/markdown/json 候选仍走内核的 contentHash；
// 本模块的集合摘要来自规范化模块的 outputSetDigest，两者是两个函数。
// 本模块不建库、不改内核/服务/备份，只做「字节 ↔ 对象库」这一层。

import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import {
  fileBytesDigest,
  normalizeOutputSet,
  normalizeRelativePath,
  normalizeRelativePaths,
} from './m1-output-set.mjs'

/**
 * 存储层错误码（领域码，不进服务层冻结的 SERVICE_ERROR_CODES）。
 *
 * 结构类错误由规范化模块抛（output_path_invalid / output_file_invalid /
 * output_file_missing / output_file_orphan / output_file_shared 等），
 * 「内容不是字节」也沿用模块的 output_file_digest_input_invalid；
 * 这里只列「字节与对象库」这一层的失败。
 */
export const OUTPUT_SET_STORE_ERROR_CODES = Object.freeze([
  'output_object_hash_invalid',
  'output_object_root_invalid',
  'output_object_path_invalid',
  'output_object_link_not_allowed',
  'output_object_missing',
  'output_object_corrupt',
  'output_object_bytes_mismatch',
  'output_object_digest_mismatch',
  'output_object_content_missing',
  'output_object_content_unexpected',
  'output_object_write_failed',
  'output_set_digest_mismatch',
])

/** 对象库在 root 下的固定位置，与内核 createWorkflowKernel 的 mkdirSync(join(root,'objects')) 一致。 */
const OBJECTS_DIR = 'objects'

/**
 * 清单里出现这些字段即判坏：对象位置只能由 hash 推导。
 * 覆盖常见的「路径别名」，避免接入方以为换个字段名就能指到别处。
 */
const MANIFEST_PATH_FIELDS = Object.freeze(['path', 'objectPath', 'storagePath', 'absolutePath', 'realPath', 'fileUrl', 'blobPath'])

const DIGEST_PATTERN = /^[a-f0-9]{64}$/

const fail = (code, detail = code) => Object.assign(new Error(`${code}:${detail}`), { code, detail })

const lstatOrNull = (path) => {
  try { return lstatSync(path) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// ---------------------------------------------------------------------------
// 路径与目录
// ---------------------------------------------------------------------------

/** 校验内容地址形态，并返回字符串形式。对象位置只能从这里推导。 */
export const assertObjectDigest = (hash) => {
  if (typeof hash !== 'string' || !DIGEST_PATTERN.test(hash)) throw fail('output_object_hash_invalid', String(hash).slice(0, 64))
  return hash
}

/**
 * 对象在对象库中的相对键（不是文件系统路径）。
 * 固定形状 objects/<hash 前两位>/<hash>，与内核 manifest 的 blobs[].relativePath 同形。
 */
export const objectKeyFor = hash => `${OBJECTS_DIR}/${assertObjectDigest(hash).slice(0, 2)}/${hash}`

/**
 * 解析存储根目录。
 *
 * 从文件系统根逐段检查，包括 root 本身；拒绝符号链接和 junction。
 * 这是离线受控目录检查，不承诺抵御外部进程在检查后替换目录。
 */
const storeBase = (root, { create }) => {
  if (typeof root !== 'string' || root === '') throw fail('output_object_root_invalid', 'root_required')
  const resolved = resolve(root)
  const anchor = parse(resolved).root
  let current = anchor
  if (!requireDirectory(current, 'filesystem_root')) throw fail('output_object_root_invalid')
  for (const part of resolved.slice(anchor.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (create) ensureDirectory(current, 'root_ancestor')
    else if (!requireDirectory(current, 'root_ancestor')) throw fail('output_object_missing', 'root_missing')
  }
  return resolved
}

/** 目录存在且是真目录（非链接）返回 true；不存在返回 false；链接或其它类型直接抛错。 */
const requireDirectory = (path, detail) => {
  const entry = lstatOrNull(path)
  if (!entry) return false
  if (entry.isSymbolicLink()) throw fail('output_object_link_not_allowed', detail)
  if (!entry.isDirectory()) throw fail('output_object_path_invalid', detail)
  return true
}

/** 逐级建目录：每级都先查是不是链接，绝不用 recursive mkdir 从顶上一把建下去（那样会跟随链接）。 */
const ensureDirectory = (path, detail) => {
  if (requireDirectory(path, detail)) return
  try { mkdirSync(path) } catch (error) {
    if (error?.code !== 'EEXIST' || !requireDirectory(path, detail)) throw error
  }
}

/**
 * 定位一个对象。create=false 时缺目录按「对象缺失」报，而不是悄悄创建。
 * @returns {{key: string, file: string, dir: string}}
 */
const objectLocation = (base, hash, { create }) => {
  const key = objectKeyFor(hash)
  const objects = join(base, OBJECTS_DIR)
  const dir = join(objects, hash.slice(0, 2))
  if (create) {
    ensureDirectory(objects, 'objects')
    ensureDirectory(dir, `objects/${hash.slice(0, 2)}`)
  } else {
    if (!requireDirectory(objects, 'objects')) throw fail('output_object_missing', `${hash}:objects_missing`)
    if (!requireDirectory(dir, `objects/${hash.slice(0, 2)}`)) throw fail('output_object_missing', `${hash}:prefix_missing`)
  }
  return { key, file: join(dir, hash), dir }
}

/** 对象文件必须是真文件：链接、目录、设备节点全部拒绝。 */
const assertPlainFile = (path, hash) => {
  const entry = lstatOrNull(path)
  if (!entry) throw fail('output_object_missing', hash)
  if (entry.isSymbolicLink()) throw fail('output_object_link_not_allowed', `${hash}:object`)
  if (!entry.isFile()) throw fail('output_object_path_invalid', `${hash}:not_a_file`)
  return entry
}

// ---------------------------------------------------------------------------
// 单个对象
// ---------------------------------------------------------------------------

/**
 * 回读并验证一个对象。
 *
 * 判定顺序刻意这样排：先看「磁盘内容是否等于它的内容地址（路径里的 hash）」，
 * 再看「长度是否等于清单声明」。否则清单 bytes 写错时会被误报成对象损坏。
 *
 * @param {string} base storeBase 的返回值
 * @param {string} hash 内容地址
 * @param {number | null} expectedBytes 清单声明的字节数；null 表示调用方没有清单。
 * @returns {Buffer}
 */
const readObjectAt = (base, hash, expectedBytes = null) => {
  const { file } = objectLocation(base, hash, { create: false })
  const entry = assertPlainFile(file, hash)
  const data = readFileSync(file)
  if (data.length !== entry.size) throw fail('output_object_corrupt', `${hash}:size_changed_during_read`)
  if (fileBytesDigest(data) !== hash) throw fail('output_object_corrupt', `${hash}:content_address_mismatch`)
  if (expectedBytes !== null && expectedBytes !== undefined && data.length !== expectedBytes) {
    throw fail('output_object_bytes_mismatch', `${hash}:declared_${expectedBytes}_actual_${data.length}`)
  }
  return data
}

/** 对象是否存在且是真文件（不做内容校验；要内容校验用 readObjectAt）。 */
export const hasOutputObject = ({ root, hash }) => {
  const base = storeBase(root, { create: false })
  let location
  try { location = objectLocation(base, assertObjectDigest(hash), { create: false }) } catch (error) {
    // 目录都不存在时「没有这个对象」是正常答案，不是错误。
    if (error?.code === 'output_object_missing') return false
    throw error
  }
  const entry = lstatOrNull(location.file)
  if (!entry) return false
  if (entry.isSymbolicLink()) throw fail('output_object_link_not_allowed', `${hash}:object`)
  return entry.isFile()
}

/**
 * 按字节摘要保存一个对象：同一 hash 只存一份；命中已存在对象必须校验通过才复用。
 *
 * 独占临时文件写入并 fsync 后，用硬链接不覆盖地发布完整对象。
 * EEXIST 必须回读验证；不支持硬链接时明确失败，不回退覆盖式 rename。
 *
 * @returns {{hash: string, key: string, bytes: number, reused: boolean}}
 */
export const putOutputObject = ({ root, bytes }) => {
  const base = storeBase(root, { create: true })
  if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw fail('output_file_digest_input_invalid', 'bytes_invalid')
  }
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const hash = fileBytesDigest(data)
  const location = objectLocation(base, hash, { create: true })
  const existing = lstatOrNull(location.file)
  if (existing) {
    assertPlainFile(location.file, hash)
    // 复用前必须校验：内容地址对不上说明对象库被改过，不能当作「已有同一份」。
    readObjectAt(base, hash, null)
    return { hash, key: location.key, bytes: data.length, reused: true }
  }
  const temp = join(location.dir, `.${hash}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`)
  let descriptor = null
  let ownedTemp = false
  try {
    descriptor = openSync(temp, 'wx', 0o600)
    ownedTemp = true
    writeFileSync(descriptor, data)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    try { linkSync(temp, location.file) } catch (error) {
      if (error?.code !== 'EEXIST') throw fail('output_object_write_failed', `no_replace_publish:${error?.code ?? 'unknown'}`)
      readObjectAt(base, hash, data.length)
      return { hash, key: location.key, bytes: data.length, reused: true }
    }
    readObjectAt(base, hash, data.length)
    return { hash, key: location.key, bytes: data.length, reused: false }
  } finally {
    if (descriptor !== null) { try { closeSync(descriptor) } catch {} }
    if (ownedTemp) { try { unlinkSync(temp) } catch {} }
  }
}

/**
 * 读取一个对象并按需校验长度。
 * @returns {Buffer}
 */
export const readOutputObject = ({ root, hash, bytes = null }) => {
  const base = storeBase(root, { create: false })
  const digest = assertObjectDigest(hash)
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0)) throw fail('output_object_bytes_mismatch', 'declared_bytes_invalid')
  return readObjectAt(base, digest, bytes)
}

// ---------------------------------------------------------------------------
// 集合的写入与读取
// ---------------------------------------------------------------------------

/** 清单里不允许自带对象路径：位置只能由 hash 推导。 */
export const assertNoInjectedObjectPaths = (files) => {
  if (!Array.isArray(files)) return // 结构错误交给规范化模块报，这里不抢它的判断
  for (const item of files) {
    if (!isPlainObject(item)) continue
    for (const field of MANIFEST_PATH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(item, field)) throw fail('output_object_path_invalid', `manifest_supplied_${field}`)
    }
  }
}

/**
 * 逐文件读取阶段唯一允许降级成「这个文件没读到」的失败。
 * 链接、存储根、内容地址形态、以及对象库目录/前缀目录的结构问题都不在此列，
 * 必须继续向上抛：把它们记成「某文件缺失」会掩盖被改过的对象库。
 */
const PER_FILE_OBJECT_ERRORS = Object.freeze([
  'output_object_missing',
  'output_object_corrupt',
  'output_object_bytes_mismatch',
  'output_object_path_invalid',
])

const isPerFileObjectError = (error) => {
  const code = error?.code
  if (!PER_FILE_OBJECT_ERRORS.includes(code)) return false
  const detail = String(error?.detail ?? '')
  // 对象库目录或其前缀目录不是目录：对象库级结构异常，不是「这个文件坏了」。
  if (code === 'output_object_path_invalid' && (detail === OBJECTS_DIR || /^objects\/[0-9a-f]{2}$/.test(detail))) return false
  return true
}

const toBytes = (value, path) => {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw fail('output_file_digest_input_invalid', `${path}:content_not_bytes`)
}

/**
 * 随附内容归一化：键按规范化模块的路径口径处理（含大小写折叠与文件/目录冲突检查），
 * 重复键直接报错而不是后者覆盖前者——静默覆盖会丢文件却仍算出合法的集合摘要。
 */
const normalizeContents = (contents) => {
  if (contents === null || contents === undefined) return new Map()
  const pairs = contents instanceof Map
    ? [...contents]
    : isPlainObject(contents) ? Object.entries(contents) : null
  if (!pairs) throw fail('output_object_content_unexpected', 'contents_shape')
  const map = new Map()
  for (const [key, value] of pairs) {
    const path = normalizeRelativePath(key)
    if (map.has(path)) throw fail('output_object_content_unexpected', `duplicate_content:${path}`)
    map.set(path, toBytes(value, path))
  }
  normalizeRelativePaths([...map.keys()])
  return map
}

/**
 * 写入一整组产物。
 *
 * @param {object} input
 * @param {string} input.root 存储根（与内核 root 相同）
 * @param {unknown} input.instances 具名输出实例
 * @param {unknown} input.files 文件清单 [{relativePath, hash, bytes, mediaType}]
 * @param {unknown} [input.declarations] 节点 outputs[] 声明；给了就做声明↔实例一一对应
 * @param {Map<string,string|Buffer>|object|null} [input.contents] relativePath → 字节；缺项只允许复用已有对象
 * @returns {{set: object, written: object[], reused: object[], blobs: object[]}}
 *
 * blobs 是**对象层**视图（按内容地址去重，可直接进 manifest.blobs），
 * set.files 是**逻辑文件层**视图（同一内容被两个名字引用时出现两次）。两者不要混用。
 */
export const writeOutputSet = ({ root, instances, files, declarations = null, contents = null }) => {
  const base = storeBase(root, { create: true })
  assertNoInjectedObjectPaths(files)
  const set = normalizeOutputSet({ instances, files, declarations })
  const supplied = normalizeContents(contents)
  const known = new Set(set.files.map(file => file.relativePath))
  for (const path of supplied.keys()) {
    if (!known.has(path)) throw fail('output_object_content_unexpected', path)
  }
  // Validate the entire set before creating any object. Failure during actual
  // I/O may still leave unreferenced objects; no manifest/adoption is published here.
  for (const file of set.files) {
    if (supplied.has(file.relativePath)) {
      const data = supplied.get(file.relativePath)
      if (fileBytesDigest(data) !== file.hash) throw fail('output_object_digest_mismatch', file.relativePath)
      if (data.length !== file.bytes) throw fail('output_object_bytes_mismatch', file.relativePath)
    } else {
      try { readObjectAt(base, file.hash, file.bytes) } catch (error) {
        if (error?.code === 'output_object_missing') throw fail('output_object_content_missing', file.relativePath)
        throw error
      }
    }
  }
  const written = []
  const reused = []
  for (const file of set.files) {
    const data = supplied.get(file.relativePath)
    if (!data) {
      // 没有随附内容：该文件必须已经有可用对象，否则就是「缺一文件」，不能半套写入。
      let entry = null
      try { entry = objectLocation(base, file.hash, { create: false }) } catch (error) {
        if (error?.code !== 'output_object_missing') throw error
      }
      if (!entry || !lstatOrNull(entry.file)) throw fail('output_object_content_missing', file.relativePath)
      readObjectAt(base, file.hash, file.bytes)
      reused.push({ relativePath: file.relativePath, hash: file.hash, bytes: file.bytes, key: entry.key })
      continue
    }
    const digest = fileBytesDigest(data)
    if (digest !== file.hash) throw fail('output_object_digest_mismatch', `${file.relativePath}:declared_${file.hash}_actual_${digest}`)
    if (data.length !== file.bytes) throw fail('output_object_bytes_mismatch', `${file.relativePath}:declared_${file.bytes}_actual_${data.length}`)
    const result = putOutputObject({ root: base, bytes: data })
    const record = { relativePath: file.relativePath, hash: result.hash, bytes: result.bytes, key: result.key }
    if (result.reused) reused.push(record)
    else written.push(record)
  }
  return { set, written, reused, blobs: blobsOf(base, set) }
}

/**
 * 对象层清单：按 hash 去重、按对象键排序，形状对齐 02:15 的 blobs[]。
 * 同一内容被多个逻辑文件名引用时只出现一次——这是「对象」而不是「文件」。
 */
const blobsOf = (base, set) => {
  const byHash = new Map()
  for (const file of set.files) {
    if (byHash.has(file.hash)) continue
    byHash.set(file.hash, { relativePath: objectKeyFor(file.hash), hash: file.hash, bytes: file.bytes, mediaType: file.mediaType })
  }
  return [...byHash.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

/**
 * 读取并校验一整组产物。
 *
 * 逐项核对：对象存在、不是链接、磁盘内容等于内容地址、长度等于清单声明；
 * 传入的集合若自带 digest，还必须等于重算结果（否则说明清单被改过但结构仍合法）。
 *
 * @returns {{set: object, digest: string, files: object[], singleFile: boolean}}
 */
const readSetAt = (base, { set, declarations = null }, { includeBytes }) => {
  if (!isPlainObject(set)) throw fail('output_object_path_invalid', 'set_required')
  assertNoInjectedObjectPaths(set.files)
  const normalized = normalizeOutputSet({ instances: set.outputs, files: set.files, declarations })
  if (set.digest !== undefined && set.digest !== normalized.digest) {
    throw fail('output_set_digest_mismatch', `declared_${set.digest}_actual_${normalized.digest}`)
  }
  const files = normalized.files.map((file) => {
    const data = readObjectAt(base, file.hash, file.bytes)
    return includeBytes
      ? { relativePath: file.relativePath, hash: file.hash, bytes: file.bytes, mediaType: file.mediaType, data }
      : { relativePath: file.relativePath, hash: file.hash, bytes: file.bytes, mediaType: file.mediaType }
  })
  return { set: normalized, digest: normalized.digest, files, singleFile: normalized.files.length === 1 }
}

/** 只读：校验整组产物，不返回字节。 */
export const verifyOutputSet = ({ root, set, declarations = null }) => {
  const base = storeBase(root, { create: false })
  return readSetAt(base, { set, declarations }, { includeBytes: false })
}

/** 只读：校验整组产物并返回每个文件的字节（data 为 Buffer）。 */
export const readOutputSet = ({ root, set, declarations = null }) => {
  const base = storeBase(root, { create: false })
  return readSetAt(base, { set, declarations }, { includeBytes: true })
}

/**
 * 只读：结构先严格校验，再逐文件尝试读取，把缺失/损坏分开列出。
 *
 * 为什么需要它：`readOutputSet` 遇到第一个缺失对象就抛，调用方拿不到
 * 「哪些文件读到了、哪些没有」，也就无法对一份结构合法但对象不全的集合
 * 给出逐文件的真实结论（例如人工草稿的文件摘要检查要判 fail 并列出路径，
 * 而内容检查只能停在未评估）。
 *
 * 两类失败严格分开，绝不混用：
 * - **结构、声明、集合摘要、清单自带对象路径** → 直接抛，不进入逐文件阶段。
 *   这类问题不是「某个文件缺了」，降级成 per-file 结果会得到错误结论。
 *   对象库目录本身不是目录（前缀目录层级异常）也按存储根级异常抛出。
 * - **单个对象缺失 / 内容地址不符 / 长度不符** → 只记进 `files[]` 与
 *   `missing`/`corrupt`，不当错误吞掉。符号链接仍然直接抛（安全边界不降级）。
 *
 * 不伪造摘要：`digest` 是 normalizeOutputSet 的重算值；清单自带 digest 与它
 * 不一致时在读取任何对象之前抛 output_set_digest_mismatch。
 *
 * @param {object} input
 * @param {string} input.root 存储根（与内核 root 相同）
 * @param {object} input.set 集合清单 {outputs, files, digest?}
 * @param {unknown} [input.declarations] 节点 outputs[] 声明；给了就做声明↔实例对应
 * @returns {{
 *   set: object, digest: string, singleFile: boolean, ok: boolean,
 *   contents: Map<string, Buffer>,
 *   files: Array<{relativePath: string, hash: string, bytes: number, mediaType: string,
 *     data: Buffer|null, state: 'read'|'missing'|'corrupt', code: string|null, detail: string|null}>,
 *   missing: object[], corrupt: object[]
 * }}
 */
export const readOutputSetTolerant = ({ root, set, declarations = null }) => {
  const base = storeBase(root, { create: false })
  if (!isPlainObject(set)) throw fail('output_object_path_invalid', 'set_required')
  assertNoInjectedObjectPaths(set.files)
  const normalized = normalizeOutputSet({ instances: set.outputs, files: set.files, declarations })
  if (set.digest !== undefined && set.digest !== normalized.digest) {
    throw fail('output_set_digest_mismatch', `declared_${set.digest}_actual_${normalized.digest}`)
  }
  // 同一内容被多个逻辑文件名引用时只读一次；失败也按 hash 复用，但逐文件记录。
  const byHash = new Map()
  const contents = new Map()
  const files = normalized.files.map((file) => {
    let cached = byHash.get(file.hash)
    if (!cached) {
      try {
        cached = { data: readObjectAt(base, file.hash, file.bytes) }
      } catch (error) {
        if (!isPerFileObjectError(error)) throw error
        cached = { code: error.code, detail: error.detail ?? null }
      }
      byHash.set(file.hash, cached)
    }
    const record = { relativePath: file.relativePath, hash: file.hash, bytes: file.bytes, mediaType: file.mediaType }
    if ('data' in cached) {
      contents.set(file.relativePath, cached.data)
      return { ...record, data: cached.data, state: 'read', code: null, detail: null }
    }
    return {
      ...record, data: null,
      state: cached.code === 'output_object_missing' ? 'missing' : 'corrupt',
      code: cached.code, detail: cached.detail,
    }
  })
  const missing = files.filter(file => file.state === 'missing')
  const corrupt = files.filter(file => file.state === 'corrupt')
  return {
    set: normalized,
    digest: normalized.digest,
    singleFile: normalized.files.length === 1,
    ok: missing.length === 0 && corrupt.length === 0,
    contents,
    files,
    missing,
    corrupt,
  }
}

// ---------------------------------------------------------------------------
// 绑定到一个 root 的便捷句柄
// ---------------------------------------------------------------------------

/**
 * 绑定存储根的句柄，供内核 / 人工确认 / 备份校验按同一 root 反复调用。
 * root 在创建时就解析（写路径会建目录），之后每次调用仍逐段检查链接。
 */
export const createOutputSetStore = ({ root } = {}) => {
  const base = storeBase(root, { create: true })
  return Object.freeze({
    root: base,
    objectKey: objectKeyFor,
    hasObject: hash => hasOutputObject({ root: base, hash }),
    putBytes: bytes => putOutputObject({ root: base, bytes }),
    readObject: ({ hash, bytes = null }) => readOutputObject({ root: base, hash, bytes }),
    writeSet: input => writeOutputSet({ ...input, root: base }),
    readSet: input => readOutputSet({ ...input, root: base }),
    readSetTolerant: input => readOutputSetTolerant({ ...input, root: base }),
    verifySet: input => verifyOutputSet({ ...input, root: base }),
  })
}
