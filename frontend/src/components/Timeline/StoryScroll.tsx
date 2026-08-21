import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Clip, Track } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { deriveCutsWithScene } from './SceneLane'

/**
 * 📜 ストーリー — 縦スクロールの絵コンテ台本。
 * カットごとに: 絵コンテ画 / 歌詞 / ユーザーの意図メモ / Claudeの演出意図 / コメントスレッド。
 * コメントはカットピンの attrs_json.comments に {who,text,ts} で永続化し、
 * Claude側はAPIから同じ配列に返信を追記する — これで紙コンテの余白の書き込みと同じ対話ができる。
 * レイアウト: PC=サムネ左・本文右 / スマホ=1カラム(サムネ上・本文下)。
 */
interface Comment { who: 'user' | 'claude'; text: string; ts: string }
interface Props {
  tracks: Track[]
  clips: Clip[]
  assets: Asset[]
  fps: number
  onClose: () => void
}

export function StoryScroll({ tracks, clips, assets, fps, onClose }: Props) {
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const updateClip = useTimelineStore(s => s.updateClip)
  const cuts = useMemo(() => deriveCutsWithScene(tracks, clips, assets), [tracks, clips, assets])
  const boardTrack = tracks.find(t => t.name === 'Board')
  const videoTracks = useMemo(
    () => new Set(tracks.filter(t => t.track_type === 'video' && t.name !== 'Board').map(t => t.id)),
    [tracks])
  const assetById = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets])
  const [draft, setDraft] = useState<Record<number, string>>({})   // pinId → 入力中コメント
  const [busy, setBusy] = useState<number | null>(null)

  const attrsOf = (pin: Clip): Record<string, unknown> => {
    try { return pin.attrs_json ? JSON.parse(pin.attrs_json) : {} } catch { return {} }
  }
  const stillFor = (s: number): { asset?: Asset; isTake: boolean } => {
    const take = clips.find(c => videoTracks.has(c.track_id) && c.asset_id != null
      && c.start_frame <= s && s <= c.start_frame + c.duration_frames - 1
      && assetById.get(c.asset_id)?.duration_sec != null)
    if (take?.asset_id != null) return { asset: assetById.get(take.asset_id), isTake: true }
    const b = boardTrack && clips.find(c => c.track_id === boardTrack.id && c.asset_id != null
      && c.start_frame <= s && s <= c.start_frame + c.duration_frames - 1)
    return { asset: b?.asset_id != null ? assetById.get(b.asset_id) : undefined, isTake: false }
  }
  const postComment = async (pin: Clip) => {
    const text = (draft[pin.id] ?? '').trim()
    if (!text) return
    setBusy(pin.id)
    const a = attrsOf(pin)
    const comments = Array.isArray(a.comments) ? a.comments as Comment[] : []
    comments.push({ who: 'user', text, ts: new Date().toISOString().slice(0, 16) })
    a.comments = comments
    await updateClip(pin.id, { attrs_json: JSON.stringify(a) })
    setDraft(d => ({ ...d, [pin.id]: '' }))
    setBusy(null)
  }

  let lastBlock = ''
  return createPortal(
    <div className="fixed inset-0 z-[160] bg-black/85 flex justify-center" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-zinc-900 w-full sm:max-w-3xl h-full flex flex-col sm:border-x sm:border-zinc-700">
        <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 flex-shrink-0">
          <h2 className="text-sm font-bold text-white">📜 ストーリー
            <span className="text-[10px] text-zinc-500 font-normal ml-2">
              Claudeの演出意図つき台本 — 各カットにコメントを書けます
            </span>
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg px-2">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 overscroll-contain">
          {cuts.map((c, i) => {
            const { asset, isTake } = stillFor(c.s)
            const a = attrsOf(c.pin)
            const story = a.story as { block?: string; note?: string } | undefined
            const comments = (Array.isArray(a.comments) ? a.comments : []) as Comment[]
            const lyrics = c.scene?.board?.lyrics ?? ''
            const dur = (c.e - c.s + 1) / fps
            const block = story?.block ?? ''
            const showBlock = block && block !== lastBlock
            if (block) lastBlock = block
            return (
              <div key={c.s} className="border-b border-zinc-800/70">
                {showBlock && (
                  <div className="sticky top-0 z-10 bg-zinc-950/95 px-3 py-1 text-[11px] font-bold
                                  text-violet-300 border-y border-zinc-800">{block}</div>
                )}
                <div className="p-3 flex flex-col sm:flex-row gap-3">
                  <button onClick={() => setCurrentFrame(c.s)}
                          className="relative flex-shrink-0 w-full sm:w-60 aspect-video bg-black rounded
                                     overflow-hidden border border-zinc-800 hover:border-zinc-500"
                          title="クリックでタイムラインをこのカットへ">
                    {asset
                      ? <img src={assetsApi.thumbnailUrl(asset.id)} alt="" loading="lazy"
                             className="w-full h-full object-cover" />
                      : <span className="absolute inset-0 flex items-center justify-center
                                         text-[10px] text-zinc-600">未着手</span>}
                    <span className="absolute top-1 left-1.5 text-[11px] font-bold text-white drop-shadow">C{i + 1}</span>
                    <span className="absolute top-1 right-1.5 text-[9px] text-zinc-300 drop-shadow">{dur.toFixed(1)}s</span>
                    {isTake && <span className="absolute bottom-1 right-1.5 text-[9px] text-emerald-300">▶テイク</span>}
                  </button>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    {lyrics && <p className="text-[11px] text-amber-200">♪ {lyrics}</p>}
                    {c.intent && <p className="text-[11px] text-zinc-300">🎯 {c.intent}</p>}
                    {story?.note && (
                      <p className="text-[11px] text-violet-200/90 bg-violet-950/40 border border-violet-900/50
                                    rounded px-2 py-1.5 leading-relaxed">🎬 {story.note}</p>
                    )}
                    {comments.map((cm, k) => (
                      <p key={k} className={`text-[11px] rounded px-2 py-1.5 leading-relaxed ${
                        cm.who === 'user'
                          ? 'text-sky-100 bg-sky-950/50 border border-sky-900/50'
                          : 'text-violet-200/90 bg-violet-950/40 border border-violet-900/50'}`}>
                        {cm.who === 'user' ? '💬 ' : '🤖 '}{cm.text}
                        <span className="text-zinc-600 ml-1.5">{cm.ts.slice(5, 16).replace('T', ' ')}</span>
                      </p>
                    ))}
                    <div className="flex gap-1.5 pt-0.5">
                      <input value={draft[c.pin.id] ?? ''}
                             onChange={e => setDraft(d => ({ ...d, [c.pin.id]: e.target.value }))}
                             onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void postComment(c.pin) }}
                             placeholder="このカットへコメント…"
                             className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded px-2 py-1
                                        text-[11px] text-zinc-100" />
                      <button onClick={() => void postComment(c.pin)} disabled={busy === c.pin.id}
                              className="text-[11px] px-2.5 rounded bg-sky-800 hover:bg-sky-700
                                         text-sky-100 disabled:opacity-40 flex-shrink-0">送信</button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
          <p className="text-center text-[10px] text-zinc-600 py-6">— 全{cuts.length}カット —</p>
        </div>
      </div>
    </div>,
    document.body)
}
