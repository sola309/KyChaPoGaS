import { useEffect, useRef } from 'react'
import { assetsApi } from '../../api/client'

// Module-level cache: assetId → Float32Array of peaks (one per pixel at zoom=1)
const peakCache = new Map<number, Float32Array>()

async function getPeaks(assetId: number, numBuckets: number): Promise<Float32Array> {
  // Fetch raw decoded audio, then decimate to numBuckets peaks
  let allPeaks = peakCache.get(assetId)
  if (!allPeaks) {
    const res  = await fetch(assetsApi.fileUrl(assetId))
    const buf  = await res.arrayBuffer()
    const ctx  = new AudioContext()
    const decoded = await ctx.decodeAudioData(buf)
    await ctx.close()

    // Mix all channels down to mono
    const ch0  = decoded.getChannelData(0)
    const mono = decoded.numberOfChannels > 1
      ? (() => {
          const ch1  = decoded.getChannelData(1)
          const out  = new Float32Array(ch0.length)
          for (let i = 0; i < ch0.length; i++) out[i] = (Math.abs(ch0[i]) + Math.abs(ch1[i])) / 2
          return out
        })()
      : new Float32Array(ch0.map(Math.abs))

    // Store at 2000-bucket resolution for re-use across zoom levels
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
    peakCache.set(assetId, stored)
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
}

export function WaveformCanvas({ assetId, width, height, color = '#4ade80' }: Props) {
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

    getPeaks(assetId, numBuckets).then(peaks => {
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
  }, [assetId, width, height, color])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full opacity-60 pointer-events-none"
      style={{ imageRendering: 'pixelated' }}
    />
  )
}
