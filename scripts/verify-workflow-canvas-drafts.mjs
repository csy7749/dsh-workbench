import assert from 'node:assert/strict'
import { readCanvasDraft, writeCanvasDraft } from '../src/client/workflow/canvas-drafts.ts'
const items = new Map()
const storage = { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) }
const draft = { id: 'graph-a', revision: 2, graph: { nodes: [{ id: 'a', config: { text: '未保存内容' } }], edges: [] } }
assert.equal(writeCanvasDraft(storage, 'product-a', draft), true)
assert.deepEqual(readCanvasDraft(storage, 'product-a'), draft)
assert.equal(readCanvasDraft(storage, 'product-b'), null)
assert.equal(writeCanvasDraft(storage, 'product-a', null), true)
assert.equal(readCanvasDraft(storage, 'product-a'), null)
assert.equal(writeCanvasDraft(null, 'product-a', draft), false)
assert.equal(readCanvasDraft({ getItem: () => '{broken' }, 'product-a'), null)
console.log('PASS canvas draft persistence, scope isolation and unavailable storage')
