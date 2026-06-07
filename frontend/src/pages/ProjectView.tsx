import { useState, useEffect, useCallback } from 'react'
import { useProjectStore } from '../store/projectStore'
import { Timeline } from '../components/Timeline/Timeline'
import { PreviewPlayer } from '../components/Preview/PreviewPlayer'
import { RightPanel } from '../components/RightPanel/RightPanel'
import type { Asset } from '../api/client'
import { assetsApi } from '../api/client'
import { useAutoPlaceGenerated } from '../hooks/useAutoPlaceGenerated'
import { useCollab } from '../hooks/useCollab'
import { CollabBar } from '../components/CollabBar'
import { useUIStore } from '../store/uiStore'

const MIN_TIMELINE_H  = 120
const MAX_TIMELINE_H  = 600
const DEFAULT_TIMELINE_H = 260

function SaveIndicator() {
  const pending = useUIStore(s => s.pendingWrites)
  return (
    <span
      className={`text-[10px] flex items-center gap-1 ${pending > 0 ? 'text-amber-400' : 'text-zinc-600'}`}
      title="変更は自動的にサーバへ保存されます"
    >
      {pending > 0
        ? (<><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> 保存中…</>)
        : (<>✓ 自動保存</>)}
    </span>
  )
}

export function ProjectView() {
  const { activeProject } = useProjectStore()
  const [assets, setAssets]       = useState<Asset[]>([])
  const [timelineH, setTimelineH] = useState(DEFAULT_TIMELINE_H)

  useEffect(() => {
    if (!activeProject) return
    assetsApi.list(activeProject.id).then(setAssets)
  }, [activeProject?.id])

  // Add a generated asset to the library (dedup by id)
  const addAsset = useCallback((asset: Asset) => {
    setAssets(prev => prev.some(a => a.id === asset.id) ? prev : [...prev, asset])
  }, [])

  // ①③ Auto-place generated images / videos / music onto the timeline
  useAutoPlaceGenerated(activeProject?.id, activeProject?.fps ?? 30, addAsset)

  // Realtime collaboration presence
  useCollab(activeProject?.id)

  // Resizable split between preview and timeline
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = timelineH

    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY
      setTimelineH(Math.max(MIN_TIMELINE_H, Math.min(MAX_TIMELINE_H, startH + dy)))
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
          <div className="ml-auto flex items-center gap-3">
            <SaveIndicator />
            <CollabBar />
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 min-h-0">
          <PreviewPlayer assets={assets} onAsset={addAsset} />
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

      {/* Right panel: Assets / Generate / Jobs */}
      <RightPanel
        projectId={activeProject.id}
        assets={assets}
        onAssetsChange={setAssets}
      />
    </div>
  )
}
