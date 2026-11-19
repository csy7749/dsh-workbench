import { coerceConfig, defById, canConnect, type ConfigValue, type ProductLineId, type WorkflowGraph } from '../shared/workflow-canvas-model.ts'
interface TemplateNodeSpec {
  id: string
  type: string
  x: number
  y: number
  title?: string
  config?: Record<string, ConfigValue>
}

type TemplateLink = [string, string, string, string]

function buildTemplate(line: ProductLineId, name: string, nodes: TemplateNodeSpec[], links: TemplateLink[]): WorkflowGraph {
  const graph: WorkflowGraph = { version: 1, name, line, nodes: [], edges: [] }
  for (const spec of nodes) {
    graph.nodes.push({ id: spec.id, type: spec.type, x: spec.x, y: spec.y, ...(spec.title ? { title: spec.title } : {}), config: spec.config ?? {} })
  }
  for (const [fromNode, fromPort, toNode, toPort] of links) {
    graph.edges.push({ from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } })
  }
  return graph
}

const GAME_TEMPLATE = buildTemplate('game', '游戏 v1 · 玩法规则与导出', [
  { id: 'brief', type: 'input.brief', x: 40, y: 200 },
  { id: 'gdd', type: 'game.gdd', x: 300, y: 200 },
  { id: 'rules', type: 'game.rules', x: 560, y: 200 },
  { id: 'check', type: 'check.rules', x: 820, y: 200 },
  { id: 'review', type: 'human.review', x: 1080, y: 200, config: { note: '核对核心循环、失败条件与可观察的验收行为，编辑规则后确认。' } },
  { id: 'export', type: 'output.publish', x: 1340, y: 200, config: { target: '文件导出' } },
], [
  ['brief', 'out', 'gdd', 'req'],
  ['gdd', 'gdd', 'rules', 'in'],
  ['rules', 'out', 'check', 'in'],
  ['check', 'pass', 'review', 'in'],
  ['review', 'out', 'export', 'in'],
])

const GAME_PRODUCT_TEMPLATE = buildTemplate('game', '游戏产品 · 从需求到可试玩交付', [
  { id: 'brief', type: 'input.brief', x: 40, y: 200, config: { text: '描述目标玩家、核心体验、参考游戏、目标平台和本次交付范围。首版以一个可完整试玩的浏览器游戏为目标。' } },
  { id: 'gdd', type: 'game.gdd', x: 300, y: 200, config: { platform: '网页', genre: '参考游戏与目标体验' } },
  { id: 'rules', type: 'game.rules', x: 560, y: 200 },
  { id: 'check', type: 'check.rules', x: 820, y: 200 },
  { id: 'design-review', type: 'human.review', title: '批准玩法范围', x: 1080, y: 200, config: { note: '核对目标、核心循环、控制方式、胜负条件和可观察验收行为。完成批准前不创建游戏工程。' } },
  { id: 'create', type: 'game.create', x: 1340, y: 200 },
  { id: 'prototype-playtest', type: 'game.playtest', title: '原型自动试玩', x: 1600, y: 200 },
  { id: 'revise', type: 'game.revise', x: 1860, y: 200 },
  { id: 'build', type: 'game.build', x: 2120, y: 200 },
  { id: 'final-playtest', type: 'game.playtest', title: '最终版本自动试玩', x: 2380, y: 200 },
  { id: 'package', type: 'game.package', x: 2640, y: 200 },
  { id: 'handoff-review', type: 'game.handoff-review', x: 2900, y: 200 },
], [
  ['brief', 'out', 'gdd', 'req'],
  ['gdd', 'gdd', 'rules', 'in'],
  ['rules', 'out', 'check', 'in'],
  ['check', 'pass', 'design-review', 'in'],
  ['design-review', 'out', 'create', 'in'],
  ['create', 'out', 'prototype-playtest', 'in'],
  ['prototype-playtest', 'out', 'revise', 'in'],
  ['revise', 'out', 'build', 'in'],
  ['build', 'out', 'final-playtest', 'in'],
  ['final-playtest', 'out', 'package', 'in'],
  ['package', 'out', 'handoff-review', 'in'],
])

const CANVAS_DELIVERY_TEMPLATE = buildTemplate('game', '工作台 · 画布开发与集中验收', [
  { id: 'brief', type: 'input.brief', title: '目标与实施范围', x: 40, y: 200, config: { text: '完成 D:/AI/dsh-workbench/docs/workflow-v1/07-画布产品化补充计划.md 中的当前剩余工作：完整 DAG 运行、持续执行和恢复、画布完整性，然后集中验收桌面画布、分支汇合、人工审核、真实模型、产品包边界、HTTP 与真实数据。以实际源码与现有工作区状态为准，保留已有改动。工作流节点只生成文档；代码修改、命令和桌面操作由外部执行并回填证据。' } },
  { id: 'plan', type: 'dsh.generate', title: '拆分实施任务', x: 310, y: 200, config: { prompt: '根据输入制定可执行的实施任务清单。覆盖通用多输出契约、节点级执行、运行详情、分组/注释/折叠、服务端草稿与版本迁移，以及真实会话、桌面和数据集中验收。每项写范围、依赖、验收方法和风险；区分现有依据与待核查事项，不假定读过仓库或声称已经完成。保留用户已有改动。' } },
  { id: 'plan-review', type: 'human.review', title: '确认任务与实施记录', x: 580, y: 200, config: { note: '审阅并修订任务清单。工作流不会修改代码：请在外部完成实施，将变更文件、未完成项及实际验证记录写入此处，再确认继续；未执行的事项标记未评估。' } },
  { id: 'acceptance', type: 'dsh.generate', title: '整理集中验收清单', x: 850, y: 200, config: { prompt: '基于输入的任务和实施记录，整理逐项验收清单：桌面入口与画布操作、保存恢复及冲突、100 节点体验、DAG 分支汇合和多输出、节点运行详情、暂停取消恢复、人审、真实 DSH 模型和工具边界、产品包边界、HTTP 与真实数据。每项列操作、期望结果、证据及状态；没有实际证据标记未评估。不要声称执行过测试、看过桌面或修改过代码。' } },
  { id: 'evidence-review', type: 'human.review', title: '回填验收证据', x: 1120, y: 200, config: { note: '在真实环境执行验收并填写结果：命令、退出码、环境、截图或日志路径、失败及复验。无法执行的项目标记未评估；确认仅代表这份记录已审阅，不等于全部通过。' } },
  { id: 'report', type: 'dsh.generate', title: '生成验收结论', x: 1390, y: 200, config: { prompt: '根据人工填写的验收记录生成结论：已通过、失败、未评估、剩余问题和后续动作，逐项引用输入中的证据。不得把缺失证据视为通过，不得虚构命令、截图、模型或运行结果；若存在失败或未评估，明确不能宣称完整验收通过。' } },
  { id: 'final-review', type: 'human.review', title: '审阅验收结论', x: 1660, y: 200, config: { note: '核对结论与实际证据，必要时修正；确认只保存人工审阅后的报告。' } },
  { id: 'export', type: 'output.publish', title: '导出任务与验收记录', x: 1930, y: 200, config: { target: '文件导出' } },
], [
  ['brief', 'out', 'plan', 'in'],
  ['plan', 'out', 'plan-review', 'in'],
  ['plan-review', 'out', 'acceptance', 'in'],
  ['acceptance', 'out', 'evidence-review', 'in'],
  ['evidence-review', 'out', 'report', 'in'],
  ['report', 'out', 'final-review', 'in'],
  ['final-review', 'out', 'export', 'in'],
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

export const templates: { id: string; line: ProductLineId; summary: string; graph: WorkflowGraph }[] = [
  { id: 'game-gdd-to-playtest', line: 'game', summary: '需求 → 设计稿 → 规则 JSON → 校验 → 人工确认 → 文件导出', graph: GAME_TEMPLATE },
  { id: 'game-product-closed-loop', line: 'game', summary: '需求 → 玩法批准 → 可玩原型 → 自动试玩修订 → 最终构建与试玩 → 离线 HTML → 人工验收', graph: GAME_PRODUCT_TEMPLATE },
  { id: 'workbench-canvas-delivery', line: 'game', summary: '画布任务拆解 → 人工实施记录 → 集中验收 → 证据回填 → 报告导出；不自动改代码或运行测试', graph: CANVAS_DELIVERY_TEMPLATE },
  { id: 'novel-bible-to-chapter', line: 'novel', summary: '需求 → 设定集 → 人物 + 大纲 → 章节 → 文风校验 → 导出', graph: NOVEL_TEMPLATE },
  { id: 'drama-story-to-deliver', line: 'drama', summary: '需求 → 故事核 → 分镜脚本 → 分镜表 + 配音 → 角色一致 → 交付包', graph: DRAMA_TEMPLATE },
]

