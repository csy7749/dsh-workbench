/** Real project files and source runner with SYNTHETIC browser reports.
 * This verifies orchestration/integrity, not rendering or real gameplay.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createNativeGameService } from '../src/host/native-game-service.mjs'
import { createWorkflowNativeGame } from '../src/host/workflow-native-game.mjs'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'
import { templateList, templateOf, validateGraph, defById } from '../src/shared/workflow-catalog.ts'
import { readNativeGameRules } from '../src/packs/game/validators.mjs'
import { CINDERWATCH_PLAYTEST_CHECKS, validateGamePlaytestEvidence } from '../src/packs/game/review.mjs'

const root = mkdtempSync(join(tmpdir(), 'cinderwatch-workflow-boundaries-'))
const workspace = join(root, 'product')
mkdirSync(workspace)
const studio = createNativeGameStudio()
const authorized = [], actions = []
const parameters = { seed: 4, biome: 'ashen', startingGold: 300, lives: 20, autoCommand: true }
const rules = { version: 1, title: 'Cinderwatch 节点验证', nativeTemplate: 'cinderwatch@1', ...parameters, creativePack: 'none', player: { count: 1, controls: ['鼠标建塔', '键盘指挥与暂停', '触屏'] }, goal: ['保护烽火台'], fail: ['生命归零'], loop: ['建塔', '击杀', '获取金币', '升级', '下一波'], acceptance: ['建塔扣金', '波次推进', '可接管和归还指挥', '失败后可重开'], openQuestions: [] }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDXkAAAAASUVORK5CYII=', 'base64')
let browserCalls = 0
const playtester = {
  async probe() { return { available: true, synthetic: true } },
  async playtest(args) {
    browserCalls++
    return studio.recordPlaytest({ ...args, report: {
      templateId: 'cinderwatch', nativeTemplate: 'cinderwatch@1', evidenceVersion: 1,
      mode: 'fixed-step-browser', simulatedSeconds: 90, playtestStatus: 'passed', finalPhase: 'play',
      errors: 0, requests: 0, inputs: { mouse: true, keyboard: true, touch: true },
      checks: Object.fromEntries(CINDERWATCH_PLAYTEST_CHECKS.map(name => [name, true])),
      observations: [{ label: 'SYNTHETIC FIXTURE', phase: 'play', gold: 325, lives: 20, wave: 2, slain: 10, towers: [], manual: false, paused: false, simulationSeconds: 90 }],
      summary: 'SYNTHETIC ORCHESTRATION FIXTURE ONLY; no browser executed. Errors: none; Screenshots: desktop.png mobile.png',
      unassessed: ['Real browser rendering, inputs and gameplay are not exercised by this script.', 'Human playtest remains unconfirmed.'],
    }, screenshots: [{ name: 'desktop.png', data: png }, { name: 'mobile.png', data: png }] })
  },
}
const service = createNativeGameService({ products: () => [{ id: 'product-fixture', workspacePath: workspace }], studio, playtester, authorize: name => authorized.push(name) })
const executeDomain = service.execute.bind(service)
service.execute = (action, args) => {
  actions.push({ action, keys: Object.keys(args) })
  for (const key of ['runId', 'nodeId', 'attemptId', 'sources', 'approved', 'workspaceIdentity']) assert.equal(key in args, false, 'workflow metadata stays outside shared tool core')
  return executeDomain(action, args)
}
const adapter = createWorkflowNativeGame({ service })
const runner = createWorkflowRunner({ dbPath: join(root, 'workflow.sqlite'), root: join(root, 'workflow'), nativeGame: adapter })
const runId = 'cinderwatch-fixture'
const base = { productId: 'product-fixture', runId, nodeId: 'create', attemptId: 'fixture-attempt', type: 'game.create', config: { template: 'cinderwatch', orientation: 'landscape' }, sources: [], signal: new AbortController().signal }
const approve = value => [{ rules: JSON.stringify(value) }]
try {
  assert(templateList().some(item => item.id === 'game-cinderwatch-test'))
  assert(!templateList().some(item => item.id === 'game-starlight-test'))
  assert.equal(templateOf('game-starlight-test').nodes.find(node => node.id === 'create').config.template, 'collector', 'legacy ID preserves its original gameplay')
  const graph = templateOf('game-cinderwatch-test')
  assert.equal(graph.nodes.length, 14)
  assert.equal(validateGraph(graph).filter(issue => issue.level === 'error').length, 0)
  assert.equal(graph.nodes.find(node => node.id === 'create').config.template, 'cinderwatch')
  assert(!defById('game.create').config.some(field => ['durationSeconds', 'hearts'].includes(field.key)))
  assert.equal(defById('game.create').config.find(field => field.key === 'template').value, 'cinderwatch')
  for (const changes of [{ seed: 0 }, { seed: 1000000 }, { startingGold: 69 }, { startingGold: 2001 }, { lives: 0 }, { lives: 101 }]) {
    await assert.rejects(() => adapter.execute({ ...base, approved: approve({ ...rules, ...changes }) }), /game_approved_rules_out_of_range/)
  }
  for (const changes of [{ nativeTemplate: 'other@1' }, { seed: '4' }, { biome: 'other' }, { autoCommand: 'true' }, { player: { count: 2 } }]) {
    await assert.rejects(() => adapter.execute({ ...base, approved: approve({ ...rules, ...changes }) }), /game_approved_scope_unsupported/)
  }
  await assert.rejects(() => adapter.execute({ ...base, approved: approve({ ...rules, creativePack: 'local-original-v1' }) }), /game_creative_pack_unsupported/)
  await assert.rejects(() => adapter.execute({ ...base, config: { template: 'collector' }, approved: approve(rules) }), /game_approved_template_mismatch/)
  assert.equal(existsSync(join(workspace, 'games')), false)
  assert.deepEqual(readNativeGameRules(JSON.stringify(rules)), rules)
  assert.equal(readNativeGameRules(JSON.stringify({ nativeTemplate: 'canvas-collector@1', durationSeconds: 15, hearts: 3 })).nativeTemplate, 'canvas-collector@1')

  runner.start({ graph, runId, productId: 'product-fixture' })
  await runner.advance(runId)
  await runner.submit({ runId, content: '# Cinderwatch\n\nFour towers, gold, waves, beacon lives and commander handover.' })
  await runner.advance(runId)
  await runner.submit({ runId, content: JSON.stringify(rules) })
  const pending = await runner.advance(runId)
  assert.equal(pending.waiting.nodeId, 'design-review')
  assert.equal(existsSync(join(workspace, 'games')), false, 'approval is required before project creation')
  const taskId = pending.waiting.taskId
  const draft = runner.draft(runId, taskId)
  const wrongApproval = { ...JSON.parse(draft.draft.content), rules: JSON.stringify({ ...rules, nativeTemplate: 'canvas-collector@1', durationSeconds: 15, hearts: 3 }) }
  await assert.rejects(() => runner.confirm({ runId, taskId, content: JSON.stringify(wrongApproval), expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision, expectedRunRevision: runner.state(runId).run.revision }), /game_approved_template_mismatch/)
  assert.equal(existsSync(join(workspace, 'games')), false, 'wrong game approval is rejected before creation')
  await runner.confirm({ runId, taskId, content: draft.draft.content, expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision, expectedRunRevision: runner.state(runId).run.revision })
  let state
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await runner.advance(runId)
    if (state.status === 'paused') assert.fail(JSON.stringify(state))
    if (state.waiting?.nodeId === 'handoff-review' && state.waiting.taskId) break
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(state.waiting?.nodeId, 'handoff-review', JSON.stringify(state))
  const get = id => JSON.parse(runner.content(runId, id))
  const created = get('create'), built = get('build'), tested = get('final-playtest'), packaged = get('package')
  const target = { workspaceRoot: workspace, productId: 'product-fixture', slug: created.slug, buildId: created.buildId }
  const actual = studio.readBuild(target)
  assert.equal(actual.template, 'cinderwatch')
  assert.deepEqual(actual.manifest.rules, parameters)
  assert.equal(actual.manifest.orientation, 'landscape')
  assert.equal(browserCalls, 2)
  assert.equal(runner.nativeOperations(runId).filter(item => item.status === 'completed').length, 6)
  assert.equal(runner.attempts(runId).filter(item => item.session_id).length, 0)
  for (const value of [created, built, tested, packaged]) {
    assert.equal(value.provider, 'workbench-native')
    assert(value.workspaceIdentity)
    assert(value.scope?.attemptId)
    assert.equal(value.projectId, created.projectId)
    assert.equal(value.buildId, created.buildId)
  }
  assert.equal(tested.finalPhase, 'play', 'endless defense need not produce collector won')
  assert(validateGamePlaytestEvidence(JSON.stringify(tested)))
  assert.equal(readFileSync(join(workspace, packaged.exportPath), 'utf8'), actual.html)
  for (const name of CINDERWATCH_PLAYTEST_CHECKS) assert.equal(validateGamePlaytestEvidence(JSON.stringify({ ...tested, checks: { ...tested.checks, [name]: false } })), false, name)
  for (const change of [{ mode: 'model-claim' }, { templateId: 'other' }, { nativeTemplate: 'other@1' }, { evidenceVersion: 0 }, { finalPhase: 'won' }, { errors: 1 }, { inputs: { mouse: true, keyboard: true, touch: false } }]) {
    assert.equal(validateGamePlaytestEvidence(JSON.stringify({ ...tested, ...change })), false)
  }
  const sources = [{ type: 'game.create', result: created }, { type: 'game.playtest', result: tested }]
  await assert.rejects(() => adapter.execute({ ...base, type: 'game.package', sources: sources.map(item => ({ ...item, result: { ...item.result, workspaceIdentity: 'different-workspace' } })) }), /game_project_scope_mismatch/)
  await assert.rejects(() => adapter.execute({ ...base, type: 'game.package', sources: [sources[0], { ...sources[1], result: { ...tested, reportHash: '0'.repeat(64) } }] }), /game_playtest_integrity_invalid/)
  const reportFile = join(workspace, tested.reportPath), reportBytes = readFileSync(reportFile)
  writeFileSync(reportFile, Buffer.concat([reportBytes, Buffer.from('\n')]))
  await assert.rejects(() => adapter.execute({ ...base, type: 'game.package', sources }), /game_playtest_integrity_invalid/)
  writeFileSync(reportFile, reportBytes)
  const handoff = runner.draft(runId, state.waiting.taskId)
  assert.equal(JSON.parse(handoff.draft.content).status, '未通过')
  await assert.rejects(() => runner.confirm({ runId, taskId: state.waiting.taskId, content: handoff.draft.content, expectedBindingVersion: handoff.binding.version, expectedTaskRevision: handoff.taskRevision, expectedRunRevision: runner.state(runId).run.revision }), /通过/)
  assert(authorized.includes('workbench_game_create') && authorized.includes('workbench_game_playtest') && authorized.includes('workbench_game_export'))
  assert(!actions.some(item => item.action === 'revision_canonical'))
  console.log('PASS Cinderwatch workflow boundaries: approved parameters, real Three.js files, shared domain actions without workflow metadata, six nodes, two SYNTHETIC reports, report tamper rejection, legacy ID compatibility and human gate still unconfirmed. Evidence: ' + root)
} finally {
  await runner.dispose()
  runner.kernel.db.close()
}
