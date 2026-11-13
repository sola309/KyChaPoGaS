// 🎞 コンポジションの一覧(軽い。本体のバンドルに入る)。
// タイムラインの comp クリップが名前と「古い」印を出すのに使う。編集画面の本体(遅延読み込み)はここを読まない側に置く。

import { create } from 'zustand'
import { compsApi } from '../../api/client'
import type { Clip } from '../../api/client'
import type { CompSummary } from './types'
import { useJobStore } from '../../store/jobStore'
import { useTimelineStore } from '../../store/timelineStore'

interface CompListState {
  projectId: number | null
  byId: Record<number, CompSummary>
  list: CompSummary[]
  loading: boolean
  load: (projectId: number) => Promise<void>
  upsert: (c: CompSummary) => void
}

export const useCompListStore = create<CompListState>((set, get) => ({
  projectId: null,
  byId: {},
  list: [],
  loading: false,
  load: async (projectId) => {
    if (get().projectId !== projectId) set({ projectId, byId: {}, list: [] })
    set({ loading: true })
    try {
      const list = await compsApi.list(projectId)
      if (get().projectId !== projectId) return
      set({ list, byId: Object.fromEntries(list.map(c => [c.id, c])), loading: false })
    } catch { set({ loading: false }) }
  },
  upsert: (c) => {
    if (get().projectId !== c.project_id) return
    // data は持たない(一覧は軽く)
    const { data: _data, ...rest } = c as CompSummary & { data?: unknown }
    void _data
    const prev = get().byId[c.id]
    const row: CompSummary = { ...prev, ...rest, layer_count: rest.layer_count ?? prev?.layer_count }
    const list = prev ? get().list.map(x => (x.id === c.id ? row : x)) : [...get().list, row]
    set({ list, byId: { ...get().byId, [c.id]: row } })
  },
}))

/** comp クリップの attrs_json({"comp_id":N,"rev":R})。comp クリップでなければ null */
export function compClipAttrs(clip: Pick<Clip, 'kind' | 'attrs_json'>): { comp_id: number; rev: number } | null {
  if (clip.kind !== 'comp') return null
  try {
    const a = JSON.parse(clip.attrs_json || '{}')
    return typeof a.comp_id === 'number' ? { comp_id: a.comp_id, rev: typeof a.rev === 'number' ? a.rev : 0 } : null
  } catch { return null }
}

/** 編集画面を開く合図(ProjectView が受けて遅延読み込みする) */
export function openCompEditor(compId?: number | null) {
  window.dispatchEvent(new CustomEvent('kychapogas:open-comp', { detail: { compId: compId ?? null } }))
}

// 描き出し(render_comp)が終わったら、一覧とタイムラインを取り直す。
// 編集画面を閉じていても、本番の書き出しの前の自動の描き直しでも、クリップが新しい素材を指す。
const seenActive = new Set<number>()
useJobStore.subscribe((s) => {
  let finished = false
  for (const j of s.jobs) {
    if ((j.job_type as string) !== 'render_comp') continue
    if (j.status === 'pending' || j.status === 'running') seenActive.add(j.id)
    else if (seenActive.has(j.id)) { seenActive.delete(j.id); if (j.status === 'completed') finished = true }
  }
  if (!finished) return
  const pid = useCompListStore.getState().projectId
  if (pid == null) return
  void useCompListStore.getState().load(pid)
  void useTimelineStore.getState().syncFromServer(pid)
  window.dispatchEvent(new Event('kychapogas:assets-changed'))
})
