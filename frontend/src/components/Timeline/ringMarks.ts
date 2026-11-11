/**
 * 💍 指輪の位置(リングマーク)。映像クリップの attrs_json に持つ(DB の列は増やさない):
 *
 *   "ring_marks": [{"f": クリップ先頭からのコマ, "x": 0..1(画面の幅), "y": 0..1(高さ),
 *                   "r": 輪の半径(画面の高さに対する割合), "a": 帯の向き(度, 0=水平・時計回りが +。
 *                   参照に描く絵は a+90° の側が下の縁 = 手前にふくらむ側。a と a+180 は絵が上下逆),
 *                   "vis": "gem" | "band" | "hidden"}, ...]   … f の昇順
 *   "ring_marks_meta": {"asset_id": 印を付けたときの素材, "asset_in_frame": そのときの頭出し}
 *
 * 補間の決まり(Python 版 outputs/pocky2026/v13/fix1013/night/ring_marks_export.py と同じ):
 *   - キーとキーの間は x / y / r / a を線形に補間する。a は角度の数値のまま(折り返さない)。
 *   - vis はそのキーから次のキーの手前まで(段階)。"hidden" = 指に隠れる・画面の外で見えない。
 *   - 最初のキーより前 = 印なし。最後のキーより後 = 最後のキーのまま。
 *   - 座標はクリップの映像の画面(変形なしならプロジェクトの画面と同じ)。手が画面の端で切れるコマのため、
 *     中心は画面の外(-0.25〜1.25)にも置ける。
 *
 * React / ストアに依存しない純粋な関数だけを置く(ノードでそのまま試せるように)。
 */

export type RingVis = 'gem' | 'band' | 'hidden'
export const RING_VIS: RingVis[] = ['gem', 'band', 'hidden']
export const RING_VIS_LABEL: Record<RingVis, string> = { gem: '石', band: '帯', hidden: '隠れ' }
/** 表示の色(プレビューの印・タイムラインの目印) */
export const RING_VIS_COLOR: Record<RingVis, string> = { gem: '#fb7185', band: '#e4e4e7', hidden: '#a1a1aa' }

export interface RingMark { f: number; x: number; y: number; r: number; a: number; vis: RingVis }
export interface RingMeta { asset_id: number | null; asset_in_frame: number }
/** あるコマの指輪。kind: key=このコマにキー / interp=キーの間 / hold=最後のキーのまま */
export interface RingState extends RingMark { kind: 'key' | 'interp' | 'hold'; index: number }

export const RING_ATTR = 'ring_marks'
export const RING_META_ATTR = 'ring_marks_meta'
export const RING_XY_MIN = -0.25
export const RING_XY_MAX = 1.25
export const RING_R_MIN = 0.003
export const RING_R_MAX = 0.25
export const RING_R_DEFAULT = 0.02

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const round = (v: number, d: number) => { const k = 10 ** d; return Math.round(v * k) / k }

/** 保存する値の丸め(x/y/r は 4 桁 = 1344px で 0.13px、a は 0.1 度) */
export function normMark(m: RingMark): RingMark {
  return {
    f: Math.max(0, Math.round(m.f)),
    x: round(clamp(m.x, RING_XY_MIN, RING_XY_MAX), 4),
    y: round(clamp(m.y, RING_XY_MIN, RING_XY_MAX), 4),
    r: round(clamp(m.r, RING_R_MIN, RING_R_MAX), 4),
    a: round(m.a, 1),
    vis: RING_VIS.includes(m.vis) ? m.vis : 'gem',
  }
}

/** attrs_json を辞書として読む。空 = {}、読めない・辞書でない = null(上書きして壊さないため) */
export function parseAttrsObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null || raw.trim() === '') return {}
  try {
    const d = JSON.parse(raw)
    return d && typeof d === 'object' && !Array.isArray(d) ? d as Record<string, unknown> : null
  } catch { return null }
}

/** 印の配列を読む(数値でないもの・vis の誤りは捨てる/直す。同じコマは後勝ち。f 昇順) */
export function sanitizeMarks(raw: unknown): RingMark[] {
  if (!Array.isArray(raw)) return []
  const byF = new Map<number, RingMark>()
  for (const k of raw) {
    if (!k || typeof k !== 'object') continue
    const o = k as Record<string, unknown>
    const f = Number(o.f), x = Number(o.x), y = Number(o.y)
    if (![f, x, y].every(Number.isFinite) || f < 0) continue
    const r = Number.isFinite(Number(o.r)) && Number(o.r) > 0 ? Number(o.r) : RING_R_DEFAULT
    const a = Number.isFinite(Number(o.a)) ? Number(o.a) : 0
    const vis = RING_VIS.includes(o.vis as RingVis) ? o.vis as RingVis : 'gem'
    const m = normMark({ f, x, y, r, a, vis })
    byF.set(m.f, m)
  }
  return [...byF.values()].sort((p, q) => p.f - q.f)
}

export function parseRingMarks(attrsJson: string | null | undefined): RingMark[] {
  // タイムラインの全クリップ(ピンの大きな attrs_json も)で呼ばれるので、印のないものは JSON を読まずに返す
  if (!attrsJson || !attrsJson.includes(`"${RING_ATTR}"`)) return []
  const a = parseAttrsObject(attrsJson)
  return a ? sanitizeMarks(a[RING_ATTR]) : []
}

export function parseRingMeta(attrsJson: string | null | undefined): RingMeta | null {
  if (!attrsJson || !attrsJson.includes(`"${RING_META_ATTR}"`)) return null
  const a = parseAttrsObject(attrsJson)
  const m = a?.[RING_META_ATTR]
  if (!m || typeof m !== 'object') return null
  const o = m as Record<string, unknown>
  return { asset_id: o.asset_id == null ? null : Number(o.asset_id), asset_in_frame: Number(o.asset_in_frame ?? 0) }
}

export const hasRingMarks = (attrsJson: string | null | undefined) => parseRingMarks(attrsJson).length > 0

/** コマ f(クリップ先頭から)の指輪。印なしは null */
export function ringAt(marks: RingMark[], f: number): RingState | null {
  if (!marks.length || f < marks[0].f) return null
  let lo = 0, hi = marks.length - 1                    // marks[i].f <= f となる最後の i
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (marks[mid].f <= f) lo = mid; else hi = mid - 1
  }
  const k = marks[lo]
  if (k.f === f) return { ...k, kind: 'key', index: lo }
  const n = marks[lo + 1]
  if (!n) return { ...k, f, kind: 'hold', index: lo }
  const t = (f - k.f) / (n.f - k.f)
  const L = (p: number, q: number) => p + (q - p) * t
  return { f, x: L(k.x, n.x), y: L(k.y, n.y), r: L(k.r, n.r), a: L(k.a, n.a), vis: k.vis, kind: 'interp', index: lo }
}

export const keyAt = (marks: RingMark[], f: number) => marks.find(m => m.f === f) ?? null

/** キーを置く(同じコマは置き換え)。返り値は新しい配列 */
export function upsertMark(marks: RingMark[], m: RingMark): RingMark[] {
  const nm = normMark(m)
  return [...marks.filter(k => k.f !== nm.f), nm].sort((p, q) => p.f - q.f)
}

export function removeMark(marks: RingMark[], f: number): RingMark[] {
  return marks.filter(k => k.f !== f)
}

/** 前後のキー(コマ送りのジャンプ用) */
export function prevKeyF(marks: RingMark[], f: number): number | null {
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].f < f) return marks[i].f
  return null
}
export function nextKeyF(marks: RingMark[], f: number): number | null {
  for (const k of marks) if (k.f > f) return k.f
  return null
}

const stateToMark = (s: RingState, f: number): RingMark => normMark({ f, x: s.x, y: s.y, r: s.r, a: s.a, vis: s.vis })

/**
 * クリップを切ったとき(分割・左端を詰める/伸ばす)の印: 元のクリップ内オフセット off から len コマぶんを
 * 先頭 0 に詰め直す。境目が補間の途中なら、そこに補間した値のキーを足して見た目を変えない。
 * off は負でもよい(左端を伸ばした = 頭に印なしのコマが増える)。
 * keepTail = 終わり(off + len)より後のキーも捨てずに持つ(左端のトリム・分割の右側。
 *   右端を詰めて隠れていた印は、あとで右端を伸ばせば戻る — 右端のトリムと同じ扱い)。
 */
export function sliceRingMarks(marks: RingMark[], off: number, len: number, keepTail = false): RingMark[] {
  if (!marks.length || len <= 0) return []
  const out: RingMark[] = []
  const s0 = off >= 0 ? ringAt(marks, off) : null
  if (s0 && s0.kind !== 'key') out.push(stateToMark(s0, 0))
  for (const k of marks) if (k.f >= off && (keepTail || k.f < off + len)) out.push({ ...k, f: k.f - off })
  const sEnd = ringAt(marks, off + len - 1)
  if (!keepTail && len > 1 && sEnd && sEnd.kind === 'interp' && !out.some(k => k.f === len - 1)) out.push(stateToMark(sEnd, len - 1))
  return sanitizeMarks(out)
}

/**
 * 左端のトリムで素材の頭出しが dIn(素材のコマ)変わったとき、同じ絵が何コマ動くか(= 印をずらす量)。
 * 一定速度なら dIn ÷ 速度。時間リマップのあるクリップは近似で dIn のまま。
 * (ClipBlock の左端トリムと、トリムの前に付けて保存待ちだった印の両方で使う — 式を 1 つにするため)
 */
export function headShiftFrames(dIn: number, speed: number | null | undefined, remapJson: string | null | undefined): number {
  const sp = speed != null && speed > 0 ? speed : 1
  return (remapJson ?? '').trim() ? dIn : Math.round(dIn / sp)
}

/**
 * attrs_json に印を書き込む(ほかのキー — 雨の設定など — はそのまま)。印が空なら ring_marks と meta を消す。
 * attrs_json が読めない(壊れている・辞書でない)ときは null を返す = 保存しない(上書きで壊さない)。
 */
export function withRingMarks(attrsJson: string | null | undefined, marks: RingMark[], meta: RingMeta | null): string | null {
  const a = parseAttrsObject(attrsJson)
  if (!a) return null
  const o: Record<string, unknown> = { ...a }
  const ms = sanitizeMarks(marks)
  if (ms.length) {
    o[RING_ATTR] = ms
    if (meta) o[RING_META_ATTR] = { asset_id: meta.asset_id, asset_in_frame: meta.asset_in_frame }
  } else {
    delete o[RING_ATTR]
    delete o[RING_META_ATTR]
  }
  return Object.keys(o).length ? JSON.stringify(o) : ''
}

/**
 * 分割・トリム用: 切り出した印で attrs_json を作り直す(印がなければ null = 元のまま)。
 * meta(印を付けたときの素材・頭出し)は、頭出しの変化 inDelta だけずらして引き継ぐ
 * (テイクが替わった・頭出しがずれたという注意を、分割やトリムで勝手に「確かめた」にしない)。meta がなければ now。
 */
export function sliceRingAttrs(attrsJson: string | null | undefined, off: number, len: number,
                               inDelta: number, now: RingMeta, keepTail = false): string | null {
  const ms = parseRingMarks(attrsJson)
  if (!ms.length) return null
  const old = parseRingMeta(attrsJson)
  const meta: RingMeta = old && Number.isFinite(old.asset_in_frame)
    ? { asset_id: old.asset_id, asset_in_frame: old.asset_in_frame + inDelta } : now
  return withRingMarks(attrsJson, sliceRingMarks(ms, off, len, keepTail), meta)
}
