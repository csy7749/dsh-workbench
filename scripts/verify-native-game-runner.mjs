/** Failure/recovery invariants with a controlled host adapter; no browser/model. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'
import { templateOf } from '../src/shared/workflow-catalog.ts'
import { nativeGameLinks } from '../src/shared/native-game-links.ts'

const root = mkdtempSync(join(tmpdir(), 'native-runner-invariants-'))
const rules = JSON.stringify({ version: 1, title: 'Fixture', nativeTemplate: 'canvas-collector@1', durationSeconds: 15, hearts: 3, player: { count: 1, controls: ['left', 'right'] }, goal: ['survive'], fail: ['health zero'], loop: ['move'], acceptance: ['restart'], openQuestions: [] })
const opened = []
const make = (name, nativeGame) => {
  const options = { dbPath: join(root, name + '.sqlite'), root: join(root, name), nativeGame }
  const runner = createWorkflowRunner(options)
  opened.push(runner)
  return { runner, options }
}
async function approve(runner, runId) {
  runner.start({ graph: templateOf('game-starlight-test'), runId, productId: 'product-fixture' })
  await runner.advance(runId)
  await runner.submit({ runId, content: '# Fixture design' })
  await runner.advance(runId)
  await runner.submit({ runId, content: rules })
  const review = await runner.advance(runId)
  const taskId = review.waiting.taskId
  const draft = runner.draft(runId, taskId)
  await runner.confirm({ runId, taskId, content: draft.draft.content, expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision, expectedRunRevision: runner.state(runId).run.revision })
}
function blockedAdapter() {
  const state = { calls: 0, aborted: false }
  return { state, adapter: { preflight() {}, execute({ signal }) { state.calls++; return new Promise((resolve, reject) => { signal.addEventListener('abort', () => { state.aborted = true; reject(new Error('native_cancelled')) }, { once: true }) }) } } }
}
try {
  const missing = make('missing', { preflight() { throw new Error('capability_unavailable: browser') }, execute() { assert.fail('no side effect after failed preflight') } }).runner
  await approve(missing, 'missing')
  assert.equal((await missing.advance('missing')).status, 'paused')
  assert.equal(missing.nativeOperations('missing').length, 0)
  assert.equal(missing.state('missing').steps.find(step => step.node_id === 'create').current_adoption_id, null)
  const pending = blockedAdapter()
  const cancelled = make('cancel', pending.adapter).runner
  await approve(cancelled, 'cancel')
  await Promise.all([cancelled.advance('cancel'), cancelled.advance('cancel')])
  assert.equal(pending.state.calls, 1, 'parallel continue never starts duplicate work')
  await assert.rejects(() => cancelled.submit({ runId: 'cancel', content: '{"buildId":"abcdefabcdef"}' }), /generation_node_required/)
  cancelled.control('cancel', 'cancel', cancelled.state('cancel').run.revision)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.state.aborted, true)
  assert.equal(cancelled.state('cancel').run.status, 'cancelled')
  assert.equal(cancelled.content('cancel', 'create'), '')
  const interrupted = blockedAdapter()
  const { runner: previous, options } = make('restart', interrupted.adapter)
  await approve(previous, 'restart')
  await previous.advance('restart')
  const attemptId = previous.nativeOperations('restart')[0].attempt_id
  await previous.dispose()
  previous.kernel.db.close()
  opened.splice(opened.indexOf(previous), 1)
  const restored = createWorkflowRunner(options)
  opened.push(restored)
  assert.equal(restored.state('restart').run.status, 'paused')
  assert.equal(restored.nativeOperations('restart')[0].status, 'unknown')
  await restored.advance('restart')
  assert.equal(interrupted.state.calls, 1, 'restart never replays an outcome-unknown write')
  assert.throws(() => restored.abandonNative({ runId: 'restart', attemptId, expectedRevision: 0 }), /cas_conflict/)
  restored.abandonNative({ runId: 'restart', attemptId, expectedRevision: restored.state('restart').run.revision })
  assert.equal(restored.nativeOperations('restart')[0].status, 'abandoned')
  assert.equal(restored.content('restart', 'create'), '')
  const base = '/workbench-api/game-studio/'
  const value = { provider: 'workbench-native', buildId: 'abcdefabcdef', ...Object.fromEntries([['previewUrl','preview'],['artifactUrl','artifact'],['downloadUrl','download']].map(([key, action]) => [key, base + action + '?buildId=abcdefabcdef'])) }
  assert(nativeGameLinks(JSON.stringify(value)))
  assert.equal(nativeGameLinks(JSON.stringify({ ...value, previewUrl: 'javascript:alert(1)' })), null)
  assert.equal(nativeGameLinks(JSON.stringify({ ...value, artifactUrl: '//attacker.invalid/game' })), null)
  assert.equal(nativeGameLinks(JSON.stringify({ ...value, downloadUrl: base + 'download?buildId=0123456789ab' })), null)
  console.log('PASS native runner: preflight before writes, concurrent continuation, forged evidence rejection, abort/no late adoption, restart/no replay, explicit CAS abandonment and safe UI links')
} finally {
  for (const runner of opened) { await runner.dispose(); runner.kernel.db.close() }
  rmSync(root, { recursive: true, force: true })
}
