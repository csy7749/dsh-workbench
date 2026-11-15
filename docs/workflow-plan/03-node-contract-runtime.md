# 03 节点契约与运行时

状态：规划草案。依赖：01、02、08。W0 先验证宿主实际能力。

## 1. 首期节点与契约

MVP 支持输入、本地转换 / 检查、DSH 生成、人工任务、受控导出五类执行方式。用户编辑确认使用显式 `human.edit-confirm` 节点：有该节点才等待编辑确认；普通自动节点通过校验后系统采用并自动继续，不在节点内部藏一个额外人审门。

```text
typeId / typeVersion / executorVersion
inputs[]: name, artifactType, schemaVersion, required, multiplicity
outputs[]: name, artifactType, schemaVersion, editable, multiplicity
configSchema / defaults / inputBindings
executor: local | tool-service | dsh-session | plugin-adapter | human
tools / skills / modelPolicy / writeScope
nodeKind: automatic | human
typeId: human.edit-confirm (人工编辑确认节点；其他人工任务按产品包声明)
validationPolicy: requiredChecks[] / allowedNotAssessed[]
adoptionMode: system_after_validation | human_confirmation (由 nodeKind 推导)
publishTargets[]: domainTarget / inputPort / baseRevision (可选，显式声明)
timeout / retryPolicy / resourceClass
effects: workspace_write | billable | network | external_publish
```

所有节点必须声明输出交付位置、硬校验、可编辑方式、失败语义和依赖。MVP 不接受用户上传代码成为节点执行器。

`tool-service` 节点由宿主直接调用已登记业务能力，不必启动模型；冻结 capabilityId / tool schema 指纹、参数映射、输出映射及 effects。需要 Agent 自主选择工具时使用 dsh-session，并冻结允许 tools 集合。工具是可复用能力入口，节点还负责输入绑定、Attempt、输出验证和采用；不能把工具目录中的全部项目自动变成可执行节点。W1 先验证一个假业务能力，领域节点按各自阶段登记。

模型 / 角色 / Skill / MCP 的版本、解析和有效配置证据以 [13 执行配置](13-execution-profiles.md) 为准；原有 tools / skills / modelPolicy 字段需通过适配解析，不以提示词列出名称代替实际注入。完整配置扩展按 E 单列增量。

## 2. 执行协议

以下 1–7 为自动执行路径；人工节点到达时只创建 HumanTask 并等待，用户确认后才进入校验 / 捕获路径，不在等待期间领取工作租约。

1. 校验定义和类型，解析已采用输入，冻结配置 / 版本 / 预算。
2. 使用数据库 CAS 领取 Attempt，生成 fencing token 和租约。
3. 建立隔离 staging 目录，准备只读输入和受限输出路径。
4. 调用执行器，持续写有界事件；长任务续租并保存外部 job / session ID。
5. 执行器提交 manifest，不直接宣布业务成功。
6. 宿主验证输出和 hash，发布不可变快照，记录 Attempt 结果。
7. 普通节点通过冻结的机器检查后系统采用并继续；到达人工节点则创建持久待办并等待确认。发布只按显式目标和既有授权进行，下一步只消费仍有效的采用快照。

模型说“完成”、session 退出成功、文件已存在均不是完整完成契约。缺 manifest / 必要产物时为 partial 信息或 failed，Step 等待修正；不能仅依赖模型主动上报进度。

`human.edit-confirm` 接受一个或一组显式绑定的产物，输出同类型的完整集合。配置声明编辑器、显示说明、必需校验和输出映射；确认服务核对 HumanTask / taskRevision、输入指纹、draftRevision、expectedAdoptionId、expectedRunRevision 和幂等 key。没有修改也允许确认；关闭页面、自动保存、超时和 Agent 回写不能触发确认。人工等待不消耗自动执行时间预算，截止提醒不自动确认；用户已明确配置的截止取消另记事件并保留草稿。W1 固定模板即可包含此节点，W3 再开放增删与调序，不以自由画布为前置。

生成、手工按钮、聊天和节点调用共用业务工具服务；各入口只适配身份、参数、权限和展示，不重新实现处理逻辑。调用时再次检查允许工具与 schema，目录中可见不等于本次可调用。共享服务不负责偷偷推进流程，推进由调度器根据采用与依赖计算。OhMyGame 的来源与适配界限见 [16](16-ohmygame-workflow-adoption.md)。

## 3. DSH 执行器

复用现有会话和派发，增加面向工作流的上下文与交付协议，不复用依赖 ideaId 的灵感提示词。保存 `runId / nodeId / attemptId / sessionId / dispatchId / inputFingerprint`。

工作流回写工具必须验证 Attempt token、输出路径和 schema。现有 `workbench_product_note_publish` 等工具直写 notes / modules，首期不能直接拿来绕开快照审核；W0 选择工作流专用 staging 工具或受控写回拦截，再由发布适配器更新领域视图。

工具策略、团队并发和可中断性必须在目标 DSH profile 验证。旧团队文档中的部分约束仅靠提示词实现，不能当成强隔离。无法强制限制写入的执行器默认只读 / 生成人工可导入候选，直到限制能力被证实。

[14 聊天协同](14-chat-workflow-studio.md) 复用相同执行器、权限、预算、候选和发布服务。工作流任务保留上述 run / node / attempt 关联；产品讨论使用独立 operation / task 和 session，相关工作流字段允许缺省，不为普通聊天伪造 Run。交接时显式绑定产物来源，切换入口不能再次发起已有执行；对应数据映射在 C0 单独验证。

### 3.1 业务接口开放为 DSH tools

补充日期：2026-11-12。将选定的业务接口注册为 DSH tools，让 Agent 能读取状态、交付候选和调用已授权能力。HTTP API、DSH tool 和工作流执行器都调用同一业务服务，复用 schema、权限校验、幂等和事件；前端仍可通过 HTTP 操作，不要求界面经过模型调用工具。DSH tools 注册不自动等于提供独立 MCP 服务，后者按实际客户端需求另定。

首批开放范围如下。**本节的冻结补充已由 M0 evidence/workflow/m0/contract-tool-governance.md 定稿：G-01..G-10 的名称、HTTP 路径、effectClass、幂等、错误码与权限边界以该清单为准；它们仍不是当前可调用接口，W1 假适配、W2 真实注册分别验收。** 领域工具按各产品包阶段加入，不一次包装所有 CRUD。

| 能力 | 冻结 tool / HTTP 操作（尚未注册） | 共用服务职责 | 开放与授权边界 |
| --- | --- | --- | --- |
| 查询运行与节点 | `workbench_workflow_get` / `GET /workflows/runs/:id` | 返回步骤、输入版本、能力和可行动作 | W1 假工具适配验证，W2 DSH 注册；按产品和会话范围只读 |
| 读取产物与执行事件 | `workbench_workflow_artifact_read`、`workbench_workflow_events` / snapshots、events 查询 | 读固定快照，事件按 seq 有界分页 | 仅返回获准内容；明确 cursor、截断和不可用状态，不返回密钥、token 或任意路径文件 |
| 提交输出候选 | `workbench_workflow_output_submit` / `POST /workflows/attempts/:id/outputs` | 校验 Attempt 身份、staging manifest、schema、文件和 hash，再捕获快照 | W2 专用交付工具；只提交候选，不由 Agent 指定 accepted 或修改正式 notes/modules |
| 上报进度 | `workbench_workflow_progress` / `POST /workflows/attempts/:id/progress` | 记录有界进度事件，关联本次 Attempt | 不能用 status=done 代替输出验收，也不能自动确认人工节点 |
| 启动、暂停、继续、取消运行 | `workbench_workflow_start/pause/resume/cancel` / runs 对应命令 | 使用固定模板、预算和输入；检查状态、revision、幂等及实际取消结果 | W0 确定启用子集；只有会话获得控制授权时注册 / 开放，启动和继续需复核副作用与剩余预算；暂停不绕过人工待办 |
| 查询或取消长任务 | `workbench_workflow_job_get/cancel` / jobs 对应查询与命令 | 复用 jobRef、已确认阶段和对账协议 | 只能控制本调用范围内任务；不提供模型随意重置未知结果或强行重提的入口 |
| 领域操作，如构建、素材加工、导出 | 各产品包声明的 tools / 领域 API | 复用同一构建或加工服务，输出进入候选链 | 随 W4/P/S 对应阶段启用；费用、文件写入和发布权限分别检查 |

人工确认与正式发布另有边界：

1. 保存人工 Draft、确认 / 驳回 HumanTask 由用户界面调用受认证的人工命令接口；首期不向 Agent 暴露可代替用户确认的 tool。Agent 修订通过候选提交，不能覆盖人工草稿。
2. 自动节点由调度器在必要校验通过后系统采用；人工节点由确认服务生成 human Adoption。Agent 工具结果不能自行生成“人工已批准”的身份。
3. 正式 notes/modules/工程发布由已声明目标的 outbox 执行；不开放任意 `force_publish` 或通用数据库写入 tool。旧直写工具须从工作流会话的允许集合排除或受控拦截；无法限制时采用只读 / 人工导入降级。
4. tool 参数中的 productId、runId、attemptId 是待校验目标，不是授权凭证。宿主从可信调用上下文绑定身份和范围；Attempt 凭证只面向本次交付，日志、返回值与快照不泄露凭证。

工具契约至少包含：名称 / 版本、输入与输出 schema、effectClass、允许范围、错误码、幂等策略和证据字段。变更工具使用 idempotencyKey，涉及当前状态时加 expectedRevision；统一返回 operationId、状态、产物或 jobRef、下一步和结构化错误。控制请求已受理与执行实际完成分别表达，不能把 HTTP 200 或 tool 调用成功等同于业务通过。

人工命令的可信身份必须由宿主验证。仅不注册确认 tool、隐藏按钮、校验 Origin 或请求体填写 actorType=human 都不足以证明人工来源；能够发 HTTP 的 Agent 仍可能访问本机端点。W0 验证宿主提供的交互凭证 / 授权通道及作用域，并测试 Agent 请求不能使用同一通道确认。目标 profile 无法建立该边界时，不将人工确认标为强隔离，阻止依赖此保证的自动写回试点；不为全部旧接口顺带建设另一套账户系统。

实施映射：W0-05/07 已冻结 API → 业务服务 → tool 对照表及权限矩阵；W1-10 用假工具适配验证契约；W2-02/08 注册真实 DSH 子集并对照 HTTP 行为验收。工作流会话当前允许集合为 G-01..G-09 加 3 个只读工作台工具；现有 20 个工具中另保留 1 个进度写工具，其余 16 个排除。人工确认与正式发布不注册为 Agent tool。C1、W4 和 S 只扩展各自能力，共用桥接层，不新增工具专用队列。M1/M2 不以完整控制工具集和领域扩展全部上线为前置。

## 4. 调度、暂停和取消

- W1 只跑线性依赖，每个运行一个活跃自动节点；不同运行通过全局配额队列调度。
- 暂停默认“当前节点安全收尾后不启动下一步”，不等同于强杀进程。
- 用户要求立即停止时先中断，再对账，显示是否真的停止。
- 等待人工不占自动执行槽；等待时长单独统计。
- 超时与取消关闭 token；外部仍运行时进入 outcome_unknown，待对账，不假定无副作用。

MVP 不声称硬限制团队成员并发就是硬限制模型 API 并发；需由能控制的调度入口计数并显露不可控部分。

## 5. 重启恢复与迟到结果

宿主启动将过期 running Attempt 标记待恢复，检查外部 session / job 和输出 manifest：

| 可观察结果 | 操作 |
| --- | --- |
| 已完成且可验证 | 宿主恢复服务捕获结果；运行未取消、输入仍有效时才允许系统采用，并遵循原暂停意图 |
| 仍运行、可重新订阅 | 接续观察，不重新发起 |
| 确认未执行 | 可创建新尝试 |
| 无法确定 | outcome_unknown，暂停相关运行并续查原任务；不提供默认重新执行 |

fencing token 过期、运行已取消或输入过期的回调只能记事件 / 候选，不更新当前采用和下游状态。

W0 固定租约与心跳默认值、重试次数 / 间隔及超时口径。总自动执行预算跨 Attempt 累计，人工等待单独计时；预算不足暂停，不因重启或更换 Attempt 重置。未知受理只有确认未执行后才能安全重提；无法确认时若用户明确承担重复效果，须记录原 job、重复风险和新 operation 身份，不能伪称幂等重试。

恢复人工节点时读取同一 HumanTask、已保存 Draft 和固定输入；恢复为等待，不重跑上游、不自动确认。暂停状态恢复后仍暂停；暂停中允许保存和确认当前待办，但确认不解除运行暂停，继续需用户显式发起。

## 6. 副作用与费用

数据库无法为外部发布提供 exactly-once。为网络付费、工程写回和发布节点保存 effect ledger：操作 key、目标、请求摘要、开始、外部结果和对账状态。

纯转换允许有上限自动重试；付费生成默认失败后人工重试；发布 / 删除 / 不确定副作用禁止盲目重试。模型费用无法预先精确计算时展示估计和限制，不伪造精确账单。

长任务使用共用 `submit / observe / collect / requestCancel / reconcile` 协议，提交意图先落盘，外部 job ID 到达立即关联。短等待超时返回 jobRef，调用方续查同一任务；已确认的生成阶段和输出下载分别恢复。响应丢失且无法查明是否受理时保持 outcome_unknown，不把重连解释为新生成。具体后端按启用阶段接入，不能直接以 OhMyGame 外部 MCP 的内存 job Map 代替持久库。

参数和命令只能来自受控 schema / 执行器，不把用户节点配置拼成 shell 字符串。密钥由宿主服务读取，不进入输出快照和浏览器配置。

## 7. 实现任务与接口方向

- R01：执行器注册、版本 / 能力清单、类型检查。
- R02：领取、租约、token、超时、事件、重启扫描。
- R03：假执行器，覆盖每种终态和迟到回调。
- R04：DSH 适配和专用交付工具；缺能力显示具体原因。
- R05：effect ledger、配额、费用记录和幂等请求。
- R06：显式人工节点、普通节点系统采用和无人工连续执行；确认期间校验 revision，重启恢复待办。
- R07：共用工具服务和可编辑产物 manifest，长任务适配统一 jobRef、阶段结果和对账接口；沿既有任务实现，不复制队列。

拟议 API 命名集中于 `/workbench-api/workflows`，运行下提供 attempts、events、pause、resume、cancel；详细 schema 在 W0 冻结，当前不是已存在接口。

## 8. 验收、风险与回退

验收必须覆盖重复点击、租约过期、崩溃恢复、上游变更、取消后回调和发布结果不明。隔离不成立即暂停该执行器接入，不通过“请勿修改文件”提示词掩盖。失败时保留假执行器与只读运行记录，旧派发入口继续存在，但旧入口写入须被当作外部变化处理。
