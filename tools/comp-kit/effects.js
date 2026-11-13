// エフェクト。どれも「画面と同じ大きさの RT → 新しい RT」の全画面パス(乗算済みアルファ)。
// 長さの単位はコンポジションの px(プレビューの縮小表示では rs を掛けて合わせる)。
// 角度は AE と同じく 0° = 上、時計回り。
import { evalAll, num, toColor, clamp } from './props.js'
import { THREE } from './gfx.js'

const HEAD = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uRes; varying vec2 vUv;
vec2 P(){ return vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y); }
vec4 S(vec2 p){ return texture2D(tSrc, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)); }
vec3 unpm(vec4 c){ return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`
const F = {
  blur: HEAD + /* glsl */ `
    uniform vec2 uDir; uniform float uSigma;
    void main(){
      vec2 p = P(); vec4 acc = vec4(0.0); float wsum = 0.0;
      float k = min(ceil(uSigma * 2.6), 16.0);
      for (float i = -16.0; i <= 16.0; i += 1.0){
        if (abs(i) > k) continue;
        float w = exp(-0.5 * i * i / (uSigma * uSigma));
        acc += S(p + uDir * i) * w; wsum += w;
      }
      gl_FragColor = acc / wsum;
    }`,
  bright: HEAD + /* glsl */ `
    uniform float uThreshold;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      float l = luma(unpm(c));
      gl_FragColor = c * smoothstep(uThreshold - 0.05, uThreshold + 0.15, l + 1e-4);
    }`,
  glowAdd: HEAD + /* glsl */ `
    uniform sampler2D tGlow; uniform float uStrength;
    void main(){
      vec4 c = texture2D(tSrc, vUv), g = texture2D(tGlow, vUv) * uStrength;
      vec3 rgb = c.rgb + g.rgb;
      float a = clamp(max(c.a + g.a * (1.0 - c.a), max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0);
      gl_FragColor = vec4(min(rgb, vec3(a)), a);
    }`,
  color: HEAD + /* glsl */ `
    uniform float uBrightness, uContrast, uSaturation, uHue, uTintAmount; uniform vec3 uTint;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      vec3 x = unpm(c);
      if (abs(uHue) > 1e-4){
        float cs = cos(uHue), sn = sin(uHue); vec3 k = vec3(0.57735);
        x = x * cs + cross(k, x) * sn + k * dot(k, x) * (1.0 - cs);
      }
      float l = luma(x);
      x = mix(vec3(l), x, uSaturation);
      x = (x - 0.5) * uContrast + 0.5 + uBrightness;
      x = mix(x, uTint * luma(clamp(x, 0.0, 1.0)) , uTintAmount);
      gl_FragColor = vec4(clamp(x, 0.0, 1.0) * c.a, c.a);
    }`,
  rgb_shift: HEAD + /* glsl */ `
    uniform vec2 uOff;
    void main(){
      vec2 p = P();
      vec4 a = S(p + uOff), b = S(p), c = S(p - uOff);
      gl_FragColor = vec4(a.r, b.g, c.b, max(b.a, max(a.a, c.a)));
    }`,
  wave: HEAD + /* glsl */ `
    uniform float uAmp, uFreq, uPhase, uVertical;
    void main(){
      vec2 p = P();
      if (uVertical > 0.5) p.y += uAmp * sin(6.2831853 * (p.x / uRes.x * uFreq + uPhase));
      else p.x += uAmp * sin(6.2831853 * (p.y / uRes.y * uFreq + uPhase));
      gl_FragColor = S(p);
    }`,
  noise: HEAD + /* glsl */ `
    uniform float uAmount, uSeed, uColorNoise;
    float h(vec2 p, float s){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + s * 0.6180339); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      vec2 p = floor(P());
      vec3 n = vec3(h(p, uSeed));
      if (uColorNoise > 0.5) n = vec3(n.x, h(p + 17.0, uSeed + 3.0), h(p + 41.0, uSeed + 7.0));
      vec3 x = unpm(c) + (n - 0.5) * uAmount;
      gl_FragColor = vec4(clamp(x, 0.0, 1.0) * c.a, c.a);
    }`,
  mosaic: HEAD + /* glsl */ `
    uniform float uSize;
    void main(){ vec2 p = P(); gl_FragColor = S((floor(p / uSize) + 0.5) * uSize); }`,
  wipe: HEAD + /* glsl */ `
    uniform vec2 uDir; uniform float uProgress, uFeather; uniform vec4 uBounds;
    void main(){
      vec2 p = P();
      // 範囲の四隅を進む向きへ射影して、端から端までを 0〜1 にする
      vec2 c = (uBounds.xy + uBounds.zw) * 0.5, hsz = (uBounds.zw - uBounds.xy) * 0.5;
      float ext = abs(uDir.x) * hsz.x + abs(uDir.y) * hsz.y;
      float s = dot(p - c, uDir) + ext;
      float edge = uProgress * (2.0 * ext + uFeather) - uFeather;
      float m = uFeather > 1e-3 ? clamp((s - edge) / uFeather, 0.0, 1.0) : step(edge, s);
      if (uProgress <= 0.0) m = 1.0;
      gl_FragColor = texture2D(tSrc, vUv) * m;
    }`,
  shadow: HEAD + /* glsl */ `
    uniform sampler2D tBlur; uniform vec2 uOff; uniform vec4 uColor;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      vec2 p = P() - uOff;
      float a = texture2D(tBlur, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)).a * uColor.a;
      gl_FragColor = c + vec4(uColor.rgb * a, a) * (1.0 - c.a);
    }`,
  stroke_outline: HEAD + /* glsl */ `
    uniform float uWidth; uniform vec4 uColor;
    void main(){
      vec2 p = P(); vec4 c = S(p); float a = c.a;
      for (float i = 0.0; i < 16.0; i += 1.0){
        float t = i * 0.3926991; vec2 d = vec2(cos(t), sin(t));
        a = max(a, S(p + d * uWidth).a);
        a = max(a, S(p + d * uWidth * 0.5).a);
      }
      a *= uColor.a;
      gl_FragColor = c + vec4(uColor.rgb * a, a) * (1.0 - c.a);
    }`,
  half: HEAD + /* glsl */ `void main(){ gl_FragColor = texture2D(tSrc, vUv); }`,
}

const D2R = Math.PI / 180
const dirOf = (deg) => [Math.sin(deg * D2R), -Math.cos(deg * D2R)]
const pct = (v, d) => { const x = num(v, d); return x > 1.0001 ? x / 100 : x } // 0〜1 でも 0〜100 でも受ける

export class Effects {
  constructor(gfx) {
    this.g = gfx
    this.mats = {}
    this.warned = new Set()
    this.v2 = new THREE.Vector2()
  }
  mat(name, extra) {
    return (this.mats[name] ??= this.g.passMaterial('fx_' + name, F[name], { tSrc: null, uRes: new THREE.Vector2(), ...extra }))
  }
  run1(name, extra, src, values, dstW, dstH) {
    const dst = this.g.acquire(dstW ?? src.width, dstH ?? src.height)
    const m = this.mat(name, extra)
    m.uniforms.uRes.value.set(src.width, src.height)
    this.g.pass(m, dst, { tSrc: src.texture, ...values })
    return dst
  }

  // ガウスぼかし。大きい半径は縮小してから掛ける(ソフトウェア GL でも重くならないように)
  blur(src, radius, dirX = 1, dirY = 1) {
    const g = this.g
    if (!(radius > 0.05)) { const d = g.acquire(src.width, src.height); g.copy(src.texture, d); return d }
    let ds = 1
    while (radius / 2 / ds > 3.5 && ds < 16) ds *= 2
    let cur = src, own = false
    for (let s = 2; s <= ds; s *= 2) {
      const nx = g.acquire(Math.ceil(src.width / s), Math.ceil(src.height / s))
      g.copy(cur.texture, nx)
      if (own) g.release(cur)
      cur = nx; own = true
    }
    const sigma = Math.max(0.3, radius / 2 / ds)
    const extra = { uDir: new THREE.Vector2(), uSigma: 1 }
    if (dirX > 0) {
      const a = this.run1('blur', extra, cur, { uDir: this.v2.set(dirX, 0), uSigma: sigma })
      if (own) g.release(cur)
      cur = a; own = true
    }
    if (dirY > 0) {
      const b = this.run1('blur', extra, cur, { uDir: this.v2.set(0, dirY), uSigma: sigma })
      if (own) g.release(cur)
      cur = b; own = true
    }
    if (cur.width !== src.width || cur.height !== src.height) {
      const up = g.acquire(src.width, src.height)
      g.copy(cur.texture, up)
      g.release(cur)
      cur = up
    }
    return cur
  }

  // 1 つ掛ける。src は解放しない。新しい RT を返す(効かないときは null)
  apply(fx, f, fps, src, info) {
    const p = evalAll(fx.params, f, fps)
    const rs = info.rs, g = this.g
    switch (fx.type) {
      case 'blur': {
        const r = num(p.radius, 10) * rs
        const dir = p.direction // 'h' | 'v' で片方向だけ
        return this.blur(src, r, dir === 'v' ? 0 : 1, dir === 'h' ? 0 : 1)
      }
      case 'glow': {
        const b = this.run1('bright', { uThreshold: 0 }, src, { uThreshold: pct(p.threshold, 0.5) })
        const bl = this.blur(b, num(p.radius, 20) * rs)
        g.release(b)
        const out = this.run1('glowAdd', { tGlow: null, uStrength: 1 }, src, { tGlow: bl.texture, uStrength: num(p.strength, 1) })
        g.release(bl)
        return out
      }
      case 'color': {
        const tint = p.tint != null ? toColor(p.tint) : null
        const m = this.mat('color', { uBrightness: 0, uContrast: 1, uSaturation: 1, uHue: 0, uTintAmount: 0, uTint: new THREE.Vector3(1, 1, 1) })
        return this.run1('color', null, src, {
          uBrightness: num(p.brightness, 0) / 100, uContrast: Math.max(0, 1 + num(p.contrast, 0) / 100),
          uSaturation: Math.max(0, 1 + num(p.saturation, 0) / 100), uHue: num(p.hue, 0) * D2R,
          uTintAmount: tint ? clamp(num(p.tint_amount, 100) / 100, 0, 1) : 0,
          uTint: m.uniforms.uTint.value.set(...(tint || [1, 1, 1]).slice(0, 3)),
        })
      }
      case 'rgb_shift': {
        const d = dirOf(num(p.angle, 90)), a = num(p.amount, 4) * rs
        return this.run1('rgb_shift', { uOff: new THREE.Vector2() }, src, { uOff: this.v2.set(d[0] * a, d[1] * a) })
      }
      case 'wave':
        return this.run1('wave', { uAmp: 0, uFreq: 1, uPhase: 0, uVertical: 0 }, src, {
          uAmp: num(p.amp, 10) * rs, uFreq: num(p.freq, 4), uPhase: num(p.speed, 1) * (f / fps) + num(p.phase, 0),
          uVertical: p.direction === 'v' ? 1 : 0,
        })
      case 'noise':
        return this.run1('noise', { uAmount: 0, uSeed: 0, uColorNoise: 0 }, src, {
          uAmount: num(p.amount, 10) / 100, uSeed: (p.animated === false ? 0 : Math.round(f * 8) % 4096) + num(p.seed, 0), uColorNoise: p.color ? 1 : 0,
        })
      case 'mosaic':
        return this.run1('mosaic', { uSize: 8 }, src, { uSize: Math.max(1, num(p.size, 16) * rs) })
      case 'wipe': {
        const d = dirOf(num(p.angle, 90)), b = info.bounds
        const m = this.mat('wipe', { uDir: new THREE.Vector2(), uProgress: 0, uFeather: 0, uBounds: new THREE.Vector4() })
        return this.run1('wipe', null, src, {
          uDir: this.v2.set(d[0], d[1]), uProgress: clamp(num(p.progress, 0) / 100, 0, 1), uFeather: Math.max(0, num(p.feather, 0) * rs),
          uBounds: m.uniforms.uBounds.value.set(b[0], b[1], b[2], b[3]),
        })
      }
      case 'drop_shadow': {
        const bl = this.blur(src, num(p.blur, 12) * rs)
        const d = dirOf(num(p.angle, 135)), dist = num(p.distance, 12) * rs
        const c = toColor(p.color ?? '#000000'), op = clamp(num(p.opacity, 60) / 100, 0, 1) * c[3]
        const m = this.mat('shadow', { tBlur: null, uOff: new THREE.Vector2(), uColor: new THREE.Vector4() })
        const out = this.run1('shadow', null, src, {
          tBlur: bl.texture, uOff: this.v2.set(d[0] * dist, d[1] * dist), uColor: m.uniforms.uColor.value.set(c[0], c[1], c[2], op),
        })
        g.release(bl)
        return out
      }
      case 'stroke_outline': {
        const c = toColor(p.color ?? '#000000')
        const m = this.mat('stroke_outline', { uWidth: 1, uColor: new THREE.Vector4() })
        return this.run1('stroke_outline', null, src, { uWidth: Math.max(0, num(p.width, 4) * rs), uColor: m.uniforms.uColor.value.set(c[0], c[1], c[2], c[3]) })
      }
      default:
        if (!this.warned.has(fx.type)) { this.warned.add(fx.type); console.warn(`[comp-engine] 未対応のエフェクト: ${fx.type}`) }
        return null
    }
  }

  // list を順に掛ける。src は呼び出し側の持ち物のまま。何も掛からなければ src をそのまま返す
  run(list, f, fps, src, info) {
    let cur = src
    for (const fx of list) {
      if (!fx || fx.enabled === false) continue
      let out = null
      try { out = this.apply(fx, f, fps, cur, info) } catch (err) { console.warn('[comp-engine] effect', fx.type, err) }
      if (!out) continue
      if (cur !== src) this.g.release(cur)
      cur = out
    }
    return cur
  }
}
