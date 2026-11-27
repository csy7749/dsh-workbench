export type GameWorkspaceStage = 'overview' | 'design' | 'make' | 'play' | 'deliver'

export interface GameWorkspaceDeps {
  apiBase: string
  product: { id: string; name: string; workspacePath?: string }
  ensureStyles?: (css: string) => void
  toast?: (message: string) => void
  openDesign?: () => void
  openImages?: () => void
  openWorkflow?: () => void
  onRequestChange?: (context: { productId: string; slug: string; buildId: string; summary: string }) => void | Promise<void>
  onStateChange?: (state: { slug: string; buildId?: string; view: GameWorkspaceStage }) => void
  initial?: { slug?: string; view?: GameWorkspaceStage }
}

export interface GameWorkspaceHandle {
  mount(): void
  render(): void
  reload(): Promise<void>
  destroy(): void
  isMounted(): boolean
}

const stages: Array<[GameWorkspaceStage, string, string]> = [
  ['overview', '概览', '这一轮做什么'], ['design', '设计', '玩法与目标'], ['make', '制作', '源码与候选'], ['play', '试玩', '看见实际变化'], ['deliver', '交付', '固定版本导出'],
]
const templates: Record<string, { title: string; description: string }> = {
  cinderwatch: { title: 'Cinderwatch · 3D 塔防', description: '程序化场景、塔防与经济循环；横屏。当前不接外部图片或 GLB。' },
  'canvas-collector': { title: 'Canvas · 2D 采集', description: '限时采集与生命规则；保留旧工程和素材槽兼容。' },
  'three-collector': { title: 'Three.js · 3D 采集', description: '离线 3D 采集起点；保留已有 GLB 和图片槽兼容。' },
}
const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const asArray = (value: any): any[] => Array.isArray(value) ? value : Array.isArray(value?.builds) ? value.builds : []
const css = `
.gw-root{--gw-panel:var(--panel,#fff);--gw-line:var(--line,#e4e5e9);--gw-muted:var(--text-2,#626773);--gw-ink:var(--text,#202731);--gw-soft:var(--panel-2,#f7f8fa);--gw-accent:var(--accent,#486c60);color:var(--gw-ink);font:13px/1.6 var(--font,system-ui,sans-serif);min-width:0}
.gw-root *{box-sizing:border-box}.gw-root [hidden]{display:none!important}.gw-shell{max-width:1440px;margin:auto;padding:20px 24px 36px}.gw-top,.gw-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.gw-top{justify-content:space-between;align-items:flex-start;margin-bottom:17px}.gw-kicker{font-size:11px;color:var(--gw-muted);letter-spacing:.08em}.gw-root h2{font-size:23px;line-height:1.3;letter-spacing:-.6px;margin:2px 0 5px}.gw-root h3{font-size:15px;margin:0 0 8px}.gw-root p{margin:5px 0 12px}.gw-muted{color:var(--gw-muted)}.gw-small{font-size:11px}.gw-context{font-size:12px;color:var(--gw-muted);overflow-wrap:anywhere}.gw-context code{color:var(--gw-ink)}
.gw-root button,.gw-root select,.gw-root input,.gw-root textarea{font:inherit;color:inherit}.gw-btn{min-height:33px;display:inline-flex;align-items:center;justify-content:center;padding:5px 12px;border:1px solid var(--gw-line);border-radius:7px;background:var(--gw-panel);cursor:pointer;text-decoration:none;color:var(--gw-ink)}.gw-btn:hover{background:var(--hover,#f0f3f2)}.gw-btn.primary{background:var(--gw-accent);border-color:var(--gw-accent);color:var(--accent-contrast,#fff)}.gw-root button:disabled{opacity:.46;cursor:not-allowed}.gw-root select{max-width:340px;min-height:33px;padding:4px 28px 4px 9px;border:1px solid var(--gw-line);border-radius:7px;background:var(--gw-panel)}
.gw-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:3px;margin:16px 0 18px;padding:4px;border:1px solid var(--gw-line);border-radius:10px;background:var(--gw-soft)}.gw-tab{border:0;border-radius:7px;padding:9px 10px;background:transparent;text-align:left;cursor:pointer;color:var(--gw-muted)}.gw-tab strong{font-weight:600;font-size:13px;display:block}.gw-tab small{font-size:10px;display:block;margin-top:1px}.gw-tab[aria-current=page]{color:var(--gw-ink);background:var(--gw-panel);box-shadow:0 1px 3px #0000000a}
.gw-grid{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(240px,1fr);gap:16px;align-items:start}.gw-card{min-width:0;padding:18px;border:1px solid var(--gw-line);border-radius:11px;background:var(--gw-panel)}.gw-stack{display:flex;flex-direction:column;gap:14px}.gw-banner{border:1px solid var(--gw-line);border-left:3px solid var(--gw-accent);border-radius:7px;padding:9px 12px;margin:0 0 14px;background:var(--gw-soft);white-space:pre-wrap;overflow-wrap:anywhere}.gw-banner.warning{border-left-color:var(--amber,#b57d24)}.gw-id{display:inline-flex;align-items:center;gap:6px;font-size:11px;border:1px solid var(--gw-line);border-radius:5px;padding:2px 7px;background:var(--gw-soft);overflow-wrap:anywhere}.gw-hero{padding:24px;background:var(--gw-soft)}.gw-hero h3{font-size:22px;letter-spacing:-.4px}.gw-rule{height:1px;background:var(--gw-line);margin:15px 0}.gw-root code{font-size:11px;overflow-wrap:anywhere}.gw-empty{padding:28px 20px;border:1px dashed var(--gw-line);border-radius:9px;text-align:center;color:var(--gw-muted)}
.gw-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.gw-field{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:12px}.gw-field.wide{grid-column:1/-1}.gw-root input,.gw-root textarea{width:100%;padding:8px 10px;background:var(--gw-panel);border:1px solid var(--gw-line);border-radius:7px;outline-offset:2px}.gw-root textarea{resize:vertical;line-height:1.65;min-height:92px}.gw-root textarea.gw-source{min-height:310px;font:12px/1.55 var(--mono,Consolas,monospace);tab-size:2}.gw-new{margin-bottom:14px}.gw-new>summary,.gw-root details>summary{cursor:pointer;font-weight:600}.gw-new[open]>summary{margin-bottom:12px}.gw-note{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.gw-list{display:flex;flex-direction:column;gap:9px}.gw-item{padding:12px;border:1px solid var(--gw-line);border-radius:8px;min-width:0}.gw-item[data-selected=true]{border-color:var(--gw-accent)}.gw-item-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:5px}.gw-item .gw-row{gap:6px;margin-top:9px}.gw-item .gw-btn{font-size:11px;min-height:29px;padding:3px 9px}.gw-json{white-space:pre-wrap;overflow-wrap:anywhere;max-height:330px;overflow:auto;font:11px/1.6 var(--mono,Consolas,monospace);background:var(--gw-soft);padding:12px;border-radius:7px}.gw-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:16px 0}.gw-metrics>div{padding:10px;border:1px solid var(--gw-line);border-radius:7px}.gw-metrics strong{display:block;font-size:17px}.gw-metrics small{font-size:10px;color:var(--gw-muted)}
.gw-viewport{min-height:420px;display:flex;justify-content:center;align-items:center;background:var(--gw-soft);border:1px solid var(--gw-line);border-radius:9px;overflow:hidden;margin:12px 0}.gw-viewport iframe{display:block;width:100%;height:560px;border:0;background:#0b1420}.gw-viewport[data-size=phone] iframe{width:min(390px,100%);height:650px}.gw-preview-empty{max-width:440px;padding:35px;text-align:center;color:var(--gw-muted)}.gw-storage{font-size:10px;color:var(--gw-muted);margin-top:14px}.gw-report-status{font-weight:600}.gw-root dl{margin:0}.gw-root dt{font-size:11px;color:var(--gw-muted);margin-top:11px}.gw-root dd{margin:2px 0 0;overflow-wrap:anywhere}
@media(max-width:900px){.gw-grid{grid-template-columns:1fr}.gw-shell{padding:16px}.gw-viewport{min-height:330px}.gw-viewport iframe{height:480px}.gw-tab small{display:none}}@media(max-width:540px){.gw-shell{padding:12px}.gw-fields{grid-template-columns:1fr}.gw-tab{padding:9px 5px;text-align:center}.gw-tab strong{font-size:12px}.gw-top h2{font-size:20px}.gw-metrics{grid-template-columns:1fr}.gw-card{padding:14px}}
`

/** A product-bound projection of the existing game service, independent of runs. */
export function createGameWorkspace(host: HTMLElement, deps: GameWorkspaceDeps): GameWorkspaceHandle {
  const product = { ...deps.product }
  const apiBase = deps.apiBase.replace(/\/$/, '') + '/game-studio/'
  const storageBase = 'dsh-game-workspace:' + JSON.stringify([product.id, product.workspacePath ?? ''])
  let root: HTMLElement | null = null, mounted = false, generation = 0, readSequence = 0
  let loading = false, busy = '', notice = '', storageNotice = ''
  let projects: any[] = [], state: any = null, revisions: any[] = [], capabilities: any = null
  let slug = '', stage: GameWorkspaceStage = 'overview', selectedBuildId = '', comparison: any = null
  let source = '', reason = '', sourceBaseHash = '', sourceBaseBuildId = '', originalSource = ''
  let goal = '', brief = '', issue = '', issueBuildId = '', manualNotes = ''
  let newTitle = '', newSlug = '', newTemplate = 'cinderwatch', newOpen = false
  let preview: HTMLIFrameElement | null = null, previewBuildId = '', previewSize = 'fit'
  const requests = new Set<AbortController>()
  const reports = new Map<string, any>(), exports = new Map<string, any>()
  const alive = (token: number): boolean => mounted && token === generation
  const currentBuild = (): any => asArray(state?.versions).find(item => item.valid !== false && item.buildCurrent)
  const selectedBuild = (): any => asArray(state?.versions).find(item => item.valid !== false && item.buildId === selectedBuildId)
  const reportFor = (): any => reports.get(slug + '\n' + selectedBuildId)
  const busyOrLoading = (): boolean => !!busy || loading
  const staleDraft = (): boolean => !!sourceBaseHash && !!state && sourceBaseHash !== state.currentHash
  const sourceCanPropose = (): boolean => !!currentBuild() && !!sourceBaseBuildId && sourceBaseBuildId === currentBuild()?.buildId && !staleDraft() && !!source.trim() && source !== originalSource && !!reason.trim()
  function store(key: string, value: any): void {
    try { localStorage.setItem(key, JSON.stringify(value)); storageNotice = '' } catch { storageNotice = '浏览器存储不可用或容量不足；当前草稿仅保留在本页，请复制备份。' }
    const line = root?.querySelector<HTMLElement>('[data-game-storage]')
    if (line) line.textContent = storageNotice || '简报、问题与源码草稿仅保存于本机浏览器；正式候选、构建与报告仍由工程服务保存。'
  }
  function readStore(key: string): any { try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null } }
  function saveDraft(): void {
    store(storageBase, { slug, view: stage })
    if (slug) store(storageBase + ':' + slug, { selectedBuildId, source, reason, sourceBaseHash, sourceBaseBuildId, originalSource, goal, brief, issue, issueBuildId, manualNotes })
  }
  function loadDraft(): void {
    const saved = readStore(storageBase + ':' + slug)
    const text = (key: string): string => typeof saved?.[key] === 'string' ? saved[key] : ''
    selectedBuildId = text('selectedBuildId'); source = text('source'); reason = text('reason'); sourceBaseHash = text('sourceBaseHash'); sourceBaseBuildId = text('sourceBaseBuildId'); originalSource = text('originalSource')
    goal = text('goal'); brief = text('brief'); issue = text('issue'); issueBuildId = text('issueBuildId'); manualNotes = text('manualNotes')
  }
  function notifyState(): void { saveDraft(); deps.onStateChange?.({ slug, buildId: selectedBuildId || undefined, view: stage }) }
  function stopPreview(): void { preview?.remove(); preview = null; previewBuildId = '' }
  function abortRequests(): void { for (const controller of requests) controller.abort(); requests.clear() }
  async function api(action: string, options: { slug?: string; body?: any; query?: Record<string, string> } = {}): Promise<any> {
    const controller = new AbortController(); requests.add(controller)
    const identity = { productId: product.id, ...(options.slug ? { slug: options.slug } : {}) }
    const post = options.body !== undefined
    const url = apiBase + action + (post ? '' : '?' + new URLSearchParams({ ...identity, ...options.query }))
    try {
      const response = await fetch(url, { method: post ? 'POST' : 'GET', signal: controller.signal, headers: { 'content-type': 'application/json' }, ...(post ? { body: JSON.stringify({ ...identity, ...options.body }) } : {}) })
      const value = await response.json()
      if (!response.ok || value.ok === false) throw new Error(value.error ?? 'HTTP ' + response.status)
      return action === 'capabilities' ? value : value.result
    } finally { requests.delete(controller) }
  }
  async function refreshGame(token: number, game: string): Promise<void> {
    const sequence = ++readSequence
    const [next, proposals, currentSource] = await Promise.all([api('state', { slug: game }), api('revisions', { slug: game }), api('source', { slug: game })])
    if (!alive(token) || game !== slug || sequence !== readSequence) return
    state = next; revisions = asArray(proposals)
    const current = currentBuild()
    if (!asArray(next.versions).some(item => item.valid !== false && item.buildId === selectedBuildId)) selectedBuildId = current?.buildId ?? ''
    if (!sourceBaseHash) {
      source = currentSource.source; originalSource = currentSource.source; sourceBaseHash = currentSource.currentHash
      sourceBaseBuildId = currentSource.currentHash === next.currentHash ? current?.buildId ?? '' : ''
    } else if (!sourceBaseBuildId && sourceBaseHash === next.currentHash && source === currentSource.source) sourceBaseBuildId = current?.buildId ?? ''
    if (preview && (stage !== 'play' || previewBuildId !== selectedBuildId)) stopPreview()
    notifyState()
  }
  async function reload(): Promise<void> {
    if (!mounted || loading) return
    const token = generation
    loading = true; render()
    try {
      const [nextProjects, nextCapabilities] = await Promise.all([api('projects'), api('capabilities').catch(() => null)])
      if (!alive(token)) return
      projects = asArray(nextProjects); capabilities = nextCapabilities
      if (slug && !projects.some(item => item.slug === slug)) { stopPreview(); slug = ''; state = null; revisions = [] }
      if (!slug && projects.length === 1) { slug = projects[0].slug; loadDraft() }
      if (slug) await refreshGame(token, slug)
      if (alive(token)) notice = ''
    } catch (error: any) { if (alive(token)) notice = error.name === 'AbortError' ? '读取已取消，可重新刷新。' : '读取失败：' + error.message }
    finally { if (alive(token)) { loading = false; render() } }
  }
  async function chooseGame(nextSlug: string): Promise<void> {
    if (busy || nextSlug === slug || (nextSlug && !projects.some(item => item.slug === nextSlug))) return
    saveDraft(); abortRequests(); stopPreview(); generation += 1
    slug = nextSlug; state = null; revisions = []; comparison = null; notice = ''; loading = false
    loadDraft(); notifyState(); render()
    if (!slug) return
    const token = generation
    loading = true; render()
    try { await refreshGame(token, slug) } catch (error: any) { if (alive(token)) notice = '读取游戏失败：' + error.message }
    finally { if (alive(token)) { loading = false; render() } }
  }
  async function task(label: string, operation: (token: number, game: string) => Promise<void>): Promise<void> {
    if (busyOrLoading()) return
    const token = generation, game = slug
    busy = label; notice = ''; render()
    try { await operation(token, game) }
    catch (error: any) {
      if (alive(token)) {
        let reconciled = false
        try {
          const actualProjects = asArray(await api('projects'))
          if (!alive(token)) return
          projects = actualProjects; reconciled = true
          if (slug) await refreshGame(token, slug)
        } catch { /* Original failure remains actionable. */ }
        if (alive(token)) notice = (error.name === 'AbortError' ? '已取消等待；后台操作可能已经完成。' : '操作未完成：' + error.message + '。') + (reconciled ? '已重新读取工程状态，请查看当前构建与候选。' : '请刷新工程状态后再决定是否重试。')
      }
    } finally { if (alive(token)) { busy = ''; render() } }
  }
  function changeStage(next: GameWorkspaceStage): void {
    if (!stages.some(([key]) => key === next)) return
    if (next !== 'play') stopPreview()
    stage = next; notifyState(); render()
  }
  function btn(action: string, title: string, disabled = false, primary = false, extra = ''): string {
    return `<button type="button" class="gw-btn${primary ? ' primary' : ''}" data-game-action="${action}" ${disabled || (busyOrLoading() && action !== 'preview-close') ? 'disabled' : ''} ${extra}>${esc(title)}</button>`
  }
  function reportHtml(report: any): string {
    if (!report) return '<p class="gw-muted">本页尚未收到此构建的自动试玩报告。历史报告文件保留在工程中，本页暂不汇总完整报告目录。</p>'
    return `<p class="gw-report-status">${report.playtestStatus === 'passed' ? '自动检查通过' : '自动检查未通过'} · <code>${esc(report.buildId)}</code></p><p class="gw-small gw-muted">${esc(report.testedAt ?? '')} · 人工体验尚未由本页验收</p><p class="gw-note">${esc(report.summary ?? '')}</p><dl><dt>报告位置</dt><dd><code>${esc(report.reportPath ?? '服务未返回路径')}</code></dd><dt>未覆盖范围</dt><dd>${esc(asArray(report.unassessed).join('\n') || '以报告明细为准。')}</dd></dl><details><summary>检查、输入与完整回执</summary><pre class="gw-json">${esc(JSON.stringify(report, null, 2))}</pre></details>`
  }
  function overviewHtml(): string {
    const current = currentBuild(), pending = revisions.filter(item => item.status === 'proposed').length
    const next = pending ? '有源码候选等待你主动核验' : !current ? '工作副本已变化，先构建固定版本' : '打开固定版本试玩，记录一个具体修改点'
    return `<div class="gw-grid"><div class="gw-stack"><section class="gw-card gw-hero"><div class="gw-kicker">本轮下一步</div><h3>${esc(next)}</h3><p class="gw-muted">先把一件事做成可玩版本，再决定下一轮。工作面可随时切换，不要求按顺序完成。</p><div class="gw-row">${pending ? btn('go-make', '查看候选', false, true) : current ? btn('go-play', '进入试玩', false, true) : btn('build', '构建当前工程', false, true)}${btn('go-design', '整理玩法目标')}</div></section><section class="gw-card"><h3>这一轮想做到什么</h3><label class="gw-field">本机目标草稿<textarea data-game-field="goal" placeholder="例如：把第一波难度调到新玩家可以理解，并验证一次建造循环。"></textarea></label><p class="gw-small gw-muted">只记录本轮方向；不改变工程规则，也不会自动触发 Agent。</p></section></div><aside class="gw-card"><h3>当前工程事实</h3><div class="gw-metrics"><div><strong>${asArray(state?.versions).filter(item => item.valid !== false).length}</strong><small>固定构建</small></div><div><strong>${pending}</strong><small>待核验候选</small></div><div><strong>${current ? '已构建' : '待构建'}</strong><small>工作副本</small></div></div><dl><dt>模板</dt><dd>${esc(templates[state?.manifest?.templateId]?.title ?? state?.manifest?.templateId)}</dd><dt>当前构建</dt><dd><code>${esc(current?.buildId ?? '工作副本未匹配固定构建')}</code></dd><dt>工作副本指纹</dt><dd><code>${esc(state?.currentHash ?? '')}</code></dd></dl><div class="gw-rule"></div><p class="gw-small gw-muted">自动检查、人工试玩与最终交付分别记录。构建存在不代表玩法已经验收。</p></aside></div>`
  }
  function designHtml(): string {
    return `<div class="gw-grid"><section class="gw-card"><h3>一页玩法简报</h3><p class="gw-muted">把目标、核心循环、输入方式和验收重点写在同一处。完整文档和导图继续使用原编辑器。</p><label class="gw-field">本机简报草稿<textarea data-game-field="brief" rows="13" placeholder="玩家目标：\n核心循环：\n输入方式：\n本轮只改：\n怎样算完成："></textarea></label><div class="gw-row">${deps.openDesign ? btn('open-design', '打开项目设计资料') : ''}${btn('go-make', '进入制作', false, true)}</div></section><aside class="gw-card"><h3>规则合同</h3><p class="gw-small gw-muted">以下来自当前工作副本。源码候选只替换 game.js，不修改这些规则。</p><pre class="gw-json">${esc(JSON.stringify({ template: state?.manifest?.templateId, orientation: state?.manifest?.orientation, rules: state?.manifest?.rules }, null, 2))}</pre><p class="gw-small gw-muted">${esc(templates[state?.manifest?.templateId]?.description ?? '请核对当前工程的模板支持范围。')}</p></aside></div>`
  }
  function sourceDiffHtml(): string {
    if (!sourceBaseHash) return '<p class="gw-small gw-muted">源码基线尚未载入。</p>'
    if (source === originalSource) return '<p class="gw-small gw-muted">草稿与载入基线一致，没有修改。</p>'
    const before = originalSource === '' ? [] : originalSource.split('\n'), after = source === '' ? [] : source.split('\n')
    let prefix = 0, suffix = 0
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
    const range = (title: string, lines: string[]): string => {
      const end = lines.length - suffix, count = end - prefix
      if (!count) return `<p class="gw-small"><strong>${esc(title)}</strong>：此侧为空范围。</p>`
      const shown: string[] = []
      let characters = 0
      // A single linear range comparison, bounded independently on both sides.
      for (let index = prefix; index < end && shown.length < 120 && characters < 16000; index++) {
        const line = lines[index], length = Math.min(line.length, 1000, 16000 - characters)
        const text = line.slice(0, length).replace(/\r/g, '⟨CR⟩')
        shown.push(`${index + 1} | ${text}${length < line.length ? ` … [本行省略 ${line.length - length} 字符]` : ''}`)
        characters += length
      }
      const omitted = count - shown.length
      return `<p class="gw-small"><strong>${esc(title)}</strong>：第 ${prefix + 1}–${end} 行，共 ${count} 行。</p><pre class="gw-json">${esc(shown.join('\n'))}</pre>${omitted ? `<p class="gw-small gw-muted">显示上限：此侧另有 ${omitted} 行未显示。</p>` : ''}`
    }
    return `<p class="gw-small gw-muted">比较载入时的基线与当前本机草稿，未写入工程。省略相同前缀 ${prefix} 行、相同后缀 ${suffix} 行；中间按一个连续修改区间展示，可能包含相同的行。每侧最多显示 120 行、16000 字符，每行最多 1000 字符；回车显示为 ⟨CR⟩。</p>${range('原始基线', before)}${range('当前草稿', after)}`
  }
  function updateSourceDiff(): void {
    const details = root?.querySelector<HTMLDetailsElement>('[data-game-source-diff]')
    const body = details?.querySelector<HTMLElement>('[data-game-source-diff-content]')
    if (details?.open && body) body.innerHTML = sourceDiffHtml()
  }
  function makeHtml(): string {
    const current = currentBuild(), stale = staleDraft()
    const sourceDiff = '<details data-game-source-diff><summary>查看草稿相对基线的修改</summary><div data-game-source-diff-content></div></details>'
    const list = revisions.length ? revisions.map(item => `<article class="gw-item" data-game-candidate-id="${esc(item.candidateId)}"><div class="gw-item-head"><code>${esc(item.candidateId)}</code><span class="gw-id">${esc(item.status)}</span></div><p class="gw-note">${esc(item.reason)}</p><p class="gw-small gw-muted">基线 <code>${esc(item.baseBuildId)}</code> · ${esc(item.createdAt ?? '')}</p><div class="gw-row">${item.status === 'proposed' ? btn('revision-verify', '核验并采用，失败回退', capabilities?.operations?.playtest === false, false, `data-candidate-id="${esc(item.candidateId)}"`) : ''}${['verifying', 'unknown', 'conflict'].includes(item.status) ? btn('revision-recover', '按当前指纹显式对账', !state?.currentHash, false, `data-candidate-id="${esc(item.candidateId)}"`) : ''}</div>${item.error ? `<p class="gw-small gw-muted">${esc(item.error)}</p>` : ''}</article>`).join('') : '<p class="gw-muted">还没有源码候选。保存候选不改变当前工程；核验会实际应用并自动决定采用或回退。</p>'
    return `<div class="gw-grid"><section class="gw-card"><h3>源码修订</h3><p class="gw-muted">编辑完整 game.js；保存候选后，由你主动发起真实浏览器核验。规则合同保持原样。</p>${stale ? '<div class="gw-banner warning">草稿基线已变化；保留了原草稿。请复制需要的改动，再以当前工程重新载入源码。</div>' : ''}<p class="gw-small gw-muted">草稿基线 <code>${esc(sourceBaseBuildId || '尚无已构建基线')}</code> · 指纹 <code>${esc(sourceBaseHash.slice(0, 12))}</code></p><label class="gw-field">候选 game.js<textarea class="gw-source" data-game-field="source" spellcheck="false" ${busyOrLoading() ? 'disabled' : ''}></textarea></label>${sourceDiff}<label class="gw-field">修订原因与对应问题<textarea data-game-field="reason" maxlength="2000" rows="3" ${busyOrLoading() ? 'disabled' : ''}></textarea></label><div class="gw-row">${btn('revision-propose', '保存源码候选', !sourceCanPropose(), true)}${btn('source-reload', '以当前工程重新载入源码（替换草稿）')}${btn('build', '构建工作副本')}</div><p class="gw-small gw-muted">编辑框是本机草稿；构建按钮只构建磁盘上的工程，不会直接应用编辑框。</p></section><aside class="gw-stack"><section class="gw-card"><h3>工程素材与工具</h3><p class="gw-small gw-muted">${esc(templates[state?.manifest?.templateId]?.description ?? '')}</p><p class="gw-small">工作副本已引用槽位：${esc(Object.keys(state?.manifest?.assets ?? {}).join('、') || '无外部素材')}</p><div class="gw-row">${deps.openImages ? btn('open-images', '打开项目图片货架') : ''}${deps.openWorkflow ? btn('open-workflow', '高级工作流') : ''}</div><p class="gw-small gw-muted">图片归档或选中不等于被游戏构建引用。没有消费槽的模板需要另做适配。</p></section><section class="gw-card"><h3>源码候选 · ${revisions.length}</h3><p class="gw-small gw-muted">核验会应用候选、构建并试玩；通过即采用，失败回退。自动试玩不等于人工体验验收。</p><div class="gw-list">${list}</div>${!current ? '<p class="gw-small gw-muted">工作副本需要先构建，才能创建新的源码候选。</p>' : ''}</section></aside></div>`
  }
  function playHtml(): string {
    const built = selectedBuild(), current = currentBuild()
    return `<div class="gw-grid"><section class="gw-card"><div class="gw-item-head"><div><h3>固定版本试玩</h3><code>${esc(selectedBuildId || '先构建或选择一个有效版本')}</code></div><div class="gw-row">${preview ? btn('preview-close', '停止预览') : btn('preview-start', '启动隔离预览', !built, true)}${btn('preview-fit', '适应宽度', !preview)}${btn('preview-phone', '窄屏视口', !preview)}</div></div><div class="gw-viewport" data-game-preview-slot data-size="${esc(previewSize)}"><div class="gw-preview-empty">预览由你主动启动。这里运行选中的固定构建，关闭或离开试玩工作面即停止。</div></div><div class="gw-row">${btn('playtest', '真实浏览器自动检查', !built || built.buildId !== current?.buildId || capabilities?.operations?.playtest === false)}${btn('go-deliver', '查看报告与交付')}</div><p class="gw-small gw-muted">自动检查只支持当前构建；历史版本可预览和导出。${capabilities?.operations?.playtest === false ? '当前浏览器检查运行时不可用，请检查本机配置。' : '自动检查会启动本机浏览器，可能需要一些时间。'}</p></section><aside class="gw-card"><h3>记录一个具体修改点</h3><p class="gw-small gw-muted">问题记录绑定到 <code data-game-issue-build>${esc(issueBuildId || selectedBuildId || '未选择版本')}</code>。输入步骤、实际表现和期望结果。</p><label class="gw-field">本机问题草稿<textarea data-game-field="issue" rows="9" placeholder="操作步骤：\n实际表现：\n期望结果："></textarea></label><div class="gw-row">${deps.onRequestChange ? btn('request-change', '带此版本打开 Agent 修改', !issue.trim() || !issueBuildId, true) : ''}${btn('issue-new', '按所选版本新建记录', !built)}</div><p class="gw-small gw-muted">这是本机草稿，尚未创建正式 Bug 或提交运行。Agent 派发仍需在原界面确认。</p><div class="gw-rule"></div><h3>本页自动报告</h3>${reportHtml(reportFor())}</aside></div>`
  }
  function deliverHtml(): string {
    const built = selectedBuild(), exported = exports.get(slug + '\n' + selectedBuildId)
    const versions = asArray(state?.versions).map(item => `<article class="gw-item" data-game-build-id="${esc(item.buildId)}" data-selected="${item.buildId === selectedBuildId}"><div class="gw-item-head"><code>${esc(item.buildId)}</code><span class="gw-id">${item.valid === false ? '校验失败' : item.buildCurrent ? '当前工程' : '历史快照'}</span></div><p class="gw-small gw-muted">${item.valid === false ? esc(item.error) : esc(item.bytes) + ' bytes · ' + esc(item.template)}</p><div class="gw-row">${btn('select-build', '选中此版', item.valid === false, item.buildId === selectedBuildId, `data-build-id="${esc(item.buildId)}"`)}${btn('compare', '与当前比较', item.valid === false || !currentBuild() || item.buildCurrent, false, `data-build-id="${esc(item.buildId)}"`)}${btn('restore', '恢复此版并保留备份', item.valid === false || item.buildCurrent, false, `data-build-id="${esc(item.buildId)}"`)}</div></article>`).join('')
    const url = apiBase + 'download?' + new URLSearchParams({ productId: product.id, slug, buildId: selectedBuildId })
    return `<div class="gw-grid"><div class="gw-stack"><section class="gw-card"><h3>交付所选固定版本</h3><p>本次目标：<code>${esc(selectedBuildId || '未选择构建')}</code></p><div class="gw-row">${btn('export', '导出此版离线 HTML', !built, true)}${built ? `<a class="gw-btn" data-game-action="download" href="${esc(url)}" download>下载此固定版本</a>` : ''}</div>${exported ? `<div class="gw-banner"><strong>工程内导出完成</strong><br><code>${esc(exported.exportPath)}</code><br>构建 ${esc(exported.buildId)} · 离线 HTML${exported.reused ? ' · 复用已有一致文件' : ''}</div>` : '<p class="gw-small gw-muted">导出在产品工作区中写入固定版本文件；下载直接获取同一不可变构建。这里不发布到网络。</p>'}<label class="gw-field">本机人工试玩记录<textarea data-game-field="manualNotes" placeholder="记录实际设备、操作和未解决问题；本页不会将它视为服务端人工验收。"></textarea></label><p class="gw-small gw-muted">此记录为当前游戏的本机笔记，请在正文注明实际验证的 build；不会自动给其他版本背书。</p></section><section class="gw-card"><h3>自动检查范围与证据</h3>${reportHtml(reportFor())}</section>${comparison ? `<section class="gw-card"><h3>固定版本差异</h3><pre class="gw-json">${esc(JSON.stringify(comparison, null, 2))}</pre></section>` : ''}</div><aside class="gw-card"><h3>版本历史 · ${asArray(state?.versions).length}</h3><p class="gw-small gw-muted">按构建标识排列；不把列表末项当作最新版本。恢复后需重新确认当前状态。</p><div class="gw-list">${versions || '<p class="gw-muted">暂无固定构建。</p>'}</div></aside></div>`
  }
  function renderMarkup(markup: string): void {
    if (!root) return
    const active = preview
    // Removing and reinserting an iframe destroys its browsing context. Keep
    // its entire live ancestor path in place and replace only sibling content.
    if (active && root.contains(active) && stage === 'play' && previewBuildId === selectedBuildId) {
      const temporary = document.createElement('div'); temporary.innerHTML = markup
      const nextSlot = temporary.querySelector('[data-game-preview-slot]')
      const oldShell = root.firstElementChild, nextShell = temporary.firstElementChild
      if (nextSlot && oldShell && nextShell) {
        const patch = (oldNode: Element, nextNode: Element): void => {
          for (const name of oldNode.getAttributeNames()) if (!nextNode.hasAttribute(name)) oldNode.removeAttribute(name)
          for (const name of nextNode.getAttributeNames()) oldNode.setAttribute(name, nextNode.getAttribute(name)!)
          if (oldNode === active.parentElement) return
          const oldChild = Array.from(oldNode.children).find(child => child === active || child.contains(active))!
          const nextChild = Array.from(nextNode.children).find(child => child === nextSlot || child.contains(nextSlot))!
          for (const child of Array.from(oldNode.childNodes)) if (child !== oldChild) child.remove()
          const nextChildren = Array.from(nextNode.childNodes), pivot = nextChildren.indexOf(nextChild)
          for (const child of nextChildren.slice(0, pivot)) oldNode.insertBefore(child, oldChild)
          for (const child of nextChildren.slice(pivot + 1)) oldNode.append(child)
          patch(oldChild, nextChild)
        }
        patch(oldShell, nextShell)
        return
      }
    }
    root.innerHTML = markup
    const slot = root.querySelector('[data-game-preview-slot]')
    if (active && slot && stage === 'play' && previewBuildId === selectedBuildId) slot.replaceChildren(active)
    else if (active) stopPreview()
  }
  function render(): void {
    if (!root || !mounted) return
    const current = currentBuild(), selected = selectedBuild()
    const projectTitle = state?.manifest?.title ?? projects.find(item => item.slug === slug)?.title ?? '选择游戏起点'
    const form = `<details class="gw-card gw-new" data-game-create-form ${newOpen || !projects.length ? 'open' : ''}><summary>创建受支持的游戏起点</summary><p class="gw-small gw-muted">在当前产品工作区内创建独立游戏；创建完成会生成首个固定构建，不自动启动预览。</p><div class="gw-fields"><label class="gw-field">游戏名称<input data-game-field="new-title" maxlength="120" placeholder="例如：守林人的第一夜"></label><label class="gw-field">工程标识（英文小写和连字符）<input data-game-field="new-slug" maxlength="64" placeholder="forest-watch"></label><label class="gw-field wide">真实模板<select data-game-field="new-template">${Object.entries(templates).map(([id, item]) => `<option value="${id}">${esc(item.title)}</option>`).join('')}</select></label></div><p class="gw-small gw-muted">${esc(templates[newTemplate]?.description)}</p><div class="gw-row">${btn('create', '创建并进入游戏', !newTitle.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newSlug), true)}</div></details>`
    const versionOptions = asArray(state?.versions).filter(item => item.valid !== false).map(item => `<option value="${esc(item.buildId)}">${esc(item.buildId)}${item.buildCurrent ? ' · 当前工程' : ' · 历史快照'}</option>`).join('')
    renderMarkup(`<div class="gw-shell" data-game-workspace data-product-id="${esc(product.id)}"><header class="gw-top"><div><div class="gw-kicker">游戏创作台 · ${esc(product.name)}</div><h2>${esc(projectTitle)}</h2><div class="gw-context">产品 <code>${esc(product.id)}</code>${slug ? ` · 工程 <code>${esc(slug)}</code>` : ''}${selected ? ` · 正在查看 <code>${esc(selected.buildId)}</code>${selected.buildCurrent ? '（当前）' : '（历史）'}` : ''}</div></div><div class="gw-row"><select data-game-action="game-select" aria-label="当前产品的游戏工程" ${busyOrLoading() ? 'disabled' : ''}><option value="">选择游戏工程</option>${projects.map(item => `<option data-game-slug="${esc(item.slug)}" value="${esc(item.slug)}">${esc(item.title)} · ${esc(item.slug)}${item.error ? ' · 需要检查' : ''}</option>`).join('')}</select>${btn('reload', '刷新')}${busy ? '<button type="button" class="gw-btn" data-game-action="cancel">取消等待</button>' : ''}</div></header>${notice ? `<div class="gw-banner warning" role="status" data-game-notice>${esc(notice)}</div>` : ''}${loading || busy ? `<div class="gw-banner" role="status">${esc(busy || '读取工程中')}…</div>` : ''}${form}${slug && state ? `<nav class="gw-tabs" aria-label="项目工作面">${stages.map(([key, title, hint]) => `<button type="button" class="gw-tab" data-game-stage-button="${key}" aria-current="${stage === key ? 'page' : 'false'}"><strong>${esc(title)}</strong><small>${esc(hint)}</small></button>`).join('')}</nav><div class="gw-row" style="margin-bottom:14px"><span class="gw-id">${current ? '工作副本已匹配构建' : '工作副本待构建'}</span><label class="gw-small">查看版本 <select data-game-action="build-select" aria-label="固定构建版本" ${busyOrLoading() ? 'disabled' : ''}><option value="">选择固定版本</option>${versionOptions}</select></label></div><main data-game-stage="${stage}">${stage === 'overview' ? overviewHtml() : stage === 'design' ? designHtml() : stage === 'make' ? makeHtml() : stage === 'play' ? playHtml() : deliverHtml()}</main>` : `<div class="gw-empty">${loading ? '正在读取游戏工程…' : slug ? '工程读取失败。请核对工作区后刷新；未触发任何自动修复。' : projects.length ? '选择要继续的游戏工程；所有操作都会显示其产品、工程和固定版本。' : '当前产品还没有已注册的游戏工程。用上方受支持模板创建第一个可玩起点。'}</div>`}<p class="gw-storage" data-game-storage>${esc(storageNotice || '简报、问题与源码草稿仅保存于本机浏览器；正式候选、构建与报告仍由工程服务保存。')}</p></div>`)
    const values: Record<string, string> = { goal, brief, issue, manualNotes, source, reason, 'new-title': newTitle, 'new-slug': newSlug, 'new-template': newTemplate }
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-game-field]').forEach(input => {
      input.value = values[input.dataset.gameField!] ?? ''
      if (input.dataset.gameField!.startsWith('new-')) input.disabled = busyOrLoading()
    })
    const gamePicker = root.querySelector<HTMLSelectElement>('[data-game-action=game-select]'); if (gamePicker) gamePicker.value = slug
    const buildPicker = root.querySelector<HTMLSelectElement>('[data-game-action=build-select]'); if (buildPicker) buildPicker.value = selectedBuildId
    const details = root.querySelector<HTMLDetailsElement>('[data-game-create-form]')
    if (details) {
      const automaticEmptyForm = !projects.length
      details.ontoggle = () => { if (!automaticEmptyForm) newOpen = details.open }
    }
    const sourceDiff = root.querySelector<HTMLDetailsElement>('[data-game-source-diff]')
    if (sourceDiff) sourceDiff.ontoggle = () => { if (sourceDiff.isConnected && sourceDiff.open) updateSourceDiff() }
  }
  async function handleAction(action: string, element: HTMLElement): Promise<void> {
    if (action === 'cancel') { abortRequests(); return }
    if (action === 'preview-close') { stopPreview(); render(); return }
    if (action === 'download' || busyOrLoading()) return
    if (action === 'reload') { await reload(); return }
    if (action.startsWith('go-')) { changeStage(action.slice(3) as GameWorkspaceStage); return }
    if (action === 'open-design') { deps.openDesign?.(); return }
    if (action === 'open-images') { deps.openImages?.(); return }
    if (action === 'open-workflow') { deps.openWorkflow?.(); return }
    if (action === 'preview-fit' || action === 'preview-phone') { previewSize = action === 'preview-phone' ? 'phone' : 'fit'; render(); return }
    if (action === 'preview-start') {
      if (!selectedBuild()) return
      stopPreview(); previewBuildId = selectedBuildId
      preview = document.createElement('iframe'); preview.title = String(state?.manifest?.title ?? slug) + ' · 构建 ' + selectedBuildId
      preview.sandbox.add('allow-scripts'); preview.referrerPolicy = 'no-referrer'
      preview.dataset.gamePreview = ''; preview.dataset.gameBuildId = selectedBuildId
      preview.src = apiBase + 'artifact?' + new URLSearchParams({ productId: product.id, slug, buildId: selectedBuildId })
      notice = ''
      render(); return
    }
    if (action === 'select-build') { const id = element.dataset.buildId ?? ''; if (asArray(state?.versions).some(item => item.valid !== false && item.buildId === id)) { stopPreview(); selectedBuildId = id; notifyState(); render() }; return }
    if (action === 'issue-new') { issue = ''; issueBuildId = selectedBuildId; notifyState(); render(); return }
    if (action === 'request-change') {
      if (!issue.trim() || !issueBuildId || !deps.onRequestChange) return
      const context = { productId: product.id, slug, buildId: issueBuildId, summary: issue.trim() }
      await task('打开修改派发', async token => { await deps.onRequestChange!(context); if (alive(token)) notice = '已打开此固定版本的修改派发，请在派发界面确认目标与执行内容。' }); return
    }
    await task(action === 'playtest' || action === 'revision-verify' ? '真实浏览器核验中' : '处理工程', async (token, game) => {
      if (action === 'create') {
        if (!newTitle.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newSlug)) throw new Error('请输入名称和有效英文工程标识')
        const created = await api('create', { body: { slug: newSlug, title: newTitle.trim(), template: newTemplate } })
        if (!alive(token)) return
        if (game) saveDraft(); stopPreview(); slug = created.slug; state = null; revisions = []; comparison = null; stage = 'play'; loadDraft()
        selectedBuildId = created.buildId; newTitle = ''; newSlug = ''; newOpen = false
        const actualProjects = asArray(await api('projects'))
        if (!alive(token)) return
        projects = actualProjects
        await refreshGame(token, slug)
        if (alive(token)) notice = '游戏与首个构建已创建。点击“启动隔离预览”开始试玩。'
        return
      }
      if (!game || !state) return
      if (action === 'source-reload') {
        await refreshGame(token, game)
        const actual = await api('source', { slug: game })
        if (!alive(token) || slug !== game) return
        source = actual.source; originalSource = actual.source; sourceBaseHash = actual.currentHash
        sourceBaseBuildId = actual.currentHash === state.currentHash ? currentBuild()?.buildId ?? '' : ''; reason = ''; notifyState()
        notice = '源码草稿已替换为当前工程内容。'; return
      }
      if (action === 'compare') {
        const actualComparison = await api('compare', { slug: game, query: { fromBuildId: element.dataset.buildId!, toBuildId: currentBuild().buildId } })
        if (alive(token)) { comparison = actualComparison; notice = '已读取两个固定构建的差异。' }; return
      }
      let result: any
      if (action === 'build') result = await api('build', { slug: game, body: {} })
      else if (action === 'export') result = await api('export', { slug: game, body: { buildId: selectedBuildId } })
      else if (action === 'restore') result = await api('restore', { slug: game, body: { buildId: element.dataset.buildId, expectedCurrentHash: state.currentHash } })
      else if (action === 'playtest') result = await api('playtest', { slug: game, body: { buildId: selectedBuildId, seconds: 20 } })
      else if (action === 'revision-propose') {
        if (!sourceCanPropose()) throw new Error('草稿基线已变化或候选内容不完整')
        result = await api('revision/propose', { slug: game, body: { source, reason, expectedBuildId: sourceBaseBuildId, expectedCurrentHash: sourceBaseHash } })
      } else if (action === 'revision-verify') result = await api('revision/verify', { slug: game, body: { candidateId: element.dataset.candidateId, seconds: 20 } })
      else if (action === 'revision-recover') result = await api('revision/recover', { slug: game, body: { candidateId: element.dataset.candidateId, expectedCurrentHash: state.currentHash } })
      else return
      if (!alive(token) || game !== slug) return
      if (action === 'export') exports.set(game + '\n' + result.buildId, result)
      if (action === 'playtest') reports.set(game + '\n' + result.buildId, result)
      if (result.report?.buildId) reports.set(game + '\n' + result.report.buildId, result.report)
      if (['build', 'restore'].includes(action) || (action === 'revision-verify' && result.accepted)) { stopPreview(); selectedBuildId = result.buildId }
      await refreshGame(token, game)
      if (!alive(token)) return
      notice = action === 'export' ? '已在产品工程内导出所选固定版本。' : action === 'playtest' ? '已收到此构建的自动检查回执；人工试玩尚需另行记录。' : action === 'revision-propose' ? '源码候选已保存；当前工程尚未采用。' : action === 'revision-verify' ? result.accepted ? '候选自动核验通过，已采用。请人工试玩此构建。' : '候选未通过，服务已回退；请核对当前构建与报告。' : action === 'revision-recover' ? '候选状态对账完成，请核对实际工程并重新试玩。' : `工程操作完成，当前构建 ${currentBuild()?.buildId ?? '待构建'}。`
    })
  }
  function updateFormButtons(): void {
    const propose = root?.querySelector<HTMLButtonElement>('[data-game-action=revision-propose]'); if (propose) propose.disabled = busyOrLoading() || !sourceCanPropose()
    const create = root?.querySelector<HTMLButtonElement>('[data-game-action=create]'); if (create) create.disabled = busyOrLoading() || !newTitle.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newSlug)
    const change = root?.querySelector<HTMLButtonElement>('[data-game-action=request-change]'); if (change) change.disabled = busyOrLoading() || !issue.trim() || !issueBuildId
    const issueBuild = root?.querySelector<HTMLElement>('[data-game-issue-build]'); if (issueBuild) issueBuild.textContent = issueBuildId || selectedBuildId || '未选择版本'
  }
  function mount(): void {
    if (mounted) return
    mounted = true; generation += 1
    deps.ensureStyles?.(css)
    root = document.createElement('section'); root.className = 'gw-root'
    if (!deps.ensureStyles) { const style = document.createElement('style'); style.textContent = css; host.append(style); root.addEventListener('gw-destroy', () => style.remove(), { once: true }) }
    const saved = readStore(storageBase)
    slug = deps.initial?.slug ?? (typeof saved?.slug === 'string' ? saved.slug : '')
    const preferredStage = deps.initial?.view ?? saved?.view
    stage = stages.some(([key]) => key === preferredStage) ? preferredStage : 'overview'
    loadDraft()
    root.addEventListener('click', event => {
      const element = (event.target as HTMLElement).closest<HTMLElement>('[data-game-action],[data-game-stage-button]')
      if (!element || !root?.contains(element) || (element as HTMLButtonElement).disabled) return
      if (element.dataset.gameStageButton) { changeStage(element.dataset.gameStageButton as GameWorkspaceStage); return }
      if (element.tagName === 'SELECT') return
      void handleAction(element.dataset.gameAction!, element)
    })
    root.addEventListener('change', event => {
      const input = event.target as HTMLSelectElement
      if (input.dataset.gameAction === 'game-select') { void chooseGame(input.value); return }
      if (input.dataset.gameAction === 'build-select') { if (busyOrLoading()) return; stopPreview(); selectedBuildId = input.value; notifyState(); render(); return }
      if (input.dataset.gameField === 'new-template' && templates[input.value]) { newTemplate = input.value; render() }
    })
    root.addEventListener('input', event => {
      const input = event.target as HTMLInputElement
      switch (input.dataset.gameField) {
        case 'source': source = input.value; break
        case 'reason': reason = input.value; break
        case 'goal': goal = input.value; break
        case 'brief': brief = input.value; break
        case 'manualNotes': manualNotes = input.value; break
        case 'issue': if (!issue && !issueBuildId) issueBuildId = selectedBuildId; issue = input.value; break
        case 'new-title': newTitle = input.value; break
        case 'new-slug': newSlug = input.value; break
        default: return
      }
      saveDraft(); updateFormButtons()
      if (input.dataset.gameField === 'source') updateSourceDiff()
    })
    host.append(root); render(); void reload()
  }
  function destroy(): void {
    saveDraft(); mounted = false; generation += 1; abortRequests(); stopPreview(); loading = false; busy = ''
    root?.dispatchEvent(new Event('gw-destroy')); root?.remove(); root = null
  }
  return { mount, render, reload, destroy, isMounted: () => mounted && root !== null && host.contains(root) }
}
