import { useEffect, useRef, useState, useCallback } from 'react'
import type { Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { TimeRuler } from './TimeRuler'
import { TrackLane, TRACK_HEIGHT } from './TrackLane'

const LABEL_WIDTH = 112  // px, must match TrackLane w-28 (7rem = 112px)
const MIN_TIMELINE_SECS = 60

interface Props {
  projectId: number
  fps: number
  assets: Asset[]
}

export function Timeline({ projectId, fps, assets }: Props) {
  const {
    tracks, clips, currentFrame, pixelsPerFrame,
    loadTimeline, addTrack, addClip, setCurrentFrame, setZoom,
  } = useTimelineStore()

  const scrollRef = useRef<HTMLDivElement>(null)
  const [selectedClipId, setSelectedClipId] = useState<number | null>(null)

  useEffect(() => { loadTimeline(projectId, fps) }, [projectId, fps])

  const totalFrames = Math.max(
    MIN_TIMELINE_SECS * fps,
    ...clips.map(c => c.start_frame + c.duration_frames),
  ) + fps * 10

  const totalWidth = Math.ceil(totalFrames * pixelsPerFrame)

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.85 : 1.18
      setZoom(pixelsPerFrame * delta)
    }
  }, [pixelsPerFrame, setZoom])

  const handleDropAsset = async (trackId: number, assetId: number, startFrame: number) => {
    const asset = assets.find(a => a.id === assetId)
    const durationFrames = asset?.duration_sec
      ? Math.round(asset.duration_sec * fps)
      : fps * 5
    await addClip(trackId, assetId, startFrame, durationFrames)
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 select-none">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
        <button
          onClick={() => addTrack(projectId, 'video', `Video ${tracks.filter(t => t.track_type === 'video').length + 1}`)}
          className="text-[11px] px-2 py-0.5 rounded bg-blue-900 hover:bg-blue-800 text-blue-200"
        >+ Video</button>
        <button
          onClick={() => addTrack(projectId, 'audio', `Audio ${tracks.filter(t => t.track_type === 'audio').length + 1}`)}
          className="text-[11px] px-2 py-0.5 rounded bg-green-900 hover:bg-green-800 text-green-200"
        >+ Audio</button>
        <span className="text-zinc-600 text-[10px] ml-2">Ctrl+Wheel でズーム｜アセットをドロップでクリップ追加</span>
        <span className="ml-auto text-[11px] text-zinc-400 font-mono">
          {String(Math.floor(currentFrame / fps / 60)).padStart(2,'0')}:
          {String(Math.floor(currentFrame / fps) % 60).padStart(2,'0')}:
          {String(currentFrame % fps).padStart(2,'0')}
          <span className="text-zinc-600"> f{currentFrame}</span>
        </span>
      </div>

      {/* Scrollable area */}
      <div className="flex-1 overflow-auto" ref={scrollRef} onWheel={handleWheel}>
        <div className="flex flex-col min-h-full">
          {/* Ruler row */}
          <div className="flex flex-shrink-0 sticky top-0 z-10 bg-zinc-900">
            <div className="w-28 flex-shrink-0 border-r border-b border-zinc-700 bg-zinc-900" />
            <TimeRuler
              pixelsPerFrame={pixelsPerFrame}
              fps={fps}
              totalWidth={totalWidth}
              currentFrame={currentFrame}
              onSeek={setCurrentFrame}
            />
          </div>

          {/* Track lanes */}
          {tracks.map(track => (
            <TrackLane
              key={track.id}
              track={track}
              clips={clips.filter(c => c.track_id === track.id)}
              assets={assets}
              pixelsPerFrame={pixelsPerFrame}
              totalWidth={totalWidth}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onDropAsset={handleDropAsset}
            />
          ))}

          {/* Empty state */}
          {tracks.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-zinc-700 text-sm py-8">
              「+ Video」または「+ Audio」でトラックを追加
            </div>
          )}

          {/* Playhead overlay — full height */}
          <div
            className="absolute top-0 bottom-0 w-px bg-purple-500/60 pointer-events-none"
            style={{ left: LABEL_WIDTH + currentFrame * pixelsPerFrame }}
          />
        </div>
      </div>
    </div>
  )
}
