# M1 缺口盘点与最小交付顺序

最新续批：输入绑定首批已落地待独立复核；当前哈希与测试以 README 顶部索引为准。线性模板的冻结读取已实现，多输入及人工绑定专项反例未收口，Stage3未通过。

历史续批：采用完整性及 REC-10–15、重跑前置 H9–H12、人工确认回滚清理 H13 已获 happy-4.1 独立局部签收。当前恢复15/15、151断言；历史专项13/13。内核 `b821ed78154c7a1fa7a1976ebadeefaed083aec4c965190a36e742de84d6c287`，历史专项 `450dcb16976001382f988b223a40afcc46991c63552ac7bc2b2d9883c0bc1ff8`，取代下文历史哈希与计数。H13 移除清理、改错 Attempt ID、空操作三种变异均命中 manifest 断言，恢复校验通过。失败路径保留内容寻址对象；离线 GC 尚未实现。W1-04 输入快照绑定、历史回切、运行级分支、比较和页面接线仍未完成，Stage 3 未通过。详细命令见 README 顶部最新索引。

当前补记（2026-11-14）：类型持久化修复经 happy-4.1 独立复核正确，REC-09 已补入证据索引；随后采用完整性补丁新增 REC-10/11，身份不匹配或同长度对象篡改在 adopt 提交前拒绝，数据库指纹不变，待独立复核。当前恢复专项 12/12、134 断言（含 REC-12 共用对象清理保护），内核 sha256 `a3d30c1f2144ad7475244aa17b1ee911de115e730a4cf6274b12c2c8a053143b`。完整命令与哈希见 [当前证据索引](README.md)。下文 B4/B5 的旧哈希、8/112 计数及“内核未改”均为历史时点，不代表当前版本。产物类型白名单仍待 W1-10 收口；Stage 3 未通过。

盘点时间：2026-11-14；基线提交 `9d7cac8`，工作区含未提交的 M1 内核与脚本。
盘点口径：[执行计划](../../../execution-plan-2026-11-11.md) §5 的 M1 三批次与阶段门、[11-roadmap-backlog.md](../../../workflow-plan/11-roadmap-backlog.md) 的 W1-01–10 / E02 / K1-01–04、[10-testing-release-governance.md](../../../workflow-plan/10-testing-release-governance.md) 的 A01–A10 / A13 / A34–A37 / A40、[17-context-knowledge-development.md](../../../workflow-plan/17-context-knowledge-development.md) 的 CTX-01–06/08。
本文件只做盘点与排序，不含新实现。是否签收 M1 由老大判定；M2 自动写回在 M0-B 前置门未验证前保持关闭。

历史盘点（以下 API 清单不是当前接口；2026-11-14 已删除 reconcileOutbox，现使用带实际观测的 reconcilePublishEffect，旧未决行继续隔离）：当时已交付的只有**隔离实验内核**：`src/workflow/m1-kernel.mjs`（547 行，导出 `createRun`/`claim`/`storeCandidate`/`adopt`/`saveDraft`/`confirmHuman`/`markUnknown`/`markFailed`/`reconcileUnknown`/`resume`/`cancelRun`/`completeOutbox`/`retryOutbox`/`reconcileOutbox`/`settleRun`，见 `src/workflow/m1-kernel.mjs:535-540`），未接入 `src/host`、`src/shared`、`src/client` 任何主运行时路径；`src/host/workflow/`、`src/shared/workflow/`、`src/client/workflow/` 三个建议目录均不存在。

图例：✅ 已由可复跑脚本验证；◐ 有实现但缺任务原文要求的某个维度；✗ 缺失。

## 当前复核补记（2026-11-14，老大主操作）

本补记纠正下方早期盘点的陈旧描述；历史记录保留，任务状态以 `docs/workflow-plan/11-roadmap-backlog.md` 为准，不把本文件作为第二份台账。

- W1-02：B3 已实现 `pruneRequests`，REC-07 覆盖保留窗口内回放与过期清理；不能再写“清理未实现”。真实宿主保留期策略仍未验证。
- W1-03/W1-05：B3 已实现 `readSnapshot`、`verifySnapshot`、`exportSnapshot` 和只读 `scanRecoverable`，REC-01–08 已局部签收；“快照读取/导出完全没有”和“无独立扫描入口”已过期。后台扫描循环、心跳续期与跨进程证据仍未覆盖。
- W1-09：B5 E2E-03 已覆盖原文确认生成独立 human 快照；E2E-02 覆盖关库重开后的待办和草稿恢复。浏览器刷新/关页证据仍未覆盖。
- B2、B3、B4、B4-2、B4-3、B5 已获此前独立局部签收，均不等于 Stage 3 或 M1 总体验收。B5 的 N6/N7 变异只有实现侧报告，因临时脚本已删除，未获独立复演。
- M1 A13 按执行计划第5节及治理文档第5节验收假宿主子集；真实宿主窗口不是该子集的通过条件。不得把全部 A04/A06/A09 缺口笼统移到 M0-B，须逐条区分 M1 持久化故障反例与真实宿主运行边界。
- W1-01 的目录是建议落点；未搬到 `src/shared/workflow/` 不等于实体/schema 完全不存在。是否满足契约需核查实际覆盖，不以搬目录代替实现。

Stage 3 仍未通过，M2 自动写回保持关闭。接下来按当前源码建立剩余能力清单，独立复核由 happy-4.1 承担。

## 1. 历史任务盘点（W1 / E02 / K1；陈旧项以上方补记为准）

| 任务 | 状态 | 已有证据 | 缺什么 |
| --- | --- | --- | --- |
| W1-01 共享实体、状态机、错误码、schema | ◐ | 运行/步骤状态枚举在 `src/workflow/m1-kernel.mjs:8-9`；错误码走 `fail()`；10 张 `workflow_*` 表在建库 SQL 内；A10 输入 schema 方言 `workflow-input/1` 已由 B4-2 落地 | 实体与 schema 未落到 `src/shared/workflow/`；错误码未集中导出成契约表 |
| W1-02 表、事务、幂等、CAS、追加事件 | ◐ | `transaction` 嵌套计数 + `BEGIN IMMEDIATE`（`:91`）、`cas` 检查 `changes===1`（`:97`）、`request` 同键同 hash 回放（`:107`）、事件追加 | 幂等请求保留期清理未实现；`seq` 用同事务 `MAX(seq)+1`，无跨进程并发证据 |
| W1-03 blob / manifest、草稿 revision、快照读取 / 导出 | ◐ | `storeCandidate` 原子落盘 + 磁盘 manifest 比对（C9，`:283`）；`saveDraft` 事务 + CAS（C10，`:363`） | **快照读取 / 导出 API 完全没有**：内核返回值里没有 `readSnapshot`/`exportSnapshot`（`:535-540`） |
| W1-04 系统 / 人工采用、显式人工节点输出、失效传播、历史分支、基础比较 | ◐ | `adopt` 系统采用、`confirmHuman` 人工采用（`:373`）、`markDownstreamStale`（`:158`，C6/C13）、父快照链（C1/C2） | 历史分支（`workflow_adoptions` 有行但无按节点列历史/回切 API）；基础比较（快照 diff）缺失 |
| W1-05 线性调度、Attempt token、超时、暂停、取消、恢复扫描 | ◐ | `claim` 只取链条上第一个未完成步骤（B2 修正越步领取，实现侧 108 项含四条断言）、token 校验、租约超时（C4）、暂停/取消/继续（C19–C22，`:452`/`:476`） | 恢复扫描只有 `claim` 内被动 `reapExpiredLeases`（`:132`），无独立扫描入口；无租约心跳续期；无取消后 in-flight 后台观察 |
| W1-06 假执行器 | ✅ | `scripts/fake-workflow-executor.mjs` 覆盖 success / failure / delayed / duplicate / unknown，失败走 `markFailed` | 无（长任务 jobRef 属 W1-10，见下） |
| W1-07 最小内测页面 | ◐ | 宿主薄挂载（B4 子批，12 项 134 条 PM-01–PM-12）+ 默认关闭只读客户端（B4-3，12 项 310 条 RC-01–RC-12，老大局部签收）：步骤状态、历史、错误可见且零写入口 | 人工节点 Markdown 草稿编辑、确认继续 / 暂停、普通节点自动前进的**页面**路径未做（需可信身份门）；真实浏览器渲染未验 |
| W1-08 A01–A10 / A34–A37 / A40 假服务路径 + 恢复 / 备份 | ◐ | 内核级断言（见第 2、3 节）+ B5 端到端假服务闭环第二轮（`scripts/verify-workflow-m1-endtoend.mjs`，8 项 132 条，执行器输出由读回输入派生，覆盖 A01/A34/A35/A37）+ B1 假服务 24 项 457 条 + B3 恢复备份 8 项 112 条 + B4 宿主隔离 12 项 134 条 | A01/A34/A35/A37 的**页面**路径（草稿编辑、确认、暂停、继续）受可信身份门阻塞；A06/A09 的跨进程崩溃与断电属 M0-B；真实 HTTP 与工具注册仍缺 |
| W1-09 HumanTask 持久化、输入 / revision 冲突、原文直接确认、刷新与暂停恢复、等待不占槽 | ◐ | 待办建表持久化、`expectedTaskRevision`/`inputFingerprint` CAS（`:373`）、等待不占槽（C21） | 「原文直接确认」没有专门断言（确认未改内容时是否建人工节点自己的快照身份）；「刷新后恢复同一待办与草稿」属页面路径，未验 |
| W1-10 共用业务工具服务、类型化产物契约、长任务协议（假 HTTP / tool） | ✅ | `src/workflow/m1-fake-service.mjs` + `scripts/verify-workflow-m1-service.mjs`：G-01–G-10 工具面、权限矩阵 5×9、冻结错误码、jobRef 绑定与取消确认、受理不明对账（S1–S24，24 项 457 条断言），老大已局部签收 | 真实端口 / 真实 HTTP、DSH 工具注册、跨进程与跨重启的 jobRef 查询仍属 M0-B |
| E02 版本化执行配置、权限交集、上下文 manifest、requested / effective 对照 | ◐ | B2 产出 `ContextManifest` / `ContextDeliveryReceipt` 与内容指纹（`policyVersion`/`assemblyVersion`/预算纳入指纹，排除执行关联）；权限交集在 B1 权限矩阵内 | 版本化执行配置与「请求配置 vs 实际生效配置」对照未实现（属 E02/W2 与 Q11） |
| K1-01 上下文 schema、范围校验、稳定拼装、超限 / 省略与错误策略 | ◐ | `src/workflow/m1-context.mjs` 的 `captureContext` / `assembleContext`：槽位顺序、可信授权目录归属绑定、必需阻止、按交付载荷计费的预算与省略收据、`context_budget_exceeded`（CTX-02 / CTX-02B / CTX-03 / CTX-08B / CTX-08C / SORT-01）；**待老大独立签收** | schema 尚未落到 `src/shared/workflow/`（D3 决定等首个真实依赖批次一起搬）；预算为常量默认值，尚无 W0 实测配置 |
| K1-02 资料不可变捕获、Attempt 输入绑定、指纹与交付记录 | ✅ | 内容寻址 blob + `sourceHash` / `capturedHash` 分离、`contentFingerprint` 排除 runId / attemptId / 时间 / 收据 / 凭证、`receipt`（`verification: captured`）；CTX-01 / CTX-04 / CTX-05 | 交付记录只到「已捕获」，宿主确认与截断探测（CTX-07）属 M2；bundle 未接主运行时 |
| K1-03 假适配器与 CTX-01–06/08 路径 | ✅ | `scripts/verify-workflow-m1-context.mjs`：11 项 106 条断言，CTX-01–06、CTX-08/08B/08C 与 CTX-02B 全覆盖，含冻结后改删源、上游改版旧 Attempt、双窗口与重复领取、跨产品目录在任意 scope 下不可读、私人资料只能来自绑定归属的独立目录 | 假适配器只在进程内，未接 B1 假服务工具面；真实资料清单与真实宿主未验 |
| K1-04 资料预检、来源详情、实际内容与历史只读 | ✗ | 无 | 依赖 W1-07 页面 |

## 2. 验收矩阵（M1 应通过的项）

| 用例 | 状态 | 已有 / 缺失 |
| --- | --- | --- |
| A01 生成 → 手改 → 采用 → 下一步 | ◐ | 内核级：`confirmHuman` 带改后内容采用、父快照指向上一采用快照（C1/C2/C3）；B5 端到端第二轮：下游节点由 `host.runNode` 跑，输入经 `host.inputFor` 真实读盘拿到手改文本、`authorType='human'`，**输出由该输入派生**（E2E-02），并把上游对象同长度篡改 → `parent_content_mismatch` 使输入链断开（E2E-08） | 页面路径（草稿编辑 + 确认按钮）受可信身份门阻塞 |
| A02 仅保存草稿 | ✅ | `saveDraft` 不推进、不使下游过期，陈旧 revision 抛 CAS（C10） |
| A03 上游采用新版本 | ✅ | `markDownstreamStale` + `adoptTx` stale 校验 + 在途 Attempt 置 superseded（C6、C13） |
| A04 双窗口采用 / 重复点击 | ◐ | 单进程 CAS、幂等回放（C3/C10）；B1 假服务侧同 key 同内容回放、同 key 异内容 `idempotency_conflict`（S5）、取消重复受理回放（S9）；缺真实双窗口 / 双连接并发写入证据 |
| A05 生成完成但 manifest 缺文件 | ✅ | `adopt` 比对磁盘 manifest，不符抛 `manifest_mismatch`（C9） |
| A06 文件发布前后 DB / 进程故障 | ◐ | 采用失败整体回滚（C10）、必需发布未完成阻止 run 完成（C14）；缺进程崩溃 / 断电、发布前后 DB 故障后的对账脚本 |
| A07 取消 / 超时后的成功回调 | ✅ | 取消终态拒迟到确认（C12）、stale 下游拒变更前 Attempt（C13）、取消结算 outbox（C17） |
| A08 外部任务结果不明 | ✅ | `outcome_unknown` 必须对账、对账后仍须显式继续（C16、C22） |
| A09 重启恢复 | ◐ | `resume` 语义（C19/C20/C22）；缺「重开库后只接续 / 对账、不重复发起」的脚本，也缺独立恢复扫描 |
| A10 输入 schema 不兼容或越界 | ✅ | B4-2：schema 方言 `workflow-input/1` 在创建运行时严格校验（未知关键字/`required` 非数组/`required` 指向未声明字段/嵌套类型/坏 `pattern`/约束与字段类型不相容/原型链成员冒充字段/显式 `properties:null` 一律拒绝），`claim` 领取前失败关闭且不扣预算、不建 Attempt、不建人工待办（HC-01/02/03/11/12/13/14/15/16）；仍不含真实页面表单的错误回显 |
| A13（W1 假宿主子集） | ◐ | 非 SQLite 句柄抛 `workflow_requires_sqlite`（C11）；缺「初始化失败不影响主面板、不改用 JSON、不破坏旧数据」的宿主集成验证（需 W1-07 挂载点） |
| A34 有 / 无 `human.edit-confirm` | ◐ | 内核两条路径（C21 + `scripts/fixtures/workflow/human-runs.json` 115 断言）；**B5 端到端**：同一份 `four-step-auto` 模板三步全 `system`+`validated` 自动推进至 completed 且无待办（E2E-01），`four-step-with-human` 模板人工节点 `human`+`human.edit-confirm` 且下游**由读回输入派生输出**（E2E-02） | 页面路径与真实节点进程未验 |
| A35 保存、关页、重启或确认原文 | ◐ | 草稿与确认分离（C10）、system/human 来源可分；**B5 端到端**：保存草稿不推进、重启（关库重开 + 新假服务）恢复同一 taskId/revision/draft_id 与草稿内容（E2E-02）；原文直接确认仍生成独立 human 快照、父指针指向上游、内容哈希相同（E2E-03），且该采用会被下游执行器实际读回（E2E-02 第 3 步） | 「关页」是关库重开而非关闭浏览器页面；页面路径仍阻塞 |
| A36 确认并暂停、暂停中确认、双窗口、上游基准变化 | ✅ | B4-2：`confirmHuman(intent:'pause')` 与采用同事务提交并置 `paused/user_paused`、暂停后 `claim` 报 `run_paused` 且发布成功也不改写为完成；双窗口旧修订 `cas_conflict`、幂等重放不重复采用、旧上游基准拒绝且草稿与 `draft_id` 保留（HC-04/05/06/07/08）；并发证据是同库双连接顺序交错，非真实并发压测 |
| A37 硬校验失败停止 | ✅ | 执行器失败 → `markFailed` → `paused` 且拒领取（C20）；**B5 端到端三类停止路径（第二轮：原因写进内核、租约到期也不复活）**：硬校验（节点实际产出超 512 KiB → `schema_invalid:content_too_large`，执行器自己 `markFailed`：运行 `paused` 且原因记录、Attempt `failed` 且 outcome 记录、恰好一条带 reason 的 `attempt.failed`，不扣预算/无采用/无快照/无发布；租约过期后 claim 仍 `run_paused`、不自动重派，显式 resume 才允许重试，E2E-04）、必需检查未评估（必需发布 pending 时不 completed、`step_not_claimable`、失败后 `paused/publish_failed`、resume 被 `publish_conflict`，E2E-05）、输出缺失（上游对象被删 → `artifact_missing:parent_object_missing` 且原因写进内核、Attempt failed、已终结 Attempt 再取输入被拒、**孤儿快照按 `source_attempt_id` 查（先用上游快照做正控证明查询有效）且失败 Attempt 无任何快照行**、同 step 仅 1 个 Attempt、租约过期不复活，E2E-06），另加输入链篡改即失败（同长度改写 → `parent_content_mismatch`，E2E-08）；越权副作用（节点发布/确认被拒且外键不动，E2E-07） | 页面展示与真实执行器进程崩溃/断电属 M0-B |
| A40 长任务短等待、下载失败、提交响应丢失 | ✅ | B1 假服务：稳定 jobRef 复用、下载失败 `retry_download` 不重提交、受理不明先对账（S4/S6/S8，24 项 457 条断言）；真实端口与 DSH 工具注册仍属 M0-B |

## 3. 上下文场景（CTX）

CTX-01–06 与 CTX-08/08B/08C 已由 B2 批次覆盖（[README.md](README.md) 的 B2 段，`node scripts/verify-workflow-m1-context.mjs` → 11 项 106 条断言；B2 本身待独立签收）：同输入同指纹、缺必需/越界/超限阻止、可选省略收据、冻结后改删源仍可读、上游改版与旧 Attempt、双窗口与重复领取、两产品与私人记忆隔离。CTX-07（宿主未确认、载荷不符、截断）与 CTX-09（真实四步）仍属 M2；CTX-10–13 属 M3/M4。

## 4. 最小交付顺序

四批，每批一个新增验证脚本，命令可直接复跑；不改旧工作台入口行为（B4 的挂载方式需老大拍板）。

### B1 假服务与长任务协议（W1-10，A04 / A08 / A40）

- 新增 `src/workflow/m1-fake-service.mjs`：假 HTTP / tool 适配器——`submit`/`poll`/`cancel`，`jobRef` 稳定复用，幂等键去重，受理不明返回 `outcome_unknown`，权限矩阵按 `docs/evidence/workflow/m0/contract-tool-governance.md` 的 G-01–G-10 收窄。
- 新增 `scripts/verify-workflow-m1-service.mjs`。
- 验收命令：`node scripts/verify-workflow-m1-service.mjs`
- 覆盖：A04 重放不双执行、A08 受理不明先对账、A40 同一 jobRef 短等待 / 下载失败 / 提交响应丢失。
- 边界：只碰 `src/workflow/` 与 `scripts/`，不注册真实工具。
- 状态：✅ 已完成并由老大局部签收（S1–S24，24 项 457 条断言，见 [README.md](README.md) 的 B1 段）。仍属 M0-B 的未覆盖部分：真实端口/HTTP、DSH 工具注册、跨进程与跨重启的 jobRef 查询。

### B2 上下文组装（K1-01/02/03，CTX-01–06/08）

- 新增 `src/workflow/m1-context.mjs`：必需 / 可选分离、可信授权目录（路径 + `productId` 归属绑定，按最具体目录判定）、稳定拼装与内容指纹（排除 runId / attemptId / 时间 / 收据 / 凭证）、资料不可变捕获、**按实际交付载荷计费**的预算与省略收据、私人记忆与跨范围资料隔离。
- 新增 `scripts/verify-workflow-m1-context.mjs`。
- 验收命令：`node scripts/verify-workflow-m1-context.mjs`
- 覆盖：CTX-01 同输入同指纹、CTX-02 缺必需 / 越界 / 超限阻止、CTX-03 可选省略有原因、CTX-04 冻结后改删源仍可读、CTX-05 人工改上游后旧 Attempt 迟到、CTX-06 双窗口 / 重复回调 / 恢复重领、CTX-08 两产品 + 私人记忆隔离、CTX-08B 共享未绑定目录不得授权跨产品资料、CTX-08C 归属目录在任何 scope 下都不可跨产品读取、私人资料必须来自绑定归属的独立目录（未绑定根即使开 `allowPrivate` 也报 `private_path_unbound`）、CTX-02B 预算按实际交付载荷计费。
- 边界：纯函数 + 临时目录，不读生产资料。
- 状态：◑ **老大局部签收**（11 项 106 条断言，含老大四轮退回的修复与反例）。顺带修掉内核 `claim` 越步领取的线性调度缺口（实现侧断言 103→108）；宿主确认/截断探测（CTX-07）仍属 M2。退回项：共享未绑定目录曾可授权跨产品资料、预算曾只算片段字节、归属校验曾只覆盖 `scope=product`（`project`/`private` 可绕过）、`allowPrivate` 曾默认放行、未绑定共享根曾能用 `allowPrivate` 一次放行其下所有私人文件，均已修并加回归测试（见 [README.md](README.md) 的 B2 段）。

### B3 恢复、备份与只读导出（W1-03 导出、W1-05 扫描，A06 / A09 / A14 副本路径）

- 改 `src/workflow/m1-kernel.mjs`：加 `readSnapshot(id)`、`exportSnapshot(id, dir, { expectedHash })`、`scanRecoverable({ now })`、幂等请求保留期清理。
- 新增 `scripts/verify-workflow-m1-recovery.mjs`：副本备份还原后 hash 一致、进程中断后 reopen 只接续不重复发起、双连接竞争同一 claim、事件 seq 并发不冲突。
- 验收命令：`node scripts/verify-workflow-m1-recovery.mjs`
- 覆盖：A06 故障对账、A09 重启接续、备份恢复。
- 边界：临时库文件 `mkdtemp`，备份目录同在临时根下。
- 状态：◑ **老大局部签收（第三轮）**（8 项 112 条断言 REC-01–REC-08 全通过）。老大前两轮共退回四项：快照身份未三方对齐（只改数据库行 id 仍 `verified:true`）、扫描六类缺 `outbox_pending`/`step_paused` 正反例、双连接被写成并发压测、行 `artifact_type` 未与 manifest 的 `artifactType` 对齐（只改数据库列仍返回伪造类型与 `verified:true`）；均已定向修复并补反例。实现：`readSnapshot`/`verifySnapshot` 三方对齐（数据库行 + manifest + 对象文件，含 `manifest.snapshotId` 与行 id 及 `${attemptId}:snapshot` 的双向比较、`manifest.artifactType` 与行 `artifact_type` 比较），只读不改；`exportSnapshot` 临时文件 + rename 后回读校验，`expectedHash` 不符不落盘；`scanRecoverable` 纯读巡检六类可恢复条目（`RECOVERY_KINDS`），真正的租约回收仍在 `claim` 内；`pruneRequests` 只删窗口外幂等记录；连接补 `PRAGMA busy_timeout=5000`。变异验证八条（去内容 hash 校验 / 去 expectedHash 比对 / 无条件删请求记录 / 扫描租约条件恒真 / 去两条 `snapshot_identity_mismatch` 判定 / 去 `outbox_pending` 插入 / 去 `step_paused` 插入 / 去 `artifact_type` 比较）均被 REC-01–REC-08 杀死；复原 sha256 `e4a9e3dc74d183f6ea93024e39067de154d6181f0717db2600d919e203a0e36e`。**已知边界**：manifest 只声明 `snapshotId`/`artifactType`/`contentHash`/`bytes`/`relativePath`，`parent_id`、`author_type`、`created_at` 无独立副本可对照，其完整性依赖数据库自身（后续靠事件日志/审计链，不属 B3）。REC-05/06 是同库双连接**顺序交错**调用，已在脚本标题与 README 中明确标注不是并发压测。未做实：后台扫描循环、租约心跳续期、多线程/多进程同时 claim 与 events seq 竞争压测、断电边界（M0-B）。详见 [README.md](README.md) 的 B3 段。

### B4-2 执行前校验与人工确认语义（A10 / A36 内核与假服务子集）

- 状态：◐ **已完成，待独立签收（第五轮：自有键判定 + 显式 properties:null）**。已落地：`src/workflow/m1-kernel.mjs` 增 `INPUT_SCHEMA_DIALECT='workflow-input/1'`、`validateInputSchemaDefinition`（白名单：根 `type/properties/required/additionalProperties`，字段 `type/enum/minLength/maxLength/pattern/minimum/maximum`；未知关键字、`required` 非数组、`required` 指向未声明字段、`array`/`object` 字段类型、坏 `pattern` 一律 `schema_invalid` 并在**创建运行时**拒绝；**类型-约束相容性**：缺 `type` 时任何约束报 `constraint_without_type:<key>`，`minLength`/`maxLength`/`pattern` 只能配 `string`、`minimum`/`maximum` 只能配 `number`/`integer`、`enum` 必须有 `type` 且候选值类型一致，否则 `constraint_type_mismatch:<key>:<type>` 或 `enum_type_mismatch:<类型>`；**字段存在性只认自有键**——`required` 指向 `toString`/`constructor`/`valueOf`/`__proto__` 等原型链成员或声明藏在原型上都按未声明拒（`required_undefined:<名>`），值侧必填同样要求自有键且非 `undefined`；**显式 `properties:null`** 报 `properties_null`，数组/标量仍报 `properties_not_object`，只有完全不写才按空对象处理）、`createRun` 增 `inputSchema` 落库、`claim` 领取前校验（失败关闭，不扣预算/不建 Attempt/不建待办/不做租约回收，只补一条 `input.rejected` 事件）、`adoptTx`/`confirmHuman` 增 `intent:'continue'|'pause'`（pause 走 `pauseRun('user_paused')` 而非 `settleRun`，与采用同事务）、`markDownstreamStale` 搁置被作废步骤的 open 待办、重新领取以 `human.task.reopened` 重开并保留 `draft_id`；`src/workflow/m1-fake-service.mjs` 的 `startRun` 增 `inputSchema` 并在授权前校验、`confirmHumanTask` 增 `intent` 值域与 `actor_id_not_authenticated` 伪造身份拒绝。
- 老大复核退回的 A10 反例：①`validateInputSchema({type:'object', required:'plan'}, {})` 曾返回 `true`（`Array.isArray` 判断把字符串当空数组）；②`{minimum:2}` 下 `rounds:1` 曾返回 `true`（只认自造 `min`/`max`）；③缺 `type` 只写 `minimum` 时 `rounds:'not-a-number'` 曾返回 `true`；④`{type:'string', minimum:2}` 配 `'x'` 曾返回 `true`；⑤`{type:'number', minLength:3}` 配 `0` 曾返回 `true`；⑥`{properties:{}, required:['toString']}` 配 `{}` 曾返回 `true`（`in` 命中原型链）；⑦`{properties:null}` 曾返回 `true`（`?? {}` 当成空对象）。现分别为 `input_schema:required_not_array`、`rounds:below_minimum`、`constraint_without_type:minimum`、`constraint_type_mismatch:minimum:string`、`constraint_type_mismatch:minLength:number`、`required_undefined:toString`、`properties_null`；自造 `min` 被 `unsupported_keyword:min` 拒绝。`scripts/probe-schema-dialect.mjs` 可一键复现（14 条探针）。
- 验收命令：`node scripts/verify-workflow-m1-human-confirm.mjs`（16 项 196 条断言 HC-01–HC-16，18 条变异全部被抓；HC-13 覆盖相容性 8 个反例与相容约束正例，HC-14 验证旧库不相容 schema 领取时失败关闭，HC-15 覆盖原型链与 `properties:null` 共 8 个创建反例，HC-16 验证这两类旧 schema 领取时同样失败关闭且预算/修订不动）+ 既有 M1/独立/服务/上下文/恢复/挂载专项与回归。
- **身份边界（UI 阻塞点）**：宿主 `RouteRequest`（`src/host/index.ts:5947-5956`）无会话/身份字段；DSH `webServer` 是裸 `node:http` 载体、不持认证（认证在 Connection 插件的 `ctx.connection.admit`，而工作台只 `inject: ['webServer','tools']`）。故本批**未新增任何写 HTTP 路由**、不把请求体 `actorId` 当认证，A36 只在假服务层验证；真实界面可用性的前置条件属 M0-B。
- 仍未做：客户端页面（步骤列表、草稿编辑、确认/暂停/继续）、A34–A37 页面路径、真实 `webServer` 前缀路由、跨进程并发（A01 端到端已由 B5 第二轮覆盖：执行器输出由读回输入派生）。

### B4 最小内测页与收口（W1-07/08，A01 / A10 / A13 / A34–A37 界面路径）

- 需先定挂载方式（见第 5 节 D1）。
- 预计改动：`src/host/workflow-page.ts`（薄路由，默认关闭）+ `src/client/workflow/`（步骤列表、草稿编辑、确认 / 暂停 / 继续、历史与错误）+ `src/workflow/m1-kernel.mjs`（`confirmHuman` 加 `intent: 'continue' | 'pause'`，补 A36；输入 schema 校验，补 A10）+ 扩 `scripts/verify-workflow-m1.mjs`。
- 验收命令：`pnpm run bundle && node scripts/verify-workflow-m1.mjs && node scripts/verify-workflow-m1-independent.mjs`
- 覆盖：A01 端到端、A13 宿主子集、A34–A37 的页面路径（A10/A36 的内核与假服务语义已由 B4-2 子批完成，见上一条）。
- 边界：不替换旧设计/笔记入口；开关默认关，旧数据不动。
- 状态：◐ **子批 W1-07/A13 宿主子集已完成，待独立签收（第二轮：补库文件物理隔离）**。已落地 `src/host/workflow-page.ts`（四道闸门：默认关闭只认 `DSH_WORKBENCH_WORKFLOW_PAGE=1/on/true/yes`、非 SQLite 独立禁用、**库文件与旧工作台库物理隔离**、初始化失败只让新路由回 503）+ 宿主入口两处最小接线 + `scripts/verify-workflow-page-mount.mjs`（**12 项 134 条断言 PM-01–PM-12**，测 `lib/index.js` 构建产物）。结果：默认关闭时只注册 `['/workbench-api']`；开启后建独立库 `dsh-workbench-workflow.sqlite` 与 `workflow/` 对象根；初始化失败（库位被目录占住）时新路由 503、同进程旧 `/state` 与旧 `/notebooks` 响应体逐字节相等、旧库 sha256 与大小不变；关→开→关三段旧数据一致。**老大退回的配置冲突**：`DSH_WORKBENCH_WORKFLOW_DB` 指向旧库时内核建表会落进同一个 `legacy.sqlite`，现改为在 `openWorkflowKernel` **之前**调 `checkWorkflowDbIsolation`，按 `same_path`（canonical：realpath 或 realpath(父目录)+文件名，Windows 小写）、`same_file`（`stat` 的 `dev:ino`，抓硬链接）、`foreign_database`（已存在且含非 `workflow_*` 表）三种理由返回 `workflow_db_conflict`；`same_path` 必须在建表前判，一旦 `CREATE TABLE IF NOT EXISTS workflow_*` 跑过就已污染。PM-09 直接复现老大反例（旧库写 `legacy_marker` 后指向旧库）：新路由 503、旧库 `sqlite_master` 仍无 `workflow_*` 表、marker 与 sha256 不变、旧 API 响应体不变；PM-10 覆盖相对段/点段/重复分隔符/大小写/硬链接（符号链接无权限时如实记 `EPERM` 跳过）；PM-11 用 `VACUUM INTO` 复制旧库为改名副本，报 `foreign_database` 且副本与原件都无 `workflow_*` 表；PM-12 是正例（独立库启用与重启复用都不误判）。变异八条（去默认关闭闸门 / 允许非 SQLite / 不隔离初始化异常 / 关闭时仍注册路由 / 去 `same_path` / 去 `same_file` / 去 `foreign_database` / 宿主不传 `legacyDbPath`）均被杀死，复原 sha256 `9441ec0de9f7c5127eec439c75af2236c5515a5cd0595f98cbd5a09fcaec5c59`。构建证据：`lib/index.js` 由 623.49 kB 增至 674.60 kB 并含内核建表 SQL 与库隔离判定，`pnpm run bundle` exit 0。**已知边界**：隔离判定是路径 + 结构判定而非内容哈希，空库/仅含 `workflow_*` 表的旧库副本无法与全新库区分（更强保证属 M0-B）。**未做**：客户端写路径（草稿编辑、确认/暂停/继续，需可信会话身份，见 B4-3 条目）、A01 端到端、A34–A37 页面路径、真实 DSH `webServer` 前缀路由。

### B4-3 默认关闭的只读客户端（W1-07 / A13 客户端子集）

- 状态：◐ **已完成，待独立签收（第二轮：读取失败不再折叠成空数据）**。按老大 m01221 派工，客户端子批先收窄到**只读**：步骤状态、历史与错误展示；草稿提交、确认、暂停、继续一律不接写 HTTP。老大第二轮退回后已定向修复：`/health` 成功而 `/runs` 503、详情非 404 失败、探针后断网都不再冒充空数据，也不再留未处理的异步异常。
- 已落地：`src/client/workflow/readonly-core.mjs`（纯逻辑，无 React/DOM，可被 node 直接验证：`planReadonlyRequests` 只给 3 条 GET；`createReadonlySource({prefix, fetchImpl})` 把请求方法写死在内部并把每次调用记进 `calls`，只暴露 `probe`/`listRuns`/`loadRun`；`loadReadonlyState` 把「探针→列表→详情」组合成**永不 reject** 的入口；`summarizeRuns`/`summarizeRun`/`readonlyView` 负责状态、历史、错误摘要，`exposed!==true` 时 `readonlyView` 返回 `null`，读失败时返回 `status:'error'` + 「读取失败：…」+ `errors[type:'read_failed']`；`describeReadFailure`/`READ_FAILURE_LABELS` 负责把 `http_500`、`unreachable` 等转成人话）；`src/client/workflow/readonly-panel.ts`（React 只读页：步骤/历史/错误三块 + 刷新按钮 + 错误横幅；侧栏入口只在探针通过后才挂，`exposed:false` 时组件 `return null`）；`src/client/index.ts` 在 `apply()` 末尾接 `installWorkflowReadonlyPanel(ctx)`，旧 `key: PANEL_ID`（`workbench`）面板与 `mountSidebarEntry(ctx)` 一行未改。
- 关闭语义：未挂载 404、`disabled_by_config`、`workflow_requires_sqlite`、`workflow_init_failed`/`workflow_db_conflict`、`/health` 不可达、`ok:true` 但 `enabled:false` —— 六种情形一律 `exposed:false`、`registerEntry` 调用 0 次、`readonlyView` 返回 `null`、整轮请求仍全是 GET。
- 读失败语义：列表 503 → `status:'error'`/`reason:workflow_init_failed`/「读取失败：工作流初始化失败」，**不出现**「还没有工作流运行」；无 `reason` 的 5xx → `http_<status>`；断网 → `unreachable`（保留 `ECONNREFUSED` 原文，`listRuns`/`loadRun`/`loadReadonlyState` 均不抛）；详情非 404 失败判 error 且**已读到的运行仍展示**；只有真正的 200 空列表与 `run_not_found` 才给空态。
- 验收命令：`pnpm run bundle && node scripts/verify-workflow-readonly-client.mjs`（**12 项 310 条断言 RC-01–RC-12**；12 条变异 M1–M7 + N1–N5 全部被抓，RC-12 额外监听 `unhandledRejection` 断言 0 条）。相关回归：挂载 12/134、人工确认 16/196、上下文 11/106、恢复 8/112、独立 22/22、内核 108、服务 24/457、fixture 35、runs 115、states 39、tool-policy 70/70，`git diff --check` 干净。
- 证据：`lib/client.js` 939.19 kB → 964.16 kB（只读页组件 + 只读逻辑 + 读故障横幅 + 侧栏入口），`lib/index.js` 684.26 kB 未变（本批未改宿主）；sha256 `readonly-core.mjs`=`f1719d709312cf78eb18c10a9c8585b772f28bfdbbab27ff26ec87c06978dd62`、`readonly-panel.ts`=`262d3975b51c1fb4fa9b016e3e02be79fe62f832c41cf7437c180a839583fa83`、`src/client/index.ts`=`6d6a5a0ee8c3360a0dbb54989dc1b8160aa5e7e8285a614fee5c19e6450294fe`、`scripts/verify-workflow-readonly-client.mjs`=`161f25f3fc3c2a58ce38d29a1d2e79bf9204e5f4287f1f85e4865d4bbfce0a7e`、`lib/client.js`=`bc94ac740589051ce9da364c6c6dfe5a3ede8d0aaa014b1e46ed9a10ad0dfae2`。
- 边界：**「旧页面不变」的证据是无入口 + 组件渲染 `null` + 旧面板注册行未改**，不是截图对比；只读面板仍在 `apply()` 时按 DSH 插槽约定注册（插槽贡献须在 apply 期间给出），但 key 独立为 `workflow-readonly`，旧入口不会选中它。错误横幅的 DOM 呈现只在逻辑层断言过，**真实浏览器渲染未验证**（属 M0-B/后续验收）；本批不接真实 webServer、不发真实 HTTP，RC 用注入的假 `fetchImpl`。
- 仍未做：草稿编辑、确认、暂停、继续的客户端与 HTTP（全部被可信身份门阻塞）、A34–A37 页面路径、真实前缀路由与浏览器验证。

### B5 端到端假服务闭环（W1-08，A01 / A34 / A35 / A37）

- 派工（老大 m01469）：仅用临时 SQLite、脱敏数据和进程内假执行器，串跑有人工节点与无人工节点两份固定模板；验证下游实际消费人工修改后的快照、无人工节点自动推进、原文直接确认及待办与草稿重启恢复，并为 A37 的硬校验失败、必需检查未评估、输出缺失补停止路径反例；分别标明已验证范围，不能用结构断言代替端到端证据。
- 状态：◐ **已完成第二轮（定向补证），待独立签收**。B5 当时内核未改（历史 sha256 `b64fb11e…`）；当前已由类型及采用完整性补丁取代，见顶部索引。第一轮被退回两处口径不符：①测试调了 `inputFor` 但 `submitOutput` 的 content 仍由测试预设（人工下游直接拼 `draftContent`），不能称执行器实际消费；②超限后是测试主动 pause，缺上游对象后运行仍 `running`、Attempt 在途，再 claim 只因在途被拒，没有「记录原因并停止」。
- 第二轮源码改动（`src/workflow/m1-fake-service.mjs`）：`host.inputFor` 只允许 `running` 的 Attempt 取输入（已终结抛 `attempt_invalid:attempt_<status>`），完整性直接复用内核只读 `readSnapshot`（manifest/身份/类型/对象/字节四方对齐），内核错误折算为 `artifact_missing:parent_snapshot_missing|parent_object_missing:<detail>|parent_content_mismatch:<detail>`；新增 `host.runNode(attemptId,{principal,pad,target,required})` 把「读输入 → 由输入算出输出 → 提交 → 宿主执行」串成一次动作，输出由 `renderNodeOutput({nodeId,input})` 生成、**只由读回的上游内容与节点 id 决定**，调用方无法预置 content；新增 `failNodeAttempt(attemptId, reason)`，读输入失败或提交被硬拒时由执行器自己调 `kernel.markFailed` 把原因写回内核（Attempt failed + 步骤/运行 paused + `attempt.failed` 事件），不再由测试 pause 冒充。
- 新增 `scripts/verify-workflow-m1-endtoend.mjs`：**8 项 132 条断言 E2E-01–E2E-08**（第一轮 7 项 95 条，第二轮 129 条，本轮补 E2E-06 孤儿快照断言后 132 条）。E2E-01 无人工模板三步自动推进至 completed（全 `system`+`validated`、无待办、父链 snap2→snap1→snap3、发布目标恰为 md/pd/audit），每步输出均由 `runNode` 从读回输入派生；E2E-02 人工模板等待 + 草稿不推进 + 重启恢复同一 taskId/revision/draft 内容 + 手改后 `human`+`human.edit-confirm` + 下游节点输入是手改文本、输出包含该文本 + 最终产物含手改语句；E2E-03 原文直接确认仍生成独立 human 快照、父指针指向上游、同内容哈希；E2E-04 硬校验失败**记录原因并停止**（超 512 KiB → `schema_invalid:content_too_large`；运行 `paused` 且原因含 content_too_large、Attempt `failed` 且 outcome 含原因、步骤 `paused`、恰好一条带 reason 的 `attempt.failed`；不扣预算/无采用/无快照/无发布；**租约过期后 claim 仍 `run_paused`、Attempt 不复活不重派**，显式 resume 后 Attempt 才变 2）；E2E-05 必需检查未评估（pending 时不 completed、`step_not_claimable`、失败后 `paused/publish_failed`、resume 被 `publish_conflict`）；E2E-06 输出缺失**记录原因并停止**（删上游对象 → `artifact_missing:parent_object_missing`，运行 `paused` 且原因记录、Attempt `failed`、已终结 Attempt 再取输入被 `attempt_invalid:attempt_failed` 拒、**孤儿快照改为按 `source_attempt_id` 查（先拿上游快照做正控证明查询有效），旧写法按 attemptId 查 Snapshot ID 恒为空、已被老大退回**、同 step 仅 1 个 Attempt、租约过期后仍 `run_paused`、`readArtifact` 报 `object_not_on_disk`）；E2E-07 越权副作用（节点发布/确认被拒且发布项与待办不动）；E2E-08 **输入链被同长度篡改即失败**（`artifact_missing:parent_content_mismatch`，运行 `paused`、无第二个采用、`readArtifact` 报 `content_hash_mismatch`）。
- 验收命令：`node scripts/verify-workflow-m1-endtoend.mjs`（8 项 132 条；7 条变异 N1–N7 全部被抓：去 `inputFor` 运行态闸门、输入失败不记录原因、输出失败不记录原因、输出不依赖输入、输入完整性退回只读库指针、失败 Attempt 留孤儿快照 `${attemptId}:snapshot`、失败 Attempt 留主键不同的孤儿快照 `${attemptId}:ghost`——第 7 条在旧断言下会漏掉、现已抓住）。相关回归：内核 108、独立 22/22、服务 24/457、人工确认 16/196、上下文 11/106、恢复 8/112、挂载 12/134、只读 12/310、fixture 35、runs 115、states 39、tool-policy 70/70，`pnpm run bundle` exit 0（`lib/index.js` 684.26 kB / `lib/client.js` 964.16 kB 未变），`git diff --check` 干净。
- sha256：`m1-kernel.mjs`=`b64fb11efed97eedc79e0cdd59607d4542a23941aaa0ab20c9ea54de27130086`（历史版本，当前哈希见顶部）、`m1-fake-service.mjs`=`6f5b8795c2fbf0309e848230680e47baeec99de15c2d3fa787743fa0dd41cd3d`、`scripts/verify-workflow-m1-endtoend.mjs`=`6bd4ca52b0b4c580190e6f4bd41b2b256836ba3fca322841deb941595f62c9f9`。
- 边界：①「下游消费手改快照」现在是执行器输出由读回输入派生、测试不再传内容，但仍不等于真实节点进程、真实模型或真实 HTTP；②「记录原因并停止」是假执行器调 `kernel.markFailed`，覆盖了租约到期后的行为，但不是真实断电或进程崩溃（属 M0-B）；③草稿仍走内核 `saveDraft`，假服务无写入口，UI 写路径继续被可信身份门阻塞；④重启是同进程关库重开 + 新服务实例，非跨进程崩溃或断电；⑤E2E-06/E2E-08 是删文件与同长度篡改，非进程崩溃；⑥越权只覆盖已冻结权限矩阵，Agent 借未开放工具扩权随 M2/A16/A17 验。

## 5. 需要老大拍板的决策点

| 编号 | 问题 | 建议 |
| --- | --- | --- |
| D1 | 最小内测页是独立脚本页，还是经宿主薄挂载？ | **已定**（老大）：默认关闭的宿主薄挂载。`src/host/workflow-page.ts` + 宿主入口两处接线已落地，`src/client/workflow/` 页面属后续子批 |
| D2 | 快照读取 / 导出取什么形状？ | `readSnapshot(id)` 返回只读对象（含 manifest 与 hash），`exportSnapshot(id, dir)` 写目录并校验 hash；不提供就地修改 |
| D3 | 共享实体是否现在迁到 `src/shared/workflow/`？ | 现在不迁，避免双套；B4 收口时一次性搬实体与错误码，测试脚本同步改导入 |
| D4 | events `seq` 跨进程冲突怎么处理？ | 保留 `BEGIN IMMEDIATE` 串行化，加最多 3 次重试并记录重试事件；跨进程压测放进 B3 脚本 |

## 6. 不计入本阶段的部分

- M0-B：真实身份、HTTP / 会话、目标 DSH profile 强限制、实际生效配置、断电边界——未验证前 M2 自动写回关闭。
- W2 及之后：真实模型调用、旧入口冲突（A11）、四步真实产物、CTX-07/09、A39 真实路径。
- 长期记忆实验（ADR-07 暂停）。

估时不在此给出：执行计划要求先由 M0 报告校准人日，本次盘点只定顺序与边界。
