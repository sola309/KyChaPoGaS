import { useEffect, useRef, useMemo } from 'react'
import type { Clip } from '../../api/client'
import { useAnalysisStore } from '../../store/analysisStore'

/**
 * RhythmLane — タイムライン全体の「リズムの気持ちよさ」を一望するレーン.
 *
 * 赤いエリア = 合成モーションカーブ（各クリップのフレーム差分を asset_in/speed
 * でマップし、カット点にスパイクを注入）。緑/琥珀のティック = ビート
 * （近傍にモーションの山がある=緑、無い=琥珀）。琥珀が並ぶ区間は
 * 「音は鳴っているのに画面が動いていない」場所。
 */

const LANE_H = 26

interface Props {
  clips: Clip[]               // 基底ビデオトラックのクリップ
  beatFrames: number[]
  pixelsPerFrame: number
  totalWidth: number
  projectFps: number
  onSeek: (frame: number) => void
}

export function RhythmLane({ clips, beatFrames, pixelsPerFrame, totalWidth, projectFps, onSeek }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const curves = useAnalysisStore(s => s.curves)

  // タイムライン合成カーブ（フレーム単位）
  const timeline = useMemo(() => {
    if (!clips.length) return new Float32Array(0)
    const total = Math.max(...clips.map(c => c.start_frame + c.duration_frames))
    const tl = new Float32Array(total + 1)
    const sorted = [...clips].sort((a, b) => a.start_frame - b.start_frame)
    sorted.forEach((c, i) => {
      const curve = c.asset_id != null ? curves[c.asset_id] : undefined
      const sp = c.speed || 1
      if (curve?.values?.length) {
        for (let f = 0; f < c.duration_frames; f++) {
          const idx = Math.floor(((c.asset_in_frame + f * sp) / projectFps) * curve.fps)
          if (idx >= 0 && idx < curve.values.length) {
            const tf = c.start_frame + f
            if (tf <= total) tl[tf] = Math.max(tl[tf], curve.values[idx])
          }
        }
      }
      // カット点 = 視覚変化（同一アセットへのジャンプカットは弱め）
      const prev = sorted[i - 1]
      const spike = prev && prev.asset_id === c.asset_id ? 0.25 : 0.8
      if (c.start_frame <= total) tl[c.start_frame] = Math.max(tl[c.start_frame], spike)
    })
    return tl
  }, [clips, curves, projectFps])

  // ビート判定しきい値（スコアラーと同じ60パーセンタイル）
  const threshold = useMemo(() => {
    const nz = Array.from(timeline).filter(v => v > 0).sort((a, b) => a - b)
    return nz.length ? Math.max(nz[Math.floor(nz.length * 0.6)], 0.05) : 0.05
  }, [timeline])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || timeline.length === 0) return
    const w = Math.min(totalWidth, 16000)
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(w * dpr)
    canvas.height = LANE_H * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, LANE_H)

    // モーションエリアチャート（カットスパイクは別色の縦線）
    const vmax = 0.25   // 表示レンジ（スパイク0.8は飽和してよい）
    ctx.fillStyle = 'rgba(214,64,93,0.55)'
    for (let x = 0; x < w; x++) {
      const f = Math.floor(x / pixelsPerFrame)
      if (f >= timeline.length) break
      const v = timeline[f]
      if (v <= 0) continue
      const h = Math.min(1, v / vmax) * (LANE_H - 4)
      ctx.fillRect(x, LANE_H - h, 1, h)
    }

    // ビートティック
    for (const bf of beatFrames) {
      const x = bf * pixelsPerFrame
      if (x > w) break
      const lo = Math.max(0, bf - 2), hi = Math.min(timeline.length - 1, bf + 2)
      let peak = 0
      for (let f = lo; f <= hi; f++) peak = Math.max(peak, timeline[f])
      ctx.fillStyle = peak >= threshold ? 'rgba(74,222,128,0.9)' : 'rgba(251,191,36,0.95)'
      ctx.fillRect(x, 0, 1.5, LANE_H)
      if (peak < threshold) {              // 弱いビートは▼マーク
        ctx.beginPath()
        ctx.moveTo(x - 3, 0); ctx.lineTo(x + 4.5, 0); ctx.lineTo(x + 0.75, 5)
        ctx.fill()
      }
    }
  }, [timeline, beatFrames, pixelsPerFrame, totalWidth, threshold])

  if (timeline.length === 0) return null
  return (
    <canvas
      ref={ref}
      height={LANE_H}
      className="block cursor-pointer"
      style={{ width: Math.min(totalWidth, 16000), height: LANE_H }}
      title="リズムレーン: 赤=画面の変化量 / 緑=ビートに山あり / 琥珀▼=ビートに変化なし（クリックでシーク）"
      onClick={e => {
        const x = e.nativeEvent.offsetX
        onSeek(Math.max(0, Math.round(x / pixelsPerFrame)))
      }}
    />
  )
}
