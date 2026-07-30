import { useEffect, useMemo, useRef, useState } from 'react'
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
  const [playing, setPlaying] = useState(false)
  const [loadedAssetId, setLoadedAssetId] = useState<number | null>(null)
  const [capturing, setCapturing] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const compRef = useRef<HTMLCanvasElement>(null)        // WYSIWYG compositor
  const imgMap = useRef<Map<number, HTMLImageElement>>(new Map())
  const refSel = useTimelineStore(s => s.refSel)         // 選択中のImage(Ref)ピン
  const [redraw, setRedraw] = useState(0)                // bumped when an image loads
  // 直前に確定した動画フレームのキャッシュ。シーク中(readyState低下)に黒フレームを
  // 出さず、前のフレームを描き続けるために使う(シーク完了ごとに更新)。
  const videoCacheRef = useRef<{ canvas: HTMLCanvasElement | null; assetId: number | null }>({ canvas: null, assetId: null })
  // コマ打ちプレビュー: スロット(=ホールド区間)が変わった時だけビデオフレームを取り込む
  const holdCacheRef = useRef<{ clipId: number | null; slot: number; canvas: HTMLCanvasElement | null }>({ clipId: null, slot: -1, canvas: null })
  const [box, setBox] = useState({ w: 0, h: 0 })   // fitted project-frame box (px)
  const [guideMode, setGuideMode] = useState<'off' | 'thirds' | 'safe'>('off')
  const [lightPreview, setLightPreview] = useState(true)   // cap backing-store res
  // 差分再生モード: |今フレーム−前フレーム| を表示し、画面全体の動き量を数値化。
  // カット=鋭いスパイク / カメラ・モーション=持続的な山。音ハメ加速の指標検証用。
  const [diffMode, setDiffMode] = useState(false)
  const prevFrameRef = useRef<HTMLCanvasElement | null>(null)
  const diffTmpRef = useRef<HTMLCanvasElement | null>(null)
  const measRef = useRef<HTMLCanvasElement | null>(null)
  const motionHistRef = useRef<number[]>([])
  const motionTextRef = useRef<HTMLSpanElement | null>(null)
  const sparkRef = useRef<HTMLCanvasElement | null>(null)

  const projW = activeProject?.width  ?? 1280
  const projH = activeProject?.height ?? 720

  // ベースレイヤー選択: 「再生ヘッドにクリップがある」最上位のVideoトラックを使う。
  // 最上段が空白の区間は透明扱いで下のトラックへフォールスルーする(黒塗りにしない)。
  const activeClip = (() => {
    const vTracks = [...tracks]
      .sort((a, b) => a.order - b.order)
      .filter(t => t.track_type === 'video' && !t.hidden)
    for (const t of vTracks) {
      const hit = clips
        .filter(c => c.track_id === t.id)
        .find(c => c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame)
      if (hit) return hit
    }
    return null
  })()
  const activeAsset = activeClip?.asset_id != null
    ? assets.find(a => a.id === activeClip.asset_id)
    : null

  // "generated" covers both images and videos — disambiguate by duration.
  const isVideoAsset = activeAsset?.asset_type === 'video'
    || (activeAsset?.asset_type === 'generated' && activeAsset?.duration_sec != null)

  // 再生ヘッドに重なる全Audioクリップ(全トラック分をミックス再生する)
  const activeAudioClips = clips.filter(c => {
    const t = tracks.find(tk => tk.id === c.track_id)
    return t?.track_type === 'audio' && !t?.hidden && c.asset_id != null
      && c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame
  })

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

  // シーク完了・デコード完了のたびに合成を再描画する(スクラブ時に古いフレームが
  // 残らないように)。video.currentTime代入は非同期なので、seekedを待たないと
  // canvasには前のフレームが描かれたままになる。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const bump = () => {
      // 確定フレームをキャッシュしてから再描画(スクラブ中の黒フレーム対策)
      if (video.readyState >= 2 && video.videoWidth) {
        const c = videoCacheRef.current
        if (!c.canvas) c.canvas = document.createElement('canvas')
        if (c.canvas.width !== video.videoWidth || c.canvas.height !== video.videoHeight) {
          c.canvas.width = video.videoWidth; c.canvas.height = video.videoHeight
        }
        c.canvas.getContext('2d')?.drawImage(video, 0, 0)
        const src = video.getAttribute('src') ?? ''
        const m = src.match(/\/assets\/(\d+)\//)
        c.assetId = m ? Number(m[1]) : c.assetId
      }
      setRedraw(n => n + 1)
    }
    video.addEventListener('seeked', bump)
    video.addEventListener('loadeddata', bump)
    video.addEventListener('canplay', bump)
    return () => {
      video.removeEventListener('seeked', bump)
      video.removeEventListener('loadeddata', bump)
      video.removeEventListener('canplay', bump)
    }
  }, [])

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
      // フレーム精度スクラブ: 半フレーム許容 + 境界丸め回避の微小オフセット
      const target = Math.max(0, assetTime) + 1e-4
      if (Math.abs(video.currentTime - target) > 0.5 / projectFps) video.currentTime = target
    }
  }, [currentFrame, playing, activeClip, projectFps, loadedAssetId, isVideoAsset])

  // 音声は単一プレイヤー方式(モバイル互換性を最優先)。
  // 対象は「最上段のAudioトラックで再生ヘッドに重なるクリップ」= Audioトラック最優先。
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const audioUnlockedRef = useRef(false)
  if (!audioElRef.current && typeof window !== 'undefined') {
    const el = new Audio()
    el.preload = 'auto'
    audioElRef.current = el
  }
  const unlockAudioPool = () => {
    if (audioUnlockedRef.current || !audioElRef.current) return
    audioUnlockedRef.current = true
    const el = audioElRef.current
    el.muted = true
    el.play().then(() => { el.pause(); el.muted = false }).catch(() => { el.muted = false })
  }
  const activeAudioClip = useMemo(() => {
    const cands = [...activeAudioClips].sort((a, b) => {
      const oa = tracks.find(t => t.id === a.track_id)?.order ?? 0
      const ob = tracks.find(t => t.id === b.track_id)?.order ?? 0
      return oa !== ob ? oa - ob : b.start_frame - a.start_frame
    })
    return cands[0] ?? null
  }, [activeAudioClips, tracks])

  useEffect(() => {
    const el = audioElRef.current
    if (!el) return
    if (!activeAudioClip || activeAudioClip.asset_id == null) {
      if (!el.paused) el.pause()
      return
    }
    const url = assetsApi.fileUrl(activeAudioClip.asset_id)
    if (!el.src.endsWith(url)) { el.src = url; el.load() }
    const t = (currentFrame - activeAudioClip.start_frame + activeAudioClip.asset_in_frame) / projectFps
    const rel = currentFrame - activeAudioClip.start_frame
    let vol = 1
    if (activeAudioClip.fade_in_frames > 0 && rel < activeAudioClip.fade_in_frames)
      vol = rel / activeAudioClip.fade_in_frames
    const tail = activeAudioClip.duration_frames - rel
    if (activeAudioClip.fade_out_frames > 0 && tail < activeAudioClip.fade_out_frames)
      vol = Math.min(vol, tail / activeAudioClip.fade_out_frames)
    el.volume = Math.max(0, Math.min(1, vol))
    if (playing) {
      if (Math.abs(el.currentTime - t) > 0.25) el.currentTime = Math.max(0, t)
      if (el.paused) el.play().catch(() => {})
    } else {
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - t) > 0.04) el.currentTime = Math.max(0, t)
    }
  }, [playing, currentFrame, activeAudioClip, projectFps])

  // Audioトラックが鳴っている間はVideoの内蔵音声をミュート(二重再生防止)
  useEffect(() => {
    const v = videoRef.current
    if (v) v.muted = !!activeAudioClip
  }, [activeAudioClip])

  useEffect(() => () => {
    const el = audioElRef.current
    if (el) { el.pause(); el.src = '' }
  }, [])

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
    // UI上で上にあるトラック(order小)ほど最前面 → 下から順に描き、最後に上を重ねる
    const vts = tracks.filter(t => t.track_type === 'video' && !t.hidden).sort((a, b) => b.order - a.order)
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
          const cache = videoCacheRef.current
          const holdFps = clip.posterize_fps ?? 0
          if (v && loadedAssetId === clip.asset_id && v.readyState >= 2 && !v.seeking) {
            if (holdFps > 0.5) {
              // 🎞 コマ打ち: 出力時間をホールド間隔で量子化し、区間が変わった時だけ取り込む
              const outSec = (currentFrame - clip.start_frame) / projectFps
              const slot = Math.floor(outSec * holdFps)
              const hc = holdCacheRef.current
              if (hc.clipId !== clip.id || hc.slot !== slot || !hc.canvas) {
                if (!hc.canvas) hc.canvas = document.createElement('canvas')
                hc.canvas.width = v.videoWidth; hc.canvas.height = v.videoHeight
                hc.canvas.getContext('2d')?.drawImage(v, 0, 0)
                hc.clipId = clip.id; hc.slot = slot
              }
              drawLayer(ctx, hc.canvas, hc.canvas.width, hc.canvas.height, xf)
            } else {
              drawLayer(ctx, v, v.videoWidth, v.videoHeight, xf)
            }
          } else if (cache.canvas && cache.assetId === clip.asset_id && cache.canvas.width) {
            // シーク中・ロード中は直前の確定フレームで埋める(黒点滅防止)
            drawLayer(ctx, cache.canvas, cache.canvas.width, cache.canvas.height, xf)
          }
        }
      }
      ctx.restore()
    }

    // Image(Ref)ピン選択中はその画像をcontainでフル表示(小サムネ確認の代替)。
    // 最後に選択したピンを優先。選択解除で通常の合成表示に戻る。
    if (refSel.length > 0) {
      const selClip = [...refSel].reverse()
        .map(id => clips.find(c => c.id === id))
        .find(c => c && c.asset_id != null)
      const im = selClip?.asset_id != null ? imgMap.current.get(selClip.asset_id) : undefined
      if (im && im.complete && im.naturalWidth) {
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, projW, projH)
        const cs = Math.min(projW / im.naturalWidth, projH / im.naturalHeight)
        const dw = im.naturalWidth * cs, dh = im.naturalHeight * cs
        ctx.drawImage(im, (projW - dw) / 2, (projH - dh) / 2, dw, dh)
      }
    }

    if (diffMode) applyDiffView(cv, ctx)
  }

  // 差分ビュー: comp を |cur - prev| に置換し、動き量(平均輝度差)を計測する
  const applyDiffView = (cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    const w = cv.width, h = cv.height
    const ensure = (ref: React.MutableRefObject<HTMLCanvasElement | null>, ww: number, hh: number) => {
      if (!ref.current) ref.current = document.createElement('canvas')
      if (ref.current.width !== ww || ref.current.height !== hh) { ref.current.width = ww; ref.current.height = hh }
      return ref.current
    }
    const tmp = ensure(diffTmpRef, w, h)
    const prev = ensure(prevFrameRef, w, h)
    // tmp ← 今フレーム(合成結果)
    const tctx = tmp.getContext('2d')!
    tctx.setTransform(1, 0, 0, 1, 0, 0)
    tctx.globalCompositeOperation = 'source-over'
    tctx.drawImage(cv, 0, 0)
    // comp ← |今 − 前| を増幅表示
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'difference'
    ctx.drawImage(prev, 0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
    ctx.save()
    ctx.filter = 'brightness(3.2) grayscale(0.2)'
    ctx.drawImage(cv, 0, 0)
    ctx.restore()
    // 動き量: 64x36に縮小した差分の平均輝度(0-100スケール)
    const m = ensure(measRef, 64, 36)
    const mctx = m.getContext('2d', { willReadFrequently: true })!
    mctx.filter = 'none'
    mctx.drawImage(cv, 0, 0, 64, 36)
    const d = mctx.getImageData(0, 0, 64, 36).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]
    const val = sum / (d.length / 4) / 3 / 255 * 100 / 3.2   // 増幅ぶんを戻す
    const hist = motionHistRef.current
    hist.push(val); if (hist.length > 240) hist.shift()
    if (motionTextRef.current) motionTextRef.current.textContent = val.toFixed(1)
    // スパークライン(直近240フレーム)
    const sp = sparkRef.current
    if (sp) {
      const sctx = sp.getContext('2d')!
      sctx.clearRect(0, 0, sp.width, sp.height)
      const vmax = Math.max(8, ...hist)
      sctx.strokeStyle = '#f0a8bc'; sctx.lineWidth = 1; sctx.beginPath()
      hist.forEach((v2, i) => {
        const x = (i / 239) * sp.width, y = sp.height - (v2 / vmax) * (sp.height - 2)
        i === 0 ? sctx.moveTo(x, y) : sctx.lineTo(x, y)
      })
      sctx.stroke()
    }
    // prev ← 今フレーム
    const pctx = prev.getContext('2d')!
    pctx.setTransform(1, 0, 0, 1, 0, 0)
    pctx.globalCompositeOperation = 'source-over'
    pctx.drawImage(tmp, 0, 0)
  }

  useEffect(() => { drawComposite() }, [currentFrame, clips, tracks, assets, loadedAssetId, projW, projH, redraw, previewHidden, lightPreview, diffMode, refSel])

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
      unlockAudioPool()
      setPlaying(p => !p)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const togglePlay = () => { unlockAudioPool(); setPlaying(p => !p) }

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
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-t border-zinc-800 flex-shrink-0 max-sm:overflow-x-auto max-sm:px-2 max-sm:[&>button]:flex-shrink-0 max-sm:[&>button]:whitespace-nowrap max-sm:[&>button]:py-1.5 max-sm:[&>span]:flex-shrink-0">
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
          onClick={() => { setDiffMode(v => !v); motionHistRef.current = [] }}
          className={`text-[10px] px-2 py-0.5 rounded ${diffMode ? 'bg-rose-900 text-rose-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
          title="差分再生: フレーム間差分を表示し画面全体の動き量を数値化（カット=スパイク/カメラ=持続山）"
        >🔍 差分</button>
        {diffMode && (
          <span className="flex items-center gap-1 text-[10px] text-rose-200 bg-zinc-900 rounded px-1.5 py-0.5">
            動き <span ref={motionTextRef} className="font-mono w-9 text-right">0.0</span>
            <canvas ref={sparkRef} width={120} height={18} className="rounded bg-zinc-950" />
          </span>
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

        <span className="text-[10px] text-zinc-600 max-sm:hidden">
          {projW}×{projH}
        </span>
      </div>
    </div>
  )
}
