import { useEffect, useRef, useState } from 'react'
import { api, assetsApi, type Asset } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import { useTimelineStore } from '../../store/timelineStore'
import { PreviewPlayer } from '../Preview/PreviewPlayer'

// AI対話メインのUIモード。
// 左=チャット(タイムライン編集ツール25種を持つLLM)、右=プレビュー。
// 通常編集UI(🎬編集)は従来どおり — ここは「話して作る」ための画面。

interface Msg {
  role: 'user' | 'assistant'
  content: string
  actions?: { tool: string; input: Record<string, unknown> }[]
}

export function AiModeView() {
  const { projects, activeProject, setActiveProject, fetchProjects } = useProjectStore()
  const loadTimeline = useTimelineStore(s => s.loadTimeline)
  const [assets, setAssets] = useState<Asset[]>([])
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (!projects.length) fetchProjects() }, [])
  useEffect(() => {
    if (activeProject) assetsApi.list(activeProject.id).then(setAssets)
    else setAssets([])
  }, [activeProject?.id])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, busy])

  const send = async () => {
    const text = input.trim()
    if (!text || busy || !activeProject) return
    setInput('')
    const history = msgs.map(m => ({ role: m.role, content: m.content }))
    setMsgs(m => [...m, { role: 'user', content: text }])
    setBusy(true)
    try {
      const r = await api.post('/llm/chat', {
        project_id: activeProject.id, message: text, history,
      })
      setMsgs(m => [...m, { role: 'assistant', content: r.data.reply, actions: r.data.actions }])
      // 編集ツールが動いた可能性があるのでタイムラインを再読込 → プレビューに即反映
      if (r.data.actions?.length) { await loadTimeline(activeProject.id, activeProject.fps); assetsApi.list(activeProject.id).then(setAssets) }
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setMsgs(m => [...m, { role: 'assistant',
        content: `⚠ ${detail || (e instanceof Error ? e.message : 'エラー')}` }])
    } finally { setBusy(false) }
  }

  const QUICK = [
    'いまのタイムラインの状態を教えて',
    'ビートに合わせてカットを整えて',
    '音ハメスコアを確認して',
    'サビの位置にフラッシュを撒いて',
  ]

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左: チャット */}
      <div className="w-[44%] min-w-[380px] flex flex-col border-r border-zinc-800">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
          <span className="text-xs text-purple-300 font-medium">🤖 AIディレクター</span>
          <select
            value={activeProject?.id ?? ''}
            onChange={e => {
              const p = projects.find(pp => pp.id === Number(e.target.value))
              if (p) { setActiveProject(p); loadTimeline(p.id, p.fps); setMsgs([]) }
            }}
            className="ml-auto bg-zinc-800 text-[11px] text-zinc-200 rounded px-2 py-1 outline-none border border-zinc-700 max-w-[220px]">
            <option value="">— プロジェクト —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2">
          {msgs.length === 0 && (
            <div className="text-[11px] text-zinc-500 leading-relaxed mt-4">
              タイムライン編集・解析・生成ジョブをすべて言葉で指示できます。<br />
              例:「ビート解析して、ダウンビートでカットして」「s04のショットをもっと暗く」<br /><br />
              <span className="text-zinc-600">クイック:</span>
              <div className="flex flex-col gap-1 mt-1">
                {QUICK.map(q => (
                  <button key={q} onClick={() => setInput(q)}
                    className="text-left text-[11px] text-purple-300/80 hover:text-purple-200 bg-zinc-900 rounded px-2 py-1.5">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`max-w-[92%] rounded-lg px-3 py-2 text-[12px] whitespace-pre-wrap leading-relaxed ${
              m.role === 'user' ? 'self-end bg-purple-900/60 text-purple-50'
                                : 'self-start bg-zinc-800 text-zinc-100'}`}>
              {m.content}
              {m.actions && m.actions.length > 0 && (
                <div className="mt-1.5 pt-1.5 border-t border-zinc-700 flex flex-col gap-0.5">
                  {m.actions.map((a, j) => (
                    <span key={j} className="text-[10px] font-mono text-emerald-300/90">
                      ⚙ {a.tool}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="self-start text-[11px] text-zinc-500 animate-pulse">考え中…（ツール実行を含むことがあります）</div>}
          <div ref={bottomRef} />
        </div>

        <div className="p-2 border-t border-zinc-800 flex gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            rows={2}
            placeholder={activeProject ? '指示を入力（Enterで送信 / Shift+Enterで改行）' : 'まずプロジェクトを選択'}
            className="flex-1 bg-zinc-900 text-[12px] text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-purple-500"
          />
          <button onClick={send} disabled={busy || !input.trim() || !activeProject}
            className="px-3 rounded bg-purple-700 hover:bg-purple-600 text-white text-sm disabled:opacity-40">
            ➤
          </button>
        </div>
      </div>

      {/* 右: プレビュー(編集モードと同じコンポーネント — AIの編集が即映る) */}
      <div className="flex-1 min-w-0 flex flex-col">
        {activeProject
          ? <PreviewPlayer assets={assets} />
          : <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">プロジェクトを選択してください</div>}
      </div>
    </div>
  )
}
