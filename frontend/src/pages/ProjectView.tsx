import { useState, useEffect, useCallback } from 'react'
import { useProjectStore } from '../store/projectStore'
import { AssetPanel } from '../components/AssetPanel'
import { Timeline } from '../components/Timeline/Timeline'
import { PreviewPlayer } from '../components/Preview/PreviewPlayer'
import type { Asset } from '../api/client'
import { assetsApi } from '../api/client'

const MIN_TIMELINE_H  = 120
const MAX_TIMELINE_H  = 600
const DEFAULT_TIMELINE_H = 260

export function ProjectView() {
  const { activeProject } = useProjectStore()
  const [assets, setAssets]         = useState<Asset[]>([])
  const [timelineH, setTimelineH]   = useState(DEFAULT_TIMELINE_H)

  useEffect(() => {
    if (!activeProject) return
    assetsApi.list(activeProject.id).then(setAssets)
  }, [activeProject?.id])

  // Space bar: play/pause (handled globally here so it works from preview area)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.code === 'Space' && (e.ctrlKey || e.metaKey || e.altKey) === false) {
        e.preventDefault()
        // Toggle play via timeline keyboard — we trigger the timeline's play button
        document.getElementById('preview-play-btn')?.click()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Resizable split between preview and timeline
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = timelineH

    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY  // dragging up = increase timeline height
      const newH = Math.max(MIN_TIMELINE_H, Math.min(MAX_TIMELINE_H, startH + dy))
      setTimelineH(newH)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [timelineH])

  if (!activeProject) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-600">
        <div className="text-center">
          <p className="text-4xl mb-4">🎬</p>
          <p className="text-lg">プロジェクトを選択または作成してください</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Project header */}
        <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-4 flex-shrink-0 bg-zinc-900">
          <h1 className="text-sm font-bold text-white">{activeProject.name}</h1>
          <div className="flex gap-3 text-xs text-zinc-500">
            <span>{activeProject.fps} fps</span>
            <span>{activeProject.width} × {activeProject.height}</span>
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 min-h-0">
          <PreviewPlayer assets={assets} />
        </div>

        {/* Drag divider */}
        <div
          className="h-1.5 flex-shrink-0 bg-zinc-800 hover:bg-purple-700 cursor-row-resize transition-colors"
          title="タイムラインの高さを調整"
          onMouseDown={handleDividerMouseDown}
        />

        {/* Timeline */}
        <div className="flex-shrink-0 border-t border-zinc-800" style={{ height: timelineH }}>
          <Timeline
            projectId={activeProject.id}
            fps={activeProject.fps}
            assets={assets}
          />
        </div>
      </div>

      {/* Asset panel */}
      <div className="w-56 border-l border-zinc-800 flex flex-col flex-shrink-0">
        <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-900">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">Assets</span>
        </div>
        <AssetPanel
          projectId={activeProject.id}
          onAssetsChange={setAssets}
        />
      </div>
    </div>
  )
}
