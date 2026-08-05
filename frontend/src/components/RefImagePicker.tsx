import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../api/client'
import { assetsApi } from '../api/client'
import { VideoFramePicker } from './Timeline/VideoFramePicker'

/**
 * 🖼 参照画像ピッカー — サムネイルgrid上のタップで複数選択(選択順を①②…で表示)。
 * H3 Ref2Vの参照画像(<Picture 1..9>)選択用。ファイル名selectでは中身が分からないため視覚選択。
 * 「🎥動画からフレーム追加」で動画アセット(参照動画の元素材など)から任意フレームを
 * 画像アセットとして保存し、そのまま選択に追加できる。
 */
interface Props {
  assets: Asset[]
  selected: number[]                  // 選択中のasset id(選択順)
  onChange: (ids: number[]) => void
  max?: number
  /** 動画フレーム追加を有効化する場合のプロジェクトfps */
  fps?: number
  /** フレーム追加時に初期選択する動画アセット(範囲下のVideoなど) */
  frameSourceAssetId?: number
}

export function RefImagePicker({ assets, selected, onChange, max = 9, fps, frameSourceAssetId }: Props) {
  const [q, setQ] = useState('')
  const [framePickerOpen, setFramePickerOpen] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const images = useMemo(() => {
    const imgs = assets
      .filter(a => a.asset_type === 'image' || (a.asset_type === 'generated' && a.duration_sec == null))
      .sort((a, b) => b.id - a.id)   // 新しい順
    const needle = q.trim().toLowerCase()
    if (!needle) return imgs
    return imgs.filter(a => a.name.toLowerCase().includes(needle) || `#${a.id}`.includes(needle))
  }, [assets, q])

  const toggle = (id: number) => {
    if (selected.includes(id)) onChange(selected.filter(x => x !== id))
    else if (selected.length < max) onChange([...selected, id])
  }

  // 動画→フレーム抽出→画像アセット化(保存)→そのまま選択に追加
  const handleFrameInsert = async (videoAssetId: number, timeSec: number, longEdge?: number) => {
    setExtracting(true)
    try {
      const img = await assetsApi.extractFrame(videoAssetId, timeSec, longEdge ?? 1280)
      window.dispatchEvent(new Event('kychapogas:assets-changed'))
      if (selected.length < max) onChange([...selected, img.id])
      setFramePickerOpen(false)
    } finally { setExtracting(false) }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="検索(名前/#id)"
               className="bg-zinc-800 text-[10px] text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500 flex-1" />
        {fps != null && (
          <button onClick={() => setFramePickerOpen(true)}
                  className="text-[10px] px-2 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 whitespace-nowrap"
                  title="動画アセットからフレームを選んで画像として保存し、参照に追加">
            🎥 動画からフレーム追加
          </button>
        )}
        <span className="text-[10px] text-zinc-500 whitespace-nowrap">{selected.length}/{max}枚</span>
        {selected.length > 0 && (
          <button onClick={() => onChange([])} className="text-[10px] text-zinc-500 hover:text-zinc-300">クリア</button>
        )}
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-5 gap-1 max-h-44 overflow-y-auto pr-1">
        {images.map(a => {
          const idx = selected.indexOf(a.id)
          return (
            <button key={a.id} onClick={() => toggle(a.id)}
                    className={`relative aspect-video rounded overflow-hidden border
                      ${idx >= 0 ? 'border-purple-400 ring-2 ring-purple-400' : 'border-zinc-700 hover:border-zinc-500'}`}
                    title={`#${a.id} ${a.name}`}>
              <img src={assetsApi.thumbnailUrl(a.id)} alt="" loading="lazy"
                   className="w-full h-full object-cover" />
              {idx >= 0 && (
                <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-purple-600 text-white
                                 text-[10px] leading-4 text-center font-bold">{idx + 1}</span>
              )}
            </button>
          )
        })}
        {images.length === 0 && (
          <span className="col-span-full text-[10px] text-zinc-600 py-2">画像アセットがありません</span>
        )}
      </div>
      {framePickerOpen && fps != null && createPortal(
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-2 sm:p-6"
             onClick={() => setFramePickerOpen(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[min(760px,96vw)] max-h-[94vh] overflow-y-auto p-4"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-zinc-200">🎥 動画からフレームを選択 → 画像保存+参照に追加</span>
              <button onClick={() => setFramePickerOpen(false)}
                      className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2 py-1">✕</button>
            </div>
            <VideoFramePicker assets={assets} fps={fps} busy={extracting}
                              onInsert={handleFrameInsert} large
                              initialAssetId={frameSourceAssetId} />
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
