import { create } from 'zustand'
import { useUIStore } from './uiStore'

export interface CollabUser { id: string; name: string; color: string }
export interface Presence { frame?: number | null; selected_clip_id?: number | null; editing_clip_id?: number | null; cursor?: { frame: number } | null }
export interface RemoteUser { user: CollabUser; presence: Presence; lastSeen: number }

const COLORS = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6']

function pickColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]
}

/** Stable per-browser identity (display name is editable; no password). */
export function getIdentity(): CollabUser {
  let id = localStorage.getItem('collab_id')
  if (!id) { id = 'u' + Math.random().toString(36).slice(2, 9); localStorage.setItem('collab_id', id) }
  let color = localStorage.getItem('collab_color')
  if (!color) { color = pickColor(id); localStorage.setItem('collab_color', color) }
  const name = localStorage.getItem('collab_name') ?? ''
  return { id, name, color }
}

interface CollabState {
  me: CollabUser
  others: Record<string, RemoteUser>
  connected: boolean
  ws: WebSocket | null
  projectId: number | null
  lastRemoteEdit: number     // timestamp bumped when another user edits the timeline
  setName: (name: string) => void
  connect: (projectId: number) => void
  disconnect: () => void
  sendPresence: (p: Presence) => void
  broadcastEdit: () => void
}

export const useCollabStore = create<CollabState>((set, get) => ({
  me: getIdentity(),
  others: {},
  connected: false,
  ws: null,
  projectId: null,
  lastRemoteEdit: 0,

  setName: (name) => {
    localStorage.setItem('collab_name', name)
    set(s => ({ me: { ...s.me, name } }))
    // reconnect so the new name propagates
    const pid = get().projectId
    if (pid != null) { get().disconnect(); get().connect(pid) }
  },

  connect: (projectId) => {
    get().disconnect()
    const me = get().me
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const q = new URLSearchParams({
      project_id: String(projectId), id: me.id, name: me.name || 'Guest', color: me.color,
    })
    const ws = new WebSocket(`${proto}://${location.host}/ws/collab?${q}`)

    ws.onopen = () => set({ connected: true })
    ws.onclose = () => set({ connected: false })
    ws.onmessage = (e) => {
      let msg: any
      try { msg = JSON.parse(e.data) } catch { return }
      const now = Date.now()
      if (msg.type === 'roster') {
        const others: Record<string, RemoteUser> = {}
        for (const u of msg.users ?? []) others[u.user.id] = { user: u.user, presence: u.presence ?? {}, lastSeen: now }
        set({ others })
      } else if (msg.type === 'join') {
        set(s => ({ others: { ...s.others, [msg.user.id]: { user: msg.user, presence: {}, lastSeen: now } } }))
        useUIStore.getState().pushToast(`${msg.user.name} が参加しました`, 'info', msg.user.color)
      } else if (msg.type === 'presence') {
        set(s => ({ others: { ...s.others, [msg.id]: { user: msg.user, presence: msg.presence ?? {}, lastSeen: now } } }))
      } else if (msg.type === 'leave') {
        const left = get().others[msg.id]?.user
        set(s => { const o = { ...s.others }; delete o[msg.id]; return { others: o } })
        if (left) useUIStore.getState().pushToast(`${left.name} が退出しました`, 'info', left.color)
      } else if (msg.type === 'edit') {
        set({ lastRemoteEdit: now })
      }
    }
    set({ ws, projectId })
  },

  disconnect: () => {
    const { ws } = get()
    if (ws) { try { ws.close() } catch { /* noop */ } }
    set({ ws: null, connected: false, others: {}, projectId: null })
  },

  sendPresence: (p) => {
    const { ws } = get()
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'presence', ...p }))
    }
  },

  // Tell other clients a timeline mutation was committed (they re-sync from server).
  broadcastEdit: () => {
    const { ws } = get()
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'edit' }))
    }
  },
}))
