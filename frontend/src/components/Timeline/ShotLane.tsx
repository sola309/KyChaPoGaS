import { useMemo, useRef, useState } from 'react'
import type { Asset, Clip, Track } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useAnalysisStore } from '../../store/analysisStore'
import { deriveCutsWithScene } from './SceneLane'
import { unitOfPin, type UnitInfo, type UnitShot } from './UnitLane'

/**
 * 🎬 ショットレーン — カット割りとは別の層。
 *
 * 1つの生成単位の中で `[Shot N] At MM:SS.mmm` がどこに置かれているかを描き、**編集できる**。
 * カット割り(C番号)は物語上の切れ目、ショットはその内側の切り替えで、大半は
 * 音源解析の実測打点の上に置かれる。どちらに由来するかを境界の色で示す。
 *
 * 実測知見: ショット境界は0.4〜1.1フレームで着弾する(=最も確実に効く経路)。
 * 一方ショット内部に書いた打点は乱数と区別できない。**ここに何を置くかが音合わせの実体**。
 *
 * 編集:
 *   ドラッグ      = 境界を移動(打点へ吸着。Altで自由移動)
 *   ダブルクリック = その位置にショットを追加
 *   ✕            = 削除(単位の先頭ショットは消せない)
 * 解析から起こした初期値がユーザーの意図と合わないことがあるため、手で直せるようにする。
 * 手編集した単位は unit.shots_edited=true が立ち、seed_units.py が上書きしない。
 *
 * データは UnitLane と同じピンの attrs_json.unit.shots(単位の全ピンへ複製)。
 */

const SRC_COLOR: Record<string, string> = {
  snare: '#d9a441', kick: '#c2564a', cymbal: '#4aa8c2', tom: '#8a7ac2', hihat: '#7ac28a',
}
const SRC_JA: Record<string, string> = {
  snare: 'スネア', kick: 'キック', cymbal: 'シンバル', tom: 'タム', hihat: 'ハイハット',
  '—': '打点なし', manual: '手動',
}
/** 実測で「1.2秒に4イベント詰めると実行されない」— 短いショットに印を出す */
const SHORT_SEC = 1.3
/** 吸着範囲(フレーム)。境界は0.4〜1.1fで着弾するので、これ以内なら打点に乗せる */
const SNAP_FRAMES = 3

interface Props {
  tracks: Track[]
  clips: Clip[]
  assets: Asset[]
  pixelsPerFrame: number
  totalWidth: number
  songAssetId?: number | null
}

interface Band { u: UnitInfo; pins: Clip[]; s: number; e: number }

export function ShotLane({ tracks, clips, assets, pixelsPerFrame, totalWidth, songAssetId }: Props) {
  const currentFrame = useTimelineStore(s => s.currentFrame)
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const updateClip = useTimelineStore(s => s.updateClip)
  const audioDrums = useAnalysisStore(s => s.audioDrums)
  const [drag, setDrag] = useState<{ unit: string; i: number; frame: number } | null>(null)
  const [msg, setMsg] = useState('')
  const movedRef = useRef(false)

  const cuts = useMemo(() => deriveCutsWithScene(tracks, clips, assets), [tracks, clips, assets])

  /** 単位ごとに、所属する全ピン(書き戻し先)と範囲を集める */
  const bands = useMemo(() => {
    const m = new Map<string, Band>()
    for (const c of cuts) {
      const u = unitOfPin(c.pin)
      if (!u) continue
      const hit = m.get(u.id)
      // 開始ピンだけでなく終了ピンにも同じ unit が入っている(seed_units.py)
      const own = clips.filter(x => x.track_id === c.pin.track_id
        && x.start_frame >= c.s && x.start_frame <= c.e && x.asset_id != null)
      if (hit) { hit.s = Math.min(hit.s, c.s); hit.e = Math.max(hit.e, c.e); hit.pins.push(...own) }
      else m.set(u.id, { u, pins: [...own], s: c.s, e: c.e })
    }
    return [...m.values()].sort((a, b) => a.s - b.s)
  }, [cuts, clips])

  /** 楽曲の全打点を「タイムライン絶対フレーム → 種別」で引けるようにする */
  const hitAt = useMemo(() => {
    const dr = songAssetId != null ? audioDrums[songAssetId] : undefined
    const out: Array<{ f: number; kind: string }> = []
    for (const [kind, arr] of Object.entries(dr?.classes ?? {}))
      for (const h of arr ?? []) out.push({ f: h.t * 24, kind })
    return out.sort((a, b) => a.f - b.f)
  }, [audioDrums, songAssetId])

  const snap = (frame: number, free: boolean) => {
    if (free || !hitAt.length) return { frame: Math.round(frame), kind: 'manual' as string }
    let best = hitAt[0]
    for (const h of hitAt) if (Math.abs(h.f - frame) < Math.abs(best.f - frame)) best = h
    return Math.abs(best.f - frame) <= SNAP_FRAMES
      ? { frame: Math.round(best.f), kind: best.kind }
      : { frame: Math.round(frame), kind: 'manual' }
  }

  /** 単位の全ピンへ shots を書き戻す。手編集の印を立て、seed_units.py の上書きを止める */
  const writeShots = async (b: Band, shots: UnitShot[]) => {
    const gen = b.u.frames / 24
    const sorted = [...shots].sort((x, y) => x.frame - y.frame)
    sorted.forEach((sh, i) => {
      sh.i = i + 1
      sh.sec = Math.round((sh.frame - b.s) / 24 * 1000) / 1000
      const nxt = i + 1 < sorted.length ? (sorted[i + 1].frame - b.s) / 24 : gen
      sh.dur = Math.round((nxt - sh.sec) * 1000) / 1000
    })
    const info: UnitInfo = { ...b.u, shots: sorted, shots_edited: true }
    for (const pin of b.pins) {
      let attrs: Record<string, unknown> = {}
      try { attrs = pin.attrs_json ? JSON.parse(pin.attrs_json) : {} } catch { /* 壊れは捨てる */ }
      attrs.unit = info
      await updateClip(pin.id, { attrs_json: JSON.stringify(attrs) })
    }
    setMsg(`${b.u.id}: ${sorted.length}ショット — プロンプトは未反映(書き直しが要ります)`)
    window.setTimeout(() => setMsg(''), 4000)
  }

  const onDown = (ev: React.PointerEvent, b: Band, sh: UnitShot) => {
    if (sh.i === 1) return          // 単位の先頭は動かせない(単位の開始そのもの)
    ev.stopPropagation()
    movedRef.current = false
    const startX = ev.clientX
    const base = sh.frame
    const move = (mv: PointerEvent) => {
      if (Math.abs(mv.clientX - startX) > 2) movedRef.current = true
      const raw = base + (mv.clientX - startX) / pixelsPerFrame
      const lo = b.s + 1, hi = b.s + b.u.frames - 1
      const { frame } = snap(Math.min(hi, Math.max(lo, raw)), mv.altKey)
      setDrag({ unit: b.u.id, i: sh.i, frame })
    }
    const up = async (mv: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (!movedRef.current) { setCurrentFrame(sh.frame); return }
      const raw = base + (mv.clientX - startX) / pixelsPerFrame
      const lo = b.s + 1, hi = b.s + b.u.frames - 1
      const r = snap(Math.min(hi, Math.max(lo, raw)), mv.altKey)
      const rest = (b.u.shots ?? []).filter(x => x.i !== sh.i)
      await writeShots(b, [...rest, { ...sh, frame: r.frame, src: r.kind, dev: null }])
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const addAt = async (b: Band, clientX: number, host: HTMLElement, alt: boolean) => {
    const rect = host.getBoundingClientRect()
    const raw = (clientX - rect.left) / pixelsPerFrame
    const r = snap(Math.min(b.s + b.u.frames - 1, Math.max(b.s + 1, raw)), alt)
    if ((b.u.shots ?? []).some(x => Math.abs(x.frame - r.frame) < 2)) return
    await writeShots(b, [...(b.u.shots ?? []),
      { i: 0, frame: r.frame, sec: 0, src: r.kind, dev: null }])
  }

  const del = async (b: Band, sh: UnitShot) => {
    if (sh.i === 1) return
    await writeShots(b, (b.u.shots ?? []).filter(x => x.i !== sh.i))
  }

  const totals = useMemo(() => {
    let beat = 0, all = 0, edited = 0
    for (const b of bands) {
      for (const sh of b.u.shots ?? []) { all++; if (SRC_COLOR[sh.src]) beat++ }
      if (b.u.shots_edited) edited++
    }
    return { beat, all, edited }
  }, [bands])

  return (
    <div className="flex flex-shrink-0 border-b border-zinc-800 bg-zinc-950/60 select-none"
         style={{ height: 22 }}>
      <div className="w-28 flex-shrink-0 border-r border-zinc-800 bg-zinc-950 px-2
                      flex flex-col justify-center sticky left-0 z-30"
           title={'ドラッグ=移動(打点へ吸着 / Altで自由)\nダブルクリック=追加\n✕=削除'}>
        <span className="text-[10px] text-zinc-400 leading-tight">🎬 ショット</span>
        <span className="text-[9px] text-zinc-600 leading-tight">
          {totals.all ? `${totals.beat}/${totals.all} 打点上` : '未設定'}
          {totals.edited > 0 && <span className="text-amber-500"> ✎{totals.edited}</span>}
        </span>
      </div>

      <div className="relative flex-1" style={{ width: totalWidth, minWidth: totalWidth }}>
        {bands.map(b => {
          const shots = [...(b.u.shots ?? [])].sort((x, y) => x.frame - y.frame)
          const end = b.s + b.u.frames
          return (
            <div key={b.u.id}
                 className="absolute top-0 bottom-0"
                 style={{ left: b.s * pixelsPerFrame, width: (end - b.s) * pixelsPerFrame }}
                 onDoubleClick={ev => addAt(b, ev.clientX, ev.currentTarget as HTMLElement, ev.altKey)}
                 title={`${b.u.id} — ダブルクリックでショット追加`}>
              {shots.map((sh, i) => {
                const live = drag && drag.unit === b.u.id && drag.i === sh.i ? drag.frame : sh.frame
                const nextF = i + 1 < shots.length ? shots[i + 1].frame : end
                const dur = (nextF - live) / 24
                const short = dur < SHORT_SEC
                const color = SRC_COLOR[sh.src] ?? (sh.src === 'manual' ? '#9aa0a6' : '#5a5a5a')
                const here = currentFrame >= live && currentFrame < nextF
                return (
                  <div key={`${b.u.id}-${sh.i}`}
                       className="absolute top-[3px] h-[15px] group"
                       style={{ left: (live - b.s) * pixelsPerFrame,
                                width: Math.max(2, (nextF - live) * pixelsPerFrame) }}
                       title={`${b.u.id} Shot ${i + 1} / ${dur.toFixed(3)}秒\n`
                            + `境界 ${((live - b.s) / 24).toFixed(3)}s = ${
                                sh.src.startsWith('cut') ? `カット境界(${sh.src.replace('cut', 'C')})`
                                : (SRC_JA[sh.src] ?? sh.src)}`
                            + (short ? '\n⚠ 短い — 1ショットに複数イベントを置くと実行されない可能性' : '')}>
                    <div className="absolute inset-0 rounded-[1px]"
                         style={{
                           background: here ? '#ffffff22' : '#ffffff0e',
                           backgroundImage: short
                             ? 'repeating-linear-gradient(45deg,#e0555533 0 3px,transparent 3px 6px)'
                             : undefined,
                         }} />
                    {/* 境界: ドラッグ用のつまみ。色が由来 */}
                    <div
                      onPointerDown={ev => onDown(ev, b, sh)}
                      className={`absolute left-0 top-0 bottom-0 ${sh.i === 1 ? '' : 'cursor-ew-resize'}`}
                      style={{ width: sh.i === 1 ? 2 : 4, marginLeft: sh.i === 1 ? 0 : -1,
                               background: color }} />
                    {sh.i !== 1 && (
                      <button
                        onClick={ev => { ev.stopPropagation(); void del(b, sh) }}
                        className="absolute -top-[1px] left-[5px] hidden group-hover:block
                                   text-[9px] leading-none text-red-300 hover:text-red-100
                                   bg-neutral-900/90 rounded px-[2px]">✕</button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {msg && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[80] px-3 py-1.5 rounded
                        bg-amber-900/90 border border-amber-600 text-amber-100 text-xs">
          {msg}
        </div>
      )}
    </div>
  )
}
