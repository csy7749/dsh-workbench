/** Real installed-browser checks for the Cinderwatch production adapter.
 * No dependencies or browsers are downloaded. Set DSH_GAME_PLAYWRIGHT_PATH and
 * DSH_GAME_BROWSER_EXECUTABLE when installed providers are outside probe paths.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createNativeGamePlaytester } from '../src/host/native-game-playtest.mjs'
import { CINDERWATCH_PLAYTEST_CHECKS } from '../src/host/native-game-cinderwatch-playtest.mjs'
import { validateGamePlaytestEvidence } from '../src/packs/game/review.mjs'

const root = mkdtempSync(join(tmpdir(), 'native-game-cinderwatch-'))
const evidenceDir = process.env.NATIVE_GAME_EVIDENCE_DIR
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true })
const studio = createNativeGameStudio(), player = createNativeGamePlaytester({ studio })
const productId = 'cinderwatch-browser-test'
const rules = { seed: 4, biome: 'ashen', startingGold: 300, lives: 20, autoCommand: true }
const create = (slug, gameRules = rules) => studio.create({ workspaceRoot: root, productId, slug, title: '余烬守望 · 三维塔防验证', template: 'cinderwatch', orientation: 'landscape', rules: gameRules })
const target = built => ({ workspaceRoot: root, productId, slug: built.slug, buildId: built.buildId })
const amend = (built, suffix) => {
  const file = join(root, built.project, 'game.js')
  writeFileSync(file, readFileSync(file, 'utf8') + suffix)
  return studio.build({ workspaceRoot: root, productId, slug: built.slug })
}
let receivedRequests = 0
const server = createServer((_request, response) => { receivedRequests++; response.writeHead(200); response.end('must stay blocked') })
const reports = {}

try {
  assert.equal((await player.probe()).available, true, 'Requires an existing Playwright installation and Chrome/Edge')
  const built = create('cinderwatch-success')
  assert.equal(studio.readBuild(target(built)).manifest.templateId, 'cinderwatch')
  const passed = reports.success = await player.playtest({ ...target(built), seconds: 20 })
  assert.equal(passed.playtestStatus, 'passed', JSON.stringify(passed, null, 2))
  assert.equal(passed.buildId, built.buildId)
  assert.equal(passed.hash, built.hash)
  assert.equal(passed.buildCurrent, true)
  assert.equal(passed.evidenceVersion, 1)
  assert.equal(passed.templateId, 'cinderwatch')
  assert.equal(passed.mode, 'fixed-step-browser')
  assert(['play', 'clear', 'defeat'].includes(passed.finalPhase))
  assert.equal(passed.errors, 0)
  assert.equal(passed.requests, 0)
  assert.deepEqual(passed.inputs, { mouse: true, keyboard: true, touch: true })
  for (const check of CINDERWATCH_PLAYTEST_CHECKS) assert.equal(passed.checks[check], true, check)
  assert(passed.simulatedSeconds > 0)
  assert(passed.observations.some(o => o.label === 'keyboard-built-archer' && o.towers.some(t => t.kind === 'archer')))
  assert(passed.observations.some(o => o.slain > 0 && o.wave > 1))
  assert.equal(passed.screenshots.length, 2)
  for (const file of passed.screenshots) {
    const image = readFileSync(join(root, file))
    assert(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    if (evidenceDir) writeFileSync(join(evidenceDir, file.endsWith('mobile.png') ? 'mobile.png' : 'desktop.png'), image)
  }
  assert.equal(validateGamePlaytestEvidence(JSON.stringify(passed)), true)

  // Frozen, nondefault production rules must reach the running game unchanged,
  // including before and after a zero-time render of the initial board.
  const configuredRules = { seed: 8, biome: 'frost', startingGold: 777, lives: 37, autoCommand: false }
  const configured = create('cinderwatch-configured', configuredRules)
  const configReport = reports.configuration = await player.playtest({ ...target(configured), seconds: 20 })
  assert.equal(configReport.playtestStatus, 'passed', JSON.stringify(configReport, null, 2))
  for (const label of ['desktop-boot', 'desktop-ready']) {
    const state = configReport.observations.find(o => o.label === label)
    assert.deepEqual({ seed: state.seed, biome: state.biome, gold: state.gold, lives: state.lives, commander: state.commander }, { seed: 8, biome: 'frost', gold: 777, lives: 37, commander: 'player' })
    assert.equal(state.towers.length, 0)
    assert.equal(state.simulationSeconds, 0)
  }

  // A script error must remain a failed report bound to its own build.
  const broken = amend(create('cinderwatch-error'), '\nthrow new Error("cinderwatch-runtime-probe")\n')
  const failed = reports.runtimeError = await player.playtest({ ...target(broken), seconds: 20 })
  assert.equal(failed.buildId, broken.buildId)
  assert.equal(failed.playtestStatus, 'failed')
  assert(failed.errors > 0)
  assert.match(JSON.stringify(failed.errorDetails), /cinderwatch-runtime-probe/)
  assert.equal(validateGamePlaytestEvidence(JSON.stringify(failed)), false)

  // The same CSP and route interception used in production block even loopback.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/never-arrives`
  const networking = amend(create('cinderwatch-network'), `\nfetch(${JSON.stringify(url)}).catch(() => {})\n`)
  const blocked = reports.networkBlocked = await player.playtest({ ...target(networking), seconds: 20 })
  assert.equal(blocked.playtestStatus, 'failed')
  assert(blocked.requests > 0)
  assert.equal(receivedRequests, 0)
  assert.equal(validateGamePlaytestEvidence(JSON.stringify(blocked)), false)

  // Changing source after a passing build invalidates its certification.
  const source = join(root, built.project, 'game.js')
  writeFileSync(source, readFileSync(source, 'utf8') + '\n// changed after browser evidence\n')
  const stale = reports.staleBuild = await player.playtest({ ...target(built), seconds: 20 })
  assert.equal(stale.buildCurrent, false)
  assert.equal(stale.playtestStatus, 'failed')
  assert.equal(validateGamePlaytestEvidence(JSON.stringify(stale)), false)

  if (evidenceDir) writeFileSync(join(evidenceDir, 'report.json'), JSON.stringify(reports, null, 2))
  console.log('PASS native Cinderwatch browser: real Three.js render, frozen nondefault configuration, mouse/keyboard build and gold, commander takeover/return, real-time pause, waves/kills/income, mobile touch/layout, build-bound PNGs, runtime-error refusal, network block and stale-build refusal; fixed-step simulation is not real-time performance or human acceptance.')
  console.log(JSON.stringify({ buildId: passed.buildId, browser: passed.browser, elapsedMs: passed.elapsedMs, simulatedSeconds: passed.simulatedSeconds, finalPhase: passed.finalPhase, checks: passed.checks, evidenceDir: evidenceDir ?? 'temporary' }))
} finally {
  await new Promise(resolve => server.listening ? server.close(resolve) : resolve())
  rmSync(root, { recursive: true, force: true })
}
