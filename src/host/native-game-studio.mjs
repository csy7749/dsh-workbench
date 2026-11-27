import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Script } from 'node:vm'
import { isDeepStrictEqual } from 'node:util'
import { gameTemplateSource, renderGameHtml, threeGameTemplateSource } from './native-game-template.mjs'
import { validateNativeGameGlb } from './native-game-glb.mjs'
import { CINDERWATCH_TEMPLATE_ID, cinderwatchDefaultRules, cinderwatchTemplateSource, validateCinderwatchRules } from './native-game-cinderwatch.mjs'

const TEMPLATE_ID = 'canvas-collector'
const THREE_TEMPLATE_ID = 'three-collector'
const TEMPLATE_IDS = new Set([TEMPLATE_ID, THREE_TEMPLATE_ID, CINDERWATCH_TEMPLATE_ID])
const TEMPLATE_VERSION = 1
const BUILDER_VERSION = 1
const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 24 * 1024 * 1024
const MAX_HTML_BYTES = 24 * 1024 * 1024
const MAX_ASSET_BYTES = 8 * 1024 * 1024
const DEFAULT_QUOTAS = Object.freeze({ maxBuilds: 100, maxBuildBytes: 256 * 1024 * 1024, maxPlaytests: 100, maxPlaytestBytes: 256 * 1024 * 1024, maxRestoreBackups: 100, maxRestoreBytes: 128 * 1024 * 1024 })
const hash = value => createHash('sha256').update(value).digest('hex')
const stateHash = (manifest, source) => hash(JSON.stringify([hash(manifest), hash(source)]))
const json = value => JSON.stringify(value, null, 2) + '\n'
const fail = code => { throw new Error(code) }

function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug)) fail('game_slug_invalid')
}

function validateProduct(productId) {
  if (typeof productId !== 'string' || !productId.trim() || productId.length > 200) fail('product_id_required')
}

function validateConfig(manifest) {
  if (!manifest || typeof manifest !== 'object') fail('game_manifest_invalid')
  if (typeof manifest.title !== 'string' || !manifest.title.trim() || manifest.title.length > 120 || /[\x00-\x1f]/.test(manifest.title)) fail('game_title_invalid')
  if (!['portrait', 'landscape'].includes(manifest.orientation)) fail('game_orientation_invalid')
  const rules = manifest.rules
  if (manifest.templateId === CINDERWATCH_TEMPLATE_ID) validateCinderwatchRules(rules)
  else if (!rules || !Number.isInteger(rules.durationSeconds) || rules.durationSeconds < 1 || rules.durationSeconds > 300
    || !Number.isInteger(rules.hearts) || rules.hearts < 1 || rules.hearts > 9) fail('game_rules_invalid')
  validateAssets(manifest.assets, manifest.templateId)
}

function validateAssets(assets, templateId) {
  if (assets === undefined) return
  if (!assets || typeof assets !== 'object' || Array.isArray(assets) || Object.getPrototypeOf(assets) !== Object.prototype) fail('game_assets_invalid')
  if (templateId === CINDERWATCH_TEMPLATE_ID && Object.keys(assets).length) fail('game_asset_slot_invalid')
  let total = 0
  for (const [slot, asset] of Object.entries(assets)) {
    const image = ['pickup', 'player', 'enemyCard', 'bossCard', 'cacheCard', 'shrineCard', 'potionCard'].includes(slot)
    const model = ['playerModel', 'pickupModel'].includes(slot) && templateId === THREE_TEMPLATE_ID
    if (!image && !model && !['pickupSound', 'hitSound'].includes(slot)) fail('game_asset_slot_invalid')
    if (!asset || typeof asset !== 'object' || Array.isArray(asset) || Object.keys(asset).sort().join(',') !== 'assetId,data,hash,mime'
      || typeof asset.assetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(asset.assetId)
      || !/^[a-f0-9]{64}$/.test(asset.hash ?? '') || typeof asset.data !== 'string'
      || asset.data.length > 4 * Math.ceil(MAX_ASSET_BYTES / 3)
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)) fail('game_asset_invalid')
    if (!(image ? ['image/svg+xml', 'image/png'] : model ? ['model/gltf-binary'] : ['audio/wav']).includes(asset.mime)) fail('game_asset_mime_invalid')
    const bytes = Buffer.from(asset.data, 'base64')
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES || bytes.toString('base64') !== asset.data || hash(bytes) !== asset.hash) fail('game_asset_integrity_invalid')
    total += bytes.length
    if (total > 2 * MAX_ASSET_BYTES) fail('game_assets_too_large')
    if (asset.mime === 'model/gltf-binary') validateNativeGameGlb(bytes)
    else if (asset.mime === 'image/svg+xml') {
      const text = bytes.toString('utf8')
      if (!Buffer.from(text).equals(bytes) || !/^\s*<svg\b[\s\S]*(?:<\/svg\s*>|\/>)\s*$/i.test(text)
        || /<!|<\?|<\s*(?:script|foreignObject|image|use|iframe|object|embed|style|audio|video)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(|@import/i.test(text)) fail('game_asset_svg_unsafe')
    } else if (asset.mime === 'image/png') {
      if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
        || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096) fail('game_asset_png_invalid')
    } else {
      if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('game_asset_wav_invalid')
      let offset = 12, format, dataBytes = 0
      while (offset + 8 <= bytes.length) {
        const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8
        if (start + size > bytes.length) fail('game_asset_wav_invalid')
        if (type === 'fmt ') {
          if (format || size < 16) fail('game_asset_wav_invalid')
          format = { codec: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8), align: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) }
        }
        if (type === 'data') dataBytes += size
        offset = start + size + (size % 2)
      }
      if (offset !== bytes.length || !format || format.codec !== 1 || ![1, 2].includes(format.channels) || ![8, 16].includes(format.bits)
        || format.rate < 8000 || format.rate > 96000 || format.align !== format.channels * format.bits / 8 || format.byteRate !== format.rate * format.align
        || !dataBytes || dataBytes % format.align || dataBytes / format.byteRate > 30) fail('game_asset_wav_invalid')
    }
  }
}

// Application bounds do not sandbox a hostile process with the same OS permissions.
function directory(path, create = false) {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error
    mkdirSync(path)
    stat = lstatSync(path)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('game_directory_unsafe')
  return path
}

function regularFile(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('game_file_unsafe')
  return stat
}

function readBytes(path, maxBytes) {
  const stat = regularFile(path)
  if (stat.size > maxBytes) fail('game_file_too_large')
  const fd = openSync(path, 'r')
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes || opened.ino !== stat.ino) fail('game_file_changed')
    const value = readFileSync(fd)
    if (value.length > maxBytes) fail('game_file_too_large')
    return value
  } finally { closeSync(fd) }
}
const readFile = (path, maxBytes) => readBytes(path, maxBytes).toString('utf8')

function paths(workspaceRoot, slug, createGames = false) {
  validateSlug(slug)
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) fail('game_workspace_invalid')
  const workspace = realpathSync(workspaceRoot)
  directory(workspace)
  const games = directory(join(workspace, 'games'), createGames)
  return { workspace, games, project: join(games, slug) }
}

function registration(project, productId) {
  directory(project)
  directory(join(project, '.studio'))
  const record = JSON.parse(readFile(join(project, '.studio/project.json'), 16 * 1024))
  if (!record || record.schemaVersion !== 1 || typeof record.projectId !== 'string' || !/^[a-f0-9-]{36}$/.test(record.projectId)) fail('game_registration_invalid')
  if (record.productId !== productId) fail('game_product_mismatch')
  return record
}

function registeredProject({ workspaceRoot, productId, slug }) {
  validateProduct(productId)
  const { workspace, project } = paths(workspaceRoot, slug)
  const record = registration(project, productId)
  return { workspace, project, record, portable: path => relative(workspace, path).split(sep).join('/') }
}

function currentInput(project) {
  const manifestBytes = readBytes(join(project, 'game.json'), MAX_MANIFEST_BYTES), sourceBytes = readBytes(join(project, 'game.js'), MAX_SOURCE_BYTES)
  const manifestText = manifestBytes.toString('utf8'), source = sourceBytes.toString('utf8')
  let manifest = null
  try { manifest = JSON.parse(manifestText) } catch { /* Raw hashes still permit guarded recovery of a damaged workcopy. */ }
  const value = { manifest, manifestText, source, sourceHash: hash(sourceBytes), manifestHash: hash(manifestBytes), currentHash: stateHash(manifestBytes, sourceBytes) }
  return Object.defineProperties(value, { manifestBytes: { value: manifestBytes }, sourceBytes: { value: sourceBytes } })
}

function validateInput(manifestText, source, record) {
  if (typeof manifestText !== 'string' || Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) fail('game_file_too_large')
  const manifest = JSON.parse(manifestText)
  if (!manifest || manifest.schemaVersion !== 1 || manifest.projectId !== record.projectId || !TEMPLATE_IDS.has(manifest.templateId)
    || manifest.templateVersion !== TEMPLATE_VERSION) fail('game_manifest_invalid')
  validateConfig(manifest)
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_SOURCE_BYTES) fail('game_file_too_large')
  if (Buffer.from(source).toString('utf8') !== source || Buffer.from(manifestText).toString('utf8') !== manifestText) fail('game_file_encoding_invalid')
  if (!source.trim()) fail('game_source_empty')
  // Parse only: never execute generated game code in the host process.
  try { new Script(source, { filename: 'game.js' }) } catch { fail('game_source_syntax_invalid') }
  if (/<\/script|<!--|<script[\s>]/i.test(source)) fail('game_source_html_delimiter')
  return { manifest, manifestText, source }
}

function projectInput(project, record) {
  const current = currentInput(project)
  if (!Buffer.from(current.manifestText).equals(current.manifestBytes) || !Buffer.from(current.source).equals(current.sourceBytes)) fail('game_file_encoding_invalid')
  return validateInput(current.manifestText, current.source, record)
}

function atomicFile(path, content) {
  try { regularFile(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, content, { flag: 'wx' })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

function lockOwner(text) {
  let owner
  try { owner = JSON.parse(text) } catch { return null }
  if (!owner || owner.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(owner.token ?? '')
    || !Number.isInteger(owner.pid) || owner.pid < 1 || owner.pid > 2147483647
    || typeof owner.createdAt !== 'string' || !Number.isFinite(Date.parse(owner.createdAt)) || Date.parse(owner.createdAt) > Date.now() + 5000) return null
  return owner
}

const deadPid = pid => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }
function releaseOwnedLock(path, token) {
  try {
    const owner = lockOwner(readFile(path, 4096))
    if (owner?.token === token) unlinkSync(path)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function acquireBuildLock(project) {
  const studio = directory(join(project, '.studio')), path = join(studio, 'build.lock'), guard = join(studio, 'build-recovery.lock')
  const token = randomUUID(), owner = { schemaVersion: 1, token, pid: process.pid, createdAt: new Date().toISOString() }
  // A crashed recovery claim is deliberately fail-closed and requires inspection.
  try { lstatSync(guard); fail('game_build_busy') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const claim = () => {
    const fd = openSync(path, 'wx')
    try { writeFileSync(fd, json(owner)) } catch (error) { closeSync(fd); try { unlinkSync(path) } catch {}; throw error }
    closeSync(fd)
  }
  try { claim() } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let prior
    try { prior = lockOwner(readFile(path, 4096)) } catch { fail('game_build_busy') }
    if (!prior || !deadPid(prior.pid)) fail('game_build_busy')
    let guardFd
    try { guardFd = openSync(guard, 'wx') } catch (conflict) { if (conflict.code === 'EEXIST') fail('game_build_busy'); throw conflict }
    try {
      writeFileSync(guardFd, json(owner))
      const fresh = lockOwner(readFile(path, 4096))
      if (!fresh || fresh.token !== prior.token || !deadPid(fresh.pid)) fail('game_build_busy')
      unlinkSync(path)
      try { claim() } catch (conflict) { if (conflict.code === 'EEXIST') fail('game_build_busy'); throw conflict }
    } finally { closeSync(guardFd); releaseOwnedLock(guard, token) }
  }
  return () => releaseOwnedLock(path, token)
}

function quotaUsage(path) {
  try { directory(path) } catch (error) { if (error.code === 'ENOENT') return { count: 0, bytes: 0 }; throw error }
  let files = 0
  function size(folder, depth = 0) {
    if (depth > 3) fail('game_storage_unsafe')
    let bytes = 0
    for (const name of readdirSync(folder)) {
      if (++files > 10000) fail('game_storage_quota_exceeded')
      const file = join(folder, name), stat = lstatSync(file)
      if (stat.isSymbolicLink()) fail('game_storage_unsafe')
      if (stat.isDirectory()) bytes += size(directory(file), depth + 1)
      else bytes += regularFile(file).size
    }
    return bytes
  }
  return { count: readdirSync(path).length, bytes: size(path) }
}

function checkQuota(path, additionalBytes, maxCount, maxBytes, code) {
  const usage = quotaUsage(path)
  if (usage.count >= maxCount || usage.bytes + additionalBytes > maxBytes) fail(code)
}

function prepareBuild(project, record, quotas, input = projectInput(project, record), existingOnly = false) {
  const { manifest, manifestText, source } = input
  const html = renderGameHtml(manifest, source)
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) fail('game_file_too_large')
  const inputHash = hash(JSON.stringify([BUILDER_VERSION, manifestText, source, html])), buildId = inputHash.slice(0, 12)
  const builds = join(project, '.studio/builds'), snapshot = join(builds, buildId)
  const receipt = { schemaVersion: 1, builderVersion: BUILDER_VERSION, projectId: record.projectId, buildId, inputHash, hash: hash(html), bytes: Buffer.byteLength(html) }
  let reused = false
  let exists = false
  try { directory(builds); directory(snapshot); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (exists) {
    try {
      if (readFile(join(snapshot, 'build.json'), 16 * 1024) !== json(receipt)
        || readFile(join(snapshot, 'game.json'), MAX_MANIFEST_BYTES) !== manifestText
        || readFile(join(snapshot, 'game.js'), MAX_SOURCE_BYTES) !== source
        || readFile(join(snapshot, 'index.html'), MAX_HTML_BYTES) !== html) fail('game_build_snapshot_conflict')
      reused = true
    } catch (error) { if (error.code === 'ENOENT') fail('game_build_snapshot_conflict'); throw error }
  }
  if (!reused && existingOnly) fail('game_update_backup_build_missing')
  if (!reused) checkQuota(builds, Buffer.byteLength(manifestText) + Buffer.byteLength(source) + Buffer.byteLength(html) + Buffer.byteLength(json(receipt)), quotas.maxBuilds, quotas.maxBuildBytes, 'game_build_quota_exceeded')
  return { ...input, html, builds, snapshot, receipt, reused }
}

function publishBuild(project, prepared) {
  const { manifest, manifestText, source, html, builds, snapshot, receipt, reused } = prepared
  const studio = directory(join(project, '.studio'))
  if (!reused) {
    directory(builds, true)
    const pending = join(builds, '.pending-' + randomUUID())
    mkdirSync(pending)
    try {
      for (const [name, value] of [['game.json', manifestText], ['game.js', source], ['index.html', html], ['build.json', json(receipt)]]) writeFileSync(join(pending, name), value, { flag: 'wx' })
      renameSync(pending, snapshot)
    } finally { rmSync(pending, { recursive: true, force: true }) }
  }
  const dist = directory(join(project, 'dist'), true)
  atomicFile(join(dist, 'index.html'), html)
  atomicFile(join(studio, 'latest.json'), json(receipt))
  return { ...receipt, title: manifest.title, template: manifest.templateId, reused, buildStatus: 'built', playtestStatus: 'not_assessed' }
}

function buildProject(project, record, quotas) {
  const release = acquireBuildLock(project)
  try { return publishBuild(project, prepareBuild(project, record, quotas)) }
  finally { release() }
}

function updateProject(args, quotas, restore = false) {
  const p = registeredProject(args), release = acquireBuildLock(p.project)
  try {
    const before = currentInput(p.project)
    if (!/^[a-f0-9]{64}$/.test(args.expectedCurrentHash ?? '') || before.currentHash !== args.expectedCurrentHash) fail('game_current_hash_conflict')
    const restored = restore ? readBuild(args, true) : null
    let manifestText = before.manifestText
    if (restore) manifestText = restored.manifestText
    else if (args.manifest !== undefined) {
      if (!before.manifest || !args.manifest || typeof args.manifest !== 'object') fail('game_manifest_invalid')
      const { assets: oldAssets, ...oldConfig } = before.manifest
      const { assets: newAssets, ...newConfig } = args.manifest
      if (!isDeepStrictEqual(oldConfig, newConfig)) fail('game_approved_config_changed')
      manifestText = json(args.manifest)
    }
    const source = restore ? restored.source : args.source === undefined ? before.source : args.source
    const input = validateInput(manifestText, source, p.record), prepared = prepareBuild(p.project, p.record, quotas, input)
    const nextHash = stateHash(manifestText, source)
    if (nextHash === before.currentHash) return { ...result(p.workspace, p.project, args.slug, args.productId, publishBuild(p.project, prepared)), currentHash: nextHash, sourceHash: before.sourceHash, manifestHash: before.manifestHash, unchanged: true, restored: !!restore }
    const backups = join(p.project, '.studio/restore-backups'), id = randomUUID(), backup = join(backups, id)
    const log = { schemaVersion: 1, operation: restore ? 'restore' : 'update', projectId: p.record.projectId, productId: args.productId, beforeHash: before.currentHash, afterHash: nextHash,
      beforeSourceHash: before.sourceHash, beforeManifestHash: before.manifestHash, afterSourceHash: hash(source), afterManifestHash: hash(manifestText), createdAt: new Date().toISOString(), ...(restore ? { buildId: args.buildId } : {}) }
    checkQuota(backups, before.manifestBytes.length + before.sourceBytes.length + Buffer.byteLength(json(log)), quotas.maxRestoreBackups, quotas.maxRestoreBytes, 'game_restore_quota_exceeded')
    // Check all publication targets and freeze recovery data before changing workcopy.
    directory(join(p.project, 'dist'), true)
    for (const file of [join(p.project, 'dist/index.html'), join(p.project, '.studio/latest.json')]) {
      try { regularFile(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    directory(backups, true); mkdirSync(backup)
    writeFileSync(join(backup, 'game.json'), before.manifestBytes, { flag: 'wx' })
    writeFileSync(join(backup, 'game.js'), before.sourceBytes, { flag: 'wx' })
    writeFileSync(join(backup, 'restore.json'), json(log), { flag: 'wx' })
    if (currentInput(p.project).currentHash !== before.currentHash) fail('game_current_hash_conflict')
    return applyPreparedUpdate(p, args, quotas, before, prepared, { backupPath: p.portable(backup), restored: !!restore })
  } finally { release() }
}

function applyPreparedUpdate(p, args, quotas, before, prepared, metadata) {
  const { manifestText, source } = prepared, nextHash = stateHash(manifestText, source)
  let ownedHash = before.currentHash, ownedSource = before.sourceBytes
  try {
    if (!Buffer.from(manifestText).equals(before.manifestBytes)) {
      atomicFile(join(p.project, 'game.json'), manifestText)
      ownedHash = stateHash(manifestText, before.sourceBytes)
    }
    if (currentInput(p.project).currentHash !== ownedHash) fail('game_update_rollback_conflict')
    if (!Buffer.from(source).equals(before.sourceBytes)) {
      atomicFile(join(p.project, 'game.js'), source)
      ownedHash = nextHash; ownedSource = source
    }
    if (currentInput(p.project).currentHash !== ownedHash) fail('game_update_rollback_conflict')
    const built = publishBuild(p.project, prepared)
    if (currentInput(p.project).currentHash !== nextHash) fail('game_update_rollback_conflict')
    return { ...result(p.workspace, p.project, args.slug, args.productId, built), currentHash: nextHash, sourceHash: hash(source), manifestHash: hash(manifestText), ...metadata }
  } catch (error) {
    if (currentInput(p.project).currentHash !== ownedHash) fail('game_update_rollback_conflict')
    atomicFile(join(p.project, 'game.json'), before.manifestBytes)
    if (currentInput(p.project).currentHash !== stateHash(before.manifestBytes, ownedSource)) fail('game_update_rollback_conflict')
    atomicFile(join(p.project, 'game.js'), before.sourceBytes)
    if (currentInput(p.project).currentHash !== before.currentHash) fail('game_update_rollback_conflict')
    // Restore the prior valid preview when possible, never overwrite an external edit.
    try { publishBuild(p.project, prepareBuild(p.project, p.record, quotas)) } catch { /* Backup remains available if the previous workcopy was already invalid. */ }
    throw error
  }
}

function rollbackUpdate(args, quotas) {
  const p = registeredProject(args), release = acquireBuildLock(p.project)
  try {
    const current = currentInput(p.project)
    if (!/^[a-f0-9]{64}$/.test(args.expectedCurrentHash ?? '') || current.currentHash !== args.expectedCurrentHash) fail('game_current_hash_conflict')
    if (!/^[a-f0-9]{64}$/.test(args.beforeHash ?? '')) fail('game_update_backup_invalid')
    const root = directory(join(p.project, '.studio/restore-backups')), prefix = p.portable(root) + '/'
    const read = id => {
      if (!/^[a-f0-9-]{36}$/.test(id)) fail('game_update_backup_invalid')
      const folder = directory(join(root, id)), log = JSON.parse(readFile(join(folder, 'restore.json'), 16 * 1024))
      if (!log || log.schemaVersion !== 1 || !['update', 'restore'].includes(log.operation) || log.projectId !== p.record.projectId || log.productId !== args.productId
        || [log.beforeHash, log.afterHash, log.beforeSourceHash, log.beforeManifestHash, log.afterSourceHash, log.afterManifestHash].some(value => !/^[a-f0-9]{64}$/.test(value ?? ''))
        || log.beforeHash !== args.beforeHash || log.afterHash !== current.currentHash
        || log.afterSourceHash !== current.sourceHash || log.afterManifestHash !== current.manifestHash) fail('game_update_backup_integrity_invalid')
      const manifestBytes = readBytes(join(folder, 'game.json'), MAX_MANIFEST_BYTES), sourceBytes = readBytes(join(folder, 'game.js'), MAX_SOURCE_BYTES)
      if (hash(manifestBytes) !== log.beforeManifestHash || hash(sourceBytes) !== log.beforeSourceHash || stateHash(manifestBytes, sourceBytes) !== log.beforeHash) fail('game_update_backup_integrity_invalid')
      if (!Buffer.from(manifestBytes.toString('utf8')).equals(manifestBytes) || !Buffer.from(sourceBytes.toString('utf8')).equals(sourceBytes)) fail('game_file_encoding_invalid')
      return { folder, manifestBytes, sourceBytes, input: validateInput(manifestBytes.toString('utf8'), sourceBytes.toString('utf8'), p.record) }
    }
    let backup
    if (args.backupPath !== undefined) {
      if (typeof args.backupPath !== 'string' || !args.backupPath.startsWith(prefix)) fail('game_update_backup_invalid')
      backup = read(args.backupPath.slice(prefix.length))
    } else {
      const names = readdirSync(root)
      if (names.length > 10000) fail('game_storage_quota_exceeded')
      const matches = []
      for (const id of names.sort()) {
        try { matches.push(read(id)) } catch { /* An unrelated or incomplete backup is never a recovery source. */ }
      }
      if (!matches.length) fail('game_update_backup_not_found')
      backup = matches[0]
      if (matches.some(value => !value.sourceBytes.equals(backup.sourceBytes) || !value.manifestBytes.equals(backup.manifestBytes))) fail('game_update_backup_ambiguous')
    }
    // Recovery never allocates another backup or new immutable build. The verified
    // original build must already exist, so a full quota cannot strand a trial.
    const prepared = prepareBuild(p.project, p.record, quotas, backup.input, true)
    if (currentInput(p.project).currentHash !== current.currentHash) fail('game_current_hash_conflict')
    return applyPreparedUpdate(p, args, quotas, current, prepared, { backupPath: p.portable(backup.folder), rolledBack: true, restored: true })
  } finally { release() }
}

function result(workspace, project, slug, productId, build) {
  const portable = path => relative(workspace, path).split(sep).join('/')
  return { ...build, productId, slug, project: portable(project), artifact: portable(join(project, '.studio/builds', build.buildId, 'index.html')), previewAvailable: false }
}

function readBuild({ workspaceRoot, productId, slug, buildId }, internal = false) {
  validateProduct(productId)
  if (typeof buildId !== 'string' || !/^[a-f0-9]{12}$/.test(buildId)) fail('game_build_id_invalid')
  const { workspace, project } = paths(workspaceRoot, slug)
  const record = registration(project, productId)
  const builds = directory(join(project, '.studio/builds'))
  const snapshot = directory(join(builds, buildId))
  const { manifest, manifestText, source } = projectInput(snapshot, record)
  const html = readFile(join(snapshot, 'index.html'), MAX_HTML_BYTES)
  const receipt = JSON.parse(readFile(join(snapshot, 'build.json'), 16 * 1024))
  const inputHash = hash(JSON.stringify([BUILDER_VERSION, manifestText, source, html]))
  const expected = { schemaVersion: 1, builderVersion: BUILDER_VERSION, projectId: record.projectId, buildId, inputHash, hash: hash(html), bytes: Buffer.byteLength(html) }
  if (buildId !== inputHash.slice(0, 12) || html !== renderGameHtml(manifest, source)
    || !receipt || Object.keys(expected).some(key => receipt[key] !== expected[key])) fail('game_build_integrity_invalid')
  let buildCurrent = false
  try {
    const current = projectInput(project, record)
    buildCurrent = current.manifestText === manifestText && current.source === source
  } catch { /* A valid historical snapshot remains readable. */ }
  return { ...result(workspace, project, slug, productId, expected), title: manifest.title, template: manifest.templateId, buildStatus: 'built', buildCurrent, sourceHash: hash(source), manifestHash: hash(manifestText), html, manifest, source, ...(internal ? { manifestText } : {}) }
}

export function createNativeGameStudio({ quotas: configured = {} } = {}) {
  if (!configured || typeof configured !== 'object' || Array.isArray(configured) || Object.keys(configured).some(key => !Object.hasOwn(DEFAULT_QUOTAS, key))) fail('game_quota_invalid')
  const quotas = { ...DEFAULT_QUOTAS, ...configured }
  if (Object.values(quotas).some(value => !Number.isSafeInteger(value) || value < 0)) fail('game_quota_invalid')
  return {
    readBuild,
    listProjects({ workspaceRoot, productId }) {
      validateProduct(productId)
      if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) fail('game_workspace_invalid')
      const workspace = realpathSync(workspaceRoot)
      directory(workspace)
      const games = join(workspace, 'games')
      try { directory(games) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
      const projects = []
      for (const entry of readdirSync(games, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const slug = entry.name
        let record
        // A shared workspace is not shared ownership. Unregistered directories,
        // unsafe names and another product's games are never exposed here.
        try { validateSlug(slug); record = registration(join(games, slug), productId) } catch { continue }
        try {
          const args = { workspaceRoot: workspace, productId, slug }
          const current = currentInput(join(games, slug))
          const built = this.listBuilds(args).find(item => item.valid && item.buildCurrent)
          projects.push({ slug, projectId: record.projectId, title: current.manifest?.title ?? slug, template: current.manifest?.templateId ?? '', buildCurrent: !!built,
            ...(built ? { buildId: built.buildId, bytes: built.bytes } : {}) })
        } catch (error) { projects.push({ slug, projectId: record.projectId, title: slug, error: /^(?:game|product)_[a-z0-9_]+$/.test(error.message) ? error.message : 'game_project_unavailable' }) }
      }
      return projects
    },
    currentState(args) {
      const p = registeredProject(args)
      return { productId: args.productId, slug: args.slug, projectId: p.record.projectId, project: p.portable(p.project), ...currentInput(p.project) }
    },
    updateProject(args) { return updateProject(args, quotas) },
    rollbackUpdate(args) { return rollbackUpdate(args, quotas) },
    listBuilds(args) {
      const p = registeredProject(args), builds = join(p.project, '.studio/builds')
      try { directory(builds) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
      return readdirSync(builds).filter(name => !name.startsWith('.pending-')).sort().map(buildId => {
        try {
          const { html, source, manifest, ...build } = readBuild({ ...args, buildId })
          return { ...build, valid: true, playtestStatus: 'not_assessed' }
        } catch (error) { return { buildId, valid: false, error: error.message } }
      })
    },
    compareBuilds(args) {
      const from = readBuild({ ...args, buildId: args.fromBuildId }, true), to = readBuild({ ...args, buildId: args.toBuildId }, true)
      const a = from.source.split('\n'), b = to.source.split('\n')
      let start = 0, end = 0
      while (start < a.length && start < b.length && a[start] === b[start]) start++
      while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
      const sourceChanged = from.source !== to.source, manifestChanged = from.manifestText !== to.manifestText
      return { fromBuildId: from.buildId, toBuildId: to.buildId, sourceChanged, manifestChanged,
        source: { fromHash: hash(from.source), toHash: hash(to.source), changed: sourceChanged, removedLines: sourceChanged ? a.length - start - end : 0, addedLines: sourceChanged ? b.length - start - end : 0 },
        manifest: { fromHash: hash(from.manifestText), toHash: hash(to.manifestText), changed: manifestChanged, changedFields: [...new Set([...Object.keys(from.manifest), ...Object.keys(to.manifest)])].filter(key => !isDeepStrictEqual(from.manifest[key], to.manifest[key])) } }
    },
    restoreBuild(args) {
      return updateProject(args, quotas, true)
    },
    readPlaytest({ reportPath, reportHash, ...args }) {
      const built = readBuild(args)
      const prefix = built.project + '/.studio/playtests/'
      if (typeof reportPath !== 'string' || !reportPath.startsWith(prefix)
        || !/^[a-f0-9-]{36}\/report\.json$/.test(reportPath.slice(prefix.length))
        || !/^[a-f0-9]{64}$/.test(reportHash ?? '')) fail('game_playtest_identity_invalid')
      const { workspace, project } = paths(args.workspaceRoot, args.slug)
      const parent = directory(join(project, '.studio/playtests'))
      const folder = directory(join(parent, reportPath.slice(prefix.length).split('/')[0]))
      const text = readFile(join(folder, 'report.json'), 256 * 1024)
      if (hash(text) !== reportHash) fail('game_playtest_integrity_invalid')
      const report = JSON.parse(text)
      if (!report || report.projectId !== built.projectId || report.productId !== built.productId
        || report.buildId !== built.buildId || report.hash !== built.hash || report.bytes !== built.bytes
        || report.reportPath !== reportPath || !Array.isArray(report.screenshots) || !report.screenshotHashes
        || report.screenshots.length > 4) fail('game_playtest_integrity_invalid')
      for (const file of report.screenshots) {
        const name = typeof file === 'string' ? file.slice(report.runDir.length + 1) : ''
        if (file !== report.runDir + '/' + name || !/^[a-z][a-z0-9-]{0,40}\.png$/.test(name)
          || relative(workspace, join(folder, name)).split(sep).join('/') !== file
          || hash(readBytes(join(folder, name), 8 * 1024 * 1024)) !== report.screenshotHashes[file]) fail('game_playtest_integrity_invalid')
      }
      return { ...report, reportHash, buildCurrent: built.buildCurrent }
    },
    exportBuild(args) {
      const built = readBuild(args)
      const { workspace, project } = paths(args.workspaceRoot, args.slug)
      const exports = directory(join(project, 'exports'), true)
      const file = join(exports, built.buildId + '.html')
      let reused = false
      try {
        if (readFile(file, MAX_HTML_BYTES) !== built.html) fail('game_export_conflict')
        reused = true
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        // Exclusive creation never overwrites a conflicting export.
        const pending = join(exports, '.pending-' + randomUUID())
        try { writeFileSync(pending, built.html, { flag: 'wx' }); renameSync(pending, file) }
        finally { rmSync(pending, { force: true }) }
      }
      const { html, source, manifest, ...evidence } = built
      const exportPath = relative(workspace, file).split(sep).join('/')
      return { ...evidence, exportPath, file: exportPath, exported: true, offline: true, reused }
    },
    recordPlaytest({ report, screenshots = [], ...args }) {
      let built = readBuild(args)
      if (!report || typeof report !== 'object' || !Array.isArray(screenshots) || screenshots.length > 4) fail('game_playtest_report_invalid')
      let total = 0
      const names = new Set()
      for (const shot of screenshots) {
        if (!shot || !/^[a-z][a-z0-9-]{0,40}\.png$/.test(shot.name) || names.has(shot.name)
          || !Buffer.isBuffer(shot.data) || shot.data.length > 8 * 1024 * 1024
          || !shot.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('game_playtest_screenshot_invalid')
        total += shot.data.length; names.add(shot.name)
      }
      if (total > 16 * 1024 * 1024) fail('game_playtest_report_too_large')
      const { workspace, project } = paths(args.workspaceRoot, args.slug)
      const release = acquireBuildLock(project)
      try {
      built = readBuild(args)
      const parent = join(project, '.studio/playtests')
      const id = randomUUID(), final = join(parent, id), pending = join(parent, '.pending-' + id)
      const portable = path => relative(workspace, path).split(sep).join('/')
      const files = screenshots.map(shot => portable(join(final, shot.name)))
      const evidence = { ...report, summary: String(report.summary ?? '').replace(/Screenshots:.*$/, 'Screenshots: ' + (files.join(', ') || 'none')), schemaVersion: 1, productId: built.productId, projectId: built.projectId, slug: built.slug, project: built.project, buildId: built.buildId, hash: built.hash, bytes: built.bytes, buildCurrent: built.buildCurrent, runDir: portable(final), reportPath: portable(join(final, 'report.json')), screenshots: files, screenshotHashes: Object.fromEntries(screenshots.map((shot, i) => [files[i], hash(shot.data)])) }
      const text = json(evidence)
      if (Buffer.byteLength(text) > 256 * 1024) fail('game_playtest_report_too_large')
      checkQuota(parent, Buffer.byteLength(text) + total, quotas.maxPlaytests, quotas.maxPlaytestBytes, 'game_playtest_quota_exceeded')
      directory(parent, true)
      mkdirSync(pending)
      try {
        writeFileSync(join(pending, 'report.json'), text, { flag: 'wx' })
        for (const shot of screenshots) writeFileSync(join(pending, shot.name), shot.data, { flag: 'wx' })
        renameSync(pending, final)
      } finally { rmSync(pending, { recursive: true, force: true }) }
      return { ...evidence, reportHash: hash(text) }
      } finally { release() }
    },
    create({ workspaceRoot, productId, slug, title, orientation = 'portrait', rules, template = TEMPLATE_ID }) {
      validateProduct(productId)
      if (!TEMPLATE_IDS.has(template)) fail('game_template_unavailable')
      if (rules === undefined) rules = template === CINDERWATCH_TEMPLATE_ID ? { ...cinderwatchDefaultRules } : { durationSeconds: 15, hearts: 3 }
      validateConfig({ title, orientation, rules, templateId: template })
      const { workspace, games, project } = paths(workspaceRoot, slug, true)
      try { lstatSync(project); fail('game_project_exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
      const staging = join(games, '.create-' + randomUUID())
      mkdirSync(staging)
      try {
        const record = { schemaVersion: 1, projectId: randomUUID(), productId }
        const manifest = { schemaVersion: 1, projectId: record.projectId, title: title.trim(), templateId: template, templateVersion: TEMPLATE_VERSION, orientation, rules }
        mkdirSync(join(staging, '.studio'))
        writeFileSync(join(staging, '.studio/project.json'), json(record), { flag: 'wx' })
        writeFileSync(join(staging, 'game.json'), json(manifest), { flag: 'wx' })
        writeFileSync(join(staging, 'game.js'), template === CINDERWATCH_TEMPLATE_ID ? cinderwatchTemplateSource() : template === THREE_TEMPLATE_ID ? threeGameTemplateSource : gameTemplateSource, { flag: 'wx' })
        const build = buildProject(staging, record, quotas)
        renameSync(staging, project)
        return result(workspace, project, slug, productId, build)
      } finally { rmSync(staging, { recursive: true, force: true }) }
    },
    build({ workspaceRoot, productId, slug }) {
      validateProduct(productId)
      const { workspace, project } = paths(workspaceRoot, slug)
      const record = registration(project, productId)
      return result(workspace, project, slug, productId, buildProject(project, record, quotas))
    },
  }
}

export const nativeGameFiles = Object.freeze({ project: registeredProject, directory, regularFile, readBytes, readFile, atomicFile, hash, json })
export const nativeGameStudioContract = Object.freeze({ templateId: TEMPLATE_ID, templateIds: [...TEMPLATE_IDS], threeTemplateId: THREE_TEMPLATE_ID, cinderwatchTemplateId: CINDERWATCH_TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, builderVersion: BUILDER_VERSION, maxSourceBytes: MAX_SOURCE_BYTES, maxManifestBytes: MAX_MANIFEST_BYTES, maxHtmlBytes: MAX_HTML_BYTES, maxAssetBytes: MAX_ASSET_BYTES, maxTotalAssetBytes: 2 * MAX_ASSET_BYTES, quotas: DEFAULT_QUOTAS })
