// Per-LAYER transform inspector — the dialogic editing surface for a selected
// clip. Each property (scale / X / Y / rotation) has a slider + a ◆ keyframe
// toggle at the playhead. Editing a slider while the property is animated
// auto-keyframes at the playhead (AE-style); otherwise it sets the static base.
// Opacity + blend are the static compositing columns. All edits flow through
// updateClip → the WYSIWYG compositor and the final render read the same model.

import { useState } from 'react'
import {
  type TProp, propValue, keyframeTimes, setBaseProp, setKeyframe, removeKeyframe,
  allKeyframeTimes, easeAt, setEaseAt,
} from '../Preview/transformEval'
import { EASE_OPTIONS } from '../Preview/easing'
import type { Clip } from '../../api/client'

interface Props {
  clip: Clip
  isOverlay: boolean              // overlay track (above the base video track)
  localT: number                  // clip-local progress at the playhead, 0..1
  beatTs: number[]                // beat positions in clip-local t (0..1) for snapping
  onChange: (patch: Partial<Clip>) => void
  onClose: () => void
}

interface Row {
  key: TProp; label: string
  min: number; max: number; step: number
  fmt: (v: number) => string
  toUI: (v: number) => number; fromUI: (v: number) => number
}

const ROWS: Row[] = [
  { key: 'scale', label: '拡大',  min: 10, max: 400, step: 1,
    fmt: v => `${Math.round(v * 100)}%`, toUI: v => v * 100, fromUI: v => v / 100 },
  { key: 'x', label: '位置X', min: -50, max: 50, step: 0.5,
    fmt: v => `${(v * 100).toFixed(1)}%`, toUI: v => v * 100, fromUI: v => v / 100 },
  { key: 'y', label: '位置Y', min: -50, max: 50, step: 0.5,
    fmt: v => `${(v * 100).toFixed(1)}%`, toUI: v => v * 100, fromUI: v => v / 100 },
  { key: 'rotation', label: '回転', min: -180, max: 180, step: 1,
    fmt: v => `${Math.round(v)}°`, toUI: v => v, fromUI: v => v },
]

const ANCHORS: [number, number][] = [
  [0, 0], [0.5, 0], [1, 0],
  [0, 0.5], [0.5, 0.5], [1, 0.5],
  [0, 1], [0.5, 1], [1, 1],
]

export function ClipInspector({ clip, isOverlay, localT, beatTs, onChange, onClose }: Props) {
  const raw = clip.transform_json ?? ''
  const [snap, setSnap] = useState(true)                     // snap keyframes to beats
  const rawT = Math.max(0, Math.min(1, localT))
  // keyframe placement time — snapped to the nearest beat when 拍スナップ is on
  const snapTime = (tt: number) => {
    if (!snap || !beatTs.length) return tt
    let best = tt, bd = 1
    for (const bt of beatTs) { const d = Math.abs(bt - tt); if (d < bd) { bd = d; best = bt } }
    return best
  }
  const t = snapTime(rawT)                                    // where keyframes land
  const kfHere = allKeyframeTimes(raw).some(kt => Math.abs(kt - t) < 0.012)

  const set = (tj: string) => onChange({ transform_json: tj })

  const onSlide = (row: Row, uiVal: number) => {
    const v = row.fromUI(uiVal)
    const animated = keyframeTimes(raw, row.key).length > 0
    set(animated ? setKeyframe(raw, row.key, t, v) : setBaseProp(raw, row.key, v))
  }

  const toggleKey = (key: TProp) => {
    const times = keyframeTimes(raw, key)
    const at = times.some(kt => Math.abs(kt - t) < 0.012)
    set(at ? removeKeyframe(raw, key, t) : setKeyframe(raw, key, t, propValue(raw, key, rawT)))
  }

  // current anchor (default centre)
  let anchor: [number, number] = [0.5, 0.5]
  try { const d = JSON.parse(raw); if (Array.isArray(d?.anchor)) anchor = d.anchor } catch { /* preset/empty */ }
  const setAnchor = (a: [number, number]) => {
    let d: any = {}
    try { d = raw ? JSON.parse(raw) : {} } catch { d = {} }
    d.anchor = a
    set(JSON.stringify(d))
  }

  const reset = () => set('')

  return (
    <div className="absolute bottom-full right-0 mb-1 w-[300px] rounded-lg border border-zinc-700 bg-zinc-900/98 shadow-2xl backdrop-blur p-3 z-30 text-zinc-200">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-zinc-300">レイヤー変形{isOverlay ? '（重ねレイヤー）' : ''}</span>
        <div className="flex items-center gap-2">
          <button onClick={reset} className="text-[10px] text-zinc-500 hover:text-zinc-300" title="変形をリセット">リセット</button>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-xs leading-none">✕</button>
        </div>
      </div>

      {ROWS.map(row => {
        const cur = propValue(raw, row.key, rawT)
        const times = keyframeTimes(raw, row.key)
        const animated = times.length > 0
        const keyHere = times.some(kt => Math.abs(kt - t) < 0.012)
        return (
          <div key={row.key} className="flex items-center gap-2 mb-1.5">
            <button
              onClick={() => toggleKey(row.key)}
              className={`text-[11px] w-4 h-4 flex items-center justify-center rounded-sm leading-none ${
                keyHere ? 'text-amber-300' : animated ? 'text-amber-600' : 'text-zinc-600 hover:text-zinc-400'
              }`}
              title={keyHere ? 'このフレームのキーフレームを削除' : '再生ヘッドにキーフレームを追加'}
            >◆</button>
            <span className="text-[10px] text-zinc-400 w-8 flex-shrink-0">{row.label}</span>
            <input
              type="range" min={row.min} max={row.max} step={row.step}
              value={row.toUI(cur)}
              onChange={e => onSlide(row, Number(e.target.value))}
              className="flex-1 h-1 accent-purple-500"
            />
            <span className={`text-[10px] w-12 text-right tabular-nums ${animated ? 'text-amber-300' : 'text-zinc-400'}`}>
              {row.fmt(cur)}
            </span>
          </div>
        )
      })}

      {/* Easing (音ハメ) — shapes the segment arriving at the keyframe here, and
          the ease applied to new keyframes. Beat-snap makes them land on-beat. */}
      <div className="flex items-center gap-2 mt-2 mb-1.5">
        <span className="text-[10px] text-zinc-400 w-12 flex-shrink-0">加減速</span>
        <select
          value={easeAt(raw, t)}
          disabled={!kfHere}
          onChange={e => set(setEaseAt(raw, t, e.target.value))}
          className="flex-1 text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700 disabled:opacity-40"
          title={kfHere ? 'このキーフレームへの動きのイージング' : 'キーフレーム上でイージングを設定できます'}
        >
          {EASE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <label className="flex items-center gap-1.5 mb-1 cursor-pointer select-none"
             title="キーフレームを曲のビートに吸着（音ハメ）">
        <input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)}
               className="accent-purple-500 w-3 h-3" disabled={!beatTs.length} />
        <span className={`text-[10px] ${beatTs.length ? 'text-zinc-300' : 'text-zinc-600'}`}>
          拍にスナップ{beatTs.length ? '' : '（音源なし）'}
        </span>
      </label>

      {/* Anchor (pivot for scale/rotation) */}
      <div className="flex items-center gap-2 mt-2 mb-1">
        <span className="text-[10px] text-zinc-500 w-12 flex-shrink-0">アンカー</span>
        <div className="grid grid-cols-3 gap-0.5">
          {ANCHORS.map(a => {
            const on = Math.abs(a[0] - anchor[0]) < 0.01 && Math.abs(a[1] - anchor[1]) < 0.01
            return (
              <button key={`${a[0]}-${a[1]}`} onClick={() => setAnchor(a)}
                className={`w-3.5 h-3.5 rounded-sm border ${on ? 'bg-purple-500 border-purple-300' : 'border-zinc-600 hover:border-zinc-400'}`}
                title={`アンカー ${a[0]},${a[1]}`} />
            )
          })}
        </div>
      </div>

      {/* Opacity + blend (static compositing columns) */}
      <div className="flex items-center gap-2 mt-2 mb-1.5">
        <span className="text-[10px] text-zinc-400 w-12 flex-shrink-0">不透明度</span>
        <input
          type="range" min={0} max={100} step={1}
          value={Math.round((clip.opacity ?? 1) * 100)}
          onChange={e => onChange({ opacity: Number(e.target.value) / 100 })}
          className="flex-1 h-1 accent-purple-500"
        />
        <span className="text-[10px] w-12 text-right tabular-nums text-zinc-400">{Math.round((clip.opacity ?? 1) * 100)}%</span>
      </div>
      {isOverlay && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-400 w-12 flex-shrink-0">合成</span>
          <select
            value={clip.blend ?? 'normal'}
            onChange={e => onChange({ blend: e.target.value as Clip['blend'] })}
            className="flex-1 text-[11px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700"
          >
            <option value="normal">通常</option>
            <option value="screen">スクリーン</option>
            <option value="add">加算</option>
            <option value="multiply">乗算</option>
          </select>
        </div>
      )}

      <p className="text-[9px] text-zinc-600 mt-2 leading-tight">
        ◆ = 再生ヘッドにキーフレーム（拍スナップ時は最寄りのビートに吸着）。加減速で
        音ハメ感を調整。拡大/位置/回転・イージングは書き出しにも反映されます。
      </p>
    </div>
  )
}
