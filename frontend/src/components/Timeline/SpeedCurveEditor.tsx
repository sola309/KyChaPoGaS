import { useMemo, useRef, useState } from 'react'
import type { SpeedEase } from '../../api/client'

/**
 * ∿ 速度エンベロープエディタ v3(スピードランプ / ベジェ)
 *  横軸 = クリップ内の位置 / 縦軸 = その時点の再生速度(対数・レンジ自動拡張=上限なし)
 *  ・両端固定キーポイント+曲線タップで点追加、ドラッグ移動、選択→✕削除
 *  ・補間は自動接線スプライン。点を選択すると**ベジェ接線ハンドル**が出て個別調整可
 *  ・点をダブルクリック/ダブルタップ → その点を1.0xへリセット
 *  ・ドラッグ中はタイムラインへリアルタイム反映(onLive)、離した時に確定(onApply)
 *  保存: speed_ease='curve:<相対16>;k=<u:v[:mi:mo],...>'(mi/mo=log速度の接線, 省略=自動)
 */

export interface SpeedPoint { u: number; v: number; mi?: number; mo?: number }

const N_SAMPLES = 16
const W = 320, H = 210, PAD = 26
const HANDLE_DU = 0.09

const PRESETS: { label: string; pts: SpeedPoint[] }[] = [
  { label: '等速',     pts: [{ u: 0, v: 1 }, { u: 1, v: 1 }] },
  { label: '加速',     pts: [{ u: 0, v: 0.5 }, { u: 1, v: 2.4 }] },
  { label: '減速',     pts: [{ u: 0, v: 2.4 }, { u: 1, v: 0.5 }] },
  { label: '緩→急→緩', pts: [{ u: 0, v: 1.8 }, { u: 0.5, v: 0.6 }, { u: 1, v: 1.8 }] },
  { label: '急→緩→急', pts: [{ u: 0, v: 0.6 }, { u: 0.5, v: 2.0 }, { u: 1, v: 0.6 }] },
]

const VFLOOR = 0.02   // 数値安定用の下限のみ(上限なし)

/** 表示レンジ: 点群にフィット(最低0.25..4を含む、余白1.6倍) */
function rangeOf(pts: SpeedPoint[]): [number, number] {
  let lo = 0.25, hi = 4
  for (const p of pts) { lo = Math.min(lo, p.v / 1.6); hi = Math.max(hi, p.v * 1.6) }
  return [Math.max(VFLOOR, lo), hi]
}

/** 対数空間エルミート評価(mi/mo指定があれば接線上書き) */
export function evalSpline(pts: SpeedPoint[], u: number): number {
  const p = pts
  if (u <= p[0].u) return p[0].v
  if (u >= p[p.length - 1].u) return p[p.length - 1].v
  let i = 0
  while (i < p.length - 2 && u > p[i + 1].u) i++
  const p0 = p[i], p1 = p[i + 1]
  const du = Math.max(1e-6, p1.u - p0.u)
  const L = (v: number) => Math.log(Math.max(VFLOOR, v))
  const autoM = (idx: number): number => {
    const a = p[Math.max(0, idx - 1)], b = p[Math.min(p.length - 1, idx + 1)]
    return (L(b.v) - L(a.v)) / Math.max(1e-6, b.u - a.u)
  }
  const m0 = p0.mo ?? autoM(i)
  const m1 = p1.mi ?? autoM(i + 1)
  const t = (u - p0.u) / du
  const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t
  const h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2
  const ln = h00 * L(p0.v) + h10 * du * m0 + h01 * L(p1.v) + h11 * du * m1
  return Math.max(VFLOOR, Math.exp(ln))
}

export function samplesFromPoints(pts: SpeedPoint[]): { rel: number[]; mean: number } {
  const abs: number[] = []
  for (let i = 0; i < N_SAMPLES; i++) abs.push(evalSpline(pts, (i + 0.5) / N_SAMPLES))
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length
  return { rel: abs.map(v => v / mean), mean }
}

export function easeStringFromPoints(pts: SpeedPoint[]): SpeedEase {
  const { rel } = samplesFromPoints(pts)
  const k = pts.map(pt => {
    let s = `${pt.u.toFixed(3)}:${pt.v.toFixed(3)}`
    if (pt.mi != null || pt.mo != null) s += `:${pt.mi?.toFixed(3) ?? ''}:${pt.mo?.toFixed(3) ?? ''}`
    return s
  }).join(',')
  return `curve:${rel.map(r => r.toFixed(3)).join(',')};k=${k}` as SpeedEase
}

export function pointsFromEase(ease: SpeedEase, speed: number): SpeedPoint[] {
  if (typeof ease === 'string' && ease.startsWith('curve:')) {
    const kPart = ease.split(';k=')[1]
    if (kPart) {
      const pts = kPart.split(',').map(s => {
        const seg = s.split(':')
        const pt: SpeedPoint = { u: Number(seg[0]), v: Math.max(VFLOOR, Number(seg[1])) }
        if (seg.length >= 4) {
          if (seg[2] !== '') pt.mi = Number(seg[2])
          if (seg[3] !== '' && seg[3] != null) pt.mo = Number(seg[3])
        }
        return pt
      }).filter(pt => isFinite(pt.u) && isFinite(pt.v))
      if (pts.length >= 2) return pts
    }
    const rel = ease.slice(6).split(';')[0].split(',').map(Number).filter(v => v > 0)
    if (rel.length >= 2) {
      return [0, 0.25, 0.5, 0.75, 1].map(u => {
        const idx = Math.min(rel.length - 1, Math.round(u * (rel.length - 1)))
        return { u, v: Math.max(VFLOOR, rel[idx] * speed) }
      })
    }
  }
  return [{ u: 0, v: Math.max(VFLOOR, speed || 1) }, { u: 1, v: Math.max(VFLOOR, speed || 1) }]
}

interface Props {
  initial: SpeedPoint[]
  sourceFrames: number
  fps: number
  onApply: (pts: SpeedPoint[]) => void          // 確定(ドラッグ終了/追加/削除/プリセット)
  onLive?: (pts: SpeedPoint[]) => void          // ドラッグ中のリアルタイム反映
}

type DragTarget = { kind: 'point'; i: number } | { kind: 'hin' | 'hout'; i: number }

export function SpeedCurveEditor({ initial, sourceFrames, fps, onApply, onLive }: Props) {
  const [pts, setPts] = useState<SpeedPoint[]>(initial)
  const [selIdx, setSelIdx] = useState<number | null>(null)
  const drag = useRef<DragTarget | null>(null)
  const moved = useRef(false)
  const lastTap = useRef<{ i: number; t: number }>({ i: -1, t: 0 })
  const svgRef = useRef<SVGSVGElement>(null)

  const [vLo, vHi] = useMemo(() => rangeOf(pts), [pts])
  const L = (v: number) => Math.log(Math.max(VFLOOR, v))
  const vToY = (v: number) => H - PAD - ((L(v) - L(vLo)) / (L(vHi) - L(vLo))) * (H - 2 * PAD)
  const yToV = (y: number) => Math.max(VFLOOR, Math.exp(L(vLo) + ((H - PAD - y) / (H - 2 * PAD)) * (L(vHi) - L(vLo))))
  const uToX = (u: number) => PAD + u * (W - 2 * PAD)
  const xToU = (x: number) => Math.max(0, Math.min(1, (x - PAD) / (W - 2 * PAD)))

  const { mean } = useMemo(() => samplesFromPoints(pts), [pts])
  const outFrames = Math.max(1, Math.round(sourceFrames / mean))

  const gridVals = useMemo(() => {
    const vals: number[] = []
    for (let e = -6; e <= 8; e++) {
      const v = 2 ** e
      if (v >= vLo * 0.99 && v <= vHi * 1.01) vals.push(v)
    }
    return vals
  }, [vLo, vHi])

  const toLocal = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }

  const commit = (next: SpeedPoint[]) => { setPts(next); onApply(next) }

  const handleMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    moved.current = true
    const { x, y } = toLocal(e)
    setPts(prev => {
      const next = [...prev]
      if (d.kind === 'point') {
        const i = d.i
        const isEnd = i === 0 || i === prev.length - 1
        const u = isEnd ? prev[i].u
          : Math.max(prev[i - 1].u + 0.02, Math.min(prev[i + 1].u - 0.02, xToU(x)))
        next[i] = { ...prev[i], u, v: yToV(y) }
      } else {
        // 接線ハンドル: log速度の傾き = Δln(v)/Δu
        const i = d.i
        const pt = prev[i]
        const hu = d.kind === 'hin' ? Math.max(0.015, pt.u - xToU(x)) : Math.max(0.015, xToU(x) - pt.u)
        const slope = (L(yToV(y)) - L(pt.v)) / hu * (d.kind === 'hin' ? -1 : 1)
        next[i] = { ...pt, [d.kind === 'hin' ? 'mi' : 'mo']: slope }
      }
      onLive?.(next)
      return next
    })
  }

  const handleUp = (e: React.PointerEvent) => {
    if (!drag.current) return
    const d = drag.current
    drag.current = null
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    if (d.kind === 'point') setSelIdx(d.i)
    if (moved.current) onApply(ptsRef.current)
  }
  // onApplyでstale stateを避けるための参照
  const ptsRef = useRef(pts); ptsRef.current = pts

  const handleCanvasDown = (e: React.PointerEvent) => {
    if (drag.current) return
    const { x, y } = toLocal(e)
    const u = xToU(x)
    if (pts.some(pt => Math.hypot(uToX(pt.u) - x, vToY(pt.v) - y) < 14)) return
    if (u < 0.03 || u > 0.97) { setSelIdx(null); return }
    const next = [...pts, { u, v: yToV(y) }].sort((a, b) => a.u - b.u)
    setPts(next)
    setSelIdx(next.findIndex(pt => pt.u === u))
    onApply(next)
  }

  const pointDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    // ダブルタップ検出(300ms以内) → 1.0xへリセット
    const now = Date.now()
    if (lastTap.current.i === i && now - lastTap.current.t < 300) {
      lastTap.current = { i: -1, t: 0 }
      const next = pts.map((pt, j) => j === i ? { ...pt, v: 1 } : pt)
      commit(next)
      onLive?.(next)
      return
    }
    lastTap.current = { i, t: now }
    drag.current = { kind: 'point', i }
    moved.current = false
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }

  const handleDown = (i: number, kind: 'hin' | 'hout') => (e: React.PointerEvent) => {
    e.stopPropagation()
    drag.current = { kind, i }
    moved.current = false
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }

  const removeSelected = () => {
    if (selIdx == null || selIdx === 0 || selIdx === pts.length - 1) return
    commit(pts.filter((_, i) => i !== selIdx)); setSelIdx(null)
  }
  const resetTangents = () => {
    if (selIdx == null) return
    commit(pts.map((pt, i) => i === selIdx ? { u: pt.u, v: pt.v } : pt))
  }

  const path = useMemo(() => {
    const seg: string[] = []
    for (let i = 0; i <= 80; i++) {
      const u = i / 80
      seg.push(`${i === 0 ? 'M' : 'L'} ${uToX(u).toFixed(1)} ${vToY(evalSpline(pts, u)).toFixed(1)}`)
    }
    return seg.join(' ')
  }, [pts, vLo, vHi])

  // 選択点の接線ハンドル座標
  const handles = useMemo(() => {
    if (selIdx == null) return null
    const pt = pts[selIdx]
    const autoM = (idx: number): number => {
      const a = pts[Math.max(0, idx - 1)], b = pts[Math.min(pts.length - 1, idx + 1)]
      return (L(b.v) - L(a.v)) / Math.max(1e-6, b.u - a.u)
    }
    const mi = pt.mi ?? autoM(selIdx), mo = pt.mo ?? autoM(selIdx)
    const mk = (m: number, dir: -1 | 1) => ({
      x: uToX(pt.u + dir * HANDLE_DU),
      y: vToY(Math.exp(L(pt.v) + dir * m * HANDLE_DU)),
    })
    return {
      in: selIdx > 0 ? mk(mi, -1) : null,
      out: selIdx < pts.length - 1 ? mk(mo, 1) : null,
      cx: uToX(pt.u), cy: vToY(pt.v),
    }
  }, [selIdx, pts, vLo, vHi])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 flex-wrap items-center">
        {PRESETS.map(pr => (
          <button key={pr.label}
                  onClick={() => { commit(pr.pts); setSelIdx(null) }}
                  className="text-[10px] px-2 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">
            {pr.label}
          </button>
        ))}
        <button onClick={resetTangents}
                disabled={selIdx == null || (pts[selIdx]?.mi == null && pts[selIdx]?.mo == null)}
                className="text-[10px] px-2 py-1 rounded bg-zinc-800 text-zinc-400 disabled:opacity-30">
          接線を自動へ
        </button>
        <button onClick={removeSelected}
                disabled={selIdx == null || selIdx === 0 || selIdx === pts.length - 1}
                className="text-[10px] px-2 py-1 rounded bg-red-950/60 text-red-300 disabled:opacity-30 ml-auto">
          ✕ 点を削除
        </button>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}
           className="w-full touch-none select-none rounded bg-zinc-950 border border-zinc-800"
           onPointerDown={handleCanvasDown}
           onPointerMove={handleMove}
           onPointerUp={handleUp}>
        {gridVals.map(v => (
          <g key={v}>
            <line x1={PAD} x2={W - PAD} y1={vToY(v)} y2={vToY(v)}
                  stroke={v === 1 ? '#52525b' : '#27272a'} strokeDasharray={v === 1 ? '' : '3 3'} />
            <text x={3} y={vToY(v) + 3} fontSize={8.5} fill="#71717a">{v < 1 ? v : `${v}x`}</text>
          </g>
        ))}
        <text x={PAD} y={H - 6} fontSize={9} fill="#71717a">0</text>
        <text x={W - PAD} y={H - 6} fontSize={9} fill="#71717a" textAnchor="end">{outFrames}f</text>
        <path d={path} stroke="#a78bfa" strokeWidth={2} fill="none" />
        {/* 接線ハンドル(選択点のみ) */}
        {handles && (
          <g>
            {handles.in && (
              <g>
                <line x1={handles.cx} y1={handles.cy} x2={handles.in.x} y2={handles.in.y} stroke="#f0abfc" strokeWidth={1} />
                <circle cx={handles.in.x} cy={handles.in.y} r={7} fill="#f0abfc" stroke="#581c87" strokeWidth={1}
                        className="cursor-move" onPointerDown={handleDown(selIdx!, 'hin')} />
              </g>
            )}
            {handles.out && (
              <g>
                <line x1={handles.cx} y1={handles.cy} x2={handles.out.x} y2={handles.out.y} stroke="#f0abfc" strokeWidth={1} />
                <circle cx={handles.out.x} cy={handles.out.y} r={7} fill="#f0abfc" stroke="#581c87" strokeWidth={1}
                        className="cursor-move" onPointerDown={handleDown(selIdx!, 'hout')} />
              </g>
            )}
          </g>
        )}
        {pts.map((pt, i) => {
          const isEnd = i === 0 || i === pts.length - 1
          return (
            <circle key={i} cx={uToX(pt.u)} cy={vToY(pt.v)} r={isEnd ? 8 : 9}
                    fill={selIdx === i ? '#a855f7' : isEnd ? '#52525b' : '#7c3aed'}
                    stroke="#ddd6fe" strokeWidth={1.5}
                    className={isEnd ? 'cursor-ns-resize' : 'cursor-move'}
                    onPointerDown={pointDown(i)} />
          )
        })}
      </svg>
      <div className="text-[11px] text-zinc-400">
        平均 {mean.toFixed(2)}x → 出力 <span className="text-amber-300 font-medium">{outFrames}コマ</span>
        ({(outFrames / fps).toFixed(2)}秒)
        <span className="text-zinc-600 ml-1">/ 素材{sourceFrames}コマ分</span>
      </div>
    </div>
  )
}
