# sprite-gen 对现有规划的适用性评估

日期：2026-11-10（Asia/Shanghai）。来源：`D:/AI/sprite-gen/`，Git HEAD：`35a27e137bfd72440cc856b080913c66f69c772e`，包与 Skill 声明版本 `4.3.0`。检查时来源仓库工作区干净。

对照基线：[工作流规划](workflow-plan/README.md)、[游戏工作流](workflow-plan/06-game-workflow.md)、[游戏插件评估](game-module-plugin-assessment-2026-11-10.md)、[节点运行时](workflow-plan/03-node-contract-runtime.md)、[执行配置](workflow-plan/13-execution-profiles.md)。这些规划目前仍是草案。

后续决策：用户已同意纳入项目规划，实施尚未启动。当前接入方案以 [15 素材工作流与 sprite-gen 接入](workflow-plan/15-asset-workflow-sprite-gen.md) 为准，任务与阶段依赖统一在 [11 里程碑](workflow-plan/11-roadmap-backlog.md) 维护。本文保留首次来源评估及当时的核验结果。

## 1. 结论

**有用，建议作为可选的游戏素材生产与加工工具接入。** 近期价值主要在静态素材处理，随后是角色动画图集；视频生成、插帧与场景合成另列扩展。

它提供可执行的 Python CLI、图像处理代码、人工挑帧网页和结构化输出，能够补齐现有 Game Studio 的素材工具链。它不提供工作台所需的多产品调度、不可变产物版本、人工采用、依赖失效与统一预算内核，因此不适合替代 W0–W3 的工作流设计。

优先采用“固定工具版本 + 子进程适配 + 产物导入”。首期无需将图像算法翻译为 TypeScript，也无需把整个项目搬进工作台主包。现有工作流和游戏分期不以 sprite-gen 可用为前提。

## 2. 在已有组合中的位置

| 来源 | 主要职责 | 与 sprite-gen 的关系 |
| --- | --- | --- |
| CCGS | 简报、角色、开发与评审方法 | 为素材任务提供风格、动作和验收约束 |
| Game Studio | 工程、构建、试玩、版本、素材候选与导出 | 消费审核后的 PNG，后续消费动画图集 |
| DrawAI | 画布、设计、视觉编辑 | 提供角色基准图或参考图，关联素材产物 |
| sprite-gen | 抠图、切帧、图集合成、挑帧、换色、动画检查及可选生成 | 作为素材执行后端 |
| dsh-workbench | 产品、任务、执行、候选、版本与人工采用 | 管理输入输出、运行状态、权限和费用 |

## 3. 值得复用的能力

| 能力 | 对规划的用途 | 优先级与边界 |
| --- | --- | --- |
| `cutout`、`slice-sheet` | 外部图片去背景、网格素材拆分，进入单图候选 | 高；可不调用模型，先做小范围试验 |
| `unpack-atlas`、`export-pngs` | 已有图集或 PNG 经挑选、变换后导出 | 高；必须读取应用挑帧结果后的成品 |
| `prepare → gen → extract → compose-atlas` | 从基准图生成按状态组织的角色动画 | 高；先验证本地处理，再单独验证模型提供方 |
| `curation` 与 `curation.json` | 挑帧、排序、定位、像素修改和预览 | 高；可借鉴 sidecar 编辑，先独立打开，后评估嵌入 |
| `manifest.json.frame_layout` | 给游戏代码准确的帧矩形和播放数据 | 高；避免根据图集大小猜网格 |
| `inspect`、`score`、`inspect-motion` 和 QA 图 | 提供格式、边缘、动作等检查证据 | 中高；评分不能替代用户对动作质量的确认 |
| `recolor`、`background-tile`、`shadow` | 生成配色变体、平铺背景和阴影 | 中；可作为独立本地转换节点 |
| `capabilities` | 从 CLI parser 导出命令、参数、提供方和付费标记 | 中高；适合做工具发现，仍需工作台自己的白名单和输入输出 schema |
| `video-*`、RIFE | 静图变动画、视频抽帧、周期裁切与插帧 | 后续专项；外部服务、工具、模型和设备依赖更多 |
| `scene-render`、`scene-inspect` | 组合现有素材，制作视觉演示 | 后续；不是可玩游戏构建器 |

生成模块的图像、视频、文字检查可能分别产生调用。网页也包含重新生成与补帧按钮，因此不能把 `curation` 整体视为离线编辑器。纯本地处理命令和联网生成命令应使用不同执行权限。

## 4. 接入前要处理的差异

### 4.1 当前 Game Studio 接受单图，动画需要新契约

`D:/AI/dsh-game-studio/src/project.ts` 的 `SlotSpec` 记录单个文件、尺寸和透明等字段；`src/assets.ts:addCandidate()` 对透明 PNG 进行 `fitSprite()` 适配。它没有动画状态、帧矩形或逐帧时长字段。

因此静态成品可先复用候选与采用流程；完整图集不能直接走现有单图缩放，否则矩形坐标与实际图片可能不再对应。建议后续增加 `sprite-atlas` 产物类型与专用消费适配，保存 atlas、manifest、状态、时长、loop、hash 和来源。

Game Studio 当前构建契约只列出 `three` 可选 runtime，不能因 sprite-gen 能导出 Phaser JSON 就认定工作台已经具备 Phaser 环境。Web Canvas 可直接按矩形绘制，但播放与状态切换仍需实现。

### 4.2 工作目录和正式快照分离

sprite-gen 的 run-dir 是可变生产目录。重新提取、挑帧和合成都可能更新其中内容；部分消费者还存在按引擎修订重新推导帧缓存的路径。`runRevision` 可用于识别编辑依据变化，但不能替代平台的不可变 ArtifactVersion 和 Attempt。

每次自动尝试使用独立 staging；人工编辑使用专用工作副本。完成后由宿主验证产物、记录 hash、导入快照，再等待采用。历史快照不作为工具的可写 run-dir，也不交给可能修复缓存的生产入口直接打开。

单图交付应运行 `export-pngs` 后读取 `curated/`；图集交付读取已合成 atlas 与 manifest。`frames/` 是挑帧前素材，直接导入会遗漏用户编辑。

### 4.3 本地锁不等于工作流恢复

源码实现了 run-dir 单写者锁、发布读写锁、临时文件替换及 Windows 分支，值得参考；`run-contract.md` 同时明确，多步重命名间被强制终止仍有持久性缺口。

平台仍需自己的 Attempt 租约、取消对账、staging 校验与快照发布。恢复时检查实际输出，不根据命令退出码或工具自身分数直接采用。不原样开放 `correction-loop --provider-command` 等自由命令入口。

### 4.4 提供方必须符合实际执行配置

项目内置 codex、grok、openai 等提供方路径；部分路径自行启动 CLI、读取本地登录状态或解析会话产物。这些是候选项目的实现方式，不能自动视为已与 DSH 模型路由、Skill、MCP、审计和费用策略接通，也不能据此承诺订阅可用或免费调用。

尤其 codex 适配器依赖特定会话 JSONL 记录，并默认在提取图片后删除该次 rollout；若使用原适配器，应评估 `--keep-session`、收据留存和实际 CLI 版本兼容性。实现所请求与实际使用的模型、提供方、凭据来源和费用证据要归入执行记录。

建议优先验证本地后处理；生成阶段再选择工作台原有生图能力，或明确接通某个提供方。取消后的外部生成状态不明时，沿用 `outcome_unknown` 对账，不自动重复购买。

### 4.5 引擎导出和许可范围

现有引擎导出是 Aseprite-compatible JSON，面向 Phaser 和 Flame；不是可编辑 `.aseprite` 文件。源码与文档未提供现成 Unity / Unreal 导入桥。

`engine-export.md` 明确说明，仅验证了导出字段结构，没有运行真实 Phaser 浏览器应用或 Flutter runtime；loop 策略保留在原 manifest，不能在格式转换时丢掉。Unity 后续需要自己的切片、pivot、PPU、动画与资源导入规则。

代码许可为 Apache-2.0，`NOTICE` 另列 MIT 来源和可选 RIFE 来源。复制或修改时保留相应许可、NOTICE 与修改记录。工具代码许可不能替代参考图、生成内容、模型权重和外部二进制的使用条件。

## 5. 推荐最小流程

```text
基准图 / 已有素材 + 风格与尺寸约束
  → 本地加工，或显式配置的生成
  → PNG / 帧 / 图集候选 + 检查报告
  → 人工挑选与编辑
  → 成品导出、hash 与清单校验
  → 发布不可变候选并人工采用
  → 静态槽位 / 动画消费适配
  → 游戏构建与真实预览
```

可先定义少量节点：`asset.import`、`asset.process`、`asset.generate`、`asset.review`、`asset.export`。人工挑帧属于工作副本编辑，导出候选后仍要遵循平台的采用规则。无需把 57 个 CLI 命令各做一张工作台节点卡。

## 6. 分期与验收建议

以下是新增范围建议，不计入已冻结的 W / P 阶段交付承诺；实施时另行估算。

| 阶段 | 交付 | 验收出口 |
| --- | --- | --- |
| S0：本地可用性试验 | 独立 Python 环境；固定版本；不联网的处理样例 | 抠图 / 切片、失败保留旧结果、最终成品导出与 alpha 检查通过 |
| S1：静态素材桥 | 本地 PNG → Game Studio 候选 → 采用 / 回退 | 采用前不改正式素材；来源与 hash 保留；导出游戏仍可离线运行 |
| S2：动画图集 | 图集产物类型、manifest 校验、播放与独立审核 | 矩形不越界，帧顺序 / 时长 / loop 正确；挑帧修改确实进入成品；真实浏览器预览通过 |
| S3：受控生成 | 某个已验证提供方、实际配置收据、预算和取消 | 无静默切换；失败不重复计费重试；主任务取消后的外部状态可对账 |
| S4：视频与高级媒体 | video、RIFE、场景等可选能力 | 工具 / 模型 / 设备探测、资源上限、许可与真实样例分别通过 |

S0 可作为独立技术试验先做；S1 等 Game Studio P1 的候选契约稳定后接入。纳入正式工作流依赖 W1/W2 产物与审核机制，游戏产品包注册按 W4 推进。视频生成和场景媒体能力与现有 P4 协调，仍保留独立范围。

## 7. 本次核验结果与限制

- 已读取 README、运行与架构契约、能力发现、引擎导出、许可，以及 CLI、文件锁 / 发布、生成、导出和 Game Studio 素材消费关键源码。
- 静态统计：`sprite_gen/` 有 141 个 Python 文件，CLI 主表注册 57 个命令，`tests/` 有 261 个 `test_*.py` 文件；数量不代表测试质量或通过率。
- 使用本机 `py -3.12` 对这 141 个源码文件执行 `ast.parse`，0 个语法错误；使用 `tomllib` 成功解析包配置。该检查不验证导入、依赖或运行行为。
- 当前 `pyproject.toml` 要求 Python 3.11+、Pillow 12.3+ / <13、NumPy 2.2.6+ / <3。README 仍写 Python 3.10+，接入按当前包元数据和实测为准。
- 本机 `python` 默认指向 3.9；`py -0p` 能找到 3.12。该 3.12 环境尚未安装 Pillow、NumPy、pytest、pytest-timeout。
- PATH 探测未找到 ffmpeg、img2webp、grok、uv；这不排除其他目录中有可配置安装。未探测 GPU / Vulkan 可用性，未安装 RIFE。
- 本地有测试文件和发布脚本，但未见 `.github/workflows/`；不能据此推断上游从未执行测试。
- 未安装依赖、运行 pytest、启动挑帧网页、调用模型、生成素材或验证引擎实际运行。候选仓库未改动，既有工作台文件改动保留；本次仅新增此评估。

建议决策：**将 sprite-gen 列入可选素材后端，优先验证 S0 / S1；继续按既定顺序建设工作流内核。** 它有机会减少素材处理与动画工具的自研量，实际节省多少应在最小样例跑通后判断。

## 8. 关键证据入口

- `D:/AI/sprite-gen/pyproject.toml`：版本、Python 与依赖要求、CLI 入口。
- `D:/AI/sprite-gen/sprite_gen/cli.py`、`sprite_gen/workflow/capabilities.py`：命令与参数发现、提供方和付费标记。
- `D:/AI/sprite-gen/docs/run-contract.md`：阶段输入输出、成品目录、并发与持久性边界。
- `D:/AI/sprite-gen/sprite_gen/spec/runio.py`：run-dir 锁、发布读写锁、原子替换。
- `D:/AI/sprite-gen/sprite_gen/serve/serve_curation.py`、`sprite_gen/curate/curation.py`：人工编辑、修复缓存与模型操作入口。
- `D:/AI/sprite-gen/sprite_gen/gen/codex_provider.py`：CLI 子进程、会话解析与清理边界。
- `D:/AI/sprite-gen/docs/engine-export.md`、`sprite_gen/compose/export_aseprite.py`：图集映射、格式限制与运行验证缺口。
- `D:/AI/sprite-gen/tests/packaging/test_pipeline_smoke.py`、`tests/compose/test_export_aseprite.py`：现有可复用验证起点，本次未运行。
- `D:/AI/sprite-gen/LICENSE`、`NOTICE`：代码与组件许可。
- `D:/AI/dsh-game-studio/src/project.ts`、`src/assets.ts`、`src/build.ts`：单图槽位、候选缩放和构建消费方式。
