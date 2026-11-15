/**
 * 工作流内测页薄挂载与初始化失败隔离（W1-07 / A13 子批）。
 *
 * 验的是构建产物 lib/index.js（真注册路由、真建库），不是源码镜像：
 *   ① 默认关闭：不注册 /workbench-workflow、不建工作流库，旧面板只看到 /workbench-api；
 *   ② 开启后薄路由可用，工作流状态只落独立 SQLite 文件；
 *   ③ 初始化失败（库文件位置被目录占住）只让新路由 503，旧 /state、旧笔记逐字节不变；
 *   ④ 无 SQLite 时独立禁用，绝不退回 JSON 写工作流（A13 原文）；
 *   ⑤ 库文件物理隔离：同路径 / 相对段 / 大小写 / 硬链接 / 符号链接 / 指向旧库的改名副本
 *      一律在建表之前拒绝，旧库既不出现 workflow_* 表，legacy_marker 也原样保留。
 *
 * 用法：node scripts/verify-workflow-page-mount.mjs
 * 前置：pnpm run bundle:host（脚本会检测 lib/index.js 是否已包含内核代码）。
 */
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import('../lib/index.js')

let checks = 0
let passed = 0
let assertions = 0
const results = []

function need(ok, message) {
  assertions += 1
  if (!ok) throw new Error(message)
}

function eq(actual, expected, label) {
  assertions += 1
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

async function check(id, title, fn) {
  checks += 1
  try {
    const detail = await fn()
    passed += 1
    results.push({ id, title, ok: true, detail })
    console.log(`  ✓ ${id} ${title}`)
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`)
  } catch (cause) {
    results.push({ id, title, ok: false, error: String(cause?.message ?? cause) })
    console.log(`  ✗ ${id} ${title}\n      ${String(cause?.message ?? cause)}`)
  }
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `dsh-workflow-page-${prefix}-`))
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 清理临时目录。Windows 上被测宿主实例的 SQLite WAL 句柄还开在本进程里，
 * 目录删不掉是预期行为（不是泄漏的子进程），保留路径并注明，交给系统回收；
 * 其它错误照常抛出，别把真问题一起吞掉。
 */
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (cause) {
    const code = String(cause?.code ?? '')
    if (code !== 'EPERM' && code !== 'EBUSY') throw cause
    console.log(`      · 临时目录保留（本进程仍持有库句柄）：${dir}`)
  }
}

/** 一次宿主装载：假 ctx 捕获注册的路由，apply 之后可按前缀发假请求。 */
function boot(dir, extraEnv = {}) {
  process.env.DSH_HOME = dir
  process.env.DSH_WORKBENCH_DB = join(dir, 'legacy.sqlite')
  for (const key of ['DSH_WORKBENCH_WORKFLOW_PAGE', 'DSH_WORKBENCH_WORKFLOW_DB']) delete process.env[key]
  Object.assign(process.env, extraEnv)
  const routes = []
  const tools = {}
  const disposers = []
  const ctx = {
    effect: (cb) => { try { cb() } catch { /* ignore */ } return () => {} },
    tools: { register: (tool) => { tools[tool.name] = tool; return () => {} } },
    webServer: { register: (route) => { routes.push(route); return () => {} }, tapIndex: () => () => {} },
    get: () => undefined,
  }
  mod.apply(ctx)
  const find = (prefix) => routes.find((route) => route.path === prefix)
  const call = (prefix, method, path, body) => new Promise((resolve) => {
    const route = find(prefix)
    if (route === undefined) { resolve({ status: 0, body: { error: 'route_not_registered' } }); return }
    let last = { status: 0 }
    const req = { url: `${prefix}${path}`, method, json: async () => body ?? {}, on() {} }
    const res = {
      writeHead(status) { last.status = status },
      end(payload) {
        if (payload !== undefined) { try { last.body = JSON.parse(String(payload)) } catch { last.body = String(payload) } }
        resolve(last)
      },
    }
    route.handler(req, res)
  })
  return { dir, routes, tools, call, find, disposers, env: () => process.env }
}

const LEGACY = '/workbench-api'
const PAGE = '/workbench-workflow'

const page = {
  mountWorkflowPage: mod.mountWorkflowPage,
  workflowPageEnabled: mod.workflowPageEnabled,
  WORKFLOW_PAGE_PREFIX: mod.WORKFLOW_PAGE_PREFIX,
  WORKFLOW_PAGE_ENABLED_ENV: mod.WORKFLOW_PAGE_ENABLED_ENV,
}

console.log('W1-07/A13 工作流内测页薄挂载')

await check('PM-01', '开关只认显式打开：1/on/true/yes 才算开，其余一律关', () => {
  need(typeof page.workflowPageEnabled === 'function', 'workflowPageEnabled 未从构建产物导出')
  eq(page.workflowPageEnabled({}), false, '缺省')
  eq(page.workflowPageEnabled({ [page.WORKFLOW_PAGE_ENABLED_ENV]: '' }), false, '空串')
  for (const off of ['0', 'off', 'no', 'false', 'disabled']) {
    eq(page.workflowPageEnabled({ [page.WORKFLOW_PAGE_ENABLED_ENV]: off }), false, off)
  }
  for (const on of ['1', 'on', 'true', 'yes', ' TRUE ']) {
    eq(page.workflowPageEnabled({ [page.WORKFLOW_PAGE_ENABLED_ENV]: on }), true, on)
  }
  return { accepted: ['1', 'on', 'true', 'yes'] }
})

await check('PM-02', '关闭时不注册路由、不打开内核、不建库文件', () => {
  const dir = tmp('off')
  const registered = []
  const opened = []
  const mounted = page.mountWorkflowPage({
    engine: 'sqlite',
    dataDir: dir,
    env: {},
    register: (route) => { registered.push(route); return () => {} },
    openKernel: (...args) => { opened.push(args); return {} },
  })
  eq(mounted.enabled, false, 'enabled')
  eq(mounted.reason, 'disabled_by_config', 'reason')
  eq(registered.length, 0, '注册路由数')
  eq(opened.length, 0, '打开内核次数')
  need(!existsSync(join(dir, 'dsh-workbench-workflow.sqlite')), '关闭状态下不应创建工作流库')
  need(!existsSync(join(dir, 'workflow')), '关闭状态下不应创建 workflow 目录')
  cleanup(dir)
  return { reason: mounted.reason, routes: registered.length, kernelOpened: opened.length }
})

await check('PM-03', '无 SQLite 时独立禁用：不退回 JSON、不打开内核、不注册路由', () => {
  const dir = tmp('json')
  const registered = []
  const opened = []
  const mounted = page.mountWorkflowPage({
    engine: 'json',
    dataDir: dir,
    env: { [page.WORKFLOW_PAGE_ENABLED_ENV]: '1' },
    register: (route) => { registered.push(route); return () => {} },
    openKernel: (...args) => { opened.push(args); return {} },
  })
  eq(mounted.enabled, false, 'enabled')
  eq(mounted.reason, 'workflow_requires_sqlite', 'reason')
  eq(registered.length, 0, '注册路由数')
  eq(opened.length, 0, '打开内核次数')
  need(!existsSync(join(dir, 'dsh-workbench-workflow.json')), '不得改写成 JSON 工作流文件')
  need(!existsSync(join(dir, 'dsh-workbench-workflow.sqlite')), '不得创建 SQLite 文件')
  cleanup(dir)
  return { reason: mounted.reason }
})

await check('PM-04', '初始化失败只让新路由 503，旧路由与旧数据不受影响（反例核心）', async () => {
  const dir = tmp('fail')
  /* 先正常起一次，写一条旧数据并记下指纹 */
  const clean = boot(dir)
  const beforeState = await clean.call(LEGACY, 'GET', '/state')
  need(beforeState.status === 200, `旧 /state 首次读取失败：${JSON.stringify(beforeState)}`)
  const wrote = await clean.call(LEGACY, 'POST', '/notebooks', { notebook: { name: '旧笔记·失败隔离' } })
  need(wrote.status === 200, `旧笔记本写入失败：${JSON.stringify(wrote)}`)
  const beforeNotes = await clean.call(LEGACY, 'GET', '/notebooks')
  const legacyDb = join(dir, 'legacy.sqlite')
  const legacyHash = sha(legacyDb)
  const legacySize = statSync(legacyDb).size

  /* 再用「库文件位置被目录占住」制造初始化失败：SQLite 无法以目录为库 */
  const blockedDb = join(dir, 'blocked.sqlite')
  mkdirSync(blockedDb)
  const broken = boot(dir, { DSH_WORKBENCH_WORKFLOW_PAGE: '1', DSH_WORKBENCH_WORKFLOW_DB: blockedDb })
  need(broken.find(PAGE) !== undefined, '初始化失败时仍应注册新路由（用于告知不可用）')
  const health = broken.call(PAGE, 'GET', '/health')
  const failed = await health
  eq(failed.status, 503, '失败态状态码')
  eq(failed.body?.error, 'workflow_disabled', '失败态错误码')
  eq(failed.body?.reason, 'workflow_init_failed', '失败态原因')
  need(typeof failed.body?.message === 'string' && failed.body.message.length > 0, '失败态应带可读原因')

  const afterState = await broken.call(LEGACY, 'GET', '/state')
  const afterNotes = await broken.call(LEGACY, 'GET', '/notebooks')
  eq(afterState.status, 200, '失败后旧 /state 状态码')
  eq(afterState.body, beforeState.body, '失败前后旧 /state')
  eq(afterNotes.body, beforeNotes.body, '失败前后旧笔记')
  eq(sha(legacyDb), legacyHash, '旧库文件哈希')
  eq(statSync(legacyDb).size, legacySize, '旧库文件大小')
  need(!existsSync(join(dir, 'workflow')), '初始化失败不应创建 workflow 对象目录')
  need(!existsSync(join(dir, 'dsh-workbench-workflow.sqlite')), '初始化失败不应创建默认工作流库')
  cleanup(dir)
  return {
    disabled: `${failed.body.error}:${failed.body.reason}`,
    message: failed.body.message,
    legacyHashUnchanged: true,
    legacyStateUnchanged: true,
  }
})

await check('PM-05', '开启后薄路由可用：health / runs / run 详情只读内核独立库', async () => {
  const dir = tmp('on')
  const app = boot(dir, { DSH_WORKBENCH_WORKFLOW_PAGE: '1' })
  const workflowDb = join(dir, 'dsh-workbench-workflow.sqlite')
  need(existsSync(workflowDb), '开启后应创建工作流独立库')
  need(existsSync(join(dir, 'workflow', 'objects')), '开启后应创建独立对象目录')
  const health = await app.call(PAGE, 'GET', '/health')
  eq(health.status, 200, 'health 状态码')
  eq(health.body?.enabled, true, 'health enabled')
  eq(health.body?.engine, 'sqlite', 'health engine')
  eq(health.body?.runs, 0, 'health 初始运行数')
  const empty = await app.call(PAGE, 'GET', '/runs')
  eq(empty.status, 200, 'runs 状态码')
  eq(empty.body?.runs, [], 'runs 初始为空')
  const missing = await app.call(PAGE, 'GET', '/runs/nope')
  eq(missing.status, 404, '缺失运行状态码')
  eq(missing.body?.error, 'run_not_found', '缺失运行错误码')
  const unknown = await app.call(PAGE, 'GET', '/nope')
  eq(unknown.status, 404, '未知路径状态码')

  /* 旧面板照常：同一进程内 /workbench-api 与 /workbench-workflow 并存 */
  const legacy = await app.call(LEGACY, 'GET', '/state')
  eq(legacy.status, 200, '旧 /state 状态码')
  const legacyHealth = await app.call(LEGACY, 'GET', '/health')
  eq(legacyHealth.body?.engine, 'sqlite', '旧 /health 仍在')
  need(!existsSync(join(dir, 'dsh-workbench-workflow.json')), '开启后也不得写 JSON 工作流副本')
  cleanup(dir)
  return { health: health.body, runs: empty.body.runs.length }
})

await check('PM-06', '默认关闭：宿主只注册 /workbench-api，旧面板数据可读写', async () => {
  const dir = tmp('default')
  const app = boot(dir)
  const paths = app.routes.map((route) => route.path)
  eq(paths, [LEGACY], '注册路由清单')
  need(!existsSync(join(dir, 'dsh-workbench-workflow.sqlite')), '默认关闭不应建工作流库')
  const state = await app.call(LEGACY, 'GET', '/state')
  eq(state.status, 200, '旧 /state 状态码')
  need(Array.isArray(state.body?.spaces), '旧 /state 应含 spaces')
  const wrote = await app.call(LEGACY, 'POST', '/notebooks', { notebook: { name: '默认关闭下仍可写' } })
  eq(wrote.status, 200, '旧笔记本写入状态码')
  const notes = await app.call(LEGACY, 'GET', '/notebooks')
  need(JSON.stringify(notes.body).includes('默认关闭下仍可写'), '旧笔记本应可读回')
  const workflowCall = await app.call(PAGE, 'GET', '/health')
  eq(workflowCall.status, 0, '新路由未注册时不可调用')
  cleanup(dir)
  return { routes: paths, workflowDbCreated: false }
})

await check('PM-07', '开启再从失败态恢复：旧数据逐字节不变、工作流库独立', async () => {
  const dir = tmp('recover')
  /* 关闭态写旧数据 → 开启态读 → 再失败态读，三段指纹一致 */
  const off = boot(dir)
  await off.call(LEGACY, 'POST', '/notebooks', { notebook: { name: '旧数据·跨开关' } })
  const legacyDb = join(dir, 'legacy.sqlite')
  const hashOff = sha(legacyDb)
  const stateOff = (await off.call(LEGACY, 'GET', '/state')).body
  const notesOff = (await off.call(LEGACY, 'GET', '/notebooks')).body

  const on = boot(dir, { DSH_WORKBENCH_WORKFLOW_PAGE: '1' })
  const stateOn = (await on.call(LEGACY, 'GET', '/state')).body
  const notesOn = (await on.call(LEGACY, 'GET', '/notebooks')).body
  eq(stateOn, stateOff, '开启态旧 /state')
  eq(notesOn, notesOff, '开启态旧笔记')
  eq(sha(legacyDb), hashOff, '开启态旧库哈希')

  const workflowDb = join(dir, 'dsh-workbench-workflow.sqlite')
  need(existsSync(workflowDb), '开启态应建工作流库')
  need(workflowDb !== legacyDb, '工作流库必须是独立文件')
  const pageHealth = await on.call(PAGE, 'GET', '/health')
  eq(pageHealth.status, 200, '开启态新路由可用')

  /* 再切回关闭：新路由消失，旧数据仍一致 */
  const offAgain = boot(dir)
  eq(offAgain.routes.map((route) => route.path), [LEGACY], '回关闭后路由清单')
  eq((await offAgain.call(LEGACY, 'GET', '/state')).body, stateOff, '回关闭后旧 /state')
  eq((await offAgain.call(LEGACY, 'GET', '/notebooks')).body, notesOff, '回关闭后旧笔记')
  cleanup(dir)
  return { legacyHashUnchanged: true, workflowDbSeparate: true }
})

await check('PM-08', '构建产物真的带内核：lib/index.js 含内核 SQL 与测试注入点', () => {
  const bundle = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  for (const fragment of ['PRAGMA busy_timeout', 'workflow_runs', 'snapshot_metadata_mismatch', '/workbench-workflow', 'DSH_WORKBENCH_WORKFLOW_PAGE']) {
    need(bundle.includes(fragment), `构建产物缺少片段：${fragment}`)
  }
  return { bytes: Buffer.byteLength(bundle), fragments: 5 }
})

/** 直接读 SQLite 的表清单与 marker 值：用来证明旧库到底被写没被写。 */
function legacyTables(file) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name))
    const hasMeta = tables.includes('meta')
    const marker = hasMeta ? db.prepare('SELECT value FROM meta WHERE key = ?').get('legacy_marker') : undefined
    return { tables, workflowTables: tables.filter((name) => name.startsWith('workflow_')), marker: marker === undefined ? null : String(marker.value) }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

await check('PM-09', '反例：工作流库指向旧库同一路径时必须拒绝，旧库不得出现 workflow_* 表', async () => {
  const dir = tmp('same')
  const legacyDb = join(dir, 'legacy.sqlite')
  /* 先正常起一次：写旧数据并打上 legacy_marker（复现老大的反例现场） */
  const clean = boot(dir)
  await clean.call(LEGACY, 'POST', '/notebooks', { notebook: { name: '旧数据·同路径冲突' } })
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const writer = new DatabaseSync(legacyDb)
  writer.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('legacy_marker', 'KEEP-ME')
  writer.close()
  const before = legacyTables(legacyDb)
  need(before.marker === 'KEEP-ME', `legacy_marker 未写入：${JSON.stringify(before)}`)
  eq(before.workflowTables, [], '冲突前旧库不应有 workflow_* 表')
  const hashBefore = sha(legacyDb)
  const stateBefore = (await clean.call(LEGACY, 'GET', '/state')).body
  const notesBefore = (await clean.call(LEGACY, 'GET', '/notebooks')).body

  /* 显式把工作流库指到旧库本身 */
  const conflict = boot(dir, { DSH_WORKBENCH_WORKFLOW_PAGE: '1', DSH_WORKBENCH_WORKFLOW_DB: legacyDb })
  need(conflict.find(PAGE) !== undefined, '冲突时应注册一条只回 503 的路由')
  const health = await conflict.call(PAGE, 'GET', '/health')
  eq(health.status, 503, '冲突态状态码')
  eq(health.body?.error, 'workflow_disabled', '冲突态错误码')
  eq(health.body?.reason, 'workflow_db_conflict', '冲突态原因')
  need(String(health.body?.message ?? '').includes('same_path'), `冲突原因应指路径相同：${health.body?.message}`)

  /* 旧库必须一字未动：没有 workflow_* 表、marker 还在、哈希不变、旧 API 照常 */
  const after = legacyTables(legacyDb)
  eq(after.workflowTables, [], '冲突后旧库仍不应出现 workflow_* 表')
  eq(after.marker, 'KEEP-ME', '冲突后 legacy_marker')
  eq(sha(legacyDb), hashBefore, '冲突后旧库哈希')
  eq((await conflict.call(LEGACY, 'GET', '/state')).body, stateBefore, '冲突后旧 /state')
  eq((await conflict.call(LEGACY, 'GET', '/notebooks')).body, notesBefore, '冲突后旧笔记')
  need(!existsSync(join(dir, 'workflow')), '冲突时不应创建 workflow 对象目录')
  cleanup(dir)
  return { reason: health.body.reason, detail: health.body.message, legacyWorkflowTables: after.workflowTables, marker: after.marker, legacyHashUnchanged: true }
})

await check('PM-10', '反例：相对段 / 大小写 / 硬链接 / 符号链接别名一律按同一文件拒绝', async () => {
  const dir = tmp('alias')
  const legacyDb = join(dir, 'legacy.sqlite')
  const clean = boot(dir)
  await clean.call(LEGACY, 'POST', '/notebooks', { notebook: { name: '旧数据·别名冲突' } })
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const writer = new DatabaseSync(legacyDb)
  writer.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('legacy_marker', 'KEEP-ME')
  writer.close()
  const hashBefore = sha(legacyDb)

  const attempt = (dbPath) => {
    const mounted = new Map()
    const app = boot(dir, { DSH_WORKBENCH_WORKFLOW_PAGE: '1', DSH_WORKBENCH_WORKFLOW_DB: dbPath })
    mounted.set('route', app.find(PAGE))
    return app
  }
  const expectConflict = async (label, dbPath, detailFragment) => {
    const app = attempt(dbPath)
    const health = await app.call(PAGE, 'GET', '/health')
    eq(health.status, 503, `${label} 状态码`)
    eq(health.body?.reason, 'workflow_db_conflict', `${label} 原因`)
    need(String(health.body?.message ?? '').includes(detailFragment), `${label} 期望原因含 ${detailFragment}，实际 ${health.body?.message}`)
    const snapshot = legacyTables(legacyDb)
    eq(snapshot.workflowTables, [], `${label} 后旧库不得有 workflow_* 表`)
    eq(snapshot.marker, 'KEEP-ME', `${label} 后 legacy_marker`)
    eq(sha(legacyDb), hashBefore, `${label} 后旧库哈希`)
    return health.body
  }

  const aliases = [
    ['相对段别名', join(dir, 'nested', '..', 'legacy.sqlite'), 'same_path_as_legacy'],
    ['点段别名', `${dir}/./legacy.sqlite`, 'same_path_as_legacy'],
    ['重复分隔符别名', join(dir, 'legacy.sqlite').replace(/([\\/])/, '$1$1'), 'same_path_as_legacy'],
  ]
  if (process.platform === 'win32') aliases.push(['大小写别名', join(dir, 'LEGACY.SQLITE'), 'same_path_as_legacy'])
  const details = []
  for (const [label, aliasPath, fragment] of aliases) {
    details.push({ label, detail: (await expectConflict(label, aliasPath, fragment)).message })
  }

  /* 硬链接：realpath 不同、dev:ino 相同，只有文件身份能抓 */
  const hardLink = join(dir, 'hard-legacy.sqlite')
  linkSync(legacyDb, hardLink)
  details.push({ label: '硬链接别名', detail: (await expectConflict('硬链接别名', hardLink, 'same_file_as_legacy')).message })

  /* 符号链接 / 目录联接：需要权限，创建不了就跳过并如实记录 */
  const softLink = join(dir, 'soft-legacy.sqlite')
  let soft = null
  try {
    symlinkSync(legacyDb, softLink)
    soft = (await expectConflict('符号链接别名', softLink, 'same_path_as_legacy')).message
    details.push({ label: '符号链接别名', detail: soft })
  } catch (cause) {
    if (!['EPERM', 'EEXIST', 'EACCES', 'UNKNOWN'].includes(String(cause?.code ?? ''))) throw cause
    details.push({ label: '符号链接别名', skipped: String(cause?.code ?? cause) })
  }

  cleanup(dir)
  return { aliases: details.length, details }
})

await check('PM-11', '反例：指向已有旧库的改名副本时拒绝，副本与原件都不得被写入 workflow_* 表', async () => {
  const dir = tmp('copy')
  const legacyDb = join(dir, 'legacy.sqlite')
  const clean = boot(dir)
  await clean.call(LEGACY, 'POST', '/notebooks', { notebook: { name: '旧数据·改名副本' } })
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const writer = new DatabaseSync(legacyDb)
  writer.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('legacy_marker', 'KEEP-ME')
  writer.close()

  const copyPath = join(dir, 'old-workbench-copy.sqlite')
  /* 用 VACUUM INTO 复制：直接 copy 主库文件会漏掉 -wal 里的建表语句，副本会变成空库，
     那样测不到「命名不同的旧库」这条拦截。 */
  const copier = new DatabaseSync(legacyDb, { readOnly: true })
  try {
    copier.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`)
  } finally {
    try { copier.close() } catch { /* ignore */ }
  }
  const copyBefore = legacyTables(copyPath)
  need(copyBefore.tables.includes('meta'), `副本应带旧库表结构：${JSON.stringify(copyBefore.tables)}`)
  eq(copyBefore.workflowTables, [], '副本复制过来时不应有 workflow_* 表')
  const copyHash = sha(copyPath)
  const app = boot(dir, { DSH_WORKBENCH_WORKFLOW_PAGE: '1', DSH_WORKBENCH_WORKFLOW_DB: copyPath })
  const health = await app.call(PAGE, 'GET', '/health')
  eq(health.status, 503, '副本冲突状态码')
  eq(health.body?.reason, 'workflow_db_conflict', '副本冲突原因')
  need(String(health.body?.message ?? '').includes('foreign_tables='), `应指出非工作流表：${health.body?.message}`)
  const copyAfter = legacyTables(copyPath)
  eq(copyAfter.workflowTables, [], '副本不得被建 workflow_* 表')
  eq(copyAfter.marker, 'KEEP-ME', '副本 marker 保持')
  eq(sha(copyPath), copyHash, '副本哈希不变')
  const original = legacyTables(legacyDb)
  eq(original.workflowTables, [], '原件不得被建 workflow_* 表')
  eq((await app.call(LEGACY, 'GET', '/state')).status, 200, '冲突下旧 API 仍可用')
  cleanup(dir)
  return { reason: health.body.reason, detail: health.body.message, copyTables: copyAfter.tables.length }
})

await check('PM-schema', '内核实际建表必须全部进入挂载白名单', async () => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const { createWorkflowKernel } = await import('../src/workflow/m1-kernel.mjs')
  const dir = tmp('schema')
  const db = new DatabaseSync(':memory:')
  try {
    createWorkflowKernel(db, dir)
    const source = readFileSync(join(root, 'src/host/workflow-page.ts'), 'utf8')
    const declaration = source.match(/export const WORKFLOW_TABLE_NAMES = \[([\s\S]*?)\]/)?.[1]
    need(!!declaration, '挂载白名单声明存在')
    const allowed = new Set([...declaration.matchAll(/'([^']+)'/g)].map(m => m[1]))
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name)
    eq(tables.filter(name => !allowed.has(name)), [], '内核表均被允许')
    return { tables }
  } finally { db.close(); cleanup(dir) }
})

await check('PM-12', '正例：独立库路径可正常启用，重启复用已有工作流库不被误判为冲突', async () => {
  const dir = tmp('separate')
  const first = boot(dir, { DSH_WORKBENCH_WORKFLOW_PAGE: '1' })
  const health = await first.call(PAGE, 'GET', '/health')
  eq(health.status, 200, '首次启用状态码')
  eq(health.body?.enabled, true, '首次启用 enabled')
  const workflowDb = join(dir, 'dsh-workbench-workflow.sqlite')
  const tables = legacyTables(workflowDb)
  need(tables.workflowTables.length >= 10, `独立库应含 10 张 workflow 表：${tables.workflowTables.length}`)
  eq(tables.marker, null, '独立库不应带旧库 marker')

  const second = boot(dir, { DSH_WORKBENCH_WORKFLOW_PAGE: '1' })
  const again = await second.call(PAGE, 'GET', '/health')
  eq(again.status, 200, '重启复用状态码')
  eq(again.body?.enabled, true, '重启复用 enabled')
  eq((await second.call(LEGACY, 'GET', '/state')).status, 200, '正例下旧 API 照常')
  cleanup(dir)
  return { workflowTables: tables.workflowTables.length, reopenOk: true }
})

/* 真注册路由此处已验证；内核层单测仍由 verify-workflow-m1*.mjs 覆盖。 */
const failed = results.filter((result) => !result.ok)
console.log(JSON.stringify({ checks, passed, assertions, failed: failed.length, results }, null, 2))
if (failed.length > 0) process.exitCode = 1
