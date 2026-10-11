const CACHE_NAME = 'calendar-app-v1.0.5';
const CORE_ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './pako.min.js',
  './jszip.min.js',
  './sql-wasm.js',
  './sql-wasm.wasm',
  './pdf.min.js',
  './pdf.worker.min.js',
  './taxonomy_seed.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(CORE_ASSETS).catch((err) => {
        console.warn('Some core assets could not be pre-cached during install:', err);
      });
      // Optionally cache bundled db if present (will be omitted on GitHub Pages)
      try {
        await cache.add('./SRG_Calendar.db');
      } catch(e) {}
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Support manual or instant update skip waiting
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (e) => {
  // Ignore chrome-extension or unsupported schemes
  if (!e.request.url.startsWith('http')) return;

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(e.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback for navigation requests
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
