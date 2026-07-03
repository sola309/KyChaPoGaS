import { useEffect, useRef, useState } from 'react'
import { useTimelineStore } from '../../store/timelineStore'
import { useProjectStore } from '../../store/projectStore'
import type { Asset } from '../../api/client'
import { assetsApi } from '../../api/client'
import { evalTransform, parseElement, type TextProps, type XForm } from './transformEval'

interface Props {
  assets: Asset[]
  onAsset?: (asset: Asset) => void
}

export function PreviewPlayer({ assets, onAsset }: Props) {
  const { tracks, clips, currentFrame, projectFps, setCurrentFrame, placeClip, previewHidden } = useTimelineStore()
  const { activeProject } = useProjectStore()
  const videoRef  = useRef<HTMLVideoElement>(null)
  const audioRef  = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [loadedAssetId, setLoadedAssetId] = useState<number | null>(null)
  const [loadedAudioId, setLoadedAudioId] = useState<number | null>(null)
  const [capturing, setCapturing] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const compRef = useRef<HTMLCanvasElement>(null)        // WYSIWYG compositor
  const imgMap = useRef<Map<number, HTMLImageElement>>(new Map())
  const [redraw, setRedraw] = useState(0)                // bumped when an image loads
  const [box, setBox] = useState({ w: 0, h: 0 })   // fitted project-frame box (px)
  const [guideMode, setGuideMode] = useState<'off' | 'thirds' | 'safe'>('off')
  const [lightPreview, setLightPreview] = useState(true)   // cap backing-store res

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

  // ── WYSIWYG compositor ────────────────────────────────────────────────────
  // Preload image assets so the canvas can composite them (file = full quality).
  useEffect(() => {
    for (const a of assets) {
      const isImg = a.asset_type === 'image' || (a.asset_type === 'generated' && a.duration_sec == null)
      if (isImg && !imgMap.current.has(a.id)) {
        const im = new Image()
        im.onload = () => setRedraw(r => r + 1)   // re-run the draw effect with fresh state
        im.src = assetsApi.fileUrl(a.id)
        imgMap.current.set(a.id, im)
      }
    }
  }, [assets])

  // Draw an asset as a LAYER: cover-fit × scale, panned by (x,y), rotated about
  // its anchor. Mirrors the AE-style transform consumed by the render.
  const drawLayer = (ctx: CanvasRenderingContext2D, src: CanvasImageSource,
                     iw: number, ih: number, xf: XForm) => {
    if (!iw || !ih) return
    const s = Math.max(projW / iw, projH / ih) * xf.zoom
    const dw = iw * s, dh = ih * s
    const cx = projW / 2 + xf.x * projW
    const cy = projH / 2 + xf.y * projH
    const [ax, ay] = xf.anchor
    ctx.save()
    ctx.translate(cx, cy)
    if (xf.rotation) ctx.rotate((xf.rotation * Math.PI) / 180)
    ctx.drawImage(src, -dw * ax, -dh * ay, dw, dh)   // anchor maps to (cx,cy)
    ctx.restore()
  }

  const drawText = (ctx: CanvasRenderingContext2D, el: TextProps, prog: number) => {
    const inD = el.inDur ?? 0.3
    const p = inD > 0 ? Math.min(1, prog / inD) : 1
    let alpha = p, dy = 0, scale = 1
    if (el.anim === 'rise') { dy = (1 - p) * 50 }
    else if (el.anim === 'slam') { scale = 1 + (1 - p) * 1.4 }
    ctx.save()
    ctx.globalAlpha *= alpha
    ctx.translate((el.x ?? 0.5) * projW, (el.y ?? 0.5) * projH + dy)
    ctx.scale(scale, scale)
    ctx.textAlign = el.align ?? 'center'; ctx.textBaseline = 'middle'
    ctx.font = `${el.weight ?? 900} ${el.size ?? 90}px "Arial Black",Arial,sans-serif`
    if (el.glow) { ctx.shadowColor = el.glow; ctx.shadowBlur = (el.size ?? 90) * 0.55 }
    ctx.fillStyle = el.color ?? '#fff'
    ctx.fillText(el.text, 0, 0)
    ctx.restore()
  }

  const drawComposite = () => {
    const cv = compRef.current; if (!cv) return
    const ctx = cv.getContext('2d'); if (!ctx) return
    // 軽量プレビュー: cap the backing-store resolution (fill cost ∝ pixels). All
    // draw code stays in project-frame coordinates; a base transform scales down.
    const capW = lightPreview ? 1280 : 3840
    const s = Math.min(1, capW / projW)
    const cw = Math.max(1, Math.round(projW * s)), ch = Math.max(1, Math.round(projH * s))
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch }
    ctx.setTransform(s, 0, 0, s, 0, 0)                 // draw in projW×projH space
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, projW, projH)
    const vts = tracks.filter(t => t.track_type === 'video').sort((a, b) => a.order - b.order)
    for (const tr of vts) {
      if (previewHidden.includes(tr.id)) continue   // hidden in preview (not render)
      const clip = clips.filter(c => c.track_id === tr.id)
        .find(c => c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame)
      if (!clip) continue
      const prog = (currentFrame - clip.start_frame) / Math.max(1, clip.duration_frames)
      const xf = evalTransform(clip.transform_json, prog, currentFrame)
      ctx.save()
      ctx.globalAlpha = (clip.opacity ?? 1) * (clip.asset_id == null ? 1 : xf.opacity)
      ctx.globalCompositeOperation = clip.blend === 'screen' ? 'screen'
        : clip.blend === 'add' ? 'lighter' : clip.blend === 'multiply' ? 'multiply' : 'source-over'
      if (clip.asset_id == null) {
        const el = parseElement(clip.transform_json)
        if (el) drawText(ctx, el, prog)
      } else {
        const asset = assets.find(a => a.id === clip.asset_id)
        const isImg = asset && (asset.asset_type === 'image' || (asset.asset_type === 'generated' && asset.duration_sec == null))
        if (isImg) {
          const im = imgMap.current.get(clip.asset_id)
          if (im && im.complete && im.naturalWidth) drawLayer(ctx, im, im.naturalWidth, im.naturalHeight, xf)
        } else {
          const v = videoRef.current
          if (v && loadedAssetId === clip.asset_id && v.readyState >= 2)
            drawLayer(ctx, v, v.videoWidth, v.videoHeight, xf)
        }
      }
      ctx.restore()
    }
  }

  useEffect(() => { drawComposite() }, [currentFrame, clips, tracks, assets, loadedAssetId, projW, projH, redraw, previewHidden, lightPreview])

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

  // Space: グローバル再生/停止(入力中は無効)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      setPlaying(p => !p)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
        {/* HTML5 video — hidden frame-source; the compositor draws its frame */}
        <video ref={videoRef} className="hidden" playsInline preload="auto" />

        {/* WYSIWYG compositor: all video tracks composited at the playhead
            (transforms / opacity / blend / text) so the timeline is what-you-see. */}
        <canvas ref={compRef} className="max-w-full max-h-full object-contain" />

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
          onClick={() => setLightPreview(v => !v)}
          className={`ml-auto text-[10px] px-2 py-0.5 rounded ${lightPreview ? 'bg-emerald-800 text-emerald-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="軽量プレビュー: 描画解像度を下げて動作を軽く（書き出し画質は不変）"
        >⚡ {lightPreview ? '軽量' : '高画質'}</button>

        <button
          onClick={cycleGuide}
          className={`text-[10px] px-2 py-0.5 rounded ${guideMode !== 'off' ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="フレーム枠ガイド: なし → 三分割 → セーフエリア"
        >⊞ {guideMode === 'off' ? 'ガイド' : guideMode === 'thirds' ? '三分割' : 'セーフ'}</button>

        <span className="text-[10px] text-zinc-600">
          {projW}×{projH}
        </span>
      </div>
    </div>
  )
}
