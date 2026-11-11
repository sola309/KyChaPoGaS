// 📚 選んだ素材の見出し: シリーズ / 作品 / 部 / 年 / タグ / メモ / 評価 / ★ をその場で直す。
import { useEffect, useState } from 'react'
import type { LibraryItem, LibraryItemUpdate } from '../../api/library'
import { LIBRARY_PARTS } from '../../api/library'
import { fmtDur } from './libraryUtils'

interface Props {
  item: LibraryItem
  onSave: (data: LibraryItemUpdate) => void
  onUnregister: () => void
}

export function ItemHeader({ item, onSave, onUnregister }: Props) {
  const [series, setSeries] = useState(item.series)
  const [work, setWork] = useState(item.work)
  const [year, setYear] = useState(item.year != null ? String(item.year) : '')
  const [tags, setTags] = useState(item.tags.join(', '))
  const [note, setNote] = useState(item.note)
  const [confirmDel, setConfirmDel] = useState(false)
  useEffect(() => {
    setSeries(item.series); setWork(item.work)
    setYear(item.year != null ? String(item.year) : '')
    setTags(item.tags.join(', ')); setNote(item.note); setConfirmDel(false)
  }, [item.asset_id, item.series, item.work, item.year, item.tags.join('\u0001'), item.note])

  const commitTags = () => {
    const list = [...new Set(tags.split(/[,、]/).map(t => t.trim()).filter(Boolean))]
    if (list.join('\u0001') !== item.tags.join('\u0001')) onSave({ tags: list })
  }
  const field = 'bg-transparent hover:bg-zinc-800 focus:bg-zinc-800 rounded px-1 outline-none border border-transparent focus:border-purple-500'

  return (
    <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-900 flex flex-col gap-1" data-lib-item-header>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
        <input value={series} onChange={e => setSeries(e.target.value)} placeholder="シリーズ"
               onBlur={() => series.trim() !== item.series && onSave({ series: series.trim() })}
               className={`${field} text-[11px] text-zinc-400 w-44 max-w-full`} title="シリーズ" />
        <input value={work} onChange={e => setWork(e.target.value)} placeholder="作品"
               onBlur={() => work.trim() !== item.work && onSave({ work: work.trim() })}
               className={`${field} text-sm font-bold text-zinc-100 flex-1 min-w-[10rem]`} title="作品" />
        <select value={item.part} onChange={e => onSave({ part: e.target.value })}
                className="bg-zinc-800 text-[11px] text-zinc-200 rounded px-1 py-0.5 outline-none border border-zinc-700" title="部">
          {LIBRARY_PARTS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <input value={year} onChange={e => setYear(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} placeholder="年"
               onBlur={() => { const y = year ? Number(year) : null; if (y !== item.year) onSave({ year: y }) }}
               className={`${field} text-[11px] text-zinc-300 w-12`} title="年" inputMode="numeric" />
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="flex gap-0.5" title="素材の評価">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => onSave({ rating: item.rating === n ? 0 : n })}
                      className={`text-sm leading-none ${item.rating >= n ? 'text-amber-400' : 'text-zinc-600 hover:text-amber-300'}`}>●</button>
            ))}
          </span>
          <button onClick={() => onSave({ starred: !item.starred })}
                  className={`text-sm leading-none ${item.starred ? 'text-amber-400' : 'text-zinc-600 hover:text-amber-300'}`}
                  title="素材の ★">{item.starred ? '★' : '☆'}</button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500 min-w-0">
        <span className="whitespace-nowrap">#{item.asset_id} · {fmtDur(item.duration_sec)}{item.width ? ` · ${item.width}×${item.height}` : ''}{item.fps ? ` · ${item.fps}fps` : ''}</span>
        <label className="flex items-center gap-0.5 min-w-0">
          <span title="素材のタグ">🏷</span>
          <input value={tags} onChange={e => setTags(e.target.value)} onBlur={commitTags}
                 onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                 placeholder="素材のタグ(, 区切り)" title="素材のタグ(, 区切り)" data-lib-item-tags
                 className={`${field} text-[10px] text-zinc-300 w-44 max-w-full`} />
        </label>
        <label className="flex items-center gap-0.5 flex-1 min-w-[8rem]">
          <span title="素材のメモ">📝</span>
          <input value={note} onChange={e => setNote(e.target.value)} onBlur={() => note !== item.note && onSave({ note })}
                 onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                 placeholder="素材のメモ" title="素材のメモ" data-lib-item-note
                 className={`${field} text-[10px] text-zinc-300 flex-1 min-w-0`} />
        </label>
        {!confirmDel ? (
          <button onClick={() => setConfirmDel(true)} className="text-zinc-600 hover:text-red-300 whitespace-nowrap"
                  title="ライブラリから外す(素材とファイルは残る。カット一覧は消える)">外す…</button>
        ) : (
          <span className="flex items-center gap-1 whitespace-nowrap">
            <span className="text-red-300">カット一覧を消して外しますか?</span>
            <button onClick={onUnregister} className="px-1.5 rounded bg-red-900 text-red-100">外す</button>
            <button onClick={() => setConfirmDel(false)} className="px-1.5 rounded bg-zinc-800 text-zinc-300">やめる</button>
          </span>
        )}
      </div>
    </div>
  )
}
