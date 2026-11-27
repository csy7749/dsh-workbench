/**
 * 工具策略 · 纯函数层（宿主 / 客户端共用）
 *
 * 参考 Locus 的做法，把「哪些工具这次能用」拆成三段，而不是一个总开关：
 *  1. 工具目录（catalog）：工具名 → { group 分组, capability 能力 }；
 *  2. 用户覆盖（overrides）：只存「偏离默认值」的显式开关，默认值随时可调；
 *  3. 能力档（profile）：按能力集合一次收窄一片工具（给未来的工具流/节点用）。
 *
 * 关键设计：档位只对「已知能力」生效，未知工具（DSH 内建的新工具）归到 other 且
 * 默认放行——这样收窄档位不会因为宿主升级而误伤一大批没登记过的工具。
 *
 * 不碰 DOM / fetch / node API，宿主、浏览器、脚本都能直接跑，便于单测。
 */

/* ------------------------------------------------------------------ */
/* 能力与分组                                                          */
/* ------------------------------------------------------------------ */

export const TOOL_CAPABILITIES = [
  'read',            // 只读查询
  'write.local',     // 改工作区文件 / 工作台正文
  'publish.product', // 写产品导图、模块、产品设计文档
  'publish.design',  // 写 UI 设计 / DEMO / 主题
  'publish.test',    // 写测试用例、测试文档、测试结果
  'publish.idea',    // 写灵感节点、产出进度
  'publish.ops',     // 写 Bug、新闻等运维类记录
  'exec',            // 执行命令 / 跑代码
  'network',         // 出网
  'delegate',        // 派生下属智能体
  'other',           // 未登记（默认放行，避免误伤）
] as const
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number]

export const CAPABILITY_LABELS: Record<ToolCapability, string> = {
  read: '只读查询',
  'write.local': '改本地文件',
  'publish.product': '写产品设计',
  'publish.design': '写 UI/DEMO',
  'publish.test': '写测试',
  'publish.idea': '写灵感',
  'publish.ops': '写 Bug/新闻',
  exec: '执行命令',
  network: '访问网络',
  delegate: '派生下属',
  other: '未登记工具',
}

export interface ToolMeta {
  name: string
  group: string
  capability: ToolCapability
  /** 面板上显示的中文名 */
  label: string
  /** 默认是否启用（v1 全部默认启用，保留字段给以后默认关闭类工具） */
  defaultEnabled?: boolean
}

/** 工作台自己的工具（与 src/host 里的注册名一一对应，verify 脚本会核对）。 */
export const WORKBENCH_TOOLS: ToolMeta[] = [
  { name: 'workbench_map_node_publish', group: '产品设计', capability: 'publish.product', label: '写产品导图节点' },
  { name: 'workbench_module_publish', group: '产品设计', capability: 'publish.product', label: '写模块/功能' },
  { name: 'workbench_product_note_publish', group: '产品设计', capability: 'publish.product', label: '写设计笔记' },
  { name: 'workbench_ui_doc_publish', group: 'UI/DEMO', capability: 'publish.design', label: '写 UI 设计' },
  { name: 'workbench_demo_publish', group: 'UI/DEMO', capability: 'publish.design', label: '交付 DEMO' },
  { name: 'workbench_theme_publish', group: 'UI/DEMO', capability: 'publish.design', label: '保存主题' },
  { name: 'workbench_testcase_publish', group: '测试', capability: 'publish.test', label: '写测试用例' },
  { name: 'workbench_test_doc_publish', group: '测试', capability: 'publish.test', label: '写测试设计文档' },
  { name: 'workbench_test_result_publish', group: '测试', capability: 'publish.test', label: '回写测试结果' },
  { name: 'workbench_idea_expand', group: '灵感', capability: 'publish.idea', label: '写灵感节点' },
  { name: 'workbench_idea_progress', group: '灵感', capability: 'publish.idea', label: '灵感进度' },
  { name: 'product_progress_publish', group: '灵感', capability: 'publish.idea', label: '产品流水线进度' },
  { name: 'workbench_bug_publish', group: 'Bug/新闻', capability: 'publish.ops', label: '新建 Bug' },
  { name: 'workbench_bug_update', group: 'Bug/新闻', capability: 'publish.ops', label: '更新 Bug' },
  { name: 'workbench_news_publish', group: 'Bug/新闻', capability: 'publish.ops', label: '写新闻订阅' },
  { name: 'workbench_note_update', group: '笔记', capability: 'write.local', label: '完善笔记正文' },
  { name: 'workbench_knowledge_search', group: '只读', capability: 'read', label: '检索项目知识' },
  { name: 'workbench_memory_search', group: '只读', capability: 'read', label: '检索记忆' },
  { name: 'workbench_memory_write', group: '记忆/团队', capability: 'write.local', label: '写记忆' },
  { name: 'workbench_game_create', group: '游戏工坊', capability: 'write.local', label: '创建游戏工程' },
  { name: 'workbench_game_build', group: '游戏工坊', capability: 'write.local', label: '构建游戏工程' },
  { name: 'workbench_game_preview', group: '游戏工坊', capability: 'read', label: '预览游戏构建' },
  { name: 'workbench_game_export', group: '游戏工坊', capability: 'write.local', label: '导出离线游戏' },
  { name: 'workbench_game_playtest', group: '游戏工坊', capability: 'exec', label: '浏览器自动试玩' },
  { name: 'workbench_game_history', group: '游戏工坊', capability: 'read', label: '游戏版本与差异' },
  { name: 'workbench_game_restore', group: '游戏工坊', capability: 'write.local', label: '恢复游戏版本' },
  { name: 'workbench_game_asset_list', group: '游戏工坊', capability: 'read', label: '读取游戏素材候选' },
  { name: 'workbench_game_asset_generate', group: '游戏工坊', capability: 'write.local', label: '生成本地原创素材' },
  { name: 'workbench_game_asset_adopt', group: '游戏工坊', capability: 'write.local', label: '采用游戏素材' },
  { name: 'workbench_game_media_crop', group: '游戏工坊', capability: 'write.local', label: '裁切游戏图片' },
  { name: 'workbench_game_media_grid_split', group: '游戏工坊', capability: 'write.local', label: '切分游戏精灵表' },
  { name: 'workbench_game_blender', group: '游戏工坊', capability: 'exec', label: 'Blender受限导出' },
  { name: 'workbench_game_revision_propose', group: '游戏工坊', capability: 'write.local', label: '提出游戏源码候选' },
  { name: 'workbench_game_revision_verify', group: '游戏工坊', capability: 'exec', label: '核验游戏源码候选' },
  { name: 'workbench_game_revision_recover', group: '游戏工坊', capability: 'write.local', label: '对账游戏修订' },
  { name: 'workbench_image_list', group: '图片素材', capability: 'read', label: '读取产品图片候选' },
  { name: 'workbench_image_generate', group: '图片素材', capability: 'network', label: '生成或编辑图片（可能消耗额度）' },
  { name: 'workbench_image_import', group: '图片素材', capability: 'write.local', label: '导入产品图片' },
  { name: 'workbench_image_select', group: '图片素材', capability: 'write.local', label: '选择产品图片素材' },
  { name: 'workbench_image_metadata', group: '图片素材', capability: 'write.local', label: '编辑图片标签与备注' },
  { name: 'workbench_image_check', group: '图片素材', capability: 'write.local', label: '记录图片技术检查' },
  { name: 'workbench_image_export', group: '图片素材', capability: 'read', label: '下载产品图片原图' },
  { name: 'workbench_team_list', group: '只读', capability: 'read', label: '读团队配置' },
]

/**
 * DSH 内建工具的分类表（精确名 + 前缀规则）。
 * 只需要覆盖「收窄时必须能挡住」的那批；其余归 other 默认放行。
 */
const BUILTIN_RULES: Array<{ test: (name: string) => boolean, meta: Omit<ToolMeta, 'name'> }> = [
  { test: name => ['generate_image', 'generate_images', 'edit_image', 'decompose_image_layers'].includes(name), meta: { group: '图片素材', capability: 'network', label: '图像模型调用（可能消耗额度）' } },
  { test: name => ['read', 'glob', 'grep', 'list', 'read_image'].includes(name), meta: { group: '文件', capability: 'read', label: '读文件' } },
  { test: name => ['write', 'edit'].includes(name), meta: { group: '文件', capability: 'write.local', label: '改文件' } },
  { test: name => ['bash', 'pwsh', 'ops_bash'].includes(name), meta: { group: '执行', capability: 'exec', label: '执行命令' } },
  { test: name => /^ops_/.test(name), meta: { group: '执行', capability: 'exec', label: 'OPS 动作' } },
  { test: name => name === 'run_code', meta: { group: '执行', capability: 'exec', label: '跑代码' } },
  { test: name => ['web_fetch', 'web_search'].includes(name), meta: { group: '网络', capability: 'network', label: '访问网络' } },
  { test: name => ['subagent', 'subagent_fork', 'spawn_teammate', 'send_message', 'wait_agent', 'list_agents', 'delegate'].includes(name), meta: { group: '派生', capability: 'delegate', label: '派生下属' } },
]

export function describeTool(name: string): ToolMeta {
  const known = WORKBENCH_TOOLS.find(tool => tool.name === name)
  if (known !== undefined) return known
  const rule = BUILTIN_RULES.find(item => item.test(name))
  if (rule !== undefined) return { name, ...rule.meta }
  return { name, group: '其他', capability: 'other', label: name }
}

/* ------------------------------------------------------------------ */
/* 档位（profile）                                                     */
/* ------------------------------------------------------------------ */

export const TOOL_PROFILE_IDS = ['full', 'read-only', 'design', 'test', 'ops'] as const
export type ToolProfileId = (typeof TOOL_PROFILE_IDS)[number]

export interface ToolProfile {
  id: ToolkitProfileKey
  label: string
  description: string
  /** 允许的能力集合；other 不在其中也放行（见文件头）。 */
  capabilities: ToolCapability[]
  /** true 时 other 也拒绝（严格白名单），v1 全部 false。 */
  strict?: boolean
}

export type ToolkitProfileKey = string

export const TOOL_PROFILES: Record<string, ToolProfile> = {
  full: {
    id: 'full', label: '不限', description: '全部工具可用（默认，行为与之前一致）',
    capabilities: [...TOOL_CAPABILITIES],
  },
  'read-only': {
    id: 'read-only', label: '只读', description: '只能查资料与读配置，不能写任何产物',
    capabilities: ['read'],
  },
  design: {
    id: 'design', label: '设计产出', description: '读 + 写产品设计/UI/DEMO/灵感，不能执行命令与出网',
    capabilities: ['read', 'publish.product', 'publish.design', 'publish.idea', 'write.local'],
  },
  test: {
    id: 'test', label: '测试产出', description: '读 + 写测试用例与结果',
    capabilities: ['read', 'publish.test'],
  },
  ops: {
    id: 'ops', label: '运维产出', description: '读 + 写 Bug/新闻记录',
    capabilities: ['read', 'publish.ops'],
  },
}

export function normalizeProfile(raw: unknown): ToolProfileId {
  const id = typeof raw === 'string' ? raw.trim() : ''
  return (TOOL_PROFILE_IDS as readonly string[]).includes(id) ? id as ToolProfileId : 'full'
}

/* ------------------------------------------------------------------ */
/* 策略对象                                                            */
/* ------------------------------------------------------------------ */

export interface ToolPolicy {
  version: 1
  /** 只存偏离默认值的开关：false=禁用，true=显式启用（给以后默认关闭的工具留口） */
  overrides: Record<string, boolean>
  /** 能力级开关：false 整组禁用，优先级高于档位 */
  capabilities: Record<string, boolean>
  /** 功能 → 档位（派发时按 feature 取） */
  featureProfiles: Record<string, ToolProfileId>
  /** 未匹配功能时的默认档位 */
  defaultProfile: ToolProfileId
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  version: 1,
  overrides: {},
  capabilities: {},
  featureProfiles: {},
  defaultProfile: 'full',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 脏数据不入库：未知工具名/能力名/档位名一律丢弃，字段类型不对回落默认。 */
export function normalizeToolPolicy(raw: unknown): ToolPolicy {
  const out: ToolPolicy = { version: 1, overrides: {}, capabilities: {}, featureProfiles: {}, defaultProfile: 'full' }
  if (!isRecord(raw)) return out
  if (isRecord(raw.overrides)) {
    for (const [name, value] of Object.entries(raw.overrides)) {
      const key = String(name).trim()
      if (key === '' || typeof value !== 'boolean') continue
      out.overrides[key] = value
    }
  }
  if (isRecord(raw.capabilities)) {
    for (const [name, value] of Object.entries(raw.capabilities)) {
      if (!(TOOL_CAPABILITIES as readonly string[]).includes(name) || typeof value !== 'boolean') continue
      out.capabilities[name] = value
    }
  }
  if (isRecord(raw.featureProfiles)) {
    for (const [feature, value] of Object.entries(raw.featureProfiles)) {
      const key = String(feature).trim()
      if (key === '') continue
      out.featureProfiles[key] = normalizeProfile(value)
    }
  }
  out.defaultProfile = normalizeProfile(raw.defaultProfile)
  return out
}

/** 合并 patch（只覆盖出现的字段），返回规范化后的新策略。 */
export function mergeToolPolicy(current: ToolPolicy, patch: unknown): ToolPolicy {
  const base = normalizeToolPolicy(current)
  if (!isRecord(patch)) return base
  const merged: ToolPolicy = {
    version: 1,
    overrides: { ...base.overrides },
    capabilities: { ...base.capabilities },
    featureProfiles: { ...base.featureProfiles },
    defaultProfile: base.defaultProfile,
  }
  if (isRecord(patch.overrides)) {
    for (const [name, value] of Object.entries(patch.overrides)) {
      const key = String(name).trim()
      if (key === '') continue
      if (value === null || typeof value !== 'boolean') delete merged.overrides[key]
      else merged.overrides[key] = value
    }
  }
  if (isRecord(patch.capabilities)) {
    for (const [name, value] of Object.entries(patch.capabilities)) {
      if (!(TOOL_CAPABILITIES as readonly string[]).includes(name)) continue
      if (value === null || typeof value !== 'boolean') delete merged.capabilities[name]
      else merged.capabilities[name] = value
    }
  }
  if (isRecord(patch.featureProfiles)) {
    for (const [feature, value] of Object.entries(patch.featureProfiles)) {
      const key = String(feature).trim()
      if (key === '') continue
      if (value === null || value === '') delete merged.featureProfiles[key]
      else merged.featureProfiles[key] = normalizeProfile(value)
    }
  }
  if (patch.defaultProfile !== undefined) merged.defaultProfile = normalizeProfile(patch.defaultProfile)
  return merged
}

export function profileForFeature(policy: ToolPolicy, feature: string): ToolProfileId {
  const key = String(feature ?? '').trim()
  if (key !== '' && policy.featureProfiles[key] !== undefined) return policy.featureProfiles[key]
  return normalizeProfile(policy.defaultProfile)
}

/* ------------------------------------------------------------------ */
/* 求值                                                                */
/* ------------------------------------------------------------------ */

export const TOOL_DENY_CODES = [
  'disabled_by_user',
  'disabled_by_capability',
  'not_in_profile',
] as const
export type ToolDenyCode = (typeof TOOL_DENY_CODES)[number]

export type ToolDecisionCode = 'ok' | ToolDenyCode

export interface ToolDecision {
  allowed: boolean
  code: ToolDecisionCode
  /** 给人看的中文原因（拒绝时非空） */
  reason: string
  profile: ToolProfileId
  capability: ToolCapability
}

const DENY_TEXT: Record<ToolDenyCode, string> = {
  disabled_by_user: '这个工具已被手动关闭',
  disabled_by_capability: '该能力组已被关闭',
  not_in_profile: '当前工具档位不含该能力',
}

/** 单个工具的判定：用户开关 > 能力开关 > 档位 > 默认启用。 */
export function resolveTool(name: string, policy: ToolPolicy, profile?: string): ToolDecision {
  const meta = describeTool(name)
  const activeProfile = normalizeProfile(profile ?? policy.defaultProfile)
  const profileDef = TOOL_PROFILES[activeProfile] ?? TOOL_PROFILES.full
  const deny = (code: ToolDenyCode): ToolDecision => ({
    allowed: false, code, reason: `${DENY_TEXT[code]}（${meta.label}）`, profile: activeProfile, capability: meta.capability,
  })

  const override = policy.overrides[name]
  if (override === false) return deny('disabled_by_user')
  if (policy.capabilities[meta.capability] === false) return deny('disabled_by_capability')
  /* 显式启用优先于档位：用户明确打开了就不再被档位挡住（能力级关闭仍然优先）。 */
  if (override === true) return { allowed: true, code: 'ok', reason: '', profile: activeProfile, capability: meta.capability }

  const capabilityAllowed = profileDef.capabilities.includes(meta.capability)
  if (capabilityAllowed) return { allowed: true, code: 'ok', reason: '', profile: activeProfile, capability: meta.capability }
  if (meta.capability === 'other' && profileDef.strict !== true) {
    return { allowed: true, code: 'ok', reason: '', profile: activeProfile, capability: meta.capability }
  }
  return deny('not_in_profile')
}

export interface ResolvedToolList {
  allowed: string[]
  blocked: Array<{ name: string; code: ToolDenyCode; reason: string }>
}

export function resolveTools(names: readonly string[], policy: ToolPolicy, profile?: string): ResolvedToolList {
  const allowed: string[] = []
  const blocked: ResolvedToolList['blocked'] = []
  for (const name of names) {
    const decision = resolveTool(name, policy, profile)
    if (decision.allowed) allowed.push(name)
    else blocked.push({ name, code: decision.code as ToolDenyCode, reason: decision.reason })
  }
  return { allowed, blocked }
}

/* ------------------------------------------------------------------ */
/* 面板视图                                                            */
/* ------------------------------------------------------------------ */

export interface ToolPolicyViewItem extends ToolMeta {
  enabled: boolean
  code: ToolDecisionCode
  reason: string
}

export interface ToolPolicyView {
  policy: ToolPolicy
  profiles: Array<{ id: string; label: string; description: string; capabilities: ToolCapability[] }>
  capabilities: Array<{ id: ToolCapability; label: string; enabled: boolean }>
  /** 按分组归好的工具清单（面板直接渲染） */
  groups: Array<{ group: string; tools: ToolPolicyViewItem[] }>
  /** 某档位下会被挡住的工具名（派发前可先解释） */
  blocked: Array<{ name: string; code: ToolDenyCode; reason: string }>
  profile: ToolProfileId
}

export function buildToolPolicyView(names: readonly string[], policy: ToolPolicy, profile?: string): ToolPolicyView {
  const activeProfile = normalizeProfile(profile ?? policy.defaultProfile)
  const items: ToolPolicyViewItem[] = names.map(name => {
    const decision = resolveTool(name, policy, activeProfile)
    const meta = describeTool(name)
    return { ...meta, enabled: decision.allowed, code: decision.code, reason: decision.reason }
  })
  const byGroup = new Map<string, ToolPolicyViewItem[]>()
  for (const item of items) {
    const bucket = byGroup.get(item.group)
    if (bucket === undefined) byGroup.set(item.group, [item])
    else bucket.push(item)
  }
  const groups = [...byGroup.entries()]
    .map(([group, tools]) => ({ group, tools: tools.slice().sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.group.localeCompare(b.group, 'zh-Hans-CN'))
  return {
    policy,
    profiles: Object.values(TOOL_PROFILES).map(profileDef => ({
      id: profileDef.id, label: profileDef.label, description: profileDef.description, capabilities: profileDef.capabilities,
    })),
    capabilities: TOOL_CAPABILITIES.map(id => ({ id, label: CAPABILITY_LABELS[id], enabled: policy.capabilities[id] !== false })),
    groups,
    blocked: resolveTools(names, policy, activeProfile).blocked,
    profile: activeProfile,
  }
}

/** kickoff 里写给人看的一行：这次允许哪些能力、禁用了什么。 */
export function describePolicyForPrompt(names: readonly string[], policy: ToolPolicy, profile: string): string {
  const activeProfile = normalizeProfile(profile)
  const profileDef = TOOL_PROFILES[activeProfile] ?? TOOL_PROFILES.full
  const resolved = resolveTools(names, policy, activeProfile)
  const lines: string[] = []
  lines.push(`- 工具档：${profileDef.label}（${profileDef.description}）`)
  lines.push(`- 本次可用工具（${resolved.allowed.length} 个）：${resolved.allowed.join('、') || '（无）'}`)
  if (resolved.blocked.length > 0) {
    lines.push(`- 本次被禁用（${resolved.blocked.length} 个）：${resolved.blocked.map(item => item.name).join('、')}`)
    lines.push('- 被禁用的工具调用会被宿主直接拒绝；不要用 bash / write / 直连本机接口等方式绕过去，改用可用工具或如实报告缺口。')
  }
  return lines.join('\n')
}
