// プロパティ値(定数 / キーフレーム / loop / wiggle)の評価と、決定論の乱数・色の小道具。
// ここにある関数は (値, コマ) だけから結果が決まる。時計も Math.random も使わない。

// ---- 決定論の乱数 ---------------------------------------------------------
export function hash32(a, b = 0, c = 0) {
  let h = (a | 0) ^ 0x9e3779b9
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = (h + Math.imul(b | 0, 0xc2b2ae35)) | 0
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f)
  h = (h + Math.imul(c | 0, 0x165667b1)) | 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}
// 0 以上 1 未満
export const rand01 = (seed, i = 0, k = 0) => hash32(seed, i, k) / 4294967296
export function strHash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
// 1 次元のなめらかなノイズ(-1〜1)。格子点の乱数を smoothstep でつなぐ
export function noise1(seed, k, t) {
  const i = Math.floor(t), u = t - i
  const a = rand01(seed, i, k) * 2 - 1, b = rand01(seed, i + 1, k) * 2 - 1
  const s = u * u * (3 - 2 * u)
  return a + (b - a) * s
}

// ---- 色 -------------------------------------------------------------------
const colorCache = new Map()
const HEX = /^#([0-9a-f]{3,8})$/i
export const isColorStr = (v) => typeof v === 'string' && HEX.test(v)
// "#rgb" "#rrggbb" "#rrggbbaa" または [r,g,b(,a)](0〜1)→ [r,g,b,a](0〜1、ストレート)
export function toColor(v, fallback = [1, 1, 1, 1]) {
  if (v == null) return fallback
  if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1]
  if (typeof v !== 'string') return fallback
  let c = colorCache.get(v)
  if (c) return c
  const m = HEX.exec(v)
  if (!m) return fallback
  let h = m[1]
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('')
  if (h.length !== 6 && h.length !== 8) return fallback
  c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  c.push(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1)
  colorCache.set(v, c)
  return c
}
export function toCss(v) {
  const c = toColor(v)
  const q = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255)
  return `rgba(${q(c[0])},${q(c[1])},${q(c[2])},${Math.min(1, Math.max(0, c[3])).toFixed(4)})`
}

// ---- イージング -----------------------------------------------------------
function bounceOut(t) {
  const n = 7.5625, d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}
const EASE = {
  linear: (t) => t,
  hold: () => 0,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - 4 * (1 - t) ** 3),
  easeInBack: (t) => 2.70158 * t * t * t - 1.70158 * t * t,
  easeOutBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  easeOutElastic: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1,
  easeOutBounce: bounceOut,
  easeInBounce: (t) => 1 - bounceOut(1 - t),
  easeInExpo: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  easeOutExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
}
// Penner 式の全種類(AviUtl の「イージング」スクリプトの番号 1〜41 と同じ並び)。
// 名前は inQuad / outQuad / inOutQuad / outInQuad … の形。
const PENNER_IN = {
  Quad: (t) => t * t,
  Cubic: (t) => t * t * t,
  Quart: (t) => t ** 4,
  Quint: (t) => t ** 5,
  Sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  Expo: (t) => (t <= 0 ? 0 : 2 ** (10 * (t - 1))),
  Circ: (t) => 1 - Math.sqrt(Math.max(0, 1 - t * t)),
  Elastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : -(2 ** (10 * (t - 1))) * Math.sin(((t - 1 - 0.075) * 2 * Math.PI) / 0.3)),
  Back: (t) => t * t * (2.70158 * t - 1.70158),
  Bounce: (t) => 1 - bounceOut(1 - t),
}
export const PENNER_ORDER = ['linear']
for (const name of ['Quad', 'Cubic', 'Quart', 'Quint', 'Sine', 'Expo', 'Circ', 'Elastic', 'Back', 'Bounce']) {
  const fin = PENNER_IN[name]
  const fout = (t) => 1 - fin(1 - t)
  EASE['in' + name] = fin
  EASE['out' + name] = fout
  EASE['inOut' + name] = (t) => (t < 0.5 ? fin(t * 2) / 2 : 1 - fin(2 - t * 2) / 2)
  EASE['outIn' + name] = (t) => (t < 0.5 ? fout(t * 2) / 2 : 0.5 + fin(t * 2 - 1) / 2)
  PENNER_ORDER.push('in' + name, 'out' + name, 'inOut' + name, 'outIn' + name)
}
export const EASE_NAMES = Object.keys(EASE)
// 3 次ベジェ(CSS の cubic-bezier と同じ)。x から媒介変数を解いて y を返す
function bezierEase(x1, y1, x2, y2, x) {
  const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
  const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t
  let lo = 0, hi = 1, t = x
  for (let i = 0; i < 24; i++) {
    const v = bx(t)
    if (Math.abs(v - x) < 1e-6) break
    if (v < x) lo = t
    else hi = t
    t = (lo + hi) / 2
  }
  return by(t)
}
export function ease(e, t) {
  if (t <= 0) return 0
  if (t >= 1) return 1
  if (Array.isArray(e)) return bezierEase(+e[0] || 0, +e[1] || 0, e[2] ?? 1, e[3] ?? 1, t)
  if (e && typeof e === 'object') {
    // {"pow": n}(TA の beki。n 乗で減速)/ {"penner": 番号} / {"back": 係数}
    if (e.penner != null) return (EASE[PENNER_ORDER[(e.penner | 0) - 1]] || EASE.linear)(t)
    if (e.pow != null) { const n = Math.max(0.01, +e.pow || 1); return e.out === false ? t ** n : 1 - (1 - t) ** n }
    if (e.back != null) {
      const s = +e.back || 1.70158, fin = (x) => x * x * ((s + 1) * x - s)
      if (e.mode === 'in') return fin(t)
      if (e.mode === 'inOut') return t < 0.5 ? fin(t * 2) / 2 : 1 - fin(2 - t * 2) / 2
      return 1 - fin(1 - t)
    }
    return t
  }
  return (EASE[e] || EASE.linear)(t)
}

// ---- 補間 -----------------------------------------------------------------
function lerpAny(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length), out = new Array(n)
    for (let i = 0; i < n; i++) out[i] = lerpAny(a[i], b[i], t)
    return out
  }
  if (isColorStr(a) || isColorStr(b)) {
    // 色は RGB で補間。片方が配列(0〜1)でもよい
    const ca = toColor(a), cb = toColor(b)
    return [0, 1, 2, 3].map((i) => ca[i] + (cb[i] - ca[i]) * t)
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out = {}
    for (const k of Object.keys(a)) out[k] = k in b ? lerpAny(a[k], b[k], t) : a[k]
    return out
  }
  return t < 1 ? a : b // 文字列など: 次のキーまで保持
}

function addWiggle(v, w, sec) {
  if (!w || !w.amp) return v
  const seed = (w.seed ?? 1) | 0, x = sec * (w.freq ?? 1)
  const amp = w.amp
  if (typeof v === 'number') return v + (Array.isArray(amp) ? amp[0] : amp) * noise1(seed, 0, x)
  if (Array.isArray(v)) {
    return v.map((c, i) =>
      typeof c === 'number' ? c + ((Array.isArray(amp) ? amp[i] ?? 0 : amp) || 0) * noise1(seed, i, x) : c)
  }
  return v
}

export const isAnimated = (p) => !!p && typeof p === 'object' && !Array.isArray(p) && (Array.isArray(p.k) || !!p.wiggle)

// p: 定数 / {k:[{f,v,e}], loop, wiggle} / {v, wiggle}。f はコマ(小数可)
export function evalProp(p, f, fps = 30, dflt) {
  if (p == null) return dflt
  if (typeof p !== 'object' || Array.isArray(p)) return p
  let v
  const k = p.k
  if (Array.isArray(k) && k.length) {
    const n = k.length
    let t = f
    const f0 = k[0].f, f1 = k[n - 1].f, span = f1 - f0
    if (p.loop && span > 0 && (t > f1 || t < f0)) {
      if (p.loop === 'pingpong') {
        let u = (((t - f0) % (2 * span)) + 2 * span) % (2 * span)
        t = f0 + (u > span ? 2 * span - u : u)
      } else t = f0 + ((((t - f0) % span) + span) % span)
    }
    if (t <= f0) v = k[0].v
    else if (t >= f1) v = k[n - 1].v
    else if (p.ignore_mid) {
      // 中間点無視: 最初のキーから最後のキーへ 1 本のイージング(途中のキーは見ない)
      v = lerpAny(k[0].v, k[n - 1].v, ease(p.e ?? k[0].e, (t - f0) / span))
    } else {
      // キーは少数なので線形探索で十分
      let i = 0
      while (i < n - 2 && k[i + 1].f <= t) i++
      const a = k[i], b = k[i + 1]
      if (a.e === 'hold') v = a.v
      else {
        const u = (t - a.f) / Math.max(1e-9, b.f - a.f)
        v = lerpAny(a.v, b.v, ease(a.e, u))
      }
    }
  } else if ('v' in p) v = p.v
  else if (p.wiggle) v = dflt
  else return p // ただのオブジェクト(gradient など)はそのまま
  if (p.wiggle) v = addWiggle(v ?? 0, p.wiggle, f / fps)
  return v ?? dflt
}

// 位置などのベクトル: 配列のプロパティ値のほか、{"x": <prop>, "y": <prop>, "z": <prop>} の分け書きも受ける
export function evalVec(p, f, fps, dflt) {
  if (p && typeof p === 'object' && !Array.isArray(p) && !Array.isArray(p.k) && !('v' in p) && !p.wiggle && ('x' in p || 'y' in p || 'z' in p)) {
    const d = Array.isArray(dflt) ? dflt : [dflt ?? 0, dflt ?? 0, dflt ?? 0]
    return [num(evalProp(p.x, f, fps), d[0] ?? 0), num(evalProp(p.y, f, fps), d[1] ?? 0), num(evalProp(p.z, f, fps), d[2] ?? 0)]
  }
  return evalProp(p, f, fps, dflt)
}

// オブジェクトの直下のプロパティをまとめて評価(source・effect の params 用)
export function evalAll(obj, f, fps) {
  const out = {}
  if (!obj) return out
  // null は「なし」の指定(fill: null など)なので、そのまま残す
  for (const key of Object.keys(obj)) out[key] = obj[key] === null ? null : evalProp(obj[key], f, fps)
  return out
}

// プロパティが取りうる最大の絶対値(ラスタライズの解像度を決めるための見積もり)
export function maxAbs(p, dflt = 0) {
  let m = 0
  const walk = (v) => {
    if (typeof v === 'number') m = Math.max(m, Math.abs(v))
    else if (Array.isArray(v)) v.slice(0, 2).forEach(walk)
  }
  if (p == null) return dflt
  if (typeof p === 'object' && !Array.isArray(p)) {
    if (!Array.isArray(p.k) && !('v' in p) && ('x' in p || 'y' in p)) return Math.max(maxAbs(p.x, dflt), maxAbs(p.y, dflt))
    if (Array.isArray(p.k)) p.k.forEach((key) => walk(key.v))
    else if ('v' in p) walk(p.v)
    const w = p.wiggle
    if (w) m += Array.isArray(w.amp) ? Math.max(...w.amp.map(Math.abs)) : Math.abs(w.amp || 0)
  } else walk(p)
  return m || dflt
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)
export const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : Array.isArray(v) && typeof v[0] === 'number' ? v[0] : d)
export const vec = (v, n, d = 0) => {
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = Array.isArray(v) ? (typeof v[i] === 'number' ? v[i] : d) : typeof v === 'number' ? v : d
  return out
}
