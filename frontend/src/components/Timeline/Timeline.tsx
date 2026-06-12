import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { Asset, TransitionType } from '../../api/client'
import { clipsApi, jobsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useAnalysisStore } from '../../store/analysisStore'
import { useCollabStore } from '../../store/collabStore'
import { useUIStore } from '../../store/uiStore'
import { TimeRuler } from './TimeRuler'
import { BeatRuler } from './BeatGrid'
import { TrackLane } from './TrackLane'
import { RenderDialog } from '../RenderDialog'

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
    deleteClip, setCurrentFrame, setZoom, undo, redo, setClipSpeed, updateClip,
    selectedClipId, setSelectedClipId, syncFromServer,
  } = useTimelineStore()

  const scrollRef      = useRef<HTMLDivElement>(null)
  const containerRef   = useRef<HTMLDivElement>(null)
  const [showRenderDialog, setShowRenderDialog] = useState(false)
  const [snapEnabled, setSnapEnabled] = useState(true)

  const { beats } = useAnalysisStore()
  const remoteUsers = useCollabStore(s => s.others)

  useEffect(() => { loadTimeline(projectId, fps) }, [projectId, fps])

  // Find the first audio clip that has beat analysis
  const beatInfo = useMemo(() => {
    for (const clip of clips) {
      if (!clip.asset_id) continue
      const b = beats[clip.asset_id]
      if (b) return { beat: b, clip }
    }
    return null
  }, [clips, beats])

  // Beat positions in timeline-frame space (for beat-snapping clip edges)
  const beatFrames = useMemo(() => {
    if (!beatInfo) return [] as number[]
    const assetInSec = beatInfo.clip.asset_in_frame / fps
    return beatInfo.beat.beats
      .map(t => Math.round(beatInfo.clip.start_frame + (t - assetInSec) * fps))
      .filter(f => f >= 0)
  }, [beatInfo, fps])

  // Snap a frame to the nearest beat within ~8px; identity when snapping is off.
  const snapFrame = useCallback((frame: number) => {
    if (!snapEnabled || beatFrames.length === 0) return frame
    const threshold = 8 / pixelsPerFrame
    let best = frame, bestDist = threshold
    for (const bf of beatFrames) {
      const d = Math.abs(bf - frame)
      if (d < bestDist) { bestDist = d; best = bf }
    }
    return best
  }, [snapEnabled, beatFrames, pixelsPerFrame])

  // Selected clip — for speed controls (video clips only)
  const selectedClip = clips.find(c => c.id === selectedClipId) ?? null
  const selTrack = selectedClip ? tracks.find(t => t.id === selectedClip.track_id) : null
  const selAsset = selectedClip ? assets.find(a => a.id === selectedClip.asset_id) : null
  const isVideoClip = selTrack?.track_type === 'video'
    && (selAsset?.asset_type === 'video'
        || (selAsset?.asset_type === 'generated' && selAsset?.duration_sec != null))

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

  const handleAutoCut = async () => {
    if (selectedClipId == null) return
    try {
      const res = await clipsApi.autoCutBeats(selectedClipId)
      await syncFromServer(projectId)
      useCollabStore.getState().broadcastEdit()
      useUIStore.getState().pushToast(
        res.created > 0 ? `ビートで ${res.created} 分割しました` : (res.message ?? 'ビートが見つかりません'),
        res.created > 0 ? 'success' : 'info',
      )
      setSelectedClipId(null)
    } catch { /* error toast handled by interceptor */ }
  }

  const handlePrecompose = async () => {
    try {
      await jobsApi.create(projectId, 'precompose', { project_id: projectId })
      useUIStore.getState().pushToast('タイムラインの焼き込みを開始しました（完了後ライブラリに追加）', 'info')
    } catch { /* handled by interceptor */ }
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

        <button
          onClick={() => setSnapEnabled(v => !v)}
          disabled={!beatInfo}
          title={beatInfo ? 'ビートスナップ（クリップ端をビートに吸着）' : '音声のビート解析後に有効'}
          className={`text-[11px] px-2 py-0.5 rounded disabled:opacity-30
            ${snapEnabled && beatInfo
              ? 'bg-emerald-800 text-emerald-100'
              : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
        >🧲 音ハメ{snapEnabled ? 'ON' : 'OFF'}</button>

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

            {isVideoClip && beatInfo && (
              <button
                onClick={handleAutoCut}
                className="text-[11px] px-2 py-0.5 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-200"
                title="クリップ範囲のビートで自動分割（音ハメ）"
              >🎵 ビートで分割</button>
            )}

            {/* Transition into this clip (rendered on the primary video track) */}
            {selTrack?.track_type === 'video' && selectedClip && (
              <>
                <div className="w-px h-4 bg-zinc-700 mx-1" />
                <span className="text-[10px] text-zinc-500">遷移</span>
                <select
                  value={selectedClip.transition_in ?? ''}
                  onChange={e => {
                    const t = e.target.value as TransitionType
                    updateClip(selectedClip.id, {
                      transition_in: t,
                      transition_frames: t ? (selectedClip.transition_frames || Math.round(fps * 0.27)) : 0,
                    })
                  }}
                  className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                  title="前のクリップからの遷移（書き出しに反映・尺は変わらず音ズレしない）"
                >
                  <option value="">カット</option>
                  <option value="cross">クロス</option>
                  <option value="white">白フラッシュ</option>
                  <option value="black">黒</option>
                </select>
                {selectedClip.transition_in && (
                  <select
                    value={String(selectedClip.transition_frames)}
                    onChange={e => updateClip(selectedClip.id, { transition_frames: Number(e.target.value) })}
                    className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                    title="遷移の長さ"
                  >
                    {[
                      [Math.max(2, Math.round(fps * 0.13)), '0.13s'],
                      [Math.round(fps * 0.27), '0.27s'],
                      [Math.round(fps * 0.5),  '0.5s'],
                      [Math.round(fps * 1.0),  '1s'],
                    ].map(([f, label]) => (
                      <option key={String(label)} value={String(f)}>{label}</option>
                    ))}
                    {![Math.max(2, Math.round(fps * 0.13)), Math.round(fps * 0.27), Math.round(fps * 0.5), Math.round(fps * 1.0)]
                      .includes(selectedClip.transition_frames) && (
                      <option value={String(selectedClip.transition_frames)}>
                        {(selectedClip.transition_frames / fps).toFixed(2)}s
                      </option>
                    )}
                  </select>
                )}
              </>
            )}

            {/* Audio fades */}
            {selTrack?.track_type === 'audio' && selectedClip && (
              <>
                <div className="w-px h-4 bg-zinc-700 mx-1" />
                {([['fade_in_frames', 'フェードIN'], ['fade_out_frames', 'フェードOUT']] as const).map(([key, label]) => (
                  <span key={key} className="flex items-center gap-1">
                    <span className="text-[10px] text-zinc-500">{label}</span>
                    <select
                      value={String(selectedClip[key] ?? 0)}
                      onChange={e => updateClip(selectedClip.id, { [key]: Number(e.target.value) })}
                      className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                      title="音声フェード（書き出しに反映）"
                    >
                      {[[0, 'なし'], [Math.round(fps * 0.5), '0.5s'], [fps, '1s'], [fps * 2, '2s'], [fps * 4, '4s']].map(([f, l]) => (
                        <option key={String(l)} value={String(f)}>{l}</option>
                      ))}
                      {![0, Math.round(fps * 0.5), fps, fps * 2, fps * 4].includes(selectedClip[key] ?? 0) && (
                        <option value={String(selectedClip[key])}>{((selectedClip[key] ?? 0) / fps).toFixed(1)}s</option>
                      )}
                    </select>
                  </span>
                ))}
              </>
            )}

            {isVideoClip && selectedClip && (
              <>
                <div className="w-px h-4 bg-zinc-700 mx-1" />
                <span className="text-[10px] text-zinc-500">速度</span>
                <select
                  value={String(selectedClip.speed)}
                  onChange={e => setClipSpeed(selectedClip.id, Number(e.target.value), selectedClip.speed_ease)}
                  className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                  title="再生速度（フレーム数は自動調整）"
                >
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(s => (
                    <option key={s} value={String(s)}>{s}x</option>
                  ))}
                  {![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(selectedClip.speed) && (
                    <option value={String(selectedClip.speed)}>{selectedClip.speed.toFixed(2)}x</option>
                  )}
                </select>
                <select
                  value={selectedClip.speed_ease}
                  onChange={e => setClipSpeed(selectedClip.id, selectedClip.speed, e.target.value as 'linear' | 'in' | 'out' | 'inout')}
                  className="text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
                  title="加減速（ベジェ）: 一定 / 加速 / 減速 / 緩急"
                >
                  <option value="linear">一定</option>
                  <option value="in">加速</option>
                  <option value="out">減速</option>
                  <option value="inout">緩急</option>
                </select>
              </>
            )}
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Zoom (touch-friendly — no Ctrl+wheel needed) */}
          <div className="flex items-center">
            <button
              onClick={() => setZoom(pixelsPerFrame * 0.8)}
              className="text-sm w-7 h-6 rounded-l bg-zinc-800 hover:bg-zinc-700 text-zinc-200 leading-none"
              title="ズームアウト"
              aria-label="ズームアウト"
            >−</button>
            <button
              onClick={() => setZoom(pixelsPerFrame * 1.25)}
              className="text-sm w-7 h-6 rounded-r bg-zinc-800 hover:bg-zinc-700 text-zinc-200 leading-none border-l border-zinc-700"
              title="ズームイン"
              aria-label="ズームイン"
            >＋</button>
          </div>
          <span className="text-zinc-600 text-[10px] hidden sm:inline">
            S=分割　Del=削除　Ctrl+Z=元に戻す
          </span>
          <button
            onClick={handlePrecompose}
            className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
            title="タイムライン全体を1本の動画に焼き込み（プリコンポーズ）→ライブラリに追加"
          >🎬 焼き込み</button>
          <button
            onClick={() => setShowRenderDialog(true)}
            className="text-[11px] px-3 py-0.5 rounded bg-purple-800 hover:bg-purple-700 text-purple-100 font-medium"
            title="MP4にレンダリング"
          >▶ レンダー</button>
        </div>

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

          {/* Beat ruler (shown only when beat analysis is available) */}
          {beatInfo && (
            <div className="flex flex-shrink-0">
              <div className="w-28 flex-shrink-0 border-r border-b border-zinc-800 bg-zinc-950 flex items-center px-2">
                <span className="text-[9px] text-zinc-600">beat</span>
              </div>
              <BeatRuler
                beat={beatInfo.beat}
                clipStartFrame={beatInfo.clip.start_frame}
                assetInFrame={beatInfo.clip.asset_in_frame}
                pixelsPerFrame={pixelsPerFrame}
                fps={fps}
                totalWidth={totalWidth}
              />
            </div>
          )}

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
              snapFrame={snapFrame}
            />
          ))}

          {tracks.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-zinc-700 text-sm py-8">
              「+ Video」または「+ Audio」でトラックを追加
            </div>
          )}

          {showRenderDialog && (
            <RenderDialog onClose={() => setShowRenderDialog(false)} />
          )}

          {/* Remote collaborators' playheads */}
          {Object.values(remoteUsers).map(o => (
            o.presence.frame != null && (
              <div
                key={o.user.id}
                className="absolute top-0 bottom-0 w-px pointer-events-none z-20"
                style={{ left: LABEL_WIDTH + o.presence.frame * pixelsPerFrame, background: o.user.color }}
              >
                <span
                  className="absolute top-0 left-0 text-[8px] leading-tight px-0.5 rounded-sm text-black whitespace-nowrap"
                  style={{ background: o.user.color }}
                >{o.user.name}</span>
              </div>
            )
          ))}

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
