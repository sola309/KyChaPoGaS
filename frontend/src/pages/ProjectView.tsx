import { useProjectStore } from '../store/projectStore'

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
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">{activeProject.name}</h1>
        {activeProject.description && (
          <p className="text-zinc-400 mt-1">{activeProject.description}</p>
        )}
        <div className="flex gap-4 mt-2 text-sm text-zinc-500">
          <span>{activeProject.fps} fps</span>
          <span>{activeProject.width} × {activeProject.height}</span>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-zinc-500 text-sm">
        タイムライン — Phase 2 で実装予定
      </div>
    </div>
  )
}
