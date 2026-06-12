import { useEffect, useRef, useState } from 'react'
import { useTimelineStore } from '../../store/timelineStore'
import { useProjectStore } from '../../store/projectStore'
import type { Asset } from '../../api/client'
import { assetsApi } from '../../api/client'

interface Props {
  assets: Asset[]
  onAsset?: (asset: Asset) => void
}

export function PreviewPlayer({ assets, onAsset }: Props) {
  const { tracks, clips, currentFrame, projectFps, setCurrentFrame, placeClip } = useTimelineStore()
  const { activeProject } = useProjectStore()
  const videoRef  = useRef<HTMLVideoElement>(null)
  const audioRef  = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [loadedAssetId, setLoadedAssetId] = useState<number | null>(null)
  const [loadedAudioId, setLoadedAudioId] = useState<number | null>(null)
  const [capturing, setCapturing] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })   // fitted project-frame box (px)
  const [guideMode, setGuideMode] = useState<'off' | 'thirds' | 'safe'>('off')

  const projW = activeProject?.width  ?? 1280
  const projH = activeProject?.height ?? 720

  // Find the clip at the current frame on the topmost video track (first in list)
  const videoTrack = tracks.find(t => t.track_type === 'video')
  const activeClip = videoTrack
    ? clips
        .filter(c => c.track_id === videoTrack.id)
        .find(c => c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame)
    : null
  const activeAsset = activeClip?.asset_id != null
    ? assets.find(a => a.id === activeClip.asset_id)
    : null

  // "generated" covers both images and videos — disambiguate by duration.
  const isVideoAsset = activeAsset?.asset_type === 'video'
    || (activeAsset?.asset_type === 'generated' && activeAsset?.duration_sec != null)
  const isImageAsset = activeAsset?.asset_type === 'image'
    || (activeAsset?.asset_type === 'generated' && activeAsset?.duration_sec == null)

  // First audio-track clip overlapping the playhead (the BGM to play)
  const activeAudioClip = clips.find(c => {
    const t = tracks.find(tk => tk.id === c.track_id)
    return t?.track_type === 'audio' && c.asset_id != null
      && c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame
  }) ?? null

  // Load video when the asset changes — prefer the low-res proxy for light preview
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!activeClip || activeClip.asset_id == null) {
      video.src = ''
      setLoadedAssetId(null)
      return
    }
    const url = assetsApi.fileUrl(activeClip.asset_id, !!activeAsset?.proxy_path)
    if (video.getAttribute('src') !== url) {
      video.src = url
      video.load()
      setLoadedAssetId(activeClip.asset_id)
    }
  }, [activeClip?.asset_id, activeAsset?.proxy_path])

  // Apply per-clip playback speed to the video element
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = activeClip?.speed && activeClip.speed > 0 ? activeClip.speed : 1
  }, [activeClip?.speed, loadedAssetId])

  // Keep the video element playing / seeked in sync with the playhead.
  // The timeline clock (below) is the MASTER; the video follows it — when a new
  // clip's src loads mid-playback we re-play() and re-seek here, so playback
  // doesn't freeze on the new clip's first frame.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!activeClip || !isVideoAsset) {
      if (!video.paused) video.pause()
      return
    }
    const sp = activeClip.speed > 0 ? activeClip.speed : 1
    const assetTime = (activeClip.asset_in_frame + (currentFrame - activeClip.start_frame) * sp) / projectFps
    if (playing) {
      if (Math.abs(video.currentTime - assetTime) > 0.25) video.currentTime = Math.max(0, assetTime)  // drift correction only
      if (video.paused) video.play().catch(() => {})
    } else {
      if (!video.paused) video.pause()
      if (Math.abs(video.currentTime - assetTime) > 0.04) video.currentTime = Math.max(0, assetTime)  // scrub
    }
  }, [currentFrame, playing, activeClip, projectFps, loadedAssetId, isVideoAsset])

  // Load audio (BGM) when the active audio clip changes
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    if (!activeAudioClip || activeAudioClip.asset_id == null) {
      a.src = ''
      setLoadedAudioId(null)
      return
    }
    if (activeAudioClip.asset_id !== loadedAudioId) {
      a.src = assetsApi.fileUrl(activeAudioClip.asset_id)
      a.load()
      setLoadedAudioId(activeAudioClip.asset_id)
    }
  }, [activeAudioClip?.asset_id])

  // Keep the audio element playing / seeked in sync with the playhead
  useEffect(() => {
    const a = audioRef.current
    if (!a || !activeAudioClip) return
    const t = (currentFrame - activeAudioClip.start_frame + activeAudioClip.asset_in_frame) / projectFps
    if (playing) {
      if (Math.abs(a.currentTime - t) > 0.25) a.currentTime = Math.max(0, t)  // correct drift only
      if (a.paused) a.play().catch(() => {})
    } else {
      if (!a.paused) a.pause()
      if (Math.abs(a.currentTime - t) > 0.04) a.currentTime = Math.max(0, t)
    }
  }, [playing, currentFrame, activeAudioClip, projectFps])

  // Measure the fitted project-frame box (object-contain) for the frame guides
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ar = projW / projH
    const update = () => {
      const cw = el.clientWidth, ch = el.clientHeight
      let w = cw, h = cw / ar
      if (h > ch) { h = ch; w = ch * ar }
      setBox({ w: Math.round(w), h: Math.round(h) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [projW, projH])

  const cycleGuide = () =>
    setGuideMode(m => (m === 'off' ? 'thirds' : m === 'thirds' ? 'safe' : 'off'))

  // ── Timeline master clock ─────────────────────────────────────────────
  // Wall-clock drives currentFrame; the <video>/<audio> elements follow it
  // (see the sync effects above). This survives clip changes mid-playback —
  // the old design derived the frame from video.currentTime, so when a new
  // clip's src loaded paused, playback froze on its first frame.
  const lastClipEnd = Math.max(0, ...clips.map(c => c.start_frame + c.duration_frames))
  const lastEndRef = useRef(lastClipEnd)
  lastEndRef.current = lastClipEnd

  useEffect(() => {
    if (!playing) return
    let raf: number
    let last = performance.now()
    let acc = 0   // fractional-frame accumulator
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * projectFps
      last = now
      const adv = Math.floor(acc)
      if (adv > 0) {
        acc -= adv
        const next = useTimelineStore.getState().currentFrame + adv
        if (next >= lastEndRef.current) {           // end of timeline → stop
          setCurrentFrame(Math.max(0, lastEndRef.current - 1))
          setPlaying(false)
          return
        }
        setCurrentFrame(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, projectFps])

  const togglePlay = () => setPlaying(p => !p)

  const goToStart = () => {
    setPlaying(false)
    setCurrentFrame(0)
  }

  // Extract the currently-previewed video frame and drop it on a Reference track
  // as an I2V keyframe (the playhead acts as the source-frame slider).
  const captureFrame = async () => {
    if (!activeProject || !activeClip || activeClip.asset_id == null || !isVideoAsset || capturing) return
    setCapturing(true)
    try {
      const t = videoRef.current?.currentTime ?? 0
      const img = await assetsApi.extractFrame(activeClip.asset_id, t)
      onAsset?.(img)
      await placeClip(activeProject.id, 'reference', img.id, Math.max(1, Math.round(projectFps * 0.5)), currentFrame)
    } catch { /* extraction failed */ } finally {
      setCapturing(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-black select-none">
      {/* Canvas area */}
      <div ref={canvasRef} className="flex-1 relative flex items-center justify-center min-h-0">
        {/* HTML5 video (always in DOM, hidden when not needed) */}
        <video
          ref={videoRef}
          className={`max-w-full max-h-full object-contain ${isVideoAsset ? '' : 'hidden'}`}
          playsInline
          preload="auto"
        />

        {/* Hidden audio element for BGM playback */}
        <audio ref={audioRef} preload="auto" className="hidden" />

        {/* Project frame boundary + design guides (overlaid on the fitted frame) */}
        {box.w > 1 && (
          <div
            className="absolute pointer-events-none border border-white/25"
            style={{ width: box.w, height: box.h, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
          >
            {guideMode === 'thirds' && (
              <>
                <div className="absolute top-0 bottom-0 bg-white/20" style={{ left: '33.333%', width: 1 }} />
                <div className="absolute top-0 bottom-0 bg-white/20" style={{ left: '66.666%', width: 1 }} />
                <div className="absolute left-0 right-0 bg-white/20" style={{ top: '33.333%', height: 1 }} />
                <div className="absolute left-0 right-0 bg-white/20" style={{ top: '66.666%', height: 1 }} />
                <div className="absolute top-0 bottom-0 bg-white/30" style={{ left: '50%', width: 1 }} />
                <div className="absolute left-0 right-0 bg-white/30" style={{ top: '50%', height: 1 }} />
              </>
            )}
            {guideMode === 'safe' && (
              <>
                {/* action-safe ~93% / title-safe ~90% */}
                <div className="absolute border border-white/25" style={{ inset: '3.5%' }} />
                <div className="absolute border border-amber-400/40" style={{ inset: '5%' }} />
              </>
            )}
          </div>
        )}

        {/* Image preview */}
        {isImageAsset && activeClip?.asset_id != null && (
          <img
            src={assetsApi.thumbnailUrl(activeClip.asset_id)}
            alt={activeAsset?.name}
            className="max-w-full max-h-full object-contain"
          />
        )}

        {/* Empty state */}
        {!activeClip && (
          <span className="text-zinc-700 text-sm">再生ヘッドにクリップがありません</span>
        )}

        {/* Timecode overlay */}
        <div className="absolute bottom-2 right-2 font-mono text-[10px] text-white/50 bg-black/40 px-1.5 py-0.5 rounded pointer-events-none">
          {String(Math.floor(currentFrame / projectFps / 60)).padStart(2, '0')}:
          {String(Math.floor(currentFrame / projectFps) % 60).padStart(2, '0')}:
          {String(currentFrame % projectFps).padStart(2, '0')}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-t border-zinc-800 flex-shrink-0">
        <button
          onClick={goToStart}
          className="text-zinc-400 hover:text-white text-sm w-6 text-center"
          title="先頭へ"
        >⏮</button>
        <button
          onClick={togglePlay}
          className="text-white hover:text-purple-300 text-base w-7 text-center"
          title={playing ? '一時停止 (Space)' : '再生 (Space)'}
        >
          {playing ? '⏸' : '▶'}
        </button>

        {activeAsset && (
          <span className="text-zinc-500 text-[10px] truncate ml-2 max-w-[120px]">
            {activeAsset.name}
          </span>
        )}

        {isVideoAsset && (
          <button
            onClick={captureFrame}
            disabled={capturing}
            className="ml-2 text-[10px] px-2 py-0.5 rounded bg-amber-800 hover:bg-amber-700 text-amber-100 disabled:opacity-40"
            title="現在のフレームを抽出してRef（I2Vキーフレーム）に追加"
          >{capturing ? '抽出中…' : '📷 キーフレーム化'}</button>
        )}

        <button
          onClick={cycleGuide}
          className={`ml-auto text-[10px] px-2 py-0.5 rounded ${guideMode !== 'off' ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="フレーム枠ガイド: なし → 三分割 → セーフエリア"
        >⊞ {guideMode === 'off' ? 'ガイド' : guideMode === 'thirds' ? '三分割' : 'セーフ'}</button>

        <span className="text-[10px] text-zinc-600">
          {projW}×{projH}
        </span>
      </div>
    </div>
  )
}
