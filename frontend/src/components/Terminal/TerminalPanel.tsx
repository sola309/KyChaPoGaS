/**
 * TerminalPanel — xterm.js embedded terminal connected to the PTY server.
 *
 * Auth model:
 *   Each user logs in with their own Anthropic account via `claude auth`.
 *   KyChaPoGaS does not manage any Claude Code credentials.
 *
 * MCP (future):
 *   claude mcp add kychapogas http://localhost:8000/mcp
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal }       from '@xterm/xterm'
import { FitAddon }       from '@xterm/addon-fit'
import { WebLinksAddon }  from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

const HEALTH_URL = '/terminal-health'   // → proxied to http://localhost:8765/health
const WS_PATH    = '/ws/terminal'       // → proxied to ws://localhost:8765

interface Props { visible: boolean }

type ServerStatus = 'checking' | 'online' | 'offline'

export function TerminalPanel({ visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef      = useRef<Terminal | null>(null)
  const fitRef       = useRef<FitAddon | null>(null)
  const wsRef        = useRef<WebSocket | null>(null)
  const initRef      = useRef(false)
  const [status, setStatus] = useState<ServerStatus>('checking')
  const [info,   setInfo]   = useState<string>('')

  // ── Health check ──────────────────────────────────────────────────────────
  const checkHealth = useCallback(async () => {
    setStatus('checking')
    try {
      const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) })
      if (r.ok) {
        const d = await r.json()
        setStatus('online')
        setInfo(`${d.platform} · ${d.shell}`)
      } else {
        setStatus('offline')
      }
    } catch {
      setStatus('offline')
    }
  }, [])

  useEffect(() => { checkHealth() }, [checkHealth])

  // ── Resize helper ─────────────────────────────────────────────────────────
  const doFit = useCallback(() => {
    if (!fitRef.current || !termRef.current || !wsRef.current) return
    fitRef.current.fit()
    const { cols, rows } = termRef.current
    if (wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [])

  // ── Init terminal once ────────────────────────────────────────────────────
  useEffect(() => {
    if (initRef.current || status !== 'online') return
    if (!containerRef.current) return
    initRef.current = true

    const term = new Terminal({
      fontFamily:       '"Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
      fontSize:         13,
      lineHeight:       1.4,
      cursorBlink:      true,
      cursorStyle:      'bar',
      allowProposedApi: true,
      theme: {
        background:         '#09090b',
        foreground:         '#e4e4e7',
        cursor:             '#a78bfa',
        selectionBackground:'#3f3f46',
        black:   '#18181b', brightBlack:   '#3f3f46',
        red:     '#ef4444', brightRed:     '#f87171',
        green:   '#22c55e', brightGreen:   '#4ade80',
        yellow:  '#eab308', brightYellow:  '#facc15',
        blue:    '#3b82f6', brightBlue:    '#60a5fa',
        magenta: '#a855f7', brightMagenta: '#c084fc',
        cyan:    '#06b6d4', brightCyan:    '#22d3ee',
        white:   '#d4d4d8', brightWhite:   '#f4f4f5',
      },
    })

    const fitAddon   = new FitAddon()
    const linksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(linksAddon)
    term.open(containerRef.current)
    fitAddon.fit()
    fitRef.current = fitAddon
    termRef.current = term

    // ── Connect WebSocket ─────────────────────────────────────────────────
    const connect = () => {
      const { cols, rows } = term
      const proto  = location.protocol === 'https:' ? 'wss' : 'ws'
      const wsUrl  = `${proto}://${location.host}${WS_PATH}?cols=${cols}&rows=${rows}`
      const ws     = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('online')
        term.write('\r\n\x1b[32m[KyChaPoGaS Terminal]\x1b[0m 接続しました\r\n')
        term.write('\x1b[2m  claude auth\x1b[0m\x1b[2m — Anthropicアカウントでログイン\x1b[0m\r\n')
        term.write('\x1b[2m  claude      \x1b[0m\x1b[2m — Claude Code を起動\x1b[0m\r\n\r\n')
        fitAddon.fit()
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }

      ws.onmessage = (e) => term.write(e.data)

      ws.onclose = (e) => {
        if (e.code !== 1000) {
          term.write(`\r\n\x1b[33m[切断 code=${e.code}]\x1b[0m 3秒後に再接続…\r\n`)
          setTimeout(connect, 3000)
        }
      }

      ws.onerror = () => {
        // onclose will follow
      }

      term.onData(data => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data }))
        }
      })
    }

    connect()

    // ── Resize observer ───────────────────────────────────────────────────
    const ro = new ResizeObserver(() => doFit())
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      wsRef.current?.close(1000)
      term.dispose()
      initRef.current = false
      fitRef.current  = null
      termRef.current = null
      wsRef.current   = null
    }
  }, [status])   // re-init when server comes online

  // Fit when drawer becomes visible
  useEffect(() => {
    if (visible) requestAnimationFrame(() => doFit())
  }, [visible, doFit])

  // ── Offline state UI ──────────────────────────────────────────────────────
  if (status === 'checking') {
    return (
      <div className="flex items-center justify-center h-full bg-zinc-950 text-zinc-500 text-sm">
        ターミナルサーバーを確認中…
      </div>
    )
  }

  if (status === 'offline') {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-zinc-950 gap-4 px-6 text-center">
        <div className="text-zinc-400 font-mono text-sm">
          <p className="text-red-400 mb-3">ターミナルサーバー未起動</p>
          <p className="text-zinc-500 text-xs mb-4">
            別のターミナルで以下を実行してください：
          </p>
          <div className="bg-zinc-900 border border-zinc-700 rounded px-4 py-3 text-left text-xs space-y-1">
            <p className="text-zinc-500"># プロジェクトルートで</p>
            <p className="text-green-400">cd terminal-server</p>
            <p className="text-green-400">node server.js</p>
          </div>
        </div>
        <button
          onClick={() => { checkHealth() }}
          className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
        >
          再確認する
        </button>
        {info && <p className="text-[10px] text-zinc-600">{info}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Status bar */}
      <div className="flex items-center gap-2 px-2 py-0.5 bg-zinc-900/80 flex-shrink-0 border-b border-zinc-800">
        <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
        <span className="text-[9px] text-zinc-500 truncate">{info}</span>
      </div>
      {/* xterm.js mount point */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-zinc-950"
        style={{ padding: '4px' }}
      />
    </div>
  )
}
