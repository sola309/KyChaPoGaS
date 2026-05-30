import { create } from 'zustand'
import type { LLMChatMessage, LLMActionLog } from '../api/client'
import { llmApi } from '../api/client'

export interface ChatEntry {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  actions?: LLMActionLog[]
  error?: string
  pending?: boolean
}

interface LLMState {
  entries: ChatEntry[]
  configured: boolean
  model: string
  sending: boolean

  checkStatus: () => Promise<void>
  sendMessage: (projectId: number, text: string) => Promise<void>
  clearHistory: () => void
}

let idSeq = 0
const uid = () => String(++idSeq)

export const useLLMStore = create<LLMState>((set, get) => ({
  entries: [],
  configured: false,
  model: '',
  sending: false,

  checkStatus: async () => {
    try {
      const { configured, model } = await llmApi.status()
      set({ configured, model })
      if (!configured) {
        set(s => ({
          entries: [
            ...s.entries,
            {
              id: uid(),
              role: 'system',
              content: 'ANTHROPIC_API_KEY が未設定です。backend/.env に追加してください。',
            },
          ],
        }))
      }
    } catch {
      set({ configured: false })
    }
  },

  sendMessage: async (projectId, text) => {
    if (get().sending) return
    const { entries } = get()

    // Add user message immediately
    const userEntry: ChatEntry = { id: uid(), role: 'user', content: text }
    const pendingEntry: ChatEntry = { id: uid(), role: 'assistant', content: '…', pending: true }
    set({ entries: [...entries, userEntry, pendingEntry], sending: true })

    // Build history for the API (exclude system and pending entries)
    const history: LLMChatMessage[] = get()
      .entries
      .filter(e => (e.role === 'user' || e.role === 'assistant') && !e.pending)
      .slice(-20)   // last 20 turns to limit context size
      .map(e => ({ role: e.role as 'user' | 'assistant', content: e.content }))

    try {
      const res = await llmApi.chat(projectId, text, history)
      set(s => ({
        sending: false,
        entries: s.entries.map(e =>
          e.id === pendingEntry.id
            ? { ...e, content: res.reply, actions: res.actions, pending: false }
            : e
        ),
      }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      set(s => ({
        sending: false,
        entries: s.entries.map(e =>
          e.id === pendingEntry.id
            ? { ...e, content: '', error: msg, pending: false }
            : e
        ),
      }))
    }
  },

  clearHistory: () => set({ entries: [] }),
}))
