/** Production component event tests, with actual management/services/files.
 * React DOM and browser playtesting are deliberately synthetic in this suite. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createNativeGameAssets } from '../src/host/native-game-assets.mjs'
import { createNativeGameRevisions } from '../src/host/native-game-revisions.mjs'
import { createNativeGameManagement } from '../src/host/native-game-management.ts'

const root = mkdtempSync(join(tmpdir(), 'native-game-panel-'))
const studio = createNativeGameStudio(), assets = createNativeGameAssets({ studio })
const target = { workspaceRoot: root, productId: 'panel-product', slug: 'first' }
let testMode = 'pass', denied
const playtester = { async playtest(args) {
  if (testMode === 'throw') throw new Error('game_ui_fixture_runtime_error')
  if (testMode === 'conflict') { const state = studio.currentState(args); writeFileSync(join(root, state.project, 'game.js'), state.source + '\n// concurrent external edit fixture\n'); throw new Error('game_ui_fixture_runtime_error') }
  return studio.recordPlaytest({ ...args, report: { playtestStatus: 'passed', errors: 0, requests: 0, summary: 'UI fixture report; real browser is assessed separately; Errors: none; Screenshots: synthetic.png', finalPhase: 'won', inputs: { keyboard: true, touch: true }, score: 1 }, screenshots: [{ name: 'synthetic.png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') }] })
} }
const revisions = createNativeGameRevisions({ studio, playtester })
const management = createNativeGameManagement({ studio, assets, revisions, playtester, blender: { async generate() { throw new Error('game_blender_unavailable') } }, products: () => [{ id: target.productId, workspacePath: root }], authorize(name) { if (denied === name) throw new Error('disabled_by_user: ' + name) } })
const requests = []
let fetchGate
async function transport(raw, init = {}) {
  const url = new URL(raw, 'http://workbench.test'), method = init.method ?? 'GET'
  const body = init.body ? JSON.parse(init.body) : null
  const request = { action: url.pathname.split('/game-studio/')[1], method, body, query: Object.fromEntries(url.searchParams) }
  requests.push(request)
  if (fetchGate?.match(request)) await fetchGate.promise
  let status = 0, text = '', ended = false
  const req = { headers: { host: 'workbench.test', ...(init.headers ?? {}) }, on() {}, off() {}, async *[Symbol.asyncIterator]() { if (init.body) yield Buffer.from(init.body) } }
  const res = { get writableEnded() { return ended }, on() {}, writeHead(value) { status = value }, end(value) { text = value ?? ''; ended = true } }
  assert.equal(await management.handle(req, res, url.pathname.replace('/workbench-api', ''), method, url), true)
  assert(status > 0)
  return { ok: status >= 200 && status < 300, status, async json() { return JSON.parse(text) } }
}

const source = readFileSync(new URL('../src/client/workflow/native-game-panel.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== undefined && child !== null && child !== false) })
function harness(identity = { productId: target.productId, slug: target.slug }) {
  const pending = new Set(), effects = []
  let scope = { key: undefined, type: null, hooks: [], mounted: true }
  let cursor = 0, dirty = false, tree, content = JSON.stringify(identity)
  const useState = initial => {
    const index = cursor++, owner = scope, hooks = owner.hooks
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], update => { if (!owner.mounted) return; hooks[index] = typeof update === 'function' ? update(hooks[index]) : update; dirty = true }]
  }
  const useRef = initial => { const index = cursor++; return scope.hooks[index] ??= { current: initial } }
  const useEffect = (effect, deps) => {
    const index = cursor++, owner = scope, previous = owner.hooks[index]
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) effects.push(() => { previous?.cleanup?.(); if (owner.mounted) owner.hooks[index] = { deps, cleanup: effect() } })
  }
  const useMemo = (fn, deps) => { const ref = useRef(); if (!ref.current || deps.some((v, i) => !Object.is(v, ref.current.deps[i]))) ref.current = { deps, value: fn() }; return ref.current.value }
  const exports = {}
  vm.runInNewContext(compiled, { exports, require(name) { assert.equal(name, 'react'); return { createElement: h, useState, useRef, useEffect, useMemo, useCallback: (fn, deps) => useMemo(() => fn, deps) } }, URLSearchParams, AbortController, console,
    fetch(...args) { const promise = transport(...args); pending.add(promise); void promise.finally(() => pending.delete(promise)); return promise },
  })
  const render = () => {
    let passes = 0
    do {
      dirty = false; cursor = 0
      const outer = exports.NativeGamePanel({ content })
      if (typeof outer?.type === 'function') {
        if (scope.key !== outer.props.key || scope.type !== outer.type) {
          scope.mounted = false
          for (const hook of scope.hooks) hook?.cleanup?.()
          scope = { key: outer.props.key, type: outer.type, hooks: [], mounted: true }
        }
        cursor = 0; tree = outer.type(outer.props)
      } else tree = outer
      while (effects.length) effects.shift()()
      assert(++passes < 20, 'Component render/effects must settle')
    } while (dirty)
    return tree
  }
  async function settle() {
    for (let i = 0; i < 100; i++) {
      await Promise.allSettled([...pending]); await new Promise(setImmediate); render()
      if (!pending.size && !dirty) { await new Promise(setImmediate); if (!pending.size && !dirty) return tree }
    }
    throw new Error('component_async_did_not_settle')
  }
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : []
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(text).join(' ') ?? ''
  const nodes = () => walk(tree)
  const button = (label, scope = tree) => { const node = walk(scope).find(n => n.type === 'button' && text(n) === label); assert(node, 'button missing: ' + label); return node }
  const click = async (label, scope) => { const node = button(label, scope); assert.equal(!!node.props.disabled, false, 'button disabled: ' + label); node.props.onClick(); return settle() }
  const row = value => { const code = nodes().find(n => n.type === 'code' && text(n).includes(value)); assert(code, 'row missing: ' + value); return nodes().find(n => n.children.includes(code)) }
  render()
  return { get tree() { return tree }, render, settle, nodes, text: () => text(tree), textOf: text, button, click, row, changeIdentity(next) { content = JSON.stringify(next); return render() }, setField(label, value) { const node = nodes().find(n => n.props['aria-label'] === label); assert(node, 'field missing: ' + label); node.props.onChange({ target: { value } }); render() } }
}

try {
  const original = studio.create({ ...target, title: '组件事件验收', rules: { durationSeconds: 3, hearts: 3 } })
  const originalState = studio.currentState(target)
  studio.updateProject({ ...target, expectedCurrentHash: originalState.currentHash, source: originalState.source + '\n// second historical version\n' })
  const panel = harness()
  assert(!panel.text().includes('当前构建：'), 'Project state is loaded by an explicit read')
  await panel.click('读取当前工程')
  const current = studio.listBuilds(target).find(b => b.buildCurrent)
  assert(panel.text().includes(current.buildId))
  assert.equal(requests.filter(item => item.method === 'GET').slice(-3).map(item => item.action).sort().join(','), 'assets,revisions,state')
  await panel.click('与当前比较', panel.row(original.buildId))
  assert(panel.text().includes('"sourceChanged": true'))
  await panel.click('真实浏览器重测当前版本')
  assert(panel.text().includes('UI fixture report'))

  await panel.click('生成候选')
  const image = assets.list(target)[0]
  assert.equal(image.provider, 'drawai'); assert.equal(image.slot, 'pickup')
  await panel.click('核验并预览', panel.row(image.assetId))
  assert(panel.nodes().some(node => node.type === 'img' && node.props.src.startsWith('data:image/svg+xml;base64,')))
  await panel.click('采用并构建', panel.row(image.assetId))
  assert.equal(studio.currentState(target).manifest.assets.pickup.assetId, image.assetId)
  assert(panel.text().includes('需要重新试玩'))
  const selectProvider = panel.nodes().find(node => node.type === 'select' && node.props.value === 'drawai')
  selectProvider.props.onChange({ target: { value: 'any-audio' } }); panel.render()
  assert(panel.nodes().some(node => node.type === 'select' && node.props.value === 'pickupSound'))
  const selectSlot = panel.nodes().find(node => node.type === 'select' && node.props.value === 'pickupSound')
  selectSlot.props.onChange({ target: { value: 'hitSound' } }); panel.render()
  await panel.click('生成候选')
  const sound = assets.list(target).find(item => item.provider === 'any-audio')
  assert.equal(sound.slot, 'hitSound')
  const audioRequest = requests.findLast(item => item.action === 'asset/generate')
  assert.equal(audioRequest.body.recipe.preset, 'hit')
  await panel.click('核验并预览', panel.row(sound.assetId))
  assert(panel.nodes().some(node => node.type === 'audio' && node.props.src.startsWith('data:audio/wav;base64,')))
  await panel.click('采用并构建', panel.row(sound.assetId))
  assert.equal(studio.currentState(target).manifest.assets.hitSound.assetId, sound.assetId)
  const beforeExternal = studio.currentState(target)
  const external = studio.updateProject({ ...target, expectedCurrentHash: beforeExternal.currentHash, source: beforeExternal.source + '\n// external edit before stale adoption fixture\n' })
  await panel.click('采用并构建', panel.row(image.assetId))
  assert(panel.text().includes('game_asset_build_conflict'), 'A stale asset adoption surfaces the host CAS conflict')
  assert.equal(studio.currentState(target).source, beforeExternal.source + '\n// external edit before stale adoption fixture\n', 'Failed stale adoption preserves the external source')
  assert(panel.text().includes(external.buildId), 'After a CAS conflict the panel refreshes the actual current build')
  const oldCurrentHash = studio.currentState(target).currentHash
  await panel.click('恢复此版本并保留备份', panel.row(original.buildId))
  assert.equal(studio.readBuild({ ...target, buildId: original.buildId }).buildCurrent, true)
  assert.equal(requests.findLast(item => item.action === 'restore').body.expectedCurrentHash, oldCurrentHash)
  assert(panel.text().includes('试玩未评估'))

  const providerNow = panel.nodes().find(node => node.type === 'select' && node.props.value === 'any-audio')
  providerNow.props.onChange({ target: { value: 'blender' } }); panel.render()
  await panel.click('生成候选')
  assert(panel.text().includes('game_blender_unavailable'), 'A missing Blender fixture surfaces its stable reason')
  assert.equal(requests.findLast(item => item.action === 'asset/generate').body.recipe.primitive, 'pickup')
  denied = 'workbench_game_asset_generate'
  await panel.click('生成候选')
  assert(panel.text().includes('game_policy_denied'))
  denied = undefined

  assert(panel.button('保存源码候选').props.disabled)
  panel.setField('候选 game.js 源码', studio.currentState(target).source + '\n// accepted UI source proposal\n')
  panel.setField('修订原因', 'component event fixture')
  await panel.click('保存源码候选')
  let proposal = revisions.list(target).find(item => item.status === 'proposed')
  assert(proposal)
  const proposedRequest = requests.findLast(item => item.action === 'revision/propose')
  assert.equal(proposedRequest.body.expectedCurrentHash, studio.currentState(target).currentHash)
  assert.equal(proposedRequest.body.expectedBuildId, original.buildId)
  await panel.click('真实核验并采用 / 回退', panel.row(proposal.candidateId))
  assert.equal(revisions.read({ ...target, candidateId: proposal.candidateId }).status, 'accepted')
  assert(panel.text().includes('候选核验通过，已采用'))

  testMode = 'throw'
  panel.setField('候选 game.js 源码', studio.currentState(target).source + '\n// rejected UI source proposal\n')
  await panel.click('保存源码候选')
  proposal = revisions.list(target).find(item => item.status === 'proposed')
  await panel.click('真实核验并采用 / 回退', panel.row(proposal.candidateId))
  assert.equal(revisions.read({ ...target, candidateId: proposal.candidateId }).status, 'rejected')
  assert(panel.text().includes('game_ui_fixture_runtime_error'))
  assert(panel.textOf(panel.row(proposal.candidateId)).includes('rejected'), 'A thrown verifier mutates status; UI must refresh rather than offering replay')
  assert(!panel.nodes().some(node => node.type === 'button' && panel.textOf(node) === '真实核验并采用 / 回退'))

  testMode = 'conflict'
  const baseline = studio.currentState(target)
  panel.setField('候选 game.js 源码', baseline.source + '\n// conflicted UI source proposal\n')
  await panel.click('保存源码候选')
  proposal = revisions.list(target).find(item => item.status === 'proposed')
  await panel.click('真实核验并采用 / 回退', panel.row(proposal.candidateId))
  assert(panel.text().includes('game_revision_rollback_conflict'))
  assert(panel.textOf(panel.row(proposal.candidateId)).includes('conflict'))
  assert(!panel.button('按当前指纹显式对账', panel.row(proposal.candidateId)).props.disabled)
  // Fixture operator resolves the concurrent edit to the known candidate, then explicitly reconciles.
  writeFileSync(join(root, baseline.project, 'game.js'), readFileSync(join(root, proposal.candidatePath, 'candidate.js')))
  await panel.click('读取当前工程')
  const recoveryHash = studio.currentState(target).currentHash
  await panel.click('按当前指纹显式对账', panel.row(proposal.candidateId))
  assert.equal(requests.findLast(item => item.action === 'revision/recover').body.expectedCurrentHash, recoveryHash)
  assert.equal(revisions.read({ ...target, candidateId: proposal.candidateId }).status, 'recovered')
  assert.equal(studio.currentState(target).sourceHash, baseline.sourceHash)
  assert(panel.text().includes('对账完成，需要重新试玩'))

  const secondTarget = { ...target, slug: 'second' }
  const second = studio.create({ ...secondTarget, title: '第二个独立工程' })
  panel.changeIdentity({ productId: target.productId, slug: 'second' })
  assert(!panel.text().includes(image.assetId), 'Changing project identity must immediately drop old candidates')
  assert(!panel.text().includes(proposal.candidateId), 'Changing identity must drop old source proposals')
  assert(!panel.text().includes(baseline.currentHash.slice(0, 12)), 'Changing identity must drop old CAS')
  await panel.click('读取当前工程')
  assert(panel.text().includes(second.buildId))
  assert(panel.button('保存源码候选').props.disabled, 'Old source text must not carry into another project')
  panel.changeIdentity({ productId: 'different-product', slug: 'second' })
  assert(!panel.text().includes(second.buildId), 'A product change also remounts scoped state, even with the same slug')
  panel.changeIdentity({ productId: target.productId, slug: 'second' })

  // Hold an old-project response across a switch: a late completion must not leak its state.
  let release
  fetchGate = { match: request => request.action === 'state' && request.query.slug === 'first', promise: new Promise(resolve => { release = resolve }) }
  panel.changeIdentity({ productId: target.productId, slug: 'first' })
  panel.button('读取当前工程').props.onClick()
  await new Promise(setImmediate)
  panel.changeIdentity({ productId: target.productId, slug: 'second' })
  release(); fetchGate = undefined
  await panel.settle()
  assert(!panel.text().includes(image.assetId), 'Late old-project refresh must be ignored after a switch')
  assert(!panel.text().includes(proposal.candidateId))
  assert(requests.every(request => request.method !== 'POST' || !('workspaceRoot' in request.body)), 'Browser writes never supply a filesystem root')
  console.log(`PASS native game panel: ${requests.length} real component-triggered management requests; history/compare/restore CAS, SVG/WAV generate/preview/adopt, provider/slot switching, source propose/verify/rejected/conflict/recover, policy/missing-provider errors, identity reset and stale-response refusal. DOM and browser evidence remain separate.`)
} finally {
  if (dirname(realpathSync(root)) !== realpathSync(tmpdir()) || !basename(root).startsWith('native-game-panel-')) throw new Error('unsafe_test_cleanup')
  rmSync(root, { recursive: true, force: true })
}
