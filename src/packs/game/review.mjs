import { validateGameRules } from './validators.mjs'
export const REVIEW_CHECK = 'game.review.documents'
export function parseGameReview(content) {
  try { const value = JSON.parse(content); return value?.kind === 'game-review-v1' && typeof value.gdd === 'string' && typeof value.rules === 'string' ? value : null } catch { return null }
}
export function validateGameReview(content) {
  const value = parseGameReview(content)
  return !!value && value.gdd.trim().length > 0 && validateGameRules(value.rules).filter(c => c.required).every(c => c.verdict === 'pass')
}

export function parseGameHandoff(content) {
  try {
    const value = JSON.parse(content)
    return value?.kind === 'game-handoff-v1' && value.version === 1 ? value : null
  } catch { return null }
}

export function validateGameHandoff(content) {
  const value = parseGameHandoff(content)
  if (!value) return false
  return value.status === '通过'
    && typeof value.buildId === 'string' && value.buildId.trim() !== ''
    && typeof value.tester === 'string' && value.tester.trim() !== ''
    && typeof value.platform === 'string' && value.platform.trim() !== ''
    && typeof value.playDurationMinutes === 'string' && Number(value.playDurationMinutes) > 0
    && typeof value.observations === 'string' && value.observations.trim() !== ''
    && typeof value.knownIssues === 'string' && value.knownIssues.trim() !== ''
    && typeof value.evidencePath === 'string' && value.evidencePath.trim() !== ''
}

function parseEvidence(content) {
  try { const value = JSON.parse(content); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch { return null }
}

const buildIdIsValid = value => typeof value === 'string' && /^[a-f0-9]{12}$/i.test(value)
export function validateGameProjectEvidence(content) {
  const value = parseEvidence(content)
  return !!value && typeof value.project === 'string' && value.project.trim() !== ''
    && typeof value.title === 'string' && value.title.trim() !== '' && buildIdIsValid(value.buildId)
    && (value.template === undefined || ['collector', 'voxel'].includes(value.template))
    && (value.bytes === undefined || Number.isSafeInteger(value.bytes) && value.bytes > 0)
    && (value.artifact === undefined || typeof value.artifact === 'string' && value.artifact.trim() !== '')
}
export function validateGamePlaytestEvidence(content) {
  const value = parseEvidence(content)
  return !!value && typeof value.project === 'string' && value.project.trim() !== '' && buildIdIsValid(value.buildId)
    && value.finalPhase === 'won' && value.buildCurrent === true && value.errors === 0 && value.requests === 0
    && typeof value.runDir === 'string' && value.runDir.trim() !== '' && Array.isArray(value.screenshots) && value.screenshots.length > 0
    && value.screenshots.every(path => typeof path === 'string' && path.trim() !== '')
    && typeof value.summary === 'string' && /Errors: none/u.test(value.summary)
    && /Screenshots:\s*\S/u.test(value.summary)
}
export function validateGamePackageEvidence(content) {
  const value = parseEvidence(content)
  return !!value && typeof value.project === 'string' && value.project.trim() !== '' && buildIdIsValid(value.buildId)
    && typeof value.exportPath === 'string' && value.exportPath.trim() !== '' && value.exportPath.toLowerCase().endsWith('.html')
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.offline === true
}
export function validateGameRevisionEvidence(content) {
  const value = parseEvidence(content)
  return !!value && typeof value.project === 'string' && value.project.trim() !== ''
    && typeof value.title === 'string' && value.title.trim() !== '' && buildIdIsValid(value.buildId)
    && Array.isArray(value.changes) && value.changes.every(change => typeof change === 'string' && change.trim() !== '')
    && (value.changes.length > 0 || typeof value.noChangesReason === 'string' && value.noChangesReason.trim() !== '')
}
