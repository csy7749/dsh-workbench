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

function parseEvidence(content) {
  try { const value = JSON.parse(content); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch { return null }
}

const buildIdIsValid = value => typeof value === 'string' && /^[a-f0-9]{12}$/i.test(value)

export function gameHandoffError(value) {
  if (!value) return '无法读取人工试玩验收表，请重新打开此验收待办。'
  const issues = []
  if (typeof value.status !== 'string' || value.status.trim() !== '通过') issues.push('实际验收通过后，将「人工试玩结论」填为“通过”')
  if (!buildIdIsValid(value.buildId)) issues.push('「构建 ID」应使用预填的 12 位 ID')
  const minutes = typeof value.playDurationMinutes === 'string' ? Number(value.playDurationMinutes.trim().replace(/\s*分钟$/u, '')) : NaN
  if (!Number.isFinite(minutes) || minutes <= 0) {
    issues.push('「实际试玩分钟数」请填大于 0 的分钟数，例如 1 或 0.5')
  }
  const required = [
    ['tester', '试玩者'], ['platform', '设备与浏览器'], ['observations', '试玩过程与观察'],
    ['knownIssues', '已知问题（没有请填“无”）'], ['evidencePath', '导出 HTML 路径（使用预填值）'],
  ]
  const missing = required.filter(([key]) => typeof value[key] !== 'string' || value[key].trim() === '').map(([, label]) => label)
  if (missing.length) issues.push('请填写' + missing.join('、'))
  return issues.length ? `${issues.join('。')}。` : null
}

export function validateGameHandoff(content) {
  return gameHandoffError(parseGameHandoff(content)) === null
}

export function validateGameProjectEvidence(content) {
  const value = parseEvidence(content)
  return !!value && typeof value.project === 'string' && value.project.trim() !== ''
    && typeof value.title === 'string' && value.title.trim() !== '' && buildIdIsValid(value.buildId)
    && (value.template === undefined || ['cinderwatch', 'collector', 'voxel', 'canvas-collector', 'three-collector'].includes(value.template))
    && (value.bytes === undefined || Number.isSafeInteger(value.bytes) && value.bytes > 0)
    && (value.artifact === undefined || typeof value.artifact === 'string' && value.artifact.trim() !== '')
}
export function validateGamePlaytestEvidence(content) {
  const value = parseEvidence(content)
  const common = !!value && typeof value.project === 'string' && value.project.trim() !== '' && buildIdIsValid(value.buildId)
    && (value.playtestStatus === undefined || value.playtestStatus === 'passed')
    && value.buildCurrent === true && value.errors === 0 && value.requests === 0
    && typeof value.runDir === 'string' && value.runDir.trim() !== '' && Array.isArray(value.screenshots) && value.screenshots.length > 0
    && value.screenshots.every(path => typeof path === 'string' && path.trim() !== '')
    && typeof value.summary === 'string' && /Errors: none/u.test(value.summary)
    && /Screenshots:\s*\S/u.test(value.summary)
  if (!common) return false
  if (value.template === 'cinderwatch' || value.templateId === 'cinderwatch' || value.nativeTemplate === 'cinderwatch@1') {
    return value.templateId === 'cinderwatch' && value.nativeTemplate === 'cinderwatch@1' && value.evidenceVersion === 1
      && value.mode === 'fixed-step-browser' && value.playtestStatus === 'passed'
      && ['play', 'clear', 'defeat'].includes(value.finalPhase)
      && Number.isFinite(value.simulatedSeconds) && value.simulatedSeconds > 0
      && ['mouse', 'keyboard', 'touch'].every(input => value.inputs?.[input] === true)
      && CINDERWATCH_PLAYTEST_CHECKS.every(check => value.checks?.[check] === true)
      && value.screenshots.length >= 2 && Array.isArray(value.observations) && value.observations.length > 0
  }
  return value.finalPhase === 'won'
}
export const CINDERWATCH_PLAYTEST_CHECKS = ['renderer', 'buildSpend', 'manualTakeover', 'commanderReturn', 'pauseToggle', 'waveProgress', 'kills', 'economy', 'mobileLayout']
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
