import assert from 'node:assert/strict'
import { createWorkflowSessionAdapter } from '../src/host/workflow-session.mjs'
const calls = []
let refuse = false
const catalog = { default: { provider: 'p1', model: 'default' }, groups: [{ id: 'p1', models: [{ id: 'default' }, { id: 'shared' }] }, { id: 'p2', models: [{ id: 'special' }, { id: 'shared' }] }] }
const adapter = createWorkflowSessionAdapter({ typertGateway: { async invoke(request) {
  calls.push(request)
  if (request.method === 'modelCatalog') { assert.deepEqual(request.args, {}); return catalog }
  assert.equal(request.args.request.sessionId, 'test-session')
  if (request.method === 'projections') return { values: { modelSelection: { next: { provider: 'p2', model: 'special' } } } }
  if (request.method === 'selectModel') return { selected: { provider: request.args.request.provider, model: refuse ? 'wrong-model' : request.args.request.model } }
  throw new Error('unexpected method')
} } })
assert.deepEqual(await adapter.prepare('test-session', { modelId: 'special', role: 'full role body' }), { providerId: 'p2', modelId: 'special', role: 'full role body', modelEvidence: 'session/selectModel', roleEvidence: 'full_prompt' })
assert.equal((await adapter.prepare('test-session', {})).modelId, 'special')
await assert.rejects(() => adapter.prepare('test-session', { providerId: 'p1' }), /必须同时选择模型/)
await assert.rejects(() => adapter.prepare('test-session', { modelId: 'shared' }), /供应商不明确/)
refuse = true
await assert.rejects(() => adapter.prepare('test-session', { providerId: 'p1', modelId: 'default' }), /生成已停止/)
assert(calls.every(call => call.namespace === 'session'))
const agents = new Map()
const sent = []
const lifecycle = createWorkflowSessionAdapter({ get(name) {
  if (name === 'agents') return { get: id => agents.get(id), async create(options) { await options.setup?.({}); agents.set(options.sessionId, { followup: message => sent.push(message) }) } }
  if (name === 'agentPresets') return { resolve: async () => ({ id: 'standard' }), mount: async () => ({ noCommit: true }) }
} })
await lifecycle.create('workflow-test', 'D:/fixture')
await lifecycle.send('workflow-test', 'deliverable')
assert.equal(sent[0].content[0].text, 'deliverable')
assert.deepEqual(sent[0].source, { kind: 'user' })
await assert.rejects(() => lifecycle.create('workflow-test', 'D:/fixture'), /already_exists/)
console.log('PASS model adapter: catalog, provider resolution, session defaults, full role, rejection without fallback')
