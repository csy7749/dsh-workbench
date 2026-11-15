import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowKernel } from '../src/workflow/m1-kernel.mjs'
import { createFakeBusinessService } from '../src/workflow/m1-fake-service.mjs'
const root = mkdtempSync(join(tmpdir(), 'read-arguments-'))
const k = createWorkflowKernel(new DatabaseSync(join(root, 'db')), root)
try {
  const s = createFakeBusinessService({ kernel: k })
  s.registerPrincipal({ id: 'ui', kind: 'ui', productId: 'p' })
  s.registerPrincipal({ id: 'http', kind: 'http-client', credential: 'fixture-only' })
  // 无 productId 的主体：产品判定那一层不会替 run 解析兜底，因此唯一能暴露「run 行不存在」检查。
  s.registerPrincipal({ id: 'scheduler', kind: 'scheduler' })
  // scoped 主体：非法 runId 必须与「不在被授予范围」同码，不能退回 artifact_missing。
  s.registerPrincipal({ id: 'agent', kind: 'node-agent', runIds: ['run-1'] })
  k.createRun({ id: 'run-1' })
  const methods = ['getRun','listArtifacts','readArtifact','listEvents','listAdoptions','readAttemptInput','readTaskInput']
  const fingerprint = () => JSON.stringify(k.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%' ORDER BY name").map(({name}) => k.query(`SELECT * FROM ${name} ORDER BY rowid`)))
  const before = fingerprint()
  let checks = 0
  const rejects = (call, code, detail, label) => {
    assert.throws(call, e => e.code === code && e.detail === detail, label)
    checks++
  }
  // 1) 格式非法 runId：身份与凭据检查优先于对象解析。
  for (const method of methods) for (const runId of [undefined, null, '', 1, {}, []]) {
    for (const [principal, code, detail] of [['ui','artifact_missing','run_not_found'], ['ghost','capability_unavailable','unknown_principal'], ['http','capability_unavailable','credential_required']]) {
      rejects(() => s[method]({principal, runId}), code, detail, `${method}/${principal}/${typeof runId}`)
    }
  }
  // 2) 格式合法但不存在：ui 与 scheduler 都必须落到同一个隐藏码。
  //    ui 靠产品层兜底，scheduler 没有任何兜底层，缺行检查被移除时这里会抛裸异常或直接返回。
  for (const method of methods) for (const runId of ['run-missing', 'run-1:absent']) {
    rejects(() => s[method]({principal: 'ui', runId}), 'artifact_missing', 'run_not_found', `${method}/ui/missing:${runId}`)
    rejects(() => s[method]({principal: 'scheduler', runId}), 'artifact_missing', 'run_not_found', `${method}/scheduler/missing:${runId}`)
    rejects(() => s[method]({principal: 'http', runId, credential: 'fixture-only'}), 'artifact_missing', 'run_not_found', `${method}/http/missing:${runId}`)
  }
  // 3) scoped 主体：非法 runId 与「不存在但格式合法」都要与「不在授予范围」同码，不能泄露对象存在性。
  //    只有 runId 为 undefined/null 时会走到 run 解析，其余由授权前置直接拒绝——两条路径必须同码。
  for (const method of methods) for (const runId of [undefined, null, '', 'run-missing']) {
    rejects(() => s[method]({principal: 'agent', runId}), 'capability_unavailable', 'run_not_authorized', `${method}/agent/scoped:${String(runId)}`)
  }
  // 4) 正控：无 productId 主体与 scoped 主体在被授予的现存 run 上必须正常。
  assert.equal(s.getRun({principal: 'scheduler', runId: 'run-1'}).status, 'completed'); checks++
  assert.equal(s.listEvents({principal: 'scheduler', runId: 'run-1'}).status, 'completed'); checks++
  assert.equal(s.getRun({principal: 'agent', runId: 'run-1'}).status, 'completed'); checks++
  // 对象参数：先提供合法 run，避免 run 守卫掩盖对象解析异常。
  s.host.registerRunProduct('run-1', 'p')
  s.registerPrincipal({ id: 'object-ui', kind: 'ui', productId: 'p' })
  for (const id of [undefined, null, '', 7, {}, [], 'object-missing']) {
    for (const [method, field, code, detail] of [
      ['readAttemptInput', 'attemptId', 'artifact_missing', 'attempt_not_in_run'],
      ['readTaskInput', 'taskId', 'artifact_missing', 'task_not_in_run'],
      ['confirmHumanTask', 'taskId', 'human_confirm_required', 'human_task_not_found'],
    ]) {
      const args = { runId: 'run-1', [field]: id, content: 'fixture confirmation' }
      rejects(() => s[method]({...args, principal: 'object-ui'}), code, detail, `${method}/object/${String(id)}`)
      rejects(() => s[method]({...args, principal: 'ghost'}), 'capability_unavailable', 'unknown_principal', `${method}/ghost`)
      rejects(() => s[method]({...args, principal: 'http'}), 'capability_unavailable', method === 'confirmHumanTask' ? 'http-client_may_not_confirm.human' : 'credential_required', `${method}/credential`)
    }
  }
  assert.equal(fingerprint(), before)
  console.log(JSON.stringify({checks, passed:checks, scope:'temporary SQLite fake read argument boundaries'}))
} finally { k.db.close(); rmSync(root, {recursive:true, force:true}) }
