import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { WorkflowCanvasStore } from '../src/host/workflow-canvas-store.ts'
import { validateGraph } from '../src/shared/workflow-catalog.ts'
import { templateOf, templateList } from '../src/shared/workflow-catalog.ts'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const db = new DatabaseSync(':memory:')
const store = new WorkflowCanvasStore(db)
const graph = {version:1,name:'A',line:'game',nodes:[
 {id:'brief',type:'input.brief',x:0,y:0,config:{text:'private A'}},
 {id:'generate',type:'dsh.generate',x:200,y:0,config:{prompt:'Keep process instructions'}},
 {id:'out',type:'output.publish',x:400,y:0,config:{dir:'private/path'}}
],edges:[]}
const a = store.create({graph,productId:'product-A'})
assert.equal(a.ok,true)
assert.equal(store.templatePreview(a.row.id).fields.length,2)
const v1 = store.saveTemplate(a.row.id,'Reusable')
assert.equal(v1.graph.nodes[0].config.text,'')
assert.equal(v1.graph.nodes[1].config.prompt,'Keep process instructions')
assert.equal(store.get(a.row.id).graph.nodes[0].config.text,'private A')
const b = store.createFromTemplate(v1.id,'product-B')
assert.equal(b.row.product_id,'product-B')
assert.equal(b.graph.nodes[0].config.text,'')
b.graph.nodes[0].config.text='private B'
store.save(b.row.id,{graph:b.graph,baseRevision:b.row.revision})
assert.equal(store.get(a.row.id).graph.nodes[0].config.text,'private A')
const v2 = store.saveTemplate(a.row.id,'Reusable','next',['brief.text'])
assert.equal(v2.revision,2)
const old = JSON.parse(db.prepare('SELECT graph_json FROM wf_template_versions WHERE template_id=? AND revision=1').get(v1.id).graph_json)
assert.equal(old.nodes[0].config.text,'')
assert.equal(store.get(b.row.id).graph.nodes[0].config.text,'private B')
assert.equal(db.prepare('SELECT forked_from_revision FROM wf_graphs WHERE id=?').get(b.row.id).forked_from_revision,1)
assert.equal(store.listTemplates()[0].copied_count,1)
const missingGraph = {version:2,name:'Missing pack',line:'external',futureGraph:{keep:true},nodes:[{id:'missing',type:'external.node',x:0,y:0,futureNode:{keep:true},config:{future:{value:1}}},{id:'known',type:'input.brief',x:300,y:0,config:{text:'saved',future:'keep'}}],edges:[{futureEdge:42,from:{node:'missing',port:'out',futurePort:'keep'},to:{node:'known',port:'future'}}]}
const missing = store.create({graph:missingGraph})
assert.equal(missing.ok,true)
db.prepare('UPDATE wf_graphs SET pack_version=? WHERE id=?').run('9.2.0',missing.row.id)
const reopened = store.get(missing.row.id)
assert.equal(reopened.graph.line,'external')
assert.deepEqual(reopened.graph.nodes[0].config.future,{value:1})
assert.equal(reopened.graph.nodes[1].config.future,'keep')
assert.equal(reopened.graph.edges.length,1)
assert.equal(store.save(missing.row.id,{graph:reopened.graph,baseRevision:reopened.row.revision}).ok,true)
assert.equal(store.get(missing.row.id).row.pack_version,'9.2.0')
const preserved = store.get(missing.row.id).graph
assert.equal(preserved.version,2)
assert.deepEqual(preserved.futureGraph,{keep:true})
assert.deepEqual(preserved.nodes[0].futureNode,{keep:true})
assert.equal(preserved.edges[0].futureEdge,42)
assert.equal(preserved.edges[0].from.futurePort,'keep')
assert(validateGraph(preserved).some(issue => issue.code === 'version_unknown'))
const tooMany = {...graph,nodes:Array.from({length:201},(_,i)=>({id:'node'+i,type:'input.brief',x:0,y:0,config:{text:'x'}}))}
assert.equal(store.create({graph:tooMany}).ok,false)
db.close()
console.log('PASS template redaction, immutable versions, independent copies, provenance')

const delivery = templateOf('workbench-canvas-delivery')
assert(delivery)
assert(templateList().some(item => item.id === 'workbench-canvas-delivery'))
assert.deepEqual(validateGraph(delivery).filter(issue => issue.level === 'error' || issue.code === 'capability_unavailable'), [])
const root = mkdtempSync(join(tmpdir(), 'canvas-delivery-template-'))
const runner = createWorkflowRunner({ dbPath: join(root, 'db.sqlite'), root: join(root, 'objects') })
try {
  runner.start({ graph: delivery, runId: 'delivery' })
  for (const [nodeId, content, humanId] of [
    ['plan', '实施清单：人工完成画布修改，保留已有改动。', 'plan-review'],
    ['acceptance', '验收清单：桌面操作未评估；DAG 检查未评估。', 'evidence-review'],
    ['report', '结论：桌面和 DAG 均未评估，不能宣称验收通过。', 'final-review'],
  ]) {
    assert.equal((await runner.advance('delivery')).waiting.nodeId, nodeId)
    await runner.submit({ runId: 'delivery', content })
    const waiting = await runner.advance('delivery')
    assert.equal(waiting.waiting.nodeId, humanId)
    const draft = runner.draft('delivery', waiting.waiting.taskId)
    await runner.confirm({ runId: 'delivery', taskId: waiting.waiting.taskId, content, expectedBindingVersion: draft.binding.version, expectedTaskRevision: draft.taskRevision, expectedRunRevision: runner.state('delivery').run.revision })
  }
  assert.equal((await runner.advance('delivery')).status, 'completed')
  const files = runner.export('delivery', join(root, 'export'))
  assert(files.some(file => file.endsWith('manifest.json')))
  console.log('PASS canvas delivery template runs through generated outputs, human evidence and export')
} finally {
  runner.kernel.db.close()
  rmSync(root, { recursive: true, force: true })
}
