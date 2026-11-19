import type { NodeDef } from '../../shared/workflow-canvas-model.js'

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
    id: 'game.playtest', title: '游戏自动试玩', cat: 'check', actor: 'agent', lines: ['game'], executor: 'dsh-session', capability: 'game-studio', artifactKind: 'json',
    requiredChecks: ['game.playtest.evidence'],
    prompt: '必须使用 DSH 游戏工坊的 game_studio_playtest 实际运行输入中的游戏，不能只读源码推测。传入项目路径并使用适合当前关卡的时长。工具返回包含 summary、finalPhase、errors、runDir 和 images；从 summary 原样提取 Screenshots 路径、Errors 和 Network requests 信息，并将输入中的当前 buildId 原样带入。只输出规范化 JSON：{"project":"工具返回的项目路径","buildId":"输入里的当前构建 ID","finalPhase":"工具返回的终局状态","buildCurrent":true,"errors":0,"requests":0,"bestScore":0,"runDir":"工具返回的试玩报告目录","screenshots":["summary 中列出的截图路径"],"summary":"工具返回的 summary","unassessed":["未覆盖项"]}。只有 summary 明确没有错误、没有网络请求且构建是当前版本时才填写 buildCurrent=true、errors=0、requests=0；数值和状态必须来自工具响应。工具失败、报告无效或未到达 won 时填写失败状态，不得编造字段或把自动试玩写成人工试玩。',
    hint: '在真实浏览器中自动试玩当前游戏构建；报告证据，不替代人工试玩。',
    inputs: [{ id: 'in', label: '产物', type: 'any' }],
    outputs: [{ id: 'out', label: '自动试玩证据', type: 'json' }],
    config: [
      { key: 'seconds', label: '试玩时长（秒）', kind: 'number', min: 1, max: 60, value: 20 },
    ],
  },

  {
    id: 'game.create', title: '创建可玩工程', cat: 'tool', actor: 'agent', lines: ['game'], executor: 'dsh-session', capability: 'game-studio', artifactKind: 'file-set',
    requiredChecks: ['game.project.evidence'], exportName: 'prototype-build.json',
    prompt: '根据已批准的玩法资料调用 DSH 游戏工坊的 game_studio_create 创建实际游戏工程并生成首个可玩构建。只使用一个新的 games/<ascii-slug> 项目目录；slug 仅含小写英文字母、数字和连字符。根据资料确定游戏标题、画面方向与美术风格，使用本节点配置的模板。按玩法为角色、敌人、收集物和背景设置清晰的中文槽位名。不要生成图片，不要发布或分享。工具返回的 build.buildId、build.bytes 才是构建证据；规范化输出 JSON：{"project":"工具返回的 project","title":"工具返回的 title","template":"本节点实际模板","buildId":"工具返回的 build.buildId","bytes":0,"previewAvailable":true}。不得虚构构建或路径。',
    hint: '从获批的设计包创建真实浏览器游戏工程和首个可玩版本。',
    inputs: [{ id: 'in', label: '已批准设计包', type: 'any' }], outputs: [{ id: 'out', label: '游戏工程与首版构建', type: 'json' }],
    config: [
      { key: 'template', label: '游戏模板', kind: 'select', options: ['collector', 'voxel'], value: 'collector', hint: 'collector 为 2D 收集躲避；voxel 为 3D 体素场景。' },
      { key: 'orientation', label: '屏幕方向', kind: 'select', options: ['portrait', 'landscape'], value: 'portrait' },
      { key: 'style', label: '美术风格', kind: 'text', value: '' },
    ],
  },
  {
    id: 'game.revise', title: '按试玩证据修订', cat: 'tool', actor: 'agent', lines: ['game'], executor: 'dsh-session', capability: 'game-studio', artifactKind: 'json',
    requiredChecks: ['game.revision.evidence'], exportName: 'prototype-revision.json',
    prompt: '输入 JSON 包含实际项目路径、初版构建和试玩证据。先用 DSH 工具读取项目状态，再实际读取该工程的 game.json 和 game.js。针对可复现错误、目标不可达、控制不响应、画面越界或试玩未覆盖的核心机制修订代码。保持批准的设计范围，不做顺手扩张；如报告没有可复现缺陷，原样保留代码并说明无需修改。只修改输入路径所指的游戏工程，不触碰工作台仓库或其他文件。不要生图、分享或发布。只输出 JSON：{"project":"原项目相对路径","title":"游戏标题","buildId":"初版构建 ID","changes":["实际修改文件及原因"],"noChangesReason":"无需修订时的原因","manualChecksRequired":["仍需人工验证的项目"]}。不得声称已试玩修订版；下一节点将重新构建。',
    hint: '读取游戏源码，依据首轮试玩证据修复问题或明确记录无需改动。',
    inputs: [{ id: 'in', label: '初版与首轮试玩证据', type: 'any' }], outputs: [{ id: 'out', label: '修订记录', type: 'json' }],
    config: [],
  },
  {
    id: 'game.build', title: '构建游戏', cat: 'tool', actor: 'agent', lines: ['game'], executor: 'dsh-session', capability: 'game-studio', artifactKind: 'json',
    requiredChecks: ['game.project.evidence'], exportName: 'final-build.json',
    prompt: '从输入 JSON 中取出唯一的游戏项目路径和标题，调用 DSH 游戏工坊的 game_studio_build 构建修订后的游戏。失败时原样报告错误并停止，不得用旧构建冒充新构建。不要改写设计、发布、分享或生成图片。工具返回的 project、buildId、bytes、artifact 才是构建证据；只输出 JSON：{"project":"工具返回的 project","title":"输入中的游戏标题","buildId":"工具返回的新构建 ID","bytes":0,"artifact":"工具返回的 artifact","note":"工具返回的 note（没有则为空）"}。不得虚构构建 ID 或路径。',
    hint: '实际重建游戏并记录版本、构建 ID 与预览产物。',
    inputs: [{ id: 'in', label: '修订后的游戏工程', type: 'any' }], outputs: [{ id: 'out', label: '最终构建', type: 'json' }], config: [],
  },
  {
    id: 'game.package', title: '导出离线游戏', cat: 'output', actor: 'agent', lines: ['game'], executor: 'dsh-session', capability: 'game-studio', artifactKind: 'json',
    requiredChecks: ['game.package.evidence'], exportName: 'offline-game-export.json',
    prompt: '输入包含最终构建、其构建 ID 及自动试玩证据。先确认自动试玩使用的 ID 与最终构建相同，再调用 DSH 游戏工坊的 game_studio_export 导出一个自包含、离线可运行的 HTML 文件。工具返回的 file、bytes 才是导出证据；规范化输出 JSON：{"project":"工具返回的 project","buildId":"输入中的最终构建 ID","exportPath":"工具返回的 file","bytes":0,"offline":true}。不要部署、发布或创建分享链接，不得虚构导出结果。',
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
