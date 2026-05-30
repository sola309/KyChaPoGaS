import { useProjectStore } from '../store/projectStore'
import { AssetPanel } from '../components/AssetPanel'

export function ProjectView() {
  const { activeProject } = useProjectStore()

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
        <div className="px-6 py-3 border-b border-zinc-800 flex items-center gap-4">
          <h1 className="text-lg font-bold text-white">{activeProject.name}</h1>
          <div className="flex gap-3 text-xs text-zinc-500">
            <span>{activeProject.fps} fps</span>
            <span>{activeProject.width} × {activeProject.height}</span>
          </div>
        </div>

        {/* Preview + Timeline placeholder */}
        <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
          <div className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 flex items-center justify-center text-zinc-600 text-sm">
            プレビュー — Phase 2 で実装予定
          </div>
          <div className="h-32 rounded-lg border border-zinc-800 bg-zinc-900 flex items-center justify-center text-zinc-600 text-sm">
            タイムライン — Phase 2 で実装予定
          </div>
        </div>
      </div>

      {/* Asset panel */}
      <div className="w-64 border-l border-zinc-800 flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-800">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">Assets</span>
        </div>
        <AssetPanel projectId={activeProject.id} />
      </div>
    </div>
  )
}
