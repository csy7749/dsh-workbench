# M0 首批基线记录

日期：2026-11-13。状态：M0-A 结构/契约证据完成；M0-B 真实宿主/运行时证据未完成；整体未通过 M0。本文不是运行时验收报告。

## 已核对

- 工作目录：D:/AI/dsh-workbench；`pwd` 返回 `/d/AI/dsh-workbench`。
- 初始 HEAD：`9d7cac81a823eef22c3e4ffc61c5ec6a75aa0f6b`；`git status --short` 初始为空。
- `node --version`：v24.18.0；package.json：dsh-workbench 1.13.0。
- 构建入口：`pnpm run bundle`；本轮尚未执行。已有 verify 不等于真实宿主验收。
- 当前 HEAD 已有工具策略 v1。历史执行计划的 e13ee3f 保留为历史值，后续以本报告记录的版本重新核查。
- 2026-11-13 修正文档 10、执行计划、17 的阶段门：明确 W1 的 A13 假宿主子集；W2 列出 A11–A15、A39、CTX-07–09 和启用的 E 子集。四步指生成模块设计、提炼模块结构、生成产品设计、一致性报告；冻结输入是前置，人工节点另计。

## 工具策略证据等级

主实施者已直接读取 src/shared/tool-policy.ts 的默认放行未登记工具说明。happy-4.1 独立复核报告指出：默认 full、other 全档放行、HTTP 接口不经工具闸门、design 允许旧直写、session_id 回写前可能按 full 执行。其报告的 verify-tool-policy 70/70 属假上下文/纯函数证据；本轮主实施者已独立复跑，不视为真实宿主隔离证明。

待复验：pre-execute / guard 实际机制、身份建立竞态、直接 HTTP 路径与可信人工身份。反例应先在假宿主及临时存储执行，不向真实生产 API 写入、不创建真实定时任务、不启用额外插件。真实模型验证需先明确预算及隔离环境。

当前结论：不能依赖现有工具档位宣称工作流强隔离；不阻止 M1 假执行器路线，不能据此开放 M2 自动发布。

## 资料清单与事实优先级

| 输入 | 用途 | 状态 |
| --- | --- | --- |
| docs/README.md | 资料导航、历史/规划区分 | 已读 |
| docs/execution-plan-2026-11-11.md | 批次顺序、首批边界 | 已读 |
| docs/workflow-plan/11-roadmap-backlog.md | 唯一任务状态台账 | 首批相关章节已读 |
| docs/workflow-plan/12-decisions-risks.md | 决策及待验证边界 | 已读 |
| docs/workflow-plan/01-domain-model.md、02-snapshot-versioning.md、03-node-contract-runtime.md、08-storage-migration.md | 契约/状态/存储 | 待逐项核对，不宣称已冻结 |
| docs/workflow-plan/10-testing-release-governance.md、17-context-knowledge-development.md | 验收与上下文 | 相关章节已读，完整矩阵待映射 |
| scripts/fixtures/workflow/product-design.json | 人工构造双产品/双导图资料 | 仅领域输入夹具，不冒充数据库 seed |

用户当前明确决策优先；设计契约按对应文档职责解释，冲突记录后解决；历史报告不替代当前代码/运行证据。夹具导图是样例业务事实来源，参考文字不能暗改导图。

## 首批可执行检查

`node scripts/verify-workflow-fixture.mjs` 在本机执行通过：35 个断言，SQLite 3.53.1。覆盖全局 ID 唯一、文档归属正确、多产品/多图/多模块与报告独立身份，并使用 `:memory:` SQLite 验证事务回滚、首次 CAS 成功及旧 revision CAS 拒绝。未导入宿主，不访问生产库；仅证明夹具完整性与本机 SQLite 基础能力，不证明实际工作流恢复或生产 schema 已通过。脚本将 SQLite 版本写入 stdout，避免沿用历史版本。

复核修正：夹具为每份文档声明 title/docKey，两产品显式共用 workspace。audit_report 只是领域标签，storageMapping 明确是未实现提案；现有发布器不传显式 docKey，不能直接导入。检查额外模拟旧隐式键推导的碰撞，但尚未调用真实发布器，不宣称已修复发布。保存草稿/冻结输入行为不再列为领域夹具断言，留给内核状态测试。`git diff --check` 通过（仅 LF→CRLF 提示）。A13 保留已有编号，以“W1 假宿主子集”与完整反例描述区分，避免改动现有 A11–A15 范围引用。

## 发布适配静态核对（M0-R2）

happy-4.1 已独立复跑 35 个夹具断言并通过文档复核。主实施者随后直接核对以下源码，结论仍是不能直接复用旧发布链：

- `src/host/index.ts:2768` 的 publishProductNote 未转发 docKey；`:1548` 按 kind/归属推导键，报告可能与产品正文 pd: 或功能正文 fd: 同键。显式身份须由新受控发布服务验证产品/目标归属，不能仅给 Agent 任意键写权限。
- `src/host/index.ts:1557` 先按 id/doc_key 查找，`:1571` 以 id 更新，无 CAS；镜像调用 `:1566` 还传入请求 id 而非解析后的 finalId，会使幂等保存的镜像路径不稳定。
- `src/host/sync.ts:411` notes 分支没有转发 kind/nodeId/moduleId/docKey，旧同步可清空设计身份；修复须保留缺省字段，并区分显式清空和未提供，覆盖旧客户端兼容。
- `src/host/index.ts:5563` 直接写最终文件；`:1567` 吞写失败后 filePath 为空，`:1573` 可能删除旧文件。新发布应分别记录 DB 与镜像结果，不能以 saveNote 返回成功当作必需发布完成。

修复边界：先在临时库刻画真实行为，再冻结 workflow 发布 CAS/outbox 协议。SQLite 闸门用于新工作流服务，不因此全面禁止旧 JSON 手工笔记。revision 字段不是充分条件：旧 UI/同步/tool 的写入也必须纳入目标冲突检测，或在同一事务中按目标完整字段 hash 检查。DB 与文件不能假称单事务；文件失败须保留旧文件并能对账。上述是源码证据和实现约束，尚无实际发布/故障运行证明。M0-P1 探针已交 happy-4.1，唯一修改边界为 scripts/probe-workflow-legacy-publish.mjs。

## 首批故障运行证据

主实施者独立运行 `node scripts/probe-workflow-legacy-publish.mjs`：18/18 缺陷刻画断言成立（不是修复通过）。bundle SHA256 为 `dface5334e33fbfb418c567ffeabef0bec61502be98ffec98250a2432d0c59bb`，临时目录 `C:/Users/gh/AppData/Local/Temp/dsh-legacy-publish-probe-RViyyP`。实际复现产品正文被报告同键覆盖、同步清空设计身份、镜像 EISDIR 失败仍返回 200 并删除旧文件。已在探针进程禁用 fetch 并断言请求尝试为零；无真实 HTTP/模型请求。这只证明该 bundle 的单进程假宿主行为，不证明源码构建一致或真实权限隔离。

`node scripts/probe-workflow-durability.mjs` 使用临时 SQLite（WAL/FULL）与同卷文件，在子进程对象发布前、发布后、DB 提交前、提交后主动退出，再由父进程重开核查。四个切点符合预期：提交前 Snapshot/Adoption/Event/outbox 均无记录；对象发布后崩溃仅留孤立对象；提交后四者完整，outbox 保持 pending 且未自动重发。目录 `C:/Users/gh/AppData/Local/Temp/workflow-durability-76Eg9Q`。这是合成协议实验，不是实际内核、强杀、断电、跨卷或磁盘满验收。首次实验在 Windows 用只读 fd 调 fsync 报 `EPERM: operation not permitted, fsync`；检查临时落盘后改为 wx 可写句柄写入及 fsync，复跑通过。未据此承诺目录项断电持久性。

## W0-01 基线盘点

源码静态盘点确认当前 host 仍是旧域模型：`src/host/index.ts` 初始化 `meta`、`spaces`、`tasks`、`subtasks`、`attachments`、`logs`、`focus_sessions`、`settings`、`news_topics`、`bug_projects`、`bugs`、`modules`、`test_projects`、`test_cases`、`test_plans`、`test_runs`、`products`、`product_demos`、`product_demo_progress`、`notebooks`、`notes`、`news_items`、`tombstones`、`themes`、`ui_designs`、`demos`、`demo_versions`、`demo_files`、`note_versions`、`ui_design_versions`、`product_inputs`、`product_maps`、`product_map_versions`、`product_progress` 等旧业务表；源码未发现 `workflow_*` 内核表。`src/host/index.ts` 仍保留 `JsonStore`，并在数据库初始化失败时切换到 `.json` 存储。该降级属于旧手工域能力基线，不能作为工作流 JSON 内核。

该盘点证明了 W0-01 的“当前结构与缺失项”部分，但尚未完成真实数据库实例的非破坏性计数、构建产物哈希和目标 DSH profile 能力收据；因此 W0-01 仍不勾选完成。生产数据不复制到本报告。

## W0-06 容量与运行约束结论

M0 冻结接口草案与治理边界：单次派发默认 15 分钟，自动执行预算跨 Attempt 累计，人工等待单独计时；租约、心跳、重试间隔、幂等 key 与请求 hash、记录保留期、单文件/总输出上限必须进入运行收据。预算不足暂停，重启或新 Attempt 不得重置；未知受理先对账再决定重提。上述是契约默认值和实现验收口径，不是当前 host 的实测能力。

当前源码仅能看到 Agent 派发 timeout 的旧兜底和现有任务表，未证明 workflow lease/heartbeat/budget/idempotency retention 已落盘，也未完成真实断电持久性测试。因此 W0-06 结论为“契约可继续、运行时能力降级为未验证”；M1 假执行器可按该口径实现，M2 自动写回必须等待真实身份、HTTP 边界和预算/租约收据。

## M0-A / M0-B 收口结论

### M0-A：结构与契约证据（完成）

已完成 W0-02 的脱敏状态协议校验、W0-03 的合成提交切点实验、W0-05 的发布身份反例与契约、W0-06 的容量/运行约束契约、W0-07 的工具治理清单，以及 W0-08 的人工采用协议与双路径结构样例。W0-02 状态校验独立复跑通过 39 项；工具策略纯函数校验独立复跑通过 70/70；当前 bundle 的哈希与已记录版本一致。上述证据分别标注为脱敏结构、合成实验、静态源码或假上下文证据，不替代真实运行时验收。

### M0-B：真实宿主与运行时证据（未完成）

W0-01 仍缺真实实例非破坏性计数和目标 DSH profile 能力收据；从当前源码重建并与既有 bundle 比对也未完成。W0-04 仍缺真实宿主身份、直接 HTTP 绕过和会话恢复证据；现有工具策略存在默认 full、未登记工具归 other、HTTP 不经工具闸门、design 可写任意文件和 session_id 建立前按 full 执行等边界，不能宣称强隔离。W0-06 仍缺租约、心跳、累计预算、幂等保留期落盘验证，以及强杀/断电/跨卷/磁盘满边界。

### 继续 / 降级决定

M0 整体不通过，原因是阶段出口要求 W0-01–08/E01/K0 的真实证据与继续/降级结论。允许受限进入 M1：只使用临时库、脱敏夹具和假执行器实现无模型持久化闭环，并保留所有未知结果与对账边界。M2 自动写回关闭；在真实宿主身份、HTTP 边界、租约/预算收据和人工确认通道建立前，只能输出候选并由人工导入。

本轮仅修改文档并创建脱敏夹具，未读写生产库、未调用真实模型或切换插件。回退仅撤销本轮文档与夹具改动，保留既有文件与数据。

## 契约草案（happy-4.1 补写，待主实施者合并）

M0-P2 判定「缺三份冻结契约与 W0-07 治理清单，不是先改源码」后，主实施者模型连续 524 中断，由 happy-4.1 续写。三份均为**独立文件**，未修改 02/03/04/08/12：

| 文件 | 任务 | 冻结条目 | 验收 |
| --- | --- | --- | --- |
| `contract-publish-identity.md` | W0-05 | P-01..P-13（键命名空间、服务生成键、报告 `audit:` 独占、归属校验、hash/revision 冲突、显式基准、唯一键并发、同步保真、DB/镜像分离、镜像原子替换、删除顺序、引擎边界、跨文件非原子） | V-01..V-07 |
| `contract-tool-governance.md` | W0-07 | G-01..G-10 拟议工具 + 现有 20 工具差集（复用 3 只读、保留 1 只写进度、排除 16）+ 权限矩阵 + jobRef 长任务协议 + 10 个错误码 | T-01..T-06 |
| `contract-human-adoption.md` | W0-08 | H-01..H-14（`human.edit-confirm` 阻塞语义、HumanTask 绑定、草稿与确认分离、确认重校验、采用事务、继续/暂停原子性、system/human 区分、发布绑定与 superseded、恢复与基准失效、驳回取消、重新采用、两路径、集合完整性） | W08-01..W08-06 |

三份均含：现状证据（源码行号或 grep 0 命中）、已复现/待复现反例、M0 内可判验收、继续/降级触发、实现归属表、未验证项。**不改变 M0 结论：M0 仍未通过**，V-02..V-06、C-01..C-05 的实际验证属 M1。

合并时需同步：11 号 W0-05/07/08 证据行；12 号 Q02/Q19/Q20 与 ADR-19/20/24；03 §3.1 工具表（把「拟议」替换为 G-01..G-10）；08 发布一节；04 人工节点一节。`docs/README.md` 的份数已按实际改为 39 份（本目录 3 份新增契约）。

## W08-03 运行样例（happy-4.1 补，含变异测试）

W0-08 原先只有产物样例、没有「有 / 无人工节点」两条运行路径。新增两件，均为新文件、未改既有夹具与源码：

- `scripts/fixtures/workflow/human-runs.json`：同一产品（`fixture-product-alpha`）、同一输入集的两次运行。
  - `fixture-run-human`：4 步，第 2 步 `human.edit-confirm`，HumanTask 绑定 `inputSetId`/`inputFingerprint`/`expectedRunRevision`，`noAutoConfirm=true`、`waitingState=waiting_review`；人工采用发布的是**同一 docKey 的新 revision**（`md:fixture-module-books` expected 1 → result 2），并且 `parentSnapshotId` 指向上游系统采用、`sameContentAsParent=true`（即未改内容也保有独立身份）。
  - `fixture-run-auto`：3 步，无人工节点、无 HumanTask，全部 `actorType=system`，每步声明 `machineCheck`。
- `scripts/verify-workflow-runs.mjs`：115 项结构断言——ID 全局唯一、步骤顺序连续且只消费上游已产出的键、docKey 命名空间限于 md/pd/fd/ui/td/audit、同一 run 内每个键的 revision 链首条必须 `expectedRevision=0` 且后续 `expectedRevision` 必须等于上一条 `resultRevision`、人工采用必须 `expectedRevision>0`（不能换个键绕开冲突）、报告 `audit:` 与正文 `pd:` 分离、两条路径都覆盖完整文档集、恢复语义（无自动确认超时、上游替换须显式 rebase、重启恢复同一待办）。

命令与输出：

```text
node scripts/verify-workflow-runs.mjs
{"checks":115,"runs":[{"id":"fixture-run-human","steps":4,"adoptions":4},{"id":"fixture-run-auto","steps":3,"adoptions":3}],"scope":"run-sample structure and protocol invariants only; not workflow acceptance"}
```

变异测试（临时目录复制脚本与夹具后逐项注入缺陷，base 通过、7 个变异全部退出 1）：

| 变异 | 断言命中 |
| --- | --- |
| baseline | exit 0 |
| `noAutoConfirm=false` | human wait has no auto-confirm |
| 人工采用 `expectedRevision` 回退为 0 | revision gap on md:fixture-module-books: expected 1, got 0 |
| 自动路径插入人工节点 | both a human path and an auto path are sampled |
| 报告改用 `pd:` 键 | revision gap on pd:fixture-product-alpha: expected 1, got 0 |
| 步骤 ID 重复 | duplicate id: fixture-step-human |
| 少一个输入文档 | input doc set covers every fixture document |
| 运行跨到 beta 产品 | cross-product run: fixture-run-auto |

边界：这是样例与结构不变量，不是调度实现，也不证明 H-01..H-14 的运行时行为（等待不占槽、确认事务、重启恢复）已成立；C-01..C-05 的验证仍属 M1（W1-04/A34–A37）。变异脚本是一次性的，未入库。

## W0-02 无模型状态样例

新增 `scripts/fixtures/workflow/state-runs.json` 与 `scripts/verify-workflow-states.mjs`，使用同一脱敏产品覆盖 completed 终态、`waiting_review` 人工待办、`paused/publish_conflict`、`paused/outcome_unknown` 与 CAS 冲突。校验要求：终态不可恢复；人工待办必须 `noAutoConfirm=true` 且可恢复同一任务；未知结果必须先对账再重试；发布冲突必须携带目标与 expected/actual revision 并先 rebase 或对账。`node scripts/verify-workflow-states.mjs` 通过，结果为 39 项结构断言。

边界：状态样例是 W0-02 的脱敏协议证据，不是 workflow 内核或真实恢复验收；当前源码尚无 workflow_* 表，运行时实现归 W1。
