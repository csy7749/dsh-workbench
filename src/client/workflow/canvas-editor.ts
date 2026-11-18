import { canConnect, defById, portsCompatible, topoOrder, type WorkflowGraph, type CanvasNode, type GraphIssue, type PortType } from '../../shared/workflow-catalog.ts'

export const NODE_WIDTH = 248
export type Viewport = { x: number; y: number; scale: number }

export interface ConnectionTarget { node: string; port: string; label: string; type: PortType }

/** Offer only unoccupied, type-compatible inputs that do not introduce a cycle. */
export function connectionChoices(graph: WorkflowGraph, from: { node: string; port: string }, nodeId: string): { choices: ConnectionTarget[]; issue: GraphIssue | null } {
  const source = graph.nodes.find(node => node.id === from.node)
  const output = source && defById(source.type)?.outputs.find(port => port.id === from.port)
  const target = graph.nodes.find(node => node.id === nodeId)
  const inputs = target && defById(target.type)?.inputs
  if (!output || !inputs) return { choices: [], issue: { level: 'error', code: 'node_missing', message: '节点或端口不可用。' } }
  const compatible = inputs.filter(port => portsCompatible(output.type, port.type))
  if (!compatible.length) return { choices: [], issue: { level: 'error', code: 'type_mismatch', message: '该节点没有与此输出类型匹配的输入。' } }
  const results = compatible.map(port => ({ port, issue: canConnect(graph, from, { node: nodeId, port: port.id }) }))
  return {
    choices: results.filter(result => !result.issue).map(({ port }) => ({ node: nodeId, port: port.id, label: port.label, type: port.type })),
    issue: results.find(result => result.issue)?.issue ?? null,
  }
}

export function alignSelection(graph: WorkflowGraph, selection: Set<string>, axis: 'left' | 'top'): WorkflowGraph {
  const nodes = graph.nodes.filter(node => selection.has(node.id))
  if (nodes.length < 2) return graph
  const coordinate = Math.min(...nodes.map(node => axis === 'left' ? node.x : node.y))
  return { ...graph, nodes: graph.nodes.map(node => selection.has(node.id) ? { ...node, [axis === 'left' ? 'x' : 'y']: coordinate } : node) }
}

export function graphBounds(nodes: CanvasNode[], heightOf: (node: CanvasNode) => number): { left: number; top: number; right: number; bottom: number } | null {
  if (!nodes.length) return null
  return {
    left: Math.min(...nodes.map(node => node.x)),
    top: Math.min(...nodes.map(node => node.y)),
    right: Math.max(...nodes.map(node => node.x + NODE_WIDTH)),
    bottom: Math.max(...nodes.map(node => node.y + heightOf(node))),
  }
}

/** Layout and fit take rendered dimensions, so card fields cannot overlap the next row. */
export function layoutGraph(graph: WorkflowGraph, heightOf: (node: CanvasNode) => number): WorkflowGraph {
  const { order, cycle } = topoOrder(graph)
  if (cycle.length) throw new Error('图中存在环，请先断开循环连线')
  const levels = new Map<string, number>()
  const rows = new Map<number, number>()
  const positions = new Map<string, { x: number; y: number }>()
  for (const id of order) {
    const upstream = graph.edges.filter(edge => edge.to.node === id)
    const level = upstream.reduce((n, edge) => Math.max(n, (levels.get(edge.from.node) ?? 0) + 1), 0)
    levels.set(id, level)
    const y = rows.get(level) ?? 48
    positions.set(id, { x: 48 + level * (NODE_WIDTH + 100), y })
    rows.set(level, y + heightOf(graph.nodes.find(node => node.id === id)!) + 48)
  }
  return { ...graph, nodes: graph.nodes.map(node => ({ ...node, ...positions.get(node.id) })) }
}

export function fitGraph(nodes: CanvasNode[], width: number, height: number, heightOf: (node: CanvasNode) => number): Viewport {
  const bounds = graphBounds(nodes, heightOf)
  if (!bounds || width <= 0 || height <= 0) return { x: 40, y: 30, scale: 1 }
  const { left, top, right, bottom } = bounds
  const scale = Math.max(.08, Math.min(1, (width - 80) / (right - left), (height - 100) / (bottom - top)))
  return { scale, x: width / 2 - (left + right) * scale / 2, y: height / 2 - (top + bottom) * scale / 2 }
}

export function duplicateSelection(graph: WorkflowGraph, selection: Set<string>): { graph: WorkflowGraph; ids: string[] } {
  const ids = new Map(graph.nodes.filter(node => selection.has(node.id)).map(node => [node.id, 'node-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36)]))
  const nodes = graph.nodes.filter(node => ids.has(node.id)).map(node => ({ ...node, id: ids.get(node.id)!, x: node.x + 40, y: node.y + 40, config: { ...node.config } }))
  const edges = graph.edges.filter(edge => ids.has(edge.from.node) && ids.has(edge.to.node)).map(edge => ({ from: { ...edge.from, node: ids.get(edge.from.node)! }, to: { ...edge.to, node: ids.get(edge.to.node)! } }))
  return { graph: { ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] }, ids: [...ids.values()] }
}

export function historyStack<T>(limit = 60) {
  const past: T[] = [], future: T[] = []
  return {
    get canUndo() { return past.length > 0 }, get canRedo() { return future.length > 0 },
    clear() { past.length = 0; future.length = 0 },
    push(value: T) { past.push(value); if (past.length > limit) past.shift(); future.length = 0 },
    undo(current: T) { if (!past.length) return null; future.push(current); return past.pop()! },
    redo(current: T) { if (!future.length) return null; past.push(current); return future.pop()! },
  }
}
