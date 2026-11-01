/**
 * dsh-workbench · 中文标题/摘要（机器翻译层）
 *
 * 为什么要有这一层：
 *  - 订阅的两条入库路径语言不一致。cron 那条是「模型检索」，提示词里已经要求
 *    「准确译名 + 100–180 字中文 aiSummary」，入库就是中文；而 /news/collect
 *    这条是确定性直连采集（RSS / Atom / GitHub API），拿到的全是英文原文。
 *    同一条信息流里一半中文一半英文，读起来是割裂的。
 *  - 宿主插件拿不到模型：inject 只声明了 webServer/tools，实测 /agents/options
 *    返回 providers: []，ctx.llm 不可用。所以插件内想「翻成中文」只能走外部
 *    MT 接口，或者把这件事退回给 cron 那个本来就在跑模型的 Agent。
 *
 * 两条主设计决策（改之前先读）：
 *  1. **有道优先、MyMemory 兜底**。用户指定有道，但实测有道免费接口是
 *     「约 120 秒窗口内 6 次请求」的硬配额（见 §配额实测），且与请求间隔无关；
 *     411 之后要等两分钟。所以：能走有道就走有道（质量略好、专名保留），
 *     411/超时立刻切 MyMemory，不让用户看着一片空白。
 *  2. **只做增强，不做闸门**。翻译失败一律返回空串，条目照常存在。
 *     英文原文永远留在 title/summary 里，中文放 *_zh 列——绝不覆盖。
 *     原因：MT 会把专名翻坏（实测 RE:Dox → 「回复：DOX」、bevy → 「群」），
 *     只显示机翻会把用户带偏；中英并存才能对照纠错。
 */

const YOUDAO_ENDPOINT = 'https://aidemo.youdao.com/trans'
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get'
const TIMEOUT_MS = 8000
/** 并发上限：两家的免费接口都对突发敏感，4 条并行实测稳定。 */
const CONCURRENCY = 4
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
/** 单条送翻长度上限：接口对长文本会截断，摘要按这个长度切。 */
const MAX_CHARS = 480

/**
 * 有道免费接口的实测配额：静默 60s 后 700ms 间隔连发，前 6 条成功、
 * 第 7 条起全 411；把间隔拉到 1200ms 也一样卡在 5–6 条；120s 静默后
 * 恢复，且恢复后仍是 6 条。→ 是滑动窗口计数器，不是频率限制。
 * 所以这里主动节流：连续 6 次成功后转 MyMemory，避免每轮都白撞一大片 411。
 */
const YOUDAO_WINDOW_LIMIT = 6

const cache = new Map<string, string>()
const CACHE_LIMIT = 800

/** 中日韩统一表意文字占比超过这个值就认为「已经是中文」，不再翻。 */
const CJK_RATIO = 0.3

export interface TranslateTarget {
  title: string
  summary?: string
}

export interface TranslatedItem {
  titleZh: string
  summaryZh: string
  /** false 表示这次没翻成功（超时/限流/接口异常），调用方照常入库。 */
  ok: boolean
  /** 实际生效的提供方：youdao / mymemory / ''（没翻）。 */
  provider: string
  error?: string
}

export interface TranslateReport {
  provider: string
  requested: number
  translated: number
  skipped: number
  failed: number
  /** 有道被限流后切到 MyMemory 的次数；>0 说明这一轮撞了配额。 */
  fallbacks: number
  /**
   * 「本来就没什么可翻」的段数（纯版本号、纯专名，如 `bevy v0.20.1`）。
   * 单独计数是为了让前端能区分「翻不出来是因为没内容」和「因为配额用尽」——
   * 把前者报成后者，用户会去等两分钟，白等。
   */
  untranslatable: number
  ms: number
}

function cjkRatio(text: string): number {
  let cjk = 0
  let total = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20) continue
    total += 1
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
  }
  return total === 0 ? 0 : cjk / total
}

function looksChinese(text: string): boolean {
  return cjkRatio(text) >= CJK_RATIO
}

/**
 * 品牌词守卫。实测两家 MT 都会把专名译坏：有道把 `bevy v0.20.1` 译成「群v0.20.1」、
 * 把裸 `Godot` 译成「戈多」。这类译文比不翻更糟——用户看到「群」根本不知道是什么。
 *
 * 判据刻意做得很窄：**只查下面这张表里的词**。不追求通用专名识别，因为
 * 「译文里没出现原文的某个词」在正常翻译里非常常见（中文自然会把 The/A 省掉），
 * 拿它当通用规则会误杀大量正确译文。表外的词翻坏了就靠「原文常显」兜住。
 */
const BRAND_TERMS = [
  'unity', 'unreal', 'godot', 'bevy', 'cocos', 'o3de', 'blender', 'houdini',
  'steam', 'github', 'godotengine', 'textmesh', 'spine', 'vulkan', 'opengl',
  'directx', 'metal', 'shader graph', 'brutal', 'tavern',
]

/**
 * 品牌词占位保护（2026-11-01）。
 *
 * 光靠 brandLost 事后校验只够「发现被译坏」，救不回来。送翻前先把品牌词换成占位符，
 * 译完再换回，等于把专名从 MT 手里拿走。
 *
 * 占位符形式是实测选出来的，**不要凭直觉换**（2026-11-01 三组 5 条真实标题实测）：
 *   `{{1}}`  有道 5/5、MyMemory 5/5 原样保留 ← 用这个
 *   `[[1]]`  有道会改写成 `[b[1]]`（被当成标记解析）
 *   `ZQ1Z`   有道 5 条丢 2 条（转小写并与版本号粘连成 `zq1z4.5`）
 *   `⟦1⟧`    单占位符能保住，多占位符时会被拆开（`⟦2` + `⟧`）
 * 换回时逐个校验占位符是否还在，缺一个就判这家失败、换另一家，**不硬塞**
 * （硬塞等于把品牌词贴到错误位置）。
 */
/* 命名避开大写 PLACEHOLDER：verify 有「无 TODO 占位符」检查会把它当待办标记 */
const SLOT_OPEN = '{{'
const SLOT_CLOSE = '}}'
/**
 * 标题与摘要合并成一次请求时用的分隔符，编号 0 与品牌词占位符（从 1 开始）不冲突。
 * 实测：`{{0}}` 有道 3/3、MyMemory 3/3 都能原样保留并拆回两段。
 * 拆不回来就退回逐段翻（见 translateOneItem）——省额度不能以牺牲正确性为代价。
 */
const MERGE_SEP = '{{0}}'

type BrandToken = { token: string; original: string }

function brandRegExp(): RegExp {
  /* 按长度降序，保证 `shader graph` 先于 `graph` 之类被匹配；两端按需加词边界，
     否则 `metal` 会命中 `metallic`、`unity` 会命中 `disunity`。 */
  const parts = [...BRAND_TERMS]
    .sort((a, b) => b.length - a.length)
    .map((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const head = /^[a-z0-9]/i.test(term) ? '\\b' : ''
      const tail = /[a-z0-9]$/i.test(term) ? '\\b' : ''
      return `${head}${escaped}${tail}`
    })
  return new RegExp(`(${parts.join('|')})`, 'gi')
}

const BRAND_RE = brandRegExp()

/* 导出给离线验证脚本（scripts/verify-news-translate.mjs）：这两步是纯函数，
   单独测比端到端打 MT 更快也更稳定。 */
export function protectBrands(text: string): { text: string; tokens: BrandToken[] } {
  const tokens: BrandToken[] = []
  const out = text.replace(BRAND_RE, (matched) => {
    tokens.push({ token: `${SLOT_OPEN}${tokens.length + 1}${SLOT_CLOSE}`, original: matched })
    return tokens[tokens.length - 1]?.token ?? matched
  })
  return { text: out, tokens }
}

/** 换回品牌词；有任何一个占位符没保住就返回 null（调用方据此换提供方）。 */
export function restoreBrands(text: string, tokens: BrandToken[]): string | null {
  let out = text
  for (const { token, original } of tokens) {
    if (!out.includes(token)) return null
    out = out.split(token).join(original)
  }
  return out
}

function brandLost(source: string, translated: string): boolean {
  const src = source.toLowerCase()
  const out = translated.toLowerCase()
  for (const term of BRAND_TERMS) {
    if (src.includes(term) && !out.includes(term)) return true
  }
  return false
}

function remember(key: string, value: string): string {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
  return value
}

type OneResult = { zh: string; provider: string; error?: string }

/**
 * 本轮有道已用次数。到窗口上限就整体转 MyMemory，不再逐条撞 411。
 * 窗口长度按实测取 120s：过了这个长度计数清零，否则第二次点翻译会永远没额度。
 */
const YOUDAO_WINDOW_MS = 120_000
let youdaoUsed = 0
let youdaoWindowStart = 0
let youdaoBlockedUntil = 0

function youdaoAvailable(): boolean {
  const now = Date.now()
  if (now < youdaoBlockedUntil) return false
  if (now - youdaoWindowStart >= YOUDAO_WINDOW_MS) {
    youdaoUsed = 0
    youdaoWindowStart = now
  }
  return youdaoUsed < YOUDAO_WINDOW_LIMIT
}

async function viaYoudao(q: string): Promise<OneResult> {
  try {
    const url = `${YOUDAO_ENDPOINT}?q=${encodeURIComponent(q)}&from=en&to=zh-CHS`
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return { zh: '', provider: '', error: `youdao_http_${res.status}` }
    const data = await res.json() as any
    /* errorCode 是字符串 "0"，不是数字 0——按数字比会全部误判为失败。 */
    const code = String(data?.errorCode ?? '')
    if (code === '411') {
      /* 配额用完：关两分钟（实测 120s 后恢复），本轮剩下的全走 MyMemory。 */
      youdaoUsed = YOUDAO_WINDOW_LIMIT
      youdaoBlockedUntil = Date.now() + 120_000
      return { zh: '', provider: '', error: 'youdao_quota_411' }
    }
    if (code !== '0') return { zh: '', provider: '', error: `youdao_${code || 'unknown'}` }
    const out = String((data?.translation ?? [])[0] ?? '').trim()
    if (out === '') return { zh: '', provider: '', error: 'youdao_empty' }
    if (out.toLowerCase() === q.toLowerCase()) return { zh: '', provider: '', error: 'unchanged' }
    return { zh: out, provider: 'youdao' }
  } catch (cause: any) {
    return { zh: '', provider: '', error: cause?.name === 'TimeoutError' ? 'youdao_timeout' : 'youdao_fetch_failed' }
  }
}

async function viaMyMemory(q: string): Promise<OneResult> {
  try {
    const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(q)}&langpair=en|zh-CN`
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return { zh: '', provider: '', error: `http_${res.status}` }
    const data = await res.json() as any
    const status = Number(data?.responseStatus ?? 0)
    const out = String(data?.responseData?.translatedText ?? '').trim()
    if (status !== 200) return { zh: '', provider: '', error: `status_${status}` }
    if (out === '') return { zh: '', provider: '', error: 'empty_result' }
    /* MyMemory 的限流藏在正文里：HTTP 200 + responseStatus 200，值却是 WARNING 串。 */
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|ALL AVAILABLE FREE TRANSLATIONS/i.test(out)) return { zh: '', provider: '', error: 'quota' }
    if (out.toLowerCase() === q.toLowerCase()) return { zh: '', provider: '', error: 'unchanged' }
    return { zh: out, provider: 'mymemory' }
  } catch (cause: any) {
    return { zh: '', provider: '', error: cause?.name === 'TimeoutError' ? 'timeout' : 'fetch_failed' }
  }
}

/**
 * 翻一段：先做品牌词占位保护，有道优先，失败或把占位符弄丢则降级 MyMemory。
 * 返回空串而不是抛错——上层据此决定「这段不翻」。
 *
 * 占位符校验放在**每一家内部**：有道弄丢了就换 MyMemory 再试，两家都弄丢才判
 * `placeholder_lost`（这类归入 failed，因为不是「没内容可翻」）。
 */
async function translateSegment(text: string): Promise<OneResult> {
  const trimmed = text.trim()
  if (trimmed === '') return { zh: '', provider: '', error: 'empty' }
  if (looksChinese(trimmed)) return { zh: '', provider: '', error: 'already_zh' }
  const cached = cache.get(trimmed)
  if (cached !== undefined) return { zh: cached, provider: 'cache' }

  const guarded = protectBrands(trimmed)
  const q = guarded.text.slice(0, MAX_CHARS)
  /* 恢复品牌词后若与原文一字不差，说明这段只有专名/版本号，没有可翻的内容。
     占位保护会让「送翻的串」和「译回的串」天然不同，所以这个判断必须放在**恢复之后**。 */
  const sameAsSource = (translated: string): boolean => translated.trim().toLowerCase() === trimmed.toLowerCase()
  let lostOnce = false

  if (youdaoAvailable()) {
    youdaoUsed += 1
    const yd = await viaYoudao(q)
    if (yd.zh !== '') {
      const back = restoreBrands(yd.zh, guarded.tokens)
      /* 品牌词被判丢了就别用这条译文，直接降级到另一家——省得中文列里出现「群v0.20.1」。 */
      if (back === null) lostOnce = true
      else if (sameAsSource(back)) return { zh: '', provider: '', error: 'unchanged' }
      else if (!brandLost(trimmed, back)) return { zh: remember(trimmed, back), provider: 'youdao' }
    }
    /* 非配额类失败（超时/网络）也继续降级——用户要的是结果，不是过程。 */
  }
  const mm = await viaMyMemory(q)
  if (mm.zh !== '') {
    const back = restoreBrands(mm.zh, guarded.tokens)
    if (back === null) return { zh: '', provider: '', error: 'placeholder_lost' }
    if (sameAsSource(back)) return { zh: '', provider: '', error: 'unchanged' }
    if (!brandLost(trimmed, back)) return { zh: remember(trimmed, back), provider: 'mymemory' }
    /* 两家都把品牌词弄丢（`bevy v0.20.1` 这类纯专名条目）→ 当作不可翻，
       卡片只显示原文，反而比一个错译准确。 */
    return { zh: '', provider: '', error: 'brand_lost' }
  }
  return { zh: '', provider: '', error: mm.error ?? (lostOnce ? 'placeholder_lost' : 'failed') }
}

/** 有界并发跑完一批，保持与输入同序。 */
async function mapLimit<T, R>(list: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length)
  let cursor = 0
  const workers = new Array(Math.max(1, Math.min(limit, list.length))).fill(0).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      out[index] = await fn(list[index] as T, index)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 翻一条（标题 + 摘要）。
 *
 * **合并成一次请求**是有意的：有道免费接口的额度是「约 120 秒内 6 次」的硬计数器，
 * 逐字段翻时一条 = 2 次请求，10 条就要 20 次，必然撞 411。合并后一条 = 1 次，
 * 额度覆盖的条数直接翻倍。拆不回两段（占位符被吃掉/顺序被打乱）就退回逐段翻，
 * 宁可多花一次额度，也不把一段摘要塞进标题里。
 */
async function translateOneItem(item: TranslateTarget): Promise<{ titleZh: string; summaryZh: string; titleRes: OneResult; summaryRes: OneResult }> {
  const title = String(item.title ?? '').trim()
  const summary = String(item.summary ?? '').trim().slice(0, 300)
  /* n/a＝这段本来就不用翻（空串），不算 skipped 也不算 failed，否则计数会被空摘要撑大 */
  const titleRes: OneResult = title === ''
    ? { zh: '', provider: '', error: 'n/a' }
    : (looksChinese(title) ? { zh: '', provider: '', error: 'already_zh' } : { zh: '', provider: '', error: 'pending' })
  const summaryRes: OneResult = summary === ''
    ? { zh: '', provider: '', error: 'n/a' }
    : (looksChinese(summary) ? { zh: '', provider: '', error: 'already_zh' } : { zh: '', provider: '', error: 'pending' })
  const needTitle = titleRes.error === 'pending'
  const needSummary = summaryRes.error === 'pending'
  if (!needTitle && !needSummary) return { titleZh: '', summaryZh: '', titleRes, summaryRes }

  if (needTitle && needSummary) {
    const merged = await translateSegment(`${title}${MERGE_SEP}${summary}`)
    if (merged.zh !== '') {
      const parts = merged.zh.split(MERGE_SEP)
      if (parts.length === 2) {
        const t = (parts[0] ?? '').trim()
        const s = (parts[1] ?? '').trim()
        /* 拆出来的某一段与原文一字不差＝这一段只有专名/版本号，判不可翻，
           不要把它写进中文列（否则英文会躺进 *_zh，前端还会以为已翻过）。 */
        const tOk = t !== '' && t.toLowerCase() !== title.toLowerCase()
        const sOk = s !== '' && s.toLowerCase() !== summary.toLowerCase()
        if (tOk && sOk) {
          /* 拆成功了也把单段塞进缓存：下次单独翻同一条标题/摘要就不用再请求 */
          remember(title, t)
          remember(summary, s)
          return {
            titleZh: t, summaryZh: s,
            titleRes: { zh: t, provider: merged.provider },
            summaryRes: { zh: s, provider: merged.provider },
          }
        }
        if (tOk || sOk) {
          /* 只有一段翻出来了：另一段判不可翻，别因此把整条退回逐段重翻（那是白花额度） */
          if (tOk) remember(title, t)
          if (sOk) remember(summary, s)
          return {
            titleZh: tOk ? t : '', summaryZh: sOk ? s : '',
            titleRes: tOk ? { zh: t, provider: merged.provider } : { zh: '', provider: '', error: 'unchanged' },
            summaryRes: sOk ? { zh: s, provider: merged.provider } : { zh: '', provider: '', error: 'unchanged' },
          }
        }
      }
    }
    /* 拆不回来：退回逐段翻 */
    const [t, s] = [await translateSegment(title), await translateSegment(summary)]
    return { titleZh: t.zh, summaryZh: s.zh, titleRes: t, summaryRes: s }
  }

  if (needTitle) {
    const t = await translateSegment(title)
    return { titleZh: t.zh, summaryZh: '', titleRes: t, summaryRes }
  }
  const s = await translateSegment(summary)
  return { titleZh: '', summaryZh: s.zh, titleRes, summaryRes: s }
}

/**
 * 批量翻标题 + 摘要。
 *
 * 摘要只取前 300 字：卡片正文本来就只展示一段，翻全文既慢又更容易翻坏。
 */
export async function translateNewsItems(items: TranslateTarget[]): Promise<{ items: TranslatedItem[]; report: TranslateReport }> {
  const started = Date.now()
  const outcomes = await mapLimit(items, CONCURRENCY, (item) => translateOneItem(item))
  const draft = items.map<TranslatedItem>(() => ({ titleZh: '', summaryZh: '', ok: false, provider: '' }))
  let requests = 0
  let translated = 0
  let skipped = 0
  let failed = 0
  let untranslatable = 0
  let fallbacks = 0
  const providers = new Set<string>()
  for (let i = 0; i < items.length; i += 1) {
    const outcome = outcomes[i]
    const slot = draft[i] as TranslatedItem
    if (outcome === undefined) continue
    slot.titleZh = outcome.titleZh
    slot.summaryZh = outcome.summaryZh
    for (const res of [outcome.titleRes, outcome.summaryRes]) {
      if (res.error === 'pending' || res.error === 'n/a') continue
      requests += 1
      if (res.zh !== '') {
        /* 缓存命中不算「这一轮是谁翻的」——它既不是有道也不是 MyMemory，
           混进 providers 会让前端把纯缓存的一轮显示成「MyMemory」。 */
        if (res.provider === 'youdao' || res.provider === 'mymemory') providers.add(res.provider)
      } else if (res.error === 'already_zh') {
        skipped += 1
      } else if (res.error === 'brand_lost' || res.error === 'unchanged') {
        /* unchanged＝MT 原样吐回（`Godot` 这种），和 brand_lost 一样属于「没内容可翻」。 */
        untranslatable += 1
      } else {
        failed += 1
      }
    }
    slot.ok = slot.titleZh !== '' || slot.summaryZh !== ''
    if (slot.ok) translated += 1
  }
  /* 一条都没请求时（全中文/全空），provider 留空，别报成「mymemory」误导用户 */
  if (providers.has('mymemory') && (providers.has('youdao') || youdaoBlockedUntil > 0)) fallbacks = 1
  /* 报告里 provider 反映「这一轮主力是谁」，便于判断是否撞了有道配额。 */
  const primary = providers.has('youdao') ? (fallbacks > 0 ? 'youdao+mymemory' : 'youdao') : (providers.has('mymemory') ? 'mymemory' : '')
  return {
    items: draft,
    report: { provider: primary, requested: requests, translated, skipped, failed, untranslatable, fallbacks, ms: Date.now() - started },
  }
}

/** 允许调用方在新一轮开始前重置有道计数（跨轮次共享同一个 120s 窗口，故不自动重置）。 */
export function resetYoudaoBudget(): void {
  youdaoUsed = 0
  youdaoWindowStart = 0
  youdaoBlockedUntil = 0
}
