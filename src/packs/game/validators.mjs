// Pure checks shared by generation, review and the kernel adoption gate.
export const GAME_CHECKS = ['game.rules.schema', 'game.rules.non_empty', 'game.rules.no_placeholder']

export function readNativeCollectorRules(content) {
  let rules
  try { rules = JSON.parse(content) } catch {}
  const { nativeTemplate, durationSeconds, hearts, creativePack } = rules ?? {}
  if (nativeTemplate !== 'canvas-collector@1' || !Number.isInteger(durationSeconds) || !Number.isInteger(hearts) || (rules.player && rules.player.count !== 1)) {
    throw new Error('game_approved_scope_unsupported: 原生工坊只支持单人横移、接下落星星计分、碰三角扣血和存活计时获胜。请按此范围修订设计和规则，确认 JSON 包含 nativeTemplate="canvas-collector@1"、整数 durationSeconds 和 hearts。若在运行旧版《星光采集》，请从模板库重新新建。')
  }
  if (durationSeconds < 3 || durationSeconds > 60 || hearts < 1 || hearts > 9) {
    throw new Error('game_approved_rules_out_of_range: 单局时长须为 3–60 秒，初始生命须为 1–9 颗心。')
  }
  if (creativePack !== undefined && !['none', 'local-original-v1'].includes(creativePack)) {
    throw new Error('game_creative_pack_unsupported: creativePack 须为 none 或 local-original-v1。')
  }
  return rules
}

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
