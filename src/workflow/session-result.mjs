/** A completed response must belong to the exact dispatched prompt, not merely a recent turn. */
export function sessionText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const text = blocks.filter(block => typeof block === 'string' || block?.type === 'text')
    .map(block => typeof block === 'string' ? block : block.text ?? '').join(String.fromCharCode(10)).trim()
  return text || (typeof message?.text === 'string' ? message.text.trim() : '')
}

export function readGenerationResult(events, { prompt, afterSeq = 0 }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('generation_prompt_required')
  const ordered = events.filter(event => Number.isSafeInteger(event?.seq) && event.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq)
  let started = false
  let content = ''
  let messageSeq = null
  for (const event of ordered) {
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      const message = data.message ?? data
      const source = message?.source ?? data.source
      // DSH emits these host snapshots as user/message alongside the dispatched prompt.
      if (['runtime-context', 'skill-catalog', 'time-context'].includes(source?.kind)) continue
      if (started) return { status: 'failed', reason: 'generation_interleaved_turn' }
      if (sessionText(message) === prompt.trim()) started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const text = sessionText(data.message)
      if (text) { content = text; messageSeq = event.seq }
    }
    if (event.type === 'turn/end') {
      const reason = typeof data.reason === 'string' ? data.reason : data.reason?.kind ?? data.reason?.type ?? data.reason?.reason
      if (reason !== 'completed') return { status: 'failed', reason: String(reason ?? 'unknown_turn_end'), endSeq: event.seq }
      if (!content) return { status: 'failed', reason: 'generation_empty_result', endSeq: event.seq }
      return { status: 'completed', content, messageSeq, endSeq: event.seq }
    }
  }
  return { status: 'pending' }
}
