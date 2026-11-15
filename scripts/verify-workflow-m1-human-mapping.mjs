// W1-10 具名人工输入映射专项验证（happy-4.1 独立复核，唯一新增文件）。
// 两段：
//   1) 纯函数：mapHumanInputSet / validateHumanInputMapping 的同名直连、具名单选、many 整组改名、
//      类型与 schema 不符、只读冲突、映射注入与未知字段拒绝、缺项/多述/计数/来源不存在。
//   2) 假服务全链：临时 SQLite + 临时对象根 + 进程内假目标适配器，
//      上游自动步骤产出 documents/many 两实例（file-set）→ 人工步骤按具名映射读成
//      reviewedDocuments/many 两实例 → 保存 → 逐文件编辑 → 确认；检查/修订/应用单列一项，
//      因为该路径当前被主源码的缺失符号阻塞（见 CHAIN-02 的失败说明）。
//      断言：原上游快照仍是证据输入且一字节未变、两实例全部保留、确认后集合是映射后的名字。
// 约束：不监听端口、不发真实 HTTP、不调用模型、不碰生产库；建库路径全在 mkdtemp 下。
// 网络一旦被调用即失败，作为「无真实网络」的可执行证据。
globalThis.fetch = () => { throw new Error('network_forbidden:verify-workflow-m1-human-mapping') }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../src/workflow/m1-fake-service.mjs'
import { fileBytesDigest, normalizeOutputSet } from '../src/workflow/m1-output-set.mjs'
import {
  HUMAN_MAPPING_ERROR_CODES,
  HUMAN_MAPPING_SCHEMA_VERSION,
  mapHumanInputSet,
  validateHumanInputMapping,
} from '../src/workflow/m1-human-mapping.mjs'

const PRODUCT = 'fixture-product-mapping'
const UI = 'ui-1'
const ALPHA = 'documents/alpha.md'
const BETA = 'documents/beta.md'
const ALPHA_TEXT = '# Alpha\n\nOriginal alpha body.\n'
const BETA_TEXT = '# Beta\n\nOriginal beta body.\n'

const results = []
let assertions = 0
// 失败时给出「卡在哪一步」：假服务把未知内核错误统一翻成 schema_invalid/kernel_error，
// 只看码分不清是保存、检查、修订还是确认。
let STAGE = 'start'
const at = (name) => { STAGE = name }

const need = (condition, message) => {
  assertions += 1
  if (!condition) throw new Error(message)
}

const expectError = (fn, code, detail = null) => {
  try {
    fn()
  } catch (error) {
    need(error.code === code, `expected ${code} but got ${error.code ?? error.message} (${error.detail ?? ''})`)
    if (detail) need(String(error.detail ?? '').includes(detail), `expected detail to include ${detail} but got ${error.detail}`)
    return error
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

const check = (id, title, fn) => {
  const root = mkdtempSync(join(tmpdir(), `m1-mapping-${id}-`))
  let world = null
  STAGE = 'setup'
  try {
    world = openWorld(root)
    const detail = fn(world)
    results.push({ id, title, status: 'pass', detail })
  } catch (error) {
    results.push({ id, title, status: 'fail', detail: `${STAGE}: ${String(error?.message ?? error)}` })
  } finally {
    try { world?.kernel?.db?.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 纯函数夹具：不读盘、不建库
// ---------------------------------------------------------------------------

const fileEntry = (relativePath, text) => ({
  relativePath,
  hash: fileBytesDigest(text),
  bytes: Buffer.byteLength(text),
  mediaType: 'text/markdown',
})

const declarationOf = (name, overrides = {}) => ({
  name,
  artifactType: 'file-set',
  schemaVersion: 1,
  editable: true,
  multiplicity: 'many',
  ...overrides,
})

// 上游集合由既有规范化实现构造，测试不自己编 digest。
const buildSourceSet = (instances, texts) => normalizeOutputSet({
  instances: instances.map(instance => ({
    artifactType: 'file-set',
    schemaVersion: 1,
    editable: true,
    multiplicity: 'many',
    ...instance,
  })),
  files: Object.entries(texts).map(([relativePath, text]) => fileEntry(relativePath, text)),
})

const namesOf = set => set.outputs.map(instance => instance.name)
const pathsOf = set => set.files.map(file => file.relativePath).sort()
const instanceFiles = set => set.outputs.map(instance => instance.files.slice().sort())

const TWO_DOCUMENTS = () => buildSourceSet(
  [
    { name: 'documents', files: [ALPHA] },
    { name: 'documents', files: [BETA] },
  ],
  { [ALPHA]: ALPHA_TEXT, [BETA]: BETA_TEXT },
)

const NAMED_DRAFTS = () => buildSourceSet(
  [
    { name: 'draft', files: [ALPHA] },
    { name: 'final', files: [BETA] },
  ],
  { [ALPHA]: ALPHA_TEXT, [BETA]: BETA_TEXT },
)

// ---------------------------------------------------------------------------
// 假服务夹具：临时库 + 临时对象根 + 进程内目标适配器
// ---------------------------------------------------------------------------

const fixtureTargets = new Map()
const fixtureTarget = (name) => {
  if (!fixtureTargets.has(name)) fixtureTargets.set(name, { revision: 1, content: '' })
  return fixtureTargets.get(name)
}

// file-set 逐文件发布时 relativePath 非 null：观察走 file_hash，基准取目标当前内容摘要。
const targetAdapter = {
  read: (target, relativePath = null) => {
    const state = fixtureTarget(target)
    return { revision: state.revision, content: state.content, ...(relativePath ? { relativePath } : {}) }
  },
  kindOf: () => 'raw_text',
}

const openWorld = (root) => {
  const kernel = openWorkflowKernel(join(root, 'workflow.sqlite'), join(root, 'objects'))
  const service = createFakeBusinessService({ kernel, targetAdapter, clock: () => '2026-11-15T00:00:00.000Z' })
  service.registerPrincipal({ id: UI, kind: 'ui', productId: PRODUCT })
  return { root, kernel, service }
}

const documentsDeclaration = declarationOf('documents')
const reviewedDeclaration = declarationOf('reviewedDocuments')

// 两个步骤都显式声明 outputs 与逐文件发布目标：内核的 validateTargets 要求
// 声明路径集合与集合文件完全一致，缺声明会直接 publish_declaration_missing。
const chainSteps = () => [
  {
    nodeId: 'documents.source',
    nodeKind: 'automatic',
    outputs: [documentsDeclaration],
    requiredChecks: [],
    publishTargets: [
      { target: 'fixture.documents', required: false, relativePath: ALPHA },
      { target: 'fixture.documents', required: false, relativePath: BETA },
    ],
  },
  {
    nodeId: 'reviewed.confirm',
    nodeKind: 'human',
    outputs: [reviewedDeclaration],
    inputMapping: [{ name: 'reviewedDocuments', from: 'documents' }],
    requiredChecks: [],
    publishTargets: [
      { target: 'fixture.reviewed', required: false, relativePath: ALPHA },
      { target: 'fixture.reviewed', required: false, relativePath: BETA },
    ],
  },
]

const publishBaseline = (target, relativePath) => ({
  target,
  required: false,
  relativePath,
  baseRevision: 1,
  baseContentHash: fileBytesDigest(fixtureTarget(target).content),
  targetKind: 'file_hash',
})

// ---------------------------------------------------------------------------
// 1. 映射纯函数
// ---------------------------------------------------------------------------

check('MAP-01', '没有映射时按同名直连，many 两个实例原样保留', () => {
  const sourceSet = TWO_DOCUMENTS()
  const outputs = [documentsDeclaration]
  const set = mapHumanInputSet({ sourceSet, outputs })
  need(namesOf(set).length === 2 && namesOf(set).every(name => name === 'documents'), `unexpected names ${namesOf(set).join(',')}`)
  need(JSON.stringify(pathsOf(set)) === JSON.stringify([ALPHA, BETA]), 'file list changed')
  need(set.digest === normalizeOutputSet({ instances: set.outputs, files: set.files, declarations: outputs }).digest, 'digest is not reproducible')
  need(set.outputs.every(item => item.editable === true && item.multiplicity === 'many'), 'editable/multiplicity not carried')
  // 映射不改字节：文件摘要原样沿用上游。
  const upstream = new Map(sourceSet.files.map(file => [file.relativePath, file.hash]))
  need(set.files.every(file => file.hash === upstream.get(file.relativePath)), 'file hash rewritten by mapping')
  return set.digest
})

check('MAP-02', '具名单选的 one 输出只取被指定的上游实例', () => {
  const sourceSet = NAMED_DRAFTS()
  const outputs = [declarationOf('reviewed', { multiplicity: 'one' })]
  const set = mapHumanInputSet({ sourceSet, outputs, inputMapping: [{ name: 'reviewed', from: 'final' }] })
  need(namesOf(set).length === 1 && namesOf(set)[0] === 'reviewed', `unexpected names ${namesOf(set).join(',')}`)
  need(JSON.stringify(pathsOf(set)) === JSON.stringify([BETA]), 'selected the wrong instance')
  need(set.outputs[0].multiplicity === 'one', 'multiplicity not applied')
  return pathsOf(set).join(',')
})

check('MAP-03', '具名 many 把整组改名，两实例与两文件全部保留', () => {
  const sourceSet = TWO_DOCUMENTS()
  const outputs = [reviewedDeclaration]
  const set = mapHumanInputSet({ sourceSet, outputs, inputMapping: [{ name: 'reviewedDocuments', from: 'documents' }] })
  need(namesOf(set).length === 2 && namesOf(set).every(name => name === 'reviewedDocuments'), `unexpected names ${namesOf(set).join(',')}`)
  need(JSON.stringify(pathsOf(set)) === JSON.stringify([ALPHA, BETA]), 'files not fully preserved')
  need(new Set(instanceFiles(set).flat()).size === 2, 'instances did not stay separate')
  need(set.digest !== sourceSet.digest, 'renaming should change the set digest')
  return set.digest
})

check('MAP-04', '类型与 schema 不符分别拒绝，不静默降级', () => {
  const sourceSet = TWO_DOCUMENTS()
  const mapping = [{ name: 'reviewedDocuments', from: 'documents' }]
  expectError(() => mapHumanInputSet({ sourceSet, outputs: [declarationOf('reviewedDocuments', { artifactType: 'json' })], inputMapping: mapping }), 'human_mapping_type_mismatch')
  expectError(() => mapHumanInputSet({ sourceSet, outputs: [declarationOf('reviewedDocuments', { schemaVersion: 2 })], inputMapping: mapping }), 'human_mapping_schema_mismatch')
  // 未传映射且名字对不上时是「来源不存在」，不是类型不符：先认名字再认类型。
  expectError(() => mapHumanInputSet({ sourceSet, outputs: [declarationOf('reviewedDocuments', { artifactType: 'json' })] }), 'human_mapping_from_unknown')
  return 'type_mismatch+schema_mismatch'
})

check('MAP-05', '上游只读时既要可编辑就拒绝，只读声明才放行', () => {
  const sourceSet = buildSourceSet([{ name: 'documents', files: [ALPHA], editable: false }], { [ALPHA]: ALPHA_TEXT })
  expectError(() => mapHumanInputSet({ sourceSet, outputs: [documentsDeclaration] }), 'human_mapping_editable_conflict')
  const readOnly = mapHumanInputSet({ sourceSet, outputs: [declarationOf('documents', { editable: false })] })
  need(readOnly.outputs[0].editable === false, 'read-only upstream became editable')
  return 'editable_false'
})

check('MAP-06', '映射条目带机器字段或未知字段一律拒绝（注入防线）', () => {
  const sourceSet = TWO_DOCUMENTS()
  const outputs = [reviewedDeclaration]
  for (const field of ['hash', 'files', 'artifactType', 'editable', 'multiplicity', 'path', 'bytes', 'mediaType']) {
    expectError(() => mapHumanInputSet({ sourceSet, outputs, inputMapping: [{ name: 'reviewedDocuments', from: 'documents', [field]: 'x' }] }), 'human_mapping_invalid', `injected_field:${field}`)
  }
  expectError(() => mapHumanInputSet({ sourceSet, outputs, inputMapping: [{ name: 'reviewedDocuments', from: 'documents', extra: 'x' }] }), 'human_mapping_invalid', 'unknown_field')
  expectError(() => validateHumanInputMapping('nope'), 'human_mapping_invalid', 'not_a_list_or_object')
  // 两个输出抢同一个上游实例：会让同一批文件跨实例共享，必须当场拒。
  expectError(() => validateHumanInputMapping([{ name: 'a', from: 'documents' }, { name: 'b', from: 'documents' }]), 'human_mapping_invalid', 'duplicate_from')
  expectError(() => validateHumanInputMapping([{ name: 'a', from: 'documents' }, { name: 'a', from: 'draft' }]), 'human_mapping_invalid', 'duplicate_name')
  // 对象写法与列表写法等价。
  const objectForm = validateHumanInputMapping({ reviewed: 'final' })
  const listForm = validateHumanInputMapping([{ name: 'reviewed', from: 'final' }])
  need(JSON.stringify(objectForm) === JSON.stringify(listForm), 'object form and list form disagree')
  need(Object.isFrozen(objectForm), 'validated mapping is not frozen')
  need(HUMAN_MAPPING_SCHEMA_VERSION === 1 && HUMAN_MAPPING_ERROR_CODES.length === 9, 'schema version or error code list changed')
  return '8 forbidden fields + unknown + duplicates'
})

check('MAP-07', '缺项、多述、计数、来源与上游文件缺失都给出各自的码', () => {
  const sourceSet = TWO_DOCUMENTS()
  expectError(() => mapHumanInputSet({ sourceSet, outputs: [reviewedDeclaration], inputMapping: [{ name: 'other', from: 'documents' }] }), 'human_mapping_incomplete')
  expectError(() => mapHumanInputSet({ sourceSet, outputs: [documentsDeclaration], inputMapping: [{ name: 'documents', from: 'documents' }, { name: 'extra', from: 'draft' }] }), 'human_mapping_undeclared')
  expectError(() => mapHumanInputSet({ sourceSet, outputs: [declarationOf('reviewed', { multiplicity: 'one' })], inputMapping: [{ name: 'reviewed', from: 'documents' }] }), 'human_mapping_count_invalid')
  expectError(() => mapHumanInputSet({ sourceSet, outputs: [reviewedDeclaration], inputMapping: [{ name: 'reviewedDocuments', from: 'nope' }] }), 'human_mapping_from_unknown')
  expectError(() => mapHumanInputSet({ sourceSet: null, outputs: [reviewedDeclaration] }), 'human_mapping_source_missing', 'source_set_required')
  const emptyInstance = buildSourceSet([{ name: 'documents', files: [ALPHA] }], { [ALPHA]: ALPHA_TEXT })
  emptyInstance.outputs[0].files = []
  expectError(() => mapHumanInputSet({ sourceSet: emptyInstance, outputs: [documentsDeclaration] }), 'human_mapping_source_missing', 'instance_files_required')
  return 'incomplete+undeclared+count+from_unknown+source_missing'
})

check('MAP-08', '映射是纯函数：不改入参，返回值与重复调用一致', () => {
  const sourceSet = TWO_DOCUMENTS()
  const outputs = [reviewedDeclaration]
  const inputMapping = [{ name: 'reviewedDocuments', from: 'documents' }]
  const before = JSON.stringify({ sourceSet, outputs, inputMapping })
  const first = mapHumanInputSet({ sourceSet, outputs, inputMapping })
  const second = mapHumanInputSet({ sourceSet, outputs, inputMapping })
  need(JSON.stringify({ sourceSet, outputs, inputMapping }) === before, 'inputs were mutated')
  need(first.digest === second.digest, 'same input produced different digests')
  need(first !== second, 'result object is shared between calls')
  return first.digest
})

// ---------------------------------------------------------------------------
// 2. 假服务全链：documents/many → reviewedDocuments/many
// ---------------------------------------------------------------------------

const documentsSet = () => ({
  instances: [
    { name: 'documents', artifactType: 'file-set', schemaVersion: 1, editable: true, multiplicity: 'many', files: [ALPHA] },
    { name: 'documents', artifactType: 'file-set', schemaVersion: 1, editable: true, multiplicity: 'many', files: [BETA] },
  ],
  files: [fileEntry(ALPHA, ALPHA_TEXT), fileEntry(BETA, BETA_TEXT)],
  contents: { [ALPHA]: ALPHA_TEXT, [BETA]: BETA_TEXT },
})

// 上游自动步骤固定产出 documents/many 两实例；返回采用结果与采用那一刻的快照证据。
const seedUpstream = (world, runId) => {
  const { kernel, service } = world
  at('claim-automatic')
  const claim = service.host.claimRun(runId)
  need(claim.kind === 'automatic', `expected automatic claim, got ${claim.kind}`)
  at('store-upstream-set')
  const candidate = kernel.storeOutputSetCandidate({ attemptId: claim.attemptId, token: claim.token, ...documentsSet() })
  at('adopt-upstream')
  const adopted = kernel.adopt({
    attemptId: claim.attemptId,
    token: claim.token,
    candidate,
    actorType: 'system',
    publishTargets: [publishBaseline('fixture.documents', ALPHA), publishBaseline('fixture.documents', BETA)],
  })
  return { adoption: adopted, snapshot: kernel.readSnapshot(adopted.snapshotId) }
}

check('CHAIN-01', '两实例映射后 读取→保存→逐文件编辑→确认，实例与文件全保留，原快照不变', (world) => {
  const { kernel, service } = world
  const runId = 'run-human-mapping-1'
  at('startRun')
  const started = service.startRun({ principal: UI, idempotencyKey: 'start-chain-1', runId, productId: PRODUCT, input: { fixture: true }, steps: chainSteps() })
  need(started.runId === runId && started.stepCount === 2, 'run not created with two steps')

  const upstream = seedUpstream(world, runId)
  need(upstream.snapshot.outputSet.outputs.length === 2, 'upstream set does not have two instances')
  need(namesOf(upstream.snapshot.outputSet).every(name => name === 'documents'), 'upstream names are not documents')

  at('claim-human')
  const humanClaim = service.host.claimRun(runId)
  need(humanClaim.kind === 'human', `expected human claim, got ${humanClaim.kind}`)
  const taskId = humanClaim.taskId
  const taskRow = kernel.one('SELECT * FROM workflow_human_tasks WHERE id=?', taskId)
  need(taskRow && taskRow.status === 'open', 'human task not open')

  // ---- 读取：页面拿到的是映射后的完整集合 ----
  at('read-draft')
  const opened = service.readHumanDraft({ principal: UI, runId, taskId })
  need(opened.taskRevision === 1 && opened.draft === null, 'fresh task should have no draft')
  need(opened.outputSet && opened.outputSet.outputs.length === 2, 'mapped set does not have two instances')
  need(namesOf(opened.outputSet).every(name => name === 'reviewedDocuments'), `draft reads wrong names ${namesOf(opened.outputSet).join(',')}`)
  need(JSON.stringify(pathsOf(opened.outputSet)) === JSON.stringify([ALPHA, BETA]), 'mapped files are not both preserved')
  need(opened.outputSet.digest !== upstream.snapshot.outputSet.digest, 'mapped digest equals upstream digest')
  // 现状：currentInput 与 outputSet 是同一份映射结果（m1-fake-service.mjs:783 直接取 humanInputSource）。
  // 原快照的证据身份改由内核读回核对，见下方 upstream* 断言；这条差异作为观察项报给主实现。
  need(opened.currentInput.outputSet.digest === opened.outputSet.digest, 'currentInput and outputSet disagree')
  need(opened.currentInput.content === JSON.stringify(opened.currentInput.outputSet), 'mapped content is not the canonical set JSON')
  const bindingVersion = opened.binding.version

  // 逐文件读取拿到的仍是上游原字节。
  at('read-file')
  const alphaRead = service.readHumanDraftFile({ principal: UI, runId, taskId, relativePath: ALPHA, expectedBindingVersion: bindingVersion, expectedTaskRevision: 1 })
  need(alphaRead.content === ALPHA_TEXT, 'mapped file content differs from upstream bytes')
  need(alphaRead.contentHash === upstream.snapshot.outputSet.files.find(file => file.relativePath === ALPHA).hash, 'mapped file hash differs from upstream')

  // ---- 保存：整组集合先落草稿 ----
  at('save-draft')
  const saved = service.saveHumanDraft({ principal: UI, runId, taskId, content: opened.currentInput.content, expectedBindingVersion: bindingVersion, expectedTaskRevision: 1 })
  need(saved.revision === 2, `unexpected draft revision ${saved.revision}`)

  // ---- 逐文件编辑：只动 alpha，beta 必须原样 ----
  at('save-file')
  const editedAlpha = `${ALPHA_TEXT}\nHuman note: keep alpha.\n`
  const edited = service.saveHumanDraftFile({ principal: UI, runId, taskId, relativePath: ALPHA, content: editedAlpha, expectedBindingVersion: bindingVersion, expectedTaskRevision: 2 })
  need(edited.revision === 3, `unexpected draft revision after file edit ${edited.revision}`)

  at('read-draft-after-edit')
  const afterEdit = service.readHumanDraft({ principal: UI, runId, taskId })
  need(afterEdit.taskRevision === 3, 'task revision did not advance')
  // readHumanDraft.outputSet 是映射后的输入基线，不随草稿变化；当前草稿集合要从 draft.content 解。
  const draftSet = JSON.parse(afterEdit.draft.content)
  need(namesOf(draftSet).length === 2, 'instances dropped after file edit')
  need(namesOf(draftSet).every(name => name === 'reviewedDocuments'), 'file edit lost the mapped names')
  need(JSON.stringify(pathsOf(draftSet)) === JSON.stringify([ALPHA, BETA]), 'draft lost a file after editing one')
  const alphaAfter = service.readHumanDraftFile({ principal: UI, runId, taskId, relativePath: ALPHA, expectedBindingVersion: bindingVersion, expectedTaskRevision: 3 })
  const betaAfter = service.readHumanDraftFile({ principal: UI, runId, taskId, relativePath: BETA, expectedBindingVersion: bindingVersion, expectedTaskRevision: 3 })
  need(alphaAfter.content === editedAlpha, 'edited alpha was not persisted')
  need(betaAfter.content === BETA_TEXT, 'beta was modified by an alpha edit')

  // ---- 确认：本节点没有必需校验，直接确认 ----
  at('confirm')
  const runBefore = kernel.one('SELECT status,revision FROM workflow_runs WHERE id=?', runId)
  const confirmed = service.confirmHumanTask({
    principal: UI,
    taskId,
    content: afterEdit.draft.content,
    expectedBindingVersion: bindingVersion,
    inputFingerprint: taskRow.input_hash,
    expectedRunRevision: runBefore.revision,
    expectedTaskRevision: 3,
    idempotencyKey: 'confirm-1',
  })
  need(confirmed.status === 'completed' && typeof confirmed.adoptionId === 'string', 'confirmation did not produce an adoption')

  // ---- 确认后的断言 ----
  const adoption = kernel.one('SELECT * FROM workflow_adoptions WHERE id=?', confirmed.adoptionId)
  need(adoption.actor_type === 'human' && adoption.reason === 'human.edit-confirm', `unexpected adoption ${adoption.actor_type}/${adoption.reason}`)
  const humanSnapshot = kernel.readSnapshot(adoption.snapshot_id)
  need(humanSnapshot.artifactType === 'file-set', 'confirm did not store a file-set snapshot')
  need(humanSnapshot.parentId === upstream.adoption.snapshotId, 'confirming snapshot is not chained to the upstream snapshot')
  const finalSet = humanSnapshot.outputSet
  need(namesOf(finalSet).length === 2 && namesOf(finalSet).every(name => name === 'reviewedDocuments'), 'confirmed set lost an instance')
  need(JSON.stringify(pathsOf(finalSet)) === JSON.stringify([ALPHA, BETA]), 'confirmed set lost a file')
  need(finalSet.digest !== upstream.snapshot.outputSet.digest, 'confirmed set digest equals the upstream digest')
  const draftAlpha = draftSet.files.find(file => file.relativePath === ALPHA)
  const finalAlpha = finalSet.files.find(file => file.relativePath === ALPHA)
  const finalBeta = finalSet.files.find(file => file.relativePath === BETA)
  const upstreamBeta = upstream.snapshot.outputSet.files.find(file => file.relativePath === BETA)
  need(finalAlpha.hash === draftAlpha.hash, 'confirmed alpha is not the edited draft')
  need(finalBeta.hash === upstreamBeta.hash, 'untouched beta changed during confirmation')

  // 原上游快照作为证据保持原样：内容摘要、集合摘要、实例名、文件摘要都不变。
  const upstreamAfter = kernel.readSnapshot(upstream.adoption.snapshotId)
  need(upstreamAfter.contentHash === upstream.snapshot.contentHash, 'upstream snapshot content hash changed')
  need(upstreamAfter.outputSet.digest === upstream.snapshot.outputSet.digest, 'upstream set digest changed')
  need(JSON.stringify(upstreamAfter.outputSet) === JSON.stringify(upstream.snapshot.outputSet), 'upstream set was rewritten')
  need(namesOf(upstreamAfter.outputSet).every(name => name === 'documents'), 'upstream instances were renamed in place')

  // 运行收敛：两步都采用，发布项全部是可选项，不应被阻塞。
  const runAfter = kernel.one('SELECT status FROM workflow_runs WHERE id=?', runId)
  need(runAfter.status === 'completed', `run did not complete: ${runAfter.status}`)
  need(kernel.one('SELECT status FROM workflow_human_tasks WHERE id=?', taskId).status === 'confirmed', 'task not confirmed')
  const outbox = kernel.query('SELECT status,required,relative_path FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=?', runId)
  need(outbox.every(item => Number(item.required) === 0), 'unexpected required publish item')
  need(outbox.length === 4, `unexpected publish item count ${outbox.length}`)

  return {
    run: runAfter.status,
    adoption: confirmed.adoptionId,
    instances: namesOf(finalSet).length,
    files: pathsOf(finalSet).length,
    upstreamDigest: upstream.snapshot.outputSet.digest.slice(0, 12),
    confirmedDigest: finalSet.digest.slice(0, 12),
  }
})

// 检查与修订走的是 structureOnly 分支，当前被主源码的缺失符号整段阻塞。
// 本项照常断言：修好后自动转绿；仍失败时 failure detail 直接给出位置。
check('CHAIN-02', '检查→独立修订→应用：两实例全程保留', (world) => {
  const { kernel, service } = world
  const runId = 'run-human-mapping-2'
  at('startRun')
  service.startRun({ principal: UI, idempotencyKey: 'start-chain-2', runId, productId: PRODUCT, input: { fixture: true }, steps: chainSteps() })
  const upstream = seedUpstream(world, runId)
  at('claim-human')
  const humanClaim = service.host.claimRun(runId)
  need(humanClaim.kind === 'human', `expected human claim, got ${humanClaim.kind}`)
  const taskId = humanClaim.taskId
  at('read-draft')
  const opened = service.readHumanDraft({ principal: UI, runId, taskId })
  const bindingVersion = opened.binding.version
  at('save-draft')
  service.saveHumanDraft({ principal: UI, runId, taskId, content: opened.currentInput.content, expectedBindingVersion: bindingVersion, expectedTaskRevision: 1 })

  at('validate-draft')
  let report
  try {
    report = service.validateHumanDraft({ principal: UI, runId, taskId, content: opened.currentInput.content, expectedBindingVersion: bindingVersion, expectedTaskRevision: 2 })
  } catch (error) {
    // 服务层会吞掉内核异常只留 schema_invalid:kernel_error；这里回内核取原始报错，
    // 只有「符号缺失」这一种失败会被改写成可读说明，其它错误原样抛出。
    let raw = ''
    try {
      kernel.validateHumanDraft({ taskId, content: opened.currentInput.content, expectedBindingVersion: bindingVersion, expectedTaskRevision: 2 })
    } catch (kernelError) { raw = String(kernelError?.message ?? '') }
    if (!/assertNoInjectedObjectPaths is not defined/.test(raw)) throw error
    throw new Error('主源码缺失符号：src/workflow/m1-kernel.mjs:1016 的 structureOnly 分支调用 assertNoInjectedObjectPaths，'
      + '但该函数只在 src/workflow/m1-output-set-store.mjs:264 内部定义、没有导出，m1-kernel.mjs 也未导入；'
      + '于是 file-set 人工节点的 validateHumanDraft 一律 ReferenceError（服务层翻成 schema_invalid:kernel_error），'
      + '检查与 requestRevision 两条链路都走不通。待主实现导出并接入后重跑本项。')
  }
  // 服务返回的是报告存储封装：状态在顶层，报告正文在 .report（subject/checks 都在里面）。
  need(report.status === 'pass', `draft validation did not pass: ${report.status}`)
  need(report.report.status === 'pass', `stored report status disagrees: ${report.report.status}`)
  need(report.artifactType === 'file-set' && report.report.subject.artifactType === 'file-set', 'validation subject is not the file-set')
  // 校验对象是「草稿集合」，此刻草稿未改过，其摘要应与读取到的映射基线一致。
  need(report.report.subject.outputSetDigest === opened.outputSet.digest, 'validated digest is not the mapped baseline digest')
  need(typeof report.id === 'string' && report.stepId, 'validation report was not persisted')

  at('request-revision')
  const request = service.requestRevision({ principal: UI, runId, taskId, expectedBindingVersion: bindingVersion, expectedTaskRevision: 2, note: 'Tighten beta wording.', retained: [], idempotencyKey: 'rev-1' })
  need(request.status === 'ready', `revision request not ready: ${request.status}`)
  // 修订记录里的 candidate 只是元数据封装（content/contentHash/artifactType/outputSetDigest），
  // 集合本体在 candidate.content 里；摘要列必须与解出来的集合一致。
  need(request.candidate.artifactType === 'file-set', `candidate artifact type ${request.candidate.artifactType}`)
  const candidateSet = JSON.parse(request.candidate.content)
  need(namesOf(candidateSet).length === 2 && namesOf(candidateSet).every(name => name === 'reviewedDocuments'), 'revision candidate lost an instance')
  need(candidateSet.files.length === 2, 'revision added or lost a file')
  need(candidateSet.digest === request.candidate.outputSetDigest, 'candidate digest column disagrees with the set body')
  need(candidateSet.digest !== upstream.snapshot.outputSet.digest, 'revision candidate equals the upstream set')

  at('apply-revision')
  const applied = service.applyRevisionCandidate({ principal: UI, runId, requestId: request.id })
  need(applied.revision === 3, `unexpected draft revision after apply ${applied.revision}`)
  need(applied.request.status === 'applied', 'revision request was not recorded as applied')
  const finalDraft = service.readHumanDraft({ principal: UI, runId, taskId })
  need(namesOf(finalDraft.outputSet).every(name => name === 'reviewedDocuments'), 'applied draft lost the mapped names')
  return { revision: applied.revision, digest: candidateSet.digest.slice(0, 12) }
})

check('CHAIN-03', '单 blob 文本人工节点不受映射影响（原路径保留）', (world) => {
  const { kernel, service } = world
  const runId = 'run-human-mapping-text'
  at('startRun')
  // 只声明文本输出、不带 inputMapping：映射模块不应被调用，文本基线照旧可用。
  service.startRun({
    principal: UI,
    idempotencyKey: 'start-chain-3',
    runId,
    productId: PRODUCT,
    input: { fixture: true },
    steps: [
      { nodeId: 'text.source', nodeKind: 'automatic', outputs: [{ name: 'content', artifactType: 'text', schemaVersion: 1, editable: true, multiplicity: 'one' }], requiredChecks: [], publishTargets: [] },
      { nodeId: 'text.confirm', nodeKind: 'human', outputs: [{ name: 'content', artifactType: 'text', schemaVersion: 1, editable: true, multiplicity: 'one' }], requiredChecks: [] },
    ],
  })
  at('claim-automatic')
  const autoClaim = service.host.claimRun(runId)
  const candidate = kernel.storeCandidate({ attemptId: autoClaim.attemptId, token: autoClaim.token, content: 'Plain text body.\n', artifactType: 'text' })
  kernel.adopt({ attemptId: autoClaim.attemptId, token: autoClaim.token, candidate, actorType: 'system' })
  at('claim-human')
  const humanClaim = service.host.claimRun(runId)
  need(humanClaim.kind === 'human', 'text human step was not claimable')
  const opened = service.readHumanDraft({ principal: UI, runId, taskId: humanClaim.taskId })
  need(opened.outputSet === null, 'text draft must not be turned into an output set')
  need(opened.currentInput.content === 'Plain text body.\n', 'text source content was changed')
  at('save-draft')
  const saved = service.saveHumanDraft({ principal: UI, runId, taskId: humanClaim.taskId, content: 'Plain text body.\n', expectedBindingVersion: opened.binding.version, expectedTaskRevision: 1 })
  need(saved.revision === 2, 'text draft was not saved')
  return 'text path unchanged'
})

const failed = results.filter(result => result.status !== 'pass')
console.log(JSON.stringify({ checks: results.length, passed: results.length - failed.length, assertions, results }, null, 2))
if (failed.length) process.exitCode = 1
