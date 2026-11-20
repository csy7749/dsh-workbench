import type { WorkflowRunSummary } from '../../shared/workflow-run-summary.ts'

export type WorkflowDestination = { view: 'workflows' | 'wftpl' } | { view: 'run'; run: WorkflowRunSummary }
export const WORKFLOW_NAVIGATION_EVENT = 'dsh-workbench:workflow-navigation'
let pending: WorkflowDestination | null = null

/** Keep navigation until the workbench has mounted and loaded, including clicks from a chat. */
export function requestWorkflowNavigation(destination: WorkflowDestination, selectPanel?: (key: string) => void): void {
  pending = destination
  selectPanel?.('workbench')
  window.dispatchEvent(new Event(WORKFLOW_NAVIGATION_EVENT))
}

export function takeWorkflowNavigation(): WorkflowDestination | null {
  const destination = pending
  pending = null
  return destination
}
