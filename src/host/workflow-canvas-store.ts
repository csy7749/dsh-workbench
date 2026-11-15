/**
 * 工作流画布 · 存储层（SQLite）
 *
 * 与宿主共用同一个 DatabaseSync 连接，但数据独立成表（wf_graphs），不进主快照：
 * 画布是长文本 + 频繁保存的东西，混进主快照会让「保存任务」变成整份图重写。
 */
import { randomUUID } from 'node:crypto'
import {
  GRAPH_LIMITS, emptyGraph, normalizeGraph, planOf, templateOf, validateGraph,
  type GraphIssue, type WorkflowGraph,
} from '../shared/workflow-canvas-model.js'

export interface GraphRow {
  id: string
  name: string
  line: string
  /** 归属产品的 DSH 工作区路径；空串=还没挂到具体产品（模板库里造出来的草稿）。 */
  product_id: string
  revision: number
  created_at: string
  updated_at: string
  nodes: number
  edges: number
}

function now(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

const SCHEMA = [
  'PRAGMA busy_timeout = 5000;',
  'CREATE TABLE IF NOT EXISTS wf_graphs (',
  '  id TEXT PRIMARY KEY,',
  '  name TEXT NOT NULL DEFAULT "",',
  '  line TEXT NOT NULL DEFAULT "game",',
  "  product_id TEXT NOT NULL DEFAULT '',",
  '  graph_json TEXT NOT NULL DEFAULT "",',
  "  revision INTEGER NOT NULL DEFAULT 1,",
  '  created_at TEXT NOT NULL,',
  '  updated_at TEXT NOT NULL,',
  '  deleted_at TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_wf_graphs_updated ON wf_graphs(deleted_at, updated_at DESC);',
].join('\n')

export interface SaveInput {
  id?: string
  name?: string
  line?: string
  productId?: string
  graph?: unknown
  /** 乐观锁：传了就必须与库里改前的 revision 相同，否则冲突 */
  baseRevision?: number
}

export interface SaveResult {
  ok: boolean
  conflict?: boolean
  row?: GraphRow
  graph?: WorkflowGraph
  issues?: GraphIssue[]
  error?: string
}

export class WorkflowCanvasStore {
  private db: any

  constructor(db: any) {
    this.db = db
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** 老库补列：wf_graphs 早先没有 product_id，直接建新表会让已有画布全丢。 */
  private migrate(): void {
    const columns = (this.db.prepare('PRAGMA table_info(wf_graphs)').all() as any[]).map(item => String(item.name))
    if (!columns.includes('product_id')) {
      this.db.exec("ALTER TABLE wf_graphs ADD COLUMN product_id TEXT NOT NULL DEFAULT ''")
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_wf_graphs_product ON wf_graphs(product_id, deleted_at, updated_at DESC)")
  }

  private row(raw: any): GraphRow | null {
    if (raw === undefined || raw === null) return null
    const graph = this.parse(raw.graph_json)
    return {
      id: String(raw.id),
      name: String(raw.name ?? ''),
      line: String(raw.line ?? 'game'),
      product_id: String(raw.product_id ?? ''),
      revision: Number(raw.revision ?? 1),
      created_at: String(raw.created_at ?? ''),
      updated_at: String(raw.updated_at ?? ''),
      nodes: graph.nodes.length,
      edges: graph.edges.length,
    }
  }

  private parse(raw: unknown): WorkflowGraph {
    if (typeof raw !== 'string' || raw.trim() === '') return emptyGraph('game')
    try {
      return normalizeGraph(JSON.parse(raw), 'game').graph
    } catch {
      return emptyGraph('game')
    }
  }

  /** productId 为 undefined 时列出全部（模板库），传空串只列未归属的。 */
  list(productId?: string): GraphRow[] {
    const sql = productId === undefined
      ? 'SELECT id, name, line, product_id, graph_json, revision, created_at, updated_at FROM wf_graphs WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200'
      : 'SELECT id, name, line, product_id, graph_json, revision, created_at, updated_at FROM wf_graphs WHERE deleted_at IS NULL AND product_id = ? ORDER BY updated_at DESC LIMIT 200'
    const rows = productId === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(productId)
    return (rows as any[]).map(item => this.row(item)).filter((item): item is GraphRow => item !== null)
  }

  get(id: string): { row: GraphRow; graph: WorkflowGraph; issues: GraphIssue[] } | null {
    const raw = this.db.prepare('SELECT * FROM wf_graphs WHERE id = ? AND deleted_at IS NULL').get(id) as any
    if (raw === undefined || raw === null) return null
    const row = this.row(raw)
    if (row === null) return null
    const normalized = raw.graph_json ? normalizeGraph(safeParse(raw.graph_json), String(raw.line ?? 'game')) : { graph: emptyGraph(String(raw.line ?? 'game')), issues: [] as GraphIssue[] }
    return { row, graph: normalized.graph, issues: normalized.issues }
  }

  create(input: SaveInput): SaveResult {
    const graph = input.graph === undefined ? emptyGraph((input.line as any) ?? 'game', input.name) : normalizeGraph(input.graph, (input.line as any) ?? 'game').graph
    const issues = input.graph === undefined ? [] : normalizeGraph(input.graph, (input.line as any) ?? 'game').issues
    if (input.name !== undefined && input.name.trim() !== '') graph.name = input.name.trim().slice(0, 120)
    const bytes = JSON.stringify(graph).length
    if (bytes > GRAPH_LIMITS.bytes) return { ok: false, error: '画布太大（' + bytes + ' 字节，上限 ' + GRAPH_LIMITS.bytes + '）' }
    const id = 'wf-' + randomUUID().slice(0, 8)
    const stamp = now()
    this.db.prepare('INSERT INTO wf_graphs (id, name, line, product_id, graph_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, graph.name, graph.line, String(input.productId ?? ''), JSON.stringify(graph), stamp, stamp)
    const saved = this.get(id)
    return { ok: true, row: saved?.row, graph, issues }
  }

  /** 保存：baseRevision 不匹配就返回冲突，让前端自己决定是覆盖还是重载。 */
  save(id: string, input: SaveInput): SaveResult {
    const current = this.db.prepare('SELECT revision FROM wf_graphs WHERE id = ? AND deleted_at IS NULL').get(id) as any
    if (current === undefined || current === null) return { ok: false, error: '画布不存在' }
    const revision = Number(current.revision ?? 1)
    if (typeof input.baseRevision === 'number' && input.baseRevision !== revision) {
      return { ok: false, conflict: true, error: '画布已被改动（库里是第 ' + revision + ' 版），重载后再存。' }
    }
    const fallbackLine = String((this.db.prepare('SELECT line FROM wf_graphs WHERE id = ?').get(id) as any)?.line ?? 'game')
    const normalized = input.graph === undefined ? null : normalizeGraph(input.graph, fallbackLine as any)
    const graph = normalized === null ? this.parse((this.db.prepare('SELECT graph_json FROM wf_graphs WHERE id = ?').get(id) as any)?.graph_json) : normalized.graph
    if (input.name !== undefined && input.name.trim() !== '') graph.name = input.name.trim().slice(0, 120)
    if (input.line !== undefined && input.graph === undefined) graph.line = normalized?.graph.line ?? graph.line
    const bytes = JSON.stringify(graph).length
    if (bytes > GRAPH_LIMITS.bytes) return { ok: false, error: '画布太大（' + bytes + ' 字节，上限 ' + GRAPH_LIMITS.bytes + '）' }
    this.db.prepare('UPDATE wf_graphs SET name = ?, line = ?, graph_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(graph.name, graph.line, JSON.stringify(graph), now(), id)
    const saved = this.get(id)
    return { ok: true, row: saved?.row, graph, issues: normalized?.issues ?? [] }
  }

  remove(id: string): boolean {
    const info = this.db.prepare('UPDATE wf_graphs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id)
    return Number(info?.changes ?? 0) > 0
  }

  /** 从模板新建：模板本身只读，落库时给一份独立副本。 */
  createFromTemplate(templateId: string, productId?: string): SaveResult {
    const graph = templateOf(templateId)
    if (graph === null) return { ok: false, error: '没有这个模板：' + templateId }
    return this.create({ graph, name: graph.name, productId })
  }

  plan(id: string): { ok: boolean; plan?: ReturnType<typeof planOf>; issues?: GraphIssue[]; error?: string } {
    const found = this.get(id)
    if (found === null) return { ok: false, error: '画布不存在' }
    return { ok: true, plan: planOf(found.graph), issues: found.issues }
  }

  validate(id: string): { ok: boolean; issues?: GraphIssue[]; error?: string } {
    const found = this.get(id)
    if (found === null) return { ok: false, error: '画布不存在' }
    return { ok: true, issues: validateGraph(found.graph) }
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
