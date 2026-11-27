// Pure checks shared by generation, review and the kernel adoption gate.
export const GAME_CHECKS = ['game.rules.schema', 'game.rules.non_empty', 'game.rules.no_placeholder']

export const CINDERWATCH_BIOMES = ['ashen', 'frost', 'fen', 'ember', 'dunes']
export const CINDERWATCH_RULES_PROMPT = 'Native contract: cinderwatch@1 is Three.js tower defense: four tower kinds and upgrades, road enemies, waves/bosses, gold economy, beacon lives and rule-based AI commander/player handover. Rules must explicitly contain nativeTemplate="cinderwatch@1", integer seed (1..999999, default 4), biome (ashen/frost/fen/ember/dunes, default ashen), integer startingGold (70..2000, default 300), integer lives (1..100, default 20), boolean autoCommand (default true). creativePack must be none or absent; all models/textures/sounds are procedural. Unsupported mechanics must be nativeTemplate="unsupported" and explained in openQuestions. Never replace tower defense with collector. Do not claim Blender/GLB, paid generation or publishing. Browser checks cover rendering, spending, handover, pause, waves, kills, economy and mobile controls/layout; no won phase is required. Human approval precedes creation.'

/** Parse the approved template contract without substituting a different game. */
export function readNativeGameRules(content, expectedTemplate) {
  let rules
  try { rules = JSON.parse(content) } catch {}
  if (expectedTemplate && rules?.nativeTemplate && rules.nativeTemplate !== (expectedTemplate === 'collector' ? 'canvas-collector' : expectedTemplate) + '@1') throw new Error('game_approved_template_mismatch: 节点模板与已批准玩法不一致，请核对后重新批准。')
  if (rules?.nativeTemplate === 'canvas-collector@1') return readNativeCollectorRules(content)
  if (rules?.nativeTemplate !== 'cinderwatch@1') {
    throw new Error('game_approved_scope_unsupported: 请批准受支持的完整玩法契约。Cinderwatch 塔防须包含 nativeTemplate="cinderwatch@1"、整数 seed / startingGold / lives、biome 和布尔 autoCommand；不能把其他玩法替换成采集游戏。')
  }
  if (!Number.isInteger(rules.seed) || !Number.isInteger(rules.startingGold) || !Number.isInteger(rules.lives)
    || !CINDERWATCH_BIOMES.includes(rules.biome) || typeof rules.autoCommand !== 'boolean'
    || (rules.player && rules.player.count !== 1)) {
    throw new Error('game_approved_scope_unsupported: Cinderwatch 规则须显式填写整数 seed / startingGold / lives、biome（ashen / frost / fen / ember / dunes）、布尔 autoCommand，支持单人指挥。')
  }
  if (rules.seed < 1 || rules.seed > 999999 || rules.startingGold < 70 || rules.startingGold > 2000 || rules.lives < 1 || rules.lives > 100) {
    throw new Error('game_approved_rules_out_of_range: Cinderwatch 的 seed 须为 1–999999，startingGold 为 70–2000，lives 为 1–100。')
  }
  if (rules.creativePack !== undefined && rules.creativePack !== 'none') {
    throw new Error('game_creative_pack_unsupported: Cinderwatch 使用随模板发布的程序化模型、纹理与声音，creativePack 须为 none。')
  }
  return rules
}

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
