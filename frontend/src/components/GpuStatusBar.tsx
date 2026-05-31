import { useEffect, useRef, useState } from 'react'
import { systemApi } from '../api/client'
import type { GpuStatus, GpuInfo } from '../api/client'

function VramBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? (used / total) * 100 : 0
  const color =
    pct > 90 ? 'bg-red-500'
    : pct > 70 ? 'bg-amber-500'
    : 'bg-emerald-500'

  return (
    <div className="flex items-center gap-1.5">
      <div className="w-20 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-zinc-300 tabular-nums text-[10px]">
        {used >= 1024 ? `${(used / 1024).toFixed(1)}` : used}
        <span className="text-zinc-500">/{total >= 1024 ? `${(total / 1024).toFixed(0)}GB` : `${total}MB`}</span>
      </span>
    </div>
  )
}

function GpuChip({ gpu }: { gpu: GpuInfo }) {
  const shortName = gpu.name
    .replace('NVIDIA ', '')
    .replace('GeForce ', '')
    .replace('RTX ', 'RTX ')
    .replace('Quadro ', 'Q ')

  return (
    <div className="flex items-center gap-2.5 px-2">
      {/* Name */}
      <span className="text-zinc-400 text-[10px] font-medium truncate max-w-[80px]" title={gpu.name}>
        {shortName}
      </span>

      {/* VRAM bar */}
      <VramBar used={gpu.vram_used_mb} total={gpu.vram_total_mb} />

      {/* Core utilization */}
      <span className="text-zinc-400 text-[10px] tabular-nums">
        <span className="text-zinc-500">core </span>
        <span className={gpu.utilization_pct > 90 ? 'text-amber-400' : 'text-zinc-300'}>
          {gpu.utilization_pct}%
        </span>
      </span>

      {/* Temperature */}
      {gpu.temperature_c > 0 && (
        <span className="text-zinc-400 text-[10px] tabular-nums">
          <span className="text-zinc-500">temp </span>
          <span className={gpu.temperature_c > 80 ? 'text-red-400' : gpu.temperature_c > 70 ? 'text-amber-400' : 'text-zinc-300'}>
            {gpu.temperature_c}°C
          </span>
        </span>
      )}

      {/* Power */}
      {gpu.power_limit_w > 0 && (
        <span className="text-zinc-400 text-[10px] tabular-nums">
          <span className="text-zinc-500">pwr </span>
          <span className="text-zinc-300">{Math.round(gpu.power_draw_w)}W</span>
        </span>
      )}
    </div>
  )
}

export function GpuStatusBar() {
  const [status, setStatus] = useState<GpuStatus | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource(systemApi.gpuSseUrl())
    esRef.current = es

    es.onmessage = (e) => {
      try {
        setStatus(JSON.parse(e.data) as GpuStatus)
      } catch { /* ignore */ }
    }
    es.onerror = () => {
      // reconnect is automatic via EventSource, but clear stale data on sustained failure
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [])

  if (!status) return null

  if (!status.available) {
    return (
      <div className="h-6 flex items-center px-3 gap-1.5 bg-zinc-900 border-b border-zinc-800 select-none">
        <span className="text-[10px] text-zinc-600">GPU: 未検出</span>
      </div>
    )
  }

  return (
    <div className="h-6 flex items-center px-1 bg-zinc-900 border-b border-zinc-800 select-none overflow-x-auto">
      <span className="text-[10px] text-zinc-600 px-1 flex-shrink-0">GPU</span>
      <div className="flex items-center divide-x divide-zinc-800">
        {status.gpus.map(g => <GpuChip key={g.index} gpu={g} />)}
      </div>
    </div>
  )
}
