import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'
export interface Toast { id: number; text: string; kind: ToastKind; color?: string }

const KIND_COLOR: Record<ToastKind, string> = {
  info: '#60a5fa', success: '#4ade80', error: '#f87171',
}

interface UIState {
  toasts: Toast[]
  /** Shot Editor overlay (mad-kit clips): open with the clip's shot_id */
  shotEditor: { shotId: string } | null
  /** UI inspect mode (🎯) — click any element to share it with the AI agent */
  inspectMode: boolean
  setInspectMode: (v: boolean) => void
  openShotEditor: (shotId: string) => void
  closeShotEditor: () => void
  pendingWrites: number        // in-flight edit writes (for the auto-save indicator)
  // Mobile/tablet off-canvas drawers (ignored on lg+ where panels are inline)
  navOpen: boolean             // left sidebar (projects)
  panelOpen: boolean           // right panel (assets / generate / jobs)
  pushToast: (text: string, kind?: ToastKind, color?: string) => void
  dismissToast: (id: number) => void
  beginWrite: () => void
  endWrite: () => void
  toggleNav: () => void
  togglePanel: () => void
  closeDrawers: () => void
}

let _seq = 1

export const useUIStore = create<UIState>((set) => ({
  toasts: [],
  shotEditor: null,
  inspectMode: false,
  setInspectMode: (v) => set({ inspectMode: v }),
  openShotEditor: (shotId) => set({ shotEditor: { shotId } }),
  closeShotEditor: () => set({ shotEditor: null }),
  pendingWrites: 0,
  navOpen: false,
  panelOpen: false,
  pushToast: (text, kind = 'info', color) =>
    set(s => ({ toasts: [...s.toasts, { id: _seq++, text, kind, color: color ?? KIND_COLOR[kind] }] })),
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
  beginWrite: () => set(s => ({ pendingWrites: s.pendingWrites + 1 })),
  endWrite: () => set(s => ({ pendingWrites: Math.max(0, s.pendingWrites - 1) })),
  // Opening one drawer closes the other (only one fits on a phone)
  toggleNav: () => set(s => ({ navOpen: !s.navOpen, panelOpen: false })),
  togglePanel: () => set(s => ({ panelOpen: !s.panelOpen, navOpen: false })),
  closeDrawers: () => set({ navOpen: false, panelOpen: false }),
}))
