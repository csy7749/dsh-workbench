/**
 * 工作流画布 · 存储层（SQLite）
 *
 * 与宿主共用同一个 DatabaseSync 连接，但数据独立成表（wf_graphs），不进主快照：
 * 画布是长文本 + 频繁保存的东西，混进主快照会让「保存任务」变成整份图重写。
 */
import { randomUUID } from 'node:crypto'
import {
  GRAPH_LIMITS, emptyGraph, normalizeGraph, planOf, templateOf, validateGraph,
  DEFAULT_PRODUCT_LINE, PACKS, type GraphIssue, type WorkflowGraph,
} from '../shared/workflow-catalog.ts'

export interface GraphRow {
  id: string
  name: string
  line: string
  /** 产品标识；历史路径值暂保留，空串表示研发草稿。 */
  product_id: string
  revision: number
  created_at: string
  updated_at: string
  nodes: number
  edges: number
  forked_from_template_id?: string | null
  forked_from_revision?: number | null
  pack_id: string
  pack_version: string
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
  '  line TEXT NOT NULL DEFAULT "",',
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wf_templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, line TEXT NOT NULL,
        summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
        source_product_id TEXT NOT NULL, source_graph_id TEXT NOT NULL,
        copied_count INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wf_template_versions (
        id TEXT PRIMARY KEY, template_id TEXT NOT NULL, revision INTEGER NOT NULL,
        graph_json TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(template_id, revision)
      );
    `)
    const columns = this.db.prepare('PRAGMA table_info(wf_graphs)').all().map((row: any) => row.name)
    if (!columns.includes('forked_from_template_id')) this.db.exec("ALTER TABLE wf_graphs ADD COLUMN forked_from_template_id TEXT")
    if (!columns.includes('forked_from_revision')) this.db.exec("ALTER TABLE wf_graphs ADD COLUMN forked_from_revision INTEGER")
    if (!columns.includes('pack_id')) this.db.exec("ALTER TABLE wf_graphs ADD COLUMN pack_id TEXT NOT NULL DEFAULT ''")
    if (!columns.includes('pack_version')) this.db.exec("ALTER TABLE wf_graphs ADD COLUMN pack_version TEXT NOT NULL DEFAULT ''")
    for (const pack of PACKS) this.db.prepare("UPDATE wf_graphs SET pack_id=?,pack_version=? WHERE line=? AND pack_id='' ").run(pack.id, pack.version, pack.id)
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
      line: String(raw.line || DEFAULT_PRODUCT_LINE),
      product_id: String(raw.product_id ?? ''),
      revision: Number(raw.revision ?? 1),
      created_at: String(raw.created_at ?? ''),
      updated_at: String(raw.updated_at ?? ''),
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      forked_from_template_id: raw.forked_from_template_id ?? null,
      forked_from_revision: raw.forked_from_revision ?? null,
      pack_id: String(raw.pack_id ?? ''),
      pack_version: String(raw.pack_version ?? ''),
    }
  }

  private parse(raw: unknown): WorkflowGraph {
    if (typeof raw !== 'string' || raw.trim() === '') return emptyGraph(DEFAULT_PRODUCT_LINE)
    try {
      return normalizeGraph(JSON.parse(raw), DEFAULT_PRODUCT_LINE).graph
    } catch {
      return emptyGraph(DEFAULT_PRODUCT_LINE)
    }
  }

  /** productId 为 undefined 时列出全部（模板库），传空串只列未归属的。 */
  list(productId?: string): GraphRow[] {
    const sql = productId === undefined
      ? 'SELECT * FROM wf_graphs WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200'
      : 'SELECT * FROM wf_graphs WHERE deleted_at IS NULL AND product_id = ? ORDER BY updated_at DESC LIMIT 200'
    const rows = productId === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(productId)
    return (rows as any[]).map(item => this.row(item)).filter((item): item is GraphRow => item !== null)
  }

  get(id: string): { row: GraphRow; graph: WorkflowGraph; issues: GraphIssue[] } | null {
    const raw = this.db.prepare('SELECT * FROM wf_graphs WHERE id = ? AND deleted_at IS NULL').get(id) as any
    if (raw === undefined || raw === null) return null
    const row = this.row(raw)
    if (row === null) return null
    const normalized = raw.graph_json ? normalizeGraph(safeParse(raw.graph_json), String(raw.line || DEFAULT_PRODUCT_LINE)) : { graph: emptyGraph(String(raw.line || DEFAULT_PRODUCT_LINE)), issues: [] as GraphIssue[] }
    return { row, graph: normalized.graph, issues: normalized.issues }
  }

  create(input: SaveInput): SaveResult {
    if (input.graph !== undefined && Buffer.byteLength(JSON.stringify(input.graph)) > GRAPH_LIMITS.bytes) return { ok: false, error: '画布超过字节上限' }
    const graph = input.graph === undefined ? emptyGraph(input.line || DEFAULT_PRODUCT_LINE, input.name) : normalizeGraph(input.graph, input.line || DEFAULT_PRODUCT_LINE).graph
    const issues = input.graph === undefined ? [] : normalizeGraph(input.graph, input.line || DEFAULT_PRODUCT_LINE).issues
    if (issues.some(issue => ['nodes_truncated', 'edges_truncated', 'edge_dangling', 'node_id_fixed'].includes(issue.code))) return { ok: false, error: '画布包含无法安全保存的数据：' + issues.map(issue => issue.message).join('；') }
    if (input.name !== undefined && input.name.trim() !== '') graph.name = input.name.trim().slice(0, 120)
    const bytes = Buffer.byteLength(JSON.stringify(graph))
    if (bytes > GRAPH_LIMITS.bytes) return { ok: false, error: '画布太大（' + bytes + ' 字节，上限 ' + GRAPH_LIMITS.bytes + '）' }
    const id = 'wf-' + randomUUID().slice(0, 8)
    const stamp = now()
    this.db.prepare('INSERT INTO wf_graphs (id, name, line, product_id, graph_json, revision, created_at, updated_at, pack_id, pack_version) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
      .run(id, graph.name, graph.line, String(input.productId ?? ''), JSON.stringify(graph), stamp, stamp, graph.line, PACKS.find(pack => pack.id === graph.line)?.version ?? '')
    const saved = this.get(id)
    return { ok: true, row: saved?.row, graph, issues }
  }

  /** 保存：baseRevision 不匹配就返回冲突，让前端自己决定是覆盖还是重载。 */
  save(id: string, input: SaveInput): SaveResult {
    const current = this.db.prepare('SELECT revision,line,pack_id,pack_version FROM wf_graphs WHERE id = ? AND deleted_at IS NULL').get(id) as any
    if (current === undefined || current === null) return { ok: false, error: '画布不存在' }
    const revision = Number(current.revision ?? 1)
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision !== revision) {
      return { ok: false, conflict: true, error: '画布已被改动（库里是第 ' + revision + ' 版），重载后再存。' }
    }
    const fallbackLine = String((this.db.prepare('SELECT line FROM wf_graphs WHERE id = ?').get(id) as any)?.line || DEFAULT_PRODUCT_LINE)
    if (input.graph !== undefined && Buffer.byteLength(JSON.stringify(input.graph)) > GRAPH_LIMITS.bytes) return { ok: false, error: '画布超过字节上限' }
    const normalized = input.graph === undefined ? null : normalizeGraph(input.graph, fallbackLine as any)
    if (normalized?.issues.some(issue => ['nodes_truncated', 'edges_truncated', 'edge_dangling', 'node_id_fixed'].includes(issue.code))) return { ok: false, error: '画布包含无法安全保存的数据：' + normalized.issues.map(issue => issue.message).join('；') }
    const graph = normalized === null ? this.parse((this.db.prepare('SELECT graph_json FROM wf_graphs WHERE id = ?').get(id) as any)?.graph_json) : normalized.graph
    if (input.name !== undefined && input.name.trim() !== '') graph.name = input.name.trim().slice(0, 120)
    if (input.line !== undefined && input.graph === undefined) graph.line = normalized?.graph.line ?? graph.line
    const bytes = Buffer.byteLength(JSON.stringify(graph))
    if (bytes > GRAPH_LIMITS.bytes) return { ok: false, error: '画布太大（' + bytes + ' 字节，上限 ' + GRAPH_LIMITS.bytes + '）' }
    const pack = PACKS.find(item => item.id === graph.line)
    const packId = pack?.id ?? (current.line === graph.line ? current.pack_id : graph.line)
    const packVersion = pack?.version ?? (current.line === graph.line ? current.pack_version : '')
    const changed = this.db.prepare('UPDATE wf_graphs SET name = ?, line = ?, graph_json = ?, revision = revision + 1, updated_at = ?, pack_id=?, pack_version=? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
      .run(graph.name, graph.line, JSON.stringify(graph), now(), packId, packVersion, id, revision)
    if (Number(changed.changes) !== 1) return { ok: false, conflict: true, error: '画布已被改动，请重新打开后处理冲突。' }
    const saved = this.get(id)
    return { ok: true, row: saved?.row, graph, issues: normalized?.issues ?? [] }
  }

  remove(id: string): boolean {
    const info = this.db.prepare('UPDATE wf_graphs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id)
    return Number(info?.changes ?? 0) > 0
  }

  /** 从模板新建：模板本身只读，落库时给一份独立副本。 */
  createFromTemplate(templateId: string, productId?: string): SaveResult {
    const custom = this.db.prepare('SELECT * FROM wf_templates WHERE id=?').get(templateId)
    if (custom) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const snapshot = this.db.prepare('SELECT graph_json FROM wf_template_versions WHERE template_id=? AND revision=?').get(templateId, custom.revision)
        const result = this.create({ graph: JSON.parse(snapshot.graph_json), productId })
        if (!result.ok || !result.row) throw new Error(result.error ?? 'copy_failed')
        this.db.prepare('UPDATE wf_graphs SET forked_from_template_id=?, forked_from_revision=? WHERE id=?').run(templateId, custom.revision, result.row.id)
        this.db.prepare('UPDATE wf_templates SET copied_count=copied_count+1 WHERE id=?').run(templateId)
        this.db.exec('COMMIT')
        result.row = this.get(result.row.id)?.row
        return result
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    const graph = templateOf(templateId)
    if (graph === null) return { ok: false, error: '没有这个模板：' + templateId }
    const result = this.create({ graph, name: graph.name, productId })
    if (result.ok && result.row) {
      this.db.prepare('UPDATE wf_graphs SET forked_from_template_id=?, forked_from_revision=1 WHERE id=?').run(templateId, result.row.id)
      result.row = this.get(result.row.id)?.row
    }
    return result
  }

  listTemplates(): any[] {
    return this.db.prepare("SELECT t.*, v.graph_json FROM wf_templates t JOIN wf_template_versions v ON v.template_id=t.id AND v.revision=t.revision WHERE t.status != 'archived' ORDER BY t.updated_at DESC").all().map((row: any) => ({ ...row, steps: this.parse(row.graph_json).nodes.length, graph_json: undefined }))
  }

  template(id: string): any {
    const builtin = templateOf(id)
    if (builtin) return { id, revision: 1, graph: builtin }
    const row = this.db.prepare('SELECT t.*,v.graph_json FROM wf_templates t JOIN wf_template_versions v ON v.template_id=t.id AND v.revision=t.revision WHERE t.id=?').get(id)
    if (!row) return null
    return { ...row, graph: this.parse(row.graph_json), graph_json: undefined }
  }

  templateVersions(id: string): any[] {
    if (templateOf(id)) return [{ revision: 1 }]
    return this.db.prepare('SELECT revision,note,created_at FROM wf_template_versions WHERE template_id=? ORDER BY revision DESC').all(id)
  }

  templatePreview(id: string): { graph: WorkflowGraph; fields: { nodeId: string; key: string; value: unknown }[] } {
    const found = this.get(id)
    if (!found) throw new Error('graph_not_found')
    const fields: { nodeId: string; key: string; value: unknown }[] = []
    for (const node of found.graph.nodes) {
      const key = ({ 'input.brief': 'text', 'input.doc': 'path', 'output.publish': 'dir' } as Record<string, string>)[node.type]
      if (key && node.config[key] !== undefined && node.config[key] !== '') fields.push({ nodeId: node.id, key, value: node.config[key] })
    }
    return { graph: found.graph, fields }
  }

  saveTemplate(id: string, name: string, summary = '', keep: string[] = []): any {
    if (!name?.trim()) throw new Error('template_name_required')
    const found = this.get(id)
    if (!found) throw new Error('graph_not_found')
    const preview = this.templatePreview(id)
    for (const field of preview.fields) {
      if (!keep.includes(field.nodeId + '.' + field.key)) preview.graph.nodes.find(node => node.id === field.nodeId)!.config[field.key] = ''
    }
    preview.graph.name = name.trim().slice(0, 120)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT * FROM wf_templates WHERE name=?').get(preview.graph.name)
      if (previous && previous.status !== 'draft') throw new Error('template_read_only')
      const templateId = previous?.id ?? 'wft-' + randomUUID()
      const revision = (previous?.revision ?? 0) + 1
      const stamp = now()
      if (previous) this.db.prepare('UPDATE wf_templates SET revision=?, summary=?, updated_at=? WHERE id=?').run(revision, summary, stamp, templateId)
      else this.db.prepare('INSERT INTO wf_templates(id,name,line,summary,source_product_id,source_graph_id,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(templateId, preview.graph.name, preview.graph.line, summary, found.row.product_id, id, revision, stamp, stamp)
      this.db.prepare('INSERT INTO wf_template_versions VALUES(?,?,?,?,?,?)').run(randomUUID(), templateId, revision, JSON.stringify(preview.graph), summary, stamp)
      this.db.exec('COMMIT')
      return { id: templateId, revision, graph: preview.graph }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
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
