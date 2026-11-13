// 🎞 レイヤーのタイムライン(下の欄)。1 行 = 1 レイヤー(上が手前)。帯のドラッグ・端の詰め・吸着・拡大・行の並べ替え・キーフレーム。
// 再生ヘッドはストアを直接購読して線だけ動かす(行は描き直さない)。行は memo。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CompDoc, CompSchema, KeyRef, Layer } from './types'
import {
  allKeyFrames, collectKeyedProps, layerIn, layerOut, moveLayer, sameFrame, shiftLayerTime, trimLayer, updateLayer, updateLayers,
} from './docOps'
import { useCompStore } from './store'
import { typeIcon } from './schema'
import { AddLayerMenu } from './AddLayerMenu'

const ROW_H = 24
const KEY_ROW_H = 18
const HEADER_W = 492
const RULER_H = 22
const SNAP_PX = 7

const BAR_COLOR: Record<string, string> = {
  text: 'bg-sky-800 border-sky-500', shape: 'bg-emerald-800 border-emerald-500', solid: 'bg-zinc-600 border-zinc-400',
  image: 'bg-amber-800 border-amber-500', video: 'bg-blue-800 border-blue-500', null: 'bg-zinc-700 border-zinc-500 border-dashed',
  camera: 'bg-rose-800 border-rose-500', comp: 'bg-purple-800 border-purple-400', model: 'bg-teal-800 border-teal-500',
  particles: 'bg-fuchsia-800 border-fuchsia-500', adjustment: 'bg-orange-800 border-orange-500',
}

interface Opt { id: string; name: string }

/** 開くまで選択肢を作らない select(100 行 × 100 択を毎回作らないため) */
function LazySelect({ value, options, onChange, title, width, emptyLabel = '—' }: {
  value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; title: string; width: number; emptyLabel?: string
}) {
  const [armed, setArmed] = useState(false)
  const cur = options.find(o => o.value === value)
  return (
    <select
      className="appearance-none bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-300 h-[18px] px-1 outline-none flex-shrink-0 truncate cursor-pointer hover:border-zinc-500"
      style={{ width }}
      value={value}
      title={title}
      onPointerEnter={() => setArmed(true)}
      onFocus={() => setArmed(true)}
      onPointerDown={e => e.stopPropagation()}
      onChange={e => onChange(e.target.value)}
    >
      {armed
        ? (<>
            <option value="">{emptyLabel}</option>
            {value && !cur && <option value={value}>{value}</option>}
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </>)
        : <option value={value}>{value ? (cur?.label ?? value) : emptyLabel}</option>}
    </select>
  )
}

const MATTE_MODES = [
  { value: 'alpha', label: 'α' }, { value: 'alpha_inv', label: 'α反' }, { value: 'luma', label: '輝' }, { value: 'luma_inv', label: '輝反' },
]

interface RowProps {
  layer: Layer
  selected: boolean
  expanded: boolean
  ppf: number
  dur: number
  others: Opt[]
  schema: CompSchema
  onBarDown: (e: React.PointerEvent, id: string, mode: 'move' | 'in' | 'out') => void
  onReorderDown: (e: React.PointerEvent, id: string) => void
  onKeyDown: (e: React.PointerEvent, ref: KeyRef) => void
  onMenu: (e: React.MouseEvent, id: string, key?: KeyRef) => void
}

const Toggle = ({ on, onClick, title, children, onCls = 'text-zinc-100' }: { on: boolean; onClick: () => void; title: string; children: React.ReactNode; onCls?: string }) => (
  <button
    className={`w-[20px] h-[18px] text-[10px] leading-none rounded flex-shrink-0 hover:bg-zinc-700 ${on ? onCls : 'text-zinc-600'}`}
    title={title}
    onPointerDown={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onClick() }}
  >{children}</button>
)

const LayerRow = memo(function LayerRow({ layer, selected, expanded, ppf, dur, others, schema, onBarDown, onReorderDown, onKeyDown, onMenu }: RowProps) {
  const patchLayer = useCompStore(s => s.patchLayer)
  const clickSel = useCompStore(s => s.clickSel)
  const toggleExpanded = useCompStore(s => s.toggleExpanded)
  const [renaming, setRenaming] = useState<string | null>(null)
  const id = layer.id
  const i0 = layerIn(layer), o0 = layerOut(layer, dur)
  const visible = layer.visible !== false
  const locked = !!layer.locked
  const keyed = useMemo(() => (expanded ? collectKeyedProps(layer) : []), [layer, expanded])
  const ticks = useMemo(() => (expanded ? [] : allKeyFrames(layer, 200)), [layer, expanded])
  const hasKeys = expanded ? keyed.length > 0 : ticks.length > 0
  const parentOpts = useMemo(() => others.filter(o => o.id !== id).map(o => ({ value: o.id, label: o.name })), [others, id])
  const blendOpts = useMemo(() => schema.blend_modes.map(o => ({ value: o.value, label: o.label ?? o.value })), [schema.blend_modes])
  const headBg = selected ? 'bg-[#2b2140]' : 'bg-zinc-900'

  return (
    <>
      <div data-row-id={id} className={`flex border-b border-zinc-800/80 ${selected ? 'bg-purple-950/25' : ''}`} style={{ height: ROW_H }}
           onContextMenu={e => onMenu(e, id)}>
        <div
          className={`sticky left-0 z-[25] flex items-center gap-0.5 pl-0.5 pr-1 border-r border-zinc-700 flex-shrink-0 ${headBg}`}
          style={{ width: HEADER_W }}
          onPointerDown={e => { if (e.button === 0) clickSel(id, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }) }}
        >
          <span className="w-[14px] text-center text-zinc-600 hover:text-zinc-300 cursor-grab text-[11px] flex-shrink-0 select-none" title="ドラッグで重なり順を変える(上が手前)"
                onPointerDown={e => onReorderDown(e, id)}>⠿</span>
          <button className={`w-[14px] text-[10px] flex-shrink-0 ${hasKeys ? 'text-amber-400' : 'text-zinc-600'} hover:text-white`}
                  title={expanded ? 'キーフレームの行を閉じる' : 'キーフレームのあるプロパティを開く'}
                  onPointerDown={e => e.stopPropagation()} onClick={() => toggleExpanded(id)}>{expanded ? '▾' : '▸'}</button>
          <span className="w-[18px] text-center text-[11px] flex-shrink-0" title={layer.type}>{typeIcon(schema, layer.type)}</span>
          {renaming != null ? (
            <input autoFocus className="flex-1 min-w-0 bg-zinc-800 border border-purple-500 rounded px-1 text-[11px] text-white outline-none h-[18px]"
                   value={renaming} onChange={e => setRenaming(e.target.value)} onPointerDown={e => e.stopPropagation()}
                   onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') setRenaming(null) }}
                   onBlur={() => { if (renaming != null && renaming !== (layer.name ?? '')) patchLayer(id, { name: renaming }); setRenaming(null) }} />
          ) : (
            <span className={`flex-1 min-w-0 truncate text-[11px] select-none ${visible ? 'text-zinc-200' : 'text-zinc-500'}`}
                  title={`${layer.name ?? id}(ダブルクリックで名前を変える)`}
                  onDoubleClick={() => { if (!locked) setRenaming(layer.name ?? id) }}>{layer.name || id}</span>
          )}
          <Toggle on={visible} title="表示 / 非表示" onClick={() => patchLayer(id, { visible: !visible })}><span className={visible ? '' : 'opacity-25 grayscale'}>👁</span></Toggle>
          <Toggle on={locked} title="ロック(動かせなくする)" onClick={() => patchLayer(id, { locked: !locked })}><span className={locked ? '' : 'opacity-20 grayscale'}>🔒</span></Toggle>
          <Toggle on={!!layer.solo} onCls="text-amber-300 bg-amber-950" title="ソロ(ソロのレイヤーだけ表示)" onClick={() => patchLayer(id, { solo: !layer.solo })}>S</Toggle>
          <Toggle on={!!layer.three_d} onCls="text-orange-300 bg-orange-950" title="3D レイヤー(カメラの影響を受ける)" onClick={() => patchLayer(id, { three_d: !layer.three_d })}>3D</Toggle>
          <LazySelect width={64} value={layer.parent ?? ''} options={parentOpts} title="親(位置・回転・拡大を継ぐ)" emptyLabel="親なし"
                      onChange={v => patchLayer(id, { parent: v || null })} />
          <LazySelect width={58} value={layer.blend && layer.blend !== 'normal' ? layer.blend : ''} options={blendOpts.filter(o => o.value !== 'normal')} title="重ね方(ブレンド)" emptyLabel="通常"
                      onChange={v => patchLayer(id, { blend: v || 'normal' })} />
          <LazySelect width={64} value={layer.matte?.layer ?? ''} options={parentOpts} title="マット(このレイヤーを、選んだレイヤーの形で切り抜く)" emptyLabel="マットなし"
                      onChange={v => patchLayer(id, { matte: v ? { ...(layer.matte ?? {}), layer: v, mode: layer.matte?.mode ?? 'alpha' } : null })} />
          {layer.matte
            ? <LazySelect width={34} value={layer.matte.mode ?? 'alpha'} options={MATTE_MODES} title="マットの読み方(α = 不透明な所 / α反 = その逆 / 輝 = 明るい所 / 輝反 = 暗い所)" emptyLabel="α"
                          onChange={v => patchLayer(id, { matte: { ...layer.matte!, mode: v || 'alpha' } })} />
            : <span className="w-[34px] flex-shrink-0" />}
        </div>
        <div className="relative flex-1 min-w-0" data-lane>
          <div
            data-bar-id={id}
            className={`absolute top-[3px] rounded-sm border text-[10px] text-white/90 overflow-hidden select-none
              ${BAR_COLOR[layer.type] ?? 'bg-zinc-700 border-zinc-500'} ${selected ? 'ring-1 ring-purple-200' : ''} ${visible ? '' : 'opacity-40'} ${locked ? 'cursor-not-allowed' : 'cursor-grab'}`}
            style={{ left: i0 * ppf, width: Math.max(4, (o0 - i0) * ppf), height: ROW_H - 7 }}
            title={`${layer.name ?? id} — ${i0}〜${o0}(${o0 - i0} コマ)${layer.type === 'comp' ? ' / ダブルクリックで中を開く' : ''}`}
            onPointerDown={e => onBarDown(e, id, 'move')}
            onDoubleClick={() => {
              const cid = layer.type === 'comp' ? (layer.source?.comp_id as number | undefined) : undefined
              if (typeof cid === 'number') window.dispatchEvent(new CustomEvent('kychapogas:comp-open-child', { detail: { compId: cid } }))
            }}
          >
            <span className="px-1.5 leading-[16px] whitespace-nowrap pointer-events-none">{layer.name || id}</span>
            {!locked && (<>
              <span className="absolute left-0 top-0 bottom-0 w-[6px] cursor-ew-resize hover:bg-white/40" onPointerDown={e => onBarDown(e, id, 'in')} />
              <span className="absolute right-0 top-0 bottom-0 w-[6px] cursor-ew-resize hover:bg-white/40" onPointerDown={e => onBarDown(e, id, 'out')} />
            </>)}
          </div>
          {ticks.map(f => (
            <span key={f} className="absolute bottom-[1px] w-[5px] h-[5px] rotate-45 bg-amber-300/90 pointer-events-none" style={{ left: f * ppf - 2.5 }} />
          ))}
        </div>
      </div>
      {expanded && keyed.length === 0 && (
        <div className="flex border-b border-zinc-800/60" style={{ height: KEY_ROW_H }}>
          <div className="sticky left-0 z-[25] bg-zinc-900 border-r border-zinc-700 flex items-center pl-12 text-[10px] text-zinc-600 flex-shrink-0" style={{ width: HEADER_W }}>
            キーフレームなし(プロパティの ◇ を押すか K で打てます)
          </div>
        </div>
      )}
      {expanded && keyed.map(kp => (
        <KeyRow key={kp.path} layerId={id} path={kp.path} label={kp.label} frames={kp.prop.k} ppf={ppf} locked={locked} onKeyDown={onKeyDown} onMenu={onMenu} />
      ))}
    </>
  )
})

const KeyRow = memo(function KeyRow({ layerId, path, label, frames, ppf, locked, onKeyDown, onMenu }: {
  layerId: string; path: string; label: string; frames: { f: number; e?: unknown }[]; ppf: number; locked: boolean
  onKeyDown: RowProps['onKeyDown']; onMenu: RowProps['onMenu']
}) {
  // この行の選択だけを文字列にして購読する(ほかの行のキーを選んでも描き直さない)
  const selSig = useCompStore(s => s.selKeys.filter(k => k.layerId === layerId && k.path === path).map(k => k.f).join(','))
  const selFrames = useMemo(() => (selSig ? selSig.split(',').map(Number) : []), [selSig])
  const setFrame = useCompStore(s => s.setFrame)
  return (
    <div className="flex border-b border-zinc-800/60 bg-zinc-950/40" style={{ height: KEY_ROW_H }} data-key-row={`${layerId}:${path}`}>
      <div className="sticky left-0 z-[25] bg-zinc-900 border-r border-zinc-700 flex items-center pl-12 pr-2 text-[10px] text-zinc-400 flex-shrink-0 truncate" style={{ width: HEADER_W }} title={path}>
        <span className="text-amber-500 mr-1">◆</span>{label}
        <span className="ml-auto text-zinc-600">{frames.length}</span>
      </div>
      <div className="relative flex-1 min-w-0">
        {frames.map(k => {
          const sel = selFrames.some(f => sameFrame(f, k.f))
          return (
            <span
              key={k.f}
              data-key-f={k.f}
              className={`absolute top-[4px] w-[10px] h-[10px] rotate-45 border ${k.e === 'hold' ? 'rounded-none' : 'rounded-[2px]'}
                ${sel ? 'bg-white border-purple-400 z-10' : 'bg-amber-400 border-amber-700 hover:bg-amber-200'} ${locked ? '' : 'cursor-ew-resize'}`}
              style={{ left: k.f * ppf - 5 }}
              title={`${label} @ ${k.f}${k.e ? ` / ${Array.isArray(k.e) ? 'ベジェ' : String(k.e)}` : ''}(ドラッグで時刻を動かす・ダブルクリックでここへ移動・右クリックでイージング)`}
              onPointerDown={e => onKeyDown(e, { layerId, path, f: k.f })}
              onDoubleClick={() => setFrame(k.f)}
              onContextMenu={e => onMenu(e, layerId, { layerId, path, f: k.f })}
            />
          )
        })}
      </div>
    </div>
  )
})

/** 目盛り。押す・なぞるで再生位置を動かす */
const Ruler = memo(function Ruler({ ppf, dur, fps, width }: { ppf: number; dur: number; fps: number; width: number }) {
  const step = useMemo(() => {
    const nice = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 3000, 6000]
    return nice.find(n => n * ppf >= 56) ?? 12000
  }, [ppf])
  const labels = useMemo(() => {
    const out: number[] = []
    for (let f = 0; f <= dur; f += step) out.push(f)
    return out
  }, [dur, step])
  const minor = step >= 10 ? step / 5 : step >= 2 ? 1 : 0
  // 再生ヘッドの頭(目盛りの上の三角)。線と同じく、ストアを直接購読して位置だけ変える
  const capRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const place = () => { const s = useCompStore.getState(); if (capRef.current) capRef.current.style.transform = `translateX(${s.frame * s.ppf - 5}px)` }
    place()
    return useCompStore.subscribe((s, p) => { if (s.frame !== p.frame || s.ppf !== p.ppf) place() })
  }, [])
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    const st = useCompStore.getState()
    if (st.playing) st.setPlaying(false)
    const at = (cx: number) => st.setFrame(Math.round((cx - el.getBoundingClientRect().left) / ppf))
    at(e.clientX)
    const onMove = (ev: PointerEvent) => at(ev.clientX)
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div data-comp-ruler className="relative flex-shrink-0 bg-zinc-900 border-b border-zinc-700 cursor-pointer select-none" style={{ width, height: RULER_H,
      backgroundImage: minor ? 'linear-gradient(to right, rgba(255,255,255,0.12) 1px, transparent 1px)' : undefined,
      backgroundSize: minor ? `${minor * ppf}px 5px` : undefined, backgroundRepeat: 'repeat-x', backgroundPosition: '0 100%' }}
         onPointerDown={scrub} title="押す・なぞるで再生位置を動かす">
      {labels.map(f => (
        <span key={f} className="absolute top-0 bottom-0 border-l border-zinc-600 pl-1 text-[9px] text-zinc-400 font-mono pointer-events-none" style={{ left: f * ppf }}>
          {f}<span className="text-zinc-600 ml-1">{fps > 0 && f % Math.round(fps) === 0 ? `${Math.round(f / fps)}s` : ''}</span>
        </span>
      ))}
      <span className="absolute top-0 bottom-0 bg-black/50 pointer-events-none" style={{ left: dur * ppf, right: 0 }} />
      <span ref={capRef} className="absolute left-0 bottom-0 w-[11px] h-[11px] bg-red-500 pointer-events-none" style={{ clipPath: 'polygon(0 0, 100% 0, 100% 45%, 50% 100%, 0 45%)' }} />
    </div>
  )
})

interface Menu { x: number; y: number; layerId: string; key?: KeyRef }

export function LayerTimeline({ onOpenChild }: { onOpenChild: (compId: number) => void }) {
  const layers = useCompStore(s => s.doc.layers)
  const sel = useCompStore(s => s.sel)
  const expanded = useCompStore(s => s.expanded)
  const ppf = useCompStore(s => s.ppf)
  const dur = useCompStore(s => s.settings.duration_frames)
  const fps = useCompStore(s => s.settings.fps)
  const schema = useCompStore(s => s.schema)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [dropY, setDropY] = useState(0)
  const zoomAnchor = useRef<{ frame: number; x: number } | null>(null)

  const selSet = useMemo(() => new Set(sel), [sel])
  const namesSig = layers.map(l => `${l.id}\u0001${l.name ?? ''}`).join('\u0002')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 名前と id が変わったときだけ作り直す(行の memo を保つ)
  const others = useMemo<Opt[]>(() => layers.map(l => ({ id: l.id, name: l.name || l.id })), [namesSig])
  const contentW = Math.max(600, (dur + Math.max(10, 240 / ppf)) * ppf)

  // 再生ヘッド: ストアを直接購読して線の位置だけ変える
  useEffect(() => {
    const place = () => {
      const s = useCompStore.getState()
      if (headRef.current) headRef.current.style.transform = `translateX(${HEADER_W + s.frame * s.ppf}px)`
    }
    place()
    return useCompStore.subscribe((s, p) => { if (s.frame !== p.frame || s.ppf !== p.ppf) place() })
  }, [])

  // 再生中は再生ヘッドが見える所までスクロールを追いかける
  useEffect(() => useCompStore.subscribe((s, p) => {
    if (s.frame === p.frame || !s.playing) return
    const el = scrollRef.current
    if (!el) return
    const x = s.frame * s.ppf
    const viewW = el.clientWidth - HEADER_W
    if (x < el.scrollLeft || x > el.scrollLeft + viewW - 20) el.scrollLeft = Math.max(0, x - 40)
  }), [])

  // Ctrl + ホイール = 拡大(カーソルの下のコマを動かさない)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const st = useCompStore.getState()
      const x = e.clientX - el.getBoundingClientRect().left - HEADER_W
      zoomAnchor.current = { frame: (el.scrollLeft + x) / st.ppf, x }
      st.setPpf(st.ppf * Math.exp(-e.deltaY * 0.0018))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  useLayoutEffect(() => {
    const a = zoomAnchor.current, el = scrollRef.current
    if (!a || !el) return
    el.scrollLeft = Math.max(0, a.frame * ppf - a.x)
    zoomAnchor.current = null
  }, [ppf])

  // ── 帯のドラッグ(動かす・端を詰める) ──
  const onBarDown = useCallback((e: React.PointerEvent, id: string, mode: 'move' | 'in' | 'out') => {
    if (e.button !== 0) return
    e.stopPropagation()
    const st = useCompStore.getState()
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }
    const wasSelected = st.sel.includes(id)
    if (!wasSelected || mods.shift || mods.ctrl) st.clickSel(id, mods)
    if (mods.shift || mods.ctrl) return
    const s0 = useCompStore.getState()
    const base: CompDoc = s0.doc
    const layer = base.layers.find(l => l.id === id)
    if (!layer || layer.locked) return
    const d = s0.settings.duration_frames
    const ids = mode === 'move' ? s0.sel.filter(x => !base.layers.find(l => l.id === x)?.locked) : [id]
    const idSet = new Set(ids)
    const targets = [0, d, s0.frame]
    for (const l of base.layers) if (!idSet.has(l.id)) targets.push(layerIn(l), layerOut(l, d))
    const edges = mode === 'move' ? ids.flatMap(x => { const l = base.layers.find(y => y.id === x)!; return [layerIn(l), layerOut(l, d)] })
      : [mode === 'in' ? layerIn(layer) : layerOut(layer, d)]
    const startX = e.clientX
    const pxf = s0.ppf
    let moved = false
    const snap = (delta: number, alt: boolean) => {
      if (alt) return delta
      let best = delta, bestDist = SNAP_PX / pxf
      for (const edge of edges) for (const t of targets) {
        const dd = Math.abs(edge + delta - t)
        if (dd < bestDist) { bestDist = dd; best = t - edge }
      }
      return best
    }
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 3) return
      if (!moved) { moved = true; st.beginGesture() }
      const delta = snap(Math.round(dx / pxf), ev.altKey)
      const next = mode === 'move'
        ? updateLayers(base, idSet, l => shiftLayerTime(l, delta, d))
        : updateLayer(base, id, l => trimLayer(l, mode, (mode === 'in' ? layerIn(layer) : layerOut(layer, d)) + delta, d))
      useCompStore.getState().commit(next, { coalesce: 'bar' })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (moved) useCompStore.getState().endCoalesce()
      else if (wasSelected && useCompStore.getState().sel.length > 1) useCompStore.getState().setSel([id])
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  // ── キーフレームのドラッグ ──
  const onKeyDown = useCallback((e: React.PointerEvent, ref: KeyRef) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const st = useCompStore.getState()
    const isSel = st.selKeys.some(k => k.layerId === ref.layerId && k.path === ref.path && sameFrame(k.f, ref.f))
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      st.setSelKeys(isSel ? st.selKeys.filter(k => !(k.layerId === ref.layerId && k.path === ref.path && sameFrame(k.f, ref.f))) : [...st.selKeys, ref])
      return
    }
    if (!isSel) st.setSelKeys([ref])
    if (st.doc.layers.find(l => l.id === ref.layerId)?.locked) return
    const s0 = useCompStore.getState()
    const base = s0.doc, keys = s0.selKeys
    const startX = e.clientX, pxf = s0.ppf
    const targets = [0, s0.settings.duration_frames, s0.frame]
    let moved = false, last = 0
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 3) return
      if (!moved) { moved = true; st.beginGesture() }
      let delta = Math.round(dx / pxf)
      if (!ev.altKey) for (const t of targets) if (Math.abs(ref.f + delta - t) < SNAP_PX / pxf) { delta = t - ref.f; break }
      if (delta === last) return
      last = delta
      useCompStore.getState().moveSelectedKeys(delta, base, keys)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (moved) useCompStore.getState().endCoalesce()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  // ── 行の並べ替え ──
  const onReorderDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const st = useCompStore.getState()
    if (!st.sel.includes(id)) st.setSel([id])
    const el = scrollRef.current
    if (!el) return
    let idx: number | null = null
    const calc = (cy: number) => {
      const rows = [...el.querySelectorAll<HTMLElement>('[data-row-id]')]
      const top = el.getBoundingClientRect().top
      let i = rows.length, y = rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : top
      for (let r = 0; r < rows.length; r++) {
        const b = rows[r].getBoundingClientRect()
        if (cy < b.top + b.height / 2) { i = r; y = b.top; break }
      }
      idx = i
      setDropIndex(i)
      setDropY(y - top + el.scrollTop)
    }
    const onMove = (ev: PointerEvent) => calc(ev.clientY)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setDropIndex(null)
      if (idx == null) return
      const s = useCompStore.getState()
      s.commit(moveLayer(s.doc, s.doc.layers.filter(l => s.sel.includes(l.id)).map(l => l.id), idx))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  const onMenu = useCallback((e: React.MouseEvent, layerId: string, key?: KeyRef) => {
    e.preventDefault()
    e.stopPropagation()
    const st = useCompStore.getState()
    if (key) {
      if (!st.selKeys.some(k => k.layerId === key.layerId && k.path === key.path && sameFrame(k.f, key.f))) st.setSelKeys([key])
    } else if (!st.sel.includes(layerId)) st.setSel([layerId])
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 300), layerId, key })
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close) }
  }, [menu])

  const menuLayer = menu ? layers.find(l => l.id === menu.layerId) : null
  const st = useCompStore.getState
  const item = (label: string, fn: () => void, hint?: string, disabled?: boolean) => (
    <button key={label} disabled={disabled} className="w-full text-left px-3 py-1 text-[11px] text-zinc-200 hover:bg-purple-800 disabled:opacity-40 disabled:hover:bg-transparent flex items-center gap-3"
            onPointerDown={e => e.stopPropagation()} onClick={() => { setMenu(null); fn() }}>
      <span className="flex-1">{label}</span>{hint && <span className="text-[9px] text-zinc-500">{hint}</span>}
    </button>
  )

  return (
    <div className="flex flex-col min-h-0 flex-1 bg-zinc-950" data-comp-timeline>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto relative"
           onPointerDown={e => { if ((e.target as HTMLElement).hasAttribute('data-lane') || e.target === e.currentTarget) st().setSel([]) }}>
        <div className="relative" style={{ width: HEADER_W + contentW, minHeight: '100%' }}>
          <div className="sticky top-0 z-30 flex" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-40 bg-zinc-900 border-b border-r border-zinc-700 flex items-center gap-1 px-1 flex-shrink-0 text-[10px] text-zinc-500" style={{ width: HEADER_W }}>
              <AddLayerMenu />
              <span className="ml-1">{layers.length} レイヤー</span>
              <span className="ml-auto flex items-center gap-1" title="タイムラインの拡大(Ctrl + ホイールでも)">
                <button className="px-1 hover:text-white" onClick={() => st().setPpf(ppf / 1.4)}>−</button>
                <input type="range" min={0} max={100} value={Math.round((Math.log(ppf / 0.5) / Math.log(120)) * 100)} className="w-16 accent-purple-500"
                       onChange={e => st().setPpf(0.5 * Math.pow(120, Number(e.target.value) / 100))} />
                <button className="px-1 hover:text-white" onClick={() => st().setPpf(ppf * 1.4)}>+</button>
                <button className="px-1 hover:text-white" title="全体が見えるように合わせる"
                        onClick={() => { const el = scrollRef.current; if (el) st().setPpf((el.clientWidth - HEADER_W - 30) / Math.max(1, dur)) }}>⤢</button>
              </span>
            </div>
            <Ruler ppf={ppf} dur={dur} fps={fps} width={contentW} />
          </div>
          {layers.length === 0 && (
            <div className="sticky left-0 p-6 text-[11px] text-zinc-500" style={{ width: 'min(100%, 560px)' }}>
              レイヤーがありません。左上の「+ レイヤー」から、テキスト・シェイプ・画像・動画などを足してください。
            </div>
          )}
          {layers.map(l => (
            <LayerRow key={l.id} layer={l} selected={selSet.has(l.id)} expanded={!!expanded[l.id]} ppf={ppf} dur={dur} others={others} schema={schema}
                      onBarDown={onBarDown} onReorderDown={onReorderDown} onKeyDown={onKeyDown} onMenu={onMenu} />
          ))}
          {/* 長さの外(描き出されない所)を暗くする */}
          <div className="absolute bottom-0 bg-black/35 pointer-events-none" style={{ left: HEADER_W + dur * ppf, right: 0, top: RULER_H }} />
          <div ref={headRef} data-comp-playhead className="absolute top-0 bottom-0 left-0 w-px bg-red-500 z-20 pointer-events-none" />
          {dropIndex != null && <div className="absolute left-0 right-0 h-[2px] bg-purple-400 z-40 pointer-events-none" style={{ top: dropY - 1 }} />}
        </div>
      </div>
      {menu && (
        <div className="fixed z-[200] w-[220px] py-1 rounded-md border border-zinc-600 bg-zinc-900 shadow-2xl" style={{ left: menu.x, top: menu.y }}
             onPointerDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
          {menu.key ? (<>
            <div className="px-3 py-0.5 text-[9px] text-zinc-500">キーフレームのイージング</div>
            {schema.easings.map(o => item(o.label ?? o.value, () => st().setSelKeysEase(o.value)))}
            {item('ベジェ(右の欄で数値を決める)', () => st().setSelKeysEase([0.25, 0.1, 0.25, 1]))}
            <div className="border-t border-zinc-700 my-1" />
            {item('このコマへ移動', () => st().setFrame(menu.key!.f))}
            {item('キーを消す', () => st().deleteSelection(), 'Delete')}
          </>) : (<>
            <div className="px-3 py-0.5 text-[9px] text-zinc-500 truncate">{sel.length > 1 ? `${sel.length} レイヤー` : (menuLayer?.name ?? menu.layerId)}</div>
            {menuLayer?.type === 'comp' && typeof menuLayer.source?.comp_id === 'number' && item('中を開く', () => onOpenChild(menuLayer.source!.comp_id as number), 'ダブルクリック')}
            {item('複製', () => st().duplicateSelection(), 'Ctrl+D')}
            {item('コピー', () => st().copySelection(), 'Ctrl+C')}
            {item('貼り付け', () => st().paste(), 'Ctrl+V')}
            {item('再生位置で分割', () => st().splitAtPlayhead())}
            {item('先頭を再生位置に', () => st().setInOutAtPlayhead('in'), '[')}
            {item('末尾を再生位置に', () => st().setInOutAtPlayhead('out'), ']')}
            {item('トランスフォームのキーを打つ', () => st().addTransformKeys(), 'K')}
            {item('プリコンポーズ(新しいコンポジションにまとめる)', () => void st().precompose())}
            <div className="border-t border-zinc-700 my-1" />
            {item('削除', () => st().deleteSelection(), 'Delete')}
          </>)}
        </div>
      )}
    </div>
  )
}
