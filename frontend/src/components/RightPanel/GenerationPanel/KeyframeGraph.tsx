import { useMemo, useRef, useState } from 'react'

// 3Dカメラ等のキーフレームをグラフで可視化・編集する汎用コンポーネント。
// x軸 = at(0..1 ショット内時刻)、y軸 = 各パラメータ(トラックごとに正規化)。
// - 点をドラッグで移動(at/値の両方)
// - 点クリック選択 → 区間ease変更 / 削除
// - トラック行をダブルクリックでキー追加
// - beats(0..1正規化)を縦線で重畳表示(音ハメ確認用)

export interface CamKey {
  at: number
  ease?: string
  [param: string]: number | string | number[] | undefined
}

export interface TrackDef {
  key: string      // 'az' | 'el' | 'dist' | 'fov' | 'roll' ...
  label: string
  color: string
  min: number
  max: number
}

export const CAMERA_TRACKS: TrackDef[] = [
  { key: 'az',   label: '方位az',  color: '#c084fc', min: -3.2, max: 3.2 },
  { key: 'el',   label: '仰角el',  color: '#60a5fa', min: -0.6, max: 1.2 },
  { key: 'dist', label: '距離',    color: '#4ade80', min: 0.5,  max: 4.0 },
  { key: 'fov',  label: 'FOV',    color: '#fbbf24', min: 20,   max: 90 },
  { key: 'roll', label: 'ロール',  color: '#f87171', min: -30,  max: 30 },
]

const EASES = ['linear', 'inOut', 'outCubic', 'inCubic'] as const
const easeFn = (name: string | undefined, u: number): number => {
  switch (name) {
    case 'inOut':    return 0.5 - 0.5 * Math.cos(Math.PI * u)
    case 'outCubic': return 1 - Math.pow(1 - u, 3)
    case 'inCubic':  return u * u * u
    default:         return u
  }
}

const W = 520, ROW_H = 64, PAD_X = 34, PAD_Y = 8

export function KeyframeGraph({ keys, onChange, tracks = CAMERA_TRACKS, beats }: {
  keys: CamKey[]
  onChange: (keys: CamKey[]) => void
  tracks?: TrackDef[]
  beats?: number[]       // 0..1 正規化済みビート位置
}) {
  const [sel, setSel] = useState<{ ki: number; track: string } | null>(null)
  const dragRef = useRef<{ ki: number; track: TrackDef; row: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const sorted = useMemo(() => [...keys].sort((a, b) => a.at - b.at), [keys])
  // 表示は値を持つトラックのみ(+az/dist は常時)
  const visible = tracks.filter(t =>
    t.key === 'az' || t.key === 'dist' || sorted.some(k => k[t.key] !== undefined))
  const H = visible.length * ROW_H + PAD_Y * 2

  const x = (at: number) => PAD_X + at * (W - PAD_X - 10)
  const y = (t: TrackDef, row: number, v: number) => {
    const top = PAD_Y + row * ROW_H + 10
    const u = (v - t.min) / (t.max - t.min)
    return top + (1 - Math.max(0, Math.min(1, u))) * (ROW_H - 22)
  }
  const invY = (t: TrackDef, row: number, py: number) => {
    const top = PAD_Y + row * ROW_H + 10
    const u = 1 - (py - top) / (ROW_H - 22)
    return t.min + Math.max(0, Math.min(1, u)) * (t.max - t.min)
  }

  const valAt = (t: TrackDef, ki: number): number => {
    const v = sorted[ki][t.key]
    if (typeof v === 'number') return v
    // 未指定キーは前後の指定値から補間表示(既定値フォールバック)
    for (let i = ki; i >= 0; i--) { const p = sorted[i][t.key]; if (typeof p === 'number') return p }
    for (let i = ki; i < sorted.length; i++) { const n = sorted[i][t.key]; if (typeof n === 'number') return n }
    return t.key === 'dist' ? 2.1 : t.key === 'fov' ? 40 : t.key === 'el' ? 0.25 : 0
  }

  const pathFor = (t: TrackDef, row: number): string => {
    if (!sorted.length) return ''
    let d = ''
    for (let i = 0; i < sorted.length - 1; i++) {
      const k0 = sorted[i], k1 = sorted[i + 1]
      const v0 = valAt(t, i), v1 = valAt(t, i + 1)
      for (let s = 0; s <= 16; s++) {
        const u = s / 16
        const at = k0.at + (k1.at - k0.at) * u
        const v = v0 + (v1 - v0) * easeFn(k1.ease as string, u)
        d += `${d ? 'L' : 'M'}${x(at).toFixed(1)},${y(t, row, v).toFixed(1)}`
      }
    }
    return d
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const py = ((e.clientY - rect.top) / rect.height) * H
    const at = Math.max(0, Math.min(1, (px - PAD_X) / (W - PAD_X - 10)))
    const v = invY(drag.track, drag.row, py)
    const next = sorted.map((k, i) => i === drag.ki
      ? { ...k, at: Math.round(at * 1000) / 1000, [drag.track.key]: Math.round(v * 1000) / 1000 }
      : k)
    onChange(next)
  }

  const addKey = (_t: TrackDef, e: React.MouseEvent) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const at = Math.max(0, Math.min(1, (px - PAD_X) / (W - PAD_X - 10)))
    onChange([...sorted, { at: Math.round(at * 1000) / 1000, ease: 'inOut' }])
  }

  const selKey = sel ? sorted[sel.ki] : null

  return (
    <div className="flex flex-col gap-1">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full bg-zinc-900 rounded border border-zinc-800 select-none touch-none"
        onPointerMove={onPointerMove}
        onPointerUp={() => { dragRef.current = null }}
        onPointerLeave={() => { dragRef.current = null }}>
        {/* ビートグリッド */}
        {(beats || []).map((b, i) => (
          <line key={i} x1={x(b)} x2={x(b)} y1={PAD_Y} y2={H - PAD_Y}
            stroke="#3f3f46" strokeWidth={i % 4 === 0 ? 1.2 : 0.5} />
        ))}
        {visible.map((t, row) => {
          const top = PAD_Y + row * ROW_H
          return (
            <g key={t.key}>
              <rect x={0} y={top} width={W} height={ROW_H} fill="transparent"
                onDoubleClick={e => addKey(t, e)} />
              <line x1={PAD_X} x2={W - 10} y1={top + ROW_H - 6} y2={top + ROW_H - 6} stroke="#27272a" />
              <text x={4} y={top + 14} fontSize={9} fill={t.color}>{t.label}</text>
              <path d={pathFor(t, row)} fill="none" stroke={t.color} strokeWidth={1.5} opacity={0.9} />
              {sorted.map((k, ki) => (
                <circle key={ki} cx={x(k.at)} cy={y(t, row, valAt(t, ki))} r={sel?.ki === ki && sel.track === t.key ? 6 : 4}
                  fill={typeof k[t.key] === 'number' ? t.color : '#52525b'}
                  stroke={sel?.ki === ki ? '#fff' : 'none'} strokeWidth={1.5}
                  className="cursor-grab"
                  onPointerDown={e => {
                    (e.target as Element).setPointerCapture(e.pointerId)
                    dragRef.current = { ki, track: t, row }
                    setSel({ ki, track: t.key })
                  }} />
              ))}
            </g>
          )
        })}
      </svg>
      {selKey && (
        <div className="flex items-center gap-2 text-[10px] text-zinc-400">
          <span>at={selKey.at}</span>
          <span>区間ease:</span>
          <select value={(selKey.ease as string) || 'linear'}
            onChange={e => onChange(sorted.map((k, i) => i === sel!.ki ? { ...k, ease: e.target.value } : k))}
            className="bg-zinc-800 text-[10px] text-zinc-200 rounded px-1 py-0.5 border border-zinc-700">
            {EASES.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
          <button onClick={() => { onChange(sorted.filter((_, i) => i !== sel!.ki)); setSel(null) }}
            className="text-red-400 hover:text-red-300 px-1">キー削除</button>
          <span className="text-zinc-600 ml-auto">行ダブルクリックでキー追加 / ドラッグで調整</span>
        </div>
      )}
    </div>
  )
}
