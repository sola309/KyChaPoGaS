// 🎞 コンポジション編集画面(全画面の重ね表示・遅延読み込み)。
// 上: プレビュー(iframe)+ 右の欄 / 下: レイヤーのタイムライン。一覧 → 編集、入れ子はパンくずで行き来する。
// three.js はプレビューの iframe の中だけで読む(このチャンクにも本体にも入らない)。

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCompStore } from './store'
import { useCompListStore } from './compList'
import { useTimelineStore } from '../../store/timelineStore'
import { CompList } from './CompList'
import { PreviewPane } from './PreviewPane'
import { LayerTimeline } from './LayerTimeline'
import { Inspector } from './Inspector'
import { JsonTab, PresetsTab, SettingsTab } from './SidePanels'
import { btnCls } from './fields'
import { handleCompKey } from './keys'

type Tab = 'props' | 'presets' | 'settings' | 'json'
const TABS: { id: Tab; label: string }[] = [
  { id: 'props', label: 'プロパティ' }, { id: 'presets', label: 'プリセット' }, { id: 'settings', label: '設定' }, { id: 'json', label: 'JSON' },
]

function SaveBadge() {
  const state = useCompStore(s => s.saveState)
  const err = useCompStore(s => s.saveError)
  const flush = useCompStore(s => s.flush)
  if (state === 'error') {
    return <button className="text-[10px] text-red-300 flex items-center gap-1 max-w-[360px]" title={`${err ?? ''}(クリックでもう一度保存)`} onClick={() => void flush()} data-comp-save="error">
      <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" /><span className="truncate">保存エラー: {err}</span></button>
  }
  if (state === 'saved') return <span className="text-[10px] text-zinc-500" data-comp-save="saved">✓ 保存済み</span>
  return <span className="text-[10px] text-amber-400 flex items-center gap-1" data-comp-save={state}><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />保存中…</span>
}

function HeaderActions({ onClose }: { onClose: () => void }) {
  const comp = useCompStore(s => s.comp)
  const render = useCompStore(s => s.render)
  const canUndo = useCompStore(s => s.undoStack.length > 0)
  const canRedo = useCompStore(s => s.redoStack.length > 0)
  const dirty = useCompStore(s => s.saveState !== 'saved')
  const st = useCompStore.getState
  const tlFrame = useTimelineStore(s => s.currentFrame)
  if (!comp) return <button className={btnCls} onClick={onClose}>✕ 閉じる</button>
  const stale = (comp.stale_deep ?? comp.stale) || dirty
  return (
    <>
      <button className={btnCls} disabled={!canUndo} title="元に戻す(Ctrl+Z)" onClick={() => st().undo()} data-comp-undo>↶</button>
      <button className={btnCls} disabled={!canRedo} title="やり直す(Ctrl+Shift+Z)" onClick={() => st().redo()} data-comp-redo>↷</button>
      <SaveBadge />
      <span className={`text-[10px] px-1.5 py-0.5 rounded ${stale ? 'bg-amber-900/70 text-amber-200' : 'bg-emerald-900/70 text-emerald-200'}`} data-comp-stale={stale ? '1' : '0'}
            title={stale ? '中身が、描き出した動画より新しい(タイムラインのクリップは古い絵のまま)' : 'タイムラインのクリップは今の中身と同じ絵です'}>
        {comp.rendered_rev === 0 ? '未描き出し' : stale ? '古い' : '描き出し済み'}
      </span>
      <button className={`${btnCls} ${stale && !render ? 'border-purple-500 text-purple-100' : ''}`} disabled={!!render} onClick={() => void st().startRender()} data-comp-render
              title="今の中身を動画素材に描き出す(置いてあるクリップも新しい絵に差し替わる)">
        {render ? `描き出し中 ${render.status === 'pending' ? '(待機)' : `${Math.round(render.progress * 100)}%`}` : '🎬 描き出し'}
      </button>
      <PlaceButton tlFrame={tlFrame} />
      <button className={btnCls} onClick={onClose} data-comp-close title="保存して閉じる">✕ 閉じる</button>
    </>
  )
}

/** 「タイムラインに置く」: 置き先のトラックを選ぶ(本体の映像トラック・新しいトラック・既定の「Comps」) */
function PlaceButton({ tlFrame }: { tlFrame: number }) {
  const [open, setOpen] = useState(false)
  const tracks = useTimelineStore(s => s.tracks)
  const boxRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])
  const video = tracks.filter(t => t.track_type === 'video').sort((a, b) => a.order - b.order)
  const comps = video.find(t => t.name === 'Comps')
  const go = (t?: number | 'new') => { setOpen(false); void useCompStore.getState().place(t) }
  const itemCls = 'w-full text-left px-3 py-1 text-[11px] text-zinc-200 hover:bg-purple-800 flex items-center gap-2'
  return (
    <span className="relative" ref={boxRef}>
      <button className={btnCls} onClick={() => setOpen(o => !o)} data-comp-place
              title={`本体のタイムラインの再生位置(${Math.round(tlFrame)} コマ目)に、このコンポジションのクリップを置く(置き先のトラックを選べます)`}>⤵ タイムラインに置く ▾</button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-[200] w-[260px] py-1 rounded-md border border-zinc-600 bg-zinc-900 shadow-2xl max-h-[60vh] overflow-y-auto" data-comp-place-menu>
          <div className="px-3 py-0.5 text-[9px] text-zinc-500">{Math.round(tlFrame)} コマ目に置く — 置き先のトラック</div>
          <button className={itemCls} data-place-track="default" onClick={() => go(comps?.id)}>🎞 <span className="flex-1">「Comps」トラック{comps ? '' : '(無ければ作る)'}</span><span className="text-[9px] text-zinc-500">既定</span></button>
          <button className={itemCls} data-place-track="new" onClick={() => go('new')}>＋ <span className="flex-1">新しいトラック(いちばん手前に作る)</span></button>
          <div className="border-t border-zinc-700 my-1" />
          {video.filter(t => t.id !== comps?.id).map(t => (
            <button key={t.id} className={itemCls} data-place-track={t.id} onClick={() => go(t.id)}>
              <span className="flex-1 truncate">{t.name}</span>{t.hidden && <span className="text-[9px] text-zinc-500">非表示</span>}<span className="text-[9px] text-zinc-600 font-mono">#{t.id}</span>
            </button>
          ))}
          {video.length === 0 && <div className="px-3 py-1 text-[10px] text-zinc-500">映像トラックがまだありません</div>}
        </div>
      )}
    </span>
  )
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'range', 'color', 'button'].includes((el as HTMLInputElement).type)
  return false
}

export function CompEditor({ projectId, initialCompId, onClose }: { projectId: number; initialCompId: number | null; onClose: () => void }) {
  const [stack, setStack] = useState<number[]>(initialCompId != null ? [initialCompId] : [])
  const [tab, setTab] = useState<Tab>('props')
  const [tlH, setTlH] = useState(() => Math.round(Math.min(420, Math.max(220, window.innerHeight * 0.36))))
  const rootRef = useRef<HTMLDivElement>(null)
  const currentId = stack.length ? stack[stack.length - 1] : null
  const comp = useCompStore(s => s.comp)
  const loading = useCompStore(s => s.loading)
  const loadError = useCompStore(s => s.loadError)
  const byId = useCompListStore(s => s.byId)
  const banner = useCompStore(s => s.banner)

  // 開いたら本体の側のフォーカスを外す(下に隠れたボタンが Space で押されないように)
  useEffect(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    rootRef.current?.focus()
    void useCompListStore.getState().load(projectId)
  }, [projectId])

  useEffect(() => {
    if (currentId != null) void useCompStore.getState().open(projectId, currentId)
    else void useCompStore.getState().close()
  }, [projectId, currentId])

  // 閉じるとき・ページを離れるときに必ず保存する
  useEffect(() => {
    const onHide = () => useCompStore.getState().flushOnUnload()
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
      void useCompStore.getState().close().then(() => useCompListStore.getState().load(projectId))
    }
  }, [projectId])

  const openChild = useCallback((id: number) => {
    setStack(s => (s[s.length - 1] === id ? s : s.includes(id) ? s.slice(0, s.indexOf(id) + 1) : [...s, id]))
  }, [])
  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent).detail?.compId; if (typeof id === 'number') openChild(id) }
    window.addEventListener('kychapogas:comp-open-child', on)
    return () => window.removeEventListener('kychapogas:comp-open-child', on)
  }, [openChild])

  // キー操作。body で受けて、本体(window に付いているタイムラインのショートカット)へは渡さない
  useEffect(() => {
    const body = document.body
    const stop = (e: Event) => e.stopPropagation()
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (isTyping(e.target)) return
      if (handleCompKey({ key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }, !!window.getSelection()?.toString())) e.preventDefault()
    }
    body.addEventListener('keydown', onKey)
    for (const t of ['keyup', 'keypress', 'paste', 'copy', 'cut']) body.addEventListener(t, stop)
    return () => {
      body.removeEventListener('keydown', onKey)
      for (const t of ['keyup', 'keypress', 'paste', 'copy', 'cut']) body.removeEventListener(t, stop)
    }
  }, [])

  const onDivider = (e: React.PointerEvent) => {
    e.preventDefault()
    const y0 = e.clientY, h0 = tlH
    const onMove = (ev: PointerEvent) => setTlH(Math.max(120, Math.min(window.innerHeight - 220, h0 + (y0 - ev.clientY))))
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const close = () => { void useCompStore.getState().flush().finally(onClose) }
  const ready = currentId != null && comp?.id === currentId

  return createPortal(
    <div ref={rootRef} tabIndex={-1} data-comp-editor
         className="fixed inset-0 z-[45] flex flex-col bg-zinc-950 text-zinc-100 outline-none"
         onChangeCapture={e => { const t = e.target as HTMLElement; if (t.tagName === 'SELECT') window.setTimeout(() => t.blur(), 0) }}>
      {/* 見出し: パンくず + 保存の状態 + 描き出し */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
        <nav className="flex items-center gap-1 text-xs min-w-0" data-comp-breadcrumb>
          <button className={`px-1.5 py-0.5 rounded hover:bg-zinc-800 ${stack.length ? 'text-zinc-400' : 'text-white font-bold'}`} onClick={() => setStack([])}>🎞 コンポジション</button>
          {stack.map((id, i) => (
            <span key={id} className="flex items-center gap-1 min-w-0">
              <span className="text-zinc-600">›</span>
              <button className={`px-1.5 py-0.5 rounded hover:bg-zinc-800 truncate max-w-[240px] ${i === stack.length - 1 ? 'text-white font-bold' : 'text-zinc-400'}`}
                      onClick={() => setStack(stack.slice(0, i + 1))} title={i === stack.length - 1 ? '' : 'ここへ戻る'}>
                {(i === stack.length - 1 && comp?.id === id ? comp.name : byId[id]?.name) ?? `#${id}`}
              </button>
            </span>
          ))}
          {ready && comp && <span className="text-[10px] text-zinc-500 font-mono ml-2 max-lg:hidden">{useCompStore.getState().settings.width}×{useCompStore.getState().settings.height}</span>}
        </nav>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {currentId != null ? <HeaderActions onClose={close} /> : <button className={btnCls} onClick={close} data-comp-close>✕ 閉じる</button>}
        </div>
      </div>

      {banner && (
        <div className="px-3 py-1.5 text-[11px] text-red-200 bg-red-950/70 border-b border-red-900 flex items-center gap-2 flex-shrink-0" data-comp-banner>
          <span className="flex-1">⚠ {banner}</span>
          <button className="text-red-300 hover:text-white" onClick={() => useCompStore.getState().setBanner(null)}>✕</button>
        </div>
      )}
      {currentId == null ? (
        <CompList projectId={projectId} onOpen={id => setStack([id])} />
      ) : loadError ? (
        <div className="flex-1 flex items-center justify-center text-xs text-red-300">開けません: {loadError}</div>
      ) : !ready || loading ? (
        <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">読み込み中…</div>
      ) : (
        <>
          <div className="flex flex-1 min-h-0">
            <PreviewPane key={currentId} compId={currentId} />
            <div className="w-[360px] max-lg:w-[300px] flex-shrink-0 border-l border-zinc-800 flex flex-col min-h-0 bg-zinc-950">
              <div className="flex border-b border-zinc-800 flex-shrink-0">
                {TABS.map(t => (
                  <button key={t.id} data-comp-tab={t.id} onClick={() => setTab(t.id)}
                          className={`flex-1 text-[11px] py-1.5 ${tab === t.id ? 'text-purple-200 border-b-2 border-purple-500 bg-zinc-900' : 'text-zinc-500 hover:text-zinc-200'}`}>{t.label}</button>
                ))}
              </div>
              {tab === 'props' ? <Inspector /> : tab === 'presets' ? <PresetsTab /> : tab === 'settings' ? <SettingsTab /> : <JsonTab />}
            </div>
          </div>
          <div className="h-1.5 flex-shrink-0 bg-zinc-800 hover:bg-purple-700 cursor-row-resize" style={{ touchAction: 'none' }} onPointerDown={onDivider} title="タイムラインの高さを調整" />
          <div className="flex-shrink-0 flex flex-col border-t border-zinc-800" style={{ height: tlH }}>
            <LayerTimeline onOpenChild={openChild} />
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
