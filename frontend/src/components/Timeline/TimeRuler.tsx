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

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const x = e.nativeEvent.offsetX
    onSeek(Math.round(x / pixelsPerFrame))
  }

  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
  }

  return (
    <div
      className="relative h-7 bg-zinc-900 border-b border-zinc-700 select-none cursor-pointer flex-shrink-0"
      style={{ width: totalWidth }}
      onClick={handleClick}
    >
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
