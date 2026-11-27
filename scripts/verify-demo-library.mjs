// Demo library contracts: built-in gallery, game preview/thumbnail, project UI demos and uploads.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = mkdtempSync(join(tmpdir(), 'dsh-demo-library-'))
process.env.DSH_WORKBENCH_DB = join(temporary, 'workbench.sqlite')
const registrations = []
const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)
host.apply({ webServer: { register(route) { registrations.push(route) } }, tools: { register() {} } })
const route = registrations.find(item => item.path === '/workbench-api')
assert.ok(route, 'workbench HTTP route registered')
const call = (method, url, body) => new Promise(resolve => {
  const req = { url: `/workbench-api${url}`, method, json: async () => body ?? {} }
  const res = {
    status: 0, headers: {}, body: undefined,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers },
    end(payload) {
      this.body = String(this.headers['content-type'] ?? '').startsWith('application/json') && typeof payload === 'string' ? JSON.parse(payload) : payload
      resolve(this)
    },
  }
  route.handler(req, res)
})

const library = await call('GET', '/demos/library')
assert.equal(library.status, 200)
assert.equal(library.body.packs.length, 1)
assert.equal(library.body.packs[0].id, 'cinderwatch')
assert.equal(library.body.packs[0].nodes.length, 11)
assert.equal(library.body.packs[0].playUrl, '/workbench-api/demos/library/cinderwatch/play')
assert.ok(library.body.packs[0].files.some(group => group.paths.includes('assets/vendor/cinderwatch/src/90-main.js')))

const gamePreview = await call('GET', '/demos/library/cinderwatch/view')
assert.equal(gamePreview.status, 200)
assert.match(gamePreview.headers['content-type'], /text\/html/)
assert.match(String(gamePreview.body), /nativeTemplate/)
assert.match(String(gamePreview.body), /Content-Security-Policy/)

const gamePlayer = await call('GET', '/demos/library/cinderwatch/play')
assert.equal(gamePlayer.status, 200)
assert.match(gamePlayer.headers['content-type'], /text\/html/)
assert.match(String(gamePlayer.body), /id=["']close-playtest["']/)
assert.match(String(gamePlayer.body), /id=["']restart-playtest["']/)
assert.match(String(gamePlayer.body), /src=["']\/workbench-api\/demos\/library\/cinderwatch\/view["']/)
assert.equal((await call('GET', '/demos/library/not-registered/play')).status, 404)

const gameThumbnail = await call('GET', '/demos/library/cinderwatch/thumbnail')
assert.equal(gameThumbnail.status, 200)
assert.equal(gameThumbnail.headers['content-type'], 'image/webp')
assert.equal(gameThumbnail.body.toString('ascii', 0, 4), 'RIFF')
assert.equal((await call('GET', '/demos/library/not-registered/thumbnail')).status, 404)

const project = (await call('POST', '/projects', { project: { name: 'Demo Library Fixture', workspacePath: temporary } })).body.project
const created = await call('POST', '/demos', { demo: { projectId: project.id, title: '网页 Demo', themeId: 'clean', layoutMode: 'single' } })
assert.equal(created.status, 200)
const demoId = created.body.demo.id
const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#843f25' } }).png().toBuffer()
const uploaded = await call('POST', `/demos/${demoId}/thumbnail`, { dataUrl: `data:image/png;base64,${png.toString('base64')}` })
assert.equal(uploaded.status, 200)
assert.match(uploaded.body.thumbnailUrl, new RegExp(`/demos/${demoId}/thumbnail`))
const webThumbnail = await call('GET', `/demos/${demoId}/thumbnail`)
assert.equal(webThumbnail.status, 200)
assert.equal(webThumbnail.headers['content-type'], 'image/webp')
assert.equal((await call('POST', '/demos/unknown/thumbnail', { dataUrl: `data:image/webp;base64,${png.toString('base64')}` })).status, 400)
const scopedLibrary = await call('GET', `/demos/library?projectId=${encodeURIComponent(project.id)}`)
assert.equal(scopedLibrary.body.demos[0].id, demoId)
assert.ok(scopedLibrary.body.demos[0].thumbnailUrl)
console.log('PASS demo library: built-in Cinderwatch catalog, safe preview/player/thumbnail routes, standalone close/restart controls, project-scoped web demos and normalized thumbnail upload')
