// Service worker: keeps the app itself (shell + Firebase sign-in code) available offline.
// Your mail is NOT stored here; app.js keeps it in IndexedDB. Bump CACHE when shipping changes to cached files.
const CACHE = 'mail-shell-v28';
const SHELL = [
  '/privacy',
  '/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
  '/assets/css/style.min.css', '/assets/css/app.css', '/assets/js/app.js',
  '/assets/fonts/lexend-latin.woff2', '/assets/fonts/lexend-latin-ext.woff2',
  '/lib/jquery/jquery.min.js', '/lib/bootstrap/js/bootstrap.bundle.min.js',
  '/lib/perfect-scrollbar/perfect-scrollbar.min.js', '/vendor/purify.min.js',
  '/lib/remixicon/fonts/remixicon.css', '/lib/remixicon/fonts/remixicon.woff2',
  '/vendor/html2canvas.min.js', '/vendor/jspdf.umd.min.js', // loaded only when you save a PDF
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
  // Everything else: same-origin, never the API, and never /ping (it must show the real server state).
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ping') return;

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

// ---- Push: the server sends one for each new mail. The push service holds it while the phone is
// offline and delivers it on reconnect, even if the app is closed. ----
// Save the new mail into the app's own IndexedDB as soon as its push arrives, so tapping the notification
// opens it at once instead of waiting for a sync. Same database and row layout as app.js (keep both in step).
const idbp = (r) => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const openMailDb = () => new Promise((ok) => {
  const r = indexedDB.open('mailbox', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('mails', { keyPath: 'key' }).createIndex('byDate', ['folder', 'ts']);
    r.result.createObjectStore('meta');
  };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => ok(null);
});
async function saveMailFromPush(d) { // never throws: if it fails, the app fetches the mail when it is opened
  const { id, t: token, m: inline } = d;
  if (!id || (!token && !inline)) return;
  let db = null;
  try {
    db = await openMailDb();
    if (!db) return;
    const key = 'inbox:' + id;
    if (await idbp(db.transaction('mails').objectStore('mails').get(key))) return; // already saved
    let m = inline; // small mails arrive inside the push: no request needed
    if (!m) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch('/api/push/mail/' + encodeURIComponent(id), { headers: { 'X-Push-Token': token }, cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      m = await res.json();
    }
    // Add only if still absent: the app may have saved (and even read) it while this was running.
    const tx = db.transaction('mails', 'readwrite');
    const os = tx.objectStore('mails');
    if (!(await idbp(os.get(key)))) os.put({ ...m, folder: 'inbox', key, ts: Date.parse(m.date) });
    await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = () => fail(tx.error); tx.onabort = () => fail(tx.error); });
  } catch (e) { /* ignore */ } finally { if (db) db.close(); }
}

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (d.id && wins.some((c) => c.visibilityState === 'visible')) { // app is on screen: just refresh it
      wins.forEach((c) => c.postMessage({ type: 'new-mail' }));
      return;
    }
    // The notification appears right away; the mail is saved alongside it.
    await Promise.all([
      self.registration.showNotification(d.title || 'New mail', {
        body: d.body || '',
        icon: '/icons/icon-192.png',
        tag: d.id ? 'mail-' + d.id : 'mail-test',
        data: { id: d.id || null, t: d.t || null },
      }),
      saveMailFromPush(d),
    ]);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { id, t } = event.notification.data || {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      await wins[0].focus().catch(() => {});
      if (id) wins[0].postMessage({ type: 'open-mail', id, t });
      return;
    }
    await self.clients.openWindow(id ? '/?mail=' + encodeURIComponent(id) + (t ? '&t=' + encodeURIComponent(t) : '') : '/');
  })());
});
