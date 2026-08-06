import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Clip } from '../../api/client'
import { useJobStore } from '../../store/jobStore'
import { useTimelineStore } from '../../store/timelineStore'
import { RefImagePicker } from '../RefImagePicker'

// 🔁 再生成パネル — 生成アセットのクリップを選択すると、そのアセットを作った
// 生成パラメータ(asset.gen_params_json)を開き、prompt/seed等を微調整して
// 「同じ場所に差し替え再生成」できる。試行錯誤の中心となるUI。

interface Props {
  clip: Clip
  asset: Asset
  projectId: number
  fps: number
  assets?: Asset[]   // Ref2Vの参照画像ピッカー用(未指定時はピッカー非表示)
}

type GenParams = Record<string, unknown> & {
  prompt?: string; negative_prompt?: string; model?: string
  width?: number; height?: number; seed?: number
  init_asset_id?: number; denoise?: number; ref_asset_ids?: number[]; use_lightning?: boolean
  keyframes?: { time_sec: number; asset_id: number }[]
  duration_sec?: number
  loras?: [string, number][]
  steps?: number; easycache?: boolean
  ref_video_asset_ids?: number[]; ref_audio_asset_ids?: number[]
  scheduler?: string; ref_image_size?: string
}

export function RegenPanel({ clip, asset, projectId, fps, assets }: Props) {
  const { generateImage, generateVideoI2V, jobs } = useJobStore()
  const { loadTimeline } = useTimelineStore()
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const watched = useRef<Set<number>>(new Set())

  const params: GenParams | null = useMemo(() => {
    try {
      const p = JSON.parse(asset.gen_params_json || '{}')
      return p && typeof p === 'object' && 'prompt' in p ? p as GenParams : null
    } catch { return null }
  }, [asset.gen_params_json])

  const kind: 'image' | 'i2v' | null = useMemo(() => {
    if (!params) return null
    const model = String(params.model ?? '')
    if (Array.isArray(params.keyframes) || model.startsWith('wan2.2') || model === 'svd-xt')
      return Array.isArray(params.keyframes) && params.keyframes.length > 0 ? 'i2v' : null
    return 'image'
  }, [params])

  const [prompt, setPrompt] = useState('')
  const [seed, setSeed] = useState<number>(-1)
  const [denoise, setDenoise] = useState(0.6)
  // ⚙ オプション(解像度・ネガティブ等)
  const [showOpts, setShowOpts] = useState(false)
  const [negPrompt, setNegPrompt] = useState('')
  const [width, setWidth] = useState(1024)
  const [height, setHeight] = useState(1024)
  const [lightning, setLightning] = useState(true)
  const [frames, setFrames] = useState(81)   // i2v: フレーム数(エンジン別グリッド)
  const [vidModel, setVidModel] = useState('wan2.2-flf2v')
  const [h3Steps, setH3Steps] = useState(15)
  const snap4n1 = (n: number) => Math.max(5, Math.round((n - 1) / 4) * 4 + 1)
  const snapH3 = (n: number) => { const m = Math.max(124, Math.min(362, n)); return Math.min(362, m + (5 - (m % 17)) % 17) }   // 訓練域124-362
  const isH3 = vidModel.startsWith('minimax-h3')
  const [easycache, setEasycache] = useState(true)
  // Ref2V: 参照画像(=keyframes)は通常パネルと同じ視覚ピッカーで編集可能に
  const [refImgIds, setRefImgIds] = useState<number[]>([])
  const [refScheduler, setRefScheduler] = useState('beta')
  const [refImgSize, setRefImgSize] = useState('match')
  const genFps = isH3 ? 24 : 16
  const snapFn = isH3 ? snapH3 : snap4n1
  useEffect(() => {
    if (!params) return
    setPrompt(String(params.prompt ?? ''))
    setSeed(Number(params.seed ?? -1))
    setDenoise(Number(params.denoise ?? 0.6))
    setNegPrompt(String(params.negative_prompt ?? ''))
    setWidth(Number(params.width ?? 1024))
    setHeight(Number(params.height ?? 1024))
    setLightning(params.use_lightning !== false)
    const m0 = String(params.model ?? 'wan2.2-flf2v')
    setVidModel(m0)
    const h3 = m0.startsWith('minimax-h3')
    const f0 = h3 ? 24 : 16
    const sn = h3 ? snapH3 : snap4n1
    setFrames(sn(Math.round(Number(params.duration_sec ?? 5) * f0)))
    setH3Steps(Number(params.steps ?? 15))
    setEasycache(params.easycache !== false)
    setRefImgIds(Array.isArray(params.keyframes) ? params.keyframes.map(k => k.asset_id) : [])
    setRefScheduler(String(params.scheduler ?? 'beta'))
    setRefImgSize(String(params.ref_image_size ?? 'match'))
  }, [params])

  const sizePresets = kind === 'i2v'
    ? (isH3
        ? [['横 1344×768(H3ネイティブ)', 1344, 768], ['縦 768×1344(H3ネイティブ)', 768, 1344],
           ['横 1152×640(高速)', 1152, 640], ['縦 640×1152(高速)', 640, 1152], ['正方 960', 960, 960]] as const
        : [['横 1280×720(推奨)', 1280, 720], ['縦 720×1280', 720, 1280],
           ['横 832×480(高速)', 832, 480], ['縦 480×832(高速)', 480, 832], ['正方 640', 640, 640]] as const)
    : [['横 1344×768', 1344, 768], ['縦 832×1216', 832, 1216], ['正方 1024', 1024, 1024]] as const

  // ジョブ完了 → タイムライン再読込(クリップのアセットが差し替わる)
  useEffect(() => {
    for (const j of jobs) {
      if (!watched.current.has(j.id)) continue
      if (j.status === 'completed' || j.status === 'failed') {
        watched.current.delete(j.id)
        if (j.status === 'completed') {
          loadTimeline(projectId, fps)
          setMsg('✅ 差し替え完了')
        } else setMsg('❌ 失敗(ジョブログ参照)')
      }
    }
  }, [jobs, projectId, fps, loadTimeline])

  if (!params || !kind) return null

  const handleRegen = async () => {
    setMsg('')
    try {
      const place = { track_id: clip.track_id, start_frame: clip.start_frame,
                      duration_frames: clip.duration_frames, replace_clip_id: clip.id }
      let jobId: number
      if (kind === 'image') {
        const job = await generateImage({
          project_id: projectId,
          prompt, negative_prompt: negPrompt,
          model: String(params.model ?? 'waiNSFWIllustrious_v170'),
          width, height, seed,
          ...(params.init_asset_id ? { init_asset_id: Number(params.init_asset_id), denoise } : {}),
          ...(Array.isArray(params.ref_asset_ids) && params.ref_asset_ids.length ? { ref_asset_ids: params.ref_asset_ids } : {}),
          ...(Array.isArray(params.loras) && params.loras.length ? { loras: params.loras } : {}),
          place,
        })
        jobId = job.id
      } else {
        const oldDur = Number(params.duration_sec ?? 3)
        const newDur = snapFn(frames) / genFps
        const kfScale = oldDur > 0 ? newDur / oldDur : 1
        // Ref2V: keyframes=参照画像。ピッカーの現在の選択をそのまま使う(通常パネルと同一挙動)
        let kfs = vidModel === 'minimax-h3-ref'
          ? refImgIds.slice(0, 9).map(id => ({ time_sec: 0, asset_id: id }))
          : params.keyframes!.map(k => ({ ...k, time_sec: k.time_sec * kfScale }))
        // H3(FL2VA)は最初/最後のみ
        if (vidModel === 'minimax-h3' && kfs.length > 2) kfs = [kfs[0], kfs[kfs.length - 1]]
        const job = await generateVideoI2V({
          project_id: projectId,
          keyframes: kfs,
          duration_sec: newDur,
          model: vidModel,
          prompt, negative_prompt: negPrompt,
          width, height, seed, use_lightning: lightning,
          ...(isH3 ? { steps: h3Steps, easycache } : {}),
          // Ref2V: 参照動画/音声・scheduler・ref_image_sizeを元条件のまま引き継ぐ
          ...(vidModel === 'minimax-h3-ref' ? {
            ...(Array.isArray(params.ref_video_asset_ids) && params.ref_video_asset_ids.length ? { ref_video_asset_ids: params.ref_video_asset_ids } : {}),
            ...(Array.isArray(params.ref_audio_asset_ids) && params.ref_audio_asset_ids.length ? { ref_audio_asset_ids: params.ref_audio_asset_ids } : {}),
            scheduler: refScheduler,
            ref_image_size: refImgSize,
          } : {}),
          place,
        })
        jobId = job.id
      }
      watched.current.add(jobId)
      setMsg(`⏳ 再生成中(job ${jobId})— 完了時にこのクリップへ差し替え`)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'エラー') }
  }

  const inputCls = 'bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500'

  return (
    <span className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={`text-[11px] px-2 py-0.5 rounded border ${
          open ? 'bg-purple-900/60 text-purple-200 border-purple-700'
               : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700'
        }`}
        title="このクリップの生成条件を開いて再生成(同じ位置に差し替え)"
      >🔁 再生成</button>

      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-2 sm:p-6"
             onClick={() => setOpen(false)}>
        <div onClick={e => e.stopPropagation()}
             className="w-[min(560px,94vw)] max-h-[92vh] overflow-y-auto p-4 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-200">🔁 再生成して差し替え</span>
            <button onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
          </div>
          <div className="text-[10px] text-zinc-500">
            {kind === 'image'
              ? `${Array.isArray(params.ref_asset_ids) && params.ref_asset_ids.length ? '✏️編集' : params.init_asset_id ? 'i2i' : 't2i'} / ${params.model} / ${params.width}×${params.height}`
              : `${params.model} / ${params.keyframes!.length}KF / ${Number(params.duration_sec ?? 0).toFixed(1)}s`}
          </div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
                    className={inputCls + ' resize-none'} placeholder="プロンプト" />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500">seed</span>
            <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))}
                   className={inputCls + ' w-28'} />
            <button onClick={() => setSeed(-1)} title="ランダム(-1)"
                    className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700">🎲</button>
          </div>
          {kind === 'i2v' && (
            <>
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                <span>エンジン</span>
                <select value={vidModel}
                        onChange={e => {
                          const m = e.target.value
                          const secs = frames / genFps
                          setVidModel(m)
                          const h3sel = m.startsWith('minimax-h3')
                          const nf = h3sel ? snapH3(Math.round(secs * 24)) : snap4n1(Math.round(secs * 16))
                          setFrames(nf)
                          // 解像度をエンジンの推奨バケットへスナップ(縦横比は維持)
                          const portrait = height > width
                          if (h3sel) { setWidth(portrait ? 768 : 1344); setHeight(portrait ? 1344 : 768) }
                          else if (width % 32 === 0 && (width === 1344 || width === 768 || width === 1152 || width === 640 || width === 960)) {
                            setWidth(portrait ? 720 : 1280); setHeight(portrait ? 1280 : 720)
                          }
                        }}
                        className={inputCls + ' flex-1'}>
                  <option value="wan2.2-flf2v">Wan2.2 FLF2V(高速)</option>
                  <option value="wan2.2-vace">Wan2.2 VACE(中間KF固定)</option>
                  <option value="minimax-h3">MiniMax H3(音声付き・約3分)</option>
                  <option value="minimax-h3-ref">🎭 H3 Ref2V(参照束)</option>
                </select>
                {isH3 && (
                  <>
                    <label className="flex items-center gap-1">steps
                      <input type="number" min={8} max={40} value={h3Steps}
                             onChange={e => setH3Steps(Math.max(8, Math.min(40, Number(e.target.value))))}
                             className={inputCls + ' w-14'} />
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer" title="約1.5〜2倍高速(わずかに甘くなる)">
                      <input type="checkbox" checked={easycache} onChange={e => setEasycache(e.target.checked)} />⚡
                    </label>
                  </>
                )}
              </div>
              {vidModel === 'minimax-h3-ref' && (
                <>
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 flex-wrap">
                    <span>🎥参照動画 {Array.isArray(params.ref_video_asset_ids) && params.ref_video_asset_ids.length
                      ? params.ref_video_asset_ids.map(x => `#${x}`).join(' ') : 'なし'}</span>
                    <span>🎤参照音声 {Array.isArray(params.ref_audio_asset_ids) && params.ref_audio_asset_ids.length
                      ? params.ref_audio_asset_ids.map(x => `#${x}`).join(' ') : 'なし'}</span>
                    <select value={refImgSize} onChange={e => setRefImgSize(e.target.value)} className={inputCls}
                            title="match=速度優先 / max=同一性優先">
                      <option value="match">match</option>
                      <option value="max">max(同一性)</option>
                    </select>
                    <select value={refScheduler} onChange={e => setRefScheduler(e.target.value)} className={inputCls}>
                      <option value="beta">beta</option>
                      <option value="normal">normal</option>
                      <option value="simple">simple</option>
                    </select>
                  </div>
                  {assets && (
                    <RefImagePicker assets={assets} selected={refImgIds} onChange={setRefImgIds} fps={fps} />
                  )}
                </>
              )}
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                <span>フレーム数</span>
                <input type="number" step={isH3 ? 17 : 4} min={5} value={frames}
                       onChange={e => setFrames(snapFn(Number(e.target.value)))}
                       className={inputCls + ' w-20'} />
                {(isH3 ? [124, 226, 362] : [41, 81, 121]).map(n => (
                  <button key={n} onClick={() => setFrames(n)}
                          className={`px-1.5 py-0.5 rounded ${frames === n ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 hover:bg-zinc-700'}`}>{n}</button>
                ))}
                <span className="ml-auto">= {(snapFn(frames) / genFps).toFixed(2)}秒({genFps}fps{isH3 ? '・音声付き' : '・推奨81'})</span>
              </div>
            </>
          )}
          {kind === 'image' && params.init_asset_id != null && (
            <label className="flex items-center gap-2 text-[10px] text-zinc-500">
              変化量 {denoise.toFixed(2)}
              <input type="range" min={0.2} max={0.9} step={0.05} value={denoise}
                     onChange={e => setDenoise(Number(e.target.value))} className="flex-1" />
            </label>
          )}

          {/* ⚙ オプション(解像度・ネガティブ・品質) */}
          <button onClick={() => setShowOpts(v => !v)}
                  className="text-[10px] text-left text-zinc-500 hover:text-zinc-300">
            {showOpts ? '▼' : '▶'} ⚙ オプション
            <span className="ml-1 text-zinc-600">{width}×{height}</span>
          </button>
          {showOpts && (
            <div className="flex flex-col gap-2 pl-1 border-l border-zinc-800">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-500 w-10">解像度</span>
                <select
                  value={sizePresets.findIndex(p => p[1] === width && p[2] === height)}
                  onChange={e => {
                    const p = sizePresets[Number(e.target.value)]
                    if (p) { setWidth(p[1]); setHeight(p[2]) }
                  }}
                  className={inputCls + ' flex-1'}
                >
                  <option value={-1}>カスタム</option>
                  {sizePresets.map((p, i) => <option key={i} value={i}>{p[0]}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-500 w-10">W×H</span>
                <input type="number" step={16} value={width}
                       onChange={e => setWidth(Number(e.target.value))} className={inputCls + ' w-20'} />
                <span className="text-zinc-600 text-[10px]">×</span>
                <input type="number" step={16} value={height}
                       onChange={e => setHeight(Number(e.target.value))} className={inputCls + ' w-20'} />
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-zinc-500">ネガティブプロンプト</span>
                <textarea value={negPrompt} onChange={e => setNegPrompt(e.target.value)} rows={2}
                          className={inputCls + ' resize-none'} placeholder="low quality, blurry, ..." />
              </label>
              {kind === 'i2v' && (
                <label className="flex items-center gap-2 text-[10px] text-zinc-500">
                  <input type="checkbox" checked={lightning} onChange={e => setLightning(e.target.checked)} />
                  高速4step(OFF=高品質20step・数倍遅い)
                </label>
              )}
            </div>
          )}

          <button onClick={handleRegen}
                  className="text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white">
            🔁 再生成して差し替え
          </button>
          {msg && <p className="text-[10px] text-zinc-400">{msg}</p>}
        </div>
        </div>,
        document.body
      )}
    </span>
  )
}
