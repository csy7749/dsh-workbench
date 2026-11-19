import { randomUUID } from 'node:crypto'

/** Pin the route through DSH's public session controller before dispatch. */
export function createWorkflowSessionAdapter(ctx) {
  const peerController = new AbortController()
  const peer = { id: 'workbench-workflow:' + randomUUID(), ctx, principal: { kind: 'owner' }, signal: peerController.signal, interactions: 'none', dispose: () => { peerController.abort(); return Promise.resolve() } }
  const invoke = async (method, request = {}) => {
    const gateway = ctx.get?.('typertGateway') ?? ctx.typertGateway
    if (!gateway?.invoke) throw new Error('DSH 会话模型接口不可用')
    return gateway.invoke({ namespace: 'session', method, args: method === 'modelCatalog' ? {} : { request }, peer, signal: AbortSignal.timeout(15000) })
  }
  return {
    dispose() { return peer.dispose() },
    async create(sessionId, cwd) {
      const agents = ctx.get?.('agents') ?? ctx.agents
      if (!agents?.create || !agents?.get) throw new Error('DSH 会话创建服务不可用')
      if (agents.get(sessionId)) throw new Error('workflow_session_already_exists')
      const presets = ctx.get?.('agentPresets') ?? ctx.agentPresets
      if (presets?.resolve && presets?.mount) {
        const preset = await presets.resolve('standard')
        await agents.create({ sessionId, meta: { ...(cwd ? { cwd } : {}), agentPreset: preset.id }, setup: async scope => { await presets.mount(scope, preset.id) } })
      } else await agents.create({ sessionId, meta: cwd ? { cwd } : {} })
      if (!agents.get(sessionId)) throw new Error('workflow_session_not_active')
    },
    async send(sessionId, prompt) {
      const agents = ctx.get?.('agents') ?? ctx.agents
      const agent = agents?.get?.(sessionId)
      if (!agent?.followup) throw new Error('DSH 会话未激活')
      if (agent.status === 'running') throw new Error('DSH 会话正在运行')
      await agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    },
    async prepare(sessionId, config) {
      const catalog = await invoke('modelCatalog')
      let provider = config.providerId
      let model = config.modelId
      if (provider && !model) throw new Error('指定供应商时必须同时选择模型')
      if (model && !provider) {
        const matches = (catalog?.groups ?? []).flatMap(group => (group.models ?? []).filter(item => item.id === model).map(() => ({ provider: group.id })))
        if (matches.length !== 1) throw new Error('模型供应商不明确，请同时填写供应商 ID')
        provider = matches[0].provider
      }
      if (!model) {
        const projection = await invoke('projections', { sessionId })
        const selection = projection?.values?.modelSelection
        const route = selection?.next ?? selection?.lastUsed ?? catalog?.default
        provider = route?.provider
        model = route?.model
      }
      if (!provider || !model) throw new Error('无法确认实际模型，请显式选择供应商和模型')
      const result = await invoke('selectModel', { sessionId, provider, model })
      if (result?.selected?.provider !== provider || result?.selected?.model !== model) throw new Error('DSH 未确认所请求的模型，生成已停止')
      return { providerId: provider, modelId: model, role: config.role, modelEvidence: 'session/selectModel', roleEvidence: 'full_prompt' }
    },
  }
}
