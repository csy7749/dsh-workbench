import { createElement as el, useEffect, useState } from 'react'
import { mountWorkflowDevelopment } from './development-panel'

const PREFIX = '/workbench-workflow-sandbox'
const KEY = 'workbench.workflow.development'

export function installWorkflowSandbox(ctx: any) {
  const send = async (message: unknown) => {
    const options = { method: 'POST', credentials: 'same-origin' as const, headers: { 'Content-Type': 'application/json', 'X-Workflow-Sandbox': '1' } }
    const request = async (path: string, body: unknown) => {
      const res = await fetch(`${PREFIX}${path}`, { ...options, body: JSON.stringify(body) })
      const value = await res.json()
      if (!res.ok) throw new Error(value.error ?? `HTTP ${res.status}`)
      return value
    }
    const { ticket } = await request('/ticket', { message })
    return (await request('/dispatch', { ticket, message })).result
  }
  const unmount = mountWorkflowDevelopment(ctx, send)
  function Entry(): ReturnType<typeof el> | null {
    const [available, setAvailable] = useState(false)
    useEffect(() => {
      let disposed = false
      void fetch(`${PREFIX}/health`, { credentials: 'same-origin', cache: 'no-store' })
        .then(async res => res.ok && (await res.json()).mode === 'temporary-fake')
        .then(ok => { if (!disposed) setAvailable(Boolean(ok)) })
        .catch(() => {})
      return () => { disposed = true }
    }, [])
    return available ? el('div', { style: { padding: '6px 12px', flex: 'none' } },
      el('button', { type: 'button', onClick: () => ctx.layout?.selectPanel(KEY), title: '独立临时数据与假执行器，不写入正式业务', style: { color: 'inherit', background: 'transparent', border: '1px solid var(--dsh-line)', borderRadius: 6, padding: '7px 10px', cursor: 'pointer' } }, '工作流操作沙盒')) : null
  }
  // Entry lives inside the existing workbench panel, not another plugin's DOM.
  return { Entry, dispose: unmount }
}
