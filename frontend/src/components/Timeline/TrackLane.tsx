import { useState } from 'react'
import { createPortal } from 'react-dom'
import { assetsApi, type Track, type Clip, type Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useProjectStore } from '../../store/projectStore'
import { VideoFramePicker } from './VideoFramePicker'
import { useCollabStore } from '../../store/collabStore'
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
  snapFrame?: (frame: number) => number
}

export function TrackLane({
  track, clips, assets, pixelsPerFrame, totalWidth,
  selectedClipId, onSelectClip, onDropAsset, snapFrame,
}: Props) {
  // 個別セレクタ購読 — currentFrameを購読すると再生中30fpsでレーン全体が再レンダされる
  // ため、フレーム値はハンドラ内で getState() から取る(表示はピッカー内のみ)
  const deleteTrack = useTimelineStore(s => s.deleteTrack)
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const setTrackHidden = useTimelineStore(s => s.setTrackHidden)
  const reorderTrack = useTimelineStore(s => s.reorderTrack)
  const addClip = useTimelineStore(s => s.addClip)
  const clipBuffered = useTimelineStore(s => s.clipBuffered)
  const clipBufferedHQ = useTimelineStore(s => s.clipBufferedHQ)
  const others = useCollabStore(s => s.others)
  const { activeProject } = useProjectStore()
  const fps = activeProject?.fps ?? 30
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerBusy, setPickerBusy] = useState(false)
  // ピッカー表示中のみフレーム値を購読(閉時は定数→再生中の再レンダを回避)
  const currentFrame = useTimelineStore(s => (pickerOpen ? s.currentFrame : -1))

  // ＋画像: 動画アセット→フレーム指定→再生ヘッド位置に画像として挿入
  const handleVFrameInsert = async (videoAssetId: number, timeSec: number, longEdge?: number) => {
    setPickerBusy(true)
    try {
      const frameAsset = await assetsApi.extractFrame(videoAssetId, timeSec, longEdge)
      const atFrame = useTimelineStore.getState().currentFrame
      await addClip(track.id, frameAsset.id, atFrame, Math.round(fps))
      window.dispatchEvent(new Event('kychapogas:assets-changed'))
      setPickerOpen(false)
    } finally { setPickerBusy(false) }
  }

  // Remote collaborators' selection / active-edit per clip id
  const remoteFor = (clipId: number) => {
    let select: string | null = null
    let lock: { name: string; color: string } | null = null
    for (const o of Object.values(others)) {
      if (o.presence.editing_clip_id === clipId) lock = { name: o.user.name, color: o.user.color }
      else if (o.presence.selected_clip_id === clipId) select = o.user.color
    }
    return { select, lock }
  }

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
    <div className={`flex flex-shrink-0 ${track.hidden ? 'opacity-40' : ''}`} style={{ height }}>
      {/* Label — ドラッグでトラック順を入れ替え */}
      <div
        draggable
        onDragStart={e => {
          e.dataTransfer.setData('trackReorderId', String(track.id))
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={e => {
          if (e.dataTransfer.types.includes('trackreorderid')) e.preventDefault()
        }}
        onDrop={e => {
          const dragId = Number(e.dataTransfer.getData('trackReorderId'))
          if (dragId) { e.preventDefault(); reorderTrack(dragId, track.id) }
        }}
        className={`w-28 flex-shrink-0 flex items-center gap-1 px-2 cursor-grab active:cursor-grabbing sticky left-0 z-30
          bg-zinc-900 border-r border-zinc-700 group
          ${isRef ? 'bg-amber-950/30' : ''}`}
        title="ドラッグで順序変更"
      >
        <span className="text-zinc-700 text-[9px] leading-none select-none">⠿</span>
        <span className={`text-[11px] truncate flex-1 ${typeColor}`}>{track.name}</span>
        <button
          onClick={() => setTrackHidden(track.id, !track.hidden)}
          className={`text-xs leading-none ${track.hidden ? 'text-zinc-600' : 'text-zinc-400 hover:text-zinc-200'}`}
          title={track.hidden ? '表示する(現在プレビュー/書き出しから除外中)' : '非表示にする'}
        >{track.hidden ? '🚫' : '👁'}</button>
        {isRef && (
          <button
            onClick={e => { e.stopPropagation(); setPickerOpen(v => !v) }}
            className={`text-sm leading-none ${pickerOpen ? 'text-purple-300' : 'text-zinc-400 hover:text-purple-300'}`}
            title="＋画像: 動画素材からフレームを指定して再生ヘッド位置に挿入"
          >＋</button>
        )}
        <button
          onClick={() => deleteTrack(track.id)}
          className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs"
          title="トラック削除"
        >✕</button>
        {pickerOpen && createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-2 sm:p-6"
               onClick={() => setPickerOpen(false)}>
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[min(760px,96vw)] max-h-[94vh] overflow-y-auto p-4 cursor-default"
                 draggable={false}
                 onClick={e => e.stopPropagation()}
                 onDragStart={e => { e.preventDefault(); e.stopPropagation() }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-zinc-200">🎥 動画からフレーム挿入 → <span className="text-amber-400">frame {currentFrame}</span>({track.name})</span>
                <button onClick={() => setPickerOpen(false)}
                        className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2 py-1">✕</button>
              </div>
              <VideoFramePicker assets={assets} fps={fps} busy={pickerBusy} onInsert={handleVFrameInsert} large />
            </div>
          </div>,
          document.body
        )}
      </div>

      {/* Clip area */}
      <div
        className={`relative border-b border-zinc-800 flex-shrink-0
          ${isRef ? 'bg-amber-950/10' : 'bg-zinc-950'}`}
        style={{ width: totalWidth, height }}
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
        onClick={e => {
          // 空白部クリックでシーク(クリップ上のクリックは各ブロックが処理)
          if (e.target !== e.currentTarget) return
          const rect = e.currentTarget.getBoundingClientRect()
          const f = Math.max(0, Math.round((e.clientX - rect.left) / pixelsPerFrame))
          setCurrentFrame(snapFrame ? snapFrame(f) : f)
        }}
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

              {/* Videoクリップの音声波形(下段・音がある素材のみ描画される) */}
              {!isAudio && clip.asset_id != null && (asset?.duration_sec ?? 0) > 0 && (
                <div
                  className="absolute pointer-events-none z-10 opacity-70"
                  style={{
                    left:   clip.start_frame * pixelsPerFrame + 6,
                    width:  Math.max(clipWidth - 12, 2),
                    top:    4 + clipInner * 0.62,
                    height: clipInner * 0.38,
                  }}
                >
                  <WaveformCanvas
                    assetId={clip.asset_id}
                    width={Math.max(clipWidth - 12, 2)}
                    height={clipInner * 0.38}
                    color="#7dd3fc"
                    useProxy={!!asset?.proxy_path}
                  />
                </div>
              )}

              <ClipBlock
                clip={clip}
                asset={asset}
                trackName={track.name}
                pixelsPerFrame={pixelsPerFrame}
                trackHeight={height}
                selected={selectedClipId === clip.id}
                onSelect={onSelectClip}
                snapFrame={snapFrame}
                remoteSelect={remoteFor(clip.id).select}
                remoteLock={remoteFor(clip.id).lock}
              />

              {/* バッファ済みバー(配信サービス風): 読み込み済み範囲を水色で表示 */}
              {(clipBuffered[clip.id]?.length ?? 0) > 0 && (
                <div
                  className="absolute pointer-events-none z-20"
                  style={{
                    left:   clip.start_frame * pixelsPerFrame + 6,
                    width:  Math.max(clipWidth - 12, 2),
                    top:    height - 7,
                    height: 3,
                  }}
                >
                  <div className="absolute inset-0 rounded-full bg-black/40" />
                  {clipBuffered[clip.id].map(([s, e], i) => (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0 rounded-full bg-sky-400/80"
                      style={{ left: `${s * 100}%`, width: `${Math.max(0.5, (e - s) * 100)}%` }}
                    />
                  ))}
                  {/* 高画質(原本)層の読み込みはアンバーの細線で上乗せ表示 */}
                  {(clipBufferedHQ[clip.id] ?? []).map(([s, e], i) => (
                    <div
                      key={`hq${i}`}
                      className="absolute top-0 rounded-full bg-amber-400"
                      style={{ left: `${s * 100}%`, width: `${Math.max(0.5, (e - s) * 100)}%`, height: '40%' }}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
