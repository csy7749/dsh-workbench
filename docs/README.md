# 文档总索引

整理日期：2026-11-11（Asia/Shanghai）。本目录同时保存现有功能说明、历史调查证据和未来方案。**先读状态，再按任务读专题；规划中的能力不等于已经可用。**

建议从 [执行计划](execution-plan-2026-11-11.md) 开始。它将已有方案收敛为 M0 基线验证 → M1 无模型闭环 → M2 产品设计试点，扩展路线分别排期。

2026-11-12 的遗漏、矛盾及源码静态复核见 [文档审校记录](documentation-review-2026-11-12.md)。其中区分已修正文档和仍待实测 / 实现的事项。

## 1. 当前使用与维护

以下是现有功能的说明入口；“已有实现”依据当前源码入口，不表示本次重新完成运行时验收。

| 文档 | 用途 | 状态与阅读注意 |
| --- | --- | --- |
| [项目 README](../README.md) | 安装、功能全貌、日常使用 | 当前包声明版本为 1.13.0 |
| [设计流水线](design-pipeline.md) | 导图、模块文档、模块结构、产品文档与检查 | 已有直接写回流程；新工作流改造见执行计划 |
| [UI 与 DEMO](ui-demo.md) | 主题、页面设计、DEMO、工具与自检 | 现有功能说明；开头引用的原始设计资料未随仓库提供 |
| [增量同步协议](sync-protocol.md) | 六类实体、游标、墓碑和同步接口 | 文档标注适用 1.10.0；跨版本使用先核对 `src/host/sync.ts` |
| [智能体团队入口](agent-team/README.md) | 团队配置、派发、投影、知识与记忆 | 含历史版本进度；模型、权限、建队等运行边界需分别核验 |

团队专题共 5 份文档：

| 文档 | 定位 |
| --- | --- |
| [01 需求与技术分析](agent-team/01-需求与技术分析.md) | 调研、宿主原理与需求依据 |
| [02 可行性评估](agent-team/02-可行性评估.md) | 历史 Spike、风险和估算 |
| [03 产品设计](agent-team/03-产品设计.md) | 信息架构、配置、派发和数据模型 |
| [04 Spike 结论](agent-team/04-Spike结论.md) | 源码 / 探针结果及未完成的真实会话验证 |
| [README](agent-team/README.md) | 专题导航、版本进度和审校记录 |

## 2. 当前开发规划

**以 [工作流 v1 对齐包](workflow-v1/00-对齐说明.md) 为准（2026-11-15 起）**：范围收敛到游戏一条线，6 篇文档分别管对齐、内核与产品包、画布与节点规范、游戏产线、实施计划、入口与归属。下文 workflow-plan 19 篇降级为历史参考，只在 v1 没写到的细节上查阅。

| 阅读顺序 | 文档 | 作用 |
| --- | --- | --- |
| 1 | [00 对齐说明](workflow-v1/00-对齐说明.md) | 为什么重起、v1 做与不做、需拍板的 D1–D7、完成定义 |
| 2 | [01 内核与产品包](workflow-v1/01-内核与产品包.md) | 四层依赖、ProductPack 契约、五条解耦红线 |
| 3 | [02 画布与节点规范](workflow-v1/02-画布与节点规范.md) | 端口类型、节点契约、连线规则、校验、路由表 |
| 4 | [03 游戏产线](workflow-v1/03-游戏产线.md) | 游戏线产物、节点、模板、验收场景 |
| 5 | [05 入口与归属](workflow-v1/05-入口与归属.md) | 双入口、复制即分离、保存为模板、ComfyUI 对照 |
| 6 | [04 实施计划](workflow-v1/04-实施计划.md) | M0–M4 里程碑、出口条件、风险预案 |

历史规划：[工作流规划总目录](workflow-plan/README.md)（草案，覆盖 W0–W6 与多条产品线，共 19 份）：

| 阅读组 | 文档 | 使用时点 |
| --- | --- | --- |
| 核心契约 | [01 领域模型](workflow-plan/01-domain-model.md)、[02 快照](workflow-plan/02-snapshot-versioning.md)、[03 运行时](workflow-plan/03-node-contract-runtime.md)、[08 存储](workflow-plan/08-storage-migration.md) | M0 冻结、M1 实现 |
| 用户闭环 | [04 人工编辑](workflow-plan/04-human-review-editor.md)、[09 编排界面](workflow-plan/09-orchestration-ui.md) | M1 最小界面、M2 试点；W3 才开放节点配置 |
| 执行和上下文 | [13 执行配置](workflow-plan/13-execution-profiles.md)、[16 OhMyGame 机制](workflow-plan/16-ohmygame-workflow-adoption.md)、[17 上下文开发](workflow-plan/17-context-knowledge-development.md) | W0/E01/K0 → W1/E02/K1 → W2/E03 |
| 验收与治理 | [10 验收](workflow-plan/10-testing-release-governance.md)、[11 任务台账](workflow-plan/11-roadmap-backlog.md)、[12 决策风险](workflow-plan/12-decisions-risks.md) | 全阶段；任务状态只在 11 更新 |
| 产品扩展 | [05 产品包](workflow-plan/05-product-packs.md)、[06 游戏](workflow-plan/06-game-workflow.md)、[07 小说短剧](workflow-plan/07-novel-drama-workflows.md) | 基础试点后分包实施 |
| 独立扩展 | [14 聊天工作室](workflow-plan/14-chat-workflow-studio.md)、[15 素材工作流](workflow-plan/15-asset-workflow-sprite-gen.md)、[18 项目研习](workflow-plan/18-project-learning-workflow.md) | C / S / L 单独估算和启用；研习先做本地单专题 |

当前实施证据见 [M0 基线记录](evidence/workflow/m0/README.md)（进行中，尚未通过阶段门）。同日另有三份 M0 冻结提案：[发布身份](evidence/workflow/m0/contract-publish-identity.md)、[工具治理](evidence/workflow/m0/contract-tool-governance.md)、[人工节点与采用](evidence/workflow/m0/contract-human-adoption.md)，均待主实施者合并进 02/03/04/08/12。M1 证据见 [M1 记录](evidence/workflow/m1/README.md) 与 [M1 缺口盘点](evidence/workflow/m1/gap-inventory.md)。2026-11-13 新增该记录与三份契约后，docs 下共 41 份 Markdown；此数量包含 evidence 文档。

## 3. 调查、评估与暂停记录

以下保留原日期和结论。引用中的外部目录、版本、哈希、测试结果均属于当时的现场信息，恢复实施前重验。

| 文档 | 定位 | 后续使用方式 |
| --- | --- | --- |
| [游戏插件评估](game-module-plugin-assessment-2026-11-10.md) | Game Studio / DrawAI 吸收边界、P0–P4、当时测试结果 | 游戏线启动先做 P0；源码检查不替代宿主联调 |
| [CCGS 评估](claude-game-studios-assessment-2026-11-10.md) | 游戏角色、流程、模板与许可 | W4/P1.5 按需转换；角色文本不授予执行权限 |
| [sprite-gen 评估](sprite-gen-assessment-2026-11-10.md) | 本地加工、图集与生成后端适用性 | 实施契约转至 15；S0 可独立验证 |
| [记忆工作暂停记录](memory-work-paused-2026-11-10.md) | 两条记忆工作线、历史 NO-GO、证据与恢复条件 | 继续暂停；K0/K1 显式上下文不代表恢复记忆实验 |
| [技术雷达审计](radar-audit-2026-11-01.md) | 2026-11-01 的问题、证据和建议批次 | 历史报告；先复核现有实现，不把整张表转成新待办 |

## 4. 文档维护规则

1. 当前功能写明适用版本；规划写明阶段和依赖；调查结果写明日期、环境、证据及未验证项。
2. 本目录索引负责导航，[执行计划](execution-plan-2026-11-11.md) 负责先后顺序，[11](workflow-plan/11-roadmap-backlog.md) 负责任务状态，[12](workflow-plan/12-decisions-risks.md) 负责决策。不要复制另一套复选框。
3. 实施任务完成时附代码版本、验证命令和结果、适用的窗口证据及回退记录；原文中的“通过”不替代本轮验收。
4. 保留现有文件名和路径，避免破坏引用。历史结论不重写；新复验追加日期和证据，过时待办由台账明确关闭或替换。
5. 新文档加入对应专题和本索引；引用缺失资料时注明缺失并提供现有替代入口。

2026-11-11 整理前共有 31 份 Markdown 文档，新增本索引与执行计划后共 33 份；2026-11-12 新增审校记录后共 34 份，同日新增项目研习计划后共 35 份。没有移动或删除原文档。
