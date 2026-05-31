/**
 * KyChaPoGaS Terminal Server
 *
 * Cross-platform PTY WebSocket server.
 * Uses a single HTTP server so both /health and WebSocket share one port.
 *
 * Platform detection:
 *   Windows → %COMSPEC% (cmd.exe) or PowerShell
 *   Linux   → $SHELL or /bin/bash
 *   macOS   → $SHELL or /bin/zsh
 *
 * Claude Code auth flow:
 *   1. User opens Terminal panel → gets a shell session
 *   2. Type `claude auth` to log in with their own Anthropic account
 *   3. Type `claude` to start Claude Code
 *   KyChaPoGaS manages no credentials — each user uses their own account.
 */

const http  = require('http')
const os    = require('os')
const path  = require('path')
const { WebSocketServer } = require('ws')
const pty   = require('node-pty')

// Project root = parent of terminal-server/
const PROJECT_ROOT = path.resolve(__dirname, '..')

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.TERMINAL_PORT ?? parseArg('--port', '8765'))
const HOST = process.env.TERMINAL_HOST ?? parseArg('--host', '127.0.0.1')

function parseArg(flag, def) {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def
}

// ── Platform shell detection ──────────────────────────────────────────────────
function detectShell() {
  const p = os.platform()
  if (p === 'win32') return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || (p === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

const SHELL = detectShell()

// ── HTTP server (health + WebSocket upgrade) ──────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/ws/terminal/health') {
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify({
      ok:       true,
      platform: os.platform(),
      shell:    SHELL,
      port:     PORT,
    }))
    return
  }
  res.writeHead(404)
  res.end()
})

// ── WebSocket server attached to the same HTTP server ─────────────────────────
const wss = new WebSocketServer({ server: httpServer })

httpServer.listen(PORT, HOST, () => {
  console.log(`[terminal-server] Listening on http://${HOST}:${PORT}`)
  console.log(`[terminal-server]   Health : http://${HOST}:${PORT}/health`)
  console.log(`[terminal-server]   WS     : ws://${HOST}:${PORT}`)
  console.log(`[terminal-server]   Shell  : ${SHELL}  (${os.platform()})`)
})

httpServer.on('error', err => {
  console.error('[terminal-server] HTTP server error:', err.message)
  process.exit(1)
})

// ── Connection handler ────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log(`[terminal-server] WS connected from ${req.socket.remoteAddress}`)

  // Parse initial size from query string
  // URL may be '/ws/terminal?cols=120&rows=30' or just '?cols=120&rows=30'
  let cols = 120, rows = 30
  try {
    const rawUrl = req.url || '/'
    const base   = rawUrl.startsWith('/') ? `http://localhost${rawUrl}` : `http://localhost/${rawUrl}`
    const url    = new URL(base)
    cols = Number(url.searchParams.get('cols') || 120)
    rows = Number(url.searchParams.get('rows') || 30)
  } catch { /* keep defaults */ }

  // Spawn PTY
  let ptyProc
  try {
    ptyProc = pty.spawn(SHELL, [], {
      name: 'xterm-256color',
      cols: Math.max(1, cols),
      rows: Math.max(1, rows),
      cwd:  PROJECT_ROOT,
      env:  process.env,
    })
  } catch (err) {
    console.error('[terminal-server] PTY spawn failed:', err.message)
    ws.close(1011, 'PTY spawn failed')
    return
  }

  console.log(`[terminal-server] PTY pid=${ptyProc.pid} cols=${cols} rows=${rows}`)

  // PTY → WS
  ptyProc.onData(data => {
    if (ws.readyState === ws.OPEN) ws.send(data)
  })

  // WS → PTY
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'data') {
        ptyProc.write(msg.data)
      } else if (msg.type === 'resize') {
        const c = Math.max(1, msg.cols ?? cols)
        const r = Math.max(1, msg.rows ?? rows)
        ptyProc.resize(c, r)
      }
    } catch {
      // Plain string fallback
      ptyProc.write(raw.toString())
    }
  })

  // Cleanup
  ptyProc.onExit(({ exitCode }) => {
    console.log(`[terminal-server] PTY pid=${ptyProc.pid} exited (code ${exitCode})`)
    if (ws.readyState === ws.OPEN) ws.close()
  })

  ws.on('close', () => {
    console.log(`[terminal-server] WS closed — killing PTY pid=${ptyProc.pid}`)
    try { ptyProc.kill() } catch { /* already exited */ }
  })

  ws.on('error', err => console.error('[terminal-server] WS error:', err.message))
})
