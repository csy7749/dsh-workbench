import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { nativeGameFiles } from './native-game-studio.mjs'
import { validateNativeGameGlb } from './native-game-glb.mjs'

const { directory, readBytes, readFile, hash, json } = nativeGameFiles
const MAX_ASSET_BYTES = 256 * 1024
const MAX_MODEL_BYTES = 8 * 1024 * 1024
const MAX_EMBEDDED_BYTES = 12 * 1024 * 1024
const MAX_NATIVE_BYTES = 16 * 1024 * 1024
const MAX_CANDIDATE_BYTES = 32 * 1024 * 1024
const IMAGE_SLOTS = ['player', 'pickup', 'enemyCard', 'bossCard', 'cacheCard', 'shrineCard', 'potionCard']
const MODEL_SLOTS = ['playerModel', 'pickupModel']
const AUDIO_SLOTS = ['pickupSound', 'hitSound']
const ID = /^[a-f0-9]{16}$/
const SHA = /^[a-f0-9]{64}$/
const fail = code => { throw new Error(code) }
const originalOrigin = Object.freeze({ implementation: 'original-workbench-adapter', license: 'MIT', upstreamPluginExecuted: false })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function metadata(value, maxBytes = 8192) {
  if (!plain(value)) fail('game_asset_metadata_invalid')
  let text
  try { text = JSON.stringify(value) } catch { fail('game_asset_metadata_invalid') }
  if (!text || Buffer.byteLength(text) > maxBytes || /"(?:__proto__|constructor|prototype)"\s*:/.test(text)) fail('game_asset_metadata_invalid')
  return canonical(JSON.parse(text))
}

function number(value, fallback, min, max, integer = false) {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) fail('game_asset_recipe_invalid')
  return result
}

function recipeObject(value, keys) {
  const recipe = value === undefined ? {} : value
  if (!plain(recipe) || Object.keys(recipe).some(key => !keys.includes(key))) fail('game_asset_recipe_invalid')
  return recipe
}

function color(value, fallback) {
  const result = value ?? fallback
  if (typeof result !== 'string' || !/^#[a-f0-9]{6}$/i.test(result)) fail('game_asset_color_invalid')
  return result.toLowerCase()
}

const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character])

function drawing(slot, input) {
  if (!IMAGE_SLOTS.includes(slot)) fail('game_asset_slot_invalid')
  const raw = recipeObject(input, ['shape', 'width', 'height', 'fill', 'stroke', 'strokeWidth', 'label'])
  const recipe = {
    shape: raw.shape ?? (slot === 'pickup' ? 'ellipse' : 'rect'),
    width: number(raw.width, 64, 16, 256, true), height: number(raw.height, 64, 16, 256, true),
    fill: color(raw.fill, slot === 'pickup' ? '#ffd45c' : '#65d69d'),
    stroke: color(raw.stroke, '#183047'), strokeWidth: number(raw.strokeWidth, 2, 0, 8), label: raw.label ?? '',
  }
  if (!['ellipse', 'rect', 'diamond'].includes(recipe.shape) || typeof recipe.label !== 'string' || recipe.label.length > 12 || /[\x00-\x1f]/.test(recipe.label)) fail('game_asset_recipe_invalid')
  const { width, height, fill, stroke, strokeWidth, label } = recipe
  const inset = strokeWidth / 2
  const style = `${recipe.shape === 'ellipse' ? 'ellipse;' : recipe.shape === 'diamond' ? 'rhombus;' : 'rounded=1;'}fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};`
  const key = hash(json(recipe)).slice(0, 24)
  const native = { format: 'dsh-drawai', schemaVersion: 1, id: `workbench-${key}`, pages: [{ id: 'page-1', name: 'Game asset', doc: { version: 2, meta: { layout: 'manual' }, nodes: [{ id: 'asset', label, style, x: inset, y: inset, w: width - strokeWidth, h: height - strokeWidth, layer: '1' }], edges: [], layers: [{ id: '1', name: 'Asset', visible: true, locked: false }] }, notes: [] }] }
  const attrs = `fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"`
  const shape = recipe.shape === 'ellipse'
    ? `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${(width - strokeWidth) / 2}" ry="${(height - strokeWidth) / 2}" ${attrs}/>`
    : recipe.shape === 'diamond'
      ? `<polygon points="${width / 2},${inset} ${width - inset},${height / 2} ${width / 2},${height - inset} ${inset},${height / 2}" ${attrs}/>`
      : `<rect x="${inset}" y="${inset}" width="${width - strokeWidth}" height="${height - strokeWidth}" rx="${Math.min(width, height) / 8}" ${attrs}/>`
  const text = label ? `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${Math.min(width, height) / Math.max(3, label.length)}" fill="${stroke}">${xml(label)}</text>` : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shape}${text}</svg>\n`
  return { recipe, output: 'output.svg', source: 'source.drawai', mime: 'image/svg+xml', compatibility: { format: 'dsh-drawai', schemaVersion: 1, scope: 'single-page-basic-shapes', fidelity: 'approximate', warnings: ['Original local SVG renderer; the upstream DrawAI plugin and editor are not executed.'] }, files: [{ name: 'source.drawai', mime: 'application/json', data: Buffer.from(json(native)) }, { name: 'output.svg', mime: 'image/svg+xml', data: Buffer.from(svg) }] }
}

function audio(slot, input) {
  if (!AUDIO_SLOTS.includes(slot)) fail('game_asset_slot_invalid')
  const raw = recipeObject(input, ['preset', 'type', 'durationSec', 'sampleRate', 'frequency', 'gain', 'seed'])
  if (raw.preset !== undefined && raw.type !== undefined) fail('game_asset_recipe_invalid')
  const recipe = { preset: raw.preset ?? raw.type ?? (slot === 'pickupSound' ? 'coin' : 'hit'), durationSec: number(raw.durationSec, 0.2, 0.05, 1.2), sampleRate: number(raw.sampleRate, 24000, 8000, 48000, true), frequency: number(raw.frequency, slot === 'pickupSound' ? 880 : 160, 40, 4000), gain: number(raw.gain, 0.5, 0.01, 0.9), seed: number(raw.seed, 1, 1, 0xffffffff, true) }
  if (!['bell', 'impact', 'coin', 'hit', 'sine', 'noise', 'whoosh'].includes(recipe.preset) || ![8000, 16000, 24000, 44100, 48000].includes(recipe.sampleRate) || recipe.frequency >= recipe.sampleRate * 0.45) fail('game_asset_recipe_invalid')
  const frames = Math.ceil(recipe.durationSec * recipe.sampleRate)
  const wav = Buffer.alloc(44 + frames * 4)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(recipe.sampleRate, 24)
  wav.writeUInt32LE(recipe.sampleRate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 4, 40)
  let random = recipe.seed >>> 0
  for (let index = 0; index < frames; index++) {
    const t = index / recipe.sampleRate; const phase = index / frames
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5
    const noise = (random >>> 0) / 0xffffffff * 2 - 1
    const frequency = recipe.frequency * (['coin', 'bell'].includes(recipe.preset) ? (phase < 0.35 ? 1 : 1.5) : recipe.preset === 'hit' ? 1 - phase * 0.7 : 1)
    const tone = Math.sin(2 * Math.PI * frequency * t)
    const envelope = Math.min(1, t / 0.005) * Math.pow(1 - phase, ['bell', 'coin'].includes(recipe.preset) ? 3 : 1.8)
    const signal = ['noise', 'whoosh'].includes(recipe.preset) ? noise : ['hit', 'impact'].includes(recipe.preset) ? tone * 0.55 + noise * 0.45 : tone * 0.8 + Math.sin(2 * Math.PI * frequency * 2.01 * t) * 0.2
    const sample = Math.round(Math.max(-1, Math.min(1, signal * envelope * recipe.gain)) * 32767)
    wav.writeInt16LE(sample, 44 + index * 4); wav.writeInt16LE(sample, 46 + index * 4)
  }
  const key = hash(json(recipe)).slice(0, 16)
  const id = `workbench_${key}`; const base = `.anyaudio/projects/${id}`
  const epoch = '1970-01-01T00:00:00Z'; const durationSec = frames / recipe.sampleRate
  const project = { schemaVersion: 1, id, name: `Game ${slot}`, sampleRate: recipe.sampleRate, durationSec, normalizeGainDb: 0, masterFaderDb: 0, masterFx: [], createdAt: epoch, modifiedAt: epoch, history: [{ at: epoch, by: 'agent', note: 'Deterministic source epoch; generated by the original Workbench SFX adapter.' }], video: null, tracks: [{ id: 'sfx', name: 'SFX', category: 'foley', muted: false, solo: false, items: [{ id: 'clip', material: 'sfx', startSec: 0, inSec: 0, outSec: durationSec, gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: slot, fx: [] }] }] }
  return { recipe, output: `${base}/materials/sfx.wav`, source: `${base}/project.json`, mime: 'audio/wav', compatibility: { format: 'dsh-any-audio', schemaVersion: 1, scope: 'single-procedural-pcm-material', warnings: ['Original deterministic local SFX synthesis; upstream AnyAudio plugin, SoundFont, TTS and network providers are not executed.', 'Native document timestamps use the reproducible source epoch.'] }, files: [{ name: `${base}/project.json`, mime: 'application/json', data: Buffer.from(json(project)) }, { name: `${base}/materials/index.json`, mime: 'application/json', data: Buffer.from(json({ materials: [{ id: 'sfx', file: 'materials/sfx.wav', kind: 'sfx', durationSec, source: { kind: 'sfx', snapshot: 'sources/sfx.sfx.json' } }] })) }, { name: `${base}/sources/sfx.sfx.json`, mime: 'application/json', data: Buffer.from(json({ format: 'workbench-procedural-sfx', schemaVersion: 1, recipe, origin: originalOrigin })) }, { name: `${base}/materials/sfx.wav`, mime: 'audio/wav', data: wav }] }
}

function svgValid(data) {
  const text = data.toString('utf8')
  if (!text.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') || !text.endsWith('</svg>\n') || /(?:<!|\b(?:href|src|style|on[a-z]+)\s*=|url\s*\(|<\s*(?:script|foreignObject|image|use|iframe))/i.test(text)) fail('game_asset_svg_unsafe')
  for (const match of text.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)\b/g)) if (!['svg', 'rect', 'ellipse', 'polygon', 'text'].includes(match[1])) fail('game_asset_svg_unsafe')
}

function wavValid(data) {
  if (data.length < 48 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 16) !== 'WAVEfmt ' || data.toString('ascii', 36, 40) !== 'data'
    || data.readUInt32LE(4) !== data.length - 8 || data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 2
    || data.readUInt16LE(32) !== 4 || data.readUInt16LE(34) !== 16 || ![8000, 16000, 24000, 44100, 48000].includes(data.readUInt32LE(24))
    || data.readUInt32LE(28) !== data.readUInt32LE(24) * 4 || data.readUInt32LE(40) !== data.length - 44 || (data.length - 44) % 4 !== 0) fail('game_asset_wav_invalid')
}

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}

function pngValid(data) {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('game_asset_png_invalid')
  let cursor = 8; let width = 0; let height = 0; let channels = 0; let ended = false
  const compressed = []
  while (cursor + 12 <= data.length) {
    const size = data.readUInt32BE(cursor); const type = data.toString('ascii', cursor + 4, cursor + 8)
    if (cursor + size + 12 > data.length || !/^[A-Za-z]{4}$/.test(type) || crc32(data.subarray(cursor + 4, cursor + 8 + size)) !== data.readUInt32BE(cursor + 8 + size)) fail('game_asset_png_invalid')
    if (cursor === 8 && type !== 'IHDR') fail('game_asset_png_invalid')
    if (type === 'IHDR') {
      if (cursor !== 8 || size !== 13) fail('game_asset_png_invalid')
      width = data.readUInt32BE(cursor + 8); height = data.readUInt32BE(cursor + 12)
      const depth = data[cursor + 16]; const colorType = data[cursor + 17]
      if (!width || !height || width > 1024 || height > 1024 || depth !== 8 || ![2, 6].includes(colorType) || data[cursor + 18] !== 0 || data[cursor + 19] !== 0 || data[cursor + 20] !== 0) fail('game_asset_png_invalid')
      channels = colorType === 6 ? 4 : 3
    } else if (type === 'IDAT') compressed.push(data.subarray(cursor + 8, cursor + 8 + size))
    else if (type === 'IEND') { if (size !== 0 || cursor + 12 !== data.length) fail('game_asset_png_invalid'); ended = true; break }
    else if (type[0] === type[0].toUpperCase()) fail('game_asset_png_invalid')
    cursor += size + 12
  }
  if (!ended || !channels || !compressed.length) fail('game_asset_png_invalid')
  let raw
  try { raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (width * channels + 1) * height }) } catch { fail('game_asset_png_invalid') }
  if (raw.length !== (width * channels + 1) * height) fail('game_asset_png_invalid')
  for (let row = 0; row < height; row++) if (raw[row * (width * channels + 1)] > 4) fail('game_asset_png_invalid')
}

export function validateNativeGameAssetOutput(mime, data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > (mime === 'model/gltf-binary' ? MAX_MODEL_BYTES : MAX_ASSET_BYTES)) fail('game_asset_too_large')
  if (mime === 'image/svg+xml') svgValid(data)
  else if (mime === 'audio/wav') wavValid(data)
  else if (mime === 'image/png') pngValid(data)
  else if (mime === 'model/gltf-binary') validateNativeGameGlb(data)
  else fail('game_asset_mime_invalid')
  return { mime, bytes: data.length, hash: hash(data) }
}

function relativeName(name) {
  if (typeof name !== 'string' || name.length > 180 || !/^[a-zA-Z0-9._/-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) fail('game_asset_file_name_invalid')
  return name
}

function candidateContext(args, create = false) {
  const context = nativeGameFiles.project(args)
  return { ...context, assets: directory(join(context.project, '.studio/assets'), create) }
}

function filePath(folder, name, create = false) {
  const parts = relativeName(name).split('/')
  let parent = folder
  for (const part of parts.slice(0, -1)) parent = directory(join(parent, part), create)
  return join(parent, parts.at(-1))
}

function descriptorOf(manifest) {
  const { schemaVersion, projectId, productId, provider, slot, recipe, output, source, mime, compatibility, origin, files } = manifest
  return { schemaVersion, projectId, productId, provider, slot, recipe, output, source, mime, compatibility, origin, files }
}

function exactTree(folder, names, prefix = '') {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const name = prefix + entry.name
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      if (![...names].some(file => file.startsWith(name + '/'))) fail('game_asset_storage_unknown_entry')
      exactTree(directory(path), names, name + '/')
    } else {
      if (!names.has(name)) fail('game_asset_storage_unknown_entry')
      nativeGameFiles.regularFile(path)
    }
  }
}

function receipt(context, manifest, manifestText, data, reused = false) {
  const folder = join(context.assets, manifest.assetId)
  return { schemaVersion: 1, projectId: context.record.projectId, productId: context.record.productId, assetId: manifest.assetId, candidateHash: manifest.candidateHash, provider: manifest.provider, slot: manifest.slot, mime: manifest.mime, bytes: data.length, hash: hash(data), status: 'candidate', manifestHash: hash(manifestText), manifestPath: context.portable(join(folder, 'manifest.json')), sourcePath: context.portable(filePath(folder, manifest.source)), outputPath: context.portable(filePath(folder, manifest.output)), compatibility: manifest.compatibility, origin: manifest.origin, files: manifest.files.map(file => ({ ...file, path: context.portable(filePath(folder, file.name)) })), reused }
}

function readCandidate(args) {
  if (!ID.test(args.assetId ?? '')) fail('game_asset_id_invalid')
  const context = candidateContext(args)
  const folder = directory(join(context.assets, args.assetId))
  const manifestText = readFile(join(folder, 'manifest.json'), 64 * 1024)
  const manifest = JSON.parse(manifestText)
  if (!manifest || manifest.schemaVersion !== 1 || manifest.assetId !== args.assetId || manifest.projectId !== context.record.projectId || manifest.productId !== context.record.productId
    || !SHA.test(manifest.candidateHash ?? '') || !Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > 10) fail('game_asset_integrity_invalid')
  const descriptor = descriptorOf(manifest)
  if (hash(json(canonical(descriptor))) !== manifest.candidateHash || manifest.candidateHash.slice(0, 16) !== manifest.assetId) fail('game_asset_integrity_invalid')
  if (manifestText !== json({ ...canonical(descriptor), assetId: manifest.assetId, candidateHash: manifest.candidateHash })) fail('game_asset_integrity_invalid')
  if (!['drawai', 'any-audio', 'blender'].includes(manifest.provider) || ![...IMAGE_SLOTS, ...MODEL_SLOTS, ...AUDIO_SLOTS].includes(manifest.slot)) fail('game_asset_integrity_invalid')
  const names = new Set(); let total = 0; let data
  for (const file of manifest.files) {
    if (!plain(file) || names.has(file.name) || !SHA.test(file.hash ?? '') || !Number.isInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_NATIVE_BYTES) fail('game_asset_integrity_invalid')
    names.add(relativeName(file.name))
    const bytes = readBytes(filePath(folder, file.name), MAX_NATIVE_BYTES)
    if (bytes.length !== file.bytes || hash(bytes) !== file.hash) fail('game_asset_integrity_invalid')
    total += bytes.length
    if (file.name === manifest.output) { data = bytes; if (file.mime !== manifest.mime) fail('game_asset_integrity_invalid') }
  }
  if (total > MAX_CANDIDATE_BYTES || !data || !names.has(manifest.source)) fail('game_asset_integrity_invalid')
  exactTree(folder, new Set(['manifest.json', ...names]))
  validateNativeGameAssetOutput(manifest.mime, data)
  return { context, manifest, manifestText, data, storageBytes: total + Buffer.byteLength(manifestText), receipt: receipt(context, manifest, manifestText, data) }
}

function store(args, provider, payload, quotas) {
  const context = candidateContext(args, true)
  let total = 0
  const names = new Set()
  for (const file of payload.files) {
    if (!Buffer.isBuffer(file.data) || !file.data.length || file.data.length > MAX_NATIVE_BYTES || names.has(relativeName(file.name))) fail('game_asset_file_invalid')
    names.add(file.name); total += file.data.length
  }
  if (total > MAX_CANDIDATE_BYTES) fail('game_asset_too_large')
  const output = payload.files.find(file => file.name === payload.output)
  if (!output || !names.has(payload.source)) fail('game_asset_file_invalid')
  validateNativeGameAssetOutput(payload.mime, output.data)
  const descriptor = canonical({ schemaVersion: 1, projectId: context.record.projectId, productId: context.record.productId, provider, slot: args.slot, recipe: metadata(payload.recipe), output: payload.output, source: payload.source, mime: payload.mime, compatibility: metadata(payload.compatibility), origin: metadata(payload.origin ?? originalOrigin), files: payload.files.map(file => ({ name: file.name, mime: file.mime, bytes: file.data.length, hash: hash(file.data) })) })
  const digest = hash(json(descriptor)); const assetId = digest.slice(0, 16)
  const manifest = { ...descriptor, assetId, candidateHash: digest }; const manifestText = json(manifest)
  const folder = join(context.assets, assetId)
  const lock = join(context.project, '.studio/assets.lock'), token = randomUUID()
  let lockFd
  try { lockFd = openSync(lock, 'wx') } catch (error) { if (error.code === 'EEXIST') fail('game_asset_storage_busy'); throw error }
  try {
    writeFileSync(lockFd, json({ token, pid: process.pid }))
    const entries = readdirSync(context.assets)
    if (entries.some(name => !ID.test(name))) fail('game_asset_storage_unknown_entry')
    let storageBytes = 0
    for (const candidateId of entries) storageBytes += readCandidate({ ...args, assetId: candidateId }).storageBytes
    if (entries.includes(assetId)) return { ...readCandidate({ ...args, assetId }).receipt, reused: true }
    if (entries.length >= quotas.maxCandidates || storageBytes + total + Buffer.byteLength(manifestText) > quotas.maxTotalBytes) fail('game_asset_storage_quota')
    const pending = join(context.assets, '.pending-' + randomUUID())
    mkdirSync(pending)
    try {
      for (const file of payload.files) writeFileSync(filePath(pending, file.name, true), file.data, { flag: 'wx' })
      writeFileSync(join(pending, 'manifest.json'), manifestText, { flag: 'wx' })
      renameSync(pending, folder)
    } finally { rmSync(pending, { recursive: true, force: true }) }
  } finally {
    closeSync(lockFd)
    try { if (JSON.parse(readFile(lock, 4096)).token === token) unlinkSync(lock) } catch { /* Preserve an uncertain or replaced claim for inspection. */ }
  }
  return readCandidate({ ...args, assetId }).receipt
}

function bytesInput(value, maxBytes) {
  if (Buffer.isBuffer(value)) { if (value.length > maxBytes) fail('game_asset_too_large'); return Buffer.from(value) }
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('game_asset_data_invalid')
  const result = Buffer.from(value, 'base64')
  if (result.length > maxBytes || result.toString('base64') !== value) fail('game_asset_data_invalid')
  return result
}

export function createNativeGameAssets({ studio, quotas: suppliedQuotas = {} } = {}) {
  if (!studio || typeof studio.currentState !== 'function' || typeof studio.updateProject !== 'function') fail('game_asset_studio_required')
  if (!plain(suppliedQuotas) || Object.keys(suppliedQuotas).some(key => !['maxCandidates', 'maxTotalBytes'].includes(key))) fail('game_asset_quota_invalid')
  const quotas = { maxCandidates: number(suppliedQuotas.maxCandidates, 128, 1, 1024, true), maxTotalBytes: number(suppliedQuotas.maxTotalBytes, 256 * 1024 * 1024, 1, 1024 * 1024 * 1024, true) }
  const cancelled = args => { if (args.signal?.aborted) fail('game_operation_cancelled') }
  return {
    async generate(args) {
      if (!args || !['drawai', 'any-audio'].includes(args.provider)) fail('game_asset_provider_invalid')
      cancelled(args)
      const payload = args.provider === 'drawai' ? drawing(args.slot, args.recipe) : audio(args.slot, args.recipe)
      cancelled(args)
      return store(args, args.provider, payload, quotas)
    },
    async accept(args) {
      const modelOutput = args?.mime === 'model/gltf-binary'
      if (!args || args.provider !== 'blender' || !(modelOutput ? MODEL_SLOTS : IMAGE_SLOTS).includes(args.slot) || !(modelOutput ? ['model/gltf-binary'] : ['image/png']).includes(args.mime)) fail('game_asset_provider_invalid')
      cancelled(args)
      if (!Array.isArray(args.nativeFiles) || args.nativeFiles.length < 1 || args.nativeFiles.length > 4) fail('game_asset_native_files_invalid')
      const nativeFiles = args.nativeFiles.map(file => {
        if (!plain(file) || !['asset.glb', 'scene.blend', 'report.json', 'job.json', 'preview.png'].includes(file.name)) fail('game_asset_native_files_invalid')
        const data = bytesInput(file.data, file.name.endsWith('.json') ? 128 * 1024 : MAX_NATIVE_BYTES)
        const mime = file.name.endsWith('.json') ? 'application/json' : file.name.endsWith('.glb') ? 'model/gltf-binary' : file.name.endsWith('.png') ? 'image/png' : 'application/x-blender'
        if (file.mime !== undefined && file.mime !== mime) fail('game_asset_mime_invalid')
        if (file.name.endsWith('.json')) { try { JSON.parse(data.toString('utf8')) } catch { fail('game_asset_native_files_invalid') } }
        if (file.name.endsWith('.glb') && (data.length < 12 || data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length)) fail('game_asset_native_files_invalid')
        if (file.name.endsWith('.png')) validateNativeGameAssetOutput('image/png', data)
        if (file.name.endsWith('.blend') && (data.length < 12 || data.toString('ascii', 0, 7) !== 'BLENDER')) fail('game_asset_native_files_invalid')
        return { name: file.name, mime, data }
      })
      const data = bytesInput(args.data, modelOutput ? MAX_MODEL_BYTES : MAX_ASSET_BYTES)
      const outputName = modelOutput ? 'asset.glb' : 'output.png'
      const retainedFiles = modelOutput ? nativeFiles.filter(file => file.name !== 'asset.glb' && file.name !== 'job.json') : nativeFiles
      if (modelOutput && !nativeFiles.some(file => file.name === 'asset.glb' && file.data.equals(data))) fail('game_asset_native_files_invalid')
      return store(args, 'blender', { recipe: metadata(args.recipe ?? {}), output: outputName, source: nativeFiles.some(file => file.name === 'scene.blend') ? 'scene.blend' : retainedFiles[0].name, mime: args.mime, compatibility: metadata(args.compatibility ?? { format: modelOutput ? 'gltf-binary' : 'blender-local-render', scope: modelOutput ? 'three-collector-model' : 'png-runtime-with-native-source', warnings: [] }), origin: metadata(args.origin ?? originalOrigin), files: [{ name: outputName, mime: args.mime, data }, ...retainedFiles] }, quotas)
    },
    list(args) {
      let context
      try { context = candidateContext(args) } catch (error) { if (error.code !== 'ENOENT') throw error; nativeGameFiles.project(args); return [] }
      return readdirSync(context.assets).filter(name => ID.test(name)).sort().map(assetId => readCandidate({ ...args, assetId }).receipt)
    },
    read(args) {
      const candidate = readCandidate(args)
      return { ...candidate.receipt, data: candidate.data.toString('base64'), manifest: candidate.manifest }
    },
    adopt(args) {
      cancelled(args)
      if (!/^[a-f0-9]{12}$/.test(args.expectedBuildId ?? '')) fail('game_asset_expected_build_required')
      const candidate = readCandidate(args)
      const { assetId, slot, hash: outputHash, mime } = candidate.receipt
      const built = studio.readBuild({ ...args, buildId: args.expectedBuildId })
      if (!built.buildCurrent || (args.expectedHash !== undefined && args.expectedHash !== built.hash)) fail('game_asset_build_conflict')
      const state = studio.currentState(args)
      const snapshotManifest = readFile(join(candidate.context.project, '.studio/builds', args.expectedBuildId, 'game.json'), 4 * 1024 * 1024)
      if (state.source !== built.source || state.manifestText !== snapshotManifest || (args.expectedCurrentHash !== undefined && args.expectedCurrentHash !== state.currentHash)) fail('game_asset_build_conflict')
      const manifest = JSON.parse(state.manifestText)
      const assets = { ...(manifest.assets ?? {}), [slot]: { assetId, hash: outputHash, mime, data: candidate.data.toString('base64') } }
      let total = 0
      for (const [key, asset] of Object.entries(assets)) {
        if (![...IMAGE_SLOTS, ...AUDIO_SLOTS].includes(key) || !plain(asset)) fail('game_asset_manifest_invalid')
        const model = MODEL_SLOTS.includes(key), image = IMAGE_SLOTS.includes(key)
        if (!model && !image && !AUDIO_SLOTS.includes(key)) fail('game_asset_manifest_invalid')
        const data = bytesInput(asset.data, model ? MAX_MODEL_BYTES : MAX_ASSET_BYTES); total += data.length
        if (!SHA.test(asset.hash ?? '') || hash(data) !== asset.hash) fail('game_asset_manifest_invalid')
        if ((model && asset.mime !== 'model/gltf-binary') || (image && !asset.mime?.startsWith('image/')) || (!model && !image && asset.mime !== 'audio/wav')) fail('game_asset_manifest_invalid')
        validateNativeGameAssetOutput(asset.mime, data)
      }
      if (total > MAX_EMBEDDED_BYTES) fail('game_asset_embedded_limit')
      const updated = studio.updateProject({ ...args, expectedCurrentHash: state.currentHash, manifest: { ...manifest, assets } })
      return { ...updated, adoptedAsset: { assetId, slot, hash: outputHash, mime }, candidate: candidate.receipt }
    },
  }
}

export const nativeGameAssetsContract = Object.freeze({ maxAssetBytes: MAX_ASSET_BYTES, maxModelBytes: MAX_MODEL_BYTES, maxEmbeddedBytes: MAX_EMBEDDED_BYTES, providers: ['drawai', 'any-audio', 'blender'], imageSlots: IMAGE_SLOTS, modelSlots: MODEL_SLOTS, audioSlots: AUDIO_SLOTS })
