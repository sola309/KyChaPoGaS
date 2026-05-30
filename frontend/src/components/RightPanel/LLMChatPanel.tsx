import { useEffect, useRef, useState } from 'react'
import { useLLMStore, type ChatEntry } from '../../store/llmStore'
import { useTimelineStore } from '../../store/timelineStore'
import { useProjectStore } from '../../store/projectStore'

const TOOL_LABEL: Record<string, string> = {
  get_project_state:    '📋 タイムライン確認',
  get_assets:           '📂 アセット確認',
  add_clip:             '➕ クリップ追加',
  move_clip:            '↔ クリップ移動',
  delete_clip:          '🗑 クリップ削除',
  split_clip:           '✂ クリップ分割',
  create_generation_job:'🎨 生成ジョブ作成',
}

function ActionBadge({ tool, result }: { tool: string; result: Record<string,unknown> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(v => !v)}
        className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-400 font-mono"
      >
        {TOOL_LABEL[tool] ?? tool} {open ? '▲' : '▼'}
      </button>
      {open && (
        <pre className="mt-1 text-[9px] text-zinc-500 bg-zinc-900 rounded p-1.5 overflow-x-auto max-h-24">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  )
}

function MessageBubble({ entry }: { entry: ChatEntry }) {
  if (entry.role === 'system') {
    return (
      <div className="px-3 py-2 text-[10px] text-amber-400 bg-amber-950/20 border border-amber-900 rounded mx-2 my-1">
        {entry.content}
      </div>
    )
  }

  const isUser = entry.role === 'user'

  return (
    <div className={`px-3 py-1.5 my-1 ${isUser ? 'text-right' : ''}`}>
      {isUser ? (
        <span className="inline-block bg-purple-800 text-white text-xs rounded-lg px-3 py-1.5 max-w-[85%] text-left whitespace-pre-wrap">
          {entry.content}
        </span>
      ) : (
        <div className="text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">
          {entry.pending ? (
            <span className="text-zinc-500 animate-pulse">考え中…</span>
          ) : entry.error ? (
            <span className="text-red-400">⚠ {entry.error}</span>
          ) : (
            entry.content
          )}
          {entry.actions && entry.actions.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {entry.actions.map((a, i) => (
                <ActionBadge key={i} tool={a.tool} result={a.result} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Suggested prompts to help users get started
const SUGGESTIONS = [
  'タイムラインの現在の状態を教えて',
  '利用可能な素材を一覧にして',
  'クリップ 1 を30フレーム後ろに移動して',
]

export function LLMChatPanel() {
  const { activeProject } = useProjectStore()
  const { entries, configured, model, sending, checkStatus, sendMessage, clearHistory } = useLLMStore()
  const { loadTimeline, projectFps } = useTimelineStore()

  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { checkStatus() }, [])

  // Scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  const handleSend = async () => {
    if (!activeProject || !input.trim() || sending) return
    const text = input.trim()
    setInput('')
    await sendMessage(activeProject.id, text)
    // Refresh timeline after potential mutations
    loadTimeline(activeProject.id, projectFps)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!activeProject) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-xs">
        プロジェクトを選択してください
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-zinc-800 flex items-center gap-2 flex-shrink-0">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${configured ? 'bg-green-400' : 'bg-zinc-600'}`} />
        <span className="text-[10px] text-zinc-500 flex-1 truncate">
          {configured ? model : 'API key未設定'}
        </span>
        {entries.length > 0 && (
          <button
            onClick={clearHistory}
            className="text-[10px] text-zinc-600 hover:text-zinc-400"
            title="会話履歴をクリア"
          >クリア</button>
        )}
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto py-1 font-mono text-[11px]">
        {entries.length === 0 && (
          <div className="px-3 pt-4 space-y-2">
            <p className="text-zinc-600 text-[10px] text-center mb-3">
              タイムライン操作を自然言語で指示できます
            </p>
            {SUGGESTIONS.map(s => (
              <button
                key={s}
                onClick={() => { setInput(s); inputRef.current?.focus() }}
                className="w-full text-left text-[10px] px-2 py-1.5 rounded border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {entries.map(e => <MessageBubble key={e.id} entry={e} />)}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-zinc-800 p-2 flex gap-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!configured || sending}
          rows={2}
          placeholder={configured ? '指示を入力… (Enter送信 / Shift+Enter改行)' : 'API key未設定'}
          className="flex-1 bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-purple-600 disabled:opacity-40 font-mono"
        />
        <button
          onClick={handleSend}
          disabled={!configured || !input.trim() || sending}
          className="self-end px-2.5 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white text-xs disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {sending ? '…' : '送信'}
        </button>
      </div>
    </div>
  )
}
