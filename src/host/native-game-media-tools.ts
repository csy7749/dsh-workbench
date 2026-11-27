import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createNativeGameMedia } from './native-game-media.mjs'
import { registerGuardedTool } from './tool-policy.js'

interface ProductWorkspace {
  id: string
  workspacePath: string
}

export function registerNativeGameMediaTools(ctx: any, products: () => ProductWorkspace[], options: any = {}): void {
  if (typeof ctx?.tools?.register !== 'function') return
  const media = options.media ?? createNativeGameMedia()
  const resolveWorkspace = (productId: unknown): string => {
    if (typeof productId !== 'string' || productId === '') throw new Error('product_id_required')
    const product = products().find(item => item.id === productId)
    if (!product || typeof product.workspacePath !== 'string' || !isAbsolute(product.workspacePath)) throw new Error('product_workspace_unavailable')
    const workspace = realpathSync(product.workspacePath)
    if (!statSync(workspace).isDirectory()) throw new Error('product_workspace_invalid')
    return workspace
  }
  const output = { schema: {}, render: (_args: unknown, result: any) => [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  const register = (tool: any): void => registerGuardedTool(ctx, {
    ...tool,
    async execute(args: any, execution?: { signal?: AbortSignal }) {
      const signal = execution?.signal
      if (signal?.aborted) return { ok: false, error: 'game_operation_cancelled' }
      return tool.execute({ ...args, signal })
    },
  }, `workbench: ${tool.name}`)

  const identity = {
    productId: { type: 'string', description: '所属工作台产品 ID；产品必须已配置有效工作区。' },
    slug: { type: 'string', description: '产品工作区 games/ 下已登记的游戏工程。' },
  }
  const run = (name: string, description: string, properties: Record<string, any>, required: string[], invoke: (args: any) => Promise<any>): void => register({
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, properties: { ...identity, ...properties }, required: ['productId', 'slug', ...required] },
    output,
    async execute(args: any) {
      try {
        const result = await invoke({ ...args, workspaceRoot: resolveWorkspace(args?.productId) })
        return { ok: true, result }
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
      }
    },
  })

  run(
    'workbench_game_media_crop',
    '在已登记游戏工程内按源像素裁切图片，输出到独立 .studio/media/crop/<runId> 目录并写入 manifest；不修改游戏源码或素材候选。',
    {
      sourcePath: { type: 'string', minLength: 1, description: '相对于游戏工程目录的图片路径；不允许绝对路径、.. 或符号链接。' },
      left: { type: 'integer', minimum: 0 },
      top: { type: 'integer', minimum: 0 },
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    },
    ['sourcePath', 'left', 'top', 'width', 'height'],
    args => media.crop(args),
  )

  run(
    'workbench_game_media_grid_split',
    '按行优先将已登记游戏工程内的精灵表切成网格帧，输出帧文件、grid.json 和 manifest 到独立 .studio/media/grid-split/<runId> 目录。',
    {
      sourcePath: { type: 'string', minLength: 1, description: '相对于游戏工程目录的精灵表路径；不允许绝对路径、.. 或符号链接。' },
      columns: { type: 'integer', minimum: 1, maximum: 100 },
      rows: { type: 'integer', minimum: 1, maximum: 100 },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    },
    ['sourcePath', 'columns', 'rows'],
    args => media.splitGrid(args),
  )
}
