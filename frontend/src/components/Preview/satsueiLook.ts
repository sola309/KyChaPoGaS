/**
 * 🎬 撮影レイヤー(kind='satsuei' のクリップ)の共通ロジック。DOM もストアも使わない(Node のテストからも読む)。
 * backend: app/services/satsuei_fx.py(書き出しと「書き出しと同じ絵」の基準)と同じ式。設計は 10/16 の撮影レイヤー設計書 §1〜§2。
 *
 *   撮影クリップ = 素材を持たない調整レイヤー。ここまでに合成した下の絵に、光の通り道の順でかける:
 *     ①空気(パラ・ライトリーク)→ ②レンズ(にじみ・光のにじみ・ハレーション・色ずれ・周辺減光)→ ③色(65³ の LUT)→ ④粒子 → ⑤効きで混ぜる
 *   attrs_json {"strength_keys": [{t, v}], "satsuei": {...SatsueiParams v1...}}
 *   効き m = clip.opacity × strength_keys(クリップ先頭基準のコマ。線形・端は保持。キーなし = 1)。m ≤ 0.001 なら何もしない。
 *   色は BT.709 のガンマのかかった RGB(0..1)のまま。光の足し算(ブルーム・リーク)だけ 2.4 乗の線形の光で。
 *   シグマ・粒の大きさは 1080p の高さ基準(描く高さ H で H/1080 倍)、色ずれ(ca)は 1920 幅基準(W/1920 倍)。
 *
 * プリセット・既定値・範囲の正は backend(GET /api/satsuei/meta)。ここにも同じ写しを持ち、meta が届く前やテストで使う
 * (registerSatsueiMeta で差し替える)。
 */

export type ParaBlend = 'screen' | 'multiply' | 'normal'
export type Vec2 = [number, number]
export type Vec3 = [number, number, number]

export interface SatsueiColor {
  exposure: number; lift: number; gamma: number; gain: number
  shadow_tint: Vec3; highlight_tint: Vec3
  contrast: number; pivot: number; shoulder: number
  sat: number; vibrance: number
  protect_sky: boolean; protect_skin: boolean; protect: number
  [k: string]: unknown
}
export interface SatsueiLens {
  diffusion: { amt: number; sigma: number; [k: string]: unknown }
  bloom: { amt: number; thr: number; knee: number; tint: Vec3; [k: string]: unknown }
  halation: { amt: number; thr: number; sigma: number; [k: string]: unknown }
  ca: number
  vignette: number
  [k: string]: unknown
}
export interface SatsueiPara { from: Vec2; to: Vec2; color: string; blend: ParaBlend; amt: number; [k: string]: unknown }
export interface SatsueiLeak {
  t0: number; attack: number; hold: number; release: number
  path: Vec2[]; size: Vec2; color: string; amt: number
  [k: string]: unknown
}
export interface SatsueiGrain { amt: number; size: number; [k: string]: unknown }
export interface SatsueiParams {
  v: 1
  preset: string
  color: SatsueiColor
  lens: SatsueiLens
  para: SatsueiPara[]
  leaks: SatsueiLeak[]
  grain: SatsueiGrain
  fit: unknown
  [k: string]: unknown
}
export interface SatsueiPreset { label: string; params: Record<string, unknown>; target: [number, number] | null }
/** GET /api/satsuei/meta の中身 */
export interface SatsueiMeta {
  defaults?: Record<string, unknown>
  ranges?: Record<string, unknown>
  presets?: Record<string, SatsueiPreset>
}

export const LUT_N = 65
/** BT.709 の明るさの重み(RGB の順) */
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722]
/** 光のにじみ(ブルーム)の 3 段のシグマ(1080p 基準)と重み */
export const BLOOM_SIGMAS: Vec3 = [17, 56, 141]
export const BLOOM_WEIGHTS: Vec3 = [0.5, 0.3, 0.2]
/** 色相の保護の範囲(度)。空 = 190..230、肌と赤い髪 = 330..30(0 をまたぐ) */
export const SKY_HUES: Vec2 = [190, 230]
export const SKIN_HUES: Vec2 = [330, 30]
export const MAX_PARA = 4
export const MAX_LEAKS = 8

/** 既定値(= 何もしない絵)。backend の satsuei_fx.DEFAULT と同じ */
export const SATSUEI_DEFAULT: SatsueiParams = {
  v: 1,
  preset: '',
  color: {
    exposure: 0, lift: 0, gamma: 1, gain: 1,
    shadow_tint: [0, 0, 0], highlight_tint: [0, 0, 0],
    contrast: 0, pivot: 0.45, shoulder: 1,
    sat: 1, vibrance: 0,
    protect_sky: false, protect_skin: false, protect: 1,
  },
  lens: {
    diffusion: { amt: 0, sigma: 11 },
    bloom: { amt: 0, thr: 0.8, knee: 0.1, tint: [1, 1, 1] },
    halation: { amt: 0, thr: 0.9, sigma: 8 },
    ca: 0,
    vignette: 0,
  },
  para: [],
  leaks: [],
  grain: { amt: 0, size: 1 },
  fit: null,
}
/** パラ・ライトリークを足すときの 1 個ぶんの既定値 */
export const PARA_DEFAULT: SatsueiPara = { from: [0.5, 0], to: [0.5, 0.6], color: '#bfe6ff', blend: 'screen', amt: 0.1 }
export const LEAK_DEFAULT: SatsueiLeak = {
  t0: 0, attack: 6, hold: 4, release: 14, path: [[0.9, 0.1]], size: [0.45, 0.35], color: '#ffd2a0', amt: 0.2,
}
export const MAX_PATH = 16

/** 範囲(下限, 上限)。DEFAULT と同じ入れ子。パラ・リークは 1 個ぶんの欄ごと。backend の satsuei_fx.RANGES と同じ。
 *  位置(パラの向き・リークの通り道)は画面の外から差し込む光のため、少しはみ出してよい(-0.5..1.5) */
export const SATSUEI_RANGES = {
  color: {
    exposure: [-2, 2], lift: [-0.2, 0.3], gamma: [0.5, 1.6], gain: [0.5, 1.5],
    shadow_tint: [-0.1, 0.1], highlight_tint: [-0.1, 0.1],
    contrast: [-0.5, 0.5], pivot: [0.1, 0.9], shoulder: [0.6, 1.0],
    sat: [0, 2], vibrance: [-1, 1], protect: [0, 1],
  },
  lens: {
    diffusion: { amt: [0, 1], sigma: [1, 60] },
    bloom: { amt: [0, 1], thr: [0.3, 1], knee: [0.01, 0.5], tint: [0, 2] },
    halation: { amt: [0, 0.5], thr: [0.5, 1], sigma: [1, 40] },
    ca: [0, 8],
    vignette: [0, 1],
  },
  para: { max: MAX_PARA, from: [-0.5, 1.5], to: [-0.5, 1.5], amt: [0, 1] },
  leaks: {
    max: MAX_LEAKS, t0: [-100000, 100000], attack: [1, 240], hold: [0, 2400], release: [1, 480],
    path: [-0.5, 1.5], path_max: MAX_PATH, size: [0.02, 2], amt: [0, 1],
  },
  grain: { amt: [0, 0.1], size: [0.5, 4] },
} as const

/** プリセット(10/16 試作 presets.py から。試作のシグマは 768 の高さ基準 → ×1.40625 で 1080 基準)。backend の PRESETS と同じ */
export const SATSUEI_PRESETS: Record<string, SatsueiPreset> = {
  ba_sunny: {
    label: 'ブルアカ風(晴れ)',
    params: {
      // lift は試作の 0.06 → 0.02(10/17。自動で合わせると全部が下の端まで下がっていた。backend の注を見る)
      color: { lift: 0.02, shadow_tint: [-0.010, 0.005, 0.035], gamma: 0.88, contrast: -0.08, shoulder: 0.82, sat: 0.92,
               protect_sky: true, protect_skin: true },
      lens: { bloom: { amt: 0.22, thr: 0.78, knee: 0.12, tint: [0.96, 1.0, 1.05] }, diffusion: { amt: 0.12, sigma: 11 } },
      para: [{ from: [0.5, 0.0], to: [0.5, 0.6], color: '#bfe6ff', blend: 'screen', amt: 0.10 }],
    },
    target: [0.26, 0.62],
  },
  rain_morning: {
    label: '雨の朝',
    params: {
      color: { lift: 0.03, shadow_tint: [-0.005, 0.0, 0.02], gamma: 0.94, shoulder: 0.85, sat: 0.95, protect_sky: true, protect_skin: true },
      lens: { bloom: { amt: 0.10, thr: 0.8, knee: 0.12 }, diffusion: { amt: 0.08, sigma: 11 } },
      para: [{ from: [0.5, 0.0], to: [0.5, 0.55], color: '#cfe8ff', blend: 'screen', amt: 0.08 }],
    },
    target: [0.17, 0.42],
  },
  rain_day: {
    label: '雨の昼',
    params: {
      color: { lift: 0.03, shadow_tint: [-0.004, 0.0, 0.015], gamma: 0.93, shoulder: 0.85, sat: 0.95, protect_sky: true, protect_skin: true },
      lens: { bloom: { amt: 0.10, thr: 0.8, knee: 0.12 }, diffusion: { amt: 0.08, sigma: 11 } },
    },
    target: [0.20, 0.45],
  },
  rain_night: {
    label: '雨の夜',
    params: {
      color: { lift: 0.0, shadow_tint: [-0.005, 0.004, 0.012], gamma: 1.0, shoulder: 0.88, sat: 0.92, protect_skin: true },
      lens: { bloom: { amt: 0.18, thr: 0.88, knee: 0.08, tint: [1.0, 0.98, 0.95] }, halation: { amt: 0.04, thr: 0.93, sigma: 7 },
              diffusion: { amt: 0.06, sigma: 8 } },
      para: [{ from: [0.5, 1.0], to: [0.5, 0.45], color: '#1a2a55', blend: 'multiply', amt: 0.10 }],
    },
    target: [0.10, 0.28],
  },
  // 10/17 E2E で足したもの(ba_sunny では夕日が薄く、教会の中の暗部が浮いた)
  sunset: {
    label: '夕焼け',
    params: {
      color: { lift: 0.02, gamma: 0.95, contrast: 0.0, shoulder: 0.85, sat: 1.02,
               highlight_tint: [0.020, 0.006, -0.018], shadow_tint: [-0.004, -0.002, 0.012], protect_skin: true },
      lens: { bloom: { amt: 0.18, thr: 0.75, knee: 0.12, tint: [1.06, 0.98, 0.88] }, diffusion: { amt: 0.06, sigma: 11 } },
      para: [{ from: [0.5, 0.0], to: [0.5, 0.55], color: '#ffd2a0', blend: 'screen', amt: 0.06 }],
    },
    target: [0.12, 0.40],
  },
  interior: {
    label: '室内(暗め)',
    params: {
      color: { lift: 0.0, gamma: 0.96, shoulder: 0.86, sat: 1.0, highlight_tint: [0.010, 0.004, -0.010], protect_skin: true },
      lens: { bloom: { amt: 0.16, thr: 0.80, knee: 0.10, tint: [1.04, 1.0, 0.94] }, halation: { amt: 0.03, thr: 0.92, sigma: 7 },
              diffusion: { amt: 0.05, sigma: 9 } },
    },
    target: [0.05, 0.30],
  },
  neutral: { label: 'なし(素のまま)', params: {}, target: null },
}

// ── backend の meta(正)の受け取り ──────────────────────────────────────
let META: SatsueiMeta | null = null
const CACHE = new Map<string, SatsueiParams>()
/** GET /api/satsuei/meta の結果を登録する(以後の normalizeSatsuei / satsueiOf / presetLabel がこれを使う) */
export function registerSatsueiMeta(meta: SatsueiMeta | null) { META = meta; CACHE.clear() }
export const satsueiMeta = (): SatsueiMeta | null => META
/** プリセット一覧(meta があればそれ、無ければ写し) */
export const satsueiPresets = (): Record<string, SatsueiPreset> => META?.presets ?? SATSUEI_PRESETS
export function presetLabel(name: string | null | undefined): string {
  if (!name) return ''
  return satsueiPresets()[name]?.label ?? SATSUEI_PRESETS[name]?.label ?? name
}
/** プリセットの設定(正規化ずみ、preset = 名前)。知らない名前は null */
export function presetParams(name: string, meta?: SatsueiMeta | null): SatsueiParams | null {
  const p = (meta ?? META)?.presets?.[name] ?? SATSUEI_PRESETS[name]
  if (!p) return null
  return normalizeSatsuei({ ...(p.params ?? {}), preset: name }, meta)
}

// ── 正規化(backend の normalize と同じ規則) ──────────────────────────────
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => (v == null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)))

/** 辞書は中まで重ね、それ以外(リスト・数値)は上書き */
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? clone(base) : clone(over)
  const out: Obj = clone(base) as Obj
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v)
  return out
}

/** 範囲の表を道のりで引く。[lo, hi] / {min, max} / {lo, hi} を受ける。無ければ写し、写しにも無ければ null */
function rangeAt(path: string[], meta: SatsueiMeta | null | undefined): [number, number] | null {
  const pick = (root: unknown): [number, number] | null => {
    let cur: unknown = root
    for (const k of path) {
      if (Array.isArray(cur) && cur.length && isObj(cur[0])) cur = cur[0]   // リストの 1 個ぶんの表
      if (!isObj(cur)) return null
      cur = cur[k]
    }
    if (Array.isArray(cur) && cur.length === 2 && cur.every(x => typeof x === 'number' && Number.isFinite(x))) return [cur[0], cur[1]]
    if (isObj(cur)) {
      const lo = Number(cur.min ?? cur.lo), hi = Number(cur.max ?? cur.hi)
      if (Number.isFinite(lo) && Number.isFinite(hi)) return [lo, hi]
    }
    return null
  }
  return (meta?.ranges ? pick(meta.ranges) : null) ?? pick(SATSUEI_RANGES)
}

/** 数(backend _num と同じ: 真偽値・null は既定値、数字の文字列は読む、範囲に収めて小数 6 桁に丸める) */
function toNum(v: unknown, d: number, r: [number, number] | null = null): number {
  if (typeof v === 'boolean' || v == null) return d
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return d
  const c = r ? Math.max(r[0], Math.min(r[1], n)) : n
  return Math.round(c * 1e6) / 1e6
}
/** 真偽(backend と同じ: 真偽値はそのまま、有限の数は 0 以外が真、ほかは既定値) */
const toBool = (v: unknown, d: boolean): boolean =>
  typeof v === 'boolean' ? v : typeof v === 'number' && Number.isFinite(v) ? v !== 0 : d
/** 並び(backend _vec と同じ: 長さが違えば既定値。2 つ組に 1 つの数が来たら縦横同じ) */
function toVec<T extends number[]>(v: unknown, d: T, r: [number, number] | null): T {
  if (typeof v === 'number' && d.length === 2) v = [v, v]
  if (!Array.isArray(v) || v.length !== d.length) return [...d] as T
  return d.map((dx, i) => toNum(v[i], dx, r)) as T
}
/** 位置 [x, y](backend _point と同じ: 2 つの有限の数でなければ null) */
function toPoint(v: unknown, r: [number, number] | null): Vec2 | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  if (!v.every(a => typeof a === 'number' && Number.isFinite(a))) return null
  return [toNum(v[0], 0, r), toNum(v[1], 0, r)]
}
/** 色("#rrggbb" / "rrggbb" / "#rgb")→ "#rrggbb"(小文字)。読めなければ d */
export function normHex(v: unknown, d: string): string {
  const c = typeof v === 'string' ? v.trim() : ''
  if (/^#?[0-9a-fA-F]{6}$/.test(c)) return (c.startsWith('#') ? c : '#' + c).toLowerCase()
  if (/^#?[0-9a-fA-F]{3}$/.test(c)) return '#' + c.replace('#', '').split('').map(x => x + x).join('').toLowerCase()
  return d
}
/** "#rrggbb" → [r, g, b](0..1) */
export function hexToRgb(hex: string): Vec3 {
  const h = normHex(hex, '#ffffff')
  return [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255) as Vec3
}

/**
 * 撮影の設定を正規化する(足りない欄は既定値で埋め、範囲に収め、壊れたリストの項目は捨て、パラ 4・リーク 8 個まで)。
 * 知らない欄(段階 2 の追加など)はそのまま残す。返り値は新しいオブジェクト。
 */
export function normalizeSatsuei(raw: unknown, meta?: SatsueiMeta | null): SatsueiParams {
  const m = meta === undefined ? META : meta
  const defs = deepMerge(SATSUEI_DEFAULT, isObj(m?.defaults) ? m!.defaults : {}) as Obj
  const src = isObj(raw) ? raw : {}
  const out = deepMerge(defs, src) as Obj
  const D = SATSUEI_DEFAULT
  const R = (...p: string[]) => rangeAt(p, m)
  const sec = (k: string, d: Obj): Obj => (isObj(src[k]) ? out[k] as Obj : clone(d))
  const cap = (path: string[], hard: number) => {
    const r = m?.ranges ? (path.reduce<unknown>((c, k) => (isObj(c) ? c[k] : undefined), m.ranges)) : undefined
    return Math.min(hard, typeof r === 'number' && r >= 0 ? Math.floor(r) : hard)
  }

  out.v = 1
  out.preset = typeof src.preset === 'string' ? src.preset.slice(0, 64) : ''
  out.fit = isObj(src.fit) ? clone(src.fit) : null

  const dc = (isObj(defs.color) ? defs.color : D.color) as SatsueiColor
  const c = sec('color', dc)
  for (const k of ['exposure', 'lift', 'gamma', 'gain', 'contrast', 'pivot', 'shoulder', 'sat', 'vibrance', 'protect'] as const)
    c[k] = toNum(c[k], toNum(dc[k], D.color[k]), R('color', k))
  c.shadow_tint = toVec(c.shadow_tint, D.color.shadow_tint, R('color', 'shadow_tint'))
  c.highlight_tint = toVec(c.highlight_tint, D.color.highlight_tint, R('color', 'highlight_tint'))
  c.protect_sky = toBool(c.protect_sky, !!dc.protect_sky)
  c.protect_skin = toBool(c.protect_skin, !!dc.protect_skin)
  out.color = c

  const dl = (isObj(defs.lens) ? defs.lens : D.lens) as SatsueiLens
  const l = sec('lens', dl)
  const sub = (k: 'diffusion' | 'bloom' | 'halation', fields: string[]) => {
    const dd = (isObj(dl[k]) ? dl[k] : D.lens[k]) as Obj
    const s = isObj(l[k]) ? l[k] as Obj : clone(dd)
    for (const f of fields) s[f] = toNum(s[f], toNum(dd[f], (D.lens[k] as Obj)[f] as number), R('lens', k, f))
    l[k] = s
    return s
  }
  sub('diffusion', ['amt', 'sigma'])
  const bl = sub('bloom', ['amt', 'thr', 'knee'])
  bl.tint = toVec(bl.tint, D.lens.bloom.tint, R('lens', 'bloom', 'tint'))
  sub('halation', ['amt', 'thr', 'sigma'])
  l.ca = toNum(l.ca, 0, R('lens', 'ca'))
  l.vignette = toNum(l.vignette, 0, R('lens', 'vignette'))
  out.lens = l

  // パラ: 向き(from/to)が読めない項目は捨てる。色が読めなければ既定の色
  const para: SatsueiPara[] = []
  const maxP = cap(['para', 'max'], MAX_PARA)
  for (const it of Array.isArray(src.para) ? src.para : []) {
    if (!isObj(it) || para.length >= maxP) continue
    const fr = toPoint(it.from === undefined ? PARA_DEFAULT.from : it.from, R('para', 'from'))
    const to = toPoint(it.to === undefined ? PARA_DEFAULT.to : it.to, R('para', 'to'))
    if (!fr || !to) continue
    const blend = it.blend === 'multiply' || it.blend === 'normal' || it.blend === 'screen' ? it.blend
      : it.blend === undefined ? PARA_DEFAULT.blend : 'screen'
    para.push({ ...it, from: fr, to, color: normHex(it.color, PARA_DEFAULT.color), blend,
                amt: toNum(it.amt, PARA_DEFAULT.amt, R('para', 'amt')) })
  }
  out.para = para

  // ライトリーク: 始まりなどが読めなければ既定値。通り道は 1 点だけ([x, y])でもよい。読めない点は捨てる
  const leaks: SatsueiLeak[] = []
  const maxL = cap(['leaks', 'max'], MAX_LEAKS), maxPath = cap(['leaks', 'path_max'], MAX_PATH)
  for (const it of Array.isArray(src.leaks) ? src.leaks : []) {
    if (!isObj(it) || leaks.length >= maxL) continue
    const pr = R('leaks', 'path')
    let rawPath: unknown = it.path === undefined ? LEAK_DEFAULT.path : it.path
    if (toPoint(rawPath, pr)) rawPath = [rawPath]
    const pts = Array.isArray(rawPath) ? rawPath.map(q => toPoint(q, pr)).filter((q): q is Vec2 => !!q) : []
    leaks.push({
      ...it,
      t0: toNum(it.t0, LEAK_DEFAULT.t0, R('leaks', 't0')),
      attack: toNum(it.attack, LEAK_DEFAULT.attack, R('leaks', 'attack')),
      hold: toNum(it.hold, LEAK_DEFAULT.hold, R('leaks', 'hold')),
      release: toNum(it.release, LEAK_DEFAULT.release, R('leaks', 'release')),
      path: (pts.length ? pts : LEAK_DEFAULT.path.map(q => [...q] as Vec2)).slice(0, maxPath),
      size: toVec(it.size, LEAK_DEFAULT.size, R('leaks', 'size')),
      color: normHex(it.color, LEAK_DEFAULT.color),
      amt: toNum(it.amt, LEAK_DEFAULT.amt, R('leaks', 'amt')),
    })
  }
  out.leaks = leaks

  const dg = (isObj(defs.grain) ? defs.grain : D.grain) as SatsueiGrain
  const g = sec('grain', dg)
  g.amt = toNum(g.amt, toNum(dg.amt, 0), R('grain', 'amt'))
  g.size = toNum(g.size, toNum(dg.size, 1), R('grain', 'size'))
  out.grain = g
  return out as SatsueiParams
}

/** attrs_json(文字列)→ {attrs, satsuei}。壊れた JSON は空扱い */
export function parseSatsueiAttrs(raw: string | null | undefined): Obj {
  if (!raw) return {}
  try {
    const d = JSON.parse(raw)
    return isObj(d) ? d : {}
  } catch { return {} }
}
/**
 * クリップの attrs_json → 正規化ずみの撮影の設定(同じ文字列は使い回す。返り値は書き換えないこと)。
 * プレビューは毎コマ呼ぶので、JSON の読み直しと正規化を省く
 */
export function satsueiOf(attrsJson: string | null | undefined): SatsueiParams {
  const key = attrsJson ?? ''
  const hit = CACHE.get(key)
  if (hit) return hit
  const p = normalizeSatsuei(parseSatsueiAttrs(key).satsuei)
  if (CACHE.size > 256) CACHE.clear()
  CACHE.set(key, p)
  return p
}

// ── 色(LUT) ───────────────────────────────────────────────────────────
/** 色の欄だけのキー(LUT を作り直すかどうかの比較に使う) */
export function colorKey(p: SatsueiParams): string {
  const c = p.color
  return [c.exposure, c.lift, c.gamma, c.gain, ...c.shadow_tint, ...c.highlight_tint, c.contrast, c.pivot, c.shoulder,
          c.sat, c.vibrance, c.protect_sky ? 1 : 0, c.protect_skin ? 1 : 0, c.protect].join(',')
}
let IDENTITY_KEY = ''
/** 色が何もしないか(既定値のまま) */
export function colorIsIdentity(p: SatsueiParams): boolean {
  if (!IDENTITY_KEY) IDENTITY_KEY = colorKey(SATSUEI_DEFAULT)
  return colorKey(p) === IDENTITY_KEY
}

const f32 = Math.fround
/** 黒の近くで効きを弱める幅(backend の TOE)。smoothstep(0, TOE, x) */
export const TOE = 0.1
/** 白の肩: 白(1,1,1)が肩の始まり + これより上なら tanh で丸めて 1 へ、届かなければ直線で 1 へ(backend の WHITE_EPS) */
export const WHITE_EPS = 1e-4
const toe = (x: number) => {
  let t = f32(x * 10)
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return f32(f32(t * t) * f32(3 - f32(2 * t)))
}
/** 65³ の 3D LUT を作る(backend satsuei_fx.color_ops と同じ式。並びは [b][g][r][rgb] = .cube と同じく赤が最も速い)。
 *  試作 looks.py からの変更(10/17): 黒の近く(TOE より下)で Lift・影の色・コントラストを弱める(真っ黒は真っ黒のまま)、
 *  白の肩で白(1,1,1)をチャンネルごとにちょうど 1 にする。
 *  numpy の float32 の計算に合わせて、途中の値を 1 つずつ float32 に丸める(色相の保護の境目で結果が割れないように) */
export function buildLut(params: SatsueiParams, n = LUT_N): Float32Array {
  const c = params.color
  const L0 = f32(LUMA[0]), L1 = f32(LUMA[1]), L2 = f32(LUMA[2])
  const expOn = c.exposure !== 0, expMul = f32(2 ** c.exposure)
  const lift = f32(c.lift), gam = f32(c.gamma), gain = f32(c.gain)
  const st0 = f32(c.shadow_tint[0]), st1 = f32(c.shadow_tint[1]), st2 = f32(c.shadow_tint[2])
  const ht0 = f32(c.highlight_tint[0]), ht1 = f32(c.highlight_tint[1]), ht2 = f32(c.highlight_tint[2])
  const conOn = c.contrast !== 0, pivot = f32(c.pivot), con32 = f32(c.contrast)
  const shOn = c.shoulder < 1, k32 = f32(c.shoulder), omk = f32(1 - c.shoulder)
  const satM1 = f32(c.sat - 1), prot32 = f32(c.protect), vibOn = c.vibrance !== 0, vib32 = f32(c.vibrance)
  const eps = f32(1e-6)
  const sky = c.protect_sky, skin = c.protect_skin
  // 露出・Lift/Gamma/Gain はチャンネルごとに独立なので、格子の値ごとに 1 回だけ計算する
  // (Lift = x + lift·(1−x)·toe(x): 0.10 より上は x·(1−lift)+lift と同じ、0 は 0 のまま)
  const pre = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = f32(i / (n - 1))
    if (expOn) v = f32(v * expMul)
    v = f32(v + f32(f32(lift * f32(1 - v)) * toe(v)))
    if (v < 0) v = 0
    pre[i] = f32(gain * f32(Math.pow(v, gam)))
  }
  // 影の色の重み(1−Y)²·toe(Y)・ハイライトの色の重み Y²(Y = 影とハイライトの色の前の明るさ)
  const weights = (x0: number, x1: number, x2: number): [number, number] => {
    const Y = f32(f32(f32(x0 * L0) + f32(x1 * L1)) + f32(x2 * L2))
    const ws = f32(1 - Y), wsc = ws < 0 ? 0 : ws > 1 ? 1 : ws, whc = Y < 0 ? 0 : Y > 1 ? 1 : Y
    return [f32(f32(wsc * wsc) * toe(Y)), f32(whc * whc)]
  }
  // 影とハイライトの色 → コントラスト(pivot のまわり。黒の近くでは弱める)
  const tone = (v: number, t1: number, t2: number, ws2: number, wh2: number) => {
    v = f32(f32(v + f32(t1 * ws2)) + f32(t2 * wh2))
    if (conOn) v = f32(v + f32(f32(con32 * f32(v - pivot)) * toe(v)))
    return v
  }
  // 白の肩: チャンネルごとに、白が肩の手前で取る値 w を 1 へ。w > k: tanh を tanh((w−k)/(1−k)) で割る。
  // w ≤ k(白が肩まで届かない): 肩の始まりを k·w に下げ、その上を直線で伸ばす。w がほぼ 0 なら前の肩だけ
  const p1 = pre[n - 1]
  const [ws1, wh1] = weights(p1, p1, p1)
  const white = [tone(p1, st0, ht0, ws1, wh1), tone(p1, st1, ht1, ws1, wh1), tone(p1, st2, ht2, ws1, wh1)]
  const shMode = [0, 0, 0], shA = [0, 0, 0], shS = [0, 0, 0]   // 1 = tanh(shS = 分母)、2 = 直線(shA = 始まり, shS = 傾き)
  if (shOn) for (let ch = 0; ch < 3; ch++) {
    const w = white[ch]
    if (w > k32 + WHITE_EPS) { shMode[ch] = 1; shA[ch] = k32; shS[ch] = f32(Math.tanh(f32(f32(w - k32) / omk))) }
    else if (w > 1e-3) { const a = f32(k32 * w); shMode[ch] = 2; shA[ch] = a; shS[ch] = f32(f32(1 - a) / f32(w - a)) }
    else { shMode[ch] = 0; shA[ch] = k32; shS[ch] = 1 }
  }
  const shoulder = (v: number, ch: number) => {
    const a = shA[ch]
    if (!(v > a)) return v
    if (shMode[ch] === 2) return f32(a + f32(f32(v - a) * shS[ch]))
    const tt = f32(omk * f32(Math.tanh(f32(f32(v - a) / omk))))
    return f32(a + (shMode[ch] === 1 ? f32(tt / shS[ch]) : tt))
  }
  const lut = new Float32Array(n * n * n * 3)
  let o = 0
  for (let bi = 0; bi < n; bi++) for (let gi = 0; gi < n; gi++) for (let ri = 0; ri < n; ri++) {
    let x0 = pre[ri], x1 = pre[gi], x2 = pre[bi]
    // 影とハイライトの色(明るさで重みを付けて足す)・コントラスト・白の肩
    const [ws2, wh2] = weights(x0, x1, x2)
    x0 = tone(x0, st0, ht0, ws2, wh2); x1 = tone(x1, st1, ht1, ws2, wh2); x2 = tone(x2, st2, ht2, ws2, wh2)
    if (shOn) { x0 = shoulder(x0, 0); x1 = shoulder(x1, 1); x2 = shoulder(x2, 2) }
    // 彩度(色相の保護つき)と自然な彩度
    const Y = f32(f32(f32(x0 * L0) + f32(x1 * L1)) + f32(x2 * L2))
    let sat = f32(1 + satM1)
    if (sky || skin || vibOn) {
      const r = x0 < 0 ? 0 : x0 > 1 ? 1 : x0, g = x1 < 0 ? 0 : x1 > 1 ? 1 : x1, b = x2 < 0 ? 0 : x2 > 1 ? 1 : x2
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b)
      const dmn = f32(mx - mn), d = f32(dmn + eps)
      let prot = 0
      if (sky || skin) {
        let h: number
        if (mx === r) { h = f32(f32(g - b) / d); if (h < 0) h = f32(h + 6) }
        else if (mx === g) h = f32(f32(f32(b - r) / d) + 2)
        else h = f32(f32(f32(r - g) / d) + 4)
        h = f32(h * 60)
        if ((sky && h >= SKY_HUES[0] && h <= SKY_HUES[1]) || (skin && (h >= SKIN_HUES[0] || h <= SKIN_HUES[1]))) prot = 1
      }
      sat = f32(1 + f32(satM1 * f32(1 - f32(prot32 * prot))))
      if (vibOn) {
        const s0 = f32(dmn / f32(mx + eps)), s = s0 < 0 ? 0 : s0 > 1 ? 1 : s0
        sat = f32(sat * f32(1 + f32(vib32 * f32(1 - s))))
      }
    }
    let v = f32(Y + f32(f32(x0 - Y) * sat)); lut[o++] = v < 0 ? 0 : v > 1 ? 1 : v
    v = f32(Y + f32(f32(x1 - Y) * sat)); lut[o++] = v < 0 ? 0 : v > 1 ? 1 : v
    v = f32(Y + f32(f32(x2 - Y) * sat)); lut[o++] = v < 0 ? 0 : v > 1 ? 1 : v
  }
  return lut
}

// ── 空気(パラ・ライトリーク) ─────────────────────────────────────────
export const toLin = (x: number) => Math.pow(Math.min(1, Math.max(0, x)), 2.4)
export const toGam = (x: number) => Math.pow(Math.min(1, Math.max(0, x)), 1 / 2.4)

/** ライトリークの包絡線(立ち上がり・保持・戻り)。i = クリップ先頭からのコマ */
export function leakEnv(i: number, ev: Pick<SatsueiLeak, 't0' | 'attack' | 'hold' | 'release'>): number {
  const t = i - ev.t0, a = ev.attack, hd = ev.hold, r = ev.release
  if (t < 0 || t > a + hd + r) return 0
  if (t < a) return Math.pow(t / a, 1.5)
  if (t < a + hd) return 1
  return Math.pow(1 - (t - a - hd) / r, 2)
}
export interface LeakNow { cx: number; cy: number; rx: number; ry: number; colLin: Vec3; a: number }
/** コマ i で光っているライトリーク(位置は path に沿って進む。a = 量 × 包絡線) */
export function leakEval(params: SatsueiParams, i: number): LeakNow[] {
  const out: LeakNow[] = []
  for (const ev of params.leaks) {
    const e = leakEnv(i, ev)
    if (e <= 0) continue
    const path = ev.path.length ? ev.path : LEAK_DEFAULT.path
    const t = Math.min(1, Math.max(0, (i - ev.t0) / Math.max(1, ev.attack + ev.hold + ev.release)))
    let cx: number, cy: number
    if (path.length > 1) {
      const k = t * (path.length - 1), j = Math.min(path.length - 2, Math.floor(k)), fr = k - j
      cx = path[j][0] * (1 - fr) + path[j + 1][0] * fr
      cy = path[j][1] * (1 - fr) + path[j + 1][1] * fr
    } else { cx = path[0][0]; cy = path[0][1] }
    const col = hexToRgb(ev.color)
    out.push({ cx, cy, rx: ev.size[0], ry: ev.size[1], colLin: col.map(toLin) as Vec3, a: ev.amt * e })
  }
  return out
}

// ── 効き・切り替わり ─────────────────────────────────────────────────
export interface SatsueiClipLike {
  id: number; kind: string; start_frame: number; duration_frames: number
  opacity?: number | null; attrs_json?: string | null
  transition_in?: string | null; transition_frames?: number | null; transition_ease?: string | null
}
export interface FKeyLike { t: number; v: number }
export const isSatsueiClip = (c: Pick<SatsueiClipLike, 'kind'> | null | undefined): boolean => !!c && c.kind === 'satsuei'

/** float() と同じ読み方(数・真偽・数の文字列。undefined は既定値 d、ほかは読めない = NaN) */
const keyNum = (x: unknown, d: number): number =>
  x === undefined ? d : typeof x === 'number' ? x : typeof x === 'boolean' ? Number(x)
    : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN
/**
 * strength_keys を正規化(backend satsuei_fx.parse_keys と同じ規則: {t, v}(t が無ければ 0・v が無ければ 1)か [t, v]、
 * 読めない項目は飛ばす・t は 0 以上(丸めない)・v は 0..1・t 昇順・同じ t は後勝ち)
 */
export function strengthKeys(attrs: Obj): FKeyLike[] {
  const m = new Map<number, number>()
  const raw = attrs.strength_keys
  if (Array.isArray(raw)) {
    for (const k of raw) {
      let t: number, v: number
      if (isObj(k)) { t = keyNum(k.t, 0); v = keyNum(k.v, 1) }
      else if (Array.isArray(k) && k.length >= 2) { t = keyNum(k[0], NaN); v = keyNum(k[1], NaN) }
      else continue
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue
      m.set(Math.max(0, t), Math.max(0, Math.min(1, v)))
    }
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }))
}
/** キー補間(線形・端は保持)。filterLayers の keyValueAt と同じ */
function keyAt(keys: FKeyLike[], f: number, fallback: number): number {
  if (!keys.length) return fallback
  if (f <= keys[0].t) return keys[0].v
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i], b = keys[i + 1]
    if (f < b.t) return a.v + (b.v - a.v) * (f - a.t) / Math.max(1e-6, b.t - a.t)
  }
  return keys[keys.length - 1].v
}
const KEY_CACHE = new Map<string, FKeyLike[]>()
/** タイムラインのコマ f での効き m = clip.opacity × strength_keys(0..1) */
export function strengthAt(clip: Pick<SatsueiClipLike, 'start_frame' | 'opacity' | 'attrs_json'>, f: number): number {
  const key = clip.attrs_json ?? ''
  let ks = KEY_CACHE.get(key)
  if (!ks) {
    ks = strengthKeys(parseSatsueiAttrs(key))
    if (KEY_CACHE.size > 256) KEY_CACHE.clear()
    KEY_CACHE.set(key, ks)
  }
  const op = Math.max(0, Math.min(1, clip.opacity ?? 1))
  return op * keyAt(ks, f - clip.start_frame, 1)
}

/** 重なり遷移のカーブ(PreviewPlayer の映像の重なり遷移と同じ。白/黒は撮影では溶けとして扱う) */
export function transitionK(t: number, ease: string | null | undefined): number {
  const x = Math.max(0, Math.min(1, t))
  if (ease === 'ease') return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
  if (ease === 'ease-in') return x * x
  if (ease === 'ease-out') return 1 - (1 - x) * (1 - x)
  return x
}

export interface LayerPick<C> { a: C; b?: C; k: number }
/**
 * 1 本の撮影トラックで、コマ f に効くクリップを決める(§2 の規則)。
 *  - 1 本だけ → それ
 *  - 重なり: 後から始まる方 B が勝つ(同じ開始なら id の大きい方)。B に遷移(transition_in + transition_frames>0)があれば、
 *    [B の頭, min(A の終わり, B の頭 + 遷移の長さ)) の間は A→B を k で混ぜる(A = その前に始まった重なっているクリップ)
 *  返り値 null = このコマには撮影なし
 */
export function resolveLayer<C extends SatsueiClipLike>(clips: readonly C[], f: number): LayerPick<C> | null {
  const act = clips.filter(c => c.kind === 'satsuei' && c.start_frame <= f && f < c.start_frame + c.duration_frames)
  if (!act.length) return null
  act.sort((x, y) => x.start_frame - y.start_frame || x.id - y.id)
  const B = act[act.length - 1]
  if (act.length === 1) return { a: B, k: 0 }
  const A = act[act.length - 2]
  const tf = B.transition_in ? Math.max(0, B.transition_frames ?? 0) : 0
  if (tf > 0 && f >= B.start_frame && f < Math.min(A.start_frame + A.duration_frames, B.start_frame + tf)) {
    return { a: A, b: B, k: transitionK((f - B.start_frame) / tf, B.transition_ease) }
  }
  return { a: B, k: 0 }
}

/** 描く側(satsueiGL)へ渡す 1 クリップぶん */
export interface SatsueiSpec { clipId: number; params: SatsueiParams; mix: number; clipFrame: number }
export interface SatsueiLayerSpec { a: SatsueiSpec; b?: SatsueiSpec; k: number }
export function specOf(clip: SatsueiClipLike, f: number): SatsueiSpec {
  return { clipId: clip.id, params: satsueiOf(clip.attrs_json), mix: strengthAt(clip, f), clipFrame: f - clip.start_frame }
}
/** resolveLayer の結果 → 描く側への指定。何も変わらない(効きがどれも ≤0.001)なら null */
export function layerSpecOf(pick: LayerPick<SatsueiClipLike> | null, f: number): SatsueiLayerSpec | null {
  if (!pick) return null
  const a = specOf(pick.a, f)
  const b = pick.b ? specOf(pick.b, f) : undefined
  const k = b ? pick.k : 0
  const live = (s: SatsueiSpec | undefined, w: number) => !!s && w > 0 && s.mix > 0.001
  if (!live(a, 1 - k) && !live(b, k)) return null
  return b ? { a, b, k } : { a, k: 0 }
}

// ── 分割・左端のトリム ───────────────────────────────────────────────
/**
 * 分割・左端のトリムで撮影クリップの先頭が dHead コマ動いたとき、ライトリークの始まり t0(クリップ先頭基準)を
 * 同じタイムラインのコマに保つ。新しい先頭より前に光り終わるリークは捨てる。効きのキーは filterLayers がずらす。
 * 文字列(attrs_json)を渡せば文字列を、オブジェクトを渡せば新しいオブジェクトを返す。何も変わらなければそのまま返す。
 */
export function shiftSatsueiAttrs<T extends string | null | undefined | Obj>(attrs: T, dHead: number): T {
  if (!dHead) return attrs
  const isStr = typeof attrs === 'string' || attrs == null
  const a = isStr ? parseSatsueiAttrs(attrs as string | null | undefined) : attrs as Obj
  const s = a.satsuei
  if (!isObj(s) || !Array.isArray(s.leaks) || !s.leaks.length) return attrs
  // 長さは正規化した値で(backend shift_attrs と同じ: 読めない始まりは 0、項目でないものは捨てる)
  const R = (k: string) => rangeAt(['leaks', k], META)
  const leaks: unknown[] = []
  for (const ev of s.leaks) {
    if (!isObj(ev)) continue
    const t0 = toNum(ev.t0, LEAK_DEFAULT.t0, R('t0'))
    const len = toNum(ev.attack, LEAK_DEFAULT.attack, R('attack')) + toNum(ev.hold, LEAK_DEFAULT.hold, R('hold'))
      + toNum(ev.release, LEAK_DEFAULT.release, R('release'))
    if (t0 + len < dHead) continue              // 新しい先頭より前に光り終わる
    leaks.push({ ...ev, t0: Math.round((t0 - dHead) * 1e6) / 1e6 })
  }
  const next = { ...a, satsuei: { ...s, leaks } }
  return (isStr ? JSON.stringify(next) : next) as T
}
