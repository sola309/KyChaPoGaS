import { useState, useEffect, useCallback } from 'react'
import { Sidebar } from './components/Sidebar'
import { ProjectView } from './pages/ProjectView'
import { TerminalPanel } from './components/Terminal/TerminalPanel'
import { GpuStatusBar } from './components/GpuStatusBar'
import { CollabToasts } from './components/CollabToasts'
import { MobileNotice } from './components/MobileNotice'

const MIN_TERM_H  = 160
const MAX_TERM_H  = 600
const DEFAULT_H   = 280

function App() {
  const [termOpen,  setTermOpen]  = useState(false)
  const [termH,     setTermH]     = useState(DEFAULT_H)
  // The embedded terminal can be disabled server-side (KYCHAPOGAS_DISABLE_TERMINAL)
  // so shared collaborators can't get a host shell.
  const [termEnabled, setTermEnabled] = useState(true)

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(d => setTermEnabled(d.terminal_enabled !== false))
      .catch(() => { /* keep default */ })
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

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* GPU / VRAM status bar */}
      <GpuStatusBar />

      {/* Collaboration join/leave toasts */}
      <CollabToasts />

      {/* Small-screen guidance */}
      <MobileNotice />

      {/* Main area (sidebar + editor) */}
      <div className="flex flex-1 min-h-0">
        <Sidebar
          onOpenTerminal={() => termEnabled && setTermOpen(v => !v)}
          termOpen={termOpen}
          terminalEnabled={termEnabled}
        />
        <ProjectView />
      </div>

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
