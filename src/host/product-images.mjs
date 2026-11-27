import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import sharp from 'sharp'
import { createProductImageV2Store } from './product-images-v2.mjs'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 64_000_000
const MAX_JOBS = 200
const MAX_STORAGE_BYTES = 512 * 1024 * 1024
const MAX_PREVIEW_CACHE_ENTRIES = 64
const MAX_PREVIEW_CACHE_BYTES = 32 * 1024 * 1024
const MAX_PREVIEW_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_JSON_BYTES = 64 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const ID = /^[a-f0-9]{32}$/
const HASH = /^[a-f0-9]{64}$/
const TYPES = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' })
const EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })
// All service instances in this host share the same product concurrency fence.
const running = new Map()
const storageFence = new Set()
const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value) + '\n'
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function inside(root, path) {
  const name = relative(root, path)
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep))
}

function directory(root, path, create = false) {
  if (!inside(root, path)) fail('image_storage_unsafe')
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(root, realpathSync(path))) fail('image_storage_unsafe')
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
    if (!create) return false
    mkdirSync(path)
    return directory(root, path)
  }
  return true
}

function fileStat(root, path, maxBytes) {
  if (!inside(root, path)) fail('image_storage_unsafe')
  let stat
  try { stat = lstatSync(path) } catch (cause) { if (cause.code === 'ENOENT') fail('image_not_found'); throw cause }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !inside(root, realpathSync(path))) fail('image_storage_unsafe')
  if (stat.size < 1 || stat.size > maxBytes) fail('image_storage_limit')
  return stat
}

function readBytes(root, path, maxBytes) {
  const stat = fileStat(root, path, maxBytes)
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail('image_storage_unsafe')
    const value = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < value.length) {
      const count = readSync(fd, value, offset, value.length - offset, offset)
      if (!count) fail('image_integrity_invalid')
      offset += count
    }
    const after = fstatSync(fd)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail('image_integrity_invalid')
    return value
  } finally { if (fd !== undefined) closeSync(fd) }
}

function readJson(context, path) {
  try { return JSON.parse(readBytes(context.root, path, MAX_JSON_BYTES).toString('utf8')) }
  catch (cause) { if (/^image_/.test(cause.message)) throw cause; fail('image_integrity_invalid') }
}

function atomicJson(context, path, value, exclusive = false) {
  // Recheck every parent before writing. The browser never supplies a path.
  context.check()
  const text = json(value)
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) fail('image_storage_limit')
  if (exclusive) {
    let fd
    try { fd = openSync(path, 'wx'); writeFileSync(fd, text); fsyncSync(fd) }
    finally { if (fd !== undefined) closeSync(fd) }
    return
  }
  try { readBytes(context.root, path, MAX_JSON_BYTES) } catch (cause) { if (cause.message !== 'image_not_found') throw cause }
  const pending = join(context.root, '.write-' + randomUUID() + '.json')
  try {
    writeFileSync(pending, text, { flag: 'wx', flush: true })
    context.check()
    renameSync(pending, path)
  } finally { try { unlinkSync(pending) } catch (cause) { if (cause.code !== 'ENOENT') throw cause } }
}

function productContext(products, productId, create = false) {
  if (typeof productId !== 'string' || !productId || productId.length > 200 || /[\x00-\x1f]/.test(productId)) fail('image_product_invalid')
  const product = products().find(item => item.id === productId)
  if (!product || !isAbsolute(product.workspacePath ?? '')) fail('product_workspace_unavailable')
  let workspaceRoot
  try {
    workspaceRoot = realpathSync(product.workspacePath)
    if (!statSync(workspaceRoot).isDirectory()) fail('product_workspace_unavailable')
  } catch { fail('product_workspace_unavailable') }
  const parents = [join(workspaceRoot, '.dsh-workbench'), join(workspaceRoot, '.dsh-workbench', 'product-images')]
  const root = join(parents[1], hash(productId).slice(0, 32))
  const paths = [...parents, root, join(root, 'jobs'), join(root, 'candidates')]
  let exists = true
  for (const path of paths) {
    if (!directory(workspaceRoot, path, create)) { exists = false; break }
  }
  const context = { root, workspaceRoot, productId, exists, jobs: join(root, 'jobs'), candidates: join(root, 'candidates'), key: root }
  context.check = () => {
    if (realpathSync(product.workspacePath) !== workspaceRoot) fail('image_storage_unsafe')
    for (const path of paths) if (!directory(workspaceRoot, path)) fail('image_storage_unsafe')
  }
  return context
}

function requestOf(args) {
  if (args.confirmed !== true) fail('image_generation_confirmation_required')
  if (typeof args.requestId !== 'string' || !UUID.test(args.requestId)) fail('image_request_id_invalid')
  if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 12_000 || /\x00/.test(args.prompt)) fail('image_prompt_invalid')
  if (!['generate', 'edit'].includes(args.mode)) fail('image_mode_invalid')
  if (args.mode === 'edit' ? !ID.test(args.referenceId ?? '') : args.referenceId !== undefined) fail('image_reference_invalid')
  return { mode: args.mode, prompt: args.prompt.trim(), ...(args.mode === 'edit' ? { referenceId: args.referenceId } : {}) }
}

function readJob(context, id) {
  if (!UUID.test(id)) fail('image_request_id_invalid')
  const job = readJson(context, join(context.jobs, id.toLowerCase() + '.json'))
  if (!plain(job) || job.schemaVersion !== 1 || job.productId !== context.productId || job.id !== id.toLowerCase()
    || !['running', 'succeeded', 'failed', 'unknown'].includes(job.status) || typeof job.createdAt !== 'string'
    || !plain(job.request) || !HASH.test(job.requestHash ?? '') || hash(json(job.request)) !== job.requestHash
    || job.candidateId !== undefined && !ID.test(job.candidateId)) fail('image_integrity_invalid')
  const normalized = requestOf({ ...job.request, requestId: job.id, confirmed: true })
  if (json(normalized) !== json(job.request)) fail('image_integrity_invalid')
  return job
}

function visibleJob(context, job) {
  const active = running.get(context.key)
  const unknown = job.status === 'running' && active !== job.id
  return {
    id: job.id, createdAt: job.createdAt, status: unknown ? 'unknown' : job.status,
    ...(job.candidateId ? { candidateId: job.candidateId } : {}),
    ...(unknown ? { error: 'image_generation_interrupted_unknown' } : job.error ? { error: job.error } : {}),
  }
}

async function inspectImage(data, claimedMime) {
  if (!Buffer.isBuffer(data) || data.length < 1 || data.length > MAX_IMAGE_BYTES) fail('image_output_size_invalid')
  let metadata
  try { metadata = await sharp(data, { animated: true, limitInputPixels: MAX_PIXELS }).metadata() }
  catch { fail('image_output_invalid') }
  const mime = TYPES[metadata.format]
  if (!mime || mime !== claimedMime || (metadata.pages ?? 1) !== 1 || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)
    || metadata.width < 1 || metadata.height < 1 || metadata.width * metadata.height > MAX_PIXELS) fail('image_output_invalid')
  if (metadata.format === 'png') {
    // libvips builds can report APNG as one PNG page. Inspect the actual chunk
    // structure so an animated original cannot enter this static-only service.
    for (let cursor = 8; cursor + 12 <= data.length;) {
      const length = data.readUInt32BE(cursor)
      if (length > data.length - cursor - 12) fail('image_output_invalid')
      const type = data.toString('ascii', cursor + 4, cursor + 8)
      if (type === 'acTL') fail('image_output_invalid')
      if (type === 'IEND') break
      cursor += length + 12
    }
  }
  // Metadata alone accepts some truncated/corrupt files; decode the full image.
  try { await sharp(data, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).stats() } catch { fail('image_output_invalid') }
  return { mime, width: metadata.width, height: metadata.height, bytes: data.length, sha256: hash(data) }
}

function safeLabel(value, fallback) {
  return typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f]/.test(value) ? value.trim() : fallback
}

function selections(context) {
  try {
    const value = readJson(context, join(context.root, 'selection.json'))
    if (!plain(value) || value.schemaVersion !== 1 || value.productId !== context.productId || !Array.isArray(value.ids)
      || value.ids.length > MAX_JOBS || value.ids.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(value.ids).size !== value.ids.length) fail('image_integrity_invalid')
    return value.ids
  } catch (cause) { if (cause.message === 'image_not_found') return []; throw cause }
}

function readCandidateManifest(context, id, selectedIds) {
  if (!ID.test(id ?? '')) fail('image_candidate_invalid')
  const folder = join(context.candidates, id)
  if (!directory(context.root, folder)) fail('image_not_found')
  const manifest = readJson(context, join(folder, 'manifest.json'))
  if (!plain(manifest) || manifest.schemaVersion !== 1 || manifest.productId !== context.productId || manifest.id !== id) fail('image_integrity_invalid')
  const { id: storedId, ...descriptor } = manifest
  if (hash(json(descriptor)).slice(0, 32) !== storedId || !HASH.test(manifest.sha256 ?? '') || !EXTENSIONS[manifest.mime]
    || !UUID.test(manifest.jobId ?? '') || !HASH.test(manifest.requestHash ?? '') || typeof manifest.createdAt !== 'string'
    || !Number.isSafeInteger(manifest.width) || !Number.isSafeInteger(manifest.height) || manifest.width < 1 || manifest.height < 1
    || manifest.width * manifest.height > MAX_PIXELS || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_IMAGE_BYTES
    || safeLabel(manifest.provider, '') !== manifest.provider || safeLabel(manifest.model, '') !== manifest.model
    || manifest.channel !== undefined && safeLabel(manifest.channel, '') !== manifest.channel) fail('image_integrity_invalid')
  const job = readJob(context, manifest.jobId)
  if (job.requestHash !== manifest.requestHash || job.request.mode !== manifest.mode || job.request.prompt !== manifest.prompt
    || job.request.referenceId !== manifest.sourceCandidateId) fail('image_integrity_invalid')
  const filename = 'original.' + EXTENSIONS[manifest.mime]
  const entries = readdirSync(folder).sort()
  if (json(entries) !== json(['manifest.json', filename].sort())) fail('image_integrity_invalid')
  const path = join(folder, filename)
  if (fileStat(context.root, path, MAX_IMAGE_BYTES).size !== manifest.bytes) fail('image_integrity_invalid')
  return {
    candidate: {
      id, createdAt: manifest.createdAt, mode: manifest.mode, prompt: manifest.prompt, provider: manifest.provider, model: manifest.model,
      ...(manifest.channel ? { channel: manifest.channel } : {}),
      width: manifest.width, height: manifest.height, mime: manifest.mime, bytes: manifest.bytes, sha256: manifest.sha256,
      selected: (selectedIds ?? selections(context)).includes(id),
      ...(manifest.sourceCandidateId ? { sourceCandidateId: manifest.sourceCandidateId } : {}),
    },
    path, filename,
  }
}

async function readCandidate(context, id, selectedIds) {
  const entry = readCandidateManifest(context, id, selectedIds)
  const data = readBytes(context.root, entry.path, MAX_IMAGE_BYTES)
  const verified = await inspectImage(data, entry.candidate.mime)
  if (['sha256', 'bytes', 'width', 'height', 'mime'].some(key => verified[key] !== entry.candidate[key])) fail('image_integrity_invalid')
  return { ...entry, data }
}

function storageUsage(context) {
  let bytes = 0
  let count = 0
  for (const name of readdirSync(context.candidates)) {
    if (!ID.test(name) && !/^\.pending-[a-f0-9-]{36}$/.test(name)) fail('image_storage_unsafe')
    const folder = join(context.candidates, name)
    if (!directory(context.root, folder)) fail('image_storage_unsafe')
    count++
    for (const file of readdirSync(folder)) {
      if (!['manifest.json', 'original.png', 'original.jpg', 'original.webp'].includes(file)) fail('image_storage_unsafe')
      bytes += readBytes(context.root, join(folder, file), MAX_IMAGE_BYTES).length
    }
  }
  return { bytes, count }
}

async function abortable(operation, signal) {
  signal.throwIfAborted()
  let listener
  const aborted = new Promise((_, reject) => {
    listener = () => reject(signal.reason ?? new Error('image_operation_cancelled'))
    signal.addEventListener('abort', listener, { once: true })
  })
  try { return await Promise.race([operation(), aborted]) }
  finally { signal.removeEventListener('abort', listener) }
}

/** Product-owned originals and candidates, independent of games and workflow runs. */
export function createProductImageService({ products, generate, readImage, authorize = () => {}, timeoutMs = 330_000 }) {
  const previewCache = new Map()
  let previewCacheBytes = 0
  const contextOf = (productId, create) => productContext(products, productId, create)
  const v2Of = productId => {
    const context = contextOf(productId)
    return createProductImageV2Store({
      workspaceRoot: context.workspaceRoot,
      productId: context.productId,
      externalUsage: () => context.exists ? { jobs: readdirSync(context.jobs).length, ...storageUsage(context) } : { jobs: 0, count: 0, bytes: 0 },
    })
  }
  const formatVersionOf = value => {
    const version = value === undefined || value === '' ? 1 : Number(value)
    if (version !== 1 && version !== 2) fail('image_format_version_unsupported')
    return version
  }
  const mergedUsage = (context, v1Jobs = 0) => {
    const v1 = context.exists ? storageUsage(context) : { count: 0, bytes: 0 }
    const v2 = v2Of(context.productId).state().usage
    return { jobs: v1Jobs + (v2.jobs ?? 0), count: v1.count + (v2.count ?? 0), bytes: v1.bytes + (v2.bytes ?? 0) }
  }
  const preview = async ({ productId, candidateId, formatVersion }) => {
    authorize('workbench_image_list')
    const version = formatVersionOf(formatVersion)
    let candidate, original
    if (version === 2) {
      const verified = await v2Of(productId).image({ candidateId })
      candidate = verified.candidate
      original = verified.data
    } else {
      const context = contextOf(productId)
      if (!context.exists) fail('image_not_found')
      const verified = await readCandidate(context, candidateId)
      context.check()
      candidate = verified.candidate
      original = verified.data
    }
    const key = JSON.stringify([productId, version, candidateId, candidate.sha256])
    let cached = previewCache.get(key)
    if (cached) {
      previewCache.delete(key)
      previewCache.set(key, cached)
    } else {
      let data
      try {
        data = await sharp(original, { limitInputPixels: MAX_PIXELS, failOn: 'warning' })
          .rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 84, effort: 3 }).toBuffer()
      } catch { fail('image_preview_failed') }
      cached = { data }
      if (data.length <= MAX_PREVIEW_ENTRY_BYTES) {
        while (previewCache.size >= MAX_PREVIEW_CACHE_ENTRIES || previewCacheBytes + data.length > MAX_PREVIEW_CACHE_BYTES) {
          const oldest = previewCache.entries().next().value
          if (!oldest) break
          previewCache.delete(oldest[0])
          previewCacheBytes -= oldest[1].data.length
        }
        previewCache.set(key, cached)
        previewCacheBytes += data.length
      }
    }
    return { data: cached.data, mime: 'image/webp', filename: `preview-${candidateId}.webp` }
  }
  return {
    async state({ productId }) {
      authorize('workbench_image_list')
      const context = contextOf(productId)
      let jobs = []
      let candidates = []
      if (context.exists) {
        const selectedIds = selections(context)
        const names = readdirSync(context.jobs)
        if (names.length > MAX_JOBS) fail('image_storage_limit')
        jobs = names.map(name => {
          if (!UUID.test(name.slice(0, -5)) || !name.endsWith('.json')) fail('image_storage_unsafe')
          return visibleJob(context, readJob(context, name.slice(0, -5)))
        })
        for (const name of readdirSync(context.candidates)) {
          if (/^\.pending-[a-f0-9-]{36}$/.test(name)) continue
          candidates.push(readCandidateManifest(context, name, selectedIds).candidate)
        }
        if (selectedIds.some(id => !candidates.some(candidate => candidate.id === id))) fail('image_integrity_invalid')
        context.check()
      }
      const v2 = v2Of(productId).state()
      return {
        candidates: [...candidates, ...v2.candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        jobs: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        operations: v2.operations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        warnings: v2.warnings,
      }
    },
    async generate(args) {
      authorize('workbench_image_generate')
      authorize('workbench_image_select')
      const request = requestOf(args)
      if (args.signal?.aborted) fail('image_operation_cancelled')
      if (typeof generate !== 'function' || typeof readImage !== 'function') fail('image_provider_unavailable')
      const context = contextOf(args.productId, true)
      const id = args.requestId.toLowerCase()
      const requestHash = hash(json(request))
      const existing = (() => { try { return readJob(context, id) } catch (cause) { if (cause.message === 'image_not_found') return null; throw cause } })()
      if (existing) {
        if (existing.requestHash !== requestHash) fail('image_request_conflict')
        const job = visibleJob(context, existing)
        return { job, ...(job.candidateId ? { candidate: (await readCandidate(context, job.candidateId)).candidate } : {}) }
      }
      if (running.has(context.key) || storageFence.has(context.key) || running.size >= 2) fail('image_generation_busy')
      const currentJobs = readdirSync(context.jobs).length
      const usage = mergedUsage(context, currentJobs)
      if (usage.jobs >= MAX_JOBS || usage.count >= MAX_JOBS || usage.bytes >= MAX_STORAGE_BYTES) fail('image_storage_limit')
      // Fence before the first await, including reference-image validation.
      running.set(context.key, id)
      storageFence.add(context.key)
      const job = { schemaVersion: 1, id, productId: context.productId, request, requestHash, createdAt: new Date().toISOString(), status: 'running' }
      let dispatched = false
      let persisted = false
      let pending = 0
      let finished = false
      const release = () => {
        if (finished && pending === 0 && running.get(context.key) === id) {
          running.delete(context.key)
          storageFence.delete(context.key)
        }
      }
      const track = operation => {
        pending++
        const promise = Promise.resolve().then(operation)
        const settled = () => { pending--; release() }
        // Attach both handlers so a rejected late call is always observed.
        promise.then(settled, settled)
        return promise
      }
      try {
        const reference = request.mode === 'edit' ? await readCandidate(context, request.referenceId) : null
        if (args.signal?.aborted) fail('image_operation_cancelled')
        try { atomicJson(context, join(context.jobs, id + '.json'), job, true); persisted = true }
        catch (cause) { if (cause.code === 'EEXIST') fail('image_request_conflict'); throw cause }
        const signal = args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        dispatched = true
        const result = await abortable(() => track(() => generate({ ...request, workspaceRoot: context.workspaceRoot, ...(reference ? { referencePath: reference.path } : {}), ...(args.execution ? { execution: args.execution } : {}), signal })), signal)
        signal.throwIfAborted()
        const image = await abortable(() => track(() => readImage(result)), signal)
        const data = Buffer.isBuffer(image?.data) ? image.data : image?.data instanceof Uint8Array ? Buffer.from(image.data) : null
        const verified = await inspectImage(data, image?.mime)
        signal.throwIfAborted()
        const descriptor = {
          schemaVersion: 1, productId: context.productId, jobId: id, requestHash, createdAt: new Date().toISOString(), mode: request.mode, prompt: request.prompt,
          provider: safeLabel(result?.provider, 'not-reported'), model: safeLabel(result?.model, 'not-reported'), ...verified,
          ...(safeLabel(result?.channel, '') ? { channel: safeLabel(result.channel, '') } : {}),
          ...(request.referenceId ? { sourceCandidateId: request.referenceId } : {}),
        }
        const candidateId = hash(json(descriptor)).slice(0, 32)
        const manifest = { id: candidateId, ...descriptor }
        const currentUsage = mergedUsage(context, readdirSync(context.jobs).length)
        if (currentUsage.count >= MAX_JOBS || currentUsage.bytes + data.length + Buffer.byteLength(json(manifest)) > MAX_STORAGE_BYTES) fail('image_storage_limit')
        const pending = join(context.candidates, '.pending-' + randomUUID())
        context.check()
        mkdirSync(pending)
        writeFileSync(join(pending, 'original.' + EXTENSIONS[verified.mime]), data, { flag: 'wx', flush: true })
        writeFileSync(join(pending, 'manifest.json'), json(manifest), { flag: 'wx', flush: true })
        context.check()
        renameSync(pending, join(context.candidates, candidateId))
        job.status = 'succeeded'
        job.candidateId = candidateId
        atomicJson(context, join(context.jobs, id + '.json'), job)
        return { job: visibleJob(context, job), candidate: (await readCandidate(context, candidateId)).candidate }
      } catch (cause) {
        if (!persisted) throw cause
        job.status = dispatched && cause?.definitive !== true ? 'unknown' : 'failed'
        // Never persist provider error strings: they can contain credentials or URLs.
        job.error = job.status === 'unknown' ? 'image_generation_result_unknown' : 'image_generation_failed'
        try { atomicJson(context, join(context.jobs, id + '.json'), job) } catch { /* The prior running intent remains non-replayable after restart. */ }
        return { job: visibleJob(context, job) }
      } finally { finished = true; release() }
    },
    async importImage({ productId, requestId, fileName, mime, data, signal }) {
      authorize('workbench_image_import')
      if (signal?.aborted) fail('image_operation_cancelled')
      if (typeof requestId !== 'string' || !UUID.test(requestId)) fail('image_request_id_invalid')
      const context = contextOf(productId)
      if (running.has(context.key) || storageFence.has(context.key)) fail('image_storage_busy')
      storageFence.add(context.key)
      try {
        const store = v2Of(productId)
        return await store.importBytes({ requestId: requestId.toLowerCase(), fileName, mime, data, signal })
      }
      finally { storageFence.delete(context.key) }
    },
    async select({ productId, candidateId, selected, formatVersion }) {
      authorize('workbench_image_select')
      if (typeof selected !== 'boolean') fail('image_selection_invalid')
      if (formatVersionOf(formatVersion) === 2) return v2Of(productId).select({ candidateId, selected })
      const context = contextOf(productId)
      if (!context.exists) fail('image_not_found')
      await readCandidate(context, candidateId)
      // Re-read after image decoding to merge concurrent selections in one host.
      const ids = new Set(selections(context))
      if (selected) ids.add(candidateId)
      else ids.delete(candidateId)
      atomicJson(context, join(context.root, 'selection.json'), { schemaVersion: 1, productId, ids: [...ids].sort() })
      return { candidateId, selected }
    },
    async image({ productId, candidateId, formatVersion }) {
      authorize('workbench_image_list')
      if (formatVersionOf(formatVersion) === 2) return v2Of(productId).image({ candidateId })
      const context = contextOf(productId)
      if (!context.exists) fail('image_not_found')
      const { candidate, data } = await readCandidate(context, candidateId)
      context.check()
      return { data, mime: candidate.mime, filename: 'image-' + candidate.id + '.' + EXTENSIONS[candidate.mime] }
    },
    preview,
    previewCacheUsage() { return { entries: previewCache.size, bytes: previewCacheBytes } },
    async updateMetadata({ productId, candidateId, formatVersion, tags, notes }) {
      authorize('workbench_image_metadata')
      if (formatVersionOf(formatVersion) !== 2) fail('image_metadata_version_invalid')
      return { metadata: await v2Of(productId).updateMetadata({ candidateId, tags, notes }) }
    },
    async check({ productId, candidateId, formatVersion }) {
      authorize('workbench_image_check')
      if (formatVersionOf(formatVersion) !== 2) fail('image_check_version_invalid')
      return { check: await v2Of(productId).check({ candidateId }) }
    },
  }
}
