/** Adapter boundary checks with real files and trusted SYNTHETIC playtest evidence.
 * No browser/gameplay or model session is executed by this test.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createWorkflowNativeGame } from '../src/host/workflow-native-game.mjs'

const root = mkdtempSync(join(tmpdir(), 'native-game-adapter-'))
const studio = createNativeGameStudio()
let probes = 0, browserRuns = 0
const authorized = []
const playtester = {
  async probe() { probes++; return { available: false, reason: 'synthetic_missing_provider' } },
  async playtest() { browserRuns++; throw new Error('browser_must_not_run_in_adapter_test') },
}
const adapter = createWorkflowNativeGame({ studio, playtester, products: () => [{ id: 'test-product', workspacePath: root }], authorize: tool => authorized.push(tool) })
const signal = new AbortController().signal
const base = { productId: 'test-product', runId: 'adapter-fixture', nodeId: 'create', attemptId: 'attempt-1', config: { template: 'collector', orientation: 'portrait' }, sources: [], approved: [], signal }
const approvedRules = { title: '适配器合成测试', nativeTemplate: 'canvas-collector@1', durationSeconds: 3, hearts: 3 }
const approved = rules => [{ rules: JSON.stringify(rules) }]
const execute = (type, changes = {}) => adapter.execute({ ...base, type, ...changes })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDXkAAAAASUVORK5CYII=', 'base64')
try {
  await assert.rejects(() => execute('game.create'), /game_approved_design_required/)
  const noTemplate = { ...approvedRules }; delete noTemplate.nativeTemplate
  for (const rules of [noTemplate, { ...approvedRules, nativeTemplate: 'voxel@1' }, { ...approvedRules, nativeTemplate: 'canvas-collector@2' }]) {
    await assert.rejects(() => execute('game.create', { approved: approved(rules) }), /game_approved_scope_unsupported/)
    assert.equal(existsSync(join(root, 'games')), false, 'unsupported approval creates no games directory')
  }
  for (const changes of [{ durationSeconds: 2 }, { durationSeconds: 61 }, { hearts: 0 }, { hearts: 10 }]) {
    await assert.rejects(() => execute('game.create', { approved: approved({ ...approvedRules, ...changes }) }), /game_approved_rules_out_of_range/)
    assert.equal(existsSync(join(root, 'games')), false, 'out-of-range approval has no project side effect')
  }
  for (const changes of [{ durationSeconds: '3' }, { durationSeconds: 3.5 }, { hearts: '3' }]) {
    await assert.rejects(() => execute('game.create', { approved: approved({ ...approvedRules, ...changes }) }), /game_approved_scope_unsupported/)
  }

  await adapter.preflight({ productId: base.productId, nodes: [{ type: 'game.playtest', disabled: true }] })
  await adapter.preflight({ productId: base.productId, nodes: [{ type: 'game.playtest', node: { disabled: true } }] })
  await adapter.preflight({ productId: base.productId, nodes: [{ type: 'game.create', config: { template: 'collector' } }] })
  assert.equal(probes, 0, 'disabled playtest nodes never probe unavailable browser')
  await assert.rejects(() => adapter.preflight({ productId: base.productId, nodes: [{ type: 'game.create', config: { template: 'voxel' } }] }), /game_template_unavailable/)
  assert.equal(probes, 0)
  await assert.rejects(() => adapter.preflight({ productId: base.productId, nodes: [{ type: 'game.playtest' }] }), /capability_unavailable: synthetic_missing_provider/)
  assert.equal(probes, 1)
  assert.equal(existsSync(join(root, 'games')), false, 'preflight is free of project side effects')

  const created = await execute('game.create', { approved: approved(approvedRules) })
  assert.equal(created.provider, 'workbench-native')
  assert.deepEqual(created.scope, { runId: base.runId, nodeId: base.nodeId, attemptId: base.attemptId })
  const target = { workspaceRoot: root, productId: base.productId, slug: created.slug, buildId: created.buildId }
  const snapshot = studio.readBuild(target)
  assert.equal(snapshot.manifest.templateId, 'canvas-collector')
  assert.equal(snapshot.manifest.templateVersion, 1)
  assert.deepEqual(snapshot.manifest.rules, { durationSeconds: 3, hearts: 3 })
  assert.equal(snapshot.manifest.title, approvedRules.title)
  assert.equal(snapshot.manifest.orientation, 'portrait')
  assert.equal(snapshot.buildCurrent, true)
  assert.equal(Buffer.byteLength(snapshot.html), created.bytes)
  assert.equal(readdirSync(join(root, 'games')).length, 1)

  // This evidence fixture tests disk binding only. It is not an assertion of gameplay.
  const report = studio.recordPlaytest({ ...target, report: { playtestStatus: 'passed', finalPhase: 'won', errors: 0, requests: 0, summary: 'SYNTHETIC ADAPTER FIXTURE ONLY\nErrors: none\nScreenshots: pending', unassessed: ['No browser or real gameplay executed.'] }, screenshots: [{ name: 'synthetic.png', data: png }] })
  const tested = { ...created, ...report }
  const sources = value => [{ type: 'game.create', result: created }, { type: 'game.playtest', result: value }]
  const noExports = () => assert.equal(existsSync(join(root, created.project, 'exports')), false, 'invalid evidence never exports')
  const bothRefuse = async (value, pattern) => {
    for (const type of ['game.revise', 'game.package']) await assert.rejects(() => execute(type, { sources: sources(value) }), pattern, type)
    noExports()
  }
  const noHash = { ...tested }; delete noHash.reportHash
  await bothRefuse(noHash, /game_playtest_identity_invalid/)
  const noPath = { ...tested }; delete noPath.reportPath
  await bothRefuse(noPath, /game_playtest_identity_invalid/)
  await bothRefuse({ ...tested, reportHash: '0'.repeat(64) }, /game_playtest_integrity_invalid/)
  const reportFile = join(root, report.reportPath)
  const originalReport = readFileSync(reportFile)
  unlinkSync(reportFile)
  await bothRefuse(tested, /ENOENT/)
  writeFileSync(reportFile, originalReport)
  writeFileSync(reportFile, Buffer.concat([originalReport, Buffer.from('\n')]))
  await bothRefuse(tested, /game_playtest_integrity_invalid/)
  writeFileSync(reportFile, originalReport)
  const screenshotFile = join(root, report.screenshots[0])
  writeFileSync(screenshotFile, Buffer.from('tampered screenshot'))
  await bothRefuse(tested, /game_playtest_integrity_invalid/)
  writeFileSync(screenshotFile, png)

  const revision = await execute('game.revise', { sources: sources(tested) })
  assert.deepEqual(revision.changes, [])
  assert(revision.noChangesReason)
  assert.equal(revision.buildId, created.buildId)
  noExports()
  const packaged = await execute('game.package', { sources: sources(tested) })
  assert.equal(packaged.buildId, created.buildId)
  assert.equal(packaged.playtestReport, report.reportPath)
  assert.equal(readFileSync(join(root, packaged.exportPath), 'utf8'), snapshot.html)
  assert.equal(browserRuns, 0)
  assert(authorized.includes('workbench_game_create') && authorized.includes('workbench_game_export'))
  console.log('PASS native game adapter: explicit supported approval/ranges, no-create rejection, disabled/enabled provider preflight, exact approved snapshot, actual report/screenshot hash reads, missing/tampered evidence rejection and synthetic-evidence revise/export; no browser executed')
} finally { rmSync(root, { recursive: true, force: true }) }
