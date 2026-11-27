/** Mount the real app.ts in Edge; only the unrelated React workflow canvas is stubbed.
 * HTTP data is an isolated fixture. No real DSH, model, or generation API is used. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import sharp from 'sharp'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceRoot = join(root, 'src'), require = createRequire(import.meta.url)
let chromium
for (const name of process.env.DSH_GAME_PLAYWRIGHT_PATH ? [process.env.DSH_GAME_PLAYWRIGHT_PATH] : [
  'playwright', 'playwright-core', join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
]) { try { chromium = require(name).chromium; if (chromium) break } catch {} }
assert.ok(chromium, 'Requires installed Playwright')
const executablePath = (process.env.DSH_GAME_BROWSER_EXECUTABLE ? [process.env.DSH_GAME_BROWSER_EXECUTABLE] : [
  join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), chromium.executablePath(),
]).find(path => existsSync(path))
assert.ok(executablePath, 'Requires installed Chrome/Edge')
const evidenceDir = resolve(process.env.PRODUCT_IMAGES_EVIDENCE_DIR || join(root, '.tmp-product-images-evidence'))
const errors = [], externalRequests = [], unexpected = [], writes = [], loadedModules = new Set(), moduleCache = new Map()
const imageStateReads = new Map()
const imageReads = []
const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#5075ba80' } }).png().toBuffer()
const sharedWorkspace = 'D:/fixture/images-shared'
const otherWorkspace = 'D:/fixture/images-other'
const emptyWorkspace = 'D:/fixture/images-empty'
const projects = [
  { id: 'project-a', name: '图片项目 A', workspacePath: sharedWorkspace },
  { id: 'project-b', name: '图片项目 B', workspacePath: otherWorkspace },
  { id: 'project-empty', name: '暂无产品的项目', workspacePath: '' },
  { id: 'project-empty-path', name: '有工作区但无产品的项目', workspacePath: emptyWorkspace },
]
const products = [
  { id: 'product-a', name: '图片产品 A', projectId: 'project-a', workspacePath: sharedWorkspace },
  { id: 'product-b', name: '图片产品 B', projectId: 'project-a', workspacePath: sharedWorkspace },
  { id: 'product-other', name: '其他项目产品', projectId: 'project-b', workspacePath: otherWorkspace },
  { id: 'product-legacy', name: '旧格式同工作区产品', workspacePath: sharedWorkspace },
  { id: 'product-conflict', name: '项目身份优先产品', projectId: 'project-b', workspacePath: sharedWorkspace },
  { id: 'product-unassigned', name: '未归属且无工作区产品', workspacePath: '' },
].map(product => ({ ...product, description: '图片素材接入检查', notebookId: '', mindmap: '[]', styles: [],
  createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z' }))
let includeUiDesign = false
const designFixture = { id: 'design-a', projectId: 'project-a', name: '用于保留草稿的 UI 设计', themeId: 'clean', platform: 'all', pages: [], status: 'draft' }
const emptyProjectDesign = { ...designFixture, id: 'design-empty', projectId: 'project-empty-path', name: '无产品项目的独立 UI 设计' }
const dispatches = []
let productReadCount = 0, delayNextProductRead = false, delayedProductRead = null, notifyDelayedProductRead = null
const candidate = id => ({ id: 'candidate-' + id, createdAt: '2026-11-26T00:00:00Z', mode: 'generate', prompt: id === 'product-a' ? '纸雕森林场景 · 本地测试图片' : '蓝色产品图标 · 本地测试图片', provider: 'fixture-provider', model: 'fixture-model', width: 1, height: 1, mime: 'image/png', bytes: png.length, sha256: 'a'.repeat(64), selected: false })

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Workbench product images mount</title>
<style>html,body{margin:0;width:100%;height:100%}#app{height:100%}</style><div id="app"></div>
<script type="module">import {mountWorkbench} from '/source/client/app.ts';window.workbench=mountWorkbench(document.querySelector('#app'));</script></html>`
const json = (res, data, code = 200, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(data)) }
async function requestBody(req) { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text) }
function sourceFor(path) {
  const normalized = resolve(sourceRoot, path.slice('/source/'.length))
  if (relative(sourceRoot, normalized).startsWith('..')) return null
  const pathOptions = [normalized, normalized + '.ts', normalized + '.tsx', normalized.replace(/\.js$/, '.ts')]
  const actual = pathOptions.find(path => existsSync(path) && statSync(path).isFile())
  if (!actual) return null
  loadedModules.add(relative(root, actual).replaceAll('\\', '/'))
  if (!moduleCache.has(actual)) moduleCache.set(actual, /\.tsx?$/.test(actual)
    ? ts.transpileModule(readFileSync(actual, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React }, fileName: actual }).outputText
    : readFileSync(actual, 'utf8'))
  return moduleCache.get(actual)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return }
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
    if (path.startsWith('/source/')) {
      const text = path.replace(/\.(tsx?|js)$/, '') === '/source/client/workflow/canvas-panel'
        ? 'export function mountCanvasInto(){return {destroy(){}}}' : sourceFor(path)
      if (text !== null) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(text); return }
    }
    if (path.startsWith('/workbench-api/assets/vendor/')) {
      const file = resolve(root, path.slice('/workbench-api/'.length))
      if (!relative(join(root, 'assets/vendor'), file).startsWith('..') && existsSync(file)) {
        res.writeHead(200, { 'content-type': extname(file) === '.css' ? 'text/css' : 'text/javascript' }); res.end(readFileSync(file)); return
      }
    }
    if (path.startsWith('/workbench-api/')) {
      if (req.method === 'POST' && path === '/workbench-api/agents/dispatches') {
        const body = await requestBody(req)
        dispatches.push(body); writes.push({ path, method: req.method })
        json(res, { ok: false, message: 'Fixture-only rejection: no session or model request is created.' }, 403); return
      }
      if (req.method === 'POST' && path === '/workbench-api/products') {
        const body = await requestBody(req), input = body.product
        assert.ok(input && typeof input.name === 'string' && typeof input.workspacePath === 'string')
        const existing = input.id ? products.find(product => product.id === input.id) : undefined
        assert.ok(!input.id || existing, 'Editing requires an existing fixture product')
        const project = projects.find(project => project.workspacePath === input.workspacePath)
        assert.ok(project, 'Fixture writes use only the explicitly declared workspaces')
        const saved = { ...(existing ?? products[0]), ...input, id: existing?.id ?? 'product-created', projectId: project.id, updatedAt: new Date().toISOString() }
        const index = products.findIndex(product => product.id === saved.id)
        if (index >= 0) products[index] = saved
        else products.push(saved)
        writes.push({ path, method: req.method, productId: saved.id, workspacePath: saved.workspacePath })
        json(res, { ok: true, product: saved }); return
      }
      if (req.method === 'POST' && path === '/workbench-api/archive') {
        const body = await requestBody(req)
        assert.deepEqual(body, { target: 'products', id: 'product-created', archived: true })
        const product = products.find(product => product.id === body.id)
        assert.ok(product, 'Archiving requires the product created through the fixture POST')
        product.archivedAt = new Date().toISOString()
        writes.push({ path, method: req.method, productId: body.id, archived: body.archived })
        json(res, { ok: true }); return
      }
      if (req.method !== 'GET') { writes.push({ path, method: req.method }); json(res, { ok: true, revision: 2 }); return }
      if (path === '/workbench-api/state') { json(res, { revision: 1, spaces: [], tasks: [], focus: [], settings: { theme: 'light' } }); return }
      if (path === '/workbench-api/projects') { json(res, { projects }); return }
      if (path === '/workbench-api/products') {
        productReadCount++
        const snapshot = JSON.parse(JSON.stringify({ products: products.filter(product => url.searchParams.get('archived') === '1' || !product.archivedAt), modules: [], demos: [] }))
        const generation = String(productReadCount)
        if (delayNextProductRead) {
          delayNextProductRead = false
          delayedProductRead = () => { json(res, snapshot, 200, { 'x-fixture-products-generation': generation }); delayedProductRead = null }
          notifyDelayedProductRead?.(); notifyDelayedProductRead = null
        } else json(res, snapshot, 200, { 'x-fixture-products-generation': generation })
        return
      }
      if (path === '/workbench-api/ui-designs') {
        const projectId = url.searchParams.get('projectId')
        json(res, { designs: !includeUiDesign ? [] : projectId === 'project-a' ? [designFixture] : projectId === 'project-empty-path' ? [emptyProjectDesign] : [] }); return
      }
      if (path === '/workbench-api/product-images/state') {
        const id = url.searchParams.get('productId')
        assert.ok(products.some(product => product.id === id), 'Image state reads require an explicitly selected known product')
        imageStateReads.set(id, (imageStateReads.get(id) || 0) + 1)
        json(res, { ok: true, available: true, candidates: [candidate(id)], jobs: [] }); return
      }
      if (path === '/workbench-api/product-images/image' || path === '/workbench-api/product-images/preview') {
        assert.equal(url.searchParams.get('candidateId'), candidate(url.searchParams.get('productId')).id)
        assert.equal(url.searchParams.get('formatVersion') ?? '1', '1')
        imageReads.push({ path, productId: url.searchParams.get('productId'), candidateId: url.searchParams.get('candidateId') })
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(png); return
      }
      json(res, { ok: true, maps: [], versions: [], projects: [], notes: [], notebooks: [], themes: [], modules: [], demos: [], bugs: [], cases: [], runs: [], teams: [], members: [] }); return
    }
    unexpected.push(path); res.writeHead(404); res.end()
  } catch (error) { errors.push(error.message); res.writeHead(500); res.end(error.message) }
})

let browser, page
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ executablePath, headless: true, timeout: 10000, args: ['--disable-extensions', '--no-first-run'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } })
  context.setDefaultTimeout(18000)
  await context.route('**/*', route => {
    const url = route.request().url()
    if (!url.startsWith(origin + '/') && !/^(data|blob):/.test(url)) { externalRequests.push(url); return route.abort() }
    return route.continue()
  })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const imageProductPicker = () => page.locator('#wb-ui-image-product')
  const projectPicker = () => page.locator('#wb-project').first()
  const section = name => page.locator(`[data-act="ui-section"][data-section="${name}"]`)
  async function assertProductOptions(expected, description) {
    await page.waitForFunction(count => [...document.querySelector('#app').shadowRoot.querySelector('#wb-ui-image-product').options].filter(option => option.value).length === count, expected.length)
    const values = await imageProductPicker().locator('option').evaluateAll(nodes => nodes.map(node => node.value).filter(Boolean).sort())
    assert.deepEqual(values, [...expected].sort(), description)
  }
  async function selectImageProduct(id) {
    await imageProductPicker().selectOption(id)
    await page.locator(`[data-product-images="${id}"] [data-candidate-id="candidate-${id}"]`).waitFor()
    await page.locator(`[data-product-images="${id}"] img`).evaluate(img => img.decode())
    assert.equal(await imageProductPicker().inputValue(), id)
  }
  await page.goto(origin)
  await page.locator('[data-act="portal-edit"]').first().waitFor({ state: 'attached' })
  await page.locator('.side-item[data-view="ui"]').click()
  await section('design').waitFor()
  assert.equal(await page.locator('[data-product-images]').count(), 0, 'UI initially opens the design section')
  await section('images').click()
  await imageProductPicker().waitFor()
  assert.equal(await imageProductPicker().inputValue(), '', 'The image page does not borrow the product-page selection')
  assert.equal(imageStateReads.size, 0, 'Entering images without selecting a product performs no image request')
  assert.equal(includeUiDesign, false, 'The image entry is usable without any UI-design record')
  await assertProductOptions(products.map(product => product.id), 'All-project scope lists products but requires an explicit choice')
  await selectImageProduct('product-a')
  assert.equal(await projectPicker().inputValue(), 'all', 'The image product picker does not change global project scope')
  assert.ok((await page.locator('#wb-ui-image-workspace').innerText()).includes(sharedWorkspace))
  assert.equal(new URL(await page.locator('[data-product-images="product-a"] img').getAttribute('src'), origin).pathname, '/workbench-api/product-images/preview')
  assert.ok(imageReads.some(read => read.path.endsWith('/preview') && read.productId === 'product-a'), 'The real app uses the preview route for gallery images')
  await page.locator('[name="image-prompt"]').fill('保留这份输入：森林场景与暖色光线')
  await page.locator('[name="image-prompt"]').evaluate(node => { window.promptBeforeRerender = node; window.imageHostBeforeRerender = node.closest('#wb-product-images-host') })
  const readsBeforeRerender = imageStateReads.get('product-a')
  await page.locator('#wb-search').fill('触发真实 renderContent')
  assert.equal(await page.locator('[name="image-prompt"]').evaluate(node => node === window.promptBeforeRerender), true)
  assert.equal(await page.locator('#wb-product-images-host').evaluate(node => node === window.imageHostBeforeRerender), true)
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), '保留这份输入：森林场景与暖色光线')
  assert.equal(imageStateReads.get('product-a'), readsBeforeRerender, 'renderContent retains one mounted handle without extra state loads')

  // Use the actual 12-second product poll and its changed-signature render.
  await page.locator('[name="image-prompt"]').focus()
  await page.locator('[name="image-prompt"]').evaluate(node => node.setSelectionRange(3, 8))
  products[0].name = '图片产品 A · 已同步'
  products[0].updatedAt = '2026-11-26T00:00:01Z'
  await page.waitForFunction(() => document.querySelector('#app').shadowRoot.querySelector('#wb-ui-image-product option[value="product-a"]')?.textContent.includes('已同步'), { timeout: 18000 })
  assert.equal(await page.locator('[name="image-prompt"]').evaluate(node => node === window.promptBeforeRerender), true, 'Real periodic product refresh retains the same prompt DOM')
  assert.equal(imageStateReads.get('product-a'), readsBeforeRerender)
  assert.equal(await page.locator('[data-product-images="product-a"]').count(), 1)
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), '保留这份输入：森林场景与暖色光线')
  assert.deepEqual(await page.locator('[name="image-prompt"]').evaluate(node => ({ focused: node.getRootNode().activeElement === node, start: node.selectionStart, end: node.selectionEnd })), { focused: true, start: 3, end: 8 }, 'Real periodic refresh preserves prompt focus and text selection')
  await selectImageProduct('product-b')
  assert.equal(await page.locator('[data-product-images="product-a"]').count(), 0)
  assert.equal(await page.evaluate(() => window.promptBeforeRerender.isConnected), false)
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), '')
  assert.equal(await page.locator('[data-candidate-id="candidate-product-a"]').count(), 0)
  assert.equal(await projectPicker().inputValue(), 'all')
  assert.ok((await page.locator('#wb-ui-image-workspace').innerText()).includes(sharedWorkspace), 'Two products may share a workspace without sharing identity')
  await selectImageProduct('product-a')
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), '保留这份输入：森林场景与暖色光线', 'Returning to the first product restores only its own draft')
  assert.equal(await page.locator('[data-candidate-id="candidate-product-b"]').count(), 0)

  await projectPicker().selectOption(sharedWorkspace)
  assert.equal(await imageProductPicker().inputValue(), '', 'Changing project clears the previous image product choice')
  assert.equal(await page.locator('[data-product-images]').count(), 0, 'Changing project cannot keep the old gallery mounted')
  await assertProductOptions(['product-a', 'product-b', 'product-legacy'], 'Explicit project ID takes priority, with workspace fallback only for legacy products')
  await selectImageProduct('product-b')
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), '')
  await projectPicker().selectOption(otherWorkspace)
  assert.equal(await imageProductPicker().inputValue(), '')
  assert.equal(await page.locator('[data-product-images]').count(), 0)
  await assertProductOptions(['product-other', 'product-conflict'], 'Switching projects never offers another project products even with a matching workspace')
  await selectImageProduct('product-other')
  assert.equal(await page.locator('[data-candidate-id="candidate-product-a"]').count(), 0)
  assert.equal(await page.locator('[data-candidate-id="candidate-product-b"]').count(), 0)
  await projectPicker().selectOption('none')
  assert.equal(await imageProductPicker().inputValue(), '')
  await assertProductOptions(['product-unassigned'], 'Unassigned scope includes only products with neither project ID nor workspace')
  await projectPicker().selectOption('prj:project-empty')
  await assertProductOptions([], 'A project without products does not borrow another project product')
  assert.equal(await page.locator('[data-act="ui-image-product-new"]').first().isVisible(), true, 'An empty product scope offers a create action')
  assert.equal(await page.locator('[data-act="ui-image-product-new"]').first().isEnabled(), true)
  assert.equal(await page.locator('[data-product-images]').count(), 0)

  await projectPicker().selectOption('all')
  await page.locator('.side-item[data-view="product"]').click()
  await page.locator('#wb-product-select').selectOption('product-a')
  await page.locator('[data-act="product-images-open"]').click()
  await page.locator('[data-product-images="product-a"] [data-candidate-id="candidate-product-a"]').waitFor()
  assert.equal(await imageProductPicker().inputValue(), 'product-a', 'The product shortcut restores the exact product when several products share its workspace')
  assert.equal(await projectPicker().inputValue(), sharedWorkspace, 'The product shortcut aligns the global project')
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), '保留这份输入：森林场景与暖色光线')

  includeUiDesign = true
  await page.locator('[name="image-prompt"]').evaluate(node => { window.promptBeforeExit = node })
  await section('design').click()
  assert.equal(await page.locator('[data-product-images]').count(), 0)
  assert.equal(await page.evaluate(() => window.promptBeforeExit.isConnected), false, 'Leaving the image tab removes its DOM')
  await page.getByText(designFixture.name, { exact: true }).waitFor()
  await page.locator('[data-ud="tab"][data-tab="spec"]').click()
  const specDraft = '# 不丢失的 UI 规范草稿\n\n切换到图片素材后仍保留这段内容。'
  page.once('dialog', dialog => dialog.accept(specDraft))
  await page.locator('[data-ud="spec-edit"]').click()
  await page.getByText('不丢失的 UI 规范草稿', { exact: true }).waitFor()
  await page.locator('#wb-ui-design-host').evaluate(node => { window.designHostBeforeImages = node })
  await section('images').click()
  await page.locator('[data-product-images="product-a"] [data-candidate-id]').waitFor()
  assert.equal(await page.locator('[name="image-prompt"]').evaluate(node => node !== window.promptBeforeExit), true)
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), '保留这份输入：森林场景与暖色光线')
  designFixture.name = '从服务器更新后的 UI 设计名称'
  await section('design').click()
  await page.getByText(designFixture.name, { exact: true }).waitFor()
  await page.getByText('不丢失的 UI 规范草稿', { exact: true }).waitFor()
  assert.equal(await page.locator('#wb-ui-design-host').evaluate(node => node === window.designHostBeforeImages), true, 'Switching to images preserves the current project UI-design instance and local draft')
  await projectPicker().selectOption(emptyWorkspace)
  await page.getByText(emptyProjectDesign.name, { exact: true }).waitFor()
  const rejectedDispatch = page.waitForResponse(response => new URL(response.url()).pathname === '/workbench-api/agents/dispatches')
  page.once('dialog', dialog => dialog.accept())
  await page.locator('[data-ud="generate"]').click()
  assert.equal((await rejectedDispatch).status(), 403, 'The fixture rejects dispatch before any session or model work')
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0].feature, 'ui.design')
  assert.equal(dispatches[0].workspacePath, emptyWorkspace, 'UI generation without a product uses the explicitly selected project workspace')
  assert.match(dispatches[0].goal, /- projectId: "project-empty-path"/)
  assert.doesNotMatch(dispatches[0].goal, /- (?:productId|mapId):/, 'An empty product project cannot borrow another product or map')
  assert.doesNotMatch(dispatches[0].goal, /图片产品 A|product-a|product-b|product-other/)
  await section('images').click()
  await assertProductOptions([], 'The confirmed UI-generation context remains a project without products')

  delayNextProductRead = true
  const delayedReadStarted = new Promise(resolve => { notifyDelayedProductRead = resolve })
  await page.locator('[data-act="ui-context-refresh"]').click()
  await delayedReadStarted
  assert.ok(delayedProductRead, 'Keep a frozen product-list read in flight across the product save')
  await page.locator('[data-act="ui-image-product-new"]').click()
  await page.locator('#wb-prod-name').fill('从图片页新建的产品')
  assert.equal(await page.locator('#wb-prod-path').inputValue(), emptyWorkspace, 'Creating from images presets the explicit project workspace')
  await page.locator('[data-act="product-save"]').click()
  await page.locator('#wb-ui-image-product option[value="product-created"]').waitFor({ state: 'attached' })
  assert.equal(await imageProductPicker().inputValue(), 'product-created', 'A successful create selects the returned product immediately')
  assert.ok((await page.locator('#wb-ui-image-workspace').innerText()).includes(emptyWorkspace))
  const nextProductReadGeneration = String(productReadCount + 1)
  const freshProductsRead = page.waitForResponse(response => new URL(response.url()).pathname === '/workbench-api/products'
    && response.headers()['x-fixture-products-generation'] === nextProductReadGeneration)
  delayedProductRead()
  await freshProductsRead
  await page.waitForFunction(() => document.querySelector('#app').shadowRoot.querySelector('#wb-ui-image-product')?.value === 'product-created')
  await assertProductOptions(['product-created'], 'A stale GET cannot remove the product just returned by POST')
  assert.ok((await page.locator('#wb-ui-image-workspace').innerText()).includes(emptyWorkspace))

  await page.locator('[data-act="ui-image-product-edit"]').click()
  await page.locator('#wb-prod-name').fill('图片页产品 · 工作区已更新')
  await page.locator('#wb-prod-path').fill(sharedWorkspace)
  await page.locator('[data-act="product-save"]').click()
  await page.waitForFunction(() => document.querySelector('#app').shadowRoot.querySelector('#wb-ui-image-product option[value="product-created"]')?.textContent === '图片页产品 · 工作区已更新')
  assert.equal(await imageProductPicker().inputValue(), 'product-created')
  assert.equal(await projectPicker().inputValue(), sharedWorkspace, 'Editing the workspace aligns project scope to the returned product project')
  assert.equal(await page.locator('.side-item[data-act="portal-project"].active').getAttribute('data-id'), sharedWorkspace, 'Editing the workspace aligns the highlighted sidebar project')
  assert.ok((await page.locator('#wb-ui-image-workspace').innerText()).includes(sharedWorkspace), 'The visible workspace follows the saved product immediately')
  assert.equal(writes.filter(write => write.path === '/workbench-api/products').length, 2, 'The fixture exercises exactly one creation and one edit')
  await page.locator('[data-product-images="product-created"] [data-candidate-id="candidate-product-created"]').waitFor()
  await page.locator('[data-act="ui-image-product-edit"]').click()
  await page.locator('[data-act="archive-toggle"][data-target="products"][data-id="product-created"]').click()
  await page.waitForFunction(() => document.querySelector('#app').shadowRoot.querySelector('#wb-modal')?.innerHTML === '')
  await assertProductOptions(['product-a', 'product-b', 'product-legacy'], 'Archiving removes the product from the active image picker')
  assert.equal(await imageProductPicker().inputValue(), '', 'Archiving clears the exact image product selection')
  assert.equal(await page.locator('[data-product-images]').count(), 0, 'Archiving removes the old gallery without selecting another product')
  assert.equal(await projectPicker().inputValue(), sharedWorkspace, 'Archiving keeps the explicit project context')
  assert.equal(await page.locator('.side-item[data-act="portal-project"].active').getAttribute('data-id'), sharedWorkspace, 'Archiving keeps the sidebar and project picker in the same context')
  assert.equal(writes.filter(write => write.path === '/workbench-api/archive').length, 1, 'The fixture exercises exactly one product archive')
  await selectImageProduct('product-a')
  await page.locator('[data-product-images="product-a"] [data-candidate-id]').waitFor()
  mkdirSync(evidenceDir, { recursive: true })
  await page.screenshot({ path: join(evidenceDir, 'product-images-app-top.png'), fullPage: true })
  await page.locator('[data-candidate-id]').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(evidenceDir, 'product-images-app-mounted.png'), fullPage: true })
  const imageStyleCount = await page.evaluate(() => [...document.querySelector('#app').shadowRoot.querySelectorAll('style')].filter(node => node.textContent.includes('.pi-root')).length)
  assert.equal(imageStyleCount, 1, 'Product image CSS is injected once')
  await page.evaluate(() => window.workbench.destroy())
  assert.equal(await page.locator('[data-product-images]').count(), 0)
  assert.ok(writes.every(write => ['/workbench-api/state', '/workbench-api/products', '/workbench-api/archive', '/workbench-api/agents/dispatches'].includes(write.path)), 'Only explicit project settings, product saves/archive and one fixture-rejected UI dispatch are written')
  assert.equal(writes.filter(write => write.path === '/workbench-api/agents/dispatches').length, 1, 'The rejected fixture dispatch is never retried')
  assert.deepEqual(errors, [])
  assert.deepEqual(unexpected, [])
  assert.deepEqual(externalRequests, [])
  assert.ok(loadedModules.has('src/client/app.ts') && loadedModules.has('src/client/product-images.ts'))
  const report = { browser: browser.version(), checks: ['real app.ts mount', 'direct sidebar UI images entry without UI designs', 'explicit product choice independent from global project', 'versioned gallery preview decoded', 'renderContent retains DOM and draft', 'real 12-second product refresh retains one handle, prompt focus and text selection', 'same-workspace product isolation', 'strict project ID and legacy workspace filters', 'unassigned and empty scope do not borrow products', 'product shortcut restores exact product and draft', 'UI-design refresh retains host and local spec draft', 'UI generation in productless project has no foreign product/map and fixture rejects before model calls', 'new and edited product update image picker and workspace', 'stale products GET is discarded after save', 'product archive clears picker, gallery and modal', 'leave tab cleanup', 'workbench destroy cleanup', 'CSS injected once', 'no model calls'], stubbed: ['React workflow canvas-panel only', 'HTTP data fixtures', 'UI dispatch rejected with HTTP 403 before session creation'], imageStateReads: Object.fromEntries(imageStateReads), imageReads, productReadCount, rejectedUiDispatch: dispatches.map(({ feature, workspacePath }) => ({ feature, workspacePath })), errors, externalRequests, unexpected, writes, humanAcceptance: 'not exercised' }
  writeFileSync(join(evidenceDir, 'product-images-app-mount-report.json'), JSON.stringify(report, null, 2))
  console.log('PASS product images actual app mount.', JSON.stringify(report))
  console.log('Evidence:', evidenceDir)
} catch (error) {
  mkdirSync(evidenceDir, { recursive: true })
  if (page) {
    await page.screenshot({ path: join(evidenceDir, 'product-images-app-mount-failure.png'), fullPage: true }).catch(() => {})
    console.error('Mount failure UI:', await page.locator('#app').innerText().catch(() => 'unavailable'), JSON.stringify({ errors, unexpected, loadedModules: [...loadedModules] }))
  }
  throw error
} finally {
  delayedProductRead?.()
  await browser?.close()
  if (server.listening) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
}
