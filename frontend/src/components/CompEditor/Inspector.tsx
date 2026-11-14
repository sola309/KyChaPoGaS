// 🎞 右の欄「プロパティ」: 選んだレイヤーの変形・中身・共通の機能・エフェクト・マスク。
// 変形のほかは、すべてスキーマ(layer_types.source / layer_common / effects / mask)から欄を作る。

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CompSchema, Effect, Layer, Mask, ParamDesc } from './types'
import { getPath, isKeyed, isObj, layerIn, layerOut } from './docOps'
import { useCompStore } from './store'
import { PropField, EasingSelect, FieldList } from './PropField'
import { NumField, Row, Section, btnCls, iconBtnCls, inputCls } from './fields'
import { commonFor, effectInfo, groupBy, newEffect, optionsOf, typeIcon, typeLabel } from './schema'
import { SourceTools, skipSourceMemo } from './SourceTools'

const T_POS: ParamDesc = { type: 'vec3', label: '位置', animatable: true }
const T_ANCHOR: ParamDesc = { type: 'vec3', label: 'アンカー', default: [0, 0, 0], animatable: true }
const T_SCALE: ParamDesc = { type: 'vec3', label: '拡大(%)', default: [100, 100, 100], animatable: true }
const T_ROT: ParamDesc = { type: 'angle', label: '回転(度)', default: 0, animatable: true }
const T_ROT3: ParamDesc = { type: 'vec3', label: '回転(度)', default: [0, 0, 0], animatable: true }
const T_OPACITY: ParamDesc = { type: 'number', label: '不透明度(%)', default: 100, min: 0, max: 100, animatable: true }
const NO_DESCS: Record<string, ParamDesc> = {}

// ── エフェクトを足すメニュー(組ごと・検索つき) ────────────────────────────────

function EffectMenu({ schema, onPick }: { schema: CompSchema; onPick: (type: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState({ right: 0, top: 0, maxH: 400 })
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const aliasOf = new Map<string, string[]>()
    for (const [a, c] of Object.entries(schema.effect_aliases)) aliasOf.set(c, [...(aliasOf.get(c) ?? []), a])
    const items = Object.entries(schema.effects).filter(([t, d]) => !needle
      || t.toLowerCase().includes(needle) || (d.label ?? '').toLowerCase().includes(needle) || (d.group ?? '').toLowerCase().includes(needle)
      || (aliasOf.get(t) ?? []).some(a => a.includes(needle)))
    return groupBy(items, d => d.group)
  }, [schema, q])
  const first = groups[0]?.[1][0]?.[0]
  const pick = (t: string) => { setOpen(false); setQ(''); onPick(t) }
  return (
    <>
      <button className={`${btnCls} border-purple-700 text-purple-200`} data-effect-add title="エフェクトを足す(上から順に掛かる)"
              onClick={e => {
                const r = e.currentTarget.getBoundingClientRect()
                const top = Math.min(r.bottom + 4, window.innerHeight - 260)
                setPos({ right: Math.max(4, window.innerWidth - r.right), top, maxH: window.innerHeight - top - 8 })
                setOpen(o => !o)
              }}>+ 足す…</button>
      {open && createPortal(
        <div ref={boxRef} className="fixed z-[200] w-[300px] flex flex-col rounded-md border border-zinc-600 bg-zinc-900 shadow-2xl" style={{ right: pos.right, top: pos.top, maxHeight: pos.maxH }} data-effect-menu>
          <input autoFocus className={`${inputCls} m-1.5`} placeholder={`エフェクトをさがす(${Object.keys(schema.effects).length} 種)`} value={q} data-effect-search
                 onChange={e => setQ(e.target.value)}
                 onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && first) pick(first); else if (e.key === 'Escape') setOpen(false) }} />
          <div className="overflow-y-auto pb-1">
            {groups.length === 0 && <div className="px-3 py-2 text-[11px] text-zinc-500">見つかりません</div>}
            {groups.map(([g, items]) => (
              <div key={g || '_'}>
                <div className="px-2 pt-1.5 pb-0.5 text-[9px] text-zinc-500 sticky top-0 bg-zinc-900 border-b border-zinc-800" data-effect-group={g}>{g || 'そのほか'}</div>
                {items.map(([t, d]) => (
                  <button key={t} data-effect-item={t} className="w-full text-left px-3 py-[3px] text-[11px] text-zinc-200 hover:bg-purple-800 flex items-center gap-2" onClick={() => pick(t)}>
                    <span className="flex-1 truncate">{d.label ?? t}</span>
                    <span className="text-[9px] text-zinc-500 font-mono">{t}</span>
                    {d.cheap === true && <span className="text-[8px] px-1 rounded bg-emerald-950 text-emerald-300" title="軽い(レンダーターゲットを使わない)">軽</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

// ── エフェクト ──────────────────────────────────────────────────────────────

function EffectsPanel({ layer, schema }: { layer: Layer; schema: CompSchema }) {
  const setRaw = useCompStore(s => s.setRaw)
  const effects: Effect[] = Array.isArray(layer.effects) ? layer.effects : []
  // 多いときは閉じて並べる(取り込んだ文書は 1 レイヤーに 10 個以上ある)
  const [openIdx, setOpenIdx] = useState<Record<number, boolean>>({})
  const defOpen = effects.length <= 3
  const ids = useMemo(() => [layer.id], [layer.id])
  const write = (next: Effect[]) => setRaw(ids, 'effects', next)
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= effects.length) return
    const a = [...effects]
    ;[a[i], a[j]] = [a[j], a[i]]
    setOpenIdx(o => ({ ...o, [i]: o[j] ?? defOpen, [j]: o[i] ?? defOpen }))
    write(a)
  }
  return (
    <Section title={`エフェクト(${effects.length})`} right={
      <span className="flex items-center gap-1">
        {effects.length > 3 && <button className={iconBtnCls} title="すべて開く / 閉じる"
          onClick={() => { const anyOpen = effects.some((_, i) => openIdx[i] ?? defOpen); setOpenIdx(Object.fromEntries(effects.map((_, i) => [i, !anyOpen]))) }}>⇕</button>}
        <EffectMenu schema={schema} onPick={t => { setOpenIdx(o => ({ ...o, [effects.length]: true })); write([...effects, newEffect(schema, t)]) }} />
      </span>
    }>
      {effects.length === 0 && <div className="text-[10px] text-zinc-600">なし(上から順に掛かります。同じ種類を何個でも重ねられます)</div>}
      {effects.map((fx, i) => {
        if (!isObj(fx)) return null
        const info = effectInfo(schema, fx.type)
        const d = info.desc
        const open = openIdx[i] ?? defOpen
        const nKeys = Object.values(fx.params ?? {}).filter(isKeyed).length
        return (
          <div key={i} className="border border-zinc-800 rounded bg-zinc-900/60" data-effect-row={i} data-effect-type={fx.type}>
            <div className="flex items-center gap-1 px-1 py-0.5">
              <input type="checkbox" checked={fx.enabled !== false} title="有効 / 無効"
                     onChange={e => setRaw(ids, `effects.${i}.enabled`, e.target.checked)} />
              <button className="flex-1 min-w-0 text-left text-[11px] text-zinc-200 truncate" onClick={() => setOpenIdx(o => ({ ...o, [i]: !open }))}
                      title={`${fx.type}${info.alias ? `(${info.canonical} の別名。文書の名前はそのまま保ちます)` : ''}`}>
                <span className="text-zinc-500 inline-block w-3">{open ? '▾' : '▸'}</span>{d?.label ?? fx.type}
                {info.alias && <span className="text-zinc-500 ml-1 font-mono text-[9px]">{fx.type}</span>}
                {nKeys > 0 && <span className="text-amber-500 ml-1 text-[9px]">◆{nKeys}</span>}
                {!d && <span className="text-zinc-500 ml-1">(この画面が知らない種類。そのまま保ちます)</span>}
              </button>
              {d?.cheap === true && <span className="text-[8px] px-1 rounded bg-emerald-950 text-emerald-300 flex-shrink-0" title="軽い(レンダーターゲットを使わない)">軽</span>}
              <button className={iconBtnCls} disabled={i === 0} title="上へ(先に掛ける)" onClick={() => move(i, -1)}>↑</button>
              <button className={iconBtnCls} disabled={i === effects.length - 1} title="下へ" onClick={() => move(i, 1)}>↓</button>
              <button className={iconBtnCls} title="複製" onClick={() => { const a = [...effects]; a.splice(i + 1, 0, JSON.parse(JSON.stringify(fx)) as Effect); write(a) }}>⧉</button>
              <button className={`${iconBtnCls} hover:text-red-400`} title="外す" data-effect-del onClick={() => { setOpenIdx({}); write(effects.filter((_, j) => j !== i)) }}>✕</button>
            </div>
            {open && (
              <div className="px-1 pb-1 flex flex-col gap-1">
                <FieldList ids={ids} layer={layer} base={`effects.${i}.params`} descs={d?.params ?? NO_DESCS} />
              </div>
            )}
          </div>
        )
      })}
    </Section>
  )
}

// ── マスク ──────────────────────────────────────────────────────────────────

const MASK_POINTS: Record<string, ParamDesc> = { points: { type: 'points', label: '頂点(箱の左上が原点)', default: [[0, 0], [200, 0], [100, 180]], animatable: true } }
const POINT_SHAPES = new Set(['polygon', 'path'])
const skipBox = (k: string) => k === 'x' || k === 'y' || k === 'w' || k === 'h' || k === 'radius' || k === 'points'
const skipPoints = (k: string) => k === 'points'

function MasksPanel({ layer, schema }: { layer: Layer; schema: CompSchema }) {
  const setRaw = useCompStore(s => s.setRaw)
  const masks: Mask[] = Array.isArray(layer.masks) ? layer.masks : []
  const ids = useMemo(() => [layer.id], [layer.id])
  const shapes = useMemo(() => (schema.mask.shape ? optionsOf(schema, schema.mask.shape) : []), [schema])
  const add = (shape: string) => {
    const m: Mask = POINT_SHAPES.has(shape)
      ? { shape, points: [[0, 0], [200, 0], [100, 180]], feather: 0 }
      : { shape, x: 0, y: 0, w: 200, h: 200, feather: 0, ...(shape === 'rounded_rect' ? { radius: 24 } : {}) }
    setRaw(ids, 'masks', [...masks, m])
  }
  return (
    <Section key={masks.length > 0 ? 'has' : 'none'} title={`マスク(${masks.length})`} defaultOpen={masks.length > 0} right={
      <select className={`${inputCls} w-[92px]`} value="" title="マスクを足す(座標はレイヤーの箱の左上が原点。4 個まで)" data-mask-add
              onChange={e => { if (e.target.value) add(e.target.value) }}>
        <option value="">+ 足す…</option>
        {shapes.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    }>
      {masks.length === 0 && <div className="text-[10px] text-zinc-600">なし</div>}
      {masks.length > 4 && <div className="text-[10px] text-amber-400">エンジンが使うのは先頭の 4 個までです</div>}
      {masks.map((m, i) => isObj(m) && (
        <div key={i} className="border border-zinc-800 rounded bg-zinc-900/60 px-1 py-1 flex flex-col gap-1" data-mask-row={i}>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-zinc-400 flex-1">マスク {i + 1}</span>
            <button className={`${iconBtnCls} hover:text-red-400`} title="外す" onClick={() => setRaw(ids, 'masks', masks.filter((_, j) => j !== i))}>✕</button>
          </div>
          <FieldList ids={ids} layer={layer} base={`masks.${i}`} descs={schema.mask} skip={POINT_SHAPES.has(String(m.shape)) ? skipBox : skipPoints} />
          {POINT_SHAPES.has(String(m.shape)) && <FieldList ids={ids} layer={layer} base={`masks.${i}`} descs={MASK_POINTS} extras={false} />}
        </div>
      ))}
    </Section>
  )
}

// ── 選んだキーフレーム ────────────────────────────────────────────────────────

function KeyframePanel() {
  const selKeys = useCompStore(s => s.selKeys)
  const doc = useCompStore(s => s.doc)
  const setEase = useCompStore(s => s.setSelKeysEase)
  const del = useCompStore(s => s.deleteSelection)
  if (!selKeys.length) return null
  const first = selKeys[0]
  const l = doc.layers.find(x => x.id === first.layerId)
  const p = l ? getPath(l, first.path) : null
  const key = isKeyed(p) ? p.k.find(k => Math.abs(k.f - first.f) < 1e-4) : null
  return (
    <Section title={`選んだキーフレーム(${selKeys.length})`}>
      <Row label="イージング" title="このキーから次のキーまでの動き方">
        {isObj(key?.e)
          ? <span className="text-[10px] text-zinc-400 font-mono truncate" title="式のイージング({pow} {back} {penner})。下の一覧から選ぶと置き換わります">{JSON.stringify(key?.e)}</span>
          : null}
        <EasingSelect value={isObj(key?.e) ? undefined : key?.e} onChange={setEase} />
      </Row>
      <div className="flex items-center gap-2 text-[10px] text-zinc-500">
        <span className="truncate">{first.path} @ {first.f}</span>
        <button className={`${btnCls} ml-auto flex-shrink-0`} title="Ctrl+C(貼るのは Ctrl+V。再生位置から)" onClick={() => useCompStore.getState().copySelection()}>コピー</button>
        <button className={`${btnCls} flex-shrink-0`} onClick={del}>キーを消す</button>
      </div>
    </Section>
  )
}

// ── レイヤーの基本 ────────────────────────────────────────────────────────────

const LayerBasics = memo(function LayerBasics({ layer, ids }: { layer: Layer; ids: string[] }) {
  const dur = useCompStore(s => s.settings.duration_frames)
  const patchLayer = useCompStore(s => s.patchLayer)
  const setRaw = useCompStore(s => s.setRaw)
  const end = useCompStore(s => s.endCoalesce)
  const schema = useCompStore(s => s.schema)
  const mb = layer.motion_blur
  return (
    <Section title="レイヤー">
      <Row label="名前">
        <input className={`${inputCls} flex-1`} value={layer.name ?? ''} placeholder={layer.id}
               onChange={e => patchLayer(layer.id, { name: e.target.value }, 'name')} onBlur={end} />
      </Row>
      <Row label="種類 / id">
        <span className="text-[11px] text-zinc-300">{typeIcon(schema, layer.type)} {typeLabel(schema, layer.type)}</span>
        <span className="text-[10px] text-zinc-500 font-mono truncate">{layer.id}</span>
      </Row>
      <Row label="表示する区間" title="in(このコマから)〜 out(このコマの手前まで)">
        <NumField prefix="⇤" value={layerIn(layer)} step={1} onEnd={end}
                  onChange={v => setRaw(ids, 'in', Math.round(Math.min(v, layerOut(layer, dur) - 1)), 'in')} />
        <NumField prefix="⇥" value={layerOut(layer, dur)} step={1} onEnd={end}
                  onChange={v => setRaw(ids, 'out', Math.round(Math.max(v, layerIn(layer) + 1)), 'out')} />
      </Row>
      <Row label="モーションブラー" title="前後 1/4 コマずつを足し込む(重い)。数は足し込む回数">
        <input type="checkbox" checked={!!mb} onChange={e => setRaw(ids, 'motion_blur', e.target.checked ? true : false)} />
        {!!mb && <NumField prefix="回" className="w-[58px]" value={typeof mb === 'number' ? mb : 16} min={2} max={64} step={1} onEnd={end}
                           onChange={v => setRaw(ids, 'motion_blur', Math.round(v), 'mb')} />}
      </Row>
    </Section>
  )
})

/** 複数選択のまとめ操作(表示・ソロ・ロック・下絵) */
function BulkBar({ ids }: { ids: string[] }) {
  const setFlagAll = useCompStore(s => s.setFlagAll)
  const b = (label: string, key: 'visible' | 'locked' | 'solo' | 'guide', value: boolean, title: string) => (
    <button key={label} className={`${btnCls} !px-1.5`} title={title} data-bulk={`${key}:${value}`} onClick={() => setFlagAll(ids, key, value)}>{label}</button>
  )
  return (
    <div className="px-2 py-1 flex items-center gap-1 flex-wrap border-b border-zinc-800 bg-zinc-900/60" data-bulk-bar>
      <span className="text-[10px] text-zinc-500 mr-1">まとめて</span>
      {b('👁 表示', 'visible', true, '選んだレイヤーをすべて表示')}{b('非表示', 'visible', false, '選んだレイヤーをすべて非表示')}
      {b('S ソロ', 'solo', true, '選んだレイヤーをすべてソロに')}{b('ソロ解除', 'solo', false, '選んだレイヤーのソロを外す')}
      {b('🔒', 'locked', true, 'すべてロック')}{b('🔓', 'locked', false, 'ロックを外す')}
    </div>
  )
}

const skipCommon = (k: string) => k.startsWith('transform.') || k === 'in' || k === 'out' || k === 'motion_blur' || k === 'parent'
const PARENT_FALLBACK: ParamDesc = { type: 'text', label: '親レイヤー', layer: true, optional: true, default: null }

// ── 本体 ────────────────────────────────────────────────────────────────────

export function Inspector() {
  const sel = useCompStore(s => s.sel)
  const primaryId = sel[sel.length - 1]
  const layer = useCompStore(s => (primaryId ? s.doc.layers.find(l => l.id === primaryId) : undefined))
  const schema = useCompStore(s => s.schema)
  const settings = useCompStore(s => s.settings)
  const layerType = layer?.type ?? ''

  const camSrc = layerType === 'camera' ? layer?.source : undefined
  const tDescs = useMemo(() => {
    const cx = settings.width / 2, cy = settings.height / 2
    // カメラの既定の位置: 画面の中心の正面、距離 = zoom(無ければ水平画角から)。エンジン(scene.js zoomOf)と同じ式
    let z = 0
    if (layerType === 'camera') {
      const zoom = typeof camSrc?.zoom === 'number' ? camSrc.zoom : 0
      const fov = typeof camSrc?.fov === 'number' ? Math.min(170, Math.max(1, camSrc.fov)) : 39.6
      z = -(zoom > 0 ? zoom : Math.round((settings.width / 2 / Math.tan((fov * Math.PI) / 360)) * 10) / 10)
    }
    return { pos: { ...T_POS, default: [cx, cy, z] } as ParamDesc }
  }, [settings.width, settings.height, layerType, camSrc?.zoom, camSrc?.fov])
  const commonGroups = useMemo(() => {
    const all = commonFor(schema, layerType)
    return groupBy(Object.entries(all).filter(([k]) => !skipCommon(k)), d => d.group)
      .map(([g, items]) => [g, Object.fromEntries(items)] as [string, Record<string, ParamDesc>])
  }, [schema, layerType])

  if (!layer) {
    return (
      <div className="flex-1 overflow-y-auto" data-comp-inspector onPointerDownCapture={() => useCompStore.getState().setFocusArea('panel')}>
        <KeyframePanel />
        <div className="p-4 text-[11px] text-zinc-500 leading-relaxed">
          レイヤーを選ぶと、ここに位置・拡大・中身・エフェクトが出ます。<br />
          左下の「+ レイヤー」で足せます。プレビューの上でドラッグして動かせます。
        </div>
      </div>
    )
  }
  const td = !!layer.three_d || layer.type === 'camera'
  const lt = schema.layer_types[layer.type]
  const srcDescs = lt?.source ?? NO_DESCS
  const hasSource = Object.keys(srcDescs).length > 0 || (isObj(layer.source) && Object.keys(layer.source).length > 0)
  const noTransform = layer.type === 'adjustment' && !layer.snapshot
  const rot3 = Array.isArray(evalFirst(layer.transform?.rotation)) || layer.transform?.rotation === undefined
  const parentDesc = schema.layer_common.parent ?? PARENT_FALLBACK
  const camDefault = layer.type === 'camera' && layer.transform?.position === undefined
  return (
    <div className="flex-1 overflow-y-auto" data-comp-inspector onPointerDownCapture={() => useCompStore.getState().setFocusArea('panel')}>
      {sel.length > 1 && <div className="px-2 py-1 text-[10px] text-amber-300 bg-amber-950/40 border-b border-zinc-800" data-multi-note>
        {sel.length} レイヤーを選択中 — 値は「{layer.name ?? layer.id}」のもの。数値を<b>ドラッグ</b>すると全部が同じ量だけ動き(差を保つ)、<b>入力</b>すると全部が同じ値になります</div>}
      {sel.length > 1 && <BulkBar ids={sel} />}
      {!!layer.locked && <div className="px-2 py-1 text-[10px] text-zinc-400 bg-zinc-800/60 border-b border-zinc-800">🔒 ロック中(行の 🔒 で外せます)</div>}
      <KeyframePanel />
      <LayerBasics layer={layer} ids={sel} />
      {!noTransform && (
        <Section title="トランスフォーム">
          <PropField ids={sel} layer={layer} path="transform.position" desc={tDescs.pos} dims={td ? 3 : 2} />
          {camDefault && <div className="text-[9px] text-zinc-500 ml-5" data-camera-default>位置を書いていないカメラ = 既定の位置(画面の中心の正面、距離 {Math.abs((tDescs.pos.default as number[])[2])})。注視するレイヤーがあるときはその正面。値を動かすとここから始まります</div>}
          {layer.type !== 'camera' && <PropField ids={sel} layer={layer} path="transform.anchor" desc={T_ANCHOR} dims={td ? 3 : 2} />}
          {layer.type !== 'camera' && <PropField ids={sel} layer={layer} path="transform.scale" desc={T_SCALE} dims={td ? 3 : 2} link />}
          {td
            ? <PropField ids={sel} layer={layer} path="transform.rotation" desc={rot3 ? T_ROT3 : T_ROT} dims={rot3 ? 3 : undefined} rotZ={!rot3} />
            : <PropField ids={sel} layer={layer} path="transform.rotation" desc={T_ROT} rotZ />}
          {td && !rot3 && (
            <button className={`${btnCls} self-start ml-5`} title="回転を [x, y, z] の 3 軸にする"
                    onClick={() => useCompStore.getState().setRaw([layer.id], 'transform.rotation', to3Rot(layer.transform?.rotation))}>X・Y 軸の回転も使う</button>
          )}
          {layer.type !== 'camera' && <PropField ids={sel} layer={layer} path="transform.opacity" desc={T_OPACITY} />}
          <PropField ids={sel} layer={layer} path="parent" desc={parentDesc} />
        </Section>
      )}
      {hasSource && (
        <Section title={`中身(${typeLabel(schema, layer.type)})`}>
          <SourceTools layer={layer} />
          <FieldList ids={sel} layer={layer} base="source" descs={srcDescs} skip={skipSourceMemo} />
        </Section>
      )}
      {commonGroups.map(([g, descs]) => {
        // 何か書かれている組は開いて出す(登場・複製など、使っている機能がすぐ見えるように)
        const active = Object.keys(descs).some(k => !['visible', 'locked', 'solo', 'blend'].includes(k) && getPath(layer, k) !== undefined)
        return (
          <Section key={`${layer.id}:${g}`} title={`${g || 'そのほか'}${active ? ' ●' : ''}`} defaultOpen={active}>
            <FieldList ids={sel} layer={layer} base="" descs={descs} switches />
          </Section>
        )
      })}
      <EffectsPanel key={`fx:${layer.id}`} layer={layer} schema={schema} />
      <MasksPanel key={`mask:${layer.id}`} layer={layer} schema={schema} />
      <div className="h-8" />
    </div>
  )
}

/** キーつきなら最初のキーの値、そうでなければ値そのもの(形を見るため) */
function evalFirst(p: unknown): unknown {
  if (isObj(p)) return Array.isArray(p.k) && p.k.length ? (p.k[0] as { v: unknown }).v : p.v
  return p
}

/** 回転(数)を [0, 0, z] に直す(キーも揃える) */
function to3Rot(p: unknown): unknown {
  const conv = (v: unknown) => (typeof v === 'number' ? [0, 0, v] : v)
  if (isObj(p)) {
    const n: Record<string, unknown> = { ...p }
    if (Array.isArray(p.k)) n.k = p.k.map(k => (isObj(k) ? { ...k, v: conv(k.v) } : k))
    if ('v' in p) n.v = conv(p.v)
    return n
  }
  return conv(p ?? 0)
}
