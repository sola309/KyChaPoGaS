import { useEffect, useMemo, useRef, useState } from 'react'
import { assetsApi, assetKind, type Asset } from '../../api/client'

// 🎥 動画フレームピッカー — 動画アセット→スクラブでフレーム指定
// →長辺px指定(lanczos)で画像アセット化。ショットパネルとタイムライン「＋」の共通部品。
// プレビューは<video>のローカルシーク(サーバー往復なし)なので長尺でも即応する。

interface Props {
  assets: Asset[]
  fps: number
  busy?: boolean
  onInsert: (videoAssetId: number, timeSec: number, longEdge?: number) => void
  compact?: boolean
  large?: boolean
  /** 初期選択する動画アセット(Ref2Vの参照動画元など) */
  initialAssetId?: number
}

export function VideoFramePicker({ assets, fps, busy = false, onInsert, compact = false, large = false, initialAssetId }: Props) {
  const [vfAssetId, setVfAssetId] = useState<number | ''>(initialAssetId ?? '')
  const [vfTime, setVfTime] = useState(0)
  const [vfEdge, setVfEdge] = useState<number>(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const seekBusy = useRef(false)          // シーク中なら最新値だけ覚えて追いかける
  const seekTarget = useRef<number | null>(null)
  const scrubbing = useRef(false)

  const vidAssets = useMemo(() => assets.filter(a => assetKind(a) === 'video'), [assets])
  const vfAsset = vidAssets.find(a => a.id === vfAssetId)
  const vfDur = vfAsset?.duration_sec ?? 0

  // <video>への低遅延シーク: seeked待ちの間に来た値は最後のものだけ適用
  const seekTo = (t: number) => {
    const v = videoRef.current
    if (!v) return
    if (seekBusy.current) { seekTarget.current = t; return }
    seekBusy.current = true
    v.currentTime = t
  }
  const handleSeeked = () => {
    seekBusy.current = false
    if (seekTarget.current != null) {
      const t = seekTarget.current
      seekTarget.current = null
      seekTo(t)
    }
  }
  const setTime = (t: number) => {
    const clamped = Math.max(0, Math.min(Math.max(0, vfDur - 0.01), t))
    setVfTime(clamped)
    seekTo(clamped)
  }

  useEffect(() => { setVfTime(0); seekTarget.current = null; seekBusy.current = false }, [vfAssetId])

  // フィルムストリップのドラッグスクラブ
  const stripScrub = (e: React.PointerEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    setTime(frac * vfDur)
  }

  const inputCls = 'bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 outline-none border border-zinc-700 focus:border-purple-500'

  return (
    <div className="flex flex-col gap-2">
      <select value={vfAssetId}
              onChange={e => setVfAssetId(e.target.value === '' ? '' : Number(e.target.value))}
              className={inputCls}>
        <option value="">動画アセットを選択…</option>
        {vidAssets.map(a => (
          <option key={a.id} value={a.id}>
            #{a.id} {a.name}({a.width}×{a.height} / {(a.duration_sec ?? 0).toFixed(1)}s)
          </option>
        ))}
      </select>
      {vfAsset && (
        <>
          {/* フィルムストリップ: クリック/ドラッグでスクラブ */}
          <img src={assetsApi.filmstripUrl(vfAsset.id, large ? 16 : 12)} alt="filmstrip"
               className="w-full rounded cursor-ew-resize border border-zinc-800 select-none touch-none"
               draggable={false}
               onPointerDown={e => { scrubbing.current = true; e.currentTarget.setPointerCapture(e.pointerId); stripScrub(e) }}
               onPointerMove={e => { if (scrubbing.current) stripScrub(e) }}
               onPointerUp={e => { scrubbing.current = false; e.currentTarget.releasePointerCapture(e.pointerId) }} />
          {/* プレビュー: <video>ローカルシーク(高速) */}
          <video ref={videoRef}
                 src={assetsApi.fileUrl(vfAsset.id, !!vfAsset.proxy_path)}
                 muted playsInline preload="auto"
                 onSeeked={handleSeeked}
                 className="w-full rounded border border-zinc-700 bg-black"
                 style={{ maxHeight: large ? '52vh' : compact ? '200px' : '300px', objectFit: 'contain' }} />
          <div className="flex items-center gap-1.5">
            <button onClick={() => setTime(vfTime - 1 / fps)}
                    className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700">-1f</button>
            <input type="range" min={0} max={Math.max(0, vfDur - 0.01)} step={1 / fps} value={vfTime}
                   onChange={e => setTime(Number(e.target.value))} className="flex-1" />
            <button onClick={() => setTime(vfTime + 1 / fps)}
                    className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700">+1f</button>
            <span className="text-[10px] text-zinc-500 w-14 text-right">{vfTime.toFixed(2)}s</span>
          </div>
          <div className="flex gap-2 items-center">
            <select value={vfEdge} onChange={e => setVfEdge(Number(e.target.value))} className={inputCls + ' flex-1'}
                    title="低解像度素材の拡大・高解像度素材の縮小(lanczos)">
              <option value={0}>元解像度({vfAsset.width}×{vfAsset.height})</option>
              <option value={1024}>長辺1024に揃える</option>
              <option value={1536}>長辺1536に揃える</option>
              <option value={2048}>長辺2048に揃える</option>
            </select>
            <button onClick={() => onInsert(vfAsset.id, vfTime, vfEdge || undefined)} disabled={busy}
                    className="text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40">
              挿入
            </button>
          </div>
        </>
      )}
    </div>
  )
}
