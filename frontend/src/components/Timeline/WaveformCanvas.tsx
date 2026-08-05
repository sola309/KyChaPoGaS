import { useEffect, useRef } from 'react'
import { assetsApi } from '../../api/client'

// Module-level cache: assetId → Float32Array of peaks (one per pixel at zoom=1)
const peakCache = new Map<number, Float32Array>()

async function getPeaks(assetId: number, numBuckets: number, useProxy = false): Promise<Float32Array> {
  // サーバ計算のピークJSON(約8KB)を取得。従来のファイル全体DL+ブラウザデコードは
  // 帯域を食い尽くして音声ストリーミングを妨げていたため、フォールバックのみに残す。
  let allPeaks = peakCache.get(assetId)
  if (!allPeaks) {
    try {
      const res = await fetch(assetsApi.fileUrl(assetId).replace(/\/file.*$/, '/peaks'))
      if (!res.ok) throw new Error(`peaks ${res.status}`)
      const data = await res.json() as { peaks: number[] }
      allPeaks = data.peaks.length ? new Float32Array(data.peaks) : new Float32Array(2000)
    } catch {
      // フォールバック: 従来方式(ファイル全体をデコード)
      const res  = await fetch(assetsApi.fileUrl(assetId, useProxy))
      const buf  = await res.arrayBuffer()
      const ctx  = new AudioContext()
      const decoded = await ctx.decodeAudioData(buf)
      await ctx.close()
      const ch0  = decoded.getChannelData(0)
      const mono = decoded.numberOfChannels > 1
        ? (() => {
            const ch1  = decoded.getChannelData(1)
            const out  = new Float32Array(ch0.length)
            for (let i = 0; i < ch0.length; i++) out[i] = (Math.abs(ch0[i]) + Math.abs(ch1[i])) / 2
            return out
          })()
        : new Float32Array(ch0.map(Math.abs))
      const stored = new Float32Array(2000)
      const chunk  = Math.ceil(mono.length / 2000)
      for (let i = 0; i < 2000; i++) {
        let max = 0
        for (let j = i * chunk; j < Math.min((i + 1) * chunk, mono.length); j++) {
          if (mono[j] > max) max = mono[j]
        }
        stored[i] = max
      }
      allPeaks = stored
    }
    peakCache.set(assetId, allPeaks)
  }

  // Resample stored 2000-peak array to requested numBuckets
  const out   = new Float32Array(numBuckets)
  const ratio = allPeaks.length / numBuckets
  for (let i = 0; i < numBuckets; i++) {
    const start = Math.floor(i * ratio)
    const end   = Math.min(Math.ceil((i + 1) * ratio), allPeaks.length)
    let max = 0
    for (let j = start; j < end; j++) {
      if (allPeaks[j] > max) max = allPeaks[j]
    }
    out[i] = max
  }
  return out
}

interface Props {
  assetId: number
  width: number
  height: number
  color?: string
  useProxy?: boolean
}

export function WaveformCanvas({ assetId, width, height, color = '#4ade80', useProxy = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (width < 2) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx    = canvas.getContext('2d')
    if (!ctx) return

    let cancelled = false
    const numBuckets = Math.ceil(width)
    canvas.width  = numBuckets
    canvas.height = height

    getPeaks(assetId, numBuckets, useProxy).then(peaks => {
      if (cancelled) return
      ctx.clearRect(0, 0, numBuckets, height)
      ctx.fillStyle = color
      const half = height / 2
      for (let i = 0; i < numBuckets; i++) {
        const barH = Math.max(1, peaks[i] * height * 0.9)
        ctx.fillRect(i, half - barH / 2, 1, barH)
      }
    }).catch(() => {
      // audio may not be decodable (video file etc.) — silently skip
    })

    return () => { cancelled = true }
  }, [assetId, width, height, color, useProxy])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full opacity-60 pointer-events-none"
      style={{ imageRendering: 'pixelated' }}
    />
  )
}
