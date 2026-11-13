// 🎬 撮影クリップ(kind='satsuei')の調整パネル。ClipInspector から開く(🌧 RainPanel と同じく右下に浮かべる)。
//  撮影 = 下の絵(Shots など)にかける色・パラ・ライトリーク・レンズ・粒子。式は ../Preview/satsueiLook.ts
//  (プレビューは WebGL の satsueiGL.ts、書き出しは backend satsuei_fx.py。同じ式)。
//  つまみはすぐプレビューに出る: 手元のクリップを書き換え、保存は止まってから 300ms 後に 1 回(satsueiEdit.editClipLive)。
//  止まるまでの一続きが「元に戻す」1 回ぶん。attrs_json・attrs.satsuei の知らない欄(段階 2 の追加など)は消さない。
//  効きの時間変化(strength_keys)は 🎚 のキー編集(FilterLayerPopover)で。

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Clip, ClipCreate, SatsueiStats, SatsueiUserPresets, TransitionType } from '../../api/client'
import { detectSatsuei, laySatsuei, autofitSatsuei, satsueiStillUrl, getSatsueiUserPresets, putSatsueiUserPresets } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useUIStore } from '../../store/uiStore'
import {
  type SatsueiParams, type SatsueiPara, type SatsueiLeak, type Vec2, type Vec3,
  satsueiOf, satsueiPresets, satsueiMeta, presetParams, presetLabel, normalizeSatsuei,
  SATSUEI_DEFAULT, SATSUEI_RANGES, PARA_DEFAULT, LEAK_DEFAULT, MAX_PARA, MAX_LEAKS,
} from '../Preview/satsueiLook'
import { getSatsueiCompare, setSatsueiCompare, subscribeSatsueiCompare, type SatsueiCompare } from '../Preview/satsueiCompare'
import { satsueiGLProblem } from '../Preview/satsueiGL'
import { filterCarry } from './filterLayers'
import {
  editClipLive, flushClipEdit, flushAllClipEdits, patchClipsUndoable, replaceClips, adoptServerReplace,
  autofitAndSave, loadSatsueiMeta, satsueiBusy, setSatsueiBusy, subscribeSatsueiBusy,
} from './satsueiEdit'
import {
  type Obj, type SatsueiSection, type SplitPick, r6, tintFromHue, hueOfTint, TINT_MAX, rawSatsuei, setIn, withSatsuei,
  copySections, SECTION_LABEL, splitSegments, pickAt, applyFitted,
} from './satsueiUi'

interface Props {
  clip: Clip
  onClose: () => void
}

// ── 小さな部品 ─────────────────────────────────────────────────────────
const btn = 'text-[10px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30'
const btnHot = 'text-[10px] px-2 py-0.5 rounded border bg-amber-800 hover:bg-amber-700 text-white border-amber-500 disabled:opacity-40'
const inputCls = 'bg-zinc-800 text-[10px] text-zinc-100 rounded px-1.5 py-0.5 outline-none border border-zinc-700 focus:border-amber-500'

const getIn = (o: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((c, k) => (c && typeof c === 'object' ? (c as Obj)[k] : undefined), o)
/** つまみの範囲(backend の範囲。meta が届いていればそれ、無ければ写し) */
function rng(path: readonly string[], fb: [number, number]): [number, number] {
  for (const root of [satsueiMeta()?.ranges, SATSUEI_RANGES]) {
    const r = getIn(root, path)
    if (Array.isArray(r) && r.length === 2 && r.every(x => typeof x === 'number')) return [r[0], r[1]]
  }
  return fb
}
const sgn = (v: number, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`

function Row({ label, hint, v, d, min, max, step, fmt, ends, onChange, disabled }: {
  label: string; hint: string; v: number; d: number; min: number; max: number; step: number
  fmt: (v: number) => string; ends?: [string, string]; onChange: (v: number) => void; disabled?: boolean
}) {
  const changed = Math.abs(v - d) > 1e-9
  return (
    <div className="mb-1" title={`${hint}(名前をダブルクリックで「何もしない値」に戻す)`}>
      <div className="flex items-center gap-2">
        <span onDoubleClick={() => { if (!disabled) onChange(d) }}
              className={`text-[10px] w-[5.5rem] flex-shrink-0 truncate cursor-default ${changed ? 'text-amber-300' : 'text-zinc-400'}`}>{label}</span>
        <input type="range" min={min} max={max} step={step} value={v} disabled={disabled}
               onChange={e => onChange(Number(e.target.value))}
               className="flex-1 min-w-0 h-1 accent-amber-500 disabled:opacity-40" />
        <span className={`text-[10px] w-12 text-right tabular-nums ${changed ? 'text-amber-300' : 'text-zinc-500'}`}>{fmt(v)}</span>
      </div>
      {ends && (
        <div className="flex justify-between text-[9px] text-zinc-600 pl-[6rem] pr-14 -mt-0.5"><span>{ends[0]}</span><span>{ends[1]}</span></div>
      )}
    </div>
  )
}

function Check({ label, hint, on, onChange, disabled }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-1 text-[10px] text-zinc-300 cursor-pointer select-none" title={hint}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={e => onChange(e.target.checked)} className="accent-amber-500 w-3 h-3" />
      <span>{label}</span>
    </label>
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
        {badge && <span className="ml-auto text-[9px] text-amber-400/90">{badge}</span>}
      </button>
      {open && <div className="mt-1 pl-1">{children}</div>}
    </div>
  )
}

/** 影・ハイライトの色: 色相 + 量(明るさの変わらない向きの RGB の足し算に直す) */
function TintRow({ label, hint, value, onChange, disabled }: {
  label: string; hint: string; value: Vec3; onChange: (t: Vec3) => void; disabled?: boolean
}) {
  const [hueLocal, setHueLocal] = useState(() => hueOfTint(value, 210).hue)
  const h = hueOfTint(value, hueLocal)
  const hue = h.amount > 0 ? h.hue : hueLocal
  // 量のつまみの上限: ふだんは TINT_MAX。プリセット・貼り付けでそれより強い色が入っていたら、その強さまで広げる
  // (広げた上限は戻さない: 下げながらドラッグしても上限が縮んでつまみが逃げないように)
  const ampMax = useRef(TINT_MAX)
  ampMax.current = Math.max(ampMax.current, Math.ceil(h.amount * 1000) / 1000)
  const sw = value.map(x => Math.round(Math.max(0, Math.min(1, 0.5 + x * 6)) * 255))   // 色見本(6 倍に強めて見せる)
  return (
    <div className="mb-1.5" title={hint}>
      <div className="flex items-center gap-2">
        <span className={`text-[10px] w-[5.5rem] flex-shrink-0 ${h.amount > 1e-5 ? 'text-amber-300' : 'text-zinc-400'}`}
              onDoubleClick={() => { if (!disabled) onChange(tintFromHue(hue, 0, h.grey)) }}>{label}</span>
        <div className="flex-1 min-w-0">
          <input type="range" min={0} max={360} step={1} value={Math.round(hue)} disabled={disabled}
                 onChange={e => { const v = Number(e.target.value); setHueLocal(v); if (h.amount > 0) onChange(tintFromHue(v, h.amount, h.grey)) }}
                 className="w-full h-1 accent-zinc-200 disabled:opacity-40" title="色(色相)" />
          <div className="h-1 rounded-sm -mt-0.5 mb-0.5 opacity-70"
               style={{ background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' }} />
          <input type="range" min={0} max={ampMax.current} step={0.001} value={Math.min(ampMax.current, h.amount)} disabled={disabled}
                 onChange={e => onChange(tintFromHue(hue, Number(e.target.value), h.grey))}
                 className="w-full h-1 accent-amber-500 disabled:opacity-40" title="色の量" />
        </div>
        <span className="w-4 h-4 rounded-sm border border-zinc-600 flex-shrink-0" style={{ background: `rgb(${sw.join(',')})` }} />
        <span className="text-[10px] w-7 text-right tabular-nums text-zinc-500">{(h.amount * 1000).toFixed(0)}</span>
      </div>
    </div>
  )
}

/** 画面の小さな見取り図。点をドラッグで動かす(位置は画面の割合。画面の外へも少し出せる) */
function PointPad({ points, onMove, ellipse, disabled }: {
  points: { p: Vec2; fill: string; label: string }[]
  onMove: (i: number, p: Vec2) => void
  ellipse?: { c: Vec2; r: Vec2; color: string }
  disabled?: boolean
}) {
  const W = 160, H = 90, M = 0.25            // 見取り図に写すのは −0.25..1.25(画面は真ん中の 2/3)
  const sx = (x: number) => ((x + M) / (1 + 2 * M)) * W
  const sy = (y: number) => ((y + M) / (1 + 2 * M)) * H
  const ref = useRef<SVGSVGElement | null>(null)
  const toP = (ev: { clientX: number; clientY: number }): Vec2 => {
    const r = ref.current!.getBoundingClientRect()
    const f = (t: number) => Math.round(Math.max(-0.5, Math.min(1.5, t * (1 + 2 * M) - M)) * 1000) / 1000
    return [f((ev.clientX - r.left) / r.width), f((ev.clientY - r.top) / r.height)]
  }
  const down = (i: number) => (e: React.PointerEvent) => {
    if (disabled) return
    e.preventDefault(); e.stopPropagation()
    const move = (ev: PointerEvent) => onMove(i, toP(ev))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const fw = sx(1) - sx(0), fh = sy(1) - sy(0)
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-40 h-[90px] flex-shrink-0 bg-zinc-950 rounded border border-zinc-800 touch-none select-none">
      <rect x={sx(0)} y={sy(0)} width={fw} height={fh} fill="#27272a" stroke="#52525b" strokeWidth={1} />
      {ellipse && <ellipse cx={sx(ellipse.c[0])} cy={sy(ellipse.c[1])} rx={Math.max(1, ellipse.r[0] * fw)} ry={Math.max(1, ellipse.r[1] * fh)}
                           fill={ellipse.color} fillOpacity={0.3} />}
      {points.length > 1 && (
        <polyline points={points.map(q => `${sx(q.p[0])},${sy(q.p[1])}`).join(' ')} fill="none" stroke="#a1a1aa" strokeWidth={1.2} strokeDasharray="3 2" />
      )}
      {points.map((q, i) => (
        <circle key={i} cx={sx(q.p[0])} cy={sy(q.p[1])} r={5} fill={q.fill} stroke="#fafafa" strokeWidth={1.2}
                onPointerDown={down(i)} className={disabled ? '' : 'cursor-grab'}>
          <title>{q.label}</title>
        </circle>
      ))}
    </svg>
  )
}

function useCompare(): SatsueiCompare {
  const [c, setC] = useState(getSatsueiCompare())
  useEffect(() => subscribeSatsueiCompare(setC), [])
  return c
}

// パネルを閉じたら「比べる」を戻す(別の撮影クリップへ移る付け直しでは戻さない)
let compareResetTimer: ReturnType<typeof setTimeout> | null = null

// 開いている欄・細かい設定(この端末だけの覚え書き)
const OPEN_KEY = 'satsuei.panel.open'
const CLIP_KEY = 'satsuei.clipboard'
const DEFAULT_OPEN = ['preset', 'color', 'compare']
const loadOpen = (): Set<string> => {
  try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null'); if (Array.isArray(v)) return new Set(v.map(String)) } catch { /* 既定 */ }
  return new Set(DEFAULT_OPEN)
}

// ── つまみの並び(言葉は見た目で言うときの言い方)──────────────────────
interface RowSpec {
  path: string[]; label: string; hint: string; step: number; fb: [number, number]
  fmt: (v: number) => string; ends?: [string, string]; detail?: boolean
}
const COLOR_ROWS: RowSpec[] = [
  { path: ['color', 'exposure'], label: '露出', hint: '全体の明るさ(段。+1 で光が 2 倍)', step: 0.05, fb: [-2, 2], fmt: v => sgn(v) },
  { path: ['color', 'lift'], label: '黒の持ち上げ', hint: '黒を持ち上げて影をつぶさない(上げるとやわらかい絵に)', step: 0.005, fb: [-0.2, 0.3], fmt: v => v.toFixed(3) },
  { path: ['color', 'gamma'], label: '中間の明るさ', hint: '中間の明るさ。左ほど明るい(1 = そのまま)', step: 0.01, fb: [0.5, 1.6], fmt: v => v.toFixed(2), ends: ['明るく', '暗く'] },
  { path: ['color', 'gain'], label: '白の強さ', hint: '明るい所の強さ(1 = そのまま)', step: 0.01, fb: [0.5, 1.5], fmt: v => v.toFixed(2) },
  { path: ['color', 'contrast'], label: 'コントラスト', hint: '明るい所と暗い所の差', step: 0.01, fb: [-0.5, 0.5], fmt: v => sgn(v) },
  { path: ['color', 'pivot'], label: '明暗の中心', hint: 'コントラストを変えても動かない明るさ', step: 0.01, fb: [0.1, 0.9], fmt: v => v.toFixed(2), detail: true },
  { path: ['color', 'shoulder'], label: '白の肩', hint: 'この明るさより上をやわらかく丸める(白飛びをやわらげる)。1 = なし', step: 0.01, fb: [0.6, 1], fmt: v => v >= 1 ? 'なし' : v.toFixed(2), ends: ['やわらかく', 'なし'] },
  { path: ['color', 'sat'], label: '彩度', hint: '色の濃さ(1 = そのまま)', step: 0.01, fb: [0, 2], fmt: v => v.toFixed(2) },
  { path: ['color', 'vibrance'], label: '自然な彩度', hint: '色の薄い所ほど強く効く彩度(肌がこってりしにくい)', step: 0.01, fb: [-1, 1], fmt: v => sgn(v) },
]
const LENS_ROWS: RowSpec[] = [
  { path: ['lens', 'diffusion', 'amt'], label: 'にじみ', hint: '絵全体にうっすら光がにじむ(やわらかいフィルターの感じ)', step: 0.01, fb: [0, 1], fmt: v => v.toFixed(2) },
  { path: ['lens', 'diffusion', 'sigma'], label: 'にじみの広さ', hint: 'にじみの広がり(1080p の高さでのピクセル)', step: 0.5, fb: [1, 60], fmt: v => `${v.toFixed(1)}px`, detail: true },
  { path: ['lens', 'bloom', 'amt'], label: '光のにじみ', hint: '明るい所から光があふれる(ブルーム)', step: 0.01, fb: [0, 1], fmt: v => v.toFixed(2) },
  { path: ['lens', 'bloom', 'thr'], label: '光り始める明るさ', hint: 'これより明るい所だけが光る', step: 0.01, fb: [0.3, 1], fmt: v => v.toFixed(2) },
  { path: ['lens', 'bloom', 'knee'], label: '光のなめらかさ', hint: '光り始めのなめらかさ(大きいほど、少し暗い所からなだらかに光る)', step: 0.01, fb: [0.01, 0.5], fmt: v => v.toFixed(2), detail: true },
  { path: ['lens', 'halation', 'amt'], label: 'ハレーション', hint: 'とても明るい所のまわりに赤いにじみ(フィルムの感じ)', step: 0.005, fb: [0, 0.5], fmt: v => v.toFixed(3) },
  { path: ['lens', 'halation', 'thr'], label: 'ハレの明るさ', hint: 'これより明るい所にハレーションが出る', step: 0.01, fb: [0.5, 1], fmt: v => v.toFixed(2), detail: true },
  { path: ['lens', 'halation', 'sigma'], label: 'ハレの広さ', hint: 'ハレーションの広がり(1080p の高さでのピクセル)', step: 0.5, fb: [1, 40], fmt: v => `${v.toFixed(1)}px`, detail: true },
  { path: ['lens', 'ca'], label: '色ずれ', hint: '画面の端ほど赤と青が少しずれる(1920 の幅でのピクセル)', step: 0.1, fb: [0, 8], fmt: v => `${v.toFixed(1)}px` },
  { path: ['lens', 'vignette'], label: '周辺減光', hint: '画面の四隅を暗く', step: 0.01, fb: [0, 1], fmt: v => v.toFixed(2) },
]
const GRAIN_ROWS: RowSpec[] = [
  { path: ['grain', 'amt'], label: '粒子の量', hint: 'フィルムの粒(書き出しでは最後に全体にも薄い粒子が入ります)', step: 0.001, fb: [0, 0.1], fmt: v => v.toFixed(3) },
  { path: ['grain', 'size'], label: '粒の大きさ', hint: '粒の大きさ(1080p の高さでのピクセル)', step: 0.1, fb: [0.5, 4], fmt: v => `${v.toFixed(1)}px` },
]
const BLEND_JA: Record<SatsueiPara['blend'], string> = { screen: '明るく(スクリーン)', multiply: '暗く(乗算)', normal: '色で覆う(通常)' }
const PARA_DIRS: { label: string; from: Vec2; to: Vec2 }[] = [
  { label: '上から', from: [0.5, 0], to: [0.5, 0.6] },
  { label: '下から', from: [0.5, 1], to: [0.5, 0.45] },
  { label: '左から', from: [0, 0.5], to: [0.6, 0.5] },
  { label: '右から', from: [1, 0.5], to: [0.4, 0.5] },
]
const KIND_JA: Record<SplitPick['kind'], string> = { hard: 'パッと替わる', bound: '下のクリップが替わる', dissolve: '溶けて替わる', wipe: '一部から替わる' }
const EASE_JA: [string, string][] = [['ease', 'なめらか'], ['linear', 'リニア'], ['ease-in', '遅→速'], ['ease-out', '速→遅']]

/** 自分のプリセットに入れる欄(ライトリークはクリップの時刻つきなので入れない) */
const lookOnly = (p: SatsueiParams): Obj => {
  const { leaks: _l, fit: _f, ...rest } = p
  return rest
}
const fmtStats = (s: SatsueiStats) => `暗部 ${s.y05.toFixed(2)}・中間 ${s.y50.toFixed(2)}・白 ${s.white.toFixed(1)}%`
const errText = (e: unknown, fb: string) => {
  const det = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  return typeof det === 'string' ? det : fb
}

// ── パネル ─────────────────────────────────────────────────────────────
export function SatsueiPanel({ clip, onClose }: Props) {
  const clips = useTimelineStore(s => s.clips)
  const tracks = useTimelineStore(s => s.tracks)
  const currentFrame = useTimelineStore(s => s.currentFrame)
  const P = satsueiOf(clip.attrs_json)
  const locked = !!clip.locked
  const cmp = useCompare()
  const [, setMetaTick] = useState(0)
  const [open, setOpen] = useState<Set<string>>(loadOpen)
  const [detail, setDetail] = useState(false)
  const [msg, setMsg] = useState('')
  const [busyLocal, setBusy] = useState<string | null>(null)
  // 分けて合わせる・置き換えて敷くの最中(パネルは作り直したクリップへ付け直しになるので、表示はパネルの外に持つ)
  const busyShared = useSyncExternalStore(subscribeSatsueiBusy, satsueiBusy)
  const busy = busyLocal ?? busyShared
  const [userPresets, setUserPresets] = useState<SatsueiUserPresets>({})
  const [presetSel, setPresetSel] = useState(() => (P.preset && satsueiPresets()[P.preset] ? P.preset : 'ba_sunny'))
  const [fitOnApply, setFitOnApply] = useState(true)
  const [saveName, setSaveName] = useState<string | null>(null)
  const [delAsk, setDelAsk] = useState(false)
  const [fitInfo, setFitInfo] = useState<{ before: SatsueiStats; after: SatsueiStats; frame: number } | null>(null)
  const [sections, setSections] = useState<Set<SatsueiSection>>(new Set(['color', 'lens', 'para', 'grain']))
  const [allAsk, setAllAsk] = useState(false)
  const [found, setFound] = useState<{ picks: SplitPick[]; on: boolean[] } | null>(null)
  const [splitFit, setSplitFit] = useState(true)
  const [layPreset, setLayPreset] = useState(() => (P.preset && satsueiPresets()[P.preset] ? P.preset : 'ba_sunny'))
  const [layFit, setLayFit] = useState(true)
  const [laySplit, setLaySplit] = useState(true)
  const [layReplace, setLayReplace] = useState(false)
  const [layAsk, setLayAsk] = useState(false)
  const [still, setStill] = useState<{ url: string; frame: number } | null>(null)
  const [stillErr, setStillErr] = useState(false)

  // プリセットの正(backend)と自分のプリセットを読む
  useEffect(() => {
    let live = true
    void loadSatsueiMeta().then(m => { if (live && m) setMetaTick(n => n + 1) })
    getSatsueiUserPresets().then(p => { if (live) setUserPresets(p) }).catch(() => { /* 無くてよい */ })
    return () => { live = false }
  }, [])
  // 閉じる・別のクリップへ移るときは待っている保存を送る
  useEffect(() => () => { void flushClipEdit(clip.id) }, [clip.id])
  useEffect(() => {
    if (compareResetTimer) { clearTimeout(compareResetTimer); compareResetTimer = null }
    return () => { compareResetTimer = setTimeout(() => setSatsueiCompare({ enabled: false, bypass: false }), 0) }
  }, [])

  const toggle = (id: string) => setOpen(s => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...n])) } catch { /* ignore */ }
    return n
  })

  const latest = () => useTimelineStore.getState().clips.find(c => c.id === clip.id) ?? clip
  // 生の attrs.satsuei を書き換える(すぐ反映・保存は後で)。key = つまみ(「元に戻す」はつまみごと。既定は label)
  const editS = (fn: (s: Obj) => Obj, label?: string, key?: string) => {
    if (locked) return
    editClipLive(clip.id, { attrs_json: withSatsuei(latest().attrs_json, fn) }, label, key ?? label)
  }
  const setP = (path: string[], v: unknown) => editS(s => setIn(s, path, v), undefined, path.join('.'))
  // パラ・ライトリークの並びは正規化した並び(壊れた項目を除いたもの。項目の知らない欄は残る)を書き換えて置く
  const editPara = (fn: (l: SatsueiPara[]) => SatsueiPara[], key: string) =>
    editS(s => ({ ...s, para: fn(normalizeSatsuei(s).para) }), undefined, 'para.' + key)
  const editLeaks = (fn: (l: SatsueiLeak[]) => SatsueiLeak[], label?: string, key?: string) =>
    editS(s => ({ ...s, leaks: fn(normalizeSatsuei(s).leaks) }), label, 'leaks.' + (key ?? label ?? ''))

  const rowOf = (r: RowSpec) => {
    const [lo, hi] = rng(r.path, r.fb)
    const v = Number(getIn(P, r.path) ?? 0)
    return <Row key={r.path.join('.')} label={r.label} hint={r.hint} v={v} d={Number(getIn(SATSUEI_DEFAULT, r.path) ?? 0)}
                min={lo} max={hi} step={r.step} fmt={r.fmt} ends={r.ends} disabled={locked}
                onChange={x => setP(r.path, r6(Math.max(lo, Math.min(hi, x))))} />
  }
  const rows = (list: RowSpec[]) => list.filter(r => detail || !r.detail).map(rowOf)

  // ── プリセット・自動で合わせる ─────────────────────────────────────
  const presetEntries = Object.entries(satsueiPresets())
  const presetOf = (sel: string): SatsueiParams | null => {
    if (sel.startsWith('user:')) {
      const n = sel.slice(5)
      return userPresets[n] ? normalizeSatsuei({ ...userPresets[n], preset: n }) : null
    }
    return presetParams(sel)
  }
  // プリセットで変える欄(ライトリークはクリップの時刻つきなので残す。粒子は自分のプリセットのときだけ)
  const presetSections = (sel: string): SatsueiSection[] => sel.startsWith('user:') ? ['color', 'lens', 'para', 'grain'] : ['color', 'lens', 'para']
  const applyPreset = async () => {
    const pp = presetOf(presetSel)
    if (!pp || locked) return
    setMsg(''); setFitInfo(null)
    const secs = presetSections(presetSel)
    if (!fitOnApply) {
      editS(s => copySections(s, { ...pp, fit: null }, secs), 'プリセットの適用')
      setMsg(`「${presetLabel(pp.preset)}」を当てました`)
      return
    }
    setBusy('プリセットを当てて明るさを合わせています…')
    try {
      await flushClipEdit(clip.id)
      const name = presetSel.startsWith('user:') ? presetSel.slice(5) : presetSel
      const res = await autofitSatsuei(clip.id, { preset: name })
      const fitted = normalizeSatsuei(res.params)
      const attrs_json = withSatsuei(latest().attrs_json, s => copySections(s, fitted, secs))
      await patchClipsUndoable([{ id: clip.id, after: { attrs_json } }], 'プリセットの適用')
      setFitInfo({ before: res.before, after: res.after, frame: res.frame })
      // 明るさの目標が無いプリセット(なし・自分で保存したもの)は、明るさを動かしていない
      const aimed = Array.isArray((fitted.fit as { target?: unknown } | null)?.target)
      setMsg(aimed ? `「${presetLabel(fitted.preset)}」を当てて、f${res.frame} の明るさに合わせました`
        : `「${presetLabel(fitted.preset)}」を当てました(このプリセットには明るさの目標が無いので、明るさはそのまま)`)
    } catch (e) {
      editS(s => copySections(s, { ...pp, fit: null }, secs), 'プリセットの適用')
      setMsg(`⚠ 明るさは合わせられませんでした(${errText(e, '下の絵を読めません')})。プリセットだけ当てました`)
    } finally { setBusy(null) }
  }
  const autoFit = async () => {
    if (locked) return
    setMsg(''); setBusy('明るさを合わせています…')
    try {
      await flushClipEdit(clip.id)
      const base = satsueiOf(latest().attrs_json)          // サーバーが読む、合わせる前の設定
      const res = await autofitSatsuei(clip.id, {})
      await flushClipEdit(clip.id)
      // 合わせて変わった所だけを書く(知らない欄は消さない: backend の正規化は中の知らない欄を落とす)
      const attrs_json = applyFitted(latest().attrs_json, base, res.params)
      await patchClipsUndoable([{ id: clip.id, after: { attrs_json } }], '自動で合わせる')
      setFitInfo({ before: res.before, after: res.after, frame: res.frame })
    } catch (e) {
      setMsg(`⚠ 合わせられませんでした: ${errText(e, '下の絵を読めません')}`)
    } finally { setBusy(null) }
  }
  const savePreset = async () => {
    const n = (saveName ?? '').trim()
    if (!n) return
    try {
      const next = await putSatsueiUserPresets({ ...userPresets, [n]: lookOnly(P) })
      setUserPresets(next); setSaveName(null); setPresetSel('user:' + n)
      setMsg(`「${n}」として保存しました(ライトリークは入りません)`)
    } catch (e) { setMsg(`⚠ 保存できませんでした: ${errText(e, '通信エラー')}`) }
  }
  const deletePreset = async () => {
    if (!presetSel.startsWith('user:')) return
    const n = presetSel.slice(5)
    const { [n]: _gone, ...rest } = userPresets
    try {
      setUserPresets(await putSatsueiUserPresets(rest)); setPresetSel('ba_sunny'); setDelAsk(false)
      setMsg(`「${n}」を消しました`)
    } catch (e) { setMsg(`⚠ 消せませんでした: ${errText(e, '通信エラー')}`) }
  }

  // ── このトラックの撮影クリップ ───────────────────────────────────
  const trackClips = useMemo(() => clips.filter(c => c.track_id === clip.track_id && c.kind === 'satsuei')
    .sort((a, b) => a.start_frame - b.start_frame || a.id - b.id), [clips, clip.track_id])
  const prevOverlap = useMemo(() => {
    let best = 0
    for (const c of trackClips) {
      if (c.id === clip.id || c.start_frame > clip.start_frame || (c.start_frame === clip.start_frame && c.id > clip.id)) continue
      best = Math.max(best, Math.min(c.start_frame + c.duration_frames, clip.start_frame + clip.duration_frames) - clip.start_frame)
    }
    return best
  }, [trackClips, clip.id, clip.start_frame, clip.duration_frames])

  // ── 比べる・書き出しと同じ絵 ─────────────────────────────────────
  const clipEnd = clip.start_frame + clip.duration_frames - 1
  const hereFrame = Math.max(clip.start_frame, Math.min(clipEnd, currentFrame))
  const showStill = async () => {
    await flushClipEdit(clip.id)
    setStillErr(false)
    setStill({ url: satsueiStillUrl(clip.id, hereFrame, 1280), frame: hereFrame })
  }
  const glProblem = satsueiGLProblem()

  // ── コピー・貼り付け・このトラックの全部へ ─────────────────────────
  const secList = (['color', 'lens', 'para', 'leaks', 'grain'] as SatsueiSection[]).filter(k => sections.has(k))
  const copyNow = () => {
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(P)); setMsg('この撮影の設定をコピーしました') }
    catch { setMsg('⚠ コピーできませんでした(この端末の保存が使えません)') }
  }
  const pasteNow = () => {
    let src: Obj | null = null
    try { src = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null') } catch { src = null }
    if (!src || typeof src !== 'object') { setMsg('コピーした設定がありません'); return }
    if (!secList.length) { setMsg('写す欄を選んでください'); return }
    const n = normalizeSatsuei(src)
    editS(s => copySections(s, n, secList), '撮影の貼り付け')
    setMsg(`${secList.map(k => SECTION_LABEL[k]).join('・')}を貼り付けました`)
  }
  const others = trackClips.filter(c => c.id !== clip.id && !c.locked)
  const applyAll = async () => {
    setAllAsk(false)
    if (!secList.length || !others.length) return
    setBusy('ほかの撮影クリップへ写しています…')
    try {
      await flushClipEdit(clip.id)
      const src = satsueiOf(latest().attrs_json)
      const n = await patchClipsUndoable(others.map(c => ({
        id: c.id, after: { attrs_json: withSatsuei(c.attrs_json, s => copySections(s, src, secList)) },
      })), '撮影をトラックの全部へ')
      setMsg(`${n} 本の撮影へ ${secList.map(k => SECTION_LABEL[k]).join('・')}を写しました(元に戻すで 1 回で戻せます)`)
    } catch (e) { setMsg(`⚠ 途中で失敗しました: ${errText(e, '通信エラー')}`) }
    finally { setBusy(null) }
  }

  // ── ✂ 境目で分ける ───────────────────────────────────────────────
  const findBounds = async () => {
    setMsg(''); setFound(null); setBusy('境目を探しています…(下の絵を読みます)')
    try {
      await flushClipEdit(clip.id)
      const r = await detectSatsuei({ track_id: clip.track_id, start_frame: clip.start_frame, duration_frames: clip.duration_frames })
      const picks: SplitPick[] = r.clip_bounds.map(at => ({ kind: 'bound' as const, at }))
      for (const t of r.transitions) {
        if (t.kind === 'hard') {
          if (!picks.some(p => p.kind === 'bound' && Math.abs((p.at ?? 0) - t.at) <= 1)) picks.push({ kind: 'hard', at: t.at })
        } else picks.push({ kind: t.kind, t0: t.t0, t1: t.t1 })
      }
      picks.sort((a, b) => pickAt(a) - pickAt(b))
      setFound({ picks, on: picks.map(() => true) })
      if (!picks.length) setMsg('このクリップの下の絵には境目が見つかりませんでした')
    } catch (e) { setMsg(`⚠ 探せませんでした: ${errText(e, '下の絵を読めません')}`) }
    finally { setBusy(null) }
  }
  const doSplit = async () => {
    if (!found || locked) return
    const cur = latest()
    const { segs, skipped } = splitSegments(cur.start_frame, cur.start_frame + cur.duration_frames, found.picks.filter((_, i) => found.on[i]))
    if (segs.length < 2) { setMsg('分けられる境目がありません(端に近すぎる・ほかの境目に近すぎる境目は使いません)'); return }
    // 分けるとこのクリップは消えてパネルは分けた 1 本へ付け直しになるので、途中の表示と結果はパネルの外(共通の表示・トースト)へ
    setSatsueiBusy(splitFit ? `${segs.length} 本に分けて、それぞれ明るさを合わせています…` : `${segs.length} 本に分けています…`)
    try {
      const datas: ClipCreate[] = segs.map((g, i) => {
        const carry = filterCarry(cur, g.start - cur.start_frame, g.end - g.start)
        const tr = i === 0 ? {}
          : g.tf > 0 ? { transition_in: 'cross' as TransitionType, transition_frames: g.tf, transition_ease: 'ease' }
          : { transition_in: '' as TransitionType, transition_frames: 0, transition_ease: 'linear' }
        return { track_id: cur.track_id, asset_id: null, start_frame: g.start, duration_frames: g.end - g.start, asset_in_frame: 0, ...carry, ...tr }
      })
      // 手元を置き換えたらすぐ、再生位置にかかる 1 本を選ぶ(パネルが閉じないように)
      const pickHere = (ms: Clip[]) => {
        const f = useTimelineStore.getState().currentFrame
        const here = [...ms].reverse().find(c => c.start_frame <= f && f < c.start_frame + c.duration_frames) ?? ms[0]
        if (here) useTimelineStore.getState().setSelectedClipId(here.id)
      }
      const made = await replaceClips([cur], datas, '撮影を境目で分ける', splitFit ? async ms => {
        const out: Clip[] = []
        for (const c of ms) { try { out.push((await autofitAndSave(c)).clip) } catch { out.push(c) } }
        return out
      } : undefined, pickHere)
      setFound(null)
      const done = `✂ 撮影を ${made.length} 本に分けました${splitFit ? '(それぞれ明るさを合わせました)' : ''}`
        + `${skipped.length ? `。近すぎる境目 ${skipped.length} 個は使いませんでした` : ''}(元に戻すで 1 回で戻せます)`
      setMsg(done)
      useUIStore.getState().pushToast(done, 'success')
    } catch (e) {
      const m = `⚠ 分けられませんでした: ${errText(e, '通信エラー')}`
      setMsg(m)
      useUIStore.getState().pushToast(m, 'error')
    } finally { setSatsueiBusy(null) }
  }

  // ── 🎬 全カットに敷く ────────────────────────────────────────────
  const doLay = async () => {
    setLayAsk(false); setMsg('')
    // 置き換えるとこのクリップも消えてパネルは付け直しになるので、途中の表示と結果はパネルの外(共通の表示・トースト)へ
    setSatsueiBusy(layFit ? '全カットに敷いて、それぞれ明るさを合わせています…(カットの数によって数十秒)' : '全カットに敷いています…')
    try {
      await flushAllClipEdits()
      const r = await laySatsuei({ track_id: clip.track_id, preset: layPreset, auto_fit: layFit, split: laySplit, replace: layReplace })
      adoptServerReplace('撮影を全カットに敷く', r.deleted, r.created)
      // このクリップが置き換えで消えたら、再生位置にかかる新しい 1 本を選ぶ(パネルが閉じないように)
      if (r.deleted.includes(clip.id)) {
        const f = useTimelineStore.getState().currentFrame
        const here = r.created.find(c => c.start_frame <= f && f < c.start_frame + c.duration_frames) ?? r.created[0]
        useTimelineStore.getState().setSelectedClipId(here ? here.id : null)
      }
      const done = r.created.length
        ? `🎬 撮影を ${r.created.length} 本敷きました${r.deleted.length ? `(前の ${r.deleted.length} 本と置き換え)` : ''}(元に戻すで 1 回で戻せます)`
        : 'すでに撮影のある所は飛ばしたので、新しく敷く所がありませんでした(置き換えるなら「今ある撮影を置き換える」を入れる)'
      setMsg(done)
      useUIStore.getState().pushToast(done, r.created.length ? 'success' : 'info')
    } catch (e) {
      const m = `⚠ 敷けませんでした: ${errText(e, '通信エラー')}`
      setMsg(m)
      useUIStore.getState().pushToast(m, 'error')
    } finally { setSatsueiBusy(null) }
  }

  // ── 表示 ─────────────────────────────────────────────────────────
  const C = P.color
  const opacity = clip.opacity ?? 1
  const relNow = currentFrame - clip.start_frame
  const leakEnd = (L: SatsueiLeak) => L.t0 + L.attack + L.hold + L.release
  // ライトリークの時間・大きさのつまみの範囲(backend の範囲。ずれていると、つまみに触れただけで長い光が縮む)
  const leakR = {
    attack: rng(['leaks', 'attack'], [1, 240]), hold: rng(['leaks', 'hold'], [0, 2400]),
    release: rng(['leaks', 'release'], [1, 480]), size: rng(['leaks', 'size'], [0.02, 2]),
  }
  const changedIn = (k: 'color' | 'lens' | 'grain') => JSON.stringify(P[k]) !== JSON.stringify(SATSUEI_DEFAULT[k])
  const dis = locked || !!busy
  const keyCount = (() => {
    try { const a = rawSatsuei(clip.attrs_json).attrs.strength_keys; return Array.isArray(a) ? a.length : 0 } catch { return 0 }
  })()
  const trackName = tracks.find(t => t.id === clip.track_id)?.name ?? ''

  return createPortal(
    <div className="fixed right-3 bottom-3 w-[360px] max-w-[calc(100vw-1.5rem)] max-h-[85dvh] overflow-y-auto overscroll-contain rounded-lg border border-amber-800 bg-zinc-900/95 shadow-2xl backdrop-blur p-3 z-[110] text-zinc-200"
         onKeyDown={e => e.stopPropagation()} data-satsuei-panel={clip.id}>
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-[11px] font-semibold text-amber-200 truncate">
          🎬 撮影 {presetLabel(P.preset) || '(手で調整)'}<span className="text-zinc-500 font-normal"> f{clip.start_frame}〜{clipEnd}・{trackName}</span>
        </span>
        <button onClick={() => { void flushClipEdit(clip.id); onClose() }} className="text-zinc-500 hover:text-zinc-200 text-xs leading-none">✕</button>
      </div>
      <p className="text-[9px] text-zinc-500 mb-1.5 leading-tight">
        下の絵(Shots など)に色・光・レンズ・粒子をかけます。つまみはすぐプレビューに出て、自動で保存されます(元に戻すで 1 操作ずつ戻せます)。
      </p>
      {locked && <p className="text-[10px] text-amber-400 mb-1">🔒 ロック中は変えられません</p>}

      {/* 全体の効き = クリップの不透明度(時間で変えるのは 🎚 のキー) */}
      <div className="flex items-center gap-2 mb-1" title="撮影全体の効き(クリップの不透明度)。時間で変えるときは 🎚 効きのキー">
        <span className="text-[10px] font-semibold text-zinc-200 w-[5.5rem] flex-shrink-0">全体の効き</span>
        <input type="range" min={0} max={100} step={1} value={Math.round(opacity * 100)} disabled={locked}
               onChange={e => editClipLive(clip.id, { opacity: Number(e.target.value) / 100 }, '撮影の効き')}
               className="flex-1 min-w-0 h-1 accent-amber-400 disabled:opacity-40" />
        <span className="text-[10px] w-9 text-right tabular-nums text-zinc-300">{Math.round(opacity * 100)}%</span>
        <button className={btn} title="効きを時間で変える(キーの編集)"
                onClick={() => window.dispatchEvent(new CustomEvent('kychapogas:open-filter', { detail: { clipId: clip.id } }))}>
          🎚{keyCount ? ` ${keyCount}` : ''}
        </button>
      </div>

      <Section title="プリセット・自動で合わせる" open={open.has('preset')} onToggle={() => toggle('preset')}>
        <div className="flex items-center gap-1.5 mb-1">
          <select value={presetSel} onChange={e => { setPresetSel(e.target.value); setDelAsk(false) }} className={`${inputCls} flex-1 min-w-0`}>
            <optgroup label="最初からある">
              {presetEntries.map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
            </optgroup>
            {Object.keys(userPresets).length > 0 && (
              <optgroup label="自分で保存した">
                {Object.keys(userPresets).map(k => <option key={k} value={'user:' + k}>{k}</option>)}
              </optgroup>
            )}
          </select>
          <button className={btnHot} disabled={dis} onClick={() => { void applyPreset() }}
                  title="選んだプリセットの色・レンズ・パラを当てる(ライトリークはそのまま)">適用</button>
          {presetSel.startsWith('user:') && (delAsk
            ? <button className={btn + ' text-red-300'} onClick={() => { void deletePreset() }}>消す?</button>
            : <button className={btn} onClick={() => setDelAsk(true)} title="この自分のプリセットを消す">✕</button>)}
        </div>
        <div className="flex items-center gap-2 mb-1.5">
          <Check label="当てたら明るさも合わせる" on={fitOnApply} onChange={setFitOnApply}
                 hint="プリセットを当てたあと、このカットの絵に合わせて黒の持ち上げ・中間の明るさを自動で動かす" />
          {saveName == null
            ? <button className={btn + ' ml-auto'} disabled={dis} onClick={() => setSaveName('')} title="今の色・レンズ・パラ・粒子を自分のプリセットとして保存">今の設定を保存</button>
            : (
              <span className="ml-auto flex items-center gap-1">
                <input autoFocus value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="名前"
                       onKeyDown={e => { if (e.key === 'Enter') void savePreset(); if (e.key === 'Escape') setSaveName(null) }}
                       className={`${inputCls} w-24`} />
                <button className={btn} disabled={!saveName.trim()} onClick={() => { void savePreset() }}>保存</button>
                <button className={btn} onClick={() => setSaveName(null)}>やめる</button>
              </span>
            )}
        </div>
        <div className="flex items-center gap-2">
          <button className={btn} disabled={dis} onClick={() => { void autoFit() }}
                  title="このクリップのまん中のコマを測り、プリセットの目標の明るさに近づくよう黒の持ち上げ・中間の明るさ(と光の強さ)を合わせる">
            ☀ 自動で合わせる
          </button>
          {fitInfo && (
            <span className="text-[9px] text-zinc-400 leading-tight">
              f{fitInfo.frame}: {fmtStats(fitInfo.before)}<br />→ {fmtStats(fitInfo.after)}
            </span>
          )}
        </div>
      </Section>

      <Section title="色" open={open.has('color')} onToggle={() => toggle('color')} badge={changedIn('color') ? '調整あり' : undefined}>
        {rows(COLOR_ROWS)}
        <TintRow label="影の色" hint="暗い所に足す色(色相と量)。明るさは変わりません" value={C.shadow_tint} disabled={locked}
                 onChange={t => setP(['color', 'shadow_tint'], t)} />
        <TintRow label="ハイライトの色" hint="明るい所に足す色(色相と量)。明るさは変わりません" value={C.highlight_tint} disabled={locked}
                 onChange={t => setP(['color', 'highlight_tint'], t)} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
          <Check label="空の色を守る" hint="空の青(色相 190〜230°)は彩度を変えない" on={C.protect_sky} disabled={locked}
                 onChange={v => setP(['color', 'protect_sky'], v)} />
          <Check label="肌と髪の色を守る" hint="肌・赤い髪(色相 330〜30°)は彩度を変えない" on={C.protect_skin} disabled={locked}
                 onChange={v => setP(['color', 'protect_skin'], v)} />
        </div>
        {(C.protect_sky || C.protect_skin) && detail && rowOf({ path: ['color', 'protect'], label: '守る強さ', hint: '色を守る強さ(1 = 彩度をまったく変えない)', step: 0.05, fb: [0, 1], fmt: v => v.toFixed(2) })}
      </Section>

      <Section title="レンズ" open={open.has('lens')} onToggle={() => toggle('lens')} badge={changedIn('lens') ? '調整あり' : undefined}>
        {rows(LENS_ROWS)}
      </Section>

      <Section title={`パラ(光や影のグラデーション)`} open={open.has('para')} onToggle={() => toggle('para')}
               badge={P.para.length ? `${P.para.length} 本` : undefined}>
        {P.para.map((q, i) => (
          <div key={i} className="border border-zinc-800 rounded p-1.5 mb-1.5">
            <div className="flex gap-2">
              <PointPad disabled={locked}
                        points={[{ p: q.from, fill: q.color, label: '濃い側(ここから)' }, { p: q.to, fill: '#18181b', label: '消える側(ここまで)' }]}
                        onMove={(k, p) => editPara(l => l.map((x, j) => j === i ? { ...x, [k === 0 ? 'from' : 'to']: p } : x), `${i}.pos`)} />
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-zinc-400">パラ {i + 1}</span>
                  <input type="color" value={q.color} disabled={locked}
                         onChange={e => { const c = e.target.value; editPara(l => l.map((x, j) => j === i ? { ...x, color: c } : x), `${i}.color`) }}
                         className="w-6 h-5 bg-transparent border border-zinc-700 rounded cursor-pointer" />
                  <button className={btn + ' ml-auto text-red-300'} disabled={locked}
                          onClick={() => editPara(l => l.filter((_, j) => j !== i), 'del')}>削除</button>
                </div>
                <select value={q.blend} disabled={locked}
                        onChange={e => { const b = e.target.value as SatsueiPara['blend']; editPara(l => l.map((x, j) => j === i ? { ...x, blend: b } : x), `${i}.blend`) }}
                        className={inputCls}>
                  {(Object.keys(BLEND_JA) as SatsueiPara['blend'][]).map(b => <option key={b} value={b}>{BLEND_JA[b]}</option>)}
                </select>
                <div className="flex flex-wrap gap-0.5">
                  {PARA_DIRS.map(d => (
                    <button key={d.label} className={btn + ' px-1'} disabled={locked}
                            onClick={() => editPara(l => l.map((x, j) => j === i ? { ...x, from: d.from, to: d.to } : x), `${i}.pos`)}>{d.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <Row label="量" hint="パラの濃さ" v={q.amt} d={0} min={0} max={1} step={0.01} fmt={v => v.toFixed(2)} disabled={locked}
                 onChange={v => editPara(l => l.map((x, j) => j === i ? { ...x, amt: r6(v) } : x), `${i}.amt`)} />
          </div>
        ))}
        <button className={btn} disabled={locked || P.para.length >= MAX_PARA}
                onClick={() => editPara(l => [...l, { ...PARA_DEFAULT, from: [...PARA_DEFAULT.from], to: [...PARA_DEFAULT.to] }], 'add')}>
          ＋ パラを足す{P.para.length >= MAX_PARA ? `(${MAX_PARA} 本まで)` : ''}
        </button>
        <p className="text-[9px] text-zinc-600 mt-1 leading-tight">●(濃い側)から ○(消える側)へ薄くなります。見取り図の点をドラッグで動かせます(枠が画面)。</p>
      </Section>

      <Section title="ライトリーク(差し込む光)" open={open.has('leaks')} onToggle={() => toggle('leaks')}
               badge={P.leaks.length ? `${P.leaks.length} 個` : undefined}>
        {P.leaks.map((L, i) => {
          const path = L.path.length ? L.path : LEAK_DEFAULT.path
          const last = path[path.length - 1]
          const shown = path.length > 1 ? path : [path[0], path[0]]
          const live = relNow >= L.t0 && relNow <= leakEnd(L)
          const setLeak = (patch: Partial<SatsueiLeak>) =>
            editLeaks(l => l.map((x, j) => j === i ? { ...x, ...patch } : x), undefined, `${i}.${Object.keys(patch).join(',')}`)
          return (
            <div key={i} className={`border rounded p-1.5 mb-1.5 ${live ? 'border-amber-700' : 'border-zinc-800'}`}>
              <div className="flex gap-2">
                <PointPad disabled={locked} ellipse={{ c: path[0], r: L.size, color: L.color }}
                          points={shown.map((p, k) => ({ p, fill: k === 0 ? L.color : '#18181b', label: k === 0 ? '光の始まりの位置' : k === shown.length - 1 ? '光の終わりの位置' : '途中の位置' }))}
                          onMove={(k, p) => {
                            const np = path.length > 1 ? path.map((q, j) => (j === k ? p : q)) : k === 0 ? [p] : [path[0], p]
                            setLeak({ path: np })
                          }} />
                <div className="flex-1 min-w-0 flex flex-col gap-1 text-[10px] text-zinc-400">
                  <div className="flex items-center gap-1">
                    <span>光 {i + 1}</span>
                    <input type="color" value={L.color} disabled={locked} onChange={e => setLeak({ color: e.target.value })}
                           className="w-6 h-5 bg-transparent border border-zinc-700 rounded cursor-pointer" />
                    <button className={btn + ' ml-auto text-red-300'} disabled={locked} onClick={() => editLeaks(l => l.filter((_, j) => j !== i), 'ライトリークを消す')}>削除</button>
                  </div>
                  <div className="flex items-center gap-1">
                    <span>始まり</span>
                    <input type="number" value={L.t0} disabled={locked}
                           onChange={e => setLeak({ t0: Math.round(Number(e.target.value) || 0) })} className={`${inputCls} w-14`} />
                    <span className="text-zinc-600">f{clip.start_frame + L.t0}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button className={btn + ' px-1'} onClick={() => useTimelineStore.getState().setCurrentFrame(Math.max(0, clip.start_frame + L.t0))} title="この光の始まりへ再生位置を動かす">▶ 始まりへ</button>
                    <button className={btn + ' px-1'} disabled={locked || relNow < 0 || relNow >= clip.duration_frames}
                            onClick={() => setLeak({ t0: relNow })} title="再生位置から光り始める">◆ 再生位置から</button>
                  </div>
                </div>
              </div>
              <Row label="量" hint="光の強さ" v={L.amt} d={0} min={0} max={1} step={0.01} fmt={v => v.toFixed(2)} disabled={locked} onChange={v => setLeak({ amt: r6(v) })} />
              <Row label="立ち上がり" hint="光りきるまでのコマ数" v={L.attack} d={LEAK_DEFAULT.attack} min={leakR.attack[0]} max={leakR.attack[1]} step={1} fmt={v => `${v}コマ`} disabled={locked} onChange={v => setLeak({ attack: v })} />
              <Row label="保持" hint="光りきったままのコマ数" v={L.hold} d={LEAK_DEFAULT.hold} min={leakR.hold[0]} max={leakR.hold[1]} step={1} fmt={v => `${v}コマ`} disabled={locked} onChange={v => setLeak({ hold: v })} />
              <Row label="戻り" hint="消えるまでのコマ数" v={L.release} d={LEAK_DEFAULT.release} min={leakR.release[0]} max={leakR.release[1]} step={1} fmt={v => `${v}コマ`} disabled={locked} onChange={v => setLeak({ release: v })} />
              <Row label="大きさ(横)" hint="光の広がり(画面の幅に対する割合)" v={L.size[0]} d={LEAK_DEFAULT.size[0]} min={leakR.size[0]} max={leakR.size[1]} step={0.01} fmt={v => v.toFixed(2)} disabled={locked} onChange={v => setLeak({ size: [r6(v), L.size[1]] })} />
              <Row label="大きさ(縦)" hint="光の広がり(画面の高さに対する割合)" v={L.size[1]} d={LEAK_DEFAULT.size[1]} min={leakR.size[0]} max={leakR.size[1]} step={0.01} fmt={v => v.toFixed(2)} disabled={locked} onChange={v => setLeak({ size: [L.size[0], r6(v)] })} />
              <p className="text-[9px] text-zinc-600 leading-tight">
                f{clip.start_frame + L.t0}〜f{clip.start_frame + leakEnd(L)} に光ります。{path.length > 1 ? `始点(${path[0].join(', ')})→ 終点(${last.join(', ')})へ動きます。` : '○ をドラッグすると動く光になります。'}
              </p>
            </div>
          )
        })}
        <button className={btn} disabled={locked || P.leaks.length >= MAX_LEAKS || relNow < 0 || relNow >= clip.duration_frames}
                title="再生位置から光り始めるライトリークを足す"
                onClick={() => editLeaks(l => [...l, { ...LEAK_DEFAULT, t0: Math.max(0, relNow), path: LEAK_DEFAULT.path.map(p => [...p] as Vec2), size: [...LEAK_DEFAULT.size] as Vec2 }], 'ライトリークを足す')}>
          ＋ 再生位置に追加{P.leaks.length >= MAX_LEAKS ? `(${MAX_LEAKS} 個まで)` : ''}
        </button>
      </Section>

      <Section title="粒子" open={open.has('grain')} onToggle={() => toggle('grain')} badge={changedIn('grain') ? '調整あり' : undefined}>
        {rows(GRAIN_ROWS)}
      </Section>

      {(prevOverlap > 0 || clip.transition_in) && (
        <Section title="前の撮影からの切り替わり" open={open.has('trans')} onToggle={() => toggle('trans')}
                 badge={clip.transition_in ? `溶け ${clip.transition_frames}コマ` : undefined}>
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
            <Check label="溶けて替わる" on={!!clip.transition_in} disabled={locked}
                   hint="前の撮影クリップと重なっている間、前の撮影からこの撮影へ少しずつ替える(切ると、重なりの頭からこの撮影だけ)"
                   onChange={v => editClipLive(clip.id, v
                     ? { transition_in: 'cross', transition_frames: Math.max(1, clip.transition_frames || prevOverlap), transition_ease: clip.transition_ease || 'ease' }
                     : { transition_in: '', transition_frames: 0 }, '撮影の切り替わり')} />
            {clip.transition_in && (
              <>
                <input type="number" min={1} value={clip.transition_frames} disabled={locked}
                       onChange={e => editClipLive(clip.id, { transition_frames: Math.max(1, Math.round(Number(e.target.value) || 1)) }, '撮影の切り替わり')}
                       className={`${inputCls} w-12`} />
                <span>コマ</span>
                <select value={clip.transition_ease || 'linear'} disabled={locked}
                        onChange={e => editClipLive(clip.id, { transition_ease: e.target.value }, '撮影の切り替わり')} className={inputCls}>
                  {EASE_JA.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </>
            )}
          </div>
          <p className="text-[9px] text-zinc-600 mt-1 leading-tight">
            前の撮影との重なり: {prevOverlap} コマ。{clip.transition_in && clip.transition_frames > prevOverlap ? '溶けは重なりの中だけで効きます。' : ''}
          </p>
        </Section>
      )}

      <Section title="比べる" open={open.has('compare')} onToggle={() => toggle('compare')}
               badge={cmp.bypass ? '撮影を止め中' : cmp.enabled ? '左右で比べ中' : undefined}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Check label="左右で比べる(左 = 前・右 = 後)" on={cmp.enabled} onChange={v => setSatsueiCompare({ enabled: v, bypass: false })}
                 hint="プレビューの左側を撮影なし、右側を撮影ありで並べて見る" />
          <Check label="撮影を止める" on={cmp.bypass} onChange={v => setSatsueiCompare({ bypass: v })}
                 hint="プレビューで撮影クリップを全部止めて、素の絵を見る(書き出しには関係ありません)" />
        </div>
        {cmp.enabled && (
          <Row label="境目の位置" hint="左右の境目(撮影がかかる範囲の幅に対する割合。⇔ 比較表示ではその枠の中)" v={cmp.split} d={0.5} min={0} max={1} step={0.01}
               fmt={v => `${Math.round(v * 100)}%`} onChange={v => setSatsueiCompare({ split: v })} />
        )}
        <div className="flex items-center gap-2 mt-1">
          <button className={btn} disabled={!!busy} onClick={() => { void showStill() }}
                  title="このコマを、書き出しと同じ計算(サーバーの Python)で描いた絵で見る">🖼 書き出しと同じ絵で見る(f{hereFrame})</button>
        </div>
        {glProblem && (
          <p className="text-[10px] text-amber-300 mt-1 leading-tight">
            この端末ではプレビューに撮影が出ません({glProblem})。「書き出しと同じ絵で見る」で確かめてください。
          </p>
        )}
      </Section>

      <Section title="設定のコピー・ほかの撮影へ" open={open.has('copy')} onToggle={() => toggle('copy')}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mb-1">
          {(Object.keys(SECTION_LABEL) as SatsueiSection[]).map(k => (
            <Check key={k} label={SECTION_LABEL[k]} on={sections.has(k)}
                   onChange={v => setSections(s => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n })} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button className={btn} onClick={copyNow} title="この撮影の設定を全部コピー(この端末に覚える)">コピー</button>
          <button className={btn} disabled={dis} onClick={pasteNow} title="コピーした設定のうち、選んだ欄だけをこの撮影に貼る">貼り付け</button>
          {allAsk
            ? (
              <span className="flex items-center gap-1 text-[10px] text-amber-300">
                {others.length} 本へ写す?
                <button className={btnHot} onClick={() => { void applyAll() }}>はい</button>
                <button className={btn} onClick={() => setAllAsk(false)}>やめる</button>
              </span>
            )
            : <button className={btn} disabled={dis || !others.length || !secList.length} onClick={() => setAllAsk(true)}
                      title="この撮影の選んだ欄を、同じトラックのほかの撮影クリップ全部へ写す(🔒ロック中は飛ばす)">
                このトラックの全部の撮影へ({others.length} 本)
              </button>}
        </div>
        <p className="text-[9px] text-zinc-600 mt-1 leading-tight">色を写すと、カットごとに合わせた明るさも同じになります(写したあと各カットで「自動で合わせる」)。</p>
      </Section>

      <Section title="✂ 境目で分ける" open={open.has('split')} onToggle={() => toggle('split')}
               badge={found ? `候補 ${found.picks.length}` : undefined}>
        <p className="text-[9px] text-zinc-500 mb-1 leading-tight">
          生成の 1 本の中でカットが替わる所(パッと・溶けて)と、下のクリップの替わり目を探して、この撮影をカットごとに分けます。
          溶けて替わる所は前後を重ねて、撮影も溶けて替わるようにします。
        </p>
        <div className="flex items-center gap-2 mb-1">
          <button className={btn} disabled={dis} onClick={() => { void findBounds() }}>🔍 境目を探す</button>
          <Check label="分けたら、それぞれ明るさを合わせる" on={splitFit} onChange={setSplitFit} />
        </div>
        {found && found.picks.length > 0 && (
          <div className="flex flex-col gap-0.5 mb-1">
            {found.picks.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px] text-zinc-300">
                <input type="checkbox" checked={found.on[i]} className="accent-amber-500 w-3 h-3"
                       onChange={e => { const on = [...found.on]; on[i] = e.target.checked; setFound({ ...found, on }) }} />
                <span className="w-[7.5rem] flex-shrink-0">{KIND_JA[p.kind]}</span>
                <span className="tabular-nums text-zinc-400">
                  {p.kind === 'hard' || p.kind === 'bound' ? `f${p.at}` : `f${p.t0}〜f${p.t1}(${(p.t1 ?? 0) - (p.t0 ?? 0) + 1}コマ)`}
                </span>
                <button className={btn + ' px-1 ml-auto'} onClick={() => useTimelineStore.getState().setCurrentFrame(pickAt(p))} title="ここへ再生位置を動かす">▶</button>
              </div>
            ))}
            <button className={btnHot + ' mt-1 self-start'} disabled={dis || !found.on.some(Boolean)} onClick={() => { void doSplit() }}>
              ✂ 選んだ境目で分ける
            </button>
          </div>
        )}
      </Section>

      <Section title="🎬 全カットに敷く" open={open.has('lay')} onToggle={() => toggle('lay')}>
        <p className="text-[9px] text-zinc-500 mb-1 leading-tight">
          このトラックに、下の絵のクリップ 1 本ごとに撮影クリップを敷きます(生成の中の切り替わりでも分けます)。すでに撮影のある所は飛ばします。
        </p>
        <div className="flex items-center gap-1.5 mb-1">
          <select value={layPreset} onChange={e => setLayPreset(e.target.value)} className={`${inputCls} flex-1 min-w-0`}>
            {presetEntries.map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
            {Object.keys(userPresets).map(k => <option key={'u' + k} value={k}>{k}(自分の)</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1">
          <Check label="明るさを合わせる" on={layFit} onChange={setLayFit} hint="カットごとに、まん中のコマで黒の持ち上げ・中間の明るさを合わせる" />
          <Check label="切り替わりで分ける" on={laySplit} onChange={setLaySplit} hint="生成の 1 本の中でカットが替わる所でも分ける" />
          <Check label="今ある撮影を置き換える" on={layReplace} onChange={setLayReplace} hint="このトラックの撮影クリップを消してから敷く(🔒ロック中は残す)" />
        </div>
        {layAsk
          ? (
            <span className="flex items-center gap-1 text-[10px] text-amber-300">
              {layReplace ? `今ある撮影 ${trackClips.filter(c => !c.locked).length} 本を置き換えます。よい?` : '全カットに敷きます。よい?'}
              <button className={btnHot} onClick={() => { void doLay() }}>はい</button>
              <button className={btn} onClick={() => setLayAsk(false)}>やめる</button>
            </span>
          )
          : <button className={btnHot} disabled={!!busy} onClick={() => setLayAsk(true)}>🎬 全カットに敷く</button>}
      </Section>

      <div className="flex items-center gap-2 mt-2 border-t border-zinc-800 pt-1.5">
        <Check label="細かい設定も出す" on={detail} onChange={setDetail} />
        {busy && <span className="ml-auto text-[10px] text-amber-300 animate-pulse">{busy}</span>}
      </div>
      {msg && <p className="text-[10px] text-zinc-300 mt-1 leading-tight">{msg}</p>}

      {still && createPortal(
        <div className="fixed inset-0 z-[120] flex flex-col items-center justify-center bg-black/85 p-3" onClick={() => setStill(null)}>
          {stillErr
            ? <p className="text-sm text-amber-300">絵を作れませんでした(下の絵が読めないなど)</p>
            : <img src={still.url} onError={() => setStillErr(true)} alt="書き出しと同じ絵"
                   className="max-w-[96vw] max-h-[84vh] object-contain border border-zinc-700 rounded" />}
          <p className="text-[11px] text-zinc-300 mt-2 text-center leading-tight">
            f{still.frame}: 書き出しと同じ計算(サーバー)で描いた絵。下の絵は Shots などの素材だけで、テロップ・雨・ほかの撮影クリップ・書き出しの最後の粒子は入りません。<br />
            <span className="text-zinc-500">クリックで閉じる</span>
          </p>
        </div>,
        document.body,
      )}
    </div>,
    document.body,
  )
}
