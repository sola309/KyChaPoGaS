// 📚 「タイムラインに置く」: 選んだカット(時間順)を再生ヘッドから続けて、選んだ映像トラックへ。
// 再生ヘッドの値を購読するのはこの部品だけ(一覧ごと描き直さないように)。
import { forwardRef, useImperativeHandle, useMemo, useState } from 'react'
import type { LibraryCut } from '../../api/library'
import { useProjectStore } from '../../store/projectStore'
import { useTimelineStore } from '../../store/timelineStore'
import { defaultTrackId, overlapsOnTrack, PLACE_CONFIRM_OVER, placeCutsOnTrack, planPlacement, trackSkipReason } from './placeCuts'
import { fmtTc } from './libraryUtils'

export interface PlaceBarHandle {
  place: () => Promise<void>
  /** 確かめ待ち(たくさん置くとき)をやめる。やめたら true */
  cancelPending: () => boolean
}

interface Props {
  projectId: number
  srcFps: number
  cuts: LibraryCut[]
  /** 選んでいるが絞り込みで隠れているカットの数(置かない) */
  hiddenSelected?: number
  /** タイムラインが再生中(この画面の下で動いている)。置く位置は Enter を押した時点の再生ヘッド */
  timelinePlaying?: boolean
  onMessage: (text: string, kind?: 'info' | 'success' | 'error') => void
  /** つなぐ/分けるの反映待ちなど、いまは置けないとき */
  disabled?: boolean
}

const NEW_TRACK = -1
const NEW_TRACK_NAME = '📚 ライブラリ'

export const PlaceBar = forwardRef<PlaceBarHandle, Props>(function PlaceBar(
  { projectId, srcFps, cuts, hiddenSelected = 0, timelinePlaying = false, onMessage, disabled }, ref) {
  const tracks = useTimelineStore(s => s.tracks)
  const clips = useTimelineStore(s => s.clips)
  const playhead = useTimelineStore(s => s.currentFrame)
  const selectedClipId = useTimelineStore(s => s.selectedClipId)
  const storeFps = useTimelineStore(s => s.projectFps)
  const projFps = useProjectStore(s => s.activeProject?.fps) ?? storeFps
  const [choice, setChoice] = useState<number | null>(null)   // null = 既定
  const [busy, setBusy] = useState(false)
  const [pendingKey, setPendingKey] = useState<string | null>(null)   // たくさん置く前の確かめ

  const vids = useMemo(() => tracks.filter(t => t.track_type === 'video').sort((a, b) => a.order - b.order), [tracks])
  const plan = useMemo(() => planPlacement(cuts, srcFps, projFps, playhead), [cuts, srcFps, projFps, playhead])
  const auto = useMemo(() => defaultTrackId(tracks, clips, selectedClipId, plan), [tracks, clips, selectedClipId, plan])
  const trackId = choice != null && (choice === NEW_TRACK || vids.some(t => t.id === choice)) ? choice : (auto ?? NEW_TRACK)
  const total = plan.reduce((s, p) => s + p.duration_frames, 0)
  const clash = trackId !== NEW_TRACK ? overlapsOnTrack(clips, trackId, plan).length : 0
  // 確かめは「同じカットの組・同じ置き先」に対してだけ有効(選び直したらもう一度確かめる)
  const key = `${cuts.length}:${cuts[0]?.id ?? ''}:${cuts[cuts.length - 1]?.id ?? ''}:${trackId}`
  const pending = pendingKey === key

  const place = async () => {
    if (busy) return
    if (disabled) { onMessage('つなぐ・分けるの反映を待っています…', 'info'); return }
    if (cuts.length === 0) { onMessage('置くカットを選んでください(クリック・Shift で範囲・Ctrl で追加)', 'info'); return }
    if (cuts.length > PLACE_CONFIRM_OVER && !pending) { setPendingKey(key); return }
    setPendingKey(null)
    setBusy(true)
    // 置く位置はこの時点の再生ヘッドで決める(タイムラインが動いていても計画は変えない)
    const planNow = plan
    try {
      let tid = trackId
      const st = useTimelineStore.getState()
      if (tid === NEW_TRACK) {
        const minOrder = st.tracks.length ? Math.min(...st.tracks.map(t => t.order)) : 0
        const t = await st.addTrackAt(projectId, 'video', NEW_TRACK_NAME, minOrder - 1)
        tid = t.id
        setChoice(t.id)
      }
      const name = useTimelineStore.getState().tracks.find(t => t.id === tid)?.name ?? ''
      const r = await placeCutsOnTrack({ projectId, trackId: tid, plan: planNow })
      // 続けて置けるよう、再生ヘッドを置いた分の後ろへ進める
      useTimelineStore.getState().setCurrentFrame(r.end)
      const short = r.shortened > 0 ? `。${r.shortened} 本はサーバーの決まりで計画より短くなりました` : ''
      onMessage(`${r.clips.length} カットを「${name}」の ${fmtTc(r.start, projFps)} から置きました(元に戻す 1 回で取り消せます)${short}`,
        r.shortened > 0 ? 'info' : 'success')
    } catch (e) {
      onMessage(e instanceof Error ? e.message : '置けませんでした', 'error')
    } finally { setBusy(false) }
  }
  useImperativeHandle(ref, () => ({
    place,
    cancelPending: () => { if (pendingKey == null) return false; setPendingKey(null); return true },
  }))

  return (
    <div className="flex-shrink-0 border-t border-zinc-800 bg-zinc-900" data-lib-placebar>
      {pending && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-amber-950/60 border-b border-amber-900 text-[11px] text-amber-100" data-lib-place-confirm>
          <span>{cuts.length.toLocaleString()} カット(計 {fmtTc(total, projFps)})をまとめて置きます。よろしいですか?</span>
          <button onClick={() => void place()} className="px-2 py-0.5 rounded bg-purple-700 hover:bg-purple-600 text-white" data-lib-place-confirm-ok>
            置く <span className="text-[10px] text-purple-200">Enter</span>
          </button>
          <button onClick={() => setPendingKey(null)} className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
            やめる <span className="text-[10px] text-zinc-500">Esc</span>
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <span className="text-[11px] text-zinc-300 whitespace-nowrap" data-lib-place-count={cuts.length}
              title={`プロジェクト ${projFps}fps で ${total} コマ`}>
          {cuts.length} カット · 計 {fmtTc(total, projFps)}
        </span>
        {hiddenSelected > 0 && (
          <span className="text-[10px] text-zinc-500 whitespace-nowrap" data-lib-place-hidden={hiddenSelected}
                title="選んでいても、いまの絞り込みで見えていないカットは置かない・評価しない">
            (絞り込みで隠れた {hiddenSelected} カットは除く)
          </span>
        )}
        <select value={trackId} onChange={e => setChoice(Number(e.target.value))} data-lib-place-track
                title="置き先の映像トラック(既定: 選択中のクリップのトラック → Video → 空いている一番上。非表示・Shots・フィルターレイヤーは既定にしない → 新しいトラック)"
                className="bg-zinc-800 text-[11px] text-zinc-200 rounded px-1 py-1 outline-none border border-zinc-700 max-w-[12rem]">
          {vids.map(t => {
            const why = trackSkipReason(t, clips)
            return (
              <option key={t.id} value={t.id}>
                {t.name}{why ? `(${why})` : ''}{t.id === auto && choice == null ? '(自動)' : ''}
              </option>
            )
          })}
          <option value={NEW_TRACK}>＋ 新しいトラック{auto == null && choice == null ? '(自動)' : ''}</option>
        </select>
        <span className="text-[11px] text-zinc-500 whitespace-nowrap" title="再生ヘッドの位置から続けて置く">
          ▸ <span className="font-mono text-zinc-300" data-lib-playhead>{fmtTc(playhead, projFps)}</span> から
        </span>
        {timelinePlaying && (
          <span className="text-[10px] text-amber-300 whitespace-nowrap" data-lib-timeline-playing
                title="この画面の下でタイムラインが再生中です。置く位置は Enter を押した時点の再生ヘッドになります">
            ▶ タイムライン再生中
          </span>
        )}
        {clash > 0 && <span className="text-[10px] text-red-300">重なるクリップ {clash} 本</span>}
        <button onClick={() => void place()} disabled={busy || disabled || cuts.length === 0} data-lib-place
                className="ml-auto text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40 whitespace-nowrap">
          {busy ? '置いています…' : '⤓ タイムラインに置く'} <span className="text-[10px] text-purple-200 max-sm:hidden">Enter</span>
        </button>
      </div>
    </div>
  )
})
