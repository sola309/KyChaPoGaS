// 🎞 「+ レイヤー」メニュー(スキーマの layer_types から作る)と、素材・コンポジションの選択。

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { assetsApi, assetKind, type Asset } from '../../api/client'
import { useCompStore } from './store'
import { useCompListStore } from './compList'
import { shapeKinds } from './schema'
import type { Layer } from './types'
import { btnCls, inputCls } from './fields'

type AssetKind = 'image' | 'video' | 'model3d' | 'any'
interface PickReq { kind: AssetKind; onPick: (a: Asset) => void }

const kindOfType = (type: string, k?: unknown): AssetKind =>
  k === 'video' || k === 'image' || k === 'model3d' || k === 'any' ? k : k === 'model' ? 'model3d' : type === 'video' ? 'video' : type === 'model' ? 'model3d' : 'image'

function AssetPicker({ req, onClose }: { req: PickReq; onClose: () => void }) {
  const projectId = useCompStore(s => s.projectId)
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    let on = true
    void assetsApi.list(projectId).then(a => { if (on) setAssets(a) }).catch(() => { if (on) setAssets([]) })
    return () => { on = false }
  }, [projectId])
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (assets ?? [])
      .filter(a => (req.kind === 'any' ? ['image', 'video'].includes(assetKind(a)) : assetKind(a) === req.kind))
      .filter(a => !needle || a.name.toLowerCase().includes(needle) || `#${a.id}`.includes(needle))
      .sort((a, b) => b.id - a.id)
      .slice(0, 300)
  }, [assets, q, req.kind])
  const label = req.kind === 'video' ? '動画' : req.kind === 'model3d' ? '3D モデル' : req.kind === 'any' ? '画像・動画' : '画像'
  return createPortal(
    <div className="fixed inset-0 z-[210] bg-black/70 flex items-center justify-center p-6" onPointerDown={onClose} data-comp-asset-picker>
      <div className="w-[min(860px,96vw)] max-h-[82vh] flex flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl" onPointerDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
          <span className="text-xs font-bold text-zinc-200">{label}の素材を選ぶ</span>
          <input autoFocus className={`${inputCls} flex-1`} placeholder="名前・#番号でしぼる" value={q} onChange={e => setQ(e.target.value)} />
          <button className={btnCls} onClick={onClose}>閉じる</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))' }}>
          {assets == null && <div className="text-[11px] text-zinc-500 p-4">読み込み中…</div>}
          {assets != null && list.length === 0 && <div className="text-[11px] text-zinc-500 p-4 col-span-full">このプロジェクトに{label}の素材がありません(編集画面の素材パネルから取り込めます)。</div>}
          {list.map(a => (
            <button key={a.id} className="flex flex-col rounded border border-zinc-700 hover:border-purple-400 bg-zinc-950 overflow-hidden text-left"
                    data-asset-card={a.id} onClick={() => { req.onPick(a); onClose() }} title={a.name}>
              <img src={assetsApi.thumbnailUrl(a.id)} loading="lazy" alt="" className="w-full h-[76px] object-contain bg-black" />
              <span className="px-1 py-0.5 text-[10px] text-zinc-300 truncate w-full">#{a.id} {a.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function AddLayerMenu() {
  const schema = useCompStore(s => s.schema)
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<string | null>(null)
  const [pick, setPick] = useState<PickReq | null>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number; maxHeight?: number }>({ left: 0, bottom: 0 })
  const comps = useCompListStore(s => s.list)
  const selfId = useCompStore(s => s.comp?.id)

  useEffect(() => {
    if (!open) return
    const close = () => { setOpen(false); setSub(null) }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  // プロパティ欄の「選ぶ…」(素材の選び直し)
  useEffect(() => {
    const onPick = (e: Event) => {
      const d = (e as CustomEvent).detail as { ids: string[]; path: string; kind?: string }
      setPick({ kind: kindOfType('', d.kind), onPick: a => useCompStore.getState().setRaw(d.ids, d.path, a.id) })
    }
    window.addEventListener('kychapogas:comp-pick-asset', onPick)
    return () => window.removeEventListener('kychapogas:comp-pick-asset', onPick)
  }, [])

  const add = (type: string, over?: Partial<Layer>) => { useCompStore.getState().addNewLayer(type, over); setOpen(false); setSub(null) }

  const addAsset = (type: string, kind: AssetKind) => {
    setOpen(false)
    setPick({ kind, onPick: a => {
      const s = useCompStore.getState()
      const over: Partial<Layer> = { name: a.name, source: { asset_id: a.id } }
      if (kind === 'video' && a.duration_sec) over.out = Math.max(1, Math.min(s.settings.duration_frames, Math.ceil(a.duration_sec * s.settings.fps)))
      s.addNewLayer(type, over)
    } })
  }

  const addComp = async (cid: number) => {
    const c = comps.find(x => x.id === cid)
    const s = useCompStore.getState()
    const out = c ? Math.max(1, Math.min(s.settings.duration_frames, Math.round(c.duration_frames * s.settings.fps / c.fps))) : s.settings.duration_frames
    add('comp', { name: c?.name ?? `comp ${cid}`, out, source: { comp_id: cid } })
    // 循環はサーバが 422 で断る。すぐ保存して確かめ、だめなら文面を出して取り消す
    await useCompStore.getState().flush()
    const after = useCompStore.getState()
    if (after.saveState === 'error') {
      const msg = after.saveError ?? ''
      after.undo()
      useCompStore.getState().setBanner(`「${c?.name ?? cid}」は入れられません: ${msg}`)
    }
  }

  const itemCls = 'w-full text-left px-3 py-1 text-[11px] text-zinc-200 hover:bg-purple-800 flex items-center gap-2'
  const others = comps.filter(c => c.id !== selfId)
  const shapes = useMemo(() => shapeKinds(schema), [schema])

  return (
    <span className="relative" onPointerDown={e => e.stopPropagation()}>
      <button data-comp-add-layer className="text-[11px] px-2 py-0.5 rounded bg-purple-800 hover:bg-purple-700 text-purple-100" onClick={e => {
        const r = e.currentTarget.getBoundingClientRect()
        // 上へ開く。画面の上にはみ出さない高さまで(スマホではボタンが画面の中ほどにある)
        setPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - 204)), bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(window.innerHeight * 0.7, Math.max(160, r.top - 12)) })
        setOpen(o => !o)
      }}>+ レイヤー</button>
      {open && createPortal(
        <div className="fixed z-[200] w-[200px] py-1 rounded-md border border-zinc-600 bg-zinc-900 shadow-2xl max-h-[70vh] overflow-y-auto" style={pos}
             onPointerDown={e => e.stopPropagation()} data-comp-add-menu>
          {Object.entries(schema.layer_types).map(([type, d]) => {
            const src = d.source ?? {}
            const label = <><span className="w-4 text-center">{d.icon ?? '▫'}</span><span className="flex-1">{d.label ?? type}</span></>
            if (type === 'shape') {
              return (
                <div key={type}>
                  <button className={itemCls} data-add-type={type} onClick={() => setSub(sub === type ? null : type)}>{label}<span className="text-zinc-500">{sub === type ? '▾' : '▸'}</span></button>
                  {sub === type && shapes.map(k => (
                    <button key={k.kind} data-add-shape={k.kind} className={`${itemCls} pl-9 text-zinc-300`} onClick={() => add('shape', { name: k.label, source: k.source })}>{k.label}</button>
                  ))}
                </div>
              )
            }
            if (src.comp_id || type === 'comp') {
              return (
                <div key={type}>
                  <button className={itemCls} data-add-type={type} onClick={() => setSub(sub === type ? null : type)}>{label}<span className="text-zinc-500">{sub === type ? '▾' : '▸'}</span></button>
                  {sub === type && (others.length
                    ? others.map(c => <button key={c.id} className={`${itemCls} pl-9 text-zinc-300`} onClick={() => void addComp(c.id)}><span className="truncate">{c.name}</span></button>)
                    : <div className="pl-9 pr-2 py-1 text-[10px] text-zinc-500">ほかのコンポジションがありません</div>)}
                </div>
              )
            }
            if (src.asset_id) {
              return <button key={type} className={itemCls} data-add-type={type} onClick={() => addAsset(type, kindOfType(type, src.asset_id.asset ?? src.asset_id.kind))}>{label}<span className="text-zinc-500">…</span></button>
            }
            return <button key={type} className={itemCls} data-add-type={type} onClick={() => add(type)}>{label}</button>
          })}
        </div>,
        document.body,
      )}
      {pick && <AssetPicker req={pick} onClose={() => setPick(null)} />}
    </span>
  )
}
