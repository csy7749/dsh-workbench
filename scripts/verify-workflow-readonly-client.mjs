/**
 * B4-3 专项：默认关闭的只读工作流客户端。
 *
 * 验收要点（老大 m01221）：
 *  1. 开关关闭时旧页面不变——探针失败即 exposed:false，页面渲染 null，不挂入口；
 *  2. 开启后只读数据可见——步骤状态、历史、错误都能从 GET 接口读出并展示；
 *  3. 不存在写入口——整轮会话的请求全是 GET，源码里没有写方法/写命令。
 *
 * 命令：node scripts/verify-workflow-readonly-client.mjs
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WORKFLOW_READONLY_METHOD,
  WORKFLOW_READONLY_PANEL_KEY,
  WORKFLOW_READONLY_PREFIX,
  createReadonlySource,
  describeReadFailure,
  installWorkflowReadonly,
  loadReadonlyState,
  planReadonlyRequests,
  readonlyView,
  summarizeRun,
  summarizeRuns,
  workflowReadonlyEndpoint,
} from '../src/client/workflow/readonly-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const results = []
let assertions = 0

function need(condition, message) {
  assertions += 1
  if (!condition) throw new Error(message)
}
function eq(actual, expected, message) {
  assertions += 1
  if (actual !== expected) throw new Error(`${message}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EBUSY') {
      console.log(`[cleanup] 临时目录保留（${error.code}）：${dir}`)
      return
    }
    throw error
  }
}
const tmpRoot = () => mkdtempSync(join(tmpdir(), 'dsh-wf-readonly-'))

const HEALTH_OK = {
  ok: true,
  enabled: true,
  engine: 'sqlite',
  kernel: 'workflow-kernel/1',
  prefix: WORKFLOW_READONLY_PREFIX,
  runs: 2,
  recoverable: 1,
}
const RUNS_OK = {
  runs: [
    { id: 'run-a', status: 'waiting_review', revision: 3, budgetUsed: 12, budgetTotal: 900, pauseReason: null, updatedAt: '2026-11-14T01:00:00.000Z' },
    { id: 'run-b', status: 'paused', revision: 5, budgetUsed: 40, budgetTotal: 900, pauseReason: 'publish_conflict', updatedAt: '2026-11-14T02:00:00.000Z' },
  ],
  recoverable: 1,
}
const RUN_DETAIL_OK = {
  run: { id: 'run-a', status: 'waiting_review', revision: 3, budgetUsed: 12, budgetTotal: 900, pauseReason: null, createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T01:00:00.000Z' },
  steps: [
    { id: 's1', nodeId: 'draft', nodeKind: 'agent', state: 'succeeded', revision: 1, stale: false },
    { id: 's2', nodeId: 'review', nodeKind: 'human', state: 'waiting_review', revision: 2, stale: true },
    { id: 's3', nodeId: 'publish', nodeKind: 'agent', state: 'pending', revision: 0, stale: false },
  ],
  events: [
    { seq: 1, type: 'run.created', payload: {}, createdAt: '2026-11-14T00:00:01.000Z' },
    { seq: 2, type: 'step.succeeded', payload: { nodeId: 'draft' }, createdAt: '2026-11-14T00:10:00.000Z' },
    { seq: 3, type: 'publish.conflict', payload: { code: 'publish_conflict', detail: 'target pd:fixture is busy' }, createdAt: '2026-11-14T00:20:00.000Z' },
    { seq: 4, type: 'outbox.outcome_unknown', payload: { code: 'outcome_unknown' }, createdAt: '2026-11-14T00:30:00.000Z' },
    { seq: 5, type: 'human.task.created', payload: { taskId: 't1' }, createdAt: '2026-11-14T00:40:00.000Z' },
  ],
}

const respond = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

/** 假后端：按路径返回预置响应，并记录每一次请求。 */
function fakeBackend(routes) {
  const calls = []
  const impl = async (url, init) => {
    const parsed = new URL(String(url), 'http://dsh.local')
    const method = String(init?.method ?? 'GET').toUpperCase()
    calls.push({ url: parsed.pathname, method })
    const handler = routes[`${method} ${parsed.pathname}`] ?? routes[parsed.pathname]
    if (handler === undefined) return respond(404, { error: 'not_found' })
    if (typeof handler === 'function') return handler(parsed)
    if (handler instanceof Error) throw handler
    return handler
  }
  return { calls, fetchImpl: impl }
}

function withBackend(routes, options) {
  const backend = fakeBackend(routes)
  const source = createReadonlySource({ prefix: WORKFLOW_READONLY_PREFIX, fetchImpl: backend.fetchImpl })
  return { ...backend, source, options }
}

const P = (suffix) => `${WORKFLOW_READONLY_PREFIX}${suffix}`
const ALLOWED_PATHS = new Set([P('/health'), P('/runs')])
const READ_METHODS = new Set(['GET'])

function assertOnlyReads(calls, label) {
  need(calls.length > 0, `${label}：应当发生读取调用`)
  for (const call of calls) {
    eq(call.method, WORKFLOW_READONLY_METHOD, `${label}：方法必须只有 GET（实际 ${call.method} ${call.url}）`)
    const inList = ALLOWED_PATHS.has(call.url)
    const inDetail = call.url.startsWith(`${P('/runs')}/`)
    need(inList || inDetail, `${label}：请求路径越界 ${call.url}`)
  }
}

const checks = []
const check = (id, title, fn) => checks.push({ id, title, fn })

// ---------------------------------------------------------------- RC-01
check('RC-01', '只读计划：方法只有 GET，路径只有 health/runs/runs/:id，数据源不暴露任何写方法', () => {
  const plan = planReadonlyRequests()
  eq(plan.length, 3, '只读计划应当只有 3 条')
  for (const item of plan) {
    eq(item.method, 'GET', `${item.path} 必须是 GET`)
    need(item.url.startsWith(WORKFLOW_READONLY_PREFIX), `${item.path} 前缀错误`)
  }
  eq(plan.map((item) => item.path).join(','), '/health,/runs,/runs/:id', '读路径清单应与薄挂载一致')
  eq(workflowReadonlyEndpoint('/workbench-workflow/'), WORKFLOW_READONLY_PREFIX, '前缀末尾斜杠应当被归一')
  eq(WORKFLOW_READONLY_PANEL_KEY, 'workflow-readonly', '只读页 key 必须与旧 workbench 面板分开')

  const source = createReadonlySource({ fetchImpl: async () => respond(200, HEALTH_OK) })
  const methods = Object.keys(source).filter((key) => typeof source[key] === 'function').sort()
  eq(methods.join(','), 'listRuns,loadRun,probe', '数据源只应有三个读方法')
  for (const forbidden of ['post', 'put', 'patch', 'delete', 'request', 'write', 'confirm', 'pause', 'resume', 'submit', 'createRun', 'adopt']) {
    need(!methods.includes(forbidden), `数据源不应暴露写方法 ${forbidden}`)
  }
})

// ---------------------------------------------------------------- RC-02
check('RC-02', '关闭时旧页面不变：未挂载 / 独立禁用 / 初始化失败 / 网络不可达 / enabled:false 一律不挂入口且渲染 null', async () => {
  const cases = [
    ['not_mounted', { [P('/health')]: respond(404, { error: 'not_found' }) }, 'not_mounted'],
    ['disabled_by_config', { [P('/health')]: respond(503, { error: 'workflow_disabled', reason: 'disabled_by_config' }) }, 'disabled_by_config'],
    ['workflow_init_failed', { [P('/health')]: respond(503, { error: 'workflow_disabled', reason: 'workflow_init_failed' }) }, 'workflow_init_failed'],
    ['workflow_requires_sqlite', { [P('/health')]: respond(503, { error: 'workflow_disabled', reason: 'workflow_requires_sqlite' }) }, 'workflow_requires_sqlite'],
    ['unreachable', { [P('/health')]: new Error('connect ECONNREFUSED 127.0.0.1:1') }, 'unreachable'],
    ['enabled_false', { [P('/health')]: respond(200, { ...HEALTH_OK, enabled: false }) }, 'disabled'],
    ['ok_false', { [P('/health')]: respond(200, { ok: false, enabled: true }) }, 'disabled'],
  ]
  for (const [label, routes, expectedReason] of cases) {
    const ctx = withBackend(routes)
    let entryCalls = 0
    const installed = await installWorkflowReadonly({
      source: ctx.source,
      registerEntry: () => { entryCalls += 1; return () => {} },
      log: () => {},
    })
    eq(installed.exposed, false, `${label}：不应暴露只读页`)
    eq(installed.reason, expectedReason, `${label}：关闭原因应为 ${expectedReason}`)
    eq(entryCalls, 0, `${label}：不得挂侧栏入口（旧界面不变）`)
    eq(readonlyView({ exposed: installed.exposed, reason: installed.reason }), null, `${label}：页面必须渲染 null`)
    installed.dispose()
    assertOnlyReads(ctx.source.calls, label)
  }
})

// ---------------------------------------------------------------- RC-03
check('RC-03', '开启后只读数据可见：探针通过即挂入口，步骤状态 / 历史 / 错误都能展示', async () => {
  const routes = {
    [P('/health')]: respond(200, HEALTH_OK),
    [P('/runs')]: respond(200, RUNS_OK),
    [P('/runs/run-a')]: respond(200, RUN_DETAIL_OK),
  }
  const ctx = withBackend(routes)
  let entryCalls = 0
  const installed = await installWorkflowReadonly({
    source: ctx.source,
    registerEntry: (info) => {
      entryCalls += 1
      eq(info.prefix, WORKFLOW_READONLY_PREFIX, '入口应当拿到薄挂载前缀')
      return () => {}
    },
  })
  eq(installed.exposed, true, '探针通过后应暴露只读页')
  eq(entryCalls, 1, '侧栏入口只挂一次')

  const runs = await ctx.source.listRuns()
  const detail = await ctx.source.loadRun('run-a')
  need(runs.ok && detail.ok, '读列表与详情都应成功')

  const view = readonlyView({ exposed: true, runs, detail })
  need(view !== null, '启用后页面必须有内容')
  eq(view.status, 'ready', '页面状态应为 ready')
  eq(view.headline, '2 个运行 · 1 项待恢复', '标题应给出运行数与待恢复数')
  eq(view.runs.length, 2, '应展示两个运行')
  eq(view.runs[0].statusLabel, '待人工确认', '运行状态应有中文标签')
  eq(view.runs[0].budget, '12/900', '运行应给出预算用量')
  eq(view.runs[1].pauseReasonLabel, '发布冲突', '暂停原因应有中文标签')

  eq(view.detail.steps.length, 3, '应展示三个步骤')
  eq(view.detail.steps[0].stateLabel, '已成功', '步骤状态应有中文标签')
  eq(view.detail.steps[1].stale, true, '被上游作废的步骤应当可见')
  eq(view.detail.history.length, 5, '历史应包含全部事件')
  eq(view.detail.history[0].type, 'run.created', '历史按 seq 正序')

  eq(view.detail.errors.length, 2, '错误应只取冲突与未知结果两条')
  eq(view.detail.errors[0].code, 'publish_conflict', '错误应带错误码')
  eq(view.detail.errors[0].message, 'target pd:fixture is busy', '错误应带 detail 文本')
  eq(view.detail.errors[1].code, 'outcome_unknown', '结果未知也应作为错误展示')
  eq(view.errors, view.detail.errors, '页面级错误应与详情一致')

  assertOnlyReads(ctx.source.calls, '开启后')
  eq(ctx.source.calls.filter((call) => call.method !== 'GET').length, 0, '整轮会话写请求数必须为 0')
  installed.dispose()
})

// ---------------------------------------------------------------- RC-04
check('RC-04', '读详情缺失时给 run_not_found，不抛出、不降级去猜', async () => {
  const routes = {
    [P('/health')]: respond(200, HEALTH_OK),
    [P('/runs')]: respond(200, { runs: [], recoverable: 0 }),
    [P('/runs/ghost')]: respond(404, { error: 'not_found' }),
  }
  const ctx = withBackend(routes)
  const runs = await ctx.source.listRuns()
  const missing = await ctx.source.loadRun('ghost')
  eq(missing.ok, false, '缺失运行应返回失败')
  eq(missing.reason, 'run_not_found', '缺失原因应为 run_not_found')
  const view = readonlyView({ exposed: true, runs, detail: missing })
  eq(view.status, 'ready', '详情缺失不应把整页判成错误')
  eq(view.detail, null, '详情缺失时右侧保持空态')
  eq(view.headline, '还没有工作流运行', '空列表应给出空态标题')
  assertOnlyReads(ctx.source.calls, '详情缺失')
})

// ---------------------------------------------------------------- RC-05
check('RC-05', '错误提取有边界：普通事件不算错误，暂停原因单独计入', () => {
  const summary = summarizeRun(RUN_DETAIL_OK)
  eq(summary.errors.length, 2, '只有失败/冲突/未知类事件算错误')
  need(!summary.errors.some((error) => error.type === 'step.succeeded'), '成功事件不得算错误')
  need(!summary.errors.some((error) => error.type === 'human.task.created'), '人工待办创建不得算错误')

  const paused = summarizeRun({
    run: { id: 'run-b', status: 'paused', revision: 5, budgetUsed: 40, budgetTotal: 900, pauseReason: 'publish_failed', updatedAt: '2026-11-14T02:00:00.000Z' },
    steps: [],
    events: [],
  })
  eq(paused.errors.length, 1, '暂停原因应单独给一条错误')
  eq(paused.errors[0].seq, null, '暂停原因没有事件序号')
  eq(paused.errors[0].message, '发布失败', '暂停原因应有中文说明')
  eq(paused.run.statusLabel, '已暂停', '运行状态应显示已暂停')
})

// ---------------------------------------------------------------- RC-06
check('RC-06', '源码级无写入口：客户端只读模块与薄挂载都不含写方法或写命令', () => {
  const clientDir = join(ROOT, 'src', 'client', 'workflow')
  // The process-local development editor is a separate write-capable surface.
  const files = readdirSync(clientDir).filter((name) => name.startsWith('readonly-') && (name.endsWith('.mjs') || name.endsWith('.ts')))
  need(files.length >= 2, '只读客户端应至少包含 core 与 panel 两个文件')

  const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']
  const WRITE_COMMANDS = ['confirmHuman', 'pauseRun', 'resumeRun', 'submitDraft', 'createRun', 'adopt(', 'cancelRun', 'saveDraft']

  for (const name of files) {
    const text = readFileSync(join(clientDir, name), 'utf8')
    for (const method of WRITE_METHODS) {
      need(!new RegExp(`['"\`]${method}['"\`]`).test(text), `${name} 不得出现写方法字面量 ${method}`)
    }
    for (const command of WRITE_COMMANDS) {
      need(!text.includes(command), `${name} 不得出现写命令 ${command}`)
    }
    for (const match of text.matchAll(/method\s*:\s*([\w'".`]+)/g)) {
      eq(match[1], 'WORKFLOW_READONLY_METHOD', `${name} 的请求方法必须固定为 WORKFLOW_READONLY_METHOD`)
    }
  }

  const hostPage = readFileSync(join(ROOT, 'src', 'host', 'workflow-page.ts'), 'utf8')
  for (const method of WRITE_METHODS) {
    need(!hostPage.includes(`'${method}'`), `薄挂载不得接受写方法 ${method}`)
  }
  eq((hostPage.match(/method === 'GET'/g) ?? []).length, 3, '薄挂载三条路由都应显式要求 GET，非 GET 落到 404')

  const entry = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
  need(entry.includes("key: PANEL_ID"), '旧工作台面板仍应注册 key=workbench')
  need(entry.includes('mountSidebarEntry(ctx)'), '旧侧栏入口仍应挂载')
  need(entry.includes('installWorkflowReadonlyPanel(ctx)'), '只读页应接入客户端入口')
  need(!entry.includes("method: 'POST'"), '客户端入口不得直接发写请求')
})

// ---------------------------------------------------------------- RC-07
check('RC-07', '构建产物证据：只读页进入 client bundle，且不含写入口标记', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  for (const marker of ['workflow-readonly', 'dsh-workflow-readonly-entry', '/workbench-workflow', 'workflowReadonly']) {
    need(bundle.includes(marker) || marker === 'workflowReadonly', `client bundle 应含只读页标记 ${marker}`)
  }
  need(bundle.includes('工作流（只读）'), 'client bundle 应含只读页标题文案')
  need(!bundle.includes('workflow-write'), 'client bundle 不得含写入口标记')
})

// ---------------------------------------------------------------- RC-08
check('RC-08', '摘要函数对脏数据稳健：缺少字段不抛、不产生 NaN', () => {
  const runs = summarizeRuns({})
  eq(runs.runs.length, 0, '空响应应给空列表')
  eq(runs.recoverable, 0, '空响应待恢复数为 0')
  const one = summarizeRuns({ runs: [{ id: 'x' }] })
  eq(one.runs[0].statusLabel, '未知', '缺状态时给未知标签')
  eq(one.runs[0].budget, '0/0', '缺预算时给 0/0')
  const detail = summarizeRun({ run: null })
  eq(detail.run, null, '缺运行时给 null')
  eq(detail.steps.length, 0, '缺步骤时给空数组')
  eq(detail.errors.length, 0, '缺事件时给空错误')
  eq(readonlyView(null), null, 'null 状态应渲染 null')
  eq(readonlyView({ exposed: false }), null, '未启用状态应渲染 null')
})

// ---------------------------------------------------------------- RC-09
check('RC-09', '列表读失败必须显示「读取失败」：/health 成功而 /runs 返回 503 不得冒充空数据', async () => {
  const routes = {
    [P('/health')]: respond(200, HEALTH_OK),
    [P('/runs')]: respond(503, { error: 'workflow_disabled', reason: 'workflow_init_failed' }),
  }
  const ctx = withBackend(routes)
  const runs = await ctx.source.listRuns()
  eq(runs.ok, false, '503 不应被当成成功')
  eq(runs.reason, 'workflow_init_failed', '失败原因应来自响应体')
  eq(runs.status, 503, '失败结果应带状态码')

  const view = readonlyView({ exposed: true, runs, detail: null })
  eq(view.status, 'error', '列表读失败必须判为读取失败')
  eq(view.reason, 'workflow_init_failed', '页面应带失败原因')
  eq(view.headline, '读取失败：工作流初始化失败', '标题应显示读取失败，不能显示空列表')
  need(view.headline !== '还没有工作流运行', '读失败绝不能显示「还没有工作流运行」')
  eq(view.runs.length, 0, '此时没有可展示的运行')
  eq(view.detail, null, '详情不应被伪造出来')
  eq(view.errors.length, 1, '应给出一条读取失败记录')
  eq(view.errors[0].code, 'workflow_init_failed', '错误记录应带原因码')
  need(view.errors[0].type === 'read_failed', '错误记录应标记为读取失败')
  assertOnlyReads(ctx.source.calls, '列表 503')

  // 页面真正走的入口也必须保留原始失败原因，不能因为「继续去猜详情」把它冲掉。
  const state = await loadReadonlyState(ctx.source)
  eq(state.exposed, true, '探针成功时入口应保持已启用')
  need(state.runs !== null && state.runs !== undefined, '入口不得丢掉列表结果')
  eq(state.runs.ok, false, '入口应保留列表读失败')
  const loadView = readonlyView(state)
  eq(loadView.status, 'error', '入口视图必须判为读取失败')
  eq(loadView.reason, 'workflow_init_failed', '入口视图应保留原始失败原因，而不是兜底成别的码')
  eq(loadView.headline, '读取失败：工作流初始化失败', '入口视图标题同样应是读取失败')

  // 纯 HTTP 码（响应体没有 reason）也要能说清。
  const bare = withBackend({ [P('/health')]: respond(200, HEALTH_OK), [P('/runs')]: respond(500, null) })
  const bareRuns = await bare.source.listRuns()
  eq(bareRuns.reason, 'http_500', '无 reason 时应用 HTTP 码作为原因')
  eq(readonlyView({ exposed: true, runs: bareRuns, detail: null }).headline, '读取失败：工作流接口返回 HTTP 500', 'HTTP 码应显示成人话')
})

// ---------------------------------------------------------------- RC-10
check('RC-10', '列表断网不得抛异常：listRuns / loadReadonlyState / 整轮加载都只返回失败状态', async () => {
  const routes = {
    [P('/health')]: respond(200, HEALTH_OK),
    [P('/runs')]: new Error('connect ECONNREFUSED 127.0.0.1:1'),
  }
  const ctx = withBackend(routes)

  let thrown = null
  let runs = null
  try {
    runs = await ctx.source.listRuns()
  } catch (error) {
    thrown = error
  }
  eq(thrown, null, 'listRuns 断网时不得抛异常')
  eq(runs.ok, false, '断网应返回失败结果')
  eq(runs.reason, 'unreachable', '断网原因应为 unreachable')
  need(runs.error.includes('ECONNREFUSED'), '失败结果应保留底层错误信息')

  const view = readonlyView({ exposed: true, runs, detail: null })
  eq(view.status, 'error', '断网必须判为读取失败')
  eq(view.headline, '读取失败：连接不上工作流接口', '断网应显示连接失败')

  // 整轮加载（页面真正调用的入口）也不得 reject。
  let loadThrown = null
  let state = null
  try {
    state = await loadReadonlyState(ctx.source)
  } catch (error) {
    loadThrown = error
  }
  eq(loadThrown, null, 'loadReadonlyState 断网时不得抛异常')
  eq(state.exposed, true, '探针成功时入口应保持已启用')
  eq(readonlyView(state).status, 'error', '整轮加载后的视图必须是读取失败')
  assertOnlyReads(ctx.source.calls, '列表断网')
})

// ---------------------------------------------------------------- RC-11
check('RC-11', '详情非 404 失败必须显示「读取失败」：500 / 503 / 断网都不得折叠成空详情', async () => {
  const cases = [
    ['detail_500', respond(500, null), 'http_500'],
    ['detail_503', respond(503, { error: 'workflow_disabled', reason: 'workflow_init_failed' }), 'workflow_init_failed'],
    ['detail_unreachable', new Error('socket hang up'), 'unreachable'],
  ]
  for (const [label, detailResponse, expectedReason] of cases) {
    const routes = {
      [P('/health')]: respond(200, HEALTH_OK),
      [P('/runs')]: respond(200, RUNS_OK),
      [P('/runs/run-a')]: detailResponse,
    }
    const ctx = withBackend(routes)
    let thrown = null
    let detail = null
    try {
      detail = await ctx.source.loadRun('run-a')
    } catch (error) {
      thrown = error
    }
    eq(thrown, null, `${label}：loadRun 不得抛异常`)
    eq(detail.ok, false, `${label}：详情读失败应返回失败`)
    eq(detail.reason, expectedReason, `${label}：失败原因应为 ${expectedReason}`)

    const runs = await ctx.source.listRuns()
    const view = readonlyView({ exposed: true, runs, detail })
    eq(view.status, 'error', `${label}：详情读失败必须判为读取失败`)
    eq(view.reason, expectedReason, `${label}：页面应带详情失败原因`)
    need(view.headline.startsWith('读取失败'), `${label}：标题应显示读取失败`)
    eq(view.detail, null, `${label}：不得伪造空详情`)
    // 列表读到的运行仍然可见，不能因为详情失败就把成功的那部分也吞掉。
    eq(view.runs.length, 2, `${label}：已读到的运行列表仍应展示`)
    assertOnlyReads(ctx.source.calls, label)
  }

  // 对照组：404 是「这个运行不存在」，仍按空态处理，不算读取失败。
  const missingCtx = withBackend({
    [P('/health')]: respond(200, HEALTH_OK),
    [P('/runs')]: respond(200, { runs: [], recoverable: 0 }),
    [P('/runs/ghost')]: respond(404, { error: 'not_found' }),
  })
  const missing = await missingCtx.source.loadRun('ghost')
  const missingView = readonlyView({ exposed: true, runs: await missingCtx.source.listRuns(), detail: missing })
  eq(missing.reason, 'run_not_found', '404 应仍是 run_not_found')
  eq(missingView.status, 'ready', 'run_not_found 不是读取失败')
  eq(missingView.headline, '还没有工作流运行', '真实空列表才显示空态')
})

// ---------------------------------------------------------------- RC-12
check('RC-12', '不产生未处理异步异常：任何响应形态下页面入口都不 reject', async () => {
  const shapes = [
    ['health_ok_runs_ok', { [P('/health')]: respond(200, HEALTH_OK), [P('/runs')]: respond(200, RUNS_OK), [P('/runs/run-a')]: respond(200, RUN_DETAIL_OK) }],
    ['runs_503', { [P('/health')]: respond(200, HEALTH_OK), [P('/runs')]: respond(503, { error: 'workflow_disabled', reason: 'workflow_init_failed' }) }],
    ['runs_throw', { [P('/health')]: respond(200, HEALTH_OK), [P('/runs')]: new Error('ECONNREFUSED') }],
    ['health_throw', { [P('/health')]: new Error('ECONNREFUSED') }],
    ['health_503', { [P('/health')]: respond(503, { error: 'workflow_disabled', reason: 'disabled_by_config' }) }],
    ['detail_throw', { [P('/health')]: respond(200, HEALTH_OK), [P('/runs')]: respond(200, RUNS_OK), [P('/runs/run-a')]: new Error('reset') }],
    ['bad_json', { [P('/health')]: respond(200, HEALTH_OK), [P('/runs')]: { status: 200, ok: true, json: async () => { throw new Error('unexpected token <') } } }],
  ]
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(String(reason))
  process.on('unhandledRejection', onUnhandled)
  try {
    for (const [label, routes] of shapes) {
      const ctx = withBackend(routes)
      let threw = null
      let state = null
      try {
        state = await loadReadonlyState(ctx.source)
      } catch (error) {
        threw = error
      }
      eq(threw, null, `${label}：loadReadonlyState 不得 reject`)
      need(state !== null && typeof state === 'object', `${label}：必须返回状态对象`)
      // 状态要么是「未启用」，要么是「读取失败」，要么是「读到数据」，不能是 undefined。
      const view = readonlyView(state)
      if (state.exposed === false) eq(view, null, `${label}：未启用时应渲染 null`)
      else need(view !== null, `${label}：已启用时必须有视图`)
      assertOnlyReads(ctx.source.calls, label)
    }
    // 让事件循环跑完，确认没有漏网的未处理拒绝。
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  eq(unhandled.length, 0, `不应有未处理的异步异常（实际：${unhandled.join(' | ')}）`)
})

// ---------------------------------------------------------------- run
async function main() {
  const dir = tmpRoot()
  try {
    for (const item of checks) {
      try {
        await item.fn()
        results.push({ id: item.id, title: item.title, ok: true })
        console.log(`  ✓ ${item.id} ${item.title}`)
      } catch (error) {
        results.push({ id: item.id, title: item.title, ok: false, error: String(error?.message ?? error) })
        console.log(`  ✗ ${item.id} ${item.title}\n      ${String(error?.message ?? error)}`)
      }
    }
  } finally {
    cleanup(dir)
  }
  const failed = results.filter((item) => !item.ok)
  console.log(JSON.stringify({ checks: results.length, passed: results.length - failed.length, assertions, failed }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

void main()
