// 🎞 プロパティ 1 つぶんの行(スキーマの記述 ParamDesc から欄を作る)。
// ◆ = 再生位置のキーフレームの切り替え。キーつきのプロパティは、値を直すと再生位置にキーが打たれる。
// スキーマ v2 の形: colors(色の列)/ fill(単色・グラデーション・模様)/ points(頂点の表)/ object(入れ子)/ list(足す・消す・並べ替え)/
// optional(入切のスイッチ。切 = 項目ごと消す)/ asset・layer・font・easing の印つきの number・text。

import { memo, useEffect, useMemo, useState } from 'react'
import type { AnimProp, Easing, Layer, ParamDesc } from './types'
import { evalProp, getPath, hasKeyAt, isAnimObj, isColorStr, isKeyed, isObj, keysOf } from './docOps'
import { useCompStore } from './store'
import { ColorField, JsonField, NumField, btnCls, inputCls, iconBtnCls } from './fields'
import { defaultFor, groupBy, loadFontOptions, objectDefaults, optionsOf, FONTS, type FontOpt } from './schema'
import { useCompListStore } from './compList'

export interface PropFieldProps {
  ids: string[]                 // 書き込む先(選択中のレイヤー)
  layer: Layer                  // 値を読むレイヤー(主に選んでいる 1 枚)
  path: string                  // レイヤーの根からの道
  desc: ParamDesc
  label?: string
  /** ベクトルの成分の数と見出し(transform 用の上書き) */
  dims?: number
  labels?: string[]
  /** 回転: 数 または [x,y,z]。2D のときは z だけを 1 つの数として出す */
  rotZ?: boolean
  /** 拡大: 縦横の比を保つ鎖を出す */
  link?: boolean
}

const NUMERIC = new Set(['number', 'angle', 'percent', 'int', 'float'])
const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v)
const numArr = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum)
const swatchCls = 'w-7 h-5 p-0 bg-transparent border border-zinc-700 rounded cursor-pointer flex-shrink-0'

export function EasingSelect({ value, onChange }: { value: Easing | undefined; onChange: (e: Easing) => void }) {
  const easings = useCompStore(s => s.schema.easings)
  const isBez = Array.isArray(value)
  const cur = isBez ? '__bezier' : (value ?? 'linear')
  const known = easings.some(o => o.value === cur)
  return (
    <span className="flex items-center gap-1 flex-wrap">
      <select className={`${inputCls} max-w-[150px]`} value={cur}
              onChange={e => onChange(e.target.value === '__bezier' ? [0.25, 0.1, 0.25, 1] : e.target.value)}>
        {easings.map(o => <option key={o.value} value={o.value}>{o.label ?? o.value}({o.value})</option>)}
        {!known && !isBez && <option value={cur as string}>{cur as string}</option>}
        <option value="__bezier">ベジェ(自分で決める)</option>
      </select>
      {isBez && (
        <span className="flex items-center gap-0.5">
          {[0, 1, 2, 3].map(i => (
            <NumField key={i} className="w-[44px]" step={0.01} value={Number((value as number[])[i]) || 0}
                      min={i % 2 === 0 ? 0 : undefined} max={i % 2 === 0 ? 1 : undefined}
                      title={['x1', 'y1', 'x2', 'y2'][i] + '(CSS の cubic-bezier と同じ)'}
                      onChange={v => { const a = [...(value as number[])] as [number, number, number, number]; a[i] = v; onChange(a) }} />
          ))}
        </span>
      )}
    </span>
  )
}

function FontSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [fonts, setFonts] = useState<FontOpt[]>(() => FONTS.map(f => ({ family: f, label: f })))
  useEffect(() => { let on = true; void loadFontOptions().then(f => { if (on) setFonts(f) }); return () => { on = false } }, [])
  const known = fonts.some(f => f.family === value)
  return (
    <select className={`${inputCls} max-w-[190px]`} value={value} onChange={e => onChange(e.target.value)} data-font-select>
      {!known && <option value={value}>{value || '(既定)'}</option>}
      {fonts.map(f => <option key={f.family} value={f.family}>{f.label}</option>)}
    </select>
  )
}

/** レイヤーを選ぶ(親・マット・切り抜き・注視)。開くまで選択肢を作らない */
function LayerSelect({ value, selfId, onChange, emptyLabel = '(なし)' }: { value: string | null; selfId: string; onChange: (v: string | null) => void; emptyLabel?: string }) {
  const [armed, setArmed] = useState(false)
  const layers = useCompStore(s => (armed ? s.doc.layers : null))
  const curName = useCompStore(s => (value ? (s.doc.layers.find(l => l.id === value)?.name ?? null) : null))
  return (
    <select className={`${inputCls} max-w-[190px]`} value={value ?? ''} onPointerEnter={() => setArmed(true)} onFocus={() => setArmed(true)}
            onChange={e => onChange(e.target.value || null)} data-layer-select>
      {layers
        ? (<>
            <option value="">{emptyLabel}</option>
            {value && !layers.some(l => l.id === value) && <option value={value}>{value}(見つからない)</option>}
            {layers.filter(l => l.id !== selfId).map(l => <option key={l.id} value={l.id}>{l.name || l.id}</option>)}
          </>)
        : <option value={value ?? ''}>{value ? (curName || value) : emptyLabel}</option>}
    </select>
  )
}

/** ループ・揺れ(wiggle)の小さな設定 */
function AnimExtras({ ids, path, raw, value }: { ids: string[]; path: string; raw: unknown; value: unknown }) {
  const setRaw = useCompStore(s => s.setRaw)
  const end = useCompStore(s => s.endCoalesce)
  const p: AnimProp = isAnimObj(raw) ? raw : {}
  const w = isObj(p.wiggle) ? p.wiggle : null
  const keyed = isKeyed(raw)
  const write = (next: AnimProp | null) => {
    // 揺れもキーも無くなったら、ただの定数に戻す
    if (!next || (!Array.isArray(next.k) && !next.wiggle)) { setRaw(ids, path, next && 'v' in next ? next.v : value, `x:${path}`); return }
    setRaw(ids, path, next, `x:${path}`)
  }
  const base = (): AnimProp => (isAnimObj(raw) ? { ...raw } : { v: raw === undefined ? value : raw })
  const setW = (patch: Record<string, unknown> | null) => {
    const n = base()
    if (patch === null) delete n.wiggle
    else n.wiggle = { freq: 2, amp: 10, seed: 1, ...(w ?? {}), ...patch }
    write(n)
  }
  const amp = w?.amp
  return (
    <div className="ml-[90px] mb-1 pl-2 border-l border-zinc-700 flex flex-col gap-1 text-[10px] text-zinc-400" data-anim-extras={path}>
      <span className="flex items-center gap-1">
        ループ
        <select className={inputCls} disabled={!keyed} value={p.loop ?? ''} data-loop-select
                title={keyed ? '最後のキーのあと、キーの区間をくり返す' : 'キーフレームがあるときに使えます'}
                onChange={e => { const n = base(); if (e.target.value) n.loop = e.target.value as 'cycle' | 'pingpong'; else delete n.loop; write(n) }}>
          <option value="">なし</option>
          <option value="cycle">くり返し(cycle)</option>
          <option value="pingpong">行って戻る(pingpong)</option>
        </select>
      </span>
      <span className="flex items-center gap-1 flex-wrap">
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!w} data-wiggle-toggle onChange={e => setW(e.target.checked ? {} : null)} />揺れ(wiggle)</label>
        {w && (<>
          <NumField prefix="Hz" className="w-[64px]" step={0.1} min={0} value={Number(w.freq ?? 1)} onChange={v => setW({ freq: v })} onEnd={end} title="1 秒に揺れる回数" />
          <NumField prefix="±" className="w-[64px]" step={1} value={Number(Array.isArray(amp) ? amp[0] : amp ?? 0)} onChange={v => setW({ amp: v })} onEnd={end}
                    title={Array.isArray(amp) ? '揺れの大きさ(成分ごとの値は JSON タブで)' : '揺れの大きさ'} />
          <NumField prefix="#" className="w-[52px]" step={1} value={Number(w.seed ?? 1)} onChange={v => setW({ seed: Math.round(v) })} onEnd={end} title="乱数の種(同じ種なら同じ揺れ)" />
        </>)}
      </span>
    </div>
  )
}

function CompSelect({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  const list = useCompListStore(s => s.list)
  const selfId = useCompStore(s => s.comp?.id)
  return (
    <span className="flex items-center gap-1">
      <select className={`${inputCls} max-w-[150px]`} value={value ?? ''} onChange={e => onChange(Number(e.target.value))}>
        {value != null && !list.some(c => c.id === value) && <option value={value}>#{value}</option>}
        {value == null && <option value="">(なし)</option>}
        {list.filter(c => c.id !== selfId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {value != null && <button className={iconBtnCls} title="このコンポジションを開く"
        onClick={() => window.dispatchEvent(new CustomEvent('kychapogas:comp-open-child', { detail: { compId: value } }))}>開く ↗</button>}
    </span>
  )
}

// ── v2 の形ごとの欄 ──────────────────────────────────────────────────────────

/** 色の列(1〜max 個)。足す・消す */
function ColorsField({ value, onChange, onEnd, min = 1, max = 4 }: { value: string[]; onChange: (v: string[]) => void; onEnd: () => void; min?: number; max?: number }) {
  return (
    <span className="flex items-center gap-1 flex-wrap" data-colors-field>
      {value.map((c, i) => (
        <span key={i} className="relative group/c flex-shrink-0">
          <input type="color" value={String(c).slice(0, 7)} className={swatchCls} title={c}
                 onChange={e => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} onBlur={onEnd} />
          {value.length > min && (
            <button className="absolute -top-1.5 -right-1.5 w-3 h-3 leading-[10px] text-[9px] rounded-full bg-zinc-700 text-zinc-200 hover:bg-red-600 hidden group-hover/c:block"
                    title="この色を消す" onClick={() => { onChange(value.filter((_, j) => j !== i)); onEnd() }}>×</button>
          )}
        </span>
      ))}
      {value.length < max && <button className={iconBtnCls} title="色を足す" data-colors-add
                                     onClick={() => { onChange([...value, value[value.length - 1] ?? '#ffffff']); onEnd() }}>+</button>}
    </span>
  )
}

type Pt = unknown
const ptXY = (p: Pt): [number, number] => (Array.isArray(p) ? [Number(p[0]) || 0, Number(p[1]) || 0] : isObj(p) ? [Number(p.x) || 0, Number(p.y) || 0] : [0, 0])
const ptHandles = (p: Pt): number[] | null => {
  if (Array.isArray(p)) return p.length >= 6 ? [2, 3, 4, 5].map(i => Number(p[i]) || 0) : null
  if (isObj(p) && (Array.isArray(p.in) || Array.isArray(p.out))) {
    const a = Array.isArray(p.in) ? p.in : [0, 0], b = Array.isArray(p.out) ? p.out : [0, 0]
    return [Number(a[0]) || 0, Number(a[1]) || 0, Number(b[0]) || 0, Number(b[1]) || 0]
  }
  return null
}
/** 元の書き方([x,y] / [x,y,inx,iny,outx,outy] / {x,y,in,out})を保って点を書き換える */
const ptWith = (p: Pt, xy: [number, number], h: number[] | null): Pt => {
  if (isObj(p)) return { ...p, x: xy[0], y: xy[1], ...(h ? { in: [h[0], h[1]], out: [h[2], h[3]] } : {}) }
  return h ? [xy[0], xy[1], ...h] : [xy[0], xy[1]]
}

/** 頂点の表(線・パス・多角形マスク)。ハンドル = ベジェの制御点(点からのずれ) */
function PointsField({ value, onChange, onEnd }: { value: Pt[]; onChange: (v: Pt[]) => void; onEnd: () => void }) {
  const anyH = value.some(p => ptHandles(p))
  const [showH, setShowH] = useState(anyH)
  const set = (i: number, p: Pt) => onChange(value.map((x, j) => (j === i ? p : x)))
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= value.length) return; const a = [...value]; [a[i], a[j]] = [a[j], a[i]]; onChange(a); onEnd() }
  return (
    <div className="flex flex-col gap-0.5" data-points-field>
      {value.map((p, i) => {
        const xy = ptXY(p), h = ptHandles(p)
        return (
          <div key={i} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <span className="w-4 text-[9px] text-zinc-500 text-right flex-shrink-0">{i + 1}</span>
              <NumField prefix="X" className="w-[70px]" value={xy[0]} onChange={v => set(i, ptWith(p, [v, xy[1]], h))} onEnd={onEnd} />
              <NumField prefix="Y" className="w-[70px]" value={xy[1]} onChange={v => set(i, ptWith(p, [xy[0], v], h))} onEnd={onEnd} />
              <button className={iconBtnCls} disabled={i === 0} title="前へ" onClick={() => move(i, -1)}>↑</button>
              <button className={iconBtnCls} disabled={i === value.length - 1} title="後ろへ" onClick={() => move(i, 1)}>↓</button>
              <button className={`${iconBtnCls} hover:text-red-400`} disabled={value.length <= 2} title="この点を消す" data-point-del
                      onClick={() => { onChange(value.filter((_, j) => j !== i)); onEnd() }}>✕</button>
            </div>
            {showH && (
              <div className="flex items-center gap-1 pl-5">
                {['入X', '入Y', '出X', '出Y'].map((lab, k) => (
                  <NumField key={k} prefix={k % 2 === 0 ? (k === 0 ? '⤶' : '⤷') : ''} className="w-[58px]" value={h ? h[k] : 0} title={`${lab}(ベジェのハンドル。点からのずれ)`}
                            onChange={v => { const nh = h ? [...h] : [0, 0, 0, 0]; nh[k] = v; set(i, ptWith(p, xy, nh)) }} onEnd={onEnd} />
                ))}
              </div>
            )}
          </div>
        )
      })}
      <div className="flex items-center gap-2 pl-5">
        <button className={btnCls} data-point-add onClick={() => {
          const last = value[value.length - 1], prev = value[value.length - 2]
          const a = ptXY(last), b = prev ? ptXY(prev) : [a[0] - 100, a[1]]
          onChange([...value, ptWith(last ?? [0, 0], [a[0] + (a[0] - b[0] || 100), a[1] + (a[1] - b[1])], ptHandles(last) ? [0, 0, 0, 0] : null)]); onEnd()
        }}>+ 点を足す</button>
        <label className="flex items-center gap-1 text-[10px] text-zinc-400"><input type="checkbox" checked={showH} onChange={e => setShowH(e.target.checked)} />ハンドル</label>
        <span className="text-[9px] text-zinc-600">{value.length} 点</span>
      </div>
    </div>
  )
}

const FILL_MODES: [string, string][] = [['none', 'なし'], ['color', '単色'], ['gradient', 'グラデーション'], ['pattern', '模様']]
const fillMode = (v: unknown): string => (v == null || v === false || v === 'none' ? 'none' : isObj(v) && v.pattern ? 'pattern' : isObj(v) && v.gradient ? 'gradient' : 'color')

/** グラデーション {type, angle, radius, stops:[[位置 0〜1, 色]…]} */
function GradientEditor({ ids, path, g }: { ids: string[]; path: string; g: Record<string, unknown> }) {
  const setRaw = useCompStore(s => s.setRaw)
  const end = useCompStore(s => s.endCoalesce)
  const stops: [number, string][] = (Array.isArray(g.stops) ? g.stops : [[0, '#ffffff'], [1, '#000000']])
    .map(s => (Array.isArray(s) ? [Number(s[0]) || 0, String(s[1] ?? '#ffffff')] : [0, '#ffffff']) as [number, string])
  const put = (patch: Record<string, unknown>) => setRaw(ids, path, { gradient: { ...g, ...patch } }, `g:${path}`)
  const radial = g.type === 'radial'
  const custom = Array.isArray(g.from) || Array.isArray(g.to)
  return (
    <div className="flex flex-col gap-1" data-gradient-editor>
      <div className="flex items-center gap-1 flex-wrap">
        <select className={inputCls} value={radial ? 'radial' : 'linear'} onChange={e => put({ type: e.target.value })}>
          <option value="linear">線</option><option value="radial">円</option>
        </select>
        {radial
          ? <NumField prefix="r" className="w-[78px]" min={0} value={isNum(g.radius) ? g.radius : 0} title="半径(0 = レイヤーの大きさに合わせる)" onEnd={end}
                      onChange={v => { const n: Record<string, unknown> = { ...g }; if (v > 0) n.radius = v; else delete n.radius; setRaw(ids, path, { gradient: n }, `g:${path}`) }} />
          : <NumField prefix="∠" className="w-[78px]" value={isNum(g.angle) ? g.angle : 180} title="角度(0 = 下から上へ色が進む / 180 = 上から下 / 90 = 左から右)" onChange={v => put({ angle: v })} onEnd={end} />}
        {custom && <span className="text-[9px] text-zinc-500" title="from / to(始点・終点の座標)が書かれています。JSON タブで直せます">from/to あり</span>}
      </div>
      {stops.map((s, i) => (
        <div key={i} className="flex items-center gap-1">
          <NumField prefix="@" className="w-[64px]" min={0} max={1} step={0.01} value={s[0]} title="位置(0 = 始まり 〜 1 = 終わり)" onEnd={end}
                    onChange={v => put({ stops: stops.map((x, j) => (j === i ? [v, x[1]] : x)) })} />
          <ColorField value={s[1]} onChange={c => put({ stops: stops.map((x, j) => (j === i ? [x[0], c ?? '#ffffff'] : x)) })} onEnd={end} />
          <button className={`${iconBtnCls} hover:text-red-400`} disabled={stops.length <= 2} title="この色を消す" onClick={() => put({ stops: stops.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <button className={`${btnCls} self-start`} data-gradient-add onClick={() => put({ stops: [...stops, [1, stops[stops.length - 1]?.[1] ?? '#000000']] })}>+ 色を足す</button>
    </div>
  )
}

/** 効かせる範囲(group・camera の scope): 下すべて / 下の N 層 / レイヤーを指定 */
function ScopeField({ ids, layer, path, value }: { ids: string[]; layer: Layer; path: string; value: unknown }) {
  const setRaw = useCompStore(s => s.setRaw)
  const end = useCompStore(s => s.endCoalesce)
  const names = useCompStore(s => (Array.isArray(value) ? value.map(id => s.doc.layers.find(l => l.id === id)?.name ?? null).join('\u0001') : ''))
  const mode = Array.isArray(value) ? 'ids' : isNum(value) && value > 0 ? 'count' : 'all'
  const nameArr = names.split('\u0001')
  const others = ids.filter(i => i !== layer.id)
  return (
    <div className="flex flex-col gap-1 min-w-0 flex-1" data-scope-field>
      <div className="flex items-center gap-1 flex-wrap">
        <select className={inputCls} value={mode} onChange={e => setRaw([layer.id], path, e.target.value === 'ids' ? [] : e.target.value === 'count' ? 1 : 0)}>
          <option value="all">下のレイヤーすべて</option><option value="count">下の N 層</option><option value="ids">レイヤーを指定</option>
        </select>
        {mode === 'count' && <NumField prefix="N" value={value as number} min={1} max={1000} step={1} onEnd={end} onChange={v => setRaw([layer.id], path, Math.max(1, Math.round(v)), 'scope')} />}
        {mode === 'ids' && <span className="text-[10px] text-zinc-500">{(value as unknown[]).length} 枚</span>}
      </div>
      {mode === 'ids' && (<>
        <div className="flex flex-wrap gap-1 max-h-[88px] overflow-y-auto">
          {(value as unknown[]).map((id, i) => (
            <span key={String(id)} className="text-[10px] px-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 flex items-center gap-1 max-w-[150px]">
              <button className="truncate hover:text-white" title={`${String(id)}(押すとこのレイヤーを選ぶ)`}
                      onClick={() => { const s = useCompStore.getState(); s.setSel([String(id)]); s.revealLayer(String(id)) }}>{nameArr[i] || String(id)}</button>
              <button className="text-zinc-500 hover:text-red-400" title="範囲から外す" onClick={() => setRaw([layer.id], path, (value as unknown[]).filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <LayerSelect value={null} selfId={layer.id} emptyLabel="+ レイヤーを足す…" onChange={v => { if (v && !(value as unknown[]).includes(v)) setRaw([layer.id], path, [...(value as unknown[]), v]) }} />
          {others.length > 0 && <button className={btnCls} title="いっしょに選んでいるレイヤーを、このレイヤーの範囲にする" onClick={() => setRaw([layer.id], path, others)}>選択中の {others.length} 枚を範囲に</button>}
        </div>
      </>)}
    </div>
  )
}

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

const NO_SKIP = () => false

/**
 * スキーマの記述(点つきの名前 = 入れ子)と、記述に無い実際の項目を合わせて行にする。
 * base が空(レイヤーの根)のとき、1 つの入れ物(transition_in・repeater など)だけでできた組には入切のスイッチを出す。
 */
export function FieldList({ ids, layer, base, descs, skip = NO_SKIP, extras = true, switches = false }: {
  ids: string[]; layer: Layer; base: string; descs: Record<string, ParamDesc>; skip?: (name: string) => boolean; extras?: boolean; switches?: boolean
}) {
  const schema = useCompStore(s => s.schema)
  const setRaw = useCompStore(s => s.setRaw)
  const unsetProp = useCompStore(s => s.unsetProp)
  const container = base ? getPath(layer, base) : layer
  const rows = useMemo(() => {
    const entries = Object.entries(descs).filter(([k]) => !skip(k))
    const covered = new Set(Object.keys(descs).map(k => k.split('.')[0]))
    const extra: [string, ParamDesc][] = []
    if (extras && base && isObj(container)) {
      for (const [k, v] of Object.entries(container)) {
        if (covered.has(k) || skip(k)) continue
        extra.push([k, { ...guessDesc(v), label: k, group: 'その他' }])
      }
    }
    return groupBy([...entries, ...extra], d => d.group)
    // container の中身(項目の有無)が変わったら作り直す
  }, [descs, container, base, skip, extras])
  return (
    <>
      {rows.map(([g, items]) => {
        // 1 つの入れ物だけでできた組(登場・退場・複製)
        const first = items[0][0].split('.')[0]
        const box = switches && g && items.every(([k]) => k.includes('.') && k.split('.')[0] === first) ? first : null
        const boxPath = box ? (base ? `${base}.${box}` : box) : ''
        const on = box ? isObj(getPath(layer, boxPath)) : true
        return (
          <div key={g || '_'} className="flex flex-col gap-1" data-field-group={g || undefined}>
            {g && (
              <div className="text-[9px] text-zinc-500 mt-1 border-b border-zinc-800 flex items-center gap-1">
                {box && <input type="checkbox" checked={on} data-box-switch={box} title={on ? '切にすると、この機能の設定ごと消します' : '入にする'}
                               onChange={e => (e.target.checked ? setRaw(ids, boxPath, objectDefaults(schema, Object.fromEntries(items))[box] ?? {}) : unsetProp(ids, boxPath))} />}
                {g}{box && !on && <span className="text-zinc-600">(切)</span>}
              </div>
            )}
            {on && items.map(([name, d]) => (
              <PropField key={name} ids={ids} layer={layer} path={base ? `${base}.${name}` : name} desc={d} />
            ))}
          </div>
        )
      })}
    </>
  )
}

/** 入れ子・表の見出しつきの組(object / list / points / fill の中身) */
function Block({ path, title, optional, onOff, right, children, hint }: {
  path: string; title: string; optional?: boolean; onOff?: () => void; right?: React.ReactNode; children: React.ReactNode; hint?: string
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="flex flex-col gap-1" data-prop-path={path}>
      <div className="flex items-center gap-1 min-h-[20px]">
        <button className="w-4 text-[10px] text-zinc-500 hover:text-white flex-shrink-0" onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'}</button>
        {optional && <input type="checkbox" checked data-opt-switch title="切にすると、この項目を消します(機能オフ)" onChange={onOff} />}
        <span className="text-[10px] text-zinc-300 truncate flex-1" title={`${title}(${path})${hint ? '\n' + hint : ''}`}>{title}</span>
        {right}
      </div>
      {open && <div className="ml-2 pl-2 border-l border-zinc-700 flex flex-col gap-1">{children}</div>}
    </div>
  )
}

export const PropField = memo(function PropField({ ids, layer, path, desc, label, dims, labels, rotZ, link }: PropFieldProps) {
  const raw = getPath(layer, path)
  const type = desc.type
  const composite = type === 'object' || type === 'list'
  const anim = !composite && isAnimObj(raw)
  const keyed = !composite && isKeyed(raw)
  // キーつきのときだけ再生位置を購読する(再生中に描き直すのはキーのある行だけ)
  const frame = useCompStore(s => (keyed ? s.frame : -1))
  const schema = useCompStore(s => s.schema)
  const setProp = useCompStore(s => s.setProp)
  const setRaw = useCompStore(s => s.setRaw)
  const unsetProp = useCompStore(s => s.unsetProp)
  const addToProp = useCompStore(s => s.addToProp)
  const toggleKeyAt = useCompStore(s => s.toggleKeyAt)
  const clearKeys = useCompStore(s => s.clearKeys)
  const setFrame = useCompStore(s => s.setFrame)
  const end = useCompStore(s => s.endCoalesce)
  const [extras, setExtras] = useState(false)
  const [linked, setLinked] = useState(true)

  const dflt = desc.default
  const value: unknown = raw === undefined ? dflt : anim ? evalProp(raw, keyed ? frame : 0, dflt) : raw
  const ck = `p:${path}`
  const write = (v: unknown) => setProp(ids, path, v, ck)
  /** つまみのドラッグ・↑↓ は、複数選択のとき差分として配る(入力した値は全部に同じ値) */
  const change = (next: unknown, how: 'scrub' | 'type' | undefined, delta: number | number[]) => {
    if (how === 'scrub' && ids.length > 1) addToProp(ids, path, delta, dflt, ck)
    else write(next)
  }
  const locked = !!layer.locked
  const title = label ?? desc.label ?? path.split('.').pop() ?? path
  // default が null の数・ベクトル(runs の size、マスクの w・h など)は「書かなければ無し」。optional と同じ入切で出す
  const optional = desc.optional === true
    || (desc.default === null && !desc.asset && (NUMERIC.has(type) || type === 'vec2' || type === 'vec3') && !path.startsWith('transform.'))
  const off = optional && (raw === undefined || raw === null)
  const turnOff = () => unsetProp(ids, path === 'matte.layer' ? 'matte' : path)
  const labelCls = 'text-[10px] w-[84px] flex-shrink-0 leading-[11px] max-h-[22px] overflow-hidden break-all self-center'

  // ── optional で「切」: スイッチだけの行 ──
  if (off) {
    return (
      <div className="flex items-center gap-1 min-h-[22px]" data-prop-path={path} data-prop-off>
        <span className="w-4 flex-shrink-0" />
        <input type="checkbox" checked={false} disabled={locked} data-opt-switch title="入にする(この項目を書く)"
               onChange={() => {
                 // 幅・高さ(省略 = 画面の大きさ)は、入にしたとき画面の大きさから始める
                 const leaf = path.split('.').pop(), cs = useCompStore.getState().settings
                 setRaw(ids, path, desc.default == null && leaf === 'width' ? cs.width : desc.default == null && leaf === 'height' ? cs.height : defaultFor(schema, desc))
               }} />
        <span className={`${labelCls} text-zinc-500`} title={`${title}(${path})— 切(書かれていない)`}>{title}</span>
        <span className="text-[10px] text-zinc-700">—</span>
      </div>
    )
  }

  // ── 入れ子(object) ──
  if (type === 'object' && isObj(desc.fields) && (raw === undefined || isObj(raw))) {
    return (
      <Block path={path} title={title} optional={optional} onOff={turnOff}>
        <FieldList ids={ids} layer={layer} base={path} descs={desc.fields} />
      </Block>
    )
  }
  // ── 列(list) ──
  if (type === 'list' && isObj(desc.item) && (raw == null || Array.isArray(raw))) {
    const items: unknown[] = Array.isArray(raw) ? raw : []
    const put = (next: unknown[]) => setRaw(ids, path, next)
    const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= items.length) return; const a = [...items]; [a[i], a[j]] = [a[j], a[i]]; put(a) }
    return (
      <Block path={path} title={`${title}(${items.length})`} optional={optional} onOff={turnOff}
             right={<button className={iconBtnCls} data-list-add title="1 件足す" onClick={() => put([...items, objectDefaults(schema, desc.item!)])}>+ 足す</button>}>
        {items.length === 0 && <div className="text-[10px] text-zinc-600">なし(「+ 足す」で 1 件作る)</div>}
        {items.map((_, i) => (
          <div key={i} className="border border-zinc-800 rounded bg-zinc-900/60 px-1 py-1 flex flex-col gap-1" data-list-item={i}>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-zinc-500 flex-1">{i + 1}</span>
              <button className={iconBtnCls} disabled={i === 0} title="上へ" onClick={() => move(i, -1)}>↑</button>
              <button className={iconBtnCls} disabled={i === items.length - 1} title="下へ" onClick={() => move(i, 1)}>↓</button>
              <button className={`${iconBtnCls} hover:text-red-400`} title="消す" data-list-del onClick={() => put(items.filter((__, j) => j !== i))}>✕</button>
            </div>
            <FieldList ids={ids} layer={layer} base={`${path}.${i}`} descs={desc.item!} />
          </div>
        ))}
      </Block>
    )
  }
  // ── 頂点の表(points) ──
  if (type === 'points' && Array.isArray(value)) {
    return (
      <Block path={path} title={title} optional={optional} onOff={turnOff} hint="原点 = レイヤーの中心(マスクは箱の左上)">
        <PointsField value={value} onChange={write} onEnd={end} />
      </Block>
    )
  }
  // ── 塗り(fill): なし / 単色 / グラデーション / 模様 ──
  if (type === 'fill') {
    const mode = anim ? 'color' : fillMode(raw === undefined ? dflt : raw)
    const accepts = Array.isArray(desc.accepts) ? desc.accepts : ['color', 'gradient', 'pattern', 'none']
    const patDescs = schema.layer_types.pattern?.source
    const setMode = (m: string) => {
      if (m === mode) return
      const firstColor = isObj(raw) && isObj(raw.gradient) && Array.isArray(raw.gradient.stops) && Array.isArray(raw.gradient.stops[0]) ? raw.gradient.stops[0][1]
        : isObj(raw) && isObj(raw.pattern) && Array.isArray(raw.pattern.colors) ? raw.pattern.colors[0] : null
      const c0 = isColorStr(value) ? value : isColorStr(firstColor) ? firstColor : isColorStr(dflt) ? dflt : '#ffffff'
      setRaw(ids, path, m === 'none' ? null : m === 'color' ? c0
        : m === 'gradient' ? { gradient: { type: 'linear', angle: 180, stops: [[0, c0], [1, '#000000']] } }
        : { pattern: { kind: 'stripes', colors: [c0, c0.toLowerCase().startsWith('#fff') ? '#e65163' : '#ffffff'], size: 40, angle: 45 } })
    }
    const modeSel = (
      <select className={inputCls} value={mode} disabled={locked} data-fill-mode onChange={e => setMode(e.target.value)}>
        {FILL_MODES.filter(([m]) => accepts.includes(m) || m === mode).map(([m, l]) => <option key={m} value={m}>{l}</option>)}
      </select>
    )
    if (mode === 'gradient' || mode === 'pattern') {
      const inner = (raw as Record<string, unknown>)[mode]
      return (
        <Block path={path} title={title} optional={optional} onOff={turnOff} right={modeSel}>
          {mode === 'gradient'
            ? <GradientEditor ids={ids} path={path} g={isObj(inner) ? inner : {}} />
            : patDescs
              ? <FieldList ids={ids} layer={layer} base={`${path}.pattern`} descs={patDescs} skip={skipPatSize} />
              : <JsonField value={raw} onChange={v => setRaw(ids, path, v)} />}
        </Block>
      )
    }
    // なし・単色は下の 1 行の形で出す(単色はキーフレーム可)
    const atKeyF = keyed && hasKeyAt(raw, frame)
    return (
      <div className="flex items-start gap-1 min-h-[22px]" data-prop-path={path}>
        {mode === 'color' && desc.animatable !== false ? (
          <button className={`w-4 h-[22px] text-[11px] leading-none flex-shrink-0 ${atKeyF ? 'text-amber-300' : keyed ? 'text-amber-600' : 'text-zinc-600 hover:text-zinc-300'}`} disabled={locked}
                  title="キーフレーム(Shift + クリックですべて消す)" onClick={e => (e.shiftKey ? clearKeys(ids, path, dflt) : toggleKeyAt(ids, path, value ?? '#ffffff'))}>{atKeyF ? '◆' : '◇'}</button>
        ) : <span className="w-4 flex-shrink-0" />}
        {optional && <input type="checkbox" checked data-opt-switch title="切にすると、この項目を消します" onChange={turnOff} />}
        <span className={`${labelCls} text-zinc-400`} title={`${title}(${path})`}>{title}</span>
        <div className="flex items-center gap-1 flex-wrap min-w-0 flex-1">
          {modeSel}
          {mode === 'color' && <ColorField value={value} onChange={write} onEnd={end} />}
        </div>
      </div>
    )
  }

  const animatable = desc.animatable === true || anim
  let body: React.ReactNode
  let fallback = false
  const assetKind = typeof desc.asset === 'string' ? desc.asset : type === 'asset' ? String(desc.kind ?? layer.type) : type === 'comp' ? 'comp' : null

  if (rotZ) {
    // 回転: 2D は z だけ
    const zi = Array.isArray(value) ? (value.length >= 3 ? 2 : value.length - 1) : -1
    const z = isNum(value) ? value : Array.isArray(value) && isNum(value[zi]) ? (value[zi] as number) : 0
    body = <NumField value={z} step={desc.step ?? 1} disabled={locked} onEnd={end}
                     onChange={(v, how) => change(Array.isArray(value) ? value.map((x, i) => (i === zi ? v : x)) : v, how, v - z)} />
  } else if (path === 'scope' || path.endsWith('.scope')) {
    body = <ScopeField ids={ids} layer={layer} path={path} value={value} />
  } else if (assetKind === 'comp' && (value == null || isNum(value))) {
    body = <CompSelect value={value as number | null} onChange={v => setRaw(ids, path, v)} />
  } else if (assetKind && (value == null || isNum(value))) {
    body = (<>
      <span className="text-[11px] text-zinc-300 font-mono" data-asset-id={value == null ? '' : String(value)}>{value == null ? '(なし)' : `#${value}`}</span>
      {isNum(value) && <img src={`/api/assets/${value}/thumbnail`} alt="" className="h-6 rounded border border-zinc-700" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />}
      <button className={btnCls} title="素材を選び直す(差し替える)" data-asset-pick
              onClick={() => window.dispatchEvent(new CustomEvent('kychapogas:comp-pick-asset', { detail: { ids, path, kind: assetKind } }))}>{value == null ? '選ぶ…' : '差し替え…'}</button>
    </>)
  } else if (NUMERIC.has(type) && (isNum(value) || value == null)) {
    const cur = isNum(value) ? value : 0
    body = <NumField value={cur} step={desc.step ?? 1} min={desc.min} max={desc.max} disabled={locked}
                     onChange={(v, how) => change(v, how, v - cur)} onEnd={end} />
  } else if ((type === 'vec2' || type === 'vec3' || dims) && (numArr(value) || isNum(value) || value == null)) {
    const n = dims ?? (type === 'vec3' ? 3 : 2)
    const dv = numArr(dflt) ? dflt : []
    const arr: number[] = numArr(value) ? value : isNum(value) ? new Array(n).fill(value) : dv
    const get = (i: number) => (isNum(arr[i]) ? arr[i] : isNum(dv[i]) ? dv[i] : 0)
    const lab = labels ?? ['X', 'Y', 'Z']
    const setI = (i: number, v: number, how?: 'scrub' | 'type') => {
      // 元の配列の長さは保つ(足りなければ既定値で伸ばす)。見えていない成分は触らない
      const len = Math.max(arr.length, i + 1, numArr(value) ? 0 : n)
      const out = Array.from({ length: len }, (_, j) => get(j))
      if (link && linked && i < 2 && get(i) !== 0) {
        const r = v / get(i)
        for (let j = 0; j < Math.min(len, n); j++) if (j !== i) out[j] = Math.round(get(j) * r * 1000) / 1000
      }
      out[i] = v
      change(out, how, out.map((x, j) => x - get(j)))
    }
    body = (<>
      {Array.from({ length: n }, (_, i) => (
        <NumField key={i} prefix={lab[i]} value={get(i)} step={desc.step ?? 1} min={desc.min} max={desc.max} disabled={locked}
                  onChange={(v, how) => setI(i, v, how)} onEnd={end} />
      ))}
      {link && <button className={`${iconBtnCls} ${linked ? 'text-purple-300' : ''}`} title="縦横の比を保つ" onClick={() => setLinked(l => !l)}>{linked ? '🔗' : '⛓️‍💥'}</button>}
    </>)
  } else if (type === 'color' && (value == null || isColorStr(value) || numArr(value))) {
    body = <ColorField value={value} nullable={!optional && (desc.nullable === true || dflt === null)} onChange={write} onEnd={end} />
  } else if (type === 'bool') {
    body = <input type="checkbox" checked={!!value} disabled={locked} onChange={e => setRaw(ids, path, e.target.checked)} />
  } else if (type === 'select' && (value == null || typeof value === 'string' || typeof value === 'number')) {
    const opts = optionsOf(schema, desc)
    const asNum = desc.numeric === true || typeof dflt === 'number' || (typeof value === 'number')
    const cur = value == null ? '' : String(value)
    const key = (v: string | number | null) => (v == null ? '' : String(v))
    body = (
      <select className={`${inputCls} max-w-[190px]`} value={cur} disabled={locked}
              onChange={e => {
                const v = e.target.value
                if (v === '' && opts.some(o => o.value == null)) { if (optional) turnOff(); else setRaw(ids, path, null); return }
                setRaw(ids, path, asNum && isFinite(Number(v)) ? Number(v) : v)
              }}>
        {!opts.some(o => key(o.value) === cur) && <option value={cur}>{cur || '—'}</option>}
        {opts.map(o => <option key={key(o.value)} value={key(o.value)}>{o.label}</option>)}
      </select>
    )
  } else if (type === 'text' && desc.layer === true && (value == null || typeof value === 'string')) {
    body = <LayerSelect value={(value as string | null) ?? null} selfId={layer.id}
                        onChange={v => (path === 'matte.layer'
                          ? setRaw(ids, 'matte', v ? { ...(isObj(layer.matte) ? layer.matte : {}), layer: v, mode: layer.matte?.mode ?? 'alpha' } : null)
                          : setRaw(ids, path, v))} />
  } else if ((type === 'font' || (type === 'text' && desc.font === true)) && (value == null || typeof value === 'string')) {
    body = <FontSelect value={(value as string) ?? ''} onChange={v => setRaw(ids, path, v)} />
  } else if ((type === 'easing' || (type === 'text' && (desc.easing === true || path.endsWith('.e')))) && (value == null || typeof value === 'string' || numArr(value))) {
    body = <EasingSelect value={value as Easing | undefined} onChange={e => setRaw(ids, path, e, ck)} />
  } else if (type === 'text' && (value == null || typeof value === 'string')) {
    const multi = path.endsWith('.text') || desc.multiline === true
    body = multi
      ? <textarea rows={3} className={`${inputCls} w-full resize-y`} value={(value as string) ?? ''} disabled={locked}
                  onChange={e => write(e.target.value)} onBlur={end} />
      : <input type="text" className={`${inputCls} w-full`} value={(value as string) ?? ''} disabled={locked}
               onChange={e => write(e.target.value)} onBlur={end} />
  } else if (type === 'colors' && Array.isArray(value) && value.every(isColorStr)) {
    body = <ColorsField value={value as string[]} onChange={write} onEnd={end} />
  } else if (type === 'colors' && (value == null || isColorStr(value))) {
    body = <ColorField value={value} onChange={write} onEnd={end} />
  } else {
    // 知らない型・形の合わない値(文字列のキー、{pow:2} のイージングなど)は JSON で
    fallback = true
    body = <JsonField value={raw === undefined ? dflt : raw} onChange={v => (v === undefined && optional ? turnOff() : setRaw(ids, path, v))} />
  }

  const atKey = keyed && hasKeyAt(raw, frame)
  const ks = keysOf(raw)
  const prevKey = keyed ? [...ks].reverse().find(k => k.f < frame - 1e-4) : undefined
  const nextKey = keyed ? ks.find(k => k.f > frame + 1e-4) : undefined
  const hasExtras = isObj(raw) && (!!raw.wiggle || !!raw.loop)
  const canKey = animatable && !fallback && !assetKind && type !== 'bool' && type !== 'select'

  return (
    <>
      <div className="flex items-start gap-1 min-h-[22px]" data-prop-path={path}>
        {canKey ? (
          <button
            className={`w-4 h-[22px] text-[11px] leading-none flex-shrink-0 ${atKey ? 'text-amber-300' : keyed ? 'text-amber-600' : 'text-zinc-600 hover:text-zinc-300'}`}
            title={keyed ? (atKey ? 'この位置のキーを消す(Shift + クリック: キーをすべて消して今の値で固定)' : 'この位置にキーを足す(Shift + クリック: キーをすべて消す)') : 'キーフレームを打つ(以後、値を変えると再生位置にキーが打たれます)'}
            disabled={locked} data-key-toggle
            onClick={e => (e.shiftKey ? clearKeys(ids, path, dflt) : toggleKeyAt(ids, path, value ?? dflt))}
          >{atKey ? '◆' : '◇'}</button>
        ) : <span className="w-4 flex-shrink-0" />}
        {optional && <input type="checkbox" checked disabled={locked} data-opt-switch className="self-center" title="切にすると、この項目を消します(機能オフ)" onChange={turnOff} />}
        <span className={`${labelCls} text-zinc-400 ${optional ? '!w-[68px]' : ''}`} title={`${title}(${path})`}>{title}</span>
        <div className="flex items-center gap-1 flex-wrap min-w-0 flex-1">{body}</div>
        {keyed && (
          <span className="flex items-center flex-shrink-0">
            <button className={iconBtnCls} disabled={!prevKey} title="前のキーへ" onClick={() => prevKey && setFrame(prevKey.f)}>◂</button>
            <button className={iconBtnCls} disabled={!nextKey} title="次のキーへ" onClick={() => nextKey && setFrame(nextKey.f)}>▸</button>
          </span>
        )}
        {canKey && (
          <button className={`${iconBtnCls} flex-shrink-0 ${hasExtras ? 'text-purple-300' : ''}`} title="ループ・揺れ(wiggle)" data-anim-extras-btn onClick={() => setExtras(x => !x)}>〰</button>
        )}
      </div>
      {extras && canKey && <AnimExtras ids={ids} path={path} raw={raw} value={value} />}
    </>
  )
})

const skipPatSize = (k: string) => k === 'width' || k === 'height'
