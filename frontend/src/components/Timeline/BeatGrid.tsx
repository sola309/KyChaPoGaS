import { useMemo } from 'react'
import type { BeatAnalysis } from '../../api/client'

interface Props {
  beat: BeatAnalysis
  /** Start frame of the audio clip on the timeline */
  clipStartFrame: number
  /** In-point of the clip within the asset (frames) */
  assetInFrame: number
  pixelsPerFrame: number
  fps: number
  totalWidth: number
}

export function BeatGrid({
  beat,
  clipStartFrame,
  assetInFrame,
  pixelsPerFrame,
  fps,
  totalWidth,
}: Props) {
  const assetInSec = assetInFrame / fps

  const { beatPx, downbeatSet } = useMemo(() => {
    const downbeatSet = new Set(beat.downbeats.map(t => Math.round(t * 1000)))
    const beatPx = beat.beats
      .map(t => {
        // Offset: the clip starts at clipStartFrame on timeline, and its first frame
        // corresponds to assetInSec into the asset.
        const effectiveSec = t - assetInSec
        if (effectiveSec < 0) return null
        const x = clipStartFrame * pixelsPerFrame + effectiveSec * fps * pixelsPerFrame
        if (x > totalWidth) return null
        return { x, isDown: downbeatSet.has(Math.round(t * 1000)) }
      })
      .filter(Boolean) as Array<{ x: number; isDown: boolean }>
    return { beatPx, downbeatSet }
  }, [beat, clipStartFrame, assetInFrame, pixelsPerFrame, fps, totalWidth])

  if (beatPx.length === 0) return null

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {beatPx.map(({ x, isDown }, i) => (
        <div
          key={i}
          className={`absolute top-0 w-px ${isDown ? 'bg-amber-400/80 h-full' : 'bg-emerald-400/40 h-2/3'}`}
          style={{ left: x }}
        />
      ))}
    </div>
  )
}

/** Compact beat ruler strip (placed between time ruler and first track). */
export function BeatRuler({
  beat,
  clipStartFrame,
  assetInFrame,
  pixelsPerFrame,
  fps,
  totalWidth,
}: Props) {
  const assetInSec = assetInFrame / fps

  const items = useMemo(() => {
    const downSet = new Set(beat.downbeats.map(t => Math.round(t * 1000)))
    return beat.beats
      .map((t, i) => {
        const effectiveSec = t - assetInSec
        if (effectiveSec < 0) return null
        const x = clipStartFrame * pixelsPerFrame + effectiveSec * fps * pixelsPerFrame
        if (x > totalWidth) return null
        const isDown = downSet.has(Math.round(t * 1000))
        return { x, isDown, i }
      })
      .filter(Boolean) as Array<{ x: number; isDown: boolean; i: number }>
  }, [beat, clipStartFrame, assetInFrame, pixelsPerFrame, fps, totalWidth])

  return (
    <div
      className="relative bg-zinc-950/80 border-b border-zinc-800 flex-shrink-0 select-none overflow-hidden"
      style={{ height: 14, width: totalWidth }}
      title={`${beat.bpm.toFixed(1)} BPM — ${beat.beats.length} beats`}
    >
      {items.map(({ x, isDown, i }) => (
        <div
          key={i}
          className={`absolute bottom-0 w-px ${isDown ? 'h-full bg-amber-400/70' : 'h-2/3 bg-emerald-400/35'}`}
          style={{ left: x }}
        />
      ))}
      {/* BPM label */}
      <span className="absolute right-1 top-0 text-[9px] text-zinc-500 leading-none mt-0.5">
        {beat.bpm.toFixed(0)} BPM
      </span>
    </div>
  )
}
