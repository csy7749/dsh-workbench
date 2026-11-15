/**
 * B4-3：工作流只读客户端的内核逻辑（无 React、无 DOM、无宿主依赖）。
 *
 * 这一层的唯一职责是把「读」这件事收口，好让「不存在写入口」可以被机器验证：
 *  - 所有请求都由 `planReadonlyRequests` 声明，方法只有 GET；
 *  - 每次真实请求都记进 `calls`，测试可以断言整轮会话里没有任何非 GET 方法与越界路径；
 *  - 后端不可用（未挂载 / 独立禁用 / 初始化失败）一律折叠成 `exposed:false`，
 *    页面此时**什么都不渲染**，旧面板与旧数据因此不受影响。
 *
 * 写操作（草稿提交、确认、暂停、继续）刻意不在这里出现：可信会话身份尚未验证（M0-B），
 * 一旦这个模块里出现写路径，就等于绕过了身份门。
 */

/** 只读页的插槽 key：与旧工作台的 `workbench` 分开，旧面板不受影响。 */
export const WORKFLOW_READONLY_PANEL_KEY = 'workflow-readonly'
export const WORKFLOW_READONLY_PREFIX = '/workbench-workflow'
/** 允许的读路径：健康、运行列表、单个运行。除此之外一律不请求。 */
export const WORKFLOW_READONLY_PATHS = ['/health', '/runs', '/runs/:id']
export const WORKFLOW_READONLY_METHOD = 'GET'

export const RUN_STATUS_LABELS = {
  created: '已创建',
  running: '执行中',
  waiting_review: '待人工确认',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export const STEP_STATE_LABELS = {
  pending: '待执行',
  running: '执行中',
  waiting_review: '待确认',
  paused: '已暂停',
  succeeded: '已成功',
  failed: '失败',
  cancelled: '已取消',
  stale: '已作废',
}

export const PAUSE_REASON_LABELS = {
  user_paused: '用户暂停',
  publish_conflict: '发布冲突',
  publish_failed: '发布失败',
  publish_outcome_unknown: '发布结果未知',
}

const labelOf = (map, value, fallback) => map[value] ?? fallback ?? String(value ?? '未知')

export function workflowReadonlyEndpoint(prefix = WORKFLOW_READONLY_PREFIX) {
  const trimmed = String(prefix ?? '').trim()
  const base = trimmed === '' ? WORKFLOW_READONLY_PREFIX : trimmed
  return base.endsWith('/') ? base.slice(0, -1) : base
}

/** 声明整轮只读会话会发出的请求：全部 GET，且都在允许的读路径内。 */
export function planReadonlyRequests(prefix = WORKFLOW_READONLY_PREFIX) {
  const base = workflowReadonlyEndpoint(prefix)
  return [
    { method: WORKFLOW_READONLY_METHOD, path: '/health', url: `${base}/health` },
    { method: WORKFLOW_READONLY_METHOD, path: '/runs', url: `${base}/runs` },
    { method: WORKFLOW_READONLY_METHOD, path: '/runs/:id', url: `${base}/runs/{id}` },
  ]
}

const runUrl = (base, runId) => `${base}/runs/${encodeURIComponent(String(runId))}`

/**
 * 只读数据源。`fetchImpl` 由调用方注入（浏览器里是 `fetch`，测试里是假函数），
 * 因此这里既不碰真实 HTTP，也不依赖宿主能力。
 */
export function createReadonlySource({ prefix = WORKFLOW_READONLY_PREFIX, fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('readonly_source_requires_fetch')
  const base = workflowReadonlyEndpoint(prefix)
  const calls = []

  const read = async (path, url, { allowNotFound = false } = {}) => {
    // 方法写死在这里，调用方无法传进来——这是「只有读」的结构性保证。
    calls.push({ method: WORKFLOW_READONLY_METHOD, path, url })
    let response = null
    try {
      response = await fetchImpl(url, { method: WORKFLOW_READONLY_METHOD })
    } catch (cause) {
      // 断网 / 被中止 / DNS 失败：折叠成一次「读取失败」，绝不向上抛，
      // 否则页面的 async 调用会留下未处理的拒绝（老大退回的第二个反例）。
      return { status: 0, body: null, ok: false, reason: 'unreachable', parseError: null, error: String(cause?.message ?? cause) }
    }
    const status = Number(response?.status ?? 0)
    let body = null
    let parseError = null
    try {
      body = await response?.json?.()
    } catch (cause) {
      parseError = String(cause?.message ?? cause)
    }
    if (allowNotFound && status === 404) return { status, body, missing: true, parseError }
    if (status < 200 || status >= 300) {
      const fromBody = body && typeof body === 'object' ? body.reason ?? body.error ?? null : null
      // 响应体没给原因时用状态码兜底：否则失败会退化成没有信息量的兜底文案。
      const reason = fromBody === null ? (status === 404 ? 'not_found' : `http_${status}`) : String(fromBody)
      return { status, body, ok: false, reason, parseError }
    }
    if (parseError !== null) return { status, body: null, ok: false, reason: 'bad_json', parseError }
    return { status, body, ok: true, parseError: null }
  }

  const failedRead = (result, fallback) => ({
    ok: false,
    reason: result.reason ?? fallback,
    status: result.status ?? 0,
    ...(result.error === undefined ? {} : { error: result.error }),
  })

  return {
    calls,
    prefix: base,
    /** 探针：只有后端明确说「已启用」才认为这个页面存在。 */
    async probe() {
      try {
        const result = await read('/health', `${base}/health`)
        if (!result.ok) {
          const reason = result.status === 404 ? 'not_mounted' : (result.reason ?? `http_${result.status}`)
          return { exposed: false, reason, status: result.status }
        }
        const body = result.body
        if (!body || typeof body !== 'object' || body.ok !== true || body.enabled !== true) {
          return { exposed: false, reason: 'disabled', status: result.status }
        }
        return { exposed: true, reason: null, status: result.status, health: body }
      } catch (cause) {
        return { exposed: false, reason: 'unreachable', error: String(cause?.message ?? cause) }
      }
    },
    async listRuns() {
      try {
        const result = await read('/runs', `${base}/runs`)
        if (!result.ok) return failedRead(result, 'list_failed')
        return { ok: true, ...summarizeRuns(result.body) }
      } catch (cause) {
        return { ok: false, reason: 'unreachable', status: 0, error: String(cause?.message ?? cause) }
      }
    },
    async loadRun(runId) {
      try {
        const result = await read('/runs/:id', runUrl(base, runId), { allowNotFound: true })
        if (result.missing) return { ok: false, reason: 'run_not_found', runId: String(runId) }
        if (!result.ok) return failedRead(result, 'load_failed')
        return { ok: true, ...summarizeRun(result.body) }
      } catch (cause) {
        return { ok: false, reason: 'unreachable', status: 0, error: String(cause?.message ?? cause) }
      }
    },
  }
}

const budgetText = (used, total) => `${Number(used ?? 0)}/${Number(total ?? 0)}`

export function summarizeRuns(body) {
  const runs = Array.isArray(body?.runs) ? body.runs : []
  return {
    recoverable: Number(body?.recoverable ?? 0),
    runs: runs.map((row) => ({
      id: String(row?.id ?? ''),
      status: String(row?.status ?? ''),
      statusLabel: labelOf(RUN_STATUS_LABELS, row?.status),
      revision: Number(row?.revision ?? 0),
      budget: budgetText(row?.budgetUsed, row?.budgetTotal),
      budgetUsed: Number(row?.budgetUsed ?? 0),
      budgetTotal: Number(row?.budgetTotal ?? 0),
      pauseReason: row?.pauseReason ?? null,
      pauseReasonLabel: row?.pauseReason ? labelOf(PAUSE_REASON_LABELS, row.pauseReason) : null,
      updatedAt: String(row?.updatedAt ?? ''),
    })),
  }
}

const ERROR_EVENT_PATTERN = /(fail|error|rejected|conflict|unknown|cancel)/i

export function summarizeRun(body) {
  const run = body?.run ?? null
  const steps = Array.isArray(body?.steps) ? body.steps : []
  const events = Array.isArray(body?.events) ? body.events : []
  const errors = []
  if (run && run.pauseReason) {
    errors.push({
      seq: null,
      type: 'run_paused',
      code: String(run.pauseReason),
      message: labelOf(PAUSE_REASON_LABELS, run.pauseReason),
      at: String(run.updatedAt ?? ''),
    })
  }
  for (const event of events) {
    const payload = event && typeof event.payload === 'object' && event.payload !== null ? event.payload : {}
    const interesting = ERROR_EVENT_PATTERN.test(String(event?.type ?? '')) || payload.code !== undefined
    if (!interesting) continue
    errors.push({
      seq: Number(event?.seq ?? 0),
      type: String(event?.type ?? ''),
      code: payload.code === undefined ? null : String(payload.code),
      message: String(payload.detail ?? payload.message ?? payload.code ?? ''),
      at: String(event?.createdAt ?? ''),
    })
  }
  return {
    run: run === null ? null : {
      id: String(run.id ?? ''),
      status: String(run.status ?? ''),
      statusLabel: labelOf(RUN_STATUS_LABELS, run.status),
      revision: Number(run.revision ?? 0),
      budget: budgetText(run.budgetUsed, run.budgetTotal),
      pauseReason: run.pauseReason ?? null,
      pauseReasonLabel: run.pauseReason ? labelOf(PAUSE_REASON_LABELS, run.pauseReason) : null,
      createdAt: String(run.createdAt ?? ''),
      updatedAt: String(run.updatedAt ?? ''),
    },
    steps: steps.map((step) => ({
      id: String(step?.id ?? ''),
      nodeId: String(step?.nodeId ?? ''),
      nodeKind: String(step?.nodeKind ?? ''),
      state: String(step?.state ?? ''),
      stateLabel: labelOf(STEP_STATE_LABELS, step?.state),
      revision: Number(step?.revision ?? 0),
      stale: step?.stale === true,
    })),
    history: events.map((event) => ({
      seq: Number(event?.seq ?? 0),
      type: String(event?.type ?? ''),
      at: String(event?.createdAt ?? ''),
    })),
    errors,
  }
}

/**
 * 一次完整的只读加载：探针 → 列表 → 详情。
 *
 * **永不 reject**。页面用它做 `setState(await loadReadonlyState(...))`，
 * 所以任何读取故障（503、断网、坏 JSON、实现抛错）都只会变成可见的失败状态，
 * 不会变成未处理的异步异常（老大退回的第二个反例）。
 */
export async function loadReadonlyState(source, { runId = null } = {}) {
  try {
    const probe = await source.probe()
    if (!probe || probe.exposed !== true) {
      return { exposed: false, reason: probe?.reason ?? 'disabled', runs: null, detail: null }
    }
    const runs = await source.listRuns()
    if (!runs || runs.ok !== true) {
      // 列表读失败就不再往下猜详情——但入口照样给出失败状态。
      return { exposed: true, runs: runs ?? { ok: false, reason: 'list_failed' }, detail: null }
    }
    const target = runId ?? (runs.runs.length > 0 ? runs.runs[0].id : null)
    const detail = target === null ? null : await source.loadRun(target)
    return { exposed: true, runs, detail, selected: target }
  } catch (cause) {
    return { exposed: true, reason: 'unreachable', error: String(cause?.message ?? cause), runs: null, detail: null }
  }
}

export const READ_FAILURE_LABELS = {
  not_mounted: '工作流接口未挂载',
  disabled_by_config: '工作流页未启用',
  workflow_requires_sqlite: '缺少 SQLite，工作流独立禁用',
  workflow_init_failed: '工作流初始化失败',
  workflow_db_conflict: '工作流库与旧工作台库冲突',
  unreachable: '连接不上工作流接口',
  bad_json: '工作流接口返回的内容不是合法 JSON',
  list_failed: '读取运行列表失败',
  load_failed: '读取运行详情失败',
  run_not_found: '运行不存在',
  not_found: '工作流接口返回 404',
}

/** 把失败原因翻成人能读的一句话；未知原因就原样带上，绝不假装成功。 */
export function describeReadFailure(reason) {
  const key = String(reason ?? '')
  if (key === '') return '读取失败'
  const direct = READ_FAILURE_LABELS[key]
  if (direct !== undefined) return direct
  const httpMatch = /^http_(\d+)$/.exec(key)
  if (httpMatch !== null) return `工作流接口返回 HTTP ${httpMatch[1]}`
  return `读取失败：${key}`
}

/**
 * 把一次读取结果折叠成页面视图。
 * 返回 `null` 表示「这个页面不该出现」——未启用时连占位都不渲染，旧界面完全不变。
 *
 * 三种结果必须分清（老大退回的关键）：
 *  - `ready`：真的读到了，数据为空才是「还没有工作流运行」；
 *  - `error`：**读失败**。列表 503、断网、详情非 404 失败都属于这类，
 *    此时绝不能显示空列表/空详情冒充「没有数据」；
 *  - 详情 `run_not_found` 是唯一的例外：那确实是「这个运行不存在」，按空态处理。
 */
export function readonlyView(state) {
  if (!state || state.exposed !== true) return null

  const failed = []
  const runsResult = state.runs ?? null
  const runs = runsResult !== null && runsResult.ok === true ? runsResult.runs : []
  const recoverable = runsResult !== null && runsResult.ok === true ? runsResult.recoverable : 0
  if (state.error) failed.push(String(state.error))
  if (runsResult !== null && runsResult.ok !== true) failed.push(runsResult.reason ?? 'list_failed')

  const detailResult = state.detail ?? null
  const detailMissing = detailResult !== null && detailResult.ok !== true
  let detail = null
  if (detailResult !== null && detailResult.ok === true) {
    detail = {
      run: detailResult.run,
      steps: detailResult.steps,
      history: detailResult.history,
      errors: detailResult.errors,
    }
  } else if (detailMissing && detailResult.reason !== 'run_not_found') {
    // 详情读失败（不是「没这个运行」）：必须报失败，不能折叠成空详情。
    failed.push(detailResult.reason ?? 'load_failed')
  }

  if (failed.length > 0) {
    const reason = failed[0]
    return {
      status: 'error',
      reason,
      message: describeReadFailure(reason),
      headline: `读取失败：${describeReadFailure(reason)}`,
      recoverable,
      // 已经读到的运行仍然展示，避免把成功的那部分也一起藏掉。
      runs,
      detail: null,
      errors: failed.map((item) => ({
        seq: null,
        type: 'read_failed',
        code: String(item),
        message: describeReadFailure(item),
        at: '',
      })),
    }
  }

  const headline = runs.length === 0
    ? '还没有工作流运行'
    : `${runs.length} 个运行${recoverable > 0 ? ` · ${recoverable} 项待恢复` : ''}`
  return {
    status: 'ready',
    reason: null,
    message: null,
    headline,
    recoverable,
    runs,
    detail,
    errors: detail === null ? [] : detail.errors,
  }
}

/**
 * 安装只读页：先探针，确认后端真的启用才挂入口。
 * `registerEntry` 由调用方注入（浏览器里挂侧栏按钮，测试里是探针间谍）。
 */
export async function installWorkflowReadonly({ source, registerEntry, log } = {}) {
  if (!source || typeof source.probe !== 'function') throw new Error('readonly_install_requires_source')
  const probe = await source.probe()
  if (!probe.exposed) {
    // 未启用：不挂入口、不渲染、不提示，旧界面一个字都不变。
    return { exposed: false, reason: probe.reason, health: null, dispose: () => {} }
  }
  let disposeEntry = () => {}
  try {
    if (typeof registerEntry === 'function') disposeEntry = registerEntry({ prefix: source.prefix, health: probe.health }) ?? (() => {})
  } catch (cause) {
    if (typeof log === 'function') log(`[workflow-readonly] 入口挂载失败：${String(cause?.message ?? cause)}`)
    return { exposed: false, reason: 'entry_failed', health: probe.health, dispose: () => {} }
  }
  return {
    exposed: true,
    reason: null,
    health: probe.health,
    dispose: () => { try { disposeEntry() } catch { /* ignore */ } },
  }
}
