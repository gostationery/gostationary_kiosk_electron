const CACHE_NAME = 'gostationary-kiosk-v2'

const PRECACHE_ASSETS = [
  '/manifest.json',
]

// Patterns that must never be cached – Vite dev server internals and
// versioned module chunks. Caching these causes stale React instances
// (two copies of React → "Invalid hook call") and broken HMR WebSocket.
function shouldSkipCache(url) {
  const u = new URL(url)
  const p = u.pathname
  const q = u.search

  // Vite dev-server internals
  if (p.startsWith('/@vite/')) return true
  if (p.startsWith('/@fs/')) return true
  if (p.startsWith('/@react-refresh')) return true
  if (p.startsWith('/__vite')) return true

  // Vite-versioned module chunks (?v=... or ?t=...)
  if (/[?&][vt]=/.test(q)) return true

  // Node modules bundled by Vite
  if (p.includes('/node_modules/')) return true

  // API calls
  if (p.startsWith('/api/')) return true

  return false
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  // Never intercept Vite dev-server or versioned module requests
  if (shouldSkipCache(event.request.url)) return

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        }
        return response
      })
    })
  )
})
