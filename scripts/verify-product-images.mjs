import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import sharp from 'sharp'
import { createProductImageService } from '../src/host/product-images.mjs'

const root = mkdtempSync(join(tmpdir(), 'product-images-'))
const workspace = join(root, 'workspace')
const outside = join(root, 'outside')
mkdirSync(workspace)
mkdirSync(outside)
const products = () => [{ id: 'product-a', workspacePath: workspace }, { id: 'product-b', workspacePath: workspace }]
const digest = value => createHash('sha256').update(value).digest('hex')
const productRoot = id => join(workspace, '.dsh-workbench', 'product-images', digest(id).slice(0, 32))
const fixture = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#ae57cc88' } }).png().toBuffer()
const edited = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#29bb22ff' } }).png().toBuffer()
const calls = []
const allowed = []
let implementation = async input => { calls.push(input); return { attachment: { id: 'fake' }, provider: 'fixture', model: 'fixture-model', data: fixture } }
const service = createProductImageService({ products, generate: input => implementation(input), readImage: async result => ({ data: result.data, mime: 'image/png' }), authorize: name => allowed.push(name) })
const request = extra => ({ productId: 'product-a', requestId: randomUUID(), prompt: '紫色角色图', mode: 'generate', confirmed: true, ...extra })

try {
  assert.deepEqual(await service.state({ productId: 'product-a' }), { candidates: [], jobs: [], operations: [], warnings: [] })
  assert.equal(existsSync(join(workspace, '.dsh-workbench')), false, 'read-only state does not create product folders')
  await assert.rejects(service.generate(request({ confirmed: false })), /image_generation_confirmation_required/)
  await assert.rejects(service.generate(request({ requestId: '../escape' })), /image_request_id_invalid/)
  await assert.rejects(service.generate(request({ mode: 'edit', referenceId: '../escape' })), /image_reference_invalid/)
  await assert.rejects(service.generate(request({ productId: 'not-registered' })), /product_workspace_unavailable/)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(service.generate(request({ signal: aborted.signal })), /image_operation_cancelled/)
  assert.equal(calls.length, 0)

  const trustedExecution = { agent: { session: { header: { id: 'fixture-session' } } }, credentialSentinel: 'never-persist-execution' }
  const initialRequest = request({ execution: trustedExecution })
  const initial = await service.generate(initialRequest)
  assert.equal(initial.job.status, 'succeeded')
  assert.equal(initial.candidate.selected, false)
  assert.equal(initial.candidate.width, 8)
  assert.equal(initial.candidate.height, 6)
  assert.equal(initial.candidate.sha256, digest(fixture))
  assert.equal(initial.candidate.bytes, fixture.length)
  assert.equal(initial.candidate.provider, 'fixture')
  assert.equal(initial.candidate.model, 'fixture-model')
  assert.equal(calls[0].workspaceRoot, realpathSync(workspace))
  assert.equal(calls[0].execution, trustedExecution, 'trusted execution passes only to the runtime adapter')
  const candidatePath = join(productRoot('product-a'), 'candidates', initial.candidate.id)
  const originalManifest = readFileSync(join(candidatePath, 'manifest.json'))
  assert(!originalManifest.toString('utf8').includes('never-persist-execution'))
  assert(!readFileSync(join(productRoot('product-a'), 'jobs', initialRequest.requestId + '.json'), 'utf8').includes('never-persist-execution'))
  assert.deepEqual(readFileSync(join(candidatePath, 'original.png')), fixture)
  assert.deepEqual((await service.image({ productId: 'product-a', candidateId: initial.candidate.id })).data, fixture)
  assert.equal((await service.generate(initialRequest)).candidate.id, initial.candidate.id)
  assert.equal(calls.length, 1, 'same request ID never regenerates')
  await assert.rejects(service.generate({ ...initialRequest, prompt: 'changed' }), /image_request_conflict/)

  await service.select({ productId: 'product-a', candidateId: initial.candidate.id, selected: true })
  assert.equal((await service.state({ productId: 'product-a' })).candidates[0].selected, true)
  await service.select({ productId: 'product-a', candidateId: initial.candidate.id, selected: false })
  assert.equal((await service.state({ productId: 'product-a' })).candidates[0].selected, false)
  assert.deepEqual(readFileSync(join(candidatePath, 'manifest.json')), originalManifest, 'selection does not mutate candidate manifests')
  assert.deepEqual((await service.state({ productId: 'product-b' })).candidates, [])
  await assert.rejects(service.image({ productId: 'product-b', candidateId: initial.candidate.id }), /image_not_found/)
  await assert.rejects(service.select({ productId: 'product-a', candidateId: initial.candidate.id, selected: 'true' }), /image_selection_invalid/)

  implementation = async input => {
    calls.push(input)
    assert.equal(input.mode, 'edit')
    assert.deepEqual(readFileSync(input.referencePath), fixture)
    assert(input.referencePath.startsWith(realpathSync(workspace)))
    return { data: edited, provider: 'fixture', model: 'edit-model' }
  }
  const edit = await service.generate(request({ mode: 'edit', referenceId: initial.candidate.id, prompt: '改成绿色' }))
  assert.equal(edit.job.status, 'succeeded')
  assert.equal(edit.candidate.sourceCandidateId, initial.candidate.id)
  assert.equal(edit.candidate.sha256, digest(edited))
  assert.deepEqual(readFileSync(join(candidatePath, 'original.png')), fixture, 'editing preserves the source candidate')

  let release
  implementation = async input => { calls.push(input); return await new Promise(resolve => { release = resolve }) }
  const inFlightRequest = request()
  const inFlight = service.generate(inFlightRequest)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  const stateWhileRunning = await service.state({ productId: 'product-a' })
  assert.equal(stateWhileRunning.jobs.find(job => job.id === inFlightRequest.requestId).status, 'running')
  assert.equal((await service.generate(inFlightRequest)).job.status, 'running', 'duplicate running request observes the same job')
  await assert.rejects(service.generate(request()), /image_generation_busy/)
  const otherInstance = createProductImageService({ products, generate: input => implementation(input), readImage: async result => ({ data: result.data, mime: 'image/png' }) })
  await assert.rejects(otherInstance.generate(request()), /image_generation_busy/, 'service instances share product concurrency fencing')
  release({ data: fixture })
  assert.equal((await inFlight).job.status, 'succeeded')

  const cancel = new AbortController()
  let releaseIgnoredCancel
  implementation = async input => { calls.push(input); return await new Promise(resolve => { releaseIgnoredCancel = resolve }) }
  const cancelledRequest = request({ signal: cancel.signal })
  const cancelled = service.generate(cancelledRequest)
  while (!releaseIgnoredCancel) await new Promise(resolve => setImmediate(resolve))
  cancel.abort()
  assert.equal((await cancelled).job.status, 'unknown', 'local cancellation does not claim remote cancellation')
  const callsAfterCancel = calls.length
  assert.equal((await service.generate({ ...cancelledRequest, signal: undefined })).job.status, 'unknown')
  assert.equal(calls.length, callsAfterCancel, 'unknown job cannot be replayed')
  await assert.rejects(service.generate(request()), /image_generation_busy/, 'an ignored cancellation retains the product fence until the original call settles')
  const candidatesBeforeLateResult = (await service.state({ productId: 'product-a' })).candidates.length
  releaseIgnoredCancel({ data: fixture, provider: 'fixture', model: 'late-result' })
  await new Promise(resolve => setImmediate(resolve))
  const afterLateResult = await service.state({ productId: 'product-a' })
  assert.equal(afterLateResult.jobs.find(job => job.id === cancelledRequest.requestId).status, 'unknown')
  assert.equal(afterLateResult.candidates.length, candidatesBeforeLateResult, 'a late success is never archived after the local result was unknown')

  const staleId = randomUUID()
  const staleRequest = { mode: 'generate', prompt: 'stale prompt' }
  writeFileSync(join(productRoot('product-a'), 'jobs', staleId + '.json'), JSON.stringify({ schemaVersion: 1, id: staleId, productId: 'product-a', createdAt: new Date().toISOString(), request: staleRequest, requestHash: digest(JSON.stringify(staleRequest) + '\n'), status: 'running' }))
  assert.equal((await service.state({ productId: 'product-a' })).jobs.find(job => job.id === staleId).status, 'unknown', 'interrupted persisted intent is not reported running forever')
  assert.equal((await service.generate({ ...request(), requestId: staleId, prompt: 'stale prompt' })).job.status, 'unknown')

  implementation = async () => { throw new Error('SECRET_KEY_DO_NOT_PERSIST https://provider.invalid/key') }
  const failed = await service.generate(request())
  assert.equal(failed.job.status, 'unknown')
  assert.equal(failed.job.error, 'image_generation_result_unknown')
  assert(!readFileSync(join(productRoot('product-a'), 'jobs', failed.job.id + '.json'), 'utf8').includes('SECRET_KEY'))
  implementation = async () => ({ data: Buffer.from('not an image') })
  assert.equal((await service.generate(request())).job.status, 'unknown', 'invalid output is recorded after a possibly billable dispatch')

  const unsafeProduct = join(root, 'unsafe-product')
  mkdirSync(unsafeProduct)
  symlinkSync(outside, join(unsafeProduct, '.dsh-workbench'), 'junction')
  const unsafeService = createProductImageService({ products: () => [{ id: 'unsafe', workspacePath: unsafeProduct }], generate: async () => ({ data: fixture }), readImage: async result => ({ data: result.data, mime: 'image/png' }) })
  await assert.rejects(unsafeService.state({ productId: 'unsafe' }), /image_storage_unsafe/)
  await assert.rejects(unsafeService.generate(request({ productId: 'unsafe' })), /image_storage_unsafe/)
  assert.deepEqual(readdirSync(outside), [])

  const hardLink = join(candidatePath, 'hardlink.png')
  linkSync(join(candidatePath, 'original.png'), hardLink)
  await assert.rejects(service.image({ productId: 'product-a', candidateId: initial.candidate.id }), /image_integrity_invalid|image_storage_unsafe/)
  unlinkSync(hardLink)
  const sameLengthCorruption = Buffer.from(fixture)
  sameLengthCorruption[Math.floor(sameLengthCorruption.length / 2)] ^= 0xff
  writeFileSync(join(candidatePath, 'original.png'), sameLengthCorruption)
  assert((await service.state({ productId: 'product-a' })).candidates.some(candidate => candidate.id === initial.candidate.id), 'state uses verified manifest and file stat, without repeatedly decoding every original')
  await assert.rejects(service.image({ productId: 'product-a', candidateId: initial.candidate.id }), /image_output_invalid|image_integrity_invalid/)
  writeFileSync(join(candidatePath, 'original.png'), edited)
  await assert.rejects(service.image({ productId: 'product-a', candidateId: initial.candidate.id }), /image_integrity_invalid/)
  await assert.rejects(service.select({ productId: 'product-a', candidateId: initial.candidate.id, selected: true }), /image_integrity_invalid/)
  writeFileSync(join(candidatePath, 'original.png'), fixture)
  const altered = JSON.parse(originalManifest.toString('utf8'))
  altered.prompt = 'modified metadata'
  writeFileSync(join(candidatePath, 'manifest.json'), JSON.stringify(altered))
  await assert.rejects(service.image({ productId: 'product-a', candidateId: initial.candidate.id }), /image_integrity_invalid/)
  assert(allowed.includes('workbench_image_generate') && allowed.includes('workbench_image_select') && allowed.includes('workbench_image_list'))

  const previewWorkspace = join(root, 'preview-cache-workspace'); mkdirSync(previewWorkspace)
  const previewService = createProductImageService({ products: () => [{ id: 'preview-product', workspacePath: previewWorkspace }],
    generate: async () => ({ data: fixture }), readImage: async result => ({ data: result.data, mime: 'image/png' }) })
  let firstPreviewCandidate
  for (let index = 0; index < 65; index++) {
    const imported = await previewService.importImage({ productId: 'preview-product', requestId: randomUUID(), fileName: `preview-${index}.png`, mime: 'image/png', data: fixture })
    if (index === 0) firstPreviewCandidate = imported.candidate
    const preview = await previewService.preview({ productId: 'preview-product', candidateId: imported.candidate.id, formatVersion: 2 })
    assert.equal(preview.mime, 'image/webp')
    const previewInfo = await sharp(preview.data).metadata()
    assert(previewInfo.width <= 1024 && previewInfo.height <= 1024)
  }
  const cacheUsage = previewService.previewCacheUsage()
  assert.equal(cacheUsage.entries, 64, 'preview LRU retains at most 64 candidate derivatives')
  assert(cacheUsage.bytes > 0 && cacheUsage.bytes <= 32 * 1024 * 1024, 'preview cache stays within its 32 MiB budget')
  await previewService.preview({ productId: 'preview-product', candidateId: firstPreviewCandidate.id, formatVersion: 2 })
  assert.equal(previewService.previewCacheUsage().entries, 64, 'cache misses evict the least-recently-used derivative')
  const firstOriginalPath = join(previewWorkspace, '.dsh-workbench', 'product-images-v2', digest('preview-product').slice(0, 32), 'candidates', firstPreviewCandidate.id, 'original.png')
  assert.deepEqual(readFileSync(firstOriginalPath), fixture, 'preview rendering never changes source candidate bytes')
  console.log('PASS product images: original bytes, verified candidate manifests, generation/editing, product isolation, selection/export, durable request deduplication, concurrency, cancellation/interruption unknown states, error redaction, link/tamper rejection, and bounded image previews')
} finally {
  if (dirname(realpathSync(root)) !== realpathSync(tmpdir()) || !basename(root).startsWith('product-images-')) throw new Error('unsafe_test_cleanup')
  rmSync(root, { recursive: true, force: true })
}
