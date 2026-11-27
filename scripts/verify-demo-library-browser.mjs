/** Real gallery UI and sandboxed Cinderwatch checks. Uses installed browsers only; never downloads.
 * Optionally retain screenshots/report with DEMO_LIBRARY_EVIDENCE_DIR. Build lib/index.js first. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url))), require = createRequire(import.meta.url)
let chromium
for (const candidate of process.env.DSH_GAME_PLAYWRIGHT_PATH ? [process.env.DSH_GAME_PLAYWRIGHT_PATH] : [
  'playwright', 'playwright-core', join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
]) { try { chromium = require(candidate).chromium; if (chromium) break } catch { /* Installed providers only. */ } }
assert.ok(chromium, 'Requires installed Playwright; optionally set DSH_GAME_PLAYWRIGHT_PATH')
const executablePath = (process.env.DSH_GAME_BROWSER_EXECUTABLE ? [process.env.DSH_GAME_BROWSER_EXECUTABLE] : [
  join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA || homedir(), 'Microsoft/Edge/Application/msedge.exe'), chromium.executablePath(),
]).find(path => existsSync(path))
assert.ok(executablePath, 'Requires installed Chrome/Edge; optionally set DSH_GAME_BROWSER_EXECUTABLE')
const temporary = mkdtempSync(join(tmpdir(), 'dsh-demo-library-browser-'))
const evidenceDir = process.env.DEMO_LIBRARY_EVIDENCE_DIR && resolve(process.env.DEMO_LIBRARY_EVIDENCE_DIR)
process.env.DSH_HOME = temporary
process.env.DSH_WORKBENCH_DB = join(temporary, 'workbench.sqlite')
const modules = new Map(['demo', 'ui-demo.css'].map(name => [`/${name}.js`, ts.transpileModule(
  readFileSync(join(root, `src/client/${name}.ts`), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, fileName: `${name}.ts` },
).outputText]))
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Demo library browser check</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#f6f6f8}#host{display:block;max-width:1120px;margin:auto}</style>
<main id="host"></main><script type="module">
import { createDemoView } from '/demo.js';
const shadow = document.querySelector('#host').attachShadow({mode:'open'});
window.demoMessages=[];window.demoWorkflowOpened=false;
window.demoView=createDemoView(shadow.appendChild(document.createElement('div')),{
 api:'/workbench-api',esc:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 toast:message=>window.demoMessages.push(message),confirm:()=>false,getProjectId:()=>'',getProjectName:()=>'',
 themes:()=>[],designs:async()=>[],ensureStyles:css=>{const s=document.createElement('style');s.textContent=css;shadow.append(s)},
 seed:()=>null,clearSeed(){},openModal(){},closeModal(){},openWorkflowTemplates(){window.demoWorkflowOpened=true}
});window.demoView.mount();
</script></html>`
const routes = [], disposers = [], errors = [], externalRequests = []
let browser
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return }
  if (modules.has(path)) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(modules.get(path)); return }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
  const route = routes.find(item => path === item.path || path.startsWith(item.path + '/'))
  if (route) Promise.resolve(route.handler(req, res)).catch(error => { errors.push(String(error)); if (!res.writableEnded) { res.writeHead(500); res.end() } })
  else { res.writeHead(404); res.end() }
})
try {
  const { apply } = await import('../lib/index.js')
  apply({ webServer: { register(route) { routes.push(route); return () => {} }, tapIndex: () => () => {} }, tools: { register() {} },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
    get() {}, on: () => () => {}, logger: { info() {}, warn() {}, error() {} } })
  assert.ok(routes.some(route => route.path === '/workbench-api'), 'Production HTTP route registered')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ executablePath, headless: true, timeout: 10000, args: ['--disable-extensions', '--no-first-run'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  context.setDefaultTimeout(15000)
  context.on('page', opened => opened.on('pageerror', error => errors.push(error.message)))
  await context.route('**/*', route => {
    const url = route.request().url()
    if (!url.startsWith(origin + '/') && !/^(data|blob):/.test(url)) { externalRequests.push(url); return route.abort() }
    return route.continue()
  })
  const page = await context.newPage()
  await page.goto(origin)
  const card = page.locator('[data-demo="pick-pack"][data-id="cinderwatch"]')
  await card.waitFor({ state: 'visible' })
  assert.match(await card.innerText(), /Cinderwatch/)
  assert.equal(await page.locator('[data-demo="generate"]').isDisabled(), true, 'No project is needed for built-in demo')
  const image = card.locator('img')
  await image.scrollIntoViewIfNeeded()
  await image.evaluate(img => img.decode())
  assert.equal(await image.evaluate(img => {
    const rect = img.getBoundingClientRect()
    return img.naturalWidth > 0 && img.getRootNode().elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === img
  }), true, 'Loaded thumbnail is visible above fallback')
  assert.equal(await page.locator('iframe').count(), 0, 'Built-in preview stays unloaded until requested')
  await page.locator('[data-demo="filter"][data-filter="game"]').click()
  assert.equal(await page.locator('iframe').count(), 0, 'Filtering to games does not start the preview')
  await page.getByText('重新试玩', { exact: true }).click()
  const sandbox = await page.locator('iframe').getAttribute('sandbox')
  assert.ok(sandbox.split(/\s+/).includes('allow-scripts'))
  assert.ok(!sandbox.split(/\s+/).includes('allow-same-origin'))
  async function gameFrame(target = page) {
    const frame = await (await target.locator('iframe').elementHandle()).contentFrame()
    assert.ok(frame)
    await frame.waitForFunction(() => window.__gameState?.().templateId === 'cinderwatch' && window.__cw?.R?.renderer)
    await frame.waitForFunction(() => window.__cw.R.renderer.info.render.calls > 0)
    return frame
  }
  const desktopFrame = await gameFrame()
  const desktop = await desktopFrame.evaluate(() => {
    const state = window.__gameState(), gl = window.__cw.R.renderer.getContext()
    let parentBlocked = false; try { void parent.document.body } catch { parentBlocked = true }
    return { template: state.nativeTemplate, renderer: state.renderer, webgl: gl.getParameter(gl.VERSION), parentBlocked }
  })
  assert.equal(desktop.template, 'cinderwatch@1')
  assert.equal(desktop.renderer.revision, '170')
  assert.match(desktop.webgl, /^WebGL 2/)
  assert.ok(desktop.renderer.width > 0 && desktop.renderer.height > 0 && desktop.parentBlocked)
  if (evidenceDir) { mkdirSync(evidenceDir, { recursive: true }); await page.screenshot({ path: join(evidenceDir, 'demo-library-desktop.png'), fullPage: true }) }
  const inlineDetached = page.waitForEvent('framedetached', { predicate: frame => frame === desktopFrame })
  await page.locator('[data-demo="close-preview"]').click()
  await inlineDetached
  assert.equal(await page.locator('iframe').count(), 0, 'Closing inline preview unloads the game')
  assert.equal(await card.count(), 1, 'Closing preview retains the gallery')
  await page.locator('[data-demo="start-preview"]').click()
  assert.notEqual(await gameFrame(), desktopFrame, 'Restart creates a fresh rendered game frame')
  await page.locator('[data-demo="vp"][data-v="mobile"]').click()
  const mobileFrame = await gameFrame()
  const mobileWidth = await mobileFrame.evaluate(() => innerWidth)
  assert.ok(mobileWidth > 0 && mobileWidth <= 390, `Mobile preview width: ${mobileWidth}`)
  if (evidenceDir) await page.screenshot({ path: join(evidenceDir, 'demo-library-mobile.png'), fullPage: true })
  const opened = context.waitForEvent('page')
  await page.locator('.ud-detail-head [data-demo="open-pack"]').click()
  const popup = await opened
  const playUrl = origin + '/workbench-api/demos/library/cinderwatch/play'
  await popup.waitForURL(playUrl)
  await popup.locator('#close-playtest').waitFor({ state: 'visible' })
  await gameFrame(popup)
  const popupClosed = popup.waitForEvent('close')
  await popup.locator('#close-playtest').click()
  await popupClosed
  assert.equal(popup.isClosed(), true, 'The gallery-opened player closes its window')
  // Two real navigations represent an ordinary tab whose browser refuses script closing.
  const direct = await context.newPage()
  await direct.goto(origin)
  await direct.locator('[data-demo="pick-pack"]').waitFor({ state: 'visible' })
  await direct.goto(playUrl)
  const directFrame = await gameFrame(direct)
  const directDetached = direct.waitForEvent('framedetached', { predicate: frame => frame === directFrame })
  await direct.locator('#close-playtest').click()
  await directDetached
  assert.equal(direct.isClosed(), false, 'An ordinary tab stays available after unloading the game')
  assert.equal(await direct.locator('iframe').count(), 0)
  await direct.getByText('试玩已关闭，可关闭此标签页', { exact: false }).waitFor({ state: 'visible' })
  if (evidenceDir) await direct.screenshot({ path: join(evidenceDir, 'demo-playtest-closed.png') })
  await direct.locator('#restart-playtest').click()
  assert.notEqual(await gameFrame(direct), directFrame, 'Direct player restarts a fresh rendered game')
  await direct.close()
  await page.locator('[data-demo="tab"][data-tab="files"]').click()
  assert.match(await page.locator('.ud-view').innerText(), /game-cinderwatch-test/)
  assert.equal(await page.locator('.ud-detail-copy .ud-chip').count(), 11)
  assert.match(await page.locator('.ud-source-groups').innerText(), /assets\/vendor\/cinderwatch\/src\/90-main\.js/)
  await page.locator('[data-demo="workflow-templates"]').click()
  assert.equal(await page.evaluate(() => window.demoWorkflowOpened), true)
  await page.locator('[data-demo="tab"][data-tab="acceptance"]').click()
  assert.match(await page.locator('.ud-view').innerText(), /MIT[\s\S]*6640b81286df8b1fd2e5a745b48211c4a9323f83/)
  assert.deepEqual(await page.evaluate(() => window.demoMessages), [])
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  const controls = { inlineClose: true, inlineRestart: true, popupClose: true, directClose: true, directRestart: true }
  const report = { browser: browser.version(), desktop, mobileWidth, controls, errors, externalRequests, humanAcceptance: 'not exercised' }
  if (evidenceDir) writeFileSync(join(evidenceDir, 'demo-library-report.json'), JSON.stringify(report, null, 2))
  console.log('PASS demo library browser: project-free gallery, visible thumbnail, sandboxed WebGL, inline close/restart, standalone popup close, direct-tab close/restart, mobile viewport, nodes/source and license.', JSON.stringify(report))
} finally {
  await browser?.close()
  for (const dispose of disposers.reverse()) dispose()
  if (server.listening) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
  try { rmSync(temporary, { recursive: true, force: true }) } catch (error) { if (!['EBUSY', 'EPERM'].includes(error.code)) throw error }
}
