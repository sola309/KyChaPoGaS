// テキスト: Canvas2D で 1 文字ずつアトラスに描き、文字ごとの四角形として並べる。
// 文字ごとアニメ(per_char)・タイプライター・円周に沿う配置は四角形の四隅を CPU で動かすだけなので、
// テクスチャは作り直さない。
import { makeCanvas, MAX_TEX, makeFill, isPatternFill } from './shape.js'
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

// ---- カウンター(数から文字列を作る) ----
const pad2 = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0')
// c: {value, decimals, pad, prefix, suffix, format, separator, scramble, seed}。f = コマ(乱数用)
export function formatCounter(c, f = 0) {
  const v = num(c.value, 0)
  // format に数を書いたときは AviUtl のカウンターの表示形式(7 = HH:MM:SS.xx、4〜6 = 時刻、0〜3 = 小数の桁数)
  let fmt = c.format ?? 'number', dec = c.decimals
  if (typeof fmt === 'number') { const n = fmt; fmt = n >= 7 ? 'timecode' : n === 6 ? 'mm:ss.cc' : n === 5 ? 'hh:mm:ss' : n === 4 ? 'mm:ss' : 'number'; if (n <= 3) dec ??= n }
  let out
  if (fmt === 'number') {
    const d = clamp(Math.round(num(dec, 0)), 0, 10)
    const neg = v < 0 && Math.abs(v) >= 0.5 / 10 ** d
    let [ip, fp] = Math.abs(v).toFixed(d).split('.')
    ip = ip.padStart(Math.max(0, Math.round(num(c.pad, 0))), '0')
    if (c.separator) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, typeof c.separator === 'string' ? c.separator : ',')
    out = (neg ? '-' : '') + ip + (fp ? '.' + fp : '')
  } else if (fmt === 'timecode' || fmt === 'hh:mm:ss.cc') {
    const t = Math.max(0, v)
    out = `${pad2(t / 3600)}:${pad2((t / 60) % 60)}:${pad2(t % 60)}.${pad2((t * 100) % 100)}`
  } else if (fmt === 'hh:mm:ss') { const t = Math.max(0, v); out = `${pad2(t / 3600)}:${pad2((t / 60) % 60)}:${pad2(t % 60)}` }
  else if (fmt === 'mm:ss') { const t = Math.max(0, v); out = `${pad2(t / 60)}:${pad2(t % 60)}` }
  else if (fmt === 'mm:ss.cc') { const t = Math.max(0, v); out = `${pad2(t / 60)}:${pad2(t % 60)}.${pad2((t * 100) % 100)}` }
  else {
    // ひな形: '#' の所に数字を右づめで入れる("####.##.##.##:##" + 202111111111 → 2021.11.11.11:11)
    const tpl = String(fmt), n = (tpl.match(/#/g) || []).length
    const digits = String(Math.floor(Math.abs(v))).padStart(n, '0').slice(-n)
    let k = 0
    out = tpl.replace(/#/g, () => digits[k++])
  }
  // scramble(0〜100): 右側のその割合の数字を、コマごとの乱数に差し替える(数字が回りながら左から決まっていく)
  const sc = clamp(num(c.scramble, 0) / 100, 0, 1)
  if (sc > 0) {
    const idx = []
    for (let i = 0; i < out.length; i++) if (out[i] >= '0' && out[i] <= '9') idx.push(i)
    const from = Math.floor(idx.length * (1 - sc) + 1e-9)
    const a = [...out], seed = (num(c.seed, 7) | 0) + Math.floor(f) * 131
    for (let k = from; k < idx.length; k++) a[idx[k]] = String(Math.floor(rand01(seed, k, 5) * 10))
    out = a.join('')
  }
  return String(c.prefix ?? '') + out + String(c.suffix ?? '')
}

// ---- 折り返し・縦書きの文字の分類 ----
const isCJK = (g) => { const c = g.codePointAt(0); return c >= 0x2e80 && !(c >= 0xff61 && c <= 0xff9f) }
const NO_START = new Set([...'、。，．,.）)」』】〕］}｝〉》！？!?ー～〜…‥・：；:;ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々'])
const NO_END = new Set([...'（(「『【〔［{｛〈《'])
const V_ROTATE = new Set([...'ー－—―‐-–〜～…‥：；:;＝=（）()「」『』［］[]｛｝{}〈〉《》【】〔〕＜＞<>→←↑↓|｜_'])
const V_PUNCT = new Set([...'、。，．'])
const V_SMALL = new Set([...'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ'])

// s: 評価済みの source。rs: ラスタライズの倍率。f: コマ(カウンターの乱数用)
// → {canvas, rect, ink, glyphs:[{x,y,w,h,u0,v0,u1,v1,cx,cy,idx,line,word}], plate, count, dual, dualOver}
export function layoutText(s, rs, f = 0) {
  const size = Math.max(1, num(s.size, 96))
  const tracking = num(s.tracking, 0)
  const leading = num(s.leading, 0) || Math.round(size * 1.2)
  const vertical = s.writing === 'vertical' || s.vertical === true
  const m = measureCtx()
  // 文の区切り(runs)。無ければ全体で 1 つ
  let runs
  if (s.counter && typeof s.counter === 'object') runs = [{ text: formatCounter(s.counter, f) }]
  else if (Array.isArray(s.runs) && s.runs.length) runs = s.runs.filter((r) => r && r.text != null)
  else runs = [{ text: String(s.text ?? '') }]
  const fixedDigits = !!(s.counter?.fixed_width || s.fixed_digits)
  const strokesOf = (st) => {
    // 内側から外側へ: [{color, width}]。stroke/stroke_width が 1 本目
    const list = []
    if (st.stroke != null && st.stroke !== 'none' && num(st.stroke_width, 0) > 0) list.push({ color: st.stroke, width: num(st.stroke_width, 0) })
    if (Array.isArray(st.strokes)) for (const x of st.strokes) if (x && num(x.width, 0) > 0) list.push({ color: x.color ?? '#000000', width: num(x.width, 0) })
    return list
  }
  const styles = runs.map((r) => {
    const st = { ...s, ...r }
    const sz = Math.max(1, num(r.size, size))
    const font = fontSpec(st, sz)
    m.font = font
    const fm = m.measureText('Mg国')
    const strokes = strokesOf(st)
    return {
      font, size: sz, asc: fm.fontBoundingBoxAscent ?? sz * 0.88, desc: fm.fontBoundingBoxDescent ?? sz * 0.12,
      fill: st.fill, hasFill: !(st.fill === null || st.fill === 'none'), strokes, sw: strokes.reduce((a, x) => a + x.width, 0),
      over: !!st.stroke_over, tracking: num(r.tracking, tracking), dy: num(r.baseline_shift, 0),
    }
  })
  const base = styles[0]
  const baseY = (leading - (base.asc + base.desc)) / 2 + base.asc
  const sh = s.shadow && typeof s.shadow === 'object' ? s.shadow : null
  const shPad = sh ? num(sh.blur, 0) * 1.5 + Math.max(Math.abs(num(sh.x, 0)), Math.abs(num(sh.y, 0))) : 0
  const dual = styles.some((st) => isPatternFill(st.fill))

  // 1 文字ずつに分ける(改行は行の区切り)
  let lines = [[]]
  runs.forEach((r, ri) => {
    String(r.text).split('\n').forEach((part, pi) => {
      if (pi > 0) lines.push([])
      for (const g of graphemes(part)) lines[lines.length - 1].push({ g, ri })
    })
  })
  const advCache = new Map()
  const advOf = (it) => {
    const key = it.ri + '|' + it.g
    let a = advCache.get(key)
    if (a === undefined) { m.font = styles[it.ri].font; a = m.measureText(it.g).width; advCache.set(key, a) }
    return a
  }
  const vAdv = (it) => {
    const st = styles[it.ri]
    return (vKind(it.g, s) === 'r' ? advOf(it) : st.size) + st.tracking
  }
  // 折り返し(wrap_width。縦書きでは 1 列の長さ)
  const wrap = num(s.wrap_width, 0)
  if (wrap > 0) {
    const out = []
    for (const ln of lines) {
      let cur = [], w = 0, lastBreak = -1
      for (let i = 0; i < ln.length; i++) {
        const it = ln[i], a = vertical ? vAdv(it) : advOf(it) + styles[it.ri].tracking
        const prev = cur[cur.length - 1]
        if (prev && (prev.g === ' ' || prev.g === '　' || isCJK(it.g) || isCJK(prev.g)) && !NO_START.has(it.g) && !NO_END.has(prev.g)) lastBreak = cur.length
        if (w + a > wrap + 1e-6 && cur.length && it.g.trim()) {
          const at = lastBreak > 0 ? lastBreak : cur.length
          const rest = cur.splice(at)
          while (cur.length && !cur[cur.length - 1].g.trim()) cur.pop()
          out.push(cur)
          cur = rest; w = cur.reduce((x, y) => x + (vertical ? vAdv(y) : advOf(y) + styles[y.ri].tracking), 0); lastBreak = -1
        }
        cur.push(it); w += a
      }
      out.push(cur)
    }
    lines = out
  }

  const even = (v) => { const c = Math.ceil(v - 1e-6); return c + (c % 2) }
  const align = s.align || 'center'
  const cells = []
  let BW, BH, word = 0
  let maxDigit = null
  const digitW = (ri) => {
    maxDigit ??= new Map()
    let w = maxDigit.get(ri)
    if (w === undefined) { m.font = styles[ri].font; w = Math.max(...[...'0123456789'].map((d) => m.measureText(d).width)); maxDigit.set(ri, w) }
    return w
  }
  if (!vertical) {
    // 行ごとに、区切りの先頭からの幅を測って各文字の位置を決める(カーニングを保つ)
    const laid = lines.map((ln) => {
      const items = []
      let x = 0, i = 0
      while (i < ln.length) {
        const ri = ln[i].ri, st = styles[ri]
        let j = i
        while (j < ln.length && ln[j].ri === ri) j++
        m.font = st.font
        let prefix = '', prev = 0, extra = 0
        for (let k = i; k < j; k++) {
          const g = ln[k].g
          prefix += g
          const nx = m.measureText(prefix).width
          let adv = nx - prev, gx = x + prev + (k - i) * st.tracking + extra
          if (fixedDigits && g >= '0' && g <= '9') { const dw = digitW(ri); gx += (dw - adv) / 2; extra += dw - adv; adv = dw }
          items.push({ g, ri, gx, adv })
          prev = nx
        }
        x += prev + (j - i) * st.tracking + extra
        i = j
      }
      const last = items[items.length - 1]
      const width = items.length ? x - styles[last.ri].tracking : 0
      return { items, width }
    })
    BW = even(Math.max(1, ...laid.map((l) => l.width))); BH = even(laid.length * leading)
    laid.forEach((ln, li) => {
      const lx = align === 'left' ? -BW / 2 : align === 'right' ? BW / 2 - ln.width : -ln.width / 2
      const top = -BH / 2 + li * leading
      for (const it of ln.items) {
        if (!it.g.trim()) { word++; continue }
        const st = styles[it.ri]
        const pad = Math.ceil(st.size * 0.3 + st.sw + shPad + 1)
        const gx = lx + it.gx, by = top + baseY + st.dy
        const x0 = Math.floor(gx - pad), x1 = Math.ceil(gx + it.adv + pad)
        const y0 = Math.floor(Math.min(top, by - st.asc) - pad), y1 = Math.ceil(Math.max(top + leading, by + st.desc) + pad)
        // rotated_glyphs(@ つきの書体): 和文の字を 90° 寝かせて描く(オブジェクトを回して縦書きにする作り用)
        cells.push({ g: it.g, st, kind: s.rotated_glyphs && isCJK(it.g) ? 'l' : 'h', gx, by, x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: gx + it.adv / 2, cy: top + leading / 2, line: li, word })
      }
      word++
    })
  } else {
    // 縦書き: 列は右から左へ。全角は正立、長音・かっこ・半角英数は 90° 回す
    const cols = lines.map((ln) => {
      const items = []
      let y = 0
      for (const it of ln) { const a = vAdv(it); items.push({ ...it, y, adv: a - styles[it.ri].tracking }); y += a }
      const last = items[items.length - 1]
      return { items, len: items.length ? y - styles[last.ri].tracking : 0 }
    })
    BW = even(cols.length * leading); BH = even(Math.max(1, ...cols.map((c) => c.len)))
    const va = s.valign || (align === 'left' ? 'top' : align === 'right' ? 'bottom' : 'middle')
    cols.forEach((col, ci) => {
      const colX = BW / 2 - (ci + 0.5) * leading
      const ty = va === 'top' ? -BH / 2 : va === 'bottom' ? BH / 2 - col.len : -col.len / 2
      for (const it of col.items) {
        if (!it.g.trim()) { word++; continue }
        const st = styles[it.ri]
        const pad = Math.ceil(st.size * 0.3 + st.sw + shPad + 1)
        const cy = ty + it.y + it.adv / 2
        const half = Math.max(st.size, it.adv) / 2
        const x0 = Math.floor(colX - half - pad), x1 = Math.ceil(colX + half + pad)
        const y0 = Math.floor(cy - half - pad), y1 = Math.ceil(cy + half + pad)
        cells.push({ g: it.g, st, kind: vKind(it.g, s), x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: colX, cy, line: ci, word })
      }
      word++
    })
  }
  // 基準点: valign を書いたときは、align / valign の側の端をレイヤーの原点に合わせる(AviUtl の「左寄せ[上]」など)。
  // 書かなければ箱の中心が原点(v1 と同じ)
  let ox = 0, oy = 0
  if (s.valign) {
    ox = align === 'left' ? BW / 2 : align === 'right' ? -BW / 2 : 0
    oy = s.valign === 'top' ? BH / 2 : s.valign === 'bottom' ? -BH / 2 : 0
    for (const c of cells) { c.x += ox; c.y += oy; c.cx += ox; c.cy += oy; if (c.kind === 'h') { c.gx += ox; c.by += oy } }
  }
  const rect = { x: -BW / 2 + ox, y: -BH / 2 + oy, w: BW, h: BH }

  // 座布団(plate): 文字の箱を padding ぶん広げた角丸の板
  let plate = null
  const pl = s.plate && typeof s.plate === 'object' ? s.plate : null
  if (pl && (cells.length || pl.always)) {
    const pd = vec(pl.padding ?? [size * 0.3, size * 0.15], 2, 0)
    const psw = pl.stroke != null && num(pl.stroke_width, 0) > 0 ? num(pl.stroke_width, 0) : 0
    const px0 = Math.floor(rect.x - pd[0] - psw - 1), py0 = Math.floor(rect.y - pd[1] - psw - 1)
    const px1 = Math.ceil(rect.x + BW + pd[0] + psw + 1), py1 = Math.ceil(rect.y + BH + pd[1] + psw + 1)
    plate = { x: px0, y: py0, w: px1 - px0, h: py1 - py0, bx: rect.x - pd[0], by: rect.y - pd[1], bw: BW + pd[0] * 2, bh: BH + pd[1] * 2, psw, def: pl }
  }
  let ink = plate ? { x: plate.x, y: plate.y, w: plate.w, h: plate.h } : null
  for (const c0 of cells) {
    // 絵の範囲は字の実際の形から測る(セルは余白が大きいので、エフェクト用の RT が無駄に大きくなる)
    let c = c0
    if (c0.kind === 'h') {
      m.font = c0.st.font
      const tm = m.measureText(c0.g)
      if (tm.actualBoundingBoxAscent != null) {
        const e = c0.st.sw + shPad + 3
        const x0 = Math.max(c0.x, Math.floor(c0.gx - tm.actualBoundingBoxLeft - e)), x1 = Math.min(c0.x + c0.w, Math.ceil(c0.gx + tm.actualBoundingBoxRight + e))
        const y0 = Math.max(c0.y, Math.floor(c0.by - tm.actualBoundingBoxAscent - e)), y1 = Math.min(c0.y + c0.h, Math.ceil(c0.by + tm.actualBoundingBoxDescent + e))
        if (x1 > x0 && y1 > y0) c = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      }
    }
    if (!ink) ink = { x: c.x, y: c.y, w: c.w, h: c.h }
    else { const x1 = Math.max(ink.x + ink.w, c.x + c.w), y1 = Math.max(ink.y + ink.h, c.y + c.h); ink.x = Math.min(ink.x, c.x); ink.y = Math.min(ink.y, c.y); ink.w = x1 - ink.x; ink.h = y1 - ink.y }
  }
  if (!cells.length && !plate) return { canvas: null, rect, ink: rect, glyphs: [], plate: null, count: 0, dual: false, vertical }

  // 棚詰め。入りきらなければ倍率を下げてやり直す
  const boxes = plate ? [plate, ...cells] : cells
  let aw, ah
  for (let tries = 0; tries < 8; tries++) {
    const area = boxes.reduce((a, c) => a + c.w * c.h, 0)
    const maxW = Math.min(MAX_TEX, Math.max(512, 2 ** Math.ceil(Math.log2(Math.sqrt(area) * rs * 1.3)), Math.ceil(Math.max(...boxes.map((c) => c.w)) * rs) + 2))
    let x = 0, y = 0, rowH = 0
    aw = 0
    for (const c of boxes) {
      const cw = Math.ceil(c.w * rs) + 2, ch = Math.ceil(c.h * rs) + 2
      if (x + cw > maxW && x > 0) { x = 0; y += rowH; rowH = 0 }
      c.ax = x + 1; c.ay = y + 1
      x += cw; rowH = Math.max(rowH, ch); aw = Math.max(aw, x)
    }
    ah = y + rowH
    if (aw <= MAX_TEX && ah * (dual ? 2 : 1) <= MAX_TEX) break
    rs *= 0.7
  }
  const H = dual ? ah * 2 : ah
  const [canvas, ctx] = makeCanvas(aw, H)
  const bb = { x0: rect.x, y0: rect.y, x1: rect.x + BW, y1: rect.y + BH }
  const begin = (c, offY) => {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.beginPath(); ctx.rect(c.ax, c.ay + offY, Math.ceil(c.w * rs), Math.ceil(c.h * rs)); ctx.clip()
    ctx.setTransform(rs, 0, 0, rs, c.ax - c.x * rs, c.ay + offY - c.y * rs)
  }
  const setShadow = (on) => {
    if (on && sh) {
      const sc = toCss(sh.color ?? '#000000')
      ctx.shadowColor = sh.opacity != null ? sc.replace(/[\d.]+\)$/, `${(parseFloat(sc.match(/([\d.]+)\)$/)[1]) * clamp(num(sh.opacity, 100) / 100, 0, 1)).toFixed(4)})`) : sc
      ctx.shadowBlur = num(sh.blur, 0) * rs; ctx.shadowOffsetX = num(sh.x, 4) * rs; ctx.shadowOffsetY = num(sh.y, 4) * rs
    } else { ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0 }
  }
  if (plate) {
    begin(plate, dual ? ah : 0)
    const d = plate.def, r = Math.max(0, Math.min(num(d.radius, 0), plate.bw / 2, plate.bh / 2))
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(plate.bx, plate.by, plate.bw, plate.bh, r); else ctx.rect(plate.bx, plate.by, plate.bw, plate.bh)
    ctx.globalAlpha = clamp(num(d.opacity, 100) / 100, 0, 1)
    ctx.fillStyle = makeFill(ctx, d.color ?? d.fill ?? '#000000', { x0: plate.bx, y0: plate.by, x1: plate.bx + plate.bw, y1: plate.by + plate.bh }) || 'rgba(0,0,0,0)'
    ctx.fill()
    if (plate.psw) { ctx.lineWidth = plate.psw; ctx.strokeStyle = toCss(d.stroke); ctx.stroke() }
    ctx.restore()
  }
  // 文字を描く。part: 'all' | 'fill'(塗りだけ)| 'rest'(縁・影だけ)
  const drawGlyph = (c, part) => {
    const st = c.st
    ctx.font = st.font; ctx.lineJoin = 'round'
    let tx, ty
    if (c.kind === 'h') { ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; tx = c.gx; ty = c.by }
    else {
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; tx = c.cx; ty = c.cy
      if (c.kind === 'r') { ctx.translate(c.cx, c.cy); ctx.rotate(Math.PI / 2); tx = 0; ty = 0 }
      else if (c.kind === 'l') { ctx.translate(c.cx, c.cy); ctx.rotate(-Math.PI / 2); tx = 0; ty = 0 }
      else if (c.kind === 'p') { tx += st.size * 0.55; ty -= st.size * 0.55 }
      else if (c.kind === 's') { tx += st.size * 0.1; ty -= st.size * 0.1 }
    }
    const fill = st.hasFill ? makeFill(ctx, st.fill ?? '#ffffff', bb) : null
    let first = true
    const strokes = () => {
      if (part === 'fill') return
      let w = st.sw
      for (let k = st.strokes.length - 1; k >= 0; k--) {
        // 外側の縁から順に。塗りの下に敷くときは 2 倍の太さ(外に見える幅 = width)
        ctx.lineWidth = st.over ? w : w * 2
        ctx.strokeStyle = toCss(st.strokes[k].color)
        setShadow(first); first = false
        ctx.strokeText(c.g, tx, ty)
        w -= st.strokes[k].width
      }
    }
    const doFill = () => {
      if (!fill) return
      if (part === 'rest') {
        // 模様で塗るとき: 影だけは下の段に落としておく(塗りの形の影)
        if (first && sh && !st.strokes.length) { setShadow(true); ctx.fillStyle = '#000'; ctx.globalCompositeOperation = 'source-over'; ctx.fillText(c.g, tx, ty); setShadow(false); ctx.globalCompositeOperation = 'destination-out'; ctx.fillText(c.g, tx, ty); ctx.globalCompositeOperation = 'source-over' }
        return
      }
      setShadow(first && part === 'all'); first = false
      ctx.fillStyle = fill; ctx.fillText(c.g, tx, ty)
    }
    // 既定は縁を塗りの下に(外側の縁取り)。stroke_over で線を上に
    if (!st.over) { strokes(); setShadow(false); doFill() } else { doFill(); setShadow(false); strokes() }
    setShadow(false)
  }
  for (const c of cells) {
    if (dual) {
      begin(c, 0); drawGlyph(c, 'fill'); ctx.restore()
      begin(c, ah); drawGlyph(c, 'rest'); ctx.restore()
    } else { begin(c, 0); drawGlyph(c, 'all'); ctx.restore() }
  }
  const q = (c, idx) => ({
    x: c.x, y: c.y, w: c.w, h: c.h, cx: c.cx ?? c.x + c.w / 2, cy: c.cy ?? c.y + c.h / 2, idx, line: c.line ?? 0, word: c.word ?? 0,
    u0: c.ax / aw, v0: c.ay / H, u1: (c.ax + c.w * rs) / aw, v1: (c.ay + c.h * rs) / H,
  })
  const glyphs = cells.map(q)
  return {
    canvas, rect, ink, glyphs, plate: plate ? q(plate, -1) : null, count: glyphs.length, dual, vertical,
    dualOver: dual && styles.some((st) => st.over), nLines: lines.length, nWords: word,
  }
}
function vKind(g, s) {
  if (V_ROTATE.has(g)) return 'r'
  if (V_PUNCT.has(g)) return 'p'
  if (V_SMALL.has(g)) return 's'
  if (g.codePointAt(0) < 0x2e80 && s.vertical_latin !== 'upright') return 'r'
  return 'u'
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
  let ranks
  if (Array.isArray(def.ranks)) ranks = Array.from({ length: n }, (_, i) => +def.ranks[i] || 0) // 順番を表で指定
  else ranks = charRanks(n, def.order || 'forward', (def.seed ?? strHash(String(layerId))) | 0)
  return {
    stagger: num(def.stagger, 2), dur: Math.max(1e-6, num(def.duration, 12)), e: def.e || 'easeOut', at: def.at, ranks,
    pos: vec(fromDef.position, 3, 0), scale: vec(fromDef.scale ?? 100, 3, 100),
    rot: Array.isArray(fromDef.rotation) ? vec(fromDef.rotation, 3, 0) : [0, 0, num(fromDef.rotation, 0)],
    op: fromDef.opacity == null ? 100 : num(fromDef.opacity, 100),
  }
}

// lay の文字を batch に積む。t = レイヤーの in からのコマ、span = レイヤーの長さ。
// opt: {visible(見せる文字数。小数可), arc:{radius,start,sweep}, randAmt(0〜1), v0max(2 段テクスチャのとき 0.5)}
export function fillTextBatch(batch, lay, perChar, t, span, layerId, opt = {}) {
  const n = lay.glyphs.length
  batch.begin(n + 1)
  const unit = perChar?.unit === 'word' ? 'word' : perChar?.unit === 'line' ? 'line' : 'char'
  // 単位(文字・単語・行)ごとの番号と中心
  let nUnits = n, unitOf = null, ucx = null, ucy = null
  if (perChar && unit !== 'char') {
    const ids = new Map()
    unitOf = lay.glyphs.map((g) => { const k = unit === 'word' ? g.word : g.line; if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k) })
    nUnits = ids.size
    const bx = Array.from({ length: nUnits }, () => [Infinity, Infinity, -Infinity, -Infinity])
    lay.glyphs.forEach((g, i) => { const b = bx[unitOf[i]]; b[0] = Math.min(b[0], g.cx); b[1] = Math.min(b[1], g.cy); b[2] = Math.max(b[2], g.cx); b[3] = Math.max(b[3], g.cy) })
    ucx = bx.map((b) => (b[0] + b[2]) / 2); ucy = bx.map((b) => (b[1] + b[3]) / 2)
  }
  const sIn = perChar ? stage(perChar, nUnits, layerId) : null
  const sOut = perChar && perChar.out ? stage(perChar.out, nUnits, layerId) : null
  const rnd = perChar && perChar.random && opt.randAmt !== 0 ? perChar.random : null
  const rSeed = rnd ? (rnd.seed ?? strHash(String(layerId)) + 11) | 0 : 0
  const rAmt = opt.randAmt ?? 1
  const arc = opt.arc && num(opt.arc.radius, 0) !== 0 ? opt.arc : null
  const vis = opt.visible
  const p = _p
  if (lay.plate) {
    const g = lay.plate
    batch.pushRect(g.x, g.y, g.w, g.h, g.u0, g.v0, g.u1, g.v1)
  }
  for (let gi = 0; gi < n; gi++) {
    const g = lay.glyphs[gi]
    const ui = unitOf ? unitOf[gi] : g.idx
    let px = 0, py = 0, pz = 0, sx = 1, sy = 1, rx = 0, ry = 0, rz = 0, op = 1
    if (vis != null) { const k = clamp(vis - g.idx, 0, 1); if (k <= 0) continue; op *= k }
    if (sIn) {
      const k = ease(sIn.e, clamp((t - num(sIn.at, 0) - sIn.ranks[ui] * sIn.stagger) / sIn.dur, 0, 1)), q = 1 - k
      px += sIn.pos[0] * q; py += sIn.pos[1] * q; pz += sIn.pos[2] * q
      sx *= 1 + (sIn.scale[0] / 100 - 1) * q; sy *= 1 + (sIn.scale[1] / 100 - 1) * q
      rx += sIn.rot[0] * q; ry += sIn.rot[1] * q; rz += sIn.rot[2] * q
      op *= clamp(1 + (sIn.op / 100 - 1) * q, 0, 1)
    }
    if (sOut) {
      // 消えるほうは、最後の文字がレイヤーの out で消え終わるように後ろから詰める
      const t0 = sOut.at != null ? num(sOut.at, 0) : span - sOut.dur - (nUnits - 1) * sOut.stagger
      const q = ease(sOut.e, clamp((t - t0 - sOut.ranks[ui] * sOut.stagger) / sOut.dur, 0, 1))
      px += sOut.pos[0] * q; py += sOut.pos[1] * q; pz += sOut.pos[2] * q
      sx *= 1 + (sOut.scale[0] / 100 - 1) * q; sy *= 1 + (sOut.scale[1] / 100 - 1) * q
      rx += sOut.rot[0] * q; ry += sOut.rot[1] * q; rz += sOut.rot[2] * q
      op *= clamp(1 + (sOut.op / 100 - 1) * q, 0, 1)
    }
    if (rnd) {
      // 文字ごとの決まった乱れ(種から決まる)
      const r = (k) => (rand01(rSeed, ui, k) * 2 - 1) * rAmt
      const rp = vec(rnd.position, 3, 0)
      px += rp[0] * r(1); py += rp[1] * r(2); pz += rp[2] * r(3)
      rz += num(rnd.rotation, 0) * r(4)
      const rsx = num(rnd.scale, 0) / 100 * r(5); sx *= 1 + rsx; sy *= 1 + rsx
      if (rnd.opacity != null) op *= clamp(1 - (num(rnd.opacity, 0) / 100) * Math.abs(r(6)), 0, 1)
    }
    if (op <= 0.0005) continue
    const x0 = g.x, y0 = g.y, x1 = g.x + g.w, y1 = g.y + g.h
    // 回す・拡大する中心(単語・行の単位ならその中心)
    const pcx = unitOf ? ucx[ui] : g.cx, pcy = unitOf ? ucy[ui] : g.cy
    const moved = px || py || pz || sx !== 1 || sy !== 1 || rx || ry || rz
    if (moved || arc) {
      _e.set(-rx * D2R, -ry * D2R, rz * D2R, 'XYZ')
      _m.makeRotationFromEuler(_e)
      _m.premultiply(_m2.makeTranslation(pcx + px, pcy + py, pz))
      _m.multiply(_m2.makeScale(sx, sy, 1)).multiply(_m2.makeTranslation(-pcx, -pcy, 0))
      if (arc) {
        // 円周に沿わせる: 文字の中心の x を円周上の角度に直す。円の中心 = レイヤーの原点
        const R = num(arc.radius, 300), aR = Math.abs(R)
        let a
        if (arc.sweep != null) {
          const sw = num(arc.sweep, 360)
          a = num(arc.start, 0) + (Math.abs(sw) >= 360 ? g.idx / Math.max(1, n) : n > 1 ? g.idx / (n - 1) - 0.5 : 0) * sw
          a *= D2R
        } else a = num(arc.start, 0) * D2R + (R > 0 ? g.cx : -g.cx) / aR
        let rot = a, rad = aR - (R > 0 ? g.cy : -g.cy)
        if (R < 0) { a += Math.PI; rot = a + Math.PI }
        // 文字を自分の中心まわりに回して、円周上へ運ぶ
        _m.premultiply(_m2.makeTranslation(-g.cx, -g.cy, 0))
        _m.premultiply(_m2.makeRotationZ(rot))
        _m.premultiply(_m2.makeTranslation(Math.sin(a) * rad, -Math.cos(a) * rad, 0))
      }
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
