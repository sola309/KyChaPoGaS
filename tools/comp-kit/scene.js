// 1 つのコンポジション文書を描く。入れ子のコンポジションも同じクラスを使う。
//   render(f) → 画面と同じ大きさの RT(乗算済みアルファ)。呼び出し側が release する。
// 行列はコンポジションの座標(左上原点・y 下向き・z 奥が正)のまま計算し、射影で初めて GL の向きに直す。
import { THREE, QuadBatch, isGlBlend, MAX_MASKS, MASK_PTS } from './gfx.js'
import { evalProp, evalAll, toColor, num, vec, maxAbs, clamp, isAnimated } from './props.js'
import { rasterShape } from './shape.js'
import { layoutText, fillTextBatch, fontSpec } from './text.js'
import { fillParticles, spriteCanvas } from './particles.js'
import { canvasTexture } from './assets.js'
import { ModelStore } from './model.js'

const D2R = Math.PI / 180
const DEFAULT_FOV = 39.6 // AE の 50mm 相当(水平画角)
const DRAWABLE = new Set(['image', 'video', 'text', 'shape', 'solid', 'comp', 'model', 'particles', 'adjustment'])
const KNOWN = new Set([...DRAWABLE, 'null', 'camera'])
const SHADER_BLEND = { multiply: 0, overlay: 1, lighten: 2, darken: 3, difference: 4, normal: 5, add: 6, screen: 7 }
const MB_SAMPLES = 16, MB_SHUTTER = 0.5 // モーションブラー: 180° シャッター。motion_blur に数を書くとその回数
const MAX_DEPTH = 8

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

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _e = new THREE.Euler()
const _d = new THREE.Vector3()
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector4()

function rotVec(r) {
  if (Array.isArray(r)) return r.length >= 3 ? [num(r[0]), num(r[1]), num(r[2])] : [0, 0, num(r[r.length - 1])]
  return [0, 0, num(r, 0)]
}
const isDefaultConst = (p, d) => p == null || (!isAnimated(p) && Array.isArray(p) && p.every((x, i) => x === (d[i] ?? d[d.length - 1])))

export class CompScene {
  constructor(env, comp) {
    this.env = env
    this.layers = new Map() // id → 実行時の情報(キャッシュつき)
    this.order = []
    this.overrides = new Map() // id → {position}(ドラッグ中の仮の値)
    this.p2d = new THREE.Matrix4()
    this.cam = { stamp: NaN, world: new THREE.Matrix4(), view: new THREE.Matrix4(), vp: new THREE.Matrix4(), zoom: 1 }
    this.warned = new Set()
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
        L = { id, type: def.type, cache: {}, batch: null, wm: new THREE.Matrix4(), mvp: new THREE.Matrix4(), stamp: NaN, mvpStamp: NaN, content: {}, opacity: 1 }
      }
      L.def = def
      L.stamp = NaN; L.mvpStamp = NaN
      L.rsHint = 0
      next.set(id, L)
      this.order.push(L)
      if (def.matte?.layer != null) this.matteSources.add(String(def.matte.layer))
      if (def.solo) this.anySolo = true
    }
    for (const [id, L] of this.layers) if (next.get(id) !== L) this.disposeLayer(L)
    this.layers = next
    this.cam.stamp = NaN
  }

  disposeLayer(L) {
    L.batch?.dispose()
    for (const k of Object.keys(L.cache)) L.cache[k]?.tex?.dispose?.()
    this.env.assets.dropVideo(this.videoKey(L))
    L.cache = {}
  }
  dispose() {
    for (const L of this.layers.values()) this.disposeLayer(L)
    this.layers.clear(); this.order = []
  }
  videoKey(L) { return `${this.comp.id ?? 'c'}:${L.id}` }

  // ---- 時間と表示 ----
  inRange(L, f) {
    const d = L.def
    return f >= (d.in ?? 0) && f < (d.out ?? Infinity)
  }
  active(L, f) {
    const d = L.def
    if (d.visible === false || !this.inRange(L, f)) return false
    if (this.anySolo && !d.solo && L.type !== 'camera' && L.type !== 'null') return false
    return true
  }

  // ---- 変形 ----
  tr(L, key, f, dflt) {
    if (key === 'position') {
      const o = this.overrides.get(L.id)
      if (o && o.position) return o.position
    }
    return evalProp(L.def.transform?.[key], f, this.fps, dflt)
  }
  // レイヤーの世界行列(コンポジションの座標)。同じコマなら使い回す
  world(L, f, depth = 0) {
    if (L.stamp === f) return L.wm
    const m = L.wm
    const pos = vec(this.tr(L, 'position', f, L.type === 'camera' ? [this.W / 2, this.H / 2, -this.zoomOf(L, f)] : [this.W / 2, this.H / 2, 0]), 3, 0)
    const rot = rotVec(this.tr(L, 'rotation', f, 0))
    const is3d = L.def.three_d || L.type === 'camera' || L.type === 'model'
    if (L.type === 'camera') {
      m.identity()
      const tg = L.def.source?.target ?? L.def.target
      if (tg != null) {
        // 注視点つき: 視線 = +z、上 = -y になる基底を作る
        const t = vec(evalProp(tg, f, this.fps), 3, 0)
        const fw = _v.set(t[0] - pos[0], t[1] - pos[1], t[2] - pos[2])
        if (fw.lengthSq() > 1e-9) {
          fw.normalize()
          const right = _v2.set(0, 1, 0).cross(fw)
          if (right.lengthSq() < 1e-9) right.set(1, 0, 0)
          right.normalize()
          const down = _v3.copy(fw).cross(right)
          m.makeBasis(right, down, fw)
        }
      }
      _e.set(-rot[0] * D2R, -rot[1] * D2R, rot[2] * D2R, 'XYZ')
      m.multiply(_m.makeRotationFromEuler(_e))
      m.setPosition(pos[0], pos[1], pos[2])
    } else {
      const sc = vec(this.tr(L, 'scale', f, 100), 3, 100)
      const an = vec(this.tr(L, 'anchor', f, 0), 3, 0)
      _e.set(is3d ? -rot[0] * D2R : 0, is3d ? -rot[1] * D2R : 0, rot[2] * D2R, 'XYZ')
      m.makeRotationFromEuler(_e)
      m.scale(_v.set(sc[0] / 100, sc[1] / 100, sc[2] / 100))
      _v.set(an[0], an[1], an[2]).applyMatrix4(m)
      m.setPosition(pos[0] - _v.x, pos[1] - _v.y, (is3d ? pos[2] : 0) - _v.z)
    }
    const pid = L.def.parent
    if (pid != null && depth < 32) {
      const P = this.layers.get(String(pid))
      if (P && P !== L) m.premultiply(this.world(P, f, depth + 1))
    }
    L.stamp = f
    return m
  }
  zoomOf(L, f) {
    const s = L?.def.source || {}
    const z = num(evalProp(s.zoom, f, this.fps), 0)
    if (z > 0) return z
    const fov = clamp(num(evalProp(s.fov, f, this.fps), DEFAULT_FOV), 1, 170)
    return this.W / 2 / Math.tan((fov * D2R) / 2)
  }
  // そのコマで有効なカメラ(いちばん上の、表示中のカメラレイヤー)
  camera(f) {
    const c = this.cam
    if (c.stamp === f) return c
    let camL = null
    for (const L of this.order) if (L.type === 'camera' && this.active(L, f)) { camL = L; break }
    c.zoom = this.zoomOf(camL, f)
    if (camL) c.world.copy(this.world(camL, f))
    else c.world.makeTranslation(this.W / 2, this.H / 2, -c.zoom)
    c.view.copy(c.world).invert()
    const near = Math.max(1, c.zoom * 0.002), far = c.zoom * 1000
    _m.set(c.zoom / (this.W / 2), 0, 0, 0, 0, -c.zoom / (this.H / 2), 0, 0,
      0, 0, (far + near) / (far - near), (-2 * far * near) / (far - near), 0, 0, 1, 0)
    c.vp.multiplyMatrices(_m, c.view)
    c.stamp = f
    return c
  }
  is3d(L) { return !!L.def.three_d || L.type === 'model' }
  mvp(L, f) {
    if (L.mvpStamp === f) return L.mvp
    const w = this.world(L, f)
    if (this.is3d(L)) L.mvp.multiplyMatrices(this.camera(f).vp, w)
    else L.mvp.multiplyMatrices(this.p2d, w)
    L.mvpStamp = f
    return L.mvp
  }
  // カメラから見た奥行き(基準点 = anchor)
  viewDepth(L, f) {
    // world() / camera() は作業用のベクトルを使うので、先に求めてから計算する
    const w = this.world(L, f), view = this.camera(f).view
    const an = vec(this.tr(L, 'anchor', f, 0), 3, 0)
    _v.set(an[0], an[1], an[2]).applyMatrix4(w).applyMatrix4(view)
    return _v.z
  }

  // ---- ラスタライズの倍率 ----
  // 拡大してもぼけないよう、scale のキーの最大値(親も含む)に合わせて大きめに描いておく
  rasterScale(L) {
    if (L.rsHint) return L.rsHint * this.env.rs
    let s = 1, cur = L, guard = 0
    while (cur && guard++ < 32) {
      s *= maxAbs(cur.def.transform?.scale, 100) / 100
      cur = cur.def.parent != null ? this.layers.get(String(cur.def.parent)) : null
    }
    const pc = L.def.source?.per_char
    if (pc) s *= Math.max(1, maxAbs(pc.from?.scale, 100) / 100, maxAbs(pc.out?.from?.scale ?? pc.out?.scale, 100) / 100)
    // 段にして、少しの変更でテクスチャを作り直さないようにする
    const steps = [1, 1.5, 2, 3, 4]
    L.rsHint = steps.find((x) => x >= s - 1e-6) || 4
    return L.rsHint * this.env.rs
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
  srcFrame(L, f) {
    const d = L.def
    return (f - (d.in ?? 0)) * (d.speed ?? 1) + (d.start ?? 0)
  }
  childScene(L) {
    const cid = L.def.source?.comp_id
    if (cid == null) return null
    const e = this.env.comps.get(cid)
    return e
  }

  // レイヤーの中身の箱(レイヤー空間。原点 = 中心)。まだ読めていなければ null
  rect(L, f) {
    const s = L.def.source || {}
    const box = (w, h) => ({ x: -w / 2, y: -h / 2, w, h })
    switch (L.type) {
      case 'solid': return box(num(evalProp(s.width, f, this.fps), this.W), num(evalProp(s.height, f, this.fps), this.H))
      case 'adjustment': return box(this.W, this.H)
      case 'null': return box(100, 100)
      case 'image': {
        const e = this.imageEntry(L)
        return e && e.state === 'ready' ? box(e.w, e.h) : null
      }
      case 'video': {
        const v = this.videoState(L, f, false)
        return v && v.w ? box(v.w, v.h) : null
      }
      case 'shape': return this.shapeRaster(L, f)?.box || null
      case 'text': return this.textRaster(L, f)?.lay.rect || null
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

  imageEntry(L) {
    const s = L.def.source || {}
    const url = s.url ? this.srcUrl(s.url) : s.asset_id != null ? this.assetUrl(s.asset_id, 'image') : null
    return url ? this.env.assets.image(url) : null
  }
  // 動画: {tex, w, h}。preview は <video>、capture は 1 コマずつの画像
  videoState(L, f, sync = true) {
    const s = L.def.source || {}, A = this.env.assets
    if (s.asset_id == null && !s.url) return null
    let meta = null
    if (s.asset_id != null) meta = A.meta(s.asset_id).data
    const n = this.srcFrame(L, f)
    if (n < -1e-6) return null
    if (this.env.mode === 'capture') {
      if (s.asset_id == null) return null
      const e = A.image(this.frameUrl(s.asset_id, Math.floor(n + 1e-4)), true)
      if (e.state !== 'ready') return null
      return { tex: e.tex, w: meta?.width || e.w, h: meta?.height || e.h }
    }
    const e = A.video(this.videoKey(L), s.url ? this.srcUrl(s.url) : this.assetUrl(s.asset_id, 'video'))
    if (sync) A.syncVideo(e, n / this.fps + 0.002, this.env.playing, L.def.speed ?? 1) // 境目ちょうどだと前のコマになることがあるので少し進める
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
    const key = rs + JSON.stringify(s)
    return this.setCacheTex(L, 'shape', key, () => {
      const r = rasterShape(s, rs)
      return r ? { tex: canvasTexture(r.canvas), rect: r.rect, box: r.box } : { tex: null, rect: null, box: null }
    })
  }
  textRaster(L, f) {
    const src = L.def.source || {}
    const s = {}
    for (const k of Object.keys(src)) if (k !== 'per_char') s[k] = src[k] === null ? null : evalProp(src[k], f, this.fps)
    const rs = this.rasterScale(L)
    const key = rs + JSON.stringify(s) + this.env.fontEpoch
    return this.setCacheTex(L, 'text', key, () => {
      const lay = layoutText(s, rs)
      return { tex: lay.canvas ? canvasTexture(lay.canvas) : null, lay }
    })
  }

  // 描くための中身をそろえる。→ L.content(使い回し)または null
  content(L, f, stack) {
    const rect = this.rect(L, f)
    if (!rect) return null
    const C = L.content
    C.rect = rect; C.texture = null; C.uvRect = null; C.edge = false; C.multi = false; C.internalAdd = false
    C.toSrgb = false; C.temp = null; C.screen = false; C.tint = null; C.quad = null
    L.batch ??= new QuadBatch(1)
    switch (L.type) {
      case 'solid': {
        const c = toColor(evalProp(L.def.source?.color, f, this.fps), [1, 1, 1, 1])
        C.tint = [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
        C.edge = true
        break
      }
      case 'adjustment': C.edge = true; break
      case 'image': C.texture = this.imageEntry(L).tex; C.edge = true; break
      case 'video': {
        const v = this.videoState(L, f)
        if (!v) return null
        C.texture = v.tex; C.edge = true
        break
      }
      case 'shape': {
        const r = this.shapeRaster(L, f)
        if (!r.tex) return null
        C.texture = r.tex; C.quad = r.rect
        break
      }
      case 'text': {
        const r = this.textRaster(L, f)
        if (!r.tex) return null
        C.texture = r.tex
        C.multi = true
        fillTextBatch(L.batch, r.lay, L.def.source?.per_char, f - (L.def.in ?? 0), (L.def.out ?? this.duration) - (L.def.in ?? 0), L.id)
        break
      }
      case 'particles': {
        const kind = L.def.source?.emitter?.sprite || 'soft'
        const sp = this.env.sprite(kind)
        C.texture = sp
        C.multi = true
        C.internalAdd = (L.def.source?.emitter?.blend || 'add') === 'add'
        fillParticles(L.batch, L.def, f, this.fps)
        break
      }
      case 'comp': {
        const e = this.childScene(L)
        if (!e || !e.scene) return null
        if (stack.includes(e.id) || stack.length >= MAX_DEPTH) { this.warn('cycle' + L.id, `入れ子が循環している: comp ${e.id}`); return null }
        // 素材のコマは親の fps で数える → 子の fps のコマに直す
        const cf = (this.srcFrame(L, f) / this.fps) * e.scene.fps
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
        break
      }
      default: return null
    }
    return C
  }

  // 四隅の画面上の位置(コンポジションの px)。カメラの後ろへ回ったら null
  corners(L, f, rect) {
    const m = this.mvp(L, f) // 先に求める(中で作業用のベクトルを使う)
    const out = []
    const pts = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]]
    for (const p of pts) {
      _v4.set(p[0], p[1], 0, 1).applyMatrix4(m)
      if (_v4.w <= 1e-6) return null
      out.push([(_v4.x / _v4.w * 0.5 + 0.5) * this.W, (0.5 - _v4.y / _v4.w * 0.5) * this.H])
    }
    return out
  }

  maskData(L, f, rect) {
    const defs = L.def.masks
    if (!Array.isArray(defs) || !defs.length) return null
    const md = (L.cache.mask ??= { n: 0, length: 0, type: [], box: new Float32Array(MAX_MASKS * 4), param: new Float32Array(MAX_MASKS * 4), pts: null })
    const n = Math.min(defs.length, MAX_MASKS)
    if (defs.length > MAX_MASKS) this.warn('masks' + L.id, `マスクは ${MAX_MASKS} 個まで`)
    if (!md.pts || md.pts.length !== n * MASK_PTS * 2) md.pts = new Float32Array(n * MASK_PTS * 2)
    md.n = md.length = n
    for (let i = 0; i < n; i++) {
      const k = evalAll(defs[i], f, this.fps)
      const x = num(k.x, 0), y = num(k.y, 0), w = num(k.w, rect.w), h = num(k.h, rect.h)
      md.type[i] = k.shape === 'ellipse' ? 1 : k.shape === 'polygon' ? 2 : 0
      md.box.set([x, y, w, h], i * 4)
      let np = 0
      if (md.type[i] === 2) {
        const pts = Array.isArray(k.points) ? k.points.slice(0, MASK_PTS) : []
        np = pts.length
        for (let j = 0; j < np; j++) { md.pts[(i * MASK_PTS + j) * 2] = +pts[j][0] || 0; md.pts[(i * MASK_PTS + j) * 2 + 1] = +pts[j][1] || 0 }
        if (np < 3) md.type[i] = 0
      }
      md.param.set([Math.max(0, num(k.feather, 0)), k.invert ? 1 : 0, clamp(num(k.opacity, 100) / 100, 0, 1), np], i * 4)
    }
    return md
  }

  // 中身を target へ描く(変形・マスクつき)
  drawContent(target, L, C, f, opacity, blend) {
    const g = this.env.gfx
    const d = (this._draw ??= {})
    d.batch = L.batch; d.texture = C.texture; d.opacity = opacity; d.uvRect = C.uvRect; d.toSrgb = C.toSrgb
    d.masks = this.maskData(L, f, C.rect); d.maskOrigin = [C.rect.x, C.rect.y]
    if (C.screen) d.mvp = this.p2d
    else d.mvp = this.mvp(L, f)
    d.edge = C.edge
    if (!C.multi) {
      // 1 枚もの: 縁のアンチエイリアス用に、画面で 1.5px ぶん外へ広げて描く
      let pad = 0
      const r = C.quad || C.rect
      if (C.edge && !C.screen) {
        const q = this.corners(L, f, r)
        if (q) {
          const sx = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) / Math.max(1e-6, r.w)
          const sy = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) / Math.max(1e-6, r.h)
          const s = Math.min(sx, sy) * this.env.rs
          pad = s > 1e-4 ? Math.min(1.5 / s, 4096) : 0
        }
      }
      const t = C.tint
      L.batch.begin(1)
      L.batch.pushRect(r.x, r.y, r.w, r.h, 0, 0, 1, 1, t ? t[0] : 1, t ? t[1] : 1, t ? t[2] : 1, t ? t[3] : 1, pad)
      L.batch.end()
      if (!C.edge) d.uvRect = null
    }
    g.drawBatch(target, d, C.internalAdd && blend === 'normal' ? 'add' : blend)
  }
  releaseTemp(C) {
    if (C && C.temp) { this.env.gfx.release(C.temp); C.temp = null }
  }

  bufSize() { return [Math.round(this.W * this.env.rs), Math.round(this.H * this.env.rs)] }

  // レイヤーを画面大の RT に描く(エフェクト・マット・不透明度の前)。中身が無ければ null
  layerBuffer(L, f, stack) {
    const g = this.env.gfx
    const [bw, bh] = this.bufSize()
    if (L.def.motion_blur) {
      // 前後の小数コマを足し込む。8bit だと 1/N の刻みで荒れるので float の RT に積む
      const acc = g.acquire(bw, bh, { float: true })
      g.clear(acc)
      let drew = false
      const N = clamp(typeof L.def.motion_blur === 'number' ? Math.round(L.def.motion_blur) : MB_SAMPLES, 2, 64)
      for (let i = 0; i < N; i++) {
        const fs = f + ((i + 0.5) / N - 0.5) * MB_SHUTTER
        const C = this.content(L, fs, stack)
        if (!C) continue
        if (C.multi || C.internalAdd) {
          // 文字や粒は重なりがあるので、いったん 1 枚にしてから足す
          const one = g.acquire(bw, bh)
          g.clear(one)
          this.drawContent(one, L, C, fs, 1, 'normal')
          g.copy(one.texture, acc, 1 / N, 'sum')
          g.release(one)
        } else this.drawContent(acc, L, C, fs, 1 / N, 'sum')
        this.releaseTemp(C)
        drew = true
      }
      if (!drew) { g.release(acc); return null }
      const out = g.acquire(bw, bh)
      g.copy(acc.texture, out)
      g.release(acc)
      return out
    }
    const C = this.content(L, f, stack)
    if (!C) return null
    const buf = g.acquire(bw, bh)
    g.clear(buf)
    this.drawContent(buf, L, C, f, 1, 'normal')
    this.releaseTemp(C)
    return buf
  }
  fxInfo(L, f) {
    const rs = this.env.rs
    let b = [0, 0, this.W * rs, this.H * rs]
    if (L.type !== 'adjustment' && L.type !== 'model' && L.type !== 'particles') {
      const r = this.rect(L, f), q = r && this.corners(L, f, r)
      if (q) b = [Math.min(...q.map((p) => p[0])) * rs, Math.min(...q.map((p) => p[1])) * rs, Math.max(...q.map((p) => p[0])) * rs, Math.max(...q.map((p) => p[1])) * rs]
    }
    return { rs, bounds: b }
  }
  enabledFx(L) {
    const e = L.def.effects
    return Array.isArray(e) && e.some((x) => x && x.enabled !== false) ? e : null
  }
  // エフェクトまで掛けた RT(マット用にも使う)
  layerProcessed(L, f, stack) {
    let buf = this.layerBuffer(L, f, stack)
    if (!buf) return null
    const fx = this.enabledFx(L)
    if (fx) {
      const out = this.env.effects.run(fx, f, this.fps, buf, this.fxInfo(L, f))
      if (out !== buf) { this.env.gfx.release(buf); buf = out }
    }
    return buf
  }
  opacityOf(L, f) { return clamp(num(this.tr(L, 'opacity', f, 100), 100) / 100, 0, 1) }

  // レイヤーを acc に重ねる。背景を読むブレンドでは acc を作り直すので、新しい acc を返す
  drawLayer(acc, L, f, stack) {
    const g = this.env.gfx, def = L.def
    const op = this.opacityOf(L, f)
    if (op <= 0) return acc
    const blend = def.blend in SHADER_BLEND ? def.blend : 'normal'
    if (def.blend && !(def.blend in SHADER_BLEND)) this.warn('blend' + def.blend, `未対応のブレンド: ${def.blend}`)
    const fx = this.enabledFx(L)
    const matteL = def.matte?.layer != null ? this.layers.get(String(def.matte.layer)) : null
    const simple = !fx && !matteL && !def.motion_blur && isGlBlend(blend) && L.type !== 'model'
    if (simple) {
      const C = this.content(L, f, stack)
      if (!C) return acc
      // 重なりのある中身を半透明で直に描くと重なりが濃くなるので、そのときだけ 1 枚にまとめる
      if (!(C.multi && (op < 0.999 || (C.internalAdd && blend !== 'add')))) {
        this.drawContent(acc, L, C, f, op, blend)
        this.releaseTemp(C)
        return acc
      }
      this.releaseTemp(C)
    }
    let buf = this.layerProcessed(L, f, stack)
    if (!buf) return acc
    if (matteL) {
      let mb = this.inRange(matteL, f) ? this.layerProcessed(matteL, f, stack) : null
      const out = g.acquire(buf.width, buf.height)
      if (mb) {
        const mop = this.opacityOf(matteL, f)
        if (mop < 0.999) { const t = g.acquire(mb.width, mb.height); g.copy(mb.texture, t, mop); g.release(mb); mb = t }
        g.pass(this.env.matteMat, out, { tSrc: buf.texture, tMatte: mb.texture, uMode: MATTE_MODE[def.matte.mode] ?? 0 })
        g.release(mb)
      } else {
        // マットが無い区間: 反転なら全部見える、そうでなければ何も見えない
        const inv = def.matte.mode === 'alpha_inv' || def.matte.mode === 'luma_inv'
        if (inv) g.copy(buf.texture, out); else g.clear(out)
      }
      g.release(buf); buf = out
    }
    if (isGlBlend(blend)) g.copy(buf.texture, acc, op, blend)
    else {
      const out = g.acquire(acc.width, acc.height)
      g.pass(this.env.blendMat, out, { tBase: acc.texture, tSrc: buf.texture, uOpacity: op, uMode: SHADER_BLEND[blend] })
      g.release(acc); acc = out
    }
    g.release(buf)
    return acc
  }

  // 調整レイヤー: ここまでの合成結果にエフェクトを掛ける。範囲はレイヤーの箱・マスク・不透明度
  adjust(acc, L, f) {
    const g = this.env.gfx, def = L.def
    const fx = this.enabledFx(L)
    const op = this.opacityOf(L, f)
    if (!fx || op <= 0) return acc
    const fxed = this.env.effects.run(fx, f, this.fps, acc, this.fxInfo(L, f))
    if (fxed === acc) return acc
    const t = def.transform || {}
    const trivial = op >= 0.999 && !(def.masks && def.masks.length) && def.parent == null &&
      isDefaultConst(t.position, [this.W / 2, this.H / 2, 0]) && isDefaultConst(t.scale, [100]) &&
      (t.rotation == null || t.rotation === 0 || isDefaultConst(t.rotation, [0])) && isDefaultConst(t.anchor, [0])
    if (trivial) { g.release(acc); return fxed }
    const cov = g.acquire(acc.width, acc.height)
    g.clear(cov)
    const C = this.content(L, f, [])
    if (C) this.drawContent(cov, L, C, f, op, 'normal')
    const out = g.acquire(acc.width, acc.height)
    g.pass(this.env.mixMat, out, { tA: acc.texture, tB: fxed.texture, tM: cov.texture })
    g.release(cov); g.release(fxed); g.release(acc)
    return out
  }

  // 描く順(奥 → 手前)。連続する 3D レイヤーの塊の中だけ、カメラから遠い順に並べ替える
  drawList(f) {
    const list = (this._list ??= [])
    list.length = 0
    let group = []
    const flush = () => {
      if (group.length > 1) {
        for (const L of group) L._depth = this.viewDepth(L, f)
        group.sort((a, b) => b._depth - a._depth || a._ord - b._ord)
      }
      for (const L of group) list.push(L)
      group = []
    }
    for (let i = this.order.length - 1, ord = 0; i >= 0; i--) {
      const L = this.order[i]
      if (!DRAWABLE.has(L.type) || !this.active(L, f) || this.matteSources.has(L.id)) continue
      L._ord = ord++
      if (this.is3d(L) && L.type !== 'adjustment') group.push(L)
      else { flush(); list.push(L) }
    }
    flush()
    return list
  }

  // 非同期の素材を読み始める(capture ではこれで積まれた Promise を待つ)
  prepare(f, stack = []) {
    const env = this.env
    for (const L of this.order) {
      const isMatte = this.matteSources.has(L.id)
      if (!(isMatte ? this.inRange(L, f) : this.active(L, f))) continue
      const s = L.def.source || {}
      try {
        if (L.type === 'image') this.imageEntry(L)
        else if (L.type === 'video') this.videoState(L, f, false)
        else if (L.type === 'text') env.font(fontSpec(s, 32), String(evalProp(s.text, f, this.fps) ?? ''))
        else if (L.type === 'model') env.models.prepare(this, L)
        else if (L.type === 'comp' && s.comp_id != null) {
          const e = env.comps.get(s.comp_id)
          if (e.scene && !stack.includes(e.id) && stack.length < MAX_DEPTH) {
            e.scene.prepare((this.srcFrame(L, f) / this.fps) * e.scene.fps, [...stack, e.id])
          }
        }
      } catch (err) { this.warn('prep' + L.id, 'prepare', L.id, err) }
    }
  }

  render(f, stack = []) {
    const g = this.env.gfx
    const [bw, bh] = this.bufSize()
    let acc = g.acquire(bw, bh)
    g.clear(acc)
    const bg = this.comp.data?.bg
    if (bg) { const c = toColor(bg, [0, 0, 0, 1]); g.fill(acc, c[0], c[1], c[2], 1) }
    for (const L of this.drawList(f).slice()) {
      try {
        acc = L.type === 'adjustment' ? this.adjust(acc, L, f) : this.drawLayer(acc, L, f, stack)
      } catch (err) { this.warn('draw' + L.id, `レイヤー ${L.id} を描けない:`, err) }
    }
    return acc
  }

  // ---- 編集画面むけ ----
  bounds(id, f) {
    const L = this.layers.get(String(id))
    if (!L || L.type === 'camera') return null
    const rect = this.rect(L, f)
    if (!rect) return null
    const corners = this.corners(L, f, rect)
    if (!corners) return null
    const an = vec(this.tr(L, 'anchor', f, 0), 3, 0)
    const mvp = this.mvp(L, f)
    _v4.set(an[0], an[1], an[2], 1).applyMatrix4(mvp)
    const anchor = _v4.w > 1e-6 ? [(_v4.x / _v4.w * 0.5 + 0.5) * this.W, (0.5 - _v4.y / _v4.w * 0.5) * this.H] : null
    return { corners, anchor, three_d: this.is3d(L) }
  }
  pick(x, y, f) {
    const list = this.drawList(f)
    for (let i = list.length - 1; i >= 0; i--) {
      const L = list[i]
      if (L.def.locked || L.type === 'adjustment') continue
      if (this.opacityOf(L, f) <= 0) continue
      const rect = this.rect(L, f)
      const q = rect && this.corners(L, f, rect)
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
      const cam = this.camera(f)
      const k = Math.max(1e-3, this.viewDepth(L, f)) / cam.zoom
      d.set(dx * k, dy * k, 0).applyMatrix4(_m2.copy(cam.world).setPosition(0, 0, 0))
    } else d.set(dx, dy, 0)
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
