import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Clip, Track } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { deriveCutsWithScene } from './SceneLane'

/**
 * コンテ表 — 全カットを一覧するグリッド。映像制作の紙コンテに相当する検討資料。
 * 各カード: Boardトラックの絵コンテ静止画(無ければScenes/Shotsのテイク) + C番号 + 尺 + 歌詞 + 意図。
 * クリックで該当カットへシーク。編集はしない(検討・議論用の読み物)。
 */
interface Props {
  tracks: Track[]
  clips: Clip[]
  assets: Asset[]
  fps: number
  onClose: () => void
}

export function BoardSheet({ tracks, clips, assets, fps, onClose }: Props) {
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const cuts = useMemo(() => deriveCutsWithScene(tracks, clips, assets), [tracks, clips, assets])
  const boardTrack = tracks.find(t => t.name === 'Board')
  const videoTracks = useMemo(
    () => new Set(tracks.filter(t => t.track_type === 'video' && t.name !== 'Board').map(t => t.id)),
    [tracks])
  const assetById = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets])

  // カットの代表画: テイク(動画)があればそのサムネ、無ければBoardの絵コンテ静止画
  const stillFor = (s: number): { asset?: Asset; isTake: boolean } => {
    const take = clips.find(c => videoTracks.has(c.track_id) && c.asset_id != null
      && c.start_frame <= s && s <= c.start_frame + c.duration_frames - 1
      && assetById.get(c.asset_id)?.duration_sec != null)
    if (take?.asset_id != null) return { asset: assetById.get(take.asset_id), isTake: true }
    const b = boardTrack && clips.find(c => c.track_id === boardTrack.id && c.asset_id != null
      && c.start_frame <= s && s <= c.start_frame + c.duration_frames - 1)
    return { asset: b?.asset_id != null ? assetById.get(b.asset_id) : undefined, isTake: false }
  }

  return createPortal(
    <div className="fixed inset-0 z-[160] bg-black/80 flex items-center justify-center p-3" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[1280px] max-w-full
                      max-h-[94dvh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800">
          <h2 className="text-sm font-bold text-white">
            🎬 コンテ表
            <span className="text-zinc-500 font-normal ml-2 text-xs">
              {cuts.length}カット — 枠色: <span className="text-emerald-400">緑=テイクあり</span> /
              <span className="text-sky-400"> 青=絵コンテのみ</span> / 灰=未着手。クリックでシーク
            </span>
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg px-2">✕</button>
        </div>
        <div className="overflow-y-auto p-3 grid gap-2
                        grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {cuts.map((c, i) => {
            const { asset, isTake } = stillFor(c.s)
            const b = c.scene?.board
            const lyrics = b?.lyrics ?? ''
            const dur = (c.e - c.s + 1) / fps
            return (
              <button key={c.s}
                      onClick={() => { setCurrentFrame(c.s); onClose() }}
                      className={`text-left rounded-md overflow-hidden border bg-zinc-950 hover:brightness-125
                                  ${isTake ? 'border-emerald-600' : asset ? 'border-sky-800' : 'border-zinc-800'}`}>
                <div className="relative aspect-video bg-black">
                  {asset ? (
                    <img src={assetsApi.thumbnailUrl(asset.id)} alt="" loading="lazy"
                         className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-600">
                      未着手
                    </div>
                  )}
                  <span className="absolute top-0.5 left-1 text-[10px] font-bold text-white drop-shadow">
                    C{i + 1}
                  </span>
                  <span className="absolute top-0.5 right-1 text-[9px] text-zinc-300 drop-shadow">
                    {dur.toFixed(1)}s
                  </span>
                  {isTake && <span className="absolute bottom-0.5 right-1 text-[9px] text-emerald-300">▶テイク</span>}
                </div>
                <div className="px-1.5 py-1 space-y-0.5">
                  {lyrics
                    ? <p className="text-[9px] text-amber-200/90 leading-tight line-clamp-1" title={lyrics}>♪ {lyrics}</p>
                    : <p className="text-[9px] text-zinc-700">♪ —</p>}
                  <p className="text-[9px] text-zinc-400 leading-tight line-clamp-2 min-h-[1.9em]"
                     title={c.intent || ''}>
                    {c.intent || <span className="text-zinc-700">意図メモなし</span>}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body)
}
