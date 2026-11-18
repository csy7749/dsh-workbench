import type { ProductPack } from '../../shared/product-pack.ts'
export const samplePack: ProductPack = {
  id: 'sample', version: '1.0.0', label: '示例',
  line: { id: 'sample', name: '示例', short: '示例', accent: '#60a5fa', summary: '无需修改内核即可扩展', focus: ['可插拔'] },
  nodeDefs: [{ id: 'sample.outline', title: '示例提纲', cat: 'design', actor: 'agent', executor: 'unavailable', unavailableReason: '示例包没有执行器。', hint: '声明示例', inputs: [{ id: 'in', label: '文档', type: 'markdown' }], outputs: [{ id: 'out', label: '提纲', type: 'json' }], config: [] }],
  templates: [{ id: 'sample-outline', line: 'sample', summary: '示例输入与提纲', graph: { version: 1, line: 'sample', name: '示例提纲', nodes: [{ id: 'input', type: 'input.brief', x: 0, y: 0, config: { text: 'example' } }, { id: 'doc', type: 'dsh.generate', x: 260, y: 0, config: {} }, { id: 'outline', type: 'sample.outline', x: 520, y: 0, config: {} }], edges: [{ from: { node: 'input', port: 'out' }, to: { node: 'doc', port: 'in' } }, { from: { node: 'doc', port: 'out' }, to: { node: 'outline', port: 'in' } }] } }],
}
