import { createPortal } from 'react-dom'
import type { Asset, Clip } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { RefImagePicker } from '../RefImagePicker'

/**
 * 🖼 ピン差し替えモーダル — Imageトラックのキーフレームピンの画像を、
 * 画像アセット(サムネグリッド)または動画素材の任意フレーム(🎥抽出)に差し替える。
 * i2v/FLF2V/VACEのキーフレーム調整用。位置・尺はそのまま、画像だけ変わる。
 */
interface Props {
  pin: Clip
  assets: Asset[]
  fps: number
  onClose: () => void
}

export function PinSwapModal({ pin, assets, fps, onClose }: Props) {
  const updateClip = useTimelineStore(s => s.updateClip)
  const tracks = useTimelineStore(s => s.tracks)
  const clips = useTimelineStore(s => s.clips)

  // 🎥フレーム抽出の初期動画 = ピン位置の下にあるVideo素材
  const videoUnderPin = (() => {
    const vts = tracks
      .filter(t => t.track_type === 'video' && t.name !== 'Shots' && !t.hidden)
      .sort((a, b) => a.order - b.order)
    for (const t of vts) {
      const c = clips.find(c => c.track_id === t.id && c.asset_id != null &&
        c.start_frame <= pin.start_frame && pin.start_frame < c.start_frame + c.duration_frames)
      if (c) return c.asset_id ?? undefined
    }
    return undefined
  })()

  const apply = async (ids: number[]) => {
    const newId = ids[0]
    if (newId == null || newId === pin.asset_id) return
    await updateClip(pin.id, { asset_id: newId })
    window.dispatchEvent(new Event('kychapogas:assets-changed'))
    onClose()
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-2 sm:p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[min(680px,96vw)] max-h-[94vh] overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-200 flex items-center gap-2">
            🖼 ピン差し替え — f{pin.start_frame}({(pin.start_frame / fps).toFixed(2)}s)
            {pin.asset_id != null && (
              <img src={assetsApi.thumbnailUrl(pin.asset_id)} alt="現在"
                   className="h-8 rounded border border-zinc-700" title={`現在: #${pin.asset_id}`} />
            )}
          </span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
        </div>
        <p className="text-[10px] text-zinc-500">
          画像をタップで即差し替え。「🎥動画からフレーム追加」で動画素材から抽出したフレームもそのまま適用されます(ピンの位置・尺は不変)。
        </p>
        <RefImagePicker assets={assets} selected={[]} onChange={ids => { void apply(ids) }}
                        max={1} fps={fps} frameSourceAssetId={videoUnderPin} />
      </div>
    </div>,
    document.body
  )
}
