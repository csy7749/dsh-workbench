// W0 protocol experiment, not production workflow implementation.
// Child exits model process crashes; this does not simulate power loss.
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, openSync, fsyncSync, closeSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const sha = value => createHash('sha256').update(value).digest('hex')
const body = 'synthetic frozen output'
const hash = sha(body)
const mode = process.argv[2]
if (mode === '--child') {
  const [root, cut] = process.argv.slice(3)
  const db = new DatabaseSync(join(root, 'probe.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON')
  const staged = join(root, 'staging', hash)
  // Windows FlushFileBuffers needs a writable handle.
  const fd = openSync(staged, 'wx')
  try { writeFileSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
  if (cut === 'before-object') process.exit(71)
  renameSync(staged, join(root, 'objects', hash))
  if (cut === 'after-object') process.exit(72)
  db.exec('BEGIN IMMEDIATE')
  db.prepare('INSERT INTO snapshots VALUES (?,?)').run('snapshot-1', hash)
  db.prepare('INSERT INTO adoptions VALUES (?,?)').run('adoption-1', 'snapshot-1')
  db.exec("INSERT INTO events VALUES (1, 'adopted'); INSERT INTO outbox VALUES ('publish-1','pending')")
  if (cut === 'before-commit') process.exit(73)
  db.exec('COMMIT')
  if (cut === 'after-commit') process.exit(74)
  db.close()
  process.exit(0)
}
const root = mkdtempSync(join(tmpdir(), 'workflow-durability-'))
const results = []
for (const [cut, code, committed] of [['before-object',71,false], ['after-object',72,false], ['before-commit',73,false], ['after-commit',74,true]]) {
  const dir = join(root, cut)
  mkdirSync(join(dir, 'staging'), { recursive:true }); mkdirSync(join(dir, 'objects'))
  let db = new DatabaseSync(join(dir, 'probe.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE snapshots(id TEXT PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE adoptions(id TEXT PRIMARY KEY, snapshot_id TEXT REFERENCES snapshots(id));
    CREATE TABLE events(seq INTEGER PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE outbox(id TEXT PRIMARY KEY, status TEXT NOT NULL);`)
  db.close()
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', dir, cut], { stdio:'inherit' })
  if (child.error) throw child.error
  assert.equal(child.status, code, cut)
  db = new DatabaseSync(join(dir, 'probe.sqlite'))
  for (const table of ['snapshots','adoptions','events','outbox']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, committed ? 1 : 0, `${cut}:${table}`)
  }
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  const object = join(dir, 'objects', hash)
  assert.equal(existsSync(object), cut !== 'before-object')
  if (existsSync(object)) assert.equal(sha(readFileSync(object)), hash)
  // Reopening never dispatches outbox; a pending operation remains pending.
  if (committed) assert.equal(db.prepare('SELECT status FROM outbox').get().status, 'pending')
  db.close()
  results.push({ cut, committed, objectPresent: existsSync(object) })
}
console.log(JSON.stringify({ scope:'W0 synthetic process-exit protocol probe; not production or power-loss acceptance', root, results }))
