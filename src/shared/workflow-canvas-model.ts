import type { ProductPack } from './product-pack.ts'

/** Pure graph contracts. Vocabulary is supplied by the catalog composition module. */
export type PortType = 'file-set' | 'markdown' | 'text' | 'json' | 'report' | 'table' | 'any' | 'control' | 'model-config' | 'role-config' | 'execution-config'
export type NodeCategory = 'input' | 'retrieve' | 'design' | 'generate' | 'tool' | 'human' | 'check' | 'output' | 'config'
export type ProductLineId = string
/** agent=DSH Agent 执行 / human=人等确认 / auto=确定性程序（解析、导出） */
export type Actor = 'agent' | 'human' | 'auto'
export type ConfigKind = 'select' | 'number' | 'text' | 'textarea' | 'range' | 'check'
export type ConfigValue = string | number | boolean

export interface PortSpec {
  id: string
  label: string
  type: PortType
  /** true = 可以不接线（如汇总节点的第 2、3 路） */
  optional?: boolean
}

export interface ConfigField {
  key: string
  label: string
  kind: ConfigKind
  value: ConfigValue
  options?: string[]
  min?: number
  max?: number
  step?: number
  hint?: string
}

export interface NodeDef {
  id: string
  title: string
  cat: NodeCategory
  actor: Actor
  hint: string
  /** 省略 = 全部产品线可用 */
  lines?: ProductLineId[]
  inputs: PortSpec[]
  outputs: PortSpec[]
  config: ConfigField[]
  executor?: 'dsh-session' | 'tool-service' | 'human' | 'unavailable'
  unavailableReason?: string
  capability?: string
  requiredChecks?: string[]
  artifactKind?: string
  prompt?: string
  /** Product-pack execution guidance, frozen into a run; never read from node configuration. */
  executionPrompt?: string
  reviewKind?: string
  exportName?: string
}

export const TYPE_COLOR: Record<PortType, string> = {
  'file-set': '#34d399',
  markdown: '#a78bfa',
  text: '#60a5fa',
  json: '#22d3ee',
  report: '#f472b6',
  table: '#fbbf24',
  any: '#94a3b8',
  control: '#eab308',
  'model-config': '#fb923c',
  'role-config': '#facc15',
  'execution-config': '#f97316',
}

export const TYPE_LABEL: Record<PortType, string> = {
  'file-set': '文件集',
  markdown: 'Markdown',
  text: '文本',
  json: 'JSON',
  report: '报告',
  table: '表格',
  any: '任意',
  control: '控制',
  'model-config': '模型配置',
  'role-config': '角色配置',
  'execution-config': '执行配置',
}

export interface CategorySpec { id: NodeCategory; name: string; accent: string; hint: string }

export const CATEGORIES: CategorySpec[] = [
  { id: 'config', name: '执行配置', accent: '#f97316', hint: '模型与角色，不占运行步骤' },
  { id: 'input', name: '输入', accent: '#34d399', hint: '流程的起点：需求、文档、已有产物' },
  { id: 'retrieve', name: '检索', accent: '#22d3ee', hint: '取知识与上下文，不产出新内容' },
  { id: 'design', name: '设计', accent: '#a78bfa', hint: '先定结构再写：设定、大纲、GDD、分镜' },
  { id: 'generate', name: '生成', accent: '#8b5cf6', hint: '按上游结构产出正文' },
  { id: 'tool', name: '工具', accent: '#38bdf8', hint: '确定性动作：汇总、解析、导出' },
  { id: 'human', name: '人工', accent: '#fbbf24', hint: '停在这里等人改完、确认再继续' },
  { id: 'check', name: '校验', accent: '#60a5fa', hint: '机器可判的规则：不合格就分流' },
  { id: 'output', name: '输出', accent: '#f472b6', hint: '落库、落工程、落交付包' },
]

export interface ProductLine {
  id: ProductLineId
  name: string
  short: string
  accent: string
  summary: string
  focus: string[]
}

export const PRODUCT_LINES: ProductLine[] = []

export function lineOf(id: string): ProductLine {
  return PRODUCT_LINES.find(item => item.id === id) ?? PRODUCT_LINES[0]
}

/* ------------------------------------------------------------------ *
 * 节点目录
 * ------------------------------------------------------------------ */

export const NODE_DEFS: NodeDef[] = []
export const PACKS: ProductPack[] = []
export function registerPack(pack: ProductPack): () => void {
  if (PACKS.some(item => item.id === pack.id)) throw new Error('pack_duplicate:' + pack.id)
  const known = new Set(NODE_DEFS.map(node => node.id))
  for (const node of pack.nodeDefs) {
    if (known.has(node.id) || !(pack.namespaces ?? [pack.id]).some(prefix => node.id.startsWith(prefix + '.'))) throw new Error('pack_node_invalid:' + node.id)
    known.add(node.id)
    if ([...node.inputs, ...node.outputs].some(port => !(port.type in TYPE_COLOR))) throw new Error('pack_port_invalid')
  }
  PACKS.push(pack)
  NODE_DEFS.push(...pack.nodeDefs)
  if (pack.line) PRODUCT_LINES.push(pack.line)
  TEMPLATES.push(...pack.templates)
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    PACKS.splice(PACKS.indexOf(pack), 1)
    for (const node of pack.nodeDefs) NODE_DEFS.splice(NODE_DEFS.indexOf(node), 1)
    if (pack.line) PRODUCT_LINES.splice(PRODUCT_LINES.indexOf(pack.line), 1)
    for (const template of pack.templates) TEMPLATES.splice(TEMPLATES.indexOf(template), 1)
  }
}

export function defById(id: string): NodeDef | undefined {
  return NODE_DEFS.find(def => def.id === id)
}

/** 某条产品线可用的节点定义（顺序保持目录顺序，节点库分组渲染）。 */
export function defsForLine(line: ProductLineId): NodeDef[] {
  return NODE_DEFS.filter(def => def.lines === undefined || def.lines.includes(line))
}

export function defsInCategory(line: ProductLineId, cat: NodeCategory): NodeDef[] {
  return defsForLine(line).filter(def => def.cat === cat)
}

/* ------------------------------------------------------------------ *
 * 图数据与收敛
 * ------------------------------------------------------------------ */

export interface CanvasNode {
  id: string
  /** NODE_DEFS 的 id；不认识的类型保留原数据并阻止执行。 */
  type: string
  x: number
  y: number
  config: Record<string, ConfigValue>
  title?: string
  disabled?: boolean
}

export interface CanvasEdge {
  from: { node: string; port: string }
  to: { node: string; port: string }
}

export interface WorkflowGraph {
  version: 1
  name: string
  line: ProductLineId
  defaults?: { providerId: string; modelId: string; role: string }
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

/** 单图上限；宿主按字节再挡一次，前端先挡免得拖爆。 */
export const GRAPH_LIMITS = { nodes: 200, edges: 400, bytes: 512 * 1024 }

export interface GraphIssue {
  level: 'error' | 'warn'
  code: string
  message: string
  nodeId?: string
}

export function emptyGraph(line: ProductLineId, name?: string): WorkflowGraph {
  return { version: 1, name: name ?? '未命名流程', line, nodes: [], edges: [] }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_X = 20000
const MAX_Y = 20000

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asFinite(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, num))
}

/** 按定义收敛已知配置项；图规范化时额外保留未知键。 */
export function coerceConfig(def: NodeDef, input: unknown): Record<string, ConfigValue> {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const out: Record<string, ConfigValue> = {}
  for (const field of def.config) {
    const value = source[field.key]
    if (field.kind === 'number' || field.kind === 'range') {
      const min = field.min ?? 0
      const max = field.max ?? 100
      out[field.key] = asFinite(typeof value === 'number' ? value : Number(value), Number(field.value), min, max)
      continue
    }
    if (field.kind === 'check') {
      out[field.key] = typeof value === 'boolean' ? value : field.value === true
      continue
    }
    if (field.kind === 'select') {
      const text = asString(value, String(field.value))
      const options = field.options ?? []
      out[field.key] = options.length === 0 || options.includes(text) ? text : String(field.value)
      continue
    }
    out[field.key] = asString(value, String(field.value))
  }
  return out
}

export function makeNode(type: string, x: number, y: number, id?: string): CanvasNode | null {
  const def = defById(type)
  if (def === undefined) return null
  return { id: id ?? type.replace(/[^A-Za-z0-9_-]/g, '-') + '-' + Math.random().toString(36).slice(2, 8), type: def.id, x, y, config: coerceConfig(def, {}) }
}

/**
 * 把任意来路的数据收敛成合法图；未知节点保留并阻止运行，其余修正均返回提示。
 * 前端从磁盘/接口读到的、以及粘贴导入的 JSON 都走这里。
 */
export function normalizeGraph(input: unknown, fallbackLine: ProductLineId): { graph: WorkflowGraph; issues: GraphIssue[] } {
  const issues: GraphIssue[] = []
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const line = typeof raw.line === 'string' && raw.line ? raw.line : fallbackLine
  if (!PRODUCT_LINES.some(item => item.id === line)) issues.push({ level: 'warn', code: 'line_unknown', message: '产品线 ' + line + ' 未安装，已保留原标识并阻止运行。' })
  const graph: WorkflowGraph = { ...raw, version: typeof raw.version === 'number' ? raw.version : 1, name: asString(raw.name, '未命名流程').slice(0, 120), line, nodes: [], edges: [] } as WorkflowGraph
  if (raw.version !== undefined && raw.version !== 1) issues.push({ level: 'warn', code: 'version_unknown', message: '画布版本不受支持，已保留原始版本并阻止运行。' })

  if (typeof raw.defaults === 'object' && raw.defaults !== null) {
    const defaults = raw.defaults as Record<string, unknown>
    graph.defaults = { ...defaults, providerId: asString(defaults.providerId, ''), modelId: asString(defaults.modelId, ''), role: asString(defaults.role, '') }
  }
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : []
  if (!Array.isArray(raw.nodes)) issues.push({ level: 'warn', code: 'nodes_missing', message: '数据里没有 nodes 数组，按空图处理。' })
  const seen = new Set<string>()
  for (const item of rawNodes) {
    if (graph.nodes.length >= GRAPH_LIMITS.nodes) {
      issues.push({ level: 'warn', code: 'nodes_truncated', message: '节点超过上限 ' + GRAPH_LIMITS.nodes + ' 个，多余的已丢弃。' })
      break
    }
    const node = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const type = asString(node.type, '')
    const def = defById(type)
    if (def === undefined) issues.push({ level: 'warn', code: 'node_unknown', message: '未知节点类型 ' + (type || '(空)') + '，已保留，安装对应产品包后可继续编辑。', nodeId: asString(node.id, '') })
    if (def && def.lines !== undefined && !def.lines.includes(line)) issues.push({ level: 'warn', code: 'node_line_mismatch', message: def.title + ' 不属于产品线「' + lineOf(line).name + '」，已保留。', nodeId: asString(node.id, '') })
    let id = asString(node.id, '')
    if (!ID_RE.test(id) || seen.has(id)) {
      let next = (type.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'node') + '-' + (graph.nodes.length + 1)
      while (seen.has(next)) next += 'x'
      issues.push({ level: 'warn', code: 'node_id_fixed', message: '节点 id 非法或重复，已改成 ' + next + '。' })
      id = next
    }
    seen.add(id)
    const sourceConfig = typeof node.config === 'object' && node.config !== null && !Array.isArray(node.config) ? node.config as Record<string, ConfigValue> : {}
    const normalizedConfig = def ? { ...sourceConfig, ...coerceConfig(def, sourceConfig) } : { ...sourceConfig }
    if (def && Object.keys(sourceConfig).some(key => JSON.stringify(sourceConfig[key]) !== JSON.stringify(normalizedConfig[key]))) issues.push({ level: 'warn', code: 'node_config_fixed', message: (node.title || def.title) + ' 的部分参数已按当前节点定义调整。', nodeId: id })
    graph.nodes.push({
      ...node,
      id,
      type,
      x: asFinite(node.x, 80 + graph.nodes.length * 40, 0, MAX_X),
      y: asFinite(node.y, 80 + graph.nodes.length * 24, 0, MAX_Y),
      config: normalizedConfig,
      ...(typeof node.title === 'string' ? { title: node.title.slice(0, 120) } : {}),
      ...(node.disabled === true ? { disabled: true } : { disabled: undefined }),
    })
  }

  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const takenInputs = new Set<string>()
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : []
  for (const item of rawEdges) {
    if (graph.edges.length >= GRAPH_LIMITS.edges) {
      issues.push({ level: 'warn', code: 'edges_truncated', message: '连线超过上限 ' + GRAPH_LIMITS.edges + ' 条，多余的已丢弃。' })
      break
    }
    const edge = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const from = (typeof edge.from === 'object' && edge.from !== null ? edge.from : {}) as Record<string, unknown>
    const to = (typeof edge.to === 'object' && edge.to !== null ? edge.to : {}) as Record<string, unknown>
    const fromNode = byId.get(asString(from.node, ''))
    const toNode = byId.get(asString(to.node, ''))
    if (fromNode === undefined || toNode === undefined) {
      issues.push({ level: 'warn', code: 'edge_dangling', message: '连线两端有节点不存在，已丢弃。' })
      continue
    }
    const fromDef = defById(fromNode.type)
    const toDef = defById(toNode.type)
    const fromPort = asString(from.port, ''), toPort = asString(to.port, '')
    if (!fromPort || !toPort) { issues.push({ level: 'warn', code: 'edge_port', message: '连线端口标识缺失，已保留并阻止运行。' }) }
    if (fromDef === undefined || toDef === undefined) { graph.edges.push({ ...edge, from: { ...from, node: fromNode.id, port: fromPort }, to: { ...to, node: toNode.id, port: toPort } }); continue }
    const outPort = fromDef.outputs.find(port => port.id === fromPort)
    const inPort = toDef.inputs.find(port => port.id === toPort)
    if (outPort === undefined || inPort === undefined) {
      issues.push({ level: 'warn', code: 'edge_port', message: '连线端口不存在，已保留并阻止运行。' })
    } else if (!portsCompatible(outPort.type, inPort.type)) issues.push({ level: 'warn', code: 'edge_type', message: TYPE_LABEL[outPort.type] + ' 接不到 ' + TYPE_LABEL[inPort.type] + '，已保留并阻止运行。' })
    const slot = toNode.id + ':' + toPort
    if (takenInputs.has(slot)) issues.push({ level: 'warn', code: 'edge_dup', message: '一个输入端口连接了多条线，已保留并阻止运行。' })
    takenInputs.add(slot)
    graph.edges.push({ ...edge, from: { ...from, node: fromNode.id, port: fromPort }, to: { ...to, node: toNode.id, port: toPort } })
  }

  return { graph, issues }
}

export function portsCompatible(from: PortType, to: PortType): boolean {
  if (from.endsWith('-config') || to.endsWith('-config')) return from === to
  return from === 'any' || to === 'any' || from === to
}

/** 连线合法性：返回 null 表示可以连，否则返回拒绝原因。 */
export function canConnect(graph: WorkflowGraph, from: { node: string; port: string }, to: { node: string; port: string }): GraphIssue | null {
  if (from.node === to.node) return { level: 'error', code: 'self_link', message: '不能连自己。' }
  const fromNode = graph.nodes.find(node => node.id === from.node)
  const toNode = graph.nodes.find(node => node.id === to.node)
  if (fromNode === undefined || toNode === undefined) return { level: 'error', code: 'node_missing', message: '节点不存在。' }
  const fromDef = defById(fromNode.type)
  const toDef = defById(toNode.type)
  if (fromDef === undefined || toDef === undefined) return { level: 'error', code: 'node_missing', message: '节点类型未知。' }
  const outPort = fromDef.outputs.find(port => port.id === from.port)
  const inPort = toDef.inputs.find(port => port.id === to.port)
  if (outPort === undefined || inPort === undefined) return { level: 'error', code: 'port_missing', message: '端口不存在。' }
  if (!portsCompatible(outPort.type, inPort.type)) {
    return { level: 'error', code: 'type_mismatch', message: TYPE_LABEL[inPort.type] + ' 只能接 ' + TYPE_LABEL[inPort.type] + '，上游是 ' + TYPE_LABEL[outPort.type] + '。' }
  }
  const occupied = graph.edges.some(edge => edge.to.node === to.node && edge.to.port === to.port)
  if (occupied) return { level: 'error', code: 'input_taken', message: '这个输入端口已经有一条线了，先删掉再用「汇总输入」并流。' }
  const pending = [to.node]
  const visited = new Set<string>()
  while (pending.length) {
    const id = pending.pop() as string
    if (id === from.node) return { level: 'error', code: 'cycle', message: '这条连线会形成环，当前流程只支持有向无环图。' }
    if (visited.has(id)) continue
    visited.add(id)
    for (const edge of graph.edges) if (edge.from.node === id) pending.push(edge.to.node)
  }
  return null
}

export function topoOrder(graph: WorkflowGraph): { order: string[]; cycle: string[] } {
  const indeg = new Map<string, number>()
  const next = new Map<string, string[]>()
  for (const node of graph.nodes) { indeg.set(node.id, 0); next.set(node.id, []) }
  for (const edge of graph.edges) {
    if (!indeg.has(edge.to.node) || !indeg.has(edge.from.node)) continue
    indeg.set(edge.to.node, (indeg.get(edge.to.node) ?? 0) + 1)
    next.get(edge.from.node)?.push(edge.to.node)
  }
  const queue = graph.nodes.filter(node => (indeg.get(node.id) ?? 0) === 0).map(node => node.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift() as string
    order.push(id)
    for (const target of next.get(id) ?? []) {
      const left = (indeg.get(target) ?? 1) - 1
      indeg.set(target, left)
      if (left === 0) queue.push(target)
    }
  }
  const cycle = graph.nodes.filter(node => !order.includes(node.id)).map(node => node.id)
  return { order, cycle }
}

/** 结构性校验：只查「这张图能不能跑」，不调模型、不读文件，所以随时可以全量跑。 */
export function validateGraph(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = []
  if (graph.version !== 1) issues.push({ level: 'error', code: 'version_unknown', message: '画布版本不受支持：' + graph.version })
  if (!PRODUCT_LINES.some(line => line.id === graph.line)) issues.push({ level: 'error', code: 'line_unknown', message: '产品线未安装：' + graph.line })
  if (graph.nodes.length === 0) {
    issues.push({ level: 'error', code: 'empty', message: '画布是空的，先拖一个输入节点进来。' })
    return issues
  }
  const checked: WorkflowGraph = { ...graph, edges: [] }
  for (const edge of graph.edges) {
    const issue = canConnect(checked, edge.from, edge.to)
    if (issue) issues.push({ ...issue, level: 'error' })
    else checked.edges.push(edge)
    if (graph.nodes.find(node => node.id === edge.from.node)?.disabled && !graph.nodes.find(node => node.id === edge.to.node)?.disabled) issues.push({ level: 'error', code: 'disabled_dependency', message: '停用节点的下游仍需要其产物，请先断开连线或停用下游。', nodeId: edge.to.node })
    const source = graph.nodes.find(node => node.id === edge.from.node)
    const sourceDef = source && defById(source.type)
    if (sourceDef && sourceDef.cat !== 'config' && sourceDef.outputs.length > 1 && source?.type !== 'check.rules') issues.push({ level: 'error', code: 'multi_output_unavailable', message: sourceDef.title + ' 的多个输出端口尚未接入独立产物，请先移除相关连线。', nodeId: source?.id })
  }
  if (new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length) issues.push({ level: 'error', code: 'duplicate_node', message: '节点标识重复。' })
  const { order, cycle } = topoOrder(graph)
  if (cycle.length > 0) {
    const names = cycle.map(id => defById(graph.nodes.find(node => node.id === id)?.type ?? '')?.title ?? id)
    issues.push({ level: 'error', code: 'cycle', message: '存在环，这些节点无法排序：' + names.join(' → ') })
  }
  const hasIncoming = new Set(graph.edges.map(edge => edge.to.node))
  const hasOutgoing = new Set(graph.edges.map(edge => edge.from.node))
  for (const node of graph.nodes) {
    const def = defById(node.type)
    if (def === undefined) { issues.push({ level: 'error', code: 'node_unknown', message: '未知节点：' + node.type, nodeId: node.id }); continue }
    if (def.lines !== undefined && !def.lines.includes(graph.line)) { issues.push({ level: 'error', code: 'node_line_mismatch', message: def.title + ' 不属于当前产品线。', nodeId: node.id }); continue }
    if (def.executor === 'unavailable' && !node.disabled) issues.push({ level: 'warn', code: 'capability_unavailable', message: def.unavailableReason ?? '当前节点不可执行。', nodeId: node.id })
    if (node.disabled) continue
    if (node.type === 'output.publish' && node.config.target !== '文件导出') issues.push({ level: 'error', code: 'output_unavailable', message: '当前仅支持文件导出，请把目标设为「文件导出」。', nodeId: node.id })
    if (node.type === 'check.rules' && node.config.rules === '引用可解析') issues.push({ level: 'error', code: 'check_unavailable', message: '引用解析检查尚未接入，请选择其他检查。', nodeId: node.id })
    if (node.type === 'check.rules' && node.config.rules === '字数达标' && (!Number.isSafeInteger(Number(node.config.expect)) || Number(node.config.expect) < 1)) issues.push({ level: 'error', code: 'check_expect_invalid', message: '字数检查需要填写大于零的整数。', nodeId: node.id })
    if (def.outputs.length > 0 && !hasOutgoing.has(node.id)) {
      issues.push({ level: 'warn', code: 'no_downstream', message: def.title + ' 的产物没有下游，跑了也没人用。', nodeId: node.id })
    }
    for (const port of def.inputs) {
      const filled = graph.edges.some(edge => edge.to.node === node.id && edge.to.port === port.id)
      if (!filled && port.optional !== true) issues.push({ level: 'error', code: 'input_missing', message: def.title + ' 的「' + port.label + '」没有接线。', nodeId: node.id })
    }
    if (def.outputs.length === 0 && !hasIncoming.has(node.id)) {
      issues.push({ level: 'warn', code: 'dead_end', message: def.title + ' 没有输入，等于空执行。', nodeId: node.id })
    }
    for (const field of def.config) {
      if (field.kind !== 'text' && field.kind !== 'textarea') continue
      const value = node.config[field.key]
      if (typeof value !== 'string' || value.trim() === '') {
        if (field.key === 'dir' || field.key === 'prompt' || field.key === 'text') {
          issues.push({ level: 'warn', code: 'config_empty', message: def.title + ' 的「' + field.label + '」还没填。', nodeId: node.id })
        }
      }
    }
    if (node.type === 'input.brief' && node.config.mustExist === true && String(node.config.text ?? '').trim() === '') {
      issues.push({ level: 'error', code: 'brief_empty', message: '需求节点标了「必须填写」，但内容是空的。', nodeId: node.id })
    }
  }
  if (!graph.nodes.some(node => hasOutgoing.has(node.id) === false && defById(node.type)?.outputs.length === 0)) {
    issues.push({ level: 'warn', code: 'no_output', message: '没有任何输出节点，产物不会落地。' })
  }
  return issues
}

/* ------------------------------------------------------------------ *
 * 执行预演（不跑模型、不写盘）
 * ------------------------------------------------------------------ */

export interface PlanInput { label: string; from: string | null; type: PortType }

export interface PlanStep {
  order: number
  nodeId: string
  type: string
  title: string
  cat: NodeCategory
  actor: Actor
  /** 这一步是确定性的还是要等模型/等人 */
  wait: 'none' | 'agent' | 'human'
  inputs: PlanInput[]
  outputs: string[]
  note: string
}

export interface Plan {
  ok: boolean
  line: ProductLineId
  name: string
  steps: PlanStep[]
  counts: { total: number; agent: number; human: number; auto: number }
  issues: GraphIssue[]
  markdown: string
}

function describeConfig(def: NodeDef, config: Record<string, ConfigValue>): string {
  const parts: string[] = []
  for (const field of def.config) {
    const value = config[field.key]
    if (value === '' || value === false) continue
    if (field.kind === 'textarea') { parts.push(field.label + '：' + String(value).slice(0, 40) + (String(value).length > 40 ? '…' : '')); continue }
    if (field.kind === 'check') { parts.push(field.label); continue }
    parts.push(field.label + '=' + String(value))
  }
  return parts.join('，')
}

export function planOf(graph: WorkflowGraph): Plan {
  const issues = validateGraph(graph)
  const { order } = topoOrder(graph)
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const steps: PlanStep[] = []
  for (const id of order) {
    const node = byId.get(id)
    if (node === undefined) continue
    const def = defById(node.type)
    if (def === undefined || def.cat === 'config' || node.disabled) continue
    const inputs: PlanInput[] = def.inputs.map(port => {
      const edge = graph.edges.find(item => item.to.node === id && item.to.port === port.id)
      const upstream = edge === undefined ? undefined : byId.get(edge.from.node)
      const upstreamDef = upstream === undefined ? undefined : defById(upstream.type)
      return { label: port.label, from: upstreamDef?.title ?? null, type: port.type }
    })
    steps.push({
      order: steps.length + 1,
      nodeId: id,
      type: def.id,
      title: node.title || def.title,
      cat: def.cat,
      actor: def.actor,
      wait: def.actor === 'human' ? 'human' : def.actor === 'agent' ? 'agent' : 'none',
      inputs,
      outputs: def.outputs.map(port => port.label + '（' + TYPE_LABEL[port.type] + '）'),
      note: [describeConfig(def, node.config), def.unavailableReason].filter(Boolean).join('；'),
    })
  }
  const counts = {
    total: steps.length,
    agent: steps.filter(step => step.actor === 'agent').length,
    human: steps.filter(step => step.actor === 'human').length,
    auto: steps.filter(step => step.actor === 'auto').length,
  }
  const plan: Plan = { ok: !issues.some(issue => issue.level === 'error'), line: graph.line, name: graph.name, steps, counts, issues, markdown: '' }
  plan.markdown = planToMarkdown(plan)
  return plan
}

export function planToMarkdown(plan: Plan): string {
  const lines: string[] = []
  lines.push('# 执行预演 · ' + plan.name)
  lines.push('')
  lines.push('- 产品线：' + lineOf(plan.line).name)
  lines.push('- 步骤：共 ' + plan.counts.total + ' 步（模型 ' + plan.counts.agent + ' / 人工 ' + plan.counts.human + ' / 程序 ' + plan.counts.auto + '）')
  lines.push('- 结论：' + (plan.ok ? '可以执行' : '不可执行（见文末问题）'))
  lines.push('')
  for (const step of plan.steps) {
    const actor = step.actor === 'agent' ? '模型' : step.actor === 'human' ? '等人工确认' : '程序'
    lines.push('## ' + step.order + '. ' + step.title + '（' + actor + '）')
    const from = step.inputs.map(item => item.label + ' ← ' + (item.from === null ? '未接' : item.from)).join('；')
    if (from !== '') lines.push('- 输入：' + from)
    if (step.outputs.length > 0) lines.push('- 产出：' + step.outputs.join('、'))
    if (step.note !== '') lines.push('- 参数：' + step.note)
    lines.push('')
  }
  if (plan.issues.length > 0) {
    lines.push('## 问题')
    for (const issue of plan.issues) lines.push('- [' + (issue.level === 'error' ? '错误' : '提示') + '] ' + issue.message)
    lines.push('')
  }
  lines.push('> 预演只算计划，不调用模型、不写任何文件。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 已注册模板
 * ------------------------------------------------------------------ */

export interface TemplateInfo { id: string; name: string; line: ProductLineId; summary: string; steps: number; revision?: number }
export const TEMPLATES: { id: string; line: ProductLineId; summary: string; graph: WorkflowGraph }[] = []

export function templateOf(id: string): WorkflowGraph | null {
  const found = TEMPLATES.find(item => item.id === id)
  return found === undefined ? null : cloneGraph(found.graph)
}

export function templateList(): TemplateInfo[] {
  return TEMPLATES.map(item => ({ id: item.id, name: item.graph.name, line: item.line, summary: item.summary, steps: item.graph.nodes.length }))
}

export function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    version: 1,
    name: graph.name,
    line: graph.line,
    ...(graph.defaults ? { defaults: { ...graph.defaults } } : {}),
    nodes: graph.nodes.map(node => ({ ...node, config: { ...node.config } })),
    edges: graph.edges.map(edge => ({ from: { node: edge.from.node, port: edge.from.port }, to: { node: edge.to.node, port: edge.to.port } })),
  }
}

/** 前端提示用：把 issues 压成一行短句。 */
export function summarizeIssues(issues: GraphIssue[]): string {
  const errors = issues.filter(issue => issue.level === 'error')
  if (errors.length > 0) return errors.length + ' 个错误：' + errors[0].message
  const warns = issues.filter(issue => issue.level === 'warn')
  if (warns.length > 0) return warns.length + ' 个提示：' + warns[0].message
  return '没有发现问题'
}
