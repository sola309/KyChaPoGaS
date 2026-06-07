import { useState, useMemo } from 'react'
import { useJobStore } from '../../../store/jobStore'
import { useProjectStore } from '../../../store/projectStore'
import { useTimelineStore } from '../../../store/timelineStore'
import { assetsApi, type Asset } from '../../../api/client'

function KeyframePreview({ timeSec, asset }: { timeSec: number; asset: Asset | undefined }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-14 h-10 rounded border border-amber-700 bg-zinc-900 overflow-hidden flex items-center justify-center">
        {asset ? (
          <img src={assetsApi.thumbnailUrl(asset.id)} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-[10px] text-zinc-600">?</span>
        )}
      </div>
      <span className="text-[9px] text-amber-400">{timeSec.toFixed(2)}s</span>
      {asset && <span className="text-[8px] text-zinc-500 truncate w-14 text-center">{asset.name}</span>}
    </div>
  )
}

export function VideoGenPanel({ assets }: { assets: Asset[] }) {
  const { activeProject } = useProjectStore()
  const { generateVideoI2V, comfyAvailable } = useJobStore()
  const { tracks, clips, projectFps } = useTimelineStore()

  const [model,    setModel]    = useState('wan2.2-flf2v')
  const [duration, setDuration] = useState(3.0)
  const [fps,      setFps]      = useState(16)
  const [strength, setStrength] = useState(0.6)
  const [seed,     setSeed]     = useState(-1)
  const [prompt,   setPrompt]   = useState('')
  const [negPrompt, setNegPrompt] = useState('')
  const [vres, setVres] = useState('832x480')   // Wan2.2 16:9 buckets
  const [useLightning, setUseLightning] = useState(true)
  const [busy,     setBusy]     = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const isWan = model.startsWith('wan2.2')

  // Read keyframes from Reference tracks on the timeline
  const keyframes = useMemo(() => {
    const refTracks = tracks.filter(t => t.track_type === 'reference')
    const refClips  = clips
      .filter(c => refTracks.some(t => t.id === c.track_id) && c.asset_id != null)
      .sort((a, b) => a.start_frame - b.start_frame)
    return refClips.map(c => ({
      time_sec: c.start_frame / projectFps,
      asset_id: c.asset_id!,
      asset:    assets.find(a => a.id === c.asset_id),
    }))
  }, [tracks, clips, assets, projectFps])

  const modeLabel =
    keyframes.length === 0 ? '— (Ref不足)' :
    keyframes.length === 1 ? '最初フレームのみ' :
    isWan && keyframes.length > 2 ? `最初→中間${keyframes.length - 2}→最終（${keyframes.length - 1}区間）` :
    isWan                  ? '最初→最後フレーム' :
    keyframes.length === 2 ? 'Start–End I2V' :
    `Multi-keyframe I2V (${keyframes.length}フレーム)`

  const handleGenerate = async () => {
    if (!activeProject || keyframes.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      await generateVideoI2V({
        project_id: activeProject.id,
        keyframes:  keyframes.map(kf => ({ time_sec: kf.time_sec, asset_id: kf.asset_id })),
        duration_sec: duration,
        fps, motion_strength: strength, model, seed,
        ...(isWan ? {
          prompt, negative_prompt: negPrompt,
          width:  Number(vres.split('x')[0]),
          height: Number(vres.split('x')[1]),
          use_lightning: useLightning,
        } : {}),
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成エラー')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {!comfyAvailable && (
        <div className="text-[10px] text-amber-400 bg-amber-950/30 border border-amber-800 rounded px-2 py-1.5">
          ComfyUI未接続 — ジョブはキューに入りますが実行されません
        </div>
      )}

      {/* Keyframe display (read from Reference Track) */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-500">参照キーフレーム（Refトラックから）</span>
          <span className="text-[9px] text-amber-400">{modeLabel}</span>
        </div>

        {keyframes.length === 0 ? (
          <div className="border border-dashed border-zinc-700 rounded p-3 text-center">
            <p className="text-[10px] text-zinc-600">
              タイムラインに <span className="text-amber-400">+ Ref</span> トラックを追加し、<br />
              画像アセットをドロップしてください
            </p>
          </div>
        ) : (
          <div className="flex gap-3 flex-wrap py-1">
            {keyframes.map((kf, i) => (
              <KeyframePreview key={i} timeSec={kf.time_sec} asset={kf.asset} />
            ))}
          </div>
        )}
      </div>

      {/* Model */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">モデル</span>
        <select
          value={model}
          onChange={e => setModel(e.target.value)}
          className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700"
        >
          <option value="wan2.2-flf2v">Wan2.2 FLF2V（最初/最後フレーム・推奨）</option>
          <option value="wan2.2-fun-inp">Wan2.2 Fun-InP（最初/最後フレーム）</option>
          <option value="svd-xt">Stable Video Diffusion XT</option>
        </select>
      </label>

      {/* Wan2.2: motion prompt */}
      {isWan && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-500">プロンプト（動きの指示）</span>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2}
              placeholder="例: anime girl with red hair, smooth dynamic motion, camera pan"
              className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700 resize-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-500">ネガティブプロンプト</span>
            <input type="text" value={negPrompt} onChange={e => setNegPrompt(e.target.value)}
              placeholder="low quality, static, blurry"
              className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700"
            />
          </label>
        </>
      )}

      {/* Duration + FPS */}
      <div className="flex gap-2">
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-[10px] text-zinc-500">長さ（秒）</span>
          <input type="number" value={duration} onChange={e => setDuration(Number(e.target.value))}
            step={0.5} min={1} max={isWan ? 10 : 60}
            className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700 w-full"
          />
        </label>
        <label className="flex flex-col gap-1 w-16">
          <span className="text-[10px] text-zinc-500">FPS</span>
          <select value={fps} onChange={e => setFps(Number(e.target.value))}
            className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700"
          >
            {isWan && <option value={16}>16</option>}
            <option value={24}>24</option>
            <option value={30}>30</option>
          </select>
        </label>
      </div>

      {/* Wan2.2: resolution + Lightning */}
      {isWan && (
        <div className="flex gap-2 items-end">
          <label className="flex flex-col gap-1 flex-1">
            <span className="text-[10px] text-zinc-500">解像度</span>
            <select value={vres} onChange={e => setVres(e.target.value)}
              className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700"
            >
              <option value="832x480">832×480（16:9・高速）</option>
              <option value="1280x720">1280×720（16:9・高品質/低速）</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 pb-1.5 cursor-pointer">
            <input type="checkbox" checked={useLightning} onChange={e => setUseLightning(e.target.checked)}
              className="accent-amber-500" />
            <span className="text-[10px] text-zinc-400">Lightning高速化(4step)</span>
          </label>
        </div>
      )}

      {/* Motion strength (SVD only) */}
      {!isWan && (
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-zinc-500">モーション強度</span>
          <div className="flex items-center gap-2">
            <input type="range" min={0} max={1} step={0.05} value={strength}
              onChange={e => setStrength(Number(e.target.value))}
              className="flex-1 accent-amber-500"
            />
            <span className="text-xs text-zinc-300 w-8 text-right">{strength.toFixed(2)}</span>
          </div>
        </label>
      )}

      {/* Seed */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">シード（-1 = ランダム）</span>
        <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))}
          className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700 w-full"
        />
      </label>

      {error && <p className="text-[10px] text-red-400">{error}</p>}

      <button
        onClick={handleGenerate}
        disabled={busy || keyframes.length === 0}
        className="w-full py-2 rounded bg-amber-800 hover:bg-amber-700 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? '生成中…' : `▶ 生成する (${keyframes.length} keyframe)`}
      </button>
    </div>
  )
}
