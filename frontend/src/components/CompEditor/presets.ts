// 🎞 アニメーションのプリセット。選んだレイヤーに、再生位置からふつうのキーフレームを書く(あとから自由に直せる)。

import type { CompSettings, Easing, Layer, PresetDesc } from './types'
import { evalProp, getPath, isKeyed, isObj, layerIn, layerOut, setKey, setPath, toConst } from './docOps'

export interface PresetCtx {
  frame: number        // 再生位置
  len: number          // 長さ(コマ)
  dist: number         // 動く距離(px)
  settings: CompSettings
  /** スキーマのプリセットの起点: true = 再生位置 / false = レイヤーの頭(in) */
  fromPlayhead?: boolean
}

export interface BuiltinPreset {
  id: string
  label: string
  group: string
  apply: (l: Layer, c: PresetCtx) => Layer
}

const vec = (v: unknown, nmin: number, d: number): number[] => {
  if (Array.isArray(v)) { const a = v.map(x => (typeof x === 'number' ? x : d)); while (a.length < nmin) a.push(d); return a }
  if (typeof v === 'number') return new Array(nmin).fill(v)
  return new Array(nmin).fill(d)
}

const cur = {
  position: (l: Layer, c: PresetCtx) => vec(evalProp(l.transform?.position, c.frame, [c.settings.width / 2, c.settings.height / 2]), 2, 0),
  scale: (l: Layer, c: PresetCtx) => vec(evalProp(l.transform?.scale, c.frame, [100, 100]), 2, 100),
  opacity: (l: Layer, c: PresetCtx) => { const v = evalProp<unknown>(l.transform?.opacity, c.frame, 100); return typeof v === 'number' ? v : 100 },
  rotation: (l: Layer, c: PresetCtx) => evalProp<unknown>(l.transform?.rotation, c.frame, 0),
}

/** transform.<name> に [コマ, 値, イージング] の列を書く */
function keys(l: Layer, name: string, list: [number, unknown, Easing?][]): Layer {
  let p: unknown = l.transform?.[name]
  for (const [f, v, e] of list) p = setKey(p, f, v, e)
  return { ...l, transform: { ...(l.transform ?? {}), [name]: p } }
}

const rotWith = (r: unknown, dz: number): unknown =>
  Array.isArray(r) ? r.map((x, i) => (i === (r.length >= 3 ? 2 : r.length - 1) && typeof x === 'number' ? x + dz : x)) : (typeof r === 'number' ? r : 0) + dz

function slide(dx: number, dy: number, e: Easing = 'easeOutCubic') {
  return (l: Layer, c: PresetCtx) => {
    const p = cur.position(l, c)
    const from = p.map((x, i) => (i === 0 ? x + dx * c.dist : i === 1 ? x + dy * c.dist : x))
    return keys(l, 'position', [[c.frame, from, e], [c.frame + c.len, p]])
  }
}

function fade(l: Layer, c: PresetCtx, from: number | null, to: number | null, e: Easing): Layer {
  const o = cur.opacity(l, c) || 100
  return keys(l, 'opacity', [[c.frame, from ?? o, e], [c.frame + c.len, to ?? o]])
}

export const LAYER_PRESETS: BuiltinPreset[] = [
  { id: 'fade_in', label: 'フェードイン', group: '出る・消える', apply: (l, c) => fade(l, c, 0, null, 'easeOut') },
  { id: 'fade_out', label: 'フェードアウト', group: '出る・消える', apply: (l, c) => fade(l, c, null, 0, 'easeIn') },
  { id: 'slide_left', label: 'スライドイン ←(右から)', group: 'スライド', apply: slide(1, 0) },
  { id: 'slide_right', label: 'スライドイン →(左から)', group: 'スライド', apply: slide(-1, 0) },
  { id: 'slide_up', label: 'スライドイン ↑(下から)', group: 'スライド', apply: slide(0, 1) },
  { id: 'slide_down', label: 'スライドイン ↓(上から)', group: 'スライド', apply: slide(0, -1) },
  { id: 'pop', label: 'ポップ', group: '拡大', apply: (l, c) => {
    const s = cur.scale(l, c)
    return keys(l, 'scale', [[c.frame, s.map(() => 0), 'easeOutBack'], [c.frame + c.len, s]])
  } },
  { id: 'spin_in', label: '回転しながら登場', group: '拡大', apply: (l, c) => {
    const s = cur.scale(l, c), r = cur.rotation(l, c)
    let n = keys(l, 'scale', [[c.frame, s.map(() => 0), 'easeOutCubic'], [c.frame + c.len, s]])
    n = keys(n, 'rotation', [[c.frame, rotWith(r, -180), 'easeOutCubic'], [c.frame + c.len, rotWith(r, 0)]])
    return fade(n, c, 0, null, 'easeOut')
  } },
  { id: 'bounce', label: 'バウンス(上から落ちてはねる)', group: 'スライド', apply: slide(0, -1, 'easeOutBounce') },
  { id: 'zoom_in', label: 'ズームイン', group: '拡大', apply: (l, c) => {
    const s = cur.scale(l, c)
    return fade(keys(l, 'scale', [[c.frame, s.map(x => x * 0.5), 'easeOutCubic'], [c.frame + c.len, s]]), c, 0, null, 'easeOut')
  } },
  { id: 'zoom_out', label: 'ズームアウト', group: '拡大', apply: (l, c) => {
    const s = cur.scale(l, c)
    return fade(keys(l, 'scale', [[c.frame, s.map(x => x * 1.6), 'easeOutCubic'], [c.frame + c.len, s]]), c, 0, null, 'easeOut')
  } },
  { id: 'blink', label: '点滅', group: '出る・消える', apply: (l, c) => {
    const o = cur.opacity(l, c) || 100
    const step = Math.max(1, Math.round(c.len / 6))
    const list: [number, unknown, Easing?][] = []
    for (let i = 0; i < 6; i++) list.push([c.frame + i * step, i % 2 ? o : 0, 'hold'])
    list.push([c.frame + 6 * step, o, 'hold'])
    return keys(l, 'opacity', list)
  } },
  { id: 'shake', label: 'シェイク(揺れ)', group: '揺れ', apply: (l, c) => {
    const p = l.transform?.position
    const w = { freq: 12, amp: Math.max(4, Math.round(c.dist / 15)), seed: 1 + (Math.abs(hashStr(l.id)) % 97) }
    const np = isKeyed(p) ? { ...p, wiggle: w } : { v: evalProp(p, c.frame, cur.position(l, c)), wiggle: w }
    return { ...l, transform: { ...(l.transform ?? {}), position: np } }
  } },
  { id: 'shake_off', label: '揺れを外す', group: '揺れ', apply: (l) => {
    const p = l.transform?.position
    if (!isObj(p) || !('wiggle' in p)) return l
    const rest = { ...p }
    delete rest.wiggle
    const np = isKeyed(rest) ? rest : toConst(null, rest.v)
    return { ...l, transform: { ...(l.transform ?? {}), position: np } }
  } },
]

function hashStr(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }

// ── テキストの 1 文字ずつ(source.per_char を書く) ────────────────────────────

const perChar = (extra: Record<string, unknown>) => (l: Layer, c: PresetCtx): Layer => {
  if (l.type !== 'text') return l
  const at = Math.max(0, Math.round(c.frame - layerIn(l)))
  const keep = isObj(l.source?.per_char) && isObj((l.source!.per_char as Record<string, unknown>).out)
    ? { out: (l.source!.per_char as Record<string, unknown>).out } : {}
  return { ...l, source: { ...(l.source ?? {}), per_char: { stagger: 2, order: 'forward', duration: c.len, e: 'easeOutCubic', at, ...extra, ...keep } } }
}

export const TEXT_PRESETS: BuiltinPreset[] = [
  { id: 'pc_fade', label: 'フェード', group: '1 文字ずつ', apply: perChar({ from: { opacity: 0 }, e: 'easeOut' }) },
  { id: 'pc_rise', label: '下から', group: '1 文字ずつ', apply: perChar({ from: { position: [0, 80], opacity: 0 } }) },
  { id: 'pc_scale', label: '拡大', group: '1 文字ずつ', apply: perChar({ from: { scale: [0, 0], opacity: 0 }, e: 'easeOutBack' }) },
  { id: 'pc_rotate', label: '回転', group: '1 文字ずつ', apply: perChar({ from: { rotation: -90, scale: [50, 50], opacity: 0 }, e: 'easeOutBack' }) },
  { id: 'pc_random', label: 'ランダム', group: '1 文字ずつ', apply: perChar({ order: 'random', seed: 7, from: { position: [0, 60], rotation: 25, scale: [60, 60], opacity: 0 } }) },
  { id: 'pc_off', label: '解除', group: '1 文字ずつ', apply: (l) => {
    if (!l.source || !('per_char' in l.source)) return l
    const s = { ...l.source }
    delete s.per_char
    return { ...l, source: s }
  } },
]

// ── スキーマのプリセット(schema.json の presets。決まりは schema.notes.presets) ──────────
//   ・apply のキーはレイヤーの点つきの道。値をそのまま書く(入れ物ごと置き換える)。
//   ・"effects+" のように + で終わるキーは、その配列の末尾に足す。
//   ・{"k":[…], "relative": true} のキーフレームは、f をレイヤーの in からの相対コマとして足す("out" = レイヤーの長さ)。
//     書き込むときに relative の印は外す。fromPlayhead のときは in の代わりに再生位置を起点にする。
export function applySchemaPreset(l: Layer, p: PresetDesc, c: PresetCtx): Layer {
  const i0 = c.fromPlayhead ? c.frame : layerIn(l)
  const len = Math.max(1, layerOut(l, c.settings.duration_frames) - i0)
  const resolve = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(resolve)
    if (!isObj(v)) return v
    if (Array.isArray(v.k) && v.relative === true) {
      const { relative: _r, ...rest } = v
      void _r
      const k = v.k.filter(isObj).map(key => ({ ...key, f: (key.f === 'out' ? len : Number(key.f) || 0) + i0 })).sort((a, b) => a.f - b.f)
      return { ...rest, k }
    }
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) o[k] = resolve(x)
    return o
  }
  let out = l
  for (const [key, tpl] of Object.entries(p.apply ?? {})) {
    const val = resolve(JSON.parse(JSON.stringify(tpl ?? null)))
    if (key.endsWith('+')) {
      const path = key.slice(0, -1)
      const cur = getPath(out, path)
      out = setPath(out, path, [...(Array.isArray(cur) ? cur : []), ...(Array.isArray(val) ? val : [val])])
    } else out = setPath(out, key, val)
  }
  return out
}
