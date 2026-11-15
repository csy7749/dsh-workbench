// W1-12「要求 AI 修订」的持久化层：把一次修订请求与它产出的独立候选落进内核的 SQLite。
//
// 为什么需要它：04:43 要求「要求 AI 修订」指定基准快照 / 草稿 revision、意见和保留项，
// 输出新候选，不覆盖人工正在编辑的 Draft；H04 再要求修订期间的草稿不被回写覆盖。
// 这两条只有在「请求」和「候选」各有一份可复读的独立存证时才成立：
// - 候选不能写进 workflow_drafts：那是用户正在编辑的草稿，写进去就是 H04 的违规。
// - 候选也不能靠 snapshot / adoption 表达：快照身份由 Attempt 派生
//   （内核 adoptTx 要求 candidate.snapshotId === `${attemptId}:snapshot`），修订没有 Attempt。
//
// 边界：
// - 只建自己的表 workflow_revision_requests；不改内核逻辑、服务、页面，不做其他表的迁移。
// - 构造时不建表（「打开」不应改写库），由调用方通过 ensure() 触发（内核建表清单、备份校验）。
// - 只存元数据与文本：候选内容以文本存本表；字节与集合对象仍归对象库。
//   本模块不写草稿、不写快照、不写采用、不发布。
// - 请求部分是冻结的：基准、意见、保留项、requestKey 一经写入不可改；save() 只能在状态机
//   上推进，并且只改候选 / 报告 / 错误码这些随产出变化的列。
// - 读取一律重新校验：重建冻结载荷指纹、重算候选内容摘要、重算集合摘要、逐列核对派生列，
//   核对基准引用（快照 / 草稿 / 输入绑定）确实成立，并核对报告与「这份候选 + 冻结定义 + 冻结输入」
//   仍然对得上（含必需检查清单与 producedBy）。只核「历史事实是否成立」，绝不要求基准仍是
//   当前草稿 / 当前绑定。
// - 失败与旧记录不宽容：failed / superseded / applied 的行同样逐项校验，坏数据在备份校验里
//   必须报出来，不能因为「这条没成功」就跳过。
//
// 不在本模块职责内（留给调用方）：
// - 保留项是否真是基准集合的子集：需要读基准集合的文件清单，属于请求入口的校验。
// - 候选文件字节是否真的在对象库里：需要读对象库，属于内核采用 / 备份校验。
// - 预算扣减：内核在请求事务里调用 chargeBudget，本模块不感知预算。
import { createHash } from 'node:crypto'
import { canonicalJson, normalizeHumanOpinion, definitionDigestFor, assessValidationReport } from './m1-validation.mjs'
import { createValidationStore } from './m1-validation-store.mjs'
import { OUTPUT_ARTIFACT_TYPES, normalizeOutputSet, normalizeRelativePaths } from './m1-output-set.mjs'

/** 修订请求表。内核建表清单、备份校验、页面表清单都要登记这个名字。 */
export const REVISION_TABLE = 'workflow_revision_requests'

/**
 * 修订请求状态机。
 *
 * requested  → 已受理、还没产出候选
 * producing  → 受信修订器正在产出（同步假修订器也允许短暂停在这里）
 * ready      → 候选已产出并通过绑定验证，等用户显式应用
 * applied    → 用户已把候选写进草稿（写草稿由调用方完成，本模块只记结果）
 * superseded → 基准失效（草稿被改、待办重开、绑定过期），候选作废但留痕
 * failed     → 产出或验证失败，带错误码；失败报告可有可无
 */
export const REVISION_STATUSES = Object.freeze(['requested', 'producing', 'ready', 'applied', 'superseded', 'failed'])

/** 只允许向前推进的转移表。空数组表示终态。 */
export const REVISION_TRANSITIONS = Object.freeze({
  requested: Object.freeze(['producing', 'ready', 'failed', 'superseded']),
  producing: Object.freeze(['ready', 'failed', 'superseded']),
  ready: Object.freeze(['applied', 'superseded']),
  applied: Object.freeze([]),
  failed: Object.freeze([]),
  superseded: Object.freeze([]),
})

/** 允许「一次写入就落在该状态」的集合：同步假修订器可以跳过中间态。 */
export const REVISION_CREATABLE_STATUSES = Object.freeze(['requested', 'producing', 'ready', 'failed'])

/** 终态：不会再变，但依然要逐行校验。 */
export const REVISION_TERMINAL_STATUSES = Object.freeze(['applied', 'failed', 'superseded'])

export const REVISION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${REVISION_TABLE} (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  binding_version INTEGER NOT NULL,
  base_snapshot_id TEXT NOT NULL,
  base_draft_id TEXT,
  base_content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  request_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  opinion_json TEXT NOT NULL,
  retained_json TEXT NOT NULL,
  status TEXT NOT NULL,
  candidate_artifact_type TEXT,
  candidate_content TEXT,
  candidate_content_hash TEXT,
  candidate_output_set_digest TEXT,
  report_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`

export const REVISION_INDEX_SQL = [
  // 创建身份 + requestKey 唯一：重放同一请求幂等命中，换内容复用同一个 key 必须冲突。
  `CREATE UNIQUE INDEX IF NOT EXISTS ${REVISION_TABLE}_request_key ON ${REVISION_TABLE}(created_by, request_key)`,
  `CREATE INDEX IF NOT EXISTS ${REVISION_TABLE}_run ON ${REVISION_TABLE}(run_id)`,
  `CREATE INDEX IF NOT EXISTS ${REVISION_TABLE}_task ON ${REVISION_TABLE}(task_id)`,
]

/**
 * 本模块内部错误码（不是服务错误码）。
 * 服务侧仍映射到已冻结的 human_confirm_required，SERVICE_ERROR_CODES 保持 10 项。
 * 注意：相对路径类问题直接抛 m1-output-set.mjs 的 output_path_* 码——那些码更精确，
 * 在这里重写一遍只会让两处口径漂移。
 */
export const REVISION_STORE_ERROR_CODES = Object.freeze([
  'revision_store_input_invalid',
  'revision_association_invalid',
  'revision_record_invalid',
  'revision_status_invalid',
  'revision_candidate_invalid',
  'revision_request_conflict',
])

const fail = (code, detail = code) => Object.assign(new Error(`${code}:${detail}`), { code, detail })
const hash = value => createHash('sha256').update(value).digest('hex')

/**
 * 内核 hash 的逐字复刻（m1-kernel.mjs:29）：字符串按 UTF-8、其余按 JSON.stringify。
 *
 * 只用于核对内核写下的派生列（这里是 workflow_input_bindings.integrity_hash）。
 * 刻意不复用内核实例：离线备份校验只拿到 { db }，没有内核对象可调；
 * 而内核的 hash 对对象走 JSON.stringify，**键序敏感**——调用点必须用与本注释下方
 * 完全相同的字面量键序 { ownerId, version, inputs }，改键序等于改算法。
 */
const kernelHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

/**
 * 落库列顺序的唯一来源：INSERT 的列清单、占位符、取值数组都由这一处派生。
 * 23 列手写占位符只要少一个就会在运行期报「参数个数不符」，这里按列名取值，
 * 列数变了会自动跟着变。
 */
const INSERT_COLUMNS = Object.freeze([
  'id', 'run_id', 'step_id', 'task_id', 'task_revision', 'binding_version',
  'base_snapshot_id', 'base_draft_id', 'base_content_hash',
  'created_by', 'request_key', 'payload_fingerprint',
  'opinion_json', 'retained_json',
  'status', 'candidate_artifact_type', 'candidate_content', 'candidate_content_hash',
  'candidate_output_set_digest', 'report_id', 'error_code', 'created_at', 'updated_at',
])

/** 状态推进时允许改写的列：冻结的请求部分一律不在其中。 */
const UPDATE_COLUMNS = Object.freeze([
  'status', 'candidate_artifact_type', 'candidate_content', 'candidate_content_hash',
  'candidate_output_set_digest', 'report_id', 'error_code', 'updated_at',
])

const MAX_NAME = 200
const MAX_ERROR = 128
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

const nonEmpty = (value, field, max = MAX_NAME) => {
  if (typeof value !== 'string' || value.trim() === '') throw fail('revision_store_input_invalid', field)
  if (value !== value.trim()) throw fail('revision_store_input_invalid', `${field}:padded`)
  if (value.length > max) throw fail('revision_store_input_invalid', `${field}:too_long`)
  return value
}

const positiveInt = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 1) throw fail('revision_store_input_invalid', field)
  return value
}

const digestValue = (value, field) => {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw fail('revision_store_input_invalid', field)
  return value
}

// 只认唯一性冲突；NOT NULL / CHECK 失败被当成「重复保存」会报成误导人的冲突。
const uniqueViolation = error => /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(error?.message ?? '')

/**
 * 行 id 由「关联 + 创建身份 + requestKey」唯一确定。
 *
 * 不把正文放进 id：修订记录是可推进的（requested → ready → applied），正文会变，
 * id 必须跟着请求走而不是跟着候选走。反过来说，同一身份用同一个 key 只能对应一个请求。
 * 对结构化数组取摘要；run/step/task 的内核标识本来含 ':'，不能直接用分隔符拼接或禁止它。
 */
export const revisionIdFor = ({ runId, stepId, createdBy, requestKey }) =>
  `revision:${hash(canonicalJson([runId, stepId, createdBy, requestKey]))}`

const assertNoColon = (value, field) => {
  if (value.includes(':')) throw fail('revision_store_input_invalid', `${field}:colon`)
  return value
}

const sortPaths = paths => [...paths].sort()

/** 保留项：规范化 + 批内唯一 + 大小写碰撞 + 文件/目录碰撞，然后排序成规范形。 */
const normalizeRetained = (paths) => {
  if (paths === undefined || paths === null) return []
  return sortPaths(normalizeRelativePaths(paths))
}

/**
 * 意见与保留项：复用 m1-validation.mjs 的人工意见口径（它已经挡住
 * 「改机器结论」的字段，并接受 disposition='request_revision' 与 retained）。
 * 默认作者是发起人本身；at 不给就留空——时间戳进冻结载荷会让「同一请求重发」
 * 因时钟不同被判成冲突，幂等就没了。
 */
const normalizeOpinion = ({ opinion, createdBy, retained }) => {
  const input = opinion === undefined || opinion === null ? {} : opinion
  if (typeof input !== 'object' || Array.isArray(input)) throw fail('revision_store_input_invalid', 'opinion')
  const paths = normalizeRetained(retained === undefined ? input.retained : retained)
  const normalized = normalizeHumanOpinion({
    by: input.by ?? createdBy,
    at: input.at ?? undefined,
    note: input.note ?? undefined,
    disposition: input.disposition ?? 'request_revision',
    retained: paths,
  })
  if (normalized.disposition !== 'request_revision') {
    throw fail('revision_store_input_invalid', `opinion_disposition:${normalized.disposition}`)
  }
  return normalized
}

/**
 * 规范化候选。
 *
 * 文本类：content 原样保存，摘要按 UTF-8 字节算（与内核 hash(content)、
 * fileBytesDigest 同算法），不做换行 / 编码转换。
 * 文件集：只接受「已验证的规范化描述」。重新规范化一次并要求与调用方给的描述逐字节相等、
 * 摘要能重算且与自报一致——不能把调用方自带的 digest 当成证据，也不能悄悄纠正它。
 */
const normalizeCandidate = (candidate) => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw fail('revision_candidate_invalid', 'not_an_object')
  }
  const artifactType = candidate.artifactType
  if (!OUTPUT_ARTIFACT_TYPES.includes(artifactType)) throw fail('revision_candidate_invalid', `artifact_type:${String(artifactType)}`)

  if (artifactType === 'file-set') {
    if (candidate.content !== undefined) throw fail('revision_candidate_invalid', 'content_not_allowed_for_file_set')
    const set = candidate.outputSet
    if (!set || typeof set !== 'object' || Array.isArray(set)) throw fail('revision_candidate_invalid', 'output_set_required')
    // 调用方可以带上节点声明：内核 verifyOutputSet 走的是「声明 ↔ 实例」一一对应那条路，
    // 传进来才能核到同一套约束（缺实例、多实例、实例改写契约）。
    const declarations = candidate.declarations === undefined || candidate.declarations === null
      ? null
      : candidate.declarations
    let verified
    try {
      verified = normalizeOutputSet({ instances: set.outputs, files: set.files, declarations })
    } catch (error) {
      throw fail('revision_candidate_invalid', `output_set:${error?.code ?? 'invalid'}`)
    }
    // 描述本身必须已经是规范形：带着多余字段或未排序的清单，说明调用方没有真正「验证过」。
    if (canonicalJson(verified) !== canonicalJson(set)) {
      throw fail('revision_candidate_invalid', 'output_set_not_canonical')
    }
    if (typeof set.digest !== 'string' || verified.digest !== set.digest) {
      throw fail('revision_candidate_invalid', 'output_set_digest_mismatch')
    }
    // 落库正文统一用「实例自述」的规范形（按 name + 文件列表排序）。
    // 带声明规范化时实例顺序跟随声明顺序，若原样存下来，读路径不带声明重算就会因为
    // 顺序不同被判成 not_normalized——同一份数据在写和读两侧必须有同一个规范形。
    // 集合摘要只覆盖排序后的实例，所以这一步不改变摘要。
    const stored = normalizeOutputSet({ instances: verified.outputs, files: verified.files })
    if (stored.digest !== verified.digest) throw fail('revision_candidate_invalid', 'output_set_digest_order_dependent')
    const content = canonicalJson(stored)
    return { artifactType, content, contentHash: hash(content), outputSetDigest: stored.digest }
  }

  if (candidate.outputSet !== undefined) throw fail('revision_candidate_invalid', 'output_set_not_allowed')
  if (typeof candidate.content !== 'string') throw fail('revision_candidate_invalid', 'content')
  return { artifactType, content: candidate.content, contentHash: hash(candidate.content), outputSetDigest: null }
}

/** 冻结载荷：进入指纹的字段一旦写入就不能再变。 */
const frozenPayload = record => ({
  runId: record.runId,
  stepId: record.stepId,
  taskId: record.taskId,
  taskRevision: record.taskRevision,
  bindingVersion: record.bindingVersion,
  baseSnapshotId: record.baseSnapshotId,
  baseDraftId: record.baseDraftId,
  baseContentHash: record.baseContentHash,
  opinion: {
    by: record.opinion.by,
    at: record.opinion.at,
    note: record.opinion.note,
    disposition: record.opinion.disposition,
    retained: record.opinion.retained,
  },
})

const payloadFingerprintOf = record => hash(canonicalJson(frozenPayload(record)))

/** 候选文本的再次校验（读路径用）：摘要自洽，集合要能重算且等于存下的摘要。 */
const assertCandidateColumns = ({ content, contentHash, artifactType, outputSetDigest, id }) => {
  if (content === null) {
    if (contentHash !== null || artifactType !== null || (outputSetDigest ?? null) !== null) {
      throw fail('revision_record_invalid', `${id}:candidate_partial`)
    }
    return null
  }
  if (typeof content !== 'string') throw fail('revision_record_invalid', `${id}:candidate_content_type`)
  if (typeof contentHash !== 'string' || hash(content) !== contentHash) {
    throw fail('revision_record_invalid', `${id}:candidate_content_hash`)
  }
  if (!OUTPUT_ARTIFACT_TYPES.includes(artifactType)) throw fail('revision_record_invalid', `${id}:candidate_artifact_type`)

  if (artifactType !== 'file-set') {
    if ((outputSetDigest ?? null) !== null) throw fail('revision_record_invalid', `${id}:candidate_output_set_digest_unexpected`)
    return { artifactType, content, contentHash, outputSetDigest: null }
  }

  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw fail('revision_record_invalid', `${id}:candidate_set_unparsable`)
  }
  if (canonicalJson(parsed) !== content) throw fail('revision_record_invalid', `${id}:candidate_set_not_canonical`)
  let recomputed
  try {
    recomputed = normalizeOutputSet({ instances: parsed.outputs, files: parsed.files })
  } catch (error) {
    throw fail('revision_record_invalid', `${id}:candidate_set:${error?.code ?? 'invalid'}`)
  }
  if (canonicalJson(recomputed) !== content) throw fail('revision_record_invalid', `${id}:candidate_set_not_normalized`)
  if (recomputed.digest !== outputSetDigest) throw fail('revision_record_invalid', `${id}:candidate_output_set_digest`)
  return { artifactType, content, contentHash, outputSetDigest: recomputed.digest }
}

/** 状态与字段的配套约束：什么状态必须有候选 / 必须有报告 / 不许带错误码。 */
const assertRecordShape = (record) => {
  const { status, id } = record
  if (!REVISION_STATUSES.includes(status)) throw fail('revision_status_invalid', `${id}:status:${String(status)}`)
  const hasCandidate = record.candidate !== null
  if (status === 'requested' || status === 'producing') {
    if (hasCandidate) throw fail('revision_record_invalid', `${id}:${status}:candidate_not_allowed`)
    if (record.reportId !== null) throw fail('revision_record_invalid', `${id}:${status}:report_not_allowed`)
    if (record.errorCode !== null) throw fail('revision_record_invalid', `${id}:${status}:error_not_allowed`)
  }
  if (status === 'ready' || status === 'applied') {
    if (!hasCandidate) throw fail('revision_record_invalid', `${id}:${status}:candidate_required`)
    // ready 意味着「候选已通过绑定验证」，所以必须点名一份具体报告；不替调用方挑「最新通过的那份」。
    if (record.reportId === null) throw fail('revision_record_invalid', `${id}:${status}:report_required`)
    if (record.errorCode !== null) throw fail('revision_record_invalid', `${id}:${status}:error_not_allowed`)
  }
  if (status === 'failed') {
    if (record.errorCode === null) throw fail('revision_record_invalid', `${id}:failed:error_required`)
  }
  if (status === 'superseded' && record.errorCode !== null) {
    throw fail('revision_record_invalid', `${id}:superseded:error_not_allowed`)
  }
}

/**
 * @param {{ kernel: any, clock?: () => string }} options
 *   kernel 是内核句柄（需要 db / one / query）；本模块不打开、不关闭、不设 pragma。
 */
export function createRevisionStore({ kernel, clock = () => new Date().toISOString() } = {}) {
  const db = kernel?.db
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('kernel.db is required')
  }

  const ensure = () => {
    db.exec(REVISION_TABLE_SQL)
    for (const sql of REVISION_INDEX_SQL) db.exec(sql)
  }
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  // 表还没建时读路径返回空：旧副本 / 临时库不需要修订表也能打开。
  const hasTableNamed = name => Boolean(one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name))
  const hasTable = () => hasTableNamed(REVISION_TABLE)

  /**
   * 关联校验：run 与 step 必须存在，且 step 属于该 run。
   * 只在本库确实有这两张表时检查——独立测试注入的最小库不该被强制要求建内核表；
   * 有表却不核对，等于允许把修订请求挂到别的运行的步骤上。
   */
  const assertRunStep = ({ runId, stepId, id }) => {
    if (!hasTableNamed('workflow_runs') || !hasTableNamed('workflow_steps')) return
    if (!one('SELECT id FROM workflow_runs WHERE id=?', runId)) throw fail('revision_association_invalid', `${id}:run:${runId}`)
    const step = one('SELECT id,run_id FROM workflow_steps WHERE id=?', stepId)
    if (!step) throw fail('revision_association_invalid', `${id}:step:${stepId}`)
    if (step.run_id !== runId) throw fail('revision_association_invalid', `${id}:step_run:${stepId}`)
  }

  /**
   * 待办归属校验。
   *
   * taskRevision 是历史引用，**不要求**等于当前 task_revision——用户可能已经又保存过草稿；
   * 只要求它不来自未来（修订请求不可能基于一个还没出现的版本）。
   */
  const assertTask = ({ taskId, stepId, taskRevision, id }) => {
    if (!hasTableNamed('workflow_human_tasks')) return
    const task = one('SELECT id,step_id,task_revision FROM workflow_human_tasks WHERE id=?', taskId)
    if (!task) throw fail('revision_association_invalid', `${id}:task:${taskId}`)
    if (task.step_id !== stepId) throw fail('revision_association_invalid', `${id}:task_step:${taskId}`)
    if (taskRevision > Number(task.task_revision)) {
      throw fail('revision_association_invalid', `${id}:task_revision_future:${taskRevision}`)
    }
  }

  /**
   * 基准引用校验。这是本模块最容易写松的地方，所以逐项钉住：
   * - 输入绑定必须存在、正文能解析、且（内核有这一列时）integrity_hash 能复算对上；
   *   binding_json 里那唯一一个输入快照必须就是 baseSnapshotId。没有这条，「基准快照属于
   *   这个绑定版本」只是自报。
   * - 基准快照必须存在（历史快照不会消失，02 要求恢复和分支保留旧版本）。
   * - 有 baseDraftId 时：草稿必须存在、id 与自身 revision 一致、且它的 snapshot_id
   *   正好等于 `${taskId}:input:${bindingVersion}`——即纳这份草稿是在这个输入绑定版本下写的；
   *   baseContentHash 必须等于草稿正文的摘要。刻意不与 task.draft_id 比较：之后又存了草稿
   *   是完全合法的，基准只是历史。
   * - 没有 baseDraftId 时：基准就是输入快照本身，baseContentHash 必须等于快照行上的
   *   content_hash。
   */
  const assertBase = ({ id, taskId, bindingVersion, baseSnapshotId, baseDraftId, baseContentHash }) => {
    if (hasTableNamed('workflow_input_bindings')) {
      // integrity_hash 是内核加列（m1-kernel.mjs:314 的 ALTER）；只有真存在时才核对，
      // 否则旧副本上会把「这一列还没有」误报成绑定被改过。
      const hasIntegrity = all('PRAGMA table_info(workflow_input_bindings)').some(column => column.name === 'integrity_hash')
      const binding = hasIntegrity
        ? one('SELECT binding_json,integrity_hash,version FROM workflow_input_bindings WHERE owner_id=? AND version=?', taskId, bindingVersion)
        : one('SELECT binding_json,version FROM workflow_input_bindings WHERE owner_id=? AND version=?', taskId, bindingVersion)
      if (!binding) throw fail('revision_association_invalid', `${id}:base_binding:missing`)
      let inputs
      try { inputs = JSON.parse(binding.binding_json) } catch { throw fail('revision_association_invalid', `${id}:base_binding:unparsable`) }
      // 绑定正文本身也要能自证没被改：否则只改 binding_json 里的 snapshotId 就能把
      // 「基准快照属于这个绑定版本」这条结论做成真的。键序必须与内核冻结点逐字一致。
      if (hasIntegrity) {
        if (kernelHash({ ownerId: taskId, version: Number(binding.version), inputs }) !== binding.integrity_hash) {
          throw fail('revision_association_invalid', `${id}:base_binding:integrity`)
        }
      }
      if (!Array.isArray(inputs) || inputs.length !== 1 || inputs[0].snapshotId !== baseSnapshotId) throw fail('revision_association_invalid', `${id}:base_binding:snapshot`)
    }
    if (hasTableNamed('workflow_snapshots')) {
      const snapshot = one('SELECT id,content_hash FROM workflow_snapshots WHERE id=?', baseSnapshotId)
      if (!snapshot) throw fail('revision_association_invalid', `${id}:base_snapshot:${baseSnapshotId}`)
      if (baseDraftId === null && snapshot.content_hash !== baseContentHash) {
        throw fail('revision_association_invalid', `${id}:base_snapshot_hash`)
      }
    }
    if (baseDraftId !== null) {
      if (!baseDraftId.startsWith(`${taskId}:draft:`)) {
        throw fail('revision_association_invalid', `${id}:base_draft_identity:${baseDraftId}`)
      }
      if (!hasTableNamed('workflow_drafts')) return
      const draft = one('SELECT id,snapshot_id,revision,content FROM workflow_drafts WHERE id=?', baseDraftId)
      if (!draft) throw fail('revision_association_invalid', `${id}:base_draft:${baseDraftId}`)
      if (`${taskId}:draft:${Number(draft.revision)}` !== baseDraftId) {
        throw fail('revision_association_invalid', `${id}:base_draft_revision:${baseDraftId}`)
      }
      if (draft.snapshot_id !== `${taskId}:input:${bindingVersion}`) {
        throw fail('revision_association_invalid', `${id}:base_draft_binding:${bindingVersion}`)
      }
      if (hash(draft.content) !== baseContentHash) throw fail('revision_association_invalid', `${id}:base_draft_hash`)
    }
  }

  /**
   * 从库行重建记录并重新校验。
   *
   * 顺序有意为之：先重建冻结载荷与指纹（证明请求部分没被改过），再校验候选正文
   * （证明产出没被改过），最后校验状态配套与基准引用（证明关联事实成立）。
   * 任何一步不过都抛错，不做「能读多少读多少」的降级。
   */
  const rehydrate = (row) => {
    const id = row.id

    let opinionParsed
    try {
      opinionParsed = JSON.parse(row.opinion_json)
    } catch {
      throw fail('revision_record_invalid', `${id}:opinion_unparsable`)
    }
    if (!opinionParsed || typeof opinionParsed !== 'object' || Array.isArray(opinionParsed)) {
      throw fail('revision_record_invalid', `${id}:opinion_not_an_object`)
    }

    let retainedParsed
    try {
      retainedParsed = JSON.parse(row.retained_json)
    } catch {
      throw fail('revision_record_invalid', `${id}:retained_unparsable`)
    }
    if (!Array.isArray(retainedParsed)) throw fail('revision_record_invalid', `${id}:retained_not_an_array`)
    let retained
    try {
      retained = normalizeRetained(retainedParsed)
    } catch (error) {
      throw fail('revision_record_invalid', `${id}:retained:${error?.code ?? 'invalid'}`)
    }
    if (canonicalJson(retained) !== row.retained_json) throw fail('revision_record_invalid', `${id}:retained_not_canonical`)

    let opinion
    try {
      opinion = normalizeHumanOpinion({
        by: opinionParsed.by,
        at: opinionParsed.at ?? undefined,
        note: opinionParsed.note ?? undefined,
        disposition: opinionParsed.disposition ?? 'request_revision',
        retained,
      })
    } catch (error) {
      throw fail('revision_record_invalid', `${id}:opinion:${error?.code ?? 'invalid'}`)
    }
    if (opinion.disposition !== 'request_revision') throw fail('revision_record_invalid', `${id}:opinion_disposition`)
    if (canonicalJson({ by: opinion.by, at: opinion.at, note: opinion.note, disposition: opinion.disposition }) !== row.opinion_json) {
      throw fail('revision_record_invalid', `${id}:opinion_not_canonical`)
    }

    const record = {
      id,
      runId: row.run_id,
      stepId: row.step_id,
      taskId: row.task_id,
      taskRevision: Number(row.task_revision),
      bindingVersion: Number(row.binding_version),
      baseSnapshotId: row.base_snapshot_id,
      baseDraftId: row.base_draft_id ?? null,
      baseContentHash: row.base_content_hash,
      createdBy: row.created_by,
      requestKey: row.request_key,
      payloadFingerprint: row.payload_fingerprint,
      opinion,
      status: row.status,
      candidate: assertCandidateColumns({
        content: row.candidate_content ?? null,
        contentHash: row.candidate_content_hash ?? null,
        artifactType: row.candidate_artifact_type ?? null,
        outputSetDigest: row.candidate_output_set_digest ?? null,
        id,
      }),
      reportId: row.report_id ?? null,
      errorCode: row.error_code ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }

    if (!Number.isSafeInteger(record.taskRevision) || record.taskRevision < 1) throw fail('revision_record_invalid', `${id}:task_revision`)
    if (!Number.isSafeInteger(record.bindingVersion) || record.bindingVersion < 1) throw fail('revision_record_invalid', `${id}:binding_version`)
    if (typeof record.baseContentHash !== 'string' || !DIGEST_PATTERN.test(record.baseContentHash)) {
      throw fail('revision_record_invalid', `${id}:base_content_hash`)
    }
    if (record.errorCode !== null && (typeof record.errorCode !== 'string' || record.errorCode === '' || record.errorCode.length > MAX_ERROR)) {
      throw fail('revision_record_invalid', `${id}:error_code`)
    }
    if (payloadFingerprintOf(record) !== record.payloadFingerprint) {
      throw fail('revision_record_invalid', `${id}:payload_fingerprint`)
    }
    if (id !== revisionIdFor({ runId: record.runId, stepId: record.stepId, createdBy: record.createdBy, requestKey: record.requestKey })) {
      throw fail('revision_record_invalid', `${id}:identity`)
    }
    assertRecordShape(record)
    assertRunStep({ runId: record.runId, stepId: record.stepId, id })
    assertTask({ taskId: record.taskId, stepId: record.stepId, taskRevision: record.taskRevision, id })
    assertBase(record)
    if (record.reportId !== null) {
      const stored = createValidationStore({ db }).read(record.reportId)
      if (!stored || stored.runId !== record.runId || stored.stepId !== record.stepId || stored.attemptId !== null || stored.producedBy !== `revision-request:${record.id}` || !record.candidate) throw fail('revision_association_invalid', `${id}:report_scope`)
      // 「报告能不能被这份候选解释」这件事依赖定义事实。定义读不到、解析不了、步骤与冻结
      // 定义对不上、节点没声明必需检查清单——都归成同一个关联错误，不让内核/校验模块的
      // 内部码（尤其 validation_definition_invalid:required_checks_required）漏出本模块族。
      const definitionRow = one('SELECT definition_json FROM workflow_run_definitions WHERE run_id=?', record.runId)
      if (!definitionRow) throw fail('revision_association_invalid', `${id}:report_definition:missing`)
      let definition
      try { definition = JSON.parse(definitionRow.definition_json) } catch { throw fail('revision_association_invalid', `${id}:report_definition:unparsable`) }
      const step = one('SELECT node_id FROM workflow_steps WHERE id=?', record.stepId)
      const node = step ? (definition?.steps ?? []).find(item => item.nodeId === step.node_id) : null
      if (!node) throw fail('revision_association_invalid', `${id}:report_definition:node`)
      // 修订记录只可能由「声明了必需检查清单的人工节点」产出（内核在生成报告时就拒了空声明），
      // 这里再缺就意味着定义已换过，而不是「这个节点不需要检查」。
      if (!Array.isArray(node.requiredChecks)) throw fail('revision_association_invalid', `${id}:report_definition:required_checks`)
      const set = record.candidate.artifactType === 'file-set' ? JSON.parse(record.candidate.content) : null
      const subject = set ? { artifactType: 'file-set', outputSetDigest: set.digest, files: set.files } : { artifactType: record.candidate.artifactType, contentHash: record.candidate.contentHash }
      let verdict
      try {
        verdict = assessValidationReport(stored.report, { subject, definitionDigest: definitionDigestFor(definition), inputSnapshotIds: [record.baseSnapshotId], requiredChecks: node.requiredChecks })
      } catch (error) {
        if (error?.code === 'validation_definition_invalid') throw fail('revision_association_invalid', `${id}:report_definition:${error.detail ?? 'invalid'}`)
        throw error
      }
      if (!verdict.applicable) throw fail('revision_association_invalid', `${id}:report_binding`)
      if (['ready', 'applied'].includes(record.status) && verdict.status !== 'pass') throw fail('revision_association_invalid', `${id}:report_not_passed`)
    }
    return record
  }

  const load = id => one(`SELECT * FROM ${REVISION_TABLE} WHERE id=?`, id)

  /** 冻结请求部分的输入校验与规范化；create 用。 */
  const freezeInput = (input) => {
    const runId = nonEmpty(input.runId, 'run_id')
    const stepId = nonEmpty(input.stepId, 'step_id')
    const taskId = nonEmpty(input.taskId, 'task_id')
    const createdBy = assertNoColon(nonEmpty(input.createdBy, 'created_by'), 'created_by')
    const requestKey = assertNoColon(nonEmpty(input.requestKey, 'request_key'), 'request_key')
    const taskRevision = positiveInt(input.taskRevision, 'task_revision')
    const bindingVersion = positiveInt(input.bindingVersion, 'binding_version')
    const baseSnapshotId = nonEmpty(input.baseSnapshotId, 'base_snapshot_id')
    const baseDraftId = input.baseDraftId === undefined || input.baseDraftId === null || input.baseDraftId === ''
      ? null
      : nonEmpty(input.baseDraftId, 'base_draft_id')
    const baseContentHash = digestValue(input.baseContentHash, 'base_content_hash')
    const opinion = normalizeOpinion({ opinion: input.opinion, createdBy, retained: input.retained })
    return { runId, stepId, taskId, taskRevision, bindingVersion, baseSnapshotId, baseDraftId, baseContentHash, createdBy, requestKey, opinion }
  }

  const rowValuesOf = (record) => ({
    id: record.id,
    run_id: record.runId,
    step_id: record.stepId,
    task_id: record.taskId,
    task_revision: record.taskRevision,
    binding_version: record.bindingVersion,
    base_snapshot_id: record.baseSnapshotId,
    base_draft_id: record.baseDraftId,
    base_content_hash: record.baseContentHash,
    created_by: record.createdBy,
    request_key: record.requestKey,
    payload_fingerprint: record.payloadFingerprint,
    opinion_json: canonicalJson({
      by: record.opinion.by, at: record.opinion.at, note: record.opinion.note, disposition: record.opinion.disposition,
    }),
    retained_json: canonicalJson(record.opinion.retained),
    status: record.status,
    candidate_artifact_type: record.candidate?.artifactType ?? null,
    candidate_content: record.candidate?.content ?? null,
    candidate_content_hash: record.candidate?.contentHash ?? null,
    candidate_output_set_digest: record.candidate?.outputSetDigest ?? null,
    report_id: record.reportId,
    error_code: record.errorCode,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  })

  /**
   * 创建一条修订请求。
   *
   * 同一 (created_by, requestKey) 重复提交时：载荷指纹一致 → 幂等返回原记录（created=false）；
   * 指纹不同 → 冲突，绝不覆盖。这条是「不覆盖人工草稿」在请求侧的对应约束：
   * 同一个幂等 key 不能先后指向两个不同的修订依据。
   */
  const create = (input) => {
    const frozen = freezeInput(input)
    const status = input.status ?? 'requested'
    if (!REVISION_CREATABLE_STATUSES.includes(status)) throw fail('revision_status_invalid', `create:${String(status)}`)
    const candidate = input.candidate === undefined || input.candidate === null ? null : normalizeCandidate(input.candidate)
    const reportId = input.reportId === undefined || input.reportId === null ? null : nonEmpty(input.reportId, 'report_id')
    const errorCode = input.errorCode === undefined || input.errorCode === null ? null : nonEmpty(input.errorCode, 'error_code', MAX_ERROR)

    const stamp = clock()
    const record = {
      id: revisionIdFor(frozen),
      ...frozen,
      payloadFingerprint: null,
      status,
      candidate,
      reportId,
      errorCode,
      createdAt: stamp,
      updatedAt: stamp,
    }
    record.payloadFingerprint = payloadFingerprintOf(record)
    assertRecordShape(record)
    assertRunStep({ runId: record.runId, stepId: record.stepId, id: record.id })
    assertTask({ taskId: record.taskId, stepId: record.stepId, taskRevision: record.taskRevision, id: record.id })
    assertBase(record)
    ensure()

    const values = rowValuesOf(record)
    try {
      run(
        `INSERT INTO ${REVISION_TABLE} (${INSERT_COLUMNS.join(',')}) VALUES(${INSERT_COLUMNS.map(() => '?').join(',')})`,
        ...INSERT_COLUMNS.map(column => values[column]),
      )
    } catch (error) {
      if (!uniqueViolation(error)) throw error
      const existing = load(record.id)
      if (!existing) {
        // 主键没撞、撞的是 (created_by, request_key)：同一个 key 被用在另一个请求上。
        throw fail('revision_request_conflict', `${record.id}:request_key_reused`)
      }
      const stored = rehydrate(existing)
      if (stored.payloadFingerprint !== record.payloadFingerprint) {
        throw fail('revision_request_conflict', `${record.id}:same_key_different_payload`)
      }
      return { created: false, record: stored }
    }

    return { created: true, record: rehydrate(load(record.id)) }
  }

  /**
   * 状态推进。
   *
   * expectStatus 是 CAS 的期望值：调用方必须说出它以为的当前状态，否则两个并发的
   * 修订器会把彼此的结果踩掉。冻结部分不参与 UPDATE，所以推进不可能顺手改基准。
   * 候选列只能从空写成值（write-once）：候选被换掉不是「推进」，是另一条修订请求。
   */
  const advance = (input) => {
    const id = nonEmpty(input.id, 'id')
    const expectStatus = input.expectStatus
    if (!REVISION_STATUSES.includes(expectStatus)) throw fail('revision_status_invalid', `${id}:expect:${String(expectStatus)}`)
    const status = input.status
    if (!REVISION_STATUSES.includes(status)) throw fail('revision_status_invalid', `${id}:target:${String(status)}`)

    const row = load(id)
    if (!row) throw fail('revision_association_invalid', `${id}:missing`)
    // 先完整读一遍：不许把一条已经坏掉的记录往前推。
    const current = rehydrate(row)
    if (current.status !== expectStatus) throw fail('revision_status_invalid', `${id}:cas:${current.status}`)
    if (!(REVISION_TRANSITIONS[current.status] ?? []).includes(status)) {
      throw fail('revision_status_invalid', `${id}:${current.status}->${status}`)
    }

    let candidate = current.candidate
    if (input.candidate !== undefined && input.candidate !== null) {
      if (current.candidate !== null) {
        // 候选不可替换：要换内容就再发一次修订请求，历史各自留痕。
        const next = normalizeCandidate(input.candidate)
        if (next.contentHash !== current.candidate.contentHash) throw fail('revision_request_conflict', `${id}:candidate_immutable`)
        candidate = current.candidate
      } else {
        candidate = normalizeCandidate(input.candidate)
      }
    }

    const pickRef = (given, currentValue, field) => {
      if (given === undefined) return currentValue
      if (given === null) return currentValue === null ? null : currentValue
      const value = nonEmpty(given, field, field === 'error_code' ? MAX_ERROR : MAX_NAME)
      if (currentValue !== null && currentValue !== value) throw fail('revision_request_conflict', `${id}:${field}_immutable`)
      return value
    }
    const reportId = pickRef(input.reportId, current.reportId, 'report_id')
    const errorCode = pickRef(input.errorCode, current.errorCode, 'error_code')

    const next = { ...current, status, candidate, reportId, errorCode, updatedAt: clock() }
    assertRecordShape(next)

    const values = rowValuesOf(next)
    const result = run(
      `UPDATE ${REVISION_TABLE} SET ${UPDATE_COLUMNS.map(column => `${column}=?`).join(',')} WHERE id=? AND status=?`,
      ...UPDATE_COLUMNS.map(column => values[column]), id, current.status,
    )
    if (Number(result?.changes ?? 0) !== 1) throw fail('revision_status_invalid', `${id}:cas_lost`)
    return { created: false, record: rehydrate(load(id)) }
  }

  /**
   * 保存：没有 id 就创建，有 id 就推进。
   *
   * @returns {{created: boolean, record: object}}
   */
  const save = (input = {}) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('revision_store_input_invalid', 'input')
    return input.id === undefined || input.id === null || input.id === '' ? create(input) : advance(input)
  }

  /** 按 id 读回；表不存在时视为没有记录（不是坏数据）。 */
  const get = (id) => {
    if (typeof id !== 'string' || id === '') throw fail('revision_store_input_invalid', 'id')
    if (!hasTable()) return null
    const row = load(id)
    return row ? rehydrate(row) : null
  }

  /**
   * 列出修订请求，按写入顺序（旧→新）。
   * 不传过滤条件就返回全表——服务层必须至少按 run 过滤，这里不替调用方决定可见范围。
   */
  const list = ({ runId = null, stepId = null, taskId = null, status = null } = {}) => {
    if (!hasTable()) return []
    const clauses = []
    const args = []
    if (runId !== null) { clauses.push('run_id=?'); args.push(nonEmpty(runId, 'run_id')) }
    if (stepId !== null) { clauses.push('step_id=?'); args.push(nonEmpty(stepId, 'step_id')) }
    if (taskId !== null) { clauses.push('task_id=?'); args.push(nonEmpty(taskId, 'task_id')) }
    if (status !== null) {
      if (!REVISION_STATUSES.includes(status)) throw fail('revision_status_invalid', `list:${String(status)}`)
      clauses.push('status=?'); args.push(status)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    return all(`SELECT * FROM ${REVISION_TABLE}${where} ORDER BY rowid`, ...args).map(rehydrate)
  }

  return { ensure, hasTable, save, get, list }
}

/**
 * 备份 / 恢复校验入口（只读，不启动内核）。
 *
 * 每一行都走与正常读取完全相同的 rehydrate：冻结载荷指纹、候选摘要、集合摘要、
 * 派生列、状态配套、基准引用（含基准绑定完整性）、报告与候选/定义/输入的一致性。
 * 失败 / 旧 / 终态记录一视同仁，不因为「已经失败了」跳过。
 * 另外补一项只在整库视角才看得见的检查：(created_by, request_key) 必须唯一——
 * 旧库可能没有那条唯一索引。report_id 的存在性与归属已由 rehydrate 覆盖，不再重复。
 * 旧副本没有修订表：没有记录可校验，不算损坏。
 */
export function verifyRevisionStore({ kernel } = {}) {
  const db = kernel?.db
  if (!db || typeof db.prepare !== 'function') throw new TypeError('kernel.db is required')
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(REVISION_TABLE)
  if (!table) return { requests: 0, present: false }

  const store = createRevisionStore({ kernel })
  const rows = db.prepare(`SELECT * FROM ${REVISION_TABLE} ORDER BY rowid`).all()
  const seenKeys = new Set()
  const byStatus = {}

  for (const row of rows) {
    // 与正常读同一套校验；坏行在这里抛错。report_id 的存在性、所属 run/step、候选 subject
    // 与 producedBy 都已由 rehydrate 的 report 段交叉核对，这里不再重复查一遍。
    store.get(row.id)
    const key = `${row.created_by}\u0000${row.request_key}`
    if (seenKeys.has(key)) throw fail('revision_store_input_invalid', `${row.id}:request_key_duplicate`)
    seenKeys.add(key)
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
  }

  return { requests: rows.length, present: true, byStatus }
}
