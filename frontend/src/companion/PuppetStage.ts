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
  // v3: face_variants.py が生成する描き差分(口形素/まぶた) — Live2D流ブレンドシェイプ
  variants?: { mouth?: Record<string, string>; eyes?: Record<string, string>
               mouthHalf?: Record<string, string>; mouthSmile?: Record<string, string> }
  // v4: THA3で焼いた中割りフレームバンク(瞬き) — bake_face_bank.py
  thaBank?: { eyeBlink?: string[]; mouth?: Record<string, string[]>; eyeHappy?: string | null
              gaze?: Record<string, string> }
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
const YAW_MAX = 0.42   // 描き差分(variants)+深度パララックス導入で拡大(v3)

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
  verlet?: { cur: Float32Array; vel: Float32Array; init: boolean; prevE?: number; prevF?: number }
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
  private revealAt = 0           // <0: 未開始 / それ以外: フェード開始時刻
  // v3 描き差分スプライト(フルキャンバスのパッチ、head変換+ヨーに追従)
  private varMouth = new Map<string, { sprite: Sprite; mesh: MeshData }>()
  private varMouthHalf = new Map<string, { sprite: Sprite; mesh: MeshData }>()  // 半開(3段口パク)
  private varMouthSmile = new Map<string, { sprite: Sprite; mesh: MeshData }>() // 笑い口セット
  private varEyes = new Map<string, { sprite: Sprite; mesh: MeshData }>()
  private vMouthA: Record<string, number> = {}   // 口形素アルファ(0/1ハードスイッチ)
  private visemeCur = ''; private visemeHold = 0  // 現在の口形素と保持フレーム数
  private visemeFull = false                       // 全開段か(false=半開段)
  private slowTalk = 0                             // 低周波の発話エネルギー(身振り用)
  private mouthStep = 0                            // 0=閉 1=半開 2=全開(ヒステリシス)
  // 口形遷移モーフ: 切替を"動き"にする(90msの縦スケール+短フェード)
  private mouthShown: { sprite: Sprite; mesh: MeshData } | null = null
  private mouthPrev: { sprite: Sprite; mesh: MeshData } | null = null
  private mouthTrans = 1                           // 0→1 遷移進行
  // C: フレーズ境界ジェスチャ / E: アイドル仕草
  private wasTalking = false
  private phraseBlinkAt = -9      // 息継ぎ瞬きの開始時刻
  private phraseGazeSeed = 1
  private idleActUntil = 0; private idleActKind = 0; private idleNextAt = 14
  private idleClose = 0
  private blinkBank: { sprite: Sprite; mesh: MeshData }[] = []  // THA3瞬き中割り
  private happyEye: { sprite: Sprite; mesh: MeshData } | null = null  // にっこり閉じ目(^^)
  private gazeBank = new Map<string, { sprite: Sprite; mesh: MeshData }>()  // 描かれた視線8方位
  private vEyesA: Record<string, number> = {}
  private mouthCavity = new Graphics()
  private cw = 1280
  private ch = 1280
  private S = 1         // motion scale = character extent (this puppet) ÷ UNIT_REF
  private mouthW = 60   // mouth layer width (texture px) — scales the viseme cavity
  private headR = 200   // cylinder radius for yaw = face half-width / sin(edge) (texture px)
  private faceL = 1e9; private faceR = -1e9   // face x-extent accumulator (init)
  private faceDepth = 0.5                      // 顔レイヤの意味的深度(前髪のヨー同期用)
  private yawPhi = 0    // current yaw angle (rad), set each frame
  private yawCx = 0     // yaw axis x in root space, set each frame
  private pivots: Record<string, [number, number]> = {}
  params: PuppetParams = { headTurn: 0, headNod: 0, talk: 0, expression: 'neutral' }
  /** external lip-sync drive (0..1) — audio amplitude → mouth open amount. */
  talkLevel = 0
  mouthRange = 0.75   // 感情による開口の最大幅(0..1) — 静かな感情では大きく開かない
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

    this.root.alpha = 0            // 全レイヤ搭載完了までステージを見せない
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
      if (ly.name === 'face') this.faceDepth = entry.depth
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

    // ── v3: 描き差分(口形素/まぶた)を前髪の直下へ ────────────────────────────
    // フルキャンバスのパッチ画像。head変換+ヨーワープに追従させるためメッシュ化。
    const variants = manifest.rig?.variants
    if (variants) {
      let fhIdx = this.root.children.length
      for (let i = 0; i < this.sprites.length; i++)
        if (this.sprites[i].group === 'fronthair') { fhIdx = this.root.getChildIndex(this.sprites[i].sprite); break }
      const loadVar = async (rel: string) => {
        const tex = await loadTex(baseUrl + rel.split('/').map(encodeURIComponent).join('/'))
        const mesh = new MeshPlane({ texture: tex, verticesX: 12, verticesY: 12 })
        const geom = mesh.geometry as unknown as MeshData['geom']
        mesh.alpha = 0
        this.root.addChildAt(mesh, fhIdx)
        return { sprite: mesh as unknown as Sprite, mesh: { geom, base: Float32Array.from(geom.positions), h: tex.height, vx: 12, vy: 12 } }
      }
      for (const [k, rel] of Object.entries(variants.mouth ?? {})) { this.varMouth.set(k, await loadVar(rel)); this.vMouthA[k] = 0 }
      for (const [k, rel] of Object.entries(variants.mouthHalf ?? {})) { this.varMouthHalf.set(k, await loadVar(rel)) }
      for (const [k, rel] of Object.entries(variants.mouthSmile ?? {})) { this.varMouthSmile.set(k, await loadVar(rel)) }
      for (const [k, rel] of Object.entries(variants.eyes ?? {})) { this.varEyes.set(k, await loadVar(rel)); this.vEyesA[k] = 0 }
    }
    // v4: THA3瞬きバンク(中割りスプライト列 — インデックス再生、クロスフェード無し)
    for (const rel of manifest.rig?.thaBank?.eyeBlink ?? []) {
      let fhIdx = this.root.children.length
      for (let i = 0; i < this.sprites.length; i++)
        if (this.sprites[i].group === 'fronthair') { fhIdx = this.root.getChildIndex(this.sprites[i].sprite); break }
      const tex = await loadTex(baseUrl + rel.split('/').map(encodeURIComponent).join('/'))
      const mesh = new MeshPlane({ texture: tex, verticesX: 12, verticesY: 12 })
      const geom = mesh.geometry as unknown as MeshData['geom']
      mesh.alpha = 0
      this.root.addChildAt(mesh, fhIdx)
      this.blinkBank.push({ sprite: mesh as unknown as Sprite, mesh: { geom, base: Float32Array.from(geom.positions), h: tex.height, vx: 12, vy: 12 } })
    }
    if (manifest.rig?.thaBank?.eyeHappy) {
      let fhIdx = this.root.children.length
      for (let i = 0; i < this.sprites.length; i++)
        if (this.sprites[i].group === 'fronthair') { fhIdx = this.root.getChildIndex(this.sprites[i].sprite); break }
      const tex = await loadTex(baseUrl + manifest.rig.thaBank.eyeHappy.split('/').map(encodeURIComponent).join('/'))
      const mesh = new MeshPlane({ texture: tex, verticesX: 12, verticesY: 12 })
      const geom = mesh.geometry as unknown as MeshData['geom']
      mesh.alpha = 0
      this.root.addChildAt(mesh, fhIdx)
      this.happyEye = { sprite: mesh as unknown as Sprite, mesh: { geom, base: Float32Array.from(geom.positions), h: tex.height, vx: 12, vy: 12 } }
    }
    for (const [k, rel] of Object.entries(manifest.rig?.thaBank?.gaze ?? {})) {
      let fhIdx = this.root.children.length
      for (let i = 0; i < this.sprites.length; i++)
        if (this.sprites[i].group === 'fronthair') { fhIdx = this.root.getChildIndex(this.sprites[i].sprite); break }
      const tex = await loadTex(baseUrl + rel.split('/').map(encodeURIComponent).join('/'))
      const mesh = new MeshPlane({ texture: tex, verticesX: 12, verticesY: 12 })
      const geom = mesh.geometry as unknown as MeshData['geom']
      mesh.alpha = 0
      this.root.addChildAt(mesh, fhIdx)
      this.gazeBank.set(k, { sprite: mesh as unknown as Sprite, mesh: { geom, base: Float32Array.from(geom.positions), h: tex.height, vx: 12, vy: 12 } })
    }
    this.fit()

    let t = 0
    this.revealAt = -1             // 次のupdateからフェードイン開始
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
    // 下端は4%オーバースキャン: 切り口(ポートレート素体の裾)を常に画面外へ
    this.root.position.set((cw - this.cw * scale) / 2 + this.viewPanX,
                           chh - this.ch * scale + this.viewPanY + 0.04 * this.ch * scale)
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
    const breathSY = 1 + 0.007 * br   // Live2D流: 呼吸は小振幅
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
    this.sMOpen += (rawOpen - this.sMOpen) * (rawOpen > this.sMOpen ? 0.5 : 0.13)
    this.sMWide += (this.mouthWide - this.sMWide) * 0.3
    const talkEnv = this.sMOpen
    // ── v3 口形素: 開口量×口幅ヒントから あ/い/う/え/お を選び描き差分をクロスフェード。
    // 差分があるときは手続き変形(縦伸ばし+疑似口腔)をブレンド率ぶん退避させる。
    let vMouthSum = 0
    if (this.varMouth.size) {
      // ハードスイッチ+ヒステリシス: クロスフェードは唇が二重に見える(不気味さの
      // 正体)。選択口形素をアルファ1で即置換、切替は8フレーム最低保持で
      // パタつきを防ぐ。開口が小さいときはベースの閉じ口(素の絵)を見せる。
      const open = talkEnv * this.mouthRange, wide = this.sMWide
      // 段(閉/半開/全開)はヒステリシス遷移: 上がる閾値と下がる閾値を離して
      // 音節ごとの高速往復を殺す(アニメの口パクは形を保持する)
      if (this.mouthStep === 0) { if (open > 0.16) this.mouthStep = 1 }
      else if (this.mouthStep === 1) { if (open > 0.5) this.mouthStep = 2; else if (open < 0.07) this.mouthStep = 0 }
      else { if (open < 0.32) this.mouthStep = 1 }
      // 母音は0.15秒最低保持。閉時のみ即時解除
      const pick = this.mouthStep === 0 ? '' :
        wide > 0.5 ? (open > 0.55 ? 'a' : 'i')
                   : (open > 0.62 ? 'a' : open > 0.36 ? 'o' : open > 0.18 ? 'u' : 'e')
      this.visemeHold++
      if (pick !== this.visemeCur && (this.visemeHold >= 9 || pick === '' || this.visemeCur === '')) {
        this.visemeCur = pick; this.visemeHold = 0
      }
      this.visemeFull = this.visemeCur !== '' && (this.varMouthHalf.size === 0 || this.mouthStep === 2)
      for (const k of this.varMouth.keys()) this.vMouthA[k] = (k === this.visemeCur && this.visemeFull) ? 1 : 0
      vMouthSum = this.visemeCur ? 1 : 0
    }
    const procM = 1 - vMouthSum                  // 手続き口の残量
    const mouthSY = 1 + 0.45 * talkEnv * procM   // closed-mouth sprite opens modestly
    const mouthDy = 4 * S * talkEnv * procM

    // 話し身振り: 音節ごとのキックは頭がカクつく(まばたきまで巻き添えに見える)。
    // ゆっくり平滑したエネルギーで、低周波のうなずき/揺れだけを乗せる。
    this.slowTalk += (talkEnv - this.slowTalk) * 0.06
    headDy += this.slowTalk * (3.5 * S) * Math.sin(t * 1.9)
    headAngle += this.slowTalk * 0.010 * Math.sin(t * 1.4 + 1)
    // 語気の表情: 強い所で眉が上がり、目がわずかに細まる(棒読み顔の解消)
    const talkExpr = this.slowTalk * (0.5 + 0.5 * Math.sin(t * 1.1 + 2))
    // ── C: フレーズ境界(息継ぎ) — 人間は文末で瞬き・視線を動かす ──
    const talkingNow = talkEnv > 0.09
    if (this.wasTalking && !talkingNow && this.slowTalk > 0.12) {
      this.phraseBlinkAt = t
      this.phraseGazeSeed = (this.phraseGazeSeed * 1103515245 + 12345) & 0x7fffffff
      const gx = ((this.phraseGazeSeed % 200) / 100 - 1) * 0.5
      const gy = (((this.phraseGazeSeed >> 8) % 100) / 100 - 0.5) * 0.3
      this.setLook(gx, gy)
    }
    this.wasTalking = talkingNow
    const phraseBlink = this.blinkShape(Math.min(1, Math.max(0, (t - this.phraseBlinkAt) / 0.22)))

    const active: Expression = this.transientT > 0 ? this.transientExpr : p.expression
    if (active !== this.lastExpr) { this.exprI = 1; this.lastExpr = active }
    const floor = active === 'neutral' ? 0 : 0.45
    this.exprI += (floor - this.exprI) * 0.012
    const expr = this.expr(active, this.exprI)

    // ロード完了後のフェードイン(0.45s)
    if (this.revealAt < 0) this.revealAt = t
    this.root.alpha = Math.min(1, (t - this.revealAt) / 0.45)

    // ── E: アイドル仕草 — ときどき伸び/見回し/ふぅ(目閉じ) ──
    if (t > this.idleNextAt && this.talkLevel < 0.02) {
      this.idleActKind = Math.floor((t * 7919) % 3)
      this.idleActUntil = t + 1.6
      this.idleNextAt = t + 14 + ((t * 104729) % 16)
    }
    let idleActRot = 0
    if (t < this.idleActUntil) {
      const u = 1 - (this.idleActUntil - t) / 1.6
      const bell = Math.sin(Math.min(1, Math.max(0, u)) * Math.PI)
      if (this.idleActKind === 0) { idleActRot = 0.02 * bell }                    // 伸び
      else if (this.idleActKind === 1) { this.setLook(Math.sin(u * TAU) * 0.8, -0.1) }  // 見回し
      else { this.idleClose = bell }                                              // ふぅ(目を閉じる)
    } else {
      this.idleClose = 0
      if (this.idleActKind === 1 && t < this.idleActUntil + 0.5) this.clearLook()
    }

    this.root.angle = 0
    const idleRot = 0.010 * Math.sin((t / 8) * TAU) + idleActRot
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
    // Live2D流の呼吸結合: 頭は「胴が首根(頭ピボット)に与える変位」に乗る。
    // これまで頭が呼吸から独立しており、肩だけ上下して首が浮いて見えた。
    const rideX = mBody.a * hx + mBody.c * hy + mBody.tx - hx
    const rideY = mBody.b * hx + mBody.d * hy + mBody.ty - hy
    // ── head yaw via cylinder warp ────────────────────────────────────────────
    // The base head transform carries NO turn (idle bob + translate only). The turn
    // is a per-vertex cylindrical remap applied AFTER this affine (see yawMapX), so
    // the face genuinely rotates: central features parallax ahead of the outline and
    // the near/far cheeks warp asymmetrically. Same field for every head layer →
    // zero inter-layer drift. yawCx tracks the slide so the axis stays on the face.
    this.yawPhi = this.sTurn * YAW_MAX
    this.yawCx = hx + headDx
    const mHead = rig(hx, hy, headAngle, 1, 1, headDx + rideX, headDy + rideY)
    const eyeDy = expr.eyeDy * S
    // Blink + squint by vertically squashing the WHOLE eye group (sclera, lashes
    // and iris together) around the eye pivot — the classic anime close. No skin
    // overlay, so no rectangular "frame" at the lids. Brows are NOT squashed.
    const eyeClose = Math.max(blinkCl, expr.lidClose, talkExpr * 0.16,
                              (t - this.phraseBlinkAt) < 0.22 ? phraseBlink : 0,
                              this.idleClose)
    // v3: 描きまぶた差分があるときは「絵」で閉じる(スカッシュは補助程度に残す)
    let vEyesClosed = 0, vEyesHalf = 0
    let blinkFrame = -1, happyOn = false
    if (this.blinkBank.length) {
      // THA3中割り: eyeClose(0..1)→フレームindex。0.12未満は素の絵。
      if (eyeClose > 0.12) blinkFrame = Math.min(this.blinkBank.length - 1,
        Math.floor(eyeClose * this.blinkBank.length))
      // 笑顔系の深い閉じはにっこり閉じ目(^^)に差し替え
      if (this.happyEye && (active === 'smile' || active === 'shy') && eyeClose > 0.8) {
        happyOn = true; blinkFrame = -1
      }
    } else if (this.varEyes.size) {
      // ハードスイッチ(アルファ0/1のみ): クロスフェードは開き目と閉じ目が
      // 半透明で重なりゴーストになる(不自然さの正体)。Live2D/アニメ同様の
      // スプライト切替 — 開(<0.3) / 半眼(0.3-0.72) / 閉(>0.72)。
      if (eyeClose > 0.72 && this.varEyes.has('closed')) vEyesClosed = 1
      else if (eyeClose > 0.3 && this.varEyes.has('half')) vEyesHalf = 1
      this.vEyesA['closed'] = vEyesClosed
      this.vEyesA['half'] = vEyesHalf
    }
    const squashAmt = this.blinkBank.length
      ? (blinkFrame >= 0 ? 0.08 : 0.94 * Math.min(1, eyeClose / 0.12))
      : 0.94 * (1 - Math.max(vEyesClosed, vEyesHalf) * 0.9)
    const eyeSY = Math.max(0.06, 1 - eyeClose * squashAmt)
    const mEyes = rig(ex, ey, 0, 1, eyeSY, 0, eyeDy + lookEyeDy)
    // brows ride with the eyes plus expression raise/tilt (#6 — now visible after z-fix)
    const mBrow = rig(ex, ey, expr.browRot, 1, 1, 0,
                      eyeDy + expr.browDy * S - talkExpr * 3.5 * S)
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
          this.warpNeck(entry, mHead, mBody)
          sprite.setFromMatrix(IDENTITY); continue
        }
        if (sway.type === 'hair') {                       // tip-sway (row-weighted)
          // front hair rides on the face → full yaw; back hair sits behind → partial.
          this.verletHair(mesh, pinM, t, S, wind, sway.amp, undefined,
            group === 'backhair' ? 0.55 : 1,
            group === 'fronthair' ? this.faceDepth : entry.depth)
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
        this.warpFace(mesh, m, entry.depth)
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

    // v3: 差分スプライト(フルキャンバスパッチ)はheadアフィン+ヨーワープに追従
    // ── 口形遷移モーフ ── (dtはupdate()冒頭のポークばね用を再利用)
    const smiley = (active === 'smile' || active === 'shy') && this.varMouthSmile.size > 0
    const target = this.visemeCur === '' ? null
      : (this.visemeFull
          ? (smiley ? this.varMouthSmile.get(this.visemeCur) : this.varMouth.get(this.visemeCur))
          : this.varMouthHalf.get(this.visemeCur)) ?? null
    if (target !== this.mouthShown) {
      this.mouthPrev = this.mouthShown
      this.mouthShown = target
      this.mouthTrans = 0
      // 入る口を出る口より上に(painter's order) — 遷移中も唇線は常に1系統だけ見える
      if (target && this.mouthPrev) {
        const ti = this.root.getChildIndex(target.sprite)
        const pi = this.root.getChildIndex(this.mouthPrev.sprite)
        if (ti < pi) this.root.setChildIndex(target.sprite, pi)
      }
    }
    this.mouthTrans = Math.min(1, this.mouthTrans + dt / 0.09)
    const u = this.mouthTrans, eIn = u * u * (3 - 2 * u)
    // 全口スプライトをリセット
    for (const [, v] of this.varMouth) (v.sprite as Sprite).alpha = 0
    for (const [, v] of this.varMouthHalf) (v.sprite as Sprite).alpha = 0
    for (const [, v] of this.varMouthSmile) (v.sprite as Sprite).alpha = 0
    // 入ってくる口: 口ピボット周りで縦に"開いていく"(0.72→1) — 中間の動きを作る
    if (this.mouthShown) {
      const spr = this.mouthShown.sprite as Sprite
      // 前の口が下に居る間は即不透明(共存ゴーストなし)。閉→開のときだけ極短フェード
      spr.alpha = this.mouthPrev ? 1 : Math.min(1, u * 3)
      const sy = 0.72 + 0.28 * eIn        // "開いていく"モーフはそのまま
      const mm = mHead.clone().append(rig(mx, my, 0, 1, sy, 0, 0))
      this.warpFace(this.mouthShown.mesh, mm)
    }
    // 出ていく口: 入る口の下で閉じつつ、後半で消える(唇線は常に1系統)
    if (this.mouthPrev && u < 1) {
      const spr = this.mouthPrev.sprite as Sprite
      spr.alpha = u < 0.55 ? 1 : 1 - (u - 0.55) / 0.45
      const sy = 1 - 0.3 * eIn
      const mm = mHead.clone().append(rig(mx, my, 0, 1, sy, 0, 0))
      this.warpFace(this.mouthPrev.mesh, mm)
    } else if (u >= 1) this.mouthPrev = null
    for (const [k, v] of this.varEyes) {
      (v.sprite as Sprite).alpha = this.blinkBank.length ? 0 : (this.vEyesA[k] ?? 0)
      if ((v.sprite as Sprite).alpha > 0.01) this.warpFace(v.mesh, mHead)
    }
    for (let i = 0; i < this.blinkBank.length; i++) {
      const b = this.blinkBank[i]
      ;(b.sprite as Sprite).alpha = i === blinkFrame ? 1 : 0
      if (i === blinkFrame) this.warpFace(b.mesh, mHead, this.faceDepth)
    }
    if (this.happyEye) {
      (this.happyEye.sprite as Sprite).alpha = happyOn ? 1 : 0
      if (happyOn) this.warpFace(this.happyEye.mesh, mHead, this.faceDepth)
    }
    // 描かれた視線: しっかり視線が振れた時だけバンク(白目とハイライトが正しい)。
    // 微小視線・サッケードは従来の瞳スライドが担当。目を閉じている間は出さない。
    let gazeKey = ''
    if (this.gazeBank.size && eyeClose < 0.3 && !happyOn) {
      const gx = Math.abs(this.sLookX) > 0.42 ? Math.sign(this.sLookX) : 0
      const gy = Math.abs(this.sLookY) > 0.38 ? Math.sign(this.sLookY) : 0
      if (gx !== 0 || gy !== 0) gazeKey = `${gx},${gy}`
    }
    for (const [k, g] of this.gazeBank) {
      const on = k === gazeKey
      ;(g.sprite as Sprite).alpha = on ? 1 : 0
      if (on) this.warpFace(g.mesh, mHead, this.faceDepth)
    }
    this.drawMouthCavity(talkEnv * procM, mx, my, mHead)
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
  private warpNeck(entry: SpriteEntry, mHead: Matrix, mBody: Matrix) {
    // 厳密な頂点ブレンド: 下端=mBodyの完全アフィン(胴体レイヤと同一式=継ぎ目ゼロ)、
    // 上端=mHeadの完全アフィン+ヨー(顔レイヤと同一式)。旧実装は下端を
    // 「頭ピボットで測った胴体変位の一律加算」で近似しており、呼吸スケールや
    // リーン回転で胴体と首下端が食い違っていた(首と胴のズレの正体)。
    const { geom, base } = entry.mesh!
    const bb = entry.bbox!
    const pos = geom.positions
    const top = bb[1], bot = bb[3], span = Math.max(1, bot - top)
    const ba = mBody.a, bbm = mBody.b, bc = mBody.c, bd = mBody.d, be = mBody.tx, bf = mBody.ty
    const ha = mHead.a, hb = mHead.b, hc = mHead.c, hd = mHead.d, he = mHead.tx, hf = mHead.ty
    for (let i = 0; i < pos.length; i += 2) {
      const x = base[i], y = base[i + 1]
      let w = (bot - y) / span            // 1 at neck top (head) .. 0 at bottom (body)
      w = w < 0 ? 0 : w > 1 ? 1 : w
      w = w * w * (3 - 2 * w)             // smoothstep
      const bx = ba * x + bc * y + be, by = bbm * x + bd * y + bf
      let hxv = ha * x + hc * y + he
      const hyv = hb * x + hd * y + hf
      // 頭側はヨー+顔と同じ深度シフトまで完全一致(顎の継ぎ目ゼロ)
      hxv = this.yawMapX(hxv) + this.yawPhi * (0.5 - this.faceDepth) * this.headR * 0.30
      pos[i] = bx + (hxv - bx) * w
      pos[i + 1] = by + (hyv - by) * w
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
  private warpFace(mesh: MeshData, m: Matrix, depth = 0.5) {
    const { geom, base } = mesh
    const pos = geom.positions
    const a = m.a, b = m.b, c = m.c, d = m.d, e = m.tx, f = m.ty
    // 深度パララックス: 手前のパーツ(鼻・口・目)ほどヨーで大きく流れる。
    // See-Through深度(rig_compilerの意味的深度, 0=近…1=遠)を利用。
    const dpx = this.yawPhi * (0.5 - depth) * this.headR * 0.30
    for (let i = 0; i < pos.length; i += 2) {
      const wx = a * base[i] + c * base[i + 1] + e
      pos[i] = this.yawMapX(wx) + dpx
      pos[i + 1] = b * base[i] + d * base[i + 1] + f
    }
    geom.getBuffer('aPosition').update()
  }

  /** Hair flow: each vertex eases (first-order, NO spring → never jitters) toward
   * its drawn position on the head plus a wind-bend, a slow flutter and a per-strand
   * travelling-wave ripple — all growing toward the tips. Smooth (no jelly) but the
   * long length and tips genuinely flow. Top ~10% stays rigid on the head. */
  private verletHair(mesh: MeshData, headM: Matrix, t: number, S: number, wind: number, amp = 1, bbox?: number[], yawAmt = 0, depth = 0.5) {
    const { base, vx, vy, geom } = mesh
    const pos = geom.positions
    const a = headM.a, b = headM.b, c = headM.c, d = headM.d, e = headM.tx, f = headM.ty
    let st = mesh.verlet
    if (!st) st = mesh.verlet = { cur: new Float32Array(pos.length), vel: new Float32Array(pos.length), init: false }
    const { cur, vel } = st
    if (!st.init) {
      for (let i = 0; i < pos.length; i += 2) {
        cur[i] = a * base[i] + c * base[i + 1] + e
        cur[i + 1] = b * base[i] + d * base[i + 1] + f
      }
      st.init = true
    }
    // ピンの平行移動速度 → 毛先への慣性キック(急に振り向くと髪が遅れてついてくる)
    const headVx = st.prevE === undefined ? 0 : e - st.prevE
    const headVy = st.prevF === undefined ? 0 : f - st.prevF
    st.prevE = e; st.prevF = f
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
      // ばね定数: 根本ほど硬い。減衰は臨界の~0.9(わずかなオーバーシュート=毛先の追い越し)
      const k = 0.30 - 0.16 * tip
      const damp = 2 * Math.sqrt(k) * 0.9
      const inertia = swing * 0.55                    // 毛先ほど頭の動きに遅れる
      // ★根本ハードピン: 上部は頭皮に完全固定(pin=1)、毛先に向かって物理へランプ。
      // 全行をバネ追従にすると根本まで頭に遅れて「髪と顔がズレる」— それの根治。
      const pinT = Math.min(1, Math.max(0, (tip - 0.28) / 0.30))     // 0=固定 .. 1=物理
      const pin = pinT * pinT * (3 - 2 * pinT)
      for (let col = 0; col < vx; col++) {
        const i = (row * vx + col) * 2
        const wave = Math.sin(base[i + 1] * 0.02 - t * 2.4 + col * 0.6) * 5 * S * swing  // strand ripple
        const tgx = a * base[i] + c * base[i + 1] + e + windBend + wave
        const tgy = b * base[i] + d * base[i + 1] + f + gravBend
        if (pin <= 0) {                                // 頭皮: 物理なし・完全追従
          cur[i] = tgx; cur[i + 1] = tgy; vel[i] = 0; vel[i + 1] = 0
          continue
        }
        vel[i]     = (vel[i]     + (tgx - cur[i]) * k - headVx * inertia * k) * (1 - damp)
        vel[i + 1] = (vel[i + 1] + (tgy - cur[i + 1]) * k - headVy * inertia * k * 0.6) * (1 - damp)
        // 発散ガード(タブ復帰などの巨大dt対策): 速度と乖離をクランプ
        const mv = 30 * S
        vel[i] = Math.max(-mv, Math.min(mv, vel[i])); vel[i + 1] = Math.max(-mv, Math.min(mv, vel[i + 1]))
        const sx = cur[i] + vel[i], sy = cur[i + 1] + vel[i + 1]
        // 物理結果と剛体追従をピン率でブレンド → 根本側は常に頭皮に密着
        cur[i] = tgx + (sx - tgx) * pin
        cur[i + 1] = tgy + (sy - tgy) * pin
        const dxx = cur[i] - tgx, dyy = cur[i + 1] - tgy, lim = 90 * S * Math.max(swing, .12)
        if (Math.abs(dxx) > lim) cur[i] = tgx + Math.sign(dxx) * lim
        if (Math.abs(dyy) > lim) cur[i + 1] = tgy + Math.sign(dyy) * lim
      }
    }
    if (yawAmt > 0 && this.yawPhi !== 0) {
      // ride the head's cylinder yaw (front hair fully, back hair partly)
      // + 顔と同じ深度パララックス(無いと前髪だけヨーで取り残されてズレる)
      const dpx = this.yawPhi * (0.5 - depth) * this.headR * 0.30 * yawAmt
      for (let i = 0; i < pos.length; i += 2) {
        pos[i] = cur[i] + (this.yawMapX(cur[i]) - cur[i]) * yawAmt + dpx
        pos[i + 1] = cur[i + 1]
      }
    } else {
      for (let i = 0; i < pos.length; i++) pos[i] = cur[i]
    }
    geom.getBuffer('aPosition').update()
  }

  /** アニメ的な非対称ブリンク波形: 速閉→保持→緩開(0..1)。 */
  private blinkShape(p: number): number {
    if (p <= 0) return 0
    if (p < 0.30) { const u = p / 0.30; return u * u }          // 加速して閉じる
    if (p < 0.45) return 1                                       // 閉眼保持
    const u = (p - 0.45) / 0.55
    return 1 - u * u * (3 - 2 * u)                               // なめらかに開く
  }

  /** 0 (open) .. 1 (closed) — drives the eye squash for blinks. */
  private blinkClose(t: number): number {
    const period = 3.3, ph = t % period, dur = 0.22
    if (ph < dur) return this.blinkShape(ph / dur)
    if (ph > 0.27 && ph < 0.27 + dur && (Math.floor(t / period) % 4 === 0))
      return this.blinkShape((ph - 0.27) / dur)
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
