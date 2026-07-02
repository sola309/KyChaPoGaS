// Music studio — a dedicated top-level tab for crafting songs from lyrics &
// melodic direction (was buried in the 生成 sub-tabs). Structure-tag builder,
// BPM/key/melody controls that compose the ACE-Step style prompt, and a list of
// the project's generated tracks with one-click placement onto an audio track.

import { useRef, useState } from 'react'
import type { Asset } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useJobStore } from '../../store/jobStore'
import { useProjectStore } from '../../store/projectStore'
import { useTimelineStore } from '../../store/timelineStore'

interface Props { assets: Asset[] }

const SECTIONS = ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'drop', 'outro']
const KEYS = ['', 'C major', 'A minor', 'G major', 'E minor', 'D major', 'B minor', 'F major', 'D minor']

export function MusicPanel({ assets }: Props) {
  const { activeProject } = useProjectStore()
  const { generateAudio } = useJobStore()
  const { placeClip } = useTimelineStore()

  const [style, setStyle] = useState('')
  const [melody, setMelody] = useState('')
  const [lyrics, setLyrics] = useState('')
  const [bpm, setBpm] = useState(128)
  const [musKey, setMusKey] = useState('')
  const [duration, setDuration] = useState(30)
  const [vocalLang, setVocalLang] = useState('ja')
  const [seed, setSeed] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const lyricsRef = useRef<HTMLTextAreaElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const hasVocals = lyrics.trim().length > 0
  const fps = activeProject?.fps ?? 30

  // this project's music/audio assets, newest first
  const tracks = assets
    .filter(a => a.asset_type === 'audio' || (a.asset_type === 'generated' && a.duration_sec != null && /wav|mp3|音|music|song/i.test(a.name)))
    .filter(a => a.asset_type === 'audio' || a.name.toLowerCase().includes('.wav') || a.name.toLowerCase().includes('music'))
    .sort((a, b) => b.id - a.id)

  const insertSection = (s: string) => {
    const ta = lyricsRef.current
    const tag = `[${s}]\n`
    if (!ta) { setLyrics(l => l + (l && !l.endsWith('\n') ? '\n' : '') + tag); return }
    const start = ta.selectionStart ?? lyrics.length
    setLyrics(lyrics.slice(0, start) + tag + lyrics.slice(start))
    requestAnimationFrame(() => { ta.focus(); const p = start + tag.length; ta.setSelectionRange(p, p) })
  }

  const composedPrompt = () => {
    const bits = [style.trim()]
    if (musKey) bits.push(`key of ${musKey}`)
    bits.push(`${bpm} bpm`)
    if (melody.trim()) bits.push(melody.trim())
    return bits.filter(Boolean).join(', ')
  }

  const handleGenerate = async () => {
    if (!activeProject || !style.trim() || busy) return
    setBusy(true); setError(null)
    try {
      await generateAudio({
        project_id: activeProject.id,
        prompt: composedPrompt(),
        lyrics: lyrics.trim(),
        duration_sec: duration,
        vocal_language: vocalLang,
        instrumental: hasVocals ? false : null,
        model: 'acestep-v15', seed,
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成エラー')
    } finally { setBusy(false) }
  }

  const togglePlay = (a: Asset) => {
    const el = audioRef.current; if (!el) return
    if (playing === a.id) { el.pause(); setPlaying(null); return }
    el.src = assetsApi.fileUrl(a.id); el.play().catch(() => {}); setPlaying(a.id)
  }

  const place = async (a: Asset) => {
    if (!activeProject) return
    const frames = Math.max(1, Math.round((a.duration_sec ?? duration) * fps))
    await placeClip(activeProject.id, 'audio', a.id, frames, 0)
  }

  return (
    <div className="h-full overflow-y-auto p-3 flex flex-col gap-3 text-zinc-200">
      <p className="text-[10px] text-zinc-500 leading-tight">
        歌詞とスタイル・メロディーの指示から曲を作ります。ボーカルは歌詞があれば自動でON。
      </p>

      {/* Style + melody direction */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">スタイル（ジャンル・雰囲気・声質）</span>
        <textarea value={style} onChange={e => setStyle(e.target.value)} rows={2}
          placeholder="emotional anime pop, bright female vocal, city-pop guitars ..."
          className="bg-zinc-800 text-xs rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-green-600" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">メロディー／展開の指示</span>
        <textarea value={melody} onChange={e => setMelody(e.target.value)} rows={2}
          placeholder="soft verse, big soaring chorus, key change on last chorus, half-time bridge ..."
          className="bg-zinc-800 text-xs rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-green-600" />
      </label>

      {/* BPM + key */}
      <div className="flex gap-2">
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-[10px] text-zinc-500">BPM <span className="text-zinc-400">{bpm}</span></span>
          <input type="range" min={60} max={200} step={1} value={bpm}
            onChange={e => setBpm(Number(e.target.value))} className="accent-green-500" />
        </label>
        <label className="flex flex-col gap-1 w-28">
          <span className="text-[10px] text-zinc-500">キー</span>
          <select value={musKey} onChange={e => setMusKey(e.target.value)}
            className="bg-zinc-800 text-xs rounded px-2 py-1.5 outline-none border border-zinc-700">
            {KEYS.map(k => <option key={k} value={k}>{k || '指定なし'}</option>)}
          </select>
        </label>
      </div>

      {/* Lyrics builder */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-500">歌詞</span>
          <span className={`text-[9px] ${hasVocals ? 'text-green-400' : 'text-zinc-600'}`}>
            {hasVocals ? '🎤 ボーカルあり' : 'インスト'}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {SECTIONS.map(s => (
            <button key={s} onClick={() => insertSection(s)}
              className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700">
              +{s}
            </button>
          ))}
        </div>
        <textarea ref={lyricsRef} value={lyrics} onChange={e => setLyrics(e.target.value)} rows={6}
          placeholder={'[verse]\n夜を駆け抜けて\n\n[chorus]\nこのまま どこまでも'}
          className="bg-zinc-800 text-xs rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-green-600 font-mono" />
      </div>

      {/* Duration / lang / seed */}
      <div className="flex gap-2 items-end">
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-[10px] text-zinc-500">長さ <span className="text-zinc-400">{duration}s</span></span>
          <input type="range" min={5} max={240} step={5} value={duration}
            onChange={e => setDuration(Number(e.target.value))} className="accent-green-500" />
        </label>
        <label className="flex flex-col gap-1 w-20">
          <span className="text-[10px] text-zinc-500">言語</span>
          <select value={vocalLang} onChange={e => setVocalLang(e.target.value)}
            className="bg-zinc-800 text-xs rounded px-2 py-1.5 outline-none border border-zinc-700">
            <option value="ja">日本語</option><option value="en">EN</option>
            <option value="zh">中文</option><option value="ko">한국</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 w-16">
          <span className="text-[10px] text-zinc-500">シード</span>
          <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))}
            className="bg-zinc-800 text-xs rounded px-2 py-1.5 outline-none border border-zinc-700 w-full" />
        </label>
      </div>

      {error && <p className="text-[10px] text-red-400">{error}</p>}

      <button onClick={handleGenerate} disabled={busy || !style.trim()}
        className="w-full py-2 rounded bg-green-800 hover:bg-green-700 text-white text-sm font-medium disabled:opacity-40 transition-colors">
        {busy ? '生成中…' : '▶ 曲を生成'}
      </button>

      {/* Generated tracks */}
      {tracks.length > 0 && (
        <div className="border-t border-zinc-800 pt-2">
          <span className="text-[10px] text-zinc-500">この作品の曲</span>
          <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />
          <div className="mt-1 space-y-1">
            {tracks.map(a => (
              <div key={a.id} className="flex items-center gap-2 text-[10px] bg-zinc-800/40 rounded px-2 py-1">
                <button onClick={() => togglePlay(a)} className="text-zinc-300 hover:text-white w-4">
                  {playing === a.id ? '⏸' : '▶'}
                </button>
                <span className="flex-1 truncate" title={a.name}>{a.name}</span>
                {a.duration_sec != null && <span className="text-zinc-600 tabular-nums">{Math.round(a.duration_sec)}s</span>}
                <button onClick={() => place(a)} className="text-emerald-400 hover:text-emerald-300 flex-shrink-0"
                  title="タイムラインの音声トラックに配置">＋TL</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
