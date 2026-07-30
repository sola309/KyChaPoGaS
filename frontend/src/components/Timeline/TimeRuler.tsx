import { useMemo } from 'react'

interface Props {
  pixelsPerFrame: number
  fps: number
  totalWidth: number
  currentFrame: number
  onSeek: (frame: number) => void
}

export function TimeRuler({ pixelsPerFrame, fps, totalWidth, currentFrame, onSeek }: Props) {
  const pixelsPerSecond = pixelsPerFrame * fps

  const marks = useMemo(() => {
    const interval = pixelsPerSecond >= 80 ? 1
      : pixelsPerSecond >= 20 ? 5
      : pixelsPerSecond >= 8  ? 10
      : 30
    const count = Math.ceil(totalWidth / pixelsPerSecond / interval) + 1
    return Array.from({ length: count }, (_, i) => i * interval)
  }, [pixelsPerSecond, totalWidth])

  // ズーム時のフレーム目盛り: 1フレーム≥6pxで全フレーム、≥2.5pxで5フレームごと
  const frameTicks = useMemo(() => {
    const step = pixelsPerFrame >= 6 ? 1 : pixelsPerFrame >= 2.5 ? 5 : 0
    if (!step) return { step: 0, frames: [] as number[] }
    const total = Math.ceil(totalWidth / pixelsPerFrame)
    const frames: number[] = []
    for (let f = 0; f <= total; f += step) {
      if (f % fps !== 0) frames.push(f)   // 秒目盛りと重なる位置は除外
    }
    return { step, frames }
  }, [pixelsPerFrame, totalWidth, fps])

  // press-and-drag scrubbing (pointer events → mouse and touch both work)
  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    onSeek(Math.max(0, Math.round(x / pixelsPerFrame)))
  }
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    scrub(e)
  }
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons & 1) scrub(e)
  }

  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
  }

  return (
    <div
      className="relative h-7 bg-zinc-900 border-b border-zinc-700 select-none cursor-ew-resize flex-shrink-0"
      style={{ width: totalWidth, touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
    >
      {/* フレーム単位の小目盛り(ズーム時のみ) */}
      {frameTicks.frames.map(f => (
        <div
          key={`f${f}`}
          className={`absolute top-0 w-px ${f % 5 === 0 ? 'h-2 bg-zinc-700' : 'h-1 bg-zinc-800'}`}
          style={{ left: f * pixelsPerFrame }}
        />
      ))}
      {/* フレーム番号(十分ズームした時のみ、5フレームごと) */}
      {pixelsPerFrame >= 14 && frameTicks.frames.filter(f => f % 5 === 0).map(f => (
        <span
          key={`fl${f}`}
          className="absolute top-2.5 text-[8px] text-zinc-600 leading-none pointer-events-none"
          style={{ left: f * pixelsPerFrame + 1 }}
        >{f}</span>
      ))}
      {marks.map(sec => (
        <div
          key={sec}
          className="absolute top-0 flex flex-col items-start"
          style={{ left: sec * pixelsPerSecond }}
        >
          <div className="w-px h-3 bg-zinc-600" />
          <span className="text-[9px] text-zinc-500 pl-0.5 leading-none mt-0.5">{fmt(sec)}</span>
        </div>
      ))}
      {/* Playhead marker on ruler */}
      <div
        className="absolute top-0 w-px h-full bg-purple-400 pointer-events-none"
        style={{ left: currentFrame * pixelsPerFrame }}
      />
    </div>
  )
}
