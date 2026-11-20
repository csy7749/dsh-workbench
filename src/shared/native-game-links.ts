/** Never turn model-supplied URLs into external navigation or executable schemes. */
export function nativeGameLinks(content: string): { previewUrl: string; artifactUrl: string; downloadUrl: string; buildId: string } | null {
  try {
    const value = JSON.parse(content)
    if (value.provider !== 'workbench-native' || !/^[a-f0-9]{12}$/.test(value.buildId)) return null
    for (const [key, action] of [['previewUrl', 'preview'], ['artifactUrl', 'artifact'], ['downloadUrl', 'download']]) {
      const raw = value[key]
      if (typeof raw !== 'string' || !raw.startsWith('/workbench-api/game-studio/' + action + '?')) return null
      const url = new URL(raw, 'https://workbench.invalid')
      if (url.origin !== 'https://workbench.invalid' || url.pathname !== '/workbench-api/game-studio/' + action || url.searchParams.get('buildId') !== value.buildId) return null
    }
    return { previewUrl: value.previewUrl, artifactUrl: value.artifactUrl, downloadUrl: value.downloadUrl, buildId: value.buildId }
  } catch { return null }
}
