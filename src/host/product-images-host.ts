import { registerGuardedTool } from './tool-policy.js'
import { createProductImageService } from './product-images.mjs'
import { createProductImagesRuntime } from './product-images-runtime.mjs'

const ROOT = '/product-images'
const ROUTES: Record<string, { method: string; tool: string; fields: string[] }> = {
  state: { method: 'GET', tool: 'workbench_image_list', fields: ['productId'] },
  generate: { method: 'POST', tool: 'workbench_image_generate', fields: ['productId', 'requestId', 'mode', 'prompt', 'referenceId', 'confirmed'] },
  import: { method: 'POST', tool: 'workbench_image_import', fields: ['productId', 'requestId', 'fileName', 'mime', 'dataBase64'] },
  select: { method: 'POST', tool: 'workbench_image_select', fields: ['productId', 'candidateId', 'formatVersion', 'selected'] },
  metadata: { method: 'POST', tool: 'workbench_image_metadata', fields: ['productId', 'candidateId', 'formatVersion', 'tags', 'notes'] },
  check: { method: 'POST', tool: 'workbench_image_check', fields: ['productId', 'candidateId', 'formatVersion'] },
  preview: { method: 'GET', tool: 'workbench_image_list', fields: ['productId', 'candidateId', 'formatVersion'] },
  image: { method: 'GET', tool: 'workbench_image_export', fields: ['productId', 'candidateId', 'formatVersion', 'download'] },
}

const MAX_IMPORT_BYTES = 20 * 1024 * 1024
const MAX_IMPORT_BASE64 = Math.ceil(MAX_IMPORT_BYTES / 3) * 4

function imageBytes(value: any): Buffer {
  if (typeof value !== 'string' || value.length < 4 || value.length > MAX_IMPORT_BASE64 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('image_import_data_invalid')
  const data = Buffer.from(value, 'base64')
  if (!data.length || data.length > MAX_IMPORT_BYTES || data.toString('base64') !== value) throw new Error('image_import_data_invalid')
  return data
}

function publicError(cause: any): string {
  const message = String(cause?.message ?? '')
  if (/^(?:disabled_by_|not_in_profile)/.test(message)) return 'image_policy_denied'
  return /^(?:image_[a-z0-9_]+|product_workspace_unavailable)$/.test(message) ? message : 'image_operation_failed'
}

function statusOf(error: string): number {
  if (error === 'image_request_too_large' || error === 'image_v2_storage_limit') return 413
  if (/policy_denied|origin_invalid/.test(error)) return 403
  if (/not_found|workspace_unavailable/.test(error)) return 404
  if (/conflict|busy|integrity/.test(error)) return 409
  if (/provider_unavailable|runtime_unavailable/.test(error)) return 503
  return error === 'image_operation_failed' ? 500 : 400
}

/** One product-owned image service shared by Agent tools and the product tab. */
export function createProductImagesModule({ ctx, products, authorize = (_name: string) => {} }: any) {
  const runtime = createProductImagesRuntime(ctx)
  const service = createProductImageService({ products, generate: runtime.generate, readImage: runtime.readImage, authorize })
  const urls = (productId: string, candidate: any) => {
    const query = new URLSearchParams({ productId, candidateId: candidate.id })
    if (candidate.formatVersion === 2) query.set('formatVersion', '2')
    return { previewUrl: `/workbench-api${ROOT}/preview?${query}`, downloadUrl: `/workbench-api${ROOT}/image?${query}&download=1` }
  }
  const candidateView = (productId: string, value: any) => ({ formatVersion: 1, ...value, ...urls(productId, value) })
  const state = async (productId: string) => {
    const value = await service.state({ productId })
    const status = await runtime.status()
    return { ...value, ...status, candidates: value.candidates.map((candidate: any) => candidateView(productId, candidate)) }
  }
  const generate = async (input: any, execution?: any) => {
    const value = await service.generate({ ...input, mode: input.mode ?? 'generate', execution, signal: execution?.signal ?? input.signal })
    return { ...value, ...(value.candidate ? { candidate: candidateView(input.productId, value.candidate) } : {}) }
  }
  const importImage = async (input: any, execution?: any) => {
    const result = await service.importImage({ ...input, signal: execution?.signal ?? input.signal, data: imageBytes(input.dataBase64) })
    return { ...result, ...(result.candidate ? { candidate: candidateView(input.productId, result.candidate) } : {}) }
  }

  function registerTools(): void {
    if (typeof ctx?.tools?.register !== 'function') return
    const string = { type: 'string' }
    const id = { type: 'string', pattern: '^[a-f0-9]{32}$' }
    const definitions = [
      { name: 'workbench_image_list', description: '查看指定产品的图片候选、选择状态和生成任务。仅读取；插件缺失时仍可查看已归档图片。',
        properties: { productId: string }, required: ['productId'], execute: (args: any) => state(args.productId) },
      { name: 'workbench_image_generate', description: '使用已安装dsh-image-gen的默认渠道生成或编辑一张静态图片，保存为产品候选，不自动采用。可能消耗额度；仅在用户明确要求生成后传confirmed=true。requestId使用新的UUID，同ID重放只读取原任务，未知结果不自动重试。edit必须明确referenceId。',
        properties: { productId: string, requestId: { type: 'string', format: 'uuid' }, prompt: { type: 'string', minLength: 1, maxLength: 12000 }, mode: { type: 'string', enum: ['generate', 'edit'] }, referenceId: id, confirmed: { type: 'boolean', const: true } },
        required: ['productId', 'requestId', 'prompt', 'confirmed'], execute: generate },
      { name: 'workbench_image_import', description: '将明确提供的静态 PNG/JPEG/WebP 字节导入指定产品，校验后保存不可变原图；不读取任意路径、不调用模型、不自动采用。requestId用于安全防重。',
        properties: { productId: string, requestId: { type: 'string', format: 'uuid' }, fileName: { type: 'string', minLength: 1, maxLength: 1024 }, mime: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] }, dataBase64: { type: 'string', minLength: 4, maxLength: MAX_IMPORT_BASE64 } },
        required: ['productId', 'requestId', 'fileName', 'mime', 'dataBase64'], execute: importImage },
      { name: 'workbench_image_select', description: '明确选择或取消选择指定产品图片。只记录素材选择，不写入游戏或自动替换其他产物。',
        properties: { productId: string, candidateId: id, formatVersion: { type: 'integer', enum: [1, 2] }, selected: { type: 'boolean' } }, required: ['productId', 'candidateId', 'selected'], execute: (args: any) => service.select(args) },
      { name: 'workbench_image_metadata', description: '为 v2 产品图片候选保存标签与备注，不改动原图；检查记录以文件 hash 绑定。',
        properties: { productId: string, candidateId: id, formatVersion: { type: 'integer', const: 2 }, tags: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 80 } }, notes: { type: 'string', maxLength: 4000 } },
        required: ['productId', 'candidateId', 'formatVersion'], execute: (args: any) => service.updateMetadata(args) },
      { name: 'workbench_image_check', description: '重新核验指定 v2 产品图片的 hash、尺寸、alpha 通道及实际透明像素，并将结果绑定到当前文件 hash。',
        properties: { productId: string, candidateId: id, formatVersion: { type: 'integer', const: 2 } },
        required: ['productId', 'candidateId', 'formatVersion'], execute: (args: any) => service.check(args) },
      { name: 'workbench_image_export', description: '核验指定产品图片原图的hash并返回下载与预览地址，不重新生成、不改原图。',
        properties: { productId: string, candidateId: id, formatVersion: { type: 'integer', enum: [1, 2] } }, required: ['productId', 'candidateId'], async execute(args: any) {
          authorize('workbench_image_export')
          const image = await service.image(args)
          return { productId: args.productId, candidateId: args.candidateId, formatVersion: args.formatVersion ?? 1, mime: image.mime, bytes: image.data.length, filename: image.filename, ...urls(args.productId, { id: args.candidateId, formatVersion: args.formatVersion ?? 1 }) }
        } },
    ]
    for (const definition of definitions) registerGuardedTool(ctx, {
      name: definition.name, description: definition.description,
      parameters: { type: 'object', additionalProperties: false, properties: definition.properties, required: definition.required },
      output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args: any, execution?: any) {
        try {
          authorize(definition.name)
          if (execution?.signal?.aborted) throw new Error('image_operation_cancelled')
          return { ok: true, result: await definition.execute(args, execution) }
        } catch (cause) { return { ok: false, error: publicError(cause) } }
      },
    }, `workbench: ${definition.name}`)
  }

  return {
    registerTools,
    async handle(req: any, res: any, path: string, method: string, url: URL): Promise<boolean> {
      if (!path.startsWith(ROOT + '/')) return false
      const route = ROUTES[path.slice(ROOT.length + 1)]
      const send = (status: number, value: any, headers: any = {}) => {
        if (res.destroyed || res.writableEnded) return
        const body = JSON.stringify(value)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': String(Buffer.byteLength(body)), ...headers })
        res.end(body)
      }
      if (!route) { send(404, { ok: false, error: 'image_route_not_found' }); return true }
      if (method !== route.method) { send(405, { ok: false, error: 'image_method_not_allowed' }, { allow: route.method }); return true }
      const controller = new AbortController()
      const abort = () => controller.abort()
      const close = () => { if (!res.writableEnded) controller.abort() }
      req.on?.('aborted', abort)
      res.on?.('close', close)
      try {
        authorize(route.tool)
        if (req.headers?.['sec-fetch-site'] === 'cross-site') throw new Error('image_origin_invalid')
        let input: any
        if (method === 'GET') {
          input = Object.fromEntries(url.searchParams)
          for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new Error('image_query_invalid')
        } else {
          if (url.search || !/^application\/json(?:;|$)/i.test(req.headers?.['content-type'] ?? '')) throw new Error('image_json_required')
          if (req.headers?.origin) {
            let origin: URL
            try { origin = new URL(req.headers.origin) } catch { throw new Error('image_origin_invalid') }
            if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw new Error('image_origin_invalid')
          }
          const maxBodyBytes = path === ROOT + '/import' ? 28 * 1024 * 1024 : 64 * 1024
          const chunks: Buffer[] = []; let bytes = 0
          for await (const chunk of req) {
            bytes += chunk.length
            if (bytes > maxBodyBytes) throw new Error('image_request_too_large')
            chunks.push(Buffer.from(chunk))
          }
          try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('image_json_invalid') }
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !route.fields.includes(key))) throw new Error('image_query_invalid')
        if (input.formatVersion !== undefined) {
          const version = Number(input.formatVersion)
          if (version !== 1 && version !== 2) throw new Error('image_format_version_unsupported')
          input.formatVersion = version
        }
        if (path === ROOT + '/image' || path === ROOT + '/preview') {
          if (input.download !== undefined && input.download !== '1') throw new Error('image_query_invalid')
          if (path === ROOT + '/preview' && input.download !== undefined) throw new Error('image_query_invalid')
          const image = path === ROOT + '/preview' ? await service.preview(input) : await service.image(input)
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(200, { 'content-type': image.mime, 'content-length': String(image.data.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin', 'content-disposition': `${path === ROOT + '/image' && input.download === '1' ? 'attachment' : 'inline'}; filename="${image.filename}"` })
            res.end(image.data)
          }
        } else {
          const value = path === ROOT + '/state' ? await state(input.productId)
            : path === ROOT + '/generate' ? await generate({ ...input, signal: controller.signal })
              : path === ROOT + '/import' ? await importImage({ ...input, signal: controller.signal })
                : path === ROOT + '/select' ? await service.select(input)
                  : path === ROOT + '/metadata' ? await service.updateMetadata(input)
                    : await service.check(input)
          send(200, { ok: true, ...value })
        }
      } catch (cause) { const error = publicError(cause); send(statusOf(error), { ok: false, error }) }
      finally { req.off?.('aborted', abort); res.off?.('close', close) }
      return true
    },
  }
}
