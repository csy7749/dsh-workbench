export type ArtifactPreviewFormat = 'markdown' | 'json' | 'text'

interface ArtifactHints {
  nodeType?: string
  exportName?: string
  artifactKind?: string
  snapshotType?: string
}

/** Preview format describes the displayed body, not the kind of artifact it represents. */
export function artifactPreviewFormat(content: string, hints: ArtifactHints = {}): ArtifactPreviewFormat {
  if (hints.nodeType === 'check.rules') return 'json'
  if (hints.nodeType === 'input.brief' || /\.txt$/i.test(hints.exportName ?? '')) return 'text'
  // Some older runners stored JSON reports as Markdown. Only infer JSON for a complete object or array.
  const trimmed = content.trim()
  if (/^[\[{]/.test(trimmed)) {
    try { JSON.parse(trimmed); return 'json' } catch { /* use the remaining hints */ }
  }
  if (/\.json$/i.test(hints.exportName ?? '') || hints.artifactKind === 'json' || hints.snapshotType === 'json') return 'json'
  if (/\.(md|markdown)$/i.test(hints.exportName ?? '') || hints.artifactKind === 'markdown') return 'markdown'
  if (hints.snapshotType === 'markdown' || /^(?: {0,3}(?:#{1,6}\s|```|>|\|)|\s*(?:[-*+]\s|\d+\.\s))/m.test(content)) return 'markdown'
  return 'text'
}
