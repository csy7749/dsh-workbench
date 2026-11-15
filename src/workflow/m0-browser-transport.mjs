import { randomUUID, createHash } from 'node:crypto'
import { createDevelopmentHost } from './m1-development-host.mjs'

export const BROWSER_WORKFLOW_PREFIX = '/workbench-workflow-sandbox'

/** Temporary fake-executor workspace only. Browser admission is not a claim of
 * unforgeable human presence; this transport must never select production data. */
export function mountBrowserWorkflow({ connection, register, onDispose, hostFactory = createDevelopmentHost }) {
  let host = null
  let active = false
  let closed = false
  const tickets = new Map()
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const admit = req => {
    if (!connection || typeof connection.admit !== 'function' || !connection.browserPeer) throw new Error('browser_admission_unavailable')
    if (typeof connection.requestRejection === 'function' && connection.requestRejection(req) !== undefined) throw new Error('browser_session_required')
    const admission = connection.admit(req)
    if (!admission || admission.peer !== connection.browserPeer) throw new Error('browser_session_required')
    return admission.peer
  }
  const readBody = async req => {
    // IncomingMessage is bounded before parsing, regardless of Content-Length.
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > 1024 * 1024) throw new Error('request_too_large')
      chunks.push(bytes)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  const route = { kind: 'prefix', path: BROWSER_WORKFLOW_PREFIX, handler(req, res) {
    void (async () => {
      try {
        if (closed) return send(res, 503, { error: 'sandbox_closed' })
        const origin = req.headers?.origin
        if (origin) {
          const parsed = new URL(origin)
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.headers?.host) return send(res, 403, { error: 'origin_rejected' })
        }
        const peer = admit(req)
        const path = new URL(req.url, 'http://dsh.internal').pathname.slice(BROWSER_WORKFLOW_PREFIX.length)
        if (req.method === 'GET' && path === '/health') return send(res, 200, { enabled: true, mode: 'temporary-fake', humanIdentityVerified: false })
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' })
        // CSRF defense is additional to admission, never a substitute for it.
        if (String(req.headers?.['x-workflow-sandbox'] ?? '') !== '1' || !String(req.headers?.['content-type'] ?? '').startsWith('application/json')) return send(res, 403, { error: 'sandbox_header_required' })
        if (path === '/ticket') {
          const now = Date.now()
          for (const [key, value] of tickets) if (value.expires <= now) tickets.delete(key)
          if (tickets.size >= 64) return send(res, 429, { error: 'ticket_limit' })
          const request = await readBody(req)
          if (!request.message || !Array.isArray(request.message.args)) throw new Error('development_message_invalid')
          const digest = createHash('sha256').update(JSON.stringify(request.message)).digest('hex')
          const ticket = randomUUID()
          tickets.set(ticket, { peer, digest, expires: now + 30000 })
          return send(res, 200, { ticket })
        }
        if (path !== '/dispatch') return send(res, 404, { error: 'not_found' })
        const body = await readBody(req)
        const ticket = tickets.get(body.ticket)
        tickets.delete(body.ticket)
        if (!ticket || ticket.peer !== peer || ticket.expires <= Date.now() || ticket.digest !== createHash('sha256').update(JSON.stringify(body.message)).digest('hex')) return send(res, 403, { error: 'ticket_invalid' })
        if (active) return send(res, 409, { error: 'sandbox_busy' })
        active = true
        try {
          if (!host) { const next = hostFactory(); next.create(); host = next }
          const result = await host.dispatch(body.message)
          return send(res, 200, { result })
        } finally { active = false }
      } catch (error) {
        const message = String(error?.message ?? error)
        send(res, /admission_unavailable/.test(message) ? 503 : /browser_session_required/.test(message) ? 403 : 400, { error: message })
      }
    })()
  } }
  const unregister = register(route)
  const dispose = () => {
    if (active) throw new Error('sandbox_busy')
    host?.close()
    closed = true
    tickets.clear()
    if (typeof unregister === 'function') unregister()
  }
  onDispose?.(dispose)
  return { dispose }
}
