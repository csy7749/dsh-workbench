/**
 * dsh-workbench · 新闻自动定时采集（批次 E，2026-11-01）
 *
 * 为什么不用 cron：宿主端口每次重启都会变，cron 的 http 任务一旦写进端口就死。
 * 所以定时器必须放在宿主进程内，到点直接调采集逻辑 —— 零外部依赖，也不经过 HTTP。
 *
 * 代价说清楚：只有 DSH 开着的时候才跑。关机期间不采，开机后靠「启动补采」补一次。
 *
 * 这个文件里的判断逻辑全部写成**纯函数**，好让 scripts/verify-news-pipeline.mjs
 * 离线断言「到期/未到期/补采/锁冲突/异常不抛出」。定时器本身（setTimeout）放在最后，
 * 依赖注入 runCollect，测试不碰它。
 */

/** 默认间隔 6 小时。GitHub 免 token 是 60 次/小时，6 小时一次离限额很远。 */
export const NEWS_AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 启动后等 60 秒再补采：宿主冷启时前面的迁移/初始化还没稳，立刻抓容易和它抢库。 */
export const NEWS_AUTO_STARTUP_DELAY_MS = 60 * 1000

/**
 * 把库里的时间串解析成毫秒。空串/非法值返回 null。
 * 用 Date.parse 而不是自己拆格式：库里既有 isoDateTime() 的本地时间，
 * 也可能有别的写入路径产生的时间串，能解析就行。
 */
export function parseAutoCollectStamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '') return null
  const at = Date.parse(raw)
  return Number.isFinite(at) ? at : null
}

/**
 * 现在该不该采。
 *
 * 三个分支各有用意：
 *  - 从没采过（null）→ 该采。否则新订阅要等满一个周期才第一次自动抓。
 *  - 时间串坏了（null）→ 该采。宁可多抓一次，也不要因为一条脏数据让订阅永远停更。
 *  - 距离上次不足间隔 → 不采，等下一个周期。
 */
export function shouldCollectNow(lastAt: unknown, now: number, intervalMs: number): boolean {
  if (!Number.isFinite(now)) return false
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false
  const at = parseAutoCollectStamp(lastAt)
  if (at === null) return true
  return now - at >= intervalMs
}

/** enabled 在 SQLite 里是 0/1，在 JSON 降级里是布尔：两种都得认。 */
export function isAutoCollectEnabled(topic: any): boolean {
  const enabled = topic?.enabled
  if (enabled === false) return false
  if (enabled === 0) return false
  if (enabled === '0' || enabled === 'false') return false
  return true
}

/**
 * 挑出这一轮该采的订阅。
 * 只挑 enabled 的；用 lastAutoCollectAt（自动采集专用时间）而不是 lastRunAt ——
 * 用户手动点一次「检索」不应该把自动采集的节奏往后推，否则点得勤就永远等不到自动采集。
 */
export function planAutoCollect(
  topics: any[],
  options: { now: number; intervalMs: number; isLocked?: (id: string) => boolean },
): string[] {
  const locked = options.isLocked ?? (() => false)
  const out: string[] = []
  for (const topic of topics ?? []) {
    const id = String(topic?.id ?? '')
    if (id === '') continue
    if (!isAutoCollectEnabled(topic)) continue
    if (locked(id)) continue
    if (!shouldCollectNow(topic?.lastAutoCollectAt ?? null, options.now, options.intervalMs)) continue
    out.push(id)
  }
  return out
}

/**
 * 防重叠锁：手动「检索」与定时采集共用同一把 —— 同一个订阅同一时刻只允许一个采集在跑。
 * 内存锁够用：宿主是单进程，锁只需要覆盖进程生命周期（重启时内存锁本来就清空了，
 * 而重启后那一次手动采集也随页面断了）。
 *
 * 用 Map 而不是 Set：记住占用时间，将来要排查「卡住不释放」时有据可查。
 */
export function createNewsCollectLock() {
  const held = new Map<string, number>()
  return {
    /** 抢到返回 true，已被占用返回 false（调用方据此跳过并记日志，不要排队）。 */
    tryAcquire(id: string): boolean {
      if (held.has(id)) return false
      held.set(id, Date.now())
      return true
    },
    release(id: string): void {
      held.delete(id)
    },
    isLocked(id: string): boolean {
      return held.has(id)
    },
    size(): number {
      return held.size
    },
  }
}

export type NewsCollectLock = ReturnType<typeof createNewsCollectLock>

/**
 * 跑一次采集，**永不抛出**。
 *
 * 这是「失败不能拖垮宿主」的落点：定时器里的任何异常（网络爆掉、库锁住、解析炸了）
 * 都必须被吃掉，记下来，下一周期照常。抛出去会顺着 setTimeout 变成 unhandledRejection，
 * 宿主层面可能直接报错甚至退出 —— 一个后台采集不该有这种权力。
 */
export async function runCollectSafely<T>(
  task: () => Promise<T>,
): Promise<{ ok: boolean; value: T | null; error: string }> {
  try {
    const value = await task()
    return { ok: true, value: value ?? null, error: '' }
  } catch (cause) {
    return { ok: false, value: null, error: String((cause as Error)?.message ?? cause) }
  }
}

export interface AutoCollectRunResult {
  topicId: string
  ok: boolean
  inserted?: number
  collected?: number
  error?: string
}

export interface AutoCollectCycleResult {
  at: string
  due: string[]
  results: AutoCollectRunResult[]
}

/**
 * 起定时器。返回 stop() 供插件卸载时清理。
 *
 * 时序：启动后等 startupDelay 跑第一轮（补采），之后每 intervalMs 跑一轮。
 * 每轮内部只对「到期且没被锁住」的订阅采集，采完立刻释放锁。
 * 单个订阅失败不影响同轮其它订阅。
 */
export function startNewsAutoCollect(options: {
  store: any
  /** 进程内直接跑采集（不走 HTTP），由 index.ts 注入。 */
  runCollect: (topicId: string) => Promise<AutoCollectRunResult>
  lock: NewsCollectLock
  intervalMs?: number
  startupDelayMs?: number
  onLog?: (message: string) => void
}): { stop: () => void; cycle: () => Promise<AutoCollectCycleResult>; isRunning: () => boolean } {
  const intervalMs = options.intervalMs ?? NEWS_AUTO_INTERVAL_MS
  const startupDelayMs = options.startupDelayMs ?? NEWS_AUTO_STARTUP_DELAY_MS
  const log = options.onLog ?? ((message: string) => console.log(`[dsh-workbench] ${message}`))
  const lock = options.lock
  let timer: any = null
  let stopped = false
  let running = false

  const cycle = async (): Promise<AutoCollectCycleResult> => {
    const at = new Date().toISOString()
    const empty: AutoCollectCycleResult = { at, due: [], results: [] }
    /* 整轮只跑一个：上一轮还没结束就跳过，避免慢采集把定时器堆成雪崩 */
    if (running) return empty
    running = true
    try {
      const topics = options.store.listNews().topics ?? []
      const due = planAutoCollect(topics, { now: Date.now(), intervalMs, isLocked: (id) => lock.isLocked(id) })
      const results: AutoCollectRunResult[] = []
      for (const topicId of due) {
        /* 再抢一次锁：plan 到这里之间可能被手动采集插进来 */
        if (!lock.tryAcquire(topicId)) {
          log(`自动采集跳过 ${topicId}：已有采集在跑`)
          continue
        }
        try {
          const outcome = await runCollectSafely(() => options.runCollect(topicId))
          results.push(outcome.ok
            ? { ...(outcome.value as AutoCollectRunResult) }
            : { topicId, ok: false, error: outcome.error })
          if (!outcome.ok) log(`自动采集失败 ${topicId}：${outcome.error}（下一周期继续）`)
        } finally {
          lock.release(topicId)
        }
      }
      if (due.length > 0) log(`自动采集完成：${results.filter(r => r.ok).length}/${due.length} 个订阅成功`)
      return { at, due, results }
    } catch (cause) {
      /* 连 listNews 都炸了也别抛：定时器必须活着 */
      log(`自动采集整轮异常：${String((cause as Error)?.message ?? cause)}`)
      return empty
    } finally {
      running = false
    }
  }

  const scheduleNext = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void cycle().finally(() => scheduleNext())
    }, intervalMs)
    /* unref：定时器不该把宿主进程钉住不退出 */
    if (typeof timer?.unref === 'function') timer.unref()
  }

  if (startupDelayMs > 0) {
    timer = setTimeout(() => {
      void cycle().finally(() => scheduleNext())
    }, startupDelayMs)
    if (typeof timer?.unref === 'function') timer.unref()
  } else {
    /* 不延迟就是「立刻补一次」：测试与手动触发走这条，语义上不该白等一个周期 */
    void cycle().finally(() => scheduleNext())
  }

  return {
    stop(): void {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
    cycle,
    isRunning: () => running,
  }
}
