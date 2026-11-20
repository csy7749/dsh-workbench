/** CAS/journal regressions use explicitly synthetic evidence; --browser also
 * exercises actual accepted/rejected source candidates and trusted repair. */
import assert from 'node:assert/strict'
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNativeGameStudio } from '../src/host/native-game-studio.mjs'
import { createNativeGameRevisions } from '../src/host/native-game-revisions.mjs'
import { createNativeGamePlaytester } from '../src/host/native-game-playtest.mjs'
import { createWorkflowNativeGame } from '../src/host/workflow-native-game.mjs'

const workspaceRoot = mkdtempSync(join(tmpdir(), 'native-revisions-'))
const studio = createNativeGameStudio(), productId = 'revision-fixture'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDXkAAAAASUVORK5CYII=', 'base64')
try {
  let built = studio.create({ workspaceRoot, productId, slug: 'source-candidates', title: '修订测试', rules: { durationSeconds: 3, hearts: 3 } })
  const target = { workspaceRoot, productId, slug: built.slug }
  const original = studio.readBuild({ ...target, buildId: built.buildId }).source
  let mode = 'pass'
  const synthetic = { async playtest(args) {
    if (mode === 'cancel') throw new Error('game_operation_cancelled')
    if (mode === 'external') { const state = studio.currentState(target); studio.updateProject({ ...target, expectedCurrentHash: state.currentHash, source: state.source + '\n// external edit\n' }) }
    return studio.recordPlaytest({ ...args, report: { playtestStatus: mode === 'fail' ? 'failed' : 'passed', finalPhase: 'won', errors: mode === 'fail' ? 1 : 0, requests: 0, summary: 'SYNTHETIC TEST FIXTURE; Errors: none; Screenshots: synthetic.png' }, screenshots: [{ name: 'synthetic.png', data: png }] })
  } }
  const revisions = createNativeGameRevisions({ studio, playtester: synthetic })
  const propose = (suffix, reason = suffix) => revisions.propose({ ...target, expectedBuildId: built.buildId, source: original + '\n// ' + suffix + '\n', reason })
  const candidate = propose('candidate one')
  assert.equal(studio.currentState(target).source, original, 'proposal does not change source')
  const applied = await revisions.verify({ ...target, candidateId: candidate.candidateId, seconds: 4 })
  assert.equal(applied.accepted, true)
  built = applied
  await assert.rejects(() => revisions.verify({ ...target, candidateId: candidate.candidateId }), /already_attempted/)
  mode = 'fail'
  const before = studio.currentState(target), bad = propose('rejected candidate')
  const rejected = await revisions.verify({ ...target, candidateId: bad.candidateId })
  assert.equal(rejected.accepted, false)
  assert.equal(studio.currentState(target).currentHash, before.currentHash, 'failed candidate rolled back exactly')
  mode = 'cancel'
  const cancelled = propose('cancelled candidate')
  await assert.rejects(() => revisions.verify({ ...target, candidateId: cancelled.candidateId }), /game_operation_cancelled/)
  assert.equal(studio.currentState(target).currentHash, before.currentHash)
  const syntax = revisions.propose({ ...target, expectedBuildId: built.buildId, source: 'function (', reason: 'bad syntax fixture' })
  await assert.rejects(() => revisions.verify({ ...target, candidateId: syntax.candidateId }), /syntax/)
  assert.equal(studio.currentState(target).currentHash, before.currentHash)
  mode = 'external'
  const conflict = propose('external concurrent edit')
  await assert.rejects(() => revisions.verify({ ...target, candidateId: conflict.candidateId }), /rollback_conflict/)
  assert.match(studio.currentState(target).source, /external edit/)
  assert.equal(revisions.read({ ...target, candidateId: conflict.candidateId }).status, 'conflict')
  const sourceFile = join(workspaceRoot, built.project, 'game.js')
  const external = readFileSync(sourceFile, 'utf8')
  assert.throws(() => revisions.recover({ ...target, candidateId: conflict.candidateId, expectedCurrentHash: '0'.repeat(64) }), /base_conflict/)
  assert.equal(readFileSync(sourceFile, 'utf8'), external)
  const state = studio.currentState(target)
  studio.updateProject({ ...target, source: original, expectedCurrentHash: state.currentHash })
  built = studio.build(target)
  mode = 'pass'
  const baseConflict = propose('changed after proposal')
  writeFileSync(sourceFile, original + '\n// changed outside service\n')
  await assert.rejects(() => revisions.verify({ ...target, candidateId: baseConflict.candidateId }), /base_conflict/)
  writeFileSync(sourceFile, original)
  const crash = propose('crash fixture')
  const crashDir = join(workspaceRoot, built.project, '.studio/revisions', crash.candidateId)
  studio.updateProject({ ...target, source: original + '\n// crash fixture\n', expectedCurrentHash: studio.currentState(target).currentHash })
  const journal = JSON.parse(readFileSync(join(crashDir, 'status.json'), 'utf8'))
  writeFileSync(join(crashDir, 'status.json'), JSON.stringify({ ...journal, status: 'verifying', pid: 2147483647 }))
  const recovered = revisions.recover({ ...target, candidateId: crash.candidateId, expectedCurrentHash: studio.currentState(target).currentHash })
  assert.equal(recovered.status, 'recovered')
  assert.equal(studio.currentState(target).source, original)
  assert.equal(revisions.list(target).length, 7)
  console.log('PASS source revisions synthetic regressions: proposal isolation, clean acceptance, no replay, failed/cancelled/syntax rollback, CAS refusal, external-edit preservation, explicit crash recovery')

  // The trial itself fills both quotas. Reject/cancel must reuse the verified
  // original snapshot and backup rather than allocating a second restore.
  for (const cancelled of [false, true]) {
    const capped = createNativeGameStudio({ quotas: { maxRestoreBackups: 1, maxBuilds: 2 } })
    const cappedTarget = { workspaceRoot, productId, slug: cancelled ? 'quota-cancel' : 'quota-reject' }
    const base = capped.create({ ...cappedTarget, title: '满配额回退', rules: { durationSeconds: 3, hearts: 3 } })
    const before = capped.currentState(cappedTarget)
    const limited = createNativeGameRevisions({ studio: capped, playtester: { async playtest(args) {
      if (cancelled) throw new Error('game_operation_cancelled')
      return capped.recordPlaytest({ ...args, report: { playtestStatus: 'failed', finalPhase: 'lost', errors: 1, requests: 0, summary: 'SYNTHETIC QUOTA FIXTURE' }, screenshots: [{ name: 'synthetic.png', data: png }] })
    } } })
    const proposal = limited.propose({ ...cappedTarget, expectedBuildId: base.buildId, source: before.source + '\n// fills final available build and backup\n', reason: 'full quota rollback fixture' })
    if (cancelled) await assert.rejects(() => limited.verify({ ...cappedTarget, candidateId: proposal.candidateId }), /game_operation_cancelled/)
    else assert.equal((await limited.verify({ ...cappedTarget, candidateId: proposal.candidateId })).accepted, false)
    assert.equal(capped.currentState(cappedTarget).currentHash, before.currentHash)
    assert.equal(capped.readBuild({ ...cappedTarget, buildId: base.buildId }).buildCurrent, true)
    assert.equal(capped.listBuilds(cappedTarget).length, 2)
  }
  console.log('PASS source revision rejection/cancellation restores original at full build and backup quotas')

  // An editor changing source or raw manifest bytes between the snapshot read
  // and baseline read must not rebind an old expectedBuildId to a new baseline.
  const raceTarget = { workspaceRoot, productId, slug: 'proposal-read-race' }
  const raceBuild = studio.create({ ...raceTarget, title: '快照绑定竞态' }), raceBefore = studio.currentState(raceTarget)
  const raceProject = join(workspaceRoot, raceBuild.project)
  for (const field of ['source', 'manifest']) {
    const changing = createNativeGameRevisions({ studio: { ...studio, readBuild(args) {
      const result = studio.readBuild(args)
      if (field === 'source') writeFileSync(join(raceProject, 'game.js'), raceBefore.source + '\n// changed between reads\n')
      else writeFileSync(join(raceProject, 'game.json'), raceBefore.manifestText + '\n')
      return result
    } }, playtester: synthetic })
    assert.throws(() => changing.propose({ ...raceTarget, expectedBuildId: raceBuild.buildId, source: raceBefore.source + '\n// proposed\n', reason: 'snapshot binding fixture' }), /game_revision_base_conflict/)
    writeFileSync(join(raceProject, 'game.js'), raceBefore.source)
    writeFileSync(join(raceProject, 'game.json'), raceBefore.manifestText)
  }

  const guardedTarget = { workspaceRoot, productId, slug: 'guarded-recovery' }
  const guardedBuild = studio.create({ ...guardedTarget, title: '恢复互斥测试' }), guardedBefore = studio.currentState(guardedTarget)
  const guarded = createNativeGameRevisions({ studio, playtester: synthetic })
  const crashed = guarded.propose({ ...guardedTarget, expectedBuildId: guardedBuild.buildId, source: guardedBefore.source + '\n// crash owner\n', reason: 'guarded stale-owner recovery' })
  const waiting = guarded.propose({ ...guardedTarget, expectedBuildId: guardedBuild.buildId, source: guardedBefore.source + '\n// waiting candidate\n', reason: 'guarded verification' })
  const trial = studio.updateProject({ ...guardedTarget, source: guardedBefore.source + '\n// crash owner\n', expectedCurrentHash: guardedBefore.currentHash })
  const revisionRoot = join(workspaceRoot, guardedBuild.project, '.studio/revisions'), recoveryGuard = join(revisionRoot, 'revision-recovery.lock'), revisionLock = join(revisionRoot, 'revision.lock')
  const statusPath = join(revisionRoot, crashed.candidateId, 'status.json'), statusBefore = JSON.parse(readFileSync(statusPath, 'utf8')), deadToken = randomUUID()
  let deadPid
  for (const pid of [2147483647, 2147483646, 999999]) { try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') { deadPid = pid; break } } }
  assert(deadPid)
  const deadJournal = JSON.stringify({ ...statusBefore, status: 'verifying', pid: deadPid, token: deadToken })
  const deadLock = JSON.stringify({ candidateId: crashed.candidateId, pid: deadPid, token: deadToken })
  writeFileSync(statusPath, deadJournal); writeFileSync(revisionLock, deadLock)
  const recoveryArgs = { ...guardedTarget, candidateId: crashed.candidateId, expectedCurrentHash: trial.currentHash }
  assert.throws(() => guarded.recover({ ...recoveryArgs, expectedCurrentHash: '0'.repeat(64) }), /game_revision_base_conflict/)
  assert.equal(readFileSync(statusPath, 'utf8'), deadJournal, 'failed CAS cannot alter the candidate journal')
  assert.equal(readFileSync(revisionLock, 'utf8'), deadLock, 'failed CAS cannot consume a stale owner claim')
  assert.equal(existsSync(recoveryGuard), false)
  writeFileSync(recoveryGuard, 'interrupted recovery; fail closed')
  await assert.rejects(() => guarded.verify({ ...guardedTarget, candidateId: waiting.candidateId }), /game_revision_busy/)
  assert.throws(() => guarded.recover(recoveryArgs), /game_revision_busy/)
  assert.equal(readFileSync(recoveryGuard, 'utf8'), 'interrupted recovery; fail closed')
  rmSync(recoveryGuard)

  // Deterministically enter a second recovery exactly while the first removes
  // its dead lock. The guard must block it before any successor can be deleted.
  const originalRm = fs.rmSync
  let nested = false, concurrentVerify
  fs.rmSync = (path, ...args) => {
    if (path === revisionLock && !nested) {
      nested = true
      assert.throws(() => guarded.recover(recoveryArgs), /game_revision_busy/)
      concurrentVerify = guarded.verify({ ...guardedTarget, candidateId: waiting.candidateId }).then(() => assert.fail('verification must honor the recovery guard'), error => assert.match(error.message, /game_revision_busy/))
    }
    return originalRm(path, ...args)
  }
  syncBuiltinESMExports()
  try { assert.equal(guarded.recover(recoveryArgs).status, 'recovered') }
  finally { fs.rmSync = originalRm; syncBuiltinESMExports() }
  assert.equal(nested, true); await concurrentVerify
  assert.equal(studio.currentState(guardedTarget).currentHash, guardedBefore.currentHash)
  assert.equal(existsSync(revisionLock), false); assert.equal(existsSync(recoveryGuard), false)
  const originalWrite = fs.writeFileSync
  fs.writeFileSync = (file, data, ...args) => { if (typeof file === 'number') throw new Error('fixture_lock_write_failure'); return originalWrite(file, data, ...args) }
  syncBuiltinESMExports()
  try { await assert.rejects(() => guarded.verify({ ...guardedTarget, candidateId: waiting.candidateId }), /fixture_lock_write_failure/) }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
  assert.equal(existsSync(revisionLock), false, 'failed initial lock write closes and removes only its own file')
  assert.equal(guarded.read({ ...guardedTarget, candidateId: waiting.candidateId }).status, 'proposed')
  console.log('PASS exact source/manifest snapshot binding, failed recovery CAS preservation, interrupted recovery guard, deterministic concurrent recovery/verify exclusion, and failed claim-write cleanup')

  if (process.argv.includes('--browser')) {
    const playtester = createNativeGamePlaytester({ studio })
    const real = createNativeGameRevisions({ studio, playtester })
    built = studio.build(target)
    const good = real.propose({ ...target, expectedBuildId: built.buildId, source: original + '\n// actual browser candidate\n', reason: 'real browser unchanged-mechanics candidate' })
    const passed = await real.verify({ ...target, candidateId: good.candidateId, seconds: 5 })
    assert.equal(passed.accepted, true, JSON.stringify(passed))
    const bad = real.propose({ ...target, expectedBuildId: passed.buildId, source: original + '\nthrow new Error("actual revision defect")\n', reason: 'intentional real browser defect' })
    const failed = await real.verify({ ...target, candidateId: bad.candidateId, seconds: 5 })
    assert.equal(failed.accepted, false)
    assert(failed.report.errors > 0)
    assert.equal(studio.currentState(target).sourceHash, passed.sourceHash)
    const beforeCancel = studio.currentState(target)
    const toCancel = real.propose({ ...target, expectedBuildId: passed.buildId, source: beforeCancel.source + '\n// real cancellation candidate\n', reason: 'real browser cancellation' })
    const controller = new AbortController(), cancelTimer = setTimeout(() => controller.abort(), 600)
    try { await assert.rejects(() => real.verify({ ...target, candidateId: toCancel.candidateId, seconds: 5, signal: controller.signal }), /game_operation_cancelled/) } finally { clearTimeout(cancelTimer) }
    assert.equal(studio.currentState(target).currentHash, beforeCancel.currentHash)
    assert.equal(real.read({ ...target, candidateId: toCancel.candidateId }).status, 'cancelled')
    const broken = studio.updateProject({ ...target, source: original + '\nthrow new Error("repair loop fixture")\n', expectedCurrentHash: studio.currentState(target).currentHash })
    const workspaceIdentity = (await import('node:crypto')).createHash('sha256').update(workspaceRoot).digest('hex')
    const adapter = createWorkflowNativeGame({ studio, playtester, products: () => [{ id: productId, workspacePath: workspaceRoot }] })
    const evidence = await adapter.execute({ productId, runId: 'real-repair-fixture', nodeId: 'playtest', attemptId: 'repair-one', type: 'game.playtest', config: { seconds: 5 }, sources: [{ type: 'game.create', result: { ...broken, workspaceIdentity } }], approved: [], signal: new AbortController().signal })
    assert.equal(evidence.playtestStatus, 'passed', JSON.stringify(evidence))
    assert.equal(evidence.repairs[0].accepted, true)
    assert.equal(evidence.failedPlaytests.length, 1)
    assert.notEqual(evidence.buildId, broken.buildId)
    console.log('PASS actual Edge source candidate acceptance/rejection/cancellation/rollback + trusted one-round canonical repair; failed and final reports preserved')
  }
} finally { rmSync(workspaceRoot, { recursive: true, force: true }) }
