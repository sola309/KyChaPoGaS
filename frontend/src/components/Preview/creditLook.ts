/**
 * 🔤 字幕クリップ(kind='credit')の共通ロジック。DOM もストアも使わない(Node のテストからも読む)。
 * 契約: repo/outputs/pocky2026/v13/fix1101/credits_live/contract/credit_contract_v1.json(設計書 DESIGN_credit_clip.md §2〜§5)。
 * backend: app/services/credit_fx.py(書き出しの正)と同じ式。数値は Python の float64 と同じ順で計算する(差 ≤ 1e-9)。
 *
 *   字幕クリップ = 素材を持たないクリップ 1 本 = 字幕 1 枚。attrs_json = {"credit": CreditV1, ...ほかの欄はそのまま}
 *   出現・消失はクリップの端から数える(出現 = 先頭から a コマで屈折 → ガラス、消失 = 末尾の d コマで逆)。
 *   保持は持たない(= 長さ − 出現 − 消失)。位置・大きさは 2560×1440 の画面の px(書き出しの 2560 と同じ画面)。
 *   静的な地図(文字の形・屈折の向きなど)は backend が作る(POST /api/credits/maps)。ここはコマごとの数(frameScalars)だけ。
 *
 * 既定値・範囲・フォントの正は backend(GET /api/credits/meta)。ここにも同じ写しを持ち、meta が届く前やテストで使う
 * (registerCreditMeta で差し替える)。
 */

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
export type CreditAlign = 'left' | 'center' | 'right'

export interface CreditFonts { name_latin: string; name_ja: string; role_latin: string; role_ja: string; [k: string]: unknown }
export interface CreditTiming {
  appear_frames: number; disappear_frames: number
  sheen_start: number | null; sheen_end: number | null
  [k: string]: unknown
}
export interface CreditStyle {
  name_size: number; name_track: number; name_ja_scale: number; name_ja_track: number
  role_size: number; role_track: number; role_latin_scale: number; line_gap: number
  rim: number; edge_rgb: Vec3; shadow: number; glow: number; role_shadow: number
  shadow_sigma: number; shadow_off: Vec2; glow_sigma: number
  plate: number; plate_rgb: Vec3; plate_sigma: number
  sheen: number; sheen_width: number; glints: number; letter_var: number
  fonts: CreditFonts
  [k: string]: unknown
}
export interface CreditRefract {
  n_max: number; tube: number; slope_sat: number; letter: number; letter_sigma: number
  zoom: number; disp: number; fres: number; fres_pow: number; fres_rgb: Vec3
  hl: number; absorb: number; g0: number; fill_q: number
  [k: string]: unknown
}
export interface CreditV1 {
  v: 1
  role: string
  name: string
  align: CreditAlign
  pos: Vec2
  seed: number
  group: string
  label: string
  timing: CreditTiming
  style: CreditStyle
  refract: CreditRefract
  [k: string]: unknown
}
export interface CreditFontInfo { id: string; file?: string; ok?: boolean; [k: string]: unknown }
/** GET /api/credits/meta の中身(使う所だけ) */
export interface CreditMeta {
  contract_version?: number
  maps_version?: number
  defaults?: { credit?: Record<string, unknown> }
  ranges?: Record<string, unknown>
  fonts?: CreditFontInfo[]
  max_labels?: number
  max_glints?: number
  new_clip_duration_s?: number
  default_pos?: number[]
  [k: string]: unknown
}

export const DESIGN_W = 2560
export const DESIGN_H = 1440
export const MAX_LABELS = 64
export const MAX_GLINTS = 6
export const MAX_TEXT = 64

/** 契約 defaults.credit の写し(backend credit_fx.DEFAULTS と同じ。Node のテストで契約ファイルと突き合わせる) */
export const CREDIT_DEFAULT: CreditV1 = {
  v: 1,
  role: '',
  name: '',
  align: 'left',
  pos: [160, 1064],
  seed: 1,
  group: '',
  label: '',
  timing: { appear_frames: 24, disappear_frames: 20, sheen_start: null, sheen_end: null },
  style: {
    name_size: 88, name_track: 0.16, name_ja_scale: 0.8, name_ja_track: 0.1,
    role_size: 50, role_track: 0.2, role_latin_scale: 1.12,
    line_gap: 0.42, rim: 0.42, edge_rgb: [10, 70, 175],
    shadow: 0.9, glow: 0.1, role_shadow: 1.4, shadow_sigma: 0.075, shadow_off: [0.03, 0.02],
    glow_sigma: 0.11, plate: 0.0, plate_rgb: [20, 64, 150], plate_sigma: 0.45,
    sheen: 0.3, sheen_width: 0.55, glints: 3, letter_var: 0.05,
    fonts: {
      name_latin: 'urw_gothic_demi',
      name_ja: 'mplus_rounded_black',
      role_latin: 'urw_gothic_book',
      role_ja: 'mplus_rounded_bold',
    },
  },
  refract: {
    n_max: 1.5, tube: 1.2, slope_sat: 2.0, letter: 0.09, letter_sigma: 0.1,
    zoom: 0.008, disp: 0.07, fres: 0.55, fres_pow: 2.0, fres_rgb: [236, 246, 255],
    hl: 0.9, absorb: 0.1, g0: 0.55, fill_q: 0.6,
  },
}

/** 契約 ranges の写し(道のり → [lo, hi] / {int} / {vec} / {enum} / {null_or_int} / {enum_from}) */
export const CREDIT_RANGES: Record<string, unknown> = {
  'align': { enum: ['left', 'center', 'right'] },
  'pos': { vec: [[-1280, 3840], [-720, 2160]] },
  'seed': { int: [0, 2147483647] },
  'timing.appear_frames': { int: [0, 240] },
  'timing.disappear_frames': { int: [0, 240] },
  'timing.sheen_start': { null_or_int: [-240, 2400] },
  'timing.sheen_end': { null_or_int: [-240, 2400] },
  'style.name_size': [8, 400], 'style.name_track': [-0.2, 1.0], 'style.name_ja_scale': [0.3, 2.0], 'style.name_ja_track': [-0.2, 1.0],
  'style.role_size': [8, 300], 'style.role_track': [-0.2, 1.0], 'style.role_latin_scale': [0.3, 2.0],
  'style.line_gap': [0.0, 3.0], 'style.rim': [0.05, 2.0], 'style.edge_rgb': { vec: [[0, 255], [0, 255], [0, 255]] },
  'style.shadow': [0.0, 3.0], 'style.glow': [0.0, 2.0], 'style.role_shadow': [0.0, 4.0], 'style.shadow_sigma': [0.0, 1.0],
  'style.shadow_off': { vec: [[-1.0, 1.0], [-1.0, 1.0]] }, 'style.glow_sigma': [0.0, 1.0],
  'style.plate': [0.0, 1.0], 'style.plate_rgb': { vec: [[0, 255], [0, 255], [0, 255]] }, 'style.plate_sigma': [0.05, 2.0],
  'style.sheen': [0.0, 2.0], 'style.sheen_width': [0.05, 3.0], 'style.glints': { int: [0, 6] }, 'style.letter_var': [0.0, 0.5],
  'style.fonts.*': { enum_from: 'fonts[].id' },
  'refract.n_max': [1.0, 3.0], 'refract.tube': [0.0, 6.0], 'refract.slope_sat': [0.2, 10.0], 'refract.letter': [0.0, 1.0],
  'refract.letter_sigma': [0.01, 1.0], 'refract.zoom': [0.0, 0.1], 'refract.disp': [0.0, 0.5], 'refract.fres': [0.0, 3.0],
  'refract.fres_pow': [0.25, 8.0], 'refract.fres_rgb': { vec: [[0, 255], [0, 255], [0, 255]] }, 'refract.hl': [0.0, 3.0],
  'refract.absorb': [0.0, 1.0], 'refract.g0': [0.0, 0.95], 'refract.fill_q': [0.0, 3.0],
}

/** 契約 fonts の写し(ok は meta が届いてから分かる) */
export const CREDIT_FONTS: CreditFontInfo[] = [
  { id: 'urw_gothic_demi', file: 'URWGothic-Demi.otf' },
  { id: 'urw_gothic_book', file: 'URWGothic-Book.otf' },
  { id: 'mplus_rounded_black', file: 'MPLUSRounded1c-Black.ttf' },
  { id: 'mplus_rounded_bold', file: 'MPLUSRounded1c-Bold.ttf' },
  { id: 'mochiy_pop_one', file: 'MochiyPopOne-Regular.ttf' },
  { id: 'yusei_magic', file: 'YuseiMagic-Regular.ttf' },
]
/** フォントの見た目の名前(パネル用) */
export const FONT_LABEL: Record<string, string> = {
  urw_gothic_demi: 'URW Gothic Demi(太)',
  urw_gothic_book: 'URW Gothic Book(細)',
  mplus_rounded_black: 'M PLUS Rounded Black(太)',
  mplus_rounded_bold: 'M PLUS Rounded Bold',
  mochiy_pop_one: 'Mochiy Pop One',
  yusei_magic: 'Yusei Magic',
}

/** 地図を作り直す欄(契約 map_keys)。style は sheen・sheen_width 以外の全部 */
export const MAP_KEYS_CREDIT = ['role', 'name', 'align', 'pos', 'seed'] as const
export const MAP_KEYS_STYLE_EXCEPT = ['sheen', 'sheen_width'] as const
export const MAP_KEYS_REFRACT = ['slope_sat', 'letter_sigma', 'fres_pow'] as const
export const NEW_CLIP_DURATION_S = 3.0
export const DEFAULT_POS: Vec2 = [160, 1064]

// ── backend の meta(正)の受け取り ──────────────────────────────────────
let META: CreditMeta | null = null
const CACHE = new Map<string, CreditV1>()
/** GET /api/credits/meta の結果を登録する(以後の normalizeCredit / creditOf / mapsVersion がこれを使う) */
export function registerCreditMeta(meta: CreditMeta | null) { META = meta; CACHE.clear() }
export const creditMeta = (): CreditMeta | null => META
export const mapsVersion = (): number => (typeof META?.maps_version === 'number' ? META.maps_version : 1)
export const creditFonts = (): CreditFontInfo[] => (Array.isArray(META?.fonts) && META!.fonts!.length ? META!.fonts! : CREDIT_FONTS)
export const newClipDurationS = (): number =>
  (typeof META?.new_clip_duration_s === 'number' && META.new_clip_duration_s > 0 ? META.new_clip_duration_s : NEW_CLIP_DURATION_S)
export const defaultPos = (): Vec2 => {
  const p = META?.default_pos
  return Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'number' && Number.isFinite(x)) ? [p[0], p[1]] : [...DEFAULT_POS] as Vec2
}

// ── 小さな道具 ─────────────────────────────────────────────────────────
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => (v == null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)))
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? clone(base) : clone(over)
  const out: Obj = clone(base) as Obj
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v)
  return out
}
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
/** 整数化は 0.5 を上へ(= Math.round。backend credit_fx._round_int = floor(x + 0.5) と同じ) */
export const roundHalfUp = (x: number): number => Math.floor(x + 0.5)
/** 制御文字(C0・DEL・C1)を消し、64 文字(コードポイント)までに切る */
export function cleanText(v: unknown, d: string, max = MAX_TEXT): string {
  if (typeof v !== 'string') return d
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  const cps = Array.from(s)
  return cps.length > max ? cps.slice(0, max).join('') : s
}
/** 数として読めるのは有限の number だけ(真偽値・文字列・null は読めない = 既定値。backend _is_num と同じ) */
function readNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ── 範囲 ──────────────────────────────────────────────────────────────
function rangesTable(meta: CreditMeta | null | undefined): Record<string, unknown> {
  return isObj(meta?.ranges) ? { ...CREDIT_RANGES, ...(meta!.ranges as Obj) } : CREDIT_RANGES
}
/** 数値の範囲 [lo, hi](int / null_or_int も lo, hi を返す)。無ければ null */
export function creditRange(path: string, meta: CreditMeta | null = META): [number, number] | null {
  const r = rangesTable(meta)[path]
  const pair = (x: unknown): [number, number] | null =>
    Array.isArray(x) && x.length === 2 && x.every(y => typeof y === 'number' && Number.isFinite(y)) ? [x[0] as number, x[1] as number] : null
  if (pair(r)) return pair(r)
  if (isObj(r)) return pair(r.int) ?? pair(r.null_or_int) ?? null
  return null
}

// ── 正規化(backend credit_fx.normalize と同じ規則) ───────────────────────
/**
 * 字幕の設定を正規化する: 足りない欄は既定値、範囲に収める(整数は偶数丸め)、知らないフォントはその役の既定、
 * 文字は制御文字を消して 64 文字まで、知らない欄はそのまま残す。何度かけても同じ(冪等)。返り値は新しいオブジェクト
 */
export function normalizeCredit(raw: unknown, meta?: CreditMeta | null): CreditV1 {
  const m = meta === undefined ? META : meta
  const metaDefs = isObj(m?.defaults) && isObj((m!.defaults as Obj).credit) ? (m!.defaults as Obj).credit : {}
  const defs = deepMerge(CREDIT_DEFAULT, metaDefs) as Obj
  const src = isObj(raw) ? raw : {}
  const out = deepMerge(defs, src) as Obj
  const R = rangesTable(m)
  const fontIds = new Set((Array.isArray(m?.fonts) && m!.fonts!.length ? m!.fonts! : CREDIT_FONTS).map(f => String(f.id)))

  const sub = (k: string): Obj => {
    const d = isObj(defs[k]) ? defs[k] as Obj : {}
    out[k] = isObj(out[k]) ? out[k] : clone(d)
    return out[k] as Obj
  }
  const defAt = (path: string[]): unknown => path.reduce<unknown>((c, k) => (isObj(c) ? c[k] : undefined), defs)
  const fix = (obj: Obj, path: string[]) => {
    const key = path.join('.'), last = path[path.length - 1]
    const rule = R[key]
    const d = defAt(path)
    const v = obj[last]
    if (Array.isArray(rule) && rule.length === 2) {
      const n = readNum(v)
      obj[last] = n == null ? (typeof d === 'number' ? d : 0) : clamp(n, rule[0] as number, rule[1] as number)
    } else if (isObj(rule) && Array.isArray(rule.int)) {
      const [lo, hi] = rule.int as number[]
      const n = readNum(v)
      obj[last] = n == null ? (typeof d === 'number' ? d : 0) : clamp(roundHalfUp(n), lo, hi)
    } else if (isObj(rule) && Array.isArray(rule.null_or_int)) {
      const [lo, hi] = rule.null_or_int as number[]
      const n = readNum(v)
      obj[last] = n == null ? null : clamp(roundHalfUp(n), lo, hi)
    } else if (isObj(rule) && Array.isArray(rule.vec)) {
      const rs = rule.vec as number[][]
      // 成分ごと(足りない・読めない成分は既定値の成分。長すぎる分は捨てる)
      const dv = Array.isArray(d) ? d as number[] : rs.map(() => 0)
      const sv = Array.isArray(v) ? v : []
      obj[last] = rs.map((r, i) => { const n = readNum(sv[i]); return n == null ? dv[i] : clamp(n, r[0], r[1]) })
    } else if (isObj(rule) && Array.isArray(rule.enum)) {
      obj[last] = (rule.enum as unknown[]).includes(v) ? v : d
    }
  }

  out.v = 1
  // 文字(役職・名前・組・名札): 文字列でなければ空。制御文字を消して 64 文字まで
  for (const k of ['role', 'name', 'group', 'label']) out[k] = cleanText(k in src ? src[k] : defs[k], '')
  fix(out, ['align'])
  fix(out, ['pos'])
  fix(out, ['seed'])

  const tm = sub('timing')
  for (const k of ['appear_frames', 'disappear_frames', 'sheen_start', 'sheen_end']) fix(tm, ['timing', k])

  const st = sub('style')
  for (const k of Object.keys(CREDIT_DEFAULT.style)) {
    if (k === 'fonts') continue
    fix(st, ['style', k])
  }
  const df = (isObj(defAt(['style', 'fonts'])) ? defAt(['style', 'fonts']) : CREDIT_DEFAULT.style.fonts) as Obj
  const fo: Obj = isObj(st.fonts) ? st.fonts as Obj : clone(df)
  for (const k of ['name_latin', 'name_ja', 'role_latin', 'role_ja']) {
    const v = fo[k]
    fo[k] = typeof v === 'string' && fontIds.has(v) ? v : (typeof df[k] === 'string' ? df[k] : (CREDIT_DEFAULT.style.fonts as Obj)[k])
  }
  st.fonts = fo

  const rf = sub('refract')
  for (const k of Object.keys(CREDIT_DEFAULT.refract)) fix(rf, ['refract', k])
  return out as CreditV1
}

/** attrs_json(文字列)→ 辞書。壊れた JSON は空扱い */
export function parseCreditAttrs(raw: string | null | undefined): Obj {
  if (!raw) return {}
  try { const d = JSON.parse(raw); return isObj(d) ? d : {} } catch { return {} }
}
/**
 * クリップの attrs_json → 正規化ずみの字幕(同じ文字列は使い回す。返り値は書き換えないこと)。プレビューは毎コマ呼ぶ
 */
export function creditOf(attrsJson: string | null | undefined): CreditV1 {
  const key = attrsJson ?? ''
  const hit = CACHE.get(key)
  if (hit) return hit
  const c = normalizeCredit(parseCreditAttrs(key).credit)
  if (CACHE.size > 256) CACHE.clear()
  CACHE.set(key, c)
  return c
}
/** attrs_json の credit を書き換えた文字列(fn は正規化ずみの写しを受けて新しい字幕を返す。結果も正規化して丸ごと持つ) */
export function withCredit(attrsJson: string | null | undefined, fn: (c: CreditV1) => CreditV1 | Obj): string {
  const attrs = parseCreditAttrs(attrsJson)
  const cur = normalizeCredit(attrs.credit)
  const next = normalizeCredit(fn(clone(cur)))
  return JSON.stringify({ ...attrs, credit: next })
}

// ── 地図のキー ─────────────────────────────────────────────────────────
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (isObj(v)) {
    const o: Obj = {}
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k])
    return o
  }
  return v
}
/** 地図を作り直す欄だけ(正規化ずみから取る)。withPos = false なら pos を除く(位置だけの変更の見分け用) */
export function mapSubsetObj(c: CreditV1, withPos = true): Obj {
  const style: Obj = {}
  for (const [k, v] of Object.entries(c.style)) if (!(MAP_KEYS_STYLE_EXCEPT as readonly string[]).includes(k)) style[k] = v
  const refract: Obj = {}
  for (const k of MAP_KEYS_REFRACT) refract[k] = c.refract[k]
  const o: Obj = { role: c.role, name: c.name, align: c.align, seed: c.seed, style, refract }
  if (withPos) o.pos = c.pos
  return o
}
/** 契約の mapSubset: 地図の欄を JSON(キーは並べ替え) */
export function mapSubset(c: CreditV1): string { return JSON.stringify(sortKeys(mapSubsetObj(c, true))) }
/** 地図のキャッシュのキー = mapSubset | 枠 | 画面 | maps_version */
export function mapKey(c: CreditV1, box: readonly [number, number], content: readonly [number, number], mv = mapsVersion()): string {
  return `${mapSubset(c)}|${box[0]}x${box[1]}|${content[0]}x${content[1]}|${mv}`
}
/** 位置を除いたキー(位置だけ変わったときは、前の地図を動かして見せる) */
export function mapKeyNoPos(c: CreditV1, box: readonly [number, number], content: readonly [number, number], mv = mapsVersion()): string {
  return `${JSON.stringify(sortKeys(mapSubsetObj(c, false)))}|${box[0]}x${box[1]}|${content[0]}x${content[1]}|${mv}`
}

// ── 画面の対応(設計書 §3) ─────────────────────────────────────────────
export interface CreditGeometry {
  K: number
  s_d: number; off_d: Vec2
  s_o: number; off_o: Vec2
  /** 2560 画面の角の座標 → 枠の角の座標 */
  toBox: (u: number, v: number) => Vec2
  /** 枠の角の座標 → 2560 画面の角の座標 */
  fromBox: (x: number, y: number) => Vec2
}
export function geometry(box: readonly [number, number], content: readonly [number, number]): CreditGeometry {
  const [bw, bh] = box, [Wc, Hc] = content
  const s_d = Math.max(DESIGN_W / Wc, DESIGN_H / Hc)
  const off_d: Vec2 = [(Wc * s_d - DESIGN_W) / 2, (Hc * s_d - DESIGN_H) / 2]
  const s_o = Math.max(bw / Wc, bh / Hc)
  const off_o: Vec2 = [(Wc * s_o - bw) / 2, (Hc * s_o - bh) / 2]
  const K = s_o / s_d
  return {
    K, s_d, off_d, s_o, off_o,
    toBox: (u, v) => [(u + off_d[0]) * K - off_o[0], (v + off_d[1]) * K - off_o[1]],
    fromBox: (x, y) => [(x + off_o[0]) / K - off_d[0], (y + off_o[1]) / K - off_d[1]],
  }
}

// ── 地図の頭書き(KCM1 の JSON) ────────────────────────────────────────
export interface CreditMapsHeader {
  v: number
  key: string
  box: [number, number]
  content: [number, number]
  k: number
  x0: number; y0: number; W: number; H: number
  cx: number; cy: number
  name_ink: [number, number, number, number]
  glints: [number, number][]
  nlab: number
  letter_base: number[]; letter_ph: number[]; letter_hz: number[]
  star_r: number
  max_t: number; max_l: number; max_r: number
  ink_box_design: [number, number, number, number]
  ink_box_box: [number, number, number, number]
  empty: boolean
  build_ms?: number
  textures?: { name: string; channels: string[] }[]
  [k: string]: unknown
}

// ── コマごとの数(設計書 §5.1) ─────────────────────────────────────────
export const ease = (x: number): number => { const c = clamp01(x); return c * c * (3 - 2 * c) }

export interface CreditClipLike { id?: number; start_frame: number; duration_frames: number; opacity?: number | null; kind?: string; attrs_json?: string | null }
export interface CreditScalars {
  active: boolean
  i: number; dur: number; a: number; d: number
  e: number; s: number; g: number; pre: number
  F0: number; kR: number; kG: number; kB: number
  fresw: number; absw: number; hlw: number
  t: number
  fac: number[]
  sheen: { on: boolean; q: number; pos: number; yc: number; bw: number; amp: number; sw0: number; sw1: number }
  /** 各きらめきの強さ(0 = 出ない)。頭書きの glints と同じ順 */
  inten: number[]
  o: number
}
/** 出現・消失の進み e(クリップ先頭からのコマ i)。屈折だけ → ガラスの目安(0..1) */
export function eAt(i: number, dur: number, a: number, d: number): number {
  return Math.min(ease((i + 1) / (a + 1)), ease((dur - i) / (d + 1)))
}
/** ガラスの見た目の進み g(e)  */
export function gOf(e: number, g0: number): number { return ease(clamp01((e - g0) / (1 - g0))) }
/** 光の帯の強さ(帯の数は frameScalars の sheen) */
export function bandAt(sh: CreditScalars['sheen'], x: number, y: number): number {
  if (!sh.on || !(sh.bw > 0)) return 0
  const z = ((x - sh.pos) + 0.55 * (y - sh.yc)) / sh.bw
  return sh.amp * Math.exp(-(z * z))
}

/**
 * このコマ f(タイムラインの絶対コマ)の数。credit は正規化ずみ、header は地図の頭書き、clip は start/duration/opacity
 */
export function frameScalars(credit: CreditV1, header: Pick<CreditMapsHeader, 'empty' | 'nlab' | 'letter_base' | 'letter_ph' | 'letter_hz' | 'name_ink' | 'glints'>,
                             clip: Pick<CreditClipLike, 'start_frame' | 'duration_frames' | 'opacity'>, f: number, fps: number): CreditScalars {
  const i = f - clip.start_frame
  const dur = clip.duration_frames
  const tm = credit.timing, rf = credit.refract, st = credit.style
  const a = tm.appear_frames, d = tm.disappear_frames
  const active = i >= 0 && i < dur && !header.empty
  const e = Math.min(ease((i + 1) / (a + 1)), ease((dur - i) / (d + 1)))
  const s = clamp01((e - rf.g0) / (1 - rf.g0))
  const g = ease(s)
  const pre = e * (1 - g)
  const r0 = (rf.n_max - 1) / (rf.n_max + 1)
  const F0 = r0 * r0
  const kR = e * (1 - rf.disp * e), kG = e, kB = e * (1 + rf.disp * e)
  const fresw = rf.fres * pre
  const absw = rf.absorb * pre
  const hlw = 255 * rf.hl * 1.1 * Math.pow(e, 1.5) * (1 - g)
  const t = f / fps
  // 文字ごとの明るさ: 並びの長さぶん(契約: 長さ max(1, nlab)。空の字幕でも 1 つ。backend は zip で回す)
  const nlab = Math.min(MAX_LABELS, header.letter_base?.length ?? 0, header.letter_ph?.length ?? 0, header.letter_hz?.length ?? 0)
  const fac: number[] = new Array(nlab)
  for (let l = 0; l < nlab; l++) {
    fac[l] = header.letter_base[l] * (1 + 0.02 * Math.sin(2 * Math.PI * header.letter_hz[l] * t + header.letter_ph[l]))
  }
  const sw0 = tm.sheen_start ?? (a - 2)
  const sw1 = tm.sheen_end ?? (dur - d + 2)
  const q = sw1 > sw0 ? (i - sw0) / (sw1 - sw0) : 0
  const on = st.sheen > 0 && sw1 > sw0 && q >= -0.05 && q <= 1.05
  const [nx0, ny0, nx1, ny1] = header.name_ink
  const w = nx1 - nx0
  const sheen = {
    on, q, sw0, sw1,
    pos: nx0 - 0.35 * w + 1.7 * w * q,
    yc: (ny0 + ny1) / 2,
    bw: st.sheen_width * (ny1 - ny0),
    amp: on ? ease((q + 0.05) / 0.25) * ease((1.05 - q) / 0.25) : 0,
  }
  const inten: number[] = []
  for (const gl of (header.glints ?? []).slice(0, MAX_GLINTS)) {
    const b = bandAt(sheen as CreditScalars['sheen'], gl[0], gl[1])
    inten.push(b >= 0.08 ? 0.65 * b : 0)
  }
  const o = clamp01(clip.opacity ?? 1)
  return { active, i, dur, a, d, e, s, g, pre, F0, kR, kG, kB, fresw, absw, hlw, t, fac, sheen, inten, o }
}

// ── クリップ ───────────────────────────────────────────────────────────
export const isCreditClip = (c: Pick<CreditClipLike, 'kind'> | null | undefined): boolean => !!c && c.kind === 'credit'
/** 保持のコマ数(= 長さ − 出現 − 消失。負なら出現・消失が重なって、いちばん強い所でも満ちきらない) */
export const holdOf = (c: CreditV1, dur: number): number => dur - c.timing.appear_frames - c.timing.disappear_frames
/** タイムラインのラベル: 🔤 役職 名前 */
export function creditLabel(c: CreditV1): string {
  const name = c.name || '(名前なし)'
  return `🔤 ${c.role ? c.role + ' ' : ''}${name}`
}
/** 新しい字幕の設定(既定値 + 役職「役職」・名前「名前」・既定の位置) */
export function newCredit(role = '役職', name = '名前', pos: Vec2 = defaultPos()): CreditV1 {
  return normalizeCredit({ role, name, pos })
}
/** 2560 画面の 90% の範囲(タイトルセーフ) */
export const SAFE_AREA: [number, number, number, number] = [DESIGN_W * 0.05, DESIGN_H * 0.05, DESIGN_W * 0.95, DESIGN_H * 0.95]
export function outsideSafe(ink: readonly number[] | null | undefined): boolean {
  if (!ink || ink.length < 4) return false
  return ink[0] < SAFE_AREA[0] || ink[1] < SAFE_AREA[1] || ink[2] > SAFE_AREA[2] || ink[3] > SAFE_AREA[3]
}
