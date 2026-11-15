# W0-07 冻结提案：业务服务 → DSH tool 清单、schema 与权限矩阵

状态：**M0 冻结提案，未合并进 03/08/11/12，M0 仍未通过。** 日期：2026-11-13。
提出：happy-4.1。合并责任：主实施者写入 03 §3.1（对照表落定）、11（W0-07 证据）、12（Q02/Q19/Q20 结论）。
依据：11 号 W0-07「按 03 第 3.1 节冻结 API → 业务服务 → DSH tool 清单、schema 与权限矩阵；**先核对现有能力**，不复制 Agent runtime / 队列」。

## 1. 先核对现有能力：20 个已注册工具

实测（`lib/index.js` 假宿主 `tools.register` 捕获，HEAD 9d7cac8）：工作台注册 20 个工具，全部经 `registerGuardedTool` 包装——`src/host/index.ts:6074-6562`（11 处调用覆盖 14 个工具）、`src/host/agent.ts:589-639`（4 个）、`src/host/idea.ts:488-563`（2 个）。能力归属取自 `src/shared/tool-policy.ts:60-81` 的 `WORKBENCH_TOOLS`。

| 工具 | capability | 写入目标 | 工作流会话内处置 |
| --- | --- | --- | --- |
| `workbench_map_node_publish` | publish.product | product_maps/节点 | **排除**（直写导图，绕过 staging） |
| `workbench_module_publish` | publish.product | modules | **排除**（W0-05 明令禁止提前改 modules） |
| `workbench_product_note_publish` | publish.product | notes（隐式 docKey） | **排除**（发布身份缺陷，见 P-01..P-04） |
| `workbench_ui_doc_publish` | publish.design | ui_designs | 排除（试点不含 UI） |
| `workbench_demo_publish` | publish.design | product_demos + 磁盘 HTML | 排除（文件落盘） |
| `workbench_theme_publish` | publish.design | themes | 排除 |
| `workbench_testcase_publish` | publish.test | test_cases | 排除（试点不含测试包） |
| `workbench_test_doc_publish` | publish.test | notes(`td:`) | 排除 |
| `workbench_test_result_publish` | publish.test | test_runs / bugs | 排除 |
| `workbench_idea_expand` | publish.idea | 灵感图 | 排除（产品派发曾回落此工具） |
| `workbench_idea_progress` | publish.idea | 灵感进度 | 排除 |
| `product_progress_publish` | publish.idea | 产品流水线进度 | **保留只写进度**（不作为完成凭证） |
| `workbench_bug_publish` | publish.ops | bugs | 排除 |
| `workbench_bug_update` | publish.ops | bugs | 排除 |
| `workbench_news_publish` | publish.ops | news_topics/items | 排除 |
| `workbench_note_update` | write.local | notes（按 id 覆盖） | **排除**（保留 existing 全字段但无 CAS，可绕过发布） |
| `workbench_knowledge_search` | read | — | 复用（只读） |
| `workbench_memory_search` | read | — | 复用（只读，K1 用） |
| `workbench_memory_write` | write.local | 记忆 | 排除（长期记忆实验暂停） |
| `workbench_team_list` | read | — | 复用（只读） |

结论：**现有 20 个工具里没有一个是"提交候选 + 宿主采用 + 受控发布"的语义**；能复用的是 3 个只读工具，另保留 1 个只写进度工具，其余 16 个在工作流会话内必须排除或降级为只读。

## 2. 工具策略 v1 的边界（作为权限矩阵前提，不是实现保障）

来自 happy-4.1 独立复核（已记入 M0 README）：

- 默认 `featureProfiles` 空 + `defaultProfile='full'` → 未配置即不隔离。
- `resolveTool` 对 `capability==='other'` 且 `strict!==true` 一律放行 → MCP 与未登记 DSH 工具在收窄档仍可用（`src/shared/tool-policy.ts:296-298`）。
- 闸门只挂 `tools/pre-execute`，不拦 `/workbench-api/*` HTTP（`src/host/tool-policy.ts:175-206`）。
- `design` 档含 `write.local`，`write/edit` 可写任意文件。
- `session_id` 由前端建会话后回写，回写前按 `full` 放行（缓存 5s，`src/host/tool-policy.ts:23`、`:277-292`）。

因此权限矩阵只能写成**目标约束**，不能引用 v1 宣称已达成。

## 3. 冻结：拟议工作流工具（G-01..G-10）

`effectClass` 枚举复用 `TOOL_CAPABILITIES`（read / write.local / publish.product / publish.design / publish.test / publish.idea / publish.ops / exec / network / delegate / other），不新增第二套分类。

| 编号 | 工具名（冻结） | HTTP | effectClass | 幂等 | 允许范围 |
| --- | --- | --- | --- | --- | --- |
| G-01 | `workbench_workflow_get` | `GET /workflows/runs/:id` | read | 天然 | 仅本产品、本会话可见 run |
| G-02 | `workbench_workflow_artifact_read` | `GET /workflows/runs/:id/artifacts` | read | 天然 | 固定快照；不返回任意路径文件 |
| G-03 | `workbench_workflow_events` | `GET /workflows/runs/:id/events` | read | 天然 | seq 有界分页，cursor 显式 |
| G-04 | `workbench_workflow_output_submit` | `POST /workflows/attempts/:id/outputs` | write.local | 必填 `idempotencyKey` | 只提交候选，写 staging，不改 notes/modules |
| G-05 | `workbench_workflow_progress` | `POST /workflows/attempts/:id/progress` | write.local | 事件去重 | 有界进度；不得代替输出验收 |
| G-06 | `workbench_workflow_start` | `POST /workflows/runs` | write.local | 必填 `idempotencyKey` | 固定模板 + 预算 + 会话授权 |
| G-07 | `workbench_workflow_pause` / `_resume` / `_cancel` | `POST /workflows/runs/:id/:command` | write.local | 幂等（同命令重复返回同状态） | 需 `expectedRevision`；不绕过人工待办 |
| G-08 | `workbench_workflow_job_get` / `_job_cancel` | `GET/POST /workflows/jobs/:id` | read / write.local | 幂等 | 仅本调用范围内的 jobRef |
| G-09 | `workbench_workflow_human_task_list` | `GET /workflows/human-tasks` | read | 天然 | 只读；**不提供确认** |
| G-10 | （不开放）人工确认 / 正式发布 | 仅 UI 受认证通道 / outbox | — | — | Agent 无对应工具 |

**冻结约束**

- G-01..G-10 是**拟议**名称，M0 确认命名后写入 03；未确认前不得在代码里注册。
- 参数中的 `productId/runId/attemptId` 是待校验目标，**不是授权凭证**；身份由宿主从可信调用上下文绑定（03 §3.1 第 4 条）。
- 统一返回 `{operationId, status, artifact|jobRef, nextAction, error?}`；`status` 区分 `accepted` 与 `completed`，HTTP 200 或 tool 成功都不等于业务通过。
- 错误码冻结：`workflow_requires_sqlite`、`publish_target_invalid`、`publish_conflict`、`attempt_invalid`、`schema_invalid`、`artifact_missing`、`outcome_unknown`、`capability_unavailable`、`budget_exhausted`、`human_confirm_required`。

## 4. 冻结：API → 业务服务 → tool 对照

| 领域动作 | 业务服务（唯一实现） | HTTP | DSH tool | 阶段 |
| --- | --- | --- | --- | --- |
| 读运行 | run service | `GET /runs/:id` | G-01 | W1 假 / W2 真 |
| 读产物 | snapshot service | `GET /runs/:id/artifacts` | G-02 | W1 假 / W2 真 |
| 读事件 | event log | `GET /runs/:id/events` | G-03 | W1 假 / W2 真 |
| 提交候选 | attempt service（校验 manifest/schema/hash） | `POST /attempts/:id/outputs` | G-04 | W1 假 / W2 真 |
| 上报进度 | attempt service | `POST /attempts/:id/progress` | G-05 | W1 假 / W2 真 |
| 启动/暂停/继续/取消 | scheduler | runs 命令 | G-06/G-07 | W0 定子集；W2 真 |
| 长任务查询/取消 | job service（复用 jobRef） | jobs | G-08 | W1 假 / W2 真 |
| 待办列表 | human task service | `GET /human-tasks` | G-09 | W1 |
| 保存人工草稿 | human command service（受认证） | `POST /human-tasks/:id/draft` | **无** | W1 |
| 确认 / 驳回 | human command service（受认证） | `POST /human-tasks/:id/confirm` | **无** | W1 |
| 正式发布 | publish outbox（声明目标） | 内部 | **无** | W1 |

**不新增**：独立 MCP 服务、工具专用队列、第二套任务状态表；C1/W4/S 只扩展各自能力并复用桥接层。

## 5. 冻结：权限矩阵

行是调用来源，列是能力。`✓`=允许，`△`=受限（需附加条件），`×`=禁止。

| 调用来源 | 读运行/产物 | 提交候选 | 报进度 | 控制运行 | 确认人工节点 | 正式发布 | 直写 notes/modules |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 用户界面（受认证会话） | ✓ | ✓（人改后） | ✓ | ✓ | ✓ | ×（走 outbox） | ✗ 首期不放开 |
| 工作流节点 Agent（派发会话） | ✓ 本 run | ✓ 仅本 attempt | ✓ 仅本 attempt | △ 仅授权范围 | × | × | × |
| 其它 Agent 会话 | ✓ 本产品 | × | × | × | × | × | × |
| 系统调度器（进程内） | ✓ | × | × | ✓ | ×（生成 human Adoption 需人确认） | ✓ | × 只经 outbox |
| 本机任意 HTTP 客户端 | 需会话校验 | 需 attempt 凭证 | 需 attempt 凭证 | 需授权 | × | × | × |

**附加条件**

- `△ 控制运行`：需该会话被授予控制权限、剩余预算 > 0、`expectedRevision` 命中；暂停/取消需回传实际结果，未知结果标 `outcome_unknown` 先对账。
- 人工确认**只能**由受认证 UI 通道产生；`actorType=human` 请求体字段、隐藏按钮、不注册 tool、Origin 校验都不构成证明（03 §3.1 第 4 条，Q19）。
- 工作流会话的允许集合 = G-01..G-09 + 3 个只读工作台工具；其余 17 个写工具必须**在注册层排除**，不能只靠提示词。
- 若宿主无法建立上述边界，该 run 标记 `capability_unavailable`，不进入自动写回。

## 6. 冻结：长任务协议（jobRef）

- 提交：`output_submit` 返回 `{jobRef, status:'accepted'}`；`jobRef` 由宿主生成，Agent 不得自造。
- 查询：`job_get` 返回 `{jobRef, status: pending|running|succeeded|failed|cancelled|outcome_unknown, attemptId, nextAction}`。
- 取消：`job_cancel` 幂等；取消成功以宿主确认为准，不以 HTTP 200 为准。
- 归属：`jobRef` 绑定 attempt；跨 attempt 使用返回 `attempt_invalid`。
- 对账：重启后未结 job 先查询再决定重试；不自动重复付费调用（03 §3.1、12 号 ADR-24）。

## 7. 验收标准（M0 内可判）

| 编号 | 判据 |
| --- | --- |
| T-01 | 03 §3.1 的拟议表替换为 G-01..G-10 冻结表，含 effectClass、幂等、错误码 |
| T-02 | 11 号 W0-07 有「现有 20 工具差集」结论：复用 3 只读 + 保留 1 进度写工具、排除 16、新增 9 |
| T-03 | 权限矩阵写入 03 或 12，明确「Agent 无确认/发布工具」 |
| T-04 | Q19 有结论：人工确认通道边界，或明确降级为只读 + 人工导入 |
| T-05 | Q20 有结论：租约/心跳/预算/幂等保留期（可与 W0-06 合并） |
| T-06 | 工具名不与现有 20 个冲突（已核对，无重名） |

## 8. 继续 / 降级

- **继续**：G-01..G-09 可在现有 `ctx.tools.register` + `registerGuardedTool` 上实现，不需要复制 runtime。
- **降级触发**：Q19 证明人工通道无法与 Agent 隔离 → 按 03 §3.1 第 4 条降为「只读 + 人工导入候选」，M1 假适配照常，M2 不开放自动发布。
- **另一降级**：若工具策略 v1 无法在注册层完成排除（只能提示词约束），则工作流会话必须用独立 profile + `strict` 白名单，或改为宿主侧直接拒绝源会话。

## 9. 未验证项

- 未在真实 DSH 宿主验证：`ctx.tools.register` 的 `when` 是否按 agent 生效、`tools/pre-execute` 是否能覆盖嵌套/子代理调用（v1 证据只有假上下文）。
- 未验证 `/workbench-api` 是否有任何会话校验（当前读码未见），因此矩阵最后一行「需会话校验」是**要求**而非现状。
- 未核对真实数据里 `pd:`/`td:`/`ui:` 键是否已冲突（依赖 W0-01 盘点）。
- 未评估 20 个工具的调用量分布，排除后是否影响现有手工流程需实测。
