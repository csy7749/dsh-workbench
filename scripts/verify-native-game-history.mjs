/** Filesystem integrity and transaction tests only; synthetic PNG/report fixtures
 * are not browser, Blender, provider, or gameplay acceptance evidence. */
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeGameStudio, nativeGameFiles as files, nativeGameStudioContract } from '../src/host/native-game-studio.mjs'

const workspaceRoot = mkdtempSync(join(tmpdir(), 'native-game-history-'))
const studio = createNativeGameStudio(), productId = 'history-fixture'
const target = { workspaceRoot, productId, slug: 'history-game' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDXkAAAAASUVORK5CYII=', 'base64')
const owner = pid => files.json({ schemaVersion: 1, token: randomUUID(), pid, createdAt: new Date().toISOString() })
const asset = (mime, data) => ({ assetId: files.hash(data).slice(0, 16), hash: files.hash(data), mime, data: data.toString('base64') })
const wav = (frames = 64) => {
  const data = Buffer.alloc(44 + frames * 4)
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(22050, 24)
  data.writeUInt32LE(22050 * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 4, 40)
  return data
}
const injectRename = callback => {
  const original = fs.renameSync
  fs.renameSync = (from, to) => callback(from, to, original)
  syncBuiltinESMExports()
  return () => { fs.renameSync = original; syncBuiltinESMExports() }
}

try {
  const first = studio.create({ ...target, title: '版本事务测试' })
  const project = join(workspaceRoot, first.project), sourcePath = join(project, 'game.js'), manifestPath = join(project, 'game.json')
  const latestPath = join(project, '.studio/latest.json'), distPath = join(project, 'dist/index.html'), lock = join(project, '.studio/build.lock')
  const original = studio.currentState(target)
  const disk = () => [manifestPath, sourcePath, distPath, latestPath].map(file => readFileSync(file, 'utf8'))
  assert.equal(original.sourceHash, files.hash(original.source))
  assert.equal(original.manifestHash, files.hash(original.manifestText))
  assert.equal(original.currentHash, files.hash(JSON.stringify([original.manifestHash, original.sourceHash])))
  assert.equal(files.project(target).record.projectId, first.projectId)
  assert.equal(files.project(target).portable(project), first.project)
  assert.throws(() => files.project({ ...target, productId: 'other' }), /game_product_mismatch/)
  assert.throws(() => files.project({ ...target, slug: '../escape' }), /game_slug_invalid/)
  const baselineDisk = disk()
  assert.throws(() => studio.updateProject({ ...target, expectedCurrentHash: original.currentHash, source: '(() => {' }), /game_source_syntax_invalid/)
  assert.throws(() => studio.updateProject({ ...target, expectedCurrentHash: original.currentHash, source: '</script>' }), /game_source_syntax_invalid|game_source_html_delimiter/)
  assert.throws(() => studio.updateProject({ ...target, expectedCurrentHash: original.currentHash, manifest: { ...original.manifest, title: 'unapproved' } }), /game_approved_config_changed/)
  assert.deepEqual(disk(), baselineDisk, 'validation failures do not mutate workcopy or previews')

  const second = studio.updateProject({ ...target, expectedCurrentHash: original.currentHash, source: original.source + '\n// verified revision fixture\n' })
  assert.notEqual(second.buildId, first.buildId)
  assert.equal(second.playtestStatus, 'not_assessed')
  assert.equal(readFileSync(join(workspaceRoot, second.backupPath, 'game.js'), 'utf8'), original.source)
  const current = studio.currentState(target)
  assert.equal(second.currentHash, current.currentHash)
  const afterSecond = disk(), backupCount = readdirSync(join(project, '.studio/restore-backups')).length
  assert.throws(() => studio.updateProject({ ...target, expectedCurrentHash: original.currentHash, source: original.source }), /game_current_hash_conflict/)
  assert.throws(() => studio.restoreBuild({ ...target, buildId: first.buildId, expectedCurrentHash: original.currentHash }), /game_current_hash_conflict/)
  assert.deepEqual(disk(), afterSecond)
  assert.equal(readdirSync(join(project, '.studio/restore-backups')).length, backupCount)
  const history = studio.listBuilds(target)
  assert.equal(history.length, 2)
  assert(history.every(build => build.valid && build.playtestStatus === 'not_assessed'))
  const diff = studio.compareBuilds({ ...target, fromBuildId: first.buildId, toBuildId: second.buildId })
  assert.equal(diff.sourceChanged, true); assert.equal(diff.manifestChanged, false)
  assert(diff.source.addedLines > 0); assert.deepEqual(diff.manifest.changedFields, [])
  const restored = studio.restoreBuild({ ...target, buildId: first.buildId, expectedCurrentHash: current.currentHash })
  assert.equal(restored.buildId, first.buildId); assert.equal(restored.restored, true); assert.equal(restored.playtestStatus, 'not_assessed')
  assert.deepEqual(disk(), baselineDisk)

  writeFileSync(sourcePath, '(() => {')
  const damaged = studio.currentState(target)
  assert.equal(studio.readBuild({ ...target, buildId: first.buildId }).buildCurrent, false)
  studio.restoreBuild({ ...target, buildId: first.buildId, expectedCurrentHash: damaged.currentHash })
  assert.deepEqual(disk(), baselineDisk, 'verified restore repairs a malformed workcopy')
  writeFileSync(sourcePath, Buffer.from([0xff]))
  const nonUtf8 = studio.currentState(target)
  assert.equal(nonUtf8.sourceHash, files.hash(Buffer.from([0xff])))
  writeFileSync(sourcePath, Buffer.from([0xfe]))
  assert.notEqual(studio.currentState(target).currentHash, nonUtf8.currentHash, 'CAS distinguishes damaged UTF-8 byte sequences')
  assert.throws(() => studio.build(target), /game_file_encoding_invalid/)
  studio.restoreBuild({ ...target, buildId: first.buildId, expectedCurrentHash: studio.currentState(target).currentHash })
  assert.deepEqual(disk(), baselineDisk)
  const secondArtifact = join(workspaceRoot, second.artifact), savedArtifact = readFileSync(secondArtifact)
  writeFileSync(secondArtifact, 'tampered snapshot')
  assert.equal(studio.listBuilds(target).find(build => build.buildId === second.buildId).valid, false)
  assert.throws(() => studio.restoreBuild({ ...target, buildId: second.buildId, expectedCurrentHash: original.currentHash }), /game_build_integrity_invalid/)
  assert.deepEqual(disk(), baselineDisk)
  writeFileSync(secondArtifact, savedArtifact)
  const secondReceipt = join(project, '.studio/builds', second.buildId, 'build.json'), savedReceipt = readFileSync(secondReceipt)
  rmSync(secondReceipt)
  writeFileSync(sourcePath, current.source)
  assert.throws(() => studio.build(target), /game_build_snapshot_conflict/, 'missing snapshot files cannot be silently recreated')
  assert.equal(existsSync(secondReceipt), false)
  writeFileSync(secondReceipt, savedReceipt)
  studio.restoreBuild({ ...target, buildId: first.buildId, expectedCurrentHash: studio.currentState(target).currentHash })

  for (const contents of ['', 'legacy owner', owner(process.pid), files.json({ schemaVersion: 1, pid: process.pid })]) {
    writeFileSync(lock, contents)
    assert.throws(() => studio.build(target), /game_build_busy/)
    assert.equal(readFileSync(lock, 'utf8'), contents)
    rmSync(lock)
  }
  let dead
  for (const pid of [2147483647, 2147483646, 999999]) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') { dead = pid; break } }
  }
  assert(dead, 'test requires a provably absent PID')
  writeFileSync(lock, owner(dead))
  assert.equal(studio.build(target).buildId, first.buildId)
  assert.equal(existsSync(lock), false)
  assert.equal(existsSync(join(project, '.studio/build-recovery.lock')), false)
  const guard = join(project, '.studio/build-recovery.lock')
  writeFileSync(guard, owner(dead))
  assert.throws(() => studio.build(target), /game_build_busy/, 'uncertain interrupted recovery stays fail closed')
  rmSync(guard)

  // Fail the publish after a successful workcopy replacement. Rollback restores
  // both exact file contents and the prior valid preview without erasing history.
  let failed = false
  let reset = injectRename((from, to, rename) => {
    if (to === latestPath && !failed) { failed = true; const error = new Error('fixture_publish_failure'); error.code = 'EIO'; throw error }
    return rename(from, to)
  })
  try {
    assert.throws(() => studio.updateProject({ ...target, expectedCurrentHash: original.currentHash, source: original.source + '\n// publication failure\n' }), /fixture_publish_failure/)
  } finally { reset() }
  assert.deepEqual(disk(), baselineDisk)
  assert.equal(existsSync(lock), false)
  failed = false
  const externalSource = original.source + '\n// concurrent editor preserved\n'
  reset = injectRename((from, to, rename) => {
    if (to === latestPath && !failed) { failed = true; writeFileSync(sourcePath, externalSource); throw new Error('fixture_external_edit') }
    return rename(from, to)
  })
  try {
    assert.throws(() => studio.updateProject({ ...target, expectedCurrentHash: original.currentHash, source: original.source + '\n// trial\n' }), /game_update_rollback_conflict/)
  } finally { reset() }
  assert.equal(readFileSync(sourcePath, 'utf8'), externalSource, 'rollback refuses to overwrite another writer')
  studio.restoreBuild({ ...target, buildId: first.buildId, expectedCurrentHash: studio.currentState(target).currentHash })
  assert.deepEqual(disk(), baselineDisk)

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#fa0"/></svg>')
  const assets = { pickup: asset('image/svg+xml', svg), player: asset('image/png', png), pickupSound: asset('audio/wav', wav()) }
  const withAssets = studio.updateProject({ ...target, expectedCurrentHash: original.currentHash, manifest: { ...original.manifest, assets } })
  assert.equal(studio.readBuild({ ...target, buildId: withAssets.buildId }).manifest.assets.pickup.hash, files.hash(svg))
  assert.equal(withAssets.playtestStatus, 'not_assessed')
  const stable = studio.currentState(target), stableDisk = disk()
  const rejectAsset = (changed, pattern) => {
    assert.throws(() => studio.updateProject({ ...target, expectedCurrentHash: stable.currentHash, manifest: { ...stable.manifest, assets: changed } }), pattern)
    assert.deepEqual(disk(), stableDisk)
  }
  rejectAsset({ background: assets.pickup }, /game_asset_slot_invalid/)
  rejectAsset({ pickup: { ...assets.pickup, hash: '0'.repeat(64) } }, /game_asset_integrity_invalid/)
  rejectAsset({ pickup: { ...assets.pickup, data: assets.pickup.data + '\n' } }, /game_asset_invalid/)
  rejectAsset({ pickup: asset('audio/wav', wav()) }, /game_asset_mime_invalid/)
  rejectAsset({ pickup: asset('image/svg+xml', Buffer.from('<svg><script>alert(1)</script></svg>')) }, /game_asset_svg_unsafe/)
  rejectAsset({ pickup: asset('image/svg+xml', Buffer.from('<svg><rect onclick="x()"/></svg>')) }, /game_asset_svg_unsafe/)
  rejectAsset({ pickup: asset('image/svg+xml', Buffer.from('<svg><image href="https://outside/"/></svg>')) }, /game_asset_svg_unsafe/)
  rejectAsset({ pickup: asset('image/png', Buffer.from('invalid image')) }, /game_asset_png_invalid/)
  rejectAsset({ hitSound: asset('audio/wav', Buffer.from('invalid audio')) }, /game_asset_wav_invalid/)
  rejectAsset({ pickup: asset('image/svg+xml', Buffer.alloc(nativeGameStudioContract.maxAssetBytes + 1, 'x')) }, /game_asset_invalid|game_asset_integrity_invalid/)
  const largeAssetBytes = Math.floor(nativeGameStudioContract.maxTotalAssetBytes / 3) + 1
  const largeSvg = Buffer.concat([svg, Buffer.alloc(largeAssetBytes - svg.length, ' ')])
  rejectAsset({ pickup: asset('image/svg+xml', largeSvg), player: asset('image/svg+xml', largeSvg), enemyCard: asset('image/svg+xml', largeSvg) }, /game_assets_too_large/)

  const limited = createNativeGameStudio({ quotas: { maxBuilds: 1, maxPlaytests: 1 } })
  const limitedTarget = { ...target, slug: 'limited' }
  const limitedBuild = limited.create({ ...limitedTarget, title: '配额测试' })
  const limitedBefore = limited.currentState(limitedTarget)
  const limitedProject = join(workspaceRoot, limitedBuild.project)
  assert.equal(limited.build(limitedTarget).reused, true, 'quota does not reject a verified existing snapshot')
  assert.throws(() => limited.updateProject({ ...limitedTarget, expectedCurrentHash: limitedBefore.currentHash, source: limitedBefore.source + '\n// exceeds quota\n' }), /game_build_quota_exceeded/)
  assert.equal(limited.currentState(limitedTarget).currentHash, limitedBefore.currentHash)
  assert.equal(existsSync(join(limitedProject, '.studio/restore-backups')), false)
  const reportArgs = { ...limitedTarget, buildId: limitedBuild.buildId, report: { summary: 'SYNTHETIC QUOTA FIXTURE; no browser executed' }, screenshots: [{ name: 'synthetic.png', data: png }] }
  limited.recordPlaytest(reportArgs)
  assert.throws(() => limited.recordPlaytest(reportArgs), /game_playtest_quota_exceeded/)
  assert.equal(readdirSync(join(limitedProject, '.studio/playtests')).length, 1)
  assert.equal(existsSync(join(limitedProject, '.studio/build.lock')), false)
  const noBackup = createNativeGameStudio({ quotas: { maxRestoreBackups: 0 } })
  assert.throws(() => noBackup.updateProject({ ...limitedTarget, expectedCurrentHash: limitedBefore.currentHash, source: limitedBefore.source + '\n// no backup quota\n' }), /game_restore_quota_exceeded/)
  assert.equal(noBackup.currentState(limitedTarget).currentHash, limitedBefore.currentHash)
  const noBytes = createNativeGameStudio({ quotas: { maxBuildBytes: 1 } })
  assert.throws(() => noBytes.create({ ...target, slug: 'too-many-bytes', title: '字节配额' }), /game_build_quota_exceeded/)
  assert.equal(existsSync(join(workspaceRoot, 'games/too-many-bytes')), false)
  const noReportBytes = createNativeGameStudio({ quotas: { maxPlaytestBytes: 1 } })
  assert.throws(() => noReportBytes.recordPlaytest({ ...target, buildId: withAssets.buildId, report: {} }), /game_playtest_quota_exceeded/)
  assert.equal(existsSync(join(project, '.studio/playtests')), false)
  assert.throws(() => createNativeGameStudio({ quotas: { unknown: 1 } }), /game_quota_invalid/)
  assert.throws(() => createNativeGameStudio({ quotas: { maxBuilds: -1 } }), /game_quota_invalid/)

  // Trials must remain recoverable after using the last snapshot/backup slot.
  const recoverable = createNativeGameStudio({ quotas: { maxBuilds: 2, maxRestoreBackups: 1 } }), rollbackTarget = { ...target, slug: 'rollback-quota' }
  const baseBuild = recoverable.create({ ...rollbackTarget, title: '配额满回退' }), rollbackBefore = recoverable.currentState(rollbackTarget)
  const trial = recoverable.updateProject({ ...rollbackTarget, expectedCurrentHash: rollbackBefore.currentHash, source: rollbackBefore.source + '\n// final quota slot trial\n' })
  const rollbackAfter = recoverable.currentState(rollbackTarget), backupFolder = join(workspaceRoot, trial.backupPath)
  const rollbackArgs = { ...rollbackTarget, beforeHash: rollbackBefore.currentHash, expectedCurrentHash: rollbackAfter.currentHash, backupPath: trial.backupPath }
  const allFull = createNativeGameStudio({ quotas: { maxBuilds: 0, maxBuildBytes: 0, maxRestoreBackups: 0, maxRestoreBytes: 0 } })
  const backupSource = readFileSync(join(backupFolder, 'game.js')), backupLog = readFileSync(join(backupFolder, 'restore.json'))
  writeFileSync(join(backupFolder, 'game.js'), 'tampered recovery bytes')
  assert.throws(() => allFull.rollbackUpdate(rollbackArgs), /game_update_backup_integrity_invalid/)
  assert.equal(recoverable.currentState(rollbackTarget).currentHash, rollbackAfter.currentHash)
  writeFileSync(join(backupFolder, 'game.js'), backupSource)
  writeFileSync(join(backupFolder, 'restore.json'), files.json({ ...JSON.parse(backupLog), beforeSourceHash: '0'.repeat(64) }))
  assert.throws(() => allFull.rollbackUpdate(rollbackArgs), /game_update_backup_integrity_invalid/)
  writeFileSync(join(backupFolder, 'restore.json'), backupLog)
  assert.throws(() => allFull.rollbackUpdate({ ...rollbackArgs, backupPath: '../escape' }), /game_update_backup_invalid/)
  assert.throws(() => allFull.rollbackUpdate({ ...rollbackArgs, expectedCurrentHash: '0'.repeat(64) }), /game_current_hash_conflict/)
  assert.throws(() => allFull.rollbackUpdate({ ...rollbackArgs, beforeHash: '0'.repeat(64) }), /game_update_backup_integrity_invalid/)
  const baseArtifact = join(workspaceRoot, baseBuild.artifact), baseHtml = readFileSync(baseArtifact)
  writeFileSync(baseArtifact, 'corrupted original build')
  assert.throws(() => allFull.rollbackUpdate(rollbackArgs), /game_build_snapshot_conflict/)
  assert.equal(recoverable.currentState(rollbackTarget).currentHash, rollbackAfter.currentHash)
  writeFileSync(baseArtifact, baseHtml)
  // Duplicate byte-identical backups are safe; model a crash before the caller
  // could persist backupPath by recovering solely from the frozen before hash.
  const duplicate = join(backupFolder, '..', randomUUID())
  mkdirSync(duplicate)
  for (const name of ['game.json', 'game.js', 'restore.json']) writeFileSync(join(duplicate, name), readFileSync(join(backupFolder, name)))
  const rollback = allFull.rollbackUpdate({ ...rollbackTarget, beforeHash: rollbackBefore.currentHash, expectedCurrentHash: rollbackAfter.currentHash })
  assert.equal(rollback.rolledBack, true)
  assert.equal(rollback.buildId, baseBuild.buildId)
  assert.equal(rollback.playtestStatus, 'not_assessed')
  assert.equal(recoverable.currentState(rollbackTarget).currentHash, rollbackBefore.currentHash)
  assert.equal(recoverable.listBuilds(rollbackTarget).length, 2)
  assert.equal(readdirSync(join(duplicate, '..')).length, 2, 'rollback allocates neither backups nor builds')
  assert.equal(readdirSync(project).some(name => name.endsWith('.tmp')), false)
  console.log('PASS native game history: verified list/compare, raw CAS, locked source/assets transactions, immutable approval, backups, exact rollback, external-edit conflict, verified restore, legacy/live/dead PID locks, fail-closed recovery, byte/count quotas and safe embedded media; no browser executed')
} finally { rmSync(workspaceRoot, { recursive: true, force: true }) }
