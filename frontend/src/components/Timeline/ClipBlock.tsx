import { useRef, useState } from 'react'
import type { Clip, Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useAnalysisStore } from '../../store/analysisStore'
import { SceneMarkers, MotionHeat } from './SceneMarkers'

const CLIP_COLORS: Record<string, string> = {
  video:     'bg-blue-800 border-blue-600',
  audio:     'bg-green-800 border-green-600',
  image:     'bg-orange-800 border-orange-600',
  generated: 'bg-purple-800 border-purple-600',
}

const HANDLE_PX = 6  // trim handle width in px

interface Props {
  clip: Clip
  asset: Asset | undefined
  pixelsPerFrame: number
  trackHeight: number
  onSelect: (id: number) => void
  selected: boolean
}

export function ClipBlock({ clip, asset, pixelsPerFrame, trackHeight, onSelect, selected }: Props) {
  const { moveClip, trimClip, deleteClip } = useTimelineStore()
  const { scenes, motion } = useAnalysisStore()
  const assetScenes = asset ? scenes[asset.id] : undefined
  const assetMotion = asset ? motion[asset.id] : undefined
  const dragRef = useRef<{ startX: number; origFrame: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const left  = clip.start_frame * pixelsPerFrame
  const width = Math.max(clip.duration_frames * pixelsPerFrame, HANDLE_PX * 2 + 4)
  const colorClass = CLIP_COLORS[asset?.asset_type ?? 'video']

  // ── Main body: move ──────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect(clip.id)
    const origFrame = clip.start_frame
    dragRef.current = { startX: e.clientX, origFrame }
    setDragging(true)

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = Math.max(0, Math.round(dragRef.current.origFrame + dx / pixelsPerFrame))
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, start_frame: newFrame } : c),
      }))
    }

    const onUp = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = Math.max(0, Math.round(dragRef.current.origFrame + dx / pixelsPerFrame))
      if (newFrame !== dragRef.current.origFrame) {
        moveClip(clip.id, dragRef.current.origFrame, newFrame)
      }
      dragRef.current = null
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ── Left trim handle ─────────────────────────────────────────────────
  const handleLeftTrimDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect(clip.id)
    const startX      = e.clientX
    const origStart   = clip.start_frame
    const origDur     = clip.duration_frames
    const origAssetIn = clip.asset_in_frame

    const clamp = (dx: number) => {
      const delta    = Math.round(dx / pixelsPerFrame)
      const newStart = Math.max(0, origStart + delta)
      const moved    = newStart - origStart
      return {
        start_frame:     newStart,
        duration_frames: Math.max(1, origDur - moved),
        asset_in_frame:  Math.max(0, origAssetIn + moved),
      }
    }

    const onMove = (ev: MouseEvent) => {
      const vals = clamp(ev.clientX - startX)
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, ...vals } : c),
      }))
    }

    const onUp = (ev: MouseEvent) => {
      const after = clamp(ev.clientX - startX)
      trimClip(clip.id,
        { start_frame: origStart, duration_frames: origDur, asset_in_frame: origAssetIn },
        after,
      )
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ── Right trim handle ────────────────────────────────────────────────
  const handleRightTrimDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect(clip.id)
    const startX  = e.clientX
    const origDur = clip.duration_frames

    const clamp = (dx: number) => Math.max(1, Math.round(origDur + dx / pixelsPerFrame))

    const onMove = (ev: MouseEvent) => {
      const dur = clamp(ev.clientX - startX)
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, duration_frames: dur } : c),
      }))
    }

    const onUp = (ev: MouseEvent) => {
      const dur = clamp(ev.clientX - startX)
      trimClip(clip.id,
        { duration_frames: origDur },
        { duration_frames: dur },
      )
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`absolute top-1 rounded border text-[10px] text-white overflow-hidden select-none
        ${colorClass} ${selected ? 'ring-1 ring-white' : ''} ${dragging ? 'opacity-80' : ''}`}
      style={{ left, width, height: trackHeight - 8 }}
      onDoubleClick={() => deleteClip(clip.id)}
      title={`${asset?.name ?? 'clip'} — ダブルクリックで削除`}
    >
      {/* Left trim handle */}
      <div
        className="absolute left-0 top-0 bottom-0 z-10 cursor-ew-resize bg-white/0 hover:bg-white/25 transition-colors"
        style={{ width: HANDLE_PX }}
        onMouseDown={handleLeftTrimDown}
      />

      {/* Label (main drag area) */}
      <div
        className={`absolute inset-0 px-2 py-0.5 flex items-center cursor-grab ${dragging ? 'cursor-grabbing' : ''}`}
        style={{ left: HANDLE_PX, right: HANDLE_PX }}
        onMouseDown={handleMouseDown}
      >
        <span className="truncate leading-tight">
          {asset?.name ?? `clip ${clip.id}`}
        </span>
      </div>

      {/* Scene change markers (video clips) */}
      {assetScenes && (
        <SceneMarkers
          scenes={assetScenes}
          assetInFrame={clip.asset_in_frame}
          clipDurationFrames={clip.duration_frames}
          pixelsPerFrame={pixelsPerFrame}
          fps={24}
        />
      )}

      {/* Motion heat overlay (video clips) */}
      {assetMotion && (
        <MotionHeat
          motion={assetMotion}
          assetInFrame={clip.asset_in_frame}
          clipDurationFrames={clip.duration_frames}
          pixelsPerFrame={pixelsPerFrame}
          fps={24}
        />
      )}

      {/* Right trim handle */}
      <div
        className="absolute right-0 top-0 bottom-0 z-10 cursor-ew-resize bg-white/0 hover:bg-white/25 transition-colors"
        style={{ width: HANDLE_PX }}
        onMouseDown={handleRightTrimDown}
      />
    </div>
  )
}
