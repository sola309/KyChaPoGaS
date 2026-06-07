import { useState } from 'react'
import { useJobStore } from '../../../store/jobStore'
import { useProjectStore } from '../../../store/projectStore'

export function AudioGenPanel() {
  const { activeProject } = useProjectStore()
  const { generateAudio } = useJobStore()

  const [prompt,   setPrompt]   = useState('')
  const [lyrics,   setLyrics]   = useState('')
  const [duration, setDuration] = useState(30)
  const [vocalLang, setVocalLang] = useState('ja')
  const [model,    setModel]    = useState('acestep-v15')
  const [seed,     setSeed]     = useState(-1)
  const [busy,     setBusy]     = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const hasVocals = lyrics.trim().length > 0

  const handleGenerate = async () => {
    if (!activeProject || !prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await generateAudio({
        project_id: activeProject.id,
        prompt: prompt.trim(),
        lyrics: lyrics.trim(),
        duration_sec: duration,
        vocal_language: vocalLang,
        instrumental: hasVocals ? false : null,
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
        <span className="text-[10px] text-zinc-500">スタイル（ジャンル・雰囲気・BPMなど）</span>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={2}
          placeholder="upbeat anime pop, female vocal, 128bpm, energetic ..."
          className="bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-green-600"
        />
      </label>

      <label className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-500">歌詞（[verse]/[chorus] 等で構成）</span>
          <span className={`text-[9px] ${hasVocals ? 'text-green-400' : 'text-zinc-600'}`}>
            {hasVocals ? '🎤 ボーカルあり' : 'インストゥルメンタル'}
          </span>
        </div>
        <textarea
          value={lyrics}
          onChange={e => setLyrics(e.target.value)}
          rows={4}
          placeholder={'[verse]\n夜を駆け抜けて\n...\n[chorus]\nこのまま どこまでも'}
          className="bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-green-600 font-mono"
        />
      </label>

      <div className="flex gap-2">
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-[10px] text-zinc-500">モデル</span>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700"
          >
            <option value="acestep-v15">ACE-Step 1.5（ボーカル対応）</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 w-24">
          <span className="text-[10px] text-zinc-500">ボーカル言語</span>
          <select
            value={vocalLang}
            onChange={e => setVocalLang(e.target.value)}
            className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700"
          >
            <option value="ja">日本語</option>
            <option value="en">English</option>
            <option value="zh">中文</option>
            <option value="ko">한국어</option>
          </select>
        </label>
      </div>

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
