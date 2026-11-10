# 13 模型、角色、Skill 与 MCP 执行配置

状态：规划草案。方向已获用户认可，运行能力尚待验证。依赖：01、03、08；供节点和 [聊天工作室](14-chat-workflow-studio.md) 共用。

## 1. 目标与边界

同一工作流允许不同节点使用不同 Provider / Model、角色、Skill 和 MCP；聊天员工也使用同一套版本化执行配置。首期一个节点绑定一个 Agent 配置，团队节点和自动模型路由后续单独估算。

模型选择、角色上下文、技能加载和工具开放是四项不同操作。将名称写进提示词不能证明模型已切换、Skill 已加载或 MCP 已接通。

## 2. 当前代码基线

本轮前置核对的代码入口为 `src/host/agent-model.ts`、`src/host/agent.ts`、`src/host/agent-store.ts`、`src/client/agent-panel.ts`：成员已有 provider、model、systemPrompt、tools、skills、mcp 等字段及目录选择。当前 kickoff 主要列出模型 / Skill / MCP 名称，不能据此证明实际配置生效；该路径未完整传入成员 systemPrompt。

这些是静态链路发现，不代表所有宿主路径均失效。W0 必须验证实际运行行为，并保存请求与实际生效的对照证据。沿用已有配置界面可减少重复建设，不能跳过执行适配。

## 3. 配置结构

```text
ExecutionProfileVersion
  profileId / version / label
  executorType / adapterVersion
  model: providerId, modelId, parameters, capabilityRequirements
  role: roleId, version, contentHash, referenceManifest
  skills[]: id, versionOrRevision, contentHash, loadingPolicy
  mcpTools[]: serverRef, toolName, schemaHash, effectClass
  localTools[] / workspacePolicy / contextPolicy
  budgets: time, attempts, tokenOrCostEstimate
  fallbackPolicy / outputContract
```

密钥和服务连接凭据只保存宿主 credential 引用，不导出到模板、角色卡、快照和浏览器。角色长文档使用短卡 + 按需资料，不能利用当前 4000 字符截断制造“已完整注入”的假象。

## 4. 解析、权限和冻结

1. 产品包和模板提供默认配置；用户在节点配置中显式覆盖允许字段。
2. 角色只提供职责与建议能力，不授予工具权限；Skill 内的 allowed-tools 也只是请求。
3. 实际权限取节点请求、产品范围、用户授权与宿主允许集合的交集；不支持的强隔离要显示限制。
4. 领取 Attempt 时冻结有效配置、角色内容、Skill 清单和输入；已有执行不热更新。
5. 保存 requestedProfile 与 effectiveProfile、实际加载上下文清单和执行收据，便于核查差异。

若 Skill 没有版本号，记录捕获 revision / hash；若 MCP 没有可靠版本，记录连接身份和工具 schema 指纹，执行前复核。工具 schema 相同不保证服务行为完全不变，报告必须保留此限制。

## 5. 模型能力与降级

按具体已配置的 Provider / Model 检查工具调用、结构化输出、图像输入、上下文和参数支持。GPT、DeepSeek、Kimi 是可选来源，不把品牌名称当能力保证，也不在模板中写死未验证的模型 ID。

模型缺失 / 不兼容时默认阻止执行，或按用户预设选择人工节点。备用模型仅在已授权策略内启用，生成新 Attempt 并记录实际模型、原因和预算影响；禁止静默换模型继续冒用原执行身份。

跨模型通过已采用快照和范围内上下文交接，不依赖共享隐藏推理或整段聊天历史。角色、Skill 或模型变化不得热改已冻结配置；若改变当前运行固定配置，先派生新运行再创建新 Attempt。已授权备用模型可按冻结的 fallbackPolicy 新建 Attempt；是否影响已采用产物按 02 的采用规则处理。

## 6. Skill 与 MCP

Skill 加载分为说明、参考文件、脚本 / 工具依赖三层。加载说明不等于允许执行脚本；依赖未安装或权限不满足时给出缺失项。参考资料作为带来源上下文，不得覆盖宿主权限和交付契约。

MCP 默认选择到工具级，标明查询、写入、付费、发布或删除。每次执行检查连接健康和允许 schema；共享连接不等于共享所有工具权限。节点工具调用进入统一事件 / effect ledger，无法确认外部效果时按 03 对账，不盲目重试。

sprite-gen 工具配置按 [15 素材工作流](15-asset-workflow-sprite-gen.md) 区分本地加工与生成：本地配置使用固定工具路径 / revision、命令白名单和输出范围，禁用网络与生成凭据；生成配置另声明实际提供方、模型、凭据引用、预算与收据。内置 CLI 登录、会话解析和 curation 的 reroll / 补帧都要纳入验证，不能绕过配置和 effect ledger。S3 未通过时服务端禁用网页生成操作；依赖发现和加载 Skill 说明均不代表已授权这些调用。

后续 ComfyUI 使用独立服务适配配置，记录实例连接引用、模板版本 / hash、参数映射、模型 / LoRA / 自定义节点依赖和资源配额。实际执行模型与请求分别记录，无法观测项标 unknown。模板导入不授予节点安装或权重下载权限；宿主到本机服务的连接与服务对外网络访问分开验证。外部任务的取消范围和恢复去重需按 15 第 8 节验证，不能把共享实例全局停止当作已支持单任务取消。

## 7. 实施与验收

- E01（W0，独立 Spike）：验证实际模型路由、角色传入、Skill 加载、MCP 工具白名单和执行收据；无需为了写计划自动发起付费测试。
- E02（W1，单独列量）：配置版本、解析器、能力差异、上下文 manifest；用假 provider 测试。
- E03（W2 执行适配扩展）：在目标 DSH 接通已验证能力，不支持项明确降级。
- E04（W3，单独列量）：节点配置 UI、目录、继承 / 覆盖提示和 requested / effective 对照。
- E05：两个相邻节点配置不同模型，收据显示实际模型不同；角色 / Skill 变更有独立指纹，历史不改变。
- E06：不允许的 MCP 写入工具无法调用；若宿主不能强制限制，则该配置不得标为已隔离。

这些是对原计划的新增任务，需在阶段估算中显式增加，不算原游戏 P1 既含能力。

## 8. 风险与回退

配置可选但不生效是主要风险：UI 展示 verified / configured-only / unavailable 的能力状态。无法接通的配置禁止假成功，保留原配置与历史只读；关闭新配置入口不会抹除执行记录。不为多模型再建立一套直接绕过 DSH 的代理运行时，确需新增执行器时单独设计和验收。
