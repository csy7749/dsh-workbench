// Pure fixture checks plus in-memory SQLite capability probe; no host or production DB.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/workflow/product-design.json', import.meta.url), 'utf8'))
const ids = new Set()
const docKeys = new Set()
let checks = 0
function check(value, message) { assert.ok(value, message); checks++ }
for (const product of fixture.products) {
  const entities = [product, ...product.maps, ...product.maps.flatMap(m => m.nodes), ...product.documents]
  for (const entity of entities) {
    check(typeof entity.id === 'string' && !ids.has(entity.id), `duplicate or missing id: ${entity.id}`)
    ids.add(entity.id)
  }
  for (const doc of product.documents) {
    check(typeof doc.title === 'string' && doc.title.length > 0, `missing title: ${doc.id}`)
    check(typeof doc.docKey === 'string' && !docKeys.has(doc.docKey), `missing or duplicate docKey: ${doc.id}`)
    docKeys.add(doc.docKey)
    const map = product.maps.find(m => m.id === doc.mapId)
    check(!!map, `cross-product map: ${doc.id}`)
    if (doc.moduleId) check(map.nodes.some(n => n.id === doc.moduleId), `wrong module: ${doc.id}`)
  }
}
const alpha = fixture.products[0]
check(fixture.products.length >= 2 && alpha.maps.length >= 2, 'multi-product/map coverage')
check(alpha.maps.flatMap(m => m.nodes).filter(n => n.kind === 'module').length >= 2, 'module coverage')
const audit = alpha.documents.find(d => d.kind === 'audit_report')
const productDoc = alpha.documents.find(d => d.kind === 'product_design')
check(audit && productDoc && audit.id !== productDoc.id && audit.docKey !== productDoc.docKey, 'separate report identity')
check(fixture.products.every(p => p.workspace === alpha.workspace), 'same-workspace isolation fixture')
check(audit.docKey.startsWith(fixture.storageMapping.audit_report.requiredExplicitDocKeyPrefix), 'explicit report namespace')
// Characterize the unsafe legacy derivation; this is not a test of the actual publisher.
const implicitKey = doc => doc.moduleId ? `md:${doc.moduleId}` : `pd:${alpha.id}`
check(implicitKey(audit) === implicitKey(productDoc), 'legacy implicit report key would collide')
const db = new DatabaseSync(':memory:')
try {
  const version = db.prepare('select sqlite_version() as version').get().version
  db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, revision INTEGER NOT NULL); INSERT INTO probe VALUES (\'draft\', 1)')
  db.exec('BEGIN; UPDATE probe SET revision=2; ROLLBACK')
  check(db.prepare('SELECT revision FROM probe').get().revision === 1, 'rollback support')
  check(db.prepare('UPDATE probe SET revision=2 WHERE id=? AND revision=?').run('draft', 1).changes === 1, 'first CAS')
  check(db.prepare('UPDATE probe SET revision=3 WHERE id=? AND revision=?').run('draft', 1).changes === 0, 'stale CAS')
  console.log(JSON.stringify({ checks, sqlite: version, scope: 'fixture integrity and in-memory SQLite only; not workflow acceptance' }))
} finally { db.close() }
