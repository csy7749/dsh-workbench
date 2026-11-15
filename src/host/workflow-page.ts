/**
 * 工作流内测页的宿主薄挂载（W1-07 / A13）。
 *
 * 四条硬约束集中在这里，别在别的地方再实现一遍：
 *  ① 默认关闭：只有 DSH_WORKBENCH_WORKFLOW_PAGE 显式为 1/on/true/yes 才注册路由。
 *     关闭时连内核都不打开，旧面板 / 旧数据完全看不到这次改动。
 *  ② 没有 SQLite 就独立禁用：不退回 JSON 写工作流状态（A13 原文要求）。
 *  ③ 库文件必须与旧工作台库物理隔离：同路径、路径别名（相对段 / 大小写 / 符号链接 / 硬链接）
 *     以及「指向一个已存在的非工作流库」全部拒绝，绝不把 workflow_* 表建进旧库。
 *     只在打开内核**之前**拦截——一旦 openWorkflowKernel 跑过，建表语句已经落盘，来不及了。
 *  ④ 初始化失败必须隔离：内核打不开只让这条路由回 503，不清库、不回滚、不影响 /workbench-api。
 *
 * 工作流用独立库文件与独立对象目录（dataDir/workflow）：内测页再怎么崩也碰不到旧工作台库。
 */
import { createRequire } from 'node:module'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { openWorkflowKernel } from '../workflow/m1-kernel.mjs'

const require = createRequire(import.meta.url)

export const WORKFLOW_PAGE_PREFIX = '/workbench-workflow'
export const WORKFLOW_PAGE_ENABLED_ENV = 'DSH_WORKBENCH_WORKFLOW_PAGE'
export const WORKFLOW_PAGE_DB_ENV = 'DSH_WORKBENCH_WORKFLOW_DB'
export const WORKFLOW_PAGE_DISABLED_REASONS = [
  'disabled_by_config', 'workflow_requires_sqlite', 'workflow_db_conflict', 'workflow_init_failed',
]
/** 工作流库文件里只允许出现这些表；出现别的表说明这个文件不是工作流库。 */
export const WORKFLOW_TABLE_NAMES = [
  'workflow_runs', 'workflow_steps', 'workflow_attempts', 'workflow_snapshots', 'workflow_drafts',
  'workflow_adoptions', 'workflow_events', 'workflow_outbox', 'workflow_human_tasks', 'workflow_requests',
  'workflow_input_bindings', 'workflow_publish_owners', 'workflow_run_definitions', 'workflow_jobs', 'workflow_validations', 'workflow_revision_requests', 'workflow_development_targets',
]

export interface WorkflowPageRoute {
  kind: string
  path: string
  handler: (req: any, res: any) => void
}

export interface WorkflowPageOptions {
  engine: string
  dataDir: string
  /** 旧工作台库的实际路径（宿主传 `dbFile`）：用来判定工作流库是否与它撞车。 */
  legacyDbPath?: string | null
  env?: Record<string, string | undefined>
  prefix?: string
  openKernel?: (dbPath: string, root: string) => any
  register?: (route: WorkflowPageRoute) => () => void
  log?: (message: string) => void
  send?: (res: any, status: number, payload: unknown) => void
  /** 测试注入口：默认读真实文件系统，允许注入假的表清单 / 身份。 */
  inspect?: (file: string) => { canonical: string; identity: string | null; tables: string[] | null }
}

export interface WorkflowPageMount {
  enabled: boolean
  reason: string | null
  error?: string
  prefix: string
  kernel: any | null
  dispose: () => void
}

/** 只认显式打开：`1/on/true/yes`。空串、0、off、缺失一律视为关闭。 */
export function workflowPageEnabled(env: Record<string, string | undefined>): boolean {
  const raw = String(env[WORKFLOW_PAGE_ENABLED_ENV] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
}

/** Windows 路径大小写不敏感：比较前统一小写，否则 `Legacy.sqlite` 能绕过 `legacy.sqlite`。 */
const CASE_INSENSITIVE = process.platform === 'win32'

function normalizeForCompare(value: string): string {
  const absolute = resolve(value)
  /* 文件已存在时 realpath 会解掉符号链接 / 8.3 短名；不存在时退化为「父目录 realpath + 文件名」。 */
  let canonical: string
  try {
    canonical = realpathSync(absolute)
  } catch {
    try {
      canonical = join(realpathSync(dirname(absolute)), basename(absolute))
    } catch {
      canonical = absolute
    }
  }
  return CASE_INSENSITIVE ? canonical.toLowerCase() : canonical
}

/** 文件身份：同一硬链接的两个路径 realpath 不同，必须靠 dev+ino 才抓得住。 */
function fileIdentity(file: string): string | null {
  try {
    const info = statSync(file)
    const ino = Number(info.ino ?? 0)
    if (ino === 0) return null
    return `${String(info.dev)}:${ino}`
  } catch {
    return null
  }
}

const WORKFLOW_TABLES = new Set(WORKFLOW_TABLE_NAMES)

/** 读已有库文件的表清单；文件不存在返回空数组。打不开（不是 SQLite / 是目录）返回 null：
 *  这种情况交给 openWorkflowKernel 去报真实错误，别在隔离判定里提前抛死。 */
function readTables(file: string): string[] | null {
  if (!existsSync(file)) return []
  let DatabaseSync: any
  try {
    ({ DatabaseSync } = require('node:sqlite'))
  } catch {
    return null
  }
  let db: any
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    return rows.map((row: any) => String(row.name)).filter((name: string) => name !== '')
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

const defaultInspect = (file: string): { canonical: string; identity: string | null; tables: string[] | null } => ({
  canonical: normalizeForCompare(file),
  identity: fileIdentity(file),
  tables: readTables(file),
})

/**
 * 校验工作流库与旧工作台库确实是两个不同的文件。
 * 返回 `null` 表示通过；否则返回冲突原因（`same_path` / `same_file` / `foreign_database`）。
 * 必须在 openWorkflowKernel **之前**调用：建表一旦执行，旧库就被污染了。
 */
export function checkWorkflowDbIsolation(
  workflowDbPath: string,
  legacyDbPath: string | null | undefined,
  inspect: WorkflowPageOptions['inspect'] = defaultInspect,
): { ok: true } | { ok: false; reason: string; detail: string } {
  if (!workflowDbPath) return { ok: false, reason: 'same_path', detail: 'workflow_db_path_empty' }
  const workflow = (inspect ?? defaultInspect)(workflowDbPath)
  if (legacyDbPath) {
    const legacy = (inspect ?? defaultInspect)(legacyDbPath)
    if (legacy.canonical !== '' && workflow.canonical === legacy.canonical) {
      return { ok: false, reason: 'same_path', detail: `${workflowDbPath}:same_path_as_legacy` }
    }
    if (workflow.identity !== null && workflow.identity === legacy.identity) {
      return { ok: false, reason: 'same_file', detail: `${workflowDbPath}:same_file_as_legacy` }
    }
  }
  /* 已存在的库文件里若有非工作流的表，它就是别人的库（换个名字也不行）。
     读不出来（不是数据库 / 是目录）不算冲突：交给 openWorkflowKernel 报真实错误。 */
  if (workflow.tables !== null) {
    const foreign = workflow.tables.filter((name) => !WORKFLOW_TABLES.has(name))
    if (foreign.length > 0) {
      return { ok: false, reason: 'foreign_database', detail: `${workflowDbPath}:foreign_tables=${foreign.slice(0, 5).join(',')}` }
    }
  }
  return { ok: true }
}

function writeJson(res: any, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
  }
  res.end(body)
}

function runView(row: any): any {
  return {
    id: row.id,
    status: row.status,
    revision: Number(row.revision),
    budgetTotal: Number(row.budget_total),
    budgetUsed: Number(row.budget_used),
    pauseReason: row.pause_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 挂载内测页路由。返回 `enabled:false` 时表示这次没有可用的工作流能力，
 * 调用方按 `reason` 打印一行日志即可，不要做任何回滚或清理动作。
 */
export function mountWorkflowPage(options: WorkflowPageOptions): WorkflowPageMount {
  const env = options.env ?? process.env
  const prefix = options.prefix ?? WORKFLOW_PAGE_PREFIX
  const log = options.log ?? ((message: string) => console.log(`[dsh-workbench] ${message}`))
  const send = options.send ?? writeJson
  const off = (reason: string, error?: string): WorkflowPageMount => ({ enabled: false, reason, error, prefix, kernel: null, dispose: () => {} })

  /* ① 默认关闭：不注册路由、不打开内核、不建库文件。 */
  if (!workflowPageEnabled(env)) return off('disabled_by_config')

  /* ② 无 SQLite 独立禁用：绝不退回 JSON 写工作流（A13）。 */
  if (options.engine !== 'sqlite') {
    log('工作流内测页未启用：当前存储不是 SQLite（工作流状态不落 JSON）')
    return off('workflow_requires_sqlite')
  }

  const workflowDbPath = env[WORKFLOW_PAGE_DB_ENV] ?? join(options.dataDir, 'dsh-workbench-workflow.sqlite')
  const root = join(options.dataDir, 'workflow')

  /* ③ 物理隔离：必须在打开内核之前判定，建表一旦跑过就已经污染旧库了。 */
  const isolation = checkWorkflowDbIsolation(workflowDbPath, options.legacyDbPath ?? null, options.inspect)
  if (!isolation.ok) {
    const message = `工作流库与旧工作台库冲突（${isolation.reason}）：${isolation.detail}`
    log(`工作流内测页已独立禁用：${message}`)
    return unavailableMount(prefix, 'workflow_db_conflict', message, log, send, options.register)
  }

  const offInit = (message: string): WorkflowPageMount => unavailableMount(prefix, 'workflow_init_failed', message, log, send, options.register)

  let kernel: any
  try {
    kernel = (options.openKernel ?? openWorkflowKernel)(workflowDbPath, root)
  } catch (cause: any) {
    /* ④ 初始化失败隔离：只让这条路由 503，旧面板与旧数据一个字都不动。 */
    const message = String(cause?.message ?? cause)
    log(`工作流内测页初始化失败，已独立禁用（旧面板与旧数据不受影响）：${message}`)
    return offInit(message)
  }

  const handler = (req: any, res: any): void => {
    void (async () => {
      let method = 'GET'
      let path = '/'
      try {
        const url = new URL(String(req?.url ?? '/'), 'http://dsh.internal')
        method = String(req?.method ?? 'GET').toUpperCase()
        path = url.pathname.slice(prefix.length) || '/'
        if (method === 'GET' && (path === '/' || path === '/health')) {
          const runs = kernel.query('SELECT COUNT(*) AS n FROM workflow_runs')
          const recoverable = kernel.scanRecoverable()
          send(res, 200, {
            ok: true,
            enabled: true,
            engine: 'sqlite',
            kernel: 'm1',
            prefix,
            runs: Number(runs?.[0]?.n ?? 0),
            recoverable: recoverable.total,
          })
          return
        }
        if (method === 'GET' && path === '/runs') {
          const rows = kernel.query('SELECT * FROM workflow_runs ORDER BY rowid DESC LIMIT 50')
          const recoverable = kernel.scanRecoverable()
          send(res, 200, { runs: rows.map(runView), recoverable: recoverable.total })
          return
        }
        if (method === 'GET' && path.startsWith('/runs/')) {
          const runId = decodeURIComponent(path.slice('/runs/'.length))
          const row = kernel.one('SELECT * FROM workflow_runs WHERE id = ?', runId)
          if (row === undefined || row === null) {
            send(res, 404, { error: 'run_not_found', runId })
            return
          }
          const steps = kernel.query('SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY rowid', runId)
          const events = kernel.query('SELECT * FROM workflow_events WHERE run_id = ? ORDER BY seq DESC LIMIT 20', runId)
          send(res, 200, {
            run: runView(row),
            steps: steps.map((step: any) => ({
              id: step.id,
              nodeId: step.node_id,
              nodeKind: step.node_kind,
              state: step.state,
              revision: Number(step.revision),
              stale: Number(step.stale) === 1,
            })),
            events: events.slice().reverse().map((event: any) => ({
              seq: Number(event.seq),
              type: event.type,
              payload: JSON.parse(event.payload || '{}'),
              createdAt: event.created_at,
            })),
          })
          return
        }
        send(res, 404, { error: 'not_found' })
      } catch (cause: any) {
        log(`工作流内测页请求失败 ${method} ${String(req?.url ?? '')}：${String(cause)}`)
        send(res, 400, { error: 'bad_request', message: String(cause?.message ?? cause) })
      }
    })()
  }

  const route: WorkflowPageRoute = { kind: 'prefix', path: prefix, handler }
  const disposeRoute = options.register ? options.register(route) : () => {}
  log(`工作流内测页已启用：${prefix}（库 ${workflowDbPath}）`)
  return {
    enabled: true,
    reason: null,
    prefix,
    kernel,
    dispose: () => {
      try { disposeRoute() } catch { /* ignore */ }
      try { kernel?.db?.close?.() } catch { /* ignore */ }
    },
  }
}

/** 挂载一条只会回 503 的路由：用于配置冲突与初始化失败两种「能力不可用」情形。 */
function unavailableMount(
  prefix: string,
  reason: string,
  message: string,
  log: (message: string) => void,
  send: (res: any, status: number, payload: unknown) => void,
  register: WorkflowPageOptions['register'],
): WorkflowPageMount {
  const brokenRoute: WorkflowPageRoute = {
    kind: 'prefix',
    path: prefix,
    handler: (req: any, res: any) => {
      const method = String(req?.method ?? 'GET').toUpperCase()
      log(`工作流内测页不可用：${method} ${String(req?.url ?? '')}`)
      send(res, 503, { error: 'workflow_disabled', reason, message })
    },
  }
  const disposeRoute = register ? register(brokenRoute) : () => {}
  return {
    enabled: false,
    reason,
    error: message,
    prefix,
    kernel: null,
    dispose: () => { try { disposeRoute() } catch { /* ignore */ } },
  }
}
