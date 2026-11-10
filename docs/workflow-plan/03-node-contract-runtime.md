# 03 节点契约与运行时

状态：规划草案。依赖：01、02、08。W0 先验证宿主实际能力。

## 1. 首期节点与契约

MVP 支持输入、本地转换 / 检查、DSH 生成、人工任务、受控导出五类执行方式。用户编辑确认使用显式 `human.edit-confirm` 节点：有该节点才等待编辑确认；普通自动节点通过校验后系统采用并自动继续，不在节点内部藏一个额外人审门。

```text
typeId / typeVersion / executorVersion
inputs[]: name, artifactType, schemaVersion, required, multiplicity
outputs[]: name, artifactType, schemaVersion, editable, multiplicity
configSchema / defaults / inputBindings
executor: local | dsh-session | plugin-adapter | human
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
| 已完成且可验证 | 补记快照与系统采用；未暂停则继续，到人工节点才等待 |
| 仍运行、可重新订阅 | 接续观察，不重新发起 |
| 确认未执行 | 可创建新尝试 |
| 无法确定 | outcome_unknown，用户选择对账 / 重新执行 |

fencing token 过期、运行已取消或输入过期的回调只能记事件 / 候选，不更新当前采用和下游状态。

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
