import { isAbsolute } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { createNativeGameStudio } from './native-game-studio.mjs'
import { createNativeGamePlaytester } from './native-game-playtest.mjs'
import { createNativeGameAssets } from './native-game-assets.mjs'
import { createNativeGameRevisions } from './native-game-revisions.mjs'
import { createNativeGameBlender } from './native-game-blender.mjs'
import { nativeGameUrls } from './native-game-http.ts'

const actions = new Set(['create', 'build', 'preview', 'export', 'playtest', 'history', 'restore', 'asset_list', 'asset_generate', 'asset_adopt', 'blender', 'revision_propose', 'revision_verify', 'revision_recover', 'revision_canonical'])

/** Game operations shared by tools and workflow adapters. No run, node, adoption
 * or workflow snapshot is needed to create, edit, test or export a game. Build
 * versions belong to the game project and retain their usual integrity checks. */
export function createNativeGameService({ products, studio = createNativeGameStudio(), playtester = createNativeGamePlaytester({ studio }), assets = createNativeGameAssets({ studio }), revisions = createNativeGameRevisions({ studio, playtester }), blender = createNativeGameBlender({ studio, assets }), authorize = () => {}, prefix = '/workbench-api' } = {}) {
  const workspaceOf = productId => {
    if (typeof productId !== 'string' || !productId) throw new Error('product_id_required')
    const product = products?.().find(item => item.id === productId)
    if (!product || !isAbsolute(product.workspacePath ?? '')) throw new Error('product_workspace_unavailable')
    try {
      const root = realpathSync(product.workspacePath)
      if (!statSync(root).isDirectory()) throw new Error('not_directory')
      return root
    } catch { throw new Error('product_workspace_unavailable') }
  }
  const decorate = value => value?.productId && value?.slug && value?.buildId
    ? { ...value, provider: 'workbench-native', previewAvailable: true, ...nativeGameUrls({ prefix, productId: value.productId, slug: value.slug, buildId: value.buildId }) }
    : value

  return {
    studio, playtester, assets, revisions, blender, workspaceOf,
    async capabilities() {
      const browser = await playtester.probe()
      return { provider: 'workbench-native', version: 3, templates: ['cinderwatch', 'canvas-collector', 'three-collector'], defaultTemplate: 'cinderwatch', operations: { create: true, build: true, preview: true, export: true, playtest: browser.available, versions: true, assets: true, revise: 'source-candidate-cas-browser-rollback', automaticRepair: 'canonical-template-only' }, browser,
        creative: { drawai: { available: true, formats: ['drawai', 'svg'], scope: 'original-basic-shapes' }, anyAudio: { available: true, formats: ['project.json', 'wav'], scope: 'original-procedural-sfx' }, blender: await blender.probe() },
        limitations: ['Cinderwatch 使用程序化模型、纹理和声音；当前不采用外部图片或 GLB 槽。', '旧采集模板仅保留兼容；不同模板使用各自的试玩策略。', '自动试玩不等于人工验收。'] }
    },
    async execute(action, input = {}) {
      if (!actions.has(action)) throw new Error('game_operation_unavailable')
      if (input.signal?.aborted) throw new Error('game_operation_cancelled')
      authorize('workbench_game_' + (action === 'revision_canonical' ? 'revision_propose' : action))
      // A caller-supplied workspace never overrides the product registry.
      const args = { ...input, workspaceRoot: workspaceOf(input.productId) }
      let result
      switch (action) {
        case 'create': {
          const template = args.template ?? 'cinderwatch'
          result = studio.create({ ...args, template, orientation: args.orientation ?? (template === 'cinderwatch' ? 'landscape' : 'portrait') })
          break
        }
        case 'build': result = studio.build(args); break
        case 'preview': {
          const { html, source, manifest, ...receipt } = studio.readBuild(args)
          result = receipt
          break
        }
        case 'export': result = studio.exportBuild(args); break
        case 'playtest': result = await playtester.playtest(args); break
        case 'history':
          if (!['list', 'compare', 'current', 'revisions'].includes(args.action)) throw new Error('game_history_action_invalid')
          result = args.action === 'compare' ? studio.compareBuilds(args) : args.action === 'current' ? studio.currentState(args) : args.action === 'revisions' ? revisions.list(args) : studio.listBuilds(args)
          break
        case 'restore': result = studio.restoreBuild(args); break
        case 'asset_list': result = args.assetId ? assets.read(args) : assets.list(args); break
        case 'asset_generate': result = await assets.generate(args); break
        case 'asset_adopt': result = assets.adopt(args); break
        case 'blender':
          authorize('workbench_game_asset_generate')
          result = await blender.generate(args)
          break
        case 'revision_propose': result = revisions.propose(args); break
        case 'revision_canonical': result = revisions.canonical(args); break
        case 'revision_verify':
          authorize('workbench_game_build'); authorize('workbench_game_playtest')
          result = await revisions.verify(args)
          break
        case 'revision_recover': result = revisions.recover(args); break
      }
      return decorate(result)
    },
  }
}

// The default Agent response is a useful operation receipt, rather than the
// workflow's evidence envelope or the project's source/manifest/base64 bytes.
const summaryFields = new Set([
  'productId', 'projectId', 'slug', 'project', 'title', 'template', 'buildId', 'buildStatus', 'buildCurrent', 'bytes', 'artifact',
  'previewAvailable', 'previewUrl', 'downloadUrl', 'exportPath', 'exported', 'offline', 'reused', 'playtestStatus', 'finalPhase',
  'errors', 'requests', 'inputs', 'checks', 'reportPath', 'screenshots', 'unassessed', 'summary',
  'assetId', 'slot', 'mime', 'status', 'candidateId', 'accepted', 'reason', 'error', 'currentHash',
  'sourcePath', 'outputPath', 'manifestPath', 'sourceChanged', 'manifestChanged', 'fromBuildId', 'toBuildId',
  'origin', 'compatibility',
])

export function nativeGameToolResult(value) {
  if (Array.isArray(value)) return value.map(nativeGameToolResult)
  if (!value || typeof value !== 'object') return value
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => summaryFields.has(key)))
  if (value.report) result.report = nativeGameToolResult(value.report)
  if (value.fromBuildId && value.toBuildId) {
    if (value.source && typeof value.source === 'object') result.sourceDiff = { changed: value.source.changed, addedLines: value.source.addedLines, removedLines: value.source.removedLines }
    if (Array.isArray(value.manifest?.changedFields)) result.changedFields = value.manifest.changedFields
  }
  return result
}
