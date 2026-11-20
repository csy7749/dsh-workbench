/** Actual source registration + policy wrapper; providers are explicit lifecycle fixtures.
 * DSH calls execute(args, ToolRunContext), whose signal must reach async providers. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import ts from 'typescript'
import * as sharedPolicy from '../src/shared/tool-policy.ts'
import * as studioModule from '../src/host/native-game-studio.mjs'
import * as assetModule from '../src/host/native-game-assets.mjs'
import * as revisionModule from '../src/host/native-game-revisions.mjs'
import * as blenderModule from '../src/host/native-game-blender.mjs'
import * as playtestModule from '../src/host/native-game-playtest.mjs'
import * as httpModule from '../src/host/native-game-http.ts'

const root = fs.mkdtempSync(path.join(tmpdir(), 'native-game-tool-cancel-'))
function load(relative, modules) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(compiled, { exports, console, Error, AbortSignal, require(name) { assert(name in modules, 'Unexpected module: ' + name); return modules[name] } })
  return exports
}
const policy = load('../src/host/tool-policy.ts', { 'node:fs': fs, 'node:path': path, '../shared/tool-policy.js': sharedPolicy })
const tools = load('../src/host/native-game-tools.ts', {
  'node:fs': fs, 'node:path': path, './tool-policy.js': policy, './native-game-studio.mjs': studioModule,
  './native-game-assets.mjs': assetModule, './native-game-revisions.mjs': revisionModule,
  './native-game-blender.mjs': blenderModule, './native-game-playtest.mjs': playtestModule, './native-game-http.js': httpModule,
})
const definitions = new Map(), guards = new Map(), effects = [], calls = [], authorizations = []
const ctx = { effect(fn, label) { effects.push(label); return fn() }, tools: { register(definition, options) { definitions.set(definition.name, definition); guards.set(definition.name, options.when) } } }
const target = { productId: 'cancel-fixture', slug: 'fixture', buildId: 'a'.repeat(12) }
const receipt = { ...target, hash: 'b'.repeat(64), bytes: 1, project: 'games/fixture', artifact: 'games/fixture/fixture.html', title: 'fixture' }
let observedSignal, acknowledgeStart
const waiting = async (name, args) => {
  calls.push(name); observedSignal = args.signal
  assert(args.signal instanceof AbortSignal, name + ' must receive the host AbortSignal')
  acknowledgeStart?.()
  return new Promise((resolve, reject) => {
    const abort = () => { args.signal.removeEventListener('abort', abort); reject(new Error('game_operation_cancelled')) }
    if (args.signal.aborted) abort(); else args.signal.addEventListener('abort', abort, { once: true })
  })
}
const immediate = name => args => { calls.push(name); return { ...receipt, receivedSignal: args.signal } }
const studio = { create: immediate('create'), build: immediate('build'), exportBuild: immediate('export'), readBuild: immediate('preview'), currentState: immediate('current'), listBuilds: immediate('list'), compareBuilds: immediate('compare'), restoreBuild: immediate('restore') }
const assets = { list: immediate('asset_list'), read: immediate('asset_read'), generate: immediate('asset_generate'), adopt: immediate('asset_adopt') }
const revisions = { list: immediate('revisions'), propose: immediate('revision_propose'), recover: immediate('revision_recover'), verify: args => waiting('revision_verify', args) }
const playtester = { playtest: args => waiting('playtest', args) }
const blender = { generate: args => waiting('blender', args) }

try {
  tools.registerNativeGameTools(ctx, () => [{ id: target.productId, workspacePath: root }], { studio, assets, revisions, playtester, blender, authorize(name) { authorizations.push(name) } })
  const expected = ['create', 'build', 'preview', 'export', 'playtest', 'history', 'restore', 'asset_list', 'asset_generate', 'asset_adopt', 'blender', 'revision_propose', 'revision_verify', 'revision_recover'].map(name => 'workbench_game_' + name)
  assert.equal(definitions.size, 14)
  assert.deepEqual([...definitions.keys()].sort(), expected.sort())
  assert.equal(effects.length, 14)
  assert(expected.every(name => sharedPolicy.WORKBENCH_TOOLS.some(meta => meta.name === name)), 'All registered names belong to the shared policy catalogue')
  for (const name of expected) {
    assert.equal(typeof guards.get(name), 'function', name + ' must use the real registerGuardedTool')
    policy.setActiveToolPolicy({ allow(candidate) { return { allowed: candidate !== name, reason: 'fixture policy' } } })
    assert.equal(guards.get(name)({ agent: {} }), false, 'Shared policy disables ' + name)
  }
  policy.setActiveToolPolicy(null)
  const cancelled = new AbortController(); cancelled.abort()
  for (const name of expected) {
    const result = await definitions.get(name).execute(target, { signal: cancelled.signal })
    assert.equal(result.ok, false, name); assert.equal(result.error, 'game_operation_cancelled', name)
  }
  assert.equal(calls.length, 0, 'Pre-cancelled tools never invoke providers or mutate project files')
  assert.equal(fs.readdirSync(root).length, 0)

  for (const [name, args] of [
    ['playtest', { ...target, seconds: 3 }],
    ['blender', { ...target, slot: 'pickup', recipe: { primitive: 'crate' } }],
    ['revision_verify', { ...target, candidateId: 'c'.repeat(16), seconds: 3 }],
  ]) {
    const controller = new AbortController(), spoof = new AbortController()
    const started = new Promise(resolve => { acknowledgeStart = resolve })
    const result = definitions.get('workbench_game_' + name).execute({ ...args, signal: spoof.signal }, { signal: controller.signal })
    await started
    assert.equal(observedSignal, controller.signal, 'Only trusted execution context supplies the cancellation signal')
    assert.notEqual(observedSignal, spoof.signal)
    controller.abort()
    assert.equal((await result).error, 'game_operation_cancelled')
  }
  assert(authorizations.includes('workbench_game_asset_generate'), 'Blender also respects the local asset-generation gate')
  assert(authorizations.includes('workbench_game_build') && authorizations.includes('workbench_game_playtest'), 'Revision verification respects build/playtest gates')
  // Immediate operations have no mid-transaction yield; pre-abort is the atomic boundary.
  const signal = new AbortController().signal
  const generated = await definitions.get('workbench_game_asset_generate').execute({ ...target, provider: 'drawai', slot: 'pickup', recipe: { shape: 'rect' } }, { signal })
  assert.equal(generated.ok, true); assert.equal(generated.result.receivedSignal, signal)
  const restored = await definitions.get('workbench_game_restore').execute({ ...target, expectedCurrentHash: 'd'.repeat(64) }, { signal })
  assert.equal(restored.result.receivedSignal, signal)
  console.log('PASS 14 real guarded registrations and shared-policy visibility; every pre-cancelled call refused without side effects; trusted ToolRunContext.signal reaches running playtest/Blender/revision verification, overrides spoofed args, and reaches asset/restore boundaries. Async providers are explicit synthetic lifecycle fixtures.')
} finally {
  policy.setActiveToolPolicy(null)
  if (path.dirname(fs.realpathSync(root)) !== fs.realpathSync(tmpdir()) || !path.basename(root).startsWith('native-game-tool-cancel-')) throw new Error('unsafe_test_cleanup')
  fs.rmSync(root, { recursive: true, force: true })
}
