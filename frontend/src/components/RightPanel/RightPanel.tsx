import { useState, useEffect } from 'react'
import type { Asset } from '../../api/client'
import { AssetPanel } from '../AssetPanel'
import { GenerationPanel } from './GenerationPanel/GenerationPanel'
import { JobQueuePanel } from './JobQueuePanel'
import { useJobStore } from '../../store/jobStore'

type PanelTab = 'assets' | 'generate' | 'jobs'

interface Props {
  projectId: number
  onAssetsChange: (assets: Asset[]) => void
  assets: Asset[]
}

const TABS: { id: PanelTab; label: string; title: string }[] = [
  { id: 'assets',   label: '📂', title: 'アセット' },
  { id: 'generate', label: '✨', title: '生成' },
  { id: 'jobs',     label: '⚙',  title: 'ジョブキュー' },
]

export function RightPanel({ projectId, onAssetsChange, assets }: Props) {
  const [tab, setTab] = useState<PanelTab>('assets')
  const { startSSE, stopSSE, checkComfyUI, jobs } = useJobStore()

  const runningCount = jobs.filter(j => j.status === 'running' || j.status === 'pending').length

  useEffect(() => {
    startSSE(projectId)
    checkComfyUI()
    return () => stopSSE()
  }, [projectId])

  return (
    <div className="flex flex-col w-56 border-l border-zinc-800 flex-shrink-0 h-full">
      {/* Tab bar */}
      <div className="flex border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            title={t.title}
            className={`flex-1 py-2 text-base relative transition-colors ${
              tab === t.id
                ? 'text-white bg-zinc-800'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
            }`}
          >
            {t.label}
            {/* Badge for running jobs */}
            {t.id === 'jobs' && runningCount > 0 && (
              <span className="absolute top-1 right-1 w-3.5 h-3.5 rounded-full bg-blue-500 text-[8px] text-white flex items-center justify-center">
                {runningCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Panel title */}
      <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
        <span className="text-xs text-zinc-500 uppercase tracking-wider">
          {TABS.find(t => t.id === tab)?.title}
        </span>
      </div>

      {/* Panel content */}
      <div className="flex-1 min-h-0">
        {tab === 'assets' && (
          <AssetPanel projectId={projectId} onAssetsChange={onAssetsChange} />
        )}
        {tab === 'generate' && (
          <GenerationPanel assets={assets} />
        )}
        {tab === 'jobs' && (
          <JobQueuePanel />
        )}
      </div>
    </div>
  )
}
