import type { WorkflowRunSummary } from '../../shared/workflow-run-summary.ts'

export interface RunMonitorSnapshot {
  runs: WorkflowRunSummary[]
  loaded: boolean
  loading: boolean
  error: string
  fetchedAt: string
}

/** One polling source for the outer sidebar, portal and hub; independent of mounted canvases. */
export function createRunMonitor(request: typeof fetch = (...args) => fetch(...args)) {
  let state: RunMonitorSnapshot = { runs: [], loaded: false, loading: false, error: '', fetchedAt: '' }
  const listeners = new Set<(snapshot: RunMonitorSnapshot) => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  let controller: AbortController | undefined
  let epoch = 0
  const emit = (): void => { for (const listener of listeners) listener(state) }
  const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  const schedule = (): void => {
    clearTimeout(timer)
    if (listeners.size) timer = setTimeout(() => { void refresh() }, visible() ? (state.runs.some(run => !['completed', 'cancelled', 'failed'].includes(run.status)) ? 4000 : 15000) : 30000)
  }
  function refresh(): Promise<void> {
    if (pending) return pending
    clearTimeout(timer)
    const generation = epoch
    const abort = new AbortController()
    controller = abort
    const timeout = setTimeout(() => abort.abort(), 10000)
    state = { ...state, loading: true }
    emit()
    pending = (async () => {
      try {
        const response = await request('/workbench-api/workflow/run-summaries', { signal: abort.signal, cache: 'no-store' })
        const data = await response.json()
        if (!response.ok || data.ok !== true || !Array.isArray(data.runs)) throw new Error(data.error || `HTTP ${response.status}`)
        if (!data.runs.every((run: any) => run
          && ['runId', 'graphName', 'productId', 'productName', 'workspacePath', 'projectName', 'status', 'updatedAt'].every(key => typeof run[key] === 'string')
          && typeof run.needsAttention === 'boolean'
          && ['completedSteps', 'totalSteps', 'skippedSteps'].every(key => Number.isFinite(run[key]) && run[key] >= 0))) throw new Error('运行摘要格式不完整')
        if (generation !== epoch) return
        state = { runs: data.runs, loaded: true, loading: false, error: '', fetchedAt: String(data.fetchedAt ?? '') }
      } catch (cause) {
        if (generation !== epoch) return
        state = { ...state, loading: false, error: `状态暂时无法更新：${String((cause as Error)?.message ?? cause)}` }
      } finally {
        clearTimeout(timeout)
        if (generation === epoch) {
          pending = undefined
          controller = undefined
          emit()
          schedule()
        }
      }
    })()
    return pending
  }
  const onVisible = (): void => { if (visible()) void refresh() }
  return {
    snapshot: (): RunMonitorSnapshot => state,
    refresh,
    subscribe(listener: (snapshot: RunMonitorSnapshot) => void): () => void {
      listeners.add(listener)
      listener(state)
      if (listeners.size === 1) {
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        epoch++
        clearTimeout(timer)
        controller?.abort()
        controller = undefined
        pending = undefined
        state = { ...state, loading: false }
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      }
    },
  }
}

export const workflowRunMonitor = createRunMonitor()
