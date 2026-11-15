// Pure structural checks for the W0-08 run samples (human / auto). No host, no DB, no network.
// Verifies fixture integrity and protocol invariants only; this is not workflow acceptance.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = name => JSON.parse(readFileSync(new URL(`./fixtures/workflow/${name}`, import.meta.url), 'utf8'))
const base = read('product-design.json')
const runs = read('human-runs.json')

const namespaces = new Set(['md', 'pd', 'fd', 'ui', 'td', 'audit'])
const ns = key => String(key).split(':')[0]

let checks = 0
function check(value, message) { assert.ok(value, message); checks++ }

const product = base.products.find(p => p.id === runs.productId)
check(product !== undefined, `unknown product: ${runs.productId}`)
check(product.id === base.products[0].id, 'run samples use the primary fixture product')

const docKeys = new Set(product.documents.map(d => d.docKey))
for (const key of runs.inputDocKeys) check(docKeys.has(key), `input docKey not in product fixture: ${key}`)
check(runs.inputDocKeys.length === docKeys.size, 'input doc set covers every fixture document')

const ids = new Set()
const snapshots = new Set()
for (const run of runs.runs) {
  for (const entity of [run, ...run.steps, ...run.adoptions]) {
    check(typeof entity.id === 'string' && entity.id.length > 0, `missing id in ${run.id}`)
    check(!ids.has(entity.id), `duplicate id: ${entity.id}`)
    ids.add(entity.id)
  }
  for (const adoption of run.adoptions) snapshots.add(adoption.snapshotId)
  for (const step of run.steps) if (step.humanTask) snapshots.add(step.humanTask.id)
}
for (const adoption of runs.runs.flatMap(r => r.adoptions)) {
  if (adoption.parentSnapshotId !== undefined) {
    check(snapshots.has(adoption.parentSnapshotId), `dangling parentSnapshotId: ${adoption.id}`)
    check(adoption.parentSnapshotId !== adoption.snapshotId, `human output reuses upstream identity: ${adoption.id}`)
  }
}

for (const run of runs.runs) {
  check(run.productId === runs.productId, `cross-product run: ${run.id}`)

  // Linear order and upstream-only consumption.
  const orders = run.steps.map(s => s.order)
  check(orders.every((o, i) => o === i + 1), `non-contiguous step order in ${run.id}`)
  const available = new Set(runs.inputDocKeys)
  for (const step of run.steps) {
    for (const key of step.consumes) check(available.has(key), `${step.id} consumes unpublished key: ${key}`)
    for (const key of step.produces) {
      check(namespaces.has(ns(key)), `unknown namespace in ${step.id}: ${key}`)
      available.add(key)
    }
  }

  // Publish targets stay inside what the run produced, and revisions chain per docKey.
  const byKey = new Map()
  for (const adoption of run.adoptions) {
    for (const target of adoption.publishTargets) {
      check(namespaces.has(ns(target.docKey)), `unknown namespace in ${run.id}: ${target.docKey}`)
      check(available.has(target.docKey), `${adoption.id} publishes unproduced key: ${target.docKey}`)
      check(target.resultRevision > target.expectedRevision, `revision must advance: ${adoption.id}`)
      if (!byKey.has(target.docKey)) byKey.set(target.docKey, [])
      byKey.get(target.docKey).push({ adoption, target })
    }
  }
  for (const [key, chain] of byKey) {
    chain.sort((a, b) => a.target.expectedRevision - b.target.expectedRevision)
    check(chain[0].target.expectedRevision === 0, `first publish of ${key} must create revision 0`)
    for (let i = 1; i < chain.length; i++) {
      check(chain[i].target.expectedRevision === chain[i - 1].target.resultRevision,
        `revision gap on ${key}: expected ${chain[i - 1].target.resultRevision}, got ${chain[i].target.expectedRevision}`)
    }
  }
}

const [human, auto] = [runs.runs.find(r => r.steps.some(s => s.kind === 'human')), runs.runs.find(r => !r.steps.some(s => s.kind === 'human'))]
check(human !== undefined && auto !== undefined, 'both a human path and an auto path are sampled')
check(human.steps.filter(s => s.kind === 'human').length === 1, 'human path declares exactly one human node')

const humanStep = human.steps.find(s => s.kind === 'human')
check(humanStep.nodeType === 'human.edit-confirm', 'human node uses the frozen node type')
const task = humanStep.humanTask
for (const field of ['id', 'runId', 'nodeId', 'inputSetId', 'inputFingerprint', 'expectedRunRevision']) {
  check(task[field] !== undefined && task[field] !== '', `human task missing ${field}`)
}
check(task.runId === human.id && task.nodeId === humanStep.id, 'human task binding points at its own run/node')
check(task.noAutoConfirm === true, 'human wait has no auto-confirm')
check(task.waitingState === 'waiting_review', 'human wait uses waiting_review')
check(human.expectedStates.atHumanNode === 'waiting_review' && human.expectedStates.terminal === 'succeeded', 'human path states declared')
check(human.recovery.autoConfirmTimeoutMs === null, 'no auto-confirm timeout')
check(human.recovery.rebaseOnUpstreamReplacement === 'requires-explicit-action', 'upstream replacement needs explicit rebase')
check(human.recovery.restartRestores.includes(task.id), 'restart restores the same human task')

const humanAdoptions = human.adoptions.filter(a => a.actorType === 'human')
check(humanAdoptions.length === 1, 'human path records exactly one human adoption')
const humanAdoption = humanAdoptions[0]
check(humanAdoption.stepId === humanStep.id, 'human adoption belongs to the human step')
check(humanAdoption.parentSnapshotId !== undefined, 'human adoption records its parent snapshot')
check(humanAdoption.sameContentAsParent === true, 'unchanged confirm still gets its own identity')
const humanTarget = humanAdoption.publishTargets[0]
check(humanTarget.expectedRevision > 0, 'human edit publishes a new revision of the same docKey, not a new key')
check(human.adoptions.filter(a => a.stepId === humanStep.id).length === 1, 'human step has no second publisher')

check(auto.steps.every(s => s.kind !== 'human'), 'auto path has no human step')
check(auto.steps.every(s => s.humanTask === undefined), 'auto path creates no human task')
check(auto.adoptions.every(a => a.actorType === 'system'), 'auto path adopts only as system')
check(auto.noEmptyHumanTask === true, 'auto path declares no empty human task')
check(auto.expectedStates.atHumanNode === null && auto.expectedStates.terminal === 'succeeded', 'auto path states declared')
check(auto.steps.every(s => typeof s.machineCheck === 'string' && s.machineCheck.length > 0), 'auto steps declare machine checks')

const audit = 'audit:fixture-product-alpha'
const productKey = 'pd:fixture-product-alpha'
check(audit !== productKey && ns(audit) === 'audit', 'report keeps its own identity')
for (const run of runs.runs) {
  const published = new Set(run.adoptions.flatMap(a => a.publishTargets.map(t => t.docKey)))
  check(published.has(audit) && published.has(productKey) && published.has('md:fixture-module-books'),
    `${run.id} publishes the full doc set`)
}

console.log(JSON.stringify({
  checks,
  runs: runs.runs.map(r => ({ id: r.id, steps: r.steps.length, adoptions: r.adoptions.length })),
  scope: 'run-sample structure and protocol invariants only; not workflow acceptance',
}))
