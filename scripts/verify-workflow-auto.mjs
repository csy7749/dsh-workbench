import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'
import { createWorkflowScheduler } from '../src/host/workflow-scheduler.mjs'

const root = mkdtempSync(join(tmpdir(), 'workflow-auto-'))
const runner = createWorkflowRunner({ dbPath: join(root, 'db.sqlite'), root: join(root, 'objects') })
const graph = { version: 1, line: 'game', name: 'auto', nodes: [
  { id: 'brief', type: 'input.brief', x: 0, y: 0, config: { text: 'Input' } },
  { id: 'one', type: 'dsh.generate', x: 300, y: 0, config: { prompt: 'First' } },
  { id: 'two', type: 'dsh.generate', x: 600, y: 0, config: { prompt: 'Second' } },
  { id: 'human', type: 'human.review', x: 900, y: 0, config: {} },
], edges: [
  { from: { node: 'brief', port: 'out' }, to: { node: 'one', port: 'in' } },
  { from: { node: 'one', port: 'out' }, to: { node: 'two', port: 'in' } },
  { from: { node: 'two', port: 'out' }, to: { node: 'human', port: 'in' } },
] }
const eventMap = new Map()
const sessions = []
const adapter = {
  async create(id) { sessions.push(id); eventMap.set(id, []) },
  async prepare() { return { providerId: 'fake', modelId: 'fake' } },
  async send(id, prompt) { eventMap.set(id, [
    { seq: 1, type: 'user/message', data: { message: { text: prompt } } },
    { seq: 2, type: 'assistant/message', data: { message: { text: 'Generated ' + sessions.length } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]) },
}
const scheduler = createWorkflowScheduler({ runs: runner, sessionEvents: id => eventMap.get(id) ?? [], advance: id => runner.advance(id), sessionAdapter: adapter, workspaceOf: () => root })
const tick = async () => { await scheduler.tick(); await new Promise(resolve => setImmediate(resolve)) }
try {
  runner.start({ graph, runId: 'auto' })
  runner.enableAuto('auto')
  for (let i = 0; i < 10 && runner.state('auto').run.status !== 'waiting_review'; i++) await tick()
  assert.equal(runner.state('auto').run.status, 'waiting_review')
  assert.equal(sessions.length, 2)
  assert.equal(runner.content('auto', 'one'), 'Generated 1')
  assert.equal(runner.content('auto', 'two'), 'Generated 2')
  await tick()
  assert.equal(sessions.length, 2)

  runner.start({ graph, runId: 'crashed' })
  runner.enableAuto('crashed')
  const session = runner.reserveAuto('crashed')
  await tick()
  assert.equal(runner.autoState('crashed').state, 'creating')
  runner.kernel.query("UPDATE wf_auto_runs SET lease_until='2000-01-01T00:00:00.000Z' WHERE run_id='crashed'")
  await tick()
  assert.equal(runner.state('crashed').run.pause_reason, 'auto_dispatch_outcome_unknown')
  assert.equal(runner.autoState('crashed').enabled, 0)
  assert.throws(() => runner.enableAuto('crashed'), /上一次/)
  runner.autoReconcileNotSent('crashed', session)
  assert.equal(runner.autoState('crashed').state, 'idle')
  console.log('PASS host automatic dispatch through two model nodes, human stop and crash fencing')

  // Hold actual adapter boundaries open while the user changes run state.
  for (const [runId, phase, action] of [
    ['paused-create', 'create', () => runner.kernel.pauseRun('paused-create')],
    ['disabled-prepare', 'prepare', () => runner.disableAuto('disabled-prepare')],
    ['cancelled-create', 'create', () => runner.kernel.cancelRun('cancelled-create')],
    ['disposed-create', 'create', scheduler => scheduler.dispose()],
    ['disposed-prepare', 'prepare', scheduler => scheduler.dispose()],
    ['disposed-send', 'send', scheduler => scheduler.dispose()],
  ]) {
    runner.start({ graph, runId })
    runner.enableAuto(runId)
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    const calls = []
    const guarded = createWorkflowScheduler({ runs: runner, sessionEvents: () => [], advance: id => runner.advance(id), workspaceOf: () => root,
      sessionAdapter: Object.fromEntries(['create', 'prepare', 'send'].map(name => [name, async () => {
        calls.push(name)
        if (name === phase) { entered.resolve(); await release.promise }
        if (name === 'prepare') return { providerId: 'fake', modelId: 'fake' }
      }])),
    })
    try {
      await guarded.tick()
      await entered.promise
      action(guarded)
      release.resolve()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(calls.includes('send'), phase === 'send', runId)
      assert.equal(runner.generation(runId), undefined, runId)
      if (runId === 'disposed-send') {
        assert.equal(runner.autoState(runId).state, 'blocked')
        assert.equal(runner.state(runId).run.pause_reason, 'auto_dispatch_outcome_unknown')
      } else assert.equal(runner.autoState(runId).state, 'idle', runId)
    } finally { release.resolve(); guarded.dispose(); runner.disableAuto(runId) }
  }
  console.log('PASS pause, disable, cancel and disposal during async preparation prevent dispatch')

  for (const phase of ['create', 'prepare', 'send']) {
    const runId = 'timeout-' + phase
    runner.start({ graph, runId })
    runner.enableAuto(runId)
    const release = Promise.withResolvers(), error = Promise.withResolvers()
    let sends = 0
    const bounded = createWorkflowScheduler({ runs: runner, sessionEvents: () => [], advance: id => runner.advance(id), workspaceOf: () => root,
      dispatchTimeoutMs: 15, onError: cause => error.resolve(cause),
      sessionAdapter: Object.fromEntries(['create', 'prepare', 'send'].map(name => [name, async () => {
        if (name === 'send') sends++
        if (name === phase) await release.promise
        if (name === 'prepare') return { providerId: 'fake', modelId: 'fake' }
      }])),
    })
    // Keep Node alive while the production scheduler's deliberately unref'ed timer fires.
    const watchdog = setTimeout(() => error.reject(new Error('timeout test did not settle')), 2000)
    try {
      await bounded.tick()
      assert.match((await error.promise).message, new RegExp('auto_' + phase + '_timeout'))
      assert.equal(runner.autoState(runId).enabled, 0)
      assert.equal(runner.autoState(runId).state, 'blocked')
      assert.equal(runner.state(runId).run.status, 'paused')
      if (phase === 'send') {
        assert.equal(runner.state(runId).run.pause_reason, 'auto_dispatch_outcome_unknown')
        assert.throws(() => runner.enableAuto(runId), /上一次/)
        assert.throws(() => runner.kernel.resume(runId), /unknown/)
      } else assert.equal(runner.generation(runId), undefined)
      release.resolve()
      await new Promise(resolve => setImmediate(resolve))
      await bounded.tick()
      assert.equal(sends, phase === 'send' ? 1 : 0)
      assert.equal(runner.autoState(runId).state, 'blocked', 'late acknowledgement must not revive dispatch')
    } finally { clearTimeout(watchdog); release.resolve(); bounded.dispose() }
  }
  console.log('PASS bounded setup/send waits, uncertain delivery fencing and late acknowledgement isolation')
} finally {
  scheduler.dispose()
  runner.kernel.db.close()
  rmSync(root, { recursive: true, force: true })
}
