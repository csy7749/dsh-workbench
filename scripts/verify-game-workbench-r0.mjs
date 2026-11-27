/** R0 integrity regressions against a fresh host bundle and temporary databases.
 * No provider calls, production database, migration or desktop acceptance. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'tsdown'
import { createWorkflowRunner } from '../src/host/workflow-runner.mjs'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const root = fs.mkdtempSync(join(tmpdir(), 'dsh-workbench-r0-'))
const bundleRoot = fs.mkdtempSync(join(repository, '.tmp-r0-bundle-'))
const workspace = join(root, 'workspace')
fs.mkdirSync(workspace)
process.env.DSH_HOME = root
process.env.DSH_WORKBENCH_DB = join(root, 'workbench.sqlite')
process.env.DSH_WORKBENCH_WORKFLOW_PAGE = '0'
const routes = [], disposers = [], tools = new Map()
let database, runner, reopened
const originalWrite = fs.writeFileSync, originalRename = fs.renameSync
try {
  await build({ config: false, cwd: repository, entry: { index: 'src/host/index.ts' }, outDir: bundleRoot, format: 'esm', platform: 'node', dts: false, sourcemap: false, clean: false, outputOptions: { entryFileNames: 'index.js' } })
  const { apply } = await import(pathToFileURL(join(bundleRoot, 'index.js')).href)
  apply({
    tools: { register(tool) { tools.set(tool.name, tool) } },
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
    on() { return () => {} },
  })
  const route = routes.find(item => item.path === '/workbench-api')
  assert.ok(route, 'public workbench route registered')
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const request = { method, url: '/workbench-api' + path, json: async () => body ?? {} }
    const response = { status: 0, writeHead(status) { this.status = status }, end(text) { resolve({ status: this.status, body: text ? JSON.parse(text) : null }) } }
    try { route.handler(request, response) } catch (error) { reject(error) }
  })
  const request = async (method, path, body, expected = 200) => {
    const result = await call(method, path, body)
    assert.equal(result.status, expected, JSON.stringify(result.body))
    return result.body
  }
  database = new DatabaseSync(process.env.DSH_WORKBENCH_DB)
  const notebook = (await request('POST', '/notebooks', { name: 'R0 设计资料', workspacePath: workspace })).notebook
  const base = { notebookId: notebook.id, productId: 'product-r0', kind: 'product_design', moduleId: '', mapId: 'map-r0', nodeId: 'node-r0' }
  const main = (await request('POST', '/notes', { ...base, title: '产品设计', content: '正文第一版' })).note
  const report = (await request('POST', '/notes', { ...base, title: '产品交叉校验', content: '报告第一版', docKey: 'pdr:product-r0' })).note
  assert.notEqual(main.id, report.id)
  assert.equal(main.docKey, 'pd:product-r0')
  const reportAgain = (await request('POST', '/notes', { ...base, title: report.title, content: '报告第二版', docKey: report.docKey })).note
  assert.equal(reportAgain.id, report.id)
  assert.equal(reportAgain.filePath, report.filePath, 'idempotent saves retain the real note ID in the mirror filename')
  assert.equal(database.prepare('SELECT content FROM notes WHERE id=?').get(main.id).content, main.content, 'report regeneration never replaces the main document')
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM notes WHERE doc_key IN (?,?)').get(main.docKey, report.docKey).n, 2)
  const product = (await request('POST', '/products', { name: 'R0 工具合同', workspacePath: workspace })).product
  const publish = tools.get('workbench_product_note_publish')
  assert.ok(publish.parameters.properties.kind.enum.includes('product_design'))
  assert.equal(publish.parameters.properties.docKey.type, 'string')
  const publishArgs = { productId: product.id, kind: 'product_design', title: '工具写正文', content: '独立正文' }
  const toolMain = await publish.execute(publishArgs)
  const toolReport = await publish.execute({ ...publishArgs, title: '工具写报告', content: '独立报告', docKey: 'pdr:' + product.id })
  const toolReportAgain = await publish.execute({ ...publishArgs, title: '工具写报告', content: '独立报告重跑', docKey: 'pdr:' + product.id })
  assert.equal(toolMain.ok, true); assert.equal(toolReport.ok, true); assert.equal(toolReportAgain.ok, true)
  assert.notEqual(toolMain.note.id, toolReport.note.id)
  assert.equal(toolReportAgain.note.id, toolReport.note.id)
  assert.equal(database.prepare('SELECT content FROM notes WHERE id=?').get(toolMain.note.id).content, '独立正文')
  const identityFields = ['mapId', 'kind', 'nodeId', 'moduleId', 'docKey']
  for (const before of [main, reportAgain]) {
    const manual = (await request('POST', '/notes', { id: before.id, notebookId: before.notebookId, title: before.title, content: before.content, tags: before.tags, pinned: before.pinned })).note
    for (const key of identityFields) assert.equal(manual[key], before[key], 'manual saves preserve ' + key)
    assert.equal(manual.content, before.content)
  }
  const reportByKey = (await request('POST', '/notes', { notebookId: notebook.id, title: reportAgain.title, content: reportAgain.content, docKey: reportAgain.docKey })).note
  for (const key of identityFields) assert.equal(reportByKey[key], reportAgain[key], 'key-based updates inherit omitted ' + key)
  const linked = (await request('POST', '/notes', { ...base, moduleId: 'module-r0', title: '链接身份保留', content: '保持这段正文' })).note
  const manualLinked = { id: linked.id, notebookId: notebook.id, title: linked.title, content: linked.content }
  const retained = (await request('POST', '/notes', manualLinked)).note
  for (const key of identityFields) assert.equal(retained[key], linked[key], 'nonempty linked metadata survives ' + key)
  const cleared = (await request('POST', '/notes', { ...manualLinked, ...Object.fromEntries(identityFields.map(key => [key, ''])) })).note
  for (const key of identityFields) assert.equal(cleared[key], '', 'explicit empty clears ' + key)
  const keptClear = (await request('POST', '/notes', manualLinked)).note
  for (const key of identityFields) assert.equal(keptClear[key], '', 'later omitted fields keep explicitly cleared ' + key)
  assert.equal(keptClear.content, linked.content)
  console.log('PASS R0 document identity: independent main/report keys, idempotency and stable mirror identity')

  const originalRow = database.prepare('SELECT * FROM notes WHERE id=?').get(main.id)
  const originalBytes = fs.readFileSync(main.filePath)
  const blocker = join(root, 'not-a-directory'); fs.writeFileSync(blocker, 'blocker')
  await request('POST', '/notebooks', { id: notebook.id, name: notebook.name, workspacePath: blocker })
  await request('POST', '/notes', { ...base, id: main.id, title: '改名不能丢旧文件', content: '不应保存' }, 400)
  await request('POST', '/notes', { ...base, id: 'failed-new-note', title: '新建失败', content: '不应落库', docKey: 'pdr:failed-new' }, 400)
  assert.deepEqual(database.prepare('SELECT * FROM notes WHERE id=?').get(main.id), originalRow)
  assert.equal(database.prepare('SELECT id FROM notes WHERE id=?').get('failed-new-note'), undefined)
  assert.deepEqual(fs.readFileSync(main.filePath), originalBytes)
  await request('POST', '/notebooks', { id: notebook.id, name: notebook.name, workspacePath: workspace })
  for (const failure of ['write', 'rename']) {
    let injected = false
    if (failure === 'write') fs.writeFileSync = (path, ...args) => {
      if (typeof path === 'string' && path.startsWith(main.filePath + '.tmp-')) { injected = true; originalWrite(path, 'partial temporary bytes'); throw new Error('fixture_partial_mirror_write') }
      return originalWrite(path, ...args)
    }
    else fs.renameSync = (from, to) => {
      if (to === main.filePath) { injected = true; throw new Error('fixture_mirror_publish_failure') }
      return originalRename(from, to)
    }
    syncBuiltinESMExports()
    try { await request('POST', '/notes', { ...base, id: main.id, title: main.title, content: '失败的替换' }, 400) }
    finally { fs.writeFileSync = originalWrite; fs.renameSync = originalRename; syncBuiltinESMExports() }
    assert.equal(injected, true)
    assert.deepEqual(database.prepare('SELECT * FROM notes WHERE id=?').get(main.id), originalRow)
    assert.deepEqual(fs.readFileSync(main.filePath), originalBytes)
    assert.equal(fs.readdirSync(dirname(main.filePath)).some(name => name.includes('.tmp-')), false)
  }
  console.log('PASS R0 mirror failure: missing directory, partial write and rename failure preserve database and previous bytes')

  const delta = await request('GET', '/sync/delta?since=0&entity=notes&limit=1000')
  const transmitted = delta.changes.find(item => item.id === report.id).row
  for (const key of ['kind', 'nodeId', 'moduleId', 'docKey']) assert.equal(transmitted[key], reportAgain[key], 'delta retains ' + key)
  const incoming = { ...transmitted, id: 'synced-design-note', nodeId: 'synced-node', moduleId: 'synced-module', docKey: 'pdr:synced-product' }
  await request('POST', '/sync/push', { changes: [{ entity: 'notes', id: incoming.id, op: 'upsert', updatedAt: '2099-01-01 00:00:00', row: incoming }] })
  await request('POST', '/sync/push', { changes: [{ entity: 'notes', id: incoming.id, op: 'upsert', updatedAt: '2099-01-01 00:00:01', row: { title: '旧客户端只改标题' } }] })
  const roundtrip = (await request('GET', '/sync/delta?since=0&entity=notes&limit=1000')).changes.find(item => item.id === incoming.id).row
  for (const key of ['kind', 'nodeId', 'moduleId', 'docKey']) assert.equal(roundtrip[key], incoming[key], 'push and partial updates preserve ' + key)
  assert.equal(roundtrip.title, '旧客户端只改标题')
  console.log('PASS R0 note sync: all four document identity fields survive delta, push and metadata-free partial edits')

  const fallback = spawnSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import { join } from 'node:path';
    const routes=[], disposers=[], tools=new Map();
    const { apply }=await import(process.env.R0_HOST_BUNDLE);
    apply({tools:{register(t){tools.set(t.name,t)}},webServer:{register(r){routes.push(r);return()=>{}}},effect(fn){const d=fn();if(typeof d==='function')disposers.push(d)},on(){return()=>{}}});
    const route=routes.find(r=>r.path==='/workbench-api');
    const call=(method,path,body)=>new Promise(resolve=>route.handler({method,url:'/workbench-api'+path,json:async()=>body},{writeHead(s){this.s=s},end(text){resolve({status:this.s,body:JSON.parse(text)})}}));
    try {
      const workspace=join(process.env.DSH_HOME,'workspace');fs.mkdirSync(workspace,{recursive:true});
      const product=(await call('POST','/products',{name:'JSON identity',workspacePath:workspace})).body.product;
      const publish=tools.get('workbench_product_note_publish');
      const args={productId:product.id,kind:'product_design',title:'JSON main',content:'main'};
      const main=await publish.execute(args), report=await publish.execute({...args,title:'JSON report',content:'report',docKey:'pdr:'+product.id});
      const again=await publish.execute({...args,title:'JSON report',content:'report two',docKey:'pdr:'+product.id});
      assert.equal(main.ok,true);assert.equal(report.ok,true);assert.equal(again.ok,true);
      assert.notEqual(main.note.id,report.note.id);assert.equal(report.note.id,again.note.id);
      assert.equal(report.note.filePath,again.note.filePath);assert.ok(main.note.filePath);
      for(const before of [main.note,again.note]){
        const saved=(await call('POST','/notes',{id:before.id,notebookId:before.notebookId,title:before.title,content:before.content})).body.note;
        for(const key of ['mapId','kind','nodeId','moduleId','docKey'])assert.equal(saved[key],before[key]);
      }
      const linked=(await call('POST','/notes',{notebookId:product.notebookId,title:'linked',content:'unchanged',kind:'module_design',mapId:'json-map',nodeId:'json-node',moduleId:'json-module'})).body.note;
      const plain={id:linked.id,notebookId:product.notebookId,title:linked.title,content:linked.content};
      const retained=(await call('POST','/notes',plain)).body.note;
      for(const key of ['mapId','kind','nodeId','moduleId','docKey'])assert.equal(retained[key],linked[key]);
      const cleared=(await call('POST','/notes',{...plain,mapId:'',kind:'',nodeId:'',moduleId:'',docKey:''})).body.note;
      for(const key of ['mapId','kind','nodeId','moduleId','docKey'])assert.equal(cleared[key],'');
      const keptClear=(await call('POST','/notes',plain)).body.note;
      for(const key of ['mapId','kind','nodeId','moduleId','docKey'])assert.equal(keptClear[key],'');
      assert.equal(keptClear.content,linked.content);
      const before=fs.readFileSync(main.note.filePath);const blocker=join(process.env.DSH_HOME,'blocker');fs.writeFileSync(blocker,'blocker');
      await call('POST','/notebooks',{id:product.notebookId,name:'blocked',workspacePath:blocker});
      assert.equal((await call('POST','/notes',{...args,id:main.note.id,notebookId:product.notebookId,content:'must fail'})).status,400);
      const notes=(await call('GET','/notes')).body.notes;
      assert.equal(notes.find(n=>n.id===main.note.id).content,'main');assert.deepEqual(fs.readFileSync(main.note.filePath),before);
    } finally { for(const dispose of disposers.reverse())await dispose() }
  `], { env: { ...process.env, DSH_HOME: join(root, 'json'), DSH_WORKBENCH_DB: join(root, 'json', 'workbench.sqlite'), R0_HOST_BUNDLE: pathToFileURL(join(bundleRoot, 'index.js')).href }, encoding: 'utf8', timeout: 20000 })
  assert.ifError(fallback.error)
  assert.equal(fallback.status, 0, fallback.stderr + '\n' + fallback.stdout)
  console.log('PASS R0 JSON fallback: actual no-SQLite host retains independent document keys, mirrors and old data on write failure')

  const dbPath = join(root, 'workflow.sqlite'), contentRoot = join(root, 'workflow-content')
  runner = createWorkflowRunner({ dbPath, root: contentRoot, productId: 'product-r0' })
  const graph = { version: 1, id: 'r0-graph', name: 'R0 原子启动', line: 'game', nodes: [{ id: 'brief', type: 'input.brief', x: 0, y: 0, config: { text: '制作一个测试用的游戏原型。' } }], edges: [] }
  runner.kernel.db.exec("CREATE TRIGGER fixture_graph_failure BEFORE INSERT ON wf_run_graphs BEGIN SELECT RAISE(ABORT, 'fixture_graph_write_failed'); END")
  assert.throws(() => runner.start({ graph, runId: 'run-r0' }), /fixture_graph_write_failed/)
  for (const table of ['workflow_runs', 'workflow_run_definitions', 'workflow_steps', 'workflow_events', 'wf_run_graphs']) {
    const key = table === 'workflow_runs' ? 'id' : 'run_id'
    assert.equal(runner.kernel.one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${key}=?`, 'run-r0').n, 0, table + ' rolls back with graph failure')
  }
  assert.equal(runner.kernel.one("SELECT COUNT(*) AS n FROM workflow_requests WHERE scope_id='run' AND idempotency_key=?", 'run-r0').n, 0)
  runner.kernel.db.exec('DROP TRIGGER fixture_graph_failure')
  runner.start({ graph, runId: 'run-r0' })
  assert.equal(runner.kernel.one('SELECT COUNT(*) AS n FROM workflow_runs WHERE id=?', 'run-r0').n, 1)
  assert.deepEqual(runner.frozenGraph('run-r0'), graph)
  await runner.dispose(); runner.kernel.db.close(); runner = null
  reopened = createWorkflowRunner({ dbPath, root: contentRoot, productId: 'product-r0' })
  assert.equal(reopened.listForGraph(graph.id)[0]?.run_id, 'run-r0')
  assert.deepEqual(reopened.frozenGraph('run-r0'), graph)
  console.log('PASS R0 atomic run start: injected graph failure leaves no partial run, same-ID retry succeeds and survives reopen')
  console.log('PASS game workbench R0 integrity; temporary evidence:', root)
} finally {
  fs.writeFileSync = originalWrite; fs.renameSync = originalRename; syncBuiltinESMExports()
  for (const dispose of disposers.reverse()) await dispose()
  if (runner) { await runner.dispose(); runner.kernel.db.close() }
  if (reopened) { await reopened.dispose(); reopened.kernel.db.close() }
  database?.close()
  const local = relative(repository, resolve(bundleRoot))
  if (!local || local.startsWith('..' + sep) || !local.startsWith('.tmp-r0-bundle-')) throw new Error('unsafe_bundle_cleanup')
  fs.rmSync(bundleRoot, { recursive: true, force: true })
}
