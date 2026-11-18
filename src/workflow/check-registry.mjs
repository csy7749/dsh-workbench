// Host composition registers pure domain evaluators; unknown checks remain unassessed.
export function createCheckEvaluator(entries) {
  const evaluators = new Map(Object.entries(entries))
  return (content, names) => names.filter(name => evaluators.has(name)).map(name => ({ name, ...evaluators.get(name)(content) }))
}
