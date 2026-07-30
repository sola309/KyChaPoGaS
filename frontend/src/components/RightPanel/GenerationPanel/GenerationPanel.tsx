import { useState } from 'react'
import type { Asset } from '../../../api/client'
import { ImageGenPanel } from './ImageGenPanel'
import { VideoGenPanel } from './VideoGenPanel'
import { MotionGfxPanel } from './MotionGfxPanel'
import { Model3DGenPanel } from './Model3DGenPanel'
import { ShotPanel } from './ShotPanel'

// Music moved to its own top-level 🎵 tab (MusicPanel) for lyric/melody crafting.
type GenTab = 'shot' | 'image' | 'video' | 'mg' | 'model3d'

const TABS: { id: GenTab; label: string }[] = [
  { id: 'shot',  label: '🎞 ショット' },
  { id: 'image', label: '🖼 画像' },
  { id: 'video', label: '🎬 動画' },
  { id: 'mg',    label: '⚡ MG' },
  { id: 'model3d', label: '🧊 3D' },
]

export function GenerationPanel({ assets }: { assets: Asset[] }) {
  const [tab, setTab] = useState<GenTab>('shot')

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tabs */}
      <div className="flex border-b border-zinc-800 flex-shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2 text-[11px] transition-colors ${
              tab === t.id
                ? 'text-white border-b-2 border-purple-500 bg-zinc-900'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'shot'  && <ShotPanel assets={assets} />}
        {tab === 'image' && <ImageGenPanel />}
        {tab === 'video' && <VideoGenPanel assets={assets} />}
        {tab === 'mg'    && <MotionGfxPanel />}
        {tab === 'model3d' && <Model3DGenPanel assets={assets} />}
      </div>
    </div>
  )
}
