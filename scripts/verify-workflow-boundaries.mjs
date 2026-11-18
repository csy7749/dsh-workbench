import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { registerPack, PACKS, NODE_DEFS, PRODUCT_LINES, templateOf, planOf } from '../src/shared/workflow-catalog.ts'
import { samplePack } from '../src/packs/sample-line/index.ts'
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
const core = [...files('src/shared').filter(path => /workflow-(?!catalog).*\.ts$/.test(path)), ...files('src/workflow').filter(path => /\.(mjs|ts)$/.test(path)), ...files('src/host').filter(path => /workflow-.*\.(mjs|ts)$/.test(path)), ...files('src/client/workflow').filter(path => /\.(tsx|ts)$/.test(path))]
const hashes = () => core.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'))
for (const path of core) assert(!/\b(game|novel|drama)\b|游戏|小说|短剧/i.test(readFileSync(path, 'utf8')), 'domain vocabulary in ' + path)
for (const path of files('src/packs').filter(path => /\.(ts|mjs)$/.test(path))) {
  const text = readFileSync(path, 'utf8')
  assert(!/from\s*['"][^'"]*(?:\/host\/|\/client\/|\/workflow\/|node:|sqlite)/.test(text), 'forbidden dependency: ' + path)
  assert(!/\b(?:fetch|require)\s*\(/.test(text), 'unexpected IO: ' + path)
}
for (const node of NODE_DEFS) assert.equal(PACKS.filter(pack => pack.nodeDefs.includes(node)).length, 1, node.id)
const before = hashes()
const initial = NODE_DEFS.length
const unregister = registerPack(samplePack)
assert(PRODUCT_LINES.some(line => line.id === 'sample'))
assert.equal(NODE_DEFS.length, initial + 1)
assert.equal(planOf(templateOf('sample-outline')).steps.length, 3)
assert.deepEqual(hashes(), before)
unregister()
unregister()
assert.equal(NODE_DEFS.length, initial)
assert(!PRODUCT_LINES.some(line => line.id === 'sample'))
assert.deepEqual(hashes(), before)
console.log(`PASS boundaries: ${core.length} core files, pure packs, unique ownership, sample register/unregister without file changes`)
