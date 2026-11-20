import { GAME_CHECKS, validateGameRules } from './validators.mjs'
import { REVIEW_CHECK, validateGameReview, validateGameHandoff, parseGameHandoff, gameHandoffError, validateGameProjectEvidence, validateGamePlaytestEvidence, validateGamePackageEvidence, validateGameRevisionEvidence } from './review.mjs'
import { parseGameReview } from './review.mjs'
import { gameReviewSources, gameHandoffSources } from './review-sources.mjs'
export { gameHandoffSources }
export const checks = Object.fromEntries([
  ...GAME_CHECKS.map(name => [name, content => validateGameRules(content).find(check => check.name === name)]),
  [REVIEW_CHECK, content => ({ verdict: validateGameReview(content) ? 'pass' : 'fail', reason: 'review_documents_validation' })],
  ['game.handoff.evidence', content => ({ verdict: validateGameHandoff(content) ? 'pass' : 'fail', reason: 'manual_playtest_evidence_required' })],
  ['game.project.evidence', content => ({ verdict: validateGameProjectEvidence(content) ? 'pass' : 'fail', reason: 'game_project_build_identity_required' })],
  ['game.revision.evidence', content => ({ verdict: validateGameRevisionEvidence(content) ? 'pass' : 'fail', reason: 'game_revision_record_required' })],
  ['game.playtest.evidence', content => ({ verdict: validateGamePlaytestEvidence(content) ? 'pass' : 'fail', reason: 'playable_clean_automated_test_required' })],
  ['game.package.evidence', content => ({ verdict: validateGamePackageEvidence(content) ? 'pass' : 'fail', reason: 'offline_html_export_required' })],
])

export const reviewContract = {
  kind: 'game-review-v1', requiredChecks: [REVIEW_CHECK],
  fields: [{ key: 'gdd', label: '设计稿 Markdown' }, { key: 'rules', label: '规则 JSON（确认时重新校验）' }],
  dependentSource: 'gdd', regenerateLabel: '应用设计稿并重新生成规则',
  parse: parseGameReview, sources: gameReviewSources,
  validateSources: nodes => {
    if (['input.brief', 'game.gdd', 'game.rules', 'check.rules'].some(type => nodes.filter(node => node.type === type).length > 1)) throw new Error('review_sources_ambiguous: 人工审核上游存在多组同类型产物，请拆分审核节点。')
  },
  initialize: (compiled, nodeId, content) => {
    const sources = gameReviewSources(compiled, nodeId)
    return JSON.stringify({ kind: 'game-review-v1', gdd: content(sources.gdd), rules: content(sources.rules) }, null, 2)
  },
}

export const gameHandoffReviewContract = {
  kind: 'game-handoff-v1', requiredChecks: ['game.handoff.evidence'],
  fields: [
    { key: 'status', label: '人工试玩结论（必须填写：通过）' },
    { key: 'buildId', label: '实际打开的构建 ID（12 位构建 ID）' },
    { key: 'tester', label: '试玩者' },
    { key: 'platform', label: '设备与浏览器' },
    { key: 'playDurationMinutes', label: '实际试玩分钟数（例如 1 或 0.5）' },
    { key: 'observations', label: '从打开到完成一轮的实际过程与观察' },
    { key: 'knownIssues', label: '已知问题（无则填写“无”）' },
    { key: 'evidencePath', label: '导出 HTML 路径（保留预填的项目相对路径）' },
  ],
  parse: parseGameHandoff,
  sources: gameHandoffSources,
  validateSources: nodes => {
    if (!nodes.some(node => node.type === 'game.build') || !nodes.some(node => node.type === 'game.playtest') || !nodes.some(node => node.type === 'game.package')) {
      throw new Error('handoff_sources_missing: 人工验收需要最终构建、自动试玩和离线导出作为上游。')
    }
  },
  initialize: (compiled, nodeId, contentOf) => {
    const sources = gameHandoffSources(compiled, nodeId)
    let built, packaged
    try { built = JSON.parse(contentOf(sources.build)); packaged = JSON.parse(contentOf(sources.package)) } catch {}
    return JSON.stringify({
      kind: 'game-handoff-v1', version: 1, status: '未通过', buildId: built?.buildId ?? '', tester: '', platform: '',
      playDurationMinutes: '', observations: '', knownIssues: '', evidencePath: packaged?.exportPath ?? '',
    }, null, 2)
  },
  validate: (content, compiled, nodeId, contentOf) => {
    const value = parseGameHandoff(content)
    const formError = gameHandoffError(value)
    if (formError) return formError
    const sources = gameHandoffSources(compiled, nodeId)
    if (!sources.build || !sources.playtest || !sources.package) return '最终构建、自动试玩或离线导出证据缺失。'
    let tested, packaged
    try {
      tested = JSON.parse(contentOf(sources.playtest))
      packaged = JSON.parse(contentOf(sources.package))
    } catch { return '最终自动试玩和 HTML 导出必须保存为可读取的 JSON 证据。' }
    let built
    try { built = JSON.parse(contentOf(sources.build)) } catch { return '最终构建必须保存为可读取的 JSON 证据。' }
    if (!validateGameProjectEvidence(JSON.stringify(built))) return '最终构建证据格式无效。'
    if (!validateGamePlaytestEvidence(JSON.stringify(tested))) return '最终构建没有通过完整自动试玩、错误/网络检查或未保存截图；请先修复并重新试玩。'
    if (!validateGamePackageEvidence(JSON.stringify(packaged))) return '离线 HTML 导出证据格式无效。'
    if (tested.project !== built.project || packaged.project !== built.project || tested.buildId !== built.buildId || packaged.buildId !== built.buildId) return '最终构建、自动试玩与导出的项目或构建 ID 不一致。'
    if (value.buildId !== built.buildId) return `请使用本次实际试玩的构建 ID ${built.buildId}。`
    if (value.evidencePath.trim() !== packaged.exportPath) return `人工试玩必须针对本次导出的同一份 HTML。请将「导出 HTML 路径」恢复为 ${packaged.exportPath}。`
    return null
  },
}

export function ruleChecks(type, content) {
  if (type === 'game.rules') return validateGameRules(content)
  if (type === 'game.create' || type === 'game.build') return checks['game.project.evidence'](content)
  if (type === 'game.revise') return checks['game.revision.evidence'](content)
  if (type === 'game.playtest') return checks['game.playtest.evidence'](content)
  if (type === 'game.package') return checks['game.package.evidence'](content)
  return null
}

/** A confirmed document bundle exports four payloads plus the host manifest. */
export function reviewedExports(compiled, content, reviewId = null) {
  const review = compiled.filter(item => item.contract.reviewKind === reviewContract.kind && (reviewId === null || item.nodeId === reviewId)).at(-1)
  const value = review && parseGameReview(content(review.nodeId))
  if (!value) return null
  const sources = gameReviewSources(compiled, review.nodeId)
  const brief = compiled.find(item => item.nodeId === sources.brief)
  const checks = validateGameRules(value.rules)
  const report = ['# 玩法规则检查', '', ...checks.map(check => `- ${check.name}: ${check.verdict} (${check.reason})`), '', '结构检查通过只代表文档满足契约；玩法、难度和验收行为仍需人工验证。'].join('\n')
  return {
    openQuestions: JSON.parse(value.rules).openQuestions,
    entries: [
      ...(brief ? [{ path: 'brief.txt', nodeId: brief.nodeId, snapshotNodeId: brief.nodeId, content: content(brief.nodeId) }] : []),
      { path: 'gdd.md', nodeId: sources.gdd, snapshotNodeId: review.nodeId, transform: 'extract_review_gdd', content: value.gdd },
      { path: 'rules.json', nodeId: sources.rules, snapshotNodeId: review.nodeId, transform: 'extract_review_rules', content: value.rules },
      { path: 'report.md', nodeId: sources.report, snapshotNodeId: review.nodeId, transform: 'validate_review_rules', content: report },
    ],
  }
}
