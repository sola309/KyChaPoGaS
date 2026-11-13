// 🎞 コンポジション編集画面(全画面の重ね表示・遅延読み込み)。
// 上: プレビュー(iframe)+ 右の欄 / 下: レイヤーのタイムライン。一覧 → 編集、入れ子はパンくずで行き来する。
// three.js はプレビューの iframe の中だけで読む(このチャンクにも本体にも入らない)。
// 画面の大きさで並びを変える(mobile.ts): PC = 今までどおり / タブレット = PC の並びで押す所を大きく /
// スマホ = 上にプレビュー・下にタブの欄(横持ちは左右)。スマホの一覧からは、まず「見るだけ」の画面(CompViewer)が開く。

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
import { TouchUI, detectLayout, isPhoneLayout, useCompLayout, useKeyboardInset } from './mobile'
import { MobileLayers } from './MobileLayers'
import { CompViewer } from './CompViewer'
import { AddLayerMenu } from './AddLayerMenu'

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

// ── スマホの並び ──────────────────────────────────────────────────────────────

type MTab = 'layers' | 'props' | 'presets' | 'info' | 'json'
const MTABS: { id: MTab; label: string }[] = [
  { id: 'layers', label: 'レイヤー' }, { id: 'props', label: 'プロパティ' }, { id: 'presets', label: 'プリセット' }, { id: 'info', label: '情報' },
]

const staleOf = (comp: { stale_deep?: boolean; stale: boolean }, dirty: boolean) => (comp.stale_deep ?? comp.stale) || dirty

/** 描き出しの状態の印(未描き出し / 古い / 描き出し済み) */
function StaleBadge({ className = '' }: { className?: string }) {
  const comp = useCompStore(s => s.comp)
  const dirty = useCompStore(s => s.saveState !== 'saved')
  if (!comp) return null
  const stale = staleOf(comp, dirty)
  return (
    <span className={`px-2 py-0.5 rounded text-[12px] whitespace-nowrap ${stale ? 'bg-amber-900/70 text-amber-200' : 'bg-emerald-900/70 text-emerald-200'} ${className}`} data-comp-stale={stale ? '1' : '0'}>
      {comp.rendered_rev === 0 ? '未描き出し' : stale ? '古い' : '描き出し済み'}
    </span>
  )
}

/** スマホの見出しの右: 取り消し・やり直し・保存の印 */
function MobileHeaderTools() {
  const canUndo = useCompStore(s => s.undoStack.length > 0)
  const canRedo = useCompStore(s => s.redoStack.length > 0)
  const save = useCompStore(s => s.saveState)
  const st = useCompStore.getState
  const b = 'w-11 h-11 flex items-center justify-center rounded-lg text-[20px] text-zinc-200 active:bg-zinc-700 disabled:opacity-30 flex-shrink-0'
  return (
    <>
      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${save === 'saved' ? 'bg-emerald-500' : save === 'error' ? 'bg-red-500' : 'bg-amber-400 animate-pulse'}`} data-comp-save={save}
            role="img" aria-label={save === 'saved' ? '保存済み' : save === 'error' ? '保存エラー' : '保存中'} />
      <button className={b} disabled={!canUndo} aria-label="元に戻す" onClick={() => st().undo()} data-comp-undo>↶</button>
      <button className={b} disabled={!canRedo} aria-label="やり直す" onClick={() => st().redo()} data-comp-redo>↷</button>
    </>
  )
}

/** 描き出し・タイムラインに置く(スマホの「情報」タブと ⋯ メニューの両方で使う) */
function MobileActions({ onDone }: { onDone?: () => void }) {
  const comp = useCompStore(s => s.comp)
  const render = useCompStore(s => s.render)
  const dirty = useCompStore(s => s.saveState !== 'saved')
  const tracks = useTimelineStore(s => s.tracks)
  const tlFrame = useTimelineStore(s => s.currentFrame)
  const [placing, setPlacing] = useState(false)
  if (!comp) return null
  const stale = staleOf(comp, dirty)
  const video = tracks.filter(t => t.track_type === 'video').sort((a, b) => a.order - b.order)
  const comps = video.find(t => t.name === 'Comps')
  const go = (t?: number | 'new') => { setPlacing(false); void useCompStore.getState().place(t); onDone?.() }
  const big = 'w-full min-h-[48px] px-3 rounded-lg border text-[15px] text-left flex items-center gap-2 active:bg-zinc-800 disabled:opacity-50'
  const item = 'w-full min-h-[44px] px-3 text-[14px] text-left text-zinc-100 flex items-center gap-2 active:bg-purple-900 border-b border-zinc-800 last:border-b-0'
  return (
    <div className="flex flex-col gap-2" data-comp-mactions>
      <button className={`${big} ${stale && !render ? 'border-purple-500 bg-purple-900/40 text-white' : 'border-zinc-700 text-zinc-100'}`} disabled={!!render} data-comp-render
              onClick={() => void useCompStore.getState().startRender()}>
        <span className="flex-1">{render ? `🎬 描き出し中 ${render.status === 'pending' ? '(待機)' : `${Math.round(render.progress * 100)}%`}` : '🎬 描き出し(動画素材にする)'}</span>
        <StaleBadge />
      </button>
      {render && <div className="h-1.5 rounded bg-zinc-800 overflow-hidden"><div className="h-full bg-purple-500 transition-[width]" style={{ width: `${Math.round(render.progress * 100)}%` }} /></div>}
      <button className={`${big} border-zinc-700 text-zinc-100`} aria-expanded={placing} onClick={() => setPlacing(p => !p)} data-comp-place>
        <span className="flex-1">⤵ タイムラインに置く({Math.round(tlFrame)} コマ目)</span><span className="text-zinc-400">{placing ? '▾' : '▸'}</span>
      </button>
      {placing && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 overflow-hidden" data-comp-place-menu>
          <div className="px-3 py-1.5 text-[12px] text-zinc-400 border-b border-zinc-800">置き先のトラック(本体のタイムラインの再生位置に置きます)</div>
          <button className={item} data-place-track="default" onClick={() => go(comps?.id)}>🎞 <span className="flex-1">「Comps」トラック{comps ? '' : '(無ければ作る)'}</span><span className="text-[12px] text-zinc-400">既定</span></button>
          <button className={item} data-place-track="new" onClick={() => go('new')}>＋ <span className="flex-1">新しいトラック(いちばん手前)</span></button>
          {video.filter(t => t.id !== comps?.id).map(t => (
            <button key={t.id} className={item} data-place-track={t.id} onClick={() => go(t.id)}>
              <span className="flex-1 truncate">{t.name}</span>{t.hidden && <span className="text-[12px] text-zinc-400">非表示</span>}<span className="text-[12px] text-zinc-500 font-mono">#{t.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** スマホの「情報」タブ: 状態・描き出し・置く・設定 */
function MobileInfoTab({ onJson }: { onJson: () => void }) {
  const comp = useCompStore(s => s.comp)
  const settings = useCompStore(s => s.settings)
  const nLayers = useCompStore(s => s.doc.layers.length)
  const err = useCompStore(s => s.saveError)
  const save = useCompStore(s => s.saveState)
  if (!comp) return null
  return (
    <div className="flex-1 min-h-0 comp-scroll comp-safe-bottom" data-comp-minfo>
      <div className="px-3 py-3 flex flex-col gap-3">
        <div className="text-[13px] text-zinc-300 leading-relaxed">
          {settings.width}×{settings.height} · {settings.fps} fps · {settings.duration_frames} コマ({(settings.duration_frames / Math.max(1, settings.fps)).toFixed(2)} 秒)· {nLayers} レイヤー
          <div className="text-zinc-400 mt-0.5">
            {save === 'saved' ? '✓ 保存済み' : save === 'error' ? <button className="text-red-300 underline" onClick={() => void useCompStore.getState().flush()}>保存エラー: {err}(押すともう一度保存)</button> : '保存中…'}
            {' · '}版 r{comp.rev}(描き出しは r{comp.rendered_rev || '—'})
          </div>
        </div>
        <MobileActions />
      </div>
      <SettingsTab />
      <div className="px-3 py-3">
        <button className="w-full min-h-[44px] rounded-lg border border-zinc-700 text-[14px] text-zinc-200 active:bg-zinc-800" onClick={onJson} data-comp-open-json>🧾 JSON を見る・直す</button>
      </div>
    </div>
  )
}

/** ⋯ メニュー(下から出るシート) */
function MobileMenu({ onClose, onTab, onList, onExit }: { onClose: () => void; onTab: (t: MTab) => void; onList: () => void; onExit: () => void }) {
  const save = useCompStore(s => s.saveState)
  const err = useCompStore(s => s.saveError)
  const item = 'w-full min-h-[48px] px-3 rounded-lg border border-zinc-700 text-[15px] text-left text-zinc-100 flex items-center gap-2 active:bg-zinc-800'
  return (
    <div className="fixed inset-0 z-[120] bg-black/60 flex items-end justify-center" onPointerDown={onClose} data-comp-mmenu>
      <div className="w-full max-w-[520px] max-h-[86%] comp-scroll rounded-t-2xl border border-b-0 border-zinc-700 bg-zinc-900 p-3 flex flex-col gap-2 comp-safe-bottom" onPointerDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 text-[13px] text-zinc-300 px-1">
          <span className="flex-1" data-comp-save-text>
            {save === 'saved' ? '✓ 保存済み(変更は自動で保存されます)' : save === 'error' ? `保存エラー: ${err ?? ''}` : '保存中…'}
          </span>
          {save === 'error' && <button className="px-3 h-10 rounded-lg border border-red-700 text-red-200" onClick={() => void useCompStore.getState().flush()}>もう一度保存</button>}
          <button className="w-11 h-11 text-[18px] text-zinc-300" aria-label="閉じる" onClick={onClose}>✕</button>
        </div>
        <MobileActions onDone={onClose} />
        <div className="grid grid-cols-2 gap-2">
          <button className={item} onClick={() => { onTab('info'); onClose() }} data-mmenu="settings">⚙ 設定</button>
          <button className={item} onClick={() => { onTab('json'); onClose() }} data-mmenu="json">🧾 JSON</button>
          <button className={item} onClick={() => { onClose(); onList() }} data-mmenu="list">🎞 一覧へ</button>
          <button className={item} onClick={() => { onClose(); onExit() }} data-comp-close>✕ 編集画面を閉じる</button>
        </div>
      </div>
    </div>
  )
}

/** 窓の大きさ(少し待ってから。プレビューの高さの計算用) */
function useWindowSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    let t: number | null = null
    const on = () => { if (t != null) window.clearTimeout(t); t = window.setTimeout(() => { t = null; setSize(p => (p.w === window.innerWidth && p.h === window.innerHeight ? p : { w: window.innerWidth, h: window.innerHeight })) }, 150) }
    window.addEventListener('resize', on)
    return () => { if (t != null) window.clearTimeout(t); window.removeEventListener('resize', on) }
  }, [])
  return size
}

/** スマホの編集画面の中身(プレビュー + タブの欄)。タブの中身は開いたものだけ作る */
function MobileWorkspace({ compId, wide, kb, tab, setTab, onOpenChild }: {
  compId: number; wide: boolean; kb: boolean; tab: MTab; setTab: (t: MTab) => void; onOpenChild: (id: number) => void
}) {
  const width = useCompStore(s => s.settings.width)
  const height = useCompStore(s => s.settings.height)
  const nSel = useCompStore(s => s.sel.length)
  const win = useWindowSize()
  const [small, setSmall] = useState(false)       // プレビューを小さくして欄を広げる
  // 縦持ち: 幅いっぱい・縦横比どおり。高すぎる絵(縦長・正方形)は画面の 42% まで。欄を広げたとき・キーボードが出ている間は小さく
  const full = Math.min(win.w * (height / Math.max(1, width)), win.h * 0.42)
  const stageH = Math.round(kb ? Math.min(full, 96) : small ? Math.min(full, Math.max(96, win.h * 0.16)) : full)

  const tabs = (
    <div className="flex items-stretch border-y border-zinc-800 bg-zinc-900 flex-shrink-0" role="tablist" data-comp-mtabs>
      {MTABS.map(t => (
        <button key={t.id} role="tab" aria-selected={tab === t.id} data-comp-tab={t.id} onClick={() => setTab(t.id)}
                className={`flex-1 min-w-0 h-11 text-[14px] whitespace-nowrap ${tab === t.id || (t.id === 'info' && tab === 'json') ? 'text-purple-100 border-b-2 border-purple-500 bg-zinc-950 font-bold' : 'text-zinc-400 border-b-2 border-transparent'}`}>
          {t.label}{t.id === 'props' && nSel > 0 && <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-purple-400 align-middle" />}
        </button>
      ))}
      {!wide && (
        <button className="w-11 h-11 flex-shrink-0 text-[16px] text-zinc-300 border-l border-zinc-800" aria-label={small ? 'プレビューを大きく' : '欄を広げる(プレビューを小さく)'} aria-pressed={small}
                onClick={() => setSmall(v => !v)} data-comp-panel-size>{small ? '▼' : '▲'}</button>
      )}
    </div>
  )
  const panel = (
    <div className="flex-1 min-h-0 flex flex-col bg-zinc-950" data-comp-mpanel={tab}>
      {tab === 'layers' ? <MobileLayers key={compId} onProps={() => setTab('props')} onPresets={() => setTab('presets')} onOpenChild={onOpenChild} />
        : tab === 'props' ? <Inspector />
        : tab === 'presets' ? <PresetsTab />
        : tab === 'info' ? <MobileInfoTab onJson={() => setTab('json')} />
        : <JsonTab />}
      {/* 素材を選ぶダイアログの受け口(レイヤーの一覧を出していない間も「選ぶ…」が効くように) */}
      {tab !== 'layers' && <span className="hidden"><AddLayerMenu /></span>}
    </div>
  )
  return wide ? (
    <div className="flex flex-1 min-h-0">
      <PreviewPane key={compId} compId={compId} compact="landscape" defaultQuality={0.5} />
      <div className="w-[46%] min-w-[300px] max-w-[420px] flex-shrink-0 border-l border-zinc-800 flex flex-col min-h-0">{tabs}{panel}</div>
    </div>
  ) : (
    <div className="flex flex-col flex-1 min-h-0">
      <PreviewPane key={compId} compId={compId} compact="portrait" stageHeight={stageH} defaultQuality={0.5} hideTransport={kb} />
      {tabs}{panel}
    </div>
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
  const layout = useCompLayout()
  const phone = isPhoneLayout(layout)
  const touch = layout !== 'desktop'
  // スマホでは、開く合図(タイムラインのクリップ・一覧のカード)はまず「見るだけ」の画面へ。編集はそこから
  const [startPhone] = useState(phone)
  const [stack, setStack] = useState<number[]>(initialCompId != null && !startPhone ? [initialCompId] : [])
  const [viewId, setViewId] = useState<number | null>(initialCompId != null && startPhone ? initialCompId : null)
  const [mtab, setMtab] = useState<MTab>('layers')
  const [menuOpen, setMenuOpen] = useState(false)
  const kb = useKeyboardInset(phone)
  const [tab, setTab] = useState<Tab>('props')
  const [tlH, setTlH] = useState(() => Math.round(Math.min(detectLayout() === 'tablet' ? 560 : 420, Math.max(220, window.innerHeight * (detectLayout() === 'tablet' ? 0.4 : 0.36)))))
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

  // 指で触る並びの間だけ、押す所を大きくする CSS(index.css の body.comp-touch)を効かせる
  useEffect(() => {
    if (!touch) return
    document.body.classList.add('comp-touch')
    return () => document.body.classList.remove('comp-touch')
  }, [touch])

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
  const nameOf = (id: number, last: boolean) => (last && comp?.id === id ? comp.name : byId[id]?.name) ?? `#${id}`

  const bannerEl = banner && (
    <div className="px-3 py-1.5 text-[11px] text-red-200 bg-red-950/70 border-b border-red-900 flex items-center gap-2 flex-shrink-0" data-comp-banner>
      <span className="flex-1">⚠ {banner}</span>
      <button className="text-red-300 hover:text-white" onClick={() => useCompStore.getState().setBanner(null)}>✕</button>
    </div>
  )

  // ── スマホ(縦・横) ──────────────────────────────────────────────────────────
  if (phone) {
    const wide = layout === 'phoneWide'
    const editing = currentId != null
    const viewing = !editing && viewId != null
    const toList = () => { void useCompStore.getState().flush(); setStack([]); setViewId(null) }
    // 戻る: 入れ子の子 → 親 → (見るだけの画面 →)一覧 → 閉じる
    const back = () => {
      if (stack.length > 1) setStack(stack.slice(0, -1))
      else if (editing) { void useCompStore.getState().flush(); setStack([]) }
      else if (viewing) setViewId(null)
      else close()
    }
    const title = editing ? nameOf(currentId, true) : viewing ? (byId[viewId]?.name ?? `#${viewId}`) : '🎞 コンポジション'
    const sub = editing ? (stack.length > 1 ? `${nameOf(stack[stack.length - 2], false)} の中` : '編集') : viewing ? '見るだけ(軽い)' : `${Object.keys(byId).length} 件`
    const hb = 'h-11 flex items-center justify-center rounded-lg text-zinc-200 active:bg-zinc-700 flex-shrink-0'
    return createPortal(
      <TouchUI.Provider value={true}>
        <div ref={rootRef} tabIndex={-1} data-comp-editor data-comp-layout={layout}
             className="fixed inset-x-0 top-0 comp-vh comp-safe z-[45] flex flex-col bg-zinc-950 text-zinc-100 outline-none overflow-hidden">
          <div className={`flex items-center gap-1 pl-1 pr-1 ${wide ? 'h-11' : 'h-12'} border-b border-zinc-800 bg-zinc-900 flex-shrink-0`} data-comp-mheader>
            <button className={`${hb} w-11 text-[26px] leading-none`} aria-label={editing || viewing ? '戻る' : '閉じる'} onClick={back} data-comp-back>{editing || viewing ? '‹' : '✕'}</button>
            <div className="flex-1 min-w-0 flex flex-col justify-center leading-tight" data-comp-breadcrumb>
              <span className="text-[15px] font-bold text-white truncate">{title}</span>
              {!wide && <span className="text-[12px] text-zinc-400 truncate">{sub}</span>}
            </div>
            {editing && ready && (<>
              <MobileHeaderTools />
              <button className={`${hb} w-11 text-[22px]`} aria-label="メニュー(保存・描き出し・置く・設定)" onClick={() => setMenuOpen(true)} data-comp-menu-btn>⋯</button>
            </>)}
            {viewing && <button className={`${hb} px-3 text-[14px] font-bold bg-purple-700 text-white active:bg-purple-600`} onClick={() => setStack([viewId])} data-comp-edit>✏ 編集</button>}
          </div>
          {bannerEl}
          {editing ? (
            loadError ? <div className="flex-1 flex items-center justify-center p-6 text-[14px] text-red-300">開けません: {loadError}</div>
            : !ready || loading ? <div className="flex-1 flex items-center justify-center text-[14px] text-zinc-400">読み込み中…</div>
            : <MobileWorkspace compId={currentId} wide={wide} kb={kb} tab={mtab} setTab={setMtab} onOpenChild={openChild} />
          ) : viewing ? (
            <CompViewer key={viewId} compId={viewId} wide={wide} onEdit={() => setStack([viewId])} />
          ) : (
            <CompList projectId={projectId} layout={layout} onOpen={id => { setViewId(null); setStack([id]) }} onView={id => setViewId(id)} />
          )}
          {menuOpen && editing && <MobileMenu onClose={() => setMenuOpen(false)} onTab={setMtab} onList={toList} onExit={close} />}
        </div>
      </TouchUI.Provider>,
      document.body,
    )
  }

  // ── PC・タブレット(タブレットは同じ並びで、押す所を大きく) ──────────────────────
  return createPortal(
    <TouchUI.Provider value={touch}>
    <div ref={rootRef} tabIndex={-1} data-comp-editor data-comp-layout={layout}
         className={`fixed z-[45] flex flex-col bg-zinc-950 text-zinc-100 outline-none ${touch ? 'inset-x-0 top-0 comp-vh comp-safe' : 'inset-0'}`}
         onChangeCapture={e => { const t = e.target as HTMLElement; if (t.tagName === 'SELECT') window.setTimeout(() => t.blur(), 0) }}>
      {/* 見出し: パンくず + 保存の状態 + 描き出し */}
      <div className={`flex items-center gap-2 px-3 border-b border-zinc-800 bg-zinc-900 flex-shrink-0 ${touch ? 'min-h-[48px] py-1 flex-wrap' : 'h-9'}`}>
        <nav className="flex items-center gap-1 text-xs min-w-0" data-comp-breadcrumb>
          <button className={`px-1.5 py-0.5 rounded hover:bg-zinc-800 ${stack.length || viewId != null ? 'text-zinc-400' : 'text-white font-bold'}`} onClick={() => { setStack([]); setViewId(null) }}>🎞 コンポジション</button>
          {!stack.length && viewId != null && (
            <span className="flex items-center gap-1 min-w-0"><span className="text-zinc-600">›</span><span className="px-1.5 py-0.5 truncate max-w-[240px] text-white font-bold">{byId[viewId]?.name ?? `#${viewId}`}</span></span>
          )}
          {stack.map((id, i) => (
            <span key={id} className="flex items-center gap-1 min-w-0">
              <span className="text-zinc-600">›</span>
              <button className={`px-1.5 py-0.5 rounded hover:bg-zinc-800 truncate max-w-[240px] ${i === stack.length - 1 ? 'text-white font-bold' : 'text-zinc-400'}`}
                      onClick={() => setStack(stack.slice(0, i + 1))} title={i === stack.length - 1 ? '' : 'ここへ戻る'}>
                {nameOf(id, i === stack.length - 1)}
              </button>
            </span>
          ))}
          {ready && comp && <span className="text-[10px] text-zinc-500 font-mono ml-2 max-lg:hidden">{useCompStore.getState().settings.width}×{useCompStore.getState().settings.height}</span>}
        </nav>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {currentId != null ? <HeaderActions onClose={close} /> : <button className={btnCls} onClick={close} data-comp-close>✕ 閉じる</button>}
        </div>
      </div>

      {bannerEl}
      {currentId == null && viewId != null ? (
        <CompViewer key={viewId} compId={viewId} wide onEdit={() => { const id = viewId; setViewId(null); setStack([id]) }} />
      ) : currentId == null ? (
        <CompList projectId={projectId} layout={layout} onOpen={id => setStack([id])} onView={touch ? id => setViewId(id) : undefined} />
      ) : loadError ? (
        <div className="flex-1 flex items-center justify-center text-xs text-red-300">開けません: {loadError}</div>
      ) : !ready || loading ? (
        <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">読み込み中…</div>
      ) : (
        <>
          <div className="flex flex-1 min-h-0">
            {/* タブレット: 再生の段は指むけ(スライダー + 大きいボタン + ⚙)。PC は今までどおり */}
            <PreviewPane key={currentId} compId={currentId} compact={touch ? 'landscape' : undefined} />
            <div className={`${touch ? 'w-[380px]' : 'w-[360px] max-lg:w-[300px]'} flex-shrink-0 border-l border-zinc-800 flex flex-col min-h-0 bg-zinc-950`}>
              <div className="flex border-b border-zinc-800 flex-shrink-0">
                {TABS.map(t => (
                  <button key={t.id} data-comp-tab={t.id} onClick={() => setTab(t.id)}
                          className={`flex-1 text-[11px] py-1.5 ${tab === t.id ? 'text-purple-200 border-b-2 border-purple-500 bg-zinc-900' : 'text-zinc-500 hover:text-zinc-200'}`}>{t.label}</button>
                ))}
              </div>
              {tab === 'props' ? <Inspector /> : tab === 'presets' ? <PresetsTab /> : tab === 'settings' ? <SettingsTab /> : <JsonTab />}
            </div>
          </div>
          <div className={`${touch ? 'h-3' : 'h-1.5'} flex-shrink-0 bg-zinc-800 hover:bg-purple-700 cursor-row-resize`} style={{ touchAction: 'none' }} onPointerDown={onDivider} title="タイムラインの高さを調整" />
          <div className="flex-shrink-0 flex flex-col border-t border-zinc-800" style={{ height: tlH }}>
            <LayerTimeline onOpenChild={openChild} />
          </div>
        </>
      )}
    </div>
    </TouchUI.Provider>,
    document.body,
  )
}
