/**
 * 💍 指輪の位置ツール(プレビューの上に重ねる)。ユーザー(10/15):
 *   「指輪があるべき位置が分からなければこちらで指定するシステムを作って。」
 *
 * ON の間だけ、プレビュー全体を受け口で覆う(クリックがほかのプレビュー操作に漏れない)。
 *   クリック = このコマにキーを置く/動かす・ドラッグ = 動かす・ホイール / + − = 大きさ・[ ] = 向き
 *   g / b / h = 石 / 帯 / 隠れ・Delete = このコマのキーを消す・← → = コマ送り・, . = 前/次のキー
 *   Ctrl+Z / Ctrl+Shift+Z = 印の取り消し / やり直し・Esc = 終わる
 * 印は映像クリップの attrs_json.ring_marks(../Timeline/ringMarks.ts)。保存は ./ringTool.ts。
 */
import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Asset, Clip } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useRingTool, ringClipAt, commitMarks, ringUndo, ringRedo, ringHint, ringAckMeta } from './ringTool'
import {
  type RingMark, type RingVis, RING_VIS, RING_VIS_LABEL, RING_VIS_COLOR, RING_R_DEFAULT, RING_R_MIN, RING_R_MAX,
  RING_XY_MIN, RING_XY_MAX, parseRingMarks, parseRingMeta, ringAt, keyAt, upsertMark, removeMark,
  prevKeyF, nextKeyF,
} from '../Timeline/ringMarks'

type View = { x: number; y: number; w: number; h: number }

const VIS_KEY: Record<RingVis, string> = { gem: 'g', band: 'b', hidden: 'h' }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 使えない理由('' = 使える)。比較表示ではレイヤーの位置が画面と一致しない */
function blockedReason(): string {
  const tl = useTimelineStore.getState()
  if (tl.tracks.some(t => t.track_type === 'video' && !t.hidden && (t.layout_json ?? '') !== '')) {
    return '比較表示(レイヤー配置)中は使えません。配置を外してください'
  }
  return ''
}

/** いまの再生位置の対象クリップと印(イベントのたびにストアから読む) */
function ctxNow() {
  const tl = useTimelineStore.getState()
  const rt = useRingTool.getState()
  const clip = ringClipAt(tl.clips, tl.tracks, rt.trackId, tl.currentFrame)
  if (!clip) return null
  const f = tl.currentFrame - clip.start_frame
  const marks = parseRingMarks(clip.attrs_json)
  return { clip, f, marks, st: ringAt(marks, f) }
}

/** 編集できるか。できなければ理由を一言出して null */
function editCtx() {
  const why = blockedReason()
  if (why) { ringHint(why); return null }
  const c = ctxNow()
  if (!c) { ringHint('この再生位置に印を付けるクリップがありません'); return null }
  if (c.clip.locked) { ringHint('🔒 ロック中のクリップです(🔓で外すと付けられます)'); return null }
  return c
}

/** 新しいキーの大きさ・向き・状態のもと: いまの状態 → 次のキー → 既定 */
function seedOf(marks: RingMark[], f: number): { r: number; a: number; vis: RingVis } {
  const st = ringAt(marks, f)
  const nf = nextKeyF(marks, f)
  const src = st ?? (nf != null ? keyAt(marks, nf) : null)
  // 隠れている区間でクリックした = ここに見えている → 直前の見えている状態(なければ石)
  let vis: RingVis = 'gem'
  if (src && src.vis !== 'hidden') vis = src.vis
  else {
    for (let i = marks.length - 1; i >= 0; i--) {
      if (marks[i].f <= f && marks[i].vis !== 'hidden') { vis = marks[i].vis; break }
    }
  }
  return { r: src?.r ?? RING_R_DEFAULT, a: src?.a ?? 0, vis }
}

/** いまのコマのキーを(なければ補間値から作って)書き換える */
function editHere(change: (m: RingMark) => RingMark, tag?: string, needMark = true) {
  const c = editCtx()
  if (!c) return
  const base = keyAt(c.marks, c.f) ?? (c.st ? { f: c.f, x: c.st.x, y: c.st.y, r: c.st.r, a: c.st.a, vis: c.st.vis } : null)
  if (!base) {
    if (needMark) ringHint('まずプレビューをクリックして、このコマに指輪を置いてください')
    return
  }
  commitMarks(c.clip.id, upsertMark(c.marks, change({ ...base, f: c.f })), { tag })
}

function ringSetVis(vis: RingVis) { editHere(m => ({ ...m, vis })) }
function ringScale(k: number) { editHere(m => ({ ...m, r: clamp(m.r * k, RING_R_MIN, RING_R_MAX) }), 'r') }
function ringRotate(d: number) { editHere(m => ({ ...m, a: m.a + d }), 'a') }
function ringRemoveHere() {
  const c = editCtx()
  if (!c) return
  if (!keyAt(c.marks, c.f)) { ringHint('このコマにはキーがありません(◆のコマで消せます)'); return }
  commitMarks(c.clip.id, removeMark(c.marks, c.f))
}
function ringStep(n: number) {
  const tl = useTimelineStore.getState()
  tl.setCurrentFrame(Math.max(0, tl.currentFrame + n))
}
function ringJumpKey(dir: -1 | 1) {
  const c = ctxNow()
  if (!c) return
  const t = dir < 0 ? prevKeyF(c.marks, c.f) : nextKeyF(c.marks, c.f)
  if (t == null) { ringHint(dir < 0 ? 'これより前のキーはありません' : 'これより後のキーはありません'); return }
  useTimelineStore.getState().setCurrentFrame(c.clip.start_frame + t)
}

/** モーダル(画面全体を覆う fixed inset-0 の窓: 🗂 テイク・素材の拡大・設定など)が開いているか。
 *  開いている間は、Esc・← → などのキーをその窓に任せる(指輪のツールが横取りしない) */
function modalOpen(): boolean {
  for (const el of document.querySelectorAll<HTMLElement>('div.fixed.inset-0')) {
    if (el.getClientRects().length > 0) return true
  }
  return false
}

/** キー操作。扱ったら true(= ほかの操作 — タイムラインの Delete でクリップ削除など — へ渡さない) */
function handleRingKey(e: KeyboardEvent): boolean {
  const k = e.key
  if (e.ctrlKey || e.metaKey) {
    // ON の間の Ctrl+Z は印の取り消し(タイムラインの取り消しは 💍 を閉じてから)
    if (k === 'z' || k === 'Z') { if (!(e.shiftKey ? ringRedo() : ringUndo())) ringHint(e.shiftKey ? 'やり直す印の操作はありません' : '取り消す印の操作はありません(タイムラインの取り消しは 💍 を閉じてから)'); return true }
    if (k === 'y' || k === 'Y') { if (!ringRedo()) ringHint('やり直す印の操作はありません'); return true }
    return false
  }
  if (e.altKey) return false
  const lower = k.length === 1 ? k.toLowerCase() : k
  const code = e.code
  if (k === 'ArrowLeft' || k === 'ArrowRight') { ringStep((e.shiftKey ? 10 : 1) * (k === 'ArrowLeft' ? -1 : 1)); return true }
  if (k === 'Escape') { useRingTool.getState().stop(); return true }
  if (k === ',' || k === '<') { ringJumpKey(-1); return true }
  if (k === '.' || k === '>') { ringJumpKey(1); return true }
  if (lower === 'g' || code === 'KeyG') { ringSetVis('gem'); return true }
  if (lower === 'b' || code === 'KeyB') { ringSetVis('band'); return true }
  if (lower === 'h' || code === 'KeyH') { ringSetVis('hidden'); return true }
  if (k === '+' || k === '=' || code === 'NumpadAdd') { ringScale(1.08); return true }
  if (k === '-' || k === '_' || code === 'NumpadSubtract') { ringScale(1 / 1.08); return true }
  if (k === '[') { ringRotate(-5); return true }
  if (k === ']') { ringRotate(5); return true }
  if (k === '{') { ringRotate(-15); return true }
  if (k === '}') { ringRotate(15); return true }
  if (k === 'Delete' || k === 'Backspace') { ringRemoveHere(); return true }
  return false
}

interface Drag { clipId: number; f: number; pointerId: number; dx: number; dy: number; base: RingMark; marks: RingMark[] }

/** プレビューの上の受け口・印・操作パネル。PreviewPlayer の映像の枠(box/view)と同じ位置に描く */
export function RingOverlay({ box, view, assets, projH }: { box: { w: number; h: number }; view: View; assets: Asset[]; projH: number }) {
  const { on, trackId, saving, error, savedAt, hint, nUndo } = useRingTool(useShallow(s => ({
    on: s.on, trackId: s.trackId, saving: s.saving, error: s.error, savedAt: s.savedAt, hint: s.hint, nUndo: s.undo.length,
  })))
  const { clips, tracks, currentFrame } = useTimelineStore(useShallow(s => ({
    clips: s.clips, tracks: s.tracks, currentFrame: s.currentFrame,
  })))
  const layerRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [draft, setDraft] = useState<{ clipId: number; marks: RingMark[] } | null>(null)
  // 操作パネルの置き場所(手が右上にあるカットでは左へ)。この端末だけの好み
  const [side, setSide] = useState<'left' | 'right'>(() => {
    try { return localStorage.getItem('kychapogas:ringHudSide') === 'left' ? 'left' : 'right' } catch { return 'right' }
  })
  const flipSide = () => setSide(v => {
    const n = v === 'left' ? 'right' : 'left'
    try { localStorage.setItem('kychapogas:ringHudSide', n) } catch { /* noop */ }
    return n
  })

  // キー操作(ON の間だけ。窓の捕捉段階で受けて、タイムラインのショートカットより先に処理する)
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.isComposing || modalOpen()) return
      if (handleRingKey(e)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [on])

  // ホイール = 大きさ(React の onWheel は passive で preventDefault できないので素のリスナー)
  useEffect(() => {
    const el = layerRef.current
    if (!on || !el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (!e.deltaY || dragRef.current) return
      ringScale(clamp(Math.exp(-e.deltaY * 0.0008), 0.8, 1.25))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [on])

  if (!on) return null

  const track = tracks.find(t => t.id === trackId)
  const clip: Clip | null = ringClipAt(clips, tracks, trackId, currentFrame)
  const f = clip ? currentFrame - clip.start_frame : 0
  const marks = clip ? (draft && draft.clipId === clip.id ? draft.marks : parseRingMarks(clip.attrs_json)) : []
  const st = clip ? ringAt(marks, f) : null
  const meta = clip ? parseRingMeta(clip.attrs_json) : null
  const asset = clip ? assets.find(a => a.id === clip.asset_id) : undefined
  const blocked = blockedReason()

  // 画面の座標(0..1) ⇔ 枠の中の px
  const toPx = (x: number, y: number) => [(x - view.x) / view.w * box.w, (y - view.y) / view.h * box.h] as const
  const rPx = (r: number) => r / view.h * box.h
  const fromEvent = (e: React.PointerEvent) => {
    const rc = boxRef.current?.getBoundingClientRect()
    if (!rc || rc.width < 2 || rc.height < 2) return null
    return {
      x: clamp(view.x + (e.clientX - rc.left) / rc.width * view.w, RING_XY_MIN, RING_XY_MAX),
      y: clamp(view.y + (e.clientY - rc.top) / rc.height * view.h, RING_XY_MIN, RING_XY_MAX),
    }
  }

  const stopEv = (e: React.SyntheticEvent) => { e.stopPropagation() }

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation(); e.preventDefault()
    if (e.button !== 0) return
    // preventDefault でフォーカスが動かないので、入力欄に残っていると g/b/h・← → が効かない。入力欄だけ外す
    const ae = document.activeElement as HTMLElement | null
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) ae.blur()
    const c = editCtx()
    const p = fromEvent(e)
    if (!c || !p) return
    const cur = c.st
    let dx = 0, dy = 0
    let base: RingMark
    const key = keyAt(c.marks, c.f)
    if (cur) {
      // 印の上(輪の内側+少し)をつかんだら、つかんだ所がずれないように動かす。離れた所なら、そこへ置き直す
      const [cx, cy] = toPx(cur.x, cur.y)
      const rc = boxRef.current!.getBoundingClientRect()
      const px = e.clientX - rc.left, py = e.clientY - rc.top
      if (Math.hypot(px - cx, py - cy) <= Math.max(rPx(cur.r), 8) + 6) { dx = cur.x - p.x; dy = cur.y - p.y }
    }
    if (key) base = { ...key }
    else {
      const sd = seedOf(c.marks, c.f)
      base = { f: c.f, x: p.x, y: p.y, r: sd.r, a: sd.a, vis: sd.vis }
    }
    const m = { ...base, x: p.x + dx, y: p.y + dy }
    dragRef.current = { clipId: c.clip.id, f: c.f, pointerId: e.pointerId, dx, dy, base, marks: c.marks }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
    setDraft({ clipId: c.clip.id, marks: upsertMark(c.marks, m) })
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    e.stopPropagation()
    const p = fromEvent(e)
    if (!p) return
    setDraft({ clipId: d.clipId, marks: upsertMark(d.marks, { ...d.base, f: d.f, x: p.x + d.dx, y: p.y + d.dy }) })
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    e.stopPropagation()
    dragRef.current = null
    const p = fromEvent(e)
    const marksNow = p ? upsertMark(d.marks, { ...d.base, f: d.f, x: p.x + d.dx, y: p.y + d.dy }) : null
    if (marksNow) commitMarks(d.clipId, marksNow)
    setDraft(null)
  }
  const onCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return
    dragRef.current = null
    setDraft(null)
  }

  const editable = !!clip && !clip.locked && !blocked
  const stateLabel = !clip ? '' : !st ? '印なし(最初のキーより前)'
    : st.kind === 'key' ? `◆ キー(${RING_VIS_LABEL[st.vis]})`
    : st.kind === 'interp' ? `補間(${RING_VIS_LABEL[st.vis]})`
    : `最後のキーのまま(${RING_VIS_LABEL[st.vis]})`
  const outside = !!st && (st.x < 0 || st.x > 1 || st.y < 0 || st.y > 1)
  const warnings: string[] = []
  if (blocked) warnings.push(blocked)
  if (clip?.locked) warnings.push('🔒 ロック中のクリップです。印を付けるには🔓で外してください')
  let metaWarn = ''
  if (clip && meta && marks.length) {
    if (meta.asset_id != null && meta.asset_id !== clip.asset_id) metaWarn = `印を付けたあと素材(テイク)が変わりました(#${meta.asset_id} → #${clip.asset_id})。手の位置を確かめてください`
    else if (meta.asset_in_frame !== clip.asset_in_frame) metaWarn = `素材の頭出しが ${clip.asset_in_frame - meta.asset_in_frame} コマ変わりました。印のコマを確かめてください`
  }
  if (clip && (clip.transform_json ?? '') !== '') warnings.push('このクリップには変形(拡大・移動)があります。印は映像そのものの位置で記録されるため、プレビューとずれます')

  const btn = (active: boolean) => `px-1.5 py-0.5 rounded border text-[10px] leading-none ${active
    ? 'bg-rose-800 border-rose-500 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'} disabled:opacity-40`

  return (
    <>
      {/* 受け口: プレビュー全体(枠の外の余白も = 画面の端すれすれ・外にも置ける) */}
      <div ref={layerRef} data-ring-layer=""
        className="absolute inset-0 z-[15]"
        style={{ cursor: editable ? 'crosshair' : 'not-allowed', touchAction: 'none' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
        onClick={stopEv} onDoubleClick={stopEv} onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}>
        <div ref={boxRef} className="absolute pointer-events-none"
          style={{ width: box.w, height: box.h, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
          <svg className="absolute left-0 top-0" width={Math.max(1, box.w)} height={Math.max(1, box.h)} style={{ overflow: 'visible' }}>
            {/* ほかのキー(薄い点): 動きの道筋の手がかり */}
            {marks.filter(m => m.f !== f).map(m => {
              const [x, y] = toPx(m.x, m.y)
              return <circle key={m.f} cx={x} cy={y} r={2.2} fill={RING_VIS_COLOR[m.vis]} opacity={0.35} />
            })}
            {st && (() => {
              const [x, y] = toPx(st.x, st.y)
              const r = Math.max(2, rPx(st.r))
              const col = RING_VIS_COLOR[st.vis]
              const key = st.kind === 'key'
              const rad = st.a * Math.PI / 180
              const L = r + 7
              const ux = Math.cos(rad) * L, uy = Math.sin(rad) * L
              // 短い線 = 参照に描く絵の下の縁(手前にふくらむ側 = a+90°)。書き出しの draw_mark と同じ
              const dx2 = -Math.sin(rad) * r * 0.7, dy2 = Math.cos(rad) * r * 0.7
              const dash = key ? undefined : '4 3'
              const hidden = st.vis === 'hidden'
              return (
                <g opacity={hidden ? 0.75 : 1}>
                  <circle cx={x} cy={y} r={r} fill="none" stroke="#000" strokeOpacity={0.65} strokeWidth={key ? 4 : 3} />
                  <circle cx={x} cy={y} r={r} fill="none" stroke={col} strokeWidth={key ? 2 : 1.5} strokeDasharray={hidden ? '2 3' : dash} />
                  <line x1={x - ux} y1={y - uy} x2={x + ux} y2={y + uy} stroke="#000" strokeOpacity={0.65} strokeWidth={3.5} />
                  <line x1={x - ux} y1={y - uy} x2={x + ux} y2={y + uy} stroke={col} strokeWidth={1.5} strokeDasharray={dash} />
                  <line x1={x} y1={y} x2={x + dx2} y2={y + dy2} stroke="#000" strokeOpacity={0.65} strokeWidth={3.5} />
                  <line x1={x} y1={y} x2={x + dx2} y2={y + dy2} stroke={col} strokeWidth={1.5} />
                  {st.vis === 'gem' && <circle cx={x} cy={y} r={2.6} fill="#e11d48" stroke="#fff" strokeWidth={0.8} />}
                  <text x={x + r + 6} y={y - r - 4} fontSize={11} fontWeight={700} fill={col}
                    stroke="#000" strokeWidth={3} paintOrder="stroke" style={{ userSelect: 'none' }}>
                    {RING_VIS_LABEL[st.vis]}{key ? ' ◆' : ''}{outside ? '(画面の外)' : ''}
                  </text>
                </g>
              )
            })()}
          </svg>
        </div>
      </div>

      {/* 操作パネル(右上)。ここでのクリックは印にならない */}
      <div className={`absolute top-2 ${side === 'left' ? 'left-2' : 'right-2'} z-[16] w-[300px] max-w-[calc(100%-1rem)] rounded-md border border-rose-800/70 bg-zinc-950/90 text-zinc-200 text-[10px] p-2 shadow-xl select-none`}
        onPointerDown={stopEv} onClick={stopEv} onDoubleClick={stopEv} onContextMenu={stopEv}
        onWheel={stopEv}>
        <div className="flex items-center justify-between mb-0.5">
          <span className="font-semibold text-[11px] text-rose-300">💍 指輪の位置</span>
          <span className="flex items-center gap-2">
            <button className="text-zinc-500 hover:text-zinc-200 text-xs leading-none" title="このパネルを反対側へ(手が隠れるとき)"
              onClick={flipSide}>⇆</button>
            <button className="text-zinc-500 hover:text-zinc-200 text-xs leading-none" title="終わる (Esc)"
              onClick={() => useRingTool.getState().stop()}>✕</button>
          </span>
        </div>
        <div className="text-zinc-500 leading-tight mb-1">
          左手の中指の付け根(石は手の甲側)。レイヤー: {track?.name ?? '—'}
        </div>
        {!clip ? (
          <div className="text-amber-300 leading-tight">この再生位置に「{track?.name ?? '?'}」のクリップがありません</div>
        ) : (
          <>
            <div className="leading-tight truncate" title={asset?.name ?? ''}>
              <span className="font-mono">f{currentFrame}</span>
              <span className="text-zinc-500">(クリップ {clip.id} の +{f})</span> {asset?.name ?? ''}
            </div>
            <div className={`leading-tight mb-1 ${st?.kind === 'key' ? 'text-rose-200' : 'text-zinc-400'}`}>{stateLabel}</div>
            <div className="flex items-center gap-1 mb-1">
              {RING_VIS.map(v => (
                <button key={v} disabled={!editable} className={btn(st?.vis === v)}
                  title={`${RING_VIS_LABEL[v]} (${VIS_KEY[v]})${v === 'hidden' ? ' = 指に隠れる・画面の外で見えない' : v === 'gem' ? ' = 石の側が見える' : ' = 帯(刻印)の側が見える'}`}
                  onClick={() => ringSetVis(v)}>
                  <span style={{ color: st?.vis === v ? undefined : RING_VIS_COLOR[v] }}>●</span> {RING_VIS_LABEL[v]} <span className="text-zinc-500">{VIS_KEY[v]}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 mb-1">
              <span className="text-zinc-400 whitespace-nowrap">大きさ</span>
              <button disabled={!editable} className={btn(false)} onClick={() => ringScale(1 / 1.08)} title="小さく (−・ホイール)">−</button>
              <span className="font-mono w-[52px] text-center">{st ? `${(st.r * projH).toFixed(1)}px` : '—'}</span>
              <button disabled={!editable} className={btn(false)} onClick={() => ringScale(1.08)} title="大きく (+・ホイール)">+</button>
              <span className="text-zinc-400 ml-1 whitespace-nowrap">向き</span>
              <button disabled={!editable} className={btn(false)} onClick={() => ringRotate(-5)} title="左へ 5° ([ / Shift で 15°)">⟲</button>
              <span className="font-mono w-[34px] text-center">{st ? `${Math.round(st.a)}°` : '—'}</span>
              <button disabled={!editable} className={btn(false)} onClick={() => ringRotate(5)} title="右へ 5° (] / Shift で 15°)">⟳</button>
            </div>
            <div className="flex items-center gap-1 mb-1">
              <span className="text-zinc-400">キー {marks.length}</span>
              <button className={btn(false)} onClick={() => ringJumpKey(-1)} title="前のキーへ (,)">◀</button>
              <button className={btn(false)} onClick={() => ringJumpKey(1)} title="次のキーへ (.)">▶</button>
              <button disabled={!editable || st?.kind !== 'key'} className={btn(false)} onClick={ringRemoveHere}
                title="このコマのキーを消す (Delete)">このコマのキーを消す</button>
            </div>
          </>
        )}
        {warnings.map(w => <div key={w} className="text-amber-300 leading-tight mb-0.5">⚠ {w}</div>)}
        {metaWarn && clip && (
          <div className="text-amber-300 leading-tight mb-0.5">
            ⚠ {metaWarn}
            {editable && (
              <button className={`${btn(false)} ml-1`} onClick={() => ringAckMeta(clip.id)}
                title="印はそのままで、いまの素材で確かめたと記録する(この注意が消えます)">確かめた</button>
            )}
          </div>
        )}
        {hint && <div className="text-sky-300 leading-tight mb-0.5">{hint}</div>}
        <div className="flex items-center justify-between text-zinc-500 leading-tight">
          <span className={error ? 'text-red-400' : saving ? 'text-amber-300' : ''}>
            {error ? `⚠ 保存できません: ${error}` : saving ? '保存中…' : savedAt ? '保存済み' : '変更なし'}
          </span>
          <span>{nUndo ? `取り消し ${nUndo} 回まで (Ctrl+Z)` : ''}</span>
        </div>
        <details className="mt-1 text-zinc-400 leading-tight" open>
          <summary className="cursor-pointer text-zinc-500">操作</summary>
          <div>クリック = このコマに置く・動かす / ドラッグ = 動かす(画面の外にも置けます)</div>
          <div>ホイール・+ − = 大きさ / [ ] = 向き(Shift で 15°)</div>
          <div className="text-zinc-500">短い線 = 指輪の絵の下の縁(手前にふくらむ側)。180° 回すと絵が上下逆</div>
          <div>g 石 / b 帯 / h 隠れ(次のキーまで見えない)</div>
          <div>Delete = このコマのキーを消す / ← → = コマ送り(Shift で 10)</div>
          <div>, . = 前 / 次のキー / Ctrl+Z = 取り消し / Esc = 終わる</div>
          <div className="text-zinc-500">キーとキーの間は位置・大きさ・向きがなめらかにつながります。</div>
        </details>
      </div>
    </>
  )
}

/** プレビューの操作バーのボタン */
export function RingToggleButton() {
  const on = useRingTool(s => s.on)
  return (
    <button
      onClick={() => useRingTool.getState().toggle()}
      className={`text-[10px] px-2 py-0.5 rounded ${on ? 'bg-rose-800 hover:bg-rose-700 text-rose-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
      title="💍 指輪の位置: プレビューをクリックして、コマごとに指輪があるべき位置を付ける(選択中の映像クリップのレイヤー、なければ Shots)"
    >💍 指輪の位置</button>
  )
}
