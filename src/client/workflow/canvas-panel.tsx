/**
 * 工作流画布 · DSH 面板（节点式，可拖拽可连线可配置）
 *
 * 和前一批的「操作沙盒」是两回事：那个是内核状态机的工程夹具（假执行器 + 临时库），
 * 这个是产品形态本身——左侧节点库按产品线（游戏/小说/短剧）给节点，中间画布拖拽连线，
 * 右侧配置参数，底部能校验拓扑并生成执行预演。数据存在工作台库的 wf_graphs 表。
 *
 * 面板自己带 shadow root，样式与工作台主体隔离，颜色全部走 DSH 主题变量。
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  CATEGORIES, PRODUCT_LINES, TEMPLATES, defById, emptyGraph, lineOf, summarizeIssues,
  TYPE_LABEL, canConnect, planOf, validateGraph,
  type CanvasNode, type ConfigField, type GraphIssue, type NodeDef, type Plan,
  type ProductLineId, type WorkflowGraph,
} from '../../shared/workflow-canvas-model.js'

const validateGraphOf = validateGraph
const planOfGraph = planOf
const canConnectOf = canConnect

function TYPE_HINT(def: NodeDef): string {
  const first = def.outputs[0]
  return first === undefined ? '终点' : TYPE_LABEL[first.type]
}

export const WORKFLOW_CANVAS_PANEL_KEY = 'workbench.workflow.canvas'
const API = '/workbench-api/workflow'
const NODE_W = 196
const PORT_TOP = 44
const PORT_GAP = 22
const MIN_SCALE = 0.3
const MAX_SCALE = 2.2

interface ClientContext {
  slots: {
    inject(slot: string, contribute: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  layout?: { selectPanel(panelId: string | null): void }
}

const h = createElement

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

interface Catalog {
  lines: typeof PRODUCT_LINES
  categories: typeof CATEGORIES
  defs: NodeDef[]
  typeColor: Record<string, string>
  typeLabel: Record<string, string>
  templates: { id: string; name: string; line: ProductLineId; summary: string; steps: number }[]
}

interface GraphRow { id: string; name: string; line: string; revision: number; updated_at: string; nodes: number; edges: number }

interface RunStep { nodeId: string; title: string; type: string; kind: 'human' | 'agent' | 'static'; state: string; stale: boolean; content: string }
interface RunWaiting { kind: string; nodeId: string | null; title: string; taskId: string | null; content: string }
interface RunView { runId: string; status: string; steps: RunStep[]; waiting: RunWaiting | null }

const RUN_STATUS: Record<string, string> = {
  created: '已创建', running: '运行中', waiting_review: '等人工确认', paused: '已暂停',
  completed: '已完成', failed: '失败', cancelled: '已取消',
}


interface ApiResult<T> { ok: boolean; error?: string; data?: T }

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(API + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const text = await response.text()
    let body: any = {}
    try { body = text.trim() === '' ? {} : JSON.parse(text) } catch { body = {} }
    if (!response.ok || body.ok === false) return { ok: false, error: String(body.error ?? body.message ?? ('HTTP ' + response.status)) }
    return { ok: true, data: body as T }
  } catch (cause) {
    return { ok: false, error: String((cause as { message?: string })?.message ?? cause) }
  }
}

/* ------------------------------------------------------------------ *
 * 几何
 * ------------------------------------------------------------------ */

interface Point { x: number; y: number }

function nodeHeight(def: NodeDef): number {
  return PORT_TOP + Math.max(def.inputs.length, def.outputs.length) * PORT_GAP + 12
}

function portPoint(node: CanvasNode, def: NodeDef, portId: string, dir: 'in' | 'out'): Point {
  const index = dir === 'out'
    ? Math.max(0, def.outputs.findIndex(port => port.id === portId))
    : Math.max(0, def.inputs.findIndex(port => port.id === portId))
  return { x: node.x + (dir === 'out' ? NODE_W : 0), y: node.y + PORT_TOP + index * PORT_GAP }
}

function curve(a: Point, b: Point): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.45)
  return 'M' + a.x + ',' + a.y + ' C' + (a.x + dx) + ',' + a.y + ' ' + (b.x - dx) + ',' + b.y + ' ' + b.x + ',' + b.y
}

const CSS = `
:host{display:block;height:100%;min-height:0}
.wf{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsh-text-1,#e6e6e6);background:var(--dsh-bg,#14161a)}
.wf-top{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsh-line,rgba(255,255,255,.1));flex:none;flex-wrap:wrap}
.wf-title{font-weight:600;font-size:13px}
.wf-sp{flex:1}
.wf-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsh-line,rgba(255,255,255,.14));background:var(--dsh-panel,rgba(255,255,255,.04));color:inherit;font-size:12px}
.wf-btn:hover{background:rgba(255,255,255,.1)}
.wf-btn[data-primary="1"]{background:rgba(96,165,250,.18);border-color:rgba(96,165,250,.5)}
.wf-btn[data-on="1"]{background:rgba(96,165,250,.22);border-color:rgba(96,165,250,.55)}
.wf-btn[disabled]{opacity:.45;cursor:not-allowed}
.wf-line{display:inline-flex;gap:4px;padding:2px;border-radius:7px;background:rgba(255,255,255,.05)}
.wf-line button{border:0;background:transparent;color:inherit;font-size:12px;padding:4px 10px;border-radius:5px;cursor:pointer}
.wf-line button[data-on="1"]{background:rgba(255,255,255,.14);font-weight:600}
.wf-main{display:flex;flex:1;min-height:0}
.wf-lib{width:236px;flex:none;display:flex;flex-direction:column;border-right:1px solid var(--dsh-line,rgba(255,255,255,.1));min-height:0}
.wf-lib-head{padding:8px 10px;font-size:11px;opacity:.6;letter-spacing:.05em;border-bottom:1px solid rgba(255,255,255,.06)}
.wf-lib-body{flex:1;overflow:auto;padding:6px 8px 14px}
.wf-cat{margin:8px 0 3px;font-size:11px;opacity:.62;display:flex;align-items:center;gap:6px}
.wf-cat i{width:7px;height:7px;border-radius:2px;display:inline-block}
.wf-item{display:block;width:100%;text-align:left;padding:5px 8px;margin:2px 0;border-radius:5px;border:1px solid transparent;
  background:rgba(255,255,255,.03);color:inherit;font-size:12px;cursor:grab}
.wf-item:hover{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.08)}
.wf-item small{display:block;opacity:.5;font-size:10.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-tpl{border:1px dashed rgba(255,255,255,.18);border-radius:6px;padding:6px 8px;margin:5px 0;cursor:pointer;font-size:11.5px}
.wf-tpl:hover{background:rgba(255,255,255,.06)}
.wf-tpl b{display:block;font-size:12px;font-weight:600;margin-bottom:2px}
.wf-tpl span{opacity:.6}
.wf-canvas{position:relative;flex:1;min-width:0;overflow:hidden;cursor:grab;
  background-image:radial-gradient(circle,rgba(255,255,255,.09) 1px,transparent 1px);background-size:22px 22px}
.wf-canvas[data-panning="1"]{cursor:grabbing}
.wf-world{position:absolute;left:0;top:0;transform-origin:0 0;width:0;height:0}
.wf-node{position:absolute;width:196px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:var(--dsh-panel,#1b1e24);
  box-shadow:0 6px 18px rgba(0,0,0,.35);user-select:none}
.wf-node[data-sel="1"]{border-color:#60a5fa;box-shadow:0 0 0 1px rgba(96,165,250,.5),0 8px 22px rgba(0,0,0,.45)}
.wf-node[data-bad="1"]{border-color:rgba(248,113,113,.75)}
.wf-node-head{display:flex;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid rgba(255,255,255,.08);cursor:move;border-radius:8px 8px 0 0}
.wf-node-head b{font-size:12px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-node-head em{font-style:normal;font-size:10px;opacity:.55}
.wf-dot{width:7px;height:7px;border-radius:50%;flex:none}
.wf-ports{position:relative;padding:3px 0 6px}
.wf-port{display:flex;align-items:center;height:22px;font-size:10.5px;opacity:.85}
.wf-port[data-dir="in"]{padding-left:12px}
.wf-port[data-dir="out"]{justify-content:flex-end;padding-right:12px}
.wf-pin{position:absolute;width:11px;height:11px;border-radius:50%;background:#0f1115;border:2px solid #94a3b8;cursor:crosshair;z-index:2}
.wf-pin[data-dir="in"]{left:-6px}
.wf-pin[data-dir="out"]{right:-6px}
.wf-pin:hover{transform:scale(1.25)}
.wf-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.wf-edges path{fill:none;stroke-width:2;pointer-events:stroke;cursor:pointer}
.wf-edges path[data-preview="1"]{stroke-dasharray:5 4;stroke:#93c5fd}
.wf-side{width:288px;flex:none;display:flex;flex-direction:column;border-left:1px solid var(--dsh-line,rgba(255,255,255,.1));min-height:0}
.wf-side-body{flex:1;overflow:auto;padding:10px 12px 20px}
.wf-side h4{margin:0 0 8px;font-size:12px;font-weight:600}
.wf-side .wf-sub{font-size:11px;opacity:.55;margin:-4px 0 10px;line-height:1.5}
.wf-field{margin:0 0 10px}
.wf-field label{display:block;font-size:11px;opacity:.72;margin-bottom:3px}
.wf-field input[type="text"],.wf-field textarea,.wf-field select,.wf-field input[type="number"]{
  width:100%;box-sizing:border-box;padding:5px 7px;border-radius:5px;font-size:12px;
  background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.14);color:inherit;font-family:inherit}
.wf-field textarea{min-height:64px;resize:vertical;line-height:1.5}
.wf-field input[type="range"]{width:100%}
.wf-hint{font-size:10.5px;opacity:.5;margin-top:3px;line-height:1.45}
.wf-check{display:flex;align-items:center;gap:6px;font-size:12px}
.wf-sec{display:flex;gap:4px;margin:0 0 8px}
.wf-sec button{flex:1;padding:4px;font-size:11px;border-radius:5px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:transparent;color:inherit}
.wf-sec button[data-on="1"]{background:rgba(96,165,250,.2);border-color:rgba(96,165,250,.5)}
.wf-issue{font-size:11.5px;line-height:1.5;padding:5px 7px;border-radius:5px;margin-bottom:4px;background:rgba(255,255,255,.04)}
.wf-issue[data-lv="error"]{background:rgba(248,113,113,.14);color:#fca5a5}
.wf-issue[data-lv="warn"]{background:rgba(251,191,36,.12);color:#fcd34d}
.wf-plan{font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:0}
.wf-empty{padding:14px;font-size:11.5px;opacity:.55;line-height:1.6}
.wf-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);padding:7px 14px;border-radius:6px;font-size:12px;z-index:9;
  background:rgba(30,34,42,.96);border:1px solid rgba(255,255,255,.16);box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:70%}
.wf-toast[data-kind="err"]{border-color:rgba(248,113,113,.6);color:#fca5a5}
.wf-run{position:absolute;right:12px;bottom:12px;width:min(520px,72%);max-height:64%;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:9px;z-index:8;
  background:rgba(26,30,38,.97);border:1px solid rgba(255,255,255,.16);box-shadow:0 12px 32px rgba(0,0,0,.45);font-size:12px}
.wf-run-head{display:flex;align-items:center;gap:8px;flex:none}
.wf-run-head b{font-size:12px;font-weight:600}
.wf-badge{padding:1px 7px;border-radius:9px;font-size:10.5px;border:1px solid rgba(255,255,255,.22);opacity:.85}
.wf-badge[data-s="completed"]{border-color:rgba(52,211,153,.7);color:#6ee7b7}
.wf-badge[data-s="waiting_review"]{border-color:rgba(251,191,36,.7);color:#fcd34d}
.wf-badge[data-s="failed"]{border-color:rgba(248,113,113,.7);color:#fca5a5}
.wf-run-steps{overflow:auto;display:flex;flex-direction:column;gap:3px;font-size:11.5px;max-height:170px}
.wf-run-step{display:flex;gap:6px;align-items:center;padding:3px 6px;border-radius:5px;background:rgba(255,255,255,.04)}
.wf-run-step[data-on="1"]{background:rgba(96,165,250,.16);outline:1px solid rgba(96,165,250,.45)}
.wf-run-step i{width:6px;height:6px;border-radius:50%;background:#64748b;flex:none}
.wf-run-step[data-st="succeeded"] i{background:#34d399}
.wf-run-step[data-st="waiting_review"] i{background:#fbbf24}
.wf-run-step[data-st="running"] i{background:#60a5fa}
.wf-run-wait{display:flex;flex-direction:column;gap:6px;flex:none;border-top:1px solid rgba(255,255,255,.1);padding-top:8px}
.wf-run-wait textarea{min-height:64px;max-height:130px;resize:vertical;font-size:11.5px;line-height:1.5;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.14);color:inherit}
.wf-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;opacity:.6;padding:6px 12px;border-top:1px solid rgba(255,255,255,.07);flex:none}
.wf-legend span{display:inline-flex;align-items:center;gap:4px}
.wf-legend i{width:7px;height:7px;border-radius:50%;display:inline-block}
`

/* ------------------------------------------------------------------ *
 * 面板
 * ------------------------------------------------------------------ */

function ensureCss(): void {
  const ID = 'dsh-workflow-canvas-css'
  if (document.getElementById(ID) !== null) return
  const style = document.createElement('style')
  style.id = ID
  style.textContent = CSS.replace(':host{display:block;height:100%;min-height:0}', '.dsh-wf-root{display:block;height:100%;min-height:0}')
  document.head.appendChild(style)
}

interface DragState {
  mode: 'node' | 'pan'
  id: string
  startX: number
  startY: number
  fromX: number
  fromY: number
}

export function CanvasPanel(): ReactElement {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [list, setList] = useState<GraphRow[]>([])
  const [doc, setDoc] = useState<{ id: string; revision: number; graph: WorkflowGraph } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [view, setView] = useState({ x: 40, y: 30, scale: 1 })
  const [issues, setIssues] = useState<GraphIssue[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [tab, setTab] = useState<'issues' | 'plan'>('issues')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<ProductLineId>('game')
  const [link, setLink] = useState<{ node: string; port: string } | null>(null)
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 })
  const [picked, setPicked] = useState<string | null>(null)

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const viewRef = useRef(view)
  const docRef = useRef(doc)
  const linkRef = useRef(link)
  viewRef.current = view
  docRef.current = doc
  linkRef.current = link

  const toast = useCallback((kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text })
    window.setTimeout(() => { setMsg(current => (current !== null && current.text === text ? null : current)) }, 3200)
  }, [])

  useEffect(() => { ensureCss() }, [])

  const refreshList = useCallback(async () => {
    const result = await call<{ graphs: GraphRow[] }>('/graphs')
    if (result.ok) setList(result.data?.graphs ?? [])
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      const result = await call<Catalog>('/catalog')
      if (!alive) return
      if (!result.ok || result.data === undefined) { toast('err', '节点目录读取失败：' + (result.error ?? '')); return }
      setCatalog(result.data)
      await refreshList()
    })()
    return () => { alive = false }
  }, [refreshList, toast])

  const openGraph = useCallback(async (id: string) => {
    if (dirty && !window.confirm('当前画布有未保存的改动，切走会丢失。继续？')) return
    setBusy(true)
    const result = await call<{ graph: WorkflowGraph; row: GraphRow; issues: GraphIssue[] }>('/graphs/' + encodeURIComponent(id))
    setBusy(false)
    if (!result.ok || result.data === undefined) { toast('err', result.error ?? '打开失败'); return }
    setDoc({ id: result.data.row.id, revision: result.data.row.revision, graph: result.data.graph })
    setLine(result.data.graph.line)
    setDirty(false)
    setSel(null)
    setIssues([])
    setPlan(null)
    setPicked(id)
    setView({ x: 40, y: 30, scale: 1 })
    if (result.data.issues.length > 0) toast('err', '这个画布读入时有 ' + result.data.issues.length + ' 处被修正：' + result.data.issues[0].message)
  }, [dirty, toast])

  const createGraph = useCallback(async (templateId?: string) => {
    setBusy(true)
    const body = templateId === undefined ? { line, graph: emptyGraph(line, lineOf(line).name + ' 流程') } : { templateId }
    const result = await call<{ graph: WorkflowGraph; row: GraphRow }>('/graphs', { method: 'POST', body: JSON.stringify(body) })
    setBusy(false)
    if (!result.ok || result.data === undefined) { toast('err', result.error ?? '新建失败'); return }
    setDoc({ id: result.data.row.id, revision: result.data.row.revision, graph: result.data.graph })
    setLine(result.data.graph.line)
    setDirty(false)
    setSel(null)
    setIssues([])
    setPlan(null)
    setPicked(result.data.row.id)
    setView({ x: 40, y: 30, scale: 1 })
    await refreshList()
    toast('ok', '已新建「' + result.data.graph.name + '」，共 ' + result.data.graph.nodes.length + ' 个节点')
  }, [line, refreshList, toast])

  const save = useCallback(async () => {
    const current = docRef.current
    if (current === null) return
    setBusy(true)
    const result = await call<{ graph: WorkflowGraph; row: GraphRow; issues: GraphIssue[] }>('/graphs/' + encodeURIComponent(current.id), {
      method: 'PUT',
      body: JSON.stringify({ graph: current.graph, baseRevision: current.revision }),
    })
    setBusy(false)
    if (!result.ok || result.data === undefined) { toast('err', result.error ?? '保存失败'); return }
    setDoc({ id: result.data.row.id, revision: result.data.row.revision, graph: current.graph })
    setDirty(false)
    await refreshList()
    toast('ok', '已保存（第 ' + result.data.row.revision + ' 版）')
  }, [refreshList, toast])

  const removeGraph = useCallback(async () => {
    const current = docRef.current
    if (current === null) return
    if (!window.confirm('删除「' + current.graph.name + '」？只删这张图，不动其它数据。')) return
    const result = await call('/graphs/' + encodeURIComponent(current.id), { method: 'DELETE' })
    if (!result.ok) { toast('err', result.error ?? '删除失败'); return }
    setDoc(null)
    setSel(null)
    setPicked(null)
    setDirty(false)
    await refreshList()
    toast('ok', '已删除')
  }, [refreshList, toast])

  const mutate = useCallback((change: (graph: WorkflowGraph) => WorkflowGraph) => {
    setDoc(current => (current === null ? current : { ...current, graph: change(current.graph) }))
    setDirty(true)
    setPlan(null)
  }, [])

  const runCheck = useCallback(() => {
    const current = docRef.current
    if (current === null) return
    const found = validateGraphOf(current.graph)
    setIssues(found)
    setTab('issues')
    const errors = found.filter(issue => issue.level === 'error').length
    toast(errors === 0 ? 'ok' : 'err', errors === 0 ? '结构没问题，可以预演' : '有 ' + errors + ' 个错误必须先修')
  }, [toast])

  const runPlan = useCallback(() => {
    const current = docRef.current
    if (current === null) return
    const found = validateGraphOf(current.graph)
    setIssues(found)
    setPlan(planOfGraph(current.graph))
    setTab('plan')
  }, [])

  const addNodeAt = useCallback((type: string, point?: Point) => {
    const def = catalog?.defs.find(item => item.id === type)
    if (def === undefined) return
    const center = point ?? { x: 120 - viewRef.current.x, y: 120 - viewRef.current.y }
    const id = type.replace(/[^A-Za-z0-9_-]/g, '-') + '-' + Math.random().toString(36).slice(2, 7)
    const config: Record<string, string | number | boolean> = {}
    for (const field of def.config) config[field.key] = field.value
    mutate(graph => ({ ...graph, nodes: [...graph.nodes, { id, type: def.id, x: Math.round(center.x), y: Math.round(center.y), config }] }))
    setSel(id)
  }, [catalog, mutate])

  const deleteNode = useCallback((id: string) => {
    mutate(graph => ({ ...graph, nodes: graph.nodes.filter(node => node.id !== id), edges: graph.edges.filter(edge => edge.from.node !== id && edge.to.node !== id) }))
    setSel(null)
  }, [mutate])

  const connect = useCallback((from: { node: string; port: string }, to: { node: string; port: string }) => {
    const current = docRef.current
    if (current === null) return
    const issue = canConnectOf(current.graph, from, to)
    if (issue !== null) { toast('err', issue.message); return }
    mutate(graph => ({ ...graph, edges: [...graph.edges, { from: { ...from }, to: { ...to } }] }))
  }, [mutate, toast])

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const box = canvasRef.current?.getBoundingClientRect()
    if (box === undefined) return { x: 0, y: 0 }
    const v = viewRef.current
    return { x: (clientX - box.left - v.x) / v.scale, y: (clientY - box.top - v.y) / v.scale }
  }, [])

  /* 滚轮缩放：必须用非 passive 的原生监听，React 的 onWheel 在根节点上是 passive 的，拦不住页面滚动。 */
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const box = canvas.getBoundingClientRect()
      setView(current => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * (event.deltaY < 0 ? 1.1 : 0.9)))
        const px = event.clientX - box.left
        const py = event.clientY - box.top
        return { scale: next, x: px - ((px - current.x) / current.scale) * next, y: py - ((py - current.y) / current.scale) * next }
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [doc])

  /* Delete / Backspace 删除选中节点；输入框里不拦。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (document.querySelector('[data-dsh-wf-canvas]') === null) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && sel !== null) { event.preventDefault(); deleteNode(sel) }
      if (event.key === 'Escape') { setSel(null); setLink(null) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sel, deleteNode])

  /* -------------------------- 渲染 -------------------------- */
  const graph = doc?.graph ?? null
  const defs = catalog?.defs ?? []
  const lineDefs = defs.filter(def => def.lines === undefined || def.lines.includes(line))
  const errorNodes = new Set(issues.filter(issue => issue.level === 'error' && issue.nodeId !== undefined).map(issue => issue.nodeId as string))
  const selectedNode = graph === null || sel === null ? null : graph.nodes.find(node => node.id === sel) ?? null
  const selectedDef = selectedNode === null ? undefined : defById(selectedNode.type)
  const templatesForLine = (catalog?.templates ?? []).filter(item => item.line === line)

  const onCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-node]') !== null) return
    setSel(null)
    dragRef.current = { mode: 'pan', id: '', startX: event.clientX, startY: event.clientY, fromX: view.x, fromY: view.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onNodePointerDown = (event: React.PointerEvent<HTMLElement>, node: CanvasNode): void => {
    event.stopPropagation()
    setSel(node.id)
    dragRef.current = { mode: 'node', id: node.id, startX: event.clientX, startY: event.clientY, fromX: node.x, fromY: node.y }
    canvasRef.current?.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (linkRef.current !== null) setCursor(toWorld(event.clientX, event.clientY))
    const drag = dragRef.current
    if (drag === null) return
    const dx = (event.clientX - drag.startX) / viewRef.current.scale
    const dy = (event.clientY - drag.startY) / viewRef.current.scale
    if (drag.mode === 'pan') {
      setView(current => ({ ...current, x: drag.fromX + (event.clientX - drag.startX), y: drag.fromY + (event.clientY - drag.startY) }))
      return
    }
    mutate(current => ({
      ...current,
      nodes: current.nodes.map(node => (node.id === drag.id ? { ...node, x: Math.round(drag.fromX + dx), y: Math.round(drag.fromY + dy) } : node)),
    }))
  }

  const endDrag = (): void => {
    dragRef.current = null
    if (linkRef.current !== null) setLink(null)
  }

  const updateConfig = (key: string, value: string | number | boolean): void => {
    if (sel === null) return
    mutate(current => ({
      ...current,
      nodes: current.nodes.map(node => (node.id === sel ? { ...node, config: { ...node.config, [key]: value } } : node)),
    }))
  }

  /* 运行：把当前画布交给宿主编译成步骤后逐步推进。生成类节点必须有人提交真实正文，
     所以这里只提供「提交 / 确认 / 导出」三个动作，不做任何自动填充。 */
  const [run, setRun] = useState<RunView | null>(null)
  const [runText, setRunText] = useState('')
  const [runBusy, setRunBusy] = useState(false)

  const applyRun = (data: any): void => {
    const next = (data?.view ?? data) as RunView | undefined
    if (next === undefined || next === null) return
    setRun(next)
    setRunText('')
  }

  const startRun = async (): Promise<void> => {
    if (doc === null) return
    setRunBusy(true)
    try {
      const result = await call<any>('/runs', { method: 'POST', body: JSON.stringify({ graphId: doc.id }) })
      if (!result.ok) { setMsg({ kind: 'err', text: '起运行失败：' + result.error }); return }
      applyRun(result.data)
      setMsg({ kind: 'ok', text: '运行已创建，按提示逐步推进' })
    } finally { setRunBusy(false) }
  }

  const submitRun = async (): Promise<void> => {
    if (run === null || runText.trim() === '') { setMsg({ kind: 'err', text: '内容不能为空' }); return }
    setRunBusy(true)
    try {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/submit', { method: 'POST', body: JSON.stringify({ content: runText }) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '提交失败' }); return }
      applyRun(result.data)
    } finally { setRunBusy(false) }
  }

  const confirmRun = async (): Promise<void> => {
    if (run === null || run.waiting === null) return
    setRunBusy(true)
    try {
      const content = runText === '' ? (run.waiting.content ?? '') : runText
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/confirm', { method: 'POST', body: JSON.stringify({ taskId: run.waiting.taskId, content }) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '确认失败' }); return }
      applyRun(result.data)
    } finally { setRunBusy(false) }
  }

  const advanceRun = async (): Promise<void> => {
    if (run === null) return
    setRunBusy(true)
    try {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/advance', { method: 'POST', body: JSON.stringify({}) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '推进失败' }); return }
      applyRun(result.data)
    } finally { setRunBusy(false) }
  }

  const exportRun = async (): Promise<void> => {
    if (run === null) return
    setRunBusy(true)
    try {
      const result = await call<{ dir: string; files: string[] }>('/runs/' + encodeURIComponent(run.runId) + '/export', { method: 'POST', body: JSON.stringify({}) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '导出失败' }); return }
      setMsg({ kind: 'ok', text: '已导出 ' + (result.data?.files.length ?? 0) + ' 个文件到 ' + (result.data?.dir ?? '') })
    } finally { setRunBusy(false) }
  }

  const runDrawer = (): ReactElement | null => {
    if (run === null) return null
    const waiting = run.waiting
    return h('div', { className: 'wf-run' },
      h('div', { className: 'wf-run-head' },
        h('b', null, '运行 · ' + run.runId.slice(-6)),
        h('span', { className: 'wf-badge', 'data-s': run.status }, RUN_STATUS[run.status] ?? run.status),
        h('span', { className: 'wf-sp' }),
        h('button', { type: 'button', className: 'wf-btn', disabled: runBusy || run.status !== 'completed', onClick: () => { void exportRun() } }, '导出产物'),
        h('button', { type: 'button', className: 'wf-btn', onClick: () => setRun(null) }, '收起'),
      ),
      h('div', { className: 'wf-run-steps' }, run.steps.map(step => h('div', {
        key: step.nodeId, className: 'wf-run-step',
        'data-st': step.state, 'data-on': waiting?.nodeId === step.nodeId ? '1' : '0',
      },
        h('i', null),
        h('span', { style: { flex: '1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, step.title),
        h('span', { style: { opacity: 0.5, fontSize: '10.5px' } }, step.kind === 'human' ? '人工' : step.kind === 'agent' ? '模型' : '程序'),
        h('span', { style: { opacity: 0.45, fontSize: '10.5px' } }, step.state === 'succeeded' ? (step.content.length + ' 字') : step.state === 'pending' ? '待执行' : step.state),
      ))),
      waiting === null
        ? (run.status === 'completed'
            ? h('div', { className: 'wf-hint' }, '这条流程已经跑完，每一步都有被采用的产物快照。点「导出产物」写到磁盘。')
            : null)
        : h('div', { className: 'wf-run-wait' },
            h('div', { className: 'wf-hint' },
              waiting.kind === 'human'
                ? '停在第 ' + run.steps.filter(step => step.state === 'succeeded').length + ' 步之后：' + waiting.title + ' 需要人工确认。可直接确认，也可以先改正文。'
                : waiting.kind === 'agent'
                  ? '下一步「' + waiting.title + '」要真实正文：把内容填进下面的框再提交（模型节点不会自动编造）。'
                  : '下一步「' + waiting.title + '」是程序节点，点继续即可。'),
            waiting.kind === 'static'
              ? h('div', { style: { display: 'flex', gap: '8px' } },
                  h('button', { type: 'button', className: 'wf-btn', 'data-primary': '1', disabled: runBusy, onClick: () => { void advanceRun() } }, '继续'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  h('textarea', {
                    value: runText === '' ? (waiting.content ?? '') : runText,
                    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setRunText(event.target.value),
                    placeholder: waiting.kind === 'human' ? '确认前可编辑正文…' : '粘贴这一步的产出正文…',
                  }),
                  h('div', { style: { display: 'flex', gap: '8px' } },
                    h('button', {
                      type: 'button', className: 'wf-btn', 'data-primary': '1', disabled: runBusy,
                      onClick: () => { void (waiting.kind === 'human' ? confirmRun() : submitRun()) },
                    }, waiting.kind === 'human' ? '确认并继续' : '提交并继续'))),
          ),
    )
  }

  return h('div', { className: 'wf dsh-wf-root', 'data-dsh-workflow-canvas': '' },
    /* 顶部条 */
    h('div', { className: 'wf-top' },
      h('span', { className: 'wf-title' }, '工作流画布'),
      h('div', { className: 'wf-line' }, PRODUCT_LINES.map(item => h('button', {
        key: item.id, type: 'button', 'data-on': item.id === line ? '1' : '0',
        onClick: () => { setLine(item.id); setPlan(null) },
        title: item.summary,
      }, item.short))),
      h('select', {
        value: doc?.id ?? '',
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { if (event.target.value !== '') void openGraph(event.target.value) },
        style: { maxWidth: '190px', fontSize: '12px', padding: '4px 6px', borderRadius: '5px', background: 'rgba(0,0,0,.28)', border: '1px solid rgba(255,255,255,.14)', color: 'inherit' },
      },
        h('option', { value: '' }, '选择已有画布（' + list.length + '）'),
        list.map(row => h('option', { key: row.id, value: row.id }, row.name + ' · ' + lineOf(row.line).short + ' · v' + row.revision)),
      ),
      h('button', { type: 'button', className: 'wf-btn', disabled: busy, onClick: () => { void createGraph() } }, '+ 新建'),
      h('button', { type: 'button', className: 'wf-btn', 'data-primary': '1', disabled: doc === null || busy || !dirty, onClick: () => { void save() } },
        dirty ? '保存改动' : '已保存'),
      h('button', { type: 'button', className: 'wf-btn', disabled: doc === null, onClick: runCheck }, '校验'),
      h('button', { type: 'button', className: 'wf-btn', disabled: doc === null, onClick: runPlan }, '执行预演'),
      h('button', { type: 'button', className: 'wf-btn', 'data-primary': '1', disabled: doc === null || runBusy, title: '把这张图真的跑起来：程序节点自动过，模型节点等你提交正文，人工节点等你确认', onClick: () => { void startRun() } }, run === null ? '开始运行' : '重新运行'),
      h('span', { className: 'wf-sp' }),
      h('span', { style: { fontSize: '11px', opacity: 0.5 } }, doc === null ? '未打开画布' : 'v' + doc.revision + ' · ' + graph!.nodes.length + ' 节点 / ' + graph!.edges.length + ' 线 · ' + Math.round(view.scale * 100) + '%'),
      doc === null ? null : h('button', { type: 'button', className: 'wf-btn', onClick: () => { void removeGraph() } }, '删除'),
    ),
    /* 主体 */
    h('div', { className: 'wf-main' },
      h('div', { className: 'wf-lib' },
        h('div', { className: 'wf-lib-head' }, lineOf(line).name + ' · 节点库（拖到画布或点击添加）'),
        h('div', { className: 'wf-lib-body' },
          CATEGORIES.map(category => {
            const items = lineDefs.filter(def => def.cat === category.id)
            if (items.length === 0) return null
            return h('div', { key: category.id },
              h('div', { className: 'wf-cat' }, h('i', { style: { background: category.accent } }), category.name, h('span', { style: { opacity: 0.5 } }, '(' + items.length + ')')),
              items.map(def => h('button', {
                key: def.id, type: 'button', className: 'wf-item', title: def.hint,
                draggable: true,
                onDragStart: (event: React.DragEvent<HTMLButtonElement>) => { event.dataTransfer.setData('text/wf-node', def.id); event.dataTransfer.effectAllowed = 'copy' },
                onClick: () => addNodeAt(def.id),
              }, def.title, h('small', null, def.actor === 'agent' ? '模型' : def.actor === 'human' ? '等人工' : '程序 · ' + TYPE_HINT(def)))),
            )
          }),
          h('div', { className: 'wf-cat', style: { marginTop: '14px' } }, '模板（一键铺满整条链路）'),
          templatesForLine.length === 0 ? h('div', { className: 'wf-hint' }, '这条产品线还没有模板') : null,
          templatesForLine.map(item => h('div', {
            key: item.id, className: 'wf-tpl', onClick: () => { void createGraph(item.id) },
          }, h('b', null, item.name), h('span', null, item.summary), h('div', { style: { opacity: 0.45, marginTop: '2px' } }, item.steps + ' 个节点'))),
        ),
      ),
      /* 画布 */
      h('div', {
        className: 'wf-canvas', ref: canvasRef, 'data-panning': dragRef.current?.mode === 'pan' ? '1' : '0',
        onPointerDown: onCanvasPointerDown, onPointerMove, onPointerUp: endDrag, onPointerLeave: endDrag,
        onDragOver: (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' },
        onDrop: (event: React.DragEvent<HTMLDivElement>) => {
          event.preventDefault()
          const type = event.dataTransfer.getData('text/wf-node')
          if (type !== '') addNodeAt(type, toWorld(event.clientX, event.clientY))
        },
      },
        graph === null ? h('div', { className: 'wf-empty' },
          '还没有打开画布。点「+ 新建」从空白开始，或从左侧模板一键铺一条完整链路（游戏/小说/短剧各有一条）。') : null,
        graph === null ? null : h('div', { className: 'wf-world', style: { transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')' } },
          h('svg', { className: 'wf-edges', width: 4000, height: 3000 },
            graph.edges.map((edge, index) => {
              const fromNode = graph.nodes.find(node => node.id === edge.from.node)
              const toNode = graph.nodes.find(node => node.id === edge.to.node)
              if (fromNode === undefined || toNode === undefined) return null
              const fromDef = defById(fromNode.type)
              const toDef = defById(toNode.type)
              if (fromDef === undefined || toDef === undefined) return null
              const color = (catalog?.typeColor ?? {})[fromDef.outputs.find(port => port.id === edge.from.port)?.type ?? 'any'] ?? '#94a3b8'
              const a = portPoint(fromNode, fromDef, edge.from.port, 'out')
              const b = portPoint(toNode, toDef, edge.to.port, 'in')
              return h('path', {
                key: 'e' + index, d: curve(a, b), stroke: color,
                onClick: () => mutate(current => ({ ...current, edges: current.edges.filter((_, i) => i !== index) })),
              })
            }),
            link === null ? null : (() => {
              const source = graph.nodes.find(node => node.id === link.node)
              const sourceDef = source === undefined ? undefined : defById(source.type)
              if (source === undefined || sourceDef === undefined) return null
              return h('path', { d: curve(portPoint(source, sourceDef, link.port, 'out'), cursor), 'data-preview': '1', stroke: '#93c5fd' })
            })(),
          ),
          graph.nodes.map(node => {
            const def = defById(node.type)
            if (def === undefined) return null
            return h('div', {
              key: node.id, 'data-node': node.id, className: 'wf-node',
              'data-sel': node.id === sel ? '1' : '0', 'data-bad': errorNodes.has(node.id) ? '1' : '0',
              style: { left: node.x + 'px', top: node.y + 'px' },
            },
              h('div', { className: 'wf-node-head', onPointerDown: (event: React.PointerEvent<HTMLElement>) => onNodePointerDown(event, node) },
                h('i', { className: 'wf-dot', style: { background: CATEGORIES.find(item => item.id === def.cat)?.accent ?? '#94a3b8' } }),
                h('b', null, def.title),
                h('em', null, def.actor === 'agent' ? '模型' : def.actor === 'human' ? '人工' : '程序'),
              ),
              h('div', { className: 'wf-ports', style: { minHeight: Math.max(def.inputs.length, def.outputs.length) * PORT_GAP + 6 } },
                def.inputs.map((port, index) => h('div', { key: 'in-' + port.id, className: 'wf-port', 'data-dir': 'in', style: { position: 'absolute', left: 0, top: 3 + index * PORT_GAP, width: '100%' } },
                  h('span', { className: 'wf-pin', 'data-dir': 'in', style: { top: 4 + index * PORT_GAP, borderColor: (catalog?.typeColor ?? {})[port.type] ?? '#94a3b8' }, title: port.label + ' · ' + ((catalog?.typeLabel ?? {})[port.type] ?? port.type) }),
                  h('span', { style: { opacity: 0.65 } }, port.label + (port.optional === true ? '?' : '')),
                )),
                def.outputs.map((port, index) => h('div', { key: 'out-' + port.id, className: 'wf-port', 'data-dir': 'out', style: { position: 'absolute', right: 0, top: 3 + index * PORT_GAP, width: '100%' } },
                  h('span', { style: { opacity: 0.65 } }, port.label),
                  h('span', {
                    className: 'wf-pin', 'data-dir': 'out', style: { top: 4 + index * PORT_GAP, borderColor: (catalog?.typeColor ?? {})[port.type] ?? '#94a3b8' },
                    title: '拖这条到下游输入口 · ' + ((catalog?.typeLabel ?? {})[port.type] ?? port.type),
                    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
                      event.stopPropagation()
                      setLink({ node: node.id, port: port.id })
                      setCursor(toWorld(event.clientX, event.clientY))
                    },
                  }),
                )),
              ),
              h('div', { style: { height: 6 } }),
            )
          }),
        ),
        msg === null ? null : h('div', { className: 'wf-toast', 'data-kind': msg.kind, 'data-dsh-wf-toast': '' }, msg.text),
      ),
      h(WorkflowSidePanel, {
        graph,
        row: doc === null ? null : { id: doc.id, revision: doc.revision },
        node: selectedNode,
        def: selectedDef,
        catalog,
        issues,
        plan,
        tab,
        dirty,
        setTab,
        update: updateConfig,
        rename: (name: string) => mutate(current => ({ ...current, name })),
        deleteNode,
        pickNode: (id: string) => setSel(id),
      }),
    ),
    h('div', { className: 'wf-legend' },
      Object.keys(catalog?.typeLabel ?? {}).map(type => h('span', { key: type }, h('i', { style: { background: (catalog?.typeColor ?? {})[type] } }), (catalog?.typeLabel ?? {})[type])),
    ),
  )
}

/* ------------------------------------------------------------------ *
 * 右侧属性面板
 * ------------------------------------------------------------------ */

interface SideProps {
  graph: WorkflowGraph | null
  row: { id: string; revision: number } | null
  node: CanvasNode | null
  def: NodeDef | undefined
  catalog: Catalog | null
  issues: GraphIssue[]
  plan: Plan | null
  tab: 'issues' | 'plan'
  dirty: boolean
  setTab(tab: 'issues' | 'plan'): void
  update(key: string, value: string | number | boolean): void
  rename(name: string): void
  deleteNode(id: string): void
  pickNode(id: string): void
}

function Field(props: { field: ConfigField; value: string | number | boolean; update(key: string, value: string | number | boolean): void }): ReactElement {
  const field = props.field
  const set = (value: string | number | boolean): void => props.update(field.key, value)
  return h('div', { className: 'wf-field' },
    h('label', null, field.label),
    field.kind === 'select'
      ? h('select', { value: String(props.value), onChange: (event: React.ChangeEvent<HTMLSelectElement>) => set(event.target.value) },
          (field.options ?? []).map(option => h('option', { key: option, value: option }, option)))
      : field.kind === 'number' || field.kind === 'range'
        ? h('div', null,
            field.kind === 'range'
              ? h('input', { type: 'range', min: field.min ?? 0, max: field.max ?? 1, step: field.step ?? 0.1, value: Number(props.value), onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(Number(event.target.value)) })
              : h('input', { type: 'number', min: field.min, max: field.max, step: field.step ?? 1, value: Number(props.value), onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(Number(event.target.value)) }),
            h('div', { className: 'wf-hint' }, '当前 ' + String(props.value) + (field.min === undefined ? '' : '（' + field.min + '–' + field.max + '）')),
          )
        : field.kind === 'textarea'
          ? h('textarea', { value: String(props.value), onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => set(event.target.value) })
          : field.kind === 'check'
            ? h('label', { className: 'wf-check' },
                h('input', { type: 'checkbox', checked: props.value === true, onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(event.target.checked) }),
                h('span', null, field.label))
            : h('input', { type: 'text', value: String(props.value), onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(event.target.value) }),
    field.hint === undefined ? null : h('div', { className: 'wf-hint' }, field.hint),
  )
}

export function WorkflowSidePanel(props: SideProps): ReactElement {
  const { graph, node, def, catalog } = props
  if (node !== null && def !== undefined) {
    return h('div', { className: 'wf-side' },
      h('div', { className: 'wf-lib-head' }, '节点 · ' + def.title),
      h('div', { className: 'wf-side-body' },
        h('div', { className: 'wf-sub' }, def.hint),
        def.config.map(field => h(Field, { key: field.key, field, value: node.config[field.key] ?? field.value, update: props.update })),
        h('h4', { style: { marginTop: '14px' } }, '端口'),
        h('div', { className: 'wf-hint' },
          '输入：' + (def.inputs.length === 0 ? '无' : def.inputs.map(port => port.label + (port.optional === true ? '(可选)' : '') + ':' + ((catalog?.typeLabel ?? {})[port.type] ?? port.type)).join('、'))),
        h('div', { className: 'wf-hint' },
          '输出：' + (def.outputs.length === 0 ? '无（终点）' : def.outputs.map(port => port.label + ':' + ((catalog?.typeLabel ?? {})[port.type] ?? port.type)).join('、'))),
        h('button', { type: 'button', className: 'wf-btn', style: { marginTop: '14px' }, onClick: () => props.deleteNode(node.id) }, '删除这个节点'),
      ),
    )
  }

  const counts = props.plan?.counts
  return h('div', { className: 'wf-side' },
    h('div', { className: 'wf-lib-head' }, '画布'),
    h('div', { className: 'wf-side-body' },
      graph === null
        ? h('div', { className: 'wf-hint' }, '没有打开画布。')
        : h('div', null,
            h('div', { className: 'wf-field' },
              h('label', null, '名称'),
              h('input', { type: 'text', value: graph.name, onChange: (event: React.ChangeEvent<HTMLInputElement>) => props.rename(event.target.value) }),
            ),
            h('div', { className: 'wf-hint' }, lineOf(graph.line).summary),
            h('div', { className: 'wf-sub', style: { marginTop: '8px' } },
              lineOf(graph.line).focus.map(item => '· ' + item).join('　') + (props.dirty ? '　（有未保存改动）' : '')),
            h('div', { className: 'wf-sec', style: { marginTop: '10px' } },
              h('button', { type: 'button', 'data-on': props.tab === 'issues' ? '1' : '0', onClick: () => props.setTab('issues') }, '问题 ' + props.issues.length),
              h('button', { type: 'button', 'data-on': props.tab === 'plan' ? '1' : '0', onClick: () => props.setTab('plan') }, '预演 ' + (props.plan === null ? '—' : props.plan.steps.length)),
            ),
            props.tab === 'issues'
              ? (props.issues.length === 0
                  ? h('div', { className: 'wf-hint' }, '还没有校验。点顶部「校验」检查环、缺输入、空配置。')
                  : h('div', null, props.issues.map((issue, index) => h('div', {
                      key: 'i' + index, className: 'wf-issue', 'data-lv': issue.level,
                      style: { cursor: issue.nodeId === undefined ? 'default' : 'pointer' },
                      onClick: () => { if (issue.nodeId !== undefined) props.pickNode(issue.nodeId) },
                    }, (issue.level === 'error' ? '错误 · ' : '提示 · ') + issue.message))))
              : (props.plan === null
                  ? h('div', { className: 'wf-hint' }, '点顶部「执行预演」：按拓扑顺序列出每一步由谁做、吃什么、产出什么。只算计划，不调模型、不写文件。')
                  : h('div', null,
                      counts === undefined ? null : h('div', { className: 'wf-hint', style: { marginBottom: '8px' } },
                        planLabel(props.plan) + ' · 模型 ' + counts.agent + ' 步 / 人工 ' + counts.human + ' 步 / 程序 ' + counts.auto + ' 步'),
                      h('pre', { className: 'wf-plan' }, props.plan.markdown),
                    )),
          ),
    ),
    runDrawer(),
  )
}

function planLabel(plan: Plan): string {
  return plan.ok ? '可以执行' : '不可执行'
}

/* ------------------------------------------------------------------ *
 * 入口：工作台顶部按钮 + 侧栏按钮
 * ------------------------------------------------------------------ */

const ENTRY_ATTR = 'data-dsh-workflow-canvas-entry'
const ENTRY_HANDLE = '__dshWorkflowCanvasEntry'

/** 工作台面板顶部的「工作流画布」按钮：和工作流沙盒按钮并排，点它切到画布面板。 */
export function CanvasEntry(props: { ctx: ClientContext }): ReactElement {
  ensureCss()
  return h('div', { style: { flex: 'none', padding: '6px 10px', display: 'flex', gap: '8px' } },
    h('button', {
      type: 'button',
      className: 'wf-btn',
      'data-primary': '1',
      style: { fontSize: '12px' },
      onClick: () => {
        try { props.ctx.layout?.selectPanel(WORKFLOW_CANVAS_PANEL_KEY) } catch (cause) { console.warn('[dsh-workflow] 打开画布失败：', String(cause)) }
      },
    }, '工作流画布'),
    h('span', { style: { fontSize: '11px', opacity: 0.5, alignSelf: 'center' } }, '节点式 · 拖拽连线 · 游戏 / 小说 / 短剧'),
  )
}


/** 注册画布面板（main 插槽）。入口只有工作台面板顶部那一个按钮，侧栏不再重复挂。 */
export function installWorkflowCanvasPanel(ctx: ClientContext): void {
  ensureCss()
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: WORKFLOW_CANVAS_PANEL_KEY,
    inject: () => ({}),
  }, CanvasPanel))
}
