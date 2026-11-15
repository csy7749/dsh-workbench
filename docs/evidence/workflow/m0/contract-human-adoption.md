# W0-08 冻结提案：人工节点、system / human 采用与发布绑定协议

状态：**M0 冻结提案，未合并进 02/03/04/08/12，M0 仍未通过。** 日期：2026-11-13。
提出：happy-4.1。合并责任：主实施者写入 02 §2、04 §3、08 发布一节、12 号 ADR-19/20/24；11 号 W0-08 记证据。
依据：11 号 W0-08「冻结人工节点、system / human 采用及发布绑定协议；用有 / 无人工节点样例验证恢复、确认和自动推进边界」；02 §2；04 §3。

## 1. 现状证据（只读）

| 编号 | 事实 | 位置 |
| --- | --- | --- |
| E-01 | 代码中不存在人工节点 / HumanTask / Adoption 概念，`grep -rn "human_task\|humanTask\|HumanTask" src/` 0 命中 | `src/` |
| E-02 | 现有"人工"只有手工触发工具与页面操作，没有"运行到节点停下等确认"的状态 | 无实现 |
| E-03 | 采用语义未实现：`publishProductNote` 直接写 notes，无 Snapshot / Adoption / stale | `src/host/index.ts:2768-2796` |
| E-04 | 快照与草稿的规则只存在于文档 02，代码无 revision/stale 字段 | `notes` 表 `:387-397` |
| E-05 | 一致性报告与产品正文共用一个键，无法表达"两个不同采用" | 反例 C-01，见 `contract-publish-identity.md` |
| E-06 | 夹具 `scripts/fixtures/workflow/product-design.json` 原先只有产物样例，**没有有 / 无人工节点的两个运行样例**；已于 2026-11-14 补 `scripts/fixtures/workflow/human-runs.json` + `scripts/verify-workflow-runs.mjs`（115 项结构断言） | 探针核对 |

结论：W0-08 当前是**纯契约缺口**，不是实现缺陷；冻结文本给出后，M1 才能在 W1-04/W1-10 上做假执行器。

## 2. 冻结条目

**H-01 人工节点类型**
显式节点类型冻结为 `human.edit-confirm`。只有模板里声明该类型的节点才创建待办；普通节点不创建空草稿、不要求点击（04 §1、02 §2）。"需要人审"不是全局开关。

**H-02 进入人工节点**
上游节点完成机器校验并 system 采用 → 宿主创建 HumanTask 并置 run 为 `waiting_review`。HumanTask 必须绑定：`runId`、`nodeId`、`inputSetId`（有序输入快照集合）、`inputFingerprint`、`templateRevision`、`expectedRunRevision`。等待**不占用执行槽**、**没有自动确认超时**。

**H-03 草稿与确认分离**
- 保存草稿只写 Draft（带 `draftRevision`），不推进、不失效下游。
- 未改内容直接确认也合法，但仍创建该人工节点**自己的输出 Snapshot 身份**（`parent` = 上游已采用快照，可复用同一 blob），不得把上游 Snapshot 身份当作人工输出。
- 后端不把"最近一次保存"当确认；`savedAt` 与 `confirmedAt` 分开记录。

**H-04 确认请求必备字段**
`humanTaskId`、`taskRevision`、`inputFingerprint`、`expectedRevision`（Draft 基准）、`expectedAdoptionId`、`expectedRunRevision`、`intent`（`continue` / `pause`）、`idempotencyKey`。缺任一字段即拒（`human_confirm_invalid`），不回落默认值。

**H-05 确认前重校验**
宿主必须重校验：内容 hash、输入新鲜度（`inputFingerprint` 未变）、schema、验证报告是否仍有效（报告只在绑定内容 hash 一致时有效）。任一项失败保留草稿并返回具体字段/文件，**禁止先推进再补错误**。

**H-06 采用事务**
单事务内写：human Snapshot、human Adoption、Event、HumanTask `confirmed`、run `revision + 1`。任一写失败整体回滚，不留"确认了一半"。

**H-07 继续 / 暂停的原子性**
- 「确认并继续」：完成人工节点并在同一事务内写下调度意图，避免下一步抢先。
- 「确认并暂停」：原子地完成确认并置 `paused`（原因 `human_confirmed`）。
- run 已 `paused` 时确认只保存结果，不解除暂停。
- 幂等：同 `idempotencyKey` 返回首次结果；同 `humanTaskId` 已 `confirmed` 时返回既有 adoption，不重复创建；两个窗口同时确认，一个成功、另一个返回 `human_confirm_conflict` 并附当前 adoption。

**H-08 system / human 采用必须可区分**
`Adoption.actorType ∈ {system, human}`，且 `human` 只能由受认证 UI 通道产生：
- Agent 侧**不注册**任何确认工具（见 `contract-tool-governance.md` G-10）；
- 请求体的 `actorType` 字段、隐藏按钮、`Origin` 头都**不构成证明**（03 §3.1 第 4 条）；
- 宿主内部分辨"这是人的动作"必须来自可信会话凭据或进程内直接调用，不能用 Agent 可伪造的参数。

**H-09 发布绑定**
- Adoption 记录声明的发布目标集合：`[{docKey, mode, required}]`。
- 每条 outbox 绑定 `adoptionId` + `docKey` + `expectedHash`；发布器按目标逐项写，成功条件 = **全部 required 目标 completed**。
- 部分完成对外显示逐项状态（`db` / `mirror` 分开），不得显示"整套已发布"。
- 旧 outbox 在对应 adoption 被 superseded 后**不续发**，标 `superseded` 并留痕；不删除记录。
- 外部文件不承诺跨文件原子可见（08 §7、10 号）。

**H-10 恢复与基准失效**
重启后恢复同一 HumanTask 与最近已保存草稿（草稿不丢）；上游基准被替换、取消或失效时禁用旧确认、保留草稿并展示差异，**重新绑定必须显式操作**，不自动换基准。

**H-11 驳回与取消**
- 驳回候选保留原因与产物，不等于取消 run；后续仍可重新生成候选。
- 取消 run 使待办失效（HumanTask `cancelled`），草稿保留为只读，不删除。
- 人工节点不因 run 暂停而自动确认。

**H-12 修改已采用上游**
同 run 内重新采用上游：先暂停并对账活跃执行 → 更新合法采用绑定 → 传播 `stale` → 显式继续；已保存 Attempt 的实际输入不得改写。改变固定外部资料、定义/配置/权限或终态运行 → 派生新 run（02 §2、ADR-25）。

**H-13 有 / 无人工节点两条路径**
- 有：`生成文档 → 人工编辑确认 → 提炼结构 → 自动节点`，等待期间 run 不推进。
- 无：`生成文档 → 机器校验 → system 采用 → 提炼结构`，不出现空待办、不出现"请点击确认"。
- 两条路径共用同一 Adoption / Snapshot / 发布绑定结构，只有 `actorType` 与是否阻塞不同。

**H-14 多文件产物**
以 `OutputSet` 为完整性边界：逐文档可编辑，但集合未完整前不确认、不继续；缺任一必需文件即 `artifact_missing`。

## 3. 已复现 / 待复现反例

| 编号 | 反例 | 期望 |
| --- | --- | --- |
| C-01 | 保存草稿后直接点确认，中间改了正文 | 指纹不符 → `human_confirm_invalid`，保留草稿（待实现验证） |
| C-02 | 两个窗口同时确认同一待办 | 一个成功、一个 `human_confirm_conflict`（待实现验证） |
| C-03 | 确认后镜像写失败 | DB 已采用、mirror `pending`，显示逐项未完成（待实现验证） |
| C-04 | 待办等待时上游被重新采用 | 旧确认禁用，需显式重新绑定（待实现验证） |
| C-05 | 无人审路径仍需点确认 | 不得出现空待办；机器校验后 system 采用（待实现验证） |
| C-06 | 报告与正文共用 `pd:` 键 | 两个采用互相覆盖（**已复现**，见 `contract-publish-identity.md` C-01） |

## 4. 验收标准（M0 内可判）

| 编号 | 判据 |
| --- | --- |
| W08-01 | 02/04/08 写入 H-01..H-14，术语与 01 的 Snapshot / Draft / Adoption / stale 一致 |
| W08-02 | 12 号新增或合并 ADR：`human.edit-confirm` 阻塞语义、system/human 采用区分、发布绑定与 superseded |
| W08-03 | 夹具补两个运行样例（有 / 无人工节点，同一产品），只写样例不实现 | **已完成**：`scripts/fixtures/workflow/human-runs.json`（`fixture-run-human` 4 步含 `human.edit-confirm`、`fixture-run-auto` 3 步全自动）+ `scripts/verify-workflow-runs.mjs` 115 项断言通过；变异测试 7 例全部被拦。不实现调度，不证明运行时行为 |
| W08-04 | 明确「Agent 无确认工具」写入 03 或 12（与 T-03 一致） |
| W08-05 | 恢复语义写明：重启恢复草稿、无自动超时、基准失效需重新绑定 |
| W08-06 | 发布成功条件写明：required 全部 completed，部分完成逐项显示 |

M0 只要求 W08-01..W08-06 的**文本与样例**；C-01..C-05 的实际验证归 M1（W1-04/A34–A37）。

## 5. 继续 / 降级

- **继续**：H-01..H-14 全部可在宿主侧实现，不依赖模型能力；M1 假执行器可完整跑通两条路径。
- **降级触发**：若 H-08 无法建立可信人工身份（Q19 未决且证据不利）→ 人工确认降级为"只读 + 人工导入候选"，M1 仍做假执行器，M2 不开放自动发布。
- **不允许替代**：用"UI 按钮存在""提示词写着必须人审""actorType=human 参数"任一条替代 H-08 的证据。

## 6. 实现归属

| 条目 | 阶段 |
| --- | --- |
| H-01..H-06 人工节点与 HumanTask | W1-04、W1-09（K1 相关只读部分） |
| H-07 继续/暂停原子性 | W1-04、W1-05 |
| H-08 可信人工身份 | W0-04 探测 + W1 假身份 + W2 目标环境 |
| H-09 发布绑定与 superseded | W1-03、W1-10；W2-03/04/06 |
| H-10 恢复与基准失效 | W1-05、W1-06 |
| H-11 驳回/取消 | W1-04、W1-06 |
| H-12 重新采用与派生 | W1-04；W3-04（派生运行与模板） |
| H-13/H-14 两路径与集合完整性 | W1-04、W2-07（A34/A35/A36） |

## 7. 未验证项

- 未在真实宿主验证"等待不占执行槽"与"重启恢复待办"；当前无实现，属纯设计。
- 未确认 `human.edit-confirm` 是否需要在模板 schema 里新增枚举值，还是用节点属性表达（03 需定）。
- 未核对 09 界面的"确认并继续/确认并暂停"（执行计划四步产物验收 A34–A36）与 04 文案是否完全一致。
- 未评估 HumanTask 与现有 `humanReview` 相关 UI 组件是否可复用（无代码可核）。
