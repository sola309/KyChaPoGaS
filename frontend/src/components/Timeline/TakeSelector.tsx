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
  /** 🗂を押したクリップ。採用が書き換えるのはこのクリップだけ。
      未指定(カット割りレーンからのダブルクリック)は従来どおり Shots の該当カット。 */
  sourceClipId?: number
  assets: Asset[]
  fps: number
  onClose: () => void
}

/** カット位置の微調整でテイクが行方不明にならないための許容幅(フレーム)。
 *  テイクは gen_params.place.start_frame で紐付くが、参照動画の差し替え等でピンを
 *  数コマ動かすと完全一致しなくなる。カット長より十分小さい幅で寄せて拾う。 */
const SNAP = 8

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
  jobId?: number                  // 生成ジョブ番号(ログや会話での指示に使う)
  drift: number                   // 生成時のカット開始との差(フレーム)。0以外はピン移動後
  spanFrames: number              // 生成時に確保した長さ。カット長を超える=複数カットにまたがるテイク
  srcStart: number                // 生成時のカット開始フレーム(部分採用のオフセット計算に使う)
}

// 生成物のファイル名は `<種別>_<ジョブID>.<拡張子>` で作られる(job_runner)。
// ジョブ番号は会話やログでテイクを一意に指す識別子になるので、そこから復元する。
const jobIdOf = (filePath: string): number | undefined => {
  const base = filePath.split('/').pop() ?? ''
  const m = base.match(/^(?:h3r|h3|s2v|wanseg|video|mg|music)_(\d+)(?:[._])/)
  return m ? Number(m[1]) : undefined
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
  // 🚀Turbo LoRAはモデルの重み自体が変わるため、同じseedでも非Turboでは再現しない。
  // 本番解像度で回していてもT2(=シードを本番へ引き継げる構成)とは呼べないのでT1扱い。
  if (p.turbo_lora) return 1
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

export function TakeSelector({ cut, sourceClipId, assets, fps, onClose }: Props) {
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
        if (!place || typeof place.start_frame !== 'number') continue
        const drift = place.start_frame - cut.s
        const span = Number(place.duration_frames ?? 0)
        // このカットで生成されたものに加えて、このカットを内側に含む長いテイク
        // (C18-20をまとめて作ったもの等)も出す。部分だけをShotsへ採るため。
        const startsHere = Math.abs(drift) <= SNAP
        const covers = place.start_frame - SNAP <= cut.s && place.start_frame + span >= cut.e
        if (!startsHere && !covers) continue
        if (!String(p?.model ?? '').match(/minimax-h3|wan2\.2|svd/)) continue
        out.push({ asset: a, seed: p.seed, prompt: p.prompt, model: p.model, steps: p.steps,
                   easycache: p.easycache, raw: p,
                   tier: tierOf(p), promptHash: hashStr(String(p.prompt ?? '')),
                   jobId: jobIdOf(a.file_path), drift,
                   spanFrames: span, srcStart: place.start_frame })
      } catch { /* gen_params壊れは無視 */ }
    }
    return out.sort((a, b) => b.asset.id - a.asset.id)   // 新しい順
  }, [assets, cut.s, cut.e])

  const shotsTrack = tracks.find(t => t.track_type === 'video' && t.name === 'Shots')
  const currentClip = shotsTrack
    ? clips.find(c => c.track_id === shotsTrack.id && c.start_frame === cut.s)
    : undefined
  const cutLen = cut.e - cut.s + 1
  const isSpan = (t: Take) => t.spanFrames > cutLen
  // 採用の書き換え先。🗂を押したクリップがあればそれ一択(他のレイヤーには触らない)。
  // 無ければ従来どおり Shots の該当カット(無ければ新規作成)。
  const sourceClip = sourceClipId != null ? clips.find(c => c.id === sourceClipId) : undefined
  const sourceTrack = sourceClip ? tracks.find(x => x.id === sourceClip.track_id) : undefined
  const targetClip = sourceClip ?? currentClip

  // 昇格: 同じプロンプトのまま上位Tierの条件で再実行する。
  // T1→T2は解像度が変わるためシードは意味を持たない(新規サンプル)。
  // T2→T3は解像度が同じなのでシードを引き継ぎ、同じ絵が高精細になる。
  const promote = async (t: Take, to: 2 | 3) => {
    const p = { ...(t.raw ?? {}) } as Record<string, unknown>
    p.width = 1344; p.height = 768
    p.steps = to === 2 ? 8 : 20
    p.easycache = false
    p.ref_image_size = 'max'
    delete p.turbo_lora          // 昇格先は常に素のモデル(Turboはテクスチャが平坦化するため下見専用)
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

  const adopt = async (tk: Take) => {
    const st = useTimelineStore.getState()
    const target = sourceClip ?? currentClip
    // このテイクの中で、対象クリップの開始位置が何フレーム目に当たるか(頭出し)
    const offAt = (startFrame: number) => Math.max(0, startFrame - tk.srcStart)

    if (target) {
      if (target.locked) {
        setMsg('🔒 このクリップはロックされています — 🔒を解除してから採用してください')
        return
      }
      // 書き換えるのは素材と頭出しだけ。開始位置・長さ・レイヤーには触れない。
      await st.updateClip(target.id, { asset_id: tk.asset.id, asset_in_frame: offAt(target.start_frame) })
      const off = offAt(target.start_frame)
      setMsg(off
        ? `✅ #${tk.asset.id} の ${(off / fps).toFixed(2)}秒地点から採用しました(${sourceTrack?.name ?? 'Shots'})`
        : `✅ #${tk.asset.id} を採用しました(${sourceTrack?.name ?? 'Shots'})`)
      return
    }

    // クリップが無い(カット割りレーンから開いた空きカット): Shots に新規作成
    const shots = shotsTrack
    if (!shots) return
    const c = await st.addClip(shots.id, tk.asset.id, cut.s, cutLen)
    const off = offAt(cut.s)
    if (off) await st.updateClip(c.id, { asset_in_frame: off })
    setMsg(`✅ #${tk.asset.id} を Shots の f${cut.s} に配置しました`)
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
            {takes.some(t => t.drift !== 0) && (
              <span className="ml-2 text-[10px] text-amber-400/90"
                    title="カット位置を動かしたあとのテイクも±8フレームまで拾っています">
                ±{SNAP}fで照合中
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            {/* 採用の書き換え先を明示(誤操作でも他レイヤーに波及しないことの見える化) */}
            <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400">
              採用先: {sourceTrack ? `${sourceTrack.name} クリップ(f${sourceClip!.start_frame}・${sourceClip!.duration_frames}f)` : `Shots f${cut.s}`}
            </span>
            {/* カット位置を動かしたあとに、テイクの紐付けを現在のカット割りへ手動で寄せ直す。
                自動実行にすると短いカットが隣り合う箇所で取り違えるため手動にしている。 */}
            <button
              onClick={() => window.dispatchEvent(new Event('kychapogas:remap-takes'))}
              title="カット位置を動かしたあと、テイクの紐付けを現在のカット割りに合わせ直します(隣のカットへは移りません)"
              className="text-[10px] px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-100">
              🗂 紐付けを整える
            </button>
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
          </span>
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
            const isCurrent = targetClip?.asset_id === t.asset.id
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
                    <span className="absolute top-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-emerald-600 text-white">
                      採用中
                    </span>
                  )}
                  <span className={`absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded border ${TIER_STYLE[t.tier].cls}`}>
                    {TIER_STYLE[t.tier].label}
                  </span>
                </div>
                <div className="text-[10px] text-zinc-400 flex flex-wrap gap-x-3 gap-y-0.5 items-center">
                  <span className="px-1 rounded bg-zinc-800 text-zinc-300" title="プロンプト版(同じ文面=同じ版)">
                    P:{t.promptHash}
                  </span>
                  {t.drift !== 0 && (
                    <span className="px-1 rounded bg-zinc-800 text-zinc-500 border border-zinc-700"
                          title={`生成時のカット開始 f${t.raw?.place ? (t.raw.place as Record<string, unknown>).start_frame : '?'} から ${-t.drift > 0 ? '+' : ''}${-t.drift}f 移動しています`}>
                      {t.drift > 0 ? '▸' : '◂'}{Math.abs(t.drift)}f
                    </span>
                  )}
                  {t.jobId != null && (
                    <span className="px-1 rounded bg-amber-900/60 text-amber-200 border border-amber-700/60"
                          title="生成ジョブ番号 — 会話やログでこのテイクを指すときに使う">
                      job {t.jobId}
                    </span>
                  )}
                  {Boolean(t.raw?.turbo_lora) && (
                    <span className="px-1 rounded bg-amber-800/70 text-amber-200 border border-amber-600/60"
                          title="Turbo LoRAで生成(4step・約30%高速)。テクスチャが平坦で、このseedは非Turboでは再現しません">
                      🚀Turbo
                    </span>
                  )}
                  <span>#{t.asset.id}</span>
                  {t.seed != null && <span>seed {t.seed}</span>}
                  {t.steps != null && <span>{t.steps}st</span>}
                  {t.raw?.width != null && <span className="text-zinc-600">{String(t.raw.width)}×{String(t.raw.height)}</span>}
                  {t.easycache != null && <span>{t.easycache ? '⚡EC' : 'EC無'}</span>}
                </div>
                {isSpan(t) && (
                  <p className="text-[9px] text-sky-400">
                    🎬 複数カット({(t.spanFrames / fps).toFixed(1)}秒 / f{t.srcStart}〜f{t.srcStart + t.spanFrames - 1})
                    — このカットはその {((cut.s - t.srcStart) / fps).toFixed(2)}秒地点
                  </p>
                )}
                {t.prompt && (
                  <p className="text-[9px] text-zinc-600 line-clamp-2" title={t.prompt}>{t.prompt}</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => adopt(t)} disabled={isCurrent}
                          className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40"
                          title={isSpan(t)
                            ? `${t.spanFrames}フレームのテイク — 採用先クリップの位置に合わせて頭出しされます`
                            : undefined}>
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
