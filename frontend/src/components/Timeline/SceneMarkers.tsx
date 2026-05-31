import { useMemo } from 'react'
import type { SceneAnalysis, MotionAnalysis } from '../../api/client'

interface SceneMarkersProps {
  scenes: SceneAnalysis
  /** Start frame of the video clip on the timeline */
  clipStartFrame: number
  assetInFrame: number
  clipDurationFrames: number
  pixelsPerFrame: number
  fps: number
}

export function SceneMarkers({
  scenes,
  clipStartFrame,
  assetInFrame,
  clipDurationFrames,
  pixelsPerFrame,
  fps,
}: SceneMarkersProps) {
  const assetInSec = assetInFrame / fps
  const clipDurSec = clipDurationFrames / fps

  const markers = useMemo(() =>
    scenes.scenes
      .map(s => {
        const relSec = s.start_sec - assetInSec
        if (relSec <= 0 || relSec > clipDurSec) return null
        return { x: relSec * fps * pixelsPerFrame }
      })
      .filter(Boolean) as Array<{ x: number }>
  , [scenes, assetInSec, clipDurSec, fps, pixelsPerFrame])

  return (
    <>
      {markers.map(({ x }, i) => (
        <div
          key={i}
          className="absolute top-0 bottom-0 w-px bg-sky-400/60 pointer-events-none"
          style={{ left: x }}
          title="シーン変換"
        />
      ))}
    </>
  )
}

interface MotionHeatProps {
  motion: MotionAnalysis
  clipStartFrame: number
  assetInFrame: number
  clipDurationFrames: number
  pixelsPerFrame: number
  fps: number
  clipWidth: number
}

export function MotionHeat({
  motion,
  assetInFrame,
  clipDurationFrames,
  pixelsPerFrame,
  fps,
  clipWidth,
}: MotionHeatProps) {
  const assetInSec = assetInFrame / fps
  const clipDurSec = clipDurationFrames / fps
  const peak = motion.peak_intensity || 1

  const bars = useMemo(() =>
    motion.segments
      .map(seg => {
        const relStart = seg.start_sec - assetInSec
        const relEnd   = seg.end_sec   - assetInSec
        if (relEnd <= 0 || relStart >= clipDurSec) return null
        const x = Math.max(0, relStart) * fps * pixelsPerFrame
        const w = (Math.min(relEnd, clipDurSec) - Math.max(relStart, 0)) * fps * pixelsPerFrame
        const alpha = Math.min(0.5, (seg.intensity / peak) * 0.5)
        return { x, w, alpha }
      })
      .filter(Boolean) as Array<{ x: number; w: number; alpha: number }>
  , [motion, assetInSec, clipDurSec, fps, pixelsPerFrame])

  return (
    <>
      {bars.map(({ x, w, alpha }, i) => (
        <div
          key={i}
          className="absolute bottom-0 pointer-events-none"
          style={{
            left: x,
            width: Math.max(1, w),
            height: '30%',
            backgroundColor: `rgba(251,113,133,${alpha})`,
          }}
        />
      ))}
    </>
  )
}
