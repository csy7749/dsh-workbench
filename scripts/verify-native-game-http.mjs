/** Real loopback HTTP with temporary registered products and actual version snapshots. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeGameHttp, nativeGameUrls } from '../src/host/native-game-http.ts'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'

const root = mkdtempSync(join(tmpdir(), 'native-game-http-'))
const studio = createNativeGameStudio()
let capabilityCalls = 0
const module = createNativeGameHttp({
  studio,
  products: () => [{ id: 'product-a', workspacePath: root }, { id: 'product-b', workspacePath: root }, { id: 'bad-workspace', workspacePath: join(root, 'not-created') }],
  capabilities: async () => { capabilityCalls++; return { provider: 'native-test', available: true } },
})
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  void module.handle(req, res, url.pathname.slice('/workbench-api'.length), req.method, url).then(handled => {
    if (!handled) { res.writeHead(404); res.end('unhandled') }
  }).catch(() => { res.writeHead(500); res.end('test_handler_failed') })
})
let responses = 0
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const request = async (path, method = 'GET') => { responses++; return fetch(origin + path, { method }) }
  const created = studio.create({ workspaceRoot: root, productId: 'product-a', slug: 'http-game', title: '<星光> & "采集"' })
  const urls = nativeGameUrls({ productId: 'product-a', slug: created.slug, buildId: created.buildId })
  const encoded = nativeGameUrls({ prefix: '/custom/', productId: 'a&b', slug: 'test', buildId: '0123456789ab' })
  for (const path of Object.values(encoded)) assert.match(path, /^\/custom\/game-studio\/[a-z]+\?productId=a%26b&/)
  assert.throws(() => nativeGameUrls({ prefix: 'https://outside/', productId: 'a', slug: 'test', buildId: created.buildId }), /game_http_prefix_invalid/)

  const capabilities = await request('/workbench-api/game-studio/capabilities')
  assert.equal(capabilities.status, 200)
  assert.deepEqual(await capabilities.json(), { ok: true, provider: 'native-test', available: true })
  assert.equal(capabilityCalls, 1)
  const preview = await request(urls.previewUrl)
  assert.equal(preview.status, 200)
  assert.match(preview.headers.get('content-type'), /text\/html/)
  assert.match(preview.headers.get('content-security-policy'), /frame-src 'self'/)
  const wrapper = await preview.text()
  assert.match(wrapper, /sandbox="allow-scripts"/)
  assert.doesNotMatch(wrapper, /allow-same-origin|allow-top-navigation|allow-popups|<script/)
  assert.match(wrapper, /&lt;星光&gt; &amp; &quot;采集&quot;/)
  assert.match(wrapper, /下载此版本 HTML/)
  assert(wrapper.includes(urls.artifactUrl.replaceAll('&', '&amp;')))
  assert(wrapper.includes(urls.downloadUrl.replaceAll('&', '&amp;')))

  const artifact = await request(urls.artifactUrl)
  assert.equal(artifact.status, 200)
  const csp = artifact.headers.get('content-security-policy')
  for (const rule of ["sandbox allow-scripts", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "base-uri 'none'", "object-src 'none'", "worker-src 'none'"]) assert(csp.includes(rule), rule)
  assert.doesNotMatch(csp, /allow-same-origin|allow-popups|allow-top-navigation/)
  assert.equal(artifact.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(artifact.headers.get('cache-control'), 'no-store')
  assert.equal(artifact.headers.get('referrer-policy'), 'no-referrer')
  const html = await artifact.text()
  assert.equal(Buffer.byteLength(html), created.bytes)
  assert.equal(Number(artifact.headers.get('content-length')), created.bytes)
  assert.equal(artifact.headers.get('x-game-build-id'), created.buildId)
  assert.equal(artifact.headers.get('x-game-content-sha256'), createHash('sha256').update(html).digest('hex'))
  assert.equal(html, readFileSync(join(root, created.artifact), 'utf8'))

  const source = join(root, created.project, 'game.js')
  writeFileSync(source, readFileSync(source, 'utf8') + '\n// next current version\n')
  const next = studio.build({ workspaceRoot: root, productId: 'product-a', slug: created.slug })
  assert.notEqual(next.buildId, created.buildId)
  const latestPath = join(root, created.project, '.studio/latest.json')
  const latest = readFileSync(latestPath, 'utf8')
  const download = await request(urls.downloadUrl)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="http-game-${created.buildId}.html"`)
  assert.equal(download.headers.get('x-game-build-id'), created.buildId)
  assert.equal(download.headers.get('x-game-content-sha256'), created.hash)
  assert.equal(await download.text(), html, 'download returns the exact historical snapshot')
  assert.equal(await (await request(urls.artifactUrl)).text(), html, 'preview remains bound to historical version')
  assert.equal(existsSync(join(root, created.project, 'exports')), false, 'read-only HTTP does not create exports')
  assert.equal(readFileSync(latestPath, 'utf8'), latest, 'reads never rebuild or move latest')

  for (const [path, method, status, code] of [
    [urls.previewUrl, 'POST', 405, 'game_method_not_allowed'],
    ['/workbench-api/game-studio/capabilities', 'POST', 405, 'game_method_not_allowed'],
    ['/workbench-api/game-studio/nope', 'GET', 404, 'game_route_not_found'],
    [urls.previewUrl.replace('product-a', 'unknown'), 'GET', 404, 'product_workspace_unavailable'],
    [urls.previewUrl.replace('product-a', 'bad-workspace'), 'GET', 404, 'product_workspace_unavailable'],
    [urls.previewUrl.replace('product-a', 'product-b'), 'GET', 403, 'game_product_mismatch'],
    [urls.previewUrl.replace('http-game', '..%2Fother'), 'GET', 400, 'game_slug_invalid'],
    [urls.previewUrl.replace('http-game', 'missing'), 'GET', 404, 'game_not_found'],
    [urls.previewUrl.replace(created.buildId, 'missing'), 'GET', 400, 'game_build_id_invalid'],
    [urls.previewUrl.replace(created.buildId, '000000000000'), 'GET', 404, 'game_not_found'],
    [urls.previewUrl + '&workspaceRoot=C%3A%2FWindows', 'GET', 400, 'game_query_invalid'],
    [urls.previewUrl + '&buildId=' + created.buildId, 'GET', 400, 'game_query_invalid'],
    ['/workbench-api/game-studio/preview', 'GET', 400, 'product_id_required'],
  ]) {
    const response = await request(path, method)
    assert.equal(response.status, status, path)
    if (status === 405) assert.equal(response.headers.get('allow'), 'GET')
    const text = await response.text()
    assert.equal(JSON.parse(text).error, code, path)
    assert(!text.includes(root), 'error never discloses absolute paths')
  }
  writeFileSync(join(root, created.artifact), '<script>unexpected source</script>')
  const corrupt = await request(urls.artifactUrl)
  assert.equal(corrupt.status, 409)
  assert.match(corrupt.headers.get('content-type'), /application\/json/)
  assert.deepEqual(await corrupt.json(), { ok: false, error: 'game_build_integrity_invalid' })
  let touched = false
  assert.equal(await module.handle({}, { writeHead() { touched = true }, end() { touched = true } }, '/game-studio-other', 'GET', new URL('http://test/')), false)
  assert.equal(touched, false)
  console.log(`PASS native game HTTP: ${responses} real responses; exact snapshots, capabilities, sandbox/CSP, title escaping, download/hash headers, read-only behavior, ownership/path/query/method/missing/corrupt errors`)
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
