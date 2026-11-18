// Pure checks shared by generation, review and the kernel adoption gate.
export const GAME_CHECKS = ['game.rules.schema', 'game.rules.non_empty', 'game.rules.no_placeholder']
export function validateGameRules(content) {
  let value
  try { value = JSON.parse(content) } catch {}
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  const strings = v => Array.isArray(v) && v.every(x => typeof x === 'string')
  const fields = ['goal', 'fail', 'loop', 'acceptance', 'openQuestions']
  const schema = object(value) && value.version === 1 && typeof value.title === 'string' && object(value.player) && Number.isInteger(value.player.count) && value.player.count > 0 && strings(value.player.controls) && fields.every(k => strings(value[k]))
  const nonempty = !!schema && !!value.title.trim() && [value.player.controls, ...fields.filter(k => k !== 'openQuestions').map(k => value[k])].every(a => a.length > 0 && a.every(s => s.trim().length > 0)) && value.openQuestions.every(s => s.trim().length > 0)
  const marker = new RegExp([String.fromCharCode(84,79,68,79), 'TBD', '待补充', '待定'].join('|'), 'i')
  // Open questions are explicitly allowed to contain unresolved questions.
  const noPlaceholder = !!schema && !marker.test(JSON.stringify({ ...value, openQuestions: [] }))
  return [
    { name: GAME_CHECKS[0], verdict: schema ? 'pass' : 'fail', reason: schema ? 'rules_schema_valid' : 'rules_schema_invalid' },
    { name: GAME_CHECKS[1], verdict: nonempty ? 'pass' : 'fail', reason: nonempty ? 'required_fields_present' : 'required_fields_empty' },
    { name: GAME_CHECKS[2], verdict: noPlaceholder ? 'pass' : 'fail', reason: noPlaceholder ? 'no_placeholders' : 'placeholder_or_invalid_schema' },
    { name: 'game.rules.acceptance_resolvable', verdict: 'not_assessed', reason: 'requires_human_review' },
  ].map(item => ({ ...item, required: GAME_CHECKS.includes(item.name), evidence: [] }))
}
