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

  const [model,    setModel]    = useState('hunyuan-i2v')
  const [duration, setDuration] = useState(5.0)
  const [fps,      setFps]      = useState(24)
  const [strength, setStrength] = useState(0.6)
  const [seed,     setSeed]     = useState(-1)
  const [busy,     setBusy]     = useState(false)
  const [error,    setError]    = useState<string | null>(null)

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
    keyframes.length === 1 ? 'Single-frame I2V' :
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
          <option value="hunyuan-i2v">HunyuanVideo I2V</option>
          <option value="cogvideox-i2v">CogVideoX I2V</option>
          <option value="svd-xt">Stable Video Diffusion XT</option>
        </select>
      </label>

      {/* Duration + FPS */}
      <div className="flex gap-2">
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-[10px] text-zinc-500">長さ（秒）</span>
          <input type="number" value={duration} onChange={e => setDuration(Number(e.target.value))}
            step={0.5} min={1} max={60}
            className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700 w-full"
          />
        </label>
        <label className="flex flex-col gap-1 w-16">
          <span className="text-[10px] text-zinc-500">FPS</span>
          <select value={fps} onChange={e => setFps(Number(e.target.value))}
            className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700"
          >
            <option value={24}>24</option>
            <option value={30}>30</option>
          </select>
        </label>
      </div>

      {/* Motion strength */}
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
