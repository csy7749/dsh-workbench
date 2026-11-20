/** Production browser adapter checks. Uses installed providers; never downloads. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createNativeGamePlaytester } from '../src/host/native-game-playtest.mjs'
import { validateGamePlaytestEvidence } from '../src/packs/game/review.mjs'

const root = mkdtempSync(join(tmpdir(), 'native-game-playtest-'))
const productId = 'browser-adapter-test'
const studio = createNativeGameStudio()
const player = createNativeGamePlaytester({ studio })
const target = game => ({ workspaceRoot: root, productId, slug: game.slug, buildId: game.buildId })
const create = (slug, durationSeconds = 3) => studio.create({ workspaceRoot: root, productId, slug, title: '原生试玩验证', rules: { durationSeconds, hearts: 3 } })
const report = result => JSON.parse(readFileSync(join(root, result.reportPath), 'utf8'))
const amend = (game, suffix) => {
  const file = join(root, game.project, 'game.js')
  writeFileSync(file, readFileSync(file, 'utf8') + suffix)
  return studio.build({ workspaceRoot: root, productId, slug: game.slug })
}
const recorded = game => readdirSync(join(root, game.project, '.studio/playtests')).filter(name => !name.startsWith('.pending-'))
let requestsReceived = 0
const server = createServer((_request, response) => { requestsReceived++; response.writeHead(200); response.end('network must stay blocked') })

try {
  const missingProvider = createNativeGamePlaytester({ studio, playwrightPath: join(root, 'missing-provider') })
  const unavailable = await missingProvider.probe()
  assert.equal(unavailable.available, false)
  assert.match(unavailable.reason, /playwright/)
  await assert.rejects(missingProvider.playtest({ workspaceRoot: root, productId, slug: 'never-created', buildId: '0123456789ab' }), /playwright/)
  const missingBrowser = await createNativeGamePlaytester({ studio, browserExecutable: join(root, 'missing-browser.exe') }).probe()
  assert.equal(missingBrowser.available, false)
  assert.match(missingBrowser.reason, /browser/)
  await assert.rejects(player.playtest({ seconds: 0 }), /game_playtest_seconds_invalid/)
  assert.equal((await player.probe()).available, true, 'An installed Playwright provider and browser are required for this explicit check')

  const good = create('success')
  const success = await player.playtest({ ...target(good), seconds: 5 })
  assert.equal(success.playtestStatus, 'passed', JSON.stringify(success))
  assert.equal(success.finalPhase, 'won')
  assert.equal(success.buildCurrent, true)
  assert.equal(success.buildId, good.buildId)
  assert.equal(success.hash, good.hash)
  assert.equal(success.errors, 0)
  assert.equal(success.requests, 0)
  assert.equal(validateGamePlaytestEvidence(JSON.stringify(success)), true)
  assert(success.score > 0, 'A real input run collected at least one star')
  assert(success.inputs.keyboard && success.inputs.touch)
  assert(success.screenshots.length > 0)
  for (const file of success.screenshots) assert(readFileSync(join(root, file)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
  assert.equal(report(success).buildId, good.buildId)

  const throwing = amend(create('runtime-error', 1), '\nthrow new Error("native-browser-runtime-probe")\n')
  const failed = await player.playtest({ ...target(throwing), seconds: 3 })
  assert.equal(failed.playtestStatus, 'failed')
  assert(failed.errors > 0)
  assert.match(JSON.stringify(report(failed)), /native-browser-runtime-probe/)
  assert.equal(validateGamePlaytestEvidence(JSON.stringify(failed)), false)

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/must-not-arrive`
  const networking = amend(create('network-block', 1), `\nfetch(${JSON.stringify(url)}).catch(() => {})\n`)
  const blocked = await player.playtest({ ...target(networking), seconds: 3 })
  assert.equal(blocked.playtestStatus, 'failed')
  assert(blocked.requests > 0, 'A blocked network attempt is reported rather than silently called offline')
  assert.equal(requestsReceived, 0, 'No game request reached even a loopback endpoint')
  assert.equal(validateGamePlaytestEvidence(JSON.stringify(blocked)), false)

  const cancellable = create('cancelled', 10)
  const controller = new AbortController()
  const pending = player.playtest({ ...target(cancellable), seconds: 12, signal: controller.signal })
  await assert.rejects(player.playtest({ ...target(good), seconds: 5 }), /game_playtest_busy/)
  const cancellationTimer = setTimeout(() => controller.abort(), 1000)
  try { await assert.rejects(pending, /game_operation_cancelled/) } finally { clearTimeout(cancellationTimer) }
  const cancelledReports = recorded(cancellable)
  assert.equal(cancelledReports.length, 1, 'Cancellation preserves a report')
  const cancelledReport = JSON.parse(readFileSync(join(root, cancellable.project, '.studio/playtests', cancelledReports[0], 'report.json'), 'utf8'))
  assert.notEqual(cancelledReport.playtestStatus, 'passed')
  assert.match(JSON.stringify(cancelledReport), /cancelled/)

  // A good historical HTML can still run, but it cannot certify changed source.
  const source = join(root, good.project, 'game.js')
  const previousSource = readFileSync(source, 'utf8')
  writeFileSync(source, previousSource + '\n// changed after tested build\n')
  const stale = await player.playtest({ ...target(good), seconds: 5 })
  assert.equal(stale.buildCurrent, false)
  assert.notEqual(stale.playtestStatus, 'passed', 'Stale builds must never be presented as passing current-source QA')
  assert.equal(validateGamePlaytestEvidence(JSON.stringify(stale)), false)
  writeFileSync(source, previousSource)
  const recovered = await player.playtest({ ...target(good), seconds: 5 })
  assert.equal(recovered.playtestStatus, 'passed', 'Failure and cancellation release the browser service')
  console.log('PASS native production playtest: real input/collection/win, build/hash-bound PNG/report, JS failure, blocked network, missing providers, bounded concurrency, cancellation evidence, stale-build refusal and recovery; no human playtest claimed')
} finally {
  await new Promise(resolve => server.listening ? server.close(resolve) : resolve())
  rmSync(root, { recursive: true, force: true })
}
