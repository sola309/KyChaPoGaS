import { useRef, useState } from 'react'
import type { SpeedEase } from '../../api/client'

/**
 * SpeedCurveEditor — AE風グラフエディタ（クリップ速度の加減速ベジェ）.
 *
 * x = クリップの出力時間(0→1), y = ソースの進行度(0→1).
 * P0=(0,0), P3=(1,1) 固定で、P1/P2 のハンドルをドラッグして任意カーブを作る。
 * 値は 'cubic:x1,y1,x2,y2' としてクリップの speed_ease に保存され、
 * 書き出し時に区分一定近似でレンダリングされる。
 */

const PRESETS: { id: SpeedEase; label: string; pts: [number, number, number, number] }[] = [
  { id: 'linear', label: '一定',  pts: [0.333, 0.333, 0.667, 0.667] },
  { id: 'in',     label: '加速',  pts: [0.42, 0.0, 1.0, 1.0] },
  { id: 'out',    label: '減速',  pts: [0.0, 0.0, 0.58, 1.0] },
  { id: 'inout',  label: '緩急',  pts: [0.42, 0.0, 0.58, 1.0] },
]

function parseEase(ease: SpeedEase): [number, number, number, number] {
  if (ease.startsWith('cubic:')) {
    const v = ease.slice(6).split(',').map(Number)
    if (v.length === 4 && v.every(n => Number.isFinite(n))) {
      return [v[0], v[1], v[2], v[3]].map(n => Math.min(1, Math.max(0, n))) as [number, number, number, number]
    }
  }
  return (PRESETS.find(p => p.id === ease) ?? PRESETS[0]).pts
}

const W = 180, H = 140, PAD = 12
const sx = (x: number) => PAD + x * (W - 2 * PAD)
const sy = (y: number) => H - PAD - y * (H - 2 * PAD)

interface Props {
  ease: SpeedEase
  onChange: (ease: SpeedEase) => void   // fires on drag end / preset click
  onClose: () => void
}

export function SpeedCurveEditor({ ease, onChange, onClose }: Props) {
  const [pts, setPts] = useState<[number, number, number, number]>(() => parseEase(ease))
  const svgRef = useRef<SVGSVGElement>(null)
  const [x1, y1, x2, y2] = pts

  const commit = (p: [number, number, number, number]) =>
    onChange(`cubic:${p.map(v => Number(v.toFixed(3))).join(',')}` as SpeedEase)

  const startDrag = (which: 1 | 2) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const toLocal = (ev: PointerEvent): [number, number] => {
      const x = Math.min(1, Math.max(0, (ev.clientX - rect.left - PAD) / (W - 2 * PAD)))
      const y = Math.min(1, Math.max(0, (H - PAD - (ev.clientY - rect.top)) / (H - 2 * PAD)))
      return [x, y]
    }
    let cur: [number, number, number, number] = [...pts] as typeof pts
    const onMove = (ev: PointerEvent) => {
      const [x, y] = toLocal(ev)
      cur = which === 1 ? [x, y, cur[2], cur[3]] : [cur[0], cur[1], x, y]
      setPts(cur)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      commit(cur)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const isPreset = (p: typeof PRESETS[number]) =>
    Math.abs(p.pts[0] - x1) < 0.01 && Math.abs(p.pts[1] - y1) < 0.01
    && Math.abs(p.pts[2] - x2) < 0.01 && Math.abs(p.pts[3] - y2) < 0.01

  return (
    <div
      className="absolute z-50 top-full left-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl p-2"
      onPointerDown={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-zinc-400">速度カーブ（横=時間 / 縦=ソース進行）</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-xs px-1">✕</button>
      </div>

      <svg ref={svgRef} width={W} height={H} className="touch-none select-none">
        {/* grid */}
        <rect x={PAD} y={PAD} width={W - 2 * PAD} height={H - 2 * PAD}
              fill="none" stroke="#3b3034" strokeWidth={1} />
        {[0.25, 0.5, 0.75].map(g => (
          <g key={g} stroke="#2a2225" strokeWidth={1}>
            <line x1={sx(g)} y1={PAD} x2={sx(g)} y2={H - PAD} />
            <line x1={PAD} y1={sy(g)} x2={W - PAD} y2={sy(g)} />
          </g>
        ))}
        {/* linear reference */}
        <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="#524448" strokeDasharray="3 3" />
        {/* handle arms */}
        <line x1={sx(0)} y1={sy(0)} x2={sx(x1)} y2={sy(y1)} stroke="#9c878c" strokeWidth={1} />
        <line x1={sx(1)} y1={sy(1)} x2={sx(x2)} y2={sy(y2)} stroke="#9c878c" strokeWidth={1} />
        {/* bezier curve */}
        <path
          d={`M ${sx(0)} ${sy(0)} C ${sx(x1)} ${sy(y1)}, ${sx(x2)} ${sy(y2)}, ${sx(1)} ${sy(1)}`}
          fill="none" stroke="#d6405d" strokeWidth={2}
        />
        {/* anchors */}
        <circle cx={sx(0)} cy={sy(0)} r={3} fill="#6f5d61" />
        <circle cx={sx(1)} cy={sy(1)} r={3} fill="#6f5d61" />
        {/* draggable handles (large touch targets) */}
        <circle cx={sx(x1)} cy={sy(y1)} r={10} fill="transparent" className="cursor-grab"
                onPointerDown={startDrag(1)} />
        <circle cx={sx(x1)} cy={sy(y1)} r={5} fill="#ee98a8" pointerEvents="none" />
        <circle cx={sx(x2)} cy={sy(y2)} r={10} fill="transparent" className="cursor-grab"
                onPointerDown={startDrag(2)} />
        <circle cx={sx(x2)} cy={sy(y2)} r={5} fill="#ee98a8" pointerEvents="none" />
      </svg>

      {/* presets */}
      <div className="flex gap-1 mt-1">
        {PRESETS.map(p => (
          <button
            key={p.id}
            onClick={() => { setPts(p.pts); onChange(p.id) }}
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              isPreset(p) ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >{p.label}</button>
        ))}
      </div>
    </div>
  )
}
