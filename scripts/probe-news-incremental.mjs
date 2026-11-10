/* 诊断用：验证「增量采集」到底有没有解决「每轮都在挑同一批」。
 *
 * 直接 import 未打包的 src/host/news-sources.ts（Node 24 自带类型剥离），
 * 用真实库里的已知 URL 跑两遍采集：
 *   A) 不传 excludeUrls —— 旧行为，看挑出来的 12 条里有几条是库里已有的；
 *   B) 传 excludeUrls    —— 新行为，看剩下的候选里还有几条是真新的。
 * 只读库、不写库；会打外网（各源真实抓取）。
 * 用法：node scripts/probe-news-incremental.mjs [topicId]
 */
import { DatabaseSync } from 'node:sqlite'

const topicId = process.argv[2] || 'news-ac061588-173'
const DB = 'C:/Users/gh/.dsh/dsh-workbench.sqlite'

const db = new DatabaseSync(DB)
const topic = db.prepare('SELECT * FROM news_topics WHERE id = ?').get(topicId)
if (!topic) {
  console.error(`没有这个订阅：${topicId}`)
  process.exit(1)
}
const knownAll = db.prepare('SELECT url FROM news_items').all().map((r) => String(r.url).toLowerCase())
const knownTopic = db.prepare('SELECT url FROM news_items WHERE topic_id = ?').all(topicId).map((r) => String(r.url).toLowerCase())
console.log(`订阅 ${topic.id}「${topic.title}」count=${topic.count} sources=${JSON.stringify(topic.sources ?? [])}`)
console.log(`库里 URL：全部 ${knownAll.length} 条 / 本订阅 ${knownTopic.length} 条\n`)

const { collectFromSources } = await import('../src/host/news-sources.ts')
const SOURCES = ['engine-official', 'github-discover', 'tech-media', 'hn-tech', 'github-releases']
const limit = Math.max(1, Math.min(20, Number(topic.count ?? 12)))

function report(label, result, knownSet) {
  const dup = result.items.filter((it) => knownSet.has(it.url.toLowerCase()))
  console.log(`\n=== ${label} ===`)
  console.log(`挑出 ${result.total} 条，其中库里已有 ${dup.length} 条 → 真新 ${result.total - dup.length} 条`)
  for (const run of result.runs) {
    const tag = run.error ? `失败：${run.error}` : `候选 ${run.fetched ?? run.items.length} 条 / 已看过 ${run.excluded ?? 0} / 留下 ${run.items.length}`
    console.log(`  · ${run.label}（${run.ms}ms）${tag}`)
  }
  for (const it of result.items) {
    console.log(`    ${knownSet.has(it.url.toLowerCase()) ? 'DUP' : 'NEW'} [${it.kind}] ${it.title.slice(0, 60)}`)
  }
}

const t0 = Date.now()
const withoutExclude = await collectFromSources(SOURCES, limit, {})
report('A) 不排除已看过（旧行为）', withoutExclude, new Set(knownAll))

/* 第二次必须用同一个已知集合；源侧结果秒级变化，但仍能看出「排除之后的候选厚度」 */
const t1 = Date.now()
const withExclude = await collectFromSources(SOURCES, limit, {}, { excludeUrls: knownTopic })
report('B) 排除本订阅已看过（新行为）', withExclude, new Set(knownAll))

console.log(`\n耗时：A ${t1 - t0}ms / B ${Date.now() - t1}ms`)
