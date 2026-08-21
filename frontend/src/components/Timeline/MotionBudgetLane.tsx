import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { useAnalysisStore } from '../../store/analysisStore'
import { MB_ROWS, DRUM_COLOR, BUILDUP_COLOR, BUILDUP_KINDS, mbHeight,
         type MBRow } from './motionBudgetRows'

/**
 * MotionBudgetLane — 「この瞬間、画はどれくらい動くべきか」を音から出して常時見せるレーン。
 *
 * 最終結果(移動量)だけを出すと、なぜその値なのかが分からず判断できない。算出の材料を全部並べる:
 *
 *   構造   楽曲の区間(サビ/メロ/間奏/…)。区間ごとの基準倍率の出どころ
 *   副     自作(信号統計)の区間。主とズレる所は手法の限界が出ている所。
 *          ユーザーのカット割り67箇所を正解とすると、境界の±0.5秒一致は
 *          allin1(=主) 79% に対し 自作 33%。エネルギー・歌唱量・和声のどれも
 *          変化しない切れ目(52.5s / 208.0s 等)は信号統計では原理的に取れない。
 *          allin1のBPM/ビートは倍テンポを誤るので使わない(103 vs 実測214.29)。
 *   盛上げ サビ前の助走(黄=上昇 / 赤=抜き / 灰=平坦)。映像設計で最も効く場所。
 *          **クリックで 平坦→上昇→抜き→削除 と切り替わり、空白クリックで新規追加**。
 *          自動判定は当てにならない(allin1の境界に自作の判定式を当てると
 *          5箇所すべて「平坦」になった)ので、人が置けるようにしてある。
 *          手動値は audio_structure_override に保存され、再解析でも消えない。
 *   移動量 最終結果。白い輪郭 = 構造を掛ける前の素の駆動力(伴奏低域の持続)。
 *          面と輪郭の差が「構造がどれだけ効いたか」
 *   歌唱   芝居の密度。濃いほどカメラを抑えて芝居を見せる
 *   粒度   ハイハット等。粒子・細かい揺れの量
 *   キック   画面の押し(Push/寄せ)・被写体の踏み込み
 *   スネア   カット・反転・ワイプ。拍位置が最も安定(実測 2拍目44% / 4拍目45%)
 *   シンバル フラッシュ・粒子。メロ0.42 vs サビ2.39 と区間差が最大
 *   打撃(旧) HPSS一括。役割が混ざって読めなかったので既定では出さない
 *   等級   カットごとの推奨(静止/小/中/大)。カット割りと縦に並べて読む
 *
 * ⚠ 絶対エネルギーではなく曲内のパーセンタイル順位を使っている。マスタリングされた
 *    楽曲はラウドネスが飽和していて、絶対値では全カットが同じ等級になるため(実測)。
 */

const SECT_COLOR: Record<string, string> = {
  'サビ': '#c84646', '間奏': '#c87832', 'メロ': '#4670b4',
  'つなぎ': '#6e648c', 'イントロ': '#464650', 'アウトロ': '#464650',
}

interface Cut { idx: number; s: number; e: number }

interface Props {
  songAssetId: number | null
  cuts: Cut[]
  pixelsPerFrame: number
  totalWidth: number
  projectFps: number
  /** 移動量の上限(画面幅%)。ここを動かして体感と合わせる */
  maxPct: number
  /** 打撃の表示下限(強さ0-1)。上げるほど「本当に目立つ当たり」だけが残る */
  hitMin: number
  rows: readonly MBRow[]
  onSeek: (frame: number) => void
  /** 小節線(フレーム)。盛り上げの端をここへ吸着させる */
  snapFrames?: number[]
  /** 盛り上げの手動編集(未指定なら読み取り専用) */
  onBuildupsChange?: (b: Buildup[]) => void
}

type Buildup = { start_sec: number; end_sec: number; target: string
                 kind: string; slope: number; break: number }

/** ドラッグ中の状態。掴んだ場所で意味が変わる */
type Drag =
  | { mode: 'new';     from: number; to: number }
  | { mode: 'move';    idx: number; grabSec: number; origS: number; origE: number }
  | { mode: 'resizeL'; idx: number }
  | { mode: 'resizeR'; idx: number }

/** 等級のしきい値は上限に対する比率で決める(上限を変えても関係が崩れないように) */
function gradeOf(v: number, maxPct: number): { label: string; color: string } {
  const r = v / maxPct
  if (r < 0.2) return { label: '静止', color: '#5a5a64' }
  if (r < 0.4) return { label: '小',   color: '#508c5a' }
  if (r < 0.7) return { label: '中',   color: '#b49646' }
  return { label: '大', color: '#dc5a5a' }
}

export function MotionBudgetLane({ songAssetId, cuts, pixelsPerFrame, totalWidth,
                                   projectFps, maxPct, hitMin, rows, onSeek,
                                   snapFrames, onBuildupsChange }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const audioMotion = useAnalysisStore(s => s.audioMotion)
  const audioStructure = useAnalysisStore(s => s.audioStructure)
  const audioStructureAlt = useAnalysisStore(s => s.audioStructureAlt)
  const buildupOverride = useAnalysisStore(s => s.buildupOverride)
  const audioDrums = useAnalysisStore(s => s.audioDrums)
  const am = songAssetId != null ? audioMotion[songAssetId] : undefined
  const st = songAssetId != null ? audioStructure[songAssetId] : undefined
  const dr = songAssetId != null ? audioDrums[songAssetId] : undefined
  const st2 = songAssetId != null ? audioStructureAlt[songAssetId] : undefined
  const ovr = songAssetId != null ? buildupOverride[songAssetId] : undefined
  // 手動上書きがあれば自動判定より優先する
  const stored: Buildup[] = (ovr ?? st?.buildups ?? []) as Buildup[]
  const [drag, setDrag] = useState<Drag | null>(null)
  const downRef = useRef<number | null>(null)   // 押下位置(吸着前の秒)
  const downPxRef = useRef(0)                  // 押下位置(px)。移動量ゼロ=クリック判定に使う
  const [live, setLive] = useState<Buildup[] | null>(null)   // ドラッグ中の見た目
  const buildups = live ?? stored

  // 解析結果は decim フレームごとに間引かれている。換算はここに集約する。
  const decim = am?.decim ?? 1

  // カットごとの平均移動量(等級帯に使う)
  const perCut = useMemo(() => {
    if (!am?.move_pct?.length) return new Map<number, number>()
    const out = new Map<number, number>()
    for (const c of cuts) {
      let sum = 0, n = 0
      for (let i = Math.floor(c.s / decim); i <= Math.floor(c.e / decim) && i < am.move_pct.length; i++) {
        sum += am.move_pct[i]; n++
      }
      if (n) out.set(c.idx, sum / n)
    }
    return out
  }, [am, cuts, decim])

  const H = mbHeight(rows)

  // ── 可視窓の追従 ───────────────────────────────────────────────────
  // 全幅を1枚のcanvasに描くと、canvasの辺長上限(Chromeで32767px)を超えた時点で
  // 描画がまるごと破棄されてレーンが白く飛ぶ。全長6351フレームでは ppf=4/dpr=2 から
  // 超過していた。解像度を落として収める手もあるが、拡大したのにボケては意味が無い。
  // スクロール位置を追い、画面幅+左右2000pxの窓だけを等倍で描いて absolute で置く
  // (RhythmLane と同じ方式)。
  const wrapRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 0, w: 6000 })
  useEffect(() => {
    const el = wrapRef.current?.closest('.overflow-auto') as HTMLElement | null
    if (!el) return
    let raf = 0
    const update = () => {
      raf = 0
      const x = Math.max(0, el.scrollLeft - 2000)
      const w = Math.max(0, Math.min(totalWidth - x, el.clientWidth + 4000))
      setView(v => (Math.abs(v.x - x) > 1000 || Math.abs(v.w - w) > 500) ? { x, w } : v)
    }
    const on = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    el.addEventListener('scroll', on)
    window.addEventListener('resize', on)
    return () => {
      el.removeEventListener('scroll', on)
      window.removeEventListener('resize', on)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [totalWidth])
  // 盛上げ行の上端Y(当たり判定に使う)
  const buildTop = useMemo(() => {
    let y = 0
    for (const r of rows) { if (r === 'build') return y; y += MB_ROWS[r].h }
    return -1
  }, [rows])

  const EDGE_PX = 6                       // 端をつかめる幅
  const secOf = (px: number) => px / pixelsPerFrame / projectFps
  /** 小節線へ吸着。近くに無ければ素の位置。音楽的な区切り以外に置く意味がないため */
  const snap = useCallback((sec: number) => {
    if (!snapFrames?.length) return sec
    const f = sec * projectFps
    let best = f, bd = Infinity
    for (const sf of snapFrames) {
      const d = Math.abs(sf - f)
      if (d < bd) { bd = d; best = sf }
    }
    // 12px以内なら吸着(ズームしても掴みやすさが変わらないよう画面距離で判定)
    return bd * pixelsPerFrame <= 12 ? best / projectFps : sec
  }, [snapFrames, projectFps, pixelsPerFrame])

  /** カーソル位置が盛上げ行のどこを指しているか */
  const hitTest = useCallback((px: number, py: number) => {
    if (buildTop < 0 || py < buildTop || py >= buildTop + MB_ROWS.build.h) return null
    const sec = secOf(px)
    for (let i = 0; i < buildups.length; i++) {
      const b = buildups[i]
      const x0 = b.start_sec * projectFps * pixelsPerFrame
      const x1 = b.end_sec * projectFps * pixelsPerFrame
      if (px < x0 - EDGE_PX || px > x1 + EDGE_PX) continue
      if (Math.abs(px - x0) <= EDGE_PX) return { kind: 'resizeL' as const, idx: i, sec }
      if (Math.abs(px - x1) <= EDGE_PX) return { kind: 'resizeR' as const, idx: i, sec }
      return { kind: 'body' as const, idx: i, sec }
    }
    return { kind: 'empty' as const, idx: -1, sec }
  }, [buildups, buildTop, pixelsPerFrame, projectFps])

  useEffect(() => {
    const cv = ref.current
    if (!cv || !am?.move_pct?.length) return
    const W = Math.max(1, Math.round(view.w))
    if (W <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr)
    cv.style.width = `${W}px`; cv.style.height = `${H}px`
    const ctx = cv.getContext('2d')
    if (!ctx) return
    // 等倍のまま、窓の左端ぶんだけ原点をずらす。描画コードは従来どおり
    // 「タイムライン先頭からの絶対座標」で書ける。
    ctx.setTransform(dpr, 0, 0, dpr, -view.x * dpr, 0)
    ctx.clearRect(view.x, 0, W, H)

    const x = (f: number) => f * pixelsPerFrame
    const xs = (sec: number) => x(sec * projectFps)

    /** 収まるときだけ書く。切り詰めると「イントロ/ア」のような読めない断片が残る */
    const fitText = (s: string, x0: number, y0: number, w: number) => {
      ctx.font = '9px sans-serif'
      if (ctx.measureText(s).width + 6 > w) return
      ctx.fillText(s, x0 + 3, y0)
    }

    /** 0-1の系列を面グラフで描く */
    const series = (arr: number[] | undefined, y0: number, h: number, color: string, scale = 1) => {
      ctx.fillStyle = '#131316'; ctx.fillRect(view.x, y0, W, h)
      if (!arr?.length) return
      ctx.beginPath(); ctx.moveTo(view.x, y0 + h)
      for (let i = 0; i < arr.length; i++) {
        ctx.lineTo(x(i * decim), y0 + h - Math.min(arr[i] / scale, 1) * h)
      }
      ctx.lineTo(x(arr.length * decim), y0 + h); ctx.closePath()
      ctx.fillStyle = color; ctx.fill()
    }

    let y = 0
    for (const r of rows) {
      const h = MB_ROWS[r].h
      if (r === 'sect') {
        ctx.fillStyle = '#0e0e11'; ctx.fillRect(view.x, y, W, h)
        for (const sc of st?.sections ?? []) {
          const x0 = xs(sc.start_sec), w = Math.max(1, xs(sc.end_sec) - x0 - 1)
          ctx.fillStyle = SECT_COLOR[sc.label] ?? '#555'
          ctx.fillRect(x0, y, w, h)
          ctx.fillStyle = 'rgba(255,255,255,0.95)'
          fitText(sc.label, x0, y + h - 3, w)
        }
      } else if (r === 'sect2') {
        // 副は主と見分けがつくよう、色を落として細く描く
        ctx.fillStyle = '#0a0a0c'; ctx.fillRect(view.x, y, W, h)
        for (const sc of st2?.sections ?? []) {
          const x0 = xs(sc.start_sec), w = Math.max(1, xs(sc.end_sec) - x0 - 1)
          ctx.globalAlpha = 0.55
          ctx.fillStyle = SECT_COLOR[sc.label] ?? '#555'
          ctx.fillRect(x0, y + 1, w, h - 2)
          ctx.globalAlpha = 1
        }
        // 主と副で境界がズレている所に印を付ける(ここが人の判断が要る場所)
        const mb = new Set((st?.sections ?? []).map(v => Math.round(v.start_sec * 10)))
        for (const sc of st2?.sections ?? []) {
          const near = [...mb].some(v => Math.abs(v / 10 - sc.start_sec) < 1.0)
          if (near) continue
          ctx.fillStyle = 'rgba(255,255,255,0.85)'
          ctx.fillRect(xs(sc.start_sec) - 1, y, 2, h)
        }
      } else if (r === 'build') {
        ctx.fillStyle = '#0e0e11'; ctx.fillRect(view.x, y, W, h)
        for (const bu of buildups) {
          const x0 = xs(bu.start_sec), w = Math.max(3, xs(bu.end_sec) - x0)
          ctx.fillStyle = BUILDUP_COLOR[bu.kind] ?? '#4a4a52'
          ctx.fillRect(x0, y + 2, w, h - 4)
          // 端のつまみ。掴めることが見て分かるように明るく出す
          ctx.fillStyle = 'rgba(255,255,255,0.8)'
          ctx.fillRect(x0, y + 2, 2, h - 4)
          ctx.fillRect(x0 + w - 2, y + 2, 2, h - 4)
          // 上昇/下降は向きを三角で示す(色だけだと区別しづらい)
          if (w > 20 && (bu.kind === '上昇' || bu.kind === '下降')) {
            const up = bu.kind === '上昇'
            ctx.fillStyle = 'rgba(20,20,20,0.75)'
            ctx.beginPath()
            const cx = x0 + w / 2, yT = y + 4, yB = y + h - 4
            if (up) { ctx.moveTo(cx, yT); ctx.lineTo(cx + 4, yB); ctx.lineTo(cx - 4, yB) }
            else { ctx.moveTo(cx, yB); ctx.lineTo(cx + 4, yT); ctx.lineTo(cx - 4, yT) }
            ctx.closePath(); ctx.fill()
          }
        }
        // 新規ドラッグ中のプレビュー
        if (drag?.mode === 'new') {
          const a = Math.min(drag.from, drag.to), b2 = Math.max(drag.from, drag.to)
          ctx.fillStyle = 'rgba(230,200,120,0.45)'
          ctx.fillRect(xs(a), y + 2, Math.max(2, xs(b2) - xs(a)), h - 4)
        }
      } else if (r === 'move') {
        series(am.move_pct, y, h, 'rgba(96,140,220,0.55)', maxPct)
        ctx.strokeStyle = '#33333c'; ctx.lineWidth = 1
        for (const t of [0.2, 0.4, 0.7]) {
          const yy = Math.round(y + h - t * h) + 0.5
          ctx.beginPath(); ctx.moveTo(view.x, yy); ctx.lineTo(view.x + W, yy); ctx.stroke()
        }
        // 構造を掛ける前の素の駆動力。面との差が「構造がどれだけ効いたか」
        if (am.sustain?.length) {
          ctx.beginPath()
          for (let i = 0; i < am.sustain.length; i++) {
            const v = Math.min(am.sustain[i] * (am.base_max_pct / maxPct), 1)
            const px = x(i * decim), py = y + h - v * h
            if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py)
          }
          ctx.strokeStyle = 'rgba(255,255,255,0.30)'; ctx.lineWidth = 1; ctx.stroke()
        }
      } else if (r === 'voice') {
        series(am.voice, y, h, 'rgba(110,200,130,0.75)')
      } else if (r === 'grain') {
        series(am.grain, y, h, 'rgba(200,200,120,0.6)')
      } else if (r === 'kick' || r === 'snare' || r === 'cymbal') {
        // ドラムは離散点。強さで高さを変えるので、弱い当たりは自然に目立たない。
        ctx.fillStyle = '#131316'; ctx.fillRect(view.x, y, W, h)
        ctx.fillStyle = DRUM_COLOR[r]
        for (const ht of dr?.classes?.[r] ?? []) {
          if (ht.v < hitMin) continue
          const hh = Math.max(2, ht.v * h)
          ctx.fillRect(x(ht.t * projectFps), y + h - hh, Math.max(1, pixelsPerFrame * 2), hh)
        }
      } else if (r === 'punch') {
        ctx.fillStyle = '#131316'; ctx.fillRect(view.x, y, W, h)
        ctx.fillStyle = 'rgba(230,90,90,0.9)'
        // 離散点で描く。連続量に閾値を掛ける方式だと214BPMのキックを全部拾って
        // 毎秒2.7本になり読めなかった(実測)。
        for (const ht of am.hits ?? []) {
          if (ht.v < hitMin) continue
          const hh = Math.max(2, ht.v * h)
          ctx.fillRect(x(ht.t * projectFps), y + h - hh, Math.max(1, pixelsPerFrame * 2), hh)
        }
      } else if (r === 'grade') {
        ctx.fillStyle = '#0e0e11'; ctx.fillRect(view.x, y, W, h)
        for (const c of cuts) {
          const v = perCut.get(c.idx)
          if (v == null) continue
          const g = gradeOf(v, maxPct)
          ctx.fillStyle = g.color
          const x0 = x(c.s), w = Math.max(1, x(c.e) - x(c.s) - 1)
          ctx.fillRect(x0, y, w, h)
          ctx.fillStyle = 'rgba(255,255,255,0.92)'
          fitText(g.label, x0, y + h - 3, w)
        }
      }
      y += h
    }
  }, [am, st, st2, dr, buildups, drag, view, cuts, perCut, pixelsPerFrame, totalWidth, maxPct, hitMin, decim, rows, H, projectFps])

  if (!am?.move_pct?.length) {
    return (
      <div ref={wrapRef} className="text-[9px] text-zinc-600 px-2 flex items-center" style={{ height: H }}>
        楽曲を解析すると移動量バジェットが出ます
      </div>
    )
  }
  return (
    <div ref={wrapRef} className="relative" style={{ width: totalWidth, height: H }}>
    <canvas
      ref={ref}
      className="cursor-pointer"
      style={{ height: H }}
      onPointerDown={e => {
        const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
        const px = e.clientX - r.left + view.x, py = e.clientY - r.top
        const h = hitTest(px, py)
        downRef.current = h && h.kind !== 'empty' ? h.sec : (h ? h.sec : null)
        if (!h || !onBuildupsChange) {                  // 盛上げ行の外 → 従来どおりシーク
          onSeek(Math.max(0, Math.round(px / pixelsPerFrame)))
          return
        }
        ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
        if (h.kind === 'empty') setDrag({ mode: 'new', from: snap(h.sec), to: snap(h.sec) })
        else if (h.kind === 'resizeL') setDrag({ mode: 'resizeL', idx: h.idx })
        else if (h.kind === 'resizeR') setDrag({ mode: 'resizeR', idx: h.idx })
        else setDrag({ mode: 'move', idx: h.idx, grabSec: h.sec,
                       origS: buildups[h.idx].start_sec, origE: buildups[h.idx].end_sec })
        downPxRef.current = px
        setLive(stored.map(b => ({ ...b })))
      }}
      onPointerMove={e => {
        const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
        const px = e.clientX - r.left + view.x, py = e.clientY - r.top
        if (!drag) {
          // つかめる場所ではカーソルを変えて、操作できることを示す
          const h = hitTest(px, py)
          const cur = !h ? 'pointer'
            : h.kind === 'resizeL' || h.kind === 'resizeR' ? 'ew-resize'
            : h.kind === 'body' ? 'grab' : 'crosshair'
          ;(e.target as HTMLCanvasElement).style.cursor = cur
          return
        }
        const sec = snap(secOf(px))
        setLive(prev => {
          const next = (prev ?? stored).map(b => ({ ...b }))
          if (drag.mode === 'new') { setDrag({ ...drag, to: sec }); return next }
          const b = next[drag.idx]
          if (!b) return next
          if (drag.mode === 'resizeL') b.start_sec = Math.min(sec, b.end_sec - 0.1)
          else if (drag.mode === 'resizeR') b.end_sec = Math.max(sec, b.start_sec + 0.1)
          else {
            const d = sec - drag.grabSec
            b.start_sec = Math.max(0, drag.origS + d)
            b.end_sec = drag.origE + d
          }
          return next
        })
      }}
      onPointerUp={e => {
        ;(e.target as HTMLCanvasElement).releasePointerCapture?.(e.pointerId)
        if (!drag || !onBuildupsChange) { setDrag(null); setLive(null); return }
        let next = (live ?? stored).map(b => ({ ...b }))
        // 既存の帯を「動かさずに離した」= クリック → 種別を巡回させる。
        // これが無いと帯の上のクリックは0距離の移動になり、何も起きない。
        if (drag.mode === 'move') {
          const r2 = (e.target as HTMLCanvasElement).getBoundingClientRect()
          if (Math.abs(e.clientX - r2.left + view.x - downPxRef.current) < 4) {
            const i = drag.idx
            if (next[i]) {
              const k = BUILDUP_KINDS.indexOf(next[i].kind as typeof BUILDUP_KINDS[number])
              if (k >= BUILDUP_KINDS.length - 1) next.splice(i, 1)   // 一巡で削除
              else next[i] = { ...next[i], kind: BUILDUP_KINDS[k + 1] }
            }
          }
        }
        if (drag.mode === 'new') {
          const a = Math.min(drag.from, drag.to), b2 = Math.max(drag.from, drag.to)
          // クリック判定には「押した生の秒」を使う。from/toは小節線へ吸着済みで、
          // 帯の内側を押しても外側の小節線へ飛んでいることがあるため。
          const clickSec = downRef.current ?? a
          if (b2 - a < 0.4) {          // 0.4秒未満はドラッグでなくクリック扱い
            // ドラッグでなく単なるクリック → その場の帯の種別を巡回(無ければ何もしない)
            const i = next.findIndex(x => x.start_sec <= clickSec && clickSec < x.end_sec)
            if (i >= 0) {
              const k = BUILDUP_KINDS.indexOf(next[i].kind as typeof BUILDUP_KINDS[number])
              if (k >= BUILDUP_KINDS.length - 1) next.splice(i, 1)   // 一巡で削除
              else next[i] = { ...next[i], kind: BUILDUP_KINDS[k + 1] }
            }
          } else {
            const target = (st?.sections ?? []).find(x => x.start_sec >= b2)?.label ?? 'サビ'
            next.push({ start_sec: a, end_sec: b2, target, kind: '上昇', slope: 0, break: 0 })
          }
        }
        next = next.filter(b => b.end_sec > b.start_sec).sort((a, b) => a.start_sec - b.start_sec)
        setDrag(null); setLive(null)
        onBuildupsChange(next)
      }}
      onPointerCancel={() => { setDrag(null); setLive(null) }}
      className="absolute top-0"
      style={{ left: view.x }}
      title="盛上げ行: ドラッグで新規 / 端をつかんで伸縮 / 本体をドラッグで移動 / クリックで 上昇→下降→抜き→平坦→削除。端は小節線に吸着\n構造/盛上げ/移動量(白線=構造前の素の駆動力)/歌唱/粒度/キック・スネア・シンバル/カット等級"
    />
    </div>
  )
}
