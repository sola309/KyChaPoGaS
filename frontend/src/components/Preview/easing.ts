// Easing functions for transform keyframes — the difference between mechanical
// linear motion and motion that "lands" on the beat. Each maps p∈[0,1]→eased.
// The SAME formulas exist in backend ffmpeg_render._EASES (sampled into the
// piecewise expr) so the preview matches the render exactly.
//
// For 音ハメ (beat-hit) feel the punchy out-eases matter most: expo.out snaps in
// fast then settles; back.out overshoots and pops back; elastic/bounce spring.

const c1 = 1.70158
const c3 = c1 + 1
const c4 = (2 * Math.PI) / 3
const c5 = (2 * Math.PI) / 4.5

function bounceOut(p: number): number {
  const n1 = 7.5625, d1 = 2.75
  if (p < 1 / d1) return n1 * p * p
  if (p < 2 / d1) { p -= 1.5 / d1; return n1 * p * p + 0.75 }
  if (p < 2.5 / d1) { p -= 2.25 / d1; return n1 * p * p + 0.9375 }
  p -= 2.625 / d1; return n1 * p * p + 0.984375
}

export const EASES: Record<string, (p: number) => number> = {
  linear: p => p,
  sineIn: p => 1 - Math.cos((p * Math.PI) / 2),
  sineOut: p => Math.sin((p * Math.PI) / 2),
  sineInOut: p => -(Math.cos(Math.PI * p) - 1) / 2,
  power2In: p => p * p,
  power2Out: p => 1 - (1 - p) * (1 - p),
  power2InOut: p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
  power3In: p => p * p * p,
  power3Out: p => 1 - Math.pow(1 - p, 3),
  power3InOut: p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  expoIn: p => (p === 0 ? 0 : Math.pow(2, 10 * p - 10)),
  expoOut: p => (p === 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  expoInOut: p => (p === 0 ? 0 : p === 1 ? 1 : p < 0.5
    ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2),
  backIn: p => c3 * p * p * p - c1 * p * p,
  backOut: p => 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2),
  backInOut: p => (p < 0.5
    ? (Math.pow(2 * p, 2) * ((c1 * 1.525 + 1) * 2 * p - c1 * 1.525)) / 2
    : (Math.pow(2 * p - 2, 2) * ((c1 * 1.525 + 1) * (p * 2 - 2) + c1 * 1.525) + 2) / 2),
  elasticOut: p => (p === 0 ? 0 : p === 1 ? 1
    : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1),
  elasticInOut: p => (p === 0 ? 0 : p === 1 ? 1 : p < 0.5
    ? -(Math.pow(2, 20 * p - 10) * Math.sin((20 * p - 11.125) * c5)) / 2
    : (Math.pow(2, -20 * p + 10) * Math.sin((20 * p - 11.125) * c5)) / 2 + 1),
  bounceOut,
}

export function applyEase(name: string | undefined, p: number): number {
  const f = name ? EASES[name] : undefined
  return f ? f(Math.max(0, Math.min(1, p))) : p
}

// Curated picker list (label + value), ordered by how musical/useful they are.
export const EASE_OPTIONS: { value: string; label: string }[] = [
  { value: 'linear', label: '線形' },
  { value: 'expoOut', label: 'スナップ (expo.out)' },
  { value: 'backOut', label: 'ポップ (back.out)' },
  { value: 'power2Out', label: '減速 (power2.out)' },
  { value: 'power3Out', label: '強減速 (power3.out)' },
  { value: 'expoIn', label: '溜め (expo.in)' },
  { value: 'power2In', label: '加速 (power2.in)' },
  { value: 'sineInOut', label: '緩急 (sine.inOut)' },
  { value: 'power2InOut', label: '緩急強 (power2.inOut)' },
  { value: 'expoInOut', label: 'キレ緩急 (expo.inOut)' },
  { value: 'elasticOut', label: 'バネ (elastic.out)' },
  { value: 'bounceOut', label: 'バウンド (bounce.out)' },
]
