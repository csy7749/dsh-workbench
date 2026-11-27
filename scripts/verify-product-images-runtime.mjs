import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createProductImagesRuntime } from '../src/host/product-images-runtime.mjs'

const root = mkdtempSync(join(tmpdir(), 'product-images-runtime-'))
const workspace = join(root, 'workspace')
const other = join(root, 'other')
mkdirSync(workspace)
mkdirSync(other)
const referencePath = join(workspace, 'source.png')
writeFileSync(referencePath, 'fixture')
const data = Buffer.from('attachment byte fixture')
const ref = { attachmentId: 'sha256:' + createHash('sha256').update(data).digest('hex'), mediaType: 'image/png', bytes: data.length, width: 8, height: 6 }
const value = () => ({ attachment: { ...ref }, provider: 'fixture', model: 'fixture-image', savedTo: join(other, 'do-not-trust.png') })
const definitions = new Map(['generate_image', 'edit_image'].map(name => [name, { name, parameters: { type: 'object', properties: { prompt: { type: 'string' }, ...(name === 'edit_image' ? { source_path: { type: 'string' } } : {}) } }, output: { schema: { type: 'object' } }, execute() { throw new Error('must_not_bypass_executor') } }]))
const live = new Map()
const calls = []
const created = []
const disposed = []
const reads = []
let visible = ['generate_image', 'edit_image']
let assemblyScope
let behavior = async batch => ({ results: [{ callId: batch.calls[0].id, result: { isError: false, value: value() } }], additionalContexts: [], concluded: false })
const ctx = {
  tools: {
    get(name) { return definitions.get(name) },
    async execute(batch) { calls.push(batch); return behavior(batch) },
  },
  attachments: {
    async readImage(attachment, signal) { reads.push({ attachment, signal }); return { ref: { ...ref }, data } },
  },
  systemPrompt: { async assemble(options) { assemblyScope = options.scope; return { tools: visible.map(name => ({ name })) } } },
  agents: {
    get(id) { return live.get(id) },
    async create(options) {
      created.push(options)
      const agent = { id: options.sessionId, session: { id: options.sessionId, header: { cwd: options.meta.cwd } } }
      live.set(agent.id, agent)
      return { agent, async dispose() { disposed.push(agent.id); live.delete(agent.id) } }
    },
  },
}
const runtime = createProductImagesRuntime(ctx)
const input = extra => ({ mode: 'generate', prompt: ' 紫色角色图 ', workspaceRoot: workspace, ...extra })
const reject = (promise, code, definitive = true) => assert.rejects(promise, error => error.message === code && error.definitive === definitive)

try {
  assert.deepEqual(await runtime.status(), { available: true, generateAvailable: true, editAvailable: true, executor: 'native' })
  const receipt = await runtime.generate(input())
  assert.deepEqual(JSON.parse(calls[0].calls[0].arguments), { prompt: '紫色角色图' })
  assert.equal(calls[0].calls[0].type, 'tool-call')
  assert.equal(calls[0].calls[0].name, 'generate_image')
  assert(!('agent' in calls[0]), 'standalone generation needs no fabricated Agent')
  assert(!('savedTo' in receipt), 'provider paths never become file-read authority')
  assert.deepEqual(await runtime.readImage(receipt), { data, mime: 'image/png' })
  assert.equal(reads[0].attachment.attachmentId, ref.attachmentId)
  await reject(runtime.readImage({ ...receipt }), 'image_receipt_invalid')
  receipt.attachment.attachmentId = 'sha256:' + '0'.repeat(64)
  assert.deepEqual(await runtime.readImage(receipt), { data, mime: 'image/png' }, 'mutating a public receipt cannot redirect its private attachment capability')

  visible = ['run_code']
  assert.equal((await runtime.status()).reason, 'image_native_executor_required')
  const beforePtc = calls.length
  await reject(runtime.generate(input()), 'image_native_executor_required')
  assert.equal(calls.length, beforePtc, 'PTC mode refuses before a potentially billable call')
  visible = ['generate_image', 'edit_image']
  definitions.delete('edit_image')
  assert.equal((await runtime.status()).reason, 'image_provider_tools_incompatible')
  definitions.set('edit_image', { ...definitions.get('generate_image'), name: 'edit_image', parameters: { type: 'object', properties: { prompt: { type: 'string' }, source_path: { type: 'string' } } } })
  const originalRead = ctx.attachments.readImage
  delete ctx.attachments.readImage
  assert.equal((await runtime.status()).reason, 'image_attachments_unavailable')
  ctx.attachments.readImage = originalRead
  const originalAssemble = ctx.systemPrompt.assemble
  delete ctx.systemPrompt.assemble
  assert.equal((await runtime.status()).reason, 'image_executor_status_unavailable')
  ctx.systemPrompt.assemble = originalAssemble

  const cancelled = new AbortController()
  cancelled.abort()
  const beforeCancel = calls.length
  await reject(runtime.generate(input({ signal: cancelled.signal })), 'image_operation_cancelled')
  assert.equal(calls.length, beforeCancel)
  await reject(runtime.generate(input({ mode: 'edit', referencePath: join(other, 'outside.png') })), 'image_reference_invalid')
  assert.equal(created.length, 0)

  await runtime.generate(input({ mode: 'edit', referencePath }))
  assert.equal(created.length, 1)
  assert.equal(created[0].meta.cwd, realpathSync(workspace))
  assert.equal(disposed.length, 1)
  assert.equal(live.size, 0)
  const editCall = calls.at(-1)
  assert.equal(editCall.agent.session.header.cwd, realpathSync(workspace))
  assert.equal(editCall.calls[0].name, 'edit_image')
  assert.deepEqual(JSON.parse(editCall.calls[0].arguments), { prompt: '紫色角色图', source_path: realpathSync(referencePath) })
  assert.equal(assemblyScope, editCall.agent)

  const trusted = { id: 'product-session', session: { id: 'product-session', header: { cwd: workspace } } }
  live.set(trusted.id, trusted)
  await runtime.generate(input({ mode: 'edit', referencePath, execution: { agent: trusted } }))
  assert.equal(calls.at(-1).agent, trusted)
  assert.equal(created.length, 1, 'reuse only the exact registered Agent bound to this workspace')
  const foreign = { id: 'foreign-session', session: { id: 'foreign-session', header: { cwd: other } } }
  live.set(foreign.id, foreign)
  await runtime.generate(input({ mode: 'edit', referencePath, execution: { agent: foreign } }))
  assert.notEqual(calls.at(-1).agent, foreign)
  assert.equal(created.length, 2, 'foreign workspace Agent must not supply edit authority')
  const fabricated = { id: trusted.id, session: { id: trusted.id, header: { cwd: workspace } } }
  await runtime.generate(input({ mode: 'edit', referencePath, execution: { agent: fabricated } }))
  assert.notEqual(calls.at(-1).agent, fabricated)
  assert.equal(created.length, 3)

  behavior = async batch => ({ results: [{ callId: batch.calls[0].id, result: { isError: true, error: { message: 'private-provider-error-not-forwarded', info: { code: 'UNKNOWN_TOOL' } } } }] })
  await reject(runtime.generate(input()), 'image_tool_not_executable')
  behavior = async batch => ({ results: [{ callId: batch.calls[0].id, result: { isError: true, error: { message: 'private-provider-error-not-forwarded', info: { code: 'PROVIDER_ERROR' } } } }] })
  await reject(runtime.generate(input()), 'image_tool_failed', false)
  behavior = async () => { throw new Error('private-url-or-key') }
  await reject(runtime.generate(input()), 'image_generation_result_unknown', false)
  behavior = async () => ({ results: [] })
  await reject(runtime.generate(input()), 'image_generation_result_unknown', false)
  behavior = async () => ({ results: [{ callId: 'different', result: { isError: false, value: value() } }] })
  await reject(runtime.generate(input()), 'image_generation_result_unknown', false)

  for (const bad of [{ svg: '<svg/>' }, { animation: { frames: 2 } }, { original: { mediaType: 'image/gif' } }, { attachment: { ...ref, mediaType: 'image/gif' } }]) {
    behavior = async batch => ({ results: [{ callId: batch.calls[0].id, result: { isError: false, value: { ...value(), ...bad } } }] })
    await reject(runtime.generate(input()), 'image_output_unsupported')
  }
  const lateCancel = new AbortController()
  behavior = async batch => { lateCancel.abort(); return { results: [{ callId: batch.calls[0].id, result: { isError: false, value: value() } }] } }
  await reject(runtime.generate(input({ signal: lateCancel.signal })), 'image_generation_result_unknown', false)
  let release
  let entered
  const entry = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const during = new AbortController()
  behavior = async batch => { entered(); await gate; return { results: [{ callId: batch.calls[0].id, result: { isError: true, error: { info: { code: 'ABORTED' } } } }] } }
  let settled = false
  const pending = runtime.generate(input({ mode: 'edit', referencePath, signal: during.signal })).finally(() => { settled = true })
  await entry
  during.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'cancellation drains the actual executor instead of racing it')
  assert.equal(live.has(calls.at(-1).agent.id), true, 'owned Agent stays alive until the running tool settles')
  release()
  await reject(pending, 'image_tool_failed', false)
  assert.equal(live.has(calls.at(-1).agent.id), false)

  behavior = async batch => ({ results: [{ callId: batch.calls[0].id, result: { isError: false, value: value() } }] })
  const corrupt = await runtime.generate(input())
  ctx.attachments.readImage = async () => ({ ref: { ...ref, width: 999 }, data })
  await reject(runtime.readImage(corrupt), 'image_attachment_integrity_invalid')
  ctx.attachments.readImage = originalRead
  const after = new AbortController()
  const afterReceipt = await runtime.generate(input({ signal: after.signal }))
  after.abort()
  await reject(runtime.readImage(afterReceipt), 'image_generation_result_unknown', false)
  const empty = createProductImagesRuntime({})
  assert.equal((await empty.status()).available, false)
  console.log('product-images runtime: guarded batch dispatch, dynamic capability checks, workspace-bound real Agents, verified attachment capture, cancellation and failure boundaries passed')
} finally {
  if (dirname(realpathSync(root)) !== realpathSync(tmpdir()) || !basename(root).startsWith('product-images-runtime-')) throw new Error('unsafe_test_cleanup')
  rmSync(root, { recursive: true, force: true })
}
