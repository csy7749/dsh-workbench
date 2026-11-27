/**
 * DEMO 视图（1.13）
 *
 * 设计约束：
 * - 与 app.ts 只通过 deps 交互；
 * - 预览走 iframe（/demos/:id/view），视口切换只改容器宽度；
 * - 布局模式（D5）创建后不可改：页头徽标 + 生成弹窗警告双提示。
 */
import { UI_DEMO_CSS } from './ui-demo.css.js'

export interface DemoDeps {
  api: string
  esc: (value: unknown) => string
  toast: (message: string) => void
  confirm: (message: string) => boolean
  getProjectId: () => string
  getProjectName: () => string
  themes: () => Array<{ id: string; name: string; platform: string; hint: string }>
  designs: () => Promise<Array<{ id: string; name: string; pages: Array<{ id: string; name: string }> }>>
  ensureStyles: (css: string) => void
  seed: () => { designId: string; pageId: string } | null
  clearSeed: () => void
  openModal: (html: string) => void
  closeModal: () => void
  /** 派发 AI 生成 DEMO 产物（HTML）。 */
  onBuild?: (demo: DemoItem) => void
  /** 打开工作流模板库。 */
  openWorkflowTemplates?: () => void
}

export interface DemoVersion {
  id: string; seq: number; label: string; source: string; targetPage: string
  summary: string; entryPath: string; bytes: number; pageCount: number; createdAt: string
}
export interface DemoItem {
  id: string; projectId: string; uiDesignId: string; themeId: string
  layoutMode: 'single' | 'multi'; scope: string; kind: string; title: string
  entryPath: string; platform: string; status: string; currentVersionId: string
  thumbnailUrl?: string; archivedAt?: string; createdAt?: string; updatedAt?: string; versions?: DemoVersion[]
}

export interface DemoPack {
  id: string; sourceKind: 'game' | 'builtin'; title: string; category: string; summary: string; description: string
  tags: string[]; version: string; thumbnailUrl: string; previewUrl: string; playUrl?: string
  workflowTemplateId: string; workflowTemplateName: string
  nodes: Array<{ id: string; title: string }>
  files: Array<{ group: string; paths: string[] }>
  acceptance: string[]; verification: Array<{ command: string; scope: string }>
  license: string; provenance: string
}

export interface DemoViewHandle {
  mount(): void
  render(): void
  reload(): Promise<void>
  destroy(): void
  isMounted(): boolean
}

export function createDemoView(host: HTMLElement, deps: DemoDeps): DemoViewHandle {
  deps.ensureStyles(UI_DEMO_CSS)
  const esc = deps.esc
  let root: HTMLElement | null = null
  let demos: DemoItem[] = []
  let packs: DemoPack[] = []
  let activeId = ''
  let activeKind: 'pack' | 'web' = 'pack'
  let filter: 'all' | 'game' | 'web' = 'all'
  let viewport: 'pc' | 'tablet' | 'mobile' = 'pc'
  let pageId = ''
  let loading = false
  let mounted = false
  // Built-in previews are opt-in: loading the library should not start a game
  // (and its WebGL context) before the user asks to play it.
  let previewClosed = true
  let tab: 'preview' | 'files' | 'versions' | 'acceptance' = 'preview'
  let files: Array<{ path: string; role: string; bytes: number }> = []
  /** 关联 UI 设计的页面清单（用于预览的页面切换）。 */
  let pages: Array<{ id: string; name: string }> = []

  async function loadPagesOf(demo: DemoItem): Promise<void> {
    pages = []
    if (demo.uiDesignId === '') return
    try {
      const data = await api(`/ui-designs/${encodeURIComponent(demo.uiDesignId)}`)
      const list = data.design?.pages
      pages = Array.isArray(list) ? list.map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id) })) : []
    } catch { pages = [] }
  }

  const current = (): DemoItem | undefined => demos.find(d => d.id === activeId) ?? demos[0]
  const currentPack = (): DemoPack | undefined => packs.find(demo => demo.id === activeId)
  const visiblePacks = (): DemoPack[] => filter === 'web' ? [] : packs
  const visibleDemos = (): DemoItem[] => filter === 'game' ? [] : demos

  /** 弹窗在 Shadow DOM 内，document.getElementById 取不到——必须从宿主 shadowRoot 查。 */
  function $el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    const shadow = root?.getRootNode() instanceof ShadowRoot ? (root.getRootNode() as ShadowRoot) : null
    return (shadow?.getElementById(id) ?? document.getElementById(id)) as T | null
  }

  async function api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${deps.api}${path}`, init)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(String((data as any)?.message ?? `HTTP ${res.status}`))
    return data
  }

  async function reload(): Promise<void> {
    const projectId = deps.getProjectId()
    if (loading) return
    const previousActiveKind = activeKind
    const previousActiveId = activeId
    loading = true
    render()
    try {
      const data = await api(`/demos/library?projectId=${encodeURIComponent(projectId)}`)
      demos = Array.isArray(data.demos) ? data.demos : []
      packs = Array.isArray(data.packs) ? data.packs : []
      const seed = deps.seed()
      if (seed !== null && demos.length > 0) {
        const hit = demos.find(d => d.uiDesignId === seed.designId)
        if (hit !== undefined) { activeId = hit.id; activeKind = 'web'; if (seed.pageId !== '') pageId = seed.pageId }
        deps.clearSeed()
      }
      if (activeKind === 'pack' && !packs.some(demo => demo.id === activeId)) activeId = packs[0]?.id ?? ''
      if (activeKind === 'web' && !demos.some(demo => demo.id === activeId)) activeId = demos[0]?.id ?? ''
      if (activeId === '' && packs.length > 0) { activeKind = 'pack'; activeId = packs[0].id }
      if (activeKind === 'pack' && (previousActiveKind !== 'pack' || previousActiveId !== activeId)) previewClosed = true
      const hit = activeKind === 'web' ? current() : undefined
      if (hit !== undefined && projectId !== '') {
        const detail = await api(`/demos/${encodeURIComponent(hit.id)}`)
        if (detail.demo?.versions) {
          const index = demos.findIndex(d => d.id === hit.id)
          if (index >= 0) demos[index] = { ...demos[index], ...detail.demo }
        }
        await loadPagesOf(hit)
        files = await loadFiles(projectId, hit.id)
      }
    } catch (cause) {
      deps.toast(`加载 DEMO 失败：${String((cause as Error).message ?? cause)}`)
    }
    loading = false
    render()
  }

  /** 文件索引（B3 接后端 tree 接口；当前按版本尝试读取元信息）。 */
  async function loadFiles(projectId: string, demoId: string): Promise<Array<{ path: string; role: string; bytes: number }>> {
    try {
      const data = await api(`/files/tree?projectId=${encodeURIComponent(projectId)}&demoId=${encodeURIComponent(demoId)}`)
      return Array.isArray(data.files) ? data.files : []
    } catch { return [] }
  }

  function themeOptions(selected: string): string {
    const list = deps.themes()
    const merged = list.length > 0 ? list : [{ id: 'clean', name: '极简白', platform: 'all', hint: '' }]
    return merged.map(t => `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
  }

  function renderPreview(demo: DemoItem): string {
    const src = `${deps.api}/demos/${encodeURIComponent(demo.id)}/view${pageId !== '' ? `?page=${encodeURIComponent(pageId)}` : ''}`
    const pagePicker = pages.length > 0
      ? `<select class="ud-sel" data-demo="page" style="height:22px;font-size:9.5px">${pages.map(p => `<option value="${esc(p.id)}" ${(pageId === p.id || (pageId === '' && pages[0]?.id === p.id)) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
      : ''
    return `<div class="ud-frame-bar">
        ${(['pc', 'tablet', 'mobile'] as const).map(v => `<button class="ud-vp ${viewport === v ? 'on' : ''}" data-demo="vp" data-v="${v}">${v === 'pc' ? 'PC' : v === 'tablet' ? '平板' : '移动'}</button>`).join('')}
        ${pagePicker}
        <span style="margin-left:auto;display:flex;gap:4px;align-items:center">
          <button class="ud-btn tiny" data-demo="optimize">✦ AI 优化此页</button>
          <button class="ud-btn tiny" data-demo="open">↗ 浏览器打开</button>
        </span>
      </div>
      <div class="ud-frame-wrap ${viewport}"><iframe class="ud-iframe" sandbox="allow-scripts allow-forms allow-modals" src="${esc(src)}" title="${esc(demo.title)}"></iframe></div>`
  }

  function renderFiles(demo: DemoItem): string {
    if (files.length === 0) {
      const version = (demo.versions ?? [])[0]
      return `<div class="ud-empty">${version
        ? `当前版本 v${version.seq} · ${version.pageCount} 页 · ${formatBytes(version.bytes)}。<br/>文件索引在 B3 接入后显示完整树。`
        : '还没有产物文件。生成 DEMO 后会在这里列出。</div>'}`
    }
    return `<div class="ud-tree">${files.map(f => `<div><span class="${f.role === 'entry' ? 'd' : ''}">${esc(f.path)}</span><span class="sz">${formatBytes(f.bytes)}</span>${f.role !== 'asset' ? `<span class="role ${f.role}">${esc(f.role)}</span>` : ''}</div>`).join('')}</div>`
  }

  function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0 B'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  function renderVersions(demo: DemoItem): string {
    const list = demo.versions ?? []
    if (list.length === 0) return `<div class="ud-empty">还没有版本。生成 DEMO 会自动创建 v1。</div>`
    return `<div class="ud-vlist">${list.map(v => `
      <div class="ud-vrow ${v.id === demo.currentVersionId ? 'current' : ''}">
        <span class="ud-vseq">v${v.seq}</span>
        <span class="ud-vlabel">${esc(v.label || v.source)}</span>
        ${v.targetPage !== '' ? `<span class="ud-tag">${esc(v.targetPage)}</span>` : ''}
        <span class="ud-vmeta">${v.pageCount} 页 · ${formatBytes(v.bytes)} · ${esc((v.createdAt ?? '').slice(5, 16))}</span>
        <span class="ud-vops">
          <button class="ud-btn tiny" data-demo="rollback" data-version="${esc(v.id)}" title="回滚到此版本">↺</button>
        </span>
      </div>`).join('')}</div>`
  }

  function renderCard(title: string, summary: string, kind: string, id: string, selected: boolean, thumbnailUrl: string, fallback: string, action: 'pick-pack' | 'pick'): string {
    return `<button class="ud-library-card ${selected ? 'active' : ''}" data-demo="${action}" data-id="${esc(id)}">
      <div class="ud-library-cover"><span class="fallback">${esc(fallback)}</span>${thumbnailUrl ? `<img src="${esc(thumbnailUrl)}" alt="${esc(title)} 缩略图" loading="lazy">` : ''}<span class="kind">${esc(kind)}</span></div>
      <div class="ud-library-card-body"><b>${esc(title)}</b><span>${esc(summary)}</span></div>
    </button>`
  }

  function renderPackFiles(pack: DemoPack): string {
    return `<div class="ud-panel-body"><div class="ud-source-groups">${pack.files.map(group => `<section class="ud-source-group"><b>${esc(group.group)} · ${group.paths.length}</b>${group.paths.map(path => `<div class="ud-source-path">${esc(path)}</div>`).join('')}</section>`).join('')}</div></div>`
  }

  function renderPackDetail(pack: DemoPack): string {
    const tabs = `<div class="ud-tabs">
      <button class="ud-tab ${tab === 'preview' ? 'active' : ''}" data-demo="tab" data-tab="preview">运行预览</button>
      <button class="ud-tab ${tab === 'files' ? 'active' : ''}" data-demo="tab" data-tab="files">节点与代码 · ${pack.nodes.length} 节点</button>
      <button class="ud-tab ${tab === 'acceptance' ? 'active' : ''}" data-demo="tab" data-tab="acceptance">验收与来源</button>
    </div>`
    let body = ''
    if (tab === 'preview') {
      body = `<div class="ud-panel"><div class="ud-frame-bar">
        ${(['pc', 'tablet', 'mobile'] as const).map(v => `<button class="ud-vp ${viewport === v ? 'on' : ''}" data-demo="vp" data-v="${v}">${v === 'pc' ? 'PC' : v === 'tablet' ? '平板' : '移动'}</button>`).join('')}
        <span style="margin-left:auto;display:flex;gap:4px">
          ${previewClosed ? '' : '<button class="ud-btn tiny" data-demo="close-preview">关闭试玩</button>'}
          <button class="ud-btn tiny" data-demo="open-pack">↗ 新窗口试玩</button>
        </span>
      </div>${previewClosed
        ? '<div class="ud-empty"><p role="status">试玩已关闭</p><button class="ud-btn" data-demo="start-preview">重新试玩</button></div>'
        : `<div class="ud-frame-wrap ${viewport}"><iframe class="ud-iframe" sandbox="allow-scripts allow-forms allow-modals" src="${esc(pack.previewUrl)}" title="${esc(pack.title)}"></iframe></div>`}
      <div class="ud-detail-copy">${esc(pack.description)}<div class="ud-chip-row">${pack.tags.map(tag => `<span class="ud-chip">${esc(tag)}</span>`).join('')}</div></div></div>`
    } else if (tab === 'files') {
      body = `<div class="ud-panel"><div class="ud-detail-head"><b>工作流节点与关联源码</b><span class="spacer"></span><button class="ud-btn tiny" data-demo="workflow-templates">打开工作流模板库</button></div><div class="ud-detail-copy"><p>模板：${esc(pack.workflowTemplateName)}（${esc(pack.workflowTemplateId)}）</p><div class="ud-chip-row">${pack.nodes.map(node => `<span class="ud-chip" title="${esc(node.id)}">${esc(node.title)} · ${esc(node.id)}</span>`).join('')}</div></div>${renderPackFiles(pack)}</div>`
    } else {
      body = `<div class="ud-panel"><div class="ud-panel-head"><div><b>验收范围</b><span>自动试玩、离线交付和真人验收分别记录</span></div></div><div class="ud-panel-body"><div class="ud-acceptance">${pack.acceptance.map(item => `<div><i>✓</i><span>${esc(item)}</span></div>`).join('')}</div><div class="ud-source-groups" style="margin-top:14px"><section class="ud-source-group"><b>验证入口</b>${pack.verification.map(item => `<div class="ud-source-path"><code>${esc(item.command)}</code><br>${esc(item.scope)}</div>`).join('')}</section><section class="ud-source-group"><b>许可与来源</b><div class="ud-source-path">${esc(pack.license)} · ${esc(pack.provenance)}</div></section></div></div></div>`
    }
    return `<div>${tabs}${body}</div>`
  }

  function renderWebDetail(demo: DemoItem): string {
    const tabs = `<div class="ud-tabs">
      <button class="ud-tab ${tab === 'preview' ? 'active' : ''}" data-demo="tab" data-tab="preview">预览</button>
      <button class="ud-tab ${tab === 'files' ? 'active' : ''}" data-demo="tab" data-tab="files">项目文件</button>
      <button class="ud-tab ${tab === 'versions' ? 'active' : ''}" data-demo="tab" data-tab="versions">版本 · ${(demo.versions ?? []).length}</button>
    </div>`
    let body = ''
    if (tab === 'preview') body = `<div class="ud-panel"><div class="ud-panel-body" style="padding:0">${renderPreview(demo)}</div></div>`
    else if (tab === 'files') body = `<div class="ud-panel"><div class="ud-panel-head"><div><b>项目文件</b><span>只读浏览 · .dsh-workbench/demos/&lt;demoId&gt;/</span></div><button class="ud-btn tiny" data-demo="reload">刷新</button></div><div class="ud-panel-body">${renderFiles(demo)}</div></div>`
    else body = `<div class="ud-panel"><div class="ud-panel-head"><div><b>版本</b><span>生成 / 按页优化 / 换主题都会产生版本</span></div></div><div class="ud-panel-body">${renderVersions(demo)}</div></div>`
    return `<div>${tabs}${body}</div>`
  }

  function render(): void {
    if (root === null) return
    if (loading && demos.length === 0 && packs.length === 0) {
      root.innerHTML = `<div class="ud-view"><div class="ud-empty">正在加载 Demo 库…</div></div>`
      return
    }
    const pack = activeKind === 'pack' ? currentPack() : undefined
    const demo = activeKind === 'web' ? current() : undefined
    const projectId = deps.getProjectId()
    const filters = `<div class="ud-library-tools">
      <button class="ud-filter ${filter === 'all' ? 'active' : ''}" data-demo="filter" data-filter="all">全部 · ${demos.length + packs.length}</button>
      <button class="ud-filter ${filter === 'game' ? 'active' : ''}" data-demo="filter" data-filter="game">游戏 · ${packs.length}</button>
      <button class="ud-filter ${filter === 'web' ? 'active' : ''}" data-demo="filter" data-filter="web">网页 · ${demos.length}</button>
      <span class="spacer"></span><span class="ud-badge">${projectId === '' ? '内置 Demo' : esc(deps.getProjectName())}</span>
      <button class="ud-btn primary" data-demo="generate" ${projectId === '' ? 'disabled title="选择项目后可创建网页 Demo"' : ''}>＋ 新建网页 Demo</button>
    </div>`
    const cards = [
      ...visiblePacks().map(item => renderCard(item.title, item.summary, item.category, item.id, activeKind === 'pack' && item.id === activeId, item.thumbnailUrl, 'CW', 'pick-pack')),
      ...visibleDemos().map(item => renderCard(item.title, `${item.themeId} · ${item.layoutMode === 'multi' ? '多文件' : '单文件'}${(item.archivedAt ?? '') !== '' ? ' · 已归档' : ''}`, item.kind === 'system' ? '产品系统' : '网页', item.id, activeKind === 'web' && item.id === activeId, item.thumbnailUrl ?? '', 'WEB', 'pick')),
    ].join('')
    const selectedHeader = pack
      ? `<div class="ud-detail-head"><b>${esc(pack.title)}</b><span class="ud-badge">${esc(pack.version)}</span><span class="spacer"></span><button class="ud-btn tiny" data-demo="open-pack">↗ 试玩</button></div>`
      : demo
        ? `<div class="ud-detail-head"><b>${esc(demo.title)}</b><span class="ud-badge ${demo.layoutMode === 'multi' ? 'multi' : 'single'}">${demo.layoutMode === 'multi' ? '多文件' : '单文件'}</span><span class="spacer"></span>
          <select class="ud-sel" data-demo="theme">${themeOptions(demo.themeId)}</select>
          <button class="ud-btn tiny" data-demo="thumbnail-pick">${demo.thumbnailUrl ? '更换封面' : '上传封面'}</button>
          <input id="wb-demo-thumbnail-file" type="file" accept="image/png,image/webp,image/jpeg" hidden>
          <button class="ud-btn tiny" data-demo="archive">${(demo.archivedAt ?? '') === '' ? '⌸ 归档' : '↩ 恢复'}</button>
          <button class="ud-btn tiny" data-demo="build">✦ 生成页面</button></div>`
        : `<div class="ud-empty">${projectId === '' ? '选择一个项目后，这里会显示该项目的网页 Demo。' : '该分类暂时没有 Demo。'}</div>`
    const selectedBody = pack ? renderPackDetail(pack) : demo ? renderWebDetail(demo) : ''
    root.innerHTML = `<div class="ud-view">
      <div class="ud-head"><div><div class="ud-eyebrow">DEMO LIBRARY</div><h2>Demo 库</h2><p class="sub">游戏模板与网页原型统一浏览；每项可登记预览、缩略图、节点、代码和验收信息。</p></div></div>
      ${filters}
      ${cards ? `<div class="ud-library-grid">${cards}</div>` : '<div class="ud-empty">还没有这个分类的 Demo。</div>'}
      <div class="ud-panel">${selectedHeader}${selectedBody}</div>
    </div>`
    bind()
  }

  function bind(): void {
    if (root === null) return
    root.querySelectorAll<HTMLElement>('[data-demo]').forEach(el => {
      el.onclick = () => {
        const act = el.getAttribute('data-demo') ?? ''
        const demo = current()
        const pack = currentPack()
        if (act === 'tab') { tab = (el.getAttribute('data-tab') ?? 'preview') as typeof tab; render(); return }
        if (act === 'vp') { viewport = (el.getAttribute('data-v') ?? 'pc') as typeof viewport; render(); return }
        if (act === 'close-preview') { previewClosed = true; render(); return }
        if (act === 'start-preview') { previewClosed = false; render(); return }
        if (act === 'filter') {
          filter = (el.getAttribute('data-filter') ?? 'all') as typeof filter
          if (filter === 'game') { activeKind = 'pack'; activeId = packs[0]?.id ?? ''; previewClosed = true }
          else if (filter === 'web') { activeKind = 'web'; activeId = demos[0]?.id ?? '' }
          else if (activeKind === 'web' && demos.length === 0) { activeKind = 'pack'; activeId = packs[0]?.id ?? ''; previewClosed = true }
          else if (activeKind === 'pack' && packs.length === 0) { activeKind = 'web'; activeId = demos[0]?.id ?? '' }
          tab = 'preview'; render(); return
        }
        if (act === 'pick') { activeKind = 'web'; activeId = el.getAttribute('data-id') ?? ''; pageId = ''; tab = 'preview'; void reload(); return }
        if (act === 'pick-pack') { activeKind = 'pack'; activeId = el.getAttribute('data-id') ?? ''; tab = 'preview'; previewClosed = true; render(); return }
        if (act === 'reload') { void reload(); return }
        if (act === 'archive') {
          if (demo) {
            const next = (demo.archivedAt ?? '') === ''
            if (!next || deps.confirm('归档后该 DEMO 会从列表隐藏（可在「显示已归档」查看）。继续？')) {
              void (async () => {
                try {
                  await api('/demos/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: demo.id, archived: next }) })
                  await reload()
                  deps.toast(next ? '已归档' : '已恢复')
                } catch (cause) { deps.toast(`操作失败：${String((cause as Error).message ?? cause)}`) }
              })()
            }
          }
          return
        }
        if (act === 'generate') { openGenerateModal(); return }
        if (act === 'thumbnail-pick') { $el<HTMLInputElement>('wb-demo-thumbnail-file')?.click(); return }
        if (act === 'build') {
          if (demo === undefined) { deps.toast('先创建一个 DEMO'); return }
          if (deps.onBuild === undefined) { deps.toast('生成通道未接入'); return }
          deps.onBuild(demo)
          return
        }
        if (act === 'optimize') { if (demo) openOptimizeModal(demo); return }
        if (act === 'open') { if (demo) window.open(`${deps.api}/demos/${encodeURIComponent(demo.id)}/view${pageId !== '' ? `?page=${encodeURIComponent(pageId)}` : ''}`, '_blank'); return }
        if (act === 'open-pack') { if (pack) window.open(pack.playUrl ?? pack.previewUrl, '_blank', 'noopener'); return }
        if (act === 'workflow-templates') { deps.openWorkflowTemplates?.(); return }
        if (act === 'rollback') { if (demo) void rollback(demo, el.getAttribute('data-version') ?? ''); return }
      }
    })
    root.querySelectorAll<HTMLImageElement>('.ud-library-cover img').forEach(image => {
      image.onerror = () => image.remove()
    })
    const thumbnailInput = $el<HTMLInputElement>('wb-demo-thumbnail-file')
    if (thumbnailInput !== null) {
      thumbnailInput.onchange = () => {
        const file = thumbnailInput.files?.[0]
        const demo = current()
        if (!file || !demo) return
        void (async () => {
          try {
            if (file.size > 12 * 1024 * 1024) throw new Error('原图不能超过 12 MB')
            const bitmap = await createImageBitmap(file)
            if (bitmap.width * bitmap.height > 16_000_000) { bitmap.close(); throw new Error('原图像素过多') }
            const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400
            const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height)
            const width = bitmap.width * scale, height = bitmap.height * scale
            const context = canvas.getContext('2d')
            if (!context) { bitmap.close(); throw new Error('浏览器无法处理该图片') }
            context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
            bitmap.close()
            const dataUrl = canvas.toDataURL('image/webp', 0.82)
            const saved = await api(`/demos/${encodeURIComponent(demo.id)}/thumbnail`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl }),
            })
            const index = demos.findIndex(item => item.id === demo.id)
            if (index >= 0) demos[index] = { ...demos[index], thumbnailUrl: String(saved.thumbnailUrl ?? '') }
            thumbnailInput.value = ''
            render()
            deps.toast('Demo 缩略图已保存')
          } catch (cause) {
            deps.toast(`缩略图保存失败：${String((cause as Error).message ?? cause)}`)
          }
        })()
      }
    }
    const pageSel = root.querySelector<HTMLSelectElement>('[data-demo="page"]')
    if (pageSel !== null) {
      pageSel.onchange = () => { pageId = pageSel.value; render() }
    }
    const themeSel = root.querySelector<HTMLSelectElement>('[data-demo="theme"]')
    if (themeSel !== null) {
      themeSel.onchange = () => {
        const demo = current()
        if (!demo) return
        void (async () => {
          try {
            await api('/demos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ demo: { id: demo.id, title: demo.title, themeId: themeSel.value } }) })
            await reload()
            deps.toast('已换主题（B1 后会自动生成新版本）')
          } catch (cause) { deps.toast(`换主题失败：${String((cause as Error).message ?? cause)}`) }
        })()
      }
    }
  }

  async function rollback(demo: DemoItem, versionId: string): Promise<void> {
    if (versionId === '') return
    if (!deps.confirm('回滚会新建一个版本（历史不丢）。继续？')) return
    try {
      await api(`/demos/${encodeURIComponent(demo.id)}/rollback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId }) })
      await reload()
      deps.toast('已回滚并生成新版本')
    } catch (cause) { deps.toast(`回滚失败：${String((cause as Error).message ?? cause)}`) }
  }

  function openOptimizeModal(demo: DemoItem): void {
    const page = pageId !== '' ? pageId : '整页'
    deps.openModal(`<h3>AI 优化此页 · ${esc(page)}</h3>
      <div class="mfield"><label>这页要改什么</label><textarea id="wb-demo-opt" rows="4" placeholder="例如：更紧凑 / 补空态 / 换布局 / 精简文案"></textarea></div>
      <div class="mfield" style="display:flex;gap:5px;flex-wrap:wrap">
        ${['更紧凑', '更醒目', '换布局', '补空态', '补错误态', '精简文案'].map(t => `<button class="btn tiny" data-demo-chip="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>
      <div class="mfield" style="background:var(--amber-soft);border:1px solid color-mix(in srgb,var(--amber) 35%,var(--line));border-radius:8px;padding:7px 10px;font-size:10px;color:#8a5a08;line-height:1.6">
        只重写「${esc(page)}」这一页；其它页面字节级不变，校验通过才落库，并自动生成新版本。</div>
      <div class="modal-foot"><button class="btn" data-act="close-modal">取消</button><button class="btn solid" id="wb-demo-opt-go">开始优化</button></div>`)
    const shadow = root?.getRootNode() instanceof ShadowRoot ? (root.getRootNode() as ShadowRoot) : null
    ;(shadow ?? document).querySelectorAll<HTMLElement>('[data-demo-chip]').forEach(chip => {
      chip.onclick = () => {
        const target = $el('wb-demo-opt') as HTMLTextAreaElement | null
        if (target === null) return
        const value = chip.getAttribute('data-demo-chip') ?? ''
        target.value = target.value.trim() === '' ? value : `${target.value}；${value}`
      }
    })
    const go = $el('wb-demo-opt-go')
    if (go !== null) {
      go.onclick = () => {
        deps.closeModal()
        deps.toast('按页优化需团队派发（B1 接入后可用）；需求已记录')
      }
    }
  }

  function openGenerateModal(): void {
    void (async () => {
      let designs: Array<{ id: string; name: string; pages: Array<{ id: string; name: string }> }> = []
      try { designs = await deps.designs() } catch (e) { designs = []; deps.toast('读取 UI 设计失败：' + String(e).slice(0,60)) }
      const designOptions = designs.length > 0
        ? designs.map(d => `<option value="${esc(d.id)}">${esc(d.name)}（${d.pages.length} 页）</option>`).join('')
        : '<option value="">（暂无 UI 设计，可直接描述生成）</option>'
      deps.openModal(`<h3>生成 DEMO</h3>
        <div class="mfield"><label>来源</label><select id="wb-demo-design">${designOptions}</select></div>
        <div class="mfield"><label>布局模式 <span style="color:var(--amber)">（创建后不可更改）</span></label>
          <select id="wb-demo-layout"><option value="single">单文件 · 页面内导航切换</option><option value="multi">多文件 · 每页独立文件</option></select>
          <div style="margin-top:5px;background:var(--amber-soft);border:1px solid color-mix(in srgb,var(--amber) 35%,var(--line));border-radius:8px;padding:7px 10px;font-size:10px;color:#8a5a08;line-height:1.6">
            模式创建后不能修改。要换模式需删除该 DEMO 后重新生成（会丢失版本历史）。</div>
        </div>
        <div class="mfield"><label>主题</label><select id="wb-demo-theme">${themeOptions('glass')}</select></div>
        <div class="mfield"><label>名称</label><input id="wb-demo-title" placeholder="例如：收银台 Demo"></div>
        <div class="modal-foot"><button class="btn" data-act="close-modal">取消</button><button class="btn solid" id="wb-demo-create">创建</button></div>`)
      const create = $el('wb-demo-create')
      if (create !== null) {
        create.onclick = () => {
          const designId = $el<HTMLSelectElement>('wb-demo-design')?.value ?? ''
          const layoutMode = $el<HTMLSelectElement>('wb-demo-layout')?.value ?? 'single'
          const themeId = $el<HTMLSelectElement>('wb-demo-theme')?.value ?? 'clean'
          const title = ($el<HTMLInputElement>('wb-demo-title')?.value ?? '').trim() || '新 DEMO'
          void (async () => {
            try {
              const data = await api('/demos', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ demo: { projectId: deps.getProjectId(), uiDesignId: designId, title, themeId, layoutMode, platform: 'all' } }),
              })
              deps.closeModal()
              activeKind = 'web'
              activeId = data.demo?.id ?? ''
              await reload()
              deps.toast(`已创建（${layoutMode === 'multi' ? '多文件' : '单文件'}）；生成页面需 B1 接入`)
            } catch (cause) { deps.toast(`创建失败：${String((cause as Error).message ?? cause)}`) }
          })()
        }
      }
    })()
  }

  function mount(): void {
    /* 视图切换时 #wb-generic 的 innerHTML 会被整体重建，缓存下来的 root 会脱离文档。
       所以每次 mount 都要确认 DOM 仍挂在宿主里，否则重建。 */
    if (mounted && root !== null && root.isConnected) { render(); return }
    root?.remove()
    root = document.createElement('div')
    root.className = 'ud-root'
    host.appendChild(root)
    mounted = true
    void reload()
  }

  function destroy(): void {
    root?.remove()
    root = null
    mounted = false
  }

  return { mount, render, reload, destroy, isMounted: () => mounted }
}
