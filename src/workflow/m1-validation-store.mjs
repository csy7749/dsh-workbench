// W1-11 验证报告的持久化层：把机器报告落进调用方注入的 SQLite，只追加、不更新。
//
// 为什么需要它：报告目前只在内存里算一遍就丢了。契约要求候选即使在验证失败时也
// 保留报告（01:64「验证器失败仍保存候选和报告，禁止自动采用」），审核页要展示
// 每项结论、原因与证据（04:22），确认时还要能判断「这份报告是否仍适用于现在的内容」
// （04:37）。这些都以「报告有一份可复读、可核对的存证」为前提。
//
// 边界：
// - 只建自己的表 workflow_validations；不碰内核、服务、页面，不做 schema 迁移。
// - 表结构由调用方（内核建表清单、备份校验）通过 ensure() 触发；构造时不建表，
//   与 job store 一致——「打开」不应改写库。
// - 不可变、可追加：本模块不导出任何 update，同一绑定下允许存在多份历史报告
//   （内容从「未评估」重新检查变成「通过」时，旧报告必须留痕，不能被抹掉）。
//   行身份是正文的内容地址：同样的报告重复保存幂等命中，内容有任何差别
//   （包括生成时间）都是另一条历史记录。同一 id 不同内容一律拒绝，绝不覆盖。
// - 确认必须按明确的报告 id 读取，不许「绑定下随便取一份」——同一绑定存在多份
//   结论时，取哪一份都能自证等于没有结论；选哪份是调用方的显式决定。
// - 读取一律重新校验：重新规范化报告结构、重算摘要，并逐列核对派生字段。
//   校验口径全部来自 m1-validation.mjs，这里不另写一套规则。
import { createHash } from 'node:crypto'
import {
  VALIDATION_SCHEMA_VERSION,
  canonicalJson,
  normalizeInputSnapshotIds,
  normalizeValidationReport,
  reportDigest,
} from './m1-validation.mjs'

/** 验证报告表。内核建表清单、备份校验、页面表清单都要登记这个名字。 */
export const VALIDATION_TABLE = 'workflow_validations'

export const VALIDATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${VALIDATION_TABLE} (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt_id TEXT,
  artifact_type TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  output_set_digest TEXT,
  content_hash TEXT,
  definition_digest TEXT NOT NULL,
  input_ids_json TEXT NOT NULL,
  input_ids_hash TEXT NOT NULL,
  report_schema INTEGER NOT NULL,
  report_status TEXT NOT NULL,
  required_checks_json TEXT NOT NULL,
  report_digest TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  report_json TEXT NOT NULL,
  produced_by TEXT,
  produced_at TEXT,
  created_at TEXT NOT NULL
)`

export const VALIDATION_INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS ${VALIDATION_TABLE}_run ON ${VALIDATION_TABLE}(run_id)`,
  `CREATE INDEX IF NOT EXISTS ${VALIDATION_TABLE}_step ON ${VALIDATION_TABLE}(step_id)`,
  // 查询索引，不是唯一约束：同一绑定允许多份历史报告。
  `CREATE INDEX IF NOT EXISTS ${VALIDATION_TABLE}_binding ON ${VALIDATION_TABLE}(run_id, step_id, subject_digest, definition_digest, input_ids_hash)`,
]

/**
 * 本模块自己的错误码（内核内部码，不是服务错误码）。
 * 服务侧仍映射到已冻结的 human_confirm_required，SERVICE_ERROR_CODES 保持 10 项。
 * 注意：结构性问题（重复检查名、非法结论、非法摘要）直接抛 m1-validation.mjs 的
 * validation_* 码——那些码比这里更精确，重写一遍只会让两处口径漂移。
 */
export const VALIDATION_STORE_ERROR_CODES = Object.freeze([
  'validation_store_input_invalid',
  'validation_association_invalid',
  'validation_report_invalid',
  'validation_report_conflict',
])

const fail = (code, detail = code) => Object.assign(new Error(`${code}:${detail}`), { code, detail })
const hash = value => createHash('sha256').update(value).digest('hex')

/**
 * 落库列顺序。INSERT 的列清单、占位符个数与取值数组都由这一处生成：
 * 21 列手写占位符只要少一个就会在运行期报「参数个数不符」，而这里列数变了会自动跟着变。
 */
const INSERT_COLUMNS = Object.freeze([
  'id', 'run_id', 'step_id', 'attempt_id', 'artifact_type', 'subject_kind', 'subject_digest',
  'output_set_digest', 'content_hash', 'definition_digest', 'input_ids_json', 'input_ids_hash',
  'report_schema', 'report_status', 'required_checks_json', 'report_digest', 'body_digest',
  'report_json', 'produced_by', 'produced_at', 'created_at',
])

/**
 * 报告行 id 由「关联 + 整个正文的内容地址」唯一确定。
 *
 * 为什么用正文地址而不是报告摘要：reportDigest 刻意不含 producedAt（同一份检查结论
 * 在不同时间重放应该等价），但它被写进了落库正文。若 id 只看 reportDigest，
 * 换个时间戳重放就会撞上同一 id 却正文不同，被误判成冲突。
 * 用正文地址后：同样字节 → 同一个 id（幂等），任何差别 → 另一条历史（追加）。
 */
export const validationIdFor = ({ runId, stepId, bodyDigest }) =>
  `validation:${runId}:${stepId}:${bodyDigest}`

const nonEmpty = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '') throw fail('validation_store_input_invalid', field)
  return value
}

// 只认唯一性冲突。不要用宽泛的 /constraint failed/：NOT NULL、CHECK 失败也会命中，
// 那类错误被当成「重复保存」去查旧行，最终会报成一条误导人的冲突。
const uniqueViolation = error => /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(error?.message ?? '')

/** 报告里与关联有关的事实，落库前一次算好，避免读的时候两套推导。 */
const bindingOf = (report) => {
  const subject = report.subject
  const inputIds = normalizeInputSnapshotIds(report.inputSnapshotIds)
  const inputIdsJson = canonicalJson(inputIds)
  return {
    artifactType: subject.artifactType,
    subjectKind: subject.kind,
    subjectDigest: subject.subjectDigest,
    outputSetDigest: subject.outputSetDigest ?? null,
    contentHash: subject.contentHash ?? null,
    definitionDigest: report.definitionDigest,
    inputIdsJson,
    inputIdsHash: hash(inputIdsJson),
    reportStatus: report.status,
    requiredChecksJson: canonicalJson(report.requiredChecks ?? []),
    reportDigest: reportDigest(report),
  }
}

/**
 * 把传入的报告重新规范化为库内形状。
 * 调用方可能给的是未规范化的原始报告（内核组装时更自然），也可能是已规范化的；
 * 两者都要落到同一形状，否则「重复保存内容一致」这条会按对象身份而不是按内容比较。
 */
const normalizedForStore = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('validation_store_input_invalid', 'report')
  if (input.schemaVersion !== undefined && input.schemaVersion !== VALIDATION_SCHEMA_VERSION) {
    throw fail('validation_report_invalid', `schema:${String(input.schemaVersion)}`)
  }
  const report = normalizeValidationReport({
    subject: input.subject,
    definitionDigest: input.definitionDigest,
    inputSnapshotIds: input.inputSnapshotIds,
    checks: input.checks,
    requiredChecks: input.requiredChecks,
    // 规范化后的报告把「没填」写成 null；再喂回去时 null 要还原成「未提供」，
    // 否则重复保存同一份报告会被判成非法字段（见 m1-validation.mjs:337-338 的契约口径）。
    producedBy: input.producedBy ?? undefined,
    producedAt: input.producedAt ?? undefined,
  })
  // 调用方自带摘要时必须与重算一致：摘要写错比没有摘要更危险，不能悄悄纠正。
  if (input.reportDigest !== undefined && input.reportDigest !== report.reportDigest) {
    throw fail('validation_report_invalid', 'report_digest_mismatch')
  }
  return report
}

/**
 * @param {{ db: any, clock?: () => string }} options
 *   db 是调用方注入的 better-sqlite3 连接（内核持有）。本模块不打开、不关闭、不设 pragma。
 */
export function createValidationStore({ db, clock = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('db is required')
  }

  // 建表由内核 schema 初始化调用 ensure()；构造时不建表。
  const ensure = () => {
    db.exec(VALIDATION_TABLE_SQL)
    for (const sql of VALIDATION_INDEX_SQL) db.exec(sql)
  }
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  // 表还没建时读路径返回空：旧副本/临时库不需要报告表也能打开。
  const hasTable = () => Boolean(one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, VALIDATION_TABLE))

  const hasTableNamed = name => Boolean(one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name))

  /**
   * 关联校验：run 与 step 必须存在，且 step 属于该 run。
   * 只在本库确实有这两张表时检查——独立测试注入的最小库不该被强制要求建内核表，
   * 但有表却不核对，等于允许把报告挂到别的运行的步骤上，备份校验会跟着失真。
   */
  const assertRunStep = ({ runId, stepId }) => {
    if (!hasTableNamed('workflow_runs') || !hasTableNamed('workflow_steps')) return
    if (!one('SELECT id FROM workflow_runs WHERE id=?', runId)) throw fail('validation_association_invalid', `run:${runId}`)
    const step = one('SELECT id,run_id FROM workflow_steps WHERE id=?', stepId)
    if (!step) throw fail('validation_association_invalid', `step:${stepId}`)
    if (step.run_id !== runId) throw fail('validation_association_invalid', `step_run:${stepId}`)
  }

  /**
   * attempt 归属校验。报告可能是在某个 Attempt 下产出的，写上 attempt_id 就必须真的属于该 step；
   * 挂错 Attempt 的报告在复核时会指向另一次执行的内容，比没有关联更能骗人。
   */
  const assertAttempt = ({ attemptId, stepId, rowId = null }) => {
    if (attemptId === null || attemptId === undefined || attemptId === '') return
    if (!hasTableNamed('workflow_attempts')) return
    const attempt = one('SELECT id,step_id FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt) throw fail('validation_association_invalid', `${rowId ?? 'attempt'}:attempt_missing`)
    if (attempt.step_id !== stepId) throw fail('validation_association_invalid', `${rowId ?? 'attempt'}:attempt_step`)
  }

  /**
   * 从库里读回并重新校验一份报告。
   *
   * 重新走 normalizeValidationReport 而不是只比摘要：摘要只能证明「这段字节没被改过」，
   * 证明不了「这段字节还符合当前口径」。口径变更后旧报告应当被读成不合规，而不是被
   * 摘要验证放行。规范化顺带挡住重复检查名、非法结论、非法摘要这些问题。
   */
  const rehydrate = (row) => {
    let parsed
    try {
      parsed = JSON.parse(row.report_json)
    } catch {
      throw fail('validation_report_invalid', `${row.id}:unparsable`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('validation_report_invalid', `${row.id}:not_an_object`)
    if (Number(row.report_schema) !== VALIDATION_SCHEMA_VERSION) throw fail('validation_report_invalid', `${row.id}:schema`)

    const report = normalizeValidationReport({
      subject: parsed.subject,
      definitionDigest: parsed.definitionDigest,
      inputSnapshotIds: parsed.inputSnapshotIds,
      checks: parsed.checks,
      requiredChecks: parsed.requiredChecks,
      producedBy: parsed.producedBy ?? undefined,
      producedAt: parsed.producedAt ?? undefined,
    })

    // 正文必须是它自己的规范化形式，且摘要列与正文一致。
    const bodyJson = canonicalJson(report)
    if (row.report_json !== bodyJson) throw fail('validation_report_invalid', `${row.id}:not_canonical`)
    if (hash(bodyJson) !== row.body_digest) throw fail('validation_report_invalid', `${row.id}:body_digest`)
    if (report.reportDigest !== row.report_digest) throw fail('validation_report_invalid', `${row.id}:report_digest`)
    if (parsed.reportDigest !== undefined && parsed.reportDigest !== report.reportDigest) throw fail('validation_report_invalid', `${row.id}:carried_digest`)

    // 派生字段也要对得上：只改 status、摘要或分类列而正文不动，同样是坏数据。
    if (report.status !== row.report_status || parsed.status !== row.report_status) throw fail('validation_report_invalid', `${row.id}:status`)
    if (report.subject.artifactType !== row.artifact_type) throw fail('validation_report_invalid', `${row.id}:artifact_type`)
    if (report.subject.kind !== row.subject_kind) throw fail('validation_report_invalid', `${row.id}:subject_kind`)
    if (report.subject.subjectDigest !== row.subject_digest) throw fail('validation_report_invalid', `${row.id}:subject`)
    if ((report.subject.outputSetDigest ?? null) !== (row.output_set_digest ?? null)) throw fail('validation_report_invalid', `${row.id}:output_set`)
    if ((report.subject.contentHash ?? null) !== (row.content_hash ?? null)) throw fail('validation_report_invalid', `${row.id}:content_hash`)
    if (report.definitionDigest !== row.definition_digest) throw fail('validation_report_invalid', `${row.id}:definition`)
    if (canonicalJson(report.inputSnapshotIds) !== row.input_ids_json) throw fail('validation_report_invalid', `${row.id}:inputs`)
    // 输入摘要列单独核对：只改 input_ids_hash 能让「按旧输入找报告」命中错的东西。
    if (hash(row.input_ids_json) !== row.input_ids_hash) throw fail('validation_report_invalid', `${row.id}:input_ids_hash`)
    if (canonicalJson(report.requiredChecks ?? []) !== row.required_checks_json) throw fail('validation_report_invalid', `${row.id}:required_checks`)
    // 生成者与生成时间只在正文里，不与任何列重复存储，但必须与列上的冗余一致（若有）。
    if ((report.producedBy ?? null) !== (row.produced_by ?? null)) throw fail('validation_report_invalid', `${row.id}:produced_by`)
    if ((report.producedAt ?? null) !== (row.produced_at ?? null)) throw fail('validation_report_invalid', `${row.id}:produced_at`)
    if (row.id !== validationIdFor({ runId: row.run_id, stepId: row.step_id, bodyDigest: hash(bodyJson) })) {
      throw fail('validation_report_invalid', `${row.id}:identity`)
    }

    assertAttempt({ attemptId: row.attempt_id, stepId: row.step_id, rowId: row.id })

    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      attemptId: row.attempt_id ?? null,
      artifactType: row.artifact_type,
      subjectKind: row.subject_kind,
      subjectDigest: row.subject_digest,
      definitionDigest: row.definition_digest,
      status: row.report_status,
      reportDigest: row.report_digest,
      bodyDigest: row.body_digest,
      producedBy: row.produced_by ?? null,
      producedAt: row.produced_at ?? null,
      createdAt: row.created_at,
      report,
    }
  }

  /**
   * 保存一份不可变机器报告。
   *
   * @param {{ runId: string, stepId: string, attemptId?: string|null, report: object }} input
   * @returns {{ created: boolean, stored: object }} created=false 表示这次输入与库里已有的完全一致
   */
  const save = ({ runId, stepId, attemptId = null, report: input } = {}) => {
    const runIdValue = nonEmpty(runId, 'run_id')
    const stepIdValue = nonEmpty(stepId, 'step_id')
    const attemptIdValue = attemptId === null || attemptId === undefined || attemptId === '' ? null : nonEmpty(attemptId, 'attempt_id')
    const report = normalizedForStore(input)
    assertRunStep({ runId: runIdValue, stepId: stepIdValue })
    // 保存路径也核对 attempt 归属：否则一条挂错 Attempt 的报告只能等到读出来才发现。
    assertAttempt({ attemptId: attemptIdValue, stepId: stepIdValue })

    const binding = bindingOf(report)
    // 规范化 JSON 作为落库正文：同一份内容永远得到同一串字节，重复保存才可能被判等。
    const reportJson = canonicalJson(report)
    const bodyDigest = hash(reportJson)
    const id = validationIdFor({ runId: runIdValue, stepId: stepIdValue, bodyDigest })
    ensure()

    // 取值顺序与 INSERT_COLUMNS 一一对应；列清单和占位符同源生成，不会出现个数漂移。
    const values = [
      id, runIdValue, stepIdValue, attemptIdValue, binding.artifactType, binding.subjectKind, binding.subjectDigest,
      binding.outputSetDigest, binding.contentHash, binding.definitionDigest, binding.inputIdsJson, binding.inputIdsHash,
      VALIDATION_SCHEMA_VERSION, binding.reportStatus, binding.requiredChecksJson, binding.reportDigest, bodyDigest, reportJson,
      report.producedBy ?? null, report.producedAt ?? null, clock(),
    ]

    try {
      run(
        `INSERT INTO ${VALIDATION_TABLE} (${INSERT_COLUMNS.join(',')}) VALUES(${INSERT_COLUMNS.map(() => '?').join(',')})`,
        ...values,
      )
    } catch (error) {
      if (!uniqueViolation(error)) throw error
      const existing = one(`SELECT * FROM ${VALIDATION_TABLE} WHERE id=?`, id)
      // 主键冲突有两种来源，必须分开处理：
      // ① 完全相同的报告被重复保存 → 幂等，返回库里那一份（created=false），不新增行；
      // ② 同 id 但字节不同（正文被改过，或摘要碰撞）→ 冲突，拒绝覆盖，绝不改旧行。
      if (!existing) throw fail('validation_report_conflict', `${id}:id_unavailable`)
      // 同一份正文挂到不同 Attempt 上：这是两条不同的关联事实。旧行不可变，
      // 也不能悄悄沿用旧的关联，只能拒绝并让调用方明确处理。
      if ((existing.attempt_id ?? null) !== attemptIdValue) {
        throw fail('validation_report_conflict', `${id}:attempt_mismatch`)
      }
      if (existing.body_digest !== bodyDigest || existing.report_json !== reportJson) {
        throw fail('validation_report_conflict', `${id}:same_id_different_body`)
      }
      return { created: false, stored: rehydrate(existing) }
    }

    return { created: true, stored: rehydrate(one(`SELECT * FROM ${VALIDATION_TABLE} WHERE id=?`, id)) }
  }

  /** 按 id 读回；表不存在时视为没有报告（不是坏数据）。 */
  const read = (id) => {
    if (typeof id !== 'string' || id === '') throw fail('validation_store_input_invalid', 'id')
    if (!hasTable()) return null
    const row = one(`SELECT * FROM ${VALIDATION_TABLE} WHERE id=?`, id)
    return row ? rehydrate(row) : null
  }

  /**
   * 按绑定列出一份绑定下的全部报告，按写入顺序（旧→新）。
   *
   * 返回列表而不是单份：「同一内容重新检查」会追加新报告，确认时必须由调用方
   * 明确选定某个 id（04:34 确认针对具体草稿版本），本模块不替它挑「最新」或「通过」的那份。
   */
  const byBinding = ({ runId, stepId, subjectDigest, definitionDigest, inputSnapshotIds = [] } = {}) => {
    const runIdValue = nonEmpty(runId, 'run_id')
    const stepIdValue = nonEmpty(stepId, 'step_id')
    if (typeof subjectDigest !== 'string' || subjectDigest === '') throw fail('validation_store_input_invalid', 'subject_digest')
    if (typeof definitionDigest !== 'string' || definitionDigest === '') throw fail('validation_store_input_invalid', 'definition_digest')
    if (!hasTable()) return []
    const inputIdsHash = hash(canonicalJson(normalizeInputSnapshotIds(inputSnapshotIds)))
    return all(
      `SELECT * FROM ${VALIDATION_TABLE} WHERE run_id=? AND step_id=? AND subject_digest=? AND definition_digest=? AND input_ids_hash=? ORDER BY rowid`,
      runIdValue, stepIdValue, subjectDigest, definitionDigest, inputIdsHash,
    ).map(rehydrate)
  }

  const listByRun = runId => hasTable()
    ? all(`SELECT * FROM ${VALIDATION_TABLE} WHERE run_id=? ORDER BY rowid`, runId).map(rehydrate)
    : []
  const listByStep = stepId => hasTable()
    ? all(`SELECT * FROM ${VALIDATION_TABLE} WHERE step_id=? ORDER BY rowid`, stepId).map(rehydrate)
    : []

  return { ensure, hasTable, save, read, byBinding, listByRun, listByStep }
}

/**
 * 备份/恢复校验入口（只读句柄，不启动内核）。
 *
 * 每条报告都重新校验结构与摘要；关联、归属、id 推导也要对得上。
 * 旧副本里没有报告表：没有记录可校验，不算损坏。
 */
export function verifyValidationStore(db) {
  if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(VALIDATION_TABLE)) {
    return { validations: 0, present: false }
  }
  const rows = db.prepare(`SELECT * FROM ${VALIDATION_TABLE}`).all()
  const hasRuns = Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_runs'`).get())
  const hasSteps = Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_steps'`).get())
  const hasAttempts = Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_attempts'`).get())
  // 复用与读路径完全相同的校验：备份校验不应该比正常读更宽松。
  const store = createValidationStore({ db })

  for (const row of rows) {
    store.read(row.id)
    if (hasRuns && !db.prepare('SELECT id FROM workflow_runs WHERE id=?').get(row.run_id)) {
      throw fail('backup_validation_association_invalid', `${row.id}:run`)
    }
    if (hasSteps) {
      const step = db.prepare('SELECT id,run_id FROM workflow_steps WHERE id=?').get(row.step_id)
      if (!step) throw fail('backup_validation_association_invalid', `${row.id}:step`)
      if (step.run_id !== row.run_id) throw fail('backup_validation_association_invalid', `${row.id}:step_run`)
    }
    if (row.attempt_id !== null && row.attempt_id !== undefined && hasAttempts) {
      const attempt = db.prepare('SELECT id,step_id FROM workflow_attempts WHERE id=?').get(row.attempt_id)
      if (!attempt) throw fail('backup_validation_association_invalid', `${row.id}:attempt`)
      if (attempt.step_id !== row.step_id) throw fail('backup_validation_association_invalid', `${row.id}:attempt_step`)
    }
  }
  return { validations: rows.length, present: true }
}
