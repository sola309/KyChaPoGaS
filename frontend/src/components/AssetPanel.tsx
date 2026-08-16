import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../api/client'
import { assetsApi, assetKind } from '../api/client'
import { useAnalysisStore } from '../store/analysisStore'
import { useJobStore } from '../store/jobStore'

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
  onAssetsChange?: (assets: Asset[]) => void
}

type KindFilter = 'all' | 'video' | 'image' | 'audio'
type SortMode = 'new' | 'old' | 'name'

export function AssetPanel({ projectId, onAssetsChange }: Props) {
  const [assets, setAssets] = useState<Asset[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [genFilter, setGenFilter] = useState<'all' | 'gen' | 'upload'>('all')
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('new')
  // 中間素材(Ref2Vの参照切り出しref_/抽出フレームframe_)は既定で非表示。
  // 数が本編素材を圧倒するため(検索時は常に対象に含める)。
  const [showIntermediate, setShowIntermediate] = useState(false)
  const isIntermediate = (name: string) => name.startsWith('ref_') || name.startsWith('frame_')

  const counts = useMemo(() => {
    const c = { all: assets.length, video: 0, image: 0, audio: 0 }
    for (const a of assets) {
      const k = assetKind(a)
      if (k === 'video') c.video++
      else if (k === 'image') c.image++
      else if (k === 'audio') c.audio++
    }
    return c
  }, [assets])

  const nInter = useMemo(() => assets.filter(a => isIntermediate(a.name)).length, [assets])

  const visible = useMemo(() => {
    let list = assets
    if (!showIntermediate && !query.trim()) list = list.filter(a => !isIntermediate(a.name))
    if (kindFilter !== 'all') list = list.filter(a => assetKind(a) === kindFilter)
    if (genFilter === 'gen') list = list.filter(a => a.asset_type === 'generated')
    if (genFilter === 'upload') list = list.filter(a => a.asset_type !== 'generated')
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      list = list.filter(a => a.name.toLowerCase().includes(q) || String(a.id).includes(q))
    }
    return [...list].sort((a, b) =>
      sortMode === 'new' ? b.id - a.id :
      sortMode === 'old' ? a.id - b.id :
      a.name.localeCompare(b.name))
  }, [assets, kindFilter, genFilter, query, sortMode, showIntermediate])

  const load = async () => {
    const list = await assetsApi.list(projectId)
    setAssets(list)
    onAssetsChange?.(list)
  }

  useEffect(() => { load() }, [projectId])

  // extract-frame等、ジョブを介さないアセット追加からの更新通知
  useEffect(() => {
    const onChanged = () => load()
    window.addEventListener('kychapogas:assets-changed', onChanged)
    return () => window.removeEventListener('kychapogas:assets-changed', onChanged)
  }, [projectId])

  // Refresh the asset list when jobs complete (new precompose/proxy/generated assets)
  const completedCount = useJobStore(s => s.jobs.filter(j => j.status === 'completed').length)
  useEffect(() => { load() }, [completedCount])

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    for (const file of Array.from(files)) {
      try {
        const asset = await assetsApi.upload(projectId, file)
        setAssets(prev => {
          const next = [...prev, asset]
          onAssetsChange?.(next)
          return next
        })
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
    setAssets(prev => {
      const next = prev.filter(a => a.id !== id)
      onAssetsChange?.(next)
      return next
    })
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

      {/* Filter / search / sort */}
      <div className="px-3 pb-2 flex flex-col gap-1.5">
        <div className="flex gap-1">
          {([['all', `すべて ${counts.all}`], ['video', `🎬 ${counts.video}`],
             ['image', `🖼 ${counts.image}`], ['audio', `🎵 ${counts.audio}`]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setKindFilter(k as KindFilter)}
                    className={`text-[10px] px-2 py-1 rounded flex-1 ${
                      kindFilter === k ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                    }`}>{label}</button>
          ))}
        </div>
        <div className="flex gap-1.5 items-center">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="🔍 名前 / #ID"
                 className="flex-1 bg-zinc-800 text-[11px] text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500" />
          <select value={genFilter} onChange={e => setGenFilter(e.target.value as typeof genFilter)}
                  className="bg-zinc-800 text-[10px] text-zinc-300 rounded px-1 py-1 outline-none border border-zinc-700">
            <option value="all">出所</option>
            <option value="gen">✨生成</option>
            <option value="upload">📁取込</option>
          </select>
          <select value={sortMode} onChange={e => setSortMode(e.target.value as SortMode)}
                  className="bg-zinc-800 text-[10px] text-zinc-300 rounded px-1 py-1 outline-none border border-zinc-700">
            <option value="new">新しい順</option>
            <option value="old">古い順</option>
            <option value="name">名前順</option>
          </select>
          <button onClick={() => setShowIntermediate(v => !v)}
                  className={`text-[10px] px-1.5 py-1 rounded border whitespace-nowrap ${
                    showIntermediate ? 'bg-zinc-700 text-zinc-200 border-zinc-500'
                                     : 'bg-zinc-800 text-zinc-500 border-zinc-700 hover:text-zinc-300'}`}
                  title="Ref2Vの参照切り出し(ref_)・抽出フレーム(frame_)の表示切替。検索時は常に対象">
            🧩中間{nInter}
          </button>
        </div>
      </div>

      {/* Asset list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
        {visible.length === 0 && (
          <p className="text-center text-zinc-600 text-xs mt-6">
            {assets.length === 0 ? 'アセットなし' : '条件に合うアセットなし'}
          </p>
        )}
        {visible.map(asset => (
          <AssetCard key={asset.id} asset={asset} onDelete={handleDelete} currentProjectId={projectId} />
        ))}
      </div>
    </div>
  )
}

function AssetCard({ asset, onDelete, currentProjectId }: { asset: Asset; onDelete: (id: number) => void; currentProjectId?: number }) {
  const isForeign = currentProjectId != null && asset.project_id !== currentProjectId
  const handleStar = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await assetsApi.toggleStar(asset.id)
    window.dispatchEvent(new Event('kychapogas:assets-changed'))
  }
  const [thumbError, setThumbError] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [proxying, setProxying] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const handleExtractAudio = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setExtracting(true)
    try {
      await assetsApi.extractAudio(asset.id)
      window.dispatchEvent(new Event('kychapogas:assets-changed'))
    } catch { /* 無音素材など */ } finally { setExtracting(false) }
  }
  const { beats, scenes, loadAnalysis, triggerAudio, triggerVideo } = useAnalysisStore()

  const canAnalyze = asset.asset_type === 'audio' || asset.asset_type === 'video'
  const isVideo = asset.asset_type === 'video' || (asset.asset_type === 'generated' && asset.duration_sec != null)
  const hasProxy = !!asset.proxy_path

  const handleProxy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setProxying(true)
    try { await assetsApi.makeProxy(asset.id) } finally {
      setTimeout(() => setProxying(false), 1500)
    }
  }
  const hasBeat    = !!beats[asset.id]
  const hasScene   = !!scenes[asset.id]

  useEffect(() => {
    if (canAnalyze) loadAnalysis(asset.id)
  }, [asset.id])

  const handleAnalyze = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setAnalyzing(true)
    try {
      if (asset.asset_type === 'audio') await triggerAudio(asset.id)
      else await triggerVideo(asset.id)
    } finally {
      setAnalyzing(false)
    }
  }

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('assetId', String(asset.id))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-800 group cursor-grab active:cursor-grabbing"
      draggable
      onDragStart={handleDragStart}
      title="タイムラインにドラッグ"
    >
      {/* Thumbnail */}
      <div className="w-14 h-9 rounded overflow-hidden bg-zinc-800 flex-shrink-0 flex items-center justify-center">
        {assetKind(asset) !== 'audio' && !thumbError ? (
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
        <p className="text-xs text-zinc-200 truncate flex items-center gap-1">
          <button onClick={handleStar}
                  className={`flex-shrink-0 leading-none ${asset.starred ? 'text-amber-400' : 'text-zinc-600 hover:text-amber-300'}`}
                  title={asset.starred ? '⭐解除(このプロジェクト外から見えなくなる)' : '⭐スター: 全プロジェクトで使えるようにする'}>
            {asset.starred ? '★' : '☆'}
          </button>
          <span className="truncate">{asset.name}</span>
          {isForeign && (
            <span className="flex-shrink-0 text-[9px] px-1 rounded bg-amber-950/60 text-amber-400 border border-amber-800"
                  title={`他プロジェクト(#${asset.project_id})のスター付き共有アセット`}>⭐PJ{asset.project_id}</span>
          )}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span className={`text-[10px] px-1 rounded ${TYPE_BADGE[assetKind(asset)] ?? TYPE_BADGE.generated}`}>
            {assetKind(asset) === 'video' ? '🎬' : assetKind(asset) === 'image' ? '🖼' : assetKind(asset) === 'audio' ? '🎵' : '🧊'}
            {asset.asset_type === 'generated' ? '✨' : ''}
          </span>
          {asset.duration_sec && (
            <span className="text-[10px] text-zinc-500">{formatDuration(asset.duration_sec)}</span>
          )}
          {asset.file_size_bytes && (
            <span className="text-[10px] text-zinc-600">{formatBytes(asset.file_size_bytes)}</span>
          )}
          {/* Analysis badges */}
          {hasBeat && (
            <span className="text-[10px] px-1 rounded bg-emerald-900 text-emerald-300" title="ビート解析済み">
              ♩{beats[asset.id].bpm.toFixed(0)}
            </span>
          )}
          {hasScene && (
            <span className="text-[10px] px-1 rounded bg-sky-900 text-sky-300" title="シーン解析済み">
              {scenes[asset.id].scene_count}S
            </span>
          )}
          {hasProxy && (
            <span className="text-[10px] px-1 rounded bg-zinc-700 text-zinc-300" title="軽量プレビュー用プロキシあり">
              📦
            </span>
          )}
        </div>
      </div>


      {/* アクションメニュー(スマホでも押せる常時表示ボタン) */}
      <button
        onClick={e => { e.stopPropagation(); setMenuOpen(true) }}
        className="text-zinc-400 hover:text-zinc-100 text-base px-1.5 py-1"
        title="操作メニュー"
      >⋯</button>

      {menuOpen && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
             onClick={() => setMenuOpen(false)}>
          <div onClick={e => e.stopPropagation()}
               className="w-[min(420px,94vw)] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-4 flex flex-col gap-1">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-16 h-10 rounded overflow-hidden bg-zinc-800 flex-shrink-0">
                {assetKind(asset) !== 'audio' && (
                  <img src={assetsApi.thumbnailUrl(asset.id)} alt="" className="w-full h-full object-cover"
                       onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-zinc-200 truncate">#{asset.id} {asset.name}</p>
                <p className="text-[10px] text-zinc-500">{assetKind(asset)}{asset.width ? ` ${asset.width}×${asset.height}` : ''}{asset.duration_sec ? ` ${formatDuration(asset.duration_sec)}` : ''}</p>
              </div>
              <button onClick={() => setMenuOpen(false)}
                      className="ml-auto text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
            </div>

            {assetKind(asset) === 'video' && (
              <button onClick={async e => { await handleExtractAudio(e); setMenuOpen(false) }}
                      disabled={extracting}
                      className="text-left text-sm px-3 py-2.5 rounded hover:bg-zinc-800 text-zinc-200 disabled:opacity-40">
                🎵 音声を抽出 <span className="text-[10px] text-zinc-500">→ 音声アセット化(BPM解析・音ハメ用)</span>
              </button>
            )}
            {assetKind(asset) === 'audio' && (
              <button onClick={async e => {
                        e.stopPropagation()
                        await assetsApi.separateVocals(asset.id)
                        setMenuOpen(false)
                      }}
                      className="text-left text-sm px-3 py-2.5 rounded hover:bg-zinc-800 text-zinc-200">
                🎤 歌唱を分離 <span className="text-[10px] text-zinc-500">→「(歌唱)」「(伴奏)」アセット化(Ref2Vリップシンク用)</span>
              </button>
            )}
            {canAnalyze && (
              <button onClick={async e => { await handleAnalyze(e); setMenuOpen(false) }}
                      disabled={analyzing}
                      className="text-left text-sm px-3 py-2.5 rounded hover:bg-zinc-800 text-zinc-200 disabled:opacity-40">
                📊 {asset.asset_type === 'audio' ? 'BPM解析' : 'シーン解析'}
                {(hasBeat || hasScene) && <span className="text-[10px] text-emerald-400 ml-1">解析済み・再実行</span>}
              </button>
            )}
            {isVideo && !hasProxy && (
              <button onClick={async e => { await handleProxy(e); setMenuOpen(false) }}
                      disabled={proxying}
                      className="text-left text-sm px-3 py-2.5 rounded hover:bg-zinc-800 text-zinc-200 disabled:opacity-40">
                📦 軽量プロキシを生成 <span className="text-[10px] text-zinc-500">プレビュー/スクラブが軽くなる</span>
              </button>
            )}
            {/* 元ファイルをそのまま保存する。比較動画や書き出し素材を手元に持ち出す用。 */}
            <a href={assetsApi.downloadUrl(asset.id)} download={asset.name}
               onClick={() => setMenuOpen(false)}
               className="text-left text-sm px-3 py-2.5 rounded hover:bg-zinc-800 text-zinc-200">
              ⬇ ダウンロード <span className="text-[10px] text-zinc-500">元ファイルをそのまま保存</span>
            </a>
            {isForeign ? (
              <p className="text-[10px] text-zinc-500 px-3 py-2">他プロジェクトの共有アセットのため、削除は元のプロジェクトから行ってください</p>
            ) : (
              <button onClick={() => { setMenuOpen(false); onDelete(asset.id) }}
                      className="text-left text-sm px-3 py-2.5 rounded hover:bg-red-950/50 text-red-400">
                🗑 削除
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
