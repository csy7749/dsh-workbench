import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { nativeGameFiles as files } from './native-game-studio.mjs'
import { gameTemplateSource } from './native-game-template.mjs'
import { validateGamePlaytestEvidence } from '../packs/game/review.mjs'

const fail = code => { throw new Error(code) }
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
const idOf = id => { if (!/^[a-f0-9]{16}$/.test(id ?? '')) fail('game_revision_id_invalid'); return id }
function releaseClaim(path, token) {
  try { if (JSON.parse(files.readFile(path, 4096)).token === token) rmSync(path) } catch { /* Preserve uncertain ownership. */ }
}
function createClaim(path, owner) {
  let fd
  try { fd = openSync(path, 'wx') } catch (error) { if (error.code === 'EEXIST') fail('game_revision_busy'); throw error }
  try { writeFileSync(fd, files.json(owner)) } catch (error) {
    // A failed first write must not strand a proposed candidate behind an empty
    // lock. The open descriptor pins exactly the file this call just created.
    try { const a = fstatSync(fd), b = lstatSync(path); if (a.ino === b.ino && a.dev === b.dev && b.isFile() && !b.isSymbolicLink()) rmSync(path) } catch { /* Fail closed if identity is uncertain. */ }
    throw error
  } finally { closeSync(fd) }
  return () => releaseClaim(path, owner.token)
}
function noRecovery(root) {
  try { lstatSync(join(root, 'revision-recovery.lock')); fail('game_revision_busy') } catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** Source proposals never run in the host. Testing temporarily applies a CAS-guarded
 * candidate, keeps every build/report, and only accepts a clean real browser result. */
export function createNativeGameRevisions({ studio, playtester, maxCandidates = 64 } = {}) {
  const location = args => {
    const project = files.project(args)
    const root = files.directory(join(project.project, '.studio/revisions'), true)
    return { ...project, root }
  }
  function read(args) {
    const p = location(args), candidateId = idOf(args.candidateId)
    const folder = files.directory(join(p.root, candidateId))
    const proposalText = files.readFile(join(folder, 'proposal.json'), 64 * 1024)
    const proposal = JSON.parse(proposalText)
    const source = files.readFile(join(folder, 'candidate.js'), 1024 * 1024)
    const baseline = files.readFile(join(folder, 'baseline.js'), 1024 * 1024)
    const { candidateId: storedId, ...identity } = proposal
    if (storedId !== candidateId || proposal.projectId !== p.record.projectId || proposal.productId !== args.productId
      || files.hash(source) !== proposal.sourceHash || files.hash(baseline) !== proposal.baselineSourceHash
      || files.hash(JSON.stringify(identity)).slice(0, 16) !== candidateId) fail('game_revision_integrity_invalid')
    const status = JSON.parse(files.readFile(join(folder, 'status.json'), 256 * 1024))
    if (status.candidateId !== candidateId || status.proposalHash !== files.hash(proposalText)) fail('game_revision_integrity_invalid')
    return { ...p, folder, proposal, source, baseline, status }
  }
  const summary = value => ({ ...value.proposal, ...value.status, candidatePath: value.portable(value.folder), source: undefined, baseline: undefined })
  const status = (value, patch) => {
    const next = { ...value.status, ...patch, updatedAt: new Date().toISOString() }
    files.atomicFile(join(value.folder, 'status.json'), files.json(next))
    value.status = next
    return next
  }
  function rollback(args, value) {
    const current = studio.currentState(args)
    if (current.sourceHash === value.proposal.baselineSourceHash && current.manifestHash === value.proposal.manifestHash) return { alreadyOriginal: true }
    if (current.sourceHash !== value.proposal.sourceHash || current.manifestHash !== value.proposal.manifestHash) fail('game_revision_rollback_conflict')
    const restored = studio.rollbackUpdate({ ...args, backupPath: value.rollbackBackupPath ?? value.status.rollbackBackupPath, beforeHash: value.proposal.baseCurrentHash, expectedCurrentHash: current.currentHash })
    return { buildId: restored.buildId, restored: true, playtestStatus: 'not_assessed' }
  }
  return {
    propose(args) {
      const p = location(args)
      const built = studio.readBuild({ ...args, buildId: args.expectedBuildId })
      const current = studio.currentState(args)
      if (!built.buildCurrent || built.sourceHash !== current.sourceHash || built.manifestHash !== current.manifestHash
        || (args.expectedCurrentHash && current.currentHash !== args.expectedCurrentHash)) fail('game_revision_base_conflict')
      if (typeof args.source !== 'string' || !args.source.trim() || Buffer.byteLength(args.source) > 1024 * 1024) fail('game_revision_source_invalid')
      if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000) fail('game_revision_reason_required')
      if (args.source === current.source) fail('game_revision_no_change')
      const identity = { schemaVersion: 1, productId: args.productId, projectId: p.record.projectId, baseBuildId: built.buildId,
        baseCurrentHash: current.currentHash, baselineSourceHash: current.sourceHash, manifestHash: current.manifestHash,
        sourceHash: files.hash(args.source), reason: args.reason.trim(), provider: args.provider === 'native-template-repair' ? args.provider : 'source-proposal' }
      const candidateId = files.hash(JSON.stringify(identity)).slice(0, 16)
      const folder = join(p.root, candidateId)
      try { files.directory(folder); return summary(read({ ...args, candidateId })) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (readdirSync(p.root).filter(name => /^[a-f0-9]{16}$/.test(name)).length >= maxCandidates) fail('game_revision_quota_exceeded')
      const pending = join(p.root, '.pending-' + randomUUID())
      mkdirSync(pending)
      try {
        const proposal = { candidateId, ...identity }, text = files.json(proposal)
        writeFileSync(join(pending, 'proposal.json'), text, { flag: 'wx' })
        writeFileSync(join(pending, 'candidate.js'), args.source, { flag: 'wx' })
        writeFileSync(join(pending, 'baseline.js'), current.source, { flag: 'wx' })
        writeFileSync(join(pending, 'status.json'), files.json({ candidateId, proposalHash: files.hash(text), status: 'proposed', createdAt: new Date().toISOString() }), { flag: 'wx' })
        renameSync(pending, folder)
      } finally { rmSync(pending, { recursive: true, force: true }) }
      return summary(read({ ...args, candidateId }))
    },
    list(args) {
      const p = location(args)
      return readdirSync(p.root).filter(name => /^[a-f0-9]{16}$/.test(name)).map(candidateId => summary(read({ ...args, candidateId })))
    },
    read(args) { return summary(read(args)) },
    async verify(args) {
      const value = read(args)
      if (args.signal?.aborted) fail('game_operation_cancelled')
      if (value.status.status !== 'proposed') fail('game_revision_already_attempted')
      noRecovery(value.root)
      const lock = join(value.root, 'revision.lock'), token = randomUUID()
      const release = createClaim(lock, { candidateId: args.candidateId, pid: process.pid, token, createdAt: new Date().toISOString() })
      let applied = false
      try {
        // Re-read after claiming: another process may have finished this proposal.
        const fresh = read(args)
        if (fresh.status.status !== 'proposed') fail('game_revision_already_attempted')
        const current = studio.currentState(args)
        if (current.currentHash !== value.proposal.baseCurrentHash) fail('game_revision_base_conflict')
        status(value, { status: 'verifying', pid: process.pid, token })
        const built = studio.updateProject({ ...args, source: value.source, expectedCurrentHash: current.currentHash })
        applied = true
        value.rollbackBackupPath = built.backupPath
        status(value, { appliedBuildId: built.buildId, appliedCurrentHash: studio.currentState(args).currentHash, rollbackBackupPath: built.backupPath })
        const report = await playtester.playtest({ ...args, buildId: built.buildId })
        const actual = studio.readPlaytest({ ...args, buildId: built.buildId, reportPath: report.reportPath, reportHash: report.reportHash })
        const reportRef = { reportPath: report.reportPath, reportHash: report.reportHash, buildId: built.buildId }
        if (args.signal?.aborted) fail('game_operation_cancelled')
        if (!validateGamePlaytestEvidence(JSON.stringify(actual))) {
          const recovery = rollback(args, value)
          status(value, { status: 'rejected', report: reportRef, recovery })
          return { ...summary(value), accepted: false, report: actual }
        }
        status(value, { status: 'accepted', report: reportRef })
        return { ...summary(value), ...built, accepted: true, report: actual }
      } catch (error) {
        let recovery
        if (applied) {
          try { recovery = rollback(args, value) } catch (conflict) { status(value, { status: 'conflict', error: conflict.message, cause: error.message }); throw conflict }
        }
        status(value, { status: args.signal?.aborted ? 'cancelled' : 'rejected', error: error.message, ...(recovery ? { recovery } : {}) })
        throw error
      } finally {
        // Never remove a successor's lock.
        release()
      }
    },
    recover(args) {
      const initial = read(args), lock = join(initial.root, 'revision.lock'), token = randomUUID()
      // Only one process may inspect/delete a dead claim. Verification observes
      // this guard too; a crashed guard deliberately requires manual inspection.
      const releaseGuard = createClaim(join(initial.root, 'revision-recovery.lock'), { candidateId: args.candidateId, pid: process.pid, token, createdAt: new Date().toISOString() })
      try {
        const value = read(args)
        if (!['verifying', 'unknown', 'conflict'].includes(value.status.status)) fail('game_revision_recovery_not_required')
        if (value.status.status === 'verifying' && alive(value.status.pid)) fail('game_revision_busy')
        if (studio.currentState(args).currentHash !== args.expectedCurrentHash) fail('game_revision_base_conflict')
        try {
          const text = files.readFile(lock, 4096)
          let owner
          try { owner = JSON.parse(text) } catch { fail('game_revision_busy') }
          if (owner.candidateId !== args.candidateId || !Number.isInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)
            || !/^[a-f0-9-]{36}$/.test(owner.token ?? '') || owner.token !== value.status.token) fail('game_revision_busy')
          if (files.readFile(lock, 4096) !== text) fail('game_revision_busy')
          rmSync(lock)
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        const release = createClaim(lock, { candidateId: args.candidateId, pid: process.pid, token, createdAt: new Date().toISOString() })
        try {
          if (studio.currentState(args).currentHash !== args.expectedCurrentHash) fail('game_revision_base_conflict')
          const recovery = rollback(args, value)
          status(value, { status: 'recovered', recovery })
          return summary(value)
        } finally { release() }
      } finally { releaseGuard() }
    },
    /** The only automatic repair is an explicit return to the original approved
     * collector implementation; never change rules or claim arbitrary AI repair. */
    canonical(args) { return this.propose({ ...args, source: gameTemplateSource, reason: '真实试玩失败：恢复已批准的 canvas-collector@1 原创标准实现；规则、方向及采用素材保持当前批准值。', provider: 'native-template-repair' }) },
  }
}
