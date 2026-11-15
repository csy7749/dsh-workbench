# W0-05 冻结提案：发布身份、冲突、镜像与引擎边界

状态：**M0 冻结提案，未合并进 01/02/03/08/12，M0 仍未通过。** 日期：2026-11-13。
提出：happy-4.1（M0-P2 复核后按阶段边界补写）。合并责任：主实施者写入 08（存储/发布）、12（决策）、11（任务状态）；本文件只作冻结文本与证据来源，不改既有契约。

## 1. 依据与判断口径

- 11 号 W0-05 原文是「**验证**四步工具 staging 与采用后领域发布，禁止提前修改 notes / modules」；03 §3.1 明确要求 W0「**冻结**准确命名、schema 和启用清单」，实现归 W1-10 / W2-02/08。
- 因此本文件只冻结**契约与反例**，不含源码修复。修复任务归属见第 7 节。
- 旧报告只作历史依据；8 号第 77 行的「`saveNote` 吞掉镜像失败不能作为新 outbox 成功依据」与第 79 行的「秒级 `updated_at` 不足以识别同秒修改」是本提案的直接来源。

## 2. 现状证据（只读核对，HEAD 9d7cac8）

| 编号 | 事实 | 位置 |
| --- | --- | --- |
| E-01 | `saveNote` 仅在未显式给出 `docKey` 时按 `kind+归属` 推导键；`product_design` 无 `moduleId` 时恒为 `pd:<productId>` | `src/host/index.ts:1547-1556` |
| E-02 | 有 `docKey` 时先按 `id`、再按 `doc_key` 查既有行，命中即更新同一行；更新 SQL 只有 `WHERE id=?` | `src/host/index.ts:1557-1576` |
| E-03 | `publishProductNote` 不接收也不转发 `docKey`；`kind` 缺失时回落 `product_design` | `src/host/index.ts:2768-2795` |
| E-04 | 工具 `workbench_product_note_publish` 的 schema 无 `docKey` 字段（`additionalProperties:false`） | `src/host/index.ts:6536-6552` |
| E-05 | 其它键命名空间：`md:`、`fd:`、`pd:`、`ui:`、`td:` | `:1549-1554`、`:3371`、`:2128` |
| E-06 | `notes` 表无 `revision`、无 `content_hash`；迁移只补 `kind/node_id/module_id/doc_key`；唯一索引 `idx_notes_doc_key` 仅约束非空键 | `src/host/index.ts:387-396`、`:569-577` |
| E-07 | 镜像直接写最终路径，无临时文件/rename/fsync；路径由标题 + `id` 后 6 位组成 | `src/host/index.ts:5563-5572` |
| E-08 | 镜像异常被吞，`filePath` 置空；`existing.file_path !== filePath` 时删除旧文件；`removeFile` 吞错 | `src/host/index.ts:1565-1573`、`:5574-5576` |
| E-09 | `/sync/push` 的 notes 分支只转发 `id/notebookId/title/content/tags/pinned/mapId` | `src/host/sync.ts:411-423` |
| E-10 | LWW 用秒级字符串比较，同值时后者覆盖且两次都 `accepted` | `src/host/sync.ts:474-481` |
| E-11 | `/sync/push` 在非 SQLite 时返回 501；发布器与 `saveNote` 无引擎判断 | `src/host/index.ts:6797-6800`、`:2768` |
| E-12 | 无 `DSH_WORKBENCH_DB` 或 SQLite 不可用时回落 `JsonStore`，其 `saveNote` 无 `kind/docKey` | `src/host/index.ts:6657-6662`、`:4194-4213` |

## 3. 已复现反例（characterization，不是修复通过）

`scripts/probe-workflow-legacy-publish.mjs`（bundle `dface5334…59bb`，17 项断言）与补充临时脚本：

| 编号 | 反例 | 观测 |
| --- | --- | --- |
| C-01 | 同产品先发产品设计、再发「一致性报告」 | 同 `docKey=pd:<product>`、同 note id、标题变为报告，正文被覆盖 |
| C-02 | 同 `docKey` 但不同 `id` 连续保存（`id-aaa`、`id-bbb`） | 两行合一，`aId === bId`，标题被后写覆盖 |
| C-03 | 同 `updatedAt` 两次 `/sync/push` | 两次都进 `accepted`，最终内容为后一次 |
| C-04 | `/sync/push` 推一篇 `md:<moduleId>` 设计文档 | 回读 `docKey/kind/moduleId` 全为空 |
| C-05 | 镜像目标被目录占位（EISDIR） | 保存仍 200、`filePath=''`、旧 `.md` 已删、新文件未写出 |
| C-06 | JSON 兜底引擎下保存两篇 `product_design` | 合成一行，`docKey` 仍被推导为 `pd:<product>` 但表无该列保证 |

## 4. 冻结条目（W0-05 交付物）

编号沿用 `P-` 前缀，供 11 号台账与 10 号验收引用。

**P-01 发布键命名空间**
`docKey` 形如 `<ns>:<scope>`，命名空间冻结为 `md`（模块设计）、`pd`（产品设计）、`fd`（功能设计）、`ui`（UI 设计）、`td`（测试设计）、`audit`（一致性/校验报告）。新增命名空间须改本条目并同步 08。

**P-02 键由服务生成**
`docKey` 由受控发布服务按目标归属生成，Agent 不得提交任意键。工具参数一律以 `productId/mapId/moduleId/featureId/nodeId` 表达目标，键是服务输出而非输入。

**P-03 报告独占身份**
一致性报告必须使用独立身份，二选一（W0 冻结其一，默认前者）：
- (a) `docKey = audit:<productId>`，与 `pd:<productId>` 分离；`notes.kind` 保持现有五值枚举，报告用领域标签 + 独立键，不新增枚举值；
- (b) 报告进独立表/独立列，不写 `notes`。
实现前先按本条目改夹具的 `storageMapping`；在此之前不得把 `audit_report` 导入现有发布器。

**P-04 目标归属校验**
发布前必须校验 `moduleId/featureId/mapId` 属于 `productId`，`docKey` 的 scope 与目标一致；读不到归属即拒绝（错误码 `publish_target_invalid`），不做「找不到就新建产品级」。

**P-05 冲突判定口径**
冲突以**目标完整字段 hash** 或**领域 revision** 判定，覆盖四个写入口：旧 UI（HTTP `POST /notes`）、直写 tool、`/sync/push`、工作流发布 outbox。秒级 `updated_at` 与全局 revision 不足以单独判定，需在 08 的 notes 一节写明。

**P-06 显式基准**
发布请求携带 `expectedRevision`（或 `baseHash`）；不匹配返回 `publish_conflict` 并附当前 `{revision, contentHash, updatedAt}`，不静默覆盖。缺失基准只允许「新建」，不允许「覆盖」。

**P-07 唯一键并发**
同 `docKey` 并发插入由唯一索引兜底，捕获约束错误后重查按 P-06 处理，不向上抛裸 SQL 错误。

**P-08 同步字段保真**
`/sync/push` 对未提供的字段一律**保留原值**；显式清空须用独立语义（如 `null` 或 `clearFields`），不得以「缺省即空串」清身份。必须保留 `kind/nodeId/moduleId/docKey/mapId`。旧客户端不带这些字段时按保留处理。

**P-09 DB 与镜像分离对账**
`saveNote`/发布器返回成功 **不等于**发布完成。发布结果须分别记录 `db` 与 `mirror` 两个状态；集合发布在全部必需目标完成前不显示「正式发布完成」。

**P-10 镜像原子替换**
镜像先写同目录临时文件、`fsync`、`rename`；写完才更新 `file_path`。任一环节失败：保留旧 `file_path` 与旧文件，记 `mirrorStatus=pending`（或错误码），并入 outbox 重试；**禁止**在失败分支删除旧文件。

**P-11 删除顺序**
删除笔记时先提交 DB 与墓碑，再删镜像文件；删文件失败只记待清理，不回滚 DB。

**P-12 引擎边界**
新工作流发布服务只跑在 SQLite；非 SQLite 返回 `workflow_requires_sqlite`。旧手工笔记的 JSON 兜底保留可用，但**不得**在 JSON 上声称 `docKey` 有效、不得在其上承接工作流发布。

**P-13 跨文件非原子**
多个用户文件不做跨文件原子承诺；外部读者可见短暂中间态。回滚以「目标仍为基准」判定：仍为基准可继续，已是预期结果补记成功，第三种内容即 `publish-conflict`。

## 5. 验收标准（M0 内可判，全部可复验）

| 编号 | 判据 | 证据形式 |
| --- | --- | --- |
| V-01 | P-01..P-04 写入 08 与 12，键命名空间与报告身份有唯一结论 | 文档 diff |
| V-02 | C-01/C-02 有对照反例：改契约为 `audit:` 后，报告与正文两行两文件互不覆盖（假宿主） | 探针输出 |
| V-03 | C-03 同秒双写产生冲突而非静默覆盖（假宿主 + 临时 SQLite） | 探针输出 |
| V-04 | C-04 推送后 `kind/docKey/moduleId` 保持不变 | 探针输出 |
| V-05 | C-05 镜像失败后旧文件与 `file_path` 保留、状态可对账 | 探针输出 |
| V-06 | C-06 JSON 引擎发布被拒并返回 `workflow_requires_sqlite` | 探针输出 |
| V-07 | 每个反例都标注「刻画缺陷」或「验证契约」，不混用 | 脚本内注释 + 退出码 |

V-02..V-06 需要 M1 的实现，故 M0 只需 V-01 与「反例已存在、修复归属已登记」；M0 不以修复完成为门。

## 6. 继续 / 降级判断

- **继续**：P-01..P-13 可实现、不依赖模型、不依赖生产库；M1 假执行器路线成立。
- **触发降级**：若 P-04 无法在宿主侧取得可信目标归属（只能信任 Agent 传参），则工作流发布降为「只读 + 人工导入候选」，不开放自动写回；M1 仍可做假适配，M2 不开放。
- **不允许的替代**：用「夹具 ID 不同」「35/17 项断言通过」「bundle 探针复现」任一条替代 V-01 的冻结文本。

## 7. 实现归属（不属于 M0）

| 条目 | 实现阶段 |
| --- | --- |
| P-02/P-03/P-04 发布服务与报告身份 | W1-04、W1-10（假适配）；W2-03/04/06 |
| P-05/P-06/P-07 revision/CAS 与冲突码 | W1-02 |
| P-08 同步保真与旧客户端兼容 | W1-02；W2-06 |
| P-09/P-10/P-11 outbox 与镜像原子性 | W1-03 |
| P-12 引擎闸门落地 | W1-01 |
| 真实并发、双窗口、恢复扫描 | W2-07；A04/A06/A39 |

## 8. 未验证项

- 未在真实宿主、多进程、真实 HTTP 并发下验证；C-02/C-03 为单进程顺序调用。
- 未验证断电与目录项持久性；durability 探针只覆盖进程退出。
- 未验证 Windows 下 ACL/磁盘满对 `rename` 的影响。
- 报告独立存储选 (a) 还是 (b) 需主实施者在 12 号决策；本文件给默认值 (a)，不代替决策。
- 未核对 `ui_designs` 与 `notes` 的 `td:`/`ui:` 键在真实数据中是否已存在冲突，需要 W0-01 的 schema/数据盘点补齐。
