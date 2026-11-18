import { randomUUID } from 'node:crypto'

/** Collect durable workflow sessions and advance host-owned static steps. */
export function createWorkflowScheduler({ runs, sessionEvents, advance, sessionAdapter = null, workspaceOf = () => '', intervalMs = 2500, dispatchTimeoutMs = 60000, onError = () => {} }) {
  let disposed = false
  let ticking = false
  const pending = new Set()
  const dispatches = new Map()
  const cancellations = new Set()
  const owner = randomUUID()
  // Stop waiting locally; a timed-out send can still have reached the remote session.
  const dispatchPhase = (phase, operation) => new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer)
      cancellations.delete(cancel)
      if (error) reject(error)
      else resolve(value)
    }
    const cancel = () => finish(new Error('workflow_scheduler_disposed'))
    const timer = setTimeout(() => finish(new Error(`auto_${phase}_timeout`)), dispatchTimeoutMs)
    timer.unref?.()
    cancellations.add(cancel)
    Promise.resolve().then(() => {
      if (disposed) throw new Error('workflow_scheduler_disposed')
      return operation()
    }).then(value => finish(null, value), error => finish(error))
  })
  const driveAuto = async row => {
    const runId = row.run_id
    const observed = runs.autoState(runId)
    if (!observed || observed.state !== row.state || observed.session_id !== row.session_id) return
    if (row.state === 'creating' || row.state === 'sending') {
      if (observed.lease_until && Date.parse(observed.lease_until) > Date.now()) return
      runs.autoInterrupted(runId, row.session_id); return
    }
    if (!observed.enabled || !['created', 'running'].includes(runs.state(runId).run.status)) return
    if (row.state === 'sent') {
      const generation = runs.generation(runId)
      if (!generation) runs.autoIdle(runId, row.session_id)
      return
    }
    if (row.state !== 'idle' || !sessionAdapter) return
    const state = await advance(runId)
    if (disposed || state.status !== 'needs_agent') return
    const sessionId = runs.reserveAuto(runId, owner)
    if (!sessionId) return
    const dispatch = { sessionId, sending: false }
    dispatches.set(runId, dispatch)
    let sending = false
    const heartbeat = setInterval(() => { if (!disposed) { try { runs.autoHeartbeat(runId, sessionId, owner) } catch (cause) { onError(cause) } } }, 10000)
    heartbeat.unref?.()
    try {
      const cwd = workspaceOf(runs.productId(runId))
      if (!cwd) throw new Error('workflow_workspace_missing')
      await dispatchPhase('create', () => sessionAdapter.create(sessionId, cwd))
      if (disposed) return
      if (!runs.autoStillCreating(runId, sessionId, owner)) { runs.autoCancelPreparation(runId, sessionId, owner); return }
      const config = runs.nextExecutionConfig(runId)
      const effectiveConfig = await dispatchPhase('prepare', () => sessionAdapter.prepare(sessionId, config))
      if (disposed) return
      if (!runs.autoStillCreating(runId, sessionId, owner)) { runs.autoCancelPreparation(runId, sessionId, owner); return }
      const afterSeq = sessionEvents(sessionId).reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0)
      const generation = runs.beginGeneration({ runId, sessionId, afterSeq, effectiveConfig })
      runs.autoSending(runId, sessionId, owner)
      sending = true
      dispatch.sending = true
      await dispatchPhase('send', () => sessionAdapter.send(sessionId, generation.prompt))
      if (!disposed) runs.autoSent(runId, sessionId, owner)
    } catch (cause) {
      if (sending) runs.autoInterrupted(runId, sessionId, owner)
      else if (disposed) runs.autoCancelPreparation(runId, sessionId, owner)
      else runs.autoBlocked(runId, sessionId, cause?.message ?? cause, owner)
      if (!disposed) onError(cause)
    } finally { clearInterval(heartbeat); dispatches.delete(runId) }
  }
  const tick = async () => {
    if (disposed || ticking || !runs || !sessionEvents) return
    ticking = true
    try {
      for (const generation of runs.activeGenerations()) {
        if (disposed) return
        try {
          const result = runs.collectGeneration({ runId: generation.run_id, sessionId: generation.session_id, events: sessionEvents(generation.session_id) })
          if (result.status === 'completed') await advance(generation.run_id)
        } catch (cause) { onError(cause) }
      }
      for (const revision of runs.activeRevisions()) {
        if (disposed) return
        try { runs.collectRevision({ runId: revision.run_id, id: revision.id, sessionId: revision.session_id, events: sessionEvents(revision.session_id) }) }
        catch (cause) { onError(cause) }
      }
      if (sessionAdapter && !disposed) {
        for (const row of runs.activeAutoRuns()) {
          if (pending.has(row.run_id)) continue
          pending.add(row.run_id)
          void driveAuto(row).catch(onError).finally(() => pending.delete(row.run_id))
        }
      }
    } catch (cause) { onError(cause) }
    finally { ticking = false }
  }
  const timer = setInterval(() => { void tick() }, Math.max(1000, intervalMs))
  timer.unref?.()
  return { tick, dispose() {
    disposed = true
    clearInterval(timer)
    for (const [runId, dispatch] of dispatches) {
      if (dispatch.sending) runs.autoInterrupted(runId, dispatch.sessionId, owner)
      else runs.autoCancelPreparation(runId, dispatch.sessionId, owner)
    }
    for (const cancel of cancellations) cancel()
  } }
}
