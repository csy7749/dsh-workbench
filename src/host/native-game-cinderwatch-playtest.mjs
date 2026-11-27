const external = value => /^(https?|wss?|ftp):/i.test(value)

export const CINDERWATCH_PLAYTEST_CHECKS = Object.freeze([
  'renderer', 'buildSpend', 'manualTakeover', 'commanderReturn', 'pauseToggle',
  'waveProgress', 'kills', 'economy', 'mobileLayout',
])

// Only observe state and invoke the game's normal update loop. Browser inputs
// perform every player action; no state setters, free gold, damage, or win hooks.
async function observe(page, label) {
  return page.evaluate(label => {
    const c = window.__cw, G = c.G, state = window.__gameState()
    const towers = G.towers.filter(t => t.alive).map(t => ({ kind: t.kind, level: t.lvl, state: t.state, padIndex: G.B.pads.indexOf(t.pad), spent: t.spent }))
    return {
      label, phase: String(G.phase), gold: G.gold, lives: G.lives,
      seed: state.seed, biome: state.biome, commander: state.commander,
      wave: Number(state.wave), slain: G.slain, towers,
      investment: towers.reduce((sum, t) => sum + t.spent, 0),
      manual: !!c.UI.manual, paused: !!G.paused, simulationSeconds: G.t,
      menuPadIndex: c.UI.menu ? G.B.pads.indexOf(c.UI.menu.pad) : -1,
      touchMode: !!c.UI.touch,
    }
  }, label)
}

async function visiblePad(page) {
  return page.evaluate(() => {
    const c = window.__cw, B = c.G.B, dpr = c.R.dpr || 1
    return B.pads.map((pad, index) => {
      const p = c.UI.proj(pad.x, pad.y, pad.z)
      return { index, x: p.x / dpr, y: p.y / dpr, occupied: !!pad.tower, priority: Math.abs(pad.s / B.L - .42) }
    }).filter(p => !p.occupied && p.x > 45 && p.x < innerWidth - 45 && p.y > innerHeight * .23 && p.y < innerHeight * .73)
      .sort((a, b) => a.priority - b.priority)[0] || null
  })
}

async function rendererEvidence(page, tick) {
  return page.evaluate(tick => {
    const c = window.__cw
    if (tick) c.tick(0, true)
    const renderer = c.R.renderer, gl = renderer.getContext(), canvas = c.R.canvas
    const sample = document.createElement('canvas'); sample.width = sample.height = 64
    const ctx = sample.getContext('2d'); ctx.drawImage(canvas, 0, 0, 64, 64)
    const pixels = ctx.getImageData(0, 0, 64, 64).data, colours = new Set()
    let opaquePixels = 0, visibleMeshes = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]) opaquePixels++
      colours.add((pixels[i] >> 3) + ',' + (pixels[i + 1] >> 3) + ',' + (pixels[i + 2] >> 3))
    }
    c.R.scene.traverse(object => { if (object.isMesh && object.visible) visibleMeshes++ })
    return {
      webglVersion: gl.getParameter(gl.VERSION), drawingBuffer: [canvas.width, canvas.height],
      geometries: renderer.info.memory.geometries, visibleMeshes, drawCalls: renderer.info.render.calls,
      sampledColours: colours.size, opaquePixels,
    }
  }, tick)
}

/** Production Three.js tower-defense checks, bound to the exact stored build. */
export async function playtestCinderwatch({ studio, service, target, built, seconds, signal, gameCsp }) {
  const checks = Object.fromEntries(CINDERWATCH_PLAYTEST_CHECKS.map(key => [key, false]))
  const inputs = { mouse: false, keyboard: false, touch: false }
  const observations = [], screenshots = [], errorDetails = [], requestDetails = []
  const rendering = {}, start = Date.now()
  let errors = 0, requests = 0, browser, browserVersion, timer, abort, runningWork
  let timedOut = false, cancelled = false, finalState = null, simulatedSeconds = 0, mobileRealtimeSeconds = 0
  const error = cause => { errors++; if (errorDetails.length < 100) errorDetails.push(String(cause).slice(0, 1000)) }
  const request = url => { requests++; if (requestDetails.length < 100) requestDetails.push(String(url).slice(0, 500)) }
  const stopped = () => { if (cancelled || timedOut || signal?.aborted) throw new Error(cancelled || signal?.aborted ? 'game_operation_cancelled' : 'game_playtest_timeout') }
  const snapshot = async (page, label) => { const state = await observe(page, label); observations.push(state); return state }
  try {
    const openPage = async (mobile, manual) => {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, acceptDownloads: false, permissions: [] })
      const initialUrl = `https://native-game.invalid/${built.buildId}-${mobile ? 'mobile' : 'desktop'}.html`
      const pageUrl = initialUrl + (manual ? '#manual=1' : '')
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
      const page = await context.newPage(); page.setDefaultTimeout(6000)
      page.on('pageerror', cause => error(cause.message))
      page.on('console', message => {
        if (message.type() !== 'error') return
        error(message.text())
        if (/Content Security Policy|connect-src|Refused to (?:connect|load)/i.test(message.text())) request('csp-blocked')
      })
      page.on('download', download => { error('download_blocked'); void download.cancel().catch(() => {}) })
      page.on('dialog', dialog => { error('dialog_blocked'); void dialog.dismiss().catch(() => {}) })
      page.on('framenavigated', frame => { if (frame === page.mainFrame() && frame.url() !== pageUrl) { error('navigation_blocked'); void page.close().catch(() => {}) } })
      await page.goto(pageUrl, { waitUntil: 'load' })
      await page.waitForFunction(() => window.__cw?.G && window.__gameState?.().templateId === 'cinderwatch')
      return { context, page }
    }
    const work = async () => {
      browser = await service.chromium.launch({ headless: true, executablePath: service.executablePath, timeout: 10000, args: ['--disable-extensions', '--no-first-run'] })
      stopped(); browserVersion = browser.version()
      const desktop = await openPage(false, true), page = desktop.page
      await snapshot(page, 'desktop-boot')
      rendering.desktop = await rendererEvidence(page, true)
      const image = rendering.desktop
      checks.renderer = /^WebGL 2/i.test(image.webglVersion) && image.geometries > 10 && image.visibleMeshes > 10 && image.drawCalls > 0 && image.sampledColours > 16 && image.opaquePixels > 2048
      let before = await snapshot(page, 'desktop-ready')
      if (before.manual) { await page.keyboard.press('c'); before = await snapshot(page, 'commander-enabled-for-check') }
      const pad = await visiblePad(page)
      if (!pad) throw new Error('cinderwatch_visible_build_pad_missing')
      await page.mouse.click(pad.x, pad.y)
      const selected = await snapshot(page, 'mouse-selected-pad')
      inputs.mouse = selected.menuPadIndex === pad.index && selected.manual
      checks.manualTakeover = !before.manual && selected.manual
      await page.keyboard.press('1')
      const builtState = await snapshot(page, 'keyboard-built-archer')
      const tower = builtState.towers.find(t => t.padIndex === pad.index)
      checks.buildSpend = !!tower && tower.kind === 'archer' && tower.spent > 0 && before.gold - builtState.gold === tower.spent && builtState.towers.length === before.towers.length + 1
      await page.keyboard.press('c')
      const returned = await snapshot(page, 'commander-returned')
      checks.commanderReturn = builtState.manual && !returned.manual
      inputs.keyboard = checks.buildSpend && checks.commanderReturn
      const baselineValue = before.gold + before.investment
      const baselineTime = before.simulationSeconds
      // Fixed 1/60s updates run actual targeting, projectiles, collisions, waves,
      // bounty and commander decisions. This is simulated game time, not FPS QA.
      for (let chunk = 0; chunk < 24; chunk++) {
        stopped()
        await page.evaluate(() => { for (let i = 0; i < 240; i++) window.__cw.tick(1 / 60, false) })
        finalState = await snapshot(page, `simulation-${(chunk + 1) * 4}s`)
        simulatedSeconds = finalState.simulationSeconds - baselineTime
        checks.waveProgress = finalState.wave >= Math.max(2, before.wave + 1)
        checks.kills = finalState.slain > before.slain
        checks.economy = finalState.gold + finalState.investment > baselineValue
        if (checks.waveProgress && checks.kills && checks.economy) break
        if (finalState.phase !== 'play') break
      }
      rendering.battle = await rendererEvidence(page, true)
      screenshots.push({ name: 'desktop.png', data: await page.screenshot({ type: 'png', timeout: 6000 }) })
      finalState = await snapshot(page, 'desktop-final')
      simulatedSeconds = finalState.simulationSeconds - baselineTime
      await desktop.context.close()
      stopped()
      // A separate real-time mobile loop proves pause actually stops game time,
      // then resumes it, and exercises touch hit-testing at phone dimensions.
      const mobile = await openPage(true, false), phone = mobile.page
      await phone.keyboard.press('p')
      const paused = await snapshot(phone, 'mobile-paused')
      await phone.waitForTimeout(160)
      const held = await snapshot(phone, 'mobile-pause-held')
      const phonePad = await visiblePad(phone)
      if (!phonePad) throw new Error('cinderwatch_mobile_build_pad_missing')
      await phone.touchscreen.tap(phonePad.x, phonePad.y)
      const touched = await snapshot(phone, 'mobile-touched-pad')
      inputs.touch = touched.menuPadIndex === phonePad.index && touched.manual && touched.touchMode
      // Capture the touch UI before the pause keyboard shortcut changes the
      // game's active input mode back to keyboard/mouse.
      await phone.waitForTimeout(40)
      screenshots.push({ name: 'mobile.png', data: await phone.screenshot({ type: 'png', timeout: 6000 }) })
      await phone.keyboard.press('p')
      await phone.waitForTimeout(160)
      const resumed = await snapshot(phone, 'mobile-resumed')
      mobileRealtimeSeconds = resumed.simulationSeconds - paused.simulationSeconds
      checks.pauseToggle = paused.paused && held.paused && held.simulationSeconds === paused.simulationSeconds && !resumed.paused && resumed.simulationSeconds > held.simulationSeconds
      checks.mobileLayout = await phone.evaluate(() => {
        const c = window.__cw, canvas = c.R.canvas.getBoundingClientRect()
        return document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight && canvas.width <= innerWidth + 1 && canvas.height <= innerHeight + 1 && canvas.width > 0 && canvas.height > 0
      })
      await mobile.context.close()
    }
    let rejectStop
    const stop = new Promise((_, reject) => { rejectStop = reject })
    const close = () => { void browser?.close().catch(() => {}) }
    abort = () => { cancelled = true; close(); rejectStop(new Error('game_operation_cancelled')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    timer = setTimeout(() => { timedOut = true; close(); rejectStop(new Error('game_playtest_timeout')) }, (seconds + 15) * 1000)
    try { runningWork = work(); await Promise.race([runningWork, stop]) }
    catch (cause) { error(cancelled ? 'game_operation_cancelled' : timedOut ? 'game_playtest_timeout' : cause.message) }
    const current = studio.readBuild(target).buildCurrent
    const passed = !cancelled && !timedOut && built.buildCurrent && current && errors === 0 && requests === 0 && Object.values(inputs).every(Boolean) && Object.values(checks).every(Boolean) && screenshots.length === 2 && ['play', 'clear', 'defeat'].includes(finalState?.phase)
    const finalPhase = finalState?.phase ?? 'unavailable'
    const report = {
      evidenceVersion: 1, templateId: 'cinderwatch', nativeTemplate: 'cinderwatch@1', mode: 'fixed-step-browser',
      testedAt: new Date().toISOString(), browser: browserVersion ?? 'unavailable', elapsedMs: Date.now() - start,
      finalPhase, errors, requests, errorDetails, requestDetails, inputs, checks, rendering, observations,
      simulatedSeconds, fixedStepSeconds: 1 / 60, mobileRealtimeSeconds,
      playtestStatus: passed ? 'passed' : 'failed',
      unassessed: [
        '桌面战斗按固定 1/60 秒执行游戏原有逻辑；模拟时间不代表实际运行帧率。',
        '手机尺寸、触屏与暂停通过浏览器模拟验证；尚未完成真人游玩或真机验收。',
        '未覆盖全部地图与 Boss、长时间稳定性、完整难度平衡、音质或资产替换。',
      ],
      summary: `Real browser tower-defense playtest: ${passed ? 'passed' : 'failed'}; phase=${finalPhase}; simulation=${simulatedSeconds.toFixed(2)}s; Errors: ${errors || 'none'}; Requests: ${requests}; Screenshots: ${screenshots.map(s => s.name).join(', ') || 'none'}`,
    }
    const recorded = studio.recordPlaytest({ ...target, report, screenshots })
    if (cancelled) throw new Error('game_operation_cancelled')
    return recorded
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
    await browser?.close().catch(() => {})
    await runningWork?.catch(() => {})
  }
}
