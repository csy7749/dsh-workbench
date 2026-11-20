import { createElement as h, useState } from 'react'

/** A scoped project drawer in the existing run card, no separate canvas. */
export function NativeGamePanel({ content }: { content: string }) {
  let identity: { productId: string; slug: string }
  try { const value = JSON.parse(content); identity = { productId: value.productId, slug: value.slug }; if (!identity.productId || !identity.slug) return null } catch { return null }
  // A different project gets fresh state; late responses belong to an unmounted
  // child and can never populate the new project's controls.
  return h(NativeGameProjectPanel, { key: identity.productId + '\n' + identity.slug, identity })
}

function NativeGameProjectPanel({ identity }: { identity: { productId: string; slug: string } }) {
  const [state, setState] = useState<any>(null), [assets, setAssets] = useState<any[]>([]), [revisions, setRevisions] = useState<any[]>([])
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [comparison, setComparison] = useState('')
  const [provider, setProvider] = useState('drawai'), [slot, setSlot] = useState('pickup'), [source, setSource] = useState(''), [reason, setReason] = useState('')
  const api = async (action: string, body?: any) => {
    const response = await fetch('/workbench-api/game-studio/' + action + (body ? '' : '?' + new URLSearchParams(identity)), { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify({ ...identity, ...body }) } : {}) })
    const value = await response.json()
    if (!response.ok || value.ok === false) throw new Error(value.error ?? 'HTTP ' + response.status)
    return value.result
  }
  const refresh = async () => {
    const [next, candidates, proposals] = await Promise.all([api('state'), api('assets'), api('revisions')])
    setState(next); setAssets(candidates); setRevisions(proposals)
    return next
  }
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setNotice('')
    try { await operation() } catch (error: any) {
      // A failed verification may still have rejected, rolled back, or marked a
      // conflict on disk. Refresh the journal before offering another action.
      try { await refresh() } catch { /* Preserve the original actionable error. */ }
      setNotice(error.message)
    } finally { setBusy(false) }
  }
  const current = (Array.isArray(state?.versions) ? state.versions : state?.versions?.builds ?? []).find((item: any) => item.buildCurrent)
  const versions = Array.isArray(state?.versions) ? state.versions : state?.versions?.builds ?? []
  const button = (label: string, onClick: () => void, disabled = false) => h('button', { type: 'button', className: 'wf-btn', disabled: busy || disabled, onClick, style: { margin: '4px 8px 4px 0' } }, label)
  return h('details', { style: { marginTop: '8px' } },
    h('summary', null, '工坊管理 · 版本 / 素材 / 源码修订'),
    h('p', null, '操作针对此产品工程。采用、恢复或修订后要重新试玩，并从原画布相应节点重跑；已有运行证据保持原版本。'),
    button('读取当前工程', () => { void act(async () => { await refresh() }) }),
    notice ? h('p', { role: 'status', style: { whiteSpace: 'pre-wrap' } }, notice) : null,
    state ? h('div', null,
      h('p', null, '当前构建：' + (current?.buildId ?? '工作副本尚未构建或已改变') + ' · CAS ' + state.currentHash.slice(0, 12)),
      button('真实浏览器重测当前版本', () => { void act(async () => { const report = await api('playtest', { buildId: current.buildId, seconds: 20 }); setNotice(report.summary) }) }, !current),
      h('details', null, h('summary', null, '版本历史 · ' + versions.length),
        ...versions.map((version: any) => h('div', { key: version.buildId, style: { margin: '8px 0' } },
          h('code', null, version.buildId + ' · ' + version.bytes + ' bytes' + (version.buildCurrent ? ' · 当前' : '')),
          button('与当前比较', () => { void act(async () => { const response = await fetch('/workbench-api/game-studio/compare?' + new URLSearchParams({ ...identity, fromBuildId: version.buildId, toBuildId: current.buildId })); const result = await response.json(); if (!response.ok) throw new Error(result.error); setComparison(JSON.stringify(result.result, null, 2)) }) }, !current),
          button('恢复此版本并保留备份', () => { void act(async () => { const result = await api('restore', { buildId: version.buildId, expectedCurrentHash: state.currentHash }); await refresh(); setNotice('已恢复 ' + result.buildId + '；试玩未评估。') }) }, !!version.buildCurrent),
        )),
        comparison ? h('pre', { style: { maxHeight: '240px', overflow: 'auto' } }, comparison) : null,
      ),
      h('details', null, h('summary', null, '原创素材候选 · ' + assets.length),
        h('label', null, '提供方 ', h('select', { value: provider, onChange: (event: any) => { const value = event.target.value; setProvider(value); setSlot(value === 'any-audio' ? 'pickupSound' : 'pickup') } }, h('option', { value: 'drawai' }, 'DrawAI 基础形状 → SVG'), h('option', { value: 'any-audio' }, 'AnyAudio 过程音效 → WAV'), h('option', { value: 'blender' }, 'Blender 几何导出（需本机运行时）'))),
        h('label', { style: { marginLeft: '8px' } }, '位置 ', h('select', { value: slot, onChange: (event: any) => setSlot(event.target.value) }, ...(provider === 'any-audio' ? ['pickupSound', 'hitSound'] : ['pickup', 'player']).map(value => h('option', { key: value, value }, value)))),
        button('生成候选', () => { void act(async () => { await api('asset/generate', { provider, slot, recipe: provider === 'drawai' ? { shape: 'diamond', width: 64, height: 64, fill: '#f5c451' } : provider === 'any-audio' ? { preset: slot === 'hitSound' ? 'hit' : 'coin', durationSec: 0.2, sampleRate: 24000, frequency: 880, gain: 0.18, seed: 42 } : { primitive: 'pickup', size: 1, color: '#f5c451' } }); await refresh(); setNotice('候选已生成并核验，尚未采用。') }) }),
        ...assets.map((asset: any) => h('div', { key: asset.assetId, style: { margin: '8px 0' } },
          h('code', null, asset.provider + ' / ' + asset.slot + ' · ' + asset.assetId + ' · ' + asset.bytes + ' bytes'),
          h('span', null, ' · ' + (asset.origin?.license ?? '见来源记录')),
          button('核验并预览', () => { void act(async () => { const response = await fetch('/workbench-api/game-studio/asset?' + new URLSearchParams({ ...identity, assetId: asset.assetId })); const result = await response.json(); if (!response.ok) throw new Error(result.error); setAssets(items => items.map(item => item.assetId === asset.assetId ? { ...item, ...result.result } : item)) }) }),
          button('采用并构建', () => { void act(async () => { const result = await api('asset/adopt', { assetId: asset.assetId, expectedBuildId: current.buildId }); await refresh(); setNotice('已构建 ' + result.buildId + '；需要重新试玩。') }) }, !current),
          asset.data && asset.mime?.startsWith('image/') ? h('img', { src: 'data:' + asset.mime + ';base64,' + asset.data, alt: asset.slot, width: 64, height: 64, style: { display: 'block' } }) : null,
          asset.data && asset.mime === 'audio/wav' ? h('audio', { controls: true, preload: 'metadata', src: 'data:audio/wav;base64,' + asset.data }) : null,
        )),
      ),
      h('details', null, h('summary', null, '源码候选 · ' + revisions.length),
        h('p', null, '仅替换 game.js。规则不变；候选真实试玩通过后采用，失败回退。自动修复仅恢复标准 collector 源码。'),
        h('textarea', { value: source, onChange: (event: any) => setSource(event.target.value), 'aria-label': '候选 game.js 源码', placeholder: '完整候选 game.js', rows: 8, style: { width: '100%' } }),
        h('input', { value: reason, onChange: (event: any) => setReason(event.target.value), 'aria-label': '修订原因', placeholder: '修订原因与对应试玩问题', style: { width: '100%' } }),
        button('保存源码候选', () => { void act(async () => { await api('revision/propose', { source, reason, expectedBuildId: current.buildId, expectedCurrentHash: state.currentHash }); await refresh(); setNotice('已保存候选；源码尚未采用。') }) }, !current || !source.trim() || !reason.trim()),
        ...revisions.map((revision: any) => h('div', { key: revision.candidateId },
          h('code', null, revision.candidateId + ' · ' + revision.status),
          h('span', null, ' · ' + revision.reason),
          revision.status === 'proposed' ? button('真实核验并采用 / 回退', () => { void act(async () => { const result = await api('revision/verify', { candidateId: revision.candidateId, seconds: 20 }); await refresh(); setNotice(result.accepted ? '候选核验通过，已采用。' : '候选未通过，已回退。') }) }) : null,
          ['verifying', 'unknown', 'conflict'].includes(revision.status) ? button('按当前指纹显式对账', () => { void act(async () => { await api('revision/recover', { candidateId: revision.candidateId, expectedCurrentHash: state.currentHash }); await refresh(); setNotice('对账完成，需要重新试玩。') }) }) : null,
        )),
      ),
    ) : null,
  )
}
