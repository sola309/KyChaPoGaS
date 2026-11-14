// 手続きで作る 3D(mesh レイヤー)。箱・球・回転体・押し出し・立体文字・管・破片と、その複製(InstancedMesh)を
// three.js の通常のマテリアルで別の RT に描き、画面大の絵としてレイヤーに戻す(model.js と同じ流れ)。
//   - 座標は文書の決まり(px・y 下・z 奥)。形そのものは three.js の座標(y 上・z 手前)で作り、置くときに直す
//   - 形(ジオメトリ)は「形を決める項目」の値ごとに作って使い回す。コマごとに動かすのは行列と複製の行列だけ
//   - 乱数はすべて props.js の rand01(種つき)。複製の動きは時刻の式(f だけで決まる)
import { THREE } from './gfx.js'
import { evalProp, num, vec, toColor, rand01, clamp } from './props.js'
import { shapePolyline, makeCanvas } from './shape.js'
import { fontSpec } from './text.js'

const D2R = Math.PI / 180
const FLIP = new THREE.Matrix4().makeScale(1, -1, -1)
const MAX_INST = 20000
const MAX_GEO = 240 // 形の使い回しの上限(超えたら、しばらく使っていないものから捨てる)

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4()
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _t = new THREE.Vector3(), _u = new THREE.Vector3(), _b = new THREE.Vector3()
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler()
const _col = new THREE.Color()

// ---- 値の評価 -------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
// {"x": <prop>, "y": <prop>, "z": <prop>} の分け書き
const isXYZ = (v) => { const ks = Object.keys(v); return ks.length > 0 && ks.every((k) => k === 'x' || k === 'y' || k === 'z') }
// オブジェクトの中のプロパティ値(キーフレームなど)を、入れ子の中まで評価する。配列は成分がプロパティ値のときだけ評価する
function evalTree(o, f, fps) {
  const out = {}
  for (const k of Object.keys(o)) {
    let v = o[k]
    if (k !== 'children' && k !== 'faces' && isObj(v)) {
      v = evalProp(v, f, fps)
      if (isObj(v)) v = isXYZ(v) ? [num(evalProp(v.x, f, fps), 0), num(evalProp(v.y, f, fps), 0), num(evalProp(v.z, f, fps), 0)] : evalTree(v, f, fps)
    } else if (Array.isArray(v) && v.length <= 4 && v.some(isObj) && k !== 'children' && k !== 'faces') v = v.map((x) => (isObj(x) ? evalProp(x, f, fps) : x)) // [10, {k:…}, 0] のような成分ごとのキー

    out[k] = v
  }
  return out
}
const v3 = (v, d = 0) => vec(v, 3, d)
// 回転(度)。数 1 個なら z
const rot3 = (v) => (Array.isArray(v) ? [+v[0] || 0, +v[1] || 0, +v[2] || 0] : [0, 0, num(v, 0)])
// 文書の回転(度。X·Y·Z の順、レイヤーの transform.rotation と同じ向き)→ three.js の座標での回転
const setEuler = (e, r) => e.set(-r[0] * D2R, r[1] * D2R, -r[2] * D2R, 'XYZ')
const pair = (v, d0, d1) => (Array.isArray(v) ? [num(v[0], d0), num(v[1], v.length > 1 ? d1 : num(v[0], d0))] : typeof v === 'number' ? [v, v] : [d0, d1])

// ---- 曲線(管・道に沿った複製)--------------------------------------------
class FnCurve extends THREE.Curve {
  constructor(fn, div = 200) { super(); this.fn = fn; this.arcLengthDivisions = div }
  getPoint(t, target = new THREE.Vector3()) { return this.fn(t, target) }
}
// path: {type: helix|circle|line|points, ...}。座標は文書の決まり(y 下・z 奥)で書き、ここで three.js の座標に直す
function makeCurve(p) {
  p = isObj(p) ? p : {}
  const type = p.type || (Array.isArray(p.points) ? 'points' : p.from || p.to ? 'line' : 'helix')
  if (type === 'line') {
    const a = v3(p.from ?? [-200, 0, 0]), b = v3(p.to ?? [200, 0, 0])
    const c = new THREE.LineCurve3(new THREE.Vector3(a[0], -a[1], -a[2]), new THREE.Vector3(b[0], -b[1], -b[2]))
    c.closedPath = false
    return c
  }
  if (type === 'points') {
    const pts = (Array.isArray(p.points) ? p.points : []).map((q) => new THREE.Vector3(+q[0] || 0, -(+q[1] || 0), -(+q[2] || 0)))
    if (pts.length < 2) pts.push(new THREE.Vector3(-100, 0, 0), new THREE.Vector3(100, 0, 0))
    const closed = !!p.closed
    let c
    if (p.curve === 'linear') {
      const P = closed ? [...pts, pts[0]] : pts, n = P.length - 1
      c = new FnCurve((t, out) => { const x = clamp(t, 0, 1) * n, i = Math.min(n - 1, Math.floor(x)); return out.lerpVectors(P[i], P[i + 1], x - i) }, Math.max(200, n * 8))
    } else c = new THREE.CatmullRomCurve3(pts, closed, 'catmullrom', clamp(num(p.tension, 0.5), 0, 1))
    c.arcLengthDivisions = Math.max(200, pts.length * 24)
    c.closedPath = closed
    return c
  }
  // helix / circle: 軸(既定 y = 縦)のまわりを回る。角度 0 = 手前(軸 z のときは上)、t が進むと右へ回る
  const circle = type === 'circle'
  const r0 = num(p.radius, 300), r1 = circle ? r0 : num(p.radius_end, r0)
  const turns = circle ? clamp(num(p.arc, 360), -360, 360) / 360 : num(p.turns, 3)
  const h = circle ? 0 : num(p.height, 400)
  const a0 = num(p.start, 0) * D2R, axis = p.axis === 'x' || p.axis === 'z' ? p.axis : 'y'
  const c = new FnCurve((t, out) => {
    const a = a0 + t * turns * Math.PI * 2, r = r0 + (r1 - r0) * t, d = -h / 2 + h * t
    const s = Math.sin(a) * r, k = Math.cos(a) * r
    return axis === 'y' ? out.set(s, d, k) : axis === 'z' ? out.set(s, k, -d) : out.set(d, k, s)
  }, Math.max(200, Math.ceil(Math.abs(turns) * 96)))
  c.closedPath = circle && Math.abs(turns) >= 0.9999
  return c
}

// ---- 文字の輪郭(Canvas2D の絵から起こす)----------------------------------
// アルファの等高線(しきい値 50%)をマーチングスクエアでたどる。→ 閉じた折れ線の列(絵の画素の座標・y 下)
function traceAlpha(alpha, W, H) {
  const TH = 127.5
  const next = new Int32Array(W * H * 2).fill(-1)
  const A = (x, y) => alpha[y * W + x]
  const hId = (x, y) => (y * W + x) * 2, vId = (x, y) => (y * W + x) * 2 + 1
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = A(x, y) > TH, tr = A(x + 1, y) > TH, br = A(x + 1, y + 1) > TH, bl = A(x, y + 1) > TH
      const n = (tl ? 1 : 0) + (tr ? 1 : 0) + (br ? 1 : 0) + (bl ? 1 : 0)
      if (n === 0 || n === 4) continue
      const T = hId(x, y), R = vId(x + 1, y), B = hId(x, y + 1), L = vId(x, y)
      if (n === 2 && tl === br) {
        // 鞍点: まん中の値でつなぎ方を決める
        const joined = (A(x, y) + A(x + 1, y) + A(x + 1, y + 1) + A(x, y + 1)) / 4 > TH
        if (tl) { if (joined) { next[T] = R; next[B] = L } else { next[T] = L; next[B] = R } }
        else if (joined) { next[R] = B; next[L] = T } else { next[R] = T; next[L] = B }
        continue
      }
      // 時計回りに角をたどって、内 → 外に出る辺(from)と、外 → 内に入る辺(to)
      let from = -1, to = -1
      if (tl !== tr) { if (tl) from = T; else to = T }
      if (tr !== br) { if (tr) from = R; else to = R }
      if (br !== bl) { if (br) from = B; else to = B }
      if (bl !== tl) { if (bl) from = L; else to = L }
      next[from] = to
    }
  }
  const pt = (id) => {
    const cell = id >> 1, x = cell % W, y = (cell - x) / W
    if (id & 1) { const a = A(x, y), b = A(x, y + 1); return [x, y + (TH - a) / (b - a)] }
    const a = A(x, y), b = A(x + 1, y)
    return [x + (TH - a) / (b - a), y]
  }
  const loops = []
  for (let s = 0; s < next.length; s++) {
    if (next[s] < 0) continue
    const loop = []
    let id = s
    while (id >= 0 && next[id] >= 0) { loop.push(pt(id)); const n = next[id]; next[id] = -1; id = n }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}
// 閉じた折れ線を間引く(Douglas–Peucker)
function simplifyLoop(pts, eps) {
  const n = pts.length
  if (n < 8) return pts
  // いちばん離れた 2 点で 2 本に分ける
  let far = 0, fd = -1
  for (let i = 1; i < n; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i } }
  const keep = new Uint8Array(n + 1)
  const P = [...pts, pts[0]]
  keep[0] = keep[far] = keep[n] = 1
  const stack = [[0, far], [far, n]]
  while (stack.length) {
    const [a, b] = stack.pop()
    if (b - a < 2) continue
    const ax = P[a][0], ay = P[a][1], dx = P[b][0] - ax, dy = P[b][1] - ay, len = Math.hypot(dx, dy) || 1e-9
    let md = -1, mi = -1
    for (let i = a + 1; i < b; i++) { const d = Math.abs((P[i][0] - ax) * dy - (P[i][1] - ay) * dx) / len; if (d > md) { md = d; mi = i } }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]) }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i])
  return out
}
const loopArea = (p) => { let a = 0; for (let i = 0, n = p.length; i < n; i++) { const q = p[(i + 1) % n]; a += p[i][0] * q[1] - q[0] * p[i][1] } return a / 2 }
function inPoly(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}
// 折れ線の列(外周と穴が混ざっている。y 下)→ THREE.Shape の列(y 上)。外周 = 面積が正の輪、穴はそれを含むいちばん小さい外周に付ける
function loopsToShapes(loops, sx, sy, ox, oy) {
  const outers = [], holes = []
  for (const lp of loops) {
    const a = loopArea(lp)
    if (Math.abs(a) < 0.5) continue
    ;(a > 0 ? outers : holes).push({ pts: lp, area: Math.abs(a), holes: [] })
  }
  if (!outers.length && holes.length) { outers.push(...holes); holes.length = 0 } // 向きが逆の入力
  for (const h of holes) {
    let best = null
    for (const o of outers) if (o.area > h.area && inPoly(h.pts[0], o.pts) && (!best || o.area < best.area)) best = o
    best?.holes.push(h.pts)
  }
  const cv = (pts) => pts.map((p) => new THREE.Vector2(p[0] * sx + ox, -(p[1] * sy + oy)))
  return outers.map((o) => {
    const s = new THREE.Shape(cv(o.pts))
    for (const h of o.holes) s.holes.push(new THREE.Path(cv(h)))
    return s
  })
}
// 立体文字の書体(太さの既定は 700)
const meshFont = (p, size) => fontSpec({ font: p.font, italic: p.italic, weight: num(p.weight, 700) }, size)
// 文字 → 輪郭。箱(行の並び)の中心が原点
function textShapes(p) {
  const fs = Math.max(1, num(p.font_size ?? p.size, 200))
  const lines = String(p.text ?? '').split('\n')
  const lead = num(p.leading, 1.2) * fs, track = num(p.tracking, 0)
  let k = clamp((320 / fs) * clamp(num(p.quality, 1), 0.25, 4), 0.25, 8)
  const [mc, mctx] = makeCanvas(4, 4)
  const setFont = (ctx, kk) => {
    ctx.font = meshFont(p, fs * kk)
    try { ctx.letterSpacing = `${track * kk}px` } catch { /* 古いブラウザ */ }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'
  }
  setFont(mctx, 1)
  const ms = lines.map((s) => mctx.measureText(s))
  const fm = mctx.measureText('Mgあ永')
  const asc = fm.fontBoundingBoxAscent ?? fs * 0.88, desc = fm.fontBoundingBoxDescent ?? fs * 0.12
  const widths = ms.map((m) => Math.max(0, m.width - (lines.length && track ? track : 0)))
  const boxW = Math.max(1, ...widths), boxH = asc + desc + lead * (lines.length - 1)
  mc.width = mc.height = 1
  // 絵の範囲: 箱 + はみ出し(斜体・飾りのぶん)
  const pad = fs * 0.35 + 4
  const cw = boxW + pad * 2, ch = boxH + pad * 2
  k = Math.min(k, 4096 / cw, 4096 / ch)
  const [cvs, ctx] = makeCanvas(Math.ceil(cw * k) + 2, Math.ceil(ch * k) + 2)
  setFont(ctx, k)
  ctx.fillStyle = '#fff'
  const align = p.align === 'left' || p.align === 'right' ? p.align : 'center'
  lines.forEach((s, i) => {
    const x = align === 'left' ? 0 : align === 'right' ? boxW - widths[i] : (boxW - widths[i]) / 2
    ctx.fillText(s, (pad + x) * k + 1, (pad + asc + lead * i) * k + 1)
  })
  const W = cvs.width, H = cvs.height
  const data = ctx.getImageData(0, 0, W, H).data
  const alpha = new Uint8Array(W * H)
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = data[j]
  // 外周の 1 画素は必ず外(輪が閉じるように)
  for (let x = 0; x < W; x++) alpha[x] = alpha[(H - 1) * W + x] = 0
  for (let y = 0; y < H; y++) alpha[y * W] = alpha[y * W + W - 1] = 0
  cvs.width = cvs.height = 1
  const eps = clamp(num(p.simplify, 0.3), 0.05, 4)
  const loops = traceAlpha(alpha, W, H).map((lp) => simplifyLoop(lp, eps)).filter((lp) => lp.length >= 3)
  // 画素の中心 = +0.5、描いた位置 = +1。箱の中心を原点に
  return loopsToShapes(loops, 1 / k, 1 / k, (0.5 - 1) / k - pad - boxW / 2, (0.5 - 1) / k - pad - boxH / 2)
}

// ---- 形 -------------------------------------------------------------------
// 押し出しの形: points([[x,y],…]。y 下)か shape(シェイプレイヤーと同じ kind。文字列なら size の大きさ)
function extrudeShapes(p) {
  if (Array.isArray(p.points) && p.points.length >= 3) {
    const loops = [p.points.map((q) => [+q[0] || 0, +q[1] || 0])]
    if (loopArea(loops[0]) < 0) loops[0].reverse()
    for (const h of Array.isArray(p.holes) ? p.holes : []) {
      if (!Array.isArray(h) || h.length < 3) continue
      const hp = h.map((q) => [+q[0] || 0, +q[1] || 0])
      if (loopArea(hp) > 0) hp.reverse()
      loops.push(hp)
    }
    return loopsToShapes(loops, 1, 1, 0, 0)
  }
  const sz = pair(p.size, 200, 200)
  const sd = isObj(p.shape) ? { width: sz[0], height: sz[1], ...p.shape } : { kind: typeof p.shape === 'string' ? p.shape : 'star', width: sz[0], height: sz[1] }
  for (const k of ['sides', 'inner', 'radius', 'petals', 'thickness', 'head', 'shaft', 'start', 'end']) if (sd[k] === undefined && p['shape_' + k] !== undefined) sd[k] = p['shape_' + k]
  if (sd.kind === 'hexagon') { sd.kind = 'polygon'; sd.sides = 6 } else if (sd.kind === 'pentagon') { sd.kind = 'polygon'; sd.sides = 5 } else if (sd.kind === 'triangle') { sd.kind = 'polygon'; sd.sides = 3 }
  else if (sd.kind === 'rounded_rect') { sd.kind = 'rect'; sd.radius ??= Math.min(sz[0], sz[1]) * 0.2 } else if (sd.kind === 'circle') sd.kind = 'ellipse'
  const poly = shapePolyline(sd)
  if (!poly || !poly.pts || poly.pts.length < 3) return []
  const loops = [poly.pts.map((q) => [q[0], q[1]])]
  if (loopArea(loops[0]) < 0) loops[0].reverse()
  for (const h of poly.holes || []) { const hp = h.map((q) => [q[0], q[1]]); if (loopArea(hp) > 0) hp.reverse(); loops.push(hp) }
  return loopsToShapes(loops, 1, 1, 0, 0)
}
// なめらかな面だけ法線をならす(角度が crease 度より大きい折れ目は残す)。インデックスなしの形むけ
// flatZ: 表・裏の面(法線が ±z)は平らなまま残す(面取りにつられて表の面に陰が出ないように)
function creaseNormals(geo, creaseDeg, flatZ = false) {
  const pos = geo.attributes.position, n = pos.count, a = pos.array
  const fn = new Float32Array(n) // 面ごとの法線(面積の重みつき)を頂点ごとに持つ
  const fx = new Float32Array(n), fy = new Float32Array(n), fz = new Float32Array(n)
  for (let i = 0; i < n; i += 3) {
    const ax = a[i * 3], ay = a[i * 3 + 1], az = a[i * 3 + 2]
    const ux = a[i * 3 + 3] - ax, uy = a[i * 3 + 4] - ay, uz = a[i * 3 + 5] - az
    const vx = a[i * 3 + 6] - ax, vy = a[i * 3 + 7] - ay, vz = a[i * 3 + 8] - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    for (let j = 0; j < 3; j++) { fx[i + j] = nx; fy[i + j] = ny; fz[i + j] = nz; fn[i + j] = l }
  }
  const map = new Map()
  const q = (v) => Math.round(v * 256)
  for (let i = 0; i < n; i++) {
    const key = q(a[i * 3]) + ',' + q(a[i * 3 + 1]) + ',' + q(a[i * 3 + 2])
    let l = map.get(key)
    if (!l) map.set(key, (l = []))
    l.push(i)
  }
  const cosT = Math.cos(creaseDeg * D2R)
  const out = new Float32Array(n * 3)
  for (const l of map.values()) {
    for (const i of l) {
      if (!(fn[i] > 0)) continue
      if (flatZ && Math.abs(fz[i]) > fn[i] * 0.9999) { out[i * 3 + 2] = fz[i] > 0 ? 1 : -1; continue }
      let sx = 0, sy = 0, sz = 0
      for (const j of l) {
        if (!(fn[j] > 0)) continue
        const d = (fx[i] * fx[j] + fy[i] * fy[j] + fz[i] * fz[j]) / (fn[i] * fn[j])
        if (d >= cosT) { sx += fx[j]; sy += fy[j]; sz += fz[j] }
      }
      const s = Math.hypot(sx, sy, sz) || 1
      out[i * 3] = sx / s; out[i * 3 + 1] = sy / s; out[i * 3 + 2] = sz / s
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3))
}
// uv を、形の外接矩形に合わせて振り直す(押し出し・文字。側面は縁の色が伸びる)
function boxUv(geo) {
  geo.computeBoundingBox()
  const bb = geo.boundingBox, pos = geo.attributes.position, uv = new Float32Array(pos.count * 2)
  const w = Math.max(1e-6, bb.max.x - bb.min.x), h = Math.max(1e-6, bb.max.y - bb.min.y)
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = (pos.getX(i) - bb.min.x) / w; uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / h }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}
function extrudeGeo(shapes, p) {
  if (!shapes.length) return new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)).setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3)).setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2))
  const depth = Math.max(0, num(p.depth, 40))
  const bv = isObj(p.bevel) ? p.bevel : typeof p.bevel === 'number' && p.bevel > 0 ? { size: p.bevel } : null
  const bsize = bv ? Math.max(0, num(bv.size, 4)) : 0
  let geo
  if (isObj(p.path) && p.geometry === 'extrude') {
    // 断面を道に沿って伸ばす(レール・帯)。面取りは付かない
    const curve = makeCurve(p.path)
    geo = new THREE.ExtrudeGeometry(shapes, { steps: Math.max(2, Math.round(num(Array.isArray(p.segments) ? p.segments[0] : p.segments, 200))), bevelEnabled: false, extrudePath: curve, curveSegments: 8 })
    creaseNormals(geo, num(p.smooth_angle, 40))
    return geo
  }
  if (depth <= 0 && !(bsize > 0)) geo = new THREE.ShapeGeometry(shapes, Math.max(1, Math.round(num(p.curve_segments, 8))))
  else {
    const bt = bv ? Math.max(0, num(bv.thickness, bsize)) : 0
    geo = new THREE.ExtrudeGeometry(shapes, {
      depth: Math.max(depth - (bsize > 0 ? bt * 2 : 0), 0.001), steps: 1, curveSegments: Math.max(1, Math.round(num(p.curve_segments, 8))),
      bevelEnabled: bsize > 0, bevelSize: bsize, bevelThickness: bt, bevelOffset: bv ? num(bv.offset, 0) : 0, bevelSegments: bv ? Math.max(1, Math.round(num(bv.segments, 3))) : 1,
    })
    // 厚みのまん中を z = 0 に
    geo.computeBoundingBox()
    geo.translate(0, 0, -(geo.boundingBox.max.z + geo.boundingBox.min.z) / 2)
    creaseNormals(geo, num(p.smooth_angle, 40), true)
  }
  boxUv(geo)
  return geo
}
function latheGeo(p) {
  let pts = (Array.isArray(p.profile) && p.profile.length >= 2 ? p.profile : [[0, -120], [80, -40], [100, 40], [0, 120]]).map((q) => new THREE.Vector2(Math.max(0, +q[0] || 0), -(+q[1] || 0)))
  // 下から上へ並べる(法線が外を向く)
  if (pts[0].y > pts[pts.length - 1].y) pts.reverse()
  const sm = Math.round(num(p.smooth, 0))
  if (sm > 0 && pts.length >= 3) pts = new THREE.SplineCurve(pts).getPoints((pts.length - 1) * sm).map((q) => { q.x = Math.max(0, q.x); return q })
  const seg = Math.max(3, Math.round(num(Array.isArray(p.segments) ? p.segments[0] : p.segments, 64)))
  return new THREE.LatheGeometry(pts, seg, 0, clamp(num(p.arc, 360), 1, 360) * D2R)
}
const segOf = (p, i, d) => Math.max(1, Math.round(num(Array.isArray(p.segments) ? p.segments[i] ?? p.segments[0] : p.segments, d)))

// 破片: 四角い板を count 個ほどに割る。→ {polys: [[x,y]…](three.js の座標・凸), cents}
function shardCells(p) {
  const sz = pair(p.size, 1920, 1080), w = sz[0], h = sz[1]
  const count = clamp(Math.round(num(p.count, 120)), 1, 6000), seed = num(p.seed, 1) | 0
  const cols = Math.max(1, Math.round(Math.sqrt((count * w) / Math.max(1, h)))), rows = Math.max(1, Math.round(count / cols))
  const cw = w / cols, ch = h / rows
  const jit = clamp(num(p.jitter, 1), 0, 1)
  const cut = p.cut === 'triangles' || p.cut === 'grid' ? p.cut : 'voronoi'
  const polys = []
  if (cut === 'voronoi') {
    const sx = new Float64Array(cols * rows), sy = new Float64Array(cols * rows)
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const n = j * cols + i
      sx[n] = -w / 2 + (i + 0.5 + (rand01(seed, n, 1) - 0.5) * 0.92 * jit) * cw
      sy[n] = -h / 2 + (j + 0.5 + (rand01(seed, n, 2) - 0.5) * 0.92 * jit) * ch
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const n = j * cols + i
      let poly = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
      // 近くの母点との垂直二等分線で切っていく
      for (let dj = -3; dj <= 3 && poly.length >= 3; dj++) for (let di = -3; di <= 3 && poly.length >= 3; di++) {
        const ii = i + di, jj = j + dj
        if ((!di && !dj) || ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue
        const m = jj * cols + ii
        const nx = sx[m] - sx[n], ny = sy[m] - sy[n], c = (nx * (sx[m] + sx[n]) + ny * (sy[m] + sy[n])) / 2
        const out = []
        for (let a = 0; a < poly.length; a++) {
          const P = poly[a], Q = poly[(a + 1) % poly.length]
          const dp = nx * P[0] + ny * P[1] - c, dq = nx * Q[0] + ny * Q[1] - c
          if (dp <= 0) out.push(P)
          if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) { const t = dp / (dp - dq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]) }
        }
        poly = out
      }
      if (poly.length >= 3) polys.push(poly)
    }
  } else {
    // 格子の角をずらして、四角(grid)か、対角線で 2 枚の三角(triangles)に
    const gx = (i, j) => -w / 2 + (i + (i > 0 && i < cols && cut === 'triangles' ? (rand01(seed, j * (cols + 1) + i, 1) - 0.5) * 0.8 * jit : 0)) * cw
    const gy = (i, j) => -h / 2 + (j + (j > 0 && j < rows && cut === 'triangles' ? (rand01(seed, j * (cols + 1) + i, 2) - 0.5) * 0.8 * jit : 0)) * ch
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const a = [gx(i, j), gy(i, j)], b = [gx(i + 1, j), gy(i + 1, j)], c = [gx(i + 1, j + 1), gy(i + 1, j + 1)], d = [gx(i, j + 1), gy(i, j + 1)]
      if (cut === 'grid') polys.push([a, b, c, d])
      else if (rand01(seed, j * cols + i, 3) < 0.5) polys.push([a, b, c], [a, c, d])
      else polys.push([a, b, d], [b, c, d])
    }
  }
  // 絵の座標(y 下)で作ったので、three.js の座標(y 上)に直す。向きは反時計回り(手前が表)にそろえる
  const outP = polys.map((poly) => { const q = poly.map((v) => [v[0], -v[1]]); if (loopArea(q) < 0) q.reverse(); return q })
  return { polys: outP, w, h }
}
// 破片の土台(頂点・法線・uv・どの破片か)。コマごとに、ここから位置を書き直す
function shardBase(p) {
  const { polys, w, h } = shardCells(p)
  const depth = Math.max(0, num(p.depth, 0)), hz = depth / 2
  let nv = 0
  for (const q of polys) nv += (q.length - 2) * 3 * (depth > 0 ? 2 : 1) + (depth > 0 ? q.length * 6 : 0)
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2)
  const ranges = new Int32Array(polys.length * 2), cents = new Float32Array(polys.length * 2)
  let o = 0
  const put = (x, y, z, nx, ny, nz) => { pos[o * 3] = x; pos[o * 3 + 1] = y; pos[o * 3 + 2] = z; nor[o * 3] = nx; nor[o * 3 + 1] = ny; nor[o * 3 + 2] = nz; uv[o * 2] = x / w + 0.5; uv[o * 2 + 1] = y / h + 0.5; o++ }
  polys.forEach((q, si) => {
    let cx = 0, cy = 0
    for (const v of q) { cx += v[0]; cy += v[1] }
    cents[si * 2] = cx / q.length; cents[si * 2 + 1] = cy / q.length
    ranges[si * 2] = o
    for (let i = 1; i < q.length - 1; i++) { put(q[0][0], q[0][1], hz, 0, 0, 1); put(q[i][0], q[i][1], hz, 0, 0, 1); put(q[i + 1][0], q[i + 1][1], hz, 0, 0, 1) }
    if (depth > 0) {
      for (let i = 1; i < q.length - 1; i++) { put(q[0][0], q[0][1], -hz, 0, 0, -1); put(q[i + 1][0], q[i + 1][1], -hz, 0, 0, -1); put(q[i][0], q[i][1], -hz, 0, 0, -1) }
      for (let i = 0; i < q.length; i++) {
        const a = q[i], b = q[(i + 1) % q.length]
        let nx = b[1] - a[1], ny = -(b[0] - a[0])
        const l = Math.hypot(nx, ny) || 1
        nx /= l; ny /= l
        put(a[0], a[1], hz, nx, ny, 0); put(a[0], a[1], -hz, nx, ny, 0); put(b[0], b[1], hz, nx, ny, 0)
        put(b[0], b[1], hz, nx, ny, 0); put(a[0], a[1], -hz, nx, ny, 0); put(b[0], b[1], -hz, nx, ny, 0)
      }
    }
    ranges[si * 2 + 1] = o
  })
  return { pos, nor, uv, ranges, cents, n: polys.length, w, h }
}

const GEO_KEYS = ['geometry', 'size', 'radius', 'radius_top', 'radius_bottom', 'height', 'tube', 'inner', 'outer', 'segments', 'radial_segments', 'arc', 'start', 'open_ended', 'detail',
  'profile', 'smooth', 'points', 'holes', 'shape', 'shape_sides', 'shape_inner', 'shape_radius', 'shape_petals', 'shape_thickness', 'shape_head', 'shape_shaft', 'shape_start', 'shape_end',
  'depth', 'bevel', 'curve_segments', 'smooth_angle', 'text', 'font', 'weight', 'italic', 'font_size', 'tracking', 'leading', 'align', 'quality', 'simplify', 'path', 'closed', 'count', 'seed', 'cut', 'jitter']
const PATH_USERS = new Set(['tube', 'extrude'])
function geoKey(e, fontEpoch) {
  const o = {}
  for (const k of GEO_KEYS) if (e[k] !== undefined && (k !== 'path' || PATH_USERS.has(e.geometry))) o[k] = e[k]
  if (e.geometry !== 'shards') { delete o.count; delete o.seed; delete o.cut; delete o.jitter }
  if (e.geometry === 'text') o._fe = fontEpoch
  return JSON.stringify(o)
}
// 形を作る(three.js の座標)。知らない種類は null
function buildGeometry(p) {
  const kind = p.geometry || 'box'
  switch (kind) {
    case 'box': { const s = v3(p.size ?? 200, 200); return new THREE.BoxGeometry(Math.max(1e-3, s[0]), Math.max(1e-3, s[1]), Math.max(1e-3, s[2]), segOf(p, 0, 1), segOf(p, 1, 1), segOf(p, 2, 1)) }
    case 'plane': { const s = pair(p.size, 200, 200); return new THREE.PlaneGeometry(s[0], s[1], segOf(p, 0, 1), segOf(p, 1, 1)) }
    case 'sphere': return new THREE.SphereGeometry(Math.max(1e-3, num(p.radius, 100)), Math.max(3, segOf(p, 0, 48)), Math.max(2, Array.isArray(p.segments) ? segOf(p, 1, 32) : Math.max(2, Math.round(segOf(p, 0, 48) * 2 / 3))))
    case 'cylinder': return new THREE.CylinderGeometry(Math.max(0, num(p.radius_top, num(p.radius, 100))), Math.max(0, num(p.radius_bottom, num(p.radius, 100))), num(p.height, 200), Math.max(3, segOf(p, 0, 48)), 1, !!p.open_ended)
    case 'cone': return new THREE.ConeGeometry(Math.max(1e-3, num(p.radius, 100)), num(p.height, 200), Math.max(3, segOf(p, 0, 48)), 1, !!p.open_ended)
    case 'torus': { const arc = clamp(num(p.arc, 360), 1, 360) * D2R; const g = new THREE.TorusGeometry(Math.max(1e-3, num(p.radius, 100)), Math.max(1e-3, num(p.tube, 20)), Math.max(3, Math.round(num(p.radial_segments, 24))), Math.max(3, segOf(p, 0, 96)), arc); g.rotateZ(Math.PI / 2 - num(p.start, 0) * D2R - arc); return g }
    case 'ring': { const arc = clamp(num(p.arc, 360), 1, 360) * D2R; return new THREE.RingGeometry(Math.max(0, num(p.inner, 60)), Math.max(1e-3, num(p.outer ?? p.radius, 120)), Math.max(3, segOf(p, 0, 64)), 1, Math.PI / 2 - num(p.start, 0) * D2R - arc, arc) }
    case 'tetrahedron': return new THREE.TetrahedronGeometry(Math.max(1e-3, num(p.radius, 100)), Math.max(0, Math.round(num(p.detail, 0))))
    case 'octahedron': return new THREE.OctahedronGeometry(Math.max(1e-3, num(p.radius, 100)), Math.max(0, Math.round(num(p.detail, 0))))
    case 'dodecahedron': return new THREE.DodecahedronGeometry(Math.max(1e-3, num(p.radius, 100)), Math.max(0, Math.round(num(p.detail, 0))))
    case 'icosahedron': return new THREE.IcosahedronGeometry(Math.max(1e-3, num(p.radius, 100)), Math.max(0, Math.round(num(p.detail, 0))))
    case 'lathe': return latheGeo(p)
    case 'extrude': return extrudeGeo(extrudeShapes(p), p)
    case 'text': return extrudeGeo(textShapes(p), p)
    case 'tube': {
      const c = makeCurve(p.path)
      return new THREE.TubeGeometry(c, Math.max(2, segOf(p, 0, 200)), Math.max(1e-3, num(p.tube, 20)), Math.max(3, Math.round(num(p.radial_segments, 12))), p.closed ?? c.closedPath)
    }
  }
  return null
}
// 表だけ描けば足りない形(面・開いた形)は、裏も描く
const OPEN_GEO = new Set(['plane', 'ring', 'shards', 'lathe', 'tube'])

// ---- マテリアル -----------------------------------------------------------
// エンジンのテクスチャ(sRGB の値・乗算済み)をそのまま貼れるよう、色の読み方を差し替える。複製ごとのフェード(aFade)もここで足す
function patchMaterial(mat, opt) {
  const u = (mat.userData.u = { uMapTf: { value: new THREE.Vector4(1, 1, 0, 0) }, uMapWrap: { value: 0 } })
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uMapTf = u.uMapTf; sh.uniforms.uMapWrap = u.uMapWrap
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uMapTf;\nuniform float uMapWrap;${opt.fade ? '\nvarying float vFade;' : ''}`)
      .replace('#include <map_fragment>', /* glsl */ `#ifdef USE_MAP
  vec2 mUv = vMapUv * uMapTf.xy + uMapTf.zw;
  vec4 sampledDiffuseColor = uMapWrap > 0.5 ? textureGrad( map, fract( mUv ), dFdx( mUv ), dFdy( mUv ) ) : texture2D( map, mUv );
  sampledDiffuseColor.rgb = sampledDiffuseColor.a > 0.0 ? sampledDiffuseColor.rgb / sampledDiffuseColor.a : vec3( 0.0 );
  sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
  diffuseColor *= sampledDiffuseColor;
#endif`)
    if (opt.fade) {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;')
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vFade;')
    }
    if (opt.glass) {
      // ガラス: 本体は透ける色、映り込みとハイライトは透けずに乗る
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', /* glsl */ `{
  float gSpec = clamp( max( totalSpecular.r, max( totalSpecular.g, totalSpecular.b ) ), 0.0, 1.0 );
  float gA = diffuseColor.a + gSpec * ( 1.0 - diffuseColor.a );
  gl_FragColor = vec4( ( ( totalDiffuse + totalEmissiveRadiance ) * diffuseColor.a + totalSpecular ) / max( gA, 1e-4 ), gA );
}`)
    }
  }
  mat.customProgramCacheKey = () => `mesh3d|${opt.fade ? 'f' : ''}${opt.glass ? 'g' : ''}`
}
const toonMaps = new Map()
function toonMap(steps) {
  steps = clamp(Math.round(steps), 2, 16)
  let t = toonMaps.get(steps)
  if (!t) {
    const d = new Uint8Array(steps * 4)
    for (let i = 0; i < steps; i++) { const v = Math.round(255 * (0.3 + 0.7 * (i / (steps - 1)))); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255 }
    t = new THREE.DataTexture(d, steps, 1, THREE.RGBAFormat)
    t.minFilter = t.magFilter = THREE.NearestFilter
    t.needsUpdate = true
    toonMaps.set(steps, t)
  }
  return t
}
const sideOf = (m, open) => (m.side === 'double' ? THREE.DoubleSide : m.side === 'back' ? THREE.BackSide : m.side === 'front' ? THREE.FrontSide : open ? THREE.DoubleSide : THREE.FrontSide)
// 作り直しが要る違い(種類・フラグ)だけを並べた署名
function matSig(m, unlit, fade, vcol) {
  let type = m.type || 'standard'
  if (unlit && type !== 'shadow') type = type === 'emissive' ? 'emissive' : 'basic'
  if (type === 'standard' && num(m.clearcoat, 0) > 0) type = 'physical'
  const tr = m.transparent ?? (type === 'glass' || type === 'shadow' || num(m.opacity, 1) < 1 || toColor(m.color)[3] < 1 || fade || vcol)
  return `${type}|${m.side || ''}|${m.wireframe ? 'w' : ''}${m.flat ? 'f' : ''}${tr ? 't' : ''}${fade ? 'F' : ''}${vcol ? 'V' : ''}${m.depth_write === false ? 'd' : ''}|${type === 'toon' ? num(m.toon_steps, 3) : ''}`
}
function makeMaterial(sig, m, open) {
  const [type] = sig.split('|'), flags = sig.split('|')[2]
  const fade = flags.includes('F'), tr = flags.includes('t')
  let mat
  if (type === 'basic' || type === 'emissive') mat = new THREE.MeshBasicMaterial()
  else if (type === 'toon') mat = new THREE.MeshToonMaterial({ gradientMap: toonMap(num(m.toon_steps, 3)) })
  else if (type === 'shadow') mat = new THREE.ShadowMaterial()
  else if (type === 'glass' || type === 'physical') mat = new THREE.MeshPhysicalMaterial()
  else mat = new THREE.MeshStandardMaterial()
  mat.side = sideOf(m, open || type === 'glass')
  mat.wireframe = !!m.wireframe
  if ('flatShading' in mat) mat.flatShading = !!m.flat
  mat.transparent = tr
  mat.depthWrite = m.depth_write ?? !(type === 'glass' || type === 'shadow')
  mat.vertexColors = flags.includes('V')
  mat.userData.type = type
  if (type !== 'shadow') patchMaterial(mat, { fade, glass: type === 'glass' })
  return mat
}
// コマごとの値(色・質感・テクスチャ)を入れる
function updateMaterial(mat, m, tex) {
  const type = mat.userData.type
  const c = toColor(m.color, type === 'shadow' ? [0, 0, 0, 1] : [1, 1, 1, 1])
  const ei = num(m.emissive_intensity, 1)
  const k = type === 'emissive' ? ei : 1
  mat.color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace)
  if (k !== 1) mat.color.multiplyScalar(k)
  mat.opacity = clamp(num(m.opacity, type === 'glass' ? 0.25 : type === 'shadow' ? 0.4 : 1), 0, 1) * c[3]
  mat.alphaTest = clamp(num(m.alpha_test, 0), 0, 1)
  if (mat.isMeshStandardMaterial) {
    mat.metalness = clamp(num(m.metalness, 0), 0, 1)
    mat.roughness = clamp(num(m.roughness, type === 'glass' ? 0.05 : 0.5), 0, 1)
    mat.userData.envK = num(m.env_intensity, 1)
    if (mat.isMeshPhysicalMaterial) { mat.clearcoat = clamp(num(m.clearcoat, 0), 0, 1); mat.clearcoatRoughness = clamp(num(m.clearcoat_roughness, 0.1), 0, 1); if (type === 'glass') mat.ior = clamp(num(m.ior, 1.5), 1, 2.333) }
  }
  if (mat.emissive) {
    const e = toColor(m.emissive, [0, 0, 0, 1])
    mat.emissive.setRGB(e[0], e[1], e[2], THREE.SRGBColorSpace)
    mat.emissiveIntensity = ei
  }
  if (type !== 'shadow') {
    const map = tex ? tex.tex : null
    if ((mat.map || null) !== map) { if (!mat.map !== !map) mat.needsUpdate = true; mat.map = map }
    const u = mat.userData.u
    const rp = pair(m.texture_repeat, 1, 1), of = pair(m.texture_offset, 0, 0)
    // 画像は上が v = 0、入れ子の絵(RT)は上が v = 1。形の uv は上が v = 1
    if (tex && tex.flipV) u.uMapTf.value.set(rp[0], -rp[1], of[0], 1 + of[1])
    else u.uMapTf.value.set(rp[0], rp[1], of[0], -of[1])
    u.uMapWrap.value = rp[0] !== 1 || rp[1] !== 1 || of[0] !== 0 || of[1] !== 0 ? 1 : 0
  }
}

// ---- 環境(映り込み)------------------------------------------------------
const ENV_PRESETS = {
  studio: { top: '#b4bccc', bottom: '#4a4c54', horizon: '#8c92a0', panels: true },
  soft: { top: '#ffffff', bottom: '#8a8a90', horizon: '#d8d8dc', panels: false },
  sunset: { top: '#31406e', bottom: '#3a2830', horizon: '#ffb070', panels: true, panel_color: '#ffd8a8' },
  night: { top: '#0a1024', bottom: '#08080c', horizon: '#243060', panels: true, panel_color: '#a8c8ff' },
}
function envDef(v) {
  if (v === 'none' || v === false) return null
  if (isObj(v)) return { top: v.top ?? '#ffffff', bottom: v.bottom ?? '#888888', horizon: v.horizon ?? null, panels: v.panels ?? false, panel_color: v.panel_color ?? '#ffffff' }
  return ENV_PRESETS[v] || ENV_PRESETS.studio
}
function buildEnv(renderer, d) {
  const sc = new THREE.Scene()
  const lin = (c, k = 1) => { const x = toColor(c); return new THREE.Color().setRGB(x[0], x[1], x[2], THREE.SRGBColorSpace).multiplyScalar(k) }
  const top = lin(d.top), bot = lin(d.bottom), hor = d.horizon ? lin(d.horizon) : top.clone().lerp(bot, 0.5)
  const sg = new THREE.SphereGeometry(50, 32, 24)
  const pos = sg.attributes.position, colors = new Float32Array(pos.count * 3), c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 50
    if (y >= 0) c.copy(hor).lerp(top, Math.pow(y, 0.6)); else c.copy(hor).lerp(bot, Math.pow(-y, 0.45))
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
  }
  sg.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const disposables = [sg]
  const sm = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: false })
  disposables.push(sm)
  sc.add(new THREE.Mesh(sg, sm))
  if (d.panels) {
    // 明るい板(スタジオの照明)。金属・ガラスにはっきりしたハイライトが映る
    const pg = new THREE.PlaneGeometry(1, 1)
    disposables.push(pg)
    const panel = (x, y, z, w, h, k) => {
      const m = new THREE.MeshBasicMaterial({ color: lin(d.panel_color ?? '#ffffff', k), side: THREE.DoubleSide, toneMapped: false })
      disposables.push(m)
      const q = new THREE.Mesh(pg, m)
      q.position.set(x, y, z); q.scale.set(w, h, 1); q.lookAt(0, 0, 0)
      sc.add(q)
    }
    panel(-22, 26, 24, 16, 12, 8)    // 左上手前の面(主役のハイライト)
    panel(30, 6, 14, 5, 24, 5)       // 右の縦長
    panel(0, 4, 45, 44, 26, 1.1)     // カメラの後ろの大きな面(正面を向いた金属が暗くならないように)
    panel(0, 34, -18, 24, 8, 3)      // 奥の上
    panel(-28, -6, -22, 6, 20, 2.5)  // 左奥の縁
  }
  const pm = new THREE.PMREMGenerator(renderer)
  const rt = pm.fromScene(sc, 0.03, 0.1, 200)
  pm.dispose()
  for (const x of disposables) x.dispose()
  return rt
}

// ---- 本体 -----------------------------------------------------------------
export class MeshStore {
  constructor(env) {
    this.env = env
    this.geos = new Map()   // 形の署名 → {geo | base, used}
    this.envs = new Map()   // 環境の署名 → PMREM の RT
    this.tick = 0
    this.camera = new THREE.PerspectiveCamera()
    this.camera.matrixAutoUpdate = false
    this.ortho = new THREE.OrthographicCamera()
    this.ortho.matrixAutoUpdate = false
    this.states = new Set()
  }
  geometry(e) {
    const key = geoKey(e, this.env.fontEpoch)
    let c = this.geos.get(key)
    if (!c) {
      let geo = null, base = null
      try {
        if (e.geometry === 'shards') base = shardBase(e)
        else { geo = buildGeometry(e); if (geo) { geo.computeBoundingSphere(); geo.computeBoundingBox() } }
      } catch (err) { console.warn('[comp-engine] mesh: 形を作れない:', e.geometry, err); this.env.report?.('error', `mesh: 形を作れない(${e.geometry}): ${err && err.message || err}`) }
      if (!geo && !base && e.geometry !== 'group') this.warnOnce('geo' + e.geometry, `mesh: 知らない形: ${e.geometry}`)
      c = { key, geo, base, used: 0 }
      this.geos.set(key, c)
      if (this.geos.size > MAX_GEO) {
        for (const [k, x] of this.geos) { if (x.used < this.tick - 30) { x.geo?.dispose(); this.geos.delete(k) } }
      }
    }
    c.used = this.tick
    return c
  }
  warnOnce(key, msg) {
    this.warned ??= new Set()
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn('[comp-engine]', msg)
    this.env.report?.('warn', msg)
  }
  envMap(v) {
    const d = envDef(v)
    if (!d) return null
    const key = JSON.stringify(d)
    let rt = this.envs.get(key)
    if (!rt) {
      if (this.envs.size >= 6) { const [k0, r0] = this.envs.entries().next().value; r0.dispose(); this.envs.delete(k0) }
      rt = buildEnv(this.env.renderer, d)
      this.envs.set(key, rt)
    }
    return rt.texture
  }

  // テクスチャの指定を全部たどる
  eachTexture(objs, fn, depth = 0) {
    if (!Array.isArray(objs) || depth > 8) return
    for (const o of objs) {
      if (!isObj(o)) continue
      if (isObj(o.material) && isObj(o.material.texture)) fn(o.material.texture, o)
      if (Array.isArray(o.faces)) for (const m of o.faces) if (isObj(m) && isObj(m.texture)) fn(m.texture, o)
      if (Array.isArray(o.children)) this.eachTexture(o.children, fn, depth + 1)
    }
  }
  eachObject(objs, fn, depth = 0) {
    if (!Array.isArray(objs) || depth > 8) return
    for (const o of objs) { if (!isObj(o)) continue; fn(o); if (Array.isArray(o.children)) this.eachObject(o.children, fn, depth + 1) }
  }
  // 入れ子をテクスチャにするときの、子のコマ
  childFrame(scene, L, t, f, child) {
    const fr = evalProp(t.frame, f, scene.fps)
    let cf = typeof fr === 'number' ? fr : (((f - (L.def.in ?? 0)) * num(evalProp(t.speed, f, scene.fps), 1) + num(evalProp(t.start, f, scene.fps), 0)) / scene.fps) * child.fps
    const d = child.duration
    if (t.loop && d > 0) cf = ((cf % d) + d) % d
    return clamp(cf, 0, Math.max(0, d - 1))
  }
  // 素材を読み始める(capture ではここで積まれた Promise を待つ)
  prepare(scene, L, f, stack) {
    const s = L.def.source || {}, env = this.env
    this.eachTexture(s.objects, (t) => {
      if (t.comp_id != null) {
        const e = env.comps.get(t.comp_id)
        if (e.scene && !stack.includes(e.id) && stack.length < 8) e.scene.prepare(this.childFrame(scene, L, t, f, e.scene), [...stack, e.id])
      } else if (t.url || t.asset_id != null) env.assets.image(t.url ? scene.srcUrl(t.url) : scene.assetUrl(t.asset_id, 'image'))
    })
    this.eachObject(s.objects, (o) => { if (o.geometry === 'text') env.font(meshFont(o, 32), String(evalProp(o.text, f, scene.fps) ?? '')) })
  }
  // → {tex, flipV} / null(まだ読めていない)
  texture(scene, L, t, f, stack, temps) {
    const env = this.env
    if (t.comp_id != null) {
      const e = env.comps.get(t.comp_id)
      if (!e || !e.scene) return null
      if (stack.includes(e.id) || stack.length >= 8) { scene.warn('cycle' + L.id, `入れ子が循環している: comp ${e.id}`); return null }
      const rt = e.scene.renderCached(this.childFrame(scene, L, t, f, e.scene), [...stack, e.id], !!t.transparent)
      temps.push(rt)
      return { tex: rt.texture, flipV: false }
    }
    if (t.url || t.asset_id != null) {
      const e = env.assets.image(t.url ? scene.srcUrl(t.url) : scene.assetUrl(t.asset_id, 'image'))
      return e.state === 'ready' ? { tex: e.tex, flipV: true } : null
    }
    return null
  }

  state(L) {
    let st = L.cache.mesh
    if (!st) {
      const root = new THREE.Scene(), holder = new THREE.Group()
      holder.matrixAutoUpdate = false
      const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1), dir = new THREE.DirectionalLight(0xffffff, 1)
      root.add(holder, hemi, dir, dir.target)
      st = L.cache.mesh = { root, holder, hemi, dir, points: [], nodes: [], tex: null }
      // レイヤーを捨てるとき(scene.disposeLayer が cache[k].tex.dispose() を呼ぶ)
      st.tex = { dispose: () => { this.disposeNodes(st.nodes); st.nodes = []; dir.shadow?.map?.dispose(); this.states.delete(st) } }
      this.states.add(st)
    }
    return st
  }
  disposeNode(n) {
    if (!n) return
    if (n.children) this.disposeNodes(n.children)
    n.obj?.removeFromParent()
    for (const m of n.mats || []) m.dispose()
    n.ownGeo?.dispose()
    if (n.obj?.isInstancedMesh) n.obj.dispose()
  }
  disposeNodes(list) { for (const n of list) this.disposeNode(n) }

  // objects の並びを three.js のオブジェクトにそろえる(同じ署名なら使い回す)
  sync(ctx, defs, nodes, parent, depth = 0) {
    defs = Array.isArray(defs) && depth <= 8 ? defs : []
    for (let i = 0; i < defs.length; i++) {
      const o = defs[i]
      let n = nodes[i]
      if (!isObj(o)) { this.disposeNode(n); nodes[i] = null; continue }
      const e = evalTree(o, ctx.f, ctx.fps)
      e.geometry ??= Array.isArray(e.children) ? 'group' : 'box'
      const isGroup = e.geometry === 'group'
      const inst = !isGroup && isObj(e.instances) && e.geometry !== 'shards' ? e.instances : null
      const cap = inst ? clamp(Math.round(num(inst.count, 100)), 1, MAX_INST) : 0
      const fade = !!inst && (num(inst.fade_in, 0) > 0 || num(inst.fade_out, 0) > 0) && inst.fade_mode !== 'scale'
      const vcol = e.geometry === 'shards' && num(e.fade, 0) > 0
      const gc = isGroup ? null : this.geometry(e)
      const open = OPEN_GEO.has(e.geometry) || (e.geometry === 'extrude' && !(num(e.depth, 40) > 0) && !e.bevel) || !!e.open_ended
      const mdefs = isGroup ? [] : [isObj(e.material) ? e.material : {}, ...(Array.isArray(e.faces) ? e.faces.map((m) => (isObj(m) ? evalTree(m, ctx.f, ctx.fps) : null)) : [])]
      const sigs = mdefs.map((m) => (m ? matSig(m, ctx.unlit, fade, vcol) : ''))
      const sig = `${gc ? gc.key : 'group'}#${cap}#${sigs.join(';')}#${open ? 1 : 0}`
      if (!n || n.sig !== sig) {
        this.disposeNode(n)
        n = nodes[i] = { sig, obj: null, mats: [], matOf: [], ownGeo: null, children: null, gc, base: null }
        if (isGroup) n.obj = new THREE.Group()
        else if (gc && (gc.geo || gc.base)) {
          n.matOf = mdefs.map((m, j) => (m ? makeMaterial(sigs[j], m, open) : null))
          n.mats = n.matOf.filter(Boolean)
          let geo = gc.geo
          if (gc.base) {
            // 破片: 位置をコマごとに書き直すので、自分用の形を持つ
            const b = gc.base
            geo = n.ownGeo = new THREE.BufferGeometry()
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3).setUsage(THREE.DynamicDrawUsage))
            geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.nor), 3).setUsage(THREE.DynamicDrawUsage))
            geo.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2))
            if (vcol) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((b.pos.length / 3) * 4).fill(1), 4).setUsage(THREE.DynamicDrawUsage))
            n.base = b; n.dirty = false
          } else if (fade) {
            // 複製ごとの aFade を足すので、自分用の写しを持つ(使い回しの形に属性を足さない)
            const g2 = n.ownGeo = geo.clone()
            g2.setAttribute('aFade', new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1).setUsage(THREE.DynamicDrawUsage))
            geo = g2
          }
          // faces: 形の面の組(group)の順に当てる。無い面は material
          const ng = geo.groups.length
          const material = ng > 1 && n.matOf.length > 1 ? Array.from({ length: Math.max(...geo.groups.map((g) => g.materialIndex)) + 1 }, (_, j) => n.matOf[j + 1] || n.matOf[0]) : n.matOf[0]
          n.obj = inst ? new THREE.InstancedMesh(geo, material, cap) : new THREE.Mesh(geo, material)
          if (inst) { n.obj.instanceMatrix.setUsage(THREE.DynamicDrawUsage); n.cap = cap }
          n.obj.frustumCulled = false
        } else n.obj = new THREE.Group()
      }
      if (n.obj.parent !== parent) parent.add(n.obj)
      // 変形
      const pos = v3(e.position), sc = e.scale === undefined ? [1, 1, 1] : v3(e.scale, 1)
      n.obj.position.set(pos[0], -pos[1], -pos[2])
      setEuler(n.obj.rotation, rot3(e.rotation))
      n.obj.scale.set(sc[0], sc[1], sc[2])
      n.obj.visible = e.visible !== false && e.visible !== 0
      n.obj.renderOrder = num(e.render_order, 0)
      n.e = e
      if (n.obj.isMesh) {
        n.obj.castShadow = e.cast_shadow ?? true
        n.obj.receiveShadow = e.receive_shadow ?? true
        for (let j = 0; j < mdefs.length; j++) {
          const mat = n.matOf[j], m = mdefs[j]
          if (!mat || !m) continue
          updateMaterial(mat, m, isObj(m.texture) ? this.texture(ctx.scene, ctx.L, m.texture, ctx.f, ctx.stack, ctx.temps) : null)
          if (mat.isMeshStandardMaterial || mat.isMeshToonMaterial || mat.isShadowMaterial) ctx.lit = true
          if (mat.isMeshStandardMaterial) ctx.envMats.push(mat)
        }
        if (n.base) this.updateShards(n, e)
        else if (inst) ctx.instanced.push(n)
      }
      if (isGroup) this.sync(ctx, e.children, (n.children ??= []), n.obj, depth + 1)
    }
    for (let i = defs.length; i < nodes.length; i++) this.disposeNode(nodes[i])
    nodes.length = defs.length
  }

  // 破片: progress(0〜1)から、1 枚ずつの位置・回転を式で決めて頂点を書き直す
  updateShards(n, e) {
    const b = n.base, geo = n.ownGeo
    const P = clamp(num(e.progress, 0), 0, 1)
    const pos = geo.attributes.position, nor = geo.attributes.normal, col = geo.attributes.color
    if (P <= 0) {
      // 割れる前: 元の板そのもの(頂点を 1 ビットも動かさない = 継ぎ目が出ない)
      if (n.dirty !== false) { pos.array.set(b.pos); nor.array.set(b.nor); pos.needsUpdate = nor.needsUpdate = true; if (col) { col.array.fill(1); col.needsUpdate = true } n.dirty = false }
      return
    }
    n.dirty = true
    const seed = num(e.seed, 1) | 0
    const dir = v3(e.direction), spread = num(e.spread, 600), sz = num(e.spread_z, spread * 0.5)
    const spin = num(e.spin, 240), gr = Array.isArray(e.gravity) ? v3(e.gravity) : [0, num(e.gravity, 0), 0]
    const org = pair(e.origin, 0, 0), sEnd = num(e.scale_end, 1), fadeLen = clamp(num(e.fade, 0), 0, 1)
    const stag = clamp(num(e.stagger_amount, 0.5), 0, 0.95), mode = e.stagger || 'none'
    const hw = b.w / 2 || 1, hh = b.h / 2 || 1, diag = Math.hypot(hw, hh) || 1
    const pa = pos.array, na = nor.array, bp = b.pos, bn = b.nor
    for (let i = 0; i < b.n; i++) {
      const cx = b.cents[i * 2], cy = b.cents[i * 2 + 1]
      // 文書の座標(y 下)での中心からの向き
      const ox = cx - org[0], oy = -cy - org[1]
      let s = 0
      switch (mode) {
        case 'left_to_right': s = (cx + hw) / (2 * hw); break
        case 'right_to_left': s = 1 - (cx + hw) / (2 * hw); break
        case 'top_to_bottom': s = 1 - (cy + hh) / (2 * hh); break
        case 'bottom_to_top': s = (cy + hh) / (2 * hh); break
        case 'center_out': s = Math.hypot(ox, oy) / diag; break
        case 'edges_in': s = 1 - Math.hypot(ox, oy) / diag; break
        case 'random': s = rand01(seed, i, 11); break
      }
      s = clamp(s, 0, 1)
      if (mode !== 'none' && mode !== 'random') s = clamp(s * 0.85 + rand01(seed, i, 12) * 0.15, 0, 1)
      const q = mode === 'none' ? P : clamp((P - s * stag) / (1 - stag), 0, 1)
      const v0 = b.ranges[i * 2], v1 = b.ranges[i * 2 + 1]
      if (q <= 0) {
        for (let k = v0 * 3; k < v1 * 3; k++) { pa[k] = bp[k]; na[k] = bn[k] }
        if (col) for (let k = v0; k < v1; k++) col.array[k * 4 + 3] = 1
        continue
      }
      const ol = Math.hypot(ox, oy)
      const ra = rand01(seed, i, 13) * Math.PI * 2
      const rx = ol > 1e-3 ? ox / ol : Math.cos(ra), ry = ol > 1e-3 ? oy / ol : Math.sin(ra)
      const k1 = 0.5 + rand01(seed, i, 14)
      // 文書の座標でのずれ → three.js の座標へ(y・z を反転)
      const dx = dir[0] * q + rx * spread * k1 * q + gr[0] * q * q
      const dy = dir[1] * q + ry * spread * k1 * q + gr[1] * q * q
      const dz = dir[2] * q + (rand01(seed, i, 15) * 2 - 1) * sz * q + gr[2] * q * q
      _u.set(rand01(seed, i, 16) * 2 - 1, rand01(seed, i, 17) * 2 - 1, rand01(seed, i, 18) * 2 - 1)
      if (_u.lengthSq() < 1e-4) _u.set(1, 0, 0)
      _q.setFromAxisAngle(_u.normalize(), spin * D2R * q * (0.4 + 1.2 * rand01(seed, i, 19)) * (rand01(seed, i, 20) < 0.5 ? -1 : 1))
      const sc = 1 + (sEnd - 1) * q
      _m.compose(_p.set(cx + dx, cy - dy, -dz), _q, _s.set(sc, sc, sc)).multiply(_m2.makeTranslation(-cx, -cy, 0))
      const el = _m.elements
      for (let k = v0; k < v1; k++) {
        const x = bp[k * 3], y = bp[k * 3 + 1], z = bp[k * 3 + 2]
        pa[k * 3] = el[0] * x + el[4] * y + el[8] * z + el[12]
        pa[k * 3 + 1] = el[1] * x + el[5] * y + el[9] * z + el[13]
        pa[k * 3 + 2] = el[2] * x + el[6] * y + el[10] * z + el[14]
        const nx = bn[k * 3], ny = bn[k * 3 + 1], nz = bn[k * 3 + 2]
        na[k * 3] = (el[0] * nx + el[4] * ny + el[8] * nz) / sc
        na[k * 3 + 1] = (el[1] * nx + el[5] * ny + el[9] * nz) / sc
        na[k * 3 + 2] = (el[2] * nx + el[6] * ny + el[10] * nz) / sc
      }
      if (col) { const a = fadeLen > 0 ? clamp((1 - q) / fadeLen, 0, 1) : 1; for (let k = v0; k < v1; k++) col.array[k * 4 + 3] = a }
    }
    pos.needsUpdate = nor.needsUpdate = true
    if (col) col.needsUpdate = true
  }

  // 複製: i 番目の位置・回転・大きさ・色を (種, i, 時刻) の式で決める
  updateInstances(n, ctx) {
    const e = n.e, I = e.instances, mesh = n.obj, cap = n.cap
    const seed = num(I.seed, 1) | 0
    const t = (ctx.f - (ctx.L.def.in ?? 0)) / ctx.fps + num(I.time_offset, 0)
    const layout = I.layout || 'box'
    const area = v3(I.area ?? 600, 600)
    const life = num(I.lifetime, 0), loop = !!I.loop && life > 0
    const emit = Math.max(0, num(I.emit_duration, loop ? life : 0)), prewarm = I.prewarm !== false
    const lifeRand = clamp(num(I.lifetime_random, 0), 0, 0.95)
    const vel = v3(I.velocity), velR = v3(I.velocity_random), grav = v3(I.gravity), radial = pair(I.radial, 0, 0), drag = Math.max(0, num(I.drag, 0))
    const rot0 = rot3(I.rotation ?? 0), rotR = v3(I.rotation_random), spin = v3(I.spin), spinR = v3(I.spin_random)
    const scl = pair(I.scale, 1, 1)
    const sway = isObj(I.sway) ? I.sway : null, swAmp = sway ? v3(typeof sway.amp === 'number' ? [sway.amp, 0, 0] : sway.amp) : null, swFreq = sway ? num(sway.freq, 0.5) : 0
    const fin = Math.max(0, num(I.fade_in, 0)), fout = Math.max(0, num(I.fade_out, 0)), fmode = I.fade_mode || 'opacity'
    const colors = Array.isArray(I.colors) && I.colors.length ? I.colors.map((c) => { const x = toColor(c); return new THREE.Color().setRGB(x[0], x[1], x[2], THREE.SRGBColorSpace) }) : null
    const fadeAttr = mesh.geometry.attributes.aFade || null
    const align = I.align !== false
    const grid = Array.isArray(I.grid) ? I.grid.map((x) => Math.max(1, Math.round(+x || 1))) : null
    const gn = grid ? [grid[0] || 1, grid[1] || 1, grid[2] || 1] : (() => { const k = Math.max(1, Math.ceil(Math.cbrt(cap))); return [k, k, k] })()
    const spacing = v3(I.spacing ?? 100, 100)
    const R = num(I.radius, 300), axis = I.axis === 'x' || I.axis === 'z' ? I.axis : 'y'
    const a0 = num(I.start, 0) * D2R, arc = clamp(num(I.arc, 360), -360, 360) * D2R, fullArc = Math.abs(arc) >= Math.PI * 2 - 1e-6
    let curve = null
    if (layout === 'along') {
      const pd = isObj(I.path) ? I.path : isObj(e.path) ? e.path : {}
      const ck = JSON.stringify(pd)
      if (n.curveKey !== ck) { n.curve = makeCurve(pd); n.curveKey = ck }
      curve = n.curve
    }
    const off = num(I.offset, 0)
    const total = layout === 'grid' ? Math.min(cap, gn[0] * gn[1] * gn[2]) : cap
    const arr = mesh.instanceMatrix.array
    let out = 0
    const depthSort = fadeAttr ? (n.order ??= []) : null
    if (depthSort) depthSort.length = 0
    const tmp = (n.tmp ??= { m: new Float32Array(cap * 16), c: new Float32Array(cap * 3), f: new Float32Array(cap), z: new Float32Array(cap) })
    // 並べ替えのための奥行き: カメラから見た z
    let mv = null
    if (depthSort) { mesh.updateWorldMatrix(true, false); mv = _m2.multiplyMatrices(ctx.camera.matrixWorldInverse, mesh.matrixWorld).elements }
    for (let i = 0; i < total; i++) {
      // 生まれる時刻と、いまの年齢
      let age = t - rand01(seed, i, 1) * emit, cyc = 0
      let lf = life > 0 ? life * (1 - lifeRand * rand01(seed, i, 2)) : 0
      if (life > 0) {
        if (loop) {
          if (age < 0 && !prewarm) continue
          cyc = Math.floor(age / life); age -= cyc * life
          if (age > lf) continue
        } else if (age < 0 || age > lf) continue
      } else if (age < 0) continue
      const k0 = (cyc * 40) | 0
      const r = (k) => rand01(seed, i, k + k0)
      // 最初の位置(three.js の座標)
      let px = 0, py = 0, pz = 0
      _q2.identity()
      if (layout === 'box') { px = (r(3) - 0.5) * area[0]; py = (r(4) - 0.5) * area[1]; pz = (r(5) - 0.5) * area[2] }
      else if (layout === 'sphere') {
        const z = r(3) * 2 - 1, ph = r(4) * Math.PI * 2, rr = R * (I.surface ? 1 : Math.cbrt(r(5))), sq = Math.sqrt(1 - z * z)
        px = Math.cos(ph) * sq * rr; py = Math.sin(ph) * sq * rr; pz = z * rr
      } else if (layout === 'grid') {
        const ix = i % gn[0], iy = Math.floor(i / gn[0]) % gn[1], iz = Math.floor(i / (gn[0] * gn[1]))
        px = (ix - (gn[0] - 1) / 2) * spacing[0]; py = -(iy - (gn[1] - 1) / 2) * spacing[1]; pz = -(iz - (gn[2] - 1) / 2) * spacing[2]
      } else if (layout === 'ring') {
        const a = a0 + arc * (fullArc ? i / total : total > 1 ? i / (total - 1) : 0) + off * Math.PI * 2
        const s = Math.sin(a) * R, c = Math.cos(a) * R
        if (axis === 'y') { px = s; pz = c; if (align) _q2.setFromEuler(_e.set(0, a, 0)) }
        else if (axis === 'z') { px = s; py = c; if (align) _q2.setFromEuler(_e.set(0, 0, -a)) }
        else { py = c; pz = s; if (align) _q2.setFromEuler(_e.set(a, 0, 0)) }
      } else if (layout === 'along' && curve) {
        let u = (curve.closedPath ? i / total : total > 1 ? i / (total - 1) : 0) + off // 1 個だけなら道の始点(offset で進める)
        u = curve.closedPath ? ((u % 1) + 1) % 1 : u
        if (u < 0 || u > 1) continue
        curve.getPointAt(u, _p)
        px = _p.x; py = _p.y; pz = _p.z
        if (align) {
          // 道の向き = x、上 = y(道に直交するように直す)
          curve.getTangentAt(u, _t)
          _u.set(0, 1, 0).addScaledVector(_t, -_t.y)
          if (_u.lengthSq() < 1e-6) _u.set(0, 0, 1).addScaledVector(_t, -_t.z)
          _u.normalize()
          _b.crossVectors(_t, _u)
          _q2.setFromRotationMatrix(_m.makeBasis(_t, _u, _b))
        }
      }
      // 動き(文書の座標の速さ → three.js の座標)
      let vx = vel[0] + (r(6) * 2 - 1) * velR[0], vy = -(vel[1] + (r(7) * 2 - 1) * velR[1]), vz = -(vel[2] + (r(8) * 2 - 1) * velR[2])
      if (radial[0] || radial[1]) {
        let dx = px, dy = py, dz = pz, dl = Math.hypot(dx, dy, dz)
        if (dl < 1e-3) { const z = r(9) * 2 - 1, ph = r(10) * Math.PI * 2, sq = Math.sqrt(1 - z * z); dx = Math.cos(ph) * sq; dy = Math.sin(ph) * sq; dz = z; dl = 1 }
        const sp = radial[0] + (radial[1] - radial[0]) * r(11)
        vx += (dx / dl) * sp; vy += (dy / dl) * sp; vz += (dz / dl) * sp
      }
      const gx = grav[0], gy = -grav[1], gz = -grav[2]
      if (drag > 0) {
        const ex = 1 - Math.exp(-drag * age), k1 = ex / drag, k2 = (age - k1) / drag
        px += vx * k1 + gx * k2; py += vy * k1 + gy * k2; pz += vz * k1 + gz * k2
      } else {
        const h2 = 0.5 * age * age
        px += vx * age + gx * h2; py += vy * age + gy * h2; pz += vz * age + gz * h2
      }
      if (sway) {
        const ph = r(12), w = Math.PI * 2
        px += swAmp[0] * Math.sin(w * (swFreq * age + ph)); py -= swAmp[1] * Math.sin(w * (swFreq * age + ph + 0.37)); pz -= swAmp[2] * Math.sin(w * (swFreq * age + ph + 0.71))
      }
      // 回転(度)
      const rx = rot0[0] + (r(13) * 2 - 1) * rotR[0] + (spin[0] + (r(16) * 2 - 1) * spinR[0]) * age
      const ry = rot0[1] + (r(14) * 2 - 1) * rotR[1] + (spin[1] + (r(17) * 2 - 1) * spinR[1]) * age
      const rz = rot0[2] + (r(15) * 2 - 1) * rotR[2] + (spin[2] + (r(18) * 2 - 1) * spinR[2]) * age
      _q.setFromEuler(_e.set(-rx * D2R, ry * D2R, -rz * D2R, 'XYZ')).premultiply(_q2)
      // 大きさ・フェード
      let s = scl[0] + (scl[1] - scl[0]) * r(19), fa = 1
      if (fin > 0) fa *= clamp(age / fin, 0, 1)
      if (fout > 0 && lf > 0) fa *= clamp((lf - age) / fout, 0, 1)
      if (fa <= 0) continue
      if (fmode === 'scale' || fmode === 'both') s *= fa
      _m.compose(_p.set(px, py, pz), _q, _s.set(s, s, s))
      tmp.m.set(_m.elements, out * 16)
      if (colors) { const c = colors[Math.min(colors.length - 1, Math.floor(r(20) * colors.length))]; tmp.c[out * 3] = c.r; tmp.c[out * 3 + 1] = c.g; tmp.c[out * 3 + 2] = c.b }
      tmp.f[out] = fmode === 'scale' ? 1 : fa
      if (depthSort) { tmp.z[out] = mv[2] * px + mv[6] * py + mv[10] * pz + mv[14]; depthSort.push(out) }
      out++
    }
    if (colors && !mesh.instanceColor) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage)
    else if (!colors && mesh.instanceColor) mesh.instanceColor.array.fill(1)
    if (depthSort) {
      // 半透明の重なりが正しくなるよう、奥から順に並べる(同じ奥行きは番号順 = 決定論)
      depthSort.sort((a, b) => tmp.z[a] - tmp.z[b] || a - b)
      for (let j = 0; j < out; j++) {
        const s0 = depthSort[j]
        for (let k = 0; k < 16; k++) arr[j * 16 + k] = tmp.m[s0 * 16 + k]
        if (colors) { mesh.instanceColor.array[j * 3] = tmp.c[s0 * 3]; mesh.instanceColor.array[j * 3 + 1] = tmp.c[s0 * 3 + 1]; mesh.instanceColor.array[j * 3 + 2] = tmp.c[s0 * 3 + 2] }
        fadeAttr.array[j] = tmp.f[s0]
      }
      fadeAttr.needsUpdate = true
    } else {
      arr.set(tmp.m.subarray(0, out * 16))
      if (colors) mesh.instanceColor.array.set(tmp.c.subarray(0, out * 3))
    }
    mesh.count = out
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  // レイヤーの箱(選択枠用の目安)。形の外接球から(グループの中は、グループの変形を見ない)。まだ作っていなければ 200 px
  bounds(L) {
    const st = L.cache.mesh
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    const walk = (nodes) => {
      for (const n of nodes) {
        if (!n || !n.obj) continue
        if (n.children) walk(n.children)
        const e = n.e || {}, p = n.obj.position, s = Math.max(Math.abs(n.obj.scale.x), Math.abs(n.obj.scale.y), Math.abs(n.obj.scale.z))
        let r = n.base ? Math.hypot(n.base.w, n.base.h) / 2 : n.gc?.geo?.boundingSphere?.radius
        if (!(r > 0) || e.visible === false || e.material?.type === 'shadow') continue // 影を受けるだけの床は、箱に数えない
        r *= s
        if (isObj(e.instances)) { const I = e.instances, a = v3(I.area ?? 600, 600); r += I.layout === 'ring' || I.layout === 'sphere' ? num(I.radius, 300) : I.layout === 'along' ? 400 : Math.max(a[0], a[1]) / 2 }
        x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r); y0 = Math.min(y0, -p.y - r); y1 = Math.max(y1, -p.y + r)
      }
    }
    if (st) walk(st.nodes)
    if (!(x1 > x0)) return { x: -100, y: -100, w: 200, h: 200 }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  // → リニア・乗算済みの RT(呼び出し側が release)
  render(scene, L, f, stack = []) {
    const env = this.env, g = env.gfx, s = L.def.source || {}
    const st = this.state(L)
    this.tick = env.drawTick || this.tick + 1
    const cam = scene.camFor(L, f)
    // カメラ(model.js と同じ。平行投影のカメラにも合わせる)
    let c
    const near = Math.max(1, cam.zoom * 0.01), far = cam.zoom * 100
    if (cam.ortho) {
      c = this.ortho
      c.left = -scene.W / 2; c.right = scene.W / 2; c.top = scene.H / 2; c.bottom = -scene.H / 2; c.near = near; c.far = far
    } else {
      c = this.camera
      c.fov = (2 * Math.atan(scene.H / 2 / cam.zoom) * 180) / Math.PI
      c.aspect = scene.W / scene.H; c.near = near; c.far = far
    }
    c.updateProjectionMatrix()
    c.matrix.copy(FLIP).multiply(cam.world).multiply(FLIP)
    c.matrixWorld.copy(c.matrix)
    c.matrixWorldInverse.copy(c.matrixWorld).invert()
    c.matrixWorldNeedsUpdate = false
    st.holder.matrix.copy(FLIP).multiply(scene.drawWorld(L, f)).multiply(FLIP)
    st.holder.matrixWorldNeedsUpdate = true
    st.root.updateMatrixWorld()
    const temps = []
    const ctx = { scene, L, f, fps: scene.fps, stack, temps, unlit: !!evalProp(s.unlit, f, scene.fps), lit: false, envMats: [], instanced: [], camera: c }
    let rt = null
    try {
      this.sync(ctx, s.objects, st.nodes, st.holder)
      st.root.updateMatrixWorld()
      for (const n of ctx.instanced) this.updateInstances(n, ctx)
      // 光: direction は文書の座標で「光の来る方向」(model と同じ)
      const li = isObj(s.light) ? evalTree(s.light, f, scene.fps) : {}
      const col = toColor(li.color ?? '#ffffff')
      st.dir.color.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace)
      st.dir.intensity = Math.max(0, num(li.intensity, 2))
      st.hemi.intensity = Math.max(0, num(li.ambient, 0.6))
      const d = v3(li.direction ?? [-0.5, -1, -1])
      _t.set(d[0], -d[1], -d[2])
      if (_t.lengthSq() < 1e-9) _t.set(0, 1, 1)
      _t.normalize()
      const shadows = !!li.shadows && !ctx.unlit
      // 影の範囲はレイヤーの原点のまわり
      _p.setFromMatrixPosition(st.holder.matrixWorld)
      const sa = Math.max(10, num(li.shadow_area, Math.max(scene.W, scene.H) * 1.2))
      st.dir.target.position.copy(shadows ? _p : _u.set(0, 0, 0))
      st.dir.position.copy(st.dir.target.position).addScaledVector(_t, shadows ? sa * 1.5 : cam.zoom * 4)
      st.dir.target.updateMatrixWorld(); st.dir.updateMatrixWorld()
      st.dir.castShadow = shadows
      if (shadows) {
        const sh = st.dir.shadow, sc = sh.camera
        sc.left = sc.bottom = -sa / 2; sc.right = sc.top = sa / 2; sc.near = 1; sc.far = sa * 3.2
        sc.updateProjectionMatrix()
        if (sh.mapSize.x !== 2048) { sh.mapSize.set(2048, 2048); sh.map?.dispose(); sh.map = null }
        sh.bias = -0.0004; sh.normalBias = sa / 700
        sh.intensity = clamp(num(li.shadow_opacity, 1), 0, 1)
      }
      const pts = Array.isArray(li.points) ? li.points.filter(isObj) : []
      while (st.points.length > pts.length) { const pl = st.points.pop(); pl.removeFromParent(); pl.dispose() }
      while (st.points.length < pts.length) { const pl = new THREE.PointLight(0xffffff, 1, 0, 0); st.holder.add(pl); st.points.push(pl) }
      pts.forEach((pd, i) => {
        const q = evalTree(pd, f, scene.fps), pl = st.points[i], pc = toColor(q.color ?? '#ffffff'), pp = v3(q.position)
        pl.color.setRGB(pc[0], pc[1], pc[2], THREE.SRGBColorSpace)
        pl.intensity = Math.max(0, num(q.intensity, 1)); pl.distance = Math.max(0, num(q.distance, 0)); pl.decay = 0
        pl.position.set(pp[0], -pp[1], -pp[2])
      })
      const lightsOn = ctx.lit && !ctx.unlit
      st.hemi.visible = st.dir.visible = lightsOn
      for (const pl of st.points) pl.visible = lightsOn
      // 環境(映り込み)。金属・ガラスなど、環境を見るマテリアルがあるときだけ作る
      // (scene.environment だとマテリアルごとの強さが効かないので、マテリアルの envMap に入れる)
      const envTex = ctx.envMats.length && !ctx.unlit ? this.envMap(evalProp(s.env, f, scene.fps) ?? 'studio') : null
      const envK = Math.max(0, num(evalProp(s.env_intensity, f, scene.fps), 1)), envRot = num(evalProp(s.env_rotation, f, scene.fps), 0) * D2R
      for (const mat of ctx.envMats) {
        if ((mat.envMap || null) !== envTex) { if (!mat.envMap !== !envTex) mat.needsUpdate = true; mat.envMap = envTex }
        mat.envMapIntensity = envK * mat.userData.envK
        mat.envMapRotation.set(0, envRot, 0)
      }
      st.root.updateMatrixWorld()
      const [bw, bh] = scene.bufSize()
      rt = g.acquire(bw, bh, { float: true, depth: true, samples: 4 })
      g.clear(rt)
      const r = env.renderer, sm0 = r.shadowMap.enabled
      r.shadowMap.enabled = shadows
      try { r.render(st.root, c) } finally { r.shadowMap.enabled = sm0 }
    } catch (err) {
      console.warn('[comp-engine] mesh', err)
      env.report?.('error', `mesh を描けない: ${err && err.message || err}`)
      if (rt) g.release(rt)
      rt = null
    }
    for (const t of temps) g.release(t)
    return rt
  }
  dispose() {
    for (const st of [...this.states]) st.tex.dispose()
    for (const c of this.geos.values()) c.geo?.dispose()
    this.geos.clear()
    for (const rt of this.envs.values()) rt.dispose()
    this.envs.clear()
  }
}
