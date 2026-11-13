// 1 つのコンポジション文書を描く。入れ子のコンポジションも同じクラスを使う。
//   render(f) → 画面と同じ大きさの RT(乗算済みアルファ)。呼び出し側が release する。
// 行列はコンポジションの座標(左上原点・y 下向き・z 奥が正)のまま計算し、射影で初めて GL の向きに直す。
//
// 1 レイヤーを描く流れ:
//   中身(content)→ エフェクトの列を上から順に(runChain)→ 複製(repeater)→ 画面へ(emit)
//   軽いエフェクト(切る・色・位置の足し算)はシェーダと行列だけで済ませ、RT を使わない。
//   重いエフェクト(ぼかし・縁など)が出てきたときだけ、レイヤーの箱 + 余白の大きさの RT に描いて掛ける。
import { THREE, QuadBatch, isGlBlend, MAX_MASKS, MASK_PTS } from './gfx.js'
import { evalProp, evalAll, evalVec, toColor, num, vec, maxAbs, clamp, isAnimated, ease, rand01 } from './props.js'
import { rasterShape, shapePolyline, flattenPath, isPatternFill, makeCanvas } from './shape.js'
import { layoutText, fillTextBatch, fontSpec } from './text.js'
import { fillParticles, SPRITE_KINDS, PARTICLE_PRESETS } from './particles.js'
import { canvasTexture } from './assets.js'
import { ModelStore } from './model.js'
import { patternUniforms } from './pattern.js'
import { INLINE, opsGlsl, MAX_OP_VEC4, MAX_OP_TEX } from './ops.js'
import { isPass } from './effects.js'

const D2R = Math.PI / 180
const DEFAULT_FOV = 39.6 // AE の 50mm 相当(水平画角)
const DRAWABLE = new Set(['image', 'video', 'sequence', 'text', 'shape', 'solid', 'pattern', 'comp', 'model', 'particles', 'adjustment'])
const KNOWN = new Set([...DRAWABLE, 'null', 'camera', 'group'])
const SHADER_BLEND = {
  multiply: 0, overlay: 1, lighten: 2, darken: 3, difference: 4, normal: 5, add: 6, screen: 7,
  subtract: 8, exclusion: 9, hard_light: 10, soft_light: 11, color_dodge: 12, color_burn: 13, linear_burn: 14,
}
const MB_SAMPLES = 16, MB_SHUTTER = 0.5 // モーションブラー: 180° シャッター。motion_blur に数を書くとその回数
const MAX_DEPTH = 8
const MAX_COPIES = 4096
const GEO = new Set(['flip', 'repeat', 'tile'])
const SKIP = new Set(['offset', 'aviutl_script'])

const BLEND_FRAG = /* glsl */ `
uniform sampler2D tBase, tSrc; uniform float uOpacity; uniform int uMode; varying vec2 vUv;
vec3 ov(vec3 b, vec3 s){ return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b)); }
void main(){
  vec4 d = texture2D(tBase, vUv), s = texture2D(tSrc, vUv) * uOpacity;
  vec3 cd = d.a > 1e-5 ? d.rgb / d.a : vec3(0.0), cs = s.a > 1e-5 ? s.rgb / s.a : vec3(0.0);
  vec3 B;
  if (uMode == 0) B = cd * cs;
  else if (uMode == 1) B = ov(cd, cs);
  else if (uMode == 2) B = max(cd, cs);
  else if (uMode == 3) B = min(cd, cs);
  else if (uMode == 4) B = abs(cd - cs);
  else if (uMode == 6) B = min(cd + cs, vec3(1.0));
  else if (uMode == 7) B = cd + cs - cd * cs;
  else if (uMode == 8) B = max(cd - cs, vec3(0.0));
  else if (uMode == 9) B = cd + cs - 2.0 * cd * cs;
  else if (uMode == 10) B = ov(cs, cd);
  else if (uMode == 11) B = mix(cd - (1.0 - 2.0 * cs) * cd * (1.0 - cd), cd + (2.0 * cs - 1.0) * (sqrt(cd) - cd), step(0.5, cs));
  else if (uMode == 12) B = min(cd / max(1.0 - cs, vec3(1e-4)), vec3(1.0));
  else if (uMode == 13) B = 1.0 - min((1.0 - cd) / max(cs, vec3(1e-4)), vec3(1.0));
  else if (uMode == 14) B = max(cd + cs - 1.0, vec3(0.0));
  else B = cs;
  // W3C の合成式(乗算済みで出す)
  vec3 co = s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * B;
  gl_FragColor = vec4(co, s.a + d.a - s.a * d.a);
}`
const MATTE_FRAG = /* glsl */ `
uniform sampler2D tSrc, tMatte; uniform int uMode; varying vec2 vUv;
void main(){
  vec4 m = texture2D(tMatte, vUv);
  float k = uMode < 2 ? m.a : dot(m.rgb, vec3(0.2126, 0.7152, 0.0722));
  if (uMode == 1 || uMode == 3) k = 1.0 - k;
  gl_FragColor = texture2D(tSrc, vUv) * clamp(k, 0.0, 1.0);
}`
const MIX_FRAG = /* glsl */ `
uniform sampler2D tA, tB, tM; varying vec2 vUv;
void main(){ gl_FragColor = mix(texture2D(tA, vUv), texture2D(tB, vUv), texture2D(tM, vUv).a); }`
const MATTE_MODE = { alpha: 0, alpha_inv: 1, luma: 2, luma_inv: 3 }

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4(), _e = new THREE.Euler()
const _d = new THREE.Vector3()
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector4()
const _q = new THREE.Quaternion(), _s3 = new THREE.Vector3()
const _c12 = new Float32Array(12), _l8 = new Float32Array(8)
const _pa = [0, 0], _pb = [0, 0], _pc = [0, 0]
const _u8 = new Float32Array(8), _q8 = new Float32Array(8)

function rotVec(r) {
  if (Array.isArray(r)) return r.length >= 3 ? [num(r[0]), num(r[1]), num(r[2])] : [0, 0, num(r[r.length - 1])]
  return [0, 0, num(r, 0)]
}
const isDefaultConst = (p, d) => p == null || (!isAnimated(p) && Array.isArray(p) && p.every((x, i) => x === (d[i] ?? d[d.length - 1])))
// 文書のどこかにキーフレームがあるか(深さ制限つき)
function anyAnimated(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 5) return false
  if (Array.isArray(v)) return v.some((x) => anyAnimated(x, depth + 1))
  if (Array.isArray(v.k) || v.wiggle) return true
  for (const k in v) if (anyAnimated(v[k], depth + 1)) return true
  return false
}
const newCam = () => ({ stamp: NaN, world: new THREE.Matrix4(), view: new THREE.Matrix4(), vp: new THREE.Matrix4(), zoom: 1, ortho: false, dof: null })
const opsCache = new Map() // 署名 → GLSL

export class CompScene {
  constructor(env, comp) {
    this.env = env
    this.layers = new Map() // id → 実行時の情報(キャッシュつき)
    this.order = []
    this.overrides = new Map() // id → {position}(ドラッグ中の仮の値)
    this.p2d = new THREE.Matrix4()
    this.cam0 = newCam()
    this.warned = new Set()
    this.mcache = new Map() // マット・切り抜き元の RT(1 回の render の間だけ)
    this.setComp(comp)
  }

  warn(key, ...msg) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn('[comp-engine]', ...msg)
  }

  // 文書の差し替え。id と type が同じレイヤーはキャッシュ(テクスチャなど)を引き継ぐ。
  // テクスチャは中身のハッシュで引くので、transform だけの変更では作り直さない
  setComp(comp) {
    this.comp = comp
    this.W = Math.max(1, comp.width | 0); this.H = Math.max(1, comp.height | 0)
    this.fps = comp.fps || 30
    this.duration = comp.duration_frames || 1
    this.p2d.set(2 / this.W, 0, 0, -1, 0, -2 / this.H, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1)
    const defs = Array.isArray(comp.data?.layers) ? comp.data.layers : []
    const next = new Map()
    this.order = []
    this.matteSources = new Set()
    this.anySolo = false
    for (const def of defs) {
      if (!def || def.id == null) continue
      const id = String(def.id)
      if (next.has(id)) { this.warn('dup' + id, `id が重なっている: ${id}`); continue }
      if (!KNOWN.has(def.type)) this.warn('type' + def.type, `未対応のレイヤー種別: ${def.type}`)
      let L = this.layers.get(id)
      if (!L || L.type !== def.type) {
        if (L) this.disposeLayer(L)
        L = {
          id, type: def.type, cache: {}, batch: null, b1: null, rb: null, wm: new THREE.Matrix4(), dm: new THREE.Matrix4(), mvp: new THREE.Matrix4(),
          stamp: NaN, dStamp: NaN, mvpStamp: NaN, content: {}, xf: { stamp: NaN }, cam: null,
        }
      }
      L.def = def
      L.stamp = NaN; L.dStamp = NaN; L.mvpStamp = NaN; L.xf.stamp = NaN
      L.rsHint = 0; L.fxHint = 0; L.tv = undefined
      L.index = this.order.length
      L.groups = null; L.cams = null
      next.set(id, L)
      this.order.push(L)
      // マット元は隠す(AE と同じ)。keep_source: true ならマット元も映す(AviUtl の「上のオブジェクトでクリッピング」)
      if (def.matte?.layer != null && !def.matte.keep_source) this.matteSources.add(String(def.matte.layer))
      if (def.solo) this.anySolo = true
    }
    for (const [id, L] of this.layers) if (next.get(id) !== L) this.disposeLayer(L)
    this.layers = next
    // グループ・範囲つきカメラ: 自分より下の N 層(scope。0 か省略 = 下すべて、id の配列も可)に効く
    const covers = (G, L) => {
      const sc = G.def.scope
      if (Array.isArray(sc)) return sc.map(String).includes(L.id)
      const n = num(sc, 0)
      return L.index > G.index && (n <= 0 || L.index <= G.index + n)
    }
    const groups = this.order.filter((L) => L.type === 'group')
    const cams = this.order.filter((L) => L.type === 'camera')
    this.hasScopedCam = cams.some((c) => c.def.scope != null)
    for (const L of this.order) {
      if (groups.length) {
        const gs = groups.filter((G) => G !== L && covers(G, L))
        if (gs.length) L.groups = gs.sort((a, b) => b.index - a.index) // 近い(内側の)グループが先
      }
      if (cams.length && L.type !== 'camera') L.cams = cams.filter((c) => c.def.scope == null || covers(c, L))
    }
    this.cam0.stamp = NaN
  }

  disposeLayer(L) {
    L.batch?.dispose(); L.b1?.dispose(); L.rb?.dispose()
    for (const k of Object.keys(L.cache)) L.cache[k]?.tex?.dispose?.()
    this.env.assets.dropVideo(this.videoKey(L))
    L.cache = {}
  }
  dispose() {
    for (const L of this.layers.values()) this.disposeLayer(L)
    this.layers.clear(); this.order = []
    this.clearMattes()
  }
  videoKey(L) { return `${this.comp.id ?? 'c'}:${L.id}` }
  // 行列などのコマごとの覚えを捨てる(ドラッグ中の仮の値を入れたとき)
  resetStamps() {
    for (const L of this.layers.values()) { L.stamp = NaN; L.dStamp = NaN; L.mvpStamp = NaN; L.xf.stamp = NaN; L.gStamp = NaN; if (L.cam) L.cam.stamp = NaN }
    this.cam0.stamp = NaN
  }

  // ---- 時間と表示 ----
  inRange(L, f) {
    const d = L.def
    return f >= (d.in ?? 0) && f < (d.out ?? Infinity)
  }
  active(L, f) {
    const d = L.def
    if (d.visible === false || !this.inRange(L, f)) return false
    if (d.guide && this.env.mode === 'capture') return false // 下絵: 書き出しには出さない
    if (this.anySolo && !d.solo && L.type !== 'camera' && L.type !== 'null' && L.type !== 'group') return false
    return true
  }
  // レイヤーの中の時刻。posterize_time(コマ打ち)= 1 秒あたり N コマに間引く
  lt(L, f) {
    const pt = L.def.posterize_time
    if (pt == null) return f
    const n = num(evalProp(pt, f, this.fps), 0)
    if (!(n > 0) || n >= this.fps) return f
    const step = this.fps / n, i0 = L.def.in ?? 0
    return i0 + Math.floor((f - i0) / step + 1e-6) * step
  }

  // ---- 変形 ----
  tr(L, key, f, dflt) {
    if (key === 'position') {
      const o = this.overrides.get(L.id)
      if (o && o.position) return o.position
      return evalVec(L.def.transform?.position, f, this.fps, dflt)
    }
    return evalProp(L.def.transform?.[key], f, this.fps, dflt)
  }
  // 登場・退場(transition_in / transition_out)。→ そのコマでの「見えている割合」など
  transitionState(L, f, X) {
    const d = L.def
    const one = (t, vis, isOut) => {
      const q = 1 - vis
      if (q <= 1e-6) return
      const type = t.type || 'fade'
      const prm = { ...t }
      switch (type) {
        case 'fade': X.op *= vis; break
        case 'slide': {
          const dirs = { left: 270, right: 90, up: 0, down: 180 }
          const ang = (typeof t.direction === 'string' ? dirs[t.direction] ?? 270 : num(t.direction ?? t.angle, 270)) * D2R
          const dist = num(t.distance, 300) * q
          // from: 入ってくる向きの逆側から(direction = 来る元の方角)
          X.px += Math.sin(ang) * dist; X.py += -Math.cos(ang) * dist
          if (t.fade !== false) X.op *= vis
          break
        }
        case 'zoom': { const k = num(t.from, 0) / 100; const s = k + (1 - k) * vis; X.sx *= s; X.sy *= s; if (t.fade) X.op *= vis; break }
        case 'flip': { const c = Math.cos(q * Math.PI / 2); if (t.axis === 'x') X.sy *= c; else X.sx *= c; break }
        case 'blur': X.fx.push({ type: 'blur', p: { radius: num(t.radius, 40) * q } }); if (t.fade !== false) X.op *= vis; break
        case 'wipe': X.fx.push({ type: 'wipe', p: { progress: q * 100, angle: num(t.angle, 90) + (isOut ? 0 : 180), feather: num(t.feather, 0) } }); break
        case 'blinds': X.fx.push({ type: 'blinds', p: { ...prm, ratio: vis * 100 } }); break
        case 'iris': X.fx.push({ type: 'iris', p: { ...prm, progress: vis * 100 } }); break
        case 'radial': X.fx.push({ type: 'radial_wipe', p: { ...prm, start: num(t.start, 0), sweep: (t.direction === 'ccw' ? -1 : 1) * vis * 360 } }); break
        case 'clip': {
          // 辺から開く(AviUtl のクリッピングを動かすのと同じ)。side = 最後まで隠れている側
          const side = t.side || 'bottom'
          X.fx.push({ type: 'crop', p: { [side]: q * 100, _pct: true, feather: num(t.feather, 0) } })
          break
        }
        default: this.warn('tr' + type, `未対応の transition: ${type}`); X.op *= vis
      }
    }
    const i0 = d.in ?? 0, o0 = d.out ?? this.duration
    const ti = d.transition_in, to = d.transition_out
    if (ti && typeof ti === 'object') {
      const dur = Math.max(1e-6, num(ti.duration, 15))
      if (f < i0 + dur) one(ti, ease(ti.e || 'easeOut', clamp((f - i0) / dur, 0, 1)), false)
    }
    if (to && typeof to === 'object') {
      const dur = Math.max(1e-6, num(to.duration, 15))
      if (f > o0 - dur) one(to, 1 - ease(to.e || 'easeIn', clamp((f - (o0 - dur)) / dur, 0, 1)), true)
    }
  }
  // 位置・拡大・回転・不透明度への足し算(offset エフェクトと transition)。同じコマなら使い回す
  xform(L, f) {
    const X = L.xf
    if (X.stamp === f) return X
    X.px = X.py = X.pz = 0; X.sx = X.sy = X.sz = 1; X.rx = X.ry = X.rz = 0; X.op = 1; X.fx = X.fx || []; X.fx.length = 0
    const fx = L.def.effects
    if (Array.isArray(fx)) {
      for (const e of fx) {
        if (!e || e.type !== 'offset' || e.enabled === false) continue
        const p = e.params || {}
        if (p.position != null) { const v = vec(evalVec(p.position, f, this.fps), 3, 0); X.px += v[0]; X.py += v[1]; X.pz += v[2] }
        if (p.scale != null) { const v = evalProp(p.scale, f, this.fps); const s = vec(v, 3, 100); X.sx *= s[0] / 100; X.sy *= (Array.isArray(v) ? s[1] : s[0]) / 100; if (Array.isArray(v) && v.length > 2) X.sz *= s[2] / 100 }
        if (p.rotation != null) { const r = rotVec(evalProp(p.rotation, f, this.fps)); X.rx += r[0]; X.ry += r[1]; X.rz += r[2] }
        if (p.opacity != null) X.op *= clamp(num(evalProp(p.opacity, f, this.fps), 100) / 100, 0, 1)
      }
    }
    if (L.def.transition_in || L.def.transition_out) this.transitionState(L, f, X)
    X.stamp = f
    return X
  }
  // 親を含まない行列(m に書く)
  local(L, f, m) {
    const X = this.xform(L, f)
    const is3d = L.def.three_d || L.type === 'model' || L.type === 'group'
    const pos = vec(this.tr(L, 'position', f, [this.W / 2, this.H / 2, 0]), 3, 0)
    const rot = rotVec(this.tr(L, 'rotation', f, 0))
    const sc = vec(this.tr(L, 'scale', f, 100), 3, 100)
    const an = vec(this.tr(L, 'anchor', f, 0), 3, 0)
    _e.set(is3d ? -(rot[0] + X.rx) * D2R : 0, is3d ? -(rot[1] + X.ry) * D2R : 0, (rot[2] + X.rz) * D2R, 'XYZ')
    m.makeRotationFromEuler(_e)
    m.scale(_v.set((sc[0] / 100) * X.sx, (sc[1] / 100) * X.sy, (sc[2] / 100) * X.sz))
    _v.set(an[0], an[1], an[2]).applyMatrix4(m)
    m.setPosition(pos[0] + X.px - _v.x, pos[1] + X.py - _v.y, (is3d ? pos[2] + X.pz : 0) - _v.z)
    return m
  }
  // レイヤーの世界行列(コンポジションの座標。親つき・グループなし)。同じコマなら使い回す
  world(L, f, depth = 0) {
    if (L.stamp === f) return L.wm
    const m = L.wm
    if (L.type === 'camera') this.cameraWorld(L, f, m, depth)
    else {
      this.local(L, f, m)
      const pid = L.def.parent
      if (pid != null && depth < 32) {
        const P = this.layers.get(String(pid))
        if (P && P !== L) m.premultiply(this.world(P, f, depth + 1))
      }
    }
    L.stamp = f
    return m
  }
  // レイヤーの原点(anchor)の世界座標
  originOf(L, f, out) {
    const w = this.drawWorld(L, f)
    const an = vec(this.tr(L, 'anchor', f, 0), 3, 0)
    return out.set(an[0], an[1], an[2]).applyMatrix4(w)
  }
  cameraWorld(L, f, m, depth) {
    const s = L.def.source || {}
    const zoom = this.zoomOf(L, f)
    // 注視点: target(座標)/ target_layer(レイヤーの位置)/ targets + target_index(順に移る)
    let tg = null
    const tl = s.targets ?? (s.target_layer != null ? [s.target_layer] : null)
    if (Array.isArray(tl) && tl.length) {
      const idx = clamp(num(evalProp(s.target_index, f, this.fps), 0), 0, tl.length - 1)
      const i0 = Math.floor(idx), i1 = Math.min(tl.length - 1, i0 + 1), k = idx - i0
      const A = this.layers.get(String(tl[i0])), B = this.layers.get(String(tl[i1]))
      if (A && A !== L) {
        const a = this.originOf(A, f, new THREE.Vector3())
        if (B && B !== L && k > 0) a.lerp(this.originOf(B, f, new THREE.Vector3()), k * k * (3 - 2 * k))
        tg = [a.x, a.y, a.z]
      }
    } else if ((s.target ?? L.def.target) != null) tg = vec(evalProp(s.target ?? L.def.target, f, this.fps), 3, 0)
    const hasPos = L.def.transform?.position != null || this.overrides.has(L.id)
    // 位置を書いていないカメラ: 注視点があればその正面(距離 = zoom)、なければ既定の位置
    const dpos = tg && !hasPos && tl ? [tg[0], tg[1], tg[2] - zoom] : [this.W / 2, this.H / 2, -zoom]
    const X = this.xform(L, f)
    const pos = vec(this.tr(L, 'position', f, dpos), 3, 0)
    const rot = rotVec(this.tr(L, 'rotation', f, 0))
    const pid = L.def.parent
    let P = null
    if (pid != null && depth < 32) { P = this.layers.get(String(pid)); if (P === L) P = null }
    const pw = P ? this.world(P, f, depth + 1) : null // 作業用のベクトルを使うので、_v より先に求める
    _v.set(pos[0] + X.px, pos[1] + X.py, pos[2] + X.pz)
    m.identity()
    if (tg) {
      // 注視点つき: 視線 = +z、上 = -y になる基底を作る。
      // target は position と同じ空間(親があれば親の空間)。target_layer / targets はレイヤーの実際の位置なので、親の空間へ直す
      if (tl && pw) { _v2.set(tg[0], tg[1], tg[2]).applyMatrix4(_m.copy(pw).invert()); tg = [_v2.x, _v2.y, _v2.z] }
      const px = _v.x, py = _v.y, pz = _v.z
      const fw = _v.set(tg[0] - px, tg[1] - py, tg[2] - pz)
      if (fw.lengthSq() > 1e-9) {
        fw.normalize()
        const right = _v2.set(0, 1, 0).cross(fw)
        if (right.lengthSq() < 1e-9) right.set(1, 0, 0)
        right.normalize()
        const down = _v3.copy(fw).cross(right)
        m.makeBasis(right, down, fw)
      }
      _e.set(-rot[0] * D2R, -rot[1] * D2R, rot[2] * D2R, 'XYZ')
      m.multiply(_m.makeRotationFromEuler(_e))
      m.setPosition(px, py, pz)
    } else {
      _e.set(-rot[0] * D2R, -rot[1] * D2R, rot[2] * D2R, 'XYZ')
      m.makeRotationFromEuler(_e)
      m.setPosition(_v.x, _v.y, _v.z)
    }
    if (pw) m.premultiply(pw)
  }
  // グループの行列: 位置のずれ + 自分の位置を中心にした回転・拡大(既定の位置 = 画面の中心 = 何もしない)
  groupMatrix(G, f) {
    if (G.gStamp === f) return G.gm
    const m = (G.gm ??= new THREE.Matrix4())
    this.local(G, f, m)
    m.multiply(_m.makeTranslation(-this.W / 2, -this.H / 2, 0))
    G.gStamp = f
    return m
  }
  // 描くときの世界行列 = 効いているグループ × world。billboard はここで向きを差し替える
  drawWorld(L, f) {
    if (L.dStamp === f) return L.dm
    const m = L.dm.copy(this.world(L, f))
    if (L.groups) for (const G of L.groups) if (this.active(G, f)) m.premultiply(this.groupMatrix(G, f))
    if (L.def.billboard && this.is3d(L)) {
      // いつもカメラのほうを向く: 位置と大きさはそのまま、向きだけカメラの向きにする
      m.decompose(_v, _q, _s3)
      const px = _v.x, py = _v.y, pz = _v.z, sx = _s3.x, sy = _s3.y, sz = _s3.z
      const cw = this.camFor(L, f).world
      const rz = rotVec(this.tr(L, 'rotation', f, 0))[2]
      m.extractRotation(cw).multiply(_m.makeRotationZ(rz * D2R)).scale(_s3.set(sx, sy, sz)).setPosition(px, py, pz)
    }
    L.dStamp = f
    return m
  }
  zoomOf(L, f) {
    const s = L?.def.source || {}
    const z = num(evalProp(s.zoom, f, this.fps), 0)
    if (z > 0) return z
    const fov = clamp(num(evalProp(s.fov, f, this.fps), DEFAULT_FOV), 1, 170)
    return this.W / 2 / Math.tan((fov * D2R) / 2)
  }
  // カメラレイヤー(null = 既定のカメラ)のそのコマの状態
  camState(CL, f) {
    const c = CL ? (CL.cam ??= newCam()) : this.cam0
    if (c.stamp === f) return c
    c.zoom = this.zoomOf(CL, f)
    if (CL) c.world.copy(this.world(CL, f))
    else c.world.makeTranslation(this.W / 2, this.H / 2, -c.zoom)
    c.view.copy(c.world).invert()
    const near = Math.max(1, c.zoom * 0.002), far = c.zoom * 1000
    const s = CL?.def.source || {}
    c.ortho = !!s.ortho
    if (c.ortho) {
      _m.set(2 / this.W, 0, 0, 0, 0, -2 / this.H, 0, 0, 0, 0, 2 / (far - near), -(far + near) / (far - near), 0, 0, 0, 1)
    } else {
      _m.set(c.zoom / (this.W / 2), 0, 0, 0, 0, -c.zoom / (this.H / 2), 0, 0,
        0, 0, (far + near) / (far - near), (-2 * far * near) / (far - near), 0, 0, 1, 0)
    }
    c.vp.multiplyMatrices(_m, c.view)
    c.dof = null
    if (s.dof && typeof s.dof === 'object' && s.dof.enabled !== false) {
      let focus = num(evalProp(s.dof.focus_distance, f, this.fps), 0)
      if (!(focus > 0)) focus = c.zoom
      c.dof = { focus, aperture: Math.max(0, num(evalProp(s.dof.aperture, f, this.fps), 20)), max: Math.max(0, num(s.dof.max_blur, 60)) }
    }
    c.stamp = f
    return c
  }
  // そのレイヤーに効くカメラ: 範囲に入っている表示中のカメラのうち、いちばん上のもの
  camFor(L, f) {
    const list = L ? L.cams : null
    if (list) for (const C of list) if (this.active(C, f)) return this.camState(C, f)
    return this.camState(null, f)
  }
  // 範囲なしで探す(編集画面むけ・v1 互換)
  camera(f) {
    for (const L of this.order) if (L.type === 'camera' && this.active(L, f) && L.def.scope == null) return this.camState(L, f)
    return this.camState(null, f)
  }
  is3d(L) { return !!L.def.three_d || L.type === 'model' }
  mvp(L, f) {
    if (L.mvpStamp === f) return L.mvp
    const w = this.drawWorld(L, f)
    if (this.is3d(L)) L.mvp.multiplyMatrices(this.camFor(L, f).vp, w)
    else L.mvp.multiplyMatrices(this.p2d, w)
    L.mvpStamp = f
    return L.mvp
  }
  vpOf(L, f) { return this.is3d(L) ? this.camFor(L, f).vp : this.p2d }
  // カメラから見た奥行き(基準点 = anchor)
  viewDepth(L, f) {
    // drawWorld() / camFor() は作業用のベクトルを使うので、先に求めてから計算する
    const w = this.drawWorld(L, f), view = this.camFor(L, f).view
    const an = vec(this.tr(L, 'anchor', f, 0), 3, 0)
    _v.set(an[0], an[1], an[2]).applyMatrix4(w).applyMatrix4(view)
    return _v.z
  }

  // ---- ラスタライズの倍率 ----
  // 拡大してもぼけないよう、scale のキーの最大値(親・グループも含む)に合わせて大きめに描いておく
  scaleEstimate(L) {
    let s = 1, cur = L, guard = 0
    const fxScale = (def) => {
      let k = 1
      if (Array.isArray(def.effects)) for (const e of def.effects) if (e && e.type === 'offset' && e.enabled !== false && e.params?.scale != null) k *= maxAbs(e.params.scale, 100) / 100
      return k
    }
    while (cur && guard++ < 32) {
      s *= (maxAbs(cur.def.transform?.scale, 100) / 100) * fxScale(cur.def)
      if (cur.groups) for (const G of cur.groups) s *= (maxAbs(G.def.transform?.scale, 100) / 100) * fxScale(G.def)
      cur = cur.def.parent != null ? this.layers.get(String(cur.def.parent)) : null
    }
    const rp = L.def.repeater
    if (rp) {
      const os = maxAbs(rp.offset?.scale, 100) / 100
      if (os > 1) s *= Math.min(4, os ** Math.max(0, maxAbs(rp.count, 1) - 1))
      if (rp.random?.scale_range) s *= maxAbs(rp.random.scale_range, 100) / 100
    }
    return s
  }
  rasterScale(L) {
    if (L.rsHint) return L.rsHint * this.env.rs
    let s = this.scaleEstimate(L)
    const pc = L.def.source?.per_char
    if (pc) s *= Math.max(1, maxAbs(pc.from?.scale, 100) / 100, maxAbs(pc.out?.from?.scale ?? pc.out?.scale, 100) / 100)
    // 段にして、少しの変更でテクスチャを作り直さないようにする
    const steps = [1, 1.5, 2, 3, 4]
    L.rsHint = steps.find((x) => x >= s - 1e-6) || 4
    return L.rsHint * this.env.rs
  }
  // エフェクト用の RT の倍率(レイヤーの 1px を何画素で持つか)
  fxRes(L) {
    if (!L.fxHint) {
      const s = this.scaleEstimate(L)
      const steps = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]
      L.fxHint = steps.find((x) => x >= s - 1e-6) || 4
    }
    return L.fxHint * this.env.rs
  }

  // ---- 中身 ----
  assetUrl(id, kind) {
    const o = this.env.opts
    if (o.assetUrl) return o.assetUrl(id, kind)
    return `${this.env.apiBase}/api/assets/${id}/file${kind === 'video' ? '?proxy=1' : ''}`
  }
  // source.url の "/..." は apiBase からの道(capture のページは about:blank なので相対 URL が使えない)
  srcUrl(u) { return typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? this.env.apiBase + u : u }
  frameUrl(id, n) {
    const o = this.env.opts
    if (o.frameUrl) return o.frameUrl(id, n, this.fps)
    return `${this.env.apiBase}/api/comps/vframe/${id}/${n}?fps=${this.fps}`
  }
  // 素材の何コマ目か。time_remap(素材のコマを直接指定)・freeze(止める)が優先
  srcFrame(L, f) {
    const d = L.def
    if (d.freeze != null) return num(evalProp(d.freeze, f, this.fps), 0)
    const tr = d.time_remap ?? d.source?.time_remap
    if (tr != null) return num(evalProp(tr, f, this.fps), 0)
    return (f - (d.in ?? 0)) * (d.speed ?? 1) + (d.start ?? 0)
  }
  // 逆再生・繰り返し(total = 素材の長さ。分からなければそのまま)
  fitFrame(L, n, total) {
    const d = L.def, lp = d.loop ?? d.source?.loop
    if (!(total > 0)) return n
    if (d.reverse) n = total - 1 - n
    if (lp) n = lp === 'pingpong' ? (() => { const u = ((n % (2 * total - 2 || 1)) + (2 * total - 2 || 1)) % (2 * total - 2 || 1); return u >= total ? 2 * total - 2 - u : u })() : ((n % total) + total) % total
    return n
  }
  childScene(L) {
    const cid = L.def.source?.comp_id
    if (cid == null) return null
    return this.env.comps.get(cid)
  }

  // レイヤーの中身の箱(レイヤー空間。原点 = 中心)。まだ読めていなければ null
  rect(L, f) {
    const s = L.def.source || {}
    const box = (w, h) => ({ x: -w / 2, y: -h / 2, w, h })
    switch (L.type) {
      case 'solid':
      case 'pattern': return box(num(evalProp(s.width, f, this.fps), this.W), num(evalProp(s.height, f, this.fps), this.H))
      case 'adjustment': return box(this.W, this.H)
      case 'null':
      case 'group': return box(100, 100)
      case 'image':
      case 'sequence': {
        const e = this.imageEntry(L, f)
        return e && e.state === 'ready' ? box(e.w, e.h) : null
      }
      case 'video': {
        if (s.sequence) { const e = this.imageEntry(L, f); return e && e.state === 'ready' ? box(e.w, e.h) : null }
        const v = this.videoState(L, f, false)
        return v && v.w ? box(v.w, v.h) : null
      }
      case 'shape': return this.shapeRaster(L, f)?.box || null
      case 'text': {
        const lay = this.textRaster(L, f)?.lay
        if (!lay) return null
        const arc = s.arc
        if (!arc && s.on_circle) { const R = Math.abs(num(evalProp(s.on_circle.radius, f, this.fps), 0)) + lay.rect.h / 2; return box(R * 2, R * 2) }
        if (arc && num(evalProp(arc.radius, f, this.fps), 0)) { const R = Math.abs(num(evalProp(arc.radius, f, this.fps), 0)) + lay.rect.h / 2; return box(R * 2, R * 2) }
        return lay.rect
      }
      case 'comp': {
        const e = this.childScene(L)
        return e && e.scene ? box(e.scene.W, e.scene.H) : null
      }
      case 'particles': {
        const p = vec(evalProp(s.emitter?.position, f, this.fps), 3, 0)
        return { x: p[0] - 40, y: p[1] - 40, w: 80, h: 80 }
      }
      case 'model': { const h = num(s.height, this.H * 0.5); return box(h, h) }
    }
    return null
  }

  // 連番: {asset_ids:[...]} または {url_pattern:".../%04d.png", start, count, fps}
  seqEntry(L, f, seq) {
    const sfps = num(seq.fps, this.fps)
    const total = Array.isArray(seq.asset_ids) ? seq.asset_ids.length : Math.max(0, Math.round(num(seq.count, 0)))
    let n = Math.floor((this.srcFrame(L, f) / this.fps) * sfps + 1e-4)
    n = Math.floor(this.fitFrame(L, n, total))
    if (seq.hold !== false && total > 0) n = clamp(n, 0, total - 1)
    if (n < 0 || (total > 0 && n >= total)) return null
    let url
    if (Array.isArray(seq.asset_ids)) { if (seq.asset_ids[n] == null) return null; url = this.assetUrl(seq.asset_ids[n], 'image') }
    else if (typeof seq.url_pattern === 'string') {
      const k = n + Math.round(num(seq.start, 1))
      url = this.srcUrl(seq.url_pattern.replace(/%0?(\d*)d/, (_, w) => String(k).padStart(+w || 0, '0')))
    } else return null
    return this.env.assets.image(url, 'seq')
  }
  imageEntry(L, f = 0) {
    const s = L.def.source || {}
    if (s.sequence && typeof s.sequence === 'object') return this.seqEntry(L, f, s.sequence)
    const url = s.url ? this.srcUrl(s.url) : s.asset_id != null ? this.assetUrl(s.asset_id, 'image') : null
    return url ? this.env.assets.image(url) : null
  }
  // 動画: {tex, w, h}。preview は <video>、capture は 1 コマずつの画像
  videoState(L, f, sync = true) {
    const s = L.def.source || {}, A = this.env.assets
    if (s.asset_id == null && !s.url) return null
    let meta = null
    if (s.asset_id != null) meta = A.meta(s.asset_id).data
    let n = this.srcFrame(L, f)
    const total = meta?.duration_sec > 0 ? Math.max(1, Math.floor(meta.duration_sec * this.fps + 1e-6) - 1) : 0 // 最後のコマは切り出せないことがあるので 1 つ手前まで
    if (L.def.reverse || L.def.loop || s.loop) n = this.fitFrame(L, n, total)
    if (n < -1e-6) return null
    if (this.env.mode === 'capture') {
      if (s.asset_id == null) return null
      const e = A.image(this.frameUrl(s.asset_id, Math.floor(n + 1e-4)), true)
      if (e.state !== 'ready') return null
      return { tex: e.tex, w: meta?.width || e.w, h: meta?.height || e.h }
    }
    const e = A.video(this.videoKey(L), s.url ? this.srcUrl(s.url) : this.assetUrl(s.asset_id, 'video'))
    const plain = L.def.time_remap == null && s.time_remap == null && L.def.freeze == null && !L.def.reverse
    if (sync) A.syncVideo(e, n / this.fps + 0.002, this.env.playing && plain, L.def.speed ?? 1) // 境目ちょうどだと前のコマになることがあるので少し進める
    if (!e.ready) return null
    return { tex: e.tex, w: meta?.width || e.video.videoWidth, h: meta?.height || e.video.videoHeight }
  }
  setCacheTex(L, slot, key, build) {
    const c = L.cache[slot]
    if (c && c.key === key) return c
    c?.tex?.dispose()
    const n = build()
    if (n) n.key = key
    L.cache[slot] = n
    return n
  }
  shapeRaster(L, f) {
    const s = evalAll(L.def.source, f, this.fps)
    const rs = this.rasterScale(L)
    // 模様の塗りはシェーダが出すので、模様の値が動いても作り直さない
    const key = rs + JSON.stringify(s, (k, v) => (k === 'fill' && isPatternFill(v) ? 'P' : v))
    return this.setCacheTex(L, 'shape', key, () => {
      const r = rasterShape(s, rs)
      return r ? { tex: canvasTexture(r.canvas), rect: r.rect, box: r.box, dual: r.dual } : { tex: null, rect: null, box: null }
    })
  }
  textRaster(L, f) {
    const src = L.def.source || {}
    const s = {}
    for (const k of Object.keys(src)) {
      if (k === 'per_char' || k === 'visible_chars' || k === 'arc' || k === 'on_circle') continue
      s[k] = src[k] === null ? null : evalProp(src[k], f, this.fps)
    }
    if (s.counter && typeof s.counter === 'object') {
      // カウンター: value(プロパティ値)。無ければ start + 経過秒 × rate
      const c = s.counter
      let v = c.value != null ? num(evalProp(c.value, f, this.fps), 0) : num(c.start, 0) + ((f - num(c.from_frame, L.def.in ?? 0)) / this.fps) * num(c.rate, 1)
      s.counter = { ...c, value: v, scramble: num(evalProp(c.scramble, f, this.fps), 0) }
    }
    const rs = this.rasterScale(L)
    const scr = s.counter && s.counter.scramble > 0 ? Math.floor(f) : 0
    const key = rs + JSON.stringify(s, (k, v) => (k === 'fill' && isPatternFill(v) ? 'P' : v)) + this.env.fontEpoch + '|' + scr
    return this.setCacheTex(L, 'text', key, () => {
      const lay = layoutText(s, rs, f)
      return { tex: lay.canvas ? canvasTexture(lay.canvas) : null, lay }
    })
  }
  // fill: {"pattern": {...}} / {"gradient": {...}}(solid 用)→ シェーダへ渡す値
  patternOf(L, fill, f, rect) {
    let spec = null
    if (isPatternFill(fill)) spec = evalAll(fill.pattern, f, this.fps)
    else if (fill && typeof fill === 'object' && fill.gradient) {
      const g = fill.gradient, st = g.stops || [[0, '#ffffff'], [1, '#000000']]
      const radial = g.type === 'radial', ang = num(g.angle, 180)
      const len = radial ? num(g.radius, Math.hypot(rect.w, rect.h) / 2) : Math.abs(Math.sin(ang * D2R)) * rect.w + Math.abs(Math.cos(ang * D2R)) * rect.h
      spec = { kind: 'gradient', colors: st.slice(0, 4).map((x) => x[1]), size: len, angle: ang - 180, grad_type: radial ? 'radial' : 'linear' }
    }
    if (!spec) return null
    const c = (L.cache.pat ??= {})
    c.u = patternUniforms(spec, c.u)
    return c.u
  }
  // 粒子の絵: 名前(soft など)/ {asset_id|url} / {shape:{...}} / {text:"桜", font, weight}
  particleSprite(L) {
    const em = L.def.source?.emitter || {}
    const kind = em.sprite ?? PARTICLE_PRESETS[em.preset]?.sprite ?? 'soft'
    if (typeof kind === 'string') return { tex: this.env.sprite(SPRITE_KINDS.includes(kind) ? kind : 'soft'), aspect: 1 }
    if (kind && typeof kind === 'object') {
      if (kind.asset_id != null || kind.url) {
        const e = this.env.assets.image(kind.url ? this.srcUrl(kind.url) : this.assetUrl(kind.asset_id, 'image'))
        return e.state === 'ready' ? { tex: e.tex, aspect: e.w / Math.max(1, e.h) } : null
      }
      const key = JSON.stringify(kind) + this.env.fontEpoch
      const c = this.setCacheTex(L, 'sprite', key, () => {
        if (kind.shape) {
          const r = rasterShape({ width: 64, height: 64, fill: '#ffffff', ...kind.shape }, 2)
          return r ? { tex: canvasTexture(r.canvas), aspect: r.rect.w / r.rect.h } : { tex: null, aspect: 1 }
        }
        const S = 128, [cv, ctx] = makeCanvas(S, S)
        ctx.font = fontSpec(kind, S * 0.8); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'
        ctx.fillText(String(kind.text ?? '●'), S / 2, S / 2)
        return { tex: canvasTexture(cv), aspect: 1 }
      })
      return c.tex ? c : null
    }
    return { tex: this.env.sprite('soft'), aspect: 1 }
  }

  // 描くための中身をそろえる。→ L.content(使い回し)または null
  content(L, f, stack) {
    const rect = this.rect(L, f)
    if (!rect) return null
    const C = L.content
    C.rect = rect; C.texture = null; C.uvRect = null; C.edge = false; C.multi = false; C.internalAdd = false
    C.toSrgb = false; C.temp = null; C.screen = false; C.tint = null; C.quad = null; C.pattern = null; C.dual = false; C.dualOver = false; C.ink = rect
    const src = L.def.source || {}
    switch (L.type) {
      case 'solid': {
        if (src.fill && typeof src.fill === 'object' && (src.fill.pattern || src.fill.gradient)) C.pattern = this.patternOf(L, src.fill, f, rect)
        else {
          const c = toColor(evalProp(src.color, f, this.fps), [1, 1, 1, 1])
          C.tint = [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
        }
        C.edge = true
        break
      }
      case 'pattern': {
        const sp = evalAll(src, f, this.fps)
        C.pattern = L.cache.patU = patternUniforms(sp, L.cache.patU ?? undefined)
        C.edge = true
        break
      }
      case 'adjustment': C.edge = true; break
      case 'image':
      case 'sequence': C.texture = this.imageEntry(L, f).tex; C.edge = true; break
      case 'video': {
        if (src.sequence) { C.texture = this.imageEntry(L, f).tex; C.edge = true; break }
        const v = this.videoState(L, f)
        if (!v) return null
        C.texture = v.tex; C.edge = true
        break
      }
      case 'shape': {
        const r = this.shapeRaster(L, f)
        if (!r.tex) return null
        C.texture = r.tex; C.quad = r.rect; C.ink = r.rect
        if (r.dual) {
          C.pattern = this.patternOf(L, src.fill, f, rect); C.dual = true; C.dualOver = true; C.uvRect = [0, 0, 1, 0.5]
        }
        break
      }
      case 'text': {
        const r = this.textRaster(L, f)
        if (!r.tex) return null
        C.texture = r.tex
        C.multi = true
        if (r.lay.dual) { C.pattern = this.patternOf(L, src.fill ?? src.runs?.find((x) => isPatternFill(x.fill))?.fill, f, rect); C.dual = true; C.dualOver = r.lay.dualOver }
        const pc = src.per_char
        // arc: {radius, start, sweep}。on_circle: {radius, rotation, arc} も同じ意味で読む
        let arc = src.arc ? evalAll(src.arc, f, this.fps) : null
        if (!arc && src.on_circle) { const oc = evalAll(src.on_circle, f, this.fps); arc = { radius: oc.radius, start: oc.rotation ?? oc.start, sweep: oc.arc ?? oc.sweep } }
        L.batch ??= new QuadBatch(1)
        fillTextBatch(L.batch, r.lay, pc, f - (L.def.in ?? 0), (L.def.out ?? this.duration) - (L.def.in ?? 0), L.id, {
          visible: src.visible_chars != null ? num(evalProp(src.visible_chars, f, this.fps), 1e9) : undefined, arc,
          randAmt: pc?.random ? clamp(num(evalProp(pc.random.amount, f, this.fps), 100) / 100, 0, 1) : 1,
        })
        // 文字が箱の外へ動くとき(文字ごとアニメ・円周)は、大きさを決められないので「範囲なし」
        C.ink = pc || arc ? null : r.lay.ink
        break
      }
      case 'particles': {
        const sp = this.particleSprite(L)
        if (!sp) return null
        C.texture = sp.tex
        C.multi = true
        const em = src.emitter || {}
        const bl = em.blend ?? PARTICLE_PRESETS[em.preset]?.blend ?? 'add'
        C.internalAdd = bl === 'add'
        L.batch ??= new QuadBatch(1)
        let depth = null
        if (this.is3d(L) && !C.internalAdd) {
          const mv = _m3.multiplyMatrices(this.camFor(L, f).view, this.drawWorld(L, f)).elements
          depth = (x, y, z) => mv[2] * x + mv[6] * y + mv[10] * z + mv[14]
        }
        fillParticles(L.batch, L.def, f, this.fps, { aspect: sp.aspect, depth })
        C.ink = null
        break
      }
      case 'comp': {
        const e = this.childScene(L)
        if (!e || !e.scene) return null
        if (stack.includes(e.id) || stack.length >= MAX_DEPTH) { this.warn('cycle' + L.id, `入れ子が循環している: comp ${e.id}`); return null }
        // 素材のコマは親の fps で数える → 子の fps のコマに直す
        let cf = (this.srcFrame(L, f) / this.fps) * e.scene.fps
        cf = this.fitFrame(L, cf, e.scene.duration)
        if (cf < -1e-6 || cf >= e.scene.duration) return null
        const rt = e.scene.render(cf, [...stack, e.id])
        C.temp = rt; C.texture = rt.texture; C.uvRect = [0, 1, 1, 0]; C.edge = true
        break
      }
      case 'model': {
        const rt = this.env.models.render(this, L, f)
        if (!rt) return null
        C.temp = rt; C.texture = rt.texture; C.uvRect = [0, 1, 1, 0]; C.edge = true; C.screen = true; C.toSrgb = true
        C.rect = { x: 0, y: 0, w: this.W, h: this.H }
        C.ink = null
        break
      }
      default: return null
    }
    return C
  }

  // 四隅の画面上の位置(コンポジションの px)。カメラの後ろへ回ったら null
  corners(L, f, rect, m = null) {
    m ??= this.mvp(L, f) // 先に求める(中で作業用のベクトルを使う)
    const out = []
    const pts = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]]
    for (const p of pts) {
      _v4.set(p[0], p[1], 0, 1).applyMatrix4(m)
      if (_v4.w <= 1e-6) return null
      out.push([(_v4.x / _v4.w * 0.5 + 0.5) * this.W, (0.5 - _v4.y / _v4.w * 0.5) * this.H])
    }
    return out
  }

  // マスク: rect / ellipse / polygon / path(ベジェ)/ シェイプの形(star・rounded_rect など)。数値はプロパティ値
  maskData(L, f, rect) {
    const defs = L.def.masks
    if (!Array.isArray(defs) || !defs.length) return null
    const md = (L.cache.mask ??= { n: 0, length: 0, type: [], box: new Float32Array(MAX_MASKS * 4), param: new Float32Array(MAX_MASKS * 4), param2: new Float32Array(MAX_MASKS * 4), pts: null })
    const n = Math.min(defs.length, MAX_MASKS)
    if (defs.length > MAX_MASKS) this.warn('masks' + L.id, `マスクは ${MAX_MASKS} 個まで`)
    if (!md.pts || md.pts.length !== n * MASK_PTS * 2) md.pts = new Float32Array(n * MASK_PTS * 2)
    md.n = md.length = n
    for (let i = 0; i < n; i++) {
      const k = evalAll(defs[i], f, this.fps)
      const x = num(k.x, 0), y = num(k.y, 0), w = num(k.w, rect.w), h = num(k.h, rect.h)
      const shape = k.shape || 'rect'
      md.type[i] = shape === 'ellipse' ? 1 : shape === 'rect' || shape === 'rounded_rect' ? 0 : 2
      md.box.set([x, y, w, h], i * 4)
      let np = 0
      if (md.type[i] === 2) {
        let pts = []
        if (shape === 'polygon' && Array.isArray(k.points)) pts = k.points
        else if (shape === 'path' && Array.isArray(k.points) && k.points.length > 1) pts = flattenPath(k.points, true)
        else {
          // シェイプの形を箱 (x,y,w,h) にはめる
          const poly = shapePolyline({ ...k, kind: shape === 'polygon' ? 'polygon' : shape, width: w, height: h, points: undefined })
          if (poly) pts = poly.pts.map((p) => [p[0] + x + w / 2, p[1] + y + h / 2])
        }
        // 頂点が多すぎるときは等間隔に間引く
        if (pts.length > MASK_PTS) { const st = pts.length / MASK_PTS; pts = Array.from({ length: MASK_PTS }, (_, j) => pts[Math.floor(j * st)]) }
        np = pts.length
        for (let j = 0; j < np; j++) { md.pts[(i * MASK_PTS + j) * 2] = +pts[j][0] || 0; md.pts[(i * MASK_PTS + j) * 2 + 1] = +pts[j][1] || 0 }
        if (np < 3) md.type[i] = 0
      }
      md.param.set([Math.max(0, num(k.feather, 0)), k.invert ? 1 : 0, clamp(num(k.opacity, 100) / 100, 0, 1), np], i * 4)
      md.param2.set([num(k.expansion, 0), md.type[i] === 0 ? Math.min(Math.max(0, num(k.radius, 0)), w / 2, h / 2) : 0, 0, 0], i * 4)
    }
    return md
  }

  bufSize() { return [Math.round(this.W * this.env.rs), Math.round(this.H * this.env.rs)] }

  // ---- エフェクトの列 ----
  // そのコマで効く列(評価済み): 自分の effects → 効いているグループの effects(内側から)→ transition → 被写界深度
  chain(L, f) {
    const out = []
    const add = (list, ff, own) => {
      if (!Array.isArray(list)) return
      for (const e of list) {
        if (!e || e.enabled === false || (own && e.type === 'offset')) continue
        if (SKIP.has(e.type) || !(e.type in INLINE || isPass(e.type) || GEO.has(e.type))) {
          // 対応していない種類は黙って飛ばす(取り込みで残した aviutl_script など。名前ごとに 1 回だけ知らせる)
          if (e.type === 'aviutl_script') this.warn('avs' + e.name, `未対応の AviUtl スクリプト: ${e.name}`)
          else if (e.type !== 'offset') this.warn('fx' + e.type, `未対応のエフェクト: ${e.type}`)
          continue
        }
        out.push({ type: e.type, p: evalAll(e.params, ff, this.fps) })
      }
    }
    add(L.def.effects, f, true)
    if (L.groups) {
      for (const G of L.groups) {
        if (!this.active(G, f)) continue
        add(G.def.effects, f, false)
        // グループの offset は、不透明度だけ子に掛ける(位置・拡大・回転はグループの行列に入っている)
      }
    }
    const X = this.xform(L, f)
    for (const e of X.fx) out.push(e)
    if (this.is3d(L) && L.type !== 'adjustment') {
      const cam = this.camFor(L, f)
      if (cam.dof) {
        const d = this.viewDepth(L, f)
        const r = Math.min(cam.dof.max, (cam.dof.aperture * Math.abs(d - cam.dof.focus)) / Math.max(d, cam.dof.focus * 0.1, 1))
        if (r > 0.4) out.push({ type: 'blur', p: { radius: r } })
      }
    }
    return out
  }
  opacityOf(L, f) {
    let op = clamp(num(this.tr(L, 'opacity', f, 100), 100) / 100, 0, 1) * this.xform(L, f).op
    if (L.groups) for (const G of L.groups) if (this.active(G, f)) op *= clamp(num(this.tr(G, 'opacity', f, 100), 100) / 100, 0, 1) * this.xform(G, f).op
    return op
  }

  // 中身 → 描く状態。エフェクトを足していくと ops(シェーダで済む分)がたまり、必要になったら RT に描き出す
  newState(L, f, C) {
    return {
      L, f, tex: C.texture, uvRect: C.uvRect, quad: C.multi ? null : (C.quad || C.rect), rect: C.rect, ink: C.screen ? null : C.ink,
      edge: C.edge, multi: C.multi, batch: C.multi ? L.batch : null, pattern: C.pattern, dual: C.dual, dualOver: C.dualOver, tint: C.tint, toSrgb: C.toSrgb,
      internalAdd: C.internalAdd, screenContent: C.screen, masks: C.screen ? null : this.maskData(L, f, C.rect), maskOrigin: [C.rect.x, C.rect.y],
      ops: [], data: null, opTex: [], n4: 0, stage: 0, copies: null, noEdge: false, inkPad: 0, hidden: false, planes: null,
      space: 'layer', buf: null, res: 1, temps: C.temp ? [C.temp] : [], worldCopies: false,
    }
  }
  freeState(S) {
    if (!S) return
    const g = this.env.gfx
    if (S.buf) { if (!S.borrow) g.release(S.buf); S.buf = null }
    S.borrow = false
    for (const t of S.temps) g.release(t)
    S.temps.length = 0
  }
  opCtx(S) {
    const self = this, L = S.L, f = S.f
    return {
      rect: S.rect, f, fps: this.fps, pad: 0, shift: null, tex: null, hide: false,
      // 画像にアルファが無いか(全部不透明か)。小さく縮めて 1 回だけ調べる
      opaque(e) {
        if (e.opaque === undefined) {
          e.opaque = false
          try {
            const [cv, c2] = makeCanvas(24, 24)
            c2.drawImage(e.tex.image, 0, 0, 24, 24)
            const d = c2.getImageData(0, 0, 24, 24).data
            let mn = 255
            for (let k = 3; k < d.length; k += 4) mn = Math.min(mn, d[k])
            e.opaque = mn >= 250
          } catch { e.opaque = false }
        }
        return e.opaque
      },
      image(p) {
        const url = p.url ? self.srcUrl(p.url) : p.asset_id != null ? self.assetUrl(p.asset_id, 'image') : null
        return url ? self.env.assets.image(url) : null
      },
      // overlay_source の素材: 画像・動画(asset_id)か、コンポジション(comp_id)
      overlay(p) {
        const n = (f - (L.def.in ?? 0)) * num(p.speed, 1) + num(p.start, 0)
        if (p.comp_id != null) {
          const e = self.env.comps.get(p.comp_id)
          if (!e || !e.scene || S.stack.includes(e.id) || S.stack.length >= MAX_DEPTH) return null
          const cf = (n / self.fps) * e.scene.fps
          if (cf < 0 || cf >= e.scene.duration) return null
          const rt = e.scene.render(p.loop ? cf % e.scene.duration : cf, [...S.stack, e.id])
          S.temps.push(rt)
          return { tex: rt.texture, w: e.scene.W, h: e.scene.H, flipY: true }
        }
        if (p.asset_id == null && !p.url) return null
        const meta = p.asset_id != null ? self.env.assets.meta(p.asset_id).data : null
        const isVideo = p.kind === 'video' || (p.kind == null && meta?.asset_type === 'video')
        if (isVideo && self.env.mode === 'capture') {
          const e = self.env.assets.image(self.frameUrl(p.asset_id, Math.max(0, Math.floor(n + 1e-4))), true)
          return e.state === 'ready' ? { tex: e.tex, w: meta?.width || e.w, h: meta?.height || e.h } : null
        }
        if (isVideo) {
          const e = self.env.assets.video(self.videoKey(L) + ':ov' + p.asset_id, p.url ? self.srcUrl(p.url) : self.assetUrl(p.asset_id, 'video'))
          self.env.assets.syncVideo(e, n / self.fps + 0.002, self.env.playing, num(p.speed, 1))
          return e.ready ? { tex: e.tex, w: meta?.width || e.video.videoWidth, h: meta?.height || e.video.videoHeight } : null
        }
        if (p.asset_id != null && !meta && self.env.assets.meta(p.asset_id).state === 'loading') return null
        const e = self.env.assets.image(p.url ? self.srcUrl(p.url) : self.assetUrl(p.asset_id, 'image'))
        return e.state === 'ready' ? { tex: e.tex, w: e.w, h: e.h } : null
      },
    }
  }
  addOp(S, type, p) {
    const reg = INLINE[type]
    if (S.n4 + reg.n > MAX_OP_VEC4 || (reg.tex && S.opTex.length >= MAX_OP_TEX)) this.flush(S, 0)
    S.data ??= (S.L.opData ??= new Float32Array(MAX_OP_VEC4 * 4))
    const ctx = this.opCtx(S)
    // transition の clip は % で来るので px に直す
    if (p._pct) { p = { ...p }; for (const k of ['top', 'bottom']) if (p[k] != null) p[k] = (p[k] / 100) * S.rect.h; for (const k of ['left', 'right']) if (p[k] != null) p[k] = (p[k] / 100) * S.rect.w }
    const i = S.n4 * 4
    for (let k = 0; k < reg.n * 4; k++) S.data[i + k] = 0
    const ok = reg.pack(p, ctx, S.data, i)
    if (ctx.hide) S.hidden = true
    if (ok === false) return
    if (S.stage === 0 && !S.copies && S.space === 'layer') this.notePlanes(S, type, i)
    S.ops.push({ type, stage: S.stage, slot: reg.tex ? S.opTex.length : 0 })
    if (reg.tex) S.opTex.push(ctx.tex)
    S.n4 += reg.n
    S.rect = ctx.rect
    if (ctx.pad) S.inkPad = Math.max(S.inkPad, ctx.pad)
    if (ctx.shift) this.addGeo(S, [{ m: new THREE.Matrix4().makeTranslation(ctx.shift[0], ctx.shift[1], 0), op: 1 }], false)
  }
  // 切り抜きの op から「残る側の半平面」を覚えておく。描く四角形をその形に切りつめて、塗る画素を減らす
  // (全面の四角を細い帯に切る、という AviUtl 流の作りが多いので効く)。planes: [nx, ny, d, feather] = n·p <= d を残す
  notePlanes(S, type, i) {
    const o = S.data, P = (S.planes ??= [])
    if (type === 'clip_line') {
      if (o[i + 7] > 0.5 || o[i + 5] > 1.5) return
      const nx = o[i + 2], ny = o[i + 3], d = nx * o[i] + ny * o[i + 1], fe = o[i + 6]
      if (o[i + 5] < 0.5) P.push([nx, ny, d, fe])
      else { P.push([nx, ny, d + o[i + 4], fe]); P.push([-nx, -ny, -d + o[i + 4], fe]) }
    } else if (type === 'crop') {
      const fe = o[i + 4]
      P.push([-1, 0, -o[i], fe], [0, -1, -o[i + 1], fe], [1, 0, o[i + 2], fe], [0, 1, o[i + 3], fe])
    } else if (type === 'mask_shape' || type === 'mask') {
      if (o[i + 7] > 0.5 || o[i + 8] < 0.999) return
      const cs = Math.abs(o[i + 10]), sn = Math.abs(o[i + 11]), ex = o[i + 2] * cs + o[i + 3] * sn + o[i + 9], ey = o[i + 2] * sn + o[i + 3] * cs + o[i + 9], fe = o[i + 6]
      P.push([-1, 0, -(o[i] - ex), fe], [0, -1, -(o[i + 1] - ey), fe], [1, 0, o[i] + ex, fe], [0, 1, o[i + 1] + ey, fe])
    } else if (type === 'iris') {
      if (o[i + 5] > 0.5 || o[i + 3] > 0.5) return
      const r = o[i + 2], fe = o[i + 4]
      P.push([-1, 0, -(o[i] - r), fe], [0, -1, -(o[i + 1] - r), fe], [1, 0, o[i] + r, fe], [0, 1, o[i + 1] + r, fe])
    }
  }
  // 矩形 r を planes で切った凸多角形(頂点の配列。空なら null)。margin = 境目の外に残す幅(レイヤーの px)
  clipRect(r, planes, margin) {
    let poly = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]
    for (const pl of planes) {
      const nx = pl[0], ny = pl[1], d = pl[2] + pl[3] + margin
      const out = []
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length]
        const da = nx * a[0] + ny * a[1] - d, db = nx * b[0] + ny * b[1] - d
        if (da <= 0) out.push(a)
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
      }
      poly = out
      if (poly.length < 3) return null
    }
    return poly
  }
  opsOf(S) {
    let sig = ''
    for (const o of S.ops) sig += o.type + o.stage + o.slot + ','
    let code = opsCache.get(sig)
    if (!code) opsCache.set(sig, (code = opsGlsl(S.ops)))
    const o = (this._ops ??= {})
    o.sig = sig; o.code = code; o.data = S.data; o.tex = S.opTex
    return o
  }
  // 絵そのものを動かす・増やす(flip / repeat)。list = [{m: レイヤー空間の行列, op}]
  addGeo(S, list, countsAsStage = true) {
    if (S.space === 'screen' && S.buf) { this.warn('geo' + S.L.id, `レイヤー ${S.L.id}: 範囲の決まらない絵のあとの flip / repeat は使えない`); return }
    if (S.ops.some((o) => o.stage === 1)) this.flush(S, 0)
    if (!S.copies) S.copies = list
    else {
      const out = []
      for (const n of list) for (const o of S.copies) { if (out.length >= MAX_COPIES) break; out.push({ m: new THREE.Matrix4().multiplyMatrices(n.m, o.m), op: n.op * o.op }) }
      S.copies = out
    }
    if (countsAsStage) S.stage = 1
    // 絵の範囲: 複製した四隅をぜんぶ含む箱
    if (S.ink) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      const b = S.baseInk ?? S.ink
      S.baseInk = b
      for (const c of S.copies) {
        for (let k = 0; k < 4; k++) {
          _v.set(k === 0 || k === 3 ? b.x : b.x + b.w, k < 2 ? b.y : b.y + b.h, 0).applyMatrix4(c.m)
          x0 = Math.min(x0, _v.x); y0 = Math.min(y0, _v.y); x1 = Math.max(x1, _v.x); y1 = Math.max(y1, _v.y)
        }
      }
      S.ink = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
  }
  geoEffect(S, type, p) {
    const r = S.rect, cx = r.x + r.w / 2, cy = r.y + r.h / 2
    if (type === 'flip') {
      // 左右(horizontal / h)・上下(vertical / v)。何も書かなければ左右。luma・hue・alpha は色の反転
      const vv = !!(p.vertical ?? p.v), extra = p.luma || p.hue || p.alpha
      const h = !!(p.horizontal ?? p.h ?? (!vv && !extra))
      if (h || vv) {
        const m = new THREE.Matrix4().makeTranslation(cx, cy, 0).multiply(_m.makeScale(h ? -1 : 1, vv ? -1 : 1, 1)).multiply(_m.makeTranslation(-cx, -cy, 0))
        this.addGeo(S, [{ m, op: 1 }], false)
      }
      if (p.luma) this.addOp(S, 'invert', { amount: 100, luma_only: true })
      if (p.hue) this.addOp(S, 'color', { hue: 180 })
      if (p.alpha) this.addOp(S, 'invert_alpha', {})
      return
    }
    // repeat / tile: 格子(grid)・一列(line)・円(circle)に並べる
    const mode = p.mode || 'grid'
    const list = []
    const T = (x, y, rot = 0, sc = 1) => {
      const m = new THREE.Matrix4().makeTranslation(cx + x, cy + y, 0)
      if (rot) m.multiply(_m.makeRotationZ(rot * D2R))
      if (sc !== 1) m.multiply(_m.makeScale(sc, sc, 1))
      return m.multiply(_m.makeTranslation(-cx, -cy, 0))
    }
    if (mode === 'line') {
      const n = clamp(Math.round(num(p.count_x ?? p.count, 3)), 1, MAX_COPIES)
      const a = num(p.angle, 90) * D2R, dx = Math.sin(a), dy = -Math.cos(a)
      const pitch = num(p.gap_x ?? p.gap, 0) || Math.abs(dx) * r.w + Math.abs(dy) * r.h
      for (let i = p.both ? -(n - 1) : 0; i < n; i++) list.push({ m: T(dx * pitch * i, dy * pitch * i), op: 1 })
    } else if (mode === 'circle') {
      const n = clamp(Math.round(num(p.count_x ?? p.count, 8)), 1, MAX_COPIES)
      const rad = num(p.radius, 200), st = num(p.angle ?? p.rotation, 0), sw = num(p.sweep ?? p.arc, 360)
      for (let i = 0; i < n; i++) {
        const a = st + (Math.abs(sw) >= 360 ? i / n : n > 1 ? i / (n - 1) : 0) * sw
        list.push({ m: T(Math.sin(a * D2R) * rad, -Math.cos(a * D2R) * rad, p.rotate === false ? 0 : a), op: 1 })
      }
    } else {
      const nx = clamp(Math.round(num(p.count_x ?? p.cols, 3)), 1, 256), ny = clamp(Math.round(num(p.count_y ?? p.rows, 3)), 1, 256)
      // 間隔: gap_x / gap_y = 自分の幅・高さに対する %(100 = すき間なし)。spacing_x / spacing_y(または spacing)= 足すすき間 px
      const sp = Array.isArray(p.spacing) ? p.spacing : [p.spacing, p.spacing]
      const pw = Math.max(1e-3, (r.w * num(p.gap_x, 100)) / 100 + num(p.spacing_x ?? sp[0], 0)), ph = Math.max(1e-3, (r.h * num(p.gap_y, 100)) / 100 + num(p.spacing_y ?? sp[1], 0))
      const gx = pw - r.w, gy = ph - r.h
      const sc = vec(p.scroll ?? [num(p.scroll_x, 0), num(p.scroll_y, 0)], 2, 0)
      const stag = !!p.stagger_rows, wrap = sc[0] !== 0 || sc[1] !== 0 || stag
      const sx = ((sc[0] % pw) + pw) % pw, sy = ((sc[1] % ph) + ph) % ph
      const tw = nx * pw - gx, th = ny * ph - gy
      for (let j = wrap ? -1 : 0; j < ny && list.length < MAX_COPIES; j++) {
        for (let i = wrap ? -1 : 0; i < nx; i++) {
          const x = (i - (nx - 1) / 2) * pw + sx + (stag && (((j % 2) + 2) % 2) ? pw / 2 : 0), y = (j - (ny - 1) / 2) * ph + sy
          const m = T(x, y)
          if (p.mirror) m.multiply(_m.makeTranslation(cx, cy, 0)).multiply(_m2.makeScale(((i % 2) + 2) % 2 ? -1 : 1, ((j % 2) + 2) % 2 ? -1 : 1, 1)).multiply(_m.makeTranslation(-cx, -cy, 0))
          list.push({ m, op: 1 })
        }
      }
      // すき間なしで並べるときは、1 枚ごとの縁のぼかしをやめる(継ぎ目に線が出ないように)
      if (Math.abs(gx) < 1e-6 && Math.abs(gy) < 1e-6) S.noEdge = true
      this.addGeo(S, list)
      S.rect = { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th }
      // 流す・段違いのときは外へはみ出すので、全体の箱で切る
      if (wrap || S.noEdge) { this.addOp(S, 'crop', { top: 1e-9 }); if (S.ink) S.ink = { ...S.rect } }
      return
    }
    this.addGeo(S, list)
    if (S.ink) S.rect = { ...S.ink }
  }

  // レイヤー空間 → RT の射影(箱 r を RT いっぱいに)
  orthoFor(r, out) {
    return out.set(2 / r.w, 0, 0, -1 - (2 * r.x) / r.w, 0, -2 / r.h, 0, 1 + (2 * r.y) / r.h, 0, 0, 0, 0, 0, 0, 0, 1)
  }
  // たまった ops・複製を RT に描き出して、「RT を 1 枚貼るだけ」の状態にする。pad = このあとのパスがはみ出す量(レイヤーの px)
  // scale = RT の解像度に掛ける倍率(このあと大きくぼかすときは、はじめから粗く描く)
  flush(S, pad, scale = 1) {
    const g = this.env.gfx, L = S.L
    if (S.buf && !S.n4 && !S.copies && !S.masks) return
    const sc = g.scissor
    g.setScissor(null)
    // 切り抜きで残る範囲だけを RT にする
    let ink = S.ink
    if (ink && S.planes && S.planes.length && !S.copies && S.space === 'layer') {
      const poly = this.clipRect(ink, S.planes, 2)
      if (!poly) { S.hidden = true; g.setScissor(sc); return }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const q of poly) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]) }
      // 画素の境目がずれないよう、元の箱から整数 px だけ内側へ
      x0 = ink.x + Math.floor(x0 - ink.x); y0 = ink.y + Math.floor(y0 - ink.y)
      ink = { x: x0, y: y0, w: Math.min(ink.x + ink.w, Math.ceil(x1 - x0) + x0) - x0, h: Math.min(ink.y + ink.h, Math.ceil(y1 - y0) + y0) - y0 }
    }
    // レイヤーの RT が画面よりずっと大きくなるとき(大きな床など)は、画面空間で掛けたほうが軽い
    let useScreen = S.space === 'screen' || !ink
    if (!useScreen && !S.buf) {
      const [bw, bh] = this.bufSize(), res0 = this.fxRes(L)
      if ((ink.w + 2 * pad) * (ink.h + 2 * pad) * res0 * res0 > bw * bh * 1.5) useScreen = true
    }
    if (useScreen) {
      // 範囲の決まらない絵(粒子・文字ごとアニメ・モデル)や、すでに画面大のバッファ: 画面空間で描く
      const [bw0, bh0] = this.bufSize()
      const bw = Math.max(1, Math.round(bw0 * scale)), bh = Math.max(1, Math.round(bh0 * scale))
      const rt = g.acquire(bw, bh)
      g.clear(rt)
      this.emit(rt, S, S.space === 'screen' || S.screenContent ? this.p2d : this.mvp(L, S.f), 1, S.internalAdd ? 'add' : 'normal')
      this.freeState(S)
      Object.assign(S, {
        tex: rt.texture, uvRect: [0, 1, 1, 0], quad: { x: 0, y: 0, w: this.W, h: this.H }, ink: null, edge: false, multi: false, batch: null, pattern: null, dual: false, tint: null,
        toSrgb: false, internalAdd: false, masks: null, ops: [], opTex: [], n4: 0, stage: 0, copies: null, noEdge: false, inkPad: 0, space: 'screen', buf: rt, res: this.env.rs * scale, baseInk: null, planes: null,
      })
    } else {
      let res = (S.buf ? S.res : this.fxRes(L)) * scale
      const ip = S.inkPad
      const need = (v) => Math.ceil((v + 2 * (pad + ip)) * res) + 4
      // 大きすぎるときは倍率を下げる
      const lim = Math.max(4096, 0)
      const big = Math.max(need(ink.w), need(ink.h))
      if (big > lim) res *= lim / big
      const pp = Math.ceil((pad + ip) * res + 2) / res
      let w = Math.ceil((ink.w + 2 * pp) * res - 1e-6), h = Math.ceil((ink.h + 2 * pp) * res - 1e-6)
      // RT の使い回しが効くよう、大きさを 32 の倍数にそろえる(右と下に余白が増えるだけ)
      w = Math.ceil(w / 32) * 32; h = Math.ceil(h / 32) * 32
      const reg = { x: ink.x - pp, y: ink.y - pp, w: w / res, h: h / res }
      const rt = g.acquire(w, h)
      g.clear(rt)
      this.emit(rt, S, this.orthoFor(reg, (S.L.om ??= new THREE.Matrix4())), 1, S.internalAdd ? 'add' : 'normal')
      this.freeState(S)
      Object.assign(S, {
        tex: rt.texture, uvRect: [0, 1, 1, 0], quad: reg, ink: reg, edge: false, multi: false, batch: null, pattern: null, dual: false, tint: null,
        toSrgb: false, internalAdd: false, masks: null, ops: [], opTex: [], n4: 0, stage: 0, copies: null, noEdge: false, inkPad: 0, space: 'layer', buf: rt, res, baseInk: null, planes: null,
      })
    }
    g.setScissor(sc)
  }
  // 列の from 番目から順に掛ける。stopAtPass = true なら、最初の重いエフェクトの手前で止めてその番号を返す
  runChain(S, chain, from = 0, stopAtPass = false) {
    const fxs = this.env.effects, g = this.env.gfx
    for (let i = from; i < chain.length; i++) {
      let e = chain[i]
      if (S.hidden) break
      if (e.type in INLINE) { this.addOp(S, e.type, e.p); continue }
      if (GEO.has(e.type)) { this.geoEffect(S, e.type, e.p); continue }
      if (stopAtPass) return i
      // blur の variant(directional / radial)は、それぞれのぼかしへ回す
      if (e.type === 'blur' && e.p.variant === 'directional') e = { type: 'directional_blur', p: { ...e.p, length: e.p.length ?? e.p.radius } }
      else if (e.type === 'blur' && e.p.variant === 'radial') e = { type: 'radial_blur', p: { ...e.p, amount: e.p.amount ?? e.p.radius } }
      // 重いエフェクト: このあと続く分のはみ出しも見込んで RT を作る
      let pad = 0
      if (!S.buf || S.n4 || S.copies) {
        for (let j = i; j < chain.length; j++) if (isPass(chain[j].type)) pad += fxs.pad(chain[j].type, chain[j].p, S.rect)
        pad = Math.min(pad, 600)
      }
      // 大きくぼかす前の描き出しは、はじめから粗い解像度で(どうせぼけるので見た目は変わらない)
      let lo = 1
      if (e.type === 'blur' && (!S.buf || S.n4 || S.copies)) {
        const r0 = (num(e.p.radius, 10) * (S.buf ? S.res : S.ink && S.space === 'layer' ? this.fxRes(S.L) : this.env.rs)) / 2
        let ds = 1
        while (r0 / ds > 3.5 && ds < 16) ds *= 2
        if (ds >= 4) lo = 2 / ds
      }
      this.flush(S, pad, lo)
      if (S.hidden || !S.buf) break
      const res = S.res
      let b
      if (S.space === 'screen') {
        b = [0, 0, S.buf.width, S.buf.height]
        if (S.L.type !== 'adjustment' && S.L.type !== 'model' && S.L.type !== 'particles') {
          const q = this.corners(S.L, S.f, S.rect)
          if (q) b = [Math.min(...q.map((p) => p[0])) * res, Math.min(...q.map((p) => p[1])) * res, Math.max(...q.map((p) => p[0])) * res, Math.max(...q.map((p) => p[1])) * res]
        }
      } else b = [(S.rect.x - S.quad.x) * res, (S.rect.y - S.quad.y) * res, (S.rect.x + S.rect.w - S.quad.x) * res, (S.rect.y + S.rect.h - S.quad.y) * res]
      let out = null
      const sc = g.scissor
      g.setScissor(null)
      try { out = fxs.apply(e.type, e.p, S.buf, { res, f: S.f, fps: this.fps, rect: b, H: this.H, W: this.W, small: true }) } catch (err) { this.warn('fxerr' + e.type, 'effect', e.type, err) }
      g.setScissor(sc)
      if (out) {
        if (out.width !== S.buf.width) S.res *= out.width / S.buf.width // ぼかしは縮小したまま返してくる
        if (!S.borrow) g.release(S.buf); S.borrow = false; S.buf = out; S.tex = out.texture
      }
    }
    return chain.length
  }

  // 画面の px → レイヤー空間の変換(画面大のバッファに、レイヤー空間の切り抜きを掛けるとき)
  toLayerMat(L, f) {
    const e = this.mvp(L, f).elements, W = this.W, H = this.H
    // (x,y,1) → クリップ座標 (X,Y,W) → 画面の px。その逆行列
    const m = (this._m3 ??= new THREE.Matrix3())
    const a = e[0], b = e[4], c = e[12], d = e[1], e2 = e[5], f2 = e[13], g = e[3], h = e[7], i = e[15]
    // px = (X/Wc*0.5+0.5)*W → 同次で: [W/2*X + W/2*Wc, -H/2*Y + H/2*Wc, Wc]
    m.set((W / 2) * (a + g), (W / 2) * (b + h), (W / 2) * (c + i), (H / 2) * (g - d), (H / 2) * (h - e2), (H / 2) * (i - f2), g, h, i)
    if (Math.abs(m.determinant()) < 1e-12) return m.identity()
    return m.invert()
  }

  // S を target に描く。M = レイヤー空間(複製のあとの空間)→ クリップ座標
  emit(target, S, M, opacity, blend) {
    if (S.hidden) return
    const g = this.env.gfx, L = S.L
    const d = (this._draw ??= {})
    d.texture = S.tex; d.opacity = opacity; d.uvRect = S.uvRect; d.toSrgb = S.toSrgb
    d.pattern = S.pattern; d.dual = S.dual; d.dualOver = S.dualOver
    d.masks = S.masks; d.maskOrigin = S.maskOrigin
    d.ops = S.n4 ? this.opsOf(S) : null
    d.toLayer = S.space === 'screen' && S.buf && S.n4 ? this.toLayerMat(L, S.f) : null
    d.mvp = M
    d.edge = S.edge && !S.noEdge
    const copies = S.copies
    let batch
    if (!copies) {
      if (S.multi) batch = S.batch
      else {
        batch = L.b1 ??= new QuadBatch(1)
        batch.begin(1)
        if (!this.pushQuad(batch, S, this.aaPad(S, M, null, target, true), null, 1, this.aaPad(S, M, null, target, false))) return
        batch.end()
      }
    } else {
      batch = L.rb ??= new QuadBatch(16)
      const base = S.multi ? S.batch : null
      const nq = base ? base.count : 1
      batch.begin(Math.min(copies.length * nq, 200000))
      const pad = base ? 0 : this.aaPad(S, M, copies[0].m, target, true), lp = base ? 0 : this.aaPad(S, M, copies[0].m, target, false)
      for (const c of copies) {
        if (c.op <= 0.0005) continue
        if (!base) { if (!this.pushQuad(batch, S, pad, c.m, c.op, lp)) break }
        else {
          if (batch.count + nq > 200000) break
          const e = c.m.elements, P = base.pos, U = base.uv, Q = base.quad, CO = base.col
          for (let k = 0; k < nq; k++) {
            for (let v = 0; v < 4; v++) {
              const x = P[k * 12 + v * 3], y = P[k * 12 + v * 3 + 1], z = P[k * 12 + v * 3 + 2]
              _c12[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12]; _c12[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; _c12[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]
              _l8[v * 2] = x; _l8[v * 2 + 1] = y
            }
            const o = k * 16
            batch.push(_c12, U[k * 8], U[k * 8 + 1], U[k * 8 + 4], U[k * 8 + 5], Q[k * 8], Q[k * 8 + 1], Q[k * 8 + 4], Q[k * 8 + 5], CO[o] * c.op, CO[o + 1] * c.op, CO[o + 2] * c.op, CO[o + 3] * c.op, _l8)
          }
        }
      }
      batch.end()
    }
    d.batch = batch
    g.drawBatch(target, d, blend)
  }
  // 描く先の 1.5 画素ぶんにあたるレイヤーの px。edgeOnly = 縁をぼかす絵のときだけ(そうでなければ 0)
  aaPad(S, M, cm, target, edgeOnly) {
    if (edgeOnly && (!S.edge || S.noEdge)) return 0
    if (S.multi) return 0
    const r = S.quad
    const m = cm ? _m3.multiplyMatrices(M, cm) : M
    const tw = target.width / 2, th = target.height / 2
    const P = (x, y, o) => { _v4.set(x, y, 0, 1).applyMatrix4(m); if (_v4.w <= 1e-6) return false; o[0] = (_v4.x / _v4.w) * tw; o[1] = (_v4.y / _v4.w) * th; return true }
    const a = _pa, b = _pb, c = _pc
    if (!P(r.x, r.y, a) || !P(r.x + r.w, r.y, b) || !P(r.x, r.y + r.h, c)) return edgeOnly ? 0 : 1e6
    const sx = Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1e-6, r.w)
    const sy = Math.hypot(c[0] - a[0], c[1] - a[1]) / Math.max(1e-6, r.h)
    const s = Math.min(sx, sy)
    return s > 1e-4 ? Math.min(1.5 / s, 4096) : edgeOnly ? 0 : 1e6
  }
  // 1 枚ものの四角形を積む。cm = 複製の行列(レイヤー空間)。lp = 画面の 1.5 画素ぶんのレイヤー px。
  // 切り抜きの半平面があれば、その形の多角形に切りつめて積む。何も残らなければ false
  pushQuad(batch, S, pad, cm, op, lp = 0) {
    const r = S.quad, uvr = S.uvRect
    pad += S.inkPad
    const x0 = r.x - pad, y0 = r.y - pad, x1 = r.x + r.w + pad, y1 = r.y + r.h + pad
    const px = r.w > 0 ? pad / r.w : 0, py = r.h > 0 ? pad / r.h : 0
    let u0 = uvr ? uvr[0] : 0, v0 = uvr ? uvr[1] : 0, u1 = uvr ? uvr[2] : 1, v1 = uvr ? uvr[3] : 1
    const t = S.tint
    const cr = (t ? t[0] : 1) * op, cg = (t ? t[1] : 1) * op, cb = (t ? t[2] : 1) * op, ca = (t ? t[3] : 1) * op
    const p = _c12, l = _l8
    if (S.planes && S.planes.length && lp < 1e5) {
      const poly = this.clipRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, S.planes, lp)
      if (!poly) return false
      const n = poly.length, e = cm ? cm.elements : null
      const uv = _u8, q = _q8
      const put = (k, v) => {
        const x = v[0], y = v[1]
        l[k * 2] = x; l[k * 2 + 1] = y
        const qx = r.w > 0 ? (x - r.x) / r.w : 0, qy = r.h > 0 ? (y - r.y) / r.h : 0
        q[k * 2] = qx; q[k * 2 + 1] = qy
        uv[k * 2] = u0 + (u1 - u0) * qx; uv[k * 2 + 1] = v0 + (v1 - v0) * qy
        if (e) { p[k * 3] = e[0] * x + e[4] * y + e[12]; p[k * 3 + 1] = e[1] * x + e[5] * y + e[13]; p[k * 3 + 2] = e[2] * x + e[6] * y + e[14] }
        else { p[k * 3] = x; p[k * 3 + 1] = y; p[k * 3 + 2] = 0 }
      }
      // 三角形の扇に分ける(四角形の枠に、最後の 2 頂点を重ねて入れる)
      for (let k = 1; k < n - 1; k += 2) {
        put(0, poly[0]); put(1, poly[k]); put(2, poly[k + 1]); put(3, poly[Math.min(k + 2, n - 1)])
        batch.pushRaw(p, uv, q, cr, cg, cb, ca, l)
      }
      return true
    }
    if (!(S.edge && !S.noEdge) && pad) { const du = (u1 - u0) * px, dv = (v1 - v0) * py; u0 -= du; u1 += du; v0 -= dv; v1 += dv }
    p[0] = x0; p[1] = y0; p[2] = 0; p[3] = x1; p[4] = y0; p[5] = 0; p[6] = x1; p[7] = y1; p[8] = 0; p[9] = x0; p[10] = y1; p[11] = 0
    if (cm) {
      l[0] = x0; l[1] = y0; l[2] = x1; l[3] = y0; l[4] = x1; l[5] = y1; l[6] = x0; l[7] = y1
      const e = cm.elements
      for (let v = 0; v < 4; v++) {
        const x = l[v * 2], y = l[v * 2 + 1]
        p[v * 3] = e[0] * x + e[4] * y + e[12]; p[v * 3 + 1] = e[1] * x + e[5] * y + e[13]; p[v * 3 + 2] = e[2] * x + e[6] * y + e[14]
      }
      batch.push(p, u0, v0, u1, v1, -px, -py, 1 + px, 1 + py, cr, cg, cb, ca, l)
    } else batch.push(p, u0, v0, u1, v1, -px, -py, 1 + px, 1 + py, cr, cg, cb, ca)
    return true
  }

  // ---- 複製(layer.repeater) ----
  // → [{m: 世界行列, op}](描く順)。使わないときは null
  repeaterCopies(L, f) {
    const R = L.def.repeater
    if (!R || typeof R !== 'object' || R.enabled === false) return null
    const n = clamp(Math.floor(num(evalProp(R.count, f, this.fps), 1) + 1e-6), 0, MAX_COPIES)
    const mode = R.mode || 'linear'
    const O = R.offset || {}
    const oPos = vec(evalVec(O.position, f, this.fps), 3, 0)
    const oRot = rotVec(evalProp(O.rotation, f, this.fps) ?? 0)
    const oScV = evalProp(O.scale, f, this.fps), oSc = vec(oScV ?? 100, 2, 100)
    const oOp = clamp(num(evalProp(O.opacity, f, this.fps), 100) / 100, 0, 1)
    const to = num(R.time_offset, 0)
    const an = vec(this.tr(L, 'anchor', f, 0), 3, 0)
    const rect = this.rect(L, f) || { w: 100, h: 100 }
    const grid = R.grid || {}, radial = R.radial || {}, rnd = R.random || {}
    const cols = Math.max(1, Math.round(num(evalProp(grid.cols, f, this.fps), Math.ceil(Math.sqrt(n)))))
    const rows = Math.ceil(n / cols)
    const gap = vec(evalProp(grid.gap, f, this.fps) ?? 0, 2, 0)
    const pitch = grid.pitch != null ? vec(evalProp(grid.pitch, f, this.fps), 2, 0) : [rect.w + gap[0], rect.h + gap[1]]
    const rad = num(evalProp(radial.radius, f, this.fps), 300), st = num(evalProp(radial.start_angle, f, this.fps), 0), sw = num(evalProp(radial.sweep, f, this.fps), 360)
    const area = vec(evalProp(rnd.area, f, this.fps) ?? [this.W, this.H, 0], 3, 0), seed = num(rnd.seed, 1) | 0
    const rRot = num(evalProp(rnd.rotation, f, this.fps), 0), rSc = Array.isArray(rnd.scale_range) ? rnd.scale_range : [100, 100]
    const out = []
    const is3d = this.is3d(L)
    for (let i = 0; i < n; i++) {
      const fi = f - i * to
      if (to && !this.inRange(L, fi)) continue
      let x = 0, y = 0, z = 0, rz = oRot[2] * i, rx = oRot[0] * i, ry = oRot[1] * i, sx = (oSc[0] / 100) ** i, sy = ((Array.isArray(oScV) ? oSc[1] : oSc[0]) / 100) ** i, op = oOp ** i
      if (mode === 'grid') {
        const c = i % cols, r = Math.floor(i / cols)
        x = (c - (cols - 1) / 2) * pitch[0] + (grid.stagger && r % 2 ? pitch[0] / 2 : 0); y = (r - (rows - 1) / 2) * pitch[1]
        x += oPos[0] * i; y += oPos[1] * i; z += oPos[2] * i
      } else if (mode === 'radial') {
        const a = st + (Math.abs(sw) >= 360 ? i / Math.max(1, n) : n > 1 ? i / (n - 1) : 0) * sw
        x = Math.sin(a * D2R) * rad; y = -Math.cos(a * D2R) * rad
        if (radial.face_center) rz += a
        z += oPos[2] * i
      } else if (mode === 'random') {
        x = (rand01(seed, i, 1) - 0.5) * area[0]; y = (rand01(seed, i, 2) - 0.5) * area[1]; z = (rand01(seed, i, 3) - 0.5) * area[2]
        rz += (rand01(seed, i, 4) * 2 - 1) * rRot
        if (is3d && rnd.rotation_3d) { rx += (rand01(seed, i, 6) * 2 - 1) * num(rnd.rotation_3d, 0); ry += (rand01(seed, i, 7) * 2 - 1) * num(rnd.rotation_3d, 0) }
        const s = (num(rSc[0], 100) + (num(rSc[1], 100) - num(rSc[0], 100)) * rand01(seed, i, 5)) / 100
        sx *= s; sy *= s
      } else { x = oPos[0] * i; y = oPos[1] * i; z = oPos[2] * i }
      // 置き場所のずれは親の空間で足し、回転・拡大は 1 個ずつ自分の anchor を中心に掛ける
      //   世界行列 = (グループ × 親) × T(ずれ) × レイヤー自身の変形 × (anchor まわりの回転・拡大)
      const m = new THREE.Matrix4()
      _e.set(is3d ? -rx * D2R : 0, is3d ? -ry * D2R : 0, rz * D2R, 'XYZ')
      m.makeRotationFromEuler(_e).scale(_v.set(sx, sy, 1))
      _v.set(an[0], an[1], an[2]).applyMatrix4(m)
      m.setPosition(an[0] - _v.x, an[1] - _v.y, an[2] - _v.z)
      m.premultiply(this.local(L, fi, _m2))
      m.premultiply(_m2.makeTranslation(x, y, is3d ? z : 0))
      const pid = L.def.parent, P = pid != null ? this.layers.get(String(pid)) : null
      if (P && P !== L) m.premultiply(this.world(P, fi))
      if (L.groups) for (const G of L.groups) if (this.active(G, fi)) m.premultiply(this.groupMatrix(G, fi))
      out.push({ m, op: to ? op * this.opacityOf(L, fi) : op, fi, i })
    }
    if (is3d) {
      // 立体: カメラから遠い順
      const view = this.camFor(L, f).view
      for (const c of out) { _v.set(an[0], an[1], an[2]).applyMatrix4(c.m).applyMatrix4(view); c.d = _v.z }
      out.sort((a, b) => b.d - a.d || a.i - b.i)
    } else if (R.order === 'front') out.reverse() // front = 最初の 1 個がいちばん手前
    return out
  }
  // 複製ごとに中身まで時刻をずらす必要があるか(中身・エフェクトが動くレイヤー)
  timeVarying(L) {
    if (L.tv === undefined) {
      const d = L.def
      L.tv = d.type === 'video' || d.type === 'comp' || d.type === 'sequence' || d.type === 'particles' || anyAnimated(d.source) || anyAnimated(d.effects) || !!d.transition_in || !!d.transition_out || !!d.source?.per_char
    }
    return L.tv
  }

  // 中身 + エフェクトの列まで済ませた状態。無ければ null。prefixOnly = 軽いエフェクトまで(モーションブラー用)
  build(L, f, stack, chain, prefixOnly = false) {
    const C = this.content(L, f, stack)
    if (!C) return null
    const S = this.newState(L, f, C)
    S.stack = stack
    if (chain.length) S.next = this.runChain(S, chain, 0, prefixOnly)
    else S.next = 0
    if (S.hidden) { this.freeState(S); return null }
    return S
  }

  // 状態 S の画面上の外接矩形(バッファの px。[x,y,w,h])。決められなければ null(= 全面)
  screenBox(S, M) {
    if (!S.ink || S.space === 'screen') return null
    const rs = this.env.rs, [bw, bh] = this.bufSize()
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    const b = S.copies ? (S.baseInk ?? S.ink) : S.ink, pad = S.inkPad + 2
    const r = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }
    const one = (m) => {
      const q = this.corners(S.L, S.f, r, m)
      if (!q) return false
      for (const p of q) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
      return true
    }
    if (S.copies) { for (const c of S.copies) if (!one(_m2.multiplyMatrices(M, c.m))) return null }
    else if (!one(M)) return null
    x0 = Math.max(0, Math.floor(x0 * rs) - 2); y0 = Math.max(0, Math.floor(y0 * rs) - 2)
    x1 = Math.min(bw, Math.ceil(x1 * rs) + 2); y1 = Math.min(bh, Math.ceil(y1 * rs) + 2)
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)]
  }

  // マット・切り抜き元のレイヤーを画面大の RT に(1 回の render の間は使い回す)
  matteBuf(ML, f, stack) {
    const key = ML.id + '@' + f
    let rt = this.mcache.get(key)
    if (rt !== undefined) return rt
    rt = null
    if (this.inRange(ML, f)) {
      const g = this.env.gfx, [bw, bh] = this.bufSize()
      const sc = g.scissor
      g.setScissor(null)
      rt = g.acquire(bw, bh)
      g.clear(rt)
      this.composite(rt, ML, f, stack, true)
      g.setScissor(sc)
    }
    this.mcache.set(key, rt)
    return rt
  }
  clearMattes() {
    for (const rt of this.mcache.values()) if (rt) this.env.gfx.release(rt)
    this.mcache.clear()
  }

  // モーションブラー: 前後の小数コマを足し込んだ画面大の状態を作る。8bit だと 1/N の刻みで荒れるので float の RT に積む
  motionBlurState(L, f, stack) {
    const g = this.env.gfx, [bw, bh] = this.bufSize()
    const acc = g.acquire(bw, bh, { float: true })
    g.clear(acc)
    let drew = false, last = null
    const N = clamp(typeof L.def.motion_blur === 'number' ? Math.round(L.def.motion_blur) : MB_SAMPLES, 2, 64)
    for (let i = 0; i < N; i++) {
      const fs = f + ((i + 0.5) / N - 0.5) * MB_SHUTTER
      const S = this.build(L, fs, stack, this.chain(L, fs), true)
      if (!S) continue
      const M = S.screenContent ? this.p2d : this.mvp(L, fs)
      if (S.multi || S.internalAdd || S.copies) {
        // 文字や粒は重なりがあるので、いったん 1 枚にしてから足す
        const one = g.acquire(bw, bh)
        g.clear(one)
        this.emit(one, S, M, 1, S.internalAdd ? 'add' : 'normal')
        g.copy(one.texture, acc, 1 / N, 'sum')
        g.release(one)
      } else this.emit(acc, S, M, 1 / N, 'sum')
      this.freeState(S)
      last = S
      drew = true
    }
    if (!drew) { g.release(acc); return null }
    const out = g.acquire(bw, bh)
    g.copy(acc.texture, out)
    g.release(acc)
    const rect = this.rect(L, f) || { x: 0, y: 0, w: this.W, h: this.H }
    const S = {
      L, f, tex: out.texture, uvRect: [0, 1, 1, 0], quad: { x: 0, y: 0, w: this.W, h: this.H }, rect, ink: null, edge: false, multi: false, batch: null,
      pattern: null, dual: false, dualOver: false, tint: null, toSrgb: false, internalAdd: false, screenContent: false, masks: null, maskOrigin: [0, 0],
      ops: [], data: null, opTex: [], n4: 0, stage: 0, copies: null, noEdge: false, inkPad: 0, hidden: false, space: 'screen', buf: out, res: this.env.rs, temps: [], stack,
    }
    // 重いエフェクトは足し込んだあとの絵に掛ける
    const chain = this.chain(L, f)
    if (last && last.next < chain.length) this.runChain(S, chain, last.next)
    return S
  }

  // レイヤーを target に重ねる。asMatte = マット用(ブレンド・マットは無視して、不透明度つきでそのまま描く)
  composite(target, L, f, stack, asMatte = false) {
    const g = this.env.gfx, def = L.def
    const sc0 = g.scissor
    const tl = this.lt(L, f)
    let op = this.opacityOf(L, tl)
    const rep = def.repeater && def.repeater.enabled !== false ? def.repeater : null
    if (op <= 0 && !(rep && num(rep.time_offset, 0))) return
    let blend = def.blend in SHADER_BLEND ? def.blend : 'normal'
    if (def.blend && !(def.blend in SHADER_BLEND)) this.warn('blend' + def.blend, `未対応のブレンド: ${def.blend}`)
    if (asMatte) blend = 'normal'
    const matteL = !asMatte && def.matte?.layer != null ? this.layers.get(String(def.matte.layer)) : null
    const clipL = !asMatte && def.clip_to != null ? this.layers.get(String(def.clip_to)) : null
    if (def.double_sided === false && this.is3d(L)) {
      // 裏を向いていたら描かない(画面上で四隅が反時計回り)
      const r = this.rect(L, tl), q = r && this.corners(L, tl, r)
      if (q && (q[1][0] - q[0][0]) * (q[3][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[3][0] - q[0][0]) < 0) return
    }
    // 複製ごとに中身の時刻もずらす(中身が動くレイヤー)。個数が多いときは形だけずらす
    const copies = rep ? this.repeaterCopies(L, tl) : null
    if (rep && (!copies || !copies.length)) return
    const perCopy = copies && num(rep.time_offset, 0) && this.timeVarying(L) && copies.length <= 64 && !def.motion_blur
    const states = []
    try {
      if (perCopy) {
        for (const c of copies) {
          const S = this.build(L, c.fi, stack, this.chain(L, c.fi))
          if (!S) continue
          if (S.space === 'screen') { this.freeState(S); continue }
          states.push({ S, M: _m.multiplyMatrices(this.vpOf(L, tl), c.m).clone(), op: c.op })
        }
      } else {
        const S = def.motion_blur ? this.motionBlurState(L, tl, stack) : this.build(L, tl, stack, this.chain(L, tl))
        if (!S) return
        let M = S.space === 'screen' || S.screenContent ? this.p2d : this.mvp(L, tl)
        if (copies) {
          if (S.space === 'screen' && S.buf) {
            // 画面大のバッファ(粒子など)を複製: 2D なら画面上の変換に直せる
            if (!this.is3d(L)) {
              const inv = _m.copy(this.drawWorld(L, tl)).invert()
              S.copies = copies.map((c) => ({ m: new THREE.Matrix4().multiplyMatrices(c.m, inv), op: c.op }))
              if (num(rep.time_offset, 0)) op = 1
            } else this.warn('rep3d' + L.id, `レイヤー ${L.id}: 範囲の決まらない 3D レイヤーは複製できない`)
          } else {
            if (S.ops.some((o) => o.stage === 1)) this.flush(S, 0)
            // 世界行列ごと差し替えるので、射影だけを掛ける
            const base = S.copies
            S.baseInk ??= S.ink
            S.copies = base ? copies.flatMap((c) => base.map((b) => ({ m: new THREE.Matrix4().multiplyMatrices(c.m, b.m), op: c.op * b.op }))) : copies
            M = S.screenContent ? this.p2d : this.vpOf(L, tl)
            if (num(rep.time_offset, 0)) op = 1
          }
        }
        states.push({ S, M, op })
      }
      if (!states.length) return
      const s0 = states[0].S
      const overlap = states.length > 1 || s0.multi || !!s0.copies
      const direct = isGlBlend(blend) && !matteL && !clipL && !(overlap && states.some((x) => x.op < 0.999)) && !(s0.internalAdd && blend !== 'add')
      if (direct) {
        for (const x of states) this.emit(target, x.S, x.M, x.op, blend)
        return
      }
      // いったん画面大の RT にまとめてから重ねる(マット・背景を読むブレンド・重なりのある半透明)
      const [bw, bh] = this.bufSize()
      let box = states.length === 1 ? this.screenBox(s0, states[0].M) : null
      if (box && (box[2] <= 0 || box[3] <= 0)) return
      if (box && box[2] * box[3] > bw * bh * 0.85) box = null
      let buf
      const uniformOp = states.every((x) => Math.abs(x.op - states[0].op) < 1e-6) ? states[0].op : null
      if (states.length === 1 && s0.space === 'screen' && s0.buf && !s0.n4 && !s0.copies) { buf = s0.buf; s0.buf = null }
      else {
        buf = g.acquire(bw, bh)
        g.setScissor(box)
        g.clear(buf)
        for (const x of states) this.emit(buf, x.S, x.M, uniformOp != null ? 1 : x.op, x.S.internalAdd ? 'add' : 'normal')
      }
      g.setScissor(box)
      const finalOp = uniformOp != null ? uniformOp : 1
      for (const [ML, mode] of [[matteL, def.matte?.mode], [clipL, def.clip_mode || 'alpha']]) {
        if (!ML) continue
        const mb = this.matteBuf(ML, f, stack)
        const out = g.acquire(bw, bh)
        if (mb) g.pass(this.env.matteMat, out, { tSrc: buf.texture, tMatte: mb.texture, uMode: MATTE_MODE[mode] ?? 0 })
        else {
          // マットが無い区間: 反転なら全部見える、そうでなければ何も見えない
          if (mode === 'alpha_inv' || mode === 'luma_inv') g.copy(buf.texture, out); else g.clear(out)
        }
        g.release(buf); buf = out
      }
      if (isGlBlend(blend)) g.copy(buf.texture, target, finalOp, blend)
      else {
        // 背景を読むブレンド: 範囲だけ写しを取って、そこへ合成し直す
        const tmp = g.acquire(target.width, target.height)
        g.copy(target.texture, tmp)
        g.pass(this.env.blendMat, target, { tBase: tmp.texture, tSrc: buf.texture, uOpacity: finalOp, uMode: SHADER_BLEND[blend] })
        g.release(tmp)
      }
      g.release(buf)
    } finally {
      g.setScissor(sc0)
      for (const x of states) this.freeState(x.S)
    }
  }

  // 調整レイヤー: ここまでの合成結果にエフェクトを掛ける。範囲はレイヤーの箱・マスク・不透明度
  adjust(acc, L, f) {
    const g = this.env.gfx, def = L.def
    const tl = this.lt(L, f)
    const chain = this.chain(L, tl)
    const op = this.opacityOf(L, tl)
    if ((!chain.length && !def.snapshot) || op <= 0) return acc
    const rect = this.rect(L, tl)
    const S = {
      L, f: tl, tex: acc.texture, uvRect: [0, 1, 1, 0], quad: { x: 0, y: 0, w: this.W, h: this.H }, rect, ink: null, edge: false, multi: false, batch: null,
      pattern: null, dual: false, dualOver: false, tint: null, toSrgb: false, internalAdd: false, screenContent: false, masks: null, maskOrigin: [0, 0],
      ops: [], data: null, opTex: [], n4: 0, stage: 0, copies: null, noEdge: false, inkPad: 0, hidden: false, space: 'screen', buf: null, res: this.env.rs, temps: [], stack: [],
    }
    // acc を「画面大の絵」として始める(借り物なので解放しない)
    S.buf = acc; S.borrow = true
    this.runChain(S, chain)
    if (S.n4 || S.copies) this.flush(S, 0)
    if (S.hidden) return acc
    let fxed = S.buf
    S.buf = null
    if (fxed !== acc && (fxed.width !== acc.width || fxed.height !== acc.height)) {
      // ぼかしが縮小したままの RT を返したとき: 画面の大きさへ戻す
      const up = g.acquire(acc.width, acc.height)
      g.copy(fxed.texture, up)
      g.release(fxed); fxed = up
    }
    for (const t of S.temps) g.release(t)
    if (def.snapshot) {
      // ここまでの画面を 1 枚の絵として、レイヤーの変形を掛けて置き直す(AviUtl のフレームバッファ)
      const out = g.acquire(acc.width, acc.height)
      g.clear(out)
      if (def.snapshot !== 'replace') g.copy(acc.texture, out) // 元の画面の上に重ねる。'replace' なら置き換える
      const C = this.content(L, tl, [])
      if (C) {
        const SS = this.newState(L, tl, C)
        SS.tex = fxed.texture; SS.uvRect = [0, 1, 1, 0]
        this.emit(out, SS, this.mvp(L, tl), op, 'normal')
      }
      if (fxed !== acc) g.release(fxed)
      g.release(acc)
      return out
    }
    if (fxed === acc) return acc
    const t = def.transform || {}
    const trivial = op >= 0.999 && !(def.masks && def.masks.length) && def.parent == null && !L.groups &&
      isDefaultConst(t.position, [this.W / 2, this.H / 2, 0]) && isDefaultConst(t.scale, [100]) &&
      (t.rotation == null || t.rotation === 0 || isDefaultConst(t.rotation, [0])) && isDefaultConst(t.anchor, [0])
    if (trivial) { g.release(acc); return fxed }
    const cov = g.acquire(acc.width, acc.height)
    g.clear(cov)
    const C = this.content(L, tl, [])
    if (C) this.emit(cov, this.newState(L, tl, C), this.mvp(L, tl), op, 'normal')
    const out = g.acquire(acc.width, acc.height)
    g.pass(this.env.mixMat, out, { tA: acc.texture, tB: fxed.texture, tM: cov.texture })
    g.release(cov); g.release(fxed); g.release(acc)
    return out
  }

  // 描く順(奥 → 手前)。連続する 3D レイヤーの塊の中だけ、カメラから遠い順に並べ替える
  // (基準は各レイヤーの anchor の奥行き。交差する面・大きな床は正しく並ばない)
  drawList(f) {
    const list = (this._list ??= [])
    list.length = 0
    let group = []
    const flush = () => {
      if (group.length > 1) {
        for (const L of group) L._depth = this.viewDepth(L, this.lt(L, f))
        group.sort((a, b) => b._depth - a._depth || a._ord - b._ord)
      }
      for (const L of group) list.push(L)
      group = []
    }
    for (let i = this.order.length - 1, ord = 0; i >= 0; i--) {
      const L = this.order[i]
      if (!DRAWABLE.has(L.type) || !this.active(L, f) || this.matteSources.has(L.id)) continue
      L._ord = ord++
      // カメラが zbuffer: false のときは奥行きで並べ替えない(配列の順のまま)
      if (this.is3d(L) && L.type !== 'adjustment' && !this.noSort(L, f)) group.push(L)
      else { flush(); list.push(L) }
    }
    flush()
    return list
  }

  noSort(L, f) {
    if (L.cams) for (const C of L.cams) if (this.active(C, f)) return C.def.source?.zbuffer === false
    return false
  }

  // 非同期の素材を読み始める(capture ではこれで積まれた Promise を待つ)
  prepare(f, stack = []) {
    const env = this.env
    for (const L of this.order) {
      const isMatte = this.matteSources.has(L.id)
      if (!(isMatte ? this.inRange(L, f) : this.active(L, f))) continue
      const s = L.def.source || {}
      try {
        const tl = this.lt(L, f)
        if (L.type === 'image' || L.type === 'sequence' || (L.type === 'video' && s.sequence)) this.imageEntry(L, tl)
        else if (L.type === 'video') this.videoState(L, tl, false)
        else if (L.type === 'text') {
          if (Array.isArray(s.runs)) for (const r of s.runs) env.font(fontSpec({ ...s, ...r }, 32), String(r?.text ?? ''))
          else env.font(fontSpec(s, 32), s.counter ? '0123456789' : String(evalProp(s.text, tl, this.fps) ?? ''))
        } else if (L.type === 'model') env.models.prepare(this, L)
        else if (L.type === 'particles') this.particleSprite(L)
        else if (L.type === 'comp' && s.comp_id != null) this.prepareComp(s.comp_id, (this.srcFrame(L, tl) / this.fps), stack, L)
        if (Array.isArray(L.def.effects)) {
          for (const e of L.def.effects) {
            if (!e || e.enabled === false || !e.params) continue
            const p = e.params
            if (e.type === 'mask_image') { const url = p.url ? this.srcUrl(p.url) : p.asset_id != null ? this.assetUrl(p.asset_id, 'image') : null; if (url) env.assets.image(url) }
            else if (e.type === 'overlay_source') {
              const n = (tl - (L.def.in ?? 0)) * num(evalProp(p.speed, tl, this.fps), 1) + num(evalProp(p.start, tl, this.fps), 0)
              if (p.comp_id != null) this.prepareComp(p.comp_id, n / this.fps, stack, L)
              else if (p.asset_id != null) {
                const me = env.assets.meta(p.asset_id)
                const isVideo = p.kind === 'video' || (p.kind == null && me.data?.asset_type === 'video')
                if (isVideo && env.mode === 'capture') env.assets.image(this.frameUrl(p.asset_id, Math.max(0, Math.floor(n + 1e-4))), true)
                else if (!isVideo && me.state !== 'loading') env.assets.image(this.assetUrl(p.asset_id, 'image'))
              } else if (p.url) env.assets.image(this.srcUrl(p.url))
            }
          }
        }
      } catch (err) { this.warn('prep' + L.id, 'prepare', L.id, err) }
    }
  }
  prepareComp(cid, sec, stack, L) {
    const e = this.env.comps.get(cid)
    if (e.scene && !stack.includes(e.id) && stack.length < MAX_DEPTH) {
      let cf = sec * e.scene.fps
      if (L) cf = this.fitFrame(L, cf, e.scene.duration)
      e.scene.prepare(cf, [...stack, e.id])
    }
  }

  render(f, stack = []) {
    const g = this.env.gfx
    const [bw, bh] = this.bufSize()
    let acc = g.acquire(bw, bh)
    const sc0 = g.scissor
    g.setScissor(null)
    g.clear(acc)
    const bg = this.comp.data?.bg
    if (bg) { const c = toColor(bg, [0, 0, 0, 1]); g.fill(acc, c[0], c[1], c[2], 1) }
    for (const L of this.drawList(f).slice()) {
      try {
        if (L.type === 'adjustment') acc = this.adjust(acc, L, f)
        else this.composite(acc, L, f, stack)
      } catch (err) { g.setScissor(null); this.warn('draw' + L.id, `レイヤー ${L.id} を描けない:`, err) }
    }
    this.clearMattes()
    g.setScissor(sc0)
    return acc
  }

  // ---- 編集画面むけ ----
  bounds(id, f) {
    const L = this.layers.get(String(id))
    if (!L || L.type === 'camera') return null
    const tl = this.lt(L, f)
    const rect = this.rect(L, tl)
    if (!rect) return null
    const corners = this.corners(L, tl, rect)
    if (!corners) return null
    const an = vec(this.tr(L, 'anchor', tl, 0), 3, 0)
    const mvp = this.mvp(L, tl)
    _v4.set(an[0], an[1], an[2], 1).applyMatrix4(mvp)
    const anchor = _v4.w > 1e-6 ? [(_v4.x / _v4.w * 0.5 + 0.5) * this.W, (0.5 - _v4.y / _v4.w * 0.5) * this.H] : null
    return { corners, anchor, three_d: this.is3d(L) }
  }
  pick(x, y, f) {
    const list = this.drawList(f)
    for (let i = list.length - 1; i >= 0; i--) {
      const L = list[i]
      if (L.def.locked || L.type === 'adjustment') continue
      const tl = this.lt(L, f)
      if (this.opacityOf(L, tl) <= 0) continue
      const rect = this.rect(L, tl)
      const q = rect && this.corners(L, tl, rect)
      if (!q) continue
      // 凸四角形の内外判定(四辺に対して同じ側)
      let pos = 0, neg = 0
      for (let k = 0; k < 4; k++) {
        const a = q[k], b = q[(k + 1) % 4]
        const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
        if (c > 0) pos++; else if (c < 0) neg++
      }
      if (pos === 0 || neg === 0) return L.id
    }
    return null
  }
  // 画面上の移動量(px)を、そのレイヤーの position の変化量に直す
  screenDelta(id, f, dx, dy) {
    const L = this.layers.get(String(id))
    if (!L) return [dx, dy, 0]
    const d = _d
    if (this.is3d(L)) {
      // 画面と平行な面の上を動かす(奥行きはそのまま)
      const cam = this.camFor(L, f)
      const k = cam.ortho ? 1 : Math.max(1e-3, this.viewDepth(L, f)) / cam.zoom
      d.set(dx * k, dy * k, 0).applyMatrix4(_m2.copy(cam.world).setPosition(0, 0, 0))
    } else d.set(dx, dy, 0)
    // グループ・親の変形を打ち消す
    if (L.groups) {
      _m.identity()
      for (const G of L.groups) if (this.active(G, f)) _m.premultiply(this.groupMatrix(G, f))
      d.applyMatrix4(_m.setPosition(0, 0, 0).invert())
    }
    const pid = L.def.parent
    const P = pid != null ? this.layers.get(String(pid)) : null
    if (P && P !== L) {
      const pw = this.world(P, f)
      d.applyMatrix4(_m.copy(pw).setPosition(0, 0, 0).invert())
    }
    return [d.x, d.y, d.z]
  }
}

export { BLEND_FRAG, MATTE_FRAG, MIX_FRAG, ModelStore }
