import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `vite build --watch` (serve.sh sets KYCHAPOGAS_WATCH=1) rebuilds dist on every
  // source change so the browser auto-reloads (see /api/build-id poller). Poll the
  // filesystem so edits are never missed — native fs events can be dropped on some
  // setups, which would silently break auto-reload. Gated by env so a one-off
  // `vite build` is NOT forced into watch mode.
  build: process.env.KYCHAPOGAS_WATCH
    ? { watch: { buildDelay: 200, chokidar: { usePolling: true, interval: 400 } } }
    : {},
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // Backend REST API
      '/api': {
        target:       'http://localhost:8002',
        changeOrigin: true,
      },
      // Terminal server health check (HTTP)
      '/terminal-health': {
        target:       'http://localhost:8765',
        changeOrigin: true,
        rewrite:      () => '/health',
      },
      // Terminal WebSocket — no path rewrite (rewriting broke the upgrade path)
      '/ws/terminal': {
        target: 'ws://localhost:8765',
        ws:     true,
        // Do NOT rewrite: terminal server accepts any path and parses
        // query string for cols/rows regardless of the path prefix.
      },
    },
  },
})
