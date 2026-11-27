export interface ProductImageCandidate {
  id: string
  formatVersion?: 1 | 2
  createdAt: string
  mode: 'generate' | 'edit' | 'import' | 'process' | 'render'
  prompt: string
  provider?: string
  channel?: string
  model?: string
  width?: number
  height?: number
  mime?: string
  bytes?: number
  sha256?: string
  selected?: boolean
  sourceCandidateId?: string
  operationId?: string
  metadata?: {
    tags: string[]
    notes: string
    checks?: ProductImageCheck[]
  }
}

export interface ProductImageCheck {
  sha256: string
  status: string
  hasAlpha?: boolean
  hasTransparentPixels?: boolean
  width?: number
  height?: number
  visualStatus?: string
}

export interface ProductImageJob {
  id: string
  status: 'running' | 'succeeded' | 'failed' | 'unknown'
  error?: string
  candidateId?: string
  createdAt?: string
}

export interface ProductImagesDeps {
  apiBase: string
  product: { id: string; name: string; workspacePath?: string }
  ensureStyles?: (css: string) => void
  openSession?: () => void
}

export interface ProductImagesViewHandle {
  mount(): void
  render(): void
  reload(): Promise<void>
  destroy(): void
  isMounted(): boolean
}

const CSS = `
.pi-root{--ud-accent:#5b5bd6;--ud-accent-ink:#4a4ac2;--ud-panel:var(--panel,#fff);--ud-panel-2:var(--panel-2,#fafafb);--ud-panel-3:var(--panel-3,#f6f6f8);--ud-line:var(--line,#e7e7eb);--ud-text:var(--text,#1a1a1f);--ud-text-2:var(--text-2,#656570);--ud-text-3:var(--text-3,#9797a2);--ud-amber:var(--amber,#c27c0e);color:var(--ud-text)}
.pi-root .ud-view{display:flex;flex-direction:column;gap:12px;padding:14px 16px 28px}
.pi-root .ud-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
.pi-root .ud-head h2{margin:0;font-size:17px;letter-spacing:-.3px}
.pi-root .ud-head .sub{margin:2px 0 0;font-size:11px;color:var(--ud-text-3)}
.pi-root .ud-actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.pi-root .ud-panel{background:var(--ud-panel);border:1px solid var(--ud-line);border-radius:var(--radius,12px);overflow:hidden}
.pi-root .ud-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid var(--ud-line);font-size:12px;cursor:pointer}
.pi-root .ud-panel-body{padding:12px}
.pi-root .ud-empty{border:1px dashed var(--ud-line);border-radius:10px;padding:22px;text-align:center;color:var(--ud-text-3);font-size:11.5px}
.pi-root .ud-sel{height:30px;padding:0 8px;border:1px solid var(--ud-line);border-radius:7px;background:var(--ud-panel);color:var(--ud-text-2);font:11px var(--font,sans-serif)}
.pi-root .ud-btn{display:inline-flex;align-items:center;gap:4px;min-height:28px;box-sizing:border-box;padding:3px 10px;border-radius:7px;border:1px solid var(--ud-line);background:var(--ud-panel);color:var(--ud-text-2);font-size:11px;font-weight:500;cursor:pointer}
.pi-root .ud-btn:hover{background:var(--hover,#f2f2f5);color:var(--ud-text)}
.pi-root .ud-btn.primary{background:var(--ud-accent);border-color:var(--ud-accent);color:#fff}
.pi-root [hidden]{display:none!important}
.pi-root .pi-form{display:flex;flex-direction:column;gap:10px}
.pi-root .pi-field{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--ud-text-2)}
.pi-root textarea{box-sizing:border-box;width:100%;resize:vertical;min-height:94px;padding:9px;border:1px solid var(--ud-line);border-radius:7px;background:var(--ud-panel);color:var(--ud-text);font:12px var(--font,sans-serif);line-height:1.6}
.pi-root .pi-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pi-root .pi-copy{margin:0;font-size:11px;line-height:1.65;color:var(--ud-text-2);overflow-wrap:anywhere;white-space:pre-wrap}
.pi-root .pi-notice{padding:9px 11px;border:1px solid var(--ud-line);border-radius:7px;background:var(--ud-panel-2)}
.pi-root .pi-warning{color:var(--ud-amber)}
.pi-root .pi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:10px}
.pi-root .pi-card{min-width:0;border:1px solid var(--ud-line);border-radius:9px;overflow:hidden;background:var(--ud-panel)}
.pi-root .pi-card[data-selected="true"]{border-color:var(--ud-accent)}
.pi-root .pi-preview{display:block;width:100%;height:180px;object-fit:contain;background:var(--ud-panel-3)}
.pi-root .pi-card-body{padding:10px;display:flex;flex-direction:column;gap:7px}
.pi-root .pi-prompt>summary{cursor:pointer}
.pi-root .pi-meta{font-size:10px;line-height:1.6;color:var(--ud-text-3);overflow-wrap:anywhere}
.pi-root .pi-job{padding:9px 0;border-bottom:1px solid var(--ud-line)}
.pi-root .pi-job:last-child{border-bottom:0}
.pi-root button:disabled{opacity:.5;cursor:not-allowed}
.pi-root .pi-confirm{font-size:11px;line-height:1.6;color:var(--ud-text-2)}
.pi-root a.ud-btn{text-decoration:none}
.pi-root .pi-import{display:flex;flex-direction:column;gap:8px;padding:12px}
.pi-root .pi-import input[type=file]{max-width:100%;font-size:11px;color:var(--ud-text-2)}
.pi-root .pi-input{box-sizing:border-box;width:100%;height:30px;padding:5px 8px;border:1px solid var(--ud-line);border-radius:7px;background:var(--ud-panel);color:var(--ud-text);font:11px var(--font,sans-serif)}
.pi-root .pi-notes{min-height:64px;font-size:11px}
.pi-root .pi-compare-tools{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--ud-line)}
.pi-root .pi-compare-grid{display:grid;grid-template-columns:repeat(var(--pi-compare-columns,2),minmax(0,1fr));gap:10px;padding:12px}
.pi-root .pi-compare-item{min-width:0;margin:0;display:flex;flex-direction:column;gap:7px}
.pi-root .pi-compare-viewport{overflow:auto;height:300px;border:1px solid var(--ud-line);border-radius:6px;background:var(--ud-panel-3)}
.pi-root .pi-compare-image{display:block;max-width:none;height:auto}
.pi-root.pi-checkerboard .pi-preview,.pi-root.pi-checkerboard .pi-compare-viewport{background-color:#eee;background-image:conic-gradient(#cfcfd3 25%,transparent 0 50%,#cfcfd3 0 75%,transparent 0);background-size:16px 16px}
.pi-root .pi-compare-empty{padding:12px}
.pi-root [data-image-action="compare"][aria-pressed="true"]{border-color:var(--ud-accent);color:var(--ud-accent-ink)}
.pi-root .pi-warning-list{margin:0;padding-left:18px;font-size:11px;line-height:1.6;color:var(--ud-amber)}
@media(max-width:760px){.pi-root .pi-compare-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pi-root .pi-compare-viewport{height:230px}}
`

const statusText: Record<ProductImageJob['status'], string> = {
  running: '生成中', succeeded: '已完成', failed: '失败', unknown: '结果未知',
}

const sourceText: Record<ProductImageCandidate['mode'], string> = {
  generate: '插件生成', edit: '插件编辑', import: '本地导入', process: '本地加工', render: '本地渲染',
}

const unavailableReasons: Record<string, string> = {
  image_native_executor_required: '请切换为 DSH 原生工具执行器后使用图片生成。',
  image_provider_unavailable: '请安装并启用 dsh-image-gen 图片插件。',
  image_runtime_unavailable: '当前宿主缺少正式工具执行或附件服务，请检查宿主版本与配置。',
  image_provider_tools_incompatible: '未检测到兼容的 dsh-image-gen 生成／编辑工具，请确认插件已启用并重启 DSH。',
  image_tools_unavailable: '当前宿主没有提供正式工具执行服务，请检查 DSH 版本与插件状态。',
  image_attachments_unavailable: '当前宿主没有提供附件服务，暂时无法读取并保存生成图片。',
  image_executor_status_unavailable: '暂时无法读取工具执行器状态，请检查 DSH 连接后刷新。',
  image_executor_unavailable: '图片工具执行器不可用，请启用 DSH 原生工具执行器后刷新。',
  image_edit_session_unavailable: '当前宿主无法创建图片编辑会话，请检查会话服务后刷新。',
}

type ImageApiError = Error & { job?: ProductImageJob; httpStatus?: number }

/** Product images are independent of game projects and workflow runs. */
export function createProductImagesView(host: HTMLElement, deps: ProductImagesDeps): ProductImagesViewHandle {
  // Capture the identity: a late response may never be redirected to a new product.
  const product = { ...deps.product }
  const apiBase = deps.apiBase.replace(/\/$/, '') + '/product-images'
  let root: HTMLElement | null = null
  let mounted = false
  let generation = 0
  let readSequence = 0
  let loading = false
  let submitting = false
  let importing = false
  let selecting = ''
  let available = false
  let reason = ''
  let notice = ''
  let prompt = ''
  let mode: 'generate' | 'edit' = 'generate'
  let referenceId = ''
  let confirmed = false
  let candidates: ProductImageCandidate[] = []
  let gallerySignature: string | null = null
  let jobs: ProductImageJob[] = []
  let operations: ProductImageJob[] = []
  let warnings: string[] = []
  let compareKeys: string[] = []
  let compareSignature: string | null = null
  let zoom = 1
  let checkerboard = true
  const metadataDrafts = new Map<string, { tags: string; notes: string }>()
  const metadataBusy = new Set<string>()
  const checkBusy = new Set<string>()
  const draftKey = 'dsh-product-image-draft:' + JSON.stringify([product.id, product.workspacePath ?? ''])
  const confirmationKey = 'dsh-product-image-confirmed:' + JSON.stringify([product.id, product.workspacePath ?? ''])
  const uncertain = new Map<string, ProductImageJob>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const requests = new Set<AbortController>()
  let status: HTMLElement, noticeNode: HTMLElement, gallery: HTMLElement, jobList: HTMLElement, warningList: HTMLElement
  let importInput: HTMLInputElement, importSubmit: HTMLButtonElement
  let comparePanel: HTMLElement, compareGrid: HTMLElement, compareEmpty: HTMLElement, compareCount: HTMLElement
  let zoomInput: HTMLSelectElement, checkerInput: HTMLInputElement
  let promptInput: HTMLTextAreaElement, modeInput: HTMLSelectElement, referenceInput: HTMLSelectElement
  let referenceField: HTMLElement, confirmInput: HTMLInputElement, submit: HTMLButtonElement, refresh: HTMLButtonElement

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function button(text: string, action: () => void, primary = false): HTMLButtonElement {
    const node = element('button', 'ud-btn' + (primary ? ' primary' : ''), text)
    node.type = 'button'
    node.onclick = action
    return node
  }

  const versionOf = (candidate: ProductImageCandidate): 1 | 2 => candidate.formatVersion === 2 ? 2 : 1
  const keyOf = (candidate: ProductImageCandidate): string => `${versionOf(candidate)}:${candidate.id}`
  const reference = (candidate: ProductImageCandidate): { candidateId: string; formatVersion?: 2 } => ({ candidateId: candidate.id, ...(versionOf(candidate) === 2 ? { formatVersion: 2 as const } : {}) })

  function imageUrl(candidate: ProductImageCandidate, download = false): string {
    const query = new URLSearchParams({ productId: product.id, candidateId: candidate.id })
    if (versionOf(candidate) === 2) query.set('formatVersion', '2')
    if (download) query.set('download', '1')
    return `${apiBase}/${download ? 'image' : 'preview'}?${query}`
  }

  function saveDraft(): void {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ prompt, mode, referenceId, compareKeys, zoom, checkerboard, metadata: [...metadataDrafts].slice(0, 200) }))
    } catch { /* Storage may be disabled; the mounted view still retains its draft. */ }
  }

  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null')
    if (saved && typeof saved === 'object') {
      if (typeof saved.prompt === 'string' && saved.prompt.length <= 12000) prompt = saved.prompt
      if (saved.mode === 'edit') mode = 'edit'
      if (typeof saved.referenceId === 'string' && saved.referenceId.length <= 200) referenceId = saved.referenceId
      if (Array.isArray(saved.compareKeys)) compareKeys = saved.compareKeys.filter((key: unknown): key is string => typeof key === 'string' && key.length <= 220).slice(0, 4)
      if ([0.25, 0.5, 1, 2].includes(saved.zoom)) zoom = saved.zoom
      if (typeof saved.checkerboard === 'boolean') checkerboard = saved.checkerboard
      if (Array.isArray(saved.metadata)) for (const item of saved.metadata.slice(0, 200)) {
        if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1]?.tags === 'string' && item[1].tags.length <= 8000 && typeof item[1]?.notes === 'string' && item[1].notes.length <= 4000) metadataDrafts.set(item[0], { tags: item[1].tags, notes: item[1].notes })
      }
    }
  } catch { /* Invalid or unavailable session drafts do not prevent local image use. */ }

  try {
    confirmed = localStorage.getItem(confirmationKey) === 'true'
  } catch { /* Storage may be disabled; quota consent still works in the mounted view. */ }

  const active = (epoch: number): boolean => mounted && generation === epoch && root !== null && host.contains(root)

  async function api(path: string, body?: object): Promise<any> {
    const controller = new AbortController()
    requests.add(controller)
    try {
      const response = await fetch(apiBase + path, {
        signal: controller.signal,
        ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) {
        const error = new Error(String(data.error ?? data.message ?? `HTTP ${response.status}`)) as ImageApiError
        error.job = data.job
        error.httpStatus = response.status
        throw error
      }
      return data
    } finally { requests.delete(controller) }
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (mounted && jobs.some(job => job.status === 'running')) timer = setTimeout(() => { void reload() }, 2500)
  }

  async function reload(): Promise<void> {
    if (!mounted) return
    const epoch = generation, sequence = ++readSequence
    loading = true
    render()
    try {
      const data = await api('/state?' + new URLSearchParams({ productId: product.id }))
      if (!active(epoch) || sequence !== readSequence) return
      available = data.available === true
      reason = unavailableReasons[String(data.reason ?? '')] ?? String(data.reason ?? '')
      candidates = Array.isArray(data.candidates) ? data.candidates : []
      jobs = Array.isArray(data.jobs) ? data.jobs : []
      operations = Array.isArray(data.operations) ? data.operations : []
      warnings = Array.isArray(data.warnings) ? data.warnings.filter((value: unknown): value is string => typeof value === 'string').slice(0, 50) : []
      for (const job of jobs) uncertain.delete(job.id)
      jobs = [...jobs, ...uncertain.values()]
      if (referenceId && !candidates.some(candidate => candidate.id === referenceId && versionOf(candidate) === 1)) referenceId = ''
      compareKeys = compareKeys.filter(key => candidates.some(candidate => keyOf(candidate) === key)).slice(0, 4)
    } catch (error) {
      if (!active(epoch) || sequence !== readSequence) return
      notice = '读取图片素材失败：' + String((error as Error).message ?? error)
      // Stop polling on transport failure; the refresh action only reads state.
      return
    } finally {
      if (active(epoch) && sequence === readSequence) { loading = false; render() }
    }
    if (active(epoch)) schedule()
  }

  async function generate(): Promise<void> {
    if (submitting || !available || !prompt.trim() || !confirmed || (mode === 'edit' && !referenceId)) return
    const epoch = generation
    const requestId = crypto.randomUUID()
    const body = { productId: product.id, requestId, prompt: prompt.trim(), mode, ...(mode === 'edit' ? { referenceId } : {}), confirmed: true }
    submitting = true
    notice = '请求已提交。生成可能消耗所选渠道额度，请等待任务结果。'
    jobs = [{ id: requestId, status: 'running', createdAt: new Date().toISOString() }, ...jobs]
    render()
    schedule()
    try {
      const data = await api('/generate', body)
      if (!active(epoch)) return
      if (data.job) jobs = [data.job, ...jobs.filter(job => job.id !== data.job.id)]
      if (data.candidate) candidates = [data.candidate, ...candidates.filter(candidate => keyOf(candidate) !== keyOf(data.candidate))]
      notice = data.job?.status === 'failed' ? '生成失败：' + String(data.job.error ?? '请查看任务记录。')
        : data.job?.status === 'unknown' ? '任务结果未知。请先刷新状态并核对生成渠道记录；此处不会自动重试。'
          : data.candidate ? '图片已保存为本产品候选，可预览、采用或下载。' : '任务已登记，可在下方查看状态。'
    } catch (cause) {
      if (!active(epoch)) return
      const error = cause as ImageApiError
      const refused = [400, 403, 404, 409, 503].includes(error.httpStatus ?? 0)
      const job: ProductImageJob = error.job
        ? { ...error.job, ...(refused ? { status: 'failed' as const } : {}) }
        : { id: requestId, status: refused ? 'failed' : 'unknown', createdAt: new Date().toISOString(), error: String(error.message ?? error) }
      if (!error.job && job.status === 'unknown') uncertain.set(requestId, job)
      jobs = [job, ...jobs.filter(item => item.id !== job.id)]
      notice = job.status === 'failed'
        ? '生成失败：' + String(job.error ?? error.message)
        : '未取得确定的生成结果：' + String(job.error ?? error.message) + '。请刷新状态并核对渠道记录后再决定是否发起新请求；不会自动重试。'
    } finally {
      if (active(epoch)) { submitting = false; render(); schedule() }
    }
  }

  async function select(candidate: ProductImageCandidate): Promise<void> {
    if (selecting) return
    const epoch = generation
    selecting = candidate.id
    render()
    try {
      await api('/select', { productId: product.id, ...reference(candidate), selected: !candidate.selected })
      if (!active(epoch)) return
      notice = candidate.selected ? '已取消采用此图片。' : '已采用为本产品图片素材；使用位置由后续操作指定。'
      await reload()
    } catch (error) {
      if (active(epoch)) notice = '更新采用状态失败：' + String((error as Error).message ?? error)
    } finally { if (active(epoch)) { selecting = ''; render() } }
  }

  function selectImport(): void {
    if (importing || importInput.disabled) return
    importInput.click()
  }

  async function importFile(): Promise<void> {
    const file = importInput.files?.[0]
    if (!file || importing) return
    const epoch = generation
    if (file.size < 1 || file.size > 20 * 1024 * 1024) {
      notice = '文件大小必须在 1 字节至 20 MiB 之间。'
      importInput.value = ''
      render()
      return
    }
    const extension = file.name.toLowerCase().split('.').at(-1)
    const mime = file.type || (extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : '')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
      notice = '只支持 PNG、JPEG 或 WebP 静态图片；GIF、APNG、SVG 与未知类型不会导入。'
      importInput.value = ''
      render()
      return
    }
    importing = true
    notice = '正在导入并核验静态图片…'
    render()
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('读取所选图片失败。'))
        reader.onabort = () => reject(new Error('读取所选图片已取消。'))
        reader.onload = () => {
          if (typeof reader.result !== 'string') return reject(new Error('读取所选图片失败。'))
          const comma = reader.result.indexOf(',')
          if (comma < 0 || reader.result.length > Math.ceil(file.size * 4 / 3) + 4096) return reject(new Error('图片数据格式无效或超出上限。'))
          resolve(reader.result.slice(comma + 1))
        }
        reader.readAsDataURL(file)
      })
      if (!active(epoch)) return
      const value = await api('/import', { productId: product.id, requestId: crypto.randomUUID(), fileName: file.name, mime, dataBase64: data })
      if (!active(epoch)) return
      const candidate = value.candidate as ProductImageCandidate | undefined
      if (candidate) candidates = [candidate, ...candidates.filter(item => keyOf(item) !== keyOf(candidate))]
      if (value.operation) operations = [value.operation, ...operations.filter(item => item.id !== value.operation.id)]
      notice = candidate ? '静态图片已作为独立候选导入；原图字节已保留。' : '导入任务已登记，可刷新查看结果。'
      importInput.value = ''
      render()
    } catch (cause) {
      if (active(epoch)) notice = '导入失败：' + String((cause as Error).message ?? cause)
    } finally {
      if (active(epoch)) { importing = false; importInput.value = ''; render() }
    }
  }

  function draftFor(candidate: ProductImageCandidate): { tags: string; notes: string } {
    const key = keyOf(candidate)
    const current = metadataDrafts.get(key)
    if (current) return current
    const metadata = candidate.metadata
    const value = { tags: Array.isArray(metadata?.tags) ? metadata.tags.join(', ') : '', notes: typeof metadata?.notes === 'string' ? metadata.notes : '' }
    metadataDrafts.set(key, value)
    return value
  }

  async function updateMetadata(candidate: ProductImageCandidate): Promise<void> {
    const key = keyOf(candidate)
    if (versionOf(candidate) !== 2 || metadataBusy.has(key)) return
    const value = { ...draftFor(candidate) }
    const controls = Array.from(root?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[name]') ?? [])
    const tagsInput = controls.find(control => control.name === `image-tags-${candidate.id}`)
    const notesInput = controls.find(control => control.name === `image-notes-${candidate.id}`)
    if (tagsInput) value.tags = tagsInput.value
    if (notesInput) value.notes = notesInput.value
    metadataDrafts.set(key, value)
    const tags = value.tags.split(',').map(tag => tag.trim()).filter(Boolean)
    if (tags.length > 50 || tags.some(tag => tag.length > 80) || value.notes.length > 4000) {
      notice = '最多 50 个标签（每个 80 字符）和 4000 字符备注。'
      saveDraft()
      render()
      return
    }
    metadataBusy.add(key)
    render()
    try {
      const data = await api('/metadata', { productId: product.id, candidateId: candidate.id, formatVersion: 2, tags, notes: value.notes })
      const hit = candidates.find(item => keyOf(item) === key)
      if (hit) hit.metadata = data.metadata
      metadataDrafts.set(key, { tags: (data.metadata?.tags ?? tags).join(', '), notes: data.metadata?.notes ?? value.notes })
      notice = '标签与备注已保存到 v2 候选元数据。'
    } catch (cause) { notice = '保存候选元数据失败：' + String((cause as Error).message ?? cause) }
    finally { metadataBusy.delete(key); saveDraft(); render() }
  }

  async function runCheck(candidate: ProductImageCandidate): Promise<void> {
    const key = keyOf(candidate)
    if (versionOf(candidate) !== 2 || checkBusy.has(key)) return
    checkBusy.add(key)
    render()
    try {
      const data = await api('/check', { productId: product.id, candidateId: candidate.id, formatVersion: 2 })
      const hit = candidates.find(item => keyOf(item) === key)
      if (hit) hit.metadata = { ...(hit.metadata ?? { tags: [], notes: '' }), checks: [data.check] }
      notice = '技术检查完成；视觉与文字判断仍需人工完成。'
    } catch (cause) { notice = '技术检查失败：' + String((cause as Error).message ?? cause) }
    finally { checkBusy.delete(key); render() }
  }

  function toggleCompare(candidate: ProductImageCandidate): void {
    const key = keyOf(candidate)
    compareKeys = compareKeys.includes(key) ? compareKeys.filter(item => item !== key) : [...compareKeys, key].slice(-4)
    saveDraft()
    render()
  }

  function renderCompare(): void {
    const selected = compareKeys.map(key => candidates.find(candidate => keyOf(candidate) === key)).filter((candidate): candidate is ProductImageCandidate => !!candidate).slice(0, 4)
    compareCount.textContent = `${selected.length}/4 张`
    compareEmpty.hidden = selected.length >= 2
    compareGrid.hidden = selected.length < 2
    if (selected.length < 2) {
      compareGrid.replaceChildren()
      compareSignature = null
      return
    }
    compareGrid.style.setProperty('--pi-compare-columns', String(Math.min(4, selected.length)))
    const signature = JSON.stringify([selected.map(candidate => [keyOf(candidate), candidate.sha256]), zoom, checkerboard])
    if (compareSignature === signature) return
    compareSignature = signature
    compareGrid.replaceChildren(...selected.map(candidate => {
      const item = element('figure', 'pi-compare-item')
      item.dataset.candidateKey = keyOf(candidate)
      item.dataset.candidateMode = candidate.mode
      const title = element('figcaption', 'pi-meta', [sourceText[candidate.mode], candidate.provider, candidate.channel, candidate.model, candidate.prompt].filter(Boolean).join(' · '))
      const viewport = element('div', 'pi-compare-viewport')
      viewport.dataset.compareCandidate = keyOf(candidate)
      const image = element('img', 'pi-compare-image')
      image.src = imageUrl(candidate)
      image.alt = candidate.prompt || '候选图片比较'
      image.loading = 'lazy'
      image.style.width = `${zoom * 100}%`
      viewport.append(image)
      item.append(title, viewport)
      return item
    }))
  }

  function updateForm(): void {
    if (promptInput.value !== prompt) promptInput.value = prompt
    modeInput.value = mode
    referenceField.hidden = mode !== 'edit'
    const options = [element('option', '', '请选择本产品候选图片')]
    options[0].value = ''
    for (const candidate of candidates.filter(item => versionOf(item) === 1)) {
      const option = element('option', '', `${candidate.prompt.slice(0, 55) || candidate.id} · ${candidate.id.slice(0, 8)}`)
      option.value = candidate.id
      options.push(option)
    }
    referenceInput.replaceChildren(...options)
    referenceInput.value = referenceId
    confirmInput.checked = confirmed
    confirmInput.disabled = submitting || !available
    submit.textContent = submitting ? '正在提交…' : mode === 'edit' ? '提交图片编辑' : '生成图片'
    submit.disabled = !available || submitting || !confirmed || !prompt.trim() || (mode === 'edit' && !referenceId)
    refresh.disabled = loading
    importInput.disabled = importing
    importSubmit.disabled = importing
    importSubmit.textContent = importing ? '正在导入…' : '导入静态图片'
    zoomInput.value = String(zoom)
    checkerInput.checked = checkerboard
  }

  function render(): void {
    if (!mounted || !root) return
    root.classList.toggle('pi-checkerboard', checkerboard)
    status.textContent = loading && !available ? '正在检测 dsh-image-gen…' : available
      ? 'dsh-image-gen 可用 · 使用插件默认渠道与模型'
      : 'dsh-image-gen 暂不可用' + (reason ? '：' + reason : '，请确认插件已启用并配置生成渠道。')
    noticeNode.textContent = notice
    noticeNode.hidden = !notice
    warningList.replaceChildren(...warnings.map(value => element('li', '', value)))
    warningList.hidden = warnings.length === 0
    updateForm()
    jobList.replaceChildren()
    if (!jobs.length && !operations.length) jobList.append(element('p', 'pi-copy', '暂无任务。图片导入为本地操作，不调用模型。'))
    for (const job of jobs) {
      const row = element('div', 'pi-job')
      row.dataset.jobId = job.id
      row.dataset.status = job.status
      row.append(element('b', 'pi-copy', statusText[job.status] ?? job.status), element('div', 'pi-meta', `${job.id}${job.createdAt ? ' · ' + job.createdAt : ''}`))
      if (job.error) row.append(element('p', 'pi-copy', job.error))
      if (job.status === 'unknown') row.append(element('p', 'pi-copy pi-warning', '结果未知，可能已产生额度消耗。请先刷新状态并核对渠道记录；不会自动重试。'))
      jobList.append(row)
    }
    for (const operation of operations) {
      const row = element('div', 'pi-job')
      row.dataset.jobId = operation.id
      row.dataset.operationKind = 'import'
      row.append(element('b', 'pi-copy', operation.status === 'succeeded' ? '图片已导入' : operation.status === 'unknown' ? '导入结果未知' : '图片导入'),
        element('div', 'pi-meta', `${operation.id}${operation.createdAt ? ' · ' + operation.createdAt : ''}`))
      if (operation.error) row.append(element('p', 'pi-copy pi-warning', String(operation.error)))
      jobList.append(row)
    }
    // Jobs are polled while generation runs. Keep unchanged image elements so
    // no-store original images are not downloaded again on every status read.
    gallery.querySelectorAll<HTMLButtonElement>('[data-image-action="select"]').forEach(node => { node.disabled = !!selecting })
    gallery.querySelectorAll<HTMLButtonElement>('[data-image-action="compare"]').forEach(node => {
      const selected = compareKeys.includes(node.dataset.candidateKey ?? '')
      node.textContent = selected ? '移出比较' : '加入比较'
      node.setAttribute('aria-pressed', String(selected))
    })
    const signature = JSON.stringify(candidates)
    if (gallerySignature !== signature) {
      gallerySignature = signature
      gallery.replaceChildren()
      if (!candidates.length) gallery.append(element('p', 'ud-empty', '尚无候选。可导入本地静态图片，或在确认额度后生成。'))
      for (const candidate of candidates) {
        const key = keyOf(candidate)
        const card = element('article', 'pi-card')
        card.dataset.candidateId = candidate.id
        card.dataset.formatVersion = String(versionOf(candidate))
        card.dataset.candidateKey = key
        card.dataset.candidateMode = candidate.mode
        card.dataset.selected = String(candidate.selected === true)
        const image = element('img', 'pi-preview')
        image.src = imageUrl(candidate)
        image.alt = candidate.prompt || '产品图片候选'
        image.loading = 'lazy'
        image.onerror = () => { image.alt = '图片预览暂不可用，可刷新或下载核对' }
        const body = element('div', 'pi-card-body')
        const operationLabel = sourceText[candidate.mode]
        body.append(element('b', 'pi-copy', candidate.selected ? '已采用' : '图片候选'))
        if (candidate.prompt) {
          const promptDetails = element('details', 'pi-prompt')
          promptDetails.append(element('summary', 'pi-copy', '提示词'), element('p', 'pi-copy', candidate.prompt))
          body.append(promptDetails)
        }
        const dimensions = candidate.width && candidate.height ? `${candidate.width} × ${candidate.height}` : '尺寸未记录'
        const size = typeof candidate.bytes === 'number' ? (candidate.bytes / 1024).toFixed(1) + ' KiB' : ''
        body.append(element('div', 'pi-meta', [operationLabel, candidate.provider || (versionOf(candidate) === 2 ? '本地文件' : '插件默认渠道'), candidate.channel, candidate.model, dimensions, size, candidate.mime, `v${versionOf(candidate)}`, candidate.createdAt].filter(Boolean).join(' · ')))
        if (candidate.sourceCandidateId) body.append(element('div', 'pi-meta', '参考候选：' + candidate.sourceCandidateId))
        if (candidate.sha256) {
          const hash = element('details')
          hash.append(element('summary', 'pi-meta', '查看文件 SHA-256'), element('div', 'pi-meta', candidate.sha256))
          body.append(hash)
        }
        const actions = element('div', 'pi-row')
        const choose = button(candidate.selected ? '取消采用' : '采用图片', () => { void select(candidate) })
        choose.dataset.imageAction = 'select'
        choose.disabled = !!selecting
        const compare = button(compareKeys.includes(key) ? '移出比较' : '加入比较', () => toggleCompare(candidate))
        compare.dataset.imageAction = 'compare'
        compare.setAttribute('aria-pressed', String(compareKeys.includes(key)))
        compare.dataset.candidateKey = key
        const edit = button('用作编辑参考', () => { mode = 'edit'; referenceId = candidate.id; saveDraft(); render(); promptInput.focus() })
        edit.dataset.imageAction = 'reference'
        edit.disabled = versionOf(candidate) !== 1
        if (edit.disabled) edit.title = 'v2 导入候选暂不能作为既有生成器的编辑参考。'
        const download = element('a', 'ud-btn', '下载原图')
        download.href = imageUrl(candidate, true)
        download.download = ''
        download.dataset.imageAction = 'download'
        actions.append(choose, compare, edit, download)
        body.append(actions)

        if (versionOf(candidate) === 2) {
          const draft = draftFor(candidate)
          const tags = element('input', 'pi-input')
          tags.type = 'text'
          tags.name = `image-tags-${candidate.id}`
          tags.placeholder = '标签，用逗号分隔'
          tags.value = draft.tags
          tags.maxLength = 8000
          tags.oninput = () => { draft.tags = tags.value; saveDraft() }
          const notes = element('textarea', 'pi-notes')
          notes.name = `image-notes-${candidate.id}`
          notes.placeholder = '候选备注（不会改写原图或来源）'
          notes.value = draft.notes
          notes.maxLength = 4000
          notes.oninput = () => { draft.notes = notes.value; saveDraft() }
          const save = button(metadataBusy.has(key) ? '正在保存…' : '保存标签与备注', () => { void updateMetadata(candidate) })
          save.disabled = metadataBusy.has(key)
          save.dataset.imageAction = 'metadata'
          const check = button(checkBusy.has(key) ? '检查中…' : '技术检查', () => { void runCheck(candidate) })
          check.disabled = checkBusy.has(key)
          check.dataset.imageAction = 'check'
          body.append(tags, notes, element('div', 'pi-row', ''),)
          body.lastElementChild!.append(save, check)
          const reports = candidate.metadata?.checks
          const report = Array.isArray(reports) ? reports.at(-1) : undefined
          if (report) {
            const channel = report.hasAlpha === true ? '有 alpha 通道' : '无 alpha 通道'
            const transparency = report.hasTransparentPixels === true ? '存在透明像素' : report.hasTransparentPixels === false ? '无透明像素' : '透明像素未评估'
            body.append(element('p', 'pi-meta', `技术检查 ${report.status} · ${channel} · ${transparency} · 视觉／文字 ${report.visualStatus ?? 'not-evaluated'} · SHA-256 ${report.sha256}`))
          }
        }
        card.append(image, body)
        gallery.append(card)
      }
    }
    renderCompare()
  }

  function mount(): void {
    if (mounted && root && host.contains(root)) { render(); return }
    root?.remove()
    generation += 1
    mounted = true
    gallerySignature = null
    compareSignature = null
    const styles = CSS
    root = element('section', 'ud-root pi-root')
    root.dataset.productImages = product.id
    if (deps.ensureStyles) deps.ensureStyles(styles)
    else { const style = element('style'); style.textContent = styles; root.append(style) }
    const view = element('div', 'ud-view')
    const head = element('header', 'ud-head')
    const copy = element('div')
    copy.append(element('h2', '', '图片素材'), element('p', 'sub', `${product.name} · 插件生成与本地导入共用画廊，可任意组合比较`))
    refresh = button('刷新状态', () => { void reload() })
    refresh.dataset.imageAction = 'refresh'
    const tools = element('div', 'ud-actions')
    tools.append(refresh)
    if (deps.openSession) tools.append(button('打开产品会话', deps.openSession))
    head.append(copy, tools)
    status = element('p', 'pi-copy')
    status.setAttribute('role', 'status')
    noticeNode = element('p', 'pi-copy pi-notice')
    noticeNode.setAttribute('role', 'status')
    const panel = element('section', 'ud-panel')
    const form = element('form', 'ud-panel-body pi-form')
    form.onsubmit = event => { event.preventDefault(); void generate() }
    form.append(element('h3', 'pi-copy', '图片生成与编辑 · dsh-image-gen'))
    const modeField = element('label', 'pi-field', '操作')
    modeInput = element('select', 'ud-sel')
    modeInput.name = 'image-mode'
    for (const [value, title] of [['generate', '生成新图片'], ['edit', '编辑已有候选']]) {
      const option = element('option', '', title); option.value = value; modeInput.append(option)
    }
    modeInput.onchange = () => { mode = modeInput.value === 'edit' ? 'edit' : 'generate'; saveDraft(); render() }
    modeField.append(modeInput)
    referenceField = element('label', 'pi-field', '参考图片（仅本产品候选）')
    referenceInput = element('select', 'ud-sel')
    referenceInput.name = 'image-reference'
    referenceInput.onchange = () => { referenceId = referenceInput.value; saveDraft(); updateForm() }
    referenceField.append(referenceInput)
    const promptField = element('label', 'pi-field', '图片描述 / 编辑要求')
    promptInput = element('textarea')
    promptInput.name = 'image-prompt'
    promptInput.placeholder = '描述用途、主体、风格和尺寸；编辑时说明要保留和修改的内容。'
    promptInput.oninput = () => { prompt = promptInput.value; saveDraft(); updateForm() }
    promptField.append(promptInput)
    const caution = element('p', 'pi-copy pi-warning', '生成与编辑会调用 dsh-image-gen 已配置的默认渠道，可能消耗额度。成功后自动进入下方画廊，可与其他生成图或本地导入图比较。页面打开、刷新和比较不会自动生成；结果未知时不会自动重试。')
    const confirmation = element('label', 'pi-confirm pi-row')
    confirmInput = element('input')
    confirmInput.type = 'checkbox'
    confirmInput.name = 'image-confirm'
    confirmInput.onchange = () => {
      confirmed = confirmInput.checked
      try { localStorage.setItem(confirmationKey, String(confirmed)) }
      catch { /* Keep the user's choice in this view when storage is unavailable. */ }
      updateForm()
    }
    confirmation.append(confirmInput, document.createTextNode('我了解生成或编辑图片可能消耗渠道额度（记住此选择，可随时取消）。'))
    submit = element('button', 'ud-btn primary', '生成图片')
    submit.type = 'submit'
    submit.dataset.imageAction = 'generate'
    form.append(modeField, referenceField, promptField, caution, confirmation, element('div', 'pi-row'))
    form.lastElementChild!.append(submit)
    panel.append(form)
    const importPanel = element('section', 'ud-panel pi-import')
    const importTitle = element('b', 'pi-copy', '导入本地静态图片')
    const importCopy = element('p', 'pi-meta', '只发送本次选中的 PNG、JPEG 或 WebP 文件；单图最多 20 MiB。浏览器不传本机路径，导入不会调用模型。')
    importInput = element('input')
    importInput.type = 'file'
    importInput.name = 'image-import-file'
    importInput.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'
    importInput.onchange = () => { void importFile() }
    importSubmit = button('导入静态图片', selectImport, true)
    importSubmit.dataset.imageAction = 'import'
    importPanel.append(importTitle, importCopy, importInput, importSubmit)
    const jobsPanel = element('details', 'ud-panel')
    jobsPanel.open = true
    jobsPanel.append(element('summary', 'ud-panel-head', '任务记录'))
    jobList = element('div', 'ud-panel-body')
    jobList.dataset.imageJobs = ''
    jobsPanel.append(jobList)
    warningList = element('ul', 'pi-warning-list')
    warningList.dataset.imageWarnings = ''
    gallery = element('div', 'pi-grid')
    gallery.dataset.imageCandidates = ''
    comparePanel = element('section', 'ud-panel')
    const compareTools = element('div', 'pi-compare-tools')
    compareTools.append(element('b', 'pi-copy', '候选比较'))
    compareCount = element('span', 'pi-meta', '0/4 张')
    zoomInput = element('select', 'ud-sel')
    zoomInput.name = 'image-compare-zoom'
    zoomInput.setAttribute('aria-label', '比较缩放比例')
    for (const [value, title] of [['0.25', '25%'], ['0.5', '50%'], ['1', '100%'], ['2', '200%']]) {
      const option = element('option', '', title); option.value = value; zoomInput.append(option)
    }
    zoomInput.onchange = () => { zoom = Number(zoomInput.value) || 1; saveDraft(); renderCompare() }
    const checkerLabel = element('label', 'pi-row pi-meta')
    checkerInput = element('input')
    checkerInput.type = 'checkbox'
    checkerInput.name = 'image-checkerboard'
    checkerInput.onchange = () => { checkerboard = checkerInput.checked; saveDraft(); render() }
    checkerLabel.append(checkerInput, document.createTextNode('透明棋盘格'))
    compareTools.append(compareCount, zoomInput, checkerLabel)
    compareEmpty = element('p', 'pi-copy pi-compare-empty', '从画廊任选 2–4 张图片：生成图之间、导入图之间或生成图与导入图均可并排比较。')
    compareGrid = element('div', 'pi-compare-grid')
    compareGrid.dataset.imageCompare = ''
    comparePanel.append(compareTools, compareEmpty, compareGrid)
    view.append(head, status, noticeNode, warningList, panel, importPanel, jobsPanel, element('h3', 'pi-copy', '图片画廊（生成与本地导入）'), gallery, comparePanel)
    root.append(view)
    host.append(root)
    render()
    void reload()
  }

  function destroy(): void {
    mounted = false
    generation += 1
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const controller of requests) controller.abort()
    requests.clear()
    loading = false
    submitting = false
    importing = false
    selecting = ''
    root?.remove()
    root = null
  }

  return { mount, render, reload, destroy, isMounted: () => mounted && root !== null && host.contains(root) }
}
