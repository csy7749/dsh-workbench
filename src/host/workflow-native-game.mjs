import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { createNativeGameStudio } from './native-game-studio.mjs'
import { createNativeGamePlaytester } from './native-game-playtest.mjs'
import { createNativeGameAssets } from './native-game-assets.mjs'
import { createNativeGameRevisions } from './native-game-revisions.mjs'
import { createNativeGameBlender } from './native-game-blender.mjs'
import { nativeGameUrls } from './native-game-http.ts'
import { validateGamePlaytestEvidence } from '../packs/game/review.mjs'
import { readNativeCollectorRules } from '../packs/game/validators.mjs'

export const NATIVE_GAME_NODES = new Set(['game.create', 'game.playtest', 'game.revise', 'game.build', 'game.package'])
const tools = { 'game.create': 'workbench_game_create', 'game.build': 'workbench_game_build', 'game.playtest': 'workbench_game_playtest', 'game.revise': 'workbench_game_build', 'game.package': 'workbench_game_export' }

/** Trusted host adapter. Models never choose the run, workspace or source receipt. */
export function createWorkflowNativeGame({ products, studio = createNativeGameStudio(), playtester = createNativeGamePlaytester({ studio }), assets = createNativeGameAssets({ studio }), revisions = createNativeGameRevisions({ studio, playtester }), blender = createNativeGameBlender({ studio, assets }), authorize = () => {}, prefix = '/workbench-api' }) {
  const workspaceOf = productId => {
    const product = products().find(item => item.id === productId)
    if (!product || !isAbsolute(product.workspacePath ?? '')) throw new Error('game_product_workspace_required')
    const root = realpathSync(product.workspacePath)
    if (!statSync(root).isDirectory()) throw new Error('game_product_workspace_required')
    return root
  }
  const decorate = value => ({ ...value, provider: 'workbench-native', previewAvailable: true, ...nativeGameUrls({ prefix, productId: value.productId, slug: value.slug, buildId: value.buildId }) })
  return {
    studio, playtester, assets, revisions, blender,
    async capabilities() {
      const browser = await playtester.probe()
      return { provider: 'workbench-native', version: 2, templates: ['canvas-collector'], operations: { create: true, build: true, preview: true, export: true, playtest: browser.available, revise: 'source-candidate-cas-browser-rollback', automaticRepair: 'canonical-collector-only', versions: true, assets: true }, browser, creative: { drawai: { available: true, formats: ['drawai', 'svg'], scope: 'original-basic-shapes' }, anyAudio: { available: true, formats: ['project.json', 'wav'], scope: 'original-procedural-sfx' }, blender: await blender.probe() }, limitations: ['固定 collector 模板；自动修复最多一次且仅恢复标准源码，不改变批准规则。', 'DrawAI / AnyAudio 为受限原生格式桥，不加载整套外部插件或付费服务。', '自动试玩不等于人工验收。'] }
    },
    async preflight({ productId, nodes }) {
      workspaceOf(productId)
      const enabled = nodes.filter(node => !node.disabled && !node.node?.disabled)
      for (const node of enabled.filter(node => NATIVE_GAME_NODES.has(node.type))) {
        authorize(tools[node.type])
        if (node.type === 'game.playtest' && Number(node.node?.config?.maxRepairs ?? node.config?.maxRepairs ?? 1) > 0) {
          authorize('workbench_game_revision_propose'); authorize('workbench_game_revision_verify'); authorize('workbench_game_build')
        }
        if (node.type === 'game.create' && !['collector', 'canvas-collector', undefined].includes(node.node?.config?.template ?? node.config?.template)) throw new Error('game_template_unavailable: 原生工坊当前只支持 2D collector')
      }
      if (enabled.some(node => node.type === 'game.playtest')) {
        const capability = await playtester.probe()
        if (!capability.available) throw new Error('capability_unavailable: ' + (capability.reason ?? 'game_browser_unavailable'))
      }
    },
    async execute({ runId, nodeId, attemptId, productId, type, config, sources, approved, signal }) {
      authorize(tools[type])
      if (signal.aborted) throw new Error('game_operation_cancelled')
      const workspaceRoot = workspaceOf(productId)
      const workspaceIdentity = createHash('sha256').update(workspaceRoot).digest('hex')
      const common = { workspaceRoot, productId }
      if (type === 'game.create') {
        if (approved.length !== 1) throw new Error('game_approved_design_required')
        const rules = readNativeCollectorRules(approved[0].rules)
        const { durationSeconds, hearts } = rules
        const slug = 'starlight-' + createHash('sha256').update(JSON.stringify([productId, runId, nodeId, attemptId])).digest('hex').slice(0, 12)
        if (rules.creativePack === 'local-original-v1') { authorize('workbench_game_asset_generate'); authorize('workbench_game_asset_adopt') }
        let result = studio.create({ ...common, slug, title: rules.title, orientation: config.orientation ?? 'portrait', rules: { durationSeconds, hearts } })
        const adoptedAssets = []
        if (rules.creativePack === 'local-original-v1') {
          for (const [provider, slot, recipe] of [
            ['drawai', 'pickup', { shape: 'diamond', width: 64, height: 64, fill: '#f5c451' }],
            ['drawai', 'player', { shape: 'rect', width: 64, height: 64, fill: '#67d5b5' }],
            ['any-audio', 'pickupSound', { preset: 'coin', durationSec: 0.18, sampleRate: 24000, frequency: 880, gain: 0.18, seed: 42 }],
            ['any-audio', 'hitSound', { preset: 'hit', durationSec: 0.22, sampleRate: 24000, frequency: 150, gain: 0.16, seed: 43 }],
          ]) {
            if (signal.aborted) throw new Error('game_operation_cancelled')
            const candidate = await assets.generate({ ...common, slug, provider, slot, recipe, signal })
            result = assets.adopt({ ...common, slug, assetId: candidate.assetId, expectedBuildId: result.buildId })
            adoptedAssets.push({ assetId: candidate.assetId, slot, hash: candidate.hash, provider })
          }
        }
        return decorate({ ...result, adoptedAssets, workspaceIdentity, scope: { runId, nodeId, attemptId }, implementedScope: '固定 2D collector 模板及批准参数；可选原创本地素材包，自定义机制需另行实现与验收。' })
      }
      const projects = [...new Set(sources.map(item => item.result.projectId).filter(Boolean))]
      if (projects.length !== 1) throw new Error('game_trusted_project_required')
      const source = sources.at(-1)?.result
      if (!source || source.productId !== productId || !source.slug || sources.some(item => item.result.workspaceIdentity !== workspaceIdentity)) throw new Error('game_project_scope_mismatch')
      const target = { ...common, slug: source.slug, buildId: source.buildId }
      if (type === 'game.build') return decorate({ ...studio.build(target), workspaceIdentity })
      if (type === 'game.playtest') {
        let result = await playtester.playtest({ ...target, seconds: Number(config.seconds ?? 20), signal })
        const repairs = [], failedPlaytests = []
        if (result.playtestStatus === 'failed' && result.buildCurrent && !signal.aborted && Number(config.maxRepairs ?? 1) > 0) {
          // Repair inside the trusted operation: failed reports never pass the node's
          // required check. The sole deterministic fix restores approved template code.
          failedPlaytests.push({ buildId: result.buildId, reportPath: result.reportPath, reportHash: result.reportHash })
          authorize('workbench_game_revision_propose'); authorize('workbench_game_revision_verify')
          try {
            const candidate = revisions.canonical({ ...target, expectedBuildId: result.buildId })
            const repaired = await revisions.verify({ ...target, candidateId: candidate.candidateId, seconds: Number(config.seconds ?? 20), signal })
            repairs.push({ candidateId: candidate.candidateId, accepted: repaired.accepted, status: repaired.status, provider: 'native-template-repair' })
            if (repaired.accepted) result = repaired.report
          } catch (cause) {
            if (signal.aborted) throw cause
            if (cause.message !== 'game_revision_no_change') repairs.push({ accepted: false, error: cause.message })
          }
        }
        const { html, source: gameSource, manifest, ...testedBuild } = studio.readBuild({ ...target, buildId: result.buildId })
        return decorate({ ...source, ...testedBuild, ...result, buildCurrent: result.buildCurrent && testedBuild.buildCurrent, productId, slug: source.slug, projectId: source.projectId, repairs, failedPlaytests })
      }
      const built = sources.filter(item => ['game.create', 'game.build'].includes(item.type)).at(-1)?.result
      const tested = sources.filter(item => item.type === 'game.playtest').at(-1)?.result
      if (!built || !tested || built.projectId !== tested.projectId || !validateGamePlaytestEvidence(JSON.stringify(tested))) throw new Error('game_clean_playtest_required')
      const actualTest = studio.readPlaytest({ ...target, buildId: tested.buildId, reportPath: tested.reportPath, reportHash: tested.reportHash })
      if (!validateGamePlaytestEvidence(JSON.stringify(actualTest)) || actualTest.playtestStatus !== 'passed') throw new Error('game_clean_playtest_required')
      const current = studio.readBuild({ ...target, buildId: tested.buildId })
      if (!current.buildCurrent) throw new Error('game_build_changed_after_playtest')
      const { html, source: gameSource, manifest, ...currentReceipt } = current
      if (type === 'game.revise') return decorate({ ...built, ...currentReceipt, changes: (tested.repairs ?? []).filter(item => item.accepted).map(item => '经真实浏览器核验后采用标准源码修复候选 ' + item.candidateId), noChangesReason: '真实自动试玩未发现待修缺陷；本步核对源码与被测快照一致。自动修复仅限恢复标准源码，自定义候选需单独核验。', repairs: tested.repairs ?? [], manualChecksRequired: tested.unassessed ?? ['人工验证玩法、失败与重开。'] })
      if (type === 'game.package') return decorate({ ...studio.exportBuild({ ...target, buildId: tested.buildId }), workspaceIdentity, playtestReport: tested.reportPath, playtestBuildId: tested.buildId })
      throw new Error('game_operation_unavailable')
    },
  }
}
