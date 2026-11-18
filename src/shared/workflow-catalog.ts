// Composition root. Pure graph functions have no dependency on product vocabulary.
import '../packs/registry.ts'
export * from './workflow-canvas-model.ts'
import { PRODUCT_LINES } from './workflow-canvas-model.ts'
export const DEFAULT_PRODUCT_LINE = PRODUCT_LINES[0].id
