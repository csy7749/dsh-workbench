/** Read-only grouping of frozen run records; never infer ownership from array order. */
interface ExecutionConfig { providerId?: string; modelId?: string }
interface Execution { requested?: ExecutionConfig | null; effective?: ExecutionConfig | null }

export interface RunStep {
  stepId?: string
  sourceAttemptId?: string | null
  description?: string
  revision: number
  nodeId: string
  title: string
  type: string
  kind: 'human' | 'agent' | 'static'
  state: string
  stale: boolean
  content: string
  artifactFormat?: 'markdown' | 'json' | 'text'
  inputs?: { nodeId: string | null; fromPort: string | null; toPort: string | null; snapshotId: string }[]
  omittedInputs?: { nodeId: string; fromPort: string; toPort: string; reason: string; snapshotId: string | null; eventSeq: number | null }[]
}

export interface RunRevision {
  id: string
  nodeId?: string
  baseline?: { stepId?: string; taskId?: string }
  status: string
  note: string
  prompt: string
  sessionId: string
  content?: string
  reportId?: string
  reason?: string
  execution?: Execution | null
}

export interface RunAttempt {
  id: string
  step_id?: string
  node_id?: string
  attempt_no: number
  session_id?: string | null
  status: string
  outcome?: string | null
  execution?: Execution | null
}

export interface RunSessionSummary {
  id: string
  sessionId: string
  purpose: string
  status: string
  result: string
  model: string
  note?: string
  reason?: string
}

const SESSION_STATUS: Record<string, string> = {
  running: '运行中', unknown: '结果待核实', succeeded: '已完成', failed: '失败',
  cancelled: '已取消', expired: '已过期', superseded: '已被替代',
  producing: '生成中', ready: '候选已就绪', applied: '已应用到草稿',
}

function modelLabel(execution?: Execution | null): string {
  const effective = [execution?.effective?.providerId, execution?.effective?.modelId].filter(Boolean).join(' / ')
  if (effective) return '实际模型：' + effective
  const requested = [execution?.requested?.providerId, execution?.requested?.modelId].filter(Boolean).join(' / ')
  return requested ? '请求模型：' + requested + '（未确认生效）' : '模型未记录'
}

function generationSummary(attempt: RunAttempt, step?: RunStep): RunSessionSummary {
  let result = ''
  if (step?.sourceAttemptId === attempt.id) result = step.stale ? '历史产物来源 · 已失效' : '当前产物来源'
  else if (attempt.status === 'succeeded' && attempt.outcome === 'accepted') {
    result = step?.sourceAttemptId ? '已被后续产物替代' : '曾采用 · 当前来源未核实'
  } else if (['failed', 'cancelled', 'expired', 'superseded'].includes(attempt.status)) result = '未采用'
  return {
    id: 'generation:' + attempt.id, sessionId: attempt.session_id!,
    purpose: attempt.attempt_no === 1 ? '首次生成' : '第 ' + attempt.attempt_no + ' 次尝试',
    status: SESSION_STATUS[attempt.status] ?? attempt.status, result,
    model: modelLabel(attempt.execution),
    reason: attempt.outcome && attempt.outcome !== 'accepted' ? attempt.outcome : undefined,
  }
}

function revisionSummary(revision: RunRevision): RunSessionSummary {
  return {
    id: 'revision:' + revision.id, sessionId: revision.sessionId, purpose: 'AI 修订',
    status: SESSION_STATUS[revision.status] ?? revision.status,
    result: revision.status === 'applied' ? '已应用到草稿，人工确认另行记录'
      : revision.status === 'ready' ? '候选待应用' : '候选未应用',
    model: modelLabel(revision.execution), note: revision.note, reason: revision.reason,
  }
}

export function groupRunNodes(run: {
  steps: RunStep[]
  attempts?: RunAttempt[]
  revisions?: RunRevision[]
  waiting?: { nodeId: string | null; taskId: string | null; revisions?: RunRevision[] } | null
}): { nodes: { step: RunStep; sessions: RunSessionSummary[] }[]; unassigned: RunSessionSummary[] } {
  const nodes = run.steps.map(step => ({ step, sessions: [] as RunSessionSummary[] }))
  const byNode = new Map(nodes.map(node => [node.step.nodeId, node]))
  const byStep = new Map(nodes.filter(node => node.step.stepId).map(node => [node.step.stepId!, node]))
  // Historical attempts can supply a stable step-to-node binding on older hosts.
  for (const attempt of run.attempts ?? []) {
    const node = attempt.node_id ? byNode.get(attempt.node_id) : undefined
    if (node && attempt.step_id && !byStep.has(attempt.step_id)) byStep.set(attempt.step_id, node)
  }
  const unassigned: RunSessionSummary[] = []
  for (const attempt of run.attempts ?? []) {
    if (!attempt.session_id) continue
    const node = attempt.node_id ? byNode.get(attempt.node_id) : byStep.get(attempt.step_id ?? '')
    const summary = generationSummary(attempt, node?.step)
    if (node) node.sessions.push(summary)
    else unassigned.push(summary)
  }
  for (const revision of run.revisions ?? run.waiting?.revisions ?? []) {
    if (!revision.sessionId) continue
    const node = revision.nodeId ? byNode.get(revision.nodeId)
      : byStep.get(revision.baseline?.stepId ?? '')
        ?? (revision.baseline?.taskId && revision.baseline.taskId === run.waiting?.taskId
          ? byNode.get(run.waiting.nodeId ?? '') : undefined)
    const summary = revisionSummary(revision)
    if (node) node.sessions.push(summary)
    else unassigned.push(summary)
  }
  return { nodes, unassigned }
}
