/**
 * 💍 タイムラインのクリップの下辺に出す、指輪の位置のキーの目印(ringMarks.ts)。
 *   (上辺の右には選択時に 🔒・🗂・⏱ のボタンが出て、刻みが隠れるため下辺に置く)
 *   細い帯 = キーから次のキーまでの状態(石=赤・帯=銀・隠れ=なし)、縦の刻み = キー。刻みのクリック = そのコマへ。
 * 印のないクリップには何も出さない。
 */
import { memo } from 'react'
import type { Clip } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useRingTool } from '../Preview/ringTool'
import { parseRingMarks, RING_VIS_COLOR, RING_VIS_LABEL } from './ringMarks'

export const RingTicks = memo(function RingTicks({ clip, pixelsPerFrame }: { clip: Clip; pixelsPerFrame: number }) {
  const toolOn = useRingTool(s => s.on)
  const marks = parseRingMarks(clip.attrs_json).filter(m => m.f < clip.duration_frames)
  if (!marks.length) return null
  const ppf = pixelsPerFrame
  return (
    <div className="absolute left-0 right-0 bottom-0 h-[7px] z-[19] pointer-events-none">
      {marks.map((m, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].f : clip.duration_frames
        if (m.vis === 'hidden') return null
        return (
          <div key={`s${m.f}`} className="absolute bottom-0 h-[2px]"
            style={{ left: m.f * ppf, width: Math.max(1, (end - m.f) * ppf), background: RING_VIS_COLOR[m.vis], opacity: 0.75 }} />
        )
      })}
      {marks.map(m => (
        <div key={m.f}
          className="absolute bottom-0 pointer-events-auto cursor-pointer"
          style={{
            left: (m.f + 0.5) * ppf - (toolOn ? 2 : 1), width: toolOn ? 4 : 2, height: toolOn ? 7 : 5,
            background: RING_VIS_COLOR[m.vis], boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
          }}
          title={`💍 指輪のキー +${m.f}f(f${clip.start_frame + m.f})${RING_VIS_LABEL[m.vis]} — クリックでこのコマへ`}
          onPointerDown={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); useTimelineStore.getState().setCurrentFrame(clip.start_frame + m.f) }}
        />
      ))}
    </div>
  )
})
