import { useEffect, useRef } from 'react'
import { useAnalysisStore } from '../../store/analysisStore'

/**
 * MotionCanvas — クリップ内のフレーム差分（画面変化量）波形.
 *
 * 音声波形の動画版: 低い棒=動きが小さい、高い棒=激しい、極大(上位8%)は
 * シーンカット級の変化として桜色でハイライトされる。クリップの
 * asset_in/speed を通してソースのカーブをタイムライン座標へマップする。
 */

interface Props {
  assetId: number
  assetInFrame: number
  durationFrames: number
  speed: number
  projectFps: number
  width: number
  height: number
}

export function MotionCanvas({
  assetId, assetInFrame, durationFrames, speed, projectFps, width, height,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const curve = useAnalysisStore(s => s.curves[assetId])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !curve?.values?.length || width < 4) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    const vals = curve.values
    const sorted = [...vals].sort((a, b) => a - b)
    const vmax = Math.max(sorted[sorted.length - 1], 0.001)
    const cutThreshold = sorted[Math.floor(sorted.length * 0.92)]   // 上位8% = カット級

    const sp = speed > 0 ? speed : 1
    const bar = Math.max(1, Math.floor(width / Math.max(1, durationFrames)))
    for (let x = 0; x < width; x++) {
      const tlFrame = (x / width) * durationFrames
      const srcSec = (assetInFrame + tlFrame * sp) / projectFps
      const idx = Math.floor(srcSec * curve.fps)
      if (idx < 0 || idx >= vals.length) continue
      const v = vals[idx]
      const hgt = Math.max(1, (v / vmax) * height)
      ctx.fillStyle = v >= cutThreshold && cutThreshold > 0
        ? 'rgba(246,194,203,0.95)'           // 桜色 = カット級の極大
        : 'rgba(227,103,126,0.55)'           // 紅 = 通常のモーション
      ctx.fillRect(x, height - hgt, Math.max(1, bar / 2), hgt)
    }
  }, [curve, assetId, assetInFrame, durationFrames, speed, projectFps, width, height])

  if (!curve) return null
  return (
    <canvas
      ref={ref}
      className="absolute bottom-0 left-0 pointer-events-none"
      style={{ width, height }}
      title="フレーム差分（画面変化量）"
    />
  )
}
