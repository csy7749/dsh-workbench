import { randomUUID } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

const STATIC_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_BYTES = 20 * 1024 * 1024
const BEFORE_DISPATCH = new Set(['UNKNOWN_TOOL', 'INVALID_ARGS', 'TOOL_ACTIVATION_FAILED', 'TOOL_CONTEXT_UNAVAILABLE', 'APPROVAL_REJECTED', 'APPROVAL_CANCELLED', 'APPROVAL_UNAVAILABLE', 'ABORTED_BEFORE_DISPATCH'])
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function failure(code, definitive = true) {
  return Object.assign(new Error(code), { definitive })
}

function service(ctx, name) {
  try { return ctx.get?.(name) ?? ctx[name] } catch { return undefined }
}

function supportedTool(tool, name) {
  const properties = tool?.parameters?.properties
  return tool?.name === name && typeof tool.execute === 'function' && plain(properties)
    && properties.prompt?.type === 'string'
    && (name !== 'edit_image' || properties.source_path?.type === 'string')
    && plain(tool.output?.schema)
}

function attachmentOf(value) {
  const ref = value?.attachment
  if (!plain(value) || value.svg !== undefined || value.animation !== undefined || value.original?.mediaType === 'image/gif'
    || !plain(ref) || !STATIC_TYPES.has(ref.mediaType)
    || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_BYTES
    || !Number.isSafeInteger(ref.width) || ref.width < 1 || !Number.isSafeInteger(ref.height) || ref.height < 1
    || typeof value.provider !== 'string' || !value.provider.trim() || value.provider.length > 200
    || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) {
    throw failure('image_output_unsupported')
  }
  return { ...ref }
}

async function workspaceOf(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw failure('product_workspace_unavailable')
  try {
    const root = await realpath(value)
    if (!(await stat(root)).isDirectory()) throw failure('product_workspace_unavailable')
    return root
  } catch { throw failure('product_workspace_unavailable') }
}

async function referenceOf(root, value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw failure('image_reference_invalid')
  try {
    const ref = await realpath(value)
    const name = relative(root, ref)
    const info = await lstat(value)
    if (!name || isAbsolute(name) || name === '..' || name.startsWith('..' + sep) || !info.isFile() || info.isSymbolicLink()) {
      throw failure('image_reference_invalid')
    }
    return ref
  } catch { throw failure('image_reference_invalid') }
}

async function matchingAgent(agents, agent, root) {
  try {
    const id = agent?.session?.id
    if (typeof id !== 'string' || typeof agents?.get !== 'function' || agents.get(id) !== agent) return undefined
    if (await realpath(agent.session.header.cwd) !== root) return undefined
    return agent
  } catch { return undefined }
}

/** Use registered image tools through DSH's guarded batch executor, without an LLM turn. */
export function createProductImagesRuntime(ctx) {
  // A receipt is an execution-local capability, never a caller-supplied attachment lookup.
  const receipts = new WeakMap()

  async function capabilities(agent, signal) {
    const tools = service(ctx, 'tools')
    const attachments = service(ctx, 'attachments')
    const systemPrompt = service(ctx, 'systemPrompt')
    const unavailable = reason => ({ available: false, generateAvailable: false, editAvailable: false, executor: 'unavailable', reason })
    if (typeof tools?.get !== 'function' || typeof tools.execute !== 'function') return unavailable('image_tools_unavailable')
    if (typeof attachments?.readImage !== 'function') return unavailable('image_attachments_unavailable')
    let generateAvailable
    let editAvailable
    try {
      generateAvailable = supportedTool(tools.get('generate_image', agent), 'generate_image')
      editAvailable = supportedTool(tools.get('edit_image', agent), 'edit_image')
    } catch { return unavailable('image_provider_unavailable') }
    if (!generateAvailable || !editAvailable) return unavailable('image_provider_tools_incompatible')
    if (typeof systemPrompt?.assemble !== 'function') return unavailable('image_executor_status_unavailable')
    let assembly
    try {
      // Registry-only assembly calls no model and commits no Session events. Its tools
      // are projected by the selected executor, unlike tools.schemas()/get().
      assembly = await systemPrompt.assemble({ ...(agent ? { scope: agent } : {}), ...(signal ? { signal } : {}) })
    } catch { return unavailable('image_executor_unavailable') }
    const names = new Set((Array.isArray(assembly?.tools) ? assembly.tools : []).map(tool => tool?.name))
    if (!names.has('generate_image') || !names.has('edit_image')) {
      return { ...unavailable('image_native_executor_required'), executor: names.has('run_code') ? 'ptc' : 'unavailable' }
    }
    return { available: true, generateAvailable: true, editAvailable: true, executor: 'native' }
  }

  return {
    status() { return capabilities() },

    async generate({ mode, prompt, workspaceRoot, referencePath, signal: callerSignal, execution } = {}) {
      if (!['generate', 'edit'].includes(mode)) throw failure('image_mode_invalid')
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12_000 || /\x00/.test(prompt)) throw failure('image_prompt_invalid')
      if (mode === 'generate' && referencePath !== undefined) throw failure('image_reference_invalid')
      const signals = [callerSignal, execution?.signal].filter(Boolean)
      let signal
      try { signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal }
      catch { throw failure('image_signal_invalid') }
      if (signal.aborted) throw failure('image_operation_cancelled')
      const root = await workspaceOf(workspaceRoot)
      const reference = mode === 'edit' ? await referenceOf(root, referencePath) : undefined
      const agents = service(ctx, 'agents')
      let agent = await matchingAgent(agents, execution?.agent, root)
      let owned
      let dispatched = false
      try {
        const initial = await capabilities(agent, signal)
        if (!initial.available) throw failure(initial.reason)
        if (mode === 'edit' && !agent) {
          if (typeof agents?.create !== 'function' || typeof agents.get !== 'function') throw failure('image_edit_session_unavailable')
          if (signal.aborted) throw failure('image_operation_cancelled')
          try {
            // The official factory creates a genuine, empty Agent scope. No prompt,
            // followup, model selection or inbox input is submitted to its idle loop.
            owned = await agents.create({ sessionId: 'workbench-image-edit:' + randomUUID(), meta: { cwd: root }, signal })
          } catch { throw failure(signal.aborted ? 'image_operation_cancelled' : 'image_edit_session_unavailable') }
          if (typeof owned?.dispose !== 'function' || !(agent = await matchingAgent(agents, owned.agent, root))) {
            throw failure('image_edit_session_invalid')
          }
          const scoped = await capabilities(agent, signal)
          if (!scoped.available) throw failure(scoped.reason)
        }
        if (signal.aborted) throw failure('image_operation_cancelled')
        const tools = service(ctx, 'tools')
        if (typeof tools?.execute !== 'function') throw failure('image_tools_unavailable')
        const id = 'workbench-image:' + randomUUID()
        const name = mode === 'edit' ? 'edit_image' : 'generate_image'
        const args = { prompt: prompt.trim(), ...(reference ? { source_path: reference } : {}) }
        dispatched = true
        // Do not race cancellation: the DSH executor drains its started tool body.
        const batch = await tools.execute({
          calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
          signal,
          ...(agent ? { agent } : {}),
        })
        const entry = batch?.results?.[0]
        if (!Array.isArray(batch?.results) || batch.results.length !== 1 || entry?.callId !== id || !plain(entry.result)) {
          throw failure('image_generation_result_unknown', false)
        }
        const result = entry.result
        if (result.isError === true) {
          const code = result.error?.info?.code
          throw failure(code === 'UNKNOWN_TOOL' ? 'image_tool_not_executable' : 'image_tool_failed', BEFORE_DISPATCH.has(code))
        }
        if (signal.aborted) throw failure('image_generation_result_unknown', false)
        if (result.isError !== false || !plain(result.value)) throw failure('image_generation_result_unknown', false)
        const ref = attachmentOf(result.value)
        const receipt = { attachment: ref, provider: result.value.provider, model: result.value.model,
          ...(typeof result.value.channel === 'string' ? { channel: result.value.channel } : {}) }
        receipts.set(receipt, { ref: Object.freeze({ ...ref }), attachments: service(ctx, 'attachments'), signal })
        return receipt
      } catch (cause) {
        if (typeof cause?.definitive === 'boolean') throw cause
        throw failure(dispatched ? 'image_generation_result_unknown' : 'image_runtime_unavailable', !dispatched)
      } finally {
        if (typeof owned?.dispose === 'function') {
          try { await owned.dispose() }
          catch { throw failure('image_edit_session_cleanup_failed', !dispatched) }
        }
      }
    },

    async readImage(receipt) {
      const record = plain(receipt) ? receipts.get(receipt) : undefined
      if (!record) throw failure('image_receipt_invalid')
      if (record.signal.aborted) throw failure('image_generation_result_unknown', false)
      if (typeof record.attachments?.readImage !== 'function') throw failure('image_attachments_unavailable')
      let image
      try { image = await record.attachments.readImage(record.ref, record.signal) }
      catch { throw failure(record.signal.aborted ? 'image_generation_result_unknown' : 'image_attachment_read_failed', !record.signal.aborted) }
      if (record.signal.aborted) throw failure('image_generation_result_unknown', false)
      const ref = image?.ref
      if (!plain(ref) || ['attachmentId', 'mediaType', 'bytes', 'width', 'height'].some(key => ref[key] !== record.ref[key])
        || !(image.data instanceof Uint8Array) || image.data.byteLength !== record.ref.bytes) {
        throw failure('image_attachment_integrity_invalid')
      }
      return { data: Buffer.from(image.data), mime: ref.mediaType }
    },
  }
}
