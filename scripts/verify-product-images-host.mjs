/** Production host + public DSH runtime contract fixture. No provider or LLM calls. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const root = mkdtempSync(join(tmpdir(), 'dsh-product-images-host-'))
const workspace = join(root, 'workspace'); mkdirSync(workspace)
process.env.DSH_HOME = root
process.env.DSH_WORKBENCH_DB = join(root, 'workbench.sqlite')
const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#5075baff' } }).png().toBuffer()
const attachment = { attachmentId: 'sha256:' + createHash('sha256').update(png).digest('hex'), mediaType: 'image/png', width: 8, height: 8, bytes: png.length }
const routes = [], disposers = [], tools = new Map(), agents = new Map(), calls = [], reads = []
let pluginEnabled = false, executor = 'native', release
const ctx = {
  tools: {
    register(definition) { tools.set(definition.name, definition); return () => {} },
    get(name) { return tools.get(name) },
    schemas() { return [...tools.values()].map(value => ({ name: value.name })) },
    async execute(input) {
      assert.ok(Array.isArray(input.calls)); assert.equal(input.calls.length, 1)
      const call = input.calls[0], args = JSON.parse(call.arguments)
      assert.ok(['generate_image', 'edit_image'].includes(call.name))
      if (call.name === 'edit_image') assert.equal(input.agent.session.header.cwd, workspace, 'Trusted workspace from real created agent')
      calls.push({ call, args })
      if (release) await new Promise(resolve => { release.resolve = resolve })
      return { results: [{ callId: call.id, result: { isError: false, value: { attachment, provider: 'fixture', model: 'fixture-image', channel: 'verified-channel' }, content: [] } }], additionalContexts: [], concluded: false }
    },
  },
  attachments: {
    async readImage(ref) { reads.push(ref); assert.deepEqual(ref, attachment); return { ref, data: new Uint8Array(png) } },
  },
  agents: {
    get(id) { return agents.get(id) },
    async create({ sessionId, meta }) {
      const agent = { id: sessionId, session: { id: sessionId, header: { id: sessionId, cwd: meta.cwd } } }
      agents.set(sessionId, agent)
      return { agent, async dispose() { agents.delete(sessionId) } }
    },
  },
  systemPrompt: { async assemble() { return { tools: executor === 'native' ? ctx.tools.schemas() : [{ name: 'run_code' }] } } },
  webServer: { register(route) { routes.push(route); return () => {} }, tapIndex: () => () => {} },
  get(name) { return this[name] },
  on: () => () => {},
  effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
  logger: { info() {}, warn() {}, error() {} },
}
function enablePlugin() {
  pluginEnabled = true
  for (const name of ['generate_image', 'edit_image']) tools.set(name, { name, execute() {}, output: { schema: {} }, parameters: { type: 'object', properties: { prompt: { type: 'string' }, ...(name === 'edit_image' ? { source_path: { type: 'string' } } : {}) } } })
}
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const route = routes.find(item => path === item.path || path.startsWith(item.path + '/'))
  if (route) route.handler(req, res)
  else { res.writeHead(404); res.end() }
})
try {
  const { apply } = await import('../lib/index.js')
  apply(ctx)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  async function request(path, method = 'GET', body, expected = 200, headers = {}) {
    const response = await fetch(origin + '/workbench-api' + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value = await response.json()
    assert.equal(response.status, expected, JSON.stringify(value))
    return value
  }
  const product = (await request('/products', 'POST', { name: '图片接入隔离验证', workspacePath: workspace })).product
  const productB = (await request('/products', 'POST', { name: '其他产品', workspacePath: workspace })).product
  const productHash = createHash('sha256').update(product.id).digest('hex').slice(0, 32)
  const v1SelectionPath = join(workspace, '.dsh-workbench', 'product-images', productHash, 'selection.json')
  const statePath = '/product-images/state?productId=' + encodeURIComponent(product.id)
  const initial = await request(statePath)
  assert.equal(pluginEnabled, false); assert.equal(initial.available, false)
  assert.deepEqual(initial.candidates, []); assert.equal(calls.length, 0)
  assert(tools.has('workbench_image_generate') && tools.has('workbench_image_export'))
  const args = { productId: product.id, requestId: randomUUID(), mode: 'generate', prompt: '一张用于测试的扁平图标', confirmed: true }
  await request('/product-images/generate', 'POST', { ...args, confirmed: false }, 400)
  const longPrompt = await request('/product-images/generate', 'POST', { ...args, prompt: '图'.repeat(12000), confirmed: false }, 400)
  assert.equal(longPrompt.error, 'image_generation_confirmation_required', 'Valid-length Chinese prompt fits the JSON wire limit')
  await request('/product-images/generate', 'POST', args, 403, { origin: 'https://other.invalid' })
  await request('/product-images/generate', 'POST', { ...args, workspaceRoot: workspace }, 400)
  await request('/product-images/generate', 'POST', { ...args, productId: 'missing-product' }, 404)
  await request(statePath + '&productId=another', 'GET', undefined, 400)
  assert.equal(calls.length, 0)
  enablePlugin()
  const ready = await request(statePath)
  assert.equal(ready.available, true, JSON.stringify(ready))
  executor = 'ptc'
  assert.equal((await request(statePath)).available, false, 'PTC has no native image entry')
  executor = 'native'
  const generated = await request('/product-images/generate', 'POST', args)
  assert.equal(generated.job.status, 'succeeded', JSON.stringify(generated))
  assert.equal(calls.length, 1); assert.equal(reads.length, 1); assert.equal(agents.size, 0)
  assert.equal(generated.candidate.provider, 'fixture')
  assert.equal(generated.candidate.model, 'fixture-image')
  assert.equal(generated.candidate.selected, false)
  const duplicate = await request('/product-images/generate', 'POST', args)
  assert.equal(duplicate.candidate.id, generated.candidate.id); assert.equal(calls.length, 1)
  await request('/product-images/generate', 'POST', { ...args, prompt: 'different' }, 409)
  const imagePath = generated.candidate.previewUrl
  const image = await fetch(origin + imagePath)
  assert.equal(image.headers.get('content-type'), 'image/webp')
  const v1Preview = Buffer.from(await image.arrayBuffer())
  const v1PreviewInfo = await sharp(v1Preview).metadata()
  assert.equal(v1PreviewInfo.format, 'webp')
  assert(v1PreviewInfo.width <= 1024 && v1PreviewInfo.height <= 1024)
  const downloaded = await fetch(origin + generated.candidate.downloadUrl)
  assert.match(downloaded.headers.get('content-disposition'), /^attachment;/)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png, 'original downloads retain the exact source bytes')
  await request('/product-images/select', 'POST', { productId: product.id, candidateId: generated.candidate.id, selected: true })
  assert.equal((await request(statePath)).candidates[0].selected, true)
  const v1SelectionBeforeV2 = readFileSync(v1SelectionPath)
  await request('/product-images/select', 'POST', { productId: productB.id, candidateId: generated.candidate.id, selected: true }, 404)
  const edited = await request('/product-images/generate', 'POST', { ...args, requestId: randomUUID(), mode: 'edit', referenceId: generated.candidate.id, prompt: '保持主体，改成绿色' })
  assert.equal(edited.job.status, 'succeeded', JSON.stringify(edited))
  assert.equal(calls[1].call.name, 'edit_image')
  assert.equal(edited.candidate.sourceCandidateId, generated.candidate.id)
  assert.equal(calls.length, 2)
  const importInput = { productId: product.id, requestId: randomUUID(), fileName: 'forest-icon.png', mime: 'image/png', dataBase64: png.toString('base64') }
  await request('/tools/policy', 'PATCH', { tool: 'workbench_image_import', enabled: false })
  await request('/product-images/import', 'POST', importInput, 403)
  assert.equal((await request(statePath)).candidates.length, 2, 'Denied import does not write a candidate')
  await request('/tools/policy', 'PATCH', { tool: 'workbench_image_import', enabled: true })
  const imported = await request('/product-images/import', 'POST', {
    ...importInput,
  })
  assert.equal(imported.operation.kind, 'import')
  assert.equal(imported.operation.status, 'succeeded')
  assert.equal(imported.candidate.formatVersion, 2)
  assert.equal(imported.candidate.mode, 'import')
  assert.equal(imported.candidate.sha256, createHash('sha256').update(png).digest('hex'))
  assert.equal(calls.length, 2, 'import does not call an image model')
  const importedAgain = await request('/product-images/import', 'POST', importInput)
  assert.equal(importedAgain.operation.id, imported.operation.id)
  assert.equal(importedAgain.candidate.id, imported.candidate.id)
  await request('/product-images/import', 'POST', { ...importInput, fileName: 'changed.png' }, 409)
  const importedPreview = await fetch(origin + imported.candidate.previewUrl)
  assert.equal(importedPreview.status, 200)
  assert.equal(importedPreview.headers.get('content-type'), 'image/webp')
  assert.equal(importedPreview.headers.get('cache-control'), 'no-store')
  const previewBytes = Buffer.from(await importedPreview.arrayBuffer())
  const previewInfo = await sharp(previewBytes).metadata()
  assert.equal(previewInfo.format, 'webp')
  assert(previewInfo.width <= 1024 && previewInfo.height <= 1024, 'preview derivatives are bounded to 1024 pixels per axis')
  const cachedPreview = await fetch(origin + imported.candidate.previewUrl)
  assert.deepEqual(Buffer.from(await cachedPreview.arrayBuffer()), previewBytes, 'the bounded in-memory preview cache returns its hash-keyed derivative')
  const importedDownload = await fetch(origin + imported.candidate.downloadUrl)
  assert.match(importedDownload.headers.get('content-disposition'), /^attachment;/)
  assert.deepEqual(Buffer.from(await importedDownload.arrayBuffer()), png)
  const importedState = await request(statePath)
  assert(importedState.candidates.some(candidate => candidate.id === imported.candidate.id && candidate.formatVersion === 2))
  await request('/product-images/select', 'POST', { productId: product.id, candidateId: imported.candidate.id, formatVersion: 2, selected: true })
  assert.deepEqual(readFileSync(v1SelectionPath), v1SelectionBeforeV2, 'v2 selections never change the v1 selection bytes')
  const metadata = await request('/product-images/metadata', 'POST', { productId: product.id, candidateId: imported.candidate.id, formatVersion: 2, tags: ['UI', '候选'], notes: '透明背景待人工检查' })
  assert.deepEqual(metadata.metadata.tags, ['UI', '候选'])
  assert.equal(metadata.metadata.notes, '透明背景待人工检查')
  await request('/product-images/metadata', 'POST', {
    productId: product.id, candidateId: imported.candidate.id, formatVersion: 2,
    tags: Array.from({ length: 51 }, (_, index) => `tag-${index + 1}`),
  }, 400)
  const check = await request('/product-images/check', 'POST', { productId: product.id, candidateId: imported.candidate.id, formatVersion: 2 })
  assert.equal(check.check.status, 'pass')
  assert.equal(check.check.hasAlpha, true)
  assert.equal(check.check.hasTransparentPixels, false)
  const stateAfterCheck = await request(statePath)
  const checkedCandidate = stateAfterCheck.candidates.find(candidate => candidate.id === imported.candidate.id)
  assert.deepEqual(checkedCandidate.metadata.checks[0], check.check, 'the host state round-trips the persisted check sidecar')
  await request('/product-images/select', 'POST', { productId: productB.id, candidateId: imported.candidate.id, formatVersion: 2, selected: true }, 404)
  await request('/tools/policy', 'PATCH', { capability: 'network', enabled: false })
  await request('/product-images/generate', 'POST', { ...args, requestId: randomUUID() }, 403)
  assert.equal(calls.length, 2)
  assert.equal((await request(statePath)).candidates.length, importedState.candidates.length, 'Local reads remain available')
  await request('/tools/policy', 'PATCH', { capability: 'network', enabled: true })
  await request('/tools/policy', 'PATCH', { tool: 'workbench_image_select', enabled: false })
  await request('/product-images/generate', 'POST', { ...args, requestId: randomUUID() }, 403)
  assert.equal(calls.length, 2)
  await request('/tools/policy', 'PATCH', { tool: 'workbench_image_select', enabled: true })
  await request('/tools/policy', 'PATCH', { capability: 'write.local', enabled: false })
  await request('/product-images/generate', 'POST', { ...args, requestId: randomUUID() }, 403)
  assert.equal(calls.length, 2)
  await request('/tools/policy', 'PATCH', { capability: 'write.local', enabled: true })
  const agentResult = await tools.get('workbench_image_generate').execute({ ...args, requestId: randomUUID() })
  assert.equal(agentResult.ok, true, JSON.stringify(agentResult)); assert.equal(agentResult.result.job.status, 'succeeded')
  const exported = await tools.get('workbench_image_export').execute({ productId: product.id, candidateId: generated.candidate.id })
  assert.equal(exported.ok, true); assert.match(exported.result.downloadUrl, /download=1$/)
  assert.equal(calls.length, 3)
  const content = JSON.stringify((await request(statePath)))
  assert.equal(content.includes(workspace.replaceAll('\\', '\\\\')), false, 'No arbitrary host paths in browser state')
  assert(readdirSync(workspace).includes('.dsh-workbench'))
  assert.equal(agents.size, 0)
  console.log('PASS production image host: tool registration, missing-plugin and PTC detection, no LLM calls, HTTP validation/origin/policy, real attachment archival, idempotency, edit isolation, selection, exact-byte download and Agent tools. Provider execution is a fixture; no paid image request was made.')
} finally {
  release?.resolve?.()
  if (server.listening) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
  for (const dispose of disposers.reverse()) await dispose()
  // The production SQLite store owns handles for the host process lifetime.
  // Keep this isolated OS-temp fixture, as other production-host checks do;
  // attempting recursive removal while SQLite is open fails on Windows.
}
