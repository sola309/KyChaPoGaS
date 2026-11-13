// 粒子: 何コマ目を描いても同じ絵になるよう、粒ごとの生まれた時刻と乱数から位置を式で求める
// (前のコマの状態を持たない)。
import { evalProp, evalAll, rand01, num, vec, toColor, clamp } from './props.js'
import { makeCanvas } from './shape.js'

const D2R = Math.PI / 180
export const MAX_PARTICLES = 6000

// 粒の絵(白。色は頂点色で付ける)
export function spriteCanvas(kind) {
  const S = 64
  const [c, ctx] = makeCanvas(S, S)
  const h = S / 2
  if (kind === 'square') { ctx.fillStyle = '#fff'; ctx.fillRect(2, 2, S - 4, S - 4) }
  else if (kind === 'circle') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(h, h, h - 2, 0, Math.PI * 2); ctx.fill() }
  else if (kind === 'star' || kind === 'spark') {
    const n = kind === 'star' ? 5 : 4, inner = kind === 'star' ? 0.45 : 0.12
    ctx.fillStyle = '#fff'; ctx.beginPath()
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2, r = (h - 2) * (i % 2 ? inner : 1)
      ctx.lineTo(h + Math.cos(a) * r, h + Math.sin(a) * r)
    }
    ctx.closePath(); ctx.fill()
  } else {
    const g = ctx.createRadialGradient(h, h, 0, h, h, h)
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.75)')
    g.addColorStop(0.6, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S)
  }
  return c
}

const _p = new Float32Array(12)
const pair = (v, a, b) => (Array.isArray(v) ? [num(v[0], a), num(v[1] ?? v[0], b)] : typeof v === 'number' ? [v, v] : [a, b])

// def: レイヤーの定義。f: コマ。→ 積んだ粒の数
export function fillParticles(batch, def, f, fps) {
  const src = def.source || {}
  const E = src.emitter || {}
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
  const area = vec(e.area, 3, 0)
  const size = pair(e.size, 16, 0), sizeR = clamp(num(e.size_random, 0.3), 0, 1)
  const opac = pair(e.opacity, 100, 0)
  const colIsPair = Array.isArray(e.color) && (typeof e.color[0] === 'string' || Array.isArray(e.color[0]))
  const c0 = toColor(colIsPair ? e.color[0] : e.color, [1, 1, 1, 1]), c1 = colIsPair ? toColor(e.color[1], c0) : c0
  const spin = num(e.spin, 0), rotR = num(e.rotation_random, e.sprite === 'star' || e.sprite === 'square' ? 360 : 0)
  const fadeIn = clamp(num(e.fade_in, 0.08), 0, 0.5)
  if (t < 0) { batch.begin(0); batch.end(); return 0 }

  // いま生きている粒の番号の範囲。負の番号は最初の一斉放出(burst)
  const first = rate > 0 ? Math.max(0, Math.ceil((t - life) * rate - 1e-9)) : 0
  const last = rate > 0 ? Math.floor(t * rate + 1e-9) : -1
  const nCont = Math.max(0, Math.min(last - first + 1, MAX_PARTICLES))
  const nBurst = t < life ? Math.min(burst, MAX_PARTICLES) : 0
  batch.begin(nCont + nBurst)
  const posAnimated = E.position && typeof E.position === 'object' && !Array.isArray(E.position)
  const pos0 = vec(e.position, 3, 0)
  const emit = (i, born) => {
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
    const x = ep[0] + (rand01(seed, i, 5) - 0.5) * area[0] + vx * mv + grav[0] * g2
    const y = ep[1] + (rand01(seed, i, 6) - 0.5) * area[1] + vy * mv + grav[1] * g2
    const z = ep[2] + (rand01(seed, i, 7) - 0.5) * area[2] + vz * mv + grav[2] * g2
    const s = (size[0] + (size[1] - size[0]) * u) * (1 - sizeR * rand01(seed, i, 8)) * 0.5
    if (s <= 0.01) return
    let a = (opac[0] + (opac[1] - opac[0]) * u) / 100
    if (fadeIn > 0) a *= Math.min(1, u / fadeIn)
    a = clamp(a * (c0[3] + (c1[3] - c0[3]) * u), 0, 1)
    if (a <= 0.002) return
    const r = (c0[0] + (c1[0] - c0[0]) * u) * a, g = (c0[1] + (c1[1] - c0[1]) * u) * a, b = (c0[2] + (c1[2] - c0[2]) * u) * a
    const rot = ((rand01(seed, i, 9) - 0.5) * rotR + spin * age * (rand01(seed, i, 10) > 0.5 ? 1 : -1)) * D2R
    const cs = Math.cos(rot) * s, sn = Math.sin(rot) * s
    _p[0] = x - cs + sn; _p[1] = y - sn - cs; _p[2] = z
    _p[3] = x + cs + sn; _p[4] = y + sn - cs; _p[5] = z
    _p[6] = x + cs - sn; _p[7] = y + sn + cs; _p[8] = z
    _p[9] = x - cs - sn; _p[10] = y - sn + cs; _p[11] = z
    batch.push(_p, 0, 0, 1, 1, 0, 0, 1, 1, r, g, b, a)
  }
  for (let j = 0; j < nBurst; j++) emit(-1 - j, 0)
  // 上限を超えるときは新しい粒を優先
  for (let i = last - nCont + 1; i <= last; i++) emit(i, i / rate)
  batch.end()
  return batch.count
}
