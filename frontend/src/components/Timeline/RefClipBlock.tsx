/**
 * RefClipBlock — a "pin" on the Reference Track.
 * Displayed as a fixed-width thumbnail marker; drag to reposition.
 */
import { useRef } from 'react'
import type { Clip, Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { assetsApi } from '../../api/client'

const PIN_WIDTH = 44  // fixed display width in px (ignores duration_frames)

interface Props {
  clip: Clip
  asset: Asset | undefined
  pixelsPerFrame: number
  trackHeight: number
  selected: boolean
  onSelect: (id: number) => void
}

export function RefClipBlock({ clip, asset, pixelsPerFrame, trackHeight, selected, onSelect }: Props) {
  const { moveClip, deleteClip } = useTimelineStore()
  const dragRef = useRef<{ startX: number; origFrame: number } | null>(null)

  const left = clip.start_frame * pixelsPerFrame

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect(clip.id)
    const origFrame = clip.start_frame
    dragRef.current = { startX: e.clientX, origFrame }

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = Math.max(0, Math.round(dragRef.current.origFrame + dx / pixelsPerFrame))
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, start_frame: newFrame } : c),
      }))
    }

    const onUp = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = Math.max(0, Math.round(dragRef.current.origFrame + dx / pixelsPerFrame))
      if (newFrame !== dragRef.current.origFrame) {
        moveClip(clip.id, dragRef.current.origFrame, newFrame)
      }
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const isImage = asset?.asset_type === 'image' || asset?.asset_type === 'generated'

  return (
    <div
      className={`absolute top-0.5 rounded border cursor-grab select-none overflow-hidden
        bg-amber-900/80 border-amber-500
        ${selected ? 'ring-1 ring-white' : ''}`}
      style={{ left, width: PIN_WIDTH, height: trackHeight - 4 }}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => deleteClip(clip.id)}
      title={`${asset?.name ?? 'ref'} @ ${(clip.start_frame / 30).toFixed(2)}s — ダブルクリックで削除`}
    >
      {isImage && asset ? (
        <img
          src={assetsApi.thumbnailUrl(asset.id)}
          alt=""
          className="w-full h-full object-cover opacity-90"
          draggable={false}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-amber-300 text-[10px]">
          {asset?.name?.slice(0, 3) ?? '?'}
        </div>
      )}

      {/* Time label at bottom */}
      <div className="absolute bottom-0 left-0 right-0 text-center text-[8px] text-amber-200/80 bg-black/50 leading-tight">
        {(clip.start_frame / 30).toFixed(1)}s
      </div>
    </div>
  )
}
