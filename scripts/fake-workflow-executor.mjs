export const FAKE_OUTCOMES = Object.freeze(['success', 'failure', 'delayed', 'duplicate', 'unknown'])

export function createFakeExecutor({ kernel, outcomes = {} } = {}) {
  if (!kernel) throw new TypeError('kernel is required')
  return {
    async execute({ runId, input = { fixture: true }, content = 'fake output' }) {
      const claim = kernel.claim(runId, input)
      if (claim.kind === 'human') return claim
      const outcome = outcomes[runId] ?? 'success'
      if (!FAKE_OUTCOMES.includes(outcome)) throw new Error(`unknown_fake_outcome:${outcome}`)
      if (outcome === 'delayed' || outcome === 'unknown') {
        kernel.markUnknown(claim.attemptId, 'outcome_unknown')
        return { ...claim, outcome: 'outcome_unknown' }
      }
      if (outcome === 'failure') {
        kernel.markFailed(claim.attemptId, 'fake_failure')
        return { ...claim, outcome: 'failed' }
      }
      const candidate = kernel.storeCandidate({ attemptId: claim.attemptId, token: claim.token, content })
      const adopted = kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate })
      if (outcome === 'duplicate') {
        try { kernel.adopt({ attemptId: claim.attemptId, token: claim.token, candidate }) } catch { return { ...claim, ...adopted, duplicateIgnored: true } }
      }
      return { ...claim, ...adopted, outcome: 'succeeded' }
    },
  }
}
