import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const runtimeUrls = [
  new URL('../../assets/vendor/threejs-game/three-gltf-runtime.js', import.meta.url),
  new URL('../assets/vendor/threejs-game/three-gltf-runtime.js', import.meta.url),
]

export function nativeThreeGameRuntime() {
  for (const url of runtimeUrls) {
    try { return readFileSync(fileURLToPath(url), 'utf8') } catch { /* source tree or installed package layout */ }
  }
  throw new Error('game_three_runtime_missing')
}
