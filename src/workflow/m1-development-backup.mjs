import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { readCaptured } from './m1-context.mjs'
import { verifyJobStore } from './m1-job-store.mjs'
import { verifyValidationStore } from './m1-validation-store.mjs'
import { createRevisionStore, verifyRevisionStore } from './m1-revision-store.mjs'
import { verifyOutputSet } from './m1-output-set-store.mjs'

const require = createRequire(import.meta.url)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => Object.assign(new Error(code), { code })
const safeAttempt = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_')
const digest = value => hash(JSON.stringify(value))

// Only offline development sessions: callers must close every writer first.
// Refuse leftover WAL rather than silently copying an incomplete main database.
function assertOffline(dbPath) {
  if (!lstatSync(dbPath).isFile() || lstatSync(dbPath).isSymbolicLink()) throw fail('backup_database_invalid')
  if (existsSync(`${dbPath}-wal`) && lstatSync(`${dbPath}-wal`).size !== 0) throw fail('backup_database_not_checkpointed')
}

function filesUnder(root, prefix = '') {
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw fail('backup_content_root_invalid')
  const result = []
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name)
    const entry = lstatSync(path)
    if (entry.isSymbolicLink()) throw fail('backup_link_not_allowed')
    const key = prefix ? `${prefix}/${name}` : name
    if (entry.isDirectory()) result.push(...filesUnder(path, key))
    else if (entry.isFile()) result.push(key)
    else throw fail('backup_file_type_invalid')
  }
  return result
}

function checkedPath(root, key) {
  if (typeof key !== 'string' || !key || key.includes('\\') || key.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw fail('backup_path_invalid')
  const path = resolve(root, key)
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw fail('backup_path_invalid')
  // Check every component so even an in-root symlink is not accepted.
  let current = root
  for (const part of key.split('/')) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw fail('backup_link_not_allowed')
  }
  return path
}

/** Read-only DB and content verification; never starts the kernel or scheduler. */
export function verifyDevelopmentCopy({ dbPath, root }) {
  assertOffline(dbPath)
  const { DatabaseSync } = require('node:sqlite')
  // SQLite may create WAL/SHM even for a read-only connection. Inspect a
  // disposable copy so repeated verification never changes the signed backup.
  const inspection = mkdtempSync(join(tmpdir(), 'dsh-workflow-inspect-'))
  let db
  try {
    const inspectionDb = join(inspection, 'workflow.sqlite')
    copyFileSync(dbPath, inspectionDb)
    db = new DatabaseSync(inspectionDb, { readOnly: true })
    const integrity = db.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw fail('backup_database_corrupt')
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw fail('backup_reference_invalid')
    const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    const snapshots = db.prepare('SELECT * FROM workflow_snapshots').all()
    for (const row of snapshots) {
      if (!/^[a-f0-9]{64}$/.test(row.content_hash)) throw fail('backup_snapshot_hash_invalid')
      const manifest = JSON.parse(readFileSync(checkedPath(root, `manifests/${safeAttempt(row.source_attempt_id)}.json`), 'utf8'))
      const bytes = readFileSync(checkedPath(root, `objects/${row.content_hash.slice(0, 2)}/${row.content_hash}`))
      if (digest(manifest) !== row.manifest_hash || manifest.snapshotId !== row.id || manifest.snapshotId !== `${row.source_attempt_id}:snapshot` || manifest.artifactType !== row.artifact_type || manifest.contentHash !== row.content_hash || hash(bytes) !== row.content_hash || bytes.length !== manifest.bytes) throw fail('backup_snapshot_invalid')
      if (manifest.sourceAttemptId !== undefined || manifest.inputSnapshotIds !== undefined || manifest.blobs !== undefined || manifest.outputSet !== undefined) {
        const binding = db.prepare('SELECT * FROM workflow_input_bindings WHERE owner_id=? ORDER BY version DESC LIMIT 1').get(row.source_attempt_id)
        if (!binding) throw fail('backup_snapshot_provenance_invalid')
        const inputs = JSON.parse(binding.binding_json)
        if (!Array.isArray(inputs)) throw fail('backup_snapshot_provenance_invalid')
        const mediaType = row.artifact_type === 'json' ? 'application/json' : row.artifact_type === 'markdown' ? 'text/markdown' : 'text/plain'
        let blobs = [{ relativePath: `objects/${row.content_hash.slice(0, 2)}/${row.content_hash}`, hash: row.content_hash, bytes: bytes.length, mediaType }]
        if (manifest.outputSet) {
          const source = db.prepare('SELECT s.node_id,d.definition_json,d.integrity_hash FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id JOIN workflow_run_definitions d ON d.run_id=s.run_id WHERE a.id=?').get(row.source_attempt_id)
          if (!source) throw fail('backup_definition_unavailable')
          const definition = JSON.parse(source.definition_json)
          if (digest(definition) !== source.integrity_hash) throw fail('backup_definition_invalid')
          const declarations = definition.steps.find(node => node.nodeId === source.node_id)?.outputs
          if (!declarations) throw fail('backup_output_declaration_missing')
          const verified = verifyOutputSet({ root, set: manifest.outputSet, declarations })
          if (manifest.artifactType !== 'file-set' || manifest.outputSetDigest !== verified.digest || bytes.toString('utf8') !== JSON.stringify(verified.set)) throw fail('backup_output_set_invalid')
          const byHash = new Map()
          for (const file of verified.set.files) {
            if (!byHash.has(file.hash)) byHash.set(file.hash, { relativePath: `objects/${file.hash.slice(0, 2)}/${file.hash}`, hash: file.hash, bytes: file.bytes, mediaType: file.mediaType })
          }
          blobs = [...byHash.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        }
        if (manifest.sourceAttemptId !== row.source_attempt_id || JSON.stringify(manifest.inputSnapshotIds) !== JSON.stringify(inputs.map(input => input.snapshotId)) || JSON.stringify(manifest.blobs) !== JSON.stringify(blobs)) throw fail('backup_snapshot_provenance_invalid')
      }
    }
    // Several historical tables have logical references without SQL foreign keys.
    const brokenReferences = [
      'SELECT p.id FROM workflow_snapshots p LEFT JOIN workflow_attempts a ON a.id=p.source_attempt_id LEFT JOIN workflow_steps s ON s.id=a.step_id WHERE a.id IS NULL OR s.id IS NULL',
      'SELECT a.id FROM workflow_adoptions a LEFT JOIN workflow_steps s ON s.id=a.step_id LEFT JOIN workflow_snapshots p ON p.id=a.snapshot_id WHERE s.id IS NULL OR p.id IS NULL',
      'SELECT s.id FROM workflow_steps s LEFT JOIN workflow_adoptions a ON a.id=s.current_adoption_id WHERE s.current_adoption_id IS NOT NULL AND (a.id IS NULL OR a.step_id<>s.id)',
      'SELECT p.id FROM workflow_snapshots p LEFT JOIN workflow_snapshots parent ON parent.id=p.parent_id WHERE p.parent_id IS NOT NULL AND parent.id IS NULL',
      'SELECT a.id FROM workflow_adoptions a LEFT JOIN workflow_adoptions previous ON previous.id=a.previous_id WHERE a.previous_id IS NOT NULL AND (previous.id IS NULL OR previous.step_id<>a.step_id)',
      'SELECT t.id FROM workflow_human_tasks t LEFT JOIN workflow_steps s ON s.id=t.step_id LEFT JOIN workflow_drafts d ON d.id=t.draft_id WHERE s.id IS NULL OR (t.draft_id IS NOT NULL AND d.id IS NULL)',
      'SELECT o.id FROM workflow_outbox o LEFT JOIN workflow_adoptions a ON a.id=o.adoption_id WHERE a.id IS NULL',
      `SELECT o.target FROM workflow_publish_owners o LEFT JOIN workflow_outbox b ON b.id=o.outbox_id WHERE b.id IS NULL OR o.target<>(b.target || CASE WHEN b.relative_path IS NOT NULL THEN '::' || b.relative_path ELSE '' END)`,
    ]
    for (const sql of brokenReferences) if (db.prepare(sql).get()) throw fail('backup_reference_invalid')
    const bindings = db.prepare('SELECT * FROM workflow_input_bindings').all()
    for (const binding of bindings) {
      const inputs = JSON.parse(binding.binding_json)
      const ownerId = binding.owner_id
      if (!Array.isArray(inputs) || inputs.length > 1 || digest({ ownerId, version: binding.version, inputs }) !== binding.integrity_hash) throw fail('backup_binding_invalid')
      const owner = db.prepare('SELECT step_id FROM workflow_attempts WHERE id=?').get(ownerId) ?? db.prepare('SELECT step_id FROM workflow_human_tasks WHERE id=?').get(ownerId)
      if (!owner) throw fail('backup_binding_invalid')
      for (const input of inputs) {
        const source = db.prepare('SELECT a.snapshot_id,p.content_hash FROM workflow_adoptions a JOIN workflow_steps s ON s.id=a.step_id JOIN workflow_snapshots p ON p.id=a.snapshot_id JOIN workflow_steps target ON target.id=? WHERE a.id=? AND s.id=? AND s.run_id=target.run_id AND s.rowid<target.rowid').get(owner.step_id, input.adoptionId, input.stepId)
        if (!source || source.snapshot_id !== input.snapshotId || source.content_hash !== input.contentHash) throw fail('backup_binding_invalid')
      }
    }
    if (db.prepare('SELECT r.id FROM workflow_runs r LEFT JOIN workflow_run_definitions d ON d.run_id=r.id WHERE d.run_id IS NULL').get()) throw fail('backup_definition_unavailable')
    const definitions = db.prepare('SELECT * FROM workflow_run_definitions').all()
    for (const row of definitions) {
      const definition = JSON.parse(row.definition_json)
      if (digest(definition) !== row.integrity_hash) throw fail('backup_definition_invalid')
      for (const entry of definition.contextCapture?.spec?.entries ?? []) {
        const contextHash = typeof entry.capturedBlobRef === 'string' ? entry.capturedBlobRef.slice('context:'.length) : ''
        if (!/^[a-f0-9]{64}$/.test(contextHash)) throw fail('backup_context_invalid')
        checkedPath(root, `context/${contextHash.slice(0, 2)}/${contextHash}`)
        const captured = readCaptured({ root, blobRef: entry.capturedBlobRef })
        if (captured.hash !== entry.capturedHash || captured.bytes.length !== entry.capturedBytes) throw fail('backup_context_invalid')
      }
    }
    // Drafts are not snapshots: validate their frozen input and referenced objects too.
    for (const draft of db.prepare('SELECT * FROM workflow_drafts').all()) {
      const owner = db.prepare(`SELECT b.binding_json,s.node_id,d.definition_json FROM workflow_input_bindings b
        JOIN workflow_human_tasks t ON t.id=b.owner_id JOIN workflow_steps s ON s.id=t.step_id
        JOIN workflow_run_definitions d ON d.run_id=s.run_id
        WHERE b.owner_id || ':input:' || b.version = ?`).get(draft.snapshot_id)
      if (!owner) throw fail('backup_draft_binding_invalid')
      const inputs = JSON.parse(owner.binding_json)
      if (inputs.length !== 1) continue
      const source = db.prepare('SELECT source_attempt_id FROM workflow_snapshots WHERE id=?').get(inputs[0].snapshotId)
      if (!source) throw fail('backup_draft_binding_invalid')
      const manifest = JSON.parse(readFileSync(checkedPath(root, `manifests/${safeAttempt(source.source_attempt_id)}.json`), 'utf8'))
      if (!manifest.outputSet) continue
      const declarations = JSON.parse(owner.definition_json).steps.find(node => node.nodeId === owner.node_id)?.outputs
      if (!declarations) throw fail('backup_output_declaration_missing')
      let set
      try { set = JSON.parse(draft.content) } catch { throw fail('backup_draft_set_invalid') }
      verifyOutputSet({ root, set, declarations })
    }
    const outboxColumns = new Set(db.prepare('PRAGMA table_info(workflow_outbox)').all().map(column => column.name))
    if (!outboxColumns.has('relative_path')) throw fail('backup_outbox_mapping_invalid')
    for (const outbox of db.prepare('SELECT target,target_kind,relative_path,expected_hash FROM workflow_outbox').all()) {
      if (outbox.relative_path !== null && (outbox.target_kind !== 'file_hash' || !/^[a-f0-9]{64}$/.test(outbox.expected_hash ?? ''))) throw fail('backup_outbox_mapping_invalid')
      if (outbox.relative_path === null && outbox.target_kind === 'file_hash') throw fail('backup_outbox_mapping_invalid')
    }
    const jobs = verifyJobStore(db)
    const validations = verifyValidationStore(db)
    const revisions = verifyRevisionStore({ kernel: { db } })
    for (const request of createRevisionStore({ kernel: { db } }).list()) {
      if (request.candidate?.artifactType !== 'file-set') continue
      const owner = db.prepare('SELECT d.definition_json,s.node_id FROM workflow_steps s JOIN workflow_run_definitions d ON d.run_id=s.run_id WHERE s.id=?').get(request.stepId)
      const declarations = JSON.parse(owner.definition_json).steps.find(node => node.nodeId === owner.node_id)?.outputs
      if (!declarations) throw fail('backup_output_declaration_missing')
      verifyOutputSet({ root, set: JSON.parse(request.candidate.content), declarations })
    }
    return { schema, snapshots: snapshots.length, definitions: definitions.length, drafts: db.prepare('SELECT count(*) AS n FROM workflow_drafts').get().n, jobs, validations, revisions }
  } finally {
    try { db?.close() } finally { rmSync(inspection, { recursive: true, force: true }) }
  }
}

/** Must only be called after dispose; exports captured files, not external source files. */
export function backupClosedDevelopmentSession({ dbPath, root }) {
  assertOffline(dbPath)
  const source = verifyDevelopmentCopy({ dbPath, root })
  const directory = mkdtempSync(join(tmpdir(), 'dsh-workflow-backup-'))
  const content = join(directory, 'content')
  mkdirSync(content)
  copyFileSync(dbPath, join(directory, 'workflow.sqlite'))
  for (const key of filesUnder(root)) {
    const target = join(content, key)
    mkdirSync(resolve(target, '..'), { recursive: true })
    copyFileSync(checkedPath(root, key), target)
  }
  const entries = filesUnder(directory).map(path => {
    const bytes = readFileSync(checkedPath(directory, path))
    return { path, bytes: bytes.length, sha256: hash(bytes) }
  })
  const manifest = { format: 'workflow-development-backup/1', implementation: 'm1-development/1', createdAt: new Date().toISOString(), scope: 'closed-temporary-session-and-captured-content-only', source, entries }
  writeFileSync(join(directory, 'backup.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  verifyDevelopmentBackup(directory)
  return { directory, manifest }
}

export function verifyDevelopmentBackup(directory) {
  if (lstatSync(directory).isSymbolicLink()) throw fail('backup_link_not_allowed')
  const manifest = JSON.parse(readFileSync(checkedPath(directory, 'backup.json'), 'utf8'))
  if (manifest.format !== 'workflow-development-backup/1' || !Array.isArray(manifest.entries)) throw fail('backup_format_invalid')
  const keys = manifest.entries.map(entry => entry.path)
  if (new Set(keys).size !== keys.length || !keys.includes('workflow.sqlite') || keys.some(key => key !== 'workflow.sqlite' && !key.startsWith('content/'))) throw fail('backup_manifest_invalid')
  const actual = filesUnder(directory).filter(key => key !== 'backup.json').sort()
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) throw fail('backup_file_set_mismatch')
  for (const entry of manifest.entries) {
    const bytes = readFileSync(checkedPath(directory, entry.path))
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw fail('backup_file_hash_mismatch')
  }
  const verified = verifyDevelopmentCopy({ dbPath: join(directory, 'workflow.sqlite'), root: join(directory, 'content') })
  if (JSON.stringify(verified) !== JSON.stringify(manifest.source)) throw fail('backup_inventory_mismatch')
  return manifest
}

/** Restore into a fresh directory only. Return paths; execution remains off. */
export function restoreDevelopmentBackup(directory) {
  // Validate the caller's path before canonicalizing; realpath hides a root link.
  const manifest = verifyDevelopmentBackup(directory)
  directory = realpathSync(directory)
  const restored = mkdtempSync(join(tmpdir(), 'dsh-workflow-restored-'))
  mkdirSync(join(restored, 'content'))
  for (const entry of manifest.entries) {
    const target = join(restored, entry.path)
    mkdirSync(resolve(target, '..'), { recursive: true })
    copyFileSync(checkedPath(directory, entry.path), target)
    const bytes = readFileSync(target)
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw fail('backup_restore_hash_mismatch')
  }
  const dbPath = join(restored, 'workflow.sqlite')
  const root = join(restored, 'content')
  const verified = verifyDevelopmentCopy({ dbPath, root })
  return { directory: restored, dbPath, root, verified, executionEnabled: false }
}
