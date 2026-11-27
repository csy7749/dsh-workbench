import type { NodeDef } from '../../shared/workflow-canvas-model.js'

const GAME_EXECUTION_PROMPT = 'Host-owned native game operation. Bind the product, run, attempt and verified source receipts; never accept model text as build or playtest evidence.'

export const nodes: NodeDef[] = [
  {
    id: 'game.rules', title: '玩法规则', cat: 'design', actor: 'agent', lines: ['game'],
    requiredChecks: ['game.rules.schema', 'game.rules.non_empty', 'game.rules.no_placeholder'], artifactKind: 'json', reviewKind: 'game-review-v1', exportName: 'rules.json',
    hint: '将设计稿变成可校验的玩法规则 JSON。',
    inputs: [{ id: 'in', label: '设计稿', type: 'markdown' }], outputs: [{ id: 'out', label: '规则', type: 'json' }],
    config: [
      { key: 'strictness', label: '严格程度', kind: 'select', options: ['宽松', '标准', '严格'], value: '标准' },
      { key: 'maxGoals', label: '目标上限', kind: 'number', min: 1, max: 8, value: 3 },
      { key: 'includeOpenQuestions', label: '列出未决问题', kind: 'check', value: true },
      { key: 'prompt', label: '提示词', kind: 'textarea', value: '根据 {{in}} 输出玩法规则 JSON：version=1、title、player{count,controls[]}、goal[]、fail[]、loop[]、acceptance[]、openQuestions[]。只输出 JSON。' },
    ],
  },
  {
    id: 'game.gdd', title: '玩法设计稿', cat: 'design', actor: 'agent', lines: ['game'], exportName: 'gdd.md',
    prompt: '产出完整 Markdown，至少六个二级章节：目标与范围、核心循环（至少四步）、操作、状态与反馈、失败条件、可观察的验收行为。内容必须对应本次需求。',
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
    id: 'game.unity-import', title: '导入 Unity 工程', cat: 'output', actor: 'auto', lines: ['game'], executor: 'unavailable', capability: 'game-studio', unavailableReason: 'Unity 工程导入器尚未接通；当前参考闭环交付浏览器 HTML。',
    hint: '把产物落到 Unity 工程的约定目录；预演模式下只列将写入的文件，不落盘。',
    inputs: [{ id: 'in', label: '产物', type: 'any' }], outputs: [],
    config: [
      { key: 'project', label: '工程路径', kind: 'text', value: '', hint: '例：D:/csy/Unity/Gitee/RingofXian/AI2Unity' },
      { key: 'folder', label: '目标目录', kind: 'select', options: ['Assets/Design', 'Assets/Data', 'Assets/Art', 'Assets/Docs'], value: 'Assets/Design' },
      { key: 'dryRun', label: '只列清单不写入', kind: 'check', value: true },
    ],
  },
  {
    id: 'game.playtest', title: '游戏自动试玩', cat: 'check', actor: 'auto', lines: ['game'], executor: 'tool-service', capability: 'game-studio', artifactKind: 'json',
    executionPrompt: GAME_EXECUTION_PROMPT,
    requiredChecks: ['game.playtest.evidence'],
    prompt: "由工作台在本机真实浏览器中试玩明确 buildId，记录输入、终局、错误、网络和截图；未覆盖项保留给人工，不接受模型编造的试玩证据。",
    hint: '在真实浏览器中自动试玩当前游戏构建；报告证据，不替代人工试玩。',
    inputs: [{ id: 'in', label: '产物', type: 'any' }],
    outputs: [{ id: 'out', label: '自动试玩证据', type: 'json' }],
    config: [
      { key: 'seconds', label: '自动试玩预算（秒）', kind: 'number', min: 1, max: 60, value: 20 },
      { key: 'maxRepairs', label: '旧 collector 兼容恢复次数', kind: 'number', min: 0, max: 1, value: 0 },
    ],
  },

  {
    id: 'game.create', title: '创建可玩工程', cat: 'tool', actor: 'auto', lines: ['game'], executor: 'tool-service', capability: 'game-studio', artifactKind: 'file-set',
    executionPrompt: GAME_EXECUTION_PROMPT,
    requiredChecks: ['game.project.evidence'], exportName: 'prototype-build.json',
    prompt: "由工作台调用共享游戏工具核心，根据已批准的 cinderwatch@1 规则创建 Three.js 塔防工程及首版构建。保留 seed、biome、startingGold、lives、autoCommand 的批准值。",
    hint: '从获批规则创建 Cinderwatch 3D 塔防；工具本身可由 Agent 直接调用，节点附加工作流证据。',
    inputs: [{ id: 'in', label: '已批准设计包', type: 'any' }], outputs: [{ id: 'out', label: '游戏工程与首版构建', type: 'json' }],
    config: [
      { key: 'template', label: '游戏模板', kind: 'select', options: ['cinderwatch', 'collector'], value: 'cinderwatch', hint: 'Cinderwatch 为完整 Three.js 塔防；collector 仅保留已有运行兼容。' },
      { key: 'orientation', label: '屏幕方向', kind: 'select', options: ['portrait', 'landscape'], value: 'landscape' },
    ],
  },
  {
    id: 'game.revise', title: '按试玩证据修订', cat: 'tool', actor: 'auto', lines: ['game'], executor: 'tool-service', capability: 'game-studio', artifactKind: 'json',
    executionPrompt: GAME_EXECUTION_PROMPT,
    requiredChecks: ['game.revision.evidence'], exportName: 'prototype-revision.json',
    prompt: "由宿主对照真实试玩报告核对工作副本和被测快照。Cinderwatch 不使用 collector 标准源码恢复；源码候选必须经过游戏工具的真实核验，不能改变批准规则或削弱通过条件。",
    hint: '读取游戏源码，依据首轮试玩证据修复问题或明确记录无需改动。',
    inputs: [{ id: 'in', label: '初版与首轮试玩证据', type: 'any' }], outputs: [{ id: 'out', label: '修订记录', type: 'json' }],
    config: [],
  },
  {
    id: 'game.build', title: '构建游戏', cat: 'tool', actor: 'auto', lines: ['game'], executor: 'tool-service', capability: 'game-studio', artifactKind: 'json',
    executionPrompt: GAME_EXECUTION_PROMPT,
    requiredChecks: ['game.project.evidence'], exportName: 'final-build.json',
    prompt: "由工作台原生工坊构建同一已登记工程，保留真实 buildId、文件字节数、hash、快照和预览地址。",
    hint: '实际重建游戏并记录版本、构建 ID 与预览产物。',
    inputs: [{ id: 'in', label: '修订后的游戏工程', type: 'any' }], outputs: [{ id: 'out', label: '最终构建', type: 'json' }], config: [],
  },
  {
    id: 'game.package', title: '导出离线游戏', cat: 'output', actor: 'auto', lines: ['game'], executor: 'tool-service', capability: 'game-studio', artifactKind: 'json',
    executionPrompt: GAME_EXECUTION_PROMPT,
    requiredChecks: ['game.package.evidence'], exportName: 'offline-game-export.json',
    prompt: "由工作台核对最终构建、自动试玩和当前源码的一致性，精确导出已试玩 buildId；不重新构建、不发布、不分享。",
    hint: '把最终已试玩版本导出为单文件 HTML；不联网发布。',
    inputs: [{ id: 'in', label: '最终试玩与构建证据', type: 'any' }], outputs: [{ id: 'out', label: '离线 HTML 交付物', type: 'json' }], config: [],
  },
  {
    id: 'game.handoff-review', title: '人工试玩与交付验收', cat: 'human', actor: 'human', lines: ['game'], reviewKind: 'game-handoff-v1', artifactKind: 'json', exportName: 'playtest-acceptance.json',
    hint: '亲自打开导出的游戏完成一轮试玩，记录设备、完成情况与已知问题；只有填写通过才可导出工作流交付记录。',
    inputs: [{ id: 'in', label: '最终构建与试玩证据', type: 'any' }], outputs: [{ id: 'out', label: '已验收交付记录', type: 'json' }],
    config: [],
  },
]
