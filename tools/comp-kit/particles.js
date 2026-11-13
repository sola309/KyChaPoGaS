// 粒子: 何コマ目を描いても同じ絵になるよう、粒ごとの生まれた時刻と乱数から位置を式で求める
// (前のコマの状態を持たない)。
import { evalProp, evalAll, rand01, noise1, num, vec, toColor, clamp } from './props.js'
import { makeCanvas, shapePolyline } from './shape.js'

const D2R = Math.PI / 180
export const MAX_PARTICLES = 6000

// 粒の絵(白。色は頂点色で付ける)
export function spriteCanvas(kind) {
  const S = 64
  const [c, ctx] = makeCanvas(S, S)
  const h = S / 2
  ctx.fillStyle = '#fff'
  if (kind === 'square') ctx.fillRect(2, 2, S - 4, S - 4)
  else if (kind === 'rect') ctx.fillRect(2, 14, S - 4, S - 28)
  else if (kind === 'circle') { ctx.beginPath(); ctx.arc(h, h, h - 2, 0, Math.PI * 2); ctx.fill() }
  else if (kind === 'star' || kind === 'spark') {
    const n = kind === 'star' ? 5 : 4, inner = kind === 'star' ? 0.45 : 0.12
    ctx.beginPath()
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2, r = (h - 2) * (i % 2 ? inner : 1)
      ctx.lineTo(h + Math.cos(a) * r, h + Math.sin(a) * r)
    }
    ctx.closePath(); ctx.fill()
  } else if (kind === 'petal' || kind === 'heart' || kind === 'flower') {
    const poly = shapePolyline({ kind, width: kind === 'petal' ? S * 0.7 : S - 6, height: S - 6 })
    ctx.beginPath()
    poly.pts.forEach((p, i) => (i ? ctx.lineTo(h + p[0], h + p[1]) : ctx.moveTo(h + p[0], h + p[1])))
    ctx.closePath(); ctx.fill()
    if (kind === 'petal') {
      // 付け根へ向かって少し濃淡をつける(色は頂点色との掛け算)
      const g = ctx.createLinearGradient(0, 4, 0, S - 4)
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(225,225,225,1)')
      ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = g; ctx.fillRect(0, 0, S, S)
    }
  } else {
    const g = ctx.createRadialGradient(h, h, 0, h, h, h)
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.75)')
    g.addColorStop(0.6, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S)
  }
  return c
}
export const SPRITE_KINDS = ['soft', 'circle', 'square', 'rect', 'star', 'spark', 'petal', 'heart', 'flower']

// 出来合いの設定(emitter に書いた値が優先)
export const PARTICLE_PRESETS = {
  petals: {
    sprite: 'petal', blend: 'normal', rate: 24, life: 6, life_random: 0.3, speed: 60, speed_random: 0.5, direction: 180, spread: 50,
    gravity: [0, 40, 0], wind: [50, 0, 0], sway: { amp: 40, freq: 0.5 }, flutter: 220, spin: 60, rotation_random: 360,
    size: [26, 26], size_random: 0.5, opacity: [100, 100, 100, 0], color: ['#ffd9e4', '#ffb7cd'], fade_in: 0.05, emit: 'box',
  },
  confetti: {
    sprite: 'rect', blend: 'normal', rate: 60, life: 4, life_random: 0.3, speed: 500, speed_random: 0.6, direction: 0, spread: 80,
    gravity: [0, 500, 0], drag: 1.2, flutter: 540, spin: 180, rotation_random: 360, size: [22, 22], size_random: 0.4,
    opacity: [100, 100, 100, 0], colors: ['#ff5d73', '#ffd166', '#06d6a0', '#4cc9f0', '#f72585', '#ffffff'], fade_in: 0,
  },
  snow: {
    sprite: 'soft', blend: 'normal', rate: 40, life: 8, life_random: 0.2, speed: 70, speed_random: 0.5, direction: 180, spread: 20,
    sway: { amp: 30, freq: 0.3 }, size: [14, 14], size_random: 0.6, opacity: [90, 90, 0], color: '#ffffff', emit: 'box',
  },
  sparks: {
    sprite: 'spark', blend: 'add', rate: 80, life: 0.9, life_random: 0.4, speed: 420, speed_random: 0.6, spread: 360,
    gravity: [0, 300, 0], drag: 1.5, size: [22, 0], color: ['#fff3c4', '#ff8a3d'], opacity: [100, 0], rotation_random: 360,
  },
  dust: {
    sprite: 'soft', blend: 'add', rate: 20, life: 5, life_random: 0.4, speed: 16, speed_random: 0.8, spread: 360,
    turbulence: { amp: 30, freq: 0.3 }, size: [10, 10], size_random: 0.7, opacity: [0, 60, 60, 0], color: '#ffffff', emit: 'box', fade_in: 0,
  },
}

const _p = new Float32Array(12)
// 寿命に沿った値: 数 / [始, 終] / [a, b, c, ...](等間隔)
function stops(v, a, b) {
  if (Array.isArray(v) && v.length) return v.map((x, i) => num(x, i ? b : a))
  if (typeof v === 'number') return [v, v]
  return [a, b]
}
function sample(st, u) {
  const n = st.length
  if (n === 1) return st[0]
  const x = clamp(u, 0, 1) * (n - 1), i = Math.min(n - 2, Math.floor(x))
  return st[i] + (st[i + 1] - st[i]) * (x - i)
}

// def: レイヤーの定義。f: コマ。opt: {aspect(粒の絵の 幅/高さ), depth(x,y,z) → カメラからの奥行き(並べ替え用)}
// → 積んだ粒の数
export function fillParticles(batch, def, f, fps, opt = {}) {
  const src = def.source || {}
  const E0 = src.emitter || {}
  const E = E0.preset && PARTICLE_PRESETS[E0.preset] ? { ...PARTICLE_PRESETS[E0.preset], ...E0 } : E0
  const seed = (src.seed ?? 1) | 0
  const e = evalAll(E, f, fps)
  const t = (f - (def.in ?? 0)) / fps
  const rate = Math.max(0, num(e.rate, 30))
  const life = Math.max(0.01, num(e.life, 1.5)), lifeR = clamp(num(e.life_random, 0), 0, 1)
  const burst = Math.max(0, Math.round(num(e.burst, 0)))
  const speed = num(e.speed, 200), speedR = clamp(num(e.speed_random, 0.3), 0, 1)
  const dir = num(e.direction, 0), spread = num(e.spread, 360)
  const zs = num(e.z_speed, 0)
  const grav = vec(e.gravity, 3, 0), drag = Math.max(0, num(e.drag, 0))
  const wind = vec(e.wind, 3, 0)
  const area = vec(e.area, 3, 0)
  const emit = e.emit || 'box'
  const size = stops(e.size, 16, 0), sizeR = clamp(num(e.size_random, 0.3), 0, 1)
  const opac = stops(e.opacity, 100, 0)
  // 色: 1 色 / [始, 終, ...](寿命に沿って変わる)。colors: [...] は粒ごとに 1 色を選ぶ
  const colList = Array.isArray(e.color) && (typeof e.color[0] === 'string' || Array.isArray(e.color[0])) ? e.color.map((c) => toColor(c, [1, 1, 1, 1])) : [toColor(e.color, [1, 1, 1, 1])]
  const pick = Array.isArray(e.colors) && e.colors.length ? e.colors.map((c) => toColor(c, [1, 1, 1, 1])) : null
  const spin = num(e.spin, 0), rotR = num(e.rotation_random, ['star', 'square', 'rect', 'petal', 'heart', 'flower'].includes(e.sprite) ? 360 : 0)
  const fadeIn = clamp(num(e.fade_in, 0.08), 0, 0.5)
  const flutter = num(e.flutter, 0)
  const sway = e.sway && typeof e.sway === 'object' ? e.sway : null
  const swA = sway ? num(sway.amp, 0) : 0, swF = sway ? num(sway.freq, 0.5) : 0
  const tb = e.turbulence && typeof e.turbulence === 'object' ? e.turbulence : typeof e.turbulence === 'number' ? { amp: e.turbulence } : null
  const tbA = tb ? num(tb.amp, 0) : 0, tbF = tb ? num(tb.freq, 0.5) : 0
  const aspect = opt.aspect > 0 ? opt.aspect : 1
  const orient = !!e.orient
  if (t < 0) { batch.begin(0); batch.end(); return 0 }

  // いま生きている粒の番号の範囲。負の番号は一斉放出(burst / bursts)
  const first = rate > 0 ? Math.max(0, Math.ceil((t - life) * rate - 1e-9)) : 0
  const last = rate > 0 ? Math.floor(t * rate + 1e-9) : -1
  const nCont = Math.max(0, Math.min(last - first + 1, MAX_PARTICLES))
  const nBurst = t < life ? Math.min(burst, MAX_PARTICLES) : 0
  const bursts = []
  if (Array.isArray(E.bursts)) {
    E.bursts.forEach((b, bi) => {
      const bt = num(b?.f ?? b?.frame, 0) / fps, cnt = Math.min(MAX_PARTICLES, Math.max(0, Math.round(num(b?.count, 0))))
      if (t >= bt && t < bt + life && cnt) bursts.push({ bi, bt, cnt })
    })
  }
  const total = nCont + nBurst + bursts.reduce((a, b) => a + b.cnt, 0)
  batch.begin(total)
  const posAnimated = E.position && typeof E.position === 'object' && !Array.isArray(E.position)
  const pos0 = vec(e.position, 3, 0)
  const sort = opt.depth && (E.blend || 'add') !== 'add' ? [] : null
  const one = (i, born) => {
    const lf = life * (1 - lifeR * rand01(seed, i, 1))
    const age = t - born
    if (age < 0 || age >= lf) return
    const u = age / lf
    // 発生位置は生まれた時刻のエミッタの位置(動くエミッタが尾を引く)
    const ep = posAnimated ? vec(evalProp(E.position, (def.in ?? 0) + born * fps, fps), 3, 0) : pos0
    const ang = (dir + (rand01(seed, i, 2) - 0.5) * spread) * D2R
    const sp = speed * (1 - speedR * rand01(seed, i, 3))
    const vx = Math.sin(ang) * sp, vy = -Math.cos(ang) * sp, vz = (rand01(seed, i, 4) - 0.5) * 2 * zs
    // 抵抗つきの移動距離: ∫e^{-kτ} = (1-e^{-kτ})/k
    const mv = drag > 0 ? (1 - Math.exp(-drag * age)) / drag : age
    const g2 = 0.5 * age * age
    // 生まれる場所: 箱 / 円(emit_edge で円周だけ)/ 線(箱の対角線)/ 点
    let ox = 0, oy = 0, oz = (rand01(seed, i, 7) - 0.5) * area[2]
    const r5 = rand01(seed, i, 5), r6 = rand01(seed, i, 6)
    if (emit === 'circle') {
      const a = r5 * Math.PI * 2, rr = e.emit_edge ? 1 : Math.sqrt(r6)
      ox = Math.cos(a) * rr * area[0] / 2; oy = Math.sin(a) * rr * (area[1] || area[0]) / 2
    } else if (emit === 'line') { ox = (r5 - 0.5) * area[0]; oy = (r5 - 0.5) * area[1] }
    else if (emit !== 'point') { ox = (r5 - 0.5) * area[0]; oy = (r6 - 0.5) * area[1] }
    let x = ep[0] + ox + vx * mv + grav[0] * g2 + wind[0] * age
    let y = ep[1] + oy + vy * mv + grav[1] * g2 + wind[1] * age
    let z = ep[2] + oz + vz * mv + grav[2] * g2 + wind[2] * age
    if (swA) x += swA * Math.sin((swF * age + rand01(seed, i, 11)) * Math.PI * 2)
    if (tbA) {
      const ph = rand01(seed, i, 12) * 100
      x += tbA * noise1(seed, 1, tbF * age + ph); y += tbA * noise1(seed, 2, tbF * age + ph + 31.7); z += tbA * 0.5 * noise1(seed, 3, tbF * age + ph + 77.1)
    }
    const s = sample(size, u) * (1 - sizeR * rand01(seed, i, 8)) * 0.5
    if (s <= 0.01) return
    let a = sample(opac, u) / 100
    if (fadeIn > 0) a *= Math.min(1, u / fadeIn)
    let c
    if (pick) c = pick[Math.floor(rand01(seed, i, 13) * pick.length) % pick.length]
    else if (colList.length === 1) c = colList[0]
    else {
      const xx = clamp(u, 0, 1) * (colList.length - 1), k = Math.min(colList.length - 2, Math.floor(xx)), q = xx - k
      const c0 = colList[k], c1 = colList[k + 1]
      c = [c0[0] + (c1[0] - c0[0]) * q, c0[1] + (c1[1] - c0[1]) * q, c0[2] + (c1[2] - c0[2]) * q, c0[3] + (c1[3] - c0[3]) * q]
    }
    a = clamp(a * c[3], 0, 1)
    if (a <= 0.002) return
    let rot = ((rand01(seed, i, 9) - 0.5) * rotR + spin * age * (rand01(seed, i, 10) > 0.5 ? 1 : -1)) * D2R
    if (orient) {
      const dk = drag > 0 ? Math.exp(-drag * age) : 1
      rot = Math.atan2(vx * dk + grav[0] * age + wind[0], -(vy * dk + grav[1] * age + wind[1]))
    }
    const cs = Math.cos(rot), sn = Math.sin(rot)
    const hx = s * aspect, hy = s
    // 四隅(粒の中での位置)。flutter があれば、粒ごとの軸まわりに立体で回す(ひらひら)
    let ax = 1, ay = 0, cf = 1, sf = 0
    if (flutter) {
      const fa = rand01(seed, i, 14) * Math.PI * 2
      ax = Math.cos(fa); ay = Math.sin(fa)
      const th = (rand01(seed, i, 15) * 360 + flutter * age * (0.6 + 0.8 * rand01(seed, i, 16))) * D2R
      cf = Math.cos(th); sf = Math.sin(th)
    }
    for (let k = 0; k < 4; k++) {
      const lx = (k === 0 || k === 3 ? -hx : hx), ly = (k < 2 ? -hy : hy)
      let qx = lx * cs - ly * sn, qy = lx * sn + ly * cs, qz = 0
      if (flutter) {
        // 軸 (ax, ay, 0) まわりの回転(ロドリゲスの式)
        const d = qx * ax + qy * ay
        const px = d * ax, py = d * ay, rx = qx - px, ry = qy - py
        qx = px + rx * cf; qy = py + ry * cf; qz = (ax * ry - ay * rx) * sf
      }
      _p[k * 3] = x + qx; _p[k * 3 + 1] = y + qy; _p[k * 3 + 2] = z + qz
    }
    // 裏返ったときに少し暗くして、ひらひらが分かるようにする
    const shade = flutter ? 0.82 + 0.18 * Math.abs(cf) : 1
    const r = c[0] * a * shade, g = c[1] * a * shade, b = c[2] * a * shade
    if (sort) sort.push({ d: opt.depth(x, y, z), p: Float32Array.from(_p), r, g, b, a })
    else batch.push(_p, 0, 0, 1, 1, 0, 0, 1, 1, r, g, b, a)
  }
  for (let j = 0; j < nBurst; j++) one(-1 - j, 0)
  for (const b of bursts) for (let j = 0; j < b.cnt; j++) one(-1 - (b.bi + 1) * 1000003 - j, b.bt)
  // 上限を超えるときは新しい粒を優先
  for (let i = last - nCont + 1; i <= last; i++) one(i, i / rate)
  if (sort) {
    sort.sort((p, q) => q.d - p.d)
    for (const q of sort) batch.push(q.p, 0, 0, 1, 1, 0, 0, 1, 1, q.r, q.g, q.b, q.a)
  }
  batch.end()
  return batch.count
}
