import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import sharp from 'sharp'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 64_000_000
const MAX_JOBS = 200
const MAX_STORAGE_BYTES = 512 * 1024 * 1024
const MAX_JSON_BYTES = 64 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const ID = /^[a-f0-9]{32}$/
const HASH = /^[a-f0-9]{64}$/
const TYPES = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' })
const EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })
const writers = new Map()
const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value) + '\n'
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))

function inside(root, path) {
  const name = relative(root, path)
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep))
}

function directory(root, path, create = false) {
  if (!inside(root, path)) fail('image_v2_storage_unsafe')
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory() || !inside(root, realpathSync(path))) fail('image_v2_storage_unsafe')
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
    if (!create) return false
    mkdirSync(path)
    return directory(root, path)
  }
  return true
}

function fileInfo(root, path, maxBytes) {
  if (!inside(root, path)) fail('image_v2_storage_unsafe')
  let info
  try { info = lstatSync(path) } catch (cause) { if (cause.code === 'ENOENT') fail('image_v2_not_found'); throw cause }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !inside(root, realpathSync(path))) fail('image_v2_storage_unsafe')
  if (info.size < 1 || info.size > maxBytes) fail('image_v2_storage_limit')
  return info
}

function readBytes(root, path, maxBytes) {
  const info = fileInfo(root, path, maxBytes)
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) fail('image_v2_storage_unsafe')
    const data = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset)
      if (!count) fail('image_v2_integrity_invalid')
      offset += count
    }
    const after = fstatSync(fd)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail('image_v2_integrity_invalid')
    return data
  } finally { if (fd !== undefined) closeSync(fd) }
}

function readJson(context, path) {
  try { return JSON.parse(readBytes(context.root, path, MAX_JSON_BYTES).toString('utf8')) }
  catch (cause) { if (String(cause?.message ?? '').startsWith('image_v2_')) throw cause; fail('image_v2_integrity_invalid') }
}

function writeExclusive(context, path, contents) {
  context.check()
  if (!inside(context.root, path)) fail('image_v2_storage_unsafe')
  let fd
  try { fd = openSync(path, 'wx', 0o600); writeFileSync(fd, contents); fsyncSync(fd) }
  finally { if (fd !== undefined) closeSync(fd) }
}

function writeJson(context, path, value, exclusive = false) {
  const bytes = Buffer.from(json(value))
  if (bytes.length > MAX_JSON_BYTES) fail('image_v2_storage_limit')
  if (exclusive) { writeExclusive(context, path, bytes); return }
  try { fileInfo(context.root, path, MAX_JSON_BYTES) } catch (cause) { if (cause.code !== 'image_v2_not_found') throw cause }
  const pending = join(context.root, '.pending-' + randomUUID() + '.json')
  try { writeExclusive(context, pending, bytes); context.check(); renameSync(pending, path) }
  finally { try { unlinkSync(pending) } catch (cause) { if (cause.code !== 'ENOENT') throw cause } }
}

function safeFileName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f]/.test(value)) fail('image_v2_file_name_invalid')
  const leaf = value.trim().split(/[\\/]/).at(-1).replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 180)
  if (!leaf || leaf === '.' || leaf === '..') fail('image_v2_file_name_invalid')
  return leaf
}

function contextOf({ workspaceRoot, productId, externalUsage = () => ({ jobs: 0, count: 0, bytes: 0 }) }) {
  if (typeof productId !== 'string' || !productId || productId.length > 200 || /[\x00-\x1f]/.test(productId)) fail('image_v2_product_invalid')
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot) || typeof externalUsage !== 'function') fail('image_v2_workspace_invalid')
  let workspace
  try { workspace = realpathSync(workspaceRoot); if (!statSync(workspace).isDirectory()) fail('image_v2_workspace_invalid') }
  catch { fail('image_v2_workspace_invalid') }
  const workbench = join(workspace, '.dsh-workbench'), parent = join(workbench, 'product-images-v2')
  const root = join(parent, hash(productId).slice(0, 32))
  const paths = [workbench, parent, root, join(root, 'operations'), join(root, 'candidates'), join(root, 'metadata')]
  const context = { workspace, root, productId, externalUsage, operations: paths[3], candidates: paths[4], metadata: paths[5] }
  context.exists = () => {
    if (realpathSync(workspaceRoot) !== workspace) fail('image_v2_storage_unsafe')
    for (const path of paths.slice(0, 3)) if (!directory(workspace, path)) return false
    for (const path of paths.slice(3)) if (!directory(workspace, path)) fail('image_v2_integrity_invalid')
    return true
  }
  context.check = () => { if (!context.exists()) fail('image_v2_storage_unsafe') }
  context.initialize = () => { for (const path of paths) directory(workspace, path, true); context.check() }
  return context
}

function normalizeInput({ requestId, data, mime, fileName, signal } = {}) {
  if (!UUID.test(requestId ?? '')) fail('image_v2_request_id_invalid')
  if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_IMAGE_BYTES || !EXTENSIONS[mime]) fail('image_v2_input_invalid')
  if (signal?.aborted) fail('image_v2_operation_cancelled')
  const bytes = Buffer.from(data), input = { fileName: safeFileName(fileName), sha256: hash(bytes), mime, bytes: bytes.length }
  return { id: requestId.toLowerCase(), bytes, input, requestHash: hash(json(input)), signal }
}

function readOperation(context, id) {
  if (!UUID.test(id ?? '') || id !== id.toLowerCase()) fail('image_v2_request_id_invalid')
  const value = readJson(context, join(context.operations, id + '.json'))
  const keys = ['schemaVersion', 'id', 'productId', 'kind', 'status', 'createdAt', 'input', 'requestHash', 'outputs']
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key) && key !== 'error') || keys.some(key => !Object.hasOwn(value, key))
    || value.schemaVersion !== 2 || value.id !== id || value.productId !== context.productId || value.kind !== 'import'
    || !['running', 'succeeded', 'failed', 'unknown'].includes(value.status) || !validDate(value.createdAt)
    || !exact(value.input, ['fileName', 'sha256', 'mime', 'bytes']) || safeFileName(value.input.fileName) !== value.input.fileName
    || !HASH.test(value.input.sha256 ?? '') || !EXTENSIONS[value.input.mime] || !Number.isSafeInteger(value.input.bytes) || value.input.bytes < 1 || value.input.bytes > MAX_IMAGE_BYTES
    || !HASH.test(value.requestHash ?? '') || value.requestHash !== hash(json(value.input))
    || !Array.isArray(value.outputs) || value.outputs.length > 1 || value.outputs.some(id => !ID.test(id ?? ''))
    || value.status === 'succeeded' && value.outputs.length !== 1
    || value.error !== undefined && !/^image_v2_[a-z0-9_]+$/.test(value.error)) fail('image_v2_integrity_invalid')
  return value
}

function visibleOperation(context, operation) {
  const status = operation.status === 'running' && writers.get(context.root)?.id !== operation.id ? 'unknown' : operation.status
  return { id: operation.id, kind: operation.kind, status, createdAt: operation.createdAt, outputs: [...operation.outputs],
    ...(status === 'unknown' ? { error: 'image_v2_import_interrupted_unknown' } : operation.error ? { error: operation.error } : {}) }
}

function manifestEntry(context, id) {
  if (!ID.test(id ?? '')) fail('image_v2_candidate_invalid')
  const folder = join(context.candidates, id)
  if (!directory(context.root, folder)) fail('image_v2_not_found')
  const manifestPath = join(folder, 'manifest.json'), manifest = readJson(context, manifestPath)
  if (!exact(manifest, ['schemaVersion', 'id', 'productId', 'operationId', 'operationKind', 'createdAt', 'file', 'source', 'parents'])
    || manifest.schemaVersion !== 2 || manifest.id !== id || manifest.productId !== context.productId || manifest.operationKind !== 'import'
    || !UUID.test(manifest.operationId ?? '') || !validDate(manifest.createdAt)
    || !exact(manifest.file, ['role', 'name', 'mime', 'bytes', 'width', 'height', 'sha256']) || manifest.file.role !== 'original'
    || !EXTENSIONS[manifest.file.mime] || manifest.file.name !== 'original.' + EXTENSIONS[manifest.file.mime]
    || !Number.isSafeInteger(manifest.file.bytes) || manifest.file.bytes < 1 || manifest.file.bytes > MAX_IMAGE_BYTES
    || !Number.isSafeInteger(manifest.file.width) || manifest.file.width < 1 || !Number.isSafeInteger(manifest.file.height) || manifest.file.height < 1
    || manifest.file.width * manifest.file.height > MAX_PIXELS || !HASH.test(manifest.file.sha256 ?? '')
    || !exact(manifest.source, ['kind', 'fileName', 'capturedAt', 'inputSha256']) || manifest.source.kind !== 'local-import'
    || safeFileName(manifest.source.fileName) !== manifest.source.fileName || !validDate(manifest.source.capturedAt)
    || manifest.source.inputSha256 !== manifest.file.sha256 || !Array.isArray(manifest.parents) || manifest.parents.length !== 0) fail('image_v2_integrity_invalid')
  const { id: storedId, ...descriptor } = manifest
  if (hash(json(descriptor)).slice(0, 32) !== id) fail('image_v2_integrity_invalid')
  const operation = readOperation(context, manifest.operationId)
  if (!operation.outputs.includes(id) || operation.input.sha256 !== manifest.file.sha256 || operation.input.fileName !== manifest.source.fileName
    || operation.input.mime !== manifest.file.mime || operation.input.bytes !== manifest.file.bytes) fail('image_v2_integrity_invalid')
  const entries = readdirSync(folder).sort()
  if (json(entries) !== json(['manifest.json', manifest.file.name].sort())) fail('image_v2_integrity_invalid')
  const path = join(folder, manifest.file.name), original = fileInfo(context.root, path, MAX_IMAGE_BYTES)
  const manifestStat = fileInfo(context.root, manifestPath, MAX_JSON_BYTES)
  if (original.size !== manifest.file.bytes) fail('image_v2_integrity_invalid')
  const candidate = { id, formatVersion: 2, mode: 'import', prompt: manifest.source.fileName, operationKind: manifest.operationKind,
    operationId: manifest.operationId, createdAt: manifest.createdAt, source: manifest.source, parents: manifest.parents,
    ...Object.fromEntries(['mime', 'bytes', 'width', 'height', 'sha256'].map(key => [key, manifest.file[key]])) }
  return { manifest, operation, path, candidate, usageBytes: original.size + manifestStat.size }
}

function emptyMetadata(context, candidateId, sha256) {
  return { formatVersion: 2, productId: context.productId, candidateId, fileSha256: sha256, tags: [], notes: '', checks: [] }
}

function readMetadata(context, id, sha256) {
  let value
  try { value = readJson(context, join(context.metadata, id + '.json')) }
  catch (cause) { if (cause.code === 'image_v2_not_found') return emptyMetadata(context, id, sha256); throw cause }
  if (!exact(value, ['formatVersion', 'productId', 'candidateId', 'fileSha256', 'tags', 'notes', 'checks']) || value.formatVersion !== 2
    || value.productId !== context.productId || value.candidateId !== id || value.fileSha256 !== sha256
    || !Array.isArray(value.tags) || value.tags.length > 50 || value.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag !== tag.trim() || tag.length > 80 || /[\x00-\x1f]/.test(tag))
    || new Set(value.tags).size !== value.tags.length || typeof value.notes !== 'string' || value.notes.length > 4000 || value.notes.includes('\x00')
    || !Array.isArray(value.checks) || value.checks.length > 1) fail('image_v2_metadata_invalid')
  if (value.checks.length) {
    const report = value.checks[0]
    if (!exact(report, ['sha256', 'status', 'hasAlpha', 'hasTransparentPixels', 'width', 'height', 'mime', 'bytes', 'visualStatus'])
      || report.sha256 !== sha256 || report.status !== 'pass' || typeof report.hasAlpha !== 'boolean' || typeof report.hasTransparentPixels !== 'boolean'
      || !Number.isSafeInteger(report.width) || report.width < 1 || !Number.isSafeInteger(report.height) || report.height < 1
      || report.width * report.height > MAX_PIXELS || !EXTENSIONS[report.mime] || !Number.isSafeInteger(report.bytes) || report.bytes < 1 || report.bytes > MAX_IMAGE_BYTES
      || report.visualStatus !== 'not-evaluated') fail('image_v2_metadata_invalid')
  }
  return value
}

function selectionIds(context) {
  let value
  try { value = readJson(context, join(context.root, 'selection.json')) }
  catch (cause) { if (cause.code === 'image_v2_not_found') return []; throw cause }
  if (!exact(value, ['schemaVersion', 'productId', 'ids']) || value.schemaVersion !== 2 || value.productId !== context.productId
    || !Array.isArray(value.ids) || value.ids.length > MAX_JOBS || value.ids.some(id => !ID.test(id ?? '')) || new Set(value.ids).size !== value.ids.length) fail('image_v2_integrity_invalid')
  return value.ids
}

function scan(context) {
  if (!context.exists()) return { entries: [], operations: [], selected: [], usage: { jobs: 0, count: 0, bytes: 0 }, warnings: [] }
  const warnings = [], entries = [], operations = []
  let bytes = 0, count = 0
  for (const name of readdirSync(context.root)) {
    if (['operations', 'candidates', 'metadata', 'selection.json'].includes(name)) continue
    if (/^\.pending-[a-f0-9-]{36}\.json$/.test(name)) { fileInfo(context.root, join(context.root, name), MAX_JSON_BYTES); warnings.push('image_v2_storage_interrupted'); continue }
    fail('image_v2_storage_unsafe')
  }
  for (const name of readdirSync(context.operations)) {
    if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) fail('image_v2_storage_unsafe')
    operations.push(readOperation(context, name.slice(0, -5)))
  }
  for (const name of readdirSync(context.candidates)) {
    if (/^\.pending-[a-f0-9-]{36}$/.test(name)) {
      const folder = join(context.candidates, name)
      if (!directory(context.root, folder)) fail('image_v2_storage_unsafe')
      for (const file of readdirSync(folder)) {
        if (!['manifest.json', 'original.png', 'original.jpg', 'original.webp'].includes(file)) fail('image_v2_storage_unsafe')
        bytes += fileInfo(context.root, join(folder, file), file === 'manifest.json' ? MAX_JSON_BYTES : MAX_IMAGE_BYTES).size
      }
      count++
      if (writers.get(context.root)?.id !== name.slice('.pending-'.length)) warnings.push('image_v2_storage_interrupted')
      continue
    }
    const entry = manifestEntry(context, name)
    entries.push(entry); bytes += entry.usageBytes; count++
  }
  const byId = new Map(entries.map(entry => [entry.candidate.id, entry]))
  for (const operation of operations) {
    if (operation.status === 'succeeded' && !byId.has(operation.outputs[0])) fail('image_v2_integrity_invalid')
    if (visibleOperation(context, operation).status === 'unknown') warnings.push('image_v2_import_interrupted_unknown')
  }
  for (const name of readdirSync(context.metadata)) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : ''
    if (!ID.test(id) || !byId.has(id)) fail('image_v2_storage_unsafe')
    fileInfo(context.root, join(context.metadata, name), MAX_JSON_BYTES)
    readMetadata(context, id, byId.get(id).candidate.sha256)
  }
  const selected = selectionIds(context)
  if (selected.some(id => !byId.has(id))) fail('image_v2_integrity_invalid')
  if (operations.length > MAX_JOBS || count > MAX_JOBS || bytes > MAX_STORAGE_BYTES) fail('image_v2_storage_limit')
  context.check()
  return { entries, operations, selected, usage: { jobs: operations.length, count, bytes }, warnings: [...new Set(warnings)] }
}

function admit(context, store, extraJobs, extraCount, extraBytes) {
  if (store.warnings.some(warning => warning.startsWith('image_v2_storage_interrupted'))) fail('image_v2_storage_interrupted')
  const usage = context.externalUsage()
  if (!plain(usage) || ['jobs', 'count', 'bytes'].some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0)) fail('image_v2_usage_invalid')
  if (usage.jobs + store.usage.jobs + extraJobs > MAX_JOBS || usage.count + store.usage.count + extraCount > MAX_JOBS
    || usage.bytes + store.usage.bytes + extraBytes > MAX_STORAGE_BYTES) fail('image_v2_storage_limit')
}

async function inspect(data, claimedMime) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_IMAGE_BYTES) fail('image_v2_image_invalid')
  let metadata, statistics
  try { metadata = await sharp(data, { animated: true, limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata() }
  catch { fail('image_v2_image_invalid') }
  const mime = TYPES[metadata.format]
  if (!mime || mime !== claimedMime || (metadata.pages ?? 1) !== 1 || !Number.isSafeInteger(metadata.width) || metadata.width < 1
    || !Number.isSafeInteger(metadata.height) || metadata.height < 1 || metadata.width * metadata.height > MAX_PIXELS) fail('image_v2_image_invalid')
  if (metadata.format === 'png') {
    for (let cursor = 8; cursor + 12 <= data.length;) {
      const length = data.readUInt32BE(cursor)
      if (length > data.length - cursor - 12) fail('image_v2_image_invalid')
      const type = data.toString('ascii', cursor + 4, cursor + 8)
      if (type === 'acTL') fail('image_v2_image_invalid')
      if (type === 'IEND') break
      cursor += length + 12
    }
  }
  try { statistics = await sharp(data, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).stats() }
  catch { fail('image_v2_image_invalid') }
  return { mime, width: metadata.width, height: metadata.height, bytes: data.length, sha256: hash(data), hasAlpha: metadata.hasAlpha === true,
    hasTransparentPixels: metadata.hasAlpha === true && statistics.isOpaque === false }
}

async function verifyImage(context, id) {
  const entry = manifestEntry(context, id), data = readBytes(context.root, entry.path, MAX_IMAGE_BYTES), inspected = await inspect(data, entry.candidate.mime)
  if (['sha256', 'bytes', 'width', 'height', 'mime'].some(key => inspected[key] !== entry.candidate[key])) fail('image_v2_integrity_invalid')
  context.check()
  return { ...entry, data, inspected }
}

async function withWrite(context, id, operation) {
  if (writers.has(context.root)) fail('image_v2_storage_busy')
  const token = { id }
  writers.set(context.root, token)
  try { return await operation() }
  finally { if (writers.get(context.root) === token) writers.delete(context.root) }
}

/** v2 import store. It has its own candidates, operation history and selection file. */
export function createProductImageV2Store(options) {
  const context = contextOf(options)
  const candidateView = (entry, selected = selectionIds(context)) => ({ ...entry.candidate, selected: selected.includes(entry.candidate.id),
    operation: visibleOperation(context, entry.operation), metadata: readMetadata(context, entry.candidate.id, entry.candidate.sha256) })
  const operationView = operation => visibleOperation(context, operation)
  const findOperation = id => {
    if (!context.exists()) return undefined
    try { return readOperation(context, id) } catch (cause) { if (cause.code === 'image_v2_not_found') return undefined; throw cause }
  }
  const replay = async (operation, requestHash) => {
    if (operation.requestHash !== requestHash) fail('image_v2_request_conflict')
    const value = operationView(operation)
    if (value.status !== 'succeeded') return { operation: value }
    const verified = await verifyImage(context, operation.outputs[0])
    return { operation: value, candidate: candidateView(verified) }
  }

  return {
    root: context.root,
    state() {
      const value = scan(context)
      return { candidates: value.entries.map(entry => candidateView(entry, value.selected)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        operations: value.operations.map(operationView).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), warnings: value.warnings, usage: value.usage }
    },

    async importBytes({ requestId, fileName, mime, data, signal } = {}) {
      if (!UUID.test(requestId ?? '')) fail('image_v2_request_id_invalid')
      if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_IMAGE_BYTES || !EXTENSIONS[mime]) fail('image_v2_input_invalid')
      if (signal?.aborted) fail('image_v2_operation_cancelled')
      const id = requestId.toLowerCase(), bytes = Buffer.from(data)
      const input = { fileName: safeFileName(fileName), sha256: hash(bytes), mime, bytes: bytes.length }
      const requestHash = hash(json(input))
      const existing = findOperation(id)
      if (existing) return replay(existing, requestHash)
      if (writers.get(context.root)?.id === id) return { operation: { id, kind: 'import', status: 'running', outputs: [] } }
      return withWrite(context, id, async () => {
        const repeated = findOperation(id)
        if (repeated) return replay(repeated, requestHash)
        admit(context, scan(context), 1, 1, bytes.length)
        const inspected = await inspect(bytes, mime)
        if (signal?.aborted) fail('image_v2_operation_cancelled')
        const createdAt = new Date().toISOString()
        const descriptor = { schemaVersion: 2, productId: context.productId, operationId: id, operationKind: 'import', createdAt,
          file: { role: 'original', name: 'original.' + EXTENSIONS[mime], mime, bytes: bytes.length, width: inspected.width, height: inspected.height, sha256: inspected.sha256 },
          source: { kind: 'local-import', fileName: input.fileName, capturedAt: createdAt, inputSha256: input.sha256 }, parents: [] }
        const candidateId = hash(json(descriptor)).slice(0, 32), manifest = { id: candidateId, ...descriptor }
        const operation = { schemaVersion: 2, id, productId: context.productId, kind: 'import', status: 'running', createdAt, input, requestHash, outputs: [candidateId] }
        admit(context, scan(context), 1, 1, bytes.length + Buffer.byteLength(json(manifest)))
        context.initialize()
        const operationPath = join(context.operations, id + '.json')
        let persisted = false, published = false
        try {
          try { writeJson(context, operationPath, operation, true); persisted = true }
          catch (cause) { if (cause.code === 'EEXIST') fail('image_v2_request_conflict'); throw cause }
          if (signal?.aborted) fail('image_v2_operation_cancelled')
          const pending = join(context.candidates, '.pending-' + id)
          context.check(); mkdirSync(pending)
          writeExclusive(context, join(pending, descriptor.file.name), bytes)
          writeExclusive(context, join(pending, 'manifest.json'), Buffer.from(json(manifest)))
          context.check()
          if (signal?.aborted) fail('image_v2_operation_cancelled')
          const destination = join(context.candidates, candidateId)
          if (readdirSync(context.candidates).includes(candidateId)) fail('image_v2_candidate_conflict')
          renameSync(pending, destination); published = true
          operation.status = 'succeeded'
          writeJson(context, operationPath, operation)
          return { operation: operationView(operation), candidate: candidateView(manifestEntry(context, candidateId)) }
        } catch (cause) {
          if (!persisted) throw cause
          operation.status = published ? 'unknown' : 'failed'
          operation.error = published ? 'image_v2_import_result_unknown' : (cause?.message === 'image_v2_operation_cancelled' ? 'image_v2_operation_cancelled' : 'image_v2_import_failed')
          try { writeJson(context, operationPath, operation) } catch { /* The persisted running intent remains non-replayable. */ }
          return { operation: operationView(operation) }
        }
      })
    },

    async image({ candidateId } = {}) {
      const entry = await verifyImage(context, candidateId)
      return { data: entry.data, mime: entry.candidate.mime, filename: `image-${candidateId}.${EXTENSIONS[entry.candidate.mime]}`, path: entry.path, candidate: candidateView(entry) }
    },

    async select({ candidateId, selected } = {}) {
      if (typeof selected !== 'boolean') fail('image_v2_selection_invalid')
      return withWrite(context, undefined, async () => {
        const entry = await verifyImage(context, candidateId)
        if (operationView(entry.operation).status !== 'succeeded') fail('image_v2_operation_unknown')
        const ids = new Set(selectionIds(context))
        if (selected) ids.add(candidateId); else ids.delete(candidateId)
        writeJson(context, join(context.root, 'selection.json'), { schemaVersion: 2, productId: context.productId, ids: [...ids].sort() })
        return { candidateId, formatVersion: 2, selected }
      })
    },

    async updateMetadata({ candidateId, tags, notes } = {}) {
      return withWrite(context, undefined, async () => {
        const entry = await verifyImage(context, candidateId), current = readMetadata(context, candidateId, entry.candidate.sha256)
        if (tags !== undefined && (!Array.isArray(tags) || tags.length > 50 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 80 || /[\x00-\x1f]/.test(tag)))) fail('image_v2_metadata_invalid')
        if (notes !== undefined && (typeof notes !== 'string' || notes.length > 4000 || notes.includes('\x00'))) fail('image_v2_metadata_invalid')
        const value = { ...current, tags: tags === undefined ? current.tags : [...new Set(tags.map(tag => tag.trim()))], notes: notes ?? current.notes }
        writeJson(context, join(context.metadata, candidateId + '.json'), value)
        return value
      })
    },

    async check({ candidateId } = {}) {
      return withWrite(context, undefined, async () => {
        const entry = await verifyImage(context, candidateId), report = { ...entry.inspected, status: 'pass', visualStatus: 'not-evaluated' }
        const current = readMetadata(context, candidateId, entry.candidate.sha256)
        writeJson(context, join(context.metadata, candidateId + '.json'), { ...current, checks: [report] })
        return report
      })
    },
  }
}
