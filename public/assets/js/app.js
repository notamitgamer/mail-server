// Mailbox front end: SmartMail template markup wired to the /api endpoints.
const $ = window.jQuery;
const FIREBASE_VER = '11.10.0';

const state = { folder: 'inbox', mails: [], hasMore: false, loading: false, shown: 30, openId: null, openMail: null, unread: 0 };
let config = { aliases: [], fromName: '' };
let getToken = async () => { throw new Error('Not signed in'); };
let signOutFn = async () => {};

const ps = new window.PerfectScrollbar('#mailGroup', { suppressScrollX: true });
const mc = new window.PerfectScrollbar('#mailContent', { suppressScrollX: true });

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseAddr = (s) => {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s || '');
  return m ? { name: m[1].trim(), addr: m[2].trim() } : { name: '', addr: String(s || '').trim() };
};
const label = (s) => { const p = parseAddr(s); return p.name || p.addr || 'Unknown'; };
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fullDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const fmtDate = (iso) => {
  const d = new Date(iso); const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
};
const toast = (msg) => {
  const t = $('#toast').text(msg).addClass('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.removeClass('show'), 3500);
};
const plain = (m) => (m.text || (m.html ? (new DOMParser().parseFromString(m.html, 'text/html').body.textContent || '') : '')).trim();

// ---------- offline store (IndexedDB) ----------
// Mail is kept on this device, like Gmail's offline mode. IndexedDB instead of localStorage:
// localStorage is capped near 5 MB and blocks the page, and HTML mail outgrows it quickly.
const PAGE = 30;
const idb = new Promise((resolve) => {
  if (!window.indexedDB) return resolve(null);
  const r = indexedDB.open('mailbox', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('mails', { keyPath: 'key' }).createIndex('byDate', ['folder', 'ts']);
    d.createObjectStore('meta');
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => resolve(null);
});
const memMails = new Map(); const memMeta = new Map(); // used only if IndexedDB is unavailable (this session)
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const bounds = (folder) => IDBKeyRange.bound([folder, 0], [folder, Number.MAX_SAFE_INTEGER]);

const store = {
  async put(folder, mails) {
    const rows = mails.map((m) => ({ ...m, folder, key: folder + ':' + m.id, ts: Date.parse(m.date) }));
    const d = await idb;
    if (!d) return rows.forEach((r) => memMails.set(r.key, r));
    const t = d.transaction('mails', 'readwrite');
    rows.forEach((r) => t.objectStore('mails').put(r));
    return txDone(t);
  },
  async get(folder, id) {
    const d = await idb;
    if (!d) return memMails.get(folder + ':' + id) || null;
    return (await req2p(d.transaction('mails').objectStore('mails').get(folder + ':' + id))) || null;
  },
  async list(folder, limit) { // newest first
    const d = await idb;
    if (!d) return [...memMails.values()].filter((r) => r.folder === folder).sort((a, b) => b.ts - a.ts).slice(0, limit);
    return new Promise((resolve, reject) => {
      const out = [];
      const c = d.transaction('mails').objectStore('mails').index('byDate').openCursor(bounds(folder), 'prev');
      c.onsuccess = () => { const cur = c.result; if (cur && out.length < limit) { out.push(cur.value); cur.continue(); } else resolve(out); };
      c.onerror = () => reject(c.error);
    });
  },
  async patch(folder, id, fields) {
    const row = await store.get(folder, id);
    if (row) await store.put(folder, [{ ...row, ...fields }]);
  },
  async remove(folder, id) { // after a delete
    const d = await idb;
    if (!d) { memMails.delete(folder + ':' + id); return; }
    const t = d.transaction('mails', 'readwrite');
    t.objectStore('mails').delete(folder + ':' + id);
    return txDone(t);
  },
  async prune(folder, ids) { // drop saved mail that no longer exists on the server (deleted on another device)
    const keep = new Set(ids);
    const d = await idb;
    if (!d) { memMails.forEach((r, k) => { if (r.folder === folder && !keep.has(r.id)) memMails.delete(k); }); return; }
    const t = d.transaction('mails', 'readwrite');
    const c = t.objectStore('mails').index('byDate').openCursor(bounds(folder));
    c.onsuccess = () => { const cur = c.result; if (!cur) return; if (!keep.has(cur.value.id)) cur.delete(); cur.continue(); };
    return txDone(t);
  },
  async reconcile(unreadIds) { // make saved inbox read flags match the server
    const unread = new Set(unreadIds);
    const flip = (r) => (r.read === unread.has(r.id) ? { ...r, read: !unread.has(r.id) } : null);
    const d = await idb;
    if (!d) { memMails.forEach((r, k) => { if (r.folder === 'inbox') { const n = flip(r); if (n) memMails.set(k, n); } }); return; }
    const t = d.transaction('mails', 'readwrite');
    const c = t.objectStore('mails').index('byDate').openCursor(bounds('inbox'));
    c.onsuccess = () => { const cur = c.result; if (!cur) return; const n = flip(cur.value); if (n) cur.update(n); cur.continue(); };
    return txDone(t);
  },
  async getMeta(k) {
    const d = await idb;
    if (!d) return memMeta.get(k) ?? null;
    return (await req2p(d.transaction('meta').objectStore('meta').get(k))) ?? null;
  },
  async setMeta(k, v) {
    const d = await idb;
    if (!d) { memMeta.set(k, v); return; }
    const t = d.transaction('meta', 'readwrite');
    t.objectStore('meta').put(v, k);
    return txDone(t);
  },
  async clear() {
    memMails.clear(); memMeta.clear();
    const d = await idb;
    if (!d) return;
    const t = d.transaction(['mails', 'meta'], 'readwrite');
    t.objectStore('mails').clear(); t.objectStore('meta').clear();
    return txDone(t);
  },
};

// Per-folder sync cursor ({ newest, oldest, hasOlder } as ms timestamps) and app-level bits.
const fresh = () => ({ inbox: {}, sent: {}, app: { unread: 0, pendingRead: [], lastSync: 0 } });
let meta = fresh();
const saveMeta = (k) => store.setMeta(k, meta[k]);
async function loadMeta() {
  const base = fresh();
  for (const k of Object.keys(base)) meta[k] = { ...base[k], ...((await store.getMeta(k)) || {}) };
}

// ---------- sign-in ----------
function showSignin(msg, button) {
  $('#signin').removeClass('d-none');
  $('#signinMsg').text(msg);
  $('#btnSignin').toggleClass('d-none', !button);
}

async function wipeLocal() { // sign-out, or a different/blocked account: nothing stays on this device
  localStorage.removeItem('mb_user');
  await store.clear();
  meta = fresh(); appReady = null; state.mails = []; state.hasMore = false; state.shown = PAGE;
  hideReader(); setUnread(0); renderList();
}

async function api(path, opts = {}) {
  const token = await getToken();
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Authorization: 'Bearer ' + token },
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.status = res.status;
    if (res.status === 403) { await signOutFn(); await wipeLocal(); showSignin(err.message, true); }
    throw err;
  }
  return data;
}

async function fetchConfig() {
  const c = await (await fetch('/api/config')).json();
  if (c.firebase) localStorage.setItem('mb_config', JSON.stringify(c)); // so the next start needs no server round trip
  return c;
}

let authUser = null; let authReady = null; let appReady = null;
function initAuth() {
  if (authReady) return authReady;
  authReady = (async () => {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VER}`;
    const [{ initializeApp }, fa] = await Promise.all([import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`)]);
    const auth = fa.getAuth(initializeApp(config.firebase));
    getToken = () => auth.currentUser.getIdToken();
    signOutFn = () => fa.signOut(auth);
    $('#btnSignin').off('click').on('click', () => fa.signInWithPopup(auth, new fa.GoogleAuthProvider()).catch((e) => showSignin('Sign-in failed: ' + e.message, true)));
    fa.onAuthStateChanged(auth, (user) => {
      authUser = user;
      if (user) start(user);
      else if (navigator.onLine) { wipeLocal(); showSignin('Sign in to continue', true); }
    });
  })();
  authReady.catch(() => { authReady = null; });
  return authReady;
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); // ask the browser not to evict saved mail
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('mb_config')); } catch (e) { /* ignore */ }
  const hint = localStorage.getItem('mb_user');

  if (saved && saved.firebase) {
    // Known device: paint saved mail now, then bring up Firebase and the server in the background.
    config = saved;
    if (hint) openApp(hint);
    initAuth().catch(() => { if (!hint) showSignin('Could not load sign-in. Are you offline?', false); });
    fetchConfig().then((c) => { config = c; }).catch(() => {});
    return;
  }
  try { config = await fetchConfig(); } catch (e) { return showSignin('Cannot reach the server.', false); }
  if (!config.firebase) return showSignin('FIREBASE_WEB_CONFIG is not set on the server.', false);
  initAuth().catch(() => showSignin('Could not load sign-in. Are you offline?', false));
}

function openApp(email) {
  if (appReady) return appReady;
  appReady = (async () => {
    $('#signin').addClass('d-none');
    $('#avatar span').text((email || 'm').charAt(0).toLowerCase());
    await loadMeta();
    state.loading = !meta.inbox.newest; // nothing saved yet: say "Loading…" until the first sync lands
    await showFolder();
  })();
  return appReady;
}

async function start(user) {
  localStorage.setItem('mb_user', user.email || 'me');
  await openApp(user.email);
  await syncAll({ reconcile: true });
  initPush().catch(() => {});
  const wanted = new URLSearchParams(location.search).get('mail'); // opened from a notification
  if (wanted) { history.replaceState(null, '', location.pathname); openInboxMail(wanted); }
}

// ---------- list ----------
const COLORS = ['green', 'blue', 'indigo', 'red', 'yellow'];
function colorOf(who) {
  let h = 0;
  for (const c of label(who)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function avatar(who) {
  return `<div class="mail-avatar"><span class="${colorOf(who)}">${esc(label(who).charAt(0).toLowerCase())}</span></div>`;
}

function setUnread(n) {
  state.unread = Math.max(0, n);
  $('#unreadCount').text(state.unread || '');
  document.title = (state.unread ? `(${state.unread}) ` : '') + 'Mail';
}

function renderList() {
  const q = $('#search').val().trim().toLowerCase();
  const items = state.mails.filter((m) => !q || `${m.subject} ${m.from} ${m.snippet}`.toLowerCase().includes(q));
  const $ul = $('#mailGroup').empty();
  if (!items.length) $ul.append(`<li class="list-empty">${state.loading ? 'Loading…' : 'No mail here'}</li>`);
  items.forEach((m) => {
    const sent = state.folder === 'sent';
    $ul.append(`<li class="mail-item${m.read ? '' : ' unread'}${m.id === state.openId ? ' active' : ''}" data-id="${esc(m.id)}">`
      + avatar(sent ? m.to[0] : m.from)
      + `<div class="mail-item-body"><div class="d-flex align-items-center"><span class="mail-sender">${esc(sent ? 'To: ' + (m.to[0] || '') : label(m.from))}</span>`
      + `<span class="mail-time">${esc(fmtDate(m.date))}</span></div>`
      + `<h6 class="mail-subject">${esc(m.subject)}</h6><p class="mail-text">${esc(m.snippet)}</p></div></li>`);
  });
  if (state.hasMore && !q) $ul.append('<li class="load-more"><button id="loadMore" class="btn btn-sm btn-outline-primary">Load more</button></li>');
  renderStatus();
  ps.update();
}

function renderStatus() {
  const n = state.mails.length; const total = meta[state.folder].total;
  $('#countText').text((navigator.onLine ? '' : 'Offline · ') + (n ? (total ? `${n} of ${total}` : `${n} saved`) : ''));
  $('#totalInbox').text(meta.inbox.total || '');
  $('#totalSent').text(meta.sent.total || '');
}

// Draw the list from what is saved on this device. Never waits on the network.
async function showFolder() {
  const f = state.folder;
  const rows = await store.list(f, state.shown + 1);
  if (f !== state.folder) return;
  state.mails = rows.slice(0, state.shown);
  state.hasMore = rows.length > state.shown || Boolean(meta[f].hasOlder);
  setUnread(meta.app.unread);
  renderList();
}

// ---------- sync ----------
// Only the gap is requested: mail newer than the newest one already saved. A full load happens once per device.
async function syncFolder(folder, reconcile) {
  const fm = meta[folder];
  const times = (mails) => mails.map((m) => Date.parse(m.date));
  let counted = false; let newUnread = 0; let added = 0; let totalSet = false;
  const takeTotal = (d) => { if (d.total !== undefined) { fm.total = d.total; totalSet = true; } };
  const applyReconcile = async (d) => {
    if (d.unread === undefined) return;
    meta.app.unread = d.unread; counted = true;
    if (d.unreadIds) await store.reconcile(d.unreadIds);
  };

  if (!fm.newest) {
    const d = await api(`/api/sync?folder=${folder}&limit=${PAGE}${reconcile ? '&reconcile=1' : ''}`);
    await store.put(folder, d.mails);
    if (d.mails.length) { fm.newest = Math.max(...times(d.mails)); fm.oldest = Math.min(...times(d.mails)); }
    fm.hasOlder = d.hasMore;
    takeTotal(d);
    if (d.ids) await store.prune(folder, d.ids);
    if (!totalSet && !d.hasMore) fm.total = d.mails.length;
    if (folder === 'inbox') await applyReconcile(d);
  } else {
    for (let i = 0, rec = reconcile; i < 20; i++, rec = false) {
      const d = await api(`/api/sync?folder=${folder}&since=${fm.newest}&limit=50${rec ? '&reconcile=1' : ''}`);
      takeTotal(d);
      if (d.ids) await store.prune(folder, d.ids);
      if (folder === 'inbox') await applyReconcile(d);
      if (!d.mails.length) break;
      if (!totalSet) added += d.mails.length;
      await store.put(folder, d.mails);
      fm.newest = Math.max(fm.newest, ...times(d.mails));
      newUnread += d.mails.filter((m) => !m.read).length;
      if (!d.hasMore) break;
    }
  }
  if (folder === 'inbox' && !counted) meta.app.unread += newUnread;
  if (!totalSet && added) fm.total = (fm.total || 0) + added;
  await saveMeta(folder);
  if (folder === 'inbox') await saveMeta('app');
}

async function flushReads() { // reads made offline are sent once we are back
  const ids = [...meta.app.pendingRead];
  for (const id of ids) {
    try { await api(`/api/mails/${encodeURIComponent(id)}/read`, { method: 'POST' }); } catch (e) { if (e.status !== 404) throw e; }
    meta.app.pendingRead = meta.app.pendingRead.filter((x) => x !== id);
  }
  if (ids.length) await saveMeta('app');
}

let syncing = false;
async function syncAll({ reconcile = false, manual = false } = {}) {
  if (syncing || !authUser) return;
  if (!navigator.onLine) { if (manual) toast('You are offline. Showing saved mail.'); return; }
  syncing = true; $('#refresh i').addClass('spin');
  try {
    await appReady;
    await flushReads();
    const folders = reconcile ? ['inbox', 'sent'] : ['inbox'].concat(state.folder === 'sent' ? ['sent'] : []);
    for (const f of folders) await syncFolder(f, reconcile);
    meta.app.lastSync = Date.now(); await saveMeta('app');
  } catch (e) { if (manual || navigator.onLine) toast(e.status ? e.message : 'Could not sync. Showing saved mail.'); }
  syncing = false; state.loading = false; $('#refresh i').removeClass('spin');
  await showFolder();
}

async function loadMore() {
  const f = state.folder;
  state.shown += PAGE;
  await showFolder();
  if (state.mails.length >= state.shown || !meta[f].hasOlder) return; // saved mail was enough
  if (!navigator.onLine) return toast('You are offline. Older mail will load when you reconnect.');
  try { // older than the oldest saved mail
    const d = await api(`/api/sync?folder=${f}&before=${meta[f].oldest}&limit=${PAGE}`);
    await store.put(f, d.mails);
    if (d.mails.length) meta[f].oldest = Math.min(meta[f].oldest, ...d.mails.map((m) => Date.parse(m.date)));
    meta[f].hasOlder = d.hasMore;
    await saveMeta(f);
  } catch (e) { toast(e.message); }
  await showFolder();
}

// ---------- reader ----------
const CLEAN = { WHOLE_DOCUMENT: true, FORBID_TAGS: ['meta', 'base', 'link', 'form', 'iframe', 'object', 'embed', 'script'] };
const FRAME_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:"><base target="_blank">`;
const FRAME_BASE = 'body{margin:0;padding:12px 4px;font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;word-wrap:break-word;overflow-x:auto}img{max-width:100%;height:auto}';
const FRAME_LIGHT = `${FRAME_CSP}<style>html{background:#fff}${FRAME_BASE}body{color:#202124}a{color:#1a56db}</style>`;
const FRAME_DARK = `${FRAME_CSP}<style>html{background:transparent}${FRAME_BASE}body{color:#cdd6f4}a{color:#89b4fa}</style>`;

// Phone back button / swipe: the reader and the sidebar are "layers" with their own history entry,
// so back closes the layer instead of leaving the site.
const layers = []; let ignorePop = 0;
function pushLayer(name) { layers.push(name); history.pushState({ mb: name }, ''); }
function closeLayer(name) {
  $('body').removeClass(name === 'mail' ? 'mailcontent-show' : 'sidebar-show');
  const i = layers.lastIndexOf(name);
  if (i >= 0 && i === layers.length - 1) { layers.pop(); ignorePop++; history.back(); } else if (i >= 0) layers.splice(i, 1);
}
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop--; return; }
  const name = layers.pop();
  if (!name || name === 'mail') $('body').removeClass('mailcontent-show');
  if (!name || name === 'side') $('body').removeClass('sidebar-show');
});

function showReader() {
  $('.mailcontent-placeholder').addClass('d-none').siblings().removeClass('d-none');
  if (window.matchMedia('(max-width: 1199px)').matches && !$('body').hasClass('mailcontent-show')) {
    $('body').addClass('mailcontent-show');
    pushLayer('mail');
  }
}

function hideReader() {
  state.openId = null; state.openMail = null;
  $('.mailcontent-placeholder').removeClass('d-none').siblings().addClass('d-none');
  closeLayer('mail');
}

function renderBody(m) {
  const doc = m.html
    ? window.DOMPurify.sanitize(m.html, CLEAN)
    : `<html><head></head><body><div style="white-space:pre-wrap">${esc(m.text || '(empty message)')}</div></body></html>`;
  const frame = document.createElement('iframe');
  // Scripts stay off; same-origin is only so we can measure the height.
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  const fh = m.html ? FRAME_LIGHT : FRAME_DARK;
  frame.className = m.html ? 'frame-light' : 'frame-dark';
  frame.srcdoc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (t) => t + fh) : fh + doc;
  frame.addEventListener('load', () => {
    try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 'px'; } catch (e) { /* ignore */ }
    mc.update();
  });
  $('#rBody').empty().append(frame);
  if (m.truncated) $('#rBody').append('<p class="text-muted small mt-2">This message was shortened because it is very large.</p>');
}

function renderReader(m) {
  const sent = state.folder === 'sent';
  const p = parseAddr(m.from);
  $('#rSubject').text(m.subject);
  const who = sent ? m.to[0] : m.from;
  $('#rAvatar').attr('class', colorOf(who)).text(label(who).charAt(0).toLowerCase());
  $('#rFrom').html(sent ? `Me <span>&lt;${esc(m.from)}&gt;</span>` : `${esc(p.name || p.addr)}${p.name ? ` <span>&lt;${esc(p.addr)}&gt;</span>` : ''}`);
  $('#rTo').text('to: ' + m.to.join(', '));
  $('#rTime').text(fullDate(m.date));
  $('#btnReplyTop, #btnReply').toggleClass('d-none', sent);
  $('#mnReply, #mnUnread').toggleClass('d-none', sent);
  const rUrl = resendUrl(m, state.folder);
  $('#mnResend').toggleClass('d-none', !rUrl).attr('href', rUrl || '#');
  $('#rAttach').html((m.attachments || []).map((a) => `<span class="attach-chip"><i class="ri-attachment-2"></i> ${esc(a.filename)}${a.size ? ' (' + fmtSize(a.size) + ')' : ''}</span>`).join(''));
  renderBody(m);
  mc.update();
}

async function openMail(id) {
  const folder = state.folder;
  state.openId = id;
  $('#mailGroup .mail-item').removeClass('active').filter((i, el) => el.dataset.id === id).addClass('active');
  showReader();
  $('#rSubject').text('Loading…'); $('#rBody').empty(); $('#rAttach').empty();
  const m = await store.get(folder, id);
  if (state.openId !== id) return;
  if (!m) { $('#rSubject').text(''); return toast('This message is not saved on this device yet.'); }
  state.openMail = m;
  renderReader(m);
  if (folder === 'inbox' && !m.read) {
    await store.patch('inbox', id, { read: true });
    const item = state.mails.find((x) => x.id === id);
    if (item) item.read = true;
    $('#mailGroup .mail-item').filter((i, el) => el.dataset.id === id).removeClass('unread');
    meta.app.unread = Math.max(0, meta.app.unread - 1);
    meta.app.pendingRead.push(id);
    saveMeta('app'); setUnread(meta.app.unread);
    if (navigator.onLine && authUser) flushReads().catch(() => {}); // offline: it is sent on the next sync
  }
}

// ---------- PDF ----------
// Makes a real .pdf file and downloads it (the print dialog is unreliable on phones and in installed apps).
// The mail is drawn by the browser, so any language and the mail's own layout come out right.
// Remote images are included only if their server allows it; the text is an image, not selectable.
const loadScript = (src) => new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load ' + src));
  document.head.appendChild(s);
});
let pdfLibs = null;
const loadPdfLibs = () => (pdfLibs = pdfLibs || Promise.all([loadScript('/vendor/html2canvas.min.js'), loadScript('/vendor/jspdf.umd.min.js')]).catch((e) => { pdfLibs = null; throw e; }));

async function savePdf() {
  const m = state.openMail;
  if (!m || savePdf.busy) return;
  savePdf.busy = true; toast('Preparing PDF…');
  let sheet;
  try {
    await loadPdfLibs();
    const body = window.DOMPurify.sanitize(m.html || `<div style="white-space:pre-wrap">${esc(m.text || '')}</div>`,
      { FORBID_TAGS: ['style', 'meta', 'base', 'link', 'form', 'iframe', 'object', 'embed', 'script'] });
    sheet = document.createElement('div');
    sheet.id = 'pdfSheet';
    sheet.innerHTML = `<div class="print-head"><h2>${esc(m.subject)}</h2><div>From: ${esc(m.from)}</div>`
      + `<div>To: ${esc(m.to.join(', '))}</div><div>Date: ${esc(fullDate(m.date))}</div></div>` + body;
    document.body.appendChild(sheet);
    // give images up to 4 s to arrive
    await Promise.race([
      Promise.all([...sheet.querySelectorAll('img')].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    const W = sheet.offsetWidth; const H = sheet.scrollHeight;
    const scale = Math.min(2, Math.sqrt(16e6 / (W * H)), 16000 / H); // stay inside phone canvas limits
    if (scale < 0.5) throw new Error('Mail is too long for a PDF file');
    const canvas = await window.html2canvas(sheet, {
      scale, backgroundColor: '#ffffff', useCORS: true, logging: false, scrollX: 0, scrollY: 0, windowWidth: W,
      onclone: (doc) => { const el = doc.getElementById('pdfSheet'); el.style.left = '0'; el.style.position = 'absolute'; },
    });
    const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const pw = pdf.internal.pageSize.getWidth(); const ph = pdf.internal.pageSize.getHeight();
    const slice = Math.floor((canvas.width * ph) / pw); // canvas rows per A4 page
    for (let y = 0, page = 0; y < canvas.height; y += slice, page++) {
      const part = document.createElement('canvas');
      part.width = canvas.width; part.height = Math.min(slice, canvas.height - y);
      const ctx = part.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, part.width, part.height);
      ctx.drawImage(canvas, 0, y, part.width, part.height, 0, 0, part.width, part.height);
      if (page) pdf.addPage();
      pdf.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, (part.height * pw) / part.width);
    }
    pdf.save(((m.subject || 'mail').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'mail') + '.pdf');
    toast('PDF saved');
  } catch (e) {
    toast('Could not make a PDF file, opening print instead.');
    printMail();
  } finally {
    if (sheet) sheet.remove();
    savePdf.busy = false;
  }
}

// Fallback: browser print dialog -> "Save as PDF"
function printMail() {
  const m = state.openMail;
  if (!m) return;
  const body = window.DOMPurify.sanitize(m.html || `<div style="white-space:pre-wrap">${esc(m.text || '')}</div>`,
    { FORBID_TAGS: ['style', 'meta', 'base', 'link', 'form', 'iframe', 'object', 'embed', 'script'] });
  $('#printArea').html(`<div class="print-head"><h2>${esc(m.subject)}</h2><div>From: ${esc(m.from)}</div>`
    + `<div>To: ${esc(m.to.join(', '))}</div><div>Date: ${esc(fullDate(m.date))}</div></div>` + body);
  const title = document.title;
  document.title = (m.subject || 'mail').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80);
  const done = () => { $('#printArea').empty(); document.title = title; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

// ---------- compose / reply ----------
function openCompose({ to = '', subject = '', body = '', replyToId = null, title = 'New Message' } = {}) {
  $('#composeTitle').text(title);
  $('#cFrom').html((config.aliases || []).map((a) => `<option>${esc(a)}</option>`).join('')).closest('.form-group').toggle((config.aliases || []).length > 1);
  $('#cTo').val(to); $('#cSubject').val(subject); $('#cBody').val(body); $('#cHtml').prop('checked', false);
  $('.compose').data('replyToId', replyToId).removeClass('d-none minimize');
  $('.menu-compose').addClass('d-none');
  if (to) { const el = $('#cBody').trigger('focus')[0]; el.setSelectionRange(0, 0); el.scrollTop = 0; } else $('#cTo').trigger('focus');
}

function closeCompose() {
  $('.compose').addClass('d-none').removeClass('minimize fullscreen');
  $('.menu-compose').removeClass('d-none');
}

function startReply() {
  const m = state.openMail;
  if (!m || state.folder !== 'inbox') return;
  const p = parseAddr(m.from);
  const quote = plain(m).slice(0, 2000).split('\n').map((l) => '> ' + l).join('\n');
  openCompose({
    to: p.addr,
    subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject,
    body: `\n\nOn ${fullDate(m.date)}, ${p.name || p.addr} wrote:\n${quote}`,
    replyToId: m.id,
    title: 'Reply',
  });
}

async function sendMail() {
  if (!navigator.onLine) return toast('You are offline. Connect to send.');
  const payload = { to: $('#cTo').val(), subject: $('#cSubject').val(), from: $('#cFrom').val() || undefined, replyToId: $('.compose').data('replyToId') || undefined };
  payload[$('#cHtml').is(':checked') ? 'html' : 'text'] = $('#cBody').val();
  $('#cSend').prop('disabled', true);
  try {
    await api('/api/send', { method: 'POST', body: JSON.stringify(payload) });
    closeCompose(); toast('Sent');
    await syncFolder('sent', false).catch(() => {});
    if (state.folder === 'sent') await showFolder();
  } catch (e) { toast(e.message); }
  $('#cSend').prop('disabled', false);
}

// ---------- message menu (three dots) ----------
// Dashboard page of a message at Resend. A received mail's id is its Resend id; sent mail stores it as resendId.
const resendUrl = (m, folder) => {
  const id = folder === 'sent' ? m.resendId : m.id;
  return id ? (folder === 'sent' ? 'https://resend.com/emails/' : 'https://resend.com/emails/receiving/') + encodeURIComponent(id) : null;
};

async function deleteMail() {
  const m = state.openMail; const folder = state.folder;
  if (!m) return;
  if (!navigator.onLine) return toast('Go online to delete mail.');
  if (!(await askConfirm({ title: 'Delete message?', message: 'It is removed from every device and cannot be recovered.', ok: 'Delete', danger: true }))) return;
  const row = await store.get(folder, m.id);
  try {
    await api(`/api/mails/${encodeURIComponent(m.id)}?folder=${folder}`, { method: 'DELETE' });
  } catch (e) { return toast(e.message); }
  await store.remove(folder, m.id);
  if (meta[folder].total) meta[folder].total -= 1;
  await saveMeta(folder);
  if (folder === 'inbox') {
    if (row && !row.read) meta.app.unread = Math.max(0, meta.app.unread - 1);
    meta.app.pendingRead = meta.app.pendingRead.filter((x) => x !== m.id);
    await saveMeta('app');
  }
  hideReader();
  await showFolder();
  toast('Deleted');
}

async function markUnread() {
  const m = state.openMail;
  if (!m || state.folder !== 'inbox') return;
  if (!navigator.onLine) return toast('Go online to change this.');
  const row = await store.get('inbox', m.id);
  if (row && !row.read) return toast('Already unread');
  try { await api(`/api/mails/${encodeURIComponent(m.id)}/unread`, { method: 'POST' }); } catch (e) { return toast(e.message); }
  meta.app.pendingRead = meta.app.pendingRead.filter((x) => x !== m.id);
  await store.patch('inbox', m.id, { read: false });
  meta.app.unread += 1;
  await saveMeta('app');
  hideReader();
  await showFolder();
  toast('Marked as unread');
}

// Themed replacement for window.confirm(): resolves true only if the person presses the OK button.
function askConfirm({ title, message, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const el = document.getElementById('confirmModal');
    const modal = modalOf(el);
    let answer = false;
    $('#confirmTitle').text(title); $('#confirmMsg').text(message);
    $('#confirmOk').text(ok).toggleClass('btn-danger', danger).toggleClass('btn-primary', !danger)
      .off('click').on('click', () => { answer = true; modal.hide(); });
    $(el).off('hidden.bs.modal').one('hidden.bs.modal', () => resolve(answer));
    modal.show();
  });
}

// Quick forward: ask for an address, confirm, and the server sends the saved message as it is.
// Bootstrap here is v5.0.1, which has no Modal.getOrCreateInstance (added in 5.1)
const modalOf = (el) => bootstrap.Modal.getInstance(el) || new bootstrap.Modal(el);
const fwdModal = () => modalOf(document.getElementById('fwdModal'));
function fwdStep(n, addr) {
  $('#fwdStep1').toggleClass('d-none', n !== 1); $('#fwdStep2').toggleClass('d-none', n !== 2);
  $('#fwdNext, #fwdCancel').toggleClass('d-none', n !== 1); $('#fwdBack, #fwdConfirm').toggleClass('d-none', n !== 2);
  if (n === 2) { $('#fwdSubj').text('\u201c' + (state.openMail.subject || '(no subject)') + '\u201d'); $('#fwdAddr').text(addr); }
}
function openForward() {
  if (!state.openMail) return;
  if (!navigator.onLine) return toast('You are offline. Connect to forward.');
  $('#fwdTo').val(''); $('#fwdErr').addClass('d-none'); $('#fwdConfirm').prop('disabled', false).text('Confirm & send');
  fwdStep(1);
  fwdModal().show();
  setTimeout(() => $('#fwdTo').trigger('focus'), 300);
}
function fwdContinue() {
  const addr = $('#fwdTo').val().trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) return $('#fwdErr').text('Enter a valid email address.').removeClass('d-none');
  $('#fwdErr').addClass('d-none');
  fwdStep(2, addr);
}
async function fwdSend() {
  const m = state.openMail; const folder = state.folder;
  if (!m) return;
  if (!navigator.onLine) return toast('You are offline. Connect to forward.');
  const $b = $('#fwdConfirm').prop('disabled', true).text('Sending…');
  try {
    await api(`/api/mails/${encodeURIComponent(m.id)}/forward?folder=${folder}`, { method: 'POST', body: JSON.stringify({ to: $('#fwdAddr').text() }) });
    fwdModal().hide(); toast('Forwarded');
    await syncFolder('sent', false).catch(() => {});
    if (state.folder === 'sent') await showFolder();
  } catch (e) { toast(e.message); $b.prop('disabled', false).text('Confirm & send'); }
}
$('#fwdNext').on('click', fwdContinue);
$('#fwdBack').on('click', () => fwdStep(1));
$('#fwdConfirm').on('click', fwdSend);
$('#fwdTo').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fwdContinue(); } });
$('#fwdEdit').on('click', (e) => { e.preventDefault(); fwdModal().hide(); startForward(); });

function startForward() {
  const m = state.openMail;
  if (!m) return;
  openCompose({
    subject: /^fwd?:/i.test(m.subject) ? m.subject : 'Fwd: ' + m.subject,
    body: `\n\n---------- Forwarded message ----------\nFrom: ${m.from}\nDate: ${fullDate(m.date)}\nSubject: ${m.subject}\nTo: ${m.to.join(', ')}\n\n${plain(m).slice(0, 4000)}`,
    title: 'Forward',
  });
}

// Shares the message text with another app (phone share sheet); copies it where sharing is not available.
// It is a copy of the text, not a public link: this mailbox is private.
async function shareMail() {
  const m = state.openMail;
  if (!m) return;
  const text = `${m.subject}\nFrom: ${m.from}\nDate: ${fullDate(m.date)}\n\n${plain(m).slice(0, 4000)}`;
  if (navigator.share) {
    try { await navigator.share({ title: m.subject, text }); } catch (e) { /* cancelled */ }
    return;
  }
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch (e) { toast('Sharing is not available here'); }
}

$('#mnReply').on('click', (e) => { e.preventDefault(); startReply(); });
$('#mnForward').on('click', (e) => { e.preventDefault(); openForward(); });
$('#mnUnread').on('click', (e) => { e.preventDefault(); markUnread(); });
$('#mnPrint').on('click', (e) => { e.preventDefault(); printMail(); });
$('#mnShare').on('click', (e) => { e.preventDefault(); shareMail(); });
$('#mnDelete').on('click', (e) => { e.preventDefault(); deleteMail(); });

// ---------- push notifications ----------
// The server sends a Web Push for each new mail; sw.js shows it. If the phone is offline the push
// service holds it and delivers it when the phone reconnects.
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToBytes = (s) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const bellState = (on) => {
  const $b = $('#btnNotify').toggleClass('on', on).attr('title', on ? 'Notifications on (tap to turn off)' : 'Turn on notifications');
  $b.find('i').attr('class', on ? 'ri-notification-3-fill' : 'ri-notification-off-line');
};
async function currentPush() {
  const reg = await navigator.serviceWorker.ready;
  return { reg, sub: await reg.pushManager.getSubscription() };
}
const subscribeNow = (reg) => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(config.vapidPublicKey) });
const savePushSub = (sub) => api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });

async function initPush() { // after sign-in: show the bell and keep the saved subscription fresh
  if (!pushSupported()) return;
  $('#btnNotify').removeClass('d-none');
  if (Notification.permission !== 'granted') return bellState(false);
  const { reg, sub } = await currentPush();
  const active = sub || (config.vapidPublicKey ? await subscribeNow(reg) : null);
  if (active) await savePushSub(active);
  bellState(Boolean(active));
}

async function togglePush() {
  if (!pushSupported()) return toast('Push is not supported here. On iPhone, add the app to the Home Screen first.');
  if (!navigator.onLine) return toast('Go online to change notifications.');
  try {
    const { reg, sub } = await currentPush();
    if (sub) { // turn off
      await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
      bellState(false);
      return toast('Notifications off');
    }
    if (!config.vapidPublicKey) return toast('Push is not set up on the server (VAPID keys missing).');
    if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications are blocked. Allow them in the app or site settings.');
    await savePushSub(await subscribeNow(reg));
    bellState(true);
    await api('/api/push/test', { method: 'POST' }); // a notification should appear in a moment
    return toast('Notifications on');
  } catch (e) { return toast('Could not change notifications: ' + e.message); }
}

async function openInboxMail(id) {
  if (state.folder !== 'inbox') $('#folders .nav-link[data-folder="inbox"]').trigger('click');
  await syncAll();
  openMail(id);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => { // sent by sw.js
    const d = e.data || {};
    if (d.type === 'new-mail') syncAll();
    if (d.type === 'open-mail' && d.id) openInboxMail(d.id);
  });
}
$('#btnNotify').on('click', (e) => { e.preventDefault(); togglePush(); });

// ---------- events ----------
$('#mailGroup').on('click', '.mail-item', function (e) { e.preventDefault(); openMail(this.dataset.id); });
$('#mailGroup').on('click', '#loadMore', loadMore);
$('#search').on('input', renderList);
$('#refresh').on('click', (e) => { e.preventDefault(); syncAll({ reconcile: true, manual: true }); });
$('#btnPdf').on('click', (e) => { e.preventDefault(); savePdf(); });
$('#btnReply, #btnReplyTop').on('click', (e) => { e.preventDefault(); startReply(); });
$('#mailBack').on('click', (e) => { e.preventDefault(); closeLayer('mail'); });
$('#avatar').on('click', async (e) => {
  e.preventDefault();
  if (!navigator.onLine) return toast('Go online to sign out.');
  if (await askConfirm({ title: 'Sign out?', message: 'Mail saved on this device will be removed.', ok: 'Sign out', danger: true })) signOutFn().then(wipeLocal).then(() => location.reload());
});

$('#folders').on('click', '.nav-link', function (e) {
  e.preventDefault();
  $(this).addClass('active').siblings().removeClass('active');
  state.folder = this.dataset.folder;
  $('#folderTitle').text(state.folder === 'sent' ? 'Sent' : 'Inbox');
  $('#search').val('');
  hideReader();
  closeLayer('side');
  state.shown = PAGE;
  showFolder().then(() => syncAll());
});

// template behaviours (sidebar, compose window)
$('.mailbox-menu').on('click', (e) => {
  e.preventDefault();
  if (window.matchMedia('(max-width: 767px)').matches) {
    if ($('body').hasClass('sidebar-show')) closeLayer('side'); else { $('body').addClass('sidebar-show'); pushLayer('side'); }
  } else $('body').toggleClass('sidebar-hide');
  mc.update();
});
$('.backdrop').on('click', () => closeLayer('side'));
$('.mailbox-search .form-control').on('focusin focusout', function (e) { $(this).parent().toggleClass('onfocus', e.type === 'focusin'); });
$('.menu-compose').on('click', (e) => { e.preventDefault(); openCompose(); });
$('.compose-title, .nav-link-minimize').on('click', function (e) { e.preventDefault(); $(this).closest('.compose').toggleClass('minimize'); });
$('.nav-link-fullscreen').on('click', function (e) { e.preventDefault(); $(this).closest('.compose').toggleClass('fullscreen'); });
$('.nav-link-close, #cDiscard').on('click', (e) => { e.preventDefault(); closeCompose(); });
$('#cSend').on('click', sendMail);

// keep the saved copy fresh: when back online, when the app is reopened, and every couple of minutes
window.addEventListener('online', () => { renderStatus(); toast('Back online'); initAuth().then(() => syncAll()).catch(() => {}); });
window.addEventListener('offline', () => { renderStatus(); toast('You are offline. Showing saved mail.'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (meta.app.lastSync || 0) > 60000) syncAll(); });
setInterval(() => { if (!document.hidden) syncAll(); }, 120000);

boot();
