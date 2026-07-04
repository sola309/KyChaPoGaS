import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useUIStore } from '../../store/uiStore'

/**
 * 🎵 音楽スタジオ — MADの選曲を対話で詰めるワークベンチ。
 *  左: 音楽ディレクターAI(曲調/歌詞/BPMの相談 → ワンクリックでフォームへ)
 *  中: 生成フォーム(ACE-Step 1.5 — BPM/キーのピン留め対応)+ 実行中ジョブ
 *  右: 曲ライブラリ(試聴 / BPM・音の取りやすさ等の解析バッジ / MAD構成案)
 */

interface Song {
  id: number; name: string; duration_sec: number | null; created_at: string | null
  lyrics?: string; caption?: string; bpm?: number | null; key?: string | null; seed?: number | null
  analysis: null | { bpm: number; toriyasusa: number; beat_stability_cv: number
    energy_contrast: number; punch: number; sections: Array<{ t0: number; t1: number; energy: number }> }
}
interface Msg { role: 'user' | 'assistant'; content: string }
interface Proposal { caption?: string; lyrics?: string; bpm?: number; duration_sec?: number }

export function MusicStudio() {
  const pushToast = useUIStore(s => s.pushToast)
  const musicDraft = useUIStore(s => s.musicDraft)
  const setMusicDraft = useUIStore(s => s.setMusicDraft)
  const [songs, setSongs] = useState<Song[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  const [jobs, setJobs] = useState<Array<Record<string, unknown>>>([])
  // form
  const [caption, setCaption] = useState('up-tempo J-pop idol anime song, cute energetic female vocal, bright sparkling synth, four-on-the-floor kick, catchy melodic chorus, clean mix')
  const [lyrics, setLyrics] = useState('')
  const [bpm, setBpm] = useState<string>('')
  const [duration, setDuration] = useState(104)
  const [variants, setVariants] = useState(2)
  const [instrumental, setInstrumental] = useState(false)
  // chat
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [chatIn, setChatIn] = useState('')
  const [busy, setBusy] = useState(false)
  const [planMd, setPlanMd] = useState<string | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const r = await api.get('/music/songs')
    setSongs(r.data.songs); setProjectId(r.data.project_id)
    if (r.data.project_id) {
      const j = await api.get(`/jobs/?project_id=${r.data.project_id}`)
      setJobs(j.data.filter((x: Record<string, unknown>) =>
        x.status === 'pending' || x.status === 'running'))
    }
  }, [])
  useEffect(() => { void load() }, [load])
  // 構成タブからの展開を受け取る
  useEffect(() => {
    if (!musicDraft) return
    if (musicDraft.caption) setCaption(musicDraft.caption)
    if (musicDraft.lyrics) setLyrics(musicDraft.lyrics)
    if (musicDraft.bpm) setBpm(String(musicDraft.bpm))
    if (musicDraft.duration_sec) setDuration(musicDraft.duration_sec)
    setMusicDraft(null)
    pushToast('構成シートから生成条件を展開しました', 'success')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicDraft])
  useEffect(() => {
    const t = setInterval(() => { void load() }, 4000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  async function send() {
    if (!chatIn.trim() || busy) return
    const next: Msg[] = [...msgs, { role: 'user', content: chatIn }]
    setMsgs(next); setChatIn(''); setBusy(true)
    try {
      const r = await api.post('/music/chat', { messages: next })
      setMsgs([...next, { role: 'assistant', content: r.data.reply }])
      if (r.data.proposal) applyProposal(r.data.proposal, false)
    } catch { pushToast('AI応答に失敗', 'error') } finally { setBusy(false) }
  }

  function applyProposal(p: Proposal, toast = true) {
    if (p.caption) setCaption(p.caption)
    if (p.lyrics) setLyrics(p.lyrics)
    if (p.bpm) setBpm(String(p.bpm))
    if (p.duration_sec) setDuration(p.duration_sec)
    if (toast) pushToast('提案をフォームへ反映しました', 'success')
  }

  /** assistantメッセージから ```song ブロックを拾う(手動反映ボタン用) */
  function proposalOf(content: string): Proposal | null {
    if (!content.includes('```song')) return null
    try {
      const frag = content.split('```song')[1].split('```')[0]
      return JSON.parse(frag.slice(frag.indexOf('{'), frag.lastIndexOf('}') + 1))
    } catch { return null }
  }

  async function generate() {
    setBusy(true)
    try {
      await api.post('/music/generate', {
        caption, lyrics, duration_sec: duration, vocal_language: 'ja',
        instrumental: instrumental || (lyrics.trim() ? null : true),
        bpm: bpm ? Number(bpm) : null, variants,
      })
      pushToast(`${variants}バリエーションの生成を開始しました`, 'success')
      void load()
    } catch { pushToast('生成の投入に失敗', 'error') } finally { setBusy(false) }
  }

  async function analyzeSong(id: number) {
    setBusy(true)
    try { await api.post(`/music/songs/${id}/analyze`); void load() }
    catch { pushToast('解析に失敗', 'error') } finally { setBusy(false) }
  }

  async function planSong(id: number) {
    setBusy(true); setPlanMd('構成案を作成中…')
    try { const r = await api.post(`/music/songs/${id}/plan`); setPlanMd(r.data.plan_md) }
    catch { setPlanMd(null); pushToast('構成案の作成に失敗', 'error') } finally { setBusy(false) }
  }

  const scoreColor = (v: number) => v >= 70 ? 'text-emerald-400' : v >= 45 ? 'text-amber-400' : 'text-red-400'

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0 text-sm overflow-y-auto lg:overflow-hidden">
      {/* ── 左: 音楽ディレクターAI ── */}
      <div className="w-full lg:w-96 border-b lg:border-b-0 lg:border-r border-zinc-800 flex flex-col min-h-0 max-h-[45vh] lg:max-h-none flex-shrink-0 lg:flex-shrink">
        <div className="px-3 py-2 border-b border-zinc-800 text-zinc-300 font-bold">🎼 音楽ディレクター</div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {!msgs.length && (
            <div className="text-xs text-zinc-500 leading-relaxed">
              曲の方向性を相談してください。例:<br />
              「疾走感のあるロック寄りで、サビで転調する曲」<br />
              「しっとり始まってラスサビで爆発する構成」<br />
              提案がまとまると「フォームへ反映」できます。
            </div>
          )}
          {msgs.map((m, i) => {
            const prop = m.role === 'assistant' ? proposalOf(m.content) : null
            return (
              <div key={i} className={`rounded-lg p-2.5 whitespace-pre-wrap text-[13px] leading-relaxed ${
                m.role === 'user' ? 'bg-purple-900/40 ml-6' : 'bg-zinc-800/80 mr-6'}`}>
                {m.content.replace(/```song[\s\S]*?```/g, '').trim()}
                {prop && (
                  <button onClick={() => applyProposal(prop)}
                    className="mt-2 block px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs">
                    ♪ この提案をフォームへ反映
                  </button>
                )}
              </div>
            )
          })}
          {busy && <div className="text-xs text-zinc-500 animate-pulse">考え中…</div>}
          <div ref={chatEnd} />
        </div>
        <div className="p-2 border-t border-zinc-800 flex gap-2">
          <input value={chatIn} onChange={e => setChatIn(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send() }}
            placeholder="曲について相談…"
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5" />
          <button onClick={() => void send()} disabled={busy}
            className="px-3 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40">送信</button>
        </div>
      </div>

      {/* ── 中: 生成フォーム ── */}
      <div className="w-full lg:w-[420px] border-b lg:border-b-0 lg:border-r border-zinc-800 flex flex-col lg:min-h-0 lg:overflow-y-auto p-3 gap-3 flex-shrink-0 lg:flex-shrink">
        <div className="text-zinc-300 font-bold">🎹 生成 (ACE-Step 1.5)</div>
        <label className="text-xs text-zinc-400">スタイル(caption / 英語)
          <textarea value={caption} onChange={e => setCaption(e.target.value)} rows={3}
            className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-[13px]" />
        </label>
        <label className="text-xs text-zinc-400">歌詞([verse][chorus]等の構造タグ推奨 / 空ならインスト)
          <textarea value={lyrics} onChange={e => setLyrics(e.target.value)} rows={10}
            placeholder={'[verse]\n...\n\n[chorus]\n...'}
            className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-[13px] font-mono" />
        </label>
        <div className="flex gap-3">
          <label className="text-xs text-zinc-400 flex-1">BPM(空=おまかせ)
            <input value={bpm} onChange={e => setBpm(e.target.value)} placeholder="120"
              className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-zinc-400 flex-1">長さ(秒)
            <input type="number" value={duration} onChange={e => setDuration(Number(e.target.value))}
              className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5" />
          </label>
          <label className="text-xs text-zinc-400 w-24">候補数
            <select value={variants} onChange={e => setVariants(Number(e.target.value))}
              className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5">
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <label className="text-xs text-zinc-400 flex items-center gap-2">
          <input type="checkbox" checked={instrumental} onChange={e => setInstrumental(e.target.checked)} />
          インストゥルメンタル(歌なし)
        </label>
        <button onClick={() => void generate()} disabled={busy}
          className="py-2 rounded bg-pink-700 hover:bg-pink-600 disabled:opacity-40 font-bold">
          ♪ {variants}バリエーション生成
        </button>
        {jobs.length > 0 && (
          <div className="text-xs text-zinc-400 border border-zinc-800 rounded p-2">
            {jobs.map(j => (
              <div key={String(j.id)} className="flex items-center gap-2 py-0.5">
                <span className="animate-pulse">⏳</span> job #{String(j.id)} {String(j.status)}
                <span className="ml-auto">{Math.round(Number(j.progress ?? 0) * 100)}%</span>
              </div>
            ))}
          </div>
        )}
        <div className="text-[11px] text-zinc-600 leading-relaxed">
          ヒント: ACE-Step 1.5 はBPM/キーのピン留め、部分修正(Repaint)、歌詞編集、参照曲ガイド(Audio2Audio)に対応。
          高度な編集はコメントでAIに依頼してください。
        </div>
      </div>

      {/* ── 右: 曲ライブラリ ── */}
      <div className="flex-1 flex flex-col lg:min-h-0 lg:overflow-y-auto p-3 gap-3">
        <div className="text-zinc-300 font-bold">📚 曲ライブラリ {projectId ? `(project ${projectId})` : ''}</div>
        {!songs.length && <div className="text-xs text-zinc-500">まだ曲がありません。左で相談 → 中央で生成。</div>}
        {songs.map(s => (
          <div key={s.id} className="border border-zinc-800 rounded-lg p-3 bg-zinc-900/60">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-bold text-zinc-200">#{s.id}</span>
              <span className="text-xs text-zinc-500">{s.created_at?.replace('T', ' ')}</span>
              <div className="flex-1" />
              {s.analysis ? (
                <span className="flex gap-2 text-xs">
                  <span className="px-2 py-0.5 rounded bg-zinc-800">BPM {s.analysis.bpm}</span>
                  <span className={`px-2 py-0.5 rounded bg-zinc-800 font-bold ${scoreColor(s.analysis.toriyasusa)}`}>
                    取りやすさ {s.analysis.toriyasusa}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-zinc-800">緩急 {s.analysis.energy_contrast}</span>
                </span>
              ) : (
                <button onClick={() => void analyzeSong(s.id)} disabled={busy}
                  className="px-2.5 py-1 rounded bg-sky-800 hover:bg-sky-700 text-xs">🔍 解析</button>
              )}
            </div>
            <audio controls preload="none" src={`/api/assets/${s.id}/file`} className="w-full h-9" />
            {s.lyrics && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200 select-none">
                  📝 歌詞 {s.key ? `· ${s.key}` : ''} {s.bpm ? `· ${s.bpm}bpm` : ''} {s.seed != null ? `· seed ${s.seed}` : ''}
                </summary>
                <pre className="mt-1 p-2 rounded bg-zinc-950 text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">{s.lyrics}</pre>
                <button onClick={() => setLyrics(s.lyrics ?? '')}
                  className="mt-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-purple-800 text-[11px]">↪ この歌詞をエディタへ(修正して再生成)</button>
              </details>
            )}
            {s.analysis && (
              <div className="mt-2 flex items-center gap-2">
                {/* energy bar (盛り上がりマップ) */}
                <div className="flex-1 flex h-3 rounded overflow-hidden bg-zinc-800">
                  {s.analysis.sections.map((sec, i) => (
                    <div key={i} title={`${sec.t0}-${sec.t1}s energy=${sec.energy}`}
                      style={{ flex: sec.t1 - sec.t0, opacity: 0.25 + sec.energy * 0.75 }}
                      className="bg-pink-500" />
                  ))}
                </div>
                <button onClick={() => void planSong(s.id)} disabled={busy}
                  className="px-2.5 py-1 rounded bg-emerald-800 hover:bg-emerald-700 text-xs">🎬 MAD構成案</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* plan modal */}
      {planMd && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-8"
          onClick={() => setPlanMd(null)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-3xl max-h-[80vh] overflow-y-auto p-6 whitespace-pre-wrap text-[13px] leading-relaxed"
            onClick={e => e.stopPropagation()}>
            {planMd}
          </div>
        </div>
      )}
    </div>
  )
}
