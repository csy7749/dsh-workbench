import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkflowKernel } from './m1-kernel.mjs'
import { createFakeBusinessService } from './m1-fake-service.mjs'
import { createDevelopmentController } from '../client/workflow/development-controller.mjs'
import { createDevelopmentDispatcher } from '../client/workflow/development-bridge.mjs'
import { createRecoveryMonitor } from './m1-recovery-monitor.mjs'
import { createCapturedContextProvider } from './m1-context-provider.mjs'
import { backupClosedDevelopmentSession } from './m1-development-backup.mjs'
import { fakeCapabilityContract } from './m1-fake-capability.mjs'
import { createDevelopmentTargetAdapter } from './m1-development-target.mjs'

/** 默认装配只创建系统临时目录；关闭后保留供重启/恢复，不自动删除数据。 */
export function createTemporaryDevelopmentSession(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-workflow-development-'))
  const dbPath = join(directory, 'workflow.sqlite')
  const root = join(directory, 'content')
  return { ...createDevelopmentSession({ ...options, dbPath, root }), directory, dbPath, root }
}

/** 开发宿主显式传入临时路径；不从生产环境配置推导路径、不监听端口。 */
export function createDevelopmentSession({ dbPath, root, productId = 'development-fixture', targetAdapter = null, context = null }) {
  if (!dbPath || !root) throw new Error('temporary_paths_required')
  const contextProvider = context === null ? null : createCapturedContextProvider({ ...context, root, productId })
  const kernel = openWorkflowKernel(dbPath, root)
  const service = createFakeBusinessService({ kernel, targetAdapter: targetAdapter ?? createDevelopmentTargetAdapter({ kernel }), contextProvider })
  const principal = 'development-ui'
  service.registerPrincipal({ id: principal, kind: 'ui', productId })
  service.registerPrincipal({ id: 'development-node', kind: 'node-agent', productId, runIds: [], attemptIds: [] })
  service.registerPrincipal({ id: 'development-publisher', kind: 'scheduler', productId })
  const controller = createDevelopmentController({
    kernel, service, principal, productId, capability: fakeCapabilityContract(),
    executePublish: ({ outboxId }) => service.host.publish({ principal: 'development-publisher', outboxId }),
    executeNode: async claim => {
      const attempt = kernel.one('SELECT step_id FROM workflow_attempts WHERE id=?', claim.attemptId)
      const step = kernel.one('SELECT run_id FROM workflow_steps WHERE id=?', attempt.step_id)
      service.registerPrincipal({ id: 'development-node', kind: 'node-agent', productId, runIds: [step.run_id], attemptIds: [claim.attemptId] })
      // 续租只覆盖此调用的生存期；失败先隔离，禁止把租约失败当成功继续推进。
      let heartbeatError = null
      const renew = () => service.heartbeat({ principal: 'development-node', attemptId: claim.attemptId, token: claim.token })
      renew()
      const timer = setInterval(() => {
        if (heartbeatError) return
        try { renew() } catch (error) {
          heartbeatError = error
          try {
            const current = kernel.one('SELECT status FROM workflow_attempts WHERE id=?', claim.attemptId)
            if (current?.status === 'running') kernel.markUnknown(claim.attemptId, 'development_heartbeat_failed')
          } catch { /* 保留首次续租错误，由控制器返回时再次隔离仍在运行的 Attempt。 */ }
        }
      }, 30000)
      timer.unref?.()
      try {
        const result = await service.host.runNode(claim.attemptId, { principal: 'development-node' })
        if (heartbeatError) throw heartbeatError
        return result
      } finally { clearInterval(timer) }
    },
  })
  const dispatcher = createDevelopmentDispatcher(controller)
  let recovery = { items: null, error: null, scannedAt: null }
  const monitor = createRecoveryMonitor({
    kernel,
    onScan: items => { recovery = { items, error: null, scannedAt: new Date().toISOString() } },
    onError: error => { recovery = { ...recovery, error: error?.message ?? String(error) } },
  })
  monitor.start()
  let disposed = false
  return {
    kernel, service, controller, dispatch: dispatcher.dispatch,
    readRecovery: () => JSON.parse(JSON.stringify(recovery)),
    backup: () => {
      if (!disposed) throw Object.assign(new Error('backup_session_must_be_closed'), { code: 'backup_session_must_be_closed' })
      return backupClosedDevelopmentSession({ dbPath, root })
    },
    dispose: () => {
      if (disposed) return
      dispatcher.dispose()
      monitor.dispose()
      kernel.db.close()
      disposed = true
    },
  }
}
