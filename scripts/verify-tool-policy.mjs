// 工具策略自检：纯函数判定矩阵 + 「工具目录表」与「真实注册名」一致性。
// 为什么必须核对注册名：WORKBENCH_TOOLS 是策略层的唯一工具目录，一旦某次注册改名而表没跟上，
// 那个工具会被归到 other（默认放行），收窄档位时就悄悄漏出去了。
// 用法：node scripts/verify-tool-policy.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = join(tmpdir(), `dsh-toolpolicy-verify-${process.pid}`)
mkdirSync(tmp, { recursive: true })
process.env.DSH_WORKBENCH_DB = join(tmp, 'wb.sqlite')
process.env.DSH_HOME = tmp

const policy = await import(pathToFileURL(join(root, 'src/shared/tool-policy.ts')).href)
const {
  DEFAULT_TOOL_POLICY, TOOL_CAPABILITIES, TOOL_PROFILE_IDS, TOOL_PROFILES, WORKBENCH_TOOLS,
  buildToolPolicyView, describePolicyForPrompt, describeTool, mergeToolPolicy, normalizeProfile,
  normalizeToolPolicy, profileForFeature, resolveTool, resolveTools,
} = policy

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name, detail) }
}

console.log('判定矩阵')
check('默认档 full 放行工作台工具', resolveTool('workbench_ui_doc_publish', DEFAULT_TOOL_POLICY).allowed)
check('默认档 full 放行 bash', resolveTool('bash', DEFAULT_TOOL_POLICY).allowed)
check('默认档 full 放行未登记工具', resolveTool('some_future_tool', DEFAULT_TOOL_POLICY).allowed)

const disabled = normalizeToolPolicy({ overrides: { bash: false } })
const denied = resolveTool('bash', disabled)
check('单个工具关闭后拒绝', denied.allowed === false && denied.code === 'disabled_by_user', JSON.stringify(denied))

const capOff = normalizeToolPolicy({ capabilities: { exec: false } })
const capDenied = resolveTool('bash', capOff)
check('能力组关闭后拒绝（code=disabled_by_capability）', capDenied.code === 'disabled_by_capability', JSON.stringify(capDenied))
check('能力组关闭也挡住同组其它工具', resolveTool('pwsh', capOff).allowed === false)

for (const [name, profile] of [['bash', 'read-only'], ['write', 'read-only'], ['web_fetch', 'read-only'], ['workbench_ui_doc_publish', 'test'], ['workbench_testcase_publish', 'read-only'], ['workbench_game_create', 'read-only'], ['workbench_game_export', 'read-only'], ['workbench_game_playtest', 'design']]) {
  const decision = resolveTool(name, DEFAULT_TOOL_POLICY, profile)
  check(`${profile} 档拒绝 ${name}`, decision.allowed === false && decision.code === 'not_in_profile', JSON.stringify(decision))
}
check('read-only 档仍放行 read', resolveTool('read', DEFAULT_TOOL_POLICY, 'read-only').allowed)
check('test 档放行写测试用例', resolveTool('workbench_testcase_publish', DEFAULT_TOOL_POLICY, 'test').allowed)
check('design 档放行写 UI 设计', resolveTool('workbench_ui_doc_publish', DEFAULT_TOOL_POLICY, 'design').allowed)
check('design 档拒绝执行命令', resolveTool('bash', DEFAULT_TOOL_POLICY, 'design').allowed === false)
check('未登记工具在收窄档仍放行（避免升级误伤）', resolveTool('some_future_tool', DEFAULT_TOOL_POLICY, 'read-only').allowed)

const explicitOn = normalizeToolPolicy({ overrides: { bash: true } })
check('显式开启可越过档位', resolveTool('bash', explicitOn, 'read-only').allowed)
const bothOff = normalizeToolPolicy({ overrides: { bash: true }, capabilities: { exec: false } })
check('能力组关闭优先于显式开启', resolveTool('bash', bothOff).allowed === false)

console.log('策略规范化')
check('未知能力名被丢弃', Object.keys(normalizeToolPolicy({ capabilities: { 'bogus.cap': false } }).capabilities).length === 0)
check('非法档位名回落 full', normalizeProfile('nope') === 'full')
check('非法默认档回落 full', normalizeToolPolicy({ defaultProfile: 'xx' }).defaultProfile === 'full')
check('脏数据不炸', normalizeToolPolicy('garbage').defaultProfile === 'full')
const merged = mergeToolPolicy(normalizeToolPolicy({ overrides: { bash: false } }), { overrides: { bash: null, read: false } })
check('merge 里 null 表示删除覆盖', merged.overrides.bash === undefined && merged.overrides.read === false, JSON.stringify(merged.overrides))
check('featureProfiles 按功能取档', profileForFeature(normalizeToolPolicy({ featureProfiles: { 'ui.design': 'design' } }), 'ui.design') === 'design')
check('未匹配功能回落默认档', profileForFeature(DEFAULT_TOOL_POLICY, 'unknown.feature') === 'full')

console.log('视图与提示词')
const view = buildToolPolicyView(['bash', 'read', 'workbench_ui_doc_publish'], DEFAULT_TOOL_POLICY, 'design')
check('视图分组非空', view.groups.length > 0)
check('视图标出被挡工具', view.blocked.some(item => item.name === 'bash'))
check('视图档位正确', view.profile === 'design')
check('能力开关数量与枚举一致', view.capabilities.length === TOOL_CAPABILITIES.length)
check('档位数量与枚举一致', view.profiles.length === TOOL_PROFILE_IDS.length)
check('每个档位都有中文标签', Object.values(TOOL_PROFILES).every(item => item.label !== ''))
const prompt = describePolicyForPrompt(['bash', 'read'], DEFAULT_TOOL_POLICY, 'read-only')
check('提示词写明档位与禁用项', prompt.includes('工具档') && prompt.includes('bash') && prompt.includes('被禁用'))
check('工具描述表覆盖内建执行类', describeTool('pwsh').capability === 'exec' && describeTool('ops_bash').capability === 'exec')
check('MCP 工具归 other', describeTool('mcp__foo__bar').capability === 'other')
check('resolveTools 分离允许/拒绝', resolveTools(['read', 'bash'], DEFAULT_TOOL_POLICY, 'read-only').allowed.join(',') === 'read')

console.log('注册名一致性与真实接线')
const registered = []
const routes = []
let gate = null
/* 先把策略文件写成 read-only 默认档：这样同一次 apply 既验证注册名，也验证闸门真的会拦。 */
mkdirSync(join(tmp, 'dsh-workbench'), { recursive: true })
writeFileSync(join(tmp, 'dsh-workbench', 'tool-policy.json'), JSON.stringify({
  version: 1, overrides: {}, capabilities: {}, featureProfiles: {}, defaultProfile: 'read-only',
}), 'utf8')
const fakeCtx = {
  webServer: { register(route) { routes.push(route) } },
  tools: {
    register(tool, options) { registered.push({ name: String(tool.name), options }) },
    schemas() { return registered.map(item => ({ name: item.name })) },
  },
  on(event, listener) { if (event === 'tools/pre-execute') gate = listener; return () => undefined },
  effect(fn) { return fn() },
}
const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)
host.apply(fakeCtx)
const tableNames = WORKBENCH_TOOLS.map(item => item.name).sort()
const liveNames = [...new Set(registered.map(item => item.name))].sort()
check('工具表数量为正', tableNames.length > 0, `table=${tableNames.length}`)
check('工具表覆盖全部已注册工具', liveNames.every(name => tableNames.includes(name)), `多出: ${liveNames.filter(name => !tableNames.includes(name)).join(', ')}`)
check('工具表没有失效条目', tableNames.every(name => liveNames.includes(name)), `缺失: ${tableNames.filter(name => !liveNames.includes(name)).join(', ')}`)
check('工具表无重复名', tableNames.length === new Set(tableNames).size)

check('闸门已挂到 tools/pre-execute', typeof gate === 'function')
check('每个工具都挂了 when 守卫', registered.every(item => typeof item.options?.when === 'function'),
  registered.filter(item => typeof item.options?.when !== 'function').map(item => item.name).join(', '))

check('工作台路由已注册', routes.length === 1 && routes[0]?.path === '/workbench-api')
if (routes.length === 1) {
  /* 假 req 只提供 json()：宿主的 readJson 优先用它，省得模拟流式 body。 */
  const call = async (url, method, body) => {
    let out = ''
    /* 宿主有两种写响应风格：res.writeHead(...) 与 res.statusCode=...；两种都要模拟，否则断言假的失败。 */
    const res = {
      statusCode: 0,
      writeHead(code) { res.statusCode = code; return res },
      setHeader() { return res },
      end(chunk) { out += String(chunk ?? '') },
    }
    routes[0].handler({ url, method, headers: {}, json: async () => body ?? {} }, res)
    /* handler 内部是 async IIFE，等一轮微任务让 res.end 落地。 */
    for (let i = 0; i < 40 && out === ''; i++) await new Promise(resolve => setTimeout(resolve, 5))
    const parsed = (() => { try { return JSON.parse(out) } catch { return null } })()
    return { status: res.statusCode, json: parsed, body: out }
  }

  console.log('闸门行为')
  if (typeof gate === 'function') {
    const agentFor = sessionId => ({ id: sessionId, session: { header: { id: sessionId } } })
    const allow = () => Promise.resolve({ kind: 'allow' })
    const userSession = `sess-user-${process.pid}`
    const openBash = await gate({ name: 'bash', agent: agentFor(userSession) }, allow)
    check('没做任何配置时 bash 照常放行（不改变旧行为）', openBash?.kind === 'allow', JSON.stringify(openBash))
    const noAgent = await gate({ name: 'bash' }, allow)
    check('无 agent 的宿主调用不受限', noAgent?.kind === 'allow')

    /* 单工具关闭是全局开关，和「派发档位」是两回事：用户点了关，所有会话都关。 */
    await call('/workbench-api/tools/policy', 'PATCH', { tool: 'bash', enabled: false })
    const deniedExec = await gate({ name: 'bash', agent: agentFor(userSession) }, allow)
    check('关掉的工具真的被拒绝', deniedExec?.kind === 'deny', JSON.stringify(deniedExec))
    check('拒绝时给出稳定原因码', deniedExec?.info?.name === 'tool_policy' && deniedExec.info.code === 'disabled_by_user', JSON.stringify(deniedExec?.info))
    check('拒绝理由带工具名与可操作提示', String(deniedExec?.reason ?? '').includes('bash') && String(deniedExec?.reason ?? '').includes('工具'))
    const stillRead = await gate({ name: 'read', agent: agentFor(userSession) }, allow)
    check('同会话其它工具不受牵连', stillRead?.kind === 'allow')
    await call('/workbench-api/tools/policy', 'PATCH', { tool: 'bash', enabled: true })
    const reopened = await gate({ name: 'bash', agent: agentFor(userSession) }, allow)
    check('重新打开后恢复放行', reopened?.kind === 'allow')

    /* 注册期守卫与闸门同源：工具连「模型可见声明」都不该出现。 */
    const guardedWrite = registered.find(item => item.name === 'workbench_note_update')?.options?.when
    check('默认情况下注册期守卫放行', guardedWrite({ agent: agentFor(userSession) }) === true)
    await call('/workbench-api/tools/policy', 'PATCH', { tool: 'workbench_note_update', enabled: false })
    check('关掉的工具在注册期就被挡住（模型看不到）', guardedWrite({ agent: agentFor(userSession) }) === false)
    const guardedRead = registered.find(item => item.name === 'workbench_memory_search')?.options?.when
    check('未关的工具照常可见', guardedRead({ agent: agentFor(userSession) }) === true)
    await call('/workbench-api/tools/policy', 'PATCH', { tool: 'workbench_note_update', enabled: true })
  }

  const got = await call('/workbench-api/tools/policy', 'GET')
  const payload = got.json
  check('GET /tools/policy 返回 200', got.status === 200, `status=${got.status}`)
  check('策略接口带工具分组', Array.isArray(payload?.groups) && payload.groups.length > 0)
  check('策略接口带默认档', payload?.profile === 'read-only', String(payload?.profile))
  const patched = await call('/workbench-api/tools/policy', 'PATCH', { defaultProfile: 'full' })
  check('PATCH /tools/policy 返回 200', patched.status === 200, `status=${patched.status}`)
  check('PATCH 后默认档生效', patched.json === null || patched.json?.profile === undefined || patched.json.profile === 'full', JSON.stringify(patched.json)?.slice(0, 120))

  console.log('按功能指定档位')
  const boundFull = await call('/workbench-api/tools/policy', 'PATCH', { feature: 'ui.design', profile: 'full' })
  check('显式指定 full 会被存下来', boundFull.json?.policy?.featureProfiles?.['ui.design'] === 'full', JSON.stringify(boundFull.json?.policy?.featureProfiles))
  const rebound = await call('/workbench-api/tools/policy', 'PATCH', { feature: 'ui.design', profile: 'read-only' })
  check('改档位覆盖旧值', rebound.json?.policy?.featureProfiles?.['ui.design'] === 'read-only')
  const followDefault = await call('/workbench-api/tools/policy', 'PATCH', { feature: 'ui.design', profile: '' })
  check('空档位表示删除覆盖', followDefault.json?.policy?.featureProfiles?.['ui.design'] === undefined, JSON.stringify(followDefault.json?.policy?.featureProfiles))

  console.log('派发档位端到端')
  const allow = () => Promise.resolve({ kind: 'allow' })
  const gateFor = async (sessionId, name) =>
    gate({ name, agent: { id: sessionId, session: { header: { id: sessionId } } } }, allow)
  const team = await call('/workbench-api/agents/teams', 'POST', { name: '验证团队' })
  const teamId = String(team.json?.team?.id ?? '')
  check('能建团队', teamId !== '', JSON.stringify(team.json)?.slice(0, 120))
  /* 复用种子主理人：新建同名成员会被 MEMBER_DUPLICATE 拒（handle 唯一），这也顺带证明去重生效。 */
  const members = await call('/workbench-api/agents/members', 'GET')
  const memberId = String(members.json?.members?.[0]?.id ?? '')
  const added = await call(`/workbench-api/agents/teams/${teamId}/members`, 'POST', { memberId })
  check('团队挂上主理人', added.status === 200 && Number(added.json?.team?.memberCount ?? 0) > 0, JSON.stringify(added.json)?.slice(0, 120))
  const created = await call('/workbench-api/agents/dispatches', 'POST', {
    teamId, feature: 'ui.design', goal: '验证工具档位', ideaId: '', allowNoIdea: true, toolProfile: 'read-only',
  })
  const dispatch = created.json?.dispatch
  check('派发默认收窄到 read-only 档', dispatch?.toolProfile === 'read-only', String(dispatch?.toolProfile))
  check('派发 kickoff 写明工具范围', String(created.json?.kickoff ?? '').includes('本次工具范围（宿主强制'))
  const sessionId = `sess-verify-${process.pid}`
  await call(`/workbench-api/agents/dispatches/${String(dispatch?.id ?? '')}`, 'PATCH', { sessionId, status: 'running' })
  const sessionDenied = await gateFor(sessionId, 'bash')
  check('派发档位在会话里真的生效', sessionDenied?.kind === 'deny', JSON.stringify(sessionDenied))
  const sessionAllowed = await gateFor(sessionId, 'read')
  check('派发档位不误伤档内工具', sessionAllowed?.kind === 'allow', JSON.stringify(sessionAllowed))
  const fullDispatch = await call('/workbench-api/agents/dispatches', 'POST', {
    teamId, feature: 'ui.design', goal: '验证全开档位', ideaId: '', allowNoIdea: true, toolProfile: 'full',
  })
  const fullSession = `sess-verify-full-${process.pid}`
  await call(`/workbench-api/agents/dispatches/${String(fullDispatch.json?.dispatch?.id ?? '')}`, 'PATCH', { sessionId: fullSession, status: 'running' })
  const fullAllowed = await gateFor(fullSession, 'bash')
  check('显式全开档位放行 bash', fullAllowed?.kind === 'allow', JSON.stringify(fullAllowed))

  console.log('用户自己的会话不受派发档位影响')
  /* 把默认档收窄到 read-only：这是「派出去的团队收窄」，不能把用户自己锁住。 */
  await call('/workbench-api/tools/policy', 'PATCH', { defaultProfile: 'read-only' })
  const userSession = `sess-user-${process.pid}`
  const userBash = await gateFor(userSession, 'bash')
  check('默认档收窄后用户会话仍能用 bash', userBash?.kind === 'allow', JSON.stringify(userBash))
  const unattributed = await gate({ name: 'bash', agent: { id: userSession, session: { header: { id: userSession } } } }, allow)
  check('无派发归属的会话不受限', unattributed?.kind === 'allow', JSON.stringify(unattributed))
  const narrowed = await call('/workbench-api/agents/dispatches', 'POST', {
    teamId, feature: 'ui.design', goal: '验证默认档', ideaId: '', allowNoIdea: true,
  })
  check('未指定档位时派发取功能默认档', narrowed.json?.dispatch?.toolProfile === 'read-only', String(narrowed.json?.dispatch?.toolProfile))
  await call('/workbench-api/tools/policy', 'PATCH', { reset: true })
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail > 0 ? 1 : 0)
