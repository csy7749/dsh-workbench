# M1 无模型 SQLite 持久化闭环证据

## 当前续批（2026-11-14，发布结果必填独立局部签收）

happy-4.1已独立局部签收本批实现，补强PRR-04为17种非法值各自从新running项结算；PRR-06/07验证授权优先、未领取及已终结项不改写。8种变异均命中并还原；老大复跑publish-result8/443通过。测试补强为共同维护，变异为独立验证。源码字节SHA256：kernel 8da47365f19928b57ec3d232aa05f046f8a2ffa9ae07043cf47507d35d57841a；service 066a0909592df67ef08cecf1bf0d53ac62857065865be6734df4892cc45ba338；结果专项90cd15d7f26fb71a0fa3cb4c32853232e7dcb289391336d94232f448bb32f760。以下为签收前实施记录，不代表当前缺口仍存在。发布整体与Stage3仍未通过。

移除 completeOutbox 与 host.publish 的默认成功。假服务先验证身份与产品归属，再校验显式结果，缺失/非法结果返回 schema_invalid/outbox_status_required 或 outbox_status_invalid，领取前不观测、不写入。内核已领取项收到无效结果时提交 outcome_unknown，reason 为 publish_result_missing 或 publish_result_invalid，沿用 settleRun 与 outbox.settled；未领取和非 running 项仍受原状态门限制。此处只修复假发布结果登记，不证明真实外部效果。

老大复跑 publish-result6/164、publish-claim16/186、kernel109、service24/457及bundle通过。PCB-12旧调用补显式 succeeded，保留适配器故障分类断言。PRR-04目前仅第一种非法值从 running 开始，后续值在 outcome_unknown 上验证拒绝，不能声称十种值均独立覆盖首次结算；待补强与独立复核。无结果回调的 running 恢复、服务对账入口、预期hash仍未完成，Stage3未通过。

## 前批证据索引（2026-11-14，三个对象参数入口独立局部签收）

happy-4.1已明确局部签收三个入口：逐一移除检查均被参数专项独立命中，还原后262/262；独立探针验证授权先行、合法对象成功，以及所有拒绝路径十一表指纹和对象目录树不变。旧task-input31及service24/457在这些变异下仍绿，不能替代新参数专项；参数专项自身未建合法对象正控，必须配套task-input、human-confirm、history-read及service回归。保留此组合验收，不为同一正向行为复制夹具。共享attemptContext等其他入口不在签收面。Stage3未通过。以下为签收前实施记录：

readAttemptInput.attemptId、readTaskInput.taskId和confirmHumanTask.taskId增加非空字符串检查，置于既有授权之后、SQLite绑定之前，沿用各入口的对象不存在错误。未修改共享attemptContext或内核。参数专项262/262，task-input31、history-read14、human-confirm16/196、service24/457及bundle通过。已复现readAttemptInput缺参裸ERR_INVALID_ARG_TYPE后修复；另两入口尚无独立变异证明。首次测试夹具缺产品映射被run守卫提前拒，修正映射后才复现真正异常；HTTP确认按既有能力拒绝而非credential_required。本批待happy-4.1独立复核，不代表所有对象入口已收口；Stage3未通过。

### 前批：runId参数边界独立局部签收

happy-4.1明确局部签收：七个读口及commandRun的runId处理、身份/凭据先于对象解析。专项补入合法缺失run、无productId scheduler及scoped主体；老大复跑199/199。测试补强为共同维护；M1–M5定向变异是happy-4.1独立验证，全部打红并逐字节还原。service24/457及bundle此前通过。runId修复不代表对象参数整体修复：readTaskInput.taskId、readAttemptInput.attemptId、confirmHumanTask.taskId缺参仍裸ERR_INVALID_ARG_TYPE，单列M1缺口。服务文件为CRLF，哈希一律按原始字节计算，不与LF归一值混用。Stage3未通过。

以下为补强前历史记录：

runContext新增非空字符串检查，非法runId统一artifact_missing/run_not_found；guardedRunContext仍先执行身份/权限/凭据预检查，scoped身份仍使用隐藏归属错误。新增verify-workflow-m1-read-arguments.mjs：七个读口×六类非法值(undefined/null/空串/数字/对象/数组)×三类主体(ui/ghost/http无凭据)，126/126通过，十一表指纹不变。service24/457及bundle通过。本批尚未独立复核，也未宣称验证全部写入口、其他对象参数或scoped身份矩阵。Stage3未通过。

### 前批：stepStale披露独立局部签收

happy-4.1已复核六类退化全部命中：恒false、恒true、以task.status推导、原始数字、仅confirmed生效、以task_revision推导。新增未确认stale断言补齐此前变体E漏测；还原后task-input31/31。已确认失效/未确认stale/未失效对照均覆盖，十一表及对象与manifest只读性有独立探针证据。仅签收字段披露，页面尚无消费方，Stage3未通过。以下待复核描述为历史过程。

待办输入专项由happy-4.1补至30项，记为共同维护的回归测试；独立探针和变异证据另外记录。新增stepStale：readTaskInput同一JOIN读取steps.stale，返回严格布尔值；status/isCurrent仍保留原语义。专项夹具增加第三步，确保人工确认后运行尚未终结，可合法暂停并重跑上游；确认时stepStale=false，重跑后status=confirmed、isCurrent=true但stepStale=true，冻结inputs不变且读取不写库。修改前undefined与false断言失败；修改后task-input31/31、history-read14/14、service24/457及bundle通过。内核与页面未改，字段及新反例待独立复核，Stage3未通过。

### 前批：待办输入读口独立局部签收

happy-4.1独立探针确认历史版本/冻结时间不偷换、授权先于对象与版本、角色凭据、跨run伪造拒绝、已确认绑定等于Attempt、删除对象不影响引用读取但内容读取拒绝。七类行为变异被专项发现；去掉task run过滤专项仍绿，列为待固化缺口，不宣称所有边界有持续回归。已确认任务status=confirmed且isCurrent=true不表示step仍有效，暂须getRun查询step.stale，下一批补stepStale披露。全族读口runId缺参裸ERR_INVALID_ARG_TYPE记录为M1服务边界问题，未授权延期到M0-B。以下待复核文字为历史实施记录，Stage3未通过。

readTaskInput({principal,runId,taskId,version=null,credential}) 新增于假服务，复用read.artifact：先授权run，再检查task归属，再校验显式正安全整数版本，再读取内核绑定。返回taskInput含taskId/stepId/version/currentVersion/isCurrent/taskRevision/status/frozenAt/inputs，只返回引用。isCurrent只表示最新冻结版本，不代表stale待办有效。历史版本独立验证，即使最新摘要损坏仍可读取健康旧版本；currentVersion只表示最大已存版本号。

新增verify-workflow-m1-task-input.mjs，14项通过，覆盖无Attempt读取、非法及超前版本、跨产品隐藏、重开前stale/重开后历史与当前版本、坏摘要和健康旧版本、DB只读。history-read14、service24/457及bundle通过。尚缺新读口的完整角色凭据矩阵、跨run伪造、已确认待办及删除对象专项；未宣称T1–T12全部覆盖。内核与页面未改，待独立复核，Stage3未通过。

### 前批：历史只读接口局部签收及专项补强

listAdoptions/readAttemptInput 已获 happy-4.1 独立探针局部签收：非空历史输入跨重跑及人工待办重开不变、多次采用previous同一步、跨run拒绝、角色与凭据边界、坏绑定错误映射、伪造下游或stepId拒绝均实测成立。happy-4.1 已将反例固化为history-read14项，老大独立执行同一脚本14/14通过。新增部分为复核者编写的独立验证；老大复跑不改变其来源。复核者报告六种定向变异命中：采用链纯时间排序、去掉run归属、权限降为read.run、错误直接translate、跳过摘要校验、跳过上游归属校验；这些变异未由老大再次执行。

接口语义：listAdoptions 按步骤rowid再采用rowid排序，属于按步骤历史，不是运行时间序；adoption ID末尾数字不是步骤内版本号。readAttemptInput 只验证冻结引用元数据，成功不保证对象可读，内容必须再经readArtifact校验。未确认人工待办尚无Attempt，当前接口无法展示其上游输入，仍须补待办输入读口。恢复采用后listArtifacts同快照多行问题留在恢复批次处理。W1-04及Stage3未完成。

### 前批：readArtifact完整校验局部签收

happy-4.1 已独立局部签收：恢复旧读取使新专项失败，现有service/endtoend仍绿；自洽manifest类型/字节篡改、缺失manifest与数据库类型篡改均拒绝。授权前移真变异由service S19等发现；十一表及对象/manifest清单只读检查通过。老大随后加强专项：按manifest.snapshotId唯一匹配目标（不依赖目录首项），坏manifest下跨产品与不存在run均要求artifact_missing/run_not_found；专项3/3通过（在既有场景内增加断言）。错误detail仍兼容折叠snapshot_content_mismatch的不同原因，不宣称精确区分bytes与内容hash。历史接口尚未实现，Stage3未通过。

以下为本批修复过程记录：

历史读取前置：readArtifact 在既有授权及run归属检查后改调 kernel.readSnapshot，返回其完整已验证元数据。保留旧对象缺失/内容损坏 detail；新增manifest错误映射artifact_missing。新增 scripts/verify-workflow-m1-history-read.mjs：manifest类型/字节篡改拒绝、读取不改DB和被篡改manifest、恢复后返回完整快照。修改前 Missing expected exception，修改后3/3；service24/457、endtoend12/152、bundle通过。首次回归因旧detail变化导致E2E06/08失败，保留兼容映射后恢复通过。仅假服务临时SQLite，历史查询新接口尚未实现，Stage3未通过。

更正：上批坏记录确认code+detail断言是精确性改进；expectedTaskRevision=99探针仍先命中绑定门，不能证明CAS曾掩盖绑定错误。

### 前批：显式绑定版本API及列表返工局部签收

happy-4.1 独立复核通过：恢复直接映射、恒标可用、遗漏摘要错误兜底、静默丢弃坏行均被专项发现；两层重放前门继续分别被反例发现。独立探针确认坏行存在时健康行仍可确认，坏行确认不写库，产品边界成立。老大随后将坏记录确认断言收紧为 schema_invalid 加精确 detail，专项34/34通过。列表侧 artifact_missing 专指输入绑定不可读；确认侧 schema_invalid 携带 attempt_input_unbound/attempt_input_invalid detail。按行恢复白名单与 inputBindingFor 的这两种领域错误耦合，新增领域错误须同步审查；其他错误仍整调用translate失败。以下待复核措辞是修复过程记录；本批局部签收不代表W1-04或Stage3通过。

独立复核证实两层重放前版本门及saveDraft门各自被反例覆盖，但发现列表中坏绑定导致整个列表抛领域码，因此本批未签收。现按行隔离 attempt_input_unbound/attempt_input_invalid：bindingVersion=null、bindingUsable=false、bindingError={code:artifact_missing,detail:领域码}；健康行正常返回，其他异常统一translate，不吞异常。新增缺行/坏摘要两种夹具：健康待办可见、坏待办标不可用、跨产品不可见、确认仍拒绝、全表指纹不变。版本专项34/34、service24/457、bundle通过。尚待独立复核列表返工，Stage3未通过。以下历史段的“尚未增加API”等仅描述当时状态。

saveDraft/confirmHuman 必须携带 expectedBindingVersion（安全整数、等于服务端冻结版本），否则 input_binding_stale。服务层映射 schema_invalid；在授权后、幂等缓存返回前校验，内核在request前及确认事务内再次校验。列表返回 bindingVersion；保存草稿仅增加task revision，不改变绑定版本。旧绑定版本重放被拒，同版本同请求仍返回原采用；不是仅靠修改幂等键防止旧请求重放。

新增 scripts/verify-workflow-m1-binding-version.mjs：无草稿/有草稿两组，缺失及非法版本、旧版本保存/确认、服务缓存与确实命中过的内核缓存重放、当前版本成功及Attempt绑定均验证；32/32通过。老大复跑 history14、independent22、bundle通过。happy-4.1迁移六个既有脚本的33个调用点，报告内核108、history14、independent22、service24/457、endtoend12/152、recovery15/151、context11/106、human-confirm16/196、readonly12/310、mount13/136及版本专项通过；迁移属于实现方测试，不计独立编写证据。新API仍待独立源码及变异复核，Stage3未通过。

### 前批输入绑定返工与摘要专项（已独立局部签收）

happy-4.1 已确认去除摘要门仅BIND-digest失败，去除内容hash门仅BIND-hash失败，恢复哈希一致。以下“待复核”及哈希为该历史批次记录，不是当前API版本。

happy-4.1 已重放失败探针并局部签收返工；去除归属、旧草稿版本及白名单检查分别命中反例。另发现摘要检查漏测：去掉摘要检查原专项仍绿。现补 BIND-digest（只坏摘要、内容不变），BIND-hash 改为内容hash错误但摘要正确，隔离两项守卫。`node scripts/verify-workflow-m1-endtoend.mjs` 12/12、152断言通过；新增反例待独立变异复核。内核未变，下方endtoend哈希为本次补测前版本。Stage3未通过。

首批独立复核不通过，本段取代下方首批结论。修复页挂载表白名单，PM-schema 比对内核实际建表与白名单；重打包后 mount13/13、136断言，PM-12重启复用恢复200，符号链接EPERM分支仍未验证。绑定增加 integrity_hash，并独立检查引用采用/快照/源步骤归属同run且位于目标前；摘要不是对任意数据库写者的安全边界。旧行无摘要不回填、明确拒绝。服务统一映射 artifact_missing，执行器记录原绑定错误并暂停。

草稿记录绑定版本；重开后旧草稿确认拒绝 input_fingerprint_conflict，重新保存后方可确认。H11断言拒绝无数据库副作用。版本取revision，可跳号。尚未增加显式 expectedBindingVersion API，终结Attempt的历史读取目前仅内核接口，不宣称历史页面完成。

新增 BIND-missing/hash/foreign：缺行、坏摘要、重算摘要的跨run引用均在runNode入口被拒、Attempt不再running、run暂停且原因保留。恢复指纹加入drafts/bindings。复跑命令为 node scripts/verify-workflow-m1-{history,endtoend,recovery,service,independent,human-confirm}.mjs（逐个运行），结果14/14、11/147、15/151、24/457、22/22、16/196；pnpm run bundle、git diff --check通过。本返工未独立变异验证，待happy-4.1复核；Stage3未通过。

当前SHA256：kernel `3ba22ff63e6122652b26c921a8c0311546d2e8e2f2cb888c573a733f45522519`；fake-service `adeb2ae01139672839ae69722683d4b2366f6ae49c6b47357995d830eccef8eb`；history `2d924ac83a674ec7ae01889532819e4f1873c88592d4c9c6bc9aebefc1eaaf0c`；endtoend `73da3ee205ab9ab99c4c434eb5515d4d43d090e1a0678c9fe84e94356f226f23`。

### 输入绑定首批（历史，复核未通过）

新增 workflow_input_bindings(owner_id,version,binding_json,frozen_at)。自动 claim 在事务中冻结最近上游采用集合（首步为空），input_hash 包含声明输入与绑定；人工待办声明指纹保持独立，创建/重开追加绑定版本，确认复制绑定到 Attempt。hostInputFor 只读冻结绑定并校验内容，不再把本步骤旧输出当输入；parentSnapshotFor 保留版本谱系语义。旧库没有绑定的 Attempt 明确拒绝，不猜测回填。

本批仅覆盖线性模板最近上游，尚不代表通用多输入绑定或页面完成。新增专项核查首步重跑无自引用、下游换输入后 hash 改变、旧绑定不变、缺绑定拒绝；人工重开沿用 H9/H11。未做本批先红后绿与变异，需独立复核及补齐边界反例。

复跑 history14/14、endtoend8/132、human-confirm16/196、independent22/22、service24/457、recovery15/151、kernel108，bundle/diff-check通过。SHA256：kernel `70ef4807c8d61bc104b81c2fc69faaa9e37ce9b05a1669a6e66a3eaab50a57ec`；fake-service `5db28e8f4026cbacc99af6e8ef389da101a6629bb54fe5a9763dbb6212a188fc`；history `a37ea3b23586a32def0a2831eeafbf33f3749cb6835a06c17f4f030be112bbb6`。Stage 3 未通过。以下哈希均为历史。

### 前批 H13 人工确认回滚清理（已独立局部签收）

happy-4.1 独立复核：移除 catch 清理、改用 step 派生 ID、将清理改为空操作，三种变异均在 H13 的 manifest 目录断言失败；内核恢复哈希一致。签收仅覆盖本批人工确认回滚清理，Stage 3 未通过。

前批 H9–H12 已获 happy-4.1 独立局部签收，其变异分别证实两处身份、租约与事件断言有效。续补 H13：临时库人为置 stale，让 confirmHuman 在 storeCandidate 后被 adoptTx 拒绝；断言十表不变、manifest 目录空、无 Attempt 残留、待办 open/revision=1；解除夹具 stale 后同请求重试成功。Attempt ID 在确认入口生成一次，由事务及 catch 共用。

当前 SHA256：内核 `b821ed78154c7a1fa7a1976ebadeefaed083aec4c965190a36e742de84d6c287`；历史专项 `450dcb16976001382f988b223a40afcc46991c63552ac7bc2b2d9883c0bc1ff8`。本批复跑 history 13/13、human-confirm 16/196、independent 22/22、bundle 和 diff --check 通过。以下旧哈希仅代表前批。

重放契约：replayed 仅表示原请求曾被接受并返回原采用，不保证它仍是当前采用；调用方须重新读取步骤状态。跨进程并发 manifest 竞争仍待 M0-B 实测，本批只验证同步临时 SQLite，不据探针假设确认存在并发缺陷。Stage 3 未通过。

### 前批 W1-04 重跑前置（已独立局部签收）

本批内核 SHA256 `570cb9b9ab22501fc7ca288e714df5bd71affc6219becb501b3aff538506d33e`；重跑专项 `919c6a7b6c77e00bfbd852d73e227e505ce78d0fc23377af9c3c6944d6a313ad`。下文清理批次哈希均为历史版本。

H9 先复现 workflow_human_tasks.id 主键冲突，修正后继续确认又复现 workflow_attempts.id 主键冲突。新 task ID 带完整 input hash，既有任务按查询得到的 id 重开；人工 Attempt ID 使用 taskId 与 task revision，清理路径同步。H9 验不同输入可再次确认且旧任务不变；H10 验上游 pending 保留、目标与下游作废且事件记录 supersededOutboxIds；H11 验下游待办重开保留草稿；H12 验过期租约返回 attempt_lease_expired 且十张表指纹不变。过期 Attempt 仍需显式对账，本批未自动回收。

可复现命令：`node scripts/verify-workflow-m1-history.mjs`（12/12）；`node scripts/verify-workflow-m1.mjs`（108）；`node scripts/verify-workflow-m1-independent.mjs`（22/22）；`node scripts/verify-workflow-m1-service.mjs`（24/457）；`node scripts/verify-workflow-m1-recovery.mjs`（15/151）；`node scripts/verify-workflow-m1-endtoend.mjs`（8/132）；`pnpm run bundle`、`git diff --check` 通过。仅临时 SQLite、假执行器；不是完整 W1-04，不代表 Stage 3 通过。

### 前批失败清理凭据门（历史版本，已独立局部签收）

happy-4.1 独立复核：去掉已采用守卫仅 REC-14 失败；去掉 token 门仅 REC-15 失败；同时去掉两者两项均失败。恢复15/151及相关回归通过，挂载符号链接分支因 EPERM 跳过，不算通过。此结论仅签收本批，不代表 Stage 3 通过。

证据边界：confirmHuman 的清理属于事务失败后的防御处理，当前没有针对该 catch 的故障注入证据；不能从外部 expectedStepRevision 参数无法触发失败推断所有异常均不可达。有效凭据但调用方传错 candidate 也可能清理自己的未采用 manifest，需要重新 storeCandidate。

REC-14 覆盖已采用 Attempt 的正确/错误 token 重放：manifest 字节、快照读取结果与数据库指纹均不变。REC-15 覆盖错误 token 不得毁掉健康在途候选：修复前15项14过，失败 `wrong token preserves pending manifest byte for byte`；修复后15/15、151断言。adopt 的异常路径仅在数据库中 Attempt 存在且 token 与请求匹配时调用 cleanupCandidate；已采用保护仍由 source_attempt_id 守卫负责。人工确认回滚的注释也改为保留共用对象，避免误称删除。

本批当前哈希：内核 `1d9ce35ca60f7700a3542e3b3e031fb7b0f136d5e676ec9da405a3c446c6faab`，恢复脚本 `30fe093eddf4759be95fbf6ecafaeb10f135414591167669e6bc3a777ec6a8a0`。运行 node scripts/verify-workflow-m1-recovery.mjs、verify-workflow-m1-independent.mjs、verify-workflow-m1.mjs、verify-workflow-m1-service.mjs、verify-workflow-m1-endtoend.mjs（后四项同在 scripts/），结果依次15/151、22/22、108、24/457、8/132；pnpm run bundle 和 git diff --check 通过。仅临时 SQLite / 假执行器证据，Stage 3 未通过。

清理契约：身份有效但采用失败（包括 cas_conflict）会删除未采用 manifest，原 candidate 再试将报 candidate_not_durable；需重新 storeCandidate，且重新满足状态/版本条件。身份无效不清理。离线 GC 尚未实现；未来回收必须同时考虑 manifest 与快照引用及在途写入协调，不能只数快照行。

### 前批在途共用对象保护（历史版本）

最新续批：采用完整性及 REC-10–12 已经 happy-4.1 独立局部签收；随后发现失败清理仅统计已提交快照，会误删其他在途 candidate 共用的对象。新增 REC-13，修复前失败 `failed adoption must preserve the in-flight shared object`；现改为失败路径保留内容寻址对象，仅清理本 Attempt 未采用的 manifest（按 source_attempt_id 检查是否已采用）。不声称 scanRecoverable 或 GC 已能回收孤儿对象：离线 GC 尚未实现，残留对象可能占空间，本阶段仍限临时工作区。

本续批当前哈希：内核 `17be87e298e9dfca90ae7d13f05e3afd8bc3e8212b26117ced1402696fb90486`；恢复专项 `31581c5a5fdbccffd398998591a7161936938529fc85b020fc1b5ecb29e863f8`；host bundle `e9b050eba7a3e0f142bb410137ca7652a77965afb9ef041b77e0123f3fae3af4`。以下旧索引哈希已被本段取代。

复跑恢复专项13/13、139断言，独立22/22、内核108、假服务24/457、端到端8/132及 bundle通过（host684.29kB/client964.16kB）。内核回归原断言 `failed adoption removes the orphan object` 与新安全策略冲突，已改为明确断言对象保留；manifest删除与快照不新增断言保持。REC-13 另验证另一合法在途候选可成功采用和读取，不能只靠改旧断言宣称修复。

### 前一批索引（历史版本，已独立复核）

本节覆盖下文各历史批次的当前版本口径；历史哈希与计数保留用于追溯，不能作为当前工作树哈希。下文 B4/B5 的“内核未改”仅指该历史批次。B2–B5 已有局部签收，Stage 3 仍未通过。

类型持久化修复由 happy-4.1 独立复核正确：采用保存经 manifestHash 校验的 onDisk.artifactType；REC-09 覆盖 text/markdown/json、伪造 candidate 类型、关库重开、读取导出及数据库历史不变。类型修复版本哈希为 `088cc7e71fa3d02137fda9414f0d3c974da115a084d634518ea708ea961a236e`（已被以下补丁取代）。旧类型错误行不自动迁移。

紧接着修复 adopt 的快照身份及对象校验：manifest.snapshotId、candidate.snapshotId 与 `${attemptId}:snapshot` 必须一致；实际对象内容的 hash 和字节数必须吻合。新增 REC-10/REC-11，修复前分别报 `expected candidate_identity_mismatch but the call succeeded` 与 `expected candidate_object_mismatch but the call succeeded`；修复后拒绝错误候选，数据库全表指纹不变。该拒绝仍沿用原有 candidate 文件清理语义，不声称磁盘不变。

当前 sha256：
- `src/workflow/m1-kernel.mjs`：`a3d30c1f2144ad7475244aa17b1ee911de115e730a4cf6274b12c2c8a053143b`
- `scripts/verify-workflow-m1-recovery.mjs`：`8c7ccff13212747e6e6714ec4c5737fbbbb85bb3f92a6655d13d77c957b468f0`
- `lib/index.js`：`041df16d97725432dba47e0c9ee79eee901520d2861272785cb4e7490f249f6c`

复现（仓库根）：`node scripts/verify-workflow-m1-recovery.mjs` 为 12/12、134 断言（新增 REC-12：拒绝候选清理不删除已采用快照共用的对象，旧快照仍完整可读，仅清理失败 Attempt 的 manifest）；挂载专项 `node scripts/verify-workflow-page-mount.mjs` 12/134（符号链接因 EPERM 跳过），只读客户端 `node scripts/verify-workflow-readonly-client.mjs` 12/310；`node scripts/verify-workflow-m1-independent.mjs` 22/22；`node scripts/verify-workflow-m1.mjs` 108；`node scripts/verify-workflow-m1-service.mjs` 24/457；`node scripts/verify-workflow-m1-human-confirm.mjs` 16/196；`node scripts/verify-workflow-m1-endtoend.mjs` 8/132；`pnpm run bundle` exit 0（host 684.62 kB / client 964.16 kB）。全部使用临时 SQLite、脱敏数据和假执行器。

未覆盖：跨进程篡改竞争、真实断电、产物类型白名单（W1-10 待收口）、历史分支/比较。采用完整性补丁待 happy-4.1 独立签收。

## 历史批次记录（以下计数与哈希均为对应批次时点）

状态：第三轮返工 + 第四轮局部修复 + 第五轮发布完成条件修复 + 第六轮显式继续门修复完成，实现侧专项测试 108 项全通过，独立验收脚本 C1–C22 全通过；B1 假服务与长任务协议（W1-10）已完成，服务专项脚本 S1–S24 共 24 项 457 条断言全通过（含老大第三至第十轮退回的凭证-幂等、授权-凭证顺序、读接口与提交路径凭证前置/透传，以及 G-01/G-04/G-05/G-08 目标对象入口的存在性隐藏矩阵），由老大局部签收（**不是 M1 总签收**）；B2 上下文组装（K1-01/02/03，CTX-01–06/08）已由老大**局部签收**（老大退回四项：共享白名单跨产品、预算只算片段、非 `product` 范围可绕过目录归属、未绑定共享根用 `allowPrivate` 一次放行私人资料；均已修并补反例），上下文专项脚本 11 项 106 条断言全通过，并顺带修掉内核越步领取的线性调度缺口（实现侧新增 5 项断言）；B3 恢复、备份与只读导出（W1-03/W1-05，A06/A09/A14）已由老大**局部签收（第三轮）**（恢复专项脚本 8 项 112 条断言全通过；老大两轮复核共退回四项：快照身份未三方对齐、扫描六类缺两类正反例、双连接被写成并发压测、行 `artifact_type` 未与 manifest 对齐，均已在原批次定向修复并补反例；该签收不含跨进程并发与真实断电验证）；B4 子批「工作流内测页薄挂载与初始化失败隔离（W1-07/A13 宿主子集）」本批完成、**待独立签收（第二轮，补库文件物理隔离）**（新增 `src/host/workflow-page.ts` 与挂载专项脚本 12 项 134 条断言全通过；默认关闭、无 SQLite 独立禁用、初始化失败只让新路由 503 且旧面板与旧数据逐字节不变；老大退回的配置冲突已修——工作流库与旧工作台库同路径、相对段/大小写/硬链接/符号链接别名、以及指向旧库的改名副本一律在**建表之前**拒绝，旧库不出现 `workflow_*` 表且 `legacy_marker` 原样保留；客户端页面仍属 B4 后续子批）；B4-2 子批「A10 执行前校验 + A36 人工确认语义」本批完成、**待独立签收**（新增 schema 方言 `workflow-input/1` 并在**创建运行时**严格校验、领取前失败关闭；确认继续与确认并暂停同事务提交、暂停后不抢跑、旧基准被拒且草稿保留；专项脚本 `verify-workflow-m1-human-confirm.mjs` 16 项 196 条断言全通过，18 条变异全部被抓；老大退回的三轮 A10 反例（`required:'plan'`、`minimum:2`、缺 `type` 只写 `minimum`、`type:'string'` 配 `minimum`、`type:'number'` 配 `minLength`、`required:['toString']` 配空对象、显式 `properties:null`）已各自变成会报错的用例：第三轮补**类型-约束相容性**（`constraint_without_type` / `constraint_type_mismatch` / `enum_type_mismatch`），第四轮把字段存在性改为**自有键判断**并拒绝显式 `properties:null`（`properties_null`），领取旧 schema 时同样失败关闭；**本批没有新增任何写 HTTP 路由**——宿主路由拿不到可信会话身份，A36 只在假服务层验证，UI 阻塞点记在本节末尾）；B4-3 子批「默认关闭的只读客户端」本批完成、**待独立签收（第二轮：读取失败不再折叠成空数据）**（新增 `src/client/workflow/readonly-core.mjs` 与 `readonly-panel.ts`：客户端只做步骤状态/历史/错误展示，请求全部 GET、方法写死在读取函数内部、路径只有 `/health`、`/runs`、`/runs/:id`；六种关闭态（未挂载/独立禁用/需 SQLite/初始化失败/库冲突/不可达）一律 `exposed:false` + 不挂侧栏入口 + 组件渲染 `null`，旧 `workbench` 面板与 `mountSidebarEntry` 注册行一字未改；专项脚本 `verify-workflow-readonly-client.mjs` **12 项 310 条断言**全通过、12 条变异全部被抓；老大退回的读故障误报已修——`/health` 成功而 `/runs` 503、详情非 404 失败、探针后断网都判 `status:'error'` 并显示「读取失败」，`loadReadonlyState` 与页面刷新保证不 reject（`unhandledRejection` 计数为 0），只有 `run_not_found` 与真正的空列表才给空态文案；**本批没有任何写入口**——草稿提交/确认/暂停/继续仍被可信身份门（M0-B）阻塞）。；B5 子批「端到端假服务闭环（W1-08）」已完成第二轮定向补证并修正 E2E-06 恒真断言、**待独立签收**（新增 `scripts/verify-workflow-m1-endtoend.mjs`，仅用临时 SQLite + 脱敏模板 + 进程内假执行器串跑有人工节点与无人工节点两份固定模板：无人工模板三步自动推进至 completed 且无待办；人工模板手改后下游由假服务新增的 `host.runNode` 跑，**输出由读回的父快照内容派生**（测试不再传任何节点内容），保存草稿不推进、重启恢复同一待办与草稿、原文直接确认仍保留 human 采用；A37 三类停止路径各有反例且**原因由执行器写回内核并停止**——硬校验超限 `schema_invalid:content_too_large`（运行 paused 且原因记录、Attempt failed、一条带 reason 的 `attempt.failed`，租约过期后 claim 仍 `run_paused`、显式 resume 才重试）、必需检查未评估时不 completed 且 `resume` 被 `publish_conflict` 拒、上游对象被删报 `artifact_missing:parent_object_missing` 同样记录原因并停止、租约到期不复活；另加输入链同长度篡改即失败（`parent_content_mismatch`）与两条孤儿快照变异；专项 **8 项 132 条断言**全通过，7 条变异全部被抓（含老大退回的 E2E-06 恒真断言：改为按 `source_attempt_id` 查并带正控，旧写法在 `${attemptId}:ghost` 孤儿快照下会漏判）；**内核未改**，`m1-kernel.mjs` sha256 与 B4-2 签收时一致）。

## 范围与边界

本轮只使用临时 SQLite（`mkdtemp` 下的一次性库文件）、脱敏 fixture、临时对象/manifest 目录和假执行器。没有调用真实模型、生产数据库、真实 HTTP 或额外插件。该模块是 M1-W1 隔离实验内核；B4 子批把工作流内测页以**默认关闭的薄挂载**接进宿主入口，用独立路由 `/workbench-workflow` 与独立库文件，旧工作台面板（`/workbench-api`）的行为与数据不变；旧 notes/modules/JsonStore 路径未修改，内核在非 SQLite 句柄上直接抛 `workflow_requires_sqlite`，不会回退 JSON。

## 产物

- `src/workflow/m1-kernel.mjs`：SQLite-only workflow kernel，创建 `workflow_runs`、`workflow_steps`、`workflow_attempts`、`workflow_snapshots`、`workflow_drafts`、`workflow_adoptions`、`workflow_events`、`workflow_outbox`、`workflow_human_tasks`、`workflow_requests`。
- `scripts/fake-workflow-executor.mjs`：success/failure/delayed/duplicate/unknown 假执行器结果；失败路径改走内核 `markFailed`，不再直接写表。
- `scripts/verify-workflow-m1.mjs`：实现侧专项测试，108 项断言（含线性调度不得越步领取）。
- `scripts/verify-workflow-m1-independent.mjs`：独立验收脚本，C1–C22 二十二项边界检查，每项独立临时库与临时根目录。
- `src/workflow/m1-fake-service.mjs`：假业务服务（G-01–G-10 工具面 + 宿主侧对象），进程内实现，不监听端口。
- `scripts/verify-workflow-m1-service.mjs`：B1 服务专项脚本，S1–S24 二十四项边界检查，共 457 条断言，每次检查独立临时库与临时对象根。
- `src/workflow/m1-context.mjs`：B2 上下文组装（捕获 + 稳定拼装 + 内容指纹 + 收据）；纯逻辑，不读生产资料、不调模型。
- `scripts/verify-workflow-m1-context.mjs`：B2 上下文专项脚本，11 项 106 条断言（CTX-01–CTX-06、CTX-08、CTX-08B、CTX-08C、CTX-02B 与槽位/估算自检），每次检查独立临时根。
- `src/workflow/m1-kernel.mjs`：B3 在内核新增只读 `readSnapshot`/`verifySnapshot`、`exportSnapshot`、`scanRecoverable`、`pruneRequests` 与 `RECOVERY_KINDS`；不改既有状态机与方法签名。
- `scripts/verify-workflow-m1-recovery.mjs`：B3 恢复专项脚本，8 项 112 条断言（REC-01–REC-08），每次检查独立临时库与临时根目录。
- `src/client/workflow/readonly-core.mjs`：B4-3 只读客户端逻辑（无 React/DOM）：GET 计划、假 `fetchImpl` 数据源、运行/步骤/历史/错误摘要。
- `src/client/workflow/readonly-panel.ts`：B4-3 只读页面（步骤/历史/错误三块）与探针通过后才挂的侧栏入口。
- `scripts/verify-workflow-readonly-client.mjs`：B4-3 专项脚本，12 项 310 条断言（RC-01–RC-12），用注入的假 `fetchImpl` 驱动，不发真实 HTTP。
- `src/host/workflow-page.ts`：B4 子批工作流内测页宿主薄挂载（默认关闭、无 SQLite 独立禁用、库文件物理隔离、初始化失败隔离），独立路由 `/workbench-workflow` 与独立库文件；只读路由，不改内核状态。
- `scripts/verify-workflow-page-mount.mjs`：B4 子批挂载专项脚本，12 项 134 条断言（PM-01–PM-12），测 `lib/index.js` 构建产物 + 假 ctx 真实注册的路由；含库文件同路径/别名/改名副本三类隔离反例。
- `src/workflow/m1-kernel.mjs`（B4-2 增量）：新增 `INPUT_SCHEMA_DIALECT='workflow-input/1'`、`validateInputSchemaDefinition`，`createRun` 增 `inputSchema` 参数并建时校验方言，`claim` 领取前校验输入（失败关闭），`adoptTx`/`confirmHuman` 增 `intent:'continue'|'pause'`，作废人工步骤时一并搁置其待办、重新领取时重开并保留草稿。
- `src/workflow/m1-fake-service.mjs`（B4-2 增量）：`startRun` 增 `inputSchema` 并在授权前校验方言与值；`confirmHumanTask` 增 `intent` 值域校验与伪造身份拒绝（`actor_id_not_authenticated`）。
- `scripts/verify-workflow-m1-human-confirm.mjs`：B4-2 专项脚本，16 项 196 条断言（HC-01–HC-16），覆盖 A10 执行前拒绝（方言 + 类型-约束相容性 + 自有键/显式 null）与 A36 确认/暂停语义，每项独立临时库。
- `scripts/probe-schema-dialect.mjs`：方言探针，复现老大复核时给出的两个 A10 反例并打印当前结果。

## 本轮修复（第三轮）

| 项 | 处理 | 证据 |
| --- | --- | --- |
| 父快照链 | `parentSnapshotFor` 统一返回快照 ID：同一步再采用取上一采用快照，跨步骤取最近上游已采用快照 | C1、C2 |
| 人工确认幂等重放 | 幂等键在状态校验之前生效，重放返回原 adoption 并标 `replayed:true`，不新增 snapshot/adoption | C3 |
| 租约超时 | `adopt` 校验 `lease_until`，过期抛 `lease_expired`；`claim` 先 `reapExpiredLeases` 把过期 Attempt 判 `expired` 并把步骤退回可领取 | C4 |
| 取消态 | 新增 `cancelRun`；已取消/已完成 run 的 `claim` 抛 `run_not_claimable` | C5 |
| stale 传播 | 上游再采用后，下游 `succeeded/waiting_review/running` 步骤置 `stale` 并置位 `stale=1`，计数进事件 | C6 |
| 累计预算 | `claim` 走 `chargeBudget`，`budget_used` 递增，达 `budget_total` 抛 `budget_exhausted` | C7 |
| outbox 状态机 | 同目标新采用把旧 `pending` 置 `superseded`；`completeOutbox` 支持 succeeded/failed；新增 `retryOutbox` 从 failed 回 pending | C8 |
| manifest 校验 | `adopt` 读取磁盘 manifest，比对 `contentHash` 与整体 `hash(onDisk)===candidate.manifestHash`，不符抛 `manifest_mismatch` | C9 |
| 事务与孤儿清理 | `saveDraft` 纳入事务；`adopt` 失败走 `cleanupCandidate` 清理未被引用的对象与 manifest | C10 |
| 存储边界 | 非 SQLite 句柄抛 `workflow_requires_sqlite`，导出 `WorkflowRequiresSqliteError` | C11 |

## 第四轮局部修复（老大独立核查退回）

| 反例 | 根因 | 处理 | 证据 |
| --- | --- | --- | --- |
| `cancelRun` 后 `confirmHuman` 仍能采用，并把 run 从 `cancelled` 改回 `completed`（违反 A07） | `adoptTx` 不看 run 状态，`succeed` 分支无条件 `setRunStatus`；`cancelRun` 只终结步骤与在途自动 Attempt，未关闭待办 | `adoptTx` 在读 step 后即校验 run，`completed`/`failed`/`cancelled` 抛 `run_closed`；`cancelRun` 把该 run 的 open 待办置 `cancelled`，迟到确认因此抛 `cas_conflict` | C12、实现侧 66 项中的取消终态断言 |
| 上游重采用把下游置 stale 后，变更前已在运行的下游 Attempt 仍可 `adopt` 并清掉 stale（违反 A03） | `markDownstreamStale` 只改 step 状态，不动在途 Attempt；`adoptTx` 也不校验 `stale` | `markDownstreamStale` 同时把下游在途 `running` Attempt 置 `superseded`/`upstream_changed` 并记录进事件；`adoptTx` 增加 `stale`/`step_stale` 校验；stale 覆盖范围扩到 `paused` | C13、实现侧 66 项中的超期下游断言 |

两处修复都是失败即回滚（`transaction` 内抛错），不会留下半步状态：C12 断言 `workflow_adoptions` 无新增行，C13 断言 `r13:step:2` 仍为 `stale` 且无 adoption。

## 第五轮修复：必需发布完成条件（老大独立核查退回）

老大复现的阶段阻塞：单步 `adopt(target='pd:fixture')` 后 `workflow_runs.status='completed'`，而 `workflow_outbox.status='pending'`，违反 [10-testing-release-governance.md](../../../workflow-plan/10-testing-release-governance.md) 的 A06/A11/A36「必需发布冲突不记成功」。

根因：`adoptTx` 只用「剩余未结束步骤数」决定 run 状态，完全没有看本运行声明的发布项；outbox 只是被插入，没有任何路径把发布结果回灌到 run。

按 [01-domain-model.md](../../../workflow-plan/01-domain-model.md)（`succeeded` 要求所有必需输出已采用**且**所有必需发布目标已完成）与 [08-storage-migration.md](../../../workflow-plan/08-storage-migration.md)（发布按 `pending/running/succeeded/conflict/failed/outcome_unknown/superseded/cancelled` 分别记录；必需目标冲突/失败时运行 paused；取消不假设撤销成功）改：

| 项 | 处理 | 证据 |
| --- | --- | --- |
| 完成条件 | 新增 `settleRun(runId)`：全部必需步骤已采用 **且** 没有未终结的必需发布（`pending`/`running`）才 `completed`；步骤都采用但发布未完则保持 `running`，不提前记成功 | C14、实现侧「run waits for the required publish」 |
| 发布结果回灌 | `completeOutbox` 支持 `succeeded`/`failed`/`conflict`/`outcome_unknown`，返回 `{outboxId,status,runStatus}` 并触发 `settleRun`；CAS 只接受 `pending`/`running` | C14、C15、C16 |
| 失败/冲突 | 必需发布 `failed`/`conflict` → run `paused`，`pause_reason` 分别为 `publish_failed`/`publish_conflict`，写 `run.publish_blocked` 事件 | C15 |
| 未知结果 | `outcome_unknown` → run `paused`（`publish_outcome_unknown`）；`retryOutbox` 对未知项抛 `outbox_requires_reconcile`；当时新增 `reconcileOutbox(id,'published'|'not_published')` 对账（历史接口，2026-11-14 已删除定义与导出；当前用带实际观测的 `reconcilePublishEffect`，缺证据旧行继续隔离） | C16 |
| 暂停意图 | 暂停中只更新结构化原因、不自动推进：阻塞换了形态就改 `pause_reason`，阻塞解除则清空原因并写 `run.publish_resolved`，等用户显式 continue；`resume` 在仍有必需发布阻塞时抛 `publish_unresolved`，无可领取步骤但发布已收敛时直接收敛为 `completed` | C15、C16 |
| 取消 × 发布 | 未领取的发布置 `superseded`（`run_cancelled`）；已发起的置 `outcome_unknown`（`cancel_requested`），不能假设撤销成功；取消后对账 `not_published` 落到 `superseded`、绝不续发 | C17 |
| 取消 × 未知执行结果 | 终态运行的未知 Attempt 只记账：`reconcileUnknown` 把 Attempt 置 `reconciled`、`outcome` 记 `${outcome}_run_closed`，写 `attempt.reconciled_after_close`，不采用、不改 run 状态 | C18 |
| 可选发布 | outbox 增 `required` 列（默认 1）与 `reason`/`updated_at`；`settleRun` 只按必需项判完成，可选失败不阻断但单列 | C14、实现侧「optional publish does not block completion」 |

`workflow_outbox` 表结构随之扩展（`required`/`reason`/`updated_at`），仍只在临时 SQLite 中创建，未触碰生产库。

变异测试（`C:/Users/gh/AppData/Local/Temp/m1-mutation`，把 `settleRun` 换回旧的「剩余步骤数决定状态」）：独立脚本 C14–C17 全部 FAIL，其中 C14 报 `run status=completed but the required publish is still pending` —— 与老大复现的现象一致；还原后 18/18 通过。

## 第六轮修复：显式继续门（老大独立核查退回）

老大复现的阶段阻塞：两步运行中第 1 步采用并创建必需 outbox，`completeOutbox(failed)` 把 run 置 `paused/publish_failed` 后，未调用 `resume` 即 `claim` 成功领取第 2 步，并把 run 改回 `running`、`pause_reason` 清空。

根因：`claim` 只拒绝 `CLOSED_RUN_STATES`（`completed`/`failed`/`cancelled`），`paused` 与 `waiting_review` 都能被直接领取；而 `claim` 末尾无条件 `setRunStatus(runId,'running')`，于是暂停意图被静默清除。另外 `settleRun` 里 `waiting_review` 是原样返回、不看是否真有未终结待办，人工确认后状态也不会自动回到 `running`。

按 [01-domain-model.md](../../../workflow-plan/01-domain-model.md)（暂停等待用户继续；等待不占槽、确认后才推进）与 [10-testing-release-governance.md](../../../workflow-plan/10-testing-release-governance.md) A36（确认并暂停 / 暂停中确认）改：

| 项 | 处理 | 证据 |
| --- | --- | --- |
| 显式继续门 | `claim` 在读步骤前先判状态：`paused` 抛 `run_paused`，`waiting_review` 抛 `run_waiting_review`，两者都不改 run 状态、不领步骤 | C19、C20、C22 |
| 阻塞解除但未继续 | 发布阻塞解除后 `settleRun` 只清 `pause_reason` 并写 `run.publish_resolved`，status 仍为 `paused`；此时 `claim` 继续拒绝，只有 `resume` 能推进 | C19 |
| 正常人工等待 | `settleRun` 改看真实未终结待办数（`workflow_human_tasks.status='open'`）：有则 `waiting_review`，确认后回到 `running`；等待期间 `claim` 抛 `run_waiting_review`，不能越过待办领后续步骤 | C21 |
| Attempt 失败后暂停 | `markFailed` 置 `paused` + 步骤回 `paused` 后，`claim` 抛 `run_paused`；`resume` 后才重新领取（`attempt_no` 递增） | C20 |
| 对账后的状态 | `reconcileUnknown(not_executed)` 仍停 `paused`，`claim` 拒绝，须 `resume`；`reconcileUnknown(executed)` 补采用后也保持 `paused`，显式 `resume` 才收敛为 `completed` | C22 |
| resume 收敛 | `resume` 在置 `created` 后立即调 `settleRun`，不留下 `created` 中间态；无可领取步骤但发布已收敛时直接 `completed` | C16、C19 |

变异测试（`C:/Users/gh/AppData/Local/Temp/m1-mutation2`，删掉 `claim` 里的两行状态门）：独立脚本 C19–C22 全部 FAIL，均报 `claim ... returned null`（即 claim 未抛错、成功领取）—— 与老大复现一致；还原后 22/22 通过。

## B2 上下文组装（K1-01/02/03，CTX-01–06/08）— 老大局部签收

依据 `docs/workflow-plan/17-context-knowledge-development.md` §5.1 的 `ContextManifest` / `ContextDeliveryReceipt` 字段与 §5.2 的拼装/失败规则，在 `src/workflow/m1-context.mjs` 实现两层：

- 捕获（`captureContext`）：授权目录先 `realpath`，每条目录可带 `productId` 归属绑定；读到真实路径后按**最具体的授权目录**判定归属，**归属判定对所有 scope 生效**（绑定了其他产品的目录，条目改标 `project` 或 `private` 也一样拒绝），产品范围的条目还必须落在绑定同一 `productId` 的目录里，否则 `context_scope_denied`（`product_path_unbound` / `product_path_mismatch`）。私人范围要求更高：该目录必须**逐条显式** `allowPrivate: true`、必须**绑定 `productId`** 且绑定归属与当前身份一致——未绑定的共享根即使开了 `allowPrivate` 也一律 `private_path_unbound`，所以私人资料只能来自自己的独立授权目录。读字节后按 `whole | section | range` 切出实际选取片段，写入内容寻址 blob（`context/<前两位>/<sha256>`，先临时文件再 rename）。`sourceHash` 与 `capturedHash` 分别记录，不混用。
- 拼装（`assembleContext`）：纯函数。稳定排序按 `contract > role > constraint > fact > upstream > reference` 槽位，再 `order`、`sourceId`；**预算按实际交付正文计费**（`## [slot] sourceId` 标题行、换行与段间分隔符都算，`budget.basis='delivered-payload'`）；可选条目按 priority 从高到低占预算、放不下的整条省略并记原因、渲染字节与片段字节；必需条目超限直接阻止并报 `required:实际载荷>预算:来源`。

| 检查 | 覆盖的行为 | 关键点 |
| --- | --- | --- |
| CTX-01 | 同输入、配置、拼装版本重复组装 | 两次组装（不同 runId/attemptId）得到同一正文与同一 `contentFingerprint`、同一 `payloadHash`；`manifestHash` 因覆盖执行关联而允许不同；**打乱传入条目顺序不改变结果** |
| CTX-02 | 缺必需 / 越界路径 / 必需超限 | 必需资料缺失在拼装前抛 `context_missing_required` 并指名来源；可选缺失只记 `missing` 不阻止；白名单外路径（含 `..` 与符号链接逃逸）抛 `context_path_out_of_scope` 且发生在读取之前；必需超预算抛 `context_budget_exceeded` 并报 `required:需求>预算:来源`，不截断 |
| CTX-03 | 可选参考超预算 | 预算只够放一条时保留高 priority、舍低 priority；省略收据含 `budget_exceeded`、渲染字节、片段字节、priority；必需条目永不省略；省略内容不出现在正文；同一输入两次得到同一省略集合；`usedTokens` 恰好等于交付载荷换算值 |
| CTX-04 | 冻结后改删源 | 改写源文件、删除源文件后，从 blob 读回的字节与 `capturedHash` 仍一致，重拼正文与指纹不变；新捕获才看到新内容（指纹变化），旧捕获不自动换版本 |
| CTX-05 | 人工改上游后旧 Attempt 迟到 | 上游 revision 1→2 时 `assertUpstreamFresh` 抛 `context_stale`（含 `1->2`）；旧 Attempt 重拼仍是旧指纹（不热替换）；新 Attempt 用新 revision 得到新指纹；上游消失报 `upstream_missing` |
| CTX-06 | 双窗口 / 重复回调 / 恢复重领 | 重复组装幂等、不修改传入 spec；同一 attempt 两个窗口组装出的正文与指纹一致；内核层面第二次 `claim` 抛 `step_not_claimable`，`workflow_steps` 里 running 步骤恒为 1 |
| CTX-08 | 两产品 + 私人记忆 | 用 p1 资料给 p2 建上下文抛 `context_scope_denied:other_product`；产品目录白名单外抛 `context_path_out_of_scope`；私人范围默认 `context_scope_denied:private_not_allowed`，显式 `allowPrivate` 才进入且改变指纹；默认输入不含私人内容 |
| CTX-08B | 共享未绑定目录不得授权产品资料（退回反例） | 只给整个 workspace（`[{path: workspace}]`）时，p2 条目自报 `productId=p2` 却指向 `workspace/p1/secret.md` → `context_scope_denied:product_path_unbound`；再叠加更窄的 p1 授权目录 → `product_path_mismatch`；两个产品各自绑定目录后，p2 只拿到自己的正文 |
| CTX-08C | 归属目录在**任何 scope** 下都不能被别的产品读；私人资料必须有自己的绑定目录（退回反例） | 授权拓扑 `[共享未绑定根, p1 专属根, p2 专属根, p1 私人根(绑定 p1), p2 私人根(绑定 p2)]`、身份 p2：`p1/secret.md` 改标 `scope=project` → `product_path_mismatch`；改标 `scope=private` → 同样 `product_path_mismatch`；**老大第三次复现的原拓扑**（只给 `[{path:root, allowPrivate:true}]`）把 `root/memory/p1/secret.md` 标成 p2 的 private → `private_path_unbound`，`foreignPrivateDelivered=false`；共享根承载散落私人笔记 → 同样 `private_path_unbound`。正例：项目级资料走共享根可交付；p1 读**自己绑定**的私人目录交付 `P1-PRIVATE-ONLY`；p2 读自己私人目录交付 `my own notes`；p2 只拿到自己绑定的产品正文 |
| CTX-02B | 预算按实际交付载荷计费（退回反例） | 必需内容 1 字节、`totalTokens=1` → 抛 `context_budget_exceeded` 且 detail 为 `required:4>1:a.md`（不是 1）；预算给到 4 时成功，`payload` 恰为 `## [fact] a.md` + 换行 + `A`、`usedTokens=4`、`deliveredBytes=16`；1 字节的可选条目在只剩片段预算时整条省略并记 `renderedBytes` |
| SORT-01 | 槽位顺序与 token 估算 | 槽位顺序严格是 `contract>role>fact>reference`；`estimateTokens = ceil(bytes/4)`；manifest 与收据都把 token 标为 `approximate` |

本批顺带修的内核缺口（B2 发现，属隔离工作流模块内）：`claim` 原来按「任一可领取步骤」取最早一条，前一步在 `running` 时会越过它领到后继步骤，同一 run 可并行派发两步（违反线性调度与 CTX-06 的无双派发）。现改为只看链条上第一个未 `succeeded`/`cancelled` 的步骤，不可领取即 `step_not_claimable`；实现侧新增 5 项断言（越步被拒、后继步骤无 Attempt、前一步采用后第二步才可领、绑定 `:step:2:attempt:1`）。

B2 退回的四项修复（老大独立复现；每批只修退回项，未启动 B3）：

1. **共享白名单跨产品读取**（`src/workflow/m1-context.mjs` 的 `normalizeRoots` / `pickRoot` 与 `captureContext` 的归属判定）：旧实现只比对条目自报的 `productId` 标签，`allowedRoots=[workspace]` 时 p2 条目指向 `workspace/p1/secret.md` 也能通过。现在授权目录是「路径 + 可选 `productId`」的记录，命中多个目录时按最具体（最长路径）那一条判定归属；未绑定目录只授权项目级资料，产品范围必须落在自己绑定的目录内。**接口收紧**：字符串形式的 `allowedRoots` 不再能授权产品资料（会报 `product_path_unbound`），调用方必须显式绑定产品目录，符合 17 §7.1「不能仅凭 projectPath 判断可以跨产品读取」。
2. **预算只算片段**（`assembleContext` 的 `renderEntry` / `payloadTokens`）：旧实现累计 `capturedBytes/4`，不计标题行与分隔符，1 字节必需内容在 1 token 预算下交付了 16 字节正文。现在必需与可选同口径，按渲染后的实际交付载荷计费，逐条重渲染判断是否放得下；省略收据同时记 `renderedBytes` 与 `capturedBytes`，`receipt.deliveredBytes` 与 `entryDelivery[].deliveredBytes` 改为渲染字节，并新增 `deliveredTokens`。
3. **归属校验只覆盖 `scope=product`**（老大第二次退回的两个反例）：`allowedRoots=[共享未绑定根, p1 专属根, p2 专属根]`、当前身份 p2 时，把 `p1/secret.md` 改标 `scope=project`，或在 `allowPrivate=true` 时改标 `scope=private`，两条路径都能交付 p1 内容。现在把归属判定提到 scope 分支之前、对**所有 scope** 生效：`rootEntry.productId` 与当前 `productId` 不符即 `context_scope_denied:product_path_mismatch`；同时把目录级 `allowPrivate` 从「默认放行」改成「逐条显式声明才放行」。项目级资料仍走共享未绑定根。
4. **未绑定共享根一次放行私人资料**（老大第三次退回）：`allowPrivate` 只要求「逐条显式」仍不够——`{path: root, allowPrivate: true}` 这一条未绑定根就能批准它下面**所有**私人文件，p2 把 `root/memory/p1/secret.md` 标成 `scope=private` 即交付（`foreignPrivateDelivered=true`）。现在 `scope=private` 要同时满足：目录逐条显式 `allowPrivate` **且** 目录绑定 `productId` **且** 绑定归属与当前身份一致；未绑定根一律 `context_scope_denied:private_path_unbound`。私人资料因此必须有自己的独立授权目录，`CTX-08C` 的私人正例也已改成给 p1/p2 各自绑定目录授权。

变异测试（临时文件，跑完即删，未留在仓库）：把 `claim` 还原成旧的「任一可领取」写法 → `verify-workflow-m1.mjs` exit 1（`Missing expected exception`）、CTX-06 FAIL（`expected step_not_claimable but the call succeeded`）；把可选条目的 priority 排序反过来 → CTX-03 FAIL（`lowest priority drops first, dropped=mid.md|high.md`）；去掉必需缺失的阻止分支 → CTX-02 FAIL（`expected context_missing_required but the call succeeded`）；去掉私人范围的授权判定 → CTX-08 FAIL（`expected context_scope_denied but the call succeeded`）；把目录归属判定改回「只比对声明标签」（`if (scope === 'product' && false)`）→ CTX-08B FAIL（`expected context_scope_denied but the call succeeded`）；把预算改回片段累加（`sum of estimatedTokens`）→ CTX-02B FAIL（`expected context_budget_exceeded but the call succeeded`）与 CTX-03 FAIL（`budget must be charged by the delivered payload, used=154`）；把归属判定退回「只对 `scope=product` 生效」→ CTX-08C FAIL（`expected context_scope_denied but the call succeeded`，即 p1 文件以 `scope=project` 交付给 p2）；把目录级 `allowPrivate` 改回默认放行（`!== false`）→ CTX-08C FAIL（共享根承载私人资料）；把私人范围的规则退回「只要 `allowPrivate` 就放行」（第四轮前的原实现）→ CTX-08C FAIL（`expected context_scope_denied but the call succeeded`，即 `foreignPrivateDelivered=true` 那条）；只删掉 `private_path_unbound` 那行、其余保留 → 同样 CTX-08C FAIL。还原后 11/11、106 条断言全绿（`src/workflow/m1-context.mjs` 复原 sha256 `7b901abef2a8fb0b46f2cdf54b5e445eb0ea9e1626784adc2580ecd98e56cb9f`）。

老大第三次复现的原拓扑已单独跑过探针（临时脚本，跑完即删）：`allowedRoots:[{path:root, allowPrivate:true}]`、身份 `productId='p2'`、`root/memory/p1/secret.md` 标 `scope=private` → `{"foreignPrivateDelivered": false, "error": {"code": "context_scope_denied", "detail": "memory/p1/secret.md:private_path_unbound"}}`。

边界：本批只有临时目录 + 假身份；授权目录的产品归属由调用方显式绑定（不做路径推断，也不读资料清单表）；**没有**真实宿主确认（收据 `verification: 'captured'`，CTX-07 的宿主确认/截断探测属 M2）、没有真实模型、没有接主入口；旧 notes/modules 与 JsonStore 未修改。

## B3 恢复、备份与只读导出（W1-03 导出、W1-05 扫描，A06/A09/A14 副本路径）— 老大局部签收（第三轮）

依据 `docs/workflow-plan/11-roadmap-backlog.md` 的 W1-03/W1-05 与 08 §发布对账、09 §恢复，在 `src/workflow/m1-kernel.mjs` 增加四个入口（均为隔离工作流模块内，不接主入口、不注册宿主工具）：

- `verifySnapshot(id)` / `readSnapshot(id)`：把「数据库行、manifest 文件、对象文件」三方对齐后返回内容与 hash。任一处不符分别报 `snapshot_not_found` / `snapshot_manifest_missing` / `snapshot_manifest_mismatch` / `snapshot_object_missing` / `snapshot_content_mismatch` / `snapshot_identity_mismatch` / `snapshot_metadata_mismatch`（detail 带 `:row_missing` / `:manifest_hash` / `:manifest_content_hash` / `:object_missing` / `:content_hash` / `:bytes` / `:manifest_snapshot_id` / `:attempt_snapshot_id` / `:artifact_type`）。只读：不写库、不写盘、不改状态。

「三方对齐」的具体口径：manifest 的 `snapshotId` 必须同时等于行 id 与 `${source_attempt_id}:snapshot`；`artifactType` 必须等于行的 `artifact_type`；`contentHash` 必须等于行的 `content_hash`；行的 `manifest_hash` 必须等于 `hash(manifest)`；对象文件存在、`hash(对象)` 等于行 `content_hash`、字节数等于 manifest 的 `bytes`。**已知边界**：manifest 只声明 `snapshotId` / `artifactType` / `contentHash` / `bytes` / `relativePath`，所以 `parent_id`、`author_type`、`created_at` 没有独立副本可对照，这几个字段的完整性只能依赖数据库自身（后续靠事件日志/审计链交叉验证，不在 B3 范围）。`relativePath` 不参与比对是有意的：备份还原会换根目录，绝对路径必然不同。
- `exportSnapshot(id, dir, { expectedHash })`：先按同一套三方校验核对，再导出到独立目录（临时文件 + rename，文件名取 `snapshotId` 加 `contentHash` 前 8 位），落盘后**回读再校验一次**（`:export_roundtrip`）。给了 `expectedHash` 但与记录不符即 `snapshot_hash_mismatch`，不落盘。
- `scanRecoverable({ now })`：纯读扫描重启/断电后需要接续或对账的条目，返回 `{ scannedAt, total, items[] }`，`kind` 取值见导出的 `RECOVERY_KINDS`（`lease_expired` / `outbox_outcome_unknown` / `outbox_running` / `outbox_pending` / `step_stale` / `step_paused` / `run_paused`；当前七类，running 仅发现，恢复转换尚未完成）。它**只报不改**，真正的领回仍走 `claim`（内部 `reapExpiredLeases`），避免两处各自改写租约。
- `pruneRequests({ retentionMs, now })`：幂等请求保留期清理，只删窗口外的 `workflow_requests`，返回 `{ removed, cutoff, retentionMs }`；窗口内的重放仍返回原结果；`retentionMs` 非法报 `request_retention_invalid`。
- 连接参数补 `PRAGMA busy_timeout = 5000`：双连接竞争时前者让后者等待而不是立刻 `SQLITE_BUSY`。

| 检查 | 覆盖的行为 | 关键点 |
| --- | --- | --- |
| REC-01 | 快照只读读取 | 内容、`contentHash`、`manifestHash`、父指针（第一条为 `null`）、`authorType`、`sourceAttemptId`、字节数都可取回且 `verified=true`；重复读取结果完全一致；读取前后 9 张表按 rowid 串联的指纹不变、对象/manifest 文件清单不变；未知快照报 `snapshot_not_found` |
| REC-02 | 校验导出 | 导出文件位于指定目录内、字节与快照一致、导出内容重新 hash 等于记录的 `contentHash`；`expectedHash` 不符报 `snapshot_hash_mismatch` 且不产生文件；不给 `expectedHash` 时仍按数据库记录自校验；导出不改库、不碰对象文件 |
| REC-03 | 副本备份还原 + 篡改检测 + 身份/类型对齐 | 整根复制（`objects/`、`manifests/`、`workflow.sqlite` 及 `-wal`/`-shm`）后在副本路径重开，读回与导出内容仍与原始 hash 一致；**同长度篡改**对象字节 → `snapshot_content_mismatch:content_hash`（字节数校验看不出来，只有内容 hash 能抓到）；改 manifest 的 `bytes` → `snapshot_manifest_mismatch`；**只改数据库行 id 为 `forged-id`（manifest 字节未变、manifest hash 仍匹配）→ `snapshot_identity_mismatch:manifest_snapshot_id`**，`readSnapshot`/`exportSnapshot` 同时拒绝，原 id 变 `snapshot_not_found`，并断言 `manifest_hash` 未变以证明「只有身份能抓到」；**只改数据库 `artifact_type` 为 `forged-artifact`（manifest 字节未变、manifest hash 与内容 hash 仍匹配）→ `snapshot_metadata_mismatch:artifact_type`**，`readSnapshot`/`exportSnapshot` 同时拒绝且不留下导出文件，并断言其余列未动以证明「只有类型比对能抓到」；两个反向用例分别只改 manifest 的 `snapshotId` / `artifactType` → 均 `snapshot_manifest_mismatch`；恢复两处后 `verified=true` 且类型回到 `text` |
| REC-04 | 进程中断后重开只接续不重复发起 | 首次 claim 并 `storeCandidate` 后关闭连接；重开后该 Attempt 仍是 `running`，租约未到期时 `scanRecoverable` **不报**过期；停机超过租约后扫描恰好报一条并指向卡住的步骤，且扫描本身不改状态；下一次 `claim` 生成 `:attempt:2`，旧 Attempt 变 `expired/lease_expired`、新 Attempt `running`，同一步骤只有 2 条 Attempt 且 id 唯一；事件追加而非重放，前缀 seq/type 不变、seq 连续 |
| REC-05 | 双连接**顺序交错**调用同一 claim | 两个 `DatabaseSync` 连同一库，左先领、右再领：右连接 `step_not_claimable`，库里只留 1 条 Attempt 且归属先到者，`budget_used=1`（预算不重复扣）；反向再跑一次，证明任一连接都可能成为后到者。**这是单线程交错调用，不是并发压测**，不构成多线程/多进程同时 claim 的互斥证据 |
| REC-06 | 事件 seq 在**交替**写入下连续 | 两个连接单线程交替各追加 5 条事件后 seq 恰好 1..11，无空号无重号；随后任何一方追加都从最后 seq 继续。**同样是顺序交替，不是并发压测**；同事务 `MAX(seq)+1` 的跨进程互斥依赖 `BEGIN IMMEDIATE`，未做多进程压力验证 |
| REC-07 | 幂等请求保留期清理 | 窗口内重放返回原结果且 `replayed=true`；宽窗口 `pruneRequests` 删除 0 条；过期窗口删除 ≥1 条且该 key 从库里消失；清理后再用同 key 建同 id 的运行按 `run_exists` 拒绝；`retentionMs=-1` 报 `request_retention_invalid` |
| REC-08 | 可恢复扫描七类**正反例** + 纯读 | 场景含必需 pending 发布、可选 pending 发布、`outcome_unknown` 发布、过期租约、`stale` 步骤、被确认中止的暂停步骤、显式暂停运行、已完成运行；当前新增已领取 running 发布正反例，扫描一次报齐七类（`items=9`，`kinds` 覆盖 `RECOVERY_KINDS` 全七项）；以下原始 B3 输出保留为历史记录；**每类都有反例**：可选 pending 不算 `outbox_pending`、pending 不算 `unknown`、被取消 Attempt 不算过期租约、未过期租约不报、`succeeded` 步骤不算 `stale`/`paused`、`completed` 运行一概不出现；同一 `now` 两次扫描逐字节相同（`scannedAt` 回显传入时钟），扫描前后库指纹不变；快照 id 不会被误当成 run id |

变异测试（`src/workflow/m1-kernel.mjs` 临时改写后即还原，未留在仓库）：删掉读快照时的内容 hash 校验 → REC-03 FAIL（同长度篡改漏过）；删掉 `expectedHash` 比对 → REC-02 FAIL；把 `pruneRequests` 的 `WHERE created_at < ?` 去掉（无条件删除）→ REC-07 FAIL；把扫描的 `lease_until < ?` 换成恒真条件 → REC-04 FAIL（未到期的租约被报成过期，重启会把在途工作当成中断重发）；**删掉 `verifySnapshot` 的两条 `snapshot_identity_mismatch` 判定 → REC-03 FAIL（`expected snapshot_identity_mismatch but the call succeeded`，即老大用 `forged-id` 复现的绕过）**；**删掉扫描里 `outbox_pending` 的插入 → REC-08 FAIL（`a required pending publish is reported with run and target`）**；**删掉 `step_paused` 的插入 → REC-08 FAIL（`a paused step is reported`）**；**删掉 `manifest.artifactType !== row.artifact_type` 判定 → REC-03 FAIL（`expected snapshot_metadata_mismatch but the call succeeded`，独立探针同时恢复成 `readOk:true`、返回伪造类型）**。还原后 8/8、112 条断言全绿，`src/workflow/m1-kernel.mjs` 复原 sha256 `e4a9e3dc74d183f6ea93024e39067de154d6181f0717db2600d919e203a0e36e`。

可复现输出：

```
node scripts/verify-workflow-m1-recovery.mjs
{"checks":8,"passed":8,"assertions":112,...}
```

```
node scripts/verify-workflow-m1-recovery.mjs | python -c "import json,sys; d=json.load(sys.stdin); print({r['id']: r['status'] for r in d['results']})"
{'REC-01': 'pass', 'REC-02': 'pass', 'REC-03': 'pass', 'REC-04': 'pass', 'REC-05': 'pass', 'REC-06': 'pass', 'REC-07': 'pass', 'REC-08': 'pass'}
```

老大退回项的独立复现（临时探针脚本，跑完即删；路径 `mkdtemp`，不碰生产库）：只把 `workflow_snapshots.id` 改成 `forged-id`、manifest 与对象文件一字不动，修复后输出

```
{
 "manifestHashUnchanged": true,
 "originalRead": true,
 "forgedReadOk": false,
 "forgedReadError": { "code": "snapshot_identity_mismatch", "detail": "forged-id:manifest_snapshot_id" },
 "forgedExportError": { "code": "snapshot_identity_mismatch", "detail": "forged-id:manifest_snapshot_id" },
 "originalIdGone": "snapshot_not_found"
}
```

修复前同一探针返回 `forgedReadOk: true`（`verified:true`，manifest 仍声明原 snapshot id），即老大独立复现时看到的行为。`manifestHashUnchanged: true` 说明本次拦截来自显式身份比较，而不是 hash 校验；同一条断言已固化在 REC-03。

老大第二轮反例的独立复现（同法临时探针）：只把 `workflow_snapshots.artifact_type` 改成 `forged-artifact`、manifest 一字不动，

```
{
 "beforeType": "text",
 "manifestType": "text",
 "manifestHashUnchanged": true,
 "contentHashUnchanged": true,
 "readOk": false,
 "readError": { "code": "snapshot_metadata_mismatch", "detail": "run-probe:step:1:attempt:1:snapshot:artifact_type" },
 "exportError": { "code": "snapshot_metadata_mismatch", "detail": "run-probe:step:1:attempt:1:snapshot:artifact_type" }
}
```

修复前该探针返回 `readOk: true`、`forgedReturnedType: "forged-artifact"`，与老大复现一致。`manifestHashUnchanged` 与 `contentHashUnchanged` 同为 `true`，说明拦截来自类型比对而非任何 hash 校验。

边界：全部用 `mkdtemp` 临时库与临时根目录，备份目录同在临时根下；不碰生产库、不发 HTTP、不调真实模型、不注册宿主工具。`scanRecoverable` 只报不改，真正的租约回收仍在 `claim` 内；双连接只做了**顺序交错**调用验证（REC-05/06 明确标注不是并发压测），多线程/多进程同时 claim 与 events `seq` 竞争、断电边界仍属 M0-B。

## B4 子批：工作流内测页薄挂载与隔离（W1-07 / A13 宿主子集）— 待独立签收（第二轮：补库文件物理隔离）

依据 D1 决策（薄挂载到宿主新路由 + 默认关闭开关）与 [10-testing-release-governance.md](../../workflow-plan/10-testing-release-governance.md) 的 A13 原文「无 SQLite 时工作流独立禁用，不改用 JSON 写工作流、不影响主面板；模块初始化失败不破坏旧数据」。本子批**只做宿主薄挂载与隔离**，客户端页面（步骤列表 / 草稿编辑 / 确认暂停继续）仍属 B4 后续子批。

改动：

- 新增 `src/host/workflow-page.ts`：导出 `mountWorkflowPage`、`workflowPageEnabled`、`checkWorkflowDbIsolation`、`WORKFLOW_PAGE_PREFIX='/workbench-workflow'`、`WORKFLOW_PAGE_ENABLED_ENV='DSH_WORKBENCH_WORKFLOW_PAGE'`、`WORKFLOW_PAGE_DB_ENV`。四道闸门按顺序判定：
  1. **默认关闭**：只有 `DSH_WORKBENCH_WORKFLOW_PAGE` 显式为 `1/on/true/yes` 才继续；否则返回 `{enabled:false, reason:'disabled_by_config'}`，**不注册路由、不打开内核、不建任何文件**。
  2. **无 SQLite 独立禁用**：`engine !== 'sqlite'` 直接 `reason:'workflow_requires_sqlite'`，不打开内核、不写 JSON 工作流文件（A13 原文）。
  3. **库文件物理隔离**（第二轮新增，老大退回项）：在 `openWorkflowKernel` **之前**调 `checkWorkflowDbIsolation(workflowDbPath, legacyDbPath)`，三种拒绝都返回 `reason:'workflow_db_conflict'` 并附 `detail`：
     - `same_path`：canonical 路径相同。canonical = `realpath`（文件已存在）或 `realpath(父目录)+文件名`（尚未创建），Windows 上统一小写 —— 因此 `nested/../legacy.sqlite`、`./legacy.sqlite`、重复分隔符、`LEGACY.SQLITE` 全部命中。
     - `same_file`：两个路径 `realpath` 不同但 `stat` 的 `dev:ino` 相同 —— 抓硬链接（符号链接由 `realpath` 归结为 `same_path`）。
     - `foreign_database`：目标文件已存在且含非 `workflow_*` 表（`meta`、`spaces`、`notebooks`…）—— 抓「把旧库换个名字当工作流库」。读不出来（不是 SQLite / 是目录）不算冲突，交给内核报真实错误。
     - 为什么必须在建表前：`openWorkflowKernel` 一跑 `CREATE TABLE IF NOT EXISTS workflow_*` 就已落盘，事后校验再退出也来不及。宿主侧 `legacyDbPath` 传的是 `store.file`（旧库实际路径）；不传就只剩结构化判定，同路径反例会退化成 `foreign_database`。
  4. **初始化失败隔离**：内核打不开时只注册一条回 `503 {error:'workflow_disabled', reason:'workflow_init_failed', message}` 的路由并打一行 warn，不清理、不回滚、不影响同进程的 `/workbench-api`。库路径冲突走同一个 `unavailableMount(...)`，只是 `reason:'workflow_db_conflict'`。
- 独立库与独立对象目录：库默认 `dataDir()/dsh-workbench-workflow.sqlite`（可用 `DSH_WORKBENCH_WORKFLOW_DB` 覆盖），对象根 `dataDir()/workflow`。内测页再怎么坏都碰不到旧工作台库 `dsh-workbench.sqlite`。
- 薄路由（只读，不触发内核副作用）：`GET /health`（`enabled/engine/kernel/runs/recoverable`）、`GET /runs`（最近 50 个运行 + 可恢复条目数）、`GET /runs/:id`（运行详情 + 步骤 + 最近 20 条事件倒序转正序），其余 `404 not_found`。
- `src/host/index.ts`：`import { mountWorkflowPage, WORKFLOW_PAGE_PREFIX }`，在 `/workbench-api` 注册之后调用 `mountWorkflowPage({ engine: store.engine, dataDir: dataDir(), legacyDbPath: store.file, register, log })`，`register` 复用既有 `ctx.effect(...)` / `webServer.register` 写法。
- 新增 `scripts/verify-workflow-page-mount.mjs`：12 项 PM-01–PM-12、134 条断言。**测的是构建产物 `lib/index.js`**（`import('../lib/index.js')` + 假 ctx 捕获真实注册的路由 + 假 req/res），并断言产物里确实含内核 SQL 片段。PM-09–PM-11 直接读 `sqlite_master` 断言旧库里没有 `workflow_*` 表、`legacy_marker` 还在、文件 sha256 不变。

| 检查 | 覆盖的行为 | 关键点 |
| --- | --- | --- |
| PM-01 | 开关取值 | 只认 `1/on/true/yes`（含大小写与空格）；`''`、`0`、`off`、`no`、`false`、`disabled`、缺省一律关 |
| PM-02 | 默认关闭不产生任何副作用 | `register` 调用 0 次、`openKernel` 调用 0 次、不建 `dsh-workbench-workflow.sqlite`、不建 `workflow/` 目录 |
| PM-03 | 无 SQLite 独立禁用 | `engine:'json'` 时 `reason:'workflow_requires_sqlite'`，不打开内核、不建 `.sqlite`、不建 `.json` 工作流文件 |
| PM-04 | 初始化失败隔离（核心反例） | 用「库文件位置被目录占住」制造真实失败（`unable to open database file`）：新路由回 503 且带可读 `message`；同进程旧 `/state`、旧 `/notebooks` **响应体逐字节相等**，旧库文件 **sha256 与大小均不变**，不产生 `workflow/` 目录与默认工作流库 |
| PM-05 | 开启后薄路由可用 | 建出独立库与 `workflow/objects`；`/health` 返回 `enabled:true, engine:'sqlite', runs:0`；`/runs` 为空；`/runs/nope` 404 `run_not_found`；未知路径 404；同进程旧 `/state`、旧 `/health` 照常，且不写 JSON 工作流副本 |
| PM-06 | 默认关闭下的旧面板 | 注册路由清单恰好 `['/workbench-api']`，旧数据可读写（写笔记本、读回），调新路由时 `route_not_registered` |
| PM-07 | 关→开→关三段一致性 | 关闭态写入的旧数据在开启态与再次关闭态 **逐字节相同**，旧库 sha256 不变，工作流库必须是独立文件 |
| PM-08 | 构建证据 | `lib/index.js` 含 `PRAGMA busy_timeout`、`workflow_runs`、`snapshot_metadata_mismatch`、`/workbench-workflow`、`DSH_WORKBENCH_WORKFLOW_PAGE` |
| PM-09 | 同路径冲突反例（老大退回项） | 旧库先写 `legacy_marker='KEEP-ME'` 与一条笔记，再把 `DSH_WORKBENCH_WORKFLOW_DB` 指向旧库本身：新路由 503 `reason:'workflow_db_conflict'`、`message` 含 `same_path`；旧库 `sqlite_master` **仍无任何 `workflow_*` 表**、`legacy_marker` 仍为 `KEEP-ME`、sha256 不变、旧 `/state` 与旧 `/notebooks` 响应体逐字节不变 |
| PM-10 | 路径别名反例 | 相对段 `nested/../legacy.sqlite`、点段 `dir/./legacy.sqlite`、重复分隔符、Windows 大小写 `LEGACY.SQLITE` 全部 `same_path_as_legacy`；硬链接 `hard-legacy.sqlite` 报 `same_file_as_legacy`；符号链接无权限时如实记录 `EPERM` 跳过（不静默通过）。每种别名后都重新断言旧库无 `workflow_*` 表、marker 与 sha256 不变 |
| PM-11 | 指向旧库的改名副本 | 用 `VACUUM INTO` 复制旧库为 `old-workbench-copy.sqlite`（直接拷主文件会漏掉 `-wal` 里的建表语句，副本是空库，测不到这条），指向副本时报 `foreign_database` 且 `message` 含 `foreign_tables=`；副本与原件都不得出现 `workflow_*` 表，副本 marker 与 sha256 不变，旧 API 仍 200 |
| PM-12 | 正例：不误伤独立库 | 默认独立库首次启用 200、库里有 10 张 `workflow_*` 表且无旧库 marker；再次启动复用同一工作流库仍 200（重启不被 `foreign_database` 误判），旧 API 照常 |

变异验证（每次只改 `src/host/workflow-page.ts` 一处，重新 `pnpm run bundle:host` 后跑 PM 脚本，跑完还原）：

| 变异 | 结果 |
| --- | --- |
| M1 删掉默认关闭闸门 | PM-02、PM-04、PM-06、PM-07 失败 |
| M2 允许非 SQLite 引擎继续挂载 | PM-03 失败 |
| M3 初始化异常改为抛出、不隔离 | PM-04 失败 |
| M4 关闭时仍注册一条 503 路由（看似无害） | PM-02、PM-06、PM-07 失败 |
| M5 删掉 `same_path` 判定 | PM-09、PM-10 失败 |
| M6 删掉 `same_file`（`dev:ino`）判定 | PM-10 失败（硬链接反例） |
| M7 删掉 `foreign_database` 判定 | PM-11 失败 |
| M8 宿主不传 `legacyDbPath`（传 `null`） | PM-09、PM-10 失败（同路径退化成 `foreign_database`，`detail` 对不上） |

复原后 `src/host/workflow-page.ts` sha256 = `9441ec0de9f7c5127eec439c75af2236c5515a5cd0595f98cbd5a09fcaec5c59`，`src/host/index.ts` sha256 = `387f19cc2f0a5ace5c1dd0b2b8fa84e625bf88355e57f0627677eeff12fe8fa9`，`scripts/verify-workflow-page-mount.mjs` sha256 = `54b15363d9514778c90b4814ea07e315c634170cb95c66a965d696cbdc2c1186`，`lib/index.js` sha256 = `8600f7806c6db639cd76c16378dea26d4ca1c84cda847dc76229358efd496841`。

可复现输出：

```text
node scripts/verify-workflow-page-mount.mjs
  ✓ PM-01 开关只认显式打开：1/on/true/yes 才算开，其余一律关
  ✓ PM-02 关闭时不注册路由、不打开内核、不建库文件
  ✓ PM-03 无 SQLite 时独立禁用：不退回 JSON、不打开内核、不注册路由
  ✓ PM-04 初始化失败只让新路由 503，旧路由与旧数据不受影响（反例核心）
      {"disabled":"workflow_disabled:workflow_init_failed","message":"unable to open database file","legacyHashUnchanged":true,"legacyStateUnchanged":true}
  ✓ PM-05 开启后薄路由可用：health / runs / run 详情只读内核独立库
  ✓ PM-06 默认关闭：宿主只注册 /workbench-api，旧面板数据可读写
  ✓ PM-07 开启再从失败态恢复：旧数据逐字节不变、工作流库独立
  ✓ PM-08 构建产物真的带内核：lib/index.js 含内核 SQL 与测试注入点
  ✓ PM-09 反例：工作流库指向旧库同一路径时必须拒绝，旧库不得出现 workflow_* 表
      {"reason":"workflow_db_conflict","detail":"…/legacy.sqlite:same_path_as_legacy","legacyWorkflowTables":[],"marker":"KEEP-ME","legacyHashUnchanged":true}
  ✓ PM-10 反例：相对段 / 大小写 / 硬链接 / 符号链接别名一律按同一文件拒绝
  ✓ PM-11 反例：指向已有旧库的改名副本时拒绝，副本与原件都不得被写入 workflow_* 表
  ✓ PM-12 正例：独立库路径可正常启用，重启复用已有工作流库不被误判为冲突
  "checks": 12, "passed": 12, "assertions": 134, "failed": 0
exit code 0

pnpm run bundle
ℹ [dsh-workbench/host] lib\index.js  674.60 kB │ gzip: 175.65 kB
✔ [dsh-workbench/host] Build complete in 63ms
ℹ [dsh-workbench/client] lib\client.js  939.19 kB │ gzip: 234.31 kB
✔ [dsh-workbench/client] Build complete in 75ms
```

构建证据的变化要说清楚：本子批之前 `pnpm run bundle` 只构建 `src/host/index.ts` 与 `src/client/index.ts`，二者都不引用 `src/workflow/`，所以 **bundle 通过不证明内核进入主运行时**（旧 README 的结论）。现在宿主入口引用 `workflow-page.ts` → `m1-kernel.mjs`，`lib/index.js` 从 623.49 kB 变为 674.60 kB 并包含内核建表 SQL、快照校验错误码与库隔离判定，PM-08 直接断言这些片段，**bundle 从此可以当作「内核进了主运行时」的证据**（仍未证明真实 DSH webServer 的 prefix 路由在浏览器端可用）。

边界（别读多）：

- 客户端页面（步骤列表、草稿编辑、确认/暂停/继续、历史与错误）**不在本子批**，属 B4 后续；A01 端到端、A34–A37 页面路径仍未覆盖。A10 输入 schema 校验与 A36 人工确认语义已由 B4-2 子批在内核与假服务层覆盖。
- 未接真实 DSH `webServer`：路由注册、前缀匹配、`ctx.effect` 卸载都只在假 ctx 上验证过，真实宿主前缀路由属 M0-B。
- 内测页只读：不提供 `confirmHuman`/`pause`/`resume` 的 HTTP 入口，因此不可能误触发内核状态变更。
- 隔离判定是**路径 + 结构**判定，不是内容哈希判定：目标文件为空或只含 `workflow_*` 表时视为可用新库。所以「只拷了主文件、`-wal` 里建表语句没跟过去」的旧库副本会呈现为空库而被放行——这是刻意选择（空库与全新库无法区分），要更强保证得给旧库打固定指纹做内容校验，属 M0-B。
- 符号链接反例需要创建符号链接权限，Windows 非管理员会 `EPERM`；脚本如实记录跳过，不把跳过当通过（硬链接反例不依赖权限，始终生效）。
- 临时目录清理：被测宿主实例的 SQLite 句柄仍在本进程内，Windows 上 `rmSync` 可能 EPERM；脚本按 `EPERM/EBUSY` 保留目录并打印路径，其它错误照常抛出，不放宽成静默忽略（与 `verify-asset-service.mjs` 的立场一致）。

## B4-2 子批：A10 执行前校验与 A36 人工确认语义 — 待独立签收（第四轮：字段存在性用自有键）

依据 [10-testing-release-governance.md](../../workflow-plan/10-testing-release-governance.md) 的 A10 原文「输入 schema 不兼容或越界：在执行前阻止，不能业务豁免」与 A36 原文「确认并暂停、暂停中确认、双窗口或上游基准变化：不抢跑或自动恢复；CAS / 幂等生效，旧基准确认拒绝且草稿保留」。本子批**只做内核语义、假业务服务与专项测试**，不做客户端页面、不接真实 webServer、不碰 M2。

老大复核退回的两个 A10 缺口（本轮修复的起因）：

| 反例 | 退回时的行为 | 根因 |
| --- | --- | --- |
| `validateInputSchema({type:'object', required:'plan'}, {})` | 返回 `true`，必填形同不存在 | 取值校验用 `Array.isArray(schema.required) ? schema.required : []`，字符串被静默当成空数组 |
| `{properties:{rounds:{type:'integer', minimum:2}}}` 下 `rounds:1` | 返回 `true` | 只认自造的 `min`/`max`，标准 `minimum` 被静默忽略 —— 一份「看起来有约束」的 schema 实际没有约束 |

结论：**静默忽略不认识的关键字，比直接报错更危险**。所以本轮不只补这两个关键字，而是把 schema 方言定死、在创建运行时严格校验。

老大第三轮复核又发现：白名单只校验了关键字的**形态与取值**，没校验**约束能不能作用在该字段类型上**。

| 反例 | 退回时的行为 | 根因 |
| --- | --- | --- |
| `{properties:{rounds:{minimum:2}}}` 配 `rounds:'not-a-number'` | 返回 `true` | 缺 `type` 时值校验器不知道按什么类型比，区间判定整段被跳过 |
| `{type:'string', minimum:2}` 配 `'x'` | 返回 `true` | 字符串字段上的数值约束永远不会被执行 |
| `{type:'number', minLength:3}` 配 `0` | 返回 `true` | 数值字段上的长度约束永远不会被执行 |

所以本轮补的是**类型-约束相容性**：约束必须依附在相容的声明类型上，否则创建运行时就拒。

老大第四轮复核又发现两处：**字段存在性用了 `in`**，于是原型链成员冒充声明字段/输入字段；**`schema.properties ?? {}`** 把显式 `null` 当成「没写 properties」。

| 反例 | 退回时的行为 | 根因 |
| --- | --- | --- |
| `{type:'object',properties:{},required:['toString']}` 配 `{}` | 返回 `true` | `'toString' in properties` 为真（原型链），声明校验与必填校验一起被架空 |
| `{type:'object',properties:null}` | 返回 `true` | `?? {}` 把显式 null 当成空对象，写错的 schema 被当成「没有字段」 |

所以第四轮把存在性判定统一收口到 `hasOwn`（`Object.prototype.hasOwnProperty.call`），并把显式 `properties:null` 单独报 `properties_null`。

改动：

- **schema 方言 `workflow-input/1`**（`src/workflow/m1-kernel.mjs` 的 `validateInputSchemaDefinition`）：白名单以外的写法一律在建 run 时抛 `schema_invalid`，detail 形如 `input_schema:<位置>:<原因>`。
  - 根：只允许 `type`（必须为 `object`）、`properties`、`required`、`additionalProperties`（只允许 `false`）。未知根关键字 → `unsupported_keyword:<key>`。
  - 字段：只允许 `type`（`string|number|integer|boolean`）、`enum`、`minLength`、`maxLength`、`pattern`、`minimum`、`maximum`。`min`/`max` 这类自造写法 → `properties.<名>:unsupported_keyword:<key>`。
  - 结构性错误单独给 detail：`required_not_array`、`required_not_string`、`required_undefined:<名>`、`properties_not_object`、`rule_not_object`、`enum_malformed`、`minLength_malformed`、`bounds_inverted`、`minimum_malformed`、`pattern_invalid`、`unsupported_type:<type>`。
  - 刻意不支持嵌套对象与数组：本方言只覆盖扁平字段，声明 `type:'array'`/`'object'` 也会被拒 —— 避免「声明了但没法校验」。
  - **类型-约束相容性**：`minLength`/`maxLength`/`pattern` 只允许配 `type:'string'`；`minimum`/`maximum` 只允许配 `type:'number'` 或 `'integer'`；`enum` 必须有 `type`，且每个候选值的类型要与声明一致（`integer` 候选可满足 `number`）。
  - **字段存在性只认自有键**：`required` 指向未声明字段（含 `toString`/`constructor`/`valueOf`/`__proto__` 这类原型链成员）→ `required_undefined:<名>`；`properties` 声明藏在原型上同样按未声明处理。
  - **显式 `properties:null`** → `properties_null`（不是空对象）；`properties` 为数组或标量仍报 `properties_not_object`；只有在**完全不写** `properties` 时才按空对象处理。
  - 缺 `type` 却写了任何约束（含 `enum`）→ `properties.<名>:constraint_without_type:<key>`；类型不符 → `properties.<名>:constraint_type_mismatch:<key>:<type>`；`enum` 候选类型不符 → `properties.<名>:enum_type_mismatch:<实际类型>`。
  - 理由：这些组合以前能过白名单，但取值校验里 `typeof value === 'string'` / `'number'` 的分支根本不会进入 —— schema 看着有约束、实际裸奔，正是 A10 要防的那种「不兼容」。
  - 值侧同理：必填判定改成「自有键且不是 `undefined`」，继承来的 `plan` 或显式 `{plan: undefined}` 都算没提供（JSON 里也不会存在这个键）。
- **校验时机三处**：`createRun` 建 run 时校验方言与相容性（写错或不相容的 schema 当场拒绝、不进库）；假服务 `startRun` 在授权判定之前先校验方言与相容性再校验值；`claim` 每次领取前 `validateInputSchema` 会**先重校验库里那份 schema 的方言与相容性**再校验值 —— 因此旧版本存进去的不合规 schema 是**失败关闭**（方言见 HC-12，相容性见 HC-14），不会被当成「没有约束」。
- **A10 的领取路径**：`claimTx` 在 `run_waiting_review` 判定之后、`reapExpiredLeases` 之前校验输入。被拒时事务回滚，只在事务外补写一条 `input.rejected` 事件（可审计）；**不扣预算、不建 Attempt、不建人工待办、不做租约回收**。
- **A36 确认语义**：`adoptTx` 增加 `intent = 'continue' | 'pause'`。intent 为 `pause` 时收尾走 `pauseRun(runId,'user_paused')` 而不是 `settleRun` —— 否则「最后一步确认并暂停」会被直接记成 `completed`，用户的暂停被吞掉。采用与暂停在同一事务里提交，所以要么两者都落，要么都不落。
- **`confirmHuman`**：校验 intent 值域（`intent:not_in_enum`）、把 intent 纳入幂等请求哈希（同 key 不同 intent 算不同请求）、失败时用 `cleanupCandidate` 清掉已写出的孤儿对象与 manifest。
- **人工待办重开**：`markDownstreamStale` 现在会把被作废下游步骤的 `open` 待办一并置为 `stale` —— 不这么做，旧待办会让运行永久停在 `waiting_review`，既不能被重新领取、也确认不了（死锁）。重新领取时同一待办以 `human.task.reopened` 重开、`task_revision` 递增、`draft_id` 保持不变（A36 草稿保留）。
- **假业务服务**（`src/workflow/m1-fake-service.mjs`）：`startRun` 新增 `inputSchema` 并在 `assertPreAuthorized` 之前校验；`confirmHumanTask` 新增 `intent` 与**伪造身份拒绝**——请求体给的 `actorId` 与已认证 `principal` 不一致时抛 `schema_invalid:actor_id_not_authenticated`，调用内核固定传 `actorId: principal`，不再 `actorId ?? principal`。
- 新增 `scripts/verify-workflow-m1-human-confirm.mjs`：16 项 HC-01–HC-16、196 条断言，每项独立 `mkdtemp` 临时库与临时根，全程假执行器。

| 检查 | 覆盖的行为 | 关键点 |
| --- | --- | --- |
| HC-01 | 无效输入在领取前被拒（A10 核心） | 缺字段/空串/超长/越界/小数/枚举外/多余字段/非对象共 9 类，逐一断言 `input_schema_invalid` 且 detail 精确到字段；之后 `budget_used`、`revision`、`status` 全部未变，`workflow_attempts` 与 `workflow_human_tasks` 计数仍为 0，只有 9 条 `input.rejected` 事件；同 run 给合法输入才扣 1 单位预算 |
| HC-02 | 人工步骤同样先校验 | 无效输入不产生任何人工待办、运行停在 `created`、预算为 0；合法输入才建出唯一待办 |
| HC-03 | schema 随 run 落库、重启仍生效 | 关闭第一个句柄后用 `openWorkflowKernel` 重开同一个库，越界输入仍被拒，合法输入可领取 |
| HC-04 | 确认继续（A36 正例） | 采用、待办 `confirmed`、`confirmed_by`、`author_type='human'` 同事务落地；运行保持 `running`，后继步骤可领取 |
| HC-05 | 确认并暂停（A36 核心） | 采用与 `paused/user_paused` 同时提交；暂停后 `claim` 报 `run_paused` 且不新增 Attempt；此后必需发布成功也**不会**把运行变 `completed`；只有显式 `resume` 才收敛为 `completed` |
| HC-06 | 暂停中确认 + 双窗口 CAS | 运行先 `pauseRun`，窗口 A 确认后运行仍是 `paused`；窗口 B 用旧修订确认报 `cas_conflict`，且未写第二个采用/快照；待办仍是 A 的确认结果；B 侧 `claim` 报 `run_paused` |
| HC-07 | 幂等 | 同请求重放 `replayed:true` 且返回原 `adoptionId`，采用与快照各只有 1 条；同 key 换正文报 `idempotency_conflict`，仍不产生新采用 |
| HC-08 | 旧上游基准 + 草稿保留（A36） | 上游重跑后下游人工步骤置 `stale`、旧待办置 `stale`、运行不再卡 `waiting_review`；旧基准确认被 `cas_conflict` 拒绝；草稿内容与 `draft_id` 原样保留；重新领取时待办以更新修订重开并继续指向同一草稿 |
| HC-09 | 服务边界（A10/A36/伪造身份） | 越界输入在 `startRun` 就被拒且不产生 run 行；方言错误（`min:2`）同样被拒且不产生 run；intent 值域、伪造 `actorId`、Agent 通道无 `confirm.human` 权限三种都拒；正例断言 `confirmed_by` 等于已认证 principal，`intent:'pause'` 真的把运行置 `paused` 且 `nextAction:'resume'` |
| HC-10 | 旧库迁移 | 手工造一份没有 `input_schema` 列的旧库，打开后自动 `ALTER TABLE` 补列，旧 run 行保留、无 schema 时任何输入放行 |
| HC-11 | 方言严格性（老大两个反例） | `required:'plan'` → `input_schema:required_not_array` 且不建 run；`min:2` → `unsupported_keyword:min`；`minimum:'2'` → `minimum_malformed`；`required:['plann']` → `required_undefined:plann`；`type:'array'` → `unsupported_type:array`；坏 `pattern` → `pattern_invalid`；正例断言 `minimum:2` 下 `rounds:1` 被拒、`rounds:2` 通过；直接调导出函数同样被拦 |
| HC-12 | 库里旧 schema 失败关闭 | 绕过 `createRun` 直接把 `min:2` 的 schema 写进库，领取时报 `schema_invalid:properties.rounds:unsupported_keyword:min`，不产生 Attempt |
| HC-13 | 约束与类型不相容（老大第三轮三个反例） | 缺 `type` 只写 `minimum` → `constraint_without_type:minimum`；`string`+`minimum`、`number`+`minLength`、`string`+`maximum`、`boolean`+`minimum` 各报 `constraint_type_mismatch`；无 `type` 的 `enum` → `constraint_without_type:enum`；`boolean` 配 `enum:[true,'yes']`、`string` 配 `enum:['web',1]` → `enum_type_mismatch`；8 个反例均不建 run；直接调 `validateInputSchema` 同样在 schema 阶段被拒；正例断言相容约束照常生效（`minLength:3` 拒 `'ab'`、`minimum:2`/`maximum:4` 拒 1 与 9、`integer`+`maximum:5` 拒 6，合法值可领取） |
| HC-14 | 库里旧 schema 的相容性也失败关闭 | 把 `{rounds:{minimum:2}}` 写进库后，用老大探针的 `rounds:'not-a-number'` 领取报 `schema_invalid:properties.rounds:constraint_without_type:minimum`，不产生 Attempt 且 `budget_used`/`revision` 未变；假服务 `startRun` 传 `{type:'string', minimum:2}` 同样在授权前被拒且不建 run |
| HC-15 | 自有键判定 + 显式 `properties:null`（老大第四轮两个反例） | `required:['toString']` / `['constructor']` / `['valueOf']` / `['__proto__']` 均报 `required_undefined:<名>` 且不建 run；`properties` 用 `Object.create({plan:...})` 把声明藏在原型上，同样 `required_undefined:plan`；`properties:null` → `properties_null`、`properties:[]` 与 `properties:'plan'` → `properties_not_object`；值侧 `Object.create({plan:'inherited'})` 与 `{plan:undefined}` 都报 `plan:required`；直接调导出函数同样在 schema 阶段被拦；正例：真声明并提供的字段通过，字段名恰好叫 `toString` 时声明+提供也照常工作 |
| HC-16 | 库里旧 schema 的原型链绕过也失败关闭 | 把 `{type:'object',properties:{},required:['toString']}` 写进库后领取 `{}` 报 `schema_invalid:required_undefined:toString`，不产生 Attempt 且 `budget_used`/`revision` 未变；旧库里 `properties:null` 的 schema 领取报 `properties_null`；合法 schema 配原型链上的值报 `plan:required`；假服务 `startRun` 传 `properties:null` 同样在授权前被拒且不建 run |

变异验证（逐条改坏一处判定、重跑专项、跑完自动还原）：

| 变异 | 破坏的判定 | 结果 |
| --- | --- | --- |
| M1 | 领取前不校验输入 schema | HC-01 FAIL |
| M2 | 确认并暂停退化为直接 `settleRun` | HC-05 FAIL |
| M3 | 作废人工步骤时不搁置待办 | HC-08 FAIL |
| M4 | 把请求体 `actorId` 当身份 | HC-09 FAIL |
| M5 | `required` 不是数组时静默跳过（反例 1 的原始缺陷） | HC-11 FAIL |
| M6 | 不认识的关键字静默忽略（反例 2 的原始缺陷） | HC-11 FAIL |
| M7 | `minimum`/`maximum` 不参与取值校验 | HC-01、HC-11 FAIL |
| M8 | 创建运行时不校验方言 | HC-11 FAIL |
| M9 | 服务启动时不校验方言 | HC-09 FAIL |
| M10 | `required` 指向未声明字段不报错 | HC-11 FAIL |
| M11 | 整段类型-约束相容性校验删掉 | HC-13、HC-14 FAIL |
| M12 | 缺 `type` 的分支不再报 `constraint_without_type` | HC-13、HC-14 FAIL |
| M13 | 字符串类约束不校验字段类型 | HC-13 FAIL |
| M14 | 数值类约束不校验字段类型 | HC-13、HC-14 FAIL |
| M15 | `enum` 候选值不校验类型 | HC-13 FAIL |
| M16 | 声明侧 `required` 退回 `name in properties`（原型链） | HC-15、HC-16 FAIL |
| M17 | 显式 `properties:null` 退回 `?? {}` 当成空对象 | HC-15、HC-16 FAIL |
| M18 | 值侧 `required` 退回 `name in value`（原型链） | HC-15、HC-16 FAIL |

18 条变异全部被抓住（M1–M10 见第二轮，M11–M15 是相容性判定，M16–M18 是自有键与显式 null，逐条单独改坏后重跑）；还原后专项回到 16 项 196 条全通过（`restored: {"checks":16,"passed":16,"assertions":196}`）。复原后 sha256：

- `src/workflow/m1-kernel.mjs` = `b64fb11efed97eedc79e0cdd59607d4542a23941aaa0ab20c9ea54de27130086`（历史版本；当前哈希见顶部索引）
- `src/workflow/m1-fake-service.mjs` = `686b2f61786dd05ac910c4e830addfc1dc1fc78415e51e31690fd3a8acb5073f`
- `scripts/verify-workflow-m1-human-confirm.mjs` = `2c9aed48916c40d0ffe5d935f8c4d733a9eb2176dbac919c745dc33f1fa63ac0`
- `scripts/probe-schema-dialect.mjs` = `c72999e3c9befaf96363b1ede7e3cd392cf0dfc7f102650d1b306b0c2e39078a`
- `lib/index.js`（构建产物）= `35b12f94ac8a369a0cf5b27486e9ab64cf5590e68b16f6d566aaec6ae6837df1`

方言探针（`node scripts/probe-schema-dialect.mjs`）——就是老大复核用的那几组：

```json
{"probe":"required-as-string","error":{"code":"schema_invalid","detail":"input_schema:required_not_array"}}
{"probe":"minimum-2-rounds-1","error":{"code":"input_schema_invalid","detail":"rounds:below_minimum"}}
{"probe":"minimum-2-rounds-2","result":true}
{"probe":"self-made-min-2-rounds-1","error":{"code":"schema_invalid","detail":"input_schema:properties.rounds:unsupported_keyword:min"}}
{"probe":"minimum-without-type-rounds-not-a-number","error":{"code":"schema_invalid","detail":"input_schema:properties.rounds:constraint_without_type:minimum"}}
{"probe":"string-with-minimum-x","error":{"code":"schema_invalid","detail":"input_schema:properties.plan:constraint_type_mismatch:minimum:string"}}
{"probe":"number-with-minlength-0","error":{"code":"schema_invalid","detail":"input_schema:properties.rounds:constraint_type_mismatch:minLength:number"}}
{"probe":"compatible-minimum-2-rounds-1","error":{"code":"input_schema_invalid","detail":"rounds:below_minimum"}}
{"probe":"compatible-minimum-2-rounds-2","result":true}
{"probe":"prototype-required-toString","error":{"code":"schema_invalid","detail":"input_schema:required_undefined:toString"}}
{"probe":"prototype-required-constructor","error":{"code":"schema_invalid","detail":"input_schema:required_undefined:constructor"}}
{"probe":"inherited-value-plan","error":{"code":"input_schema_invalid","detail":"plan:required"}}
{"probe":"properties-null","error":{"code":"schema_invalid","detail":"input_schema:properties_null"}}
{"probe":"own-key-plan-ok","result":true}
```

### 身份边界：为什么 A36 只在假服务里验证（UI 阻塞点）

派工要求「先核实可信会话身份能否注入；不能证明时不得开放匿名写 HTTP，也不得把请求体的 actorId 当认证」。核实结论是**不能证明**：

- 工作台宿主路由拿到的 `RouteRequest`（`src/host/index.ts:5947-5956`）只有 `url`/`method`/`on`/`json`，**没有任何会话或身份字段**。
- DSH 自身的 `docs/subsystems/web-server.md` 写明 WebServer 是裸 `node:http` 载体、「The carrier owns no authentication or Origin policy」；认证在 Connection 插件（`ctx.connection.admit(request)`），而工作台插件只 `inject: ['webServer','tools']`，拿不到 `ctx.connection`。
- 其 `PrincipalMap` 只有 `owner:{kind:'owner'}` 一种 principal，没有「哪个浏览器会话在操作」的信息。

因此本批**没有新增任何写 HTTP 路由**（内测页仍是只读的 `/health`、`/runs`、`/runs/:id`），也不把请求体 `actorId` 当认证（HC-09 正是这个反例）。**UI 阻塞点**：确认/暂停/继续要在真实界面可用，必须先有一个能把可信会话身份注入路由的宿主能力，属 M0-B；在那之前只能以假服务验证语义。

边界：

- 客户端页面、真实 webServer、真实 HTTP、M2 都不在本子批，M2 自动写回保持关闭。
- 输入 schema 方言只覆盖扁平字段；嵌套对象/数组明确不支持（会报错而不是降级校验）。
- `confirmHuman` 的并发证据是同库双连接、顺序交错调用（HC-06），**不是真实并发压测**，也没有跨进程验证。

## B4-3 子批：默认关闭的只读客户端（W1-07 / A13 客户端子集）— 待独立签收（第二轮：读取失败不再折叠成空数据）

按老大 m01221 派工：客户端子批先收窄到**只读**——步骤状态、历史与错误展示；草稿提交、确认、暂停、继续**一律不接写 HTTP**，可信身份门（M0-B）未验证前不开放任何写入口。

老大第二轮退回（原文要点）：「健康探针成功后，列表 503、详情非 404 失败或后续断网，都应显示『读取失败』，不能显示空列表或空详情，也不能留下未处理的异步异常。补对应反例并更新证据；保持默认关闭和零写入口。」退回前确实存在三处缺陷：`/health` 成功而 `/runs` 返回 503 时 `readonlyView({exposed:true,runs:{ok:false}})` 仍给出 `status:'ready'` 与「还没有工作流运行」；`/runs` 在探针后网络拒绝时 `listRuns()` 抛出、`ReadonlyPage.refresh` 的 `void` 调用无 catch，留下未处理的异步拒绝且界面无提示；详情非 404 失败被静默折叠成空详情。

第二轮修复（同一批次内定向修复，未扩大范围）：

- `src/client/workflow/readonly-core.mjs`：`read()` 把 `fetchImpl` 的失败 catch 成 `{status:0, ok:false, reason:'unreachable', error}`，非 2xx 且响应体没给原因时用 `http_<status>` 兜底（404 → `not_found`）；新增 `failedRead()` 统一兜底，`listRuns`/`loadRun` 各自 catch；新增 `loadReadonlyState(source,{runId})`——探针→列表→详情，**保证永不 reject**（`try/catch` 兜底返回 `{exposed:true, reason:'unreachable', runs:null, detail:null}`）；`readonlyView` 先收集 `failed[]`（`state.error`、`runs.ok!==true`、详情 `ok!==true` 且 `reason!=='run_not_found'`），有失败就返回 `status:'error'` + `headline:'读取失败：…'` + `errors:[{type:'read_failed',…}]`，**已读到的 runs 仍展示**（不把成功那半也藏掉），只有 `run_not_found` 与真正的空列表才给空态文案；新增 `READ_FAILURE_LABELS` 与 `describeReadFailure()`（`http_(\d+)` → 「工作流接口返回 HTTP N」）。
- `src/client/workflow/readonly-panel.ts`：`refresh` 改走 `loadReadonlyState` 并整段 `try/catch` 兜底；错误横幅（`data-dsh-workflow-readonly-error`）显示失败原因，多项时追加「共 N 项：…」；列表与详情空态分别区分「运行列表读取失败」/「详情读取失败，无法展示步骤与历史」。

改动清单（只碰工作流客户端、客户端入口与专项测试）：

- 新增 `src/client/workflow/readonly-core.mjs`：只读逻辑，**无 React、无 DOM**，可以被 node 直接 import 验证。请求方法写死在 `read` 内部（调用方无法传入），每次真实请求都记进 `source.calls`；暴露的方法只有 `probe`/`listRuns`/`loadRun` 三个读方法（另加不直接请求的 `loadReadonlyState` 组合器）。
- 新增 `src/client/workflow/readonly-panel.ts`：React 只读页（步骤/历史/错误三块 + 刷新按钮 + 错误横幅）与侧栏入口；`exposed:false` 时组件直接 `return null`。
- `src/client/index.ts`：`apply()` 末尾接 `installWorkflowReadonlyPanel(ctx)`；旧 `key: PANEL_ID`（`workbench`）面板注册与 `mountSidebarEntry(ctx)` 一行未改。
- `scripts/verify-workflow-readonly-client.mjs`：RC-01–RC-12，**12 项 310 条断言**。

关闭语义（默认关闭，五种「不该出现」都收敛成同一结果）：

| 后端状态 | 探针返回 | 页面 | 侧栏入口 |
| --- | --- | --- | --- |
| 未挂载（404） | `exposed:false, reason:not_mounted` | 渲染 `null` | 不挂 |
| `disabled_by_config` | `exposed:false, reason:disabled_by_config` | 渲染 `null` | 不挂 |
| `workflow_requires_sqlite` | `exposed:false, reason:workflow_requires_sqlite` | 渲染 `null` | 不挂 |
| `workflow_init_failed` / `workflow_db_conflict` | `exposed:false, reason:workflow_init_failed` / `workflow_db_conflict` | 渲染 `null` | 不挂 |
| `/health` 不可达 | `exposed:false, reason:unreachable` | 渲染 `null` | 不挂 |
| `ok:true` 但 `enabled:false` | `exposed:false, reason:disabled` | 渲染 `null` | 不挂 |

| 检查 | 覆盖的行为 |
| --- | --- |
| RC-01 | 只读计划只有 3 条 GET（`/health`、`/runs`、`/runs/:id`），前缀归一；数据源只有 `probe/listRuns/loadRun` 三个读方法，`post/put/patch/delete/confirm/pause/resume/submit/createRun/adopt` 一个都不存在 |
| RC-02 | 上表六种关闭态逐一验证：`exposed:false`、`registerEntry` 调用 0 次、`readonlyView` 返回 `null`，且整轮请求仍全是 GET |
| RC-03 | 探针通过即挂入口一次；列表给出中文状态标签与预算（`待人工确认`、`12/900`、`发布冲突`）；详情给出 3 个步骤（`已成功`/被上游作废标记）、5 条历史、2 条错误（`publish_conflict` 带 detail、`outcome_unknown`）；整轮 `method!=='GET'` 的请求数为 0 |
| RC-04 | 详情 404 → `run_not_found`，不抛错、不把整页判成错误，右侧保持空态 |
| RC-05 | 错误提取有边界：`step.succeeded`、`human.task.created` 不算错误；`pauseReason` 单独成一条（`seq:null`、中文说明） |
| RC-06 | 源码级无写入口：`src/client/workflow/*` 不含 `POST/PUT/PATCH/DELETE` 字面量、不含 `confirmHuman/pauseRun/resumeRun/submitDraft/createRun/adopt(/cancelRun/saveDraft`，所有 `method:` 取值必须是 `WORKFLOW_READONLY_METHOD`；薄挂载三条路由都显式要求 GET；旧 `key: PANEL_ID` 面板与 `mountSidebarEntry(ctx)` 仍在 |
| RC-07 | 构建产物证据：`lib/client.js` 含 `workflow-readonly`、`dsh-workflow-readonly-entry`、`/workbench-workflow` 与「工作流（只读）」文案，不含 `workflow-write` |
| RC-08 | 脏数据稳健：空响应给空列表、缺字段给 `未知`/`0/0`、`readonlyView(null)` 与 `exposed:false` 都返回 `null` |
| RC-09 | **老大第一反例**：`/health` 成功而 `/runs` 返回 503 → `status:'error'`、`reason:workflow_init_failed`、`headline:'读取失败：工作流初始化失败'`，断言**不出现**「还没有工作流运行」，`errors[0].type==='read_failed'`；响应体无 `reason` 的 500 → `http_500` → 「读取失败：工作流接口返回 HTTP 500」；`loadReadonlyState` 入口同样保留原始失败原因（不被后续「猜详情」冲掉） |
| RC-10 | **老大第二反例**：`/runs` 断网时 `listRuns` **不抛**、`reason:'unreachable'`、保留 `ECONNREFUSED` 原文，`loadReadonlyState` 不 reject，视图判 `error` 且显示「读取失败：连接不上工作流接口」 |
| RC-11 | **详情非 404 失败**：500 / 503 / 断网三例都不抛、都判 `error` 且 `detail:null`，同时**列表读到的 2 条运行仍展示**；对照组 404 → `run_not_found` + `status:'ready'` + 空态文案（确认没有把「运行不存在」误报成读取失败） |
| RC-12 | 七种响应形态（`health_ok_runs_ok`/`runs_503`/`runs_throw`/`health_throw`/`health_503`/`detail_throw`/`bad_json`）全部经 `loadReadonlyState` 走一遍：**都不 reject**、都返回状态对象；并监听 `process.on('unhandledRejection')`，等 20ms 后断言**未处理拒绝 0 条** |

变异（12 条，全部被抓；改完即还原）：

| 变异 | 内容 | 抓到它的检查 |
| --- | --- | --- |
| M1 | 探针把任何 200 都当启用（忽略 `enabled`） | RC-02 |
| M2 | 未启用时页面也渲染（`readonlyView` 不再返回 `null`） | RC-02、RC-08 |
| M3 | 请求记录成 `POST` | RC-02、RC-03、RC-04、RC-06 |
| M4 | 所有事件都算错误 | RC-03、RC-05 |
| M5 | 探针失败也挂入口 | RC-02 |
| M6 | 客户端出现写命令字面量 `pauseRun` | RC-06 |
| M7 | 面板里出现 `method: 'POST'` 的请求 | RC-06 |
| N1 | `readonlyView` 忽略列表读失败（= 老大复现的原缺陷：ready + 空列表） | RC-09、RC-10 |
| N2 | `read()` 与 `listRuns()` 的 catch 一起去掉，断网异常直接抛给页面 | RC-10 |
| N3 | 详情读失败折叠成 `ok:true` 的空详情 | RC-11 |
| N4 | 失败态仍用空态文案「还没有工作流运行」 | RC-09、RC-10、RC-11 |
| N5 | 列表失败后仍继续去猜详情，把原始失败原因冲成兜底码 | RC-09 |

可复现输出：

```
$ node scripts/verify-workflow-readonly-client.mjs
  ✓ RC-01 只读计划：方法只有 GET，路径只有 health/runs/runs/:id，数据源不暴露任何写方法
  ✓ RC-02 关闭时旧页面不变：未挂载 / 独立禁用 / 初始化失败 / 网络不可达 / enabled:false 一律不挂入口且渲染 null
  ✓ RC-03 开启后只读数据可见：探针通过即挂入口，步骤状态 / 历史 / 错误都能展示
  ✓ RC-04 读详情缺失时给 run_not_found，不抛出、不降级去猜
  ✓ RC-05 错误提取有边界：普通事件不算错误，暂停原因单独计入
  ✓ RC-06 源码级无写入口：客户端只读模块与薄挂载都不含写方法或写命令
  ✓ RC-07 构建产物证据：只读页进入 client bundle，且不含写入口标记
  ✓ RC-08 摘要函数对脏数据稳健：缺少字段不抛、不产生 NaN
  ✓ RC-09 列表读失败必须显示「读取失败」：/health 成功而 /runs 返回 503 不得冒充空数据
  ✓ RC-10 列表断网不得抛异常：listRuns / loadReadonlyState / 整轮加载都只返回失败状态
  ✓ RC-11 详情非 404 失败必须显示「读取失败」：500 / 503 / 断网都不得折叠成空详情
  ✓ RC-12 不产生未处理异步异常：任何响应形态下页面入口都不 reject
{"checks":12,"passed":12,"assertions":310,"failed":[]}
```

变异复跑（临时脚本已删，跑完自动还原并校验 sha256 一致）：

```
$ node scripts/verify-workflow-readonly-client.mjs   # 逐条变异后重跑
{"results":[{"id":"N1","caught":true,"failed":"✗ RC-09,✗ RC-10"},
            {"id":"N2","caught":true,"failed":"✗ RC-10"},
            {"id":"N3","caught":true,"failed":"✗ RC-11"},
            {"id":"N4","caught":true,"failed":"✗ RC-09,✗ RC-10,✗ RC-11"},
            {"id":"N5","caught":true,"failed":"✗ RC-09"}],
 "match":true}
```

构建：`pnpm run bundle` exit 0，`lib/client.js` 964.16 kB / gzip 241.25 kB（B4-3 前 939.19 kB / 234.31 kB，第一轮 959.32 kB），`lib/index.js` 684.26 kB / gzip 178.28 kB（bundle 后未变，本批没有改宿主）。

已复原文件哈希（sha256）：

- `src/client/workflow/readonly-core.mjs` = `f1719d709312cf78eb18c10a9c8585b772f28bfdbbab27ff26ec87c06978dd62`
- `src/client/workflow/readonly-panel.ts` = `262d3975b51c1fb4fa9b016e3e02be79fe62f832c41cf7437c180a839583fa83`
- `src/client/index.ts` = `6d6a5a0ee8c3360a0dbb54989dc1b8160aa5e7e8285a614fee5c19e6450294fe`
- `scripts/verify-workflow-readonly-client.mjs` = `161f25f3fc3c2a58ce38d29a1d2e79bf9204e5f4287f1f85e4865d4bbfce0a7e`
- `lib/client.js` = `bc94ac740589051ce9da364c6c6dfe5a3ede8d0aaa014b1e46ed9a10ad0dfae2`

边界（如实标注，别当成已验证的）：

- **「旧页面不变」的证据是无入口 + 渲染 `null` + 旧面板注册行未改**，不是截图对比。只读面板在 `apply()` 时按 DSH 插槽约定注册（插槽贡献必须在 apply 期间给出），但组件在 `exposed:false` 时返回 `null`，且 `key` 是独立的 `workflow-readonly`，不会被旧入口选中。
- 面板本身没有在真实 DSH 界面里跑过：本批不接真实 webServer、不用真实 HTTP，RC 用的是注入的假 `fetchImpl`。真实浏览器渲染属 M0-B/后续验收。
- 只读页**只有读**。草稿编辑、确认、暂停、继续仍缺可信会话身份，仍是阻塞点（见上一节「身份边界」）。
- **读取失败与空数据被严格区分**：列表/详情读失败一律 `status:'error'` + 「读取失败：…」并用 `errors[type:'read_failed']` 留痕，只有真正的 200 空列表或 `run_not_found` 才显示「还没有工作流运行」；已读到的运行在详情失败时仍展示（不把成功那半也藏掉）。这条语义在 `readonly-core.mjs` 里验证，错误横幅的 DOM 呈现只在逻辑层断言过，未在真实浏览器里截图。
- 刷新是再读一次（GET），不会清除服务端任何状态。

## B5 子批：端到端假服务闭环（W1-08 / A01 / A34 / A35 / A37）— 待独立签收（第二轮：执行器真消费 + 失败记录原因）

按老大 m01469 派工：「按 **W1-08/B5** 实施下一子批：仅用临时 SQLite、脱敏数据和进程内假执行器，串跑有人工节点与无人工节点两份固定模板。重点验证下游实际消费人工修改后的快照、无人工节点自动推进、原文直接确认及待办与草稿重启恢复，并为 A37 的硬校验失败、必需检查未评估和输出缺失补停止路径反例；分别标明已验证范围，不能用结构断言代替端到端证据。」

第一轮交上来被老大退回两处口径不符：①测试虽然调了 `inputFor`，但 `submitOutput` 的 content 仍由测试代码预设（人工下游直接拿 `draftContent` 拼），不能称「执行器实际消费输入」；②超限后的暂停是测试主动 `pause`，缺失上游对象后运行仍是 `running`、Attempt 在途，再 claim 只是因在途被拒——没有「记录原因并停止」。第二轮定向补证如下。

**B5 当时没有改内核**（历史哈希 `b64fb11e…`）；后续类型持久化和采用完整性补丁已修改内核，当前哈希及 REC-09–11 见顶部索引。B5 当时改动只在假服务与专项脚本。

改动清单：

- `src/workflow/m1-fake-service.mjs`：
  - `host.inputFor(attemptId)` 收紧——只有 `running` 的 Attempt 才能取输入，已终结的抛 `attempt_invalid:attempt_<status>`；完整性校验改为直接复用内核只读的 `readSnapshot`（manifest / 快照身份 / 类型 / 对象 / 字节四方对齐），服务侧不另写半套检查；内核错误折算成 `artifact_missing:parent_snapshot_missing` / `parent_object_missing:<detail>` / `parent_content_mismatch:<detail>`（`<detail>` 取内核错误的 message）。
  - 新增 `host.runNode(attemptId, { principal, pad, target, required })` 把「读输入 → 由输入算出输出 → 提交 → 宿主执行」串成一个动作。输出由 `renderNodeOutput({ nodeId, input })` 生成，**只由读回的上游内容和节点 id 决定**（`[nodeId]\n<上游内容>`，无上游则 `(no upstream snapshot)`），调用方没有任何参数可以预置 content。
  - 新增 `failNodeAttempt(attemptId, reason)`：读输入失败或提交被硬拒时，由假执行器自己调 `kernel.markFailed`，把原因写回内核（Attempt `failed` + 步骤 `paused` + 运行 `paused` + `attempt.failed` 事件），而不是让测试发 pause 冒充停。
- 新增 `scripts/verify-workflow-m1-endtoend.mjs`：E2E-01–E2E-08，**8 项 132 条断言**（第一轮 7 项 95 条；第二轮 129 条；本轮补 E2E-06 孤儿快照断言后 132 条）。两份模板直接读 `scripts/fixtures/workflow/human-runs.json` 的 `four-step-with-human` / `four-step-auto`，发布目标从 `adoptions[].publishTargets[].docKey` 取，测试不自行扩大范围；测试里不存在「预设节点输出」的入口。

| 检查 | 覆盖的行为 |
| --- | --- |
| E2E-01 | **无人工节点模板自动推进（A34）**：三步自动链路全部 `actor_type='system'`、`reason='validated'`，无人工待办、无隐式内容审批；父链 `snap2→snap1`、`snap3→snap2`；三个必需发布全部 `succeeded` 且目标恰为模板声明的 `md:` / `pd:` / `audit:`；运行 `completed` 并有 `run.completed` 事件。**每一步的输入都是 `host.inputFor` 从对象库读回的内容，输出由该内容派生**（第 1 步含 `(no upstream snapshot)`，第 2 步以 `[fixture-auto-step-structure]` 开头，第 3 步的输入逐字等于第 2 步输出）。 |
| E2E-02 | **人工节点等待 + 草稿 + 重启 + 手改被真实消费（A01/A34/A35）**：人工节点领取后运行 `waiting_review`，再次领取抛 `run_waiting_review`，不创建 Attempt、不产生采用；`saveDraft` 后仍等待且不采用；**重启**（关库重开 + 新假服务实例）恢复同一 `taskId`、`task_revision=2`、同一 `draft_id` 与同一草稿内容，仍不能越过；确认手改内容后 `actor_type='human'`、`reason='human.edit-confirm'`、父指针指向生成快照，**原生成快照仍可读且内容未变**；下游节点由 `runNode` 跑，其**输入**是手改文本、其**输出**由该输入派生（断言 `content.includes(draftContent)`）、`authorType='human'`；最终报告产物里仍含手改语句，运行 `completed`。 |
| E2E-03 | **原文直接确认（A35）**：不存草稿、直接确认与上游完全一致的内容，仍生成独立 human 快照、`actor_type='human'`、父指针指向上游、内容哈希与上游相同（同内容去重但不吞掉采用记录）。 |
| E2E-04 | **A37 硬校验失败：记录原因并停止**：节点实际产出（由输入派生 + `pad` 撑到超限）超过 512 KiB 契约上限 → 服务当场 `schema_invalid:content_too_large`；**假执行器自己把原因写回内核**——运行 `paused` 且 `pause_reason` 含 `content_too_large`、Attempt `failed` 且 outcome 含原因、步骤 `paused`、恰有一条带 reason 的 `attempt.failed` 事件；预算不多扣、无采用、无快照、无发布项、不 completed。**把租约改成已过期后再 claim 仍是 `run_paused`，Attempt 不会复活、不会自动开第二个 Attempt**；只有显式 `resume` 之后重派才成立（Attempt 变 2）。 |
| E2E-05 | **A37 必需检查未评估**：必需发布仍是 `pending` 时运行**不得** `completed`，再领取被判 `step_not_claimable`；检查失败发布后运行 `paused` + `pause_reason='publish_failed'`，claim 被拒、`resume` 被 `publish_conflict` 拒绝（不能靠继续按钮绕过未评估的检查），且没有 `run.completed` 事件。 |
| E2E-06 | **A37 输出缺失：记录原因并停止**：下游领取后把上游对象文件从磁盘删掉，`runNode` 报 `artifact_missing:parent_object_missing` 并**由执行器自己 markFailed**——运行 `paused` 且 `pause_reason` 含 `parent_object_missing`、Attempt `failed`、步骤 `paused`；已终结的 Attempt 再问输入被 `attempt_invalid:attempt_failed` 拒绝；**孤儿快照按 `source_attempt_id` 查**（先拿上游快照做正控证明查询有效，再断言失败 Attempt 没有任何快照行、也没有 `${attemptId}:snapshot` 这一行、全库只剩上游那 1 个快照）、不采用、不追加发布项、只 1 个 Attempt；**租约过期后 claim 仍 `run_paused`、不重派**；`readArtifact` 报 `artifact_missing:object_not_on_disk`。 |
| E2E-07 | **A37 越权副作用**：节点 Agent 发布被 `capability_unavailable:node-agent_may_not_publish.official` 拒绝，发布项数量/状态/目标全部不变；节点 Agent 确认人工待办被 `node-agent_may_not_confirm.human` 拒绝，待办仍 `open`。 |
| E2E-08 | **A01 输入链被篡改即失败（新增）**：把上游对象文件做**同长度**改写（字节数不变，只有内容哈希能抓住），`runNode` 报 `artifact_missing:parent_content_mismatch`；运行 `paused` 且原因记录、无第二个采用、对象库里没有任何篡改后的采用快照；`readArtifact` 报 `artifact_missing:content_hash_mismatch`。 |

变异（7 条，全部被抓；改完即还原并核对 sha256 一致）：

| 变异 | 内容 | 抓到它的检查 |
| --- | --- | --- |
| N1 | 去掉 `host.inputFor` 的「只有 running 才能取输入」闸门 | E2E-06 |
| N2 | 读输入失败只抛出、不记录原因（不 markFailed） | E2E-06、E2E-08 |
| N3 | 提交被硬拒时只抛出、不记录原因（不 markFailed） | E2E-04 |
| N4 | 节点输出不再依赖读到的输入（返回固定内容） | E2E-01、E2E-02 |
| N5 | 输入完整性退回「只读库指针、不校验对象文件」 | E2E-06、E2E-08 |
| N6 | 失败 Attempt 留下孤儿快照，主键就是 `${attemptId}:snapshot` | E2E-06（`a failed attempt must not leave an orphan snapshot, found ["e2e-output-missing:step:2:attempt:1:snapshot"]`）、E2E-08 |
| N7 | 失败 Attempt 留下主键不同的孤儿快照 `${attemptId}:ghost`（**旧断言按 attemptId 查快照会漏掉**） | E2E-06（`… found ["e2e-output-missing:step:2:attempt:1:ghost"]`）、E2E-08 |

孤儿快照断言的对照实验（证明这次修复不是同义反复）：同一条 N7 变异下，**旧写法** `SELECT id FROM workflow_snapshots WHERE id = <attemptId>` 仍返回空、E2E-06 判 **pass**（盲）；**新写法**按 `source_attempt_id` 查则判 **fail** 并打印出 `e2e-output-missing:step:2:attempt:1:ghost`。实验脚本跑完自动还原，`restored:true`。

可复现输出：

```
$ node scripts/verify-workflow-m1-endtoend.mjs
{"checks":8,"passed":8,"assertions":132}
E2E-01 {"status":"completed","adoptions":3,"publishes":3}
E2E-02 {"status":"completed","humanSnapshot":"e2e-human:step:2:human-attempt:2:snapshot","draft":"e2e-human:human:e2e-human:step:2:draft:2"}
E2E-03 {"sameContentAsParent":true,"actor":"human"}
E2E-04 {"code":"schema_invalid","runStatus":"paused","pauseReason":"output_content_too_large","budgetUsed":1}
E2E-05 {"status":"paused","pauseReason":"publish_failed"}
E2E-06 {"code":"artifact_missing","runStatus":"paused","pauseReason":"input_parent_object_missing:e2e-output-missing:step:1:attempt:1:snapshot:object_missing","firstStepOutput":50}
E2E-07 {"deniedPublish":true,"deniedConfirm":true,"publishes":1}
E2E-08 {"code":"artifact_missing","runStatus":"paused","pauseReason":"input_parent_content_mismatch:e2e-tampered-input:step:1:attempt:1:snapshot:content_hash"}
```

变异复跑（临时脚本已删，跑完自动还原并核对 sha256 一致）：

```
{"allCaught":true,"restored":true,
 "results":[{"name":"N1 去掉 hostInputFor 的运行态闸门","applied":true,"caughtBy":["E2E-06"],"passed":7,"checks":8},
            {"name":"N2 输入失败只抛出、不记录原因","applied":true,"caughtBy":["E2E-06","E2E-08"],"passed":6,"checks":8},
            {"name":"N3 输出失败只抛出、不记录原因","applied":true,"caughtBy":["E2E-04"],"passed":7,"checks":8},
            {"name":"N4 节点输出不再依赖读到的输入","applied":true,"caughtBy":["E2E-01","E2E-02"],"passed":6,"checks":8},
            {"name":"N5 输入完整性退回「只读库指针、不校验对象」","applied":true,"caughtBy":["E2E-06","E2E-08"],"passed":6,"checks":8},
            {"name":"N6 失败 Attempt 留下孤儿快照（主键就是 attemptId:snapshot）","applied":true,"caughtBy":["E2E-06","E2E-08"],"passed":6,"checks":8},
            {"name":"N7 失败 Attempt 留下主键不同的孤儿快照（旧断言按 attemptId 查快照会漏掉）","applied":true,"caughtBy":["E2E-06","E2E-08"],"passed":6,"checks":8}]}
```

构建与回归：`pnpm run bundle` exit 0，`lib/index.js` 684.26 kB / gzip 178.28 kB、`lib/client.js` 964.16 kB / gzip 241.25 kB（本批未改宿主与客户端，尺寸未变）。回归全 exit 0：专项 8 项 132 条、内核 108、独立 22/22、假服务 24 项 457 条、人工确认 16 项 196 条、上下文 11 项 106 条、恢复 8 项 112 条、挂载 12 项 134 条、只读客户端 12 项 310 条、fixture 35、runs 115、states 39、tool-policy 70/70；`git diff --check` 干净。

已复原文件哈希（sha256）：

- `src/workflow/m1-kernel.mjs` = `b64fb11efed97eedc79e0cdd59607d4542a23941aaa0ab20c9ea54de27130086`（历史版本；当前哈希见顶部索引）（与 B4-2 签收时一致，本批未改）
- `src/workflow/m1-fake-service.mjs` = `6f5b8795c2fbf0309e848230680e47baeec99de15c2d3fa787743fa0dd41cd3d`
- `scripts/verify-workflow-m1-endtoend.mjs` = `6bd4ca52b0b4c580190e6f4bd41b2b256836ba3fca322841deb941595f62c9f9`
- `lib/index.js` = `35b12f94ac8a369a0cf5b27486e9ab64cf5590e68b16f6d566aaec6ae6837df1`
- `lib/client.js` = `bc94ac740589051ce9da364c6c6dfe5a3ede8d0aaa014b1e46ed9a10ad0dfae2`

边界（分别标明，别当成已全部验证）：

- 「下游消费手改快照」现在是**执行器的输出由读回的输入派生**，测试代码不再传入任何节点内容；但它验证的是 M1 契约里的数据流，不等于真实节点进程、真实模型或真实 HTTP。
- 「记录原因并停止」是**假执行器调 `kernel.markFailed`**（Attempt 终结 + 步骤与运行 `paused` + `attempt.failed` 事件），不是测试发 pause；租约到期后的行为也被覆盖，但**不是真实断电或进程崩溃**，跨进程与断电仍属 M0-B。
- 人工节点的草稿保存仍走内核 `saveDraft`（假服务没有对应写入口）：宿主没有可信会话身份（`RouteRequest` 无会话字段，见 B4 子批身份边界），UI 写路径继续阻塞（M0-B）。
- 重启是**同进程关库重开 + 新建假服务实例**，不是跨进程崩溃或断电。
- E2E-06/E2E-08 的失效是删文件与同长度篡改，不是执行器进程中途崩溃。
- E2E-06 的「无孤儿快照」按 `source_attempt_id` 校验，并先用上游快照做正控证明该查询能命中，避免再次退化成恒真断言；`${attemptId}:ghost` 变异证明旧写法会漏判。
- A37 的「越权副作用」只覆盖本批已冻结的权限矩阵（节点无发布/无确认），不覆盖 Agent 通过未开放工具扩大权限的路径（随 M2 与 A16/A17 验）。

## B1 假服务与长任务协议（W1-10）

依据 [contract-tool-governance.md](../m0/contract-tool-governance.md) 的 G-01–G-10 工具清单、§4 冻结错误码、§5 权限矩阵与 §6 jobRef 协议，在 `src/workflow/m1-fake-service.mjs` 实现进程内假业务服务：工具面（`registerPrincipal`/`startRun`/`getRun`/`listArtifacts`/`readArtifact`/`listEvents`/`submitOutput`/`reportProgress`/`commandRun`/`getJob`/`cancelJob`/`downloadArtifact`/`listHumanTasks`/`confirmHumanTask`）与宿主侧对象（`claimRun`/`registerRunProduct`/`outboxFor`/`executeJob`/`reconcileJob`/`confirmJobCancel`/`publish`）分离，宿主侧不挂在工具面上。不监听端口、不注册 DSH 工具、不接主入口。

| 检查 | 覆盖的行为 | 关键点 |
| --- | --- | --- |
| S1 | 权限矩阵关键格 | node-agent 不能确认、other-agent 不能读产物、ui 可确认并推进；确认拒绝走 `capability_unavailable`；**另一产品的 UI 读 run / 列产物 / 读事件 / 控制运行 / 确认待办全部 `product_not_authorized`，且被拒的确认既不关闭待办也不产生快照** |
| S2 | 输入与凭证校验 | 空内容、超 `MAX_OUTPUT_BYTES`、进度越界、缺 productId、缺 expectedRevision、缺凭证均按冻结码拒绝 |
| S3 | attempt 归属与不可探测 | 越权 attempt 与伪造 token 分别 `capability_unavailable` / `attempt_invalid`；**未授权者对外来 attempt 用错 token 与真实 token 得到完全相同的拒绝，不存在的 attemptId 也与外来 attempt 同一拒绝**；授权者错 token 仍 `attempt_token_mismatch`，正确凭证可正常重放 |
| S4 | 稳定 jobRef 与凭证 | 同一 attempt 重复提交只认一个 jobRef（`reused:true`），不同 content 不会二次派发；**已绑定 jobRef 后错 token 提交抛 `attempt_invalid:attempt_token_mismatch`，取不回该作业、不新建作业** |
| S5 | 调用重放 | 同 key 同内容回放同一 operation（`replayed:true`），同 key 异内容 `schema_invalid:idempotency_conflict` |
| S6 | 受理不明先对账 | `outcome_unknown` 时拒绝直接重提，`reconcileJob(not_executed)` 后才 `resume` 并领取新 attempt、新 jobRef |
| S7 | 对账为已执行 | 补采用一次、不重复执行宿主；产物缺失时 `artifact_missing`，不得冒充成功；对账后仍须显式 `resume` |
| S8 | 下载失败不重复提交 | 首次取件失败返回 `nextAction=retry_download`；重试取回同一产物，`hostExecutions` 仍为 1，作业数不变 |
| S9 | 取消以宿主确认为准 | 受理后是 `cancelling`，未确认不能当已取消；重复取消只回放；确认后迟到执行为 `cancelled` 且不计执行 |
| S10 | 取消未确认 | 宿主否认 → `outcome_unknown` 待对账；成功后取消不回退，产物仍可下载 |
| S11 | 运行取消边界 | 未开始作业作废、在途未知转对账；迟到成功不采用、不复活已取消运行 |
| S12 | 运行控制 | expectedRevision 不匹配拒绝；暂停期间 `claimRun` 抛 `run_paused`；同 key 重复暂停回放；`resume` 后恢复（在途步骤也能继续） |
| S13 | 人工等待 | node-agent 只能列出被授权的待办，不能确认；ui 确认后运行回 `running` 并可领后续步骤 |
| S14 | 产品隔离 | 他产品 agent 读不到产物；只读身份不因参数被绕过 |
| S15 | 事件分页 | cursor/limit 有界、seq 严格递增、无重复；重放进度不追加重复事件 |
| S16 | 必需发布门 | 发布 pending 时运行保持 `running`；成功后 `completed`；失败后 `paused/publish_failed`；发布同样按 outbox 反查所属产品再判身份 |
| S17 | 宿主操作不在工具面 | `reconcileJob`/`confirmJobCancel`/`executeJob`/`publish` 只在宿主对象上；冻结码齐全；未知 job 走 `attempt_invalid` |
| S24 | 目标对象入口的存在性隐藏矩阵 | 对 `getRun`/`listArtifacts`/`readArtifact`/`listEvents`/`commandRun`（ui、other-agent、http、scheduler、scoped node-agent 五类身份）、`submitOutput`/`reportProgress`（ui、http、scoped node-agent；attempt 级另比 `attempt_invalid:attempt_not_found` 与 `capability_unavailable:attempt_not_authorized`，并断言被拒后 `state().jobs.length` 不变、`workflow_events` 条数不变，再用正向对照证明两个计数都敏感：新 attempt 合法提交后 `jobs.length` 恰好 +1；同一 run 上合法 `reportProgress` 前后事件数恰好 +1，且新增那条为 `attempt.progress`、`percent` 与会话一致）、`getJob`/`cancelJob`/`downloadArtifact`、`confirmHumanTask`，逐入口比较「跨产品现存」与「不存在」的外部响应，要求码与 detail 完全一致（run 级 `artifact_missing:run_not_found`、scoped `capability_unavailable:run_not_authorized`、job 级 `attempt_invalid:job_not_found`、task 级 `human_confirm_required:human_task_not_found`）；本产品读/下载/列待办正常；无凭证与未知对象同码；越界快照 `snapshot_not_in_run`、版本不符 `expected_revision_mismatch` 等真实内部错误不被伪装成 404 |
| S23 | 提交凭证与 jobRef 存在性 | 带 `sess-1` 的 http-client 正确凭证提交必须被受理（此前漏传导致 `credential_required`）；缺凭证仍 `credential_required`；p2 会话对 p1 现存 job 与未知 job，`getJob`/`cancelJob`/`downloadArtifact` 三条路径的码与 detail 完全一致；本产品读/下载/取消正常；scoped node-agent 仍 `run_not_authorized` |
| S21 | 控制入口的凭证透传 | 同一 `sess-1` 的 http-client 能 `getJob` 就必须能 `cancelJob`（→ `cancelling`、`await_host_confirmation`）；缺/错凭证对「已存在 jobRef」与「未知 jobRef」返回同一 `credential_required`（两组深比较）；带正确凭证的未知 jobRef 是普通 `job_not_found`；node-agent 授权作业仍可取消、未知 jobRef 仍 `run_not_authorized` |
| S22 | 启动与控制共用凭证边界 | http-client 缺/错凭证启动返回同一 `credential_required` 且不建运行；带凭证可 `startRun`/`pause`/`resume`；p2 会话不能替 p1 建运行（`product_not_authorized`）；未获授权的 node-agent 不能靠启动入口绕过 scoped |
| S20 | 受限身份与待办列表 | scoped 的 node-agent 对「未授权但存在」「不存在」「跨产品」三种 run，`getRun`/`listArtifacts`/`readArtifact`/`listEvents`/`commandRun` 全部同一 `capability_unavailable:run_not_authorized`；未知 `jobRef` 对 `getJob`/`cancelJob` 也是该码而非 `job_not_found`；p2 的 UI 调 `listHumanTasks`（带或不带 productId）都拿不到 p1 的待办；授权路径照旧可读可取消 |
| S19 | 读接口凭证先于解析 | 未认证的 http-client 对已存在 run / 不存在 run / 跨产品 run、缺凭证与错凭证，`getRun`/`listArtifacts`/`readArtifact`/`listEvents` 全部得到同一 `capability_unavailable:credential_required`；`jobRef` 存在与不存在同样一致；`commandRun` 也必须先认证；认证后本产品可读、缺失 run 报 `run_not_found`、跨产品报 `product_not_authorized` |
| S18 | 权限矩阵逐格自检 | 遍历 5 类身份 × 9 个能力，把每个 `deny` 格用一次性 principal 实测拒绝（含 `write.direct` 不存在直写入口）；`deny` 判在解析对象之前 |

失败反例本身是断言的一部分：S2/S3/S5/S6/S7/S10/S12/S14/S17/S18 的预期都是「必须被拒绝或必须不动」，服务把 `deny` 判在解析实体之前，因此被拒绝的会话无法从错误码反推对象是否存在。

边界收紧（老大 B1 退回后的十四处修复，另有七处“断言自身失效”修正）：

| 缺口 | 根因 | 修复 | 负例 |
| --- | --- | --- | --- |
| 跨产品 UI 可读别人的 run（G-01 本产品本会话可见） | `PERMISSIONS.ui.read.run` 是 `allow`，`authorize` 的 `product` 档只有 other-agent 用到，UI 不核产品 | UI 的 `read.run`/`read.artifact`/`read.events`/`read.job` 改为 `product` 档；并在 `authorize` 末尾对**所有**档位统一再判产品边界（任何带 `productId` 的会话都不得访问别的产品），`publish` 也先按 outbox 反查所属产品再判 | S1 |
| 已绑定 jobRef 后错 token 仍能取回作业（G-04 attempt 凭证边界） | `submitOutput` 先查 `attemptJobs` 复用分支，token 校验在复用分支之后 | 把 `attempt.token` 校验提到复用分支之前，凭证先于复用 | S4 |
| 同幂等键 + 同请求体、只换错 token 仍返回原 jobRef 且 `replayed:true`（G-04 与幂等交互） | 幂等重放命中时在 `execute()` 之前就返回缓存结果，而 token 校验写在 `execute()` 里，重放路径根本不经过凭证校验 | 把 `attempt.token` 校验提到 `idempotent(...)` **调用之前**，并额外把 `credential = hash({attemptId, token})` 并入请求指纹 | S4、S5 |
| run 级入口对跨产品现存 run 报 `product_not_authorized`、对不存在 run 报 `run_not_found`（跨产品存在性预言机，五个入口共用） | 每个入口各自 `runContext` + `authorize`，授权失败直接抛出，缺失与无权两条路径不同码 | 抽出 `guardedRunContext`：先 `assertPreAuthorized`，再取对象；对象缺失或 `authorize` 抛 `capability_unavailable` 时统一走 `hidden()`（scoped/attempt → `run_not_authorized`，其余 → `run_not_found`），只吞授权类失败 | S24 |
| `submitOutput`/`reportProgress` 对跨产品现存 attempt 报 `product_not_authorized`、对不存在 attempt 报 `attempt_not_found`（attemptId 存在性预言机，G-04/G-05） | 前置身份通过后先 `attemptContext` 解析、再跑完整产品授权，缺失与无权两条路径不同码 | 新增 `guardedAttemptContext`：`assertPreAuthorized` 之后解析 attempt，缺失或 `authorize` 抛 `capability_unavailable` 时统一走 `hidden()`（attempt 档 → `attempt_not_authorized`，其余 → `attempt_not_found`）；两个入口改用它，拒绝发生在幂等表与副作用之前 | S24 |
| S24 的事件正向对照曾写成“`run-s24-positive` 总事件数 > 0”，而 `claimRun` 早已写入 `attempt.claimed`，删掉 `reportProgress` 的事件写入仍然通过 | 正向对照没有取前后差值，无法证明新增事件来自进度上报 | 在合法 `reportProgress` 前记录同一 run 的事件数，之后断言恰好 +1，并核对最后一条事件为 `attempt.progress` 且 `percent` 正确 | S24 |
| S24 的“无副作用”断言曾用 `service.state().jobs.size`，而 `state().jobs` 是数组，比较的是两个 `undefined`（恒真，杀不死“拒绝时误建作业”的变异） | S24 无副作用检查取错字段 | 改为 `.length`，补 `Array.isArray` 前提断言，并加正向对照：在全新 attempt 上合法提交后计数必须 +1、合法进度上报后事件必须增加 | S24 |
| `confirmHumanTask` 对跨产品现存 task 报 `product_not_authorized`、对不存在 task 报 `human_task_not_found`（taskId 存在性预言机） | 先按 taskId 查表，查不到立刻抛 `human_task_not_found`；查到了才走产品判定 | 缺失的 task、缺 step、`authorize` 授权失败统一走 `taskHidden()` → `human_confirm_required:human_task_not_found` | S24 |
| `submitOutput` 在完整授权时漏传会话凭证：正确凭证的 HTTP 提交仍被拒 | `authorize({...context:{attemptId,runId,productId}})` 少了 `credential`，`credential` 档拿到 `undefined`，必然 `credential_required` | 把 `credential` 一并传入 `authorize` 的 context（与 `commandRun`/`reportProgress` 的幂等 context 口径一致） | S23 |
| `jobContext` 对认证后的跨产品现存 job 报 `product_not_authorized`、对未知 jobRef 报 `job_not_found`（跨产品存在性预言机） | 缺失判断只按档位分叉，解析出 job 后直接 `authorize` 抛错，两条路径不同码 | 引入 `hidden()`：scoped/attempt → `run_not_authorized`，其余 → `job_not_found`；job 缺失与 `authorize` 失败（产品/归属）都走同一 `hidden()`，凭证失败仍由前置 `assertPreAuthorized` 抛 `credential_required` | S23 |
| `cancelJob` 吞掉会话凭证：能读自己 job 的 http-client 无法取消它（正常路径回归） | `cancelJob` 签名只有 `principal`/`jobRef`/`idempotencyKey`，既不把 `credential` 传给 `jobContext` 也不并入幂等 context，`credential` 档永远拿不到凭证比较 | 签名补 `credential`，透传给 `jobContext` 与幂等 context；`startRun` 同类缺漏一并补上（`assertPreAuthorized(principal,'control.run',{credential})`） | S21、S22 |
| p2 的 UI 能从 `listHumanTasks` 拿到 p1 的待办（G-01 本产品本会话可见） | `listHumanTasks` 只对 `other-agent` 按产品过滤，UI 的 `read.run` 是 `product` 档但待办查询走的是全表 | 过滤条件改为「任何带 `productId` 的身份都按 `runProducts` 过滤」，再叠加 `runIds` 过滤 | S20 |
| scoped node-agent 可用 `run_not_authorized` 与 `run_not_found` 区分 run 是否存在（G-01 存在性预言机） | `assertPreAuthorized` 只前置了 attempt 与 credential 两档，`scoped` 档要等解析出 run 后的 `authorize` 才判 | `assertPreAuthorized` 增加 `runId` 参数，`scoped` 档在解析前按 `record.runIds` 判定；四个读接口与 `commandRun` 都传入 `runId`；`jobContext` 对 scoped/attempt 身份把「作业不存在」与「无权」合并为 `run_not_authorized` | S20 |
| 未认证调用方可探知 run/job 是否存在（G-01/G-08 先解析后授权） | `getRun`/`listArtifacts`/`readArtifact`/`listEvents` 先 `runContext` 再 `authorize`；`jobContext` 先查 `jobs` 再授权；`commandRun` 干脆只有档位检查、凭证要等 `idempotent` 内的 `authorize` | 新增 `assertPreAuthorized(principal, capability, {attemptId, credential})`：只凭身份档位、被授予的 attempt 集合与会话凭证判定，**不解析任何对象**；插到全部「先解析后授权」入口之前（四个读接口、`jobContext`、`commandRun`、`reportProgress`、`submitOutput`、`confirmHumanTask`），解析后再跑完整 `authorize` 复核产品边界 | S19 |
| 未授权者可由错误码差异探测凭证（G-04 授权与凭证顺序） | 上一修复把 token 校验提到最前，排在了 `authorize` 的 attempt 判定之前，于是「错 token → `attempt_token_mismatch`、对 token → `attempt_not_authorized`」构成凭证正确性预言机 | 新增 `assertAttemptGranted`，只凭身份与被授予的 attemptIds 先行判定，**不解析对象**；随后才 `attemptContext` → `authorize`（含产品边界）→ token 校验 → 幂等。顺带堵住「不存在的 attemptId 报 `attempt_not_found`」的存在性探测 | S3 |

变异测试（临时文件，未留在仓库）：把 other-agent 的 `read.artifact` 从 `deny` 改成 `allow` → S14 FAIL；去掉 `attemptJobs` 复用 → S4/S6 FAIL（jobRef 变化）；把取消受理直接置 `cancelled` → S9/S10 FAIL；删掉 `authorize` 里的统一产品判定 → S1 FAIL（跨产品读取成功）；把 token 校验挪回复用分支之后 → S3/S4 FAIL（错 token 取回作业）；**删掉 `idempotent` 之前的 token 前置校验 → S3/S4/S5 FAIL（错 token 命中重放）**；把前置的 `assertPreAuthorized` 删掉或挪到 token 校验之后 → S1/S3 FAIL（未授权者拿到 `attempt_token_mismatch`，且不存在的 attemptId 与外来 attempt 可区分）；把 `getRun` 的凭证前置挪回 `runContext` 之后 → S19 FAIL（已存在 run 与缺失 run 返回不同码）；删掉 `jobContext` 的前置 → S19 FAIL（`job_not_found` 泄露 jobRef 存在）；删掉 `commandRun` 的前置 → S19 FAIL（缺失 run 报 `artifact_missing` 而非 `credential_required`）；**删掉 `reportProgress` 里的 `kernel.appendEvent(...)`（受理照旧返回）→ S24 FAIL（`an accepted progress report must add exactly one event, 2 -> 2`），而旧的“总数 > 0”写法对同一变异只有 S15 失败、S24 仍通过（空验证的直接证据）；只在“跨产品 attempt 被隐藏”这条路上误建作业（探针走 attempt 档时不触发）→ S24 FAIL（`rejected submissions must not create jobs, 1 -> 5`），把同一变异放到 `.size` 旧写法下则 24/24 全绿（断言无效的直接证据）；`submitOutput`/`reportProgress` 退回复用不带守卫的 `attemptContext` + `authorize` → S24 FAIL（跨产品 attempt 与缺失 attempt 可区分）；run 级入口的授权失败恢复成直接抛 `product_not_authorized` → S1/S14/S19/S24 FAIL（跨产品与缺失可区分）；`confirmHumanTask` 恢复成直接抛产品码 → S1/S24 FAIL；把越界快照的 `snapshot_not_in_run` 改成 `run_not_found` → S24 FAIL（真实内部错误被伪装成 404）；`cancelJob` 退回不带 credential 的旧签名 → S21 FAIL（`credential_required`）；`startRun` 去掉凭证前置 → S22 FAIL（`credential_required` 且不建运行）；`submitOutput` 的 `authorize` 去掉 `credential` → S23 FAIL（`credential_required`，即老大复现的正常路径被拒）；`jobContext` 去掉 `hidden()` 包裹 → S23 FAIL（跨产品现存 job 与未知 job 报错可区分）；把待办过滤改回只对 `other-agent` → S20 FAIL（p2 UI 拿到 p1 待办）；删掉 `assertPreAuthorized` 的 scoped 判定 → S20 FAIL（未授权 run 与缺失 run 返回不同码）；把 `jobContext` 的「不存在」恢复成 `job_not_found` → S20 FAIL（jobRef 存在性泄露）**；还原后 24/24、457 条断言。注：`guardedAttemptContext` 里「只吞 `attempt_invalid`」这一分支目前没有别的错误源，单独改写成吞掉所有错误也全绿，故不记为独立已验收边界。

凭证并入请求指纹（`credential` 字段）是纵深防御，不是独立可观测的行为：在 token 前置校验存在时，去掉该字段测试仍全绿（已实测），所以它不能被单独当作已验收的边界，本条只声明前者有变异测试覆盖。

## 可复现命令与结果

运行目录：`D:/AI/dsh-workbench`；基线提交 `9d7cac8`，工作区含本轮未提交改动。

```text
node scripts/verify-workflow-m1.mjs
{"checks":108,"tables":["workflow_adoptions","workflow_attempts","workflow_drafts","workflow_events","workflow_human_tasks","workflow_outbox","workflow_requests","workflow_runs","workflow_snapshots","workflow_steps"],"scope":"temporary SQLite, synthetic fixtures and fake executor only"}
exit code 0

node scripts/verify-workflow-m1-human-confirm.mjs
{
  "checks": 12,
  "passed": 12,
  "assertions": 119,
  ...
}
exit code 0

node scripts/probe-schema-dialect.mjs
{"probe":"required-as-string","error":{"code":"schema_invalid","detail":"input_schema:required_not_array"}}
{"probe":"minimum-2-rounds-1","error":{"code":"input_schema_invalid","detail":"rounds:below_minimum"}}
{"probe":"minimum-2-rounds-2","result":true}
{"probe":"self-made-min-2-rounds-1","error":{"code":"schema_invalid","detail":"input_schema:properties.rounds:unsupported_keyword:min"}}
{"probe":"minimum-without-type-rounds-not-a-number","error":{"code":"schema_invalid","detail":"input_schema:properties.rounds:constraint_without_type:minimum"}}
{"probe":"string-with-minimum-x","error":{"code":"schema_invalid","detail":"input_schema:properties.plan:constraint_type_mismatch:minimum:string"}}
{"probe":"number-with-minlength-0","error":{"code":"schema_invalid","detail":"input_schema:properties.rounds:constraint_type_mismatch:minLength:number"}}
{"probe":"compatible-minimum-2-rounds-1","error":{"code":"input_schema_invalid","detail":"rounds:below_minimum"}}
{"probe":"compatible-minimum-2-rounds-2","result":true}
{"probe":"prototype-required-toString","error":{"code":"schema_invalid","detail":"input_schema:required_undefined:toString"}}
{"probe":"prototype-required-constructor","error":{"code":"schema_invalid","detail":"input_schema:required_undefined:constructor"}}
{"probe":"inherited-value-plan","error":{"code":"input_schema_invalid","detail":"plan:required"}}
{"probe":"properties-null","error":{"code":"schema_invalid","detail":"input_schema:properties_null"}}
{"probe":"own-key-plan-ok","result":true}
exit code 0

node scripts/verify-workflow-m1-service.mjs
ok   S1 permission matrix key cells
ok   S2 input and credential validation
ok   S3 attempt ownership
ok   S4 stable jobRef per attempt
ok   S5 replay does not double-execute
ok   S6 unknown outcome is reconciled before any retry
ok   S7 reconciling as executed adopts once and never re-executes
ok   S8 a failed download never resubmits the generation job
ok   S9 cancellation is only final after host confirmation
ok   S10 an unconfirmed cancel becomes unknown and a succeeded job cannot be cancelled
ok   S11 run cancellation settles queued and in-flight jobs without reviving the run
ok   S12 run commands require expectedRevision and pause blocks claiming
ok   S13 human waiting is read-only for agents and resolves on the ui channel
ok   S14 product isolation and read-only access for other agents
ok   S15 events page with a bounded cursor without duplicates
ok   S16 required publish gates run completion through the fake service
ok   S17 host-only operations are absent from the tool surface
ok   S18 every deny cell in the permission matrix is enforced
{"checks":24,"assertions":457,"passed":24,"failed":[],"scope":"fake business service only; temporary SQLite, temporary object root, no real HTTP, no host tool registration"}
exit code 0

node scripts/verify-workflow-m1-context.mjs | grep -E '"id"|"status": "fail"' | head -20
      "id": "CTX-01",
      "id": "CTX-02",
      "id": "CTX-02B",
      "id": "CTX-03",
      "id": "CTX-04",
      "id": "CTX-05",
      "id": "CTX-06",
      "id": "CTX-08",
      "id": "CTX-08B",
      "id": "CTX-08C",
      "id": "SORT-01",
(no `"status": "fail"` line)
node scripts/verify-workflow-m1-context.mjs | grep -E '"checks"|"passed"|"assertions"'
  "checks": 11,
  "passed": 11,
  "assertions": 106,
exit code 0

node scripts/verify-workflow-m1-independent.mjs
ok   C1 parent snapshot points to upstream snapshot across steps
ok   C2 re-adoption parent is a snapshot id, not an adoption id
ok   C3 confirmHuman replays the same idempotency key without duplicating rows
ok   C4 expired lease rejects adoption and re-claims as a new attempt
ok   C5 cancelled run rejects claim
ok   C6 upstream re-adoption marks downstream step stale
ok   C7 attempts accumulate budget_used and block when exhausted
ok   C8 outbox supersedes pending items and supports retry
ok   C9 adopt verifies the manifest on disk
ok   C10 failed adoption rolls back and stale draft revision is rejected
ok   C11 kernel refuses non-SQLite storage
ok   C12 cancelled run rejects a late human confirmation and stays cancelled
ok   C13 stale downstream rejects its pre-change attempt
ok   C14 required publish pending blocks completion
ok   C15 publish failure or conflict pauses the run
ok   C16 unknown publish outcome requires reconciliation
ok   C17 cancellation settles queued and in-flight publishes
ok   C18 cancel then reconcile never revives the run
ok   C19 claim cannot bypass a publish-blocked pause
ok   C20 attempt failure needs an explicit resume
ok   C21 human waiting blocks later steps until confirmed
ok   C22 reconciled unknown outcome still needs an explicit resume
{"checks":22,"passed":22,"failed":[],"scope":"independent M1 acceptance; temporary SQLite, synthetic content, fake executor only"}
exit code 0
```

相关回归（同一提交、同一工作区）：

```text
node scripts/verify-workflow-page-mount.mjs -> {"checks":12,"passed":12,"assertions":134,"failed":0} exit 0
node scripts/verify-workflow-readonly-client.mjs -> {"checks":8,"passed":8,"assertions":172,"failed":[]} exit 0
node scripts/verify-workflow-m1-human-confirm.mjs -> {"checks":16,"passed":16,"assertions":196} exit 0
node scripts/verify-workflow-m1-context.mjs -> {"checks":11,"passed":11,"assertions":106} exit 0
node scripts/verify-workflow-m1-recovery.mjs -> {"checks":8,"passed":8,"assertions":112} exit 0
node scripts/verify-workflow-fixture.mjs   -> {"checks":35,"sqlite":"3.53.1",...} exit 0
node scripts/verify-workflow-runs.mjs      -> {"checks":115,...} exit 0
node scripts/verify-workflow-states.mjs    -> {"checks":39,...} exit 0
node scripts/verify-tool-policy.mjs        -> 70/70 通过 exit 0
git diff --check                            -> 通过（仅 LF→CRLF 提示）
```

`pnpm run bundle` 执行记录（区分双方，避免把一次执行写成未执行）：

| 执行方 | 时机 | 结果 |
| --- | --- | --- |
| happy-4.1 | 第六轮修复后，本工作区 `D:/AI/dsh-workbench` | exit 0，`[dsh-workbench/client] 1 files, total: 939.19 kB` |
| 老大 | 第六轮独立复核 | 独立复跑 exit 0 |
| happy-4.1 | B4 子批（宿主薄挂载）后 | exit 0，`lib/index.js 674.60 kB`（gzip 175.65 kB）、`lib/client.js 939.19 kB`（gzip 234.31 kB） |
| happy-4.1 | B4-2 子批（A10/A36）后 | exit 0，`[dsh-workbench/host] lib\index.js 684.26 kB │ gzip: 178.28 kB`、`[dsh-workbench/client] lib\client.js 939.19 kB │ gzip: 234.31 kB`（内核新增约 9.6 kB：schema 方言 + 类型-约束相容性 + 自有键判定、意图参数、待办重开） |
| happy-4.1 | B4-3 子批（只读客户端）后 | exit 0，`[dsh-workbench/host] lib\index.js 684.26 kB │ gzip: 178.28 kB`（未变，本批未改宿主）、`[dsh-workbench/client] lib\client.js 964.16 kB │ gzip: 241.25 kB`（+24.97 kB：只读页组件 + 只读逻辑 + 读故障横幅 + 侧栏入口） |

B4 子批之前该命令只构建 `src/host`、`src/client` 两个入口，两者都不引用 `src/workflow/`，所以 bundle 通过不证明内核进入主运行时。B4 子批把 `workflow-page.ts` 接进宿主入口后，`lib/index.js` 由 623.49 kB 增至 674.60 kB 且含内核建表 SQL、快照校验错误码与库隔离判定，**bundle 现在可以作为「内核已进入主运行时」的构建证据**（PM-08 断言这些片段）；它仍不证明真实 DSH `webServer` 的 prefix 路由在浏览器端可用。

## 未覆盖与阶段门

仍未覆盖，属于 W1 后续或 M0-B：租约心跳续期（只有超时判死与重领）、真正的后台扫描循环（B3 的 `scanRecoverable` 只做纯读巡检，`reapExpiredLeases` 仍在 `claim` 内被动触发）、真实浏览器界面验证（B4 子批只做了宿主薄挂载与隔离；B4-3 提供了只读客户端逻辑与 React 组件，但只在注入的假 `fetchImpl` 上验证过，没有在真实 DSH 界面里跑；草稿编辑/确认暂停继续仍未实现）。B3 已补上幂等请求保留期清理、快照只读读取/校验导出（含行 id、manifest、对象三方对齐）、副本备份还原与双连接顺序交错验证；B4 子批把内测页接进宿主入口，但只提供只读路由（`/health`、`/runs`、`/runs/:id`），没有 `confirmHuman`/暂停/继续的 HTTP 入口；B4-3 把「只读」这一半做成了客户端页面（步骤状态、历史、错误），开关关闭时不挂入口且组件渲染 `null`，**写入口仍然是零**。B4-2 子批补上了 A10 的执行前输入校验（方言白名单 + 类型-约束相容性 + 自有键判定 + 创建时拒绝 + 领取前失败关闭）与 A36 的确认/暂停语义（同事务、不抢跑、旧基准拒绝且草稿保留），但**只在假服务层验证**：宿主路由拿不到可信会话身份，写 HTTP 入口一个都没开放，草稿编辑/确认暂停继续的客户端仍未实现——这是本批最明确的 UI 阻塞点，解除条件是 M0-B 能证明会话身份可注入路由。B2 上下文只到「捕获 + 拼装 + 收据 `verification: 'captured'`」，宿主确认与截断探测（CTX-07）属 M2；没有把上下文接到主运行时，也没有真实模型或真实资料清单。假 HTTP/tool 适配已由 B1 以进程内假服务覆盖工具面语义，但**没有**监听端口、没有注册 DSH 工具、没有跨进程或跨重启的 jobRef 查询路径，这些仍属 M0-B。逐项状态、最小交付顺序、文件边界与验收命令见 [gap-inventory.md](gap-inventory.md)。events 的 seq 仍是同事务内 `MAX(seq)+1`，跨进程并发下依赖 `BEGIN IMMEDIATE` 串行化，只在同库双连接层面验证过，未做多进程压测。M0-B 的真实身份、HTTP/会话、预算租约、幂等保留期和断电边界继续未验证，M2 自动写回保持关闭。

回退：本批（B4 子批）改动是**新增一个宿主模块 + 宿主入口两处最小改动 + 一个验证脚本 + 本目录证据**。回退时把 `src/host/index.ts` 的两处改动（`workflow-page` 的 import/re-export 行、`/workbench-api` 注册之后的 `mountWorkflowPage({...})` 调用块）删掉、不纳入 `src/host/workflow-page.ts` 与 `scripts/verify-workflow-page-mount.mjs`，即回到基线 `9d7cac8` 的运行时行为（B4 之前的 `src/workflow/` 新增文件同样未被任何入口引用）。B4-3 子批（只读客户端）同样是纯增量：回退只需删掉 `src/client/index.ts` 里的 `installWorkflowReadonlyPanel` import 行与 `apply()` 末尾那段调用，并排除 `src/client/workflow/`、`scripts/verify-workflow-readonly-client.mjs`；旧 `workbench` 面板与侧栏入口的代码一行都不用动，所以回退后界面与 B4-2 时完全相同。**不要直接删除未跟踪文件**：这些文件是未提交的工作产物，删除不可恢复；确需清理时先把文件移入备份目录（例如仓库外的归档路径）并记录清单，或在提交历史中留一次新增再回退，由负责人确认后再处理。
