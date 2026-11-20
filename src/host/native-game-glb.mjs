const fail = () => { throw new Error('game_glb_invalid') }

/** Bound the embedded GLB surface and reject external resources before browser loading. */
export function validateNativeGameGlb(data) {
  if (!Buffer.isBuffer(data) || data.length < 28 || data.length > 8 * 1024 * 1024
    || data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) fail()
  let offset = 12, jsonBytes, binaryBytes
  while (offset < data.length) {
    if (offset + 8 > data.length) fail()
    const length = data.readUInt32LE(offset), type = data.readUInt32LE(offset + 4)
    if (!length || length % 4 || offset + 8 + length > data.length) fail()
    const bytes = data.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4E4F534A && !jsonBytes) jsonBytes = bytes
    else if (type === 0x004E4942 && !binaryBytes) binaryBytes = bytes
    else fail()
    offset += 8 + length
  }
  if (!jsonBytes || !binaryBytes || jsonBytes.length > 1024 * 1024) fail()
  let gltf
  try { gltf = JSON.parse(jsonBytes.toString('utf8')) } catch { fail() }
  if (gltf?.asset?.version !== '2.0' || !Array.isArray(gltf.buffers) || gltf.buffers.length !== 1
    || gltf.buffers[0]?.uri !== undefined || !Number.isSafeInteger(gltf.buffers[0]?.byteLength)
    || gltf.buffers[0].byteLength < 1 || gltf.buffers[0].byteLength > binaryBytes.length
    || binaryBytes.length - gltf.buffers[0].byteLength > 3
    || !Array.isArray(gltf.meshes) || !gltf.meshes.length || gltf.meshes.length > 32
    || !Array.isArray(gltf.nodes) || !gltf.nodes.length || gltf.nodes.length > 32
    || !Array.isArray(gltf.scenes) || gltf.scenes.length !== 1
    || (gltf.animations?.length ?? 0) !== 0 || (gltf.skins?.length ?? 0) !== 0
    || (gltf.images?.length ?? 0) !== 0 || gltf.extensions || gltf.extensionsRequired) fail()
  const visit = (value, depth = 0) => {
    if (depth > 24) fail()
    if (Array.isArray(value)) { if (value.length > 100000) fail(); for (const item of value) visit(item, depth + 1) }
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (key === 'uri' || key === 'extensions') fail()
      visit(item, depth + 1)
    } else if (typeof value === 'number' && !Number.isFinite(value)) fail()
  }
  visit(gltf)
  return { bytes: data.length, meshes: gltf.meshes.length, nodes: gltf.nodes.length }
}
