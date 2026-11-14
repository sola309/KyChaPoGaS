// シェイプのラスタライズ(Canvas2D)。形はいったん折れ線にしてから描くので、
// どの形でも trim(線を描いていく)・破線が同じ計算で効く。
import { toCss, toColor, num, rand01, clamp } from './props.js'

export const MAX_TEX = 4096
const D2R = Math.PI / 180

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
// ハンドルつきの点の並び → 折れ線
export function flattenPath(points, closed) {
  const P = points.map(normPoint)
  const pts = [[P[0].x, P[0].y]]
  const seg = (a, b) => {
    if (!a.o[0] && !a.o[1] && !b.i[0] && !b.i[1]) pts.push([b.x, b.y])
    else bez(pts, [a.x, a.y], [a.x + a.o[0], a.y + a.o[1]], [b.x + b.i[0], b.y + b.i[1]], [b.x, b.y])
  }
  for (let i = 1; i < P.length; i++) seg(P[i - 1], P[i])
  if (closed && P.length > 1) { seg(P[P.length - 1], P[0]); pts.pop() }
  return pts
}
// 多角形の角を丸める(半径 r。辺の半分より大きくはしない)
function roundCorners(pts, r) {
  if (!(r > 0.01) || pts.length < 3) return pts
  const out = [], n = pts.length
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i + n - 1) % n], b = pts[(i + 1) % n]
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1])
    const d = Math.min(r, la / 2, lb / 2)
    if (d < 0.01) { out.push(p); continue }
    const s = [p[0] + ((a[0] - p[0]) / la) * d, p[1] + ((a[1] - p[1]) / la) * d]
    const e = [p[0] + ((b[0] - p[0]) / lb) * d, p[1] + ((b[1] - p[1]) / lb) * d]
    const k = Math.max(3, Math.ceil(d / 3))
    for (let j = 0; j <= k; j++) {
      const t = j / k, u = 1 - t
      out.push([u * u * s[0] + 2 * u * t * p[0] + t * t * e[0], u * u * s[1] + 2 * u * t * p[1] + t * t * e[1]])
    }
  }
  return out
}
// 角度(0° = 上・時計回り)の円弧の点
function arcPts(out, rx, ry, a0, a1, rev = false) {
  const n = Math.max(4, Math.ceil((Math.abs(a1 - a0) / 360) * Math.min(256, Math.max(48, (rx + ry) / 3))))
  for (let i = 0; i <= n; i++) {
    const a = (a0 + ((rev ? n - i : i) / n) * (a1 - a0)) * D2R
    out.push([Math.sin(a) * rx, -Math.cos(a) * ry])
  }
}

// → {pts: [[x,y]...], closed, holes?: [[...]]}。座標はレイヤー空間(原点 = レイヤーの中心)
export function shapePolyline(s) {
  const kind = s.kind || 'rect'
  const w = num(s.width, 100), h = num(s.height, num(s.width, 100))
  let pts = []
  let closed = true, holes = null
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
  } else if (kind === 'polygon' || kind === 'star' || kind === 'burst') {
    const burst = kind === 'burst'
    const sides = Math.max(3, Math.round(num(s.sides ?? s.points_n, kind === 'polygon' ? 6 : burst ? 14 : 5)))
    const inner = kind === 'polygon' ? 1 : num(s.inner, burst ? 0.72 : 0.5)
    const n = kind === 'polygon' ? sides : sides * 2
    const jit = burst ? clamp(num(s.jitter, 0.2), 0, 1) : 0, seed = num(s.seed, 1) | 0
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2
      let k = kind !== 'polygon' && i % 2 ? inner : 1
      if (jit) k *= 1 - jit * rand01(seed, i, 3) * (i % 2 ? 0.5 : 1)
      pts.push([Math.cos(a) * w / 2 * k, Math.sin(a) * h / 2 * k])
    }
    pts = roundCorners(pts, num(s.radius, 0))
  } else if (kind === 'arc' || kind === 'pie' || kind === 'ring') {
    let a0 = num(s.start, 0), a1 = num(s.end, 360)
    if (a1 < a0) [a0, a1] = [a1, a0]
    a1 = Math.min(a1, a0 + 360)
    const full = a1 - a0 >= 359.999
    if (a1 - a0 < 1e-4) return null
    if (kind === 'arc') { arcPts(pts, w / 2, h / 2, a0, a1); closed = full; if (full) pts.pop() }
    else if (kind === 'pie') { if (!full) pts.push([0, 0]); arcPts(pts, w / 2, h / 2, a0, a1); if (full) pts.pop() }
    else {
      const k = clamp(num(s.inner, 0.6), 0, 0.999)
      if (full) { arcPts(pts, w / 2, h / 2, a0, a1); pts.pop(); const hl = []; arcPts(hl, w / 2 * k, h / 2 * k, a0, a1); hl.pop(); holes = [hl] }
      else { arcPts(pts, w / 2, h / 2, a0, a1); arcPts(pts, w / 2 * k, h / 2 * k, a0, a1, true) }
    }
  } else if (kind === 'arrow') {
    const hd = clamp(num(s.head, 0.4), 0.02, 1) * w, sh = clamp(num(s.shaft, 0.4), 0.01, 1) * h / 2
    pts.push([-w / 2, -sh], [w / 2 - hd, -sh], [w / 2 - hd, -h / 2], [w / 2, 0], [w / 2 - hd, h / 2], [w / 2 - hd, sh], [-w / 2, sh])
    pts = roundCorners(pts, num(s.radius, 0))
  } else if (kind === 'chevron') {
    const t = clamp(num(s.thickness, 0.4), 0.02, 1) * w
    pts.push([-w / 2, -h / 2], [-w / 2 + t, -h / 2], [w / 2, 0], [-w / 2 + t, h / 2], [-w / 2, h / 2], [w / 2 - t, 0])
    pts = roundCorners(pts, num(s.radius, 0))
  } else if (kind === 'cross') {
    const tx = clamp(num(s.thickness, 0.33), 0.02, 1) * w / 2, ty = clamp(num(s.thickness, 0.33), 0.02, 1) * h / 2
    const X = w / 2, Y = h / 2
    pts.push([-tx, -Y], [tx, -Y], [tx, -ty], [X, -ty], [X, ty], [tx, ty], [tx, Y], [-tx, Y], [-tx, ty], [-X, ty], [-X, -ty], [-tx, -ty])
    pts = roundCorners(pts, num(s.radius, 0))
  } else if (kind === 'heart') {
    const n = 96
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2
      const x = 16 * Math.sin(t) ** 3, y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
      pts.push([(x / 32) * w, ((y + 2.4) / 29) * h])
    }
  } else if (kind === 'flower') {
    // 丸い花びらを n 枚(梅の花の形)。inner = 花びらの重なりぐあい(小さいほど切れ込みが深い)
    const n = Math.max(3, Math.round(num(s.petals ?? s.sides, 5)))
    const ov = 0.9 + clamp(num(s.inner, 0.5), 0, 1) * 0.6
    const c = 1 / (1 + ov * Math.sin(Math.PI / n)), rp = 1 - c
    const steps = Math.max(120, n * 36)
    for (let i = 0; i < steps; i++) {
      const th = (i / steps) * Math.PI * 2
      let r = 0
      for (let k = 0; k < n; k++) {
        let d = th - (k / n) * Math.PI * 2
        d = Math.atan2(Math.sin(d), Math.cos(d))
        const q = rp * rp - c * c * Math.sin(d) ** 2
        if (Math.abs(d) < Math.PI / 2 && q >= 0) r = Math.max(r, c * Math.cos(d) + Math.sqrt(q))
      }
      pts.push([Math.sin(th) * r * w / 2, -Math.cos(th) * r * h / 2])
    }
  } else if (kind === 'petal') {
    // 桜の花びら 1 枚(先に切れ込み)。下が付け根
    const P = [
      { x: 0, y: h / 2, in: [w * 0.25, -h * 0.15], out: [-w * 0.25, -h * 0.15] },
      { x: -w / 2, y: -h * 0.12, in: [0, h * 0.28], out: [0, -h * 0.22] },
      { x: -w * 0.14, y: -h / 2, in: [-w * 0.22, 0], out: [w * 0.03, h * 0.05] },
      { x: 0, y: -h * 0.38 },
      { x: w * 0.14, y: -h / 2, in: [-w * 0.03, h * 0.05], out: [w * 0.22, 0] },
      { x: w / 2, y: -h * 0.12, in: [0, -h * 0.22], out: [0, h * 0.28] },
    ]
    pts = flattenPath(P, true)
  } else if (kind === 'bubble') {
    const r = Math.max(0, Math.min(num(s.radius, 24), w / 2, h / 2))
    const base = shapePolyline({ kind: 'rect', width: w, height: h, radius: r }).pts
    const tw = Math.min(num(s.tail_width, 40), w - 2 * r - 2), tx = clamp(num(s.tail_x, -0.2), -0.5, 0.5) * (w - 2 * r - tw)
    const tip = Array.isArray(s.tail) ? s.tail : [tx - 30, h / 2 + 50]
    // 下の辺(右から左へ進む)にしっぽを差し込む
    for (const p of base) {
      pts.push(p)
      if (!pts._tail && Math.abs(p[1] - h / 2) < 1e-6 && p[0] <= w / 2 - r + 1e-6 && tw > 2) {
        pts._tail = true
        pts.push([tx + tw / 2, h / 2], [+tip[0] || 0, +tip[1] || 0], [tx - tw / 2, h / 2])
      }
    }
    delete pts._tail
  } else if (kind === 'line' || kind === 'path') {
    let src = Array.isArray(s.points) && s.points.length ? s.points : [[-w / 2, 0], [w / 2, 0]]
    closed = kind === 'path' && !!s.closed
    // morph: 同じ頂点数の別のパスとの間を補間する
    const to = s.morph_to, k = clamp(num(s.morph, 0) / 100, 0, 1)
    if (Array.isArray(to) && to.length === src.length && k > 0) {
      const A = src.map(normPoint), B = to.map(normPoint), L = (a, b) => a + (b - a) * k
      src = A.map((a, i) => ({ x: L(a.x, B[i].x), y: L(a.y, B[i].y), in: [L(a.i[0], B[i].i[0]), L(a.i[1], B[i].i[1])], out: [L(a.o[0], B[i].o[0]), L(a.o[1], B[i].o[1])] }))
    }
    pts = flattenPath(src, closed)
    if (kind === 'path' && num(s.radius, 0) > 0 && closed) pts = roundCorners(pts, num(s.radius, 0))
  } else return null
  return { pts, closed, holes }
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

export const isPatternFill = (f) => !!f && typeof f === 'object' && !Array.isArray(f) && !!f.pattern
export function makeFill(ctx, fill, bb) {
  if (fill == null || fill === false || fill === 'none') return null
  if (isPatternFill(fill)) return '#ffffff' // 模様はシェーダで塗る。ここでは型(白)だけ
  const g = fill && typeof fill === 'object' && !Array.isArray(fill) ? fill.gradient : null
  if (!g) return toCss(fill)
  const stops = g.stops || [[0, '#ffffff'], [1, '#000000']]
  let gr
  if (g.type === 'radial') {
    const c = g.from || [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2]
    const r = g.radius ?? (g.to ? Math.hypot(g.to[0] - c[0], g.to[1] - c[1]) : Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2)
    gr = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], Math.max(0.01, r))
  } else {
    let a = g.from, b = g.to
    if (!a || !b) {
      // angle(0° = 上へ向かって色が進む。既定 180 = 上から下)
      const ang = num(g.angle, 180) * D2R, dx = Math.sin(ang), dy = -Math.cos(ang)
      const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2
      const half = (Math.abs(dx) * (bb.x1 - bb.x0) + Math.abs(dy) * (bb.y1 - bb.y0)) / 2
      a = [cx - dx * half, cy - dy * half]; b = [cx + dx * half, cy + dy * half]
    }
    gr = ctx.createLinearGradient(a[0], a[1], b[0], b[1])
  }
  for (const st of stops) gr.addColorStop(Math.min(1, Math.max(0, st[0])), toCss(st[1]))
  return gr
}

// s: 評価済みの source。rs: ラスタライズの倍率。
// → {canvas, rect:{x,y,w,h}, box, dual}(rect はレイヤー空間)。
// dual = true のとき canvas は上下 2 段(上 = 塗りの型、下 = 線)で、塗りの色はシェーダの模様が出す
export function rasterShape(s, rs) {
  const poly = shapePolyline(s)
  if (!poly || poly.pts.length < 2) return null
  const { pts, closed, holes } = poly
  const hasStroke = s.stroke != null && s.stroke !== 'none' && num(s.stroke_width, 0) > 0
  const sw = hasStroke ? num(s.stroke_width, 0) : 0
  const fillDef = s.fill === undefined && !hasStroke ? '#ffffff' : s.fill
  const dual = isPatternFill(fillDef)
  const join = s.join || 'round', cap = s.cap || 'butt'
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
  const bb = { x0, y0, x1, y1 }
  // _halo: {width, color} = 形の外側の縁取り(stroke_outline を形のラスタライズに畳み込んだもの。scene.js の haloOf)
  const halo = s._halo && closed && num(s._halo.width, 0) > 0 ? s._halo : null
  const hw = halo ? num(halo.width, 0) : 0
  const pad = (sw + 2 * hw) * (join === 'miter' ? 2 : cap === 'square' ? 0.75 : 0.5) + 2
  const rx = Math.floor(x0 - pad), ry = Math.floor(y0 - pad)
  const rw = Math.ceil(x1 + pad) - rx, rh = Math.ceil(y1 + pad) - ry
  rs = Math.min(rs, MAX_TEX / rw, MAX_TEX / (rh * (dual ? 2 : 1)))
  const ch = Math.ceil(rh * rs)
  const [canvas, ctx] = makeCanvas(rw * rs, dual ? ch * 2 : ch)
  const trace = (list, close) => {
    ctx.moveTo(list[0][0], list[0][1])
    for (let i = 1; i < list.length; i++) ctx.lineTo(list[i][0], list[i][1])
    if (close) ctx.closePath()
  }
  ctx.setTransform(rs, 0, 0, rs, -rx * rs, -ry * rs)
  const fill = makeFill(ctx, fillDef, bb)
  if (halo) {
    // 形(塗り + 線)を hw だけ太らせた形を、縁の色でいちばん下に描く
    ctx.beginPath(); trace(pts, true)
    if (holes) for (const hl of holes) trace(hl, true)
    ctx.strokeStyle = halo.color; ctx.lineWidth = sw + 2 * hw; ctx.lineJoin = join === 'miter' ? 'miter' : 'round'
    ctx.stroke()
  }
  if (fill && pts.length > 2) {
    ctx.beginPath(); trace(pts, true)
    if (holes) for (const hl of holes) trace(hl, true)
    ctx.fillStyle = fill; ctx.fill(holes ? 'evenodd' : 'nonzero')
  }
  if (hasStroke) {
    if (dual) ctx.setTransform(rs, 0, 0, rs, -rx * rs, -ry * rs + ch)
    ctx.strokeStyle = makeFill(ctx, s.stroke, bb)
    ctx.lineWidth = sw; ctx.lineJoin = join; ctx.lineCap = cap
    if (Array.isArray(s.dash) && s.dash.length) {
      ctx.setLineDash(s.dash.map((v) => Math.max(0.01, +v || 0)))
      ctx.lineDashOffset = num(s.dash_offset, 0)
    }
    const tr = Array.isArray(s.trim) ? s.trim : null
    let a = tr ? num(tr[0], 0) / 100 : 0, b = tr ? num(tr[1], 100) / 100 : 1
    if (a > b) [a, b] = [b, a]
    a = Math.max(0, a); b = Math.min(1, b)
    const off = num(s.trim_offset, 0) / 100
    if (a <= 0 && b >= 1) {
      ctx.beginPath(); trace(pts, closed)
      if (holes) for (const hl of holes) trace(hl, true)
      ctx.stroke()
    } else if (b > a) {
      // 閉じた形で offset を使うと終点をまたぐので 2 本に分ける
      let segs
      if (closed && off) {
        const a2 = (((a + off) % 1) + 1) % 1, b2 = a2 + (b - a)
        segs = b2 <= 1 ? trimPolyline(pts, true, a2, b2) : [...trimPolyline(pts, true, a2, 1), ...trimPolyline(pts, true, 0, b2 - 1)]
      } else segs = trimPolyline(pts, closed, a, b)
      for (const sg of segs) { ctx.beginPath(); trace(sg, false); ctx.stroke() }
    }
  }
  // rect = テクスチャを貼る矩形(線の太さぶん広い)、box = 形そのものの外接矩形(マスク・選択枠の基準)
  // stroke_in_box: 線の外側の縁までを箱にする(AviUtl の図形 + ライン幅と同じ。crop・マスクなど「箱から測るもの」の基準が線の外側になる)
  const bg = s.stroke_in_box && hasStroke ? sw / 2 : 0
  return { canvas, rect: { x: rx, y: ry, w: rw, h: rh }, box: { x: x0 - bg, y: y0 - bg, w: Math.max(1e-3, x1 - x0 + 2 * bg), h: Math.max(1e-3, y1 - y0 + 2 * bg) }, dual }
}

export { toColor }
