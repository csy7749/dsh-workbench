/**
 * M0-B 浏览器沙盒通道专项复核（独立验证脚本，不改被测实现）。
 *
 * 范围声明：只验证「浏览器准入拒绝」「请求票据重放」「临时库隔离」三件事，
 * 以及它们与 Origin 栅栏、CSRF 头、方法/路径、并发、关闭、请求体上限的交互。
 *
 * 重要限制（写进断言，避免被后续引用成更强的结论）：
 *   - 通过 admission 只证明「请求来自已鉴权的浏览器连接」，不证明「屏幕前有人」。
 *   - /health 必须始终 humanIdentityVerified:false；任何脚本都不得据此宣称人工确认。
 *   - 本脚本只使用临时目录、脱敏内容与假宿主，不接触生产库、真实模型或正式写回。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BROWSER_WORKFLOW_PREFIX, mountBrowserWorkflow } from '../src/workflow/m0-browser-transport.mjs'
import { createDevelopmentHost } from '../src/workflow/m1-development-host.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCTION_LIKE = /dsh-workbench\.sqlite/

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

/* ---------------------------------------------------------------- 假 HTTP 载体 */

const makeReq = ({ method = 'GET', path = '/', headers = {}, body = null, peer = undefined } = {}) => {
  const req = { __peer: peer, url: `${BROWSER_WORKFLOW_PREFIX}${path}`, method, headers: { ...headers } }
  req[Symbol.asyncIterator] = async function* () {
    if (body === null || body === undefined) return
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    // 切成两段，覆盖跨 chunk 的缓冲拼接路径。
    const buffer = Buffer.from(text, 'utf8')
    const half = Math.max(1, Math.floor(buffer.length / 2))
    yield buffer.subarray(0, half)
    if (buffer.length > half) yield buffer.subarray(half)
  }
  return req
}

const makeRes = () => {
  let settle
  const done = new Promise(resolve => { settle = resolve })
  const res = {
    status: null,
    headers: null,
    body: null,
    done,
    writeHead(status, headers) { res.status = status; res.headers = headers ?? {} },
    end(payload) {
      res.body = payload === undefined ? null : JSON.parse(String(payload))
      settle(res)
    },
  }
  return res
}

const call = async (route, req) => {
  const res = makeRes()
  route.handler(req, res)
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('handler 未在 5s 内结束（可能挂起）')), 5000))
  await Promise.race([res.done, timer])
  return { status: res.status, headers: res.headers, body: res.body }
}

const JSON_HEADERS = { 'x-workflow-sandbox': '1', 'content-type': 'application/json' }
const SAME_ORIGIN = { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }
/** 票据现在绑定「载荷摘要」，所以每个用例都要先有确定的 message。 */
const MESSAGE = Object.freeze({ args: [{ op: 'inspect' }] })
const OTHER_MESSAGE = Object.freeze({ args: [{ op: 'advance' }] })

const mount = ({ connection, hostFactory } = {}) => {
  const routes = []
  const unregistered = []
  const register = route => {
    routes.push(route)
    return () => { unregistered.push(route) }
  }
  let disposeFn = null
  const api = mountBrowserWorkflow({
    connection,
    register,
    onDispose: fn => { disposeFn = fn },
    ...(hostFactory ? { hostFactory } : {}),
  })
  return { api, route: routes[0], routes, unregistered, get disposeFn() { return disposeFn } }
}

const browserConnection = () => {
  const peer = { id: 'peer-browser' }
  const stats = { admitted: 0 }
  return {
    peer,
    stats,
    connection: {
      browserPeer: peer,
      admit: req => {
        stats.admitted += 1
        return '__peer' in req && req.__peer !== undefined ? { peer: req.__peer } : { peer }
      },
    },
  }
}

const stubHost = ({ dispatch } = {}) => {
  const state = { created: 0, dispatched: [], closed: 0 }
  return {
    state,
    factory: () => ({
      create() { state.created += 1; return { state: 'open' } },
      dispatch(message) {
        state.dispatched.push(message)
        return dispatch ? dispatch(message, state) : { echoed: message }
      },
      close() { state.closed += 1; return { state: 'closed' } },
    }),
  }
}

const issueTicket = async (route, message = MESSAGE) => {
  const { status, body } = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: JSON_HEADERS, body: { message } }))
  if (status !== 200) throw new Error(`票据发放失败: ${status} ${JSON.stringify(body)}`)
  return body.ticket
}

const dispatch = (route, { ticket, message = MESSAGE, peer, headers = JSON_HEADERS }) =>
  call(route, makeReq({ method: 'POST', path: '/dispatch', headers, body: { ticket, message }, ...(peer ? { peer } : {}) }))

/* ------------------------------------------------------------------ 检查项 */

await check('BT-01', '装配：前缀路由、dispose 注册与卸载', async () => {
  const { api, route, unregistered, disposeFn } = mount({ connection: browserConnection().connection })
  need(BROWSER_WORKFLOW_PREFIX === '/workbench-workflow-sandbox', '前缀常量未被改动')
  need(route !== undefined, 'register 收到一条路由')
  need(route.kind === 'prefix', '路由是前缀路由')
  need(route.path === BROWSER_WORKFLOW_PREFIX, '路由路径等于前缀常量')
  need(typeof route.handler === 'function', '路由带 handler')
  need(typeof disposeFn === 'function', 'onDispose 收到 dispose 函数')
  need(api.dispose === disposeFn, '返回的 dispose 与 onDispose 注册的是同一个')
  api.dispose()
  need(unregistered.length === 1, 'dispose 卸载了路由')
})

await check('BT-02', '准入能力缺失：503 browser_admission_unavailable', async () => {
  for (const connection of [undefined, null, {}, { browserPeer: { id: 'p' } }, { admit() {} }]) {
    const { route, api } = mount({ connection })
    const { status, body } = await call(route, makeReq({ path: '/health' }))
    need(status === 503, `无准入能力时返回 503（收到 ${status}）`)
    need(body?.error === 'browser_admission_unavailable', '错误码为 browser_admission_unavailable')
    api.dispose()
  }
})

await check('BT-03', '准入被拒：403 browser_session_required，且不触达宿主', async () => {
  let created = 0
  const connection = { browserPeer: { id: 'peer-browser' }, admit: () => ({ rejection: 403 }) }
  const { route, api } = mount({
    connection,
    hostFactory: () => { created += 1; return { create() {}, dispatch() { return {} }, close() {} } },
  })
  const { status, body } = await call(route, makeReq({ method: 'POST', path: '/dispatch', headers: JSON_HEADERS, body: {} }))
  need(status === 403, `拒绝请求返回 403（收到 ${status}）`)
  need(body?.error === 'browser_session_required', '错误码为 browser_session_required')
  need(created === 0, '被拒请求没有创建宿主')
  api.dispose()
})

await check('BT-04', '非浏览器 Peer（API 凭证）不能进入沙盒，也不消耗浏览器票据', async () => {
  const { connection } = browserConnection()
  const apiPeer = { id: 'peer-api' }
  const host = stubHost()
  const { route, api } = mount({ connection, hostFactory: host.factory })

  const ticket = await issueTicket(route)
  const foreign = await dispatch(route, { ticket, peer: apiPeer })
  need(foreign.status === 403, `API Peer 被拒（收到 ${foreign.status}）`)
  need(foreign.body?.error === 'browser_session_required', '错误码为 browser_session_required')
  need(host.state.created === 0, 'API Peer 未创建宿主')

  const legitimate = await dispatch(route, { ticket })
  need(legitimate.status === 200, `浏览器票据仍可用（收到 ${legitimate.status}）`)
  need(host.state.created === 1, '只有浏览器请求创建了宿主')

  const spy = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: JSON_HEADERS, body: { message: MESSAGE }, peer: apiPeer }))
  need(spy.status === 403, 'API Peer 连票据端点也被拒')
  api.dispose()
})

await check('BT-05', '/health 只陈述沙盒事实，明确不宣称人工身份', async () => {
  const host = stubHost()
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })
  const { status, body, headers } = await call(route, makeReq({ path: '/health' }))
  need(status === 200, `/health 返回 200（收到 ${status}）`)
  need(body?.enabled === true, 'enabled 为 true')
  need(body?.mode === 'temporary-fake', 'mode 为 temporary-fake')
  need(body?.humanIdentityVerified === false, 'humanIdentityVerified 必须为 false')
  need(headers?.['Cache-Control'] === 'no-store', '响应带 Cache-Control: no-store')
  need(host.state.created === 0, '健康探针不创建宿主')
  api.dispose()
})

await check('BT-06', '方法 / 路径 / CSRF 头三门先于宿主', async () => {
  const host = stubHost()
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })

  const put = await call(route, makeReq({ method: 'PUT', path: '/health' }))
  need(put.status === 405, `非 GET/POST 返回 405（收到 ${put.status}）`)

  const unknown = await call(route, makeReq({ method: 'POST', path: '/nope', headers: JSON_HEADERS, body: { message: MESSAGE } }))
  need(unknown.status === 404, `未知路径返回 404（收到 ${unknown.status}）`)
  need(unknown.body?.error === 'not_found', '错误码为 not_found')

  const noHeader = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: { 'content-type': 'application/json' }, body: { message: MESSAGE } }))
  need(noHeader.status === 403, `缺沙盒头返回 403（收到 ${noHeader.status}）`)
  need(noHeader.body?.error === 'sandbox_header_required', '错误码为 sandbox_header_required')

  const wrongType = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: { 'x-workflow-sandbox': '1', 'content-type': 'text/plain' }, body: '' }))
  need(wrongType.status === 403, `非 JSON 内容类型返回 403（收到 ${wrongType.status}）`)

  const badValue = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: { 'x-workflow-sandbox': 'yes', 'content-type': 'application/json' }, body: { message: MESSAGE } }))
  need(badValue.status === 403, '沙盒头值必须恰为 1')

  need(host.state.created === 0, '三道门都先于宿主创建')
  api.dispose()
})

await check('BT-07', '票据一次性：重放同一票据与同一载荷被拒', async () => {
  const host = stubHost()
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })
  const ticket = await issueTicket(route)

  const first = await dispatch(route, { ticket })
  need(first.status === 200, `首次派发成功（收到 ${first.status}）`)
  need(first.body?.result?.echoed?.args?.[0]?.op === 'inspect', 'message 原样传给宿主并回传结果')

  const replay = await dispatch(route, { ticket })
  need(replay.status === 403, `重放返回 403（收到 ${replay.status}）`)
  need(replay.body?.error === 'ticket_invalid', '错误码为 ticket_invalid')
  need(host.state.created === 1, '重放没有再次创建宿主')
  need(host.state.dispatched.length === 1, '重放没有第二次触达宿主')
  api.dispose()
})

await check('BT-08', '票据绑定 Peer：非浏览器 Peer 引用票据不会烧掉它', async () => {
  const { connection, peer } = browserConnection()
  const host = stubHost()
  const { route, api } = mount({ connection, hostFactory: host.factory })
  const ticket = await issueTicket(route)

  const stolen = await dispatch(route, { ticket, peer: { id: 'peer-other' } })
  need(stolen.status === 403, '其他 Peer 被拒')
  need(host.state.dispatched.length === 0, '其他 Peer 没有触达宿主')

  const genuine = await dispatch(route, { ticket, peer })
  need(genuine.status === 200, `真正浏览器仍可用该票据（收到 ${genuine.status}）`)
  api.dispose()
})

await check('BT-09', '票据过期：超过 30s 后不可用', async () => {
  const host = stubHost()
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const ticket = await issueTicket(route)
    now += 30_001
    const expired = await dispatch(route, { ticket })
    need(expired.status === 403, `过期票据返回 403（收到 ${expired.status}）`)
    need(expired.body?.error === 'ticket_invalid', '错误码为 ticket_invalid')
    need(host.state.created === 0, '过期票据不创建宿主')
  } finally {
    Date.now = realNow
  }
  api.dispose()
})

await check('BT-10', '未取用票据有上限：第 65 张返回 429 ticket_limit', async () => {
  const host = stubHost()
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })
  const seen = new Set()
  for (let i = 0; i < 64; i += 1) seen.add(await issueTicket(route))
  need(seen.size === 64, '64 张票据互不相同')
  const overflow = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: JSON_HEADERS, body: { message: MESSAGE } }))
  need(overflow.status === 429, `第 65 张返回 429（收到 ${overflow.status}）`)
  need(overflow.body?.error === 'ticket_limit', '错误码为 ticket_limit')
  need(host.state.created === 0, '只发票据不创建宿主')
  api.dispose()
})

await check('BT-11', '同一挂载串行执行：进行中返回 409 sandbox_busy', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const host = stubHost({ dispatch: async message => { await gate; return { done: message } } })
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })

  const firstTicket = await issueTicket(route)
  const secondTicket = await issueTicket(route)

  const firstRes = makeRes()
  route.handler(makeReq({ method: 'POST', path: '/dispatch', headers: JSON_HEADERS, body: { ticket: firstTicket, message: MESSAGE } }), firstRes)
  await new Promise(resolve => setTimeout(resolve, 20))

  const busy = await dispatch(route, { ticket: secondTicket })
  need(busy.status === 409, `并发请求返回 409（收到 ${busy.status}）`)
  need(busy.body?.error === 'sandbox_busy', '错误码为 sandbox_busy')

  release()
  await Promise.race([firstRes.done, new Promise((_, reject) => setTimeout(() => reject(new Error('首个请求未结束')), 5000))])
  need(firstRes.status === 200, '首个请求最终成功')
  need(firstRes.body?.result?.done?.args?.[0]?.op === 'inspect', '首个请求结果正确')
  need(host.state.dispatched.length === 1, '并发期间没有第二次执行')
  api.dispose()
})

await check('BT-12', '关闭：先释放宿主再拒绝新请求，并卸载路由', async () => {
  const host = stubHost()
  const { route, api, unregistered } = mount({ connection: browserConnection().connection, hostFactory: host.factory })
  const ticket = await issueTicket(route)
  const ok = await dispatch(route, { ticket })
  need(ok.status === 200, '关闭前可派发')
  need(host.state.created === 1, '关闭前宿主已创建')

  api.dispose()
  need(host.state.closed === 1, 'dispose 关闭了宿主')
  need(unregistered.length === 1, 'dispose 卸载了路由')

  const after = await call(route, makeReq({ path: '/health' }))
  need(after.status === 503, `关闭后返回 503（收到 ${after.status}）`)
  need(after.body?.error === 'sandbox_closed', '错误码为 sandbox_closed')

  const nextTicket = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: JSON_HEADERS, body: { message: MESSAGE } }))
  need(nextTicket.status === 503, '关闭后不再发新票据')
})

await check('BT-13', '请求体上限：超过 1MiB 直接拒绝且不创建宿主', async () => {
  const host = stubHost()
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })
  const huge = JSON.stringify({ message: { args: [{ op: 'x'.repeat(1_200_000) }] } })
  const over = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: JSON_HEADERS, body: huge }))
  need(over.status === 400, `超大请求返回 400（收到 ${over.status}）`)
  need(over.body?.error === 'request_too_large', '错误码为 request_too_large')
  need(host.state.created === 0, '超大请求没有创建宿主')
  api.dispose()
})

await check('BT-14', '临时库隔离：默认宿主落在临时目录，二次派发复用同一宿主', async () => {
  const source = readFileSync(join(HERE, '../src/workflow/m0-browser-transport.mjs'), 'utf8')
  need(!PRODUCTION_LIKE.test(source), '通道实现本身不出现生产库文件名')

  let real = null
  let factoryCalls = 0
  let dispatchCalls = 0
  const factory = () => {
    factoryCalls += 1
    const inner = createDevelopmentHost()
    return {
      create() { const info = inner.create(); real = info; return info },
      dispatch(message) { dispatchCalls += 1; return { recorded: message } },
      close() { return inner.close() },
    }
  }

  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: factory })
  try {
    need(real === null, '惰性：装配时不创建宿主')
    const health = await call(route, makeReq({ path: '/health' }))
    need(health.status === 200 && health.body.humanIdentityVerified === false, '健康探针仍不宣称人工身份')
    need(real === null, '健康探针不创建宿主')

    const ticket = await issueTicket(route)
    const first = await dispatch(route, { ticket })
    need(first.status === 200, `派发成功（收到 ${first.status}）`)
    need(real !== null, '首次派发创建了宿主')

    need(real.state === 'open', '宿主 create 后为 open')
    const location = real.location
    need(location !== null && typeof location === 'object', 'create() 回传 location')
    const tempRoot = tmpdir().replace(/\\/g, '/')
    const dbPath = String(location.dbPath).replace(/\\/g, '/')
    need(dbPath.startsWith(tempRoot), `dbPath 在系统临时目录内（${dbPath}）`)
    need(!PRODUCTION_LIKE.test(dbPath), 'dbPath 不是生产库')
    need(/dsh-workflow-development-/.test(dbPath), 'dbPath 来自临时会话目录前缀')
    need(existsSync(location.dbPath), '临时库文件确实已建立')
    need(String(location.directory).replace(/\\/g, '/') !== String(location.root).replace(/\\/g, '/'), '目录与内容根分离')

    const second = await dispatch(route, { ticket: await issueTicket(route) })
    need(second.status === 200, '二次派发成功')
    need(factoryCalls === 1, '同一挂载只创建一个宿主')
    need(dispatchCalls === 2, '两次派发都进入同一宿主')
    need(real.state === 'open', '复用期间宿主保持 open')
  } finally {
    api.dispose()
    const cleanup = real?.location?.directory
    if (cleanup && existsSync(cleanup)) rmSync(cleanup, { recursive: true, force: true })
  }
})

await check('BT-15', 'Origin 栅栏先于准入：跨站 Origin 被拒且不调用 admit', async () => {
  const { connection, stats } = browserConnection()
  const host = stubHost()
  const { route, api } = mount({ connection, hostFactory: host.factory })

  const crossSite = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site', host: '127.0.0.1:8080', origin: 'http://evil.example' }, body: { message: MESSAGE } }))
  need(crossSite.status === 403, `跨站 Origin 返回 403（收到 ${crossSite.status}）`)
  need(crossSite.body?.error === 'origin_rejected', '错误码为 origin_rejected')
  need(stats.admitted === 0, 'Origin 栅栏发生在 admit 之前（admit 未被调用）')

  const nullOrigin = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: { ...JSON_HEADERS, host: '127.0.0.1:8080', origin: 'null' }, body: { message: MESSAGE } }))
  need(nullOrigin.status === 400, `无法解析的 Origin 返回 400（收到 ${nullOrigin.status}）`)

  const fileOrigin = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: { ...JSON_HEADERS, host: '127.0.0.1:8080', origin: 'file:///tmp/x' }, body: { message: MESSAGE } }))
  need(fileOrigin.status === 403, `非 http(s) Origin 返回 403（收到 ${fileOrigin.status}）`)
  need(fileOrigin.body?.error === 'origin_rejected', '错误码为 origin_rejected')
  need(host.state.created === 0, 'Origin 栅栏全程未创建宿主')
  api.dispose()
})

await check('BT-16', '同源 Origin 放行，且与取消 Origin 头等价', async () => {
  const host = stubHost()
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })

  const withOrigin = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: { ...JSON_HEADERS, ...SAME_ORIGIN }, body: { message: MESSAGE } }))
  need(withOrigin.status === 200, `同源 Origin 发放票据（收到 ${withOrigin.status}）`)

  const noOrigin = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: JSON_HEADERS, body: { message: MESSAGE } }))
  need(noOrigin.status === 200, '不带 Origin 头的浏览器请求仍可用（由 cookie 准入负责）')

  const httpsMismatch = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: { ...JSON_HEADERS, host: '127.0.0.1:8080', origin: 'https://127.0.0.1:8080' }, body: { message: MESSAGE } }))
  need(httpsMismatch.status === 200, '协议不同但 host 相同按实现放行（记录现状，不改实现）')
  api.dispose()
})

await check('BT-17', '票据发放要求显式 message.args 数组', async () => {
  const host = stubHost()
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })
  for (const body of [{}, { message: null }, { message: {} }, { message: { args: 'x' } }, { message: { args: {} } }]) {
    const { status, body: reply } = await call(route, makeReq({ method: 'POST', path: '/ticket', headers: JSON_HEADERS, body }))
    need(status === 400, `非法 message 返回 400（收到 ${status} / ${JSON.stringify(body)}）`)
    need(reply?.error === 'development_message_invalid', '错误码为 development_message_invalid')
  }
  need(host.state.created === 0, '非法 message 不创建宿主')
  api.dispose()
})

await check('BT-18', '票据绑定载荷摘要：改载荷即失效，且票据一律一次性', async () => {
  const host = stubHost()
  const { route, api } = mount({ connection: browserConnection().connection, hostFactory: host.factory })
  const ticket = await issueTicket(route, MESSAGE)

  const swapped = await dispatch(route, { ticket, message: OTHER_MESSAGE })
  need(swapped.status === 403, `换载荷返回 403（收到 ${swapped.status}）`)
  need(swapped.body?.error === 'ticket_invalid', '错误码为 ticket_invalid')
  need(host.state.dispatched.length === 0, '换载荷没有触达宿主')

  const afterSwap = await dispatch(route, { ticket, message: MESSAGE })
  need(afterSwap.status === 403, '被换载荷尝试后，原票据也已作废（一次性，不复活）')

  const reordered = { note: 'x', args: [{ op: 'inspect' }] }
  const ticket2 = await issueTicket(route, reordered)
  const exact = await dispatch(route, { ticket: ticket2, message: reordered })
  need(exact.status === 200, '同序载荷与票据匹配即可派发')
  const finalTicket = await issueTicket(route, reordered)
  const differentOrder = { args: [{ op: 'inspect' }], note: 'x' }
  const orderMismatch = await dispatch(route, { ticket: finalTicket, message: differentOrder })
  need(orderMismatch.status === 403, 'JSON 键序不同视为不同载荷（记录现状：客户端必须保持键序）')
  api.dispose()
})

/* -------------------------------------------------------------------- 汇总 */

const passed = results.filter(item => item.status === 'pass').length
const report = {
  scope: 'independent M0-B browser sandbox review; temporary SQLite, synthetic content, fake host only',
  admissionClaim: 'browser admission proves an authenticated browser connection, not human presence',
  checks: results.length,
  passed,
  failed: results.filter(item => item.status !== 'pass'),
  assertions,
  results,
}
console.log(JSON.stringify(report, null, 2))
if (passed !== results.length) process.exitCode = 1
