// 📚 素材全体の帯: 上がチャプター、下がカットの密度(1 カット 1 本の目盛り・入り方で色分け)。
// 絞り込みに入っているカットは色つき、外れたカットは薄く。クリックでその位置のカットへ飛ぶ。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LibraryChapter, LibraryCut } from '../../api/library'
import { fmtTc, TRANS_COLOR, TRANS_LABEL } from './libraryUtils'

interface Props {
  cuts: LibraryCut[]
  visibleIds: Set<number>
  frames: number
  fps: number
  chapters: LibraryChapter[]
  currentStart: number | null
  chapterFilter: number
  onJump: (frame: number) => void
  onChapter: (i: number) => void
}

export function SourceStrip({ cuts, visibleIds, frames, fps, chapters, currentStart, chapterFilter, onJump, onChapter }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<{ x: number; frame: number } | null>(null)
  const total = Math.max(1, frames || (cuts.length ? cuts[cuts.length - 1].end : 1))

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const H = 22
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || w <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(H * dpr)
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, H)
    g.fillStyle = '#1b1619'
    g.fillRect(0, 0, w, H)
    const filtered = visibleIds.size < cuts.length
    // 外れたカット(薄い)→ 入っているカット(色)の順に描く
    for (const pass of [0, 1]) {
      for (const c of cuts) {
        const inside = visibleIds.has(c.id)
        if ((pass === 0) === inside && filtered) continue
        if (pass === 0 && !filtered) continue
        const x = Math.floor(c.start / total * w) + 0.5
        g.strokeStyle = inside ? (TRANS_COLOR[c.trans_in] ?? '#9c878c') : '#3b3034'
        g.globalAlpha = inside ? 0.95 : 0.8
        g.beginPath()
        const special = c.trans_in !== 'hard'
        g.moveTo(x, special ? 2 : 6)
        g.lineTo(x, H - 2)
        g.stroke()
      }
    }
    g.globalAlpha = 1
    if (currentStart != null) {
      const x = Math.floor(currentStart / total * w) + 0.5
      g.fillStyle = '#fbbf24'
      g.fillRect(x - 1, 0, 3, H)
    }
  }, [cuts, visibleIds, total, w, currentStart])

  const frameAt = (clientX: number) => {
    const el = wrapRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(total - 1, Math.round((clientX - r.left) / Math.max(1, r.width) * total)))
  }

  return (
    <div className="px-3 pt-1.5 pb-1 flex flex-col gap-1 border-b border-zinc-800 bg-zinc-900/60" data-lib-strip>
      {chapters.length > 0 && (
        <div className="flex h-4 rounded overflow-hidden text-[9px] leading-4" data-lib-chapters>
          {chapters.map((ch, i) => {
            const pct = (ch.end_frame - ch.start_frame) / total * 100
            const on = chapterFilter === i
            // 「Chapter 07」は番号だけ。幅が足りない区切りは文字を出さない
            const px = pct / 100 * w
            const m = /^chapter\s*0*(\d+)$/i.exec(ch.title.trim())
            const label = px < 14 ? '' : m ? m[1] : ch.title
            return (
              <button key={i} onClick={() => onChapter(i)}
                      className={`truncate px-0.5 border-r border-zinc-950 text-center ${
                        on ? 'bg-purple-800 text-purple-50' : i % 2 ? 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700' : 'bg-zinc-700/70 text-zinc-300 hover:bg-zinc-600'}`}
                      style={{ width: `${pct}%`, minWidth: 2 }}
                      title={`${ch.title}  ${fmtTc(ch.start_frame, fps)} 〜 ${fmtTc(ch.end_frame, fps)}(クリックでこのチャプターの頭へ。絞り込みは上の「チャプター」)`}
                      data-lib-chapter={i}>
                {label}
              </button>
            )
          })}
        </div>
      )}
      <div ref={wrapRef} className="relative cursor-crosshair" style={{ height: H }}
           onMouseMove={e => setHover({ x: e.clientX - (wrapRef.current?.getBoundingClientRect().left ?? 0), frame: frameAt(e.clientX) })}
           onMouseLeave={() => setHover(null)}
           onClick={e => onJump(frameAt(e.clientX))}
           title="カットの密度(色 = 入り方)。クリックでその位置のカットへ">
        <canvas ref={canvasRef} className="absolute inset-0 rounded" style={{ width: '100%', height: H }} />
        {hover && (
          <span className="absolute -top-0.5 pointer-events-none text-[9px] px-1 rounded bg-zinc-950/90 text-zinc-200 border border-zinc-700 whitespace-nowrap"
                style={{ left: Math.min(Math.max(0, hover.x + 6), Math.max(0, w - 70)) }}>
            {fmtTc(hover.frame, fps)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[9px] text-zinc-500">
        {(['hard', 'dissolve', 'fade_black', 'fade_white', 'flash_cut'] as const).map(k => (
          <span key={k} className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ background: TRANS_COLOR[k] }} />{TRANS_LABEL[k]}
          </span>
        ))}
      </div>
    </div>
  )
}
