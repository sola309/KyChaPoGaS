// puppet レイヤー: パーツ分解した立ち絵(コンパニオンのリグ。manifest v2 + レイヤー PNG)を、格子メッシュの変形で動かす。
//   まばたき・口・首ふり(円筒ワープ)・首のかしげ・うなずき・体の傾き・呼吸・髪と布のゆれ。
// 決定論: 絵は (文書, コマ) だけで決まる。物理の積分はしない。ゆれは正弦の重ね(閉じた式)、
//   「毛先が遅れてついてくる」は少し前のコマの姿勢を毛先ほど強く混ぜて作る(状態を持たない)。
// 描き方: パペットのキャンバス(例 1280×1280)大の RT に、z 順に 1 枚ずつ重ねる(sRGB の値・乗算済み)。
//   その RT を 1 枚の絵としてレイヤーに戻すので、transform・effects・親子・マット・3D は image レイヤーと同じに効く。
// 考え方は frontend/src/companion/PuppetStage.ts と同じ(yawMapX / warpFace / warpNeck)。あちらは実時間のばね、こちらは式。
import { THREE } from './gfx.js'
import { evalProp, num, vec, clamp, rand01, strHash } from './props.js'
import { canvasTexture } from './assets.js'

const TAU = Math.PI * 2
const UNIT_REF = 1190 // 動きの量の基準(キャラの実寸 px)。rig.unit ÷ これ = 動きの倍率
const YAW_MAX = 0.42 // head_turn ±1 での首ふりの角度(rad)
const DEG = Math.PI / 180
const sstep = (u) => { u = u < 0 ? 0 : u > 1 ? 1 : u; return u * u * (3 - 2 * u) }

// 2D アフィン [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f
// rig = 軸 (px, py) のまわりで 拡大 → 回転 → 平行移動
function rig(px, py, ang, sx, sy, dx, dy) {
  const co = Math.cos(ang), si = Math.sin(ang)
  const a = co * sx, b = si * sx, c = -si * sy, d = co * sy
  return [a, b, c, d, px + dx - a * px - c * py, py + dy - b * px - d * py]
}
// m·n(先に n、あとで m)
function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
}

const VERT = /* glsl */ `
uniform vec2 uSize; varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.x / uSize.x * 2.0 - 1.0, 1.0 - position.y / uSize.y * 2.0, 0.0, 1.0); }`
const FRAG = /* glsl */ `
uniform sampler2D uMap; uniform float uOpacity; uniform vec2 uSize; uniform vec3 uClip; varying vec2 vUv;
// uClip = (a, b, c): 元の絵の位置 (x, y) で a·x + b·y + c > 0 の側だけ描く(腕・脚の層を左右に分ける)。既定 (0, 0, 1) = 全部
void main(){ gl_FragColor = texture2D(uMap, vUv) * (uOpacity * clamp(dot(vec3(vUv * uSize, 1.0), uClip) + 0.5, 0.0, 1.0)); }`

// 古い manifest(sway の分類なし)むけの名前からの推定
function fallbackSway(name, group) {
  if (name === 'neck') return { type: 'neck', pin: '', amp: 0 }
  if (group === 'backhair') return { type: 'hair', pin: 'head', amp: 1 }
  if (group === 'fronthair') return { type: 'hair', pin: 'head', amp: 0.32 }
  if (name === 'bottomwear') return { type: 'cloth', pin: 'body', amp: 0.42 }
  return null
}

// bones.png = bones.json の写し(tools/pose-kit/make_bones.py が作る。長さ 4 バイト + UTF-8 の JSON を RGB の画素に詰めた PNG)。
// いまの /api/puppet/<id>/layer/ は .png しか返さないので、この形で読む。無い・読めないときは null(ボーンなし = いままでどおり)
async function loadBones(url) {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const cv = document.createElement('canvas')
    cv.width = bmp.width; cv.height = bmp.height
    const g = cv.getContext('2d', { willReadFrequently: true })
    g.drawImage(bmp, 0, 0)
    const d = g.getImageData(0, 0, cv.width, cv.height).data
    const n = cv.width * cv.height, raw = new Uint8Array(n * 3)
    for (let i = 0; i < n; i++) { raw[i * 3] = d[i * 4]; raw[i * 3 + 1] = d[i * 4 + 1]; raw[i * 3 + 2] = d[i * 4 + 2] }
    const len = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0
    if (!len || len > raw.length - 4) return null
    const b = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + len)))
    return b && b.joints && Array.isArray(b.bones) ? b : null
  } catch { return null }
}

// ---- ボーンの姿勢 ----
// 関節の角度(度)は画面の中の回転。腕・脚は「正 = 外へ開く(体から離れる向き)」で左右とも同じ意味、waist・neck は「正 = 画面で時計回り」。
// _l = 本人の左 = 画面の右(mesh レイヤーのマネキンと同じ)。値を [角度, 長さの倍率] と書くと、ボーンの向きに縮める(手前・奥へ振った腕や脚の見かけ)。
const POSE_JOINTS = ['waist', 'neck', 'shoulder_l', 'shoulder_r', 'elbow_l', 'elbow_r', 'wrist_l', 'wrist_r', 'hip_l', 'hip_r', 'knee_l', 'knee_r', 'ankle_l', 'ankle_r']
export const PUPPET_PRESETS = ['stand', 'a_pose', 't_pose', 'idle', 'walk', 'run', 'wave', 'sit', 'hand_on_hip', 'peace', 'lean_forward', 'cheer']
// マネキン(mesh3d.js の mqPreset)と同じ角度の表(あちらは持ち主が別なので写し。直すときは両方)。ph = 位相(0〜1 で 1 周)
function mqPreset(name, ph) {
  const th = ph * TAU, s = Math.sin(th), c = Math.cos(th)
  const P = { shoulder_l: [0, 0, 6], shoulder_r: [0, 0, 6], elbow_l: [8, 0, 0], elbow_r: [8, 0, 0] }
  switch (name) {
    case 'a_pose': P.shoulder_l = [0, 0, 35]; P.shoulder_r = [0, 0, 35]; P.elbow_l = [0, 0, 0]; P.elbow_r = [0, 0, 0]; break
    case 't_pose': P.shoulder_l = [0, 0, 90]; P.shoulder_r = [0, 0, 90]; P.elbow_l = [0, 0, 0]; P.elbow_r = [0, 0, 0]; break
    case 'idle':
      P.root = [0, 0, 0.8 * s]; P.chest = [1.2 * s, 0, -0.8 * s]; P.head = [0, 0, 1.5 * s]
      P.shoulder_l = [0, 0, 8 + s]; P.shoulder_r = [0, 0, 8 - s]; P.elbow_l = [10, 0, 0]; P.elbow_r = [10, 0, 0]
      break
    case 'walk': case 'run': {
      const k = name === 'run' ? 1 : 0
      const hipA = 26 + 18 * k, knA = 48 + 42 * k, armA = 20 + 22 * k
      P.root = [3 + 9 * k, -5 * s, 0]; P.chest = [2 * k, 9 * s, 0]; P.head = [-4 * k, -4 * s, 0]
      P.hip_l = [hipA * s + 8 * k, 0, 2]; P.hip_r = [-hipA * s + 8 * k, 0, 2]
      P.knee_l = [4 + 14 * k + knA * Math.max(0, c), 0, 0]; P.knee_r = [4 + 14 * k + knA * Math.max(0, -c), 0, 0]
      P.ankle_l = [-6 * s, 0, 0]; P.ankle_r = [6 * s, 0, 0]
      P.shoulder_l = [-armA * s, 0, 7]; P.shoulder_r = [armA * s, 0, 7]
      P.elbow_l = [15 + 65 * k + 10 * Math.max(0, -s), 0, 0]; P.elbow_r = [15 + 65 * k + 10 * Math.max(0, s), 0, 0]
      P.ground = true
      break
    }
    case 'wave': P.shoulder_r = [0, -90, 84]; P.elbow_r = [82 + 26 * s, 0, 0]; P.head = [0, 0, -4]; break
    case 'sit':
      P.hip_l = [88, 0, 4]; P.hip_r = [88, 0, 4]; P.knee_l = [88, 0, 0]; P.knee_r = [88, 0, 0]
      P.shoulder_l = [28, 10, 6]; P.shoulder_r = [28, 10, 6]; P.elbow_l = [55, 0, 0]; P.elbow_r = [55, 0, 0]
      break
    case 'hand_on_hip': P.shoulder_r = [-22, 62, 46]; P.elbow_r = [98, 0, 0]; P.root = [0, 0, 2.5]; P.chest = [0, 0, -2.5]; break
    case 'peace':
      P.shoulder_r = [25, -75, 62]; P.elbow_r = [128, 0, 0]; P.head = [0, 0, -7]
      P.shoulder_l = [-22, 62, 46]; P.elbow_l = [98, 0, 0]
      break
    case 'lean_forward':
      P.hip_l = [14, 0, 2]; P.hip_r = [14, 0, 2]
      P.shoulder_l = [-48, 30, 10]; P.shoulder_r = [-48, 30, 10]; P.elbow_l = [25, 0, 0]; P.elbow_r = [25, 0, 0]
      break
    case 'cheer': P.shoulder_l = [0, -90, 152]; P.shoulder_r = [0, -90, 152]; P.elbow_l = [22, 0, 0]; P.elbow_r = [22, 0, 0]; break
  }
  return P
}
const _e3 = new THREE.Euler(), _v3 = new THREE.Vector3()
function mqQuat(name, a) {
  const x = (a?.[0] || 0) * DEG, y = (a?.[1] || 0) * DEG, z = (a?.[2] || 0) * DEG, side = name.endsWith('_l') ? 1 : -1
  if (name === 'root' || name === 'spine' || name === 'chest') _e3.set(x, y, -z, 'YXZ')
  else if (name.startsWith('shoulder') || name.startsWith('hip') || name.startsWith('wrist')) _e3.set(-x, -side * y, side * z, 'ZXY')
  else if (name.startsWith('elbow')) _e3.set(-x, -side * y, 0, 'YXZ')
  else if (name.startsWith('knee')) _e3.set(x, 0, 0, 'XYZ')
  else _e3.set(x, -side * y, 0, 'YXZ') // ankle
  return new THREE.Quaternion().setFromEuler(_e3)
}
// マネキンの姿勢(3D)→ 各ボーンの画面上の向き(rad)と見かけの長さ(0〜1)。正面から見た平行投影
function presetDirs(P) {
  const out = {}
  const qRoot = mqQuat('root', P.root), qChest = qRoot.clone().multiply(mqQuat('spine', P.spine)).multiply(mqQuat('chest', P.chest))
  const put = (name, q) => { _v3.set(0, -1, 0).applyQuaternion(q); out[name] = [Math.atan2(-_v3.y, _v3.x), Math.hypot(_v3.x, _v3.y)] }
  for (const s of ['l', 'r']) {
    const ua = qChest.clone().multiply(mqQuat('shoulder_' + s, P['shoulder_' + s])), fa = ua.clone().multiply(mqQuat('elbow_' + s, P['elbow_' + s]))
    put('upper_arm_' + s, ua); put('forearm_' + s, fa); put('hand_' + s, fa.clone().multiply(mqQuat('wrist_' + s, P['wrist_' + s])))
    const th = qRoot.clone().multiply(mqQuat('hip_' + s, P['hip_' + s])), sh = th.clone().multiply(mqQuat('knee_' + s, P['knee_' + s]))
    put('thigh_' + s, th); put('shin_' + s, sh); out['foot_' + s] = out['shin_' + s]
  }
  return out
}
const wrapPi = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a }
const _presetCache = new Map()
// preset → {ボーン: [親に対する回転(rad), 長さの倍率], lean, waist, neck(rad), ground}。立ち姿(stand)との差で出す
function presetLocal(name, ph) {
  const key = name + '|' + Math.round(ph * 1e5)
  let r = _presetCache.get(key)
  if (r) return r
  const P = mqPreset(name, ph), A = presetDirs(P), B = presetDirs(mqPreset('stand', 0))
  const tz = (k) => (P[k]?.[2] || 0) * DEG
  r = { bones: {}, lean: tz('root'), waist: tz('spine') + tz('chest'), neck: tz('neck') + tz('head'), ground: !!P.ground }
  const g = {}, sc = {}
  for (const k of Object.keys(A)) {
    sc[k] = clamp(A[k][1] / Math.max(1e-3, B[k][1]), 0.3, 1.1)
    // ほぼ手前・奥を向いたボーンは画面上の向きが定まらないので、回転を弱める
    g[k] = wrapPi(A[k][0] - B[k][0]) * sstep(A[k][1] / 0.3)
  }
  for (const s of ['l', 'r']) {
    r.bones['upper_arm_' + s] = [g['upper_arm_' + s] - r.lean - r.waist, sc['upper_arm_' + s]]
    r.bones['forearm_' + s] = [wrapPi(g['forearm_' + s] - g['upper_arm_' + s]), sc['forearm_' + s]]
    r.bones['hand_' + s] = [wrapPi(g['hand_' + s] - g['forearm_' + s]), sc['hand_' + s]]
    r.bones['thigh_' + s] = [g['thigh_' + s] - r.lean, sc['thigh_' + s]]
    r.bones['shin_' + s] = [wrapPi(g['shin_' + s] - g['thigh_' + s]), sc['shin_' + s]]
    r.bones['foot_' + s] = [0, 1]
  }
  if (_presetCache.size > 4000) _presetCache.clear()
  _presetCache.set(key, r)
  return r
}
// 関節 j のまわりで、向き (dx, dy)(単位)に s 倍に縮めてから ang 回す
function boneLocal(j, dx, dy, ang, s) {
  const k = s - 1, co = Math.cos(ang), si = Math.sin(ang)
  const a0 = 1 + k * dx * dx, b0 = k * dx * dy, c0 = k * dx * dy, d0 = 1 + k * dy * dy
  const a = co * a0 - si * b0, b = si * a0 + co * b0, c = co * c0 - si * d0, d = si * c0 + co * d0
  return [a, b, c, d, j[0] - a * j[0] - c * j[1], j[1] - b * j[0] - d * j[1]]
}

// アニメらしい非対称のまばたき: 速く閉じる → 少し保つ → ゆっくり開く(p = 0〜1)
function blinkShape(p) {
  if (p <= 0 || p >= 1) return 0
  if (p < 0.3) { const u = p / 0.3; return u * u }
  if (p < 0.45) return 1
  return 1 - sstep((p - 0.45) / 0.55)
}

export class PuppetStore {
  constructor(env) {
    this.env = env
    this.items = new Map() // manifest の URL → パペット
    this.scene = new THREE.Scene()
    this.cam = new THREE.Camera()
    this.cavityTex = null
  }

  baseUrl(scene, L) {
    const s = L.def.source || {}
    if (s.url) return String(scene.srcUrl(s.url)).replace(/\/+$/, '')
    if (s.puppet_id == null || s.puppet_id === '') return null
    return `${this.env.apiBase}/api/puppet/${encodeURIComponent(String(s.puppet_id))}`
  }
  layerUrl(e, file) { return `${e.base}/layer/${String(file).split('/').map(encodeURIComponent).join('/')}` }

  entry(scene, L) {
    const base = this.baseUrl(scene, L)
    if (!base) return null
    let e = this.items.get(base)
    if (!e) {
      e = { base, state: 'loading', man: null, parts: [], promise: null }
      const layer = this.env.curLayer
      e.promise = fetch(`${base}/manifest`).then((r) => (r.ok ? r.json() : null)).then((man) => {
        if (!man || !Array.isArray(man.layers)) throw new Error('manifest')
        return loadBones(`${base}/layer/bones.png`).then((bones) => {
          this.build(e, man, bones)
          e.state = 'ready'
          this.env.invalidate()
        })
      }).catch(() => {
        e.state = 'error'
        console.warn('[comp-engine] パペットを読めない:', base)
        this.env.report?.('error', `パペットを読めない: ${base}`, layer)
      })
      this.items.set(base, e)
    }
    if (e.state === 'loading') this.env.pending.push(e.promise)
    return e
  }

  // 1 枚ぶんの格子(範囲 = box [l, t, r, b]。頂点はキャンバスの px、uv はキャンバス全体に対する割合)
  grid(e, box, nx, ny) {
    const [cw, ch] = e.size
    const l = Math.max(0, box[0] - 3), t = Math.max(0, box[1] - 3), r = Math.min(cw, box[2] + 3), b = Math.min(ch, box[3] + 3)
    const n = nx * ny
    const base = new Float32Array(n * 2), pos = new Float32Array(n * 3), uv = new Float32Array(n * 2)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const x = l + ((r - l) * i) / (nx - 1), y = t + ((b - t) * j) / (ny - 1)
      base[k * 2] = x; base[k * 2 + 1] = y
      pos[k * 3] = x; pos[k * 3 + 1] = y
      uv[k * 2] = x / cw; uv[k * 2 + 1] = y / ch
    }
    const idx = []
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i
      idx.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(idx)
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uMap: { value: null }, uOpacity: { value: 1 }, uSize: { value: new THREE.Vector2(cw, ch) }, uClip: { value: new THREE.Vector3(0, 0, 1) } },
      depthTest: false, depthWrite: false, transparent: true, toneMapped: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    })
    const mesh = new THREE.Mesh(g, mat)
    mesh.frustumCulled = false
    return { mesh, base, pos, nx, ny, box: [l, t, r, b] }
  }

  build(e, man, bones = null) {
    e.man = man
    e.bones = bones
    const skinsOf = new Map()
    if (bones) for (const sk of bones.skins || []) { if (!skinsOf.has(sk.layer)) skinsOf.set(sk.layer, []); skinsOf.get(sk.layer).push(sk) }
    e.lower = new Set(bones?.lower_layers || [])
    const cw = num(man.canvas?.[0], 1280), ch = num(man.canvas?.[1], 1280)
    e.size = [cw, ch]
    const rg = man.rig || {}
    e.S = num(rg.unit, ch * 0.93) / UNIT_REF
    const pv = man.pivots || {}
    e.piv = { head: pv.head || [cw / 2, ch * 0.28], eyes: pv.eyes || [cw / 2, ch * 0.19], mouth: pv.mouth || [cw / 2, ch * 0.24], body: pv.body || [cw / 2, ch * 0.8] }
    const layers = [...man.layers].sort((a, b) => num(a.z, 0) - num(b.z, 0))
    let fl = 1e9, fr = -1e9, ht = 1e9, hb = -1e9, hl = 1e9, hr = -1e9
    e.faceDepth = 0.5
    for (const ly of layers) {
      const bb = ly.bbox
      if (!bb) continue
      if (ly.name === 'face') e.faceDepth = num(ly.depth, 0.5)
      if (ly.group === 'head' || ly.group === 'eyes' || ly.group === 'mouth') { fl = Math.min(fl, bb[0]); fr = Math.max(fr, bb[2]) }
      if ((ly.group === 'head' && ly.name !== 'neck') || ly.group === 'eyes' || ly.group === 'mouth' || ly.group === 'fronthair') { hl = Math.min(hl, bb[0]); hr = Math.max(hr, bb[2]); ht = Math.min(ht, bb[1]); hb = Math.max(hb, bb[3]) }
    }
    // 首ふりの円筒の半径: 顔の半幅より少し広く(端で傾きが無限にならない)
    e.headR = (fr > fl ? (fr - fl) / 2 : ch * 0.13) / 0.92
    e.headBox = hr > hl ? [hl - 40, ht - 40, hr + 40, hb + 40] : [0, 0, cw, ch]
    const er = rg.eye?.region
    // まぶたを閉じる軸: 目の下寄り(上まぶたが下りてくるように見える)
    e.eyeAxisY = er ? er[1] + (er[3] - er[1]) * 0.72 : e.piv.eyes[1]
    e.eyeH = er ? er[3] - er[1] : ch * 0.03
    const mr = rg.mouth?.region
    e.mouthW = mr ? Math.max(12, mr[2] - mr[0]) : 60
    e.parts = []
    const patch = (key, rel) => { const p = this.grid(e, e.headBox, 16, 16); Object.assign(p, { kind: 'patch', key, url: this.layerUrl(e, rel), name: key, group: 'patch', depth: e.faceDepth }); return p }
    const v = rg.variants || {}
    const patches = []
    for (const [k, rel] of Object.entries(v.eyes || {})) patches.push(patch('eyes:' + k, rel))
    ;(rg.thaBank?.eyeBlink || []).forEach((rel, i) => patches.push(patch('blink:' + i, rel)))
    for (const [k, rel] of Object.entries(v.mouthHalf || {})) patches.push(patch('mouthHalf:' + k, rel))
    for (const [k, rel] of Object.entries(v.mouth || {})) patches.push(patch('mouth:' + k, rel))
    e.has = { eyesClosed: !!v.eyes?.closed, eyesHalf: !!v.eyes?.half, bank: (rg.thaBank?.eyeBlink || []).length, mouth: Object.keys(v.mouth || {}), mouthHalf: Object.keys(v.mouthHalf || {}) }
    let patchesIn = false
    for (const ly of layers) {
      if (!ly.file || !ly.bbox) continue
      const sway = ly.sway || fallbackSway(ly.name, ly.group)
      const st = sway?.type
      const face = (ly.group === 'head' || ly.group === 'eyes' || ly.group === 'mouth') && !st
      // 描き差分(口・まぶた)は前髪のすぐ下に入れる
      if (ly.group === 'fronthair' && !patchesIn) { e.parts.push(...patches); patchesIn = true }
      const [nx, ny] = st === 'hair' ? [18, 22] : st === 'cloth' ? [12, 14] : st === 'neck' ? [6, 12] : face ? [12, 12] : [2, 2]
      const common = { url: this.layerUrl(e, ly.file), name: ly.name, group: ly.group, depth: num(ly.depth, 0.5), sway, bbox: ly.bbox, phase: (strHash(String(ly.name)) % 6283) / 1000 }
      const sks = skinsOf.get(ly.name)
      if (sks) {
        // ボーンで曲げる層(bones.json の格子とウェイト)。腕・脚は左右 1 枚ずつ(同じ PNG を uClip で分けて描く)
        for (const sk of sks) {
          const g = sk.grid, p = this.grid(e, [g.box[0] + 3, g.box[1] + 3, g.box[2] - 3, g.box[3] - 3], g.nx, g.ny)
          Object.assign(p, common, { kind: 'skin', skin: sk, nb: sk.bones.length })
          if (Array.isArray(sk.clip)) p.mesh.material.uniforms.uClip.value.set(sk.clip[0], sk.clip[1], sk.clip[2])
          e.parts.push(p)
        }
        continue
      }
      const p = this.grid(e, ly.bbox, nx, ny)
      Object.assign(p, common, { kind: st || (face ? 'face' : 'body') })
      e.parts.push(p)
      if (ly.group === 'mouth') {
        // 手続きの口の中(描き差分が無いとき): 暗い楕円 + 歯 + 舌。口のレイヤーのすぐ上
        const c = this.grid(e, [0, 0, 2, 2], 2, 2)
        Object.assign(c, { kind: 'cavity', name: '(mouth cavity)', group: 'mouth', depth: num(ly.depth, 0.5) })
        c.mesh.geometry.getAttribute('uv').array.set([0, 0, 1, 0, 0, 1, 1, 1])
        e.parts.push(c)
      }
    }
    if (!patchesIn) e.parts.push(...patches)
  }

  cavity() {
    if (this.cavityTex) return this.cavityTex
    const cv = document.createElement('canvas')
    cv.width = cv.height = 128
    const g = cv.getContext('2d')
    g.beginPath(); g.ellipse(64, 64, 62, 62, 0, 0, TAU); g.closePath(); g.clip()
    g.fillStyle = 'rgba(54,9,15,0.96)'; g.fillRect(0, 0, 128, 128)
    g.fillStyle = 'rgba(242,236,233,0.85)'; g.fillRect(8, 2, 112, 22)
    g.fillStyle = 'rgba(150,40,58,0.9)'; g.beginPath(); g.ellipse(64, 104, 44, 30, 0, 0, TAU); g.fill()
    return (this.cavityTex = canvasTexture(cv))
  }

  prepare(scene, L, f) {
    const e = this.entry(scene, L)
    if (!e || e.state !== 'ready') return
    for (const p of e.parts) if (p.url) this.env.assets.image(p.url)
  }
  // source.crop: [左, 上, 右, 下](パペットのキャンバスの px)= その範囲だけをレイヤーの箱にする(バストアップ・顔の寄り)。動いて外へ出たぶんは切れる
  cropOf(e, L) {
    const c = L.def.source?.crop, [cw, ch] = e.size
    if (!Array.isArray(c) || c.length < 4) return [0, 0, cw, ch]
    const l = clamp(num(c[0], 0), 0, cw - 1), t = clamp(num(c[1], 0), 0, ch - 1)
    return [l, t, clamp(num(c[2], cw), l + 1, cw), clamp(num(c[3], ch), t + 1, ch)]
  }
  bounds(scene, L) {
    const e = this.entry(scene, L)
    if (!e || e.state !== 'ready') return null
    const c = this.cropOf(e, L)
    return { x: -(c[2] - c[0]) / 2, y: -(c[3] - c[1]) / 2, w: c[2] - c[0], h: c[3] - c[1] }
  }
  // RT のどこを映すか(RT は上が v = 1)
  uvRect(scene, L) {
    const e = this.entry(scene, L), c = this.cropOf(e, L), [cw, ch] = e.size
    return [c[0] / cw, 1 - c[1] / ch, c[2] / cw, 1 - c[3] / ch]
  }

  // ---- そのコマの値 ----
  params(e, s, f, fps) {
    const P = (k, d) => num(evalProp(s[k], f, fps), d)
    const t = f / fps
    // 書き方は 2 通り: 平らな項目(sway / wind / sway_speed …)か、まとめた形(sway: {amount, wind, speed, lag, seed} など)
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && !Array.isArray(v.k) && v.v === undefined && !v.wiggle
    const sw = isObj(s.sway) ? s.sway : { amount: s.sway, wind: s.wind, speed: s.sway_speed, lag: s.sway_lag, seed: s.sway_seed }
    const br = isObj(s.breath) ? s.breath : { amount: s.breath, period: s.breath_period }
    const ab = s.auto_blink
    let blink = clamp(P('blink', 0), 0, 1)
    if (ab) {
      const o = isObj(ab) ? ab : { interval: s.blink_interval, seed: s.blink_seed, duration: s.blink_duration }
      const iv = Math.max(0.4, num(evalProp(o.interval, f, fps), 3.4)), dur = Math.max(0.05, num(evalProp(o.duration, f, fps), 0.24)), seed = num(o.seed, 1) | 0
      const k = Math.floor(t / iv)
      // 区間 k に 1 回。始まりは区間の 15〜85 % のどこか(種で決まる)
      for (const j of [k - 1, k]) {
        if (j < 0) continue
        const t0 = (j + 0.15 + 0.7 * rand01(seed, j, 77)) * iv
        blink = Math.max(blink, blinkShape((t - t0) / dur))
      }
    }
    const look = vec(evalProp(s.look, f, fps) ?? [0, 0], 2, 0)
    return {
      t, blink, mouth: clamp(P('mouth', 0), 0, 1), vowel: String(evalProp(s.vowel, f, fps) ?? 'a'),
      turn: clamp(P('head_turn', 0), -1, 1), tilt: P('head_tilt', 0) * DEG, nod: clamp(P('head_nod', 0), -1, 1), lean: P('body_lean', 0) * DEG,
      shift: vec(evalProp(s.head_shift, f, fps) ?? [0, 0], 2, 0), brow: clamp(P('brow', 0), -1, 1), lookX: clamp(look[0], -1, 1), lookY: clamp(look[1], -1, 1),
      breath: num(evalProp(br.amount, f, fps), 1), breathPeriod: Math.max(0.3, num(evalProp(br.period, f, fps), 4)),
      sway: num(evalProp(sw.amount, f, fps), 1), wind: num(evalProp(sw.wind, f, fps), 0), speed: num(evalProp(sw.speed, f, fps), 1),
      lag: Math.max(0, num(evalProp(sw.lag, f, fps), 0.16)), seed: num(sw.seed, 0),
      bone: e.bones ? this.boneParams(s, f, fps) : null,
    }
  }
  // ボーンの値: pose_preset(マネキンと同じ名前)+ pose_phase(0〜1)+ pose_amount(0〜1 = 立ち姿からどれだけ寄せるか)に、pose: {関節: 度 か [度, 長さの倍率]} を足す
  boneParams(s, f, fps) {
    const ps = s.pose && typeof s.pose === 'object' ? s.pose : null
    const name = evalProp(s.pose_preset, f, fps)
    const b = { preset: typeof name === 'string' && PUPPET_PRESETS.includes(name) ? name : null, phase: num(evalProp(s.pose_phase, f, fps), 0),
      amount: clamp(num(evalProp(s.pose_amount, f, fps), 1), 0, 1), ground: s.pose_ground, ang: {}, len: {}, any: false }
    if (b.preset === 'stand' || b.amount <= 0) b.preset = null
    if (b.preset) b.any = true
    if (ps) for (const j of POSE_JOINTS) {
      if (ps[j] === undefined || ps[j] === null) continue
      const v = evalProp(ps[j], f, fps)
      const a = num(v, 0), l = Array.isArray(v) && typeof v[1] === 'number' ? clamp(v[1], 0.1, 2) : 1
      if (a !== 0 || l !== 1) { b.ang[j] = a * DEG; b.len[j] = l; b.any = true }
    }
    return b
  }
  // ボーンの行列(FK)。→ {lean, waist, neck(足すぶん・rad), build(body) → {名前: 行列}}
  boneMats(e, bq, body) {
    const B = e.bones, J = B.joints
    const pr = bq.preset ? presetLocal(bq.preset, bq.phase) : null, k = bq.amount
    // M = 頂点に掛ける行列(縮みを含む)、F = 子が乗る枠(縮みを含まない。親が縮んでも子の形はつぶれず、関節の位置だけが動く)
    const M = { pelvis: body }, F = { pelvis: body }
    for (const b of B.bones) {
      if (b.name === 'pelvis') continue
      const parM = M[b.parent] || body, parF = F[b.parent] || body, j = J[b.joint]
      if (!j) { M[b.name] = parM; F[b.name] = parF; continue }
      if (b.name === 'chest') { const a = (bq.ang.waist || 0) + (pr ? pr.waist * k : 0); M.chest = F.chest = a ? mul(parF, rig(j[0], j[1], a, 1, 1, 0, 0)) : parF; continue }
      const t = J[b.to] || [j[0], j[1] + 1]
      let dx = t[0] - j[0], dy = t[1] - j[1]
      const L = Math.hypot(dx, dy) || 1
      dx /= L; dy /= L
      const side = b.name.endsWith('_l') ? 1 : -1
      const pb = pr?.bones[b.name]
      const ang = (pb ? pb[0] * k : 0) - side * (bq.ang[b.angle] || 0)
      const len = (pb ? 1 + (pb[1] - 1) * k : 1) * (bq.len[b.angle] ?? 1)
      // 枠: 親の枠の上で関節のまわりに回し、関節が「縮んだ親」の上の位置に来るよう平行移動
      let fr = ang ? mul(parF, rig(j[0], j[1], ang, 1, 1, 0, 0)) : parF
      if (parM !== parF) {
        fr = fr.slice()
        fr[4] += parM[0] * j[0] + parM[2] * j[1] + parM[4] - (fr[0] * j[0] + fr[2] * j[1] + fr[4])
        fr[5] += parM[1] * j[0] + parM[3] * j[1] + parM[5] - (fr[1] * j[0] + fr[3] * j[1] + fr[5])
      }
      F[b.name] = fr
      M[b.name] = len !== 1 ? mul(fr, boneLocal(j, dx, dy, 0, len)) : fr
    }
    // 足を地面に付ける(walk・run、または pose_ground: true): いちばん低い足先が立ち姿の高さに来るよう、全体を上下にずらす
    if (bq.ground === true || (bq.ground !== false && pr?.ground && k > 0)) {
      let rest = -1e9, now = -1e9
      for (const s of ['l', 'r']) for (const [bn, jn] of [['foot_' + s, 'toe_' + s], ['shin_' + s, 'ankle_' + s]]) {
        const m = M[bn], j = J[jn]
        if (!m || !j) continue
        rest = Math.max(rest, body[1] * j[0] + body[3] * j[1] + body[5]); now = Math.max(now, m[1] * j[0] + m[3] * j[1] + m[5])
      }
      const dy = rest > -1e8 ? (rest - now) * (bq.ground === true ? 1 : k) : 0
      if (dy) for (const n of Object.keys(M)) { const m = M[n].slice(); m[5] += dy; M[n] = m }
    }
    return { M, neck: (bq.ang.neck || 0) + (pr ? pr.neck * k : 0), waist: (bq.ang.waist || 0) + (pr ? pr.waist * k : 0) }
  }
  // 体と頭の行列
  pose(e, q) {
    const S = e.S, [hx, hy] = e.piv.head, [bx, by] = e.piv.body
    const br = Math.sin((q.t / q.breathPeriod) * TAU) * q.breath
    const bob = -2.2 * S * br
    const headDx = q.shift[0] * S, headDy = bob * 0.5 + q.nod * 16 * S + q.shift[1] * S
    if (q.bone && q.bone.any) {
      // ボーンあり: 体(腰)→ 胸(腰の関節で曲がる)→ 頭。腕・脚は boneMats の行列
      const pr = q.bone.preset ? presetLocal(q.bone.preset, q.bone.phase) : null
      const lean = q.lean + (pr ? pr.lean * q.bone.amount : 0)
      const bm = this.boneMats(e, q.bone, rig(bx, by, lean, 1, 1 + 0.007 * br, q.turn * 7 * S, bob * 0.5))
      const body = bm.M.pelvis, chest = bm.M.chest || body
      const rideX = chest[0] * hx + chest[2] * hy + chest[4] - hx, rideY = chest[1] * hx + chest[3] * hy + chest[5] - hy
      const head = rig(hx, hy, q.tilt + lean + bm.waist + bm.neck, 1, 1, headDx + rideX, headDy + rideY)
      return { body, chest, M: bm.M, head, yawPhi: q.turn * YAW_MAX, yawCx: hx + headDx + rideX }
    }
    const body = rig(bx, by, q.lean, 1, 1 + 0.007 * br, q.turn * 7 * S, bob * 0.5)
    // 頭は体の首の付け根に乗る
    const rideX = body[0] * hx + body[2] * hy + body[4] - hx, rideY = body[1] * hx + body[3] * hy + body[5] - hy
    const head = rig(hx, hy, q.tilt + q.lean, 1, 1, headDx + rideX, headDy + rideY)
    return { body, chest: body, M: null, head, yawPhi: q.turn * YAW_MAX, yawCx: hx + headDx + rideX }
  }

  // → sRGB の値・乗算済みの RT(キャンバス大。上が v = 1)。呼び出し側が release。まだ読めていなければ null
  render(scene, L, f) {
    const e = this.entry(scene, L)
    if (!e || e.state !== 'ready') return null
    const env = this.env, g = env.gfx, s = L.def.source || {}, fps = scene.fps
    const q = this.params(e, s, f, fps)
    const po = this.pose(e, q)
    // 毛先・すその遅れ用: 少し前の姿勢
    const lagF = q.lag * fps
    const q2 = lagF > 0 ? this.params(e, s, f - lagF, fps) : q
    const po2 = lagF > 0 ? this.pose(e, q2) : po
    const S = e.S, R = e.headR
    const { head, body, chest, yawPhi, yawCx } = po
    // 腰から下の層(bones.json の lower_layers)は体(腰)、それ以外は胸に乗る。ボーンが無ければ胸 = 体
    const baseOf = (p) => (e.lower.has(p.name) ? body : chest), baseOf2 = (p) => (e.lower.has(p.name) ? po2.body : po2.chest)
    const yawX = (x, phi, cx) => {
      if (phi === 0) return x
      const xl = x - cx, u = clamp(xl / R, -1, 1)
      return cx + xl * Math.cos(phi) + R * Math.sqrt(1 - u * u) * Math.sin(phi)
    }
    // 奥行きの視差(手前の部品ほど首ふり・うなずきで大きく動く)
    const par = (depth) => [yawPhi * (0.5 - depth) * R * 0.3, q.nod * (0.5 - depth) * R * 0.1]

    // 目・口
    const [ex, ey] = e.piv.eyes, [mx, my] = e.piv.mouth
    const c = q.blink
    let eyeKey = ''
    if (e.has.bank) { if (c > 0.12) eyeKey = 'blink:' + Math.min(e.has.bank - 1, Math.floor(c * e.has.bank)) }
    else if (c > 0.72 && e.has.eyesClosed) eyeKey = 'eyes:closed'
    else if (c > 0.3 && e.has.eyesHalf) eyeKey = 'eyes:half'
    // 描いたまぶたが無いときは、目(白目・虹彩・まつ毛)を縦につぶす
    const eyeSY = eyeKey ? 1 - 0.1 * c : Math.max(0.05, 1 - c * 0.95)
    const lookDy = q.lookY * 4 * S
    const mEyes = rig(ex, e.eyeAxisY, 0, 1, eyeSY, 0, 0)
    const mPupil = rig(ex, e.eyeAxisY, 0, 1, eyeSY, clamp(q.lookX * 7, -7, 7) * S, lookDy)
    const mBrow = rig(ex, ey, 0, 1, 1, 0, -q.brow * 7 * S - c * 0.06 * e.eyeH)
    let mouthKey = ''
    const vw = q.vowel
    if (e.has.mouth.length && q.mouth > 0.12) {
      const full = e.has.mouth.includes(vw) ? vw : e.has.mouth[0]
      mouthKey = q.mouth > 0.5 || !e.has.mouthHalf.includes(full) ? 'mouth:' + full : 'mouthHalf:' + full
    }
    const proc = mouthKey ? 0 : q.mouth
    const mMouth = rig(mx, my, 0, 1, 1 + 0.45 * proc, 0, 4 * S * proc)
    // 差分の口: 段の入り口で縦に少しつぶれた形から開く(0.12 → 半開、0.5 → 全開)
    const band = q.mouth > 0.5 ? (q.mouth - 0.5) / 0.15 : (q.mouth - 0.12) / 0.12
    const mPatchMouth = rig(mx, my, 0, 1, 0.72 + 0.28 * sstep(band), 0, 0)

    // ゆれ(閉じた式): 大きなうねり 3 本 + はためき + 房ごとのさざ波。p = レイヤーごとの位相
    const sp = q.speed, sd = q.seed * 1.618
    const gust = (p) => q.wind * 0.8 + 0.55 * Math.sin(q.t * 0.93 * sp + p + sd) + 0.3 * Math.sin(q.t * 2.2 * sp + 1.3 + p * 1.7 + sd) + 0.15 * Math.sin(q.t * 5.1 * sp + 2.7 + p * 2.3)

    const [cw, ch] = e.size
    const res = clamp(scene.fxRes(L), 0.5, 2)
    const rt = g.acquire(cw * res, ch * res)
    g.clear(rt)
    const sc = this.scene
    while (sc.children.length) sc.remove(sc.children[0])
    const hide = Array.isArray(s.hide) ? s.hide : null
    let order = 0
    for (const p of e.parts) {
      if (hide && hide.includes(p.name)) continue
      let tex, opacity = 1
      if (p.kind === 'cavity') {
        if (proc <= 0.05) continue
        tex = this.cavity()
      } else {
        if (p.kind === 'patch' && p.key !== eyeKey && p.key !== mouthKey) continue
        const im = env.assets.image(p.url)
        if (im.state !== 'ready') continue
        tex = im.tex
      }
      const { base, pos } = p, n = base.length / 2
      const [px, py] = par(p.depth)
      if (p.kind === 'face' || p.kind === 'patch') {
        let m = head
        if (p.kind === 'patch') { if (p.key.startsWith('mouth')) m = mul(head, mPatchMouth) }
        else if (p.group === 'eyes') m = mul(head, p.name === 'eyebrow' ? mBrow : p.name === 'irides' ? mPupil : mEyes)
        else if (p.group === 'mouth') m = mul(head, mMouth)
        for (let i = 0; i < n; i++) {
          const x = base[i * 2], y = base[i * 2 + 1]
          pos[i * 3] = yawX(m[0] * x + m[2] * y + m[4], yawPhi, yawCx) + px
          pos[i * 3 + 1] = m[1] * x + m[3] * y + m[5] + py
        }
      } else if (p.kind === 'cavity') {
        // 口の幅に合わせた楕円。唇から下へ開く
        const w = e.mouthW * 0.36, h = e.mouthW * 0.34 * proc, cy = my + h * 0.45
        const q4 = [[mx - w, cy - h], [mx + w, cy - h], [mx - w, cy + h], [mx + w, cy + h]]
        const wx = head[0] * mx + head[2] * my + head[4]
        const dxy = yawX(wx, yawPhi, yawCx) - wx + px
        for (let i = 0; i < 4; i++) {
          pos[i * 3] = head[0] * q4[i][0] + head[2] * q4[i][1] + head[4] + dxy
          pos[i * 3 + 1] = head[1] * q4[i][0] + head[3] * q4[i][1] + head[5] + py
        }
        opacity = clamp(proc * 4, 0, 1)
      } else if (p.kind === 'neck') {
        // 首: 下の端は体に、上の端は頭に付く(間はなめらかに混ぜる)
        const span = Math.max(1, p.bbox[3] - p.bbox[1])
        const [npx, npy] = par(e.faceDepth)
        for (let i = 0; i < n; i++) {
          const x = base[i * 2], y = base[i * 2 + 1]
          const w = sstep((p.bbox[3] - y) / span)
          const bxv = chest[0] * x + chest[2] * y + chest[4], byv = chest[1] * x + chest[3] * y + chest[5]
          const hxv = yawX(head[0] * x + head[2] * y + head[4], yawPhi, yawCx) + npx, hyv = head[1] * x + head[3] * y + head[5] + npy
          pos[i * 3] = bxv + (hxv - bxv) * w
          pos[i * 3 + 1] = byv + (hyv - byv) * w
        }
      } else if (p.kind === 'hair' || p.kind === 'cloth') {
        const onHead = p.sway.pin !== 'body'
        const m = onHead ? head : baseOf(p), m2 = onHead ? po2.head : baseOf2(p)
        const amp = num(p.sway.amp, 1) * q.sway, pinY = num(p.sway.pinY, p.kind === 'hair' ? 0.22 : 0.28)
        const top = p.bbox[1], span = Math.max(1, p.bbox[3] - p.bbox[1])
        // 首ふりへの乗り方: 前髪は顔といっしょ、後ろ髪は半分ほど、布は乗らない
        const yawAmt = !onHead || p.kind !== 'hair' ? 0 : p.group === 'backhair' ? 0.55 : 1
        const dep = p.group === 'fronthair' ? e.faceDepth : p.depth
        const [hpx, hpy] = par(dep)
        const gu = gust(p.phase)
        const flutter = Math.sin(q.t * 3.9 * sp + p.phase * 3.1) * 0.27
        for (let i = 0; i < n; i++) {
          const x = base[i * 2], y = base[i * 2 + 1]
          const tip = clamp((y - top) / span, 0, 1)
          const sw = sstep((tip - pinY) / Math.max(1e-3, 1 - pinY)) // 0 = 根元(固定)〜 1 = 先
          const swing = sw * amp
          // いまの姿勢と少し前の姿勢を、先ほど強く混ぜる(根元は必ずいまの姿勢 = 頭・体から離れない)
          const k = clamp(sw * 0.7 * Math.min(1, amp + 0.4), 0, 0.85)
          let X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5]
          let px0 = hpx, phi = yawPhi, cx = yawCx
          if (k > 0 && m2 !== m) {
            X += (m2[0] * x + m2[2] * y + m2[4] - X) * k
            Y += (m2[1] * x + m2[3] * y + m2[5] - Y) * k
            if (yawAmt) { phi += (po2.yawPhi - yawPhi) * k; cx += (po2.yawCx - yawCx) * k; px0 = phi * (0.5 - dep) * R * 0.3 }
          }
          const wave = Math.sin(y * 0.02 - q.t * 7.2 * sp + x * 0.013 + p.phase) * 4
          X += ((gu + flutter) * 26 + wave) * S * swing
          Y += Math.abs(gu) * -3 * S * swing
          if (yawAmt) X += (yawX(X, phi, cx) - X) * yawAmt + px0 * yawAmt
          pos[i * 3] = X
          pos[i * 3 + 1] = Y + (yawAmt ? hpy * yawAmt : 0)
        }
      } else if (p.kind === 'skin') {
        // ボーンのスキニング: 頂点 = Σ ウェイト × ボーンの行列 × 元の位置
        const sk = p.skin, nb = p.nb, W = sk.weights, base0 = baseOf(p)
        const Ms = sk.bones.map((bn) => (po.M && po.M[bn]) || (bn === 'chest' ? chest : bn === 'pelvis' ? body : base0))
        // すそのゆれ(布と分類された層だけ。ボーンの変形の上に足す)
        const cloth = p.sway?.type === 'cloth' ? num(p.sway.amp, 1) * q.sway : 0
        const top = p.bbox[1], span = Math.max(1, p.bbox[3] - p.bbox[1]), pinY = num(p.sway?.pinY, 0.28)
        const gu = cloth ? gust(p.phase) + Math.sin(q.t * 3.9 * sp + p.phase * 3.1) * 0.27 : 0
        for (let i = 0; i < n; i++) {
          const x = base[i * 2], y = base[i * 2 + 1]
          let X = 0, Y = 0, ws = 0
          for (let k = 0; k < nb; k++) {
            const w = W[i * nb + k]
            if (!w) continue
            const m = Ms[k]
            X += w * (m[0] * x + m[2] * y + m[4]); Y += w * (m[1] * x + m[3] * y + m[5]); ws += w
          }
          if (ws > 0) { X /= ws; Y /= ws } else { X = base0[0] * x + base0[2] * y + base0[4]; Y = base0[1] * x + base0[3] * y + base0[5] }
          if (cloth) {
            const swing = sstep((clamp((y - top) / span, 0, 1) - pinY) / Math.max(1e-3, 1 - pinY)) * cloth
            X += (gu * 26 + Math.sin(y * 0.02 - q.t * 7.2 * sp + x * 0.013 + p.phase) * 4) * S * swing
          }
          pos[i * 3] = X
          pos[i * 3 + 1] = Y
        }
      } else {
        const m = p.group === 'head' ? head : baseOf(p)
        for (let i = 0; i < n; i++) {
          const x = base[i * 2], y = base[i * 2 + 1]
          pos[i * 3] = m[0] * x + m[2] * y + m[4]
          pos[i * 3 + 1] = m[1] * x + m[3] * y + m[5]
        }
      }
      p.mesh.geometry.getAttribute('position').needsUpdate = true
      p.mesh.material.uniforms.uMap.value = tex
      p.mesh.material.uniforms.uOpacity.value = opacity
      p.mesh.renderOrder = order++
      sc.add(p.mesh)
    }
    try {
      env.renderer.setRenderTarget(rt)
      env.renderer.render(sc, this.cam)
    } catch (err) { console.warn('[comp-engine] puppet', err); g.release(rt); return null }
    return rt
  }

  dispose() {
    for (const e of this.items.values()) for (const p of e.parts) { p.mesh.geometry.dispose(); p.mesh.material.dispose() }
    this.items.clear()
    this.cavityTex?.dispose(); this.cavityTex = null
  }
}
