import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useUIStore } from '../../store/uiStore'
import { isFilterClip, filterLabel } from './filterLayers'
import { isCreditClip, creditOf, creditLabel } from '../Preview/creditLook'
import { useCompListStore, compClipAttrs, openCompEditor } from '../CompEditor/compList'

/**
 * 👆 指で触る機械むけ: 選んだクリップの「開く / 消す」の帯(画面の下に出る)。
 *
 * PC ではクリップのダブルクリックで、字幕・撮影・雨・単色/ぼかしの調整を開き、素材クリップは消える。
 * 指ではダブルクリックが出せない(iOS)うえ、2 度押しで消えるのは危ないので、指で触る機械では
 * ダブルクリックを止め(ClipBlock / RefClipBlock)、代わりにここから開く・消す(消すのは確認つき)。
 * PC(マウス)ではこの帯は出ない。
 */
export function TouchClipBar({ assets }: { assets: Asset[] }) {
  const clipId = useTimelineStore(s => s.selectedClipId)
  const clip = useTimelineStore(s => (s.selectedClipId == null ? undefined : s.clips.find(c => c.id === s.selectedClipId)))
  const track = useTimelineStore(s => (clip ? s.tracks.find(t => t.id === clip.track_id) : undefined))
  const compName = useCompListStore(s => {
    const a = clip?.kind === 'comp' ? compClipAttrs(clip) : null
    return a ? (s.byId[a.comp_id]?.name ?? `コンポジション #${a.comp_id}`) : null
  })
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { setConfirming(false) }, [clipId])
  if (!clip) return null

  const asset = clip.asset_id != null ? assets.find(a => a.id === clip.asset_id) : undefined
  const ev = (name: string) => () => window.dispatchEvent(new CustomEvent(name, { detail: { clipId: clip.id } }))
  const isPin = track?.track_type === 'reference' && track.name === 'Image' && clip.asset_id != null
  const isMgShot = clip.kind === 'mg_shot' || (asset?.name ?? '').startsWith('shot:')
  const compAttrs = clip.kind === 'comp' ? compClipAttrs(clip) : null

  // 何のクリップか・「開く」で開くもの(ClipBlock のダブルクリックと同じ行き先)
  let label: string, openLabel: string | null = null, open: (() => void) | null = null
  if (compAttrs) { label = `🎞 ${compName}`; openLabel = '編集画面を開く'; open = () => openCompEditor(compAttrs.comp_id) }
  else if (isCreditClip(clip)) { label = creditLabel(creditOf(clip.attrs_json)); openLabel = '字幕の調整を開く'; open = ev('kychapogas:open-credit') }
  else if (clip.kind === 'satsuei') { label = filterLabel(clip); openLabel = '撮影の調整を開く'; open = ev('kychapogas:open-satsuei') }
  else if (isFilterClip(clip)) { label = filterLabel(clip); openLabel = '調整を開く'; open = ev('kychapogas:open-filter') }
  else if (clip.kind === 'rain') { label = `🌧 雨 ${Math.round((clip.opacity ?? 1) * 100)}%`; openLabel = '雨の調整を開く'; open = ev('kychapogas:open-rain') }
  else if (isMgShot) {
    label = asset?.name ?? 'ショット'; openLabel = 'ショットを開く'
    open = () => {
      try {
        const sid = JSON.parse(clip.attrs_json || '{}').shot_id ?? (asset?.name ?? '').replace(/^shot:/, '')
        if (sid) useUIStore.getState().openShotEditor(sid)
      } catch { /* noop */ }
    }
  }
  else if (isPin) label = `📌 カットのピン(${asset?.name ?? `#${clip.asset_id}`})`
  else label = asset?.name ?? `clip ${clip.id}`

  const locked = !!clip.locked
  const doDelete = () => {
    const st = useTimelineStore.getState()
    void st.deletePin(clip.id)        // ピンは相方ごと(カット単位)。ピン以外はふつうに 1 つ消す
    st.setSelectedClipId(null)
  }
  const btn = 'h-11 px-3 rounded-md text-[14px] whitespace-nowrap flex-shrink-0 flex items-center justify-center touch-manipulation'

  return createPortal(
    <div className="fixed inset-x-0 bottom-0 z-[60] bg-zinc-900/95 border-t border-zinc-600 shadow-[0_-4px_16px_rgba(0,0,0,0.5)] px-2 pt-1.5 flex items-center gap-2 select-none"
         style={{ paddingBottom: 'calc(6px + env(safe-area-inset-bottom))', WebkitTapHighlightColor: 'transparent' }}
         data-touch-clip-bar={clip.id}>
      {confirming ? (
        <>
          <span className="flex-1 min-w-0 text-[13px] text-red-200 leading-snug">
            {isPin ? 'このカット(ピン 2 本)を消しますか？' : 'このクリップを消しますか？'}
            <span className="block text-[12px] text-zinc-400 truncate">{label}</span>
          </span>
          <button type="button" className={`${btn} bg-zinc-700 text-zinc-100`} onClick={() => setConfirming(false)} data-touch-clip-cancel>やめる</button>
          <button type="button" className={`${btn} bg-red-700 text-white font-bold`} onClick={doDelete} data-touch-clip-delete-yes>消す</button>
        </>
      ) : (
        <>
          <span className="flex-1 min-w-0 text-[13px] text-zinc-200 truncate">{locked ? '🔒 ' : ''}{label}</span>
          {open && openLabel && (
            <button type="button" className={`${btn} bg-purple-700 text-white font-bold`} onClick={open} data-touch-clip-open>{openLabel}</button>
          )}
          <button type="button" className={`${btn} bg-zinc-800 text-red-300 border border-red-900 disabled:opacity-40`} disabled={locked}
                  title={locked ? 'ロック中のクリップは消せません' : undefined}
                  onClick={() => setConfirming(true)} data-touch-clip-delete>消す</button>
          <button type="button" className={`${btn} !px-0 w-11 bg-zinc-800 text-zinc-300`} aria-label="選択をやめる"
                  onClick={() => useTimelineStore.getState().setSelectedClipId(null)} data-touch-clip-close>✕</button>
        </>
      )}
    </div>,
    document.body)
}
