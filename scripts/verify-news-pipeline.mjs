// 游戏技术雷达管线自检：kind 口径 / 相关性闸门 / 事件键 / 翻译占位符 / 常青闸门 / 删除端点。
// 全部离线跑：不打外网、不碰真宿主、不碰真库（临时库由 DSH_WORKBENCH_DB 指到系统临时目录）。
// 用法：node scripts/verify-news-pipeline.mjs
//
// 为什么这些要单独测：这几条都是「错一条就把内容灌歪」的闸门，而它们的真实输入
// （HN 标题里的 galgame、GitHub 里的私服仓库、带 utm 的官方链接）在离线环境里根本复现不出来，
// 只能拿构造样本钉住行为。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = join(tmpdir(), `wbnews-${process.pid}-${Date.now()}`)
mkdirSync(tmp, { recursive: true })
const dbPath = join(tmp, 'wb.sqlite')
/* 硬保险：这个脚本会真的执行 DELETE。数据库路径必须落在临时目录，
   否则一旦有人在真机上跑出异常配置，删的就是用户真实数据。 */
if (!dbPath.startsWith(tmpdir())) {
  console.error(`拒绝运行：测试库不在临时目录（${dbPath}）`)
  process.exit(1)
}
process.env.DSH_WORKBENCH_DB = dbPath

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('  ✓', name) } else { fail += 1; console.log('  ✗', name, detail) }
}

const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)

/* ---------- 1. 导出可见性 ----------
   这些纯函数原本是模块私有的，为了能离线断言才改成导出。导出没了等于这一整批
   断言失去意义，所以先钉住它。 */
console.log('\n[1] 构建产物导出')
const need = ['normalizeNewsKind', 'NEWS_EVERGREEN_KINDS', 'isOffTopicNews', 'normalizeNewsUrl', 'newsEventKey', 'cleanNewsItemsDetailed', 'protectBrands', 'restoreBrands', 'clipText']
for (const key of need) check(`导出 ${key}`, typeof host[key] === 'function' || Array.isArray(host[key]), typeof host[key])

/* ---------- 2. kind 口径 ----------
   产品只认 7 类，代码里旧值 12 个。映射错一个，卡片上的类型标签就是错的。 */
console.log('\n[2] kind 旧值映射与未知兜底')
const KIND_CASES = [
  ['oss', 'oss-launch'],
  ['tool', 'tool-update'],
  ['update', 'release'],
  ['announcement', 'release'],
  ['review', 'deep-dive'],
  ['dlc', 'other'],
  ['dev', 'other'],
  ['community', 'other'],
  ['data', 'other'],
  ['peripheral', 'other'],
  ['release', 'release'],
  ['oss-launch', 'oss-launch'],
  /* 未知值不能原样漏出去：cards 的标签表里没有就会渲染成空 pill */
  ['完全不认识的类型', 'other'],
  ['', 'other'],
  [null, 'other'],
]
for (const [input, expected] of KIND_CASES) {
  const got = host.normalizeNewsKind(input)
  check(`normalizeNewsKind(${JSON.stringify(input)}) = ${expected}`, got === expected, `实际 ${got}`)
}

/* ---------- 3. 相关性闸门 ---------- */
console.log('\n[3] 相关性闸门')
const BLOCK = [
  ['盘点 galgame 女主角排名前十', 'community'],
  ['某某私服开服了，外挂写法分享', 'github'],
  ['SP.13 龙珠超开播！聊聊这部新番', 'media'],
]
for (const [title, sourceKey] of BLOCK) {
  check(`挡掉「${title.slice(0, 14)}…」`, host.isOffTopicNews({ title, summary: '', sourceKey }) === true)
}
const ALLOW = [
  ['Unity 6.3 渲染管线更新说明', 'community'],
  ['Godot 4.5 里写一个 compute shader', 'community'],
  ['bevy v0.20.1 发布，ECS 调度重写', 'github'],
]
for (const [title, sourceKey] of ALLOW) {
  check(`放行「${title.slice(0, 14)}…」`, host.isOffTopicNews({ title, summary: '', sourceKey }) === false)
}
/* 官方源免检：官方博客发的「社区活动回顾」也算一手信息，不能拿通用闸门拦 */
check('官方源免检（同样标题不挡）', host.isOffTopicNews({ title: '盘点 galgame 女主角排名前十', summary: '', sourceKey: 'official' }) === false)

/* ---------- 4. 事件键 ----------
   只做 URL 规范化，不做标题相似度：误合并比重复更难收拾。 */
console.log('\n[4] 跨源事件键')
const VARIANTS = [
  'https://blog.unity.com/tech/foo?utm_source=twitter&utm_medium=social',
  'https://www.blog.unity.com/tech/foo/',
  'https://blog.unity.com/tech/foo#comments',
]
const keys = VARIANTS.map((u) => host.newsEventKey(u))
check('同一文章的 utm/www/尾斜杠/fragment 四种写法同键', new Set(keys).size === 1, JSON.stringify(keys))
check('事件键形如 ev-<16hex>', /^ev-[0-9a-f]{16}$/.test(keys[0] ?? ''), keys[0])
check('不同文章不同键', host.newsEventKey('https://godotengine.org/article/bar') !== keys[0])
check('normalizeNewsUrl 去掉跟踪参数', !host.normalizeNewsUrl(VARIANTS[0]).includes('utm_source'), host.normalizeNewsUrl(VARIANTS[0]))

/* ---------- 5. 常青闸门 ---------- */
console.log('\n[5] 时效闸门与常青清单')
const today = new Date().toISOString().slice(0, 10)
const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10)
const mkItem = (extra) => ({
  title: 'Unity shader graph tutorial',
  url: `https://example.com/${Math.random().toString(36).slice(2)}`,
  source: 'X',
  sourceKey: 'community',
  kind: 'tutorial',
  publishedAt: today,
  summary: '',
  ...extra,
})
const clean = host.cleanNewsItemsDetailed([
  mkItem({ title: 'Godot 开源项目首发', kind: 'oss-launch', publishedAt: old }),
  mkItem({ title: 'Unity 6.2 正式发布', kind: 'release', publishedAt: old, sourceKey: 'official', source: 'Unity Blog' }),
])
check('40 天前的 oss-launch 不丢', clean.items.some((i) => i.kind === 'oss-launch'), JSON.stringify(clean.items.map((i) => i.kind)))
check('40 天前的 release 被时效闸门丢掉', !clean.items.some((i) => i.kind === 'release'), JSON.stringify(clean.items.map((i) => i.kind)))
check('dropped.stale 计数为 1', clean.dropped.stale === 1, JSON.stringify(clean.dropped))
check('常青清单含 oss-launch/tool-update/tutorial/paper', ['oss-launch', 'tool-update', 'tutorial', 'paper'].every((k) => host.NEWS_EVERGREEN_KINDS.includes(k)), JSON.stringify(host.NEWS_EVERGREEN_KINDS))

const gateClean = host.cleanNewsItemsDetailed(BLOCK.map(([title, sourceKey]) => mkItem({ title, sourceKey })))
check('闸门丢弃计入 dropped.offTopic', gateClean.dropped.offTopic === BLOCK.length && gateClean.items.length === 0, JSON.stringify(gateClean.dropped))

/* ---------- 6. 翻译占位符 ---------- */
console.log('\n[6] 品牌词占位保护')
const protectedText = host.protectBrands('Notes on the Complex Roots of Unity and bevy v0.20.1')
const tokens = protectedText.tokens ?? []
check('Unity 被换成占位符', protectedText.text.includes('{{1}}') && !/unity/i.test(protectedText.text), protectedText.text)
check('bevy 被换成占位符', protectedText.text.includes('{{2}}'), protectedText.text)
check('占位符编号从 1 开始且连续', tokens.map((t) => t.token).join(',') === '{{1}},{{2}}', JSON.stringify(tokens.map((t) => t.token)))
check('译完能原样还原', host.restoreBrands(protectedText.text, tokens) === 'Notes on the Complex Roots of Unity and bevy v0.20.1', String(host.restoreBrands(protectedText.text, tokens)))
/* 关键：MT 吃掉一个占位符时必须判失败，不能把品牌词硬贴到别处 */
check('缺一个占位符判失败（返回 null）', host.restoreBrands(protectedText.text.split('{{1}}').join(''), tokens) === null)
check('无品牌词的文本原样通过', host.protectBrands('Godot 4.5 发布').tokens.length === 1 && host.protectBrands('hello world').tokens.length === 0)

/* ---------- 7. 删除端点 ----------
   D1：单条删除 + 清空订阅。用假 ctx 起插件，临时库上真调 route handler。 */
console.log('\n[7] 删除/清空端点（临时库）')
const reg = []
const ctx = {
  webServer: { register(r) { reg.push(r) } },
  tools: { register() {} },
  effect: (fn) => fn?.(),
  reflect: { get: () => undefined },
  get: () => undefined,
}
host.apply(ctx)
const route = reg.find((r) => r.path === '/workbench-api')
check('注册了 /workbench-api 路由', route !== undefined)
const call = (method, url, body) => new Promise((resolve) => {
  const req = { url: `/workbench-api${url}`, method, json: async () => body ?? {} }
  route.handler(req, {
    status: 0,
    writeHead(code) { this.status = code },
    end(payload) { resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }) },
  })
})

const raw = new DatabaseSync(dbPath)
const now = new Date().toISOString()
raw.prepare(`INSERT INTO news_topics(id,title,query,schedule_kind,times,weekday,custom_cron,schedule_text,cron_task_ids,enabled,count,last_run_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('topic-test', '测试订阅', 'unity', 'daily', '08:30', 1, '', '', '[]', 1, 6, now, now, now)
const insertItem = raw.prepare(`INSERT INTO news_items(id,topic_id,title,url,source,published_at,summary,ai_summary,source_key,kind,title_zh,summary_zh,heat,heat_kind,event_key,fetched_at,hash)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
insertItem.run('ni-a', 'topic-test', 'A', 'https://example.com/a', 'X', today, '', '', 'community', 'tutorial', '', '', 0, '', 'ev-a', now, 'h-a')
insertItem.run('ni-b', 'topic-test', 'B', 'https://example.com/b', 'X', today, '', '', 'community', 'tutorial', '', '', 0, '', 'ev-b', now, 'h-b')
raw.close()

const del1 = await call('DELETE', '/news/items/ni-a')
check('DELETE /news/items/ni-a → 200', del1.status === 200 && del1.body?.removed === 1, JSON.stringify(del1))
const del2 = await call('DELETE', '/news/items/ni-a')
check('重复删同一条 → 404（不静默成功）', del2.status === 404 && del2.body?.error === 'unknown_item', JSON.stringify(del2))
const del3 = await call('DELETE', '/news/items/')
check('缺 id → 400 missing_item', del3.status === 400 && del3.body?.error === 'missing_item', JSON.stringify(del3))

const clear1 = await call('POST', '/news/items/clear', { topicId: 'topic-test' })
check('清空缺 confirm → 400', clear1.status === 400 && clear1.body?.error === 'confirm_required', JSON.stringify(clear1))
const clear2 = await call('POST', '/news/items/clear', { topicId: 'topic-test', confirm: true })
check('清空 → 200 且 removed=1', clear2.status === 200 && clear2.body?.removed === 1, JSON.stringify(clear2))
const clear3 = await call('POST', '/news/items/clear', { topicId: 'no-such-topic', confirm: true })
check('清空不存在的订阅 → 404', clear3.status === 404 && clear3.body?.error === 'unknown_topic', JSON.stringify(clear3))
const after = await call('GET', '/news')
check('清空后订阅本身仍在', (after.body?.topics ?? []).some((t) => t.id === 'topic-test'), JSON.stringify((after.body?.topics ?? []).map((t) => t.id)))
check('清空后条目已空', (after.body?.items ?? []).filter((i) => i.topicId === 'topic-test').length === 0, JSON.stringify((after.body?.items ?? []).length))

/* ---------- 8. GitHub 标题截断 ----------
   原来的实现就是 slice(0, max)：会把单词劈开、也可能把 emoji 的代理对切成半个字符。 */
console.log('\n[8] 标题按词边界截断')
const longEn = 'A tiny game engine written in Rust with a focus on deterministic simulation and hot reload'
const cut = host.clipText(longEn, 40)
check('超长文本被截断', cut.length <= 40, `${cut.length} ${JSON.stringify(cut)}`)
check('截断后带省略号', cut.endsWith('…'), JSON.stringify(cut))
const body = cut.slice(0, -1).trimEnd()
check('截断点是原串的前缀', longEn.startsWith(body), JSON.stringify(body))
/* 关键断言：截断点后面跟着空格，说明是停在词边界；紧跟字母就说明把词劈开了 */
check('截断点停在词边界（后面是空格）', longEn.charAt(body.length) === ' ', JSON.stringify(longEn.charAt(body.length)))
check('短文本原样返回', host.clipText('Godot 4.5', 40) === 'Godot 4.5')
/* emoji：Array.from 按码点切，代理对不会被撕开成 U+FFFD */
const emojiText = '🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮'
const emojiCut = host.clipText(emojiText, 5)
check('emoji 不被切成半个字符', !emojiCut.includes('\uFFFD'), JSON.stringify(emojiCut))
check('emoji 按码点计数截断', Array.from(emojiCut).length === 5, JSON.stringify(Array.from(emojiCut)))

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail > 0) process.exitCode = 1