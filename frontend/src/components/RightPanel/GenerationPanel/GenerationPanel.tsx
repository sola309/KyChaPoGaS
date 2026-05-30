import { useState } from 'react'
import type { Asset } from '../../../api/client'
import { ImageGenPanel } from './ImageGenPanel'
import { AudioGenPanel } from './AudioGenPanel'
import { VideoGenPanel } from './VideoGenPanel'

type GenTab = 'image' | 'audio' | 'video'

const TABS: { id: GenTab; label: string }[] = [
  { id: 'image', label: '🖼 画像' },
  { id: 'audio', label: '🎵 音楽' },
  { id: 'video', label: '🎬 動画' },
]

export function GenerationPanel({ assets }: { assets: Asset[] }) {
  const [tab, setTab] = useState<GenTab>('image')

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
        {tab === 'image' && <ImageGenPanel />}
        {tab === 'audio' && <AudioGenPanel />}
        {tab === 'video' && <VideoGenPanel assets={assets} />}
      </div>
    </div>
  )
}
