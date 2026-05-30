import { useState, useEffect } from 'react'
import { useProjectStore } from '../store/projectStore'
import { AssetPanel } from '../components/AssetPanel'
import { Timeline } from '../components/Timeline/Timeline'
import type { Asset } from '../api/client'
import { assetsApi } from '../api/client'

export function ProjectView() {
  const { activeProject } = useProjectStore()
  const [assets, setAssets] = useState<Asset[]>([])

  useEffect(() => {
    if (!activeProject) return
    assetsApi.list(activeProject.id).then(setAssets)
  }, [activeProject?.id])

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
        {/* Header */}
        <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-4 flex-shrink-0 bg-zinc-900">
          <h1 className="text-sm font-bold text-white">{activeProject.name}</h1>
          <div className="flex gap-3 text-xs text-zinc-500">
            <span>{activeProject.fps} fps</span>
            <span>{activeProject.width} × {activeProject.height}</span>
          </div>
        </div>

        {/* Preview (placeholder) */}
        <div className="flex-1 bg-black flex items-center justify-center text-zinc-700 text-sm min-h-0">
          プレビュー — Phase 2 後半で実装予定
        </div>

        {/* Timeline */}
        <div className="h-64 border-t border-zinc-800 flex-shrink-0">
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
