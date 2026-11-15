# 08 存储、迁移与文件

状态：规划草案。依赖：01、02；为 03 提供可靠持久化和恢复协议。

## 1. 数据权威与边界

| 数据 | 权威存储 | 镜像 / 索引 |
| --- | --- | --- |
| 模板、运行、尝试、采用、事件 | 现有 SQLite 中独立 workflow 表 | 可导出清单 |
| 快照内容 | 不可变 blob 内容库及 manifest | SQLite 保存 hash、来源和大小 |
| 草稿 | 宿主管理的工作副本 + revision 元数据 | 编辑器本地恢复缓存仅辅助 |
| 现有 notes / modules / product_maps | 仍由原域维护 | 工作流通过受控发布投影更新 |
| 用户游戏 / 画布 / 小说工程 | 用户工作区文件 | 快照保存冻结副本，不仅保存路径 |

“文件为内容真源”不意味着同时允许 SQLite、原路径和 blob 三方各自修改同一快照。历史内容只从内容库读，工作文件变化通过显式重新导入进入候选。

工作流首期要求可用的 SQLite 事务存储。当前主工作台在没有 `node:sqlite` 时可使用 JsonStore，但新工作流不能据此承诺相同的 CAS / 恢复能力：缺 SQLite 时仅禁用新运行、采用和发布，明确返回 `workflow_requires_sqlite`，保留旧工作台功能，不为首期另造 JSON 工作流引擎。初始化失败须与主面板隔离；已有工作流数据不能在能力恢复前被空 JSON 状态覆盖。

## 2. 建议表与索引

| 表 | 核心字段 / 约束 |
| --- | --- |
| workflow_definitions | id、name、productKind、draftRevision、publishedVersion、archivedAt |
| workflow_versions | workflowId、version、definitionJson、packageLock、hash；唯一版本 |
| workflow_runs | productContext、definitionVersion、status、revision、forkSource、累计 budget、pauseReason、暂停 / 取消意图 |
| workflow_steps | runId、nodeId、state、freshness、currentAdoptionId |
| workflow_attempts | stepId、attemptNo、tokenHash、leaseUntil、sessionId、status、inputManifest |
| workflow_artifacts / snapshots | 逻辑身份、类型、manifest、hash、父版本、作者、尝试来源 |
| workflow_drafts | baseSnapshot、revision、workspaceRef、state |
| workflow_human_tasks | stepId、inputManifest / 指纹、taskRevision、draftRefs、状态、confirmedBy、confirmedAt；按固定输入基准幂等创建 |
| workflow_adoptions / reviews | 输出集合、验证、actorType（system / human）、操作者、前一个采用 ID、理由 |
| workflow_events | runId、seq、eventId、type、payload、time |
| workflow_effects | attemptId、operationKey、target、status、externalReceipt |
| workflow_external_jobs | attemptId、adapter / 实例身份、jobRef、阶段指纹、提交意图、外部 ID、状态与已捕获结果；具体 DDL 在 W0 冻结 |
| workflow_publish_jobs | adoptionId、domainTarget、baseRevision、outboxStatus |
| workflow_requests | scopeId、operation、idempotencyKey、requestHash、operationId、结果引用、保留期；唯一约束按 01 |

所有外键 / 唯一索引和归档策略在 W0 完成 DDL 设计；本表是边界方案，不是可直接执行的 migration。Event payload 有版本和大小限制，不当无限聊天日志。

[13 执行配置](13-execution-profiles.md) 的增量需保存配置版本、请求 / 有效值、加载 manifest 与脱敏收据；[14 聊天协同](14-chat-workflow-studio.md) 的 C0 另行设计产品级 operation / task、候选来源和采用关联。现有工作流表以 run / step 为必需关联，不能简单将这些列置空后声称已支持产品讨论；需确定复用既有任务表或新增关联的适配与迁移。聊天历史仍由 DSH 维护，仅保存 session 引用，不复制完整聊天库；两类新增 schema 随 E/C 单列评审。

## 3. 内容库布局

默认内容库在工作台 dataDir 下的 `workflow/objects/`，与项目可移动工作副本分开；可配置位置但同一次写入 staging 与最终对象必须在同卷。

```text
<dataDir>/workflow/
  objects/<hash-prefix>/<sha256>
  manifests/<snapshotId>.json
  staging/<attemptId>/
  quarantine/
<workspace>/.dsh-workbench/workflows/<runId>/
  work/<attemptId>/
  drafts/<draftId>/
  exports/
```

工作区清单只用于定位和导出，不作为可共享完整备份；绝对路径不能成为跨机器唯一身份。已有外部工程不自动移动。只读工作区需要可配置临时工作根并保留范围约束。

工作区与 dataDir 可在不同卷：先把允许的输出复制到内容库所在卷的 staging 并校验，再在该卷发布对象，不能直接对跨卷工作文件承诺原子 rename。正式对象和 manifest 都须在 DB 引用前完整落盘，写入 / 校验失败不提交 Snapshot；孤立文件仅进入后续有引用检查的回收计划。进程崩溃恢复与断电持久性分开验证，W0 明确 SQLite journal / synchronous、文件落盘和 OS 支持边界。

Draft 也不能先覆盖唯一正文再更新 DB revision。先写按 draftRevision 区分的新内容并落盘，再以事务 CAS 更新指针；失败保留旧可读版本，恢复扫描清理未引用候选。对象、manifest、Draft 及请求去重记录都纳入成组备份与引用完整性核验。

## 4. 文件与 SQLite 的一致性协议

跨文件与数据库不声称单事务原子性，使用阶段发布与对账：

1. 输出写入 staging，校验路径、大小、类型和完整 manifest。
2. hash 后把 blob 发布到内容寻址目录；已有相同 blob 校验后复用。
3. 事务写 Snapshot / Attempt / Event，引用已发布内容；事务失败留下可回收未引用对象。
4. 采用时事务写 Adoption、Step、stale 标记及声明的发布 outbox。人工确认还需 CAS 更新 HumanTask、Draft revision 和继续 / 暂停意图；普通节点系统采用无需创建人审待办。
5. outbox 按目标基准 revision 幂等更新 notes / modules / 工程工作文件；外部冲突时停在 publish-conflict，不覆盖人工变化。
6. 若下一步依赖领域投影，则等待发布成功；若读取快照，可在契约允许时继续，不依赖镜像更新时间猜测完成。

发布任务按 `pending / running / succeeded / conflict / failed / outcome_unknown / superseded / cancelled` 分别记录；`publish-conflict` 是界面原因码，不是 WorkflowRun 新状态。必需目标冲突 / 失败时运行 paused，成功条件遵循 01。正式发布前复核采用是否仍为当前、运行取消意图及目标基准；被替换的旧采用将未执行任务记 superseded，不得继续回写。取消阻止尚未领取的发布；已发起的文件 / 外部操作先对账，不能假设撤销成功。

领域 DB 更新可以事务化，但多个用户文件不具备跨文件原子替换保证。发布记录同时保存原基准和预期结果 hash；崩溃后目标仍为基准才可继续，已是预期结果则补记成功，出现第三种内容即冲突。多个发布目标须显示逐项结果和集合状态：全部必需项完成前不显示“正式发布完成”，不覆盖用户后来修改，也不承诺外部读者看不到短暂中间状态。notes 的 DB 与 Markdown 镜像分别对账；现有 `saveNote` 吞掉镜像失败的行为不能直接作为新 outbox 的成功依据。

旧 UI、工具和 `/sync/push` 都可能写 notes，不能只检查旧流水线按钮。发布冲突以目标真实字段 / 文件 hash 或新建的领域 revision 比较；现有全局 revision 和秒级 updated_at 不足以单独识别所有同秒修改。只抽取试点涉及的保存服务，保留稳定领域 ID，避免复用 `saveNote` 时的隐式 doc_key 推导、正文截断和版本保留策略改变工作流快照。

宿主启动扫描 staging、未引用对象、未结 Attempt 和 outbox。缺内容的记录标 unavailable 并阻止执行，不能以空内容继续。崩溃恢复只完成已有可验证事务，不自动重复付费 / 发布调用。

待确认 HumanTask 与外部 job 关联一并恢复。确认前崩溃恢复原待办；确认事务已提交但客户端没收到响应时，重试返回同一确认结果，不再次发布或派发下游。外部任务阶段记录与 effect ledger 共用身份和提交意图，不再建设第二套队列。

### M1 发布归属表的升级限制（2026-11-14）

`workflow_publish_owners` 与采用/outbox 在同一事务中写入，领取仅认显式持有者，不按 outbox 的 rowid 或时间推断。当前没有旧记录回填或归属修复入口：升级旧库后缺 owner 的 pending，以及 owner 行被删除的条目，都会以 `outbox_superseded` 拒绝领取；该错误目前也涵盖归属缺失，不能据此断言确有更新采用。

不得按物理顺序自动回填，也不得删除新 outbox 来恢复旧项资格。升级前保留一致备份，在副本核查待发布条目及归属；无法证明归属时保持停止发布。可审计的归属迁移/修复及明确诊断仍为未完成项，本批仅验证失败关闭，不代表旧库发布兼容已完成。

### M1 发布领取代次的升级限制（2026-11-14）

`workflow_outbox.claim_generation` 持久化递增，领取返回 `claimGeneration`，结算与对账必须携带该代次。旧表增加列默认零；零不代表可用的领取身份。旧 running / outcome_unknown 行缺少可证明的代次，既不能正常结算，也不能直接通过对账恢复；不得从数据库替迟到调用补当前代次。现有状态门先行，合法可结算/可对账状态的缺失或不符代次返回 `outbox_claim_mismatch`。

升级前保留一致备份，在副本核查未决发布及真实效果；不能证明身份和效果时保持隔离、停止重发。本批未提供历史代次修复、自动恢复、租约或服务对账入口，不得声称旧库未决发布已兼容。新 pending 条目领取后取得正整数代次；重领递增，旧代回调不得结算新领取。

### M1 显式声明发布未知（2026-11-14，本批新增约束）

假服务 `declarePublishUnknown` 复用 `control.run`，但仅允许已注册的 UI / scheduler；node-agent 即便获授该 run、other-agent、HTTP client 均不能调用。先验身份，再验 outbox 所属运行与产品，最后校验原因和代次。操作者取授权记录的 id，忽略请求 actorId；这是假服务身份边界，不代表真实宿主身份已验收。

内核 `markOutboxUnknown(id, { actorId, reason, claimGeneration })` 仅接受 running 和当前正整数代次；pending 返回 outbox_not_claimed，其他状态返回 cas_conflict。代次错误在服务层固定为 publish_conflict / outbox_claim_mismatch。原因必须非空白且不超过 500 个 UTF-16 单元（JavaScript length），原文保存，不 trim、不截断。状态结算与 outbox.unknown_declared 审计同事务，审计包含 outboxId、actorId、reason、claimGeneration、declaredAt；审计失败必须回滚状态。

声明只表示效果未知，不是成功证据；不调用发布适配器、不重新领取或重发。结果核验与服务对账仍未实现，旧库零代次继续失败关闭；发布整体与 Stage 3 未通过。

### M1 实际效果证据与目标类别（2026-11-14，后续实施契约）

本节细化第 4 节：发布意图在采用事务内持久化 `target_kind`（`raw_text` 或 `domain_revision`）、发布前真实目标的 `base_hash`、目标投影的 `expected_hash` 与 `base_revision`。类别取自构造时注册的可信适配器，不接受发布/对账请求临时选类别；读取基准应在采用前完成，不得在准备发布时重新取当前值冒充原基准。当前批次仅原文假目标，领域投影的完整字段摘要仍须另验。

两类均先比较预期摘要：已是预期则补记成功，不领取、不重发。否则 `raw_text` 以完整原文字节摘要判断是否仍为基准，revision 只记审计；`domain_revision` 则要求基准摘要和领域 revision 同时匹配。缺类别、缺摘要或观测不完整时服务发布拒绝，旧记录不得自动推断类别或回填基准。旧 revision-only 内核夹具不算已迁移服务路径。

对账仍要求授权身份、当前正整数代次与 unknown 状态。明确被新归属/采用取代的旧项，absent/diverged 记 superseded，不回到 pending，不作为当前冲突阻塞；applied 仍记实际成功，原因使用成功语义，原取代原因保留在审计中。缺 owner 是归属未知而非已证明被取代，保持隔离，不自动修复。观测与状态同事务记审计，不承诺跨进程外部写入原子性。

本节是后续实现与测试依据，不代表现有服务采用入口已完成迁移；此前固定要求 hash 与 revision 同时匹配的口径仅适用于 domain_revision。假服务目前没有实际目标写入，误记成功不能表述为已经覆盖用户文件。Stage 3 仍未通过。

### M1 移除无证据发布对账入口（2026-11-14）

删除内核 `reconcileOutbox(id,outcome,claimGeneration)` 定义与导出，不保留别名；后续对账使用 `reconcilePublishEffect` 的实际观测和身份审计。该旧接口此前没有服务/页面业务调用，删除不代表修复了已发生的业务文件覆盖。

本批不新增无证据终结入口。缺类别、基准、归属或有效代次的旧未决记录继续隔离、停止重发，只能保留备份并人工核查；不得把人工核查解释为直接改库清状态。可审计的历史记录迁移/处置尚未实现，旧库兼容未验收。暂停或取消运行也不能证明外部效果未发生；不能仅为运行收尾将未知发布改成成功或已取消。

## 5. 旧流水线迁移

- M01：仅新增表、配置开关与内容库，不改原任务全量快照格式。
- M02：定义旧四步流程模板，首次用户选择新运行才捕获源导图和现有文档。
- M03：AI 先生成 staging 候选；采用后通过发布适配器更新原 notes / modules，保留 doc_key 幂等键和事实约束。
- M04：旧入口保留；同一产品运行期间提供占用提示和写入冲突检查，不能声称旧入口不会修改输入。
- M05：足够验证后将旧按钮转发新工作流；保留版本开关恢复旧入口。

旧对象不会伪造为曾经运行过的节点。已存在文档导入须标 imported，保留原 ID 和捕获时间，不将其当作模型生成证据。

## 6. 备份、导出、删除

使用 SQLite backup API 或停写后的可靠复制，不在线只复制 WAL 主文件。备份清单包含 DB schema、blob/hash、包版本和用户工作文件捕获范围；恢复到副本后先做完整性验证。

成组备份须建立一致性边界：短暂停写 / 领取以取得 DB 与所引用 manifest、blob、Draft revision 的清单，或使用可证明等价的快照流程；复制期间固定这些引用并禁止 GC / 草稿版本清理。备份结束后验证清单中每项内容及 hash，恢复前不启用调度 / 发布。分别在不同时刻复制 DB 和可变草稿不算已验证的成组备份。

模板包与运行包分开：模板包不含用户产物；运行包可含内容和来源，但不包含密钥、环境配置或默认执行脚本。导入拒绝路径穿越、链接逃逸、超限压缩文件和不支持 schema；未知包仅只读。

删除默认归档。对象 GC 先扫描引用、保留期和导出依赖，再生成计划供执行；仍被草稿、运行、采用和发布引用的对象不可回收。用户主动请求彻底删除时另行处理依赖和告警，不静默级联。

## 7. 验收与故障注入

- DB 写失败、blob 写失败、rename 后崩溃、采用后投影失败均可恢复。
- 旧任务 / 产品 / 笔记 / Bug / 测试 / 团队数据不被迁移意外改写。
- 工程外部修改被检测，当前采用快照仍可读。
- 导出包在空环境只读可查看；缺包显示能力缺失。
- 备份恢复后的每个 manifest 均可验证，对账不重新发起模型请求。
- Windows 大小写、UNC、junction、符号链接及跨卷路径都有明确支持 / 拒绝结果。

### M1 开发副本的旧记录隔离边界（实现中，待集中验证）

M1 不从历史 outbox、owner 或当前工作文件推断丢失的运行定义及应发布目标集合。冻结定义缺失或完整性校验失败时，开发页明确显示不可用；已有历史快照仍只能通过其原有完整性校验读口读取，不能据此认定恢复、派生或发布可用。

- 缺少冻结运行定义的副本拒绝开发备份恢复校验（`backup_definition_unavailable`）；保留原库及内容目录，不补造定义、不删除旧记录。
- 缺少步骤目标声明与明确 `publishTargets: []` 不等价。恢复/派生必须具备可验证声明；历史目标集合不能作为补全来源。
- 缺目标 owner、基准内容摘要或有效领取代次的旧发布记录继续隔离。不得通过重试按钮推断归属、提高代次或补写成功；重排队也不等于获得发布资格，领取和效果对账仍各自校验。
- 本阶段没有自动迁移或人工修复旧定义的入口。后续迁移须另给版本化来源、校验规则及副本验证证据；不得直接修改生产库来消除诊断。

开发备份由已关闭会话生成，调用者仍须保证没有其他进程写入。恢复先复制到新临时目录并校验，显式打开恢复会话也不自动领取或继续运行；真正执行仍须走授权操作。此边界不代表跨进程停写、断电恢复或旧库升级兼容已经验收。

## 8. 风险与回退

回退 UI 和执行入口可以是代码回退；回退已经发布到用户工程的效果不能仅还原 DB。需要保存发布前基准，用户文件未再变化时才可执行反向恢复，否则导出恢复副本人工处理。新表默认保留只读，回退时不删除内容库；备份未验证前不执行 destructive migration。

未决：移动 / 离线工作区的重绑定方式、共享数据目录的权限和最大文件策略，W0 必须确定首期支持范围。
