// 「軽い」エフェクト = その画素の位置と色だけで決まるもの。レンダーターゲットを使わず、
// レイヤーを描くフラグメントシェーダの中で順に評価する(切る・隠す → アルファに掛ける、色 → 順に掛ける)。
// 1 個の op は vec4 を n 個使う。シェーダは op の並び(署名)ごとに作って使い回す。
// 座標 $P はレイヤー空間の px(原点 = レイヤーの中心)。角度は 0° = 上・時計回り。
import { num, vec, toColor, clamp } from './props.js'

const D2R = Math.PI / 180
const dirOf = (deg) => [Math.sin(deg * D2R), -Math.cos(deg * D2R)]
const pct = (v, d) => clamp(num(v, d) / 100, 0, 1)
const put = (o, i, a, b = 0, c = 0, d = 0) => { o[i] = a; o[i + 1] = b; o[i + 2] = c; o[i + 3] = d }
const putCol = (o, i, v, dflt) => { const c = toColor(v, dflt); put(o, i, c[0], c[1], c[2], c[3]) }
const cxy = (r, p) => [r.x + r.w / 2 + num(p.cx ?? p.x, 0), r.y + r.h / 2 + num(p.cy ?? p.y, 0)]

export const OPS_GLSL = /* glsl */ `
float OAA(float d, float f, float px){ return clamp(0.5 - d / max(f, px), 0.0, 1.0); }
float OL(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float OH(vec2 p, float s){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + s * 0.6180339); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float OSTAR(vec2 p, float r, float n, float m){
  p.y = -p.y;
  float an = 3.141593 / n, en = 3.141593 / m; vec2 acs = vec2(cos(an), sin(an)), ecs = vec2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an; p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs; p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}
vec4 OOVER(vec4 s, vec3 col, float k){
  float a = k + s.a * (1.0 - k);
  return vec4(a > 1e-5 ? (col * k + s.rgb * s.a * (1.0 - k)) / a : s.rgb, a);
}
vec4 OGRAD(vec4 c0, vec4 c1, vec4 c2, vec4 c3, float n, float t){
  float x = clamp(t, 0.0, 1.0) * (n - 1.0);
  return x < 1.0 ? mix(c0, c1, x) : x < 2.0 ? mix(c1, c2, x - 1.0) : mix(c2, c3, x - 2.0);
}
vec2 OCBCR(vec3 c){ return vec2(dot(c, vec3(-0.168736, -0.331264, 0.5)), dot(c, vec3(0.5, -0.418688, -0.081312))); }
`

// mask: アルファに掛ける式(m に掛ける)。color: 色の式(s = ストレートの vec4 を書き換える)。
// pack(p, ctx, o, i): 評価済みの値 p を o[i..] に詰める。false を返すと「何もしない」
const R = {}

// ---- 切る・隠す ----
R.clip_line = {
  n: 2,
  mask: `{ float d = dot($P - $0.xy, $0.zw); float k = $1.y < 0.5 ? OAA(d, $1.z, px) : OAA(abs(d) - $1.x, $1.z, px);
    if ($1.w > 1.5) { float t = clamp(($1.y < 0.5 ? -d : $1.x - abs(d)) / max($1.z, px), 0.0, 1.0); k = 0.5 - 0.5 * cos(3.14159265 * t); }
    if ($1.y > 1.5) k = 1.0 - k; if (mod($1.w, 2.0) > 0.5) k = 1.0 - k; m *= k; }`,
  pack(p, ctx, o, i) {
    // 法線 n = (-sin a, cos a)(a = 0 なら下向き)。幅 0 のときは法線の側(a = 0 なら中心より下)が消える
    const c = cxy(ctx.rect, p), n = dirOf(num(p.angle, 0) + 180), w = num(p.width, 0)
    put(o, i, c[0], c[1], n[0], n[1])
    // feather_mode: 'center'(既定。境目をまん中に、ぼかし幅ぶんを直線で)/ 'inside'(境目で 0、残る側の内側へ ぼかし幅ぶんを cos カーブで上がる。
    //   AviUtl の斜めクリッピングの帯で実測した形: 幅 1000・ぼかし 2000 だと帯のまん中でも 14.6 % までしか上がらない)
    put(o, i + 4, Math.abs(w) / 2, w > 0 ? 1 : w < 0 ? 2 : 0, Math.max(0, num(p.feather, 0)), (p.invert ? 1 : 0) + (p.feather_mode === 'inside' ? 2 : 0))
  },
}
R.crop = {
  n: 2,
  mask: `{ vec2 q = max($0.xy - $P, $P - $0.zw); m *= OAA(max(q.x, q.y), $1.x, px); }`,
  pack(p, ctx, o, i) {
    const r = ctx.rect
    const l = Math.max(0, num(p.left, 0)), t = Math.max(0, num(p.top, 0)), rt = Math.max(0, num(p.right, 0)), b = Math.max(0, num(p.bottom, 0))
    if (!l && !t && !rt && !b) return false
    const nr = { x: r.x + l, y: r.y + t, w: Math.max(0, r.w - l - rt), h: Math.max(0, r.h - t - b) }
    put(o, i, nr.x, nr.y, nr.x + nr.w, nr.y + nr.h)
    put(o, i + 4, Math.max(0, num(p.feather, 0)))
    // center: 切ったあとの絵の中心を元の中心へ寄せる(AviUtl の「中心の位置を変更」)
    if (p.center || p.recenter) ctx.shift = [(ctx.shift?.[0] || 0) + (r.x + r.w / 2) - (nr.x + nr.w / 2), (ctx.shift?.[1] || 0) + (r.y + r.h / 2) - (nr.y + nr.h / 2)]
    ctx.rect = nr
  },
}
R.clip = R.crop
R.blinds = {
  n: 3,
  mask: `{ float sx = dot($P - $0.xy, $0.zw) + $2.y; float bi = floor(sx / $1.x); float fr = sx / $1.x - bi; float keep = $1.y;
    if ($1.w > 0.0) { float u = clamp(bi * $1.x / max(2.0 * $2.x, 1.0) + 0.5, 0.0, 1.0); keep = clamp($1.y * (1.0 + $1.w) - u * $1.w, 0.0, 1.0); }
    m *= keep >= 1.0 ? 1.0 : keep <= 0.0 ? 0.0 : OAA(max((fr - keep) * $1.x, -fr * $1.x), $1.z, px); }`,
  pack(p, ctx, o, i) {
    const r = ctx.rect, n = dirOf(num(p.angle, 0))
    const ext = (Math.abs(n[0]) * r.w + Math.abs(n[1]) * r.h) / 2
    let pitch = num(p.pitch ?? p.width, 0)
    if (!(pitch > 0)) pitch = (2 * ext) / Math.max(1, num(p.count, 8))
    const ratio = p.ratio != null ? pct(p.ratio, 50) : p.progress != null ? pct(p.progress, 50) : 0.5
    put(o, i, r.x + r.w / 2 + num(p.cx, 0), r.y + r.h / 2 + num(p.cy, 0), n[0], n[1])
    put(o, i + 4, Math.max(0.01, pitch), ratio, Math.max(0, num(p.feather, 0)), Math.max(0, num(p.stagger, 0)) / 100)
    put(o, i + 8, Math.max(1, ext), num(p.phase, 0))
  },
}
R.clip_sector = {
  n: 2,
  mask: `{ vec2 q = $P - $0.xy; float r = length(q); float t = mod(atan(q.x, -q.y) - $0.z, 6.2831853); float k;
    if ($0.w >= 6.28318) k = 1.0; else if ($0.w <= 0.0) k = 0.0; else {
      float sd = t < $0.w ? min(t, $0.w - t) : -min(6.2831853 - t, t - $0.w);
      k = clamp(0.5 + sin(clamp(sd, -1.5708, 1.5708)) * r / max($1.x, px), 0.0, 1.0); }
    if ($1.y < 0.5) k = 1.0 - k; m *= k; }`,
  // 扇形 [start, start+sweep] を消す。keep: true でその扇形だけ残す
  pack(p, ctx, o, i, keepDefault = false) {
    const c = cxy(ctx.rect, p)
    let st = num(p.start, 0), sw = p.sweep != null ? num(p.sweep, 0) : pct(p.progress, 100) * 360
    if (sw < 0) { st += sw; sw = -sw }
    put(o, i, c[0], c[1], (((st % 360) + 360) % 360) * D2R, Math.min(360, sw) * D2R)
    const keep = p.keep != null ? !!p.keep : p.invert != null ? (keepDefault ? !p.invert : !!p.invert) : keepDefault
    put(o, i + 4, Math.max(0, num(p.feather, 0)), keep ? 1 : 0)
  },
}
R.radial_wipe = { ...R.clip_sector, pack: (p, ctx, o, i) => R.clip_sector.pack(p, ctx, o, i, true) }
R.iris = {
  n: 3,
  mask: `{ vec2 q = ($P - $0.xy) * $2.xy; float sd;
    if ($0.w < 0.5) sd = length(q) - $0.z;
    else if ($0.w < 1.5) sd = max(abs(q.x), abs(q.y)) - $0.z;
    else if ($0.w < 2.5) sd = (abs(q.x) + abs(q.y)) * 0.7071 - $0.z;
    else sd = OSTAR(q, $0.z, $1.z, $1.w);
    float k = OAA(sd, $1.x, px); if ($1.y > 0.5) k = 1.0 - k; m *= k; }`,
  pack(p, ctx, o, i) {
    const r = ctx.rect, c = cxy(r, p)
    const hw = r.w / 2 + Math.abs(num(p.cx, 0)), hh = r.h / 2 + Math.abs(num(p.cy, 0)), diag = Math.hypot(hw, hh)
    const shape = { circle: 0, rect: 1, diamond: 2, star: 3, polygon: 4 }[p.shape] ?? 0
    const sides = Math.max(3, Math.round(num(p.sides, shape === 3 ? 5 : 6)))
    const inner = clamp(num(p.inner, 0.5), 0.05, 1)
    let full = diag, ax = 1, ay = 1, mm = 2
    if (shape === 1) { const hm = Math.min(hw, hh) || 1; ax = hm / (hw || 1); ay = hm / (hh || 1); full = hm }
    else if (shape === 2) full = (hw + hh) * 0.7071
    else if (shape === 3) { mm = 2 + (1 - inner) * (sides - 2); full = diag / Math.max(0.2, inner) }
    else if (shape === 4) full = diag / Math.cos(Math.PI / sides)
    const rad = p.radius != null ? Math.max(0, num(p.radius, 0)) : pct(p.progress, 100) * (full + 2)
    put(o, i, c[0], c[1], rad, Math.min(shape, 3))
    put(o, i + 4, Math.max(0, num(p.feather, 0)), p.invert ? 1 : 0, sides, shape === 4 ? 2 : mm)
    put(o, i + 8, ax, ay)
  },
}
R.mask_shape = {
  n: 4,
  mask: `{ vec2 q = $P - $0.xy; q = vec2(q.x * $2.z + q.y * $2.w, -q.x * $2.w + q.y * $2.z); float sd;
    if ($1.x < 0.5) { vec2 e = abs(q) - $0.zw + $1.y; sd = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - $1.y; }
    else if ($1.x < 1.5) { vec2 rr = max($0.zw, vec2(1e-3)); float k0 = length(q / rr), k1 = length(q / (rr * rr)); sd = k1 > 1e-9 ? k0 * (k0 - 1.0) / k1 : -min(rr.x, rr.y); }
    else if ($1.x < 2.5) sd = (abs(q.x) / max($0.z, 1e-3) + abs(q.y) / max($0.w, 1e-3) - 1.0) * min($0.z, $0.w) * 0.7071;
    else { float rm = min($0.z, $0.w); sd = OSTAR(q / max($0.zw, vec2(1e-3)) * rm, rm, $3.x, $1.y); }
    float k = OAA(sd - $2.y, $1.z, px); if ($1.w > 0.5) k = 1.0 - k; m *= mix(1.0, k, $2.x); }`,
  pack(p, ctx, o, i) {
    const r = ctx.rect, c = cxy(r, p)
    // 大きさ: w,h(px)か、size(px)+ aspect(-100〜100。正で縦長、負で横長)。省略時はレイヤーの大きさ
    let w = num(p.w ?? p.width, NaN), h = num(p.h ?? p.height, NaN)
    if (p.size != null && !p.fit_original && num(p.size, 0) > 0) {
      const s = num(p.size, 100), a = clamp(num(p.aspect, 0) / 100, -1, 1)
      w = s * (a > 0 ? 1 - a : 1); h = s * (a < 0 ? 1 + a : 1)
    }
    if (!isFinite(w)) w = r.w
    if (!isFinite(h)) h = r.h
    const shape = { rect: 0, rounded_rect: 0, ellipse: 1, circle: 1, diamond: 2, star: 3, polygon: 4, triangle: 4, pentagon: 4, hexagon: 4 }[p.shape] ?? 0
    const sides = Math.max(3, Math.round(num(p.sides, { triangle: 3, pentagon: 5, hexagon: 6, star: 5 }[p.shape] ?? 6)))
    const inner = clamp(num(p.inner, 0.5), 0.05, 1)
    const rot = num(p.rotation, 0) * D2R
    put(o, i, c[0], c[1], Math.max(0, w / 2), Math.max(0, h / 2))
    put(o, i + 4, Math.min(shape, 3), shape === 0 ? Math.min(Math.max(0, num(p.radius, 0)), w / 2, h / 2) : shape === 3 ? 2 + (1 - inner) * (sides - 2) : 2,
      Math.max(0, num(p.feather, 0)), p.invert ? 1 : 0)
    put(o, i + 8, pct(p.opacity, 100), num(p.expansion, 0), Math.cos(rot), Math.sin(rot))
    put(o, i + 12, sides)
  },
}
R.mask = R.mask_shape
R.mask_image = {
  n: 3, tex: true,
  mask: `{ vec2 q = $P - $0.xy; q = vec2(q.x * $1.x + q.y * $1.y, -q.x * $1.y + q.y * $1.x); vec2 uv = q / (2.0 * $0.zw) + 0.5;
    vec4 t = texture2D($T, uv, $1.z); float k = $2.y > 0.5 ? dot(t.rgb, vec3(0.2126, 0.7152, 0.0722)) : t.a;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) k = 0.0;
    if ($1.w > 0.5) k = 1.0 - k; m *= mix(1.0, k, $2.x); }`,
  pack(p, ctx, o, i) {
    const e = ctx.image(p)
    if (!e) return false
    // まだ読めていない間は、反転でなければ全部隠す(一瞬だけ素通しで見えるのを防ぐ)
    if (e.state !== 'ready') { if (p.invert) return false; ctx.hide = true; return false }
    const r = ctx.rect, c = cxy(r, p)
    let w = e.w, h = e.h
    // size = 長いほうの辺の px(0・省略・fit_original は元の大きさ)
    if (p.size != null && !p.fit_original && num(p.size, 0) > 0) { const k = num(p.size, 0) / Math.max(w, h); w *= k; h *= k }
    const sc = vec(p.scale ?? 100, 2, 100)
    w *= sc[0] / 100; h *= sc[1] / 100
    const a = clamp(num(p.aspect, 0) / 100, -1, 1)
    if (a > 0) w *= 1 - a; else if (a < 0) h *= 1 + a
    const rot = num(p.rotation, 0) * D2R, fe = Math.max(0, num(p.feather, 0))
    put(o, i, c[0], c[1], Math.max(1e-3, w / 2), Math.max(1e-3, h / 2))
    put(o, i + 4, Math.cos(rot), Math.sin(rot), fe > 0.5 ? Math.log2(1 + (fe * e.w) / Math.max(1, w)) : 0, p.invert ? 1 : 0)
    // channel: 'alpha' | 'luma' | 省略 = 画像にアルファがあればアルファ、無ければ輝度
    put(o, i + 8, pct(p.opacity, 100), p.channel === 'luma' || (p.channel !== 'alpha' && ctx.opaque(e)) ? 1 : 0)
    ctx.tex = e.tex
  },
}
R.wipe = {
  n: 2,
  mask: `{ float ext = abs($0.x) * $1.z + abs($0.y) * $1.w; float sx = dot($P - $1.xy, $0.xy) + ext; float edge = $0.z * (2.0 * ext + $0.w) - $0.w;
    m *= $0.z <= 0.0 ? 1.0 : $0.w > 1e-3 ? clamp((sx - edge) / $0.w, 0.0, 1.0) : clamp(0.5 + (sx - edge) / px, 0.0, 1.0); }`,
  pack(p, ctx, o, i) {
    const r = ctx.rect, d = dirOf(num(p.angle, 90)), pr = pct(p.progress, 0)
    if (pr <= 0) return false
    put(o, i, d[0], d[1], pr, Math.max(0, num(p.feather, 0)))
    put(o, i + 4, r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2)
  },
}
R.opacity = {
  n: 1, mask: `m *= $0.x;`,
  pack(p, ctx, o, i) { put(o, i, pct(p.amount ?? p.opacity, 100)) },
}

// ---- 色 ----
R.fill = {
  n: 2,
  // $1.y: 0 = ベタ塗り / 1 = 色 × 輝度(tint)/ 2 = 輝度(Y)はそのまま、色差(Cb・Cr)だけ指定色のものにする(AviUtl の「輝度を保持する」)
  color: `{ vec3 fc = $0.rgb;
    if ($1.y > 1.5) { vec2 cc = OCBCR($0.rgb); float y = dot(s.rgb, vec3(0.299, 0.587, 0.114));
      fc = clamp(vec3(y + 1.402 * cc.y, y - 0.344136 * cc.x - 0.714136 * cc.y, y + 1.772 * cc.x), 0.0, 1.0); }
    else if ($1.y > 0.5) fc = $0.rgb * OL(s.rgb);
    s.rgb = mix(s.rgb, fc, $1.x); }`,
  pack(p, ctx, o, i, tint = false) {
    const c = toColor(p.color ?? '#ffffff')
    const am = pct(p.amount, 100) * c[3]
    if (am <= 0) return false
    put(o, i, c[0], c[1], c[2], 1); put(o, i + 4, am, tint ? (p.keep_luma === false ? 0 : 1) : p.keep_luma ? 2 : 0)
  },
}
R.tint = { ...R.fill, pack: (p, ctx, o, i) => R.fill.pack(p, ctx, o, i, true) }
R.color = {
  n: 3,
  color: `{ vec3 x = s.rgb;
    if (abs($1.y) > 1e-5 || $1.x < 0.99999){ vec3 k = vec3(0.57735); x = x * $1.x + cross(k, x) * $1.y + k * dot(k, x) * (1.0 - $1.x); }
    x = mix(vec3(OL(x)), x, $0.z);
    x = ((x - 0.5) * $0.y + 0.5 + $0.x) * $1.z;
    if ($1.w != 1.0) x = pow(max(x, vec3(0.0)), vec3($1.w));
    x = mix(x, $2.rgb * OL(clamp(x, 0.0, 1.0)), $0.w);
    s.rgb = clamp(x, 0.0, 1.0); }`,
  pack(p, ctx, o, i) {
    const tint = p.tint != null ? toColor(p.tint) : null
    const hue = num(p.hue, 0) * D2R
    put(o, i, num(p.brightness, 0) / 100, Math.max(0, 1 + num(p.contrast, 0) / 100), Math.max(0, 1 + num(p.saturation, 0) / 100), tint ? pct(p.tint_amount, 100) : 0)
    put(o, i + 4, Math.cos(hue), Math.sin(hue), Math.max(0, num(p.gain ?? p.luminance, 100) / 100), 100 / Math.max(1, num(p.gamma, 100)))
    put(o, i + 8, ...(tint || [1, 1, 1]).slice(0, 3))
  },
}
R.grayscale = {
  n: 1, color: `s.rgb = mix(s.rgb, vec3(OL(s.rgb)), $0.x);`,
  pack(p, ctx, o, i) { put(o, i, pct(p.amount, 100)) },
}
R.duotone = {
  n: 3,
  color: `{ vec4 dc = mix($0, $1, pow(clamp(mix(OL(s.rgb), max(s.r, max(s.g, s.b)), $2.z), 0.0, 1.0), $2.x)); s = vec4(mix(s.rgb, dc.rgb, $2.y), s.a * mix(1.0, dc.a, $2.y)); }`,
  pack(p, ctx, o, i) {
    putCol(o, i, p.dark ?? '#000000'); putCol(o, i + 4, p.light ?? '#ffffff')
    put(o, i + 8, 100 / Math.max(1, num(p.gamma, 100)), pct(p.amount, 100), p.gray === 'max' ? 1 : 0)
  },
}
R.threshold = {
  n: 3,
  color: `{ float k = smoothstep($2.x - $2.y, $2.x + $2.y + 1e-4, OL(s.rgb)); vec4 dc = mix($0, $1, k); s = vec4(mix(s.rgb, dc.rgb, $2.z), s.a * mix(1.0, dc.a, $2.z)); }`,
  pack(p, ctx, o, i) {
    putCol(o, i, p.dark ?? p.color_dark ?? '#000000'); putCol(o, i + 4, p.light ?? p.color_light ?? '#ffffff')
    put(o, i + 8, num(p.level ?? p.threshold, 128) / 255, Math.max(0, num(p.softness, 0)) / 255, pct(p.amount, 100))
  },
}
R.binarize = R.threshold
R.bleach_bypass = {
  n: 1,
  color: `{ vec3 g = vec3(OL(s.rgb)); vec3 ov = mix(2.0 * s.rgb * g, 1.0 - 2.0 * (1.0 - s.rgb) * (1.0 - g), step(0.5, s.rgb));
    vec3 x = mix(s.rgb, ov, $0.x); x = mix(vec3(OL(x)), x, $0.y); s.rgb = pow(clamp(x, 0.0, 1.0), vec3($0.z)); }`,
  pack(p, ctx, o, i) { put(o, i, pct(p.amount, 100), Math.max(0, num(p.saturation, 70)) / 100, 100 / Math.max(1, num(p.gamma, 120))) },
}
R.invert = {
  n: 1, color: `s.rgb = mix(s.rgb, $0.y > 0.5 ? s.rgb + (1.0 - 2.0 * OL(s.rgb)) : 1.0 - s.rgb, $0.x); s.rgb = clamp(s.rgb, 0.0, 1.0);`,
  pack(p, ctx, o, i) { put(o, i, pct(p.amount, 100), p.luma_only ? 1 : 0) },
}
// 絵の範囲(ctx.ext = 線の太さ・縁取りのはみ出しも含めた、いまの絵の箱)。決まらない絵(粒子など)は無限大
const extOf = (ctx) => { const e = ctx.ext; return e ? [e.x, e.y, e.x + e.w, e.y + e.h] : [-1e7, -1e7, 1e7, 1e7] }
// 透明度の反転は、絵の範囲の中だけ(その外まで不透明にしない)
R.invert_alpha = {
  n: 2, alpha: true,
  color: `{ vec2 q = max($1.xy - $P, $P - $1.zw); s.a = mix(s.a, 1.0 - s.a, $0.x * OAA(max(q.x, q.y), 0.0, px)); }`,
  pack(p, ctx, o, i) { put(o, i, pct(p.amount, 100)); put(o, i + 4, ...extOf(ctx)) },
}
R.levels = {
  n: 2,
  color: `s.rgb = mix(vec3($1.x), vec3($1.y), pow(clamp((s.rgb - $0.x) / max($0.y - $0.x, 1e-4), 0.0, 1.0), vec3($0.z)));`,
  pack(p, ctx, o, i) {
    put(o, i, num(p.in_black, 0) / 255, num(p.in_white, 255) / 255, 1 / Math.max(0.01, num(p.gamma, 1)))
    put(o, i + 4, num(p.out_black, 0) / 255, num(p.out_white, 255) / 255)
  },
}
R.gradient_map = {
  n: 5,
  color: `{ vec4 g = OGRAD($0, $1, $2, $3, $4.x, OL(s.rgb)); s = vec4(mix(s.rgb, g.rgb, $4.y), s.a * mix(1.0, g.a, $4.y)); }`,
  pack(p, ctx, o, i) {
    const cols = Array.isArray(p.colors) && p.colors.length >= 2 ? p.colors : ['#000000', '#ffffff']
    const n = Math.min(4, cols.length)
    for (let k = 0; k < 4; k++) putCol(o, i + k * 4, cols[Math.min(k, n - 1)])
    put(o, i + 16, n, pct(p.amount, 100))
  },
}
R.posterize = {
  n: 1, color: `s.rgb = floor(s.rgb * $0.x + 0.5) / $0.x;`,
  pack(p, ctx, o, i) { put(o, i, Math.max(1, Math.round(num(p.levels, 4)) - 1)) },
}
R.chroma_key = {
  n: 2,
  // 色相と彩度が近い画素を抜く(AviUtl のクロマキーに合わせ、範囲は 256 を 1 周・最大とする目盛り)
  color: `{ vec2 a = OCBCR(s.rgb), b = OCBCR($0.rgb); float sa = length(a), sb = length(b);
    float dh = sa > 1e-4 && sb > 1e-4 ? acos(clamp(dot(a, b) / (sa * sb), -1.0, 1.0)) * 40.743665 : 0.0;
    float ds = abs(sa - sb) * 256.0;
    float e = max($1.z, 0.5);
    float k = (1.0 - smoothstep($1.x, $1.x + e * 4.0, dh)) * (1.0 - smoothstep($1.y, $1.y + e * 8.0, ds));
    if ($0.a < 0.5) k = 1.0 - smoothstep($1.y, $1.y + e * 8.0, distance(s.rgb, $0.rgb) * 147.8);
    s.a *= 1.0 - k;
    if ($1.w > 0.0) { float sp = (1.0 - smoothstep($1.x, $1.x * 3.0 + 8.0, dh)) * $1.w; s.rgb = mix(s.rgb, vec3(OL(s.rgb)), sp); } }`,
  pack(p, ctx, o, i) {
    const c = toColor(p.color ?? '#00ff00'), ck = p.mode === 'color_key'
    // mode: "color_key" = 色の近さだけで抜く(範囲 = diff_range)
    put(o, i, c[0], c[1], c[2], ck ? 0 : 1)
    put(o, i + 4, Math.max(0, num(p.hue_range, 24)), Math.max(0, num(ck ? p.diff_range ?? p.luma_range : p.sat_range, ck ? 16 : 96)), Math.max(0, num(p.edge, 1)), pct(p.spill, 0))
  },
}
R.luma_key = {
  n: 1,
  color: `{ float k = smoothstep($0.x - $0.y, $0.x + $0.y + 1e-4, OL(s.rgb)); s.a *= $0.z > 0.5 ? 1.0 - k : k; }`,
  pack(p, ctx, o, i) { put(o, i, num(p.threshold, 128) / 255, Math.max(0, num(p.softness, 10)) / 255, p.invert ? 1 : 0) },
}
R.vignette = {
  n: 3,
  color: `{ float v = smoothstep($2.x, $2.x + $2.y + 1e-4, length(($P - $0.xy) * $0.zw) * 0.70711); s.rgb = mix(s.rgb, $1.rgb, v * $1.a); }`,
  pack(p, ctx, o, i) {
    const r = ctx.rect
    put(o, i, r.x + r.w / 2 + num(p.cx, 0), r.y + r.h / 2 + num(p.cy, 0), 2 / Math.max(1, r.w), 2 / Math.max(1, r.h))
    const c = toColor(p.color ?? '#000000')
    put(o, i + 4, c[0], c[1], c[2], pct(p.amount, 50) * c[3])
    put(o, i + 8, pct(p.radius, 50), Math.max(0, num(p.softness, 50)) / 100)
  },
}
R.flash = {
  n: 1, color: `s.rgb = min(s.rgb + $0.rgb * $0.a, vec3(1.0));`,
  pack(p, ctx, o, i) { const c = toColor(p.color ?? '#ffffff'); const a = Math.max(0, num(p.amount, 50)) / 100 * c[3]; if (a <= 0) return false; put(o, i, c[0], c[1], c[2], a) },
}
R.lightleak = {
  n: 3,
  color: `{ vec2 q = $P - $1.xy; q = vec2(q.x * $2.x + q.y * $2.y, (-q.x * $2.y + q.y * $2.x) * $2.z); float k = exp(-dot(q, q) / ($1.z * $1.z)) * $1.w;
    s.rgb = 1.0 - (1.0 - s.rgb) * (1.0 - $0.rgb * k); }`,
  pack(p, ctx, o, i) {
    const r = ctx.rect, c = cxy(r, p), a = num(p.angle, 0) * D2R
    putCol(o, i, p.color ?? '#ffb060')
    put(o, i + 4, c[0], c[1], Math.max(1, num(p.radius, Math.max(r.w, r.h) * 0.5)), Math.max(0, num(p.amount, 60)) / 100)
    put(o, i + 8, Math.cos(a), Math.sin(a), 1 / Math.max(0.05, num(p.stretch, 1)))
  },
}
R.gradient_overlay = {
  n: 7,
  color: `{ float t = $5.y > 0.5 ? length($P - $4.xy) / $5.x : dot($P - $4.xy, $4.zw) / $5.x + 0.5;
    vec4 g = OGRAD($0, $1, $2, $3, $5.z, t); vec3 b = s.rgb, x;
    if ($6.x < 0.5) x = g.rgb; else if ($6.x < 1.5) x = min(b + g.rgb, vec3(1.0)); else if ($6.x < 2.5) x = b * g.rgb;
    else if ($6.x < 3.5) x = b + g.rgb - b * g.rgb; else if ($6.x < 4.5) x = mix(2.0 * b * g.rgb, 1.0 - 2.0 * (1.0 - b) * (1.0 - g.rgb), step(0.5, b));
    else if ($6.x < 5.5) x = max(b - g.rgb, vec3(0.0)); else if ($6.x < 6.5) x = max(b, g.rgb); else if ($6.x < 7.5) x = min(b, g.rgb); else x = abs(b - g.rgb);
    s.rgb = mix(b, x, g.a * $5.w); }`,
  pack(p, ctx, o, i) {
    const r = ctx.rect
    let cols = Array.isArray(p.colors) && p.colors.length >= 2 ? p.colors : [p.color1 ?? p.color ?? p.from ?? '#ffffff', p.color2 ?? p.to ?? '#000000']
    const n = Math.min(4, cols.length)
    for (let k = 0; k < 4; k++) putCol(o, i + k * 4, cols[Math.min(k, n - 1)])
    const radial = [p.kind, p.gradient, p.shape].some((x) => x === 'radial' || x === 'circle')
    // angle = 0 で上(1 色目)から下(最後の色)へ。時計回りに回る
    const d = dirOf(num(p.angle, 0) + 180)
    const len = num(p.width ?? p.length, 0) > 0 ? num(p.width ?? p.length, 0) : radial ? Math.hypot(r.w, r.h) / 2 : Math.abs(d[0]) * r.w + Math.abs(d[1]) * r.h
    put(o, i + 16, r.x + r.w / 2 + num(p.cx, 0), r.y + r.h / 2 + num(p.cy, 0), d[0], d[1])
    put(o, i + 20, Math.max(1e-3, len), radial ? 1 : 0, n, pct(p.amount ?? p.strength, 100))
    put(o, i + 24, { normal: 0, add: 1, multiply: 2, screen: 3, overlay: 4, subtract: 5, lighten: 6, darken: 7, difference: 8 }[p.blend] ?? 0)
  },
}
R.gradient = R.gradient_overlay
R.border = {
  n: 3, alpha: true,
  color: `{ vec2 q = max($0.xy - $P, $P - $0.zw); float d = max(q.x, q.y); float k = OAA(d, 0.0, px) * (1.0 - OAA(d + $2.x, 0.0, px)) * $1.a; s = OOVER(s, $1.rgb, k); }`,
  pack(p, ctx, o, i) {
    const r = ctx.rect, w = Math.max(0, num(p.width, 4))
    if (w <= 0) return false
    const out = p.position === 'outside' ? w : p.position === 'center' ? w / 2 : 0
    put(o, i, r.x - out, r.y - out, r.x + r.w + out, r.y + r.h + out)
    const c = toColor(p.color ?? '#ffffff')
    put(o, i + 4, c[0], c[1], c[2], c[3] * pct(p.opacity, 100))
    put(o, i + 8, w)
    ctx.pad = Math.max(ctx.pad || 0, out + 1)
  },
}
R.noise = {
  n: 1,
  color: `{ vec2 np = floor($P); vec3 n = vec3(OH(np, $0.y));
    if ($0.z > 0.5) n = vec3(n.x, OH(np + 17.0, $0.y + 3.0), OH(np + 41.0, $0.y + 7.0));
    s.rgb = clamp(s.rgb + (n - 0.5) * $0.x, 0.0, 1.0); }`,
  pack(p, ctx, o, i) {
    put(o, i, num(p.amount, 10) / 100, (p.animated === false ? 0 : Math.round(ctx.f * 8) % 4096) + num(p.seed, 0), p.color ? 1 : 0)
  },
}

// 別の素材(画像・動画・コンポジション)をレイヤーの絵に重ねる / 色だけ置き換える
R.overlay_source = {
  n: 3, tex: true, alpha: true,
  // アルファが増えるのは over / under だけ(色の置き換え・輝度をアルファに、は増えない)
  // atop = 絵のある所にだけ重ねる(アルファはそのまま。AviUtl の画像・動画ファイル合成「前方から合成」: 文字や図形に絵を貼る)
  addsAlpha: (p) => !(p.mode === 'replace_color' || p.mode === 'luma_to_alpha' || p.mode === 'atop'),
  // 重ねる素材は、いまの絵の範囲の中だけに出る(AviUtl と同じ。絵の外へはみ出さない)
  color: `{ vec2 uv = ($P - $0.xy) / (2.0 * $0.zw) + 0.5; bool outb = uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0;
    if ($1.w > 0.5) { uv = fract(uv); outb = false; }
    if ($P.x < $2.x || $P.y < $2.y || $P.x > $2.z || $P.y > $2.w) outb = true;
    if ($1.z > 0.5) uv.y = 1.0 - uv.y;
    vec4 t0 = outb ? vec4(0.0) : texture2D($T, uv); vec4 t = t0 * $1.y;
    vec3 tc = t0.a > 1e-5 ? t0.rgb / t0.a : vec3(0.0);
    if ($1.x < 0.5) s = OOVER(s, tc, t.a);
    else if ($1.x < 1.5) { float a = s.a + t.a * (1.0 - s.a); s = vec4(a > 1e-5 ? (s.rgb * s.a + tc * t.a * (1.0 - s.a)) / a : s.rgb, a); }
    else if ($1.x < 2.5) s.rgb = mix(s.rgb, tc, clamp(t0.a * 64.0, 0.0, 1.0) * $1.y);
    else if ($1.x < 3.5) s.a *= outb ? 0.0 : OL(t.rgb);
    else s.rgb = mix(s.rgb, tc, t.a); }`,
  pack(p, ctx, o, i) {
    const e = ctx.overlay(p)
    if (!e) return false
    const r = ctx.rect, sc = vec(p.scale ?? 100, 2, 100)
    let w = e.w * sc[0] / 100, h = e.h * sc[1] / 100
    if (p.fit) { w = r.w; h = r.h }
    // anchor: 'top_left' = 箱の左上に素材の左上を合わせた所から x・y だけずらす(AviUtl の画像ファイル合成)。既定は中心どうし
    const tl = p.anchor === 'top_left' && !p.fit
    put(o, i, (tl ? r.x + w / 2 : r.x + r.w / 2) + num(p.x, 0), (tl ? r.y + h / 2 : r.y + r.h / 2) + num(p.y, 0), Math.max(1e-3, w / 2), Math.max(1e-3, h / 2))
    put(o, i + 4, { over: 0, under: 1, replace_color: 2, luma_to_alpha: 3, atop: 4 }[p.mode] ?? 0, pct(p.opacity, 100), e.flipY ? 1 : 0, p.repeat || p.tile ? 1 : 0)
    put(o, i + 8, ...extOf(ctx))
    ctx.tex = e.tex
  },
}

export const INLINE = R
export const isInline = (type) => type in R

// op の並び → GLSL。list: [{type, stage(0 = 複製の前の座標 / 1 = 後), slot(テクスチャの番号)}]
// 書いた順に評価する。切る・隠す op は m に掛けてためておき、アルファを足す・読む色の op(alpha: true。
// invert_alpha・border・overlay_source)の手前で s.a に掛けてから続ける。残りは最後に全体へ掛ける
// (掛け算どうしは順番を変えても同じなので、ふつうの並びでは今までと 1 ビットも変わらない)。
export function opsGlsl(list) {
  let n4 = 0, mask = '', color = '', ntex = 0, pending = false
  for (const op of list) {
    const r = R[op.type]
    const base = n4
    const sub = (src) => (op.stage ? src.replace(/\bpx\b/g, 'pxG') : src)
      .replace(/\$(\d)/g, (_, k) => `uOp[${base + +k}]`).replace(/\$P/g, op.stage ? 'pG' : 'pL').replace(/\$T/g, `uOpTex${op.slot | 0}`)
    if (r.mask) {
      if (color) { color += sub(r.mask) + '\n'; pending = true } // 色の op のあと: その場で計算して m にためる
      else mask += sub(r.mask) + '\n'
    }
    if (r.color) {
      if (r.alpha && (mask || pending)) { color += 's.a *= m; m = 1.0;\n'; pending = false }
      color += sub(r.color) + '\n'
    }
    if (r.tex) ntex = Math.max(ntex, (op.slot | 0) + 1)
    n4 += r.n
  }
  return { n4, mask, color, ntex }
}
export const MAX_OP_VEC4 = 96
export const MAX_OP_TEX = 2
