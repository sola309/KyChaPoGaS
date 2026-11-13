// 🎞 編集画面の小さな入力部品(数値・色・選択)。数値は横ドラッグでつまみのように動かせる。

import { memo, useRef, useState } from 'react'
import { round, toHex6 } from './docOps'

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
  return (
    <label className={`flex items-center gap-0.5 ${className ?? 'w-[62px]'}`} title={title ?? '横にドラッグで増減(Shift: 10 倍 / Alt: 1/10)・クリックで入力・↑↓'}>
      {prefix && <span className="text-[9px] text-zinc-500 select-none w-2 text-center flex-shrink-0">{prefix}</span>}
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        disabled={disabled}
        className={`${inputCls} w-full text-right font-mono cursor-ew-resize focus:cursor-text ${disabled ? 'opacity-40' : ''}`}
        value={draft ?? (mixed ? '—' : String(round(safe, 3)))}
        onChange={e => setDraft(e.target.value)}
        onPointerDown={e => {
          if (disabled || e.button !== 0 || document.activeElement === ref.current) return
          e.preventDefault()
          drag.current = { x: e.clientX, v: safe, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          const d = drag.current
          if (!d) return
          const dx = e.clientX - d.x
          if (!d.moved && Math.abs(dx) < 3) return
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
          if (!d.moved) { ref.current?.focus(); ref.current?.select() }
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
    </label>
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
  return (
    <span className="flex items-center gap-1">
      {nullable && (
        <input type="checkbox" checked={!none} title={none ? 'なし(チェックで色をつける)' : 'チェックを外すと「なし」'}
               onChange={e => { onChange(e.target.checked ? hex : null); onEnd?.() }} />
      )}
      <input type="color" value={hex} disabled={none}
             className={`w-7 h-5 p-0 bg-transparent border border-zinc-700 rounded cursor-pointer ${none ? 'opacity-30' : ''}`}
             onChange={e => onChange(e.target.value)} onBlur={onEnd} />
      <input type="text" disabled={none} className={`${inputCls} w-[68px] font-mono ${none ? 'opacity-30' : ''}`}
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
