// GL まわりの土台: レンダーターゲットの使い回し、全画面パス、四角形のまとめ描き(QuadBatch)、
// レイヤー用シェーダ。内部はすべて乗算済みアルファ(premultiplied)で、色は sRGB の値をそのまま運ぶ。
import * as THREE from './three.module.min.js'

export const MAX_MASKS = 4
export const MASK_PTS = 24 // 1 マスクあたりの多角形の頂点数の上限

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

// ---- レイヤー用シェーダ ---------------------------------------------------
const LAYER_VERT = /* glsl */ `
attribute vec2 aQuad;
attribute vec4 aColor;
uniform mat4 uMVP;
varying vec2 vUv; varying vec2 vQuad; varying vec4 vColor; varying vec2 vLayer;
void main(){
  vUv = uv; vQuad = aQuad; vColor = aColor; vLayer = position.xy;
  gl_Position = uMVP * vec4(position, 1.0);
}`
const LAYER_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
uniform float uEdge;      // 1 = 四角形の縁を解析的にアンチエイリアス
uniform vec4 uUvRect;     // uEdge のときのテクスチャ範囲 (u0,v0,u1,v1)
uniform float uToSrgb;    // 1 = リニア → sRGB(モデル用)
varying vec2 vUv; varying vec2 vQuad; varying vec4 vColor; varying vec2 vLayer;
#if NUM_MASKS > 0
uniform vec2 uMaskOrigin;
uniform int uMaskType[NUM_MASKS];     // 0 rect / 1 ellipse / 2 polygon
uniform vec4 uMaskBox[NUM_MASKS];     // x,y,w,h
uniform vec4 uMaskParam[NUM_MASKS];   // feather, invert, opacity, 頂点数
uniform vec2 uMaskPts[NUM_MASKS * ${MASK_PTS}];
float sdPoly(int off, int n, vec2 p){
  vec2 v0 = uMaskPts[off];
  float d = dot(p - v0, p - v0); float s = 1.0;
  int j = n - 1;
  for (int i = 0; i < ${MASK_PTS}; i++){
    if (i >= n) break;
    vec2 vi = uMaskPts[off + i], vj = uMaskPts[off + j];
    vec2 e = vj - vi, w = p - vi;
    vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-9), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
    j = i;
  }
  return s * sqrt(d);
}
float maskAt(int i, vec2 p, float px){
  vec4 box = uMaskBox[i]; vec4 prm = uMaskParam[i];
  float sd;
  if (uMaskType[i] == 0){
    vec2 q = abs(p - (box.xy + box.zw * 0.5)) - box.zw * 0.5;
    sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  } else if (uMaskType[i] == 1){
    vec2 r = max(box.zw * 0.5, vec2(1e-3));
    vec2 q = p - (box.xy + r);
    float k0 = length(q / r), k1 = length(q / (r * r));
    sd = k1 > 1e-9 ? k0 * (k0 - 1.0) / k1 : -min(r.x, r.y);
  } else {
    sd = sdPoly(i * ${MASK_PTS}, int(prm.w + 0.5), p);
  }
  float m = clamp(0.5 - sd / max(prm.x, px), 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  if (prm.y > 0.5) m = 1.0 - m;
  return m * prm.z;
}
#endif
void main(){
  vec2 uv = vUv; float cov = 1.0;
  if (uEdge > 0.5){
    vec2 fw = max(fwidth(vQuad), vec2(1e-7));
    vec2 a = clamp(vQuad / fw + 0.502, 0.0, 1.0) * clamp((1.0 - vQuad) / fw + 0.502, 0.0, 1.0);
    cov = a.x * a.y;
    uv = mix(uUvRect.xy, uUvRect.zw, clamp(vQuad, 0.0, 1.0));
  }
  vec4 c = texture2D(uMap, uv);
  if (uToSrgb > 0.5){
    vec3 l = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    l = mix(l * 12.92, 1.055 * pow(max(l, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, l));
    c = vec4(clamp(l, 0.0, 1.0) * c.a, c.a);
  }
  c *= vColor * (uOpacity * cov);
#if NUM_MASKS > 0
  vec2 mp = vLayer - uMaskOrigin;
  float px = max(length(fwidth(vLayer)) * 0.7071, 1e-4);
  float m = 1.0;
  for (int i = 0; i < NUM_MASKS; i++) m *= maskAt(i, mp, px);
  c *= m;
#endif
  gl_FragColor = c;
}`

// GL の合成だけで済むブレンド(背景を読まない)
const GL_BLEND = {
  none: null,
  normal: [THREE.OneFactor, THREE.OneMinusSrcAlphaFactor, THREE.OneFactor, THREE.OneMinusSrcAlphaFactor],
  add: [THREE.OneFactor, THREE.OneFactor, THREE.OneFactor, THREE.OneMinusSrcAlphaFactor],
  screen: [THREE.OneFactor, THREE.OneMinusSrcColorFactor, THREE.OneFactor, THREE.OneMinusSrcAlphaFactor],
  sum: [THREE.OneFactor, THREE.OneFactor, THREE.OneFactor, THREE.OneFactor], // モーションブラーの足し込み
}
export const isGlBlend = (mode) => mode in GL_BLEND && mode !== 'none' && mode !== 'sum'

function applyBlend(mat, mode) {
  const b = GL_BLEND[mode]
  if (!b) { mat.blending = THREE.NoBlending; return }
  mat.blending = THREE.CustomBlending
  mat.blendEquation = THREE.AddEquation
  mat.blendSrc = b[0]; mat.blendDst = b[1]; mat.blendSrcAlpha = b[2]; mat.blendDstAlpha = b[3]
}

// ---- 四角形のまとめ描き ---------------------------------------------------
// 1 レイヤーの中身 = 四角形の集まり(単一画像なら 1 枚、テキストは文字ごと、粒子は粒ごと)。
export class QuadBatch {
  constructor(capacity = 1) {
    this.capacity = 0
    this.count = 0
    this.geometry = null
    this._grow(capacity)
  }
  _grow(n) {
    const cap = Math.max(1, n)
    this.geometry?.dispose()
    const g = new THREE.BufferGeometry()
    this.pos = new Float32Array(cap * 12)
    this.uv = new Float32Array(cap * 8)
    this.quad = new Float32Array(cap * 8)
    this.col = new Float32Array(cap * 16)
    const idx = cap * 4 > 65535 ? new Uint32Array(cap * 6) : new Uint16Array(cap * 6)
    for (let i = 0; i < cap; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6)
    const dyn = (arr, n2) => { const a = new THREE.BufferAttribute(arr, n2); a.setUsage(THREE.DynamicDrawUsage); return a }
    g.setAttribute('position', dyn(this.pos, 3))
    g.setAttribute('uv', dyn(this.uv, 2))
    g.setAttribute('aQuad', dyn(this.quad, 2))
    g.setAttribute('aColor', dyn(this.col, 4))
    g.setIndex(new THREE.BufferAttribute(idx, 1))
    this.geometry = g
    this.capacity = cap
  }
  begin(n) {
    if (n > this.capacity) this._grow(Math.ceil(n * 1.25))
    this.count = 0
  }
  // p: 四隅 [TL, TR, BR, BL] の xyz(12 個の数)。uv: (u0,v0)=TL 側, (u1,v1)=BR 側。
  // q: 四角形の中での位置(縁 AA 用。0〜1 の外へ出してよい)。c: 乗算済みの色
  push(p, u0, v0, u1, v1, q0x, q0y, q1x, q1y, r, g, b, a) {
    const i = this.count++
    this.pos.set(p, i * 12)
    this.uv.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8)
    this.quad.set([q0x, q0y, q1x, q0y, q1x, q1y, q0x, q1y], i * 8)
    const c = this.col, o = i * 16
    for (let k = 0; k < 4; k++) { c[o + k * 4] = r; c[o + k * 4 + 1] = g; c[o + k * 4 + 2] = b; c[o + k * 4 + 3] = a }
  }
  // 軸に平行な 1 枚(レイヤー空間の矩形)
  pushRect(x, y, w, h, u0, v0, u1, v1, r = 1, g = 1, b = 1, a = 1, pad = 0, z = 0) {
    const px = w > 0 ? pad / w : 0, py = h > 0 ? pad / h : 0
    _p[0] = x - pad; _p[1] = y - pad; _p[2] = z
    _p[3] = x + w + pad; _p[4] = y - pad; _p[5] = z
    _p[6] = x + w + pad; _p[7] = y + h + pad; _p[8] = z
    _p[9] = x - pad; _p[10] = y + h + pad; _p[11] = z
    this.push(_p, u0, v0, u1, v1, -px, -py, 1 + px, 1 + py, r, g, b, a)
  }
  end() {
    const g = this.geometry
    for (const k of ['position', 'uv', 'aQuad', 'aColor']) {
      const at = g.attributes[k]
      at.clearUpdateRanges?.()
      at.addUpdateRange?.(0, this.count * at.itemSize * 4)
      at.needsUpdate = true
    }
    g.setDrawRange(0, this.count * 6)
  }
  dispose() { this.geometry?.dispose(); this.geometry = null }
}
const _p = new Float32Array(12)

// ---- 本体 -----------------------------------------------------------------
export class Gfx {
  constructor(renderer) {
    this.r = renderer
    this.pool = new Map() // "wxhxtype" → 空いている RT の配列
    this.live = 0
    this.scene = new THREE.Scene()
    this.cam = new THREE.Camera()
    const tri = new THREE.BufferGeometry()
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
    this.tri = tri
    this.mesh = new THREE.Mesh(tri, undefined)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
    this.passMats = new Map()
    this.layerMats = new Map()
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
    white.needsUpdate = true
    this.white = white
    const gl = renderer.getContext()
    this.halfFloat = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))
    this.copyMat = this.passMaterial('copy', /* glsl */ `
      uniform sampler2D tSrc; uniform float uMul; varying vec2 vUv;
      void main(){ gl_FragColor = texture2D(tSrc, vUv) * uMul; }`, { tSrc: null, uMul: 1 })
    this.fillMat = this.passMaterial('fill', /* glsl */ `
      uniform vec4 uColor; void main(){ gl_FragColor = uColor; }`, { uColor: new THREE.Vector4() })
  }

  // ---- レンダーターゲットの使い回し ----
  acquire(w, h, opts = {}) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h))
    const type = opts.float && this.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType
    const key = `${w}x${h}x${type}x${opts.depth ? 'd' : ''}${opts.samples || 0}`
    const list = this.pool.get(key)
    let rt = list && list.pop()
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: !!opts.depth, stencilBuffer: false, type, samples: opts.samples || 0,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      })
      rt.__key = key
    }
    this.live++
    return rt
  }
  release(rt) {
    if (!rt) return
    this.live--
    let list = this.pool.get(rt.__key)
    if (!list) this.pool.set(rt.__key, (list = []))
    list.push(rt)
  }
  // 使われていない RT を捨てる(大きさが変わったときなど)
  trim() {
    for (const list of this.pool.values()) { for (const rt of list) rt.dispose(); list.length = 0 }
  }

  clear(rt) {
    const r = this.r
    r.setRenderTarget(rt)
    r.setScissorTest(false)
    r.setClearColor(0x000000, 0)
    r.clear(true, true, false)
  }

  // ---- 全画面パス ----
  passMaterial(name, frag, uniforms) {
    let m = this.passMats.get(name)
    if (m) return m
    const u = {}
    for (const k of Object.keys(uniforms)) u[k] = { value: uniforms[k] }
    m = new THREE.ShaderMaterial({
      name, vertexShader: FS_VERT, fragmentShader: frag, uniforms: u,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    })
    this.passMats.set(name, m)
    return m
  }
  // mat を target(null = キャンバス)へ全画面で描く。blend を渡すと GL の合成を使う
  pass(mat, target, values, blend = 'none') {
    if (values) for (const k in values) mat.uniforms[k].value = values[k]
    applyBlend(mat, blend)
    this.mesh.geometry = this.tri
    this.mesh.material = mat
    this.r.setRenderTarget(target)
    this.r.render(this.scene, this.cam)
  }
  copy(srcTex, target, mul = 1, blend = 'none') {
    this.pass(this.copyMat, target, { tSrc: srcTex, uMul: mul }, blend)
  }
  fill(target, r, g, b, a) {
    this.fillMat.uniforms.uColor.value.set(r, g, b, a)
    this.pass(this.fillMat, target, null)
  }

  // ---- レイヤーの四角形 ----
  layerMaterial(nMasks) {
    let m = this.layerMats.get(nMasks)
    if (m) return m
    const uniforms = {
      uMap: { value: this.white }, uMVP: { value: new THREE.Matrix4() }, uOpacity: { value: 1 },
      uEdge: { value: 0 }, uUvRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uToSrgb: { value: 0 },
    }
    if (nMasks > 0) {
      uniforms.uMaskOrigin = { value: new THREE.Vector2() }
      uniforms.uMaskType = { value: new Array(nMasks).fill(0) }
      uniforms.uMaskBox = { value: Array.from({ length: nMasks }, () => new THREE.Vector4()) }
      uniforms.uMaskParam = { value: Array.from({ length: nMasks }, () => new THREE.Vector4()) }
      uniforms.uMaskPts = { value: new Float32Array(nMasks * MASK_PTS * 2) }
    }
    m = new THREE.ShaderMaterial({
      name: `layer${nMasks}`, vertexShader: LAYER_VERT, fragmentShader: LAYER_FRAG, uniforms,
      defines: { NUM_MASKS: nMasks }, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
    })
    this.layerMats.set(nMasks, m)
    return m
  }
  // d: {batch, texture, mvp(Matrix4), opacity, edge, uvRect:[u0,v0,u1,v1], masks, maskOrigin, toSrgb}
  drawBatch(target, d, blend = 'normal') {
    if (!d.batch.count) return
    const masks = d.masks && d.masks.length ? d.masks : null
    const mat = this.layerMaterial(masks ? masks.n : 0)
    const u = mat.uniforms
    u.uMap.value = d.texture || this.white
    u.uMVP.value.copy(d.mvp)
    u.uOpacity.value = d.opacity ?? 1
    u.uEdge.value = d.edge ? 1 : 0
    u.uToSrgb.value = d.toSrgb ? 1 : 0
    const r = d.uvRect
    if (r) u.uUvRect.value.set(r[0], r[1], r[2], r[3]); else u.uUvRect.value.set(0, 0, 1, 1)
    if (masks) {
      u.uMaskOrigin.value.set(d.maskOrigin[0], d.maskOrigin[1])
      for (let i = 0; i < masks.n; i++) {
        u.uMaskType.value[i] = masks.type[i]
        u.uMaskBox.value[i].fromArray(masks.box, i * 4)
        u.uMaskParam.value[i].fromArray(masks.param, i * 4)
      }
      u.uMaskPts.value.set(masks.pts)
    }
    applyBlend(mat, blend)
    this.mesh.geometry = d.batch.geometry
    this.mesh.material = mat
    this.r.setRenderTarget(target)
    this.r.render(this.scene, this.cam)
  }

  dispose() {
    this.trim()
    for (const m of this.passMats.values()) m.dispose()
    for (const m of this.layerMats.values()) m.dispose()
    this.tri.dispose()
    this.white.dispose()
  }
}

export { THREE }
