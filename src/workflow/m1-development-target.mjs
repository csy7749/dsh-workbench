import { fileBytesDigest } from './m1-output-set.mjs'

// Offline target owned by one development session; never writes official artifacts.
export function createDevelopmentTargetAdapter({ kernel }) {
  kernel.db.exec('CREATE TABLE IF NOT EXISTS workflow_development_targets (target_key TEXT PRIMARY KEY, data BLOB NOT NULL, revision INTEGER NOT NULL)')
  const values = {
    get: key => {
      const row = kernel.one('SELECT data,revision FROM workflow_development_targets WHERE target_key=?', key)
      return row ? { data: Buffer.from(row.data), revision: row.revision } : null
    },
    set: (key, value) => kernel.db.prepare('INSERT INTO workflow_development_targets VALUES(?,?,?) ON CONFLICT(target_key) DO UPDATE SET data=excluded.data,revision=excluded.revision').run(key, value.data, value.revision),
  }
  const identify = (target, relativePath) => {
    if (typeof target !== 'string' || !target.startsWith('development:')) throw new Error('development_target_required')
    return JSON.stringify([target, relativePath ?? null])
  }
  const read = (target, relativePath = null) => {
    const value = values.get(identify(target, relativePath)) ?? { data: Buffer.alloc(0), revision: 0 }
    return relativePath === null
      ? { kind: 'raw_text', content: value.data.toString('utf8'), revision: value.revision }
      : { kind: 'file_hash', data: Buffer.from(value.data), relativePath, revision: value.revision }
  }
  return {
    kindOf(target) { identify(target, null); return 'raw_text' },
    read,
    write(target, content, options = {}) {
      const relativePath = options.relativePath ?? null
      const key = identify(target, relativePath)
      const prior = values.get(key) ?? { data: Buffer.alloc(0), revision: 0 }
      if (options.expectedHash !== fileBytesDigest(prior.data) || (options.expectedRevision != null && options.expectedRevision !== prior.revision)) return { status: 'conflict' }
      const data = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8')
      values.set(key, { data, revision: prior.revision + 1 })
      return { status: 'succeeded' }
    },
  }
}
