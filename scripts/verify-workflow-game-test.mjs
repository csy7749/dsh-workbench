/** Synthetic integration test: no model, browser, game tools or human playtest are executed. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { templateOf, templateList, validateGraph } from '../src/shared/workflow-catalog.ts'
import { compileGraph, createWorkflowRunner } from '../src/host/workflow-runner.mjs'
import { WorkflowCanvasStore } from '../src/host/workflow-canvas-store.ts'

const graph = templateOf('game-starlight-test')
assert(graph)
assert(templateList().some(item => item.id === 'game-cinderwatch-test'))
assert(!templateList().some(item => item.id === 'game-starlight-test'), 'legacy template stays available by ID, outside recommendations')
assert.deepEqual(validateGraph(graph).filter(issue => issue.level === 'error' || issue.code === 'capability_unavailable'), [])
assert.equal(graph.nodes.length, 14)
assert.equal(graph.nodes.filter(node => node.type === 'flow.join').length, 2)
assert.equal(graph.nodes.find(node => node.id === 'prototype-playtest').config.seconds, 20)
assert.equal(graph.nodes.find(node => node.id === 'final-playtest').config.seconds, 20)
assert.match(graph.nodes.find(node => node.id === 'brief').config.text, /每局 15 秒/)
assert.equal(compileGraph(graph).find(node => node.nodeId === 'handoff-review').contract.reviewKind, 'game-handoff-v1')
assert.equal(compileGraph(graph).find(node => node.nodeId === 'design-review').contract.reviewKind, 'game-review-v1')
const storeDb = new DatabaseSync(':memory:')
try {
  const store = new WorkflowCanvasStore(storeDb)
  const first = store.createFromTemplate('game-starlight-test', 'test-a')
  const second = store.createFromTemplate('game-starlight-test', 'test-b')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  first.graph.nodes.find(node => node.id === 'brief').config.text = 'Changed instance'
  assert.notEqual(second.graph.nodes.find(node => node.id === 'brief').config.text, 'Changed instance')
  assert.notEqual(templateOf('game-starlight-test').nodes[0].config.text, 'Changed instance')
  assert.equal(templateOf('game-product-closed-loop').nodes.length, 12)
} finally { storeDb.close() }

const root = mkdtempSync(join(tmpdir(), 'workflow-game-test-'))
const dbPath = join(root, 'run.sqlite')
const objects = join(root, 'objects')
const nativeGame = { preflight() {}, async execute({ nodeId }) { return JSON.parse(outputs[nodeId]) } }
let runner = createWorkflowRunner({ dbPath, root: objects, nativeGame })
const runId = 'synthetic-game-test'
const project = 'games/synthetic-test'
const buildId = '0123456789ab'
const finalId = 'abcdef012345'
const gdd = '# 星光采集\n\n15 秒内收集星星，生命归零失败；结算后可以重开。'
const rules = JSON.stringify({ version: 1, title: '星光采集', player: { count: 1, controls: ['左右键移动', '触屏横向拖动'] }, goal: ['存活15秒'], fail: ['生命归零'], loop: ['移动', '拾取星星', '躲避三角'], acceptance: ['拾取星星后加分', '碰撞后扣血', '结算重开后复位'], openQuestions: [] })
const playtest = id => ({ project, buildId: id, finalPhase: 'won', buildCurrent: true, errors: 0, requests: 0, runDir: 'synthetic/run', screenshots: ['synthetic/end.png'], summary: 'Synthetic fixture only. Errors: none\nScreenshots: synthetic/end.png' })
const outputs = {
  gdd, rules,
  create: JSON.stringify({ project, title: '星光采集', template: 'collector', buildId, bytes: 1024 }),
  'prototype-playtest': JSON.stringify(playtest(buildId)),
  revise: JSON.stringify({ project, title: '星光采集', buildId, changes: [], noChangesReason: 'Synthetic fixture: no code is edited.' }),
  build: JSON.stringify({ project, title: '星光采集', buildId: finalId, bytes: 2048, artifact: project + '/dist/index.html' }),
  'final-playtest': JSON.stringify(playtest(finalId)),
  package: JSON.stringify({ project, buildId: finalId, exportPath: project + '/export/game.html', bytes: 2048, offline: true }),
}
async function generate(nodeId) {
  assert.equal((await runner.advance(runId)).waiting.nodeId, nodeId)
  const generation = runner.beginGeneration({ runId, sessionId: 'synthetic-' + nodeId })
  if (nodeId === 'gdd') assert.match(generation.prompt, /Do not modify files or send messages/)
  const events = [
    { seq: 1, type: 'user/message', data: { message: { text: generation.prompt } } },
    { seq: 2, type: 'assistant/message', data: { message: { text: outputs[nodeId] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  assert.equal(runner.collectGeneration({ runId, sessionId: generation.sessionId, events }).status, 'completed')
}
function confirmInput(taskId, content) {
  const draft = runner.draft(runId, taskId)
  return { runId, taskId, content, expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision, expectedRunRevision: runner.state(runId).run.revision }
}
try {
  runner.start({ graph, runId })
  await generate('gdd')
  await generate('rules')
  const design = await runner.advance(runId)
  assert.equal(design.waiting.nodeId, 'design-review')
  assert.equal(runner.content(runId, 'create'), '')
  const designDraft = runner.draft(runId, design.waiting.taskId).draft.content
  await assert.rejects(() => runner.confirm(confirmInput(design.waiting.taskId, designDraft)), /game_approved_scope_unsupported/)
  assert.equal(runner.state(runId).run.status, 'waiting_review')
  assert.equal(runner.nativeOperations(runId).length, 0)
  const designReview = JSON.parse(designDraft)
  designReview.rules = JSON.stringify({ ...JSON.parse(designReview.rules), nativeTemplate: 'canvas-collector@1', durationSeconds: 15, hearts: 3 })
  await runner.confirm(confirmInput(design.waiting.taskId, JSON.stringify(designReview)))
  await assert.rejects(() => runner.submit({ runId, content: outputs.create }), /generation_node_required/)
  await runner.advance(runId)
  for (let count = 0; count < 200 && runner.state(runId).run.status === 'running'; count++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(runner.nativeOperations(runId).length, 6)
  assert(runner.nativeOperations(runId).every(item => item.status === 'completed'))
  const handoff = await runner.advance(runId)
  assert.equal(handoff.waiting.nodeId, 'handoff-review')
  const taskId = handoff.waiting.taskId
  const initial = JSON.parse(runner.draft(runId, taskId).draft.content)
  assert.equal(initial.kind, 'game-handoff-v1')
  assert.equal(initial.status, '未通过')
  await assert.rejects(() => runner.confirm(confirmInput(taskId, JSON.stringify(initial))), /人工试玩结论.*实际试玩分钟数.*试玩者.*已知问题/)
  const acceptance = { ...initial, status: '通过', buildId: finalId, tester: 'Synthetic test fixture', platform: 'Not a real device', playDurationMinutes: '1 分钟', observations: 'Synthetic runner fixture; no human played.', knownIssues: 'Real model, browser and human checks unassessed.', evidencePath: project + '/export/game.html' }
  await assert.rejects(() => runner.confirm(confirmInput(taskId, JSON.stringify({ ...acceptance, buildId }))), /构建 ID/)
  await assert.rejects(() => runner.confirm(confirmInput(taskId, JSON.stringify({ ...acceptance, evidencePath: 'other.html' }))), /同一份 HTML/)
  const draft = runner.draft(runId, taskId)
  runner.saveDraft({ runId, taskId, content: JSON.stringify(acceptance), expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision })
  runner.kernel.db.close()
  runner = createWorkflowRunner({ dbPath, root: objects, nativeGame })
  assert.equal(JSON.parse(runner.draft(runId, taskId).draft.content).observations, acceptance.observations)
  await runner.confirm(confirmInput(taskId, JSON.stringify(acceptance)))
  assert.equal((await runner.advance(runId)).status, 'completed')
  assert.equal(runner.attempts(runId).filter(attempt => attempt.session_id).length, 2)
  console.log('PASS synthetic starlight template: isolated copies, 14 nodes, 2 joins, scoped prompts, design gate, handoff rejection, draft recovery and completion; no real game executed')
} finally {
  runner.kernel.db.close()
  rmSync(root, { recursive: true, force: true })
}
