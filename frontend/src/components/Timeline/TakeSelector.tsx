import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'

/**
 * 🗂 テイクブラウザ — カットごとの生成履歴(テイク)を閲覧・プレビュー・採用する。
 * カット紐付けは生成時のgen_params.place.start_frame(=カット開始フレーム)で判定。
 * place.auto=falseの夜間バリエーション生成分もここに並ぶ。
 * 「採用」でShotsトラックの該当カット位置へ配置(既存クリップがあれば差し替え)。
 */
interface Props {
  cut: { s: number; e: number }
  assets: Asset[]
  fps: number
  onClose: () => void
}

interface Take {
  asset: Asset
  seed?: number
  prompt?: string
  model?: string
  steps?: number
  easycache?: boolean
}

export function TakeSelector({ cut, assets, fps, onClose }: Props) {
  const clips = useTimelineStore(s => s.clips)
  const tracks = useTimelineStore(s => s.tracks)
  const [previewId, setPreviewId] = useState<number | null>(null)
  const [msg, setMsg] = useState('')

  const takes = useMemo<Take[]>(() => {
    const out: Take[] = []
    for (const a of assets) {
      if (a.asset_type !== 'generated' || a.duration_sec == null || !a.gen_params_json) continue
      try {
        const p = JSON.parse(a.gen_params_json)
        const place = p?.place
        if (!place || place.start_frame !== cut.s) continue
        if (!String(p?.model ?? '').match(/minimax-h3|wan2\.2|svd/)) continue
        out.push({ asset: a, seed: p.seed, prompt: p.prompt, model: p.model, steps: p.steps, easycache: p.easycache })
      } catch { /* gen_params壊れは無視 */ }
    }
    return out.sort((a, b) => b.asset.id - a.asset.id)   // 新しい順
  }, [assets, cut.s])

  const shotsTrack = tracks.find(t => t.track_type === 'video' && t.name === 'Shots')
  const currentClip = shotsTrack
    ? clips.find(c => c.track_id === shotsTrack.id && c.start_frame === cut.s)
    : undefined

  const adopt = async (assetId: number) => {
    const st = useTimelineStore.getState()
    let shots = shotsTrack
    if (!shots) return
    const dur = cut.e - cut.s + 1
    if (currentClip) {
      await st.updateClip(currentClip.id, { asset_id: assetId, duration_frames: dur })
    } else {
      await st.addClip(shots.id, assetId, cut.s, dur)
    }
    setMsg(`✅ #${assetId} をC(f${cut.s})に採用しました`)
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-2 sm:p-6"
         onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[min(880px,96vw)] max-h-[94vh] overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-200">
            🗂 テイク履歴 — カット f{cut.s}–{cut.e}({((cut.e + 1 - cut.s) / fps).toFixed(2)}秒)
            <span className="text-zinc-500 ml-2 text-xs">{takes.length}テイク</span>
          </span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
        </div>

        {takes.length === 0 && (
          <p className="text-xs text-zinc-500">このカット位置(place.start_frame={cut.s})で生成されたテイクはまだありません。</p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {takes.map(t => {
            const isCurrent = currentClip?.asset_id === t.asset.id
            const showVideo = previewId === t.asset.id
            return (
              <div key={t.asset.id}
                   className={`rounded-lg border p-2 flex flex-col gap-1.5
                     ${isCurrent ? 'border-emerald-500 bg-emerald-950/20' : 'border-zinc-700 bg-zinc-950'}`}>
                <div className="relative aspect-video rounded overflow-hidden bg-black cursor-pointer"
                     onClick={() => setPreviewId(showVideo ? null : t.asset.id)}>
                  {showVideo ? (
                    <video src={assetsApi.fileUrl(t.asset.id, !!t.asset.proxy_path)} autoPlay loop muted playsInline
                           className="w-full h-full object-contain" />
                  ) : (
                    <>
                      <img src={assetsApi.thumbnailUrl(t.asset.id)} alt="" className="w-full h-full object-cover" />
                      <span className="absolute inset-0 flex items-center justify-center text-white/70 text-2xl">▶</span>
                    </>
                  )}
                  {isCurrent && (
                    <span className="absolute top-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-emerald-600 text-white">採用中</span>
                  )}
                </div>
                <div className="text-[10px] text-zinc-400 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>#{t.asset.id}</span>
                  {t.seed != null && <span>seed {t.seed}</span>}
                  {t.steps != null && <span>{t.steps}steps</span>}
                  {t.easycache != null && <span>{t.easycache ? '⚡EC' : 'EC無'}</span>}
                  <span className="text-zinc-600">{(t.model ?? '').replace('minimax-', '')}</span>
                </div>
                {t.prompt && (
                  <p className="text-[9px] text-zinc-600 line-clamp-2" title={t.prompt}>{t.prompt}</p>
                )}
                <button onClick={() => adopt(t.asset.id)} disabled={isCurrent}
                        className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40 self-start">
                  {isCurrent ? '採用中' : '✅ このテイクを採用'}
                </button>
              </div>
            )
          })}
        </div>
        {msg && <p className="text-[10px] text-emerald-400">{msg}</p>}
        <p className="text-[9px] text-zinc-600">
          サムネクリックでループ再生プレビュー(プロキシ)。採用するとShotsトラックの f{cut.s} 位置に配置/差し替えされます(カット長にトリム)。
        </p>
      </div>
    </div>,
    document.body
  )
}
