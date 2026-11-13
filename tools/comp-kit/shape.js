// シェイプのラスタライズ(Canvas2D)。形はいったん折れ線にしてから描くので、
// どの形でも trim(線を描いていく)が同じ計算で効く。
import { toCss, toColor, num } from './props.js'

export const MAX_TEX = 4096

// ソフトウェア描画に固定(GPU の有無で画が変わらないように)
export function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h))
  const ctx = c.getContext('2d', { willReadFrequently: true })
  return [c, ctx]
}

function bez(out, p0, c0, c1, p1) {
  const len = Math.hypot(c0[0] - p0[0], c0[1] - p0[1]) + Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) + Math.hypot(p1[0] - c1[0], p1[1] - c1[1])
  const n = Math.min(96, Math.max(8, Math.ceil(len / 6)))
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1],
    ])
  }
}
// 点: [x,y] / [x,y,inx,iny,outx,outy] / {x,y,in:[dx,dy],out:[dx,dy]}(ハンドルは点からの相対)
function normPoint(p) {
  if (Array.isArray(p)) return { x: +p[0] || 0, y: +p[1] || 0, i: [+p[2] || 0, +p[3] || 0], o: [+p[4] || 0, +p[5] || 0] }
  return { x: +p.x || 0, y: +p.y || 0, i: p.in || [0, 0], o: p.out || [0, 0] }
}

// → {pts: [[x,y]...], closed}。座標はレイヤー空間(原点 = レイヤーの中心)
export function shapePolyline(s) {
  const kind = s.kind || 'rect'
  const w = num(s.width, 100), h = num(s.height, num(s.width, 100))
  const pts = []
  let closed = true
  if (kind === 'rect') {
    const r = Math.max(0, Math.min(num(s.radius, 0), w / 2, h / 2))
    const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2
    if (r < 0.01) pts.push([x0, y0], [x1, y0], [x1, y1], [x0, y1])
    else {
      const n = Math.max(4, Math.ceil(r / 3))
      const arc = (cx, cy, a0) => { for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * Math.PI / 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]) } }
      arc(x1 - r, y0 + r, -Math.PI / 2); arc(x1 - r, y1 - r, 0); arc(x0 + r, y1 - r, Math.PI / 2); arc(x0 + r, y0 + r, Math.PI)
      // 左上の直線の始まりから描き始める
      pts.unshift([x0 + r, y0])
    }
  } else if (kind === 'ellipse') {
    const n = Math.min(256, Math.max(48, Math.ceil((w + h) / 6)))
    for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; pts.push([Math.cos(a) * w / 2, Math.sin(a) * h / 2]) }
  } else if (kind === 'polygon' || kind === 'star') {
    const sides = Math.max(3, Math.round(num(s.sides, kind === 'star' ? 5 : 6)))
    const inner = kind === 'star' ? num(s.inner, 0.5) : 1
    const n = kind === 'star' ? sides * 2 : sides
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2
      const k = kind === 'star' && i % 2 ? inner : 1
      pts.push([Math.cos(a) * w / 2 * k, Math.sin(a) * h / 2 * k])
    }
  } else if (kind === 'line' || kind === 'path') {
    const src = Array.isArray(s.points) && s.points.length ? s.points : [[-w / 2, 0], [w / 2, 0]]
    const P = src.map(normPoint)
    closed = kind === 'path' && !!s.closed
    pts.push([P[0].x, P[0].y])
    const seg = (a, b) => {
      if (!a.o[0] && !a.o[1] && !b.i[0] && !b.i[1]) pts.push([b.x, b.y])
      else bez(pts, [a.x, a.y], [a.x + a.o[0], a.y + a.o[1]], [b.x + b.i[0], b.y + b.i[1]], [b.x, b.y])
    }
    for (let i = 1; i < P.length; i++) seg(P[i - 1], P[i])
    if (closed && P.length > 1) { seg(P[P.length - 1], P[0]); pts.pop() }
  } else return null
  return { pts, closed }
}

// 折れ線の start〜end(0〜1、長さの割合)の部分を取り出す。閉じた形は一周を 1 とする
function trimPolyline(pts, closed, a, b) {
  const P = closed ? [...pts, pts[0]] : pts
  const cum = [0]
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]))
  const total = cum[cum.length - 1]
  if (total <= 0) return []
  const at = (d) => {
    let i = 1
    while (i < P.length - 1 && cum[i] < d) i++
    const t = (d - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1])
    return [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * t, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t]
  }
  const piece = (d0, d1) => {
    const out = [at(d0)]
    for (let i = 1; i < P.length - 1; i++) if (cum[i] > d0 && cum[i] < d1) out.push(P[i])
    out.push(at(d1))
    return out
  }
  const d0 = a * total, d1 = b * total
  if (d1 - d0 <= 1e-6) return []
  return [piece(d0, d1)]
}

function makeFill(ctx, fill, bb) {
  if (fill == null || fill === false || fill === 'none') return null
  const g = fill && typeof fill === 'object' && !Array.isArray(fill) ? fill.gradient : null
  if (!g) return toCss(fill)
  const stops = g.stops || [[0, '#ffffff'], [1, '#000000']]
  let gr
  if (g.type === 'radial') {
    const c = g.from || [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2]
    const r = g.radius ?? (g.to ? Math.hypot(g.to[0] - c[0], g.to[1] - c[1]) : Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2)
    gr = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], Math.max(0.01, r))
  } else {
    const a = g.from || [(bb.x0 + bb.x1) / 2, bb.y0], b = g.to || [(bb.x0 + bb.x1) / 2, bb.y1]
    gr = ctx.createLinearGradient(a[0], a[1], b[0], b[1])
  }
  for (const st of stops) gr.addColorStop(Math.min(1, Math.max(0, st[0])), toCss(st[1]))
  return gr
}

// s: 評価済みの source。rs: ラスタライズの倍率。→ {canvas, rect:{x,y,w,h}}(rect はレイヤー空間)
export function rasterShape(s, rs) {
  const poly = shapePolyline(s)
  if (!poly || poly.pts.length < 2) return null
  const { pts, closed } = poly
  const hasStroke = s.stroke != null && s.stroke !== 'none' && num(s.stroke_width, 0) > 0
  const sw = hasStroke ? num(s.stroke_width, 0) : 0
  const fillDef = s.fill === undefined && !hasStroke ? '#ffffff' : s.fill
  const join = s.join || 'round', cap = s.cap || 'butt'
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
  const bb = { x0, y0, x1, y1 }
  const pad = sw * (join === 'miter' ? 2 : cap === 'square' ? 0.75 : 0.5) + 2
  const rx = Math.floor(x0 - pad), ry = Math.floor(y0 - pad)
  const rw = Math.ceil(x1 + pad) - rx, rh = Math.ceil(y1 + pad) - ry
  rs = Math.min(rs, MAX_TEX / rw, MAX_TEX / rh)
  const [canvas, ctx] = makeCanvas(rw * rs, rh * rs)
  ctx.setTransform(rs, 0, 0, rs, -rx * rs, -ry * rs)
  const trace = (list, close) => {
    ctx.beginPath()
    ctx.moveTo(list[0][0], list[0][1])
    for (let i = 1; i < list.length; i++) ctx.lineTo(list[i][0], list[i][1])
    if (close) ctx.closePath()
  }
  const fill = makeFill(ctx, fillDef, bb)
  if (fill && pts.length > 2) { trace(pts, true); ctx.fillStyle = fill; ctx.fill() }
  if (hasStroke) {
    ctx.strokeStyle = makeFill(ctx, s.stroke, bb)
    ctx.lineWidth = sw; ctx.lineJoin = join; ctx.lineCap = cap
    const tr = Array.isArray(s.trim) ? s.trim : null
    let a = tr ? num(tr[0], 0) / 100 : 0, b = tr ? num(tr[1], 100) / 100 : 1
    if (a > b) [a, b] = [b, a]
    a = Math.max(0, a); b = Math.min(1, b)
    const off = num(s.trim_offset, 0) / 100
    if (a <= 0 && b >= 1) { trace(pts, closed); ctx.stroke() }
    else if (b > a) {
      // 閉じた形で offset を使うと終点をまたぐので 2 本に分ける
      let segs
      if (closed && off) {
        const a2 = (((a + off) % 1) + 1) % 1, b2 = a2 + (b - a)
        segs = b2 <= 1 ? trimPolyline(pts, true, a2, b2) : [...trimPolyline(pts, true, a2, 1), ...trimPolyline(pts, true, 0, b2 - 1)]
      } else segs = trimPolyline(pts, closed, a, b)
      for (const sg of segs) { trace(sg, false); ctx.stroke() }
    }
  }
  // rect = テクスチャを貼る矩形(線の太さぶん広い)、box = 形そのものの外接矩形(マスク・選択枠の基準)
  return { canvas, rect: { x: rx, y: ry, w: rw, h: rh }, box: { x: x0, y: y0, w: Math.max(1e-3, x1 - x0), h: Math.max(1e-3, y1 - y0) } }
}

export { toColor }
