// 显式注入的进程内传输协议；不监听窗口消息或网络，不接受客户端身份字段。
export const DEVELOPMENT_METHODS = Object.freeze([
  'read', 'start', 'advance', 'draft', 'input', 'artifact', 'command',
  'save', 'rebind', 'validate', 'saveFile', 'readFile', 'confirm', 'rerun', 'restore', 'fork', 'compare', 'events',
  'declarePublishUnknown', 'reconcilePublishEffect', 'publish', 'retryPublish', 'requestRevision', 'applyRevision',
])

export function createDevelopmentDispatcher(controller) {
  let closed = false
  let active = false
  return {
    async dispatch(message) {
      if (closed) throw new Error('development_bridge_closed')
      if (!message || !DEVELOPMENT_METHODS.includes(message.method) || !Array.isArray(message.args)) throw new Error('development_message_invalid')
      if (active) throw new Error('development_operation_in_progress')
      const args = JSON.parse(JSON.stringify(message.args))
      // 身份只由开发 session 提供，桥接请求没有覆盖身份的途径。
      active = true
      try {
        const result = await controller[message.method](...args)
        return JSON.parse(JSON.stringify(result ?? null))
      } finally { active = false }
    },
    dispose() { if (active) throw new Error('development_operation_in_progress'); closed = true },
  }
}

export function createDevelopmentBridge(send) {
  if (typeof send !== 'function') throw new Error('development_transport_required')
  return Object.fromEntries(DEVELOPMENT_METHODS.map(method => [method, (...args) => send({ method, args })]))
}
