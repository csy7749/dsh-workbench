/**
 * 工作流画布 · DSH 面板（节点式，可拖拽可连线可配置）
 *
 * 和前一批的「操作沙盒」是两回事：那个是内核状态机的工程夹具（假执行器 + 临时库），
 * 左侧节点库按注册的产品线给节点，中间画布拖拽连线，
 * 右侧配置参数，底部能校验拓扑并生成执行预演。数据存在工作台库的 wf_graphs 表。
 *
 * 面板挂在工作台 Shadow DOM 中，使用独立的画布样式。
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { NODE_WIDTH, alignSelection, connectionChoices, duplicateSelection, fitGraph, graphBounds, historyStack, layoutGraph, type ConnectionTarget } from './canvas-editor.ts'
import { readCanvasDraft, writeCanvasDraft } from './canvas-drafts.ts'
import {
  CATEGORIES, PRODUCT_LINES, defById, emptyGraph, lineOf, summarizeIssues,
  TYPE_LABEL, canConnect, planOf, validateGraph,
  normalizeGraph, type CanvasNode, type ConfigField, type GraphIssue, type NodeDef, type Plan,
  type ProductLineId, type WorkflowGraph,
} from '../../shared/workflow-catalog.ts'

const validateGraphOf = validateGraph
const planOfGraph = planOf
const canConnectOf = canConnect

function TYPE_HINT(def: NodeDef): string {
  const first = def.outputs[0]
  return first === undefined ? '终点' : TYPE_LABEL[first.type]
}

export const WORKFLOW_CANVAS_PANEL_KEY = 'workbench.workflow.canvas'
const API = '/workbench-api/workflow'
const NODE_W = NODE_WIDTH
const PORT_TOP = 44
const PORT_GAP = 22
const MIN_SCALE = 0.08
const MAX_SCALE = 2.2

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

interface RunStep { revision: number; nodeId: string; title: string; type: string; kind: 'human' | 'agent' | 'static'; state: string; stale: boolean; content: string; inputs?: { nodeId: string | null; fromPort: string | null; toPort: string | null; snapshotId: string }[]; omittedInputs?: { nodeId: string; fromPort: string; toPort: string; reason: string; snapshotId: string | null; eventSeq: number | null }[] }
interface RunRevision { id: string; status: string; note: string; prompt: string; sessionId: string; content?: string; reportId?: string }
interface RunWaiting { editor?: { kind: string; fields: { key: string; label: string }[]; regenerateLabel: string }; sources?: { nodeId: string; title: string; snapshotId: string; content: string }[]; revisions?: RunRevision[]; kind: string; nodeId: string | null; title: string; taskId: string | null; content: string; bindingVersion?: number; taskRevision?: number }
interface RunView { auto?: { enabled: number; state: string; session_id?: string | null; reason?: string | null } | null; generation?: { session_id: string } | null; runId: string; revision: number; status: string; pauseReason?: string; attempts?: any[]; validations?: any[]; events?: any[]; steps: RunStep[]; waiting: RunWaiting | null }


const RUN_STATUS: Record<string, string> = {
  created: '已创建', running: '运行中', waiting_review: '等人工确认', paused: '已暂停',
  completed: '已完成', failed: '失败', cancelled: '已取消',
}
const STEP_STATUS: Record<string, string> = { pending: '待运行', running: '运行中', waiting_review: '待审核', succeeded: '已完成', stale: '已过期', paused: '已暂停', failed: '失败', cancelled: '已取消', skipped: '分支跳过' }


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
  return PORT_TOP + Math.max(def.inputs.length, def.outputs.length) * PORT_GAP + 24 + inlineFields(def).reduce((height, field) => height + (field.kind === 'textarea' ? 150 : field.kind === 'range' ? 88 : 72), 0)
}

function inlineFields(def: NodeDef): ConfigField[] {
  const fields = def.config.slice(0, 2)
  const prompt = def.config.find(field => field.key === 'prompt')
  return prompt && !fields.includes(prompt) ? [...fields.slice(0, 1), prompt] : fields
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
.wf{--dsh-text-1:#e6e6e6;--dsh-bg:#14161a;--dsh-panel:#1b1e24;--dsh-line:rgba(255,255,255,.14);--dsh-accent:#60a5fa;display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsh-text-1);background:var(--dsh-bg);color-scheme:dark}
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
.wf-marquee{position:absolute;pointer-events:none;z-index:6;border:1px solid #60a5fa;background:rgba(96,165,250,.14)}
.wf-world{position:absolute;left:0;top:0;transform-origin:0 0;width:0;height:0}
.wf-node{position:absolute;width:248px;box-sizing:border-box;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:var(--dsh-panel,#1b1e24);
  box-shadow:0 6px 18px rgba(0,0,0,.35);user-select:none}
.wf-node[data-sel="1"]{border-color:#60a5fa;box-shadow:0 0 0 1px rgba(96,165,250,.5),0 8px 22px rgba(0,0,0,.45)}
.wf-node[data-bad="1"]{border-color:rgba(248,113,113,.75)}
.wf-node-head{display:flex;align-items:center;gap:6px;height:33px;padding:7px 9px;border-bottom:1px solid rgba(255,255,255,.08);cursor:move;border-radius:8px 8px 0 0}
.wf-node-head b{font-size:12px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-node-head em{font-style:normal;font-size:10px;opacity:.55}
.wf-dot{width:7px;height:7px;border-radius:50%;flex:none}
.wf-ports{position:relative;padding:3px 0 6px}
.wf-port{display:flex;align-items:center;height:22px;font-size:10.5px;opacity:.85;pointer-events:none}
.wf-port[data-dir="in"]{padding-left:12px}
.wf-port[data-dir="out"]{justify-content:flex-end;padding-right:12px}
.wf-pin{position:absolute;width:11px;height:11px;border-radius:50%;background:#0f1115;border:2px solid #94a3b8;cursor:crosshair;z-index:2;pointer-events:auto}
.wf-pin[data-dir="in"]{left:-6px}
.wf-pin[data-dir="out"]{right:-6px}
.wf-pin:hover{transform:scale(1.25)}
.wf-pin[data-compatible="yes"]{background:#34d399;box-shadow:0 0 0 5px rgba(52,211,153,.18)}
.wf-pin[data-compatible="no"]{opacity:.35}
.wf-pin[data-dir="out"]::before{content:"";position:absolute;inset:-10px}
.wf-node[data-link-target="yes"]{outline:2px solid #34d399;outline-offset:2px}
.wf-node[data-link-target="no"]{outline:2px solid #f87171;outline-offset:2px}
.wf-link-menu{position:absolute;z-index:10;min-width:150px;max-width:240px;padding:6px;border:1px solid rgba(255,255,255,.2);border-radius:7px;background:var(--dsh-panel,#1b1e24);box-shadow:0 8px 24px rgba(0,0,0,.45);cursor:default}
.wf-link-menu button{display:block;width:100%;text-align:left;margin-top:3px}
.wf-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.wf-edges path{fill:none;stroke-width:2;pointer-events:stroke;cursor:pointer}
.wf-edges .wf-edge-hit{stroke:transparent;stroke-width:14}
.wf-edges path[data-preview="1"]{stroke-dasharray:5 4;stroke:#93c5fd}
.wf-edges path[data-selected="1"]{stroke-width:4;filter:drop-shadow(0 0 4px #93c5fd)}
.wf-node-fields{border-top:1px solid rgba(255,255,255,.08);padding:7px 9px 3px;user-select:text}
.wf-node-fields .wf-field{margin-bottom:6px}.wf-node-fields textarea{min-height:54px;max-height:100px}
.wf-node-fields .wf-hint{display:none}
.wf-search{box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid rgba(255,255,255,.14);border-radius:5px;background:rgba(0,0,0,.25);color:inherit}
.wf-canvas-tools{position:absolute;left:12px;bottom:12px;display:flex;gap:4px;z-index:5;background:var(--dsh-panel,#1b1e24);padding:4px;border:1px solid rgba(255,255,255,.14);border-radius:7px}
.wf-canvas-tools{right:204px;max-width:calc(100% - 228px);flex-wrap:wrap}
.wf-minimap{position:absolute;right:12px;bottom:12px;width:180px;height:120px;z-index:4;border:1px solid rgba(255,255,255,.16);border-radius:6px;background:rgba(20,24,30,.92);cursor:crosshair;touch-action:none}
@media(max-width:850px){.wf-minimap{width:130px;height:88px}.wf-canvas-tools{right:154px;max-width:calc(100% - 178px)}}
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
.wf-start{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center}
.wf-start-title{font-size:13px;font-weight:600}
.wf-start-hint{font-size:11.5px;opacity:.6;max-width:420px;line-height:1.6}
.wf-start-list{display:flex;flex-direction:column;gap:8px;width:min(420px,100%);margin-top:4px}
.wf-start-item{display:flex;flex-direction:column;gap:3px;align-items:flex-start;padding:10px 12px;border:1px solid var(--dsh-line);border-radius:8px;background:var(--dsh-panel);color:inherit;cursor:pointer;text-align:left}
.wf-start-item:hover{border-color:var(--dsh-accent,#60a5fa)}
.wf-start-name{font-size:12.5px;font-weight:600}
.wf-start-sum{font-size:11px;opacity:.6}
.wf-start-foot{margin-top:6px}
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
.wf-run-progress{display:grid!important;grid-template-columns:220px minmax(0,1fr);align-content:start;align-items:start;gap:10px}
.wf-run-progress>*{grid-column:2;min-width:0}
.wf-run-progress>.wf-run-head{grid-column:1/-1}
.wf-run-progress>.wf-run-steps{grid-column:1;grid-row:2/span 20;max-height:none}
@media(max-width:1000px){.wf-run-progress{grid-template-columns:170px minmax(0,1fr)}}
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

function ensureCss(container: HTMLElement): void {
  const ID = 'dsh-workflow-canvas-css'
  const target = container.getRootNode()
  const root = target instanceof ShadowRoot ? target : document.head
  if (root.querySelector('#' + ID) !== null) return
  const style = document.createElement('style')
  style.id = ID
  style.textContent = CSS.replace(':host{display:block;height:100%;min-height:0}', '.dsh-wf-root{display:block;height:100%;min-height:0}')
  root.appendChild(style)
}

interface DragState {
  mode: 'node' | 'pan' | 'select'
  id: string
  startX: number
  startY: number
  fromX: number
  fromY: number
  additive?: boolean
}

const canvasDrafts = new Map<string, { id: string; revision: number; graph: WorkflowGraph }>()
let draftWarningInstalled = false
const draftStorage = (): Storage | null => { try { return window.localStorage } catch { return null } }

function installDraftWarning(): void {
  if (draftWarningInstalled) return
  draftWarningInstalled = true
  window.addEventListener('beforeunload', event => { if (canvasDrafts.size) { event.preventDefault(); event.returnValue = '' } })
}

export function CanvasPanel(props: CanvasScope = {}): ReactElement {
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
  const [templateDraft, setTemplateDraft] = useState<{ name: string; fields: { nodeId: string; key: string; value: unknown }[]; keep: string[] } | null>(null)
  const [line, setLine] = useState<ProductLineId>(PRODUCT_LINES[0].id)
  const [displayMode, setDisplayMode] = useState<'progress' | 'canvas'>('canvas')
  const [selection, setSelection] = useState<string[]>([])
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [, setHistoryVersion] = useState(0)
  const [link, setLink] = useState<{ node: string; port: string; replaceIndex?: number } | null>(null)
  const [linkTarget, setLinkTarget] = useState<{ node: string; valid: boolean } | null>(null)
  const [linkChoice, setLinkChoice] = useState<{ from: { node: string; port: string; replaceIndex?: number }; targets: ConnectionTarget[]; x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 })
  const [picked, setPicked] = useState<string | null>(null)

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const viewRef = useRef(view)
  const docRef = useRef(doc)
  const linkRef = useRef(link)
  const historyRef = useRef(historyStack<WorkflowGraph>())
  const dragHistoryRef = useRef(false)
  viewRef.current = view
  docRef.current = doc
  linkRef.current = link

  const toast = useCallback((kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text })
    window.setTimeout(() => { setMsg(current => (current !== null && current.text === text ? null : current)) }, 3200)
  }, [])

  const productPath = props.productId ?? ''
  const scopeKey = productPath || '__templates__'
  const persistDraft = useCallback((value: { id: string; revision: number; graph: WorkflowGraph } | null) => {
    if (value) canvasDrafts.set(scopeKey, value)
    else canvasDrafts.delete(scopeKey)
    if (!writeCanvasDraft(draftStorage(), scopeKey, value) && value) toast('err', '画布草稿暂时无法写入本地存储，请及时保存。')
  }, [scopeKey, toast])
  useEffect(() => { installDraftWarning() }, [])
  const refreshList = useCallback(async (): Promise<GraphRow[]> => {
    const query = productPath === '' ? '' : '?product=' + encodeURIComponent(productPath)
    const result = await call<{ graphs: GraphRow[] }>('/graphs' + query)
    if (!result.ok) return []
    const rows = result.data?.graphs ?? []
    setList(rows)
    return rows
  }, [productPath])

  useEffect(() => {
    let alive = true
    void (async () => {
      const result = await call<Catalog>('/catalog')
      if (!alive) return
      if (!result.ok || result.data === undefined) { toast('err', '节点目录读取失败：' + (result.error ?? '')); return }
      setCatalog(result.data)
      const rows = await refreshList()
      const draft = canvasDrafts.get(scopeKey) ?? readCanvasDraft(draftStorage(), scopeKey)
      if (draft && alive) {
        canvasDrafts.set(scopeKey, draft)
        docRef.current = draft; setDoc(draft); setLine(draft.graph.line); setDirty(true)
        const row = rows.find(item => item.id === draft.id)
        toast(row?.revision === draft.revision ? 'ok' : 'err', row?.revision === draft.revision ? '已恢复未保存的画布草稿' : '草稿已恢复，但原画布版本已变化或被删除；保存会检查版本冲突。')
      }
    })()
    return () => { alive = false }
  }, [refreshList, toast, scopeKey])

  const openGraph = useCallback(async (id: string) => {
    if (dirty && !window.confirm('当前画布有未保存的改动，切走会丢失。继续？')) return
    const pending = canvasDrafts.get(scopeKey)
    if (pending && pending.id !== id && !dirty && !window.confirm('当前作用域有未保存的画布改动，打开另一张图会丢失。继续？')) return
    setBusy(true)
    const result = await call<{ graph: WorkflowGraph; row: GraphRow; issues: GraphIssue[] }>('/graphs/' + encodeURIComponent(id))
    setBusy(false)
    if (!result.ok || result.data === undefined) { toast('err', result.error ?? '打开失败'); return }
    persistDraft(null)
    docRef.current = { id: result.data.row.id, revision: result.data.row.revision, graph: result.data.graph }; setDoc(docRef.current)
    historyRef.current.clear(); setHistoryVersion(v => v + 1); setSelection([]); setSelectedEdge(null)
    setLine(result.data.graph.line)
    setDirty(false)
    setSel(null)
    setIssues([])
    setPlan(null)
    setPicked(id)
    setView({ x: 40, y: 30, scale: 1 })
    if (result.data.issues.length > 0) toast('err', '这个画布读入时有 ' + result.data.issues.length + ' 个提示：' + result.data.issues[0].message)
  }, [dirty, toast, persistDraft, scopeKey])

  /** 进来就该看到东西：这个作用域里有图就直接打开最近那张，不给空画布当首屏。 */
  useEffect(() => {
    if (doc !== null || docRef.current !== null || list.length === 0 || canvasDrafts.has(scopeKey) || readCanvasDraft(draftStorage(), scopeKey)) return
    void openGraph(list[0].id)
  }, [list, doc, openGraph, scopeKey])

  const createGraph = useCallback(async (templateId?: string, firstNode?: CanvasNode) => {
    if (dirty && !window.confirm('当前画布有未保存的改动，继续新建会丢失这些改动。继续？')) return
    setBusy(true)
    const body = templateId === undefined
      ? { line, graph: { ...emptyGraph(line, lineOf(line).name + (productPath === '' ? ' 模板草稿' : ' 流程')), nodes: firstNode ? [firstNode] : [] }, productId: productPath }
      : { templateId, productId: productPath }
    const result = await call<{ graph: WorkflowGraph; row: GraphRow }>('/graphs', { method: 'POST', body: JSON.stringify(body) })
    setBusy(false)
    if (!result.ok || result.data === undefined) { toast('err', result.error ?? '新建失败'); return }
    persistDraft(null)
    docRef.current = { id: result.data.row.id, revision: result.data.row.revision, graph: result.data.graph }; setDoc(docRef.current)
    historyRef.current.clear(); setHistoryVersion(v => v + 1); setSelection([]); setSelectedEdge(null)
    setLine(result.data.graph.line)
    setDirty(false)
    setSel(null)
    setIssues([])
    setPlan(null)
    setPicked(result.data.row.id)
    if (firstNode) setSel(firstNode.id)
    setView({ x: 40, y: 30, scale: 1 })
    await refreshList()
    toast('ok', '已新建「' + result.data.graph.name + '」，共 ' + result.data.graph.nodes.length + ' 个节点')
  }, [line, productPath, refreshList, toast, dirty, persistDraft])

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
    const latest = docRef.current
    if (!latest || latest.id !== current.id) { await refreshList(); return }
    const changedDuringSave = latest.graph !== current.graph
    const updated = { ...latest, revision: result.data.row.revision, graph: changedDuringSave ? latest.graph : result.data.graph }
    docRef.current = updated; setDoc(updated)
    persistDraft(changedDuringSave ? updated : null)
    setDirty(changedDuringSave)
    await refreshList()
    const warning = result.data.issues?.[0]?.message
    toast(warning ? 'err' : 'ok', changedDuringSave ? '已保存第 ' + result.data.row.revision + ' 版，之后的改动仍待保存' : warning ? '已保存，注意：' + warning : '已保存（第 ' + result.data.row.revision + ' 版）')
  }, [refreshList, toast, persistDraft])

  const removeGraph = useCallback(async () => {
    const current = docRef.current
    if (current === null) return
    if (!window.confirm('删除「' + current.graph.name + '」？只删这张图，不动其它数据。')) return
    const result = await call('/graphs/' + encodeURIComponent(current.id), { method: 'DELETE' })
    if (!result.ok) { toast('err', result.error ?? '删除失败'); return }
    setDoc(null)
    persistDraft(null); docRef.current = null
    setSel(null)
    setPicked(null)
    setDirty(false)
    await refreshList()
    toast('ok', '已删除')
  }, [refreshList, toast, persistDraft])

  const mutate = useCallback((change: (graph: WorkflowGraph) => WorkflowGraph, record = true) => {
    const current = docRef.current
    if (current === null) return
    const next = change(current.graph)
    if (record) { historyRef.current.push(current.graph); setHistoryVersion(v => v + 1) }
    const updated = { ...current, graph: next }
    persistDraft(updated)
    docRef.current = updated
    setDoc(updated)
    setDirty(true)
    setPlan(null)
  }, [persistDraft])

  const travelHistory = useCallback((direction: 'undo' | 'redo') => {
    const current = docRef.current
    if (!current) return
    const graph = historyRef.current[direction](current.graph)
    if (!graph) return
    const updated = { ...current, graph }; docRef.current = updated; setDoc(updated)
    persistDraft(updated)
    setDirty(true); setPlan(null); setSel(null); setSelection([]); setSelectedEdge(null); setHistoryVersion(v => v + 1)
  }, [persistDraft])

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
    const box = canvasRef.current?.getBoundingClientRect()
    const center = point ?? { x: Math.max(0, ((box?.width ?? 500) / 2 - viewRef.current.x) / viewRef.current.scale - NODE_W / 2), y: Math.max(0, ((box?.height ?? 300) / 2 - viewRef.current.y) / viewRef.current.scale - 40) }
    const id = type.replace(/[^A-Za-z0-9_-]/g, '-') + '-' + Math.random().toString(36).slice(2, 7)
    const config: Record<string, string | number | boolean> = {}
    for (const field of def.config) config[field.key] = field.value
    const node = { id, type: def.id, x: Math.round(center.x), y: Math.round(center.y), config }
    if (docRef.current === null) {
      if (!busy) void createGraph(undefined, node)
      return
    }
    mutate(graph => ({ ...graph, nodes: [...graph.nodes, node] }))
    setSel(id)
    setSelection([id]); setSelectedEdge(null)
  }, [catalog, mutate, busy, createGraph])

  useEffect(() => {
    if (!doc?.graph.nodes.length) return
    const frame = window.requestAnimationFrame(() => {
      const box = canvasRef.current?.getBoundingClientRect()
      if (box) setView(fitGraph(doc.graph.nodes, box.width, box.height, node => { const def = defById(node.type); return def ? nodeHeight(def) : 80 }))
    })
    return () => window.cancelAnimationFrame(frame)
  }, [doc?.id])

  const deleteNode = useCallback((id: string) => {
    mutate(graph => ({ ...graph, nodes: graph.nodes.filter(node => node.id !== id), edges: graph.edges.filter(edge => edge.from.node !== id && edge.to.node !== id) }))
    setSel(null)
    setSelection([])
  }, [mutate])

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
      if (event.composedPath().some(item => item instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(item.tagName))) return
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
  }, [])

  /* Shadow DOM 会重定向 target，用 composedPath 判断焦点是否在画布和输入框中。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const path = event.composedPath()
      if (path.some(item => item instanceof HTMLElement && (item.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(item.tagName)))) return
      const canvas = canvasRef.current
      if (!canvas || !path.includes(canvas)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); travelHistory(event.shiftKey ? 'redo' : 'undo'); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); travelHistory('redo'); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && selection.length) {
        event.preventDefault()
        const result = duplicateSelection(docRef.current!.graph, new Set(selection))
        mutate(() => result.graph); setSelection(result.ids); setSel(result.ids[0] ?? null); return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedEdge !== null) { event.preventDefault(); mutate(graph => ({ ...graph, edges: graph.edges.filter((_, i) => i !== selectedEdge) })); setSelectedEdge(null) }
        else if (selection.length) { event.preventDefault(); const ids = new Set(selection); mutate(graph => ({ ...graph, nodes: graph.nodes.filter(node => !ids.has(node.id)), edges: graph.edges.filter(edge => !ids.has(edge.from.node) && !ids.has(edge.to.node)) })); setSelection([]); setSel(null) }
      }
      if (event.key === 'Escape') { setSel(null); setSelection([]); setSelectedEdge(null); linkRef.current = null; setLink(null); setLinkTarget(null); setLinkChoice(null) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selection, selectedEdge, mutate, travelHistory])

  /* -------------------------- 渲染 -------------------------- */
  const graph = doc?.graph ?? null
  const defs = catalog?.defs ?? []
  const lineDefs = defs.filter(def => (def.lines === undefined || def.lines.includes(line)) && (def.title + ' ' + def.id + ' ' + def.hint).toLowerCase().includes(search.trim().toLowerCase()))
  const errorNodes = new Set(issues.filter(issue => issue.level === 'error' && issue.nodeId !== undefined).map(issue => issue.nodeId as string))
  const selectedNode = graph === null || sel === null ? null : graph.nodes.find(node => node.id === sel) ?? null
  const selectedDef = selectedNode === null ? undefined : defById(selectedNode.type)
  const templatesForLine = (catalog?.templates ?? []).filter(item => item.line === line)

  const onCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-node]') !== null) return
    if (target.closest('path') !== null || target.closest('.wf-canvas-tools, .wf-link-menu') !== null) return
    setLinkChoice(null)
    event.currentTarget.focus()
    if (!event.shiftKey) { setSel(null); setSelection([]) }
    setSelectedEdge(null)
    dragRef.current = { mode: event.shiftKey ? 'select' : 'pan', id: '', startX: event.clientX, startY: event.clientY, fromX: view.x, fromY: view.y, additive: event.shiftKey }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onNodePointerDown = (event: React.PointerEvent<HTMLElement>, node: CanvasNode): void => {
    event.stopPropagation()
    canvasRef.current?.focus()
    const next = event.shiftKey ? (selection.includes(node.id) ? selection.filter(id => id !== node.id) : [...selection, node.id]) : (selection.includes(node.id) ? selection : [node.id])
    setSelection(next); setSel(next.includes(node.id) ? node.id : next[0] ?? null); setSelectedEdge(null)
    dragHistoryRef.current = false
    dragRef.current = { mode: 'node', id: node.id, startX: event.clientX, startY: event.clientY, fromX: node.x, fromY: node.y }
    canvasRef.current?.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (linkRef.current !== null) {
      setCursor(toWorld(event.clientX, event.clientY))
      const hit = connectionDrop(event.clientX, event.clientY, linkRef.current)
      const target = hit?.node ? { node: hit.node, valid: hit.choices.length > 0 } : null
      setLinkTarget(previous => previous?.node === target?.node && previous?.valid === target?.valid ? previous : target)
    }
    const drag = dragRef.current
    if (drag === null) return
    if (drag.mode === 'select') {
      const box = canvasRef.current?.getBoundingClientRect()
      if (box) setMarquee({ x: Math.min(drag.startX, event.clientX) - box.left, y: Math.min(drag.startY, event.clientY) - box.top, width: Math.abs(event.clientX - drag.startX), height: Math.abs(event.clientY - drag.startY) })
      return
    }
    const dx = (event.clientX - drag.startX) / viewRef.current.scale
    const dy = (event.clientY - drag.startY) / viewRef.current.scale
    if (drag.mode === 'pan') {
      setView(current => ({ ...current, x: drag.fromX + (event.clientX - drag.startX), y: drag.fromY + (event.clientY - drag.startY) }))
      return
    }
    const moving = selection.includes(drag.id) ? selection : [drag.id]
    const currentNode = docRef.current?.graph.nodes.find(node => node.id === drag.id)
    if (!currentNode) return
    const x = Math.max(0, Math.round(drag.fromX + dx)), y = Math.max(0, Math.round(drag.fromY + dy))
    const nodes = docRef.current!.graph.nodes.filter(node => moving.includes(node.id))
    const offsetX = Math.max(-Math.min(...nodes.map(node => node.x)), x - currentNode.x)
    const offsetY = Math.max(-Math.min(...nodes.map(node => node.y)), y - currentNode.y)
    if (!offsetX && !offsetY) return
    mutate(current => ({
      ...current,
      nodes: current.nodes.map(node => (moving.includes(node.id) ? { ...node, x: Math.max(0, node.x + offsetX), y: Math.max(0, node.y + offsetY) } : node)),
    }), !dragHistoryRef.current)
    dragHistoryRef.current = true
  }

  const panToWorld = (worldX: number, worldY: number): void => {
    const box = canvasRef.current?.getBoundingClientRect()
    if (!box) return
    setView(current => ({ ...current, x: box.width / 2 - worldX * current.scale, y: box.height / 2 - worldY * current.scale }))
  }

  const connectionDrop = (clientX: number, clientY: number, from: { node: string; port: string; replaceIndex?: number }): { node: string; choices: ConnectionTarget[]; issue: GraphIssue | null } | null => {
    const canvas = canvasRef.current
    const current = docRef.current?.graph
    if (!canvas || !current) return null
    const bounds = canvas.getBoundingClientRect()
    if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return null
    const candidate = from.replaceIndex === undefined ? current : { ...current, edges: current.edges.filter((_, index) => index !== from.replaceIndex) }
    const root = canvas.getRootNode() as Document | ShadowRoot
    const hit = root.elementFromPoint(clientX, clientY)
    if (hit?.closest('.wf-canvas-tools, .wf-minimap, .wf-link-menu, .wf-start')) return null
    const direct = hit?.closest('[data-wf-input]') as HTMLElement | null
    if (direct && canvas.contains(direct)) {
      const to = { node: direct.dataset.nodeId ?? '', port: direct.dataset.portId ?? '' }
      const issue = canConnectOf(candidate, from, to)
      const node = current.nodes.find(item => item.id === to.node)
      const port = node && defById(node.type)?.inputs.find(item => item.id === to.port)
      return { node: to.node, choices: !issue && port ? [{ ...to, label: port.label, type: port.type }] : [], issue }
    }
    // A fixed screen-space radius keeps the target usable at any zoom level.
    const nearby = Array.from(canvas.querySelectorAll<HTMLElement>('[data-wf-input]')).map(element => {
      const box = element.getBoundingClientRect()
      const dx = Math.max(box.left - clientX, 0, clientX - box.right), dy = Math.max(box.top - clientY, 0, clientY - box.bottom)
      return { element, distance: Math.hypot(dx, dy) }
    }).filter(item => item.distance <= 18).sort((a, b) => a.distance - b.distance)
    const body = hit?.closest('[data-node]') as HTMLElement | null
    const bodyNode = body && canvas.contains(body) ? body.dataset.node : null
    const options = bodyNode ? nearby.filter(item => item.element.dataset.nodeId === bodyNode) : nearby
    const uniqueNearest = options[0] && (!options[1] || options[1].distance - options[0].distance > 3) ? options[0].element : null
    let nearbyIssue: GraphIssue | null = null
    if (uniqueNearest) {
      const to = { node: uniqueNearest.dataset.nodeId ?? '', port: uniqueNearest.dataset.portId ?? '' }
      const issue = canConnectOf(candidate, from, to)
      nearbyIssue = issue
      if (!issue) {
        const node = current.nodes.find(item => item.id === to.node)
        const port = node && defById(node.type)?.inputs.find(item => item.id === to.port)
        if (port) return { node: to.node, choices: [{ ...to, label: port.label, type: port.type }], issue: null }
      }
    }
    const nodeId = bodyNode ?? nearby[0]?.element.dataset.nodeId
    if (!nodeId) return null
    const result = connectionChoices(candidate, from, nodeId)
    return { node: nodeId, choices: result.choices, issue: nearbyIssue ?? result.issue }
  }

  const completeConnection = (from: { node: string; port: string; replaceIndex?: number }, to: { node: string; port: string }): void => {
    const current = docRef.current?.graph
    if (!current) return
    const candidate = from.replaceIndex === undefined ? current : { ...current, edges: current.edges.filter((_, index) => index !== from.replaceIndex) }
    const issue = canConnectOf(candidate, from, to)
    if (issue) { toast('err', issue.message); return }
    mutate(graph => ({ ...graph, edges: [...graph.edges.filter((_, index) => index !== from.replaceIndex), { from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } }] }))
    setSelectedEdge(null)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag?.mode === 'select') {
      const first = toWorld(drag.startX, drag.startY), last = toWorld(event.clientX, event.clientY)
      const left = Math.min(first.x, last.x), right = Math.max(first.x, last.x), top = Math.min(first.y, last.y), bottom = Math.max(first.y, last.y)
      const hits = (docRef.current?.graph.nodes ?? []).filter(node => { const def = defById(node.type); return node.x <= right && node.x + NODE_W >= left && node.y <= bottom && node.y + (def ? nodeHeight(def) : 80) >= top }).map(node => node.id)
      const next = [...new Set([...(drag.additive ? selection : []), ...hits])]
      setSelection(next); setSel(next[0] ?? null); setMarquee(null)
    }
    dragRef.current = null
    if (linkRef.current !== null) {
      const from = linkRef.current
      const drop = connectionDrop(event.clientX, event.clientY, from)
      if (drop?.choices.length === 1) completeConnection(from, drop.choices[0])
      else if (drop && drop.choices.length > 1) {
        const box = canvasRef.current!.getBoundingClientRect()
        setLinkChoice({ from, targets: drop.choices, x: Math.max(4, Math.min(box.width - 175, event.clientX - box.left)), y: Math.max(4, Math.min(box.height - 130, event.clientY - box.top)) })
      } else if (drop?.issue) {
        toast('err', drop.issue.message)
      }
      linkRef.current = null
      setLink(null)
      setLinkTarget(null)
    }
  }

  const updateNodeConfig = (id: string, key: string, value: string | number | boolean): void => {
    mutate(current => ({
      ...current,
      nodes: current.nodes.map(node => (node.id === id ? { ...node, config: { ...node.config, [key]: value } } : node)),
    }))
  }
  const updateConfig = (key: string, value: string | number | boolean): void => { if (sel !== null) updateNodeConfig(sel, key, value) }

  /* 运行：把当前画布交给宿主编译成步骤后逐步推进。生成类节点必须有人提交真实正文，
     所以这里只提供「提交 / 确认 / 导出」三个动作，不做任何自动填充。 */
  const [run, setRun] = useState<RunView | null>(null)
  const [history, setHistory] = useState<any[]>([])
  const [runText, setRunText] = useState('')
  let reviewDocuments: Record<string, string> | null = null
  try { const value = JSON.parse(runText); const editor = run?.waiting?.editor; if (editor && value?.kind === editor.kind && editor.fields.every(field => typeof value[field.key] === 'string')) reviewDocuments = value } catch {}
  const [runBusy, setRunBusy] = useState(false)

  const editorBaseline = useRef({ key: '', content: '' })
  const applyRun = (data: any, replaceEditor = false): void => {
    const next = (data?.view ?? data) as RunView | undefined
    if (!next?.runId || !Array.isArray(next.steps)) return
    const key = next.runId + ':' + (next.waiting?.taskId ?? next.waiting?.nodeId ?? '')
    const content = next.waiting?.content ?? ''
    const baseline = editorBaseline.current
    setRunText(current => replaceEditor || baseline.key !== key || current === baseline.content ? content : current)
    editorBaseline.current = { key, content }
    setRun(next)
  }

  useEffect(() => {
    let alive = true
    setRun(null)
    setRunText('')
    if (doc?.id) void (async () => {
      const history = await call<any>('/runs?graphId=' + encodeURIComponent(doc.id))
      if (alive) setHistory(history.data?.runs ?? [])
      const latest = history.data?.runs?.[0]
      if (!alive || !latest) return
      const result = await call<any>('/runs/' + encodeURIComponent(latest.run_id))
      if (alive && result.ok) applyRun(result.data)
    })()
    return () => { alive = false }
  }, [doc?.id])

  const startRun = async (automatic = false): Promise<void> => {
    if (doc === null) return
    setRunBusy(true)
    try {
      const result = await call<any>('/runs', { method: 'POST', body: JSON.stringify({ graphId: doc.id, automatic }) })
      if (!result.ok) { setMsg({ kind: 'err', text: '起运行失败：' + result.error }); return }
      applyRun(result.data)
      const history = await call<any>('/runs?graphId=' + encodeURIComponent(doc.id))
      setHistory(history.data?.runs ?? [])
      setMsg({ kind: 'ok', text: automatic ? '宿主自动运行已启动，遇到人工节点将等待确认' : '运行已创建，按提示逐步推进' })
    } finally { setRunBusy(false) }
  }

  useEffect(() => {
    const review = run?.waiting
    const active = review?.revisions?.filter(item => item.status === 'producing') ?? []
    if (!review || review.kind !== 'human' || active.length === 0) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      for (const revision of active) {
        const result = await call<any>('/runs/' + encodeURIComponent(run!.runId) + '/revisions/collect', { method: 'POST', body: JSON.stringify({ revisionId: revision.id, sessionId: revision.sessionId }) })
        if (!alive) return
        if (result.ok && result.data?.revision?.status !== 'producing') { applyRun(result.data); return }
      }
      timer = setTimeout(() => { void poll() }, 3000)
    }
    timer = setTimeout(() => { void poll() }, 1200)
    return () => { alive = false; clearTimeout(timer) }
  }, [run?.runId, run?.waiting?.nodeId, run?.waiting?.revisions?.length, run?.status])

  useEffect(() => {
    const sessionId = run?.generation?.session_id
    if (!sessionId || run?.status !== 'running' || run.auto?.enabled) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const collect = async (): Promise<void> => {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/collect', { method: 'POST', body: JSON.stringify({ sessionId }) })
      if (!alive) return
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '读取生成结果失败' }); return }
      if (result.data?.result?.status !== 'pending') {
        applyRun(result.data)
        if (result.data?.result?.status === 'failed') setMsg({ kind: 'err', text: '生成未被采纳：' + result.data.result.reason })
        return
      }
      timer = setTimeout(() => { void collect() }, 3000)
    }
    timer = setTimeout(() => { void collect() }, 1000)
    return () => { alive = false; clearTimeout(timer) }
  }, [run?.runId, run?.generation?.session_id, run?.status, run?.auto?.enabled])

  const rerunStep = async (step: RunStep): Promise<void> => {
    if (!run) return
    setRunBusy(true)
    try {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/rerun', { method: 'POST', body: JSON.stringify({ nodeId: step.nodeId, expectedRunRevision: run.revision, expectedStepRevision: step.revision }) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '重跑失败' }); return }
      applyRun(result.data)
      setMsg({ kind: 'ok', text: '本步及下游已标记失效，点击恢复后重新执行；旧快照保留。' })
    } finally { setRunBusy(false) }
  }

  const generateRun = async (): Promise<void> => {
    if (!run || !props.createSession || !props.sendSession) return
    setRunBusy(true)
    try {
      const sessionId = await props.createSession()
      const bound = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/generation', { method: 'POST', body: JSON.stringify({ sessionId }) })
      if (!bound.ok) throw new Error(bound.error)
      applyRun(bound.data)
      try { await props.sendSession(sessionId, bound.data.generation.prompt) }
      catch (cause) {
        const failed = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/generation-failed', { method: 'POST', body: JSON.stringify({ sessionId }) })
        if (failed.ok) applyRun(failed.data)
        throw cause
      }
      setMsg({ kind: 'ok', text: '生成会话已启动：' + sessionId })
    } catch (cause) { setMsg({ kind: 'err', text: String(cause) }) }
    finally { setRunBusy(false) }
  }

  const submitRun = async (): Promise<void> => {
    if (run === null || runText.trim() === '') { setMsg({ kind: 'err', text: '内容不能为空' }); return }
    setRunBusy(true)
    try {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/submit', { method: 'POST', body: JSON.stringify({ content: runText }) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '提交失败' }); return }
      applyRun(result.data)
      if (result.data?.adopted?.status === 'failed') setMsg({ kind: 'err', text: '内容未通过校验，已暂停；恢复后可重试。' })
    } finally { setRunBusy(false) }
  }

  const confirmRun = async (intent = 'continue'): Promise<void> => {
    if (run === null || run.waiting === null) return
    setRunBusy(true)
    try {
      const content = runText
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/confirm', { method: 'POST', body: JSON.stringify({ taskId: run.waiting.taskId, content, intent, expectedBindingVersion: run.waiting.bindingVersion, expectedTaskRevision: run.waiting.taskRevision, expectedRunRevision: run.revision }) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '确认失败' }); return }
      applyRun(result.data)
    } finally { setRunBusy(false) }
  }

  const reviseDesign = async (): Promise<void> => {
    if (!run?.waiting) return
    setRunBusy(true)
    try {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/revise-design', { method: 'POST', body: JSON.stringify({ taskId: run.waiting.taskId, content: runText, expectedBindingVersion: run.waiting.bindingVersion, expectedTaskRevision: run.waiting.taskRevision, expectedRunRevision: run.revision }) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '修改设计稿失败' }); return }
      applyRun(result.data)
      setMsg({ kind: 'ok', text: '设计稿已采用，规则及后续结果已过期，请重新生成规则。' })
    } finally { setRunBusy(false) }
  }

  useEffect(() => {
    if (!run?.auto?.enabled || !['created', 'running'].includes(run.status)) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId))
      if (!alive) return
      if (result.ok) applyRun(result.data)
      timer = setTimeout(() => { void poll() }, 2500)
    }
    timer = setTimeout(() => { void poll() }, 1200)
    return () => { alive = false; clearTimeout(timer) }
  }, [run?.runId, run?.auto?.enabled, run?.status])

  const controlRun = async (action: string): Promise<void> => {
    if (!run) return
    setRunBusy(true)
    try {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/' + action, { method: 'POST', body: JSON.stringify({ expectedRevision: run.revision, taskId: run.waiting?.taskId, content: runText, expectedBindingVersion: run.waiting?.bindingVersion, expectedTaskRevision: run.waiting?.taskRevision }) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '操作失败' }); return }
      applyRun(result.data)
    } finally { setRunBusy(false) }
  }

  const setAutoRun = async (enabled: boolean): Promise<void> => {
    if (!run) return
    setRunBusy(true)
    try {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/auto', { method: 'POST', body: JSON.stringify({ enabled }) })
      if (result.ok) applyRun(result.data); else setMsg({ kind: 'err', text: result.error ?? '自动运行设置失败' })
    } finally { setRunBusy(false) }
  }

  const beginRevision = async (): Promise<void> => {
    if (!run?.waiting || !props.createSession || !props.sendSession) return
    const note = window.prompt('告诉模型希望如何修订当前草稿')
    if (!note?.trim()) return
    setRunBusy(true)
    try {
      const sessionId = await props.createSession()
      const saved = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/draft', { method: 'POST', body: JSON.stringify({ taskId: run.waiting.taskId, content: runText, expectedBindingVersion: run.waiting.bindingVersion, expectedTaskRevision: run.waiting.taskRevision }) })
      if (!saved.ok) throw new Error(saved.error)
      applyRun(saved.data)
      const waiting = saved.data.view.waiting
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/revisions', { method: 'POST', body: JSON.stringify({ taskId: waiting.taskId, note, sessionId, expectedBindingVersion: waiting.bindingVersion, expectedTaskRevision: waiting.taskRevision }) })
      if (!result.ok) throw new Error(result.error)
      applyRun(result.data)
      try { await props.sendSession(sessionId, result.data.revision.prompt) }
      catch (cause) {
        const failed = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/revisions/fail', { method: 'POST', body: JSON.stringify({ revisionId: result.data.revision.id, reason: String(cause) }) })
        if (failed.ok) applyRun(failed.data)
        throw cause
      }
      setMsg({ kind: 'ok', text: '修订候选生成中：' + sessionId })
    } catch (cause) { setMsg({ kind: 'err', text: String(cause) }) }
    finally { setRunBusy(false) }
  }

  const collectRevision = async (revision: RunRevision): Promise<void> => {
    if (!run || !props.createSession) return
    setRunBusy(true)
    try {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/revisions/collect', { method: 'POST', body: JSON.stringify({ revisionId: revision.id, sessionId: revision.sessionId }) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '读取修订失败' }); return }
      applyRun(result.data)
    } finally { setRunBusy(false) }
  }

  const applyRevision = async (revision: RunRevision): Promise<void> => {
    if (!run) return
    setRunBusy(true)
    try {
      const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/revisions/apply', { method: 'POST', body: JSON.stringify({ revisionId: revision.id }) })
      if (!result.ok) { setMsg({ kind: 'err', text: result.error ?? '应用修订失败' }); return }
      applyRun(result.data, true)
      setMsg({ kind: 'ok', text: '修订候选已应用到草稿；确认前仍可编辑。' })
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
    return h('div', { className: 'wf-run' + (displayMode === 'progress' ? ' wf-run-progress' : ''), style: displayMode === 'progress' ? { position: 'relative', right: 'auto', bottom: 'auto', width: 'auto', flex: 1, minWidth: 0, maxHeight: 'none', overflow: 'auto' } : {} },
      h('div', { className: 'wf-run-head' },
        h('b', null, '运行 · ' + run.runId.slice(-6)),
        h('span', { className: 'wf-badge', 'data-s': run.status }, RUN_STATUS[run.status] ?? run.status),
        run.auto?.enabled ? h('span', { className: 'wf-badge' }, '宿主自动') : null,
        h('span', { className: 'wf-sp' }),
        !['completed', 'cancelled', 'failed'].includes(run.status) ? h('button', { type: 'button', className: 'wf-btn', disabled: runBusy, onClick: () => { void setAutoRun(!run.auto?.enabled) } }, run.auto?.enabled ? '关闭自动' : '开启自动') : null,
        h('button', { type: 'button', className: 'wf-btn', disabled: runBusy || run.status !== 'completed', onClick: () => { void exportRun() } }, '导出产物'),
        !['completed', 'cancelled', 'failed'].includes(run.status) ? h('button', { type: 'button', className: 'wf-btn', disabled: runBusy, onClick: () => { void controlRun(run.status === 'paused' ? 'resume' : 'pause') } }, run.status === 'paused' ? '恢复' : '暂停') : null,
        !['completed', 'cancelled', 'failed'].includes(run.status) ? h('button', { type: 'button', className: 'wf-btn', disabled: runBusy, onClick: () => { void controlRun('cancel') } }, '取消运行') : null,
        h('button', { type: 'button', className: 'wf-btn', onClick: () => setRun(null) }, '收起'),
      ),
      h('div', { className: 'wf-run-steps' }, run.steps.map(step => h('div', {
        key: step.nodeId, className: 'wf-run-step',
        'data-st': step.state, 'data-on': waiting?.nodeId === step.nodeId ? '1' : '0',
      },
        run.status === 'paused' && step.state === 'succeeded' ? h('button', { className: 'wf-btn', disabled: runBusy, onClick: () => { void rerunStep(step) } }, '重跑') : null,
        h('i', null),
        h('span', { style: { flex: '1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, step.title),
        h('span', { style: { opacity: 0.5, fontSize: '10.5px' } }, step.kind === 'human' ? '人工' : step.kind === 'agent' ? '模型' : '程序'),
        h('span', { style: { opacity: 0.45, fontSize: '10.5px' } }, step.stale ? '已失效 · 待重跑' : step.state === 'succeeded' ? (step.content.length + ' 字') : STEP_STATUS[step.state] ?? step.state),
      ))),
      run.pauseReason ? h('div', { className: 'wf-issue', 'data-lv': 'error' }, '停止原因：' + run.pauseReason) : null,
      run.auto?.reason ? h('div', { className: 'wf-issue', 'data-lv': 'error' }, '自动执行：' + run.auto.reason) : null,
      run.auto?.state === 'blocked' && run.auto.session_id && !(run.attempts ?? []).some(attempt => attempt.session_id === run.auto?.session_id) ? h('button', { className: 'wf-btn', disabled: runBusy, onClick: async () => {
        setRunBusy(true)
        try {
          const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/auto-reconcile', { method: 'POST', body: JSON.stringify({ sessionId: run.auto?.session_id }) })
          if (result.ok) applyRun(result.data); else setMsg({ kind: 'err', text: result.error ?? '恢复失败' })
        } finally { setRunBusy(false) }
      } }, '确认未发送并准备重试') : null,
      (run.attempts ?? []).filter(attempt => ['running', 'unknown'].includes(attempt.status) && attempt.session_id).map(attempt => h('button', { key: attempt.id, className: 'wf-btn', disabled: runBusy, onClick: async () => {
        if (!window.confirm('放弃采用本次会话结果？会话可能仍在运行，迟到结果会被忽略。之后可恢复并重试。')) return
        setRunBusy(true)
        try {
          const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/generation-abandon', { method: 'POST', body: JSON.stringify({ sessionId: attempt.session_id, expectedRevision: run.revision }) })
          if (result.ok) applyRun(result.data); else toast('err', result.error ?? '放弃失败')
        } finally { setRunBusy(false) }
      } }, '放弃本次生成结果并准备重试')),
      h('details', null, h('summary', null, '产物、尝试与校验历史'),
        ...run.steps.map(step => h('details', { key: step.nodeId }, h('summary', null, step.title + (step.stale ? ' · 上游已变更' : '')), h('pre', { style: { whiteSpace: 'pre-wrap' } }, step.content))),
        h('pre', { style: { whiteSpace: 'pre-wrap' } }, JSON.stringify({ attempts: run.attempts, validations: run.validations, events: run.events }, null, 2))),
      waiting === null
        ? (run.status === 'completed'
            ? h('div', { className: 'wf-hint' }, '流程已完成；命中的节点保留产物，未命中的分支已跳过。点「导出产物」写到磁盘。')
            : null)
        : h('div', { className: 'wf-run-wait' },
            h('div', { className: 'wf-hint' },
              waiting.kind === 'human'
                ? '停在第 ' + run.steps.filter(step => step.state === 'succeeded').length + ' 步之后：' + waiting.title + ' 需要人工确认。可直接确认，也可以先改正文。'
                : waiting.kind === 'agent'
                  ? '下一步「' + waiting.title + '」需要生成正文。可使用 DSH 生成，也可手动提交已有内容；通过校验后才会采用。'
                  : '下一步「' + waiting.title + '」是程序节点，点继续即可。'),
            waiting.kind === 'human' ? h('div', null, (waiting.sources ?? []).map(source => h('details', { key: source.nodeId, open: true }, h('summary', null, source.title + ' · ' + source.snapshotId), h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '260px', overflow: 'auto' } }, source.content)))) : null,
            waiting.kind === 'human' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', margin: '8px 0' } },
              h('button', { className: 'wf-btn', disabled: runBusy || !props.createSession || !props.sendSession, onClick: () => { void beginRevision() } }, '请求 AI 修订候选'),
              ...(waiting.revisions ?? []).map(revision => h('div', { key: revision.id, style: { borderTop: '1px solid var(--dsh-line)', paddingTop: '6px' } },
                h('div', null, revision.note + ' · ' + revision.status),
                revision.status === 'producing' ? h('button', { className: 'wf-btn', disabled: runBusy, onClick: () => { void collectRevision(revision) } }, '检查候选') : null,
                revision.status === 'ready' ? h('button', { className: 'wf-btn', disabled: runBusy, onClick: () => { void applyRevision(revision) } }, '应用到草稿') : null,
                revision.content ? h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '160px', overflow: 'auto' } }, revision.content) : null))) : null,
            waiting.kind === 'static'
              ? h('div', { style: { display: 'flex', gap: '8px' } },
                  h('button', { type: 'button', className: 'wf-btn', 'data-primary': '1', disabled: runBusy, onClick: () => { void advanceRun() } }, '继续'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  waiting.kind === 'agent' ? h('button', { className: 'wf-btn', disabled: runBusy || !!run.generation || !!run.auto?.enabled || !props.createSession, onClick: () => { void generateRun() } }, '使用 DSH 生成') : null,
                  waiting.kind === 'human' && reviewDocuments ? h('div', null,
                    ...(waiting.editor?.fields ?? []).map(field => h('label', { key: field.key, style: { display: 'block' } },
                      field.label,
                      h('textarea', { style: { width: '100%', minHeight: '180px' }, value: reviewDocuments![field.key], onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setRunText(JSON.stringify({ ...reviewDocuments, [field.key]: event.target.value }, null, 2)) })))) : h('textarea', {
                    value: runText,
                    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setRunText(event.target.value),
                    placeholder: waiting.kind === 'human' ? '确认前可编辑正文…' : '粘贴这一步的产出正文…',
                  }),
                  h('div', { style: { display: 'flex', gap: '8px' } },
                    h('button', {
                      type: 'button', className: 'wf-btn', 'data-primary': '1', disabled: runBusy,
                      onClick: () => { void (waiting.kind === 'human' ? confirmRun() : submitRun()) },
                    }, waiting.kind === 'human' ? '确认并继续' : '提交并继续'),
                    waiting.kind === 'human' ? h('button', { className: 'wf-btn', disabled: runBusy, onClick: () => { void controlRun('draft') } }, '保存草稿') : null,
                    waiting.kind === 'human' ? h('button', { className: 'wf-btn', disabled: runBusy, onClick: () => {
                      const note = window.prompt('记录需要修改的原因（保存草稿并留在当前待办）')
                      if (note?.trim()) void (async () => {
                        setRunBusy(true)
                        try {
                          const result = await call<any>('/runs/' + encodeURIComponent(run.runId) + '/request-changes', { method: 'POST', body: JSON.stringify({ taskId: waiting.taskId, content: runText, note, expectedBindingVersion: waiting.bindingVersion, expectedTaskRevision: waiting.taskRevision }) })
                          if (result.ok) { applyRun(result.data); toast('ok', '已记录修改意见，仍等待当前人工审核') } else toast('err', result.error ?? '记录失败')
                        } finally { setRunBusy(false) }
                      })()
                    } }, '要求修改并保留待办') : null,
                    waiting.kind === 'human' && reviewDocuments ? h('button', { className: 'wf-btn', disabled: runBusy, onClick: () => { void reviseDesign() } }, waiting.editor?.regenerateLabel) : null,
                    waiting.kind === 'human' ? h('button', { className: 'wf-btn', disabled: runBusy, onClick: () => { void confirmRun('pause') } }, '确认并暂停') : null)),
          ),
    )
  }

  return h('div', { className: 'wf dsh-wf-root', 'data-dsh-workflow-canvas': '' },
    /* 顶部条 */
    h('div', { className: 'wf-top' },
      h('span', { className: 'wf-title' }, '工作流画布'),
      productPath ? h('button', { className: 'wf-btn', onClick: () => setDisplayMode(displayMode === 'progress' ? 'canvas' : 'progress') }, displayMode === 'progress' ? '编辑这张图' : '流程进度') : null,
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
      h('button', { type: 'button', className: 'wf-btn', disabled: doc === null || dirty || busy, title: '先保存画布，再审阅模板的参数清空清单', onClick: async () => {
        const result = await call<{ fields: { nodeId: string; key: string; value: unknown }[] }>('/graphs/' + encodeURIComponent(doc!.id) + '/template')
        if (!result.ok || !result.data) { toast('err', result.error ?? '预览失败'); return }
        setTemplateDraft({ name: doc!.graph.name, fields: result.data.fields, keep: [] })
      } }, '保存为模板'),
      h('button', { type: 'button', className: 'wf-btn', disabled: doc === null, onClick: runCheck }, '校验'),
      h('button', { type: 'button', className: 'wf-btn', disabled: doc === null, onClick: runPlan }, '执行预演'),
      h('button', { type: 'button', className: 'wf-btn', disabled: !doc || !historyRef.current.canUndo, title: 'Ctrl+Z', onClick: () => travelHistory('undo') }, '撤销'),
      h('button', { type: 'button', className: 'wf-btn', disabled: !doc || !historyRef.current.canRedo, title: 'Ctrl+Shift+Z', onClick: () => travelHistory('redo') }, '重做'),
      h('button', { type: 'button', className: 'wf-btn', 'data-primary': '1', disabled: !productPath || doc === null || dirty || runBusy, title: '新建运行并推进到下一个生成或人工节点', onClick: () => { void startRun() } }, '新建运行'),
      h('button', { className: 'wf-btn', disabled: !productPath || doc === null || dirty || runBusy, title: '宿主自动运行，遇人工审核暂停；关闭页面后继续', onClick: () => { void startRun(true) } }, '自动运行'),
      h('button', { className: 'wf-btn', disabled: !doc || dirty, onClick: () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(doc!.graph, null, 2)], { type: 'application/json' }))
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'workflow.json'; anchor.click(); URL.revokeObjectURL(url)
      } }, '导出图 JSON'),
      h('label', { className: 'wf-btn' }, '导入图 JSON', h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]; if (!file) return
        try {
          if (dirty && !window.confirm('导入会切换画布，当前未保存的改动将丢失。继续？')) return
          if (file.size > 512 * 1024) throw new Error('画布文件超过 512 KB 上限')
          const normalized = normalizeGraph(JSON.parse(await file.text()), line)
          if (normalized.issues.length) throw new Error(normalized.issues.map(item => item.message).join('；'))
          const result = await call<any>('/graphs', { method: 'POST', body: JSON.stringify({ graph: normalized.graph, productId: productPath }) })
          if (!result.ok) throw new Error(result.error)
          await refreshList(); await openGraph(result.data.row.id)
        } catch (cause) { toast('err', String(cause)) }
        event.target.value = ''
      } })),
      h('span', { className: 'wf-sp' }),
      h('span', { style: { fontSize: '11px', opacity: 0.5 } }, doc === null ? '未打开画布' : 'v' + doc.revision + ' · ' + graph!.nodes.length + ' 节点 / ' + graph!.edges.length + ' 线 · ' + Math.round(view.scale * 100) + '%'),
      doc === null ? null : h('button', { type: 'button', className: 'wf-btn', onClick: () => { void removeGraph() } }, '删除'),
    ),
    doc === null ? null : h('details', { style: { padding: '6px 12px', flex: 'none' } },
      h('summary', null, '流程默认执行配置'),
      h('div', { className: 'wf-hint' }, '生成步骤继承这里的设置。指定模型经 DSH 接口确认后执行；接口拒绝时停止，历史记录请求与生效配置。'),
      (['providerId', 'modelId', 'role'] as const).map(key => h('div', { className: 'wf-field', key },
        h('label', null, key === 'providerId' ? '默认模型提供方' : key === 'modelId' ? '默认模型' : '默认角色指令'),
        h(key === 'role' ? 'textarea' : 'input', {
          value: doc.graph.defaults?.[key] ?? '',
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            const value = event.target.value
            mutate(current => ({ ...current, defaults: { providerId: '', modelId: '', role: '', ...current.defaults, [key]: value } }))
          },
        }),
      )),
    ),
    templateDraft === null ? null : h('div', { className: 'wf-side-body', role: 'dialog', 'aria-label': '保存为模板', style: { flex: 'none', maxHeight: '280px', overflow: 'auto' } },
      h('div', { className: 'wf-field' }, h('label', null, '模板名称（同名新增版本）'), h('input', { type: 'text', value: templateDraft.name, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setTemplateDraft({ ...templateDraft, name: event.target.value }) })),
      h('p', null, '以下字段默认清空；取消勾选则保留。提示词、阈值与选项保留。'),
      templateDraft.fields.map(field => {
        const key = field.nodeId + '.' + field.key
        return h('label', { className: 'wf-check', key }, h('input', { type: 'checkbox', checked: !templateDraft.keep.includes(key), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setTemplateDraft({ ...templateDraft, keep: event.target.checked ? templateDraft.keep.filter(value => value !== key) : [...templateDraft.keep, key] }) }), '清空 ' + key + '：' + String(field.value).slice(0, 100))
      }),
      h('button', { className: 'wf-btn', disabled: busy || !templateDraft.name.trim(), onClick: async () => {
        setBusy(true)
        const result = await call('/graphs/' + encodeURIComponent(doc!.id) + '/template', { method: 'POST', body: JSON.stringify(templateDraft) })
        setBusy(false)
        if (!result.ok) { toast('err', result.error ?? '保存模板失败'); return }
        setTemplateDraft(null)
        const updated = await call<Catalog>('/catalog')
        if (updated.data) setCatalog(updated.data)
        toast('ok', '已保存模板版本，产品图保持独立')
      } }, '确认保存'),
      h('button', { className: 'wf-btn', onClick: () => setTemplateDraft(null) }, '取消'),
    ),
    /* 主体 */
    h('div', { className: 'wf-main' },
      displayMode === 'progress' && doc ? h('div', { className: 'wf-lib' }, h('div', { className: 'wf-lib-head' }, '运行历史'), ...history.map(item => h('button', { key: item.run_id, className: 'wf-btn', onClick: async () => { const result = await call<any>('/runs/' + encodeURIComponent(item.run_id)); if (result.ok) applyRun(result.data); else toast('err', result.error ?? '读取运行失败') } }, item.run_id + ' · ' + (RUN_STATUS[item.status] ?? item.status)))) : null,
      displayMode === 'progress' && doc ? (runDrawer() ?? h('div', { className: 'wf-empty' }, '尚无运行。编辑并保存需求后，可以开始运行。')) : null,
      h('div', { className: 'wf-lib', style: { display: displayMode === 'progress' && doc ? 'none' : undefined } },
        h('div', { className: 'wf-lib-head' }, (PRODUCT_LINES.find(item => item.id === line)?.name ?? ('未安装产品线：' + line)) + ' · 节点库（拖到画布或点击添加）'),
        h('div', { className: 'wf-lib-body' },
          h('input', { className: 'wf-search', placeholder: '搜索节点名称或类型', value: search, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value) }),
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
        className: 'wf-canvas', ref: canvasRef, tabIndex: 0, 'data-panning': dragRef.current?.mode === 'pan' ? '1' : '0', style: { display: displayMode === 'progress' && doc ? 'none' : undefined },
        onPointerDown: onCanvasPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: () => { dragRef.current = null; linkRef.current = null; setLink(null); setLinkTarget(null); setMarquee(null) },
        onDragOver: (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' },
        onDrop: (event: React.DragEvent<HTMLDivElement>) => {
          event.preventDefault()
          const type = event.dataTransfer.getData('text/wf-node')
          if (type !== '') addNodeAt(type, toWorld(event.clientX, event.clientY))
        },
      },
        marquee ? h('div', { className: 'wf-marquee', style: { left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height } }) : null,
        graph === null ? h('div', { className: 'wf-start' },
          h('div', { className: 'wf-start-title' }, productPath === '' ? '从模板开始' : '这个产品还没有流程'),
          h('div', { className: 'wf-start-hint' },
            productPath === ''
              ? '点击或拖入左侧节点即可新建模板草稿；也可选择已有模板作为起点。编辑保存后，点击「保存为模板」发布。'
              : '选一条模板铺开，之后这张图归这个产品，改动只影响它自己。'),
          h('div', { className: 'wf-start-list' },
            templatesForLine.map(tpl => h('button', {
              key: tpl.id, type: 'button', className: 'wf-start-item', disabled: busy,
              onClick: () => { void createGraph(tpl.id) },
            },
              h('div', { className: 'wf-start-name' }, tpl.name),
              h('div', { className: 'wf-start-sum' }, tpl.summary + ' · ' + tpl.steps + ' 个节点'),
            )),
          ),
          h('div', { className: 'wf-start-foot' },
            h('button', { type: 'button', className: 'wf-btn', disabled: busy, onClick: () => { void createGraph() } }, '空白画布'),
          ),
        ) : null,
        graph === null ? null : h('div', { className: 'wf-world', style: { transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')' } },
          h('svg', { className: 'wf-edges', width: Math.max(4000, ...graph.nodes.map(node => node.x + NODE_W + 200)), height: Math.max(3000, ...graph.nodes.map(node => node.y + 500)) },
            graph.edges.map((edge, index) => {
              const fromNode = graph.nodes.find(node => node.id === edge.from.node)
              const toNode = graph.nodes.find(node => node.id === edge.to.node)
              if (fromNode === undefined || toNode === undefined) return null
              const fromDef = defById(fromNode.type)
              const toDef = defById(toNode.type)
              const color = (catalog?.typeColor ?? {})[fromDef?.outputs.find(port => port.id === edge.from.port)?.type ?? 'any'] ?? '#94a3b8'
              const a = fromDef ? portPoint(fromNode, fromDef, edge.from.port, 'out') : { x: fromNode.x + NODE_W, y: fromNode.y + PORT_TOP }
              const b = toDef ? portPoint(toNode, toDef, edge.to.port, 'in') : { x: toNode.x, y: toNode.y + PORT_TOP }
              return h('g', { key: 'e' + index },
                h('path', { className: 'wf-edge-hit', d: curve(a, b), onPointerDown: (event: React.PointerEvent<SVGPathElement>) => { event.stopPropagation(); canvasRef.current?.focus(); setSel(null); setSelection([]); setSelectedEdge(index) } }),
                h('path', {
                  d: curve(a, b), stroke: color,
                  'data-selected': selectedEdge === index ? '1' : '0',
                  onPointerDown: (event: React.PointerEvent<SVGPathElement>) => { event.stopPropagation(); canvasRef.current?.focus(); setSel(null); setSelection([]); setSelectedEdge(index) },
                }),
                selectedEdge === index ? h('circle', { cx: b.x, cy: b.y, r: 7, fill: color, stroke: '#fff', strokeWidth: 2, style: { pointerEvents: 'all', cursor: 'crosshair' },
                  onPointerDown: (event: React.PointerEvent<SVGCircleElement>) => { event.stopPropagation(); setLinkChoice(null); const next = { ...edge.from, replaceIndex: index }; setLink(next); linkRef.current = next; setCursor(toWorld(event.clientX, event.clientY)); canvasRef.current?.setPointerCapture(event.pointerId) } }) : null)
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
            if (def === undefined) return h('div', { key: node.id, 'data-node': node.id, className: 'wf-node', 'data-sel': selection.includes(node.id) ? '1' : '0', 'data-bad': '1', style: { left: node.x + 'px', top: node.y + 'px' } },
              h('div', { className: 'wf-node-head', onPointerDown: (event: React.PointerEvent<HTMLElement>) => onNodePointerDown(event, node) }, h('i', { className: 'wf-dot', style: { background: '#f87171' } }), h('b', null, node.title || node.type), h('em', null, '未安装')),
              h('div', { className: 'wf-hint', style: { padding: '8px 10px' } }, '节点数据和连线已保留；当前无法执行。'))
            return h('div', {
              key: node.id, 'data-node': node.id, className: 'wf-node',
              'data-sel': selection.includes(node.id) ? '1' : '0', 'data-bad': errorNodes.has(node.id) ? '1' : '0',
              'data-link-target': linkTarget?.node === node.id ? (linkTarget.valid ? 'yes' : 'no') : undefined,
              style: { left: node.x + 'px', top: node.y + 'px' },
            },
              h('div', { className: 'wf-node-head', onPointerDown: (event: React.PointerEvent<HTMLElement>) => onNodePointerDown(event, node) },
                h('i', { className: 'wf-dot', style: { background: CATEGORIES.find(item => item.id === def.cat)?.accent ?? '#94a3b8' } }),
                h('b', { onDoubleClick: () => { const title = window.prompt('节点名称', node.title || def.title); if (title?.trim()) mutate(current => ({ ...current, nodes: current.nodes.map(item => item.id === node.id ? { ...item, title: title.trim().slice(0, 120) } : item) })) } }, node.title || def.title),
                h('em', null, run?.steps.find(step => step.nodeId === node.id)?.stale ? '已过期' : STEP_STATUS[run?.steps.find(step => step.nodeId === node.id)?.state ?? ''] ?? (node.disabled ? '已停用' : def.actor === 'agent' ? '模型' : def.actor === 'human' ? '人工' : '程序')),
              ),
              h('div', { className: 'wf-ports', style: { minHeight: Math.max(def.inputs.length, def.outputs.length) * PORT_GAP + 6 } },
                def.inputs.map((port, index) => {
                  const connectGraph = link?.replaceIndex === undefined ? graph : { ...graph, edges: graph.edges.filter((_, edgeIndex) => edgeIndex !== link.replaceIndex) }
                  const connectIssue = link ? canConnectOf(connectGraph, { node: link.node, port: link.port }, { node: node.id, port: port.id }) : null
                  return h('div', { key: 'in-' + port.id, className: 'wf-port', 'data-dir': 'in', style: { position: 'absolute', left: 0, top: 3 + index * PORT_GAP, width: '100%' } },
                  h('span', { className: 'wf-pin', 'data-dir': 'in', 'data-compatible': link ? (connectIssue ? 'no' : 'yes') : undefined, 'data-wf-input': '', 'data-node-id': node.id, 'data-port-id': port.id, style: { top: 4, borderColor: (catalog?.typeColor ?? {})[port.type] ?? '#94a3b8' }, title: connectIssue?.message ?? (port.label + ' · ' + ((catalog?.typeLabel ?? {})[port.type] ?? port.type)) }),
                  h('span', { style: { opacity: 0.65 } }, port.label + (port.optional === true ? '?' : '')),
                ) }),
                def.outputs.map((port, index) => h('div', { key: 'out-' + port.id, className: 'wf-port', 'data-dir': 'out', style: { position: 'absolute', right: 0, top: 3 + index * PORT_GAP, width: '100%' } },
                  h('span', { style: { opacity: 0.65 } }, port.label),
                  h('span', {
                    className: 'wf-pin', 'data-dir': 'out', style: { top: 4, borderColor: (catalog?.typeColor ?? {})[port.type] ?? '#94a3b8' },
                    title: '拖这条到下游输入口 · ' + ((catalog?.typeLabel ?? {})[port.type] ?? port.type),
                    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
                      event.stopPropagation()
                      setLinkChoice(null)
                      setLink({ node: node.id, port: port.id })
                      linkRef.current = { node: node.id, port: port.id }
                      setCursor(toWorld(event.clientX, event.clientY))
                      canvasRef.current?.setPointerCapture(event.pointerId)
                    },
                  }),
                )),
              ),
              def.config.length ? h('div', { className: 'wf-node-fields', onPointerDown: (event: React.PointerEvent) => event.stopPropagation() },
                inlineFields(def).map(field => h(Field, { key: field.key, field, value: node.config[field.key] ?? field.value, update: (key: string, value: string | number | boolean) => updateNodeConfig(node.id, key, value) }))) : null,
              h('div', { style: { height: 6 } }),
            )
          }),
        ),
        linkChoice ? h('div', { className: 'wf-link-menu', role: 'dialog', 'aria-label': '选择输入端口', style: { left: linkChoice.x, top: linkChoice.y }, onPointerDown: (event: React.PointerEvent) => event.stopPropagation() },
          h('div', { className: 'wf-hint' }, '选择要连接的输入'),
          ...linkChoice.targets.map(target => h('button', { key: target.port, type: 'button', className: 'wf-btn', onClick: () => { completeConnection(linkChoice.from, target); setLinkChoice(null) } }, target.label + ' · ' + TYPE_LABEL[target.type])),
          h('button', { type: 'button', className: 'wf-btn', onClick: () => setLinkChoice(null) }, '取消'),
        ) : null,
        graph && displayMode === 'canvas' ? (() => {
          const heightOf = (node: CanvasNode): number => { const def = defById(node.type); return def ? nodeHeight(def) : 80 }
          const bounds = graphBounds(graph.nodes, heightOf)
          if (!bounds) return null
          const pad = 7, mapWidth = 164, mapHeight = 104
          const worldWidth = Math.max(1, bounds.right - bounds.left), worldHeight = Math.max(1, bounds.bottom - bounds.top)
          const scale = Math.min((mapWidth - pad * 2) / worldWidth, (mapHeight - pad * 2) / worldHeight)
          const viewportWidth = canvasRef.current?.clientWidth ?? 0, viewportHeight = canvasRef.current?.clientHeight ?? 0
          const viewport = { left: ( -view.x / view.scale - bounds.left) * scale + pad, top: (-view.y / view.scale - bounds.top) * scale + pad, width: viewportWidth / view.scale * scale, height: viewportHeight / view.scale * scale }
          const locate = (event: React.PointerEvent<SVGElement>): void => {
            const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect() ?? (event.currentTarget as SVGSVGElement).getBoundingClientRect()
            const px = (event.clientX - rect.left) * 180 / rect.width, py = (event.clientY - rect.top) * 120 / rect.height
            panToWorld(bounds.left + (px - pad) / scale, bounds.top + (py - pad) / scale)
          }
          return h('svg', { className: 'wf-minimap', viewBox: '0 0 180 120', role: 'img', 'aria-label': '畫布縮圖；點擊定位' },
            h('rect', { x: pad, y: pad, width: mapWidth, height: mapHeight, fill: 'transparent', onPointerDown: locate }),
            h('g', { onPointerDown: locate },
              ...graph.edges.map((edge, index) => { const from = graph.nodes.find(node => node.id === edge.from.node), to = graph.nodes.find(node => node.id === edge.to.node); return from && to ? h('line', { key: 'mini-edge-' + index, x1: pad + (from.x + NODE_WIDTH - bounds.left) * scale, y1: pad + (from.y + 24 - bounds.top) * scale, x2: pad + (to.x - bounds.left) * scale, y2: pad + (to.y + 24 - bounds.top) * scale, stroke: '#64748b', strokeWidth: 1 }) : null }),
              ...graph.nodes.map(node => h('rect', { key: node.id, x: pad + (node.x - bounds.left) * scale, y: pad + (node.y - bounds.top) * scale, width: Math.max(3, NODE_WIDTH * scale), height: Math.max(3, heightOf(node) * scale), rx: 1, fill: selection.includes(node.id) ? '#60a5fa' : '#94a3b8' })),
              h('rect', { x: viewport.left, y: viewport.top, width: viewport.width, height: viewport.height, fill: 'rgba(96,165,250,.1)', stroke: '#60a5fa', strokeWidth: 1, pointerEvents: 'none' }),
            ),
          )
        })() : null,
        graph ? h('div', { className: 'wf-canvas-tools', onPointerDown: (event: React.PointerEvent) => event.stopPropagation() },
          h('button', { className: 'wf-btn', onClick: () => setView(current => ({ ...current, scale: Math.max(MIN_SCALE, current.scale / 1.2) })) }, '−'),
          h('span', { style: { alignSelf: 'center', fontSize: 11, minWidth: 42, textAlign: 'center' } }, Math.round(view.scale * 100) + '%'),
          h('button', { className: 'wf-btn', onClick: () => setView(current => ({ ...current, scale: Math.min(MAX_SCALE, current.scale * 1.2) })) }, '+'),
          h('button', { className: 'wf-btn', onClick: () => { const box = canvasRef.current?.getBoundingClientRect(); if (box) setView(fitGraph(graph.nodes, box.width, box.height, node => { const def = defById(node.type); return def ? nodeHeight(def) : 80 })) } }, '适应画布'),
          h('button', { className: 'wf-btn', onClick: () => { try { mutate(current => layoutGraph(current, node => { const def = defById(node.type); return def ? nodeHeight(def) : 80 })) } catch (error) { toast('err', String((error as Error).message)) } } }, '自动布局'),
          selection.length > 1 ? h('button', { className: 'wf-btn', title: '选中节点左对齐', onClick: () => mutate(current => alignSelection(current, new Set(selection), 'left')) }, '左对齐') : null,
          selection.length > 1 ? h('button', { className: 'wf-btn', title: '选中节点顶对齐', onClick: () => mutate(current => alignSelection(current, new Set(selection), 'top')) }, '顶对齐') : null,
          h('span', { className: 'wf-hint', style: { alignSelf: 'center' } }, 'Shift 框选 · Ctrl+D 复制'),
          selectedEdge !== null ? h('span', { className: 'wf-hint', style: { alignSelf: 'center' } }, '拖动终点可重接') : null,
          selectedEdge !== null ? h('button', { className: 'wf-btn', onClick: () => { mutate(current => ({ ...current, edges: current.edges.filter((_, i) => i !== selectedEdge) })); setSelectedEdge(null) } }, '删除连线') : null,
        ) : null,
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
        pickNode: (id: string) => { setSel(id); setSelection([id]); setSelectedEdge(null) },
        hidden: displayMode === 'progress' && doc !== null,
        runStep: run?.steps.find(step => step.nodeId === selectedNode?.id) ?? null,
        toggleNode: (id: string) => mutate(current => ({ ...current, nodes: current.nodes.map(item => item.id === id ? { ...item, disabled: !item.disabled } : item) })),
      }),
      displayMode === 'canvas' ? runDrawer() : null,
    ),
    msg === null || displayMode !== 'progress' ? null : h('div', { className: 'wf-issue', 'data-lv': msg.kind === 'err' ? 'error' : 'warn' }, msg.text),
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
  hidden?: boolean
  toggleNode(id: string): void
  runStep: RunStep | null
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
  if (props.hidden) return h('div', { style: { display: 'none' } })
  if (node !== null && def !== undefined) {
    return h('div', { className: 'wf-side' },
      h('div', { className: 'wf-lib-head' }, '节点 · ' + def.title),
      h('div', { className: 'wf-side-body' },
        h('div', { className: 'wf-sub' }, def.hint),
        def.config.map(field => h(Field, { key: field.key, field, value: node.config[field.key] ?? field.value, update: props.update })),
        props.runStep ? h('details', { open: true }, h('summary', null, '本次运行 · ' + (props.runStep.stale ? '已过期' : STEP_STATUS[props.runStep.state] ?? props.runStep.state)),
          ...(props.runStep.inputs ?? []).map((input, index) => h('div', { key: index, className: 'wf-hint' }, (input.toPort ?? '输入') + ' ← ' + (input.nodeId ?? '上游') + (input.fromPort ? '.' + input.fromPort : '') + ' · ' + input.snapshotId)),
          ...(props.runStep.omittedInputs ?? []).map((input, index) => h('div', { key: 'omitted-' + index, className: 'wf-hint' }, input.toPort + ' ← ' + input.nodeId + '.' + input.fromPort + ' · ' + (input.reason === 'port_inactive' ? '此出口未命中' : '上游分支已跳过') + (input.snapshotId ? ' · ' + input.snapshotId : ' · 事件 #' + input.eventSeq))),
          h('pre', { className: 'wf-plan', style: { maxHeight: 220, overflow: 'auto', marginTop: 8 } }, props.runStep.content || '暂无已采用产物')) : null,
        h('h4', { style: { marginTop: '14px' } }, '端口'),
        h('div', { className: 'wf-hint' },
          '输入：' + (def.inputs.length === 0 ? '无' : def.inputs.map(port => port.label + (port.optional === true ? '(可选)' : '') + ':' + ((catalog?.typeLabel ?? {})[port.type] ?? port.type)).join('、'))),
        h('div', { className: 'wf-hint' },
          '输出：' + (def.outputs.length === 0 ? '无（终点）' : def.outputs.map(port => port.label + ':' + ((catalog?.typeLabel ?? {})[port.type] ?? port.type)).join('、'))),
        h('button', { type: 'button', className: 'wf-btn', onClick: () => props.toggleNode(node.id) }, node.disabled ? '启用节点' : '停用节点'),
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
  )
}

function planLabel(plan: Plan): string {
  return plan.ok ? '可以执行' : '不可执行'
}

/* ------------------------------------------------------------------ *
 * 嵌入：工作台自己的视图里挂载（研发 → 工作流模板 / 产品 → 流程）
 * ------------------------------------------------------------------ */

/** 画布作用域：productPath 为空表示「还没有归属产品的模板草稿」。 */
export interface CanvasScope {
  productPath?: string
  productId?: string
  createSession?: () => Promise<string>
  sendSession?: (sessionId: string, prompt: string) => Promise<void>
}

/**
 * 把画布挂进一个普通 DOM 容器（app.ts 里的视图宿主容器）。
 * 返回卸载函数；同一个容器重复挂载前必须先调它，否则 React 会报容器已被占用。
 */
export function mountCanvasInto(container: HTMLElement, scope: CanvasScope = {}): () => void {
  ensureCss(container)
  const root = createRoot(container)
  root.render(h(CanvasPanel, scope))
  return () => { try { root.unmount() } catch { /* 容器已被上层移除，忽略 */ } }
}
