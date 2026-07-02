import { Application, Container, Sprite, Graphics, MeshPlane, Assets, Matrix, Texture } from 'pixi.js'

/**
 * PuppetStage — rig a See-Through layer decomposition into a living 2.5D puppet.
 *
 * Layers are full-frame (canvas-sized) transparent PNGs, pre-aligned, stacked in
 * z-order. With a v2 manifest (Rig Compiler / "Semantic Canonical Rig") it also
 * gets: pupil-only gaze masked to the sclera, a real skin eyelid that closes on
 * blink, a viseme mouth, and per-feature expression transforms (brows now move).
 * Falls back to the v1 behaviour (eye-squash blink, whole-eye gaze) when a puppet
 * has no `rig` metadata.
 *
 * update(t) is a pure function of time + params, so it can run live (ticker) or
 * be stepped deterministically for headless capture (window.__puppetSeek).
 */

export interface SwayInfo { type: 'hair' | 'cloth' | 'neck'; pin: 'head' | 'body' | ''; amp: number }
export interface PuppetLayer { name: string; file: string; group: string; z: number; bbox: number[]; depth?: number; sway?: SwayInfo }
type Pt = [number, number]
export interface RigMeta {
  unit?: number        // character extent (canvas px) — motion is scaled to this
  skinColor: string
  eye: { region: number[] | null; left: Pt | null; right: Pt | null; sclera: string | null; pupil: string | null }
  mouth: { region: number[]; center: Pt; left: Pt; right: Pt } | null
  brow: { left: Pt; right: Pt } | null
  cheek: { left: Pt; right: Pt } | null
  meshGroups: string[]
}
export interface PuppetManifest {
  id: string; name: string; canvas: [number, number]
  pivots: Record<string, [number, number]>
  layers: PuppetLayer[]
  version?: number
  rig?: RigMeta
}

export type Expression = 'neutral' | 'smile' | 'angry' | 'surprised' | 'sad' | 'smug' | 'shy'

export interface PuppetParams {
  headTurn: number   // -1..1  (left..right)
  headNod: number    // -1..1  (up..down)
  talk: number       // 0..1   talking intensity (drives mouth)
  expression: Expression
}

const TAU = Math.PI * 2
const IDENTITY = new Matrix()   // for meshes whose vertices are already root-local
// motion constants are tuned for this character extent (px); every puppet's motion
// is scaled by its own measured extent ÷ this, so framing/resolution don't matter.
const UNIT_REF = 1190
// Max yaw angle (rad) at slider ±1. Kept deliberately SMALL: a flat single-image head
// can't truly yaw, so we only hint at it (gentle cylinder parallax) — small + never
// broken beats large + uncanny. Raise later if a face-splitting pipeline lands.
const YAW_MAX = 0.30

function rig(px: number, py: number, angle: number, sx: number, sy: number, dx: number, dy: number): Matrix {
  // PIXI matrix ops are left-multiply → result = T2·R·S·T1 (pivot transform)
  const m = new Matrix()
  m.translate(-px, -py)
  m.scale(sx, sy)
  m.rotate(angle)
  m.translate(px + dx, py + dy)
  return m
}

interface MeshData {
  geom: { positions: Float32Array; getBuffer: (id: string) => { update: () => void } }
  base: Float32Array; h: number; vx: number; vy: number
  verlet?: { cur: Float32Array; prev: Float32Array; init: boolean }
}
interface SpriteEntry {
  sprite: Container; group: string; depth: number; name: string
  bbox?: number[]   // [l,t,r,b] in texture space (for the neck joint blend)
  sway?: SwayInfo   // hair / cloth / neck classification from the rig compiler
  mesh?: MeshData
}

export class PuppetStage {
  app = new Application()
  root = new Container()
  private sprites: SpriteEntry[] = []
  private mouthCavity = new Graphics()
  private cw = 1280
  private ch = 1280
  private S = 1         // motion scale = character extent (this puppet) ÷ UNIT_REF
  private mouthW = 60   // mouth layer width (texture px) — scales the viseme cavity
  private headR = 200   // cylinder radius for yaw = face half-width / sin(edge) (texture px)
  private faceL = 1e9; private faceR = -1e9   // face x-extent accumulator (init)
  private yawPhi = 0    // current yaw angle (rad), set each frame
  private yawCx = 0     // yaw axis x in root space, set each frame
  private pivots: Record<string, [number, number]> = {}
  params: PuppetParams = { headTurn: 0, headNod: 0, talk: 0, expression: 'neutral' }
  /** external lip-sync drive (0..1) — audio amplitude → mouth open amount. */
  talkLevel = 0
  /** mouth width 0..1 from spectral tilt (front vowels い/え wide, う/お round). */
  mouthWide = 0.5
  private sMOpen = 0; private sMWide = 0.5
  private lastT = 0
  // smoothed values
  private sTurn = 0; private sNod = 0; private sTalk = 0
  // look-at-user (pointer/touch tracking) — targets in -1..1, smoothed
  private lookXT = 0; private lookYT = 0
  private sLookX = 0; private sLookY = 0
  /** while true the character glances aside as if thinking (LLM is replying). */
  thinking = false
  // poke/tap reaction — damped recoil spring + a transient surprised face
  private pokeX = 0; private pokeV = 0
  private transientExpr: Expression = 'surprised'; private transientT = 0
  // expression intensity — ramps to 1 when set, then relaxes toward a floor
  private exprI = 0; private lastExpr: Expression = 'neutral'
  // emphasis nods while speaking (driven by talk envelope onset)
  private emph = 0; private lastTalkEnv = 0
  // user view transform — zoom (×base-fit) and pan (renderer px) so the user can
  // enlarge/move the model (esp. on phones where a full body is tiny).
  private viewZoom = 1; private viewPanX = 0; private viewPanY = 0
  // pointer state: distinguish hover(gaze) / drag(pan) / pinch(zoom) / tap(poke)
  private ptrs = new Map<number, { x: number; y: number }>()
  private dragging = false; private movedPx = 0
  private pinchDist = 0

  /** Point the gaze/head at a normalized canvas position (-1..1, +x right, +y down). */
  setLook(x: number, y: number) {
    this.lookXT = Math.max(-1, Math.min(1, x))
    this.lookYT = Math.max(-1, Math.min(1, y))
  }
  /** Stop tracking — gaze eases back to idle. */
  clearLook() { this.lookXT = 0; this.lookYT = 0 }
  /** Poke reaction — recoil + a brief surprised expression. */
  poke() { this.pokeV += 6.5; this.transientExpr = 'surprised'; this.transientT = 0.85 }

  /** the renderer's own canvas (created in init, appended to the host element). */
  get canvas(): HTMLCanvasElement { return this.app.canvas as HTMLCanvasElement }

  async init(host: HTMLElement, baseUrl: string, manifest: PuppetManifest) {
    const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 820
    const maxTex = mobile ? 768 : 0
    // Each stage owns a FRESH canvas (Pixi creates it). Switching puppets destroys
    // this canvas and the next stage makes its own — avoids re-initialising WebGL on
    // a shared/destroyed canvas, which froze the page on puppet switch.
    await this.app.init({ width: 540, height: 760,
                          backgroundAlpha: 0, antialias: !mobile,
                          resolution: Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 2) })
    const cv = this.app.canvas as HTMLCanvasElement
    cv.style.maxHeight = '100%'; cv.style.maxWidth = '100%'
    cv.style.touchAction = 'none'; cv.style.cursor = 'grab'
    host.appendChild(cv)
    this.bindViewControls(cv)
    this.app.ticker.maxFPS = mobile ? 30 : 60

    const texScale = maxTex && manifest.canvas[0] > maxTex ? maxTex / manifest.canvas[0] : 1
    // motion scale from the MEASURED character extent (not the canvas) → identical
    // proportions whatever the source image size or how the character is framed.
    const unit = (manifest.rig?.unit ?? manifest.canvas[1] * 0.93) * texScale
    this.S = unit / UNIT_REF
    this.cw = manifest.canvas[0] * texScale
    this.ch = manifest.canvas[1] * texScale
    this.pivots = Object.fromEntries(Object.entries(manifest.pivots)
      .map(([k, [x, y]]) => [k, [x * texScale, y * texScale]])) as Record<string, [number, number]>
    this.app.stage.addChild(this.root)

    const loadTex = async (url: string): Promise<Texture> => {
      const base: Texture = await Assets.load(url)
      if (texScale === 1 || base.width <= maxTex) return base
      const src = base.source.resource as CanvasImageSource
      const cv = document.createElement('canvas')
      cv.width = Math.round(base.width * texScale); cv.height = Math.round(base.height * texScale)
      cv.getContext('2d')!.drawImage(src, 0, 0, cv.width, cv.height)
      return Texture.from(cv)
    }

    const ordered = [...manifest.layers].sort((a, b) => a.z - b.z)
    let mouthChildIndex = -1
    for (const ly of ordered) {
      const tex: Texture = await loadTex(baseUrl + encodeURIComponent(ly.file))
      const entry: SpriteEntry = { sprite: new Sprite(tex), group: ly.group, depth: ly.depth ?? 0.5, name: ly.name }
      if (ly.bbox) entry.bbox = ly.bbox.map(v => v * texScale)
      // sway classification comes from the rig compiler; fall back to names for
      // older manifests so any puppet still rigs sensibly.
      entry.sway = ly.sway ?? this.fallbackSway(ly.name, ly.group)
      // face groups accumulate the x-extent → cylinder radius for the yaw warp
      const onFace = ly.group === 'head' || ly.group === 'eyes' || ly.group === 'mouth'
      if (onFace && entry.bbox) {
        this.faceL = Math.min(this.faceL, entry.bbox[0])
        this.faceR = Math.max(this.faceR, entry.bbox[2])
      }
      // Meshes: hair (tip-sway), neck (body→head joint blend), cloth (skirt/cape),
      // AND every face part (head/eyes/mouth) so the head can be cylinder-warped for
      // a real yaw (see yawMapX). Only body/clothing stay as plain rigid sprites.
      const st = entry.sway?.type
      const isFaceMesh = onFace && !st
      if (st === 'hair' || st === 'cloth' || st === 'neck' || isFaceMesh) {
        const vx = st === 'neck' ? 6 : st === 'cloth' ? 10 : isFaceMesh ? 12 : 8
        const vy = st === 'neck' ? 12 : isFaceMesh ? 12 : 14
        const mesh = new MeshPlane({ texture: tex, verticesX: vx, verticesY: vy })
        const geom = mesh.geometry as unknown as MeshData['geom']
        entry.sprite = mesh
        entry.mesh = { geom, base: Float32Array.from(geom.positions), h: tex.height, vx, vy }
      } else {
        (entry.sprite as Sprite).anchor.set(0, 0)
      }
      this.root.addChild(entry.sprite)
      this.sprites.push(entry)
      if (ly.group === 'mouth') {
        mouthChildIndex = this.root.children.length - 1
        if (entry.bbox) this.mouthW = Math.max(12, entry.bbox[2] - entry.bbox[0])
      }
    }

    // Cylinder radius for the yaw warp: a touch wider than the face half-width so the
    // face edges sit inside the cylinder (finite slope → no pinch) and warp ASYMMETRICALLY
    // (near cheek bulges, far cheek recedes) instead of just shrinking.
    const fhw = this.faceR > this.faceL ? (this.faceR - this.faceL) / 2 : this.ch * 0.13
    this.headR = fhw / 0.92

    // mouth cavity just above the closed-mouth sprite
    if (mouthChildIndex >= 0) this.root.addChildAt(this.mouthCavity, mouthChildIndex + 1)
    else this.root.addChild(this.mouthCavity)
    this.fit()

    let t = 0
    this.app.ticker.add((tk) => { t += tk.deltaMS / 1000; this.update(t) })
    this.onVis = () => { if (document.hidden) this.app.ticker.stop(); else this.app.ticker.start() }
    document.addEventListener('visibilitychange', this.onVis)

    const w = window as unknown as { __puppetSeek?: (s: number) => void; __puppetStage?: PuppetStage }
    w.__puppetSeek = (sec: number) => { this.update(sec); this.app.render() }
    w.__puppetStage = this
  }

  private onVis?: () => void

  /** renderer-px per CSS-px (DPR×Pixi resolution) — pointer deltas are in CSS px. */
  private get viewRes(): number {
    const cssW = this.canvas.clientWidth || this.app.renderer.width
    return this.app.renderer.width / cssW
  }
  private baseFit(): number {
    return Math.min(this.app.renderer.width / this.cw, this.app.renderer.height / this.ch)
  }

  private fit() {
    const cw = this.app.renderer.width, chh = this.app.renderer.height
    const scale = this.baseFit() * this.viewZoom
    this.root.scale.set(scale)
    this.root.position.set((cw - this.cw * scale) / 2 + this.viewPanX,
                           chh - this.ch * scale + this.viewPanY)
  }

  // ── user view controls (zoom / pan) ────────────────────────────────────────
  /** Zoom by `factor` about a CSS-space anchor (default canvas center), keeping the
   *  anchored content point fixed on screen. */
  zoomAt(factor: number, cssX?: number, cssY?: number) {
    const cw = this.app.renderer.width, chh = this.app.renderer.height
    const res = this.viewRes
    const ax = cssX == null ? cw / 2 : cssX * res
    const ay = cssY == null ? chh / 2 : cssY * res
    const s0 = this.baseFit() * this.viewZoom
    const x0 = (cw - this.cw * s0) / 2 + this.viewPanX
    const y0 = chh - this.ch * s0 + this.viewPanY
    const lx = (ax - x0) / s0, ly = (ay - y0) / s0
    this.viewZoom = Math.max(0.7, Math.min(6, this.viewZoom * factor))
    const s1 = this.baseFit() * this.viewZoom
    this.viewPanX = ax - s1 * lx - (cw - this.cw * s1) / 2
    this.viewPanY = ay - s1 * ly - (chh - this.ch * s1)
    this.clampPan(); this.fit(); this.app.render()
  }
  /** Pan by a CSS-space delta. */
  panBy(cssDx: number, cssDy: number) {
    const res = this.viewRes
    this.viewPanX += cssDx * res; this.viewPanY += cssDy * res
    this.clampPan(); this.fit(); this.app.render()
  }
  /** Reset zoom/pan to the default fit. */
  resetView() { this.viewZoom = 1; this.viewPanX = 0; this.viewPanY = 0; this.fit(); this.app.render() }
  zoomIn() { this.zoomAt(1.25) }
  zoomOut() { this.zoomAt(1 / 1.25) }
  /** keep at least part of the model on screen (loose clamp). */
  private clampPan() {
    const cw = this.app.renderer.width, chh = this.app.renderer.height
    const s = this.baseFit() * this.viewZoom
    const w = this.cw * s, h = this.ch * s
    const mx = Math.max(cw * 0.4, w * 0.5), my = Math.max(chh * 0.4, h * 0.5)
    const baseX = (cw - w) / 2, baseY = chh - h
    this.viewPanX = Math.max(-baseX - mx, Math.min(cw - baseX - w + mx, this.viewPanX))
    this.viewPanY = Math.max(-baseY - my, Math.min(chh - baseY - h + my, this.viewPanY))
  }

  /** Attach wheel/drag/pinch view controls + hover-gaze to the canvas. */
  private bindViewControls(cv: HTMLCanvasElement) {
    cv.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.offsetX, e.offsetY)
    }, { passive: false })
    cv.addEventListener('dblclick', () => this.resetView())
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture?.(e.pointerId)
      this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
      this.movedPx = 0
      if (this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()]
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
      } else {
        this.dragging = true
      }
    })
    cv.addEventListener('pointermove', (e) => {
      const prev = this.ptrs.get(e.pointerId)
      if (this.ptrs.size === 2 && prev) {
        // pinch-zoom about the midpoint
        this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const [a, b] = [...this.ptrs.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (this.pinchDist > 0) {
          const rect = cv.getBoundingClientRect()
          this.zoomAt(d / this.pinchDist, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top)
        }
        this.pinchDist = d
        return
      }
      if (this.dragging && prev) {
        const dx = e.clientX - prev.x, dy = e.clientY - prev.y
        this.movedPx += Math.abs(dx) + Math.abs(dy)
        this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
        this.panBy(dx, dy)
        return
      }
      // hover → gaze
      const rect = cv.getBoundingClientRect()
      this.setLook(((e.clientX - rect.left) / rect.width) * 2 - 1,
                   ((e.clientY - rect.top) / rect.height) * 2 - 1)
    })
    const end = (e: PointerEvent) => {
      const wasTap = this.dragging && this.movedPx < 6
      this.ptrs.delete(e.pointerId)
      if (this.ptrs.size < 2) this.pinchDist = 0
      if (this.ptrs.size === 0) { this.dragging = false; if (wasTap) this.poke() }
    }
    cv.addEventListener('pointerup', end)
    cv.addEventListener('pointercancel', end)
    cv.addEventListener('pointerleave', () => { if (!this.dragging) this.clearLook() })
  }

  /** pure: compute all per-layer transforms for time t */
  update(t: number) {
    const p = this.params
    this.sTurn += (p.headTurn - this.sTurn) * 0.12
    this.sNod  += (p.headNod  - this.sNod)  * 0.12
    this.sTalk += (p.talk     - this.sTalk) * 0.25

    const lxT = this.thinking ? 0.42 + 0.12 * Math.sin(t * 1.3) : this.lookXT
    const lyT = this.thinking ? -0.5 : this.lookYT
    this.sLookX += (lxT - this.sLookX) * (this.thinking ? 0.05 : 0.09)
    this.sLookY += (lyT - this.sLookY) * (this.thinking ? 0.05 : 0.09)

    const S = this.S   // character-relative motion scale (resolution/framing-independent)
    const [hx, hy] = this.pivots.head  ?? [this.cw / 2, this.ch * 0.28]
    const [ex, ey] = this.pivots.eyes  ?? [this.cw / 2, this.ch * 0.19]
    const [mx, my] = this.pivots.mouth ?? [this.cw / 2, this.ch * 0.24]
    const [bx, by] = this.pivots.body  ?? [this.cw / 2, this.ch * 0.80]

    const br = Math.sin((t / 4) * TAU)
    const breathSY = 1 + 0.012 * br
    const bob = -2.2 * S * br

    const swayA = 0.022 * Math.sin((t / 6) * TAU) + 0.012 * Math.sin((t / 3.7) * TAU)
    // Head turn (yaw) is NOT done here — a roll/squash on a flat head reads as a tilt
    // or "getting thin". The real turn is a cylindrical per-vertex warp applied below
    // (yawPhi/yawMapX). headAngle carries only idle bob + a hair-thin gaze roll.
    let headAngle = swayA + this.sLookX * 0.08
    let headDx = (4 * Math.sin((t / 5) * TAU) + this.sLookX * 10) * S
    let headDy = bob + this.sNod * 16 * S + this.sLookY * 12 * S

    let dt = t - this.lastT
    if (!(dt > 0) || dt > 0.06) dt = 1 / 60
    this.lastT = t
    this.pokeV += (-this.pokeX * 120 - this.pokeV * 11) * dt
    this.pokeX += this.pokeV * dt
    if (this.transientT > 0) this.transientT -= dt
    headAngle += this.pokeX * 0.06
    headDx += this.pokeX * 26 * S
    headDy -= Math.abs(this.pokeX) * 8 * S
    // ── ambient wind (shared fBm-ish field): a low-freq gust + flutter, so hair &
    // cloth keep swaying even when the head/body is still. Same field drives all
    // secondary motion (hair + skirt) so it moves coherently.
    const wind = 0.55 * Math.sin(t * 0.31) + 0.3 * Math.sin(t * 0.74 + 1.3)
               + 0.15 * Math.sin(t * 1.9 + 2.7)   // ≈ [-1, 1]

    const blinkCl = this.blinkClose(t)        // 0 (open) .. 1 (closed)

    // gaze drives the pupils only; idle saccade keeps the eyes alive
    const saccade = 6 * Math.sin((t / 7.3) * TAU) + (Math.sin(t * 1.7) > 0.97 ? 10 : 0)
    const lookEyeDy = this.sLookY * 9 * S

    // ── mouth open envelope ──
    const rawOpen = this.talkLevel > 0.001
      ? this.talkLevel
      : this.sTalk * Math.abs(Math.sin(t * 9.5)) * (0.55 + 0.45 * Math.sin(t * 2.3))
    this.sMOpen += (rawOpen - this.sMOpen) * 0.45
    this.sMWide += (this.mouthWide - this.sMWide) * 0.3
    const talkEnv = this.sMOpen
    const mouthSY = 1 + 0.45 * talkEnv          // closed-mouth sprite opens modestly
    const mouthDy = 4 * S * talkEnv

    const talkOnset = Math.max(0, talkEnv - this.lastTalkEnv)
    this.lastTalkEnv = talkEnv
    this.emph = this.emph * 0.88 + talkOnset * 5
    headDy += this.emph * 4 * S
    headAngle += this.emph * 0.012

    const active: Expression = this.transientT > 0 ? this.transientExpr : p.expression
    if (active !== this.lastExpr) { this.exprI = 1; this.lastExpr = active }
    const floor = active === 'neutral' ? 0 : 0.45
    this.exprI += (floor - this.exprI) * 0.012
    const expr = this.expr(active, this.exprI)

    this.root.angle = 0
    const idleRot = 0.010 * Math.sin((t / 8) * TAU)
    const idleDx = 6 * Math.sin((t / 9) * TAU)
    this.fit()
    this.root.rotation = idleRot
    this.root.x += idleDx

    // body follows the head (turn + gaze) so the head doesn't pivot on a frozen
    // torso — the shoulders/collar rotate & shift toward the turn, selling the join.
    // The torso must NOT roll with a head turn (that's what made the whole figure
    // look tilted/leaning). Shoulders only shift a little toward the turn so the
    // collar follows; the neck bend does the rest of the join.
    const leanRot = this.sLookX * 0.018 + 0.004 * Math.sin((t / 7) * TAU)
    const leanDx = (this.sLookX * 6 + this.sTurn * 7) * S
    const mBody = rig(bx, by, leanRot, 1, breathSY, leanDx, bob * 0.5)
    // ── head yaw via cylinder warp ────────────────────────────────────────────
    // The base head transform carries NO turn (idle bob + translate only). The turn
    // is a per-vertex cylindrical remap applied AFTER this affine (see yawMapX), so
    // the face genuinely rotates: central features parallax ahead of the outline and
    // the near/far cheeks warp asymmetrically. Same field for every head layer →
    // zero inter-layer drift. yawCx tracks the slide so the axis stays on the face.
    this.yawPhi = this.sTurn * YAW_MAX
    this.yawCx = hx + headDx
    const mHead = rig(hx, hy, headAngle, 1, 1, headDx, headDy)
    const eyeDy = expr.eyeDy * S
    // Blink + squint by vertically squashing the WHOLE eye group (sclera, lashes
    // and iris together) around the eye pivot — the classic anime close. No skin
    // overlay, so no rectangular "frame" at the lids. Brows are NOT squashed.
    const eyeClose = Math.max(blinkCl, expr.lidClose)   // 0 open .. 1 closed
    const eyeSY = Math.max(0.06, 1 - eyeClose * 0.94)
    const mEyes = rig(ex, ey, 0, 1, eyeSY, 0, eyeDy + lookEyeDy)
    // brows ride with the eyes plus expression raise/tilt (#6 — now visible after z-fix)
    const mBrow = rig(ex, ey, expr.browRot, 1, 1, 0, eyeDy + expr.browDy * S)
    const mMouth = rig(mx, my, 0, 1 + expr.mouthSX, mouthSY * expr.mouthSY, 0, mouthDy)

    // pupils: a small CLAMPED offset within the sclera (gaze + look + expression
    // aside), sharing the eye's vertical position. Clamped so the iris never
    // slides off the white — no mask needed (mask mis-clipped on big poses).
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v))
    const pupX = clamp((saccade * 0.6 + this.sLookX * 7 + expr.gazeDx), 7) * S
    const pupY = eyeDy + clamp(this.sLookY * 5, 4) * S
    const mPupil = rig(ex, ey, 0, 1, eyeSY, pupX, pupY)   // iris squashes with the eye

    // Sway pieces (auto-classified by the rig compiler) get physics; everything
    // else is rigid. ALL head-attached rigid parts share ONE head transform (mHead)
    // so their connected roots never drift apart on a turn.
    for (const entry of this.sprites) {
      const { sprite, group, name, mesh, sway } = entry
      if (sway && mesh) {
        const pinM = sway.pin === 'body' ? mBody : mHead
        if (sway.type === 'neck' && entry.bbox) {
          // body's displacement of the neck base (breathing/lean) — the neck bottom rides it
          const nbdx = mBody.a * hx + mBody.c * hy + mBody.tx - hx
          const nbdy = mBody.b * hx + mBody.d * hy + mBody.ty - hy
          this.warpNeck(entry, hx, hy, headAngle, headDx, headDy, nbdx, nbdy)
          sprite.setFromMatrix(IDENTITY); continue
        }
        if (sway.type === 'hair') {                       // tip-sway (row-weighted)
          // front hair rides on the face → full yaw; back hair sits behind → partial.
          this.verletHair(mesh, pinM, t, S, wind, sway.amp, undefined, group === 'backhair' ? 0.55 : 1)
          sprite.setFromMatrix(IDENTITY); continue
        }
        if (sway.type === 'cloth') {                      // hem-sway (bbox-weighted)
          this.verletHair(mesh, pinM, t, S, wind, sway.amp, entry.bbox)
          sprite.setFromMatrix(IDENTITY); continue
        }
      }
      // Face meshes: apply the part affine, then the shared cylinder yaw, per-vertex.
      if (mesh && (group === 'head' || group === 'eyes' || group === 'mouth')) {
        let m: Matrix
        if (group === 'eyes') {
          if (name === 'eyebrow')      m = mHead.clone().append(mBrow)
          else if (name === 'irides')  m = mHead.clone().append(mPupil)
          else                         m = mHead.clone().append(mEyes)
        } else if (group === 'mouth') { m = mHead.clone().append(mMouth) }
        else                          { m = mHead }
        this.warpFace(mesh, m)
        sprite.setFromMatrix(IDENTITY); continue
      }
      // Plain rigid sprites (body / clothing / un-meshed fallback head parts).
      let m: Matrix
      switch (group) {
        case 'head':  m = mHead; break
        case 'eyes':
          if (name === 'eyebrow')      m = mHead.clone().append(mBrow)
          else if (name === 'irides')  m = mHead.clone().append(mPupil)
          else                         m = mHead.clone().append(mEyes)
          break
        case 'mouth': m = mHead.clone().append(mMouth); break
        case 'fronthair': case 'backhair': m = mHead; break   // (only if un-meshed fallback)
        default:      m = mBody                                 // body / clothing / etc.
      }
      sprite.setFromMatrix(m)
    }

    this.drawMouthCavity(talkEnv, mx, my, mHead)
  }

  /** Viseme mouth cavity — scaled to the character's actual mouth width so a small
   * mouth opens a small amount (never past the chin). openness×width×roundness. */
  private drawMouthCavity(talkEnv: number, mx: number, my: number, headM: Matrix) {
    const g = this.mouthCavity
    g.clear()
    if (talkEnv <= 0.05) { g.visible = false; return }
    const mw = this.mouthW                          // actual mouth width (texture px)
    const wide = this.sMWide                        // 0 (round う/お) .. 1 (wide い/え)
    const w = mw * (0.30 + 0.22 * wide)             // half-width of the opening
    const h = mw * 0.34 * talkEnv * (1.1 - 0.4 * wide)   // open height, capped to mouth size
    const cy = my + h * 0.45                         // opens downward from the lips
    g.ellipse(mx, cy, w, h).fill({ color: 0x36090f, alpha: 0.94 })                            // dark cavity
    g.rect(mx - w * 0.9, cy - h * 0.92, w * 1.8, h * 0.32).fill({ color: 0xf2ece9, alpha: 0.5 * Math.min(1, talkEnv * 2) })   // upper teeth
    g.ellipse(mx, cy + h * 0.4, w * 0.7, h * 0.45).fill({ color: 0x7a1c2c, alpha: 0.7 })       // tongue
    // place via the head affine, then slide by the cylinder yaw at the mouth's x so the
    // cavity tracks the lips as the face turns.
    const wx = headM.a * mx + headM.c * my + headM.tx
    g.setFromMatrix(headM.clone().translate(this.yawMapX(wx) - wx, 0))
    g.visible = true
  }

  /** name-based sway fallback for older manifests without compiler classification. */
  private fallbackSway(name: string, group: string): SwayInfo | undefined {
    if (name === 'neck') return { type: 'neck', pin: '', amp: 0 }
    if (group === 'backhair') return { type: 'hair', pin: 'head', amp: 1 }
    if (group === 'fronthair') return { type: 'hair', pin: 'head', amp: 0.32 }
    if (name === 'bottomwear') return { type: 'cloth', pin: 'body', amp: 0.42 }
    return undefined
  }

  /** Neck joint: blend each vertex from the body transform (bottom, welded to the
   * shoulders) to the head transform (top), so the neck stretches/bends to follow
   * a turning head without a gap. Vertices end in root-local space → IDENTITY. */
  private warpNeck(entry: SpriteEntry, hx: number, hy: number,
                   ang: number, hdx: number, hdy: number, bdx: number, bdy: number) {
    const { geom, base } = entry.mesh!
    const bb = entry.bbox!
    const pos = geom.positions
    const top = bb[1], bot = bb[3], span = Math.max(1, bot - top)
    for (let i = 0; i < pos.length; i += 2) {
      const x = base[i], y = base[i + 1]
      let w = (bot - y) / span            // 1 at neck top (head) .. 0 at bottom (body)
      w = w < 0 ? 0 : w > 1 ? 1 : w
      w = w * w * (3 - 2 * w)             // smoothstep
      // BEND: rotate the vertex around the neck base by the head angle × w — the
      // base stays vertical, the top reaches the full head angle (smooth, no fold).
      const a = ang * w, ca = Math.cos(a), sa = Math.sin(a)
      const dx = x - hx, dy = y - hy
      const rx = hx + dx * ca - dy * sa
      const ry = hy + dx * sa + dy * ca
      // SHIFT: bottom rides the body's motion (breathing/lean), top the head's.
      let nx = rx + bdx + (hdx - bdx) * w
      const ny = ry + bdy + (hdy - bdy) * w
      // top of the neck follows the head's cylinder yaw (blends to 0 at the body)
      nx += (this.yawMapX(nx) - nx) * w
      pos[i] = nx
      pos[i + 1] = ny
    }
    geom.getBuffer('aPosition').update()
  }

  /** Map a root-space x through the head's cylinder yaw: the face is treated as the
   * front of a vertical cylinder of radius headR; rotating it by yawPhi moves a point
   * at offset xl to xl·cosφ + √(R²−xl²)·sinφ. Central features parallax ahead of the
   * outline (→ reads as a real turn); near/far cheeks warp asymmetrically. y is
   * unchanged (pure yaw). Same field for every head layer → no inter-layer drift. */
  private yawMapX(x: number): number {
    const phi = this.yawPhi
    if (phi === 0) return x
    const R = this.headR, xl = x - this.yawCx
    const u = Math.max(-1, Math.min(1, xl / R))
    return this.yawCx + xl * Math.cos(phi) + R * Math.sqrt(1 - u * u) * Math.sin(phi)
  }

  /** A face part: apply its affine (head translate + per-part expression), then the
   * shared cylinder yaw, per vertex. Vertices end in root-local space → IDENTITY. */
  private warpFace(mesh: MeshData, m: Matrix) {
    const { geom, base } = mesh
    const pos = geom.positions
    const a = m.a, b = m.b, c = m.c, d = m.d, e = m.tx, f = m.ty
    for (let i = 0; i < pos.length; i += 2) {
      const wx = a * base[i] + c * base[i + 1] + e
      pos[i] = this.yawMapX(wx)
      pos[i + 1] = b * base[i] + d * base[i + 1] + f
    }
    geom.getBuffer('aPosition').update()
  }

  /** Hair flow: each vertex eases (first-order, NO spring → never jitters) toward
   * its drawn position on the head plus a wind-bend, a slow flutter and a per-strand
   * travelling-wave ripple — all growing toward the tips. Smooth (no jelly) but the
   * long length and tips genuinely flow. Top ~10% stays rigid on the head. */
  private verletHair(mesh: MeshData, headM: Matrix, t: number, S: number, wind: number, amp = 1, bbox?: number[], yawAmt = 0) {
    const { base, vx, vy, geom } = mesh
    const pos = geom.positions
    const a = headM.a, b = headM.b, c = headM.c, d = headM.d, e = headM.tx, f = headM.ty
    let st = mesh.verlet
    if (!st) st = mesh.verlet = { cur: new Float32Array(pos.length), prev: new Float32Array(pos.length), init: false }
    const { cur } = st
    if (!st.init) {
      for (let i = 0; i < pos.length; i += 2) {
        cur[i] = a * base[i] + c * base[i + 1] + e
        cur[i + 1] = b * base[i] + d * base[i + 1] + f
      }
      st.init = true
    }
    // root→tip weight: by row for hair, or by Y within the bbox for cloth (so the
    // skirt waist is rigid and only the hem flares, regardless of where it sits).
    const bTop = bbox ? bbox[1] : 0, bSpan = bbox ? Math.max(1, bbox[3] - bbox[1]) : 1
    const flutter = Math.sin(t * 1.3) * 14
    for (let row = 0; row < vy; row++) {
      const tip = bbox
        ? Math.min(1, Math.max(0, (base[(row * vx) * 2 + 1] - bTop) / bSpan))
        : row / (vy - 1)
      const sw = Math.max(0, (tip - 0.1) / 0.9)
      const swing = sw * sw * (3 - 2 * sw) * amp      // smoothstep: most of the length sways (amp: bangs gentler)
      const windBend = (wind * 52 + flutter) * S * swing   // bulk sway + slow flutter
      const gravBend = 13 * S * swing                 // droop
      const follow = 0.5 - 0.18 * tip                 // tips ease a touch slower → trailing lag
      for (let col = 0; col < vx; col++) {
        const i = (row * vx + col) * 2
        const wave = Math.sin(base[i + 1] * 0.02 - t * 2.4 + col * 0.6) * 5 * S * swing  // strand ripple
        const tgx = a * base[i] + c * base[i + 1] + e + windBend + wave
        const tgy = b * base[i] + d * base[i + 1] + f + gravBend
        cur[i] += (tgx - cur[i]) * follow
        cur[i + 1] += (tgy - cur[i + 1]) * follow
      }
    }
    if (yawAmt > 0 && this.yawPhi !== 0) {
      // ride the head's cylinder yaw (front hair fully, back hair partly)
      for (let i = 0; i < pos.length; i += 2) {
        pos[i] = cur[i] + (this.yawMapX(cur[i]) - cur[i]) * yawAmt
        pos[i + 1] = cur[i + 1]
      }
    } else {
      for (let i = 0; i < pos.length; i++) pos[i] = cur[i]
    }
    geom.getBuffer('aPosition').update()
  }

  /** 0 (open) .. 1 (closed) — drives the eye squash for blinks. */
  private blinkClose(t: number): number {
    const period = 3.3, ph = t % period, dur = 0.14
    if (ph < dur) return Math.sin((ph / dur) * Math.PI)
    if (ph > 0.19 && ph < 0.19 + dur && (Math.floor(t / period) % 4 === 0))
      return Math.sin(((ph - 0.19) / dur) * Math.PI)
    return 0
  }

  private expr(e: Expression, intensity = 1) {
    // eyeSY = legacy vertical squash (v1 fallback only). v2 uses lidClose so the
    // sclera / iris / mask never desync. browDy<0 raises brows; mouthSX shears.
    const N = { eyeSY: 1, eyeDy: 0, gazeDx: 0, mouthSY: 1, mouthSX: 0, browDy: 0, browRot: 0, lidClose: 0 }
    let target = N
    switch (e) {
      case 'smile':     target = { eyeSY: 0.80, eyeDy: 1,  gazeDx: 0,  mouthSY: 1.25, mouthSX: 0.10, browDy: -1, browRot: 0,    lidClose: 0.30 }; break
      case 'angry':     target = { eyeSY: 0.92, eyeDy: -1, gazeDx: 0,  mouthSY: 0.9,  mouthSX: -0.05, browDy: 5, browRot: 0,    lidClose: 0.16 }; break
      case 'surprised': target = { eyeSY: 1.0,  eyeDy: -3, gazeDx: 0,  mouthSY: 1.5,  mouthSX: 0,     browDy: -8, browRot: 0,   lidClose: 0    }; break
      case 'sad':       target = { eyeSY: 0.86, eyeDy: 2,  gazeDx: 0,  mouthSY: 0.85, mouthSX: -0.06, browDy: -2, browRot: 0.04, lidClose: 0.12 }; break
      case 'smug':      target = { eyeSY: 0.80, eyeDy: -1, gazeDx: 6,  mouthSY: 1.1,  mouthSX: 0.14,  browDy: -2, browRot: 0.05, lidClose: 0.28 }; break
      case 'shy':       target = { eyeSY: 0.90, eyeDy: 2,  gazeDx: -8, mouthSY: 0.95, mouthSX: 0,     browDy: 1,  browRot: 0,    lidClose: 0.14 }; break
    }
    const i = Math.max(0, Math.min(1, intensity))
    const L = (a: number, b: number) => a + (b - a) * i
    return {
      eyeSY: L(N.eyeSY, target.eyeSY), eyeDy: L(N.eyeDy, target.eyeDy), gazeDx: L(N.gazeDx, target.gazeDx),
      mouthSY: L(N.mouthSY, target.mouthSY), mouthSX: L(N.mouthSX, target.mouthSX),
      browDy: L(N.browDy, target.browDy), browRot: L(N.browRot, target.browRot),
      lidClose: L(N.lidClose, target.lidClose),
    }
  }

  destroy() {
    if (this.onVis) document.removeEventListener('visibilitychange', this.onVis)
    try { this.app.destroy(true, { children: true }) } catch { /* noop */ }
  }
}
