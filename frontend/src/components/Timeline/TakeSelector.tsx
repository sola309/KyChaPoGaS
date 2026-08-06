import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../../api/client'
import { assetsApi, generationApi, type VideoI2VParams } from '../../api/client'
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
  raw?: Record<string, unknown>   // 全生成パラメータ(詳細トグル用)
  tier: 1 | 2 | 3                 // 検証段階(生成条件から自動判定)
  promptHash: string              // プロンプト版の識別子(同一文面=同一版)
}

/**
 * Tier判定 — リサーチ結論に基づく検証段階。
 *  T1 下見: 低解像度・低ステップ。プロンプト解釈の検証専用(シードは本番に引き継げない)
 *  T2 選定: 本番解像度・低ステップ。シードが本番へ引き継げる唯一の構成
 *  T3 本番: 本番解像度・高ステップ
 */
const tierOf = (p: Record<string, unknown>): 1 | 2 | 3 => {
  const px = Number(p.width ?? 0) * Number(p.height ?? 0)
  const steps = Number(p.steps ?? 20)
  if (px < 900000) return 1              // 1344x768(1.03MP)未満=下見
  return steps <= 10 ? 2 : 3
}
const TIER_STYLE: Record<number, { label: string; cls: string }> = {
  1: { label: 'T1 下見', cls: 'bg-sky-900/70 text-sky-200 border-sky-600' },
  2: { label: 'T2 選定', cls: 'bg-violet-900/70 text-violet-200 border-violet-600' },
  3: { label: 'T3 本番', cls: 'bg-emerald-900/70 text-emerald-200 border-emerald-600' },
}
// プロンプト文面のハッシュ(短い16進)。同じ版のテイクをグループ化するのに使う
const hashStr = (s: string): string => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16).slice(0, 4)
}

export function TakeSelector({ cut, assets, fps, onClose }: Props) {
  const clips = useTimelineStore(s => s.clips)
  const tracks = useTimelineStore(s => s.tracks)
  const [previewId, setPreviewId] = useState<number | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)   // 生成情報の詳細トグル
  const [tierFilter, setTierFilter] = useState<0 | 1 | 2 | 3>(0)  // 0=すべて
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
        out.push({ asset: a, seed: p.seed, prompt: p.prompt, model: p.model, steps: p.steps,
                   easycache: p.easycache, raw: p,
                   tier: tierOf(p), promptHash: hashStr(String(p.prompt ?? '')) })
      } catch { /* gen_params壊れは無視 */ }
    }
    return out.sort((a, b) => b.asset.id - a.asset.id)   // 新しい順
  }, [assets, cut.s])

  const shotsTrack = tracks.find(t => t.track_type === 'video' && t.name === 'Shots')
  const currentClip = shotsTrack
    ? clips.find(c => c.track_id === shotsTrack.id && c.start_frame === cut.s)
    : undefined

  // 昇格: 同じプロンプトのまま上位Tierの条件で再実行する。
  // T1→T2は解像度が変わるためシードは意味を持たない(新規サンプル)。
  // T2→T3は解像度が同じなのでシードを引き継ぎ、同じ絵が高精細になる。
  const promote = async (t: Take, to: 2 | 3) => {
    const p = { ...(t.raw ?? {}) } as Record<string, unknown>
    p.width = 1344; p.height = 768
    p.steps = to === 2 ? 8 : 20
    p.easycache = false
    p.ref_image_size = 'max'
    if (to === 3 && t.tier === 2) p.seed = t.seed          // T2→T3のみシード継承
    else p.seed = Math.floor(Math.random() * 2 ** 31)
    p.place = { ...((p.place as Record<string, unknown>) ?? {}), auto: false }
    try {
      await generationApi.videoI2V(p as unknown as VideoI2VParams)
      setMsg(to === 3 && t.tier === 2
        ? `⬆ T3本番へ昇格(seed ${t.seed} を継承)— 完了後この一覧に出ます`
        : `⬆ T${to}へ昇格(解像度が変わるためシードは新規)— 完了後この一覧に出ます`)
    } catch { setMsg('⚠ 昇格に失敗しました') }
  }

  const adopt = async (assetId: number) => {
    const st = useTimelineStore.getState()
    let shots = shotsTrack
    if (!shots) return
    if (currentClip?.locked) {
      setMsg('🔒 このカットはロックされています — クリップの🔒を解除してから採用してください')
      return
    }
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

        {takes.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
            <span className="text-zinc-500">段階</span>
            {([0, 1, 2, 3] as const).map(t => {
              const n = t === 0 ? takes.length : takes.filter(x => x.tier === t).length
              return (
                <button key={t} onClick={() => setTierFilter(t)}
                        className={`px-2 py-1 rounded border ${
                          tierFilter === t ? 'bg-zinc-700 text-zinc-100 border-zinc-500'
                                           : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'}`}>
                  {t === 0 ? `すべて ${n}` : `${TIER_STYLE[t].label} ${n}`}
                </button>
              )
            })}
            <span className="ml-auto text-zinc-600">
              プロンプト版 {new Set(takes.map(t => t.promptHash)).size}種
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {takes.filter(t => tierFilter === 0 || t.tier === tierFilter).map(t => {
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
                  <span className={`absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded border ${TIER_STYLE[t.tier].cls}`}>
                    {TIER_STYLE[t.tier].label}
                  </span>
                </div>
                <div className="text-[10px] text-zinc-400 flex flex-wrap gap-x-3 gap-y-0.5 items-center">
                  <span className="px-1 rounded bg-zinc-800 text-zinc-300" title="プロンプト版(同じ文面=同じ版)">
                    P:{t.promptHash}
                  </span>
                  <span>#{t.asset.id}</span>
                  {t.seed != null && <span>seed {t.seed}</span>}
                  {t.steps != null && <span>{t.steps}st</span>}
                  {t.raw?.width != null && <span className="text-zinc-600">{String(t.raw.width)}×{String(t.raw.height)}</span>}
                  {t.easycache != null && <span>{t.easycache ? '⚡EC' : 'EC無'}</span>}
                </div>
                {t.prompt && (
                  <p className="text-[9px] text-zinc-600 line-clamp-2" title={t.prompt}>{t.prompt}</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => adopt(t.asset.id)} disabled={isCurrent}
                          className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40">
                    {isCurrent ? '採用中' : '✅ 採用'}
                  </button>
                  {t.tier === 1 && (
                    <button onClick={() => void promote(t, 2)}
                            className="text-[10px] px-2 py-1 rounded bg-violet-800 hover:bg-violet-700 text-violet-100"
                            title="同じプロンプトで本番解像度・8stepへ(解像度が変わるためシードは新規)">
                      ⬆ T2へ
                    </button>
                  )}
                  {t.tier === 2 && (
                    <button onClick={() => void promote(t, 3)}
                            className="text-[10px] px-2 py-1 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-100"
                            title="同じプロンプト・同じシードで20step本番へ(この絵が高精細になる)">
                      ⬆ T3へ(seed継承)
                    </button>
                  )}
                  {t.tier === 1 && (
                    <button onClick={() => void promote(t, 3)}
                            className="text-[10px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                            title="下見を飛ばして本番条件で回す(シードは新規)">
                      ⬆ T3へ直行
                    </button>
                  )}
                  <button onClick={() => setDetailId(detailId === t.asset.id ? null : t.asset.id)}
                          className="text-[10px] px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700">
                    {detailId === t.asset.id ? '▲ 生成情報' : '▼ 生成情報'}
                  </button>
                </div>
                {detailId === t.asset.id && t.raw && (
                  <div className="text-[9px] text-zinc-400 bg-zinc-900 border border-zinc-800 rounded p-2 flex flex-col gap-0.5">
                    {([
                      ['model', t.raw.model], ['seed', t.raw.seed], ['steps', t.raw.steps],
                      ['scheduler', t.raw.scheduler], ['ref_image_size', t.raw.ref_image_size],
                      ['easycache', t.raw.easycache], ['size', `${t.raw.width}×${t.raw.height}`],
                      ['duration', `${Number(t.raw.duration_sec ?? 0).toFixed(2)}s`],
                      ['参照画像', (t.raw.keyframes as { asset_id: number }[] | undefined)?.map(kf => `#${kf.asset_id}`).join(' ')],
                      ['参照動画', (t.raw.ref_video_asset_ids as number[] | undefined)?.map(x => `#${x}`).join(' ')],
                      ['参照音声', (t.raw.ref_audio_asset_ids as number[] | undefined)?.map(x => `#${x}`).join(' ')],
                    ] as [string, unknown][]).filter(([, v]) => v != null && v !== '' && v !== 'undefined×undefined').map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <span className="text-zinc-600 w-20 flex-shrink-0">{k}</span>
                        <span className="break-all">{String(v)}</span>
                      </div>
                    ))}
                    {t.prompt && (
                      <div className="mt-1 pt-1 border-t border-zinc-800">
                        <span className="text-zinc-600">prompt</span>
                        <p className="whitespace-pre-wrap break-words text-zinc-300">{t.prompt}</p>
                      </div>
                    )}
                  </div>
                )}
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
