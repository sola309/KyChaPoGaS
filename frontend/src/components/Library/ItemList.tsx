// 📚 左の列: ライブラリの素材(シリーズ → 作品 でまとめる)と、まだ入っていない長い動画。
import { useMemo, useState } from 'react'
import type { LibraryCandidate, LibraryItem } from '../../api/library'
import { LIBRARY_PARTS } from '../../api/library'
import { fmtDur, guessMeta } from './libraryUtils'

const PART_CLASS: Record<string, string> = {
  '本編': 'bg-purple-900/70 text-purple-200',
  '予告': 'bg-sky-900/70 text-sky-200',
  '特典': 'bg-emerald-900/70 text-emerald-200',
  'OP・ED': 'bg-amber-900/70 text-amber-200',
  'その他': 'bg-zinc-700 text-zinc-300',
}

interface Props {
  items: LibraryItem[]
  candidates: LibraryCandidate[]
  currentId: number | null
  onSelect: (assetId: number) => void
  onAnalyze: (assetId: number) => void
  onRegister: (c: LibraryCandidate, meta: { series: string; work: string; part: string; move: boolean }) => Promise<void>
}

export function ItemList({ items, candidates, currentId, onSelect, onAnalyze, onRegister }: Props) {
  // シリーズ → 作品 の順でまとめる(並びは sort_order → 作品名 → 部)
  const groups = useMemo(() => {
    const bySeries = new Map<string, Map<string, LibraryItem[]>>()
    const sorted = [...items].sort((a, b) =>
      a.series.localeCompare(b.series, 'ja') || a.sort_order - b.sort_order
      || a.work.localeCompare(b.work, 'ja') || LIBRARY_PARTS.indexOf(a.part as never) - LIBRARY_PARTS.indexOf(b.part as never)
      || a.asset_id - b.asset_id)
    for (const it of sorted) {
      const s = it.series || '(シリーズ未設定)'
      if (!bySeries.has(s)) bySeries.set(s, new Map())
      const w = bySeries.get(s)!
      const wk = it.work || it.name
      if (!w.has(wk)) w.set(wk, [])
      w.get(wk)!.push(it)
    }
    return [...bySeries.entries()]
  }, [items])

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto" data-lib-items>
      {items.length === 0 && (
        <p className="text-[11px] text-zinc-500 px-3 py-4">まだ何も入っていません。下の「ライブラリに入っていない長い動画」から入れられます。</p>
      )}
      {groups.map(([series, works]) => (
        <div key={series} className="pb-1">
          <div className="sticky top-0 z-10 px-3 py-1 text-[10px] font-bold tracking-wide text-zinc-400 bg-zinc-900 border-b border-zinc-800 truncate" title={series}>
            {series}
          </div>
          {[...works.entries()].map(([work, its]) => (
            <div key={work} className="px-2 pt-1">
              <div className="px-1 text-[11px] text-zinc-300 truncate" title={work}>{work}</div>
              {its.map(it => (
                <ItemRow key={it.asset_id} it={it} active={it.asset_id === currentId}
                         onSelect={onSelect} onAnalyze={onAnalyze} />
              ))}
            </div>
          ))}
        </div>
      ))}

      <div className="mt-2 border-t border-zinc-800 pt-2 pb-3">
        <div className="px-3 text-[10px] font-bold text-zinc-400 mb-1">ライブラリに入っていない長い動画</div>
        {candidates.length === 0 && <p className="px-3 text-[10px] text-zinc-600">10 分以上の動画はすべて入っています</p>}
        {candidates.map(c => <CandidateRow key={c.asset_id} c={c} items={items} onRegister={onRegister} />)}
      </div>
    </div>
  )
}

function ItemRow({ it, active, onSelect, onAnalyze }: {
  it: LibraryItem; active: boolean; onSelect: (id: number) => void; onAnalyze: (id: number) => void
}) {
  const st = it.analysis_status
  return (
    <div onClick={() => onSelect(it.asset_id)} data-lib-item={it.asset_id} title={`#${it.asset_id} ${it.name}`}
         className={`mt-1 rounded px-2 py-1.5 cursor-pointer border ${
           active ? 'bg-purple-950/60 border-purple-700' : 'border-transparent hover:bg-zinc-800'}`}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`text-[9px] px-1 rounded flex-shrink-0 ${PART_CLASS[it.part] ?? PART_CLASS['その他']}`}>{it.part}</span>
        {it.starred && <span className="text-amber-400 text-[10px] flex-shrink-0">★</span>}
        {!it.file_exists && <span className="text-[9px] text-red-300 flex-shrink-0" title="素材のファイルが見つかりません">ファイルなし</span>}
        <span className="text-[10px] text-zinc-400 ml-auto flex-shrink-0">{fmtDur(it.duration_sec)}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-1 text-[10px]">
        {st === 'done' && <span className="text-zinc-300">{it.cut_count.toLocaleString()} カット</span>}
        {st === 'none' && (
          <button onClick={e => { e.stopPropagation(); onAnalyze(it.asset_id) }} data-lib-analyze={it.asset_id}
                  className="px-1.5 py-0.5 rounded bg-purple-800 hover:bg-purple-700 text-purple-50">カットを解析</button>
        )}
        {st === 'queued' && <span className="text-zinc-400">解析の順番待ち{it.queue_position ? `(${it.queue_position} 番目)` : ''}…</span>}
        {st === 'running' && (
          <span className="flex-1 flex items-center gap-1.5" title="解析中">
            <span className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <span className="block h-full bg-purple-500 transition-[width] duration-500" style={{ width: `${Math.round(it.analysis_progress * 100)}%` }} />
            </span>
            <span className="text-zinc-400 tabular-nums">{Math.round(it.analysis_progress * 100)}%</span>
          </span>
        )}
        {(st === 'error' || st === 'interrupted') && (
          <span className="text-red-300 truncate" title={it.analysis_error || (st === 'interrupted' ? '解析が途中で止まりました' : '')}>
            {st === 'interrupted' ? '解析が中断' : `解析に失敗: ${it.analysis_error || '不明'}`}
          </span>
        )}
        {(st === 'done' || st === 'error' || st === 'interrupted') && (
          <button onClick={e => { e.stopPropagation(); onAnalyze(it.asset_id) }} data-lib-analyze={it.asset_id}
                  className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                  title="もう一度カットを解析する(付けたタグ・評価・つなぐ/分けるは引き継ぐ)">解析しなおす</button>
        )}
      </div>
    </div>
  )
}

function CandidateRow({ c, items, onRegister }: {
  c: LibraryCandidate; items: LibraryItem[]
  onRegister: Props['onRegister']
}) {
  const [open, setOpen] = useState(false)
  // サーバーの下書き(ファイル名から)を優先し、足りないところは既存のシリーズ名などから補う
  const g = useMemo(() => {
    const mine = guessMeta(c.name, items)
    const sv = c.suggest
    return { series: sv?.series || mine.series, work: sv?.work || mine.work, part: sv?.part || mine.part }
  }, [c.name, c.suggest, items])
  const [series, setSeries] = useState(g.series)
  const [work, setWork] = useState(g.work)
  const [part, setPart] = useState(g.part)
  const [move, setMove] = useState(true)
  const [busy, setBusy] = useState(false)
  const seriesList = useMemo(() => [...new Set(items.map(i => i.series).filter(Boolean))], [items])
  return (
    <div className="mx-2 mt-1 rounded border border-zinc-800 px-2 py-1.5" data-lib-candidate={c.asset_id}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[10px] text-zinc-300 truncate flex-1" title={c.name}>{c.name}</span>
        <span className="text-[10px] text-zinc-500 flex-shrink-0">{fmtDur(c.duration_sec)}</span>
      </div>
      <div className="text-[9px] text-zinc-600 truncate" title={c.project_name}>#{c.asset_id}{c.project_id != null ? ` · PJ${c.project_id}${c.project_name ? ` ${c.project_name}` : ''}` : ''}{c.width ? ` · ${c.width}×${c.height}` : ''}</div>
      {!open ? (
        <button onClick={() => setOpen(true)} className="mt-1 text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
          ライブラリに入れる
        </button>
      ) : (
        <form className="mt-1.5 flex flex-col gap-1"
              onSubmit={async e => {
                e.preventDefault()
                setBusy(true)
                try { await onRegister(c, { series: series.trim(), work: work.trim(), part, move }); setOpen(false) } finally { setBusy(false) }
              }}>
          <input value={series} onChange={e => setSeries(e.target.value)} placeholder="シリーズ" list={`lib-series-${c.asset_id}`}
                 className="bg-zinc-800 text-[11px] text-zinc-100 rounded px-1.5 py-0.5 outline-none border border-zinc-700 focus:border-purple-500" />
          <datalist id={`lib-series-${c.asset_id}`}>{seriesList.map(s => <option key={s} value={s} />)}</datalist>
          <input value={work} onChange={e => setWork(e.target.value)} placeholder="作品(例: 劇場版 前編 始まりの物語)"
                 className="bg-zinc-800 text-[11px] text-zinc-100 rounded px-1.5 py-0.5 outline-none border border-zinc-700 focus:border-purple-500" />
          <select value={part} onChange={e => setPart(e.target.value)}
                  className="bg-zinc-800 text-[11px] text-zinc-100 rounded px-1 py-0.5 outline-none border border-zinc-700">
            {LIBRARY_PARTS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <label className="flex items-center gap-1 text-[10px] text-zinc-300">
            <input type="checkbox" checked={move} onChange={e => setMove(e.target.checked)} className="accent-purple-500" />
            ファイルをライブラリへ移す
          </label>
          <div className="flex gap-1">
            <button type="submit" disabled={busy || !work.trim()}
                    className="text-[10px] px-2 py-0.5 rounded bg-purple-800 hover:bg-purple-700 text-purple-50 disabled:opacity-40">
              {busy ? '入れています…' : '入れる'}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">やめる</button>
          </div>
        </form>
      )}
    </div>
  )
}
