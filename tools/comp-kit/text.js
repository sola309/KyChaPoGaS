// テキスト: Canvas2D で 1 文字ずつアトラスに描き、文字ごとの四角形として並べる。
// 文字ごとアニメ(per_char)は四角形の四隅を CPU で動かすだけなので、テクスチャは作り直さない。
import { makeCanvas, MAX_TEX } from './shape.js'
import { toCss, num, ease, vec, rand01, strHash, clamp } from './props.js'
import { THREE } from './gfx.js'

// 指定のフォント名 → この機械にある書体まで含めた CSS の並び
export function fontStack(name) {
  const n = String(name || 'Noto Sans JP')
  const serif = /serif|mincho|明朝/i.test(n) && !/sans/i.test(n)
  const mono = /mono/i.test(n)
  const tail = mono ? '"Noto Sans Mono","DejaVu Sans Mono",monospace'
    : serif ? '"Noto Serif CJK JP","Noto Serif JP","IPAMincho",serif'
      : '"Noto Sans CJK JP","Noto Sans JP","IPAGothic",sans-serif'
  return `"${n.replace(/"/g, '')}",${tail}`
}
export function fontSpec(s, size) {
  return `${s.italic ? 'italic ' : ''}${num(s.weight, 400)} ${size}px ${fontStack(s.font)}`
}

let segmenter
function graphemes(str) {
  try {
    segmenter ??= new Intl.Segmenter('ja', { granularity: 'grapheme' })
    return [...segmenter.segment(str)].map((x) => x.segment)
  } catch { return [...str] }
}

const measureCtx = () => (measureCtx.c ??= makeCanvas(4, 4)[1])

// s: 評価済みの source。rs: ラスタライズの倍率。
// → {canvas, rect, glyphs:[{x,y,w,h,u0,v0,u1,v1,cx,cy,idx}], count}
export function layoutText(s, rs) {
  const size = Math.max(1, num(s.size, 96))
  const text = String(s.text ?? '')
  const tracking = num(s.tracking, 0)
  const leading = num(s.leading, 0) || Math.round(size * 1.2)
  const hasStroke = s.stroke != null && s.stroke !== 'none' && num(s.stroke_width, 0) > 0
  const sw = hasStroke ? num(s.stroke_width, 0) : 0
  const hasFill = !(s.fill === null || s.fill === 'none')
  const font = fontSpec(s, size)
  const m = measureCtx()
  m.font = font
  const fm = m.measureText('Mg国')
  const asc = fm.fontBoundingBoxAscent ?? size * 0.88, desc = fm.fontBoundingBoxDescent ?? size * 0.12
  const base = (leading - (asc + desc)) / 2 + asc

  // 行ごとに、先頭からの幅を測って各文字の位置を決める(カーニングを保つ)
  const lines = text.split('\n').map((ln) => {
    const gs = graphemes(ln)
    const xs = []
    let prefix = '', prev = 0
    for (let i = 0; i < gs.length; i++) {
      xs.push(prev + i * tracking)
      prefix += gs[i]
      prev = m.measureText(prefix).width
    }
    const width = gs.length ? prev + (gs.length - 1) * tracking : 0
    return { gs, xs, width, advEnd: prev }
  })
  // 中心が画素の境に来るよう、箱は偶数の大きさにする(100% で文字がぼけない)
  const even = (v) => { const c = Math.ceil(v - 1e-6); return c + (c % 2) }
  const BW = even(Math.max(1, ...lines.map((l) => l.width))), BH = even(lines.length * leading)
  const align = s.align || 'center'
  const pad = Math.ceil(size * 0.3 + sw + 1)

  const cells = []
  lines.forEach((ln, li) => {
    const lx = align === 'left' ? -BW / 2 : align === 'right' ? BW / 2 - ln.width : -ln.width / 2
    const top = -BH / 2 + li * leading
    ln.gs.forEach((g, i) => {
      if (!g.trim()) return
      const gx = lx + ln.xs[i]
      const adv = (i + 1 < ln.xs.length ? ln.xs[i + 1] - tracking : ln.advEnd + i * tracking) - ln.xs[i]
      const x0 = Math.floor(gx - pad), x1 = Math.ceil(gx + adv + pad)
      const y0 = Math.floor(top - pad), y1 = Math.ceil(top + leading + pad)
      cells.push({ g, gx, by: top + base, x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: gx + adv / 2, cy: top + leading / 2, line: li })
    })
  })
  if (!cells.length) return { canvas: null, rect: { x: -BW / 2, y: -BH / 2, w: BW, h: BH }, glyphs: [], count: 0 }

  // 棚詰め。入りきらなければ倍率を下げてやり直す
  let aw, ah
  for (let tries = 0; tries < 6; tries++) {
    const maxW = Math.min(MAX_TEX, Math.max(512, 2 ** Math.ceil(Math.log2(Math.sqrt(cells.reduce((a, c) => a + c.w * c.h, 0)) * rs * 1.3))))
    let x = 0, y = 0, rowH = 0
    aw = 0
    for (const c of cells) {
      const cw = Math.ceil(c.w * rs) + 2, ch = Math.ceil(c.h * rs) + 2
      if (x + cw > maxW && x > 0) { x = 0; y += rowH; rowH = 0 }
      c.ax = x + 1; c.ay = y + 1
      x += cw; rowH = Math.max(rowH, ch); aw = Math.max(aw, x)
    }
    ah = y + rowH
    if (aw <= MAX_TEX && ah <= MAX_TEX) break
    rs *= 0.7
  }
  const [canvas, ctx] = makeCanvas(aw, ah)
  const fill = hasFill ? toCss(s.fill ?? '#ffffff') : null
  const stroke = hasStroke ? toCss(s.stroke) : null
  for (const c of cells) {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.beginPath(); ctx.rect(c.ax, c.ay, Math.ceil(c.w * rs), Math.ceil(c.h * rs)); ctx.clip()
    ctx.setTransform(rs, 0, 0, rs, c.ax - c.x * rs, c.ay - c.y * rs)
    ctx.font = font; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'
    const drawStroke = () => {
      if (!stroke) return
      ctx.lineJoin = 'round'; ctx.lineWidth = sw * (s.stroke_over ? 1 : 2); ctx.strokeStyle = stroke
      ctx.strokeText(c.g, c.gx, c.by)
    }
    // 既定は縁を塗りの下に(外側の縁取り)。stroke_over で線を上に
    if (!s.stroke_over) drawStroke()
    if (fill) { ctx.fillStyle = fill; ctx.fillText(c.g, c.gx, c.by) }
    if (s.stroke_over) drawStroke()
    ctx.restore()
  }
  const glyphs = cells.map((c, idx) => ({
    x: c.x, y: c.y, w: c.w, h: c.h, cx: c.cx, cy: c.cy, idx, line: c.line,
    u0: c.ax / aw, v0: c.ay / ah, u1: (c.ax + c.w * rs) / aw, v1: (c.ay + c.h * rs) / ah,
  }))
  return { canvas, rect: { x: -BW / 2, y: -BH / 2, w: BW, h: BH }, glyphs, count: glyphs.length }
}

// 文字の登場順(0 始まりの順位)
export function charRanks(n, order, seed) {
  const r = new Array(n)
  for (let i = 0; i < n; i++) r[i] = i
  if (order === 'backward') return r.map((i) => n - 1 - i)
  if (order === 'center') return r.map((i) => Math.floor(Math.abs(i - (n - 1) / 2)))
  if (order === 'edges') return r.map((i) => Math.floor((n - 1) / 2 - Math.floor(Math.abs(i - (n - 1) / 2))))
  if (order === 'random') {
    const idx = r.slice().sort((a, b) => rand01(seed, a, 7) - rand01(seed, b, 7) || a - b)
    const out = new Array(n)
    idx.forEach((ci, rank) => { out[ci] = rank })
    return out
  }
  return r
}

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _e = new THREE.Euler(), _v = new THREE.Vector3()
const D2R = Math.PI / 180

function stage(def, n, layerId) {
  if (!def) return null
  const fromDef = def.from || def.to || def
  return {
    stagger: num(def.stagger, 2), dur: Math.max(1e-6, num(def.duration, 12)), e: def.e || 'easeOut', at: def.at,
    ranks: charRanks(n, def.order || 'forward', (def.seed ?? strHash(String(layerId))) | 0),
    pos: vec(fromDef.position, 3, 0), scale: vec(fromDef.scale ?? 100, 3, 100),
    rot: Array.isArray(fromDef.rotation) ? vec(fromDef.rotation, 3, 0) : [0, 0, num(fromDef.rotation, 0)],
    op: fromDef.opacity == null ? 100 : num(fromDef.opacity, 100),
  }
}

// lay の文字を batch に積む。t = レイヤーの in からのコマ、span = レイヤーの長さ
export function fillTextBatch(batch, lay, perChar, t, span, layerId) {
  const n = lay.glyphs.length
  batch.begin(n)
  const sIn = perChar ? stage(perChar, n, layerId) : null
  const sOut = perChar && perChar.out ? stage(perChar.out, n, layerId) : null
  const p = _p
  for (const g of lay.glyphs) {
    let px = 0, py = 0, pz = 0, sx = 1, sy = 1, rx = 0, ry = 0, rz = 0, op = 1
    if (sIn) {
      const k = ease(sIn.e, clamp((t - num(sIn.at, 0) - sIn.ranks[g.idx] * sIn.stagger) / sIn.dur, 0, 1)), q = 1 - k
      px += sIn.pos[0] * q; py += sIn.pos[1] * q; pz += sIn.pos[2] * q
      sx *= 1 + (sIn.scale[0] / 100 - 1) * q; sy *= 1 + (sIn.scale[1] / 100 - 1) * q
      rx += sIn.rot[0] * q; ry += sIn.rot[1] * q; rz += sIn.rot[2] * q
      op *= clamp(1 + (sIn.op / 100 - 1) * q, 0, 1)
    }
    if (sOut) {
      // 消えるほうは、最後の文字がレイヤーの out で消え終わるように後ろから詰める
      const t0 = sOut.at != null ? num(sOut.at, 0) : span - sOut.dur - (n - 1) * sOut.stagger
      const q = ease(sOut.e, clamp((t - t0 - sOut.ranks[g.idx] * sOut.stagger) / sOut.dur, 0, 1))
      px += sOut.pos[0] * q; py += sOut.pos[1] * q; pz += sOut.pos[2] * q
      sx *= 1 + (sOut.scale[0] / 100 - 1) * q; sy *= 1 + (sOut.scale[1] / 100 - 1) * q
      rx += sOut.rot[0] * q; ry += sOut.rot[1] * q; rz += sOut.rot[2] * q
      op *= clamp(1 + (sOut.op / 100 - 1) * q, 0, 1)
    }
    if (op <= 0.0005) continue
    const x0 = g.x, y0 = g.y, x1 = g.x + g.w, y1 = g.y + g.h
    if (px || py || pz || sx !== 1 || sy !== 1 || rx || ry || rz) {
      _e.set(-rx * D2R, -ry * D2R, rz * D2R, 'XYZ')
      _m.makeRotationFromEuler(_e)
      _m.premultiply(_m2.makeTranslation(g.cx + px, g.cy + py, pz))
      _m.multiply(_m2.makeScale(sx, sy, 1)).multiply(_m2.makeTranslation(-g.cx, -g.cy, 0))
      const cs = [x0, y0, x1, y0, x1, y1, x0, y1]
      for (let i = 0; i < 4; i++) {
        _v.set(cs[i * 2], cs[i * 2 + 1], 0).applyMatrix4(_m)
        p[i * 3] = _v.x; p[i * 3 + 1] = _v.y; p[i * 3 + 2] = _v.z
      }
    } else {
      p[0] = x0; p[1] = y0; p[2] = 0; p[3] = x1; p[4] = y0; p[5] = 0
      p[6] = x1; p[7] = y1; p[8] = 0; p[9] = x0; p[10] = y1; p[11] = 0
    }
    batch.push(p, g.u0, g.v0, g.u1, g.v1, 0, 0, 1, 1, op, op, op, op)
  }
  batch.end()
}
const _p = new Float32Array(12)
