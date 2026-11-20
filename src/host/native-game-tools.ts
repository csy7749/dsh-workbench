import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createNativeGameStudio } from './native-game-studio.mjs'
import { registerGuardedTool } from './tool-policy.js'
import { createNativeGamePlaytester } from './native-game-playtest.mjs'
import { nativeGameUrls } from './native-game-http.js'
import { createNativeGameAssets } from './native-game-assets.mjs'
import { createNativeGameRevisions } from './native-game-revisions.mjs'
import { createNativeGameBlender } from './native-game-blender.mjs'

interface ProductWorkspace {
  id: string
  workspacePath: string
}

export function registerNativeGameTools(ctx: any, products: () => ProductWorkspace[], options: any = {}): void {
  if (typeof ctx?.tools?.register !== 'function') return
  const studio = options.studio ?? createNativeGameStudio()
  const playtester = options.playtester ?? createNativeGamePlaytester({ studio })
  // JS factories validate dependencies at runtime; TS infers only their defaulted option keys.
  const assets = options.assets ?? createNativeGameAssets({ studio } as any)
  const revisions = options.revisions ?? createNativeGameRevisions({ studio, playtester } as any)
  const blender = options.blender ?? createNativeGameBlender({ studio, assets } as any)
  const decorate = (value: any): any => ({ ...value, provider: 'workbench-native', previewAvailable: true, ...nativeGameUrls({ prefix: options.prefix ?? '/workbench-api', productId: value.productId, slug: value.slug, buildId: value.buildId }) })
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
    // DSH supplies ToolRunContext as execute's second argument. The cancellation
    // signal is trusted host context, never a model-supplied JSON parameter.
    async execute(args: any, execution?: { signal?: AbortSignal }) {
      const signal = execution?.signal
      if (signal?.aborted) return { ok: false, error: 'game_operation_cancelled' }
      return tool.execute({ ...args, signal })
    },
  }, `workbench: ${tool.name}`)

  register({
    name: 'workbench_game_create',
    description: '在指定工作台产品的 games/<slug> 下创建本地可玩游戏并构建首版。支持 collector 2D Canvas 与 three-collector 3D Three.js/GLB 模板；只能使用 ASCII slug，不得指定绝对路径。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      productId: { type: 'string', description: '所属工作台产品 ID；产品必须已配置有效工作区。' },
      slug: { type: 'string', description: '新工程目录名，仅小写字母、数字和连字符。' },
      title: { type: 'string', description: '游戏标题。' },
      template: { type: 'string', enum: ['canvas-collector', 'three-collector'], description: 'canvas-collector 为 2D；three-collector 为离线 Three.js 3D 场景，支持 Blender GLB 模型素材。' },
      orientation: { type: 'string', enum: ['portrait', 'landscape'] },
      rules: { type: 'object', additionalProperties: false, properties: {
        durationSeconds: { type: 'integer', minimum: 1, maximum: 300 },
        hearts: { type: 'integer', minimum: 1, maximum: 9 },
      }, required: ['durationSeconds', 'hearts'] },
    }, required: ['productId', 'slug', 'title'] },
    output,
    async execute(args: any) {
      try {
        return { ok: true, ...decorate(studio.create({ workspaceRoot: resolveWorkspace(args?.productId), productId: args?.productId, slug: args?.slug, title: args?.title, orientation: args?.orientation, rules: args?.rules, template: args?.template })) }
      } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }
    },
  })

  register({
    name: 'workbench_game_build',
    description: '构建指定工作台产品下已登记 games/<slug> 工程的单文件 HTML，并返回实际构建 ID、文件字节数与 hash。不得传入工程路径。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      productId: { type: 'string', description: '所属产品 ID。' },
      slug: { type: 'string', description: '产品工作区 games/ 下的工程目录名。' },
    }, required: ['productId', 'slug'] },
    output,
    async execute(args: any) {
      try {
        return { ok: true, ...decorate(studio.build({ workspaceRoot: resolveWorkspace(args?.productId), productId: args?.productId, slug: args?.slug })) }
      } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }
    },
  })

  const parameters = { type: 'object', additionalProperties: false, properties: {
    productId: { type: 'string', description: '所属产品 ID。' },
    slug: { type: 'string', description: '产品工作区 games/ 下已登记的工程。' },
    buildId: { type: 'string', pattern: '^[a-f0-9]{12}$', description: '必须使用实际构建返回的版本 ID。' },
  }, required: ['productId', 'slug', 'buildId'] }
  for (const action of ['preview', 'export', 'playtest']) register({
    name: 'workbench_game_' + action,
    description: action === 'preview' ? '读取并核验指定版本，返回受限预览和下载地址。' : action === 'export' ? '精确导出指定构建的离线单文件 HTML；不重建、不发布。' : '使用本机已安装浏览器真实试玩指定版本，返回终局、错误、网络、截图及未覆盖项；不会下载浏览器。',
    parameters: action === 'playtest' ? { ...parameters, properties: { ...parameters.properties, seconds: { type: 'integer', minimum: 1, maximum: 60 } } } : parameters,
    output,
    async execute(args: any) {
      try {
        const target = { workspaceRoot: resolveWorkspace(args?.productId), productId: args?.productId, slug: args?.slug, buildId: args?.buildId, signal: args?.signal }
        let result: any
        if (action === 'playtest') result = await playtester.playtest({ ...target, seconds: args?.seconds })
        else if (action === 'export') result = studio.exportBuild(target)
        else { const { html, source, manifest, ...evidence } = studio.readBuild(target); result = evidence }
        return { ok: true, ...decorate(result) }
      } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }
    },
  })

  const string = { type: 'string' }
  const buildId = { type: 'string', pattern: '^[a-f0-9]{12}$' }
  const currentHash = { type: 'string', pattern: '^[a-f0-9]{64}$' }
  const assetId = { type: 'string', pattern: '^[a-f0-9]{16}$' }
  const candidateId = { type: 'string', pattern: '^[a-f0-9]{16}$' }
  const identity = { productId: string, slug: string }
  const definitions: any[] = [
    ['history', '读取经完整性核验的构建历史、源码/规则/资产差异和当前CAS指纹；不把历史试玩视为当前验收。', { action: { type: 'string', enum: ['list', 'compare', 'current', 'revisions'] }, fromBuildId: buildId, toBuildId: buildId }, ['action'], async (args: any) => args.action === 'compare' ? studio.compareBuilds(args) : args.action === 'revisions' ? revisions.list(args) : args.action === 'current' ? studio.currentState(args) : studio.listBuilds(args)],
    ['restore', '按expectedCurrentHash恢复已核验的历史快照并保存备份；恢复后必须重新试玩。', { buildId, expectedCurrentHash: currentHash }, ['buildId', 'expectedCurrentHash'], async (args: any) => studio.restoreBuild(args)],
    ['asset_list', '列出或读取素材候选；核验原生源文件和导出字节hash，返回来源/许可/兼容范围。', { assetId }, [], async (args: any) => args.assetId ? assets.read(args) : assets.list(args)],
    ['asset_generate', '生成原创受限DrawAI基础形状SVG或AnyAudio过程音效WAV及可编辑原生工程，先存为候选；不加载完整外部插件，不访问付费服务。', { provider: { type: 'string', enum: ['drawai', 'any-audio'] }, slot: { type: 'string', enum: ['pickup', 'player', 'enemyCard', 'bossCard', 'cacheCard', 'shrineCard', 'potionCard', 'pickupSound', 'hitSound'] }, recipe: { type: 'object', description: '形状shape/width/height/fill；音效preset/durationSec/sampleRate/frequency/gain/seed。宿主严格检查字段。' } }, ['provider', 'slot', 'recipe'], async (args: any) => assets.generate(args)],
    ['asset_adopt', '将已核验候选采用到指定游戏slot；CAS要求expectedBuildId仍为当前快照，嵌入离线HTML并生成新版本。', { assetId, expectedBuildId: buildId }, ['assetId', 'expectedBuildId'], async (args: any) => assets.adopt(args)],
    ['blender', '用已安装Blender执行固定受限几何recipe，保留真实blend/GLB/PNG、报告和hash；可将GLB候选采用到3D游戏，或把PNG采用到2D游戏。', { slot: { type: 'string', enum: ['pickup', 'player', 'enemyCard', 'bossCard', 'cacheCard', 'shrineCard', 'potionCard', 'pickupModel', 'playerModel'] }, recipe: { type: 'object', description: '受限primitive=crate或pickup、color、size；不能传入Python或文件路径。model槽只能用于 three-collector 工程。' } }, ['slot', 'recipe'], async (args: any) => { options.authorize?.('workbench_game_asset_generate'); return blender.generate(args) }],
    ['revision_propose', '为指定当前build创建仅game.js的不可变源码候选；不执行、不采用，不改变批准规则。', { source: string, reason: string, expectedBuildId: buildId, expectedCurrentHash: currentHash }, ['source', 'reason', 'expectedBuildId'], async (args: any) => revisions.propose(args)],
    ['revision_verify', 'CAS试用一次源码候选并真实浏览器核验；通过才采用，失败或取消回退，外部编辑冲突停止。不可重放已尝试候选。', { candidateId, seconds: { type: 'integer', minimum: 1, maximum: 60 } }, ['candidateId'], async (args: any) => { options.authorize?.('workbench_game_build'); options.authorize?.('workbench_game_playtest'); return revisions.verify(args) }],
    ['revision_recover', '显式对账崩溃或冲突后的源码候选，必须提供当前CAS指纹；不能重放未知浏览器执行，恢复后需重新试玩。', { candidateId, expectedCurrentHash: currentHash }, ['candidateId', 'expectedCurrentHash'], async (args: any) => revisions.recover(args)],
  ]
  for (const [action, description, properties, required, invoke] of definitions) register({
    name: 'workbench_game_' + action, description,
    parameters: { type: 'object', additionalProperties: false, properties: { ...identity, ...properties }, required: ['productId', 'slug', ...required] }, output,
    async execute(args: any) {
      try {
        const target = { ...args, workspaceRoot: resolveWorkspace(args?.productId) }
        const result = await invoke(target)
        return { ok: true, result: result?.buildId && result?.slug ? decorate(result) : result }
      } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }
    },
  })
}
