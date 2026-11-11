/**
 * 🔤 字幕パネルを開いている間、プレビューに字幕の文字の枠を出す。枠をドラッグ = 位置(Shift で縦か横だけ)、
 * 枠の上でホイール = 大きさ(名前と役職を同じ割合で)。枠の外のクリック・ドラッグはふだんのプレビューのまま。
 * 位置は 2560×1440 の画面の px(creditLook.geometry でキャンバスの枠 ⇔ 画面を対応させる。書き出しの 2560 と同じ画面)。
 * 枠は backend の地図の ink_box_design(文字の外接矩形)を、その地図を作ったときからの位置の差だけ動かしたもの。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTimelineStore } from '../../store/timelineStore'
import { creditOf, geometry, creditRange, SAFE_AREA } from './creditLook'
import { lastCreditMapsInfo, subscribeCreditMaps, creditMapsVersion } from './creditFields'
import { creditPanelClipId, subscribeCreditUi } from './creditUi'
import { editCredit, previewCredit, commitCreditDrag, cancelCreditDrag, settleBeforeDrag } from '../Timeline/creditEdit'

type View = { x: number; y: number; w: number; h: number }

function layoutRect(raw: string | undefined, projW: number, projH: number) {
  if (!raw || !raw.trim()) return null
  try {
    const d = JSON.parse(raw) as { x?: number; y?: number; w?: number; h?: number }
    const x = d.x ?? 0, y = d.y ?? 0, w = d.w ?? 1, h = d.h ?? 1
    if (x === 0 && y === 0 && w === 1 && h === 1) return null
    return { x: x * projW, y: y * projH, w: Math.max(1, w * projW), h: Math.max(1, h * projH) }
  } catch { return null }
}

export function CreditOverlay({ box, view, projW, projH, canvasRef }: {
  box: { w: number; h: number }; view: View; projW: number; projH: number
  canvasRef: React.RefObject<HTMLCanvasElement | null>
}) {
  const panelId = useSyncExternalStore(subscribeCreditUi, creditPanelClipId)
  useSyncExternalStore(subscribeCreditMaps, creditMapsVersion)
  const clip = useTimelineStore(s => (panelId == null ? null : s.clips.find(c => c.id === panelId) ?? null))
  const tracks = useTimelineStore(s => s.tracks)
  const inClip = useTimelineStore(s => !!clip && s.currentFrame >= clip.start_frame && s.currentFrame < clip.start_frame + clip.duration_frames)
  const rectRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState(false)
  const ctxRef = useRef<{ toDesign: (dx: number, dy: number) => [number, number] } | null>(null)

  // ホイール = 大きさ(React の onWheel は passive なので素のリスナー)
  useEffect(() => {
    const el = rectRef.current
    if (!el || !clip || clip.locked) return
    const id = clip.id
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (!e.deltaY) return
      const k = Math.max(0.8, Math.min(1.25, Math.exp(-e.deltaY * 0.001)))
      const [nlo, nhi] = creditRange('style.name_size') ?? [8, 400]
      const [rlo, rhi] = creditRange('style.role_size') ?? [8, 300]
      editCredit(id, c => ({ ...c, style: { ...c.style,
        name_size: Math.round(Math.max(nlo, Math.min(nhi, c.style.name_size * k))),
        role_size: Math.round(Math.max(rlo, Math.min(rhi, c.style.role_size * k))) } }), '字幕: 大きさ', 'credit.style.size')
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  if (!clip) return null
  const cv = canvasRef.current
  const info = lastCreditMapsInfo(clip.id)
  if (!cv || !cv.width || !info || box.w < 2) return null
  const credit = creditOf(clip.attrs_json)
  const ib = info.maps.header.ink_box_design
  if (!ib || info.maps.header.empty) return null
  const tr = tracks.find(t => t.id === clip.track_id)
  const lay = layoutRect(tr?.layout_json, projW, projH)
  const ps = cv.width / projW
  const bx = lay ? Math.round(lay.x * ps) : 0, by = lay ? Math.round(lay.y * ps) : 0
  const bw = lay ? Math.max(1, Math.min(cv.width - bx, Math.round(lay.w * ps))) : cv.width
  const bh = lay ? Math.max(1, Math.min(cv.height - by, Math.round(lay.h * ps))) : cv.height
  const G = geometry([bw, bh], [projW, projH])
  const ddx = credit.pos[0] - info.credit.pos[0], ddy = credit.pos[1] - info.credit.pos[1]
  // 2560 画面の座標 → 枠の px → キャンバスの px → 表示の px
  const toScreen = (u: number, v: number): [number, number] => {
    const [x, y] = G.toBox(u, v)
    return [((x + bx) / cv.width - view.x) / view.w * box.w, ((y + by) / cv.height - view.y) / view.h * box.h]
  }
  const pad = 6                                       // 枠は文字より少し大きく(つかみやすく、表示の px)
  const [x0, y0] = toScreen(ib[0] + ddx, ib[1] + ddy)
  const [x1, y1] = toScreen(ib[2] + ddx, ib[3] + ddy)
  const [s0x, s0y] = toScreen(SAFE_AREA[0], SAFE_AREA[1])
  const [s1x, s1y] = toScreen(SAFE_AREA[2], SAFE_AREA[3])
  // 表示の px の差 → 2560 画面の px の差
  ctxRef.current = {
    toDesign: (dx, dy) => [dx * (cv.width * view.w / box.w) / G.K, dy * (cv.height * view.h / box.h) / G.K],
  }
  const locked = !!clip.locked

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (locked || e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const id = clip.id
    settleBeforeDrag(id)                              // パネルのつまみの保存待ちを先に送る(ドラッグ中の位置を混ぜない)
    const sx = e.clientX, sy = e.clientY
    const p0 = [...credit.pos] as [number, number]
    const orig = clip.attrs_json
    let last: [number, number] = [p0[0], p0[1]]
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
    setDrag(true)
    const move = (ev: PointerEvent) => {
      let [dx, dy] = ctxRef.current?.toDesign(ev.clientX - sx, ev.clientY - sy) ?? [0, 0]
      if (ev.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0 }
      const nx = Math.round(p0[0] + dx), ny = Math.round(p0[1] + dy)
      if (nx === last[0] && ny === last[1]) return
      last = [nx, ny]
      previewCredit(id, c => ({ ...c, pos: [nx, ny] }))     // 動かしている間は手元だけ(前の地図をずらして見せる)
    }
    const done = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      setDrag(false)
    }
    const up = () => {
      done()
      const [nx, ny] = last
      if (nx !== p0[0] || ny !== p0[1]) commitCreditDrag(id, orig, c => ({ ...c, pos: [nx, ny] }), '字幕: 位置', 'credit.pos')
    }
    // ブラウザに操作を取られた(指のスクロールなど): 動かした分を戻す(保存しない)
    const cancel = () => {
      done()
      const [nx, ny] = last
      if (nx !== p0[0] || ny !== p0[1]) cancelCreditDrag(id, orig, c => ({ ...c, pos: [nx, ny] }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  return (
    <div className="absolute pointer-events-none z-[14]" data-credit-overlay={clip.id}
         style={{ width: box.w, height: box.h, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
      {drag && (
        <div className="absolute border border-dashed border-amber-300/60"
             style={{ left: s0x, top: s0y, width: s1x - s0x, height: s1y - s0y }} title="タイトルセーフ(画面の 90%)" />
      )}
      <div ref={rectRef}
           className={`absolute pointer-events-auto rounded-sm ${locked ? 'cursor-not-allowed' : drag ? 'cursor-grabbing' : 'cursor-grab'}`}
           style={{
             left: x0 - pad, top: y0 - pad, width: Math.max(4, x1 - x0 + 2 * pad), height: Math.max(4, y1 - y0 + 2 * pad),
             border: `1px ${inClip ? 'solid' : 'dashed'} rgba(103,232,249,${drag ? 0.95 : 0.7})`,
             boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
             touchAction: 'none',
           }}
           title={locked ? '🔒 ロック中' : '字幕: ドラッグで移動(Shift で縦か横だけ)・ホイールで大きさ'}
           onPointerDown={onDown}
           onClick={e => e.stopPropagation()}
           onDoubleClick={e => e.stopPropagation()}>
        <span className="absolute -top-4 left-0 text-[9px] leading-none px-1 py-0.5 rounded bg-black/70 text-cyan-200 whitespace-nowrap">
          🔤 ({Math.round(credit.pos[0])}, {Math.round(credit.pos[1])}) {credit.style.name_size}px{inClip ? '' : '・再生位置が字幕の外'}
        </span>
      </div>
    </div>
  )
}
