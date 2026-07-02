import { useState, useEffect } from 'react'
import type { Asset } from '../../api/client'
import { AssetPanel } from '../AssetPanel'
import { GenerationPanel } from './GenerationPanel/GenerationPanel'
import { JobQueuePanel } from './JobQueuePanel'
import { LayerPanel } from './LayerPanel'
import { StoragePanel } from './StoragePanel'
import { MusicPanel } from './MusicPanel'
import { useJobStore } from '../../store/jobStore'
import { useUIStore } from '../../store/uiStore'

type PanelTab = 'assets' | 'layers' | 'generate' | 'music' | 'jobs' | 'storage'

interface Props {
  projectId: number
  onAssetsChange: (assets: Asset[]) => void
  assets: Asset[]
}

const TABS: { id: PanelTab; label: string; title: string }[] = [
  { id: 'assets',   label: '📂', title: 'アセット' },
  { id: 'layers',   label: '🗂', title: 'レイヤー' },
  { id: 'generate', label: '✨', title: '生成' },
  { id: 'music',    label: '🎵', title: '音楽スタジオ' },
  { id: 'storage',  label: '💾', title: '容量' },
  { id: 'jobs',     label: '⚙',  title: 'ジョブキュー' },
]

export function RightPanel({ projectId, onAssetsChange, assets }: Props) {
  const [tab, setTab] = useState<PanelTab>('assets')
  const panelOpen = useUIStore(s => s.panelOpen)
  const closeDrawers = useUIStore(s => s.closeDrawers)
  const { startSSE, stopSSE, checkComfyUI, jobs } = useJobStore()

  const runningCount = jobs.filter(j => j.status === 'running' || j.status === 'pending').length

  useEffect(() => {
    startSSE(projectId)
    checkComfyUI()
    return () => stopSSE()
  }, [projectId])

  return (
    <div
      className={`flex flex-col w-64 max-w-[85vw] border-l border-zinc-800 h-full bg-zinc-900
        fixed inset-y-0 right-0 z-50 transition-transform duration-200
        lg:static lg:z-auto lg:max-w-none lg:flex-shrink-0 lg:translate-x-0
        ${panelOpen ? 'translate-x-0' : 'translate-x-full'}`}
    >
      {/* Tab bar */}
      <div className="flex border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
        {/* Close (mobile drawer only) */}
        <button
          onClick={closeDrawers}
          className="lg:hidden px-3 text-zinc-500 hover:text-zinc-200"
          title="閉じる"
          aria-label="パネルを閉じる"
        >✕</button>
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
      <div className="flex-1 min-h-0 relative">
        <div className={`absolute inset-0 ${tab === 'assets'   ? '' : 'hidden'}`}>
          <AssetPanel projectId={projectId} onAssetsChange={onAssetsChange} />
        </div>
        <div className={`absolute inset-0 ${tab === 'layers'   ? '' : 'hidden'}`}>
          <LayerPanel assets={assets} />
        </div>
        <div className={`absolute inset-0 ${tab === 'generate' ? '' : 'hidden'}`}>
          <GenerationPanel assets={assets} />
        </div>
        <div className={`absolute inset-0 ${tab === 'music'    ? '' : 'hidden'}`}>
          <MusicPanel assets={assets} />
        </div>
        <div className={`absolute inset-0 ${tab === 'storage'  ? '' : 'hidden'}`}>
          <StoragePanel projectId={projectId} assets={assets} onAssetsChange={onAssetsChange} />
        </div>
        <div className={`absolute inset-0 ${tab === 'jobs'     ? '' : 'hidden'}`}>
          <JobQueuePanel />
        </div>
      </div>
    </div>
  )
}
