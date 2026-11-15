// Characterization probe for the LEGACY publish chain. This does NOT test a fix.
// It drives lib/index.js through the same fake host route pattern as
// scripts/verify-product-docs.mjs, against a throwaway SQLite DB and workspace
// under os.tmpdir. It asserts that the current defects reproduce:
//   1. publishing an audit report through workbench_product_note_publish
//      overwrites the product design note (same derived docKey);
//   2. POST /sync/push upserts a design note without kind/docKey/moduleId and
//      wipes those identity fields;
//   3. a mirror write failure (target path is a directory, no chmod) leaves the
//      DB row with file_path='' and deletes the previously mirrored file.
// Usage: node scripts/probe-workflow-legacy-publish.mjs
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundlePath = join(root, 'lib/index.js')
const bundleHash = createHash('sha256').update(readFileSync(bundlePath)).digest('hex')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-legacy-publish-probe-'))
const dbPath = join(tmp, 'wb.sqlite')
process.env.DSH_WORKBENCH_DB = dbPath

let pass = 0
let fail = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (ok) { pass++; console.log('  ✓', name, detail) }
  else { fail++; console.log('  ✗', name, detail) }
}

const tools = []
const routes = []
// Fail closed if host initialization or a timer attempts network access.
let networkAttempts = 0
globalThis.fetch = async () => { networkAttempts++; throw new Error('probe_network_forbidden') }
const host = await import(pathToFileURL(bundlePath).href)
host.apply({
  webServer: { register(r) { routes.push(r) } },
  tools: { register(t) { tools.push(t) }, schemas: () => [] },
})
const route = routes.find(r => r.path === '/workbench-api')
if (!route) throw new Error('未注册 /workbench-api 路由')

const call = (method, url, body) => new Promise((resolve) => {
  const req = {
    url: `/workbench-api${url}`,
    method,
    headers: {},
    json: async () => body ?? {},
  }
  const res = {
    status: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    writeHead(status) { this.status = status },
    end(payload) {
      let parsed = null
      if (payload) { try { parsed = JSON.parse(String(payload)) } catch { parsed = String(payload) } }
      resolve({ status: this.status, body: parsed })
    },
  }
  route.handler(req, res)
})

// ---- fixture: product + map + module, all in the throwaway workspace ----
const productRes = await call('POST', '/products', { product: { name: 'probe-product', workspacePath: tmp } })
const product = productRes.body?.product
check('临时产品创建', !!product?.id, product?.id ?? JSON.stringify(productRes.body).slice(0, 200))
const mapId = (await call('GET', `/products/maps?productId=${product.id}`)).body?.maps?.[0]?.id
check('临时导图创建', !!mapId, String(mapId ?? ''))
const moduleRes = await call('POST', '/modules', { module: { productId: product.id, mapId, name: 'probe-module', kind: 'module' } })
const mod = moduleRes.body?.module
check('临时模块创建', !!mod?.id, mod?.id ?? JSON.stringify(moduleRes.body).slice(0, 200))

const publishTool = tools.find(t => t.name === 'workbench_product_note_publish')
check('假宿主注册了 workbench_product_note_publish', !!publishTool, `tools=${tools.length}`)

// ---- 1. report overwrites product design ----
const pd = await publishTool.execute({ productId: product.id, mapId, title: '产品设计', content: '产品正文 v1' })
check('产品设计发布成功', pd?.ok === true, pd?.error ?? '')
const report = await publishTool.execute({ productId: product.id, mapId, title: '一致性报告', content: '报告正文' })
check('一致性报告发布成功（工具路径无 docKey）', report?.ok === true, report?.error ?? '')
const notesAfter = (await call('GET', '/notes')).body?.notes ?? []
const pdKeyNotes = notesAfter.filter(n => String(n.docKey ?? '') === `pd:${product.id}`)
check(
  '缺陷复现：报告与产品正文同键，报告覆盖产品正文',
  pdKeyNotes.length === 1 && pdKeyNotes[0].title === '一致性报告' && pdKeyNotes[0].content === '报告正文',
  `count=${pdKeyNotes.length}, titles=${pdKeyNotes.map(n => n.title).join('|')}`,
)
check(
  '缺陷复现：第一次产品设计行已被同一 id 覆盖',
  String(pd?.note?.id ?? '') !== '' && String(pd?.note?.id) === String(report?.note?.id),
  `${pd?.note?.id} vs ${report?.note?.id}`,
)

// ---- 2. sync push wipes design identity ----
const syncNoteId = 'note-sync-probe-000001'
const syncCreated = await call('POST', '/notes', {
  note: {
    id: syncNoteId, notebookId: product.notebookId, title: '同步模块设计', content: 'v1',
    kind: 'module_design', moduleId: mod.id, mapId,
  },
})
check('同步探针前置笔记创建且 docKey=md:<moduleId>', syncCreated.body?.note?.docKey === `md:${mod.id}`, String(syncCreated.body?.note?.docKey ?? ''))
const pushed = await call('POST', '/sync/push', {
  changes: [{
    entity: 'notes', id: syncNoteId, op: 'upsert', updatedAt: '2099-01-01 00:00:00',
    row: { title: '同步模块设计', content: 'v2' },
  }],
})
check('sync/push 接受推送', pushed.status === 200 && (pushed.body?.accepted ?? []).includes(syncNoteId), JSON.stringify(pushed.body).slice(0, 200))
const syncAfter = ((await call('GET', '/notes')).body?.notes ?? []).find(n => n.id === syncNoteId)
check(
  '缺陷复现：sync/push 后 docKey/kind/moduleId 被清空',
  String(syncAfter?.docKey ?? '') === '' && String(syncAfter?.kind ?? '') === '' && String(syncAfter?.moduleId ?? '') === '',
  JSON.stringify({ docKey: syncAfter?.docKey, kind: syncAfter?.kind, moduleId: syncAfter?.moduleId }),
)

// ---- 3. mirror write failure: target path is a directory ----
const mirrorId = 'note-mirror-probe-000001'
const first = await call('POST', '/notes', {
  note: { id: mirrorId, notebookId: product.notebookId, title: 'old-title', content: 'old-body' },
})
const oldPath = String(first.body?.note?.filePath ?? '')
check('镜像探针第一次保存成功且落盘', oldPath !== '' && existsSync(oldPath), oldPath)
const mirrorDir = dirname(oldPath)
const newPath = join(mirrorDir, `new-title-${mirrorId.slice(-6)}.md`)
mkdirSync(newPath, { recursive: true })
check('已用目录占位制造确定性的写失败目标', existsSync(newPath) && statSync(newPath).isDirectory(), newPath)
const second = await call('POST', '/notes', {
  note: { id: mirrorId, notebookId: product.notebookId, title: 'new-title', content: 'new-body' },
})
check('镜像失败时保存仍返回 200（正文入库）', second.status === 200 && second.body?.note?.content === 'new-body', JSON.stringify(second.body).slice(0, 200))
check(
  '缺陷复现：镜像失败后 file_path 被清空',
  String(second.body?.note?.filePath ?? '') === '',
  String(second.body?.note?.filePath ?? ''),
)
check(
  '缺陷复现：镜像失败后旧 Markdown 被删除',
  !existsSync(oldPath),
  `oldPath=${oldPath}, exists=${existsSync(oldPath)}`,
)
check('镜像目标仍是目录（未写出文件）', existsSync(newPath) && statSync(newPath).isDirectory(), newPath)

check('宿主未尝试 fetch 网络请求', networkAttempts === 0, String(networkAttempts))

// ---- evidence ----
const sourceBundle = {
  bundle: bundlePath,
  bundleSha256: bundleHash,
  bundleBytes: statSync(bundlePath).size,
  bundleMtime: statSync(bundlePath).mtime.toISOString(),
  note: 'Probe characterizes the BUNDLED legacy implementation; it is not a fix test and not a source-current guarantee.',
}
const summary = {
  ok: fail === 0,
  characterization: fail === 0,
  checks: { pass, fail, total: pass + fail },
  tempDir: tmp,
  dbPath,
  productId: product.id,
  bundle: sourceBundle,
  results,
}
console.log('\n' + JSON.stringify(summary, null, 2))
process.exit(fail === 0 ? 0 : 1)
