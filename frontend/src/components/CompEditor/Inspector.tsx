// 🎞 右の欄「プロパティ」: 選んだレイヤーの変形・中身・エフェクト・マスク。中身とエフェクトの欄はスキーマから作る。

import { memo, useMemo, useState } from 'react'
import type { CompSchema, Effect, Layer, Mask, ParamDesc } from './types'
import { getPath, isKeyed, isObj, layerIn, layerOut } from './docOps'
import { useCompStore } from './store'
import { PropField, EasingSelect } from './PropField'
import { NumField, Row, Section, btnCls, iconBtnCls, inputCls } from './fields'
import { groupBy, newEffect, typeIcon, typeLabel } from './schema'

const T_POS: ParamDesc = { type: 'vec3', label: '位置', animatable: true }
const T_ANCHOR: ParamDesc = { type: 'vec3', label: 'アンカー', default: [0, 0, 0], animatable: true }
const T_SCALE: ParamDesc = { type: 'vec3', label: '拡大(%)', default: [100, 100, 100], animatable: true }
const T_ROT: ParamDesc = { type: 'angle', label: '回転(度)', default: 0, animatable: true }
const T_ROT3: ParamDesc = { type: 'vec3', label: '回転(度)', default: [0, 0, 0], animatable: true }
const T_OPACITY: ParamDesc = { type: 'number', label: '不透明度(%)', default: 100, min: 0, max: 100, animatable: true }

/** 知らない項目の値から、欄の型を見立てる */
function guessDesc(v: unknown): ParamDesc {
  const x = isObj(v) && Array.isArray(v.k) && v.k.length ? (v.k[0] as { v: unknown }).v : isObj(v) && 'v' in v ? v.v : v
  if (typeof x === 'number') return { type: 'number', animatable: true }
  if (typeof x === 'boolean') return { type: 'bool' }
  if (typeof x === 'string') return /^#[0-9a-f]{3,8}$/i.test(x) ? { type: 'color', animatable: true } : { type: 'text' }
  if (Array.isArray(x) && x.length >= 2 && x.length <= 3 && x.every(n => typeof n === 'number')) return { type: x.length === 3 ? 'vec3' : 'vec2', animatable: true }
  if (Array.isArray(x) && x.length && x.every(c => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c))) return { type: 'colors' }
  return { type: 'json' }
}

/** スキーマの記述(点つきの名前 = 入れ子)と、記述に無い実際の項目を合わせて行にする */
function SchemaFields({ ids, layer, base, descs, skip }: { ids: string[]; layer: Layer; base: string; descs: Record<string, ParamDesc>; skip?: (name: string) => boolean }) {
  const container = base ? getPath(layer, base) : layer
  const rows = useMemo(() => {
    const entries = Object.entries(descs).filter(([k]) => !skip?.(k))
    const covered = new Set(entries.map(([k]) => k.split('.')[0]))
    const extra: [string, ParamDesc][] = []
    if (base && isObj(container)) {
      for (const [k, v] of Object.entries(container)) {
        if (covered.has(k) || skip?.(k)) continue
        extra.push([k, { ...guessDesc(v), label: k, group: 'その他' }])
      }
    }
    return groupBy([...entries, ...extra], d => d.group)
    // container の中身(項目の有無)が変わったら作り直す
  }, [descs, container, base, skip])
  return (
    <>
      {rows.map(([g, items]) => (
        <div key={g || '_'} className="flex flex-col gap-1">
          {g && <div className="text-[9px] text-zinc-500 mt-1 border-b border-zinc-800">{g}</div>}
          {items.map(([name, d]) => (
            <PropField key={name} ids={ids} layer={layer} path={base ? `${base}.${name}` : name} desc={d} />
          ))}
        </div>
      ))}
    </>
  )
}

// ── エフェクト ──────────────────────────────────────────────────────────────

function EffectsPanel({ ids, layer, schema }: { ids: string[]; layer: Layer; schema: CompSchema }) {
  const setRaw = useCompStore(s => s.setRaw)
  const effects: Effect[] = Array.isArray(layer.effects) ? layer.effects : []
  const [openIdx, setOpenIdx] = useState<Record<number, boolean>>({})
  const groups = useMemo(() => groupBy(Object.entries(schema.effects), d => d.group), [schema.effects])
  const write = (next: Effect[]) => setRaw([layer.id], 'effects', next)
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= effects.length) return
    const a = [...effects]
    ;[a[i], a[j]] = [a[j], a[i]]
    write(a)
  }
  return (
    <Section title={`エフェクト(${effects.length})`} right={
      <select className={`${inputCls} w-[92px]`} value="" title="エフェクトを足す(上から順に掛かる)"
              onChange={e => { if (e.target.value) write([...effects, newEffect(schema, e.target.value)]) }}>
        <option value="">+ 足す…</option>
        {groups.map(([g, items]) => g
          ? <optgroup key={g} label={g}>{items.map(([t, d]) => <option key={t} value={t}>{d.label ?? t}</option>)}</optgroup>
          : items.map(([t, d]) => <option key={t} value={t}>{d.label ?? t}</option>))}
      </select>
    }>
      {effects.length === 0 && <div className="text-[10px] text-zinc-600">なし</div>}
      {effects.map((fx, i) => {
        if (!isObj(fx)) return null
        const d = schema.effects[fx.type]
        const closed = openIdx[i] === false
        return (
          <div key={i} className="border border-zinc-800 rounded bg-zinc-900/60">
            <div className="flex items-center gap-1 px-1 py-0.5">
              <input type="checkbox" checked={fx.enabled !== false} title="有効 / 無効"
                     onChange={e => setRaw([layer.id], `effects.${i}.enabled`, e.target.checked)} />
              <button className="flex-1 text-left text-[11px] text-zinc-200 truncate" onClick={() => setOpenIdx(o => ({ ...o, [i]: closed }))}>
                <span className="text-zinc-500 inline-block w-3">{closed ? '▸' : '▾'}</span>{d?.label ?? fx.type}
                {!d && <span className="text-zinc-500 ml-1">(この画面が知らない種類。そのまま保ちます)</span>}
              </button>
              <button className={iconBtnCls} disabled={i === 0} title="上へ(先に掛ける)" onClick={() => move(i, -1)}>↑</button>
              <button className={iconBtnCls} disabled={i === effects.length - 1} title="下へ" onClick={() => move(i, 1)}>↓</button>
              <button className={`${iconBtnCls} hover:text-red-400`} title="外す" onClick={() => write(effects.filter((_, j) => j !== i))}>✕</button>
            </div>
            {!closed && (
              <div className="px-1 pb-1 flex flex-col gap-1">
                <SchemaFields ids={ids.length > 1 ? [layer.id] : ids} layer={layer} base={`effects.${i}.params`} descs={d?.params ?? NO_DESCS} />
              </div>
            )}
          </div>
        )
      })}
    </Section>
  )
}
const NO_DESCS: Record<string, ParamDesc> = {}

// ── マスク ──────────────────────────────────────────────────────────────────

const MASK_NUM: Record<string, ParamDesc> = {
  x: { type: 'number', label: 'X', default: 0, animatable: true }, y: { type: 'number', label: 'Y', default: 0, animatable: true },
  w: { type: 'number', label: '幅', default: 200, min: 0, animatable: true }, h: { type: 'number', label: '高さ', default: 200, min: 0, animatable: true },
}
const MASK_COMMON: Record<string, ParamDesc> = {
  feather: { type: 'number', label: 'ぼかし', default: 0, min: 0, animatable: true },
  opacity: { type: 'number', label: '不透明度', default: 100, min: 0, max: 100, animatable: true },
  invert: { type: 'bool', label: '反転', default: false },
}
const MASK_POINTS: ParamDesc = { type: 'json', label: '頂点 [[x,y]…]' }

function MasksPanel({ layer }: { layer: Layer }) {
  const setRaw = useCompStore(s => s.setRaw)
  const masks: Mask[] = Array.isArray(layer.masks) ? layer.masks : []
  const ids = useMemo(() => [layer.id], [layer.id])
  const add = (shape: string) => {
    const m: Mask = shape === 'polygon'
      ? { shape, points: [[0, 0], [200, 0], [100, 180]], feather: 0 }
      : { shape, x: 0, y: 0, w: 200, h: 200, feather: 0 }
    setRaw(ids, 'masks', [...masks, m])
  }
  return (
    <Section title={`マスク(${masks.length})`} defaultOpen={masks.length > 0} right={
      <select className={`${inputCls} w-[92px]`} value="" title="マスクを足す(座標はレイヤーの箱の左上が原点。4 個まで)"
              onChange={e => { if (e.target.value) add(e.target.value) }}>
        <option value="">+ 足す…</option>
        <option value="rect">四角</option><option value="ellipse">楕円</option><option value="polygon">多角形</option>
      </select>
    }>
      {masks.length === 0 && <div className="text-[10px] text-zinc-600">なし</div>}
      {masks.length > 4 && <div className="text-[10px] text-amber-400">エンジンが使うのは先頭の 4 個までです</div>}
      {masks.map((m, i) => isObj(m) && (
        <div key={i} className="border border-zinc-800 rounded bg-zinc-900/60 px-1 py-1 flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-zinc-400 flex-1">マスク {i + 1}</span>
            <select className={inputCls} value={m.shape ?? 'rect'} onChange={e => setRaw(ids, `masks.${i}.shape`, e.target.value)}>
              {!['rect', 'ellipse', 'polygon'].includes(m.shape ?? 'rect') && <option value={m.shape}>{m.shape}</option>}
              <option value="rect">四角</option><option value="ellipse">楕円</option><option value="polygon">多角形</option>
            </select>
            <button className={`${iconBtnCls} hover:text-red-400`} title="外す" onClick={() => setRaw(ids, 'masks', masks.filter((_, j) => j !== i))}>✕</button>
          </div>
          {m.shape === 'polygon'
            ? <PropField ids={ids} layer={layer} path={`masks.${i}.points`} desc={MASK_POINTS} />
            : Object.entries(MASK_NUM).map(([k, d]) => <PropField key={k} ids={ids} layer={layer} path={`masks.${i}.${k}`} desc={d} />)}
          {Object.entries(MASK_COMMON).map(([k, d]) => <PropField key={k} ids={ids} layer={layer} path={`masks.${i}.${k}`} desc={d} />)}
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
        <EasingSelect value={key?.e} onChange={setEase} />
      </Row>
      <div className="flex items-center gap-2 text-[10px] text-zinc-500">
        <span>{first.path} @ {first.f}</span>
        <button className={`${btnCls} ml-auto`} onClick={del}>キーを消す</button>
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
  const timed = layer.type === 'video' || layer.type === 'comp'
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
      {timed && (
        <Row label="素材の時間" title="start = 素材の何コマ目から(コンポジションの fps で数える)/ speed = 速さ">
          <NumField prefix="▶" value={typeof layer.start === 'number' ? layer.start : 0} step={1} min={0} onEnd={end}
                    onChange={v => setRaw(ids, 'start', v, 'start')} />
          <NumField prefix="×" value={typeof layer.speed === 'number' ? layer.speed : 1} step={0.01} min={0.01} onEnd={end}
                    onChange={v => setRaw(ids, 'speed', v, 'speed')} />
        </Row>
      )}
      <Row label="モーションブラー" title="前後 1/4 コマずつを足し込む(重い)。数は足し込む回数">
        <input type="checkbox" checked={!!mb} onChange={e => setRaw(ids, 'motion_blur', e.target.checked ? true : false)} />
        {!!mb && <NumField prefix="回" className="w-[58px]" value={typeof mb === 'number' ? mb : 16} min={2} max={64} step={1} onEnd={end}
                           onChange={v => setRaw(ids, 'motion_blur', Math.round(v), 'mb')} />}
      </Row>
    </Section>
  )
})

// ── 本体 ────────────────────────────────────────────────────────────────────

export function Inspector() {
  const sel = useCompStore(s => s.sel)
  const primaryId = sel[sel.length - 1]
  const layer = useCompStore(s => (primaryId ? s.doc.layers.find(l => l.id === primaryId) : undefined))
  const schema = useCompStore(s => s.schema)
  const settings = useCompStore(s => s.settings)

  const tDescs = useMemo(() => {
    const cx = settings.width / 2, cy = settings.height / 2
    return { pos: { ...T_POS, default: [cx, cy, 0] } as ParamDesc }
  }, [settings.width, settings.height])

  if (!layer) {
    return (
      <div className="flex-1 overflow-y-auto">
        <KeyframePanel />
        <div className="p-4 text-[11px] text-zinc-500 leading-relaxed">
          レイヤーを選ぶと、ここに位置・拡大・中身・エフェクトが出ます。<br />
          左上の「+ レイヤー」で足せます。プレビューの上でドラッグして動かせます。
        </div>
      </div>
    )
  }
  const td = !!layer.three_d
  const lt = schema.layer_types[layer.type]
  const srcDescs = lt?.source ?? NO_DESCS
  const hasSource = Object.keys(srcDescs).length > 0 || (isObj(layer.source) && Object.keys(layer.source).length > 0)
  const noTransform = layer.type === 'adjustment'
  const commonDescs = schema.layer_common
  return (
    <div className="flex-1 overflow-y-auto" data-comp-inspector>
      {sel.length > 1 && <div className="px-2 py-1 text-[10px] text-amber-300 bg-amber-950/40 border-b border-zinc-800">{sel.length} レイヤーを選択中 — 値は「{layer.name ?? layer.id}」のもの。変えると全部に同じ値が入ります</div>}
      {!!layer.locked && <div className="px-2 py-1 text-[10px] text-zinc-400 bg-zinc-800/60 border-b border-zinc-800">🔒 ロック中(行の 🔒 で外せます)</div>}
      <KeyframePanel />
      <LayerBasics layer={layer} ids={sel} />
      {!noTransform && (
        <Section title="トランスフォーム">
          <PropField ids={sel} layer={layer} path="transform.position" desc={tDescs.pos} dims={td ? 3 : 2} />
          <PropField ids={sel} layer={layer} path="transform.anchor" desc={T_ANCHOR} dims={td ? 3 : 2} />
          <PropField ids={sel} layer={layer} path="transform.scale" desc={T_SCALE} dims={td ? 3 : 2} link />
          {td
            ? <PropField ids={sel} layer={layer} path="transform.rotation" desc={Array.isArray(evalFirst(layer.transform?.rotation)) || layer.transform?.rotation === undefined ? T_ROT3 : T_ROT} dims={Array.isArray(evalFirst(layer.transform?.rotation)) || layer.transform?.rotation === undefined ? 3 : undefined} rotZ={!(Array.isArray(evalFirst(layer.transform?.rotation)) || layer.transform?.rotation === undefined)} />
            : <PropField ids={sel} layer={layer} path="transform.rotation" desc={T_ROT} rotZ />}
          {td && !Array.isArray(evalFirst(layer.transform?.rotation)) && layer.transform?.rotation !== undefined && (
            <button className={`${btnCls} self-start ml-5`} title="回転を [x, y, z] の 3 軸にする"
                    onClick={() => useCompStore.getState().setRaw([layer.id], 'transform.rotation', to3Rot(layer.transform?.rotation))}>X・Y 軸の回転も使う</button>
          )}
          <PropField ids={sel} layer={layer} path="transform.opacity" desc={T_OPACITY} />
        </Section>
      )}
      {hasSource && (
        <Section title={`中身(${typeLabel(schema, layer.type)})`}>
          <SchemaFields ids={sel} layer={layer} base="source" descs={srcDescs} />
        </Section>
      )}
      {Object.keys(commonDescs).length > 0 && (
        <Section title="そのほかの機能" defaultOpen={false}>
          <SchemaFields ids={sel} layer={layer} base="" descs={commonDescs} />
        </Section>
      )}
      <EffectsPanel ids={sel} layer={layer} schema={schema} />
      <MasksPanel layer={layer} />
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
