import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, renameSync, existsSync, unlinkSync, readFileSync, openSync, closeSync, fsyncSync, linkSync, lstatSync } from 'node:fs'
import { dirname, join, resolve, parse as parsePath, sep } from 'node:path'
import { createJobStore } from './m1-job-store.mjs'
import { createValidationStore } from './m1-validation-store.mjs'
import { definitionDigestFor, assertValidationReport, assessValidationReport } from './m1-validation.mjs'
import { validateDraft } from './m1-draft-validator.mjs'
import { validateFakeCapability } from './m1-fake-capability.mjs'
import { validateOutputDeclarations, normalizeOutputSet, fileBytesDigest } from './m1-output-set.mjs'
import { validateHumanInputMapping, mapHumanInputSet } from './m1-human-mapping.mjs'
import { assertNoInjectedObjectPaths, putOutputObject, readOutputObject, writeOutputSet, verifyOutputSet, readOutputSet, readOutputSetTolerant } from './m1-output-set-store.mjs'

const require = createRequire(import.meta.url)

export const ARTIFACT_TYPES = Object.freeze(['text', 'markdown', 'json', 'file-set', 'report'])

export const RUN_STATES = ['created', 'running', 'waiting_review', 'paused', 'completed', 'failed', 'cancelled']
export const STEP_STATES = ['pending', 'running', 'waiting_review', 'paused', 'succeeded', 'failed', 'cancelled', 'stale', 'skipped']
/** 仍未收敛、会被视为 run 未完成的状态。stale 需要重跑，所以也算未完成。 */
const OPEN_STEP_STATES = ['pending', 'stale', 'running', 'waiting_review', 'paused']
const CLAIMABLE_STEP_STATES = ['pending', 'stale', 'paused']
const CLOSED_RUN_STATES = ['completed', 'failed', 'cancelled']

const DEFAULT_LEASE_MS = 15 * 60 * 1000
/** 可恢复扫描的条目种类：租约过期、待对账发布、待续发发布、需重跑步骤、被暂停运行。 */
export const RECOVERY_KINDS = ['lease_expired', 'outbox_outcome_unknown', 'outbox_running', 'outbox_pending', 'step_stale', 'step_paused', 'run_paused']

const now = () => new Date().toISOString()
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const json = value => JSON.stringify(value ?? {})
const parse = value => JSON.parse(value || '{}')
const fail = (code, message = code) => Object.assign(new Error(message), { code })
const fileSafe = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_')

const readCandidateManifest = (path) => {
  const directory = lstatSync(dirname(path))
  const entry = lstatSync(path)
  if (directory.isSymbolicLink() || !directory.isDirectory() || entry.isSymbolicLink() || !entry.isFile()) throw fail('manifest_path_invalid')
  return parse(readFileSync(path, 'utf8'))
}

// Controlled offline workspace: publish a complete manifest without replacing
// another candidate. File fsync does not claim directory-entry crash durability.
const writeCandidateManifest = (path, manifest) => {
  const directory = lstatSync(dirname(path))
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw fail('manifest_path_invalid')
  const content = json(manifest)
  const temp = `${path}.${randomBytes(16).toString('hex')}.tmp`
  let fd = null
  let owned = false
  try {
    fd = openSync(temp, 'wx', 0o600)
    owned = true
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    try { linkSync(temp, path) } catch (error) {
      if (error?.code !== 'EEXIST') throw fail('manifest_publish_failed', `no_replace_publish:${error?.code ?? 'unknown'}`)
      const entry = lstatSync(path)
      if (entry.isSymbolicLink() || !entry.isFile()) throw fail('manifest_path_invalid')
      if (readFileSync(path, 'utf8') !== content) throw fail('candidate_manifest_conflict')
    }
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch {} }
    if (owned) { try { unlinkSync(temp) } catch {} }
  }
}

export class WorkflowRequiresSqliteError extends Error {
  constructor() { super('workflow_requires_sqlite'); this.code = 'workflow_requires_sqlite' }
}

/** 输入校验失败的错误码（A10）：detail 一律是 `<字段>:<原因>`，便于调用方定位而不泄露库内结构。 */
export const INPUT_SCHEMA_INVALID = 'input_schema_invalid'

// JSON 类型判别：整数单独一类，否则 schema 里写 integer 会让 3 和 3.5 混为一谈。
const valueType = (value) => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/**
 * A10 的 schema 方言：只认下面这份白名单，别的一律在「创建运行」时拒绝。
 * 静默忽略不认识的关键字等于输入边界没生效——{minimum:2} 被当成没有约束，比直接报错更危险。
 * 刻意不支持嵌套对象与数组：本方言只覆盖扁平字段，声明了也没法校验，所以直接拒。
 */
export const INPUT_SCHEMA_DIALECT = 'workflow-input/1'
const SCHEMA_ROOT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties'])
const SCHEMA_PROPERTY_KEYS = new Set(['type', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum'])
const SCHEMA_PROPERTY_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

const schemaBad = (detail) => fail('schema_invalid', `input_schema:${detail}`)

/**
 * 字段存在性一律用自有键判断。
 * `name in obj` 会顺着原型链找到 toString/constructor/valueOf，于是 `required:['toString']` 配 `{}`
 * 被误判成「已声明且已提供」——必填校验被原型链成员架空，输入边界等于没设。
 */
const hasOwn = (target, key) => Object.prototype.hasOwnProperty.call(target, key)

/**
 * 校验 schema 本身是否符合方言：在创建运行时调用，写错/用错关键字立刻拒绝。
 * 通过返回 true，失败抛 schema_invalid —— 不让一份「看起来有约束、实际被忽略」的 schema 进库。
 */
export function validateInputSchemaDefinition(schema) {
  if (schema === null || schema === undefined) return true
  if (typeof schema !== 'object' || Array.isArray(schema)) throw schemaBad('not_object')
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_ROOT_KEYS.has(key)) throw schemaBad(`unsupported_keyword:${key}`)
  }
  if (schema.type !== 'object') throw schemaBad(`root_type:${schema.type ?? 'undefined'}`)
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) throw schemaBad('required_not_array')
    for (const name of schema.required) {
      if (typeof name !== 'string' || name === '') throw schemaBad('required_not_string')
    }
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw schemaBad('additional_properties_unsupported')
  }
  // 显式 properties:null 是写错的 schema，不是「没有字段」：以前 `?? {}` 把它当成空对象放行，
  // 于是 required 里写什么都会被当成未声明而静默失效（或反过来被当成合法空 schema）。
  if (schema.properties === null) throw schemaBad('properties_null')
  const properties = schema.properties === undefined ? {} : schema.properties
  if (typeof properties !== 'object' || Array.isArray(properties)) throw schemaBad('properties_not_object')
  for (const [name, rule] of Object.entries(properties)) {
    const path = `properties.${name}`
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) throw schemaBad(`${path}:rule_not_object`)
    for (const key of Object.keys(rule)) {
      if (!SCHEMA_PROPERTY_KEYS.has(key)) throw schemaBad(`${path}:unsupported_keyword:${key}`)
    }
    if (rule.type !== undefined && !SCHEMA_PROPERTY_TYPES.has(rule.type)) throw schemaBad(`${path}:unsupported_type:${rule.type}`)
    if (rule.enum !== undefined) {
      if (!Array.isArray(rule.enum) || rule.enum.length === 0) throw schemaBad(`${path}:enum_malformed`)
    }
    for (const key of ['minLength', 'maxLength']) {
      if (rule[key] === undefined) continue
      if (!Number.isInteger(rule[key]) || rule[key] < 0) throw schemaBad(`${path}:${key}_malformed`)
    }
    if (rule.minLength !== undefined && rule.maxLength !== undefined && rule.minLength > rule.maxLength) {
      throw schemaBad(`${path}:bounds_inverted`)
    }
    for (const key of ['minimum', 'maximum']) {
      if (rule[key] === undefined) continue
      if (typeof rule[key] !== 'number' || !Number.isFinite(rule[key])) throw schemaBad(`${path}:${key}_malformed`)
    }
    if (rule.minimum !== undefined && rule.maximum !== undefined && rule.minimum > rule.maximum) {
      throw schemaBad(`${path}:bounds_inverted`)
    }
    if (rule.pattern !== undefined) {
      if (typeof rule.pattern !== 'string') throw schemaBad(`${path}:pattern_malformed`)
      try {
        new RegExp(rule.pattern)
      } catch {
        throw schemaBad(`${path}:pattern_invalid`)
      }
    }
    // 约束必须依附在相容的类型上。缺 type 时值校验器会跳过长度/区间/枚举判定，
    // {minimum:2} 这种「看着有约束、其实不生效」的 schema 比报错更危险，创建时直接拒。
    const declaredType = rule.type
    const stringKeys = ['minLength', 'maxLength', 'pattern'].filter((key) => rule[key] !== undefined)
    const numericKeys = ['minimum', 'maximum'].filter((key) => rule[key] !== undefined)
    if (declaredType === undefined) {
      const orphan = rule.enum !== undefined ? 'enum' : (stringKeys[0] ?? numericKeys[0])
      if (orphan !== undefined) throw schemaBad(`${path}:constraint_without_type:${orphan}`)
    } else {
      for (const key of stringKeys) {
        if (declaredType !== 'string') throw schemaBad(`${path}:constraint_type_mismatch:${key}:${declaredType}`)
      }
      if (numericKeys.length > 0 && declaredType !== 'number' && declaredType !== 'integer') {
        throw schemaBad(`${path}:constraint_type_mismatch:${numericKeys[0]}:${declaredType}`)
      }
      if (rule.enum !== undefined) {
        for (const candidate of rule.enum) {
          const actual = valueType(candidate)
          if (actual !== declaredType && !(declaredType === 'number' && actual === 'integer')) {
            throw schemaBad(`${path}:enum_type_mismatch:${actual}`)
          }
        }
      }
    }
  }
  // required 里的字段必须真的声明过：拼错名字会让「必填」变成永远满足。
  for (const name of schema.required ?? []) {
    if (!hasOwn(properties, name)) throw schemaBad(`required_undefined:${name}`)
  }
  return true
}

/**
 * A10：执行前按 schema 校验 run 输入。
 * 只认这一处判定——没有 allowInvalid / bypass 之类开关，业务不得豁免；
 * 通过返回 true，失败抛 input_schema_invalid（schema 本身写坏则是 schema_invalid）。
 * 先校验 schema 是否符合方言，再校验值：读库里的旧 schema 也一样过这一道，不会因为「存进去了」就跳过。
 */
export function validateInputSchema(schema, input) {
  validateInputSchemaDefinition(schema)
  if (schema === null || schema === undefined) return true
  const bad = (path, reason) => fail(INPUT_SCHEMA_INVALID, `${path}:${reason}`)
  const value = input === undefined ? {} : input
  if (valueType(value) !== 'object') throw bad('$', 'not_object')
  const properties = schema.properties === undefined ? {} : schema.properties
  const required = schema.required ?? []
  // 值侧同样只认自有键：`'toString' in {}` 为真，会让 `required:['toString']` 配空对象直接通过。
  // 显式 undefined 等同于没提供——JSON 里根本没有这个值，放行会留下一个「必填但其实缺席」的洞。
  for (const name of required) {
    if (!hasOwn(value, name) || value[name] === undefined) throw bad(name, 'required')
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) if (!hasOwn(properties, name)) throw bad(name, 'unexpected')
  }
  for (const [name, rule] of Object.entries(properties)) {
    if (!hasOwn(value, name) || value[name] === undefined) continue
    const actual = valueType(value[name])
    const expected = rule?.type
    // integer 满足 number；反过来不行（3.5 不是 integer）。
    if (expected !== undefined && expected !== actual && !(expected === 'number' && actual === 'integer')) {
      throw bad(name, 'wrong_type')
    }
    if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => candidate === value[name])) throw bad(name, 'not_in_enum')
    if (typeof value[name] === 'string') {
      if (Number.isInteger(rule.minLength) && value[name].length < rule.minLength) throw bad(name, 'too_short')
      if (Number.isInteger(rule.maxLength) && value[name].length > rule.maxLength) throw bad(name, 'too_long')
      if (typeof rule.pattern === 'string' && !new RegExp(rule.pattern).test(value[name])) throw bad(name, 'pattern_mismatch')
    }
    if (typeof value[name] === 'number') {
      if (rule.minimum !== undefined && value[name] < rule.minimum) throw bad(name, 'below_minimum')
      if (rule.maximum !== undefined && value[name] > rule.maximum) throw bad(name, 'above_maximum')
    }
  }
  return true
}

export function createWorkflowKernel(db, root, options = {}) {
  if (!db || typeof db.exec !== 'function') throw new WorkflowRequiresSqliteError()
  mkdirSync(join(root, 'objects'), { recursive: true })
  mkdirSync(join(root, 'manifests'), { recursive: true })
  mkdirSync(join(root, 'staging'), { recursive: true })
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      budget_total INTEGER NOT NULL DEFAULT 900, budget_used INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), node_id TEXT NOT NULL,
      node_kind TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      current_adoption_id TEXT, stale INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workflow_attempts (
      id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES workflow_steps(id), attempt_no INTEGER NOT NULL,
      token TEXT NOT NULL, lease_until TEXT NOT NULL, status TEXT NOT NULL, input_hash TEXT NOT NULL,
      output_hash TEXT, outcome TEXT, UNIQUE(step_id, attempt_no)
    );
    CREATE TABLE IF NOT EXISTS workflow_snapshots (
      id TEXT PRIMARY KEY, artifact_type TEXT NOT NULL, content_hash TEXT NOT NULL,
      manifest_hash TEXT NOT NULL, parent_id TEXT, source_attempt_id TEXT, author_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_drafts (
      id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, revision INTEGER NOT NULL,
      content TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', UNIQUE(id, revision)
    );
    CREATE TABLE IF NOT EXISTS workflow_adoptions (
      id TEXT PRIMARY KEY, step_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
      actor_type TEXT NOT NULL, previous_id TEXT, reason TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
      type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS workflow_outbox (
      id TEXT PRIMARY KEY, adoption_id TEXT NOT NULL, target TEXT NOT NULL,
      base_revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      required INTEGER NOT NULL DEFAULT 1, reason TEXT, updated_at TEXT, created_at TEXT NOT NULL,
      base_hash TEXT, expected_hash TEXT, target_kind TEXT, relative_path TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_publish_owners (
      target TEXT PRIMARY KEY, outbox_id TEXT NOT NULL, adopted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_human_tasks (
      id TEXT PRIMARY KEY, step_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      task_revision INTEGER NOT NULL DEFAULT 1, draft_id TEXT, status TEXT NOT NULL,
      confirmed_by TEXT, confirmed_at TEXT, UNIQUE(step_id, input_hash)
    );
    CREATE TABLE IF NOT EXISTS workflow_input_bindings (
      owner_id TEXT NOT NULL, version INTEGER NOT NULL, binding_json TEXT NOT NULL,
      frozen_at TEXT NOT NULL, PRIMARY KEY(owner_id, version)
    );
    CREATE TABLE IF NOT EXISTS workflow_requests (
      scope_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      operation_id TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_id, idempotency_key)
    );
  `)

  createJobStore({ kernel: { db } }).ensure()
  const validationStore = createValidationStore({ db })
  validationStore.ensure()

  // 输入 schema 跟着 run 落到库里：重启后再领取仍然要按同一份 schema 校验（A10），
  // 不能只存在调用方内存里。旧库用 ALTER 补列，避免重建表丢数据。
  const runColumns = db.prepare('PRAGMA table_info(workflow_runs)').all().map((column) => column.name)
  if (!runColumns.includes('input_schema')) db.exec('ALTER TABLE workflow_runs ADD COLUMN input_schema TEXT')

  const bindingColumns = db.prepare('PRAGMA table_info(workflow_input_bindings)').all().map(c => c.name)
  if (!bindingColumns.includes('integrity_hash')) db.exec('ALTER TABLE workflow_input_bindings ADD COLUMN integrity_hash TEXT')

  const outboxColumns = db.prepare('PRAGMA table_info(workflow_outbox)').all().map(c => c.name)
  if (!outboxColumns.includes('claim_generation')) db.exec('ALTER TABLE workflow_outbox ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0')

  for (const column of ['base_hash', 'expected_hash', 'target_kind', 'relative_path']) {
    if (!outboxColumns.includes(column)) db.exec(`ALTER TABLE workflow_outbox ADD COLUMN ${column} TEXT`)
  }

  db.exec(`CREATE TABLE IF NOT EXISTS workflow_run_definitions (
    run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id), definition_json TEXT NOT NULL,
    integrity_hash TEXT NOT NULL, product_id TEXT, fork_json TEXT
  );`)

  const definitionFor = runId => {
    const row = one('SELECT * FROM workflow_run_definitions WHERE run_id=?', runId)
    if (!row) throw fail('definition_unavailable')
    const definition = parse(row.definition_json)
    if (row.integrity_hash !== hash(definition)) throw fail('definition_invalid')
    return definition
  }
  const targetsFor = stepId => {
    const step = one('SELECT * FROM workflow_steps WHERE id=?', stepId)
    if (!step) throw fail('step_not_found')
    const definition = definitionFor(step.run_id)
    const node = definition.steps.find(item => item.nodeId === step.node_id)
    if (!node || !Array.isArray(node.publishTargets)) throw fail('publish_declaration_missing')
    return node.publishTargets
  }

  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)

  let txDepth = 0
  const transaction = (fn) => {
    if (txDepth > 0) return fn()
    txDepth++
    db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); db.exec('COMMIT'); return value } catch (error) { try { db.exec('ROLLBACK') } catch {}; throw error } finally { txDepth-- }
  }
  const cas = (sql, args, code = 'cas_conflict') => {
    const result = db.prepare(sql).run(...args)
    if (Number(result.changes ?? 0) !== 1) throw fail(code)
    return result
  }
  const event = (runId, type, payload) => {
    const row = one('SELECT COALESCE(MAX(seq), 0) AS seq FROM workflow_events WHERE run_id=?', runId)
    const seq = Number(row.seq) + 1
    run('INSERT INTO workflow_events(id,run_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)', `${runId}:e:${seq}`, runId, seq, type, json(payload), now())
  }
  const request = (scopeId, key, input, operation) => {
    const requestHash = hash(input)
    const prior = one('SELECT * FROM workflow_requests WHERE scope_id=? AND idempotency_key=?', scopeId, key)
    if (prior) {
      if (prior.request_hash !== requestHash) throw fail('idempotency_conflict')
      return { ...parse(prior.result), replayed: true }
    }
    const result = operation()
    run('INSERT INTO workflow_requests VALUES(?,?,?,?,?,?)', scopeId, key, requestHash, result.operationId, json(result), now())
    return result
  }

  // 运行与步骤状态推进都读一次 revision 再 CAS，避免静默覆盖。
  const setRunStatus = (runId, status, pauseReason = null) => {
    const row = one('SELECT revision FROM workflow_runs WHERE id=?', runId)
    cas('UPDATE workflow_runs SET status=?,pause_reason=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', [status, pauseReason, now(), runId, row.revision])
  }
  const chargeBudget = (runId) => {
    const row = one('SELECT budget_total,budget_used FROM workflow_runs WHERE id=?', runId)
    if (!row) throw fail('run_not_found')
    if (Number(row.budget_used) >= Number(row.budget_total)) throw fail('budget_exhausted')
    run('UPDATE workflow_runs SET budget_used=budget_used+1 WHERE id=?', runId)
    return Number(row.budget_used) + 1
  }
  // 进程重启或租约到期后，把过期 Attempt 打成 expired，并把卡住的步骤退回可领取。
  const reapExpiredLeases = (runId) => {
    const stamp = now()
    const stale = all("SELECT a.id AS attempt_id, a.step_id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? AND a.status='running' AND a.lease_until < ?", runId, stamp)
    for (const row of stale) {
      run("UPDATE workflow_attempts SET status='expired', outcome='lease_expired' WHERE id=? AND status='running'", row.attempt_id)
      const step = one('SELECT * FROM workflow_steps WHERE id=?', row.step_id)
      if (step && ['running', 'waiting_review'].includes(step.state)) run("UPDATE workflow_steps SET state='paused', revision=revision+1 WHERE id=?", step.id)
    }
    return stale.length
  }
  const dependenciesOf = step => one('SELECT run_id FROM workflow_run_definitions WHERE run_id=?', step.run_id) ? definitionFor(step.run_id).steps.find(node => node.nodeId === step.node_id)?.dependencies : undefined
  const joinsAny = step => definitionFor(step.run_id).steps.find(node => node.nodeId === step.node_id)?.joinPolicy === 'any'
  const activeConditionalPort = content => {
    const envelope = parse(content)
    if (envelope.kind !== 'workflow-check-v1' || typeof envelope.ok !== 'boolean' || typeof envelope.input !== 'string' || !envelope.report || typeof envelope.report !== 'object' || envelope.report.ok !== envelope.ok) throw fail('conditional_output_invalid')
    return envelope.ok ? 'pass' : 'fail'
  }
  const descendantsOf = step => {
    const definitions = one('SELECT run_id FROM workflow_run_definitions WHERE run_id=?', step.run_id) ? definitionFor(step.run_id).steps : []
    if (!definitions.some(node => node.dependencies !== undefined)) return all('SELECT * FROM workflow_steps WHERE run_id=? AND rowid > (SELECT rowid FROM workflow_steps WHERE id=?)', step.run_id, step.id)
    const ids = new Set([step.node_id])
    let changed = true
    while (changed) {
      changed = false
      for (const node of definitions) if (!ids.has(node.nodeId) && node.dependencies?.some(dep => ids.has(dep.nodeId))) { ids.add(node.nodeId); changed = true }
    }
    ids.delete(step.node_id)
    return all('SELECT * FROM workflow_steps WHERE run_id=? ORDER BY rowid', step.run_id).filter(row => ids.has(row.node_id))
  }
  // New definitions bind every connected input. Old definitions retain their linear semantics.
  const captureInputs = (step) => {
    const dependencies = dependenciesOf(step)
    if (dependencies !== undefined) {
      const omissions = []
      const inputs = dependencies.flatMap(dep => {
        const sourceStep = one('SELECT * FROM workflow_steps WHERE run_id=? AND node_id=?', step.run_id, dep.nodeId)
        if (joinsAny(step) && sourceStep?.state === 'skipped' && !sourceStep.stale) {
          const evidence = one("SELECT seq FROM workflow_events WHERE run_id=? AND type='step.skipped' AND json_extract(payload,'$.stepId')=? ORDER BY seq DESC LIMIT 1", step.run_id, sourceStep.id)
          if (!evidence) throw fail('conditional_skip_invalid')
          omissions.push({ ...dep, stepId: sourceStep.id, reason: 'upstream_skipped', eventSeq: evidence.seq })
          return []
        }
        const upstream = one('SELECT s.id AS stepId,a.id AS adoptionId,a.snapshot_id AS snapshotId,p.content_hash AS contentHash FROM workflow_steps s JOIN workflow_adoptions a ON a.id=s.current_adoption_id JOIN workflow_snapshots p ON p.id=a.snapshot_id WHERE s.run_id=? AND s.node_id=? AND s.state=? AND s.stale=0', step.run_id, dep.nodeId, 'succeeded')
        if (!upstream) throw fail('dependency_not_ready', dep.nodeId)
        const source = definitionFor(step.run_id).steps.find(node => node.nodeId === dep.nodeId)
        if (source?.portPayloads === 'check-v1' && dep.fromPort !== activeConditionalPort(readSnapshot(upstream.snapshotId).content)) {
          if (!joinsAny(step)) throw fail('dependency_inactive', dep.nodeId)
          omissions.push({ ...upstream, ...dep, reason: 'port_inactive' })
          return []
        }
        return [{ ...upstream, nodeId: dep.nodeId, fromPort: dep.fromPort, toPort: dep.toPort }]
      })
      if (joinsAny(step)) {
        if (!inputs.length) throw fail('dependency_inactive')
        return { inputs, omissions }
      }
      return inputs
    }
    const upstream = one('SELECT s.id AS stepId,a.id AS adoptionId,a.snapshot_id AS snapshotId,p.content_hash AS contentHash FROM workflow_steps s JOIN workflow_adoptions a ON a.id=s.current_adoption_id JOIN workflow_snapshots p ON p.id=a.snapshot_id WHERE s.run_id=? AND s.rowid < (SELECT rowid FROM workflow_steps WHERE id=?) ORDER BY s.rowid DESC LIMIT 1', step.run_id, step.id)
    return upstream ? [upstream] : []
  }
  const freezeInputs = (ownerId, version, inputs) => run('INSERT INTO workflow_input_bindings VALUES(?,?,?,?,?)', ownerId, version, json(inputs), now(), hash({ ownerId, version, inputs }))
  const inputBindingFor = (ownerId, version = null) => {
    const binding = version === null
      ? one('SELECT * FROM workflow_input_bindings WHERE owner_id=? ORDER BY version DESC LIMIT 1', ownerId)
      : one('SELECT * FROM workflow_input_bindings WHERE owner_id=? AND version=?', ownerId, version)
    if (!binding) throw fail('attempt_input_unbound')
    const stored = parse(binding.binding_json)
    if (binding.integrity_hash !== hash({ ownerId, version: binding.version, inputs: stored })) throw fail('attempt_input_invalid')
    const inputs = Array.isArray(stored) ? stored : stored?.inputs
    const omissions = Array.isArray(stored) ? [] : stored?.omissions
    const owner = one('SELECT step_id FROM workflow_attempts WHERE id=?', ownerId) ?? one('SELECT step_id FROM workflow_human_tasks WHERE id=?', ownerId)
    if (!owner || !Array.isArray(inputs)) throw fail('attempt_input_invalid')
    const target = one('SELECT * FROM workflow_steps WHERE id=?', owner.step_id)
    const dependencies = target && dependenciesOf(target)
    if (dependencies === undefined && inputs.length > 1) throw fail('attempt_input_invalid')
    if (!Array.isArray(omissions) || (omissions.length && !joinsAny(target))) throw fail('attempt_input_invalid')
    if (dependencies !== undefined) {
      const matches = (input, dep) => input && dep && input.nodeId === dep.nodeId && input.fromPort === dep.fromPort && input.toPort === dep.toPort
      const allInputs = [...inputs, ...omissions]
      if (allInputs.length !== dependencies.length || dependencies.some(dep => allInputs.filter(input => matches(input, dep)).length !== 1)) throw fail('attempt_input_invalid')
      const activeDependencies = dependencies.filter(dep => !omissions.some(item => matches(item, dep)))
      if (inputs.some((input, i) => !matches(input, activeDependencies[i]))) throw fail('attempt_input_invalid')
      if (joinsAny(target) && !inputs.length) throw fail('attempt_input_invalid')
    }
    for (const input of inputs) {
      const source = one('SELECT a.snapshot_id,p.content_hash FROM workflow_adoptions a JOIN workflow_steps s ON s.id=a.step_id JOIN workflow_snapshots p ON p.id=a.snapshot_id JOIN workflow_steps target ON target.id=? WHERE a.id=? AND s.id=? AND s.run_id=target.run_id AND s.rowid<target.rowid', owner.step_id, input.adoptionId, input.stepId)
      if (!source || source.snapshot_id !== input.snapshotId || source.content_hash !== input.contentHash) throw fail('attempt_input_invalid')
    }
    for (const omitted of omissions) {
      const source = one('SELECT node_id FROM workflow_steps WHERE id=? AND run_id=? AND rowid<(SELECT rowid FROM workflow_steps WHERE id=?)', omitted.stepId, target.run_id, target.id)
      if (source?.node_id !== omitted.nodeId) throw fail('attempt_input_invalid')
      if (omitted.reason === 'upstream_skipped') {
        const evidence = one("SELECT payload FROM workflow_events WHERE run_id=? AND seq=? AND type='step.skipped'", target.run_id, omitted.eventSeq)
        if (!evidence || parse(evidence.payload).stepId !== omitted.stepId) throw fail('attempt_input_invalid')
      } else if (omitted.reason === 'port_inactive') {
        const adoption = one('SELECT snapshot_id FROM workflow_adoptions WHERE id=? AND step_id=?', omitted.adoptionId, omitted.stepId)
        const definition = definitionFor(target.run_id).steps.find(node => node.nodeId === omitted.nodeId)
        if (definition?.portPayloads !== 'check-v1' || adoption?.snapshot_id !== omitted.snapshotId) throw fail('attempt_input_invalid')
        const snapshot = readSnapshot(omitted.snapshotId)
        if (snapshot.contentHash !== omitted.contentHash || activeConditionalPort(snapshot.content) === omitted.fromPort) throw fail('attempt_input_invalid')
      } else throw fail('attempt_input_invalid')
    }
    return { version: binding.version, inputs, ...(omissions.length ? { omissions } : {}) }
  }
  // 快照父指针一律指向快照 id：同一步再采用指向上一个快照，跨步骤指向最近上游已采用的快照。
  const parentSnapshotFor = (step) => {
    if (step.current_adoption_id) {
      const prior = one('SELECT snapshot_id FROM workflow_adoptions WHERE id=?', step.current_adoption_id)
      if (prior) return prior.snapshot_id
    }
    const dependencies = dependenciesOf(step)
    if (dependencies !== undefined) {
      const owner = one("SELECT id FROM workflow_attempts WHERE step_id=? AND status='running' ORDER BY attempt_no DESC LIMIT 1", step.id)
      if (!owner) throw fail('attempt_input_unbound')
      return inputBindingFor(owner.id).inputs[0]?.snapshotId ?? null
    }
    const upstream = all('SELECT current_adoption_id FROM workflow_steps WHERE run_id=? AND rowid < (SELECT rowid FROM workflow_steps WHERE id=?) ORDER BY rowid DESC', step.run_id, step.id)
    for (const row of upstream) {
      if (!row.current_adoption_id) continue
      const adoption = one('SELECT snapshot_id FROM workflow_adoptions WHERE id=?', row.current_adoption_id)
      if (adoption) return adoption.snapshot_id
    }
    return null
  }
  // 上游被重新采用后，下游已产出的步骤失效，必须重跑；在途 Attempt 一并作废，
  // 否则它仍能凭有效 token 采用上游变更之前的结果，把 stale 清掉（A03 反例）。
  const markDownstreamStale = (step) => {
    const downstream = descendantsOf(step)
    const marked = []
    const voided = []
    const shelvedTasks = []
    for (const row of downstream) {
      if (['succeeded', 'waiting_review', 'running', 'paused', 'skipped'].includes(row.state)) {
        run("UPDATE workflow_steps SET state='stale', stale=1, revision=revision+1 WHERE id=?", row.id)
        marked.push(row.id)
        const inflight = all("SELECT id FROM workflow_attempts WHERE step_id=? AND status='running'", row.id)
        for (const attempt of inflight) {
          run("UPDATE workflow_attempts SET status='superseded', outcome='upstream_changed' WHERE id=?", attempt.id)
          voided.push(attempt.id)
        }
        // 人工步骤被作废时，它挂着的待办必须一起搁置（status='stale'）：否则旧的 open 待办
        // 会让运行一直停在 waiting_review，既不能被重新领取，也确认不了——直接死锁。
        // 草稿不动：重新领取时同一待办会以新修订重开，编辑内容仍在（A36 草稿保留）。
        const tasks = all("SELECT id FROM workflow_human_tasks WHERE step_id=? AND status='open'", row.id)
        for (const task of tasks) {
          run("UPDATE workflow_human_tasks SET status='stale' WHERE id=?", task.id)
          shelvedTasks.push(task.id)
        }
      }
    }
    return { marked, voided, shelvedTasks }
  }

  // 必需发布失败/冲突/结果未知时的暂停原因（01-domain-model：结构化 pauseReason）。
  const PUBLISH_PAUSE_REASON = { conflict: 'publish_conflict', failed: 'publish_failed', outcome_unknown: 'publish_outcome_unknown' }
  // 只有已终结的发布才不阻拦完成：superseded / cancelled 是被替换或被取消，不算未完成。
  const REQUIRED_PUBLISH_OPEN = ['pending', 'running']
  const REQUIRED_PUBLISH_BLOCKED = ['conflict', 'failed', 'outcome_unknown']

  // 本运行声明的发布项（只取必需项；可选发布失败不影响完成，但要单列）。
  const publishItemsFor = (runId, requiredOnly = true) => {
    const rows = all('SELECT o.*,o.relative_path AS relativePath FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? ORDER BY o.rowid', runId)
    return requiredOnly ? rows.filter((row) => Number(row.required) === 1) : rows
  }

  // 运行收敛条件（01 §状态机 + 08 §发布对账）：
  // 只有全部必需步骤已采用且全部必需发布已成功，才允许 completed；
  // 必需发布冲突/失败/未知一律 paused 并写结构化原因，且必须显式 resume 才会再次推进。
  const settleRun = (runId) => {
    const runRow = one('SELECT status,pause_reason FROM workflow_runs WHERE id=?', runId)
    if (!runRow) throw fail('run_not_found')
    if (CLOSED_RUN_STATES.includes(runRow.status)) return runRow.status
    const items = publishItemsFor(runId)
    const blocked = items.find((item) => REQUIRED_PUBLISH_BLOCKED.includes(item.status))
    // 暂停中的运行不自动推进，但要跟着发布结果更新结构化原因：
    // 换了阻塞形态就改原因；阻塞已解除则清空原因、等用户显式 continue（01 §暂停语义）。
    if (runRow.status === 'paused') {
      const publishPaused = Object.values(PUBLISH_PAUSE_REASON).includes(runRow.pause_reason)
      if (!publishPaused) return 'paused'
      if (blocked) {
        if (runRow.pause_reason !== PUBLISH_PAUSE_REASON[blocked.status]) {
          setRunStatus(runId, 'paused', PUBLISH_PAUSE_REASON[blocked.status])
          event(runId, 'run.publish_blocked', { outboxId: blocked.id, target: blocked.target, status: blocked.status })
        }
        return 'paused'
      }
      setRunStatus(runId, 'paused', null)
      event(runId, 'run.publish_resolved', { awaiting: 'explicit_resume' })
      return 'paused'
    }
    const openSteps = Number(one(`SELECT COUNT(*) AS n FROM workflow_steps WHERE run_id=? AND state IN (${OPEN_STEP_STATES.map(() => '?').join(',')})`, runId, ...OPEN_STEP_STATES).n)
    if (blocked) {
      setRunStatus(runId, 'paused', PUBLISH_PAUSE_REASON[blocked.status])
      event(runId, 'run.publish_blocked', { outboxId: blocked.id, target: blocked.target, status: blocked.status })
      return 'paused'
    }
    const unsettled = items.find((item) => REQUIRED_PUBLISH_OPEN.includes(item.status))
    if (openSteps === 0 && !unsettled) {
      setRunStatus(runId, 'completed', null)
      event(runId, 'run.completed', { publishes: items.length })
      return 'completed'
    }
    // 步骤都已采用但必需发布还没完成：保持进行中，不能提前记成功。
    if (openSteps === 0) return runRow.status === 'created' ? (setRunStatus(runId, 'running'), 'running') : runRow.status
    // 等待状态只看是否真的还有未终结的人工待办：确认后必须回到 running。
    const openTasks = Number(one("SELECT COUNT(*) AS n FROM workflow_human_tasks WHERE status='open' AND step_id IN (SELECT id FROM workflow_steps WHERE run_id=?)", runId).n)
    if (openTasks > 0) {
      if (runRow.status !== 'waiting_review') setRunStatus(runId, 'waiting_review', null)
      return 'waiting_review'
    }
    if (runRow.status === 'created' || runRow.status === 'waiting_review') { setRunStatus(runId, 'running', null); return 'running' }
    return runRow.status
  }

  const createRun = ({ id, human = false, input = { fixture: true }, steps = null, inputSchema = null, productId = null, definitionVersion = 1, contextCapture = null, fork = null, idempotencyKey = `create:${id}` }) => transaction(() => request('run', id, { id, human, input, steps, inputSchema, productId, definitionVersion, contextCapture, fork }, () => {
    if (one('SELECT id FROM workflow_runs WHERE id=?', id)) throw fail('run_exists')
    // schema 本身写坏属于装配错误，建 run 时就拒，别等到领取时才发现（A10）。
    // 这里连方言一起校验：不认识的关键字（例如 minimum 之外自造的写法）必须当场失败，
    // 否则会变成「有约束的假象」，输入边界实际没生效。
    if (inputSchema !== null) validateInputSchemaDefinition(inputSchema)
    const t = now()
    run('INSERT INTO workflow_runs(id,status,revision,budget_total,budget_used,pause_reason,created_at,updated_at,input_schema) VALUES(?,?,?,?,?,?,?,?,?)', id, 'created', 1, 900, 0, null, t, t, inputSchema === null ? null : json(inputSchema))
    const definitions = steps ?? [{ nodeId: human ? 'human.edit-confirm' : 'fake.transform', nodeKind: human ? 'human' : 'automatic' }]
    if (!Array.isArray(definitions) || definitions.length === 0) throw fail('run_steps_required')
    if (new Set(definitions.map(item => item.nodeId)).size !== definitions.length) throw fail('definition_invalid')
    const graphDefinition = definitions.some(node => node.dependencies !== undefined)
    const preceding = new Set()
    for (const node of definitions) {
      if (typeof node.nodeId !== 'string' || !node.nodeId || !['automatic', 'human'].includes(node.nodeKind ?? 'automatic')) throw fail('definition_invalid')
      if (graphDefinition && (!Array.isArray(node.dependencies) || node.dependencies.some(dep => !dep || !preceding.has(dep.nodeId) || typeof dep.fromPort !== 'string' || !dep.fromPort || typeof dep.toPort !== 'string' || !dep.toPort) || new Set(node.dependencies.map(dep => dep.toPort)).size !== node.dependencies.length)) throw fail('definition_invalid', 'invalid_dependencies')
      if (node.nodeKind === 'human' && node.dependencies?.length > 1) throw fail('human_output_mapping_required')
      if (node.portPayloads !== undefined && node.portPayloads !== 'check-v1') throw fail('definition_invalid', 'invalid_port_payloads')
      if (node.joinPolicy !== undefined && (!['any', 'all'].includes(node.joinPolicy) || node.nodeKind === 'human')) throw fail('definition_invalid', 'invalid_join_policy')
      preceding.add(node.nodeId)
      validateFakeCapability(node)
      if (node.inputMapping !== undefined) {
        if (node.nodeKind !== 'human') throw fail('human_output_mapping_required')
        validateHumanInputMapping(node.inputMapping)
      }
      // Missing legacy declarations remain distinguishable from an explicit empty list.
      // Unknown names are retained: the evaluator must report not_assessed, never infer pass.
      if (node.requiredChecks !== undefined) {
        if (!Array.isArray(node.requiredChecks) || node.requiredChecks.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 128) || new Set(node.requiredChecks).size !== node.requiredChecks.length) throw fail('validation_checks_invalid')
      }
      if (node.outputs !== undefined) {
        if (!Array.isArray(node.outputs) || node.outputs.length === 0 || node.outputs.some(output => !output || typeof output.name !== 'string' || !output.name || !ARTIFACT_TYPES.includes(output.artifactType) || typeof output.editable !== 'boolean' || !Number.isSafeInteger(output.schemaVersion) || output.schemaVersion < 1)) throw fail('output_contract_invalid')
        validateOutputDeclarations(node.outputs)
      }
      if (node.publishTargets !== undefined) {
        const fileSetNode = node.outputs?.some(output => output.artifactType === 'file-set') === true
        if (!Array.isArray(node.publishTargets) || node.publishTargets.some(item => !item || typeof item.target !== 'string' || !item.target || typeof item.required !== 'boolean' || (fileSetNode ? typeof item.relativePath !== 'string' || !item.relativePath : item.relativePath !== undefined))) throw fail('publish_declaration_invalid')
        if (new Set(node.publishTargets.map(item => `${item.target}\u0000${item.relativePath ?? ''}`)).size !== node.publishTargets.length) throw fail('publish_declaration_invalid')
      }
    }
    const definition = { version: definitionVersion, input, inputSchema, steps: definitions, contextCapture }
    run('INSERT INTO workflow_run_definitions VALUES(?,?,?,?,?)', id, json(definition), hash(definition), productId, fork === null ? null : json(fork))
    definitions.forEach((definition, index) => run('INSERT INTO workflow_steps VALUES(?,?,?,?,?,?,?,?)', `${id}:step:${index + 1}`, id, definition.nodeId, definition.nodeKind ?? 'automatic', 'pending', 1, null, 0))
    event(id, 'run.created', { human, stepCount: definitions.length })
    return { operationId: `op:${id}`, runId: id, stepCount: definitions.length }
  }))

  const claim = (runId, input = { fixture: true }) => {
    try {
      return claimTx(runId, input)
    } catch (error) {
      // 被拒的领取本身要留证据：事件写在做回滚的事务之外，所以只记一条、不改运行状态。
      if (error?.code === INPUT_SCHEMA_INVALID && one('SELECT id FROM workflow_runs WHERE id=?', runId)) {
        try { event(runId, 'input.rejected', { code: error.code, detail: error.message }) } catch {}
      }
      throw error
    }
  }

  const claimTx = (runId, input = { fixture: true }) => transaction(() => {
    const runRow = one('SELECT * FROM workflow_runs WHERE id=?', runId)
    if (!runRow) throw fail('run_not_found')
    if (CLOSED_RUN_STATES.includes(runRow.status)) throw fail('run_not_claimable')
    // 暂停是显式意图：只能由 resume 解除，claim 不得自己把 run 拉回 running（A36）。
    if (runRow.status === 'paused') throw fail('run_paused')
    // 有待确认的人工待办时，不能越过它去领取后续步骤。
    if (runRow.status === 'waiting_review') throw fail('run_waiting_review')
    // A10：输入 schema 在领取之前判，失败就停在原地——不扣预算、不建 Attempt、不建人工待办，
    // 也不做租约回收：一次被拒的领取不该顺手改动任何运行状态。
    validateInputSchema(runRow.input_schema ? parse(runRow.input_schema) : null, input)
    reapExpiredLeases(runId)
    // 线性调度：只看链条上最前面尚未完成的一步。前面还在途/等待时不得越过它领取后继步骤，
    // 否则同一 run 会并行派发两个步骤（CTX-06 的无双派发要求）。
    const step = one(`SELECT * FROM workflow_steps WHERE run_id=? AND state NOT IN ('succeeded','cancelled','skipped') ORDER BY rowid LIMIT 1`, runId)
    if (!step || !CLAIMABLE_STEP_STATES.includes(step.state)) throw fail('step_not_claimable')
    chargeBudget(runId)

    if (step.node_kind === 'human') {
      cas('UPDATE workflow_steps SET state=?,stale=0,revision=revision+1 WHERE id=? AND revision=?', ['waiting_review', step.id, step.revision])
      setRunStatus(runId, 'waiting_review')
      const inputHash = hash(input)
      const existing = one('SELECT * FROM workflow_human_tasks WHERE step_id=? AND input_hash=?', step.id, inputHash)
      const taskId = existing?.id ?? `${step.run_id}:human:${step.id}:${inputHash}`
      if (!existing) {
        run('INSERT INTO workflow_human_tasks VALUES(?,?,?,?,?,?,?,?)', taskId, step.id, inputHash, 1, null, 'open', null, null)
        freezeInputs(taskId, 1, captureInputs(step))
        event(runId, 'human.task.created', { inputHash, taskId })
      } else if (existing.status !== 'open') {
        // 上游变更等原因搁置过的待办，重新领取时以新修订重开；draft_id 留着，
        // 编辑者能接着上次的草稿继续（A36：旧基准被拒不能连草稿一起丢）。
        cas('UPDATE workflow_human_tasks SET status=?,task_revision=task_revision+1,confirmed_by=NULL,confirmed_at=NULL WHERE id=? AND task_revision=?', ['open', taskId, existing.task_revision])
        freezeInputs(taskId, existing.task_revision + 1, captureInputs(step))
        event(runId, 'human.task.reopened', { inputHash, taskId, previousStatus: existing.status, draftId: existing.draft_id, taskRevision: existing.task_revision + 1 })
      } else {
        event(runId, 'human.task.awaited', { inputHash, taskId, taskRevision: existing.task_revision })
      }
      return { kind: 'human', taskId }
    }

    const attemptNo = Number(one('SELECT COALESCE(MAX(attempt_no),0) AS n FROM workflow_attempts WHERE step_id=?', step.id).n) + 1
    const attemptId = `${step.id}:attempt:${attemptNo}`
    const token = hash(`${attemptId}:${Math.random()}`)
    const inputs = captureInputs(step)
    freezeInputs(attemptId, step.revision, inputs)
    run('INSERT INTO workflow_attempts VALUES(?,?,?,?,?,?,?,?,?)', attemptId, step.id, attemptNo, token, new Date(Date.now() + DEFAULT_LEASE_MS).toISOString(), 'running', hash({ declared: input, inputs }), null, null)
    cas('UPDATE workflow_steps SET state=?,stale=0,revision=revision+1 WHERE id=? AND revision=?', ['running', step.id, step.revision])
    setRunStatus(runId, 'running')
    event(runId, 'attempt.claimed', { attemptId })
    return { kind: 'automatic', attemptId, token }
  })

  const skipConditionalStep = (runId, nodeId) => transaction(() => {
    const current = one('SELECT * FROM workflow_runs WHERE id=?', runId)
    if (!current || !['created', 'running'].includes(current.status)) throw fail('run_not_claimable')
    const step = one("SELECT * FROM workflow_steps WHERE run_id=? AND state NOT IN ('succeeded','cancelled','skipped') ORDER BY rowid LIMIT 1", runId)
    if (!step || step.node_id !== nodeId || !CLAIMABLE_STEP_STATES.includes(step.state)) throw fail('step_not_claimable')
    const dependencies = dependenciesOf(step)
    if (!dependencies?.length) throw fail('conditional_skip_invalid')
    const inactive = []
    for (const dep of dependencies) {
      const upstream = one('SELECT * FROM workflow_steps WHERE run_id=? AND node_id=?', runId, dep.nodeId)
      if (upstream?.state === 'skipped') { inactive.push(dep.nodeId + ':' + dep.fromPort); continue }
      if (upstream?.state !== 'succeeded' || upstream.stale || !upstream.current_adoption_id) throw fail('dependency_not_ready', dep.nodeId)
      const adoption = one('SELECT snapshot_id FROM workflow_adoptions WHERE id=?', upstream.current_adoption_id)
      const snapshot = readSnapshot(adoption.snapshot_id)
      const source = definitionFor(runId).steps.find(item => item.nodeId === dep.nodeId)
      if (source?.portPayloads === 'check-v1') {
        if (dep.fromPort !== activeConditionalPort(snapshot.content)) inactive.push(dep.nodeId + ':' + dep.fromPort)
      }
    }
    if (!inactive.length || (joinsAny(step) && inactive.length !== dependencies.length)) throw fail('conditional_skip_invalid')
    cas("UPDATE workflow_steps SET state='skipped',stale=0,revision=revision+1 WHERE id=? AND revision=?", [step.id, step.revision])
    event(runId, 'step.skipped', { stepId: step.id, nodeId, inactive })
    const status = settleRun(runId)
    return { stepId: step.id, status, inactive }
  })

  // 显式重跑只在暂停且执行/发布已对账后开放；不篡改历史 Attempt。
  const rerunStep = ({ stepId, expectedRunRevision, expectedStepRevision }) => transaction(() => {
    const step = one('SELECT * FROM workflow_steps WHERE id=?', stepId)
    if (!step) throw fail('step_not_found')
    const current = one('SELECT * FROM workflow_runs WHERE id=?', step.run_id)
    if (CLOSED_RUN_STATES.includes(current.status)) throw fail('run_closed')
    if (current.revision !== expectedRunRevision || step.revision !== expectedStepRevision) throw fail('cas_conflict')
    if (current.status !== 'paused') throw fail('run_not_paused')
    const attempts = all('SELECT a.status,a.lease_until FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=?', step.run_id)
    if (attempts.some(a => a.status === 'unknown')) throw fail('attempt_outcome_unknown')
    if (attempts.some(a => a.status === 'running' && Date.parse(a.lease_until) <= Date.now())) throw fail('attempt_lease_expired')
    if (attempts.some(a => a.status === 'running')) throw fail('attempt_in_flight')
    if (publishItemsFor(step.run_id, false).some(item => ['running', 'outcome_unknown', 'failed', 'conflict'].includes(item.status))) throw fail('publish_unresolved')
    if (step.state !== 'succeeded' || !step.current_adoption_id) throw fail('step_not_adopted')
    cas('UPDATE workflow_steps SET state=?,stale=1,revision=revision+1 WHERE id=? AND revision=?', ['stale', stepId, expectedStepRevision])
    // 尚未派发的旧发布不应在重跑期间落地；运行中/未知项已在上方拒绝。
    const affected = new Set([stepId, ...descendantsOf(step).map(row => row.id)])
    const supersededOutboxIds = all("SELECT o.id,s.id AS step_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE o.status='pending' AND s.run_id=? ORDER BY o.rowid", step.run_id).filter(row => affected.has(row.step_id)).map(item => item.id)
    for (const id of supersededOutboxIds) run("UPDATE workflow_outbox SET status='superseded',reason='step_rerun',updated_at=? WHERE id=? AND status='pending'", now(), id)
    const downstream = markDownstreamStale(step)
    setRunStatus(step.run_id, 'paused', 'step_rerun')
    event(step.run_id, 'step.rerun_requested', { stepId, downstream, supersededOutboxIds })
    return { stepId, revision: expectedStepRevision + 1 }
  })

  const restoreAdoption = ({ stepId, sourceAdoptionId, actorId, reason, expectedRunRevision, expectedStepRevision, publishTargets, idempotencyKey }) => transaction(() => {
    if (!actorId || typeof reason !== 'string' || !reason.trim() || !idempotencyKey) throw fail('restore_identity_required')
    return request(`restore:${stepId}`, idempotencyKey, { sourceAdoptionId, actorId, reason, expectedRunRevision, expectedStepRevision }, () => {
      const step = one('SELECT * FROM workflow_steps WHERE id=?', stepId)
      if (!step) throw fail('step_not_found')
      const source = one('SELECT * FROM workflow_adoptions WHERE id=? AND step_id=?', sourceAdoptionId, stepId)
      if (!source) throw fail('adoption_not_found')
      const snapshot = readSnapshot(source.snapshot_id)
      validateTargets(stepId, publishTargets, snapshot.outputSet)
      const historical = all('SELECT target,required,relative_path FROM workflow_outbox WHERE adoption_id=?', sourceAdoptionId).map(item => ({ target: item.target, required: Boolean(item.required), ...(item.relative_path !== null ? { relativePath: item.relative_path } : {}) }))
      validateTargets(stepId, historical, snapshot.outputSet)
      for (const item of publishTargets) {
        if (!item.baseContentHash || !['raw_text', 'domain_revision', 'file_hash'].includes(item.targetKind)) throw fail('publish_observation_required')
        if (snapshot.outputSet) {
          const file = snapshot.outputSet.files.find(candidate => candidate.relativePath === item.relativePath)
          if (!file) throw fail('publish_declaration_mismatch')
          readOutputObject({ root, hash: file.hash, bytes: file.bytes })
        }
      }
      // 重跑前置门与失效传播共用一个事务；恢复追加采用，不改历史 Attempt/绑定。
      rerunStep({ stepId, expectedRunRevision, expectedStepRevision })
      const adoptionId = `${stepId}:adoption:${expectedStepRevision + 2}`
      run('INSERT INTO workflow_adoptions VALUES(?,?,?,?,?,?,?)', adoptionId, stepId, source.snapshot_id, 'human', step.current_adoption_id, reason, now())
      cas('UPDATE workflow_steps SET state=?,stale=0,revision=revision+1,current_adoption_id=? WHERE id=? AND revision=?', ['succeeded', adoptionId, stepId, expectedStepRevision + 1])
      const outboxIds = enqueueTargets(adoptionId, snapshot.contentHash, publishTargets, snapshot.outputSet, { content: snapshot.content })
      event(step.run_id, 'adoption.restored', { adoptionId, sourceAdoptionId, actorId, reason, outboxIds })
      return { operationId: adoptionId, adoptionId, snapshotId: source.snapshot_id, outboxIds }
    })
  })

  const forkRun = ({ sourceRunId, id, actorId, reason, expectedRunRevision, idempotencyKey }) => transaction(() => {
    if (!actorId || typeof reason !== 'string' || !reason.trim() || !idempotencyKey || typeof id !== 'string' || !id) throw fail('fork_identity_required')
    return request(`fork:${sourceRunId}`, idempotencyKey, { id, actorId, reason, expectedRunRevision }, () => {
      const source = one('SELECT * FROM workflow_runs WHERE id=?', sourceRunId)
      if (!source) throw fail('run_not_found')
      if (!CLOSED_RUN_STATES.includes(source.status)) throw fail('fork_requires_closed_run')
      if (source.revision !== expectedRunRevision) throw fail('cas_conflict')
      if (publishItemsFor(sourceRunId, false).some(item => ['running', 'outcome_unknown'].includes(item.status))) throw fail('publish_unresolved')
      if (one("SELECT a.id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? AND a.status IN ('running','unknown')", sourceRunId)) throw fail('attempt_outcome_unknown')
      const definition = definitionFor(sourceRunId)
      const sourceSteps = all('SELECT * FROM workflow_steps WHERE run_id=? ORDER BY rowid', sourceRunId)
      for (const step of sourceSteps) targetsFor(step.id)
      const origins = sourceSteps.filter(step => step.current_adoption_id).map(step => {
        const adopted = one('SELECT * FROM workflow_adoptions WHERE id=?', step.current_adoption_id)
        readSnapshot(adopted.snapshot_id)
        return { nodeId: step.node_id, adoptionId: adopted.id, snapshotId: adopted.snapshot_id }
      })
      const productId = one('SELECT product_id FROM workflow_run_definitions WHERE run_id=?', sourceRunId).product_id
      const fork = { sourceRunId, sourceRevision: source.revision, actorId, reason, origins }
      // 首期分支重新执行全部步骤，历史仅作可追溯来源，不冒充新运行的已采用输入。
      const created = createRun({ id, steps: definition.steps, input: definition.input, inputSchema: definition.inputSchema, definitionVersion: definition.version, contextCapture: definition.contextCapture ?? null, productId, fork })
      event(id, 'run.forked', fork)
      return { ...created, sourceRunId }
    })
  })

  const compareSnapshots = (leftId, rightId) => {
    const left = readSnapshot(leftId)
    const right = readSnapshot(rightId)
    if (left.outputSet || right.outputSet) {
      const oldFiles = new Map((left.outputSet?.files ?? []).map(file => [file.relativePath, file]))
      const newFiles = new Map((right.outputSet?.files ?? []).map(file => [file.relativePath, file]))
      const files = []
      for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
        const before = oldFiles.get(path) ?? null, after = newFiles.get(path) ?? null
        if (json(before) === json(after)) continue
        files.push({ path, change: !before ? 'added' : !after ? 'removed' : before.hash !== after.hash ? 'content_changed' : 'metadata_changed', before, after })
      }
      return {
        leftId, rightId, kind: 'output-set', equal: left.contentHash === right.contentHash,
        leftHash: left.contentHash, rightHash: right.contentHash,
        typeChanged: Boolean(left.outputSet) !== Boolean(right.outputSet), files,
        outputsChanged: json(left.outputSet?.outputs ?? null) !== json(right.outputSet?.outputs ?? null),
        beforeOutputs: left.outputSet?.outputs ?? null, afterOutputs: right.outputSet?.outputs ?? null,
        changes: [], fields: null,
      }
    }
    const a = left.content.split('\n'), b = right.content.split('\n')
    const changes = []
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      if (a[index] !== b[index]) changes.push({ line: index + 1, before: a[index] ?? null, after: b[index] ?? null })
    }
    let fields = null
    const leftRow = one('SELECT artifact_type FROM workflow_snapshots WHERE id=?', leftId)
    const rightRow = one('SELECT artifact_type FROM workflow_snapshots WHERE id=?', rightId)
    if (leftRow.artifact_type === 'json' && rightRow.artifact_type === 'json') {
      fields = []
      const walk = (before, after, path = '$') => {
        if (JSON.stringify(before) === JSON.stringify(after)) return
        if (Array.isArray(before) && Array.isArray(after)) {
          const keyed = values => values.every(item => item && typeof item === 'object' && (typeof item.id === 'string' || typeof item.id === 'number')) && new Set(values.map(item => String(item.id))).size === values.length
          if (keyed(before) && keyed(after)) {
            const oldItems = new Map(before.map(item => [String(item.id), item]))
            const newItems = new Map(after.map(item => [String(item.id), item]))
            for (const id of [...new Set([...oldItems.keys(), ...newItems.keys()])].sort()) walk(oldItems.get(id), newItems.get(id), `${path}[id=${JSON.stringify(id)}]`)
            const oldOrder = before.map(item => String(item.id)), newOrder = after.map(item => String(item.id))
            if (json(oldOrder) !== json(newOrder)) fields.push({ path: `${path}.$order`, before: oldOrder, after: newOrder, beforePresent: true, afterPresent: true })
          } else {
            for (let index = 0; index < Math.max(before.length, after.length); index++) walk(before[index], after[index], `${path}[${index}]`)
          }
        } else if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
          for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) walk(before[key], after[key], `${path}.${key}`)
        } else fields.push({ path, before: before ?? null, after: after ?? null, beforePresent: before !== undefined, afterPresent: after !== undefined })
      }
      try { walk(JSON.parse(left.content), JSON.parse(right.content)) } catch { throw fail('snapshot_json_invalid') }
    }
    return { leftId, rightId, equal: left.contentHash === right.contentHash, leftHash: left.contentHash, rightHash: right.contentHash, changes, fields }
  }

  const storeCandidate = ({ attemptId, token, content, artifactType = 'text' }) => {
    const attempt = one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt || attempt.token !== token || attempt.status !== 'running') throw fail('attempt_token_invalid')
    if (!ARTIFACT_TYPES.includes(artifactType)) throw fail('artifact_type_invalid')
    const step = one('SELECT run_id,node_id FROM workflow_steps WHERE id=?', attempt.step_id)
    if (one('SELECT run_id FROM workflow_run_definitions WHERE run_id=?', step.run_id)) {
      const node = definitionFor(step.run_id).steps.find(item => item.nodeId === step.node_id)
      // The scalar entry can represent exactly one declared output. A matching
      // type alone must not allow a partial multi-output set to be adopted.
      if (node?.outputs && (node.outputs.length !== 1 || node.outputs[0].artifactType !== artifactType)) throw fail('output_contract_mismatch')
    }
    if (typeof content !== 'string') throw fail('artifact_content_invalid')
    if (artifactType === 'json') {
      try { JSON.parse(content) } catch { throw fail('artifact_json_invalid') }
    }
    const binding = inputBindingFor(attemptId)
    const contentHash = hash(content)
    const safe = fileSafe(attemptId)
    const stored = putOutputObject({ root, bytes: content })
    if (stored.hash !== contentHash) throw fail('artifact_content_hash_mismatch')
    const object = join(root, stored.key)
    const mediaType = artifactType === 'json' ? 'application/json' : artifactType === 'markdown' ? 'text/markdown' : 'text/plain'
    const manifest = {
      snapshotId: `${attemptId}:snapshot`, artifactType, contentHash, bytes: Buffer.byteLength(content), relativePath: object,
      sourceAttemptId: attemptId, inputSnapshotIds: binding.inputs.map(input => input.snapshotId),
      blobs: [{ relativePath: `objects/${contentHash.slice(0, 2)}/${contentHash}`, hash: contentHash, bytes: Buffer.byteLength(content), mediaType }],
    }
    const manifestHash = hash(manifest)
    const manifestPath = join(root, 'manifests', `${safe}.json`)
    writeCandidateManifest(manifestPath, manifest)
    return { snapshotId: manifest.snapshotId, contentHash, manifestHash, content }
  }

  const storeOutputSetCandidate = ({ attemptId, token, instances, files, contents }) => {
    const attempt = one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt || attempt.token !== token || attempt.status !== 'running') throw fail('attempt_token_invalid')
    const step = one('SELECT run_id,node_id FROM workflow_steps WHERE id=?', attempt.step_id)
    const node = definitionFor(step.run_id).steps.find(item => item.nodeId === step.node_id)
    if (!node?.outputs) throw fail('output_declaration_missing')
    const binding = inputBindingFor(attemptId)
    const stored = writeOutputSet({ root, instances, files, contents, declarations: node.outputs })
    // Descriptor bytes have their own content address; the set digest never
    // substitutes for a file-byte hash in legacy publication comparisons.
    const content = json(stored.set)
    const descriptor = putOutputObject({ root, bytes: content })
    const manifest = {
      snapshotId: `${attemptId}:snapshot`, artifactType: 'file-set',
      contentHash: descriptor.hash, bytes: Buffer.byteLength(content),
      relativePath: join(root, descriptor.key), sourceAttemptId: attemptId,
      inputSnapshotIds: binding.inputs.map(input => input.snapshotId),
      outputSet: stored.set, outputSetDigest: stored.set.digest,
      blobs: stored.blobs,
    }
    writeCandidateManifest(join(root, 'manifests', `${fileSafe(attemptId)}.json`), manifest)
    return { snapshotId: manifest.snapshotId, contentHash: descriptor.hash, manifestHash: hash(manifest), content }
  }

  const verifyCandidateSet = (manifest, attemptId, content) => {
    if (!manifest.outputSet) return null
    const step = one('SELECT s.run_id,s.node_id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE a.id=?', attemptId)
    if (!step) throw fail('attempt_not_found')
    const declarations = definitionFor(step.run_id).steps.find(node => node.nodeId === step.node_id)?.outputs
    if (!declarations) throw fail('output_declaration_missing')
    const verified = verifyOutputSet({ root, set: manifest.outputSet, declarations })
    const byHash = new Map()
    for (const file of verified.set.files) {
      if (!byHash.has(file.hash)) byHash.set(file.hash, {
        relativePath: `objects/${file.hash.slice(0, 2)}/${file.hash}`, hash: file.hash, bytes: file.bytes, mediaType: file.mediaType,
      })
    }
    const blobs = [...byHash.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    if (manifest.artifactType !== 'file-set' || manifest.outputSetDigest !== verified.digest || content !== json(verified.set) || json(manifest.blobs) !== json(blobs)) throw fail('output_set_manifest_mismatch')
    return verified.set
  }

  // 失败路径只清理本 Attempt 的未采用 manifest。内容寻址对象可能被其他在途
  // candidate 共用，不能仅凭快照行计数删除；未引用对象暂保留，离线 GC 尚未实现。
  const cleanupCandidate = (attemptId, candidate) => {
    if (!candidate?.contentHash) return
    const snapshotExists = one('SELECT COUNT(*) AS n FROM workflow_snapshots WHERE source_attempt_id=?', attemptId).n
    if (Number(snapshotExists) === 0) {
      try {
        const manifestPath = join(root, 'manifests', `${fileSafe(attemptId)}.json`)
        const entry = lstatSync(manifestPath)
        if (entry.isSymbolicLink() || !entry.isFile()) return
        const manifest = readCandidateManifest(manifestPath)
        // A rejected or forged candidate must not remove a different durable one.
        if (manifest.snapshotId !== `${attemptId}:snapshot` || manifest.sourceAttemptId !== attemptId ||
            candidate.snapshotId !== manifest.snapshotId || candidate.manifestHash !== hash(manifest) ||
            candidate.contentHash !== manifest.contentHash) return
        unlinkSync(manifestPath)
      } catch {}
    }
  }

  const enqueueTargets = (adoptionId, contentHash, targets, outputSet = null, candidate = null) => {
    return targets.map((item, index) => {
      const { target, required = true, baseRevision = 1, baseContentHash = null, targetKind = null, relativePath = null } = item
      if (relativePath && targetKind !== 'file_hash') throw fail('publish_observation_required')
      const file = outputSet ? outputSet.files.find(candidate => candidate.relativePath === relativePath) : null
      if (outputSet && !file) throw fail('publish_declaration_mismatch', 'file_mapping_invalid')
      const expectedHash = file?.hash ?? contentHash
      const id = outputSet ? `${adoptionId}:publish:${hash(`${target}\u0000${relativePath}`).slice(0, 24)}` : `${adoptionId}:publish${index === 0 ? '' : `:${index + 1}`}`
      if (baseContentHash !== null && !/^[a-f0-9]{64}$/.test(baseContentHash)) throw fail('publish_observation_required')
      if (targetKind !== null && !['raw_text', 'domain_revision', 'file_hash'].includes(targetKind)) throw fail('publish_observation_required')
      run("UPDATE workflow_outbox SET status='superseded',reason='superseded_by_newer_adoption',updated_at=? WHERE target=? AND relative_path IS ? AND status='pending' AND adoption_id<>?", now(), target, relativePath, adoptionId)
      run("UPDATE workflow_outbox SET status='outcome_unknown',reason='superseded_while_running',updated_at=? WHERE target=? AND relative_path IS ? AND status='running' AND adoption_id<>?", now(), target, relativePath, adoptionId)
      run('INSERT INTO workflow_outbox(id,adoption_id,target,base_revision,status,required,reason,updated_at,created_at,base_hash,expected_hash,target_kind,relative_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, adoptionId, target, baseRevision, 'pending', required ? 1 : 0, null, now(), now(), baseContentHash, expectedHash, targetKind, relativePath)
      run('INSERT INTO workflow_publish_owners(target,outbox_id,adopted_at) VALUES(?,?,?) ON CONFLICT(target) DO UPDATE SET outbox_id=excluded.outbox_id,adopted_at=excluded.adopted_at', `${target}${relativePath ? `::${relativePath}` : ''}`, id, now())
      return id
    })
  }
  const validateTargets = (stepId, targets, outputSet = null) => {
    const declared = targetsFor(stepId)
    const signature = items => json(items.map(item => [item.target, item.required, item.relativePath ?? null]).sort((a, b) => `${a[0]}\u0000${a[2] ?? ''}`.localeCompare(`${b[0]}\u0000${b[2] ?? ''}`)))
    if (!Array.isArray(targets) || targets.some(item => !item || typeof item.target !== 'string' || typeof item.required !== 'boolean') || signature(declared) !== signature(targets)) throw fail('publish_declaration_mismatch')
    // Intermediate steps may explicitly declare no publication. Once publishing,
    // declarations must cover the whole adopted collection exactly once.
    if (outputSet && declared.length > 0) {
      const expected = outputSet.files.map(file => file.relativePath).sort()
      const actual = targets.map(item => item.relativePath).sort()
      if (json(expected) !== json(actual) || new Set(actual).size !== actual.length) throw fail('publish_declaration_mismatch', 'file_mapping_incomplete')
    }
    return targets
  }

  const adoptTx = ({ attemptId, token, candidate, actorType = 'system', expectedStepRevision = null, target = null, required = true, baseRevision = 1, baseContentHash = null, targetKind = null, publishTargets = null, intent = 'continue' }) => {
    const attempt = one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt || attempt.token !== token || attempt.status !== 'running') throw fail('attempt_token_invalid')
    if (Date.parse(attempt.lease_until) <= Date.now()) throw fail('lease_expired')
    const step = one('SELECT * FROM workflow_steps WHERE id=?', attempt.step_id)
    if (!step) throw fail('step_not_found')
    // 已取消/已完成/已失败的 run 一律不再接受采用（A07 反例：取消后的人工确认不能复活 run）。
    const runRow = one('SELECT * FROM workflow_runs WHERE id=?', step.run_id)
    if (!runRow) throw fail('run_not_found')
    if (CLOSED_RUN_STATES.includes(runRow.status)) throw fail('run_closed')
    // 上游变更后该步骤已 stale，旧结果不能落地并清掉 stale。
    if (Number(step.stale) === 1 || step.state === 'stale') throw fail('step_stale')
    if (!candidate?.snapshotId || !candidate.contentHash || !candidate.manifestHash || typeof candidate.content !== 'string') throw fail('candidate_manifest_required')
    const object = join(root, 'objects', candidate.contentHash.slice(0, 2), candidate.contentHash)
    const manifestPath = join(root, 'manifests', `${fileSafe(attemptId)}.json`)
    if (!existsSync(object) || !existsSync(manifestPath)) throw fail('candidate_not_durable')
    if (hash(candidate.content) !== candidate.contentHash) throw fail('candidate_content_mismatch')
    // manifest 必须和磁盘上的一致，否则说明落地后被改过。
    const onDisk = readCandidateManifest(manifestPath)
    if (onDisk.contentHash !== candidate.contentHash || hash(onDisk) !== candidate.manifestHash) throw fail('manifest_mismatch')
    if (onDisk.snapshotId !== candidate.snapshotId || candidate.snapshotId !== `${attemptId}:snapshot`) throw fail('candidate_identity_mismatch')
    const objectContent = readOutputObject({ root, hash: candidate.contentHash, bytes: onDisk.bytes }).toString('utf8')
    if (hash(objectContent) !== candidate.contentHash || Buffer.byteLength(objectContent) !== onDisk.bytes) throw fail('candidate_object_mismatch')
    const candidateSet = verifyCandidateSet(onDisk, attemptId, objectContent)
    const definition = definitionFor(step.run_id)
    const node = definition.steps.find(item => item.nodeId === step.node_id)
    if (!node) throw fail('definition_invalid', 'step_node_missing')
    if (node.portPayloads === 'check-v1') activeConditionalPort(objectContent)
    if ((step.node_kind ?? node.nodeKind) !== node.nodeKind) throw fail('definition_invalid', 'step_kind_mismatch')
    if (step.node_kind === 'automatic') {
      if (!Array.isArray(node?.requiredChecks)) throw fail('validation_definition_invalid', 'required_checks_required')
      const binding = inputBindingFor(attemptId)
      const report = validateDraft({
        ...(candidateSet ? { outputSet: candidateSet, contents: new Map(readOutputSet({ root, set: candidateSet }).files.map(file => [file.relativePath, file.data])) } : { content: objectContent, artifactType: onDisk.artifactType }),
        definition, inputSnapshotIds: binding.inputs.map(input => input.snapshotId), requiredChecks: node.requiredChecks,
        producedBy: 'm1-kernel', producedAt: now(),
      }, options.evaluateChecks)
      const verdict = assessValidationReport(report, { subject: report.subject, definitionDigest: definitionDigestFor(definition), inputSnapshotIds: binding.inputs.map(input => input.snapshotId), requiredChecks: node.requiredChecks })
      const saved = validationStore.save({ runId: step.run_id, stepId: step.id, attemptId, report })
      event(step.run_id, 'automatic.validation.created', { attemptId, stepId: step.id, reportId: saved.stored.id, status: report.status, requiredChecks: node.requiredChecks })
      if (!verdict.applicable || verdict.status !== 'pass') return { validationFailure: verdict.reasons.join(','), reportId: saved.stored.id, candidate, attemptId, token }
    }
    if (expectedStepRevision !== null && step.revision !== expectedStepRevision) throw fail('cas_conflict')

    const parentSnapshotId = parentSnapshotFor(step)
    run('INSERT INTO workflow_snapshots VALUES(?,?,?,?,?,?,?,?)', candidate.snapshotId, onDisk.artifactType, candidate.contentHash, candidate.manifestHash, parentSnapshotId, attemptId, actorType, now())
    const adoptionId = `${step.id}:adoption:${step.revision + 1}`
    run('INSERT INTO workflow_adoptions VALUES(?,?,?,?,?,?,?)', adoptionId, step.id, candidate.snapshotId, actorType, step.current_adoption_id, actorType === 'human' ? 'human.edit-confirm' : 'validated', now())
    cas('UPDATE workflow_steps SET state=?,stale=0,revision=revision+1,current_adoption_id=? WHERE id=? AND revision=?', ['succeeded', adoptionId, step.id, step.revision])
    run('UPDATE workflow_attempts SET status=?,output_hash=?,outcome=? WHERE id=?', 'succeeded', candidate.contentHash, 'accepted', attemptId)

    // 旧夹具路径保留，但只有冻结声明的运行支持恢复和分支。
    const targets = publishTargets ?? (target ? [{ target, required, baseRevision, baseContentHash, targetKind }] : [])
    if (one('SELECT run_id FROM workflow_run_definitions WHERE run_id=?', step.run_id)) validateTargets(step.id, targets, candidateSet)
    if (onDisk.outputSet && targets.length) {
      for (const item of targets) {
        if (!item.baseContentHash || !['raw_text', 'domain_revision', 'file_hash'].includes(item.targetKind)) throw fail('publish_observation_required')
      }
    }
    const outboxIds = enqueueTargets(adoptionId, candidate.contentHash, targets, candidateSet, candidate)

    const staleSteps = markDownstreamStale(step)
    // 步骤全部采用也要等必需发布完成才算成功（A06/A11/A36）。
    // A36：确认并暂停时不做完成收敛——否则最后一步「确认并暂停」会被 settleRun 直接记成
    // completed，用户明确要求的暂停被吞掉。暂停与采用在同一事务里提交，之后只能显式 resume。
    let runStatus
    if (intent === 'pause') {
      const paused = pauseRun(step.run_id, 'user_paused')
      runStatus = paused.status
    } else {
      runStatus = settleRun(step.run_id)
    }
    event(step.run_id, 'adoption.created', { adoptionId, actorType, parentSnapshotId, staleSteps, runStatus, intent })
    return { operationId: adoptionId, adoptionId, snapshotId: candidate.snapshotId, outboxIds }
  }

  const adopt = (args) => {
    try {
      const result = transaction(() => adoptTx(args))
      if (result?.validationFailure) {
        markFailed(args.attemptId, 'automatic_validation_failed')
        const step = one('SELECT run_id,id FROM workflow_steps WHERE id=(SELECT step_id FROM workflow_attempts WHERE id=?)', args.attemptId)
        transaction(() => event(step.run_id, 'automatic.validation.blocked', { attemptId: args.attemptId, stepId: step.id, reportId: result.reportId, reason: result.validationFailure }))
        return { operationId: `validation:${result.reportId}`, status: 'failed', validationReportId: result.reportId, candidate: { snapshotId: result.candidate.snapshotId, contentHash: result.candidate.contentHash, manifestHash: result.candidate.manifestHash, artifactType: result.candidate.artifactType ?? null }, reason: result.validationFailure }
      }
      return result
    } catch (error) {
      // 无效凭据不得清理合法候选；事务回滚后重新读取所属 Attempt。
      try {
        const attempt = one('SELECT token FROM workflow_attempts WHERE id=?', args.attemptId)
        if (attempt && attempt.token === args.token) cleanupCandidate(args.attemptId, args.candidate)
      } catch {}
      throw error
    }
  }

  const assertBindingVersion = (taskId, expectedBindingVersion) => {
    const binding = inputBindingFor(taskId)
    if (!Number.isSafeInteger(expectedBindingVersion) || expectedBindingVersion !== binding.version) {
      throw fail('input_binding_stale', `expected=${expectedBindingVersion};actual=${binding.version}`)
    }
    return binding
  }

  const humanInputSource = (stepId, binding, { structureOnly = false } = {}) => {
    if (binding.inputs.length !== 1) throw fail('human_output_mapping_required')
    const snapshotId = binding.inputs[0].snapshotId
    const sourceRow = one('SELECT artifact_type FROM workflow_snapshots WHERE id=?', snapshotId)
    let source = structureOnly && sourceRow?.artifact_type === 'file-set'
      ? (() => { const { row, manifest, content } = verifySnapshot(snapshotId, { allowMissingOutputFiles: true }); return { snapshotId: row.id, artifactType: row.artifact_type, content, outputSet: manifest.outputSet ?? null } })()
      : readSnapshot(snapshotId)
    const step = one('SELECT * FROM workflow_steps WHERE id=?', stepId)
    const node = definitionFor(step.run_id).steps.find(item => item.nodeId === step.node_id)
    const input = binding.inputs[0]
    const upstream = definitionFor(step.run_id).steps.find(item => item.nodeId === input.nodeId)
    if (upstream?.portPayloads === 'check-v1') {
      const envelope = parse(source.content)
      if (input.fromPort !== activeConditionalPort(source.content)) throw fail('conditional_output_invalid')
      source = { ...source, content: input.fromPort === 'pass' ? envelope.input : json(envelope.report), artifactType: input.fromPort === 'pass' ? 'markdown' : 'report' }
    }
    if (!source.outputSet) {
      if (node.inputMapping !== undefined) throw fail('human_output_mapping_required')
      return source
    }
    const outputSet = mapHumanInputSet({ sourceSet: source.outputSet, outputs: node.outputs, inputMapping: node.inputMapping })
    return { ...source, outputSet, content: json(outputSet) }
  }

  // A single frozen upstream collection may carry multiple named instances.
  const humanOutputType = (stepId, binding, content, { structureOnly = false } = {}) => {
    const step = one('SELECT * FROM workflow_steps WHERE id=?', stepId)
    const outputs = definitionFor(step.run_id).steps.find(node => node.nodeId === step.node_id)?.outputs
    const source = binding.inputs.length ? humanInputSource(stepId, binding, { structureOnly }) : null
    if (source?.outputSet) {
      if (binding.inputs.length !== 1 || !outputs) throw fail("human_output_mapping_required")
      let proposed
      try { proposed = JSON.parse(content) } catch { throw fail("artifact_json_invalid") }
      if (structureOnly) assertNoInjectedObjectPaths(proposed.files)
      const set = structureOnly
        ? normalizeOutputSet({ instances: proposed.outputs, files: proposed.files, declarations: outputs })
        : verifyOutputSet({ root, set: proposed, declarations: outputs }).set
      if (structureOnly && proposed.digest !== set.digest) throw fail("output_set_digest_mismatch")
      const shape = set => set.outputs.map(item => ({ name: item.name, artifactType: item.artifactType, schemaVersion: item.schemaVersion, multiplicity: item.multiplicity })).sort((a, b) => json(a).localeCompare(json(b)))
      if (json(shape(set)) !== json(shape(source.outputSet))) throw fail('output_contract_mismatch')
      for (const declaration of outputs) {
        const originals = source.outputSet.outputs.filter(item => item.name === declaration.name)
        if (declaration.editable && originals.every(item => item.editable !== false)) continue
        const subset = value => {
          const instances = value.outputs.filter(item => item.name === declaration.name)
          const paths = new Set(instances.flatMap(item => item.files))
          return { instances: instances.map(item => ({ ...item, editable: false })), files: value.files.filter(file => paths.has(file.relativePath)) }
        }
        if (json(subset(set)) !== json(subset(source.outputSet))) throw fail('artifact_not_editable')
      }
      return { outputSet: set }
    }
    if (outputs && outputs.length !== 1) throw fail('human_output_mapping_required')
    const artifactType = source?.artifactType ?? outputs?.[0]?.artifactType ?? 'text'
    if (outputs && outputs[0].artifactType !== artifactType) throw fail('output_contract_mismatch')
    if (outputs?.[0]?.editable === false && (!source || content !== source.content)) throw fail('artifact_not_editable')
    return artifactType
  }

  // Separate transaction from confirmation: failed checks remain in report history.
  const validateHumanDraft = ({ taskId, content, expectedBindingVersion, expectedTaskRevision, producedBy = 'development-draft-validator' }) => {
    try { return transaction(() => {
    if (typeof content !== 'string') throw fail('artifact_content_invalid')
    const binding = assertBindingVersion(taskId, expectedBindingVersion)
    const task = one('SELECT * FROM workflow_human_tasks WHERE id=?', taskId)
    if (!task || task.status !== 'open') throw fail('human_task_unavailable')
    if (task.task_revision !== expectedTaskRevision) throw fail('cas_conflict')
    const step = one('SELECT * FROM workflow_steps WHERE id=?', task.step_id)
    const draft = task.draft_id ? one('SELECT snapshot_id FROM workflow_drafts WHERE id=?', task.draft_id) : null
    if (task.draft_id && (!draft || draft.snapshot_id !== `${taskId}:input:${binding.version}`)) throw fail('input_fingerprint_conflict')
    const definition = definitionFor(step.run_id)
    const node = definition.steps.find(item => item.nodeId === step.node_id)
    const kind = humanOutputType(step.id, binding, content, { structureOnly: true })
    const collection = kind?.outputSet ? readOutputSetTolerant({ root, set: kind.outputSet, declarations: node.outputs }) : null
    const report = validateDraft({
      ...(collection ? { outputSet: collection.set, contents: collection.contents, fileReadIssues: [...collection.missing, ...collection.corrupt] } : { content, artifactType: kind }),
      definition, inputSnapshotIds: binding.inputs.map(input => input.snapshotId), requiredChecks: node.requiredChecks,
      producedBy, producedAt: now(),
    }, options.evaluateChecks)
    const saved = validationStore.save({ runId: step.run_id, stepId: step.id, report })
    event(step.run_id, 'human.validation.created', { taskId, taskRevision: expectedTaskRevision, bindingVersion: binding.version, validationReportId: saved.stored.id, status: report.status })
    return saved.stored
    }) } catch (error) {
      // The failed transaction has rolled back. Record only verified ownership and
      // a bounded error code; never invent a content digest for invalid input.
      const owner = one('SELECT s.run_id FROM workflow_human_tasks t JOIN workflow_steps s ON s.id=t.step_id WHERE t.id=?', taskId)
      if (owner) {
        try {
          transaction(() => event(owner.run_id, 'human.validation.blocked', {
            taskId, requestedTaskRevision: expectedTaskRevision ?? null,
            requestedBindingVersion: expectedBindingVersion ?? null,
            stage: 'prepare_or_store', errorCode: String(error.code ?? 'validation_unavailable').slice(0, 128),
          }))
        } catch (recordError) {
          throw fail('validation_audit_failed', `${error.code ?? 'validation_unavailable'}:${recordError.code ?? 'event_write_failed'}`)
        }
      }
      throw error
    }
  }

  const saveDraft = ({ taskId, content, expectedBindingVersion, expectedTaskRevision = 1, rebind = false }) => transaction(() => {
    const binding = assertBindingVersion(taskId, expectedBindingVersion)
    const task = one('SELECT * FROM workflow_human_tasks WHERE id=?', taskId)
    if (!task || task.status !== 'open') throw fail('human_task_unavailable')
    if (task.task_revision !== expectedTaskRevision) throw fail('cas_conflict')
    const prior = task.draft_id ? one('SELECT * FROM workflow_drafts WHERE id=?', task.draft_id) : null
    if (task.draft_id && !prior) throw fail('artifact_missing')
    const changedBaseline = prior && prior.snapshot_id !== `${taskId}:input:${binding.version}`
    if (changedBaseline && rebind !== true) throw fail('input_fingerprint_conflict')
    humanOutputType(task.step_id, binding, content)
    const draftId = `${taskId}:draft:${expectedTaskRevision + 1}`
    run('INSERT INTO workflow_drafts VALUES(?,?,?,?,?)', draftId, `${taskId}:input:${binding.version}`, expectedTaskRevision + 1, content, 'open')
    cas('UPDATE workflow_human_tasks SET draft_id=?,task_revision=task_revision+1 WHERE id=? AND task_revision=?', [draftId, taskId, expectedTaskRevision])
    if (changedBaseline) event(one('SELECT run_id FROM workflow_steps WHERE id=?', task.step_id).run_id, 'human.draft.rebound', { taskId, previousDraftId: prior.id, draftId, bindingVersion: binding.version, taskRevision: expectedTaskRevision + 1 })
    return { draftId, revision: expectedTaskRevision + 1 }
  })

  // A revision candidate freezes the editor baseline without becoming a draft.
  const revisionContext = ({ taskId, expectedBindingVersion, expectedTaskRevision }) => {
    const binding = assertBindingVersion(taskId, expectedBindingVersion)
    const task = one('SELECT * FROM workflow_human_tasks WHERE id=?', taskId)
    if (!task || task.status !== 'open') throw fail('human_task_unavailable')
    if (task.task_revision !== expectedTaskRevision) throw fail('cas_conflict')
    const step = one('SELECT * FROM workflow_steps WHERE id=?', task.step_id)
    const owner = one('SELECT status FROM workflow_runs WHERE id=?', step.run_id)
    if (!owner || CLOSED_RUN_STATES.includes(owner.status) || step.state !== 'waiting_review') throw fail('human_task_unavailable')
    if (binding.inputs.length !== 1) throw fail('human_output_mapping_required')
    const source = humanInputSource(step.id, binding)
    const draft = task.draft_id ? one('SELECT * FROM workflow_drafts WHERE id=?', task.draft_id) : null
    if (task.draft_id && !draft) throw fail('artifact_missing')
    if (draft && draft.snapshot_id !== `${taskId}:input:${binding.version}`) throw fail('input_fingerprint_conflict')
    const content = draft?.content ?? source.content
    const kind = humanOutputType(step.id, binding, content)
    return { runId: step.run_id, stepId: step.id, taskId, taskRevision: task.task_revision, bindingVersion: binding.version,
      baseSnapshotId: source.snapshotId, baseDraftId: task.draft_id ?? null, baseContentHash: hash(content), content,
      outputSet: kind?.outputSet ?? null }
  }
  const beginRevisionRequest = ({ taskId, expectedBindingVersion, expectedTaskRevision }, operation) => transaction(() => {
    const context = revisionContext({ taskId, expectedBindingVersion, expectedTaskRevision })
    chargeBudget(context.runId)
    const result = operation(context)
    event(context.runId, 'human.revision.requested', { taskId, taskRevision: context.taskRevision, bindingVersion: context.bindingVersion, requestId: result.id })
    return result
  })

  const applyRevisionDraft = ({ baseline, content }, recordApplied) => transaction(() => {
    const current = revisionContext({ taskId: baseline.taskId, expectedBindingVersion: baseline.bindingVersion, expectedTaskRevision: baseline.taskRevision })
    if (current.baseSnapshotId !== baseline.baseSnapshotId || current.baseDraftId !== baseline.baseDraftId || current.baseContentHash !== baseline.baseContentHash) throw fail('input_binding_stale')
    const saved = saveDraft({ taskId: baseline.taskId, content, expectedBindingVersion: baseline.bindingVersion, expectedTaskRevision: baseline.taskRevision })
    recordApplied()
    event(current.runId, 'human.revision.applied', { taskId: baseline.taskId, draftId: saved.draftId })
    return saved
  })

  const readDraftFile = ({ taskId, relativePath, expectedBindingVersion, expectedTaskRevision }) => {
    const binding = assertBindingVersion(taskId, expectedBindingVersion)
    const task = one('SELECT * FROM workflow_human_tasks WHERE id=?', taskId)
    if (!task || task.status !== 'open') throw fail('human_task_unavailable')
    if (task.task_revision !== expectedTaskRevision) throw fail('cas_conflict')
    const source = humanInputSource(task.step_id, binding)
    if (!source?.outputSet) throw fail('output_set_required')
    const draft = task.draft_id ? one('SELECT * FROM workflow_drafts WHERE id=?', task.draft_id) : null
    if (draft && draft.snapshot_id !== `${taskId}:input:${binding.version}`) throw fail('input_fingerprint_conflict')
    const { outputSet } = humanOutputType(task.step_id, binding, draft?.content ?? source.content)
    const file = outputSet.files.find(item => item.relativePath === relativePath)
    if (!file) throw fail('output_file_missing')
    if (!(file.mediaType.startsWith('text/') || file.mediaType === 'application/json')) throw fail('artifact_binary_edit_unsupported')
    const data = readOutputObject({ root, hash: file.hash, bytes: file.bytes })
    const content = data.toString('utf8')
    if (!Buffer.from(content, 'utf8').equals(data)) throw fail('artifact_encoding_invalid')
    return { taskId, relativePath, content, contentHash: file.hash, taskRevision: task.task_revision, bindingVersion: binding.version }
  }

  const saveDraftFile = ({ taskId, relativePath, content, expectedBindingVersion, expectedTaskRevision = 1 }) => transaction(() => {
    const binding = assertBindingVersion(taskId, expectedBindingVersion)
    const task = one('SELECT * FROM workflow_human_tasks WHERE id=?', taskId)
    if (!task || task.status !== 'open') throw fail('human_task_unavailable')
    if (task.task_revision !== expectedTaskRevision) throw fail('cas_conflict')
    if (typeof content !== 'string') throw fail('artifact_content_invalid')
    const source = humanInputSource(task.step_id, binding)
    if (!source?.outputSet) throw fail('output_set_required')
    const draft = task.draft_id ? one('SELECT * FROM workflow_drafts WHERE id=?', task.draft_id) : null
    if (draft && draft.snapshot_id !== `${taskId}:input:${binding.version}`) throw fail('input_fingerprint_conflict')
    const baseline = draft?.content ?? source.content
    const { outputSet } = humanOutputType(task.step_id, binding, baseline)
    const original = outputSet.files.find(file => file.relativePath === relativePath)
    const owner = outputSet.outputs.find(output => output.files.includes(relativePath))
    if (!original || !owner) throw fail('output_file_missing')
    if (!owner.editable || source.outputSet.outputs.some(output => output.name === owner.name && !output.editable)) throw fail('artifact_not_editable')
    if (!(original.mediaType.startsWith('text/') || original.mediaType === 'application/json')) throw fail('artifact_binary_edit_unsupported')
    if (owner.artifactType === 'json' || original.mediaType === 'application/json') {
      try { JSON.parse(content) } catch { throw fail('artifact_json_invalid') }
    }
    const stored = putOutputObject({ root, bytes: content })
    const step = one('SELECT * FROM workflow_steps WHERE id=?', task.step_id)
    const declarations = definitionFor(step.run_id).steps.find(node => node.nodeId === step.node_id).outputs
    const set = normalizeOutputSet({ declarations, instances: outputSet.outputs, files: outputSet.files.map(file => file.relativePath === relativePath ? { ...file, hash: stored.hash, bytes: Buffer.byteLength(content) } : file) })
    return saveDraft({ taskId, content: json(set), expectedBindingVersion, expectedTaskRevision })
  })

  const confirmHuman = ({ taskId, content, actorId, expectedBindingVersion, inputFingerprint, expectedRunRevision, expectedAdoptionId = null, idempotencyKey = null, expectedTaskRevision = 1, target = null, required = true, baseRevision = 1, baseContentHash = null, targetKind = null, publishTargets = null, validationReportId = null, intent = 'continue' }) => {
    if (!actorId || typeof actorId !== 'string') throw fail('human_identity_required')
    // A10：控制意图属于输入，先校验再落任何状态；不接受未知值，也不做「默认继续」的正则兜底。
    if (!['continue', 'pause'].includes(intent)) throw fail(INPUT_SCHEMA_INVALID, 'intent:not_in_enum')
    const task = one('SELECT * FROM workflow_human_tasks WHERE id=?', taskId)
    if (!task) throw fail('human_task_not_found')
    const step = one('SELECT * FROM workflow_steps WHERE id=?', task.step_id)
    if (!step) throw fail('step_not_found')
    // A stale review cannot be revived by an old idempotency record.
    assertBindingVersion(taskId, expectedBindingVersion)
    const key = idempotencyKey ?? `confirm:${taskId}:${expectedTaskRevision}:${expectedBindingVersion}`
    const body = { taskId, content, actorId, expectedBindingVersion, inputFingerprint: inputFingerprint ?? null, expectedRunRevision: expectedRunRevision ?? null, expectedAdoptionId, expectedTaskRevision, validationReportId, intent }
    // 幂等键在状态校验之前生效：同一请求重放返回原采用，不会因为任务已确认而报错。
    let candidate = null
    const attemptId = `${taskId}:human-attempt:${expectedTaskRevision}`
    try {
      return request(`human:${taskId}`, key, body, () => transaction(() => {
        const current = one('SELECT * FROM workflow_human_tasks WHERE id=?', taskId)
        if (!current || current.task_revision !== expectedTaskRevision || current.status !== 'open') throw fail('cas_conflict')
        if (inputFingerprint !== undefined && inputFingerprint !== null && inputFingerprint !== current.input_hash) throw fail('input_fingerprint_conflict')
        const runRow = one('SELECT * FROM workflow_runs WHERE id=?', step.run_id)
        if (expectedRunRevision !== undefined && expectedRunRevision !== null && expectedRunRevision !== runRow.revision) throw fail('cas_conflict')
        if (expectedAdoptionId !== null && expectedAdoptionId !== step.current_adoption_id) throw fail('cas_conflict')
        const token = hash(`${attemptId}:${actorId}:${key}`)
        const attemptNo = Number(one('SELECT COALESCE(MAX(attempt_no),0) AS n FROM workflow_attempts WHERE step_id=?', task.step_id).n) + 1
        const binding = assertBindingVersion(taskId, expectedBindingVersion)
        if (current.draft_id) {
          const draft = one('SELECT snapshot_id FROM workflow_drafts WHERE id=?', current.draft_id)
          if (!draft || draft.snapshot_id !== `${taskId}:input:${binding.version}`) throw fail('input_fingerprint_conflict')
        }
        const artifactType = humanOutputType(task.step_id, binding, content)
        const definition = definitionFor(step.run_id)
        const node = definition.steps.find(item => item.nodeId === step.node_id)
        if (!Array.isArray(node?.requiredChecks)) throw fail('human_confirm_required', 'validation_declaration_missing')
        if (node.requiredChecks.length || validationReportId !== null) {
          if (typeof validationReportId !== 'string' || !validationReportId) throw fail('human_confirm_required', 'validation_report_required')
          try {
            const stored = validationStore.read(validationReportId)
            if (!stored || stored.runId !== step.run_id || stored.stepId !== step.id) throw new Error('validation_report_scope_mismatch')
            const subject = artifactType?.outputSet
              ? { artifactType: 'file-set', outputSetDigest: artifactType.outputSet.digest, files: artifactType.outputSet.files }
              : { artifactType, contentHash: hash(content) }
            assertValidationReport(stored.report, { subject, definitionDigest: definitionDigestFor(definition), inputSnapshotIds: binding.inputs.map(input => input.snapshotId), requiredChecks: node.requiredChecks })
          } catch (error) { throw fail('human_confirm_required', error.message) }
        }
        freezeInputs(attemptId, binding.version, binding.inputs)
        run('INSERT INTO workflow_attempts VALUES(?,?,?,?,?,?,?,?,?)', attemptId, task.step_id, attemptNo, token, new Date(Date.now() + DEFAULT_LEASE_MS).toISOString(), 'running', hash({ declaredHash: current.input_hash, inputs: binding.inputs }), null, null)
        cas('UPDATE workflow_human_tasks SET status=?,confirmed_by=?,confirmed_at=? WHERE id=? AND task_revision=?', ['confirmed', actorId, now(), taskId, expectedTaskRevision])
        candidate = artifactType?.outputSet
          ? storeOutputSetCandidate({ attemptId, token, instances: artifactType.outputSet.outputs, files: artifactType.outputSet.files, contents: null })
          : storeCandidate({ attemptId, token, content, artifactType })
        const adopted = adoptTx({ attemptId, token, candidate, actorType: 'human', expectedStepRevision: step.revision, target, required, baseRevision, baseContentHash, targetKind, publishTargets, intent })
        event(step.run_id, 'human.confirmed', { taskId, attemptId, adoptionId: adopted.adoptionId, snapshotId: adopted.snapshotId, actorId, taskRevision: expectedTaskRevision, bindingVersion: binding.version, validationReportId, requiredChecks: node.requiredChecks, intent })
        return adopted
      }))
    } catch (error) {
      // 事务回滚后清理本次未采用 manifest；共用内容对象保留，等待未来离线 GC。
      if (candidate) { try { cleanupCandidate(attemptId, candidate) } catch {} }
      throw error
    }
  }

  const heartbeatAttempt = ({ attemptId, token, leaseMs = DEFAULT_LEASE_MS }) => transaction(() => {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > DEFAULT_LEASE_MS) throw fail('lease_duration_invalid')
    const attempt = one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt || attempt.token !== token || attempt.status !== 'running') throw fail('attempt_token_invalid')
    if (Date.parse(attempt.lease_until) <= Date.now()) throw fail('lease_expired')
    const step = one('SELECT * FROM workflow_steps WHERE id=?', attempt.step_id)
    const current = one('SELECT status FROM workflow_runs WHERE id=?', step.run_id)
    if (CLOSED_RUN_STATES.includes(current.status) || step.stale || step.state !== 'running') throw fail('attempt_token_invalid')
    const leaseUntil = new Date(Math.max(Date.parse(attempt.lease_until), Date.now() + leaseMs)).toISOString()
    cas("UPDATE workflow_attempts SET lease_until=? WHERE id=? AND token=? AND status='running' AND lease_until=?", [leaseUntil, attemptId, token, attempt.lease_until])
    event(step.run_id, 'attempt.heartbeat', { attemptId, leaseUntil })
    return { attemptId, leaseUntil }
  })

  const markUnknown = (attemptId, reason = 'outcome_unknown') => transaction(() => {
    const attempt = one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt) throw fail('attempt_not_found')
    cas('UPDATE workflow_attempts SET status=?,outcome=? WHERE id=? AND status=?', ['unknown', reason, attemptId, 'running'])
    const runId = one('SELECT run_id FROM workflow_steps WHERE id=?', attempt.step_id).run_id
    setRunStatus(runId, 'paused', reason)
    event(runId, 'attempt.outcome_unknown', { attemptId, reason })
    return { attemptId, reason }
  })

  // 明确的执行失败：Attempt 终结、步骤退回可领取、运行暂停；恢复走 resume + 重新 claim。
  const markFailed = (attemptId, reason = 'executor_failed') => transaction(() => {
    const attempt = one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt) throw fail('attempt_not_found')
    cas('UPDATE workflow_attempts SET status=?,outcome=? WHERE id=? AND status=?', ['failed', reason, attemptId, 'running'])
    cas('UPDATE workflow_steps SET state=?,revision=revision+1 WHERE id=? AND state=?', ['paused', attempt.step_id, 'running'])
    const runId = one('SELECT run_id FROM workflow_steps WHERE id=?', attempt.step_id).run_id
    setRunStatus(runId, 'paused', reason)
    event(runId, 'attempt.failed', { attemptId, reason })
    return { attemptId, reason }
  })

  const reconcileUnknown = (attemptId, outcome) => transaction(() => {
    const attempt = one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt || attempt.status !== 'unknown') throw fail('unknown_not_reconcilable')
    const runId = one('SELECT run_id FROM workflow_steps WHERE id=?', attempt.step_id).run_id
    const runRow = one('SELECT status FROM workflow_runs WHERE id=?', runId)
    // 取消/完成后的未知结果只记账、绝不采用：迟到的成功不能复活终态运行（A07/A08）。
    if (runRow && CLOSED_RUN_STATES.includes(runRow.status)) {
      run("UPDATE workflow_attempts SET status='reconciled',outcome=? WHERE id=?", `${outcome}_run_closed`, attemptId)
      event(runId, 'attempt.reconciled_after_close', { attemptId, outcome, runStatus: runRow.status })
      return outcome
    }
    const executed = outcome !== 'not_executed'
    run('UPDATE workflow_attempts SET status=?,outcome=? WHERE id=?', executed ? 'succeeded' : 'reconciled', outcome, attemptId)
    if (executed) {
      // 已执行但没收到结果：采用已产出的对象，让流程继续。
      const produced = join(root, 'manifests', `${fileSafe(attemptId)}.json`)
      if (!existsSync(produced)) throw fail('reconcile_artifact_missing')
      const manifest = parse(readFileSync(produced, 'utf8'))
      const content = readFileSync(join(root, 'objects', manifest.contentHash.slice(0, 2), manifest.contentHash), 'utf8')
      const step = one('SELECT * FROM workflow_steps WHERE id=?', attempt.step_id)
      const token = attempt.token
      run("UPDATE workflow_attempts SET status='running' WHERE id=?", attemptId)
      adoptTx({ attemptId, token, candidate: { snapshotId: manifest.snapshotId, contentHash: manifest.contentHash, manifestHash: hash(manifest), content }, expectedStepRevision: step.revision })
    } else {
      cas('UPDATE workflow_steps SET state=?,revision=revision+1 WHERE id=? AND state=?', ['paused', attempt.step_id, 'running'])
      setRunStatus(runId, 'paused', 'reconciled_not_executed')
    }
    event(runId, 'attempt.reconciled', { attemptId, outcome })
    return outcome
  })

  const resume = (runId) => transaction(() => {
    const runRow = one('SELECT * FROM workflow_runs WHERE id=?', runId)
    if (!runRow || !['paused', 'waiting_review'].includes(runRow.status)) throw fail('run_not_resumable')
    // 用户继续前须先解决发布阻塞；未对账的未知结果不能靠 resume 越过。
    const blocked = publishItemsFor(runId).find((item) => REQUIRED_PUBLISH_BLOCKED.includes(item.status))
    if (blocked) throw fail('publish_unresolved')
    if (one("SELECT a.id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? AND a.status='unknown' LIMIT 1", runId)) throw fail('attempt_outcome_unknown')
    const placeholders = CLAIMABLE_STEP_STATES.map(() => '?').join(',')
    const step = one(`SELECT * FROM workflow_steps WHERE run_id=? AND state IN (${placeholders}) ORDER BY rowid LIMIT 1`, runId, ...CLAIMABLE_STEP_STATES)
    // 没有可领取步骤不等于不能继续：在途 Attempt 会自己结束，等待发布收敛也要靠显式继续收尾。
    setRunStatus(runId, 'created', null)
    // 继续后立刻按当前步骤/待办/发布收敛定状态，避免留下 created 中间态。
    const runStatus = settleRun(runId)
    event(runId, 'run.resumed', { stepId: step?.id ?? null, runStatus })
    return { runId, stepId: step?.id ?? null, status: runStatus }
  })

  const cancelRun = (runId) => transaction(() => {
    const runRow = one('SELECT * FROM workflow_runs WHERE id=?', runId)
    if (!runRow) throw fail('run_not_found')
    if (['completed', 'cancelled'].includes(runRow.status)) throw fail('run_not_cancellable')
    run("UPDATE workflow_steps SET state='cancelled', revision=revision+1 WHERE run_id=? AND state NOT IN ('succeeded','cancelled')", runId)
    run("UPDATE workflow_attempts SET status='cancelled', outcome='run_cancelled' WHERE status='running' AND step_id IN (SELECT id FROM workflow_steps WHERE run_id=?)", runId)
    // 待办一并终结：取消后不能再用旧任务确认并写回结果。
    run("UPDATE workflow_human_tasks SET status='cancelled' WHERE status='open' AND step_id IN (SELECT id FROM workflow_steps WHERE run_id=?)", runId)
    // 未领取的发布直接作废；已发起的不能假设撤销成功，转未知待对账（08 §发布对账）。
    const scope = 'adoption_id IN (SELECT a.id FROM workflow_adoptions a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=?)'
    run(`UPDATE workflow_outbox SET status='superseded',reason='run_cancelled',updated_at=? WHERE status='pending' AND ${scope}`, now(), runId)
    run(`UPDATE workflow_outbox SET status='outcome_unknown',reason='cancel_requested',updated_at=? WHERE status='running' AND ${scope}`, now(), runId)
    setRunStatus(runId, 'cancelled')
    event(runId, 'run.cancelled', {})
    return { runId, status: 'cancelled' }
  })

  // 同步假适配器领取；不提供跨进程目标写入的原子性保证。
  const claimOutbox = (id, { observe } = {}) => transaction(() => {
    const item = one('SELECT * FROM workflow_outbox WHERE id=?', id)
    if (!item) throw fail('outbox_not_found')
    if (item.status === 'running') throw fail('outbox_already_claimed')
    if (item.status !== 'pending') throw fail('outbox_not_claimable')
    const context = one('SELECT s.run_id, s.stale, s.current_adoption_id, r.status FROM workflow_adoptions a JOIN workflow_steps s ON s.id=a.step_id JOIN workflow_runs r ON r.id=s.run_id WHERE a.id=?', item.adoption_id)
    if (!context) throw fail('outbox_orphaned')
    if (CLOSED_RUN_STATES.includes(context.status)) throw fail('run_not_claimable')
    if (context.stale || context.current_adoption_id !== item.adoption_id) throw fail('outbox_superseded')
    // 显式接管记录与采用同事务提交；旧库缺记录时拒绝领取，不按物理行序猜测归属。
    const owner = one('SELECT outbox_id FROM workflow_publish_owners WHERE target=?', `${item.target}${item.relative_path ? `::${item.relative_path}` : ''}`)
    if (owner?.outbox_id !== item.id) throw fail('outbox_superseded')
    if (typeof observe !== 'function') throw fail('publish_observation_required')
    let observed
    try { observed = observe(item.target, item.relative_path ?? null) } catch (error) {
      throw fail('target_unavailable', error?.message ?? 'adapter_observation_failed')
    }
    if (!observed || observed.target !== item.target || !Number.isSafeInteger(observed.revision) || (item.relative_path && observed.relativePath !== item.relative_path)) throw fail('publish_observation_required')
    // 内容观测不能降级到 revision-only；无基准的旧记录须先迁移。
    if (item.relative_path && item.target_kind !== 'file_hash') throw fail('publish_observation_required')
    if (item.base_hash === null && observed.contentHash !== undefined) throw fail('publish_observation_required')
    // 旧的纯 revision 内核夹具待单独迁移，不算内容证据路径。
    if (item.base_hash !== null) {
      if (!['raw_text', 'domain_revision', 'file_hash'].includes(item.target_kind)) throw fail('publish_observation_required')
      if (typeof observed.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(observed.contentHash)) throw fail('publish_observation_required')
      if (observed.contentHash === item.expected_hash) {
        cas("UPDATE workflow_outbox SET status='succeeded',reason='already_applied',updated_at=? WHERE id=? AND status='pending'", [now(), id])
        const runStatus = settleRun(context.run_id)
        event(context.run_id, 'outbox.effect_already_applied', { outboxId: id, observedHash: observed.contentHash, observedRevision: observed.revision, observedAt: now() })
        return { outboxId: id, status: 'succeeded', effect: 'already_applied', claimGeneration: item.claim_generation, runStatus }
      }
      if (observed.contentHash !== item.base_hash) throw fail('publish_base_mismatch')
    }
    if (item.target_kind === 'domain_revision' && observed.revision !== item.base_revision) throw fail('publish_base_mismatch')
    const claimGeneration = item.claim_generation + 1
    if (!Number.isSafeInteger(claimGeneration) || claimGeneration < 1) throw fail('outbox_claim_mismatch')
    cas("UPDATE workflow_outbox SET status='running',claim_generation=?,updated_at=? WHERE id=? AND status='pending' AND claim_generation=?", [claimGeneration, now(), id, item.claim_generation])
    event(context.run_id, 'outbox.claimed', { outboxId: id, target: item.target, observedRevision: observed.revision, claimGeneration })
    return { outboxId: id, status: 'running', claimGeneration }
  })

  // 发布结果只由发布适配器/假发布回写：succeeded 才算完成，failed/conflict 让运行暂停，
  // outcome_unknown 必须先对账，不能重试了当成功（A08/A09）。
  const assertClaimGeneration = (item, claimGeneration) => {
    if (!Number.isSafeInteger(claimGeneration) || claimGeneration < 1 || claimGeneration !== item.claim_generation) throw fail('outbox_claim_mismatch')
  }
  const completeOutbox = (id, status, reason = null, claimGeneration) => transaction(() => {
    const item = one('SELECT * FROM workflow_outbox WHERE id=?', id)
    if (!item) throw fail('outbox_not_found')
    // 已领取后结果无效不能假定未执行；提交未知状态，供显式对账。
    if (!['succeeded', 'failed', 'conflict', 'outcome_unknown'].includes(status)) {
      reason = status === undefined ? 'publish_result_missing' : 'publish_result_invalid'
      status = 'outcome_unknown'
    }
    if (item.status === 'pending') throw fail('outbox_not_claimed')
    if (item.status !== 'running') throw fail('cas_conflict')
    assertClaimGeneration(item, claimGeneration)
    const runId = one('SELECT s.run_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE o.id=?', id)
    if (!runId) throw fail('outbox_orphaned')
    // 取消/已完成的运行不允许被发布回写改写状态。
    cas("UPDATE workflow_outbox SET status=?,reason=?,updated_at=? WHERE id=? AND status='running'", [status, reason, now(), id])
    const runStatus = settleRun(runId.run_id)
    event(runId.run_id, 'outbox.settled', { outboxId: id, status, runStatus })
    return { outboxId: id, status, runStatus }
  })
  // 显式声明未知只隔离在途发布，不重发；调用层负责把 actorId 绑定到授权身份。
  const markOutboxUnknown = (id, { actorId, reason, claimGeneration } = {}) => transaction(() => {
    if (typeof actorId !== 'string' || !actorId.trim()) throw fail('publish_actor_required')
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw fail('schema_invalid', 'publish_reason_required')
    const settled = completeOutbox(id, 'outcome_unknown', reason, claimGeneration)
    const context = one('SELECT s.run_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE o.id=?', id)
    const declaredAt = now()
    event(context.run_id, 'outbox.unknown_declared', { outboxId: id, claimGeneration, reason, actorId, declaredAt })
    return { ...settled, claimGeneration, declaredAt }
  })

  // 只读观测在事务内取得，状态与观测审计一起提交；不执行目标写入。
  const reconcilePublishEffect = (id, { actorId, claimGeneration, observe } = {}) => transaction(() => {
    const item = one('SELECT * FROM workflow_outbox WHERE id=?', id)
    if (!item) throw fail('outbox_not_found')
    if (item.status !== 'outcome_unknown') throw fail('outbox_not_reconcilable')
    assertClaimGeneration(item, claimGeneration)
    if (typeof actorId !== 'string' || !actorId.trim()) throw fail('publish_actor_required')
    if (!['raw_text', 'domain_revision', 'file_hash'].includes(item.target_kind) || !item.base_hash || !item.expected_hash || typeof observe !== 'function') throw fail('target_unavailable')
    let observed
    try { observed = observe(item.target, item.relative_path ?? null) } catch (error) { throw fail('target_unavailable', error?.message) }
    if (!observed || observed.target !== item.target || !Number.isSafeInteger(observed.revision) || (item.relative_path && observed.relativePath !== item.relative_path) || typeof observed.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(observed.contentHash)) throw fail('target_unavailable')
    const decision = observed.contentHash === item.expected_hash ? 'applied'
      : observed.contentHash === item.base_hash && (item.target_kind !== 'domain_revision' || observed.revision === item.base_revision) ? 'absent' : 'diverged'
    const context = one('SELECT s.run_id,s.stale,s.current_adoption_id,r.status FROM workflow_adoptions a JOIN workflow_steps s ON s.id=a.step_id JOIN workflow_runs r ON r.id=s.run_id WHERE a.id=?', item.adoption_id)
    if (!context) throw fail('outbox_orphaned')
    const owner = one('SELECT outbox_id FROM workflow_publish_owners WHERE target=?', `${item.target}${item.relative_path ? `::${item.relative_path}` : ''}`)
    // 缺归属不能推断被取代；有明确更新归属/采用或 stale 才隔离旧项。
    if (!owner) throw fail('outbox_superseded')
    const superseded = owner.outbox_id !== id || context.current_adoption_id !== item.adoption_id || Boolean(context.stale)
    const status = decision === 'applied' ? 'succeeded' : superseded ? 'superseded' : decision === 'diverged' ? 'conflict'
      : CLOSED_RUN_STATES.includes(context.status) ? 'superseded' : 'pending'
    const reason = decision === 'applied' ? 'effect_applied' : superseded ? (item.reason?.includes('superseded') ? item.reason : 'superseded_before_reconciliation') : `effect_${decision}`
    cas("UPDATE workflow_outbox SET status=?,reason=?,updated_at=? WHERE id=? AND status='outcome_unknown' AND claim_generation=?", [status, reason, now(), id, claimGeneration])
    const runStatus = settleRun(context.run_id)
    const observedAt = now()
    event(context.run_id, decision === 'diverged' ? 'outbox.effect_conflict' : 'outbox.effect_reconciled', {
      outboxId: id, decision, claimGeneration, actorId, observedHash: observed.contentHash,
      observedRevision: observed.revision, observedAt, runStatus, previousReason: item.reason,
    })
    return { outboxId: id, status, decision, claimGeneration, observedAt, runStatus }
  })

  // 失败/冲突可重试；结果未知必须先对账，否则等于假设外部没执行。
  const retryOutbox = (id) => transaction(() => {
    const item = one('SELECT * FROM workflow_outbox WHERE id=?', id)
    if (!item) throw fail('outbox_not_found')
    if (item.status === 'outcome_unknown') throw fail('outbox_requires_reconcile')
    const context = one('SELECT s.run_id,s.stale,s.current_adoption_id,r.status FROM workflow_adoptions a JOIN workflow_steps s ON s.id=a.step_id JOIN workflow_runs r ON r.id=s.run_id WHERE a.id=?', item.adoption_id)
    if (!context) throw fail('outbox_orphaned')
    if (CLOSED_RUN_STATES.includes(context.status)) throw fail('run_not_claimable')
    if (context.stale || context.current_adoption_id !== item.adoption_id || one('SELECT outbox_id FROM workflow_publish_owners WHERE target=?', `${item.target}${item.relative_path ? `::${item.relative_path}` : ''}`)?.outbox_id !== id) throw fail('outbox_superseded')
    cas("UPDATE workflow_outbox SET status='pending',reason=null,updated_at=? WHERE id=? AND status IN ('failed','conflict')", [now(), id])
    return 'pending'
  })

  // 单个 Attempt 被宿主确认中止（例如长任务取消成功）：步骤退回可领取，运行暂停等显式继续。
  const cancelAttempt = (attemptId, reason = 'attempt_cancelled') => transaction(() => {
    const attempt = one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt) throw fail('attempt_not_found')
    cas('UPDATE workflow_attempts SET status=?,outcome=? WHERE id=? AND status=?', ['cancelled', reason, attemptId, 'running'])
    const step = one('SELECT * FROM workflow_steps WHERE id=?', attempt.step_id)
    if (step && step.state === 'running') cas('UPDATE workflow_steps SET state=?,revision=revision+1 WHERE id=? AND revision=?', ['paused', step.id, step.revision])
    const runId = step.run_id
    setRunStatus(runId, 'paused', reason)
    event(runId, 'attempt.cancelled', { attemptId, reason })
    return { attemptId, reason }
  })

  // Revokes adoption authority without asserting whether the remote operation ran.
  const abandonAttemptResult = attemptId => transaction(() => {
    const attempt = one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt || !['running', 'unknown'].includes(attempt.status)) throw fail('attempt_not_abandonable')
    const step = one('SELECT * FROM workflow_steps WHERE id=?', attempt.step_id)
    const owner = one('SELECT status FROM workflow_runs WHERE id=?', step.run_id)
    if (!owner || CLOSED_RUN_STATES.includes(owner.status)) throw fail('run_closed')
    cas('UPDATE workflow_attempts SET status=?,outcome=? WHERE id=? AND status=?', ['cancelled', 'result_abandoned_remote_outcome_unknown', attemptId, attempt.status])
    if (step.state === 'running') cas('UPDATE workflow_steps SET state=?,revision=revision+1 WHERE id=? AND revision=?', ['paused', step.id, step.revision])
    setRunStatus(step.run_id, 'paused', 'session_result_abandoned')
    event(step.run_id, 'attempt.result_abandoned', { attemptId, remoteOutcome: 'unknown' })
    return { attemptId, remoteOutcome: 'unknown' }
  })

  // 显式暂停：与 markFailed / markUnknown 造成的暂停区分原因；只能由 resume 解除（A36）。
  const pauseRun = (runId, reason = 'user_paused') => transaction(() => {
    const runRow = one('SELECT * FROM workflow_runs WHERE id=?', runId)
    if (!runRow) throw fail('run_not_found')
    if (CLOSED_RUN_STATES.includes(runRow.status)) throw fail('run_closed')
    if (runRow.status === 'paused') return { runId, status: 'paused', reason: runRow.pause_reason }
    cas('UPDATE workflow_runs SET status=?,pause_reason=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', ['paused', reason, now(), runId, runRow.revision])
    event(runId, 'run.paused', { reason, previousStatus: runRow.status })
    return { runId, status: 'paused', reason }
  })

  // 外层（业务服务、界面命令）按运行追加事件；seq 仍由内核统一分配。
  const appendEvent = (runId, type, payload = {}) => transaction(() => {
    if (!one('SELECT id FROM workflow_runs WHERE id=?', runId)) throw fail('run_not_found')
    event(runId, type, payload)
    return { runId, type }
  })

  // ---------- B3：只读读取、校验导出、可恢复扫描、幂等保留期清理 ----------
  // 三个副本路径（对象内容、manifest、数据库行）必须互相对得上，缺一即认为副本不可信。
  const manifestPathFor = (attemptId) => join(root, 'manifests', `${fileSafe(attemptId ?? '')}.json`)
  const objectPathFor = (contentHash) => join(root, 'objects', String(contentHash).slice(0, 2), String(contentHash))

  const verifySnapshot = (snapshotId, { allowMissingOutputFiles = false } = {}) => {
    const row = one('SELECT * FROM workflow_snapshots WHERE id=?', snapshotId)
    if (!row) throw fail('snapshot_not_found', `${snapshotId}:row_missing`)
    const manifestPath = manifestPathFor(row.source_attempt_id)
    if (!existsSync(manifestPath)) throw fail('snapshot_manifest_missing', `${snapshotId}:manifest_missing`)
    const manifest = readCandidateManifest(manifestPath)
    if (hash(manifest) !== row.manifest_hash) throw fail('snapshot_manifest_mismatch', `${snapshotId}:manifest_hash`)
    // 身份也要对齐：只改数据库行的快照 id 时 manifest 原样不变，上面的 hash 校验仍会通过，
    // 所以必须显式比对 manifest 声明的 id 与查询到的行 id、以及该行来源 Attempt 推出的 id。
    if (manifest.snapshotId !== row.id) throw fail('snapshot_identity_mismatch', `${snapshotId}:manifest_snapshot_id`)
    if (manifest.snapshotId !== `${row.source_attempt_id}:snapshot`) throw fail('snapshot_identity_mismatch', `${snapshotId}:attempt_snapshot_id`)
    // 类型同理：行上的 artifact_type 不在 manifest hash 覆盖范围内（manifest 只自证自己的字节），
    // 只改数据库的列值时上面所有校验都通过，所以类型必须显式与 manifest 声明比对。
    if (manifest.artifactType !== row.artifact_type) throw fail('snapshot_metadata_mismatch', `${snapshotId}:artifact_type`)
    if (manifest.contentHash !== row.content_hash) throw fail('snapshot_content_mismatch', `${snapshotId}:manifest_content_hash`)
    if (allowMissingOutputFiles && row.artifact_type !== 'file-set') throw fail('snapshot_output_set_metadata_invalid')
    if (allowMissingOutputFiles && (!manifest.outputSet || !manifest.sourceAttemptId || !Array.isArray(manifest.inputSnapshotIds) || !Array.isArray(manifest.blobs))) throw fail('snapshot_output_set_metadata_invalid')
    if (manifest.sourceAttemptId !== undefined || manifest.inputSnapshotIds !== undefined || manifest.blobs !== undefined) {
      const binding = inputBindingFor(row.source_attempt_id)
      const expectedMedia = row.artifact_type === 'json' ? 'application/json' : row.artifact_type === 'markdown' ? 'text/markdown' : 'text/plain'
      const expectedBlobs = [{ relativePath: `objects/${row.content_hash.slice(0, 2)}/${row.content_hash}`, hash: row.content_hash, bytes: Number(manifest.bytes), mediaType: expectedMedia }]
      if (manifest.sourceAttemptId !== row.source_attempt_id || json(manifest.inputSnapshotIds) !== json(binding.inputs.map(input => input.snapshotId)) || (!manifest.outputSet && json(manifest.blobs) !== json(expectedBlobs))) throw fail('snapshot_metadata_mismatch', `${snapshotId}:provenance_or_blobs`)
    }
    const object = objectPathFor(row.content_hash)
    if (!existsSync(object)) throw fail('snapshot_object_missing', `${snapshotId}:object_missing`)
    const content = readOutputObject({ root, hash: row.content_hash, bytes: Number(manifest.bytes) }).toString('utf8')
    if (hash(content) !== row.content_hash) throw fail('snapshot_content_mismatch', `${snapshotId}:content_hash`)
    if (Buffer.byteLength(content) !== Number(manifest.bytes)) throw fail('snapshot_content_mismatch', `${snapshotId}:bytes`)
    if (manifest.outputSet && allowMissingOutputFiles) {
      const attempt = one('SELECT step_id FROM workflow_attempts WHERE id=?', row.source_attempt_id)
      if (!attempt) throw fail('snapshot_source_attempt_invalid')
      const step = one('SELECT run_id,node_id FROM workflow_steps WHERE id=?', attempt.step_id)
      if (!step) throw fail('snapshot_source_step_invalid')
      const declarations = definitionFor(step.run_id).steps.find(node => node.nodeId === step.node_id)?.outputs
      if (row.artifact_type !== 'file-set' || content !== json(manifest.outputSet)) throw fail('snapshot_output_set_metadata_invalid')
      const normalized = normalizeOutputSet({ instances: manifest.outputSet.outputs, files: manifest.outputSet.files, declarations })
      const byHash = new Map()
      for (const file of normalized.files) if (!byHash.has(file.hash)) byHash.set(file.hash, { relativePath: `objects/${file.hash.slice(0, 2)}/${file.hash}`, hash: file.hash, bytes: file.bytes, mediaType: file.mediaType })
      const blobs = [...byHash.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      if (manifest.outputSet.digest !== normalized.digest || manifest.outputSetDigest !== normalized.digest || json(manifest.blobs) !== json(blobs)) throw fail('snapshot_output_set_metadata_invalid')
    } else {
      verifyCandidateSet(manifest, row.source_attempt_id, content)
    }
    return { row, manifest, content }
  }

  // 只读：不写库、不写盘、不改任何状态。
  const readSnapshot = (snapshotId) => {
    const { row, manifest, content } = verifySnapshot(snapshotId)
    return {
      snapshotId: row.id, artifactType: row.artifact_type, contentHash: row.content_hash,
      manifestHash: row.manifest_hash, parentId: row.parent_id, sourceAttemptId: row.source_attempt_id,
      authorType: row.author_type, createdAt: row.created_at, bytes: Number(manifest.bytes),
      content, outputSet: manifest.outputSet ?? null, outputSetDigest: manifest.outputSetDigest ?? null, verified: true,
    }
  }

  const readSnapshotFiles = (snapshotId) => {
    const { manifest } = verifySnapshot(snapshotId)
    if (!manifest.outputSet) throw fail('output_set_required')
    return readOutputSet({ root, set: manifest.outputSet })
  }

  // 导出到独立目录：先校验再落盘，落盘后回读校验；不给 expectedHash 时按数据库记录比对。
  const exportSnapshot = (snapshotId, dir, { expectedHash = null } = {}) => {
    if (!dir) throw fail('snapshot_export_dir_required')
    const { row, manifest, content } = verifySnapshot(snapshotId)
    if (expectedHash !== null && expectedHash !== row.content_hash) throw fail('snapshot_hash_mismatch', `${snapshotId}:expected_hash`)
    if (manifest.outputSet) {
      const collection = readOutputSet({ root, set: manifest.outputSet })
      // Export only to a new leaf under an existing, non-link directory chain.
      // A failed export is retained without a completion marker for inspection.
      const destination = resolve(dir)
      const parent = dirname(destination)
      let current = parsePath(parent).root
      for (const part of parent.slice(current.length).split(sep).filter(Boolean)) {
        current = join(current, part)
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('snapshot_export_path_invalid')
      }
      mkdirSync(destination)
      const payload = join(destination, 'files')
      mkdirSync(payload)
      for (const file of collection.files) {
        const path = join(payload, ...file.relativePath.split('/'))
        mkdirSync(dirname(path), { recursive: true })
        const fd = openSync(path, 'wx', 0o600)
        try { writeFileSync(fd, file.data); fsyncSync(fd) } finally { closeSync(fd) }
        const bytes = readFileSync(path)
        if (fileBytesDigest(bytes) !== file.hash || bytes.length !== file.bytes) throw fail('snapshot_export_file_mismatch')
      }
      const completion = { snapshotId, contentHash: row.content_hash, manifestHash: row.manifest_hash, outputSet: collection.set }
      writeCandidateManifest(join(destination, 'export.json'), completion)
      return { snapshotId, path: destination, contentHash: row.content_hash, manifestHash: row.manifest_hash, outputSetDigest: collection.digest, files: collection.files.length, bytes: collection.files.reduce((total, file) => total + file.bytes, 0) }
    }
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${fileSafe(`${snapshotId}-${row.content_hash.slice(0, 8)}`)}.txt`)
    writeFileSync(`${target}.tmp`, content, 'utf8')
    renameSync(`${target}.tmp`, target)
    const roundTrip = readFileSync(target, 'utf8')
    if (hash(roundTrip) !== row.content_hash) throw fail('snapshot_content_mismatch', `${snapshotId}:export_roundtrip`)
    return { snapshotId, path: target, contentHash: row.content_hash, manifestHash: row.manifest_hash, bytes: Number(manifest.bytes) }
  }

  // 可恢复扫描：纯读，返回重启/断电后需要接续或对账的条目，不做任何修复动作。
  const scanRecoverable = ({ now: at = null } = {}) => {
    const stamp = at ?? now()
    const items = []
    const expired = all("SELECT a.id AS attempt_id, a.step_id, a.lease_until, s.run_id FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE a.status='running' AND a.lease_until < ? ORDER BY s.rowid, a.attempt_no", stamp)
    for (const row of expired) items.push({ kind: 'lease_expired', runId: row.run_id, stepId: row.step_id, attemptId: row.attempt_id, leaseUntil: row.lease_until })
    const unknown = all("SELECT o.id AS outbox_id, o.claim_generation, o.updated_at, o.target, o.status, o.reason, s.run_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE o.status='outcome_unknown' ORDER BY o.rowid")
    for (const row of unknown) items.push({ kind: 'outbox_outcome_unknown', runId: row.run_id, outboxId: row.outbox_id, target: row.target, reason: row.reason, claimGeneration: Number(row.claim_generation), updatedAt: row.updated_at })
    const runningOutbox = all("SELECT o.id AS outbox_id, o.claim_generation, o.updated_at, o.target, s.run_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE o.status='running' ORDER BY o.rowid")
    for (const row of runningOutbox) items.push({ kind: 'outbox_running', runId: row.run_id, outboxId: row.outbox_id, target: row.target, claimGeneration: Number(row.claim_generation), updatedAt: row.updated_at })
    const pending = all("SELECT o.id AS outbox_id, o.claim_generation, o.updated_at, o.target, s.run_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE o.status='pending' AND o.required=1 ORDER BY o.rowid")
    for (const row of pending) items.push({ kind: 'outbox_pending', runId: row.run_id, outboxId: row.outbox_id, target: row.target, claimGeneration: Number(row.claim_generation), updatedAt: row.updated_at })
    const stale = all("SELECT s.id AS step_id, s.run_id FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id WHERE s.stale=1 AND r.status NOT IN ('completed','failed','cancelled') ORDER BY s.rowid")
    for (const row of stale) items.push({ kind: 'step_stale', runId: row.run_id, stepId: row.step_id })
    const pausedSteps = all("SELECT s.id AS step_id, s.run_id FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id WHERE s.state='paused' AND r.status NOT IN ('completed','failed','cancelled') ORDER BY s.rowid")
    for (const row of pausedSteps) items.push({ kind: 'step_paused', runId: row.run_id, stepId: row.step_id })
    const pausedRuns = all("SELECT id AS run_id, pause_reason FROM workflow_runs WHERE status='paused' ORDER BY rowid")
    for (const row of pausedRuns) items.push({ kind: 'run_paused', runId: row.run_id, reason: row.pause_reason })
    return { scannedAt: stamp, total: items.length, items }
  }

  // 幂等请求保留期清理：只删过期窗口外的记录，窗口内的重放仍然按原结果返回。
  const pruneRequests = ({ retentionMs = 7 * 24 * 60 * 60 * 1000, now: at = null } = {}) => {
    if (!Number.isFinite(retentionMs) || retentionMs < 0) throw fail('request_retention_invalid')
    const stamp = at ?? now()
    const cutoff = new Date(Date.parse(stamp) - retentionMs).toISOString()
    const removed = run('DELETE FROM workflow_requests WHERE created_at < ?', cutoff)
    return { removed: Number(removed.changes ?? 0), cutoff, retentionMs }
  }

  return {
    db, root, transaction, createRun, claim, skipConditionalStep, rerunStep, restoreAdoption, forkRun, compareSnapshots, definitionFor, targetsFor, inputBindingFor, assertBindingVersion, storeCandidate, storeOutputSetCandidate, adopt, saveDraft, validateHumanDraft, readDraftFile, saveDraftFile, confirmHuman,
    heartbeatAttempt, markUnknown, markFailed, reconcileUnknown, resume, cancelRun, cancelAttempt, abandonAttemptResult, pauseRun, appendEvent,
    claimOutbox, completeOutbox, markOutboxUnknown, retryOutbox, reconcilePublishEffect, settleRun,
    readSnapshot, readSnapshotFiles, exportSnapshot, scanRecoverable, pruneRequests, verifySnapshot,
    humanInputSource, revisionContext, beginRevisionRequest, applyRevisionDraft,
    listValidations: runId => validationStore.listByRun(runId),
    query: (sql, ...args) => all(sql, ...args), one: (sql, ...args) => one(sql, ...args), hash,
  }
}

export function openWorkflowKernel(dbPath, root, options = {}) {
  let DatabaseSync
  try { ({ DatabaseSync } = require('node:sqlite')) } catch { throw new WorkflowRequiresSqliteError() }
  return createWorkflowKernel(new DatabaseSync(dbPath), root, options)
}
