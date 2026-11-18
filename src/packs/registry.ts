import { configurationNodes } from './core/execution-config.ts'
import { nodes as core } from './core/nodes.ts'
import { nodes as game } from './game/nodes.ts'
import { nodes as novel } from './novel/nodes.ts'
import { nodes as drama } from './drama/nodes.ts'
import { templates } from './templates.ts'
import { registerPack, normalizeGraph, NODE_DEFS, PRODUCT_LINES, PACKS, TEMPLATES } from '../shared/workflow-canvas-model.ts'
import type { NodeDef } from '../shared/workflow-canvas-model.ts'

const executable = (nodes: NodeDef[]): NodeDef[] => nodes.map(node => ({
  ...node,
  executor: node.executor ?? (node.cat === 'human' ? 'human' : node.actor === 'agent' ? 'dsh-session' : 'tool-service'),
  inputs: node.actor === 'agent' ? [...node.inputs, { id: 'execution', label: '执行配置', type: 'execution-config', optional: true }] : node.inputs,
}))
registerPack({ id: 'core', version: '1.0.0', label: '通用', namespaces: ['input', 'retrieve', 'flow', 'dsh', 'tool', 'human', 'check', 'output', 'config'], nodeDefs: executable([...configurationNodes, ...core]), templates: [] })
registerPack({ id: 'game', version: '1.0.0', label: '游戏', line: { id: 'game', name: '游戏', short: '游戏', accent: '#34d399', summary: '需求 → 设计稿 → 规则 → 校验 → 人工确认 → 文件导出', focus: ['设计稿', '玩法规则', '人工审核', '文件导出'] }, nodeDefs: executable(game), templates: [] })
for (const [id, name, nodes, accent] of [['novel', '小说', novel, '#a78bfa'], ['drama', '短剧', drama, '#f472b6']] as const) {
  registerPack({ id, version: '1.0.0', label: name, line: { id, name, short: name, accent, summary: '示例节点，真实执行暂缓', focus: ['契约示例'] }, nodeDefs: executable(nodes.map(node => ({ ...node, executor: 'unavailable', unavailableReason: name + '真实执行不在 v1 范围。' }))), templates: [] })
}
for (const template of templates) {
  const normalized = { ...template, graph: normalizeGraph(template.graph, template.line).graph }
  TEMPLATES.push(normalized)
  PACKS.find(pack => pack.id === template.line)!.templates.push(normalized)
}
export const registeredNodes = NODE_DEFS
export const productLines = PRODUCT_LINES
