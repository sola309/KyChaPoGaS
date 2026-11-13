// 🔤 字幕クリップ(kind='credit')の調整パネル。ClipInspector から開く(🎬 SatsueiPanel と同じく右下に浮かべる)。
//  字幕 = ガラスの文字。下の絵(Shots・撮影・ロゴ…ここより下のトラック全部)が文字の中で屈折して見える。
//  式は ../Preview/creditLook.ts(コマごとの数)+ creditGL.ts(画素)。書き出しは backend credit_fx.py(同じ式・同じ地図)。
//  つまみはすぐプレビューに出る: 手元のクリップを書き換え、保存は止まってから 300ms 後に 1 回(satsueiEdit.editClipLive)。
//  止まるまでの一続きが「元に戻す」1 回ぶん。attrs_json のほかの欄・credit の知らない欄は消さない。
//  文字・大きさ・フォントなど「文字の形」が変わる欄は backend で地図を作り直す(250ms 止まってから。届くまでは前の絵のまま)。

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Clip } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import {
  type CreditV1, type Vec3, creditOf, creditRange, creditFonts, CREDIT_DEFAULT, FONT_LABEL, holdOf, eAt, gOf,
  outsideSafe, isCreditClip,
} from '../Preview/creditLook'
import { creditMapsErrorFor, creditMapsVersion, lastCreditMapsInfo, loadCreditMeta, subscribeCreditMaps } from '../Preview/creditFields'
import { creditGLProblem } from '../Preview/creditGL'
import { setCreditPanelClipId, creditPanelClipId, requestCreditSnapshot } from '../Preview/creditUi'
import { useProjectStore } from '../../store/projectStore'
import { editClipLive, flushClipEdit } from './satsueiEdit'
import {
  editCredit, setCreditField, copyCreditParts, extendCredits, lastShotsEnd, mergeParts,
  CREDIT_PART_LABEL, type CreditPart,
} from './creditEdit'
import { fmtTc, parseTc } from './filterLayers'

interface Props { clip: Clip; onClose: () => void }

type Obj = Record<string, unknown>
const btn = 'text-[10px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30'
const btnHot = 'text-[10px] px-2 py-0.5 rounded border bg-cyan-800 hover:bg-cyan-700 text-white border-cyan-500 disabled:opacity-40'
const inputCls = 'bg-zinc-800 text-[10px] text-zinc-100 rounded px-1.5 py-0.5 outline-none border border-zinc-700 focus:border-cyan-500'
const getIn = (o: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((c, k) => (c && typeof c === 'object' ? (c as Obj)[k] : undefined), o)
const r4 = (v: number) => Math.round(v * 1e4) / 1e4
const hexOf = (c: readonly number[]) => '#' + c.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
const rgbOf = (h: string): Vec3 => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) || 0) as Vec3

// ── 小さな部品 ─────────────────────────────────────────────────────────
function Row({ label, hint, v, d, min, max, step, fmt, onChange, disabled, mapKey }: {
  label: string; hint: string; v: number; d: number; min: number; max: number; step: number
  fmt: (v: number) => string; onChange: (v: number) => void; disabled?: boolean; mapKey?: boolean
}) {
  const changed = Math.abs(v - d) > 1e-9
  return (
    <div className="mb-1" title={`${hint}(名前をダブルクリックで既定値 ${fmt(d)} に戻す)${mapKey ? '。文字の形が変わるので、少し待つと反映されます' : ''}`}>
      <div className="flex items-center gap-2">
        <span onDoubleClick={() => { if (!disabled) onChange(d) }}
              className={`text-[10px] w-[5.8rem] flex-shrink-0 truncate cursor-default ${changed ? 'text-cyan-300' : 'text-zinc-400'}`}>
          {label}{mapKey ? <span className="text-zinc-600">*</span> : null}
        </span>
        <input type="range" min={min} max={max} step={step} value={Math.max(min, Math.min(max, v))} disabled={disabled}
               onChange={e => onChange(Number(e.target.value))}
               className="flex-1 min-w-0 h-1 accent-cyan-400 disabled:opacity-40" />
        <span className={`text-[10px] w-12 text-right tabular-nums ${changed ? 'text-cyan-300' : 'text-zinc-500'}`}>{fmt(v)}</span>
      </div>
    </div>
  )
}

/** 整数(コマ・px)の入力: 数字 + 小さく動かすボタン。確定は Enter / 離れたとき / ボタン */
function IntField({ label, hint, v, min, max, onChange, disabled, steps = [1, 10], suffix, w = 'w-14' }: {
  label: string; hint: string; v: number; min: number; max: number; onChange: (v: number) => void
  disabled?: boolean; steps?: number[]; suffix?: string; w?: string
}) {
  const [txt, setTxt] = useState(String(v))
  useEffect(() => { setTxt(String(v)) }, [v])
  const commit = (s: string) => {
    const n = Math.round(Number(s))
    if (!Number.isFinite(n)) { setTxt(String(v)); return }
    const c = Math.max(min, Math.min(max, n))
    setTxt(String(c))
    if (c !== v) onChange(c)
  }
  const nudge = (d: number) => { const c = Math.max(min, Math.min(max, v + d)); if (c !== v) onChange(c) }
  return (
    <div className="flex items-center gap-1 mb-1" title={hint}>
      <span className="text-[10px] w-[5.8rem] flex-shrink-0 text-zinc-400 truncate">{label}</span>
      {steps.slice().reverse().map(s => <button key={-s} className={btn + ' px-1'} disabled={disabled} onClick={() => nudge(-s)}>−{s}</button>)}
      <input value={txt} disabled={disabled} onChange={e => setTxt(e.target.value)} onBlur={e => commit(e.target.value)}
             onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
             className={`${inputCls} ${w} text-right tabular-nums`} />
      {steps.map(s => <button key={s} className={btn + ' px-1'} disabled={disabled} onClick={() => nudge(s)}>+{s}</button>)}
      {suffix && <span className="text-[10px] text-zinc-500">{suffix}</span>}
    </div>
  )
}

/** 日本語入力(IME)で崩れない文字の欄: 変換中は書き込まず、確定・止まって 150ms・離れたとき・Enter で書く */
function TextField({ label, hint, value, onCommit, disabled, placeholder, field }: {
  label: string; hint: string; value: string; onCommit: (v: string) => void; disabled?: boolean; placeholder?: string; field?: string
}) {
  const [draft, setDraft] = useState(value)
  const composing = useRef(false)
  const sent = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ref = useRef<HTMLInputElement | null>(null)
  // 外から変わった(元に戻すなど)ときは入力中でなければ合わせる
  useEffect(() => {
    if (value === sent.current) return
    sent.current = value
    if (!composing.current) setDraft(value)
  }, [value])
  const commit = (v: string) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (v === sent.current) return
    sent.current = v
    onCommit(v)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return (
    <div className="flex items-center gap-2 mb-1" title={hint}>
      <span className="text-[10px] w-[5.8rem] flex-shrink-0 text-zinc-400">{label}</span>
      <input ref={ref} value={draft} disabled={disabled} placeholder={placeholder} data-credit-field={field}
             onChange={e => {
               const v = e.target.value
               setDraft(v)
               if (composing.current || (e.nativeEvent as InputEvent).isComposing) return
               if (timer.current) clearTimeout(timer.current)
               timer.current = setTimeout(() => commit(v), 150)
             }}
             onCompositionStart={() => { composing.current = true }}
             onCompositionEnd={e => { composing.current = false; const v = (e.target as HTMLInputElement).value; setDraft(v); commit(v) }}
             onBlur={e => { if (!composing.current) commit(e.target.value) }}
             onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur() }}
             className={`${inputCls} flex-1 min-w-0 text-[11px]`} />
    </div>
  )
}

function Section({ title, open, onToggle, badge, children }: {
  title: string; open: boolean; onToggle: () => void; badge?: string; children: React.ReactNode
}) {
  return (
    <div className="border-t border-zinc-800 pt-1.5 mt-1.5">
      <button onClick={onToggle} className="w-full flex items-center gap-1 text-[11px] text-zinc-300 hover:text-white">
        <span className="w-3 text-zinc-500">{open ? '▾' : '▸'}</span>
        <span>{title}</span>
        {badge && <span className="ml-auto text-[9px] text-cyan-300/90">{badge}</span>}
      </button>
      {open && <div className="mt-1 pl-1">{children}</div>}
    </div>
  )
}

function TcInput({ frame, fps, onCommit, disabled }: { frame: number; fps: number; onCommit: (f: number) => void; disabled?: boolean }) {
  const [txt, setTxt] = useState(fmtTc(frame, fps))
  useEffect(() => { setTxt(fmtTc(frame, fps)) }, [frame, fps])
  const commit = () => {
    const f = parseTc(txt, fps)
    if (f == null) { setTxt(fmtTc(frame, fps)); return }
    if (f !== frame) onCommit(f)
  }
  return (
    <input value={txt} disabled={disabled} onChange={e => setTxt(e.target.value)} onBlur={commit}
           onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
           className={`${inputCls} font-mono w-20`} title="MM:SS:FF またはフレーム数" />
  )
}

/** 出現・消失の進み(濃い線 = 屈折の強さ e、薄い線 = ガラスの見た目 g)と再生位置。クリックでそのコマへ */
function RampGraph({ clip, credit }: { clip: Clip; credit: CreditV1 }) {
  const currentFrame = useTimelineStore(s => s.currentFrame)
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const dur = Math.max(1, clip.duration_frames)
  const a = credit.timing.appear_frames, d = credit.timing.disappear_frames, g0 = credit.refract.g0
  const W = 320, H = 46, P = 3
  const x = (i: number) => P + ((i + 0.5) / dur) * (W - 2 * P)
  const y = (v: number) => H - P - v * (H - 2 * P - 4)
  const { pe, pg } = useMemo(() => {
    const n = Math.min(dur, 320)
    const e1: string[] = [], g1: string[] = []
    for (let k = 0; k <= n; k++) {
      const i = Math.min(dur - 1, Math.round(k / Math.max(1, n) * (dur - 1)))
      const e = eAt(i, dur, a, d), g = gOf(e, g0)
      e1.push(`${x(i).toFixed(1)},${y(e).toFixed(1)}`); g1.push(`${x(i).toFixed(1)},${y(g).toFixed(1)}`)
    }
    return { pe: e1.join(' '), pg: g1.join(' ') }
  }, [dur, a, d, g0])  // eslint-disable-line react-hooks/exhaustive-deps
  const rel = currentFrame - clip.start_frame
  const ref = useRef<SVGSVGElement | null>(null)
  const seek = (ev: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const i = Math.max(0, Math.min(dur - 1, Math.floor(((ev.clientX - r.left) / r.width * W - P) / (W - 2 * P) * dur)))
    setCurrentFrame(clip.start_frame + i)
  }
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full h-[46px] bg-zinc-950 rounded border border-zinc-800 cursor-pointer select-none touch-none"
         onPointerDown={seek} onPointerMove={ev => { if (ev.buttons & 1) seek(ev) }}>
      {a + d > dur && <rect x={0} y={0} width={W} height={H} fill="#ef4444" fillOpacity={0.15} />}
      <rect x={P} y={P} width={Math.max(0, x(a - 0.5) - P)} height={H - 2 * P} fill="#0e7490" fillOpacity={0.25} />
      <rect x={x(dur - d - 0.5)} y={P} width={Math.max(0, W - P - x(dur - d - 0.5))} height={H - 2 * P} fill="#0e7490" fillOpacity={0.25} />
      <line x1={P} y1={y(g0)} x2={W - P} y2={y(g0)} stroke="#a1a1aa" strokeOpacity={0.35} strokeDasharray="2 3" />
      <polygon points={`${x(0)},${H - P} ${pe} ${x(dur - 1)},${H - P}`} fill="#22d3ee" fillOpacity={0.15} />
      <polyline points={pg} fill="none" stroke="#e0f2fe" strokeOpacity={0.7} strokeWidth={1} />
      <polyline points={pe} fill="none" stroke="#67e8f9" strokeWidth={1.6} />
      {rel >= 0 && rel < dur && <line x1={x(rel)} y1={0} x2={x(rel)} y2={H} stroke="#f472b6" strokeWidth={1.2} />}
    </svg>
  )
}

// ── つまみの並び ───────────────────────────────────────────────────────
interface RowSpec { path: string[]; label: string; hint: string; step: number; fmt: (v: number) => string; detail?: boolean; mapKey?: boolean; ui?: [number, number] }
const f2 = (v: number) => v.toFixed(2), f3 = (v: number) => v.toFixed(3)
const REFRACT_ROWS: RowSpec[] = [
  { path: ['refract', 'tube'], label: '管の屈折', hint: '文字の太さの中で丸い管のように絵が曲がる強さ(いちばん効く)', step: 0.05, fmt: f2 },
  { path: ['refract', 'letter'], label: '文字レンズ', hint: '1 文字ずつの大きなレンズの強さ(文字の真ん中ほど絵がふくらむ)', step: 0.005, fmt: f3 },
  { path: ['refract', 'zoom'], label: 'ズーム', hint: '字幕全体で絵を少し拡大する', step: 0.001, fmt: f3 },
  { path: ['refract', 'disp'], label: '色ずれ', hint: '赤は弱く・青は強く曲がる(プリズムの色のにじみ)', step: 0.005, fmt: f3 },
  { path: ['refract', 'fres'], label: '縁の光', hint: '文字の縁に入る白い光(屈折している間)', step: 0.05, fmt: f2 },
  { path: ['refract', 'hl'], label: 'ハイライト', hint: '左上から当たる光(屈折している間)', step: 0.05, fmt: f2 },
  { path: ['refract', 'absorb'], label: '縁の暗み', hint: '文字の縁で絵が少し暗くなる(屈折している間)', step: 0.01, fmt: f2 },
  { path: ['refract', 'n_max'], label: '反射の強さ n', hint: 'ガラスの屈折率(縁の光の基本の強さだけに効く)', step: 0.01, fmt: f2 },
  { path: ['refract', 'slope_sat'], label: '管の傾きの上限', hint: '管の縁の急な所の曲がりの上限', step: 0.1, fmt: f2, detail: true, mapKey: true },
  { path: ['refract', 'letter_sigma'], label: 'レンズの広さ', hint: '文字レンズの広がり', step: 0.01, fmt: f2, detail: true, mapKey: true },
  { path: ['refract', 'fres_pow'], label: '縁の光の鋭さ', hint: '縁の光の幅(大きいほど細く鋭い)', step: 0.05, fmt: f2, detail: true, mapKey: true },
]
const LOOK_ROWS: RowSpec[] = [
  { path: ['style', 'rim'], label: '縁', hint: 'ガラスの縁の色の幅(名前の文字)', step: 0.01, fmt: f2, mapKey: true },
  { path: ['style', 'shadow'], label: '影', hint: '文字の下の影の濃さ', step: 0.05, fmt: f2, mapKey: true },
  { path: ['style', 'glow'], label: '光彩', hint: '文字のまわりの光', step: 0.01, fmt: f2, mapKey: true },
  { path: ['style', 'plate'], label: '下敷き', hint: '文字の後ろのぼんやりした色の下敷き(明るい絵の上で読みやすく)', step: 0.01, fmt: f2, mapKey: true },
  { path: ['style', 'sheen'], label: 'つや', hint: '文字の上を横切る光の帯の強さ', step: 0.01, fmt: f2 },
  { path: ['style', 'sheen_width'], label: 'つやの幅', hint: '光の帯の幅(文字の高さに対して)', step: 0.01, fmt: f2 },
  { path: ['style', 'letter_var'], label: '文字ごとの明るさ', hint: '文字ごとに明るさを少しずつ変えて、ゆっくり揺らす', step: 0.005, fmt: f3, mapKey: true },
  { path: ['style', 'role_shadow'], label: '役職の影', hint: '役職(上の行)の影の濃さ', step: 0.05, fmt: f2, detail: true, mapKey: true },
  { path: ['style', 'shadow_sigma'], label: '影のぼかし', hint: '影のぼけ幅(名前の大きさに対して)', step: 0.005, fmt: f3, detail: true, mapKey: true },
  { path: ['style', 'glow_sigma'], label: '光彩の広さ', hint: '光彩の広がり(名前の大きさに対して)', step: 0.005, fmt: f3, detail: true, mapKey: true },
  { path: ['style', 'plate_sigma'], label: '下敷きの広さ', hint: '下敷きの広がり', step: 0.01, fmt: f2, detail: true, mapKey: true },
]
const SIZE_ROWS: RowSpec[] = [
  { path: ['style', 'line_gap'], label: '行間', hint: '役職と名前の間(名前の大きさに対して)', step: 0.01, fmt: f2, mapKey: true },
  { path: ['style', 'name_track'], label: '名前の字間', hint: '名前(英数)の字間', step: 0.01, fmt: f2, detail: true, mapKey: true },
  { path: ['style', 'name_ja_scale'], label: '名前(日本語)の大きさ', hint: '名前の日本語の文字の大きさ(英数に対して)', step: 0.01, fmt: f2, detail: true, mapKey: true },
  { path: ['style', 'name_ja_track'], label: '名前(日本語)の字間', hint: '名前の日本語の字間', step: 0.01, fmt: f2, detail: true, mapKey: true },
  { path: ['style', 'role_track'], label: '役職の字間', hint: '役職の字間', step: 0.01, fmt: f2, detail: true, mapKey: true },
  { path: ['style', 'role_latin_scale'], label: '役職(英数)の大きさ', hint: '役職の英数の文字の大きさ(日本語に対して)', step: 0.01, fmt: f2, detail: true, mapKey: true },
]
const TIMING_PRESETS: { label: string; a: number; d: number; hint: string }[] = [
  { label: 'さっと', a: 14, d: 12, hint: '前の .mov の速さ(出現 14・消失 12 コマ)' },
  { label: '標準', a: 24, d: 20, hint: '出現 24・消失 20 コマ(新しい既定)' },
  { label: 'ゆっくり', a: 32, d: 26, hint: '出現 32・消失 26 コマ' },
  { label: 'たっぷり', a: 42, d: 34, hint: '出現 42・消失 34 コマ(長いカット向き)' },
]
const REFRACT_PRESETS: { label: string; v: Partial<Record<'tube' | 'letter' | 'zoom' | 'disp' | 'fres' | 'hl', number>> }[] = [
  { label: '控えめ', v: { tube: 0.7, letter: 0.05, zoom: 0.004, disp: 0.04, fres: 0.4, hl: 0.6 } },
  { label: '標準', v: { tube: 1.2, letter: 0.09, zoom: 0.008, disp: 0.07, fres: 0.55, hl: 0.9 } },
  { label: '強め', v: { tube: 1.8, letter: 0.12, zoom: 0.011, disp: 0.09, fres: 0.7, hl: 1.1 } },
  { label: 'とても強く', v: { tube: 2.8, letter: 0.18, zoom: 0.016, disp: 0.12, fres: 0.85, hl: 1.3 } },
]
const OPEN_KEY = 'credit.panel.open'
const DEFAULT_OPEN = ['text', 'pos', 'time', 'refract']
const loadOpen = (): Set<string> => {
  try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null'); if (Array.isArray(v)) return new Set(v.map(String)) } catch { /* 既定 */ }
  return new Set(DEFAULT_OPEN)
}

// ── パネル ─────────────────────────────────────────────────────────────
export function CreditPanel({ clip, onClose }: Props) {
  const clips = useTimelineStore(s => s.clips)
  const tracks = useTimelineStore(s => s.tracks)
  const fps = useTimelineStore(s => s.projectFps) || 24
  const setTrackHidden = useTimelineStore(s => s.setTrackHidden)
  const P = creditOf(clip.attrs_json)
  const locked = !!clip.locked
  const [, setTick] = useState(0)
  useSyncExternalStore(subscribeCreditMaps, creditMapsVersion)       // 地図が届いたら警告(文字の枠など)を見直す
  const mapsErr = creditMapsErrorFor(clip.id)
  const [open, setOpen] = useState<Set<string>>(loadOpen)
  const [detail, setDetail] = useState(false)
  const [msg, setMsg] = useState('')
  const [parts, setParts] = useState<Set<CreditPart>>(new Set(['timing', 'refract', 'look']))
  const [ask, setAsk] = useState<null | 'group' | 'all' | 'extend' | 'reset'>(null)
  const [extN, setExtN] = useState(12)
  const [extScope, setExtScope] = useState<'group' | 'all'>('all')
  const proj = useProjectStore(s => s.activeProject)
  // 「書き出しと同じ計算」: 左 = プレビュー(WebGL)、右 = サーバー(numpy = 書き出しの式)、差
  const [still, setStill] = useState<null | { frame: number; preview: string; server: string; stat: string } | { frame: number; err: string }>(null)
  const [stillBusy, setStillBusy] = useState(false)
  useEffect(() => () => { if (still && 'server' in still) URL.revokeObjectURL(still.server) }, [still])

  useEffect(() => {
    let live = true
    void loadCreditMeta().then(m => { if (live && m) setTick(n => n + 1) })
    return () => { live = false }
  }, [])
  // プレビューにこのクリップの枠を出す(ドラッグで動かす)・全部の字幕の地図を先に取る
  useEffect(() => {
    setCreditPanelClipId(clip.id)
    return () => { if (creditPanelClipId() === clip.id) setCreditPanelClipId(null); void flushClipEdit(clip.id) }
  }, [clip.id])

  const toggle = (id: string) => setOpen(s => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...n])) } catch { /* ignore */ }
    return n
  })

  const num = (path: readonly string[]) => Number(getIn(P, path) ?? 0)
  const def = (path: readonly string[]) => Number(getIn(CREDIT_DEFAULT, path) ?? 0)
  const rng = (path: readonly string[], fb: [number, number]) => creditRange(path.join('.')) ?? fb
  const set = (path: readonly string[], v: unknown, label?: string) => { if (!locked) setCreditField(clip.id, path, v, label) }
  const rowOf = (r: RowSpec) => {
    const [lo, hi] = r.ui ?? rng(r.path, [0, 1])
    return <Row key={r.path.join('.')} label={r.label} hint={r.hint} v={num(r.path)} d={def(r.path)} min={lo} max={hi} step={r.step}
                fmt={r.fmt} disabled={locked} mapKey={r.mapKey}
                onChange={x => set(r.path, r4(Math.max(lo, Math.min(hi, x))), `字幕: ${r.label}`)} />
  }
  const rows = (list: RowSpec[]) => list.filter(r => detail || !r.detail).map(rowOf)
  const clipEdit = (patch: Partial<Clip>, label: string, key = label) => { if (!locked) editClipLive(clip.id, patch, label, key) }

  // ── 時間 ───────────────────────────────────────────────────────────
  const dur = clip.duration_frames
  const a = P.timing.appear_frames, d = P.timing.disappear_frames
  const hold = holdOf(P, dur)
  const refrOnly = useMemo(() => {
    // 出現・消失のうちガラスの色が付く前(屈折だけ)のコマ数
    let ai = 0, di = 0
    for (let i = 0; i < Math.min(a, dur); i++) if (eAt(i, dur, a, d) > 0 && gOf(eAt(i, dur, a, d), P.refract.g0) === 0) ai++
    for (let i = Math.max(0, dur - d); i < dur; i++) if (eAt(i, dur, a, d) > 0 && gOf(eAt(i, dur, a, d), P.refract.g0) === 0) di++
    return { ai, di }
  }, [a, d, dur, P.refract.g0])
  const setTiming = (na: number, nd: number, label: string) =>
    editCredit(clip.id, c => ({ ...c, timing: { ...c.timing, appear_frames: na, disappear_frames: nd } }), label, 'credit.timing.both')

  // ── 位置と大きさ ───────────────────────────────────────────────────
  const [nlo, nhi] = rng(['style', 'name_size'], [8, 400])
  const [rlo, rhi] = rng(['style', 'role_size'], [8, 300])
  const setSize = (ns: number) => editCredit(clip.id, c => {
    const k = ns / Math.max(1e-6, c.style.name_size)
    return { ...c, style: { ...c.style, name_size: Math.round(ns), role_size: Math.round(Math.max(rlo, Math.min(rhi, c.style.role_size * k))) } }
  }, '字幕: 大きさ', 'credit.style.size')
  const placeAt = (align: CreditV1['align'], x: number, y: number) =>
    editCredit(clip.id, c => ({ ...c, align, pos: [x, y] }), '字幕: 位置', 'credit.pos')

  // ── 警告 ───────────────────────────────────────────────────────────
  const track = tracks.find(t => t.id === clip.track_id)
  const info = lastCreditMapsInfo(clip.id)
  const inkNow = (() => {
    if (!info) return null
    const ib = info.maps.header.ink_box_design
    if (!ib) return null
    const dx = P.pos[0] - info.credit.pos[0], dy = P.pos[1] - info.credit.pos[1]
    return [ib[0] + dx, ib[1] + dy, ib[2] + dx, ib[3] + dy]
  })()
  const shotsEnd = lastShotsEnd()
  const warns: { text: string; act?: { label: string; fn: () => void } }[] = []
  if (track?.hidden) warns.push({ text: `「${track.name}」トラックが非表示です(プレビューにも書き出しにも出ません)`, act: { label: 'トラックを表示', fn: () => { void setTrackHidden(track.id, false) } } })
  if (a + d > dur) warns.push({ text: `出現 ${a} + 消失 ${d} = ${a + d} コマが長さ ${dur} コマより長いので、ガラスに満ちきりません(長さを伸ばすか、出現・消失を短く)` })
  if (outsideSafe(inkNow)) warns.push({ text: '文字が画面の 90%(タイトルセーフ)の外に出ています' })
  if (shotsEnd != null && clip.start_frame + dur > shotsEnd) warns.push({ text: `最後の Shots(f${shotsEnd - 1})より後まで続いています(書き出しが伸びます)` })
  if (!P.name) warns.push({ text: '名前が空なので、この字幕は何も描きません' })
  if (mapsErr) warns.push({ text: `字幕の形を作れませんでした: ${mapsErr}` })
  const glProblem = creditGLProblem()
  if (glProblem) warns.push({ text: `この端末ではプレビューに字幕が出ません(${glProblem})` })

  // ── ほかの字幕へ ───────────────────────────────────────────────────
  const allCredits = clips.filter(c => isCreditClip(c))
  const group = P.group
  const sameGroup = group ? allCredits.filter(c => c.id !== clip.id && creditOf(c.attrs_json).group === group) : []
  const others = allCredits.filter(c => c.id !== clip.id)
  const partList = [...parts]
  const doCopy = async (scope: 'group' | 'all') => {
    setAsk(null)
    const targets = scope === 'group' ? sameGroup : others
    const label = scope === 'group' ? `字幕: 同じ組へ写す(${partList.map(p => CREDIT_PART_LABEL[p]).join('・')})` : `字幕: 全部へ写す(${partList.map(p => CREDIT_PART_LABEL[p]).join('・')})`
    try {
      await flushClipEdit(clip.id)
      const n = await copyCreditParts(useTimelineStore.getState().clips.find(c => c.id === clip.id) ?? clip, targets, partList, label)
      setMsg(`${n} 本の字幕へ写しました(元に戻すで 1 回で戻せます)`)
    } catch { setMsg('⚠ 写せませんでした(通信エラー)') }
  }
  const doExtend = async () => {
    setAsk(null)
    const base = extScope === 'group' && group
      ? allCredits.filter(c => creditOf(c.attrs_json).group === group)
      : allCredits
    try {
      await flushClipEdit(clip.id)
      const n = await extendCredits(base, extN, `字幕: 尺を ${extN > 0 ? '+' : ''}${extN} コマ`)
      setMsg(`${n} 本の字幕の尺を ${extN > 0 ? '+' : ''}${extN} コマにしました(末尾を動かしました。元に戻すで 1 回で戻せます)`)
    } catch { setMsg('⚠ 尺を変えられませんでした(通信エラー)') }
  }
  const doReset = () => {
    setAsk(null)
    editCredit(clip.id, c => mergeParts(c, CREDIT_DEFAULT, ['timing', 'refract', 'look']), '字幕: 既定に戻す', 'credit.reset')
  }
  const showStill = async () => {
    setStillBusy(true)
    const f = useTimelineStore.getState().currentFrame
    try {
      await flushClipEdit(clip.id)
      const snap = await requestCreditSnapshot(clip.id)
      if (!snap) { setStill({ frame: f, err: 'このコマでは字幕がプレビューに出ていません(字幕の範囲へ再生位置を動かしてから)' }); return }
      const cur = useTimelineStore.getState().clips.find(c => c.id === clip.id) ?? clip
      const r = await fetch('/api/credits/still', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credit: creditOf(cur.attrs_json), start_frame: cur.start_frame, duration_frames: cur.duration_frames, opacity: cur.opacity ?? 1,
          frame: snap.frame, fps, box: snap.box, content: [proj?.width ?? snap.box[0], proj?.height ?? snap.box[1]], picture_png_b64: snap.below,
        }),
      })
      if (!r.ok) { let m = `${r.status}`; try { const j = await r.json(); if (typeof j?.detail === 'string') m = j.detail } catch { /* 本文なし */ } setStill({ frame: snap.frame, err: `サーバーで描けませんでした: ${m}` }); return }
      const server = URL.createObjectURL(await r.blob())
      // 差(枠全体の RGB、0..255)
      const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src })
      const [a, b] = await Promise.all([load(snap.preview), load(server)])
      const px = (im: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = snap.box[0]; c.height = snap.box[1]; const x = c.getContext('2d', { willReadFrequently: true })!; x.drawImage(im, 0, 0); return x.getImageData(0, 0, c.width, c.height).data }
      const pa = px(a), pb = px(b)
      let mx = 0, sum = 0, n = 0, over = 0
      for (let i = 0; i < pa.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(pa[i + c] - pb[i + c]); if (d > mx) mx = d; sum += d; n++; if (d > 2) over++ }
      setStill({ frame: snap.frame, preview: snap.preview, server, stat: `差: いちばん大きい所 ${mx}・平均 ${(sum / n).toFixed(4)}(0〜255)・2 より大きい所 ${over} 個` })
    } catch (e) {
      setStill({ frame: f, err: `描けませんでした: ${String((e as Error)?.message ?? e)}` })
    } finally { setStillBusy(false) }
  }
  const playFromHead = () => {
    window.dispatchEvent(new CustomEvent('kychapogas:play-range', { detail: { from: clip.start_frame, to: clip.start_frame + clip.duration_frames } }))
  }
  const fonts = creditFonts()
  const clipEnd = clip.start_frame + dur - 1

  return createPortal(
    <div className="fixed right-3 bottom-3 w-[372px] max-w-[calc(100vw-1.5rem)] max-h-[85dvh] overflow-y-auto overscroll-contain rounded-lg border border-cyan-800 bg-zinc-900/95 shadow-2xl backdrop-blur p-3 z-[110] text-zinc-200"
         onKeyDown={e => e.stopPropagation()} data-credit-panel={clip.id}>
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-[11px] font-semibold text-cyan-200 truncate">
          🔤 字幕 {P.role ? `${P.role} ` : ''}{P.name || '(名前なし)'}
          <span className="text-zinc-500 font-normal"> f{clip.start_frame}〜{clipEnd}・{track?.name ?? ''}{P.label ? `・${P.label}` : ''}</span>
        </span>
        <button onClick={() => { void flushClipEdit(clip.id); onClose() }} className="text-zinc-500 hover:text-zinc-200 text-xs leading-none">✕</button>
      </div>
      <p className="text-[9px] text-zinc-500 mb-1.5 leading-tight">
        ガラスの文字。下に重なっている絵が文字の中で屈折して見えます。つまみはすぐプレビューに出て、自動で保存されます(元に戻すで 1 操作ずつ)。
        <span className="text-zinc-600"> * の欄は文字の形が変わるので、手を止めて少しすると反映されます。</span>
      </p>
      {locked && <p className="text-[10px] text-amber-400 mb-1">🔒 ロック中は変えられません</p>}
      {warns.length > 0 && (
        <div className="mb-1 flex flex-col gap-0.5">
          {warns.map((w, i) => (
            <div key={i} className="text-[10px] text-amber-300 leading-tight flex items-center gap-1.5">
              <span>⚠ {w.text}</span>
              {w.act && <button className={btn + ' ml-auto flex-shrink-0'} onClick={w.act.fn}>{w.act.label}</button>}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 mb-1 [&>button]:whitespace-nowrap">
        <button className={btnHot} onClick={playFromHead} title="字幕の頭から再生して、終わりで止める">▶ 出現から再生</button>
        <button className={btn} onClick={() => useTimelineStore.getState().setCurrentFrame(clip.start_frame + Math.max(0, Math.min(dur - 1, a + Math.floor(Math.max(0, hold) / 2))))}
                title="ガラスに満ちた所(保持のまん中)へ">◆ 保持へ</button>
        <button className={btn} disabled={stillBusy} onClick={() => { void showStill() }}
                title="このコマを、書き出しと同じ計算(サーバーの Python)でも描いて、プレビューと並べて比べる">🖼 書き出しと同じ計算</button>
        <span className="ml-auto text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">{dur} コマ({(dur / fps).toFixed(2)} 秒)</span>
      </div>

      {/* 全体の効き = クリップの不透明度 */}
      <div className="flex items-center gap-2 mb-1" title="字幕全体の効き(クリップの不透明度)。0 で下の絵のまま">
        <span className="text-[10px] font-semibold text-zinc-200 w-[5.8rem] flex-shrink-0">全体の効き</span>
        <input type="range" min={0} max={100} step={1} value={Math.round((clip.opacity ?? 1) * 100)} disabled={locked}
               onChange={e => clipEdit({ opacity: Number(e.target.value) / 100 }, '字幕の効き')}
               className="flex-1 min-w-0 h-1 accent-cyan-400 disabled:opacity-40" />
        <span className="text-[10px] w-9 text-right tabular-nums text-zinc-300">{Math.round((clip.opacity ?? 1) * 100)}%</span>
      </div>

      <Section title="文字" open={open.has('text')} onToggle={() => toggle('text')}>
        <TextField label="役職" hint="上の行(白い文字)。空にすると名前だけ" value={P.role} disabled={locked} placeholder="(なし)" field="role"
                   onCommit={v => set(['role'], v, '字幕: 役職')} />
        <TextField label="名前" hint="下の行(ガラスの文字)。空にすると字幕は何も描きません" value={P.name} disabled={locked} field="name"
                   onCommit={v => set(['name'], v, '字幕: 名前')} />
        <div className="flex items-center gap-1 mb-1">
          <span className="text-[10px] w-[5.8rem] flex-shrink-0 text-zinc-400" title="行どうしのそろえ方(位置 X が左端・まん中・右端になる)">揃え</span>
          {([['left', '左'], ['center', '中央'], ['right', '右']] as const).map(([k, l]) => (
            <button key={k} disabled={locked} onClick={() => set(['align'], k, '字幕: 揃え')}
                    className={`text-[10px] px-2 py-0.5 rounded ${P.align === k ? 'bg-cyan-800 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}>{l}</button>
          ))}
        </div>
        {detail && (
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 mt-1">
            {([['name_latin', '名前(英数)'], ['name_ja', '名前(日本語)'], ['role_latin', '役職(英数)'], ['role_ja', '役職(日本語)']] as const).map(([k, l]) => (
              <label key={k} className="flex flex-col text-[9px] text-zinc-500">
                <span>{l}のフォント*</span>
                <select value={String(P.style.fonts[k])} disabled={locked} className={inputCls}
                        onChange={e => set(['style', 'fonts', k], e.target.value, '字幕: フォント')}>
                  {fonts.map(f => <option key={f.id} value={f.id}>{FONT_LABEL[f.id] ?? f.id}{f.ok === false ? '(無い)' : ''}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
      </Section>

      <Section title="位置と大きさ" open={open.has('pos')} onToggle={() => toggle('pos')}
               badge={`(${Math.round(P.pos[0])}, ${Math.round(P.pos[1])})・${P.style.name_size}px`}>
        <IntField label="X(左右)" hint="2560×1440 の画面での位置(揃えが左なら文字の左端、中央ならまん中、右なら右端)" v={Math.round(P.pos[0])}
                  min={rng(['pos'], [-1280, 3840])[0]} max={3840} disabled={locked}
                  onChange={v => editCredit(clip.id, c => ({ ...c, pos: [v, c.pos[1]] }), '字幕: 位置', 'credit.pos')} />
        <IntField label="Y(上下)" hint="2560×1440 の画面での位置(文字のいちばん上)" v={Math.round(P.pos[1])} min={-720} max={2160} disabled={locked}
                  onChange={v => editCredit(clip.id, c => ({ ...c, pos: [c.pos[0], v] }), '字幕: 位置', 'credit.pos')} />
        <div className="flex flex-wrap items-center gap-1 mb-1 pl-[6.1rem]">
          <button className={btn + ' px-1'} disabled={locked} onClick={() => placeAt('left', 160, P.pos[1])}>左寄せ</button>
          <button className={btn + ' px-1'} disabled={locked} onClick={() => placeAt('center', 1280, P.pos[1])}>中央</button>
          <button className={btn + ' px-1'} disabled={locked} onClick={() => placeAt('right', 2400, P.pos[1])}>右寄せ</button>
          <button className={btn + ' px-1'} disabled={locked} onClick={() => placeAt(P.align, P.pos[0], 1064)} title="下のいつもの高さ(y 1064)">下</button>
          <button className={btn + ' px-1'} disabled={locked} onClick={() => placeAt(P.align, P.pos[0], 160)} title="上(y 160)">上</button>
        </div>
        <p className="text-[9px] text-zinc-600 mb-1 pl-[6.1rem] leading-tight">プレビューの枠をドラッグで動かせます(Shift で縦横どちらかだけ・ホイールで大きさ)。</p>
        <Row label="大きさ" hint="名前の大きさ(px、2560 の画面)。役職も同じ割合で変わる" v={P.style.name_size} d={CREDIT_DEFAULT.style.name_size}
             min={nlo} max={Math.min(nhi, 240)} step={1} fmt={v => `${Math.round(v)}px`} disabled={locked} mapKey onChange={v => setSize(v)} />
        {detail && (
          <>
            <Row label="名前の大きさ" hint="名前だけの大きさ(px)" v={P.style.name_size} d={CREDIT_DEFAULT.style.name_size} min={nlo} max={nhi} step={1}
                 fmt={v => `${Math.round(v)}px`} disabled={locked} mapKey onChange={v => set(['style', 'name_size'], Math.round(v), '字幕: 名前の大きさ')} />
            <Row label="役職の大きさ" hint="役職だけの大きさ(px)" v={P.style.role_size} d={CREDIT_DEFAULT.style.role_size} min={rlo} max={rhi} step={1}
                 fmt={v => `${Math.round(v)}px`} disabled={locked} mapKey onChange={v => set(['style', 'role_size'], Math.round(v), '字幕: 役職の大きさ')} />
          </>
        )}
        {rows(SIZE_ROWS)}
      </Section>

      <Section title="時間(出現・保持・消失)" open={open.has('time')} onToggle={() => toggle('time')}
               badge={`${a} / ${hold} / ${d} コマ`}>
        <RampGraph clip={clip} credit={P} />
        <p className="text-[9px] text-zinc-500 mt-0.5 mb-1 leading-tight">
          濃い線 = 屈折の強さ、薄い線 = ガラスの色。点線より下は屈折だけ(出現 {refrOnly.ai} コマ・消失 {refrOnly.di} コマ)。クリックでそのコマへ。
        </p>
        <div className="flex items-center gap-1.5 mb-1 text-[10px] text-zinc-400">
          <span className="w-[5.8rem] flex-shrink-0">開始</span>
          <TcInput frame={clip.start_frame} fps={fps} disabled={locked}
                   onCommit={f => clipEdit({ start_frame: Math.max(0, f) }, '字幕の開始')} />
          <span className="text-zinc-600">f{clip.start_frame}</span>
          <button className={btn + ' ml-auto'} disabled={locked} title="開始を再生位置へ(長さはそのまま)"
                  onClick={() => clipEdit({ start_frame: useTimelineStore.getState().currentFrame }, '字幕の開始')}>◆ 再生位置へ</button>
        </div>
        <IntField label="長さ" hint="クリップの長さ(コマ)。末尾が動きます" v={dur} min={1} max={100000} disabled={locked} suffix="コマ"
                  onChange={v => clipEdit({ duration_frames: v }, '字幕の長さ')} />
        <IntField label="出現" hint="先頭から、屈折 → ガラスに満ちるまでのコマ数" v={a} min={0} max={240} disabled={locked} suffix="コマ"
                  onChange={v => set(['timing', 'appear_frames'], v, '字幕の出現')} />
        <IntField label="保持" hint="ガラスに満ちている間のコマ数(変えると長さが変わる)" v={hold} min={-480} max={100000} disabled={locked} suffix="コマ"
                  onChange={v => clipEdit({ duration_frames: Math.max(1, a + v + d) }, '字幕の長さ')} />
        <IntField label="消失" hint="ガラス → 屈折 → 消えるまでのコマ数(末尾から)" v={d} min={0} max={240} disabled={locked} suffix="コマ"
                  onChange={v => set(['timing', 'disappear_frames'], v, '字幕の消失')} />
        <div className="flex flex-wrap items-center gap-1 mb-1 pl-[6.1rem]">
          {TIMING_PRESETS.map(p => (
            <button key={p.label} className={`${btn} px-1 ${a === p.a && d === p.d ? 'ring-1 ring-cyan-500' : ''}`} disabled={locked}
                    title={p.hint} onClick={() => setTiming(p.a, p.d, `字幕の出現・消失(${p.label})`)}>{p.label}</button>
          ))}
        </div>
        <Row label="屈折だけの割合" hint="出現・消失のうち、ガラスの色が付く前の屈折だけの部分(大きいほど屈折が長く見える)" v={P.refract.g0}
             d={CREDIT_DEFAULT.refract.g0} min={0} max={rng(['refract', 'g0'], [0, 0.95])[1]} step={0.01} fmt={v => `${Math.round(v * 100)}%`}
             disabled={locked} onChange={v => set(['refract', 'g0'], r4(v), '字幕: 屈折だけの割合')} />
        <Row label="ガラス色の満ち方" hint="ガラスの色が縁から中へ満ちていく強さ(0 = 一様に)" v={P.refract.fill_q} d={CREDIT_DEFAULT.refract.fill_q}
             min={0} max={rng(['refract', 'fill_q'], [0, 3])[1]} step={0.05} fmt={f2} disabled={locked}
             onChange={v => set(['refract', 'fill_q'], r4(v), '字幕: ガラス色の満ち方')} />
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400 mb-1">
          <span className="w-[5.8rem] flex-shrink-0" title="光の帯が文字を横切る時刻(クリップ先頭からのコマ)">つやの時刻</span>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" className="accent-cyan-500 w-3 h-3" disabled={locked}
                   checked={P.timing.sheen_start == null && P.timing.sheen_end == null}
                   onChange={e => editCredit(clip.id, c => ({ ...c, timing: { ...c.timing,
                     sheen_start: e.target.checked ? null : (c.timing.appear_frames - 2),
                     sheen_end: e.target.checked ? null : (dur - c.timing.disappear_frames + 2) } }), '字幕: つやの時刻', 'credit.timing.sheen')} />
            自動(出現の終わり〜消失の始まり)
          </label>
        </div>
        {(P.timing.sheen_start != null || P.timing.sheen_end != null) && (
          <>
            <IntField label="つやの始まり" hint="クリップ先頭からのコマ" v={P.timing.sheen_start ?? a - 2} min={-240} max={2400} disabled={locked}
                      onChange={v => set(['timing', 'sheen_start'], v, '字幕: つやの時刻')} />
            <IntField label="つやの終わり" hint="クリップ先頭からのコマ" v={P.timing.sheen_end ?? dur - d + 2} min={-240} max={2400} disabled={locked}
                      onChange={v => set(['timing', 'sheen_end'], v, '字幕: つやの時刻')} />
          </>
        )}
      </Section>

      <Section title="屈折" open={open.has('refract')} onToggle={() => toggle('refract')}>
        <div className="flex flex-wrap items-center gap-1 mb-1.5">
          <span className="text-[10px] text-zinc-500 w-[5.8rem] flex-shrink-0">強さの目安</span>
          {REFRACT_PRESETS.map(p => (
            <button key={p.label} className={btn + ' px-1'} disabled={locked}
                    onClick={() => editCredit(clip.id, c => ({ ...c, refract: { ...c.refract, ...p.v } }), `字幕: 屈折(${p.label})`, 'credit.refract.preset')}>{p.label}</button>
          ))}
        </div>
        {rows(REFRACT_ROWS)}
        {detail && (
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] w-[5.8rem] flex-shrink-0 text-zinc-400">縁の光の色</span>
            <input type="color" value={hexOf(P.refract.fres_rgb)} disabled={locked}
                   onChange={e => set(['refract', 'fres_rgb'], rgbOf(e.target.value), '字幕: 縁の光の色')}
                   className="w-7 h-5 bg-transparent border border-zinc-700 rounded cursor-pointer" />
          </div>
        )}
      </Section>

      <Section title="見た目" open={open.has('look')} onToggle={() => toggle('look')}>
        {rows(LOOK_ROWS)}
        <IntField label="きらめき" hint="光の帯が通るときに出る星の数(0〜6)*" v={P.style.glints} min={0} max={6} steps={[1]} disabled={locked}
                  onChange={v => set(['style', 'glints'], v, '字幕: きらめき')} />
        <div className="flex items-center gap-1 mb-1" title="文字ごとの明るさのゆらぎ・きらめきの位置を決める数(組の字幕は同じにするとそろう)*">
          <span className="text-[10px] w-[5.8rem] flex-shrink-0 text-zinc-400">乱数*</span>
          <input type="number" value={P.seed} disabled={locked} onChange={e => set(['seed'], Math.max(0, Math.round(Number(e.target.value) || 0)), '字幕: 乱数')}
                 className={`${inputCls} w-24`} />
          <button className={btn} disabled={locked} onClick={() => set(['seed'], Math.floor(Math.random() * 100000), '字幕: 乱数')}>🎲</button>
        </div>
        {detail && (
          <div className="flex items-center gap-3 mb-1">
            <label className="flex items-center gap-1 text-[10px] text-zinc-400">縁の色*
              <input type="color" value={hexOf(P.style.edge_rgb)} disabled={locked} onChange={e => set(['style', 'edge_rgb'], rgbOf(e.target.value), '字幕: 縁の色')}
                     className="w-7 h-5 bg-transparent border border-zinc-700 rounded cursor-pointer" />
            </label>
            <label className="flex items-center gap-1 text-[10px] text-zinc-400">下敷きの色*
              <input type="color" value={hexOf(P.style.plate_rgb)} disabled={locked} onChange={e => set(['style', 'plate_rgb'], rgbOf(e.target.value), '字幕: 下敷きの色')}
                     className="w-7 h-5 bg-transparent border border-zinc-700 rounded cursor-pointer" />
            </label>
          </div>
        )}
      </Section>

      <Section title="ほかの字幕へ・まとめて" open={open.has('copy')} onToggle={() => toggle('copy')}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mb-1">
          {(Object.keys(CREDIT_PART_LABEL) as CreditPart[]).map(k => (
            <label key={k} className="flex items-center gap-1 text-[10px] text-zinc-300 cursor-pointer select-none">
              <input type="checkbox" checked={parts.has(k)} className="accent-cyan-500 w-3 h-3"
                     onChange={e => setParts(s => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n })} />
              {CREDIT_PART_LABEL[k]}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
          {ask === 'group' || ask === 'all'
            ? (
              <span className="flex items-center gap-1 text-[10px] text-cyan-200">
                {ask === 'group' ? `同じ組(${group})の ${sameGroup.length} 本` : `ほかの字幕 ${others.length} 本`}へ写す?
                <button className={btnHot} onClick={() => { void doCopy(ask) }}>はい</button>
                <button className={btn} onClick={() => setAsk(null)}>やめる</button>
              </span>
            )
            : (
              <>
                <button className={btn} disabled={locked || !group || !sameGroup.length || !partList.length} onClick={() => setAsk('group')}
                        title="選んだ欄を同じ組の字幕へ写す(🔒ロック中は飛ばす)">同じ組に写す{group ? `(${sameGroup.length})` : '(組なし)'}</button>
                <button className={btn} disabled={locked || !others.length || !partList.length} onClick={() => setAsk('all')}
                        title="選んだ欄をほかの字幕全部へ写す(🔒ロック中は飛ばす)">全字幕に写す({others.length})</button>
              </>
            )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mb-1.5 text-[10px] text-zinc-400">
          <span>尺を</span>
          <input type="number" value={extN} onChange={e => setExtN(Math.round(Number(e.target.value) || 0))} className={`${inputCls} w-14`} />
          <span>コマ</span>
          <select value={extScope} onChange={e => setExtScope(e.target.value as 'group' | 'all')} className={inputCls}>
            <option value="all">全部の字幕({allCredits.length})</option>
            {group && <option value="group">同じ組({sameGroup.length + 1})</option>}
          </select>
          {ask === 'extend'
            ? (<><button className={btnHot} onClick={() => { void doExtend() }}>はい</button><button className={btn} onClick={() => setAsk(null)}>やめる</button></>)
            : <button className={btn} disabled={!extN} onClick={() => setAsk('extend')} title="末尾を動かして尺を変える(元に戻す 1 回で戻せる)">伸ばす</button>}
        </div>
        <div className="flex items-center gap-1.5">
          {ask === 'reset'
            ? (<span className="flex items-center gap-1 text-[10px] text-cyan-200">時間・屈折・見た目を既定に戻す?
                <button className={btnHot} onClick={doReset}>はい</button><button className={btn} onClick={() => setAsk(null)}>やめる</button></span>)
            : <button className={btn} disabled={locked} onClick={() => setAsk('reset')} title="文字・位置・大きさ・フォントは残して、時間・屈折・見た目を既定値に">既定に戻す</button>}
        </div>
        {detail && (
          <div className="mt-1.5 grid grid-cols-2 gap-x-2">
            <label className="flex flex-col text-[9px] text-zinc-500">組(同じ組にまとめて写す)
              <input value={P.group} disabled={locked} onChange={e => set(['group'], e.target.value, '字幕: 組')} className={inputCls} />
            </label>
            <label className="flex flex-col text-[9px] text-zinc-500">名札(C13a など)
              <input value={P.label} disabled={locked} onChange={e => set(['label'], e.target.value, '字幕: 名札')} className={inputCls} />
            </label>
          </div>
        )}
      </Section>

      <div className="flex items-center gap-2 mt-2 border-t border-zinc-800 pt-1.5">
        <label className="flex items-center gap-1 text-[10px] text-zinc-300 cursor-pointer select-none">
          <input type="checkbox" checked={detail} onChange={e => setDetail(e.target.checked)} className="accent-cyan-500 w-3 h-3" />細かい設定も出す
        </label>
      </div>
      {msg && <p className="text-[10px] text-zinc-300 mt-1 leading-tight">{msg}</p>}

      {still && createPortal(
        <div className="fixed inset-0 z-[120] flex flex-col items-center justify-center bg-black/85 p-3" onClick={() => setStill(null)} data-credit-still="">
          {'err' in still
            ? <p className="text-sm text-amber-300">{still.err}</p>
            : (
              <div className="flex flex-wrap gap-2 justify-center">
                <figure className="flex flex-col items-center">
                  <img src={still.preview} alt="プレビュー" className="max-w-[47vw] max-h-[76vh] object-contain border border-zinc-700 rounded" />
                  <figcaption className="text-[11px] text-zinc-300 mt-1">プレビュー(WebGL)</figcaption>
                </figure>
                <figure className="flex flex-col items-center">
                  <img src={still.server} alt="書き出しと同じ計算" className="max-w-[47vw] max-h-[76vh] object-contain border border-zinc-700 rounded" />
                  <figcaption className="text-[11px] text-zinc-300 mt-1">書き出しと同じ計算(サーバー)</figcaption>
                </figure>
              </div>
            )}
          <p className="text-[11px] text-zinc-300 mt-2 text-center leading-tight">
            f{still.frame}: 下の絵はどちらもプレビューの今の絵(字幕より下のトラック)。{'stat' in still ? still.stat : ''}<br />
            <span className="text-zinc-500">クリックで閉じる</span>
          </p>
        </div>,
        document.body,
      )}
    </div>,
    document.body,
  )
}
