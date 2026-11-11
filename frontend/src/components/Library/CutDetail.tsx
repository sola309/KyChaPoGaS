// 📚 いま見ているカットの詳細: プロキシでカットの範囲だけをくり返し再生・コマ送り・つまみ、
// タグ / メモ / 評価 / ★ の編集、「前とつなぐ」「後とつなぐ」「ここで分ける」。
// タグ・評価・★ は「選んでいて、いま見えているカット」(selection)に付く。キー操作・置くと同じ組
// (メモ・つなぐ・分けるは表示中のこのカットだけ)。何も選んでいなければ編集はできない。
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { assetsApi } from '../../api/client'
import type { LibraryCut, LibraryTagCount } from '../../api/library'
import { fmtLen, fmtTc, TRANS_LABEL } from './libraryUtils'

export interface CutDetailHandle {
  togglePlay: () => void
  focusTag: () => void
  shownFrame: () => number | null
}

interface Props {
  assetId: number
  hasProxy: boolean
  fps: number
  cut: LibraryCut | null
  prev: LibraryCut | null
  next: LibraryCut | null
  selection: LibraryCut[]          // 編集の対象 = 選択中で見えているカット(current を含むとは限らない)
  tagSuggestions: LibraryTagCount[]
  busy: boolean
  onRate: (n: number) => void
  onStar: () => void
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
  onNote: (note: string) => void
  onMerge: (dir: 'prev' | 'next') => void
  onSplit: (at: number) => void
}

export const CutDetail = forwardRef<CutDetailHandle, Props>(function CutDetail(p, ref) {
  const { assetId, hasProxy, fps, cut, prev, next, selection, tagSuggestions, busy } = p
  const vRef = useRef<HTMLVideoElement>(null)
  const tagRef = useRef<HTMLInputElement>(null)
  const [playing, setPlaying] = useState(false)
  const [frame, setFrame] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const [tagText, setTagText] = useState('')
  const [tagFocus, setTagFocus] = useState(false)
  const [note, setNote] = useState('')
  const rangeRef = useRef<{ s: number; e: number }>({ s: 0, e: 1 })

  const src = assetsApi.fileUrl(assetId, hasProxy)
  const s = cut?.start ?? 0
  const e = cut?.end ?? 1
  rangeRef.current = { s, e }

  const seekFrame = (f: number) => {
    const v = vRef.current
    if (!v) return
    const ff = Math.max(rangeRef.current.s, Math.min(rangeRef.current.e - 1, Math.round(f)))
    v.currentTime = (ff + 0.5) / fps      // コマの真ん中へ(境目の丸めで前のコマが出ないように)
    setFrame(ff)
  }

  // カットが変わったら頭へ(再生中なら続けて再生)
  useEffect(() => {
    if (!cut) return
    setNote(cut.note)
    setFrame(cut.start)
    const v = vRef.current
    if (!v) return
    if (v.readyState >= 1) seekFrame(cut.start)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cut?.id, cut?.start, cut?.end])

  useEffect(() => { if (cut) setNote(cut.note) }, [cut?.note])

  // 再生中: 表示コマの追従と、尻まで来たら頭へ戻す(カットの範囲だけをループ)
  useEffect(() => {
    const v = vRef.current
    if (!v || !playing) return
    let raf = 0
    const tick = () => {
      const { s: cs, e: ce } = rangeRef.current
      const f = Math.floor(v.currentTime * fps)
      if (f >= ce || f < cs - 1) {
        v.currentTime = (cs + 0.5) / fps
        setFrame(cs)
      } else setFrame(Math.max(cs, f))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, fps])

  const togglePlay = () => {
    const v = vRef.current
    if (!v || !cut) return
    if (v.paused) {
      const f = Math.floor(v.currentTime * fps)
      if (f < cut.start || f >= cut.end - 1) v.currentTime = (cut.start + 0.5) / fps
      void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    } else {
      v.pause()
      setPlaying(false)
      seekFrame(Math.floor(v.currentTime * fps))
    }
  }

  useImperativeHandle(ref, () => ({
    togglePlay,
    focusTag: () => tagRef.current?.focus(),
    shownFrame: () => frame,
  }))

  const step = (d: number) => {
    const v = vRef.current
    if (!v) return
    if (!v.paused) { v.pause(); setPlaying(false) }
    seekFrame((frame ?? s) + d)
  }

  // 対象のタグ(全体の和集合と、付いている数)。対象 = selection そのもの(キー操作・置くと同じ組)
  const none = selection.length === 0
  const single = selection.length === 1 && cut != null && selection[0].id === cut.id
  const multi = !none && !single
  const targets = selection
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of targets) for (const t of c.tags) m.set(t, (m.get(t) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ja'))
  }, [targets])
  const sugg = useMemo(() => {
    const q = tagText.trim().toLowerCase()
    const have = new Set(tagCounts.filter(([, n]) => n === targets.length).map(([t]) => t))
    return tagSuggestions
      .filter(t => !have.has(t.tag) && (!q || t.tag.toLowerCase().includes(q)))
      .slice(0, 12)
  }, [tagSuggestions, tagText, tagCounts, targets.length])

  const addTag = (t: string) => {
    const v = t.trim()
    if (!v) return
    p.onAddTag(v)
    setTagText('')
  }

  if (!cut) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-zinc-500 p-4 text-center" data-lib-detail>
        カットを選ぶと、ここで再生・編集できます
      </div>
    )
  }

  const len = cut.end - cut.start
  const shown = frame ?? cut.start
  const ratingNow = none ? -1 : (selection.every(c => c.rating === selection[0].rating) ? selection[0].rating : -1)
  const starNow = !none && selection.every(c => c.starred)
  const editTitle = none ? 'カットを選ぶと付けられます(クリック・Shift で範囲・Ctrl で追加)' : ''
  const canSplit = shown > cut.start && shown < cut.end

  return (
    <div className="h-full flex flex-col min-h-0 overflow-y-auto" data-lib-detail>
      <div className="relative bg-black aspect-video flex-shrink-0">
        <video ref={vRef} src={src} preload="auto" muted={false} playsInline
               className="absolute inset-0 w-full h-full object-contain"
               onLoadedMetadata={() => { setReady(true); seekFrame(rangeRef.current.s) }}
               onPause={() => setPlaying(false)}
               onClick={togglePlay} />
        {!ready && <span className="absolute inset-0 flex items-center justify-center text-[11px] text-zinc-500">読み込み中…</span>}
        <span className="absolute left-1.5 top-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-950/80 text-zinc-100" data-lib-shown-frame={shown}>
          {fmtTc(shown, fps)} <span className="text-zinc-400">({shown - cut.start + 1}/{len})</span>
        </span>
      </div>

      {/* つまみ・コマ送り */}
      <div className="px-3 pt-2 flex flex-col gap-1.5">
        <input type="range" min={cut.start} max={Math.max(cut.start, cut.end - 1)} value={shown}
               onChange={ev => { const v = vRef.current; if (v && !v.paused) { v.pause(); setPlaying(false) } seekFrame(Number(ev.target.value)) }}
               className="w-full accent-purple-500" data-lib-scrub />
        <div className="flex items-center gap-1">
          <button onClick={() => step(-(shown - cut.start))} className={btn} title="頭へ">⏮</button>
          <button onClick={() => step(-1)} className={btn} title="1 コマ戻る" data-lib-step="-1">◀</button>
          <button onClick={togglePlay} className={`${btn} w-14`} title="再生 / 停止(Space)" data-lib-play>
            {playing ? '⏸ 停止' : '▶ 再生'}
          </button>
          <button onClick={() => step(1)} className={btn} title="1 コマ進む" data-lib-step="1">▶</button>
          <button onClick={() => step(cut.end - 1 - shown)} className={btn} title="尻へ">⏭</button>
          <span className="ml-auto text-[10px] text-zinc-400 text-right leading-tight">
            #{cut.idx + 1} · {fmtLen(len, fps)}<br />
            <span className="text-zinc-500">{fmtTc(cut.start, fps)} 〜 {fmtTc(cut.end, fps)}</span>
          </span>
        </div>
        <div className="text-[10px] text-zinc-500 flex flex-wrap gap-x-2">
          <span>入り: <span className="text-zinc-300">{TRANS_LABEL[cut.trans_in] ?? cut.trans_in}{cut.trans_frames ? ` ${cut.trans_frames}f` : ''}</span></span>
          <span>明るさ {(cut.luma * 100).toFixed(0)}</span>
          <span>動き {(cut.motion * 100).toFixed(1)}</span>
          <span>彩度 {(cut.sat * 100).toFixed(0)}</span>
          {cut.hue != null && (
            <span className="flex items-center gap-1">色相 <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: `hsl(${cut.hue} 70% 50%)` }} /></span>
          )}
          {cut.dark && <span className="text-indigo-300">暗い</span>}
          {cut.bright && <span className="text-amber-200">明るい</span>}
        </div>
      </div>

      {/* つなぐ / 分ける */}
      <div className="px-3 pt-2 flex flex-wrap gap-1">
        <button disabled={!prev || busy} onClick={() => p.onMerge('prev')} className={btn2} data-lib-merge="prev"
                title={prev ? `#${prev.idx + 1} とこのカットを 1 つにする` : '前のカットがありません'}>⇤ 前とつなぐ</button>
        <button disabled={!next || busy} onClick={() => p.onMerge('next')} className={btn2} data-lib-merge="next"
                title={next ? `このカットと #${next.idx + 1} を 1 つにする` : '後のカットがありません'}>後とつなぐ ⇥</button>
        <button disabled={!canSplit || busy} onClick={() => p.onSplit(shown)} className={btn2} data-lib-split
                title={canSplit ? `表示中のコマ ${fmtTc(shown, fps)} から後ろを別のカットにする` : 'カットの頭のコマでは分けられません(コマを進めてください)'}>
          ✂ ここで分ける
        </button>
        {busy && <span className="text-[10px] text-amber-300 self-center animate-pulse" data-lib-busy>サムネイルを作り直しています…</span>}
      </div>

      {/* 評価・★ */}
      <div className="px-3 pt-3 flex items-center gap-2">
        <span className="text-[10px] text-zinc-500 w-10 whitespace-nowrap" data-lib-target-count={selection.length}
              title={multi ? `選んでいる ${selection.length} カットに付く` : undefined}>
          {none ? '選択なし' : multi ? `${selection.length}件` : '評価'}
        </span>
        <div className="flex gap-0.5" data-lib-rating={ratingNow}>
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} onClick={() => p.onRate(ratingNow === n ? 0 : n)} disabled={none}
                    className={`text-base leading-none px-0.5 disabled:opacity-40 ${ratingNow >= n ? 'text-amber-400' : 'text-zinc-600 hover:text-amber-300'}`}
                    title={editTitle || `評価 ${n}(キー ${n}・0 で消す)`}>●</button>
          ))}
        </div>
        <button onClick={p.onStar} data-lib-star={starNow ? 1 : 0} disabled={none}
                className={`ml-auto text-xs px-2 py-1 rounded border disabled:opacity-40 ${starNow ? 'border-amber-600 bg-amber-950/50 text-amber-300' : 'border-zinc-700 text-zinc-400 hover:text-amber-300'}`}
                title={editTitle || '★(キー F)'}>{starNow ? '★ お気に入り' : '☆ お気に入り'}</button>
      </div>

      {/* タグ */}
      <div className="px-3 pt-3">
        <div className="text-[10px] text-zinc-500 mb-1">タグ{multi ? `(選んだ ${selection.length} カットに付く)` : none ? '(カットを選ぶと付けられます)' : ''}</div>
        <div className="flex flex-wrap gap-1 mb-1" data-lib-tags>
          {tagCounts.length === 0 && <span className="text-[10px] text-zinc-600">なし</span>}
          {tagCounts.map(([t, n]) => (
            <span key={t} className={`text-[10px] pl-1.5 pr-0.5 py-0.5 rounded flex items-center gap-0.5 ${n === targets.length ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800 text-zinc-400 border border-dashed border-zinc-600'}`}>
              {t}{multi && n < targets.length ? <span className="text-zinc-500">{n}</span> : null}
              <button onClick={() => p.onRemoveTag(t)} className="px-0.5 text-zinc-400 hover:text-red-300" title="外す">×</button>
            </span>
          ))}
        </div>
        <div className="relative">
          <input ref={tagRef} value={tagText} onChange={ev => setTagText(ev.target.value)}
                 onFocus={() => setTagFocus(true)} onBlur={() => setTimeout(() => setTagFocus(false), 150)}
                 onKeyDown={ev => {
                   if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) { ev.preventDefault(); addTag(tagText) }
                   if (ev.key === 'Escape') { (ev.target as HTMLInputElement).blur() }
                 }}
                 disabled={none}
                 placeholder={none ? 'カットを選ぶとタグを付けられます' : 'タグを追加(Enter)… キー T'} data-lib-tag-input
                 className="w-full bg-zinc-800 text-[11px] text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500 disabled:opacity-50" />
          {tagFocus && sugg.length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-0.5 max-h-40 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 shadow-xl">
              {sugg.map(t => (
                <button key={t.tag} onMouseDown={ev => { ev.preventDefault(); addTag(t.tag) }}
                        className="w-full text-left text-[11px] px-2 py-1 hover:bg-zinc-800 text-zinc-200 flex">
                  <span className="truncate">{t.tag}</span><span className="ml-auto text-zinc-500">{t.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* メモ */}
      <div className="px-3 pt-3 pb-3">
        <div className="text-[10px] text-zinc-500 mb-1">メモ(このカット)</div>
        <textarea value={note} onChange={ev => setNote(ev.target.value)}
                  onBlur={() => { if (note !== cut.note) p.onNote(note) }}
                  rows={2} data-lib-note
                  className="w-full bg-zinc-800 text-[11px] text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500 resize-y" />
      </div>
    </div>
  )
})

const btn = 'text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
const btn2 = 'text-[11px] px-2 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 disabled:opacity-35 disabled:hover:bg-zinc-900'
