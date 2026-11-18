import { validateGameRules } from './validators.mjs'
export const REVIEW_CHECK = 'game.review.documents'
export function parseGameReview(content) {
  try { const value = JSON.parse(content); return value?.kind === 'game-review-v1' && typeof value.gdd === 'string' && typeof value.rules === 'string' ? value : null } catch { return null }
}
export function validateGameReview(content) {
  const value = parseGameReview(content)
  return !!value && value.gdd.trim().length > 0 && validateGameRules(value.rules).filter(c => c.required).every(c => c.verdict === 'pass')
}
