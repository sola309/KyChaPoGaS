import { useState } from 'react'
import { useJobStore } from '../../../store/jobStore'
import { useProjectStore } from '../../../store/projectStore'

export function ImageGenPanel() {
  const { activeProject } = useProjectStore()
  const { generateImage, comfyAvailable } = useJobStore()

  const [prompt,    setPrompt]    = useState('')
  const [negPrompt, setNegPrompt] = useState('')
  const [model,     setModel]     = useState('waiNSFWIllustrious_v170')
  const [width,     setWidth]     = useState(1344)   // SDXL 16:9 bucket (≈16:9)
  const [height,    setHeight]    = useState(768)
  const [seed,      setSeed]      = useState(-1)
  const [busy,      setBusy]      = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const handleGenerate = async () => {
    if (!activeProject || !prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await generateImage({
        project_id: activeProject.id,
        prompt: prompt.trim(),
        negative_prompt: negPrompt.trim(),
        model, width, height, seed,
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

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">プロンプト</span>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={3}
          placeholder="masterpiece, anime style, ..."
          className="bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-purple-500"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">ネガティブプロンプト</span>
        <textarea
          value={negPrompt}
          onChange={e => setNegPrompt(e.target.value)}
          rows={2}
          placeholder="low quality, blurry, ..."
          className="bg-zinc-800 text-xs text-zinc-500 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-zinc-500"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">モデル</span>
        <select
          value={model}
          onChange={e => setModel(e.target.value)}
          className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700"
        >
          <option value="waiNSFWIllustrious_v170">WAI Illustrious v17.0（アニメ）</option>
          <option value="sdxl-base">SDXL Base</option>
          <option value="flux-dev">FLUX.1 Dev（要DL）</option>
        </select>
      </label>

      <div className="flex gap-2">
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-[10px] text-zinc-500">幅</span>
          <input type="number" value={width} onChange={e => setWidth(Number(e.target.value))}
            step={64} min={256} max={2048}
            className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700 w-full"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-[10px] text-zinc-500">高さ</span>
          <input type="number" value={height} onChange={e => setHeight(Number(e.target.value))}
            step={64} min={256} max={2048}
            className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700 w-full"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">シード（-1 = ランダム）</span>
        <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))}
          className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700 w-full"
        />
      </label>

      {error && <p className="text-[10px] text-red-400">{error}</p>}

      <button
        onClick={handleGenerate}
        disabled={busy || !prompt.trim()}
        className="w-full py-2 rounded bg-purple-700 hover:bg-purple-600 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? '生成中…' : '▶ 生成する'}
      </button>
    </div>
  )
}
