# 工作台原生 Game Studio 方案

状态：方案 v0.4，原生 14 工具、版本 CAS / 比较 / 恢复、素材与源码候选、管理抽屉及受限创作桥已实施，原 14 节点模板已带显式原创素材包完成真实浏览器联测；本机 Blender 5.3.0 的固定 worker 已实际生成并回读 `.blend` / GLB / PNG。尚未完成真实桌面 / 模型 / 人工交付验收，最终人工门仍未通过。更新日期：2026-11-19（Asia/Shanghai）。任务状态以 [11 的 GS 清单](11-roadmap-backlog.md#16-gs-原生游戏工坊工作包) 为准；第 12 / 13 节保留历史证据，当前扩展范围与限制见第 14 节。

目标：为工作台提供自有、可独立运行的浏览器小游戏工坊，使游戏工作流不依赖 DSH Game Studio 插件是否安装或向会话暴露工具。本文定义产品边界、参考来源、能力分期和验收；核心采用原创模板，试玩按需使用本机已有 Playwright 与浏览器，不自动安装或下载运行环境。

## 1. 结论

建设工作台原生 Game Studio，首期定位为**本地优先的 Web 小游戏原型工坊**。工作台负责工程身份、文件范围、构建、预览、版本证据和离线导出；模型 / Agent 负责在明确授权的工程副本内提出代码与设计修改。工作流通过工作台自身的能力提供方执行游戏操作，不要求运行会话安装 `dsh-game-studio`。

兼容当前工作流节点的操作语义；原生工具采用 `workbench_game_*` 名称，避免与外部插件的 `game_studio_*` 工具冲突。当前共注册 14 工具，覆盖创建 / 构建 / 预览 / 试玩 / 导出、版本、素材、Blender 及源码候选。工作流的创建、试玩、修订核对、构建、打包节点由宿主按节点类型执行，绑定产品工作区、run / attempt 和可信上游凭据；已有画布或冻结运行中的旧外部工具提示不会让这些节点再派发外部游戏插件会话。设计稿与规则生成仍使用现有模型会话；自动修复仅在固定 collector 内恢复原创标准源码，最多一轮，不是通用模型修复服务。

首期不承诺 Unity / Unreal 工程编辑或构建，不包括付费生图、视频、社交发布、微信小游戏上传和多人服务。目标是先稳定跑通“创建 → 修改 → 构建 → 预览 → 试玩证据 → 离线导出”。

## 2. 参考来源与吸收边界

以下状态基于 2026-11-19 更新后的本地仓库检查。来源仓库仅作为设计参考；本方案不表示已复制、移植或验证它们的实现。

| 来源 | 可借鉴机制 | 对工作台的处理 | 暂不吸收 |
| --- | --- | --- | --- |
| `dsh-game-studio` | 模板起步、工程清单、快速构建、预览、版本、资产槽、自动试玩、离线 HTML；新版本增加 MCP 多宿主入口和微信导出 | 采用其“先生成可玩基线”的产品目标和清晰工具边界；评估兼容既有 `game.json` / `game.js` 工程 | 不把插件宿主注册、会话扫描和右侧栏实现当成工作台架构；微信、分享、发布、生成服务另行评估 |
| `Claude-Code-Game-Studios` | 简报确认、游戏逐步成长、按项目配置严谨度、引擎适配、阶段技能、范围约束 | 把游戏 brief、约束、可选 rigor 和逐次迭代接入工作流；保持阶段产物可编辑、可追溯 | 不复制其 Claude 专属 Hooks、权限体系、命令和全部角色 / 技能库 |
| `novel-to-game` | 来源事实引用、创意方向比较、平台与运行时前置确认、设计与实现分离、盲测和端到端验证证据 | 对小说改编及其他有来源材料的游戏保留来源映射；游戏设计冻结后再实现；QA 记录证据和未评估项 | 不将小说全书分析、配音、互动电影或每个游戏都要运行的长流程设为通用前置 |
| `GameFactory-3A` | 多模态资产流水线、任务分工、引擎适配、资产交付与恢复思路 | 作为未来 3D / 资产生产后端的能力地图；将资产任务与游戏工程、来源和许可建立关联 | 不把云端模型、Blender、Unity、UE、音视频生成堆入 Web 原型首期；第三方资产和模型费用单独授权 |
| `ohmygame` | 本地优先创作工作区、实时预览、资产与代码并置、插件扩展、Agent 通过工具操作工作室 | 借鉴工作台一体化入口及稳定扩展点；Agent 接工作台工具服务和操作结果，不依赖自然语言声称成功 | 不复制完整桌面应用、账户 / 社区 / 多人后端、插件市场或通用媒体平台 |
| `dsh-drawai` | 原生画布文档、流程 / UI / 分镜表达、SVG / PNG 导出、AI 语义绘图和视觉素材整理 | 已以原创受限配方生成基本形状 `.drawai` 与 SVG 候选，并实测上游解析 / SVG 导出兼容；完整工作台画布后续评估 | 不运行上游完整插件、编辑器或纹理库，不把其 DSH 侧栏直接嵌入；PNG、视频 / 动效运行时另行排期 |
| `blender-skills` | Blender 建模、场景、动画、优化及 Unity / Unreal / Godot 导出流程的技能目录；通过 Blender MCP 实际执行 | 已实现原创固定 worker，调用本机 Blender 生成两类基本几何的 `.blend` / GLB / PNG 候选；保留后续技能映射接口 | 当前未接 Blender MCP，也未装入整套技能库；不支持任意 Python、外部工程、纹理、动画或任意 3D 游戏 |
| `any-audio` | Agent 可编辑的多轨音频项目、MIDI / 音色渲染、TTS、音效库、混音与波形时间线 | 已以原创过程合成生成单素材 WAV 与兼容工程，实测上游 schema / 混音 / WAV 导出；多轨编辑与其他 provider 后续评估 | 不运行完整 AnyAudio 插件或时间线，不下载 SoundFont / 音效包，不默认调用 TTS、在线源或上传音频 |

来源能力只转化为需求和接口设计。复用具体代码、模板、美术、文档或第三方依赖前，逐项检查许可证、作者声明、第三方通知和文件来源；保留所需归属，不以“参考”替代许可证义务。当前检查到 DSH Game Studio、Blender Skills、AnyAudio、DrawAI、NovelToGame、CCGS 为 MIT，GameFactory-3A 和 OhMyGame 为 Apache-2.0；分发依赖、模板、声音库、纹理和素材仍需单独审查。DrawAI 的上游说明指出部分纹理未逐项标注来源，未完成核验前不得默认纳入工作台发布包。优先自有实现与重写接口行为，未经清单审查不复制文件。

## 3. 用户与产品边界

使用者可以从一句想法或已批准的设计包创建浏览器小游戏，在工作台内检查、迭代和导出。Agent 可被委派修改，但所有输入、执行范围和返回证据都绑定明确工程和构建版本。

工程归属工作区和产品；可通过注册表引用用户指定的目录。默认新工程位于工作区约定的 `games/<slug>/`，不能通过任意相对路径或 symlink 写出允许范围。工程文件是内容真源，SQLite 只保存关联、运行和索引元数据。隐藏目录的发现依靠登记，不依赖递归扫描。

首期默认支持可离线运行的 HTML5 2D 模板；模板结构、运行时依赖和构建器必须固定版本并随工作台发布。Three.js / 3D 模板须经依赖体积、离线打包与许可证验收后单独纳入，不把其存在作为 MVP 假设。任意前端项目导入采用隔离的导入副本，不承诺通用框架兼容。

## 4. 核心用户流程

```text
想法或已批准设计
  →  brief 与约束（可编辑；按配置确认）
  → 新建工程与首个可玩构建
  → 预览与修改（每次修改进入工程工作副本）
  → 构建检查与版本快照
  → 自动输入冒烟 / 状态试玩（提供方可用时）
  → 按证据修订并重建
  → 导出自包含 HTML
  → 人工试玩与交付记录（模板要求时）
```

Brief 与人审门是否必需由具体模板决定，不在工具服务内硬编码。简短原型可以减少文档步骤；正式改编流程可要求来源映射、设计批准和人工试玩。自动检查不能声称主观趣味、平衡或人工试玩已验证。

## 5. 能力边界与工具契约

工作台工具服务按动作分层注册。当前 14 工具使用产品登记的工作区，不接收任意文件路径；工作流宿主适配器另绑定 `runId`、`attemptId` 和可信上游凭据，并写入操作 journal。capability 预检在创建副作用前报告缺失浏览器或被禁用工具；取消、超时、完成与结果未知进入运行状态 / 事件。直接工具调用、管理抽屉与工作流运行绑定是不同入口，不能把独立操作当作已获某个工作流 Attempt 的采用授权。自动化证据及尚未完成的真实环境验收见第 14 节。

| 能力 | 输入与效果 | 最低返回证据 |
| --- | --- | --- |
| `workbench_game_create` | 在产品登记的工作区创建唯一工程，从固定版本模板初始化 | 工程 ID / 相对路径、标题、模板版本、初始 buildId、HTML 字节数、输入与产物 hash |
| `workbench_game_build` | 对指定工程工作副本做校验与构建；只有输入变化才创建新构建 | projectId、buildId、输入指纹、产物 hash / bytes、构建状态、错误摘要 |
| `workbench_game_preview` | 核验指定 buildId，返回隔离预览与下载地址 | projectId、buildId、hash、previewUrl / artifactUrl / downloadUrl；不授予工程目录读写权限 |
| `workbench_game_playtest` | 对明确 buildId 在本机已有浏览器中执行真实输入与状态观察 | 被测 buildId、浏览器、finalPhase、错误 / 网络计数、截图 / 报告路径、未覆盖项 |
| `workbench_game_export` | 将明确 buildId 的已核验快照导出为自包含 HTML，不重建 | buildId、exportPath、bytes、hash；单文件封装标志与真实试玩的网络证据分别记录 |
| `workbench_game_history` | 列出 / 比较经核验的版本，读取当前 CAS 指纹或源码候选状态 | buildId、源码 / manifest hash、差异及当前状态 |
| `workbench_game_restore` | 以 `expectedCurrentHash` 恢复已核验版本，保留工作副本备份 | 前后指纹、backupPath、恢复构建；试玩重新为未评估 |
| `workbench_game_asset_list` | 列出候选或回读指定候选，校验原生文件与输出 | assetId、来源 / 许可、兼容范围、每文件 hash / bytes |
| `workbench_game_asset_generate` | 依受限 DrawAI / AnyAudio 配方生成原创素材候选，不自动采用 | 原生源、SVG / WAV、manifestHash、实际 hash / bytes |
| `workbench_game_asset_adopt` | 以 `expectedBuildId` 核对当前版本，将候选写入限定 slot 并构建 | 采用 assetId / hash、CAS 结果、新 buildId |
| `workbench_game_blender` | 本机 Blender 执行固定几何 worker，不能输入任意 Python 或路径 | 实际版本、job、`.blend` / GLB / PNG / 报告 hash 与几何核验 |
| `workbench_game_revision_propose` | 为指定当前 build 保存仅替换 `game.js` 的不可变候选 | candidateId、基准 / 候选源码 hash、修订原因 |
| `workbench_game_revision_verify` | CAS 试用一次候选，真实浏览器核验，通过采用，失败 / 取消回退 | 真实报告引用、accepted / rejected / conflict、恢复记录 |
| `workbench_game_revision_recover` | 显式对账死进程 / 未知 / 冲突候选，不重放未知执行 | 当前 CAS、候选状态与恢复结果；仍需重新试玩 |

工具须先校验工程登记和路径范围，再执行文件操作；绝不让模型直接指定任意输出路径。构建失败保留输入副本和上一成功版本，但不得把上一版本冒充本次构建。相同输入重复构建应能识别缓存 / 无变化，并清楚报告是否复用了既有产物。

## 6. 工程、构建与安全基线

- 工程 manifest 记录 schemaVersion、projectId、templateId / version、标题、方向、规则和文件清单；迁移采用显式版本号，未知格式只读，不覆盖。
- 工程源文件、导入资产、候选、采用资产、构建产物、试玩报告分开保存。构建从冻结的文件快照读取，产物与输入 hash 关联。
- 每次写入先产生可恢复的工作副本；修订冲突通过基准 hash 检测，冲突时输出新副本或要求处理，禁止静默覆盖。
- 预览使用 sandbox iframe 和严格 CSP；默认禁止网络、顶级导航和访问宿主。离线导出检查外部请求，无法证明离线时标失败 / 未评估。
- 试玩使用本地已安装浏览器或明确报告 provider 不可用；不自动下载浏览器。playtest 与构建必须绑定同一 buildId。
- 生成式媒体、发布、分享、上传、远程同步是独立授权能力，不能因存在工具或模板提示自动执行。
- 文件身份、路径大小写、Windows 分隔符、符号链接、清理和并发构建列为 P0 专项测试。

## 7. 与现有工作流的接入

`src/host/workflow-native-game.mjs` 提供原生能力适配器，`workflow-runner.mjs` 按节点类型接管 `game.create`、`game.playtest`、`game.revise`、`game.build`、`game.package`。原来的模板 ID、节点和连线保持可用；已保存画布 / 冻结图中残留的 `game_studio_*` 提示作为旧配置数据保留，不再作为这五类节点的派发指令。它们不需要安装外部 `dsh-game-studio`；玩法设计与规则生成仍需工作台现有模型会话能力。

运行前及执行节点前检查宿主 capability 与工具策略。浏览器不可用时明确停止，不下载浏览器，也不伪造试玩结果。宿主使用实际产品归属及原生操作 journal 取可信上游，拒绝混用外部插件或手填的历史项目证据；成功结果经现有校验 / 采用机制提交给工作流内核。模型文字不是工具成功凭证。

原生操作采用 Attempt 级 journal，并提供取消、重启后结果未知及显式放弃入口。结果未知不会自动重放文件副作用；用户须先核对并显式放弃后再重试。旧运行如已有在途外部游戏会话或已采用外部项目证据，需先放弃旧会话结果，必要时从创建节点重跑；不能将旧来源改名成原生证据。原模板新运行、旧冻结提示接管及完整导出已通过自动集成验证；实际桌面中用户已有运行的续跑留给联合测试。

本模块复用工作流的运行、尝试、快照、人工确认、权限和恢复机制，不另建 Agent runtime、会话库或任务队列。游戏核心可在关闭工作流时独立用于创建、打开和导出已登记工程。

## 8. 分期与验收

| 阶段 | 交付 | 阶段出口 |
| --- | --- | --- |
| GS0 契约与来源复核 | 固定格式、工具 schema、目录 / 权限模型、依赖与许可证清单、UI 嵌入 / 预览 Spike | 在当前工作台仓库中可重复创建并打包最小 HTML；无写越界；决策记录通过审阅 |
| GS1 最小工程核心 | 工程登记、单一 2D 模板、create / build、内容 hash、版本快照、失败恢复 | 运行两次创建得到不同工程；同工程构建返回真实 buildId 和 bytes；损坏 / 非法路径拒绝且已有工程不变 |
| GS2 预览与离线导出 | 隔离预览、buildId 绑定、单文件 HTML 导出、结果回读 | 桌面 / 手机 viewport 可运行；导出离线打开；外部请求检测通过；编辑旧版本不会改变当前版本 |
| GS3 工作流宿主能力 | capability manifest、create / build / export 节点映射、运行事件和取消 | 不安装 DSH Game Studio 插件即可走通批准输入到导出；缺工具在副作用前停止；失败无假产物 |
| GS4 自动试玩与迭代 | Playwright 或已验证浏览器适配、脚本 / 状态接口、截图和报告 | build / playtest ID 一致；错误、未覆盖、浏览器不可用均明确；自动试玩不冒充真人试玩 |
| GS5 游戏成长与 2D 资产 | 可调参数、资产候选与许可记录、版本比较 / 回退；先接手工素材和已验收的静态素材处理 | 无生图或媒体后端仍可完成基础流程；采用可追溯、可回退；依赖按需加载 |
| GS6 设计画布（DrawAI） | 评估并适配原生画布文档、工作台内编辑、SVG / PNG 导出与游戏素材候选桥 | 文件格式往返、保存冲突、Shadow DOM、快捷键、导出来源 / 许可通过验收；不要求视频运行时 |
| GS7 3D 制作（Blender Skills） | Blender / Blender MCP 探测与授权、最小技能映射、后台任务取消 / 恢复、模型与动画导出及引擎中立资产登记 | Blender 未安装或未启动时 Web 核心不受影响；路径 / 进程范围受限；导出格式、贴图、比例、面数和许可检查通过 |
| GS8 音频制作（AnyAudio） | 音频工程与时间线数据契约、试听 / 渲染服务、分轨 / 混音导出、游戏资产关联；TTS 与在线源作为可选 provider | 无音频依赖时 Web 核心仍可用；SoundFont / 音效来源可追溯；模型 / 服务费用与上传行为须显式授权；取消任务不损坏项目 |
| GS9 引擎 / 发布扩展 | 依据用户需求独立评估 Unity、Godot、微信导出、分享或发布 | 每个目标平台单独立项、授权、运行环境、体积和真实设备验收，不由 Web MVP 自动推导兼容 |

完成 GS3 后即可解除当前工作流对外部游戏插件工具提供方的必要依赖；完成 GS1/GS2 不等于已完成自动试玩或人工交付闭环。

GS6–GS8 是可选创作模块，可按需求并行细化，但各自不反向阻塞 Web 工坊核心。当前只落地其受限子集，不据此将完整阶段标为完成。DrawAI、Blender、AnyAudio 原生工程分别保存；采用到游戏的有限 SVG / PNG / WAV 字节按 slot 内嵌到 manifest，以生成单文件 HTML，原生工程不塞入游戏配置。跨模块通过有版本的文件 / 资产契约传递产物。

## 9. 当前与目标架构

建议职责边界（实现路径按当前代码复核后确定）：

- Host game service：项目登记、路径校验、工程操作、构建队列 / 互斥、快照与能力注册。
- Shared contracts：manifest schema、工具输入输出、构建 / 试玩 / 导出证据、版本迁移。
- Client game module：工程列表、创建 / 导入、源文件与配置查看、预览、构建状态、历史和错误；不复制工作流运行 UI。
- Template/runtime package：固定模板、游戏运行时、构建脚本、CSP 与资源，按需加载。
- Workflow adapter：把节点尝试变成受限 host 操作，再把经过校验的证据提交给工作流。
- Optional creative adapters：DrawAI、Blender 和 AnyAudio 各自提供能力探测、项目 / 任务生命周期、取消、来源信息和标准导出资产；模块不可用时只禁用对应步骤。

不向大型 `lib/index.js`、`lib/client.js` 或现有 `app.ts` 持续堆入整套模块。模块拆分和前端挂载遵循仓库现有 host/client 分层与 Shadow DOM 约束。

## 10. 风险与未决事项

- 五类游戏操作节点已由原生 Host 适配，设计生成仍走现有会话；新旧冻结提示、取消与结果未知已有自动化回归，仍不能据此宣称真实桌面闭环已验收。
- Game Studio 上游最新版本已加入独立 MCP 服务和多宿主安装脚本，后续如保留作为兼容 provider，需确保与原生 provider 不重复注册或双执行。
- 外部仓库更新只证明本地分支已快进，不等同于其最新实现已在工作台兼容或验收。
- 需要确认工作台 Node 版本、打包目标、可用浏览器自动化依赖与本地服务生命周期；不因参考仓库的依赖声明推断本工作台环境已具备。
- 本机 Blender 5.3.0 的固定 worker 已实测；这不表示 Blender MCP、全部 Blender Skills、任意文件 / Python 或引擎导入已接通。技能安装不能替代运行时、权限确认和逐项导出验收。
- AnyAudio 项目可引用外部音色库与音效包，且 TTS provider 的成本、网络和隐私属性不同；素材来源 / 许可、下载体积、密钥管理和费用授权必须分开处理。
- DrawAI 的 `.drawio` / `.drawai` 与媒体目录需要保留原生保存和迁移语义；其最新包内第三方纹理存在未逐项列明来源的情况，须先完成来源核验。
- 现有旧评估记录的是 2026-11-10 前版本；本次上游已更新，开始 GS0 时重新检查源码和许可证，不能把旧路径和风险描述直接当成当前状态。
- 当前 `bytes` 表示快照 `index.html` 的实际 UTF-8 字节数，`hash` 为该文件的 SHA-256；后续导出 bytes 单独对应导出文件。
- 当前由 Agent 形成设计候选、人工批准后 Host 创建固定 collector 工程；已实现受限本地素材、源码候选核验与标准源码恢复。自定义机制、任意资产生成、复杂关卡和模型自动修复仍须另行实现及验收。

## 11. 来源版本

本方案基于以下仓库在 2026-11-19 同步后的当前分支状态：

| 仓库 | 分支 | HEAD |
| --- | --- | --- |
| `dsh-game-studio` | `main` | `02d7f26` |
| `GameFactory-3A` | `main` | `f9e927c` |
| `novel-to-game` | `main` | `ea07fe2` |
| `ohmygame` | `main` | `35648c4e` |
| `blender-skills` | `main` | `904f095` |
| `any-audio` | `main` | `230c547` |
| `dsh-drawai` | `master` | `3c5b88e` |
| `Claude-Code-Game-Studios` | `main` | `abc0de7` |

其他 `D:\AI\AI-Game` 仓库也已更新，完整清单见本次任务结果和本地 Git 历史。来源内容按参考资料处理；当前文档记录的是拟采取的产品决策，不声称来源项目验证了工作台实现。

## 12. 首批实现与验证（2026-11-19，历史批次）

本节记录最初只有 create / build 时的实现及已运行证据；下述“尚未接入”及“下一批”均为该批次状态。后续接线见第 13 节，当前版本 / 创作桥见第 14 节；旧测试结果不能自动覆盖新增代码。

### 12.1 已实现的独立核心

- `src/host/native-game-studio.mjs`：工程登记、固定模板创建、构建、输入校验、内容寻址快照、缓存完整性校验与构建锁。
- `src/host/native-game-template.mjs`：原创 `canvas-collector` v1，无第三方代码、素材、CDN 或安装步骤。支持横 / 竖屏、键盘 / 触屏移动、收集、碰撞扣血、计时胜负和重开，默认 15 秒 / 3 颗心。
- `src/host/native-game-tools.ts`：向宿主注册两个 `workbench_game_*` 工具，通过 `productId` 查询已有产品工作区；schema 不接收工作区路径。构建还核对工程登记的 productId，两个产品即使共用目录也不能通过工具互相构建工程。
- `src/shared/tool-policy.ts`：两个工具归入 `write.local`，沿用现有注册守卫和执行策略；这属于工具开关 / 档位控制，不等同于 GS3 的运行级授权。

当前格式如下；所有返回路径均相对产品工作区，分隔符为 `/`：

```text
games/<slug>/
  game.json                         # schemaVersion 1，工程身份、模板版本与规则
  game.js                           # 可编辑工作副本，最大 1 MiB
  dist/index.html                   # 最新成功构建的便利副本
  .studio/project.json              # schemaVersion 1，projectId / productId 登记
  .studio/latest.json               # 最新成功构建凭据
  .studio/build.lock                # 构建期间的独占锁
  .studio/builds/<buildId>/
    game.json / game.js             # 该版本的冻结输入
    index.html / build.json         # 产物与构建凭据
```

`buildId` 为完整 `inputHash` 的前 12 位十六进制字符；完整指纹包括构建器版本、manifest 原文、源码和输出 HTML。`hash` 对应输出 HTML，`bytes` 对应该文件字节数。同输入构建逐项核对旧快照后返回 `reused:true`，快照损坏或短 ID 冲突时拒绝覆盖。返回的 `artifact` 指向版本快照，不指向可变 `dist`。创建生成新的工程 UUID，因此不同工程的构建身份也不同。

构建仅使用 `vm.Script` 解析 JavaScript 语法，不在宿主执行源码或执行包脚本。构建拒绝可破坏内联脚本边界的 HTML 分隔符；模板 CSP 默认禁止联网。应用层拒绝越界 slug、Windows 保留名称、目录链接、符号链接及硬链接文件；这些检查不是针对同权限恶意进程的 OS 沙箱。工作区由已有产品配置授权，构建服务不会额外将工作区限制为工作台自身仓库。

解析 / 校验失败保留工作副本和上一成功产物，不返回伪造成功。普通失败释放锁并清理本次临时目录。进程被终止后的旧锁、遗留临时目录、快照保留 / 磁盘配额及跨文件断电一致性仍待恢复方案；不得未核实运行状态就自动删除锁重试。当前 `dist` 和 `latest.json` 分别原子替换，不承诺二者跨文件事务；版本快照为核验依据。

### 12.2 调用与本地验证

宿主加载新版后，独立工具调用示例（将产品 ID 替换为已配置工作区的实际产品）：

```json
{"tool":"workbench_game_create","arguments":{"productId":"<实际产品ID>","slug":"star-catcher","title":"星光采集","rules":{"durationSeconds":15,"hearts":3}}}
```

修改工程工作副本 `game.js` 或合法的 `game.json` 后，调用 `workbench_game_build`，参数为同一 `productId`、`slug`。现阶段没有源码编辑专用工具或 UI；示例中的占位 ID 不是可直接执行的真实产品。工具返回 `ok:true` 以及实际 `projectId`、`buildId`、`artifact`、`bytes`、`hash`、`inputHash`、`reused`。`previewAvailable:false`、`playtestStatus:"not_assessed"` 明确表示尚无宿主预览或该次构建的试玩验收。

```powershell
pnpm run bundle
npm run verify:game-studio
node scripts/verify-agent-tools.mjs
node scripts/verify-workflow-v1-host.mjs
node scripts/verify-workflow-game.mjs
npm run verify
```

以上本轮均通过；`verify` 已纳入原生核心专项。工具注册 13/13、V1 宿主集成 54 个 HTTP 响应及新增真实游戏工具断言通过；完整 `verify` 的既有打包检查 129/129、新闻 87/87、资产服务 37/37、工具策略 70/70、基础工作流 26 项通过。资产服务真实进程测试在沙箱内被 `spawn EPERM` 阻止，在授权的沙箱外重跑通过。

浏览器检查为可选开发专项，不向生产包增加 Playwright 依赖，也不下载浏览器：

```powershell
# 已安装本地 Playwright 和 Edge 时可直接运行；否则指定已有包与浏览器。
$env:NATIVE_GAME_PLAYWRIGHT = '<本机已有 playwright 包的绝对目录>'
$env:NATIVE_GAME_EVIDENCE_DIR = '<可写的截图及报告目录>'
npm run verify:game-studio:browser
```

可用 `NATIVE_GAME_BROWSER` 指定已有浏览器可执行文件。本轮使用打包后的 `lib/index.js` 创建真实文件，并用已安装 Edge 157.0.4341.60 打开：390×844 竖屏验证键盘、触屏、收集、碰撞、失败、重开；960×540 横屏验证计时获胜与页面适配。页面错误、console error、外部 HTTP 请求均为零。测试生成 `portrait-playing.png`、`landscape-won.png`、`report.json`，测试工程结束后清理；设置独立证据目录可保留截图和报告。未指定时证据随临时目录一起清理。

这是固定模板的浏览器冒烟，未验收通用 Agent 生成代码、DSH 真窗口、人工趣味与平衡、内嵌预览隔离或工作流全链；也不把专项脚本当作已实现 `workbench_game_playtest`。

### 12.3 下一批与回退边界

下一批优先 GS2：受限预览路由 / iframe、指定 buildId 的导出与文件回读；随后 GS3 实现 capability 预检、运行 / 尝试绑定、幂等调用记录及节点适配，再重跑不安装外部游戏插件的真实工作流。现有外部闭环不在本批切换，避免缺少原生试玩 / 导出时返回半套证据。

本批不迁移生产数据库，不安装外部插件或生成服务，不重启 DSH，不提交 / 推送。回退只需移除原生工具注册、策略目录条目及新增模块后重建；保留已有用户工程和版本目录，不以回退为由清理作品。DrawAI、Blender Skills、AnyAudio 仍按 GS6–GS8 独立规划，未在本批接通。

## 13. 原模板原生接线续批（自动集成验证通过）

本节保留五工具接线批次的范围和收据；其中“未接通”及“无需修改核对”是当时状态，当前扩展与仍待验收项见第 14 节。

### 13.1 已落地的实现范围

- 五工具由 `native-game-tools.ts` 注册，并接现有工具策略。创建 / 构建返回真实凭据与版本链接，preview / export / playtest 要求实际 `productId`、`slug`、`buildId`。
- `native-game-http.ts` 按产品登记校验指定版本，提供 `/game-studio/preview`、`artifact`、`download` 及 capabilities；只读 GET 不接受文件路径。预览页的 iframe 仅允许脚本，产物响应另带 CSP sandbox、禁网络 / 表单 / 外框等限制；下载内容也是核验过的同一构建，不指向可变 `dist`。真实 Edge 已验证游戏 iframe 访问父页面 DOM 被拒绝。
- `native-game-studio.mjs` 新增已核验历史版本读取、精确版本导出和试玩报告 / PNG 存储。导出文件位于工程 `exports/<buildId>.html`，不重新构建；重复导出只核对同内容，冲突不覆盖。工作副本变化不会改写已有快照或导出。
- `native-game-playtest.mjs` 只探测已安装 Playwright / Playwright Core 与本机浏览器；使用真实浏览器输入与只读状态钩子观察，记录终局、错误、网络尝试、截图和未覆盖项，不在宿主执行游戏源码。缺 provider 明确报错；不安装包、不下载浏览器，不替换工程实际规则以缩短或绕过测试。
- `workflow-native-game.mjs` 与 runner 以当前产品 / workspace、run / Attempt、可信原生 journal 接五类操作节点；旧冻结提示无需手工重写。已有外部游戏会话结果不自动采用为原生来源。预览 / 下载链接及结果未知的显式放弃入口接在原运行视图。

### 13.2 固定模板与交付边界

本批只实现 collector 合同：左右移动、收集计分、障碍扣血、计时胜负、重开以及明确的时长 / 生命参数。它不能把任意 GDD 自动实现为任意类型游戏；不支持的玩法不能由自动试玩成功反推已实现。

创建前，已批准的规则 JSON 必须显式包含 `nativeTemplate:"canvas-collector@1"`、整数 `durationSeconds`（3–60）和整数 `hearts`（1–9）。缺少字段、模板不匹配或数值越界时暂停，且不创建工程；不再以节点默认值代替批准参数。新建与旧冻结运行的 `game.rules` 生成都会收到宿主补充的实现范围提示：只有需求符合完整 collector 合同时才输出该标记，否则标记不支持并在 `openQuestions` 说明。

旧画布可以继续保留。若以前已经批准的规则缺少这三个字段，应回到玩法审核，必要时重跑规则 / 审核节点，在规则对象中明确补齐并重新批准，再从创建节点继续；无需另建画布，不直接修改已采用快照或略过人审。通用规则文档通过原 schema 校验，也不等于获准创建原生 collector。

`game.revise` 当前是“无须改动”的证据核对：只有真实试玩通过，且工作副本仍与被测构建一致时，记录 `changes:[]` 及原因。修订核对与最终导出都会调用受限 `readPlaytest`，回读实际报告，核对 `reportHash`、报告中的产品 / 工程 / buildId / 产物 hash，以及 `screenshotHashes` 对应的 PNG 文件；报告或截图缺失 / 损坏时停止。随后以 `buildCurrent` 再确认工作副本仍等于被测快照。发现脚本、网络或终局问题时停止等待修复，不自动改代码，不通过削弱碰撞或胜负规则制造通过。

`offline:true` 表示已按固定模板 / CSP 封装自包含 HTML，不代表静态导出服务证明了任意脚本永不尝试联网。工作流最终导出另以同一版本真实试玩的错误 / 网络证据为门槛；手工打开导出文件的设备表现、失败 / 重开及真人玩法体验仍须人工检查。最终人工交付待办保持未通过，只有真实测试者填写验收记录并确认后才可完成。

### 13.3 新增验证登记（2026-11-19）

以下结果来自本批源码与重新打包后的实际执行。合成适配器、真实游戏及尚未进行的人工验收分别记录：

| 检查入口 | 本批应覆盖 | 当前证据状态 |
| --- | --- | --- |
| `verify-native-game-studio.mjs` | 指定历史版本读取、快照完整性、不可变导出、证据文件存储及非法输入 | 通过；还覆盖报告 / PNG 篡改与损坏工作副本 |
| `verify-native-game-http.mjs` | 产品与版本范围、隔离响应 / iframe、下载 bytes / hash、非法路径与历史版本 | 19 个真实 loopback HTTP 响应通过 |
| `verify-native-game-runner.mjs` | Host 派发、并发继续、伪造证据拒绝、取消 / 重启未知及显式放弃 | 合成适配器专项通过，无浏览器 / 模型声明 |
| `verify-native-game-adapter.mjs` | 批准合同 / 参数门、无副作用拒绝、停用节点预检、报告 / PNG hash 门 | 通过；试玩输入明确为合成证据 |
| `verify-native-game-playtest.mjs` | 真实输入、采星获胜、JS 错误、联网尝试、provider 缺失、并发、取消、旧版拒绝、恢复 | 本机 Edge 157.0.4341.60 通过；联网反例 loopback 收到 0 请求 |
| `verify-native-game-workflow.mjs` | 原 14 节点模板、旧冻结提示、真实创建 / 两轮试玩 / 构建 / 导出、最终人工门 | 通过；6 个宿主操作完成，人工待办仍为未通过 |
| bundle、`npm run verify`、工具 / V1 HTTP / 原模板 / 节点分组专项 | 重新打包、已有功能与新原生专项 | 全部通过；打包 129/129、新闻 87/87、资产 37/37、策略 73/73、基础工作流 26；另工具 16/16、V1 HTTP 54 |

原模板真实集成最后一轮：runId=`run-mwnlp85c-yho7n`，最终 buildId=`e0220469ea2b`，HTML 实际 6099 bytes，SHA-256=`e59751733f3c3fff52f1d9ea1be5321fabf4ded9c853888b983b40e3ff581f74`。原型与最终版各按实际 15 秒 / 3 心规则运行至 won，错误 0、网络尝试 0；未修改源码的修订合法复用同一 buildId。下载、导出、被测快照逐字节一致，隔离预览的父页面访问被拒绝。GDD / 规则由测试夹具提交，并非真实模型设计会话；最终人工验收未填写通过。

本机保留证据目录：`C:\Users\gh\.codex\visualizations\2026\11\19\01a1f2de-16f7-75d1-93ff-9d7ff40f8b55\native-game-studio-complete`，含 `workflow-report.json`、`native-workflow-preview.png` 和实际导出的 `star-catcher.html`。构建 ID 含工程身份，不同新工程即使 HTML 相同也可能不同；以上仅是本次测试收据。沙箱内浏览器 / 子进程曾报 `spawn EPERM`，真实进程测试在授权的沙箱外完成。严格 TS 检查覆盖新原生工具 / HTTP / 链接模块，不据此声称整个仓库已通过独立严格类型检查。

浏览器试玩用截获的虚拟 URL 提供精确快照，响应强制不透明 CSP sandbox；只允许一次初始导航，其他请求中止，弹窗 / 下载 / 后续导航拒绝。单服务最多一个试玩，取消会等待晚到的浏览器启动清理；错误 / 请求详情最多各 100 条，计数保留总数。生产环境缺包、浏览器或执行权限时明确失败，不把能力探测当作实测通过。

复测命令：`npm run verify:game-studio`（不启动浏览器）、`npm run verify:game-studio:playtest`（生产浏览器反例）、`npm run verify:game-studio:workflow`（原模板真实全链）。联合测试前重载更新后的 DSH 宿主并刷新工作台，保留原画布；按 13.2 补齐旧批准合同，从创建继续 / 重跑，核对每步版本和预览链接，最终由真实测试者打开离线 HTML 完成一局与重开再填写人工待办。

生产试玩 provider 可通过 `DSH_GAME_PLAYWRIGHT_PATH` 指向已有 Playwright 包，以 `DSH_GAME_BROWSER_EXECUTABLE` 指向已有浏览器程序；这些与第 12 节旧模板冒烟脚本的 `NATIVE_GAME_*` 变量分开。不要以 provider 探测成功代替实际浏览器启动 / 试玩成功。

本批仍未完成 DSH 真窗口、真实模型设计会话与人工交付联合验收。崩溃后文件构建锁 / 临时目录清理、快照保留与磁盘配额仍按 GS1-03 处理；Attempt journal 的结果未知保护不能替代这些文件恢复能力。DrawAI、Blender Skills、AnyAudio 保持 GS6–GS8 规划状态，未接通。

## 14. 版本、素材、修订与创作桥续批（2026-11-19）

本节为当前实现范围。新增模块使用原创本地实现，不要求安装 `dsh-game-studio`、DrawAI、AnyAudio 或 Blender MCP 插件。DrawAI / AnyAudio 的本地上游仓库只在可选兼容测试中使用，不成为生产依赖。Blender 步骤另需实际安装的可执行程序；缺失时明确失败，不下载或伪造产物。

### 14.1 版本事务、恢复与存储边界

`native-game-studio.mjs` 提供 `currentState`、版本列表 / 比较及 CAS `updateProject` / `restoreBuild`。当前指纹覆盖 manifest 原文与 `game.js`；受控更新持同一构建锁，先校验、预构建并保存原字节备份，再更新工作副本和发布构建。资产采用只允许改变 `assets`，源码候选只替换 `game.js`；标题、规则、方向及其他批准配置不能借资产采用修改。恢复要求 `expectedCurrentHash`，冲突拒写；恢复 / 更新失败时只回退本次仍拥有的字节，检测外部编辑时停止并保留冲突信息，不覆盖别人的改动。

构建锁记录 token / PID，只有确认旧 owner 已退出时才能经独占 recovery claim 回收；未知格式、活进程或遗留 recovery claim 保持失败关闭。普通失败清理本次临时目录；未知历史 pending 不被批量删除。版本快照与备份可回读，不承诺跨文件断电事务，也不把应用层互斥视为同权限恶意进程的 OS 沙箱。

| 对象 | 当前默认限额 | 达限 / 异常行为 |
| --- | --- | --- |
| 构建快照 | 100 个、合计 256 MiB | 拒绝新增，不清历史；同内容须先核验后复用 |
| 试玩记录 | 100 个、合计 256 MiB | 保留既有报告，拒绝新记录 |
| 恢复 / 更新备份 | 100 个、合计 128 MiB | 在修改工作副本前拒绝；备份保存原字节 |
| 源码候选 | 64 个，每份候选与基准源码各不超过 1 MiB | 拒绝新增；每候选最多核验一次 |
| 素材候选 | 128 个、合计 256 MiB | 写前核验已有候选并计入 manifest / 全部原生文件；未知文件、遗留 pending 或未知锁拒写 |
| 单份素材候选 | 合计 32 MiB；原生单文件 16 MiB | 超限拒收，已存候选不被修补覆盖 |
| 游戏运行时素材 | 本服务每 slot 256 KiB，四槽合计 1 MiB | 只允许 player / pickup 图片与 pickupSound / hitSound 音效；选中输出内嵌离线 HTML |
| Blender job | 32 个、合计 256 MiB，下一任务预留 34 MiB | 保留 job / journal，拒绝超限；未知 owner 不自动重跑 |

核心格式校验另允许单素材 1 MiB、全部嵌入 2 MiB、manifest 4 MiB、HTML 6 MiB；当前素材服务采用上表更窄限制。配额拒绝不等于提供了自动保留 / 清理 UI。精确磁盘故障、强制断电及人工清理策略仍需继续验收，GS1-03 不整体打勾。

### 14.2 源码候选与最多一轮标准修复

`native-game-revisions.mjs` 在 `.studio/revisions/<candidateId>/` 保存提案、基准源码、候选源码及状态。提出候选不修改工程；核验时以基准 CAS 试用并构建，在真实本机浏览器中运行，回读报告与截图后才决定采用。失败 / 取消回退到原基准，失败报告和候选保留；外部编辑导致的冲突停止自动回退。崩溃或未知状态通过 `revision_recover` 显式对账，不重放未知浏览器执行；恢复后仍须重新试玩。

提案同时核对指定构建与当前源码 / manifest 指纹，拒绝两次读取之间的外部变更。恢复使用独占 guard，失败 CAS 不改 journal 或消费旧锁；中断的 guard 保持失败关闭，需人工核对。失败 / 取消回退复用已核验的原快照与备份，不另占构建或备份配额；构建和备份配额已满的回归通过。

工作流 `game.playtest` 可在当前版本失败时尝试一次 `native-template-repair`：仅恢复随工作台发布的原创 `canvas-collector@1` 标准 `game.js`，保持已批准规则、方向与采用素材不变，再执行真实试玩。`maxRepairs:0` 可关闭；当前没有循环增量修复。标准源码本身未变化时不制造修复候选；仍失败则节点不能以通过继续。`game.revise` 回读实际证据并记录已采用的标准修复或无须修改原因。

手工 / Agent 提交完整源码候选是另一入口，不代表已实现自动调用模型改代码。候选浏览器通过也只证明当前固定观察项，不能推导任意玩法正确、趣味 / 平衡合格或规则可被削弱。

### 14.3 原创 DrawAI / AnyAudio 受限格式桥

`native-game-assets.mjs` 在 `.studio/assets/<16位内容ID>/` 保存不可变 manifest、原生源与实际 SVG / WAV。receipt 包含完整候选 hash、manifestHash、逐文件 hash / bytes、提供方、来源 / 许可、兼容范围和警告；读取与采用重新核验原生文件、输出、额外文件及链接。生成只得到 `status:candidate`；显式采用须核对 `expectedBuildId` 与当前快照，再以核心 CAS 事务构建新版本。之前的构建和候选保持不变。

- DrawAI：原创 ellipse / rect / diamond 基本形状配方，宽高 16–256，限定十六进制颜色及短标签，生成单页 `.drawai` 与无外链 SVG。SVG 标为 `approximate`；拒绝脚本、事件、实体和外部资源。不包含完整画布、保存 / 迁移编辑器、纹理、PNG rasterizer、AI 绘图或动效能力。
- AnyAudio：原创 bell / impact / coin / hit / sine / noise / whoosh 配方，0.05–1.2 秒，受限采样率 / 频率 / 增益 / seed，输出实际双声道 PCM16 WAV，并保留 `.anyaudio/projects/<id>/project.json`、材料索引和参数源。原生时间戳使用确定性的 source epoch，不冒充生成时间。没有多轨时间线 UI、MIDI / SoundFont、TTS、在线库或 MP3 / MP4 能力。
- 原创候选记录 `implementation:original-workbench-adapter`、`license:MIT` 与 `upstreamPluginExecuted:false`；不把“格式兼容”表述成执行了完整上游插件，亦不把上游第三方纹理 / 音色的许可带入原创候选。

兼容验证已实际运行：本地上游 DrawAI `parseCanvas` 读取本服务生成文件，`buildExportSvg` 导出测试 SVG 703 bytes；上游 AnyAudio `validateProject` / `validateMaterial` 接受生成工程，`renderProject` 真实混音，再由 `exportProject` 输出 24 kHz、双声道、6000 帧、24044 bytes 的 WAV，原候选 hash 不变。该数字是兼容夹具收据，不是最终游戏包体积。专项可通过 `DSH_GAME_REFERENCE_ROOT` 指定本地参考目录；无参考仓库时明确 SKIP，生产模块不加载 sibling 代码。

### 14.4 真实 Blender 固定 worker 子集

`native-game-blender.mjs` 探测本机程序，使用原创固定后台 Python worker；输入仅 crate / pickup、size 0.1–4 和颜色，不能传入任意 Python、路径、外部工程或包安装命令。单个自有进程执行受限 recipe，保留 job / journal，输出真实 `.blend`、GLB、128×128 RGBA8 透明 PNG 和报告。PNG 是当前 2D 游戏的运行时 sprite；原生模型文件作为候选来源保留，不意味着游戏新增 3D 渲染器。

本机 Blender 5.3.0 已实际生成两类几何，回读输出字节和报告 hash；专项还重新打开真实 `.blend`、在 Blender 中导入真实 GLB，校验三角面数、顶点 / 索引、尺寸和无外部 URI。固定输出限制为 10000 三角面以内、受限尺寸、无动画 / 骨骼 / 外部纹理。已测实际 worker 取消 / 超时、缺失 provider、忙锁、未知 owner 与输出损坏；取消 / 超时任务不能成为成功候选。确认退出前不释放进程槽，不清除未知 owner 的执行 claim。

可用 `DSH_GAME_BLENDER_EXECUTABLE` 指定已有可执行文件；当前默认任务超时 120 秒。此实现未接 Blender MCP，没有载入全部 Blender Skills，也不承诺任意建模、材质、动画、引擎导入或完整 GS7。Blender 可执行文件的许可证与发布义务独立于原创 worker / 生成素材；工作台不把 Blender 二进制打入插件包。

### 14.5 原画布的管理入口与显式素材包

原运行结果卡片新增 `NativeGamePanel` 管理抽屉，复用同一产品 / 工程身份，可读取版本、比较 / 恢复、生成并试听 / 预览素材候选、显式采用、提交源码候选、真实核验与显式恢复。`native-game-management.ts` 接现有工具策略，POST 限同源 JSON；浏览器不能传入工作区或任意路径。它不是完整 DrawAI / Blender / AnyAudio 编辑器，也不自动改写已有工作流 Attempt 的证据。管理操作后需要重新试玩，并从原画布相应节点重跑。

原 14 节点模板及连线无需扩充。只有已批准规则显式含 `creativePack:"local-original-v1"` 时，创建节点才生成并采用两个 DrawAI SVG（pickup / player）和两个 AnyAudio WAV（pickupSound / hitSound）；缺省或 `none` 继续使用模板基线。该包不隐式生成 Blender 素材，不访问付费 / 网络 provider。若旧规则未含该项，需回原玩法审核编辑并重新批准，不能在创建阶段绕过已采用规则开启。受限 Blender 生成另由独立工具或抽屉显式操作；可用性探测与生成分别记录。

### 14.6 本轮证据与未通过门槛

| 检查入口 | 本轮覆盖与结果 |
| --- | --- |
| `verify-native-game-history.mjs` | 版本回读 / 比较、CAS 恢复、备份、配额、死锁恢复及失败保护专项，通过 |
| `verify-native-game-assets.mjs` | 真实原生 / SVG / WAV、不可变字节、上游实际兼容、采用 CAS、PNG 验证、配额 / pending / 链接 / 篡改拒绝，通过 |
| `verify-native-game-blender.mjs` | Blender 5.3.0 实际生成、`.blend` 重开 / GLB 导入、输出 / 几何回读、worker 取消 / 超时与失败拒收，通过 |
| `verify-native-game-revisions.mjs --browser` | 源码候选实际浏览器通过 / 失败、采用 / 回退、标准源码恢复及冲突 / 恢复专项，通过 |
| `verify-native-game-management.mjs` | 24 次真实 HTTP，管理路由、产品 / 方法 / 同源与策略边界，通过；不代替桌面抽屉操作验收 |
| `verify-native-game-panel.mjs` | 组件触发 76 次真实管理请求，版本 / 素材 / 源码候选与过期响应拒绝，通过；非实际 DOM / 桌面验收 |
| `verify-native-game-tool-cancellation.mjs` | 14 工具保留真实注册守卫，接入 DSH `execute(args, exec)` 的可信取消信号；预取消无副作用，异步生命周期测试替身确认浏览器 / Blender / 修订收到同一信号，通过 |
| `verify-native-game-workflow.mjs --creative` | 原 14 节点及旧冻结提示，显式四素材包、两轮真实试玩、构建 / 指定版本导出与隔离，通过；最终人工门保持未通过 |
| `verify-native-game-creative-browser.mjs` | DrawAI / AnyAudio 与真实 Blender PNG 合并采用，真实浏览器加载 / 绘制 / 解码、额外碰撞失败 / hit 音源启动及重开，通过 |
| 完整 `npm run verify`、extensions、工具注册 / V1 Host / 节点分组 | 本轮完整回归及扩展专项通过；14 原生工具注册纳入工具专项 25/25，V1 Host 54 次 HTTP；不据专项宣称整个仓库独立严格 TS 或真实模型验收 |

证据目录：`C:\Users\gh\.codex\visualizations\2026\11\19\01a1f2de-16f7-75d1-93ff-9d7ff40f8b55\native-game-studio-extended`。`workflow-report.json` 对应原模板显式素材包，`creative-report.json` 对应包括真实 Blender sprite 的组合专项；两者不是同一个工程 / 构建。最终收据如下，仍以该目录 report 与保留文件逐字节回读为准，不要把第 13 节历史收据当作本轮结果。

| 证据 | 构建 / 字节数 | SHA-256 / 观察 |
| --- | --- | --- |
| 原 14 节点 `workflow-report.json`，runId=`run-mwnpncdn-ne7tu` | `6283823b7d45`，60506 bytes；`star-catcher.html` | `e4940a63f66527f014eb0e84ba866b462e60c4381d44e2c4a0791c498ce7ce6c`；won、错误 / 请求 0，player / pickup 绘制 2169 / 4401 次，pickupSound 17 次 |
| Blender 混合 `creative-report.json` | `45f199770f57`，86345 bytes；`creative-catcher.html` | `b889da8a302593d461ad8a8bef91c92d050f585a2b4f685cc54f977219322fc7`；player / pickup 绘制 878 / 1715 次，pickupSound 6 次，额外 offlineLoss / offlineHitAudioSourceStarted / restartResetsState 均为 true |

自动获胜路径记录 sprite 加载 / 绘制、WAV 解码及采集音源启动；避障不等于撞击音效已播放，组合专项另有碰撞触发 `hitSound` 的 SourceStarted 证据。音频解码 / SourceStarted 不是人工听感或系统实际扬声器出声验收。固定状态钩子只支持当前模板观察，不能证明任意候选源码正确。

本轮面板、管理路由和工具注册文件的定向严格 TypeScript 检查通过。直接工具调用、HTTP 断连及工作流分别转接宿主取消信号；同步原子文件事务的取消边界在进入事务前，异步浏览器 / Blender 执行另有实际取消专项。

设计与规则仍由测试夹具提供，本轮不是实际 DSH 模型会话或桌面操作记录；最终 `humanGate` 为 `waiting_review / 未通过`，没有自动填写测试者或代替本人确认。实际桌面抽屉、用户原运行续跑、人工一局 / 失败 / 重开 / 听感及交付记录仍需联合验收。GS6 / GS7 / GS8 仅完成上述格式 / worker 子集，完整编辑器、MCP、任意 3D、多轨音频与 AI 自动修复继续保留未完成状态。

复测入口：`npm run verify:game-studio:extensions`（受本机 Blender / 本地兼容参考可用性影响）、`npm run verify:game-studio:revisions`、`npm run verify:game-studio:creative`、`npm run verify:game-studio:creative-browser`。真实浏览器 / Blender 子进程需要正常执行权限，能力探测不能代替真实执行；不自动安装依赖。
