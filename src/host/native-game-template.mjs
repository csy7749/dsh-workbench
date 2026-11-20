import { nativeThreeGameRuntime } from './native-game-runtime.mjs'

// Original dependency-free baseline; no external repository code or assets.
function collectorGame() {
  const { rules } = window.GAME
  const assets = window.GAME.assets ?? {}
  const sprites = {}, sounds = {}, media = { images: {}, drawn: {}, audio: {}, played: {}, errors: [] }
  let audio
  for (const [slot, asset] of Object.entries(assets)) {
    const uri = 'data:' + asset.mime + ';base64,' + asset.data
    if (asset.mime.startsWith('image/')) {
      const image = new Image()
      image.onload = () => { media.images[slot] = true }
      image.onerror = () => { media.errors.push(slot + ':image_decode_failed') }
      sprites[slot] = image
      image.src = uri
    } else if (asset.mime === 'audio/wav') {
      audio ??= new AudioContext()
      const binary = atob(asset.data), bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      void audio.decodeAudioData(bytes.buffer).then(buffer => { sounds[slot] = buffer; media.audio[slot] = true }, () => { media.errors.push(slot + ':audio_decode_failed') })
    }
  }
  function play(slot) {
    if (!audio || !sounds[slot] || audio.state !== 'running') return
    const sound = audio.createBufferSource()
    sound.buffer = sounds[slot]
    sound.connect(audio.destination)
    sound.start()
    media.played[slot] = (media.played[slot] ?? 0) + 1
  }
  window.__gameAssets = () => ({ images: { ...media.images }, drawn: { ...media.drawn }, audio: { ...media.audio }, played: { ...media.played }, errors: [...media.errors] })
  const canvas = document.querySelector('canvas')
  const ctx = canvas.getContext('2d')
  const overlay = document.querySelector('#overlay')
  const heading = document.querySelector('#phase')
  const description = document.querySelector('#description')
  const button = document.querySelector('button')
  const hud = document.querySelector('#hud')
  const keys = new Set()
  let state
  let objects
  let spawnTime
  let sequence
  let lastTime
  function reset(phase = 'ready') {
    state = { phase, score: 0, hearts: rules.hearts, remaining: rules.durationSeconds, x: 0.5 }
    objects = []
    spawnTime = 0
    sequence = 0
    keys.clear()
    lastTime = null
  }
  function finish(phase) {
    state.phase = phase
    heading.textContent = phase === 'won' ? '挑战完成' : '再试一次'
    description.textContent = '本局收集 ' + state.score + ' 颗星星。'
    button.textContent = '重新开始'
    overlay.hidden = false
  }
  button.addEventListener('click', () => { void audio?.resume().catch(() => {}); reset('playing'); overlay.hidden = true })
  window.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'a', 'd', 'A', 'D'].includes(event.key)) { event.preventDefault(); keys.add(event.key.toLowerCase()) }
  })
  window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()))
  window.addEventListener('blur', () => keys.clear())
  function point(event) {
    if (state.phase !== 'playing') return
    const rect = canvas.getBoundingClientRect()
    state.x = Math.max(0.055, Math.min(0.945, (event.clientX - rect.left) / rect.width))
  }
  canvas.addEventListener('pointerdown', event => { canvas.setPointerCapture(event.pointerId); point(event) })
  canvas.addEventListener('pointermove', event => { if (canvas.hasPointerCapture(event.pointerId)) point(event) })
  function update(delta) {
    if (state.phase !== 'playing') return
    state.remaining = Math.max(0, state.remaining - delta)
    const direction = Number(keys.has('arrowright') || keys.has('d')) - Number(keys.has('arrowleft') || keys.has('a'))
    state.x = Math.max(0.055, Math.min(0.945, state.x + direction * delta * 0.85))
    spawnTime -= delta
    if (spawnTime <= 0) {
      const positions = [0.5, 0.25, 0.75, 0.4, 0.6]
      const hazard = sequence % 3 === 2
      objects.push({ x: positions[sequence % positions.length], y: -0.04, hazard })
      sequence++
      spawnTime += 0.55
    }
    for (const object of objects) {
      object.y += delta * 0.5
      if (Math.abs(object.y - 0.87) < 0.05 && Math.abs(object.x - state.x) < 0.065) {
        object.y = 2
        if (object.hazard) { state.hearts--; play('hitSound') }
        else { state.score++; play('pickupSound') }
      }
    }
    objects = objects.filter(object => object.y < 1.1)
    if (state.hearts <= 0) finish('lost')
    else if (state.remaining <= 0) finish('won')
  }
  function draw() {
    const w = canvas.width
    const h = canvas.height
    ctx.fillStyle = '#101b2b'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#24374d'
    for (let i = 0; i < 25; i++) ctx.fillRect((i * 71 % w), (i * 113 % h), 2, 2)
    for (const object of objects) {
      if (!object.hazard && sprites.pickup?.complete && sprites.pickup.naturalWidth) {
        ctx.drawImage(sprites.pickup, object.x * w - 14, object.y * h - 14, 28, 28)
        media.drawn.pickup = (media.drawn.pickup ?? 0) + 1
        continue
      }
      ctx.fillStyle = object.hazard ? '#ef8c80' : '#f5c451'
      ctx.beginPath()
      if (object.hazard) {
        ctx.moveTo(object.x * w, object.y * h - 13)
        ctx.lineTo(object.x * w + 13, object.y * h + 12)
        ctx.lineTo(object.x * w - 13, object.y * h + 12)
        ctx.closePath()
      } else ctx.arc(object.x * w, object.y * h, 10, 0, Math.PI * 2)
      ctx.fill()
    }
    if (sprites.player?.complete && sprites.player.naturalWidth) { ctx.drawImage(sprites.player, state.x * w - 20, 0.87 * h - 20, 40, 40); media.drawn.player = (media.drawn.player ?? 0) + 1 }
    else {
      ctx.fillStyle = '#67d5b5'
      ctx.beginPath()
      ctx.roundRect(state.x * w - 17, 0.87 * h - 12, 34, 24, 8)
      ctx.fill()
    }
    hud.textContent = '星星 ' + state.score + '　生命 ' + state.hearts + '　剩余 ' + Math.ceil(state.remaining) + ' 秒'
  }
  function frame(time) {
    const delta = lastTime === null ? 0 : Math.min(0.1, (time - lastTime) / 1000)
    lastTime = time
    update(delta)
    draw()
    requestAnimationFrame(frame)
  }
  reset()
  description.textContent = '左右移动收集星星，躲开红色三角。坚持 ' + rules.durationSeconds + ' 秒获胜。支持方向键、A/D 和触屏拖动。'
  window.__gameState = () => ({ ...state, objects: objects.map(object => ({ ...object })) })
  requestAnimationFrame(frame)
}

export const gameTemplateSource = '(' + collectorGame.toString() + ')()\n'

function threeCollectorGame() {
  const { rules, assets = {} } = window.GAME
  const runtime = window.STUDIO_THREE
  const THREE = runtime?.THREE
  const Loader = runtime?.GLTFLoader
  const canvas = document.querySelector('canvas')
  const overlay = document.querySelector('#overlay')
  const button = document.querySelector('button')
  const hud = document.querySelector('#hud')
  const keys = new Set()
  const media = { models: {}, drawn: {}, errors: [] }
  let scene, camera, renderer, player, pickupTemplate, state, objects = [], spawnTime = 0, sequence = 0, lastTime = null

  function modelFor(slot, fallback) {
    const mesh = new THREE.Group()
    if (assets[slot]?.mime !== 'model/gltf-binary' || !Loader) { mesh.add(fallback()); return Promise.resolve(mesh) }
    try {
      const binary = atob(assets[slot].data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const buffer = bytes.buffer
      return new Promise(resolve => new Loader().parse(buffer, '', result => {
        result.scene.traverse(node => { if (node.isMesh) { node.castShadow = true; node.receiveShadow = true } })
        mesh.add(result.scene)
        media.models[slot] = true
        resolve(mesh)
      }, error => { media.errors.push(slot + ':gltf_load_failed'); mesh.add(fallback()); resolve(mesh) }))
    } catch { media.errors.push(slot + ':gltf_decode_failed'); mesh.add(fallback()); return Promise.resolve(mesh) }
  }
  function box(color, size = 1) {
    return () => new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ color, roughness: 0.68 }))
  }
  function place(object, x, z, scale) { object.position.set(x, 0.65, z); object.scale.setScalar(scale); object.traverse(node => { if (node.isMesh) node.castShadow = true }) }
  function setPhase(phase) {
    state.phase = phase
    if (phase === 'won' || phase === 'lost') {
      document.querySelector('#phase').textContent = phase === 'won' ? '挑战完成' : '再试一次'
      document.querySelector('#description').textContent = '本局收集 ' + state.score + ' 件物品。'
      button.textContent = '重新开始'
      overlay.hidden = false
    }
  }
  function reset(phase = 'ready') {
    for (const object of objects) scene.remove(object.mesh)
    objects = []; spawnTime = 0; sequence = 0; accumulator = 0; lastTime = null; keys.clear()
    state = { phase, score: 0, hearts: rules.hearts, remaining: rules.durationSeconds, x: 0 }
    player.position.set(0, 0.72, 4)
    player.rotation.set(0, 0, 0)
  }
  function pointer(event) {
    if (state.phase !== 'playing') return
    const rect = canvas.getBoundingClientRect()
    state.x = Math.max(-5.2, Math.min(5.2, ((event.clientX - rect.left) / rect.width - 0.5) * 10.4))
  }
  function spawn() {
    const hazard = sequence % 4 === 3
    const x = [-4.2, -2.1, 0, 2.1, 4.2][sequence % 5]
    const mesh = hazard
      ? new THREE.Mesh(new THREE.TetrahedronGeometry(0.55), new THREE.MeshStandardMaterial({ color: '#ff625f', roughness: 0.4, emissive: '#5b1717' }))
      : pickupTemplate?.clone(true) ?? new THREE.Mesh(new THREE.IcosahedronGeometry(0.48, 1), new THREE.MeshStandardMaterial({ color: '#ffd166', roughness: 0.35, emissive: '#62430b', emissiveIntensity: 0.22 }))
    scene.add(mesh); place(mesh, x, -7, 1); objects.push({ mesh, x, z: -7, hazard }); sequence++
  }
  function update(delta) {
    if (state.phase !== 'playing') return
    state.remaining = Math.max(0, state.remaining - delta)
    const direction = Number(keys.has('arrowright') || keys.has('d')) - Number(keys.has('arrowleft') || keys.has('a'))
    state.x = Math.max(-5.2, Math.min(5.2, state.x + direction * delta * 7.4))
    player.position.x = state.x
    spawnTime -= delta
    if (spawnTime <= 0) { spawn(); spawnTime += 0.62 }
    for (const object of objects) {
      object.z += delta * 4.1
      object.mesh.position.z = object.z
      object.mesh.position.x = object.x
      object.mesh.rotation.y += delta * (object.hazard ? 1.4 : 1.1)
      if (Math.abs(object.z - 4) < 0.32 && Math.abs(object.x - state.x) < 0.9) {
        object.z = 20
        if (object.hazard) state.hearts--; else state.score++
      }
    }
    objects = objects.filter(object => { if (object.z > 9) { scene.remove(object.mesh); return false } return true })
    if (state.hearts <= 0) setPhase('lost')
    else if (state.remaining <= 0) setPhase('won')
  }
  function draw() {
    const width = canvas.clientWidth, height = canvas.clientHeight
    if (canvas.width !== Math.round(width * renderer.getPixelRatio()) || canvas.height !== Math.round(height * renderer.getPixelRatio())) {
      renderer.setSize(width, height, false)
      camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix()
    }
    camera.position.x += (state.x * 0.28 - camera.position.x) * 0.06
    camera.lookAt(state.x * 0.22, 0, 0)
    renderer.render(scene, camera)
    for (const slot of Object.keys(media.models)) media.drawn[slot] = (media.drawn[slot] ?? 0) + 1
    hud.textContent = '收集 ' + state.score + '　生命 ' + state.hearts + '　剩余 ' + Math.ceil(state.remaining) + ' 秒'
  }
  function frame(time) {
    const delta = lastTime === null ? 0 : Math.min(0.05, (time - lastTime) / 1000)
    lastTime = time; update(delta); draw(); requestAnimationFrame(frame)
  }
  if (!THREE || !Loader) {
    document.querySelector('#description').textContent = 'Three.js 运行时未加载，无法启动 3D 场景。'
    window.__gameState = () => ({ phase: 'error', score: 0, hearts: 0, remaining: 0, x: 0, objects: [] })
    return
  }
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' }) }
  catch (error) {
    document.querySelector('#description').textContent = '浏览器暂不支持 WebGL：' + String(error.message || error)
    window.__gameState = () => ({ phase: 'error', score: 0, hearts: 0, remaining: 0, x: 0, objects: [] })
    return
  }
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor('#111b31', 1)
  scene = new THREE.Scene(); scene.background = new THREE.Color('#111b31'); scene.fog = new THREE.Fog('#111b31', 13, 32)
  camera = new THREE.PerspectiveCamera(49, 1, 0.1, 80)
  camera.position.set(0, 9, 13)
  const hemi = new THREE.HemisphereLight('#b9d7ff', '#26384b', 2.1); scene.add(hemi)
  const sun = new THREE.DirectionalLight('#ffe0a2', 3); sun.position.set(-5, 9, 5); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); scene.add(sun)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(16, 24), new THREE.MeshStandardMaterial({ color: '#274354', roughness: 0.92 }))
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, -0.05, 1); ground.receiveShadow = true; scene.add(ground)
  const lane = new THREE.GridHelper(14, 14, '#6c9f9e', '#466c75'); lane.position.set(0, 0.01, 1); scene.add(lane)
  const boundaryMaterial = new THREE.MeshStandardMaterial({ color: '#e2a95e', roughness: 0.45, emissive: '#41280d' })
  for (const x of [-6.8, 6.8]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.35, 22), boundaryMaterial); rail.position.set(x, 0.12, 1); scene.add(rail) }
  const time = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), new THREE.MeshBasicMaterial({ color: '#b7d8ff', transparent: true, opacity: 0.12 }))
  time.rotation.x = -Math.PI / 2; time.position.set(0, 0.02, -5.5); scene.add(time)
  Promise.all([modelFor('playerModel', box('#65d69d', 0.95)), modelFor('pickupModel', () => new THREE.Mesh(new THREE.OctahedronGeometry(0.6), new THREE.MeshStandardMaterial({ color: '#ffd166', roughness: 0.35, emissive: '#62430b' })))])
    .then(([hero, pickup]) => { player = hero; pickupTemplate = pickup; place(player, 0, 4, 0.78); scene.add(player); reset(); requestAnimationFrame(frame) })
    .catch(error => { media.errors.push('model_initialization_failed'); document.querySelector('#description').textContent = String(error.message || error) })
  button.addEventListener('click', () => { reset('playing'); overlay.hidden = true })
  window.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'a', 'd', 'A', 'D'].includes(event.key)) { event.preventDefault(); keys.add(event.key.toLowerCase()) } })
  window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()))
  window.addEventListener('blur', () => keys.clear())
  canvas.addEventListener('pointerdown', event => { canvas.setPointerCapture(event.pointerId); pointer(event) })
  canvas.addEventListener('pointermove', event => { if (canvas.hasPointerCapture(event.pointerId)) pointer(event) })
  window.__gameAssets = () => ({ models: { ...media.models }, drawn: { ...media.drawn }, errors: [...media.errors] })
  window.__gameState = () => ({ ...state, objects: objects.map(object => ({ x: (object.x + 7) / 14, y: (object.z + 7) / 16, hazard: object.hazard })) })
  document.querySelector('#description').textContent = '在三维场地里左右移动，收集晶体并躲开危险体。支持方向键、A/D 和触屏拖动。'
}

export const threeGameTemplateSource = '(' + threeCollectorGame.toString() + ')()\n'
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export function renderGameHtml(manifest, source) {
  if (manifest.templateId === 'three-collector') return renderThreeGameHtml(manifest, source, nativeThreeGameRuntime())
  const title = escapeHtml(manifest.title)
  const width = manifest.orientation === 'landscape' ? 720 : 400
  const height = manifest.orientation === 'landscape' ? 400 : 640
  const config = JSON.stringify({ rules: manifest.rules, orientation: manifest.orientation, ...(manifest.assets ? { assets: manifest.assets } : {}) }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; media-src data:;">
<title>${title}</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0b1420;color:#eff5fb;font:16px system-ui,sans-serif}
body{display:flex;flex-direction:column;align-items:center;overflow:hidden}header{width:min(100%,720px);padding:12px 16px;flex:none}h1{font-size:20px;margin:0 0 6px}#hud{font-size:14px;font-variant-numeric:tabular-nums;color:#c6d5e6}
main{position:relative;min-height:0;flex:1;width:min(100%,${width}px);display:flex;justify-content:center;margin-bottom:12px}canvas{display:block;width:100%;height:100%;touch-action:none}
#overlay{position:absolute;inset:0;display:grid;place-content:center;text-align:center;background:#101b2bea;padding:24px}#overlay[hidden]{display:none}h2{font-size:28px;margin:0 0 12px}p{max-width:30em;line-height:1.7;margin:0 0 20px;color:#c6d5e6}button{font:600 17px system-ui,sans-serif;border:0;border-radius:10px;background:#67d5b5;color:#102b25;padding:14px 24px;cursor:pointer}button:focus-visible{outline:3px solid #f5c451;outline-offset:4px}
</style></head><body><header><h1>${title}</h1><div id="hud" aria-live="off"></div></header><main><canvas width="${width}" height="${height}" aria-label="左右移动收集星星"></canvas><section id="overlay"><h2 id="phase">准备采集</h2><p id="description"></p><button type="button">开始游戏</button></section></main><script>window.GAME=${config};\n${source}</script></body></html>\n`
}

export function renderThreeGameHtml(manifest, source, runtime = nativeThreeGameRuntime()) {
  const title = escapeHtml(manifest.title)
  const config = JSON.stringify({ rules: manifest.rules, orientation: manifest.orientation, ...(manifest.assets ? { assets: manifest.assets } : {}) }).replace(/</g, '\\u003c')
  const width = manifest.orientation === 'landscape' ? 960 : 540
  const height = manifest.orientation === 'landscape' ? 540 : 960
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; worker-src 'none'; object-src 'none';">
<title>${title}</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111b31;color:#f4f6fb;font:16px system-ui,sans-serif}body{display:flex;flex-direction:column}header{flex:none;padding:12px 16px}h1{font-size:20px;margin:0 0 6px}#hud{font-size:14px;color:#c7d7ea;font-variant-numeric:tabular-nums}main{position:relative;min-height:0;flex:1;width:100%;overflow:hidden}canvas{display:block;width:100%;height:100%;touch-action:none}#overlay{position:absolute;inset:0;display:grid;place-content:center;text-align:center;background:#101b31d9;padding:24px}#overlay[hidden]{display:none}h2{font-size:28px;margin:0 0 12px}p{max-width:30em;line-height:1.7;margin:0 0 20px;color:#c7d7ea}button{font:600 17px system-ui,sans-serif;border:0;border-radius:10px;background:#65d69d;color:#102b25;padding:14px 24px;cursor:pointer}button:focus-visible{outline:3px solid #ffd166;outline-offset:4px}</style></head>
<body><header><h1>${title}</h1><div id="hud" aria-live="off"></div></header><main><canvas width="${width}" height="${height}" aria-label="三维游戏场景"></canvas><section id="overlay"><h2 id="phase">准备进入</h2><p id="description"></p><button type="button">开始游戏</button></section></main>
<script>${runtime}</script><script>window.GAME=${config};\n${source}</script></body></html>\n`
}
