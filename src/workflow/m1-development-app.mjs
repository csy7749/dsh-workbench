import { createDevelopmentHost } from './m1-development-host.mjs'

/** Explicit same-process composition. The caller supplies the panel installer;
 * never import this Node-only module into the production browser bundle.
 */
export function createDevelopmentApp({ ctx, mountPanel, options = {} } = {}) {
  if (!ctx || typeof mountPanel !== 'function') throw new Error('development_panel_adapter_required')
  const host = createDevelopmentHost(options)
  let unmount = null
  let disposed = false
  host.create()
  try {
    unmount = mountPanel(ctx, message => {
      if (disposed) return Promise.reject(new Error('development_app_closed'))
      return Promise.resolve().then(() => host.dispatch(message))
    })
    if (typeof unmount !== 'function') throw new Error('development_panel_disposer_required')
  } catch (error) {
    host.close()
    throw error
  }
  return {
    inspect: () => host.inspect(),
    dispose() {
      if (disposed) return host.inspect()
      // Close first: an active request rejects closure and leaves the panel usable.
      host.close()
      disposed = true
      unmount()
      return host.inspect()
    },
    backup: () => host.backup(),
  }
}
