/**
 * RefClipBlock — a "pin" on the Reference Track.
 * Displayed as a fixed-width thumbnail marker; drag to reposition.
 */
import { memo, useRef } from 'react'
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

export const RefClipBlock = memo(function RefClipBlock({ clip, asset, pixelsPerFrame, trackHeight, selected, onSelect }: Props) {
  const moveClip = useTimelineStore(s => s.moveClip)
  const deleteClip = useTimelineStore(s => s.deleteClip)
  const toggleRefSel = useTimelineStore(s => s.toggleRefSel)
  const selIdx = useTimelineStore(s => s.refSel.indexOf(clip.id))
  const dragRef = useRef<{ startX: number; origFrame: number } | null>(null)

  const left = clip.start_frame * pixelsPerFrame

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    onSelect(clip.id)
    const origFrame = clip.start_frame
    dragRef.current = { startX: e.clientX, origFrame }

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = Math.max(0, Math.round(dragRef.current.origFrame + dx / pixelsPerFrame))
      useTimelineStore.setState(s => ({
        clips: s.clips.map(c => c.id === clip.id ? { ...c, start_frame: newFrame } : c),
      }))
    }

    const onUp = (ev: PointerEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const newFrame = Math.max(0, Math.round(dragRef.current.origFrame + dx / pixelsPerFrame))
      if (newFrame !== dragRef.current.origFrame) {
        void moveClip(clip.id, dragRef.current.origFrame, newFrame).then(() => {
          // カット割りの空き自動補完(CutGapFillerが処理)へ通知
          window.dispatchEvent(new CustomEvent('kychapogas:pin-moved', {
            detail: { clipId: clip.id, trackId: clip.track_id },
          }))
        })
      } else {
        // 動かさずに離した=クリック/タップ → i2vキーフレーム選択をトグル
        toggleRefSel(clip.id)
      }
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }


  return (
    <div
      className={`absolute top-0.5 rounded border cursor-grab select-none
        bg-amber-900/80 ${selIdx >= 0 ? 'border-purple-400' : 'border-amber-500'}
        ${selected ? 'ring-2 ring-purple-300' : ''}`}
      style={{ left, width: PIN_WIDTH, height: trackHeight - 4, touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => deleteClip(clip.id)}
      title={`${asset?.name ?? 'ref'} @ ${(clip.start_frame / 30).toFixed(2)}s — ダブルクリックで削除`}
    >
      {clip.asset_id != null ? (
        /* アセット一覧が未リフレッシュでもID直指定でサムネを出す(挿入直後の「?」対策) */
        <img
          src={assetsApi.thumbnailUrl(clip.asset_id)}
          alt=""
          className="w-full h-full object-cover opacity-90 rounded"
          draggable={false}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-amber-300 text-[10px]">
          {asset?.name?.slice(0, 3) ?? 'ref'}
        </div>
      )}

      {/* キーフレーム打点=左端の◆(生成はこの位置基準。胴体はサムネ表示のみ) */}
      <div className="absolute -left-[5px] -top-[3px] text-[9px] text-amber-400 leading-none pointer-events-none">◆</div>
      {selIdx >= 0 && (
        <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-purple-600 text-white
                        text-[9px] flex items-center justify-center font-bold pointer-events-none">
          {selIdx + 1}
        </div>
      )}
      {/* Time label at bottom */}
      <div className="absolute bottom-0 left-0 right-0 text-center text-[8px] text-amber-200/80 bg-black/50 leading-tight">
        {(clip.start_frame / 30).toFixed(1)}s
      </div>
    </div>
  )
})
