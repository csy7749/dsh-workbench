import type { NodeDef, ProductLine, WorkflowGraph } from './workflow-canvas-model.ts'

/** Declarative vocabulary; execution, storage and IO belong to the host. */
export interface ProductPack {
  id: string
  version: string
  label: string
  namespaces?: string[]
  line?: ProductLine
  nodeDefs: NodeDef[]
  templates: { id: string; line: string; summary: string; graph: WorkflowGraph; legacy?: boolean }[]
}
