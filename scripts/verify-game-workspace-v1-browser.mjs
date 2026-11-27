/** Mount the real workbench app and game workspace in an installed browser.
 * HTTP records are isolated fixtures; only the unrelated React canvas is stubbed.
 * This is not a live DSH run, model call, real game rendering or human acceptance. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url))), sourceRoot = join(root, 'src')
const require = createRequire(import.meta.url)
let chromium
for (const name of process.env.DSH_GAME_PLAYWRIGHT_PATH ? [process.env.DSH_GAME_PLAYWRIGHT_PATH] : [
  'playwright', 'playwright-core', join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
]) { try { chromium = require(name).chromium; if (chromium) break } catch {} }
assert.ok(chromium, 'Requires installed Playwright; no browser is downloaded')
const executablePath = (process.env.DSH_GAME_BROWSER_EXECUTABLE ? [process.env.DSH_GAME_BROWSER_EXECUTABLE] : [
  join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), chromium.executablePath(),
]).find(path => existsSync(path))
assert.ok(executablePath, 'Requires installed Edge/Chrome')
const evidenceDir = resolve(process.env.GAME_WORKSPACE_V1_EVIDENCE_DIR || join(root, '.tmp-game-workspace-v1-evidence'))
const errors = [], externalRequests = [], unexpected = [], writes = [], gameReads = [], artifacts = []
const moduleCache = new Map(), loadedModules = new Set()
const sharedWorkspace = 'D:/fixture/game-shared', otherWorkspace = 'D:/fixture/game-other'
const projects = [
  { id: 'project-a', name: '余烬守望研发', workspacePath: sharedWorkspace },
  { id: 'project-b', name: '第二游戏项目', workspacePath: otherWorkspace },
  { id: 'project-empty', name: '暂无产品的项目', workspacePath: '' },
]
const products = [
  { id: 'product-a', name: '守望主游戏', projectId: 'project-a', workspacePath: sharedWorkspace },
  { id: 'product-b', name: '守望实验版', projectId: 'project-a', workspacePath: sharedWorkspace },
  { id: 'product-other', name: '第二项目游戏', projectId: 'project-b', workspacePath: otherWorkspace },
  { id: 'product-legacy', name: '旧格式同工作区产品', workspacePath: sharedWorkspace },
  { id: 'product-conflict', name: '项目身份优先产品', projectId: 'project-b', workspacePath: sharedWorkspace },
  { id: 'product-unassigned', name: '尚无归属产品', workspacePath: '' },
].map(product => ({ ...product, description: '游戏工作区浏览器隔离检查', notebookId: '', mindmap: '[]', styles: [], createdAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z' }))
const fixtureGame = (productId, letter) => ({
  productId, slug: 'game-' + productId, title: products.find(product => product.id === productId).name,
  projectId: 'native-' + productId, template: 'cinderwatch', buildId: letter.repeat(12),
  currentHash: letter.repeat(64), sourceHash: 'e'.repeat(64), manifestHash: 'f'.repeat(64),
  source: `// ${productId} fixture source\nwindow.__fixtureGame = true;\n`, revisions: [],
})
const games = new Map([['product-a', [fixtureGame('product-a', 'a')]], ['product-b', [fixtureGame('product-b', 'b')]], ['product-other', [fixtureGame('product-other', 'c')]]])
let holdNextProjects = false, releaseProjects = null, notifyProjectsHeld = null
const urls = game => {
  const query = new URLSearchParams({ productId: game.productId, slug: game.slug, buildId: game.buildId })
  return Object.fromEntries(['preview', 'artifact', 'download'].map(action => [action + 'Url', '/workbench-api/game-studio/' + action + '?' + query]))
}
const receipt = game => ({ productId: game.productId, projectId: game.projectId, slug: game.slug, title: game.title, template: game.template,
  buildId: game.buildId, buildCurrent: true, buildStatus: 'built', playtestStatus: 'not_assessed', valid: true, bytes: 2048, previewAvailable: true, ...urls(game) })
const gameState = game => ({ currentHash: game.currentHash, sourceHash: game.sourceHash, manifestHash: game.manifestHash,
  manifest: { schemaVersion: 1, projectId: game.projectId, title: game.title, templateId: game.template, templateVersion: 1, orientation: 'landscape', rules: { seed: 4, biome: 'ashen', startingGold: 300, lives: 20, autoCommand: true } }, versions: [receipt(game)] })
const json = (res, data, code = 200) => { if (res.destroyed) return; res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
async function requestBody(req) { let text = ''; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {} }
function sourceFor(path) {
  const normalized = resolve(sourceRoot, path.slice('/source/'.length))
  if (relative(sourceRoot, normalized).startsWith('..')) return null
  const actual = [normalized, normalized + '.ts', normalized + '.tsx', normalized.replace(/\.js$/, '.ts')].find(path => existsSync(path) && statSync(path).isFile())
  if (!actual) return null
  loadedModules.add(relative(root, actual).replaceAll('\\', '/'))
  if (!moduleCache.has(actual)) moduleCache.set(actual, /\.tsx?$/.test(actual) ? ts.transpileModule(readFileSync(actual, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React }, fileName: actual,
  }).outputText : readFileSync(actual, 'utf8'))
  return moduleCache.get(actual)
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Game workbench v1 real mount</title>
<style>html,body{margin:0;width:100%;height:100%}#app{height:100%}</style><div id="app"></div>
<script type="module">import {mountWorkbench} from '/source/client/app.ts';window.workbench=mountWorkbench(document.querySelector('#app'));</script></html>`
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return }
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
    if (path.startsWith('/source/')) {
      const text = path.replace(/\.(tsx?|js)$/, '') === '/source/client/workflow/canvas-panel' ? 'export function mountCanvasInto(){return {destroy(){}}}' : sourceFor(path)
      if (text !== null) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(text); return }
    }
    if (path.startsWith('/workbench-api/assets/vendor/')) {
      const file = resolve(root, path.slice('/workbench-api/'.length))
      if (!relative(join(root, 'assets/vendor'), file).startsWith('..') && existsSync(file)) {
        res.writeHead(200, { 'content-type': extname(file) === '.css' ? 'text/css' : 'text/javascript' }); res.end(readFileSync(file)); return
      }
    }
    if (path.startsWith('/workbench-api/game-studio/')) {
      const action = path.slice('/workbench-api/game-studio/'.length)
      const input = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await requestBody(req)
      if (req.method === 'GET') gameReads.push({ action, ...input })
      else writes.push({ path, action, input })
      if (action === 'capabilities') { json(res, { ok: true, provider: 'workbench-native', defaultTemplate: 'cinderwatch', templates: ['cinderwatch', 'canvas-collector', 'three-collector'], operations: { create: true, build: true, preview: true, export: true, playtest: true, versions: true, assets: true, revise: 'source-candidate-cas-browser-rollback' }, browser: { available: true }, limitations: ['自动试玩不等于人工验收。'] }); return }
      assert.ok(products.some(product => product.id === input.productId), 'A game request requires an explicitly selected known product')
      if (action === 'projects') {
        const payload = { ok: true, result: (games.get(input.productId) ?? []).map(receipt) }
        if (holdNextProjects) { holdNextProjects = false; releaseProjects = () => { json(res, payload); releaseProjects = null }; notifyProjectsHeld?.(); notifyProjectsHeld = null }
        else json(res, payload)
        return
      }
      if (action === 'create') {
        assert.equal(input.productId, 'product-b', 'The test creates into the explicitly selected second product')
        assert.equal(input.slug, 'fixture-created')
        assert.ok(input.title)
        const game = { ...fixtureGame(input.productId, 'd'), slug: input.slug, title: input.title, template: input.template || 'cinderwatch' }
        games.get(input.productId).push(game); json(res, { ok: true, result: receipt(game) }); return
      }
      const game = (games.get(input.productId) ?? []).find(game => game.slug === input.slug)
      assert.ok(game, 'Requests stay bound to one product and registered game')
      if (action === 'state') { json(res, { ok: true, result: gameState(game) }); return }
      if (action === 'versions') { json(res, { ok: true, result: [receipt(game)] }); return }
      if (action === 'source') { json(res, { ok: true, result: { source: game.source, currentHash: game.currentHash, sourceHash: game.sourceHash, manifestHash: game.manifestHash } }); return }
      if (action === 'assets') { json(res, { ok: true, result: [] }); return }
      if (action === 'revisions') { json(res, { ok: true, result: game.revisions }); return }
      if (action === 'build') { json(res, { ok: true, result: receipt(game) }); return }
      if (action === 'revision/propose') {
        assert.equal(input.expectedCurrentHash, game.currentHash, 'The browser submits the draft original CAS baseline')
        assert.equal(input.expectedBuildId, game.buildId)
        assert.ok(input.source !== game.source && input.reason)
        const candidate = { candidateId: 'candidate-' + game.productId, status: 'proposed', reason: input.reason, createdAt: '2026-11-27T01:00:00Z', expectedBuildId: input.expectedBuildId }
        game.revisions.push(candidate); json(res, { ok: true, result: candidate }); return
      }
      if (action === 'export') {
        assert.equal(input.buildId, game.buildId)
        json(res, { ok: true, result: { ...receipt(game), exported: true, offline: true, exportPath: `games/${game.slug}/exports/${game.buildId}.html` } }); return
      }
      if (action === 'artifact') {
        assert.equal(input.buildId, game.buildId)
        artifacts.push({ ...input })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'" })
        res.end(`<!doctype html><meta charset="utf-8"><style>body{background:#132520;color:#f1f7f3;font:18px sans-serif;padding:24px}</style><p>隔离的游戏预览测试页</p><script>window.fixtureBuild=${JSON.stringify(input.buildId)};window.fixtureProduct=${JSON.stringify(input.productId)}</script>`); return
      }
      throw new Error('Unexpected game fixture action: ' + action)
    }
    if (path.startsWith('/workbench-api/')) {
      if (req.method !== 'GET') {
        const input = await requestBody(req)
        writes.push({ path, input })
        if (path === '/workbench-api/state') { json(res, { ok: true, revision: 2 }); return }
        json(res, { ok: false, error: 'fixture_forbids_execution' }, 403); return
      }
      if (path === '/workbench-api/state') { json(res, { revision: 1, spaces: [], tasks: [], focus: [], settings: { theme: 'light' } }); return }
      if (path === '/workbench-api/projects') { json(res, { projects }); return }
      if (path === '/workbench-api/products') { json(res, { products, modules: [], demos: [] }); return }
      json(res, { ok: true, maps: [], versions: [], projects: [], notes: [], notebooks: [], themes: [], designs: [], modules: [], demos: [], bugs: [], cases: [], runs: [], teams: [], members: [], templates: [] }); return
    }
    unexpected.push(path); res.writeHead(404); res.end()
  } catch (error) { errors.push(error.message); if (!res.writableEnded) json(res, { ok: false, error: error.message }, 500) }
})

let browser, page
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ executablePath, headless: true, timeout: 10000, args: ['--disable-extensions', '--no-first-run'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } })
  context.setDefaultTimeout(15000)
  await context.route('**/*', route => {
    const url = route.request().url()
    if (!url.startsWith(origin + '/') && !/^(data|blob):/.test(url)) { externalRequests.push(url); return route.abort() }
    return route.continue()
  })
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
  const projectPicker = () => page.locator('#wb-project').first(), productPicker = () => page.locator('#wb-game-product')
  const workspace = () => page.locator('[data-game-workspace]').first()
  const action = name => workspace().locator(`[data-game-action="${name}"]`)
  const stage = name => workspace().locator(`[data-game-stage-button="${name}"]`)
  const field = name => workspace().locator(`[data-game-field="${name}"]`)
  async function openGame() {
    await page.locator('[data-workbench-nav="projects"]').click()
    await page.locator('[data-view="game"]:visible').first().click()
    await productPicker().waitFor({ state: 'visible' })
  }
  async function selectProduct(id) {
    await productPicker().selectOption(id)
    await page.locator(`[data-game-workspace][data-product-id="${id}"]`).waitFor({ state: 'visible' })
    await action('game-select').locator(`option[value="game-${id}"]`).waitFor({ state: 'attached' })
    await action('game-select').selectOption('game-' + id)
    await stage('play').waitFor({ state: 'visible' })
  }
  async function assertProductOptions(expected) {
    await page.waitForFunction(count => [...document.querySelector('#app').shadowRoot.querySelector('#wb-game-product').options].filter(option => option.value).length === count, expected.length)
    assert.deepEqual(await productPicker().locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean).sort()), expected.slice().sort())
  }
  async function assertNoPageOverflow(label) {
    const measure = await page.evaluate(() => {
      const shadow = document.querySelector('#app').shadowRoot
      const candidates = [...shadow.querySelectorAll('.wb-layout,.wb-main,.wb-content,#wb-content,[data-game-workspace]')]
      return { outer: document.documentElement.scrollWidth - innerWidth, elements: candidates.map(node => ({ name: node.id || node.className || node.tagName, client: node.clientWidth, scroll: node.scrollWidth, right: node.getBoundingClientRect().right })) }
    })
    assert.ok(measure.outer <= 1, label + ': outer page overflow ' + JSON.stringify(measure))
    assert.ok(measure.elements.every(node => node.scroll <= node.client + 1 && node.right <= 901 + (page.viewportSize().width - 900)), label + ': workspace shell overflow ' + JSON.stringify(measure))
  }

  await page.goto(origin)
  for (const [name, label] of [['start', '开始'], ['projects', '项目'], ['assets', '素材'], ['runs', '运行'], ['more', '更多']]) {
    const nav = page.locator(`[data-workbench-nav="${name}"]`)
    await nav.waitFor({ state: 'visible' }); assert.match(await nav.innerText(), new RegExp(label))
  }
  await openGame()
  assert.equal(await projectPicker().inputValue(), 'all')
  assert.equal(await productPicker().inputValue(), '', 'All-project scope starts with an explicit product choice')
  await assertProductOptions([])
  assert.equal(gameReads.filter(read => read.productId).length, 0, 'Opening the game entry in all scope does not read another product')
  assert.equal(await page.locator('iframe').count(), 0)
  await projectPicker().selectOption(sharedWorkspace)
  await assertProductOptions(['product-a', 'product-b', 'product-legacy'])
  assert.equal(await productPicker().inputValue(), '', 'Choosing a project still requires an explicit product choice')

  await selectProduct('product-a')
  assert.equal(await projectPicker().inputValue(), sharedWorkspace, 'A product choice keeps the explicitly selected global project scope')
  assert.equal(await page.locator('iframe').count(), 0, 'Loading a game never starts the preview automatically')
  assert.equal(await workspace().locator('[data-game-create-form]').evaluate(details => details.open), false, 'Existing games keep the creation form folded on first load')
  await stage('play').click()
  assert.equal(await page.locator('iframe').count(), 0, 'Entering play still waits for an explicit start')
  await action('preview-start').click()
  const firstFrameEl = page.locator('[data-game-workspace] iframe')
  await firstFrameEl.waitFor({ state: 'visible' })
  const frameUrl = new URL(await firstFrameEl.getAttribute('src'), origin)
  assert.equal(frameUrl.pathname, '/workbench-api/game-studio/artifact')
  assert.equal(frameUrl.searchParams.get('productId'), 'product-a')
  assert.equal(frameUrl.searchParams.get('buildId'), 'a'.repeat(12))
  assert.deepEqual((await firstFrameEl.getAttribute('sandbox')).split(/\s+/).sort(), ['allow-scripts'])
  const firstFrame = await (await firstFrameEl.elementHandle()).contentFrame()
  await firstFrame.waitForFunction(() => window.fixtureBuild === 'aaaaaaaaaaaa')
  assert.equal(await firstFrame.evaluate(() => { try { void parent.document.body; return false } catch { return true } }), true)
  await firstFrame.evaluate(() => { window.playContinuity = 'kept' })
  const artifactReadsBeforeRender = artifacts.length
  await action('preview-phone').click()
  await field('issue').fill('连续性检查：切换视口和刷新应保留当前试玩状态')
  await action('reload').click()
  await page.waitForFunction(() => !document.querySelector('#app').shadowRoot.querySelector('[data-game-action="reload"]').disabled)
  assert.equal(await firstFrame.evaluate(() => window.playContinuity), 'kept', 'Viewport, issue editing and refresh preserve the live iframe browsing context')
  await action('preview-fit').click()
  assert.equal(await firstFrame.evaluate(() => window.playContinuity), 'kept')
  assert.equal(artifacts.length, artifactReadsBeforeRender, 'Ordinary UI renders do not request or reload the game artifact')
  mkdirSync(evidenceDir, { recursive: true })
  await page.locator('#wb-content').evaluate(node => { node.scrollTop = 0 })
  await page.screenshot({ path: join(evidenceDir, 'game-workspace-play-desktop.png'), fullPage: true })
  const closeDetached = page.waitForEvent('framedetached', { predicate: frame => frame === firstFrame })
  await action('preview-close').click(); await closeDetached
  assert.equal(await page.locator('[data-game-workspace] iframe').count(), 0)
  await action('preview-start').click()
  const secondFrame = await (await page.locator('[data-game-workspace] iframe').elementHandle()).contentFrame()
  await secondFrame.waitForFunction(() => Boolean(window.fixtureBuild))
  const stageDetached = page.waitForEvent('framedetached', { predicate: frame => frame === secondFrame })
  await stage('overview').click(); await stageDetached
  assert.equal(await page.locator('[data-game-workspace] iframe').count(), 0, 'Leaving play unloads the game')

  await stage('make').click()
  if (!await field('source').inputValue()) await action('source-reload').click()
  await field('source').fill(games.get('product-a')[0].source + '// local draft\n')
  await field('reason').fill('在隔离fixture里检查草稿基线')
  assert.equal(await action('revision-propose').isEnabled(), true)
  const oldDraft = await field('source').inputValue()
  const currentGame = games.get('product-a')[0]
  currentGame.currentHash = 'd'.repeat(64); currentGame.sourceHash = '9'.repeat(64); currentGame.source += '// external workcopy change\n'
  await action('reload').click()
  await workspace().getByText('草稿基线已变化', { exact: false }).waitFor({ state: 'visible' })
  assert.equal(await field('source').inputValue(), oldDraft, 'Refreshing preserves the user draft for review')
  assert.equal(await action('revision-propose').isDisabled(), true, 'The old draft cannot borrow the freshly loaded CAS hash')
  assert.equal(writes.filter(write => write.action === 'revision/propose').length, 0)
  await action('source-reload').click()
  await page.waitForFunction(expected => document.querySelector('#app').shadowRoot.querySelector('[data-game-field="source"]').value === expected, currentGame.source)
  await field('source').fill(currentGame.source + '// accepted new baseline draft\n')
  await field('reason').fill('显式重新载入后的候选')
  await action('revision-propose').click()
  await page.waitForFunction(() => document.querySelector('#app').shadowRoot.querySelector('[data-game-action="revision-verify"]'))
  assert.equal(writes.filter(write => write.action === 'revision/propose').length, 1)
  assert.equal(writes.find(write => write.action === 'revision/propose').input.expectedCurrentHash, currentGame.currentHash)
  assert.match(await action('revision-verify').first().innerText(), /(?:核验|验证).*采用/, 'The UI names the existing verify-and-adopt operation accurately')

  await selectProduct('product-b')
  assert.equal(await page.locator('[data-game-workspace][data-product-id="product-a"]').count(), 0)
  assert.equal(await action('game-select').inputValue(), 'game-product-b')
  await stage('play').click(); await action('preview-start').click()
  const productFrame = await (await page.locator('[data-game-workspace] iframe').elementHandle()).contentFrame()
  await productFrame.waitForFunction(() => window.fixtureProduct === 'product-b')
  const productDetached = page.waitForEvent('framedetached', { predicate: frame => frame === productFrame })
  await projectPicker().selectOption(otherWorkspace); await productDetached
  assert.equal(await productPicker().inputValue(), '')
  assert.equal(await page.locator('[data-game-workspace]').count(), 0)
  await assertProductOptions(['product-other', 'product-conflict'])
  await projectPicker().selectOption(sharedWorkspace)
  await assertProductOptions(['product-a', 'product-b', 'product-legacy'])
  assert.equal(await productPicker().inputValue(), '', 'Same-workspace products do not auto-select the first product')
  await projectPicker().selectOption('prj:project-empty')
  await assertProductOptions([])
  assert.equal(await page.locator('[data-game-workspace]').count(), 0, 'An empty project cannot borrow a foreign product')

  await projectPicker().selectOption('all')
  await assertProductOptions([])
  await projectPicker().selectOption(sharedWorkspace)
  await assertProductOptions(['product-a', 'product-b', 'product-legacy'])
  let held
  const heldPromise = new Promise(resolve => { notifyProjectsHeld = resolve })
  holdNextProjects = true
  await productPicker().selectOption('product-a')
  await heldPromise
  await selectProduct('product-b')
  held = releaseProjects; assert.ok(held); held()
  await page.waitForTimeout(100)
  assert.equal(await page.locator('[data-game-workspace][data-product-id="product-a"]').count(), 0, 'An old delayed product response cannot remount its workspace')
  assert.equal(await action('game-select').inputValue(), 'game-product-b')

  const createForm = workspace().locator('[data-game-create-form]')
  if (!await createForm.evaluate(details => details.open)) await createForm.locator('summary').click()
  await field('new-title').fill('从工作区创建的游戏')
  await field('new-slug').fill('fixture-created')
  await field('new-template').selectOption('cinderwatch')
  await action('create').click()
  await page.waitForFunction(() => document.querySelector('#app').shadowRoot.querySelector('[data-game-action="game-select"]')?.value === 'fixture-created')
  assert.equal(await page.locator('[data-game-workspace] iframe').count(), 0, 'Creation enters play with its first fixed build but does not auto-start')
  await stage('deliver').click(); await action('export').click()
  await workspace().getByText('games/fixture-created/exports/' + 'd'.repeat(12) + '.html', { exact: true }).waitFor({ state: 'visible' })
  const exportWrite = writes.find(write => write.action === 'export')
  assert.deepEqual(exportWrite.input, { productId: 'product-b', slug: 'fixture-created', buildId: 'd'.repeat(12) })
  await stage('play').click(); await action('preview-start').click()
  const createdFrame = await (await page.locator('[data-game-workspace] iframe').elementHandle()).contentFrame()
  await createdFrame.waitForFunction(() => window.fixtureBuild === 'dddddddddddd')
  const gameDetached = page.waitForEvent('framedetached', { predicate: frame => frame === createdFrame })
  await action('game-select').selectOption('game-product-b'); await gameDetached
  await page.waitForFunction(() => document.querySelector('#app').shadowRoot.querySelector('[data-game-action="build-select"]')?.value === 'bbbbbbbbbbbb')
  assert.equal(await page.locator('[data-game-workspace] iframe').count(), 0, 'Switching games within the same product unloads the prior build')

  mkdirSync(evidenceDir, { recursive: true })
  await stage('overview').click()
  await page.locator('#wb-content').evaluate(node => { node.scrollTop = 0 })
  await page.screenshot({ path: join(evidenceDir, 'game-workspace-desktop.png'), fullPage: true })
  await assertNoPageOverflow('1440px overview')
  await page.setViewportSize({ width: 900, height: 1000 })
  await assertNoPageOverflow('900px overview')
  await stage('make').click()
  await page.locator('#wb-content').evaluate(node => { node.scrollTop = 0 })
  await assertNoPageOverflow('900px make')
  await page.screenshot({ path: join(evidenceDir, 'game-workspace-900.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1080 })
  for (const view of ['ui', 'product']) {
    const entry = page.locator(`.side-item[data-view="${view}"]`).first()
    await entry.click(); await page.waitForTimeout(50)
    assert.equal(await page.locator('[data-game-workspace]').count(), 0, 'Legacy ' + view + ' entry remains reachable')
  }
  await page.locator('[data-workbench-nav="assets"]').click()
  await page.locator('[data-workbench-nav="runs"]').click()
  await page.locator('[data-workbench-nav="more"]').click()
  await page.locator('[data-workbench-nav="start"]').click()
  await openGame(); await selectProduct('product-b'); await stage('play').click(); await action('preview-start').click()
  const destroyFrame = await (await page.locator('[data-game-workspace] iframe').elementHandle()).contentFrame()
  await destroyFrame.waitForFunction(() => Boolean(window.fixtureBuild))
  const destroyDetached = page.waitForEvent('framedetached', { predicate: frame => frame === destroyFrame })
  await page.evaluate(() => window.workbench.destroy()); await destroyDetached
  assert.equal(await page.locator('[data-game-workspace]').count(), 0, 'Destroy unloads the independent game workspace')
  assert.ok(loadedModules.has('src/client/app.ts') && loadedModules.has('src/client/game-workspace.ts'))
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(externalRequests, [])
  assert.equal(writes.some(write => /agents\/dispatch|workflow.*run|asset\/generate|revision\/verify/.test(write.path)), false, 'The mount suite never creates sessions, workflow executions or provider jobs')
  const report = { browser: browser.version(), loadedRealModules: [...loadedModules].sort(), gameReads: gameReads.length,
    explicitProductSelection: true, sharedWorkspaceIsolation: true, delayedResponseIsolation: true,
    draftCas: true, createAndExactBuildExport: true, fixedBuildSandbox: true, previewContinuity: true, previewClose: true, stageLeaveUnload: true, gameSwitchUnload: true, destroyUnload: true,
    narrowViewport: 900, artifacts, errors, externalRequests, writes: writes.map(write => ({ path: write.path, action: write.action })),
    scope: 'real app.ts and game-workspace.ts with isolated HTTP fixtures; unrelated React canvas stubbed',
    modelCalls: 0, realGameRenderer: 'not exercised', realDsh: 'not exercised', humanAcceptance: 'not exercised' }
  writeFileSync(join(evidenceDir, 'game-workspace-report.json'), JSON.stringify(report, null, 2))
  console.log('PASS game workbench v1 browser: five global entries, independent game workspace, explicit product scope, stale response/draft CAS, fixed-build opaque preview and teardown, legacy entries, 900px layout. ' + JSON.stringify(report))
} catch (error) {
  if (page && !page.isClosed()) { mkdirSync(evidenceDir, { recursive: true }); await page.screenshot({ path: join(evidenceDir, 'game-workspace-failure.png'), fullPage: true }).catch(() => {}) }
  console.error('Game workspace browser fixture diagnostics:', JSON.stringify({ errors, unexpected, gameReads, writes }))
  throw error
} finally {
  releaseProjects?.()
  await browser?.close()
  if (server.listening) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
}
