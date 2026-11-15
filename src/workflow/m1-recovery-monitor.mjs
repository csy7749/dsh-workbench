// 定时只读扫描；不重派、不把未知效果自动改成失败或成功。
export function createRecoveryMonitor({ kernel, onScan, onError = () => {}, intervalMs = 30000 }) {
  if (!kernel || typeof onScan !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('recovery_monitor_invalid')
  let timer = null
  let closed = false
  let scanning = false
  const scan = async () => {
    if (closed || scanning) return
    scanning = true
    try { await onScan(kernel.scanRecoverable()) }
    catch (error) { try { await onError(error) } catch {} }
    finally { scanning = false }
  }
  return {
    scan,
    start() {
      if (closed) throw new Error('recovery_monitor_closed')
      if (timer !== null) return
      timer = setInterval(() => { void scan() }, intervalMs)
      timer.unref?.()
      void scan()
    },
    dispose() { closed = true; if (timer !== null) clearInterval(timer); timer = null },
  }
}
