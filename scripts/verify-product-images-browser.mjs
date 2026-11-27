/** Product-image UI with a local HTTP fixture. No model calls or browser downloads. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import sharp from 'sharp'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
let chromium
for (const name of process.env.DSH_GAME_PLAYWRIGHT_PATH ? [process.env.DSH_GAME_PLAYWRIGHT_PATH] : [
  'playwright', 'playwright-core', join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
]) { try { chromium = require(name).chromium; if (chromium) break } catch {} }
assert.ok(chromium, 'Requires installed Playwright; optionally set DSH_GAME_PLAYWRIGHT_PATH')
const executablePath = (process.env.DSH_GAME_BROWSER_EXECUTABLE ? [process.env.DSH_GAME_BROWSER_EXECUTABLE] : [
  join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA || homedir(), 'Microsoft/Edge/Application/msedge.exe'), chromium.executablePath(),
]).find(path => existsSync(path))
assert.ok(executablePath, 'Requires installed Chrome/Edge')

const moduleText = ts.transpileModule(readFileSync(join(root, 'src/client/product-images.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, fileName: 'product-images.ts',
}).outputText
const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#5075ba80' } }).png().toBuffer()
const products = new Map(['product-a', 'product-b'].map(id => [id, { available: true, candidates: [], jobs: [], operations: [] }]))
const writes = [], errors = [], externalRequests = [], imageRequests = []
let delayedGeneration = null, delayNext = false, unknownNext = false, unavailable = false, denyNext = false, failNext = false
let unavailableReason = '图片插件尚未连接'
let imageReads = 0
const maliciousPrompt = '<img src=x onerror="window.untrustedExecuted=true"> 纸雕风森林卡片'
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Product image check</title>
<style>body{margin:0;background:#f6f6f8;font-family:Arial,sans-serif}main{max-width:1050px;margin:auto}</style>
<main id="host"></main><script type="module">
import {createProductImagesView} from '/product-images.js';
const shadow=document.querySelector('#host').attachShadow({mode:'open'});
const host=shadow.appendChild(document.createElement('div'));
window.mountProduct=id=>{window.images?.destroy();window.images=createProductImagesView(host,{apiBase:'/workbench-api',product:{id,name:id}});window.images.mount()};
window.mountProduct('product-a');
</script></html>`

function json(res, body, code = 200) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
async function readBody(req) { let value = ''; for await (const chunk of req) value += chunk; return JSON.parse(value) }
function finishGeneration(res, body, state) {
  const job = state.jobs.find(item => item.id === body.requestId)
  if (failNext) { failNext = false; job.status = 'failed'; job.error = '渠道明确拒绝生成'; json(res, { ok: true, job }); return }
  job.status = unknownNext ? 'unknown' : 'succeeded'
  if (unknownNext) { unknownNext = false; job.error = '渠道连接中断，无法确认结果'; json(res, { ok: true, job }); return }
  const candidate = { id: 'candidate-' + body.requestId, createdAt: new Date().toISOString(), mode: body.mode, prompt: body.prompt,
    provider: 'fixture-provider', channel: 'fixture-channel', model: 'fixture-model', width: 1, height: 1, mime: 'image/png', bytes: png.length,
    sha256: 'a'.repeat(64), selected: false, ...(body.referenceId ? { sourceCandidateId: body.referenceId } : {}) }
  job.candidateId = candidate.id
  state.candidates.unshift(candidate)
  json(res, { ok: true, job, candidate })
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return }
    if (url.pathname === '/product-images.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(moduleText); return }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
    if (url.pathname.endsWith('/state')) {
      const state = products.get(url.searchParams.get('productId'))
      json(res, { ok: true, ...state, available: !unavailable, ...(unavailable ? { reason: unavailableReason } : {}) }); return
    }
    if (url.pathname.endsWith('/image') || url.pathname.endsWith('/preview')) {
      const state = products.get(url.searchParams.get('productId'))
      const candidate = state?.candidates.find(item => item.id === url.searchParams.get('candidateId'))
      assert.ok(candidate, 'Image reads resolve only within the requested product')
      assert.equal(url.searchParams.get('formatVersion') ?? '1', String(candidate.formatVersion ?? 1), 'Preview and download preserve candidate format identity')
      imageRequests.push({ path: url.pathname, productId: url.searchParams.get('productId'), candidateId: candidate.id, formatVersion: candidate.formatVersion ?? 1 })
      imageReads += 1
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', ...(url.searchParams.has('download') ? { 'content-disposition': 'attachment; filename="image.png"' } : {}) }); res.end(png); return
    }
    if (url.pathname.endsWith('/generate')) {
      const body = await readBody(req), state = products.get(body.productId)
      writes.push({ action: 'generate', ...body })
      assert.equal(body.confirmed, true)
      assert.match(body.requestId, /^[a-f\d-]{36}$/)
      if (denyNext) { denyNext = false; json(res, { ok: false, error: '图片生成未获工具策略授权' }, 403); return }
      if (body.mode === 'edit') assert.ok(state.candidates.some(item => item.id === body.referenceId))
      state.jobs.unshift({ id: body.requestId, status: 'running', createdAt: new Date().toISOString() })
      if (delayNext) { delayNext = false; delayedGeneration = () => { finishGeneration(res, body, state); delayedGeneration = null }; return }
      finishGeneration(res, body, state); return
    }
    if (url.pathname.endsWith('/import')) {
      const body = await readBody(req), state = products.get(body.productId)
      writes.push({ action: 'import', ...body })
      assert.match(body.requestId, /^[a-f\d-]{36}$/)
      assert.equal(body.fileName, 'local-forest.png')
      assert.equal(body.mime, 'image/png')
      assert.equal(Buffer.from(body.dataBase64, 'base64').compare(png), 0)
      const candidate = { id: 'import-' + body.requestId, formatVersion: 2, createdAt: new Date().toISOString(), mode: 'import', prompt: body.fileName,
        width: 1, height: 1, mime: body.mime, bytes: png.length, sha256: 'b'.repeat(64), selected: false, metadata: { tags: [], notes: '' } }
      const operation = { id: body.requestId, kind: 'import', status: 'succeeded', createdAt: candidate.createdAt, outputs: [candidate.id] }
      state.candidates.unshift(candidate); state.operations.unshift(operation)
      json(res, { ok: true, operation, candidate }); return
    }
    if (url.pathname.endsWith('/select')) {
      const body = await readBody(req), state = products.get(body.productId)
      writes.push({ action: 'select', ...body })
      const candidate = state.candidates.find(item => item.id === body.candidateId)
      assert.ok(candidate); candidate.selected = body.selected
      json(res, { ok: true, candidate }); return
    }
    if (url.pathname.endsWith('/metadata')) {
      const body = await readBody(req), state = products.get(body.productId)
      writes.push({ action: 'metadata', ...body })
      const candidate = state.candidates.find(item => item.id === body.candidateId && item.formatVersion === 2)
      assert.ok(candidate)
      candidate.metadata = { ...candidate.metadata, tags: body.tags, notes: body.notes }
      json(res, { ok: true, metadata: candidate.metadata }); return
    }
    if (url.pathname.endsWith('/check')) {
      const body = await readBody(req), state = products.get(body.productId)
      writes.push({ action: 'check', ...body })
      const candidate = state.candidates.find(item => item.id === body.candidateId && item.formatVersion === 2)
      assert.ok(candidate)
      const check = { sha256: 'b'.repeat(64), status: 'pass', hasAlpha: true, hasTransparentPixels: true, width: 1, height: 1, mime: 'image/png', bytes: png.length, visualStatus: 'not-evaluated' }
      candidate.metadata = { ...candidate.metadata, checks: [check] }
      json(res, { ok: true, check }); return
    }
    res.writeHead(404); res.end()
  } catch (error) { errors.push(error.message); if (!res.writableEnded) json(res, { ok: false, error: error.message }, 500) }
})

let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ executablePath, headless: true, timeout: 10000, args: ['--disable-extensions', '--no-first-run'] })
  const context = await browser.newContext({ viewport: { width: 1180, height: 950 }, acceptDownloads: true })
  context.setDefaultTimeout(10000)
  await context.route('**/*', route => {
    const url = route.request().url()
    if (!url.startsWith(origin + '/') && !/^(data|blob):/.test(url)) { externalRequests.push(url); return route.abort() }
    return route.continue()
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const candidateCard = id => page.locator(`[data-candidate-id="${id}"]`)
  async function assertComparison(expected, description) {
    const items = page.locator('[data-image-compare] [data-compare-candidate]')
    await page.waitForFunction(count => document.querySelector('#host').shadowRoot.querySelectorAll('[data-image-compare] [data-compare-candidate]').length === count, expected.length)
    assert.deepEqual(await items.evaluateAll(nodes => nodes.map(node => node.dataset.compareCandidate)), expected, description)
    const images = page.locator('[data-image-compare] img')
    await images.evaluateAll(nodes => Promise.all(nodes.map(image => image.decode())))
    const sources = await images.evaluateAll(nodes => nodes.map(image => image.src))
    for (const [index, value] of sources.entries()) {
      const url = new URL(value), [version, ...idParts] = expected[index].split(':')
      const candidateId = idParts.join(':')
      const candidate = products.get('product-a').candidates.find(item => item.id === candidateId && String(item.formatVersion ?? 1) === version)
      assert.ok(candidate)
      const figure = page.locator('[data-image-compare] .pi-compare-item').nth(index)
      assert.equal(await figure.getAttribute('data-candidate-key'), expected[index])
      assert.equal(await figure.getAttribute('data-candidate-mode'), candidate.mode)
      const caption = await figure.locator('figcaption').innerText()
      assert.ok(caption.includes({ generate: '插件生成', edit: '插件编辑', import: '本地导入' }[candidate.mode]), 'The comparison identifies the image source')
      for (const detail of [candidate.provider, candidate.channel, candidate.model, candidate.prompt].filter(Boolean)) {
        assert.ok(caption.includes(detail), 'The comparison retains provider/channel/model and prompt provenance')
      }
      assert.equal(url.pathname, '/workbench-api/product-images/preview')
      assert.equal(url.searchParams.get('productId'), 'product-a')
      assert.equal(url.searchParams.get('candidateId'), candidateId)
      assert.equal(url.searchParams.get('formatVersion') ?? '1', version)
      assert.ok(imageRequests.some(request => request.path.endsWith('/preview') && request.productId === 'product-a'
        && request.candidateId === candidateId && String(request.formatVersion) === version), 'The comparison loads the correct versioned preview')
    }
  }
  await page.goto(origin)
  await page.getByText('dsh-image-gen 可用', { exact: false }).waitFor()
  assert.equal(writes.length, 0, 'Mounting does not invoke any write')
  assert.equal(await page.locator('[name="image-reference"]').isVisible(), false)
  await page.locator('[name="image-prompt"]').fill(maliciousPrompt)
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), false, 'Quota confirmation starts unchecked for a new product')
  assert.equal(await page.locator('[data-image-action="generate"]').isDisabled(), true, 'Explicit quota confirmation required')
  await page.locator('[name="image-confirm"]').check()
  await page.locator('[data-image-action="refresh"]').click()
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), maliciousPrompt, 'State refresh retains draft')
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), true, 'State refresh retains quota confirmation')
  await page.reload()
  await page.getByText('dsh-image-gen 可用', { exact: false }).waitFor()
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), true, 'Reloading restores the saved quota confirmation')
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), maliciousPrompt, 'Reloading retains the product draft')
  assert.equal(writes.length, 0, 'Restoring quota confirmation does not submit a generation')
  await page.locator('[name="image-confirm"]').uncheck()
  await page.reload()
  await page.getByText('dsh-image-gen 可用', { exact: false }).waitFor()
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), false, 'Manually revoking confirmation persists after reload')
  assert.equal(await page.locator('[data-image-action="generate"]').isDisabled(), true, 'Revoking confirmation disables submission')
  await page.locator('[name="image-confirm"]').check()
  await page.evaluate(() => window.mountProduct('product-a'))
  await page.getByText('dsh-image-gen 可用', { exact: false }).waitFor()
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), true, 'Recreating the product view restores quota confirmation')
  assert.equal(writes.length, 0, 'Reloading or recreating a confirmed view never invokes a write')
  delayNext = true
  await page.locator('[data-image-action="generate"]').click()
  await page.waitForFunction(() => document.querySelector('#host').shadowRoot.querySelector('[data-image-action="generate"]').disabled)
  for (let attempt = 0; attempt < 20 && !delayedGeneration; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(delayedGeneration)
  await page.locator('[data-image-action="refresh"]').click()
  await page.locator('[data-image-jobs] [data-status="running"]').waitFor()
  assert.equal(writes.filter(item => item.action === 'generate').length, 1, 'Reading running status never repeats a submission')
  delayedGeneration()
  const card = page.locator('[data-candidate-id]').first()
  await card.waitFor()
  await card.locator('img').evaluate(img => img.decode())
  await card.locator('img').evaluate(img => { window.originalImageElement = img })
  const imageReadsBeforeRefresh = imageReads
  await page.locator('[data-image-action="refresh"]').click()
  await page.waitForFunction(() => !document.querySelector('#host').shadowRoot.querySelector('[data-image-action="refresh"]').disabled)
  assert.equal(await card.locator('img').evaluate(img => img === window.originalImageElement), true, 'Status refresh retains original image DOM')
  assert.equal(imageReads, imageReadsBeforeRefresh, 'Status polling does not re-download no-store images')
  assert.equal(await page.evaluate(() => !!window.untrustedExecuted), false)
  assert.equal(await card.locator('img').count(), 1, 'Prompt markup is displayed only as text')
  assert.match(await card.innerText(), /fixture-provider.*fixture-model.*1 × 1/)
  const candidateId = await card.getAttribute('data-candidate-id')
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), true, 'Submitting a generation retains quota confirmation')
  await card.locator('[data-image-action="select"]').click()
  await page.locator('[data-candidate-id][data-selected="true"]').waitFor()
  await card.locator('[data-image-action="select"]').click()
  await page.locator('[data-candidate-id][data-selected="false"]').waitFor()
  const downloaded = page.waitForEvent('download')
  await card.locator('[data-image-action="download"]').click()
  assert.equal((await downloaded).suggestedFilename(), 'image.png')
  await card.locator('[data-image-action="reference"]').click()
  assert.equal(await page.locator('[name="image-reference"]').inputValue(), candidateId)
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), true, 'Choosing an edit reference retains quota confirmation')
  await page.locator('[name="image-mode"]').selectOption('generate')
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), true, 'Switching generation mode retains quota confirmation')
  await page.locator('[name="image-mode"]').selectOption('edit')
  await page.locator('[name="image-reference"]').selectOption(candidateId)
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), true, 'Changing the edit reference retains quota confirmation')
  await page.locator('[name="image-prompt"]').fill('将背景改为蓝色，保留主体')
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), true, 'Editing the prompt retains quota confirmation')
  assert.equal(await page.locator('[data-image-action="generate"]').isDisabled(), false, 'The next edit can be submitted without confirming again')
  await page.locator('[data-image-action="generate"]').click()
  await page.locator('[data-candidate-id]').nth(1).waitFor()
  assert.equal(writes.filter(item => item.action === 'generate').at(-1).referenceId, candidateId)
  const firstCandidate = page.locator('[data-candidate-id]').nth(0)
  const secondCandidate = page.locator('[data-candidate-id]').nth(1)
  const editedId = await firstCandidate.getAttribute('data-candidate-id')
  const generationCountBeforeComparisons = writes.filter(item => item.action === 'generate').length
  await firstCandidate.locator('[data-image-action="compare"]').click()
  await secondCandidate.locator('[data-image-action="compare"]').click()
  await page.locator('[data-image-compare] .pi-compare-item').first().waitFor()
  assert.equal(await page.locator('[data-image-compare] .pi-compare-item').count(), 2)
  await assertComparison([`1:${editedId}`, `1:${candidateId}`], 'Two network-generated candidates compare in the shared gallery')
  await page.locator('[name="image-compare-zoom"]').selectOption('2')
  await page.locator('[name="image-checkerboard"]').uncheck()
  assert.equal(await page.locator('[name="image-checkerboard"]').isChecked(), false)
  await page.locator('[name="image-import-file"]').setInputFiles({ name: 'local-forest.png', mimeType: 'image/png', buffer: png })
  const importedCard = page.locator('[data-format-version="2"]').first()
  await importedCard.waitFor()
  const importedId = await importedCard.getAttribute('data-candidate-id')
  await importedCard.locator(`[name="image-tags-${importedId}"]`).fill('forest, ui')
  await importedCard.locator(`[name="image-notes-${importedId}"]`).fill('本地候选备注')
  await importedCard.locator('[data-image-action="metadata"]').click()
  await page.getByText('标签与备注已保存到 v2 候选元数据。').waitFor()
  await importedCard.locator('[data-image-action="check"]').click()
  await page.getByText(/技术检查 pass.*存在透明像素/).waitFor()
  await page.locator('[data-image-action="refresh"]').click()
  await page.waitForFunction(() => !document.querySelector('#host').shadowRoot.querySelector('[data-image-action="refresh"]').disabled)
  assert.match(await importedCard.locator('p.pi-meta').innerText(), /技术检查 pass.*存在透明像素/, 'the persisted check remains visible after state reload')
  await importedCard.locator('[data-image-action="metadata"]').click()
  await page.getByText('标签与备注已保存到 v2 候选元数据。').waitFor()
  assert.match(await importedCard.locator('p.pi-meta').innerText(), /技术检查 pass.*存在透明像素/, 'saving tags and notes preserves the check')
  const metadataWriteCount = writes.filter(item => item.action === 'metadata').length
  const tooManyTags = Array.from({ length: 51 }, (_, index) => `tag-${index + 1}`).join(', ')
  const tagsInput = importedCard.locator(`[name="image-tags-${importedId}"]`)
  await tagsInput.fill(tooManyTags)
  assert.equal((await tagsInput.inputValue()).split(',').length, 51, 'the browser input retains all 51 tags for client-side validation')
  const saveMetadataButton = importedCard.locator('[data-image-action="metadata"]')
  assert.equal(await saveMetadataButton.isDisabled(), false)
  await saveMetadataButton.click()
  await page.waitForTimeout(100)
  const statusTexts = await page.locator('[role="status"]').allInnerTexts()
  assert.equal(writes.filter(item => item.action === 'metadata').length, metadataWriteCount,
    `the browser rejects more than 50 tags before the request; sentTags=${JSON.stringify(writes.filter(item => item.action === 'metadata').at(-1)?.tags?.length)} status=${JSON.stringify(statusTexts)}`)
  assert(statusTexts.some(text => text.includes('最多 50 个标签（每个 80 字符）和 4000 字符备注。')), JSON.stringify(statusTexts))
  assert.equal(writes.filter(item => item.action === 'import').length, 1)
  assert.equal(writes.filter(item => item.action === 'metadata').at(-1).notes, '本地候选备注')
  assert.equal(writes.filter(item => item.action === 'check').length, 1)
  await candidateCard(importedId).locator('[data-image-action="compare"]').click()
  await assertComparison([`1:${editedId}`, `1:${candidateId}`, `2:${importedId}`], 'Three-way comparison can mix generated and imported images')
  await page.locator('[name="image-import-file"]').setInputFiles({ name: 'local-forest.png', mimeType: 'image/png', buffer: png })
  await page.waitForFunction(() => document.querySelector('#host').shadowRoot.querySelectorAll('[data-format-version="2"]').length === 2)
  const secondImportedId = await page.locator('[data-format-version="2"]').first().getAttribute('data-candidate-id')
  assert.notEqual(secondImportedId, importedId, 'Separate imports retain independent candidate identities')
  await candidateCard(secondImportedId).locator('[data-image-action="compare"]').click()
  await assertComparison([`1:${editedId}`, `1:${candidateId}`, `2:${importedId}`, `2:${secondImportedId}`], 'Four-way comparison accepts both origins together')
  await candidateCard(editedId).locator('[data-image-action="compare"]').click()
  await candidateCard(candidateId).locator('[data-image-action="compare"]').click()
  await assertComparison([`2:${importedId}`, `2:${secondImportedId}`], 'Two local imports compare without generated candidates')
  assert.equal(await candidateCard(candidateId).locator('[data-image-action="compare"]').getAttribute('aria-pressed'), 'false', 'Removing a network candidate clears its comparison state')
  await candidateCard(importedId).locator('[data-image-action="compare"]').click()
  assert.equal(await page.locator('[data-image-compare] .pi-compare-item').count(), 0, 'The comparison hides when fewer than two candidates remain')
  await candidateCard(candidateId).locator('[data-image-action="compare"]').click()
  await assertComparison([`2:${secondImportedId}`, `1:${candidateId}`], 'A local import and a network-generated image compare in either source order')
  await page.locator('[data-image-action="refresh"]').click()
  await page.waitForFunction(() => !document.querySelector('#host').shadowRoot.querySelector('[data-image-action="refresh"]').disabled)
  await assertComparison([`2:${secondImportedId}`, `1:${candidateId}`], 'Refreshing retains the mixed-source comparison')
  assert.equal(writes.filter(item => item.action === 'import').length, 2)
  assert.equal(writes.filter(item => item.action === 'generate').length, generationCountBeforeComparisons, 'Importing, comparing, removing, zooming and refreshing never trigger another generation')
  unknownNext = true
  await page.locator('[name="image-confirm"]').check()
  await page.locator('[data-image-action="generate"]').click()
  await page.locator('[data-image-jobs] [data-status="unknown"]').waitFor()
  assert.match(await page.locator('[data-image-jobs] [data-status="unknown"]').innerText(), /不会自动重试/)
  const count = writes.filter(item => item.action === 'generate').length
  await page.locator('[data-image-action="refresh"]').click()
  await page.getByText('dsh-image-gen 可用', { exact: false }).waitFor()
  assert.equal(writes.filter(item => item.action === 'generate').length, count)

  denyNext = true
  await page.locator('[name="image-confirm"]').check()
  await page.locator('[data-image-action="generate"]').click()
  await page.locator('[data-image-jobs] [data-status="failed"]').waitFor()
  const refusedId = writes.filter(item => item.action === 'generate').at(-1).requestId
  const refusedJob = page.locator(`[data-job-id="${refusedId}"]`)
  assert.equal(await refusedJob.getAttribute('data-status'), 'failed')
  assert.match(await refusedJob.innerText(), /工具策略授权/)
  assert.doesNotMatch(await refusedJob.innerText(), /结果未知|可能已产生额度消耗/)
  await page.getByText('生成失败：图片生成未获工具策略授权', { exact: true }).waitFor()
  failNext = true
  await page.locator('[name="image-confirm"]').check()
  await page.locator('[data-image-action="generate"]').click()
  await page.getByText('生成失败：渠道明确拒绝生成', { exact: true }).waitFor()

  // Destroy during an outstanding generation, then mount another product.
  delayNext = true
  await page.locator('[name="image-confirm"]').check()
  await page.locator('[data-image-action="generate"]').click()
  for (let attempt = 0; attempt < 20 && !delayedGeneration; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(delayedGeneration)
  await page.evaluate(() => window.mountProduct('product-b'))
  await page.locator('[data-product-images="product-b"]').waitFor()
  delayedGeneration()
  await page.getByText('dsh-image-gen 可用', { exact: false }).waitFor()
  assert.equal(await page.locator('[data-candidate-id]').count(), 0, 'Late product A results cannot appear in product B')
  assert.equal(await page.locator('[data-image-compare] .pi-compare-item').count(), 0, 'Product A mixed-source comparison cannot appear in product B')
  assert.equal(await page.locator('[name="image-prompt"]').inputValue(), '')
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), false, 'Product B does not inherit product A quota confirmation')
  const writesBeforeProductRestore = writes.length
  await page.evaluate(() => window.mountProduct('product-a'))
  await page.getByText('dsh-image-gen 可用', { exact: false }).waitFor()
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), true, 'Returning to product A restores only its saved confirmation')
  assert.equal(writes.length, writesBeforeProductRestore, 'Restoring another product confirmation does not auto-generate')
  await page.evaluate(() => window.mountProduct('product-b'))
  await page.getByText('dsh-image-gen 可用', { exact: false }).waitFor()
  assert.equal(await page.locator('[name="image-confirm"]').isChecked(), false, 'Returning to product B keeps its unconfirmed state')
  unavailable = true
  await page.locator('[data-image-action="refresh"]').click()
  await page.getByText('图片插件尚未连接', { exact: false }).waitFor()
  assert.equal(await page.locator('[data-image-action="generate"]').isDisabled(), true)
  unavailableReason = 'image_native_executor_required'
  await page.locator('[data-image-action="refresh"]').click()
  await page.getByText('请切换为 DSH 原生工具执行器', { exact: false }).waitFor()
  unavailableReason = 'image_provider_tools_incompatible'
  await page.locator('[data-image-action="refresh"]').click()
  await page.getByText('未检测到兼容的 dsh-image-gen', { exact: false }).waitFor()
  assert.deepEqual(externalRequests, [])
  assert.deepEqual(errors, [])
  console.log('PASS product images browser: persistent per-product quota opt-in and revocation without auto-generation, safe prompt rendering, preserved draft and image DOM/no repeated no-store downloads, generation/edit reference, import, generated/generated, imported/imported and mixed-source 2–4-image comparison with versioned previews, removal/refresh/zoom/checkerboard without generation, v2 metadata and technical-check actions, running/unknown state, no retry, HTTP 403 and HTTP 200 failed classification, select/unselect, download, Chinese plugin guidance and product isolation. No real model calls; manual product acceptance not exercised.')
} finally {
  delayedGeneration?.()
  await browser?.close()
  if (server.listening) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
}
