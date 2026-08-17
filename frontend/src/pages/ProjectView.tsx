import { useState, useEffect, useCallback, useRef } from 'react'
import { useProjectStore } from '../store/projectStore'
import { Timeline } from '../components/Timeline/Timeline'
import { PreviewPlayer } from '../components/Preview/PreviewPlayer'
import { RightPanel } from '../components/RightPanel/RightPanel'
import { ShotEditor } from '../components/ShotEditor/ShotEditor'
import { useUIStore } from '../store/uiStore'
import { useTimelineStore } from '../store/timelineStore'
import type { Asset } from '../api/client'
import { assetsApi, api } from '../api/client'
import { useAutoPlaceGenerated } from '../hooks/useAutoPlaceGenerated'
import { useCollab } from '../hooks/useCollab'
import { CollabBar } from '../components/CollabBar'

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
  const shotEditor = useUIStore(st => st.shotEditor)
  const closeShotEditor = useUIStore(st => st.closeShotEditor)
  const [timelineH, setTimelineH] = useState(DEFAULT_TIMELINE_H)

  useEffect(() => {
    if (!activeProject) return
    assetsApi.list(activeProject.id).then(setAssets)
  }, [activeProject?.id])

  // 別プロジェクト所属の素材(複製プロジェクトのクリップが参照)は一覧に来ないため、
  // クリップの参照から不足分を個別取得して合流する。これが無いとプレビューが
  // 素材の種別を判定できず、動画が永遠に「読込中」になる(AniPAFE 24fps の clip840)。
  const tlClips = useTimelineStore(st => st.clips)
  const fetchedMissing = useRef<Set<number>>(new Set())
  useEffect(() => {
    const have = new Set(assets.map(a => a.id))
    const missing = [...new Set(tlClips.map(c => c.asset_id)
      .filter((x): x is number => x != null && !have.has(x) && !fetchedMissing.current.has(x)))]
    if (!missing.length) return
    missing.forEach(id => fetchedMissing.current.add(id))
    void Promise.all(missing.map(id => assetsApi.get(id).catch(() => null)))
      .then(rs => {
        const got = rs.filter((a): a is Asset => !!a)
        if (got.length) setAssets(prev => {
          const h = new Set(prev.map(a => a.id))
          return [...prev, ...got.filter(a => !h.has(a.id))]
        })
      })
  }, [tlClips, assets])

  // Add a generated asset to the library (dedup by id)
  const addAsset = useCallback((asset: Asset) => {
    setAssets(prev => prev.some(a => a.id === asset.id) ? prev : [...prev, asset])
  }, [])

  // ①③ Auto-place generated images / videos / music onto the timeline
  useAutoPlaceGenerated(activeProject?.id, activeProject?.fps ?? 30, addAsset)

  // 📋 クリップボード貼り付け: 画像をアセットとして取り込む(Ctrl+V / ⌘V)
  useEffect(() => {
    const pid = activeProject?.id
    if (!pid) return
    const onPaste = async (e: ClipboardEvent) => {
      // 入力欄への通常ペーストは邪魔しない
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (!file) continue
          const named = new File([file], `paste_${Date.now()}.png`, { type: file.type })
          const asset = await assetsApi.upload(pid, named)
          addAsset(asset)
          window.dispatchEvent(new Event('kychapogas:assets-changed'))
          useUIStore.getState().pushToast(`📋 貼り付け画像をアセット#${asset.id}として追加しました`, 'success')
          return
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [activeProject?.id])

  // Realtime collaboration presence
  useCollab(activeProject?.id)

  // Resizable split between preview and timeline (Pointer Events → touch + mouse)
  const handleDividerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = timelineH

    const onMove = (ev: PointerEvent) => {
      const dy = startY - ev.clientY
      setTimelineH(Math.max(MIN_TIMELINE_H, Math.min(MAX_TIMELINE_H, startH + dy)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
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
      {shotEditor && (
        <ShotEditor projectId={activeProject.id} shotId={shotEditor.shotId}
          onClose={closeShotEditor} />
      )}
      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Project header */}
        <div className="px-4 max-sm:px-2 py-2 max-sm:py-1.5 border-b border-zinc-800 flex items-center gap-4 max-sm:gap-2 flex-shrink-0 bg-zinc-900">
          <h1 className="text-sm font-bold text-white">{activeProject.name}</h1>
          <div className="flex gap-3 text-xs text-zinc-500 max-sm:hidden">
            <span>{activeProject.fps} fps</span>
            <span>{activeProject.width} × {activeProject.height}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button
              className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded px-2 py-0.5"
              title="プロジェクト一式を .kycha.zip に書き出し(別ストレージ保管用)"
              onClick={async () => {
                const r = await api.post(`/projects/${activeProject.id}/export`)
                window.open(r.data.download, '_blank')
              }}
            >📦 書き出し</button>
            <span className="max-sm:hidden"><SaveIndicator /></span>
            <CollabBar />
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 min-h-0">
          <PreviewPlayer assets={assets} onAsset={addAsset} />
        </div>

        {/* Drag divider */}
        <div
          className="h-2 lg:h-1.5 flex-shrink-0 bg-zinc-800 hover:bg-purple-700 cursor-row-resize transition-colors"
          style={{ touchAction: 'none' }}
          title="タイムラインの高さを調整"
          onPointerDown={handleDividerPointerDown}
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
