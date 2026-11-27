import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import sharp from 'sharp'
import { createProductImageV2Store } from '../src/host/product-images-v2.mjs'

const tempRoot = mkdtempSync(join(tmpdir(), 'product-images-v2-'))
const workspace = join(tempRoot, 'workspace')
const outside = join(tempRoot, 'outside')
mkdirSync(workspace); mkdirSync(outside)
const digest = value => createHash('sha256').update(value).digest('hex')
const v1Root = join(workspace, '.dsh-workbench', 'product-images', digest('product-a').slice(0, 32))
const v1Selection = Buffer.from(JSON.stringify({ schemaVersion: 1, productId: 'product-a', ids: [] }) + '\n')
const transparentPng = await sharp({ create: { width: 6, height: 4, channels: 4, background: { r: 35, g: 90, b: 150, alpha: 0.5 } } }).png().toBuffer()
const opaquePng = await sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 10, g: 120, b: 40 } } }).png().toBuffer()
const empty = () => ({ jobs: 0, count: 0, bytes: 0 })
const store = createProductImageV2Store({ workspaceRoot: workspace, productId: 'product-a' })
const importImage = (requestId, extra = {}) => store.importBytes({ requestId, fileName: 'C:\\user\\forest icon.png', mime: 'image/png', data: transparentPng, ...extra })

try {
  assert.deepEqual(store.state(), { candidates: [], operations: [], warnings: [], usage: { jobs: 0, count: 0, bytes: 0 } })
  assert.equal(existsSync(join(workspace, '.dsh-workbench')), false, 'read-only v2 state creates no folders')
  assert.equal(store.state().candidates.length, 0)
  await assert.rejects(store.image({ candidateId: 'a'.repeat(32) }), /image_v2_not_found/)
  assert.equal(existsSync(join(workspace, '.dsh-workbench')), false, 'missing-image read creates no folders')

  mkdirSync(v1Root, { recursive: true })
  writeFileSync(join(v1Root, 'selection.json'), v1Selection)
  const requestId = randomUUID()
  const result = await importImage(requestId)
  assert.equal(result.operation.status, 'succeeded')
  assert.equal(result.operation.kind, 'import')
  assert.equal(result.candidate.formatVersion, 2)
  assert.equal(result.candidate.mode, 'import')
  assert.equal(result.candidate.prompt, 'forest icon.png')
  assert.equal(result.candidate.source.kind, 'local-import')
  assert.equal(result.candidate.source.inputSha256, digest(transparentPng))
  assert.equal(result.candidate.sha256, digest(transparentPng))
  assert.equal(result.candidate.width, 6)
  assert.equal(result.candidate.height, 4)
  assert.deepEqual(readFileSync(join(store.root, 'candidates', result.candidate.id, 'original.png')), transparentPng)
  assert.deepEqual(readFileSync(join(v1Root, 'selection.json')), v1Selection, 'v1 selection bytes are not changed by v2 import')
  assert.deepEqual(readdirSync(store.root).sort(), ['candidates', 'metadata', 'operations'])

  const duplicate = await importImage(requestId)
  assert.equal(duplicate.candidate.id, result.candidate.id, 'same request ID and frozen input replays the same candidate')
  await assert.rejects(importImage(requestId, { data: opaquePng }), /image_v2_request_conflict/)
  const duplicateBytes = await store.importBytes({ requestId: randomUUID(), fileName: 'other-name.png', mime: 'image/png', data: transparentPng })
  assert.notEqual(duplicateBytes.candidate.id, result.candidate.id, 'same bytes from a different operation preserve distinct provenance')
  assert.equal(duplicateBytes.candidate.sha256, result.candidate.sha256)

  const image = await store.image({ candidateId: result.candidate.id })
  assert.equal(image.mime, 'image/png')
  assert.deepEqual(image.data, transparentPng)
  assert.equal(image.candidate.id, result.candidate.id)

  const check = await store.check({ candidateId: result.candidate.id })
  assert.equal(check.status, 'pass')
  assert.equal(check.sha256, digest(transparentPng))
  assert.equal(check.hasAlpha, true)
  assert.equal(check.hasTransparentPixels, true)
  assert.equal(check.visualStatus, 'not-evaluated')
  const metadata = await store.updateMetadata({ candidateId: result.candidate.id, tags: ['角色', '透明背景'], notes: '可用于界面试排' })
  assert.deepEqual(metadata.tags, ['角色', '透明背景'])
  assert.equal(metadata.checks[0].sha256, check.sha256, 'metadata retains hash-bound technical check')
  assert.equal(store.state().candidates.find(candidate => candidate.id === result.candidate.id).metadata.notes, '可用于界面试排')
  const fiftyTags = Array.from({ length: 50 }, (_, index) => `tag-${index + 1}`)
  assert.deepEqual((await store.updateMetadata({ candidateId: result.candidate.id, tags: fiftyTags })).tags, fiftyTags, 'the configured maximum of 50 tags is accepted')
  await assert.rejects(store.updateMetadata({ candidateId: result.candidate.id, tags: [...fiftyTags, 'tag-51'] }), /image_v2_metadata_invalid/)
  await store.updateMetadata({ candidateId: result.candidate.id, tags: ['角色', '透明背景'], notes: '可用于界面试排' })
  assert.equal(store.state().candidates.find(candidate => candidate.id === result.candidate.id).metadata.checks[0].sha256, check.sha256,
    'tag and note updates preserve the hash-bound technical check')

  const selected = await store.select({ candidateId: result.candidate.id, selected: true })
  assert.deepEqual(selected, { candidateId: result.candidate.id, formatVersion: 2, selected: true })
  assert.deepEqual(JSON.parse(readFileSync(join(store.root, 'selection.json'), 'utf8')).ids, [result.candidate.id])
  assert.deepEqual(readFileSync(join(v1Root, 'selection.json')), v1Selection, 'v2 selection never touches v1 selection.json')
  await store.select({ candidateId: result.candidate.id, selected: false })

  const opaque = await store.importBytes({ requestId: randomUUID(), fileName: 'opaque.png', mime: 'image/png', data: opaquePng })
  const opaqueCheck = await store.check({ candidateId: opaque.candidate.id })
  assert.equal(opaqueCheck.hasAlpha, false)
  assert.equal(opaqueCheck.hasTransparentPixels, false)
  const jpeg = await sharp(opaquePng).jpeg().toBuffer()
  const webp = await sharp(opaquePng).webp().toBuffer()
  for (const [fileName, mime, data] of [['photo.jpg', 'image/jpeg', jpeg], ['photo.webp', 'image/webp', webp]]) {
    const imported = await store.importBytes({ requestId: randomUUID(), fileName, mime, data })
    assert.equal(imported.candidate.mime, mime)
    assert.equal(imported.candidate.sha256, digest(data))
    assert.deepEqual((await store.image({ candidateId: imported.candidate.id })).data, data, `${mime} import preserves exact source bytes`)
  }

  const otherProduct = createProductImageV2Store({ workspaceRoot: workspace, productId: 'product-b' })
  assert.deepEqual(otherProduct.state().candidates, [])
  await assert.rejects(otherProduct.image({ candidateId: result.candidate.id }), /image_v2_not_found/)

  await assert.rejects(store.importBytes({ requestId: randomUUID(), fileName: 'fake.png', mime: 'image/png', data: Buffer.from('not an image') }), /image_v2_image_invalid/)
  await assert.rejects(store.importBytes({ requestId: randomUUID(), fileName: 'fake.jpg', mime: 'image/jpeg', data: transparentPng }), /image_v2_image_invalid/)
  await assert.rejects(store.importBytes({ requestId: randomUUID(), fileName: '../', mime: 'image/png', data: transparentPng }), /image_v2_file_name_invalid/)
  await assert.rejects(store.importBytes({ requestId: randomUUID(), fileName: 'image.png', mime: 'image/svg+xml', data: transparentPng }), /image_v2_input_invalid/)
  const cancelled = AbortSignal.abort()
  await assert.rejects(store.importBytes({ requestId: randomUUID(), fileName: 'cancel.png', mime: 'image/png', data: transparentPng, signal: cancelled }), /image_v2_operation_cancelled/)

  const quotaWorkspace = join(tempRoot, 'quota'); mkdirSync(quotaWorkspace)
  const quotaStore = createProductImageV2Store({ workspaceRoot: quotaWorkspace, productId: 'quota-product', externalUsage: () => ({ jobs: 200, count: 0, bytes: 0 }) })
  await assert.rejects(quotaStore.importBytes({ requestId: randomUUID(), fileName: 'quota.png', mime: 'image/png', data: opaquePng }), /image_v2_storage_limit/)
  assert.equal(existsSync(join(quotaWorkspace, '.dsh-workbench')), false, 'quota failure occurs before creating product storage')

  const interruptedId = randomUUID()
  const interruptedInput = { fileName: 'crash.png', sha256: digest(opaquePng), mime: 'image/png', bytes: opaquePng.length }
  const operation = { schemaVersion: 2, id: interruptedId, productId: 'product-a', kind: 'import', status: 'running', createdAt: new Date().toISOString(),
    input: interruptedInput, requestHash: digest(Buffer.from(JSON.stringify(interruptedInput) + '\n')), outputs: [] }
  writeFileSync(join(store.root, 'operations', interruptedId + '.json'), JSON.stringify(operation) + '\n')
  const interruptedState = store.state()
  assert.equal(interruptedState.operations.find(item => item.id === interruptedId).status, 'unknown')
  assert(interruptedState.warnings.includes('image_v2_import_interrupted_unknown'))
  const replayUnknown = await store.importBytes({ requestId: interruptedId, fileName: 'crash.png', mime: 'image/png', data: opaquePng })
  assert.equal(replayUnknown.operation.status, 'unknown', 'interrupted import is never silently re-executed')

  const pendingId = randomUUID()
  const pendingFolder = join(store.root, 'candidates', '.pending-' + pendingId)
  mkdirSync(pendingFolder)
  writeFileSync(join(pendingFolder, 'original.png'), opaquePng)
  const pendingState = store.state()
  assert(pendingState.warnings.includes('image_v2_storage_interrupted'))
  await assert.rejects(store.importBytes({ requestId: randomUUID(), fileName: 'blocked.png', mime: 'image/png', data: opaquePng }), /image_v2_storage_interrupted/)

  const hardlink = join(store.root, 'candidates', result.candidate.id, 'hardlink.png')
  linkSync(join(store.root, 'candidates', result.candidate.id, 'original.png'), hardlink)
  await assert.rejects(store.image({ candidateId: result.candidate.id }), /image_v2_storage_unsafe|image_v2_integrity_invalid/)
  unlinkSync(hardlink)
  const originalPath = join(store.root, 'candidates', result.candidate.id, 'original.png')
  const corrupted = Buffer.from(transparentPng); corrupted[0] ^= 0xff
  writeFileSync(originalPath, corrupted)
  await assert.rejects(store.image({ candidateId: result.candidate.id }), /image_v2_image_invalid|image_v2_integrity_invalid/)
  writeFileSync(originalPath, transparentPng)
  const manifestPath = join(store.root, 'candidates', result.candidate.id, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.file.width += 1
  writeFileSync(manifestPath, JSON.stringify(manifest) + '\n')
  assert.throws(() => store.state(), /image_v2_integrity_invalid/)

  const unsafeWorkspace = join(tempRoot, 'unsafe'); mkdirSync(unsafeWorkspace)
  symlinkSync(outside, join(unsafeWorkspace, '.dsh-workbench'), 'junction')
  const unsafeStore = createProductImageV2Store({ workspaceRoot: unsafeWorkspace, productId: 'unsafe' })
  assert.throws(() => unsafeStore.state(), /image_v2_storage_unsafe/)
  assert.deepEqual(readdirSync(outside), [], 'symlink target is never written')

  console.log('PASS product images v2: no-create reads, immutable isolated imports, request idempotency, provenance, dual-version selection isolation, exact-byte export, hash-bound metadata/checks, alpha versus transparency, quota preflight, unknown/pending recovery fences, symlink/hardlink/tamper and input rejection.')
} finally {
  const resolved = resolve(tempRoot), parent = resolve(tmpdir())
  if (relative(parent, resolved).startsWith('..') || resolved === parent || !resolved.startsWith(parent + '\\')) throw new Error('unsafe_test_cleanup')
  rmSync(resolved, { recursive: true, force: true })
}
