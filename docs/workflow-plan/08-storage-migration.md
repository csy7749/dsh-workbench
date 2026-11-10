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

## 2. 建议表与索引

| 表 | 核心字段 / 约束 |
| --- | --- |
| workflow_definitions | id、name、productKind、draftRevision、publishedVersion、archivedAt |
| workflow_versions | workflowId、version、definitionJson、packageLock、hash；唯一版本 |
| workflow_runs | productContext、definitionVersion、status、revision、forkSource、budget |
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

## 4. 文件与 SQLite 的一致性协议

跨文件与数据库不声称单事务原子性，使用阶段发布与对账：

1. 输出写入 staging，校验路径、大小、类型和完整 manifest。
2. hash 后把 blob 发布到内容寻址目录；已有相同 blob 校验后复用。
3. 事务写 Snapshot / Attempt / Event，引用已发布内容；事务失败留下可回收未引用对象。
4. 采用时事务写 Adoption、Step、stale 标记及声明的发布 outbox。人工确认还需 CAS 更新 HumanTask、Draft revision 和继续 / 暂停意图；普通节点系统采用无需创建人审待办。
5. outbox 按目标基准 revision 幂等更新 notes / modules / 工程工作文件；外部冲突时停在 publish-conflict，不覆盖人工变化。
6. 若下一步依赖领域投影，则等待发布成功；若读取快照，可在契约允许时继续，不依赖镜像更新时间猜测完成。

宿主启动扫描 staging、未引用对象、未结 Attempt 和 outbox。缺内容的记录标 unavailable 并阻止执行，不能以空内容继续。崩溃恢复只完成已有可验证事务，不自动重复付费 / 发布调用。

待确认 HumanTask 与外部 job 关联一并恢复。确认前崩溃恢复原待办；确认事务已提交但客户端没收到响应时，重试返回同一确认结果，不再次发布或派发下游。外部任务阶段记录与 effect ledger 共用身份和提交意图，不再建设第二套队列。

## 5. 旧流水线迁移

- M01：仅新增表、配置开关与内容库，不改原任务全量快照格式。
- M02：定义旧四步流程模板，首次用户选择新运行才捕获源导图和现有文档。
- M03：AI 先生成 staging 候选；采用后通过发布适配器更新原 notes / modules，保留 doc_key 幂等键和事实约束。
- M04：旧入口保留；同一产品运行期间提供占用提示和写入冲突检查，不能声称旧入口不会修改输入。
- M05：足够验证后将旧按钮转发新工作流；保留版本开关恢复旧入口。

旧对象不会伪造为曾经运行过的节点。已存在文档导入须标 imported，保留原 ID 和捕获时间，不将其当作模型生成证据。

## 6. 备份、导出、删除

使用 SQLite backup API 或停写后的可靠复制，不在线只复制 WAL 主文件。备份清单包含 DB schema、blob/hash、包版本和用户工作文件捕获范围；恢复到副本后先做完整性验证。

模板包与运行包分开：模板包不含用户产物；运行包可含内容和来源，但不包含密钥、环境配置或默认执行脚本。导入拒绝路径穿越、链接逃逸、超限压缩文件和不支持 schema；未知包仅只读。

删除默认归档。对象 GC 先扫描引用、保留期和导出依赖，再生成计划供执行；仍被草稿、运行、采用和发布引用的对象不可回收。用户主动请求彻底删除时另行处理依赖和告警，不静默级联。

## 7. 验收与故障注入

- DB 写失败、blob 写失败、rename 后崩溃、采用后投影失败均可恢复。
- 旧任务 / 产品 / 笔记 / Bug / 测试 / 团队数据不被迁移意外改写。
- 工程外部修改被检测，当前采用快照仍可读。
- 导出包在空环境只读可查看；缺包显示能力缺失。
- 备份恢复后的每个 manifest 均可验证，对账不重新发起模型请求。
- Windows 大小写、UNC、junction、符号链接及跨卷路径都有明确支持 / 拒绝结果。

## 8. 风险与回退

回退 UI 和执行入口可以是代码回退；回退已经发布到用户工程的效果不能仅还原 DB。需要保存发布前基准，用户文件未再变化时才可执行反向恢复，否则导出恢复副本人工处理。新表默认保留只读，不回退时删除内容库；备份未验证前不执行 destructive migration。

未决：移动 / 离线工作区的重绑定方式、共享数据目录的权限和最大文件策略，W0 必须确定首期支持范围。
