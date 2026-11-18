import type { NodeDef } from '../../shared/workflow-canvas-model.js'

export const nodes: NodeDef[] = [
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
    id: 'input.doc', title: '输入文档', cat: 'input', actor: 'auto', executor: 'unavailable', unavailableReason: '文档读取尚未接入，请使用需求节点。',
    hint: '引用已有材料：产品笔记、模块文档、本地文件或项目里的规格。',
    inputs: [], outputs: [{ id: 'out', label: '文档', type: 'file-set' }],
    config: [
      { key: 'source', label: '来源', kind: 'select', options: ['产品笔记', '模块文档', '项目文件', '本地上传'], value: '产品笔记' },
      { key: 'path', label: '路径 / 标题', kind: 'text', value: '', hint: '留空表示运行时再选' },
      { key: 'mustExist', label: '必须存在', kind: 'check', value: true },
    ],
  },
  {
    id: 'retrieve.knowledge', title: '知识检索', cat: 'retrieve', actor: 'auto', executor: 'unavailable', unavailableReason: '工作流知识检索尚未接入。',
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
    hint: '把几路产物合并成一份上下文：可等待全部分支，也可等任一有效分支。',
    inputs: [
      { id: 'a', label: '输入 A', type: 'any' },
      { id: 'b', label: '输入 B', type: 'any', optional: true },
      { id: 'c', label: '输入 C', type: 'any', optional: true },
    ],
    outputs: [{ id: 'out', label: '合并', type: 'any' }],
    config: [
      { key: 'policy', label: '汇合条件', kind: 'select', options: ['全部命中', '任一命中'], value: '全部命中', hint: '等待所有连接分支结束；任一命中时只合并有效产物，跳过的分支保留记录。' },
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
    id: 'tool.call', title: '工具调用', cat: 'tool', actor: 'auto', executor: 'unavailable', unavailableReason: '通用工具执行尚未接入。',
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
    hint: '通过输出原文；关闭中断后，失败输出检查报告。未命中的分支会跳过。',
    inputs: [{ id: 'in', label: '输入', type: 'any' }],
    outputs: [
      { id: 'pass', label: '通过', type: 'any' },
      { id: 'fail', label: '未通过', type: 'report' },
    ],
    config: [
      { key: 'rules', label: '必需检查', kind: 'select', options: ['非空', '结构完整', '引用可解析', '无占位符', '字数达标'], value: '非空' },
      { key: 'strict', label: '失败时暂停（关闭后走失败分支）', kind: 'check', value: true },
      { key: 'expect', label: '期望值', kind: 'text', value: '', hint: '非空类留空；字数达标填最小字数。' },
    ],
  },
  {
    id: 'output.publish', title: '文件导出', cat: 'output', actor: 'auto',
    hint: '运行完成后显式导出文件集，保留来源与哈希。',
    inputs: [{ id: 'in', label: '输入', type: 'any' }], outputs: [],
    config: [
      { key: 'target', label: '目标', kind: 'select', options: ['产品模块', '设计笔记', '文件导出', '问题清单'], value: '文件导出' },
      { key: 'dir', label: '历史导出路径（不执行）', kind: 'text', value: '', hint: '实际目录固定为产品项目根下 workflow-out/唯一批次，不采用此字段。' },
    ],
  },

]
