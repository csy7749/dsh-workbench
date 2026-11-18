import { defById, type WorkflowGraph } from './workflow-canvas-model.ts'

export interface ExecutionConfig { providerId: string; modelId: string; role: string }
export const emptyExecutionConfig = (): ExecutionConfig => ({ providerId: '', modelId: '', role: '' })

/** Resolve only typed configuration edges. Business data never becomes instructions. */
export function resolveExecutionConfig(graph: WorkflowGraph, nodeId: string): ExecutionConfig {
  const result = { ...emptyExecutionConfig(), ...graph.defaults }
  const node = graph.nodes.find(item => item.id === nodeId)
  if (!node || defById(node.type)?.actor !== 'agent') return result
  const edge = graph.edges.find(item => item.to.node === nodeId && item.to.port === 'execution')
  if (!edge) return result
  const combine = graph.nodes.find(item => item.id === edge.from.node)
  if (combine?.type !== 'config.combine' || edge.from.port !== 'config') throw new Error('invalid_execution_config')
  for (const port of ['model', 'role']) {
    const input = graph.edges.find(item => item.to.node === combine.id && item.to.port === port)
    if (!input) continue
    const source = graph.nodes.find(item => item.id === input.from.node)
    if (source?.type !== 'config.' + port || input.from.port !== port) throw new Error('invalid_execution_' + port)
    for (const key of port === 'model' ? ['providerId', 'modelId'] as const : ['role'] as const) {
      const value = source.config[key]
      if (typeof value === 'string' && value.trim()) result[key] = value
    }
  }
  return result
}
