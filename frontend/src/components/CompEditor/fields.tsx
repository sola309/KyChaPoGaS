// 🎞 編集画面の小さな入力部品(数値・色・選択)。数値は横ドラッグでつまみのように動かせる。

import { memo, useEffect, useRef, useState } from 'react'
import { round, toHex6 } from './docOps'
import { useTouchUI } from './mobile'

export const inputCls = 'bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[11px] text-zinc-100 outline-none focus:border-purple-500 min-w-0'
export const btnCls = 'text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent'
export const iconBtnCls = 'text-[11px] leading-none px-1 py-0.5 rounded text-zinc-400 hover:bg-zinc-700 hover:text-white disabled:opacity-30'

interface NumProps {
  value: number
  /** how: 'scrub' = 横ドラッグ・↑↓(複数選択では差分として配る)/ 'type' = 入力した値 */
  onChange: (v: number, how?: 'scrub' | 'type') => void
  /** ドラッグ・入力のひと区切り(取り消し 1 回ぶんの終わり) */
  onEnd?: () => void
  step?: number
  min?: number
  max?: number
  prefix?: string
  className?: string
  title?: string
  disabled?: boolean
  /** 複数選択で値がそろっていない */
  mixed?: boolean
}

/**
 * 数値欄。横にドラッグ = 値を動かす(Shift で 10 倍、Alt で 1/10)。クリック = 入力。↑↓ = 1 刻み。
 */
export const NumField = memo(function NumField({ value, onChange, onEnd, step = 1, min, max, prefix, className, title, disabled, mixed }: NumProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null)
  const touch = useTouchUI()
  // − / + の押しっぱなし(指で触る並びだけ)。いちばん新しい値から刻む
  const live = useRef({ v: 0, onChange, onEnd })
  const rep = useRef<{ t: number; i: number } | null>(null)
  useEffect(() => () => { if (rep.current) { window.clearTimeout(rep.current.t); window.clearInterval(rep.current.i) } }, [])
  const clamp = (v: number) => {
    let x = v
    if (typeof min === 'number') x = Math.max(min, x)
    if (typeof max === 'number') x = Math.min(max, x)
    return round(x, 3)
  }
  const safe = typeof value === 'number' && isFinite(value) ? value : 0
  const commitDraft = () => {
    if (draft == null) return
    const v = parseFloat(draft)
    setDraft(null)
    if (isFinite(v) && (clamp(v) !== safe || mixed)) onChange(clamp(v), 'type')
  }
  useEffect(() => { live.current = { v: safe, onChange, onEnd } })
  const stepBy = (d: number) => {
    const c = live.current
    const nv = clamp(c.v + d * step)
    if (nv !== c.v) { c.v = nv; c.onChange(nv, 'scrub') }
  }
  const stopRep = () => {
    const r = rep.current
    if (!r) return
    rep.current = null
    window.clearTimeout(r.t); window.clearInterval(r.i)
    live.current.onEnd?.()
  }
  const startRep = (e: React.PointerEvent, d: number) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()            // 入力欄のフォーカス(画面キーボード)を動かさない
    stopRep()
    stepBy(d)
    const r = { t: 0, i: 0 }
    r.t = window.setTimeout(() => { r.i = window.setInterval(() => stepBy(d), 70) }, 420)
    rep.current = r
  }
  const stepBtn = (d: number) => (
    <button type="button" tabIndex={-1} disabled={disabled} data-num-step={d} aria-label={d < 0 ? '減らす' : '増やす'}
            className="comp-num-step w-9 h-10 flex-shrink-0 rounded border border-zinc-700 bg-zinc-800 text-zinc-200 text-[18px] leading-none active:bg-purple-800 disabled:opacity-40 select-none"
            style={{ touchAction: 'manipulation' }}
            onPointerDown={e => startRep(e, d)} onPointerUp={stopRep} onPointerCancel={stopRep} onPointerLeave={stopRep}
            onContextMenu={e => e.preventDefault()}>{d < 0 ? '−' : '+'}</button>
  )
  const Wrap = touch ? 'span' : 'label'
  return (
    <Wrap className={touch ? 'comp-num flex items-center gap-1 flex-1 min-w-[150px] max-w-[260px]' : `flex items-center gap-0.5 ${className ?? 'w-[62px]'}`}
          title={touch ? title : title ?? '横にドラッグで増減(Shift: 10 倍 / Alt: 1/10)・クリックで入力・↑↓'} data-num-field>
      {prefix && <span className={touch ? 'text-[12px] text-zinc-400 select-none min-w-[14px] text-center flex-shrink-0' : 'text-[9px] text-zinc-500 select-none w-2 text-center flex-shrink-0'}>{prefix}</span>}
      {touch && stepBtn(-1)}
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        disabled={disabled}
        className={`${inputCls} w-full text-right font-mono cursor-ew-resize focus:cursor-text ${disabled ? 'opacity-40' : ''}`}
        style={touch ? { touchAction: 'pan-y' } : undefined}
        enterKeyHint="done"
        value={draft ?? (mixed ? '—' : String(round(safe, 3)))}
        onChange={e => setDraft(e.target.value)}
        onFocus={touch ? e => { const el = e.currentTarget; window.setTimeout(() => { try { el.select() } catch { /* noop */ } }, 0) } : undefined}
        onPointerDown={e => {
          if (disabled || e.button !== 0 || document.activeElement === ref.current) return
          // 指: 押しただけならブラウザに任せて入力(画面キーボード)。横になぞれば増減、縦はスクロール(touch-action: pan-y)
          if (e.pointerType !== 'touch') e.preventDefault()
          drag.current = { x: e.clientX, v: safe, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          const d = drag.current
          if (!d) return
          const dx = e.clientX - d.x
          if (!d.moved && Math.abs(dx) < (e.pointerType === 'touch' ? 8 : 3)) return
          d.moved = true
          const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
          const nv = clamp(d.v + dx * step * mult)
          if (nv !== safe) onChange(nv, 'scrub')
        }}
        onPointerUp={e => {
          const d = drag.current
          if (!d) return
          drag.current = null
          try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* noop */ }
          if (!d.moved) { if (e.pointerType !== 'touch') { ref.current?.focus(); ref.current?.select() } }
          else onEnd?.()
        }}
        onPointerCancel={() => { if (drag.current) { drag.current = null; onEnd?.() } }}
        onKeyDown={e => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const base = draft != null && isFinite(parseFloat(draft)) ? parseFloat(draft) : safe
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
            setDraft(null)
            onChange(clamp(base + (e.key === 'ArrowUp' ? 1 : -1) * step * mult), 'scrub')
          } else if (e.key === 'Enter') { commitDraft(); ref.current?.blur() }
          else if (e.key === 'Escape') { setDraft(null); window.setTimeout(() => ref.current?.blur(), 0) }
        }}
        onBlur={() => { commitDraft(); onEnd?.() }}
      />
      {touch && stepBtn(1)}
    </Wrap>
  )
})

interface ColorProps {
  value: unknown                  // "#rrggbb" / [r,g,b,a] / null
  onChange: (v: string | null) => void
  onEnd?: () => void
  nullable?: boolean
  fallback?: string
}

/** 色。「なし」にできる欄(塗り・線)はチェックで切り替える */
export const ColorField = memo(function ColorField({ value, onChange, onEnd, nullable, fallback = '#ffffff' }: ColorProps) {
  const none = value == null
  const hex = toHex6(value, fallback)
  const [draft, setDraft] = useState<string | null>(null)
  const touch = useTouchUI()
  return (
    <span className="flex items-center gap-1">
      {nullable && (
        <input type="checkbox" checked={!none} title={none ? 'なし(チェックで色をつける)' : 'チェックを外すと「なし」'}
               onChange={e => { onChange(e.target.checked ? hex : null); onEnd?.() }} />
      )}
      <input type="color" value={hex} disabled={none}
             className={`w-7 h-5 p-0 bg-transparent border border-zinc-700 rounded cursor-pointer ${none ? 'opacity-30' : ''}`}
             onChange={e => onChange(e.target.value)} onBlur={onEnd} />
      <input type="text" disabled={none} className={`${inputCls} ${touch ? 'w-[112px]' : 'w-[68px]'} font-mono ${none ? 'opacity-30' : ''}`}
             autoCapitalize="off" autoCorrect="off" spellCheck={false}
             value={draft ?? (none ? '' : typeof value === 'string' ? value : hex)}
             onChange={e => setDraft(e.target.value)}
             onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
             onBlur={() => {
               if (draft != null && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(draft.trim())) onChange(draft.trim())
               setDraft(null); onEnd?.()
             }} />
    </span>
  )
})

/** 見出しつきの折りたたみ */
export function Section({ title, children, right, defaultOpen = true }: { title: string; children: React.ReactNode; right?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-zinc-800">
      <div className="flex items-center gap-1 px-2 py-1 bg-zinc-900 sticky top-0 z-10">
        <button className="flex-1 text-left text-[11px] font-bold text-zinc-300 hover:text-white" onClick={() => setOpen(o => !o)}>
          <span className="inline-block w-3 text-zinc-500">{open ? '▾' : '▸'}</span>{title}
        </button>
        {right}
      </div>
      {open && <div className="px-2 py-1.5 flex flex-col gap-1">{children}</div>}
    </div>
  )
}

/** ラベル + 中身の 1 行 */
export function Row({ label, children, title }: { label: React.ReactNode; children: React.ReactNode; title?: string }) {
  const touch = useTouchUI()
  // 指で触る並び: ラベルを上、中身を下(幅をいっぱいに使う)
  if (touch) {
    return (
      <div className="flex flex-col gap-1 py-1" title={title} data-row>
        <span className="text-[12px] text-zinc-400">{label}</span>
        <div className="flex items-center gap-2 flex-wrap min-w-0">{children}</div>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 min-h-[22px]" title={title}>
      <span className="text-[10px] text-zinc-400 w-[84px] flex-shrink-0 truncate">{label}</span>
      <div className="flex items-center gap-1 flex-wrap min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** JSON をそのまま書く欄(知らない型・形の合わない値用)。直せたときだけ書き込む */
export function JsonField({ value, onChange, rows = 2 }: { value: unknown; onChange: (v: unknown) => void; rows?: number }) {
  const text = value === undefined ? '' : JSON.stringify(value)
  const [draft, setDraft] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  return (
    <textarea
      rows={rows}
      spellCheck={false}
      className={`${inputCls} w-full font-mono resize-y ${err ? 'border-red-500' : ''}`}
      value={draft ?? text}
      title="JSON で書く欄(形が合わないときは赤くなり、書き込まれません)"
      onChange={e => { setDraft(e.target.value); setErr(false) }}
      onBlur={() => {
        if (draft == null) return
        if (draft.trim() === '') { setDraft(null); if (value !== undefined) onChange(undefined); return }
        try { const v = JSON.parse(draft); setDraft(null); setErr(false); if (JSON.stringify(v) !== text) onChange(v) }
        catch { setErr(true) }
      }}
    />
  )
}
