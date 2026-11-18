import type { NodeDef } from '../../shared/workflow-canvas-model.js'

export const nodes: NodeDef[] = [
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

]
