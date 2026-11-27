import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const CINDERWATCH_TEMPLATE_ID = 'cinderwatch'
export const CINDERWATCH_NATIVE_TEMPLATE = 'cinderwatch@1'
export const cinderwatchBiomes = Object.freeze(['ashen', 'frost', 'fen', 'ember', 'dunes'])
export const cinderwatchDefaultRules = Object.freeze({ seed: 4, biome: 'ashen', startingGold: 300, lives: 20, autoCommand: true })

export function validateCinderwatchRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.getPrototypeOf(rules) !== Object.prototype
    || Object.keys(rules).sort().join(',') !== 'autoCommand,biome,lives,seed,startingGold'
    || !Number.isInteger(rules.seed) || rules.seed < 1 || rules.seed > 999999
    || !cinderwatchBiomes.includes(rules.biome)
    || !Number.isInteger(rules.startingGold) || rules.startingGold < 70 || rules.startingGold > 2000
    || !Number.isInteger(rules.lives) || rules.lives < 1 || rules.lives > 100
    || typeof rules.autoCommand !== 'boolean') throw new Error('game_rules_invalid')
  return rules
}

// The second location is used by installed packages whose host modules live in lib/.
const assetRoots = [
  new URL('../../assets/vendor/cinderwatch/', import.meta.url),
  new URL('../assets/vendor/cinderwatch/', import.meta.url),
]
function assetRoot() {
  const root = assetRoots.find(url => existsSync(new URL('LICENSE', url)))
  if (!root) throw new Error('game_cinderwatch_assets_missing')
  return root
}
const readAsset = name => readFileSync(new URL(name, assetRoot()), 'utf8').replace(/\r\n/g, '\n')
function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error('game_cinderwatch_source_contract_changed')
  return source.replace(before, () => after)
}

function titleWidth(ctx, title, scale) {
  const max = Math.max(1, R.dw - 48 * (R.dpr || 1))
  if (/^[\x20-\x7e]+$/.test(title)) return Math.min(max, PX.measure(title) * scale)
  ctx.save(); ctx.font = (PX.LINE * scale) + 'px system-ui, sans-serif'
  const width = ctx.measureText(title).width; ctx.restore()
  return Math.min(max, width)
}
function drawTitle(ctx, title, x, y, scale, color) {
  const width = titleWidth(ctx, title, scale)
  if (/^[\x20-\x7e]+$/.test(title)) return PX.text(ctx, title, x, y, Math.min(scale, width / Math.max(1, PX.measure(title))), color, { align: 'c' })
  ctx.save(); ctx.font = (PX.LINE * scale) + 'px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = color
  ctx.fillText(title, x, y, width); ctx.restore()
}

function installChineseUi(PX, TOWER, MON, BIOMES) {
  const dictionary = {
    'Cinderwatch': '烬火守望', 'AI commander': '自动指挥', 'You command': '你在指挥',
    'Tap a pad to play': '点击空塔位建造', 'Click a pad to take over': '点击空塔位接管',
    'Tap for the AI': '点击交还指挥', 'Click here for the AI': '点击交还指挥',
    'Tap a pad to build': '点击空塔位建造', 'Click a pad to build': '点击空塔位建造',
    'Drag to look around': '拖动旋转视角', 'Pinch or double-tap to zoom': '双指缩放视角',
    '1-4 pick a tower': '按 1–4 选择防御塔', 'Space calls the next wave': '空格键召唤下一波',
    'Wheel zooms, drag moves the view': '滚轮缩放，拖动移动视角',
    'Next wave in 0': '下一波即将到来', 'Tap to call · +00': '点击提前出击 · +金币',
    'The fire has died': '烽火已熄', 'Boss defeated': '首领已击败', 'A new pass awaits': '新的关隘等待守护',
    'Paused': '已暂停', 'Pause (P)': '暂停（P）', 'Resume (P)': '继续（P）',
    'Speed (Tab)': '游戏速度（Tab）', 'Tap for sound': '点击切换声音', 'Click for sound': '点击切换声音',
    'Sound is off (M)': '声音已关闭（M）', 'Sound is on (M)': '声音已开启（M）', 'Sound': '声音',
    'Full screen': '全屏', 'Zoom in (+)': '放大（+）', 'Zoom out (-)': '缩小（-）', 'Follow the fight': '跟随战斗',
    'Choose a tower': '选择防御塔', 'Tap one to see what it does,': '点击查看防御塔说明，',
    'then tap it again to build.': '再次点击即可建造。', 'Hover or press 1 to 4': '悬停查看，或按 1–4',
    'to see what each does.': '查看各防御塔说明。', 'Build here': '在此建造',
    'Tap again to build': '再次点击建造', 'Not enough gold yet': '金币不足',
    'Max level': '已达最高级', ' health': ' 生命', 'The pass holds': '关隘守住了', 'The beacon is out': '烽火熄灭了',
    'Ashen Pass': '灰烬山隘', 'Frostfall': '霜落谷', 'Mirefen': '迷雾沼泽', 'Emberscar': '余烬裂谷', 'Duskmesa': '暮色台地',
    'Archer tower': '弓箭塔', 'Archers': '弓箭手', 'Fast flaming arrows.': '快速发射火焰箭。', 'Can hit flyers.': '可攻击飞行敌人。',
    'Bombard': '轰击炮', 'Slow shells that burst.': '缓慢发射爆炸炮弹。', 'Ground targets only.': '仅攻击地面目标。',
    'Storm spire': '雷暴尖塔', 'Spire': '雷暴塔', 'Chain lightning that slows.': '释放连锁闪电并减速。',
    'Guard post': '守卫哨站', 'Guards': '守卫', 'Footmen who block': '步兵会拦截敌人，', 'and duel on the road.': '并在道路上迎战。',
    'Skeleton': '骷髅兵', 'Giant rat': '巨鼠', 'Slime': '史莱姆', 'Slimelet': '小史莱姆',
    'Skeleton knight': '骷髅骑士', 'Bat': '蝙蝠', 'Ghoul': '食尸鬼', 'Scarab': '圣甲虫',
    'Cave spider': '洞穴蜘蛛', 'Dire wolf': '恶狼', 'Sapper': '爆破兵', 'Wraith': '幽影',
    'Bog toad': '沼泽蛙', 'Wisp': '鬼火', 'War drummer': '战鼓手', 'Gargoyle': '石像鬼',
    'Necromancer': '死灵法师', 'Mummy': '木乃伊', 'Troll': '巨魔', 'Golem': '石像傀儡',
    'Brood mother': '蛛群母体', 'Bone Giant': '骸骨巨人', 'Ogre': '食人魔', 'Frost Jotun': '霜巨人',
    'Brood Queen': '蛛后', 'Magma Colossus': '熔岩巨像', 'The Buried King': '地底之王',
    'Fast and frail. Comes in packs.': '行动迅速但很脆弱，通常成群出现。',
    'Splits in two when it dies.': '死亡后会分裂成两个小史莱姆。', 'Its armor turns most arrows.': '身披重甲，大多数箭矢难以穿透。',
    'Flies over the road. Only archers and spires reach it.': '会飞越道路，只有弓箭塔和雷暴尖塔能攻击它。',
    'Runs faster the more it is hurt.': '受伤越重，奔跑越快。', 'Slips past your footmen.': '能够绕过步兵防线。',
    'Fast, and it bites hard.': '行动迅捷，撕咬凶猛。', 'Its powder keg blows up friend and foe.': '火药桶爆炸时会伤及敌我双方。',
    'Arrows and swords miss while it fades.': '隐去身形时，箭矢与刀剑都无法命中。',
    'Covers ground in long hops.': '以远距离跳跃快速穿越战场。', 'A fast flyer. Easy to kill, hard to catch.': '飞行迅速，容易击败却难以追上。',
    'Speeds up everything near it.': '能提升附近敌人的行动速度。', 'A flyer that shrugs off arrows.': '会飞行且能抵挡箭矢。',
    'Raises skeletons as it walks.': '行进途中会召唤骷髅兵。', 'Bursts into scarabs when it falls.': '倒下时会化作一群圣甲虫。',
    'Heals unless you keep hitting it.': '若不持续攻击，它就会恢复生命。', 'Shrugs off arrows and is hard to slow.': '不惧箭矢，也难以减速。',
    'Bursts into spiders when it falls.': '倒下时会涌出一群蜘蛛。', 'Slow and enormous. Hit it with everything.': '体型巨大、行动缓慢，全力攻击它。',
    'Smashes footmen aside.': '会将步兵击飞。', 'Its stomp freezes nearby towers.': '跺地会冻结附近的防御塔。',
    'Keeps hatching spiders.': '会不断孵化蜘蛛。', 'Speeds up when it is nearly dead.': '濒临倒下时会加速行动。',
    'Summons mummies to walk with him.': '会召唤木乃伊随行作战。',
  }
  const cjk = /[\u3400-\u9fff]/
  const metrics = document.createElement('canvas').getContext('2d')
  metrics.font = '8px "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  const localize = value => {
    const text = String(value)
    if (Object.hasOwn(dictionary, text)) return dictionary[text]
    let match = text.match(/^Wave (\d+)(?: · (.+))?$/)
    if (match) return `第${match[1]}波${match[2] ? ' · ' + localize(match[2]) : ''}`
    match = text.match(/^Next wave in (.+)$/)
    if (match) return '下波倒计时：' + match[1] + ' 秒'
    match = text.match(/^(Tap to call|Call now) · \+(\d+)$/)
    if (match) return `点击提前出击 · +${match[2]} 金币`
    match = text.match(/^(\d+) on the road$/)
    if (match) return `路上敌人：${match[1]}`
    match = text.match(/^Best run: wave (\d+)$/)
    if (match) return `最佳纪录：第${match[1]}波`
    if (text.endsWith(' · The commander plays until you take over.')) return text.replace(' · The commander plays until you take over.', ' · 自动指挥中，点击即可接管。')
    match = text.match(/^Upgrade (\d+)$/)
    if (match) return `升级（${match[1]}金币）`
    match = text.match(/^(Confirm )?Sell \+(\d+)$/)
    if (match) return `${match[1] ? '确认出售' : '出售'}，返还 ${match[2]} 金币`
    match = text.match(/^Range ([\d.]+) · Damage ([\d.]+)$/)
    if (match) return `射程 ${match[1]} · 伤害 ${match[2]}`
    match = text.match(/^Next: range ([\d.]+) · damage ([\d.]+)$/)
    if (match) return `下一级：射程 ${match[1]} · 伤害 ${match[2]}`
    match = text.match(/^Next: (\d+) footmen · (\d+) health$/)
    if (match) return `下一级：${match[1]} 名守卫 · ${match[2]} 生命`
    match = text.match(/^(.+): click a pad$/)
    if (match) return `已选择${match[1]}：点击空塔位建造`
    match = text.match(/^(\d+) kills$/)
    if (match) return `击杀 ${match[1]}`
    if (text.includes(' · ')) {
      const parts = text.split(' · '), translated = parts.map(localize)
      if (translated.some((part, index) => part !== parts[index])) return translated.join(' · ')
    }
    if (/\bfps\b/i.test(text)) return text.replace(/\bfps\b/ig, '帧/秒').replace(/ calls /, ' 绘制调用 ').replace(/ mons /, ' 敌人 ')
    return text
  }
  const originalMeasure = PX.measure, originalText = PX.text
  PX.measure = value => {
    const text = localize(value)
    if (cjk.test(text)) return metrics.measureText(text).width
    let width = 0, count = 0
    for (const char of text) { width += cjk.test(char) ? 8 : originalMeasure(char); count++ }
    return Math.max(0, width - (count ? 1 : 0))
  }
  PX.text = (ctx, value, x, y, scale, color, options) => {
    const text = localize(value)
    if (!cjk.test(text)) return originalText(ctx, text, x, y, scale, color, options)
    const s = Math.max(1, Math.round(scale || 1)), opts = options || {}, alpha = opts.alpha === undefined ? 1 : opts.alpha
    if (alpha <= 0) return PX.measure(text) * s
    const width = PX.measure(text) * s
    let left = x
    if (opts.align === 'c') left -= width / 2
    else if (opts.align === 'r') left -= width
    ctx.save(); ctx.globalAlpha *= alpha
    ctx.font = `${8 * s}px "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = color || '#ffffff'
    if (opts.outline) { ctx.strokeStyle = opts.outline; ctx.lineWidth = Math.max(1, s); ctx.strokeText(text, Math.round(left), Math.round(y)) }
    ctx.fillText(text, Math.round(left), Math.round(y)); ctx.restore()
    return width
  }
  for (const value of Object.values(TOWER)) { value.name = localize(value.name); value.short = localize(value.short); value.desc = value.desc.map(localize) }
  for (const value of Object.values(MON)) { value.name = localize(value.name); if (value.tip) value.tip = localize(value.tip) }
  for (const value of BIOMES) value.name = localize(value.name)
}

function installBridge() {
  applyCamera()
  const towerState = tower => tower ? {
    kind: tower.kind, level: tower.lvl + 1, state: tower.state, padIndex: G.B.pads.indexOf(tower.pad),
    spent: tower.spent, kills: tower.kills, damageDealt: tower.dealt, alive: tower.alive,
  } : null
  window.__gameState = () => ({
    templateId: 'cinderwatch', nativeTemplate: 'cinderwatch@1', title: window.GAME.title,
    phase: G.phase, objective: 'endless-defense', simulationSeconds: G.t,
    seed: CW_RULES.seed, boardSeed: G.B.seed, biome: G.B.bio.key, boardIndex: G.B.index,
    rules: { ...CW_RULES }, gold: G.gold, lives: G.lives, maxLives: G.maxLives,
    kills: G.slain, slain: G.slain, wave: waveNumber(), waveInBoard: G.k,
    completedBoards: G.level, defeats: G.run - 1, monsterCount: G.mons.filter(monster => !monster.dead).length,
    paused: G.paused, speed: G.speed, autoCommand: !UI.playerActive(), commander: UI.playerActive() ? 'player' : 'ai',
    towers: G.towers.filter(tower => tower.alive).map(towerState),
    pads: G.B.pads.map((pad, index) => {
      const point = UI.proj(pad.x, pad.y + .1, pad.z), dpr = R.dpr || 1
      return { index, x: pad.x, y: pad.y, z: pad.z, screenX: point.x / dpr, screenY: point.y / dpr, tower: towerState(pad.tower) }
    }),
    renderer: { name: 'three.js', revision: THREE.REVISION, width: R.iw, height: R.ih, quality: R.quality },
  })
  // Normal player controls only. The upstream __cw debug hooks stay available for
  // deterministic stepping, while acceptance tests must exercise real input.
  window.__gameControl = Object.freeze({
    setCommander(value) { if (!['ai', 'player'].includes(value)) throw new Error('game_commander_invalid'); UI.setManual(value === 'player') },
    setPaused(value) { if (typeof value !== 'boolean') throw new Error('game_pause_invalid'); G.paused = value },
    restart() { location.reload() },
  })
}

let cachedSource, cachedRuntime
/** Read the complete pinned upstream game lazily, so collector-only consumers do
 * not need the large third-party resources. Vendored source files stay unchanged. */
export function cinderwatchTemplateSource() {
  if (cachedSource) return cachedSource
  const root = assetRoot(), folder = new URL('src/', root)
  let source = readdirSync(fileURLToPath(folder)).filter(name => name.endsWith('.js')).sort()
    .map(name => readFileSync(new URL(name, folder), 'utf8').replace(/\r\n/g, '\n')).join('\n')
  source = replaceOnce(source, '  return o;\n})();', '  o.seed = CW_RULES.seed; o.biome = CW_RULES.biome;\n  return o;\n})();')
  source = replaceOnce(source, 'G.gold = 300 + 80 * G.level;', 'G.gold = CW_RULES.startingGold + 80 * G.level;')
  source = replaceOnce(source, '  beginBattle(true);', '  G.maxLives = CW_RULES.lives; UI.setManual(!CW_RULES.autoCommand);\n  beginBattle(true);')
  source = replaceOnce(source, '  if (HASH.k) G.k = +HASH.k;', '  installBridge();\n  if (HASH.k) G.k = +HASH.k;')
  source = replaceOnce(source, "t1 = 'Cinderwatch'", 't1 = window.GAME.title')
  source = replaceOnce(source, 'let w = PX.measure(t1) * sc;', 'let w = titleWidth(c, t1, sc);')
  source = replaceOnce(source, "PX.text(c, t1, W / 2, yy + pad, sc, '#ffd9a8', { align: 'c' });", "drawTitle(c, t1, W / 2, yy + pad, sc, '#ffd9a8');")
  source = replaceOnce(source, 'Cinderwatch could not start.<br><small>It needs a browser with WebGL 2 turned on.</small>', '游戏无法启动。<br><small>请使用已启用 WebGL 2 的浏览器。</small>')
  source = replaceOnce(source, "for (const wd of str.split(' ')) { const t = cur2 ? cur2 + ' ' + wd : wd;", "const isCjk = /[\\u3400-\\u9fff]/.test(str), words = isCjk ? [...str] : str.split(' '), gap = isCjk ? '' : ' '; for (const wd of words) { const t = cur2 ? cur2 + gap + wd : wd;")
  source += '\n' + installChineseUi.toString() + '\ninstallChineseUi(PX, TOWER, MON, BIOMES);\n'
  cachedSource = "(function(){\n'use strict';\nconst CW_RULES = window.GAME.rules;\n"
    + [titleWidth.toString(), drawTitle.toString(), installBridge.toString(), source].join('\n') + '\n})();\n'
  return cachedSource
}

function threeRuntime() {
  if (cachedRuntime) return cachedRuntime
  const source = readAsset('vendor/three.module.min.js'), start = source.lastIndexOf('export{'), end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('game_cinderwatch_runtime_invalid')
  const names = source.slice(start + 7, end).split(',').filter(value => value.trim()).map(value => {
    const pair = value.trim().split(' as '), local = pair[0].trim(), exported = (pair[1] || pair[0]).trim()
    if (!/^[\w$]+$/.test(local) || !/^[\w$]+$/.test(exported)) throw new Error('game_cinderwatch_runtime_invalid')
    return exported + ':' + local
  })
  cachedRuntime = 'var THREE=(function(){' + source.slice(0, start) + '\nreturn {' + names.join(',') + '};})();'
  return cachedRuntime
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const scriptJson = value => JSON.stringify(value).replace(/[<\u2028\u2029]/g, char => ({ '<': '\\u003c', '\u2028': '\\u2028', '\u2029': '\\u2029' })[char])
function safeScript(source) {
  if (typeof source !== 'string' || /<\/script|<!--|<script[\s>]/i.test(source)) throw new Error('game_source_html_delimiter')
  return source
}

export function renderCinderwatchHtml(manifest, source = cinderwatchTemplateSource()) {
  validateCinderwatchRules(manifest.rules)
  const displayTitle = manifest.title === 'Cinderwatch' ? '烬火守望' : manifest.title
  const title = escapeHtml(displayTitle)
  const config = scriptJson({ title: displayTitle, rules: manifest.rules, orientation: manifest.orientation, nativeTemplate: CINDERWATCH_NATIVE_TEMPLATE })
  const notices = readAsset('LICENSE') + '\n\n' + readAsset('vendor/LICENSE-three.txt')
  if (notices.includes('*/')) throw new Error('game_cinderwatch_notice_invalid')
  const csp = "default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; media-src data: blob:; worker-src 'none'; object-src 'none';"
  let html = readAsset('src/shell.html')
  html = replaceOnce(html, '<html lang="en">', '<html lang="zh-CN">')
  html = replaceOnce(html, 'Cinderwatch: a self-playing 3D isometric tower defense in a single HTML file.', '烬火守望：单文件离线运行的三维塔防游戏。')
  html = replaceOnce(html, '<meta charset="utf-8">', '<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="' + csp + '">')
  html = replaceOnce(html, '<title>Cinderwatch</title>', '<title>' + title + '</title>')
  html = replaceOnce(html, '<meta name="apple-mobile-web-app-title" content="Cinderwatch">', '<meta name="apple-mobile-web-app-title" content="' + title + '">')
  html = replaceOnce(html, '<div id="load">Cinderwatch<br><small>Lighting the beacon</small></div>', '<div id="load">' + title + '<br><small>正在点燃烽火</small></div>')
  html = replaceOnce(html, '<canvas id="gl"></canvas>', '<canvas id="gl" aria-label="Three.js 塔防场景"></canvas>')
  html = replaceOnce(html, '/*__THREE__*/', '/*\n' + notices + '\n*/\n' + safeScript(threeRuntime()))
  html = replaceOnce(html, '/*__GAME__*/', 'window.GAME=' + config + ';\n' + safeScript(source))
  return html
}
