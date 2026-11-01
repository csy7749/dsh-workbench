/**
 * 新闻采集源（第一期：零依赖直连）。
 *
 * 产品口径（用户 2026-10-31 拍板，取代早期「查引擎发版」的理解）：
 *   - **GitHub 不是用来查引擎发版的**，而是找「新鲜好用的开源游戏工具与项目」，
 *     尤其 Unity 相关，以及与游戏相关的 AI 技术 —— 走 Search API 按 topic + 新鲜度发现；
 *   - **引擎版本资讯**走官方博客（Unity / Godot / UE 的 RSS）与技术媒体账号；
 *   - RSSHub 只用来承载没有原生 RSS 的中文游戏媒体，需要 934MB 依赖，不进入第一期。
 *
 * 约束：
 *   - 全部用全局 fetch，不引入 cheerio / rss-parser / ofetch；
 *   - 单源失败不抛出，返回 { items: [], error }，由上层决定健康度；
 *   - 产出字段必须能被 index.ts 的 cleanNewsItemsDetailed 接受（它还会再做一次
 *     URL 合法性、枚举白名单、14/180 天时效闸门）。
 */

export type NewsSourceKey = 'official' | 'github' | 'community' | 'media'

/**
 * 与 index.ts 的 NEWS_SOURCE_KEYS / NEWS_KINDS 保持一致。
 *
 * 2026-11-01 迁移到「游戏技术雷达」口径的 7 类。
 * 旧的 12 类是「游戏资讯」时代留下的（update/dlc/announcement/dev/community/data/review/peripheral
 * 加上雷达新增的 oss/tool/tutorial/paper），两套混在一起没人说得清一条属于哪类。
 * 现行 7 类只看**内容形态**，不看来源：
 */
export type NewsKind =
  /** 官方发布：引擎/工具/框架的新版本与公告 */
  | 'release'
  /** 开源首发：新冒出来的开源项目与工具 */
  | 'oss-launch'
  /** 教程 */
  | 'tutorial'
  /** 深度解析：原理剖析、源码分析、技术长文 */
  | 'deep-dive'
  /** 论文 */
  | 'paper'
  /** 工具更新：已有工具的版本迭代 */
  | 'tool-update'
  /** 其它：兜底，读到的未知值也归这里 */
  | 'other'

export type RawNewsItem = {
  title: string
  url: string
  source: string
  sourceKey: NewsSourceKey
  kind: NewsKind
  publishedAt: string
  summary: string
  /**
   * 热度（2026-11-01）：各源自己的原始值，**不做跨源归一化**——points 是几十上百的整数，
   * star 增速是「每天几颗星」的小数，混在一起比大小没有意义。heatKind 标明量纲。
   */
  heat?: number
  heatKind?: 'points' | 'star-velocity' | ''
}

export type SourceRun = {
  id: string
  label: string
  items: RawNewsItem[]
  error?: string
  ms: number
}

export type SourceDescriptor = {
  id: string
  label: string
  /** 源类别，决定 sourceKey 默认值 */
  layer: NewsSourceKey
  /** 该源默认产出的内容类型 */
  kind: NewsKind
  /** 需要在请求里额外指定的参数，如 Steam 的 appid、GitHub 的 owner/repo */
  params?: { key: string; label: string; placeholder: string }[]
  enabled: boolean
  /**
   * 技术密度权重（缺省 1）。只影响「跨源抢位置」时的配额，不影响源内部排序。
   * 依据：实测机核首页常见万智牌赛程、周报这类与技术无关内容，而引擎官方博客
   * 与 GitHub 项目发现几乎条条有技术实质，所以前者给 1、后者给 3。
   */
  weight?: number
  note: string
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT_MS = 10_000

/** 统一超时 fetch。 */
async function fetchText(url: string, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', timeoutMs = TIMEOUT_MS): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 剥 CDATA 与 HTML 标签，压空白，截断。
 *
 * 顺序很关键：很多 feed（例如 Unreal Engine 的 Atom）把 HTML **实体转义**成
 * `&lt;p&gt;hello&lt;/p&gt;`，如果先剥标签再解实体，就会把 `&lt;p&gt;` 还原成
 * 一个裸标签留在标题里。所以必须「解实体 → 剥标签 → 再解一次实体」。
 */
function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi, '&')
}

function plainText(raw: string, max = 600): string {
  let s = String(raw ?? '')
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  s = decodeEntities(s)
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/\s+/g, ' ').trim()
  return s.slice(0, max)
}

/**
 * 按词边界截断并补省略号（2026-11-01 D3）。
 *
 * 原来 github-discover 用的是 `plainText(..., 120)`，本质就是 `slice(0, 120)`：
 * 会把单词从中间劈开（`... image-gene`），也可能把 emoji 的代理对切成半个字符（显示成 �）。
 * 这里先按**码点**切（`Array.from` 把代理对当一个元素，emoji 不会被撕开），
 * 再尽量退到最近的空格；只有空格足够靠后（≥60%）才采纳，否则为了一个空格
 * 砍掉近一半标题不值。余量固定留 1 个位置给省略号。
 */
export function clipText(text: string, max: number): string {
  const raw = String(text ?? '')
  const chars = Array.from(raw)
  if (chars.length <= max) return raw
  const cut = chars.slice(0, Math.max(1, max - 1))
  const lastSpace = cut.lastIndexOf(' ')
  const keep = lastSpace >= Math.floor(cut.length * 0.6) ? cut.slice(0, lastSpace) : cut
  return `${keep.join('').trimEnd()}…`
}

/** 从任意日期字符串取 YYYY-MM-DD；失败返回空串（让上层的时间闸门放行）。 */
function toDateOnly(text: string): string {
  const raw = String(text ?? '').trim()
  if (raw === '') return ''
  // 已是 YYYY-MM-DD
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toISOString().slice(0, 10)
}

/** 轻量 RSS 2.0 / Atom 解析：只取 title / link / date / description。 */
function parseFeed(xml: string, limit: number): { title: string; url: string; date: string; desc: string }[] {
  const out: { title: string; url: string; date: string; desc: string }[] = []
  const blocks = [
    ...Array.from(xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)).map((m) => m[0]),
    ...Array.from(xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)).map((m) => m[0]),
  ]
  for (const block of blocks) {
    if (out.length >= limit) break
    const pick = (tag: string): string => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
      return m ? m[1] : ''
    }
    const title = plainText(pick('title'), 300)
    // Atom 的 link 在属性里
    let url = ''
    const linkAttr = block.match(/<link[^>]*href="([^"]+)"/i)
    if (linkAttr) url = linkAttr[1]
    if (url === '') url = plainText(pick('link'), 500)
    if (url === '' && /<guid[^>]*isPermaLink="true"/i.test(block)) url = plainText(pick('guid'), 500)
    const date = pick('pubDate') || pick('published') || pick('updated') || pick('dc:date')
    const desc = pick('description') || pick('summary') || pick('content:encoded') || pick('content')
    if (title === '' || !/^https?:\/\//i.test(url)) continue
    out.push({ title, url, date, desc })
  }
  return out
}

/* ───────────────────────── 源 1：引擎官方 RSS（Unity / Godot / UE） ───────────────────────── */

const ENGINE_FEEDS: { id: string; label: string; url: string }[] = [
  { id: 'unity', label: 'Unity 官方博客', url: 'https://blog.unity.com/feed' },
  { id: 'godot', label: 'Godot 官方博客', url: 'https://godotengine.org/rss.xml' },
  { id: 'unreal', label: 'Unreal Engine 官方', url: 'https://www.unrealengine.com/en-US/rss' },
]

/**
 * 按「分组配额 + 时间补齐」挑选，而不是全局按时间排序后截断。
 *
 * 为什么必须这样做：引擎官方博客（Unity/Godot/UE）发得很勤，而 GitHub
 * Releases 天然比博客文章老。如果合并后全局按 publishedAt 降序取前 N，
 * GitHub 这条源会**永远一条都进不来**——实测 limit=6 时 6 条全是引擎官方，
 * GitHub 的 8 条全被时间挤出。同理在引擎官方内部，Unity 发博客的频率远高于
 * Godot / UE，不给每家保底名额就等于只有 Unity。所以先给每组保底名额，
 * 余量再按时间补，最终输出仍按时间降序（新的在前）。
 */
function pickWithQuota<T extends { publishedAt: string }>(groups: T[][], limit: number): T[] {
  const nonEmpty = groups.filter((g) => g.length > 0)
  if (nonEmpty.length === 0) return []
  const sorted = nonEmpty.map((g) => g.slice().sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))))
  const base = Math.max(1, Math.floor(limit / sorted.length))
  const picked: T[] = []
  const rest: T[] = []
  for (const g of sorted) {
    picked.push(...g.slice(0, base))
    rest.push(...g.slice(base))
  }
  rest.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
  picked.push(...rest.slice(0, Math.max(0, limit - picked.length)))
  return picked.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
}

/**
 * 跨源配额分配（带权重）。
 *
 * 与 pickWithQuota 的区别：等分会让「机核」这种综合文化媒体与「引擎官方博客」
 * 拿一样多的位置，实测机核首屏经常是万智牌赛程、周报这类与技术无关的内容。
 * 权重让源的**技术密度**直接决定它占几个位置，同时保留「每组至少 1 条」
 * 的保底，避免小源被彻底饿死。
 */
function pickWithWeightedQuota<T extends { publishedAt: string }>(groups: Array<{ items: T[]; weight: number }>, limit: number): T[] {
  const nonEmpty = groups
    .filter((g) => g.items.length > 0)
    .map((g) => ({ items: g.items.slice().sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))), weight: Math.max(1, g.weight) }))
  if (nonEmpty.length === 0) return []
  const totalWeight = nonEmpty.reduce((sum, g) => sum + g.weight, 0)
  const picked: T[] = []
  // 每组先拿保底配额，剩下的候选进 rest，各记「还能再补几条」
  const rest: Array<{ item: T; group: number }> = []
  nonEmpty.forEach((g, gi) => {
    const quota = Math.max(1, Math.floor((limit * g.weight) / totalWeight))
    picked.push(...g.items.slice(0, quota))
    for (const item of g.items.slice(quota)) rest.push({ item, group: gi })
  })
  // 余量按时间补，但**每组最多再补 1 条**。
  // 不加上限的话，更新频次高的源（实测机核每天十几条、日期最新）会靠日期
  // 把余量全吃光，等于绕过了权重——权重就形同虚设了。
  rest.sort((a, b) => String(b.item.publishedAt).localeCompare(String(a.item.publishedAt)))
  const used = new Set<number>()
  for (const entry of rest) {
    if (picked.length >= limit) break
    if (used.has(entry.group)) continue
    used.add(entry.group)
    picked.push(entry.item)
  }
  if (picked.length > limit) picked.length = limit
  // 注意：这里**不按日期重排**。保持「权重高的组在前」的顺序，上层按索引取用时
  // 才符合权重意图；最终展示顺序由 collectFromSources 统一按时间排。
  return picked
}

async function collectEngineOfficial(limit: number): Promise<RawNewsItem[]> {
  const results = await Promise.allSettled(
    ENGINE_FEEDS.map(async (feed) => {
      const xml = await fetchText(feed.url, 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8', 8000)
      return parseFeed(xml, limit).map((it): RawNewsItem => ({
        title: it.title,
        url: it.url,
        source: feed.label,
        sourceKey: 'official',
        kind: 'release',
        publishedAt: toDateOnly(it.date),
        summary: plainText(it.desc, 600),
      }))
    }),
  )
  // 每个 feed 一组，按配额挑，保证 Unity 不会把 Godot / UE 挤掉
  const groups: RawNewsItem[][] = []
  for (const r of results) if (r.status === 'fulfilled') groups.push(r.value)
  return pickWithQuota(groups, limit)
}

/* ───────────────────────── 源 2：GitHub Releases（直连 API，免 token） ───────────────────────── */

/**
 * 默认关注的仓库：只放**确实有 Releases 的开源引擎**。
 *
 * 2026-10-31 实测（per_page=2）：
 *   godotengine/godot                 200 / 有（3.6.3-stable、4.7.2-stable）
 *   bevyengine/bevy                   200 / 有（v0.20.1）
 *   cocos/cocos-engine                200 / 有（Release 3.8.8）
 *   o3de/o3de                         200 / 有（2605.0）
 *   Unity-Technologies/UnityCsReference 200 但 **0 条 Releases**（Unity 不用 GitHub Releases 发版）
 *   EpicGames/UnrealEngine            404（私有仓库，匿名 API 不可见）
 *
 * 所以 Unity / UE 的版本信息**不可能**从这条源拿到，必须靠官方博客（engine-official 源）。
 * 这条源的定位是「开源引擎与工具的发版」，不是「三家引擎版本全覆盖」。
 */
const DEFAULT_REPOS = ['godotengine/godot', 'bevyengine/bevy', 'cocos/cocos-engine', 'o3de/o3de']

/** 解析仓库列表：显式 params.repo（逗号分隔）优先；其次从 query 里找 owner/repo；再次按关键词。 */
function resolveRepos(params: Record<string, string>): string[] {
  const explicit = String(params.repo ?? '').split(',').map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s))
  if (explicit.length > 0) return explicit.slice(0, 6)
  const text = String(params.query ?? '').trim()
  const inText = text.match(/([\w.-]+)\/([\w.-]+)/)
  if (inText) return [`${inText[1]}/${inText[2]}`]
  const KEYWORD: Record<string, string[]> = {
    unity: ['Unity-Technologies/UnityCsReference'],
    godot: ['godotengine/godot'],
    unreal: ['o3de/o3de'],
    bevy: ['bevyengine/bevy'],
    cocos: ['cocos/cocos-engine'],
  }
  const key = text.toLowerCase()
  return KEYWORD[key] ?? DEFAULT_REPOS
}

async function fetchRepoReleases(repo: string, limit: number): Promise<RawNewsItem[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=${Math.min(20, Math.max(1, limit))}`, {
    headers: { 'user-agent': 'dsh-workbench', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  // 单仓库失败（404 私有库 / 0 条 releases）不该让整条源失败，交给上层按空组处理
  if (!res.ok) {
    // 配额用尽是**暂时**状态，不是源坏了。实测未认证 core API 只有 60 次/小时，
    // 一次开发期验证就能打光，4 个仓库会同时回 403。必须把这种状态与「仓库 404」
    // 区分开，否则界面上会显示 4 行吓人的 HTTP 403，而实际半小时后自动恢复。
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0)
      const when = reset > 0 ? new Date(reset * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '稍后'
      throw new Error(`github_rate_limited：配额用尽，${when} 后自动恢复（未认证 60 次/小时，配 GITHUB_TOKEN 可提到 5000）`)
    }
    throw new Error(`GitHub ${repo} HTTP ${res.status}`)
  }
  const data = (await res.json()) as any
  if (!Array.isArray(data)) return []
  return data.slice(0, limit).map((rel: any) => ({
    title: `${repo.split('/')[1]} ${String(rel?.name || rel?.tag_name || 'release')}`,
    url: String(rel?.html_url ?? ''),
    source: `GitHub · ${repo}`,
    sourceKey: 'github' as NewsSourceKey,
    kind: 'release' as NewsKind,
    publishedAt: toDateOnly(String(rel?.published_at ?? rel?.created_at ?? '')),
    summary: plainText(String(rel?.body ?? ''), 600),
  })).filter((x: RawNewsItem) => x.url !== '')
}

/** 多仓库并发采集，再按仓库配额挑选（否则更新勤的库会挤掉安静的库）。 */
async function collectGithubReleases(limit: number, params: Record<string, string>): Promise<RawNewsItem[]> {
  const repos = resolveRepos(params)
  const results = await Promise.allSettled(repos.map((repo) => fetchRepoReleases(repo, limit)))
  const groups: RawNewsItem[][] = []
  const failures: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value.length > 0) groups.push(r.value)
    } else {
      failures.push(`${repos[i]}: ${String((r.reason as Error)?.message ?? r.reason)}`)
    }
  })
  // 全部仓库都失败才算这条源失败；部分失败返回可用的部分
  if (groups.length === 0) {
    // 配额用尽会让每个仓库都报同一件事，拼接 4 行没有信息量，只留一句
    const rateLimited = failures.find((f) => f.includes('github_rate_limited'))
    if (rateLimited) throw new Error(rateLimited.slice(rateLimited.indexOf('github_rate_limited')))
    throw new Error(failures.join('; ') || 'no_releases')
  }
  return pickWithQuota(groups, limit)
}

/* ───────────────────────── 源 3：Steam 新闻（直连 v2 API，免 token） ───────────────────────── */

function guessAppId(params: Record<string, string>): string {
  const explicit = String(params.appid ?? '').trim()
  if (/^\d+$/.test(explicit)) return explicit
  const fromQuery = String(params.query ?? '').match(/\b(\d{4,8})\b/)
  if (fromQuery) return fromQuery[1]
  // 常用游戏兜底：黑神话悟空
  return '2358720'
}

async function collectSteamNews(limit: number, params: Record<string, string>): Promise<RawNewsItem[]> {
  const appid = guessAppId(params)
  const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=${Math.min(20, Math.max(1, limit))}&maxlength=600`
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Steam HTTP ${res.status}`)
  const data = (await res.json()) as any
  const list = data?.appnews?.newsitems
  if (!Array.isArray(list)) throw new Error('unexpected_payload')
  return list.slice(0, limit).map((it: any) => {
    const date = Number(it?.date ?? 0)
    return {
      title: plainText(String(it?.title ?? ''), 300),
      url: String(it?.url ?? ''),
      source: `Steam · ${String(it?.feedlabel ?? appid)}`,
      sourceKey: 'official' as NewsSourceKey,
      kind: 'release' as NewsKind,
      publishedAt: date > 0 ? new Date(date * 1000).toISOString().slice(0, 10) : '',
      summary: plainText(String(it?.contents ?? ''), 600),
    }
  }).filter((x: RawNewsItem) => x.title !== '' && x.url !== '')
}

/* ─────────────── 源 4：GitHub 项目发现（Search API，找新工具/新项目，不是查发版） ─────────────── */

/**
 * 用户 2026-10-31 的原话：
 *   「GitHub 上不是让你去看 Unity 他们的发版，更多的是新鲜好用的开源游戏工具和项目，
 *     特别是 unity 相关的，还有就是与游戏相关的 ai 技术。」
 *
 * 所以这条源用 Search API 按 topic + 建仓时间发现，而不是拉某个仓库的 Releases。
 * 排序不用绝对 star 数（老项目会永远占前面），而用 **star 增速 = stars / 建仓天数**。
 *
 * 限流：未认证 Search API 只有 **10 次/分钟**（实测打第 5 条就 403），Core 是 60 次/小时。
 * 因此默认只跑 3 条查询；配了 GITHUB_TOKEN 才放开到 5 条。
 */
const DISCOVERY_QUERIES: { q: string; kind: NewsKind; label: string }[] = [
  { q: 'topic:unity', kind: 'oss-launch', label: 'Unity 相关项目' },
  { q: 'topic:game-ai', kind: 'oss-launch', label: '游戏 AI' },
  { q: 'topic:game-engine', kind: 'oss-launch', label: '游戏引擎/工具' },
  { q: 'topic:godot', kind: 'oss-launch', label: 'Godot 项目' },
  { q: 'topic:unreal-engine', kind: 'oss-launch', label: 'Unreal 项目' },
]

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': 'dsh-workbench', accept: 'application/vnd.github+json' }
  const token = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()
  if (token !== '') headers.authorization = `Bearer ${token}`
  return headers
}

async function searchRepos(q: string, perPage: number): Promise<any[]> {
  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`,
    { headers: githubHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) },
  )
  if (res.status === 403 || res.status === 429) {
    throw new Error('github_rate_limited（未认证 Search API 限 10 次/分钟，配 GITHUB_TOKEN 可提高到 30）')
  }
  if (!res.ok) throw new Error(`GitHub search HTTP ${res.status}`)
  const data = (await res.json()) as any
  return Array.isArray(data?.items) ? data.items : []
}

async function collectGithubDiscovery(limit: number, params: Record<string, string>): Promise<RawNewsItem[]> {
  const windowDays = Math.max(7, Math.min(180, Math.round(Number(params.days ?? 120) || 120)))
  const minStars = Math.max(0, Math.round(Number(params.minStars ?? 20) || 20))
  const hasToken = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim() !== ''
  const maxQueries = hasToken ? 5 : 3
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10)
  const queries = DISCOVERY_QUERIES.slice(0, maxQueries)

  const results = await Promise.allSettled(
    queries.map((item) => searchRepos(`${item.q} created:>${since} fork:false stars:>=${minStars}`, 15)),
  )

  const errors: string[] = []
  const scored: { item: RawNewsItem; velocity: number }[] = []
  const nowStamp = Date.now()
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      errors.push(`${queries[i].q}: ${String((r.reason as Error)?.message ?? r.reason)}`)
      return
    }
    for (const repo of r.value) {
      if (repo?.fork) continue
      const stars = Number(repo?.stargazers_count ?? 0)
      if (stars < minStars) continue
      const created = Date.parse(String(repo?.created_at ?? ''))
      const htmlUrl = String(repo?.html_url ?? '')
      if (!Number.isFinite(created) || htmlUrl === '') continue
      const ageDays = Math.max(1, (nowStamp - created) / 86_400_000)
      if (ageDays > 180) continue
      const velocity = stars / ageDays
      const fullName = String(repo?.full_name ?? '')
      const desc = plainText(String(repo?.description ?? ''), 200)
      const lang = String(repo?.language ?? '').trim()
      const metrics = [desc, `${stars}★`, `${Math.round(ageDays)} 天`, `日增 ${velocity.toFixed(1)}★`, lang]
        .filter((x) => x !== '')
        .join(' · ')
      scored.push({
        velocity,
        item: {
          // 标题给「仓库名 + 一句话简介」，只写 owner/repo 的话卡片上完全看不出是干什么的
          title: clipText(desc === '' ? fullName : `${fullName} · ${desc}`, 120),
          url: htmlUrl,
          source: `GitHub · ${queries[i].label}`,
          sourceKey: 'github',
          kind: queries[i].kind,
          publishedAt: new Date(created).toISOString().slice(0, 10),
          summary: clipText(metrics, 600),
          /* 热度＝star 增速（stars/ageDays）：这才是「新鲜好用」的判据，绝对 star 数只会把老项目顶在前面 */
          heat: velocity,
          heatKind: 'star-velocity',
        },
      })
    }
  })

  // 全部查询都失败才算这条源失败；限流时如果一条都没拿到，明确报出来
  if (scored.length === 0) throw new Error(errors.join('; ') || 'no_repositories')

  // 按 star 增速降序：这才是「新鲜好用」的判据，绝对 star 数只会把老项目顶在前面
  scored.sort((a, b) => b.velocity - a.velocity)
  const seen = new Set<string>()
  const out: RawNewsItem[] = []
  for (const { item } of scored) {
    const key = item.url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

/* ───────────────────────── 源 5：游戏技术媒体（直连原生 RSS） ───────────────────────── */

/**
 * 「比较火的游戏技术论坛 / 游戏技术新闻账号」这一侧。
 *
 * 2026-10-31 实测（直连，不需要 RSSHub）：
 *   gamefromscratch.com/feed      200 RSS / 10 条 —— 游戏开发工具新闻（Ucupaint、Brutal、Unibuilder…）技术密度最高
 *   80.lv/feed                    200 RSS / 10 条 —— 游戏技术 / 美术技术
 *   gcores.com/rss                200 RSS / 20 条 —— 中文游戏媒体（综合方向，技术密度低，但补中文）
 *   indienova /feed、/rss         404（无原生 RSS，只能走 RSSHub）
 *   gamedeveloper.com/rss.xml     403 Cloudflare
 *   gamedev.net/rss               403
 */
const TECH_MEDIA_FEEDS: { id: string; label: string; url: string; kind: NewsKind; weight: number }[] = [
  // 权重直接反映技术密度：GameFromScratch 条条是开发工具发布，80.lv 是技术/美术拆解，
  // 机核是综合游戏文化（周报、赛事、发售），技术条目只是偶尔出现，所以给最低权重。
  { id: 'gamefromscratch', label: 'GameFromScratch · 工具新闻', url: 'https://gamefromscratch.com/feed/', kind: 'tool-update', weight: 3 },
  { id: '80lv', label: '80.lv · 游戏技术', url: 'https://80.lv/feed', kind: 'tutorial', weight: 3 },
  { id: 'gcores', label: '机核 · 中文游戏媒体', url: 'https://www.gcores.com/rss', kind: 'other', weight: 1 },
]

async function collectTechMedia(limit: number): Promise<RawNewsItem[]> {
  const results = await Promise.allSettled(
    TECH_MEDIA_FEEDS.map(async (feed) => {
      const xml = await fetchText(feed.url, 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8', 8000)
      return parseFeed(xml, limit).map((it): RawNewsItem => ({
        title: it.title,
        url: it.url,
        source: feed.label,
        sourceKey: 'media',
        kind: feed.kind,
        publishedAt: toDateOnly(it.date),
        summary: plainText(it.desc, 600),
      }))
    }),
  )
  const groups: { items: RawNewsItem[]; weight: number }[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length > 0) groups.push({ items: r.value, weight: TECH_MEDIA_FEEDS[i].weight })
  })
  if (groups.length === 0) throw new Error('all_feeds_failed')
  return pickWithWeightedQuota(groups, limit)
}

/* ───────────────────────── 源 6：Hacker News 技术讨论（官方 Algolia API） ───────────────────────── */

/**
 * 「比较火的游戏技术论坛」的英文侧。
 *
 * 一开始用的是 hnrss.org 的关键词 RSS，实测不可用：
 *   unity 6.3s / godot 7.5s / gamedev 1.9s / game+engine 20s 超时，
 *   而且连续请求会被限流，整轮采集经常 12s 预算内一条都拿不到。
 *
 * 换成 Hacker News 的官方搜索 API（hn.algolia.com，免 key、JSON、稳定）后
 * 单查询 719–919ms，并且自带 points 与评论数——正好是本设计里要的「热度」信号，
 * 不用再自己估。样本（2026-10-31 实测，points 降序）：
 *   game engine → fheroes2 220★ / Libsm64 196★ / Show HN: C# Game Engine 118★
 *   unity       → VLC for Unity 169★ / RimWorld 1.7 从 Unity 迁到自研引擎 101★
 *   godot       → 移植 1993 年 Amiga 游戏到 Godot（用 LLM 读源码）381★
 */
const HN_QUERIES = [
  { q: 'game engine', label: 'HN · 游戏引擎' },
  { q: 'unity', label: 'HN · Unity' },
  { q: 'godot', label: 'HN · Godot' },
  { q: 'gamedev', label: 'HN · 游戏开发' },
]

/**
 * q=unity 是**全文匹配**，会把数学与政治语境一起捞回来。
 * 实测样本：「Notes on the Complex Roots of Unity」（单位根，纯数学，45★）。
 * 这类条目进技术雷达是纯噪音，所以先过一道语境闸门：
 * 命中下面这些短语、且标题里没有任何游戏开发字样，就丢掉。
 *
 * 这一层与 index.ts 的「相关性闸门」（NEWS_OFF_TOPIC_PATTERNS / NEWS_TECH_TERMS）**分工不同，不合并**：
 * - 这里管「查询词本身的歧义」：HN 全文检索把 unity 当政治/数学词命中，只有这个源有这问题，
 *   而且判据是「命中噪音短语 **且** 没有任何游戏开发字样」，比其他源更宽。
 * - 那边管「整条内容跑题」：所有非官方源共用，判据是「命中黑名单，或一个技术词都没有」。
 * 合并会两头受伤：把 HN 的宽判据推广到全源会漏掉大量偏题条目，把通用闸门塞进 HN 会误杀
 * 「Show HN: I built a physics engine」这类标题不含 game 字样的正当技术帖。
 */
const HN_NOISE_PATTERNS = /roots? of unity|unity (?:government|party|cup|day|church|of (?:the|faith))|national unity|political unity|european unity|african unity|spiritual unity|unity (?:and|is|in) /i
const HN_GAME_HINT = /game|engine|gamedev|shader|render|3d|sprite|level.?design|unreal|godot|unity.?editor|textmesh|indie|mod|mobile/i

function isNoise(title: string): boolean {
  return HN_NOISE_PATTERNS.test(title) && !HN_GAME_HINT.test(title)
}

async function collectHackerNews(limit: number, params: Record<string, string>): Promise<RawNewsItem[]> {
  const days = Math.max(7, Math.min(180, Math.round(Number(params.days ?? 120) || 120)))
  const minPoints = Math.max(0, Math.min(500, Math.round(Number(params.minPoints ?? 5) || 0)))
  const since = Math.floor((Date.now() - days * 86400e3) / 1000)
  const perQuery = Math.min(20, Math.max(5, limit))

  const results = await Promise.allSettled(
    HN_QUERIES.map(async (item) => {
      const url = 'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(item.q)
        + `&tags=story&numericFilters=created_at_i>${since},points>${minPoints}&hitsPerPage=${perQuery}`
      // Algolia 是本项目所有源里最慢的一个：实测单查询 2.4–10.6s（服务端不稳，
      // 与过滤条件无关）。四个查询并行跑，所以整源耗时≈最慢那一条。
      // 给 8s 而不是 10s：超时的那条查询单独失败，其余照常返回，不拖垮整轮采集。
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`HN ${item.q} HTTP ${res.status}`)
      const data = (await res.json()) as any
      const hits: any[] = Array.isArray(data?.hits) ? data.hits : []
      // 两道闸门，都是实测踩出来的：
      //  ① Algolia 默认带**拼写容错**，q=unity 会把「The United Kingdom ...」配进来，
      //     所以必须自己再验一次「标题里确实有这个词」。
      //  ② 同一条故事会被多个查询命中（实测 Show HN: Parin 同时命中 game engine 与 godot），
      //     源内要先按 URL 去重，否则同一张卡出现两遍。
      const tokens = item.q.toLowerCase().split(/\s+/).filter(Boolean)
      const seenUrls = new Set<string>()
      return hits
        .filter((h) => {
          const t = String(h?.title ?? '')
          if (!t) return false
          if (!tokens.some((tok) => t.toLowerCase().includes(tok))) return false
          return !isNoise(t)
        })
        .map((h): RawNewsItem => {
          const hnLink = `https://news.ycombinator.com/item?id=${String(h.objectID ?? '')}`
          const points = Number(h.points ?? 0)
          const comments = Number(h.num_comments ?? 0)
          return {
            // 带上 points 与评论数：这是本设计要的「热度」，比标题本身更能说明值不值得看
            title: `${plainText(String(h.title), 300)} · ${points}★ ${comments} 评论`,
            url: String(h.url || hnLink),
            source: item.label,
            sourceKey: 'community',
            kind: 'other',
            publishedAt: toDateOnly(String(h.created_at ?? '')),
            summary: plainText(`${points} 分 · ${comments} 条讨论 · ${String(h.url || hnLink)}`, 600),
            /* 热度＝HN 分数（评论数已写进摘要，不再单列一个量纲） */
            heat: points,
            heatKind: 'points',
          }
        })
        .filter((x) => {
          const key = x.url.toLowerCase()
          if (seenUrls.has(key)) return false
          seenUrls.add(key)
          return true
        })
    }),
  )

  const groups: RawNewsItem[][] = []
  const failures: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { if (r.value.length > 0) groups.push(r.value) }
    else failures.push(`${HN_QUERIES[i].q}: ${String((r.reason as Error)?.message ?? r.reason)}`)
  })
  if (groups.length === 0) throw new Error(failures.join('; ') || 'hn_empty')
  return pickWithQuota(groups, limit)
}

/* ───────────────────────── 注册表与调度 ───────────────────────── */

export const NEWS_SOURCES: SourceDescriptor[] = [
  {
    id: 'github-discover',
    label: 'GitHub 项目发现（开源工具/AI）',
    layer: 'github',
    kind: 'oss-launch',
    params: [
      { key: 'days', label: '新鲜窗口（天）', placeholder: '默认 120，最大 180' },
      { key: 'minStars', label: '最低 star', placeholder: '默认 20，用于过滤噪音' },
    ],
    weight: 4,
    enabled: true,
    note: 'Search API 按 topic + 建仓时间发现新项目，按 star 增速排序。免 token 限 10 次/分钟（默认只跑 3 条查询），配 GITHUB_TOKEN 可到 30 次/分钟。',
  },
  {
    id: 'engine-official',
    label: '引擎官方（Unity / Godot / UE）',
    layer: 'official',
    kind: 'release',
    weight: 3,
    enabled: true,
    note: '直连原生 RSS。版本资讯的正解在这里，不在 GitHub——Unity 与 UE 都不在 GitHub Releases 发版。',
  },
  {
    id: 'tech-media',
    label: '游戏技术媒体（工具/技术/中文）',
    layer: 'media',
    kind: 'tool-update',
    weight: 2,
    enabled: true,
    note: '直连原生 RSS：GameFromScratch（开发工具新闻）、80.lv（游戏技术）、机核（中文综合）。indienova 与 GameDev.net 无原生 RSS 或被 Cloudflare 拦。',
  },
  {
    id: 'hn-tech',
    label: 'Hacker News 技术讨论',
    layer: 'community',
    kind: 'other',
    params: [
      { key: 'days', label: '时间窗（天）', placeholder: '默认 120，范围 7–180' },
      { key: 'minPoints', label: '最低分数', placeholder: '默认 5，0 表示不限制' },
    ],
    weight: 3,
    enabled: true,
    note: '走 Hacker News 官方搜索 API（hn.algolia.com，免 key），单查询约 0.8s，自带 points 与评论数当热度。不用 hnrss：实测单条 6–20s 且会限流。',
  },
  {
    id: 'github-releases',
    label: 'GitHub Releases（关注仓库的发版）',
    layer: 'github',
    kind: 'release',
    params: [{ key: 'repo', label: '仓库', placeholder: 'owner/repo，逗号分隔多个；留空用默认开源引擎' }],
    weight: 2,
    enabled: true,
    note: '只适合「明确关注的仓库发版」。默认 godot / bevy / cocos / o3de；Unity 与 UE 无 Releases（UnityCsReference 返回 0 条、UnrealEngine 私有 404）。',
  },
  {
    id: 'steam-news',
    label: 'Steam 官方新闻',
    layer: 'official',
    kind: 'release',
    params: [{ key: 'appid', label: 'AppID', placeholder: '留空从订阅词里找数字，再兜底 2358720' }],
    weight: 1,
    enabled: false,
    note: 'api.steampowered.com 直连实测不稳定（2026-10-31 连续超时，curl 亦不通），第一期关闭。RSSHub 的 /steam/news/:appid 走 store.steampowered.com，实测 200 可用，留到接入 RSSHub 时再启用。',
  },
]

export type CollectResult = {
  runs: SourceRun[]
  items: RawNewsItem[]
  /** 去重并配额分配后的条数 */
  total: number
}

/** 单次采集的可选约束：每源条数、内容类型白名单。 */
export type CollectOptions = {
  /** 每个源最多取几条候选；0/缺省 = 沿用 limit。 */
  perSourceLimit?: number
  /** 只要这几类内容（NewsKind）；空数组 = 不限制。 */
  kinds?: string[]
}

/** 并发跑选中的源；单源失败只记 error，不影响其他源。 */
export async function collectFromSources(
  sourceIds: string[],
  limit: number,
  params: Record<string, string>,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const wanted = NEWS_SOURCES.filter((s) => (sourceIds.length === 0 ? s.enabled : sourceIds.includes(s.id)))
  // 每个源先取足够多的候选（limit 的上限 20），选条交给 pickWithQuota 统一分配，
  // 这样「某个源刚好没料」时余量能补给别的源，而不是各源先自行截断再撞车。
  // perSourceLimit 是订阅自己配的（一个订阅想要「每源 3 条引擎官方 + 1 条 HN」这种配比）。
  const askedPerSource = Math.round(Number(options.perSourceLimit ?? 0))
  const perSource = Math.min(20, Math.max(1, askedPerSource > 0 ? askedPerSource : limit))
  const kinds = (options.kinds ?? []).map((k) => String(k).trim()).filter(Boolean)
  const runs = await Promise.all(
    wanted.map(async (src): Promise<SourceRun> => {
      const started = Date.now()
      try {
        let items: RawNewsItem[] = []
        if (src.id === 'engine-official') items = await collectEngineOfficial(limit)
        else if (src.id === 'github-discover') items = await collectGithubDiscovery(perSource, params)
        else if (src.id === 'tech-media') items = await collectTechMedia(limit)
        else if (src.id === 'hn-tech') items = await collectHackerNews(limit, params)
        else if (src.id === 'github-releases') items = await collectGithubReleases(perSource, params)
        else if (src.id === 'steam-news') items = await collectSteamNews(perSource, params)
        else throw new Error(`unknown_source:${src.id}`)
        /* 类型过滤放在配额分配之前：先把不要的类型剔掉，配额才算得准。
           放在最后筛会让「挑中的 6 条里有 4 条被类型过滤掉」变成实际只进 2 条。 */
        if (kinds.length > 0) items = items.filter((item) => kinds.includes(item.kind))
        return { id: src.id, label: src.label, items, ms: Date.now() - started }
      } catch (cause) {
        return { id: src.id, label: src.label, items: [], error: String((cause as Error)?.message ?? cause), ms: Date.now() - started }
      }
    }),
  )
  // 跨源去重
  const seen = new Set<string>()
  const groups: RawNewsItem[][] = runs.map((run) => {
    const kept: RawNewsItem[] = []
    for (const item of run.items) {
      const key = item.url.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      kept.push(item)
    }
    return kept
  })
  // 按源配额挑选：不这样做，发布时间老的源（GitHub Releases）会被永远饿死；
  // 用权重而不是等分，是因为各源技术密度差得很远（见 SourceDescriptor.weight）。
  const weighted = groups.map((items, i) => ({ items, weight: wanted[i]?.weight ?? 1 }))
  const picked = pickWithWeightedQuota(weighted, limit)
  // 配额挑完、再统一按时间排：权重决定「谁进得来」，时间决定「谁显示在前面」
  picked.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
  return { runs, items: picked, total: picked.length }
}
