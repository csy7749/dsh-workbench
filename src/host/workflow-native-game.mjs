import { createHash } from 'node:crypto'
import { createNativeGameService } from './native-game-service.mjs'
import { validateGamePlaytestEvidence } from '../packs/game/review.mjs'
import { readNativeGameRules } from '../packs/game/validators.mjs'

export const NATIVE_GAME_NODES = new Set(['game.create', 'game.playtest', 'game.revise', 'game.build', 'game.package'])
const tools = { 'game.create': 'workbench_game_create', 'game.build': 'workbench_game_build', 'game.playtest': 'workbench_game_playtest', 'game.revise': 'workbench_game_build', 'game.package': 'workbench_game_export' }

/** Trusted host adapter. Models never choose the run, workspace or source receipt. */
export function createWorkflowNativeGame(options) {
  const { authorize = () => {} } = options
  const service = options.service ?? createNativeGameService(options)
  const { studio, playtester, assets, revisions, blender, workspaceOf } = service
  return {
    service, studio, playtester, assets, revisions, blender,
    capabilities: () => service.capabilities(),
    async preflight({ productId, nodes }) {
      workspaceOf(productId)
      const enabled = nodes.filter(node => !node.disabled && !node.node?.disabled)
      for (const node of enabled.filter(node => NATIVE_GAME_NODES.has(node.type))) {
        authorize(tools[node.type])
        if (node.type === 'game.playtest' && Number(node.node?.config?.maxRepairs ?? node.config?.maxRepairs ?? 0) > 0) {
          authorize('workbench_game_revision_propose'); authorize('workbench_game_revision_verify'); authorize('workbench_game_build')
        }
        if (node.type === 'game.create' && !['cinderwatch', 'collector', 'canvas-collector', undefined].includes(node.node?.config?.template ?? node.config?.template)) throw new Error('game_template_unavailable: 请选择 Cinderwatch 塔防；collector 仅用于兼容已有运行。')
      }
      if (enabled.some(node => node.type === 'game.playtest')) {
        const capability = await playtester.probe()
        if (!capability.available) throw new Error('capability_unavailable: ' + (capability.reason ?? 'game_browser_unavailable'))
      }
    },
    async execute({ runId, nodeId, attemptId, productId, type, config = {}, sources = [], approved = [], signal }) {
      authorize(tools[type])
      if (signal?.aborted) throw new Error('game_operation_cancelled')
      const workspaceRoot = workspaceOf(productId)
      const workspaceIdentity = createHash('sha256').update(workspaceRoot).digest('hex')
      const common = { productId }
      const decorate = value => ({ ...value, provider: 'workbench-native', workspaceIdentity, scope: { runId, nodeId, attemptId } })
      if (type === 'game.create') {
        if (approved.length !== 1) throw new Error('game_approved_design_required')
        const rules = readNativeGameRules(approved[0].rules)
        const template = rules.nativeTemplate === 'cinderwatch@1' ? 'cinderwatch' : 'canvas-collector'
        const configuredTemplate = config.template === 'collector' ? 'canvas-collector' : config.template
        if (configuredTemplate && configuredTemplate !== template) throw new Error('game_approved_template_mismatch: 节点模板与已批准玩法不一致，请核对后重新批准。')
        const approvedParameters = template === 'cinderwatch'
          ? { seed: rules.seed, biome: rules.biome, startingGold: rules.startingGold, lives: rules.lives, autoCommand: rules.autoCommand }
          : { durationSeconds: rules.durationSeconds, hearts: rules.hearts }
        const slug = (template === 'cinderwatch' ? 'cinderwatch-' : 'starlight-') + createHash('sha256').update(JSON.stringify([productId, runId, nodeId, attemptId])).digest('hex').slice(0, 12)
        if (rules.creativePack === 'local-original-v1') { authorize('workbench_game_asset_generate'); authorize('workbench_game_asset_adopt') }
        let result = await service.execute('create', { ...common, slug, title: rules.title, template, orientation: config.orientation ?? (template === 'cinderwatch' ? 'landscape' : 'portrait'), rules: approvedParameters })
        const adoptedAssets = []
        if (rules.creativePack === 'local-original-v1') {
          for (const [provider, slot, recipe] of [
            ['drawai', 'pickup', { shape: 'diamond', width: 64, height: 64, fill: '#f5c451' }],
            ['drawai', 'player', { shape: 'rect', width: 64, height: 64, fill: '#67d5b5' }],
            ['any-audio', 'pickupSound', { preset: 'coin', durationSec: 0.18, sampleRate: 24000, frequency: 880, gain: 0.18, seed: 42 }],
            ['any-audio', 'hitSound', { preset: 'hit', durationSec: 0.22, sampleRate: 24000, frequency: 150, gain: 0.16, seed: 43 }],
          ]) {
            if (signal?.aborted) throw new Error('game_operation_cancelled')
            const candidate = await service.execute('asset_generate', { ...common, slug, provider, slot, recipe, signal })
            result = await service.execute('asset_adopt', { ...common, slug, assetId: candidate.assetId, expectedBuildId: result.buildId })
            adoptedAssets.push({ assetId: candidate.assetId, slot, hash: candidate.hash, provider })
          }
        }
        return decorate({ ...result, adoptedAssets, implementedScope: template === 'cinderwatch' ? 'Cinderwatch Three.js 塔防模板及批准参数：建塔、升级、敌人波次、金币经济、生命与自动指挥接管；程序化模型、纹理与声音。' : '已有 collector 模板的兼容运行及批准参数。' })
      }
      const projects = [...new Set(sources.map(item => item.result.projectId).filter(Boolean))]
      if (projects.length !== 1) throw new Error('game_trusted_project_required')
      const source = sources.at(-1)?.result
      if (!source || !source.slug || sources.some(item => item.result.productId !== productId || item.result.slug !== source.slug || item.result.workspaceIdentity !== workspaceIdentity)) throw new Error('game_project_scope_mismatch')
      const target = { ...common, slug: source.slug, buildId: source.buildId }
      const readTarget = { ...target, workspaceRoot }
      if (type === 'game.build') return decorate(await service.execute('build', target))
      if (type === 'game.playtest') {
        let result = await service.execute('playtest', { ...target, seconds: Number(config.seconds ?? 20), signal })
        const repairs = [], failedPlaytests = []
        const template = studio.readBuild(readTarget).template
        if (template === 'canvas-collector' && result.playtestStatus === 'failed' && result.buildCurrent && !signal?.aborted && Number(config.maxRepairs ?? 1) > 0) {
          // Repair inside the trusted operation: failed reports never pass the node's
          // required check. The sole deterministic fix restores approved template code.
          failedPlaytests.push({ buildId: result.buildId, reportPath: result.reportPath, reportHash: result.reportHash })
          authorize('workbench_game_revision_propose'); authorize('workbench_game_revision_verify')
          try {
            const candidate = await service.execute('revision_canonical', { ...target, expectedBuildId: result.buildId })
            const repaired = await service.execute('revision_verify', { ...target, candidateId: candidate.candidateId, seconds: Number(config.seconds ?? 20), signal })
            repairs.push({ candidateId: candidate.candidateId, accepted: repaired.accepted, status: repaired.status, provider: 'native-template-repair' })
            if (repaired.accepted) result = repaired.report
          } catch (cause) {
            if (signal?.aborted) throw cause
            if (cause.message !== 'game_revision_no_change') repairs.push({ accepted: false, error: cause.message })
          }
        }
        const { html, source: gameSource, manifest, ...testedBuild } = studio.readBuild({ ...readTarget, buildId: result.buildId })
        return decorate({ ...source, ...testedBuild, ...result, buildCurrent: result.buildCurrent && testedBuild.buildCurrent, productId, slug: source.slug, projectId: source.projectId, repairs, failedPlaytests })
      }
      const built = sources.filter(item => ['game.create', 'game.build'].includes(item.type)).at(-1)?.result
      const tested = sources.filter(item => item.type === 'game.playtest').at(-1)?.result
      if (!built || !tested || built.projectId !== tested.projectId || !validateGamePlaytestEvidence(JSON.stringify(tested))) throw new Error('game_clean_playtest_required')
      const actualTest = studio.readPlaytest({ ...readTarget, buildId: tested.buildId, reportPath: tested.reportPath, reportHash: tested.reportHash })
      if (!validateGamePlaytestEvidence(JSON.stringify(actualTest)) || actualTest.playtestStatus !== 'passed') throw new Error('game_clean_playtest_required')
      const current = studio.readBuild({ ...readTarget, buildId: tested.buildId })
      if (!current.buildCurrent) throw new Error('game_build_changed_after_playtest')
      const { html, source: gameSource, manifest, ...currentReceipt } = current
      if (type === 'game.revise') return decorate({ ...built, ...currentReceipt, changes: (tested.repairs ?? []).filter(item => item.accepted).map(item => '经真实浏览器核验后采用标准源码修复候选 ' + item.candidateId), noChangesReason: '本步核对源码与已通过的被测快照一致；当前报告未要求额外源码修改。新源码候选须单独核验，自动试玩仍不替代人工玩法与难度验收。', repairs: tested.repairs ?? [], manualChecksRequired: tested.unassessed ?? ['人工验证玩法、失败与重开。'] })
      if (type === 'game.package') return decorate({ ...await service.execute('export', { ...target, buildId: tested.buildId }), playtestReport: tested.reportPath, playtestBuildId: tested.buildId })
      throw new Error('game_operation_unavailable')
    },
  }
}
