// 🎞 コンポジションの一覧(作る・名前を変える・複製・削除・設定)。

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { compsApi, assetsApi, apiErrorText } from '../../api/client'
import { useProjectStore } from '../../store/projectStore'
import { useUIStore } from '../../store/uiStore'
import { useCompListStore } from './compList'
import type { CompSummary } from './types'
import { ColorField, NumField, Row, btnCls, inputCls } from './fields'

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
    <div className="fixed inset-0 z-[210] bg-black/70 flex items-center justify-center p-6" onPointerDown={onClose} data-comp-settings-dialog>
      <div className="w-[380px] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-3 flex flex-col gap-2" onPointerDown={e => e.stopPropagation()}>
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

export function CompList({ projectId, onOpen }: { projectId: number; onOpen: (id: number) => void }) {
  const list = useCompListStore(s => s.list)
  const loading = useCompListStore(s => s.loading)
  const load = useCompListStore(s => s.load)
  const project = useProjectStore(s => s.activeProject)
  const toast = useUIStore(s => s.pushToast)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<{ comp: CompSummary; bg: string | null } | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

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
                {c.rendered_asset_id != null
                  ? <img src={`${assetsApi.thumbnailUrl(c.rendered_asset_id)}?r=${c.rendered_rev}`} alt="" loading="lazy" className="max-w-full max-h-full object-contain" />
                  : <span className="text-3xl opacity-40">🎞</span>}
                <span className={`absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded ${c.stale ? 'bg-amber-600 text-black' : 'bg-emerald-700 text-white'}`}>
                  {c.rendered_rev === 0 ? '未描き出し' : c.stale ? '古い' : '描き出し済み'}
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
    </div>
  )
}
