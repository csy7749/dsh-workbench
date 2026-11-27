import { registerGuardedTool } from './tool-policy.js'
import { createNativeGameService, nativeGameToolResult } from './native-game-service.mjs'

interface ProductWorkspace {
  id: string
  workspacePath: string
}

export function registerNativeGameTools(ctx: any, products: () => ProductWorkspace[], options: any = {}): void {
  if (typeof ctx?.tools?.register !== 'function') return
  const service = options.service ?? createNativeGameService({ ...options, products })
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
    description: '创建可玩游戏并构建首版，默认 Cinderwatch 三维塔防。返回工程、构建 ID 和预览地址；不需要工作流、节点或审批包。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      productId: { type: 'string', description: '所属工作台产品 ID；产品必须已配置有效工作区。' },
      slug: { type: 'string', description: '新工程目录名，仅小写字母、数字和连字符。' },
      title: { type: 'string', description: '游戏标题。' },
      template: { type: 'string', enum: ['cinderwatch', 'canvas-collector', 'three-collector'], default: 'cinderwatch', description: 'cinderwatch 为完整微缩沙盘塔防；旧采集模板保留兼容。' },
      orientation: { type: 'string', enum: ['portrait', 'landscape'] },
      rules: { description: '省略则使用模板默认参数。', oneOf: [
        { type: 'object', additionalProperties: false, properties: {
          seed: { type: 'integer', minimum: 1, maximum: 999999 },
          biome: { type: 'string', enum: ['ashen', 'frost', 'fen', 'ember', 'dunes'] },
          startingGold: { type: 'integer', minimum: 70, maximum: 2000 },
          lives: { type: 'integer', minimum: 1, maximum: 100 },
          autoCommand: { type: 'boolean' },
        }, required: ['seed', 'biome', 'startingGold', 'lives', 'autoCommand'] },
        { type: 'object', additionalProperties: false, properties: {
          durationSeconds: { type: 'integer', minimum: 1, maximum: 300 },
          hearts: { type: 'integer', minimum: 1, maximum: 9 },
        }, required: ['durationSeconds', 'hearts'] },
      ] },
    }, required: ['productId', 'slug', 'title'] },
    output,
    async execute(args: any) {
      try {
        return { ok: true, ...nativeGameToolResult(await service.execute('create', args)) }
      } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }
    },
  })

  register({
    name: 'workbench_game_build',
    description: '构建已登记游戏的单文件 HTML，返回构建 ID、体积和预览地址；相同输入复用既有版本。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      productId: { type: 'string', description: '所属产品 ID。' },
      slug: { type: 'string', description: '产品工作区 games/ 下的工程目录名。' },
    }, required: ['productId', 'slug'] },
    output,
    async execute(args: any) {
      try {
        return { ok: true, ...nativeGameToolResult(await service.execute('build', args)) }
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
        return { ok: true, ...nativeGameToolResult(await service.execute(action, args)) }
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
    ['history', '读取经完整性核验的构建历史、源码/规则/资产差异和当前CAS指纹；不把历史试玩视为当前验收。', { action: { type: 'string', enum: ['list', 'compare', 'current', 'revisions'] }, fromBuildId: buildId, toBuildId: buildId }, ['action']],
    ['restore', '按expectedCurrentHash恢复已核验的历史快照并保存备份；恢复后必须重新试玩。', { buildId, expectedCurrentHash: currentHash }, ['buildId', 'expectedCurrentHash']],
    ['asset_list', '列出或读取素材候选；核验原生源文件和导出字节hash，返回来源/许可/兼容范围。', { assetId }, []],
    ['asset_generate', '生成原创受限DrawAI基础形状SVG或AnyAudio过程音效WAV及可编辑原生工程，先存为候选；不加载完整外部插件，不访问付费服务。', { provider: { type: 'string', enum: ['drawai', 'any-audio'] }, slot: { type: 'string', enum: ['pickup', 'player', 'enemyCard', 'bossCard', 'cacheCard', 'shrineCard', 'potionCard', 'pickupSound', 'hitSound'] }, recipe: { type: 'object', description: '形状shape/width/height/fill；音效preset/durationSec/sampleRate/frequency/gain/seed。宿主严格检查字段。' } }, ['provider', 'slot', 'recipe']],
    ['asset_adopt', '将已核验候选采用到指定游戏slot；CAS要求expectedBuildId仍为当前快照，嵌入离线HTML并生成新版本。', { assetId, expectedBuildId: buildId }, ['assetId', 'expectedBuildId']],
    ['blender', '用已安装Blender执行固定受限几何recipe，保留真实blend/GLB/PNG、报告和hash；可将GLB候选采用到3D游戏，或把PNG采用到2D游戏。', { slot: { type: 'string', enum: ['pickup', 'player', 'enemyCard', 'bossCard', 'cacheCard', 'shrineCard', 'potionCard', 'pickupModel', 'playerModel'] }, recipe: { type: 'object', description: '受限primitive=crate或pickup、color、size；不能传入Python或文件路径。model槽只能用于 three-collector 工程。' } }, ['slot', 'recipe']],
    ['revision_propose', '为指定当前build创建仅game.js的不可变源码候选；不执行、不采用，不改变批准规则。', { source: string, reason: string, expectedBuildId: buildId, expectedCurrentHash: currentHash }, ['source', 'reason', 'expectedBuildId']],
    ['revision_verify', 'CAS试用一次源码候选并真实浏览器核验；通过才采用，失败或取消回退，外部编辑冲突停止。不可重放已尝试候选。', { candidateId, seconds: { type: 'integer', minimum: 1, maximum: 60 } }, ['candidateId']],
    ['revision_recover', '显式对账崩溃或冲突后的源码候选，必须提供当前CAS指纹；不能重放未知浏览器执行，恢复后需重新试玩。', { candidateId, expectedCurrentHash: currentHash }, ['candidateId', 'expectedCurrentHash']],
  ]
  for (const [action, description, properties, required] of definitions) register({
    name: 'workbench_game_' + action, description,
    parameters: { type: 'object', additionalProperties: false, properties: { ...identity, ...properties }, required: ['productId', 'slug', ...required] }, output,
    async execute(args: any) {
      try {
        return { ok: true, result: nativeGameToolResult(await service.execute(action, args)) }
      } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) } }
    },
  })
}
