import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Clip } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { SpeedCurveEditor, pointsFromEase, samplesFromPoints, easeStringFromPoints } from './SpeedCurveEditor'

/**
 * 🎛 ショット調整ポップアップ — 両隣が埋まったShotsクリップを、タイムラインを
 * 触らずに編集する。カット長(タイムライン上の尺・位置)は固定したまま:
 *  - ソース窓: 生成クリップ(例5.17s)のどの区間をカット(例1.77s)に使うか
 *  - 速度+加減速カーブ(尺は変えず、消費するソース範囲だけ変わる)
 *  - 分割(クリップ内の任意フレームで✂)
 *  - カット境界とのズレ表示と「カット長に合わせる」
 */
interface Props {
  clip: Clip
  asset: Asset | undefined
  fps: number
  onClose: () => void
}

export function ShotTunePopover({ clip, asset, fps, onClose }: Props) {
  const liveUpdateClip = useTimelineStore(s => s.liveUpdateClip)
  const updateClip = useTimelineStore(s => s.updateClip)
  const splitClip = useTimelineStore(s => s.splitClip)
  const tracks = useTimelineStore(s => s.tracks)
  const clips = useTimelineStore(s => s.clips)

  const [assetIn, setAssetIn] = useState(clip.asset_in_frame)
  const [speed, setSpeed] = useState(clip.speed ?? 1)
  const [showCurve, setShowCurve] = useState(false)
  const [splitAt, setSplitAt] = useState(Math.floor(clip.duration_frames / 2))
  const [playing, setPlaying] = useState(false)          // 停止=フレーム単位スクラブ / 再生=窓ループ
  const [scrubSrc, setScrubSrc] = useState(clip.asset_in_frame)   // 現在位置(ソースフレーム)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)

  const sourceFrames = asset?.duration_sec ? Math.max(1, Math.floor(asset.duration_sec * fps)) : clip.duration_frames
  const usedSrc = Math.round(clip.duration_frames * speed)     // カットが消費するソース量
  const maxIn = Math.max(0, sourceFrames - usedSrc)

  // このクリップが属するカット(Imageピンのペアリングから導出)
  const cut = useMemo(() => {
    const imgTrack = tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
    if (!imgTrack) return null
    const pins = clips.filter(c => c.track_id === imgTrack.id && c.asset_id != null)
      .map(c => c.start_frame).sort((a, b) => a - b)
    for (let i = 0; i + 1 < pins.length; i += 2) {
      if (pins[i] <= clip.start_frame && clip.start_frame <= pins[i + 1]) {
        return { n: i / 2 + 1, s: pins[i], e: pins[i + 1] }
      }
    }
    return null
  }, [tracks, clips, clip.start_frame])
  const cutMatch = cut && clip.start_frame === cut.s && clip.duration_frames === cut.e - cut.s + 1

  // プレビュー: 再生中=窓ループ / 停止中=scrubSrc位置のフレーム静止表示
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (!playing) {
      v.pause()
      const t = scrubSrc / fps + 1e-4
      if (Math.abs(v.currentTime - t) > 0.5 / fps) v.currentTime = t
      return
    }
    const t0 = assetIn / fps
    const t1 = (assetIn + usedSrc) / fps
    v.playbackRate = Math.min(4, Math.max(0.1, speed))
    const onTime = () => {
      setScrubSrc(Math.floor(v.currentTime * fps))
      if (v.currentTime >= t1 - 0.03 || v.currentTime < t0 - 0.2) v.currentTime = t0
    }
    v.addEventListener('timeupdate', onTime)
    if (Math.abs(v.currentTime - t0) > 0.2 && v.currentTime > t1) v.currentTime = t0
    v.play().catch(() => {})
    return () => v.removeEventListener('timeupdate', onTime)
  }, [playing, assetIn, usedSrc, speed, fps, scrubSrc])

  const scrubTo = (srcFrame: number) => {
    setPlaying(false)
    setScrubSrc(Math.max(0, Math.min(sourceFrames - 1, Math.round(srcFrame))))
  }
  const stripFrameAt = (clientX: number) => {
    const el = stripRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return ((clientX - rect.left) / rect.width) * sourceFrames
  }
  // タイムラインと同じ操作系:
  //  - 窓(紫ブロック)をドラッグ = クリップ移動と同様に窓を動かす
  //  - 窓の外をクリック/ドラッグ = 再生ヘッドのシーク(スクラブ)
  const dragWinRef = useRef<{ grabOffset: number } | null>(null)
  const stripDown = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    const f = stripFrameAt(e.clientX)
    if (f >= assetIn && f < assetIn + usedSrc) {
      dragWinRef.current = { grabOffset: f - assetIn }   // 窓ドラッグ開始
    } else {
      dragWinRef.current = null
      scrubTo(f)
    }
  }
  const stripMove = (e: React.PointerEvent) => {
    if (!(e.buttons & 1)) return
    const f = stripFrameAt(e.clientX)
    if (dragWinRef.current) applyIn(f - dragWinRef.current.grabOffset)
    else scrubTo(f)
  }
  const stripUp = () => { dragWinRef.current = null }

  // Space=再生/停止・←→=±1f(Shiftで±10f) — タイムラインと同じキー操作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); setPlaying(p => !p) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); scrubTo(scrubSrc - (e.shiftKey ? 10 : 1)) }
      if (e.key === 'ArrowRight') { e.preventDefault(); scrubTo(scrubSrc + (e.shiftKey ? 10 : 1)) }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubSrc, sourceFrames])
  // 現在位置がカット(窓)内なら、対応するタイムライン出力位置
  const inWindow = scrubSrc >= assetIn && scrubSrc < assetIn + usedSrc
  const outFrame = inWindow ? Math.round((scrubSrc - assetIn) / Math.max(0.05, speed)) : null

  const applyIn = (val: number) => {
    const nv = Math.max(0, Math.min(maxIn, Math.round(val)))
    setAssetIn(nv)
    liveUpdateClip(clip.id, { asset_in_frame: nv })
  }
  const applySpeed = (sp: number) => {
    const nsp = Math.max(0.05, Math.min(8, sp))
    setSpeed(nsp)
    const newUsed = Math.round(clip.duration_frames * nsp)
    const clampedIn = Math.min(assetIn, Math.max(0, sourceFrames - newUsed))
    if (clampedIn !== assetIn) setAssetIn(clampedIn)
    liveUpdateClip(clip.id, { speed: nsp, asset_in_frame: clampedIn })
  }

  const inputCls = 'bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500'
  const chipCls = (on: boolean) => `text-[10px] px-2 py-1 rounded ${on ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-2 sm:p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[min(720px,96vw)] max-h-[94vh] overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-200">
            🎛 ショット調整 — #{clip.asset_id} {asset?.name ?? ''}
            {cut && (
              <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${cutMatch ? 'bg-emerald-900 text-emerald-300' : 'bg-amber-950 text-amber-400'}`}>
                カットC{cut.n} f{cut.s}-{cut.e}{cutMatch ? ' 一致' : ' ズレあり'}
              </span>
            )}
          </span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
        </div>

        {/* プレビュー: 停止=現在位置の静止フレーム / 再生=カット窓を実速度ループ */}
        <div className="relative">
          <video ref={videoRef} muted playsInline loop={false}
                 src={clip.asset_id != null ? assetsApi.fileUrl(clip.asset_id, !!asset?.proxy_path) : undefined}
                 className="w-full aspect-video bg-black rounded object-contain" />
          <span className="absolute bottom-1 right-1.5 font-mono text-[10px] text-white/60 bg-black/50 px-1 rounded pointer-events-none">
            src {scrubSrc}f{outFrame != null ? ` → out +${outFrame}f (f${clip.start_frame + outFrame})` : '(窓外)'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setPlaying(p => !p)}
                  className="text-xs px-3 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700">
            {playing ? '⏸ 停止(コマ調整へ)' : '▶ 窓をループ再生'}
          </button>
          {[-10, -1, 1, 10].map(d => (
            <button key={d} onClick={() => scrubTo(scrubSrc + d)} className={chipCls(false)}>{d > 0 ? `+${d}` : d}f</button>
          ))}
          <span className="text-[10px] text-zinc-600 ml-auto">停止中はフィルムストリップのクリック/ドラッグでコマ単位スクラブ</span>
        </div>

        {/* 上段: カットレイヤー(タイムライン上の尺 — 固定) */}
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-zinc-500">カットレイヤー(タイムライン f{clip.start_frame}-{clip.start_frame + clip.duration_frames - 1}・尺固定)</span>
          <div className="relative h-5 bg-zinc-800 rounded overflow-hidden">
            <div className="absolute inset-0 bg-purple-900/50 flex items-center pl-1 text-[9px] text-purple-200">
              {clip.duration_frames}f = {(clip.duration_frames / fps).toFixed(2)}s
            </div>
            {outFrame != null && (
              <div className="absolute top-0 bottom-0 w-px bg-amber-300"
                   style={{ left: `${(outFrame / clip.duration_frames) * 100}%` }} />
            )}
          </div>
        </div>

        {/* 下段: Shotフル尺(フィルムストリップ)+ソース窓 */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px] text-zinc-500">
            <span>Shotレイヤー(生成フル尺 {sourceFrames}f のうち紫の {usedSrc}f がカットに載る)</span>
            <span>窓開始 {assetIn}f = {(assetIn / fps).toFixed(2)}s</span>
          </div>
          <div ref={stripRef}
               className="relative h-14 bg-zinc-950 rounded overflow-hidden select-none"
               style={{ touchAction: 'none' }}
               onPointerDown={stripDown} onPointerMove={stripMove} onPointerUp={stripUp}>
            {clip.asset_id != null && (
              <img src={`/api/assets/${clip.asset_id}/filmstrip?count=12`} alt=""
                   className="absolute inset-0 w-full h-full object-fill opacity-70 pointer-events-none" />
            )}
            {/* ソース窓 = タイムラインのクリップと同じ「掴んでドラッグで移動」 */}
            <div className="absolute top-0 bottom-0 border-2 border-purple-400 bg-purple-500/20 pointer-events-none cursor-grab"
                 style={{ left: `${(assetIn / sourceFrames) * 100}%`, width: `${(usedSrc / sourceFrames) * 100}%` }} />
            {/* 再生ヘッド */}
            <div className="absolute top-0 bottom-0 w-px bg-amber-300 pointer-events-none"
                 style={{ left: `${(scrubSrc / sourceFrames) * 100}%` }} />
          </div>
          <div className="flex gap-1 items-center flex-wrap text-[10px] text-zinc-600">
            <span>窓ドラッグ=移動 / 外クリック=シーク / Space=再生 / ←→=±1f(Shiftで±10f)</span>
            <button onClick={() => applyIn(scrubSrc)} className={chipCls(false) + ' ml-auto'} title="再生ヘッド位置を窓の開始フレームにする">
              ▶ ヘッド位置を窓開始に
            </button>
          </div>
        </div>

        {/* 速度(尺は固定・消費ソース範囲が変わる) */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-zinc-500">速度</span>
          {[0.25, 0.5, 1, 1.5, 2, 4].map(sp => (
            <button key={sp} onClick={() => applySpeed(sp)} className={chipCls(Math.abs(speed - sp) < 0.01)}>×{sp}</button>
          ))}
          <input type="number" step={0.05} min={0.05} max={8} value={Number(speed.toFixed(2))}
                 onChange={e => applySpeed(Number(e.target.value))} className={inputCls + ' w-20'} />
          <button onClick={() => setShowCurve(v => !v)} className={chipCls(showCurve || (clip.speed_ease ?? 'linear') !== 'linear')}>
            ∿ 加減速カーブ
          </button>
          <span className="text-[10px] text-zinc-600">尺({(clip.duration_frames / fps).toFixed(2)}s)は固定</span>
        </div>
        {showCurve && (
          <SpeedCurveEditor
            initial={pointsFromEase(clip.speed_ease, clip.speed ?? 1)}
            sourceFrames={usedSrc}
            fps={fps}
            onLive={pts => {
              const { rel, mean } = samplesFromPoints(pts)
              const flat = rel.every(v => Math.abs(v - 1) < 1e-3)
              liveUpdateClip(clip.id, { speed: mean, speed_ease: flat ? 'linear' : easeStringFromPoints(pts) })
            }}
            onApply={(pts) => {
              const { rel, mean } = samplesFromPoints(pts)
              const flat = rel.every(v => Math.abs(v - 1) < 1e-3)
              setSpeed(mean)
              void updateClip(clip.id, { speed: mean, speed_ease: flat ? 'linear' : easeStringFromPoints(pts) })
            }}
          />
        )}

        {/* 分割 */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500">✂ 分割位置</span>
          <input type="range" min={1} max={clip.duration_frames - 1} value={splitAt}
                 onChange={e => setSplitAt(Number(e.target.value))} className="flex-1" />
          <span className="text-[10px] text-zinc-400 w-24">+{splitAt}f ({(splitAt / fps).toFixed(2)}s)</span>
          <button onClick={async () => { await splitClip(clip.id, clip.start_frame + splitAt); onClose() }}
                  className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white">✂ 分割</button>
        </div>

        {cut && !cutMatch && (
          <button onClick={() => { void updateClip(clip.id, { start_frame: cut.s, duration_frames: cut.e - cut.s + 1 }) }}
                  className="text-[11px] px-2 py-1.5 rounded bg-amber-900/60 text-amber-200 border border-amber-700 self-start">
            📐 カットC{cut.n}の範囲(f{cut.s}-{cut.e})にぴったり合わせる
          </button>
        )}
        <p className="text-[9px] text-zinc-600">
          変更は即タイムラインへ反映(アンドゥ可)。速度・カーブは尺を変えず「どのソース区間をどう再生するか」だけを変えます。
        </p>
      </div>
    </div>,
    document.body
  )
}
