/* 诊断用：把每个采集源当前返回的候选与库里已有的 URL 对一下，
   回答「为什么每轮采集都是重复」。不改库、不写文件。 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('C:/Users/gh/.dsh/dsh-workbench.sqlite')
const known = db.prepare('SELECT url FROM news_items').all().map((r) => String(r.url).toLowerCase())
const knownSet = new Set(known)
console.log(`库里已有 ${known.length} 条\n`)

const FEEDS = [
  ['Unity 官方博客', 'https://blog.unity.com/feed'],
  ['Godot 官方博客', 'https://godotengine.org/rss.xml'],
  ['UE 官方', 'https://www.unrealengine.com/en-US/rss'],
  ['GameFromScratch', 'https://gamefromscratch.com/feed/'],
  ['80.lv', 'https://80.lv/feed'],
  ['机核', 'https://www.gcores.com/rss'],
]

function linkOf(xml) {
  const out = []
  for (const block of xml.split(/<item[\s>]/).slice(1)) {
    const m = block.match(/<link>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/link>/)
      || block.match(/<link[^>]*href="([^"]+)"/)
    const t = block.match(/<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/)
    const d = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || block.match(/<published>([\s\S]*?)<\/published>/) || block.match(/<dc:date>([\s\S]*?)<\/dc:date>/)
    if (m && t) out.push({ link: m[1].trim(), title: t[1].replace(/<[^>]+>/g, '').slice(0, 70), date: (d?.[1] ?? '').trim().slice(0, 25) })
  }
  return out
}

async function head(url, opts = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 dsh-probe', accept: 'application/rss+xml,application/xml,application/json' }, signal: AbortSignal.timeout(12000), ...opts })
  return res
}

console.log('=== RSS 源（取前 15 条，看与库重复） ===')
for (const [label, url] of FEEDS) {
  try {
    const res = await head(url)
    const xml = await res.text()
    const items = linkOf(xml).slice(0, 15)
    const dup = items.filter((it) => knownSet.has(it.link.toLowerCase())).length
    console.log(`\n${label}  HTTP ${res.status}  条目 ${items.length}  库内重复 ${dup}`)
    for (const it of items.slice(0, 6)) console.log(`   ${knownSet.has(it.link.toLowerCase()) ? 'DUP ' : 'NEW '} ${it.date.slice(0, 16).padEnd(17)} ${it.title}`)
  } catch (e) { console.log(`\n${label}  失败: ${e.message}`) }
}

console.log('\n=== GitHub Search（created>120d，sort=stars，stars>=20，前 15） ===')
const GHQ = ['topic:unity', 'topic:game-ai', 'topic:game-engine', 'topic:godot', 'topic:unreal-engine']
const since = new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10)
for (const q of GHQ) {
  try {
    const res = await head(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} created:>${since} fork:false stars:>=20`)}&sort=stars&order=desc&per_page=15`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-probe' } })
    if (!res.ok) { console.log(`\n${q}  HTTP ${res.status} 剩余 ${res.headers.get('x-ratelimit-remaining')}`); continue }
    const data = await res.json()
    const items = (data.items ?? []).map((it) => ({ link: it.html_url, created: String(it.created_at).slice(0, 10), stars: it.stargazers_count, name: it.full_name }))
    const dup = items.filter((it) => knownSet.has(it.link.toLowerCase())).length
    console.log(`\n${q}  条目 ${items.length}  库内重复 ${dup}`)
    for (const it of items.slice(0, 8)) console.log(`   ${knownSet.has(it.link.toLowerCase()) ? 'DUP ' : 'NEW '} ${it.created} ${String(it.stars).padStart(6)}★ ${it.name}`)
  } catch (e) { console.log(`\n${q}  失败: ${e.message}`) }
}

console.log('\n=== HN Algolia（created_at_i>120d，points>5，前 15） ===')
const hnSince = Math.floor((Date.now() - 120 * 86400e3) / 1000)
for (const q of ['game engine', 'unity', 'godot', 'gamedev']) {
  try {
    const res = await head(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${hnSince},points>5&hitsPerPage=15`)
    const data = await res.json()
    const items = (data.hits ?? []).map((h) => ({ link: String(h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`), created: String(h.created_at).slice(0, 10), points: h.points, title: String(h.title ?? '').slice(0, 60) }))
    const dup = items.filter((it) => knownSet.has(it.link.toLowerCase())).length
    console.log(`\n${q}  条目 ${items.length}  库内重复 ${dup}`)
    for (const it of items.slice(0, 8)) console.log(`   ${knownSet.has(it.link.toLowerCase()) ? 'DUP ' : 'NEW '} ${it.created} ${String(it.points).padStart(4)}★ ${it.title}`)
  } catch (e) { console.log(`\n${q}  失败: ${e.message}`) }
}
