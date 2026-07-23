const CACHE = 'gradebook-v1'
const URLS = ['/', '/gradebook/', '/gradebook/index.html', '/gradebook/manifest.json', '/gradebook/icons/icon-192.svg', '/gradebook/icons/icon-512.svg', 'https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.wasm', 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.js']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(URLS)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))))
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  if (e.request.url.includes('sql-wasm.wasm')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)))
    return
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok && e.request.method === 'GET') {
        const clone = res.clone()
        caches.open(CACHE).then(c => c.put(e.request, clone))
      }
      return res
    }).catch(() => caches.match(e.request)))
  )
})
