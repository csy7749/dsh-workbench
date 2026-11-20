import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { nativeGameFiles } from './native-game-studio.mjs'
import { validateNativeGameAssetOutput } from './native-game-assets.mjs'

const { project, directory, readBytes, atomicFile, hash, json } = nativeGameFiles
const fail = code => { throw new Error(code) }
const MAX_NATIVE = 16 * 1024 * 1024
// Embedded at development time; no source-tree path is needed by the bundled host.
const WORKER_SOURCE = "\"\"\"Original fixed worker: declarative primitives only; no external inputs or scripts.\"\"\"\nimport hashlib\nimport json\nimport math\nimport re\nimport sys\nfrom pathlib import Path\n\nimport bpy\nfrom mathutils import Vector\n\n\ndef require(value, code):\n    if not value:\n        raise ValueError(code)\n\n\ndef main():\n    root = Path(__file__).resolve().parent\n    require(sys.argv[sys.argv.index(\"--\") + 1:] == [\"job.json\"], \"job_argument_invalid\")\n    raw = (root / \"job.json\").read_bytes()\n    require(len(raw) <= 16384, \"job_too_large\")\n    job = json.loads(raw)\n    require(set(job) == {\"schemaVersion\", \"workerVersion\", \"jobId\", \"projectId\", \"productId\", \"slug\", \"recipe\"}, \"job_fields_invalid\")\n    require(job[\"schemaVersion\"] == 1 and job[\"workerVersion\"] == 1 and re.fullmatch(r\"[a-f0-9-]{36}\", job[\"jobId\"]), \"job_invalid\")\n    recipe = job[\"recipe\"]\n    require(isinstance(recipe, dict) and set(recipe) == {\"primitive\", \"color\", \"size\"}, \"recipe_invalid\")\n    require(recipe[\"primitive\"] in (\"crate\", \"pickup\"), \"primitive_invalid\")\n    size = recipe[\"size\"]\n    require(type(size) in (int, float) and math.isfinite(size) and 0.1 <= size <= 4, \"size_invalid\")\n    require(isinstance(recipe[\"color\"], str) and re.fullmatch(r\"#[A-F0-9]{6}\", recipe[\"color\"]), \"color_invalid\")\n    output = root / \"output\"\n    require(output.is_dir() and not output.is_symlink() and not any(output.iterdir()), \"output_invalid\")\n    bpy.ops.object.select_all(action=\"SELECT\")\n    bpy.ops.object.delete(use_global=False)\n    scene = bpy.context.scene\n    scene.unit_settings.system = \"METRIC\"\n    scene.unit_settings.scale_length = 1.0\n    color = tuple(int(recipe[\"color\"][i:i + 2], 16) / 255 for i in (1, 3, 5))\n\n    def material(name, rgb):\n        mat = bpy.data.materials.new(name)\n        mat.use_nodes = True\n        mat.node_tree.nodes.get(\"Principled BSDF\").inputs[\"Base Color\"].default_value = (*rgb, 1)\n        mat.node_tree.nodes.get(\"Principled BSDF\").inputs[\"Roughness\"].default_value = 0.65\n        mat.diffuse_color = (*rgb, 1)\n        return mat\n\n    primary = material(\"MAT_Primary\", color)\n    accent = material(\"MAT_Accent\", tuple(c * 0.45 for c in color))\n    meshes = []\n\n    def cube(name, dimensions, location, mat):\n        bpy.ops.mesh.primitive_cube_add(size=1, location=location)\n        obj = bpy.context.object\n        obj.name = name\n        obj.dimensions = dimensions\n        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)\n        obj.data.materials.append(mat)\n        meshes.append(obj)\n\n    if recipe[\"primitive\"] == \"crate\":\n        cube(\"SM_Crate\", (size, size, size), (0, 0, size / 2), primary)\n        for index, height in enumerate((size * 0.15, size * 0.85)):\n            cube(\"SM_BandHorizontal_%d\" % index, (size * 1.02, size * 1.02, size * 0.1), (0, 0, height), accent)\n        for index, x in enumerate((-size * 0.4, size * 0.4)):\n            cube(\"SM_BandVertical_%d\" % index, (size * 0.1, size * 1.02, size * 1.02), (x, 0, size / 2), accent)\n    else:\n        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=size * 0.5, location=(0, 0, size / 2))\n        obj = bpy.context.object\n        obj.name = \"SM_Pickup\"\n        obj.data.materials.append(primary)\n        meshes.append(obj)\n    bpy.ops.object.select_all(action=\"DESELECT\")\n    for obj in meshes:\n        obj.select_set(True)\n    bpy.context.view_layer.objects.active = meshes[0]\n    scene.cursor.location = (0, 0, 0)\n    bpy.ops.object.origin_set(type=\"ORIGIN_CURSOR\")\n    triangle_count = 0\n    vertices = []\n    for obj in meshes:\n        obj.data.calc_loop_triangles()\n        triangle_count += len(obj.data.loop_triangles)\n        vertices.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)\n    dimensions = [max(v[a] for v in vertices) - min(v[a] for v in vertices) for a in range(3)]\n    require(triangle_count <= 10000 and all(0 < n < 8 for n in dimensions), \"geometry_budget_invalid\")\n    require(bpy.ops.export_scene.gltf(filepath=str(output / \"asset.glb\"), export_format=\"GLB\", use_selection=True, export_yup=True, export_apply=True, export_animations=False, export_cameras=False, export_lights=False) == {\"FINISHED\"}, \"glb_export_failed\")\n    bpy.ops.object.camera_add(location=(size * 2.8, -size * 3.5, size * 2.6))\n    camera = bpy.context.object\n    camera.name = \"CAM_Preview\"\n    camera.rotation_euler = (Vector((0, 0, size / 2)) - camera.location).to_track_quat(\"-Z\", \"Y\").to_euler()\n    camera.data.type = \"ORTHO\"\n    camera.data.ortho_scale = size * 1.85\n    scene.camera = camera\n    bpy.ops.object.light_add(type=\"AREA\", location=(size * 2, -size * 3, size * 4))\n    light = bpy.context.object\n    light.name = \"LGT_Key\"\n    light.data.energy = 400 * size * size\n    light.data.shape = \"DISK\"\n    light.data.size = size * 4\n    light.rotation_euler = (Vector((0, 0, size / 2)) - light.location).to_track_quat(\"-Z\", \"Y\").to_euler()\n    # CPU Cycles works in background without depending on a graphics context.\n    scene.render.engine = \"CYCLES\"\n    scene.cycles.device = \"CPU\"\n    scene.cycles.samples = 8\n    scene.render.resolution_x = 128\n    scene.render.resolution_y = 128\n    scene.render.resolution_percentage = 100\n    scene.render.film_transparent = True\n    scene.render.image_settings.file_format = \"PNG\"\n    scene.render.image_settings.color_mode = \"RGBA\"\n    scene.render.image_settings.color_depth = \"8\"\n    scene.render.filepath = str(output / \"preview.png\")\n    require(bpy.ops.render.render(write_still=True) == {\"FINISHED\"}, \"render_failed\")\n    require(bpy.ops.wm.save_as_mainfile(filepath=str(output / \"scene.blend\"), compress=False) == {\"FINISHED\"}, \"blend_save_failed\")\n    files = {}\n    for name in (\"asset.glb\", \"preview.png\", \"scene.blend\"):\n        path = output / name\n        require(path.is_file() and not path.is_symlink(), \"output_missing\")\n        data = path.read_bytes()\n        require(0 < len(data) <= (262144 if name.endswith(\".png\") else 16777216), \"output_size_invalid\")\n        files[name] = {\"bytes\": len(data), \"hash\": hashlib.sha256(data).hexdigest()}\n    report = {\"schemaVersion\": 1, \"workerVersion\": 1, \"status\": \"completed\", \"jobId\": job[\"jobId\"], \"projectId\": job[\"projectId\"], \"productId\": job[\"productId\"], \"slug\": job[\"slug\"], \"jobHash\": hashlib.sha256(raw).hexdigest(), \"recipe\": recipe, \"blenderVersion\": bpy.app.version_string, \"renderEngine\": scene.render.engine, \"triangleCount\": triangle_count, \"dimensionsMetres\": dimensions, \"files\": files}\n    (output / \"report.json\").write_text(json.dumps(report, sort_keys=True, indent=2) + \"\\n\", encoding=\"utf-8\")\n\n\nif __name__ == \"__main__\":\n    main()\n"

function validateRecipe(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['primitive', 'size', 'color'].includes(key))
    || !['crate', 'pickup'].includes(input.primitive)) fail('game_blender_recipe_invalid')
  const size = input.size ?? 1, color = input.color ?? (input.primitive === 'crate' ? '#8F5C38' : '#E8B34B')
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0.1 || size > 4
    || typeof color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(color)) fail('game_blender_recipe_invalid')
  return { primitive: input.primitive, color: color.toUpperCase(), size }
}

/** Strict fixed-worker GLB subset. No URIs, animation, extensions or hierarchy. */
function validateGlb(data) {
  if (!Buffer.isBuffer(data) || data.length < 28 || data.length > MAX_NATIVE
    || data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) fail('game_blender_glb_invalid')
  const chunks = []
  for (let offset = 12; offset < data.length;) {
    if (offset + 8 > data.length) fail('game_blender_glb_invalid')
    const length = data.readUInt32LE(offset), type = data.readUInt32LE(offset + 4)
    if (!length || length % 4 || offset + 8 + length > data.length || chunks.length >= 2) fail('game_blender_glb_invalid')
    chunks.push({ type, bytes: data.subarray(offset + 8, offset + 8 + length) })
    offset += 8 + length
  }
  if (chunks.length !== 2 || chunks[0].type !== 0x4E4F534A || chunks[1].type !== 0x004E4942 || chunks[0].bytes.length > 1024 * 1024) fail('game_blender_glb_invalid')
  let doc
  try { doc = JSON.parse(chunks[0].bytes.toString('utf8')) } catch { fail('game_blender_glb_invalid') }
  const binary = chunks[1].bytes
  const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min
  const visit = (value, depth = 0) => {
    if (depth > 24) fail('game_blender_glb_invalid')
    if (Array.isArray(value)) { if (value.length > 100000) fail('game_blender_glb_invalid'); for (const item of value) visit(item, depth + 1) }
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (['uri', 'sparse', 'extensions'].includes(key)) fail('game_blender_glb_external_or_extension')
      visit(item, depth + 1)
    }
    else if (typeof value === 'number' && !Number.isFinite(value)) fail('game_blender_glb_invalid')
  }
  visit(doc)
  if (!doc || doc.asset?.version !== '2.0' || !Array.isArray(doc.buffers) || doc.buffers.length !== 1
    || !integer(doc.buffers[0]?.byteLength, 1) || doc.buffers[0].byteLength > binary.length || binary.length - doc.buffers[0].byteLength > 3
    || ['extensionsRequired', 'animations', 'skins', 'images', 'cameras'].some(key => (doc[key]?.length ?? 0) !== 0)
    || !Array.isArray(doc.meshes) || !doc.meshes.length || doc.meshes.length > 32
    || !Array.isArray(doc.nodes) || doc.nodes.length !== doc.meshes.length || (doc.materials?.length ?? 0) > 8
    || !Array.isArray(doc.scenes) || doc.scenes.length !== 1 || ![undefined, 0].includes(doc.scene)
    || !Array.isArray(doc.scenes[0]?.nodes) || doc.scenes[0].nodes.length !== doc.nodes.length
    || new Set(doc.scenes[0].nodes).size !== doc.nodes.length
    || !Array.isArray(doc.bufferViews) || doc.bufferViews.length > 256
    || !Array.isArray(doc.accessors) || doc.accessors.length > 256) fail('game_blender_glb_invalid')
  for (const view of doc.bufferViews) if (!view || view.buffer !== 0 || !integer(view.byteOffset ?? 0)
    || !integer(view.byteLength, 1) || (view.byteOffset ?? 0) + view.byteLength > doc.buffers[0].byteLength) fail('game_blender_glb_accessor_invalid')
  function accessor(index, type, componentTypes) {
    const item = doc.accessors[index], view = item && doc.bufferViews[item.bufferView]
    if (!integer(index) || !item || !view || item.type !== type || !componentTypes.includes(item.componentType)
      || item.normalized || !integer(item.count, 1) || item.count > 100000 || !integer(item.bufferView)
      || !integer(item.byteOffset ?? 0)) fail('game_blender_glb_accessor_invalid')
    const width = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[item.componentType], arity = type === 'VEC3' ? 3 : 1
    const stride = view.byteStride ?? width * arity, offset = item.byteOffset ?? 0
    if (!integer(stride, width * arity) || stride > 252 || stride % width || offset % width
      || offset + (item.count - 1) * stride + width * arity > view.byteLength) fail('game_blender_glb_accessor_invalid')
    const base = (view.byteOffset ?? 0) + offset
    return { count: item.count, read(i, c = 0) {
      const at = base + i * stride + c * width
      return item.componentType === 5126 ? binary.readFloatLE(at) : width === 4 ? binary.readUInt32LE(at) : width === 2 ? binary.readUInt16LE(at) : binary.readUInt8(at)
    } }
  }
  const geometry = []
  let triangleCount = 0, vertexCount = 0
  for (const mesh of doc.meshes) {
    if (!Array.isArray(mesh?.primitives) || !mesh.primitives.length || mesh.primitives.length > 8) fail('game_blender_glb_invalid')
    const points = []
    for (const primitive of mesh.primitives) {
      if (![undefined, 4].includes(primitive.mode) || primitive.targets
        || (primitive.material !== undefined && (!integer(primitive.material) || !doc.materials?.[primitive.material]))) fail('game_blender_glb_invalid')
      const vertices = accessor(primitive.attributes?.POSITION, 'VEC3', [5126])
      vertexCount += vertices.count
      if (vertexCount > 100000) fail('game_blender_glb_budget_exceeded')
      const indices = primitive.indices === undefined ? null : accessor(primitive.indices, 'SCALAR', [5121, 5123, 5125])
      const count = indices?.count ?? vertices.count
      if (count % 3) fail('game_blender_glb_triangle_invalid')
      triangleCount += count / 3
      if (triangleCount > 10000) fail('game_blender_glb_budget_exceeded')
      if (indices) for (let i = 0; i < indices.count; i++) if (indices.read(i) >= vertices.count) fail('game_blender_glb_index_invalid')
      for (let i = 0; i < vertices.count; i++) {
        const point = [vertices.read(i, 0), vertices.read(i, 1), vertices.read(i, 2)]
        if (point.some(n => !Number.isFinite(n) || Math.abs(n) > 8)) fail('game_blender_glb_vertex_invalid')
        points.push(point)
      }
    }
    geometry.push(points)
  }
  const used = new Set(), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const index of doc.scenes[0].nodes) {
    const node = doc.nodes[index]
    if (!integer(index) || !node || !integer(node.mesh) || !geometry[node.mesh] || used.has(node.mesh)
      || (node.children?.length ?? 0) || (node.matrix && (node.translation || node.rotation || node.scale))) fail('game_blender_glb_scene_invalid')
    used.add(node.mesh)
    const t = node.translation ?? [0, 0, 0], s = node.scale ?? [1, 1, 1], q = node.rotation ?? [0, 0, 0, 1], m = node.matrix
    for (const [v, length] of [[t, 3], [s, 3], [q, 4]]) if (!Array.isArray(v) || v.length !== length || v.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100)) fail('game_blender_glb_transform_invalid')
    if (Math.abs(q.reduce((sum, n) => sum + n * n, 0) - 1) > 0.001
      || (m && (!Array.isArray(m) || m.length !== 16 || m.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1))) fail('game_blender_glb_transform_invalid')
    for (const p of geometry[node.mesh]) {
      let world
      if (m) world = [0, 1, 2].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r])
      else {
        const [x, y, z] = p.map((n, i) => n * s[i]), [qx, qy, qz, qw] = q
        const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x)
        world = [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx].map((n, i) => n + t[i])
      }
      world.forEach((n, i) => { if (!Number.isFinite(n) || Math.abs(n) > 8) fail('game_blender_glb_vertex_invalid'); min[i] = Math.min(min[i], n); max[i] = Math.max(max[i], n) })
    }
  }
  const dimensionsMetres = max.map((n, i) => n - min[i])
  if (dimensionsMetres.some(n => !Number.isFinite(n) || n <= 0 || n > 8)) fail('game_blender_glb_dimensions_invalid')
  return { triangleCount, dimensionsMetres, meshes: doc.meshes.length, materials: doc.materials?.length ?? 0 }
}

/** Kill only the owned process/tree; do not release callers until close. */
function runProcess(executable, args, { cwd, env, signal, timeoutMs = 5000 } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('game_operation_cancelled'))
  return new Promise((resolve, reject) => {
    let child, timer, reason, bytes = 0, stdout = '', stderr = ''
    const stop = code => {
      if (reason) return
      reason = code
      if (!child?.pid) return
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
        const fallback = () => { try { child.kill('SIGKILL') } catch { /* Already closed. */ } }
        killer.on('error', fallback)
        killer.on('close', code => { if (code) fallback() })
      } else { try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* Already closed. */ } } }
    }
    const abort = () => stop('game_operation_cancelled')
    try { child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { reject(new Error('game_blender_process_unavailable')); return }
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', value => {
      bytes += value.length
      if (bytes > 65536) { stop('game_blender_output_limit'); return }
      if (name === 'stdout') stdout += value.toString('utf8'); else stderr += value.toString('utf8')
    })
    child.on('error', () => { reason ??= 'game_blender_process_unavailable' })
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (reason) reject(new Error(reason))
      else if (code !== 0) reject(new Error('game_blender_process_failed'))
      else resolve({ stdout, stderr, code })
    })
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => stop('game_blender_timeout'), timeoutMs)
    if (signal?.aborted) abort()
  })
}

function executableCandidates(explicit) {
  if (explicit !== undefined) return typeof explicit === 'string' && isAbsolute(explicit) ? [explicit] : []
  const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, process.platform === 'win32' ? 'blender.exe' : 'blender'))
  if (process.platform === 'win32') for (const base of [...new Set([process.env.ProgramFiles ?? 'C:/Program Files', 'D:/Program Files'])]) {
    const foundation = join(base, 'Blender Foundation')
    try { for (const name of readdirSync(foundation).filter(name => /^Blender [0-9.]+$/.test(name)).sort().reverse()) candidates.push(join(foundation, name, 'blender.exe')) } catch { /* Installed runtimes only. */ }
  }
  else candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/Applications/Blender.app/Contents/MacOS/Blender')
  return [...new Set(candidates)]
}

function jobQuota(parent) {
  let bytes = 0, entries = 0
  const inspect = path => {
    const stat = lstatSync(path)
    if (++entries > 4096 || stat.isSymbolicLink()) fail('game_blender_job_directory_unsafe')
    if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name))
    else if (stat.isFile() && stat.nlink === 1) bytes += stat.size
    else fail('game_blender_job_directory_unsafe')
  }
  const jobs = readdirSync(parent).filter(name => name !== 'execution.lock')
  if (jobs.length >= 32) fail('game_blender_job_limit')
  for (const name of jobs) { if (!/^[a-f0-9-]{36}$/.test(name)) fail('game_blender_job_directory_unsafe'); inspect(join(parent, name)) }
  if (bytes + 34 * 1024 * 1024 > 256 * 1024 * 1024) fail('game_blender_storage_limit')
}

function validateOutputs(folder, job, jobText) {
  const output = directory(join(folder, 'output'))
  if (readdirSync(output).sort().join('|') !== ['asset.glb', 'preview.png', 'report.json', 'scene.blend'].sort().join('|')) fail('game_blender_output_files_invalid')
  const values = Object.fromEntries(['asset.glb', 'preview.png', 'report.json', 'scene.blend'].map(name => [name, readBytes(join(output, name), name.endsWith('.png') ? 262144 : name.endsWith('.json') ? 131072 : MAX_NATIVE)]))
  let report
  try { report = JSON.parse(values['report.json'].toString('utf8')) } catch { fail('game_blender_report_invalid') }
  if (!report || report.schemaVersion !== 1 || report.workerVersion !== 1 || report.status !== 'completed'
    || ['jobId', 'projectId', 'productId', 'slug'].some(key => report[key] !== job[key]) || report.jobHash !== hash(jobText)
    || JSON.stringify(validateRecipe(report.recipe)) !== JSON.stringify(job.recipe)
    || typeof report.blenderVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?/.test(report.blenderVersion) || report.renderEngine !== 'CYCLES'
    || !report.files || Object.keys(report.files).sort().join('|') !== ['asset.glb', 'preview.png', 'scene.blend'].sort().join('|')) fail('game_blender_report_invalid')
  for (const name of ['asset.glb', 'preview.png', 'scene.blend']) if (report.files[name]?.bytes !== values[name].length || report.files[name]?.hash !== hash(values[name])) fail('game_blender_output_hash_invalid')
  const geometry = validateGlb(values['asset.glb'])
  const dims = report.dimensionsMetres
  if (report.triangleCount !== geometry.triangleCount || !Array.isArray(dims) || dims.length !== 3
    || dims.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 8)
    || dims.slice().sort((a, b) => a - b).some((n, i) => Math.abs(n - geometry.dimensionsMetres.slice().sort((a, b) => a - b)[i]) > 0.002)
    || geometry.dimensionsMetres.some(n => n < job.recipe.size * 0.6 || n > job.recipe.size * 1.1)) fail('game_blender_geometry_report_invalid')
  validateNativeGameAssetOutput('image/png', values['preview.png'])
  const png = values['preview.png'], blend = values['scene.blend']
  if (png.readUInt32BE(16) !== 128 || png.readUInt32BE(20) !== 128 || png[24] !== 8 || png[25] !== 6) fail('game_blender_png_invalid')
  const legacyBlend = blend.length >= 12 && /^BLENDER[-_][vV]\d{3}$/.test(blend.toString('ascii', 0, 12))
  // Blender 5.3's actual uncompressed output uses the 17-byte 64-bit block header.
  const modernBlend = blend.length >= 17 && /^BLENDER17-01v\d{4}$/.test(blend.toString('ascii', 0, 17))
  if (!legacyBlend && !modernBlend) fail('game_blender_blend_invalid')
  return { values, report, geometry }
}

export function createNativeGameBlender({ studio, assets, executable, timeoutMs = 120000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) fail('game_blender_timeout_invalid')
  let active = false
  async function provider(signal) {
    const candidate = executableCandidates(executable ?? process.env.DSH_GAME_BLENDER_EXECUTABLE).find(path => {
      try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && !/^\\\\/.test(path) && !/[\x00-\x1f]/.test(path) } catch { return false }
    })
    if (!candidate) return { available: false, reason: 'game_blender_unavailable' }
    try {
      const version = await runProcess(candidate, ['--version'], { signal, timeoutMs: 5000 })
      const match = /^Blender (\d+)\.(\d+)(?:\.(\d+))?/m.exec(version.stdout)
      if (!match || +match[1] < 3 || (+match[1] === 3 && +match[2] < 6)) return { available: false, reason: 'game_blender_version_unsupported' }
      const help = await runProcess(candidate, ['--help'], { signal, timeoutMs: 5000 })
      if (['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '--python'].some(flag => !help.stdout.includes(flag))) return { available: false, reason: 'game_blender_cli_unsupported' }
      return { available: true, executable: candidate, version: match[0].slice(8) }
    } catch (error) { if (signal?.aborted) fail('game_operation_cancelled'); return { available: false, reason: error.message } }
  }
  return {
    async probe() {
      const status = await provider()
      return { available: status.available, provider: 'installed-blender', ...(status.reason ? { reason: status.reason } : {}), ...(status.version ? { version: status.version, executable: status.executable } : {}), downloads: false, workerVersion: 1, renderValidated: false, recipes: ['crate', 'pickup'] }
    },
    async generate({ workspaceRoot, productId, slug, buildId, recipe, slot = 'pickup', signal } = {}) {
      const normalized = validateRecipe(recipe)
      if (!['player', 'pickup', 'playerModel', 'pickupModel'].includes(slot)) fail('game_asset_slot_invalid')
      if (signal?.aborted) fail('game_operation_cancelled')
      if (active) fail('game_blender_busy')
      if (!studio || typeof assets?.accept !== 'function') fail('game_blender_assets_unavailable')
      const target = { workspaceRoot, productId, slug }, owned = project(target)
      const selectedBuild = buildId === undefined ? null : studio.readBuild({ ...target, buildId })
      if (selectedBuild && !selectedBuild.buildCurrent) fail('game_build_stale')
      if (slot.endsWith('Model') && selectedBuild?.template !== 'three-collector') fail('game_asset_template_incompatible')
      active = true
      let lock, fd, folder, journal, accepted
      try {
        const service = await provider(signal)
        if (!service.available) fail(service.reason)
        const parent = directory(join(owned.project, '.studio/blender-jobs'), true)
        lock = join(parent, 'execution.lock')
        try { fd = openSync(lock, 'wx') } catch (error) { if (error.code === 'EEXIST') fail('game_blender_busy_or_recovery_required'); throw error }
        jobQuota(parent)
        const jobId = randomUUID()
        writeFileSync(fd, json({ jobId, pid: process.pid, startedAt: new Date().toISOString() }))
        folder = join(parent, jobId); mkdirSync(folder)
        for (const name of ['output', 'config', 'empty-scripts', 'data']) mkdirSync(join(folder, name))
        const job = { schemaVersion: 1, workerVersion: 1, jobId, projectId: owned.record.projectId, productId, slug, recipe: normalized }, text = json(job)
        if (Buffer.byteLength(text) > 16384) fail('game_blender_job_too_large')
        writeFileSync(join(folder, 'job.json'), text, { flag: 'wx' }); writeFileSync(join(folder, 'worker.py'), WORKER_SOURCE, { flag: 'wx' })
        journal = { schemaVersion: 1, jobId, projectId: job.projectId, productId, slug, jobHash: hash(text), state: 'running', startedAt: new Date().toISOString(), recovery: 'Never replay outcome-unknown jobs; inspect retained output.' }
        atomicFile(join(folder, 'journal.json'), json(journal))
        const env = {}
        for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[name]) env[name] = process.env[name]
        Object.assign(env, { PYTHONPATH: '', PYTHONHOME: '', BLENDER_USER_CONFIG: join(folder, 'config'), BLENDER_USER_SCRIPTS: join(folder, 'empty-scripts'), BLENDER_USER_DATAFILES: join(folder, 'data') })
        await runProcess(service.executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', join(folder, 'worker.py'), '--', 'job.json'], { cwd: folder, env, signal, timeoutMs })
        if (signal?.aborted) fail('game_operation_cancelled')
        const output = validateOutputs(folder, job, text)
        if (buildId !== undefined) {
          const current = studio.readBuild({ ...target, buildId })
          if (!current.buildCurrent || (slot.endsWith('Model') && current.template !== 'three-collector')) fail('game_build_stale')
        }
        const modelOutput = slot.endsWith('Model')
        accepted = await assets.accept({ ...target, signal, provider: 'blender', slot, data: modelOutput ? output.values['asset.glb'] : output.values['preview.png'], mime: modelOutput ? 'model/gltf-binary' : 'image/png', nativeFiles: [
          { name: 'asset.glb', data: output.values['asset.glb'], mime: 'model/gltf-binary' },
          { name: 'scene.blend', data: output.values['scene.blend'], mime: 'application/x-blender' },
          { name: 'report.json', data: output.values['report.json'], mime: 'application/json' },
          { name: 'job.json', data: Buffer.from(text), mime: 'application/json' },
        ], recipe: normalized, origin: { kind: 'fixed-blender-worker', jobId, workerVersion: 1, blenderVersion: output.report.blenderVersion, jobHash: hash(text) }, compatibility: modelOutput
          ? { template: 'three-collector@1', projection: 'gltf-model', native3d: 'embedded-glb', collision: 'runtime-proxy' }
          : { template: 'canvas-collector@1', projection: 'orthographic-sprite', native3d: 'stored-only', width: 128, height: 128 } })
        if (signal?.aborted) fail('game_operation_cancelled')
        journal = { ...journal, state: 'completed', completedAt: new Date().toISOString(), assetId: accepted.assetId, files: output.report.files }
        atomicFile(join(folder, 'journal.json'), json(journal))
        return { ...accepted, provider: 'blender', jobId, workerVersion: 1, blenderVersion: output.report.blenderVersion, geometry: output.geometry, nativeFilesVerified: true, adoptionRequired: true }
      } catch (error) {
        if (folder && journal) try { atomicFile(join(folder, 'journal.json'), json({ ...journal, state: signal?.aborted ? 'cancelled' : 'failed', reason: String(error.message).slice(0, 200), finishedAt: new Date().toISOString(), assetId: accepted?.assetId ?? null })) } catch { /* Retain last durable running journal. */ }
        throw error
      } finally {
        if (fd !== undefined) { closeSync(fd); try { unlinkSync(lock) } catch { /* Explicit recovery required; never replay. */ } }
        active = false
      }
    },
  }
}

export const nativeGameBlenderInternals = Object.freeze({ validateRecipe, validateGlb, validateOutputs, jobQuota, runProcess, workerSource: WORKER_SOURCE })
