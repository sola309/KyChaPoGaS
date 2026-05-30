import type { Track, Clip, Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { ClipBlock } from './ClipBlock'

const TRACK_HEIGHT = 48

interface Props {
  track: Track
  clips: Clip[]
  assets: Asset[]
  pixelsPerFrame: number
  totalWidth: number
  selectedClipId: number | null
  onSelectClip: (id: number) => void
  onDropAsset: (trackId: number, assetId: number, startFrame: number) => void
}

export function TrackLane({
  track, clips, assets, pixelsPerFrame, totalWidth,
  selectedClipId, onSelectClip, onDropAsset,
}: Props) {
  const { deleteTrack } = useTimelineStore()

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const assetId = Number(e.dataTransfer.getData('assetId'))
    if (!assetId) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const startFrame = Math.max(0, Math.round(x / pixelsPerFrame))
    onDropAsset(track.id, assetId, startFrame)
  }

  const typeColor = track.track_type === 'video' ? 'text-blue-400' : 'text-green-400'

  return (
    <div className="flex flex-shrink-0" style={{ height: TRACK_HEIGHT }}>
      {/* Label */}
      <div className="w-28 flex-shrink-0 flex items-center justify-between px-2 bg-zinc-900 border-r border-zinc-700 group">
        <span className={`text-[11px] truncate ${typeColor}`}>{track.name}</span>
        <button
          onClick={() => deleteTrack(track.id)}
          className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs"
          title="トラック削除"
        >✕</button>
      </div>

      {/* Clip area */}
      <div
        className="relative bg-zinc-950 border-b border-zinc-800 flex-shrink-0"
        style={{ width: totalWidth, height: TRACK_HEIGHT }}
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
        {/* Lane line */}
        <div className="absolute inset-x-0 top-1/2 h-px bg-zinc-800 pointer-events-none" />

        {clips.map(clip => (
          <ClipBlock
            key={clip.id}
            clip={clip}
            asset={assets.find(a => a.id === clip.asset_id)}
            pixelsPerFrame={pixelsPerFrame}
            trackHeight={TRACK_HEIGHT}
            selected={selectedClipId === clip.id}
            onSelect={onSelectClip}
          />
        ))}
      </div>
    </div>
  )
}

export { TRACK_HEIGHT }
