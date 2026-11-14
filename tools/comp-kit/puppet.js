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
uniform sampler2D uMap; uniform float uOpacity; varying vec2 vUv;
void main(){ gl_FragColor = texture2D(uMap, vUv) * uOpacity; }`

// 古い manifest(sway の分類なし)むけの名前からの推定
function fallbackSway(name, group) {
  if (name === 'neck') return { type: 'neck', pin: '', amp: 0 }
  if (group === 'backhair') return { type: 'hair', pin: 'head', amp: 1 }
  if (group === 'fronthair') return { type: 'hair', pin: 'head', amp: 0.32 }
  if (name === 'bottomwear') return { type: 'cloth', pin: 'body', amp: 0.42 }
  return null
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
        this.build(e, man)
        e.state = 'ready'
        this.env.invalidate()
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
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uMap: { value: null }, uOpacity: { value: 1 }, uSize: { value: new THREE.Vector2(cw, ch) } },
      depthTest: false, depthWrite: false, transparent: true, toneMapped: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    })
    const mesh = new THREE.Mesh(g, mat)
    mesh.frustumCulled = false
    return { mesh, base, pos, nx, ny, box: [l, t, r, b] }
  }

  build(e, man) {
    e.man = man
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
      const p = this.grid(e, ly.bbox, nx, ny)
      Object.assign(p, { kind: st || (face ? 'face' : 'body'), url: this.layerUrl(e, ly.file), name: ly.name, group: ly.group, depth: num(ly.depth, 0.5), sway, bbox: ly.bbox, phase: (strHash(String(ly.name)) % 6283) / 1000 })
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
    }
  }
  // 体と頭の行列
  pose(e, q) {
    const S = e.S, [hx, hy] = e.piv.head, [bx, by] = e.piv.body
    const br = Math.sin((q.t / q.breathPeriod) * TAU) * q.breath
    const bob = -2.2 * S * br
    const body = rig(bx, by, q.lean, 1, 1 + 0.007 * br, q.turn * 7 * S, bob * 0.5)
    // 頭は体の首の付け根に乗る
    const rideX = body[0] * hx + body[2] * hy + body[4] - hx, rideY = body[1] * hx + body[3] * hy + body[5] - hy
    const headDx = q.shift[0] * S, headDy = bob * 0.5 + q.nod * 16 * S + q.shift[1] * S
    const head = rig(hx, hy, q.tilt + q.lean, 1, 1, headDx + rideX, headDy + rideY)
    return { body, head, yawPhi: q.turn * YAW_MAX, yawCx: hx + headDx + rideX }
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
    const { head, body, yawPhi, yawCx } = po
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
          const bxv = body[0] * x + body[2] * y + body[4], byv = body[1] * x + body[3] * y + body[5]
          const hxv = yawX(head[0] * x + head[2] * y + head[4], yawPhi, yawCx) + npx, hyv = head[1] * x + head[3] * y + head[5] + npy
          pos[i * 3] = bxv + (hxv - bxv) * w
          pos[i * 3 + 1] = byv + (hyv - byv) * w
        }
      } else if (p.kind === 'hair' || p.kind === 'cloth') {
        const onHead = p.sway.pin !== 'body'
        const m = onHead ? head : body, m2 = onHead ? po2.head : po2.body
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
      } else {
        const m = p.group === 'head' ? head : body
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
