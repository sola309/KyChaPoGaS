import { useRef, useState } from 'react'
import type { Clip, Asset } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useUIStore } from '../../store/uiStore'
import { useAnalysisStore } from '../../store/analysisStore'
import { SceneMarkers, MotionHeat } from './SceneMarkers'
import { MotionCanvas } from './MotionCanvas'
import { allKeyframeTimes, removeKeyframe, TPROPS } from '../Preview/transformEval'

const CLIP_COLORS: Record<string, string> = {
  video:     'bg-blue-800 border-blue-600',
  audio:     'bg-green-800 border-green-600',
  image:     'bg-orange-800 border-orange-600',
  generated: 'bg-purple-800 border-purple-600',
}

// Trim handles are widened on touch devices (no precise cursor) so they're
// comfortable to grab with a finger.
const COARSE = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches
const HANDLE_PX = COARSE ? 16 : 6  // trim handle width in px

interface Props {
  clip: Clip
  asset: Asset | undefined
  pixelsPerFrame: number
  trackHeight: number
  onSelect: (id: number) => void
  selected: boolean
  /** Snap a timeline frame to the nearest beat (identity when snapping is off). */
  snapFrame?: (frame: number) => number
  /** Another collaborator has this clip selected (outline color). */
  remoteSelect?: string | null
  /** Another collaborator is actively editing this clip (soft lock). */
  remoteLock?: { name: string; color: string } | null
}

export function ClipBlock({ clip, asset, pixelsPerFrame, trackHeight, onSelect, selected, snapFrame, remoteSelect, remoteLock }: Props) {
  const snap = snapFrame ?? ((f: number) => f)
  const { moveClip, trimClip, deleteClip, projectFps, setEditingClipId, updateClip, setCurrentFrame } = useTimelineStore()
  const openShotEditor = useUIStore(st => st.openShotEditor)
  // mg_shot detection is defensive: fall back to the asset naming convention so a
  // stale cached Clip object (no `kind` field) can never fall into delete-on-dblclick.
  const isMgShot = clip.kind === 'mg_shot' || (asset?.name ?? '').startsWith('shot:')
  const openEditor = () => {
    try {
      const sid = JSON.parse(clip.attrs_json || '{}').shot_id
        ?? (asset?.name ?? '').replace(/^shot:/, '')
      if (sid) openShotEditor(sid)
    } catch { /* noop */ }
  }
  const locked = !!remoteLock
  const { scenes, motion } = useAnalysisStore()

  // Video/audio clips have a finite source (duration_sec); images do not and can
  // be stretched freely (freeze-frame / placeholder). For finite sources the
  // right edge is clamped so a clip never runs past the end of its source.
  const sourceFrames = asset?.duration_sec
    ? Math.max(1, Math.floor(asset.duration_sec * projectFps))
    : null
  const isStretchable = sourceFrames == null   // images stretch without limit
  const assetScenes = asset ? scenes[asset.id] : undefined
  const assetMotion = asset ? motion[asset.id] : undefined
  const dragRef = useRef<{ startX: number; origFrame: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const left  = clip.start_frame * pixelsPerFrame
  const width = Math.max(clip.duration_frames * pixelsPerFrame, HANDLE_PX * 2 + 4)
  const colorClass = CLIP_COLORS[asset?.asset_type ?? 'video']

  // Interactions use Pointer Events so mouse, touch, and pen all work. The
  // draggable surfaces set touch-action:none (below) so a finger-drag edits the
  // clip instead of scrolling the timeline.

  // ── Main body: move ──────────────────────────────────────────────────
  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (locked) return                 // another collaborator is editing this clip
    onSelect(clip.id)
    setEditingClipId(clip.id)
    const origFrame = clip.start_frame
    dragRef.current = { startX: e.clientX, origFrame }
    setDragging(true)

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = snap(Math.max(0, Math.round(dragRef.current.origFrame + dx / pixelsPerFrame)))
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, start_frame: newFrame } : c),
      }))
    }

    const onUp = (ev: PointerEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = snap(Math.max(0, Math.round(dragRef.current.origFrame + dx / pixelsPerFrame)))
      if (newFrame !== dragRef.current.origFrame) {
        moveClip(clip.id, dragRef.current.origFrame, newFrame)
      }
      dragRef.current = null
      setDragging(false)
      setEditingClipId(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ── Left trim handle ─────────────────────────────────────────────────
  const handleLeftTrimDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (locked) return
    onSelect(clip.id)
    setEditingClipId(clip.id)
    const startX      = e.clientX
    const origStart   = clip.start_frame
    const origDur     = clip.duration_frames
    const origAssetIn = clip.asset_in_frame

    const clamp = (dx: number) => {
      const newStart = Math.max(0, snap(origStart + Math.round(dx / pixelsPerFrame)))
      const moved    = newStart - origStart
      return {
        start_frame:     newStart,
        duration_frames: Math.max(1, origDur - moved),
        asset_in_frame:  Math.max(0, origAssetIn + moved),
      }
    }

    const onMove = (ev: PointerEvent) => {
      const vals = clamp(ev.clientX - startX)
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, ...vals } : c),
      }))
    }

    const onUp = (ev: PointerEvent) => {
      const after = clamp(ev.clientX - startX)
      trimClip(clip.id,
        { start_frame: origStart, duration_frames: origDur, asset_in_frame: origAssetIn },
        after,
      )
      setEditingClipId(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ── Right trim handle ────────────────────────────────────────────────
  const handleRightTrimDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (locked) return
    onSelect(clip.id)
    setEditingClipId(clip.id)
    const startX  = e.clientX
    const origDur = clip.duration_frames
    // For finite-source clips, cap at the remaining source frames.
    const maxDur  = sourceFrames != null ? Math.max(1, sourceFrames - clip.asset_in_frame) : Infinity

    const clamp = (dx: number) => {
      // Snap the clip's END (start + duration) to a beat so cuts land on the beat.
      const snappedEnd = snap(clip.start_frame + Math.round(origDur + dx / pixelsPerFrame))
      const dur = snappedEnd - clip.start_frame
      return Math.min(maxDur, Math.max(1, dur))
    }

    const onMove = (ev: PointerEvent) => {
      const dur = clamp(ev.clientX - startX)
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, duration_frames: dur } : c),
      }))
    }

    const onUp = (ev: PointerEvent) => {
      const dur = clamp(ev.clientX - startX)
      trimClip(clip.id,
        { duration_frames: origDur },
        { duration_frames: dur },
      )
      setEditingClipId(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={`absolute top-1 rounded border text-[10px] text-white overflow-hidden select-none
        ${colorClass} ${selected ? 'ring-2 ring-purple-300' : ''} ${dragging ? 'opacity-80' : ''} ${locked ? 'opacity-70' : ''}`}
      style={{
        left, width, height: trackHeight - 8,
        ...(remoteLock ? { outline: `2px solid ${remoteLock.color}`, outlineOffset: '-1px' }
          : remoteSelect ? { outline: `1px dashed ${remoteSelect}`, outlineOffset: '-1px' } : {}),
      }}
      onDoubleClick={() => {
        if (locked) return
        if (isMgShot) openEditor()
        else deleteClip(clip.id)
      }}
      title={remoteLock ? `${remoteLock.name} が編集中`
        : isMgShot ? `${asset?.name ?? 'shot'} — ダブルクリック/✎でショットエディタ`
        : `${asset?.name ?? 'clip'}${isStretchable ? '（静止画: 自由に引き伸ばし可）' : ''} — ダブルクリックで削除`}
    >
      {/* Shot Editor button (mg_shot clips) — single-click, no dblclick ambiguity */}
      {isMgShot && !locked && (
        <button
          className="absolute top-0.5 right-0.5 z-30 w-5 h-5 rounded bg-pink-600/90 hover:bg-pink-500 text-white text-[11px] leading-none flex items-center justify-center"
          title="ショットエディタを開く"
          onClick={e => { e.stopPropagation(); openEditor() }}
          onDoubleClick={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
        >✎</button>
      )}
      {/* Remote editor lock badge */}
      {remoteLock && (
        <span
          className="absolute -top-3 left-0 text-[8px] leading-tight px-0.5 rounded-sm text-black whitespace-nowrap z-30"
          style={{ background: remoteLock.color }}
        >🔒 {remoteLock.name}</span>
      )}
      {/* Filmstrip background (video clips) */}
      {asset && (asset.asset_type === 'video' || (asset.asset_type === 'generated' && asset.duration_sec != null)) && (
        <div
          className="absolute inset-0 opacity-45 pointer-events-none bg-no-repeat"
          style={{ backgroundImage: `url(${assetsApi.filmstripUrl(asset.id)})`, backgroundSize: '100% 100%' }}
        />
      )}

      {/* Motion waveform (フレーム差分量 — 音声波形の動画版) */}
      {asset && (asset.asset_type === 'video' || (asset.asset_type === 'generated' && asset.duration_sec != null)) && (
        <MotionCanvas
          assetId={asset.id}
          assetInFrame={clip.asset_in_frame}
          durationFrames={clip.duration_frames}
          speed={clip.speed || 1}
          projectFps={projectFps}
          width={Math.round(width)}
          height={Math.max(8, Math.round((trackHeight - 8) * 0.45))}
        />
      )}

      {/* キーフレーム◆マーカー(選択時のみ): クリック=ジャンプ / Shift+クリック=削除 */}
      {selected && allKeyframeTimes(clip.transform_json ?? '').map(kt => (
        <div key={kt}
          className="absolute z-20 w-2.5 h-2.5 rotate-45 bg-purple-300 border border-purple-600 cursor-pointer hover:bg-white"
          style={{ left: kt * width - 5, bottom: 1 }}
          title={`キーフレーム ${(kt * 100).toFixed(0)}% (Shift+クリックで削除)`}
          onClick={e => {
            e.stopPropagation()
            if (e.shiftKey) {
              let tj = clip.transform_json ?? ''
              for (const p of TPROPS) tj = removeKeyframe(tj, p, kt)
              updateClip(clip.id, { transform_json: tj })
            } else {
              setCurrentFrame(clip.start_frame + Math.round(kt * clip.duration_frames))
            }
          }}
        />
      ))}

      {/* Transition-in indicator (◣ at the head of the clip) */}
      {clip.transition_in && (
        <div
          className="absolute left-0 top-0 bottom-0 pointer-events-none z-[5]"
          style={{
            width: Math.max(6, clip.transition_frames * pixelsPerFrame),
            background: clip.transition_in === 'white'
              ? 'linear-gradient(to right, rgba(255,255,255,0.75), transparent)'
              : clip.transition_in === 'black'
              ? 'linear-gradient(to right, rgba(0,0,0,0.85), transparent)'
              : 'linear-gradient(to right, rgba(238,152,168,0.7), transparent)',
          }}
          title={`遷移: ${clip.transition_in}`}
        />
      )}

      {/* Left trim handle */}
      <div
        className="clip-trim-handle absolute left-0 top-0 bottom-0 z-10 cursor-ew-resize bg-white/0 hover:bg-white/25 transition-colors"
        style={{ width: HANDLE_PX, touchAction: 'none' }}
        onPointerDown={handleLeftTrimDown}
      />

      {/* Label (main drag area) */}
      <div
        className={`absolute inset-0 px-2 py-0.5 flex items-center cursor-grab ${dragging ? 'cursor-grabbing' : ''}`}
        style={{ left: HANDLE_PX, right: HANDLE_PX, touchAction: 'none' }}
        onPointerDown={handlePointerDown}
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
        className="clip-trim-handle absolute right-0 top-0 bottom-0 z-10 cursor-ew-resize bg-white/0 hover:bg-white/25 transition-colors"
        style={{ width: HANDLE_PX, touchAction: 'none' }}
        onPointerDown={handleRightTrimDown}
      />
    </div>
  )
}
