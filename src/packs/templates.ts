import { coerceConfig, defById, canConnect, type ConfigValue, type ProductLineId, type WorkflowGraph } from '../shared/workflow-canvas-model.ts'
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
    graph.nodes.push({ id: spec.id, type: spec.type, x: spec.x, y: spec.y, config: spec.config ?? {} })
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
  { id: 'novel-bible-to-chapter', line: 'novel', summary: '需求 → 设定集 → 人物 + 大纲 → 章节 → 文风校验 → 导出', graph: NOVEL_TEMPLATE },
  { id: 'drama-story-to-deliver', line: 'drama', summary: '需求 → 故事核 → 分镜脚本 → 分镜表 + 配音 → 角色一致 → 交付包', graph: DRAMA_TEMPLATE },
]

