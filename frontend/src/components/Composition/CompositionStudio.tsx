import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useUIStore } from '../../store/uiStore'

/**
 * 📝 構成スタジオ — MADの構成(セクション割り・盛り上がり曲線・歌詞・映像意図)を
 * 対話で詰める上流ワークスペース。構成シートは曲(音楽タブ)とshotlist(編集)の
 * 共通の設計図になる。将来はブログ等の文章にも拡張予定。
 */

interface Section {
  tag: string; name: string; bars: number; energy: number
  mood: string; visual: string; lyrics: string
}
interface Sheet {
  format_version: number; title: string; concept: string
  bpm_target: number | null; sections: Section[]
}
interface Msg { role: 'user' | 'assistant'; content: string }

const EMPTY: Sheet = { format_version: 1, title: '', concept: '', bpm_target: 120, sections: [] }
const TAGS = ['[intro]', '[verse]', '[pre-chorus]', '[chorus]', '[bridge]', '[breakdown]', '[outro]']

export function CompositionStudio() {
  const pushToast = useUIStore(s => s.pushToast)
  const setMusicDraft = useUIStore(s => s.setMusicDraft)
  const [list, setList] = useState<Array<{ id: string; title: string; sections: number }>>([])
  const [cid, setCid] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>(EMPTY)
  const [dirty, setDirty] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [chatIn, setChatIn] = useState('')
  const [busy, setBusy] = useState(false)
  const [songs, setSongs] = useState<Array<{ id: number; name: string }>>([])
  const [songSel, setSongSel] = useState<number | null>(null)
  const [modal, setModal] = useState<string | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)

  const loadList = useCallback(async () => {
    const r = await api.get('/music/compositions'); setList(r.data)
    const sg = await api.get('/music/songs')
    setSongs(sg.data.songs); if (sg.data.songs[0]) setSongSel(sg.data.songs[0].id)
  }, [])
  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  async function open(id: string) {
    const r = await api.get(`/music/compositions/${id}`)
    setCid(id); setSheet({ ...EMPTY, ...r.data }); setDirty(false); setMsgs([])
  }
  function createNew() {
    const id = `comp_${Date.now().toString(36)}`
    setCid(id)
    setSheet({ ...EMPTY, title: '新しい構成', sections: [
      { tag: '[intro]', name: 'イントロ', bars: 8, energy: 0.3, mood: '', visual: 'MGイントロ', lyrics: '' },
      { tag: '[verse]', name: 'Aメロ', bars: 8, energy: 0.45, mood: '', visual: 'キャラ紹介', lyrics: '' },
      { tag: '[chorus]', name: 'サビ', bars: 8, energy: 0.85, mood: '', visual: 'ピークMG', lyrics: '' },
      { tag: '[outro]', name: 'アウトロ', bars: 4, energy: 0.35, mood: '', visual: 'クレジット', lyrics: '' },
    ] })
    setDirty(true); setMsgs([])
  }
  async function save() {
    if (!cid) return
    await api.put(`/music/compositions/${cid}`, sheet)
    setDirty(false); void loadList(); pushToast('構成シートを保存しました', 'success')
  }
  function patch(p: Partial<Sheet>) { setSheet(s => ({ ...s, ...p })); setDirty(true) }
  function patchSec(i: number, p: Partial<Section>) {
    setSheet(s => ({ ...s, sections: s.sections.map((x, k) => k === i ? { ...x, ...p } : x) })); setDirty(true)
  }

  async function send() {
    if (!chatIn.trim() || busy) return
    const ctx = `現在の構成シート:\n${JSON.stringify(sheet)}\n\n${chatIn}`
    const next: Msg[] = [...msgs, { role: 'user', content: chatIn }]
    setMsgs(next); setChatIn(''); setBusy(true)
    try {
      const r = await api.post('/music/chat', {
        messages: [...msgs, { role: 'user', content: ctx }] })
      setMsgs([...next, { role: 'assistant', content: r.data.reply }])
      if (r.data.sheet) {
        setSheet(s => ({ ...s, ...r.data.sheet })); setDirty(true)
        pushToast('AIが構成シートを更新しました(要保存)', 'info')
      }
    } catch { pushToast('AI応答に失敗', 'error') } finally { setBusy(false) }
  }

  async function derive() {
    if (!cid) return
    await save()
    const r = await api.post(`/music/compositions/${cid}/derive`)
    setMusicDraft(r.data)
    pushToast('🎵 音楽タブのフォームに展開しました(タブを切り替えてください)', 'success')
  }
  async function verify() {
    if (!cid || !songSel) return
    await save()
    const r = await api.post(`/music/compositions/${cid}/verify/${songSel}`)
    const rows = r.data.sections.map((s: Record<string, unknown>) =>
      `${s.ok ? '✅' : '⚠️'} ${s.name} ${s.t0}-${s.t1}s 想定${s.want_energy ?? '-'} 実測${s.measured_energy ?? '-'}`).join('\n')
    setModal(`曲との突き合わせ (song #${songSel})\n実測BPM ${r.data.bpm_measured} / 実測${r.data.duration_measured}s / 想定${r.data.duration_planned}s\nズレ ${r.data.mismatches}件\n\n${rows}\n\n${r.data.hint}`)
  }
  async function toShotlist() {
    if (!cid || !songSel) return
    await save()
    const r = await api.post(`/music/compositions/${cid}/to_shotlist/${songSel}`)
    setModal('shotlist雛形(コピーして使用 / AIに肉付け依頼可):\n\n' + JSON.stringify(r.data, null, 2))
  }

  const totalBars = sheet.sections.reduce((a, s) => a + (s.bars || 0), 0)
  const barSec = sheet.bpm_target ? 240 / sheet.bpm_target : 2
  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0 text-sm overflow-y-auto lg:overflow-hidden">
      {/* 左: シート一覧 */}
      <div className="w-full lg:w-56 border-b lg:border-b-0 lg:border-r border-zinc-800 flex flex-col max-h-[30vh] lg:max-h-none flex-shrink-0 lg:flex-shrink">
        <div className="px-3 py-2 border-b border-zinc-800 flex items-center">
          <span className="text-zinc-300 font-bold">構成シート</span>
          <button onClick={createNew} className="ml-auto text-zinc-400 hover:text-white text-lg" title="新規">+</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {list.map(c => (
            <button key={c.id} onClick={() => void open(c.id)}
              className={`w-full text-left px-2 py-1.5 rounded text-[13px] ${cid === c.id ? 'bg-purple-900/50' : 'hover:bg-zinc-800'}`}>
              {c.title} <span className="text-zinc-600">({c.sections})</span>
            </button>
          ))}
        </div>
      </div>

      {/* 中: シートエディタ */}
      <div className="flex-1 lg:border-r border-zinc-800 lg:overflow-y-auto p-4 space-y-3 min-w-0">
        {!cid ? (
          <div className="text-zinc-500 text-xs mt-8 text-center">左の「+」で新規作成、または既存シートを選択</div>
        ) : (
          <>
            <div className="flex gap-3 items-center">
              <input value={sheet.title} onChange={e => patch({ title: e.target.value })}
                placeholder="タイトル" className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 font-bold" />
              <label className="text-xs text-zinc-400">BPM
                <input type="number" value={sheet.bpm_target ?? ''} onChange={e => patch({ bpm_target: Number(e.target.value) || null })}
                  className="ml-1 w-20 bg-zinc-900 border border-zinc-700 rounded px-2 py-2" />
              </label>
              <button onClick={() => void save()} disabled={!dirty}
                className="px-4 py-2 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 font-bold">保存</button>
            </div>
            <textarea value={sheet.concept} onChange={e => patch({ concept: e.target.value })}
              placeholder="コンセプト(スタイル記述 / 英語推奨)" rows={2}
              className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-[13px]" />
            {/* energy curve preview */}
            <div className="flex items-end h-14 gap-0.5 bg-zinc-900/60 rounded p-1.5">
              {sheet.sections.map((s, i) => (
                <div key={i} title={`${s.name} ${s.bars}小節`} style={{ flex: s.bars, height: `${8 + s.energy * 92}%` }}
                  className="bg-gradient-to-t from-pink-700 to-pink-400 rounded-sm min-w-2" />
              ))}
            </div>
            <div className="text-[11px] text-zinc-500">
              計 {totalBars}小節 ≈ {(totalBars * barSec).toFixed(0)}秒 (BPM {sheet.bpm_target ?? '?'})
            </div>
            {/* sections */}
            {sheet.sections.map((s, i) => (
              <div key={i} className="border border-zinc-800 rounded-lg p-2.5 space-y-1.5 bg-zinc-900/40">
                <div className="flex gap-2 items-center">
                  <select value={s.tag} onChange={e => patchSec(i, { tag: e.target.value })}
                    className="bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-xs">
                    {TAGS.map(t => <option key={t}>{t}</option>)}
                  </select>
                  <input value={s.name} onChange={e => patchSec(i, { name: e.target.value })}
                    className="w-28 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs" />
                  <label className="text-[11px] text-zinc-500">小節
                    <input type="number" value={s.bars} onChange={e => patchSec(i, { bars: Number(e.target.value) })}
                      className="ml-1 w-14 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-xs" />
                  </label>
                  <label className="text-[11px] text-zinc-500 flex items-center gap-1 flex-1">盛り上がり
                    <input type="range" min={0} max={1} step={0.05} value={s.energy}
                      onChange={e => patchSec(i, { energy: Number(e.target.value) })} className="flex-1 accent-pink-500" />
                    <span className="w-8 text-right">{s.energy.toFixed(2)}</span>
                  </label>
                  <button onClick={() => { setSheet(sh => ({ ...sh, sections: sh.sections.filter((_, k) => k !== i) })); setDirty(true) }}
                    className="text-zinc-600 hover:text-red-400">✕</button>
                </div>
                <div className="flex gap-2">
                  <input value={s.mood} onChange={e => patchSec(i, { mood: e.target.value })}
                    placeholder="ムード(英語: driving guitar, soft piano…)"
                    className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs" />
                  <input value={s.visual} onChange={e => patchSec(i, { visual: e.target.value })}
                    placeholder="映像の意図(キャラ紹介 / ピークMG…)"
                    className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs" />
                </div>
                <textarea value={s.lyrics} onChange={e => patchSec(i, { lyrics: e.target.value })}
                  placeholder="歌詞(未定なら空)" rows={2}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-xs font-mono" />
              </div>
            ))}
            <button onClick={() => { setSheet(sh => ({ ...sh, sections: [...sh.sections, { tag: '[verse]', name: '新セクション', bars: 8, energy: 0.5, mood: '', visual: '', lyrics: '' }] })); setDirty(true) }}
              className="w-full py-1.5 rounded border border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-300">＋ セクション追加</button>
            {/* actions */}
            <div className="flex gap-2 items-center pt-2 border-t border-zinc-800">
              <button onClick={() => void derive()} className="px-3 py-1.5 rounded bg-pink-700 hover:bg-pink-600 text-xs font-bold">🎵 音楽タブへ展開</button>
              <select value={songSel ?? ''} onChange={e => setSongSel(Number(e.target.value))}
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs">
                {songs.map(s => <option key={s.id} value={s.id}>song #{s.id}</option>)}
              </select>
              <button onClick={() => void verify()} disabled={!songSel} className="px-3 py-1.5 rounded bg-sky-800 hover:bg-sky-700 disabled:opacity-40 text-xs">🔍 曲とのズレ検証</button>
              <button onClick={() => void toShotlist()} disabled={!songSel} className="px-3 py-1.5 rounded bg-emerald-800 hover:bg-emerald-700 disabled:opacity-40 text-xs">🎬 shotlist雛形</button>
            </div>
          </>
        )}
      </div>

      {/* 右: 構成作家AI */}
      <div className="w-full lg:w-96 border-t lg:border-t-0 border-zinc-800 flex flex-col min-h-0 max-h-[45vh] lg:max-h-none flex-shrink-0 lg:flex-shrink">
        <div className="px-3 py-2 border-b border-zinc-800 text-zinc-300 font-bold">✍️ 構成作家AI</div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {!msgs.length && (
            <div className="text-xs text-zinc-500 leading-relaxed">
              現在のシートを踏まえて相談できます。例:<br />
              「サビ前にブレイクを入れて緩急をつけたい」<br />
              「Aメロの歌詞を書いて。りんごと放課後がモチーフ」<br />
              AIの構成更新は自動でシートに反映されます(要保存)。
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`rounded-lg p-2.5 whitespace-pre-wrap text-[13px] leading-relaxed ${
              m.role === 'user' ? 'bg-purple-900/40 ml-6' : 'bg-zinc-800/80 mr-6'}`}>
              {m.content.replace(/```(comp|song)[\s\S]*?```/g, '(シート更新)').trim()}
            </div>
          ))}
          {busy && <div className="text-xs text-zinc-500 animate-pulse">考え中…</div>}
          <div ref={chatEnd} />
        </div>
        <div className="p-2 border-t border-zinc-800 flex gap-2">
          <input value={chatIn} onChange={e => setChatIn(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send() }}
            placeholder="構成について相談…" disabled={!cid}
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 disabled:opacity-40" />
          <button onClick={() => void send()} disabled={busy || !cid}
            className="px-3 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40">送信</button>
        </div>
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-8" onClick={() => setModal(null)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-3xl max-h-[80vh] overflow-y-auto p-6 whitespace-pre-wrap text-[12px] font-mono leading-relaxed"
            onClick={e => e.stopPropagation()}>{modal}</div>
        </div>
      )}
    </div>
  )
}
