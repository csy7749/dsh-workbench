/** Real loopback management HTTP and files; browser evidence is synthetic here.
 * Actual browser/Blender exports are covered by the separate provider suites. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createNativeGameAssets } from '../src/host/native-game-assets.mjs'
import { createNativeGameRevisions } from '../src/host/native-game-revisions.mjs'
import { createNativeGameManagement } from '../src/host/native-game-management.ts'
const workspaceRoot = mkdtempSync(join(tmpdir(), 'native-management-'))
const studio = createNativeGameStudio(), assets = createNativeGameAssets({ studio })
let denied
const revisions = createNativeGameRevisions({ studio, playtester: { async playtest() { throw new Error('no_browser_in_http_fixture') } } })
const management = createNativeGameManagement({ studio, assets, revisions, products: () => [{ id: 'one', workspacePath: workspaceRoot }, { id: 'two', workspacePath: workspaceRoot }], authorize(name) { if (name === denied) throw new Error('disabled_by_user: ' + name) } })
const server = createServer((req, res) => { const url = new URL(req.url, 'http://localhost'); void management.handle(req, res, url.pathname.replace('/workbench-api', ''), req.method, url).then(handled => { if (!handled) { res.writeHead(404); res.end('{}') } }) })
let responses = 0
try {
  const created = studio.create({ workspaceRoot, productId: 'one', slug: 'manage', title: '管理集成' })
  const target = { productId: 'one', slug: created.slug }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const call = async (action, body, status = 200, headers = {}) => {
    responses++
    const response = await fetch(origin + '/workbench-api/game-studio/' + action + (body === undefined ? '?' + new URLSearchParams(target) : ''), { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify({ ...target, ...body }) }) })
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result.result ?? result
  }
  const initial = await call('state')
  assert.equal(initial.versions.length, 1)
  const image = await call('asset/generate', { provider: 'drawai', slot: 'pickup', recipe: { shape: 'diamond', width: 64, height: 64, fill: '#f5c451' } })
  assert.equal(image.mime, 'image/svg+xml')
  assert.equal((await call('assets')).length, 1)
  const adopted = await call('asset/adopt', { assetId: image.assetId, expectedBuildId: created.buildId })
  assert.notEqual(adopted.buildId, created.buildId)
  assert.equal((await call('asset/adopt', { assetId: image.assetId, expectedBuildId: created.buildId }, 409)).ok, false)
  const sound = await call('asset/generate', { provider: 'any-audio', slot: 'pickupSound', recipe: { preset: 'coin', durationSec: 0.2, sampleRate: 24000, seed: 42 } })
  assert.equal(sound.mime, 'audio/wav')
  assert.equal((await call('assets')).length, 2)
  const next = await call('asset/adopt', { assetId: sound.assetId, expectedBuildId: adopted.buildId })
  const versions = await call('versions')
  assert.equal(versions.length, 3)
  let current = await call('state')
  assert(current.manifest.assets.pickupSound)
  await call('restore', { buildId: created.buildId, expectedCurrentHash: initial.currentHash }, 409)
  const restored = await call('restore', { buildId: created.buildId, expectedCurrentHash: current.currentHash })
  assert.equal(restored.buildId, created.buildId)
  assert.equal(restored.playtestStatus, 'not_assessed')
  current = await call('state')
  const candidate = await call('revision/propose', { expectedBuildId: created.buildId, expectedCurrentHash: current.currentHash, source: studio.currentState({ ...target, workspaceRoot }).source + '\n// HTTP source proposal\n', reason: 'HTTP fixture' })
  assert.equal(candidate.status, 'proposed')
  assert.equal((await call('revisions')).length, 1)
  assert.equal(studio.currentState({ ...target, workspaceRoot }).currentHash, current.currentHash)
  await call('asset/generate', { provider: 'drawai', slot: 'pickup', recipe: { shape: 'rect', script: 'not allowed' } }, 400)
  await call('asset/generate', { provider: 'drawai', slot: 'pickup', recipe: { shape: 'rect' }, workspaceRoot: 'C:/Windows' }, 400)
  await call('asset/generate', { provider: 'drawai', slot: 'pickup', recipe: { shape: 'rect' } }, 403, { origin: 'https://outside.invalid' })
  await call('asset/generate', { provider: 'drawai', slot: 'pickup', recipe: { shape: 'rect' } }, 403, { origin: 'null' })
  await call('restore', { productId: 'two', buildId: next.buildId, expectedCurrentHash: current.currentHash }, 403)
  denied = 'workbench_game_asset_generate'
  await call('asset/generate', { provider: 'drawai', slot: 'pickup', recipe: { shape: 'rect' } }, 403)
  denied = 'workbench_game_revision_verify'
  await call('revision/verify', { candidateId: candidate.candidateId }, 403)
  denied = 'workbench_game_playtest'
  await call('revision/verify', { candidateId: candidate.candidateId }, 403)
  assert.equal(revisions.read({ ...target, workspaceRoot, candidateId: candidate.candidateId }).status, 'proposed', 'disabled browser cannot be bypassed through revision verify')
  denied = 'workbench_game_build'
  await call('revision/verify', { candidateId: candidate.candidateId }, 403)
  assert.equal(revisions.read({ ...target, workspaceRoot, candidateId: candidate.candidateId }).status, 'proposed')
  console.log(`PASS native management: ${responses} real HTTP calls; product-bound state/history, SVG+WAV candidate/adoption, stale CAS, restore/retest, source proposal, origin/extra-path/policy refusal`)
} finally {
  await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
  rmSync(workspaceRoot, { recursive: true, force: true })
}
