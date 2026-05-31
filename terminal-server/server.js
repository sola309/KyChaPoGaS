/**
 * KyChaPoGaS Terminal Server
 *
 * Cross-platform PTY WebSocket server.
 * Each WebSocket connection gets its own PTY session.
 *
 * Platform detection:
 *   Windows → cmd.exe (or PowerShell if preferred)
 *   Linux   → $SHELL (or /bin/bash)
 *   macOS   → $SHELL (or /bin/zsh)
 *
 * Usage:
 *   node server.js [--port 8765] [--host 127.0.0.1]
 *
 * Claude Code flow:
 *   1. User opens the terminal panel in the browser
 *   2. A PTY session starts with the system shell
 *   3. User types `claude` to launch Claude Code
 *   4. First use: `claude auth` for OAuth login
 *   5. Each user logs in with their own Anthropic account
 */

const os        = require('os')
const path      = require('path')
const pty       = require('node-pty')
const { WebSocketServer } = require('ws')

// ── Config from CLI args / env ────────────────────────────────────────────────
const PORT = Number(process.env.TERMINAL_PORT ?? parseArg('--port', '8765'))
const HOST = process.env.TERMINAL_HOST ?? parseArg('--host', '127.0.0.1')

function parseArg(flag, def) {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def
}

// ── Platform shell detection ──────────────────────────────────────────────────
function detectShell() {
  const platform = os.platform()
  if (platform === 'win32') {
    // Prefer PowerShell if available, fall back to cmd.exe
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

function shellArgs(shell) {
  const platform = os.platform()
  if (platform === 'win32') {
    // PowerShell: start in interactive mode
    if (shell.toLowerCase().includes('powershell')) return []
    return []  // cmd.exe: no extra args needed
  }
  return []  // bash/zsh: just run interactively
}

const SHELL      = detectShell()
const SHELL_ARGS = shellArgs(SHELL)

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ host: HOST, port: PORT })

wss.on('listening', () => {
  console.log(`[terminal-server] Listening on ws://${HOST}:${PORT}`)
  console.log(`[terminal-server] Shell: ${SHELL}  Platform: ${os.platform()}`)
})

wss.on('connection', (ws, req) => {
  const remoteAddr = req.socket.remoteAddress
  console.log(`[terminal-server] New connection from ${remoteAddr}`)

  // Parse initial size from query string (?cols=80&rows=24)
  const url    = new URL(req.url, `ws://${HOST}`)
  const cols   = Number(url.searchParams.get('cols') ?? 120)
  const rows   = Number(url.searchParams.get('rows') ?? 30)

  // Spawn PTY
  let ptyProc
  try {
    ptyProc = pty.spawn(SHELL, SHELL_ARGS, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd:  os.homedir(),
      env:  process.env,
    })
  } catch (err) {
    console.error('[terminal-server] Failed to spawn PTY:', err.message)
    ws.close(1011, 'PTY spawn failed')
    return
  }

  console.log(`[terminal-server] PTY pid=${ptyProc.pid}  cols=${cols} rows=${rows}`)

  // PTY → WS
  ptyProc.onData(data => {
    if (ws.readyState === ws.OPEN) ws.send(data)
  })

  // WS → PTY
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw)
      if (msg.type === 'data') {
        ptyProc.write(msg.data)
      } else if (msg.type === 'resize') {
        ptyProc.resize(
          Math.max(1, msg.cols ?? cols),
          Math.max(1, msg.rows ?? rows),
        )
      }
    } catch {
      // Plain string input (backward compat)
      ptyProc.write(raw.toString())
    }
  })

  // Cleanup
  ptyProc.onExit(({ exitCode }) => {
    console.log(`[terminal-server] PTY exited (code ${exitCode})`)
    if (ws.readyState === ws.OPEN) ws.close()
  })

  ws.on('close', () => {
    console.log(`[terminal-server] WS closed — killing PTY pid=${ptyProc.pid}`)
    try { ptyProc.kill() } catch { /* already dead */ }
  })

  ws.on('error', err => {
    console.error('[terminal-server] WS error:', err.message)
  })
})

wss.on('error', err => {
  console.error('[terminal-server] Server error:', err.message)
  process.exit(1)
})
