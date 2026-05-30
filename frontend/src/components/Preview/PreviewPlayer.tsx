import { useEffect, useRef, useState } from 'react'
import { useTimelineStore } from '../../store/timelineStore'
import type { Asset } from '../../api/client'
import { assetsApi } from '../../api/client'

interface Props {
  assets: Asset[]
}

export function PreviewPlayer({ assets }: Props) {
  const { tracks, clips, currentFrame, projectFps, setCurrentFrame } = useTimelineStore()
  const videoRef  = useRef<HTMLVideoElement>(null)
  const rafRef    = useRef<number | null>(null)
  const lastTsRef = useRef<number>(0)
  const [playing, setPlaying] = useState(false)
  const [loadedAssetId, setLoadedAssetId] = useState<number | null>(null)

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

  // Load video when the asset changes
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!activeClip || activeClip.asset_id == null) {
      video.src = ''
      setLoadedAssetId(null)
      return
    }
    if (activeClip.asset_id !== loadedAssetId) {
      video.src = assetsApi.fileUrl(activeClip.asset_id)
      video.load()
      setLoadedAssetId(activeClip.asset_id)
    }
  }, [activeClip?.asset_id])

  // Seek when NOT playing (scrubbing)
  useEffect(() => {
    if (playing) return
    const video = videoRef.current
    if (!video || !activeClip) return
    const assetTime = (currentFrame - activeClip.start_frame + activeClip.asset_in_frame) / projectFps
    if (Math.abs(video.currentTime - assetTime) > 0.04) {
      video.currentTime = Math.max(0, assetTime)
    }
  }, [currentFrame, playing, activeClip, projectFps])

  // Play / pause
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (playing) {
      video.play().catch(() => {})
      lastTsRef.current = performance.now()

      const tick = (now: number) => {
        const elapsed = now - lastTsRef.current
        lastTsRef.current = now
        // Sync currentFrame from video.currentTime when available
        if (!video.paused && activeClip != null) {
          const frame = Math.round(video.currentTime * projectFps)
            - activeClip.asset_in_frame
            + activeClip.start_frame
          setCurrentFrame(Math.max(0, frame))
          // Auto-stop at clip boundary
          if (frame >= activeClip.start_frame + activeClip.duration_frames) {
            stopPlay()
            return
          }
        } else {
          // No video — advance frame by elapsed time
          const frames = Math.round((elapsed / 1000) * projectFps)
          if (frames > 0) {
            useTimelineStore.setState(s => ({
              currentFrame: s.currentFrame + frames,
            }))
          }
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } else {
      video.pause()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [playing])

  const stopPlay = () => {
    setPlaying(false)
  }

  const togglePlay = () => setPlaying(p => !p)

  const goToStart = () => {
    setPlaying(false)
    setCurrentFrame(0)
  }

  const isVideoAsset = activeAsset?.asset_type === 'video'
  const isImageAsset = activeAsset?.asset_type === 'image'

  return (
    <div className="flex flex-col h-full bg-black select-none">
      {/* Canvas area */}
      <div className="flex-1 relative flex items-center justify-center min-h-0">
        {/* HTML5 video (always in DOM, hidden when not needed) */}
        <video
          ref={videoRef}
          className={`max-w-full max-h-full object-contain ${isVideoAsset ? '' : 'hidden'}`}
          playsInline
          preload="auto"
        />

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

        <span className="ml-auto text-[10px] text-zinc-600">
          Draft Preview
        </span>
      </div>
    </div>
  )
}
