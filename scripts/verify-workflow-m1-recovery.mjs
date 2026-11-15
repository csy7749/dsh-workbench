// B3 / W1-03、W1-05、A06、A09、A14 恢复专项验证（happy-4.1）。
// 全程临时 SQLite + 临时根目录 + 副本文件，不碰生产库、不发 HTTP、不调真实模型。
// 覆盖：快照只读读取、校验导出、副本备份还原、重启接续不重复发起、双连接 claim、事件 seq 竞争、幂等保留期清理。
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkflowKernel, openWorkflowKernel, RECOVERY_KINDS } from '../src/workflow/m1-kernel.mjs'

const auto = (nodeId = 'fake.transform', publishTargets = [], artifactType = 'text') => ({ nodeId, nodeKind: 'automatic', requiredChecks: [], publishTargets, outputs: [{ name: 'content', artifactType, schemaVersion: 1, editable: true, multiplicity: 'one' }] })
const results = []
let assertions = 0

const need = (condition, message) => {
  assertions += 1
  if (!condition) throw new Error(message)
}

const expectError = (fn, code, detail = null) => {
  try {
    fn()
  } catch (error) {
    need(error.code === code, `expected ${code} but got ${error.code ?? error.message} (${error.detail ?? error.message ?? ''})`)
    if (detail) {
      const actual = error.detail ?? error.message
      need(actual === detail, `expected detail ${detail} but got ${actual}`)
    }
    return error
  }
  throw new Error(`expected ${code} but the call succeeded`)
}

const check = (id, title, fn) => {
  const root = mkdtempSync(join(tmpdir(), `m1-rec-${id}-`))
  const handles = []
  try {
    const open = (dbPath = join(root, 'workflow.sqlite'), objRoot = root) => {
      const kernel = createWorkflowKernel(new DatabaseSync(dbPath), objRoot)
      handles.push(kernel)
      return kernel
    }
    const detail = fn({ root, open })
    results.push({ id, title, status: 'pass', detail: detail ?? null })
  } catch (error) {
    results.push({ id, title, status: 'fail', detail: String(error?.message ?? error) })
  } finally {
    for (const kernel of handles) { try { kernel.db.close() } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
}

// 动态覆盖用户表及其定义；比较持久化状态，不声称能发现写入后又还原的瞬时操作。
const stateFingerprint = (kernel) => kernel.hash(JSON.stringify(kernel.query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(({ name, sql }) => ({
  name, sql, rows: kernel.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).map(row => JSON.stringify(row)).sort(),
}))))
const objectTree = (root) => {
  const out = []
  const walk = (dir, prefix = '') => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`)
      else {
        const bytes = readFileSync(join(dir, entry.name))
        out.push({ path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  walk(join(root, 'objects'), 'objects/')
  walk(join(root, 'manifests'), 'manifests/')
  walk(join(root, 'staging'), 'staging/')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

// 夹具目标适配器：目标版本与正文都由夹具持有；adopt 的 baseRevision/baseContentHash 与
// claim/对账的 observe 都取自它，绝不回读 workflow_outbox（否则等于拿请求参数和请求参数比）。
const targets = new Map()
const fixtureTarget = (name) => {
  if (!targets.has(name)) {
    const state = { name, revision: 1, content: `recovery base of ${name}` }
    state.observe = (asked) => ({ target: asked, revision: state.revision, contentHash: state.contentHash() })
    state.contentHash = () => createHash('sha256').update(state.content, 'utf8').digest('hex')
    state.advanceTo = (next) => { state.revision = next }
    state.setContent = (next) => { state.content = next }
    targets.set(name, state)
  }
  return targets.get(name)
}
const claimPublish = (kernel, outboxId, target) => kernel.claimOutbox(outboxId, { observe: fixtureTarget(target).observe })

// 一条走完的单步自动流程：返回采用的快照 id 与发布项。
const completeRun = (kernel, { runId = 'run-1', content = 'recovery content', target = 'pd:fixture-recovery' } = {}) => {
  kernel.createRun({ id: runId, input: { fixture: true }, steps: [auto('fake.transform', [{ target, required: true }])] })
  const attempt = kernel.claim(runId)
  const candidate = kernel.storeCandidate({ attemptId: attempt.attemptId, token: attempt.token, content })
  const fixture = fixtureTarget(target)
  const adoption = kernel.adopt({
    attemptId: attempt.attemptId, token: attempt.token, candidate, target, baseRevision: fixture.revision,
    baseContentHash: fixture.contentHash(), targetKind: 'raw_text',
  })
  const outbox = kernel.one('SELECT id FROM workflow_outbox WHERE adoption_id=?', adoption.adoptionId)
  return { attempt, candidate, adoption, outboxId: outbox.id, target }
}

// 01 快照只读读取：内容、hash、父指针与作者都可取回，且不改库、不改盘。
check('REC-01', 'readSnapshot returns verified content and mutates nothing', ({ open }) => {
  const kernel = open()
  const { adoption, candidate, outboxId, target } = completeRun(kernel)
  const publishClaim = claimPublish(kernel, outboxId, target)
  kernel.completeOutbox(outboxId, 'succeeded', null, publishClaim.claimGeneration)
  const dbBefore = stateFingerprint(kernel)
  const treeBefore = objectTree(kernel.root)
  const snapshot = kernel.readSnapshot(adoption.snapshotId)
  need(snapshot.verified === true, 'readSnapshot marks the copy as verified')
  need(snapshot.content === 'recovery content', 'readSnapshot returns the stored text')
  need(snapshot.contentHash === candidate.contentHash, 'readSnapshot reports the content hash')
  need(snapshot.manifestHash === candidate.manifestHash, 'readSnapshot reports the manifest hash')
  need(snapshot.parentId === null, 'the first snapshot has no parent')
  need(snapshot.authorType === 'system', 'author type comes from the adoption')
  need(snapshot.sourceAttemptId === adoption.snapshotId.replace(':snapshot', ''), 'source attempt is recorded')
  need(snapshot.bytes === Buffer.byteLength('recovery content'), 'byte length matches the payload')
  need(JSON.stringify(kernel.readSnapshot(adoption.snapshotId)) === JSON.stringify(snapshot), 'repeated reads are identical')
  need(stateFingerprint(kernel) === dbBefore, 'readSnapshot does not write to the database')
  need(JSON.stringify(objectTree(kernel.root)) === JSON.stringify(treeBefore), 'readSnapshot does not touch object files')
  expectError(() => kernel.readSnapshot('missing-snapshot'), 'snapshot_not_found')
  return { snapshotId: adoption.snapshotId }
})

check('REC-09', 'non-text artifact types survive adoption and reopen', ({ root, open }) => {
  let kernel = open()
  const snapshots = []
  for (const artifactType of ['text', 'markdown', 'json']) {
    const id = `typed-${artifactType}`
    const content = artifactType === 'json' ? '{"fixture":true}' : '# Typed fixture\n\nBody'
    kernel.createRun({ id, input: { fixture: true }, steps: [auto('fake.transform', [], artifactType)] })
    const attempt = kernel.claim(id)
    const candidate = kernel.storeCandidate({ ...attempt, content, artifactType })
    // Caller metadata is not authoritative: use the hash-verified disk manifest.
    candidate.artifactType = 'forged'
    const adopted = kernel.adopt({ ...attempt, candidate })
    need(kernel.one('SELECT artifact_type FROM workflow_snapshots WHERE id=?', adopted.snapshotId).artifact_type === artifactType, 'adoption preserves manifest artifact type')
    snapshots.push({ id: adopted.snapshotId, artifactType, content })
  }
  kernel.db.close()
  kernel = open()
  const before = stateFingerprint(kernel)
  for (const item of snapshots) {
    const snapshot = kernel.readSnapshot(item.id)
    need(snapshot.artifactType === item.artifactType, 'reopened snapshot preserves type')
    need(snapshot.content === item.content, 'reopened content is unchanged')
    kernel.exportSnapshot(item.id, join(root, `export-${item.artifactType}`), { expectedHash: snapshot.contentHash })
    need(stateFingerprint(kernel) === before, 'read and export do not alter history')
  }
  return { types: snapshots.map(item => item.artifactType) }
})

check('REC-10', 'adoption rejects a mismatched snapshot identity without database effects', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'bad-identity', input: { fixture: true } })
  const attempt = kernel.claim('bad-identity')
  const candidate = kernel.storeCandidate({ ...attempt, content: 'identity fixture' })
  candidate.snapshotId = 'foreign-snapshot'
  const before = stateFingerprint(kernel)
  expectError(() => kernel.adopt({ ...attempt, candidate, target: 'pd:fixture' }), 'candidate_identity_mismatch')
  need(stateFingerprint(kernel) === before, 'identity rejection leaves all database state unchanged')
})

check('REC-11', 'adoption rejects same-length object tampering without database effects', ({ root, open }) => {
  const kernel = open()
  kernel.createRun({ id: 'bad-object', input: { fixture: true } })
  const attempt = kernel.claim('bad-object')
  const candidate = kernel.storeCandidate({ ...attempt, content: 'integrity fixture' })
  const object = join(root, 'objects', candidate.contentHash.slice(0, 2), candidate.contentHash)
  writeFileSync(object, 'integrity fixturE', 'utf8')
  need(Buffer.byteLength('integrity fixturE') === Buffer.byteLength(candidate.content), 'tampering preserves byte length')
  const before = stateFingerprint(kernel)
  expectError(() => kernel.adopt({ ...attempt, candidate, target: 'pd:fixture' }), 'output_object_corrupt')
  need(stateFingerprint(kernel) === before, 'object rejection leaves all database state unchanged')
})

check('REC-12', 'rejected candidate cleanup preserves an already adopted shared object', ({ root, open }) => {
  const kernel = open()
  const original = completeRun(kernel, { content: 'shared immutable content' })
  const saved = kernel.readSnapshot(original.adoption.snapshotId)
  kernel.createRun({ id: 'shared-rejected', input: { fixture: true } })
  const attempt = kernel.claim('shared-rejected')
  const candidate = kernel.storeCandidate({ ...attempt, content: saved.content })
  need(candidate.contentHash === saved.contentHash, 'fixture uses the same physical object')
  const manifestBytes = readFileSync(join(root, 'manifests', `${attempt.attemptId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), 'utf8')
  candidate.snapshotId = 'wrong-shared-id'
  const before = stateFingerprint(kernel)
  expectError(() => kernel.adopt({ ...attempt, candidate }), 'candidate_identity_mismatch')
  need(stateFingerprint(kernel) === before, 'shared-object rejection preserves database state')
  need(JSON.stringify(kernel.readSnapshot(original.adoption.snapshotId)) === JSON.stringify(saved), 'cleanup preserves the adopted snapshot and content')
  const rejectedManifest = join(root, 'manifests', `${attempt.attemptId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  // 保留语义要按字节比，不是"文件还在"：伪造身份不得让合法 manifest 被截断或重写。
  need(existsSync(rejectedManifest), 'forged snapshot identity cannot remove the durable legitimate candidate manifest')
  need(readFileSync(rejectedManifest, 'utf8') === manifestBytes, 'the legitimate candidate manifest survives the forged identity byte for byte')
})

check('REC-13', 'failed adoption preserves an object shared by in-flight candidates', ({ root, open }) => {
  const kernel = open()
  const candidates = ['pending-a', 'pending-b'].map(id => {
    kernel.createRun({ id, input: { fixture: true }, steps: [auto()] })
    const attempt = kernel.claim(id)
    return { ...attempt, candidate: kernel.storeCandidate({ ...attempt, content: 'shared in-flight bytes' }) }
  })
  const [a, b] = candidates
  need(a.candidate.contentHash === b.candidate.contentHash, 'two in-flight candidates share one object')
  a.candidate.snapshotId = 'invalid-pending-id'
  const before = stateFingerprint(kernel)
  expectError(() => kernel.adopt(a), 'candidate_identity_mismatch')
  need(stateFingerprint(kernel) === before, 'failed adoption leaves both attempts unchanged')
  need(existsSync(join(root, 'objects', b.candidate.contentHash.slice(0, 2), b.candidate.contentHash)), 'failed adoption must preserve the in-flight shared object')
  const adopted = kernel.adopt(b)
  need(kernel.readSnapshot(adopted.snapshotId).content === b.candidate.content, 'the other in-flight candidate still adopts and reads correctly')
})

check('REC-14', 'rejected adoption replay preserves an adopted manifest', ({ root, open }) => {
  const kernel = open()
  const { attempt, candidate, adoption } = completeRun(kernel)
  const saved = kernel.readSnapshot(adoption.snapshotId)
  const manifest = join(root, 'manifests', `${attempt.attemptId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  const bytes = readFileSync(manifest, 'utf8')
  const before = stateFingerprint(kernel)
  for (const token of [attempt.token, 'wrong-token']) {
    expectError(() => kernel.adopt({ ...attempt, token, candidate }), 'attempt_token_invalid')
    need(existsSync(manifest) && readFileSync(manifest, 'utf8') === bytes, 'adopted manifest survives rejected replay byte for byte')
    need(JSON.stringify(kernel.readSnapshot(adoption.snapshotId)) === JSON.stringify(saved), 'adopted snapshot survives rejected replay unchanged')
    need(stateFingerprint(kernel) === before, 'rejected replay preserves database state')
  }
})

check('REC-15', 'wrong token cannot destroy a healthy pending candidate', ({ root, open }) => {
  const kernel = open()
  kernel.createRun({ id: 'token-guard', steps: [auto()] })
  const attempt = kernel.claim('token-guard')
  const candidate = kernel.storeCandidate({ ...attempt, content: 'healthy pending bytes' })
  const manifest = join(root, 'manifests', `${attempt.attemptId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  const bytes = readFileSync(manifest, 'utf8')
  const before = stateFingerprint(kernel)
  expectError(() => kernel.adopt({ ...attempt, token: 'wrong-token', candidate }), 'attempt_token_invalid')
  need(stateFingerprint(kernel) === before, 'wrong token preserves database state')
  need(existsSync(manifest) && readFileSync(manifest, 'utf8') === bytes, 'wrong token preserves pending manifest byte for byte')
  const adopted = kernel.adopt({ ...attempt, candidate })
  need(kernel.readSnapshot(adopted.snapshotId).content === candidate.content, 'legitimate adoption still succeeds after wrong token')
})

// 02 校验导出：导出后回读 hash 一致；期望 hash 不符时拒绝；导出不改库。
check('REC-02', 'exportSnapshot writes a verified copy and rejects a wrong expected hash', ({ root, open }) => {
  const kernel = open()
  const { adoption, candidate, outboxId, target } = completeRun(kernel)
  const publishClaim = claimPublish(kernel, outboxId, target)
  kernel.completeOutbox(outboxId, 'succeeded', null, publishClaim.claimGeneration)
  const dbBefore = stateFingerprint(kernel)
  const treeBefore = objectTree(kernel.root)
  const dir = join(root, 'exported')
  const exported = kernel.exportSnapshot(adoption.snapshotId, dir, { expectedHash: candidate.contentHash })
  need(existsSync(exported.path), 'export file exists under the requested directory')
  need(exported.path.startsWith(dir), 'export stays inside the requested directory')
  need(readFileSync(exported.path, 'utf8') === 'recovery content', 'exported bytes equal the snapshot content')
  need(exported.contentHash === kernel.hash(readFileSync(exported.path, 'utf8')), 'exported bytes hash to the recorded content hash')
  need(exported.bytes === Buffer.byteLength('recovery content'), 'export reports the byte length')
  expectError(() => kernel.exportSnapshot(adoption.snapshotId, dir, { expectedHash: 'deadbeef' }), 'snapshot_hash_mismatch')
  const again = kernel.exportSnapshot(adoption.snapshotId, join(root, 'exported-2'))
  need(again.contentHash === exported.contentHash, 'export without expectedHash still verifies against the row')
  need(stateFingerprint(kernel) === dbBefore, 'exportSnapshot does not write to the database')
  need(JSON.stringify(objectTree(kernel.root)) === JSON.stringify(treeBefore), 'exportSnapshot does not touch object files')
  return { path: exported.path }
})

// 03 副本备份还原：整根复制后在副本上重开，hash 仍一致；副本被改过必须报错。
check('REC-03', 'restored backup keeps hashes and detects tampering', ({ root, open }) => {
  const kernel = open()
  const { adoption, candidate, outboxId, target } = completeRun(kernel)
  const publishClaim = claimPublish(kernel, outboxId, target)
  kernel.completeOutbox(outboxId, 'succeeded', null, publishClaim.claimGeneration)
  const original = kernel.readSnapshot(adoption.snapshotId)
  kernel.db.close()
  const backup = join(root, 'backup')
  mkdirSync(backup, { recursive: true })
  cpSync(join(root, 'objects'), join(backup, 'objects'), { recursive: true })
  cpSync(join(root, 'manifests'), join(backup, 'manifests'), { recursive: true })
  cpSync(join(root, 'workflow.sqlite'), join(backup, 'workflow.sqlite'))
  for (const suffix of ['-wal', '-shm']) {
    const file = join(root, `workflow.sqlite${suffix}`)
    if (existsSync(file)) cpSync(file, join(backup, `workflow.sqlite${suffix}`))
  }
  const restored = open(join(backup, 'workflow.sqlite'), backup)
  const copy = restored.readSnapshot(adoption.snapshotId)
  need(copy.contentHash === original.contentHash, 'restored content hash equals the original')
  need(copy.manifestHash === original.manifestHash, 'restored manifest hash equals the original')
  need(copy.content === original.content, 'restored content equals the original bytes')
  const exported = restored.exportSnapshot(adoption.snapshotId, join(backup, 'exported'), { expectedHash: candidate.contentHash })
  need(readFileSync(exported.path, 'utf8') === original.content, 'a restored copy exports the same bytes')

  const objectFile = join(backup, 'objects', candidate.contentHash.slice(0, 2), candidate.contentHash)
  // 同长度篡改：字节数校验看不出来，只有内容 hash 能抓到。
  writeFileSync(objectFile, 'recovery contenT', 'utf8')
  expectError(() => restored.readSnapshot(adoption.snapshotId), 'output_object_corrupt')
  expectError(() => restored.exportSnapshot(adoption.snapshotId, join(backup, 'exported-2')), 'output_object_corrupt')

  const manifestFile = join(backup, 'manifests', `${String(adoption.snapshotId.replace(':snapshot', '')).replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  writeFileSync(objectFile, 'recovery content', 'utf8')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, bytes: 1 }), 'utf8')
  expectError(() => restored.readSnapshot(adoption.snapshotId), 'snapshot_manifest_mismatch')
  writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8')

  // 老大独立反例：只改数据库里的快照 id，manifest 一个字节不动。manifest hash 仍与行记录相符，
  // 只有身份比对能抓到。
  restored.db.prepare('UPDATE workflow_snapshots SET id=? WHERE id=?').run('forged-id', adoption.snapshotId)
  expectError(() => restored.readSnapshot('forged-id'), 'snapshot_identity_mismatch', 'forged-id:manifest_snapshot_id')
  expectError(() => restored.exportSnapshot('forged-id', join(backup, 'exported-3')), 'snapshot_identity_mismatch')
  expectError(() => restored.readSnapshot(adoption.snapshotId), 'snapshot_not_found', `${adoption.snapshotId}:row_missing`)
  const forgedRow = restored.one('SELECT * FROM workflow_snapshots WHERE id=?', 'forged-id')
  need(forgedRow.manifest_hash === original.manifestHash, 'the forged row is otherwise untouched, so only identity can catch it')
  restored.db.prepare('UPDATE workflow_snapshots SET id=? WHERE id=?').run(adoption.snapshotId, 'forged-id')

  // 反向：只改 manifest 声明的 id（行不动），hash 校验先挡住。
  const manifestOnly = { ...manifest, snapshotId: 'forged-manifest-id' }
  writeFileSync(manifestFile, JSON.stringify(manifestOnly), 'utf8')
  expectError(() => restored.readSnapshot(adoption.snapshotId), 'snapshot_manifest_mismatch')
  writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8')

  // 老大第二轮反例：只改数据库里的 artifact_type，manifest 一个字节不动。行记录本身仍自洽
  // （manifest hash 相符、内容 hash 相符），只有类型比对能抓到。
  need(original.artifactType === 'text', 'the stored snapshot type is text')
  need(manifest.artifactType === 'text', 'the manifest declares the same type')
  restored.db.prepare('UPDATE workflow_snapshots SET artifact_type=? WHERE id=?').run('forged-artifact', adoption.snapshotId)
  expectError(() => restored.readSnapshot(adoption.snapshotId), 'snapshot_metadata_mismatch', `${adoption.snapshotId}:artifact_type`)
  expectError(() => restored.exportSnapshot(adoption.snapshotId, join(backup, 'exported-4')), 'snapshot_metadata_mismatch')
  const forgedType = restored.one('SELECT * FROM workflow_snapshots WHERE id=?', adoption.snapshotId)
  need(forgedType.artifact_type === 'forged-artifact' && forgedType.manifest_hash === original.manifestHash,
    'the forged type keeps every other column intact, so only the type check can catch it')
  need(!existsSync(join(backup, 'exported-4')), 'a rejected export leaves no file behind')
  restored.db.prepare('UPDATE workflow_snapshots SET artifact_type=? WHERE id=?').run('text', adoption.snapshotId)

  // 反向：只改 manifest 声明的类型（行不动），manifest hash 先挡住。
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, artifactType: 'image' }), 'utf8')
  expectError(() => restored.readSnapshot(adoption.snapshotId), 'snapshot_manifest_mismatch')
  writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8')

  need(restored.readSnapshot(adoption.snapshotId).verified === true, 'restoring both copies brings the snapshot back to verified')
  need(restored.readSnapshot(adoption.snapshotId).artifactType === 'text', 'the restored type matches the manifest again')
  return { restoredSnapshot: adoption.snapshotId }
})

// 04 进程中断后重开：只接续不重复发起，租约过期先被扫描出来再交接第二个 Attempt。
check('REC-04', 'reopen continues the interrupted attempt without re-issuing it', ({ root, open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-interrupted', steps: [auto('one'), auto('two')] })
  const first = kernel.claim('run-interrupted')
  need(first.kind === 'automatic', 'first claim hands out an automatic attempt')
  const firstSnapshot = kernel.storeCandidate({ attemptId: first.attemptId, token: first.token, content: 'partial work' })
  need(firstSnapshot.contentHash.length === 64, 'candidate is stored before the simulated crash')
  const eventsBefore = kernel.query("SELECT seq,type FROM workflow_events WHERE run_id=? ORDER BY seq", 'run-interrupted')
  kernel.db.close()

  const reopened = open()
  need(reopened.one('SELECT status FROM workflow_attempts WHERE id=?', first.attemptId).status === 'running', 'the interrupted attempt is still running after reopen')
  // 租约未到期时不能被报成过期，否则重启会把在途工作当成中断重复发起。
  const liveScan = reopened.scanRecoverable()
  need(!liveScan.items.some((item) => item.kind === 'lease_expired' && item.attemptId === first.attemptId), 'a lease that has not expired is not reported')
  const nowLater = new Date(Date.now() + 16 * 60 * 1000).toISOString()
  const dbBefore = stateFingerprint(reopened)
  const scan = reopened.scanRecoverable({ now: nowLater })
  need(stateFingerprint(reopened) === dbBefore, 'scanRecoverable does not reap or rewrite anything')
  const expired = scan.items.filter((item) => item.kind === 'lease_expired' && item.attemptId === first.attemptId)
  need(expired.length === 1, 'the expired attempt is reported exactly once')
  need(expired[0].stepId === first.attemptId.split(':attempt:')[0], 'the scan points at the blocked step')
  need(reopened.one('SELECT status FROM workflow_attempts WHERE id=?', first.attemptId).status === 'running', 'the attempt stays untouched until a claim')

  // 让租约在真实时钟上确实过期（等价于宿主停机超过租约时长），再交给下一次 claim 接续。
  const past = new Date(Date.now() - 1000).toISOString()
  reopened.db.prepare('UPDATE workflow_attempts SET lease_until=? WHERE id=?').run(past, first.attemptId)
  const second = reopened.claim('run-interrupted')
  need(second.attemptId !== first.attemptId, 'continuation is a new attempt, not the old one')
  need(second.attemptId === `${first.stepId ?? first.attemptId.split(':attempt:')[0]}:attempt:2`, 'continuation takes the next attempt number')
  const attempts = reopened.query('SELECT id, attempt_no, status, outcome FROM workflow_attempts WHERE step_id=? ORDER BY attempt_no', first.attemptId.split(':attempt:')[0])
  need(attempts.length === 2, 'exactly one retry attempt exists')
  need(attempts[0].status === 'expired' && attempts[0].outcome === 'lease_expired', 'the interrupted attempt is marked expired with its outcome')
  need(attempts[1].status === 'running', 'the continuation attempt is running')
  need(new Set(attempts.map((row) => row.id)).size === 2, 'attempt ids are unique')
  const eventsAfter = reopened.query("SELECT seq,type FROM workflow_events WHERE run_id=? ORDER BY seq", 'run-interrupted')
  need(eventsAfter.length > eventsBefore.length, 'the continuation appends events instead of replaying history')
  need(eventsAfter.slice(0, eventsBefore.length).every((row, index) => row.seq === eventsBefore[index].seq && row.type === eventsBefore[index].type), 'pre-existing events keep their seq and order')
  const seqs = eventsAfter.map((row) => Number(row.seq))
  need(seqs.every((seq, index) => seq === index + 1), 'event seq is contiguous after reopen')
  return { attempts: attempts.length, events: eventsAfter.length }
})

// 05 双连接（同库两个句柄）顺序交错调用同一 claim：先到的拿到 Attempt，后到的被拒，库里只留一条。
// 注意：这是交错调用，不是并发压测——本脚本单线程，不能证明多线程/多进程同时 claim 的互斥性。
check('REC-05', 'two connections alternating a claim keep a single attempt (sequential, not a stress test)', ({ root, open }) => {
  const dbPath = join(root, 'workflow.sqlite')
  const left = open(dbPath)
  const right = open(dbPath)
  left.createRun({ id: 'run-race' })
  const winner = left.claim('run-race')
  need(winner.kind === 'automatic', 'the connection that calls first wins the claim')
  expectError(() => right.claim('run-race'), 'step_not_claimable')
  const attempts = right.query("SELECT id FROM workflow_attempts WHERE step_id='run-race:step:1'")
  need(attempts.length === 1, 'the second call created no additional attempt')
  need(attempts[0].id === winner.attemptId, 'the stored attempt belongs to the winner')
  need(Number(right.one('SELECT budget_used FROM workflow_runs WHERE id=?', 'run-race').budget_used) === 1, 'budget is charged once')

  right.createRun({ id: 'run-race-2' })
  const winner2 = right.claim('run-race-2')
  expectError(() => left.claim('run-race-2'), 'step_not_claimable')
  need(left.query("SELECT id FROM workflow_attempts WHERE step_id='run-race-2:step:1'").length === 1, 'the refusal is symmetric: either connection can be the loser')
  return { winner: winner.attemptId, winner2: winner2.attemptId }
})

// 06 事件 seq：两个连接交替写同一 run，序号连续且不重复。
// 注意：同样是单线程交替写入，用来验证 seq 分配不依赖调用方，而不是并发压测结论。
check('REC-06', 'alternating appends from two connections keep seq contiguous (sequential, not a stress test)', ({ root, open }) => {
  const dbPath = join(root, 'workflow.sqlite')
  const left = open(dbPath)
  const right = open(dbPath)
  left.createRun({ id: 'run-events' })
  for (let index = 0; index < 5; index += 1) {
    left.appendEvent('run-events', 'left.tick', { index })
    right.appendEvent('run-events', 'right.tick', { index })
  }
  const rows = right.query('SELECT seq,type FROM workflow_events WHERE run_id=? ORDER BY seq', 'run-events')
  need(rows.length === 11, 'every alternating append landed exactly once')
  need(rows.every((row, index) => Number(row.seq) === index + 1), 'seq has no gap and no duplicate')
  need(new Set(rows.map((row) => Number(row.seq))).size === rows.length, 'seq values are unique')
  const last = Number(rows[rows.length - 1].seq)
  left.appendEvent('run-events', 'left.last', {})
  need(Number(right.one('SELECT MAX(seq) AS seq FROM workflow_events WHERE run_id=?', 'run-events').seq) === last + 1, 'the next append continues from the last seq')
  return { events: rows.length }
})

// 07 幂等请求保留期清理：窗口内重放仍返回原结果，过期清理后才允许重新执行。
check('REC-07', 'pruneRequests only drops replay records outside the retention window', ({ open }) => {
  const kernel = open()
  kernel.createRun({ id: 'run-idem', idempotencyKey: 'start-key', input: { fixture: true } })
  const replay = kernel.createRun({ id: 'run-idem', idempotencyKey: 'start-key', input: { fixture: true } })
  need(replay.replayed === true, 'a replay inside the window returns the original result')
  need(Number(kernel.one('SELECT COUNT(*) AS n FROM workflow_requests').n) >= 1, 'the replay record is stored')
  const kept = kernel.pruneRequests({ retentionMs: 365 * 24 * 60 * 60 * 1000 })
  need(kept.removed === 0, 'a wide retention window removes nothing')
  need(kernel.createRun({ id: 'run-idem', idempotencyKey: 'start-key', input: { fixture: true } }).replayed === true, 'the window still replays after a no-op prune')
  const pruned = kernel.pruneRequests({ retentionMs: 0, now: new Date(Date.now() + 60 * 1000).toISOString() })
  need(pruned.removed >= 1, 'an expired window removes the record')
  need(pruned.cutoff > new Date().toISOString() || pruned.retentionMs === 0, 'the cutoff is derived from the supplied clock')
  need(Number(kernel.one("SELECT COUNT(*) AS n FROM workflow_requests WHERE idempotency_key='start-key'").n) === 0, 'the pruned key is gone')
  expectError(() => kernel.createRun({ id: 'run-idem', idempotencyKey: 'start-key', input: { fixture: true } }), 'run_exists')
  expectError(() => kernel.pruneRequests({ retentionMs: -1 }), 'request_retention_invalid')
  return { removed: pruned.removed }
})

// 08 可恢复扫描覆盖面与纯读：七类条目各自都有正例与反例（负例证明不是"见到什么都报"）。
check('REC-08', 'scanRecoverable reports all seven recovery kinds, each with a negative case', ({ open }) => {
  const kernel = open()

  // 1) outbox_pending：必需发布未终结的运行。
  const pending = completeRun(kernel, { runId: 'run-pending', content: 'pending content', target: 'pd:fixture-pending' })
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', pending.outboxId).status === 'pending', 'the required publish is pending')
  // 反例：可选发布不收在 outbox_pending 里（它不阻塞完成）。
  const optionalRun = kernel.createRun({ id: 'run-optional-scan', steps: [auto('fake.transform', [{ target: 'ui:fixture-optional', required: false }])] })
  const optionalClaim = kernel.claim(optionalRun.runId)
  const optionalCandidate = kernel.storeCandidate({ attemptId: optionalClaim.attemptId, token: optionalClaim.token, content: 'optional scan content' })
  const optionalAdoption = kernel.adopt({ attemptId: optionalClaim.attemptId, token: optionalClaim.token, candidate: optionalCandidate, target: 'ui:fixture-optional', required: false })
  const optionalOutboxId = kernel.one('SELECT id FROM workflow_outbox WHERE adoption_id=?', optionalAdoption.adoptionId).id
  need(kernel.one('SELECT status FROM workflow_outbox WHERE id=?', optionalOutboxId).status === 'pending', 'the optional publish is also pending')

  // 2) outbox_outcome_unknown：结果未知的发布。
  const unknownRun = completeRun(kernel, { runId: 'run-unknown-scan', content: 'unknown content', target: 'pd:fixture-unknown' })
  const unknownScanClaim = claimPublish(kernel, unknownRun.outboxId, unknownRun.target)
  kernel.completeOutbox(unknownRun.outboxId, 'outcome_unknown', null, unknownScanClaim.claimGeneration)

  // 3) lease_expired：真实时钟上已过期的在途 Attempt。
  kernel.createRun({ id: 'run-lease' })
  const leaseClaim = kernel.claim('run-lease')
  kernel.db.prepare('UPDATE workflow_attempts SET lease_until=? WHERE id=?').run(new Date(Date.now() - 60 * 1000).toISOString(), leaseClaim.attemptId)

  // 4) step_stale：上游变更后需重跑的下游步骤。
  kernel.createRun({ id: 'run-stale', steps: [auto('one'), auto('two')] })
  const staleAttempt = kernel.claim('run-stale')
  kernel.storeCandidate({ attemptId: staleAttempt.attemptId, token: staleAttempt.token, content: 'stale upstream' })
  kernel.db.exec("UPDATE workflow_steps SET stale=1, state='stale' WHERE id='run-stale:step:2'")

  // 5) step_paused：单个 Attempt 被确认中止后步骤退回可领取前的暂停态。
  kernel.createRun({ id: 'run-step-paused' })
  const pausedAttempt = kernel.claim('run-step-paused')
  kernel.cancelAttempt(pausedAttempt.attemptId, 'host_confirmed_stop')

  // 6) run_paused：显式暂停。
  kernel.createRun({ id: 'run-explicit-paused' })
  kernel.claim('run-explicit-paused')
  kernel.pauseRun('run-explicit-paused')

  // 完成态运行不得出现在任何一类里（负例：finished 运行不算待恢复）。
  const closed = completeRun(kernel, { runId: 'run-closed', content: 'closed content', target: 'pd:fixture-closed' })
  const closedClaim = claimPublish(kernel, closed.outboxId, closed.target)
  kernel.completeOutbox(closed.outboxId, 'succeeded', null, closedClaim.claimGeneration)
  need(kernel.one('SELECT status FROM workflow_runs WHERE id=?', 'run-closed').status === 'completed', 'the closed run is completed')

  const runningPublish = completeRun(kernel, { runId: 'run-publish-running', content: 'running publish', target: 'pd:fixture-running' })
  const firstRunningClaim = claimPublish(kernel, runningPublish.outboxId, runningPublish.target)

  const dbBefore = stateFingerprint(kernel)
  const scanFilesBefore = JSON.stringify(objectTree(kernel.root))
  const scanClock = new Date().toISOString()
  const first = kernel.scanRecoverable({ now: scanClock })
  const second = kernel.scanRecoverable({ now: scanClock })
  need(JSON.stringify(first) === JSON.stringify(second), 'two scans with the same clock are identical')
  need(stateFingerprint(kernel) === dbBefore, 'scanRecoverable writes nothing')
  need(JSON.stringify(objectTree(kernel.root)) === scanFilesBefore, 'scanRecoverable preserves file paths and bytes')
  need(first.scannedAt === scanClock, 'the scan echoes the clock it was given')
  need(first.total === first.items.length, 'the total matches the item list')
  need(first.items.every((item) => RECOVERY_KINDS.includes(item.kind)), 'every reported kind is a known recovery kind')

  const ofKind = (kind) => first.items.filter((item) => item.kind === kind)
  const runningItems = ofKind('outbox_running')
  need(runningItems.length === 1 && runningItems[0].outboxId === runningPublish.outboxId && runningItems[0].target === runningPublish.target && runningItems[0].runId === 'run-publish-running', 'only the claimed running publish is reported with exact identity')
  need(!runningItems.some(item => item.outboxId === pending.outboxId || item.outboxId === closed.outboxId), 'pending and succeeded publishes are not running recovery items')

  // 发布诊断披露持久化值，不把更新时间冒充领取时间或租约。
  for (const id of [runningPublish.outboxId, unknownRun.outboxId, pending.outboxId]) {
    const row = kernel.one('SELECT claim_generation, updated_at FROM workflow_outbox WHERE id=?', id)
    const item = first.items.find(item => item.outboxId === id)
    need(item.claimGeneration === row.claim_generation, 'scan exposes the persisted publish generation')
    need(item.updatedAt === row.updated_at, 'scan exposes the persisted update timestamp')
  }

  // 1) outbox_pending 正例 + 反例
  const pendingItems = ofKind('outbox_pending')
  const pendingItem = pendingItems.find((item) => item.outboxId === pending.outboxId)
  need(Boolean(pendingItem) && pendingItem.runId === 'run-pending' && pendingItem.target === 'pd:fixture-pending', 'a required pending publish is reported with run and target')
  need(!pendingItems.some((item) => item.outboxId === optionalOutboxId), 'an optional pending publish is not reported as recoverable work')
  need(!pendingItems.some((item) => item.runId === 'run-closed'), 'a completed run contributes no pending publish')

  // 2) outbox_outcome_unknown 正例 + 反例
  const unknownItems = ofKind('outbox_outcome_unknown')
  const unknownItem = unknownItems.find((item) => item.outboxId === unknownRun.outboxId)
  need(Boolean(unknownItem) && unknownItem.target === 'pd:fixture-unknown', 'an unknown publish is reported with its target')
  need(!unknownItems.some((item) => item.outboxId === pending.outboxId), 'a merely pending publish is not reported as unknown')

  // 3) lease_expired 正例 + 反例
  const leaseItems = ofKind('lease_expired')
  const leaseItem = leaseItems.find((item) => item.attemptId === leaseClaim.attemptId)
  need(Boolean(leaseItem) && leaseItem.stepId === 'run-lease:step:1', 'an expired lease is reported with its step')
  need(leaseItem.leaseUntil < new Date().toISOString(), 'the reported lease is genuinely in the past')
  need(!leaseItems.some((item) => item.attemptId === pausedAttempt.attemptId), 'a cancelled attempt is not reported as an expired lease')
  need(!leaseItems.some((item) => item.runId === 'run-closed'), 'a completed run contributes no expired lease')
  const liveAttempt = kernel.one('SELECT id FROM workflow_attempts WHERE step_id=?', 'run-explicit-paused:step:1')
  need(!leaseItems.some((item) => item.attemptId === liveAttempt.id), 'a lease that has not expired is not reported')

  // 4) step_stale 正例 + 反例
  const staleItems = ofKind('step_stale')
  need(staleItems.some((item) => item.stepId === 'run-stale:step:2' && item.runId === 'run-stale'), 'a stale downstream step is reported')
  need(!staleItems.some((item) => item.stepId === 'run-closed:step:1'), 'a succeeded step is not reported as stale')

  // 5) step_paused 正例 + 反例
  const stepPausedItems = ofKind('step_paused')
  const stepPausedItem = stepPausedItems.find((item) => item.stepId === 'run-step-paused:step:1')
  need(Boolean(stepPausedItem) && stepPausedItem.runId === 'run-step-paused', 'a paused step is reported')
  need(!stepPausedItems.some((item) => item.stepId === 'run-closed:step:1'), 'a succeeded step is not reported as paused')
  need(!stepPausedItems.some((item) => item.runId === 'run-stale' && item.stepId === 'run-stale:step:1'), 'the running step is not reported as paused')

  // 6) run_paused 正例 + 反例
  const runPausedItems = ofKind('run_paused')
  const explicitItem = runPausedItems.find((item) => item.runId === 'run-explicit-paused')
  need(Boolean(explicitItem) && explicitItem.reason === 'user_paused', 'an explicitly paused run is reported with its reason')
  need(!runPausedItems.some((item) => item.runId === 'run-closed'), 'a completed run is not reported as paused')
  need(!runPausedItems.some((item) => item.runId === 'run-pending'), 'a running run is not reported as paused')

  // 七类都在，且没有多余种类。
  const present = [...new Set(first.items.map((item) => item.kind))].sort()
  need(present.length === RECOVERY_KINDS.length, `all seven recovery kinds must appear, got ${present.join(',')}`)
  need(RECOVERY_KINDS.every((kind) => present.includes(kind)), 'every declared recovery kind is exercised by this scenario')
  need(!first.items.some((item) => item.runId === pending.adoption.snapshotId), 'snapshot ids are not mistaken for run ids')
  // 同一发布项重领后，各分支必须报告真实代次，重试不能把代次当作在途状态。
  kernel.completeOutbox(runningPublish.outboxId, 'failed', null, firstRunningClaim.claimGeneration)
  kernel.retryOutbox(runningPublish.outboxId)
  const secondRunningClaim = claimPublish(kernel, runningPublish.outboxId, runningPublish.target)
  need(secondRunningClaim.claimGeneration === 2, 'the second claim reaches generation 2')
  const assertReclaimedScan = (kind) => {
    const before = stateFingerprint(kernel)
    const filesBefore = JSON.stringify(objectTree(kernel.root))
    const scan = kernel.scanRecoverable({ now: scanClock })
    const matches = scan.items.filter(item => item.outboxId === runningPublish.outboxId)
    need(matches.length === 1 && matches[0].kind === kind, `reclaimed publish has only the ${kind} recovery kind`)
    need(matches[0].claimGeneration === 2, `${kind} scan preserves generation 2`)
    const row = kernel.one('SELECT updated_at FROM workflow_outbox WHERE id=?', runningPublish.outboxId)
    need(matches[0].updatedAt === row.updated_at, `${kind} scan preserves persisted update time`)
    need(stateFingerprint(kernel) === before, `${kind} reclaimed scan writes nothing`)
    need(JSON.stringify(objectTree(kernel.root)) === filesBefore, `${kind} reclaimed scan preserves file paths and bytes`)
  }
  assertReclaimedScan('outbox_running')
  kernel.completeOutbox(runningPublish.outboxId, 'outcome_unknown', null, secondRunningClaim.claimGeneration)
  assertReclaimedScan('outbox_outcome_unknown')
  // 观测到目标仍是基准正文 → absent，item 回到 pending（这是扫描要报告的第三态）。
  kernel.reconcilePublishEffect(runningPublish.outboxId, {
    actorId: 'fixture-reconciler',
    claimGeneration: secondRunningClaim.claimGeneration,
    observe: fixtureTarget(runningPublish.target).observe,
  })
  assertReclaimedScan('outbox_pending')
  return { items: first.total, kinds: present }
})

const failed = results.filter((result) => result.status !== 'pass')
process.stdout.write(`${JSON.stringify({ checks: results.length, passed: results.length - failed.length, assertions, results }, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
