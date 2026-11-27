/** Production game HTTP/domain checks in temporary workspaces. No DSH runtime,
 * model, production database, browser or human acceptance is exercised here. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createNativeGameService } from '../src/host/native-game-service.mjs'
import { createNativeGameManagement } from '../src/host/native-game-management.ts'
import { createNativeGameHttp } from '../src/host/native-game-http.ts'

const temporary = mkdtempSync(join(tmpdir(), 'dsh-game-workspace-v1-'))
const sharedWorkspace = join(temporary, 'shared'), otherWorkspace = join(temporary, 'other')
mkdirSync(sharedWorkspace); mkdirSync(otherWorkspace)
const products = () => [
  { id: 'game-a', name: '游戏产品 A', projectId: 'project-a', workspacePath: sharedWorkspace },
  { id: 'game-b', name: '游戏产品 B', projectId: 'project-a', workspacePath: sharedWorkspace },
  { id: 'game-other', name: '其他项目', projectId: 'project-b', workspacePath: otherWorkspace },
  { id: 'game-no-workspace', name: '无工作区', projectId: 'project-empty', workspacePath: '' },
]
let denied = ''
const authorizations = [], errors = []
const authorize = name => {
  authorizations.push(name)
  if (name === denied) throw new Error('disabled_by_user: ' + name)
}
const service = createNativeGameService({ products, authorize })
const management = createNativeGameManagement({ ...service, service, products, authorize })
const http = createNativeGameHttp({ studio: service.studio, products, management })
let requests = 0
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  Promise.resolve(http.handle(req, res, url.pathname.replace(/^\/workbench-api(?=\/)/, ''), req.method, url)).then(handled => {
    if (!handled) { res.writeHead(404); res.end('{}') }
  }).catch(error => {
    errors.push(String(error))
    if (!res.writableEnded) { res.writeHead(500); res.end('{}') }
  })
})

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  async function call(action, input, { method = 'GET', status = 200, headers = {} } = {}) {
    requests++
    const response = await fetch(origin + '/workbench-api/game-studio/' + action + (method === 'GET' ? '?' + new URLSearchParams(input) : ''), {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
    })
    const payload = await response.json()
    assert.equal(response.status, status, action + ': ' + JSON.stringify(payload))
    assert.equal(payload.ok, status === 200, action + ': ok agrees with HTTP status')
    if (status !== 200) {
      assert.match(payload.error, /^(?:game|product)_[a-z0-9_]+$/)
      assert.equal(JSON.stringify(payload).includes(temporary), false, 'Errors do not leak the workspace path')
    }
    return payload.result ?? payload
  }
  const post = (action, input, options = {}) => call(action, input, { ...options, method: 'POST' })
  const a = { productId: 'game-a', slug: 'alpha' }, b = { productId: 'game-b', slug: 'beta' }

  assert.deepEqual(await call('projects', { productId: a.productId }), [])
  assert.equal(existsSync(join(sharedWorkspace, 'games')), false, 'Listing an empty product never creates a game folder')
  await call('projects', {}, { status: 400 })
  await call('projects', { productId: 'unknown' }, { status: 404 })
  await call('projects', { productId: 'game-no-workspace' }, { status: 404 })
  await call('projects', { productId: a.productId, workspaceRoot: otherWorkspace }, { status: 400 })

  const createdA = await post('create', { ...a, title: '余烬守望 · 产品 A' })
  assert.match(createdA.buildId, /^[a-f0-9]{12}$/)
  assert.equal(createdA.productId, a.productId)
  assert.equal(createdA.slug, a.slug)
  assert.equal(createdA.template, 'cinderwatch', 'The direct game entry uses the existing complete default game')
  assert.equal(createdA.previewAvailable, true)
  assert.equal(createdA.buildStatus, 'built')
  const createdB = await post('create', { ...b, title: '独立产品 B', template: 'canvas-collector' })
  assert.equal(createdB.productId, b.productId)
  assert.equal(createdB.template, 'canvas-collector')
  const brokenDir = join(sharedWorkspace, 'games', 'unrelated-directory')
  mkdirSync(brokenDir); writeFileSync(join(brokenDir, 'game.json'), '{invalid unrelated fixture')

  const gamesA = await call('projects', { productId: a.productId })
  const gamesB = await call('projects', { productId: b.productId })
  assert.deepEqual(gamesA.map(game => game.slug), [a.slug], 'A shared filesystem directory does not merge product identities')
  assert.deepEqual(gamesB.map(game => game.slug), [b.slug])
  assert.equal(gamesA[0].title, '余烬守望 · 产品 A')
  assert.equal(gamesA[0].buildId, createdA.buildId)
  assert.deepEqual(await call('projects', { productId: 'game-other' }), [], 'Another project has an independent game list')
  assert.equal(existsSync(join(otherWorkspace, 'games')), false)

  const initialState = await call('state', a)
  const initialSource = await call('source', a)
  assert.match(initialSource.currentHash, /^[a-f0-9]{64}$/)
  assert.equal(initialSource.currentHash, initialState.currentHash)
  assert.equal(initialSource.sourceHash, initialState.sourceHash)
  assert.equal(initialSource.manifestHash, initialState.manifestHash)
  assert.equal(initialSource.source, readFileSync(join(sharedWorkspace, 'games', a.slug, 'game.js'), 'utf8'))
  assert.equal(initialState.versions.length, 1)
  assert.equal((await post('build', a)).buildId, createdA.buildId, 'An unchanged build preserves its fixed identity')

  const historical = new URLSearchParams({ ...a, buildId: createdA.buildId })
  const readArtifact = async action => {
    requests++
    const response = await fetch(origin + '/workbench-api/game-studio/' + action + '?' + historical)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-game-build-id'), createdA.buildId)
    assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/)
    assert.equal(response.headers.get('content-security-policy').includes('allow-same-origin'), false)
    return { response, html: await response.text() }
  }
  const oldArtifact = await readArtifact('artifact')
  assert.equal(existsSync(join(sharedWorkspace, 'games', a.slug, 'exports')), false, 'Preview reads do not silently export')
  appendFileSync(join(sharedWorkspace, 'games', a.slug, 'game.js'), '\n// game workspace v1 isolated revision\n')
  const built = await post('build', a)
  assert.notEqual(built.buildId, createdA.buildId)
  const changed = await call('source', a)
  assert.notEqual(changed.currentHash, initialSource.currentHash)
  assert.equal(changed.source.endsWith('// game workspace v1 isolated revision\n'), true)
  assert.equal((await call('versions', a)).length, 2)
  assert.equal((await readArtifact('artifact')).html, oldArtifact.html, 'The historical preview stays pinned after a new build')
  const download = await readArtifact('download')
  assert.equal(download.html, oldArtifact.html)
  assert.match(download.response.headers.get('content-disposition'), new RegExp(a.slug + '-' + createdA.buildId + '\\.html'))
  assert.equal(existsSync(join(sharedWorkspace, 'games', a.slug, 'exports')), false, 'Downloading an artifact does not mutate exports')

  const exported = await post('export', { ...a, buildId: createdA.buildId })
  assert.equal(exported.buildId, createdA.buildId, 'Delivery refers to the exact selected build')
  assert.equal(exported.exported, true)
  assert.equal(readFileSync(join(sharedWorkspace, exported.exportPath), 'utf8'), oldArtifact.html)
  assert.equal((await post('export', { ...a, buildId: createdA.buildId })).reused, true)

  for (const action of ['state', 'source', 'versions']) await call(action, { ...a, productId: b.productId }, { status: 403 })
  await post('build', { ...a, productId: b.productId }, { status: 403 })
  await post('export', { ...a, productId: b.productId, buildId: createdA.buildId }, { status: 403 })
  await post('create', { ...a, slug: 'outside', title: 'Refuse caller path', workspaceRoot: otherWorkspace }, { status: 400 })
  await post('create', { ...a, slug: 'outside', title: 'Refuse cross origin' }, { status: 403, headers: { origin: 'https://outside.invalid' } })
  assert.equal(existsSync(join(sharedWorkspace, 'games', 'outside')), false)
  await post('build', { ...a, buildId: createdA.buildId }, { status: 400 })
  await call('source', { ...a, slug: 'absent' }, { status: 404 })
  denied = 'workbench_game_create'
  await post('create', { ...a, slug: 'denied', title: 'Policy refusal' }, { status: 403 })
  assert.equal(existsSync(join(sharedWorkspace, 'games', 'denied')), false)
  denied = 'workbench_game_build'
  await post('build', a, { status: 403 })
  denied = 'workbench_game_export'
  await post('export', { ...a, buildId: built.buildId }, { status: 403 })
  assert.equal(existsSync(join(sharedWorkspace, 'games', a.slug, 'exports', built.buildId + '.html')), false)
  denied = ''

  assert.deepEqual(errors, [])
  assert.equal(authorizations.some(name => /playtest|asset_generate|revision_verify/.test(name)), false, 'These checks invoke no browser, generation provider or model')
  assert.deepEqual(readdirSync(temporary).sort(), ['other', 'shared'])
  const report = { requests, products: 4, createdGames: 2, exactBuildExport: createdA.buildId, newBuild: built.buildId,
    scope: 'production source HTTP handlers and real isolated game files', modelCalls: 0, realDsh: 'not exercised', humanAcceptance: 'not exercised' }
  console.log('PASS game workspace v1 domain: product-bound list/create/source/build/export, same-workspace isolation, immutable artifacts, CAS inputs, origin/path/policy refusals. ' + JSON.stringify(report))
} finally {
  if (server.listening) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
  if (dirname(realpathSync(temporary)) !== realpathSync(tmpdir()) || !basename(temporary).startsWith('dsh-game-workspace-v1-')) throw new Error('unsafe_test_cleanup')
  rmSync(temporary, { recursive: true, force: true })
}
