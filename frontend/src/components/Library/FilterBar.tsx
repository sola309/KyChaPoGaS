// 📚 カットの絞り込みと並べ替え。
import { useEffect, useMemo, useState } from 'react'
import type { LibraryChapter, LibraryCut } from '../../api/library'
import { TRANS_KINDS } from '../../api/library'
import type { CutFilters, SortKey } from './libraryUtils'
import { DEFAULT_FILTERS, filtersActive, SORT_LABEL, TRANS_LABEL } from './libraryUtils'

interface Props {
  filters: CutFilters
  sort: SortKey
  desc: boolean
  cuts: LibraryCut[]          // 素材の全カット(タグの候補用)
  chapters: LibraryChapter[]
  shown: number
  total: number
  onFilters: (f: CutFilters) => void
  onSort: (k: SortKey, desc: boolean) => void
  /** 開いている小窓(タグの一覧)を Esc で閉じられるよう、閉じる関数を親へ渡す(閉じたら null) */
  onEscapeTarget?: (close: (() => void) | null) => void
}

export function FilterBar({ filters: f, sort, desc, cuts, chapters, shown, total, onFilters, onSort, onEscapeTarget }: Props) {
  const set = (patch: Partial<CutFilters>) => onFilters({ ...f, ...patch })
  const [tagOpen, setTagOpen] = useState(false)
  // Esc は画面のキー処理(window の捕捉段階)が先に受けるので、そこから閉じてもらう
  useEffect(() => {
    if (!onEscapeTarget) return
    onEscapeTarget(tagOpen ? () => setTagOpen(false) : null)
    return () => { if (tagOpen) onEscapeTarget(null) }
  }, [tagOpen, onEscapeTarget])
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of cuts) for (const t of c.tags) m.set(t, (m.get(t) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
  }, [cuts])

  const tog = (on: boolean) => `text-[10px] px-1.5 py-1 rounded border whitespace-nowrap ${
    on ? 'bg-purple-800 border-purple-600 text-purple-50' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200'}`
  const sel = 'bg-zinc-800 text-[10px] text-zinc-300 rounded px-1 py-1 outline-none border border-zinc-700'

  return (
    <div className="px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/80 flex flex-wrap items-center gap-1.5" data-lib-filters>
      <input value={f.text} onChange={e => set({ text: e.target.value })} placeholder="🔍 タグ・メモ"
             data-lib-filter-text
             className="w-32 bg-zinc-800 text-[11px] text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500" />
      <div className="relative">
        <button onClick={() => setTagOpen(v => !v)} className={tog(f.tags.length > 0)} data-lib-filter-tags
                title="タグで絞る(選んだタグをすべて持つカット)">🏷 タグ{f.tags.length ? ` ${f.tags.length}` : ''} ▾</button>
        {tagOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setTagOpen(false)} />
            <div className="absolute z-30 mt-1 left-0 w-56 max-h-64 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 shadow-2xl p-1">
              {tagCounts.length === 0 && <p className="text-[10px] text-zinc-500 px-2 py-1">この素材のカットにはまだタグがありません</p>}
              {tagCounts.map(([t, n]) => {
                const on = f.tags.includes(t)
                return (
                  <button key={t} onClick={() => set({ tags: on ? f.tags.filter(x => x !== t) : [...f.tags, t] })}
                          className={`w-full flex text-left text-[11px] px-2 py-1 rounded ${on ? 'bg-purple-900/60 text-purple-100' : 'text-zinc-200 hover:bg-zinc-800'}`}>
                    <span className="w-4">{on ? '✓' : ''}</span><span className="truncate">{t}</span><span className="ml-auto text-zinc-500">{n}</span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
      {f.tags.map(t => (
        <span key={t} className="text-[10px] pl-1.5 pr-0.5 py-0.5 rounded bg-purple-900/60 text-purple-100 flex items-center">
          {t}<button onClick={() => set({ tags: f.tags.filter(x => x !== t) })} className="px-1 hover:text-white">×</button>
        </span>
      ))}
      <button onClick={() => set({ starOnly: !f.starOnly })} className={tog(f.starOnly)} data-lib-filter-star>★だけ</button>
      <select value={f.minRating} onChange={e => set({ minRating: Number(e.target.value) })} className={sel} title="評価がこれ以上" data-lib-filter-rating>
        <option value={0}>評価</option>
        {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{'●'.repeat(n)} 以上</option>)}
      </select>
      <span className="flex items-center gap-0.5 text-[10px] text-zinc-500" title="カットの長さ(秒)">
        長さ
        <SecInput value={f.minSec} onChange={v => set({ minSec: v })} placeholder="最小" testId="minsec" />
        〜
        <SecInput value={f.maxSec} onChange={v => set({ maxSec: v })} placeholder="最大" testId="maxsec" />
        秒
      </span>
      <button onClick={() => set({ dark: !f.dark })} className={tog(f.dark)} data-lib-filter-dark>暗い</button>
      <button onClick={() => set({ bright: !f.bright })} className={tog(f.bright)} data-lib-filter-bright>明るい</button>
      <select value={f.motion} onChange={e => set({ motion: e.target.value as CutFilters['motion'] })} className={sel} title="動きの量(この素材の中での順位: 少 = 下位 30 %・多 = 上位 30 %)" data-lib-filter-motion>
        <option value="all">動き</option>
        <option value="low">動き 少</option>
        <option value="high">動き 多</option>
      </select>
      <select value={f.trans} onChange={e => set({ trans: e.target.value })} className={sel} title="入り方" data-lib-filter-trans>
        <option value="all">入り方</option>
        {TRANS_KINDS.map(k => <option key={k} value={k}>{TRANS_LABEL[k]}</option>)}
      </select>
      {chapters.length > 0 && (
        <select value={f.chapter} onChange={e => set({ chapter: Number(e.target.value) })} className={`${sel} max-w-[9rem]`} title="チャプター" data-lib-filter-chapter>
          <option value={-1}>チャプター</option>
          {chapters.map((c, i) => <option key={i} value={i}>{c.title || `Chapter ${i + 1}`}</option>)}
        </select>
      )}
      {filtersActive(f) && (
        <button onClick={() => onFilters(DEFAULT_FILTERS)} className="text-[10px] px-1.5 py-1 text-zinc-400 hover:text-zinc-100" data-lib-filter-clear>✕ 条件を消す</button>
      )}
      <span className="ml-auto flex items-center gap-1">
        <span className="text-[10px] text-zinc-500 tabular-nums whitespace-nowrap" data-lib-count={shown}>
          {shown === total ? `${total.toLocaleString()} カット` : `${shown.toLocaleString()} / ${total.toLocaleString()} カット`}
        </span>
        <select value={sort} onChange={e => onSort(e.target.value as SortKey, e.target.value === 'time' ? false : true)} className={sel} title="並べ替え" data-lib-sort>
          {(Object.keys(SORT_LABEL) as SortKey[]).map(k => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
        </select>
        <button onClick={() => onSort(sort, !desc)} className="text-[10px] px-1.5 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-zinc-100"
                title={desc ? '大きい順(押すと小さい順)' : '小さい順(押すと大きい順)'} data-lib-sort-dir>{desc ? '↓' : '↑'}</button>
      </span>
    </div>
  )
}

/** 秒の入力(打ちかけの「1.」を消さないよう文字のまま持ち、数になったら知らせる) */
function SecInput({ value, onChange, placeholder, testId }: {
  value: number | null; onChange: (v: number | null) => void; placeholder: string; testId: string
}) {
  const [text, setText] = useState(value == null ? '' : String(value))
  useEffect(() => {
    if ((text.trim() === '' ? null : Number(text)) !== value) setText(value == null ? '' : String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <input value={text} placeholder={placeholder} inputMode="decimal" {...{ [`data-lib-filter-${testId}`]: '' }}
           onChange={e => {
             const t = e.target.value.replace(/[^0-9.]/g, '')
             setText(t)
             const n = Number(t)
             if (t.trim() === '') onChange(null)
             else if (Number.isFinite(n)) onChange(Math.max(0, n))
           }}
           className="w-10 bg-zinc-800 text-[10px] text-zinc-100 rounded px-1 py-1 outline-none border border-zinc-700 focus:border-purple-500" />
  )
}
