/** Real game files + actual tool registrations. No workflow runner or browser is
 * required; this verifies that Agent calls remain independent of node evidence. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import ts from 'typescript'
import * as serviceModule from '../src/host/native-game-service.mjs'

const root = fs.mkdtempSync(path.join(tmpdir(), 'native-game-service-'))
const products = () => [{ id: 'independent-game', workspacePath: root }]
const authorizations = []
const service = serviceModule.createNativeGameService({ products, authorize: name => authorizations.push(name) })
const source = fs.readFileSync(new URL('../src/host/native-game-tools.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const exported = {}
vm.runInNewContext(compiled, { exports: exported, Error, require(name) {
  if (name === './native-game-service.mjs') return serviceModule
  if (name === './tool-policy.js') return { registerGuardedTool(ctx, definition) { ctx.tools.register(definition) } }
  throw new Error('Unexpected tool dependency: ' + name)
} })
const tools = new Map()
exported.registerNativeGameTools({ tools: { register(definition) { tools.set(definition.name, definition) } } }, products, { service })
const forbidden = ['runId', 'nodeId', 'attemptId', 'scope', 'workspaceIdentity', 'nativeOperationId', 'source', 'manifest', 'html', 'data', 'runDir', 'reportHash', 'screenshotHashes', 'sourceHash', 'manifestHash', 'inputHash', 'schemaVersion', 'builderVersion']
function compact(value) {
  for (const key of forbidden) assert.equal(Object.hasOwn(value, key), false, 'Agent receipt must omit ' + key)
}
const invoke = (action, args, execution) => tools.get('workbench_game_' + action).execute({ productId: 'independent-game', slug: 'watchtower', ...args }, execution)
try {
  assert.equal(tools.size, 14)
  const schema = tools.get('workbench_game_create').parameters
  assert.equal(schema.properties.template.default, 'cinderwatch')
  for (const field of ['runId', 'nodeId', 'attemptId', 'sources', 'approved', 'workspaceRoot']) assert.equal(Object.hasOwn(schema.properties, field), false)
  const created = await invoke('create', { title: '三维塔防 · 独立工具' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.template, 'cinderwatch')
  assert.equal(created.project, 'games/watchtower')
  assert.equal(created.previewAvailable, true)
  assert.match(created.previewUrl, /^\/workbench-api\/game-studio\/preview\?/)
  assert(Buffer.byteLength(JSON.stringify(created)) < 2048, 'Normal create response stays small')
  compact(created)
  const target = { productId: 'independent-game', slug: 'watchtower', buildId: created.buildId }
  const raw = service.studio.readBuild({ ...target, workspaceRoot: root })
  assert.equal(raw.manifest.orientation, 'landscape')
  assert.deepEqual(raw.manifest.rules, { seed: 4, biome: 'ashen', startingGold: 300, lives: 20, autoCommand: true })
  assert(raw.source.length > 400000 && raw.html.length > 1000000, 'Complete game, not a placeholder scene')
  const built = await invoke('build')
  assert.equal(built.ok, true)
  assert.equal(built.buildId, created.buildId)
  assert.equal(built.reused, true)
  compact(built)
  const preview = await invoke('preview', { buildId: created.buildId })
  compact(preview)
  assert.equal(preview.buildId, created.buildId)
  const history = await invoke('history', { action: 'current' })
  assert.match(history.result.currentHash, /^[a-f0-9]{64}$/)
  compact(history.result)
  const exported = await invoke('export', { buildId: created.buildId })
  assert.equal(exported.ok, true)
  assert.equal(fs.readFileSync(path.join(root, exported.exportPath), 'utf8'), raw.html)
  compact(exported)
  const sourcePath = path.join(root, created.project, 'game.js')
  fs.appendFileSync(sourcePath, '\n// independent tool iteration\n')
  const updated = await invoke('build')
  assert.notEqual(updated.buildId, created.buildId)
  const diff = await invoke('history', { action: 'compare', fromBuildId: created.buildId, toBuildId: updated.buildId })
  assert.equal(diff.result.sourceDiff.changed, true)
  assert(diff.result.sourceDiff.addedLines > 0)
  assert.deepEqual(diff.result.changedFields, [])
  compact(diff.result)
  // Domain receipts remain available to node adapters, but no workflow tables or
  // run folders were created by any of these independently useful tool calls.
  assert.match(raw.hash, /^[a-f0-9]{64}$/)
  assert.deepEqual(fs.readdirSync(root), ['games'])
  const cancelled = new AbortController(); cancelled.abort()
  const stopped = await invoke('create', { slug: 'cancelled', title: 'Cancelled' }, { signal: cancelled.signal })
  assert.equal(stopped.error, 'game_operation_cancelled')
  assert.equal(fs.existsSync(path.join(root, 'games/cancelled')), false)
  const denied = serviceModule.createNativeGameService({ products, authorize() { throw new Error('fixture_policy_denied') } })
  await assert.rejects(() => denied.execute('create', { productId: 'independent-game', slug: 'denied', title: 'Denied' }), /fixture_policy_denied/)
  assert.equal(fs.existsSync(path.join(root, 'games/denied')), false)
  await assert.rejects(() => service.execute('create', { productId: 'unknown', workspaceRoot: root, slug: 'unknown', title: 'Unknown' }), /product_workspace_unavailable/)
  assert(authorizations.includes('workbench_game_create') && authorizations.includes('workbench_game_export'))
  console.log('PASS shared game service: independent real Cinderwatch tool creation/build/preview/export, compact responses, meaningful version diffs, no workflow snapshots, registry/policy/cancellation boundaries')
} finally {
  if (path.dirname(fs.realpathSync(root)) !== fs.realpathSync(tmpdir()) || !path.basename(root).startsWith('native-game-service-')) throw new Error('unsafe_test_cleanup')
  fs.rmSync(root, { recursive: true, force: true })
}
