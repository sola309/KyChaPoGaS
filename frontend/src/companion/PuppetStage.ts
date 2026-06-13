import { Application, Container, Sprite, Graphics, Assets, Matrix, type Texture } from 'pixi.js'

/**
 * PuppetStage — rig a See-Through layer decomposition into a living 2.5D puppet.
 *
 * Layers are full-frame (canvas-sized) transparent PNGs, pre-aligned, stacked in
 * z-order. Procedural motion is applied per-layer via composed pivot-matrices:
 *   body   → breathing (subtle vertical scale + bob)
 *   head   → sway + user head-turn (rotate around the neck pivot)
 *   eyes   → blink (vertical squash) + idle gaze, composed under head
 *   mouth  → lip-sync (vertical open) composed under head
 *   hair   → head motion + a delayed swing (parallax/momentum)
 *
 * update(t) is a pure function of time + params, so it can run live (ticker) or
 * be stepped deterministically for headless capture (window.__puppetSeek).
 */

export interface PuppetLayer { name: string; file: string; group: string; z: number; bbox: number[]; depth?: number }
export interface PuppetManifest {
  id: string; name: string; canvas: [number, number]
  pivots: Record<string, [number, number]>
  layers: PuppetLayer[]
}

export interface PuppetParams {
  headTurn: number   // -1..1  (left..right)
  headNod: number    // -1..1  (up..down)
  talk: number       // 0..1   talking intensity (drives mouth)
  expression: 'neutral' | 'smile' | 'angry' | 'surprised'
}

const TAU = Math.PI * 2

function rig(px: number, py: number, angle: number, sx: number, sy: number, dx: number, dy: number): Matrix {
  // PIXI matrix ops are left-multiply → result = T2·R·S·T1 (pivot transform)
  const m = new Matrix()
  m.translate(-px, -py)
  m.scale(sx, sy)
  m.rotate(angle)
  m.translate(px + dx, py + dy)
  return m
}

export class PuppetStage {
  app = new Application()
  root = new Container()
  private sprites: { sprite: Sprite; group: string; depth: number; name: string }[] = []
  private mouthCavity = new Graphics()
  private cw = 1280
  private ch = 1280
  private pivots: Record<string, [number, number]> = {}
  params: PuppetParams = { headTurn: 0, headNod: 0, talk: 0, expression: 'neutral' }
  /** external lip-sync drive (0..1) — audio amplitude → mouth open amount. */
  talkLevel = 0
  /** mouth width 0..1 from spectral tilt (front vowels い/え wide, う/お round). */
  mouthWide = 0.5
  private sMOpen = 0; private sMWide = 0.5
  // hair / skirt spring state (secondary motion)
  private lastT = 0; private lastHeadA = 0
  private hairAF = 0; private hairVF = 0
  private hairAB = 0; private hairVB = 0
  private skirtA = 0; private skirtV = 0
  // smoothed values
  private sTurn = 0; private sNod = 0; private sTalk = 0

  async init(canvas: HTMLCanvasElement, baseUrl: string, manifest: PuppetManifest) {
    await this.app.init({ canvas, width: canvas.width, height: canvas.height,
                          backgroundAlpha: 0, antialias: true })
    this.cw = manifest.canvas[0]; this.ch = manifest.canvas[1]
    this.pivots = manifest.pivots
    this.app.stage.addChild(this.root)

    // load + stack layers in z-order
    const ordered = [...manifest.layers].sort((a, b) => a.z - b.z)
    let mouthChildIndex = -1
    for (const ly of ordered) {
      const tex: Texture = await Assets.load(baseUrl + encodeURIComponent(ly.file))
      const s = new Sprite(tex)
      s.anchor.set(0, 0)
      this.root.addChild(s)
      this.sprites.push({ sprite: s, group: ly.group, depth: ly.depth ?? 0.5, name: ly.name })
      if (ly.group === 'mouth') mouthChildIndex = this.root.children.length - 1
    }
    // mouth cavity (procedural open-mouth) just above the closed-mouth sprite,
    // below front hair — so an opening mouth reveals a dark cavity.
    if (mouthChildIndex >= 0) this.root.addChildAt(this.mouthCavity, mouthChildIndex + 1)
    else this.root.addChild(this.mouthCavity)
    this.fit()

    // live ticker (capture path bypasses this via __puppetSeek)
    let t = 0
    this.app.ticker.add((tk) => { t += tk.deltaMS / 1000; this.update(t) })
    // headless-capture hooks
    const w = window as unknown as { __puppetSeek?: (s: number) => void; __puppetStage?: PuppetStage }
    w.__puppetSeek = (sec: number) => { this.update(sec); this.app.render() }
    w.__puppetStage = this
  }

  /** fit the 1280² puppet into the canvas (contain, anchored to bottom-centre) */
  private fit() {
    const cw = this.app.renderer.width, chh = this.app.renderer.height
    const scale = Math.min(cw / this.cw, chh / this.ch)
    this.root.scale.set(scale)
    this.root.position.set((cw - this.cw * scale) / 2, chh - this.ch * scale)
  }

  /** pure: compute all per-layer transforms for time t */
  update(t: number) {
    const p = this.params
    // ease params toward targets for smooth control
    this.sTurn += (p.headTurn - this.sTurn) * 0.12
    this.sNod  += (p.headNod  - this.sNod)  * 0.12
    this.sTalk += (p.talk     - this.sTalk) * 0.25

    const [hx, hy] = this.pivots.head  ?? [this.cw / 2, this.ch * 0.28]
    const [ex, ey] = this.pivots.eyes  ?? [this.cw / 2, this.ch * 0.19]
    const [mx, my] = this.pivots.mouth ?? [this.cw / 2, this.ch * 0.24]
    const [bx, by] = this.pivots.body  ?? [this.cw / 2, this.ch * 0.80]

    // ── breathing ──
    const br = Math.sin((t / 4) * TAU)
    const breathSY = 1 + 0.012 * br
    const bob = -2.2 * br                       // chest up → head rises

    // ── idle + head sway + user turn ──
    const swayA = 0.022 * Math.sin((t / 6) * TAU) + 0.012 * Math.sin((t / 3.7) * TAU)
    const headAngle = swayA + this.sTurn * 0.30
    const headDx = this.sTurn * 34 + 4 * Math.sin((t / 5) * TAU)
    const headDy = bob + this.sNod * 16

    // ── hair spring physics (secondary motion / momentum) ──
    // Hair lags the head with a damped spring → natural swing + overshoot.
    // Back hair is heavier (softer spring) than front.
    let dt = t - this.lastT
    if (!(dt > 0) || dt > 0.06) dt = 1 / 60
    this.lastT = t
    const headVel = (headAngle - this.lastHeadA) / dt
    this.lastHeadA = headAngle
    const spring = (x: number, v: number, target: number, k: number, c: number, drive: number) => {
      const acc = (target - x) * k - v * c + drive
      const nv = v + acc * dt
      return [x + nv * dt, nv] as [number, number]
    }
    ;[this.hairAF, this.hairVF] = spring(this.hairAF, this.hairVF, headAngle * 0.95, 140, 13, headVel * 0.5)
    ;[this.hairAB, this.hairVB] = spring(this.hairAB, this.hairVB, headAngle * 0.85, 70, 9, headVel * 0.6)
    ;[this.skirtA, this.skirtV] = spring(this.skirtA, this.skirtV, 0, 60, 8,
                                         (headVel + this.sTurn * 0.4) * 0.25 + 0.02 * Math.sin((t / 3.1) * TAU))

    // ── blink (deterministic ~3.3s, plus a double now and then) ──
    const blink = this.blinkSquash(t)

    // ── gaze saccade ──
    const gz = 6 * Math.sin((t / 7.3) * TAU) + (Math.sin(t * 1.7) > 0.97 ? 10 : 0)

    // ── mouth (lip-sync, viseme-ish) ──
    // Real audio amplitude (talkLevel) drives openness; spectral tilt (mouthWide)
    // shapes width. Falls back to a procedural envelope for push-to-talk.
    const rawOpen = this.talkLevel > 0.001
      ? this.talkLevel
      : this.sTalk * Math.abs(Math.sin(t * 9.5)) * (0.55 + 0.45 * Math.sin(t * 2.3))
    this.sMOpen += (rawOpen - this.sMOpen) * 0.45
    this.sMWide += (this.mouthWide - this.sMWide) * 0.3
    const talkEnv = this.sMOpen
    const mouthSY = 1 + 1.0 * talkEnv
    const mouthDy = 9 * talkEnv

    // ── expression offsets ──
    const expr = this.expr(p.expression)

    // ── idle whole-body sway on the root ──
    this.root.angle = 0
    const idleRot = 0.010 * Math.sin((t / 8) * TAU)
    const idleDx = 6 * Math.sin((t / 9) * TAU)
    // apply via root pivot (bottom centre) — re-fit position each frame
    this.fit()
    this.root.rotation = idleRot
    this.root.x += idleDx

    // ── matrices ──
    const mBody = rig(bx, by, 0, 1, breathSY, 0, bob * 0.5)
    const mHead = rig(hx, hy, headAngle, 1, 1, headDx, headDy)
    const mEyes = rig(ex, ey, 0, 1, blink * expr.eyeSY, gz + expr.gazeDx, expr.eyeDy)
    const mMouth = rig(mx, my, 0, 1 + expr.mouthSX * 0, mouthSY * expr.mouthSY, 0, mouthDy)
    // back hair driven by its spring (swings/overshoots the head)
    const mHairB = rig(hx, hy, this.hairAB + 0.03 * Math.sin((t / 5.5) * TAU), 1, 1,
                       this.hairAB * 60, 0)

    // depth-parallax on head turn (2.5D): nearer layers (low depth) shift more.
    // Uses See-Through per-layer pseudo-depth — gives head-turn a pseudo-3D feel.
    const PARALLAX = 70
    const parallax = (depth: number) =>
      rig(hx, hy, headAngle, 1, 1, headDx + (0.5 - depth) * this.sTurn * PARALLAX, headDy)

    // skirt: swing the hem around the waist (top of the bottomwear bbox)
    const skirtTop = by - 120
    const mSkirt = mBody.clone().append(rig(bx, skirtTop, this.skirtA, 1, 1, 0, 0))

    for (const { sprite, group, depth, name } of this.sprites) {
      let m: Matrix
      switch (group) {
        case 'body':      m = (name === 'bottomwear' || name === 'legwear') ? mSkirt : mBody; break
        case 'backhair':  m = mHairB; break
        case 'head':      m = parallax(depth); break
        case 'eyes':      m = parallax(depth).append(mEyes); break
        case 'mouth':     m = parallax(depth).append(mMouth); break
        case 'fronthair': m = rig(hx, hy, this.hairAF + 0.04 * Math.sin((t / 4.5) * TAU),
                                  1, 1, headDx * 1.1 + this.hairAF * 50 + (0.5 - depth) * this.sTurn * PARALLAX, headDy); break
        default:          m = mHead
      }
      sprite.setFromMatrix(m)
    }

    // ── procedural open-mouth cavity (viseme) ──
    const g = this.mouthCavity
    g.clear()
    if (talkEnv > 0.04) {
      const w = 26 * (0.55 + 0.9 * this.sMWide)    // 幅: 母音で変化
      const h = 30 * talkEnv                        // 高さ: 開き量
      g.ellipse(mx, my + h * 0.35, w, h).fill({ color: 0x3a0a12, alpha: 0.92 })  // 口腔（暗）
      g.ellipse(mx, my + h * 0.7, w * 0.7, h * 0.45).fill({ color: 0x7a1428, alpha: 0.7 })  // 舌
      g.ellipse(mx, my + h * 0.95, w * 0.95, h * 0.3).fill({ color: 0xe6b8be, alpha: 0.55 }) // 下唇
      g.setFromMatrix(parallax(0.4))   // 口と同じ深度で頭に追従
      g.visible = true
    } else {
      g.visible = false
    }
  }

  private blinkSquash(t: number): number {
    const period = 3.3
    const ph = t % period
    const dur = 0.13
    if (ph < dur) return 1 - Math.sin((ph / dur) * Math.PI) * 0.92
    // occasional double blink
    if (ph > 0.18 && ph < 0.18 + dur && (Math.floor(t / period) % 4 === 0))
      return 1 - Math.sin(((ph - 0.18) / dur) * Math.PI) * 0.92
    return 1
  }

  private expr(e: PuppetParams['expression']) {
    switch (e) {
      case 'smile':     return { eyeSY: 0.78, eyeDy: 2, gazeDx: 0, mouthSY: 1.25, mouthSX: 0.1 }
      case 'angry':     return { eyeSY: 0.92, eyeDy: -3, gazeDx: 0, mouthSY: 0.9, mouthSX: 0 }
      case 'surprised': return { eyeSY: 1.18, eyeDy: -4, gazeDx: 0, mouthSY: 1.5, mouthSX: 0 }
      default:          return { eyeSY: 1, eyeDy: 0, gazeDx: 0, mouthSY: 1, mouthSX: 0 }
    }
  }

  destroy() {
    try { this.app.destroy(true, { children: true }) } catch { /* noop */ }
  }
}
