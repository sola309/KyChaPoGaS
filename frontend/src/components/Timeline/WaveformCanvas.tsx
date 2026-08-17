import { useEffect, useRef, useState } from 'react'
import { assetsApi } from '../../api/client'

// Module-level cache: assetId → Float32Array of peaks (one per pixel at zoom=1)
const peakCache = new Map<number, Float32Array>()

async function getPeaks(assetId: number, useProxy = false): Promise<Float32Array> {
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

  return allPeaks
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
  const wrapRef = useRef<HTMLDivElement>(null)

  // 長尺クリップの全幅canvasはブラウザの辺長上限(WebKitは32767px)を超えて
  // 確保に失敗し、波形が丸ごと消える。上限の手前からは「見えている窓+左右2000px」
  // だけを描き、スクロールに追従させる(RhythmLaneと同じ方式)。
  const CAP = 16000
  const windowed = width > CAP
  const [view, setView] = useState({ x: 0, w: Math.min(width, CAP) })
  useEffect(() => {
    if (!windowed) { setView({ x: 0, w: Math.ceil(width) }); return }
    const wrap = wrapRef.current
    const sc = wrap?.closest('.overflow-auto') as HTMLElement | null
    if (!wrap || !sc) return
    let raf = 0
    const update = () => {
      raf = 0
      // ラッパーのコンテンツ座標(スクロール領域内での開始x)
      const rel = wrap.getBoundingClientRect().left - sc.getBoundingClientRect().left + sc.scrollLeft
      const x = Math.max(0, Math.min(width, sc.scrollLeft - rel - 2000))
      const w = Math.max(0, Math.min(width - x, sc.clientWidth + 4000))
      setView(v => (Math.abs(v.x - x) > 1000 || Math.abs(v.w - w) > 500) ? { x, w } : v)
    }
    const on = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    sc.addEventListener('scroll', on)
    window.addEventListener('resize', on)
    return () => {
      sc.removeEventListener('scroll', on)
      window.removeEventListener('resize', on)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [windowed, width])

  useEffect(() => {
    if (width < 2 || view.w < 2) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx    = canvas.getContext('2d')
    if (!ctx) return

    let cancelled = false
    const w = Math.ceil(view.w)
    canvas.width  = w
    canvas.height = height

    getPeaks(assetId, useProxy).then(all => {
      if (cancelled) return
      ctx.clearRect(0, 0, w, height)
      ctx.fillStyle = color
      const half = height / 2
      const ratio = all.length / width          // 全幅に対するピーク列の比
      for (let i = 0; i < w; i++) {
        const g0 = Math.floor((view.x + i) * ratio)
        const g1 = Math.min(Math.ceil((view.x + i + 1) * ratio), all.length)
        let peak = 0
        for (let j = g0; j < g1; j++) if (all[j] > peak) peak = all[j]
        if (g1 <= g0 && g0 < all.length) peak = all[g0]
        const barH = Math.max(1, peak * height * 0.9)
        ctx.fillRect(i, half - barH / 2, 1, barH)
      }
    }).catch(() => {
      // audio may not be decodable (video file etc.) — silently skip
    })

    return () => { cancelled = true }
  }, [assetId, width, height, color, useProxy, view])

  return (
    <div ref={wrapRef} className="absolute inset-0 pointer-events-none">
      <canvas
        ref={canvasRef}
        className="absolute top-0 h-full opacity-60"
        style={{ left: view.x, width: view.w, imageRendering: 'pixelated' }}
      />
    </div>
  )
}
