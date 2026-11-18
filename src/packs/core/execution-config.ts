import type { NodeDef } from '../../shared/workflow-canvas-model.js'

export const configurationNodes: NodeDef[] = [
  { id: 'config.model', title: '模型配置', cat: 'config', actor: 'auto', hint: '指定供应商和模型；留空继承流程默认值。', inputs: [], outputs: [{ id: 'model', label: '模型', type: 'model-config' }], config: [
    { key: 'providerId', label: '供应商 ID', kind: 'text', value: '' },
    { key: 'modelId', label: '模型 ID', kind: 'text', value: '' },
  ] },
  { id: 'config.role', title: '角色配置', cat: 'config', actor: 'auto', hint: '完整角色正文作为本次生成指令，不会只传角色名称。', inputs: [], outputs: [{ id: 'role', label: '角色', type: 'role-config' }], config: [
    { key: 'role', label: '完整角色指令', kind: 'textarea', value: '' },
  ] },
  { id: 'config.combine', title: '执行配置组合', cat: 'config', actor: 'auto', hint: '组合模型与角色，可供多个业务节点共用。未连接的部分继承流程默认值。', inputs: [
    { id: 'model', label: '模型', type: 'model-config', optional: true },
    { id: 'role', label: '角色', type: 'role-config', optional: true },
  ], outputs: [{ id: 'config', label: '执行配置', type: 'execution-config' }], config: [] },
]
