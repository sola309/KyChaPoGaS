// 🎞 コンポジションの一覧(作る・名前を変える・複製・削除・設定)。

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { compsApi, apiErrorText } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import { useUIStore } from '../../store/uiStore'
import { useCompListStore } from './compList'
import type { CompSummary } from './types'
import { ColorField, NumField, Row, btnCls, inputCls } from './fields'
import { isPhoneLayout, type CompLayout } from './mobile'

interface FormValue { name: string; width: number; height: number; fps: number; duration_frames: number; bg: string | null }

function SettingsDialog({ title, initial, okLabel, onOk, onClose }: {
  title: string; initial: FormValue; okLabel: string; onOk: (v: FormValue) => Promise<void>; onClose: () => void
}) {
  const [v, setV] = useState<FormValue>(initial)
  const [busy, setBusy] = useState(false)
  const set = (p: Partial<FormValue>) => setV(x => ({ ...x, ...p }))
  const submit = async () => {
    setBusy(true)
    try { await onOk({ ...v, name: v.name.trim() || 'コンポジション' }); onClose() } catch { /* 文面は呼び出し側が出す */ } finally { setBusy(false) }
  }
  return createPortal(
    <div className="fixed inset-0 z-[210] bg-black/70 flex items-center justify-center p-6 max-sm:p-3" onPointerDown={onClose} data-comp-settings-dialog>
      <div className="w-[380px] max-w-full max-h-full overflow-y-auto overscroll-contain rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-3 flex flex-col gap-2" onPointerDown={e => e.stopPropagation()}>
        <div className="text-xs font-bold text-zinc-200 mb-1">{title}</div>
        <Row label="名前"><input autoFocus className={`${inputCls} flex-1`} value={v.name} onChange={e => set({ name: e.target.value })}
                               onKeyDown={e => { if (e.key === 'Enter') void submit() }} /></Row>
        <Row label="大きさ(px)">
          <NumField prefix="W" value={v.width} min={2} max={8192} step={2} onChange={x => set({ width: Math.round(x) })} />
          <NumField prefix="H" value={v.height} min={2} max={8192} step={2} onChange={x => set({ height: Math.round(x) })} />
        </Row>
        <Row label="fps"><NumField value={v.fps} min={1} max={120} step={1} onChange={x => set({ fps: x })} /></Row>
        <Row label="長さ(コマ)">
          <NumField value={v.duration_frames} min={1} max={100000} step={1} onChange={x => set({ duration_frames: Math.round(x) })} />
          <span className="text-[10px] text-zinc-500">{(v.duration_frames / Math.max(1, v.fps)).toFixed(2)} 秒</span>
        </Row>
        <Row label="背景" title="チェックなし = 透明(下のトラックが透ける)">
          <ColorField value={v.bg} nullable fallback="#000000" onChange={bg => set({ bg })} />
          {v.bg == null && <span className="text-[10px] text-zinc-500">透明</span>}
        </Row>
        <div className="flex justify-end gap-2 mt-2">
          <button className={btnCls} onClick={onClose}>やめる</button>
          <button className={`${btnCls} border-purple-500 text-purple-100 bg-purple-900/50`} disabled={busy} onClick={() => void submit()} data-comp-settings-ok>{okLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── 一覧の絵(GET /api/comps/{id}/thumb)。見えたカードから、同時に 2 枚までしか取りに行かない ──
// (描き出していないコンポジションでも 1 コマ出る。初回は 1 枚 2 秒ほどかかるので、48 枚を一度に頼まない)
const THUMB_MAX = 2
let thumbBusy = 0
const thumbQueue: { run: () => void; alive: () => boolean }[] = []
function thumbPump() {
  while (thumbBusy < THUMB_MAX && thumbQueue.length) {
    const job = thumbQueue.shift()!
    if (!job.alive()) continue
    thumbBusy++
    job.run()
  }
}
const thumbDone = new Set<string>()      // 一度読めた URL(ブラウザのキャッシュにあるので、次からは並ばずに出す)

function CompThumb({ comp }: { comp: CompSummary }) {
  const url = `/api/comps/${comp.id}/thumb?width=480&r=${comp.rev}`
  const boxRef = useRef<HTMLDivElement>(null)
  // 状態は URL ごと(版が変わったら待ちからやり直す)。一度読めた URL はすぐ出す
  const [got, setGot] = useState<{ url: string; st: 'load' | 'ok' | 'err' } | null>(null)
  const state: 'wait' | 'load' | 'ok' | 'err' = thumbDone.has(url) ? 'ok' : got?.url === url ? got.st : 'wait'
  useEffect(() => {
    if (thumbDone.has(url)) return
    const setState = (st: 'load' | 'ok' | 'err') => setGot({ url, st })
    const el = boxRef.current
    if (!el) return
    let alive = true, started = false, finished = false
    const finish = (ok: boolean) => {
      if (finished) return
      finished = true
      thumbBusy = Math.max(0, thumbBusy - 1)
      if (ok) thumbDone.add(url)
      if (alive) setState(ok ? 'ok' : 'err')
      thumbPump()
    }
    const io = new IntersectionObserver(es => {
      if (started || !es.some(e => e.isIntersecting)) return
      started = true
      io.disconnect()
      thumbQueue.push({
        alive: () => alive,
        run: () => {
          if (alive) setState('load')
          const img = new Image()
          img.onload = () => finish(true)
          img.onerror = () => finish(false)
          img.src = url
        },
      })
      thumbPump()
    }, { rootMargin: '120px' })
    io.observe(el)
    // 途中で外れても、読み込みは最後まで待ってから枠を返す(同時 2 枚を守る)
    return () => { alive = false; io.disconnect() }
  }, [url])
  return (
    <div ref={boxRef} className="w-full h-full flex items-center justify-center" data-comp-thumb={state}>
      {state === 'ok'
        ? <img src={url} alt="" className="max-w-full max-h-full object-contain" style={{ background: 'repeating-conic-gradient(#2a2a2e 0% 25%, #1c1c1f 0% 50%) 50% / 16px 16px' }} />
        : <span className={`text-3xl opacity-40 ${state === 'load' ? 'animate-pulse' : ''}`}>🎞</span>}
    </div>
  )
}

const isStale = (c: CompSummary) => c.stale_deep ?? c.stale

/**
 * layout: 画面の並び(省略 = PC)。スマホ・タブレットでは大きなカード + 検索、カードを押すと「見るだけ」の画面(onView)。
 */
export function CompList({ projectId, onOpen, onView, layout = 'desktop' }: { projectId: number; onOpen: (id: number) => void; onView?: (id: number) => void; layout?: CompLayout }) {
  const list = useCompListStore(s => s.list)
  const loading = useCompListStore(s => s.loading)
  const load = useCompListStore(s => s.load)
  const project = useProjectStore(s => s.activeProject)
  const toast = useUIStore(s => s.pushToast)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<{ comp: CompSummary; bg: string | null } | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [moreId, setMoreId] = useState<number | null>(null)
  const phone = isPhoneLayout(layout)
  const touch = layout !== 'desktop'
  const view = onView ?? onOpen
  const needle = query.trim().toLowerCase()
  const shown = needle ? list.filter(c => c.name.toLowerCase().includes(needle) || `#${c.id}`.includes(needle)) : list

  useEffect(() => { void load(projectId) }, [projectId, load])

  const rename = async () => {
    const r = renaming
    setRenaming(null)
    if (!r || !r.name.trim()) return
    const cur = list.find(c => c.id === r.id)
    if (!cur || cur.name === r.name.trim()) return
    try { await compsApi.update(r.id, { name: r.name.trim() }); await load(projectId) } catch { /* トーストは client */ }
  }
  const del = async (c: CompSummary) => {
    if (!window.confirm(`コンポジション「${c.name}」を削除しますか?(元に戻せません)`)) return
    setError(null)
    try { await compsApi.delete(c.id, true); await load(projectId) }
    catch (e) { setError(`「${c.name}」を削除できません: ${apiErrorText(e)}`) }
  }
  const openSettings = async (c: CompSummary) => {
    try { const full = await compsApi.get(c.id); setEditing({ comp: c, bg: full.data?.bg ?? null }) } catch { /* トーストは client */ }
  }

  const badge = (c: CompSummary, cls: string) => (
    <span className={`${cls} rounded ${isStale(c) ? 'bg-amber-600 text-black' : 'bg-emerald-700 text-white'}`} data-comp-badge
          title={isStale(c) && c.rendered_rev !== 0 && !c.stale ? '入れ子の子コンポジションが変わった(または描き出したファイルが無い)' : ''}>
      {c.rendered_rev === 0 ? '未描き出し' : isStale(c) ? '古い' : '描き出し済み'}
    </span>
  )
  const dialogs = (<>
      {creating && (
        <SettingsDialog
          title="新しいコンポジション" okLabel="作って開く"
          initial={{ name: `コンポジション ${list.length + 1}`, width: project?.width ?? 1920, height: project?.height ?? 1080, fps: project?.fps ?? 30,
            duration_frames: Math.round((project?.fps ?? 30) * 5), bg: null }}
          onClose={() => setCreating(false)}
          onOk={async v => {
            const { bg, ...rest } = v
            const c = await compsApi.create({ project_id: projectId, ...rest, data: { version: 1, bg, layers: [] } })
            await load(projectId)
            onOpen(c.id)
          }}
        />
      )}
      {editing && (
        <SettingsDialog
          title={`「${editing.comp.name}」の設定`} okLabel="保存"
          initial={{ name: editing.comp.name, width: editing.comp.width, height: editing.comp.height, fps: editing.comp.fps,
            duration_frames: editing.comp.duration_frames, bg: editing.bg }}
          onClose={() => setEditing(null)}
          onOk={async v => {
            const { bg, ...rest } = v
            // 背景は文書(data)の中にあるので、変えたときだけ文書ごと送る(ほかの項目はそのまま)
            if (bg !== editing.bg) {
              const full = await compsApi.get(editing.comp.id)
              await compsApi.update(editing.comp.id, { ...rest, data: { ...full.data, bg } })
            } else await compsApi.update(editing.comp.id, rest)
            await load(projectId)
            toast('設定を保存しました', 'success')
          }}
        />
      )}
  </>)

  // ── スマホ・タブレット: 大きなカード(スマホの縦は 1 列、横は 2 列、タブレットは幅に合わせて)。押すと「見るだけ」の画面 ──
  if (touch) {
    const act = 'h-11 px-3 rounded-lg border text-[14px] whitespace-nowrap flex items-center justify-center gap-1 active:bg-zinc-800'
    return (
      <div className="flex-1 min-h-0 comp-scroll comp-safe-bottom" data-comp-list data-comp-list-layout={phone ? 'phone' : 'tablet'}>
        <div className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur px-3 pt-2 pb-2 border-b border-zinc-800 flex items-center gap-2">
          <input type="search" enterKeyHint="search" className="flex-1 min-w-0 h-11 rounded-lg bg-zinc-800 border border-zinc-700 px-3 text-[16px] text-zinc-100 outline-none focus:border-purple-500"
                 placeholder={`🔍 ${list.length} 件からさがす`} value={query} onChange={e => setQuery(e.target.value)} data-comp-search />
          <button className="h-11 px-3 rounded-lg bg-purple-700 active:bg-purple-600 text-white text-[14px] font-bold whitespace-nowrap flex-shrink-0" onClick={() => setCreating(true)} data-comp-new>+ 新規</button>
        </div>
        {error && <div className="m-3 px-3 py-2 rounded border border-red-800 bg-red-950/60 text-[13px] text-red-200 flex gap-2" data-comp-list-error>
          <span className="flex-1">⚠ {error}</span><button className="text-red-300 px-2" onClick={() => setError(null)} aria-label="閉じる">✕</button></div>}
        {loading && !list.length && <div className="text-[14px] text-zinc-400 p-6">読み込み中…</div>}
        {!loading && !list.length && <div className="text-[14px] text-zinc-400 m-3 p-5 border border-dashed border-zinc-700 rounded-lg leading-relaxed">まだありません。「+ 新規」で作れます。</div>}
        {!!list.length && !shown.length && <div className="text-[14px] text-zinc-400 p-6">「{query}」に合うコンポジションがありません。</div>}
        <div className="grid gap-3 p-3" style={{ gridTemplateColumns: layout === 'phone' ? 'minmax(0, 1fr)' : layout === 'phoneWide' ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {shown.map(c => (
            <div key={c.id} data-comp-card={c.id} className="rounded-xl border border-zinc-700 bg-zinc-900 overflow-hidden flex flex-col">
              <button className="relative w-full bg-black flex items-center justify-center" style={{ aspectRatio: '16 / 9' }} onClick={() => view(c.id)} aria-label={`「${c.name}」を見る`} data-comp-view={c.id}>
                <CompThumb comp={c} />
                {badge(c, 'absolute top-2 right-2 text-[12px] px-2 py-0.5 font-bold')}
                <span className="absolute bottom-2 left-2 w-10 h-10 rounded-full bg-black/60 text-white text-[16px] flex items-center justify-center pointer-events-none">▶</span>
                <span className="absolute bottom-2 right-2 text-[12px] px-1.5 py-0.5 rounded bg-black/70 text-zinc-100 font-mono pointer-events-none">{(c.duration_frames / Math.max(1, c.fps)).toFixed(1)}s</span>
              </button>
              <div className="px-3 pt-2 pb-3 flex flex-col gap-1.5">
                {renaming?.id === c.id
                  ? <input autoFocus className="w-full h-11 rounded-lg bg-zinc-800 border border-purple-500 px-2 text-[16px] text-zinc-100 outline-none" value={renaming.name} enterKeyHint="done"
                           onChange={e => setRenaming({ id: c.id, name: e.target.value })}
                           onKeyDown={e => { if (e.key === 'Enter') void rename(); else if (e.key === 'Escape') setRenaming(null) }} onBlur={() => void rename()} />
                  : <div className="text-[15px] font-bold text-zinc-100 leading-snug break-words">{c.name}</div>}
                <div className="text-[13px] text-zinc-400">
                  {c.width}×{c.height} · {c.fps}fps · {c.duration_frames} コマ · {c.layer_count ?? '?'} レイヤー
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <button className={`${act} flex-1 border-purple-500 bg-purple-900/50 text-purple-100 font-bold`} onClick={() => view(c.id)} data-comp-view-btn={c.id}>▶ 見る</button>
                  <button className={`${act} flex-1 border-zinc-600 text-zinc-100`} onClick={() => onOpen(c.id)} data-comp-open={c.id}>✏ 開く(編集)</button>
                  <button className={`${act} w-11 !px-0 border-zinc-600 text-zinc-200 ${moreId === c.id ? 'bg-zinc-700' : ''}`} aria-label="そのほかの操作" aria-expanded={moreId === c.id}
                          onClick={() => setMoreId(moreId === c.id ? null : c.id)} data-comp-more={c.id}>⋯</button>
                </div>
                {moreId === c.id && (
                  <div className="grid grid-cols-2 gap-2" data-comp-more-menu>
                    <button className={`${act} border-zinc-700 text-zinc-200`} onClick={() => { setMoreId(null); setRenaming({ id: c.id, name: c.name }) }}>✎ 名前を変える</button>
                    <button className={`${act} border-zinc-700 text-zinc-200`} onClick={() => { setMoreId(null); void compsApi.duplicate(c.id).then(() => load(projectId)).catch(() => undefined) }} data-comp-dup={c.id}>⧉ 複製</button>
                    <button className={`${act} border-zinc-700 text-zinc-200`} onClick={() => { setMoreId(null); void openSettings(c) }}>⚙ 大きさ・長さ</button>
                    <button className={`${act} border-red-900 text-red-300`} onClick={() => { setMoreId(null); void del(c) }} data-comp-del={c.id}>🗑 削除</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        {dialogs}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4" data-comp-list>
      <div className="max-w-[1100px] mx-auto">
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-sm font-bold text-zinc-100">🎞 コンポジション</h2>
          <span className="text-[11px] text-zinc-500">レイヤーを重ねてキーフレームで動かす、入れ子のタイムライン。描き出すと動画素材になり、タイムラインに置けます。</span>
          <button className="ml-auto text-xs px-3 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white" onClick={() => setCreating(true)} data-comp-new>+ 新しいコンポジション</button>
        </div>
        {error && <div className="mb-2 px-3 py-1.5 rounded border border-red-800 bg-red-950/60 text-[11px] text-red-200 flex" data-comp-list-error>
          <span className="flex-1">⚠ {error}</span><button className="text-red-300 hover:text-white" onClick={() => setError(null)}>✕</button></div>}
        {loading && !list.length && <div className="text-xs text-zinc-500 p-6">読み込み中…</div>}
        {!loading && !list.length && <div className="text-xs text-zinc-500 p-6 border border-dashed border-zinc-700 rounded">まだありません。「+ 新しいコンポジション」で作れます。</div>}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
          {list.map(c => (
            <div key={c.id} data-comp-card={c.id} className="rounded-lg border border-zinc-700 bg-zinc-900 overflow-hidden flex flex-col hover:border-purple-500">
              <button className="relative h-[124px] bg-black flex items-center justify-center" onClick={() => onOpen(c.id)} title="開いて編集">
                <CompThumb comp={c} />
                <span className={`absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded ${isStale(c) ? 'bg-amber-600 text-black' : 'bg-emerald-700 text-white'}`} data-comp-badge
                      title={isStale(c) && c.rendered_rev !== 0 && !c.stale ? '入れ子の子コンポジションが変わった(または描き出したファイルが無い)' : ''}>
                  {c.rendered_rev === 0 ? '未描き出し' : isStale(c) ? '古い' : '描き出し済み'}
                </span>
              </button>
              <div className="px-2 py-1.5 flex flex-col gap-1">
                {renaming?.id === c.id
                  ? <input autoFocus className={`${inputCls} w-full`} value={renaming.name} onChange={e => setRenaming({ id: c.id, name: e.target.value })}
                           onKeyDown={e => { if (e.key === 'Enter') void rename(); else if (e.key === 'Escape') setRenaming(null) }} onBlur={() => void rename()} />
                  : <div className="text-xs text-zinc-100 truncate cursor-text" title="ダブルクリックで名前を変える" onDoubleClick={() => setRenaming({ id: c.id, name: c.name })}>{c.name}</div>}
                <div className="text-[10px] text-zinc-500 font-mono">
                  {c.width}×{c.height} · {c.fps}fps · {c.duration_frames}f({(c.duration_frames / Math.max(1, c.fps)).toFixed(1)}s) · {c.layer_count ?? '?'} レイヤー
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <button className={`${btnCls} border-purple-600 text-purple-200`} onClick={() => onOpen(c.id)} data-comp-open={c.id}>開く</button>
                  <button className={btnCls} onClick={() => setRenaming({ id: c.id, name: c.name })}>名前</button>
                  <button className={btnCls} onClick={() => void compsApi.duplicate(c.id).then(() => load(projectId)).catch(() => undefined)} data-comp-dup={c.id}>複製</button>
                  <button className={btnCls} onClick={() => void openSettings(c)} title="大きさ・fps・長さ・背景">⚙</button>
                  <button className={`${btnCls} ml-auto hover:text-red-300 hover:border-red-700`} onClick={() => void del(c)} data-comp-del={c.id}>削除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      {dialogs}
    </div>
  )
}
