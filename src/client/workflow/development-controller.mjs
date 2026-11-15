// M1 进程内开发适配；不注册 HTTP，不绕过真实宿主身份门。
export function createDevelopmentController({ service, kernel, principal, productId, executeNode, executePublish = null, capability = null }) {
  if (!service || !kernel || !principal || !productId) throw new Error('development_adapter_required')
  let sequence = 0
  const key = () => `dev:${Date.now()}:${++sequence}`
  const revisionKeys = new Map()
  const requestRevision = ({ retry = false, ...args }) => {
    const signature = JSON.stringify([args.runId, args.taskId, args.expectedBindingVersion, args.expectedTaskRevision, args.note, [...(args.retained ?? [])].sort()])
    if (retry || !revisionKeys.has(signature)) revisionKeys.set(signature, key().replaceAll(':', '-'))
    return service.requestRevision({ ...args, principal, idempotencyKey: revisionKeys.get(signature) })
  }
  const read = runId => {
    const detail = service.getRun({ principal, runId })
    const tasks = service.listHumanTasks({ principal, productId }).tasks.filter(task => task.run_id === runId)
    const adoptions = service.listAdoptions({ principal, runId }).adoptions
    const publications = kernel.query('SELECT o.id,o.adoption_id,o.target,o.relative_path,o.expected_hash,o.target_kind,o.status,o.required,o.reason,o.claim_generation FROM workflow_outbox o JOIN workflow_adoptions a ON a.id=o.adoption_id JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? ORDER BY o.rowid', runId)
    const scan = kernel.scanRecoverable()
    const recovery = { scannedAt: scan.scannedAt, items: scan.items.filter(item => item.runId === runId) }
    const contextPreflight = service.preflightContext({ principal, runId })
    const blockedValidations = []
    if (service.listEvents) {
      let cursor = 0
      let pages = 0
      let hasMore = true
      while (hasMore && pages < 100) {
        const eventPage = service.listEvents({ principal, runId, cursor, limit: 100 })
        blockedValidations.push(...eventPage.events.filter(event => ['human.validation.blocked', 'automatic.validation.blocked'].includes(event.type)))
        if (eventPage.hasMore && (!Number.isSafeInteger(eventPage.nextCursor) || eventPage.nextCursor <= cursor)) throw new Error("validation_event_cursor_invalid")
        if (!eventPage.hasMore && eventPage.nextCursor !== null) throw new Error("validation_event_cursor_invalid")
        cursor = eventPage.nextCursor ?? cursor
        hasMore = eventPage.hasMore
        pages++
      }
      if (hasMore) throw new Error("validation_event_history_page_limit")
    }
    return { ...detail, tasks, adoptions, publications, recovery, contextPreflight, blockedValidations, revisions: service.listRevisionRequests({ principal, runId }).requests, validations: service.listValidations({ principal, runId }).reports, definition: service.readDefinition({ principal, runId }) }
  }
  const textOutput = editable => [{ name: 'content', artifactType: 'text', schemaVersion: 1, editable, multiplicity: 'one' }]
  const collectionOutputs = [{ name: 'documents', artifactType: 'file-set', schemaVersion: 1, editable: true, multiplicity: 'many' }]
  const reviewOutputs = [{ ...collectionOutputs[0], name: 'reviewedDocuments' }]
  const start = ({ runId, human = true, collection = false, checked = false }) => service.startRun({ principal, productId, runId, idempotencyKey: key(), steps: collection ? [
    { nodeId: 'draft', nodeKind: 'automatic', executor: 'development-file-set', publishTargets: [], requiredChecks: [], outputs: collectionOutputs },
    { nodeId: 'review', nodeKind: 'human', publishTargets: ['draft.txt', 'notes.txt'].map(relativePath => ({ target: `development:${runId}:documents`, relativePath, required: true })), requiredChecks: checked ? ['set.file_bytes_hashed'] : [], outputs: reviewOutputs, inputMapping: [{ name: 'reviewedDocuments', from: 'documents' }] },
  ] : [
    { nodeId: 'draft', nodeKind: 'automatic', publishTargets: [], requiredChecks: [], outputs: textOutput(false) },
    ...(human ? [{ nodeId: 'review', nodeKind: 'human', publishTargets: [], requiredChecks: checked ? ['content.non_empty'] : [], outputs: textOutput(true) }] : []),
    { nodeId: 'final', nodeKind: 'automatic', publishTargets: [{ target: `development:${runId}:content`, required: true }], requiredChecks: [], outputs: textOutput(false),
      ...(capability ? { executor: 'tool-service', capability, effects: [] } : {}) },
  ] })
  const advance = async runId => {
    // 有界循环；每次读取持久状态，等待人工或暂停时立即返回。
    for (let count = 0; count < 100; count++) {
      const current = read(runId)
      if (!['created', 'running'].includes(current.run.status)) return current
      const open = current.steps.find(step => !['succeeded', 'cancelled'].includes(step.state))
      if (!open || open.state === 'running') return current
      const claim = kernel.claim(runId, kernel.definitionFor(runId).input)
      if (claim.kind === 'human') return read(runId)
      if (typeof executeNode !== 'function') {
        kernel.markFailed(claim.attemptId, 'development_executor_unavailable')
        return read(runId)
      }
      try { await executeNode(claim) } catch (error) {
        const attempt = kernel.one('SELECT status FROM workflow_attempts WHERE id=?', claim.attemptId)
        if (attempt?.status === 'running') kernel.markUnknown(claim.attemptId, 'development_executor_failed')
        throw error
      }
    }
    throw new Error('development_step_limit')
  }
  return {
    read, start, advance,
    events: (runId, cursor = 0) => service.listEvents({ principal, runId, cursor }),
    draft: (runId, taskId) => service.readHumanDraft({ principal, runId, taskId }),
    input: (runId, taskId) => service.readTaskInput({ principal, runId, taskId }),
    artifact: (runId, snapshotId) => service.readArtifact({ principal, runId, snapshotId }),
    command: (runId, command, expectedRevision) => service.commandRun({ principal, runId, command, expectedRevision, idempotencyKey: key() }),
    save: args => service.saveHumanDraft({ ...args, principal }),
    rebind: args => service.saveHumanDraft({ ...args, principal, rebind: true }),
    validate: args => service.validateHumanDraft({ ...args, principal }),
    requestRevision,
    applyRevision: args => service.applyRevisionCandidate({ ...args, principal }),
    saveFile: args => service.saveHumanDraftFile({ ...args, principal }),
    readFile: args => service.readHumanDraftFile({ ...args, principal }),
    confirm: args => service.confirmHumanTask({ ...args, principal, idempotencyKey: key() }),
    publish: ({ outboxId } = {}) => {
      if (typeof executePublish !== 'function') throw new Error('development_publisher_unavailable')
      return executePublish({ outboxId })
    },
    retryPublish: args => service.retryPublish({ ...args, principal }),
    declarePublishUnknown: args => service.declarePublishUnknown({ ...args, principal }),
    reconcilePublishEffect: args => service.reconcilePublishEffect({ ...args, principal }),
    rerun: args => service.rerunVersion({ ...args, principal }),
    restore: args => service.restoreVersion({ ...args, principal, idempotencyKey: key() }),
    fork: args => service.forkHistory({ ...args, principal, idempotencyKey: key() }),
    compare: args => service.compareVersions({ ...args, principal }),
  }
}
