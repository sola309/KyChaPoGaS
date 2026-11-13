// 🎞 コンポジション編集画面の状態(zustand)。文書・選択・再生位置・取り消しの履歴・自動保存・描き出し。
// 再生位置(frame)もここに置くが、購読するのは再生ヘッドと数字の表示だけにする(全体を描き直さない)。

import { create } from 'zustand'
import { compsApi, jobsApi, patchCompKeepalive, apiErrorText } from '../../api/client'
import { useUIStore } from '../../store/uiStore'
import { useTimelineStore } from '../../store/timelineStore'
import { useCompListStore } from './compList'
import type { CompDoc, CompSchema, CompSettings, CompSummary, Easing, KeyRef, Layer } from './types'
import {
  addLayer, clampFrame, cloneLayers, duplicateLayers, evalProp, findLayer, getPath, hasKeyAt, isKeyed, layerIn, layerOut,
  moveKeys, normalizeDoc, removeKey, removeLayers, round, sameFrame, setKey, setKeyEase, setPath, setValueAt, splitLayer,
  structuredCloneSafe, toConst, toggleKey, trimLayer, uniqueId, updateLayer, updateLayers,
} from './docOps'
import { BUILTIN_SCHEMA, loadSchema, newLayer } from './schema'

interface Snap { doc: CompDoc; settings: CompSettings }
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'
export interface RenderState { jobId: number; progress: number; phase?: string; status: string }

const MAX_HISTORY = 200
const SAVE_DEBOUNCE_MS = 800
const COALESCE_MS = 1200

// ── 画面に出さない持ち物 ──────────────────────────────────────────────────────
let coalesceKey: string | null = null
let coalesceAt = 0
let gesture = false                         // ドラッグの最中(間が空いても取り消し 1 回ぶんにまとめる)
let saveTimer: number | null = null
let saving: Promise<void> | null = null
let savedDoc: CompDoc | null = null          // 最後にサーバへ届いた文書(同じなら送らない)
let savedSettings: CompSettings | null = null
let openSeq = 0
/** コンポジションごとの履歴(パンくずで行き来しても取り消せるように)。rev が合うときだけ戻す */
const histories = new Map<number, { undo: Snap[]; redo: Snap[]; rev: number }>()
/** レイヤーのコピー(コンポジションをまたいで貼れる) */
let clipboard: Layer[] = []
/** この画面で保存し直したコンポジション(親へ戻ったとき iframe に comp:invalidate を送る) */
export const savedChildComps = new Set<number>()

const EMPTY_DOC: CompDoc = { version: 1, bg: null, layers: [] }
const EMPTY_SETTINGS: CompSettings = { width: 1920, height: 1080, fps: 30, duration_frames: 120 }

interface CompEditorState {
  projectId: number
  comp: CompSummary | null
  doc: CompDoc
  settings: CompSettings
  loading: boolean
  loadError: string | null
  schema: CompSchema

  sel: string[]
  selKeys: KeyRef[]
  frame: number
  playing: boolean
  loop: boolean
  expanded: Record<string, boolean>
  ppf: number                      // タイムラインの 1 コマの幅(px)

  undoStack: Snap[]
  redoStack: Snap[]
  saveState: SaveState
  saveError: string | null
  render: RenderState | null
  /** 見出しの下に出す知らせ(サーバが断った理由など。✕ で消す) */
  banner: string | null
  setBanner: (t: string | null) => void

  open: (projectId: number, compId: number) => Promise<void>
  close: () => Promise<void>
  /** 文書を置き換える。coalesce に同じ名前を続けて渡すと取り消し 1 回ぶんにまとまる(ドラッグ中) */
  commit: (doc: CompDoc, opts?: { coalesce?: string; settings?: CompSettings }) => void
  apply: (fn: (doc: CompDoc) => CompDoc, coalesce?: string) => void
  /** ドラッグの始まり(endCoalesce まで、同じ coalesce 名の変更を 1 回ぶんにまとめる) */
  beginGesture: () => void
  endCoalesce: () => void
  undo: () => void
  redo: () => void
  flush: () => Promise<void>
  flushOnUnload: () => void

  setFrame: (f: number) => void
  setPlaying: (p: boolean) => void
  setLoop: (v: boolean) => void
  setPpf: (v: number) => void
  setSel: (ids: string[]) => void
  clickSel: (id: string, mods: { shift?: boolean; ctrl?: boolean }) => void
  setSelKeys: (keys: KeyRef[]) => void
  toggleExpanded: (id: string) => void

  patchLayer: (id: string, patch: Partial<Layer>, coalesce?: string) => void
  /** その場の値を書く(キーつきなら再生位置にキー) */
  setProp: (ids: string[], path: string, value: unknown, coalesce?: string) => void
  /** 生の値を書く(プロパティ値として解釈しない。undefined で項目を消す) */
  setRaw: (ids: string[], path: string, value: unknown, coalesce?: string) => void
  toggleKeyAt: (ids: string[], path: string, dflt: unknown) => void
  clearKeys: (ids: string[], path: string, dflt: unknown) => void
  addTransformKeys: () => void
  deleteSelection: () => void
  duplicateSelection: () => void
  copySelection: () => void
  paste: () => void
  splitAtPlayhead: () => void
  setInOutAtPlayhead: (edge: 'in' | 'out') => void
  moveSelectedKeys: (delta: number, base: CompDoc, keys: KeyRef[]) => void
  setSelKeysEase: (e: Easing) => void
  addNewLayer: (type: string, over?: Partial<Layer>) => string
  precompose: () => Promise<void>

  setSettings: (s: Partial<CompSettings>, bg?: string | null) => void
  rename: (name: string) => Promise<void>
  startRender: () => Promise<void>
  place: () => Promise<void>
}

const toast = (t: string, k: 'info' | 'success' | 'error' = 'info') => useUIStore.getState().pushToast(t, k)

export const useCompStore = create<CompEditorState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer != null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => { saveTimer = null; void doSave() }, SAVE_DEBOUNCE_MS)
  }

  const needsSave = () => {
    const s = get()
    return !!s.comp && (s.doc !== savedDoc || s.settings !== savedSettings)
  }

  async function doSave(): Promise<void> {
    if (saving) { await saving; if (!needsSave()) return }
    const s = get()
    if (!s.comp || !needsSave()) { if (s.saveState === 'dirty') set({ saveState: 'saved' }); return }
    const id = s.comp.id
    const doc = s.doc, settings = s.settings
    set({ saveState: 'saving', saveError: null })
    const p = (async () => {
      try {
        const res = await compsApi.update(id, { data: doc, ...settings }, true)
        if (get().comp?.id !== id) { savedChildComps.add(id); return }
        savedDoc = doc; savedSettings = settings
        savedChildComps.add(id)
        const { data: _d, ...meta } = res
        void _d
        const row = { ...meta, layer_count: doc.layers.length }
        useCompListStore.getState().upsert(row)
        const h = histories.get(id)
        if (h) h.rev = res.rev
        set({ comp: row, saveState: get().doc === doc && get().settings === settings ? 'saved' : 'dirty' })
      } catch (e) {
        if (get().comp?.id === id) set({ saveState: 'error', saveError: apiErrorText(e) })
      }
    })()
    saving = p
    await p
    saving = null
    if (get().comp?.id === id && get().saveState === 'dirty') scheduleSave()
  }

  const pruneSel = (doc: CompDoc) => {
    const ids = new Set(doc.layers.map(l => l.id))
    const s = get()
    const sel = s.sel.filter(i => ids.has(i))
    const selKeys = s.selKeys.filter(k => {
      const l = ids.has(k.layerId) ? findLayer(doc, k.layerId) : null
      return !!l && hasKeyAt(getPath(l, k.path), k.f)
    })
    return {
      ...(sel.length !== s.sel.length ? { sel } : {}),
      ...(selKeys.length !== s.selKeys.length ? { selKeys } : {}),
    }
  }

  const snapOf = (s: CompEditorState): Snap => ({ doc: s.doc, settings: s.settings })

  const stashHistory = () => {
    const s = get()
    if (s.comp) histories.set(s.comp.id, { undo: s.undoStack, redo: s.redoStack, rev: s.comp.rev })
  }

  async function watchJob(jobId: number, compId: number) {
    set({ render: { jobId, progress: 0, status: 'pending' } })
    for (;;) {
      await new Promise(r => setTimeout(r, 900))
      let j
      try { j = await jobsApi.get(jobId) } catch { continue }
      if (get().render?.jobId !== jobId) return
      set({ render: { jobId, progress: j.progress, phase: j.phase, status: j.status } })
      if (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') {
        const pid = get().projectId
        if (j.status === 'completed') {
          toast('🎞 描き出しが終わりました', 'success')
          try {
            const res = await compsApi.get(compId)
            const { data: _d, ...meta } = res
            void _d
            const row = { ...meta, layer_count: res.data.layers?.length ?? 0 }
            useCompListStore.getState().upsert(row)
            if (get().comp?.id === compId) set({ comp: row })
          } catch { /* 表示だけ */ }
          void useCompListStore.getState().load(pid)
          void useTimelineStore.getState().syncFromServer(pid)
          window.dispatchEvent(new Event('kychapogas:assets-changed'))
        } else toast(`描き出しに失敗しました: ${j.error_msg ?? j.status}`, 'error')
        window.setTimeout(() => { if (get().render?.jobId === jobId) set({ render: null }) }, 1500)
        return
      }
    }
  }

  return {
    projectId: 0,
    comp: null,
    doc: EMPTY_DOC,
    settings: EMPTY_SETTINGS,
    loading: false,
    loadError: null,
    schema: BUILTIN_SCHEMA,
    sel: [],
    selKeys: [],
    frame: 0,
    playing: false,
    loop: true,
    expanded: {},
    ppf: 6,
    undoStack: [],
    redoStack: [],
    saveState: 'saved',
    saveError: null,
    render: null,
    banner: null,
    setBanner: (banner) => set({ banner }),

    open: async (projectId, compId) => {
      const seq = ++openSeq
      await get().flush()
      stashHistory()
      set({ projectId, loading: true, loadError: null, playing: false })
      void loadSchema().then(schema => { if (get().schema !== schema) set({ schema }) })
      try {
        const res = await compsApi.get(compId)
        if (seq !== openSeq) return
        const doc = normalizeDoc(res.data)
        const settings: CompSettings = { width: res.width, height: res.height, fps: res.fps, duration_frames: res.duration_frames }
        const { data: _d, ...meta } = res
        void _d
        savedDoc = doc; savedSettings = settings
        coalesceKey = null
        const h = histories.get(compId)
        const keep = h && h.rev === res.rev
        set({
          comp: { ...meta, layer_count: doc.layers.length }, doc, settings, loading: false,
          sel: [], selKeys: [], frame: 0, expanded: {},
          undoStack: keep ? h.undo : [], redoStack: keep ? h.redo : [],
          saveState: 'saved', saveError: null,
          ppf: Math.max(1, Math.min(24, 900 / Math.max(1, settings.duration_frames))),
        })
      } catch (e) {
        if (seq !== openSeq) return
        set({ loading: false, loadError: apiErrorText(e), comp: null, doc: EMPTY_DOC })
      }
    },

    close: async () => {
      await get().flush()
      stashHistory()
      openSeq++
      set({ comp: null, doc: EMPTY_DOC, sel: [], selKeys: [], playing: false, undoStack: [], redoStack: [], render: null })
      savedDoc = null; savedSettings = null
    },

    commit: (doc, opts) => {
      const s = get()
      const settings = opts?.settings ?? s.settings
      if (doc === s.doc && settings === s.settings) return
      const now = performance.now()
      const merge = !!opts?.coalesce && opts.coalesce === coalesceKey && (gesture || now - coalesceAt < COALESCE_MS) && s.undoStack.length > 0
      coalesceKey = opts?.coalesce ?? null
      coalesceAt = now
      set({
        doc, settings,
        undoStack: merge ? s.undoStack : [...s.undoStack.slice(-(MAX_HISTORY - 1)), snapOf(s)],
        redoStack: s.redoStack.length ? [] : s.redoStack,
        saveState: 'dirty',
      })
      const pr = pruneSel(doc)
      if (Object.keys(pr).length) set(pr)
      scheduleSave()
    },

    apply: (fn, coalesce) => get().commit(fn(get().doc), coalesce ? { coalesce } : undefined),

    beginGesture: () => { gesture = true; coalesceKey = null },
    endCoalesce: () => { coalesceKey = null; gesture = false },

    undo: () => {
      const s = get()
      const prev = s.undoStack[s.undoStack.length - 1]
      if (!prev) return
      coalesceKey = null; gesture = false
      set({ doc: prev.doc, settings: prev.settings, undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, snapOf(s)], saveState: 'dirty' })
      set(pruneSel(prev.doc))
      scheduleSave()
    },

    redo: () => {
      const s = get()
      const next = s.redoStack[s.redoStack.length - 1]
      if (!next) return
      coalesceKey = null
      set({ doc: next.doc, settings: next.settings, redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, snapOf(s)], saveState: 'dirty' })
      set(pruneSel(next.doc))
      scheduleSave()
    },

    flush: async () => {
      if (saveTimer != null) { window.clearTimeout(saveTimer); saveTimer = null }
      if (saving) await saving
      if (needsSave()) await doSave()
    },

    flushOnUnload: () => {
      const s = get()
      if (!s.comp || !needsSave()) return
      if (saveTimer != null) { window.clearTimeout(saveTimer); saveTimer = null }
      patchCompKeepalive(s.comp.id, { data: s.doc, ...s.settings })
      savedDoc = s.doc; savedSettings = s.settings
    },

    setFrame: (f) => {
      const v = clampFrame(f, get().settings)
      if (v !== get().frame) set({ frame: v })
    },
    setPlaying: (playing) => set({ playing }),
    setLoop: (loop) => set({ loop }),
    setPpf: (v) => set({ ppf: Math.max(0.5, Math.min(60, v)) }),
    setSel: (ids) => set({ sel: ids, selKeys: [] }),
    clickSel: (id, mods) => {
      const s = get()
      if (mods.ctrl) set({ sel: s.sel.includes(id) ? s.sel.filter(x => x !== id) : [...s.sel, id], selKeys: [] })
      else if (mods.shift && s.sel.length) {
        const order = s.doc.layers.map(l => l.id)
        const a = order.indexOf(s.sel[s.sel.length - 1]), b = order.indexOf(id)
        if (a < 0 || b < 0) { set({ sel: [id], selKeys: [] }); return }
        const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
        const rest = s.sel.filter(x => !range.includes(x))
        // 最後に押した行を「主」にする(プロパティ欄に出る)
        set({ sel: [...rest, ...range.filter(x => x !== id), id], selKeys: [] })
      } else set({ sel: [id], selKeys: [] })
    },
    setSelKeys: (selKeys) => set({ selKeys }),
    toggleExpanded: (id) => set(s => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),

    patchLayer: (id, patch, coalesce) => get().apply(d => updateLayer(d, id, l => ({ ...l, ...patch })), coalesce),

    setProp: (ids, path, value, coalesce) => {
      const f = get().frame
      get().apply(d => updateLayers(d, ids, l => setPath(l, path, setValueAt(getPath(l, path), f, value))), coalesce)
    },
    setRaw: (ids, path, value, coalesce) => get().apply(d => updateLayers(d, ids, l => setPath(l, path, value)), coalesce),

    toggleKeyAt: (ids, path, dflt) => {
      const f = get().frame
      get().apply(d => updateLayers(d, ids, l => setPath(l, path, toggleKey(getPath(l, path), f, dflt))))
    },
    clearKeys: (ids, path, dflt) => {
      const f = get().frame
      get().apply(d => updateLayers(d, ids, l => {
        const p = getPath(l, path)
        return isKeyed(p) ? setPath(l, path, toConst(p, evalProp(p, f, dflt))) : l
      }))
    },

    addTransformKeys: () => {
      const s = get()
      if (!s.sel.length) return
      const f = s.frame
      const dflt: Record<string, unknown> = {
        position: [s.settings.width / 2, s.settings.height / 2], anchor: [0, 0], scale: [100, 100], rotation: 0, opacity: 100,
      }
      s.apply(d => updateLayers(d, s.sel, l => {
        if (l.locked) return l
        const t = { ...(l.transform ?? {}) }
        // すでにあるプロパティ(と位置・拡大・回転・不透明度)にキーを打つ
        for (const name of ['position', 'scale', 'rotation', 'opacity', 'anchor']) {
          if (name === 'anchor' && t.anchor === undefined) continue
          if (name === 'position' && t.position === undefined && (l.type === 'camera' || l.type === 'adjustment')) continue
          t[name] = setKey(t[name], f, evalProp(t[name], f, dflt[name]))
        }
        return { ...l, transform: t }
      }))
      toast(`◆ ${f} コマ目にトランスフォームのキーを打ちました`)
    },

    deleteSelection: () => {
      const s = get()
      if (s.selKeys.length) {
        const keys = s.selKeys
        s.apply(d => {
          let out = d
          for (const k of keys) out = updateLayer(out, k.layerId, l => (l.locked ? l : setPath(l, k.path, removeKey(getPath(l, k.path), k.f))))
          return out
        })
        set({ selKeys: [] })
        return
      }
      const ids = s.sel.filter(id => !findLayer(s.doc, id)?.locked)
      if (ids.length) s.apply(d => removeLayers(d, ids))
    },

    duplicateSelection: () => {
      const s = get()
      if (!s.sel.length) return
      const r = duplicateLayers(s.doc, s.sel)
      s.commit(r.doc)
      set({ sel: r.newIds, selKeys: [] })
    },

    copySelection: () => {
      const s = get()
      const set_ = new Set(s.sel)
      clipboard = structuredCloneSafe(s.doc.layers.filter(l => set_.has(l.id)))
      if (clipboard.length) toast(`${clipboard.length} レイヤーをコピーしました`)
    },

    paste: () => {
      const s = get()
      if (!clipboard.length) return
      const copies = cloneLayers(s.doc, clipboard)
      const firstSel = s.doc.layers.findIndex(l => s.sel.includes(l.id))
      const at = firstSel >= 0 ? firstSel : 0
      const layers = [...s.doc.layers]
      layers.splice(at, 0, ...copies)
      s.commit({ ...s.doc, layers })
      set({ sel: copies.map(c => c.id), selKeys: [] })
    },

    splitAtPlayhead: () => {
      const s = get()
      let doc = s.doc
      const made: string[] = []
      for (const id of s.sel) {
        if (findLayer(doc, id)?.locked) continue
        const r = splitLayer(doc, id, s.frame, s.settings.duration_frames)
        doc = r.doc
        if (r.newId) made.push(r.newId)
      }
      if (doc === s.doc) { toast('再生位置が選んだレイヤーの中にありません'); return }
      s.commit(doc)
    },

    setInOutAtPlayhead: (edge) => {
      const s = get()
      const dur = s.settings.duration_frames
      // [ = 再生位置を先頭に / ] = 再生位置のコマまで表示(out は含まないので +1)
      s.apply(d => updateLayers(d, s.sel, l => (l.locked ? l : trimLayer(l, edge, edge === 'in' ? s.frame : s.frame + 1, dur))))
    },

    moveSelectedKeys: (delta, base, keys) => {
      // base(ドラッグを始めたときの文書)から毎回作り直す
      let out = base
      const groups = new Map<string, KeyRef[]>()
      for (const k of keys) {
        const g = `${k.layerId}\n${k.path}`
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(k)
      }
      for (const ks of groups.values()) {
        out = updateLayer(out, ks[0].layerId, l => setPath(l, ks[0].path, moveKeys(getPath(l, ks[0].path), ks.map(k => k.f), delta)))
      }
      get().commit(out, { coalesce: 'key-drag' })
      set({ selKeys: keys.map(k => ({ ...k, f: k.f + delta })) })
    },

    setSelKeysEase: (e) => {
      const keys = get().selKeys
      if (!keys.length) return
      get().apply(d => {
        let out = d
        for (const k of keys) out = updateLayer(out, k.layerId, l => setPath(l, k.path, setKeyEase(getPath(l, k.path), [k.f], e)))
        return out
      }, 'key-ease')
    },

    addNewLayer: (type, over) => {
      const s = get()
      const id = uniqueId(s.doc, type === 'null' ? 'null' : type)
      const layer = newLayer(s.schema, type, id, s.settings, over)
      const firstSel = s.doc.layers.findIndex(l => s.sel.includes(l.id))
      s.commit(addLayer(s.doc, layer, firstSel >= 0 ? firstSel : 0))
      set({ sel: [id], selKeys: [] })
      return id
    },

    precompose: async () => {
      const s = get()
      if (!s.comp || !s.sel.length) return
      const selSet = new Set(s.sel)
      const moving = s.doc.layers.filter(l => selSet.has(l.id))
      if (!moving.length) return
      // 組の外を指す親・マットは外す(外の変形は引き継げない)
      const inner = structuredCloneSafe(moving).map(l => ({
        ...l,
        parent: l.parent != null && selSet.has(l.parent) ? l.parent : null,
        matte: l.matte && selSet.has(l.matte.layer) ? l.matte : null,
      }))
      const name = `${moving[0].name ?? moving[0].id} プリコンポ`
      let child
      try {
        child = await compsApi.create({ project_id: s.projectId, name, ...s.settings, data: { version: 1, bg: null, layers: inner } }, true)
      } catch (e) { toast(`プリコンポーズできません: ${apiErrorText(e)}`, 'error'); return }
      const cur = get()
      if (cur.comp?.id !== s.comp.id) return
      const at = cur.doc.layers.findIndex(l => selSet.has(l.id))
      const id = uniqueId(cur.doc, 'comp')
      const layer = newLayer(cur.schema, 'comp', id, cur.settings, { name, source: { comp_id: child.id } })
      cur.commit(addLayer(removeLayers(cur.doc, selSet), layer, Math.max(0, at)))
      set({ sel: [id], selKeys: [] })
      void useCompListStore.getState().load(s.projectId)
      toast(`🎞 「${name}」にまとめました(帯をダブルクリックで中を開く)`, 'success')
    },

    setSettings: (patch, bg) => {
      const s = get()
      const settings: CompSettings = {
        width: Math.max(2, Math.round(patch.width ?? s.settings.width)),
        height: Math.max(2, Math.round(patch.height ?? s.settings.height)),
        fps: Math.max(1, round(patch.fps ?? s.settings.fps, 3)),
        duration_frames: Math.max(1, Math.round(patch.duration_frames ?? s.settings.duration_frames)),
      }
      const same = (Object.keys(settings) as (keyof CompSettings)[]).every(k => settings[k] === s.settings[k])
      const doc = bg !== undefined && bg !== s.doc.bg ? { ...s.doc, bg } : s.doc
      if (same && doc === s.doc) return
      s.commit(doc, { settings: same ? s.settings : settings })
      if (get().frame > settings.duration_frames - 1) set({ frame: settings.duration_frames - 1 })
    },

    rename: async (name) => {
      const c = get().comp
      const v = name.trim()
      if (!c || !v || v === c.name) return
      try {
        const res = await compsApi.update(c.id, { name: v })
        const { data: _d, ...meta } = res
        void _d
        const row = { ...get().comp!, name: meta.name, rev: meta.rev, stale: meta.stale }
        useCompListStore.getState().upsert(row)
        if (get().comp?.id === c.id) set({ comp: row })
      } catch { /* トーストは client が出す */ }
    },

    startRender: async () => {
      const s = get()
      if (!s.comp || s.render) return
      await s.flush()
      if (get().saveState === 'error') { toast('保存できていないので描き出せません', 'error'); return }
      try {
        const r = await compsApi.render(s.comp.id)
        void watchJob(r.job_id, s.comp.id)
      } catch { /* トーストは client が出す */ }
    },

    place: async () => {
      const s = get()
      if (!s.comp) return
      await s.flush()
      if (get().saveState === 'error') { toast('保存できていないので置けません', 'error'); return }
      try {
        const at = useTimelineStore.getState().currentFrame
        const r = await compsApi.place(s.comp.id, { start_frame: Math.max(0, Math.round(at)), render: true })
        await useTimelineStore.getState().syncFromServer(s.projectId)
        toast(`🎞 タイムラインの ${Math.round(at)} コマ目に置きました${r.job_id ? '(描き出し中…終わると絵が入ります)' : ''}`, 'success')
        if (r.job_id && !get().render) void watchJob(r.job_id, s.comp.id)
      } catch { /* トーストは client が出す */ }
    },
  }
})

/** 再生位置にあるレイヤーか(表示の判定用) */
export const layerActiveAt = (l: Layer, f: number, dur: number) => f >= layerIn(l) && f < layerOut(l, dur)

export { sameFrame }
