import assert from 'node:assert/strict'
import { createTemporaryDevelopmentSession } from '../src/workflow/m1-development-session.mjs'
const session = createTemporaryDevelopmentSession()
const c = session.controller
try {
  for (const collection of [false, true]) {
    const runId = collection ? 'development-collection' : 'development-text'
    c.start({ runId, collection, checked: true })
    let view = await c.advance(runId)
    assert.equal(view.run.status, 'waiting_review')
    let task = view.tasks.find(item => item.status === 'open')
    const initial = c.draft(runId, task.id)
    const content = initial.currentInput.content
    if (collection) {
      const set = JSON.parse(content)
      assert.equal(set.outputs.length, 2)
      assert.ok(set.outputs.every(item => item.name === 'reviewedDocuments'))
    }
    c.save({ runId, taskId: task.id, content, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision })
    view = c.read(runId)
    task = view.tasks.find(item => item.status === 'open')
    const saved = c.draft(runId, task.id)
    const report = c.validate({ runId, taskId: task.id, content: saved.draft.content, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision })
    assert.equal(report.status, 'pass')
    c.confirm({ runId, taskId: task.id, content: saved.draft.content, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision, expectedRunRevision: view.run.revision, validationReportId: report.id, intent: 'continue' })
    view = await c.advance(runId)
    for (const item of view.publications.filter(item => item.status === 'pending')) c.publish({ outboxId: item.id })
    view = c.read(runId)
    assert.equal(view.run.status, 'completed')
    assert.equal(view.publications.length, collection ? 2 : 1)
    assert.ok(view.publications.every(item => item.status === 'succeeded'))
    console.log(`PASS ${runId} review validation adoption publication`)
  }
} finally { session.dispose() }
const backup = session.backup()
assert.ok(backup)
console.log('PASS closed-session backup')
