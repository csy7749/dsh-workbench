// 验证「一条完整的」工作流：画布图 → 编译 → 逐步执行 → 人工确认 → 导出。
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wf-run-'))
const dbPath = join(dir, 'workflow.sqlite')
const root = join(dir, 'content')
const runner = createWorkflowRunner({ dbPath, root, productId: 'p-test' })

const graph = {
  version: 1, id: 'graph-test', name: '游戏 v1', line: 'game',
  nodes: [
    { id: 'n1', type: 'input.brief', x: 0, y: 0, config: { text: '做一个 60 秒内通关的网页小游戏：玩家控制方块躲开下落的尖刺，吃到金币加分。' } },
    { id: 'n2', type: 'game.gdd', x: 200, y: 0, config: { tone: '简洁' } },
    { id: 'n3', type: 'check.rules', x: 400, y: 0, config: {} },
    { id: 'n4', type: 'human.review', x: 600, y: 0, config: {} },
    { id: 'n5', type: 'output.publish', x: 800, y: 0, config: { target: '文件导出', dir: 'out' } },
  ],
  edges: [
    { from: { node: 'n1', port: 'out' }, to: { node: 'n2', port: 'req' } },
    { from: { node: 'n2', port: 'gdd' }, to: { node: 'n3', port: 'in' } },
    { from: { node: 'n3', port: 'pass' }, to: { node: 'n4', port: 'in' } },
    { from: { node: 'n4', port: 'out' }, to: { node: 'n5', port: 'in' } },
  ],
}
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')) }

const started = runner.start({ graph, runId: 'run-1' })
check('编译出 5 步', started.steps.length === 5, JSON.stringify(started.steps.map(s => s.kind)))

let step = await runner.advance('run-1')
check('第一个静态节点跑完后停在生成节点', step.status === 'needs_agent' && step.waiting.nodeId === 'n2', step.status + ' / ' + (step.waiting && step.waiting.nodeId))
const brief = runner.content('run-1', 'n1')
check('input.brief 产出正文', brief.includes('方块'), brief.slice(0, 24))

const gdd = '# 游戏设计文档\n\n## 玩法\n玩家控制方块左右移动，躲开下落的尖刺，吃到金币加 1 分。\n\n## 目标\n60 秒内达到 10 分即可通关。\n\n## 失败\n碰到尖刺即结束，显示本局得分。\n'
const generation = runner.beginGeneration({ runId: 'run-1', sessionId: 'session-test' })
const generationEvents = [
  { seq: 1, type: 'user/message', data: { message: { text: generation.prompt } } },
  { seq: 2, type: 'assistant/message', data: { message: { text: gdd } } },
]
check('未结束的会话不采纳', runner.collectGeneration({ runId: 'run-1', sessionId: 'session-test', events: generationEvents }).status === 'pending' && runner.content('run-1', 'n2') === '')
generationEvents.push({ seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } })
const collected = runner.collectGeneration({ runId: 'run-1', sessionId: 'session-test', events: generationEvents })
check('完成会话按绑定尝试采纳正文', collected.status === 'completed' && runner.content('run-1', 'n2') === gdd.trim())
check('重复收取结果幂等', runner.collectGeneration({ runId: 'run-1', sessionId: 'session-test', events: generationEvents }).endSeq === 3)
step = await runner.advance('run-1')
check('生成节点提交后自动跑到人工节点', step.status === 'waiting_human' && step.waiting.nodeId === 'n4', step.status + ' / ' + (step.waiting && step.waiting.nodeId))
const checkContent = runner.content('run-1', 'n3')
check('check.rules 判定通过', JSON.parse(checkContent).ok === true, checkContent.replace(/\s+/g, ' ').slice(0, 40))

const reviewSources = runner.reviewSources('run-1', 'n4')
check('人审来源包含设计文档和校验的快照', reviewSources.some(source => source.nodeId === 'n2' && source.content === gdd.trim() && source.snapshotId) && reviewSources.some(source => source.nodeId === 'n3') && !reviewSources.some(source => source.nodeId === 'n5'))
const draft = runner.draft('run-1', step.waiting.taskId)
runner.saveDraft({ runId: 'run-1', taskId: step.waiting.taskId, content: gdd, expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision })
check('草稿回读一致', runner.draft('run-1', step.waiting.taskId).draft.content === gdd)
const reopened = createWorkflowRunner({ dbPath, root, productId: 'p-test' })
check('重开运行存储可恢复人审草稿', reopened.listForGraph('graph-test')[0]?.run_id === 'run-1' && reopened.draft('run-1', step.waiting.taskId).draft.content === gdd)
check('其他产品不可枚举本图运行', reopened.listForGraph('graph-test', 'p-other').length === 0)
let staleRejected = false
try {
  await runner.confirm({ runId: 'run-1', taskId: step.waiting.taskId, content: 'stale overwrite', expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision, expectedRunRevision: runner.state('run-1').run.revision })
} catch { staleRejected = true }
check('旧页面确认被拒绝且草稿不变', staleRejected && runner.draft('run-1', step.waiting.taskId).draft.content === gdd)
await runner.confirm({ runId: 'run-1', taskId: step.waiting.taskId, content: gdd + '\n## 人工补充\n金币每枚 +1 分，最多 10 枚。\n', intent: 'pause', expectedBindingVersion: runner.draft('run-1', step.waiting.taskId).binding.version, expectedTaskRevision: runner.draft('run-1', step.waiting.taskId).taskRevision, expectedRunRevision: runner.state('run-1').run.revision })
check('确认并暂停保留暂停意图', runner.state('run-1').run.status === 'paused')
runner.control('run-1', 'resume', runner.state('run-1').run.revision)
step = await runner.advance('run-1')
check('确认后整条运行完成', step.done === true && step.status === 'completed', step.status)

const outDir = join(dir, 'export')
const files = runner.export('run-1', outDir)
check('导出产出文件', files.length >= 3, files.join(','))
check('导出内容可读回', readFileSync(join(outDir, 'review.md'), 'utf8').includes('人工补充'), '')

runner.start({ graph, runId: 'run-product-b', productId: 'p-other' })
await runner.advance('run-product-b')
check('运行保存真实产品归属', runner.kernel.one('SELECT product_id FROM workflow_run_definitions WHERE run_id=?', 'run-product-b').product_id === 'p-other')
let crossProductRejected = false
try { runner.service.getRun({ principal: 'workflow-ui:p-test', runId: 'run-product-b' }) } catch { crossProductRejected = true }
check('产品 A 身份不能读取产品 B 运行', crossProductRejected)
const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
check('导出清单包含快照标识及哈希', manifest.files.every(file => typeof file.snapshotId === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)))
let overwriteRejected = false
try { runner.export('run-1', outDir) } catch { overwriteRejected = true }
check('已存在的导出批次不会被覆盖', overwriteRejected && readFileSync(join(outDir, 'manifest.json'), 'utf8').includes(manifest.runId))
check('导出清单保留产品归属', manifest.productId === 'p-test')
await runner.submit({ runId: 'run-product-b', content: gdd })
const reviewB = await runner.advance('run-product-b')
const oldDraftB = runner.draft('run-product-b', reviewB.waiting.taskId)
runner.control('run-product-b', 'pause', runner.state('run-product-b').run.revision)
const beforeRerun = runner.state('run-product-b')
const designStep = beforeRerun.steps.find(step => step.node_id === 'n2')
runner.rerun({ runId: 'run-product-b', nodeId: 'n2', expectedRunRevision: beforeRerun.run.revision, expectedStepRevision: designStep.revision })
check('重跑将已完成的下游校验标记失效', runner.state('run-product-b').steps.find(step => step.node_id === 'n3').stale === 1)
check('重跑保留旧设计快照正文', runner.content('run-product-b', 'n2') === gdd)
let oldReviewRejected = false
try { await runner.confirm({ runId: 'run-product-b', taskId: reviewB.waiting.taskId, content: 'old draft', expectedBindingVersion: oldDraftB.binding.version, expectedTaskRevision: oldDraftB.taskRevision, expectedRunRevision: runner.state('run-product-b').run.revision }) } catch { oldReviewRejected = true }
check('重跑后旧人审无法确认', oldReviewRejected)
runner.control('run-product-b', 'resume', runner.state('run-product-b').run.revision)
check('恢复后回到重跑节点', (await runner.advance('run-product-b')).waiting.nodeId === 'n2')
const failed = results.filter(r => !r.ok)
console.log('\n' + (failed.length === 0 ? 'ALL PASS' : 'FAILED ' + failed.length) + ' / ' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
