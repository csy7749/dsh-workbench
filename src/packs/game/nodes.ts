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
    id: 'game.unity-import', title: '导入 Unity 工程', cat: 'output', actor: 'auto', lines: ['game'], executor: 'unavailable', capability: 'game-studio', unavailableReason: '需要 Game Studio，当前不可用。',
    hint: '把产物落到 Unity 工程的约定目录；预演模式下只列将写入的文件，不落盘。',
    inputs: [{ id: 'in', label: '产物', type: 'any' }], outputs: [],
    config: [
      { key: 'project', label: '工程路径', kind: 'text', value: '', hint: '例：D:/csy/Unity/Gitee/RingofXian/AI2Unity' },
      { key: 'folder', label: '目标目录', kind: 'select', options: ['Assets/Design', 'Assets/Data', 'Assets/Art', 'Assets/Docs'], value: 'Assets/Design' },
      { key: 'dryRun', label: '只列清单不写入', kind: 'check', value: true },
    ],
  },
  {
    id: 'game.playtest', title: '试玩任务单', cat: 'output', actor: 'agent', lines: ['game'], executor: 'unavailable', capability: 'game-studio', unavailableReason: '需要 Game Studio，当前不可用；玩法尚未验证。',
    hint: '给试玩的人一份可执行的任务单：看什么、怎么记录、什么算问题。',
    inputs: [{ id: 'in', label: '产物', type: 'any' }],
    outputs: [{ id: 'out', label: '任务单', type: 'markdown' }],
    config: [
      { key: 'players', label: '试玩人数', kind: 'number', min: 1, max: 30, value: 3 },
      { key: 'minutes', label: '每人时长（分钟）', kind: 'number', min: 5, max: 180, value: 20 },
      { key: 'focus', label: '观察重点', kind: 'select', options: ['上手成本', '手感', '难度曲线', '留存意愿'], value: '上手成本' },
    ],
  },

  { id: 'game.build', title: '构建工程', cat: 'tool', actor: 'auto', lines: ['game'], executor: 'unavailable', capability: 'game-studio', unavailableReason: '需要 Game Studio，当前不可用。', hint: '冻结玩法规则与工程基准后构建，v1 仅保留契约。', inputs: [{ id: 'in', label: '玩法规则', type: 'json' }], outputs: [{ id: 'out', label: '构建文件', type: 'file-set' }], config: [] },
]
