import { useState, useEffect, useCallback } from 'react'
import { Sidebar } from './components/Sidebar'
import { ProjectView } from './pages/ProjectView'
import { TerminalPanel } from './components/Terminal/TerminalPanel'
import { GpuStatusBar } from './components/GpuStatusBar'
import { CollabToasts } from './components/CollabToasts'
import { MobileNotice } from './components/MobileNotice'
import { BrandLogo } from './components/BrandLogo'
import { CompanionView } from './companion/CompanionView'
import { SettingsModal } from './components/SettingsModal'
import { InspectOverlay } from './components/InspectOverlay'
import { useUIStore } from './store/uiStore'

const MIN_TERM_H  = 160
const MAX_TERM_H  = 600
const DEFAULT_H   = 280

// 埋め込みターミナルUIは一時的に非表示（コードはアーカイブとして保持）。
// 復活させるには true に戻す（バックエンドのIP制限/--no-terminal も併用可）。
const TERMINAL_UI_ENABLED = false

function App() {
  const [termOpen,  setTermOpen]  = useState(false)
  const [termH,     setTermH]     = useState(DEFAULT_H)
  // The embedded terminal can be disabled server-side (KYCHAPOGAS_DISABLE_TERMINAL)
  // so shared collaborators can't get a host shell.
  const [termBackendEnabled, setTermEnabled] = useState(true)
  const termEnabled = TERMINAL_UI_ENABLED && termBackendEnabled

  useEffect(() => {
    if (!TERMINAL_UI_ENABLED) return
    fetch('/api/health')
      .then(r => r.json())
      .then(d => setTermEnabled(d.terminal_enabled !== false))
      .catch(() => { /* keep default */ })
  }, [])

  // Auto-apply UI updates: poll the build id and soft-reload when it changes
  // (so improvements appear without a manual hard reload).
  useEffect(() => {
    let initial: string | null = null
    let reloading = false
    const check = async () => {
      try {
        const { build } = await (await fetch('/api/build-id', { cache: 'no-store' })).json()
        if (!build) return
        if (initial === null) { initial = build; return }
        if (build !== initial && !reloading) {
          reloading = true
          useUIStore.getState().pushToast('新しいバージョンを読み込みます…', 'info')
          setTimeout(() => location.reload(), 900)
        }
      } catch { /* ignore */ }
    }
    const t = setInterval(check, 4000)
    check()
    return () => clearInterval(t)
  }, [])

  // Ctrl+` to toggle terminal (same as VS Code) — only when enabled
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault()
        if (termEnabled) setTermOpen(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [termEnabled])

  // Drag divider to resize terminal height
  const handleDividerDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = termH

    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY   // drag up = bigger terminal
      setTermH(Math.max(MIN_TERM_H, Math.min(MAX_TERM_H, startH + dy)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [termH])

  const navOpen    = useUIStore(s => s.navOpen)
  const panelOpen  = useUIStore(s => s.panelOpen)
  const toggleNav  = useUIStore(s => s.toggleNav)
  const togglePanel = useUIStore(s => s.togglePanel)
  const closeDrawers = useUIStore(s => s.closeDrawers)

  // Platform: one app active at a time (video editor / AI companion …)
  const [activeApp, setActiveApp] = useState<'editor' | 'companion'>('editor')
  const [showSettings, setShowSettings] = useState(false)
  const inspectMode = useUIStore(s => s.inspectMode)
  const setInspectMode = useUIStore(s => s.setInspectMode)
  const APPS = [
    { id: 'editor' as const, label: '🎬 編集' },
    { id: 'companion' as const, label: '🎭 コンパニオン' },
  ]

  return (
    <div className="app-root flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* GPU / VRAM status bar */}
      <GpuStatusBar />

      {/* App launcher — one app active at a time */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-800 bg-zinc-950 flex-shrink-0">
        {APPS.map(a => (
          <button
            key={a.id}
            onClick={() => setActiveApp(a.id)}
            className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
              activeApp === a.id ? 'bg-purple-800 text-purple-100' : 'text-zinc-400 hover:bg-zinc-800'
            }`}
          >{a.label}</button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <BrandLogo className="text-[10px] font-bold tracking-widest text-purple-400/70" />
          <button
            onClick={() => setInspectMode(!inspectMode)}
            className={`px-2 text-lg leading-none rounded ${inspectMode ? 'bg-sky-600' : 'hover:bg-zinc-700'}`}
            title="UIインスペクトモード — クリックした要素をAIと共有"
          >🎯</button>
          <button
            onClick={() => setShowSettings(true)}
            className="text-zinc-400 hover:text-zinc-100 text-sm px-1"
            title="設定（APIキー・プロバイダ・エンジン）"
            aria-label="設定"
          >⚙</button>
        </span>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      <InspectOverlay />

      {/* Collaboration join/leave toasts */}
      <CollabToasts />

      {/* Small-screen guidance */}
      <MobileNotice />

      {/* Mobile/tablet top bar — drawer toggles (hidden on lg where panels are inline) */}
      <div className="lg:hidden flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
        <button
          onClick={toggleNav}
          className="px-2 py-1 rounded text-zinc-300 hover:bg-zinc-800 text-lg leading-none"
          title="プロジェクト一覧"
          aria-label="プロジェクト一覧"
        >☰</button>
        <BrandLogo className="text-xs font-bold tracking-widest text-purple-400" />
        <button
          onClick={togglePanel}
          className="ml-auto px-2 py-1 rounded text-zinc-300 hover:bg-zinc-800"
          title="アセット / 生成 / ジョブ"
          aria-label="アセット / 生成 / ジョブ"
        >✨</button>
      </div>

      {/* Main area — the active app */}
      {activeApp === 'companion' ? (
        <div className="flex flex-1 min-h-0">
          <CompanionView />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 relative">
          {/* Backdrop behind the mobile drawers */}
          {(navOpen || panelOpen) && (
            <div
              className="lg:hidden fixed inset-0 bg-black/50 z-40"
              onClick={closeDrawers}
            />
          )}
          <Sidebar
            onOpenTerminal={() => termEnabled && setTermOpen(v => !v)}
            termOpen={termOpen}
            terminalEnabled={termEnabled}
          />
          <ProjectView />
        </div>
      )}

      {/* Bottom terminal drawer */}
      {termOpen && termEnabled && (
        <>
          {/* Drag handle */}
          <div
            className="h-1.5 flex-shrink-0 bg-zinc-800 hover:bg-purple-700 cursor-row-resize transition-colors"
            onMouseDown={handleDividerDrag}
            title="ターミナルの高さを調整"
          />

          {/* Terminal container */}
          <div
            className="flex flex-col flex-shrink-0 border-t border-zinc-800"
            style={{ height: termH }}
          >
            {/* Terminal toolbar */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 flex-shrink-0">
              <span className="text-xs text-zinc-400 font-mono">
                Terminal
                <span className="text-zinc-600 ml-2 text-[10px]">
                  claude auth — ログイン　claude — Claude Code起動
                </span>
              </span>
              <div className="ml-auto flex items-center gap-1">
                <span className="text-[10px] text-zinc-600">Ctrl+`</span>
                <button
                  onClick={() => setTermOpen(false)}
                  className="ml-2 text-zinc-500 hover:text-zinc-200 text-sm w-5 h-5 flex items-center justify-center"
                  title="ターミナルを閉じる"
                >✕</button>
              </div>
            </div>

            {/* xterm.js mount point */}
            <div className="flex-1 min-h-0">
              <TerminalPanel visible={termOpen} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default App
