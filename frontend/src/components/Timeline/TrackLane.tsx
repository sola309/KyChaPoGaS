import type { Track, Clip, Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { ClipBlock } from './ClipBlock'
import { RefClipBlock } from './RefClipBlock'
import { WaveformCanvas } from './WaveformCanvas'

export const TRACK_HEIGHT    = 48
export const REF_TRACK_HEIGHT = 36  // thinner for reference tracks

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

  const isRef   = track.track_type === 'reference'
  const isAudio = track.track_type === 'audio'
  const height  = isRef ? REF_TRACK_HEIGHT : TRACK_HEIGHT

  const typeColor = isRef
    ? 'text-amber-400'
    : track.track_type === 'video' ? 'text-blue-400' : 'text-green-400'

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const assetId = Number(e.dataTransfer.getData('assetId'))
    if (!assetId) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const startFrame = Math.max(0, Math.round(x / pixelsPerFrame))
    onDropAsset(track.id, assetId, startFrame)
  }

  return (
    <div className="flex flex-shrink-0" style={{ height }}>
      {/* Label */}
      <div
        className={`w-28 flex-shrink-0 flex items-center justify-between px-2
          bg-zinc-900 border-r border-zinc-700 group
          ${isRef ? 'bg-amber-950/30' : ''}`}
      >
        <span className={`text-[11px] truncate ${typeColor}`}>{track.name}</span>
        <button
          onClick={() => deleteTrack(track.id)}
          className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs"
          title="トラック削除"
        >✕</button>
      </div>

      {/* Clip area */}
      <div
        className={`relative border-b border-zinc-800 flex-shrink-0
          ${isRef ? 'bg-amber-950/10' : 'bg-zinc-950'}`}
        style={{ width: totalWidth, height }}
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
        {/* Centre line */}
        {!isRef && (
          <div className="absolute inset-x-0 top-1/2 h-px bg-zinc-800 pointer-events-none" />
        )}

        {clips.map(clip => {
          const asset = assets.find(a => a.id === clip.asset_id)

          if (isRef) {
            return (
              <RefClipBlock
                key={clip.id}
                clip={clip}
                asset={asset}
                pixelsPerFrame={pixelsPerFrame}
                trackHeight={height}
                selected={selectedClipId === clip.id}
                onSelect={onSelectClip}
              />
            )
          }

          const clipWidth = Math.max(clip.duration_frames * pixelsPerFrame, 12)
          const clipInner = height - 8

          return (
            <div key={clip.id}>
              {/* Audio waveform overlay */}
              {isAudio && clip.asset_id != null && (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left:   clip.start_frame * pixelsPerFrame + 6,
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
                trackHeight={height}
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
