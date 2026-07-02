// Evaluate a clip's transform_json (the per-LAYER transform) at a clip-local
// progress 0..1 — mirrors backend ffmpeg_render so the live preview matches the
// final render. Returns a full layer transform {zoom, x, y, rotation, opacity,
// anchor} (x/y normalized to the frame, rotation in degrees, opacity 0..1).
//
// Schema v2 (backward compatible):
//   { "preset": "kenburns_in" }                         legacy preset
//   { "keyframes": [{ "t":0, "scale":1.3, "x":0, "y":0,
//                     "rotation":0, "opacity":1 }, ...] }  per-property keyframes
//   { "scale":1, "x":0, "y":0, "rotation":0, "opacity":1 } static base (no anim)
// A static base + keyframes can coexist: the base is the value a property holds
// when it has no keyframe of its own. t = 0..1 over the clip.

import { applyEase } from './easing'

export interface XForm {
  zoom: number; x: number; y: number
  rotation: number; opacity: number
  anchor: [number, number]
}

export type TProp = 'scale' | 'x' | 'y' | 'rotation' | 'opacity'
export const TPROPS: TProp[] = ['scale', 'x', 'y', 'rotation', 'opacity']
export const TDEFAULT: Record<TProp, number> = { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 }

// `ease` shapes the segment ARRIVING at this keyframe (from the previous one) —
// the destination keyframe owns the easing, GSAP-style.
export interface KF { t: number; scale?: number; x?: number; y?: number; rotation?: number; opacity?: number; ease?: string }
export interface TDef {
  keyframes?: KF[]
  shake?: { amp: number; decay: number }
  anchor?: [number, number]
  scale?: number; x?: number; y?: number; rotation?: number; opacity?: number
}

// Presets carry musical default eases (punch snaps with expo.out, Ken Burns
// glides with sine.inOut) — linear keyframes are what made the old motion feel
// mechanical / off-beat.
const PRESETS: Record<string, TDef> = {
  kenburns_in:  { keyframes: [{ t: 0, scale: 1.0 }, { t: 1, scale: 1.18, ease: 'sineInOut' }] },
  kenburns_out: { keyframes: [{ t: 0, scale: 1.18 }, { t: 1, scale: 1.0, ease: 'sineInOut' }] },
  punch_in:     { keyframes: [{ t: 0, scale: 1.28 }, { t: 0.22, scale: 1.0, ease: 'expoOut' }] },
  punch_out:    { keyframes: [{ t: 0, scale: 1.0 }, { t: 0.18, scale: 1.25, ease: 'backOut' }, { t: 1, scale: 1.0, ease: 'power2Out' }] },
  pan_lr:       { keyframes: [{ t: 0, scale: 1.15, x: -0.06 }, { t: 1, scale: 1.15, x: 0.06, ease: 'power2InOut' }] },
  pan_rl:       { keyframes: [{ t: 0, scale: 1.15, x: 0.06 }, { t: 1, scale: 1.15, x: -0.06, ease: 'power2InOut' }] },
  shake:        { keyframes: [{ t: 0, scale: 1.08 }, { t: 1, scale: 1.08 }], shake: { amp: 14, decay: 1.0 } },
}

export function parseTransform(raw: string): TDef | null {
  if (!raw || !raw.trim()) return null
  try {
    const d = JSON.parse(raw)
    if (d && typeof d === 'object') {
      if (d.kind === 'text') return null            // element clip, not a transform
      if (d.preset && PRESETS[d.preset]) return { ...PRESETS[d.preset], ...stripBase(d) }
      return d as TDef                              // keyframes and/or static base
    }
  } catch {
    return PRESETS[raw.trim()] ?? null              // bare preset name
  }
  return null
}

// pick only the static base props (not keyframes/preset) from a raw object
function stripBase(d: any): Partial<TDef> {
  const o: Partial<TDef> = {}
  for (const k of TPROPS) if (typeof d[k] === 'number') (o as any)[k] = d[k]
  if (Array.isArray(d.anchor)) o.anchor = d.anchor
  return o
}

// eased sample of a property across its keyframes; the destination keyframe's
// `ease` shapes each segment. Falls back to the static base when no keyframe
// carries that property.
function sampleProp(kfs: KF[], p: number, key: TProp, base: number): number {
  const pts = kfs.filter(k => typeof k[key] === 'number')
    .map(k => [k.t, k[key] as number, k.ease] as const)
  if (!pts.length) return base
  if (p <= pts[0][0]) return pts[0][1]
  if (p >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, v0] = pts[i], [t1, v1, ease1] = pts[i + 1]
    if (p >= t0 && p <= t1) {
      const u = applyEase(ease1, (p - t0) / Math.max(1e-6, t1 - t0))
      return v0 + (v1 - v0) * u
    }
  }
  return pts[pts.length - 1][1]
}

export function evalTransform(raw: string, progress: number, frame = 0): XForm {
  const d = parseTransform(raw)
  const out: XForm = { zoom: 1, x: 0, y: 0, rotation: 0, opacity: 1, anchor: [0.5, 0.5] }
  if (!d) return out
  if (Array.isArray(d.anchor)) out.anchor = [d.anchor[0], d.anchor[1]]
  const kfs = (d.keyframes ?? []).slice().sort((a, b) => a.t - b.t)
  const baseOf = (k: TProp) => (typeof d[k] === 'number' ? (d[k] as number) : TDEFAULT[k])
  out.zoom     = Math.max(0.01, sampleProp(kfs, progress, 'scale', baseOf('scale')))
  out.x        = sampleProp(kfs, progress, 'x', baseOf('x'))
  out.y        = sampleProp(kfs, progress, 'y', baseOf('y'))
  out.rotation = sampleProp(kfs, progress, 'rotation', baseOf('rotation'))
  out.opacity  = Math.max(0, Math.min(1, sampleProp(kfs, progress, 'opacity', baseOf('opacity'))))
  if (d.shake) {
    const amp = d.shake.amp / 1920
    const env = Math.exp(-d.shake.decay * progress * 4)
    out.x += amp * env * Math.sin(frame * 12.9898)
    out.y += amp * env * Math.cos(frame * 78.233)
  }
  return out
}

// ── Editing helpers (used by the inspector) ──────────────────────────────────

// Does this clip's transform carry any animation (keyframes / shake)?
export function isAnimated(raw: string): boolean {
  const d = parseTransform(raw)
  return !!d && ((d.keyframes?.length ?? 0) > 0 || !!d.shake)
}

// The current value of a property at clip-local progress (for slider display).
export function propValue(raw: string, key: TProp, progress: number): number {
  const xf = evalTransform(raw, progress)
  return key === 'scale' ? xf.zoom : key === 'rotation' ? xf.rotation
    : key === 'opacity' ? xf.opacity : key === 'x' ? xf.x : xf.y
}

// Set a property's STATIC base value (no animation) → returns new transform_json.
export function setBaseProp(raw: string, key: TProp, value: number): string {
  const d: TDef = parseTransform(raw) ?? {}
  ;(d as any)[key] = value
  return serialize(d)
}

// Set a keyframe for `key` at clip-local t (0..1). If one exists near t, update it;
// otherwise insert. Returns new transform_json.
export function setKeyframe(raw: string, key: TProp, t: number, value: number): string {
  const d: TDef = parseTransform(raw) ?? {}
  const kfs = (d.keyframes ?? []).slice()
  const EPS = 0.012
  const idx = kfs.findIndex(k => Math.abs(k.t - t) < EPS)
  if (idx >= 0) kfs[idx] = { ...kfs[idx], [key]: value }
  else kfs.push({ t, [key]: value })
  kfs.sort((a, b) => a.t - b.t)
  d.keyframes = kfs
  return serialize(d)
}

// Remove the keyframe nearest t that carries `key` (drops the prop or whole kf).
export function removeKeyframe(raw: string, key: TProp, t: number): string {
  const d: TDef = parseTransform(raw) ?? {}
  const kfs = (d.keyframes ?? []).slice()
  const EPS = 0.012
  const idx = kfs.findIndex(k => Math.abs(k.t - t) < EPS && typeof k[key] === 'number')
  if (idx >= 0) {
    const { [key]: _drop, t: tt, ...rest } = kfs[idx]
    if (Object.keys(rest).length === 0) kfs.splice(idx, 1)
    else kfs[idx] = { t: tt, ...rest }
  }
  d.keyframes = kfs
  return serialize(d)
}

// All keyframe times that carry a given property (for the timeline diamonds).
export function keyframeTimes(raw: string, key: TProp): number[] {
  const d = parseTransform(raw)
  return (d?.keyframes ?? []).filter(k => typeof k[key] === 'number').map(k => k.t).sort((a, b) => a - b)
}

// All keyframe times (any property) — for the timeline/inspector ease editing.
export function allKeyframeTimes(raw: string): number[] {
  const d = parseTransform(raw)
  return (d?.keyframes ?? []).map(k => k.t).sort((a, b) => a - b)
}

// The ease of the keyframe nearest t (the segment arriving at it). '' = none/here.
export function easeAt(raw: string, t: number): string {
  const d = parseTransform(raw)
  const k = (d?.keyframes ?? []).find(k => Math.abs(k.t - t) < 0.012)
  return k?.ease ?? 'linear'
}

// Set the ease on the keyframe nearest t (across all its props). No-op if none.
export function setEaseAt(raw: string, t: number, ease: string): string {
  const d: TDef = parseTransform(raw) ?? {}
  const kfs = (d.keyframes ?? []).slice()
  const idx = kfs.findIndex(k => Math.abs(k.t - t) < 0.012)
  if (idx < 0) return raw
  kfs[idx] = { ...kfs[idx], ease }
  d.keyframes = kfs
  return serialize(d)
}

function serialize(d: TDef): string {
  const out: any = {}
  for (const k of TPROPS) if (typeof (d as any)[k] === 'number') out[k] = round((d as any)[k])
  if (d.anchor) out.anchor = [round(d.anchor[0]), round(d.anchor[1])]
  if (d.shake) out.shake = d.shake
  if (d.keyframes && d.keyframes.length) {
    out.keyframes = d.keyframes.map(k => {
      const o: any = { t: round(k.t) }
      for (const p of TPROPS) if (typeof k[p] === 'number') o[p] = round(k[p] as any)
      if (k.ease && k.ease !== 'linear') o.ease = k.ease
      return o
    })
  }
  return Object.keys(out).length ? JSON.stringify(out) : ''
}
const round = (v: number) => Math.round(v * 1e4) / 1e4

// Parse a non-asset "element" clip (text / shape) stored in transform_json.
export interface TextProps {
  kind: 'text'
  text: string
  size?: number; color?: string; glow?: string; weight?: number
  x?: number; y?: number; align?: CanvasTextAlign
  inDur?: number; anim?: 'rise' | 'fade' | 'slam'
}
export function parseElement(raw: string): TextProps | null {
  if (!raw || !raw.trim()) return null
  try { const d = JSON.parse(raw); return d?.kind === 'text' ? d as TextProps : null } catch { return null }
}
