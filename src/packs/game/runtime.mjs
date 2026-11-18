import { GAME_CHECKS, validateGameRules } from './validators.mjs'
import { REVIEW_CHECK, validateGameReview } from './review.mjs'
import { parseGameReview } from './review.mjs'
import { gameReviewSources } from './review-sources.mjs'
export const checks = Object.fromEntries([
  ...GAME_CHECKS.map(name => [name, content => validateGameRules(content).find(check => check.name === name)]),
  [REVIEW_CHECK, content => ({ verdict: validateGameReview(content) ? 'pass' : 'fail', reason: 'review_documents_validation' })],
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

export function ruleChecks(type, content) { return type === 'game.rules' ? validateGameRules(content) : null }

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
