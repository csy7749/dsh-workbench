import assert from 'node:assert/strict'
import { alignSelection, connectionChoices, fitGraph, graphBounds, layoutGraph } from '../src/client/workflow/canvas-editor.ts'

const graph = { version: 1, line: 'game', name: 'editor', nodes: [
  { id: 'a', type: 'input.brief', x: 300, y: 500, config: {} },
  { id: 'b', type: 'dsh.generate', x: 900, y: 100, config: {} },
  { id: 'c', type: 'output.publish', x: 40, y: 40, config: {} },
], edges: [
  { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
  { from: { node: 'b', port: 'out' }, to: { node: 'c', port: 'in' } },
] }
const heightOf = node => node.id === 'b' ? 380 : 160
const arranged = layoutGraph(graph, heightOf)
const positions = Object.fromEntries(arranged.nodes.map(node => [node.id, [node.x, node.y]]))
assert.deepEqual(positions, { a: [48, 48], b: [396, 48], c: [744, 48] })
assert.deepEqual(graph.nodes.map(node => [node.x, node.y]), [[300, 500], [900, 100], [40, 40]], 'layout must preserve source graph')
assert.deepEqual(Object.keys(graphBounds(graph.nodes, heightOf)), ['left', 'top', 'right', 'bottom'])
const fitted = fitGraph(graph.nodes, 1200, 800, heightOf)
for (const node of graph.nodes) {
  const x = fitted.x + node.x * fitted.scale, y = fitted.y + node.y * fitted.scale
  assert(x >= 0 && y >= 0)
  assert(x + 248 * fitted.scale <= 1200)
  assert(y + heightOf(node) * fitted.scale <= 800)
}
const aligned = alignSelection(graph, new Set(['a', 'b']), 'left')
assert.deepEqual(aligned.nodes.map(node => node.x), [300, 300, 40])
assert.deepEqual(alignSelection(graph, new Set(['a']), 'top'), graph, 'single selection is unchanged')
assert.deepEqual(graph.nodes.map(node => [node.x, node.y]), [[300, 500], [900, 100], [40, 40]], 'alignment must preserve source graph')
assert.throws(() => layoutGraph({ ...graph, edges: [...graph.edges, { from: { node: 'c', port: 'out' }, to: { node: 'a', port: 'in' } }] }, heightOf), /存在环/)
const connections = { ...graph, nodes: [
  { id: 'brief', type: 'input.brief', x: 0, y: 0, config: {} },
  { id: 'model', type: 'config.model', x: 0, y: 0, config: {} },
  { id: 'cfg', type: 'config.combine', x: 0, y: 0, config: {} },
  { id: 'join', type: 'flow.join', x: 0, y: 0, config: {} },
  { id: 'join2', type: 'flow.join', x: 0, y: 0, config: {} },
  { id: 'out', type: 'output.publish', x: 0, y: 0, config: {} },
], edges: [] }
assert.deepEqual(connectionChoices(connections, { node: 'model', port: 'model' }, 'cfg').choices.map(port => port.port), ['model'])
assert.equal(connectionChoices(connections, { node: 'model', port: 'model' }, 'join').issue.code, 'type_mismatch')
assert.deepEqual(connectionChoices(connections, { node: 'brief', port: 'out' }, 'join').choices.map(port => port.port), ['a', 'b', 'c'])
const occupied = { ...connections, edges: [{ from: { node: 'brief', port: 'out' }, to: { node: 'join', port: 'a' } }] }
assert.deepEqual(connectionChoices(occupied, { node: 'brief', port: 'out' }, 'join').choices.map(port => port.port), ['b', 'c'])
const cyclic = { ...occupied, edges: [...occupied.edges, { from: { node: 'join', port: 'out' }, to: { node: 'out', port: 'in' } }] }
assert.equal(connectionChoices(cyclic, { node: 'join', port: 'out' }, 'brief').issue.code, 'type_mismatch')
assert.equal(connectionChoices(cyclic, { node: 'join', port: 'out' }, 'join').issue.code, 'self_link')
assert.equal(connectionChoices({ ...cyclic, edges: [{ from: { node: 'join', port: 'out' }, to: { node: 'join2', port: 'a' } }] }, { node: 'join2', port: 'out' }, 'join').issue.code, 'cycle')
console.log('PASS canvas editor layout, fit, alignment and safe matching of connection targets')
