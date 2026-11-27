/** Production bundle, HTTP workflow, and real installed-browser tower defense.
 * Only design documents are fixtures. The final human gate is never confirmed. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'cinderwatch-workflow-e2e-'))
const workspace = join(root, 'workspace')
mkdirSync(workspace)
const evidence = resolve(process.env.NATIVE_GAME_EVIDENCE_DIR || '.tmp-cinderwatch-workflow-evidence')
mkdirSync(evidence, { recursive: true })
process.env.DSH_HOME = root
process.env.DSH_WORKBENCH_DB = join(root, 'workbench.sqlite')
const { apply } = await import('../lib/index.js')
const routes = [], disposers = [], tools = new Map()
apply({ tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} }, tapIndex: () => () => {} },
  effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
  get() {}, on: () => () => {}, logger: { info() {}, warn() {}, error() {} } })
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const route = routes.find(route => pathname === route.path || pathname.startsWith(route.path + '/'))
  if (route) route.handler(req, res)
  else { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
async function call(path, method = 'GET', body, status = 200) {
  const response = await fetch(origin + '/workbench-api' + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json()
  assert.equal(response.status, status, JSON.stringify(value))
  return value
}
const versions = view => ({ taskId: view.waiting.taskId, expectedBindingVersion: view.waiting.bindingVersion, expectedTaskRevision: view.waiting.taskRevision, expectedRunRevision: view.revision })
let browser
try {
  const capabilities = await call('/game-studio/capabilities')
  assert.equal(capabilities.defaultTemplate, 'cinderwatch')
  assert.equal(capabilities.operations.playtest, true, JSON.stringify(capabilities))
  const product = (await call('/products', 'POST', { name: 'Cinderwatch 3D real workflow fixture', workspacePath: workspace })).product
  // The same production tool works before any workflow exists and has no node
  // requirements or output envelope. It creates a separate independent game.
  const independent = await tools.get('workbench_game_create').execute({ productId: product.id, slug: 'independent-tower', title: '独立三维塔防工具' })
  assert.equal(independent.ok, true, JSON.stringify(independent))
  assert.equal(independent.template, 'cinderwatch')
  assert.equal(Object.hasOwn(independent, 'workspaceIdentity'), false)
  assert.equal(Object.hasOwn(independent, 'scope'), false)
  assert.equal(Object.hasOwn(independent, 'inputHash'), false)
  assert(Buffer.byteLength(JSON.stringify(independent)) < 2048)
  assert.equal((await call('/workflow/run-summaries')).runs.length, 0)
  const fork = await call('/workflow/templates/game-cinderwatch-test/fork', 'POST', { productId: product.id }, 201)
  const run = await call('/workflow/runs', 'POST', { graphId: fork.row.id }, 201)
  const runId = run.runId, path = '/workflow/runs/' + runId
  assert.equal(run.view.waiting.nodeId, 'gdd')
  await call(path + '/submit', 'POST', { content: '# 余烬守望\n\n## 目标与范围\n基于Cinderwatch完整Three.js塔防。\n## 核心循环\n建塔、迎敌、击杀获金、升级、守住烽火。\n## 操作\n鼠标和触屏选塔位，1至4建造，C切换指挥，P暂停。\n## 状态与反馈\n金币、基地生命、波次及火光。\n## 失败条件\n基地生命归零，之后开始新一轮。\n## 可观察验收行为\n建塔扣款、交还指挥、波次推进、击杀收益、手机适屏。' })
  const rules = { version: 1, title: '余烬守望 · 三维塔防', nativeTemplate: 'cinderwatch@1', seed: 4, biome: 'ashen', startingGold: 300, lives: 20, autoCommand: true, creativePack: 'none',
    player: { count: 1, controls: ['鼠标或触屏选塔位', '数字键建造', 'C切换指挥', 'P暂停'] }, goal: ['守住烽火并推进波次'], fail: ['基地生命归零'], loop: ['建塔', '迎敌', '击杀获金', '升级'], acceptance: ['建塔扣金', '接管与归还指挥', '暂停恢复', '波次与收益', '手机触屏'], openQuestions: [] }
  const design = (await call(path + '/submit', 'POST', { content: JSON.stringify(rules) })).view
  assert.equal(design.waiting.nodeId, 'design-review')
  assert.deepEqual(readdirSync(join(workspace, 'games')), ['independent-tower'], 'No workflow game is created before design approval')
  await call(path + '/confirm', 'POST', { ...versions(design), content: design.waiting.content })
  await call(path + '/advance', 'POST', {})
  const deadline = Date.now() + 90000
  let view
  while (Date.now() < deadline) {
    view = (await call(path)).view
    if (view.status === 'paused') assert.fail('Native operation stopped: ' + view.pauseReason)
    if (view.status === 'waiting_review' && view.waiting?.nodeId === 'handoff-review' && view.waiting.taskId && view.waiting.content) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(view.waiting?.nodeId, 'handoff-review', JSON.stringify(view))
  assert.equal(view.attempts.filter(attempt => attempt.session_id).length, 0, 'Fixture design; game operations do not dispatch model sessions')
  const completed = view.nativeOperations.filter(operation => operation.status === 'completed')
  assert.equal(completed.length, 6)
  const get = nodeId => JSON.parse(view.steps.find(step => step.nodeId === nodeId).content)
  const initial = get('create'), built = get('build'), tested = get('final-playtest'), packaged = get('package')
  for (const value of [initial, built, tested, packaged]) {
    assert.equal(value.provider, 'workbench-native')
    assert.equal(value.nativeRunId, runId)
    assert.equal(value.template, 'cinderwatch')
    assert(value.workspaceIdentity && value.scope, 'Node adapter adds workflow evidence around domain operations')
  }
  assert.notEqual(initial.projectId, independent.projectId)
  assert.equal(initial.buildId, built.buildId)
  assert.equal(built.buildId, tested.buildId)
  assert.equal(built.buildId, packaged.buildId)
  assert.equal(tested.playtestStatus, 'passed')
  assert.equal(tested.finalPhase, 'play')
  assert.equal(tested.errors, 0); assert.equal(tested.requests, 0)
  for (const check of Object.values(tested.checks)) assert.equal(check, true)
  for (const id of ['prototype-playtest', 'final-playtest']) {
    const report = get(id)
    assert(report.screenshots.length === 2 && report.screenshots.every(file => existsSync(join(workspace, file))))
    assert.equal(createHash('sha256').update(readFileSync(join(workspace, report.reportPath))).digest('hex'), report.reportHash)
    writeFileSync(join(evidence, id + '.json'), JSON.stringify(report, null, 2))
  }
  const bytes = readFileSync(join(workspace, packaged.exportPath))
  assert.equal(bytes.length, packaged.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), packaged.hash)
  const downloaded = await fetch(origin + packaged.downloadUrl)
  assert.match(downloaded.headers.get('content-disposition'), /attachment/)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes)
  assert.equal(JSON.parse(view.waiting.content).status, '未通过')
  await call(path + '/confirm', 'POST', { ...versions(view), content: view.waiting.content }, 400)
  assert.equal((await call(path)).view.status, 'waiting_review')
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.DSH_GAME_PLAYWRIGHT_PATH || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_GAME_BROWSER_EXECUTABLE ? { executablePath: process.env.DSH_GAME_BROWSER_EXECUTABLE } : { channel: 'msedge' }) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + built.previewUrl)
  const frame = page.frameLocator('iframe')
  await frame.locator('canvas#gl').waitFor()
  await frame.locator('body').evaluate(() => new Promise(resolve => {
    const check = () => window.__gameState?.().templateId === 'cinderwatch' ? resolve(true) : setTimeout(check, 25)
    check()
  }))
  const localization = await frame.locator('body').evaluate(() => ({ language: document.documentElement.lang,
    englishWidth: window.__cw.PX.measure('AI commander'), chineseWidth: window.__cw.PX.measure('自动指挥'),
    buildHintWidth: window.__cw.PX.measure('Click a pad to build'), chineseHintWidth: window.__cw.PX.measure('点击空塔位建造') }))
  assert.equal(localization.language, 'zh-CN')
  assert.equal(localization.englishWidth, localization.chineseWidth)
  assert.equal(localization.buildHintWidth, localization.chineseHintWidth)
  // Inspect the production menu against a real pad; actual input is exercised separately.
  const localizedBuildMenu = await frame.locator('body').evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype, fillText = proto.fillText, drawn = []
    proto.fillText = function (text, ...args) { drawn.push(String(text)); return fillText.call(this, text, ...args) }
    try { window.__cw.UI.draw() } finally { proto.fillText = fillText }
    return { menuOpen: !!window.__cw.UI.menu, drawn }
  })
  assert.equal(localizedBuildMenu.menuOpen, true, JSON.stringify({ commander, emptyPad }))
  assert(localizedBuildMenu.drawn.includes('在此建造'), JSON.stringify(localizedBuildMenu.drawn))
  assert(!localizedBuildMenu.drawn.some(text => text.includes('Build here') || text.includes('Choose a tower')))
  assert.equal(await frame.locator('body').evaluate(() => { try { void parent.document.body; return 'unsafe' } catch { return 'blocked' } }), 'blocked')
  await page.screenshot({ path: join(evidence, 'workflow-preview.png') })
  await page.screenshot({ path: join(evidence, 'localized-menu.png') })
  const htmlPath = join(evidence, 'cinderwatch.html')
  writeFileSync(htmlPath, bytes)
  const context = await browser.newContext({ offline: true, viewport: { width: 1280, height: 800 } })
  const offline = await context.newPage()
  offline.on('pageerror', error => errors.push(error.message))
  await offline.goto(pathToFileURL(htmlPath).href)
  await offline.waitForFunction(() => window.__gameState?.().templateId === 'cinderwatch')
  assert.equal(await offline.evaluate(() => window.__gameState().rules.startingGold), 300)
  assert.equal(errors.length, 0, JSON.stringify(errors))
  await offline.screenshot({ path: join(evidence, 'offline.png') })
  for (const file of tested.screenshots) copyFileSync(join(workspace, file), join(evidence, file.endsWith('mobile.png') ? 'mobile.png' : 'desktop.png'))
  const report = { checkedAt: new Date().toISOString(), template: 'game-cinderwatch-test', runId, initialBuildId: initial.buildId, finalBuildId: built.buildId, bytes: bytes.length, hash: packaged.hash, independentToolBytes: Buffer.byteLength(JSON.stringify(independent)), nativeOperations: completed.length, finalPhase: tested.finalPhase, checks: tested.checks, inputs: tested.inputs, errors: tested.errors, requests: tested.requests, localization, sandboxParentAccess: 'blocked', offlineFile: 'passed', humanGate: 'waiting_review / 未通过', limitations: ['Design documents were submitted fixtures; no live DSH model session was exercised.', 'Battle checks use actual game fixed-step logic; real-time FPS and human acceptance remain unassessed.'] }
  writeFileSync(join(evidence, 'workflow-report.json'), JSON.stringify(report, null, 2))
  console.log('PASS production Cinderwatch workflow:', JSON.stringify(report))
} finally {
  await browser?.close()
  for (const dispose of disposers.reverse()) dispose()
  await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
}
