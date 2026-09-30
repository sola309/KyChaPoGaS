import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Clip } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { useUIStore } from '../../store/uiStore'
import {
  type FKey, type FilterKind, type PresetId, BLUR_DEFAULT, BLUR_MAX,
  getKeys, keyValueAt, defaultValue, valueRange, withKeys, solidColor, parseFilterAttrs,
  presetKeys, rescaleKeys, fmtTc, parseTc, isFilterClip,
} from './filterLayers'

const inputCls = 'bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500'
const chipCls = (on: boolean) => `text-[10px] px-2 py-1 rounded ${on ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`

/** タイムコード入力(MM:SS:FF / フレーム数)。確定(Enter/blur)で onCommit */
function TcInput({ frame, fps, onCommit, className }: { frame: number; fps: number; onCommit: (f: number) => void; className?: string }) {
  const [txt, setTxt] = useState(fmtTc(frame, fps))
  useEffect(() => { setTxt(fmtTc(frame, fps)) }, [frame, fps])
  const commit = () => {
    const f = parseTc(txt, fps)
    if (f == null) { setTxt(fmtTc(frame, fps)); return }
    if (f !== frame) onCommit(f)
  }
  return (
    <input value={txt} onChange={e => setTxt(e.target.value)} onBlur={commit}
           onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
           className={`${inputCls} font-mono w-24 ${className ?? ''}`} title="MM:SS:FF またはフレーム数" />
  )
}

// ── キーフレームグラフ ────────────────────────────────────────────────────
// 背景クリック=キー追加 / キーをドラッグ=移動(時間と値) / キーをダブルクリック=削除
function KeyGraph({ keys, dur, kind, color, playRel, onChange, onSeek }: {
  keys: FKey[]; dur: number; kind: FilterKind; color: string; playRel: number | null
  onChange: (k: FKey[], final: boolean) => void; onSeek: (rel: number) => void
}) {
  const W = 640, H = 150, P = 12
  const last = Math.max(1, dur - 1)
  const vmax = kind === 'solid' ? 1 : Math.max(10, Math.ceil(Math.max(0, ...keys.map(k => k.v)) * 1.25))
  const x = (t: number) => P + (t / last) * (W - 2 * P)
  const y = (v: number) => P + (1 - v / vmax) * (H - 2 * P)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const toTV = (ev: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    const px = (ev.clientX - r.left) * (W / r.width), py = (ev.clientY - r.top) * (H / r.height)
    const t = Math.max(0, Math.min(last, Math.round((px - P) / (W - 2 * P) * last)))
    const [lo, hi] = valueRange(kind)
    let v = (1 - (py - P) / (H - 2 * P)) * vmax
    v = Math.max(lo, Math.min(Math.min(hi, vmax), v))
    v = kind === 'solid' ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10
    return { t, v }
  }
  // 折れ線(端は保持)
  const pts: string[] = []
  const fb = defaultValue(kind)
  if (!keys.length) pts.push(`${x(0)},${y(fb)}`, `${x(last)},${y(fb)}`)
  else {
    pts.push(`${x(0)},${y(keys[0].v)}`)
    for (const k of keys) pts.push(`${x(Math.min(last, k.t))},${y(k.v)}`)
    pts.push(`${x(last)},${y(keys[keys.length - 1].v)}`)
  }
  const dragIdx = useRef<number | null>(null)
  const onKeyDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    dragIdx.current = i
    const base = keys.slice()
    let cur = base
    const move = (ev: PointerEvent) => {
      const { t, v } = toTV(ev)
      cur = base.map((k, j) => j === i ? { t, v } : k)
      onChange(cur, false)
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      dragIdx.current = null
      onChange(cur, true)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto bg-zinc-950 rounded border border-zinc-800 cursor-crosshair touch-none"
      onPointerDown={e => {
        if (e.button !== 0) return
        const { t, v } = toTV(e)
        if (e.shiftKey) { onSeek(t); return }
        onChange([...keys.filter(k => k.t !== t), { t, v }], true)
      }}>
      {/* 目盛: 値の 0/50/100% */}
      {[0, 0.5, 1].map(f => (
        <g key={f}>
          <line x1={P} x2={W - P} y1={y(vmax * f)} y2={y(vmax * f)} stroke="#3f3f46" strokeDasharray="3 4" />
          <text x={2} y={y(vmax * f) - 2} fontSize="9" fill="#71717a">{kind === 'solid' ? f.toFixed(1) : (vmax * f).toFixed(0)}</text>
        </g>
      ))}
      {kind === 'solid' && (
        <polygon points={[`${x(0)},${y(0)}`, ...pts, `${x(last)},${y(0)}`].join(' ')}
                 fill={color} fillOpacity={0.35} />
      )}
      <polyline points={pts.join(' ')} fill="none" stroke={kind === 'solid' ? '#c4b5fd' : '#67e8f9'} strokeWidth={2} />
      {playRel != null && playRel >= 0 && playRel <= last && (
        <line x1={x(playRel)} x2={x(playRel)} y1={0} y2={H} stroke="#f43f5e" strokeWidth={1.5} />
      )}
      {keys.map((k, i) => (
        <g key={`${k.t}-${i}`} transform={`translate(${x(Math.min(last, k.t))},${y(k.v)})`}
           onPointerDown={onKeyDown(i)}
           onDoubleClick={e => { e.stopPropagation(); onChange(keys.filter((_, j) => j !== i), true) }}
           className="cursor-grab">
          <rect x={-6} y={-6} width={12} height={12} transform="rotate(45)" fill="#e9d5ff" stroke="#7c3aed" strokeWidth={1.5} />
          <title>{`+${k.t}f = ${k.v} (ドラッグで移動 / ダブルクリックで削除)`}</title>
        </g>
      ))}
    </svg>
  )
}

// ── 編集ポップアップ ───────────────────────────────────────────────────────
export function FilterLayerPopover({ clipId, fps, onClose }: { clipId: number; fps: number; onClose: () => void }) {
  const clip = useTimelineStore(s => s.clips.find(c => c.id === clipId))
  const liveUpdateClip = useTimelineStore(s => s.liveUpdateClip)
  const updateClip = useTimelineStore(s => s.updateClip)
  const deleteClip = useTimelineStore(s => s.deleteClip)
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const currentFrame = useTimelineStore(s => s.currentFrame)
  // ドラッグ中のキー(確定までローカル表示だけ更新)
  const [dragKeys, setDragKeys] = useState<FKey[] | null>(null)
  const kind = (clip?.kind ?? 'solid') as FilterKind
  const [ramp, setRamp] = useState(kind === 'blur' ? 8 : Math.round(fps))
  const [peak, setPeak] = useState(kind === 'blur' ? BLUR_DEFAULT : 1)
  const keys = useMemo(() => dragKeys ?? (clip ? getKeys(clip) : []), [dragKeys, clip])
  if (!clip || !isFilterClip(clip)) return null
  const dur = clip.duration_frames
  const last = Math.max(0, dur - 1)
  const color = solidColor(clip)
  const rel = currentFrame - clip.start_frame
  const inClip = rel >= 0 && rel < dur
  const [lo, hi] = valueRange(kind)
  const locked = !!clip.locked

  const setKeys = (k: FKey[], final = true) => {
    if (!final) { setDragKeys(k); return }
    setDragKeys(null)
    liveUpdateClip(clip.id, { attrs_json: withKeys(clip.attrs_json, kind, k) })
  }
  const setColor = (c: string) => {
    const a = parseFilterAttrs(clip.attrs_json)
    a.color = c
    liveUpdateClip(clip.id, { attrs_json: JSON.stringify(a) })
  }
  const applyPreset = (id: PresetId) => setKeys(presetKeys(id, dur, ramp, peak, 0))
  const maxKeyT = keys.length ? Math.max(...keys.map(k => k.t)) : 0
  const cur = keyValueAt(keys, Math.max(0, Math.min(last, rel)), defaultValue(kind))
  const fmtVal = (v: number) => kind === 'solid' ? v.toFixed(2) : v.toFixed(1)

  const setRange = async (start: number, endIncl: number) => {
    const s = Math.max(0, start), e = Math.max(s, endIncl)
    const want = e - s + 1
    await updateClip(clip.id, { start_frame: s, duration_frames: want })
    const got = useTimelineStore.getState().clips.find(c => c.id === clip.id)
    if (got && got.duration_frames < want) {
      useUIStore.getState().pushToast(
        `サーバーがカット境界で尺を ${got.duration_frames}f に詰めました(バックエンドのフィルターレイヤー対応パッチ未適用)`, 'info')
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-2 sm:p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[min(720px,96vw)] max-h-[94vh] overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-200">
            {kind === 'solid' ? '■ 単色レイヤー' : '◌ ぼかしレイヤー'}
            <span className="ml-2 text-[10px] text-zinc-500">#{clip.id}</span>
            {locked && <span className="ml-2 text-[10px] text-amber-400">🔒ロック中(編集不可)</span>}
          </span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
        </div>

        {/* 区間 */}
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">
          <span>区間</span>
          <TcInput frame={clip.start_frame} fps={fps} onCommit={f => { void setRange(f, clip.start_frame + last) }} />
          <span>→</span>
          <TcInput frame={clip.start_frame + last} fps={fps} onCommit={f => { void setRange(clip.start_frame, f) }} />
          <span className="text-zinc-500">({dur}f / {(dur / fps).toFixed(2)}s・終端含む)</span>
          <button className={chipCls(false) + ' ml-auto'} title="再生ヘッドを開始位置にする(終端は固定)"
                  onClick={() => { if (currentFrame <= clip.start_frame + last) void setRange(currentFrame, clip.start_frame + last) }}>⇤ 再生位置から</button>
          <button className={chipCls(false)} title="再生ヘッドを終端にする(開始は固定)"
                  onClick={() => { if (currentFrame >= clip.start_frame) void setRange(clip.start_frame, currentFrame) }}>再生位置まで ⇥</button>
        </div>

        {/* 色 */}
        {kind === 'solid' && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 w-8">色</span>
            <input type="color" value={color} onChange={e => setColor(e.target.value)}
                   className="w-8 h-7 bg-transparent border border-zinc-700 rounded cursor-pointer" />
            <input value={color} onChange={e => { if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) setColor(e.target.value) }}
                   className={`${inputCls} font-mono w-24`} />
            <button className={chipCls(color === '#000000')} onClick={() => setColor('#000000')}>■ 黒</button>
            <button className={chipCls(color === '#ffffff')} onClick={() => setColor('#ffffff')}>□ 白</button>
          </div>
        )}

        {/* グラフ */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px] text-zinc-500">
            <span>{kind === 'solid' ? '不透明度(0=透明 / 1=不透明)' : 'ぼかしの強さ σ(1080p基準px)'} — 背景クリックでキー追加・◆ドラッグで移動・◆ダブルクリックで削除・Shift+クリックで再生位置移動</span>
          </div>
          <KeyGraph keys={keys} dur={dur} kind={kind} color={color}
                    playRel={inClip ? rel : null}
                    onChange={(k, final) => { if (!locked) setKeys(k, final) }}
                    onSeek={r => setCurrentFrame(clip.start_frame + r)} />
          <div className="text-[10px] text-zinc-500">
            再生位置: {inClip ? `+${rel}f → ${fmtVal(cur)}` : '区間外'}
          </div>
        </div>

        {/* プリセット */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-zinc-500">プリセット</span>
          <label className="text-[10px] text-zinc-400 flex items-center gap-1">
            {kind === 'solid' ? '到達値' : '強さσ'}
            <input type="number" step={kind === 'solid' ? 0.05 : 0.5} min={lo} max={hi} value={peak}
                   onChange={e => setPeak(Math.max(lo, Math.min(hi, Number(e.target.value) || 0)))}
                   className={`${inputCls} w-16`} />
          </label>
          <label className="text-[10px] text-zinc-400 flex items-center gap-1">
            ランプ
            <input type="number" min={1} max={Math.max(1, last)} value={ramp}
                   onChange={e => setRamp(Math.max(1, Number(e.target.value) || 1))}
                   className={`${inputCls} w-16`} />f
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button className={chipCls(false)} onClick={() => applyPreset('up')}>0→{peak} 全体</button>
          <button className={chipCls(false)} onClick={() => applyPreset('down')}>{peak}→0 全体</button>
          <button className={chipCls(false)} onClick={() => applyPreset('up_hold')}>0→{peak}({ramp}f)→保持</button>
          <button className={chipCls(false)} onClick={() => applyPreset('hold_down')}>保持→{peak}→0(末尾{ramp}f)</button>
          <button className={chipCls(false)} onClick={() => applyPreset('const')}>一定 {peak}</button>
        </div>

        {/* キー一覧 */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500">キー({keys.length})</span>
            <button className={chipCls(false) + ' ml-auto'} disabled={!inClip}
                    title="再生位置に、現在の補間値でキーを追加"
                    onClick={() => setKeys([...keys.filter(k => k.t !== rel), { t: rel, v: Number(fmtVal(cur)) }])}>＋ 再生位置にキー</button>
            <button className={chipCls(false)} disabled={maxKeyT === 0 || maxKeyT === last}
                    title={`キーの時間を比例伸縮して、最後のキー(+${maxKeyT}f)をクリップ終端(+${last}f)に合わせる`}
                    onClick={() => setKeys(rescaleKeys(keys, maxKeyT, last))}>↔ キーを尺に合わせる</button>
          </div>
          <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
            {keys.map((k, i) => (
              <div key={`${k.t}-${i}`} className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                <span className="w-4 text-zinc-600">{i + 1}</span>
                <span>+</span>
                <input type="number" min={0} max={last} value={k.t}
                       onChange={e => setKeys(keys.map((x, j) => j === i ? { t: Math.max(0, Math.round(Number(e.target.value) || 0)), v: x.v } : x))}
                       className={`${inputCls} w-20`} />
                <span>f</span>
                <span className="font-mono text-zinc-500 w-20">{fmtTc(clip.start_frame + k.t, fps)}</span>
                <span>値</span>
                <input type="number" step={kind === 'solid' ? 0.05 : 0.5} min={lo} max={hi} value={k.v}
                       onChange={e => setKeys(keys.map((x, j) => j === i ? { t: x.t, v: Number(e.target.value) || 0 } : x))}
                       className={`${inputCls} w-20`} />
                <button className={chipCls(false)} onClick={() => setCurrentFrame(clip.start_frame + Math.min(k.t, last))} title="このキーへ再生位置を移動">▶</button>
                <button className="text-[10px] px-2 py-1 rounded bg-zinc-800 text-red-300 hover:bg-red-900/60"
                        onClick={() => setKeys(keys.filter((_, j) => j !== i))}>削除</button>
              </div>
            ))}
            {!keys.length && <span className="text-[10px] text-zinc-600">キーなし(一定 {fmtVal(defaultValue(kind))})</span>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => { void deleteClip(clip.id); onClose() }} disabled={locked}
                  className="text-xs px-2 py-1 rounded bg-red-900 hover:bg-red-800 text-red-200 disabled:opacity-40">✕ このレイヤーを削除</button>
          <p className="text-[9px] text-zinc-600 ml-auto">
            キーは「クリップ先頭からのフレーム」。キー間は直線、最初のキーより前・最後のキーより後は端の値で保持。
            {kind === 'blur' ? ' ぼかしはこのトラックより下のレイヤー全体に掛かります(書き出しは出力解像度に比例)。' : ' 上にあるトラックほど手前に重なります。'}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── 作成ポップアップ ─────────────────────────────────────────────────────
type NewKind = 'black' | 'white' | 'color' | 'blur'
export function FilterAddPopover({ projectId, fps, onClose, onCreated }: {
  projectId: number; fps: number; onClose: () => void; onCreated: (clip: Clip) => void
}) {
  const tracks = useTimelineStore(s => s.tracks)
  const clips = useTimelineStore(s => s.clips)
  const selectedClipId = useTimelineStore(s => s.selectedClipId)
  const addFilterClip = useTimelineStore(s => s.addFilterClip)
  const addTrackAt = useTimelineStore(s => s.addTrackAt)
  const playhead = useTimelineStore.getState().currentFrame
  const sel = clips.find(c => c.id === selectedClipId)

  const [nk, setNk] = useState<NewKind>('black')
  const [color, setColor] = useState('#ff0000')
  const [start, setStart] = useState(sel ? sel.start_frame : playhead)
  const [end, setEnd] = useState(sel ? sel.start_frame + sel.duration_frames - 1 : playhead + Math.round(fps * 2) - 1)
  const isBlur = nk === 'blur'
  const vtracks = useMemo(() => tracks.filter(t => t.track_type === 'video').sort((a, b) => a.order - b.order), [tracks])
  const defName = isBlur ? 'Filter' : 'Solid'
  const [target, setTarget] = useState<number | 'new-top'>(() => vtracks.find(t => t.name === 'Solid')?.id ?? 'new-top')
  useEffect(() => {
    const t = vtracks.find(x => x.name === defName)
    setTarget(t ? t.id : 'new-top')
  }, [defName]) // eslint-disable-line react-hooks/exhaustive-deps
  const [preset, setPreset] = useState<PresetId>('up')
  useEffect(() => { setPreset(isBlur ? 'up_hold' : 'up') }, [isBlur])
  const [ramp, setRamp] = useState(8)
  const [peak, setPeak] = useState(1)
  useEffect(() => { setPeak(isBlur ? BLUR_DEFAULT : 1); setRamp(isBlur ? 8 : Math.round(fps)) }, [isBlur, fps])
  const [busy, setBusy] = useState(false)

  const dur = Math.max(1, end - start + 1)
  const overlaps = target !== 'new-top'
    && clips.some(c => c.track_id === target && c.start_frame < start + dur && start < c.start_frame + c.duration_frames)
  const targetTrack = target === 'new-top' ? null : vtracks.find(t => t.id === target)
  const nonFilterOnTarget = target !== 'new-top' && clips.some(c => c.track_id === target && !isFilterClip(c))

  const create = async () => {
    setBusy(true)
    try {
      let trackId: number
      if (target === 'new-top') {
        const minOrder = Math.min(0, ...tracks.map(t => t.order))
        const tr = await addTrackAt(projectId, 'video', defName, minOrder - 1)
        trackId = tr.id
      } else trackId = target
      const kind: FilterKind = isBlur ? 'blur' : 'solid'
      const keys = presetKeys(preset, dur, ramp, Math.max(0, Math.min(isBlur ? BLUR_MAX : 1, peak)), 0)
      const attrs: Record<string, unknown> = isBlur ? { blur_keys: keys }
        : { color: nk === 'black' ? '#000000' : nk === 'white' ? '#ffffff' : color, opacity_keys: keys }
      const clip = await addFilterClip(trackId, kind, start, dur, JSON.stringify(attrs))
      if (clip.duration_frames < dur) {
        useUIStore.getState().pushToast(
          `サーバーがカット境界で尺を ${clip.duration_frames}f に詰めました(バックエンドのフィルターレイヤー対応パッチ未適用)`, 'info')
      }
      onCreated(clip)
      onClose()
    } finally { setBusy(false) }
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-2 sm:p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[min(520px,96vw)] max-h-[94vh] overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-200">🎚 フィルターレイヤーを追加</span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 w-10">種類</span>
          <button className={chipCls(nk === 'black')} onClick={() => setNk('black')}>■ 黒</button>
          <button className={chipCls(nk === 'white')} onClick={() => setNk('white')}>□ 白</button>
          <button className={chipCls(nk === 'color')} onClick={() => setNk('color')}>● 色…</button>
          {nk === 'color' && <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-8 h-7 bg-transparent border border-zinc-700 rounded" />}
          <button className={chipCls(nk === 'blur')} onClick={() => setNk('blur')}>◌ ぼかし</button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">
          <span className="text-zinc-500 w-10">区間</span>
          <TcInput frame={start} fps={fps} onCommit={setStart} />
          <span>→</span>
          <TcInput frame={end} fps={fps} onCommit={setEnd} />
          <span className="text-zinc-500">{dur}f</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button className={chipCls(false)} onClick={() => { const f = useTimelineStore.getState().currentFrame; setStart(f); if (end < f) setEnd(f + Math.round(fps * 2) - 1) }}>開始=再生位置</button>
          <button className={chipCls(false)} onClick={() => { const f = useTimelineStore.getState().currentFrame; if (f >= start) setEnd(f) }}>終端=再生位置</button>
          {sel && <button className={chipCls(false)} onClick={() => { setStart(sel.start_frame); setEnd(sel.start_frame + sel.duration_frames - 1) }}>選択クリップの範囲</button>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 w-10">配置先</span>
          <select value={String(target)} onChange={e => setTarget(e.target.value === 'new-top' ? 'new-top' : Number(e.target.value))}
                  className={inputCls}>
            <option value="new-top">＋ 新規トラック「{defName}」(最前面)</option>
            {vtracks.map(t => <option key={t.id} value={t.id}>{t.name}{t.hidden ? '(非表示)' : ''}</option>)}
          </select>
        </div>
        {nonFilterOnTarget && (
          <p className="text-[10px] text-amber-400">⚠ {targetTrack?.name} には素材クリップがあります。フィルターは専用トラックに置くのがおすすめです(Shots の空枠扱い等を避けるため)。</p>
        )}
        {overlaps && <p className="text-[10px] text-amber-400">⚠ 配置先トラックの既存クリップと区間が重なります。</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 w-10">{isBlur ? '強さ' : '不透明'}</span>
          <select value={preset} onChange={e => setPreset(e.target.value as PresetId)} className={inputCls}>
            <option value="up">0→{peak} 全体</option>
            <option value="down">{peak}→0 全体</option>
            <option value="up_hold">0→{peak}(ランプ)→保持</option>
            <option value="hold_down">保持→{peak}→0(末尾ランプ)</option>
            <option value="const">一定 {peak}</option>
          </select>
          <label className="text-[10px] text-zinc-400 flex items-center gap-1">
            {isBlur ? 'σ' : '値'}
            <input type="number" step={isBlur ? 0.5 : 0.05} min={0} max={isBlur ? BLUR_MAX : 1} value={peak}
                   onChange={e => setPeak(Number(e.target.value) || 0)} className={`${inputCls} w-16`} />
          </label>
          {(preset === 'up_hold' || preset === 'hold_down') && (
            <label className="text-[10px] text-zinc-400 flex items-center gap-1">
              ランプ
              <input type="number" min={1} value={ramp} onChange={e => setRamp(Math.max(1, Number(e.target.value) || 1))} className={`${inputCls} w-16`} />f
            </label>
          )}
        </div>
        <p className="text-[9px] text-zinc-600">
          {isBlur ? 'ぼかし: このトラックより下に重なっている絵全体をぼかします。σは1920×1080基準(出力解像度に比例)。'
            : '単色: 画面全体を1色で覆います。不透明度はキーで変化(後から編集可)。'}
          作成後はクリップをダブルクリック(または「🎚 編集」)でキーを編集できます。
        </p>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs">キャンセル</button>
          <button onClick={() => { void create() }} disabled={busy || end < start}
                  className="flex-1 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white text-xs disabled:opacity-40">
            {busy ? '作成中…' : '追加'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
