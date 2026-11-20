/** Explicit local-browser check of the template emitted by the production bundle.
 * Needs an installed Playwright package and Edge; never downloads either.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNativeGameStudio } from '../lib/index.js'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.NATIVE_GAME_PLAYWRIGHT || 'playwright')
const root = mkdtempSync(join(tmpdir(), 'native-game-browser-'))
const evidence = process.env.NATIVE_GAME_EVIDENCE_DIR || root
mkdirSync(evidence, { recursive: true })
const studio = createNativeGameStudio()
const errors = []
const requests = []
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.NATIVE_GAME_BROWSER ? { executablePath: process.env.NATIVE_GAME_BROWSER } : { channel: 'msedge' }) })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
  context.on('request', request => { if (/^https?:/i.test(request.url())) requests.push(request.url()) })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const portrait = studio.create({ workspaceRoot: root, productId: 'browser-test', slug: 'portrait', title: '星光采集', rules: { durationSeconds: 5, hearts: 1 } })
  await page.goto(pathToFileURL(join(root, portrait.artifact)).href)
  await page.waitForFunction(() => window.__gameState?.().phase === 'ready')
  await page.getByRole('button', { name: '开始游戏' }).click()
  await page.keyboard.down('ArrowLeft')
  await page.waitForFunction(() => window.__gameState().x < 0.4)
  await page.keyboard.up('ArrowLeft')
  const rect = await page.locator('canvas').boundingBox()
  await page.touchscreen.tap(rect.x + rect.width * 0.5, rect.y + rect.height * 0.87)
  await page.waitForFunction(() => Math.abs(window.__gameState().x - 0.5) < 0.01)
  await page.waitForFunction(() => window.__gameState().score >= 1)
  await page.screenshot({ path: join(evidence, 'portrait-playing.png') })
  await page.touchscreen.tap(rect.x + rect.width * 0.75, rect.y + rect.height * 0.87)
  await page.waitForFunction(() => window.__gameState().phase === 'lost')
  assert.equal(await page.evaluate(() => window.__gameState().hearts), 0)
  await page.getByRole('button', { name: '重新开始' }).click()
  const restarted = await page.evaluate(() => window.__gameState())
  assert.equal(restarted.phase, 'playing')
  assert.equal(restarted.score, 0)
  assert.equal(restarted.hearts, 1)
  assert(restarted.remaining > 4.5)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true)

  const landscape = studio.create({ workspaceRoot: root, productId: 'browser-test', slug: 'landscape', title: '横屏测试', orientation: 'landscape', rules: { durationSeconds: 3, hearts: 3 } })
  await page.setViewportSize({ width: 960, height: 540 })
  await page.goto(pathToFileURL(join(root, landscape.artifact)).href)
  await page.getByRole('button', { name: '开始游戏' }).click()
  const wide = await page.locator('canvas').boundingBox()
  await page.touchscreen.tap(wide.x + wide.width * 0.07, wide.y + wide.height * 0.87)
  await page.waitForFunction(() => window.__gameState().phase === 'won')
  await page.screenshot({ path: join(evidence, 'landscape-won.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true)
  assert.deepEqual(errors, [])
  assert.deepEqual(requests, [])
  const report = { browser: browser.version(), portrait: { buildId: portrait.buildId, bytes: portrait.bytes }, landscape: { buildId: landscape.buildId, bytes: landscape.bytes }, checks: ['launch', 'render', 'keyboard', 'touch', 'collect', 'collision', 'loss', 'win', 'restart', 'viewport-fit'], errors, externalRequests: requests, limitations: ['Template smoke only; no DSH desktop, agent generation, general game QA, or human playtest.'] }
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log('PASS native bundled game browser:', JSON.stringify(report))
  await context.close()
} finally {
  await browser?.close()
  rmSync(root, { recursive: true, force: true })
}
