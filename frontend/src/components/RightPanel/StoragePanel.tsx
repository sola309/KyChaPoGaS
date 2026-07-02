// Storage / footprint panel — visualises what the app is holding (per-project
// asset bytes by type, and the browser-side storage + JS-heap the frontend
// occupies) and offers one-click reductions: proxy-ify heavy videos (lighter
// preview + smaller working set) and delete assets no clip references.

import { useEffect, useState } from 'react'
import type { Asset } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'

interface Props {
  projectId: number
  assets: Asset[]
  onAssetsChange: (assets: Asset[]) => void
}

const fmt = (b: number): string => {
  if (!b) return '0'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)))
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}

type Kind = 'image' | 'video' | 'audio' | 'other'
const KIND_COLOR: Record<Kind, string> = {
  image: 'bg-sky-500', video: 'bg-purple-500', audio: 'bg-emerald-500', other: 'bg-zinc-500',
}
const KIND_LABEL: Record<Kind, string> = { image: '画像', video: '動画', audio: '音声', other: 'その他' }

function kindOf(a: Asset): Kind {
  if (a.asset_type === 'audio') return 'audio'
  if (a.asset_type === 'video') return 'video'
  if (a.asset_type === 'image') return 'image'
  if (a.asset_type === 'generated') return a.duration_sec == null ? 'image' : 'video'
  return 'other'
}

export function StoragePanel({ projectId, assets, onAssetsChange }: Props) {
  const clips = useTimelineStore(s => s.clips)
  const [browser, setBrowser] = useState<{ usage?: number; quota?: number; heap?: number; heapLimit?: number }>({})
  const [busy, setBusy] = useState<number | 'unused' | 'proxyall' | null>(null)

  useEffect(() => {
    (async () => {
      const b: typeof browser = {}
      try {
        if (navigator.storage?.estimate) {
          const e = await navigator.storage.estimate()
          b.usage = e.usage; b.quota = e.quota
        }
      } catch { /* not available */ }
      const m = (performance as any).memory
      if (m) { b.heap = m.usedJSHeapSize; b.heapLimit = m.jsHeapSizeLimit }
      setBrowser(b)
    })()
  }, [assets.length])

  const usedIds = new Set(clips.map(c => c.asset_id).filter((x): x is number => x != null))
  const totals: Record<Kind, number> = { image: 0, video: 0, audio: 0, other: 0 }
  for (const a of assets) totals[kindOf(a)] += a.file_size_bytes ?? 0
  const grand = Object.values(totals).reduce((s, v) => s + v, 0)

  const unused = assets.filter(a => !usedIds.has(a.id))
  const unusedBytes = unused.reduce((s, a) => s + (a.file_size_bytes ?? 0), 0)
  const proxyless = assets.filter(a => kindOf(a) === 'video' && !a.proxy_path)
  const largest = [...assets].sort((a, b) => (b.file_size_bytes ?? 0) - (a.file_size_bytes ?? 0)).slice(0, 8)

  const refresh = async () => onAssetsChange(await assetsApi.list(projectId))

  const delOne = async (a: Asset) => {
    setBusy(a.id)
    try { await assetsApi.delete(a.id); await refresh() } finally { setBusy(null) }
  }
  const delUnused = async () => {
    if (!confirm(`未使用アセット ${unused.length}件 (${fmt(unusedBytes)}) を削除しますか？`)) return
    setBusy('unused')
    try { for (const a of unused) await assetsApi.delete(a.id); await refresh() } finally { setBusy(null) }
  }
  const proxyOne = async (a: Asset) => {
    setBusy(a.id)
    try { await assetsApi.makeProxy(a.id) } finally { setBusy(null) }
  }
  const proxyAll = async () => {
    setBusy('proxyall')
    try { for (const a of proxyless) await assetsApi.makeProxy(a.id) } finally { setBusy(null) }
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4 text-zinc-200">
      {/* Project asset footprint */}
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[11px] font-semibold text-zinc-300">プロジェクト容量</span>
          <span className="text-[11px] tabular-nums text-zinc-400">{fmt(grand)} ・ {assets.length}点</span>
        </div>
        <div className="flex h-3 rounded overflow-hidden bg-zinc-800">
          {(['image', 'video', 'audio', 'other'] as Kind[]).map(k => totals[k] > 0 && (
            <div key={k} className={KIND_COLOR[k]} style={{ width: `${(totals[k] / grand) * 100}%` }} title={`${KIND_LABEL[k]} ${fmt(totals[k])}`} />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
          {(['image', 'video', 'audio', 'other'] as Kind[]).filter(k => totals[k] > 0).map(k => (
            <span key={k} className="flex items-center gap-1 text-[9px] text-zinc-500">
              <span className={`w-2 h-2 rounded-sm ${KIND_COLOR[k]}`} />{KIND_LABEL[k]} {fmt(totals[k])}
            </span>
          ))}
        </div>
      </div>

      {/* Browser-side footprint (what the frontend occupies) */}
      <div>
        <span className="text-[11px] font-semibold text-zinc-300">ブラウザ側（フロントエンド）</span>
        <div className="mt-1 space-y-1.5">
          {browser.quota != null && (
            <div>
              <div className="flex justify-between text-[10px] text-zinc-400">
                <span>サイト保存領域</span><span className="tabular-nums">{fmt(browser.usage ?? 0)} / {fmt(browser.quota)}</span>
              </div>
              <div className="h-1.5 rounded bg-zinc-800 overflow-hidden mt-0.5">
                <div className="h-full bg-sky-500" style={{ width: `${Math.min(100, ((browser.usage ?? 0) / browser.quota) * 100)}%` }} />
              </div>
            </div>
          )}
          {browser.heap != null && browser.heapLimit != null && (
            <div>
              <div className="flex justify-between text-[10px] text-zinc-400">
                <span>JSメモリ（ヒープ）</span><span className="tabular-nums">{fmt(browser.heap)} / {fmt(browser.heapLimit)}</span>
              </div>
              <div className="h-1.5 rounded bg-zinc-800 overflow-hidden mt-0.5">
                <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, (browser.heap / browser.heapLimit) * 100)}%` }} />
              </div>
            </div>
          )}
          {browser.quota == null && browser.heap == null && (
            <p className="text-[10px] text-zinc-600">このブラウザは容量APIを公開していません。</p>
          )}
        </div>
      </div>

      {/* Reduction actions */}
      <div className="space-y-1.5">
        <span className="text-[11px] font-semibold text-zinc-300">削減</span>
        <button
          onClick={delUnused} disabled={!unused.length || busy != null}
          className="w-full text-left text-[11px] px-2 py-1.5 rounded bg-zinc-800 hover:bg-red-900/50 disabled:opacity-40 border border-zinc-700"
        >
          🗑 未使用アセットを削除
          <span className="text-zinc-500"> — {unused.length}点 / {fmt(unusedBytes)}</span>
        </button>
        <button
          onClick={proxyAll} disabled={!proxyless.length || busy != null}
          className="w-full text-left text-[11px] px-2 py-1.5 rounded bg-zinc-800 hover:bg-purple-900/50 disabled:opacity-40 border border-zinc-700"
        >
          ⚡ 動画をプロキシ化（軽量プレビュー）
          <span className="text-zinc-500"> — {proxyless.length}本</span>
        </button>
      </div>

      {/* Largest assets */}
      <div>
        <span className="text-[11px] font-semibold text-zinc-300">大きいアセット</span>
        <div className="mt-1 space-y-1">
          {largest.map(a => {
            const k = kindOf(a); const isUnused = !usedIds.has(a.id)
            return (
              <div key={a.id} className="flex items-center gap-2 text-[10px]">
                <span className={`w-2 h-2 rounded-sm flex-shrink-0 ${KIND_COLOR[k]}`} />
                <span className="flex-1 truncate text-zinc-300" title={a.name}>{a.name}</span>
                {isUnused && <span className="text-[8px] px-1 rounded bg-zinc-700 text-zinc-400 flex-shrink-0">未使用</span>}
                {k === 'video' && !a.proxy_path && (
                  <button onClick={() => proxyOne(a)} disabled={busy != null}
                    className="text-[9px] text-purple-400 hover:text-purple-300 flex-shrink-0" title="プロキシ生成">⚡</button>
                )}
                <span className="tabular-nums text-zinc-500 w-14 text-right flex-shrink-0">{fmt(a.file_size_bytes ?? 0)}</span>
                <button onClick={() => delOne(a)} disabled={busy != null}
                  className="text-zinc-600 hover:text-red-400 flex-shrink-0" title="削除">✕</button>
              </div>
            )
          })}
        </div>
      </div>
      <p className="text-[9px] text-zinc-600 leading-tight">
        プロキシ化＝低解像度の代替を作りプレビューを軽量化（書き出しは元素材を使用）。
      </p>
    </div>
  )
}
