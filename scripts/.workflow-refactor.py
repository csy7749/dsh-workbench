from pathlib import Path
p=Path('src/shared/workflow-canvas-model.ts')
s=p.read_text(encoding='utf-8')
a=s.index('interface TemplateNodeSpec')
b=s.index('export function templateOf',a)
block=s[a:b].replace('export const TEMPLATES:', 'export const templates:')
header="import { coerceConfig, defById, canConnect, type ConfigValue, type ProductLineId, type WorkflowGraph } from '../shared/workflow-canvas-model.ts'\n"
Path('src/packs/templates.ts').write_text(header+block,encoding='utf-8')
s=s[:a]+"export interface TemplateInfo { id: string; name: string; line: ProductLineId; summary: string; steps: number; revision?: number }\nexport const TEMPLATES: { id: string; line: ProductLineId; summary: string; graph: WorkflowGraph }[] = []\n\n"+s[b:]
s=s.replace("import { registeredNodes, productLines } from '../packs/registry.ts'", "import type { ProductPack } from './product-pack.ts'")
a=s.index('/**'); b=s.index('export type PortType')
s=s[:a]+"/** Pure graph contracts. Vocabulary is supplied by the catalog composition module. */\n"+s[b:]
s=s.replace("export type ProductLineId = 'game' | 'novel' | 'drama'", 'export type ProductLineId = string')
s=s.replace('/** 省略 = 三条产品线都可用 */','/** 省略 = 全部产品线可用 */')
s=s.replace('  config: ConfigField[]\n}', """  config: ConfigField[]
  executor?: 'dsh-session' | 'tool-service' | 'human' | 'unavailable'
  unavailableReason?: string
  capability?: string
  requiredChecks?: string[]
  artifactKind?: string
  prompt?: string
  reviewKind?: string
  exportName?: string
}""",1)
s=s.replace('export const PRODUCT_LINES: ProductLine[] = productLines', 'export const PRODUCT_LINES: ProductLine[] = []')
s=s.replace('export const NODE_DEFS: NodeDef[] = registeredNodes', """export const NODE_DEFS: NodeDef[] = []
export const PACKS: ProductPack[] = []
export function registerPack(pack: ProductPack): () => void {
  if (PACKS.some(item => item.id === pack.id)) throw new Error('pack_duplicate:' + pack.id)
  const known = new Set(NODE_DEFS.map(node => node.id))
  for (const node of pack.nodeDefs) {
    if (known.has(node.id) || !(pack.namespaces ?? [pack.id]).some(prefix => node.id.startsWith(prefix + '.'))) throw new Error('pack_node_invalid:' + node.id)
    known.add(node.id)
    if ([...node.inputs, ...node.outputs].some(port => !(port.type in TYPE_COLOR))) throw new Error('pack_port_invalid')
  }
  PACKS.push(pack)
  NODE_DEFS.push(...pack.nodeDefs)
  if (pack.line) PRODUCT_LINES.push(pack.line)
  TEMPLATES.push(...pack.templates)
  return () => {
    PACKS.splice(PACKS.indexOf(pack), 1)
    for (const node of pack.nodeDefs) NODE_DEFS.splice(NODE_DEFS.indexOf(node), 1)
    if (pack.line) PRODUCT_LINES.splice(PRODUCT_LINES.indexOf(pack.line), 1)
    for (const template of pack.templates) TEMPLATES.splice(TEMPLATES.indexOf(template), 1)
  }
}""")
s=s.replace('  config: Record<string, ConfigValue>\n}', '  config: Record<string, ConfigValue>\n  title?: string\n  disabled?: boolean\n}',1)
s=s.replace('      config: coerceConfig(def, node.config),', "      config: coerceConfig(def, node.config),\n      ...(typeof node.title === 'string' ? { title: node.title.slice(0, 120) } : {}),\n      ...(node.disabled === true ? { disabled: true } : {}),")
s=s.replace("if (outPort.type !== 'any' && inPort.type !== 'any' && outPort.type !== inPort.type)", 'if (!portsCompatible(outPort.type, inPort.type))')
a=s.index("    if (node.type.startsWith('novel.')")
b=s.index('    if (def.outputs.length',a)
s=s[:a]+"    if (def.executor === 'unavailable' && !node.disabled) issues.push({ level: 'warn', code: 'capability_unavailable', message: def.unavailableReason ?? '当前节点不可执行。', nodeId: node.id })\n    if (node.disabled) continue\n"+s[b:]
s=s.replace('    if (def === undefined) continue\n    const inputs: PlanInput[]', "    if (def === undefined || def.cat === 'config' || node.disabled) continue\n    const inputs: PlanInput[]")
s=s.replace('      title: def.title,','      title: node.title || def.title,')
s=s.replace('      note: describeConfig(def, node.config),', "      note: [describeConfig(def, node.config), def.unavailableReason].filter(Boolean).join('；'),")
s=s.replace("id: node.id, type: node.type, x: node.x, y: node.y, config: { ...node.config }", "...node, config: { ...node.config }")
s=s.replace(' * 模板：三条产品线各一条「一拖就能跑」的完整链路',' * 已注册模板')
p.write_text(s,encoding='utf-8')
# Composition imports are explicit; the pure model never imports packs.
for file in ['src/host/workflow-canvas-store.ts','src/host/workflow-canvas.ts','src/host/workflow-runner.mjs','src/client/workflow/canvas-panel.tsx']:
 p=Path(file);s=p.read_text(encoding='utf-8');s=s.replace('shared/workflow-canvas-model.ts','shared/workflow-catalog.ts').replace('shared/workflow-canvas-model.js','shared/workflow-catalog.ts');p.write_text(s,encoding='utf-8')
for p in Path('scripts').glob('verify-workflow-*.mjs'):
 s=p.read_text(encoding='utf-8').replace('shared/workflow-canvas-model.ts','shared/workflow-catalog.ts');p.write_text(s,encoding='utf-8')
