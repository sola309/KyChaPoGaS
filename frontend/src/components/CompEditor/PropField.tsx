// 🎞 プロパティ 1 つぶんの行(スキーマの記述 ParamDesc から欄を作る)。
// ◆ = 再生位置のキーフレームの切り替え。キーつきのプロパティは、値を直すと再生位置にキーが打たれる。

import { memo, useEffect, useState } from 'react'
import type { AnimProp, Easing, Layer, ParamDesc } from './types'
import { evalProp, getPath, hasKeyAt, isAnimObj, isColorStr, isKeyed, isObj, keysOf } from './docOps'
import { useCompStore } from './store'
import { ColorField, JsonField, NumField, inputCls, iconBtnCls } from './fields'
import { loadFonts, FONTS } from './schema'
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

export function EasingSelect({ value, onChange }: { value: Easing | undefined; onChange: (e: Easing) => void }) {
  const easings = useCompStore(s => s.schema.easings)
  const isBez = Array.isArray(value)
  const cur = isBez ? '__bezier' : (value ?? 'linear')
  const known = easings.some(o => o.value === cur)
  return (
    <span className="flex items-center gap-1 flex-wrap">
      <select className={`${inputCls} max-w-[150px]`} value={cur}
              onChange={e => onChange(e.target.value === '__bezier' ? [0.25, 0.1, 0.25, 1] : e.target.value)}>
        {easings.map(o => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
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
  const [fonts, setFonts] = useState<string[]>(FONTS)
  useEffect(() => { let on = true; void loadFonts().then(f => { if (on) setFonts(f) }); return () => { on = false } }, [])
  const known = fonts.includes(value)
  return (
    <select className={`${inputCls} max-w-[170px]`} value={value} onChange={e => onChange(e.target.value)}>
      {!known && value && <option value={value}>{value}</option>}
      {fonts.map(f => <option key={f} value={f}>{f}</option>)}
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
    <div className="ml-[90px] mb-1 pl-2 border-l border-zinc-700 flex flex-col gap-1 text-[10px] text-zinc-400">
      <span className="flex items-center gap-1">
        ループ
        <select className={inputCls} disabled={!keyed} value={p.loop ?? ''}
                title={keyed ? '最後のキーのあと、キーの区間をくり返す' : 'キーフレームがあるときに使えます'}
                onChange={e => { const n = base(); if (e.target.value) n.loop = e.target.value as 'cycle' | 'pingpong'; else delete n.loop; write(n) }}>
          <option value="">なし</option>
          <option value="cycle">くり返し(cycle)</option>
          <option value="pingpong">行って戻る(pingpong)</option>
        </select>
      </span>
      <span className="flex items-center gap-1 flex-wrap">
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!w} onChange={e => setW(e.target.checked ? {} : null)} />揺れ(wiggle)</label>
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

export const PropField = memo(function PropField({ ids, layer, path, desc, label, dims, labels, rotZ, link }: PropFieldProps) {
  const raw = getPath(layer, path)
  const anim = isAnimObj(raw)
  const keyed = isKeyed(raw)
  // キーつきのときだけ再生位置を購読する(再生中に描き直すのはキーのある行だけ)
  const frame = useCompStore(s => (keyed ? s.frame : -1))
  const setProp = useCompStore(s => s.setProp)
  const setRaw = useCompStore(s => s.setRaw)
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
  const type = desc.type
  const animatable = desc.animatable === true || anim
  const locked = !!layer.locked

  let body: React.ReactNode
  let fallback = false

  if (rotZ) {
    // 回転: 2D は z だけ
    const z = isNum(value) ? value : Array.isArray(value) && isNum(value[value.length >= 3 ? 2 : value.length - 1]) ? (value[value.length >= 3 ? 2 : value.length - 1] as number) : 0
    body = <NumField value={z} step={desc.step ?? 1} disabled={locked} onEnd={end}
                     onChange={v => write(Array.isArray(value) ? value.map((x, i) => (i === (value.length >= 3 ? 2 : value.length - 1) ? v : x)) : v)} />
  } else if (NUMERIC.has(type) && (isNum(value) || value == null)) {
    body = <NumField value={isNum(value) ? value : 0} step={desc.step ?? (type === 'percent' ? 1 : 1)} min={desc.min} max={desc.max} disabled={locked}
                     onChange={write} onEnd={end} />
  } else if ((type === 'vec2' || type === 'vec3' || dims) && (numArr(value) || isNum(value) || value == null)) {
    const n = dims ?? (type === 'vec3' ? 3 : 2)
    const dv = numArr(dflt) ? dflt : []
    const arr: number[] = numArr(value) ? value : isNum(value) ? new Array(n).fill(value) : dv
    const get = (i: number) => (isNum(arr[i]) ? arr[i] : isNum(dv[i]) ? dv[i] : 0)
    const lab = labels ?? ['X', 'Y', 'Z']
    const setI = (i: number, v: number) => {
      // 元の配列の長さは保つ(足りなければ既定値で伸ばす)。見えていない成分は触らない
      const len = Math.max(arr.length, i + 1, numArr(value) ? 0 : n)
      const out = Array.from({ length: len }, (_, j) => get(j))
      if (link && linked && i < 2 && get(i) !== 0) {
        const r = v / get(i)
        for (let j = 0; j < Math.min(len, n); j++) if (j !== i) out[j] = Math.round(get(j) * r * 1000) / 1000
      }
      out[i] = v
      write(out)
    }
    body = (<>
      {Array.from({ length: n }, (_, i) => (
        <NumField key={i} prefix={lab[i]} value={get(i)} step={desc.step ?? 1} min={desc.min} max={desc.max} disabled={locked}
                  onChange={v => setI(i, v)} onEnd={end} />
      ))}
      {link && <button className={`${iconBtnCls} ${linked ? 'text-purple-300' : ''}`} title="縦横の比を保つ" onClick={() => setLinked(l => !l)}>{linked ? '🔗' : '⛓️‍💥'}</button>}
    </>)
  } else if (type === 'color' && (value == null || isColorStr(value) || numArr(value))) {
    body = <ColorField value={value} nullable={desc.nullable === true || dflt === null} onChange={write} onEnd={end} />
  } else if (type === 'bool') {
    body = <input type="checkbox" checked={!!value} disabled={locked} onChange={e => setRaw(ids, path, e.target.checked)} />
  } else if (type === 'select' && (value == null || typeof value === 'string' || typeof value === 'number')) {
    const opts = desc.options ?? []
    const asNum = desc.numeric === true || typeof dflt === 'number' || (typeof value === 'number')
    const cur = value == null ? '' : String(value)
    body = (
      <select className={`${inputCls} max-w-[170px]`} value={cur} disabled={locked}
              onChange={e => setRaw(ids, path, asNum && isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value)}>
        {!opts.some(o => String(o.value) === cur) && <option value={cur}>{cur || '—'}</option>}
        {opts.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label ?? String(o.value)}</option>)}
      </select>
    )
  } else if (type === 'text' && (value == null || typeof value === 'string')) {
    const multi = path.endsWith('.text') || desc.multiline === true
    body = multi
      ? <textarea rows={3} className={`${inputCls} w-full resize-y`} value={(value as string) ?? ''} disabled={locked}
                  onChange={e => write(e.target.value)} onBlur={end} />
      : <input type="text" className={`${inputCls} w-full`} value={(value as string) ?? ''} disabled={locked}
               onChange={e => write(e.target.value)} onBlur={end} />
  } else if (type === 'font' && (value == null || typeof value === 'string')) {
    body = <FontSelect value={(value as string) ?? ''} onChange={v => setRaw(ids, path, v)} />
  } else if (type === 'easing' && (value == null || typeof value === 'string' || numArr(value))) {
    body = <EasingSelect value={value as Easing | undefined} onChange={e => setRaw(ids, path, e, ck)} />
  } else if (type === 'asset' && (value == null || isNum(value))) {
    body = (<>
      <span className="text-[11px] text-zinc-300 font-mono">{value == null ? '(なし)' : `#${value}`}</span>
      {isNum(value) && <img src={`/api/assets/${value}/thumbnail`} alt="" className="h-6 rounded border border-zinc-700" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />}
      <button className={iconBtnCls} title="素材を選び直す"
              onClick={() => window.dispatchEvent(new CustomEvent('kychapogas:comp-pick-asset', { detail: { ids, path, kind: desc.kind ?? layer.type } }))}>選ぶ…</button>
    </>)
  } else if (type === 'comp' && (value == null || isNum(value))) {
    body = <CompSelect value={value as number | null} onChange={v => setRaw(ids, path, v)} />
  } else if (type === 'colors' && Array.isArray(value) && value.every(isColorStr)) {
    body = (<>
      {value.map((c, i) => (
        <input key={i} type="color" value={(c as string).slice(0, 7)} className="w-7 h-5 p-0 bg-transparent border border-zinc-700 rounded cursor-pointer"
               onChange={e => write(value.map((x, j) => (j === i ? e.target.value : x)))} onBlur={end} />
      ))}
    </>)
  } else if (type === 'colors' && (value == null || isColorStr(value))) {
    body = <ColorField value={value} onChange={write} onEnd={end} />
  } else {
    // 知らない型・形の合わない値(グラデーションの塗り、文字列のキーなど)は JSON で
    fallback = true
    body = <JsonField value={raw === undefined ? dflt : raw} onChange={v => setRaw(ids, path, v)} />
  }

  const atKey = keyed && hasKeyAt(raw, frame)
  const ks = keysOf(raw)
  const prevKey = keyed ? [...ks].reverse().find(k => k.f < frame - 1e-4) : undefined
  const nextKey = keyed ? ks.find(k => k.f > frame + 1e-4) : undefined
  const hasExtras = isObj(raw) && (!!raw.wiggle || !!raw.loop)

  return (
    <>
      <div className="flex items-start gap-1 min-h-[22px]" data-prop-path={path}>
        {animatable && !fallback ? (
          <button
            className={`w-4 h-[22px] text-[11px] leading-none flex-shrink-0 ${atKey ? 'text-amber-300' : keyed ? 'text-amber-600' : 'text-zinc-600 hover:text-zinc-300'}`}
            title={keyed ? (atKey ? 'この位置のキーを消す(Shift + クリック: キーをすべて消して今の値で固定)' : 'この位置にキーを足す(Shift + クリック: キーをすべて消す)') : 'キーフレームを打つ(以後、値を変えると再生位置にキーが打たれます)'}
            disabled={locked}
            onClick={e => (e.shiftKey ? clearKeys(ids, path, dflt) : toggleKeyAt(ids, path, value ?? dflt))}
          >{atKey ? '◆' : '◇'}</button>
        ) : <span className="w-4 flex-shrink-0" />}
        <span className="text-[10px] text-zinc-400 w-[72px] flex-shrink-0 truncate leading-[22px]" title={`${label ?? desc.label ?? path}(${path})`}>{label ?? desc.label ?? path.split('.').pop()}</span>
        <div className="flex items-center gap-1 flex-wrap min-w-0 flex-1">{body}</div>
        {keyed && (
          <span className="flex items-center flex-shrink-0">
            <button className={iconBtnCls} disabled={!prevKey} title="前のキーへ" onClick={() => prevKey && setFrame(prevKey.f)}>◂</button>
            <button className={iconBtnCls} disabled={!nextKey} title="次のキーへ" onClick={() => nextKey && setFrame(nextKey.f)}>▸</button>
          </span>
        )}
        {animatable && !fallback && (
          <button className={`${iconBtnCls} flex-shrink-0 ${hasExtras ? 'text-purple-300' : ''}`} title="ループ・揺れ(wiggle)" onClick={() => setExtras(x => !x)}>〰</button>
        )}
      </div>
      {extras && animatable && !fallback && <AnimExtras ids={ids} path={path} raw={raw} value={value} />}
    </>
  )
})

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
