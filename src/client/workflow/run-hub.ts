import { isActiveRun, runCounts, WORKFLOW_STATUS, type WorkflowRunSummary } from '../../shared/workflow-run-summary.ts'
import type { RunMonitorSnapshot } from './run-monitor.ts'

export type RunHubFilter = 'active' | 'attention' | 'history'
const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const stamp = (value: string): string => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '未知时间'

export function runSummaryRow(run: WorkflowRunSummary): string {
  const status = run.status === 'paused' && run.pauseReason !== 'user_paused' ? '异常暂停' : WORKFLOW_STATUS[run.status] ?? run.status
  return `<article class="wf-hub-row">
    <div class="wf-hub-name"><b>${esc(run.graphName)}</b><span>${esc(run.projectName)} / ${esc(run.productName)}</span><small title="${esc(run.runId)}">运行 ${esc(run.runId)} · 来源：画布工作流</small></div>
    <div class="wf-hub-state"><span class="wf-hub-badge" data-tone="${run.needsAttention ? 'attention' : run.status === 'running' ? 'running' : 'neutral'}">${esc(status)}</span><span>${esc(run.currentNodeTitle ?? (run.status === 'completed' ? '执行结束' : '暂无执行节点'))}</span>${run.pauseReason || run.autoReason ? `<small>${esc(run.pauseReason || run.autoReason)}</small>` : ''}</div>
    <div class="wf-hub-progress"><span>已完成 ${run.completedSteps} / ${run.totalSteps} 步${run.skippedSteps ? ` · 跳过 ${run.skippedSteps}` : ''}</span><progress max="${Math.max(1, run.totalSteps)}" value="${run.completedSteps}" aria-label="已完成 ${run.completedSteps} / ${run.totalSteps} 步"></progress><small>更新于 <time datetime="${esc(run.updatedAt)}">${esc(stamp(run.updatedAt))}</time></small></div>
    <button class="btn" data-wf-open="${esc(run.runId)}">${run.status === 'waiting_review' ? '去处理' : run.needsAttention ? '查看原因' : '查看运行'}</button>
  </article>`
}

export function renderRunHub(state: RunMonitorSnapshot, options: { compact?: boolean; filter?: RunHubFilter; project?: string } = {}): string {
  const counts = runCounts(state.runs)
  const compact = options.compact === true
  const scoped = options.project ? state.runs.filter(run => run.workspacePath.toLowerCase() === options.project!.toLowerCase()) : state.runs
  const filter = options.filter ?? 'active'
  let rows = compact ? state.runs.filter(run => isActiveRun(run) || run.needsAttention)
    : scoped.filter(run => filter === 'attention' ? run.needsAttention : filter === 'history' ? !isActiveRun(run) : isActiveRun(run) || run.needsAttention)
  if (compact && rows.length === 0) rows = state.runs.slice(0, 3)
  if (compact) rows = rows.slice(0, 3)
  return `<section class="wf-hub${compact ? ' wf-hub-compact' : ''}" aria-label="${compact ? '工作流动态' : '工作流运行'}">
    <div class="wf-hub-heading"><div><h2>${compact ? '工作流动态' : '运行概览'}</h2><span>全部项目 · ${counts.running} 运行中 · ${counts.attention} 待处理${compact ? '' : ' · 当前仅接入画布工作流'}</span></div><div class="wf-hub-actions">${compact ? '<button class="btn" data-wf-hub>查看全部</button>' : '<button class="btn" data-wf-templates>工作流模板</button>'}<button class="btn" data-wf-refresh ${state.loading ? 'disabled' : ''}>${state.loading ? '更新中…' : '刷新'}</button></div></div>
    ${state.error ? `<p class="wf-hub-error" role="status">${esc(state.error)}${state.loaded ? '；以下保留上次读取结果。' : ''}</p>` : ''}
    ${!compact ? `<div class="wf-hub-filters" role="group" aria-label="运行筛选">${([['active', '运行中 / 待处理'], ['attention', '需要处理'], ['history', '近期历史']] as const).map(([key, label]) => `<button class="btn${filter === key ? ' primary' : ''}" data-wf-filter="${key}" aria-pressed="${filter === key}">${label}</button>`).join('')}<label><input type="checkbox" data-wf-current ${options.project ? 'checked' : ''}>仅当前项目</label></div>` : ''}
    <div class="wf-hub-rows">${rows.map(runSummaryRow).join('') || `<p class="wf-hub-empty">${!state.loaded ? state.error ? '运行状态尚未读取成功，可重试。' : '正在读取工作流状态…' : filter === 'attention' ? '当前没有需要处理的运行。' : options.project ? '当前项目没有符合筛选的运行。' : '暂无运行，可从具体产品的流程中启动。'}</p>`}</div>
    ${!compact ? '<p class="wf-hub-foot">保留最近 20 条完成 / 取消记录；失败运行保留在待处理中。产品设计、UI 及测试的独立派发将在后续阶段接入。</p>' : ''}
  </section>`
}

export const RUN_HUB_CSS = `
.wf-hub{margin:0 0 24px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);overflow:hidden}
.wf-hub-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.wf-hub-heading h2{font-size:16px;margin:0 0 4px}.wf-hub-heading span,.wf-hub-foot{font-size:12px;color:var(--text-2)}
.wf-hub-actions,.wf-hub-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.wf-hub-filters{padding:12px 20px;border-bottom:1px solid var(--line)}
.wf-hub-filters label{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px}.wf-hub-filters .primary{background:var(--accent-soft);color:var(--accent-ink)}
.wf-hub-row{display:grid;grid-template-columns:minmax(160px,1.2fr) minmax(140px,1fr) minmax(170px,1fr) auto;align-items:center;gap:18px;padding:16px 20px;border-bottom:1px solid var(--line)}
.wf-hub-row:last-child{border-bottom:0}.wf-hub-name,.wf-hub-state,.wf-hub-progress{display:flex;flex-direction:column;gap:5px;min-width:0;overflow-wrap:anywhere}
.wf-hub-name b{font-size:13px}.wf-hub-name span,.wf-hub-state>span:not(.wf-hub-badge),.wf-hub-progress>span{font-size:12px;color:var(--text-2)}
.wf-hub small{font-size:11px;color:var(--text-3)}.wf-hub-badge{align-self:flex-start;border:1px solid var(--line);border-radius:5px;padding:2px 7px;font-size:11px}
.wf-hub-badge[data-tone=attention]{color:var(--amber);background:var(--amber-soft)}.wf-hub-badge[data-tone=running]{color:var(--accent-ink);background:var(--accent-soft)}
.wf-hub-progress progress{width:100%;height:6px;border:0;accent-color:var(--accent)}
.wf-hub-progress progress::-webkit-progress-bar{background:var(--panel-3);border-radius:4px}.wf-hub-progress progress::-webkit-progress-value{background:var(--accent);border-radius:4px}
.wf-hub-error{padding:10px 20px;margin:0;background:var(--amber-soft);color:var(--amber);font-size:12px}
.wf-hub-empty{padding:22px 20px;margin:0;color:var(--text-2)}.wf-hub-foot{margin:0;padding:12px 20px;border-top:1px solid var(--line)}
@media(max-width:1000px){.wf-hub-row{grid-template-columns:minmax(140px,1fr) minmax(140px,1fr)}.wf-hub-row>.btn{justify-self:start}.wf-hub-filters label{margin-left:0}}
@media(max-width:600px){.wf-hub-row{grid-template-columns:1fr}.wf-hub-heading{padding:14px}.wf-hub-row{padding:14px}}
`
