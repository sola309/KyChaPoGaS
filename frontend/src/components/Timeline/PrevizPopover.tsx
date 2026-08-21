import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTimelineStore } from '../../store/timelineStore'
import { useAnalysisStore } from '../../store/analysisStore'
import { useUIStore } from '../../store/uiStore'
import { assetsApi, type Clip } from '../../api/client'
import { DEFAULT_PREVIZ, drawPrevizBase, drawPrevizFx, parsePreviz, sampleCurve,
         type Previz } from './previz'

export { parsePreviz, type Previz } from './previz'

/**
 * 🎞 プレビズ設定 — ノイズプレビューを音付きで再生しながら、カットの
 * カメラワーク(3Dベクトル)・移動量カーブ・フラッシュ・暗転を調整する。
 *
 *  - 移動は3D球で指定: 球ドラッグ=画面内方向(斜め自由) / 奥行スライダ=寄り・引き
 *  - 拍レーン・移動量カーブ・スクラブは両端を揃えたミニタイムライン(同一時間軸)
 *  - 音声はタイムラインの可聴トラックをミックスし、音声を親時計に映像を同期
 * 保存はカット開始ピンの attrs_json.previz。生成キューには影響しない。
 */
const FLASHES: Array<[Previz['flash'], string]> = [['none', 'なし'], ['cut', 'カット頭'], ['beat', '拍ごと']]
const FADES: Array<[Previz['fade'], string]> = [['none', 'なし'], ['in', '暗転から'], ['out', '暗転へ'], ['inout', '両方']]
const CW = 384, CURVE_H = 96, BEAT_H = 18, SCRUB_H = 16

interface Props {
  cutIndex: number
  pinClipId: number
  fps: number
  cutFrames: number
  cutStartFrame: number
  onClose: () => void
}

export function PrevizPopover({ cutIndex, pinClipId, fps, cutFrames, cutStartFrame, onClose }: Props) {
  const clips = useTimelineStore(s => s.clips)
  const tracks = useTimelineStore(s => s.tracks)
  const updateClip = useTimelineStore(s => s.updateClip)
  const liveUpdateClip = useTimelineStore(s => s.liveUpdateClip)
  const beatsMap = useAnalysisStore(s => s.beats)
  const pushToast = useUIStore(s => s.pushToast)
  const pin = clips.find(c => c.id === pinClipId)

  const attrs = useMemo(() => {
    try { return pin?.attrs_json ? JSON.parse(pin.attrs_json) : {} } catch { return {} }
  }, [pin?.attrs_json])
  const pv: Previz = parsePreviz(pin?.attrs_json) ?? { ...DEFAULT_PREVIZ }

  const save = (patch: Partial<Previz>, live = false) => {
    try {
      const next = { ...pv, ...patch }
      const body = JSON.stringify({ ...attrs, previz: next })
      if (live) liveUpdateClip(pinClipId, { attrs_json: body })
      else void updateClip(pinClipId, { attrs_json: body }).catch(e =>
        pushToast(`プレビズの保存に失敗: ${e}`, 'error'))
    } catch (e) { pushToast(`プレビズの保存に失敗: ${e}`, 'error') }
  }

  // ── カット内ビート(表示と拍フラッシュ) ────────────────────────────────
  const { beatRel, downRel } = useMemo(() => {
    for (const c of clips) {
      const b = c.asset_id != null ? beatsMap[c.asset_id] : undefined
      if (!b) continue
      const inSec = c.asset_in_frame / fps
      const conv = (arr: number[]) => arr
        .map(t => Math.round(c.start_frame + (t - inSec) * fps) - cutStartFrame)
        .filter(f => f >= 0 && f < cutFrames)
      return { beatRel: conv(b.beats), downRel: conv((b as { downbeats?: number[] }).downbeats ?? []) }
    }
    return { beatRel: [] as number[], downRel: [] as number[] }
  }, [clips, beatsMap, fps, cutStartFrame, cutFrames])

  // ── 再生状態 ─────────────────────────────────────────────────────────
  const cvRef = useRef<HTMLCanvasElement>(null)
  const [rel, setRel] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [audioOn, setAudioOn] = useState(true)
  const relRef = useRef(0)

  const audioClips = useMemo(() => {
    const cutEnd = cutStartFrame + cutFrames
    return clips.filter(c => {
      const t = tracks.find(tk => tk.id === c.track_id)
      return t?.track_type === 'audio' && !t.hidden && c.asset_id != null
        && c.start_frame < cutEnd && c.start_frame + c.duration_frames > cutStartFrame
    })
  }, [clips, tracks, cutStartFrame, cutFrames])
  const audioEls = useRef<Map<number, HTMLAudioElement>>(new Map())
  const toAssetSec = (c: Clip, F: number) => (F - c.start_frame + c.asset_in_frame) / fps

  const renderFrame = (r: number) => {
    const cv = cvRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height)
    drawPrevizBase(ctx, cv.width, cv.height, pv, r, cutFrames)
    drawPrevizFx(ctx, cv.width, cv.height, pv, r, cutFrames, beatRel)
  }
  const renderRef = useRef(renderFrame)
  renderRef.current = renderFrame
  useEffect(() => { renderFrame(rel) }, [rel, pv, cutFrames, beatRel])

  useEffect(() => {
    relRef.current = rel
    if (playing) return
    const F = cutStartFrame + rel
    for (const c of audioClips) {
      const el = audioEls.current.get(c.id)
      if (el && el.readyState >= 1) el.currentTime = Math.max(0, toAssetSec(c, F)) + 1e-3
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rel, playing])

  useEffect(() => {
    // 親時計は毎回同じクリップに固定する(順序が変わるとループ基準がぶれる)。
    // 「元音源」を最優先、無ければクリップIDの小さい方。
    const entries = audioOn
      ? audioClips.map(c => ({ c, el: audioEls.current.get(c.id) }))
          .filter((x): x is { c: Clip; el: HTMLAudioElement } => !!x.el)
          .sort((a, b) => {
            const nm = (x: typeof a) => tracks.find(tk => tk.id === x.c.track_id)?.name ?? ''
            const pa = nm(a).includes('元音源') ? 0 : 1
            const pb = nm(b).includes('元音源') ? 0 : 1
            return pa - pb || a.c.id - b.c.id
          })
      : []
    if (!playing) { entries.forEach(({ el }) => el.pause()); return }
    if (entries.length > 0) {
      // 音声を親時計に: 映像は currentTime から導出するので原理的にズレない
      const seekAll = (r: number) => {
        const F = cutStartFrame + r
        for (const { c, el } of entries) el.currentTime = Math.max(0, toAssetSec(c, F)) + 1e-3
      }
      // メタデータ未読込のうちは currentTime 代入が無視され、頭出しがずれる。
      // readyState>=1 を待ってから頭出し→再生する。
      let started = false
      const startAll = () => {
        if (started) return
        if (entries.some(({ el }) => el.readyState < 1)) return
        started = true
        seekAll(relRef.current)
        entries.forEach(({ el }) => {
          el.preservesPitch = false          // 速度変更時の音程補正を切る(位置精度優先)
          void el.play().catch(() => {})
        })
      }
      startAll()
      const onMeta = () => startAll()
      entries.forEach(({ el }) => el.addEventListener('loadedmetadata', onMeta))
      const master = entries[0]
      let raf = 0
      const tick = () => {
        // 表示フレームは四捨五入。切り捨てだと常に平均0.5フレーム遅れて見え、
        // 実測でも最大1.16フレーム(48ms)の遅れになっていた。
        // HTMLAudioElement.currentTime はバッファ更新の粒度で階段状に返るため、
        // 端数を捨てるとその階段がそのまま遅れとして残る。
        const F = master.el.currentTime * fps + master.c.start_frame - master.c.asset_in_frame
        let r = Math.round(F - cutStartFrame)
        if (r >= cutFrames || master.el.ended) { seekAll(0); r = 0 }
        if (r >= 0) {
          renderRef.current(r)
          if (r !== relRef.current) setRel(r)
        }
        // 従属トラックの追従: 小さなズレは再生速度で吸収し、大きくズレた時だけシーク。
        // 毎回シークすると音が切れて聞き取れなくなるため。
        const masterF = master.el.currentTime * fps + master.c.start_frame - master.c.asset_in_frame
        for (let i = 1; i < entries.length; i++) {
          const el = entries[i].el
          const want = toAssetSec(entries[i].c, masterF)
          const err = el.currentTime - want
          if (Math.abs(err) > 0.12) { el.currentTime = want; el.playbackRate = 1 }
          else el.playbackRate = Math.min(1.03, Math.max(0.97, 1 - err * 0.5))
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      return () => {
        cancelAnimationFrame(raf)
        entries.forEach(({ el }) => {
          el.removeEventListener('loadedmetadata', onMeta)
          el.pause(); el.playbackRate = 1
        })
      }
    }
    let raf = 0, last = performance.now(), acc = 0
    const tick = (now: number) => {
      acc += (now - last) * fps / 1000; last = now
      if (acc >= 1) { setRel(r => (r + Math.floor(acc)) % cutFrames); acc -= Math.floor(acc) }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, audioOn, audioClips, fps, cutFrames, cutStartFrame, tracks])

  // ── 3D球(画面内方向) + 奥行 ──────────────────────────────────────────
  const ballRef = useRef<SVGSVGElement>(null)
  const [vx, vy, vz] = pv.moveVec
  const ballDrag = (e: React.PointerEvent, live: boolean) => {
    const r = ballRef.current!.getBoundingClientRect()
    let x = ((e.clientX - r.left) / r.width) * 2 - 1
    let y = ((e.clientY - r.top) / r.height) * 2 - 1
    const len = Math.hypot(x, y)
    if (len > 1) { x /= len; y /= len }
    save({ moveVec: [Math.round(x * 100) / 100, Math.round(y * 100) / 100, vz] }, live)
  }

  // ── カーブエディタ ───────────────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null)
  const dragIdx = useRef<number | null>(null)
  const pts = pv.movePts
  const toXY = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return {
      t: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      v: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)),
    }
  }
  const nearIdx = (t: number, v: number) => {
    let ni = -1, nd = 0.07
    pts.forEach((p, i) => {
      const d = Math.hypot(p[0] - t, (p[1] - v) * (CURVE_H / CW))
      if (d < nd) { nd = d; ni = i }
    })
    return ni
  }
  const onCurveDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const { t, v } = toXY(e)
    let ni = nearIdx(t, v)
    if (ni < 0) {
      const next = [...pts, [t, v] as [number, number]].sort((a, b) => a[0] - b[0])
      save({ movePts: next })
      ni = next.findIndex(p => p[0] === t && p[1] === v)
    }
    dragIdx.current = ni
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onCurveMove = (e: React.PointerEvent) => {
    if (dragIdx.current == null || !e.buttons) return
    const i = dragIdx.current
    const { t, v } = toXY(e)
    const next = pts.map((p, j) => {
      if (j !== i) return p
      const lo = j === 0 ? 0 : pts[j - 1][0] + 0.02
      const hi = j === pts.length - 1 ? 1 : pts[j + 1][0] - 0.02
      const tt = j === 0 ? 0 : j === pts.length - 1 ? 1 : Math.min(hi, Math.max(lo, t))
      return [tt, v] as [number, number]
    })
    save({ movePts: next }, true)
  }
  const onCurveDbl = (e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    const t = (e.clientX - r.left) / r.width
    const v = 1 - (e.clientY - r.top) / r.height
    const ni = nearIdx(t, v)
    if (ni > 0 && ni < pts.length - 1 && pts.length > 2)
      save({ movePts: pts.filter((_, j) => j !== ni) })
  }
  const curvePath = useMemo(() => {
    const N = 64
    let d = ''
    for (let i = 0; i <= N; i++) {
      const u = i / N
      d += `${i === 0 ? 'M' : 'L'}${(u * CW).toFixed(1)},${((1 - sampleCurve(pts, u)) * CURVE_H).toFixed(1)}`
    }
    return d
  }, [pts])

  // ── スクラブ(拍レーン/スクラブ帯の共通ハンドラ) ───────────────────────
  const scrub = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    const r = el.getBoundingClientRect()
    const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    setPlaying(false)
    setRel(Math.min(cutFrames - 1, Math.round(u * (cutFrames - 1))))
  }
  const headPct = `${(rel / Math.max(1, cutFrames - 1)) * 100}%`

  if (!pin) return null
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-3"
         onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[440px] max-w-full p-4
                      flex flex-col gap-3 max-h-[92dvh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">
            🎞 プレビズ — C{cutIndex}（{(cutFrames / fps).toFixed(1)}秒）
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg px-2">✕</button>
        </div>
        {attrs.intent && (
          <p className="text-[10px] text-zinc-500 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 line-clamp-2">
            {attrs.intent}
          </p>
        )}

        {/* ── プレビュー + トランスポート ── */}
        <div className="flex flex-col gap-1.5">
          <canvas ref={cvRef} width={384} height={216}
                  className="w-full rounded border border-zinc-700 bg-black" />
          <div className="flex items-center gap-1.5 text-xs">
            <button onClick={() => { setPlaying(false); setRel(0) }}
                    className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">⏮</button>
            <button onClick={() => { setPlaying(false); setRel(r => Math.max(0, r - 1)) }}
                    className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">−1f</button>
            <button onClick={() => setPlaying(p => !p)}
                    className={`px-3 py-1 rounded font-medium ${playing
                      ? 'bg-amber-700 hover:bg-amber-600 text-amber-50'
                      : 'bg-fuchsia-700 hover:bg-fuchsia-600 text-white'}`}>
              {playing ? '⏸' : '▶ ループ'}
            </button>
            <button onClick={() => { setPlaying(false); setRel(r => Math.min(cutFrames - 1, r + 1)) }}
                    className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">+1f</button>
            <span className="flex-1" />
            <span className="font-mono text-zinc-400 text-[10px]">f{rel}/{cutFrames}</span>
            <button onClick={() => setAudioOn(v => !v)}
                    className={`px-2 py-1 rounded ${audioOn
                      ? 'bg-emerald-800 hover:bg-emerald-700 text-emerald-100'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'}`}
                    title={audioOn ? '音源ON(可聴トラックをミックス・音声が親時計)' : '音源OFF'}>
              {audioOn ? '🔊' : '🔇'}
            </button>
          </div>
          {audioClips.map(c => (
            <audio key={c.id} src={assetsApi.fileUrl(c.asset_id!)} preload="auto"
                   ref={el => {
                     if (el) audioEls.current.set(c.id, el)
                     else audioEls.current.delete(c.id)
                   }} />
          ))}
        </div>

        {/* ── ミニタイムライン(両端を揃えた時間軸: 拍 / カーブ / スクラブ) ── */}
        <div className="relative select-none">
          {/* 拍レーン */}
          <svg width="100%" height={BEAT_H} viewBox={`0 0 ${CW} ${BEAT_H}`} preserveAspectRatio="none"
               className="block rounded-t border border-b-0 border-zinc-700 bg-zinc-950 cursor-ew-resize touch-none"
               onPointerDown={e => { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); scrub(e) }}
               onPointerMove={e => { if (e.buttons) scrub(e) }}>
            {beatRel.map((bf, i) => (
              <rect key={i} x={bf / cutFrames * CW} y={BEAT_H * 0.35} width={1.2} height={BEAT_H * 0.65}
                    fill="rgba(251,191,36,0.85)" />
            ))}
            {downRel.map((bf, i) => (
              <rect key={`d${i}`} x={bf / cutFrames * CW - 0.4} y={0} width={2} height={BEAT_H}
                    fill="rgba(251,146,60,0.95)" />
            ))}
          </svg>
          {/* 移動量カーブ */}
          <svg ref={svgRef} width="100%" height={CURVE_H} viewBox={`0 0 ${CW} ${CURVE_H}`} preserveAspectRatio="none"
               className="block border border-zinc-700 bg-zinc-950 touch-none cursor-crosshair"
               onPointerDown={onCurveDown} onPointerMove={onCurveMove}
               onPointerUp={() => { dragIdx.current = null }}
               onDoubleClick={onCurveDbl}>
            {[0.25, 0.5, 0.75].map(g => (
              <line key={g} x1={0} x2={CW} y1={g * CURVE_H} y2={g * CURVE_H} stroke="#27272a" strokeWidth={1} />
            ))}
            <path d={curvePath} fill="none" stroke="#a855f7" strokeWidth={2} />
            {pts.map((p, i) => (
              <circle key={i} cx={p[0] * CW} cy={(1 - p[1]) * CURVE_H} r={6}
                      fill="#d8b4fe" stroke="#7e22ce" strokeWidth={2} />
            ))}
          </svg>
          {/* スクラブ帯 */}
          <div className="relative rounded-b border border-t-0 border-zinc-700 bg-zinc-800/70 cursor-ew-resize touch-none"
               style={{ height: SCRUB_H }}
               onPointerDown={e => { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); scrub(e) }}
               onPointerMove={e => { if (e.buttons) scrub(e) }}>
            <span className="absolute left-1 top-0 text-[8px] text-zinc-500">f0</span>
            <span className="absolute right-1 top-0 text-[8px] text-zinc-500">f{cutFrames}</span>
          </div>
          {/* 再生ヘッド(全レーン貫通) */}
          <div className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-10"
               style={{ left: headPct }} />
        </div>
        <p className="text-[9px] text-zinc-600 -mt-2">
          拍レーン/下の帯=ドラッグでシーク　カーブ=クリックでキー追加・ドラッグ移動・ダブルクリック削除（縦=移動速度）
        </p>

        {/* ── カメラワーク(3D球 + 奥行) ── */}
        <div>
          <div className="text-[10px] text-zinc-500 mb-1">カメラワーク（球=画面内方向・斜め自由 / 右=奥行き）</div>
          <div className="flex items-center gap-3">
            <svg ref={ballRef} width={104} height={104} viewBox="-1.15 -1.15 2.3 2.3"
                 className="touch-none cursor-move shrink-0"
                 onPointerDown={e => { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); ballDrag(e, false) }}
                 onPointerMove={e => { if (e.buttons) ballDrag(e, true) }}>
              <defs>
                <radialGradient id="pvball" cx="35%" cy="35%">
                  <stop offset="0%" stopColor="#52525b" />
                  <stop offset="100%" stopColor="#18181b" />
                </radialGradient>
              </defs>
              <circle cx={0} cy={0} r={1} fill="url(#pvball)" stroke="#3f3f46" strokeWidth={0.04} />
              <line x1={-1} x2={1} y1={0} y2={0} stroke="#27272a" strokeWidth={0.02} />
              <line x1={0} x2={0} y1={-1} y2={1} stroke="#27272a" strokeWidth={0.02} />
              {(vx !== 0 || vy !== 0) && (
                <line x1={0} y1={0} x2={vx} y2={vy} stroke="#a855f7" strokeWidth={0.06} strokeLinecap="round" />
              )}
              <circle cx={vx} cy={vy} r={0.13} fill="#d8b4fe" stroke="#7e22ce" strokeWidth={0.05} />
            </svg>
            <div className="flex-1 flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                <span className="w-8">奥行</span>
                <span className="text-zinc-600">引く</span>
                <input type="range" min={-100} max={100} value={Math.round(vz * 100)}
                       className="flex-1 accent-purple-500"
                       onChange={e => save({ moveVec: [vx, vy, Number(e.target.value) / 100] }, true)} />
                <span className="text-zinc-600">寄る</span>
              </div>
              <div className="text-[10px] text-zinc-500 font-mono">
                x {vx.toFixed(2)} / y {vy.toFixed(2)} / z {vz.toFixed(2)}
              </div>
              <button onClick={() => save({ moveVec: [0, 0, 0] })}
                      className="self-start text-[10px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800">
                リセット(静止)
              </button>
            </div>
          </div>
        </div>

        {/* ── フラッシュ ── */}
        <div>
          <div className="text-[10px] text-zinc-500 mb-1">フラッシュ</div>
          <div className="flex gap-1 items-center flex-wrap">
            {FLASHES.map(([v, label]) => (
              <button key={v} onClick={() => save({ flash: v })}
                      className={`px-2 py-1 rounded border text-xs ${pv.flash === v
                        ? 'bg-amber-800 border-amber-500 text-amber-100'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'}`}>
                {label}
              </button>
            ))}
            {pv.flash !== 'none' && (
              <span className="flex items-center gap-1.5 ml-2 text-[10px] text-zinc-400">
                長さ
                <input type="range" min={2} max={16} value={pv.flashLen}
                       className="w-24 accent-amber-500"
                       onChange={e => save({ flashLen: Number(e.target.value) }, true)} />
                {pv.flashLen}f
              </span>
            )}
          </div>
        </div>

        {/* ── 暗転フェード ── */}
        <div>
          <div className="text-[10px] text-zinc-500 mb-1">暗転フェード</div>
          <div className="flex gap-1 flex-wrap">
            {FADES.map(([v, label]) => (
              <button key={v} onClick={() => save({ fade: v })}
                      className={`px-2 py-1 rounded border text-xs ${pv.fade === v
                        ? 'bg-sky-800 border-sky-500 text-sky-100'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'}`}>
                {label}
              </button>
            ))}
          </div>
          {(pv.fade === 'in' || pv.fade === 'inout') && (
            <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-zinc-400">
              <span className="w-14">イン長さ</span>
              <input type="range" min={2} max={Math.min(96, cutFrames)} value={pv.fadeIn}
                     className="flex-1 accent-sky-500"
                     onChange={e => save({ fadeIn: Number(e.target.value) }, true)} />
              <span className="w-10 text-right">{pv.fadeIn}f</span>
            </div>
          )}
          {(pv.fade === 'out' || pv.fade === 'inout') && (
            <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-zinc-400">
              <span className="w-14">アウト長さ</span>
              <input type="range" min={2} max={Math.min(96, cutFrames)} value={pv.fadeOut}
                     className="flex-1 accent-sky-500"
                     onChange={e => save({ fadeOut: Number(e.target.value) }, true)} />
              <span className="w-10 text-right">{pv.fadeOut}f</span>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
