import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script, runInNewContext } from 'node:vm'
import { CINDERWATCH_NATIVE_TEMPLATE, cinderwatchBiomes, cinderwatchDefaultRules, cinderwatchTemplateSource, renderCinderwatchHtml, validateCinderwatchRules } from '../src/host/native-game-cinderwatch.mjs'
import { renderGameHtml } from '../src/host/native-game-template.mjs'
import { createNativeGameStudio, nativeGameStudioContract } from '../src/host/native-game-studio.mjs'
import { createNativeGameRevisions } from '../src/host/native-game-revisions.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const vendor = fileURLToPath(new URL('../assets/vendor/cinderwatch/', import.meta.url))
const source = cinderwatchTemplateSource()
const provenance = JSON.parse(readFileSync(join(vendor, 'PROVENANCE.json'), 'utf8'))
assert.equal(provenance.commit, '6640b81286df8b1fd2e5a745b48211c4a9323f83')
assert.equal(provenance.threeRevision, '170')
assert.equal(provenance.vendoredFilesUnmodified, true)
assert.equal(provenance.sha256Encoding, 'utf8-lf')
for (const [path, expected] of Object.entries(provenance.files)) assert.equal(hash(readFileSync(join(vendor, path), 'utf8').replace(/\r\n/g, '\n')), expected, 'pinned source: ' + path)
assert.equal(readdirSync(join(vendor, 'src')).filter(name => name.endsWith('.js')).length, 19)
assert.ok(Buffer.byteLength(source) > 400000 && Buffer.byteLength(source) < nativeGameStudioContract.maxSourceBytes)
assert.doesNotThrow(() => new Script(source, { filename: 'cinderwatch-game.js' }))
assert.match(source, /window\.__cw =/)
assert.match(source, /window\.__gameState =/)
assert.match(source, /objective: 'endless-defense'/)
assert.match(source, /installChineseUi\(PX, TOWER, MON, BIOMES\)/)
assert.match(source, /点击空塔位建造/)
assert.match(source, /第\$\{match\[1\]\}波/)
assert.doesNotMatch(source, /phase:\s*['"]won['"]|setPhase\(['"]won/)
assert.equal(CINDERWATCH_NATIVE_TEMPLATE, 'cinderwatch@1')
assert.ok(nativeGameStudioContract.templateIds.includes('cinderwatch'))
assert.equal(nativeGameStudioContract.templateId, 'canvas-collector', 'keep existing studio default')

for (const biome of cinderwatchBiomes) assert.deepEqual(validateCinderwatchRules({ ...cinderwatchDefaultRules, biome }), { ...cinderwatchDefaultRules, biome })
for (const patch of [
  { seed: 0 }, { seed: 1000000 }, { seed: 4.5 }, { seed: '4' }, { biome: 'winter' },
  { startingGold: 69 }, { startingGold: 2001 }, { startingGold: 70.5 }, { lives: 0 }, { lives: 101 },
  { autoCommand: 1 }, { autoCommand: 'false' }, { hearts: 3 }, { durationSeconds: 20 },
]) assert.throws(() => validateCinderwatchRules({ ...cinderwatchDefaultRules, ...patch }), /game_rules_invalid/)
for (const rules of [null, [], {}, { ...cinderwatchDefaultRules, lives: undefined }]) assert.throws(() => validateCinderwatchRules(rules), /game_rules_invalid/)
assert.doesNotThrow(() => validateCinderwatchRules({ seed: 1, biome: 'ashen', startingGold: 70, lives: 1, autoCommand: false }))
assert.doesNotThrow(() => validateCinderwatchRules({ seed: 999999, biome: 'dunes', startingGold: 2000, lives: 100, autoCommand: true }))

function htmlConfig(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
  assert.equal(scripts.length, 2, 'all runtime code stays in two closed inline scripts')
  for (const script of scripts) assert.doesNotThrow(() => new Script(script))
  const prefix = scripts[1].slice(0, scripts[1].indexOf(';\n'))
  const context = { window: {} }; runInNewContext(prefix, context)
  return JSON.parse(JSON.stringify(context.window.GAME))
}
for (const [index, biome] of cinderwatchBiomes.entries()) {
  const rules = { seed: 8 + index, biome, startingGold: 777 + index, lives: 37 + index, autoCommand: index % 2 === 0 }
  const manifest = { templateId: 'cinderwatch', title: '烽火 ' + biome, orientation: 'landscape', rules }
  const html = renderCinderwatchHtml(manifest, source)
  assert.equal(renderGameHtml(manifest, source), html, 'template dispatcher')
  assert.deepEqual(htmlConfig(html), { title: manifest.title, rules, orientation: 'landscape', nativeTemplate: 'cinderwatch@1' })
  assert.match(html, /connect-src 'none'/)
  assert.match(html, /<html lang="zh-CN">/)
  assert.match(html, /正在点燃烽火/)
  assert.match(html, /单文件离线运行的三维塔防游戏/)
  assert.match(html, /default-src 'none'/)
  assert.match(html, /Copyright \(c\) 2026 kevintngo/)
  assert.match(html, /Copyright © 2010-2024 three\.js authors/)
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["'](?:https?:|file:|\.\.\/|vendor\/|src\/)/i)
  assert.doesNotMatch(html, /<script[^>]+src\s*=|<link[^>]+href\s*=\s*["'](?!data:)/i)
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|TextureLoader|GLTFLoader|AudioLoader)\b/)
}
const hostileTitle = '</title><script>alert(1)</script>\u2028&"'
const titleHtml = renderCinderwatchHtml({ title: hostileTitle, rules: { ...cinderwatchDefaultRules }, orientation: 'portrait' }, source)
assert.equal(htmlConfig(titleHtml).title, hostileTitle)
assert.ok(titleHtml.includes('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;'))
assert.throws(() => renderCinderwatchHtml({ title: 'x', rules: { ...cinderwatchDefaultRules } }, '</script><script>'), /game_source_html_delimiter/)

const temporaryParent = realpathSync(tmpdir())
const root = mkdtempSync(join(temporaryParent, 'native-game-cinderwatch-'))
try {
  const installed = join(root, 'installed')
  mkdirSync(join(installed, 'lib'), { recursive: true })
  mkdirSync(join(installed, 'assets/vendor'), { recursive: true })
  cpSync(vendor, join(installed, 'assets/vendor/cinderwatch'), { recursive: true })
  for (const name of Object.keys(provenance.files)) {
    const path = join(installed, 'assets/vendor/cinderwatch', name)
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
  }
  cpSync(fileURLToPath(new URL('../src/host/native-game-cinderwatch.mjs', import.meta.url)), join(installed, 'lib/native-game-cinderwatch.mjs'))
  const packaged = await import(pathToFileURL(join(installed, 'lib/native-game-cinderwatch.mjs')).href)
  assert.equal(packaged.cinderwatchTemplateSource(), source, 'installed lib/ resolves package assets after LF checkout')
  const packageManifest = { title: 'package', rules: { ...cinderwatchDefaultRules }, orientation: 'landscape' }
  assert.equal(packaged.renderCinderwatchHtml(packageManifest, source), renderCinderwatchHtml(packageManifest, source))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const studio = createNativeGameStudio(), base = { workspaceRoot: workspace, productId: 'cinderwatch-contract', slug: 'beacon' }
  const created = studio.create({ ...base, title: '烽火守望', orientation: 'landscape', template: 'cinderwatch' })
  assert.equal(created.template, 'cinderwatch')
  assert.equal(created.playtestStatus, 'not_assessed')
  const initial = studio.readBuild({ ...base, buildId: created.buildId })
  assert.deepEqual(initial.manifest.rules, cinderwatchDefaultRules)
  assert.equal(initial.source, source)
  assert.equal(initial.hash, hash(initial.html))
  assert.equal(initial.bytes, Buffer.byteLength(initial.html))
  assert.ok(initial.bytes > 1000000)
  const repeated = studio.build(base)
  assert.equal(repeated.buildId, created.buildId)
  assert.equal(repeated.reused, true)
  const exported = studio.exportBuild({ ...base, buildId: created.buildId })
  assert.equal(readFileSync(join(workspace, exported.exportPath), 'utf8'), initial.html)
  assert.equal(exported.hash, initial.hash)
  assert.equal(studio.exportBuild({ ...base, buildId: created.buildId }).reused, true)

  const configured = { seed: 8, biome: 'frost', startingGold: 777, lives: 37, autoCommand: false }
  const alternative = studio.create({ ...base, slug: 'frost', title: '冰霜烽火', template: 'cinderwatch', rules: configured })
  const alternativeBuild = studio.readBuild({ ...base, slug: 'frost', buildId: alternative.buildId })
  assert.deepEqual(htmlConfig(alternativeBuild.html).rules, configured)
  assert.notEqual(alternative.hash, initial.hash)
  assert.equal(initial.html, studio.readBuild({ ...base, buildId: created.buildId }).html, 'other projects preserve the original snapshot')
  assert.throws(() => studio.create({ ...base, slug: 'null-rules', title: 'bad', template: 'cinderwatch', rules: null }), /game_rules_invalid/)
  assert.throws(() => studio.create({ ...base, slug: 'collector-rules', title: 'bad', template: 'cinderwatch', rules: { durationSeconds: 15, hearts: 3 } }), /game_rules_invalid/)
  assert.equal(existsSync(join(workspace, 'games/collector-rules')), false)
  const manifestPath = join(workspace, created.project, 'game.json')
  writeFileSync(manifestPath, JSON.stringify({ ...initial.manifest, assets: { player: {} } }))
  assert.throws(() => studio.build(base), /game_asset_slot_invalid/)
  writeFileSync(manifestPath, JSON.stringify(initial.manifest, null, 2) + '\n')
  assert.equal(studio.build(base).buildId, initial.buildId)

  writeFileSync(join(workspace, created.project, 'game.js'), source + '\n// candidate change\n')
  const altered = studio.build(base)
  const revisions = createNativeGameRevisions({ studio })
  const canonical = revisions.canonical({ ...base, expectedBuildId: altered.buildId })
  assert.equal(canonical.sourceHash, hash(source), 'canonical repair chooses the current project template')
  assert.match(canonical.reason, /cinderwatch@1/)
  assert.notEqual(canonical.sourceHash, studio.currentState(base).sourceHash)
  console.log('PASS cinderwatch: 23 pinned source hashes, complete r170/offline HTML, five biome configurations, strict rules, safe Unicode titles, installed asset fallback, deterministic snapshots/export and template-specific repair')
} finally {
  // Verify the resolved absolute target before recursively deleting test data.
  const absolute = resolve(root), resolved = realpathSync(root), rel = relative(temporaryParent, resolved)
  assert.equal(resolved, absolute)
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) && rel.startsWith('native-game-cinderwatch-'))
  rmSync(absolute, { recursive: true, force: true })
}
