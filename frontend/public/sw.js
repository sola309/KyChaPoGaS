/*
 * Minimal service worker — makes KyChaPoGaS an installable PWA and serves the
 * app shell when offline. We deliberately do NOT cache /api/* (live data) or the
 * hashed JS/CSS bundles aggressively: the app's own build-id poller handles
 * updates, so the SW uses network-first for navigation and stale-while-revalidate
 * for static assets only.
 */
const SHELL = 'kychapogas-shell-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.add('/')).catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET') return
  // never intercept API, websockets, media streams, or cross-origin
  if (url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return

  // navigations: network-first, fall back to cached shell when offline
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone(); caches.open(SHELL).then(c => c.put('/', copy)).catch(() => {})
        return r
      }).catch(() => caches.match('/'))
    )
    return
  }

  // static assets: stale-while-revalidate
  if (/\.(js|css|png|jpg|jpeg|webp|svg|woff2?|ico|webmanifest)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const net = fetch(e.request).then(r => {
          const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {})
          return r
        }).catch(() => cached)
        return cached || net
      })
    )
  }
})
