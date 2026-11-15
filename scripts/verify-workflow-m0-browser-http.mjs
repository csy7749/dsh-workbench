/**
 * M0-B 浏览器沙盒通道的本机真实 HTTP 联调（独立验证脚本）。
 *
 * 与 verify-workflow-m0-browser-transport.mjs 的分工：
 *   - 那个脚本用假 req/res 验逻辑分支（快、可穷举反例）；
 *   - 这个脚本把路由挂到真实 node:http server 上，用真实 socket 发请求，
 *     验真实 IncomingMessage / 分块请求体 / 头部大小写 / 真连接上的重放。
 *
 * 边界（写进断言，避免被引用成更强的结论）：
 *   - admission 通过只代表「来自已鉴权的浏览器连接」，不代表屏幕前有人；
 *     /health 必须始终 humanIdentityVerified:false。
 *   - 只绑 127.0.0.1 随机端口，只走 loopback，不对外监听，不打生产库、不调真实模型。
 *
 * 用法：node scripts/verify-workflow-m0-browser-http.mjs
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BROWSER_WORKFLOW_PREFIX, mountBrowserWorkflow } from '../src/workflow/m0-browser-transport.mjs'
import { createDevelopmentHost } from '../src/workflow/m1-development-host.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCTION_LIKE = /dsh-workbench\.sqlite/
const BROWSER_COOKIE = 'dsh-browser-session=v1-test'
const MESSAGE = { args: [{ op: 'inspect' }, { op: 'advance' }, { op: 'read' }] }

const results = []
let assertions = 0
const need = (condition, label) => {
  assertions += 1
  if (!condition) throw new Error(`断言失败: ${label}`)
}
const check = async (id, title, fn) => {
  try {
    await fn()
    results.push({ id, title, status: 'pass' })
  } catch (error) {
    results.push({ id, title, status: 'fail', error: String(error?.message ?? error) })
  }
}

/** 模拟宿主准入：带浏览器 cookie 的请求归 browserPeer，其余一律 401。 */
const browserAdmission = () => {
  const peer = { id: 'peer-browser' }
  const stats = { calls: 0 }
  return {
    peer,
    stats,
    connection: {
      browserPeer: peer,
      admit: req => {
        stats.calls += 1
        const cookie = String(req.headers?.cookie ?? '')
        return cookie.includes(BROWSER_COOKIE) ? { peer } : { rejection: 401 }
      },
    },
  }
}

/** 挂载后取到路由，再交给监听在 loopback 随机端口上的真 http server。 */
const mountOnLoopback = async ({ connection, hostFactory }) => {
  let captured = null
  const api = mountBrowserWorkflow({
    connection,
    register: route => { captured = route; return () => { captured = null } },
    ...(hostFactory ? { hostFactory } : {}),
  })
  const server = createServer((req, res) => {
    if (captured === null) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'disposed' }))
      return
    }
    captured.handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}${BROWSER_WORKFLOW_PREFIX}`
  const close = async () => {
    if (close.done) return
    close.done = true
    try { api.dispose() } catch { /* 已在用例内 dispose 过 */ }
    // 大请求体被截断后 socket 可能仍是 keep-alive，直接 close 会一直等；先断连接再关。
    server.closeAllConnections?.()
    await new Promise(resolve => { server.close(() => resolve()); server.unref() })
  }
  return { api, base, port: address.port, hostHeader: `127.0.0.1:${address.port}`, close }
}

const post = async (url, body, headers = {}) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workflow-Sandbox': '1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed, headers: res.headers }
}

const ticket = async (base, headers = {}) => {
  const res = await post(`${base}/ticket`, { message: MESSAGE }, headers)
  if (res.status !== 200) throw new Error(`票据发放失败 ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.ticket
}

/* ------------------------------------------------------------------ 检查项 */

await check('HT-01', '真实 loopback 上：健康探针不宣称人工身份，且不建宿主', async () => {
  const { connection } = browserAdmission()
  let created = 0
  const env = await mountOnLoopback({
    connection,
    hostFactory: () => ({ create() { created += 1 }, dispatch() { return {} }, close() {} }),
  })
  try {
    const res = await fetch(`${env.base}/health`, { headers: { Cookie: BROWSER_COOKIE } })
    const body = await res.json()
    need(res.status === 200, `health 返回 200（收到 ${res.status}）`)
    need(body.mode === 'temporary-fake', 'mode 为 temporary-fake')
    need(body.humanIdentityVerified === false, 'humanIdentityVerified 必须为 false')
    need(res.headers.get('cache-control') === 'no-store', '带 no-store')
    need(created === 0, 'health 不建宿主')
  } finally { await env.close() }
})

await check('HT-02', '真实 HTTP：无浏览器 cookie 的请求被准入拒绝（403）', async () => {
  const { connection, stats } = browserAdmission()
  let created = 0
  const env = await mountOnLoopback({
    connection,
    hostFactory: () => ({ create() { created += 1 }, dispatch() { return {} }, close() {} }),
  })
  try {
    const noCookie = await post(`${env.base}/ticket`, { message: MESSAGE })
    need(noCookie.status === 403, `无 cookie 返回 403（收到 ${noCookie.status}）`)
    need(noCookie.body.error === 'browser_session_required', '错误码为 browser_session_required')
    need(stats.calls === 1, 'admit 确实被调用（拒绝来自准入而非别处）')

    const forged = await post(`${env.base}/ticket`, { message: MESSAGE }, { Cookie: 'dsh-browser-session=v0-old' })
    need(forged.status === 403, `错版本 cookie 返回 403（收到 ${forged.status}）`)
    need(created === 0, '被拒请求不建宿主')
  } finally { await env.close() }
})

await check('HT-03', '真实 HTTP：取票→派发→一次性（真 socket 上的重放）', async () => {
  const { connection } = browserAdmission()
  const env = await mountOnLoopback({ connection, hostFactory: () => {
    const inner = createDevelopmentHost()
    const state = { created: 0, dispatched: 0, location: null }
    return {
      create() { state.created += 1; const info = inner.create(); state.location = info.location; return info },
      dispatch(message) { state.dispatched += 1; return { accepted: message, ok: true } },
      close() { return inner.close() },
      __state: state,
    }
  } })
  try {
    const t = await ticket(env.base, { Cookie: BROWSER_COOKIE })
    need(typeof t === 'string' && t.length > 0, '拿到票据')

    const first = await post(`${env.base}/dispatch`, { ticket: t, message: MESSAGE }, { Cookie: BROWSER_COOKIE })
    need(first.status === 200, `派发成功（收到 ${first.status}）`)
    need(first.body.result?.ok === true, '结果来自宿主')
    need(JSON.stringify(first.body.result.accepted) === JSON.stringify(MESSAGE), '载荷逐字到达宿主')

    const replay = await post(`${env.base}/dispatch`, { ticket: t, message: MESSAGE }, { Cookie: BROWSER_COOKIE })
    need(replay.status === 403, `重放返回 403（收到 ${replay.status}）`)
    need(replay.body.error === 'ticket_invalid', '错误码为 ticket_invalid')
  } finally { await env.close() }
})

await check('HT-04', '真实 HTTP：跨站 Origin 被拒，且不调用准入', async () => {
  const { connection, stats } = browserAdmission()
  const env = await mountOnLoopback({ connection, hostFactory: () => ({ create() {}, dispatch() { return {} }, close() {} }) })
  try {
    const cross = await post(`${env.base}/ticket`, { message: MESSAGE }, { Cookie: BROWSER_COOKIE, Origin: 'http://evil.example' })
    need(cross.status === 403, `跨站返回 403（收到 ${cross.status}）`)
    need(cross.body.error === 'origin_rejected', '错误码为 origin_rejected')
    need(stats.calls === 0, 'Origin 栅栏先于 admit')

    const same = await post(`${env.base}/ticket`, { message: MESSAGE }, { Cookie: BROWSER_COOKIE, Origin: `http://${env.hostHeader}` })
    need(same.status === 200, `同源放行（收到 ${same.status}）`)
  } finally { await env.close() }
})

await check('HT-05', '真实 HTTP：缺 CSRF 头被拒，方法/路径边界正确', async () => {
  const { connection } = browserAdmission()
  const env = await mountOnLoopback({ connection, hostFactory: () => ({ create() {}, dispatch() { return {} }, close() {} }) })
  try {
    const noHeader = await fetch(`${env.base}/ticket`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: BROWSER_COOKIE }, body: JSON.stringify({ message: MESSAGE }),
    }).then(async res => ({ status: res.status, body: await res.json() }))
    need(noHeader.status === 403 && noHeader.body.error === 'sandbox_header_required', '缺头返回 sandbox_header_required')

    const put = await fetch(`${env.base}/health`, { method: 'PUT', headers: { Cookie: BROWSER_COOKIE } })
    need(put.status === 405, `PUT 返回 405（收到 ${put.status}）`)

    const unknownPath = await post(`${env.base}/nope`, { message: MESSAGE }, { Cookie: BROWSER_COOKIE })
    need(unknownPath.status === 404, `未知路径 404（收到 ${unknownPath.status}）`)
    need(unknownPath.body.error === 'not_found', '错误码为 not_found')
  } finally { await env.close() }
})

await check('HT-06', '真实 HTTP：超过 1MiB 的请求体在读取阶段被截断', async () => {
  const { connection } = browserAdmission()
  const env = await mountOnLoopback({ connection, hostFactory: () => ({ create() {}, dispatch() { return {} }, close() {} }) })
  try {
    const huge = JSON.stringify({ message: { args: [{ op: 'x'.repeat(1_400_000) }] } })
    const res = await post(`${env.base}/ticket`, huge, { Cookie: BROWSER_COOKIE })
    need(res.status === 400, `超大请求返回 400（收到 ${res.status}）`)
    need(res.body.error === 'request_too_large', '错误码为 request_too_large')
  } finally { await env.close() }
})

await check('HT-07', '真实 HTTP：并发第二个请求 409，首个仍成功', async () => {
  const { connection } = browserAdmission()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const env = await mountOnLoopback({ connection, hostFactory: () => ({
    create() {},
    async dispatch(message) { await gate; return { done: message } },
    close() {},
  }) })
  try {
    const t1 = await ticket(env.base, { Cookie: BROWSER_COOKIE })
    const t2 = await ticket(env.base, { Cookie: BROWSER_COOKIE })
    const slow = post(`${env.base}/dispatch`, { ticket: t1, message: MESSAGE }, { Cookie: BROWSER_COOKIE })
    await new Promise(resolve => setTimeout(resolve, 60))
    const busy = await post(`${env.base}/dispatch`, { ticket: t2, message: MESSAGE }, { Cookie: BROWSER_COOKIE })
    need(busy.status === 409, `并发返回 409（收到 ${busy.status}）`)
    need(busy.body.error === 'sandbox_busy', '错误码为 sandbox_busy')
    release()
    const first = await slow
    need(first.status === 200, '首个请求最终成功')
  } finally { await env.close() }
})

await check('HT-08', '真实 HTTP：dispose 后不再受理，也不建宿主', async () => {
  const { connection } = browserAdmission()
  let created = 0
  const env = await mountOnLoopback({ connection, hostFactory: () => ({ create() { created += 1 }, dispatch() { return {} }, close() {} }) })
  await env.api.dispose()
  const after = await fetch(`${env.base}/health`, { headers: { Cookie: BROWSER_COOKIE } }).then(async res => ({ status: res.status, body: await res.json() }))
  need(after.status === 503, `dispose 后返回 503（收到 ${after.status}）`)
  // 两种都可接受：路由已被卸载（挂载方自答），或 handler 仍在但已关闭。
  need(['sandbox_closed', 'disposed'].includes(after.body?.error), `错误码表明已关闭（实际 ${JSON.stringify(after.body)}）`)
  need(created === 0, '关闭后不建宿主')
  await env.close()
})

await check('HT-09', '真实 HTTP 全链落在临时库：路径、隔离与复用', async () => {
  const { connection } = browserAdmission()
  let seen = null
  let factoryCalls = 0
  const env = await mountOnLoopback({ connection, hostFactory: () => {
    factoryCalls += 1
    const inner = createDevelopmentHost()
    return {
      create() { const info = inner.create(); seen = info.location; return info },
      dispatch(message) { return { recorded: message } },
      close() { return inner.close() },
    }
  } })
  try {
    const source = readFileSync(join(HERE, '../src/workflow/m0-browser-transport.mjs'), 'utf8')
    need(!PRODUCTION_LIKE.test(source), '通道源码不出现生产库文件名')
    need(seen === null, '惰性：未派发前不建宿主')

    const ok = await post(`${env.base}/dispatch`, { ticket: await ticket(env.base, { Cookie: BROWSER_COOKIE }), message: MESSAGE }, { Cookie: BROWSER_COOKIE })
    need(ok.status === 200, `派发成功（收到 ${ok.status}）`)
    need(seen !== null, '首次派发建了宿主')

    const tempRoot = tmpdir().replace(/\\/g, '/')
    const dbPath = String(seen.dbPath).replace(/\\/g, '/')
    need(dbPath.startsWith(tempRoot), `临时库在系统临时目录内（${dbPath}）`)
    need(!PRODUCTION_LIKE.test(dbPath), '临时库不是生产库')
    need(/dsh-workflow-development-/.test(dbPath), '临时库来自临时会话目录')
    need(existsSync(seen.dbPath), '临时库文件已建立')

    const again = await post(`${env.base}/dispatch`, { ticket: await ticket(env.base, { Cookie: BROWSER_COOKIE }), message: MESSAGE }, { Cookie: BROWSER_COOKIE })
    need(again.status === 200, '二次派发成功')
    need(factoryCalls === 1, '同一挂载只建一个宿主')
  } finally {
    await env.close()
    const dir = seen?.directory
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------- 汇总 */

const passed = results.filter(item => item.status === 'pass').length
const report = {
  scope: 'independent M0-B loopback HTTP review; temporary SQLite, synthetic content, fake host only',
  admissionClaim: 'browser admission proves an authenticated browser connection, not human presence',
  checks: results.length,
  passed,
  failed: results.filter(item => item.status !== 'pass'),
  assertions,
  results,
}
console.log(JSON.stringify(report, null, 2))
if (passed !== results.length) process.exitCode = 1
