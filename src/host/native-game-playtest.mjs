import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { playtestCinderwatch } from './native-game-cinderwatch-playtest.mjs'

const require = createRequire(import.meta.url)
const external = value => /^(https?|wss?|ftp):/i.test(value)
const gameCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

/** Real browser input and observations; no game code executes in the host. */
export function createNativeGamePlaytester({ studio, playwrightPath, browserExecutable } = {}) {
  let active = false
  function provider() {
    let chromium
    const configured = playwrightPath ?? process.env.DSH_GAME_PLAYWRIGHT_PATH
    const candidates = configured ? [configured] : ['playwright', 'playwright-core', join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')]
    for (const candidate of candidates) {
      try { chromium = require(candidate).chromium; if (chromium) break } catch { /* Try installed providers only. */ }
    }
    if (!chromium) return { available: false, reason: 'game_playwright_unavailable' }
    const explicit = browserExecutable ?? process.env.DSH_GAME_BROWSER_EXECUTABLE
    const executables = explicit ? [explicit] : [
      join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
      join(process.env.LOCALAPPDATA ?? homedir(), 'Microsoft/Edge/Application/msedge.exe'),
      chromium.executablePath(),
    ]
    const executablePath = executables.find(path => existsSync(path))
    return executablePath ? { available: true, chromium, executablePath } : { available: false, reason: 'game_browser_unavailable' }
  }
  return {
    async probe() {
      const { available, reason } = provider()
      return { available, ...(reason ? { reason } : {}), provider: 'installed-playwright', downloads: false }
    },
    async playtest({ workspaceRoot, productId, slug, buildId, seconds = 20, signal }) {
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('game_playtest_seconds_invalid')
      if (signal?.aborted) throw new Error('game_operation_cancelled')
      if (active) throw new Error('game_playtest_busy')
      const service = provider()
      if (!service.available) throw new Error(service.reason)
      const target = { workspaceRoot, productId, slug, buildId }
      const built = studio.readBuild(target)
      active = true
      if (built.manifest.templateId === 'cinderwatch') {
        try { return await playtestCinderwatch({ studio, service, target, built, seconds, signal, gameCsp }) }
        finally { active = false }
      }
      let browser, timer, abort, runningWork, timedOut = false, cancelled = false
      let state = null, keyboard = false, touch = false, screenshot
      let assetEvidence = { expected: Object.keys(built.manifest.assets ?? {}), images: {}, drawn: {}, audio: {}, played: {}, errors: [] }
      const errors = [], requests = [], unassessed = ['固定模板的状态钩子用于观察；不证明任意游戏脚本正确。', '本轮未覆盖失败后重开、全部机型、性能稳定性及真人玩法体验。']
      let errorCount = 0, requestCount = 0
      const error = value => { errorCount++; if (errors.length < 100) errors.push(String(value).slice(0, 1000)) }
      const request = value => { requestCount++; if (requests.length < 100) requests.push(String(value).slice(0, 500)) }
      const start = Date.now()
      try {
        const work = async () => {
          browser = await service.chromium.launch({ headless: true, executablePath: service.executablePath, timeout: 10000, args: ['--disable-extensions', '--no-first-run'] })
          if (signal?.aborted || timedOut) { await browser.close(); throw new Error('game_operation_cancelled') }
          // Opaque CSP sandbox + worker-src none already disable workers. Playwright's
          // serviceWorkers:block hook itself throws when reading navigator in this origin.
          const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, acceptDownloads: false, permissions: [] })
          const initialUrl = 'https://native-game.invalid/' + built.buildId + '.html'
          let served = false
          await context.route('**/*', route => {
            const item = route.request()
            if (!served && item.isNavigationRequest() && item.url() === initialUrl) {
              served = true
              return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': gameCsp }, body: built.html })
            }
            if (external(item.url())) request(item.url())
            return route.abort()
          })
          context.on('page', popup => { if (context.pages().length > 1) { error('popup_blocked'); void popup.close().catch(() => {}) } })
          const page = await context.newPage()
          page.setDefaultTimeout(4000)
          page.on('pageerror', cause => error(cause.message))
          page.on('console', message => {
            if (message.type() === 'error') {
              const text = message.text().slice(0, 1000)
              error(text)
              if (/Content Security Policy|connect-src|Refused to (?:connect|load)/i.test(text)) request('csp-blocked')
            }
          })
          page.on('download', download => { error('download_blocked'); void download.cancel().catch(() => {}) })
          page.on('dialog', dialog => { error('dialog_blocked'); void dialog.dismiss().catch(() => {}) })
          page.on('framenavigated', frame => { if (frame === page.mainFrame() && frame.url() !== initialUrl) { error('navigation_blocked'); void page.close().catch(() => {}) } })
          await page.goto(initialUrl, { waitUntil: 'load' })
          await page.waitForFunction(() => window.__gameState?.().phase === 'ready')
          await page.getByRole('button', { name: '开始游戏' }).click()
          if (assetEvidence.expected.length) {
            await page.waitForFunction(slots => {
              const media = window.__gameAssets?.()
              return !!media && slots.every(slot => media.images?.[slot] === true || media.audio?.[slot] === true)
            }, assetEvidence.expected)
          }
          const initialX = await page.evaluate(() => Number(window.__gameState().x))
          await page.keyboard.down('ArrowLeft')
          await page.waitForTimeout(140)
          await page.keyboard.up('ArrowLeft')
          keyboard = (await page.evaluate(() => Number(window.__gameState().x))) < initialX
          const rect = await page.locator('canvas').boundingBox()
          if (!rect || !keyboard) throw new Error('game_input_unresponsive')
          await page.touchscreen.tap(rect.x + rect.width * 0.5, rect.y + rect.height * 0.87)
          touch = Math.abs((await page.evaluate(() => window.__gameState().x)) - 0.5) < 0.02
          const deadline = Date.now() + seconds * 1000
          while (Date.now() < deadline && !signal?.aborted) {
            state = await page.evaluate(() => {
              const s = window.__gameState()
              return { phase: String(s.phase).slice(0, 30), x: Number(s.x), score: Number(s.score), hearts: Number(s.hearts), remaining: Number(s.remaining), objects: Array.isArray(s.objects) ? s.objects.slice(0, 100).map(o => ({ x: Number(o.x), y: Number(o.y), hazard: !!o.hazard })) : [] }
            })
            if (state.phase !== 'playing') break
            const objects = Array.isArray(state.objects) ? state.objects : []
            const danger = objects.filter(object => object.hazard && object.y > 0.60 && object.y < 0.97)
            const safe = x => Number.isFinite(x) && danger.every(object => Math.abs(object.x - x) > 0.15)
            const stars = objects.filter(object => !object.hazard && object.y > 0.1 && object.y < 0.91 && safe(object.x)).sort((a, b) => b.y - a.y)
            const x = stars[0]?.x ?? (safe(state.x) ? state.x : [0.08, 0.23, 0.38, 0.53, 0.68, 0.83, 0.92].filter(safe).sort((a, b) => Math.abs(a - state.x) - Math.abs(b - state.x))[0] ?? 0.08)
            await page.touchscreen.tap(rect.x + rect.width * x, rect.y + rect.height * 0.87)
            await page.waitForTimeout(65)
          }
          if (assetEvidence.expected.length) assetEvidence = { ...assetEvidence, ...await page.evaluate(() => window.__gameAssets()) }
          screenshot = await page.screenshot({ type: 'png', timeout: 4000 })
          return browser.version()
        }
        let rejectStop
        const stop = new Promise((_, reject) => { rejectStop = reject })
        const close = () => { void browser?.close().catch(() => {}) }
        abort = () => { cancelled = true; close(); rejectStop(new Error('game_operation_cancelled')) }
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => { timedOut = true; close(); rejectStop(new Error('game_playtest_timeout')) }, (seconds + 15) * 1000)
        let browserVersion
        try { runningWork = work(); browserVersion = await Promise.race([runningWork, stop]) } catch (cause) {
          error(cancelled ? 'game_operation_cancelled' : timedOut ? 'game_playtest_timeout' : cause.message)
        }
        const phase = state?.phase ?? 'unavailable'
        const current = studio.readBuild(target).buildCurrent
        const assetsPassed = assetEvidence.expected.every(slot => (assetEvidence.images[slot] === true && assetEvidence.drawn?.[slot] > 0) || assetEvidence.audio[slot] === true)
          && assetEvidence.errors.length === 0 && (!assetEvidence.expected.includes('pickupSound') || assetEvidence.played.pickupSound > 0)
        const passed = !cancelled && !timedOut && phase === 'won' && built.buildCurrent && current && errorCount === 0 && requestCount === 0 && keyboard && touch && (state?.score ?? 0) > 0 && assetsPassed
        const report = { testedAt: new Date().toISOString(), browser: browserVersion ?? 'unavailable', elapsedMs: Date.now() - start, finalPhase: phase, errors: errorCount, requests: requestCount, errorDetails: errors, requestDetails: requests, inputs: { keyboard, touch }, score: state?.score ?? 0, assetEvidence, assetsPassed, playtestStatus: passed ? 'passed' : 'failed', unassessed,
          summary: `Real browser playtest: ${passed ? 'passed' : 'failed'}; phase=${phase}; Errors: ${errorCount ? errorCount : 'none'}; Requests: ${requestCount}; Screenshots: ${screenshot ? 'end.png' : 'none'}` }
        const recorded = studio.recordPlaytest({ ...target, report, screenshots: screenshot ? [{ name: 'end.png', data: screenshot }] : [] })
        if (cancelled) throw new Error('game_operation_cancelled')
        return recorded
      } finally {
        clearTimeout(timer)
        if (abort) signal?.removeEventListener('abort', abort)
        await browser?.close().catch(() => {})
        // A cancelled launch can resolve late; retain the slot until it closes.
        await runningWork?.catch(() => {})
        active = false
      }
    },
  }
}
