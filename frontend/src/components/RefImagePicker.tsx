import { useMemo, useState } from 'react'
import type { Asset } from '../api/client'
import { assetsApi } from '../api/client'

/**
 * 🖼 参照画像ピッカー — サムネイルgrid上のタップで複数選択(選択順を①②…で表示)。
 * H3 Ref2Vの参照画像(<Picture 1..9>)選択用。ファイル名selectでは中身が分からないため視覚選択。
 */
interface Props {
  assets: Asset[]
  selected: number[]                  // 選択中のasset id(選択順)
  onChange: (ids: number[]) => void
  max?: number
}

export function RefImagePicker({ assets, selected, onChange, max = 9 }: Props) {
  const [q, setQ] = useState('')
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

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="検索(名前/#id)"
               className="bg-zinc-800 text-[10px] text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500 flex-1" />
        <span className="text-[10px] text-zinc-500">{selected.length}/{max}枚</span>
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
    </div>
  )
}
