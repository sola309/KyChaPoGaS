import { useEffect, useRef, useState, useCallback } from 'react'
import type { Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { TimeRuler } from './TimeRuler'
import { TrackLane } from './TrackLane'

const LABEL_WIDTH = 112  // px — must match TrackLane w-28 (7rem = 112px)
const MIN_TIMELINE_SECS = 60

interface Props {
  projectId: number
  fps: number
  assets: Asset[]
}

export function Timeline({ projectId, fps, assets }: Props) {
  const {
    tracks, clips, currentFrame, pixelsPerFrame,
    canUndo, canRedo, undoStack, redoStack,
    loadTimeline, addTrack, addClip, splitClip,
    deleteClip, setCurrentFrame, setZoom, undo, redo,
  } = useTimelineStore()

  const scrollRef     = useRef<HTMLDivElement>(null)
  const containerRef  = useRef<HTMLDivElement>(null)
  const [selectedClipId, setSelectedClipId] = useState<number | null>(null)

  useEffect(() => { loadTimeline(projectId, fps) }, [projectId, fps])

  const totalFrames = Math.max(
    MIN_TIMELINE_SECS * fps,
    ...clips.map(c => c.start_frame + c.duration_frames),
  ) + fps * 10

  const totalWidth = Math.ceil(totalFrames * pixelsPerFrame)

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey

    if (ctrl && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
      return
    }
    if ((ctrl && e.key === 'y') || (ctrl && e.shiftKey && e.key === 'z')) {
      e.preventDefault()
      redo()
      return
    }
    if ((e.key === 's' || e.key === 'S') && !ctrl) {
      if (selectedClipId !== null) {
        splitClip(selectedClipId, currentFrame)
      }
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedClipId !== null) {
        deleteClip(selectedClipId)
        setSelectedClipId(null)
      }
    }
  }, [selectedClipId, currentFrame, splitClip, deleteClip, undo, redo])

  // ── Wheel zoom ────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.85 : 1.18
      setZoom(pixelsPerFrame * delta)
    }
  }, [pixelsPerFrame, setZoom])

  // ── Drop asset ────────────────────────────────────────────────────────
  const handleDropAsset = async (trackId: number, assetId: number, startFrame: number) => {
    const asset = assets.find(a => a.id === assetId)
    const durationFrames = asset?.duration_sec
      ? Math.round(asset.duration_sec * fps)
      : fps * 5
    await addClip(trackId, assetId, startFrame, durationFrames)
  }

  const undoLabel = undoStack.length > 0 ? undoStack[undoStack.length - 1].label : ''
  const redoLabel = redoStack.length > 0 ? redoStack[redoStack.length - 1].label : ''

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full bg-zinc-950 select-none outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-900 flex-shrink-0 flex-wrap">
        <button
          onClick={() => addTrack(projectId, 'video', `Video ${tracks.filter(t => t.track_type === 'video').length + 1}`)}
          className="text-[11px] px-2 py-0.5 rounded bg-blue-900 hover:bg-blue-800 text-blue-200"
        >+ Video</button>
        <button
          onClick={() => addTrack(projectId, 'audio', `Audio ${tracks.filter(t => t.track_type === 'audio').length + 1}`)}
          className="text-[11px] px-2 py-0.5 rounded bg-green-900 hover:bg-green-800 text-green-200"
        >+ Audio</button>
        <button
          onClick={() => addTrack(projectId, 'reference', `Ref ${tracks.filter(t => t.track_type === 'reference').length + 1}`)}
          className="text-[11px] px-2 py-0.5 rounded bg-amber-900 hover:bg-amber-800 text-amber-200"
          title="参照キーフレームトラック（I2V生成用）"
        >+ Ref</button>

        <div className="w-px h-4 bg-zinc-700 mx-1" />

        {/* Undo / Redo */}
        <button
          onClick={() => undo()}
          disabled={!canUndo}
          title={canUndo ? `元に戻す: ${undoLabel}` : ''}
          className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed"
        >↩ 元に戻す</button>
        <button
          onClick={() => redo()}
          disabled={!canRedo}
          title={canRedo ? `やり直す: ${redoLabel}` : ''}
          className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed"
        >↪ やり直す</button>

        {selectedClipId !== null && (
          <>
            <div className="w-px h-4 bg-zinc-700 mx-1" />
            <button
              onClick={() => { splitClip(selectedClipId, currentFrame) }}
              className="text-[11px] px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
              title="再生ヘッドでクリップを分割 (S)"
            >✂ 分割</button>
            <button
              onClick={() => { deleteClip(selectedClipId); setSelectedClipId(null) }}
              className="text-[11px] px-2 py-0.5 rounded bg-red-900 hover:bg-red-800 text-red-200"
              title="クリップを削除 (Del)"
            >✕ 削除</button>
          </>
        )}

        <span className="text-zinc-600 text-[10px] ml-auto hidden sm:inline">
          S=分割　Del=削除　Ctrl+Z=元に戻す　Ctrl+Wheel=ズーム
        </span>

        <span className="text-[11px] text-zinc-400 font-mono ml-2">
          {String(Math.floor(currentFrame / fps / 60)).padStart(2, '0')}:
          {String(Math.floor(currentFrame / fps) % 60).padStart(2, '0')}:
          {String(currentFrame % fps).padStart(2, '0')}
          <span className="text-zinc-600"> f{currentFrame}</span>
        </span>
      </div>

      {/* Scrollable area */}
      <div className="flex-1 overflow-auto" ref={scrollRef} onWheel={handleWheel}>
        <div className="flex flex-col min-h-full relative">
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

          {tracks.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-zinc-700 text-sm py-8">
              「+ Video」または「+ Audio」でトラックを追加
            </div>
          )}

          {/* Playhead — full height */}
          <div
            className="absolute top-0 bottom-0 w-px bg-purple-500/60 pointer-events-none"
            style={{ left: LABEL_WIDTH + currentFrame * pixelsPerFrame }}
          />
        </div>
      </div>
    </div>
  )
}
