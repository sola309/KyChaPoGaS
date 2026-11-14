import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Asset, Clip, Track } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { deriveCutsWithScene } from './SceneLane'
import { TakeSelector } from './TakeSelector'

/**
 * 📱 確認用タイムライン(スマホ)。編集用のタイムライン(Timeline.tsx)を縮めて出す代わりの、見るだけの帯。
 *
 *  - 再生位置は帯のまん中に固定。帯を左右になぞると、その分だけコマが動く(スクラブ)
 *  - 上の段 = 時刻の目盛り、下の段 = カットの帯(C 番号)。カットを押すとそのカットの頭へ。
 *    頭にいるカットをもう一度押すと 🗂 テイク履歴(カット割りレーンの 2 回押しと同じもの)
 *  - カット(Image トラックのピンの組)が無いプロジェクトでは、いちばん上の映像トラックのクリップの区間を帯にする
 *  - 「✎ 編集」で今までのタイムラインに切り替える(ProjectView が切り替えを持つ)
 *
 * ここからは何も書き込まない(テイク履歴の「採用」だけは、開いた先で人が押したときに書く)。
 */

interface Props {
  fps: number
  assets: Asset[]
  onEdit: () => void
}

interface Band { n: number; label: string; s: number; e: number; cut: boolean; title: string }

const RULER_H = 24
const BAND_H = 44
/** 帯ぜんたいの高さ(上下の線こみ)。ProjectView の並びはこれを知らなくてよい(中身の高さで決まる) */
export const REVIEW_TIMELINE_H = RULER_H + BAND_H + 4

const hue = (i: number) => `hsl(${Math.round(((i * 0.14) % 1) * 360)}, 45%, 34%)`   // カット割りレーンと同じ色の順

function bandsOf(tracks: Track[], clips: Clip[]): Band[] {
  const cuts = deriveCutsWithScene(tracks, clips)
  if (cuts.length) {
    return cuts.map(c => ({ n: c.idx, label: `C${c.idx}`, s: c.s, e: c.e, cut: true, title: `カット ${c.idx}` }))
  }
  // カットが無い: クリップのある、いちばん上の映像トラック(見えているもの)の区間
  const vts = tracks.filter(t => t.track_type === 'video' && !t.hidden).sort((a, b) => a.order - b.order)
  for (const t of vts) {
    const cs = clips.filter(c => c.track_id === t.id && c.duration_frames > 0).sort((a, b) => a.start_frame - b.start_frame)
    if (cs.length) {
      return cs.map((c, i) => ({ n: i + 1, label: String(i + 1), s: c.start_frame, e: c.start_frame + c.duration_frames - 1,
                                 cut: false, title: `${t.name} のクリップ ${i + 1}` }))
    }
  }
  return []
}

const fmtSec = (sec: number) => {
  const m = Math.floor(sec / 60), s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 帯の中身(目盛りとカット)。再生位置では描き直さない */
const Strip = memo(function Strip({ bands, ppf, fps, lastFrame, armed }: {
  bands: Band[]; ppf: number; fps: number; lastFrame: number; armed: number | null
}) {
  const pps = ppf * fps
  const step = pps >= 70 ? 1 : pps >= 36 ? 2 : pps >= 15 ? 5 : pps >= 7 ? 10 : 30
  const secs = Math.ceil(lastFrame / fps)
  const marks: number[] = []
  for (let s = 0; s <= secs; s += step) marks.push(s)
  return (
    <>
      <div className="absolute left-0 top-0 border-b border-zinc-700" style={{ height: RULER_H, width: Math.max(1, lastFrame * ppf) }}>
        {marks.map(s => (
          <div key={s} className="absolute top-0 bottom-0 flex items-end" style={{ left: s * pps }}>
            <div className="absolute left-0 top-0 w-px h-2 bg-zinc-500" />
            <span className="pl-1 text-[12px] leading-none pb-1 text-zinc-400 font-mono tabular-nums whitespace-nowrap">{fmtSec(s)}</span>
          </div>
        ))}
      </div>
      {bands.map((b, i) => {
        const w = Math.max(3, (b.e + 1 - b.s) * ppf - 1)
        const on = armed === b.s
        return (
          <div key={`${b.s}-${i}`} data-review-band={b.n} data-band-index={i} title={b.title}
               className={`absolute rounded-sm border overflow-hidden flex items-center ${on ? 'border-purple-300 ring-1 ring-purple-300' : 'border-black/40'}`}
               style={{ left: b.s * ppf, width: w, top: RULER_H + 3, height: BAND_H - 6, background: b.cut ? hue(i % 12) : '#1e40af' }}>
            {w >= 26 && (
              <span className="pl-1.5 text-[13px] font-semibold text-white whitespace-nowrap leading-none">
                {b.label}
                {on && b.cut && w >= 44 && <span className="ml-1 font-normal text-[12px] text-purple-100">🗂</span>}
                {w >= 96 && !(on && b.cut) && <span className="ml-1.5 font-normal text-[12px] text-white/60">{((b.e + 1 - b.s) / fps).toFixed(1)}s</span>}
              </span>
            )}
          </div>
        )
      })}
    </>
  )
})

/** 再生位置に合わせて帯を送る(ここだけが再生位置を購読する) */
function Scroller({ ppf, center, children }: { ppf: number; center: number; children: React.ReactNode }) {
  const frame = useTimelineStore(s => s.currentFrame)
  return (
    <div className="absolute top-0 bottom-0 left-0 will-change-transform" data-review-frame={frame}
         style={{ transform: `translate3d(${Math.round(center - frame * ppf)}px,0,0)` }}>
      {children}
    </div>
  )
}

/** まん中の再生位置の札(今のカット・コマ) */
function HeadBadge({ bands }: { bands: Band[] }) {
  const frame = useTimelineStore(s => s.currentFrame)
  const b = bands.find(x => x.s <= frame && frame <= x.e)
  return (
    <span className="absolute top-0 left-1/2 -translate-x-1/2 px-1.5 rounded-b bg-purple-600 text-white text-[12px] leading-[18px] font-mono tabular-nums whitespace-nowrap pointer-events-none z-10">
      {b ? `${b.label} · ` : ''}{frame}f
    </span>
  )
}

export function ReviewTimeline({ fps, assets, onEdit }: Props) {
  const tracks = useTimelineStore(s => s.tracks)
  const clips = useTimelineStore(s => s.clips)
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)

  const bands = useMemo(() => bandsOf(tracks, clips), [tracks, clips])
  const lastFrame = useMemo(() => Math.max(fps, ...clips.map(c => c.start_frame + c.duration_frames)), [clips, fps])

  // 拡大率: 帯のまん中ぐらいの長さのカットが 60px ほどになるように(短いカットも押せる・長い作品も送りやすい)
  const ppf = useMemo(() => {
    if (!bands.length) return 48 / fps
    const lens = bands.map(b => b.e + 1 - b.s).sort((a, b) => a - b)
    const med = lens[Math.floor(lens.length / 2)]
    return Math.min(120, Math.max(16, (60 / med) * fps)) / fps
  }, [bands, fps])

  // 帯の幅(まん中 = 再生位置)
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const upd = () => setWidth(el.clientWidth)
    upd()
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', upd); return () => window.removeEventListener('resize', upd) }
    const ro = new ResizeObserver(upd)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 押した(頭へ送った)カットの頭のコマ。頭にいる間にもう一度押すと 🗂 テイク履歴
  const [armed, setArmed] = useState<number | null>(null)
  const [takeCut, setTakeCut] = useState<{ s: number; e: number } | null>(null)
  // 頭から離れたら「もう一度押すと開く」をやめる
  useEffect(() => useTimelineStore.subscribe((s, prev) => {
    if (s.currentFrame !== prev.currentFrame) setArmed(a => (a === s.currentFrame ? a : null))
  }), [])

  // なぞる = スクラブ(指の動きの分だけコマを送る)、動かさずに離す = 押した
  const drag = useRef<{ id: number; x0: number; f0: number; moved: boolean; band: number | null } | null>(null)
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const hit = (e.target as HTMLElement).closest?.('[data-band-index]') as HTMLElement | null
    drag.current = { id: e.pointerId, x0: e.clientX, f0: useTimelineStore.getState().currentFrame, moved: false,
                     band: hit ? Number(hit.dataset.bandIndex) : null }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 取れなくても動く */ }
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x0
    if (!d.moved && Math.abs(dx) < 6) return
    d.moved = true
    setCurrentFrame(Math.min(lastFrame - 1, Math.max(0, Math.round(d.f0 - dx / ppf))))
  }
  const tap = useRef<{ band: number | null; x: number } | null>(null)
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    // 押した結果は、このあとの click で処理する(ここでテイク履歴を開くと、続いて来る click が開いた画面の背景に当たって閉じてしまう)
    tap.current = d.moved || e.type === 'pointercancel' ? null : { band: d.band, x: e.clientX }
  }
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = tap.current
    tap.current = null
    if (!t) return
    if (t.band != null) {
      const b = bands[t.band]
      if (!b) return
      if (b.cut && armed === b.s && useTimelineStore.getState().currentFrame === b.s) { setTakeCut({ s: b.s, e: b.e }); return }
      setCurrentFrame(b.s)
      setArmed(b.s)
      return
    }
    // 帯の外(目盛り・すき間)を押した: その位置へ
    const rect = e.currentTarget.getBoundingClientRect()
    const f = useTimelineStore.getState().currentFrame + (t.x - rect.left - rect.width / 2) / ppf
    setCurrentFrame(Math.min(lastFrame - 1, Math.max(0, Math.round(f))))
  }

  return (
    <div className="flex items-stretch bg-zinc-950 border-t border-zinc-800 select-none" data-review-timeline
         style={{ height: REVIEW_TIMELINE_H, WebkitTapHighlightColor: 'transparent' }}>
      <div ref={boxRef} className="relative flex-1 min-w-0 overflow-hidden cursor-ew-resize" data-review-strip
           style={{ touchAction: 'none' }}
           role="slider" aria-label="確認用タイムライン(なぞって送る)" aria-valuemin={0} aria-valuemax={lastFrame - 1}
           onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClick={onClick}>
        <Scroller ppf={ppf} center={width / 2}>
          <Strip bands={bands} ppf={ppf} fps={fps} lastFrame={lastFrame} armed={armed} />
        </Scroller>
        {bands.length === 0 && (
          <span className="absolute left-2 text-[12px] text-zinc-500 pointer-events-none" style={{ top: RULER_H + 14 }}>クリップがありません</span>
        )}
        {/* 再生位置(まん中に固定) */}
        <div className="absolute top-0 bottom-0 left-1/2 w-0.5 -ml-px bg-purple-400 pointer-events-none z-10" />
        <HeadBadge bands={bands} />
      </div>
      <button type="button" onClick={onEdit} data-review-edit
              className="flex-shrink-0 w-[60px] border-l border-zinc-800 bg-zinc-900 text-zinc-200 active:bg-zinc-700 flex flex-col items-center justify-center gap-0.5"
              style={{ touchAction: 'manipulation' }}
              title="編集用のタイムライン(トラック・クリップ)に切り替える" aria-label="編集用のタイムラインに切り替える">
        <span className="text-base leading-none">✎</span>
        <span className="text-[12px] leading-none">編集する</span>
      </button>
      {takeCut && <TakeSelector cut={takeCut} assets={assets} fps={fps} onClose={() => setTakeCut(null)} />}
    </div>
  )
}
