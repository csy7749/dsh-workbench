import { createInterface } from 'node:readline'
import { createDevelopmentApp } from '../src/workflow/m1-development-app.mjs'

// Offline same-process entry. Each input line is {method,args}; no HTTP or model.
let dispatch
const app = createDevelopmentApp({
  ctx: {},
  mountPanel(_ctx, send) { dispatch = send; return () => {} },
})
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
process.stdout.write(`${JSON.stringify({ developmentHost: app.inspect(), input: 'one JSON {method,args} per line; EOF closes the temporary session' })}\n`)
try {
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      const result = await dispatch(JSON.parse(line))
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? null, error: error.detail ?? error.message })}\n`)
    }
  }
} finally {
  app.dispose()
  process.stdout.write(`${JSON.stringify({ developmentHost: app.inspect() })}\n`)
}
