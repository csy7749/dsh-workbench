/** Real DrawAI-compatible SVG + local AnyAudio-compatible WAV + installed Blender
 * PNG/native files -> adoption -> immutable HTML -> Edge -> offline loss/restart. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createNativeGameAssets } from '../src/host/native-game-assets.mjs'
import { createNativeGameBlender } from '../src/host/native-game-blender.mjs'
import { createNativeGamePlaytester } from '../src/host/native-game-playtest.mjs'

const root = mkdtempSync(join(tmpdir(), 'native-creative-real-'))
const evidence = process.env.NATIVE_GAME_EVIDENCE_DIR ?? join(root, 'evidence')
mkdirSync(evidence, { recursive: true })
const studio = createNativeGameStudio(), assets = createNativeGameAssets({ studio }), blender = createNativeGameBlender({ studio, assets }), playtester = createNativeGamePlaytester({ studio })
const target = { workspaceRoot: root, productId: 'actual-creative-test', slug: 'creative-catcher' }
let browser
try {
  assert.equal((await blender.probe()).available, true, 'This explicit suite requires an installed Blender; missing is not a pass')
  let built = studio.create({ ...target, title: '星光采集 · 原创素材联测', rules: { durationSeconds: 6, hearts: 1 } })
  const candidates = []
  for (const [provider, slot, recipe] of [
    ['drawai', 'pickup', { shape: 'diamond', fill: '#f5c451', width: 64, height: 64 }],
    ['any-audio', 'pickupSound', { preset: 'coin', sampleRate: 24000, durationSec: 0.2, frequency: 880, seed: 42, gain: 0.18 }],
    ['any-audio', 'hitSound', { preset: 'hit', sampleRate: 24000, durationSec: 0.2, frequency: 150, seed: 43, gain: 0.16 }],
  ]) {
    const candidate = await assets.generate({ ...target, provider, slot, recipe }); candidates.push(candidate)
    built = assets.adopt({ ...target, assetId: candidate.assetId, expectedBuildId: built.buildId })
  }
  const geometry = await blender.generate({ ...target, slot: 'player', recipe: { primitive: 'crate', size: 1, color: '#67D5B5' } })
  candidates.push(geometry)
  built = assets.adopt({ ...target, assetId: geometry.assetId, expectedBuildId: built.buildId })
  const tested = await playtester.playtest({ ...target, buildId: built.buildId, seconds: 8 })
  assert.equal(tested.playtestStatus, 'passed', JSON.stringify(tested))
  assert.equal(tested.assetEvidence.images.player, true)
  assert.equal(tested.assetEvidence.images.pickup, true)
  assert(tested.assetEvidence.drawn.player > 0)
  assert(tested.assetEvidence.drawn.pickup > 0)
  assert(tested.assetEvidence.played.pickupSound > 0)
  assert.equal(tested.errors, 0); assert.equal(tested.requests, 0)
  const exported = studio.exportBuild({ ...target, buildId: built.buildId }), output = join(evidence, 'creative-catcher.html')
  copyFileSync(join(root, exported.exportPath), output)
  assert.equal(readFileSync(output).length, exported.bytes)
  assert.equal(createHash('sha256').update(readFileSync(output)).digest('hex'), exported.hash)
  for (const candidate of candidates) {
    const folder = join(evidence, candidate.provider + '-' + candidate.slot); mkdirSync(folder, { recursive: true })
    for (const file of candidate.files) {
      const local = join(folder, file.name); mkdirSync(join(local, '..'), { recursive: true })
      copyFileSync(join(root, file.path), local)
    }
  }
  for (const shot of tested.screenshots) copyFileSync(join(root, shot), join(evidence, 'auto-' + basename(shot)))
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.DSH_GAME_PLAYWRIGHT_PATH ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_GAME_BROWSER_EXECUTABLE ? { executablePath: process.env.DSH_GAME_BROWSER_EXECUTABLE } : { channel: 'msedge' }) })
  const page = await browser.newPage({ viewport: { width: 440, height: 840 }, hasTouch: true })
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()) })
  await page.goto(pathToFileURL(output).href)
  await page.getByRole('button', { name: '开始游戏' }).click()
  await page.waitForFunction(() => window.__gameAssets?.().audio.hitSound && window.__gameAssets?.().images.player)
  const bounds = await page.locator('canvas').boundingBox(), deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.__gameState())
    if (state.phase === 'lost') break
    const hazard = state.objects.find(object => object.hazard && object.y > 0.2)
    if (hazard) await page.touchscreen.tap(bounds.x + bounds.width * hazard.x, bounds.y + bounds.height * 0.87)
    await page.waitForTimeout(50)
  }
  assert.equal(await page.evaluate(() => window.__gameState().phase), 'lost', 'real input reached loss state')
  assert((await page.evaluate(() => window.__gameAssets().played.hitSound)) > 0, 'actual hit emitted an audio source')
  await page.screenshot({ path: join(evidence, 'creative-loss.png') })
  await page.getByRole('button', { name: '重新开始' }).click()
  const restarted = await page.evaluate(() => window.__gameState())
  assert.equal(restarted.phase, 'playing'); assert.equal(restarted.score, 0); assert.equal(restarted.hearts, 1)
  await page.screenshot({ path: join(evidence, 'creative-playing.png') })
  assert.equal(errors.length, 0, JSON.stringify(errors)); assert.equal(requests.length, 0)
  const report = { checkedAt: new Date().toISOString(), blenderVersion: geometry.blenderVersion, buildId: built.buildId, bytes: exported.bytes, hash: exported.hash, geometry: geometry.geometry, candidates: candidates.map(({ assetId, provider, slot, hash, bytes }) => ({ assetId, provider, slot, hash, bytes })), assetEvidence: tested.assetEvidence, automaticFinalPhase: tested.finalPhase, errors, requests, offlineLoss: true, offlineHitAudioSourceStarted: true, restartResetsState: true, limitations: ['Fixed template state hooks support observations; arbitrary game correctness is not proven.', 'Audio source start and decode are browser evidence, not a human listening assessment.', 'This is automated integration, not DSH desktop or human game acceptance.'] }
  writeFileSync(join(evidence, 'creative-report.json'), JSON.stringify(report, null, 2))
  console.log('PASS real creative provider/asset/game/offline integration:', JSON.stringify(report))
} finally { await browser?.close(); rmSync(root, { recursive: true, force: true }) }
