/**
 * 资产库视图的状态决策（纯函数，无语义副作用）。
 *
 * 为什么抽出来单独放：这段「进入视图要不要复查服务」的判断原先散在渲染分支里，只能靠肉眼验。
 * 它恰好有两个必错的边界——
 *  ① 首次就绪后服务退出，再进入视图不复查，页面永远是旧 iframe；
 *  ② syncAssetsView 每次 renderAll 都会跑，复查写重了就会对着宿主狂刷请求。
 * 抽成纯函数后，离线脚本能直接钉住这两条，不用起浏览器。
 */
export type AssetServicePhase = 'idle' | 'starting' | 'ready' | 'failed'

/**
 * 进入视图是否要复查服务。
 * 只认「进入的那一次」：非进入（renderAll 重绘）一律 false，避免反复请求；
 * 正在启动中也 false，避免叠加第二个请求。
 */
export function shouldProbeOnEnter(entering: boolean, phase: AssetServicePhase): boolean {
  if (!entering) return false
  return phase !== 'starting'
}

/** 点「刷新」是否要复查服务。就绪态同样要查——服务可能已经在后台退出。 */
export function shouldProbeOnReload(phase: AssetServicePhase): boolean {
  return phase !== 'starting'
}

/** 探测结果 → 下一阶段：只有 confirmed running 才算就绪，否则一律失败态（带原因给重试）。 */
export function phaseAfterProbe(running: boolean): AssetServicePhase {
  return running ? 'ready' : 'failed'
}

/**
 * 复查发现服务仍在跑，是否需要重载 iframe。
 * 只在实际点了「刷新」（mode='reload'）且本来就在看页面时重载：
 * 进入视图时 iframe 已经在那，重载只会闪一下。
 */
export function shouldReloadFrame(mode: 'enter' | 'reload', phase: AssetServicePhase, running: boolean): boolean {
  return running && phase === 'ready' && mode === 'reload'
}
