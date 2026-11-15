import { captureContext, assembleContext } from './m1-context.mjs'

// 仅由受信开发装配捕获；页面不能覆盖目录授权或读取路径。
export function createCapturedContextProvider({ root, productId, projectId = null, allowedRoots, entries, budget = { totalTokens: 8000 } }) {
  const { root: ignored, ...spec } = captureContext({ root, productId, projectId, allowedRoots, entries, now: () => new Date().toISOString() })
  const capture = JSON.parse(JSON.stringify({ spec, budget }))
  return { snapshot: () => JSON.parse(JSON.stringify(capture)) }
}

// 重启/派生只读取定义中的捕获引用；内容根由宿主提供，不信持久记录里的路径。
export function assembleCapturedContext({ root, capture, runId, attemptId, nodeId, binding }) {
  return assembleContext({
    spec: { ...capture.spec, root }, runId, attemptId, nodeId, budget: capture.budget,
    upstream: (binding.inputs ?? []).map(item => ({ key: item.key ?? item.stepId ?? item.snapshotId, revision: item.revision ?? item.adoptionId ?? null, snapshotId: item.snapshotId })),
    adapterVersion: 'development-fake/1',
  })
}
