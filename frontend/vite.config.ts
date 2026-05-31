import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // Backend REST API
      '/api': {
        target:       'http://localhost:8000',
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
