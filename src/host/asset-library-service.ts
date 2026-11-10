/**
 * 资产库本机服务（4173）的生命周期管理。
 *
 * 为什么要它在宿主里：工作台已经有「Unity 资产库」入口，却还要求用户自己去终端
 * 跑 `npm run start:web`——入口的意义就被这句提示抵消了。这里让进入视图时按需拉起、
 * 已在跑就复用，失败把原因交回前端（前端给重试按钮，不再教用户敲命令）。
 *
 * 三条硬约束（都是踩过的坑，别放宽）：
 *  1) **不触发依赖安装**。只认资产库里已装好的 tsx；没有就报错返回，绝不在宿主里跑
 *     pnpm/npm install——那会同时动 lockfile 与 node_modules，属于用户没同意的副作用。
 *  2) **不重复启动**。同一时刻只允许一个启动流程（在飞 Promise 去重），且启动前先
 *     探测端口；端口上已经有资产库就直接复用，不认领别人的进程。
 *  3) **失败要能说清原因**。子进程提前退出时把 stderr 尾巴带回去，前端才有话可说。
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

/** 资产库仓库默认位置；可用 DSH_ASSET_LIBRARY_DIR 覆盖（路径变了不该改代码）。 */
const DEFAULT_DIR = 'D:\\csy\\Unity\\UnityResources'
/** 与资产库 src/web.ts 的默认端口保持一致。 */
const DEFAULT_PORT = 4173
/** 页面 title：用来确认端口上跑的是资产库，而不是恰好占了 4173 的别的服务。 */
const PAGE_MARKER = '资产库 · Unity Asset Store'
/** 轮询端口直到就绪的总预算。tsx 冷启动要编译 TS，实测 3–6 秒，留足余量。 */
const READY_TIMEOUT_MS = 25_000
const PROBE_TIMEOUT_MS = 1_500
/** 只留 stderr 尾巴：整份输出对用户没用，报错时给最后几行就够定位。 */
const STDERR_KEEP = 2_000

export interface AssetServiceStatus {
  ok: boolean
  /** 端口上确实有资产库在响应。 */
  running: boolean
  /** 这个进程是本宿主拉起来的（false = 端口上跑着别的/用户自己启的实例）。 */
  ownedByUs: boolean
  /** 正在启动中（前端据此显示「正在启动」而不是失败）。 */
  starting: boolean
  port: number
  url: string
  dir: string
  /** 上一次失败的说明；成功后清空。 */
  lastError: string
}

let child: ChildProcess | null = null
let stderrTail = ''
let lastError = ''
let starting = false
let inflight: Promise<AssetServiceStatus> | null = null

function dirOf(): string {
  const raw = (process.env.DSH_ASSET_LIBRARY_DIR ?? '').trim()
  return raw !== '' && isAbsolute(raw) ? raw : DEFAULT_DIR
}

function portOf(): number {
  const raw = Number((process.env.ASSET_LIBRARY_PORT ?? '').trim())
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT
}

function urlOf(): string {
  return `http://127.0.0.1:${portOf()}/`
}

/** 探测端口：拿到 HTML 且含资产库页面标记才算「在跑」。 */
async function probe(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(urlOf(), { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) return false
    const text = await res.text()
    return text.includes(PAGE_MARKER)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/* starting 由调用方显式给：ensure 成功返回时模块级 starting 还没来得及在 finally 里清掉，
   直接读它会让「刚启动成功」的返回值同时是 running:true + starting:true，前端状态自相矛盾。 */
function status(running: boolean, startingNow = starting): AssetServiceStatus {
  const owned = child !== null && child.exitCode === null && child.signalCode === null
  return {
    ok: running,
    running,
    ownedByUs: running && owned,
    starting: startingNow,
    port: portOf(),
    url: urlOf(),
    dir: dirOf(),
    lastError,
  }
}

/** 只读探测：前端挂载时先问一句，避免每次都走启动流程。 */
export async function getAssetServiceStatus(): Promise<AssetServiceStatus> {
  return status(await probe())
}

function tsxEntry(dir: string): string | null {
  /* 优先用资产库自己 node_modules 里的 tsx 入口，用 node 直接跑：
     Windows 上走 .cmd 要 shell，容易把参数切坏，也绕过不了 Install 检查。 */
  const candidates = [
    join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(dir, 'node_modules', 'tsx', 'dist', 'cli.js'),
  ]
  for (const file of candidates) if (existsSync(file)) return file
  return null
}

/**
 * 保证服务在跑：已在跑直接返回；否则拉起一次并等端口就绪。
 * 并发调用共享同一个在飞 Promise（重复点击不会起第二个进程）。
 */
export async function ensureAssetService(): Promise<AssetServiceStatus> {
  if (await probe()) {
    lastError = ''
    starting = false
    return status(true, false)
  }
  if (inflight !== null) return inflight
  starting = true
  inflight = startOnce().finally(() => {
    inflight = null
    starting = false
  })
  return inflight
}

async function startOnce(): Promise<AssetServiceStatus> {
  lastError = ''
  stderrTail = ''
  const dir = dirOf()
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    lastError = `资产库目录不存在：${dir}（可用环境变量 DSH_ASSET_LIBRARY_DIR 指定正确位置）`
    return status(false, false)
  }
  const entry = tsxEntry(dir)
  if (entry === null) {
    /* 这里刻意不装依赖：装依赖会改 lockfile 与 node_modules，属于用户没同意的副作用。 */
    lastError = `资产库缺少运行依赖（${join(dir, 'node_modules', 'tsx')} 不存在）。请在资产库目录执行一次 pnpm install 后再重试。`
    return status(false, false)
  }
  /* 复用已在跑的实例：端口被占但不是我们的子进程，就不重复拉起。 */
  if (child !== null && child.exitCode === null) {
    const ready = await waitReady(child)
    if (!ready) return status(false, false)
    return status(true, false)
  }

  let proc: ChildProcess
  try {
    proc = spawn(process.execPath, [entry, join(dir, 'src', 'web.ts')], {
      cwd: dir,
      // ASSET_LIBRARY_PORT 传给资产库自己读（src/web.ts:10），宿主端口变了也不冲突。
      env: { ...process.env, ASSET_LIBRARY_PORT: String(portOf()) },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
  } catch (cause) {
    lastError = `启动资产库失败：${String((cause as Error)?.message ?? cause)}`
    return status(false, false)
  }
  child = proc
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP)
  })
  /* spawn 失败只发 'error'，不设 exitCode 也不保证有 'exit'——用标志让 waitReady 立刻放弃。 */
  let spawnError = false
  proc.on('error', (cause: Error) => {
    spawnError = true
    lastError = `启动资产库失败：${cause.message}`
  })
  proc.on('exit', (code: number | null) => {
    if (child === proc) child = null
    /* 主动停止（dispose）时 exitCode 也会来到，但那时不该把它记成失败。 */
    if (code !== null && code !== 0 && lastError === '') {
      lastError = `资产库进程退出（退出码 ${code}）${stderrTail.trim() !== '' ? `：${tail(stderrTail)}` : ''}`
    }
  })

  const ready = await waitReady(proc, () => spawnError)
  if (!ready) return status(false, false)
  lastError = ''
  return status(true, false)
}

function tail(text: string): string {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim() !== '')
  return lines.slice(-4).join(' / ')
}

/**
 * 等端口就绪；子进程先退出或 spawn 直接报错就立刻失败，不把 25 秒预算白等完。
 *
 * aborted() 是必须的：spawn 失败（ENOENT/EACCES 这类）只发 'error' 事件，
 * **不会**设 exitCode、也不一定有 'exit'——只靠 exitCode 判断会稳稳超时 25 秒，
 * 用户看到的是「启动超时」而不是真正的原因。实测这条边界靠肉眼看不出来，故显式传入。
 */
async function waitReady(proc: ChildProcess, aborted: () => boolean = () => false): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probe()) return true
    if (aborted()) return false
    if (proc.exitCode !== null) {
      if (lastError === '') {
        lastError = `资产库启动后立即退出（退出码 ${proc.exitCode}）${stderrTail.trim() !== '' ? `：${tail(stderrTail)}` : ''}`
      }
      return false
    }
    await new Promise<void>(resolve => setTimeout(resolve, 250))
  }
  try { proc.kill() } catch { /* 已经死了就别再抛 */ }
  child = null
  lastError = `资产库启动超时（${Math.round(READY_TIMEOUT_MS / 1000)} 秒内端口未就绪）${stderrTail.trim() !== '' ? `：${tail(stderrTail)}` : ''}`
  return false
}

/**
 * 收掉自己拉起的进程；用户自己启的实例不动。
 *
 * 返回 Promise 而不是裸 kill：kill 只是「发信号」，进程真正退出是之后的事。
 * Windows 上子进程还活着时它用过的文件删不掉（测试里就是临时目录 rmSync 报 EPERM），
 * 所以要能等到 'exit' 才继续。超时没退出返回 false，调用方据此明确报告，
 * 而不是假装清理成功。
 */
export async function stopAssetService(timeoutMs = 5_000): Promise<boolean> {
  const proc = child
  child = null
  if (proc === null) return true
  /* 已经退出但没被回收：同样算停住了。 */
  if (proc.exitCode !== null || proc.signalCode !== null) return true
  const exited = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    proc.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
  try { proc.kill() } catch { /* 已经死了就别再抛 */ }
  if (await exited) return true
  /* SIGTERM 没杀掉就强杀一次：这一步不该再等，返回 false 让调用方如实报错。 */
  try { proc.kill('SIGKILL') } catch { /* 同上 */ }
  return false
}
