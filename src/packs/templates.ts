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
  { id: 'brief', type: 'input.brief', x: 40, y: 200, config: { text: '基于 Cinderwatch 制作可离线试玩的 Three.js 塔防。保留四类塔及升级、敌人波次、金币经济、基地生命、自动指挥与手动接管。使用 seed=4、biome=ashen、startingGold=300、lives=20、autoCommand=true；规则 JSON 显式包含 nativeTemplate="cinderwatch@1" 和以上五个参数。交付单文件 HTML，并记录自动试玩与人工验收。' } },
  { id: 'gdd', type: 'game.gdd', x: 300, y: 200, config: { platform: '网页', genre: 'Cinderwatch Three.js 塔防' } },
  { id: 'rules', type: 'game.rules', x: 560, y: 200 },
  { id: 'check', type: 'check.rules', x: 820, y: 200 },
  { id: 'design-review', type: 'human.review', title: '批准玩法范围', x: 1080, y: 200, config: { note: '核对目标、核心循环、控制方式、胜负条件和可观察验收行为。完成批准前不创建游戏工程。' } },
  { id: 'create', type: 'game.create', x: 1340, y: 200, config: { template: 'cinderwatch', orientation: 'landscape' } },
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

const GAME_TEST_BRIEF = [
  '制作原创浏览器小游戏《星光采集》，作为游戏产品与画布工作流的首次联合测试。',
  '范围：2D 竖屏、单关卡、单人、每局 15 秒；使用原生 collector 固定模板和内置图形，不调用生图服务、不联网发布。',
  '玩法：方向键 / A、D 或触屏拖动角色左右移动，接取下落星星加分并躲避红色三角；初始 3 颗心，碰撞扣血，归零失败；存活满 15 秒获胜并显示本局得分。',
  '批准实现契约：nativeTemplate="canvas-collector@1"、durationSeconds=15、hearts=3。规则 JSON 必须显式保留这些字段。该版本仅实现上述固定完整玩法。保持碰撞和失败规则有效，不用无敌或空场景获得测试通过。',
  '游戏验收：标题页能开始；键盘与触屏移动有效；拾取后加分；碰撞后扣血；计时结束显示获胜；生命归零显示失败；结算后可重新开始且得分、生命和倒计时复位；界面不越界。',
  '自动试玩：原型和最终版本各运行 20 秒，使用实际发布参数、不传 rules 覆盖、不使用 characters-only。保存真实报告和截图；自动驾驶未覆盖的失败、重开和触屏行为留给人工试玩，不能声称自动通过。',
  '交付：原生工坊在产品工作区的 games 目录下创建本次尝试的独立工程，记录真实项目路径、标题、模板、构建 ID 与字节数。',
  '工作流验收：设计批准前不创建工程；两个试玩节点与构建节点有各自的宿主尝试和证据，不依赖游戏插件会话；最终人工待办保留未通过状态直到真实试玩；保存草稿后刷新仍能恢复；上游重跑后旧下游产物标记过期。',
  '最终交付单文件离线 HTML。人工打开该文件验证一局和重新开始，并分别记录游戏问题、画布问题及未覆盖项目。没有实际证据时标记未评估。',
].join('\n\n')

const GAME_TEST_CONFIG: Record<string, Record<string, ConfigValue>> = {
  brief: { text: GAME_TEST_BRIEF },
  gdd: { platform: '网页', genre: '2D 单关卡收集躲避', prompt: '严格按需求中的 15 秒试玩范围设计《星光采集》。沿用 collector 可支持的核心循环，写清正常胜负、扣血、计分、重开和键盘/触屏验收；区分自动驾驶证据与人工补测。不扩充关卡、商店、账号或联网功能。' },
  rules: { prompt: '根据 {{in}} 输出玩法规则 JSON，包含 version=1、title、player{count,controls[]}、goal[]、fail[]、loop[]、acceptance[]、openQuestions[]。若设计符合单人横移、接下落星星和躲三角的固定范围，显式写入 nativeTemplate="canvas-collector@1"、durationSeconds=15、hearts=3、creativePack="none"。不支持的机制写入 openQuestions。只输出 JSON。' },
  'design-review': { note: '核对 JSON 中的 canvas-collector@1、15 秒、3 颗心，并检查设计稿和规则都使用左右键／A、D 或触屏横向拖动、接星星计分、碰三角扣血、胜负和重开。' },
  create: { template: 'collector', orientation: 'portrait', durationSeconds: 15, hearts: 3, style: '深蓝夜空、暖黄星星、绿色角色、红色三角；使用内置图形', prompt: '由工作台原生工坊在本次尝试的新目录中创建批准的 15 秒、3 颗心 collector 游戏，返回实际快照证据。' },
  'prototype-playtest': { seconds: 20, prompt: '使用 seconds=20，按工程实际规则自动试玩；不传 rules 覆盖，不使用 characters-only。原样保存工具 summary，工具没有证实的字段标记未评估，不能自行填 true 或 0。' },
  revise: { prompt: '保留《星光采集》的 15 秒和 3 颗心规则。先读取同一项目，再依据真实报告修订；没有可复现缺陷时记录无需修改原因。保留输入的项目路径、标题与当前 buildId，供后续构建使用。禁止通过削弱胜负或碰撞规则使试玩通过。' },
  'final-playtest': { seconds: 20, prompt: '使用 seconds=20，对最终构建按实际规则自动试玩；不传 rules 覆盖，不使用 characters-only。原样保存 summary，工具没有证实的字段标记未评估，不能把失败、重开和键盘/触屏全部算作已自动覆盖。' },
  package: { prompt: '由宿主核对最终构建和真实试玩证据后，精确导出相同 buildId 的快照，不重新构建。源码变化或证据不一致时停止交付。' },
}

const GAME_TEST_TEMPLATE: WorkflowGraph = {
  ...GAME_PRODUCT_TEMPLATE,
  name: '测试 · 星光采集 · 游戏完整闭环',
  nodes: GAME_PRODUCT_TEMPLATE.nodes.flatMap((node, index) => [
    { ...node, x: 40 + (index + (index > 6 ? 1 : 0) + (index > 9 ? 1 : 0)) * 260, config: { ...node.config, ...GAME_TEST_CONFIG[node.id] } },
    ...(node.id === 'prototype-playtest' ? [{ id: 'prototype-context', type: 'flow.join', title: '汇总原型与试玩证据', x: 1860, y: 200, config: { policy: '全部命中', order: '按端口' } }] : []),
    ...(node.id === 'final-playtest' ? [{ id: 'final-context', type: 'flow.join', title: '汇总最终构建与试玩', x: 2900, y: 200, config: { policy: '全部命中', order: '按端口' } }] : []),
  ]),
  edges: [
    ...GAME_PRODUCT_TEMPLATE.edges.filter(edge => edge.to.node !== 'revise' && edge.to.node !== 'package').map(edge => ({ from: { ...edge.from }, to: { ...edge.to } })),
    { from: { node: 'create', port: 'out' }, to: { node: 'prototype-context', port: 'a' } },
    { from: { node: 'prototype-playtest', port: 'out' }, to: { node: 'prototype-context', port: 'b' } },
    { from: { node: 'prototype-context', port: 'out' }, to: { node: 'revise', port: 'in' } },
    { from: { node: 'build', port: 'out' }, to: { node: 'final-context', port: 'a' } },
    { from: { node: 'final-playtest', port: 'out' }, to: { node: 'final-context', port: 'b' } },
    { from: { node: 'final-context', port: 'out' }, to: { node: 'package', port: 'in' } },
  ],
}

const CINDERWATCH_TEST_CONFIG: Record<string, Record<string, ConfigValue>> = {
  brief: { text: [
    '以 Cinderwatch 为完整可玩基线，验证 Three.js 塔防与工作台游戏节点。保留上游 MIT 许可、作者与 Three.js 通知。',
    '批准参数：nativeTemplate="cinderwatch@1"、seed=4、biome="ashen"、startingGold=300、lives=20、autoCommand=true。规则 JSON 显式保留这些字段，creativePack="none"。',
    '玩法：四类塔、建造/升级/出售、道路敌人、波次与Boss、金币收益、基地生命、自动指挥/手动接管、暂停、速度与镜头控制。场景、模型、纹理与声音为程序化资源。',
    '自动验收：真实浏览器绘制 WebGL 场景；鼠标建塔扣金；键盘接管/归还指挥与暂停；波次推进、击杀与经济增长；触屏输入和竖屏布局；零脚本错误和联网尝试，保存桌面/手机截图。无尽塔防不以 won 或通关为通过条件。',
    '工作流：批准前不创建；每个节点调用同一游戏工具核心，记录真实项目与 buildId；构建、试玩和离线导出保持同版。Agent 可独立调用工具，无需 run 或工作流快照。',
    '人工验收：实际打开导出 HTML，建塔、升级、缩放平移、指挥接管，观察至少两波敌人，补测失败与重开、听感和难度；填写真实设备、分钟数、导出路径与已知问题。自动报告不能替代人工通过。',
  ].join('\n\n') },
  gdd: { platform: '网页', genre: 'Three.js 3D 塔防', prompt: '围绕 Cinderwatch 完整塔防设计本次验证，保留四塔、升级、道路敌人、波次、金币、生命、自动指挥与玩家接管。使用需求中的批准参数，不替换成采集躲避，不承诺任意模型导入或付费生成。区分自动证据和人工玩法、失败/重开验收。' },
  rules: { prompt: '根据 {{in}} 输出 JSON：version=1、title、player{count=1,controls[]}、goal[]、fail[]、loop[]、acceptance[]、openQuestions[]，另显式写 nativeTemplate="cinderwatch@1"、seed=4、biome="ashen"、startingGold=300、lives=20、autoCommand=true、creativePack="none"。塔防无尽波次不要求 won；基地生命归零失败，可重开。不得添加未实现机制或改成 collector。' },
  'design-review': { note: '核对 cinderwatch@1、seed4、ashen、300金币、20生命和自动指挥=true；确认四塔、升级、波次、金币和接管。只有这些批准值创建到工程；不靠采集或空场景代替。' },
  create: { template: 'cinderwatch', orientation: 'landscape' },
  'prototype-playtest': { seconds: 20, maxRepairs: 0 },
  revise: { prompt: '核对同一项目、当前源码与塔防专有自动证据。没有待修项则明确无需修改；Cinderwatch 禁止用 collector 标准源码恢复，不能削弱战斗或篡改规则通过。' },
  'final-playtest': { seconds: 20, maxRepairs: 0 },
  package: { prompt: '核对 Cinderwatch 专有试玩 checks 全通过、真实报告/截图 hash 与当前 buildId 一致后，精确导出该构建；不重新构建或联网发布。' },
}

const CINDERWATCH_TEST_TEMPLATE: WorkflowGraph = {
  ...GAME_TEST_TEMPLATE,
  name: '测试 · Cinderwatch 3D 塔防 · 游戏完整闭环',
  nodes: GAME_TEST_TEMPLATE.nodes.map(node => ({ ...node, config: { ...(CINDERWATCH_TEST_CONFIG[node.id] ?? node.config) } })),
}

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

export const templates: { id: string; line: ProductLineId; summary: string; graph: WorkflowGraph; legacy?: boolean }[] = [
  { id: 'game-gdd-to-playtest', line: 'game', summary: '需求 → 设计稿 → 规则 JSON → 校验 → 人工确认 → 文件导出', graph: GAME_TEMPLATE },
  { id: 'game-product-closed-loop', line: 'game', summary: '需求 → 玩法批准 → 可玩原型 → 自动试玩修订 → 最终构建与试玩 → 离线 HTML → 人工验收', graph: GAME_PRODUCT_TEMPLATE },
  { id: 'game-cinderwatch-test', line: 'game', summary: '预填 Cinderwatch 3D 塔防；验证建塔、指挥接管、波次、金币、移动端及离线交付，保留人工验收', graph: CINDERWATCH_TEST_TEMPLATE },
  { id: 'game-starlight-test', line: 'game', legacy: true, summary: '旧版《星光采集》兼容模板；保留已有模板 ID 与运行', graph: GAME_TEST_TEMPLATE },
  { id: 'workbench-canvas-delivery', line: 'game', summary: '画布任务拆解 → 人工实施记录 → 集中验收 → 证据回填 → 报告导出；不自动改代码或运行测试', graph: CANVAS_DELIVERY_TEMPLATE },
  { id: 'novel-bible-to-chapter', line: 'novel', summary: '需求 → 设定集 → 人物 + 大纲 → 章节 → 文风校验 → 导出', graph: NOVEL_TEMPLATE },
  { id: 'drama-story-to-deliver', line: 'drama', summary: '需求 → 故事核 → 分镜脚本 → 分镜表 + 配音 → 角色一致 → 交付包', graph: DRAMA_TEMPLATE },
]

