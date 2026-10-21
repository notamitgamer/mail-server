// Phase 1 service worker: makes the app installable and keeps the app shell
// (not your mail) available. Bump CACHE when shipping changes to cached files.
const CACHE = 'mail-shell-v1';
const SHELL = [
  '/', '/manifest.webmanifest', '/icons/icon-192.png',
  '/assets/css/style.min.css', '/assets/css/app.css', '/assets/js/app.js',
  '/lib/jquery/jquery.min.js', '/lib/bootstrap/js/bootstrap.bundle.min.js',
  '/lib/perfect-scrollbar/perfect-scrollbar.min.js', '/vendor/purify.min.js',
  '/lib/remixicon/fonts/remixicon.css', '/lib/remixicon/fonts/remixicon.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin GETs only, never the API: answer from cache and refresh it in the background.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
