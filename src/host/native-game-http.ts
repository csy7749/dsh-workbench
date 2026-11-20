import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

type Identity = { productId: string; slug: string; buildId: string }
type Response = { writeHead(status: number, headers?: Record<string, string>): void; end(body?: any): void }
const artifactCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'self'"
const wrapperCsp = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
const html = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
function base(prefix = '/workbench-api') {
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(prefix)) throw new Error('game_http_prefix_invalid')
  return prefix.replace(/\/+$/, '') + '/game-studio/'
}
export function nativeGameUrls({ prefix = '/workbench-api', productId, slug, buildId }: Identity & { prefix?: string }) {
  const query = new URLSearchParams({ productId, slug, buildId }).toString()
  const path = base(prefix)
  return { previewUrl: path + 'preview?' + query, artifactUrl: path + 'artifact?' + query, downloadUrl: path + 'download?' + query }
}
function send(res: Response, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-length': String(Buffer.byteLength(body)), ...headers })
  res.end(body)
}
export function createNativeGameHttp(options: {
  prefix?: string
  studio: { readBuild(input: Identity & { workspaceRoot: string }): any }
  products: () => { id: string; workspacePath: string }[]
  capabilities?: () => Promise<any> | any
  management?: { handle(req: any, res: any, path: string, method: string, url: URL): Promise<boolean> }
}) {
  base(options.prefix)
  return {
    async handle(_req: unknown, res: Response, path: string, method: string, url: URL): Promise<boolean> {
      if (path !== '/game-studio' && !path.startsWith('/game-studio/')) return false
      if (options.management && await options.management.handle(_req, res, path, method, url)) return true
      if (!['/game-studio/capabilities', '/game-studio/preview', '/game-studio/artifact', '/game-studio/download'].includes(path)) {
        send(res, 404, JSON.stringify({ ok: false, error: 'game_route_not_found' })); return true
      }
      if (method !== 'GET') { send(res, 405, JSON.stringify({ ok: false, error: 'game_method_not_allowed' }), { allow: 'GET' }); return true }
      try {
        if (path === '/game-studio/capabilities') {
          send(res, 200, JSON.stringify({ ok: true, ...(options.capabilities ? await options.capabilities() : { create: true, build: true, preview: true, export: true, playtest: false }) })); return true
        }
        for (const name of url.searchParams.keys()) if (!['productId', 'slug', 'buildId'].includes(name) || url.searchParams.getAll(name).length !== 1) throw new Error('game_query_invalid')
        const productId = url.searchParams.get('productId') ?? ''
        const slug = url.searchParams.get('slug') ?? ''
        const buildId = url.searchParams.get('buildId') ?? ''
        if (!productId || productId.length > 200 || /[\x00-\x1f]/.test(productId)) throw new Error('product_id_required')
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) throw new Error('game_slug_invalid')
        if (!/^[a-f0-9]{12}$/.test(buildId)) throw new Error('game_build_id_invalid')
        const product = options.products().find(item => item.id === productId)
        if (!product || typeof product.workspacePath !== 'string' || !isAbsolute(product.workspacePath)) throw new Error('product_workspace_unavailable')
        let workspaceRoot: string
        try { workspaceRoot = realpathSync(product.workspacePath); if (!statSync(workspaceRoot).isDirectory()) throw new Error('not_directory') } catch { throw new Error('product_workspace_unavailable') }
        const built = await options.studio.readBuild({ workspaceRoot, productId, slug, buildId })
        const headers = { 'x-game-build-id': built.buildId, 'x-game-content-sha256': built.hash }
        if (path !== '/game-studio/preview') {
          send(res, 200, built.html, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': artifactCsp, ...(path === '/game-studio/download' ? { 'content-disposition': `attachment; filename="${slug}-${buildId}.html"` } : {}) }); return true
        }
        const urls = nativeGameUrls({ prefix: options.prefix, productId, slug, buildId })
        const title = html(String(built.title))
        const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · 游戏预览</title><style>*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:#0b1420;color:#eff5fb;font:14px system-ui,sans-serif}header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:12px 16px}h1{font-size:16px;margin:0}small{color:#bbcbdc}a{color:#8be4cb}iframe{display:block;flex:1;min-height:0;width:100%;border:0}</style></head><body><header><h1>${title}</h1><small>构建 ${buildId}</small><a href="${html(urls.downloadUrl)}" download>下载此版本 HTML</a></header><iframe src="${html(urls.artifactUrl)}" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${title} · 隔离试玩"></iframe></body></html>\n`
        send(res, 200, body, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': wrapperCsp })
      } catch (cause: any) {
        const raw = String(cause?.message ?? '')
        const error = /^(?:game|product)_[a-z0-9_]+$/.test(raw) ? raw : cause?.code === 'ENOENT' ? 'game_not_found' : 'game_operation_failed'
        const status = error === 'game_not_found' || error === 'product_workspace_unavailable' ? 404 : error === 'game_product_mismatch' ? 403 : /conflict|corrupt|integrity/.test(error) ? 409 : error === 'game_operation_failed' ? 500 : 400
        send(res, status, JSON.stringify({ ok: false, error }))
      }
      return true
    },
  }
}
