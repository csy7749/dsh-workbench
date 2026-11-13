# 游戏技术雷达 产品审计报告（第 2 版）

> 时效说明（2026-11-11）：本文保留 2026-11-01 的现场结论。当前源码已包含确定性采集入口、七类 kind、source_health、热度 / event_key 及 `scripts/verify-news-pipeline.mjs`，不能直接将下表全部作为未完成任务。应先逐项复核实现与运行效果；URL 归并也不等于语义事件合并。本次整理未复跑业务测试，整体排期见 [执行计划](execution-plan-2026-11-11.md)。

审计日期 2026-11-01，分支 `feat/news-extension`。
方法：读代码（`src/host/index.ts`、`src/host/news-sources.ts`、`src/client/app.ts`）、查运行库 `dsh-workbench.sqlite` 的真实数据、对照群公告里的产品口径。

第 2 版相对第 1 版的变化（用户拍板）：
- 去掉「待学队列」，形态保持信息流，不再做 inbox/learning/done/dropped。
- 去掉多端布局审计，只在 DSH 面板里用。
- `GITHUB_TOKEN` 由用户自己配置，不进待办。
- 旧订阅「AI 行业动态」「黑神话：悟空」及其 2 个 cron 任务已暂停（已完成）。
- 新增「翻译质量」一项。

权重 = 对「雷达能不能成立」的影响占比，12 项合计 100。

## 结论

采集器和翻译的底层做得扎实，但采集器没有入口，是目前最大的缺口。其次是内容类型 kind 与产品口径不一致，以及没有相关性过滤。

## 问题清单（按权重降序）

| # | 权重 | 级别 | 问题 | 证据 |
|---|---|---|---|---|
| 1 | 26 | P0 | 确定性采集器没有任何入口。UI「检索」按钮和定时任务走的是 cron Agent（模型搜索），`/news/collect` 只是 HTTP 端点，没有按钮，也没有调度。`news-sources.ts` 整套直连采集在产品里不会自己运行。 | `src/client/app.ts:2479-2495` runNewsTopic 只调 `cronFetch(.../run)`；全仓库 grep `news/collect` 只命中 `src/host/index.ts:6981`。库里 10 条是手动调 API 灌入的。「游戏技术雷达」订阅的 `cron_task_ids` 是空数组。 |
| 2 | 14 | P0 | kind 口径分裂。产品口径是 release/oss-launch/tutorial/deep-dive/paper/tool-update/other，代码里是 12 个旧值（update/dlc/peripheral/data/review…）。`update` 一个桶同时装官方发版、UE 案例营销、bevy 补丁版本。 | `src/host/index.ts:4864` NEWS_KINDS；`src/host/news-sources.ts:19-34` NewsKind。 |
| 3 | 12 | P1 | 没有相关性闸门。权重只管跨源抢配额，不管内容是否算技术。 | 库里 10 条中约 3 条偏离：80.lv「Retro Fantasy Indie RPG」被标成 tutorial（实为游戏推荐）、机核「核周报」、Rivian 万圣节模式（UE 营销案例）。 |
| 4 | 10 | P1 | 翻译质量与稳定性。有道 120 秒窗口只给 6 次，超出就降级 MyMemory；引擎名会被译坏（bevy→群、Godot→戈多），词守卫只能判"不可用"，不能救回译文。见下方「翻译方案」。 | `src/host/translate.ts`；实测见下。 |
| 5 | 9 | P1 | 订阅模型没升级。`news_topics` 只有 query/count，没有 sources/kinds/per_source_limit/source_health，单源失败用户看不到。 | `src/host/index.ts:882-887`。 |
| 6 | 7 | P1 | 核心代码未提交。`news-sources.ts`、`translate.ts` 是 untracked，`index.ts`/`app.ts`/`styles.ts` 有未提交修改；`lib/*.js` 构建产物被跟踪；根目录有散落物（`.tmp-rsshub-test/`、`.tmp-test-sources.ts`、`newdir_x/`、`pnpm-lock.yaml`、`.tmp-db-backup-*.sqlite`）。 | `git status --short`。 |
| 7 | 6 | P1 | 常青清单偏离口径。`NEWS_EVERGREEN_KINDS` 含 update/dlc/announcement，不止 oss/tool/tutorial/paper，官方发版公告的时效闸门放宽到 180 天。 | `src/host/index.ts:4871` 与 `:4912`。 |
| 8 | 5 | P2 | 没有跨源事件合并。hash 只是 URL，同一个「Godot 4.8 beta 2」在官方博客、HN、GitHub 上各占一条。 | `src/host/index.ts:4923`；唯一键 `UNIQUE(topic_id, hash)`。 |
| 9 | 4 | P2 | 热度信号没落库。HN 的 points、GitHub 的 starVelocity 采集时算了，入库时丢了，信息流只能按时间排。 | `news_items` 无 heat 列。 |
| 10 | 3 | P2 | 没有单条删除和清空订阅条目的 API 与入口。 | 只有 `DELETE /news/topics`。 |
| 11 | 3 | P2 | 没有自动化验证。`scripts/` 下 30 多个 verify 脚本，0 个覆盖新闻采集、清洗闸门、翻译守卫。 | `ls scripts`。 |
| 12 | 1 | P3 | GitHub 项目标题是「仓库名 · 描述」被硬截断，卡片上出现「…with an RL」。 | 库里 AutoTavern / BRUTAL 两条。 |

已完成：旧订阅停用（原第 6 项）。

## 翻译方案（第 4 项）

2026-11-01 实测：

| 通道 | 结果 |
|---|---|
| Bing Edge 免费令牌（`edge.microsoft.com/translate/auth`） | 返回空令牌，后续 401，不可用 |
| Google `translate.googleapis.com` 直连 | 6 秒超时，不可用 |
| Google 经本机代理 `127.0.0.1:7897` | 可用，每条 3–5 秒；译文通顺，语序正确（"Linux 现已支持 VLC for Unity"），但 bevy→「贝维」仍被译坏 |

建议按收益排序：

1. **品牌词占位保护**（推荐先做，成本最低）。送翻前把 Godot、bevy、Unity 等换成不会被翻译的占位符（如 `⟦1⟧`），译完再换回。三家 MT 都因此受益，直接解决「戈多」「群」「贝维」。比现在"译坏再判不可用"更根本。
2. **Google 经代理作为第三档提供方**。有道 → Google(代理) → MyMemory。代理地址做成可配置，没配置就跳过。局限：依赖用户本机代理。
3. **多条合并成一次请求**。用换行拼接多条标题一次发，减少有道的窗口消耗（6 次窗口能多翻几倍条目）。
4. **LLM 翻译**（质量最好，能带术语表）。宿主插件拿不到模型，只能经客户端会话或 cron Agent 触发，有 token 成本和延迟。适合作为"精翻"按钮，不适合默认路径。

## 建议的执行批次

| 批次 | 内容 | 对应项 |
|---|---|---|
| A 接通与止血 | 「检索」按钮改为先调 `/news/collect` 再写入；提交代码、清理散落物；校正常青清单 | 1, 6, 7 |
| B 口径统一 | kind 迁到新 7 类（含旧数据映射）；相关性闸门；topic 增加 sources/kinds/source_health | 2, 3, 5 |
| C 翻译与排序 | 品牌词占位保护；合并请求；可选 Google 代理档；落库 heat；事件合并 | 4, 9, 8 |
| D 收尾 | 单条删除 / 清空；verify 脚本；标题截断 | 10, 11, 12 |

## 未审计项

- 翻译按钮在配额用尽时的提示文案，本轮没有复测。
