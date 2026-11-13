// 模様(パターン)。レイヤー用シェーダの中で式から描くので、どの拡大率でもくっきり出る。
//   pattern レイヤー / solid・shape・text の fill: {"pattern": {...}} で使う。
// 座標はレイヤー空間の px(原点 = レイヤーの中心)。offset を動かすと流れる。
import { num, vec, toColor, clamp } from './props.js'

// kind → {id, 既定値}。別名は alias で引く
export const PATTERN_KINDS = {
  stripes: { id: 1, size: 40 },
  checker: { id: 2, size: 60 },
  dots: { id: 3, size: 40 },
  grid: { id: 4, size: 60, line_width: 3 },
  hex: { id: 5, size: 80, line_width: 4 },
  triangles: { id: 6, size: 80, ratio: 0.8660254 },
  uroko: { id: 6, size: 80, ratio: 1 },
  yagasuri: { id: 7, size: 80, ratio: 1 },
  asanoha: { id: 8, size: 120, line_width: 3 },
  seigaiha: { id: 9, size: 80, line_width: 0 },
  shippo: { id: 10, size: 100, line_width: 3 },
  kagome: { id: 11, size: 80, line_width: 5 },
  halftone: { id: 12, size: 24 },
  rays: { id: 13, size: 100, ratio: 0.5 },
  concentric: { id: 14, size: 40 },
  waves: { id: 15, size: 40 },
  noise: { id: 16, size: 200 },
  grain: { id: 17, size: 1 },
  zigzag: { id: 18, size: 60, ratio: 0.5 },
  gradient: { id: 19, size: 1080 },
}
const ALIAS = { ichimatsu: 'checker', polka: 'dots', sunburst: 'rays', chevron: 'zigzag', paper: 'grain', stripe: 'stripes', hexagon: 'hex', ring: 'concentric', rings: 'concentric', wave: 'waves' }
export const patternKind = (k) => PATTERN_KINDS[ALIAS[k] || k] ? (ALIAS[k] || k) : 'stripes'

const COMMON = /* glsl */ `
uniform vec4 uPC[4];   // 色(乗算済み)
uniform vec4 uPA;      // size, line_width, softness, ratio
uniform vec4 uPB;      // cos, sin, offset.x, offset.y
uniform vec4 uPE;      // kind ごとの追加
uniform vec4 uPF;
uniform float uPN;     // 色の数
vec4 PCOL(float i){
  float k = mod(i, uPN);
  return k < 0.5 ? uPC[0] : k < 1.5 ? uPC[1] : k < 2.5 ? uPC[2] : uPC[3];
}
float PAA(float d, float w){ return clamp(0.5 - d / w, 0.0, 1.0); }
float PH(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float PVN(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(PH(i), PH(i + vec2(1.0, 0.0)), f.x), mix(PH(i + vec2(0.0, 1.0)), PH(i + vec2(1.0, 1.0)), f.x), f.y);
}
// 帯を色の順に並べる(x = 帯の番号つきの座標、s = 帯の幅 px)
vec4 PBANDS(float x, float s, float w){
  float i = floor(x), f = x - i;
  float nb = f < 0.5 ? i - 1.0 : i + 1.0;
  float d = (f < 0.5 ? f : 1.0 - f) * s;
  return mix(PCOL(i), PCOL(nb), clamp(0.5 - d / w, 0.0, 0.5));
}
`
const BODY = {
  // 1 stripes: x 方向に帯が並ぶ。line_width > 0 なら色 0 の上に色 1 の線
  1: `
    if (lw > 0.0) { float f = abs(fract(p.x / s + 0.5) - 0.5) * s; return mix(uPC[0], uPC[1], PAA(f - lw * 0.5, w)); }
    return PBANDS(p.x / s, s, w);`,
  // 2 checker(市松)
  2: `
    vec2 t = abs(fract(p / s * 0.5 + 0.25) * 2.0 - 1.0);
    vec2 sd = clamp((0.5 - t) * s / w, -0.5, 0.5) * 2.0;
    return mix(uPC[0], uPC[1], 0.5 - 0.5 * sd.x * sd.y);`,
  // 3 dots: uPE.x = 1 で 1 行おきに半分ずらす
  3: `
    vec2 g = p / s; if (uPE.x > 0.5) g.x += 0.5 * mod(floor(g.y), 2.0);
    vec2 c = (fract(g) - 0.5) * s; float r = (lw > 0.0 ? lw : s * 0.5) * 0.5;
    return mix(uPC[0], uPC[1], PAA(length(c) - r, w));`,
  // 4 grid
  4: `
    vec2 c = abs(fract(p / s + 0.5) - 0.5) * s;
    return mix(uPC[0], uPC[1], PAA(min(c.x, c.y) - lw * 0.5, w));`,
  // 5 hex(亀甲): line_width > 0 = 色 1 の線 + 面は色 0・2・3、0 = 面を色の順に塗り分け
  5: `
    vec2 g = p / s; vec2 r = vec2(1.0, 1.7320508), h = r * 0.5;
    vec2 a = mod(g, r) - h, b = mod(g - h, r) - h;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    float d0 = gv.x, d1 = dot(gv, vec2(0.5, 0.8660254)), d2 = dot(gv, vec2(-0.5, 0.8660254));
    float ed = (0.5 - max(abs(d0), max(abs(d1), abs(d2)))) * s;
    vec2 id = g - gv;
    vec2 nv = abs(d0) > abs(d1) && abs(d0) > abs(d2) ? vec2(sign(d0), 0.0) : abs(d1) > abs(d2) ? sign(d1) * vec2(0.5, 0.8660254) : sign(d2) * vec2(-0.5, 0.8660254);
    vec2 id2 = id + nv;
    float k1 = mod((floor(id.x * 2.0 + 0.5) + 3.0 * floor(id.y / 0.8660254 + 0.5)) * 0.5, 3.0);
    float k2 = mod((floor(id2.x * 2.0 + 0.5) + 3.0 * floor(id2.y / 0.8660254 + 0.5)) * 0.5, 3.0);
    vec4 c1, c2;
    if (lw > 0.0) {
      c1 = k1 < 0.5 || uPN < 2.5 ? uPC[0] : k1 < 1.5 || uPN < 3.5 ? uPC[2] : uPC[3];
      c2 = k2 < 0.5 || uPN < 2.5 ? uPC[0] : k2 < 1.5 || uPN < 3.5 ? uPC[2] : uPC[3];
    } else { c1 = PCOL(k1); c2 = PCOL(k2); }
    vec4 c = mix(c1, c2, clamp(0.5 - ed / w, 0.0, 0.5));
    if (lw > 0.0) c = mix(c, uPC[1], PAA(ed - lw * 0.5, w));
    return c;`,
  // 6 triangles / uroko(鱗): ratio = 高さ / 底辺
  6: `
    float hgt = s * uPA.w; float b = p.y / hgt; float a = p.x / s - b * 0.5;
    float fa = a - floor(a), fb = b - floor(b), fc = fract(a + b);
    float ks = s * hgt / length(vec2(hgt, s * 0.5));
    float d = min(min(fa, 1.0 - fa) * ks, min(min(fb, 1.0 - fb) * hgt, min(fc, 1.0 - fc) * ks));
    if (lw > 0.0) return mix(uPC[0], uPC[1], PAA(d - lw * 0.5, w));
    float up = step(fa + fb, 1.0);
    return mix(up > 0.5 ? uPC[1] : uPC[0], up > 0.5 ? uPC[0] : uPC[1], clamp(0.5 - d / w, 0.0, 0.5));`,
  // 7 yagasuri(矢絣): size = 列の幅、ratio = 帯の高さ / 幅、uPE.x = 傾き。line_width > 0 で矢の軸の線
  7: `
    float hgt = s * uPA.w;
    float col = floor(p.x / s), fx = p.x / s - col;
    float odd = mod(col, 2.0); float u = odd > 0.5 ? 1.0 - fx : fx;
    float v = p.y / hgt + u * uPE.x + floor(col * 0.5);
    float t = abs(fract(v * 0.5 + 0.25) * 2.0 - 1.0);
    float gl = length(vec2(uPE.x / s, 1.0 / hgt));
    float tA = clamp((0.5 - t) / (gl * w), -0.5, 0.5) + 0.5;
    tA = mix(tA, 1.0 - tA, clamp(0.5 - u * s / w, 0.0, 0.5));
    vec4 c = mix(uPC[1], uPC[0], tA);
    if (lw > 0.0) c = mix(c, PCOL(min(2.0, uPN - 1.0)), PAA((1.0 - u) * s - lw * 0.5, w));
    return c;`,
  // 8 asanoha(麻の葉): 正三角形の格子 + 重心から頂点への線
  8: `
    float hgt = s * 0.8660254; float b = p.y / hgt; float a = p.x / s - b * 0.5;
    float fa = a - floor(a), fb = b - floor(b);
    float up = step(fa + fb, 1.0);
    float e1 = (up > 0.5 ? fa : 1.0 - fa) * hgt, e2 = (up > 0.5 ? fb : 1.0 - fb) * hgt;
    float e3 = (up > 0.5 ? 1.0 - fa - fb : fa + fb - 1.0) * hgt;
    float lo = min(e1, min(e2, e3)), hi = max(e1, max(e2, e3)), mid = e1 + e2 + e3 - lo - hi;
    float d = min(lo, (mid - lo) / 1.7320508) - lw * 0.5;
    return mix(uPC[0], uPC[1], PAA(d, w));`,
  // 9 seigaiha(青海波): size = 円の半径、uPE.x = 輪の数、ratio = 線の割合
  9: `
    float R = s, rowH = R * 0.5; float n = max(1.0, floor(uPE.x + 0.5));
    float lr = lw > 0.0 ? clamp(lw / (R / n), 0.02, 0.98) : clamp(uPA.w, 0.02, 0.98);
    vec4 acc = vec4(0.0); float cv = 0.0;
    float j0 = floor(p.y / rowH);
    for (int k = 0; k < 5; k++){
      float j = j0 + 2.0 - float(k); float jm = mod(j, 2.0);
      float cx = (floor((p.x / R - jm) * 0.5 + 0.5) * 2.0 + jm) * R;
      float d = length(p - vec2(cx, j * rowH));
      float cov = PAA(d - R, w) * (1.0 - cv);
      if (cov > 0.0) {
        float f = fract(d / R * n);
        float sd = f > 1.0 - lr ? min(f - (1.0 - lr), 1.0 - f) : -min(1.0 - lr - f, f);
        float t = clamp(0.5 + sd * (R / n) / w, 0.0, 1.0);
        acc += mix(uPC[0], uPC[1], t) * cov; cv += cov;
      }
    }
    return acc + uPC[0] * (1.0 - cv);`,
  // 10 shippo(七宝): 色 0 = 地、色 1 = 重なり(花びら)、線は色 2(無ければ色 1)
  10: `
    float r = s * 0.5;
    vec2 qa = (fract(p / s + 0.5) - 0.5) * s, qb = (fract(p / s) - 0.5) * s;
    float da = r - length(qa), db = r - length(qb);
    vec4 c = mix(uPC[0], uPN > 2.5 ? uPC[1] : uPC[0], clamp(0.5 + min(da, db) / w, 0.0, 1.0));
    if (lw > 0.0) c = mix(c, uPN > 2.5 ? uPC[2] : uPC[1], PAA(min(abs(da), abs(db)) - lw * 0.5, w));
    else if (uPN < 2.5) c = mix(uPC[0], uPC[1], clamp(0.5 + min(da, db) / w, 0.0, 1.0));
    return c;`,
  // 11 kagome(籠目)
  11: `
    float hgt = s * 0.8660254; float b = p.y / hgt; float a = p.x / s - b * 0.5;
    float fa = a - floor(a), fb = b - floor(b), fc = fract(a + b + 0.5);
    float d = min(min(fa, 1.0 - fa), min(min(fb, 1.0 - fb), min(fc, 1.0 - fc))) * hgt;
    return mix(uPC[0], uPC[1], PAA(d - lw * 0.5, w));`,
  // 12 halftone: uPE = 勾配の向き(x,y), 長さ, 段違い。uPF = 勾配の中心(x,y), 点の最小, 最大。uPA.w = 1 で放射
  12: `
    vec2 g = p / s; float row = floor(g.y);
    if (uPE.w > 0.5) g.x += 0.5 * mod(row, 2.0);
    vec2 cell = floor(g) + 0.5; vec2 cc = cell;
    if (uPE.w > 0.5) cc.x -= 0.5 * mod(row, 2.0);
    cc *= s;
    vec2 L = vec2(cc.x * uPB.x - cc.y * uPB.y, cc.x * uPB.y + cc.y * uPB.x) + uPB.zw - uPF.xy;
    float t = uPA.w > 0.5 ? length(L) / max(uPE.z, 1e-3) : dot(L, uPE.xy) / max(uPE.z, 1e-3) + 0.5;
    float rad = mix(uPF.w, uPF.z, clamp(t, 0.0, 1.0)) * s * 0.5;
    float d = length((g - cell) * s) - rad;
    return mix(uPC[0], uPC[1], rad <= 0.01 ? 0.0 : PAA(d, w));`,
  // 13 rays(集中線): uPE = 本数, ばらつき, 内側の半径, 種
  13: `
    float n = max(2.0, floor(uPE.x + 0.5));
    float x = atan(p.x, -p.y) / 6.2831853 * n; float r = length(p);
    if (uPN > 2.5 && uPE.y <= 0.0 && uPE.z <= 0.0) {
      float i = floor(x), f = x - i;
      float nb = mod(f < 0.5 ? i - 1.0 : i + 1.0, n);
      float d = (f < 0.5 ? f : 1.0 - f) / n * 6.2831853 * r;
      return mix(PCOL(mod(i, n)), PCOL(nb), clamp(0.5 - d / w, 0.0, 0.5));
    }
    float i = mod(floor(x), n), f = fract(x);
    float h1 = PH(vec2(i, uPE.w)), h2 = PH(vec2(i + 17.0, uPE.w));
    float r0 = uPE.z * (1.0 + uPE.y * 2.0 * h2);
    float taper = uPE.z > 0.0 ? clamp(1.0 - r0 / max(r, 1e-3), 0.0, 1.0) : 1.0;
    float hw = uPA.w * (1.0 - uPE.y * h1) * 0.5 * taper;
    float d = (abs(f - 0.5) - hw) / n * 6.2831853 * r;
    float k = PAA(d, w); if (uPE.z > 0.0) k *= step(r0, r);
    return mix(uPC[0], uPC[1], k);`,
  // 14 concentric
  14: `
    float r = length(p);
    if (lw > 0.0) { float f = abs(fract(r / s + 0.5) - 0.5) * s; return mix(uPC[0], uPC[1], PAA(f - lw * 0.5, w)); }
    return PBANDS(r / s, s, w);`,
  // 15 waves: uPE.x = 振幅, uPE.y = 波長
  15: `
    float wl = max(uPE.y, 1.0); float ph = 6.2831853 * p.x / wl;
    float y = p.y + uPE.x * sin(ph);
    float k = 1.0 / sqrt(1.0 + pow(uPE.x * 6.2831853 / wl * cos(ph), 2.0));
    if (lw > 0.0) { float f = abs(fract(y / s + 0.5) - 0.5) * s * k; return mix(uPC[0], uPC[1], PAA(f - lw * 0.5, w)); }
    return PBANDS(y / s, s * k, w);`,
  // 16 noise: uPE = 種, コントラスト, 重ねる回数
  16: `
    vec2 g = p / s + uPE.x * 17.31; float n = 0.0, am = 0.5, tot = 0.0;
    for (int k = 0; k < 5; k++){ if (float(k) >= uPE.z) break; n += PVN(g) * am; tot += am; g = g * 2.03 + 11.7; am *= 0.5; }
    n = clamp((n / tot - 0.5) * uPE.y + 0.5, 0.0, 1.0);
    float x = n * (uPN - 1.0); float i = min(floor(x), uPN - 2.0);
    return mix(PCOL(i), PCOL(i + 1.0), clamp(x - i, 0.0, 1.0));`,
  // 17 grain(紙の粒): uPE.x = 種, uPE.y = 量
  17: `
    float n = PH(floor(p / s) + uPE.x * 7.13);
    return mix(uPC[0], uPC[1], clamp(n * uPE.y, 0.0, 1.0));`,
  // 18 zigzag(山形): size = 山の幅、ratio = 帯の高さ / 幅、uPE.x = 山の高さ
  18: `
    float hgt = s * uPA.w; float tri = abs(fract(p.x / s) - 0.5) * 2.0;
    float y = p.y + tri * uPE.x;
    float k = 1.0 / sqrt(1.0 + pow(2.0 * uPE.x / s, 2.0));
    if (lw > 0.0) { float f = abs(fract(y / hgt + 0.5) - 0.5) * hgt * k; return mix(uPC[0], uPC[1], PAA(f - lw * 0.5, w)); }
    return PBANDS(y / hgt, hgt * k, w);`,
  // 19 gradient: 色を順になめらかにつなぐ。uPA.w = 1 で放射。size = 端から端までの長さ
  19: `
    float t = uPA.w > 0.5 ? length(p) / s : p.y / s + 0.5;
    float x = clamp(t, 0.0, 1.0) * (uPN - 1.0); float i = min(floor(x), max(uPN - 2.0, 0.0));
    return mix(PCOL(i), PCOL(min(i + 1.0, uPN - 1.0)), clamp(x - i, 0.0, 1.0));`,
}

// レイヤー用シェーダへ差し込む GLSL。vec4 patternColor(vec2 レイヤー座標, float 1 画素の大きさ) を定義する
export function patternGlsl(id) {
  return COMMON + `
vec4 patternColor(vec2 lp, float px){
  vec2 q = lp - uPB.zw;
  vec2 p = vec2(q.x * uPB.x + q.y * uPB.y, -q.x * uPB.y + q.y * uPB.x);
  float s = max(uPA.x, 1e-3), lw = uPA.y, w = max(uPA.z, px);
  ${BODY[id] || BODY[1]}
}`
}

const D2R = Math.PI / 180
const DEFAULT_COLORS = ['#f4a7b9', '#ffffff']

// 評価済みの指定 → シェーダへ渡す値。out を使い回す
export function patternUniforms(s, out) {
  const kind = patternKind(s.kind)
  const K = PATTERN_KINDS[kind]
  out ??= { id: 0, colors: new Float32Array(16), A: [0, 0, 0, 0], B: [0, 0, 0, 0], E: [0, 0, 0, 0], F: [0, 0, 0, 0], n: 2 }
  out.id = K.id
  let cols = Array.isArray(s.colors) && s.colors.length ? s.colors : DEFAULT_COLORS
  // [r,g,b,a] 1 色だけを配列で渡された場合
  if (typeof cols[0] === 'number') cols = [cols]
  const n = clamp(cols.length, 1, 4)
  for (let i = 0; i < 4; i++) {
    const c = toColor(cols[Math.min(i, n - 1)], [1, 1, 1, 1])
    out.colors[i * 4] = c[0] * c[3]; out.colors[i * 4 + 1] = c[1] * c[3]; out.colors[i * 4 + 2] = c[2] * c[3]; out.colors[i * 4 + 3] = c[3]
  }
  out.n = Math.max(n, kind === 'gradient' || kind === 'noise' ? 2 : 1)
  if (n === 1) for (let i = 4; i < 8; i++) out.colors[i] = out.colors[i - 4]
  const size = Math.max(0.01, num(s.size, K.size))
  let lw = Math.max(0, num(s.line_width, K.line_width ?? 0))
  let ratio = num(s.ratio, K.ratio ?? 0.5)
  const ang = num(s.angle, 0) * D2R
  const off = vec(s.offset, 2, 0)
  const E = out.E, F = out.F
  E[0] = E[1] = E[2] = E[3] = 0; F[0] = F[1] = F[2] = F[3] = 0
  switch (kind) {
    case 'stripes': if (s.ratio != null && !lw) lw = clamp(ratio, 0, 1) * size; break
    case 'dots': E[0] = s.stagger ? 1 : 0; break
    case 'yagasuri': E[0] = num(s.slope, 1); break
    case 'seigaiha': E[0] = num(s.rings, 3); if (s.ratio == null) ratio = 0.5; break
    case 'halftone': {
      const ga = num(s.grad_angle, 180) * D2R
      E[0] = Math.sin(ga); E[1] = -Math.cos(ga); E[2] = Math.max(1, num(s.grad_length, 1080)); E[3] = s.stagger === false ? 0 : 1
      const c = vec(s.grad_center, 2, 0)
      F[0] = c[0]; F[1] = c[1]; F[2] = num(s.dot_min, 0) / 100; F[3] = num(s.dot_max, 100) / 100
      ratio = s.grad_type === 'radial' ? 1 : 0
      break
    }
    case 'rays': E[0] = num(s.count, 24); E[1] = clamp(num(s.jitter, 0), 0, 1); E[2] = Math.max(0, num(s.inner, 0)); E[3] = num(s.seed, 1); break
    case 'waves': E[0] = num(s.amplitude, size * 0.5); E[1] = num(s.wavelength, size * 4); break
    case 'noise': E[0] = num(s.seed, 1); E[1] = num(s.contrast, 1.5); E[2] = clamp(Math.round(num(s.octaves, 3)), 1, 5); break
    case 'grain': E[0] = num(s.seed, 1); E[1] = num(s.amount, 100) / 100; break
    case 'zigzag': E[0] = num(s.amplitude, size * 0.5); break
    case 'gradient': ratio = s.grad_type === 'radial' ? 1 : 0; break
  }
  out.A[0] = size; out.A[1] = lw; out.A[2] = Math.max(0, num(s.softness, 0)); out.A[3] = ratio
  out.B[0] = Math.cos(ang); out.B[1] = Math.sin(ang); out.B[2] = off[0]; out.B[3] = off[1]
  return out
}
