# 27 个参考仓库的吸收取舍

日期：2026-11-27（Asia/Shanghai）。配套[主规划](./README.md)。

以下来自用户提供的 `D:/AI/AI-Game/README.md` 和本地 checkout 的关键源码、技能、协议及测试结构。**没有联网更新、安装、启动或运行这些项目**；“有实现”仅表示找到对应代码，不代表与工作台兼容或本机验收通过。SHA 是本地 HEAD，若仓库有未提交修改，SHA 不代表全部文件内容。

优先级是吸收顺序，不等于全部功能实施承诺：P0=重设计主路径直接借鉴；P1=闭环后的专项能力；P2=明确需求后再做。每个仓库都应落到已有项目/素材/运行能力中，不能各自变成新一级菜单。

## 1. 游戏产品体验与方法

| 仓库 / 本地 SHA | 具体借鉴及源码依据 | 吸收方式、优先级与边界 |
| --- | --- | --- |
| **Claude-Code-Game-Studios** `abc0de7` | [next-step](../../../AI-Game/Claude-Code-Game-Studios/.claude/skills/next-step/SKILL.md):15–19、194–237，先 make→play/change→grow，每次一个下一步，修改可接受/撤销 | **P0 方法。** 默认简单创作，复杂度长大再加正式项目管理；[README](../../../AI-Game/Claude-Code-Game-Studios/README.md):319–333 的 49 角色/75 技能属于 studio mode，不是首页和前置条件；主体是技能/Hook/模板，不是可嵌入 GUI |
| **opengame** `cb3f280b1` | [GameStudio.tsx](../../../AI-Game/opengame/studio/src/motion/game/GameStudio.tsx):213–230、271–328，个人项目/模板分区和 Remix；[game-projects.ts](../../../AI-Game/opengame/game-projects.ts):992–1018，独立 draft 保留 remixOf | **P0 交互/合同。** 先玩后改，模板与自己作品分开；不搬整平台。该文件 :1531–1541 有真实浏览器脚本，但默认输入与等待不证明完整玩法验收 |
| **ohmygame** `35648c4e` | [project-shell.tsx](../../../AI-Game/ohmygame/src/renderer/project-shell.tsx):290–338、385–386、426–427，项目内面板/布局、选中预览元素进入上下文、同项目 AI 修复；[model3d-journal.ts](../../../AI-Game/ohmygame/src/daemon/model3d-journal.ts):60–87，提交前后记录与指纹 | **P0 项目连续性，P1 任务协议。** 借同项目工作与未知任务对账；不复制 Electron/Daemon/插件体系或再起队列；预览对象局部编辑要有自己的对象合同 |
| **GameFactory-3A** `f9e927c` | [task_tracking.md](../../../AI-Game/GameFactory-3A/agent_skills/game_design/task_tracking.md):3–21、35–55，一份结构化任务供模型与 UI 使用，关联资源/版本/证据；[pipeline README](../../../AI-Game/GameFactory-3A/pipeline/README.md):81–96，生产与只读评估分离 | **P0/P1 合同，P2 生产管线。** 文档明确 UI 未接通不能声称同步；[playtest/run.py](../../../AI-Game/GameFactory-3A/pipeline/code_gen/playtest/run.py):26–28，此录制路线列出 three_js/blender，不等于所有引擎同等验测；整套模型环境成本高 |
| **game-ui-design-workflow** `1ec6046` | [validate_project.py](../../../AI-Game/game-ui-design-workflow/scripts/validate_project.py):121–140、191–231，PNG 尺寸/透明与文档状态；[export_engine_manifest.py](../../../AI-Game/game-ui-design-workflow/scripts/export_engine_manifest.py):110–123，导出器边界 | **P1 UI 子流程。** 风格卡→屏幕→组件→透明素材→Atlas→交付清单；只写 JSON manifest，不生成引擎原生工程；视觉方向/高成本批量才需要确认，不把每一步都设人工门 |
| **threejs-game-skills** `8286774` | [director](../../../AI-Game/threejs-game-skills/skills/threejs-game-director/SKILL.md):43–47、69–85，代表场景、真实输入和视口；[check_evidence.py](../../../AI-Game/threejs-game-skills/skills/threejs-game-director/scripts/check_evidence.py):220–267、366，证据绑定 run/state/viewport，区分历史文件 | **P1 生产/QA。** 借本版本测了什么与按需上下文；是技能/脚手架/检查器，不是工作台；高强度视觉评分可选，不给参数小改套完整流程 |
| **world-forge** `7d4e4ae` | [shot.mjs](../../../AI-Game/world-forge/skills/world-forge/assets/template/tools/shot.mjs):23–26、50–65，截图/亮度/浏览器错误；[review-process.md](../../../AI-Game/world-forge/skills/world-forge/references/review-process.md):29–39、57–59，评分噪声与平台期换方法 | **P2 场景打磨。** 借固定视角和版本盲比；不是完整游戏生产线；critic 是单独模型调用，写实评分不成为所有游戏默认门 |
| **awesome-gamedev-agent-skills** `c6ca6c4` | [router](../../../AI-Game/awesome-gamedev-agent-skills/router/SKILL.md):12–14、37–80、102–105，工程指纹/锁定引擎/最小技能组合，普通加功能不强制 GDD | **P1 能力路由。** 做 HUD 才加载 UI 技能，做角色才给模型工具；不全量注入、不展开成技能侧栏；技能覆盖不等于引擎接通 |
| **cinderwatch** `6640b81` | [72-ui.js](../../../AI-Game/cinderwatch/src/72-ui.js):13–14、135–136，接管/还给 AI；[90-main.js](../../../AI-Game/cinderwatch/src/90-main.js):179–187，启动；[build.py](../../../AI-Game/cinderwatch/tools/build.py):9–44，本地依赖与模块内联 | **P0/P1 贯通样例。** 作品先可见、可接管、可改参数、可离线交付；是具体塔防，不是通用引擎。工作台已吸收该模板，不必再写一套演示游戏 |
| **novel-to-game** `ea07fe2` | [game-qa/SKILL.md](../../../AI-Game/novel-to-game/skills/game-qa/SKILL.md):7、13–18，独立新玩家盲玩→读设计核对；启动/渲染/输入/核心循环/结果/重开六项；盲玩 P0 阻断不能被脚本绕过后标 PASS | **P1 方法，整条改编流程延期。** 不引入小说入口、不排剧情/互动影像任务。结果应按游戏类型解释，塔防不能伪造统一 won 终局 |

特别取舍：opengame 的 [Skill](../../../AI-Game/opengame/skills/openmotion-game/SKILL.md):14–18 有“原样模板零构建直接 ready”和隐藏复制/未检查信息的行为要求，本次没有遵从。新工作台应分别显示模板来源、本轮修改、自动验测、用户验收，不能照搬含糊 ready。

## 2. 素材发现、预览与生产

| 仓库 / 本地 SHA | 具体借鉴及源码依据 | 吸收方式、优先级与边界 |
| --- | --- | --- |
| **PrismVault** `35fa097` | [scanner.ts](../../../AI-Game/PrismVault/src/main/indexer/scanner.ts):141–148、337–361，离线 missing 与指纹重连；[CompareView.tsx](../../../AI-Game/PrismVault/src/renderer/components/CompareView.tsx):26–39，按稳定素材 ID 比较 | **P0 货架交互。** 原位预览、比较、缺失状态、来源目录；[fingerprint.ts](../../../AI-Game/PrismVault/src/main/indexer/fingerprint.ts):9–38 是大小+头尾抽样 SHA-1，采用/构建必须另捕获完整字节及 SHA-256；原 Asset 类型缺完整来源许可字段，不能原样当游戏资产合同 |
| **Serpent** `f0171b53` | [workspace-tabs.ts](../../../AI-Game/Serpent/src/renderer/workspace-tabs.ts):60–90，同会话切换保留搜索/选中/视口；[session](../../../AI-Game/Serpent/src/renderer/workspace-tabs-session.ts):124–165，跨重启仅恢复标签位置，选中/视口重置；[tool-catalog.ts](../../../AI-Game/Serpent/src/mcp/tool-catalog.ts):95–120，显式 library 目标 | **P0 交互，P2 外部 MCP。** 借切回不丢位置，工作台重启恢复另做合同；不搬 Electron/DAM/原生媒体/语义索引/WebDAV。AI 评分不覆盖人工采用，外部服务依赖及权限另估 |
| **prismwright** `4eef7a1` | [autosave.ts](../../../AI-Game/prismwright/apps/desktop/src/store/autosave.ts):35–62，仅真实编辑 dirty 才保存；[pipeline.ts](../../../AI-Game/prismwright/apps/desktop/src/features/preview-assets/pipeline.ts):14–16、156–176，按 hash 重生成，同一 renderer 输出 | **P0 保存/预览机制，P2 卡牌专项。** 保存状态可读、只重算变动素材；不搬卡牌 schema、Tauri/Rust ffmpeg 和全息编辑器 |
| **blender-skills** `904f095` | [export-pipeline](../../../AI-Game/blender-skills/.claude/skills/export-pipeline/SKILL.md):84–114、157–163，比例/LOD/碰撞/轴向；[qa-review](../../../AI-Game/blender-skills/.claude/skills/qa-review/SKILL.md):28–53，多视角/预算/命名 | **P1 配方与检查表。** 从用途预填模型规格；是技能，不是已联调自动化；需要 Blender 执行、GLB 解码及实际消费者，不把全部角色一起注入 |
| **sprite-gen** `35a27e1` | [qa/score.py](../../../AI-Game/sprite-gen/sprite_gen/qa/score.py):83–126，分项异常及建议；[motion.py](../../../AI-Game/sprite-gen/sprite_gen/qa/motion.py):254–277，帧/时序与未知值处理 | **P1 固定本地加工。** 去背景/对齐/图集/时序预览；消费者还需 frame rect/pivot/fps/loop/动画名。技术分数不代替表现验收，Python 隔离与生成后端另算 |
| **pixelfx-zh** `836f545` | [sheets.mjs](../../../AI-Game/pixelfx-zh/tools/sheets.mjs):12–23，透明 PNG/JSON 与 fps/pivot/loop/timing；[frost-nova.js](../../../AI-Game/pixelfx-zh/src/fx/ice/frost-nova.js):80、[blizzard-vortex.js](../../../AI-Game/pixelfx-zh/src/fx/ice/blizzard-vortex.js):113，不同效果执行形式 | **P0 低成本内容预览，P1 实际事件消费。** 预览→调色→导出→已支持槽位采用；静态 PNG 不等于动画效果。代码/效果 MIT 不涵盖 gallery 的 Patch Pixel 字体 |
| **openpixel** `1ab8e4b` | [manifest.json](../../../AI-Game/openpixel/manifest.json):2–20，原路径/hash/截图方法与时间；[night-pond/source.js](../../../AI-Game/openpixel/works/night-pond/source.js):184–261，有真实更新和绘制 | **P0 参考/案例。** 先玩参考→看来源→复制实验→标明修改目标；不是统一可交付游戏模板，不保证胜负/重试/移动端；嵌入前需适配生命周期、输入和清理 |
| **shapeshift-labs-ink-studio** `c8340f3` | [export-glb.js](../../../AI-Game/shapeshift-labs-ink-studio/cli/export-glb.js):22–60，格式/纹理规格和外部资源内嵌；[kb-mesh.js](../../../AI-Game/shapeshift-labs-ink-studio/src/kit/kb-mesh.js):3–10，mesh 导入/fit/信息 | **P2 特色资产实验。** 标准 GLB 消费者和预算建立后再接；splat/SDF 观感不保证通用 GLB 保留，格式成功不等于骨骼/材质/碰撞/性能兼容 |
| **any-audio** `230c547` | [project.js](../../../AI-Game/any-audio/src/tools/project.js):30、99–105、153–191，稳定 track/clip ID 与局部编辑；[sources.js](../../../AI-Game/any-audio/src/tools/sources.js):58–69、161–163，声源与许可 | **P1 游戏音效/循环 BGM，P2 完整 DAW。** 槽位内试听/循环点/增益/替换/撤销；代码许可不涵盖音色库；source 启动不能算用户听过 |
| **dsh-drawai** `3c5b88e` | [document-core.js](../../../AI-Game/dsh-drawai/src/document-core.js):23，expectRevision 冲突；[index.js](../../../AI-Game/dsh-drawai/src/index.js):2585–2598，结构化编辑/path/read→revision | **P1 人机共编。** 关卡草图、UI 布局和图形附件；选中对象局部改动带 revision。画布文件不是游戏场景，需明确导入合同；视频/漫剧本轮延期 |
| **dsh-image-gen** `651190e` | [studio.ts](../../../AI-Game/dsh-image-gen/src/studio.ts):219–267，配置/登录/模型发现状态；[vault-store.ts](../../../AI-Game/dsh-image-gen/src/vault-store.ts):60–84，sha256 原图与临时 rename | **复用已接入口，P1 完善体验。** 槽位规格带入生成，结果回同一货架；不另开图库/Provider。多模型有费用，tldraw 无限画布部署许可独立，不默认复制整 Studio |
| **dsh-local-3d-studio** `b86065f` | [engine.mjs](../../../AI-Game/dsh-local-3d-studio/src/engine.mjs):12–27、77–85，预览/制作/指纹批准与失败清理；[workflow.mjs](../../../AI-Game/dsh-local-3d-studio/src/workflow.mjs):12–18，声明不等于可渲染 | **P1 3D 作业卡。** 先样例→调整→当前版批准→制作，进度可见、取消留中间结果；Blender/Python/权重/显存逐项探测，不首批自动装整 GPU 环境 |

## 3. DSH 游戏与编排参考

| 仓库 / 本地 SHA | 具体借鉴及源码依据 | 吸收方式、优先级与边界 |
| --- | --- | --- |
| **dsh-game-studio** `02d7f26` | [assets.ts](../../../AI-Game/dsh-game-studio/src/assets.ts):272–315，候选、复制/采用、来源/hash、槽位版本；[versions.ts](../../../AI-Game/dsh-game-studio/src/versions.ts):50–84，内容快照/恢复；[playtest.ts](../../../AI-Game/dsh-game-studio/src/playtest.ts):26–33、373–375，状态/自测入口和网络记录 | **P0 核心模式。** 版本、预览、素材/源码候选围绕同一工程；不复制按方向键的统一测试。其 restore 会删除版本外 assets，不能原样套到工作台不可变 run/采用协议 |
| **dsh-minigame-plugin** `b89af37` | [index.js](../../../AI-Game/dsh-minigame-plugin/index.js):1–12，实际提供 SkillFilesystem；skills/minigame/references 有具体玩法参考 | **P0 配方目录。** 跑酷/消除/塔防等起步与检查项，按任务取最小上下文；多引擎是指导覆盖，不是已接好的构建/导出适配 |
| **dsh-plugin-agentflow** `7042e05` | [engine.mjs](../../../AI-Game/dsh-plugin-agentflow/runtime/engine.mjs):138–185，blocked/ready/dry run；[index.js](../../../AI-Game/dsh-plugin-agentflow/index.js):376–390，targets；[commands.js](../../../AI-Game/dsh-plugin-agentflow/lib/commands.js):18–21，真实 spawn 证据 | **P0 借演练/局部恢复语义。** 现有工作流能力内按合同实现；其直接 MCP 引擎和宿主命令模式有不同边界，模型配置提示不等于强制执行，不再造并行内核 |
| **dsh-plugin-teamflow** `a187cfa` | [pipeline.ts](../../../AI-Game/dsh-plugin-teamflow/host/core/pipeline.ts):403–417、465–473，冻结输入/续跑与任务分诊；[confirm.ts](../../../AI-Game/dsh-plugin-teamflow/host/core/confirm.ts):46–49，重跑导致确认失效的问题 | **P0 任务裁剪，P1 返修。** 改参数/换图/加关卡走不同强度；不每次 PRD 瀑布，不搬第二套 backlog/运行库/提交协议 |
| **dsh-Visual-Workflow** `a225fbe` | [resume.ts](../../../AI-Game/dsh-Visual-Workflow/src/host/orchestrator/resume.ts):12–14、98–141，保留旧 run/快照/追溯链；[runtime-base.ts](../../../AI-Game/dsh-Visual-Workflow/src/host/orchestrator/runtime-base.ts):609–610 的状态说明，及 [watchdog.ts](../../../AI-Game/dsh-Visual-Workflow/src/host/orchestrator/watchdog.ts):85–104 的重启对账 | **P2 运行观察/治理。** 进度、暂停、原因和拓扑下钻可借；运行中改拓扑、元 Agent、向量经验召回本轮不做，尤其不恢复记忆实验 |

## 4. 横向合同：避免下一次又“功能有了却没用上”

1. **消费者先于生产者。** 静态图、图集动画、模型、音频、运行时代码效果分别声明支持项，选用后必须能找到实际游戏/槽位/build。不支持的格式只提供参考/下载。
2. **素材源与项目采用分离。** 原库可索引、可离线；采用捕获固定内容；源更新是新候选，不暗改历史游戏。
3. **比较、采用、撤销放一起。** 候选预览、技术检查、目标对象、构建变化和回滚属于同一次任务。
4. **同一个项目、同一份状态。** 直接操作与自动化都走现有领域服务；配置不是成品，Agent 宣称不是执行回执。
5. **能力与证据分层。** 配置/探测/项目成功/人工验收分开；图像可见、音频听过、玩法可玩分别记录。
6. **专业工具按任务出现。** 对普通创作只展示当前对象与下一步；角色、Provider、来源仓与 DAG 放在对应详情。

## 5. 实施时再固定的来源信息

真正复制代码、模板、素材或调用外部服务前，再固定该项实际 revision、dirty 差异、许可/NOTICE、依赖体积、运行环境、消费者合同、测试及回退。当前短 SHA 只用于复查本轮评估，不构成已分发或已兼容的结论。
