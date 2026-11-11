/**
 * フィルターレイヤー(素材を持たない調整クリップ)の共通ロジック。
 *
 *   kind='solid': attrs {"color":"#000000","opacity_keys":[{"t":0,"v":0},{"t":N,"v":1}]}
 *       全画面の単色。不透明度(0..1) = キー補間 × clip.opacity
 *   kind='blur' : attrs {"blur_keys":[{"t":0,"v":0},{"t":8,"v":7}]}
 *       このレイヤーより下(先に合成された絵)を区間中だけガウスぼかし。
 *       v = 1920x1080 基準のシグマ(px)。出力解像度に比例してスケール。
 *   kind='satsuei': attrs {"strength_keys":[{"t":0,"v":1}], "satsuei":{...}}
 *       🎬 撮影(色・パラ・ライトリーク・レンズ・粒子)を下の絵にかける。効き(0..1) = キー補間 × clip.opacity。
 *       中身の式とプレビューは ../Preview/satsueiLook.ts・satsueiGL.ts(書き出しは backend satsuei_fx.py)。
 *
 * t = クリップ先頭からのフレーム。キー間は線形、先頭キー以前/最終キー以降は端の値を保持。
 * 書き出し側(backend ffmpeg_render.filter_key_value / _filter_parts)と同じ規則。
 */
import type { Clip } from '../../api/client'
import { shiftRainAttrs } from './rainFx'
import { sliceRingAttrs } from './ringMarks'
import { shiftSatsueiAttrs, satsueiOf, presetLabel } from '../Preview/satsueiLook'

export type FilterKind = 'solid' | 'blur' | 'satsuei'
export interface FKey { t: number; v: number }
export interface FilterAttrs {
  color?: string
  opacity_keys?: FKey[]
  blur_keys?: FKey[]
  strength_keys?: FKey[]
  [k: string]: unknown
}

export const isFilterClip = (c: Pick<Clip, 'kind'> | null | undefined): boolean =>
  !!c && (c.kind === 'solid' || c.kind === 'blur' || c.kind === 'satsuei')

/** ぼかしの既定の強さ(1080p基準シグマ) — 元ネタのぼかし相当 */
export const BLUR_DEFAULT = 7
export const BLUR_MAX = 60

export function parseFilterAttrs(raw: string | null | undefined): FilterAttrs {
  if (!raw) return {}
  try {
    const d = JSON.parse(raw)
    return d && typeof d === 'object' && !Array.isArray(d) ? d as FilterAttrs : {}
  } catch { return {} }
}

export const keysField = (kind: FilterKind) =>
  kind === 'solid' ? 'opacity_keys' : kind === 'satsuei' ? 'strength_keys' : 'blur_keys'
export const valueRange = (kind: FilterKind): [number, number] => kind === 'blur' ? [0, BLUR_MAX] : [0, 1]
/** キーが無いときの値(単色 = 不透明、撮影 = 全部効く、ぼかし = なし) */
export const defaultValue = (kind: FilterKind) => kind === 'blur' ? 0 : 1

/** キー列を正規化(数値化・クランプ・t昇順・同一tは後勝ち) */
export function normKeys(raw: unknown, kind: FilterKind): FKey[] {
  const [lo, hi] = valueRange(kind)
  const m = new Map<number, number>()
  if (Array.isArray(raw)) {
    for (const k of raw) {
      if (!k || typeof k !== 'object') continue
      const t = Number((k as FKey).t), v = Number((k as FKey).v)
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue
      m.set(Math.max(0, Math.round(t)), Math.max(lo, Math.min(hi, v)))
    }
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }))
}

export function getKeys(clip: Pick<Clip, 'kind' | 'attrs_json'>): FKey[] {
  const kind = clip.kind as FilterKind
  const a = parseFilterAttrs(clip.attrs_json)
  return normKeys(a[keysField(kind)], kind)
}

/** キー補間(線形・端は保持)。キー無しは既定値 */
export function keyValueAt(keys: FKey[], f: number, fallback: number): number {
  if (!keys.length) return fallback
  if (f <= keys[0].t) return keys[0].v
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i], b = keys[i + 1]
    if (f < b.t) return a.v + (b.v - a.v) * (f - a.t) / Math.max(1e-6, b.t - a.t)
  }
  return keys[keys.length - 1].v
}

export function filterValueAt(clip: Pick<Clip, 'kind' | 'attrs_json' | 'start_frame'>, frame: number): number {
  const kind = clip.kind as FilterKind
  return keyValueAt(getKeys(clip), frame - clip.start_frame, defaultValue(kind))
}

export function solidColor(clip: Pick<Clip, 'attrs_json'>): string {
  const c = String(parseFilterAttrs(clip.attrs_json).color ?? '#000000')
  if (/^#?[0-9a-fA-F]{6}$/.test(c)) return (c.startsWith('#') ? c : '#' + c).toLowerCase()
  if (/^#?[0-9a-fA-F]{3}$/.test(c)) return '#' + c.replace('#', '').split('').map(x => x + x).join('').toLowerCase()
  return '#000000'
}

export function withKeys(attrsJson: string, kind: FilterKind, keys: FKey[]): string {
  const a = parseFilterAttrs(attrsJson)
  a[keysField(kind)] = normKeys(keys, kind)
  return JSON.stringify(a)
}

/** 分割用: クリップ内オフセット off から len フレームを切り出したときのキー列(境界値を補う) */
export function sliceKeys(keys: FKey[], off: number, len: number, fallback: number): FKey[] {
  const out: FKey[] = [{ t: 0, v: keyValueAt(keys, off, fallback) }]
  for (const k of keys) if (k.t > off && k.t < off + len - 1) out.push({ t: k.t - off, v: k.v })
  if (len > 1) out.push({ t: len - 1, v: keyValueAt(keys, off + len - 1, fallback) })
  return out
}

/** 分割/復元時に引き継ぐフィールド。フィルタークリップ以外は空 */
export function filterCarry(clip: Clip, off = 0, len = clip.duration_frames): Partial<Clip> {
  // 🌧 雨クリップ(黒地の雨の層を screen で重ねる): 分割しても重ね方と設定を引き継ぐ。
  // 引き継がないと半分ずつが「通常」合成の黒い層になり、画面が真っ暗になる
  // (「寄りでのぼかし」の開始コマはクリップ先頭基準なので、後半はずらす)
  if (clip.kind === 'rain') return { kind: clip.kind, attrs_json: shiftRainAttrs(clip.attrs_json, off, len) ?? clip.attrs_json, opacity: clip.opacity, blend: clip.blend }
  if (!isFilterClip(clip)) {
    // 💍 指輪の位置の印(映像クリップの ring_marks): 分割しても半分ずつに引き継ぐ(右側は先頭基準のコマをずらす)。
    // 後ろ半分(= 元の終わりまで)は、右端を詰めて隠れていた印もそのまま持つ。分割の右側の頭出しは +off(splitClip と同じ)
    const tail = off + len >= clip.duration_frames
    const ra = sliceRingAttrs(clip.attrs_json, off, len, off, { asset_id: clip.asset_id, asset_in_frame: clip.asset_in_frame + off }, tail)
    return ra != null ? { attrs_json: ra } : {}
  }
  const kind = clip.kind as FilterKind
  const keys = getKeys(clip)
  let attrs = keys.length ? withKeys(clip.attrs_json, kind, sliceKeys(keys, off, len, defaultValue(kind))) : clip.attrs_json
  if (kind === 'satsuei') {
    // 🎬 撮影: ライトリークの始まりはクリップ先頭基準なので、後ろ半分はずらす(前に光り終わるものは捨てる)。
    // 前半分は前のクリップからの溶け(transition_in)も引き継ぐ(境目で分けた撮影の溶けが消えないように)
    attrs = shiftSatsueiAttrs(attrs, off) ?? attrs
    const tr = off === 0 && clip.transition_in
      ? { transition_in: clip.transition_in, transition_frames: clip.transition_frames, transition_ease: clip.transition_ease } : {}
    return { kind: clip.kind, attrs_json: attrs, opacity: clip.opacity, blend: clip.blend, ...tr }
  }
  return { kind: clip.kind, attrs_json: attrs, opacity: clip.opacity, blend: clip.blend }
}

/**
 * 左端のトリムで先頭が moved コマ動いたときのフィルタークリップの attrs_json(絶対時刻が変わらないようにずらす)。
 * キー: 詰めた分は先頭キーにその時点の値を置く(ClipBlock の左トリムと同じ)。🎬 撮影はライトリークの始まりもずらす。
 * 変わらなければ null
 */
export function shiftFilterHead(clip: Pick<Clip, 'kind' | 'attrs_json'>, moved: number): string | null {
  if (!moved || !isFilterClip(clip)) return null
  const kind = clip.kind as FilterKind
  const ks = getKeys(clip)
  let attrs = clip.attrs_json
  if (ks.length) {
    const shifted = moved > 0
      ? [{ t: 0, v: keyValueAt(ks, moved, defaultValue(kind)) }, ...ks.filter(k => k.t > moved).map(k => ({ t: k.t - moved, v: k.v }))]
      : ks.map(k => ({ t: k.t - moved, v: k.v }))
    attrs = withKeys(attrs, kind, shifted)
  }
  if (kind === 'satsuei') attrs = shiftSatsueiAttrs(attrs, moved) ?? attrs
  return attrs !== clip.attrs_json ? attrs : null
}

/** プリセット。dur=クリップ尺、ramp=ランプのフレーム数、peak=到達値 */
export type PresetId = 'up' | 'down' | 'up_hold' | 'hold_down' | 'const'
export function presetKeys(id: PresetId, dur: number, ramp: number, peak: number, base = 0): FKey[] {
  const last = Math.max(0, dur - 1)
  const r = Math.max(1, Math.min(Math.max(1, last), Math.round(ramp)))
  switch (id) {
    case 'up':        return [{ t: 0, v: base }, { t: last, v: peak }]
    case 'down':      return [{ t: 0, v: peak }, { t: last, v: base }]
    case 'up_hold':   return [{ t: 0, v: base }, { t: r, v: peak }]
    case 'hold_down': return [{ t: Math.max(0, last - r), v: peak }, { t: last, v: base }]
    case 'const':     return [{ t: 0, v: peak }]
  }
}

/** キーの時間を旧尺→新尺へ比例伸縮(「尺に合わせる」) */
export function rescaleKeys(keys: FKey[], fromLast: number, toLast: number): FKey[] {
  if (fromLast <= 0) return keys
  return keys.map(k => ({ t: Math.round(k.t * toLast / fromLast), v: k.v }))
}

export const fmtTc = (f: number, fps: number) => {
  const fi = Math.max(1, Math.round(fps))
  const s = Math.floor(f / fi)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(f % fi).padStart(2, '0')}`
}
/** "MM:SS:FF" / "SS:FF" / "123"(フレーム) → フレーム。不正は null */
export const parseTc = (s: string, fps: number): number | null => {
  const t = s.trim()
  if (/^\d+$/.test(t)) return Number(t)
  const p = t.split(':').map(Number)
  if (p.some(x => !Number.isFinite(x) || x < 0)) return null
  const fi = Math.max(1, Math.round(fps))
  if (p.length === 3) return (p[0] * 60 + p[1]) * fi + p[2]
  if (p.length === 2) return p[0] * fi + p[1]
  return null
}

const fmtV = (v: number) => String(Number(v.toFixed(2)))
export const filterLabel = (clip: Clip): string => {
  if (clip.kind === 'solid') {
    const ks = getKeys(clip)
    const r = ks.length > 1 ? ` ${fmtV(ks[0].v)}→${fmtV(ks[ks.length - 1].v)}` : ks.length ? ` ${fmtV(ks[0].v)}` : ''
    return `■ 単色 ${solidColor(clip)}${r}`
  }
  if (clip.kind === 'blur') {
    const ks = getKeys(clip)
    const mx = ks.length ? Math.max(...ks.map(k => k.v)) : 0
    return `◌ ぼかし σ${fmtV(mx)}`
  }
  if (clip.kind === 'satsuei') {
    // 🎬 プリセットの名前(手で変えた後も最後に当てたプリセット)。効きのキーがあれば範囲も
    const ks = getKeys(clip)
    const r = ks.length > 1 ? ` ${fmtV(ks[0].v)}→${fmtV(ks[ks.length - 1].v)}` : ks.length && ks[0].v < 1 ? ` ${fmtV(ks[0].v)}` : ''
    return `🎬 ${presetLabel(satsueiOf(clip.attrs_json).preset) || '撮影'}${r}`
  }
  return clip.kind
}
