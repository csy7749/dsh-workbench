import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { templateOf, validateGraph } from '../src/shared/workflow-catalog.ts'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionRevisions } from '../src/host/workflow-revisions.mjs'
import { gameReviewSources } from '../src/packs/game/review-sources.mjs'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'
import { GAME_CHECKS, validateGameRules } from '../src/packs/game/validators.mjs'
import { gameHandoffReviewContract } from '../src/packs/game/runtime.mjs'
const branches = [
  {nodeId:'gdd-a',type:'game.gdd',upstream:[]},
  {nodeId:'rules-a',type:'game.rules',upstream:['gdd-a']},
  {nodeId:'check-a',type:'check.rules',upstream:['rules-a']},
  {nodeId:'review-a',type:'human.review',upstream:['check-a']},
  {nodeId:'gdd-b',type:'game.gdd',upstream:[]},
  {nodeId:'rules-b',type:'game.rules',upstream:['gdd-b']},
  {nodeId:'check-b',type:'check.rules',upstream:['rules-b']},
  {nodeId:'review-b',type:'human.review',upstream:['check-b']},
]
assert.deepEqual(gameReviewSources(branches, 'review-a'), {brief:undefined,gdd:'gdd-a',rules:'rules-a',report:'check-a'})
assert.deepEqual(gameReviewSources(branches, 'review-b'), {brief:undefined,gdd:'gdd-b',rules:'rules-b',report:'check-b'})
const rules = {version:1,title:'避障',player:{count:1,controls:['左右移动']},goal:['得分10'],fail:['碰撞'],loop:['移动并躲避'],acceptance:['碰撞后停止计分'],openQuestions:[]}
const valid = v => validateGameRules(JSON.stringify(v)).filter(c => c.required).every(c => c.verdict === 'pass')
assert(valid(rules))
assert(!valid({...rules,version:2}))
assert(!valid({...rules,goal:[]}))
assert(!valid({...rules,acceptance:['TBD']}))
assert(valid({...rules,openQuestions:['待定：是否加入音效？']}))
assert.equal(validateGameRules(JSON.stringify(rules)).at(-1).verdict,'not_assessed')
const dir=mkdtempSync(join(tmpdir(),'workflow-game-'))
const runner=createWorkflowRunner({dbPath:join(dir,'run.sqlite'),root:join(dir,'objects')})
const graph={version:1,name:'checks',line:'game',nodes:[{id:'brief',type:'input.brief',config:{text:'设计稿'}},{id:'gdd',type:'game.gdd',config:{}},{id:'rules',type:'game.rules',config:{}}],edges:[{from:{node:'brief',port:'out'},to:{node:'gdd',port:'req'}},{from:{node:'gdd',port:'gdd'},to:{node:'rules',port:'in'}}]}
runner.start({graph,runId:'invalid'})
await runner.advance('invalid')
await runner.submit({runId:'invalid',content:'# 设计稿'})
await runner.advance('invalid')
const generation = runner.beginGeneration({runId:'invalid',sessionId:'invalid-rules-session'})
const events = [{seq:1,type:'user/message',data:{message:{text:generation.prompt}}},{seq:2,type:'assistant/message',data:{message:{text:JSON.stringify({...rules,goal:[]})}}},{seq:3,type:'turn/end',data:{reason:{kind:'completed'}}}]
const rejected=runner.collectGeneration({runId:'invalid',sessionId:generation.sessionId,events})
assert.equal(rejected.reason,'generation_validation_failed')
assert.equal(rejected.endSeq,3)
assert.equal(JSON.parse(rejected.content).goal.length,0)
assert.deepEqual(runner.collectGeneration({runId:'invalid',sessionId:generation.sessionId,events}),rejected)
assert.equal(rejected.status,'failed')
assert.equal(runner.content('invalid','rules'),'')
assert(runner.kernel.listValidations('invalid').length > 0)
runner.start({graph,runId:'valid'})
await runner.advance('valid')
await runner.submit({runId:'valid',content:'# 设计稿'})
await runner.advance('valid')
await runner.submit({runId:'valid',content:JSON.stringify(rules)})
assert.equal(JSON.parse(runner.content('valid','rules')).title,rules.title)
assert.deepEqual(runner.compiled('valid')[2].step.requiredChecks,GAME_CHECKS)
const template = templateOf('game-gdd-to-playtest')
assert.equal(template.nodes.length, 6)
const productTemplate = templateOf('game-product-closed-loop')
assert(productTemplate)
assert.deepEqual(validateGraph(productTemplate).filter(issue => issue.level === 'error' || issue.code === 'capability_unavailable'), [])
assert.equal(productTemplate.nodes.length, 12)
assert.deepEqual(productTemplate.nodes.map(node => node.type), [
  'input.brief', 'game.gdd', 'game.rules', 'check.rules', 'human.review', 'game.create',
  'game.playtest', 'game.revise', 'game.build', 'game.playtest', 'game.package', 'game.handoff-review',
])
const handoffCompiled = [
  { nodeId: 'build', type: 'game.build', upstream: ['revise'] },
  { nodeId: 'test', type: 'game.playtest', upstream: ['build'] },
  { nodeId: 'package', type: 'game.package', upstream: ['test'] },
  { nodeId: 'handoff', type: 'game.handoff-review', upstream: ['package'] },
]
const handoffData = {
  build: { project: 'games/sample', title: 'Sample', buildId: '0123456789ab' },
  test: { project: 'games/sample', buildId: '0123456789ab', finalPhase: 'won', buildCurrent: true, errors: 0, requests: 0, runDir: 'runs/1', screenshots: ['runs/1/final.png'], summary: 'Errors: none\nScreenshots: runs/1/final.png' },
  package: { project: 'games/sample', buildId: '0123456789ab', exportPath: 'games/sample/dist/game.html', bytes: 100, offline: true },
}
const handoffContent = {
  kind: 'game-handoff-v1', version: 1, status: '通过', buildId: '0123456789ab', tester: 'tester',
  platform: 'Windows Chrome', playDurationMinutes: '5', observations: '完成一局', knownIssues: '无', evidencePath: 'games/sample/dist/game.html',
}
const getHandoffContent = nodeId => JSON.stringify(handoffData[nodeId] ?? handoffContent)
assert.equal(gameHandoffReviewContract.validate(JSON.stringify(handoffContent), handoffCompiled, 'handoff', getHandoffContent), null)
handoffData.test.buildId = 'abcdefabcdef'
assert.match(gameHandoffReviewContract.validate(JSON.stringify(handoffContent), handoffCompiled, 'handoff', getHandoffContent), /构建 ID/)
handoffData.test.buildId = '0123456789ab'
handoffData.package.exportPath = 'games/other/dist/game.html'
assert.match(gameHandoffReviewContract.validate(JSON.stringify(handoffContent), handoffCompiled, 'handoff', getHandoffContent), /同一份 HTML/)
handoffData.package.exportPath = 'games/sample/dist/game.html'
handoffData.test.errors = 1
assert.match(gameHandoffReviewContract.validate(JSON.stringify(handoffContent), handoffCompiled, 'handoff', getHandoffContent), /没有通过完整自动试玩/)
template.nodes.find(node => node.type === 'input.brief').config.text = '制作左右移动避障游戏'
runner.start({ graph: template, runId: 'six-step' })
assert.equal((await runner.advance('six-step')).waiting.nodeId, 'gdd')
await runner.submit({ runId: 'six-step', content: '# 避障设计稿' })
assert.equal((await runner.advance('six-step')).waiting.nodeId, 'rules')
await runner.submit({ runId: 'six-step', content: JSON.stringify(rules) })
const review = await runner.advance('six-step')
assert.equal(review.status, 'waiting_human')
const sources = runner.reviewSources('six-step', 'review')
assert(sources.some(source => source.type === 'game.gdd'))
assert(sources.some(source => source.type === 'game.rules' && JSON.parse(source.content).version === 1))
assert.equal(JSON.parse(runner.content('six-step', 'check')).ok, true)
const draft = runner.draft('six-step', review.waiting.taskId)
assert.equal(JSON.parse(draft.draft.content).kind, 'game-review-v1')
const revisions = createSessionRevisions(runner.kernel)
const candidate = revisions.begin({runId:'six-step',taskId:review.waiting.taskId,expectedBindingVersion:draft.binding.version,expectedTaskRevision:draft.taskRevision,note:'精简设计稿',sessionId:'review-session'})
const candidateText = JSON.stringify({kind:'game-review-v1',gdd:'# 候选设计稿',rules:JSON.stringify(rules)})
const revisionEvents = [{seq:1,type:'user/message',data:{message:{text:candidate.prompt}}},{seq:2,type:'assistant/message',data:{message:{text:candidateText}}},{seq:3,type:'turn/end',data:{reason:{kind:'completed'}}}]
assert.equal(revisions.collect({runId:'six-step',id:candidate.id,events:revisionEvents.slice(0,2)}).status,'producing')
assert.equal(revisions.collect({runId:'six-step',id:candidate.id,events:revisionEvents}).status,'ready')
assert.equal(runner.draft('six-step',review.waiting.taskId).draft.content,draft.draft.content)
assert.equal(createSessionRevisions(runner.kernel).list('six-step')[0].status,'ready')
assert.equal(runner.revisions('six-step')[0].nodeId, 'review', 'revision history resolves its owning review node')
revisions.apply({runId:'six-step',id:candidate.id})
assert.equal(JSON.parse(runner.draft('six-step',review.waiting.taskId).draft.content).gdd,'# 候选设计稿')
const changedDraft = runner.draft('six-step',review.waiting.taskId)
assert.throws(() => runner.saveDraft({runId:'six-step',taskId:review.waiting.taskId,content:draft.draft.content,expectedBindingVersion:draft.binding.version,expectedTaskRevision:draft.taskRevision}), /cas_conflict/)
assert.equal(runner.content('six-step', 'review'), '')
await assert.rejects(() => runner.confirm({ runId: 'six-step', taskId: review.waiting.taskId, content: changedDraft.draft.content, expectedBindingVersion: changedDraft.binding.version, expectedTaskRevision: changedDraft.taskRevision, expectedRunRevision: runner.state('six-step').run.revision }), /设计稿已修改/)
assert.equal(revisions.apply({runId:'six-step',id:candidate.id}).status,'applied')
runner.reviseDesign({ runId: 'six-step', taskId: review.waiting.taskId, content: changedDraft.draft.content, expectedBindingVersion: changedDraft.binding.version, expectedTaskRevision: changedDraft.taskRevision, expectedRunRevision: runner.state('six-step').run.revision })
assert.equal(runner.content('six-step', 'gdd'), '# 候选设计稿')
assert.equal(runner.state('six-step').steps.find(step => step.node_id === 'rules').stale, 1)
assert.equal((await runner.advance('six-step')).waiting.nodeId, 'rules')
await runner.submit({ runId: 'six-step', content: JSON.stringify(rules) })
const newReview = await runner.advance('six-step')
const newDraft = runner.draft('six-step', newReview.waiting.taskId)
await runner.confirm({ runId: 'six-step', taskId: newReview.waiting.taskId, content: newDraft.draft.content, expectedBindingVersion: newDraft.binding.version, expectedTaskRevision: newDraft.taskRevision, expectedRunRevision: runner.state('six-step').run.revision })
assert.equal((await runner.advance('six-step')).status, 'completed')
assert.equal(runner.revisions('six-step')[0].nodeId, 'review', 'revision ownership survives task completion')
const output = join(dir, 'six-step-export')
const files = runner.export('six-step', output)
assert.deepEqual(files.sort(), ['brief.txt', 'gdd.md', 'rules.json', 'report.md', 'manifest.json'].sort())
assert.deepEqual(JSON.parse(readFileSync(join(output, 'rules.json'), 'utf8')), rules)
assert.equal(readFileSync(join(output, 'gdd.md'), 'utf8'), '# 候选设计稿')
assert.equal(runner.content('six-step', 'gdd'), '# 候选设计稿')
const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
assert.equal(manifest.files.find(f => f.path === 'gdd.md').snapshotId, manifest.files.find(f => f.path === 'rules.json').snapshotId)
assert.deepEqual(manifest.openQuestions, rules.openQuestions)
assert.match(manifest.definitionHash, /^[a-f0-9]{64}$/)
assert.equal(manifest.files.find(f => f.path === 'gdd.md').transform, 'extract_review_gdd')
assert.equal(manifest.files.find(f => f.path === 'report.md').transform, 'validate_review_rules')
for (const file of manifest.files) {
  const bytes = readFileSync(join(output, file.path))
  assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(file.bytes, bytes.length)
}
const multi = { ...template, name: 'two independent reviews', nodes: [], edges: [] }
for (const suffix of ['a', 'b']) {
  multi.nodes.push(...template.nodes.map(node => ({ ...node, id: node.id + '-' + suffix, config: { ...node.config, ...(node.id === 'brief' ? { text: 'Brief ' + suffix } : {}) } })))
  multi.edges.push(...template.edges.map(edge => ({ from: { ...edge.from, node: edge.from.node + '-' + suffix }, to: { ...edge.to, node: edge.to.node + '-' + suffix } })))
}
runner.start({ graph: multi, runId: 'multi-review' })
for (const suffix of ['a', 'b']) {
  assert.equal((await runner.advance('multi-review')).waiting.nodeId, 'gdd-' + suffix)
  await runner.submit({ runId: 'multi-review', content: '# Design ' + suffix })
  await runner.advance('multi-review')
  await runner.submit({ runId: 'multi-review', content: JSON.stringify({ ...rules, title: 'Rules ' + suffix }) })
  const waiting = await runner.advance('multi-review')
  assert.equal(waiting.waiting.nodeId, 'review-' + suffix)
  const item = runner.draft('multi-review', waiting.waiting.taskId)
  await runner.confirm({ runId: 'multi-review', taskId: waiting.waiting.taskId, content: item.draft.content, expectedBindingVersion: item.binding.version, expectedTaskRevision: item.taskRevision, expectedRunRevision: runner.state('multi-review').run.revision })
}
assert.equal((await runner.advance('multi-review')).status, 'completed')
const multiDir = join(dir, 'multi-review-export')
const multiFiles = runner.export('multi-review', multiDir)
assert.equal(multiFiles.length, 9)
const multiManifest = JSON.parse(readFileSync(join(multiDir, 'manifest.json'), 'utf8'))
assert.deepEqual(new Set(multiManifest.files.map(file => file.exportGroup)), new Set(['review-a', 'review-b']))
assert.equal(JSON.parse(readFileSync(join(multiDir, 'review-1-rules.json'), 'utf8')).title, 'Rules a')
assert.equal(JSON.parse(readFileSync(join(multiDir, 'review-2-rules.json'), 'utf8')).title, 'Rules b')
console.log('PASS game validation and six-node template: generation, checks, review sources, confirmation, export hashes')
