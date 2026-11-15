/**
 * B4-3：工作流只读页面（React 组件 + 侧栏入口）。
 *
 * 只有读取：探针 `/health`、列表 `/runs`、详情 `/runs/:id`，全部 GET。
 * 草稿提交、确认、暂停、继续这类写操作**一个都不接**——可信会话身份未验证（M0-B），
 * 所以这里既没有表单也没有按钮，连写请求的 URL 规划都不存在（见 readonly-core.mjs）。
 */
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  WORKFLOW_READONLY_PANEL_KEY,
  createReadonlySource,
  installWorkflowReadonly,
  loadReadonlyState,
  readonlyView,
} from './readonly-core.mjs'

/** readonly-core 是纯 .mjs（便于 node 直接验证），这里补一个本地视图类型。 */
interface ReadonlyViewState {
  exposed: boolean
  reason?: string | null
  runs?: { ok: boolean; runs: Array<{ id: string }>; recoverable: number }
  detail?: unknown
  error?: string | null
}

const ENTRY_ATTR = 'data-dsh-workflow-readonly-entry'
const ENTRY_CLASS = 'dsh-workflow-readonly-entry-clone'
const ENTRY_HANDLE = '__dshWorkflowReadonlyEntry'

interface ClientContext {
  slots: {
    inject(slot: string, contribute: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
    entries(slot: string): unknown[]
  }
  layout?: { selectPanel(panelId: string | null): void }
}

const CSS = `
.dsh-wf-ro{display:flex;flex-direction:column;height:100%;font-size:13px;color:var(--dsh-text-1,#e6e6e6);overflow:hidden}
.dsh-wf-ro-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsh-line,rgba(255,255,255,.12))}
.dsh-wf-ro-head h3{margin:0;font-size:14px;font-weight:600}
.dsh-wf-ro-badge{padding:1px 7px;border-radius:9px;background:rgba(120,200,255,.16);font-size:11px}
.dsh-wf-ro-body{display:flex;flex:1;min-height:0}
.dsh-wf-ro-list{width:290px;flex:none;overflow:auto;border-right:1px solid var(--dsh-line,rgba(255,255,255,.12))}
.dsh-wf-ro-detail{flex:1;min-width:0;overflow:auto;padding:12px 16px}
.dsh-wf-ro-row{display:block;width:100%;text-align:left;padding:9px 12px;border:0;border-bottom:1px solid rgba(255,255,255,.06);background:transparent;color:inherit;cursor:pointer}
.dsh-wf-ro-row[data-active="1"]{background:rgba(120,200,255,.12)}
.dsh-wf-ro-row small{display:block;opacity:.66;margin-top:2px}
.dsh-wf-ro-sec{margin:0 0 8px;font-size:12px;letter-spacing:.04em;opacity:.72}
.dsh-wf-ro-steps,.dsh-wf-ro-events{list-style:none;margin:0 0 16px;padding:0}
.dsh-wf-ro-steps li,.dsh-wf-ro-events li{display:flex;gap:10px;padding:4px 0;border-bottom:1px dotted rgba(255,255,255,.08)}
.dsh-wf-ro-steps li b,.dsh-wf-ro-events li b{font-weight:500}
.dsh-wf-ro-muted{opacity:.6}
.dsh-wf-ro-error{color:#ff8a8a}
.dsh-wf-ro-err{margin:10px 16px;padding:9px 12px;border-radius:7px;background:rgba(255,110,110,.12);color:#ffb3b3}
`

function ensureCss(): void {
  if (document.getElementById('dsh-workflow-readonly-css') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-workflow-readonly-css'
  style.textContent = CSS
  document.head.appendChild(style)
}

const el = createElement

function ReadonlyPage(props: { source: ReturnType<typeof createReadonlySource> }): ReactElement | null {
  const [state, setState] = useState<ReadonlyViewState>({ exposed: false })
  const [selected, setSelected] = useState<string | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async (runId?: string | null) => {
    // 整个刷新必须是「不抛」的：调用方是 void refresh(...)，一旦 reject
    // 就是未处理的异步异常，页面既没有提示也看不到真实故障。
    // loadReadonlyState 本身已保证不 reject，这里的 try/catch 是最后一道兜底。
    try {
      const next = await loadReadonlyState(props.source, { runId: runId ?? null })
      if (!mounted.current) return
      if (!next.exposed) {
        setState({ exposed: false, reason: next.reason })
        return
      }
      if (next.selected !== undefined) setSelected(next.selected)
      if (next.runs === null || next.runs === undefined) {
        setState({ exposed: true, error: next.reason ?? next.error ?? 'list_failed' })
        return
      }
      setState({ exposed: true, runs: next.runs, detail: next.detail })
    } catch (cause) {
      // 兜底：即使数据源被换掉或实现有 bug，也只落到「读取失败」，绝不静默。
      if (!mounted.current) return
      setState({ exposed: true, error: String((cause as { message?: string })?.message ?? cause) })
    }
  }, [props.source])

  useEffect(() => {
    mounted.current = true
    void refresh(null)
    return () => { mounted.current = false }
  }, [refresh])

  const view = readonlyView(state)
  // 未启用时渲染 null：旧界面完全不变。
  if (view === null) return null

  const pick = (runId: string): void => { void refresh(runId) }

  return el('div', { className: 'dsh-wf-ro', 'data-dsh-workflow-readonly': '' },
    el('div', { className: 'dsh-wf-ro-head' },
      el('h3', null, '工作流（只读）'),
      el('span', { className: 'dsh-wf-ro-badge' }, view.headline),
      el('button', { type: 'button', className: 'dsh-wf-ro-refresh', onClick: () => { void refresh(selected) } }, '刷新'),
    ),
    view.status === 'error' ? el('div', { className: 'dsh-wf-ro-err', 'data-dsh-workflow-readonly-error': '' },
      view.message ?? '读取失败',
      view.errors.length > 1 ? el('div', { className: 'dsh-wf-ro-muted' }, `共 ${view.errors.length} 项：${view.errors.map((item) => item.message).join('；')}`) : null,
    ) : null,
    el('div', { className: 'dsh-wf-ro-body' },
      el('div', { className: 'dsh-wf-ro-list' }, view.runs.length === 0
        ? el('div', { className: 'dsh-wf-ro-muted', style: { padding: '12px 16px' } },
            view.status === 'error' ? '运行列表读取失败' : '还没有工作流运行')
        : view.runs.map((run) => el('button', {
            type: 'button',
            key: run.id,
            className: 'dsh-wf-ro-row',
            'data-active': run.id === selected ? '1' : '0',
            onClick: () => pick(run.id),
          },
          el('b', null, run.statusLabel),
          el('small', null, `${run.id} · 预算 ${run.budget}`),
          run.pauseReasonLabel === null ? null : el('small', { className: 'dsh-wf-ro-error' }, run.pauseReasonLabel),
        ))),
      el('div', { className: 'dsh-wf-ro-detail' }, view.detail === null
        ? el('div', { className: 'dsh-wf-ro-muted' },
            view.status === 'error' ? '详情读取失败，无法展示步骤与历史' : '从左侧选择一个运行查看步骤与历史')
        : el('div', null,
            el('h4', { className: 'dsh-wf-ro-sec' }, `步骤（${view.detail.steps.length}）`),
            el('ul', { className: 'dsh-wf-ro-steps' }, view.detail.steps.map((step) => el('li', { key: step.id },
              el('span', { className: 'dsh-wf-ro-muted' }, `#${step.revision}`),
              el('b', null, step.nodeId),
              el('span', null, step.stateLabel),
              step.stale ? el('span', { className: 'dsh-wf-ro-error' }, '上游已变更') : null,
            ))),
            el('h4', { className: 'dsh-wf-ro-sec' }, `历史（最近 ${view.detail.history.length} 条）`),
            el('ul', { className: 'dsh-wf-ro-events' }, view.detail.history.map((event) => el('li', { key: `h${event.seq}` },
              el('span', { className: 'dsh-wf-ro-muted' }, `#${event.seq}`),
              el('b', null, event.type),
              el('span', { className: 'dsh-wf-ro-muted' }, event.at),
            ))),
            el('h4', { className: 'dsh-wf-ro-sec' }, `错误（${view.detail.errors.length}）`),
            view.detail.errors.length === 0
              ? el('div', { className: 'dsh-wf-ro-muted' }, '没有错误记录')
              : el('ul', { className: 'dsh-wf-ro-events' }, view.detail.errors.map((error) => el('li', { key: `e${error.seq ?? error.type}` },
                  el('span', { className: 'dsh-wf-ro-muted' }, error.seq === null ? '—' : `#${error.seq}`),
                  el('b', { className: 'dsh-wf-ro-error' }, error.code ?? error.type),
                  el('span', null, error.message),
                ))),
          )),
    ),
  )
}

interface SidebarController { dispose(): void }

function nativeButton(): HTMLButtonElement | undefined {
  for (const node of Array.from(document.querySelectorAll<HTMLButtonElement>('button[class*="newSession"]'))) {
    if (String(node.className).indexOf('newSessionLabel') === -1) return node
  }
  return undefined
}

/** 侧栏入口：只在只读后端确认启用后才调用，关闭时不产生任何 DOM。 */
function mountSidebarEntry(ctx: ClientContext): SidebarController {
  ensureCss()
  const previous = (window as unknown as Record<string, SidebarController | undefined>)[ENTRY_HANDLE]
  previous?.dispose()
  document.querySelectorAll(`[${ENTRY_ATTR}]`).forEach((node) => node.remove())

  let entry: HTMLButtonElement | null = null
  let disposed = false
  const place = (): void => {
    if (disposed) return
    const target = nativeButton()
    if (target === undefined || target.parentElement === null) return
    if (entry === null) {
      entry = target.cloneNode(true) as HTMLButtonElement
      entry.className = `${String(target.className)} ${ENTRY_CLASS}`
      entry.setAttribute(ENTRY_ATTR, '')
      entry.setAttribute('data-dsh-plugin', 'dsh-workbench')
      entry.setAttribute('data-dsh-part', 'workflow-readonly-entry')
      entry.setAttribute('aria-label', '工作流（只读）')
      entry.removeAttribute('id')
      entry.innerHTML = ''
      const icon = document.createElement('span')
      icon.className = 'dsh-workbench-entry-icon'
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h10"></path><path d="M4 18h7"></path></svg>'
      const label = document.createElement('span')
      label.className = 'dsh-workbench-entry-label'
      label.textContent = '工作流'
      entry.appendChild(icon)
      entry.appendChild(label)
      entry.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        try { ctx.layout?.selectPanel(WORKFLOW_READONLY_PANEL_KEY) } catch (cause) { console.warn('[dsh-workflow] 打开只读页失败：', String(cause)) }
      })
    }
    const anchor = document.querySelector('[data-dsh-workbench-entry], [data-dsh-plugin="dsh-cron"][data-dsh-part="sidebar-entry"]') ?? target
    if (entry.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', entry)
  }
  const observer = new MutationObserver(place)
  observer.observe(document.body, { childList: true, subtree: true })
  const timer = window.setInterval(place, 2000)
  place()

  const controller: SidebarController = {
    dispose(): void {
      disposed = true
      observer.disconnect()
      window.clearInterval(timer)
      entry?.remove()
      entry = null
    },
  }
  ;(window as unknown as Record<string, SidebarController | undefined>)[ENTRY_HANDLE] = controller
  return controller
}

/**
 * 注册只读面板并（在后端确认启用后）挂侧栏入口。
 * 面板本身在 `exposed:false` 时渲染 null，所以即使插槽被选中也不会出现空白页面。
 */
export function installWorkflowReadonlyPanel(ctx: ClientContext, options: { prefix?: string; fetchImpl?: typeof fetch } = {}): Promise<unknown> {
  const source = createReadonlySource({ prefix: options.prefix, fetchImpl: options.fetchImpl ?? ((...args) => fetch(...args)) })
  const Page = (): ReactElement | null => createElement(ReadonlyPage, { source })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: WORKFLOW_READONLY_PANEL_KEY,
    inject: () => ({}),
  }, Page))
  return installWorkflowReadonly({ source, registerEntry: () => mountSidebarEntry(ctx) })
}
