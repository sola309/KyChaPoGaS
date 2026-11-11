// 📚 カット一覧(仮想スクロール)。数千枚でも見えている行だけを描く。
// サムネイルはスプライト(1 枚 50 カット・1 行 = 頭/中/尻 の 3 コマ 192×108)の背景位置で切り出す。
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { LibraryCut } from '../../api/library'
import { libraryApi } from '../../api/library'
import { fmtLen, fmtTc, TRANS_BADGE, TRANS_BADGE_CLASS, TRANS_LABEL } from './libraryUtils'

const GAP = 8
const PAD = 8
const MIN_CARD_W = 164
const INFO_H = 46
const OVERSCAN_ROWS = 3
const CELL_W = 192
const CELL_H = 108
const PER_SHEET = 50

export interface CutGridHandle {
  scrollToIndex: (i: number) => void
  scrollToTop: () => void
  cols: () => number
  scrollTop: () => number
}

interface Props {
  assetId: number
  cuts: LibraryCut[]
  fps: number
  sheetVer: (sheet: number) => string
  selected: Set<number>
  currentId: number | null
  initialScrollTop: number
  onCardClick: (cut: LibraryCut, index: number, e: React.MouseEvent) => void
  onCardDoubleClick: (cut: LibraryCut) => void
  onCardDragStart?: (cut: LibraryCut, e: React.DragEvent) => void
  onCardDragEnd?: () => void
  onScrollTop?: (top: number) => void
}

export const CutGrid = forwardRef<CutGridHandle, Props>(function CutGrid(props, ref) {
  const { assetId, cuts, fps, sheetVer, selected, currentId, initialScrollTop,
          onCardClick, onCardDoubleClick, onCardDragStart, onCardDragEnd, onScrollTop } = props
  const scRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const rafRef = useRef(0)

  useLayoutEffect(() => {
    const el = scRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const innerW = Math.max(0, size.w - PAD * 2)
  const cols = Math.max(1, Math.floor((innerW + GAP) / (MIN_CARD_W + GAP)))
  const cardW = Math.max(80, Math.floor((innerW - GAP * (cols - 1)) / cols))
  const thumbW = cardW - 8
  const thumbH = Math.round(thumbW * 9 / 16)
  const cardH = thumbH + 8 + INFO_H
  const rowH = cardH + GAP
  const rows = Math.ceil(cuts.length / cols)
  const totalH = rows * rowH + PAD * 2 - (rows > 0 ? GAP : 0)

  // 初回(と素材の切り替え)だけ保存したスクロール位置へ戻す
  const restoredFor = useRef<string>('')
  useLayoutEffect(() => {
    const el = scRef.current
    const key = `${assetId}`
    if (!el || size.w === 0 || cuts.length === 0 || restoredFor.current === key) return
    restoredFor.current = key
    el.scrollTop = initialScrollTop
    setScrollTop(el.scrollTop)
  }, [assetId, size.w, cuts.length, initialScrollTop])

  const onScroll = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const el = scRef.current
      if (!el) return
      setScrollTop(el.scrollTop)
      onScrollTop?.(el.scrollTop)
    })
  }, [onScrollTop])
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  useImperativeHandle(ref, () => ({
    scrollToIndex: (i: number) => {
      const el = scRef.current
      if (!el || i < 0) return
      const r = Math.floor(i / cols)
      const top = PAD + r * rowH
      if (top < el.scrollTop) el.scrollTop = Math.max(0, top - PAD)
      else if (top + cardH > el.scrollTop + el.clientHeight) el.scrollTop = top + cardH - el.clientHeight + PAD
    },
    scrollToTop: () => { if (scRef.current) scRef.current.scrollTop = 0 },
    cols: () => cols,
    scrollTop: () => scRef.current?.scrollTop ?? 0,
  }), [cols, rowH, cardH])

  const firstRow = Math.max(0, Math.floor((scrollTop - PAD) / rowH) - OVERSCAN_ROWS)
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + size.h) / rowH) + OVERSCAN_ROWS)
  const items: React.ReactNode[] = []
  if (size.w > 0) {
    for (let r = firstRow; r <= lastRow; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        if (i >= cuts.length) break
        const cut = cuts[i]
        items.push(
          <CutCard key={cut.id} cut={cut} index={i} assetId={assetId} fps={fps}
                   ver={sheetVer(Math.floor((cut.thumb_idx ?? cut.idx) / PER_SHEET))}
                   left={PAD + c * (cardW + GAP)} top={PAD + r * rowH}
                   width={cardW} thumbW={thumbW} thumbH={thumbH}
                   selected={selected.has(cut.id)} current={cut.id === currentId}
                   onClick={onCardClick} onDoubleClick={onCardDoubleClick}
                   onDragStart={onCardDragStart} onDragEnd={onCardDragEnd} />,
        )
      }
    }
  }

  return (
    <div ref={scRef} onScroll={onScroll} data-lib-grid
         className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-zinc-950"
         style={{ contain: 'strict' }}>
      <div style={{ height: Math.max(totalH, 0), position: 'relative' }}>
        {items}
      </div>
      {cuts.length === 0 && (
        <p className="absolute inset-x-0 top-10 text-center text-xs text-zinc-500">条件に合うカットがありません</p>
      )}
    </div>
  )
})

interface CardProps {
  cut: LibraryCut
  index: number
  assetId: number
  fps: number
  ver: string
  left: number
  top: number
  width: number
  thumbW: number
  thumbH: number
  selected: boolean
  current: boolean
  onClick: Props['onCardClick']
  onDoubleClick: Props['onCardDoubleClick']
  onDragStart?: Props['onCardDragStart']
  onDragEnd?: Props['onCardDragEnd']
}

/** 1 枚のカード。ホバー中は 頭→中→尻 を巡回する */
const CutCard = memo(function CutCard({ cut, index, assetId, fps, ver, left, top, width, thumbW, thumbH,
                                         selected, current, onClick, onDoubleClick, onDragStart, onDragEnd }: CardProps) {
  const [cell, setCell] = useState(1)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null } setCell(1) }
  const start = () => {
    if (timer.current) return
    setCell(0)
    let k = 0
    timer.current = setInterval(() => { k = (k + 1) % 3; setCell(k) }, 380)
  }
  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  const s = thumbW / CELL_W
  const ti = cut.thumb_idx ?? cut.idx
  const row = ti % PER_SHEET
  const sheet = Math.floor(ti / PER_SHEET)
  const len = cut.end - cut.start
  const badge = TRANS_BADGE[cut.trans_in]
  return (
    <div data-lib-card={cut.id} data-lib-index={index}
         draggable={!!onDragStart}
         onDragStart={onDragStart ? e => onDragStart(cut, e) : undefined}
         onDragEnd={onDragEnd}
         onMouseDown={e => { if (e.shiftKey) e.preventDefault() /* Shift 範囲選択で文字が選択されないように */ }}
         onClick={e => onClick(cut, index, e)}
         onDoubleClick={() => onDoubleClick(cut)}
         onMouseEnter={start} onMouseLeave={stop}
         className={`absolute rounded-md p-1 cursor-pointer select-none transition-colors ${
           selected ? 'bg-purple-950/70 ring-2 ring-purple-400' : 'bg-zinc-900 hover:bg-zinc-800 ring-1 ring-zinc-800'
         } ${current ? 'outline outline-2 outline-offset-1 outline-amber-400' : ''}`}
         style={{ left, top, width }}
         title={`#${cut.idx + 1} ${fmtTc(cut.start, fps)} 〜 ${fmtTc(cut.end, fps)}(${TRANS_LABEL[cut.trans_in] ?? cut.trans_in}${cut.trans_frames ? ` ${cut.trans_frames}f` : ''})`}>
      <div className="relative rounded overflow-hidden bg-zinc-800"
           style={{
             width: thumbW, height: thumbH,
             backgroundImage: `url(${libraryApi.spriteUrl(assetId, sheet, ver)})`,
             backgroundSize: `${CELL_W * 3 * s}px auto`,
             backgroundPosition: `${-cell * CELL_W * s}px ${-row * CELL_H * s}px`,
             backgroundRepeat: 'no-repeat',
           }}>
        {badge && (
          <span className={`absolute left-1 top-1 text-[9px] leading-none px-1 py-0.5 rounded ${TRANS_BADGE_CLASS[cut.trans_in] ?? 'bg-zinc-800 text-zinc-200'}`}
                title={`${TRANS_LABEL[cut.trans_in] ?? cut.trans_in}${cut.trans_frames ? ` ${cut.trans_frames}f` : ''}`}>
            {badge}{cut.trans_frames > 0 && cut.trans_in !== 'start' ? <span className="opacity-70"> {cut.trans_frames}</span> : null}
          </span>
        )}
        {cut.starred && <span className="absolute right-1 top-0.5 text-amber-400 text-sm leading-none drop-shadow">★</span>}
        {cut.edited && <span className="absolute right-1 bottom-1 text-[9px] leading-none px-1 py-0.5 rounded bg-zinc-950/80 text-zinc-300" title="つなぐ・分けるで直したカット">✂</span>}
        <span className="absolute left-1 bottom-1 text-[9px] leading-none px-1 py-0.5 rounded bg-zinc-950/75 text-zinc-300">#{cut.idx + 1}</span>
        {cell !== 1 && (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-zinc-950/60">
            <span className="block h-full bg-amber-400" style={{ width: `${(cell + 1) * 33.3}%` }} />
          </span>
        )}
      </div>
      <div className="px-0.5 pt-1 flex flex-col gap-0.5" style={{ height: INFO_H }}>
        <div className="flex items-center gap-1 text-[10px] leading-none">
          <span className="font-mono text-zinc-200">{fmtTc(cut.start, fps)}</span>
          <span className="ml-auto text-zinc-400 whitespace-nowrap">{fmtLen(len, fps)}</span>
        </div>
        <div className="flex items-center gap-1 min-w-0">
          <span className="flex gap-[2px] flex-shrink-0" title={`評価 ${cut.rating}`}>
            {[1, 2, 3, 4, 5].map(n => (
              <span key={n} className={`w-1.5 h-1.5 rounded-full ${n <= cut.rating ? 'bg-amber-400' : 'bg-zinc-700'}`} />
            ))}
          </span>
          <span className="flex gap-0.5 min-w-0 overflow-hidden">
            {cut.tags.slice(0, 3).map(t => (
              <span key={t} className="text-[9px] leading-none px-1 py-0.5 rounded bg-zinc-800 text-zinc-300 whitespace-nowrap">{t}</span>
            ))}
            {cut.tags.length > 3 && <span className="text-[9px] text-zinc-500">+{cut.tags.length - 3}</span>}
          </span>
        </div>
        {cut.note && <div className="text-[9px] text-zinc-500 truncate" title={cut.note}>{cut.note}</div>}
      </div>
    </div>
  )
})
