import assert from 'node:assert/strict'
import { compileGraph } from '../src/host/workflow-runner.mjs'
import { canConnect, cloneGraph, normalizeGraph } from '../src/shared/workflow-catalog.ts'

const node = (id, type, config = {}) => ({ id, type, config, x: 0, y: 0 })
const edge = (a, ap, b, bp) => ({ from: { node: a, port: ap }, to: { node: b, port: bp } })
const graph = {
  version: 1, name: 'configuration regression', line: 'game',
  defaults: { providerId: 'default-provider', modelId: 'default-model', role: 'default-role' },
  nodes: [node('brief', 'input.brief', { text: 'brief' }), node('model', 'config.model', { modelId: 'selected-model' }), node('role', 'config.role', { role: 'Complete role instructions' }), node('cfg', 'config.combine'), node('gdd', 'game.gdd'), node('second', 'dsh.generate')],
  edges: [edge('brief', 'out', 'gdd', 'req'), edge('model', 'model', 'cfg', 'model'), edge('role', 'role', 'cfg', 'role'), edge('cfg', 'config', 'gdd', 'execution'), edge('cfg', 'config', 'second', 'execution'), edge('gdd', 'gdd', 'second', 'in')],
}
const normalized = normalizeGraph(graph, 'game')
assert.deepEqual(normalized.issues, [])
const withoutConfigEdges = { ...graph, edges: graph.edges.filter(item => !['model', 'role', 'cfg'].includes(item.from.node)) }
assert.equal(canConnect(withoutConfigEdges, { node: 'model', port: 'model' }, { node: 'cfg', port: 'model' }), null)
assert.equal(canConnect(withoutConfigEdges, { node: 'role', port: 'role' }, { node: 'cfg', port: 'role' }), null)
assert.equal(canConnect(withoutConfigEdges, { node: 'cfg', port: 'config' }, { node: 'gdd', port: 'execution' }), null)
assert.equal(canConnect(withoutConfigEdges, { node: 'model', port: 'model' }, { node: 'cfg', port: 'role' }).code, 'type_mismatch')
assert.deepEqual(cloneGraph(normalized.graph).defaults, graph.defaults)
const compiled = compileGraph(normalized.graph)
assert.deepEqual(compiled.map(item => item.nodeId), ['brief', 'gdd', 'second'])
assert.deepEqual(compiled[1].upstream, ['brief'])
assert.deepEqual(compiled[2].upstream, ['gdd'])
assert.deepEqual(compiled[1].executionConfig, { providerId: 'default-provider', modelId: 'selected-model', role: 'Complete role instructions' })
assert.deepEqual(compiled[1].executionConfig, compiled[2].executionConfig)
graph.nodes[1].config.modelId = 'later-edit'
assert.equal(compiled[1].executionConfig.modelId, 'selected-model')
assert.equal(canConnect(graph, { node: 'model', port: 'model' }, { node: 'second', port: 'execution' }).code, 'type_mismatch')
assert.equal(canConnect(graph, { node: 'brief', port: 'out' }, { node: 'gdd', port: 'execution' }).code, 'type_mismatch')
const inherited = { ...graph, edges: graph.edges.filter(item => item.to.port !== 'execution') }
assert.deepEqual(compileGraph(inherited)[1].executionConfig, graph.defaults)
console.log('PASS: config isolation, defaults, shared configuration, frozen values, actual data edges')
