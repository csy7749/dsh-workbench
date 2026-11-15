/**
 * M0-B 宿主构建产物验证：直接加载 lib/index.js（重启后 DSH 真正加载的就是它），
 * 用最小 ctx 桩调用 apply()，确认沙盒路由确实被登记，并通过真实 loopback HTTP
 * 验证健康探测、浏览器准入拒绝、CSRF 头与票据一次性。
 *
 * 只使用临时目录、临时 SQLite、假执行器；不触碰生产库、不调用真实模型。
 * 运行：node scripts/verify-workflow-m0-host-bundle.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX_PREFIX = '/workbench-workflow-sandbox'

let checks = 0
let passed = 0
let assertions = 0
const results = []

function need(condition, message) {
  assertions += 1
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

async function check(id, title, fn) {
  checks += 1
  try {
    await fn()
    passed += 1
    results.push({ id, title, status: 'pass' })
  } catch (cause) {
    results.push({ id, title, status: 'fail', error: String(cause?.message ?? cause) })
  }
}

/** 最小宿主 ctx 桩：只实现 apply() 用到的那几项。 */
function fakeContext({ withConnection = true } = {}) {
  const routes = []
  const disposers = []
  const labels = []
  const ctx = {
    tools: { register: () => {} },
    webServer: { register: route => { routes.push(route); return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1) } } },
    on: () => () => {},
    effect: (factory, label) => {
      if (label) labels.push(label)
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  if (withConnection) {
    ctx.connection = {
      browserPeer: { id: 'browser-peer', principal: { kind: 'owner' }, interactions: 'answer' },
      admit: request => (String(request?.headers?.cookie ?? '').includes('dsh-browser-session')
        ? { peer: ctx.connection.browserPeer }
        : { rejection: 403 }),
    }
  }
  return { ctx, routes, disposers, labels }
}

/** 把 apply() 登记的 prefix 路由接到真实 http server 上。 */
function serve(routes) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const route = routes.find(item => path === item.path || path.startsWith(`${item.path}/`))
    if (!route) { res.writeHead(404); res.end(); return }
    route.handler(req, res)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()) }),
      })
    })
  })
}

/** 沙盒所有写入口都要求 CSRF 头 + JSON content-type，这里统一带上。 */
const CSRF = { 'x-workflow-sandbox': '1' }
const SESSION = { cookie: 'dsh-browser-session=v1-bundle' }

async function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status: res.status, headers: res.headers, body: parsed, text }
}

const { apply, inject } = await import('../lib/index.js')
const roots = []

/** 每次 apply 用独立临时 DSH_HOME 与临时库，绝不碰生产库。 */
function scene({ withConnection = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'm0b-bundle-'))
  roots.push(root)
  const previousHome = process.env.DSH_HOME
  const previousDb = process.env.DSH_WORKBENCH_DB
  process.env.DSH_HOME = root
  process.env.DSH_WORKBENCH_DB = join(root, 'workbench.sqlite')
  const fake = fakeContext({ withConnection })
  apply(fake.ctx)
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousDb === undefined) delete process.env.DSH_WORKBENCH_DB
  else process.env.DSH_WORKBENCH_DB = previousDb
  return { ...fake, root }
}

const main = scene()
const live = await serve(main.routes)

await check('HB-01', '构建产物导出 apply 并声明 connection 注入', () => {
  need(typeof apply === 'function', 'apply 应该是函数')
  need(Array.isArray(inject) && inject.includes('connection'), `inject 应含 connection，实际 ${JSON.stringify(inject)}`)
})

await check('HB-02', 'apply() 登记沙盒 prefix 路由与卸载钩子', () => {
  const sandbox = main.routes.find(route => route.path === SANDBOX_PREFIX)
  need(sandbox !== undefined, `应登记 ${SANDBOX_PREFIX}，实际 ${JSON.stringify(main.routes.map(route => route.path))}`)
  need(sandbox.kind === 'prefix', `kind 应为 prefix，实际 ${sandbox.kind}`)
  need(main.labels.includes('workbench: workflow sandbox'), `effect 应登记沙盒卸载钩子，实际 ${JSON.stringify(main.labels)}`)
})

await check('HB-03', '真实 HTTP：/health 声明临时假执行器且不可缓存', async () => {
  const res = await request(live.port, `${SANDBOX_PREFIX}/health`, { headers: SESSION })
  need(res.status === 200, `status 应为 200，实际 ${res.status} ${res.text.slice(0, 120)}`)
  need(res.body?.mode === 'temporary-fake', `mode 应为 temporary-fake，实际 ${JSON.stringify(res.body)}`)
  need(res.body?.humanIdentityVerified === false, 'health 不得宣称已校验真人身份')
  need(String(res.headers.get('cache-control') ?? '').includes('no-store'), 'health 必须 no-store')
})

await check('HB-04', '真实 HTTP：/health 本身也受浏览器准入保护', async () => {
  const res = await request(live.port, `${SANDBOX_PREFIX}/health`)
  need(res.status === 403, `无会话 health 应 403，实际 ${res.status}`)
  need(String(res.body?.error ?? '').includes('browser_session_required'), `error 应含 browser_session_required，实际 ${JSON.stringify(res.body)}`)
})

await check('HB-05', '真实 HTTP：取票与派发都要求 CSRF 头', async () => {
  const message = { method: 'read', args: [] }
  const noHeader = await request(live.port, `${SANDBOX_PREFIX}/ticket`, { method: 'POST', headers: SESSION, body: { message } })
  need(noHeader.status === 403, `缺 CSRF 头应 403，实际 ${noHeader.status}`)
  need(String(noHeader.body?.error ?? '').includes('sandbox_header_required'), `error 应含 sandbox_header_required，实际 ${JSON.stringify(noHeader.body)}`)
  const noSession = await request(live.port, `${SANDBOX_PREFIX}/ticket`, { method: 'POST', headers: CSRF, body: { message } })
  need(noSession.status === 403, `缺会话应 403，实际 ${noSession.status}`)
  need(String(noSession.body?.error ?? '').includes('browser_session_required'), `error 应含 browser_session_required，实际 ${JSON.stringify(noSession.body)}`)
})

await check('HB-06', '真实 HTTP：票据一次性，且派发真的穿透到业务层', async () => {
  const headers = { ...SESSION, ...CSRF }
  const message = { method: 'read', args: [] }
  const ticketRes = await request(live.port, `${SANDBOX_PREFIX}/ticket`, { method: 'POST', headers, body: { message } })
  need(ticketRes.status === 200, `取票应 200，实际 ${ticketRes.status} ${ticketRes.text.slice(0, 160)}`)
  const ticket = ticketRes.body?.ticket
  need(typeof ticket === 'string' && ticket.length > 0, '应返回票据')
  /* read 缺 runId 必然业务报错；这里要证明的是票据校验已通过、消息真的进了宿主，
     而不是被 gate 拦下（gate 错误码只有 browser_session_required / sandbox_header_required / ticket_invalid）。 */
  const first = await request(live.port, `${SANDBOX_PREFIX}/dispatch`, { method: 'POST', headers, body: { ticket, message } })
  const firstError = String(first.body?.error ?? '')
  need(!['browser_session_required', 'sandbox_header_required', 'ticket_invalid'].some(code => firstError.includes(code)), `首次派发不应被 gate 拒：${first.status} ${first.text.slice(0, 200)}`)
  need(first.status === 400 && firstError.includes('run_not_found'), `首次派发应穿透到业务层并因缺 runId 报错，实际 ${first.status} ${first.text.slice(0, 200)}`)
  const replay = await request(live.port, `${SANDBOX_PREFIX}/dispatch`, { method: 'POST', headers, body: { ticket, message } })
  need(replay.status === 403, `重放应 403，实际 ${replay.status}`)
  need(String(replay.body?.error ?? '').includes('ticket_invalid'), `重放 error 应含 ticket_invalid，实际 ${JSON.stringify(replay.body)}`)
})

await check('HB-07', '无准入能力时不登记路由（避免暴露无门禁入口）', async () => {
  const noConn = scene({ withConnection: false })
  const route = noConn.routes.find(item => item.path === SANDBOX_PREFIX)
  need(route === undefined, `无 connection 时不应登记 ${SANDBOX_PREFIX}，实际 ${JSON.stringify(noConn.routes.map(item => item.path))}`)
})

await live.close()
/* 宿主桩没有 close 语义，SQLite 句柄在进程退出前一直持有：Windows 下删不掉目录是正常的，
   清理失败不影响结论（临时目录由系统回收）。 */
for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 句柄未释放，忽略 */ }
}

console.log(JSON.stringify({
  checks,
  passed,
  failed: results.filter(item => item.status === 'fail'),
  assertions,
  scope: 'M0-B host bundle review; temporary SQLite, synthetic fixtures, fake executor only',
  results,
}, null, 2))

process.exit(passed === checks ? 0 : 1)
