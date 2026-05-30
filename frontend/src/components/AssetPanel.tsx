import { useEffect, useRef, useState } from 'react'
import type { Asset } from '../api/client'
import { assetsApi } from '../api/client'

const TYPE_BADGE: Record<string, string> = {
  video: 'bg-blue-900 text-blue-300',
  audio: 'bg-green-900 text-green-300',
  image: 'bg-orange-900 text-orange-300',
  generated: 'bg-purple-900 text-purple-300',
}

function formatDuration(sec: number | null): string {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  projectId: number
}

export function AssetPanel({ projectId }: Props) {
  const [assets, setAssets] = useState<Asset[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    const list = await assetsApi.list(projectId)
    setAssets(list)
  }

  useEffect(() => { load() }, [projectId])

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    for (const file of Array.from(files)) {
      try {
        const asset = await assetsApi.upload(projectId, file)
        setAssets(prev => [...prev, asset])
      } catch {
        // skip failed uploads silently for now
      }
    }
    setUploading(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    handleFiles(e.dataTransfer.files)
  }

  const handleDelete = async (id: number) => {
    await assetsApi.delete(id)
    setAssets(prev => prev.filter(a => a.id !== id))
  }

  return (
    <div className="flex flex-col h-full">
      {/* Upload zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`mx-3 mt-3 mb-2 rounded-lg border-2 border-dashed cursor-pointer flex items-center justify-center py-4 text-sm transition-colors ${
          dragOver
            ? 'border-purple-400 bg-purple-900/20 text-purple-300'
            : 'border-zinc-700 hover:border-zinc-500 text-zinc-500 hover:text-zinc-400'
        }`}
      >
        {uploading ? (
          <span className="animate-pulse">アップロード中...</span>
        ) : (
          <span>クリックまたはドロップでアップロード</span>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />
      </div>

      {/* Asset list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
        {assets.length === 0 && (
          <p className="text-center text-zinc-600 text-xs mt-6">アセットなし</p>
        )}
        {assets.map(asset => (
          <AssetCard key={asset.id} asset={asset} onDelete={handleDelete} />
        ))}
      </div>
    </div>
  )
}

function AssetCard({ asset, onDelete }: { asset: Asset; onDelete: (id: number) => void }) {
  const [thumbError, setThumbError] = useState(false)

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-800 group">
      {/* Thumbnail */}
      <div className="w-14 h-9 rounded overflow-hidden bg-zinc-800 flex-shrink-0 flex items-center justify-center">
        {(asset.asset_type === 'video' || asset.asset_type === 'image') && !thumbError ? (
          <img
            src={assetsApi.thumbnailUrl(asset.id)}
            alt=""
            className="w-full h-full object-cover"
            onError={() => setThumbError(true)}
          />
        ) : (
          <span className="text-lg">
            {asset.asset_type === 'audio' ? '🎵' : asset.asset_type === 'generated' ? '✨' : '🎬'}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-200 truncate">{asset.name}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`text-[10px] px-1 rounded ${TYPE_BADGE[asset.asset_type] ?? TYPE_BADGE.generated}`}>
            {asset.asset_type}
          </span>
          {asset.duration_sec && (
            <span className="text-[10px] text-zinc-500">{formatDuration(asset.duration_sec)}</span>
          )}
          {asset.file_size_bytes && (
            <span className="text-[10px] text-zinc-600">{formatBytes(asset.file_size_bytes)}</span>
          )}
        </div>
      </div>

      {/* Delete */}
      <button
        onClick={() => onDelete(asset.id)}
        className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs px-1 transition-opacity"
        title="削除"
      >✕</button>
    </div>
  )
}
