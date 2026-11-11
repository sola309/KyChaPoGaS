/**
 * 🎬 撮影パネル(SatsueiPanel)・フィルター追加の小さな計算。ストアも API も使わない(Node のテストからも読む)。
 *
 *   - 影・ハイライトの色: 色相(0..360)と量(つまみは 0..0.05)⇔ RGB の足し算 [r, g, b](BT.709 の明るさが変わらない向き)
 *   - attrs_json の書き換え: 知らない欄(段階 2 の追加など)を消さないよう、生の attrs.satsuei に道のりで書き込む。
 *     元に戻す・自動で合わせるは、変わった所の一覧(diffPaths)を今の中身へ当てる(applyChanges)
 *   - 「✂ 境目で分ける」の区切り方(backend routers/satsuei.py の _segments と同じ規則)
 *   - 撮影トラックの置き場所(Shots・Scenes など素材のトラックのすぐ上、ロゴ・単色・フィルターより下)
 */
import type { Clip, Track } from '../../api/client'
import { LUMA, type Vec3, type SatsueiParams } from '../Preview/satsueiLook'

export type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => (v == null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)))
/** 小数 6 桁に丸める(スライダーの 0.30000000000000004 を保存しない) */
export const r6 = (v: number) => Math.round(v * 1e6) / 1e6

// ── 影・ハイライトの色(色相 + 量)────────────────────────────────────────
/** 色の量の上限(各チャンネルの足し算の最大値。設定の範囲は ±0.1) */
export const TINT_MAX = 0.05
const lumaOf = (v: readonly number[]) => v[0] * LUMA[0] + v[1] * LUMA[1] + v[2] * LUMA[2]

/** 色相 h の純色から明るさの分を引いた向き(いちばん大きいチャンネルの絶対値が 1) */
function hueDir(h: number): Vec3 {
  const hh = ((h % 360) + 360) % 360
  const f = (n: number) => { const k = (n + hh / 60) % 6; return 1 - Math.max(0, Math.min(k, 4 - k, 1)) }
  const c = [f(5), f(3), f(1)]
  const y = lumaOf(c)
  const d = c.map(x => x - y)
  const m = Math.max(...d.map(Math.abs)) || 1
  return d.map(x => x / m) as Vec3
}

/** 足す色の各チャンネルの範囲(backend RANGES の shadow_tint / highlight_tint) */
const TINT_LIM = 0.1
/**
 * 色相・量 → 足す色 [r, g, b]。grey = 今の値のうち明るさの分(3 チャンネル同じだけ足す分)。
 * 色相と量の分は明るさを変えない(BT.709 の重みで 0)ので、色だけが変わる。grey はそのまま残す
 * (プリセットの値にはわずかに明るさの分が入っている。色相を動かしただけで明るさが変わらないように)。
 * 量はつまみの上限(TINT_MAX)で切らない(プリセットや貼り付けで入った強い色を、色相を動かしただけで弱めない)。
 * どれかのチャンネルが範囲(±0.1)を越えるときは量のほうを縮める(チャンネルごとに切ると色相が変わる)
 */
export function tintFromHue(hue: number, amount: number, grey = 0): Vec3 {
  const d = hueDir(hue)
  const g = Math.max(-TINT_LIM, Math.min(TINT_LIM, grey))
  let a = Math.max(0, Number.isFinite(amount) ? amount : 0)
  for (const x of d) {
    if (x > 1e-9) a = Math.min(a, (TINT_LIM - g) / x)
    else if (x < -1e-9) a = Math.min(a, (g + TINT_LIM) / -x)
  }
  a = Math.max(0, a)
  return d.map(x => r6(Math.max(-TINT_LIM, Math.min(TINT_LIM, g + a * x)))) as Vec3
}

/** 足す色 [r, g, b] → {色相, 量, 明るさの分}。量がほぼ 0 なら色相は fallback */
export function hueOfTint(t: readonly number[], fallback = 0): { hue: number; amount: number; grey: number } {
  const grey = lumaOf(t)
  const d = [t[0] - grey, t[1] - grey, t[2] - grey]
  const amount = Math.max(...d.map(Math.abs))
  if (amount < 1e-5) return { hue: fallback, amount: 0, grey }
  const mx = Math.max(...d), mn = Math.min(...d), dl = mx - mn
  let h: number
  if (mx === d[0]) h = (((d[1] - d[2]) / dl) % 6 + 6) % 6
  else if (mx === d[1]) h = (d[2] - d[0]) / dl + 2
  else h = (d[0] - d[1]) / dl + 4
  return { hue: Math.round(h * 60 * 10) / 10 % 360, amount, grey }
}

// ── attrs_json の書き換え(知らない欄は残す)────────────────────────────
/** attrs_json → {attrs(全体), s(生の attrs.satsuei)}。壊れていれば空 */
export function rawSatsuei(attrsJson: string | null | undefined): { attrs: Obj; s: Obj } {
  let attrs: Obj = {}
  try { const d = JSON.parse(attrsJson || '{}'); if (isObj(d)) attrs = d } catch { /* 空 */ }
  return { attrs, s: isObj(attrs.satsuei) ? attrs.satsuei : {} }
}

/** obj の道のり path に value を入れた新しいオブジェクト(途中が無い・辞書でなければ辞書を作る。ほかの欄はそのまま) */
export function setIn(obj: Obj, path: readonly string[], value: unknown): Obj {
  if (!path.length) return obj
  const [k, ...rest] = path
  const out: Obj = { ...obj }
  out[k] = rest.length ? setIn(isObj(obj[k]) ? obj[k] as Obj : {}, rest, value) : clone(value)
  return out
}

/** attrs_json の satsuei を書き換えた文字列(fn は生の satsuei を受けて新しい satsuei を返す) */
export function withSatsuei(attrsJson: string | null | undefined, fn: (s: Obj) => Obj): string {
  const { attrs, s } = rawSatsuei(attrsJson)
  return JSON.stringify({ ...attrs, satsuei: fn(s) })
}

// ── 変わった所だけを書き戻す(元に戻す・自動で合わせる・保存の重ね直し)─────────────────
/** 1 か所の変化。path は辞書の道のり(並びは中まで見ない = 丸ごと 1 つの値)。無い欄は undefined */
export interface PathChange { path: string[]; before: unknown; after: unknown }
/** a → b で変わった所の一覧(両方が辞書の所は中へ、それ以外は値を丸ごと比べる) */
export function diffPaths(a: unknown, b: unknown, path: string[] = [], out: PathChange[] = []): PathChange[] {
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], [...path, k], out)
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path, before: clone(a), after: clone(b) })
  }
  return out
}
/** obj の道のり path を value にした新しいオブジェクト(value が undefined なら消す。ほかの欄はそのまま) */
export function putPath(obj: Obj, path: readonly string[], value: unknown): Obj {
  if (!path.length) return isObj(value) ? clone(value) : obj
  if (value !== undefined) return setIn(obj, path, value)
  const [k, ...rest] = path
  if (!(k in obj)) return obj
  const out: Obj = { ...obj }
  if (!rest.length) delete out[k]
  else if (isObj(obj[k])) out[k] = putPath(obj[k] as Obj, rest, undefined)
  return out
}
/** 変化の一覧を obj に当てる。dir = 'after'(やり直す・保存)は前から、'before'(元に戻す)は後ろから */
export function applyChanges(obj: Obj, changes: readonly PathChange[], dir: 'before' | 'after'): Obj {
  const list = dir === 'before' ? [...changes].reverse() : changes
  let o = obj
  for (const ch of list) o = putPath(o, ch.path, ch[dir])
  return o
}
/** attrs_json(文字列)に変化の一覧を当てた文字列。壊れた JSON は空の辞書として扱う */
export function applyChangesToAttrs(attrsJson: string | null | undefined, changes: readonly PathChange[], dir: 'before' | 'after'): string {
  return JSON.stringify(applyChanges(rawSatsuei(attrsJson).attrs, changes, dir))
}
/** attrs_json(文字列)どうしの変化の一覧 */
export function diffAttrs(beforeJson: string | null | undefined, afterJson: string | null | undefined): PathChange[] {
  return diffPaths(rawSatsuei(beforeJson).attrs, rawSatsuei(afterJson).attrs)
}

/**
 * 「自動で合わせる」の結果 fitted(backend の正規化ずみ)を生の attrs_json へ: 合わせる前の設定 base(正規化ずみ)から
 * 変わった所(黒の持ち上げ・中間・彩度・にじみの量など)だけを書き込む。ほかの欄は今の値のまま
 * (backend の正規化は中の知らない欄を落とすので、丸ごと重ねると段階 2 の欄などが消える)。記録 fit は丸ごと置き換える。
 * 項目の並び(パラ・ライトリーク)は丸ごとは書かない(違って見えるのは項目の知らない欄の分だけ)。ただしパラの効き(amt)は
 * 暗い絵で自動で弱める(10/17、backend の auto_fit)ので、本数が同じときだけ 1 本ずつ amt を書く(項目の知らない欄は残す)
 */
export function applyFitted(attrsJson: string | null | undefined, base: SatsueiParams | Obj, fitted: Obj): string {
  const itemList = (v: unknown) => Array.isArray(v) && v.some(isObj)
  const ch = diffPaths(base, fitted).filter(c => c.after !== undefined && c.path[0] !== 'fit' && !itemList(c.before))
  return withSatsuei(attrsJson, s => {
    const out: Obj = { ...applyChanges(s, ch, 'after'), fit: clone(fitted.fit ?? null) }
    const bp = (base as Obj).para, fp = fitted.para, rp = out.para
    if (Array.isArray(bp) && Array.isArray(fp) && Array.isArray(rp) && bp.length === fp.length && rp.length === fp.length) {
      out.para = rp.map((q, i) => {
        const a = isObj(bp[i]) ? bp[i].amt : undefined, b = isObj(fp[i]) ? fp[i].amt : undefined
        return isObj(q) && typeof b === 'number' && a !== b ? { ...q, amt: b } : q
      })
    }
    return out
  })
}

/**
 * 生の値 raw に、正規化ずみの値 known を重ねる(known にある欄は known の値、raw にしか無い欄 = 知らない欄はそのまま)。
 * 辞書は中まで。並び(パラ・リークなど)は丸ごと known
 */
export function mergeKnown(raw: unknown, known: unknown): unknown {
  if (!isObj(raw) || !isObj(known)) return clone(known)
  const out: Obj = { ...raw }
  for (const k of Object.keys(known)) out[k] = mergeKnown(raw[k], known[k])
  return out
}

/** コピー・「このトラックの全部へ」で選べる欄 */
export type SatsueiSection = 'color' | 'lens' | 'para' | 'leaks' | 'grain'
export const SECTION_LABEL: Record<SatsueiSection, string> = {
  color: '色', lens: 'レンズ', para: 'パラ', leaks: 'ライトリーク', grain: '粒子',
}
/**
 * 生の satsuei(写し先)に、src(正規化ずみ)の選んだ欄を写す。色かレンズを写すときはプリセットの名前も写す
 * (色を写すときは「自動で合わせる」の記録 fit も写す: 写し先の古い記録で合わせ直すと写した色が崩れる)。
 * 色・レンズ・粒子は写し先の知らない欄(段階 2 の追加など)を残して重ねる。パラ・ライトリークの並びは丸ごと写す
 */
export function copySections(target: Obj, src: SatsueiParams | Obj, sections: readonly SatsueiSection[]): Obj {
  const out: Obj = { ...target }
  for (const k of sections) out[k] = mergeKnown(target[k], (src as Obj)[k])
  if (sections.includes('color') || sections.includes('lens')) out.preset = (src as Obj).preset ?? ''
  if (sections.includes('color')) out.fit = clone((src as Obj).fit ?? null)
  return out
}

// ── ✂ 境目で分ける ─────────────────────────────────────────────────────
/** 分ける候補(タイムラインのコマ)。hard = パッと替わる / bound = 下のクリップが替わる / dissolve・wipe = t0..t1 で替わる */
export interface SplitPick { kind: 'hard' | 'bound' | 'dissolve' | 'wipe'; at?: number; t0?: number; t1?: number }
/** 分けた 1 本 [start, end)。tf = 頭の溶け(前の 1 本と重なるコマ数。0 = パッと切り替わる) */
export interface SplitSeg { start: number; end: number; tf: number }
/** これより短い区切りは作らない(backend の MIN_SEG と同じ) */
export const MIN_SEG = 4

export const pickAt = (p: SplitPick) => (p.kind === 'hard' || p.kind === 'bound' ? (p.at ?? 0) : (p.t0 ?? 0))

/**
 * クリップ [f0, f1) を候補で区切る(backend _segments と同じ): パッと替わる at → 新しい 1 本は at から。
 * 溶け・一部から替わる t0..t1 → 前の 1 本は t1 まで(t1+1 で終わる)、後の 1 本は t0 から溶け(tf = t1 − t0 + 1)。
 * 前の 1 本だけが効く区間・最後の 1 本が MIN_SEG コマより短くなる候補は使わない(skipped に返す)
 */
export function splitSegments(f0: number, f1: number, picks: readonly SplitPick[], minSeg = MIN_SEG): { segs: SplitSeg[]; skipped: SplitPick[] } {
  const segs: SplitSeg[] = [{ start: f0, end: f1, tf: 0 }]
  const skipped: SplitPick[] = []
  for (const p of [...picks].sort((a, b) => pickAt(a) - pickAt(b))) {
    let s: number, e: number
    if (p.kind === 'hard' || p.kind === 'bound') { s = e = Math.round(p.at ?? 0) }
    else { s = Math.round(p.t0 ?? 0); e = Math.round(p.t1 ?? 0) + 1 }
    const cur = segs[segs.length - 1]
    if (s - (cur.start + cur.tf) < minSeg || f1 - e < minSeg || e < s) { skipped.push(p); continue }
    cur.end = e
    segs.push({ start: s, end: f1, tf: e - s })
  }
  return { segs, skipped }
}

// ── 撮影トラックの置き場所 ─────────────────────────────────────────────
export const SATSUEI_TRACK = '撮影'
/** 素材(生成の絵)のトラック。いちばん上にあるもののすぐ上に撮影トラックを置く */
const FOOTAGE_RE = /^(shots|scenes|sequences|video)\b/i
/** 素材の上に重ねる側のトラック(ロゴ・文字・単色・ぼかし・雨)。素材のトラックが名前で見つからないときに外す */
const OVERLAY_RE = /logo|text|title|telop|テロップ|文字|ロゴ|字幕|solid|filter|撮影|rain|雨/i
const NON_MEDIA = new Set(['solid', 'blur', 'satsuei', 'rain'])

type TrackLike = Pick<Track, 'id' | 'name' | 'order' | 'track_type'>
/**
 * 新しい撮影トラックの order と、場所を空けるためにずらす(order − 1)トラック。
 * 素材のトラック(Shots / Scenes / Sequences / Video…。名前で無ければ、素材のクリップがある重ね以外のトラック)の
 * いちばん上のすぐ上。そこが埋まっていれば、それより上の映像トラックを全部 1 つずつ上へずらす
 * (プロジェクト 33: Filter -3 / Solid -2 / Logo -1 / Scenes 0 → 撮影 -1、Logo -2・Solid -3・Filter -4)。
 * 素材のトラックが無ければ最前面
 */
export function satsueiTrackPlacement(tracks: readonly TrackLike[], clips: readonly Pick<Clip, 'track_id' | 'asset_id' | 'kind'>[]):
  { order: number; shift: { id: number; order: number }[]; above: TrackLike | null } {
  const vt = tracks.filter(t => t.track_type === 'video').sort((a, b) => a.order - b.order)
  let foot = vt.find(t => FOOTAGE_RE.test(t.name.trim()))
  if (!foot) {
    const media = new Set(clips.filter(c => c.asset_id != null && !NON_MEDIA.has(c.kind)).map(c => c.track_id))
    foot = vt.find(t => media.has(t.id) && !OVERLAY_RE.test(t.name))
  }
  if (!foot) return { order: Math.min(0, ...vt.map(t => t.order)) - 1, shift: [], above: null }
  const want = foot.order - 1
  const taken = vt.some(t => t.order === want)
  const shift = taken ? vt.filter(t => t.order <= want).map(t => ({ id: t.id, order: t.order - 1 })) : []
  return { order: want, shift, above: foot }
}
