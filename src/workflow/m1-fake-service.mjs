// W1-10 假业务服务：在临时 SQLite 与临时对象目录上模拟「HTTP / tool → 业务服务」边界。
// 只做本地假适配：不监听端口、不发真实 HTTP、不注册任何宿主工具、不接主运行时。
// 调用面与权限矩阵对应 docs/evidence/workflow/m0/contract-tool-governance.md 的 G-01..G-10 与 §5。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateInputSchema, validateInputSchemaDefinition } from './m1-kernel.mjs'
import { assembleCapturedContext } from './m1-context-provider.mjs'
import { executeFakeCapability } from './m1-fake-capability.mjs'
import { createJobStore, jobRefFor, submissionIntent } from './m1-job-store.mjs'
import { normalizeOutputSet, fileBytesDigest } from './m1-output-set.mjs'
import { createRevisionStore, revisionIdFor } from './m1-revision-store.mjs'
import { putOutputObject, readOutputObject } from './m1-output-set-store.mjs'

/** 冻结错误码（contract-tool-governance.md §4）。服务只返回这 10 个码，具体原因放 detail。 */
export const SERVICE_ERROR_CODES = Object.freeze([
  'workflow_requires_sqlite',
  'publish_target_invalid',
  'publish_conflict',
  'attempt_invalid',
  'schema_invalid',
  'artifact_missing',
  'outcome_unknown',
  'capability_unavailable',
  'budget_exhausted',
  'human_confirm_required',
])

export const PRINCIPAL_KINDS = Object.freeze(['ui', 'node-agent', 'other-agent', 'scheduler', 'http-client'])

export const CAPABILITIES = Object.freeze([
  'read.run', 'read.artifact', 'read.events',
  'submit.output', 'report.progress', 'control.run',
  'read.job', 'confirm.human', 'publish.official', 'write.direct',
])

export const JOB_STATES = Object.freeze(['pending', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'])

export const MAX_OUTPUT_BYTES = 512 * 1024
export const MAX_EVENT_PAGE = 100

/** 与契约 §5 的权限矩阵逐格对应：allow / scoped(仅被授予的 run) / attempt(仅被派发的 attempt) / product(仅本产品) / credential(需凭证) / deny。 */
export const PERMISSIONS = Object.freeze({
  'ui': Object.freeze({
    // 本产品本会话可见：UI 读取也必须带产品边界，不允许跨产品读别人的 run（G-01）。
    'read.run': 'product', 'read.artifact': 'product', 'read.events': 'product',
    'submit.output': 'allow', 'report.progress': 'allow', 'control.run': 'allow',
    'read.job': 'product', 'confirm.human': 'allow', 'publish.official': 'deny', 'write.direct': 'deny',
  }),
  'node-agent': Object.freeze({
    'read.run': 'scoped', 'read.artifact': 'scoped', 'read.events': 'scoped',
    'submit.output': 'attempt', 'report.progress': 'attempt', 'control.run': 'scoped',
    'read.job': 'scoped', 'confirm.human': 'deny', 'publish.official': 'deny', 'write.direct': 'deny',
  }),
  'other-agent': Object.freeze({
    'read.run': 'product', 'read.artifact': 'deny', 'read.events': 'deny',
    'submit.output': 'deny', 'report.progress': 'deny', 'control.run': 'deny',
    'read.job': 'deny', 'confirm.human': 'deny', 'publish.official': 'deny', 'write.direct': 'deny',
  }),
  'scheduler': Object.freeze({
    'read.run': 'allow', 'read.artifact': 'allow', 'read.events': 'allow',
    'submit.output': 'deny', 'report.progress': 'deny', 'control.run': 'allow',
    'read.job': 'allow', 'confirm.human': 'deny', 'publish.official': 'allow', 'write.direct': 'deny',
  }),
  'http-client': Object.freeze({
    'read.run': 'credential', 'read.artifact': 'credential', 'read.events': 'credential',
    'submit.output': 'credential', 'report.progress': 'credential', 'control.run': 'credential',
    'read.job': 'credential', 'confirm.human': 'deny', 'publish.official': 'deny', 'write.direct': 'deny',
  }),
})

/** 内核的领域错误码不是工具面错误码；这里映射到冻结集合，原始码进 detail。 */
const DOMAIN_TO_SERVICE = Object.freeze({
  attempt_token_invalid: 'attempt_invalid',
  attempt_not_found: 'attempt_invalid',
  run_closed: 'attempt_invalid',
  run_not_claimable: 'attempt_invalid',
  step_not_found: 'artifact_missing',
  run_not_found: 'artifact_missing',
  candidate_manifest_required: 'artifact_missing',
  candidate_content_mismatch: 'artifact_missing',
  candidate_not_durable: 'artifact_missing',
  manifest_mismatch: 'artifact_missing',
  reconcile_artifact_missing: 'artifact_missing',
  budget_exhausted: 'budget_exhausted',
  publish_unresolved: 'publish_conflict',
  outbox_not_found: 'artifact_missing',
  outbox_not_claimable: 'publish_conflict',
  outbox_already_claimed: 'publish_conflict',
  outbox_superseded: 'publish_conflict',
  outbox_not_claimed: 'publish_conflict',
  outbox_claim_mismatch: 'publish_conflict',
  publish_actor_required: 'schema_invalid',
  publish_reason_required: 'schema_invalid',
  publish_base_mismatch: 'publish_conflict',
  publish_observation_required: 'schema_invalid',
  target_unavailable: 'capability_unavailable',
  outbox_requires_reconcile: 'outcome_unknown',
  outbox_not_reconcilable: 'outcome_unknown',
  human_identity_required: 'human_confirm_required',
  human_task_not_found: 'human_confirm_required',
  human_task_unavailable: 'human_confirm_required',
  cas_conflict: 'schema_invalid',
  idempotency_conflict: 'schema_invalid',
  input_fingerprint_conflict: 'schema_invalid',
  input_binding_stale: 'schema_invalid',
  input_schema_invalid: 'schema_invalid',
  run_not_resumable: 'capability_unavailable',
  run_not_cancellable: 'capability_unavailable',
  run_paused: 'capability_unavailable',
  run_waiting_review: 'capability_unavailable',
})

const fail = (code, detail, extra = {}) => {
  if (!SERVICE_ERROR_CODES.includes(code)) throw new Error(`unfrozen_service_error:${code}`)
  return Object.assign(new Error(`${code}:${detail}`), { code, detail, ...extra })
}

const translate = (error, fallback = 'schema_invalid') => {
  if (!error) return fail(fallback, 'unknown_error')
  if (SERVICE_ERROR_CODES.includes(error.code)) return error
  const code = DOMAIN_TO_SERVICE[error.code] ?? fallback
  return fail(code, error.code ?? 'kernel_error', { cause: error.message })
}

const NEXT_ACTION_BY_RUN = Object.freeze({
  created: 'claim', running: 'wait', waiting_review: 'human_confirm', paused: 'resume',
  completed: 'none', failed: 'none', cancelled: 'none',
})

export function createFakeBusinessService({ kernel, targetAdapter = null, contextProvider = null, clock = () => new Date().toISOString(), maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
  if (!kernel) throw new TypeError('kernel is required')
  const principals = new Map()
  const operations = new Map()
  // 作业以 workflow_jobs 为准；jobs 只是本进程的读缓存，避免每次读都过一遍库。
  const jobs = new Map()
  const jobStore = createJobStore({ kernel, clock })
  const revisionStore = createRevisionStore({ kernel, clock })
  revisionStore.ensure()
  // Synchronous producers cannot still be running in a newly opened service.
  for (const request of revisionStore.list()) {
    if (['requested', 'producing'].includes(request.status)) revisionStore.save({ id: request.id, expectStatus: request.status, status: 'failed', errorCode: 'revision_interrupted' })
  }
  const runProducts = new Map()
  const metrics = { operations: 0, jobRefs: 0, hostExecutions: 0, downloads: 0, cancelRequests: 0, recoveredJobs: 0 }

  // 启动即隔离：重启前已受理但未完成的任务一律转 outcome_unknown，不重派、不采用、不复活终态。
  // 必须在任何调用进入之前完成，否则会话看到的是「看起来还在跑」的假象。
  const recoveredJobs = jobStore.recover({ markUnknown: (attemptId, reason) => kernel.markUnknown(attemptId, reason) })
  metrics.recoveredJobs = recoveredJobs.length

  // 所有状态变更都写穿到库：内存只做缓存，崩溃后以库里的行为准。
  const persist = (job, patch = {}) => {
    Object.assign(job, patch)
    jobStore.save(job)
    jobs.set(job.jobRef, job)
    return job
  }

  const operationId = prefix => `${prefix}:${++metrics.operations}`

  const registerPrincipal = ({ id, kind, productId = null, runIds = null, attemptIds = null, credential = null } = {}) => {
    if (!id || typeof id !== 'string') throw fail('schema_invalid', 'principal_id_required')
    if (!PRINCIPAL_KINDS.includes(kind)) throw fail('schema_invalid', 'principal_kind_invalid')
    if (runIds !== null && (!Array.isArray(runIds) || runIds.some(runId => typeof runId !== 'string'))) throw fail('schema_invalid', 'run_ids_invalid')
    if (attemptIds !== null && (!Array.isArray(attemptIds) || attemptIds.some(attemptId => typeof attemptId !== 'string'))) throw fail('schema_invalid', 'attempt_ids_invalid')
    const existing = principals.get(id)
    if (existing) {
      // 同一会话后续被授予新 run / attempt 时是授权更新，不是新建身份。
      if (existing.kind !== kind) throw fail('schema_invalid', 'principal_kind_conflict')
      const merge = (current, next) => next === null ? current : [...new Set([...(current ?? []), ...next])]
      principals.set(id, {
        id, kind,
        productId: productId ?? existing.productId,
        runIds: merge(existing.runIds, runIds),
        attemptIds: merge(existing.attemptIds, attemptIds),
        credential: credential ?? existing.credential,
      })
      return { id, kind, updated: true }
    }
    principals.set(id, { id, kind, productId, runIds, attemptIds, credential })
    return { id, kind }
  }

  // 先按身份判档，再解析对象：被拒绝的会话不应该从错误码里推断 attempt 是否存在。
  const assertCapabilityAllowed = (principal, capability) => {
    const record = principals.get(principal)
    if (!record) throw fail('capability_unavailable', 'unknown_principal')
    const level = PERMISSIONS[record.kind]?.[capability] ?? 'deny'
    if (level === 'deny') throw fail('capability_unavailable', `${record.kind}_may_not_${capability}`)
    return record
  }

  const authorize = ({ principal, capability, context = {} }) => {
    const record = principals.get(principal)
    if (!record) throw fail('capability_unavailable', 'unknown_principal')
    const level = PERMISSIONS[record.kind]?.[capability] ?? 'deny'
    if (level === 'deny') throw fail('capability_unavailable', `${record.kind}_may_not_${capability}`)
    if (level === 'scoped') {
      // 未指定 run 时表示按该会话被授予的 run 集合过滤（例如待办列表），而不是放行全部。
      if (context.runId === null || context.runId === undefined) {
        if (!Array.isArray(record.runIds) || record.runIds.length === 0) throw fail('capability_unavailable', 'no_authorized_runs')
      } else if (!Array.isArray(record.runIds) || !record.runIds.includes(context.runId)) {
        throw fail('capability_unavailable', 'run_not_authorized')
      }
    }
    if (level === 'attempt') {
      if (!Array.isArray(record.attemptIds) || !context.attemptId || !record.attemptIds.includes(context.attemptId)) throw fail('capability_unavailable', 'attempt_not_authorized')
    }
    if (level === 'product') {
      if (!record.productId || context.productId !== record.productId) throw fail('capability_unavailable', 'product_not_authorized')
    }
    if (level === 'credential') {
      if (!record.credential || context.credential !== record.credential) throw fail('capability_unavailable', 'credential_required')
    }
    // 产品边界对每种身份都成立，不能只靠档位：UI 的 read.run 曾是 allow，
    // 于是 ui-2(p2) 能读到 p1 的 run。这里统一再判一次（G-01）。
    if (record.productId && (context.productId === undefined || context.productId !== record.productId)) {
      throw fail('capability_unavailable', 'product_not_authorized')
    }
    return record
  }

  // 解析对象之前就能判的授权：身份档位、被授予的 attempt 集合、会话凭证。
  // 这三项都不依赖库里的对象，所以必须前置：否则「对象不存在」与「无权 / 未认证」返回不同错误码，
  // 未授权调用方就能靠错误码差异探测 run / job / task 是否存在（G-01、G-04、G-08）。
  const assertPreAuthorized = (principal, capability, { attemptId = null, runId = null, credential = null } = {}) => {
    const record = assertCapabilityAllowed(principal, capability)
    const level = PERMISSIONS[record.kind]?.[capability] ?? 'deny'
    if (level === 'attempt' && (!Array.isArray(record.attemptIds) || !attemptId || !record.attemptIds.includes(attemptId))) {
      throw fail('capability_unavailable', 'attempt_not_authorized')
    }
    // 按 run 授权的身份：必须在解析 run 之前判定，否则「未授权但存在」报 run_not_authorized、
    // 「不存在」报 run_not_found，runId 就成了存在性预言机（G-01）。
    if (level === 'scoped' && runId !== null && (!Array.isArray(record.runIds) || !record.runIds.includes(runId))) {
      throw fail('capability_unavailable', 'run_not_authorized')
    }
    if (level === 'credential' && (!record.credential || credential !== record.credential)) {
      throw fail('capability_unavailable', 'credential_required')
    }
    return record
  }

  const runContext = (runId) => {
    if (typeof runId !== 'string' || runId.length === 0) throw fail('artifact_missing', 'run_not_found')
    const row = kernel.one('SELECT * FROM workflow_runs WHERE id=?', runId)
    if (!row) throw fail('artifact_missing', 'run_not_found')
    return { runId, run: row, productId: kernel.one('SELECT product_id FROM workflow_run_definitions WHERE run_id=?', runId)?.product_id ?? runProducts.get(runId) ?? null }
  }

  // 「未授权对象对外不可区分」的统一出口（G-01/G-04）：run 不存在、跨产品、不在被授予范围内，
  // 都返回同一个结果；scoped/attempt 身份用 run_not_authorized，其余身份用 run_not_found。
  // 只吞授权类失败，真正的内部错误照旧抛出，避免把 bug 伪装成 404。
  const guardedRunContext = ({ principal, capability, runId, credential = null }) => {
    const record = assertPreAuthorized(principal, capability, { runId, credential })
    const level = PERMISSIONS[record.kind]?.[capability] ?? 'deny'
    const hidden = () => (level === 'scoped' || level === 'attempt')
      ? fail('capability_unavailable', 'run_not_authorized')
      : fail('artifact_missing', 'run_not_found')
    let ctx
    try { ctx = runContext(runId) } catch (error) {
      if (error?.code === 'artifact_missing' && error?.detail === 'run_not_found') throw hidden()
      throw error
    }
    try {
      authorize({ principal, capability, context: { runId, productId: ctx.productId, credential } })
    } catch (error) {
      // 凭证问题在 assertPreAuthorized 已判过，走到这里一定是归属/产品不符。
      if (error?.code === 'capability_unavailable') throw hidden()
      throw error
    }
    return { ctx, level, record }
  }

  // attempt 级入口（G-04/G-05）用同一口径：跨产品现存 attempt 与不存在 attempt 对外同一响应。
  // attempt 归属（node-agent 的 attemptIds）已在 assertPreAuthorized 里先判，这里只处理
  // 「解析不到对象」与「对象存在但无权访问」两种情况，且都不透露对象是否存在。
  const guardedAttemptContext = ({ principal, capability, attemptId, credential = null }) => {
    const record = assertPreAuthorized(principal, capability, { attemptId, credential })
    const level = PERMISSIONS[record.kind]?.[capability] ?? 'deny'
    const hidden = () => (level === 'attempt')
      ? fail('capability_unavailable', 'attempt_not_authorized')
      : fail('attempt_invalid', 'attempt_not_found')
    let ctx
    try { ctx = attemptContext(attemptId) } catch (error) {
      if (error?.code === 'attempt_invalid') throw hidden()
      throw error
    }
    try {
      authorize({ principal, capability, context: { attemptId, runId: ctx.runId, productId: ctx.productId, credential } })
    } catch (error) {
      if (error?.code === 'capability_unavailable') throw hidden()
      throw error
    }
    return { ctx, level, record }
  }

  const attemptContext = (attemptId) => {
    const attempt = kernel.one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt) throw fail('attempt_invalid', 'attempt_not_found')
    const step = kernel.one('SELECT * FROM workflow_steps WHERE id=?', attempt.step_id)
    if (!step) throw fail('artifact_missing', 'step_not_found')
    return { attemptId, attempt, step, runId: step.run_id, productId: runProducts.get(step.run_id) ?? null }
  }

  /** 幂等：同 principal+能力下，同 key 同请求返回原结果，同 key 不同请求拒绝，重复调用不产生第二次副作用。 */
  const idempotent = ({ principal, capability, key, context, payload, execute, fallback = 'schema_invalid' }) => {
    authorize({ principal, capability, context })
    if (typeof key !== 'string' || key.trim() === '') throw fail('schema_invalid', 'idempotency_key_required')
    const scope = `${principal}|${capability}`
    const requestHash = kernel.hash({ scope, payload })
    const prior = operations.get(`${scope}|${key}`)
    if (prior) {
      if (prior.requestHash !== requestHash) throw fail('schema_invalid', 'idempotency_conflict')
      return { ...prior.result, replayed: true }
    }
    let result
    try { result = execute() } catch (error) { throw translate(error, fallback) }
    operations.set(`${scope}|${key}`, { requestHash, result })
    return result
  }

  // ---- G-06 启动 -----------------------------------------------------------
  const startRun = ({ principal, idempotencyKey, runId, productId, steps = null, human = false, input = { fixture: true }, inputSchema = null, credential = null } = {}) => {
    if (typeof runId !== 'string' || runId === '') throw fail('schema_invalid', 'run_id_required')
    if (typeof productId !== 'string' || productId === '') throw fail('schema_invalid', 'product_id_required')
    if (steps !== null && (!Array.isArray(steps) || steps.length === 0)) throw fail('schema_invalid', 'run_steps_required')
    // A10：schema 不兼容或越界在启动这一步就拦，且提示落到字段级——不生成 run，也不留可豁免的旁路。
    // 先校验方言（写错/不认识的关键字当场拒绝），再校验值：缺了前者，一个被静默忽略的约束
    // 会让调用方以为输入被卡住了，实际放行。
    validateInputSchemaDefinition(inputSchema)
    try {
      validateInputSchema(inputSchema, input)
    } catch (error) {
      throw fail('schema_invalid', `input:${error.message}`)
    }
    // 启动也是控制入口：受认证的 HTTP 会话必须能用同一凭证建运行，不能一律报 credential_required。
    assertPreAuthorized(principal, 'control.run', { credential })
    return idempotent({
      principal, capability: 'control.run', key: idempotencyKey,
      context: { runId, productId, credential }, payload: { runId, productId, steps, human, input, inputSchema }, fallback: 'capability_unavailable',
      execute: () => {
        const created = kernel.createRun({ id: runId, steps: steps ?? [{ nodeId: human ? 'human.edit-confirm' : 'fake.transform', nodeKind: human ? 'human' : 'automatic', publishTargets: [] }], human, input, inputSchema, productId, contextCapture: contextProvider?.snapshot() ?? null })
        runProducts.set(runId, productId)
        return { operationId: operationId('op-start'), status: 'accepted', runId, stepCount: created.stepCount, nextAction: 'claim' }
      },
    })
  }

  // ---- G-01 / G-02 / G-03 读取 ---------------------------------------------
  const getRun = ({ principal, runId, credential = null } = {}) => {
    // 先判会话凭证，再查 run：否则未认证调用方能从 credential_required / run_not_found 的差异
    // 得知某个 runId 是否存在（G-01）。
    const { ctx } = guardedRunContext({ principal, capability: 'read.run', runId, credential })
    const steps = kernel.query('SELECT id,node_id,node_kind,state,revision,stale,current_adoption_id FROM workflow_steps WHERE run_id=? ORDER BY rowid', runId)
    return {
      operationId: operationId('op-get'), status: 'completed',
      run: { ...ctx.run }, steps, nextAction: NEXT_ACTION_BY_RUN[ctx.run.status] ?? 'none',
    }
  }

  const readDefinition = ({ principal, runId, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    try {
      const definition = kernel.definitionFor(runId)
      const row = kernel.one('SELECT fork_json FROM workflow_run_definitions WHERE run_id=?', runId)
      return { available: true, version: definition.version, steps: definition.steps.map(node => ({
        nodeId: node.nodeId, nodeKind: node.nodeKind, outputs: node.outputs ?? null, inputMapping: node.inputMapping ?? null,
        validationDeclarationAvailable: Array.isArray(node.requiredChecks),
        requiredChecks: Array.isArray(node.requiredChecks) ? node.requiredChecks : null,
        declarationAvailable: Array.isArray(node.publishTargets),
        publishTargets: Array.isArray(node.publishTargets) ? node.publishTargets : null,
      })), fork: row?.fork_json ? JSON.parse(row.fork_json) : null }
    } catch (error) {
      return { available: false, error: error.code ?? 'definition_invalid', steps: null, fork: null }
    }
  }

  const listArtifacts = ({ principal, runId, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    const artifacts = kernel.query(`
      SELECT s.id AS snapshotId, s.artifact_type AS artifactType, s.content_hash AS contentHash,
             s.manifest_hash AS manifestHash, s.parent_id AS parentId, s.author_type AS authorType,
             a.id AS adoptionId
      FROM workflow_snapshots s
      JOIN workflow_attempts at ON at.id = s.source_attempt_id
      JOIN workflow_steps st ON st.id = at.step_id
      LEFT JOIN workflow_adoptions a ON a.snapshot_id = s.id
      WHERE st.run_id=? ORDER BY s.rowid`, runId)
    return { operationId: operationId('op-artifacts'), status: 'completed', artifacts, nextAction: 'none' }
  }

  // 只读固定快照：路径完全由库内 contentHash 推出，不接受调用方给路径。
  const readArtifact = ({ principal, runId, snapshotId, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    if (typeof snapshotId !== 'string' || snapshotId === '') throw fail('schema_invalid', 'snapshot_id_required')
    const snapshot = kernel.one(`
      SELECT s.* FROM workflow_snapshots s
      JOIN workflow_attempts at ON at.id = s.source_attempt_id
      JOIN workflow_steps st ON st.id = at.step_id
      WHERE st.run_id=? AND s.id=?`, runId, snapshotId)
    if (!snapshot) throw fail('artifact_missing', 'snapshot_not_in_run')
    let artifact
    try { artifact = kernel.readSnapshot(snapshotId) }
    catch (error) {
      // Preserve existing object-read details while exposing new manifest failures.
      const detail = { snapshot_object_missing: 'object_not_on_disk', snapshot_content_mismatch: 'content_hash_mismatch', output_object_corrupt: 'content_hash_mismatch' }[error.code] ?? error.code ?? 'snapshot_read_failed'
      throw fail('artifact_missing', detail)
    }
    return {
      operationId: operationId('op-artifact'),
      status: 'completed',
      artifact,
      nextAction: 'none',
    }
  }

  // Historical reads use the same run authorization as current-state reads.
  const listAdoptions = ({ principal, runId, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.run', runId, credential })
    const adoptions = kernel.query(`
      SELECT a.id AS adoptionId, a.step_id AS stepId, a.snapshot_id AS snapshotId,
             a.previous_id AS previousId, a.actor_type AS actorType, a.reason, a.created_at AS createdAt
      FROM workflow_adoptions a JOIN workflow_steps s ON s.id=a.step_id
      WHERE s.run_id=? ORDER BY s.rowid, a.rowid`, runId)
    return { operationId: operationId('op-adoptions'), status: 'completed', adoptions, nextAction: 'none' }
  }

  // 只读预检仅覆盖冻结外部资料；不预言下一次领取的上游绑定。
  const preflightContext = ({ principal, runId, credential = null } = {}) => {
    const { ctx } = guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    try {
      const capture = kernel.definitionFor(runId).contextCapture
      if (capture == null) return { configured: false, ready: true, scope: 'captured_external_sources' }
      if (capture.spec?.productId !== ctx.productId) throw fail('context_invalid', 'capture_product_mismatch')
      const assembled = assembleCapturedContext({ root: kernel.root, capture, runId, attemptId: null, nodeId: null, binding: { inputs: [] } })
      return { configured: true, ready: true, scope: 'captured_external_sources', manifest: assembled.manifest, receipt: assembled.receipt }
    } catch (error) {
      return { ready: false, scope: 'captured_external_sources', error: error.code ?? 'context_unavailable', detail: error.detail ?? error.message }
    }
  }

  const readAttemptInput = ({ principal, runId, attemptId, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    if (typeof attemptId !== 'string' || attemptId.length === 0) throw fail('artifact_missing', 'attempt_not_in_run')
    const attempt = kernel.one(`SELECT a.id FROM workflow_attempts a
      JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? AND a.id=?`, runId, attemptId)
    if (!attempt) throw fail('artifact_missing', 'attempt_not_in_run')
    let binding
    try { binding = kernel.inputBindingFor(attemptId) }
    catch (error) {
      if (['attempt_input_unbound', 'attempt_input_invalid'].includes(error.code)) throw fail('artifact_missing', error.code)
      throw translate(error)
    }
    return { operationId: operationId('op-attempt-input'), status: 'completed', binding, nextAction: 'none' }
  }

  const readTaskInput = ({ principal, runId, taskId, version = null, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    if (typeof taskId !== 'string' || taskId.length === 0) throw fail('artifact_missing', 'task_not_in_run')
    const task = kernel.one(`SELECT t.*, s.stale AS step_stale FROM workflow_human_tasks t
      JOIN workflow_steps s ON s.id=t.step_id WHERE s.run_id=? AND t.id=?`, runId, taskId)
    if (!task) throw fail('artifact_missing', 'task_not_in_run')
    if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw fail('schema_invalid', 'input_binding_version_invalid')
    let binding
    try { binding = kernel.inputBindingFor(taskId, version) }
    catch (error) {
      if (['attempt_input_unbound', 'attempt_input_invalid'].includes(error.code)) throw fail('artifact_missing', error.code)
      throw translate(error)
    }
    const current = kernel.one('SELECT MAX(version) AS version FROM workflow_input_bindings WHERE owner_id=?', taskId)
    const frozen = kernel.one('SELECT frozen_at FROM workflow_input_bindings WHERE owner_id=? AND version=?', taskId, binding.version)
    return { operationId: operationId('op-task-input'), status: 'completed', taskInput: {
      taskId, stepId: task.step_id, ...binding, currentVersion: current.version,
      isCurrent: binding.version === current.version, taskRevision: task.task_revision,
      status: task.status, stepStale: task.step_stale === 1, frozenAt: frozen.frozen_at,
    }, nextAction: 'none' }
  }

  const listEvents = ({ principal, runId, cursor = 0, limit = 50, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.events', runId, credential })
    if (!Number.isInteger(cursor) || cursor < 0) throw fail('schema_invalid', 'cursor_invalid')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) throw fail('schema_invalid', 'limit_out_of_range')
    const rows = kernel.query('SELECT seq,type,payload,created_at FROM workflow_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?', runId, cursor, limit + 1)
    const page = rows.slice(0, limit)
    const hasMore = rows.length > limit
    return {
      operationId: operationId('op-events'),
      status: 'completed',
      events: page.map(row => ({ seq: row.seq, type: row.type, payload: JSON.parse(row.payload), createdAt: row.created_at })),
      nextCursor: hasMore ? page[page.length - 1].seq : null,
      hasMore,
      nextAction: 'none',
    }
  }

  // ---- G-04 提交候选（长任务入口） -----------------------------------------
  const submitOutput = ({ principal, attemptId, token, content, artifactType = 'text', target = null, required = true, idempotencyKey, credential = null } = {}) => {
    if (typeof attemptId !== 'string' || attemptId === '') throw fail('schema_invalid', 'attempt_id_required')
    if (typeof token !== 'string' || token === '') throw fail('schema_invalid', 'attempt_token_required')
    if (typeof content !== 'string' || content === '') throw fail('schema_invalid', 'content_required')
    if (Buffer.byteLength(content) > maxOutputBytes) throw fail('schema_invalid', 'content_too_large')
    if (target !== null && (typeof target !== 'string' || target === '')) throw fail('schema_invalid', 'publish_target_invalid')
    // 授权先于凭证、也先于解析对象：否则未获授权的会话可以用「错 token 报 attempt_token_mismatch、
    // 对 token 报 attempt_not_authorized」的差异探测自己是否猜中了别人的 attempt 凭证（G-04）。
    // 授权先于凭证、也先于解析对象；跨产品现存与缺失的 attempt 由 guardedAttemptContext 统一隐藏。
    // 凭证必须一起传：http-client 的档位就是 credential，漏传会让正确的提交被当成未认证。
    const { ctx } = guardedAttemptContext({ principal, capability: 'submit.output', attemptId, credential })
    if (ctx.attempt.token !== token) throw fail('attempt_invalid', 'attempt_token_mismatch')
    let artifactContent = content
    if (artifactType === 'file-set') {
      try {
        const envelope = JSON.parse(content)
        if (envelope.format !== 'workflow-output-set/1') throw new Error('format')
        const step = kernel.one('SELECT run_id,node_id FROM workflow_steps WHERE id=?', ctx.attempt.step_id)
        const outputs = kernel.definitionFor(step.run_id).steps.find(node => node.nodeId === step.node_id)?.outputs
        if (!outputs) throw new Error('declarations')
        artifactContent = JSON.stringify(normalizeOutputSet({ instances: envelope.instances, files: envelope.files, declarations: outputs }))
      } catch { throw fail('schema_invalid', 'output_set_envelope_invalid') }
    }
    const requestCredential = kernel.hash({ attemptId, token })
    return idempotent({
      principal, capability: 'submit.output', key: idempotencyKey,
      context: { attemptId, runId: ctx.runId, productId: ctx.productId, credential },
      // 凭证并入请求指纹：即便将来有别的路径绕过前置校验，错凭证也不会命中别人的缓存结果。
      payload: { attemptId, content, artifactType, target, required, credential: requestCredential },
      execute: () => {
        // 同一 attempt 只绑定一个 jobRef：先查库里的既有绑定（含重启前的），重复提交只拿回原作业。
        const bound = jobStore.loadByAttempt(attemptId)
        if (bound) {
          const job = requireJob(bound.jobRef)
          const status = job.status === 'outcome_unknown' ? 'outcome_unknown' : 'accepted'
          return {
            operationId: `op-submit:${job.jobRef}`, status, jobRef: job.jobRef, reused: true,
            nextAction: job.status === 'outcome_unknown' ? 'reconcile' : jobNextAction(job),
          }
        }
        if (ctx.attempt.status !== 'running') throw fail('attempt_invalid', `attempt_${ctx.attempt.status}`)
        // jobRef 由 Attempt 派生：重启后引用不变，也不依赖任何进程内计数器。
        const jobRef = jobRefFor(attemptId)
        const stored = jobStore.insert({
          jobRef, attemptId, runId: ctx.runId, status: 'pending', target, required,
          artifactType, createdAt: clock(), detail: null,
          // 提交意图先落盘：即使响应丢失，重启后也能证明「这个 Attempt 被受理过」。
          intent: submissionIntent({
            attemptId, runId: ctx.runId, token, target, required, artifactType,
            contentHash: kernel.hash(artifactContent), bytes: Buffer.byteLength(artifactContent), idempotencyKey,
          }),
        })
        if (!stored.created) {
          // 并发或重启后的重复提交：库里的既有绑定优先，绝不建第二个作业。
          const job = requireJob(stored.job.jobRef)
          return {
            operationId: `op-submit:${job.jobRef}`, status: job.status === 'outcome_unknown' ? 'outcome_unknown' : 'accepted',
            jobRef: job.jobRef, reused: true,
            nextAction: job.status === 'outcome_unknown' ? 'reconcile' : jobNextAction(job),
          }
        }
        metrics.jobRefs += 1
        const job = { ...stored.job, content }
        jobs.set(jobRef, job)
        return { operationId: `op-submit:${jobRef}`, status: 'accepted', jobRef, nextAction: 'job_get' }
      },
    })
  }

  // Transport-neutral file-set envelope. Reuse submitOutput so authorization,
  // request deduplication and durable job identity cover every submitted byte.
  const submitOutputSet = ({ instances, files, contents, ...args } = {}) => {
    if (!Array.isArray(instances) || !Array.isArray(files) || !contents || typeof contents !== 'object' || Array.isArray(contents)) throw fail('schema_invalid', 'output_set_required')
    const encoded = Object.create(null)
    for (const [name, value] of Object.entries(contents)) {
      if (typeof value !== 'string' && !Buffer.isBuffer(value)) throw fail('schema_invalid', 'output_file_bytes_required')
      encoded[name] = Buffer.from(value).toString('base64')
    }
    const content = JSON.stringify({ format: 'workflow-output-set/1', instances, files, contents: encoded })
    return submitOutput({ ...args, artifactType: 'file-set', content })
  }

  const stageJobCandidate = (job, attempt, body, kind) => {
    if (kind !== 'file-set') return kernel.storeCandidate({ attemptId: job.attemptId, token: attempt.token, content: body, artifactType: kind })
    let envelope
    try { envelope = JSON.parse(body) } catch { throw fail('schema_invalid', 'output_set_envelope_invalid') }
    if (envelope?.format !== 'workflow-output-set/1' || !envelope.contents || typeof envelope.contents !== 'object' || Array.isArray(envelope.contents)) throw fail('schema_invalid', 'output_set_envelope_invalid')
    const contents = new Map()
    for (const [name, value] of Object.entries(envelope.contents)) {
      if (typeof value !== 'string') throw fail('schema_invalid', 'output_file_encoding_invalid')
      const bytes = Buffer.from(value, 'base64')
      if (bytes.toString('base64') !== value) throw fail('schema_invalid', 'output_file_encoding_invalid')
      contents.set(name, bytes)
    }
    return kernel.storeOutputSetCandidate({ attemptId: job.attemptId, token: attempt.token, instances: envelope.instances, files: envelope.files, contents })
  }

  // ---- G-05 进度 -----------------------------------------------------------
  const reportProgress = ({ principal, attemptId, idempotencyKey, percent, note = '', credential = null } = {}) => {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw fail('schema_invalid', 'percent_out_of_range')
    if (typeof note !== 'string' || note.length > 500) throw fail('schema_invalid', 'note_too_long')
    const { ctx } = guardedAttemptContext({ principal, capability: 'report.progress', attemptId, credential })
    return idempotent({
      principal, capability: 'report.progress', key: idempotencyKey,
      context: { attemptId, runId: ctx.runId, productId: ctx.productId, credential },
      payload: { attemptId, percent, note },
      execute: () => {
        kernel.appendEvent(ctx.runId, 'attempt.progress', { attemptId, percent, note })
        return { operationId: operationId('op-progress'), status: 'accepted', attemptId, percent, nextAction: 'none' }
      },
    })
  }

  const heartbeat = ({ principal, attemptId, token, credential = null } = {}) => {
    guardedAttemptContext({ principal, capability: 'report.progress', attemptId, credential })
    try { return kernel.heartbeatAttempt({ attemptId, token }) } catch (error) { throw translate(error) }
  }

  // ---- G-07 运行控制 -------------------------------------------------------
  const commandRun = ({ principal, runId, command, expectedRevision, idempotencyKey, reason = 'user_paused', credential = null } = {}) => {
    if (!['pause', 'resume', 'cancel'].includes(command)) throw fail('schema_invalid', 'command_invalid')
    if (!Number.isInteger(expectedRevision)) throw fail('schema_invalid', 'expected_revision_required')
    const { ctx } = guardedRunContext({ principal, capability: 'control.run', runId, credential })
    return idempotent({
      principal, capability: 'control.run', key: idempotencyKey,
      context: { runId, productId: ctx.productId, credential },
      payload: { runId, command, expectedRevision, reason }, fallback: 'capability_unavailable',
      execute: () => {
        const current = kernel.one('SELECT status,revision FROM workflow_runs WHERE id=?', runId)
        if (current.revision !== expectedRevision) throw fail('schema_invalid', 'expected_revision_mismatch')
        if (command === 'pause') {
          if (['completed', 'failed', 'cancelled'].includes(current.status)) return { operationId: operationId('op-pause'), status: current.status, runId, detail: 'run_closed', nextAction: 'none' }
          const result = kernel.pauseRun(runId, reason)
          return { operationId: operationId('op-pause'), status: result.status, runId, nextAction: 'resume' }
        }
        if (command === 'resume') {
          if (['running', 'created'].includes(current.status)) return { operationId: operationId('op-resume'), status: current.status, runId, detail: 'already_active', nextAction: 'claim' }
          if (['completed', 'failed', 'cancelled'].includes(current.status)) return { operationId: operationId('op-resume'), status: current.status, runId, detail: 'run_closed', nextAction: 'none' }
          const result = kernel.resume(runId)
          return { operationId: operationId('op-resume'), status: result.status, runId, nextAction: NEXT_ACTION_BY_RUN[result.status] ?? 'none' }
        }
        if (['completed', 'failed', 'cancelled'].includes(current.status)) {
          return { operationId: operationId('op-cancel'), status: current.status, runId, detail: 'run_closed', nextAction: 'none' }
        }
        kernel.cancelRun(runId)
        // 在途长任务不能假设撤销成功：未开始的作废，已发起的转未知待对账（A07/A08）。
        for (const job of jobStore.byRun(runId)) {
          if (job.status === 'pending') persist(job, { status: 'cancelled', detail: 'run_cancelled_before_start' })
          else if (['running', 'cancelling'].includes(job.status)) persist(job, { status: 'outcome_unknown', detail: 'run_cancelled_in_flight' })
        }
        return { operationId: operationId('op-cancel'), status: 'cancelled', runId, nextAction: 'none' }
      },
    })
  }

  // ---- G-08 长任务查询 / 取消 ----------------------------------------------
  const jobNextAction = job => {
    if (job.status === 'pending' || job.status === 'running') return 'job_get'
    if (job.status === 'cancelling') return 'await_host_confirmation'
    if (job.status === 'succeeded') return job.downloadFailed ? 'retry_download' : 'download'
    if (job.status === 'outcome_unknown') return 'reconcile'
    if (job.status === 'failed') return 'resume'
    return 'none'
  }

  const jobContext = ({ principal, jobRef, capability, credential = null }) => {
    // 先判凭证再查作业：未认证调用方不该从 job_not_found 得知 jobRef 是否存在（G-08）。
    const record = assertPreAuthorized(principal, capability, { credential })
    const level = PERMISSIONS[record.kind]?.[capability] ?? 'deny'
    // 「不存在」「跨产品」「不在被授予的 run/attempt」对外必须是同一个结果：一旦可区分，
    // jobRef 自己就是跨产品/跨会话的存在性预言机（G-01/G-08）。
    const hidden = () => level === 'scoped' || level === 'attempt'
      ? fail('capability_unavailable', 'run_not_authorized')
      : fail('attempt_invalid', 'job_not_found')
    // 作业以库为准：重启后内存缓存是空的，但同一 jobRef 仍须可读、可对账。
    const job = jobs.get(jobRef) ?? jobStore.load(jobRef)
    if (!job) throw hidden()
    jobs.set(jobRef, job)
    const ctx = attemptContext(job.attemptId)
    try {
      authorize({ principal, capability, context: { attemptId: job.attemptId, runId: job.runId, productId: ctx.productId, credential } })
    } catch {
      // 归属或产品不匹配与「查无此作业」同码；凭证不匹配已在上面 throw，不会走到这里。
      throw hidden()
    }
    return { job, ctx }
  }

  const getJob = ({ principal, jobRef, credential = null } = {}) => {
    assertCapabilityAllowed(principal, 'read.job')
    const { job } = jobContext({ principal, jobRef, capability: 'read.run', credential })
    return {
      operationId: operationId('op-job'),
      status: job.status,
      jobRef,
      attemptId: job.attemptId,
      artifact: job.artifact ? { snapshotId: job.artifact.snapshotId, contentHash: job.artifact.contentHash } : null,
      nextAction: jobNextAction(job),
      detail: job.detail,
    }
  }

  const cancelJob = ({ principal, jobRef, idempotencyKey, credential = null } = {}) => {
    assertCapabilityAllowed(principal, 'control.run')
    // 会话凭证必须和读接口走同一条前置判定：http-client 能 getJob 就必须能用同一凭证 cancelJob。
    const { job } = jobContext({ principal, jobRef, capability: 'control.run', credential })
    return idempotent({
      principal, capability: 'control.run', key: idempotencyKey,
      context: { attemptId: job.attemptId, runId: job.runId, productId: attemptContext(job.attemptId).productId, credential },
      payload: { jobRef }, fallback: 'capability_unavailable',
      execute: () => {
        // 取消以宿主确认为准，不以受理成功为准；重复取消不会再向宿主发一次请求。
        if (['succeeded', 'cancelled', 'failed', 'outcome_unknown', 'cancelling'].includes(job.status)) {
          return { operationId: `op-cancel-job:${jobRef}`, status: job.status, jobRef, detail: job.detail, nextAction: jobNextAction(job) }
        }
        metrics.cancelRequests += 1
        persist(job, { cancelRequests: job.cancelRequests + 1, status: 'cancelling', detail: 'cancel_requested' })
        return { operationId: `op-cancel-job:${jobRef}`, status: 'cancelling', jobRef, nextAction: 'await_host_confirmation' }
      },
    })
  }

  const downloadArtifact = ({ principal, jobRef, failOnce = false, credential = null } = {}) => {
    assertCapabilityAllowed(principal, 'read.artifact')
    const { job } = jobContext({ principal, jobRef, capability: 'read.artifact', credential })
    if (job.status !== 'succeeded' || !job.artifact) throw fail('artifact_missing', 'job_not_succeeded')
    metrics.downloads += 1
    persist(job, { downloads: job.downloads + 1 })
    // 下载失败只影响这次取件：作业与产物不变，重试不会再提交生成任务。
    if (failOnce && !job.downloadFailed) {
      persist(job, { downloadFailed: true })
      return { operationId: operationId('op-download'), status: 'failed', jobRef, error: { code: 'artifact_missing', detail: 'download_failed' }, nextAction: 'retry_download' }
    }
    let verified, files = null
    try {
      verified = kernel.readSnapshot(job.artifact.snapshotId)
      if (verified.contentHash !== job.artifact.contentHash) throw fail('artifact_missing', 'content_hash_mismatch')
      if (verified.outputSet) files = kernel.readSnapshotFiles(job.artifact.snapshotId).files.map(({ data, ...entry }) => ({ ...entry, encoding: 'base64', content: data.toString('base64') }))
    } catch (error) { throw translate(error) }
    const content = verified.content
    persist(job, { downloadFailed: false })
    return {
      operationId: operationId('op-download'),
      status: 'completed',
      jobRef,
      artifact: { snapshotId: job.artifact.snapshotId, contentHash: job.artifact.contentHash, content, outputSet: verified.outputSet, files },
      nextAction: 'none',
    }
  }

  // ---- G-09 待办列表（只读，无确认） ---------------------------------------
  const listHumanTasks = ({ principal, productId = null, credential = null } = {}) => {
    assertCapabilityAllowed(principal, 'read.run')
    const record = principals.get(principal)
    if (!record) throw fail('capability_unavailable', 'unknown_principal')
    authorize({ principal, capability: 'read.run', context: { runId: null, productId: productId ?? record.productId, credential } })
    let rows = kernel.query(`
      SELECT t.id, t.step_id, s.run_id, t.input_hash, t.task_revision, t.status, t.draft_id
      FROM workflow_human_tasks t JOIN workflow_steps s ON s.id = t.step_id ORDER BY t.rowid`)
    // 产品边界对每种身份都成立：只按 other-agent 过滤时，p2 的 UI 会拿到 p1 的待办（G-01）。
    if (record.productId) rows = rows.filter(row => runContext(row.run_id).productId === record.productId)
    if (Array.isArray(record.runIds)) rows = rows.filter(row => record.runIds.includes(row.run_id))
    rows = rows.map(row => {
      try { return { ...row, bindingVersion: kernel.inputBindingFor(row.id).version, bindingUsable: true } }
      catch (error) {
        if (!['attempt_input_unbound', 'attempt_input_invalid'].includes(error?.code)) throw translate(error)
        return { ...row, bindingVersion: null, bindingUsable: false, bindingError: { code: 'artifact_missing', detail: error.code } }
      }
    })
    return { operationId: operationId('op-human-tasks'), status: 'completed', tasks: rows, nextAction: 'none' }
  }

  // 采用前从构造期适配器读取基准；请求中的摘要、类别和 revision 均不作为证据。
  const captureDeclaredTargets = (stepId, requestedTarget = null) => {
    const declared = kernel.targetsFor(stepId)
    if (requestedTarget !== null && (declared.length !== 1 || declared[0].target !== requestedTarget)) throw fail('publish_target_invalid', 'publish_declaration_mismatch')
    return declared.map(item => ({ ...item, ...capturePublishBaseline(item.target, item.relativePath ?? null) }))
  }

  const readHumanDraft = ({ principal, runId, taskId, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    if (typeof taskId !== 'string') throw fail('artifact_missing', 'task_not_in_run')
    const task = kernel.one('SELECT t.* FROM workflow_human_tasks t JOIN workflow_steps s ON s.id=t.step_id WHERE t.id=? AND s.run_id=?', taskId, runId)
    if (!task) throw fail('artifact_missing', 'task_not_in_run')
    const draft = task.draft_id ? kernel.one('SELECT * FROM workflow_drafts WHERE id=?', task.draft_id) : null
    const binding = kernel.inputBindingFor(taskId)
    const source = binding.inputs.length === 1 ? kernel.humanInputSource(task.step_id, binding) : null
    const draftBindingVersion = draft ? Number(draft.snapshot_id.slice(`${taskId}:input:`.length)) : null
    const baselineCurrent = !draft || draft.snapshot_id === `${taskId}:input:${binding.version}`
    return { taskId, taskRevision: task.task_revision, taskStatus: task.status, draft, binding, outputSet: source?.outputSet ?? null, baselineCurrent, draftBindingVersion,
      currentInput: source ? { snapshotId: binding.inputs[0].snapshotId, content: source.content, outputSet: source.outputSet ?? null } : null }
  }

  const saveHumanDraft = ({ principal, runId, taskId, content, expectedBindingVersion, expectedTaskRevision, rebind = false, credential = null } = {}) => {
    const { record } = guardedRunContext({ principal, capability: 'confirm.human', runId, credential })
    if (record.kind !== 'ui') throw fail('human_confirm_required', 'ui_required')
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxOutputBytes) throw fail('schema_invalid', 'content_invalid')
    if (typeof taskId !== 'string' || !kernel.one('SELECT t.id FROM workflow_human_tasks t JOIN workflow_steps s ON s.id=t.step_id WHERE t.id=? AND s.run_id=?', taskId, runId)) throw fail('human_confirm_required', 'human_task_not_found')
    try { return kernel.saveDraft({ taskId, content, expectedBindingVersion, expectedTaskRevision, rebind }) } catch (error) { throw translate(error) }
  }

  const listValidations = ({ principal, runId, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    try { return { reports: kernel.listValidations(runId) } } catch (error) { throw translate(error) }
  }

  const validateHumanDraft = ({ principal, runId, taskId, content, expectedBindingVersion, expectedTaskRevision, credential = null } = {}) => {
    const { record } = guardedRunContext({ principal, capability: 'confirm.human', runId, credential })
    if (record.kind !== 'ui') throw fail('human_confirm_required', 'ui_required')
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxOutputBytes) throw fail('schema_invalid', 'content_invalid')
    if (typeof taskId !== 'string' || !kernel.one('SELECT t.id FROM workflow_human_tasks t JOIN workflow_steps s ON s.id=t.step_id WHERE t.id=? AND s.run_id=?', taskId, runId)) throw fail('human_confirm_required', 'human_task_not_found')
    try { return kernel.validateHumanDraft({ taskId, content, expectedBindingVersion, expectedTaskRevision }) } catch (error) { throw translate(error) }
  }

  const revisionIsCurrent = record => {
    try {
      const current = kernel.revisionContext({ taskId: record.taskId, expectedBindingVersion: record.bindingVersion, expectedTaskRevision: record.taskRevision })
      return current.baseSnapshotId === record.baseSnapshotId && current.baseDraftId === record.baseDraftId && current.baseContentHash === record.baseContentHash
    } catch (error) {
      if (['cas_conflict', 'input_binding_stale', 'input_fingerprint_conflict', 'human_task_unavailable', 'attempt_input_unbound', 'attempt_input_invalid'].includes(error.code)) return false
      throw error
    }
  }
  const listRevisionRequests = ({ principal, runId, credential = null } = {}) => {
    const { record } = guardedRunContext({ principal, capability: 'confirm.human', runId, credential })
    if (record.kind !== 'ui') throw fail('human_confirm_required', 'ui_required')
    try {
      const requests = revisionStore.list({ runId }).map(item => {
        if (['requested', 'producing', 'ready'].includes(item.status) && !revisionIsCurrent(item)) return { ...item, status: 'superseded', baselineCurrent: false }
        return item
      })
      return { requests }
    } catch (error) { throw translate(error) }
  }
  // Deterministic offline producer, deliberately separate from model Attempts.
  const requestRevision = ({ principal, runId, taskId, expectedBindingVersion, expectedTaskRevision, note, retained = [], idempotencyKey, credential = null } = {}) => {
    const { record: actor } = guardedRunContext({ principal, capability: 'confirm.human', runId, credential })
    if (actor.kind !== 'ui') throw fail('human_confirm_required', 'ui_required')
    if (typeof note !== 'string' || !note.trim() || Buffer.byteLength(note) > 4096 || typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.includes(':') || !Array.isArray(retained) || new Set(retained).size !== retained.length) throw fail('schema_invalid', 'revision_request_invalid')
    if (!kernel.one('SELECT t.id FROM workflow_human_tasks t JOIN workflow_steps s ON s.id=t.step_id WHERE t.id=? AND s.run_id=?', taskId, runId)) throw fail('human_confirm_required', 'human_task_not_found')
    let request
    try {
      const step = kernel.one('SELECT step_id FROM workflow_human_tasks WHERE id=?', taskId)
      const prior = revisionStore.get(revisionIdFor({ runId, stepId: step.step_id, createdBy: actor.id, requestKey: idempotencyKey }))
      if (prior) {
        if (prior.taskId !== taskId || prior.taskRevision !== expectedTaskRevision || prior.bindingVersion !== expectedBindingVersion || prior.opinion.note !== note || JSON.stringify(prior.opinion.retained) !== JSON.stringify([...retained].sort())) throw fail('schema_invalid', 'revision_request_conflict')
        return prior
      }
      request = kernel.beginRevisionRequest({ taskId, expectedBindingVersion, expectedTaskRevision }, context => {
        if (!context.baseDraftId) throw fail('schema_invalid', 'revision_saved_draft_required')
        const paths = new Set(context.outputSet?.files.map(file => file.relativePath) ?? [])
        if (retained.some(path => typeof path !== 'string' || !paths.has(path))) throw fail('schema_invalid', 'revision_retained_invalid')
        return revisionStore.save({ ...context, createdBy: actor.id, requestKey: idempotencyKey, opinion: { by: actor.id, note, disposition: 'request_revision', retained }, retained }).record
      })
      request = revisionStore.save({ id: request.id, expectStatus: 'requested', status: 'producing' }).record
      const context = kernel.revisionContext({ taskId, expectedBindingVersion, expectedTaskRevision })
      const source = kernel.readSnapshot(context.baseSnapshotId)
      const suffix = `\n\nDevelopment revision: ${note}\n`
      let candidate
      if (context.outputSet) {
        const files = context.outputSet.files.map(file => {
          const owner = context.outputSet.outputs.find(output => output.files.includes(file.relativePath))
          if (retained.includes(file.relativePath) || !owner?.editable || !(file.mediaType.startsWith('text/') && file.mediaType !== 'application/json') || owner.artifactType === 'json') return file
          const bytes = readOutputObject({ root: kernel.root, hash: file.hash, bytes: file.bytes })
          const content = bytes.toString('utf8') + suffix
          if (Buffer.byteLength(content) > maxOutputBytes) throw fail('schema_invalid', 'content_invalid')
          const stored = putOutputObject({ root: kernel.root, bytes: content })
          return { ...file, hash: stored.hash, bytes: Buffer.byteLength(content) }
        })
        const set = normalizeOutputSet({ instances: context.outputSet.outputs, files })
        candidate = { artifactType: 'file-set', outputSet: set }
      } else {
        if (source.artifactType === 'json') throw fail('capability_unavailable', 'development_json_revision_unsupported')
        candidate = { artifactType: source.artifactType, content: context.content + suffix }
      }
      const content = candidate.outputSet ? JSON.stringify(candidate.outputSet) : candidate.content
      if (Buffer.byteLength(content) > maxOutputBytes) throw fail('schema_invalid', 'content_invalid')
      const report = kernel.validateHumanDraft({ taskId, content, expectedBindingVersion, expectedTaskRevision, producedBy: `revision-request:${request.id}` })
      if (!revisionIsCurrent(request)) return revisionStore.save({ id: request.id, expectStatus: 'producing', status: 'superseded' }).record
      return revisionStore.save({ id: request.id, expectStatus: 'producing', status: report.status === 'pass' ? 'ready' : 'failed', candidate, reportId: report.id, ...(report.status === 'pass' ? {} : { errorCode: 'revision_validation_failed' }) }).record
    } catch (error) {
      if (request && ['requested', 'producing'].includes(request.status)) revisionStore.save({ id: request.id, expectStatus: request.status, status: 'failed', errorCode: String(error.detail ?? error.code ?? 'revision_failed').slice(0, 128) })
      throw translate(error)
    }
  }
  const applyRevisionCandidate = ({ principal, runId, requestId, credential = null } = {}) => {
    const { record: actor } = guardedRunContext({ principal, capability: 'confirm.human', runId, credential })
    if (actor.kind !== 'ui') throw fail('human_confirm_required', 'ui_required')
    try {
      const request = revisionStore.get(requestId)
      if (!request || request.runId !== runId) throw fail('artifact_missing', 'revision_not_in_run')
      if (request.status === 'applied') return request
      if (request.status !== 'ready') throw fail('schema_invalid', 'revision_not_ready')
      if (!revisionIsCurrent(request)) {
        revisionStore.save({ id: request.id, expectStatus: 'ready', status: 'superseded' })
        throw fail('human_confirm_required', 'revision_baseline_stale')
      }
      const saved = kernel.applyRevisionDraft({ baseline: request, content: request.candidate.content }, () => revisionStore.save({ id: request.id, expectStatus: 'ready', status: 'applied' }))
      return { ...saved, request: revisionStore.get(request.id) }
    } catch (error) { throw translate(error) }
  }

  const readHumanDraftFile = ({ principal, runId, taskId, relativePath, expectedBindingVersion, expectedTaskRevision, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    if (typeof taskId !== 'string' || typeof relativePath !== 'string' || !kernel.one('SELECT t.id FROM workflow_human_tasks t JOIN workflow_steps s ON s.id=t.step_id WHERE t.id=? AND s.run_id=?', taskId, runId)) throw fail('artifact_missing', 'task_not_in_run')
    try { return kernel.readDraftFile({ taskId, relativePath, expectedBindingVersion, expectedTaskRevision }) } catch (error) { throw translate(error) }
  }

  const saveHumanDraftFile = ({ principal, runId, taskId, relativePath, content, expectedBindingVersion, expectedTaskRevision, credential = null } = {}) => {
    const { record } = guardedRunContext({ principal, capability: 'confirm.human', runId, credential })
    if (record.kind !== 'ui') throw fail('human_confirm_required', 'ui_required')
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxOutputBytes || typeof relativePath !== 'string') throw fail('schema_invalid', 'content_invalid')
    if (typeof taskId !== 'string' || !kernel.one('SELECT t.id FROM workflow_human_tasks t JOIN workflow_steps s ON s.id=t.step_id WHERE t.id=? AND s.run_id=?', taskId, runId)) throw fail('human_confirm_required', 'human_task_not_found')
    try { return kernel.saveDraftFile({ taskId, relativePath, content, expectedBindingVersion, expectedTaskRevision }) } catch (error) { throw translate(error) }
  }

  const rerunVersion = ({ principal, runId, stepId, expectedRunRevision, expectedStepRevision, credential = null } = {}) => {
    const { record } = guardedRunContext({ principal, capability: 'control.run', runId, credential })
    if (record.kind !== 'ui') throw fail('human_confirm_required', 'ui_required')
    if (typeof stepId !== 'string' || !kernel.one('SELECT id FROM workflow_steps WHERE id=? AND run_id=?', stepId, runId)) throw fail('artifact_missing', 'step_not_found')
    try { return kernel.rerunStep({ stepId, expectedRunRevision, expectedStepRevision }) }
    catch (error) { throw translate(error) }
  }

  const restoreVersion = ({ principal, runId, stepId, sourceAdoptionId, reason, expectedRunRevision, expectedStepRevision, idempotencyKey, credential = null } = {}) => {
    const { record } = guardedRunContext({ principal, capability: 'control.run', runId, credential })
    if (record.kind !== 'ui') throw fail('human_confirm_required', 'ui_required')
    if (!kernel.one('SELECT id FROM workflow_steps WHERE id=? AND run_id=?', stepId, runId)) throw fail('artifact_missing', 'step_not_found')
    try {
      return kernel.restoreAdoption({ stepId, sourceAdoptionId, reason, actorId: record.id, expectedRunRevision, expectedStepRevision, idempotencyKey, publishTargets: captureDeclaredTargets(stepId) })
    } catch (error) { throw translate(error) }
  }

  const forkHistory = ({ principal, runId, newRunId, reason, expectedRunRevision, idempotencyKey, credential = null } = {}) => {
    const { record } = guardedRunContext({ principal, capability: 'control.run', runId, credential })
    if (record.kind !== 'ui') throw fail('human_confirm_required', 'ui_required')
    try { return kernel.forkRun({ sourceRunId: runId, id: newRunId, reason, actorId: record.id, expectedRunRevision, idempotencyKey }) }
    catch (error) { throw translate(error) }
  }

  const compareVersions = ({ principal, runId, leftId, rightId, credential = null } = {}) => {
    guardedRunContext({ principal, capability: 'read.artifact', runId, credential })
    for (const id of [leftId, rightId]) {
      if (typeof id !== 'string' || !kernel.one('SELECT a.id FROM workflow_adoptions a JOIN workflow_steps s ON s.id=a.step_id WHERE a.snapshot_id=? AND s.run_id=?', id, runId)) throw fail('artifact_missing', 'snapshot_not_found')
    }
    try { return kernel.compareSnapshots(leftId, rightId) } catch (error) { throw translate(error, 'artifact_missing') }
  }

  // 文件目标以原始字节为证据；文本目标保留既有 content 契约。
  // 适配器同步调用，Promise/不完整观测均拒绝，不用其自报摘要替代实际内容。
  const observeTarget = (target, relativePath = null) => {
    if (typeof targetAdapter?.read !== 'function') throw new Error('target_adapter_unavailable')
    const value = targetAdapter.read(target, relativePath)
    if (!value || !Number.isSafeInteger(value.revision) || (relativePath && value.relativePath !== relativePath)) throw new Error('target_observation_invalid')
    const bytes = relativePath
      ? (Buffer.isBuffer(value.data) ? value.data : typeof value.content === 'string' ? Buffer.from(value.content, 'utf8') : null)
      : (typeof value.content === 'string' ? Buffer.from(value.content, 'utf8') : null)
    if (!bytes) throw new Error('target_observation_invalid')
    return { target, ...(relativePath ? { relativePath } : {}), revision: value.revision, contentHash: fileBytesDigest(bytes) }
  }

  const capturePublishBaseline = (target, relativePath = null) => {
    if (!target) return {}
    try {
      if (typeof targetAdapter?.read !== 'function' || (relativePath === null && typeof targetAdapter?.kindOf !== 'function')) throw new Error('target_adapter_unavailable')
      const targetKind = relativePath === null ? targetAdapter.kindOf(target) : 'file_hash'
      if (!['raw_text', 'domain_revision', 'file_hash'].includes(targetKind)) throw new Error('target_observation_invalid')
      const observed = observeTarget(target, relativePath)
      return { targetKind, baseRevision: observed.revision, baseContentHash: observed.contentHash }
    } catch (error) { throw fail('capability_unavailable', error?.message ?? 'target_unavailable') }
  }

  // ---- 人工确认：只有受认证 UI 通道 --------------------------------------------------
  const confirmHumanTask = ({ principal, taskId, content, expectedBindingVersion, inputFingerprint, expectedRunRevision, expectedTaskRevision = 1, idempotencyKey, target = null, required = true, baseRevision = 1, credential = null, actorId = null, validationReportId = null, intent = 'continue' } = {}) => {
    if (typeof content !== 'string') throw fail('schema_invalid', 'content_required')
    // A10：意图是输入，先判值域，再谈授权与对象。
    if (!['continue', 'pause'].includes(intent)) throw fail('schema_invalid', 'intent_invalid')
    // A16/A17/A35/A39：人工身份只认受认证会话本身。请求体里带别的 actorId 一律拒绝，
    // 否则 Agent 只要伪造一个 human 字段就拿到了人工身份。
    if (actorId !== null && actorId !== undefined && actorId !== principal) throw fail('schema_invalid', 'actor_id_not_authenticated')
    assertPreAuthorized(principal, 'confirm.human', { credential })
    // 跨产品现存 task 与不存在的 task 必须同一结果，否则 taskId 本身成为存在性预言机（G-01）。
    const taskHidden = () => fail('human_confirm_required', 'human_task_not_found')
    if (typeof taskId !== 'string' || taskId.length === 0) throw taskHidden()
    const task = kernel.one('SELECT * FROM workflow_human_tasks WHERE id=?', taskId)
    if (!task) throw taskHidden()
    const step = kernel.one('SELECT * FROM workflow_steps WHERE id=?', task.step_id)
    if (!step) throw taskHidden()
    const ctx = runContext(step.run_id)
    try {
      authorize({ principal, capability: 'confirm.human', context: { runId: step.run_id, productId: ctx.productId, credential } })
    } catch (error) {
      if (error?.code === 'capability_unavailable') throw taskHidden()
      throw error
    }
    try { kernel.assertBindingVersion(taskId, expectedBindingVersion) } catch (error) { throw translate(error) }
    return idempotent({
      principal, capability: 'confirm.human', key: idempotencyKey,
      context: { runId: step.run_id, productId: ctx.productId, credential },
      payload: { taskId, content, expectedBindingVersion, inputFingerprint, expectedRunRevision, expectedTaskRevision, target, required, baseRevision, validationReportId, intent },
      fallback: 'capability_unavailable',
      execute: () => {
        const result = kernel.confirmHuman({
          // 身份取自已认证会话，不取请求体（上面已拒绝不一致的 actorId）。
          taskId, content, expectedBindingVersion, actorId: principal,
          inputFingerprint, expectedRunRevision, expectedTaskRevision,
          idempotencyKey: `confirm:${taskId}:${expectedTaskRevision}`,
          target, required, validationReportId, intent, publishTargets: captureDeclaredTargets(step.id, target),
        })
        return {
          operationId: result.operationId, status: 'completed', adoptionId: result.adoptionId,
          snapshotId: result.snapshotId, intent,
          nextAction: intent === 'pause' ? 'resume' : 'claim',
        }
      },
    })
  }

  // ---- 宿主侧（进程内，不暴露为工具：G-10 人工确认 / 正式发布不开放） -------
  const requireJob = jobRef => {
    // 先查库：重启后同一 jobRef 仍须可读，否则对账入口连对象都拿不到。
    const job = jobs.get(jobRef) ?? jobStore.load(jobRef)
    if (!job) throw fail('attempt_invalid', 'job_not_found')
    jobs.set(jobRef, job)
    return job
  }

  // 节点实际拿到的输入：按父快照指针解析上一步已采用的快照，并从对象库读回内容。
  // 这不是结构断言——下游要消费的就是这份磁盘内容，上游缺文件/被篡改会当场报 artifact_missing（A01/A37）。
  // 只有运行中的 Attempt 才有「正在消费的输入」；已终结的 Attempt 再问输入属于契约外调用。
  const hostInputFor = (attemptId) => {
    const attempt = kernel.one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt) throw fail('attempt_invalid', 'attempt_not_found')
    if (attempt.status !== 'running') throw fail('attempt_invalid', `attempt_${attempt.status}`)
    const step = kernel.one('SELECT * FROM workflow_steps WHERE id=?', attempt.step_id)
    if (!step) throw fail('artifact_missing', 'step_not_found')
    let binding
    try { binding = kernel.inputBindingFor(attemptId) }
    catch (error) { throw fail('artifact_missing', error.code ?? 'attempt_input_unbound') }
    const frozenInput = binding.inputs[0] ?? null
    const snapshotId = frozenInput?.snapshotId ?? null
    if (!snapshotId) return { attemptId, snapshotId: null, contentHash: null, authorType: null, content: null }
    // 完整性用内核的只读校验（manifest / 身份 / 类型 / 对象 / 字节四方对齐），不在服务里另写一套半吊子检查：
    // 只改库里的行指针或只改磁盘对象，都必须在这里当场失败，不能把脏内容当输入发下去。
    let verified
    try {
      verified = kernel.readSnapshot(snapshotId)
      if (verified.contentHash !== frozenInput.contentHash) throw fail('artifact_missing', 'parent_content_mismatch:frozen_input_hash')
    } catch (error) {
      // 内核的错误把细节放在 message 里（没有 detail 字段），服务侧统一折算成一个可读的原因尾段。
      const reason = error?.detail ?? error?.message ?? error?.code ?? 'unavailable'
      if (error?.code === 'snapshot_not_found') throw fail('artifact_missing', 'parent_snapshot_missing')
      if (error?.code === 'snapshot_object_missing') throw fail('artifact_missing', `parent_object_missing:${reason}`)
      if (String(error?.code).startsWith('snapshot_') || String(error?.code).startsWith('output_object_')) throw fail('artifact_missing', `parent_content_mismatch:${reason}`)
      throw error
    }
    return { attemptId, snapshotId, contentHash: verified.contentHash, authorType: verified.authorType, content: verified.content }
  }

  // 节点硬失败：由假执行器自己把原因写回内核（Attempt 终结 + 步骤 paused + 运行 paused + attempt.failed 事件），
  // 不是让测试调 pause 冒充；租约到期也因此救不回一条已记录原因的暂停运行（A37）。
  const failNodeAttempt = (attemptId, reason) => {
    try { kernel.markFailed(attemptId, reason) } catch (error) {
      if (error?.code !== 'attempt_not_found') throw error
    }
    return { attemptId, reason }
  }

  // 假节点的确定性输出：只由「从对象库读回的上游内容」与节点 id 决定，调用方无法预置 content。
  const renderNodeOutput = ({ nodeId, input, pad = 0 }) => {
    const upstream = input.content === null ? '(no upstream snapshot)' : input.content
    const body = `[${nodeId}]\n${upstream}`
    return pad > 0 ? `${body}${'x'.repeat(pad)}` : body
  }

  // 假执行器跑一个节点：读输入 → 由输入算出输出 → 作为节点 Agent 提交 → 宿主执行。
  // 输入链断开或输出不合契约时，原因写进内核并停止，不留一个还能被续跑的在途 Attempt。
  const hostRunNode = (attemptId, { principal = 'node-1', pad = 0, target = null, required = true } = {}) => {
    const attempt = kernel.one('SELECT * FROM workflow_attempts WHERE id=?', attemptId)
    if (!attempt) throw fail('attempt_invalid', 'attempt_not_found')
    if (attempt.status !== 'running') throw fail('attempt_invalid', `attempt_${attempt.status}`)
    const step = kernel.one('SELECT * FROM workflow_steps WHERE id=?', attempt.step_id)
    if (!step) throw fail('attempt_invalid', 'step_not_found')

    let input
    try {
      input = hostInputFor(attemptId)
    } catch (error) {
      if (error?.code === 'artifact_missing') failNodeAttempt(attemptId, `input_${error.detail ?? 'unavailable'}`)
      throw error
    }

    let context = null
    try {
      const capture = kernel.definitionFor(step.run_id).contextCapture
      if (capture != null) {
        if (capture.spec?.productId !== runContext(step.run_id).productId) throw fail('context_invalid', 'capture_product_mismatch')
        context = assembleCapturedContext({ root: kernel.root, capture, runId: step.run_id, attemptId, nodeId: step.node_id, binding: kernel.inputBindingFor(attemptId) })
        if (!context || typeof context.payload !== 'string' || !context.manifest || !context.receipt || context.receipt.verification !== 'captured') throw fail('context_invalid', 'captured_context_required')
        kernel.appendEvent(step.run_id, 'attempt.context_captured', { attemptId, manifest: context.manifest, receipt: context.receipt, payload: context.payload })
      }
    } catch (error) {
      failNodeAttempt(attemptId, `context_${error.code ?? 'unavailable'}`)
      throw error
    }
    let content
    let submit
    try {
      const node = kernel.definitionFor(step.run_id).steps.find(item => item.nodeId === step.node_id)
      if (node?.executor === 'tool-service') {
        const result = executeFakeCapability({ node, content: input.content ?? '', attemptId,
          record: (type, payload) => kernel.appendEvent(step.run_id, type, payload) })
        content = result.outputs.content
      } else {
        content = renderNodeOutput({ nodeId: step.node_id, input: context ? { ...input, content: `${context.payload}\n\n${input.content ?? '(no upstream snapshot)'}` } : input, pad })
      }
      if (node?.executor === 'development-file-set') {
        // Fixed offline example; no paths or executable content supplied by the page.
        const contents = { 'draft.txt': content, 'notes.txt': 'Development review notes\n' }
        const files = Object.entries(contents).map(([relativePath, value]) => ({
          relativePath, hash: fileBytesDigest(Buffer.from(value, 'utf8')), bytes: Buffer.byteLength(value), mediaType: 'text/plain',
        }))
        submit = submitOutputSet({ principal, attemptId, token: attempt.token, target, required,
          idempotencyKey: `submit:${attemptId}`, contents, files,
          instances: node.outputs[0].multiplicity === 'many'
            ? files.map(file => ({ ...node.outputs[0], files: [file.relativePath] }))
            : [{ ...node.outputs[0], files: files.map(file => file.relativePath) }],
        })
      } else submit = submitOutput({
        principal, attemptId, token: attempt.token, content, target, required,
        idempotencyKey: `submit:${attemptId}`,
      })
    } catch (error) {
      // 契约级硬失败（例如输出超过上限）：作业根本不会产生，但这次执行失败必须留痕并停下。
      failNodeAttempt(attemptId, `output_${error.detail ?? error.code ?? 'invalid'}`)
      throw error
    }
    const executed = host.executeJob(submit.jobRef)
    return { input, content, jobRef: submit.jobRef, executed }
  }

  const host = Object.freeze({
    claimRun: (runId, input = { fixture: true }) => kernel.claim(runId, input),
    inputFor: hostInputFor,
    runNode: hostRunNode,
    registerRunProduct: (runId, productId) => { runProducts.set(runId, productId); return { runId, productId } },
    outboxFor: runId => kernel.query(`
      SELECT o.* FROM workflow_outbox o
      JOIN workflow_adoptions a ON a.id = o.adoption_id
      JOIN workflow_steps s ON s.id = a.step_id
      WHERE s.run_id=? ORDER BY o.rowid`, runId),
    executeJob: (jobRef, { outcome = 'succeeded', content = null, artifactType = null, withArtifact = false } = {}) => {
      const job = requireJob(jobRef)
      const body = content ?? job.content ?? 'fake output'
      const kind = artifactType ?? job.artifactType ?? 'text'
      if (['succeeded', 'failed', 'cancelled', 'outcome_unknown', 'cancelling'].includes(job.status)) {
        return { jobRef, status: job.status, hostCalls: job.hostCalls, detail: 'job_closed' }
      }
      const attempt = kernel.one('SELECT * FROM workflow_attempts WHERE id=?', job.attemptId)
      if (!attempt || attempt.status !== 'running') {
        persist(job, { status: 'cancelled', detail: 'attempt_closed_before_execution' })
        return { jobRef, status: 'cancelled', hostCalls: job.hostCalls, detail: job.detail }
      }
      metrics.hostExecutions += 1
      persist(job, { status: 'running', hostCalls: job.hostCalls + 1 })
      if (outcome === 'outcome_unknown') {
        if (withArtifact) {
          try {
            const staged = stageJobCandidate(job, attempt, body, kind)
            persist(job, { artifact: { snapshotId: staged.snapshotId, contentHash: staged.contentHash, manifestHash: staged.manifestHash, content: staged.content } })
          } catch (error) {
            kernel.markUnknown(job.attemptId, 'candidate_unavailable')
            persist(job, { status: 'outcome_unknown', detail: 'candidate_unavailable' })
            throw translate(error)
          }
        }
        try { kernel.markUnknown(job.attemptId, 'outcome_unknown') } catch (error) { throw translate(error) }
        persist(job, { status: 'outcome_unknown', detail: 'acceptance_unconfirmed' })
        return { jobRef, status: 'outcome_unknown', hostCalls: job.hostCalls, detail: job.detail }
      }
      if (outcome === 'failed') {
        persist(job, { status: 'failed', detail: 'host_reported_failure' })
        try { kernel.markFailed(job.attemptId, 'fake_service_failed') } catch (error) { throw translate(error) }
        return { jobRef, status: 'failed', hostCalls: job.hostCalls, detail: job.detail }
      }
      let publishBaseline
      try { publishBaseline = { publishTargets: captureDeclaredTargets(attempt.step_id, job.target) } } catch (error) {
        // 尚未生成候选或采用；先持久化隔离，再开放既有显式对账入口。
        try { kernel.markUnknown(job.attemptId, 'baseline_unavailable') } catch (isolationError) { throw translate(isolationError) }
        persist(job, { status: 'outcome_unknown', detail: 'baseline_unavailable' })
        throw translate(error)
      }
      let candidate
      try { candidate = stageJobCandidate(job, attempt, body, kind) } catch (error) {
        kernel.markUnknown(job.attemptId, 'candidate_unavailable')
        persist(job, { status: 'outcome_unknown', detail: 'candidate_unavailable' })
        throw translate(error)
      }
      persist(job, { artifact: { snapshotId: candidate.snapshotId, contentHash: candidate.contentHash, manifestHash: candidate.manifestHash, content: candidate.content } })
      // 作业成功必须在持久采用完成后登记。
      let adopted
      try { adopted = kernel.adopt({ attemptId: job.attemptId, token: attempt.token, candidate, target: job.target, required: job.required, ...publishBaseline }) }
      catch (error) {
        kernel.markUnknown(job.attemptId, 'adoption_failed')
        persist(job, { status: 'outcome_unknown', detail: 'adoption_failed' })
        throw translate(error)
      }
      if (adopted?.status === 'failed') {
        persist(job, { status: 'failed', detail: 'automatic_validation_failed', validationReportId: adopted.validationReportId, artifact: { ...job.artifact, ...adopted.candidate, content: job.artifact?.content ?? null } })
        return { jobRef, status: 'failed', hostCalls: job.hostCalls, detail: job.detail, validationReportId: job.validationReportId }
      }
      persist(job, {
        status: 'succeeded', detail: 'host_confirmed',
        adoptionId: adopted.adoptionId, outboxIds: adopted.outboxIds, outboxId: adopted.outboxIds[0] ?? null,
      })
      return { jobRef, status: 'succeeded', hostCalls: job.hostCalls, adoptionId: adopted.adoptionId, outboxId: job.outboxId, outboxIds: job.outboxIds }
    },
    reconcileJob: (jobRef, outcome) => {
      const job = requireJob(jobRef)
      if (job.status !== 'outcome_unknown') throw fail('outcome_unknown', 'job_not_reconcilable')
      if (!['executed', 'not_executed'].includes(outcome)) throw fail('schema_invalid', 'reconcile_outcome_invalid')
      try { kernel.reconcileUnknown(job.attemptId, outcome) } catch (error) { throw translate(error) }
      if (outcome === 'executed') {
        // 只有真的补采用成功才算作业成功；运行已取消时对账只记账，不采用也不复活（A07）。
        const snapshot = kernel.one('SELECT * FROM workflow_snapshots WHERE source_attempt_id=? ORDER BY rowid DESC LIMIT 1', job.attemptId)
        if (snapshot) {
          persist(job, {
            status: 'succeeded', detail: 'reconciled_executed',
            artifact: { snapshotId: snapshot.id, contentHash: snapshot.content_hash, manifestHash: snapshot.manifest_hash, content: job.artifact?.content ?? null },
          })
        } else {
          persist(job, { status: 'cancelled', detail: 'reconciled_not_adopted' })
        }
      } else {
        persist(job, { status: 'cancelled', detail: 'reconciled_not_executed' })
      }
      return { jobRef, status: job.status, detail: job.detail }
    },
    confirmJobCancel: (jobRef, confirmed = true) => {
      const job = requireJob(jobRef)
      if (job.status !== 'cancelling') return { jobRef, status: job.status, detail: 'no_cancel_pending' }
      persist(job, { cancelConfirmed: confirmed === true })
      if (confirmed) {
        // 宿主确认取消：该 Attempt 真正终结，步骤退回可领取、运行暂停等显式继续。
        try { kernel.cancelAttempt(job.attemptId, 'job_cancelled_by_host') } catch (error) { throw translate(error) }
        persist(job, { status: 'cancelled', detail: 'host_confirmed_cancel' })
      } else {
        try { kernel.markUnknown(job.attemptId, 'cancel_unconfirmed') } catch (error) { throw translate(error) }
        persist(job, { status: 'outcome_unknown', detail: 'cancel_unconfirmed' })
      }
      return { jobRef, status: job.status, detail: job.detail }
    },
    publish: ({ principal, outboxId } = {}) => {
      // 先判身份再解析对象：无权发布会话不该从错误码推断 outbox 是否存在。
      assertCapabilityAllowed(principal, 'publish.official')
      // 发布同样受产品边界约束：按 outbox 反查它所属的 run 与产品，再判产品归属。
      const row = kernel.one(`
        SELECT s.run_id FROM workflow_outbox o
        JOIN workflow_adoptions a ON a.id = o.adoption_id
        JOIN workflow_steps s ON s.id = a.step_id
        WHERE o.id=?`, outboxId)
      if (!row) throw fail('artifact_missing', 'outbox_not_found')
      authorize({ principal, capability: 'publish.official', context: { runId: row.run_id, productId: runContext(row.run_id).productId } })
      try {
        const evidence = kernel.one('SELECT o.*,a.snapshot_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id WHERE o.id=?', outboxId)
        if (!evidence || !['raw_text', 'domain_revision', 'file_hash'].includes(evidence.target_kind) || !evidence.base_hash || !evidence.expected_hash) throw fail('capability_unavailable', 'publish_evidence_required')
        if (evidence.status !== 'pending') throw fail('outbox_not_claimable')
        if (typeof targetAdapter?.read !== 'function' || typeof targetAdapter?.write !== 'function') throw fail('capability_unavailable', 'target_adapter_unavailable')
        const source = evidence.relative_path
          ? kernel.readSnapshotFiles(evidence.snapshot_id).files.find(file => file.relativePath === evidence.relative_path)
          : (() => { const snapshot = kernel.readSnapshot(evidence.snapshot_id); return { content: snapshot.content, hash: snapshot.contentHash } })()
        if (!source || source.hash !== evidence.expected_hash || (evidence.relative_path && !Buffer.isBuffer(source.data))) throw fail('artifact_missing', 'publish_source_invalid')
        // 所有可失败的内容准备放在领取之前，避免未发起写入就遗留 running。
        const payload = evidence.relative_path ? Buffer.from(source.data) : source.content
        const writeOptions = {
          relativePath: evidence.relative_path ?? null,
          expectedRevision: evidence.base_revision,
          expectedHash: evidence.base_hash,
          targetKind: evidence.target_kind,
          idempotencyKey: evidence.id,
        }
        const claim = kernel.claimOutbox(outboxId, { observe: observeTarget })
        if (claim.effect === 'already_applied') return claim
        let result, observed
        try {
          result = targetAdapter.write(evidence.target, payload, writeOptions)
          // 异步适配器不属于本同步假服务契约，效果可能仍在途中。
          if (result && typeof result.then === 'function') throw new Error('asynchronous_target_adapter_unsupported')
          observed = observeTarget(evidence.target, evidence.relative_path ?? null)
        } catch (error) {
          kernel.completeOutbox(outboxId, 'outcome_unknown', 'publish_effect_ambiguous', claim.claimGeneration)
          throw fail('outcome_unknown', error?.message ?? 'adapter_write_or_readback_failed')
        }
        const unchanged = observed.contentHash === evidence.base_hash &&
          (evidence.target_kind !== 'domain_revision' || observed.revision === evidence.base_revision)
        // 只有实际读回的预期字节可证明成功；失败/冲突也须读回证明没有预期效果。
        const status = observed.contentHash === evidence.expected_hash ? 'succeeded'
          : !unchanged || result?.status === 'conflict' ? 'conflict'
          : result?.status === 'failed' ? 'failed' : 'outcome_unknown'
        const reason = status === 'succeeded' ? 'readback_verified'
          : status === 'conflict' ? 'readback_conflict'
          : status === 'failed' ? 'adapter_failed_no_effect' : 'adapter_result_unconfirmed'
        const settled = kernel.completeOutbox(outboxId, status, reason, claim.claimGeneration)
        return { ...settled, claimGeneration: claim.claimGeneration }
      } catch (error) { throw translate(error) }
    },
  })

  const retryPublish = ({ principal, outboxId, credential = null } = {}) => {
    const record = assertPreAuthorized(principal, 'control.run', { credential })
    if (!['ui', 'scheduler'].includes(record.kind)) throw fail('capability_unavailable', `${record.kind}_may_not_retry_publish`)
    if (typeof outboxId !== 'string' || !outboxId) throw fail('artifact_missing', 'run_not_found')
    const row = kernel.one('SELECT s.run_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE o.id=?', outboxId)
    guardedRunContext({ principal, capability: 'control.run', runId: row?.run_id, credential })
    try { return { status: kernel.retryOutbox(outboxId) } } catch (error) { throw translate(error) }
  }

  // M1 显式隔离入口：仅 UI/调度器，身份来自注册表，不采信请求 actorId。
  const declarePublishUnknown = ({ principal, outboxId, claimGeneration, reason, credential = null } = {}) => {
    const record = assertPreAuthorized(principal, 'control.run', { credential })
    if (!['ui', 'scheduler'].includes(record.kind)) throw fail('capability_unavailable', `${record.kind}_may_not_declare_publish_unknown`)
    if (typeof outboxId !== 'string' || !outboxId) throw fail('artifact_missing', 'run_not_found')
    const row = kernel.one('SELECT s.run_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE o.id=?', outboxId)
    guardedRunContext({ principal, capability: 'control.run', runId: row?.run_id, credential })
    try {
      return kernel.markOutboxUnknown(outboxId, { actorId: record.id, reason, claimGeneration })
    } catch (error) { throw translate(error) }
  }

  const reconcilePublishEffect = ({ principal, outboxId, claimGeneration, credential = null } = {}) => {
    const record = assertPreAuthorized(principal, 'control.run', { credential })
    if (!['ui', 'scheduler'].includes(record.kind)) throw fail('capability_unavailable', `${record.kind}_may_not_reconcile_publish_effect`)
    if (typeof outboxId !== 'string' || !outboxId) throw fail('artifact_missing', 'run_not_found')
    const row = kernel.one('SELECT s.run_id FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE o.id=?', outboxId)
    guardedRunContext({ principal, capability: 'control.run', runId: row?.run_id, credential })
    try {
      return kernel.reconcilePublishEffect(outboxId, { actorId: record.id, claimGeneration, observe: observeTarget })
    } catch (error) { throw translate(error) }
  }

  const state = () => ({
    principals: [...principals.values()].map(({ id, kind, productId }) => ({ id, kind, productId })),
    jobs: jobStore.list().map(job => ({ ...job, artifact: job.artifact ? { snapshotId: job.artifact.snapshotId, contentHash: job.artifact.contentHash } : null })),
    recovered: recoveredJobs.map(entry => ({ ...entry })),
    operations: operations.size,
    metrics: { ...metrics },
  })

  return {
    registerPrincipal, startRun, getRun, readDefinition, listArtifacts, readArtifact, listEvents, listAdoptions, preflightContext, readAttemptInput, readTaskInput,
    readHumanDraft, readHumanDraftFile, saveHumanDraft, saveHumanDraftFile, validateHumanDraft, listValidations, requestRevision, listRevisionRequests, applyRevisionCandidate, rerunVersion, restoreVersion, forkHistory, compareVersions,
    submitOutput, submitOutputSet, reportProgress, heartbeat, commandRun, getJob, cancelJob, downloadArtifact,
    listHumanTasks, confirmHumanTask, retryPublish, declarePublishUnknown, reconcilePublishEffect, host, state,
  }
}
