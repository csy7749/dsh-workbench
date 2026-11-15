/**
 * 工作流画布 · 节点目录与图模型（纯函数，宿主与浏览器共用）
 *
 * 三条产品线共用一套执行语义（输入 → 生成/设计 → 人工 → 校验 → 发布），
 * 差别只在节点目录与模板：游戏走 GDD/数值/关卡/Unity 导入，小说走设定/大纲/章节/文风，
 * 短剧走故事/分镜/角色一致/配音交付。加一条产品线 = 加一组 NodeDef + 模板，不改内核。
 *
 * 这个文件里没有 DOM、没有 IO、没有时间：便于 node 直接 import 做断言。
 */

export type PortType = 'file-set' | 'markdown' | 'text' | 'json' | 'report' | 'table' | 'any' | 'control'
export type NodeCategory = 'input' | 'retrieve' | 'design' | 'generate' | 'tool' | 'human' | 'check' | 'output'
export type ProductLineId = 'game' | 'novel' | 'drama'
/** agent=DSH Agent 执行 / human=人等确认 / auto=确定性程序（解析、导出） */
export type Actor = 'agent' | 'human' | 'auto'
export type ConfigKind = 'select' | 'number' | 'text' | 'textarea' | 'range' | 'check'
export type ConfigValue = string | number | boolean

export interface PortSpec {
  id: string
  label: string
  type: PortType
  /** true = 可以不接线（如汇总节点的第 2、3 路） */
  optional?: boolean
}

export interface ConfigField {
  key: string
  label: string
  kind: ConfigKind
  value: ConfigValue
  options?: string[]
  min?: number
  max?: number
  step?: number
  hint?: string
}

export interface NodeDef {
  id: string
  title: string
  cat: NodeCategory
  actor: Actor
  hint: string
  /** 省略 = 三条产品线都可用 */
  lines?: ProductLineId[]
  inputs: PortSpec[]
  outputs: PortSpec[]
  config: ConfigField[]
}

export const TYPE_COLOR: Record<PortType, string> = {
  'file-set': '#34d399',
  markdown: '#a78bfa',
  text: '#60a5fa',
  json: '#22d3ee',
  report: '#f472b6',
  table: '#fbbf24',
  any: '#94a3b8',
  control: '#eab308',
}

export const TYPE_LABEL: Record<PortType, string> = {
  'file-set': '文件集',
  markdown: 'Markdown',
  text: '文本',
  json: 'JSON',
  report: '报告',
  table: '表格',
  any: '任意',
  control: '控制',
}

export interface CategorySpec { id: NodeCategory; name: string; accent: string; hint: string }

export const CATEGORIES: CategorySpec[] = [
  { id: 'input', name: '输入', accent: '#34d399', hint: '流程的起点：需求、文档、已有产物' },
  { id: 'retrieve', name: '检索', accent: '#22d3ee', hint: '取知识与上下文，不产出新内容' },
  { id: 'design', name: '设计', accent: '#a78bfa', hint: '先定结构再写：设定、大纲、GDD、分镜' },
  { id: 'generate', name: '生成', accent: '#8b5cf6', hint: '按上游结构产出正文' },
  { id: 'tool', name: '工具', accent: '#38bdf8', hint: '确定性动作：汇总、解析、导出' },
  { id: 'human', name: '人工', accent: '#fbbf24', hint: '停在这里等人改完、确认再继续' },
  { id: 'check', name: '校验', accent: '#60a5fa', hint: '机器可判的规则：不合格就分流' },
  { id: 'output', name: '输出', accent: '#f472b6', hint: '落库、落工程、落交付包' },
]

export interface ProductLine {
  id: ProductLineId
  name: string
  short: string
  accent: string
  summary: string
  focus: string[]
}

export const PRODUCT_LINES: ProductLine[] = [
  { id: 'game', name: '游戏', short: '游戏', accent: '#34d399', summary: '玩法设计 → 数值/关卡/美术需求 → 人工评审 → 导入 Unity 工程', focus: ['GDD', '数值表', '关卡草案', '美术清单', 'Unity 导入'] },
  { id: 'novel', name: '小说', short: '小说', accent: '#a78bfa', summary: '设定集 → 人物 → 分卷大纲 → 章节正文 → 文风一致性 → 导出', focus: ['设定集', '分卷大纲', '章节正文', '文风校验'] },
  { id: 'drama', name: 'AI 短剧', short: '短剧', accent: '#f472b6', summary: '一句话故事 → 分镜脚本 → 分镜表 → 角色一致 → 配音字幕 → 交付包', focus: ['故事核', '分镜脚本', '角色一致性', '配音字幕'] },
]

export function lineOf(id: string): ProductLine {
  return PRODUCT_LINES.find(item => item.id === id) ?? PRODUCT_LINES[0]
}

/* ------------------------------------------------------------------ *
 * 节点目录
 * ------------------------------------------------------------------ */

export const NODE_DEFS: NodeDef[] = [
  /* ---------------- 通用 ---------------- */
  {
    id: 'input.brief', title: '需求 / 一句话', cat: 'input', actor: 'human',
    hint: '把这次要做什么写成一句话；下游所有生成都读它。',
    inputs: [], outputs: [{ id: 'out', label: '需求', type: 'text' }],
    config: [
      { key: 'text', label: '需求原文', kind: 'textarea', value: '', hint: '例：做一套环形卡牌战斗的中式玄幻原型，先出可试玩的第一关。' },
      { key: 'mustExist', label: '必须填写', kind: 'check', value: true },
    ],
  },
  {
    id: 'input.doc', title: '输入文档', cat: 'input', actor: 'auto',
    hint: '引用已有材料：产品笔记、模块文档、本地文件或项目里的规格。',
    inputs: [], outputs: [{ id: 'out', label: '文档', type: 'file-set' }],
    config: [
      { key: 'source', label: '来源', kind: 'select', options: ['产品笔记', '模块文档', '项目文件', '本地上传'], value: '产品笔记' },
      { key: 'path', label: '路径 / 标题', kind: 'text', value: '', hint: '留空表示运行时再选' },
      { key: 'mustExist', label: '必须存在', kind: 'check', value: true },
    ],
  },
  {
    id: 'retrieve.knowledge', title: '知识检索', cat: 'retrieve', actor: 'auto',
    hint: '从知识库取相关片段，给生成节点当事实依据。',
    inputs: [{ id: 'q', label: '查询', type: 'text' }],
    outputs: [{ id: 'hits', label: '片段', type: 'json' }],
    config: [
      { key: 'topK', label: '返回条数', kind: 'number', min: 1, max: 30, value: 6 },
      { key: 'scope', label: '范围', kind: 'select', options: ['本项目', '全部知识库'], value: '本项目' },
    ],
  },
  {
    id: 'flow.join', title: '汇总输入', cat: 'tool', actor: 'auto',
    hint: '把几路产物合并成一份上下文：一个端口只收一条线，多路就靠它并流。',
    inputs: [
      { id: 'a', label: '输入 A', type: 'any' },
      { id: 'b', label: '输入 B', type: 'any', optional: true },
      { id: 'c', label: '输入 C', type: 'any', optional: true },
    ],
    outputs: [{ id: 'out', label: '合并', type: 'any' }],
    config: [
      { key: 'order', label: '拼接顺序', kind: 'select', options: ['按端口', '按标题', '按时间'], value: '按端口' },
      { key: 'separator', label: '分隔符', kind: 'text', value: '---' },
    ],
  },
  {
    id: 'dsh.generate', title: 'DSH 生成', cat: 'generate', actor: 'agent',
    hint: '派一个 Agent 按提示词产出正文；提示词里可用双大括号引用上游产物。',
    inputs: [{ id: 'in', label: '输入', type: 'any' }], outputs: [{ id: 'out', label: '产物', type: 'markdown' }],
    config: [
      { key: 'profile', label: '执行配置', kind: 'select', options: ['默认', '经济', '强力'], value: '默认' },
      { key: 'prompt', label: '提示词', kind: 'textarea', value: '', hint: '用 {{in}} 引用上游产物，用 {{brief}} 引用需求。' },
      { key: 'temperature', label: '温度', kind: 'range', min: 0, max: 1, step: 0.1, value: 0.4 },
      { key: 'allowTools', label: '允许调用工具', kind: 'check', value: false },
    ],
  },
  {
    id: 'tool.call', title: '工具调用', cat: 'tool', actor: 'auto',
    hint: '调一个已登记的工作台工具，参数可用 {{in}} 映射上游产物。',
    inputs: [{ id: 'in', label: '输入', type: 'any' }], outputs: [{ id: 'out', label: '结果', type: 'json' }],
    config: [
      { key: 'tool', label: '已登记工具', kind: 'select', options: ['knowledge.search', 'product.module.set', 'note.publish', 'testcase.publish'], value: 'knowledge.search' },
      { key: 'args', label: '参数映射 (JSON)', kind: 'textarea', value: '{ "query": "{{in}}" }' },
    ],
  },
  {
    id: 'human.review', title: '人工审核', cat: 'human', actor: 'human',
    hint: '流程在这里停下，等人改完点「确认并继续」；运行记录会留下谁改了什么。',
    inputs: [{ id: 'in', label: '输入', type: 'any' }], outputs: [{ id: 'out', label: '已确认', type: 'any' }],
    config: [
      { key: 'editor', label: '编辑器', kind: 'select', options: ['Markdown', '表格', '富文本', '纯文本'], value: 'Markdown' },
      { key: 'note', label: '给审阅者的说明', kind: 'textarea', value: '', hint: '写清这次要看什么、改到什么程度算过。' },
      { key: 'timeout', label: '超时（分钟）', kind: 'number', min: 0, max: 10080, value: 120 },
    ],
  },
  {
    id: 'check.rules', title: '规则校验', cat: 'check', actor: 'auto',
    hint: '机器能判的硬规则；通过走一路、不通过走另一路，不要靠人眼盯。',
    inputs: [{ id: 'in', label: '输入', type: 'any' }],
    outputs: [
      { id: 'pass', label: '通过', type: 'any' },
      { id: 'fail', label: '未通过', type: 'report' },
    ],
    config: [
      { key: 'rules', label: '必需检查', kind: 'select', options: ['非空', '结构完整', '引用可解析', '无占位符', '字数达标'], value: '非空' },
      { key: 'strict', label: '任一失败即中断', kind: 'check', value: true },
      { key: 'expect', label: '期望值', kind: 'text', value: '', hint: '非空类留空；字数达标填最小字数。' },
    ],
  },
  {
    id: 'output.publish', title: '发布到领域', cat: 'output', actor: 'auto',
    hint: '把产物落到工作台里（产品模块 / 设计笔记 / 文件导出）。',
    inputs: [{ id: 'in', label: '输入', type: 'any' }], outputs: [],
    config: [
      { key: 'target', label: '目标', kind: 'select', options: ['产品模块', '设计笔记', '文件导出', '问题清单'], value: '设计笔记' },
      { key: 'dir', label: '导出目录', kind: 'text', value: '', hint: '文件导出时必填，支持相对项目根目录。' },
      { key: 'overwrite', label: '允许覆盖', kind: 'check', value: false },
    ],
  },

  /* ---------------- 游戏 ---------------- */
  {
    id: 'game.gdd', title: '玩法设计稿', cat: 'design', actor: 'agent', lines: ['game'],
    hint: '把需求落成 GDD：核心循环、状态、操作、失败条件，供数值/关卡/美术继续拆。',
    inputs: [{ id: 'req', label: '需求 / 参考', type: 'any' }],
    outputs: [{ id: 'gdd', label: 'GDD', type: 'markdown' }],
    config: [
      { key: 'loop', label: '设计重点', kind: 'select', options: ['核心循环', '战斗', '经济', '叙事', '养成'], value: '核心循环' },
      { key: 'genre', label: '品类 / 参考', kind: 'text', value: '', hint: '例：环形卡牌 + 肉鸽，参考《痛苦之环》。' },
      { key: 'platform', label: '目标平台', kind: 'select', options: ['PC', '移动', '主机', '网页'], value: 'PC' },
      { key: 'sections', label: '必写章节数', kind: 'number', min: 3, max: 20, value: 6 },
    ],
  },
  {
    id: 'game.balance', title: '数值表', cat: 'design', actor: 'agent', lines: ['game'],
    hint: '从 GDD 抽出可调数值：成长曲线、掉落、消耗；输出成表而不是散文。',
    inputs: [{ id: 'gdd', label: 'GDD', type: 'markdown' }],
    outputs: [{ id: 'table', label: '数值表', type: 'table' }],
    config: [
      { key: 'economy', label: '经济模型', kind: 'select', options: ['单资源', '双资源', '多资源'], value: '单资源' },
      { key: 'curve', label: '成长曲线', kind: 'select', options: ['线性', '指数', 'S 曲线'], value: 'S 曲线' },
      { key: 'levels', label: '覆盖等级', kind: 'number', min: 1, max: 200, value: 20 },
    ],
  },
  {
    id: 'game.level', title: '关卡草案', cat: 'design', actor: 'agent', lines: ['game'],
    hint: '一关的目标、节奏、敌人/障碍布置与失败复盘点。',
    inputs: [{ id: 'gdd', label: 'GDD', type: 'markdown' }],
    outputs: [{ id: 'level', label: '关卡', type: 'markdown' }],
    config: [
      { key: 'count', label: '关卡数', kind: 'number', min: 1, max: 20, value: 1 },
      { key: 'difficulty', label: '难度曲线', kind: 'range', min: 0, max: 1, step: 0.1, value: 0.3 },
      { key: 'minutes', label: '单关时长（分钟）', kind: 'number', min: 1, max: 120, value: 8 },
    ],
  },
  {
    id: 'game.asset-spec', title: '美术需求清单', cat: 'design', actor: 'agent', lines: ['game'],
    hint: '把美术要做什么列成清单：对象、规格、动画、是否要骨骼，避免临时加需求。',
    inputs: [{ id: 'gdd', label: 'GDD', type: 'markdown' }],
    outputs: [{ id: 'spec', label: '需求清单', type: 'markdown' }],
    config: [
      { key: 'style', label: '美术风格', kind: 'text', value: '', hint: '例：低多边形 + 手绘贴图。' },
      { key: 'rig', label: '需要骨骼动画', kind: 'check', value: false },
      { key: 'budget', label: '预算档位', kind: 'select', options: ['最小可玩', '中等', '完整'], value: '最小可玩' },
    ],
  },
  {
    id: 'game.unity-import', title: '导入 Unity 工程', cat: 'output', actor: 'auto', lines: ['game'],
    hint: '把产物落到 Unity 工程的约定目录；预演模式下只列将写入的文件，不落盘。',
    inputs: [{ id: 'in', label: '产物', type: 'any' }], outputs: [],
    config: [
      { key: 'project', label: '工程路径', kind: 'text', value: '', hint: '例：D:/csy/Unity/Gitee/RingofXian/AI2Unity' },
      { key: 'folder', label: '目标目录', kind: 'select', options: ['Assets/Design', 'Assets/Data', 'Assets/Art', 'Assets/Docs'], value: 'Assets/Design' },
      { key: 'dryRun', label: '只列清单不写入', kind: 'check', value: true },
    ],
  },
  {
    id: 'game.playtest', title: '试玩任务单', cat: 'output', actor: 'agent', lines: ['game'],
    hint: '给试玩的人一份可执行的任务单：看什么、怎么记录、什么算问题。',
    inputs: [{ id: 'in', label: '产物', type: 'any' }],
    outputs: [{ id: 'out', label: '任务单', type: 'markdown' }],
    config: [
      { key: 'players', label: '试玩人数', kind: 'number', min: 1, max: 30, value: 3 },
      { key: 'minutes', label: '每人时长（分钟）', kind: 'number', min: 5, max: 180, value: 20 },
      { key: 'focus', label: '观察重点', kind: 'select', options: ['上手成本', '手感', '难度曲线', '留存意愿'], value: '上手成本' },
    ],
  },

  /* ---------------- 小说 ---------------- */
  {
    id: 'novel.bible', title: '设定集', cat: 'design', actor: 'agent', lines: ['novel'],
    hint: '世界规则、力量体系、地名与禁忌；后面所有章节都以它为准。',
    inputs: [{ id: 'req', label: '需求 / 参考', type: 'any' }],
    outputs: [{ id: 'bible', label: '设定集', type: 'markdown' }],
    config: [
      { key: 'genre', label: '类型', kind: 'select', options: ['玄幻', '都市', '科幻', '武侠', '悬疑'], value: '玄幻' },
      { key: 'pov', label: '叙事人称', kind: 'select', options: ['第一人称', '第三人称限知', '第三人称全知'], value: '第三人称限知' },
      { key: 'rules', label: '硬设定条数', kind: 'number', min: 3, max: 40, value: 10 },
    ],
  },
  {
    id: 'novel.character', title: '人物小传', cat: 'design', actor: 'agent', lines: ['novel'],
    hint: '每个主要人物的欲望、缺陷、说话方式；防止写到后面变性格。',
    inputs: [{ id: 'bible', label: '设定集', type: 'markdown' }],
    outputs: [{ id: 'cast', label: '人物', type: 'markdown' }],
    config: [
      { key: 'count', label: '主要人物数', kind: 'number', min: 1, max: 20, value: 3 },
      { key: 'deep', label: '写到台词样本', kind: 'check', value: true },
    ],
  },
  {
    id: 'novel.outline', title: '分卷大纲', cat: 'design', actor: 'agent', lines: ['novel'],
    hint: '卷 → 章 → 每章一句事件；写作时按章抽取，不一次性写整本。',
    inputs: [{ id: 'bible', label: '设定集', type: 'markdown' }],
    outputs: [{ id: 'outline', label: '大纲', type: 'markdown' }],
    config: [
      { key: 'volumes', label: '卷数', kind: 'number', min: 1, max: 20, value: 1 },
      { key: 'chapters', label: '每卷章数', kind: 'number', min: 1, max: 200, value: 10 },
      { key: 'ending', label: '先定结局', kind: 'check', value: true },
    ],
  },
  {
    id: 'novel.chapter', title: '章节正文', cat: 'generate', actor: 'agent', lines: ['novel'],
    hint: '一次写一章：按大纲的本章事件，带上前一章结尾做衔接。',
    inputs: [{ id: 'ctx', label: '大纲 / 前文', type: 'any' }],
    outputs: [{ id: 'chapter', label: '章节', type: 'markdown' }],
    config: [
      { key: 'words', label: '目标字数', kind: 'number', min: 300, max: 20000, value: 3000 },
      { key: 'style', label: '文风', kind: 'text', value: '', hint: '例：冷峻、短句多、少形容词。' },
      { key: 'hook', label: '章末留钩子', kind: 'check', value: true },
    ],
  },
  {
    id: 'novel.style-check', title: '文风与一致性', cat: 'check', actor: 'agent', lines: ['novel'],
    hint: '专名、人设、时间线、文风是否跑偏；不通过就回流重写。',
    inputs: [{ id: 'in', label: '待校验', type: 'any' }],
    outputs: [
      { id: 'pass', label: '通过', type: 'markdown' },
      { id: 'fail', label: '问题清单', type: 'report' },
    ],
    config: [
      { key: 'rules', label: '检查项', kind: 'select', options: ['人称一致', '时间线一致', '专名一致', '文风贴合', '无禁用词'], value: '专名一致' },
      { key: 'glossary', label: '专名表', kind: 'textarea', value: '', hint: '一行一个，命中的才允许出现。' },
      { key: 'strict', label: '任一失败即中断', kind: 'check', value: true },
    ],
  },
  {
    id: 'novel.export', title: '导出章节包', cat: 'output', actor: 'auto', lines: ['novel'],
    hint: '按卷/章生成可交付文件；预演只列文件名。',
    inputs: [{ id: 'in', label: '章节', type: 'any' }], outputs: [],
    config: [
      { key: 'format', label: '格式', kind: 'select', options: ['Markdown', 'TXT', 'docx'], value: 'Markdown' },
      { key: 'dir', label: '导出目录', kind: 'text', value: '', hint: '例：D:/writing/ringofxian' },
      { key: 'naming', label: '命名规则', kind: 'select', options: ['卷-章-标题', '序号-标题'], value: '卷-章-标题' },
    ],
  },

  /* ---------------- AI 短剧 ---------------- */
  {
    id: 'drama.logline', title: '故事核', cat: 'design', actor: 'agent', lines: ['drama'],
    hint: '一句话故事 + 冲突 + 反转；短剧成败几乎全在这一步。',
    inputs: [{ id: 'req', label: '需求 / 参考', type: 'any' }],
    outputs: [{ id: 'logline', label: '故事核', type: 'text' }],
    config: [
      { key: 'genre', label: '类型', kind: 'select', options: ['逆袭', '悬疑', '情感', '搞笑', '科幻'], value: '逆袭' },
      { key: 'audience', label: '受众', kind: 'select', options: ['男性向', '女性向', '泛人群'], value: '泛人群' },
      { key: 'hook', label: '前 3 秒钩子', kind: 'textarea', value: '' },
    ],
  },
  {
    id: 'drama.script', title: '分镜脚本', cat: 'design', actor: 'agent', lines: ['drama'],
    hint: '按集出脚本：场次、台词、动作、情绪；台词要能直接配。',
    inputs: [{ id: 'logline', label: '故事核', type: 'any' }],
    outputs: [{ id: 'script', label: '脚本', type: 'markdown' }],
    config: [
      { key: 'episodes', label: '集数', kind: 'number', min: 1, max: 100, value: 5 },
      { key: 'seconds', label: '单集时长（秒）', kind: 'number', min: 15, max: 600, value: 90 },
      { key: 'style', label: '镜头风格', kind: 'select', options: ['写实', '动画', '漫画分格', '3D 渲染'], value: '写实' },
    ],
  },
  {
    id: 'drama.shotlist', title: '分镜表', cat: 'design', actor: 'agent', lines: ['drama'],
    hint: '一镜一行的表：镜号、景别、运镜、时长、画面描述、台词。',
    inputs: [{ id: 'script', label: '脚本', type: 'markdown' }],
    outputs: [{ id: 'shots', label: '分镜表', type: 'table' }],
    config: [
      { key: 'perEpisode', label: '每集镜头数', kind: 'number', min: 3, max: 200, value: 12 },
      { key: 'columns', label: '必填列', kind: 'select', options: ['基础 6 列', '含情绪', '含音效'], value: '基础 6 列' },
    ],
  },
  {
    id: 'drama.character-lock', title: '角色一致性', cat: 'check', actor: 'agent', lines: ['drama'],
    hint: '角色外观/服装/年龄是否跨镜跑偏；这是 AI 短剧最容易崩的地方。',
    inputs: [{ id: 'in', label: '待校验', type: 'any' }],
    outputs: [
      { id: 'pass', label: '通过', type: 'any' },
      { id: 'fail', label: '返工清单', type: 'report' },
    ],
    config: [
      { key: 'refs', label: '参考图数量', kind: 'number', min: 0, max: 20, value: 3 },
      { key: 'rules', label: '检查项', kind: 'select', options: ['脸型一致', '服装一致', '年龄一致', '场景连贯'], value: '服装一致' },
      { key: 'strict', label: '任一失败即中断', kind: 'check', value: true },
    ],
  },
  {
    id: 'drama.voice', title: '配音与字幕', cat: 'generate', actor: 'agent', lines: ['drama'],
    hint: '按镜头生成配音文本与字幕条，标注语气与停顿。',
    inputs: [{ id: 'script', label: '脚本', type: 'markdown' }],
    outputs: [{ id: 'audio', label: '配音文本', type: 'file-set' }],
    config: [
      { key: 'voice', label: '音色', kind: 'select', options: ['低沉男声', '清亮女声', '少年音', '旁白'], value: '低沉男声' },
      { key: 'subtitle', label: '同时出字幕', kind: 'check', value: true },
      { key: 'rate', label: '语速', kind: 'range', min: 0.7, max: 1.6, step: 0.1, value: 1 },
    ],
  },
  {
    id: 'drama.deliver', title: '交付投稿包', cat: 'output', actor: 'auto', lines: ['drama'],
    hint: '按平台要求整理封面、标题、简介、标签与成片清单。',
    inputs: [{ id: 'in', label: '产物', type: 'any' }], outputs: [],
    config: [
      { key: 'platform', label: '平台', kind: 'select', options: ['抖音', '快手', '视频号', 'YouTube'], value: '抖音' },
      { key: 'ratio', label: '画幅', kind: 'select', options: ['9:16', '16:9', '1:1'], value: '9:16' },
      { key: 'dir', label: '交付目录', kind: 'text', value: '' },
    ],
  },
]

export function defById(id: string): NodeDef | undefined {
  return NODE_DEFS.find(def => def.id === id)
}

/** 某条产品线可用的节点定义（顺序保持目录顺序，节点库分组渲染）。 */
export function defsForLine(line: ProductLineId): NodeDef[] {
  return NODE_DEFS.filter(def => def.lines === undefined || def.lines.includes(line))
}

export function defsInCategory(line: ProductLineId, cat: NodeCategory): NodeDef[] {
  return defsForLine(line).filter(def => def.cat === cat)
}

/* ------------------------------------------------------------------ *
 * 图数据与收敛
 * ------------------------------------------------------------------ */

export interface CanvasNode {
  id: string
  /** NODE_DEFS 的 id；不认识的类型会在 normalize 里被丢弃并记 warn */
  type: string
  x: number
  y: number
  config: Record<string, ConfigValue>
}

export interface CanvasEdge {
  from: { node: string; port: string }
  to: { node: string; port: string }
}

export interface WorkflowGraph {
  version: 1
  name: string
  line: ProductLineId
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

/** 单图上限；宿主按字节再挡一次，前端先挡免得拖爆。 */
export const GRAPH_LIMITS = { nodes: 200, edges: 400, bytes: 512 * 1024 }

export interface GraphIssue {
  level: 'error' | 'warn'
  code: string
  message: string
  nodeId?: string
}

export function emptyGraph(line: ProductLineId, name?: string): WorkflowGraph {
  return { version: 1, name: name ?? '未命名流程', line, nodes: [], edges: [] }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_X = 20000
const MAX_Y = 20000

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asFinite(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, num))
}

/** 按定义收敛一个节点的配置：未知键丢弃、类型不符回落默认值、数值夹到 min/max。 */
export function coerceConfig(def: NodeDef, input: unknown): Record<string, ConfigValue> {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const out: Record<string, ConfigValue> = {}
  for (const field of def.config) {
    const value = source[field.key]
    if (field.kind === 'number' || field.kind === 'range') {
      const min = field.min ?? 0
      const max = field.max ?? 100
      out[field.key] = asFinite(typeof value === 'number' ? value : Number(value), Number(field.value), min, max)
      continue
    }
    if (field.kind === 'check') {
      out[field.key] = typeof value === 'boolean' ? value : field.value === true
      continue
    }
    if (field.kind === 'select') {
      const text = asString(value, String(field.value))
      const options = field.options ?? []
      out[field.key] = options.length === 0 || options.includes(text) ? text : String(field.value)
      continue
    }
    out[field.key] = asString(value, String(field.value))
  }
  return out
}

export function makeNode(type: string, x: number, y: number, id?: string): CanvasNode | null {
  const def = defById(type)
  if (def === undefined) return null
  return { id: id ?? type.replace(/[^A-Za-z0-9_-]/g, '-') + '-' + Math.random().toString(36).slice(2, 8), type: def.id, x, y, config: coerceConfig(def, {}) }
}

/**
 * 把任意来路的数据收敛成合法图。宁可变小也不要静默改坏：丢掉的东西全部记 warn。
 * 前端从磁盘/接口读到的、以及粘贴导入的 JSON 都走这里。
 */
export function normalizeGraph(input: unknown, fallbackLine: ProductLineId): { graph: WorkflowGraph; issues: GraphIssue[] } {
  const issues: GraphIssue[] = []
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const line = PRODUCT_LINES.some(item => item.id === raw.line) ? (raw.line as ProductLineId) : fallbackLine
  const graph: WorkflowGraph = { version: 1, name: asString(raw.name, '未命名流程').slice(0, 120), line, nodes: [], edges: [] }

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : []
  if (!Array.isArray(raw.nodes)) issues.push({ level: 'warn', code: 'nodes_missing', message: '数据里没有 nodes 数组，按空图处理。' })
  const seen = new Set<string>()
  for (const item of rawNodes) {
    if (graph.nodes.length >= GRAPH_LIMITS.nodes) {
      issues.push({ level: 'warn', code: 'nodes_truncated', message: '节点超过上限 ' + GRAPH_LIMITS.nodes + ' 个，多余的已丢弃。' })
      break
    }
    const node = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const def = defById(asString(node.type, ''))
    if (def === undefined) {
      issues.push({ level: 'warn', code: 'node_unknown', message: '未知节点类型 ' + asString(node.type, '(空)') + '，已丢弃。' })
      continue
    }
    if (def.lines !== undefined && !def.lines.includes(line)) {
      issues.push({ level: 'warn', code: 'node_line_mismatch', message: def.title + ' 不属于产品线「' + lineOf(line).name + '」，已丢弃。', nodeId: asString(node.id, undefined as unknown as string) })
      continue
    }
    let id = asString(node.id, '')
    if (!ID_RE.test(id) || seen.has(id)) {
      const next = def.id.replace(/[^A-Za-z0-9_-]/g, '-') + '-' + (graph.nodes.length + 1)
      issues.push({ level: 'warn', code: 'node_id_fixed', message: '节点 id 非法或重复，已改成 ' + next + '。' })
      id = next
    }
    seen.add(id)
    graph.nodes.push({
      id,
      type: def.id,
      x: asFinite(node.x, 80 + graph.nodes.length * 40, 0, MAX_X),
      y: asFinite(node.y, 80 + graph.nodes.length * 24, 0, MAX_Y),
      config: coerceConfig(def, node.config),
    })
  }

  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const takenInputs = new Set<string>()
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : []
  for (const item of rawEdges) {
    if (graph.edges.length >= GRAPH_LIMITS.edges) {
      issues.push({ level: 'warn', code: 'edges_truncated', message: '连线超过上限 ' + GRAPH_LIMITS.edges + ' 条，多余的已丢弃。' })
      break
    }
    const edge = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const from = (typeof edge.from === 'object' && edge.from !== null ? edge.from : {}) as Record<string, unknown>
    const to = (typeof edge.to === 'object' && edge.to !== null ? edge.to : {}) as Record<string, unknown>
    const fromNode = byId.get(asString(from.node, ''))
    const toNode = byId.get(asString(to.node, ''))
    if (fromNode === undefined || toNode === undefined) {
      issues.push({ level: 'warn', code: 'edge_dangling', message: '连线两端有节点不存在，已丢弃。' })
      continue
    }
    const fromDef = defById(fromNode.type)
    const toDef = defById(toNode.type)
    if (fromDef === undefined || toDef === undefined) continue
    const outPort = fromDef.outputs.find(port => port.id === asString(from.port, ''))
    const inPort = toDef.inputs.find(port => port.id === asString(to.port, ''))
    if (outPort === undefined || inPort === undefined) {
      issues.push({ level: 'warn', code: 'edge_port', message: '连线端口不存在，已丢弃。' })
      continue
    }
    if (outPort.type !== 'any' && inPort.type !== 'any' && outPort.type !== inPort.type) {
      issues.push({ level: 'warn', code: 'edge_type', message: TYPE_LABEL[outPort.type] + ' 接不到 ' + TYPE_LABEL[inPort.type] + '，已丢弃。' })
      continue
    }
    const slot = toNode.id + ':' + inPort.id
    if (takenInputs.has(slot)) {
      issues.push({ level: 'warn', code: 'edge_dup', message: '一个输入端口只收一条线，多余的已丢弃。' })
      continue
    }
    takenInputs.add(slot)
    graph.edges.push({ from: { node: fromNode.id, port: outPort.id }, to: { node: toNode.id, port: inPort.id } })
  }

  return { graph, issues }
}

/** 连线合法性：返回 null 表示可以连，否则返回拒绝原因。 */
export function canConnect(graph: WorkflowGraph, from: { node: string; port: string }, to: { node: string; port: string }): GraphIssue | null {
  if (from.node === to.node) return { level: 'error', code: 'self_link', message: '不能连自己。' }
  const fromNode = graph.nodes.find(node => node.id === from.node)
  const toNode = graph.nodes.find(node => node.id === to.node)
  if (fromNode === undefined || toNode === undefined) return { level: 'error', code: 'node_missing', message: '节点不存在。' }
  const fromDef = defById(fromNode.type)
  const toDef = defById(toNode.type)
  if (fromDef === undefined || toDef === undefined) return { level: 'error', code: 'node_missing', message: '节点类型未知。' }
  const outPort = fromDef.outputs.find(port => port.id === from.port)
  const inPort = toDef.inputs.find(port => port.id === to.port)
  if (outPort === undefined || inPort === undefined) return { level: 'error', code: 'port_missing', message: '端口不存在。' }
  if (outPort.type !== 'any' && inPort.type !== 'any' && outPort.type !== inPort.type) {
    return { level: 'error', code: 'type_mismatch', message: TYPE_LABEL[inPort.type] + ' 只能接 ' + TYPE_LABEL[inPort.type] + '，上游是 ' + TYPE_LABEL[outPort.type] + '。' }
  }
  const occupied = graph.edges.some(edge => edge.to.node === to.node && edge.to.port === to.port)
  if (occupied) return { level: 'error', code: 'input_taken', message: '这个输入端口已经有一条线了，先删掉再用「汇总输入」并流。' }
  return null
}

export function topoOrder(graph: WorkflowGraph): { order: string[]; cycle: string[] } {
  const indeg = new Map<string, number>()
  const next = new Map<string, string[]>()
  for (const node of graph.nodes) { indeg.set(node.id, 0); next.set(node.id, []) }
  for (const edge of graph.edges) {
    if (!indeg.has(edge.to.node) || !indeg.has(edge.from.node)) continue
    indeg.set(edge.to.node, (indeg.get(edge.to.node) ?? 0) + 1)
    next.get(edge.from.node)?.push(edge.to.node)
  }
  const queue = graph.nodes.filter(node => (indeg.get(node.id) ?? 0) === 0).map(node => node.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift() as string
    order.push(id)
    for (const target of next.get(id) ?? []) {
      const left = (indeg.get(target) ?? 1) - 1
      indeg.set(target, left)
      if (left === 0) queue.push(target)
    }
  }
  const cycle = graph.nodes.filter(node => !order.includes(node.id)).map(node => node.id)
  return { order, cycle }
}

/** 结构性校验：只查「这张图能不能跑」，不调模型、不读文件，所以随时可以全量跑。 */
export function validateGraph(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = []
  if (graph.nodes.length === 0) {
    issues.push({ level: 'error', code: 'empty', message: '画布是空的，先拖一个输入节点进来。' })
    return issues
  }
  const { order, cycle } = topoOrder(graph)
  if (cycle.length > 0) {
    const names = cycle.map(id => defById(graph.nodes.find(node => node.id === id)?.type ?? '')?.title ?? id)
    issues.push({ level: 'error', code: 'cycle', message: '存在环，这些节点无法排序：' + names.join(' → ') })
  }
  const hasIncoming = new Set(graph.edges.map(edge => edge.to.node))
  const hasOutgoing = new Set(graph.edges.map(edge => edge.from.node))
  for (const node of graph.nodes) {
    const def = defById(node.type)
    if (def === undefined) continue
    if (def.outputs.length > 0 && !hasOutgoing.has(node.id)) {
      issues.push({ level: 'warn', code: 'no_downstream', message: def.title + ' 的产物没有下游，跑了也没人用。', nodeId: node.id })
    }
    for (const port of def.inputs) {
      const filled = graph.edges.some(edge => edge.to.node === node.id && edge.to.port === port.id)
      if (!filled && port.optional !== true) issues.push({ level: 'error', code: 'input_missing', message: def.title + ' 的「' + port.label + '」没有接线。', nodeId: node.id })
    }
    if (def.outputs.length === 0 && !hasIncoming.has(node.id)) {
      issues.push({ level: 'warn', code: 'dead_end', message: def.title + ' 没有输入，等于空执行。', nodeId: node.id })
    }
    for (const field of def.config) {
      if (field.kind !== 'text' && field.kind !== 'textarea') continue
      const value = node.config[field.key]
      if (typeof value !== 'string' || value.trim() === '') {
        if (field.key === 'dir' || field.key === 'prompt' || field.key === 'text') {
          issues.push({ level: 'warn', code: 'config_empty', message: def.title + ' 的「' + field.label + '」还没填。', nodeId: node.id })
        }
      }
    }
    if (node.type === 'input.brief' && node.config.mustExist === true && String(node.config.text ?? '').trim() === '') {
      issues.push({ level: 'error', code: 'brief_empty', message: '需求节点标了「必须填写」，但内容是空的。', nodeId: node.id })
    }
  }
  if (!graph.nodes.some(node => hasOutgoing.has(node.id) === false && defById(node.type)?.outputs.length === 0)) {
    issues.push({ level: 'warn', code: 'no_output', message: '没有任何输出节点，产物不会落地。' })
  }
  return issues
}

/* ------------------------------------------------------------------ *
 * 执行预演（不跑模型、不写盘）
 * ------------------------------------------------------------------ */

export interface PlanInput { label: string; from: string | null; type: PortType }

export interface PlanStep {
  order: number
  nodeId: string
  type: string
  title: string
  cat: NodeCategory
  actor: Actor
  /** 这一步是确定性的还是要等模型/等人 */
  wait: 'none' | 'agent' | 'human'
  inputs: PlanInput[]
  outputs: string[]
  note: string
}

export interface Plan {
  ok: boolean
  line: ProductLineId
  name: string
  steps: PlanStep[]
  counts: { total: number; agent: number; human: number; auto: number }
  issues: GraphIssue[]
  markdown: string
}

function describeConfig(def: NodeDef, config: Record<string, ConfigValue>): string {
  const parts: string[] = []
  for (const field of def.config) {
    const value = config[field.key]
    if (value === '' || value === false) continue
    if (field.kind === 'textarea') { parts.push(field.label + '：' + String(value).slice(0, 40) + (String(value).length > 40 ? '…' : '')); continue }
    if (field.kind === 'check') { parts.push(field.label); continue }
    parts.push(field.label + '=' + String(value))
  }
  return parts.join('，')
}

export function planOf(graph: WorkflowGraph): Plan {
  const issues = validateGraph(graph)
  const { order } = topoOrder(graph)
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const steps: PlanStep[] = []
  for (const id of order) {
    const node = byId.get(id)
    if (node === undefined) continue
    const def = defById(node.type)
    if (def === undefined) continue
    const inputs: PlanInput[] = def.inputs.map(port => {
      const edge = graph.edges.find(item => item.to.node === id && item.to.port === port.id)
      const upstream = edge === undefined ? undefined : byId.get(edge.from.node)
      const upstreamDef = upstream === undefined ? undefined : defById(upstream.type)
      return { label: port.label, from: upstreamDef?.title ?? null, type: port.type }
    })
    steps.push({
      order: steps.length + 1,
      nodeId: id,
      type: def.id,
      title: def.title,
      cat: def.cat,
      actor: def.actor,
      wait: def.actor === 'human' ? 'human' : def.actor === 'agent' ? 'agent' : 'none',
      inputs,
      outputs: def.outputs.map(port => port.label + '（' + TYPE_LABEL[port.type] + '）'),
      note: describeConfig(def, node.config),
    })
  }
  const counts = {
    total: steps.length,
    agent: steps.filter(step => step.actor === 'agent').length,
    human: steps.filter(step => step.actor === 'human').length,
    auto: steps.filter(step => step.actor === 'auto').length,
  }
  const plan: Plan = { ok: !issues.some(issue => issue.level === 'error'), line: graph.line, name: graph.name, steps, counts, issues, markdown: '' }
  plan.markdown = planToMarkdown(plan)
  return plan
}

export function planToMarkdown(plan: Plan): string {
  const lines: string[] = []
  lines.push('# 执行预演 · ' + plan.name)
  lines.push('')
  lines.push('- 产品线：' + lineOf(plan.line).name)
  lines.push('- 步骤：共 ' + plan.counts.total + ' 步（模型 ' + plan.counts.agent + ' / 人工 ' + plan.counts.human + ' / 程序 ' + plan.counts.auto + '）')
  lines.push('- 结论：' + (plan.ok ? '可以执行' : '不可执行（见文末问题）'))
  lines.push('')
  for (const step of plan.steps) {
    const actor = step.actor === 'agent' ? '模型' : step.actor === 'human' ? '等人工确认' : '程序'
    lines.push('## ' + step.order + '. ' + step.title + '（' + actor + '）')
    const from = step.inputs.map(item => item.label + ' ← ' + (item.from === null ? '未接' : item.from)).join('；')
    if (from !== '') lines.push('- 输入：' + from)
    if (step.outputs.length > 0) lines.push('- 产出：' + step.outputs.join('、'))
    if (step.note !== '') lines.push('- 参数：' + step.note)
    lines.push('')
  }
  if (plan.issues.length > 0) {
    lines.push('## 问题')
    for (const issue of plan.issues) lines.push('- [' + (issue.level === 'error' ? '错误' : '提示') + '] ' + issue.message)
    lines.push('')
  }
  lines.push('> 预演只算计划，不调用模型、不写任何文件。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 模板：三条产品线各一条「一拖就能跑」的完整链路
 * ------------------------------------------------------------------ */

interface TemplateNodeSpec {
  id: string
  type: string
  x: number
  y: number
  config?: Record<string, ConfigValue>
}

type TemplateLink = [string, string, string, string]

function buildTemplate(line: ProductLineId, name: string, nodes: TemplateNodeSpec[], links: TemplateLink[]): WorkflowGraph {
  const graph: WorkflowGraph = { version: 1, name, line, nodes: [], edges: [] }
  for (const spec of nodes) {
    const def = defById(spec.type)
    if (def === undefined) throw new Error('模板引用了未知节点 ' + spec.type)
    graph.nodes.push({ id: spec.id, type: def.id, x: spec.x, y: spec.y, config: coerceConfig(def, spec.config ?? {}) })
  }
  for (const [fromNode, fromPort, toNode, toPort] of links) {
    const issue = canConnect(graph, { node: fromNode, port: fromPort }, { node: toNode, port: toPort })
    if (issue !== null) throw new Error('模板连线非法：' + fromNode + '.' + fromPort + ' → ' + toNode + '.' + toPort + '：' + issue.message)
    graph.edges.push({ from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } })
  }
  return graph
}

const GAME_TEMPLATE = buildTemplate('game', '游戏 · 从需求到试玩单', [
  { id: 'brief', type: 'input.brief', x: 40, y: 200, config: { text: '做一套环形卡牌战斗的中式玄幻原型，先出可试玩的第一关。' } },
  { id: 'gdd', type: 'game.gdd', x: 300, y: 200, config: { genre: '环形卡牌 + 肉鸽，参考《痛苦之环》', loop: '核心循环' } },
  { id: 'balance', type: 'game.balance', x: 580, y: 60, config: { levels: 12 } },
  { id: 'level', type: 'game.level', x: 580, y: 200, config: { count: 1, minutes: 8 } },
  { id: 'asset', type: 'game.asset-spec', x: 580, y: 340, config: { style: '低多边形 + 手绘贴图', budget: '最小可玩' } },
  { id: 'join', type: 'flow.join', x: 840, y: 200 },
  { id: 'review', type: 'human.review', x: 1090, y: 200, config: { note: '看数值曲线是否陡、关卡目标是否单一、美术清单是否都能买得起。' } },
  { id: 'check', type: 'check.rules', x: 1330, y: 200, config: { rules: '非空', strict: true } },
  { id: 'playtest', type: 'game.playtest', x: 1580, y: 100, config: { players: 3, focus: '上手成本' } },
  { id: 'issues', type: 'output.publish', x: 1580, y: 320, config: { target: '问题清单' } },
], [
  ['brief', 'out', 'gdd', 'req'],
  ['gdd', 'gdd', 'balance', 'gdd'],
  ['gdd', 'gdd', 'level', 'gdd'],
  ['gdd', 'gdd', 'asset', 'gdd'],
  ['balance', 'table', 'join', 'a'],
  ['level', 'level', 'join', 'b'],
  ['asset', 'spec', 'join', 'c'],
  ['join', 'out', 'review', 'in'],
  ['review', 'out', 'check', 'in'],
  ['check', 'pass', 'playtest', 'in'],
  ['check', 'fail', 'issues', 'in'],
])

const NOVEL_TEMPLATE = buildTemplate('novel', '小说 · 从设定到章节', [
  { id: 'brief', type: 'input.brief', x: 40, y: 200, config: { text: '写一部中式玄幻长篇的第一卷，第一人称限知，冷峻文风。' } },
  { id: 'bible', type: 'novel.bible', x: 300, y: 200, config: { genre: '玄幻', rules: 10 } },
  { id: 'cast', type: 'novel.character', x: 570, y: 80, config: { count: 3, deep: true } },
  { id: 'outline', type: 'novel.outline', x: 570, y: 320, config: { volumes: 1, chapters: 10, ending: true } },
  { id: 'join', type: 'flow.join', x: 830, y: 200 },
  { id: 'chapter', type: 'novel.chapter', x: 1080, y: 200, config: { words: 3000, style: '冷峻、短句多、少形容词', hook: true } },
  { id: 'style', type: 'novel.style-check', x: 1330, y: 200, config: { rules: '专名一致', strict: true } },
  { id: 'export', type: 'novel.export', x: 1580, y: 100, config: { format: 'Markdown', naming: '卷-章-标题' } },
  { id: 'issues', type: 'output.publish', x: 1580, y: 320, config: { target: '问题清单' } },
], [
  ['brief', 'out', 'bible', 'req'],
  ['bible', 'bible', 'cast', 'bible'],
  ['bible', 'bible', 'outline', 'bible'],
  ['cast', 'cast', 'join', 'a'],
  ['outline', 'outline', 'join', 'b'],
  ['join', 'out', 'chapter', 'ctx'],
  ['chapter', 'chapter', 'style', 'in'],
  ['style', 'pass', 'export', 'in'],
  ['style', 'fail', 'issues', 'in'],
])

const DRAMA_TEMPLATE = buildTemplate('drama', '短剧 · 从一句话到交付包', [
  { id: 'brief', type: 'input.brief', x: 40, y: 200, config: { text: '一个被退婚的杂役弟子，靠一门残缺功法在宗门大比上翻盘。' } },
  { id: 'logline', type: 'drama.logline', x: 290, y: 200, config: { genre: '逆袭', audience: '男性向' } },
  { id: 'script', type: 'drama.script', x: 540, y: 200, config: { episodes: 5, seconds: 90, style: '写实' } },
  { id: 'shots', type: 'drama.shotlist', x: 800, y: 80, config: { perEpisode: 12 } },
  { id: 'voice', type: 'drama.voice', x: 800, y: 340, config: { voice: '低沉男声', subtitle: true } },
  { id: 'lock', type: 'drama.character-lock', x: 1050, y: 80, config: { rules: '服装一致', strict: true } },
  { id: 'join', type: 'flow.join', x: 1300, y: 200 },
  { id: 'deliver', type: 'drama.deliver', x: 1550, y: 200, config: { platform: '抖音', ratio: '9:16' } },
  { id: 'issues', type: 'output.publish', x: 1050, y: 340, config: { target: '问题清单' } },
], [
  ['brief', 'out', 'logline', 'req'],
  ['logline', 'logline', 'script', 'logline'],
  ['script', 'script', 'shots', 'script'],
  ['script', 'script', 'voice', 'script'],
  ['shots', 'shots', 'lock', 'in'],
  ['lock', 'pass', 'join', 'a'],
  ['voice', 'audio', 'join', 'b'],
  ['join', 'out', 'deliver', 'in'],
  ['lock', 'fail', 'issues', 'in'],
])

export interface TemplateInfo { id: string; name: string; line: ProductLineId; summary: string; steps: number }

export const TEMPLATES: { id: string; line: ProductLineId; summary: string; graph: WorkflowGraph }[] = [
  { id: 'game-gdd-to-playtest', line: 'game', summary: '需求 → GDD → 数值/关卡/美术需求 → 人工评审 → 校验 → 试玩单', graph: GAME_TEMPLATE },
  { id: 'novel-bible-to-chapter', line: 'novel', summary: '需求 → 设定集 → 人物 + 大纲 → 章节 → 文风校验 → 导出', graph: NOVEL_TEMPLATE },
  { id: 'drama-story-to-deliver', line: 'drama', summary: '需求 → 故事核 → 分镜脚本 → 分镜表 + 配音 → 角色一致 → 交付包', graph: DRAMA_TEMPLATE },
]

export function templateOf(id: string): WorkflowGraph | null {
  const found = TEMPLATES.find(item => item.id === id)
  return found === undefined ? null : cloneGraph(found.graph)
}

export function templateList(): TemplateInfo[] {
  return TEMPLATES.map(item => ({ id: item.id, name: item.graph.name, line: item.line, summary: item.summary, steps: item.graph.nodes.length }))
}

export function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    version: 1,
    name: graph.name,
    line: graph.line,
    nodes: graph.nodes.map(node => ({ id: node.id, type: node.type, x: node.x, y: node.y, config: { ...node.config } })),
    edges: graph.edges.map(edge => ({ from: { node: edge.from.node, port: edge.from.port }, to: { node: edge.to.node, port: edge.to.port } })),
  }
}

/** 前端提示用：把 issues 压成一行短句。 */
export function summarizeIssues(issues: GraphIssue[]): string {
  const errors = issues.filter(issue => issue.level === 'error')
  if (errors.length > 0) return errors.length + ' 个错误：' + errors[0].message
  const warns = issues.filter(issue => issue.level === 'warn')
  if (warns.length > 0) return warns.length + ' 个提示：' + warns[0].message
  return '没有发现问题'
}
