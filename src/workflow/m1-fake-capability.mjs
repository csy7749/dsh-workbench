import { createHash } from 'node:crypto'

// M1 开发专用能力；不注册为 DSH tool，不接受代码、路径或网络参数。
const schema = { input: { content: 'string' }, output: { content: 'string' } }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const contract = {
  capabilityId: 'development.text.identity', capabilityVersion: 1,
  toolSchemaFingerprint: hash(schema), effectClass: 'read', effects: [],
  parameterMapping: { content: 'bound.content' }, outputMapping: { content: 'content' },
}
export const fakeCapabilityContract = () => JSON.parse(JSON.stringify(contract))
const invalid = () => Object.assign(new Error('development_capability_invalid'), { code: 'development_capability_invalid' })
export function validateFakeCapability(node) {
  if (node.executor !== 'tool-service') return
  const actual = node.capability
  if (!actual || Object.keys(actual).length !== Object.keys(contract).length) throw invalid()
  for (const key of Object.keys(contract)) if (JSON.stringify(actual[key]) !== JSON.stringify(contract[key])) throw invalid()
  if (!Array.isArray(node.effects) || node.effects.length !== 0 || node.nodeKind !== 'automatic') throw invalid()
  if (!Array.isArray(node.outputs) || node.outputs.length !== 1) throw invalid()
  const output = node.outputs[0]
  if (output.name !== 'content' || output.artifactType !== 'text' || output.schemaVersion !== 1 || output.editable !== false || output.multiplicity !== 'one') throw invalid()
}
export function executeFakeCapability({ node, content, attemptId, record }) {
  validateFakeCapability(node)
  if (node.executor !== 'tool-service' || typeof content !== 'string' || typeof record !== 'function') throw invalid()
  const request = { content }
  const operationId = `capability:${attemptId}`
  // 在确定性纯函数执行前持久记录实际请求；不包含 Attempt token。
  record('attempt.capability_request', { attemptId, operationId, capability: fakeCapabilityContract(), request, requestHash: hash(request) })
  const outputs = { content: request.content }
  record('attempt.capability_result', { attemptId, operationId, status: 'succeeded', outputHash: hash(outputs), effectClass: 'read', effects: [] })
  return { operationId, status: 'succeeded', outputs, next: 'submit_candidate' }
}
