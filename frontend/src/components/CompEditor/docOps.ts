// 🎞 コンポジション文書の操作(React に依らない純関数)。
// どの関数も引数を書き換えず、変わった所だけ新しいオブジェクトにする(変わらないレイヤーは同じ参照のまま → 行の memo が効く)。
// 評価(evalProp)は tools/comp-kit/props.js と同じ式。

import type { AnimProp, CompDoc, CompSettings, Easing, Keyframe, Layer, PropValue } from './types'

// ── 小道具 ──────────────────────────────────────────────────────────────────

export const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** {k:[…]} か {v, wiggle} の形(= 定数ではない) */
export const isAnimObj = (p: unknown): p is AnimProp =>
  isObj(p) && (Array.isArray(p.k) || 'wiggle' in p || ('v' in p && Object.keys(p).every(k => k === 'v' || k === 'wiggle' || k === 'loop')))

/** キーフレームを持つか */
export const isKeyed = (p: unknown): p is AnimProp & { k: Keyframe[] } =>
  isObj(p) && Array.isArray(p.k) && p.k.length > 0

export const keysOf = (p: unknown): Keyframe[] => (isKeyed(p) ? p.k : [])

const FEPS = 1e-4
export const sameFrame = (a: number, b: number) => Math.abs(a - b) < FEPS
export const hasKeyAt = (p: unknown, f: number) => keysOf(p).some(k => sameFrame(k.f, f))

export const layerIn = (l: Layer) => (typeof l.in === 'number' ? l.in : 0)
export const layerOut = (l: Layer, dur: number) => (typeof l.out === 'number' ? l.out : dur)

// ── 評価(props.js と同じ) ────────────────────────────────────────────────────

function hash32(a: number, b = 0, c = 0) {
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
const rand01 = (seed: number, i = 0, k = 0) => hash32(seed, i, k) / 4294967296
function noise1(seed: number, k: number, t: number) {
  const i = Math.floor(t), u = t - i
  const a = rand01(seed, i, k) * 2 - 1, b = rand01(seed, i + 1, k) * 2 - 1
  return a + (b - a) * (u * u * (3 - 2 * u))
}

const HEX = /^#([0-9a-f]{3,8})$/i
export const isColorStr = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)
export function toColor(v: unknown, fallback: number[] = [1, 1, 1, 1]): number[] {
  if (Array.isArray(v)) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0, v[3] == null ? 1 : Number(v[3])]
  if (typeof v !== 'string') return fallback
  const m = HEX.exec(v)
  if (!m) return fallback
  let h = m[1]
  if (h.length === 3 || h.length === 4) h = [...h].map(x => x + x).join('')
  if (h.length !== 6 && h.length !== 8) return fallback
  const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
  c.push(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1)
  return c
}
/** 色(文字列か 0〜1 の配列)→ "#rrggbb"(アルファは落とす。<input type=color> 用) */
export function toHex6(v: unknown, fallback = '#ffffff'): string {
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase()
  if (!isColorStr(v) && !Array.isArray(v)) return fallback
  const c = toColor(v)
  const q = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')
  return `#${q(c[0])}${q(c[1])}${q(c[2])}`
}

function bounceOut(t: number) {
  const n = 7.5625, d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}
const EASE: Record<string, (t: number) => number> = {
  linear: t => t,
  hold: () => 0,
  easeIn: t => t * t,
  easeOut: t => 1 - (1 - t) * (1 - t),
  easeInOut: t => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  easeInCubic: t => t * t * t,
  easeOutCubic: t => 1 - (1 - t) ** 3,
  easeInOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - 4 * (1 - t) ** 3),
  easeInBack: t => 2.70158 * t * t * t - 1.70158 * t * t,
  easeOutBack: t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  easeOutElastic: t => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1),
  easeOutBounce: bounceOut,
  easeInBounce: t => 1 - bounceOut(1 - t),
  easeInExpo: t => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  easeOutExpo: t => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
}
function bezierEase(x1: number, y1: number, x2: number, y2: number, x: number) {
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t
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
export function ease(e: Easing | undefined, t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  if (Array.isArray(e)) return bezierEase(+e[0] || 0, +e[1] || 0, e[2] ?? 1, e[3] ?? 1, t)
  return (EASE[e ?? 'linear'] || EASE.linear)(t)
}

function lerpAny(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length), out = new Array(n)
    for (let i = 0; i < n; i++) out[i] = lerpAny(a[i], b[i], t)
    return out
  }
  if (isColorStr(a) || isColorStr(b)) {
    const ca = toColor(a), cb = toColor(b)
    return [0, 1, 2, 3].map(i => ca[i] + (cb[i] - ca[i]) * t)
  }
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(a)) out[k] = k in b ? lerpAny(a[k], b[k], t) : a[k]
    return out
  }
  return t < 1 ? a : b
}

function addWiggle(v: unknown, w: NonNullable<AnimProp['wiggle']>, sec: number): unknown {
  if (!w || !w.amp) return v
  const seed = (w.seed ?? 1) | 0, x = sec * (w.freq ?? 1)
  const amp = w.amp
  if (typeof v === 'number') return v + (Array.isArray(amp) ? amp[0] : amp) * noise1(seed, 0, x)
  if (Array.isArray(v)) {
    return v.map((c, i) => (typeof c === 'number' ? c + ((Array.isArray(amp) ? amp[i] ?? 0 : amp) || 0) * noise1(seed, i, x) : c))
  }
  return v
}

/**
 * プロパティ値を f コマ目で評価する。
 * wiggle=false(既定)なら揺れを足さない「元の値」を返す(編集欄に出す値。揺れを足した値を書き戻さないため)。
 */
export function evalProp<T = unknown>(p: unknown, f: number, dflt?: T, opts?: { fps?: number; wiggle?: boolean }): T {
  if (p == null) return dflt as T
  if (!isObj(p)) return p as T
  let v: unknown
  const k = p.k
  if (Array.isArray(k) && k.length) {
    const ks = k as Keyframe[]
    const n = ks.length
    let t = f
    const f0 = ks[0].f, f1 = ks[n - 1].f, span = f1 - f0
    if (p.loop && span > 0 && (t > f1 || t < f0)) {
      if (p.loop === 'pingpong') {
        const u = (((t - f0) % (2 * span)) + 2 * span) % (2 * span)
        t = f0 + (u > span ? 2 * span - u : u)
      } else t = f0 + ((((t - f0) % span) + span) % span)
    }
    if (t <= f0) v = ks[0].v
    else if (t >= f1) v = ks[n - 1].v
    else {
      // 二分探索(キーが多い文書でも速く)
      let lo = 0, hi = n - 1
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ks[m].f <= t) lo = m; else hi = m }
      const a = ks[lo], b = ks[lo + 1]
      if (a.e === 'hold') v = a.v
      else v = lerpAny(a.v, b.v, ease(a.e, (t - a.f) / Math.max(1e-9, b.f - a.f)))
    }
  } else if ('v' in p) v = p.v
  else if (p.wiggle) v = dflt
  else return p as T
  if (opts?.wiggle && p.wiggle) v = addWiggle(v ?? 0, p.wiggle as NonNullable<AnimProp['wiggle']>, f / (opts.fps || 30))
  return (v ?? dflt) as T
}

// ── プロパティ値の書き換え ────────────────────────────────────────────────────

const sortKeys = (k: Keyframe[]) => [...k].sort((a, b) => a.f - b.f)

/** f にキーを打つ(同じコマにあれば値だけ替え、イージングは残す) */
export function setKey(p: unknown, f: number, v: unknown, e?: Easing): AnimProp {
  const base: AnimProp = isObj(p) && (Array.isArray(p.k) || 'v' in p || 'wiggle' in p) ? { ...(p as AnimProp) } : {}
  const ks = Array.isArray(base.k) ? base.k : []
  delete base.v
  const i = ks.findIndex(k => sameFrame(k.f, f))
  if (i >= 0) {
    const nk = { ...ks[i], v }
    if (e !== undefined) nk.e = e
    base.k = ks.map((k, j) => (j === i ? nk : k))
  } else {
    const nk: Keyframe = { f, v }
    if (e !== undefined) nk.e = e
    base.k = sortKeys([...ks, nk])
  }
  return base
}

/** f のキーを消す。最後の 1 個を消したら定数(その値)に戻す。揺れは残す */
export function removeKey(p: unknown, f: number): PropValue {
  if (!isKeyed(p)) return p as PropValue
  const rest = p.k.filter(k => !sameFrame(k.f, f))
  if (rest.length === p.k.length) return p
  if (rest.length) return { ...p, k: rest }
  return toConst(p, p.k[0].v)
}

/** キーフレームをやめて定数 v にする(wiggle があれば {v, wiggle} で残す) */
export function toConst(p: unknown, v: unknown): PropValue {
  if (isObj(p) && p.wiggle) return { v, wiggle: p.wiggle } as AnimProp
  return v as PropValue
}

/** その場の値を書く: キーつきなら f にキー、{v,wiggle} なら v、定数なら置き換え */
export function setValueAt(p: unknown, f: number, v: unknown): PropValue {
  if (isKeyed(p)) return setKey(p, f, v)
  if (isObj(p) && ('wiggle' in p || 'v' in p) && !Array.isArray(p.k)) return { ...p, v } as AnimProp
  return v as PropValue
}

/** ◆ の切り替え: キーなし → f に打つ / f にキーあり → 消す / キーつきで f に無い → 足す */
export function toggleKey(p: unknown, f: number, dflt: unknown): PropValue {
  if (isKeyed(p)) {
    if (hasKeyAt(p, f)) return removeKey(p, f)
    return setKey(p, f, evalProp(p, f, dflt))
  }
  return setKey(p, f, evalProp(p, f, dflt))
}

/** キーを時間方向に動かす。frames に入っているコマのキーだけ delta ずらす(ぶつかった先のキーは置き換え) */
export function moveKeys(p: unknown, frames: number[], delta: number): PropValue {
  if (!isKeyed(p) || !delta) return p as PropValue
  const moving = p.k.filter(k => frames.some(f => sameFrame(f, k.f)))
  if (!moving.length) return p
  const moved = moving.map(k => ({ ...k, f: k.f + delta }))
  const stay = p.k.filter(k => !moving.includes(k) && !moved.some(m => sameFrame(m.f, k.f)))
  return { ...p, k: sortKeys([...stay, ...moved]) }
}

export function setKeyEase(p: unknown, frames: number[], e: Easing): PropValue {
  if (!isKeyed(p)) return p as PropValue
  return { ...p, k: p.k.map(k => (frames.some(f => sameFrame(f, k.f)) ? { ...k, e } : k)) }
}

/** プロパティ値の中のキーをすべて delta コマずらす(レイヤーの帯を動かしたとき) */
export function shiftProp<T>(p: T, delta: number): T {
  if (!isKeyed(p) || !delta) return p
  return { ...p, k: p.k.map(k => ({ ...k, f: k.f + delta })) } as T
}

// ── パス("transform.position" "effects.0.params.radius" "source.per_char.stagger") ──

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur == null) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** 不変の書き込み。value が undefined ならその項目を消す。途中が無ければ作る(数字の区切りは配列) */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const segs = path.split('.')
  const rec = (cur: unknown, i: number): unknown => {
    const seg = segs[i]
    const isIdx = /^\d+$/.test(seg)
    if (i === segs.length - 1) {
      if (Array.isArray(cur) && isIdx) { const a = [...cur]; a[+seg] = value; return a }
      const o: Record<string, unknown> = { ...(isObj(cur) ? cur : {}) }
      if (value === undefined) delete o[seg]
      else o[seg] = value
      return o
    }
    if (Array.isArray(cur) && isIdx) { const a = [...cur]; a[+seg] = rec(a[+seg], i + 1); return a }
    const o: Record<string, unknown> = { ...(isObj(cur) ? cur : {}) }
    o[seg] = rec(o[seg] ?? (/^\d+$/.test(segs[i + 1]) ? [] : undefined), i + 1)
    return o
  }
  return rec(obj, 0) as T
}

// ── レイヤー ────────────────────────────────────────────────────────────────

export const findLayer = (doc: CompDoc, id: string) => doc.layers.find(l => l.id === id)

export function updateLayer(doc: CompDoc, id: string, fn: (l: Layer) => Layer): CompDoc {
  let changed = false
  const layers = doc.layers.map(l => {
    if (l.id !== id) return l
    const n = fn(l)
    if (n !== l) changed = true
    return n
  })
  return changed ? { ...doc, layers } : doc
}

export function updateLayers(doc: CompDoc, ids: Iterable<string>, fn: (l: Layer) => Layer): CompDoc {
  const set = ids instanceof Set ? (ids as Set<string>) : new Set(ids)
  let changed = false
  const layers = doc.layers.map(l => {
    if (!set.has(l.id)) return l
    const n = fn(l)
    if (n !== l) changed = true
    return n
  })
  return changed ? { ...doc, layers } : doc
}

export function uniqueId(doc: CompDoc, base = 'L', extra?: Set<string>): string {
  const used = new Set(doc.layers.map(l => l.id))
  if (extra) extra.forEach(x => used.add(x))
  const stem = base.replace(/_?\d+$/, '') || 'L'
  for (let i = 1; ; i++) {
    const id = `${stem}${i}`
    if (!used.has(id)) return id
  }
}

/** レイヤーを index の位置に足す(0 = いちばん手前) */
export function addLayer(doc: CompDoc, layer: Layer, index = 0): CompDoc {
  const layers = [...doc.layers]
  layers.splice(Math.max(0, Math.min(layers.length, index)), 0, layer)
  return { ...doc, layers }
}

/** レイヤーを消す。消したレイヤーを親・マットにしていた参照も外す */
export function removeLayers(doc: CompDoc, ids: Iterable<string>): CompDoc {
  const set = new Set(ids)
  if (!set.size) return doc
  const layers = doc.layers.filter(l => !set.has(l.id)).map(l => {
    const badParent = l.parent != null && set.has(l.parent)
    const badMatte = !!l.matte && set.has(l.matte.layer)
    if (!badParent && !badMatte) return l
    const n = { ...l }
    if (badParent) n.parent = null
    if (badMatte) n.matte = null
    return n
  })
  return { ...doc, layers }
}

/** レイヤーの組を写して新しい id を振る(組の中どうしの親・マットの参照は新しい id に付け替える) */
export function cloneLayers(doc: CompDoc, src: Layer[]): Layer[] {
  const taken = new Set<string>()
  const map = new Map<string, string>()
  for (const l of src) {
    const id = uniqueId(doc, l.id, taken)
    taken.add(id)
    map.set(l.id, id)
  }
  const exists = new Set(doc.layers.map(l => l.id))
  return src.map(l => {
    const n: Layer = { ...structuredCloneSafe(l), id: map.get(l.id)! }
    if (n.parent != null) n.parent = map.get(n.parent) ?? (exists.has(n.parent) ? n.parent : null)
    if (n.matte) n.matte = map.has(n.matte.layer) ? { ...n.matte, layer: map.get(n.matte.layer)! } : exists.has(n.matte.layer) ? n.matte : null
    return n
  })
}

export const structuredCloneSafe = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** 選んだレイヤーをそれぞれのすぐ上に複製する。新しい id の一覧も返す */
export function duplicateLayers(doc: CompDoc, ids: string[]): { doc: CompDoc; newIds: string[] } {
  const set = new Set(ids)
  const src = doc.layers.filter(l => set.has(l.id))
  if (!src.length) return { doc, newIds: [] }
  const copies = cloneLayers(doc, src)
  const byOld = new Map(src.map((l, i) => [l.id, copies[i]]))
  const layers: Layer[] = []
  for (const l of doc.layers) {
    const c = byOld.get(l.id)
    if (c) layers.push({ ...c, name: `${l.name ?? l.id} 2` })
    layers.push(l)
  }
  return { doc: { ...doc, layers }, newIds: copies.map(c => c.id) }
}

/** 行の並べ替え: ids のレイヤーを(今の並びのまま)index の前へ移す。index は移す前の並びでの位置 */
export function moveLayer(doc: CompDoc, ids: string[], index: number): CompDoc {
  const set = new Set(ids)
  const moving = doc.layers.filter(l => set.has(l.id))
  if (!moving.length) return doc
  const before = doc.layers.slice(0, Math.max(0, index)).filter(l => !set.has(l.id)).length
  const rest = doc.layers.filter(l => !set.has(l.id))
  const layers = [...rest.slice(0, before), ...moving, ...rest.slice(before)]
  if (layers.every((l, i) => l === doc.layers[i])) return doc
  return { ...doc, layers }
}

/** レイヤーの中のすべてのキーフレームに fn を当てる(transform・source・effects・masks を再帰でたどる) */
function mapAnimProps(l: Layer, fn: <T>(p: T) => T): Layer {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6 || v == null || typeof v !== 'object') return v
    if (Array.isArray(v)) {
      let ch = false
      const a = v.map(x => { const y = walk(x, depth + 1); if (y !== x) ch = true; return y })
      return ch ? a : v
    }
    if (isKeyed(v)) return fn(v)
    let ch = false
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = walk(x, depth + 1)
      if (y !== x) ch = true
      o[k] = y
    }
    return ch ? o : v
  }
  const n: Layer = { ...l }
  for (const key of ['transform', 'source', 'effects', 'masks'] as const) {
    if (l[key] != null) (n as Record<string, unknown>)[key] = walk(l[key], 0)
  }
  // そのほかの入れ物(スキーマで足された repeater など)もたどる
  for (const [k, v] of Object.entries(l)) {
    if (['transform', 'source', 'effects', 'masks', 'matte'].includes(k)) continue
    if (v && typeof v === 'object') (n as Record<string, unknown>)[k] = walk(v, 0)
  }
  return n
}

/** 帯を動かす: in / out とすべてのキーフレームを delta コマずらす */
export function shiftLayerTime(l: Layer, delta: number, dur: number): Layer {
  if (!delta) return l
  const n = mapAnimProps(l, p => shiftProp(p, delta))
  n.in = layerIn(l) + delta
  n.out = layerOut(l, dur) + delta
  return n
}

/** 帯の端を詰める。in を動かしたとき、動画・入れ子は中身の位置が変わらないよう start も進める */
export function trimLayer(l: Layer, edge: 'in' | 'out', frame: number, dur: number): Layer {
  const i0 = layerIn(l), o0 = layerOut(l, dur)
  if (edge === 'in') {
    const f = Math.min(frame, o0 - 1)
    if (f === i0 && typeof l.in === 'number') return l
    const n: Layer = { ...l, in: f, out: o0 }
    if (l.type === 'video' || l.type === 'comp') n.start = Math.max(0, (l.start ?? 0) + (f - i0) * (l.speed ?? 1))
    return n
  }
  const f = Math.max(frame, i0 + 1)
  if (f === o0 && typeof l.out === 'number') return l
  return { ...l, in: i0, out: f }
}

/** f で 2 つに分ける(前半が元の id のまま上、後半が新しい id で下) */
export function splitLayer(doc: CompDoc, id: string, f: number, dur: number): { doc: CompDoc; newId: string | null } {
  const idx = doc.layers.findIndex(l => l.id === id)
  if (idx < 0) return { doc, newId: null }
  const l = doc.layers[idx]
  const i0 = layerIn(l), o0 = layerOut(l, dur)
  if (!(f > i0 && f < o0)) return { doc, newId: null }
  const newId = uniqueId(doc, l.id)
  const a: Layer = { ...l, in: i0, out: f }
  const b: Layer = { ...structuredCloneSafe(l), id: newId, in: f, out: o0, name: `${l.name ?? l.id} (後)` }
  if (l.type === 'video' || l.type === 'comp') b.start = (l.start ?? 0) + (f - i0) * (l.speed ?? 1)
  const layers = [...doc.layers]
  layers.splice(idx, 1, a, b)
  return { doc: { ...doc, layers }, newId }
}

// ── キーフレームのあるプロパティの一覧(行を開いたときに並べる) ──────────────

export interface KeyedProp { path: string; label: string; prop: AnimProp & { k: Keyframe[] } }

const TRANSFORM_LABEL: Record<string, string> = {
  position: '位置', anchor: 'アンカー', scale: '拡大', rotation: '回転', opacity: '不透明度',
}

export function collectKeyedProps(l: Layer): KeyedProp[] {
  const out: KeyedProp[] = []
  const walk = (v: unknown, path: string, label: string, depth: number) => {
    if (depth > 6 || v == null || typeof v !== 'object') return
    if (isKeyed(v)) { out.push({ path, label, prop: v }); return }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}.${i}`, `${label}[${i}]`, depth + 1)); return }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`, label ? `${label}.${k}` : k, depth + 1)
  }
  for (const [k, v] of Object.entries(l.transform ?? {})) walk(v, `transform.${k}`, TRANSFORM_LABEL[k] ?? k, 1)
  for (const [k, v] of Object.entries(l.source ?? {})) walk(v, `source.${k}`, k, 1)
  ;(l.effects ?? []).forEach((fx, i) => {
    for (const [k, v] of Object.entries(fx?.params ?? {})) walk(v, `effects.${i}.params.${k}`, `${fx.type}.${k}`, 2)
  })
  ;(l.masks ?? []).forEach((m, i) => {
    for (const [k, v] of Object.entries(m ?? {})) walk(v, `masks.${i}.${k}`, `マスク${i + 1}.${k}`, 2)
  })
  for (const [k, v] of Object.entries(l)) {
    if (['transform', 'source', 'effects', 'masks', 'matte'].includes(k)) continue
    if (v && typeof v === 'object') walk(v, k, k, 1)
  }
  return out
}

/** レイヤーのすべてのキーのコマ(重なりは 1 つに)。閉じた行の帯に出す小さな印用 */
export function allKeyFrames(l: Layer, max = 400): number[] {
  const set = new Set<number>()
  for (const kp of collectKeyedProps(l)) {
    for (const k of kp.prop.k) { set.add(k.f); if (set.size >= max) break }
    if (set.size >= max) break
  }
  return [...set].sort((a, b) => a - b)
}

// ── 文書の検査(JSON タブ・読み込み) ──────────────────────────────────────────

/** 文書として保存できるか。だめなら理由(日本語)を返す */
export function validateDoc(d: unknown): string | null {
  if (!isObj(d)) return '文書はオブジェクト({ … })にしてください'
  if (!Array.isArray(d.layers)) return 'layers は配列にしてください'
  const seen = new Set<string>()
  for (let i = 0; i < d.layers.length; i++) {
    const l = d.layers[i]
    if (!isObj(l)) return `layers[${i}] がオブジェクトではありません`
    if (typeof l.id !== 'string' || !l.id) return `layers[${i}] に文字列の id が要ります`
    if (seen.has(l.id)) return `レイヤーの id「${l.id}」が重なっています`
    seen.add(l.id)
  }
  return null
}

/** 読み込んだ文書を編集できる最低限の形に整える(知らない項目はそのまま) */
export function normalizeDoc(d: unknown): CompDoc {
  const o = isObj(d) ? d : {}
  const layers = Array.isArray(o.layers) ? (o.layers.filter(l => isObj(l) && typeof l.id === 'string') as unknown as Layer[]) : []
  return { ...o, layers } as CompDoc
}

// ── 時間の表示 ──────────────────────────────────────────────────────────────

export function timecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame))
  const fr = Math.max(1, Math.round(fps))
  const s = Math.floor(f / fps)
  const ff = Math.round(f - s * fps)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(Math.min(fr - 1, Math.max(0, ff)))}`
}

export const clampFrame = (f: number, s: CompSettings) => Math.min(Math.max(1, s.duration_frames) - 1, Math.max(0, Math.round(f)))

/** 数の丸め(編集で 0.30000000004 のような値を書かない) */
export const round = (v: number, digits = 3) => { const m = 10 ** digits; return Math.round(v * m) / m }
