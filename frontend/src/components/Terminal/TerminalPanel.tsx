/**
 * TerminalPanel — xterm.js embedded terminal connected to the PTY server.
 *
 * Authentication:
 *   Each user logs in with their own Anthropic account via `claude auth`.
 *   KyChaPoGaS does not manage any Claude Code credentials.
 *
 * MCP integration (future):
 *   Run `claude mcp add kychapogas http://localhost:8000/mcp` once
 *   to give Claude Code access to KyChaPoGaS timeline tools.
 */

import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

const WS_URL = '/ws/terminal'   // proxied by Vite dev server → ws://localhost:8765

interface Props {
  visible: boolean
}

export function TerminalPanel({ visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef      = useRef<Terminal | null>(null)
  const fitRef       = useRef<FitAddon | null>(null)
  const wsRef        = useRef<WebSocket | null>(null)
  const initRef      = useRef(false)

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
    if (initRef.current) return
    if (!containerRef.current) return
    initRef.current = true

    const term = new Terminal({
      fontFamily:      '"Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
      fontSize:        13,
      lineHeight:      1.4,
      cursorBlink:     true,
      cursorStyle:     'bar',
      theme: {
        background:  '#09090b',   // zinc-950
        foreground:  '#e4e4e7',   // zinc-200
        cursor:      '#a78bfa',   // purple-400
        selectionBackground: '#3f3f46',
        black:   '#18181b', brightBlack:   '#3f3f46',
        red:     '#ef4444', brightRed:     '#f87171',
        green:   '#22c55e', brightGreen:   '#4ade80',
        yellow:  '#eab308', brightYellow:  '#facc15',
        blue:    '#3b82f6', brightBlue:    '#60a5fa',
        magenta: '#a855f7', brightMagenta: '#c084fc',
        cyan:    '#06b6d4', brightCyan:    '#22d3ee',
        white:   '#d4d4d8', brightWhite:   '#f4f4f5',
      },
      allowProposedApi: true,
    })

    const fitAddon   = new FitAddon()
    const linksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(linksAddon)
    term.open(containerRef.current)
    fitRef.current = fitAddon
    termRef.current = term

    // ── Connect WebSocket ─────────────────────────────────────────────────
    const connect = () => {
      const { cols, rows } = term
      const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_URL}?cols=${cols}&rows=${rows}`
      const ws    = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        term.write('\r\n\x1b[32m[KyChaPoGaS Terminal]\x1b[0m Connected\r\n')
        term.write('\x1b[2m  Tip: type \x1b[0m\x1b[33mclaude\x1b[0m\x1b[2m to start Claude Code\x1b[0m\r\n')
        term.write('\x1b[2m  First time? run \x1b[0m\x1b[33mclaude auth\x1b[0m\x1b[2m to log in\x1b[0m\r\n\r\n')
        fitAddon.fit()
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }

      ws.onmessage = (e) => term.write(e.data)

      ws.onclose = (e) => {
        if (e.code !== 1000) {
          term.write(`\r\n\x1b[31m[disconnected — code ${e.code}]\x1b[0m\r\n`)
          // Auto-reconnect after 3s
          setTimeout(connect, 3000)
        }
      }

      ws.onerror = () => {
        term.write('\r\n\x1b[31m[terminal-server unavailable]\x1b[0m\r\n')
        term.write('\x1b[2m  Start it with: cd terminal-server && node server.js\x1b[0m\r\n')
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
    }
  }, [])

  // Fit when drawer becomes visible
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => doFit())
    }
  }, [visible, doFit])

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-zinc-950"
      style={{ padding: '4px' }}
    />
  )
}
