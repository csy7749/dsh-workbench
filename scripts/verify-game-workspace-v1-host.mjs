/** Build lib/index.js with npm run bundle:host before running this check.
 * Real Host wiring, temporary SQLite/products/game files and loopback
 * HTTP. --browser additionally mounts real app.ts and renders real Cinderwatch.
 * The DSH context is a registration harness; no model/provider/session is run. */
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url))), sourceRoot = join(root, 'src')
const temporary = mkdtempSync(join(tmpdir(), 'dsh-game-workspace-host-'))
const workspace = join(temporary, 'workspace'), otherWorkspace = join(temporary, 'other')
mkdirSync(workspace); mkdirSync(otherWorkspace)
process.env.DSH_HOME = temporary
process.env.DSH_WORKBENCH_DB = join(temporary, 'workbench.sqlite')
process.env.DSH_WORKBENCH_WORKFLOW_PAGE = '0'
const browserRequested = process.argv.includes('--browser')
const evidenceDir = resolve(process.env.GAME_WORKSPACE_V1_HOST_EVIDENCE_DIR || join(root, '.tmp-game-workspace-v1-host-evidence'))
const routes = [], disposers = [], tools = new Map(), errors = [], externalRequests = [], providerCalls = []
const modules = new Map(), loadedModules = new Set(), registeredGameCalls = []
const originalFetch = globalThis.fetch
let origin = '', browser, page, database, chromium, executablePath, requests = 0, browserPhase = 'setup'
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Real game Host wiring</title>
<style>html,body{margin:0;width:100%;height:100%}#app{height:100%}</style><div id="app"></div>
<script type="module">import {mountWorkbench} from '/source/client/app.ts';window.workbench=mountWorkbench(document.querySelector('#app'));</script></html>`
function sourceFor(path) {
  const normalized = resolve(sourceRoot, path.slice('/source/'.length))
  if (relative(sourceRoot, normalized).startsWith('..')) return null
  const actual = [normalized, normalized + '.ts', normalized + '.tsx', normalized.replace(/\.js$/, '.ts')].find(path => existsSync(path) && statSync(path).isFile())
  if (!actual) return null
  loadedModules.add(relative(root, actual).replaceAll('\\', '/'))
  if (!modules.has(actual)) modules.set(actual, /\.tsx?$/.test(actual) ? ts.transpileModule(readFileSync(actual, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React }, fileName: actual,
  }).outputText : readFileSync(actual, 'utf8'))
  return modules.get(actual)
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'), path = url.pathname
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (path.startsWith('/source/')) {
    const source = path.replace(/\.(tsx?|js)$/, '') === '/source/client/workflow/canvas-panel' ? 'export function mountCanvasInto(){return {destroy(){}}}' : sourceFor(path)
    if (source !== null) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(source); return }
  }
  const route = routes.find(route => path === route.path || path.startsWith(route.path + '/'))
  if (!route) { res.writeHead(404); res.end('{}'); return }
  if (path.startsWith('/workbench-api/game-studio/')) registeredGameCalls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams) })
  Promise.resolve(route.handler(req, res)).catch(error => {
    errors.push(String(error))
    if (!res.writableEnded) { res.writeHead(500); res.end('{}') }
  })
})

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  globalThis.fetch = (input, options) => {
    const url = String(input?.url ?? input)
    if (!url.startsWith(origin + '/')) { externalRequests.push(url); throw new Error('host_test_external_request_blocked') }
    return originalFetch(input, options)
  }
  if (browserRequested) {
    const require = createRequire(import.meta.url)
    let playwrightPath
    for (const name of process.env.DSH_GAME_PLAYWRIGHT_PATH ? [process.env.DSH_GAME_PLAYWRIGHT_PATH] : [
      'playwright', 'playwright-core', join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
    ]) { try { chromium = require(name).chromium; if (chromium) { playwrightPath = name; break } } catch {} }
    assert.ok(chromium, 'Requires installed Playwright; no browser is downloaded')
    executablePath = (process.env.DSH_GAME_BROWSER_EXECUTABLE ? [process.env.DSH_GAME_BROWSER_EXECUTABLE] : [
      join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), chromium.executablePath(),
    ]).find(path => existsSync(path))
    assert.ok(executablePath, 'Requires installed Edge/Chrome')
    // The actual Host playtester discovers the same installed provider; no fake
    // report, provider substitution or browser download is used for revisions.
    process.env.DSH_GAME_PLAYWRIGHT_PATH = playwrightPath
    process.env.DSH_GAME_BROWSER_EXECUTABLE = executablePath
  }
  const { apply } = await import('../lib/index.js')
  apply({
    webServer: { register(route) { routes.push(route); return () => {} }, tapIndex: () => () => {} },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => {} },
      get(name) { return tools.get(name) }, schemas() { return [...tools.values()].map(tool => ({ name: tool.name })) },
      async execute(input) { providerCalls.push({ kind: 'tool-execution', input }); throw new Error('host_test_provider_call_forbidden') },
    },
    agents: { async create(input) { providerCalls.push({ kind: 'agent-creation', input }); throw new Error('host_test_agent_creation_forbidden') }, get() {} },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
    get(name) { return this[name] }, on: () => () => {}, logger: { info() {}, warn() {}, error() {} },
  })
  assert.ok(routes.some(route => route.path === '/workbench-api'), 'The real built Host registers its public API')
  assert.ok(tools.has('workbench_game_create'), 'The same Host registers independent game tools')
  async function request(path, method = 'GET', body, expected = 200) {
    requests++
    const response = await fetch(origin + '/workbench-api' + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const payload = await response.json()
    assert.equal(response.status, expected, method + ' ' + path + ': ' + JSON.stringify(payload))
    return payload
  }
  const project = (await request('/projects', 'POST', { name: '真实 Host 游戏工作区', workspacePath: workspace })).project
  const otherProject = (await request('/projects', 'POST', { name: '隔离的另一项目', workspacePath: otherWorkspace })).project
  const product = (await request('/products', 'POST', { name: '真实 Host 守望主游戏', workspacePath: workspace })).product
  const productB = (await request('/products', 'POST', { name: '真实 Host 守望实验版', workspacePath: workspace })).product
  const otherProduct = (await request('/products', 'POST', { name: '另一项目产品', workspacePath: otherWorkspace })).product
  assert.equal(product.projectId, project.id)
  assert.equal(productB.projectId, project.id)
  assert.equal(otherProduct.projectId, otherProject.id)
  assert.equal((await request('/projects')).projects.length, 2)
  assert.equal((await request('/products')).products.length, 3)
  database = new DatabaseSync(process.env.DSH_WORKBENCH_DB)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM products').get().n, 3, 'Products were persisted by the actual SQLite store')
  const game = { productId: product.id, slug: 'host-alpha' }, gameB = { productId: productB.id, slug: 'host-beta' }
  const route = (action, input) => '/game-studio/' + action + '?' + new URLSearchParams(input)
  assert.deepEqual((await request(route('projects', { productId: product.id }))).result, [])
  const created = (await request('/game-studio/create', 'POST', { ...game, title: '真实 Host 的 Cinderwatch' })).result
  assert.equal(created.template, 'cinderwatch', 'Public HTTP invokes the shared game service with the correct execute signature')
  assert.equal(created.productId, product.id); assert.equal(created.slug, game.slug)
  assert.match(created.buildId, /^[a-f0-9]{12}$/)
  assert.equal(created.buildStatus, 'built')
  const beta = (await request('/game-studio/create', 'POST', { ...gameB, title: '真实 Host 的独立采集游戏', template: 'canvas-collector' })).result
  assert.equal(beta.template, 'canvas-collector')
  assert.deepEqual((await request(route('projects', { productId: product.id }))).result.map(item => item.slug), [game.slug])
  assert.deepEqual((await request(route('projects', { productId: productB.id }))).result.map(item => item.slug), [gameB.slug])
  assert.deepEqual((await request(route('projects', { productId: otherProduct.id }))).result, [])
  const initialSource = (await request(route('source', game))).result
  assert.ok(initialSource.source.length > 400000, 'The real complete Cinderwatch source is returned')
  assert.match(initialSource.currentHash, /^[a-f0-9]{64}$/)
  assert.equal((await request('/game-studio/build', 'POST', game)).result.buildId, created.buildId)
  const artifactPath = route('artifact', { ...game, buildId: created.buildId })
  const oldArtifactResponse = await fetch(origin + '/workbench-api' + artifactPath)
  assert.equal(oldArtifactResponse.status, 200)
  assert.equal(oldArtifactResponse.headers.get('x-game-build-id'), created.buildId)
  const oldArtifact = await oldArtifactResponse.text()
  assert.ok(oldArtifact.length > 1000000, 'The served game is the full offline artifact')
  appendFileSync(join(workspace, 'games', game.slug, 'game.js'), '\n// real Host wiring regression build\n')
  const rebuilt = (await request('/game-studio/build', 'POST', game)).result
  assert.notEqual(rebuilt.buildId, created.buildId)
  assert.notEqual((await request(route('source', game))).result.currentHash, initialSource.currentHash)
  assert.equal((await request(route('versions', game))).result.length, 2)
  assert.equal(await (await fetch(origin + '/workbench-api' + artifactPath)).text(), oldArtifact, 'The old build remains immutable through the production route')
  const exported = (await request('/game-studio/export', 'POST', { ...game, buildId: created.buildId })).result
  assert.equal(exported.buildId, created.buildId)
  assert.equal(exported.exported, true)
  assert.equal(readFileSync(join(workspace, exported.exportPath), 'utf8'), oldArtifact)
  await request(route('source', { ...game, productId: productB.id }), 'GET', undefined, 403)
  await request('/game-studio/export', 'POST', { ...game, productId: productB.id, buildId: created.buildId }, 403)
  assert.equal(providerCalls.length, 0)
  const report = { scope: 'real built lib/index.js Host registrations, actual HTTP handlers, temporary SQLite and game files',
    httpRequests: requests, defaultTemplate: created.template, oldBuild: created.buildId, rebuilt: rebuilt.buildId, exportedBuild: exported.buildId,
    sameWorkspaceProductIsolation: true, productionWiring: true, browser: 'not requested', screenshots: [],
    providerCalls, externalRequests, errors, liveDsh: 'not exercised; Host registration context is a harness', humanAcceptance: 'not exercised' }
  if (browserRequested) {
    browser = await chromium.launch({ executablePath, headless: true, timeout: 10000, args: ['--disable-extensions', '--no-first-run'] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } })
    context.setDefaultTimeout(25000)
    await context.route('**/*', route => {
      const url = route.request().url()
      if (!url.startsWith(origin + '/') && !/^(data|blob):/.test(url)) { externalRequests.push(url); return route.abort() }
      return route.continue()
    })
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin)
    await page.locator('[data-workbench-nav="projects"]').click()
    await page.locator(`[data-act="project-game-open"][data-product="${productB.id}"]`).first().click()
    await page.locator(`[data-game-workspace][data-product-id="${productB.id}"]`).waitFor({ state: 'visible' })
    const ws = page.locator('[data-game-workspace]'), action = name => ws.locator(`[data-game-action="${name}"]`)
    const field = name => ws.locator(`[data-game-field="${name}"]`)
    await ws.locator('[data-game-stage-button="overview"]').waitFor({ state: 'visible' })
    assert.equal(await page.locator('iframe').count(), 0)
    const createForm = ws.locator('[data-game-create-form]')
    if (!await createForm.evaluate(details => details.open)) await createForm.locator('summary').click()
    await field('new-title').fill('浏览器经真实 Host 创建的守望游戏')
    await field('new-slug').fill('host-ui-cinderwatch')
    await field('new-template').selectOption('cinderwatch')
    await action('create').click()
    await page.waitForFunction(() => document.querySelector('#app').shadowRoot.querySelector('[data-game-action="game-select"]')?.value === 'host-ui-cinderwatch')
    await action('preview-start').waitFor({ state: 'visible' })
    assert.equal(await page.locator('iframe').count(), 0, 'Real UI creation still requires explicit preview start')
    const uiGames = (await request(route('projects', { productId: productB.id }))).result
    const uiGame = uiGames.find(item => item.slug === 'host-ui-cinderwatch')
    assert.ok(uiGame); assert.equal(uiGame.template, 'cinderwatch')
    await action('preview-start').click()
    const iframe = page.locator('iframe[data-game-preview]')
    await iframe.waitFor({ state: 'visible' })
    assert.deepEqual((await iframe.getAttribute('sandbox')).split(/\s+/), ['allow-scripts'])
    const frame = await (await iframe.elementHandle()).contentFrame()
    await frame.waitForFunction(() => window.__gameState?.().templateId === 'cinderwatch' && window.__cw?.R?.renderer)
    await frame.waitForFunction(() => window.__cw.R.renderer.info.render.calls > 0)
    const rendered = await frame.evaluate(() => {
      const game = window.__gameState(), gl = window.__cw.R.renderer.getContext()
      let parentBlocked = false; try { void parent.document.body } catch { parentBlocked = true }
      return { nativeTemplate: game.nativeTemplate, renderer: game.renderer, webgl: gl.getParameter(gl.VERSION), parentBlocked }
    })
    assert.equal(rendered.nativeTemplate, 'cinderwatch@1')
    assert.match(rendered.webgl, /^WebGL 2/)
    assert.equal(rendered.parentBlocked, true)
    await frame.evaluate(() => { window.hostPlayContinuity = 'kept' })
    await action('preview-phone').click(); await action('preview-fit').click()
    assert.equal(await frame.evaluate(() => window.hostPlayContinuity), 'kept')
    mkdirSync(evidenceDir, { recursive: true })
    await page.locator('#wb-content').evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: join(evidenceDir, 'game-workspace-real-host-play.png'), fullPage: true })
    const detached = page.waitForEvent('framedetached', { predicate: target => target === frame })
    await ws.locator('[data-game-stage-button="deliver"]').click(); await detached
    await action('export').click()
    await ws.getByText(`games/${uiGame.slug}/exports/${uiGame.buildId}.html`, { exact: true }).waitFor({ state: 'visible' })
    assert.ok(existsSync(join(workspace, 'games', uiGame.slug, 'exports', uiGame.buildId + '.html')))

    const uiIdentity = { productId: productB.id, slug: uiGame.slug }
    async function appendSourceFromKeyboard(addition, phase) {
      browserPhase = phase
      const source = field('source')
      await ws.locator('[data-game-stage="make"]').waitFor({ state: 'visible' })
      await source.waitFor({ state: 'visible' })
      await source.scrollIntoViewIfNeeded()
      await page.waitForFunction(() => {
        const source = document.querySelector('#app')?.shadowRoot?.querySelector('[data-game-field="source"]')
        return source instanceof HTMLTextAreaElement && !source.disabled && !source.readOnly
      })
      const originalLength = await source.evaluate(node => node.value.length)
      await source.focus()
      await source.press('Control+End')
      // A short native keyboard insertion exercises the real input listener
      // without sending a 400KB fill argument into Playwright's error log.
      await page.keyboard.insertText(addition)
      const changed = await source.evaluate((node, suffix) => ({ length: node.value.length, endsWith: node.value.endsWith(suffix) }), addition)
      assert.equal(changed.length, originalLength + addition.length, phase + ': source length after native input')
      assert.equal(changed.endsWith, true, phase + ': appended source suffix')
    }
    async function postFromUi(name, button) {
      const pending = page.waitForResponse(response => response.url() === origin + '/workbench-api/game-studio/' + name && response.request().method() === 'POST', { timeout: 80000 })
      await button.click()
      const response = await pending, value = await response.json()
      assert.equal(response.status(), 200, name + ': ' + JSON.stringify(value))
      assert.equal(value.ok, true)
      return value.result
    }
    function retainPlaytestEvidence(name, detail) {
      assert.equal(detail.productId, productB.id)
      assert.equal(detail.slug, uiGame.slug)
      assert.equal(detail.requests, 0, 'The real playtester blocks and reports external game requests')
      assert.ok(detail.unassessed.some(item => /真人|真机/.test(item)), 'Real browser evidence explicitly leaves human acceptance unassessed')
      const persisted = JSON.parse(readFileSync(join(workspace, detail.reportPath), 'utf8'))
      assert.equal(persisted.buildId, detail.buildId)
      assert.equal(persisted.playtestStatus, detail.playtestStatus)
      writeFileSync(join(evidenceDir, name + '-report.json'), JSON.stringify(detail, null, 2))
      for (const file of detail.screenshots) {
        const absolute = resolve(workspace, file)
        assert.equal(relative(workspace, absolute).startsWith('..'), false)
        const saved = name + '-' + basename(file)
        copyFileSync(absolute, join(evidenceDir, saved)); report.screenshots.push(saved)
      }
      return { buildId: detail.buildId, playtestStatus: detail.playtestStatus, errors: detail.errors, requests: detail.requests,
        browser: detail.browser, checks: detail.checks, report: name + '-report.json', unassessed: detail.unassessed }
    }
    browserPhase = 'open source revision panel'
    await ws.locator('[data-game-stage-button="make"]').click()
    const cleanSource = await field('source').inputValue()
    assert.ok(cleanSource.length > 400000)
    await appendSourceFromKeyboard('\n// Harmless comment for real Host UI candidate acceptance.\n', 'append passing candidate')
    await field('reason').fill('真实 UI 验证：只追加无害注释，核验通过后采用此固定构建。')
    browserPhase = 'propose passing candidate'
    const proposed = await postFromUi('revision/propose', action('revision-propose'))
    assert.equal(proposed.status, 'proposed')
    const acceptedButton = ws.locator(`[data-game-candidate-id="${proposed.candidateId}"] [data-game-action="revision-verify"]`)
    await acceptedButton.waitFor({ state: 'visible' })
    browserPhase = 'verify passing candidate'
    const accepted = await postFromUi('revision/verify', acceptedButton)
    assert.equal(accepted.accepted, true, JSON.stringify(accepted.report?.checks))
    assert.equal(accepted.status, 'accepted')
    assert.notEqual(accepted.buildId, uiGame.buildId)
    assert.equal(accepted.report.buildId, accepted.buildId)
    assert.equal(accepted.report.playtestStatus, 'passed')
    assert.equal(accepted.report.errors, 0)
    await ws.getByText('候选自动核验通过，已采用。请人工试玩此构建。', { exact: true }).waitFor({ state: 'visible' })
    const acceptedState = (await request(route('state', uiIdentity))).result
    assert.equal(acceptedState.versions.find(item => item.buildCurrent).buildId, accepted.buildId)
    assert.equal(JSON.parse(readFileSync(join(workspace, accepted.candidatePath, 'status.json'), 'utf8')).status, 'accepted')
    const acceptedEvidence = retainPlaytestEvidence('revision-accepted', accepted.report)

    // Reload the new source baseline explicitly before preparing the failing
    // proposal. The actual playtester, not this test, detects the runtime error.
    browserPhase = 'reload adopted source baseline'
    await action('source-reload').click()
    await ws.getByText('源码草稿已替换为当前工程内容。', { exact: true }).waitFor({ state: 'visible' })
    const acceptedSource = (await request(route('source', uiIdentity))).result
    assert.ok(await field('source').inputValue() === acceptedSource.source, 'Reloaded source exactly matches the adopted baseline')
    await appendSourceFromKeyboard('\nthrow new Error("intentional-host-ui-revision-failure");\n', 'append failing candidate')
    await field('reason').fill('真实 UI 验证：故意触发运行时错误，核验必须失败并回退到已采用构建。')
    browserPhase = 'propose failing candidate'
    const badProposed = await postFromUi('revision/propose', action('revision-propose'))
    const rejectedButton = ws.locator(`[data-game-candidate-id="${badProposed.candidateId}"] [data-game-action="revision-verify"]`)
    await rejectedButton.waitFor({ state: 'visible' })
    browserPhase = 'verify failing candidate and rollback'
    const rejected = await postFromUi('revision/verify', rejectedButton)
    assert.equal(rejected.accepted, false)
    assert.equal(rejected.status, 'rejected', 'The domain records a failed verification as a rejected candidate')
    assert.equal(rejected.report.playtestStatus, 'failed')
    assert.ok(rejected.report.errors > 0)
    assert.ok(rejected.report.errorDetails.some(item => item.includes('intentional-host-ui-revision-failure')))
    assert.notEqual(rejected.report.buildId, accepted.buildId, 'The failed evidence belongs to its own tested candidate build')
    await ws.getByText('候选未通过，服务已回退；请核对当前构建与报告。', { exact: true }).waitFor({ state: 'visible' })
    const restoredState = (await request(route('state', uiIdentity))).result
    const restoredSource = (await request(route('source', uiIdentity))).result
    assert.equal(restoredState.versions.find(item => item.buildCurrent).buildId, accepted.buildId)
    assert.equal(restoredSource.currentHash, acceptedSource.currentHash)
    assert.ok(restoredSource.source === acceptedSource.source, 'Rollback restores the adopted source exactly')
    assert.equal((await request(route('revisions', uiIdentity))).result.find(item => item.candidateId === badProposed.candidateId).status, 'rejected')
    const rejectedEvidence = retainPlaytestEvidence('revision-rejected', rejected.report)
    await ws.locator('[data-game-stage-button="deliver"]').click()
    assert.equal(await action('build-select').inputValue(), accepted.buildId, 'Rollback leaves the accepted build selected')
    assert.match(await ws.locator('.gw-report-status').innerText(), new RegExp('自动检查通过.*' + accepted.buildId))
    await action('build-select').selectOption(rejected.report.buildId)
    assert.match(await ws.locator('.gw-report-status').innerText(), new RegExp('自动检查未通过.*' + rejected.report.buildId))
    await ws.getByText('人工体验尚未由本页验收', { exact: false }).waitFor({ state: 'visible' })
    await page.locator('#wb-content').evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: join(evidenceDir, 'game-workspace-real-host-rejected-build.png'), fullPage: true })
    report.revisionAcceptance = { candidateId: proposed.candidateId, status: accepted.status, accepted: accepted.accepted, ...acceptedEvidence }
    report.revisionRejection = { candidateId: badProposed.candidateId, status: rejected.status, accepted: rejected.accepted, restoredBuildId: accepted.buildId,
      currentHashRestored: true, sourceRestored: true, failedReportBoundToCandidateBuild: true, humanAcceptance: 'not exercised', ...rejectedEvidence }
    report.screenshots.push('game-workspace-real-host-rejected-build.png')
    report.browser = browser.version(); report.realGameRenderer = rendered
    report.browserCreation = { productId: productB.id, slug: uiGame.slug, buildId: uiGame.buildId, exported: true }
    report.clientScope = 'real source app.ts/game-workspace.ts; only unrelated React canvas stubbed; all API data and Cinderwatch artifacts are production Host outputs'
    report.loadedRealModules = [...loadedModules].sort()
    report.screenshots.push('game-workspace-real-host-play.png')
    await page.evaluate(() => window.workbench.destroy())
  }
  assert.equal(providerCalls.length, 0)
  assert.deepEqual(externalRequests, []); assert.deepEqual(errors, [])
  report.httpRequests = requests; report.productionGameRequests = registeredGameCalls.length
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, browserRequested ? 'game-workspace-real-host-report.json' : 'game-workspace-real-host-http-report.json'), JSON.stringify(report, null, 2))
  console.log('PASS game workspace real Host: built plugin -> SQLite registry -> production game HTTP -> shared service -> immutable artifacts/export' + (browserRequested ? '; real UI creation, sandboxed WebGL, source acceptance and failed-candidate rollback' : '') + '. ' + JSON.stringify(report))
} catch (error) {
  let ui
  if (page && !page.isClosed()) {
    mkdirSync(evidenceDir, { recursive: true })
    ui = await page.evaluate(() => {
      const root = document.querySelector('#app')?.shadowRoot
      const source = root?.querySelector('[data-game-field="source"]'), box = source?.getBoundingClientRect()
      return { stage: root?.querySelector('[data-game-stage]')?.getAttribute('data-game-stage'),
        source: source ? { length: source.value.length, disabled: source.disabled, readOnly: source.readOnly,
          connected: source.isConnected, display: getComputedStyle(source).display, visibility: getComputedStyle(source).visibility,
          box: box && { x: box.x, y: box.y, width: box.width, height: box.height } } : null,
        activeField: root?.activeElement?.getAttribute('data-game-field'),
        notice: root?.querySelector('[data-game-notice]')?.textContent?.slice(0, 700) }
    }).catch(() => ({ unavailable: true }))
    await page.screenshot({ path: join(evidenceDir, 'game-workspace-real-host-failure.png'), fullPage: true, timeout: 5000 }).catch(() => {})
  }
  const compactError = { name: error?.name, message: String(error?.message ?? error).slice(0, 1800),
    stack: String(error?.stack ?? '').split('\n').slice(0, 7).map(line => line.slice(0, 350)) }
  console.error('Real Host failure:', JSON.stringify({ phase: browserPhase, error: compactError, ui }))
  console.error('Real Host diagnostics:', JSON.stringify({ requests, errors: errors.map(error => String(error).slice(0, 500)), externalRequests, providerCalls, registeredGameCalls }))
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  await browser?.close()
  database?.close()
  for (const dispose of disposers.reverse()) dispose()
  if (server.listening) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
  if (dirname(realpathSync(temporary)) !== realpathSync(tmpdir()) || !basename(temporary).startsWith('dsh-game-workspace-host-')) throw new Error('unsafe_test_cleanup')
  try { rmSync(temporary, { recursive: true, force: true }) } catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error }
}
