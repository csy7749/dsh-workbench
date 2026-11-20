/** Cross-project read model. Domain dispatches are not workflow runs until explicitly integrated. */
export interface WorkflowRunSummary {
  runId: string
  graphId: string
  graphName: string
  productId: string
  productName: string
  workspacePath: string
  projectName: string
  status: string
  pauseReason: string | null
  autoState: string | null
  autoReason: string | null
  createdAt: string
  updatedAt: string
  completedSteps: number
  totalSteps: number
  skippedSteps: number
  currentNodeId: string | null
  currentNodeTitle: string | null
  needsAttention: boolean
}

export const WORKFLOW_STATUS: Record<string, string> = {
  created: '待运行', running: '运行中', waiting_review: '等待确认', paused: '已暂停',
  completed: '已完成', failed: '失败', cancelled: '已取消',
}

export function isActiveRun(run: Pick<WorkflowRunSummary, 'status'>): boolean {
  return !['completed', 'failed', 'cancelled'].includes(run.status)
}

export function runNeedsAttention(run: Pick<WorkflowRunSummary, 'status' | 'pauseReason' | 'autoState'>): boolean {
  return run.status === 'waiting_review' || run.status === 'failed'
    || (isActiveRun(run) && (run.autoState === 'blocked' || (run.status === 'paused' && run.pauseReason !== 'user_paused')))
}

export function runPriority(run: WorkflowRunSummary): number {
  return run.needsAttention ? 0 : ['created', 'running'].includes(run.status) ? 1 : run.status === 'paused' ? 2 : 3
}

export function sortRunSummaries(runs: WorkflowRunSummary[]): WorkflowRunSummary[] {
  return [...runs].sort((a, b) => runPriority(a) - runPriority(b) || b.updatedAt.localeCompare(a.updatedAt) || b.runId.localeCompare(a.runId))
}

export function runCounts(runs: WorkflowRunSummary[]): { running: number; attention: number; active: number } {
  return {
    running: runs.filter(run => ['created', 'running'].includes(run.status)).length,
    attention: runs.filter(run => run.needsAttention).length,
    active: runs.filter(isActiveRun).length,
  }
}
