/**
 * 🎞 プレビズ共有モジュール — 設定の型・カーブ補間・ノイズ描画。
 *
 * PreviewPlayer(本編プレビュー)と PrevizPopover(調整ポップアップ)の両方が
 * ここを使うことで、ポップアップで見た動きがそのまま本編プレビューでも再現される。
 * すべてフロントエンド描画。生成キュー・レンダーには一切影響しない。
 *
 * attrs_json.previz = {
 *   move:    { dir, amt },              // amt はカーブ平均(後方互換用)
 *   movePts: [[t,v], ...],              // 移動量カーブ: t=カット内進行0..1 / v=量0..1
 *   flash:   'none'|'cut'|'beat',
 *   flashLen: number,                   // フラッシュ減衰フレーム数
 *   fade:    'none'|'in'|'out'|'inout',
 *   fadeIn:  number, fadeOut: number,   // 暗転の長さ(フレーム)
 * }
 */
export type PrevizDir = 'none' | 'left' | 'right' | 'up' | 'down' | 'in' | 'out'
export interface Previz {
  /** 移動方向ベクトル [x, y, z]。x=右+ / y=下+ / z=奥+(寄り)・手前-(引き)。
      斜めも自由。大きさは movePts カーブが時間軸で決める。 */
  moveVec: [number, number, number]
  movePts: Array<[number, number]>
  flash: 'none' | 'cut' | 'beat'
  flashLen: number
  fade: 'none' | 'in' | 'out' | 'inout'
  fadeIn: number
  fadeOut: number
  /** 旧形式(方向プリセット)。読み込み時に moveVec へ変換される */
  move?: { dir: PrevizDir; amt: number }
}

export const DEFAULT_PREVIZ: Previz = {
  moveVec: [0, 0, 0],
  movePts: [[0, 0.5], [1, 0.5]],
  flash: 'none', flashLen: 4,
  fade: 'none', fadeIn: 8, fadeOut: 8,
}

const DIR2VEC: Record<PrevizDir, [number, number, number]> = {
  none: [0, 0, 0], left: [-1, 0, 0], right: [1, 0, 0], up: [0, -1, 0], down: [0, 1, 0],
  in: [0, 0, 1], out: [0, 0, -1],
}

export function parsePreviz(attrsJson: string | undefined): Previz | null {
  if (!attrsJson) return null
  try {
    const p = JSON.parse(attrsJson).previz
    if (!p) return null
    const amt = p.move?.amt ?? 0.5
    const vec: [number, number, number] =
      Array.isArray(p.moveVec) && p.moveVec.length === 3
        ? p.moveVec
        : DIR2VEC[(p.move?.dir as PrevizDir) ?? 'none'] ?? [0, 0, 0]
    return {
      ...DEFAULT_PREVIZ,
      ...p,
      moveVec: vec,
      movePts: Array.isArray(p.movePts) && p.movePts.length >= 2
        ? p.movePts : [[0, amt], [1, amt]],
    }
  } catch { return null }
}

/** 移動量カーブの補間 — Catmull-Rom(=3次エルミート)でキーポイントを滑らかに通す */
export function sampleCurve(pts: Array<[number, number]>, u: number): number {
  const P = [...pts].sort((a, b) => a[0] - b[0])
  if (u <= P[0][0]) return P[0][1]
  if (u >= P[P.length - 1][0]) return P[P.length - 1][1]
  let i = 0
  while (i < P.length - 2 && u > P[i + 1][0]) i++
  const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)]
  const span = Math.max(1e-6, p2[0] - p1[0])
  const t = (u - p1[0]) / span
  // 接線(片側差分)。y方向のみのスプラインなので単調性は clamp で担保
  const m1 = (p2[1] - p0[1]) / Math.max(1e-6, p2[0] - p0[0]) * span
  const m2 = (p3[1] - p1[1]) / Math.max(1e-6, p3[0] - p1[0]) * span
  const t2 = t * t, t3 = t2 * t
  const v = (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1
          + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2
  return Math.min(1, Math.max(0, v))
}

// ── ノイズタイル(8pxブロック、初回のみ生成) ─────────────────────────────
let _tile: HTMLCanvasElement | null = null
export function noiseTile(): HTMLCanvasElement {
  if (_tile) return _tile
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  for (let y = 0; y < 256; y += 8)
    for (let x = 0; x < 256; x += 8) {
      const v = 26 + Math.floor(Math.random() * 70)
      g.fillStyle = `rgb(${v},${v},${v + 6})`
      g.fillRect(x, y, 8, 8)
    }
  _tile = c
  return c
}

/** ノイズ地の描画。移動はカーブ量の累積(積分)なので、量の変化=速度の変化として見える */
export function drawPrevizBase(ctx: CanvasRenderingContext2D, w: number, h: number,
                               pv: Previz | null, rel: number, dur: number): void {
  const tile = noiseTile()
  const v = pv?.moveVec ?? [0, 0, 0]
  const pts = pv?.movePts ?? DEFAULT_PREVIZ.movePts
  // 累積移動量: 0..rel の各フレームのカーブ値の和(量100%=10px/フレーム)。
  // ベクトルの x/y はパン、z はズームとして同時に効く(斜め+寄りも可)。
  let travel = 0
  const D = Math.max(1, dur)
  for (let f = 0; f < rel; f++) travel += sampleCurve(pts, f / D) * 10
  const ox = -travel * v[0]
  const oy = -travel * v[1]
  const z = (travel * v[2]) / (10 * D)          // カーブ平均×進行で正規化
  const sc = Math.min(2.6, Math.max(0.4, 1 + z * 0.9))
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(sc, sc)
  ctx.translate(-w / 2 - ox, -h / 2 - oy)
  const T = 256
  const x0 = Math.floor((ox - w * 0.5) / T) * T
  const y0 = Math.floor((oy - h * 0.5) / T) * T
  for (let y = y0; y < oy + h * 1.5; y += T)
    for (let x = x0; x < ox + w * 1.5; x += T)
      ctx.drawImage(tile, x, y)
  ctx.restore()
}

/** フラッシュ/暗転(全画面効果)。beatRel = カット内ビート位置(相対フレーム)の列 */
export function drawPrevizFx(ctx: CanvasRenderingContext2D, w: number, h: number,
                             pv: Previz | null, rel: number, dur: number,
                             beatRel: number[] = []): void {
  if (!pv) return
  if (pv.flash !== 'none') {
    const L = Math.max(1, pv.flashLen)
    let f0 = -999
    if (pv.flash === 'cut') f0 = 0
    else for (const bf of beatRel) if (bf <= rel && rel - bf < L) f0 = Math.max(f0, bf)
    const dt = rel - f0
    if (dt >= 0 && dt < L) {
      ctx.fillStyle = `rgba(255,255,255,${(0.85 * (1 - dt / L)).toFixed(3)})`
      ctx.fillRect(0, 0, w, h)
    }
  }
  if (pv.fade !== 'none') {
    let a = 0
    if ((pv.fade === 'in' || pv.fade === 'inout') && rel < pv.fadeIn)
      a = 1 - rel / Math.max(1, pv.fadeIn)
    if ((pv.fade === 'out' || pv.fade === 'inout') && dur - rel < pv.fadeOut)
      a = Math.max(a, 1 - (dur - rel) / Math.max(1, pv.fadeOut))
    if (a > 0) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(1, a).toFixed(3)})`
      ctx.fillRect(0, 0, w, h)
    }
  }
}
