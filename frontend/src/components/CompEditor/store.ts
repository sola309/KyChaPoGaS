// 🎞 コンポジション編集画面の状態(zustand)。文書・選択・再生位置・取り消しの履歴・自動保存・描き出し。
// 再生位置(frame)もここに置くが、購読するのは再生ヘッドと数字の表示だけにする(全体を描き直さない)。

import { create } from 'zustand'
import { compsApi, jobsApi, patchCompKeepalive, apiErrorText } from '../../api/client'
import { useUIStore } from '../../store/uiStore'
import { useTimelineStore } from '../../store/timelineStore'
import { useCompListStore } from './compList'
import type { CompDoc, CompProblem, CompSchema, CompSettings, CompSummary, Easing, KeyClip, KeyRef, Layer } from './types'
import {
  addDelta, addLayer, clampFrame, isObj, scopeInfo, unsetPath, cloneLayers, duplicateLayers, evalProp, findLayer, getPath, hasKeyAt, isKeyed, layerIn, layerOut,
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
/** キーフレームのコピー。最後にコピーしたほう(レイヤーかキー)を貼る */
let keyClipboard: KeyClip[] = []
let clipboardKind: 'layers' | 'keys' = 'layers'
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
  /** たたんだ group・camera の範囲(id → true) */
  collapsed: Record<string, boolean>
  toggleCollapsed: (id: string) => void
  /** 最後に触った場所(←→ がコマ送りか、レイヤーの移動かを決める) */
  focusArea: 'preview' | 'timeline' | 'panel'
  setFocusArea: (a: 'preview' | 'timeline' | 'panel') => void
  /** 行を見える所までスクロールさせる合図(プレビューで選んだとき・問題の一覧から) */
  reveal: { id: string; tick: number } | null
  revealLayer: (id: string) => void
  /** エンジンからの知らせ(comp:error) */
  problems: CompProblem[]
  addProblem: (p: { level?: unknown; message?: unknown; layer_id?: unknown }) => void
  clearProblems: () => void

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
  /** 項目を消す(optional の「切」)。空になった入れ物も消す */
  unsetProp: (ids: string[], path: string) => void
  /** 今の値に差分を足す(複数選択のつまみドラッグ。レイヤーごとの値の差を保つ) */
  addToProp: (ids: string[], path: string, delta: number | number[], dflt: unknown, coalesce?: string) => void
  /** 選んだレイヤーを px 単位で動かす(矢印キー) */
  nudge: (dx: number, dy: number) => void
  /** 行のスイッチ(表示・ロック・ソロ・3D)。選んだ行の上で押すと、選んだレイヤーすべてに同じ値 */
  toggleFlag: (id: string, key: 'visible' | 'locked' | 'solo' | 'three_d' | 'guide') => void
  setFlagAll: (ids: string[], key: 'visible' | 'locked' | 'solo' | 'guide', value: boolean) => void
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
  /** track: 省略 =「Comps」トラック / 番号 = その映像トラック / 'new' = 新しい映像トラックを作って置く */
  place: (track?: number | 'new') => Promise<void>
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
    collapsed: {},
    toggleCollapsed: (id) => set(s => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
    focusArea: 'timeline',
    setFocusArea: (focusArea) => { if (get().focusArea !== focusArea) set({ focusArea }) },
    reveal: null,
    revealLayer: (id) => {
      // たたんだ範囲の中なら開く
      const s = get()
      const own = scopeInfo(s.doc.layers).owners.get(id)
      if (own?.some(o => s.collapsed[o])) { const c = { ...s.collapsed }; for (const o of own) delete c[o]; set({ collapsed: c }) }
      set({ reveal: { id, tick: (s.reveal?.tick ?? 0) + 1 } })
    },
    problems: [],
    addProblem: (p) => {
      const message = String(p.message ?? '').slice(0, 400)
      if (!message) return
      const level = typeof p.level === 'string' ? p.level : 'warn'
      const layer_id = typeof p.layer_id === 'string' ? p.layer_id : undefined
      const cur = get().problems
      const i = cur.findIndex(x => x.message === message && x.layer_id === layer_id)
      if (i >= 0) set({ problems: cur.map((x, j) => (j === i ? { ...x, count: x.count + 1 } : x)) })
      else set({ problems: [...cur.slice(-99), { level, message, layer_id, count: 1 }] })
    },
    clearProblems: () => { if (get().problems.length) set({ problems: [] }) },

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
          sel: [], selKeys: [], frame: 0, expanded: {}, collapsed: {}, problems: [], reveal: null,
          undoStack: keep ? h.undo : [], redoStack: keep ? h.redo : [],
          saveState: 'saved', saveError: null,
          // 全体が見える幅から始める(長いコンポジションでも帯が画面に入る)
          ppf: Math.max(0.1, Math.min(24, 1000 / Math.max(1, settings.duration_frames))),
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
    setPpf: (v) => set({ ppf: Math.max(0.05, Math.min(60, v)) }),
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
    setSelKeys: (selKeys) => {
      // キーを選んだら、そのキーのレイヤーも選ぶ(プロパティ欄と、キーの貼り先がそろう)
      if (!selKeys.length) { set({ selKeys }); return }
      const ids = [...new Set(selKeys.map(k => k.layerId))]
      const cur = get().sel
      set(ids.length === cur.length && ids.every(i => cur.includes(i)) ? { selKeys } : { selKeys, sel: ids })
    },
    toggleExpanded: (id) => set(s => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),

    patchLayer: (id, patch, coalesce) => get().apply(d => updateLayer(d, id, l => ({ ...l, ...patch })), coalesce),

    setProp: (ids, path, value, coalesce) => {
      const f = get().frame
      get().apply(d => updateLayers(d, ids, l => setPath(l, path, setValueAt(getPath(l, path), f, value))), coalesce)
    },
    setRaw: (ids, path, value, coalesce) => get().apply(d => updateLayers(d, ids, l => setPath(l, path, value)), coalesce),

    unsetProp: (ids, path) => get().apply(d => updateLayers(d, ids, l => (getPath(l, path) === undefined ? l : unsetPath(l, path)))),

    addToProp: (ids, path, delta, dflt, coalesce) => {
      const f = get().frame
      get().apply(d => updateLayers(d, ids, l => {
        if (l.locked) return l
        const p = getPath(l, path)
        const cur = evalProp<unknown>(p, f, dflt)
        const next = addDelta(cur, delta)
        return next === cur ? l : setPath(l, path, setValueAt(p, f, next))
      }), coalesce)
    },

    nudge: (dx, dy) => {
      const s = get()
      if (!s.sel.length) return
      const f = s.frame
      const center = [s.settings.width / 2, s.settings.height / 2]
      s.apply(d => updateLayers(d, s.sel, l => {
        if (l.locked || l.type === 'adjustment') return l
        const p = l.transform?.position
        if (p === undefined && l.type === 'camera') return l
        // {x, y, z} の分け書き
        if (isObj(p) && !Array.isArray(p.k) && !('v' in p) && ('x' in p || 'y' in p)) {
          let n = l
          if (dx) n = setPath(n, 'transform.position.x', setValueAt(p.x, f, round(evalProp<number>(p.x, f, center[0]) + dx)))
          if (dy) n = setPath(n, 'transform.position.y', setValueAt(p.y, f, round(evalProp<number>(p.y, f, center[1]) + dy)))
          return n
        }
        const cur = evalProp<unknown>(p, f, center)
        const arr = Array.isArray(cur) ? cur : center
        return setPath(l, 'transform.position', setValueAt(p, f, addDelta(arr, [dx, dy])))
      }), 'nudge')
    },

    toggleFlag: (id, key) => {
      const s = get()
      const l = findLayer(s.doc, id)
      if (!l) return
      const cur = key === 'visible' ? l.visible !== false : !!l[key]
      const ids = s.sel.includes(id) && s.sel.length > 1 ? s.sel : [id]
      s.apply(d => updateLayers(d, ids, x => ({ ...x, [key]: !cur })))
    },
    setFlagAll: (ids, key, value) => get().apply(d => updateLayers(d, ids, x => ((key === 'visible' ? x.visible !== false : !!x[key]) === value ? x : { ...x, [key]: value }))),

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
      if (s.selKeys.length) {
        const out: KeyClip[] = []
        for (const k of s.selKeys) {
          const l = findLayer(s.doc, k.layerId)
          const p = l ? getPath(l, k.path) : null
          const key = isKeyed(p) ? p.k.find(x => sameFrame(x.f, k.f)) : null
          if (key) out.push({ layerId: k.layerId, path: k.path, f: key.f, v: structuredCloneSafe(key.v), ...(key.e !== undefined ? { e: key.e } : {}) })
        }
        if (out.length) { keyClipboard = out; clipboardKind = 'keys'; toast(`◆ キーフレーム ${out.length} 個をコピーしました(Ctrl+V で再生位置に貼る)`) }
        return
      }
      clipboardKind = 'layers'
      const set_ = new Set(s.sel)
      clipboard = structuredCloneSafe(s.doc.layers.filter(l => set_.has(l.id)))
      if (clipboard.length) toast(`${clipboard.length} レイヤーをコピーしました`)
    },

    paste: () => {
      const s = get()
      if (clipboardKind === 'keys' && keyClipboard.length) {
        // いちばん早いキーが再生位置に来るように貼る。1 レイヤーぶんのコピーは選んだレイヤーすべてへ、複数レイヤーぶんは元のレイヤーへ
        const f0 = Math.min(...keyClipboard.map(k => k.f))
        const srcLayers = [...new Set(keyClipboard.map(k => k.layerId))]
        const targets = srcLayers.length === 1 && s.sel.length ? s.sel.map(id => ({ from: srcLayers[0], to: id })) : srcLayers.map(id => ({ from: id, to: id }))
        const made: KeyRef[] = []
        let doc = s.doc
        for (const t of targets) {
          doc = updateLayer(doc, t.to, l => {
            if (l.locked) return l
            let n = l
            for (const k of keyClipboard) {
              if (k.layerId !== t.from) continue
              const f = k.f - f0 + s.frame
              n = setPath(n, k.path, setKey(getPath(n, k.path), f, structuredCloneSafe(k.v), k.e))
              made.push({ layerId: t.to, path: k.path, f })
            }
            return n
          })
        }
        if (doc === s.doc) { toast('貼る先のレイヤーがありません(レイヤーを選んでください)'); return }
        s.commit(doc)
        set({ selKeys: made })
        const ex = { ...get().expanded }
        for (const t of targets) ex[t.to] = true
        set({ expanded: ex })
        return
      }
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
        const row = { ...get().comp!, name: meta.name, rev: meta.rev, stale: meta.stale, stale_deep: meta.stale_deep }
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

    place: async (track) => {
      const s = get()
      if (!s.comp) return
      await s.flush()
      if (get().saveState === 'error') { toast('保存できていないので置けません', 'error'); return }
      try {
        const tl = useTimelineStore.getState()
        const at = tl.currentFrame
        let track_id: number | undefined = typeof track === 'number' ? track : undefined
        if (track === 'new') {
          // いちばん手前(order が最小)に新しい映像トラックを作る
          const orders = tl.tracks.map(t => t.order)
          const n = tl.tracks.filter(t => t.track_type === 'video').length + 1
          track_id = (await tl.addTrackAt(s.projectId, 'video', `Comp ${n}`, orders.length ? Math.min(...orders) - 1 : 0)).id
        }
        const r = await compsApi.place(s.comp.id, { start_frame: Math.max(0, Math.round(at)), render: true, ...(track_id != null ? { track_id } : {}) })
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
