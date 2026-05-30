import type { Track, Clip, Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { ClipBlock } from './ClipBlock'
import { WaveformCanvas } from './WaveformCanvas'

export const TRACK_HEIGHT = 48

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
  const isAudio   = track.track_type === 'audio'

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
        {/* Lane centre line */}
        <div className="absolute inset-x-0 top-1/2 h-px bg-zinc-800 pointer-events-none" />

        {clips.map(clip => {
          const asset       = assets.find(a => a.id === clip.asset_id)
          const clipWidth   = Math.max(clip.duration_frames * pixelsPerFrame, 12)
          const clipInner   = TRACK_HEIGHT - 8  // matches ClipBlock top-1 + 1px margin

          return (
            <div key={clip.id}>
              {/* Waveform overlay for audio tracks */}
              {isAudio && clip.asset_id != null && (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left:   clip.start_frame * pixelsPerFrame + 6,  // account for trim handles
                    width:  Math.max(clipWidth - 12, 2),
                    top:    4,
                    height: clipInner,
                  }}
                >
                  <WaveformCanvas
                    assetId={clip.asset_id}
                    width={Math.max(clipWidth - 12, 2)}
                    height={clipInner}
                    color="#4ade80"
                  />
                </div>
              )}

              <ClipBlock
                clip={clip}
                asset={asset}
                pixelsPerFrame={pixelsPerFrame}
                trackHeight={TRACK_HEIGHT}
                selected={selectedClipId === clip.id}
                onSelect={onSelectClip}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
