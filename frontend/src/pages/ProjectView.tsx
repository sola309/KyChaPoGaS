import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
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
import { CAPTURE } from '../capture'
import { useCompListStore, openCompEditor } from '../components/CompEditor/compList'

// 🎞 コンポジション編集画面は開いたときに読み込む(本体のバンドルを重くしない)
const CompEditor = lazy(() => import('../components/CompEditor/CompEditor').then(m => ({ default: m.CompEditor })))

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
  // 📱 指で触る機械むけ: 「プレビューだけ」(タイムラインを畳む)と、背の低い画面(横持ちのスマホ)でのタイムラインの高さの上限。
  // 横持ち(高さ 390px ほど)では、タイムライン 260px + 見出しでプレビューの高さが 0 になっていた。PC では何も変わらない。
  const [touchUi, setTouchUi] = useState({ coarse: false, short: false })
  // null = まだ選んでいない(背の低い画面では、最初からプレビューだけにする)
  const [previewOnlyPick, setPreviewOnly] = useState<boolean | null>(null)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const c = window.matchMedia('(pointer: coarse)'), s = window.matchMedia('(max-height: 500px)')
    const upd = () => setTouchUi({ coarse: c.matches, short: c.matches && s.matches })
    upd()
    c.addEventListener?.('change', upd); s.addEventListener?.('change', upd)
    return () => { c.removeEventListener?.('change', upd); s.removeEventListener?.('change', upd) }
  }, [])
  const previewOnly = previewOnlyPick ?? touchUi.short
  const hideTimeline = previewOnly && touchUi.coarse && !CAPTURE

  // 🎞 コンポジション: 一覧(comp クリップの名前と「古い」印用)を読み、合図で編集画面を開く
  const [compEditor, setCompEditor] = useState<{ compId: number | null } | null>(null)
  const projectIdForComps = activeProject?.id
  useEffect(() => {
    if (projectIdForComps == null) return
    void useCompListStore.getState().load(projectIdForComps)
    const onOpen = (e: Event) => setCompEditor({ compId: (e as CustomEvent).detail?.compId ?? null })
    window.addEventListener('kychapogas:open-comp', onOpen)
    return () => { window.removeEventListener('kychapogas:open-comp', onOpen); setCompEditor(null) }
  }, [projectIdForComps])

  // アセット一覧は AssetPanel が読み、onAssetsChange でここへ届く(以前はここでも
  // 同じ一覧を取得しており、起動時に同一の5MB応答を3回受けていた)。
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
  // 🎥 撮影用モードでは参加しない(他の人の画面に撮影用ブラウザが現れないように)
  useCollab(CAPTURE ? undefined : activeProject?.id)

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
      {compEditor && (
        <Suspense fallback={null}>
          <CompEditor projectId={activeProject.id} initialCompId={compEditor.compId} onClose={() => setCompEditor(null)} />
        </Suspense>
      )}
      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Project header */}
        <div className="px-4 max-sm:px-2 py-2 max-sm:py-1.5 border-b border-zinc-800 flex items-center gap-4 max-sm:gap-2 flex-shrink-0 bg-zinc-900">
          <h1 className="text-sm font-bold text-white max-sm:truncate max-sm:min-w-0">{activeProject.name}</h1>
          <div className="flex gap-3 text-xs text-zinc-500 max-sm:hidden">
            <span>{activeProject.fps} fps</span>
            <span>{activeProject.width} × {activeProject.height}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {/* スマホ幅: 折り返さない・押しやすい高さ(「コンポジション」は「コンポ」に縮める) */}
            <button
              className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded px-2 py-0.5 whitespace-nowrap flex-shrink-0 max-sm:min-h-[36px] max-sm:text-[13px] max-sm:text-zinc-200"
              title="コンポジション(レイヤーを重ねてキーフレームで動かす、入れ子のタイムライン)を開く"
              aria-label="コンポジションを開く"
              data-open-comp-editor
              onClick={() => openCompEditor(null)}
            >🎞 <span className="max-sm:hidden">コンポジション</span><span className="sm:hidden">コンポ</span></button>
            <button
              className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded px-2 py-0.5 whitespace-nowrap flex-shrink-0 max-sm:min-h-[36px]"
              title="プロジェクト一式を .kycha.zip に書き出し(別ストレージ保管用)"
              onClick={async () => {
                const r = await api.post(`/projects/${activeProject.id}/export`)
                window.open(r.data.download, '_blank')
              }}
            >📦<span className="max-sm:hidden"> 書き出し</span></button>
            {touchUi.coarse && !CAPTURE && (
              <button
                className={`text-xs border rounded px-2 py-0.5 whitespace-nowrap flex-shrink-0 min-h-[36px] ${previewOnly ? 'bg-purple-800 border-purple-500 text-white' : 'border-zinc-700 text-zinc-200'}`}
                aria-pressed={previewOnly}
                title="プレビューだけを大きく出す(タイムラインを畳む)。もう一度押すと戻る"
                data-preview-only={previewOnly ? '1' : '0'}
                onClick={() => setPreviewOnly(!previewOnly)}
              >{previewOnly ? '▤ タイムライン' : '⛶ 大きく'}</button>
            )}
            <span className="max-sm:hidden"><SaveIndicator /></span>
            {!CAPTURE && <CollabBar />}
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 min-h-0">
          <PreviewPlayer assets={assets} onAsset={addAsset} />
        </div>

        {/* Drag divider */}
        <div
          className={`h-2 lg:h-1.5 flex-shrink-0 bg-zinc-800 hover:bg-purple-700 cursor-row-resize transition-colors ${hideTimeline ? 'hidden' : ''}`}
          style={{ touchAction: 'none' }}
          title="タイムラインの高さを調整"
          onPointerDown={handleDividerPointerDown}
        />

        {/* Timeline */}
        {/* 🎥 撮影用モード: タイムラインは中身の高さ(全レーン・全トラック)。残りをプレビューに */}
        <div className={`flex-shrink-0 border-t border-zinc-800 ${hideTimeline ? 'hidden' : ''}`}
             style={{ height: CAPTURE ? 'auto' : touchUi.short ? `min(${timelineH}px, 36dvh)` : timelineH }}>
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
