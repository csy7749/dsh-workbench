import { createElement as el, useState } from 'react'
import { createDevelopmentBridge } from './development-bridge.mjs'

export function mountWorkflowDevelopment(ctx: any, send: (message: unknown) => Promise<unknown>) {
  return installWorkflowDevelopmentPanel(ctx, createDevelopmentBridge(send))
}

/** 开发宿主显式提供桥接控制器时注册面板；不修改生产只读入口。 */
export function installWorkflowDevelopmentPanel(ctx: any, controller: any) {
  if (!controller) throw new Error('development_controller_required')
  const registration = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'workbench.workflow.development', inject: () => ({}) }, () => el(WorkflowDevelopmentPanel, { controller })))
  return () => { if (typeof registration === 'function') registration(); else registration?.dispose?.() }
}

/**
 * 产物展示的安全口径（只在本文件内实现，不改只读入口）：
 * 1. 只用 React 文本节点，任何类型都不走 innerHTML / dangerouslySetInnerHTML；
 * 2. HTML 一律按源码显示，不执行脚本、不加载外部资源，也不插进页面；
 * 3. Markdown 里的图片不加载、链接不生成锚点，只降级成可读文字；
 * 4. 未知类型按文本显示，不做猜测性渲染；
 * 5. 单次渲染有字符上限，超出只显示前段并明确提示。
 */
const MAX_ARTIFACT_CHARS = 20000

const ARTIFACT_LABELS: Record<string, string> = {
  text: '文本', markdown: 'Markdown', json: 'JSON', html: 'HTML', 'file-set': '文件清单', report: '报告',
}

const PRE_STYLE = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 } as const

const clipArtifact = (content: string) => content.length > MAX_ARTIFACT_CHARS
  ? { text: content.slice(0, MAX_ARTIFACT_CHARS), truncated: true }
  : { text: content, truncated: false }

// 单个捕获组包住全部行内语法，split 后奇数位就是标记，偶数位是纯文本。
const INLINE_MARKDOWN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|!\[[^\]\n]*\]\([^)\s]*\)|\[[^\]\n]*\]\([^)\s]*\))/

const inlineToken = (token: string, key: string) => {
  if (token.startsWith('`') && token.endsWith('`') && token.length > 2) return el('code', { key }, token.slice(1, -1))
  if ((token.startsWith('**') || token.startsWith('__')) && token.endsWith(token.slice(0, 2)) && token.length > 4) {
    return el('strong', { key }, token.slice(2, -2))
  }
  const close = token.indexOf(']')
  const label = token.slice(token.startsWith('!') ? 2 : 1, close)
  const target = token.slice(close + 2, -1)
  // 图片不加载、链接不跳转：只把可读文字留在正文里，避免远端请求与意外导航。
  return el('span', { key, style: { opacity: 0.75 } }, token.startsWith('!') ? `[图片 ${label || target}]` : `${label}（${target}）`)
}

// split 保留捕获组后，奇数位是标记、偶数位是纯文本；这个下标语义不能被过滤打乱，
// 所以空片段只在渲染阶段跳过，绝不先 filter 再按位置判断。
const renderInlineMarkdown = (text: string, keyPrefix: string) => text
  .split(INLINE_MARKDOWN)
  .map((part, index) => {
    if (index % 2 === 1) return inlineToken(part, `${keyPrefix}:i:${index}`)
    return part === '' ? null : part
  })
  .filter(part => part !== null)

/** 最小 Markdown 渲染：标题、列表、围栏代码、引用、分隔线、段落；其余按原文文字显示。 */
const renderMarkdown = (source: string, keyPrefix: string) => {
  const lines = source.split(/\r?\n/)
  const blocks: any[] = []
  let cursor = 0
  let counter = 0
  const key = () => `${keyPrefix}:${counter++}`
  const headingRe = /^(#{1,6})\s+(.*)$/
  const bulletRe = /^\s*[-*+]\s+(.*)$/
  const orderedRe = /^\s*\d+[.)]\s+(.*)$/
  const quoteRe = /^\s*>\s?(.*)$/
  const fenceRe = /^\s*```/
  const blockStartRe = /^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (fenceRe.test(line)) {
      const body: string[] = []
      cursor++
      while (cursor < lines.length && !fenceRe.test(lines[cursor])) { body.push(lines[cursor]); cursor++ }
      cursor++ // 结束围栏缺失也能安全收尾
      blocks.push(el('pre', { key: key(), style: { ...PRE_STYLE, padding: 8, borderRadius: 6, background: 'rgba(255,255,255,.06)', overflowX: 'auto' } }, el('code', null, body.join('\n'))))
      continue
    }
    const heading = headingRe.exec(line)
    if (heading !== null) {
      blocks.push(el('div', { key: key(), style: { fontWeight: 600, marginTop: 10 } }, renderInlineMarkdown(heading[2], key())))
      cursor++
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(el('hr', { key: key() })); cursor++; continue }
    if (quoteRe.test(line)) {
      const body: string[] = []
      while (cursor < lines.length) {
        const quoted = quoteRe.exec(lines[cursor])
        if (quoted === null) break
        body.push(quoted[1])
        cursor++
      }
      blocks.push(el('blockquote', { key: key(), style: { margin: '8px 0', paddingLeft: 10, borderLeft: '3px solid rgba(255,255,255,.25)' } }, renderInlineMarkdown(body.join(' '), key())))
      continue
    }
    if (bulletRe.test(line) || orderedRe.test(line)) {
      const ordered = !bulletRe.test(line)
      const matcher = ordered ? orderedRe : bulletRe
      const items: any[] = []
      while (cursor < lines.length) {
        const item = matcher.exec(lines[cursor])
        if (item === null) break
        const itemKey = key()
        items.push(el('li', { key: itemKey }, renderInlineMarkdown(item[1], itemKey)))
        cursor++
      }
      blocks.push(el(ordered ? 'ol' : 'ul', { key: key(), style: { margin: '6px 0', paddingLeft: 20 } }, items))
      continue
    }
    if (line.trim() === '') { cursor++; continue }
    const paragraph: string[] = []
    while (cursor < lines.length && lines[cursor].trim() !== '' && !blockStartRe.test(lines[cursor])) { paragraph.push(lines[cursor]); cursor++ }
    // 兜底推进：任何被 blockStartRe 命中的行都必须落成一段，否则会原地打转。
    if (paragraph.length === 0) { paragraph.push(line); cursor++ }
    blocks.push(el('p', { key: key(), style: { margin: '6px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, renderInlineMarkdown(paragraph.join('\n'), key())))
  }
  return blocks
}

// 被截断的 JSON 必然解析失败，那不是内容错误；这种情况直接显示片段并说明未解析，
// 避免把「显示上限」误报成「JSON 坏了」。
const renderJson = (source: string, keyPrefix: string, truncated = false) => {
  if (truncated) {
    return el('div', { key: keyPrefix },el('p', { style: { margin: '0 0 6px', opacity: 0.75 } }, '内容已截断，以下片段未做 JSON 解析：'), el('pre', { style: PRE_STYLE }, source))
  }
  try { return el('pre', { key: keyPrefix, style: PRE_STYLE }, JSON.stringify(JSON.parse(source), null, 2)) }
  catch { return el('div', null, el('p', { style: { margin: '0 0 6px', opacity: 0.75 } }, 'JSON 解析失败，以下为原文：'), el('pre', { style: PRE_STYLE }, source)) }
}

const renderHtmlSource = (source: string) => el('div', null,
  el('p', { style: { margin: '0 0 6px', opacity: 0.75 } }, 'HTML 源码：只显示文本，不执行脚本、不加载外部资源，也不插入页面。'),
  el('pre', { style: PRE_STYLE }, source),
)

/** 按落库类型选择展示方式；输入只来自已验证快照，仍按不可信文本处理。 */
function ArtifactBody({ artifact }: { artifact: any }) {
  const type = typeof artifact?.artifactType === 'string' ? artifact.artifactType : ''
  const raw = typeof artifact?.content === 'string' ? artifact.content : String(artifact?.content ?? '')
  const { text, truncated } = clipArtifact(raw)
  const label = ARTIFACT_LABELS[type] ?? (type ? `${type}（未知类型，按文本显示）` : '类型未知（按文本显示）')
  const digest = typeof artifact?.contentHash === 'string' ? artifact.contentHash : ''
  const bytes = Number.isSafeInteger(artifact?.bytes) ? artifact.bytes : null
  return el('div', null,
    el('p', { style: { margin: '0 0 6px', fontSize: 12, opacity: 0.8 } },
      `类型 ${label}${bytes === null ? '' : ` · ${bytes} 字节`}${digest ? ` · sha256 ${digest.slice(0, 12)}…` : ''}${artifact?.verified === true ? ' · 已校验' : ''}`),
    artifact?.outputSet ? el('section', null,
      el('p', null, `整组产物 · ${artifact.outputSet.files.length} 个文件 · 集合摘要 ${artifact.outputSetDigest ?? ''}`),
      el('ul', null, ...artifact.outputSet.outputs.map((output: any, index: number) =>
        el('li', { key: `output-${index}` }, `${output.name} · ${output.artifactType} · ${output.editable ? '可编辑' : '只读'} · ${output.files.join('、')}`))),
      el('table', { style: { width: '100%', textAlign: 'left' } },
        el('thead', null, el('tr', null, ...['文件', '类型', '字节', '摘要'].map(label => el('th', { key: label }, label)))),
        el('tbody', null, ...artifact.outputSet.files.map((file: any) => el('tr', { key: file.relativePath },
          el('td', null, file.relativePath), el('td', null, file.mediaType), el('td', null, String(file.bytes)), el('td', null, file.hash))))),
      el('p', null, '此处展示已校验的文件清单；文件内容不会作为网页执行。'),
    ) : type === 'json' ? renderJson(text, 'json', truncated)
      : type === 'markdown' ? el('div', null, renderMarkdown(text, 'md'))
      : type === 'html' ? renderHtmlSource(text)
      : el('pre', { style: PRE_STYLE }, text),
    truncated && !artifact?.outputSet ? el('p', { style: { margin: '6px 0 0', fontSize: 12, opacity: 0.75 } }, `内容超过 ${MAX_ARTIFACT_CHARS} 字符，其余未显示。`) : null,
  )
}

/**
 * 逐文件发布的产品口径（02 §89 S06）：必需发布项没有全部成功之前，
 * 绝不能把半套已发布显示成整套发布完成。所以按采用分组，
 * 每组先给一句集合结论，再逐文件列出目标与状态。
 */
const PUBLISH_STATUS_LABELS: Record<string, string> = {
  pending: '待发布', running: '发布中', succeeded: '已发布',
  failed: '失败', conflict: '冲突', outcome_unknown: '结果未知', superseded: '已被取代',
}
// 需要人工处理的形态；其余未成功状态都算「在途」，两种都不等于完成。
const PUBLISH_NEEDS_ATTENTION = ['failed', 'conflict', 'outcome_unknown']

const publishStatusLabel = (status: unknown) =>
  (typeof status === 'string' ? PUBLISH_STATUS_LABELS[status] ?? `${status}（未知状态）` : '状态未知')

/** 按采用分组并算出集合结论；集合未完成时结论里带必需项计数，不写「已发布」。 */
const groupPublications = (publications: unknown) => {
  const groups = new Map<string, any[]>()
  for (const item of Array.isArray(publications) ? publications : []) {
    const key = typeof item?.adoption_id === 'string' && item.adoption_id ? item.adoption_id : '归属未知'
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.entries()].map(([adoptionId, items]) => {
    const required = items.filter(item => item?.required)
    // superseded 是被后续采用取代的历史项：既不算在途，也不是这套集合的缺口。
    const live = required.filter(item => item.status !== 'superseded')
    const superseded = required.length - live.length
    const succeeded = live.filter(item => item.status === 'succeeded').length
    const attention = live.filter(item => PUBLISH_NEEDS_ATTENTION.includes(item.status)).length
    const open = live.length - succeeded - attention
    const complete = live.length > 0 && succeeded === live.length
    const summary = complete
      ? `整套已发布 · 必需 ${succeeded}/${live.length}${superseded > 0 ? ` · 已取代 ${superseded}` : ''}`
      : live.length === 0
        ? required.length === 0 ? `无必需发布项 · 共 ${items.length} 项` : `已被取代 · 共 ${items.length} 项`
        : `整套未完成 · 必需已发布 ${succeeded}/${live.length}`
          + `${attention > 0 ? ` · 需处理 ${attention}` : ''}${open > 0 ? ` · 在途 ${open}` : ''}`
          + `${superseded > 0 ? ` · 已取代 ${superseded}` : ''}`
    return { adoptionId, items, complete, attention: attention > 0, summary }
  })
}

/** 单个发布项的读数：文件路径优先，整份内容明确标注，不留下空白项。 */
const publishItemLabel = (item: any) => {
  const file = typeof item?.relative_path === 'string' && item.relative_path ? item.relative_path : '（整份内容）'
  const digest = typeof item?.expected_hash === 'string' && item.expected_hash ? ` · 内容 ${item.expected_hash.slice(0, 12)}…` : ''
  return `${file} → ${item?.target} · ${publishStatusLabel(item?.status)} · ${item?.required ? '必需' : '可选'}${digest}`
}

/**
 * 冻结定义里的应发布映射（03 §1 / 02 §89）：文件集节点逐项声明 relativePath，
 * 采用前就能看出每个文件要去哪个目标。三种状态必须分开说，
 * 因为「未声明」让恢复和派生不可用，而「明确空」只是无需发布。
 */
const frozenPublishRows = (definition: any) => {
  const steps = Array.isArray(definition?.steps) ? definition.steps : []
  return steps.map((node: any) => {
    const declared = Array.isArray(node?.publishTargets) ? node.publishTargets : null
    const available = node?.declarationAvailable === true && declared !== null
    const targets = declared ?? []
    const files = targets.filter((item: any) => typeof item?.relativePath === 'string' && item.relativePath)
    const state = !available ? '未声明（不可据此恢复或派生）'
      : targets.length === 0 ? '明确空目标（无需发布）'
        : files.length === 0 ? `整份内容 ${targets.length} 项`
          : `逐文件 ${files.length} 项`
    return { nodeId: node?.nodeId ?? '(未知步骤)', kind: node?.nodeKind ?? '', state, targets, available }
  })
}

/**
 * 「要求 AI 修订」的读数（04 §43）：修订的基准是已保存的草稿版本，产出是独立候选，
 * 候选不写进草稿、也不代表已采用。所以页面必须把三件事分开显示：
 * 请求状态、候选内容与摘要、候选和当前草稿的对照结论；应用只能由用户显式点击。
 */
const REVISION_STATUS_LABELS: Record<string, string> = {
  requested: '已受理', producing: '产出中', ready: '候选已就绪',
  applied: '已应用到草稿', superseded: '基准失效（未应用）', failed: '产出失败',
}

const revisionStatusLabel = (status: unknown) =>
  typeof status === 'string' ? REVISION_STATUS_LABELS[status] ?? `${status}（未知状态）` : '状态未知'

/** 候选集合描述来自库里的正文；解析失败只说坏在哪，不猜内容。 */
const candidateSet = (candidate: any) => {
  if (candidate?.artifactType !== 'file-set') return null
  try {
    const parsed = JSON.parse(String(candidate?.content ?? ''))
    return parsed && Array.isArray(parsed.files) && Array.isArray(parsed.outputs) ? parsed : null
  } catch { return null }
}

/** 候选与当前草稿的对照：只比能确定的事实，逐文件比 hash。 */
const compareCandidate = (candidate: any, content: string, draftSet: any) => {
  const set = candidateSet(candidate)
  if (!set) {
    if (typeof candidate?.content !== 'string') return '没有候选内容'
    return candidate.content === content ? '与当前编辑内容一致' : '与当前编辑内容不同'
  }
  if (!draftSet?.files) return '当前草稿不是同一份文件集合，无法逐文件对照'
  const mine = new Map(draftSet.files.map((file: any) => [file.relativePath, file]))
  const changed = set.files.filter((file: any) => mine.get(file.relativePath)?.hash !== file.hash)
  const onlyDraft = draftSet.files.filter((file: any) => !set.files.some((item: any) => item.relativePath === file.relativePath))
  if (changed.length === 0 && onlyDraft.length === 0) return `与当前草稿同一份集合 · ${set.files.length} 个文件`
  return `与当前草稿不同 · 变动 ${changed.length} 个${onlyDraft.length ? ` · 草稿独有 ${onlyDraft.length} 个` : ''}`
}

/** 显式注入进程内开发控制器；生产只读入口不会自动挂载此组件。 */
export function WorkflowDevelopmentPanel({ controller }: { controller: any }) {
  const [runId, setRunId] = useState('')
  const [view, setView] = useState<any>(null)
  const [content, setContent] = useState('')
  const [reason, setReason] = useState('')
  const [selected, setSelected] = useState('')
  const [comparison, setComparison] = useState<any>(null)
  const [artifact, setArtifact] = useState<any>(null)
  const [eventPage, setEventPage] = useState<any>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [draftSet, setDraftSet] = useState<any>(null)
  const [savedDraft, setSavedDraft] = useState<any>(null)
  const [draftBaseline, setDraftBaseline] = useState<any>(null)
  const [draftConflict, setDraftConflict] = useState<any>(null)
  const [validation, setValidation] = useState<any>(null)
  const [filePath, setFilePath] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [fileDirty, setFileDirty] = useState(false)
  const [fileLoaded, setFileLoaded] = useState(false)
  const [revisionNote, setRevisionNote] = useState('')
  const [retainedFiles, setRetainedFiles] = useState<string[]>([])
  const task = view?.tasks?.find((item: any) => item.status === 'open')
  const act = async (operation: () => any) => {
    if (busy) return
    setBusy(true); setError('')
    try { await operation() } catch (cause: any) { setError(cause.detail ?? cause.message ?? String(cause)) }
    finally { setBusy(false) }
  }
  const refresh = async (id = runId) => {
    const next = await controller.read(id)
    const open = next.tasks.find((item: any) => item.status === 'open')
    const saved = open ? await controller.draft(id, open.id) : null
    const nextSet = saved?.outputSet ? (saved.draft ? JSON.parse(saved.draft.content) : saved.outputSet) : null
    const source = saved?.binding.inputs[0]
    const nextContent = saved?.draft?.content ?? saved?.currentInput?.content ?? (source ? (await controller.artifact(id, source.snapshotId)).artifact.content : '')
    // Commit the refreshed editor only after every read succeeds.
    setValidation(null); setSavedDraft(saved?.draft ?? null); setDraftBaseline(saved); setDraftConflict(null)
    setContent(nextContent); setRetainedFiles([])
    setEventPage(null)
    setComparison(null)
    setArtifact(null)
    setDraftSet(null); setFilePath(''); setFileContent(''); setFileDirty(false); setFileLoaded(false)
    setDraftSet(nextSet)
    setView(next)
  }
  const button = (label: string, operation: () => any, disabled = false, allowDirty = false) => el('button', { type: 'button', disabled: busy || disabled || (fileDirty && !allowDirty), onClick: () => void act(operation) }, label)
  const advanceAndRefresh = async () => {
    let executionError: any
    try { await controller.advance(runId) } catch (cause) { executionError = cause }
    try { await refresh() } catch (cause: any) {
      if (!executionError) throw cause
      throw new Error(`${executionError.detail ?? executionError.message ?? String(executionError)}；状态刷新失败：${cause.detail ?? cause.message ?? String(cause)}`)
    }
    if (executionError) throw executionError
  }
  const saveEditor = async (rebind = false) => {
    try {
      await controller[rebind ? 'rebind' : 'save']({ runId, taskId: task.id, content, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision })
    } catch (cause) {
      // Read the competing version without replacing local editor state.
      try { setDraftConflict(await controller.draft(runId, task.id)) } catch { /* original error remains visible */ }
      throw cause
    }
    await refresh()
  }
  const saveFileEditor = async () => {
    try {
      await controller.saveFile({ runId, taskId: task.id, relativePath: filePath, content: fileContent, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision })
    } catch (cause) {
      try { setDraftConflict(await controller.draft(runId, task.id)) } catch { /* preserve local file and original failure */ }
      throw cause
    }
    await refresh()
  }
  const validate = async () => {
    setValidation(null)
    if (reviewBlocked) throw new Error('当前输入绑定不可用或已过期，不能检查。')
    try {
      const report = await controller.validate({ runId, taskId: task.id, content, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision })
      setValidation(report)
      return report
    } catch (error) {
      try { await refresh() } catch (refreshError: any) { throw new Error(`${(error as any).message ?? String(error)}；阻断记录刷新失败：${refreshError.message ?? String(refreshError)}`) }
      throw error
    }
  }
  const confirm = async (intent: string) => {
    if (reviewBlocked) throw new Error('当前输入绑定不可用或已过期，不能确认。')
    if (fileDirty) throw new Error('请先保存文件修改，再确认整组草稿。')
    await controller.confirm({ taskId: task.id, content, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision, inputFingerprint: task.input_hash, expectedRunRevision: view.run.revision, validationReportId: validation?.id ?? null, intent })
    setContent(''); await advanceAndRefresh()
  }
  /**
   * 修订请求的门槛：基准必须是「已保存的草稿版本」，而不只是输入框里现在写着什么。
   * 否则用户以为修订基于眼前的文字，实际存的却是上一版——未保存的编辑被悄悄丢掉了。
   */
  const editorMatchesDraft = Boolean(savedDraft) && (draftSet ? true : savedDraft.content === content)
  const requestRevision = async () => {
    if (reviewBlocked) throw new Error('当前输入绑定不可用或已过期，不能请求修订。')
    if (fileDirty) throw new Error('请先保存或放弃文件修改，再请求修订。')
    if (!savedDraft) throw new Error('请先保存当前编辑：修订以已保存的草稿版本为基准，未保存的内容不会被带进去。')
    if (!editorMatchesDraft) throw new Error('当前编辑内容与已保存草稿不同：请先保存或放弃修改，再请求修订。')
    if (!revisionNote.trim()) throw new Error('请填写修订意见，说明希望改什么。')
    await controller.requestRevision({
      runId, taskId: task.id, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision,
      note: revisionNote, retained: draftSet ? retainedFiles : [],
    })
    setRevisionNote(''); setRetainedFiles([])
    await refresh()
  }
  const applyRevision = async (requestId: string) => {
    if (fileDirty || !editorMatchesDraft) throw new Error('请先保存或放弃当前编辑，再应用修订候选。')
    await controller.applyRevision({ runId, requestId })
    setValidation(null)
    await refresh()
  }
  const reviewIndex = view?.steps.findIndex((step: any) => step.id === task?.step_id) ?? -1
  const reviewStep = reviewIndex >= 0 ? view.steps[reviewIndex] : null
  const downstream = reviewIndex >= 0 ? view.steps.slice(reviewIndex + 1) : []
  const reviewDefinition = view?.definition?.steps?.find((node: any) => node.nodeId === reviewStep?.node_id)
  const reviewBlocked = !task?.bindingUsable || !reviewStep || Boolean(reviewStep.stale) || draftBaseline?.baselineCurrent === false
  const history = view?.adoptions ?? []
  const chosen = history.find((item: any) => item.adoptionId === selected)
  const chosenStep = view?.steps.find((item: any) => item.id === chosen?.stepId)
  const taskRevisions = (Array.isArray(view?.revisions) ? view.revisions : [])
    .filter((item: any) => item?.taskId === task?.id)
    .slice()
    .sort((left: any, right: any) => String(right?.updatedAt ?? right?.createdAt ?? '').localeCompare(String(left?.updatedAt ?? left?.createdAt ?? '')))
  // 可逐文件编辑/保留的集合文件：与草稿编辑下拉共用同一口径，避免两处筛选条件漂移。
  const editableFiles = draftSet
    ? draftSet.files.filter((file: any) => (file.mediaType.startsWith('text/') || file.mediaType === 'application/json')
      && draftSet.outputs.some((output: any) => output.editable && output.files.includes(file.relativePath)))
    : []
  return el('section', { 'data-workflow-development': '', style: { padding: 16, overflow: 'auto', height: '100%', color: 'inherit' } },
    el('h3', null, '工作流操作沙盒'),
    el('p', null, '使用独立临时数据和假执行器；生成、修订及发布均为演练，不调用真实模型，不写正式业务。当前确认不代表正式人工授权，关闭或重启宿主后不自动恢复本次沙盒。'),
    el('input', { 'aria-label': '运行标识', value: runId, disabled: busy || fileDirty, onChange: (event: any) => { setRunId(event.target.value); setValidation(null); setView(null); setSelected(''); setComparison(null); setArtifact(null); setEventPage(null); setContent(''); setReason(''); setDraftSet(null); setFilePath(''); setFileContent(''); setFileDirty(false); setFileLoaded(false) } }),
    button('读取运行', () => refresh(), !runId),
    button('新建含人工流程', async () => { await controller.start({ runId, human: true }); await advanceAndRefresh() }, !runId),
    button('新建自动流程', async () => { await controller.start({ runId, human: false }); await advanceAndRefresh() }, !runId),
    button('新建文件集审核示例', async () => { await controller.start({ runId, collection: true }); await advanceAndRefresh() }, !runId),
    button('新建必需检查示例', async () => { await controller.start({ runId, human: true, checked: true }); await advanceAndRefresh() }, !runId),
    button('新建文件集必需检查示例', async () => { await controller.start({ runId, collection: true, checked: true }); await advanceAndRefresh() }, !runId),
    error ? el('p', { role: 'alert' }, error) : null,
    view ? el('div', null,
      el('p', null, `运行：${view.run.status}；原因：${view.run.pause_reason ?? '无'}`),
      button('暂停', async () => { await controller.command(runId, 'pause', view.run.revision); await refresh() }),
      button('继续', async () => { await controller.command(runId, 'resume', view.run.revision); await advanceAndRefresh() }),
      button('取消', async () => { await controller.command(runId, 'cancel', view.run.revision); await refresh() }),
      el('ol', null, view.steps.map((step: any) => el('li', { key: step.id }, `${step.node_id} · ${step.state}${step.stale ? ' · 输入已过期' : ''}`))),
      task ? el('div', null,
        el('h4', null, '人工编辑'),
        el('p', null, reviewDefinition?.validationDeclarationAvailable ? `定义要求的检查：${reviewDefinition.requiredChecks.length ? reviewDefinition.requiredChecks.join('、') : '明确无必需检查'}（清单不代表检查已通过）` : '定义未声明必需检查；不能据此视为无需验证。'),
        el('p', null, `待办版本：${task.task_revision}；输入绑定版本：${task.bindingVersion ?? '不可用'}`),
        el('p', null, savedDraft ? `已保存草稿版本：${savedDraft.revision}${savedDraft.content !== content ? '；当前编辑内容与此版本不同，确认将采用当前编辑内容。' : '；当前内容与此版本一致。'}` : '尚无已保存草稿；确认将采用当前编辑内容。'),
        el('p', null, `后续步骤：${downstream.length ? downstream.map((step: any) => step.node_id).join(' → ') : '无'}`),
        reviewBlocked ? el('p', { role: 'alert' }, '当前输入绑定不可用或已过期，不能确认。请核对输入与历史版本。') : null,
        draftBaseline?.baselineCurrent === false ? el('details', { open: true },
          el('summary', null, `草稿基于旧输入版本 ${draftBaseline.draftBindingVersion}；当前输入版本 ${task.bindingVersion}。请核对差异后显式重新绑定。`),
          el('p', null, '重新绑定保留当前编辑并保存为新草稿版本；旧草稿继续留存，检查报告需重新生成。文件集仍须满足当前输入的只读文件与声明约束。'),
          el('h5', null, '保留的旧草稿'), el('pre', { style: PRE_STYLE }, clipArtifact(savedDraft?.content ?? '').text),
          el('h5', null, '当前输入'), el('pre', { style: PRE_STYLE }, clipArtifact(draftBaseline.currentInput?.content ?? '').text),
          el('p', null, savedDraft?.content === draftBaseline.currentInput?.content ? '两份内容一致；输入绑定版本仍需重新确认。' : '内容存在差异；不会自动合并或覆盖。'),
        ) : null,
        button('读取冻结输入', async () => {
          const saved = await controller.draft(runId, task.id)
          const frozen = saved.currentInput
          setValidation(null); setContent(frozen?.content ?? '')
          setDraftSet(frozen?.outputSet ?? null); setFilePath(''); setFileContent(''); setFileDirty(false); setFileLoaded(false)
        }),
        draftSet ? el('div', null,
          el('p', null, '选择集合中的可编辑文本文件，填写完整替换内容后保存；其他文件保持原样。'),
          el('select', { 'aria-label': '编辑文件', value: filePath, disabled: busy || fileDirty, onChange: (event: any) => { setFilePath(event.target.value); setFileContent(''); setFileDirty(false); setFileLoaded(false) } },
            el('option', { value: '' }, '选择文件'),
            ...editableFiles.map((file: any) => el('option', { key: file.relativePath, value: file.relativePath }, file.relativePath))),
          button('读取当前文件内容', async () => { const file = await controller.readFile({ runId, taskId: task.id, relativePath: filePath, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision }); setFileContent(file.content); setFileDirty(false); setFileLoaded(true) }, !filePath || fileDirty),
          el('textarea', { 'aria-label': '文件完整替换内容', rows: 8, value: fileContent, disabled: busy || !filePath || !fileLoaded, onChange: (event: any) => { setFileContent(event.target.value); setFileDirty(true) } }),
          button('保存文件到整组草稿', () => saveFileEditor(), !filePath || !fileLoaded || !fileDirty, true),
        ) : null,
        el('textarea', { readOnly: Boolean(draftSet), disabled: busy, 'aria-label': '人工草稿', rows: 12, style: { width: '100%' }, value: content, onChange: (event: any) => { setContent(event.target.value); setValidation(null) } }),
        button('检查当前草稿', () => validate(), fileDirty || reviewBlocked),
         validation ? el('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(validation.report ?? validation, null, 2)) : null,
         button('保存草稿', () => saveEditor(), reviewBlocked),
         draftBaseline?.baselineCurrent === false && savedDraft ? button('以当前输入重新绑定草稿', () => saveEditor(true), !task?.bindingUsable || Boolean(reviewStep?.stale) || fileDirty) : null,
        draftConflict ? el('details', { open: true },
          el('summary', null, '保存未成功；本地编辑已保留。请比较服务器版本后选择恢复方式。'),
          el('h5', null, '服务器当前草稿'), el('pre', { style: PRE_STYLE }, clipArtifact(draftConflict.draft?.content ?? draftConflict.currentInput?.content ?? '').text),
          el('h5', null, '本地未保存内容'), el('pre', { style: PRE_STYLE }, clipArtifact(fileDirty ? fileContent : content).text),
          button('保留本地编辑，更新版本后继续编辑', async () => {
            const next = await controller.read(runId)
            const latest = await controller.draft(runId, task.id)
            if (!next.tasks.some((item: any) => item.id === task.id && item.status === 'open')) throw new Error('待办已关闭；本地内容仍保留，请复制后读取新状态。')
            const set = draftSet ? (latest.draft ? JSON.parse(latest.draft.content) : latest.outputSet) : null
            if (fileDirty && !set?.files?.some((file: any) => file.relativePath === filePath)) throw new Error('服务器已移除此文件；本地文件编辑保留，请复制内容后重新选择。')
            setView(next); setSavedDraft(latest.draft ?? null); setDraftBaseline(latest); setValidation(null); setDraftConflict(null)
            if (draftSet) {
              setDraftSet(set); setContent(latest.draft?.content ?? latest.currentInput?.content ?? '')
            }
          }, false, true),
          button('明确放弃本地编辑并读取服务器版本', () => refresh(), false, true),
        ) : null,
        fileDirty ? el('p', { role: 'status' }, '文件修改尚未保存；保存或明确放弃后才能继续操作。') : null,
        fileDirty ? button('放弃未保存的文件修改', () => { setFileContent(''); setFilePath(''); setFileDirty(false); setFileLoaded(false) }, false, true) : null,
        button('确认并继续', () => confirm('continue'), fileDirty || reviewBlocked),
        button('确认并暂停', () => confirm('pause'), fileDirty || reviewBlocked),
        el('h4', null, '要求 AI 修订'),
        el('p', null, '修订以已保存的草稿版本为基准，产出独立候选：它不会改写当前草稿，也不等于已采用。只有你点击「应用到草稿」才写进草稿。'),
        el('p', null, savedDraft ? `修订基准：已保存草稿版本 ${savedDraft.revision}${editorMatchesDraft ? '（与当前内容一致）' : '（当前编辑内容与之不同，请先保存或放弃修改）'}` : '尚无已保存草稿：请先保存当前编辑，再请求修订。'),
        el('textarea', { 'aria-label': '修订意见', rows: 4, style: { width: '100%' }, disabled: busy, value: revisionNote, onChange: (event: any) => setRevisionNote(event.target.value) }),
        draftSet
          ? el('div', null,
            el('p', { style: { margin: '0 0 4px' } }, '保留项：勾选的文件要求修订时保持原样（不允许改动）；不勾选的文件可以调整。不可编辑文件本来就不会被改动。'),
            ...editableFiles.map((file: any) => el('label', { key: `retain:${file.relativePath}`, style: { display: 'block' } },
              el('input', {
                type: 'checkbox', checked: retainedFiles.includes(file.relativePath), disabled: busy,
                onChange: () => setRetainedFiles(current => current.includes(file.relativePath)
                  ? current.filter(item => item !== file.relativePath)
                  : [...current, file.relativePath]),
              }),
              ` 保留 ${file.relativePath}`)))
          : el('p', null, '文本产物没有可勾选的保留文件项；修订意见里可以直接说明哪一段不要改。'),
        button('请求修订', () => requestRevision(), fileDirty || reviewBlocked || !editorMatchesDraft || !revisionNote.trim()),
        el('h4', null, '修订候选'),
        el('p', null, '候选按请求分开保存；基准失效或产出失败也保留记录。只有「候选已就绪」的请求可以应用。'),
        taskRevisions.length === 0
          ? el('p', { style: { margin: '0 0 6px', fontSize: 12, opacity: 0.75 } }, '这个待办还没有修订请求。')
          : el('div', null, ...taskRevisions.map((item: any) => {
            const candidate = item?.candidate ?? {}
            const set = candidateSet(candidate)
            const requestId = item?.id ?? item?.requestId
            return el('details', { key: requestId ?? `${item?.status}:${item?.createdAt}`, open: item?.status === 'ready' },
              el('summary', null, `${revisionStatusLabel(item?.status)} · ${item?.updatedAt ?? item?.createdAt ?? '时间未知'}${item?.errorCode ? ` · ${item.errorCode}` : ''}`),
              el('p', null, `候选内容摘要：${typeof candidate.contentHash === 'string' ? `${candidate.contentHash.slice(0, 12)}…` : '未产出'}`),
              el('p', null, `基准内容摘要：${typeof item?.baseContentHash === 'string' ? `${item.baseContentHash.slice(0, 12)}…` : '未记录'}`),
              el('p', null, `对照：${compareCandidate(candidate, content, draftSet)}`),
              item?.reportId ? el('p', null, `候选报告：${item.reportId}`) : null,
              item?.errorCode ? el('p', { role: 'alert' }, `产出失败：${item.errorCode}（候选内容可能不完整，不能应用）`) : null,
               item?.status === 'failed' ? button('以同一意见新建重试请求', async () => {
                 await controller.requestRevision({ runId, taskId: task.id, expectedBindingVersion: task.bindingVersion, expectedTaskRevision: task.task_revision, note: item.opinion.note, retained: item.opinion.retained, retry: true })
                 await refresh()
               }, reviewBlocked || !editorMatchesDraft || fileDirty || item.taskRevision !== task.task_revision || item.bindingVersion !== task.bindingVersion) : null,
              set
                ? el('div', null,
                  el('table', { style: { width: '100%', textAlign: 'left' } },
                    el('thead', null, el('tr', null, ...['候选文件', '类型', '字节', '摘要'].map(label => el('th', { key: label }, label)))),
                    el('tbody', null, ...set.files.map((file: any) => el('tr', { key: `candidate:${file.relativePath}` },
                      el('td', null, file.relativePath), el('td', null, String(file.mediaType)), el('td', null, String(file.bytes)), el('td', null, `${String(file.hash).slice(0, 12)}…`))))),
                  el('p', { style: { margin: '6px 0 0', fontSize: 12, opacity: 0.75 } }, `集合摘要 ${typeof candidate.outputSetDigest === 'string' ? candidate.outputSetDigest : (typeof set.digest === 'string' ? set.digest : '未记录')}`))
                : typeof candidate.content === 'string'
                  ? el('pre', { style: { ...PRE_STYLE, padding: 8, borderRadius: 6, background: 'rgba(255,255,255,.06)', overflowX: 'auto' } }, clipArtifact(candidate.content).text)
                  : el('p', null, '没有候选内容。'),
              button('应用到草稿', () => applyRevision(requestId), !requestId || item?.status !== 'ready' || fileDirty || !editorMatchesDraft),
            )
          })),
      ) : null,
      el('h4', null, '检查阻断记录'),
      el('p', null, '这些记录表示检查未能形成可验证摘要，不代表一份失败报告。'),
      ...(view.blockedValidations ?? []).map((event: any) => el('details', { key: event.seq },
        el('summary', null, `${event.type} · ${event.seq}`),
        el('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(event, null, 2)))),
      el('h4', null, '历史检查报告'),
      el('p', null, '历史报告不自动用于当前确认；修改草稿后请重新检查。'),
      ...(view.validations ?? []).map((report: any) => el('details', { key: report.id },
        el('summary', null, `${report.stepId} · ${report.status} · ${report.producedAt ?? report.createdAt}`),
        el('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(report, null, 2)))),
      el('h4', null, '冻结步骤与应发布目标'),
      el('p', null, '明确空目标表示无需发布；声明缺失表示不可据此恢复或派生。'),
      view.definition?.available === false
        ? el('p', null, `冻结定义不可读：${view.definition.error ?? 'definition_invalid'}`)
        : el('div', null, ...frozenPublishRows(view.definition).map((row: any) => el('section', { key: row.nodeId, style: { margin: '0 0 8px' } },
          el('p', { style: { margin: '0 0 4px', fontWeight: 600 } }, `${row.nodeId}${row.kind ? ` · ${row.kind}` : ''} · ${row.state}`),
          row.targets.length === 0 ? null : el('table', { style: { width: '100%', textAlign: 'left' } },
            el('thead', null, el('tr', null, ...['文件', '目标', '必需'].map(label => el('th', { key: label }, label)))),
            el('tbody', null, ...row.targets.map((item: any, index: number) => el('tr', { key: `${row.nodeId}:${index}` },
              el('td', null, typeof item?.relativePath === 'string' && item.relativePath ? item.relativePath : '（整份内容）'),
              el('td', null, String(item?.target ?? '')),
              el('td', null, item?.required ? '必需' : '可选'))))),
        ))),
      el('details', null,
        el('summary', null, '冻结定义原文'),
        el('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(view.definition, null, 2))),
      el('h4', null, '冻结资料预检'),
      el('p', null, '仅检查已捕获的外部资料与预算；实际执行还会检查本次上游输入。'),
      el('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(view.contextPreflight, null, 2)),
      el('h4', null, '执行与上下文记录'),
      button('读取运行记录', async () => setEventPage(await controller.events(runId))),
      button('下一页记录', async () => setEventPage(await controller.events(runId, eventPage.nextCursor)), !eventPage?.hasMore),
      eventPage ? el('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(eventPage.events, null, 2)) : null,
      el('h4', null, '待处理运行事项'),
      el('p', null, `扫描时间：${view.recovery?.scannedAt ?? '未扫描'}；扫描只读，不会自动重试。`),
      el('ul', null, (view.recovery?.items ?? []).map((item: any, index: number) => el('li', { key: index }, `${item.kind} · ${item.stepId ?? item.outboxId ?? item.runId}${item.reason ? ` · ${item.reason}` : ''}`))),
      el('h4', null, '发布状态'),
      el('p', null, '按采用分组逐文件列出目标与状态；必需项没有全部成功前只显示「整套未完成」。声明未知仅隔离状态，对账从宿主适配器读取实际目标，不会自动重发。请在下方原因栏填写隔离原因。'),
      (view.publications ?? []).length === 0
        ? el('p', { style: { margin: '0 0 6px', fontSize: 12, opacity: 0.75 } }, '尚未产生发布项。')
        : el('div', null, ...groupPublications(view.publications).map((group: any) => el('section', { key: group.adoptionId, style: { margin: '0 0 10px' } },
          el('p', { style: { margin: '0 0 4px', fontWeight: 600, opacity: group.complete ? 0.85 : 1 } }, group.summary),
          el('p', { style: { margin: '0 0 4px', fontSize: 12, opacity: 0.7 } }, `采用 ${group.adoptionId}`),
          el('ul', null, ...group.items.map((item: any) => el('li', { key: item.id },
            `${publishItemLabel(item)}${item.reason ? ` · ${item.reason}` : ''}`,
            button('发布此文件', async () => { await controller.publish({ outboxId: item.id }); await refresh() }, item.status !== 'pending'),
            button('重新排队发布', async () => {
              await controller.retryPublish({ outboxId: item.id }); await refresh()
            }, !['failed', 'conflict'].includes(item.status)),
            button('声明发布结果未知', async () => {
              await controller.declarePublishUnknown({ outboxId: item.id, claimGeneration: item.claim_generation, reason })
              await refresh()
            }, item.status !== 'running' || !reason.trim()),
            button('核对实际发布效果', async () => {
              await controller.reconcilePublishEffect({ outboxId: item.id, claimGeneration: item.claim_generation })
              await refresh()
            }, item.status !== 'outcome_unknown'),
          ))),
        ))),
      el('h4', null, '版本历史'),
      el('select', { 'aria-label': '历史采用', value: selected, disabled: busy, onChange: (event: any) => { setSelected(event.target.value); setComparison(null); setArtifact(null) } },
        el('option', { value: '' }, '选择历史版本'),
        ...history.map((item: any) => el('option', { key: item.adoptionId, value: item.adoptionId }, `${item.stepId} · ${item.createdAt}`))),
      el('input', { 'aria-label': '恢复或派生原因', placeholder: '填写恢复或派生原因', value: reason, onChange: (event: any) => setReason(event.target.value) }),
      button('读取版本原文', async () => { setArtifact((await controller.artifact(runId, chosen.snapshotId)).artifact) }, !chosen),
      artifact ? el('div', null,
        el('h4', null, '不可变版本内容'),
        el(ArtifactBody, { artifact }),
      ) : null,
      button('与当前版本比较', async () => {
        const current = history.find((item: any) => item.adoptionId === chosenStep.current_adoption_id)
        setComparison(await controller.compare({ runId, leftId: chosen.snapshotId, rightId: current.snapshotId }))
      }, !chosen || !chosenStep?.current_adoption_id),
      button('重跑所选版本所在步骤', async () => {
        await controller.rerun({ runId, stepId: chosen.stepId, expectedRunRevision: view.run.revision, expectedStepRevision: chosenStep.revision })
        setComparison(null); setArtifact(null); await refresh()
      }, !chosen || chosenStep?.state !== 'succeeded' || view.run.status !== 'paused'),
      button('恢复选中版本', async () => { await controller.restore({ runId, stepId: chosen.stepId, sourceAdoptionId: chosen.adoptionId, reason, expectedRunRevision: view.run.revision, expectedStepRevision: chosenStep.revision }); await refresh() }, !chosen || !reason.trim() || view.run.status !== 'paused'),
      button('派生新运行', async () => {
        const newRunId = `${runId}:fork:${Date.now()}`
        await controller.fork({ runId, newRunId, reason, expectedRunRevision: view.run.revision })
        setRunId(newRunId); setView(null); setSelected(''); setComparison(null); setArtifact(null); setContent(''); await refresh(newRunId)
      }, !reason.trim() || !['completed', 'failed', 'cancelled'].includes(view.run.status)),
      comparison ? el('pre', { style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(comparison, null, 2)) : null,
    ) : null,
  )
}
