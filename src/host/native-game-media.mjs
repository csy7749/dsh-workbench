import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import sharp from 'sharp'
import { nativeGameFiles } from './native-game-studio.mjs'

const { project: registeredProject, directory, regularFile, readBytes, hash, json } = nativeGameFiles
const MAX_INPUT_BYTES = 128 * 1024 * 1024
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024
const MAX_TOTAL_PIXELS = 64_000_000
const MAX_PIXELS = 100_000_000
const MAX_FRAMES = 100
const MAX_RUNS = 100
const MAX_STORAGE_BYTES = 1024 * 1024 * 1024
const MAX_QUEUED = 8
const FORMATS = new Set(['png', 'jpeg', 'webp'])
const OPERATIONS = new Set(['crop', 'grid-split'])
const fail = code => { throw new Error(code) }

sharp.cache({ files: 0 })

let activeTasks = 0
const waitingTasks = []

async function withMediaTask(operation, signal) {
  if (signal?.aborted) fail('game_operation_cancelled')
  if (activeTasks < 2) activeTasks += 1
  else {
    if (waitingTasks.length >= MAX_QUEUED) fail('game_media_queue_full')
    await new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, abort: null }
      item.abort = () => {
        const index = waitingTasks.indexOf(item)
        if (index >= 0) waitingTasks.splice(index, 1)
        reject(new Error('game_operation_cancelled'))
      }
      signal?.addEventListener('abort', item.abort, { once: true })
      waitingTasks.push(item)
    })
  }
  try {
    if (signal?.aborted) fail('game_operation_cancelled')
    return await operation()
  } finally {
    const next = waitingTasks.shift()
    if (next) {
      next.signal?.removeEventListener('abort', next.abort)
      next.resolve()
    } else activeTasks -= 1
  }
}

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`game_media_${name}_invalid`)
  return value
}

function outputFormat(value) {
  const format = value ?? 'png'
  if (!FORMATS.has(format)) fail('game_media_format_invalid')
  return format
}

function imageType(format) { return format === 'jpeg' ? 'image/jpeg' : `image/${format}` }
function imageExtension(format) { return format === 'jpeg' ? 'jpg' : format }
function checkSignal(signal) { if (signal?.aborted) fail('game_operation_cancelled') }

function readProjectImage(context, sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.length < 1 || sourcePath.length > 512 || /[\x00-\x1f]/.test(sourcePath)) fail('game_media_source_invalid')
  const normalized = sourcePath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || isAbsolute(sourcePath) || /^[a-z]:/i.test(normalized)) fail('game_media_source_invalid')
  const parts = normalized.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.includes(':'))) fail('game_media_source_invalid')
  let parent = context.project
  for (const part of parts.slice(0, -1)) parent = directory(join(parent, part))
  const source = join(parent, parts.at(-1))
  regularFile(source)
  const bytes = readBytes(source, MAX_INPUT_BYTES)
  return { source, bytes, relativePath: context.portable(source), sha256: hash(bytes) }
}

async function imageInfo(bytes) {
  let metadata
  try { metadata = await sharp(bytes, { animated: false, limitInputPixels: MAX_PIXELS }).metadata() }
  catch { fail('game_media_image_invalid') }
  const dimensions = metadata.autoOrient ?? metadata
  if (!dimensions.width || !dimensions.height || !Number.isSafeInteger(dimensions.width * dimensions.height)) fail('game_media_image_invalid')
  if (dimensions.width * dimensions.height > MAX_TOTAL_PIXELS) fail('game_media_pixel_limit')
  return { width: dimensions.width, height: dimensions.height, format: metadata.format }
}

function addOutput(outputs, output) {
  const total = outputs.reduce((bytes, item) => bytes + item.bytes.length, output.bytes.length)
  if (total > MAX_OUTPUT_BYTES) fail('game_media_output_limit')
  outputs.push(output)
}

function ensureDirectory(path) {
  try { return directory(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    mkdirSync(path)
    return directory(path)
  }
}

function inspectStorage(root) {
  let runs = 0
  let bytes = 0
  let files = 0
  for (const operation of readdirSync(root)) {
    if (!OPERATIONS.has(operation)) fail('game_media_storage_unknown_entry')
    const operationRoot = directory(join(root, operation))
    for (const run of readdirSync(operationRoot)) {
      if (run.startsWith('.pending-')) fail('game_media_storage_interrupted')
      if (!/^[a-f0-9-]{36}$/.test(run)) fail('game_media_storage_unknown_entry')
      const runRoot = directory(join(operationRoot, run))
      runs += 1
      for (const entry of readdirSync(runRoot)) {
        if (++files > 10_000) fail('game_media_storage_quota')
        const path = join(runRoot, entry)
        const stat = lstatSync(path)
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('game_media_storage_unsafe')
        bytes += regularFile(path).size
      }
    }
  }
  return { runs, bytes }
}

function acquireMediaLock(studioPath) {
  const path = join(studioPath, 'media.lock')
  const token = randomUUID()
  let fd
  try { fd = openSync(path, 'wx') }
  catch (error) { if (error.code === 'EEXIST') fail('game_media_storage_busy'); throw error }
  try { writeFileSync(fd, json({ schemaVersion: 1, token, pid: process.pid, createdAt: new Date().toISOString() })) }
  catch (error) { closeSync(fd); try { unlinkSync(path) } catch {}; throw error }
  closeSync(fd)
  return () => {
    try {
      const stat = regularFile(path)
      if (stat.size > 4096) return
      const current = JSON.parse(readBytes(path, 4096).toString('utf8'))
      if (current?.token === token) unlinkSync(path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function publish(context, operation, runId, source, recipe, sourceInfo, outputs) {
  const studioPath = directory(join(context.project, '.studio'))
  const mediaRoot = ensureDirectory(join(studioPath, 'media'))
  const operationRoot = ensureDirectory(join(mediaRoot, operation))
  const pending = join(operationRoot, `.pending-${runId}`)
  const final = join(operationRoot, runId)
  const release = acquireMediaLock(studioPath)
  try {
    const entries = outputs.map(output => ({
      name: output.name,
      mediaType: output.mediaType,
      bytes: output.bytes.length,
      sha256: hash(output.bytes),
      ...(output.width ? { width: output.width } : {}),
      ...(output.height ? { height: output.height } : {}),
    }))
    const manifest = {
      schemaVersion: 1,
      provider: 'workbench-native',
      origin: { repository: 'WhiteTowerAI/ohmygame', license: 'Apache-2.0', adapted: true },
      operation,
      runId,
      productId: context.record.productId,
      projectId: context.record.projectId,
      slug: source.slug,
      createdAt: new Date().toISOString(),
      source: { path: sourceInfo.relativePath, bytes: sourceInfo.bytes.length, sha256: sourceInfo.sha256, ...sourceInfo.dimensions },
      recipe,
      files: entries,
    }
    const manifestText = json(manifest)
    const manifestBytes = Buffer.byteLength(manifestText)
    const usage = inspectStorage(mediaRoot)
    const outputBytes = outputs.reduce((total, output) => total + output.bytes.length, 0)
    if (usage.runs >= MAX_RUNS || usage.bytes + outputBytes + manifestBytes > MAX_STORAGE_BYTES) fail('game_media_storage_quota')
    if (manifestBytes + outputBytes > MAX_OUTPUT_BYTES) fail('game_media_output_limit')
    mkdirSync(pending)
    try {
      for (const output of outputs) writeFileSync(join(pending, output.name), output.bytes, { flag: 'wx' })
      writeFileSync(join(pending, 'manifest.json'), manifestText, { flag: 'wx' })
      renameSync(pending, final)
      return {
        ok: true,
        operation,
        runId,
        productId: context.record.productId,
        projectId: context.record.projectId,
        slug: source.slug,
        source: manifest.source,
        files: entries.map(file => ({ ...file, path: context.portable(join(final, file.name)) })),
        manifestPath: context.portable(join(final, 'manifest.json')),
        manifestHash: hash(manifestText),
        reused: false,
      }
    } finally { rmSync(pending, { recursive: true, force: true }) }
  } finally { release() }
}

export function createNativeGameMedia() {
  return {
    crop: args => withMediaTask(async () => {
      checkSignal(args.signal)
      const context = registeredProject(args)
      const input = readProjectImage(context, args.sourcePath)
      const dimensions = await imageInfo(input.bytes)
      const left = integer(args.left, 0, dimensions.width - 1, 'crop')
      const top = integer(args.top, 0, dimensions.height - 1, 'crop')
      const width = integer(args.width, 1, dimensions.width, 'crop')
      const height = integer(args.height, 1, dimensions.height, 'crop')
      if (left + width > dimensions.width || top + height > dimensions.height) fail('game_media_crop_out_of_bounds')
      const format = outputFormat(args.format)
      checkSignal(args.signal)
      let bytes
      try {
        bytes = await sharp(input.bytes, { limitInputPixels: MAX_PIXELS }).autoOrient().extract({ left, top, width, height }).toFormat(format).toBuffer()
      } catch { fail('game_media_crop_failed') }
      checkSignal(args.signal)
      const runId = randomUUID()
      const output = { name: `cropped.${imageExtension(format)}`, bytes, mediaType: imageType(format), width, height }
      const source = { slug: args.slug }
      const saved = publish(context, 'crop', runId, source, { left, top, width, height, format }, { ...input, dimensions }, [output])
      return { ...saved, width, height, format, bytes: bytes.length, sha256: hash(bytes) }
    }, args.signal),

    splitGrid: args => withMediaTask(async () => {
      checkSignal(args.signal)
      const context = registeredProject(args)
      const input = readProjectImage(context, args.sourcePath)
      const dimensions = await imageInfo(input.bytes)
      const columns = integer(args.columns, 1, 100, 'columns')
      const rows = integer(args.rows, 1, 100, 'rows')
      const count = columns * rows
      if (count > MAX_FRAMES) fail('game_media_frame_limit')
      const format = outputFormat(args.format)
      const columnEdges = Array.from({ length: columns + 1 }, (_, index) => Math.round(index * dimensions.width / columns))
      const rowEdges = Array.from({ length: rows + 1 }, (_, index) => Math.round(index * dimensions.height / rows))
      const columnWidths = columnEdges.slice(1).map((edge, index) => edge - columnEdges[index])
      const rowHeights = rowEdges.slice(1).map((edge, index) => edge - rowEdges[index])
      if (columnWidths.some(width => width < 1) || rowHeights.some(height => height < 1)) fail('game_media_cell_invalid')
      const outputs = []
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          checkSignal(args.signal)
          const width = columnWidths[column]
          const height = rowHeights[row]
          let bytes
          try {
            bytes = await sharp(input.bytes, { limitInputPixels: MAX_PIXELS }).autoOrient().extract({ left: columnEdges[column], top: rowEdges[row], width, height }).toFormat(format).toBuffer()
          } catch { fail('game_media_grid_split_failed') }
          addOutput(outputs, { name: `frame-${String(row * columns + column).padStart(4, '0')}.${imageExtension(format)}`, bytes, mediaType: imageType(format), width, height })
        }
      }
      const uniformWidth = new Set(columnWidths).size === 1
      const uniformHeight = new Set(rowHeights).size === 1
      const frames = outputs.length
      const manifest = {
        columns,
        rows,
        ...(uniformWidth ? { cellWidth: columnWidths[0] } : {}),
        ...(uniformHeight ? { cellHeight: rowHeights[0] } : {}),
        columnWidths,
        rowHeights,
        frames: count,
        selectedFrames: Array.from({ length: count }, (_, index) => index),
      }
      outputs.push({ name: 'grid.json', bytes: Buffer.from(json(manifest)), mediaType: 'application/json' })
      const outputBytes = outputs.reduce((total, output) => total + output.bytes.length, 0)
      if (outputBytes > MAX_OUTPUT_BYTES) fail('game_media_output_limit')
      checkSignal(args.signal)
      const runId = randomUUID()
      const source = { slug: args.slug }
      const saved = publish(context, 'grid-split', runId, source, { ...manifest, format }, { ...input, dimensions }, outputs)
      return { ...saved, columns, rows, frameCount: frames, format, bytes: outputBytes }
    }, args.signal),
  }
}
