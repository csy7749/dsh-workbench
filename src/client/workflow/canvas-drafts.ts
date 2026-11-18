import type { WorkflowGraph } from '../../shared/workflow-catalog.ts'

export interface CanvasDraft { id: string; revision: number; graph: WorkflowGraph }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const prefix = 'dsh-workflow-draft-v1:'

export function readCanvasDraft(storage: StorageLike | null, scope: string): CanvasDraft | null {
  try {
    if (!storage) return null
    const raw = storage.getItem(prefix + scope)
    if (!raw) return null
    const value = JSON.parse(raw)
    if (typeof value?.id !== 'string' || !value.id || !Number.isSafeInteger(value.revision) || value.revision < 1 || !value.graph || !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges)) return null
    return value
  } catch { return null }
}

export function writeCanvasDraft(storage: StorageLike | null, scope: string, draft: CanvasDraft | null): boolean {
  try {
    if (!storage) return false
    if (draft) storage.setItem(prefix + scope, JSON.stringify(draft))
    else storage.removeItem(prefix + scope)
    return true
  } catch { return false }
}
