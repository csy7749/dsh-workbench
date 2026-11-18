// Resolve document identities from frozen graph edges, never from editable draft fields.
export function gameReviewSources(compiled, nodeId) {
  const ancestors = new Set()
  const visit = id => {
    for (const up of compiled.find(item => item.nodeId === id)?.upstream ?? []) {
      if (ancestors.has(up)) continue
      ancestors.add(up)
      visit(up)
    }
  }
  visit(nodeId)
  const source = type => compiled.filter(item => ancestors.has(item.nodeId) && item.type === type).at(-1)?.nodeId
  return { brief: source('input.brief'), gdd: source('game.gdd'), rules: source('game.rules'), report: source('check.rules') }
}
