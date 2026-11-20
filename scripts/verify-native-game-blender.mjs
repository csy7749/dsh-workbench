/** Real installed Blender when available; lifecycle/GLB counterexamples below are explicit fixtures. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createNativeGameAssets } from '../src/host/native-game-assets.mjs'
import { createNativeGameBlender, nativeGameBlenderInternals as internals } from '../src/host/native-game-blender.mjs'

const root = mkdtempSync(join(tmpdir(), 'native-game-blender-'))
const digest = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const studio = createNativeGameStudio(), assets = createNativeGameAssets({ studio })
const service = createNativeGameBlender({ studio, assets })
const target = { workspaceRoot: root, productId: 'blender-acceptance', slug: 'geometry' }

function fixtureGlb(mutator = () => {}, editBinary = () => {}) {
  const binary = Buffer.alloc(72)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((n, i) => binary.writeFloatLE(n, i * 4))
  ;[0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3].forEach((n, i) => binary.writeUInt16LE(n, 48 + i * 2))
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 72 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 24 }], accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 }
  mutator(doc); editBinary(binary)
  let text = Buffer.from(JSON.stringify(doc)); text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)])
  const data = Buffer.alloc(12 + 8 + text.length + 8 + binary.length)
  data.write('glTF'); data.writeUInt32LE(2, 4); data.writeUInt32LE(data.length, 8)
  data.writeUInt32LE(text.length, 12); data.writeUInt32LE(0x4E4F534A, 16); text.copy(data, 20)
  data.writeUInt32LE(binary.length, 20 + text.length); data.writeUInt32LE(0x004E4942, 24 + text.length); binary.copy(data, 28 + text.length)
  return data
}

function fixturePng() {
  function crc(data) { let value = 0xffffffff; for (const b of data) { value ^= b; for (let i = 0; i < 8; i++) value = value >>> 1 ^ ((value & 1) ? 0xedb88320 : 0) } return (value ^ 0xffffffff) >>> 0 }
  function chunk(name, value) { const type = Buffer.from(name), result = Buffer.alloc(value.length + 12); result.writeUInt32BE(value.length); type.copy(result, 4); value.copy(result, 8); result.writeUInt32BE(crc(Buffer.concat([type, value])), result.length - 4); return result }
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(128 * (128 * 4 + 1)))), chunk('IEND', Buffer.alloc(0))])
}

try {
  const worker = readFileSync(fileURLToPath(new URL('../src/host/native-game-blender-worker.py', import.meta.url)), 'utf8')
  assert.equal(internals.workerSource, worker, 'Bundled embedded worker must exactly match reviewable Python source')
  assert.deepEqual(internals.validateRecipe({ primitive: 'pickup' }), { primitive: 'pickup', color: '#E8B34B', size: 1 })
  for (const recipe of [undefined, {}, { primitive: 'script' }, { primitive: 'crate', size: NaN }, { primitive: 'crate', size: 9 }, { primitive: 'crate', color: 'red' }, { primitive: 'crate', python: 'print(1)' }]) assert.throws(() => internals.validateRecipe(recipe), /recipe_invalid/)
  assert.throws(() => createNativeGameBlender({ timeoutMs: 1 }), /timeout_invalid/)
  const missing = createNativeGameBlender({ studio, assets, executable: join(root, 'not-installed-blender.exe') })
  assert.equal((await missing.probe()).available, false)
  assert.equal((await missing.probe()).reason, 'game_blender_unavailable')
  await assert.rejects(missing.generate({ recipe: { primitive: 'crate', script: 'bad' } }), /recipe_invalid/)
  const preCancelled = new AbortController(); preCancelled.abort()
  await assert.rejects(service.generate({ recipe: { primitive: 'crate' }, signal: preCancelled.signal }), /game_operation_cancelled/)
  assert.equal(internals.validateGlb(fixtureGlb()).triangleCount, 4)
  for (const data of [Buffer.alloc(12), fixtureGlb(doc => { doc.buffers[0].uri = 'file:///secret' }), fixtureGlb(doc => { doc.nodes[0].children = [0] }), fixtureGlb(doc => { doc.bufferViews[0].byteLength = 4 }), fixtureGlb(() => {}, bytes => bytes.writeFloatLE(NaN, 0)), fixtureGlb(() => {}, bytes => bytes.writeUInt16LE(77, 48)), fixtureGlb(doc => { doc.meshes[0].primitives[0].mode = 1 })]) assert.throws(() => internals.validateGlb(data), /game_blender_glb_/)
  const lengthTamper = fixtureGlb(); lengthTamper.writeUInt32LE(lengthTamper.length + 4, 8); assert.throws(() => internals.validateGlb(lengthTamper), /glb_invalid/)

  // Explicit synthetic fixtures prove validator/lifecycle refusal, never a Blender render.
  const fixture = join(root, 'validator-fixture'); mkdirSync(fixture); mkdirSync(join(fixture, 'output'))
  const job = { schemaVersion: 1, workerVersion: 1, jobId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', projectId: 'fixture-project', productId: 'fixture-product', slug: 'fixture', recipe: internals.validateRecipe({ primitive: 'crate' }) }, jobText = json(job)
  const fixtureValues = { 'asset.glb': fixtureGlb(), 'preview.png': fixturePng(), 'scene.blend': Buffer.from('BLENDER-v530fixture-only-not-a-real-blend') }
  const fixtureReport = { ...job, status: 'completed', jobHash: digest(jobText), blenderVersion: '5.3.0 fixture', renderEngine: 'CYCLES', triangleCount: 4, dimensionsMetres: [1, 1, 1], files: Object.fromEntries(Object.entries(fixtureValues).map(([name, bytes]) => [name, { bytes: bytes.length, hash: digest(bytes) }])) }
  for (const [name, value] of Object.entries(fixtureValues)) writeFileSync(join(fixture, 'output', name), value)
  const fixtureReportPath = join(fixture, 'output/report.json')
  writeFileSync(fixtureReportPath, json(fixtureReport)); assert.equal(internals.validateOutputs(fixture, job, jobText).geometry.triangleCount, 4)
  writeFileSync(fixtureReportPath, json({ ...fixtureReport, jobId: 'wrong' })); assert.throws(() => internals.validateOutputs(fixture, job, jobText), /report_invalid/)
  writeFileSync(fixtureReportPath, json(fixtureReport)); writeFileSync(join(fixture, 'output/asset.glb'), Buffer.concat([fixtureValues['asset.glb'], Buffer.from('tampered')]))
  assert.throws(() => internals.validateOutputs(fixture, job, jobText), /output_hash_invalid/)
  const processResult = await internals.runProcess(process.execPath, ['-e', 'process.stdout.write("fixture-ok")'], { timeoutMs: 5000 })
  assert.equal(processResult.stdout, 'fixture-ok')
  await assert.rejects(internals.runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 200 }), /game_blender_timeout/)
  const cancel = new AbortController(), timer = setTimeout(() => cancel.abort(), 200)
  try { await assert.rejects(internals.runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 5000, signal: cancel.signal }), /game_operation_cancelled/) } finally { clearTimeout(timer) }
  await assert.rejects(internals.runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(70000))'], { timeoutMs: 5000 }), /game_blender_output_limit/)
  await assert.rejects(internals.runProcess(join(root, 'missing.exe'), [], { timeoutMs: 1000 }), /game_blender_process_unavailable/)
  const quotaFixture = join(root, 'quota-fixture'); mkdirSync(quotaFixture)
  for (let i = 0; i < 32; i++) mkdirSync(join(quotaFixture, 'aaaaaaaa-aaaa-4aaa-aaaa-' + String(i).padStart(12, '0')))
  assert.throws(() => internals.jobQuota(quotaFixture), /game_blender_job_limit/)

  const created = studio.create({ ...target, title: 'Blender real primitive acceptance', rules: { durationSeconds: 3, hearts: 3 } })
  await assert.rejects(missing.generate({ ...target, recipe: { primitive: 'crate' } }), /game_blender_unavailable/)
  assert.equal(assets.list(target).length, 0, 'Unavailable providers must never fabricate candidates')
  const capability = await service.probe()
  if (!capability.available) {
    assert.notEqual(process.env.DSH_GAME_BLENDER_REQUIRED, '1', JSON.stringify(capability))
    console.log('PASS Blender safety fixtures; real Blender generation NOT ASSESSED:', JSON.stringify(capability))
  } else {
    const receipts = []
    for (const primitive of ['crate', 'pickup']) {
      let candidate
      try { candidate = await service.generate({ ...target, buildId: created.buildId, recipe: { primitive, size: 1, color: '#E8B34B' } }) }
      catch (error) {
        const jobs = join(root, created.project, '.studio/blender-jobs')
        for (const id of readdirSync(jobs).filter(name => /^[a-f0-9-]{36}$/.test(name))) {
          const blend = readFileSync(join(jobs, id, 'output/scene.blend'))
          console.error('Actual .blend header diagnostic:', blend.subarray(0, 32).toString('hex'), JSON.stringify(blend.subarray(0, 24).toString('ascii')))
        }
        throw error
      }
      assert.equal(candidate.provider, 'blender'); assert.equal(candidate.nativeFilesVerified, true); assert.equal(candidate.status, 'candidate')
      assert(candidate.geometry.triangleCount > 0)
      const read = assets.read({ ...target, assetId: candidate.assetId })
      assert.equal(read.manifest.files.length, 5)
      for (const file of candidate.files) { const bytes = readFileSync(join(root, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.hash) }
      const jobFolder = join(root, created.project, '.studio/blender-jobs', candidate.jobId)
      assert.equal(JSON.parse(readFileSync(join(jobFolder, 'journal.json'), 'utf8')).state, 'completed')
      assert(!readdirSync(dirname(jobFolder)).includes('execution.lock'))
      const jobBytes = readFileSync(join(jobFolder, 'job.json'))
      internals.validateOutputs(jobFolder, JSON.parse(jobBytes), jobBytes)
      // Reopen the actual saved .blend and import the actual GLB in installed Blender.
      const verifyScript = join(root, 'verify-reopen.py')
      writeFileSync(verifyScript, 'import bpy,sys\nfrom pathlib import Path\np=Path(sys.argv[sys.argv.index("--")+1])\nassert bpy.context.scene.render.resolution_x == 128\nassert any(o.type=="MESH" for o in bpy.context.scene.objects)\nbpy.ops.wm.read_factory_settings(use_empty=True)\nassert bpy.ops.import_scene.gltf(filepath=str(p))=={"FINISHED"}\nassert any(o.type=="MESH" for o in bpy.context.scene.objects)\nprint("DSH_REAL_BLEND_REOPEN_AND_GLB_IMPORT_OK")\n')
      const executable = capability.executable
      const verified = await internals.runProcess(executable, ['--background', '--disable-autoexec', '--python-exit-code', '1', join(jobFolder, 'output/scene.blend'), '--python', verifyScript, '--', join(jobFolder, 'output/asset.glb')], { timeoutMs: 60000 })
      assert.match(verified.stdout, /DSH_REAL_BLEND_REOPEN_AND_GLB_IMPORT_OK/)
      receipts.push({ primitive, assetId: candidate.assetId, jobId: candidate.jobId, blenderVersion: candidate.blenderVersion, pngBytes: candidate.bytes, pngHash: candidate.hash, triangles: candidate.geometry.triangleCount, nativeFiles: candidate.files.map(({ name, bytes, hash }) => ({ name, bytes, hash })) })
    }
    assert.equal(assets.list(target).length, 2)
    const jobParent = join(root, created.project, '.studio/blender-jobs')
    const priorJobs = new Set(readdirSync(jobParent))
    const cancelling = new AbortController()
    const cancellationWatch = setInterval(() => {
      if (readdirSync(jobParent).some(name => !priorJobs.has(name) && /^[a-f0-9-]{36}$/.test(name) && existsSync(join(jobParent, name, 'journal.json')))) cancelling.abort()
    }, 10)
    const cancellationFallback = setTimeout(() => cancelling.abort(), 10000)
    try {
      const pending = service.generate({ ...target, recipe: { primitive: 'crate' }, signal: cancelling.signal })
      await assert.rejects(service.generate({ ...target, recipe: { primitive: 'crate' } }), /game_blender_busy/)
      await assert.rejects(pending, /game_operation_cancelled/)
    } finally { clearInterval(cancellationWatch); clearTimeout(cancellationFallback) }
    const cancelledJobs = readdirSync(jobParent).filter(name => !priorJobs.has(name) && /^[a-f0-9-]{36}$/.test(name))
    assert.equal(cancelledJobs.length, 1, 'Cancellation reached a real owned Blender job')
    assert.equal(JSON.parse(readFileSync(join(jobParent, cancelledJobs[0], 'journal.json'), 'utf8')).state, 'cancelled')
    assert(!existsSync(join(jobParent, 'execution.lock')))
    const timingOut = createNativeGameBlender({ studio, assets, timeoutMs: 100 })
    await assert.rejects(timingOut.generate({ ...target, recipe: { primitive: 'pickup' } }), /game_blender_timeout/)
    const journals = readdirSync(jobParent).filter(name => /^[a-f0-9-]{36}$/.test(name)).map(name => JSON.parse(readFileSync(join(jobParent, name, 'journal.json'), 'utf8')))
    assert(journals.some(journal => journal.state === 'failed' && journal.reason === 'game_blender_timeout'))
    assert.equal(assets.list(target).length, 2, 'Cancelled and timed-out real jobs never become candidates')
    assert(!existsSync(join(jobParent, 'execution.lock')))
    writeFileSync(join(jobParent, 'execution.lock'), '{"fixture":"unknown-owner"}')
    await assert.rejects(service.generate({ ...target, recipe: { primitive: 'crate' } }), /game_blender_busy_or_recovery_required/)
    assert.equal(readFileSync(join(jobParent, 'execution.lock'), 'utf8'), '{"fixture":"unknown-owner"}', 'Unknown-owner lock must remain for explicit recovery')
    rmSync(join(jobParent, 'execution.lock'))
    assert.equal(studio.readBuild({ ...target, buildId: created.buildId }).buildCurrent, true, 'Candidate generation never adopts automatically')
    const selected = assets.list(target)[0]
    const adopted = assets.adopt({ ...target, assetId: selected.assetId, expectedBuildId: created.buildId })
    assert.notEqual(adopted.buildId, created.buildId)
    const built = studio.readBuild({ ...target, buildId: adopted.buildId })
    assert.equal(built.manifest.assets.pickup.mime, 'image/png')
    assert.equal(digest(Buffer.from(built.manifest.assets.pickup.data, 'base64')), selected.hash)
    assert(built.html.includes('"mime":"image/png"'), 'Build embeds the selected runtime sprite descriptor')
    console.log('PASS real Blender primitive generation, PNG/GLB/blend/report/job hashes, .blend reopen, GLB import, immutable candidates, explicit sprite adoption, real worker cancellation/timeout, busy and unknown-lock refusal; fixtures cover malformed GLB/report, missing provider, job quotas and output limits. Receipts:', JSON.stringify(receipts))
  }
} finally {
  if (dirname(realpathSync(root)) !== realpathSync(tmpdir()) || !basename(resolve(root)).startsWith('native-game-blender-')) throw new Error('unsafe_test_cleanup')
  rmSync(root, { recursive: true, force: true })
}
