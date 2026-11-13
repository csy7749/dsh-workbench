# 01 领域模型与状态机

状态：规划草案。依赖：无。下游：02、03、04、08、10。

## 1. 范围与术语

定义模板、运行、尝试、产物版本和决策。产品包提示词、可视化布局和执行器内部实现不属于本模块。

| 实体 | 含义 | 修改方式 |
| --- | --- | --- |
| ProductContext | 工作区、创作产品 ID、产品类型与允许路径 | 运行创建时冻结上下文 |
| Workflow | 模板身份、名称、当前发布版本、归档状态 | 乐观锁更新 |
| WorkflowVersion | 节点、边、配置、包版本、审核策略的已发布定义 | 不可变；修改后发布新版本 |
| WorkflowRun | 一次运行及其固定定义、配置、预算和起始输入 | 状态可变，固定字段不变 |
| Step | 一次运行中的逻辑步骤 | 保存当前采用结果和新鲜度 |
| Attempt | 一次节点执行 / 重试 | 重试生成新 attempt，不复活旧记录 |
| Artifact | 产物逻辑身份，如第 3 章或某游戏构建 | 版本内容存 Snapshot |
| Snapshot | 规范化内容、清单、hash 和来源链 | 不可变 |
| Draft | 由某快照派生的工作副本 | 带 revision 更新 |
| HumanTask | 显式人工节点等待的输入集合、草稿与确认身份 | 持久化，等待不占自动执行槽；同一输入基准不重复创建 |
| Adoption | 某步选用某快照及对应输入 / 验证 / 操作者 | 追加记录，区分 system 自动采用与 human 人工确认 |
| Event | 状态转移、决策、恢复与对账记录 | 追加事件，按运行递增 seq |

Artifact 的“当前版本”只是视图指针。已完成运行固定引用具体 snapshotId，不能在读取时跟随当前版本。

扩展边界：[13 执行配置](13-execution-profiles.md) 增加不可变 ExecutionProfileVersion；[14 聊天协同](14-chat-workflow-studio.md) 引入产品级 operation / task 来源。普通讨论无须创建 WorkflowRun。C0 需要明确候选来源、产品级采用与 Step 采用之间的关联适配；两者共享快照不可变、revision 校验和采用追加记录的规则，产品级采用本身不触发工作流调度。未完成适配前不宣称聊天产物已经可正式交接。

## 2. 运行状态

首期状态枚举：`created`、`running`、`waiting_review`、`paused`、`recovering`、`succeeded`、`failed`、`cancelled`。

| 当前 | 动作 / 条件 | 下一状态 |
| --- | --- | --- |
| created | 校验通过并开始 | running |
| running | 到达显式人工节点，已创建待办和输入基准 | waiting_review |
| running / waiting_review | 暂停请求生效 | paused |
| waiting_review | 用户确认且校验通过，仍有下一步 | running |
| paused | 用户继续且阻塞已解除，仍有步骤 | running 或 waiting_review |
| paused | 用户继续，所有必要步骤和必需发布均已完成 | succeeded |
| 任一非终态 | 宿主重启后发现需要外部对账的未结执行 | recovering |
| recovering | 对账可确认结果 | running / waiting_review / paused / failed |
| running / waiting_review | 所有必要步骤均有有效采用记录，必需发布完成且无未结执行 | succeeded |
| running / waiting_review / recovering | 可处理失败、缺能力或结果不明，保留本轮 | paused，记录原因 |
| 任一非终态 | 必要步骤失败且结束本轮 | failed |
| 任一非终态 | 取消完成 | cancelled |

`succeeded / failed / cancelled` 是运行终态。终态后修订、重试或历史续跑创建新运行，记录 `forkedFromRunId` 和起点；原运行不变。运行中某次尝试失败可在停留页面选择新尝试；若用户结束本轮则运行进入 failed。

补充状态口径（2026-11-12）：可重试失败、缺能力、输入失效、必要校验失败、发布冲突或外部结果不明而等待处理时，运行进入 `paused` 并保存结构化 `pauseReason`、关联 Step / Attempt / publishJob 和恢复动作；界面的“受阻”是该状态的显示，不另造未定义的 `blocked` 运行状态。用户继续前须解决阻塞并重新校验。只改暂停标记不能取消已经运行的外部任务，立即停止仍走 03 的中断和对账协议。

`succeeded` 要求所有必需输出被有效采用、所有必需发布目标已完成，且无未结执行 / 必需校验 / 发布冲突。采用成功与领域发布成功分别记录；暂停期间完成最后一个确认也保持 paused，显式继续后才能收敛为 succeeded。被明确声明为可选的发布失败单列展示，不能默认为必需发布成功。

恢复保存重启前的暂停原因和取消意图。原 created 且未发起的运行保留 created，原 waiting_review 恢复同一人工待办；原 paused 不因重启自动继续。需要外部对账时进入 recovering，完成对账后仍遵循原意图；取消中的运行不得因发现产物完成而转为系统采用。运行取消是逻辑终止，仍未停止的外部 job 保留独立状态和对账记录，不据 cancelled 声称外部已停止。

## 3. 节点与尝试状态

Step 保存两个维度，避免“成功但已过期”无法表达：

- 执行 / 审核状态：`pending / ready / executing / waiting_review / accepted / failed / skipped / cancelled`。
- 新鲜度：`current / stale`；含 `staleReason` 和受影响输入。

Attempt 状态：`queued → running → succeeded | failed | timed_out | cancelled`；queued 尚未派发时也可取消。无法确认外部结果时进入 `outcome_unknown`，它是待对账状态，不是可直接重试的失败终态。关闭其写回 token，保留原 Attempt 和外部 job 身份；对账后按已验证结果进入上述终态，记录独立 reconciliation 事件。只有运行、输入和权限仍有效且未取消时，才能通过宿主恢复服务捕获结果并采用；原执行器不能凭失效 token 恢复写入。输入已过期或取消的结果最多留作隔离候选 / 诊断。

Attempt 成功仅表示执行和输出交付契约完成，不代表通过人工审核。普通节点经必要校验后系统采用；只有显式人工节点等待用户。验证器失败仍保存候选和报告，禁止自动采用。

普通自动节点交付并通过冻结的校验策略后，由系统追加 Adoption，Step 为 accepted，自动调度下一步；不能因没有人工节点而将失败或必需的 not_assessed 当成 pass。只有显式人工节点进入 waiting_review：HumanTask 绑定上游已系统采用的输入快照，用户确认后该人工节点产出自己的快照和人工 Adoption。系统采用不等于人工批准。

人工等待时不保持 running 的自动 Attempt 或工作租约；保存草稿不创建执行。用户提交确认时才建立校验 / 捕获 Attempt，冻结待确认 revision；需要烘焙或导出的编辑器使用共用长任务协议。失败返回同一人工待办，成功事务性记录输出、人工采用和确认事件。不得为等待用户模拟模型运行或反复生成上游内容。

不引入 `approved → succeeded` 两个含义相同的审核终态：用户采用记录生效后 Step 为 accepted；WorkflowRun 是否结束由调度器计算。

## 4. 审核与验证

Draft：`editing / submitted / abandoned`。提交不使内容不可更改：确认操作读取明确 draftRevision，生成不可变快照并写采用记录。

HumanTask：`pending / confirmed / superseded / cancelled`。上游基准失效时旧待办 superseded，保留草稿并要求显式处理差异；新待办绑定新的输入集合。确认不要求用户必须改字，允许检查后直接确认原文，仍记录人工确认来源。

ReviewDecision：`accept / request_changes / reject_candidate / waive_check`。验证结果：`pass / fail / not_assessed / not_applicable`。

人工豁免必须记录原因和操作者，不能把 fail 改成 pass；路径越界、类型错误、schema 不支持、密钥泄漏等硬校验不能通过业务豁免跳过。

## 5. 强制不变量

1. 模板、包、执行器、输入、参数和审核策略在一次尝试领取时冻结。
2. 下游正式执行只消费已采用的快照；Adoption 可由系统或人工产生，草稿预览不具备下游推进资格。
3. 同一 Step 可保存多个候选，只能有一个当前采用组合；采用组合可包含多个文档 / 文件快照。
4. 修改上游采用组合时，下游标 stale，历史内容保留。
5. Event 与数据库状态更新同事务提交；文件发布另按 08 的恢复协议处理。
6. 已终止 Attempt 的迟到结果不能变成当前采用结果。
7. 原始产物、人工修订和采用决策保留各自作者与来源。
8. 自动采用只选择运行内版本；正式 notes / modules / 工程回写走已声明的发布动作。需要人工确认的目标绑定人工节点输出，不得在其上游系统采用时提前发布。
9. 等待人工的节点不能被 Agent、超时或重启自动确认；没有人工节点的正常路径不能被隐式追加内容审批。

## 6. 并发与身份

使用不可猜测的稳定 ID；由宿主生成。推荐唯一约束：

```text
workflow version: (workflowId, version)
step:             (runId, nodeId)
attempt:          (stepId, attemptNo)
request:          (scopeId, operation, idempotencyKey)
completion:       (attemptId, completionId)
event:            (runId, seq)
human task:       (stepId, inputFingerprint, taskRevision)
```

变更请求带 revision / expectedAdoptionId；人工确认还核对 expectedRunRevision / taskRevision，防止与暂停、取消或基准替换并发时抢跑。冲突返回 409 和服务端现状，不能丢掉本地草稿。输入 hash 用于内容完整性和缓存候选判断，不作为所有运行的唯一身份。

`scopeId` 在创建运行前使用可信操作者 + 产品范围，创建后可绑定 runId，避免 start 请求因尚无 runId 无法去重。保存规范化请求指纹：相同 key / 相同请求返回同一结果，不同请求复用 key 返回冲突。去重记录至少覆盖在途操作、恢复与允许的客户端重放窗口；保留期由 W0 冻结，不能先删记录再恢复旧 outbox。当前采用指针按 Step revision CAS 更新，追加 Adoption 记录本身不替代唯一性约束。

创建运行的请求始终使用创建前的固定 scope 查重，runId 只追加为结果关联；不能在重放时改用 runId 导致重复创建。请求指纹不包含临时 transport / trace 标识，同一业务操作的 HTTP 和 tool 适配使用一致的规范化字段。

## 7. 任务与验收

- D01：共享类型、错误码与状态转移表；测试每条合法转移及非法跳转。
- D02：验证终态不可重开、重试使用新 attempt、历史续跑使用新 run。
- D03：验证双窗口采用只允许一个 revision 生效，重复请求返回同一结果。
- D04：验证生成完成、验证通过、人工采用三个事件分别存在。
- D05：验证游戏 / 小说产品上下文可用，不依赖 ideaId 或软件模块 ID。
- D06：有 / 无人工节点、原文直接确认、人工待办恢复和 system / human 来源均可区分。

## 8. 风险与回退

状态过多时 UI 使用中文行动状态，内部维度不合并；发现语义不够时先更新本表再迁移。W0 用内存模型与临时数据库验证，不改生产；已发布 schema 变更要求版本迁移，不通过临时加枚举修补历史。

未决项：运行失败后是否保留“原运行内新尝试”的便利入口需在 W0 固定 UI 行为；本计划默认终态运行派生新运行，防止审计含义变化。
