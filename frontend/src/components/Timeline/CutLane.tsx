import { useEffect, useMemo, useRef, useState } from 'react'
import type { Asset, Clip, Track } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { TakeSelector } from './TakeSelector'
import { PrevizPopover } from './PrevizPopover'

/**
 * 🎬 カット割りレーン v3 — Imageトラックのピンを時刻順に「2個ずつペアリング」して
 * カット(開始フレーム→終了フレーム)を導出する。データを持たないため:
 *  - ピンのドラッグに常に連動
 *  - ピンが別のピンをまたぐと並び順が変わり、ペアが組み直される
 *  - ピンが奇数個のときは最後の1つを「未ペア」として黄色表示
 * 終端ピンのフレームは「カットの最終フレーム」(包含)。1フレームカット可。
 *
 * カット端のドラッグ(1フレーム精度で生成/消滅の両対応):
 *  - 縮めて空きを作る → 空きに新規カットが即時自動生成(Timelineの'kychapogas:pin-moved')
 *  - 隣カットに食い込む → 隣の端がロールして境界移動
 *  - 隣カットを丸ごと越える → そのカットは消滅(ドラッグ中は赤く予告表示)
 */

interface Props {
  tracks: Track[]
  clips: Clip[]
  assets: Asset[]
  pixelsPerFrame: number
  fps: number
  totalWidth: number
}

interface CutInfo { s: number; e: number; sId: number; eId: number }

/**
 * MiniMax H3 の推奨尺(17n+5 フレーム @24fps, 124〜362f = 5.17〜15.08秒)への当てはまり。
 * プロジェクトfpsが24でない場合は24fps換算してから判定する。
 *  ◎ 完全一致 / ○ 使用率90%以上 / △ 70〜90% / ▽ 70%未満(生成分の3割超を捨てる)
 *  短 = 124f未満(伸ばす or 隣とまとめる) / 分割 = 362f超(2本に割る)
 */
export const h3Grid = (n: number) => { const m = Math.max(124, Math.min(362, n)); return Math.min(362, m + (5 - (m % 17)) % 17) }
export type H3Fit = { n24: number; snap: number; use: number; grade: '◎' | '○' | '△' | '▽' | '短' | '継続' | '分割'; color: string; hint: string }
export function h3Fit(frames: number, fps: number): H3Fit {
  const n24 = Math.max(1, Math.round(frames * 24 / fps))
  const snap = h3Grid(n24)
  const use = n24 / snap
  const sec = (f: number) => (f / 24).toFixed(2) + 's'
  const toProj = (f24: number) => Math.round(f24 * fps / 24)
  if (n24 < 124) return { n24, snap, use, grade: '短', color: '#f87171', hint: `最短124f(${sec(124)})に ${toProj(124 - n24)}f 足りない → 伸ばすか隣と統合` }
  if (n24 > 1042) return { n24, snap, use, grade: '分割', color: '#f87171', hint: `継続生成の上限3段(1042f=${sec(1042)})超 → 分割が必要` }
  if (n24 > 362) {
    // 362f超は継続生成(前セグメント末尾22fを次の先頭へ固定→連結)。正味は 17n+5 グリッドに乗る
    const segs = Math.ceil((n24 - 362) / 340) + 1
    const g = n24 + (5 - (n24 % 17)) % 17
    return { n24, snap: g, use: n24 / g, grade: '継続', color: '#fbbf24',
             hint: `362f超 → 継続生成${segs}段(正味${g}f=${sec(g)})` + (g === n24 ? '・グリッド一致' : ` ・ +${toProj(g - n24)}f でグリッド一致`) }
  }
  const up = snap - n24
  const down = n24 - (snap - 17)
  if (up === 0) return { n24, snap, use, grade: '◎', color: '#4ade80', hint: `17n+5 に完全一致(${sec(snap)})` }
  const adj = `+${toProj(up)}f で ${sec(snap)} 一致` + (snap - 17 >= 124 ? ` / −${toProj(down)}f で ${sec(snap - 17)} 一致` : '')
  if (use >= 0.9) return { n24, snap, use, grade: '○', color: '#a3e635', hint: `生成${snap}f(${sec(snap)})の${Math.round(use * 100)}%を使用 ・ ${adj}` }
  if (use >= 0.7) return { n24, snap, use, grade: '△', color: '#fbbf24', hint: `生成${snap}f(${sec(snap)})の${Math.round(use * 100)}%を使用(捨て多め) ・ ${adj}` }
  return { n24, snap, use, grade: '▽', color: '#fb923c', hint: `生成${snap}f(${sec(snap)})の${Math.round(use * 100)}%しか使わない ・ ${adj}` }
}

interface DragState { cutIdx: number; side: 'l' | 'r'; frame: number; origFrame: number }

const hue = (i: number) => `hsl(${Math.round(((i * 0.14) % 1) * 360)}, 45%, 38%)`
const LANE_H = 26

export function CutLane({ tracks, clips, assets, pixelsPerFrame, fps, totalWidth }: Props) {
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const refSel = useTimelineStore(s => s.refSel)
  const [takeCut, setTakeCut] = useState<{ s: number; e: number; clipId?: number } | null>(null)   // 🗂テイクブラウザ
  const [previzCut, setPrevizCut] = useState<{ idx: number; pinId: number; frames: number; start: number } | null>(null)  // 🎞プレビズ
  const previzPress = useRef<number | null>(null)   // タッチ長押し検出
  // Shotsクリップの🗂ボタンなど、レーン外からも開けるようにする
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { s: number; e: number; clipId?: number } | undefined
      if (d) setTakeCut({ s: d.s, e: d.e, clipId: d.clipId })
    }
    window.addEventListener('kychapogas:open-takes', onOpen)
    return () => window.removeEventListener('kychapogas:open-takes', onOpen)
  }, [])
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const justDraggedRef = useRef(false)   // ドラッグ直後のclick(シーク)誤発火防止

  const { cuts, dangling } = useMemo(() => {
    const imgTrack = tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
    if (!imgTrack) return { cuts: [] as CutInfo[], dangling: null as number | null }
    const pins = clips
      .filter(c => c.track_id === imgTrack.id && c.asset_id != null)
      .map(c => ({ id: c.id, f: c.start_frame }))
      .sort((a, b) => a.f - b.f)
    const cuts: CutInfo[] = []
    for (let i = 0; i + 1 < pins.length; i += 2)
      cuts.push({ s: pins[i].f, e: pins[i + 1].f, sId: pins[i].id, eId: pins[i + 1].id })
    return { cuts, dangling: pins.length % 2 === 1 ? pins[pins.length - 1].f : null }
  }, [tracks, clips])

  // ドラッグ中: 消滅予定(呑み込まれる)カットの添字集合
  const doomed = useMemo(() => {
    const set = new Set<number>()
    if (!drag) return set
    const { cutIdx, side, frame } = drag
    if (side === 'r') {
      for (let j = cutIdx + 1; j < cuts.length && frame >= cuts[j].e; j++) set.add(j)
    } else {
      for (let j = cutIdx - 1; j >= 0 && frame <= cuts[j].s; j--) set.add(j)
    }
    return set
  }, [drag, cuts])

  const applyEdgeDrop = async (cutIdx: number, side: 'l' | 'r', newFrame: number) => {
    const st = useTimelineStore.getState()
    // ドラッグ中の状態変化に備えて最新ストアからペアを再導出
    const imgTrack = st.tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
    if (!imgTrack) return
    const pins = st.clips
      .filter(c => c.track_id === imgTrack.id && c.asset_id != null)
      .map(c => ({ id: c.id, f: c.start_frame }))
      .sort((a, b) => a.f - b.f)
    const cs: CutInfo[] = []
    for (let i = 0; i + 1 < pins.length; i += 2)
      cs.push({ s: pins[i].f, e: pins[i + 1].f, sId: pins[i].id, eId: pins[i + 1].id })
    const cut = cs[cutIdx]
    if (!cut) return

    const rolled: number[] = []
    const dead: number[] = []
    if (side === 'r') {
      const nf = Math.max(cut.s, newFrame)          // 自カットは最低1フレーム
      if (nf === cut.e) return
      for (let j = cutIdx + 1; j < cs.length; j++) {
        const n = cs[j]
        if (nf >= n.e) { dead.push(n.sId, n.eId); continue }   // 丸ごと呑み込み→消滅
        if (nf >= n.s) {                                        // 部分的に食い込み→ロール
          await st.updateClip(n.sId, { start_frame: nf + 1 })
          rolled.push(n.sId)
        }
        break
      }
      await st.updateClip(cut.eId, { start_frame: nf })
    } else {
      const nf = Math.min(cut.e, newFrame)
      if (nf === cut.s) return
      for (let j = cutIdx - 1; j >= 0; j--) {
        const p = cs[j]
        if (nf <= p.s) { dead.push(p.sId, p.eId); continue }
        if (nf <= p.e) {
          await st.updateClip(p.eId, { start_frame: nf - 1 })
          rolled.push(p.eId)
        }
        break
      }
      await st.updateClip(cut.sId, { start_frame: nf })
    }
    for (const id of dead) await st.deleteClip(id)
    if (rolled.length) {
      window.dispatchEvent(new CustomEvent('kychapogas:pin-roll', { detail: { clipIds: rolled } }))
    }
    // 動かした自カットの端: 画像追従+空きがあれば新規カット生成(fillGapsが判定)
    window.dispatchEvent(new CustomEvent('kychapogas:pin-moved', {
      detail: { clipId: side === 'r' ? cut.eId : cut.sId },
    }))
  }

  // カットクリック: シーク+そのカットのピンペアをKF選択にトグル。
  // 選択後はツールバーの「🎬選択KF→i2v」からFLF2V/VACE/H3/🎭Ref2Vへ流せる。
  const toggleCutSelect = (c: CutInfo) => {
    const st = useTimelineStore.getState()
    const both = st.refSel.includes(c.sId) && st.refSel.includes(c.eId)
    if (both) {
      st.toggleRefSel(c.sId)
      st.toggleRefSel(c.eId)
    } else {
      if (!st.refSel.includes(c.sId)) st.toggleRefSel(c.sId)
      if (!st.refSel.includes(c.eId)) st.toggleRefSel(c.eId)
    }
  }

  const startEdgeDrag = (e: React.PointerEvent, cutIdx: number, side: 'l' | 'r') => {
    e.stopPropagation()
    e.preventDefault()
    const cut = cuts[cutIdx]
    const origFrame = side === 'l' ? cut.s : cut.e
    const startX = e.clientX
    dragRef.current = { cutIdx, side, frame: origFrame, origFrame }
    setDrag(dragRef.current)
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const f = Math.max(0, Math.round(d.origFrame + (ev.clientX - startX) / pixelsPerFrame))
      if (f !== d.frame) {
        dragRef.current = { ...d, frame: f }
        setDrag(dragRef.current)
      }
    }
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!d) return
      if (d.frame !== d.origFrame) {
        justDraggedRef.current = true
        setTimeout(() => { justDraggedRef.current = false }, 200)
        void applyEdgeDrop(d.cutIdx, d.side, d.frame)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const fitStats = useMemo(() => {
    let bad = 0, meh = 0
    for (const c of cuts) { const g = h3Fit(c.e + 1 - c.s, fps).grade; if (g === '短' || g === '分割') bad++; else if (g === '△' || g === '▽' || g === '継続') meh++ }
    return { bad, meh }
  }, [cuts, fps])

  if (cuts.length === 0 && dangling == null) return null

  return (
    <div className="flex flex-shrink-0 border-b border-zinc-800" style={{ height: LANE_H }}>
      <div className="w-28 flex-shrink-0 border-r border-zinc-800 bg-zinc-950 flex items-center px-2 sticky left-0 z-30">
        <span className="text-[9px] text-zinc-500 whitespace-nowrap"
              title={`H3尺(17n+5f@24fps, 5.17〜15.08s)の適合: 緑=◎一致/○90%以上・黄=△70〜90%/継続(>15.08s、継続生成n段)・橙=▽70%未満・赤=短すぎ(<5.17s)/分割要(>43.4s)`}>
          🎬 カット割り {cuts.length}
          {dangling != null && <span className="text-yellow-300 ml-1" title="ピンが奇数本です。未ペアのピン(黄)以降のカットがずれていないか確認してください。ピンはダブルクリック/Delで相方ごと消えます">⚠奇数</span>}
          {fitStats.bad > 0 && <span className="text-red-400 ml-1">✗{fitStats.bad}</span>}
          {fitStats.meh > 0 && <span className="text-amber-400 ml-0.5">△{fitStats.meh}</span>}
        </span>
      </div>
      <div className="relative flex-shrink-0 bg-zinc-950" style={{ width: totalWidth }}>
        {cuts.map((c, i) => {
          // ドラッグ中は自カットの端をライブ反映(サーバ往復前に見た目が追従する)
          let s = c.s
          let e = c.e
          if (drag && drag.cutIdx === i) {
            if (drag.side === 'l') s = Math.min(e, drag.frame)
            else e = Math.max(s, drag.frame)
          }
          const w = Math.max(2, (e + 1 - s) * pixelsPerFrame)
          const isDoomed = doomed.has(i)
          const isSelected = refSel.includes(c.sId) && refSel.includes(c.eId)
          const fit = h3Fit(e + 1 - s, fps)
          return (
            <div
              key={`${c.sId}-${i}`}
              className={`absolute top-0.5 bottom-0.5 rounded-sm border overflow-visible
                          text-[9px] text-white/90 leading-none
                          ${isDoomed ? 'border-red-400 opacity-40'
                            : isSelected ? 'border-purple-300 ring-1 ring-purple-300'
                            : 'border-black/30 hover:brightness-125'}`}
              style={{ left: s * pixelsPerFrame, width: w,
                       background: isDoomed ? '#7f1d1d' : hue(i % 12) }}
              title={`C${i + 1}: ${(c.s / fps).toFixed(2)}s → ${((c.e + 1) / fps).toFixed(2)}s(${((c.e + 1 - c.s) / fps).toFixed(1)}秒)\nH3尺 ${fit.grade}: ${fit.n24}f@24fps → ${fit.hint}\nクリック=選択(i2v/Ref2V用)・ダブルクリック=🗂テイク履歴・端ドラッグ=境界調整`}
              onClick={() => {
                if (justDraggedRef.current) return
                setCurrentFrame(c.s)
                toggleCutSelect(c)
              }}
              onDoubleClick={() => setTakeCut({ s: c.s, e: c.e })}
              // 🎞プレビズ: 右クリック(タッチは長押し500ms)でカットの動き設定を開く
              onContextMenu={ev => {
                ev.preventDefault()
                setPrevizCut({ idx: i + 1, pinId: c.sId, frames: c.e + 1 - c.s, start: c.s })
              }}
              onPointerDown={ev => {
                if (ev.pointerType !== 'touch') return
                const x0 = ev.clientX, y0 = ev.clientY
                previzPress.current = window.setTimeout(() => {
                  setPrevizCut({ idx: i + 1, pinId: c.sId, frames: c.e + 1 - c.s, start: c.s })
                }, 500)
                const cancel = (mv: PointerEvent) => {
                  if (mv.type === 'pointermove' && Math.hypot(mv.clientX - x0, mv.clientY - y0) < 8) return
                  if (previzPress.current) { clearTimeout(previzPress.current); previzPress.current = null }
                  window.removeEventListener('pointermove', cancel)
                  window.removeEventListener('pointerup', cancel)
                }
                window.addEventListener('pointermove', cancel)
                window.addEventListener('pointerup', cancel)
              }}
            >
              <span className="absolute left-1.5 top-1/2 -translate-y-1/2 pointer-events-none flex gap-1 items-baseline overflow-hidden max-w-full">
                {w > 34 && <span>C{i + 1}</span>}
                {w > 84 && <span className="text-white/50">{((e + 1 - s) / fps).toFixed(1)}s</span>}
                {w > 110 && <span style={{ color: fit.color }}>{fit.grade}{fit.grade === '◎' || fit.grade === '短' || fit.grade === '分割' ? '' : fit.grade === '継続' ? `${Math.ceil((fit.n24 - 362) / 340) + 1}段` : `${Math.round(fit.use * 100)}%`}</span>}
              </span>
              {/* H3尺インジケータ: 下辺の色帯(狭いカットでも見える) */}
              <div className="absolute left-0 right-0 bottom-0 h-[3px] rounded-b-sm pointer-events-none"
                   style={{ background: fit.color, opacity: isDoomed ? 0.3 : 0.95 }} />
              {/* 端ドラッグハンドル: 8px+外側4pxまで掴める。狭いカットは右端のみ */}
              {w >= 18 && (
                <div className="absolute top-0 bottom-0 cursor-ew-resize z-10 group/hl"
                     style={{ left: -4, width: 10, touchAction: 'none' }}
                     onPointerDown={ev => startEdgeDrag(ev, i, 'l')}>
                  <div className="absolute left-[4px] top-0 bottom-0 w-[3px] bg-white/25 group-hover/hl:bg-amber-300/90 rounded-sm" />
                </div>
              )}
              <div className="absolute top-0 bottom-0 cursor-ew-resize z-10 group/hr"
                   style={{ right: -4, width: 10, touchAction: 'none' }}
                   onPointerDown={ev => startEdgeDrag(ev, i, 'r')}>
                <div className="absolute right-[4px] top-0 bottom-0 w-[3px] bg-white/25 group-hover/hr:bg-amber-300/90 rounded-sm" />
              </div>
            </div>
          )
        })}
        {dangling != null && (
          <div className="absolute top-0.5 bottom-0.5 w-1.5 rounded-sm bg-yellow-400"
               style={{ left: dangling * pixelsPerFrame }}
               title={`未ペアのピン(${(dangling / fps).toFixed(2)}s)— もう1つ置くとカットになります`} />
        )}
        {takeCut && (
          <TakeSelector cut={takeCut} sourceClipId={takeCut.clipId} assets={assets} fps={fps} onClose={() => setTakeCut(null)} />
        )}
        {previzCut && (
          <PrevizPopover cutIndex={previzCut.idx} pinClipId={previzCut.pinId}
                         fps={fps} cutFrames={previzCut.frames} cutStartFrame={previzCut.start}
                         onClose={() => setPrevizCut(null)} />
        )}
        {drag && (
          <>
            <div className="absolute top-0 bottom-0 w-px bg-amber-300 pointer-events-none z-20"
                 style={{ left: drag.frame * pixelsPerFrame }} />
            <div className="absolute -top-0.5 z-30 pointer-events-none text-[9px] px-1.5 py-0.5 rounded
                            bg-zinc-900/95 border border-amber-500/60 text-amber-200 whitespace-nowrap"
                 style={{ left: drag.frame * pixelsPerFrame + 6, transform: 'translateY(-100%)' }}>
              C{drag.cutIdx + 1}{drag.side === 'l' ? '開始' : '終端'} {(drag.frame / fps).toFixed(2)}s
              ({drag.frame - drag.origFrame >= 0 ? '+' : ''}{drag.frame - drag.origFrame}f)
              {doomed.size > 0 && <span className="text-red-300 ml-1">{doomed.size}カット消滅</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
