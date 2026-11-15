import { createTemporaryDevelopmentSession, createDevelopmentSession } from './m1-development-session.mjs'
import { restoreDevelopmentBackup } from './m1-development-backup.mjs'

/** 仅供进程内假宿主显式装配；不注册网络路由，不接收浏览器路径或身份。 */
export function createDevelopmentHost(options = {}) {
  let session = null
  let location = null
  let state = 'empty'
  const requireState = expected => {
    if (state !== expected) throw new Error(`development_host_requires_${expected}`)
  }
  const inspect = () => ({ state, location: location ? { ...location } : null, executionEnabled: state === 'open' })
  return {
    inspect,
    create() {
      requireState('empty')
      const next = createTemporaryDevelopmentSession(options)
      session = next
      location = { directory: next.directory, dbPath: next.dbPath, root: next.root }
      state = 'open'
      return inspect()
    },
    dispatch(message) {
      requireState('open')
      return session.dispatch(message)
    },
    close() {
      if (state === 'closed') return inspect()
      requireState('open')
      // 活跃请求会由 session 拒绝关闭；失败时保留 open，不错误允许备份。
      session.dispose()
      state = 'closed'
      return inspect()
    },
    backup() {
      requireState('closed')
      return session.backup()
    },
    restore(directory) {
      requireState('empty')
      const restored = restoreDevelopmentBackup(directory)
      location = { directory: restored.directory, dbPath: restored.dbPath, root: restored.root }
      state = 'restored'
      return { ...inspect(), verified: restored.verified }
    },
    openRestored() {
      requireState('restored')
      // 恢复验证与开启会话分开；开启不 claim、不 resume、不执行节点。
      const next = createDevelopmentSession({ ...options, dbPath: location.dbPath, root: location.root, context: null })
      session = next
      state = 'open'
      return inspect()
    },
  }
}
