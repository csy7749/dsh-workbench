import type { NodeDef } from '../../shared/workflow-canvas-model.js'

export const nodes: NodeDef[] = [
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
