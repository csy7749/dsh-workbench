import { CINDERWATCH_DEMO } from './game/cinderwatch-demo.mjs'

/** Built-in demos are immutable gallery entries; project-created demos stay in the workspace store. */
export const BUILTIN_DEMO_LIBRARY = Object.freeze([CINDERWATCH_DEMO])

export function findBuiltinDemo(id) {
  return BUILTIN_DEMO_LIBRARY.find(demo => demo.id === String(id))
}
