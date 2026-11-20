/** Production bundle + original 14-node template + real browser games.
 * Design inputs are fixtures. The final human gate remains unconfirmed.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { nativeGameLinks } from '../src/shared/native-game-links.ts'

const root = mkdtempSync(join(tmpdir(), 'native-workflow-real-'))
const workspace = join(root, 'game-workspace')
mkdirSync(workspace)
const evidence = process.env.NATIVE_GAME_EVIDENCE_DIR || join(root, 'evidence')
const creativePack = process.env.NATIVE_GAME_CREATIVE_PACK === '1' || process.argv.includes('--creative')
mkdirSync(evidence, { recursive: true })
process.env.DSH_HOME = root
process.env.DSH_WORKBENCH_DB = join(root, 'workbench.sqlite')
const { apply } = await import('../lib/index.js')
const routes = []
const disposers = []
const registered = []
apply({ tools: { register(tool) { registered.push(tool); return () => {} } }, webServer: { register(route) { routes.push(route); return () => {} }, tapIndex: () => () => {} }, effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) }, get() {}, on: () => () => {}, logger: { info() {}, warn() {}, error() {} } })
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
let browser
try {
  for (const name of ['create', 'build', 'preview', 'playtest', 'export']) assert(registered.some(tool => tool.name === 'workbench_game_' + name))
  const capabilities = await call('/game-studio/capabilities')
  assert.equal(capabilities.operations.playtest, true, JSON.stringify(capabilities))
  const product = (await call('/products', 'POST', { name: 'Native full workflow fixture', workspacePath: workspace })).product
  const fork = await call('/workflow/templates/game-starlight-test/fork', 'POST', { productId: product.id }, 201)
  const run = await call('/workflow/runs', 'POST', { graphId: fork.row.id }, 201)
  const runId = run.runId
  const path = '/workflow/runs/' + runId
  assert.equal(run.view.waiting.nodeId, 'gdd')
  await call(path + '/submit', 'POST', { content: '# 星光采集\n\n## 目标\n固定2D收集躲避。\n## 循环\n移动、拾取、躲避、结算。\n## 控制\n左右键与触屏。\n## 状态\n15秒、3颗心。\n## 失败\n心数归零。\n## 验收\n可获胜并重开。' })
  const rules = { version: 1, title: '星光采集', nativeTemplate: 'canvas-collector@1', durationSeconds: 15, hearts: 3, player: { count: 1, controls: ['左右键', '触屏拖动'] }, goal: ['存活15秒'], fail: ['生命归零'], loop: ['移动', '拾取', '躲避'], acceptance: ['拾取加分', '碰撞扣血', '结算重开复位'], openQuestions: [] }
  if (creativePack) rules.creativePack = 'local-original-v1'
  const design = (await call(path + '/submit', 'POST', { content: JSON.stringify(rules) })).view
  assert.equal(design.waiting.nodeId, 'design-review')
  assert.equal(existsSync(join(workspace, 'games')), false, 'no project before design approval')
  // Simulate an old saved/frozen template carrying obsolete game-studio prompts.
  const db = new DatabaseSync(join(root, 'workflow-runs.sqlite'))
  const frozen = JSON.parse(db.prepare('SELECT compiled_json FROM wf_run_graphs WHERE run_id=?').get(runId).compiled_json)
  for (const node of frozen.filter(node => ['game.create', 'game.playtest', 'game.revise', 'game.build', 'game.package'].includes(node.type))) {
    node.kind = 'agent'; node.contract.prompt = 'Use game_studio_create/build/playtest/export'; node.node.config.prompt = '必须调用旧插件，否则停止。'
  }
  db.prepare('UPDATE wf_run_graphs SET compiled_json=? WHERE run_id=?').run(JSON.stringify(frozen), runId)
  db.close()
  const versions = view => ({ taskId: view.waiting.taskId, expectedBindingVersion: view.waiting.bindingVersion, expectedTaskRevision: view.waiting.taskRevision, expectedRunRevision: view.revision })
  await call(path + '/confirm', 'POST', { ...versions(design), content: design.waiting.content })
  await Promise.all([call(path + '/advance', 'POST', {}), call(path + '/advance', 'POST', {})])
  const deadline = Date.now() + 90000
  let view
  while (Date.now() < deadline) {
    view = (await call(path)).view
    if (view.status === 'paused') assert.fail('Native operation stopped: ' + view.pauseReason)
    if (view.status === 'waiting_review' && view.waiting?.nodeId === 'handoff-review' && view.waiting.taskId && view.waiting.content) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(view.waiting?.nodeId, 'handoff-review', JSON.stringify(view))
  assert.equal(view.attempts.filter(attempt => attempt.session_id).length, 0, 'fixture design was submitted; native game nodes need no model sessions')
  const operationEvents = view.nativeOperations.filter(operation => operation.status === 'completed')
  assert.equal(operationEvents.length, 6)
  const get = nodeId => JSON.parse(view.steps.find(step => step.nodeId === nodeId).content)
  const initial = get('create'), built = get('build'), tested = get('final-playtest'), packaged = get('package')
  for (const value of [initial, built, tested, packaged]) {
    assert.equal(value.provider, 'workbench-native')
    assert.equal(value.nativeRunId, runId)
    assert(nativeGameLinks(JSON.stringify(value)))
  }
  assert.equal(built.buildId, tested.buildId)
  assert.equal(built.buildId, packaged.buildId)
  assert.equal(tested.finalPhase, 'won')
  assert.equal(tested.errors, 0)
  assert.equal(tested.requests, 0)
  assert.equal(tested.buildCurrent, true)
  if (creativePack) {
    assert.equal(initial.adoptedAssets.length, 4)
    assert.equal(tested.assetsPassed, true)
    assert.equal(tested.assetEvidence.expected.length, 4)
    assert.equal(tested.assetEvidence.images.pickup, true)
    assert.equal(tested.assetEvidence.images.player, true)
    assert(tested.assetEvidence.drawn.pickup > 0)
    assert(tested.assetEvidence.drawn.player > 0)
    assert.equal(tested.assetEvidence.audio.pickupSound, true)
    assert.equal(tested.assetEvidence.audio.hitSound, true)
    assert(tested.assetEvidence.played.pickupSound > 0, 'actual browser pickup emitted an audio source')
  }
  assert.equal(initial.buildId, built.buildId, 'no-change revision legitimately reuses its build')
  const exported = readFileSync(join(workspace, packaged.exportPath))
  assert.equal(exported.length, packaged.bytes)
  assert.equal(createHash('sha256').update(exported).digest('hex'), packaged.hash)
  for (const id of ['prototype-playtest', 'final-playtest']) {
    const test = get(id)
    assert(test.reportPath && existsSync(join(workspace, test.reportPath)))
    assert(test.screenshots.length && test.screenshots.every(file => existsSync(join(workspace, file))))
  }
  const downloaded = await fetch(origin + packaged.downloadUrl)
  assert.match(downloaded.headers.get('content-disposition'), /attachment/)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), exported)
  assert.equal(JSON.parse(view.waiting.content).status, '未通过')
  await call(path + '/confirm', 'POST', { ...versions(view), content: view.waiting.content }, 400)
  assert.equal((await call(path)).view.status, 'waiting_review')
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.DSH_GAME_PLAYWRIGHT_PATH || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_GAME_BROWSER_EXECUTABLE ? { executablePath: process.env.DSH_GAME_BROWSER_EXECUTABLE } : { channel: 'msedge' }) })
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } })
  await page.goto(origin + built.previewUrl)
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: '开始游戏' }).click()
  assert.equal(await frame.locator('body').evaluate(() => { try { void parent.document.body; return 'unsafe' } catch { return 'blocked' } }), 'blocked')
  await frame.locator('#hud').filter({ hasText: /星星 [1-9]/ }).waitFor({ timeout: 5000 })
  await page.screenshot({ path: join(evidence, 'native-workflow-preview.png') })
  writeFileSync(join(evidence, 'star-catcher.html'), exported)
  await page.goto(pathToFileURL(join(evidence, 'star-catcher.html')).href)
  await page.getByRole('button', { name: '开始游戏' }).click()
  await page.waitForFunction(() => window.__gameState?.().phase === 'playing')
  if (creativePack) {
    await page.waitForFunction(() => window.__gameAssets?.().audio.pickupSound && window.__gameAssets?.().images.pickup)
    cpSync(join(workspace, initial.project, '.studio/assets'), join(evidence, 'native-assets'), { recursive: true })
  }
  const report = { checkedAt: new Date().toISOString(), template: 'game-starlight-test', creativePack, ...(creativePack ? { adoptedAssets: initial.adoptedAssets, assetEvidence: tested.assetEvidence } : {}), frozenLegacyPrompts: true, runId, initial: { buildId: initial.buildId, bytes: initial.bytes }, final: { buildId: built.buildId, bytes: packaged.bytes, hash: packaged.hash }, nativeOperations: operationEvents.length, finalPhase: tested.finalPhase, errors: tested.errors, requests: tested.requests, sandboxParentAccess: 'blocked', humanGate: 'waiting_review / 未通过', limitations: ['Design inputs are fixtures, not a real DSH model session.', 'Human playtest and desktop UI acceptance remain for joint user testing.'] }
  writeFileSync(join(evidence, 'workflow-report.json'), JSON.stringify(report, null, 2))
  console.log('PASS original template real native workflow:', JSON.stringify(report))
} finally {
  await browser?.close()
  for (const dispose of disposers.reverse()) dispose()
  await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
}
