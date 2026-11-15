// W1-10 长任务的提交意图存储：把「已受理的生成任务」从进程内存搬到临时 SQLite。
//
// 为什么需要它：契约（03 §4 / :121）要求「提交意图先落盘，外部 job ID 到达立即关联，
// 响应丢失保持 outcome_unknown」。此前 jobRef 与作业状态只存在假业务服务的 Map 里，
// 进程重启后 jobRef 全部失效，重启前已受理的任务在库上没有任何痕迹——既无法对账，
// 也无法证明「没有自动重派」。
//
// 边界：
// - 只存意图与作业状态，不存正文。正文只在执行器真正运行时以候选快照形式进入对象库；
//   因此重启后不可能「自动重跑同一意图」，这也是本模块刻意不保存 content 的原因。
// - 只建自己的表。表结构与校验入口在此导出，供内核建表、备份校验与页面表清单登记。
// - 不做重派：recover() 只把未完成项隔离成 outcome_unknown，并交给内核已有的
//   markUnknown 去暂停运行；是否继续由人通过既有对账/恢复入口决定。
import { createHash } from 'node:crypto'

/** 假业务服务的任务意图表。内核建表清单、备份校验、页面表清单都要登记这个名字。 */
export const JOB_TABLE = 'workflow_jobs'

export const JOB_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${JOB_TABLE} (
  job_ref TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  target TEXT,
  required INTEGER NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_json TEXT,
  adoption_id TEXT,
  outbox_id TEXT,
  outbox_ids TEXT,
  cancel_requests INTEGER NOT NULL DEFAULT 0,
  cancel_confirmed INTEGER NOT NULL DEFAULT 0,
  host_calls INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  download_failed INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  intent_json TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  recovered_at TEXT,
  recovered_reason TEXT,
  attempt_isolated INTEGER NOT NULL DEFAULT 0
)`

export const JOB_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${JOB_TABLE}_status ON ${JOB_TABLE}(status)`

/** 作业状态词表：与假业务服务里 jobNextAction 的取值一一对应。 */
export const JOB_STATUSES = Object.freeze(['pending', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'])

/** 未完成状态：只有这些在启动恢复时需要隔离，终态不重写。 */
export const OPEN_JOB_STATUSES = Object.freeze(['pending', 'running', 'cancelling'])

/**
 * 启动隔离原因。刻意区分「还没派发」与「派发中」：前者可以确定执行器没被调用过，
 * 后者只能确定结果不可知，两者对账时的证据强度不同，不能混成一个原因。
 */
export const RECOVERED_REASON = Object.freeze({
  pending: 'service_restarted_before_dispatch',
  running: 'service_restarted_during_dispatch',
  cancelling: 'service_restarted_during_cancel',
})

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const fail = (code, detail = code) => Object.assign(new Error(`${code}:${detail}`), { code, detail })

/**
 * jobRef 由 attempt 唯一确定：同一 Attempt 只绑定一个任务，重启后仍是同一个引用。
 * 这样「稳定 jobRef」不依赖任何进程内计数器，也不需要额外的映射表。
 */
export const jobRefFor = attemptId => `job:${attemptId}`

const uniqueViolation = error => /UNIQUE|PRIMARY KEY|constraint failed/i.test(error?.message ?? '')

/**
 * 一次采用可以声明多个发布目标，内核为此返回 outboxIds 数组。
 * 读的时候区分两种情况，不能一律「尽量解析」：
 * - `outbox_ids` 有值：它是权威来源，必须严格校验。坏 JSON、不是数组、元素不是非空字符串、
 *   有重复，都按坏数据处理抛错——如果这里退回单值或过滤掉非法元素，
 *   备份校验就会拿着被悄悄修好的数组去比对，坏数组反而能通过。
 * - `outbox_ids` 为 null 或整列不存在（旧库没补列）：才兼容旧单值 `outbox_id`。
 */
const parseOutboxIds = (row) => {
  const raw = row.outbox_ids
  if (raw !== null && raw !== undefined) {
    let parsed
    try { parsed = JSON.parse(raw) } catch { throw fail('job_outbox_ids_invalid', `${row.job_ref}:unparsable`) }
    if (!Array.isArray(parsed)) throw fail('job_outbox_ids_invalid', `${row.job_ref}:not_array`)
    const ids = []
    for (const id of parsed) {
      if (typeof id !== 'string' || id === '') throw fail('job_outbox_ids_invalid', `${row.job_ref}:bad_element`)
      if (ids.includes(id)) throw fail('job_outbox_ids_invalid', `${row.job_ref}:duplicate`)
      ids.push(id)
    }
    return ids
  }
  return typeof row.outbox_id === 'string' && row.outbox_id !== '' ? [row.outbox_id] : []
}

const outboxIdsOf = job => {
  const source = Array.isArray(job.outboxIds)
    ? job.outboxIds
    : typeof job.outboxId === 'string' && job.outboxId !== '' ? [job.outboxId] : []
  // 写路径也不能「过滤掉非法元素」：那会让坏关联在落库时被悄悄抹平，
  // 事后既查不出是谁丢的，也无法与备份校验的严格口径对齐。
  const ids = []
  for (const id of source) {
    if (typeof id !== 'string' || id === '') throw fail('job_outbox_ids_invalid', `write:${job.jobRef}`)
    if (ids.includes(id)) throw fail('job_outbox_ids_invalid', `write:${job.jobRef}:duplicate`)
    ids.push(id)
  }
  return ids
}

const toJob = row => {
  const outboxIds = parseOutboxIds(row)
  return {
    jobRef: row.job_ref,
    attemptId: row.attempt_id,
    runId: row.run_id,
    status: row.status,
    target: row.target,
    required: row.required === 1,
    artifactType: row.artifact_type,
    artifact: row.artifact_json ? JSON.parse(row.artifact_json) : null,
    adoptionId: row.adoption_id,
    // 单值列保留给「只关心主目标」的读方；完整关联以 outboxIds 为准。
    outboxId: outboxIds[0] ?? row.outbox_id ?? null,
    outboxIds,
    cancelRequests: row.cancel_requests,
    cancelConfirmed: row.cancel_confirmed === 1,
    hostCalls: row.host_calls,
    downloads: row.downloads,
    downloadFailed: row.download_failed === 1,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    recoveredAt: row.recovered_at,
    recoveredReason: row.recovered_reason,
    attemptIsolated: row.attempt_isolated === 1,
    // 正文不进库：重启后旧的意图不能被自动重跑，见文件头边界说明。
    content: null,
  }
}

/** 提交意图的规范化形式：只留判定所需的事实，不含凭证明文。 */
export const submissionIntent = ({ attemptId, runId, token, target, required, artifactType, contentHash, bytes, idempotencyKey }) => ({
  attemptId,
  runId,
  // 凭证只记不可逆摘要：意图要能在重启后自证来源，但不能把 Attempt 令牌抄一份进库。
  tokenHash: hash(token),
  target: target ?? null,
  required: required === true,
  artifactType,
  contentHash,
  bytes,
  idempotencyKey: idempotencyKey ?? null,
})

/**
 * @param {{ kernel: { db: any }, clock?: () => string }} options
 */
export function createJobStore({ kernel, clock = () => new Date().toISOString() } = {}) {
  if (!kernel?.db) throw new TypeError('kernel.db is required')
  // 建表由内核 schema 初始化调用 ensure()（见交付说明的接入点清单）。
  // 服务自己不在构造时建表：构造发生在只读探活与零写入断言之间，
  // 「打开服务」不应改写库。
  const ensure = () => {
    kernel.db.exec(JOB_TABLE_SQL)
    kernel.db.exec(JOB_INDEX_SQL)
    // 旧库补列：表可能是上一版建的（只有单 outbox_id、没有隔离收敛标记），
    // 补列而不重建，避免为了多目标关联把已有的作业行丢掉。
    const columns = kernel.db.prepare(`PRAGMA table_info(${JOB_TABLE})`).all().map(column => column.name)
    if (!columns.includes('outbox_ids')) kernel.db.exec(`ALTER TABLE ${JOB_TABLE} ADD COLUMN outbox_ids TEXT`)
    if (!columns.includes('attempt_isolated')) kernel.db.exec(`ALTER TABLE ${JOB_TABLE} ADD COLUMN attempt_isolated INTEGER NOT NULL DEFAULT 0`)
  }
  const one = (sql, ...args) => kernel.db.prepare(sql).get(...args)
  const all = (sql, ...args) => kernel.db.prepare(sql).all(...args)
  const run = (sql, ...args) => kernel.db.prepare(sql).run(...args)
  // 表还没建时读路径返回空：既有临时库/旧副本不需要作业表也能打开。
  const hasTable = () => Boolean(one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, JOB_TABLE))

  const load = jobRef => {
    if (!hasTable()) return null
    const row = one(`SELECT * FROM ${JOB_TABLE} WHERE job_ref=?`, jobRef)
    return row ? toJob(row) : null
  }
  const loadByAttempt = attemptId => {
    if (!hasTable()) return null
    const row = one(`SELECT * FROM ${JOB_TABLE} WHERE attempt_id=?`, attemptId)
    return row ? toJob(row) : null
  }
  const openJobs = () => hasTable() ? all(`SELECT * FROM ${JOB_TABLE} WHERE status IN ('pending','running','cancelling') ORDER BY rowid`).map(toJob) : []
  const list = () => hasTable() ? all(`SELECT * FROM ${JOB_TABLE} ORDER BY rowid`).map(toJob) : []
  const byRun = runId => hasTable() ? all(`SELECT * FROM ${JOB_TABLE} WHERE run_id=? ORDER BY rowid`, runId).map(toJob) : []

  /**
   * 落盘提交意图。UNIQUE(attempt_id) 是「同一 Attempt 只绑定一个 jobRef」的库内保证：
   * 重复提交（含重启后的重复提交）只能拿回原任务，不会生成第二个。
   */
  const insert = job => {
    // 唯一会隐式建表的位置：第一次写意图时才落 schema。
    ensure()
    const intentJson = JSON.stringify(job.intent)
    const at = clock()
    const outboxIds = outboxIdsOf(job)
    try {
      run(`INSERT INTO ${JOB_TABLE}
        (job_ref,attempt_id,run_id,status,target,required,artifact_type,artifact_json,adoption_id,outbox_id,outbox_ids,
         cancel_requests,cancel_confirmed,host_calls,downloads,download_failed,detail,intent_json,intent_hash,
         created_at,updated_at,recovered_at,recovered_reason,attempt_isolated)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      job.jobRef, job.attemptId, job.runId, job.status ?? 'pending', job.target ?? null, job.required === false ? 0 : 1,
      job.artifactType ?? 'text', job.artifact ? JSON.stringify({ snapshotId: job.artifact.snapshotId, contentHash: job.artifact.contentHash, manifestHash: job.artifact.manifestHash }) : null,
      job.adoptionId ?? null, outboxIds[0] ?? null, outboxIds.length > 0 ? JSON.stringify(outboxIds) : null,
      job.cancelRequests ?? 0, job.cancelConfirmed === true ? 1 : 0, job.hostCalls ?? 0, job.downloads ?? 0, job.downloadFailed === true ? 1 : 0,
      job.detail ?? null, intentJson, hash(intentJson), job.createdAt ?? at, at, null, null, job.attemptIsolated === true ? 1 : 0)
    } catch (error) {
      if (!uniqueViolation(error)) throw error
      const existing = loadByAttempt(job.attemptId)
      if (!existing) throw fail('job_intent_conflict', 'attempt_binding_unavailable')
      return { created: false, job: existing }
    }
    return { created: true, job: toJob(one(`SELECT * FROM ${JOB_TABLE} WHERE job_ref=?`, job.jobRef)) }
  }

  /** 写回可变状态。终态作业再次调用只会更新 detail，不会把状态改回去（由调用方保证）。 */
  const save = job => {
    ensure()
    const outboxIds = outboxIdsOf(job)
    run(`UPDATE ${JOB_TABLE} SET status=?,artifact_json=?,adoption_id=?,outbox_id=?,outbox_ids=?,cancel_requests=?,cancel_confirmed=?,
      host_calls=?,downloads=?,download_failed=?,detail=?,updated_at=?,attempt_isolated=? WHERE job_ref=?`,
    job.status, job.artifact ? JSON.stringify({ snapshotId: job.artifact.snapshotId, contentHash: job.artifact.contentHash, manifestHash: job.artifact.manifestHash }) : null,
    job.adoptionId ?? null, outboxIds[0] ?? null, outboxIds.length > 0 ? JSON.stringify(outboxIds) : null,
    job.cancelRequests ?? 0, job.cancelConfirmed === true ? 1 : 0,
    job.hostCalls ?? 0, job.downloads ?? 0, job.downloadFailed === true ? 1 : 0, job.detail ?? null, clock(),
    job.attemptIsolated === true ? 1 : 0, job.jobRef)
    return job
  }

  /**
   * 隔离一个 Attempt。三种结果必须分开，不能混成一个布尔：
   * - 它已经不在 running：别处已收尾（或本来就没跑起来），算收敛，不必再动；
   * - 本次标记成功：收敛；
   * - 标记失败且它仍在 running：没收敛，保留 0 标记等下次启动再试。
   */
  const isolateAttempt = (attemptId, reason, markUnknown) => {
    const attempt = one('SELECT status FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt) return { attempt: false, error: 'attempt_not_found', converged: false }
    if (attempt.status !== 'running') return { attempt: true, error: null, converged: true, already: true }
    if (typeof markUnknown !== 'function') return { attempt: false, error: 'mark_unknown_unavailable', converged: false }
    try {
      markUnknown(attemptId, reason)
      return { attempt: true, error: null, converged: true }
    } catch (error) {
      // 并发下「别人先隔离了」会以 cas 失败的形式冒出来；此时库里其实已经收敛，
      // 记成失败会让每次启动都白跑一遍，也会让人误以为还有活没干完。
      const after = one('SELECT status FROM workflow_attempts WHERE id=?', attemptId)
      const settled = Boolean(after) && after.status !== 'running'
      return { attempt: settled, error: error?.code ?? 'mark_unknown_failed', converged: settled }
    }
  }

  /**
   * 启动恢复：把未完成项隔离成 outcome_unknown，不重派、不采用、不改终态。
   * 两遍走：
   * - 第一遍补收敛「作业行已隔离、Attempt 当时没隔离成功」的旧条目。它们已经不在
   *   未完成状态里，只靠 openJobs() 永远扫不到，否则运行会一直停在 running。
   * - 第二遍处理本次启动新发现的未完成项。
   * 单条失败不中断其余条目——恢复期最怕的是一条脏数据挡住全部运行。
   */
  const recover = ({ markUnknown = null } = {}) => {
    const recovered = []
    const pendingAttempts = hasTable()
      ? all(`SELECT * FROM ${JOB_TABLE} WHERE status='outcome_unknown' AND recovered_reason IS NOT NULL AND attempt_isolated=0 ORDER BY rowid`).map(toJob)
      : []
    for (const job of pendingAttempts) {
      const reason = job.recoveredReason ?? 'service_restarted'
      const isolated = isolateAttempt(job.attemptId, reason, markUnknown)
      if (isolated.converged) run(`UPDATE ${JOB_TABLE} SET attempt_isolated=1,updated_at=? WHERE job_ref=?`, clock(), job.jobRef)
      recovered.push({ jobRef: job.jobRef, attemptId: job.attemptId, previousStatus: job.status, reason, isolated, phase: 'retry' })
    }
    for (const job of openJobs()) {
      const reason = RECOVERED_REASON[job.status] ?? 'service_restarted'
      const at = clock()
      // 先落作业行、再隔离 Attempt：顺序反过来时，标记成功又崩溃会留下「还像在跑」的作业行。
      run(`UPDATE ${JOB_TABLE} SET status='outcome_unknown',detail=?,recovered_at=?,recovered_reason=?,updated_at=?,attempt_isolated=0
        WHERE job_ref=? AND status=?`, reason, at, reason, at, job.jobRef, job.status)
      const isolated = isolateAttempt(job.attemptId, reason, markUnknown)
      if (isolated.converged) run(`UPDATE ${JOB_TABLE} SET attempt_isolated=1,updated_at=? WHERE job_ref=?`, clock(), job.jobRef)
      recovered.push({ jobRef: job.jobRef, attemptId: job.attemptId, previousStatus: job.status, reason, isolated, phase: 'fresh' })
    }
    return recovered
  }

  return { ensure, hasTable, load, loadByAttempt, openJobs, list, byRun, insert, save, recover }
}

/**
 * 备份/恢复校验入口（只读句柄，不启动内核）。
 * 任一条意图摘要与内容不符、关联的 outbox/采用/快照不属于本任务，都说明副本不可信。
 * 注意这里的严格口径：坏数组不做任何修补，直接判坏——修补过的数据会让校验形同虚设。
 */
export function verifyJobStore(db) {
  // 旧副本里没有作业表：没有作业记录可校验，不算损坏。
  if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(JOB_TABLE)) return { jobs: 0, open: 0, present: false }
  const rows = db.prepare(`SELECT * FROM ${JOB_TABLE}`).all()
  for (const row of rows) {
    if (!JOB_STATUSES.includes(row.status)) throw fail('backup_job_status_invalid', row.job_ref)
    if (row.job_ref !== jobRefFor(row.attempt_id)) throw fail('backup_job_identity_invalid', row.job_ref)
    if (hash(row.intent_json) !== row.intent_hash) throw fail('backup_job_intent_invalid', row.job_ref)
    // 摘要只能证明「意图没被改过」，不能证明「记下来的就是这件事」：
    // 还要把意图内容与任务行逐项对上，否则两条一致的错数据也能通过校验。
    let intent
    try { intent = JSON.parse(row.intent_json) } catch { throw fail('backup_job_intent_invalid', `${row.job_ref}:unparsable`) }
    const mismatch = intent?.attemptId !== row.attempt_id
      || intent?.runId !== row.run_id
      || (intent?.target ?? null) !== (row.target ?? null)
      || (intent?.required === true) !== (row.required === 1)
      || (intent?.artifactType ?? 'text') !== row.artifact_type
    if (mismatch) throw fail('backup_job_intent_mismatch', row.job_ref)
    if (row.artifact_json !== null) {
      const artifact = JSON.parse(row.artifact_json)
      const snapshot = db.prepare('SELECT id,content_hash FROM workflow_snapshots WHERE id=?').get(artifact.snapshotId)
      if (!snapshot || snapshot.content_hash !== artifact.contentHash) throw fail('backup_job_artifact_invalid', row.job_ref)
      // 意图说提交了 A，落地的产物却是 B：两份记录互相矛盾，副本不可信。
      if (intent?.contentHash !== artifact.contentHash) throw fail('backup_job_intent_mismatch', `${row.job_ref}:content_hash`)
    }
    // 多目标关联：数组是权威（坏数组在 parseOutboxIds 里已经抛错，不会走到这里被悄悄修好），
    // 单值列必须是它的首项，且每个 outbox 都要真的存在、属于本任务的采用。
    const outboxIds = parseOutboxIds(row)
    if (row.outbox_id !== null && outboxIds[0] !== row.outbox_id) throw fail('backup_job_outbox_invalid', `${row.job_ref}:head`)
    if (outboxIds.length > 0 && !row.adoption_id) throw fail('backup_job_outbox_invalid', `${row.job_ref}:adoption_missing`)
    for (const id of outboxIds) {
      const outbox = db.prepare('SELECT id,adoption_id FROM workflow_outbox WHERE id=?').get(id)
      if (!outbox) throw fail('backup_job_outbox_invalid', `${row.job_ref}:${id}:missing`)
      // 存在还不够：挂到别人的采用上就说明这条关联被改过或抄错了行。
      if (outbox.adoption_id !== row.adoption_id) throw fail('backup_job_outbox_invalid', `${row.job_ref}:${id}:adoption`)
    }
    // job 绑定本次交付的采用；人工恢复新增历史采用，不改变旧 job 的交付归属。
    // 因此 actor_type 不能豁免本 Attempt 的快照来源校验。
    if (row.adoption_id) {
      const adoption = db.prepare('SELECT id,step_id,snapshot_id,actor_type FROM workflow_adoptions WHERE id=?').get(row.adoption_id)
      if (!adoption) throw fail('backup_job_adoption_invalid', `${row.job_ref}:missing`)
      const attempt = db.prepare('SELECT step_id FROM workflow_attempts WHERE id=?').get(row.attempt_id)
      if (!attempt || adoption.step_id !== attempt.step_id) throw fail('backup_job_adoption_invalid', `${row.job_ref}:step`)
      const snapshot = db.prepare('SELECT id,source_attempt_id FROM workflow_snapshots WHERE id=?').get(adoption.snapshot_id)
      if (!snapshot) throw fail('backup_job_adoption_invalid', `${row.job_ref}:snapshot`)
      if (!row.artifact_json || JSON.parse(row.artifact_json).snapshotId !== adoption.snapshot_id) throw fail('backup_job_adoption_invalid', `${row.job_ref}:artifact`)
      if (snapshot.source_attempt_id !== row.attempt_id) {
        throw fail('backup_job_adoption_invalid', `${row.job_ref}:snapshot_provenance`)
      }
    }
  }
  const broken = `SELECT j.job_ref FROM ${JOB_TABLE} j
    LEFT JOIN workflow_attempts a ON a.id=j.attempt_id
    LEFT JOIN workflow_steps s ON s.id=a.step_id
    LEFT JOIN workflow_runs r ON r.id=j.run_id
    WHERE a.id IS NULL OR r.id IS NULL OR s.run_id<>j.run_id`
  if (db.prepare(broken).get()) throw fail('backup_job_reference_invalid')
  return { jobs: rows.length, open: rows.filter(row => OPEN_JOB_STATUSES.includes(row.status)).length, present: true }
}
