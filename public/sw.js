// Service worker: keeps the app itself (shell + Firebase sign-in code) available offline.
// Your mail is NOT stored here; app.js keeps it in IndexedDB. Bump CACHE when shipping changes to cached files.
const CACHE = 'mail-shell-v2';
const SHELL = [
  '/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
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

// Answer from cache at once and refresh the cache in the background.
const staleWhileRevalidate = (req, { ignoreSearch = false } = {}) =>
  caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(req, { ignoreSearch });
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Firebase sign-in code from Google's CDN: cached so the app can start offline.
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Everything else: same-origin, never the API.
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') { // opening the app (also "/?source=pwa", etc.) always gets the cached page offline
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok && url.pathname === '/') caches.open(CACHE).then((c) => c.put('/', res.clone()));
        return res;
      }).catch(() => caches.match('/', { ignoreSearch: true }))
    );
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
