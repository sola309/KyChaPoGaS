import { useRef, useState } from 'react'
import type { Clip, Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'

const CLIP_COLORS: Record<string, string> = {
  video: 'bg-blue-800 border-blue-600',
  audio: 'bg-green-800 border-green-600',
  image: 'bg-orange-800 border-orange-600',
  generated: 'bg-purple-800 border-purple-600',
}

interface Props {
  clip: Clip
  asset: Asset | undefined
  pixelsPerFrame: number
  trackHeight: number
  onSelect: (id: number) => void
  selected: boolean
}

export function ClipBlock({ clip, asset, pixelsPerFrame, trackHeight, onSelect, selected }: Props) {
  const { updateClip, deleteClip } = useTimelineStore()
  const dragRef = useRef<{ startX: number; startFrame: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const left = clip.start_frame * pixelsPerFrame
  const width = Math.max(clip.duration_frames * pixelsPerFrame, 4)
  const colorClass = CLIP_COLORS[asset?.asset_type ?? 'video']

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect(clip.id)
    dragRef.current = { startX: e.clientX, startFrame: clip.start_frame }
    setDragging(true)

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = Math.max(0, Math.round(dragRef.current.startFrame + dx / pixelsPerFrame))
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, start_frame: newFrame } : c),
      }))
    }

    const onUp = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = Math.max(0, Math.round(dragRef.current.startFrame + dx / pixelsPerFrame))
      updateClip(clip.id, { start_frame: newFrame })
      dragRef.current = null
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`absolute top-1 rounded border text-[10px] text-white overflow-hidden cursor-grab select-none
        ${colorClass} ${selected ? 'ring-1 ring-white' : ''} ${dragging ? 'cursor-grabbing opacity-80' : ''}`}
      style={{ left, width, height: trackHeight - 8 }}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => deleteClip(clip.id)}
      title={`${asset?.name ?? 'clip'} — ダブルクリックで削除`}
    >
      <div className="px-1 py-0.5 truncate leading-tight">
        {asset?.name ?? `clip ${clip.id}`}
      </div>
    </div>
  )
}
