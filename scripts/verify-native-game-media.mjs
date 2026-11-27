import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import sharp from 'sharp'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as sharedPolicy from '../src/shared/tool-policy.ts'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createNativeGameAssets } from '../src/host/native-game-assets.mjs'
import { createNativeGameMedia } from '../src/host/native-game-media.mjs'

const root = mkdtempSync(join(tmpdir(), 'native-game-media-'))
const workspace = join(root, 'workspace')
const linkedWorkspace = join(root, 'linked-workspace')
const outside = join(root, 'outside')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const target = { workspaceRoot: workspace, productId: 'media-product', slug: 'media-game' }
const studio = createNativeGameStudio()
const media = createNativeGameMedia()
const assets = createNativeGameAssets({ studio })
const portable = path => join(workspace, path)
let resetToolPolicy = () => undefined

function load(relative, modules) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(compiled, { exports, console, Error, AbortSignal, Buffer, process, require(name) { assert(name in modules, 'Unexpected module: ' + name); return modules[name] } })
  return exports
}

function checkedManifest(receipt) {
  const text = readFileSync(portable(receipt.manifestPath), 'utf8')
  assert.equal(digest(Buffer.from(text)), receipt.manifestHash)
  const manifest = JSON.parse(text)
  assert.equal(manifest.operation, receipt.operation)
  assert.equal(manifest.productId, target.productId)
  assert.equal(manifest.slug, target.slug)
  assert.equal(manifest.source.sha256, digest(readFileSync(portable(manifest.source.path))))
  for (const file of manifest.files) {
    const bytes = readFileSync(portable(join(path.dirname(receipt.manifestPath), file.name)))
    assert.equal(bytes.length, file.bytes, file.name)
    assert.equal(digest(bytes), file.sha256, file.name)
  }
  return manifest
}

try {
  mkdirSync(workspace)
  mkdirSync(linkedWorkspace)
  mkdirSync(outside)
  const created = studio.create({ ...target, title: '本地媒体处理' })
  const project = portable(created.project)
  const sourcePath = join(project, 'fixture.png')
  const rgba = Buffer.alloc(4 * 2 * 4)
  const colors = [
    [255, 0, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255],
    [0, 0, 255, 255], [0, 0, 255, 255], [255, 255, 0, 255], [255, 255, 0, 255],
  ]
  colors.forEach((color, index) => rgba.set(color, index * 4))
  const fixture = await sharp(rgba, { raw: { width: 4, height: 2, channels: 4 } }).png().toBuffer()
  writeFileSync(sourcePath, fixture)
  const originalGameJson = readFileSync(join(project, 'game.json'))
  const originalGameJs = readFileSync(join(project, 'game.js'))
  const sourceHash = digest(fixture)
  assert.deepEqual(assets.list(target), [])

  const crop = await media.crop({ ...target, sourcePath: 'fixture.png', left: 2, top: 0, width: 2, height: 2 })
  assert.equal(crop.ok, true)
  assert.equal(crop.width, 2)
  assert.equal(crop.height, 2)
  assert.equal(crop.sha256, digest(readFileSync(portable(crop.files[0].path))))
  const cropPixels = await sharp(readFileSync(portable(crop.files[0].path))).raw().toBuffer()
  assert.deepEqual([...cropPixels.subarray(0, 4)], colors[2], 'crop starts at requested source pixel')
  assert.deepEqual([...cropPixels.subarray(4, 8)], colors[3])
  assert.deepEqual([...cropPixels.subarray(8, 12)], colors[6])
  assert.deepEqual([...cropPixels.subarray(12, 16)], colors[7])
  const cropManifest = checkedManifest(crop)
  assert.deepEqual(cropManifest.recipe, { left: 2, top: 0, width: 2, height: 2, format: 'png' })

  const split = await media.splitGrid({ ...target, sourcePath: 'fixture.png', columns: 2, rows: 2 })
  assert.equal(split.frameCount, 4)
  const gridManifest = checkedManifest(split)
  assert.deepEqual(gridManifest.recipe.selectedFrames, [0, 1, 2, 3])
  assert.deepEqual(gridManifest.recipe.columnWidths, [2, 2])
  assert.deepEqual(gridManifest.recipe.rowHeights, [1, 1])
  const frames = gridManifest.files.filter(file => file.name.startsWith('frame-'))
  assert.deepEqual(frames.map(file => file.name), ['frame-0000.png', 'frame-0001.png', 'frame-0002.png', 'frame-0003.png'])
  for (let index = 0; index < frames.length; index += 1) {
    const pixels = await sharp(readFileSync(portable(join(path.dirname(split.manifestPath), frames[index].name)))).raw().toBuffer()
    assert.deepEqual([...pixels.subarray(0, 4)], colors[[0, 2, 4, 6][index]], `row-major frame ${index}`)
  }
  assert.equal(digest(readFileSync(sourcePath)), sourceHash, 'media operations never rewrite source images')
  assert.deepEqual(readFileSync(join(project, 'game.json')), originalGameJson, 'media operations never alter game configuration')
  assert.deepEqual(readFileSync(join(project, 'game.js')), originalGameJs, 'media operations never alter game source')
  assert.deepEqual(assets.list(target), [], 'media outputs do not enter the single-file game asset candidate list')

  await assert.rejects(media.crop({ ...target, sourcePath, left: 0, top: 0, width: 1, height: 1 }), /game_media_source_invalid/)
  await assert.rejects(media.crop({ ...target, sourcePath: '../media-game/fixture.png', left: 0, top: 0, width: 1, height: 1 }), /game_media_source_invalid/)
  await assert.rejects(media.crop({ ...target, sourcePath: 'fixture.png:stream', left: 0, top: 0, width: 1, height: 1 }), /game_media_source_invalid/)
  await assert.rejects(media.crop({ ...target, sourcePath: 'fixture.png', left: 3, top: 0, width: 2, height: 1 }), /game_media_crop_out_of_bounds/)
  await assert.rejects(media.crop({ ...target, sourcePath: 'fixture.png', left: 0, top: 0, width: 1, height: 1, format: 'svg' }), /game_media_format_invalid/)
  await assert.rejects(media.splitGrid({ ...target, sourcePath: 'fixture.png', columns: 11, rows: 10 }), /game_media_frame_limit/)
  await assert.rejects(media.splitGrid({ ...target, sourcePath: 'fixture.png', columns: 5, rows: 1 }), /game_media_cell_invalid/)
  await assert.rejects(media.crop({ ...target, productId: 'other-product', sourcePath: 'fixture.png', left: 0, top: 0, width: 1, height: 1 }), /game_product_mismatch/)
  await assert.rejects(media.crop({ ...target, sourcePath: 'game.js', left: 0, top: 0, width: 1, height: 1 }), /game_media_image_invalid/)
  await assert.rejects(media.crop({ ...target, signal: AbortSignal.abort(), sourcePath: 'fixture.png', left: 0, top: 0, width: 1, height: 1 }), /game_operation_cancelled/)
  assert.equal(existsSync(join(project, '.studio/media.lock')), false)
  assert.equal(readdirSync(join(project, '.studio/media/crop')).some(name => name.startsWith('.pending-')), false)
  assert.equal(readdirSync(join(project, '.studio/media/grid-split')).some(name => name.startsWith('.pending-')), false)

  const linkDir = join(project, 'linked-images')
  symlinkSync(outside, linkDir, 'junction')
  await assert.rejects(media.crop({ ...target, sourcePath: 'linked-images/fixture.png', left: 0, top: 0, width: 1, height: 1 }), /game_directory_unsafe/)
  const hardLink = join(project, 'hardlinked.png')
  linkSync(sourcePath, hardLink)
  await assert.rejects(media.crop({ ...target, sourcePath: 'hardlinked.png', left: 0, top: 0, width: 1, height: 1 }), /game_file_unsafe/)
  unlinkSync(hardLink)
  assert.deepEqual(readdirSync(outside), [], 'linked inputs never write outside the registered game project')

  const policy = load('../src/host/tool-policy.ts', { 'node:fs': fs, 'node:path': path, '../shared/tool-policy.js': sharedPolicy })
  resetToolPolicy = () => policy.setActiveToolPolicy(null)
  const mediaModule = await import('../src/host/native-game-media.mjs')
  const toolsModule = load('../src/host/native-game-media-tools.ts', { 'node:fs': fs, 'node:path': path, './tool-policy.js': policy, './native-game-media.mjs': mediaModule })
  const definitions = new Map(), guards = new Map(), effects = []
  const ctx = { effect(fn, label) { effects.push(label); return fn() }, tools: { register(definition, options) { definitions.set(definition.name, definition); guards.set(definition.name, options.when) } } }
  toolsModule.registerNativeGameMediaTools(ctx, () => [{ id: target.productId, workspacePath: workspace }])
  const expected = ['workbench_game_media_crop', 'workbench_game_media_grid_split']
  assert.deepEqual([...definitions.keys()].sort(), expected.sort())
  assert.equal(effects.length, 2)
  assert(expected.every(name => sharedPolicy.WORKBENCH_TOOLS.some(item => item.name === name)))
  assert(expected.every(name => typeof guards.get(name) === 'function'))
  const guardedPolicy = { allow: candidate => ({ allowed: candidate !== expected[0], reason: 'test policy' }) }
  policy.setActiveToolPolicy(guardedPolicy)
  assert.equal(guards.get(expected[0])({ agent: {} }), false)
  assert.equal(guards.get(expected[1])({ agent: {} }), true)
  policy.setActiveToolPolicy(null)
  const beforeCancelled = readdirSync(join(project, '.studio/media/crop')).length
  const cancelled = await definitions.get(expected[0]).execute({ ...target, sourcePath: 'fixture.png', left: 0, top: 0, width: 1, height: 1 }, { signal: AbortSignal.abort() })
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.error, 'game_operation_cancelled')
  assert.equal(readdirSync(join(project, '.studio/media/crop')).length, beforeCancelled)
  const spoofedSignal = AbortSignal.abort()
  const trustedSignalCall = await definitions.get(expected[0]).execute({ ...target, sourcePath: 'fixture.png', left: 0, top: 0, width: 1, height: 1, signal: spoofedSignal }, { signal: new AbortController().signal })
  assert.equal(trustedSignalCall.ok, true, 'model arguments cannot forge the host cancellation signal')

  writeFileSync(join(project, '.studio/media/unknown-entry'), 'preserve')
  await assert.rejects(media.crop({ ...target, sourcePath: 'fixture.png', left: 0, top: 0, width: 1, height: 1 }), /game_media_storage_unknown_entry/)
  assert.equal(readFileSync(join(project, '.studio/media/unknown-entry'), 'utf8'), 'preserve')
  assert.equal(existsSync(join(project, '.studio/media.lock')), false)
  assert.equal(readdirSync(join(project, '.studio/media/crop')).some(name => name.startsWith('.pending-')), false)
  assert.equal(readdirSync(join(project, '.studio/media/grid-split')).some(name => name.startsWith('.pending-')), false)
  console.log('PASS native game media: actual crop/grid pixels, row-major frame order, immutable source and game files, manifest/file hashes, project and link isolation, guarded Agent registration, trusted cancellation, quota/input validation, and candidate-list separation')
} finally {
  resetToolPolicy()
  if (path.dirname(fs.realpathSync(root)) !== fs.realpathSync(tmpdir()) || !path.basename(root).startsWith('native-game-media-')) throw new Error('unsafe_test_cleanup')
  rmSync(root, { recursive: true, force: true })
}
