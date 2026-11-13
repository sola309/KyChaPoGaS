// 🎞 スマホ用のレイヤーの一覧(タイムラインの代わり)。
// 縦に並べるだけ: 種類の絵文字・名前・表示の入切・「どこに居るか」の細い帯と再生位置。押すと選ぶ(プレビューにも選択枠が出る)。
// 並べ替え・帯の長さの変更は PC / タブレットのタイムラインで行う。行は見えている分だけ描く(数百レイヤーでも軽い)。

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Layer } from './types'
import { layerIn, layerOut } from './docOps'
import { useCompStore } from './store'
import { typeIcon, typeLabel } from './schema'
import { AddLayerMenu } from './AddLayerMenu'

const ROW_H = 56
const OVERSCAN = 6
/** これより多い文書は、最初から「今映っている層だけ」にする */
const ALIVE_DEFAULT_OVER = 40

const BAR: Record<string, string> = {
  text: '#0ea5e9', shape: '#a855f7', image: '#f59e0b', video: '#10b981', solid: '#a8a29e', comp: '#ec4899',
  camera: '#84cc16', group: '#84cc16', adjustment: '#eab308', particles: '#d946ef', pattern: '#f43f5e', model: '#14b8a6',
}

const Row = memo(function Row({ layer, selected, dur, icon, typeName, onProps }: {
  layer: Layer; selected: boolean; dur: number; icon: string; typeName: string; onProps: () => void
}) {
  const id = layer.id
  const visible = layer.visible !== false
  const i0 = Math.max(0, layerIn(layer)), o0 = Math.min(dur, layerOut(layer, dur))
  const left = (i0 / Math.max(1, dur)) * 100, width = Math.max(1.5, ((o0 - i0) / Math.max(1, dur)) * 100)
  const nFx = Array.isArray(layer.effects) ? layer.effects.length : 0
  return (
    <div data-mrow-id={id} data-selected={selected ? '1' : '0'} role="button" tabIndex={-1}
         className={`flex items-stretch border-b border-zinc-800 ${selected ? 'bg-purple-950/60' : 'bg-zinc-950 active:bg-zinc-900'}`}
         style={{ height: ROW_H, borderLeft: `4px solid ${selected ? 'var(--color-purple-400)' : BAR[layer.type] ?? '#52525b'}` }}
         onClick={() => { const s = useCompStore.getState(); s.setFocusArea('timeline'); s.setSel(selected && s.sel.length === 1 ? [] : [id]) }}>
      <span className="w-10 flex items-center justify-center text-[20px] flex-shrink-0" title={typeName}>{icon}</span>
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5 pr-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`truncate text-[14px] leading-tight ${visible ? 'text-zinc-100' : 'text-zinc-500 line-through'} ${layer.guide ? 'italic' : ''}`}>{layer.name || id}</span>
          {!!layer.locked && <span className="text-[12px] flex-shrink-0">🔒</span>}
          {!!layer.solo && <span className="text-[12px] px-1 rounded bg-amber-900 text-amber-200 flex-shrink-0">S</span>}
          {nFx > 0 && <span className="text-[12px] text-zinc-500 flex-shrink-0">fx{nFx}</span>}
          {selected && (
            <span role="button" className="ml-auto -my-1 px-2 py-1 rounded-full bg-purple-800 text-[12px] text-purple-50 whitespace-nowrap flex-shrink-0" data-mrow-props aria-label="プロパティを開く"
                  onClick={e => { e.stopPropagation(); onProps() }}>調整 ›</span>
          )}
        </div>
        <div className="relative h-1.5 rounded bg-zinc-800" aria-hidden>
          <span className="absolute top-0 bottom-0 rounded" style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%`, background: BAR[layer.type] ?? '#71717a', opacity: visible ? 0.9 : 0.35 }} />
          <span className="absolute -top-1 -bottom-1 w-px bg-red-400" style={{ left: 'var(--ph, 0%)' }} />
        </div>
      </div>
      <button className="w-12 flex items-center justify-center text-[20px] flex-shrink-0" data-flag="visible" data-on={visible ? '1' : '0'} aria-label={visible ? '非表示にする' : '表示する'} aria-pressed={visible}
              onClick={e => { e.stopPropagation(); useCompStore.getState().toggleFlag(id, 'visible') }}>
        <span className={visible ? '' : 'opacity-25 grayscale'}>👁</span>
      </button>
    </div>
  )
})

export function MobileLayers({ onProps, onPresets, onOpenChild }: { onProps: () => void; onPresets: () => void; onOpenChild: (compId: number) => void }) {
  const layers = useCompStore(s => s.doc.layers)
  const sel = useCompStore(s => s.sel)
  const dur = useCompStore(s => s.settings.duration_frames)
  const schema = useCompStore(s => s.schema)
  const reveal = useCompStore(s => s.reveal)
  const [query, setQuery] = useState('')
  const [aliveOnly, setAliveOnly] = useState(() => useCompStore.getState().doc.layers.length > ALIVE_DEFAULT_OVER)
  const [scroll, setScroll] = useState({ top: 0, h: 400 })
  const boxRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 「今映っている層だけ」: 映っているレイヤーの組が変わったときだけ描き直す(再生位置そのものは購読しない)
  const aliveSig = useCompStore(s => {
    if (!aliveOnly) return ''
    const d = s.settings.duration_frames, f = s.frame
    let out = ''
    for (const l of s.doc.layers) if (f >= layerIn(l) && f < layerOut(l, d)) out += l.id + '\u0001'
    return out
  })

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const alive = aliveOnly ? new Set(aliveSig.split('\u0001')) : null
    return layers.filter(l => (!alive || alive.has(l.id))
      && (!needle || `${l.name ?? ''}\n${l.id}\n${l.type}\n${typeLabel(schema, l.type)}`.toLowerCase().includes(needle)))
  }, [layers, query, aliveOnly, aliveSig, schema])
  const selSet = useMemo(() => new Set(sel), [sel])

  // 再生位置の線は CSS 変数で動かす(行を描き直さない)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const put = () => { const s = useCompStore.getState(); el.style.setProperty('--ph', `${(s.frame / Math.max(1, s.settings.duration_frames)) * 100}%`) }
    put()
    return useCompStore.subscribe((s, p) => { if (s.frame !== p.frame || s.settings !== p.settings) put() })
  }, [])

  // 見えている範囲
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const upd = () => { raf = 0; setScroll(p => (p.top === el.scrollTop && p.h === el.clientHeight ? p : { top: el.scrollTop, h: el.clientHeight })) }
    const on = () => { if (!raf) raf = requestAnimationFrame(upd) }
    upd()
    el.addEventListener('scroll', on, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(on) : null
    ro?.observe(el)
    return () => { cancelAnimationFrame(raf); el.removeEventListener('scroll', on); ro?.disconnect() }
  }, [])

  // プレビューで選んだレイヤーの行を見える所へ
  const rowsRef = useRef(rows)
  useLayoutEffect(() => { rowsRef.current = rows }, [rows])
  useEffect(() => {
    const el = scrollRef.current
    if (!reveal || !el) return
    const i = rowsRef.current.findIndex(l => l.id === reveal.id)
    if (i < 0) return
    const top = i * ROW_H
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - Math.max(0, el.clientHeight / 2 - ROW_H))
  }, [reveal])

  const a = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN)
  const b = Math.min(rows.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + OVERSCAN)
  const vis = rows.slice(a, b)
  const primary = sel.length ? layers.find(l => l.id === sel[sel.length - 1]) : undefined
  const st = useCompStore.getState
  const chip = 'h-10 px-3 rounded-full border text-[13px] whitespace-nowrap flex-shrink-0'
  const act = 'h-10 px-3 rounded-lg border border-zinc-700 bg-zinc-800 text-[13px] text-zinc-100 whitespace-nowrap flex-shrink-0 active:bg-zinc-700 disabled:opacity-40'

  return (
    <div ref={boxRef} className="flex-1 min-h-0 flex flex-col bg-zinc-950" data-comp-mlayers data-rows-total={rows.length} data-rows-mounted={vis.length}
         onPointerDownCapture={() => useCompStore.getState().setFocusArea('timeline')}>
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
        <AddLayerMenu />
        <input className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded-lg px-2 h-10 text-[16px] text-zinc-100 outline-none focus:border-purple-500" placeholder="🔍 名前・種類" type="search" enterKeyHint="search"
               value={query} data-layer-filter onChange={e => setQuery(e.target.value)} />
        <button className={`${chip} ${aliveOnly ? 'bg-purple-800 border-purple-500 text-white' : 'border-zinc-600 text-zinc-300'}`} data-alive-only={aliveOnly ? '1' : '0'} aria-pressed={aliveOnly}
                onClick={() => setAliveOnly(v => !v)}>{aliveOnly ? '✓ ' : ''}今映っている層だけ</button>
      </div>
      <div className="px-3 py-1 text-[12px] text-zinc-400 border-b border-zinc-800 flex-shrink-0 flex items-center gap-2" data-layer-count>
        <span>{rows.length === layers.length ? `${layers.length} レイヤー` : `${rows.length} / ${layers.length} レイヤー`}(上が手前)</span>
        {(aliveOnly || !!query.trim()) && rows.length !== layers.length && (
          <button className="ml-auto text-purple-300 underline underline-offset-2 !min-h-0 py-1" onClick={() => { setQuery(''); setAliveOnly(false) }}>すべて出す</button>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 comp-scroll" data-mlayers-scroll>
        {layers.length === 0 && <div className="p-5 text-[14px] text-zinc-400 leading-relaxed">レイヤーがありません。左上の「+ レイヤー」から、テキスト・シェイプ・画像などを足してください。</div>}
        {layers.length > 0 && rows.length === 0 && <div className="p-5 text-[14px] text-zinc-400 leading-relaxed">この位置に映っているレイヤー(または検索に合うレイヤー)がありません。「すべて出す」で全部を並べます。</div>}
        <div style={{ height: a * ROW_H }} />
        {vis.map(l => (
          <Row key={l.id} layer={l} selected={selSet.has(l.id)} dur={dur} icon={typeIcon(schema, l.type)} typeName={typeLabel(schema, l.type)} onProps={onProps} />
        ))}
        <div style={{ height: Math.max(0, rows.length - b) * ROW_H }} />
      </div>
      {primary && (
        <div className="flex items-center gap-2 px-2 py-1.5 border-t border-zinc-700 bg-zinc-900 flex-shrink-0 overflow-x-auto" data-mlayers-actions>
          <button className={`${act} !border-purple-500 !bg-purple-900/60`} onClick={onProps} data-mact="props">🎛 プロパティ</button>
          <button className={act} onClick={onPresets} data-mact="presets">✨ プリセット</button>
          {primary.type === 'comp' && typeof primary.source?.comp_id === 'number' && (
            <button className={act} onClick={() => onOpenChild(primary.source!.comp_id as number)} data-mact="open-child">🎞 中を開く</button>
          )}
          <button className={act} onClick={() => st().toggleFlag(primary.id, 'locked')} data-mact="lock">{primary.locked ? '🔓 ロック解除' : '🔒 ロック'}</button>
          <button className={act} onClick={() => st().toggleFlag(primary.id, 'solo')} data-mact="solo">{primary.solo ? 'ソロ解除' : 'S ソロ'}</button>
          <button className={act} onClick={() => st().duplicateSelection()} data-mact="dup">⧉ 複製</button>
          <button className={act} onClick={() => st().addTransformKeys()} data-mact="key">◆ キー</button>
          <button className={`${act} !text-red-300`} onClick={() => st().deleteSelection()} data-mact="del">🗑 削除</button>
        </div>
      )}
    </div>
  )
}
