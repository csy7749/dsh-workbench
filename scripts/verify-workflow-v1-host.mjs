/** Current V1 bundle over real loopback HTTP, isolated database and synthetic content. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'workflow-v1-host-'))
process.env.DSH_HOME = root
process.env.DSH_WORKBENCH_DB = join(root, 'workbench.sqlite')
const { apply } = await import(process.env.WORKFLOW_HOST_BUNDLE ?? '../lib/index.js')
const routes = []
const disposers = []
const ctx = {
  tools: { register: () => () => {} },
  webServer: { register: route => { routes.push(route); return () => {} }, tapIndex: () => () => {} },
  effect: factory => { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
  get: () => undefined, on: () => () => {},
  logger: { info() {}, warn() {}, error() {} },
}
apply(ctx)
assert(routes.some(route => route.path === '/workbench-api'))
assert(!routes.some(route => route.path.includes('sandbox')))
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const route = routes.find(route => path === route.path || path.startsWith(route.path + '/'))
  if (!route) { res.writeHead(404); res.end(); return }
  route.handler(req, res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let assertions = 0
async function call(path, method = 'GET', body, status = 200) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/workbench-api${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json()
  assert.equal(response.status, status, JSON.stringify(value)); assertions++
  return value
}
try {
  const catalog = await call('/workflow/catalog')
  assert(catalog.defs.some(node => node.id === 'config.combine'))
  assert.equal(catalog.defs.find(node => node.id === 'game.build').executor, 'dsh-session')
  const productA = (await call('/products', 'POST', { name: 'Isolated V1 A', workspacePath: root })).product
  const productB = (await call('/products', 'POST', { name: 'Isolated V1 B', workspacePath: root })).product
  await call('/workflow/graphs', 'POST', { productId: root, templateId: 'game-gdd-to-playtest' }, 400)
  const draft = await call('/workflow/graphs', 'POST', { templateId: 'game-gdd-to-playtest' }, 201)
  await call('/workflow/runs', 'POST', { graphId: draft.row.id }, 400)
  const a = await call('/workflow/templates/game-gdd-to-playtest/fork', 'POST', { productId: productA.id }, 201)
  assert.equal(a.row.product_id, productA.id)
  assert.equal(a.row.forked_from_revision, 1)
  a.graph.nodes.find(node => node.type === 'input.brief').config.text = 'A private brief'
  a.graph.nodes.find(node => node.type === 'output.publish').config.dir = 'A/private/path'
  const saved = await call('/workflow/graphs/' + a.row.id, 'PUT', { graph: a.graph, baseRevision: 1 })
  await call('/workflow/graphs/' + a.row.id, 'PUT', { graph: a.graph, baseRevision: 1 }, 409)
  await call('/workflow/graphs/' + a.row.id, 'PUT', { graph: a.graph }, 409)
  const preview = await call('/workflow/graphs/' + a.row.id + '/template')
  assert.equal(preview.fields.length, 2)
  const template = (await call('/workflow/graphs/' + a.row.id + '/template', 'POST', { name: 'Isolated reusable flow' }, 201)).template
  await call('/workflow/templates/' + template.id)
  assert.equal((await call('/workflow/templates/' + template.id + '/versions')).versions.length, 1)
  const b = await call('/workflow/templates/' + template.id + '/fork', 'POST', { productId: productB.id }, 201)
  assert.equal(b.graph.nodes.find(node => node.type === 'input.brief').config.text, '')
  assert.equal(b.graph.nodes.find(node => node.type === 'output.publish').config.dir, '')
  assert.equal((await call('/workflow/graphs?product=' + productB.id)).graphs.length, 1)
  assert.equal((await call('/workflow/graphs/' + a.row.id)).row.revision, saved.row.revision)
  let view = (await call('/workflow/runs', 'POST', { graphId: a.row.id }, 201)).view
  const runPath = '/workflow/runs/' + view.runId
  assert.equal(view.waiting.nodeId, 'gdd')
  assert(view.steps.every(step => typeof step.stepId === 'string' && step.stepId.length > 0))
  assert.equal(view.steps.find(step => step.nodeId === 'gdd').sourceAttemptId, null)
  view = (await call(runPath + '/auto', 'POST', { enabled: true })).view
  assert.equal(view.auto.enabled, 1)
  await call(runPath + '/submit', 'POST', { content: 'must not race automatic dispatch' }, 400)
  view = (await call(runPath + '/auto', 'POST', { enabled: false })).view
  assert.equal(view.auto.enabled, 0)
  await call(runPath + '/generation', 'POST', { sessionId: 'no-live-gateway' }, 400)
  assert.equal((await call(runPath)).view.attempts.filter(attempt => attempt.session_id).length, 0)
  view = (await call(runPath + '/submit', 'POST', { content: '# Isolated design\nConcrete design for A' })).view
  const designStep = view.steps.find(step => step.nodeId === 'gdd')
  assert(designStep.sourceAttemptId, 'current artifact exposes its exact source attempt')
  assert(view.attempts.some(attempt => attempt.id === designStep.sourceAttemptId && attempt.node_id === designStep.nodeId))
  const bad = await call(runPath + '/submit', 'POST', { content: '{}' })
  assert.equal(bad.view.status, 'paused')
  assert.equal(bad.adopted.status, 'failed')
  view = (await call(runPath + '/resume', 'POST', { expectedRevision: bad.view.revision })).view
  const rules = { version: 1, title: 'A', player: { count: 1, controls: ['左右移动'] }, goal: ['收集十枚金币'], fail: ['碰到障碍'], loop: ['移动', '收集', '计分', '检查胜负'], acceptance: ['收集十枚后显示胜利'], openQuestions: ['数值待定，由试玩决定'] }
  view = (await call(runPath + '/submit', 'POST', { content: JSON.stringify(rules) })).view
  assert.equal(view.status, 'waiting_review')
  assert.equal(view.waiting.editor.fields.length, 2)
  const stale = { ...view.waiting }
  const edited = JSON.parse(view.waiting.content); edited.rules = JSON.stringify({ ...rules, title: 'Reviewed A' })
  view = (await call(runPath + '/draft', 'POST', { taskId: stale.taskId, content: JSON.stringify(edited), expectedBindingVersion: stale.bindingVersion, expectedTaskRevision: stale.taskRevision })).view
  assert.equal((await call(runPath)).view.waiting.content, JSON.stringify(edited))
  await call(runPath + '/confirm', 'POST', { taskId: stale.taskId, content: stale.content, expectedBindingVersion: stale.bindingVersion, expectedTaskRevision: stale.taskRevision, expectedRunRevision: view.revision }, 400)
  const waiting = view.waiting
  view = (await call(runPath + '/confirm', 'POST', { taskId: waiting.taskId, content: waiting.content, expectedBindingVersion: waiting.bindingVersion, expectedTaskRevision: waiting.taskRevision, expectedRunRevision: view.revision, intent: 'pause' })).view
  assert.equal(view.status, 'paused')
  view = (await call(runPath + '/resume', 'POST', { expectedRevision: view.revision })).view
  assert.equal(view.status, 'completed')
  const exported = await call(runPath + '/export', 'POST', {})
  assert.deepEqual(exported.files.sort(), ['brief.txt', 'gdd.md', 'rules.json', 'report.md', 'manifest.json'].sort())
  assert.equal(JSON.parse(readFileSync(join(exported.dir, 'rules.json'), 'utf8')).title, 'Reviewed A')
  assert.equal(JSON.parse(readFileSync(join(exported.dir, 'manifest.json'), 'utf8')).sourceRevision, 2)
  assert.equal((await call('/workflow/runs?graphId=' + a.row.id)).runs.length, 1)
  console.log(`PASS V1 host bundle: ${assertions} HTTP responses; product isolation, CAS, redaction, failure/retry, review/pause, five-file export`)
} finally {
  await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
  for (const dispose of disposers.reverse()) dispose()
}
