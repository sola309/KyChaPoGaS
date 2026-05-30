import { useState } from 'react'
import { useJobStore } from '../../../store/jobStore'
import { useProjectStore } from '../../../store/projectStore'

export function AudioGenPanel() {
  const { activeProject } = useProjectStore()
  const { generateAudio } = useJobStore()

  const [prompt,   setPrompt]   = useState('')
  const [duration, setDuration] = useState(30)
  const [model,    setModel]    = useState('musicgen-small')
  const [seed,     setSeed]     = useState(-1)
  const [busy,     setBusy]     = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const handleGenerate = async () => {
    if (!activeProject || !prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await generateAudio({
        project_id: activeProject.id,
        prompt: prompt.trim(),
        duration_sec: duration,
        model, seed,
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成エラー')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">プロンプト</span>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={3}
          placeholder="upbeat electronic, 128bpm, anime opening ..."
          className="bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-green-600"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">モデル</span>
        <select
          value={model}
          onChange={e => setModel(e.target.value)}
          className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700"
        >
          <option value="musicgen-small">MusicGen Small（高速）</option>
          <option value="musicgen-medium">MusicGen Medium</option>
          <option value="musicgen-large">MusicGen Large（高品質）</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">長さ（秒）</span>
        <div className="flex items-center gap-2">
          <input
            type="range" min={5} max={120} step={5} value={duration}
            onChange={e => setDuration(Number(e.target.value))}
            className="flex-1 accent-green-500"
          />
          <span className="text-xs text-zinc-300 w-10 text-right">{duration}s</span>
        </div>
      </label>

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
        className="w-full py-2 rounded bg-green-800 hover:bg-green-700 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? '生成中…' : '▶ 生成する'}
      </button>
    </div>
  )
}
