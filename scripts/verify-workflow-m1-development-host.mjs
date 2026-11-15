import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { verifyDevelopmentBackup } from '../src/workflow/m1-development-backup.mjs'
import { createDevelopmentHost } from '../src/workflow/m1-development-host.mjs'
import { createDevelopmentApp } from '../src/workflow/m1-development-app.mjs'
import { createDevelopmentBridge } from '../src/client/workflow/development-bridge.mjs'

const host = createDevelopmentHost()
assert.throws(() => host.backup(), /development_host_requires_closed/)
host.create()
const bridge = createDevelopmentBridge(message => host.dispatch(message))
const runId = 'host-restore-fixture'
await bridge.start({ runId, checked: true })
const advancing = bridge.advance(runId)
assert.throws(() => host.close(), /development_operation_in_progress/)
assert.equal(host.inspect().state, 'open')
const waiting = await advancing
assert.equal(waiting.run.status, 'waiting_review')
assert.throws(() => host.backup(), /development_host_requires_closed/)
await assert.rejects(host.dispatch({ method: 'backup', args: [] }), /development_message_invalid/)
host.close()
assert.throws(() => bridge.read(runId), /development_host_requires_open/)
const backup = host.backup()
const backupFiles = readdirSync(backup.directory).sort()
const backupDb = readFileSync(join(backup.directory, 'workflow.sqlite'))
verifyDevelopmentBackup(backup.directory)
verifyDevelopmentBackup(backup.directory)
assert.deepEqual(readdirSync(backup.directory).sort(), backupFiles)
assert.deepEqual(readFileSync(join(backup.directory, 'workflow.sqlite')), backupDb)
// Extra sidecars remain a manifest violation; verification must not hide them.
const unexpected = join(backup.directory, 'workflow.sqlite-wal')
assert.ok(!backupFiles.includes('workflow.sqlite-wal'))
writeFileSync(unexpected, '', { flag: 'wx' })
assert.throws(() => verifyDevelopmentBackup(backup.directory), /backup_file_set_mismatch/)
unlinkSync(unexpected)
const restored = createDevelopmentHost()
assert.throws(() => restored.restore(backup.directory + '-missing'))
assert.equal(restored.inspect().state, 'empty')
restored.restore(backup.directory)
assert.equal(restored.inspect().state, 'restored')
assert.equal(restored.inspect().executionEnabled, false)
assert.throws(() => restored.dispatch({ method: 'read', args: [runId] }), /development_host_requires_open/)
restored.openRestored()
try {
  const reopened = await restored.dispatch({ method: 'read', args: [runId] })
  assert.equal(reopened.run.status, 'waiting_review')
  assert.equal(reopened.run.budget_used, waiting.run.budget_used)
  assert.deepEqual(reopened.tasks, waiting.tasks)
  assert.deepEqual(reopened.adoptions, waiting.adoptions)
  assert.deepEqual(reopened.publications, waiting.publications)
} finally { restored.close() }
let send
let unmounted = 0
const app = createDevelopmentApp({ ctx: {}, mountPanel: (_ctx, transport) => { send = transport; return () => { unmounted++ } } })
const pending = send({ method: 'start', args: [{ runId: 'app-fixture' }] })
await pending
app.dispose()
app.dispose()
assert.equal(unmounted, 1)
await assert.rejects(send({ method: 'read', args: ['app-fixture'] }), /development_app_closed/)
assert.ok(app.backup())
console.log('PASS development bridge, active-close guard, closed backup, explicit restore/open, app disposal; temporary SQLite only')
