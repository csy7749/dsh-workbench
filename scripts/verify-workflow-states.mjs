import fs from 'node:fs'
import path from 'node:path'

const fixturePath = path.resolve('scripts/fixtures/workflow/state-runs.json')
const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
const runs = data.runs
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const ids = new Set()
for (const run of runs) {
  check(!ids.has(run.id), `duplicate run id: ${run.id}`)
  ids.add(run.id)
  check(run.productId === undefined || run.productId === data.productId, `cross-product run: ${run.id}`)
  check(Number.isInteger(run.revision) && run.revision >= 0, `invalid revision: ${run.id}`)
  check(['completed', 'waiting_review', 'paused'].includes(run.status), `invalid status: ${run.id}`)
  if (run.status === 'completed') {
    check(run.resume?.allowed === false && run.resume?.reason === 'terminal', `terminal run is resumable: ${run.id}`)
    check(run.steps.every(step => step.status === 'completed'), `terminal run has unfinished step: ${run.id}`)
  }
  if (run.status === 'waiting_review') {
    check(run.humanTask?.status === 'pending', `waiting run lacks pending HumanTask: ${run.id}`)
    check(run.humanTask?.noAutoConfirm === true, `waiting run allows auto-confirm: ${run.id}`)
    check(typeof run.humanTask?.inputFingerprint === 'string', `waiting run lacks input fingerprint: ${run.id}`)
    check(run.resume?.allowed === true, `waiting run cannot restore: ${run.id}`)
  }
  if (run.status === 'paused') {
    check(typeof run.pauseReason === 'string', `paused run lacks reason: ${run.id}`)
    check(run.resume?.allowed === false || run.resume?.allowed === true, `paused run lacks resume decision: ${run.id}`)
  }
  if (run.pauseReason === 'outcome_unknown') {
    check(run.effect?.status === 'outcome_unknown', `unknown result lacks effect ledger: ${run.id}`)
    check(run.resume?.allowed === false && run.resume?.action.includes('reconcile'), `unknown result retried without reconciliation: ${run.id}`)
  }
  if (run.pauseReason === 'publish_conflict') {
    check(run.conflict?.target && Number.isInteger(run.conflict.expectedRevision), `conflict lacks target baseline: ${run.id}`)
    check(run.resume?.action.includes('reconcile') || run.resume?.action.includes('rebase'), `conflict lacks rebase/reconcile action: ${run.id}`)
  }
}
check(runs.some(run => run.status === 'completed'), 'missing completed terminal sample')
check(runs.some(run => run.status === 'waiting_review'), 'missing human wait sample')
check(runs.some(run => run.pauseReason === 'outcome_unknown'), 'missing unknown-result sample')
check(runs.some(run => run.pauseReason === 'publish_conflict'), 'missing conflict sample')
if (failures.length) {
  console.error(JSON.stringify({ failures }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ checks: 4 + runs.length * 7, runs: runs.map(({ id, status, pauseReason }) => ({ id, status, ...(pauseReason ? { pauseReason } : {}) })), scope: data.scope }))
