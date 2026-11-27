import { isAbsolute } from 'node:path'
import { realpathSync, statSync } from 'node:fs'

const routes: Record<string, { method: string; tool: string; fields: string[] }> = {
  projects: { method: 'GET', tool: 'workbench_game_history', fields: [] },
  state: { method: 'GET', tool: 'workbench_game_history', fields: [] },
  source: { method: 'GET', tool: 'workbench_game_history', fields: [] },
  versions: { method: 'GET', tool: 'workbench_game_history', fields: [] },
  compare: { method: 'GET', tool: 'workbench_game_history', fields: ['fromBuildId', 'toBuildId'] },
  assets: { method: 'GET', tool: 'workbench_game_asset_list', fields: [] },
  asset: { method: 'GET', tool: 'workbench_game_asset_list', fields: ['assetId'] },
  revisions: { method: 'GET', tool: 'workbench_game_history', fields: [] },
  create: { method: 'POST', tool: 'workbench_game_create', fields: ['title', 'template', 'orientation', 'rules'] },
  build: { method: 'POST', tool: 'workbench_game_build', fields: [] },
  export: { method: 'POST', tool: 'workbench_game_export', fields: ['buildId'] },
  restore: { method: 'POST', tool: 'workbench_game_restore', fields: ['buildId', 'expectedCurrentHash'] },
  'asset/generate': { method: 'POST', tool: 'workbench_game_asset_generate', fields: ['provider', 'slot', 'recipe'] },
  'asset/adopt': { method: 'POST', tool: 'workbench_game_asset_adopt', fields: ['assetId', 'expectedBuildId'] },
  'revision/propose': { method: 'POST', tool: 'workbench_game_revision_propose', fields: ['source', 'reason', 'expectedBuildId', 'expectedCurrentHash'] },
  'revision/verify': { method: 'POST', tool: 'workbench_game_revision_verify', fields: ['candidateId', 'seconds'] },
  'revision/recover': { method: 'POST', tool: 'workbench_game_revision_recover', fields: ['candidateId', 'expectedCurrentHash'] },
  playtest: { method: 'POST', tool: 'workbench_game_playtest', fields: ['buildId', 'seconds'] },
}

/** Same product registry and policy as tools. The browser never supplies a path. */
export function createNativeGameManagement(options: any) {
  const { service, studio = service?.studio, assets = service?.assets, revisions = service?.revisions, blender = service?.blender, playtester = service?.playtester, products, authorize = (_name: string) => {} } = options
  return {
    async handle(req: any, res: any, path: string, method: string, url: URL): Promise<boolean> {
      const action = path.slice('/game-studio/'.length)
      const route = path.startsWith('/game-studio/') ? routes[action] : undefined
      if (!route) return false
      const send = (code: number, value: any, headers: any = {}) => {
        const body = JSON.stringify(value)
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': String(Buffer.byteLength(body)), ...headers })
        res.end(body)
      }
      if (method !== route.method) { send(405, { ok: false, error: 'game_method_not_allowed' }, { allow: route.method }); return true }
      const controller = new AbortController()
      const abort = () => controller.abort()
      req.on?.('aborted', abort)
      res.on?.('close', () => { if (!res.writableEnded) abort() })
      try {
        authorize(route.tool)
        let input: any
        if (method === 'GET') {
          input = Object.fromEntries(url.searchParams)
          for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new Error('game_query_invalid')
        } else {
          if (url.search || !/^application\/json(?:;|$)/i.test(req.headers?.['content-type'] ?? '')) throw new Error('game_json_required')
          const origin = req.headers?.origin
          if (req.headers?.['sec-fetch-site'] === 'cross-site' || (origin && (origin === 'null' || new URL(origin).host !== req.headers?.host))) throw new Error('game_origin_invalid')
          const chunks: Buffer[] = []; let bytes = 0
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('game_request_too_large'); chunks.push(chunk) }
          try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('game_json_invalid') }
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['productId', ...(action === 'projects' ? [] : ['slug']), ...route.fields].includes(key))) throw new Error('game_query_invalid')
        const { productId, slug } = input
        if (typeof productId !== 'string' || !productId || productId.length > 200) throw new Error('product_id_required')
        if (action !== 'projects' && (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64)) throw new Error('game_slug_invalid')
        const product = products().find((item: any) => item.id === productId)
        if (!product || !isAbsolute(product.workspacePath ?? '')) throw new Error('product_workspace_unavailable')
        let workspaceRoot: string
        try { workspaceRoot = realpathSync(product.workspacePath); if (!statSync(workspaceRoot).isDirectory()) throw new Error() } catch { throw new Error('product_workspace_unavailable') }
        const args = { ...input, workspaceRoot, signal: controller.signal }
        // Existing-project operations validate registration in their domain
        // methods. Immutable exports do not require a readable workcopy.
        const state = ['projects', 'create', 'build', 'export'].includes(action) ? null : studio.currentState(args)
        let result: any
        switch (action) {
          case 'projects': result = studio.listProjects(args); break
          case 'create': result = service ? await service.execute('create', args) : studio.create({ ...args, template: input.template ?? 'cinderwatch', orientation: input.orientation ?? (input.template && input.template !== 'cinderwatch' ? 'portrait' : 'landscape') }); break
          case 'build': result = service ? await service.execute('build', args) : studio.build(args); break
          case 'export': result = service ? await service.execute('export', args) : studio.exportBuild(args); break
          case 'state': result = { currentHash: state.currentHash, sourceHash: state.sourceHash, manifestHash: state.manifestHash, manifest: state.manifest, versions: studio.listBuilds(args) }; break
          case 'source': result = { source: state.source, currentHash: state.currentHash, sourceHash: state.sourceHash, manifestHash: state.manifestHash }; break
          case 'versions': result = studio.listBuilds(args); break
          case 'compare': result = studio.compareBuilds(args); break
          case 'restore': result = studio.restoreBuild(args); break
          case 'assets': result = assets.list(args); break
          case 'asset': result = assets.read(args); break
          case 'revisions': result = revisions.list(args); break
          case 'asset/generate':
            if (input.provider === 'blender') { authorize('workbench_game_blender'); result = await blender.generate(args) }
            else result = await assets.generate(args)
            break
          case 'asset/adopt': result = assets.adopt(args); break
          case 'revision/propose': result = revisions.propose(args); break
          case 'revision/verify': authorize('workbench_game_build'); authorize('workbench_game_playtest'); result = await revisions.verify(args); break
          case 'revision/recover': result = revisions.recover(args); break
          case 'playtest': result = await playtester.playtest(args); break
        }
        send(200, { ok: true, result })
      } catch (cause: any) {
        const message = String(cause?.message ?? '')
        const error = /^(?:game|product|blender)_[a-z0-9_]+$/.test(message) ? message : cause?.code === 'ENOENT' ? 'game_not_found' : /^(?:disabled_by_|not_in_profile)/.test(message) ? 'game_policy_denied' : 'game_operation_failed'
        send(error === 'game_policy_denied' || error === 'game_product_mismatch' || error === 'game_origin_invalid' ? 403 : /conflict|integrity|busy|already_attempted/.test(error) ? 409 : error === 'game_operation_failed' ? 500 : error === 'game_not_found' || error === 'product_workspace_unavailable' ? 404 : 400, { ok: false, error })
      } finally { req.off?.('aborted', abort) }
      return true
    },
  }
}
