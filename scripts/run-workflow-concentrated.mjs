// Offline concentrated regression runner; individual scripts own temporary fixtures.
import { readdirSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.workflow-validation')
mkdirSync(output, { recursive: true })
const names = readdirSync(resolve(root, 'scripts')).filter(name => /^verify-workflow.*\.mjs$/.test(name)).sort()
const results = []
for (const name of names) {
  const log = resolve(output, name + '.log')
  const fd = openSync(log, 'w')
  const run = spawnSync(process.execPath, [resolve(root, 'scripts', name)], { cwd: root, stdio: ['ignore', fd, fd], timeout: 60000 })
  closeSync(fd)
  const result = { name, status: run.status, error: run.error?.message ?? null, log }
  results.push(result)
  console.log(`${run.status === 0 ? 'PASS' : 'FAIL'} ${name}`)
  if (run.status !== 0) console.log(readFileSync(log, 'utf8').slice(-2200))
}
writeFileSync(resolve(output, 'results.json'), JSON.stringify(results, null, 2))
console.log(`TOTAL ${results.length} PASS ${results.filter(item => item.status === 0).length} FAIL ${results.filter(item => item.status !== 0).length}`)
process.exitCode = results.some(item => item.status !== 0) ? 1 : 0
