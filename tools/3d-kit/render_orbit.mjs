// 3d-kit: GLB → カメラワーク付き透過webm (vp9 + alpha)
//
// 生成3Dモデル(Hunyuan3D-2 / MoGe-2レリーフ)を映像素材化する決定論レンダラ。
// qa_render.mjs と同じ headless Chromium(swiftshader) 方式。フレームは
// canvas.toDataURL の透過PNGとして取り出し、ffmpeg で yuva420p webm に焼く。
//
// usage:
//   node render_orbit.mjs --glb model.glb --out out.webm \
//     [--preset orbit|dolly_in|dolly_out|sway|arc_l|arc_r|parallax] \
//     [--seconds 4] [--fps 30] [--width 1280] [--height 720] \
//     [--style standard|toon|wire] [--turns 1]

import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const require = createRequire(join(REPO, 'frontend', 'package.json'))
const { chromium } = require('playwright-core')

const EXEC = process.env.QA_CHROME ||
  '/home/kigarashi309/.cache/ms-playwright/chromium-1223/chrome-linux/chrome'
const LIBS = join(REPO, 'tools', 'mg-libs')

// ── args ──────────────────────────────────────────────────────────────────
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k)
  return i >= 0 ? process.argv[i + 1] : d
}
const GLB = arg('glb'); const OUT = arg('out')
// --scene-json: 複数GLB合成シーン {objects:[{glb,pos,rot,scale,style}], camera:[{at,az,el,dist,fov,roll,target,ease}]}
// '@path.json' でファイル指定可。scene モードでは --glb 不要。
let SCENE = null
{
  const sj = arg('scene-json', '')
  if (sj) SCENE = JSON.parse(sj.startsWith('@') ? readFileSync(sj.slice(1), 'utf8') : sj)
}
if ((!GLB && !SCENE) || !OUT) { console.error('need --glb (or --scene-json) and --out'); process.exit(2) }
const PRESET = arg('preset', 'orbit')
const SECONDS = parseFloat(arg('seconds', '4'))
const FPS = parseInt(arg('fps', '30'))
const W = parseInt(arg('width', '1280'))
const H = parseInt(arg('height', '720'))
const STYLE = arg('style', 'standard')   // standard|toon|wire|depth
const TURNS = parseFloat(arg('turns', '1'))
// --frames は Wan 系の「4n+1フレーム」制約に正確に合わせるための直接指定
const N = arg('frames') ? parseInt(arg('frames')) : Math.max(2, Math.round(SECONDS * FPS))
// --camera-json '[{"at":0,"az":0,"el":0.2,"dist":2.2,"fov":40}, ...]' でキーフレーム軌道
const CAMJSON = arg('camera-json', '')

const glbB64 = SCENE ? '' : readFileSync(GLB).toString('base64')
if (SCENE) for (const o of SCENE.objects) { o.url = 'file://' + resolve(o.glb) }

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;overflow:hidden}</style>
<script type="importmap">{"imports":{
  "three": "file://${LIBS}/three.module.min.js",
  "three/addons/utils/BufferGeometryUtils.js": "file://${LIBS}/BufferGeometryUtils.js"
}}</script>
</head><body>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from 'file://${LIBS}/GLTFLoader.js'

const W=${W}, H=${H}, PRESET=${JSON.stringify(PRESET)}, STYLE=${JSON.stringify(STYLE)}, TURNS=${TURNS}
const CAMKEYS=${CAMJSON || 'null'}
const SCENE=${SCENE ? JSON.stringify(SCENE) : 'null'}

const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, preserveDrawingBuffer:true})
// depth: 黒背景不透明(遠=黒, 近=白 — DepthAnything系の慣例に合わせる)
renderer.setSize(W, H); renderer.setClearColor(0x000000, STYLE === 'depth' ? 1 : 0)
renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(40, W/H, 0.01, 1000)
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2))
const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(2,3,4); scene.add(key)
const rim = new THREE.DirectionalLight(0xaaccff, 1.2); rim.position.set(-3,1,-4); scene.add(rim)

let center = new THREE.Vector3(), radius = 1, sizeY = 1, isRelief = false

function toonify(root){
  // 3段グラデでトゥーン化 + 反転ハル輪郭線
  const c = document.createElement('canvas'); c.width = 3; c.height = 1
  const g = c.getContext('2d')
  ;['#666677','#aaaabb','#ffffff'].forEach((col,i)=>{ g.fillStyle=col; g.fillRect(i,0,1,1) })
  const grad = new THREE.CanvasTexture(c)
  grad.minFilter = grad.magFilter = THREE.NearestFilter
  const meshes = []
  root.traverse(o => { if (o.isMesh) meshes.push(o) })   // 追加ハルの再帰処理を防ぐ
  for (const o of meshes) {
    const old = o.material
    o.material = new THREE.MeshToonMaterial({
      color: old.color || new THREE.Color(0xdddddd),
      map: old.map || null, gradientMap: grad,
      vertexColors: !!old.vertexColors })
    const hull = new THREE.Mesh(o.geometry, new THREE.MeshBasicMaterial({
      color: 0x1a1a2a, side: THREE.BackSide }))
    hull.scale.setScalar(1.02); o.add(hull)
  }
}

function wireify(root){
  const meshes = []
  root.traverse(o => { if (o.isMesh) meshes.push(o) })
  for (const o of meshes) {
    const wf = new THREE.LineSegments(
      new THREE.WireframeGeometry(o.geometry),
      new THREE.LineBasicMaterial({color:0x99eeff, transparent:true, opacity:0.5}))
    o.add(wf)
    o.material = new THREE.MeshStandardMaterial({color:0x223344, roughness:0.9,
      vertexColors: !!o.material.vertexColors})
  }
}

// ボクセル→メッシュ変換由来のGLBは巻き向き(法線)が反転していることがあり、
// そのままだとライトが乗らず真っ黒になる。多数決で判定して面を裏返す。
function fixWinding(geom, obj){
  const pos = geom.attributes.position, idx = geom.index
  if (!pos) return
  const c = new THREE.Vector3()
  for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 500)))
    c.add(new THREE.Vector3().fromBufferAttribute(pos, i))
  c.multiplyScalar(1 / Math.min(500, pos.count))
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3()
  const ab = new THREE.Vector3(), ad = new THREE.Vector3(), fc = new THREE.Vector3()
  let out = 0, inn = 0
  const nTri = idx ? idx.count / 3 : pos.count / 3
  const step = Math.max(1, Math.floor(nTri / 2000))
  for (let f = 0; f < nTri; f += step) {
    const i0 = idx ? idx.getX(f*3) : f*3, i1 = idx ? idx.getX(f*3+1) : f*3+1, i2 = idx ? idx.getX(f*3+2) : f*3+2
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); d.fromBufferAttribute(pos, i2)
    ab.subVectors(b, a); ad.subVectors(d, a)
    fc.addVectors(a, b).add(d).multiplyScalar(1/3).sub(c)
    const dot = ab.cross(ad).dot(fc)
    if (dot > 0) out++; else if (dot < 0) inn++
  }
  if (inn > out) {
    if (idx) {
      for (let f = 0; f < idx.count; f += 3) {
        const t = idx.getX(f+1); idx.setX(f+1, idx.getX(f+2)); idx.setX(f+2, t)
      }
      idx.needsUpdate = true
    } else {
      obj.material && (obj.material.side = THREE.DoubleSide)
    }
    geom.computeVertexNormals()
  } else if (!geom.attributes.normal) {
    geom.computeVertexNormals()
  }
}

function applyStyle(root, style){
  root.traverse(o => { if (o.isMesh && o.material && !o.material.map) fixWinding(o.geometry, o) })
  root.traverse(o => {
    if (o.isMesh && o.material && !o.material.map && !o.material.vertexColors &&
        o.material.color && o.material.color.getHex() === 0xffffff)
      o.material.color.setHex(0xd8d0c8)
  })
  if (style === 'toon') toonify(root)
  else if (style === 'wire') wireify(root)
}

window.__ready = (async () => {
  if (SCENE) {
    const loader = new GLTFLoader()
    for (const spec of SCENE.objects) {
      const gltf = await loader.loadAsync(spec.url)
      const node = gltf.scene
      applyStyle(node, spec.style || STYLE)
      // 各オブジェクトを自身のサイズで正規化(高さ1)→ scale はシーン単位
      const bb = new THREE.Box3().setFromObject(node)
      const sz = bb.getSize(new THREE.Vector3()), ct = bb.getCenter(new THREE.Vector3())
      const norm = 1 / Math.max(1e-6, sz.y)
      const wrap = new THREE.Group()
      node.position.sub(ct)                     // 原点=モデル中心
      node.position.y += sz.y / 2 * 1            // 足元を y=0 に
      node.scale.setScalar(norm)
      node.position.multiplyScalar(norm)
      wrap.add(node)
      if (spec.pos) wrap.position.set(spec.pos[0] ?? 0, spec.pos[1] ?? 0, spec.pos[2] ?? 0)
      if (spec.rot) wrap.rotation.set(
        (spec.rot[0] ?? 0) * Math.PI / 180, (spec.rot[1] ?? 0) * Math.PI / 180,
        (spec.rot[2] ?? 0) * Math.PI / 180)
      if (spec.scale) wrap.scale.setScalar(spec.scale)
      scene.add(wrap)
    }
    const box = new THREE.Box3()
    scene.traverse(o => { if (o.isMesh) box.expandByObject(o) })
    const size = box.getSize(new THREE.Vector3())
    box.getCenter(center)
    radius = Math.max(size.x, size.y, size.z)
    sizeY = size.y
    if (STYLE === 'depth') {
      scene.overrideMaterial = new THREE.ShaderMaterial({
        uniforms: { uNear: { value: radius * 0.9 }, uFar: { value: radius * 3.2 } },
        vertexShader: 'varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'varying float vZ; uniform float uNear, uFar; void main(){ float d = clamp((uFar - vZ) / (uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(vec3(d), 1.0); }',
      })
    }
    return true
  }
  const bin = Uint8Array.from(atob(${JSON.stringify(glbB64)}), ch => ch.charCodeAt(0)).buffer
  const gltf = await new GLTFLoader().parseAsync(bin, '')
  const root = gltf.scene
  root.traverse(o => { if (o.isMesh && o.material && !o.material.map) fixWinding(o.geometry, o) })
  // 無テクスチャのHunyuanメッシュはフラットグレーだと寂しいので少し暖色に
  root.traverse(o => {
    if (o.isMesh && o.material && !o.material.map && !o.material.vertexColors &&
        o.material.color && o.material.color.getHex() === 0xffffff)
      o.material.color.setHex(0xd8d0c8)
  })
  if (STYLE === 'toon') toonify(root)
  else if (STYLE === 'wire') wireify(root)
  scene.add(root)
  if (STYLE === 'depth') {
    // 線形深度→グレースケール(近=白)。範囲はモデル半径から固定し、フリッカーを防ぐ
    const boxD = new THREE.Box3().setFromObject(root)
    const szD = boxD.getSize(new THREE.Vector3())
    const rD = Math.max(szD.x, szD.y, szD.z)
    scene.overrideMaterial = new THREE.ShaderMaterial({
      uniforms: { uNear: { value: rD * 0.9 }, uFar: { value: rD * 3.2 } },
      vertexShader: 'varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying float vZ; uniform float uNear, uFar; void main(){ float d = clamp((uFar - vZ) / (uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(vec3(d), 1.0); }',
    })
  }

  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  box.getCenter(center)
  radius = Math.max(size.x, size.y, size.z)
  sizeY = size.y
  // MoGeレリーフはカメラ正対の起伏板: 奥行きだけ薄い or 巨大なら relief と判断
  isRelief = PRESET === 'parallax'
  return true
})()

// t: 0..1 → カメラ配置(決定論)
window.__seek = (t) => {
  const d = radius * 2.1
  let az = 0, el = 0.25, dist = d
  const ease = x => 0.5 - 0.5 * Math.cos(Math.PI * x)   // easeInOut
  const EASES = {
    linear: u => u, inOut: ease,
    outCubic: u => 1 - Math.pow(1 - u, 3), inCubic: u => u * u * u,
  }
  const KEYS = (SCENE && SCENE.camera) || CAMKEYS
  if (KEYS) {
    let k0 = KEYS[0], k1 = KEYS[KEYS.length - 1]
    for (let i = 0; i < KEYS.length - 1; i++)
      if (t >= KEYS[i].at && t <= KEYS[i + 1].at) { k0 = KEYS[i]; k1 = KEYS[i + 1]; break }
    let su = k1.at === k0.at ? 0 : Math.min(1, Math.max(0, (t - k0.at) / (k1.at - k0.at)))
    su = (EASES[k1.ease || 'linear'] || EASES.linear)(su)
    const L = (a, b) => a + (b - a) * su
    const az2 = L(k0.az ?? 0, k1.az ?? 0), el2 = L(k0.el ?? .25, k1.el ?? .25)
    const dist2 = L(k0.dist ?? 2.1, k1.dist ?? 2.1) * radius
    camera.fov = L(k0.fov ?? 40, k1.fov ?? 40); camera.updateProjectionMatrix()
    const tg0 = k0.target || [center.x, center.y, center.z]
    const tg1 = k1.target || [center.x, center.y, center.z]
    const tgt = new THREE.Vector3(L(tg0[0], tg1[0]), L(tg0[1], tg1[1]), L(tg0[2], tg1[2]))
    camera.position.set(
      tgt.x + dist2 * Math.sin(az2) * Math.cos(el2),
      tgt.y + dist2 * Math.sin(el2),
      tgt.z + dist2 * Math.cos(az2) * Math.cos(el2))
    camera.up.set(0, 1, 0)
    camera.lookAt(tgt)
    const roll = L(k0.roll ?? 0, k1.roll ?? 0) * Math.PI / 180
    if (roll) camera.rotateZ(roll)
    renderer.render(scene, camera)
    return renderer.domElement.toDataURL('image/png')
  }
  if (false) {
    // キーフレーム [{at,az,el,dist,fov}] 線形補間(dist は radius 倍率)
    let k0 = CAMKEYS[0], k1 = CAMKEYS[CAMKEYS.length - 1]
    for (let i = 0; i < CAMKEYS.length - 1; i++)
      if (t >= CAMKEYS[i].at && t <= CAMKEYS[i + 1].at) { k0 = CAMKEYS[i]; k1 = CAMKEYS[i + 1]; break }
    const su = k1.at === k0.at ? 0 : Math.min(1, Math.max(0, (t - k0.at) / (k1.at - k0.at)))
    const L = (a, b) => a + (b - a) * su
    az = L(k0.az ?? 0, k1.az ?? 0); el = L(k0.el ?? .25, k1.el ?? .25)
    dist = L(k0.dist ?? 2.1, k1.dist ?? 2.1) * radius
    camera.fov = L(k0.fov ?? 40, k1.fov ?? 40); camera.updateProjectionMatrix()
    camera.position.set(
      center.x + dist * Math.sin(az) * Math.cos(el),
      center.y + dist * Math.sin(el),
      center.z + dist * Math.cos(az) * Math.cos(el))
    camera.lookAt(center)
    renderer.render(scene, camera)
    return renderer.domElement.toDataURL('image/png')
  }
  switch (PRESET) {
    case 'orbit':     az = t * Math.PI * 2 * TURNS; break
    case 'dolly_in':  dist = d * (1.35 - 0.65 * ease(t)); break
    case 'dolly_out': dist = d * (0.70 + 0.65 * ease(t)); break
    case 'sway':      az = Math.sin(t * Math.PI * 2) * 0.26; break
    case 'arc_l':     az = -0.7 + 1.4 * ease(1 - t); el = 0.18 + 0.10 * t; break
    case 'arc_r':     az = -0.7 + 1.4 * ease(t);     el = 0.18 + 0.10 * t; break
    case 'parallax': {
      // レリーフ用: 正面からの小さな平行移動+微ドリー(3Dフォト)。
      // メッシュ高がフレームをほぼ満たす距離に寄せる(fovから逆算)。
      const fit = (sizeY / 2) / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.02
      const tx = Math.sin(t * Math.PI * 2) * radius * 0.05
      const ty = Math.cos(t * Math.PI * 2) * radius * 0.025
      const tz = fit * (1.06 - 0.14 * ease(t))
      camera.position.set(center.x + tx, center.y + ty, center.z + tz)
      camera.lookAt(center)
      renderer.render(scene, camera)
      return renderer.domElement.toDataURL('image/png')
    }
  }
  camera.position.set(
    center.x + dist * Math.sin(az) * Math.cos(el),
    center.y + dist * Math.sin(el),
    center.z + dist * Math.cos(az) * Math.cos(el))
  camera.lookAt(center)
  renderer.render(scene, camera)
  return renderer.domElement.toDataURL('image/png')
}
</script></body></html>`

// ── drive ─────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'orbit3d-'))
const pageFile = join(tmp, 'viewer.html')
writeFileSync(pageFile, html)

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--no-sandbox', '--allow-file-access-from-files'],
})
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  page.on('pageerror', e => console.error('[page]', e.message))
  await page.goto('file://' + pageFile)
  await page.waitForFunction('window.__ready !== undefined')
  await page.evaluate('window.__ready')

  for (let i = 0; i < N; i++) {
    const t = N === 1 ? 0 : i / (N - 1)
    const dataUrl = await page.evaluate(`window.__seek(${t})`)
    writeFileSync(join(tmp, `f${String(i).padStart(5, '0')}.png`),
                  Buffer.from(dataUrl.split(',')[1], 'base64'))
    if (i % 30 === 0) console.log(`frame ${i}/${N}`)
  }

  const enc = OUT.endsWith('.mp4')
    ? ['-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-auto-alt-ref', '0']
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS),
    '-i', join(tmp, 'f%05d.png'), ...enc, OUT], { stdio: 'inherit' })
  console.log('wrote', OUT)
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}
