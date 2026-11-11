/**
 * 🌧 雨フィルター(kind='rain' のクリップ)の共通ロジック。backend: app/services/rain_fx.py・app/routers/rain.py
 *
 *   素材 = 黒地に「そのカットの元動画の雨筋」だけを描いた層の動画。blend='screen' で下に重ねる。
 *   clip.opacity = 強さ(すぐ反映。プレビューの canvas screen + globalAlpha と書き出しの blend screen:all_opacity は同じ式)。
 *   attrs_json {"rain": {...}} = 層を作った設定。変えたら「雨を作り直す」(CPU ジョブ render_rain_layer)で層を作り直す。
 */
import type { AxiosRequestConfig } from 'axios'
import { api, type Clip, type Job } from '../../api/client'

export interface RainSettings {
  k: number; L: number; t0: number; t1: number; wmax: number; hmax: number; gap: number
  blur: number; lit: number; glow: number; twinkle: number; glint: number; cut: number; blur2: number | null
  src_asset_id?: number; src_offset?: number
  // 作ったときの記録(読み取りのみ)
  job_id?: number; asset_id?: number; rendered_at?: string; base_asset_ids?: number[]
}

/** 既定値(backend の rain_fx.SPEC と同じ。k は 1.0 = 強さはクリップの不透明度で持つ) */
export const RAIN_DEFAULTS: RainSettings = {
  k: 1.0, L: 9, t0: 3, t1: 14, wmax: 5, hmax: 90, gap: 1,
  blur: 0.6, lit: 0, glow: 0, twinkle: 0, glint: 0, cut: 0, blur2: null,
}
/** 層の見た目に効くキー(作り直しが要るかどうかの比較に使う) */
export const RAIN_KEYS = ['k', 'L', 't0', 't1', 'wmax', 'hmax', 'gap', 'blur', 'lit', 'glow', 'twinkle', 'glint', 'cut', 'blur2'] as const
export type RainKey = typeof RAIN_KEYS[number]

export const isRainClip = (c: Pick<Clip, 'kind'> | null | undefined): boolean => !!c && c.kind === 'rain'

export function parseAttrs(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const d = JSON.parse(raw)
    return d && typeof d === 'object' && !Array.isArray(d) ? d as Record<string, unknown> : {}
  } catch { return {} }
}

export function rainOf(clip: Pick<Clip, 'attrs_json'>): RainSettings {
  const r = parseAttrs(clip.attrs_json).rain
  return { ...RAIN_DEFAULTS, ...(r && typeof r === 'object' ? r as Partial<RainSettings> : {}) }
}

/**
 * 分割・左端のトリムで雨クリップの先頭が off コマ動いたときの attrs_json。len = 動いた後の尺。
 * 「寄りでのぼかし」の開始 cut はクリップ先頭からのコマ数なので、同じタイムラインのコマから始まるようにずらす
 * (ずらさないと、C27|C28 の境目で分けた後半を作り直したとき、寄りのぼかしが 68 コマ後ろへずれて消える)。
 * 層そのものは asset_in_frame で同じ絵のまま。cut が 0(なし)なら何もしない。
 */
export function shiftRainAttrs(raw: string | null | undefined, off: number, len: number): string | null | undefined {
  const attrs = parseAttrs(raw)
  const r = attrs.rain
  if (!off || !r || typeof r !== 'object') return raw
  const rain = { ...(r as Record<string, unknown>) }
  const cut = Number(rain.cut ?? 0)
  if (!(cut > 0)) return raw
  const c2 = cut - off
  if (c2 <= 0) {                // 新しい先頭がもう寄りの中: 全体を寄りのぼかしで作る
    if (rain.blur2 != null) rain.blur = rain.blur2
    rain.cut = 0
    rain.blur2 = null
  } else if (c2 >= len) {       // 寄りまで届かない
    rain.cut = 0
  } else {
    rain.cut = c2
  }
  return JSON.stringify({ ...attrs, rain })
}

const num = (v: unknown) => (v == null || v === '' ? null : Number(v))
export function sameLook(a: RainSettings, b: RainSettings): boolean {
  return RAIN_KEYS.every(k => {
    const x = num(a[k]), y = num(b[k])
    if (k === 'blur2') return (x ?? num(a.blur)) === (y ?? num(b.blur))
    return x === y
  })
}

/** 送る設定(作ったときの記録は送らない) */
export function lookOnly(s: RainSettings): Partial<RainSettings> {
  const o: Partial<RainSettings> = {}
  for (const k of RAIN_KEYS) (o as Record<string, unknown>)[k] = s[k]
  if (s.src_asset_id != null) o.src_asset_id = s.src_asset_id
  if (s.src_offset != null) o.src_offset = s.src_offset
  return o
}

export interface RainTake {
  asset_id: number; name: string; created_at: string
  start_frame: number | null; duration_frames: number | null; job_id: number | null
  cover_mean: number | null; base_asset_ids?: number[]; rain: RainSettings; current: boolean
}

// 失敗は画面の中で知らせるので、共通のエラートーストは出さない(__silent)
const silent = { __silent: true } as unknown as AxiosRequestConfig

export const rainApi = {
  render: (clipId: number, rain: Partial<RainSettings>) =>
    api.post<Job>(`/rain/clips/${clipId}/render`, { rain }, silent).then(r => r.data),
  create: (body: { track_id: number; start_frame: number; duration_frames: number; opacity?: number; rain?: Partial<RainSettings> }) =>
    api.post<Job>('/rain/clips', body, silent).then(r => r.data),
  takes: (clipId: number) => api.get<RainTake[]>(`/rain/clips/${clipId}/takes`, silent).then(r => r.data),
}

/** 一言で(テイク一覧用) */
export function rainSummary(s: RainSettings): string {
  const p = [`細さ≤${s.wmax}px`, `長さ≤${s.hmax}px`, `量${s.t0}`, `ぼかし${s.blur}`]
  if (s.glint) p.push(`きらめき${s.glint}`)
  if (s.glow) p.push(`にじみ${s.glow}`)
  if (s.lit) p.push(`明かり${s.lit}`)
  if (s.cut) p.push(`寄り${s.cut}f〜σ${s.blur2 ?? s.blur}`)
  return p.join(' ')
}
