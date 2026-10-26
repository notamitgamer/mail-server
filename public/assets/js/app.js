// Mailbox front end: SmartMail template markup wired to the /api endpoints.
const $ = window.jQuery;
const FIREBASE_VER = '11.10.0';

const state = { folder: 'inbox', mails: [], hasMore: false, loading: false, shown: 30, openId: null, openMail: null, unread: 0, filter: 'all' };
let config = { aliases: [], fromName: '' };
const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); // the Android app
const hap = (kind) => { try { if (window.MailNative) window.MailNative.haptic(kind); else if (navigator.vibrate) navigator.vibrate(kind === 'tick' ? 8 : 16); } catch (e) { /* optional */ } };
const cap = (name) => window.Capacitor.Plugins[name] || window.Capacitor.registerPlugin(name);
let getToken = async () => { throw new Error('Not signed in'); };
let signOutFn = async () => {};

const ps = new window.PerfectScrollbar('#mailGroup', { suppressScrollX: true });
// The reader holds the mail in an iframe, and touches inside an iframe never reach this page, so
// PerfectScrollbar (JS-driven scrolling) can't scroll when the swipe starts on the mail body.
// On phones/tablets use the browser's native scrolling instead, which chains out of the iframe.
const nativeReader = window.matchMedia('(max-width: 1199px), (pointer: coarse)');
let mcInst = null;
const mc = {
  update() { if (mcInst) mcInst.update(); },
  sync() {
    if (nativeReader.matches) {
      if (mcInst) { mcInst.destroy(); mcInst = null; }
      document.getElementById('mailContent').classList.add('native-scroll');
    } else {
      document.getElementById('mailContent').classList.remove('native-scroll');
      if (!mcInst) mcInst = new window.PerfectScrollbar('#mailContent', { suppressScrollX: true });
    }
  },
};
mc.sync();
if (nativeReader.addEventListener) nativeReader.addEventListener('change', () => mc.sync());

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
// List preview: drop link clutter ("[https://cdn...]", bare URLs) from snippets already saved, keeping readable text.
const cleanSnippet = (s) => String(s || '')
  .replace(/\[([^\]]+)\]\((?:https?:|cid:|mailto:)[^)]*\)/gi, '$1')
  .replace(/\[\s*(?:https?:\/\/|cid:)[^\]]*\]/gi, ' ')
  .replace(/\[(?:image|img)\b[^\]]*\]/gi, ' ')
  .replace(/<(?:https?:\/\/|mailto:)[^>]*>/gi, ' ')
  .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
  .replace(/\s+/g, ' ').trim();
const previewOf = (m) => {
  const c = cleanSnippet(m.snippet);
  if (!c) return '(no preview)';
  const first = /^.*?[.!?](?=\s|$)/.exec(c); // first readable sentence when the text is long
  return first && c.length > 140 ? first[0] : c;
};
const dayLabel = (iso) => {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const diff = Math.round((t - d) / 864e5);
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : 'Earlier';
};
const TITLES = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', trash: 'Bin' };
const EMPTY = {
  inbox: ['ri-mail-check-line', 'Inbox zero', 'Nothing new. Enjoy the quiet.'],
  sent: ['ri-send-plane-2-line', 'Nothing sent yet', 'Messages you send will show up here.'],
  drafts: ['ri-draft-line', 'No drafts', 'Messages you start writing are saved here automatically.'],
  trash: ['ri-delete-bin-line', 'Bin is empty', 'Deleted mail stays here for 30 days.'],
  search: ['ri-search-line', 'No matches', 'Try a different word.'],
};
const skelRows = (n) => Array.from({ length: n }, () => '<li class="mail-row skel-row" aria-hidden="true"><div class="mail-item"><span class="skel skel-avatar"></span>'
  + '<div class="mail-item-body"><span class="skel skel-line w40"></span><span class="skel skel-line w75"></span><span class="skel skel-line w90"></span></div></div></li>').join('');

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
    const keep = new Set(ids); const gone = [];
    const d = await idb;
    if (!d) { memMails.forEach((r, k) => { if (r.folder === folder && !keep.has(r.id)) { memMails.delete(k); gone.push(r.id); } }); } else {
      const t = d.transaction('mails', 'readwrite');
      const c = t.objectStore('mails').index('byDate').openCursor(bounds(folder));
      c.onsuccess = () => { const cur = c.result; if (!cur) return; if (!keep.has(cur.value.id)) { gone.push(cur.value.id); cur.delete(); } cur.continue(); };
      await txDone(t);
    }
    for (const id of gone) await fileStore.removeMail(id).catch(() => {}); // their saved attachments go too
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

// ---------- attachments on this device ----------
// Files you open, plus small ones fetched in the background, are kept here (like Gmail's offline mode) so they
// open without the network. A database of its own: a mail row never has to be rewritten when a file is saved.
const FILE_CACHE_MAX = 250 * 1024 * 1024; // past this, the oldest saved files are dropped (they can be downloaded again)
const AUTO_FILE_MAX = 1024 * 1024; // files up to this size are fetched in the background after a sync
const fdb = new Promise((resolve) => {
  if (!window.indexedDB) return resolve(null);
  const r = indexedDB.open('mailbox-files', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('files', { keyPath: 'key' }).createIndex('byMail', 'mailId'); // small records: name, type, size
    d.createObjectStore('blobs'); // the bytes, kept apart so listing files never loads them
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => resolve(null);
});
const memFiles = new Map(); // used only if IndexedDB is unavailable (this session)
const fileStore = {
  async get(key) { // the file with its bytes, or null
    const d = await fdb;
    if (!d) return memFiles.get(key) || null;
    const info = await req2p(d.transaction('files').objectStore('files').get(key));
    if (!info) return null;
    const buf = await req2p(d.transaction('blobs').objectStore('blobs').get(key));
    return buf ? { ...info, buf } : null;
  },
  async saved(mailId) { // numbers of this mail's attachments that are on the device
    const d = await fdb;
    if (!d) return [...memFiles.values()].filter((f) => f.mailId === mailId).map((f) => f.n);
    return (await req2p(d.transaction('files').objectStore('files').index('byMail').getAll(mailId))).map((f) => f.n);
  },
  async put(rec) { // { key, mailId, n, name, type, size, ts, buf }
    const d = await fdb;
    if (!d) { memFiles.set(rec.key, rec); return; }
    const { buf, ...info } = rec;
    const t = d.transaction(['files', 'blobs'], 'readwrite');
    t.objectStore('files').put(info); t.objectStore('blobs').put(buf, rec.key);
    await txDone(t);
    await fileStore.trim().catch(() => {});
  },
  async removeMail(mailId) {
    memFiles.forEach((f, k) => { if (f.mailId === mailId) memFiles.delete(k); });
    const d = await fdb;
    if (!d) return;
    const keys = await req2p(d.transaction('files').objectStore('files').index('byMail').getAllKeys(mailId));
    if (!keys.length) return;
    const t = d.transaction(['files', 'blobs'], 'readwrite');
    keys.forEach((k) => { t.objectStore('files').delete(k); t.objectStore('blobs').delete(k); });
    return txDone(t);
  },
  async trim() { // keep the total under FILE_CACHE_MAX, oldest first
    const d = await fdb;
    if (!d) return;
    const all = await req2p(d.transaction('files').objectStore('files').getAll());
    let total = all.reduce((s, f) => s + f.size, 0);
    if (total <= FILE_CACHE_MAX) return;
    const t = d.transaction(['files', 'blobs'], 'readwrite');
    for (const f of all.sort((a, b) => a.ts - b.ts)) {
      if (total <= FILE_CACHE_MAX * 0.9) break;
      t.objectStore('files').delete(f.key); t.objectStore('blobs').delete(f.key); total -= f.size;
    }
    return txDone(t);
  },
  async clear() {
    memFiles.clear();
    const d = await fdb;
    if (!d) return;
    const t = d.transaction(['files', 'blobs'], 'readwrite');
    t.objectStore('files').clear(); t.objectStore('blobs').clear();
    return txDone(t);
  },
};

// Per-folder sync cursor ({ newest, oldest, hasOlder } as ms timestamps) and app-level bits.
const fresh = () => ({ inbox: {}, sent: {}, drafts: {}, trash: {}, app: { unread: 0, pendingRead: [], lastSync: 0 } });
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
  await store.clear(); await fileStore.clear().catch(() => {});
  meta = fresh(); appReady = null; state.mails = []; state.hasMore = false; state.shown = PAGE;
  hideReader(); setUnread(0); renderList();
}

async function api(path, opts = {}) {
  const token = await getToken();
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Authorization: 'Bearer ' + token },
  });
  if (res.ok && opts.binary) return res.arrayBuffer(); // a file, not JSON
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
    signOutFn = () => fa.signOut(auth).then(() => isNative() && cap('FirebaseAuthentication').signOut().catch(() => {}));
    $('#btnSignin').off('click').on('click', () => { // Google blocks sign-in popups inside an app's WebView, so the Android app signs in natively
      const go = isNative()
        ? cap('FirebaseAuthentication').signInWithGoogle({ skipNativeAuth: true }).then((r) => fa.signInWithCredential(auth, fa.GoogleAuthProvider.credential(r.credential.idToken)))
        : fa.signInWithPopup(auth, new fa.GoogleAuthProvider());
      go.catch((e) => showSignin('Sign-in failed: ' + e.message, true));
    });
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
    if (hint) {
      openApp(hint).then(async () => { // opened from a notification: the push already saved the mail, so show it now, before sign-in finishes
        const id = wantedMail(); const token = wantedToken();
        if (id && (token || await store.get('inbox', id))) { history.replaceState(null, '', location.pathname); openInboxMail(id, { sync: false, token }); }
      }).catch(() => {});
    }
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
  initPush().catch(() => {}); // notifications are required: asks for them here if they are not on yet
  const wanted = wantedMail(); const token = wantedToken(); // opened from a notification
  if (wanted) history.replaceState(null, '', location.pathname);
  if (wanted && (token || await store.get('inbox', wanted))) openInboxMail(wanted, { sync: false, token }); // show it now; the sync below runs alongside
  await syncAll({ reconcile: true });
  if (wanted && state.openId !== wanted) openInboxMail(wanted, { sync: false }); // no token and not saved: it had to be synced first
}
const wantedMail = () => new URLSearchParams(location.search).get('mail'); // set when the app is opened from a notification
const wantedToken = () => new URLSearchParams(location.search).get('t'); // read token of that mail, from its push

// ---------- list ----------
const COLORS = ['green', 'blue', 'indigo', 'red', 'yellow', 'pink', 'purple', 'slate'];
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
  try { if (window.MailNative) window.MailNative.setUnread(state.unread || 0); else if (navigator.setAppBadge) (state.unread ? navigator.setAppBadge(state.unread) : navigator.clearAppBadge()).catch(() => {}); } catch (e) { /* optional */ }
}

function renderList() {
  const q = $('#search').val().trim().toLowerCase();
  const onlyUnread = state.filter === 'unread' && state.folder === 'inbox';
  const items = state.mails.filter((m) => (!onlyUnread || !m.read) && (!q || `${m.subject} ${m.from} ${m.snippet}`.toLowerCase().includes(q)));
  const $ul = $('#mailGroup').empty().attr('aria-busy', String(Boolean(state.loading && !items.length)));
  if (!items.length && state.loading) $ul.append(skelRows(7));
  else if (!items.length) {
    const [icon, title, hint] = q ? EMPTY.search : onlyUnread ? ['ri-mail-check-line', 'All caught up', 'No unread messages.'] : EMPTY[state.folder];
    $ul.append(`<li class="list-empty"><i class="${icon}" aria-hidden="true"></i><strong>${title}</strong><span>${hint}</span></li>`);
  }
  let lastDay = '';
  items.forEach((m) => {
    const sent = state.folder === 'sent' || state.folder === 'drafts' || (state.folder === 'trash' && m.origin === 'sent');
    const drafts = state.folder === 'drafts';
    const who = drafts ? (m.to[0] ? 'To: ' + m.to[0] : 'No recipient') : sent ? 'To: ' + (m.to[0] || '') : label(m.from);
    const day = dayLabel(m.date);
    if (day !== lastDay) { lastDay = day; $ul.append(`<li class="mail-day" role="presentation">${day}</li>`); }
    $ul.append(`<li class="mail-row" data-dir=""><div class="swipe-bg" aria-hidden="true">`
      + (state.folder === 'inbox' ? `<span class="swipe-read"><i class="${m.read ? 'ri-mail-unread-line' : 'ri-mail-open-line'}"></i>${m.read ? 'Unread' : 'Read'}</span>`
        : state.folder === 'trash' ? '<span class="swipe-read"><i class="ri-arrow-go-back-line"></i>Restore</span>' : '')
      + '<span class="swipe-del">Delete<i class="ri-delete-bin-line"></i></span></div>'
      + `<div class="mail-item${m.read ? '' : ' unread'}${m.id === state.openId ? ' active' : ''}" data-id="${esc(m.id)}" role="button" tabindex="0">`
      + avatar(sent ? (m.to[0] || 'Draft') : m.from)
      + `<div class="mail-item-body"><div class="d-flex align-items-center"><h6 class="mail-subject">${m.read ? '' : '<span class="visually-hidden">Unread. </span>'}${esc(m.subject)}</h6>`
      + `${(m.attachments || []).length ? '<i class="ri-attachment-2 mail-clip" aria-label="Has attachment"></i>' : ''}<span class="mail-time">${esc(fmtDate(m.date))}</span></div>`
      + `<p class="mail-text"><span class="mail-sender${drafts ? ' mail-draft' : ''}">${esc(who)}</span> \u2013 ${esc(previewOf(m))}</p></div></div></li>`);
  });
  if (state.hasMore && !q) $ul.append('<li class="load-more"><button id="loadMore" class="btn btn-sm btn-outline-primary">Load more</button></li>');
  renderStatus();
  ps.update();
}

function renderStatus() {
  const n = state.mails.length; const total = meta[state.folder].total;
  $('#countText').text((navigator.onLine ? '' : 'Offline · ') + (n ? (total ? `${n} of ${total}` : `${n} saved`) + (state.folder === 'trash' ? ' · removed after 30 days' : '') : ''));
  $('#totalInbox').text(meta.inbox.total || '');
  $('#totalSent').text(meta.sent.total || '');
  $('#totalDrafts').text(meta.drafts.total || '');
  $('#totalTrash').text(meta.trash.total || '');
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
    const folders = reconcile ? ['inbox', 'sent', 'drafts', 'trash'] : ['inbox'].concat(state.folder !== 'inbox' ? [state.folder] : []);
    for (const f of folders) await syncFolder(f, reconcile);
    meta.app.lastSync = Date.now(); await saveMeta('app');
  } catch (e) { if (manual || navigator.onLine) toast(e.status ? e.message : 'Could not sync. Showing saved mail.'); }
  syncing = false; state.loading = false; $('#refresh i').removeClass('spin');
  await showFolder();
  prefetchFiles();
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
const FRAME_DARK = `${FRAME_CSP}<style>html{background:transparent;color-scheme:dark}${FRAME_BASE}body{color:#e6e1e5}a{color:#d0bcff}</style>`;

// Phone back button / swipe: every screen layered on top of the list (reader, sidebar, compose, popups, a
// folder other than Inbox, the unread filter, search) is a "layer" with its own history entry, so back closes
// the top layer instead of leaving the app. `depth` counts the history entries we added; sync() keeps it equal
// to layers.length, so UI changes and system back can never get out of step.
const layers = []; let depth = 0, hopping = 0;
const openModals = new Set(); let menuOpen = false;
function sync() {
  if (hopping) return; // a history.go() is in flight; popstate will call sync() again
  while (depth < layers.length) history.pushState({ mb: ++depth }, '');
  if (depth > layers.length) { hopping = depth - layers.length; history.go(-hopping); }
}
function undoLayer(name) { // put the screen back the way it was without this layer
  if (name === 'mail') $('body').removeClass('mailcontent-show');
  else if (name === 'side') $('body').removeClass('sidebar-show');
  else if (name === 'compose') { if (!$('.compose').hasClass('d-none')) $('.nav-link-close').first().trigger('click'); }
  else if (name === 'modal') {
    const el = [...document.querySelectorAll('.modal.show')].pop();
    if (el) { openModals.delete(el.id); window.bootstrap.Modal.getOrCreateInstance(el).hide(); }
  }
  else if (name === 'menu') { menuOpen = false; const t = document.getElementById('btnMore'); if (t) window.bootstrap.Dropdown.getOrCreateInstance(t).hide(); }
  else if (name === 'list') closeCsList(true);
  else if (name === 'folder') $('#folders .nav-link[data-folder="inbox"]').trigger('click');
  else if (name === 'filter') setFilter('all');
  else if (name === 'search') { $('#search').val('').trigger('input').trigger('blur'); $('.mailbox-header').removeClass('searching'); }
}
function pushLayer(name) { layers.push(name); sync(); }
function dropLayer(name) { const i = layers.lastIndexOf(name); if (i >= 0) layers.splice(i, 1); sync(); }
function closeLayer(name) { dropLayer(name); undoLayer(name); }
window.addEventListener('popstate', () => {
  if (hopping) { depth -= hopping; hopping = 0; sync(); return; }
  if (depth > 0) depth--; // the person pressed back: history already moved one step
  const name = layers.pop();
  if (name) undoLayer(name);
  sync();
});
// Called by the Android app (MainActivity) on the system back button: closes the top layer, false if none is open.
window.__layerBack = () => {
  const name = layers.pop();
  if (!name) return false;
  undoLayer(name); sync();
  return true;
};
// Popups: Bootstrap modals and the "More" menu register themselves while they are open.
$('.modal').on('show.bs.modal', function () { if (!openModals.has(this.id)) { openModals.add(this.id); pushLayer('modal'); } })
  .on('hidden.bs.modal', function () { if (openModals.delete(this.id)) dropLayer('modal'); });
$('#btnMore').parent().on('show.bs.dropdown', () => { if (!menuOpen) { menuOpen = true; pushLayer('menu'); } })
  .on('hidden.bs.dropdown', () => { if (menuOpen) { menuOpen = false; dropLayer('menu'); } });

// ---- custom lists: themed replacement for the native <select> popup (the phone's own picker can't be themed or closed by back) ----
let csOpen = null;
const csList = document.createElement('ul');
csList.id = 'csList'; csList.className = 'cs-list d-none'; csList.setAttribute('role', 'listbox');
document.body.appendChild(csList);
function csRefresh(sel) {
  if (!sel._csBtn) return;
  const o = sel.options[sel.selectedIndex];
  sel._csBtn.textContent = o ? o.textContent : '';
  sel._csBtn.disabled = sel.disabled || !sel.options.length;
}
function closeCsList(fromBack) {
  if (!csOpen) return;
  csOpen.btn.setAttribute('aria-expanded', 'false');
  csOpen = null; csList.classList.add('d-none'); csList.innerHTML = '';
  if (!fromBack) dropLayer('list');
}
function openCsList(sel) {
  closeCsList(false);
  const btn = sel._csBtn; const r = btn.getBoundingClientRect();
  csList.innerHTML = [...sel.options].map((o, i) => `<li role="option" data-i="${i}" class="cs-item${i === sel.selectedIndex ? ' on' : ''}" aria-selected="${i === sel.selectedIndex}">${esc(o.textContent)}</li>`).join('');
  csList.classList.remove('d-none');
  const w = Math.min(Math.max(r.width, 180), window.innerWidth - 16);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const below = window.innerHeight - r.bottom; const up = below < 220 && r.top > below;
  csList.style.cssText = `width:${w}px;left:${left}px;max-height:${Math.max(120, Math.min(window.innerHeight * 0.45, (up ? r.top : below) - 12))}px;`
    + (up ? `bottom:${window.innerHeight - r.top + 4}px;top:auto` : `top:${r.bottom + 4}px;bottom:auto`);
  csOpen = { sel, btn }; btn.setAttribute('aria-expanded', 'true');
  pushLayer('list');
  const on = csList.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}
function customSelect(sel) {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'cs-btn ' + sel.className;
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  sel.classList.add('cs-native'); sel.tabIndex = -1; sel._csBtn = btn;
  sel.insertAdjacentElement('afterend', btn);
  btn.addEventListener('click', () => { if (csOpen && csOpen.sel === sel) closeCsList(false); else openCsList(sel); });
  new MutationObserver(() => csRefresh(sel)).observe(sel, { childList: true, subtree: true });
  $(sel).on('change', () => csRefresh(sel));
  csRefresh(sel);
}
csList.addEventListener('click', (e) => {
  const li = e.target.closest('.cs-item'); if (!li || !csOpen) return;
  const sel = csOpen.sel; sel.selectedIndex = Number(li.dataset.i);
  closeCsList(false); csRefresh(sel); $(sel).trigger('change');
});
document.addEventListener('pointerdown', (e) => { if (csOpen && !csList.contains(e.target) && !csOpen.btn.contains(e.target)) closeCsList(false); });
const jqVal = $.fn.val; // .val(x) on a <select> doesn't fire events, so refresh the label ourselves
$.fn.val = function (v) { const r = jqVal.apply(this, arguments); if (arguments.length) this.filter('select').each((_, el) => csRefresh(el)); return r; };
['cFrom', 'cTplSel', 'tplPick'].forEach((id) => customSelect(document.getElementById(id)));

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

// ---------- attachments ----------
const MIME_RE = /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/;
// Only types the browser shows without running anything are opened in a tab. Everything else (HTML, SVG, scripts...)
// is saved as an opaque download, so a file from outside can never run inside this app's origin.
const PREVIEWABLE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain|audio\/(mpeg|mp4|ogg|wav|webm)|video\/(mp4|webm))$/;
const noFile = new Set(); // files the server said are gone: not asked for again this session
let persistAsked = false;
function askPersist() { // ask the browser not to evict saved files when the device runs low on space
  if (persistAsked) return; persistAsked = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
}

function attachChips(m) {
  return (m.attachments || []).map((a, n) => `<button type="button" class="attach-chip" data-n="${n}" title="Download ${esc(a.filename)}">`
    + '<i class="ri-download-2-line attach-state" aria-hidden="true"></i>'
    + `<span class="attach-name">${esc(a.filename)}</span>${a.size ? `<span class="attach-size">${fmtSize(a.size)}</span>` : ''}</button>`).join('');
}
function setChip(el, st) { // 'idle' | 'busy' | 'saved'
  el.classList.toggle('busy', st === 'busy'); el.classList.toggle('saved', st === 'saved');
  el.querySelector('.attach-state').className = 'attach-state ' + (st === 'busy' ? 'ri-loader-4-line spin' : st === 'saved' ? 'ri-check-line' : 'ri-download-2-line');
  el.title = (st === 'saved' ? 'Open ' : 'Download ') + (el.querySelector('.attach-name').textContent || '');
}
async function markSavedFiles(m) { // tick the files that are already on this device
  const saved = new Set(await fileStore.saved(m.id).catch(() => []));
  if (state.openId !== m.id) return;
  $('#rAttach .attach-chip').each((i, el) => { if (saved.has(Number(el.dataset.n))) setChip(el, 'saved'); });
}

// Download one attachment and keep it on this device. A failure to save (storage full) still hands the file over.
async function fetchFile(m, n, a, folder) {
  const buf = await api(`/api/mails/${encodeURIComponent(m.id)}/attachments/${n}?folder=${folder}`, { binary: true });
  const type = String(a.contentType || '').toLowerCase();
  const rec = { key: m.id + ':' + n, mailId: m.id, n, name: a.filename || 'attachment', type: MIME_RE.test(type) ? type : 'application/octet-stream', size: buf.byteLength, ts: Date.now(), buf };
  try { await fileStore.put(rec); askPersist(); rec.saved = true; } catch (e) { rec.saved = false; }
  return rec;
}

function b64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function deliverFile(rec) {
  const N = window.MailNative;
  if (N) { // Android app: a WebView cannot download a blob, so the app saves it into Downloads and offers to open it
    if (typeof N.saveFile !== 'function') return toast('Update the app to download attachments.');
    let ok = false;
    try { ok = N.saveFile(rec.name, rec.type, b64(rec.buf)); } catch (e) { /* reported below */ }
    return toast(ok ? 'Saved to Downloads' : 'Could not save this file.');
  }
  const preview = PREVIEWABLE.test(rec.type);
  const url = URL.createObjectURL(new Blob([rec.buf], { type: preview ? rec.type : 'application/octet-stream' }));
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  if (preview && window.open(url, '_blank', 'noopener')) return;
  const link = document.createElement('a');
  link.href = url; link.download = rec.name; document.body.appendChild(link); link.click(); link.remove();
}

async function openAttachment(m, n, el) {
  const a = m && (m.attachments || [])[n];
  if (!a || (el && el.classList.contains('busy'))) return;
  let rec = await fileStore.get(m.id + ':' + n).catch(() => null);
  if (!rec) {
    if (!navigator.onLine) return toast('Go online to download this file.');
    if (el) setChip(el, 'busy');
    try { rec = await fetchFile(m, n, a, state.folder); } catch (e) {
      if (e.status === 404) noFile.add(m.id + ':' + n);
      if (el) setChip(el, 'idle');
      return toast(e.status === 404 ? 'This file is no longer available.' : e.message);
    }
    if (el) setChip(el, rec.saved ? 'saved' : 'idle');
  }
  deliverFile(rec);
}
$('#rAttach').on('click', '.attach-chip', function () { openAttachment(state.openMail, Number(this.dataset.n), this); });

let prefetching = false;
async function prefetchFiles() { // small files of the newest inbox mail are fetched after a sync, so they open offline
  if (prefetching || !navigator.onLine || (navigator.connection && navigator.connection.saveData)) return;
  prefetching = true;
  try {
    let budget = 8; // per sync, so a first load on a new device fills in over a few syncs
    for (const m of await store.list('inbox', 15)) {
      if (!(m.attachments || []).length) continue;
      const have = new Set(await fileStore.saved(m.id));
      for (let n = 0; n < m.attachments.length && budget > 0; n++) {
        const a = m.attachments[n];
        if (!a.size || a.size > AUTO_FILE_MAX || have.has(n) || noFile.has(m.id + ':' + n)) continue;
        budget--;
        try { await fetchFile(m, n, a, 'inbox'); } catch (e) { if (e.status === 404) noFile.add(m.id + ':' + n); else throw e; }
      }
    }
  } catch (e) { /* tried again on the next sync */ }
  prefetching = false;
}

function renderReader(m) {
  const trash = state.folder === 'trash'; const inbox = state.folder === 'inbox';
  const sent = state.folder === 'sent' || (trash && m.origin === 'sent');
  const p = parseAddr(m.from);
  $('#rSubject').text(m.subject);
  const who = sent ? m.to[0] : m.from;
  $('#rAvatar').attr('class', colorOf(who)).text(label(who).charAt(0).toLowerCase());
  $('#rFrom').html(sent ? `Me <span>&lt;${esc(m.from)}&gt;</span>` : `${esc(p.name || p.addr)}${p.name ? ` <span>&lt;${esc(p.addr)}&gt;</span>` : ''}`);
  $('#rTo').text('to: ' + m.to.join(', ') + ((m.cc || []).length ? ' · cc: ' + m.cc.join(', ') : '') + ((m.bcc || []).length ? ' · bcc: ' + m.bcc.join(', ') : ''));
  $('#rTime').text(fullDate(m.date));
  $('#btnReplyTop, #btnReply').toggleClass('d-none', !inbox);
  $('#mnReply, #mnUnread, #btnUnreadTop').toggleClass('d-none', !inbox);
  $('#btnFwdTop, #btnForward, #mnForward').toggleClass('d-none', trash);
  $('#btnRestoreTop, #mnRestore').toggleClass('d-none', !trash);
  $('#btnDelTop').attr({ title: trash ? 'Delete forever' : 'Move to Bin', 'aria-label': trash ? 'Delete forever' : 'Move to Bin' });
  const rUrl = resendUrl(m, sent ? 'sent' : state.folder);
  $('#mnResend').toggleClass('d-none', !rUrl).attr('href', rUrl || '#');
  $('#rAttach').html(attachChips(m));
  if ((m.attachments || []).length) markSavedFiles(m);
  renderBody(m);
  mc.update();
}

async function openMail(id, { ready } = {}) {
  if (state.folder === 'drafts') return editDraft(id); // ready: optional async step that makes the mail available (it is shown as loading until then)
  const folder = state.folder;
  state.openId = id;
  $('#mailGroup .mail-item').removeClass('active').filter((i, el) => el.dataset.id === id).addClass('active');
  showReader();
  $('#rSubject').html('<span class="skel skel-line w75 skel-title" role="status" aria-label="Loading"></span>');
  $('#rBody').html('<span class="skel skel-line w90"></span><span class="skel skel-line w75"></span><span class="skel skel-line w60"></span>'); $('#rAttach').empty();
  if (ready) await ready();
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
const MAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const TPL_FORBID = ['style', 'meta', 'base', 'link', 'form', 'iframe', 'object', 'embed', 'script'];
const cleanTpl = (html) => window.DOMPurify.sanitize(html || '', { FORBID_TAGS: TPL_FORBID });
const asList = (v) => [].concat(v || []).filter(Boolean);
let composeDirty = false; let draftTimer = null; let draftBusy = null; let templates = null;

// Recipient fields: every address becomes a pill (red when it is not a valid address). Click a pill's text to edit it.
const pillsOf = ($box) => $box.find('.pill').map((i, el) => el.dataset.addr).get();
function initPillBox($box) {
  const label = esc($box.data('label'));
  $box.html(`<span class="pill-label">${label}</span><span class="pill-list"></span><input class="pill-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${label}">`);
}
function addPills($box, text) {
  const found = String(text).match(/[^\s,;<>"']+@[^\s,;<>"']+/g); // also pulls the address out of "Name <a@b.c>"
  const items = found || (String(text).trim() ? [String(text).trim()] : []);
  const have = new Set(pillsOf($box).map((a) => a.toLowerCase()));
  items.forEach((a) => {
    if (have.has(a.toLowerCase())) return;
    have.add(a.toLowerCase());
    $box.find('.pill-list').append(`<span class="pill${MAIL_RE.test(a) ? '' : ' bad'}" data-addr="${esc(a)}"><span class="pill-text">${esc(a)}</span>`
      + `<button type="button" class="pill-x" tabindex="-1" aria-label="Remove ${esc(a)}"><i class="ri-close-line" aria-hidden="true"></i></button></span>`);
  });
  if (items.length) queueDraft();
}
const setPills = ($box, list) => { $box.find('.pill').remove(); $box.find('.pill-input').val(''); asList(list).forEach((a) => addPills($box, a)); };
const commitPill = ($input) => { const v = $input.val(); if (v.trim()) { $input.val(''); addPills($input.closest('.pill-box'), v); } };
const commitAllPills = () => $('.compose .pill-input').each(function () { commitPill($(this)); });
const showCc = (on) => { $('#cCcRow, #cBccRow').toggleClass('d-none', !on); $('#cCcToggle').toggleClass('d-none', on); };

// ---- templates (HTML blocks kept on the server, offered when a message is started) ----
async function loadTemplates(force) {
  if (templates && !force) return templates;
  if (!navigator.onLine) return templates || [];
  try { templates = (await api('/api/templates')).templates; } catch (e) { templates = templates || []; }
  return templates;
}
function attachTemplate(t) { // t: { name, html } or null
  $('.compose').data('tpl', t || null);
  $('#cTplOn').toggleClass('d-none', !t); $('#cTpl').addClass('d-none');
  if (t) { $('#cTplName').text(t.name || 'Template'); $('#cTplPreview').html(cleanTpl(t.html)); }
}
async function offerTemplate() {
  const list = await loadTemplates();
  const $c = $('.compose');
  if (!list.length || $c.hasClass('d-none') || $c.data('tpl') || $c.data('tplSkipped')) return;
  $('#cTplSel').html(list.map((t) => `<option value="${esc(t.id)}"${t.isDefault ? ' selected' : ''}>${esc(t.name)}</option>`).join(''));
  $('#cTpl').removeClass('d-none');
}

// ---- drafts: saved a couple of seconds after you stop typing ----
const composeData = () => {
  const $c = $('.compose'); const tpl = $c.data('tpl');
  return {
    id: $c.data('draftId') || undefined, from: $('#cFrom').val() || '',
    to: pillsOf($('#cTo')), cc: pillsOf($('#cCc')), bcc: pillsOf($('#cBcc')),
    subject: $('#cSubject').val(), text: $('#cBody').val(), htmlMode: $('#cHtml').is(':checked'),
    replyToId: $c.data('replyToId') || undefined, templateHtml: tpl ? tpl.html : '', templateName: tpl ? tpl.name : '',
  };
};
const composeEmpty = (d) => !d.to.length && !d.cc.length && !d.bcc.length && !d.subject.trim() && !d.text.trim() && !d.templateHtml;
function queueDraft() { composeDirty = true; clearTimeout(draftTimer); draftTimer = setTimeout(() => saveDraft(), 2000); }
async function saveDraft() {
  clearTimeout(draftTimer);
  if (!composeDirty || $('.compose').hasClass('d-none') || !navigator.onLine) return false;
  const d = composeData();
  if (composeEmpty(d)) return false;
  if (draftBusy) await draftBusy.catch(() => {}); // one save at a time, so a new draft's id is known before the next one
  composeDirty = false;
  const $c = $('.compose'); d.id = $c.data('draftId') || undefined;
  draftBusy = api('/api/drafts', { method: 'POST', body: JSON.stringify(d) });
  try {
    const r = await draftBusy;
    $c.data('draftId', r.id); $('#cDraftState').text('Draft saved');
    syncFolder('drafts', false).then(() => (state.folder === 'drafts' ? showFolder() : renderStatus())).catch(() => {});
    return true;
  } catch (e) {
    if (e.status === 404) $c.data('draftId', null); // discarded or sent elsewhere: the next save starts a new draft
    composeDirty = true; $('#cDraftState').text('Not saved');
    return false;
  } finally { draftBusy = null; }
}

function openCompose({ to = [], cc = [], bcc = [], from = '', subject = '', body = '', replyToId = null, draftId = null, template = null, htmlMode = false, title = 'New Message' } = {}) {
  clearTimeout(draftTimer);
  $('#composeTitle').text(title);
  $('#cFrom').html((config.aliases || []).map((a) => `<option>${esc(a)}</option>`).join('')).closest('.form-group').toggle((config.aliases || []).length > 1);
  if (from) $('#cFrom').val(from);
  setPills($('#cTo'), to); setPills($('#cCc'), cc); setPills($('#cBcc'), bcc);
  showCc(asList(cc).length > 0 || asList(bcc).length > 0);
  $('#cSubject').val(subject); $('#cBody').val(body); $('#cHtml').prop('checked', htmlMode); $('#cDraftState').text('');
  $('.compose').data({ replyToId, draftId, tplSkipped: false }).removeClass('d-none minimize');
  attachTemplate(template);
  $('.menu-compose').addClass('d-none');
  if (!layers.includes('compose')) pushLayer('compose');
  if (!template) offerTemplate();
  if (asList(to).length) { const el = $('#cBody').trigger('focus')[0]; el.setSelectionRange(0, 0); el.scrollTop = 0; } else $('#cTo .pill-input').trigger('focus');
  clearTimeout(draftTimer); composeDirty = false;
}

function closeCompose() {
  clearTimeout(draftTimer); composeDirty = false;
  $('.compose').addClass('d-none').removeClass('minimize fullscreen');
  $('.menu-compose').removeClass('d-none');
  dropLayer('compose');
}

async function editDraft(id) {
  const m = await store.get('drafts', id);
  if (!m) return toast('Draft not found.');
  openCompose({
    to: m.to, cc: m.cc, bcc: m.bcc, from: m.from, subject: m.subject === '(no subject)' ? '' : m.subject, body: m.text || '',
    replyToId: m.replyToId, draftId: m.id, htmlMode: m.htmlMode, title: 'Draft',
    template: m.templateHtml ? { name: m.templateName || 'Template', html: m.templateHtml } : null,
  });
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
  commitAllPills();
  if ($('.compose .pill.bad').length) return toast('Fix the red address first.');
  if (!pillsOf($('#cTo')).length) return toast('Add at least one recipient.');
  clearTimeout(draftTimer);
  $('#cSend').prop('disabled', true);
  try {
    if (draftBusy) await draftBusy.catch(() => {});
    const d = composeData(); const $c = $('.compose'); const tpl = $c.data('tpl');
    const payload = { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, from: d.from || undefined, replyToId: d.replyToId, draftId: $c.data('draftId') || undefined };
    if (tpl) { // message first, then the template block
      const head = d.htmlMode ? d.text : `<div style="white-space:pre-wrap">${esc(d.text)}</div>`;
      payload.html = `${head}<br><br>${tpl.html}`;
      if (!d.htmlMode) payload.text = `${d.text}\n\n${new DOMParser().parseFromString(cleanTpl(tpl.html), 'text/html').body.textContent.replace(/\n{3,}/g, '\n\n').trim()}`;
    } else payload[d.htmlMode ? 'html' : 'text'] = d.text;
    await api('/api/send', { method: 'POST', body: JSON.stringify(payload) });
    const did = payload.draftId;
    closeCompose(); toast('Sent');
    if (did) { await store.remove('drafts', did); if (meta.drafts.total) meta.drafts.total -= 1; await saveMeta('drafts'); }
    await syncFolder('sent', false).catch(() => {});
    if (state.folder === 'sent' || state.folder === 'drafts') await showFolder(); else renderStatus();
  } catch (e) { toast(e.message); }
  $('#cSend').prop('disabled', false);
}

// ---------- message menu (three dots) ----------
// Dashboard page of a message at Resend. A received mail's id is its Resend id; sent mail stores it as resendId.
const resendUrl = (m, folder) => {
  const id = folder === 'sent' ? m.resendId : m.id;
  return id ? 'https://resend.com/emails/' + encodeURIComponent(id) : null;
};

async function deleteMail(id) { // id: a row swiped in the list; none: the message open in the reader
  const m = id ? { id } : state.openMail; const folder = state.folder;
  if (!m) return;
  if (!navigator.onLine) return toast('Go online to delete mail.');
  const hard = folder === 'trash' || folder === 'drafts';
  const ask = folder === 'drafts' ? { title: 'Discard draft?', message: 'This draft is deleted from every device.', ok: 'Discard', danger: true }
    : hard ? { title: 'Delete forever?', message: 'It is removed from every device and cannot be recovered.', ok: 'Delete forever', danger: true }
      : { title: 'Move to Bin?', message: 'You can restore it from the Bin for 30 days.', ok: 'Move to Bin' };
  if (!(await askConfirm(ask))) return;
  const row = await store.get(folder, m.id);
  try {
    await api(`/api/mails/${encodeURIComponent(m.id)}?folder=${folder}`, { method: 'DELETE' });
  } catch (e) { return toast(e.message); }
  await store.remove(folder, m.id);
  if (hard) fileStore.removeMail(m.id).catch(() => {}); // deleted forever: its saved attachments go too
  if (meta[folder].total) meta[folder].total -= 1;
  await saveMeta(folder);
  if (folder === 'inbox') {
    if (row && !row.read) meta.app.unread = Math.max(0, meta.app.unread - 1);
    meta.app.pendingRead = meta.app.pendingRead.filter((x) => x !== m.id);
    await saveMeta('app');
  }
  if (!id || state.openId === id) hideReader();
  await showFolder();
  toast(hard ? 'Deleted' : 'Moved to Bin');
  if (!hard) syncFolder('trash', false).then(renderStatus).catch(() => {});
}

async function restoreMail(id) {
  const m = id ? { id } : state.openMail;
  if (!m || state.folder !== 'trash') return;
  if (!navigator.onLine) return toast('Go online to restore mail.');
  let r;
  try { r = await api(`/api/mails/${encodeURIComponent(m.id)}/restore`, { method: 'POST' }); } catch (e) { return toast(e.message); }
  await store.remove('trash', m.id);
  if (meta.trash.total) meta.trash.total -= 1;
  await saveMeta('trash');
  // Put it straight back: a normal sync only fetches mail newer than the newest one saved, and a restored mail is older.
  if (r.mail) {
    await store.put(r.folder, [r.mail]);
    meta[r.folder].total = (meta[r.folder].total || 0) + 1; await saveMeta(r.folder);
    if (r.folder === 'inbox' && !r.mail.read) { meta.app.unread += 1; await saveMeta('app'); }
  }
  if (!id || state.openId === id) hideReader();
  await showFolder();
  toast(r.folder === 'sent' ? 'Restored to Sent' : 'Restored to Inbox');
}

async function emptyBin() {
  if (!navigator.onLine) return toast('Go online to empty the Bin.');
  if (!(await askConfirm({ title: 'Empty Bin?', message: 'Everything in the Bin is deleted forever.', ok: 'Empty Bin', danger: true }))) return;
  try { await api('/api/trash', { method: 'DELETE' }); } catch (e) { return toast(e.message); }
  for (const r of await store.list('trash', 100000)) { await store.remove('trash', r.id); await fileStore.removeMail(r.id).catch(() => {}); }
  meta.trash = {}; await saveMeta('trash');
  hideReader(); await showFolder(); toast('Bin emptied');
}

// Swipe action: flip one inbox message between read and unread (same server calls as opening / "Mark as unread").
async function toggleReadById(id) {
  if (state.folder !== 'inbox') return;
  const row = await store.get('inbox', id);
  if (!row) return;
  if (row.read) {
    if (!navigator.onLine) return toast('Go online to change this.');
    try { await api(`/api/mails/${encodeURIComponent(id)}/unread`, { method: 'POST' }); } catch (e) { return toast(e.message); }
    meta.app.pendingRead = meta.app.pendingRead.filter((x) => x !== id);
    await store.patch('inbox', id, { read: false });
    meta.app.unread += 1;
  } else {
    await store.patch('inbox', id, { read: true });
    meta.app.unread = Math.max(0, meta.app.unread - 1);
    if (!meta.app.pendingRead.includes(id)) meta.app.pendingRead.push(id);
    if (navigator.onLine && authUser) flushReads().catch(() => {}); // offline: sent on the next sync
  }
  await saveMeta('app');
  await showFolder();
  toast(row.read ? 'Marked as unread' : 'Marked as read');
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
const modalOf = (el) => bootstrap.Modal.getOrCreateInstance(el);
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
  const $b = $('#btnNotify').toggleClass('on', on).attr('title', on ? 'Notifications are on (tap to send a test)' : 'Notifications are off')
    .attr('aria-label', on ? 'Send a test notification' : 'Notifications are off');
  $b.find('i').attr('class', on ? 'ri-notification-3-fill' : 'ri-notification-off-line');
};
async function currentPush() {
  const reg = await navigator.serviceWorker.ready;
  return { reg, sub: await reg.pushManager.getSubscription() };
}
const subscribeNow = (reg) => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(config.vapidPublicKey) });
const savePushSub = (sub) => api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
const sameKey = (sub, key) => { // was this subscription made with the server's current key?
  const a = sub.options && sub.options.applicationServerKey;
  if (!a) return true;
  const x = new Uint8Array(a); const y = b64ToBytes(key);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// Notifications are required: until they are on, a full-screen prompt covers the app.
function showGate(kind, note) { // kind: 'ask' (not asked yet) or 'blocked' (turned off in settings)
  const blocked = kind === 'blocked';
  $('#notifyGate').removeClass('d-none');
  $('#ngTitle').text(blocked ? 'Notifications are blocked' : 'Turn on notifications');
  $('#ngText').text(blocked
    ? 'Open this app’s or site’s settings, set Notifications to Allow, then come back and tap the button.'
    : 'New mail arrives as a notification, and tapping it opens the mail straight away. Notifications must be on to use this app.');
  $('#ngAllow').text(blocked ? 'I’ve allowed them' : 'Allow notifications');
  $('#ngNote').text(note || '');
}
const hideGate = () => $('#notifyGate').addClass('d-none');

async function activatePush() { // permission is granted: make sure there is a live subscription and the server has it
  const { reg, sub } = await currentPush();
  let active = sub;
  if (active && config.vapidPublicKey && !sameKey(active, config.vapidPublicKey)) { // the server's key changed (an update): start over
    await active.unsubscribe().catch(() => {});
    active = null;
  }
  if (!active) active = await subscribeNow(reg);
  await savePushSub(active);
}

// Android app: notifications come from FCM instead of Web Push.
let nativeRegistered = false;
async function initNativePush() {
  const P = cap('PushNotifications');
  $('#btnNotify').removeClass('d-none');
  const p = await P.checkPermissions();
  if (p.receive !== 'granted') { bellState(false); return showGate(p.receive === 'denied' ? 'blocked' : 'ask'); }
  hideGate();
  if (!nativeRegistered) { nativeRegistered = true; await P.register(); } // the 'registration' event below sends the token to the server
  bellState(true);
}
if (isNative()) {
  const P = cap('PushNotifications');
  P.addListener('registration', (t) => api('/api/push/fcm', { method: 'POST', body: JSON.stringify({ token: t.value }) }).catch(() => { nativeRegistered = false; }));
  P.addListener('pushNotificationReceived', () => { if (authUser) syncAll(); }); // app is on screen: just refresh
  P.addListener('pushNotificationActionPerformed', (a) => { // notification tapped
    const d = (a.notification && a.notification.data) || {};
    if (!d.id) return;
    if (appReady) openInboxMail(d.id, { token: d.t });
    else history.replaceState(null, '', '/?mail=' + encodeURIComponent(d.id) + (d.t ? '&t=' + encodeURIComponent(d.t) : '')); // cold start: start() opens it
  });
}


// Android app: pick up what the native side queued (notification tap, mailto: link, shared text), and drop the splash.
let nativeTries = 0;
// Android shell: sync when the app comes back to the front (the web app's own timer is paused in the background).
window.__nativeResume = () => { if (authUser && appReady && Date.now() - (meta.app.lastSync || 0) > 15000) syncAll(); };
// Android shell: the APK comes from GitHub Releases, so look there for a newer build (at most every 6 hours).
async function checkUpdate() {
  const N = window.MailNative;
  if (!N || typeof N.versionCode !== 'function' || !authUser || !appReady) return;
  let st = {}; try { st = JSON.parse(localStorage.getItem('mb_upd') || '{}'); } catch (e) { /* none */ }
  if (Date.now() - (st.t || 0) < 6 * 3600 * 1000) return;
  try {
    const r = await fetch('https://api.github.com/repos/notamitgamer/mail-server/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const rel = await r.json();
    const m = /versionCode:\s*(\d+)/.exec(rel.body || '') || /android-build-(\d+)/.exec(rel.tag_name || '');
    const asset = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
    st.t = Date.now(); localStorage.setItem('mb_upd', JSON.stringify(st));
    if (!m || !asset) return;
    const latest = Number(m[1]);
    if (latest <= Number(N.versionCode()) || st.skip === latest) return;
    const ok = await askConfirm({ title: 'Update available', message: 'A newer version of the Mailbox app is ready (build ' + latest + '). Download it now?', ok: 'Download' });
    if (ok) N.openUrl(asset.browser_download_url); else { st.skip = latest; localStorage.setItem('mb_upd', JSON.stringify(st)); }
  } catch (e) { /* offline or rate limited: try again next time */ }
}
setTimeout(checkUpdate, 10000);
window.__nativePending = () => {
  if (!window.MailNative) return;
  if (!appReady || !authUser) { if (nativeTries++ < 40) setTimeout(window.__nativePending, 300); return; }
  let p = null;
  try { p = JSON.parse(window.MailNative.takePending() || 'null'); } catch (e) { /* none */ }
  if (!p) return;
  if (p.kind === 'mail' && p.id) openInboxMail(p.id, { token: p.t }).then(() => { if (p.reply) startReply(); });
  else if (p.kind === 'compose') openCompose({ to: p.to || [], subject: p.subject || '', body: p.body || '' });
};
window.addEventListener('load', () => { setTimeout(() => { try { if (window.MailNative) window.MailNative.hideSplash(); } catch (e) { /* optional */ } }, 500); window.__nativePending(); });

let pushBusy = false;
async function initPush() { // after sign-in and every time the app comes back to the front: keep notifications on
  if (isNative()) return initNativePush().catch((e) => toast('Could not set up notifications: ' + e.message));
  if (pushBusy || !pushSupported() || !config || !config.vapidPublicKey) return; // not supported here (e.g. an iPhone browser tab) or the server has push off
  pushBusy = true;
  try {
    $('#btnNotify').removeClass('d-none');
    if (Notification.permission !== 'granted') { bellState(false); return showGate(Notification.permission === 'denied' ? 'blocked' : 'ask'); }
    hideGate();
    if (!navigator.onLine) return;
    await activatePush();
    bellState(true);
  } catch (e) {
    bellState(false);
    if (navigator.onLine) toast('Could not set up notifications: ' + e.message);
  } finally { pushBusy = false; }
}

$('#ngAllow').on('click', async () => {
  const $b = $('#ngAllow').prop('disabled', true);
  try {
    if (isNative()) {
      const r = await cap('PushNotifications').requestPermissions();
      if (r.receive === 'denied') return showGate('blocked');
      if (r.receive !== 'granted') return showGate('ask', 'Tap Allow in the prompt to continue.');
      await initNativePush();
      api('/api/push/test', { method: 'POST' }).catch(() => {});
      return;
    }
    if (Notification.permission !== 'granted') await Notification.requestPermission();
    if (Notification.permission === 'denied') return showGate('blocked');
    if (Notification.permission !== 'granted') return showGate('ask', 'Tap Allow in the prompt to continue.');
    if (!navigator.onLine) return showGate('ask', 'Connect to the internet to finish turning on notifications.');
    await activatePush();
    hideGate(); bellState(true);
    api('/api/push/test', { method: 'POST' }).catch(() => {}); // a notification should appear in a moment
  } catch (e) { showGate('ask', 'Could not turn on notifications: ' + e.message); }
  finally { $b.prop('disabled', false); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && authUser) initPush().catch(() => {}); }); // e.g. back from settings

async function testPush() { // the bell: notifications cannot be turned off here, it only sends a test
  if (!$('#btnNotify').hasClass('on')) return initPush();
  if (!navigator.onLine) return toast('Go online to send a test.');
  try { await api('/api/push/test', { method: 'POST' }); toast('Test notification sent'); } catch (e) { toast('Could not send a test: ' + e.message); }
}

// Fetches one mail with the read token from its push and saves it. No sign-in and no sync needed, so a tap
// that comes before the service worker has finished saving the mail is still quick.
async function fetchPushMail(id, token) {
  if (!id || !token || !navigator.onLine) return false;
  try {
    const res = await fetch('/api/push/mail/' + encodeURIComponent(id), { headers: { 'X-Push-Token': token }, cache: 'no-store' });
    if (!res.ok) return false;
    const m = await res.json();
    if (!(await store.get('inbox', id))) await store.put('inbox', [m]); // the worker may have saved it meanwhile
    return true;
  } catch (e) { return false; }
}

// Opens a mail from a notification. The reader opens at once (as loading). If the mail is already on the
// phone it shows immediately; if not, it is fetched directly with the push token, and only if that is not
// possible does it fall back to a full sync. The normal sync runs afterwards.
async function openInboxMail(id, { sync = true, token = null } = {}) {
  await appReady;
  if (state.folder !== 'inbox') $('#folders .nav-link[data-folder="inbox"]').trigger('click');
  const saved = await store.get('inbox', id);
  const ready = saved ? null : async () => {
    if (await fetchPushMail(id, token)) return;
    await syncAll();
    while (syncing) await new Promise((r) => setTimeout(r, 100)); // a sync that was already running
  };
  await openMail(id, { ready });
  if (sync) syncAll().catch(() => {});
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => { // sent by sw.js
    const d = e.data || {};
    if (d.type === 'new-mail') syncAll();
    if (d.type === 'open-mail' && d.id) openInboxMail(d.id, { token: d.t });
  });
}
$('#btnNotify').on('click', (e) => { e.preventDefault(); testPush(); });

// ---------- events ----------
$('#mailGroup').on('click', '.mail-item', function (e) {
  e.preventDefault();
  if (Date.now() - touch.swipedAt < 400) return; // the finger-lift after a swipe is not a tap
  openMail(this.dataset.id);
});
$('#mailGroup').on('keydown', '.mail-item', function (e) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMail(this.dataset.id); }
});

// ---------- touch: swipe a row (right = read/unread, left = delete) and pull the list down to refresh ----------
const touch = { x: 0, y: 0, dx: 0, dy: 0, mode: null, row: null, swipedAt: 0 };
const SWIPE_AT = 90; const SWIPE_MAX = 130; const PULL_AT = 70;
const mailGroupEl = document.getElementById('mailGroup');
const ptrEl = document.getElementById('ptr');
const slide = (el, x, animate) => { el.style.transition = animate ? 'transform .2s ease' : 'none'; el.style.transform = x ? `translateX(${x}px)` : ''; };
const pullTo = (px, animate) => {
  mailGroupEl.style.transition = animate ? 'transform .2s ease' : 'none';
  mailGroupEl.style.transform = px ? `translateY(${px}px)` : '';
  ptrEl.style.opacity = String(Math.min(1, px / PULL_AT));
  ptrEl.firstElementChild.style.transform = `rotate(${px * 4}deg)`;
};
mailGroupEl.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { touch.mode = null; return; }
  const t = e.touches[0];
  touch.x = t.clientX; touch.y = t.clientY; touch.dx = 0; touch.dy = 0; touch.mode = 'wait';
  const it = e.target.closest('.mail-item');
  touch.row = it && !it.closest('.skel-row') ? it.closest('.mail-row') : null;
}, { passive: true });
mailGroupEl.addEventListener('touchmove', (e) => {
  if (!touch.mode) return;
  const t = e.touches[0];
  touch.dx = t.clientX - touch.x; touch.dy = t.clientY - touch.y;
  if (touch.mode === 'wait') {
    if (Math.abs(touch.dx) < 8 && Math.abs(touch.dy) < 8) return;
    if (Math.abs(touch.dx) > Math.abs(touch.dy) && touch.row) touch.mode = 'swipe';
    else if (touch.dy > 0 && mailGroupEl.scrollTop <= 0) touch.mode = 'pull';
    else { touch.mode = null; return; }
  }
  if (touch.mode === 'swipe') {
    e.preventDefault();
    let dx = Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, touch.dx));
    if (dx > 0 && (state.folder !== 'inbox')) dx = 0; // Sent has no read/unread
    touch.row.dataset.dir = dx > 0 ? 'read' : dx < 0 ? 'del' : '';
    const wasArmed = touch.row.classList.contains('armed');
    touch.row.classList.toggle('armed', Math.abs(dx) >= SWIPE_AT);
    if (!wasArmed && Math.abs(dx) >= SWIPE_AT) hap('tick');
    slide(touch.row.querySelector('.mail-item'), dx, false);
  } else if (touch.mode === 'pull') {
    e.preventDefault();
    pullTo(Math.min(110, touch.dy * 0.5), false);
  }
}, { passive: false });
const touchEnd = (e) => {
  const cancelled = e.type === 'touchcancel'; // the system took the touch (gesture, call...): snap back, run nothing
  const mode = touch.mode; touch.mode = null;
  const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (mode === 'swipe') {
    const row = touch.row; const item = row.querySelector('.mail-item');
    const id = item.dataset.id; const dx = Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, touch.dx));
    touch.swipedAt = Date.now();
    slide(item, 0, animate);
    row.classList.remove('armed');
    if (cancelled) return;
    if (dx <= -SWIPE_AT) deleteMail(id);
    else if (dx >= SWIPE_AT && state.folder === 'inbox') toggleReadById(id);
    else if (dx >= SWIPE_AT && state.folder === 'trash') restoreMail(id);
  } else if (mode === 'pull') {
    const pulled = Math.min(110, touch.dy * 0.5);
    pullTo(0, animate);
    if (!cancelled && pulled >= PULL_AT) syncAll({ reconcile: true, manual: true });
  }
};
mailGroupEl.addEventListener('touchend', touchEnd);
mailGroupEl.addEventListener('touchcancel', touchEnd);
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
  if (state.folder === 'inbox') dropLayer('folder'); else if (!layers.includes('folder')) pushLayer('folder');
  $('#folderTitle').text(TITLES[state.folder] || 'Inbox');
  $('#btnEmptyBin').toggleClass('d-none', state.folder !== 'trash');
  setFilter('all'); $('.mailbox-header').removeClass('searching');
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
$('.nav-link-close').on('click', async (e) => { e.preventDefault(); const saved = await saveDraft(); closeCompose(); if (saved) toast('Draft saved'); });
$('#cDiscard').on('click', async (e) => {
  e.preventDefault();
  if (!$('.compose').data('draftId') && composeEmpty(composeData())) return closeCompose();
  if (!(await askConfirm({ title: 'Discard draft?', message: 'This message is deleted.', ok: 'Discard', danger: true }))) return;
  clearTimeout(draftTimer); composeDirty = false;
  if (draftBusy) await draftBusy.catch(() => {});
  const did = $('.compose').data('draftId');
  if (did && navigator.onLine) {
    try {
      await api(`/api/mails/${encodeURIComponent(did)}?folder=drafts`, { method: 'DELETE' });
      await store.remove('drafts', did); meta.drafts.total = Math.max(0, (meta.drafts.total || 1) - 1); await saveMeta('drafts');
      if (state.folder === 'drafts') await showFolder(); else renderStatus();
    } catch (er) { toast(er.message); }
  }
  closeCompose();
});
$('#cSend').on('click', sendMail);

// keep the saved copy fresh: when back online, when the app is reopened, and every couple of minutes
window.addEventListener('online', () => { renderStatus(); toast('Back online'); initAuth().then(() => syncAll()).catch(() => {}); });
window.addEventListener('offline', () => { renderStatus(); toast('You are offline. Showing saved mail.'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (meta.app.lastSync || 0) > 60000) syncAll(); });
setInterval(() => { if (!document.hidden) syncAll(); }, 120000);

boot();

// ---- unread filter, reader actions, keyboard shortcuts ----
function setFilter(f) {
  state.filter = f;
  if (f === 'unread' && state.folder === 'inbox') { if (!layers.includes('filter')) pushLayer('filter'); } else dropLayer('filter');
  $('#btnFilter').toggleClass('d-none', state.folder !== 'inbox').toggleClass('on', f === 'unread')
    .attr({ 'aria-pressed': String(f === 'unread'), title: f === 'unread' ? 'Showing unread only' : 'Show unread only' });
  $('#filterChip').toggleClass('d-none', !(f === 'unread' && state.folder === 'inbox'));
  if (state.mails) renderList();
}
$('#filterChip button').on('click', () => setFilter('all'));
$('#btnFilter').on('click', (e) => { e.preventDefault(); setFilter(state.filter === 'unread' ? 'all' : 'unread'); });
const openSearch = () => { $('.mailbox-header').addClass('searching'); if (!layers.includes('search')) pushLayer('search'); $('#search').trigger('focus'); };
$('#btnSearch').on('click', (e) => { e.preventDefault(); openSearch(); });
$('#search').on('blur', () => { if (!$('#search').val()) { $('.mailbox-header').removeClass('searching'); dropLayer('search'); } })
  .on('keydown', (e) => { if (e.key === 'Escape') { $('#search').val('').trigger('input').trigger('blur'); } });
$('#btnFwdTop, #btnForward').on('click', (e) => { e.preventDefault(); openForward(); });
$('#btnUnreadTop').on('click', (e) => { e.preventDefault(); markUnread(); });
$('#btnDelTop').on('click', (e) => { e.preventDefault(); deleteMail(); });

$(document).on('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || $(e.target).is('input, textarea, select, [contenteditable]') || $('.modal.show').length) return;
  const items = $('#mailGroup .mail-item');
  const i = items.index(items.filter('.active'));
  if (e.key === '/') { e.preventDefault(); openSearch(); }
  else if (e.key === 'j' && items.length && state.folder !== 'drafts') items.eq(Math.min(i + 1, items.length - 1)).trigger('click');
  else if (e.key === 'k' && items.length && state.folder !== 'drafts') items.eq(Math.max(i - 1, 0)).trigger('click');
  else if (e.key === 'r' && state.openMail && state.folder === 'inbox') { e.preventDefault(); startReply(); }
  else if (e.key === 'c') { e.preventDefault(); openCompose(); }
});

// ---- build info: the commit this code was built from, and the commit the server runs now ----
const BUILD_LOADED = typeof __BUILD__ !== 'undefined' ? __BUILD__ : { commit: '', repo: 'notamitgamer/mail-server', branch: '' };
let buildLive = null;
function paintBuild(offline) {
  const b = BUILD_LOADED.commit ? BUILD_LOADED : (buildLive || BUILD_LOADED);
  const $link = $('#buildLink');
  if (b.commit) $link.text(b.commit.slice(0, 7)).attr('href', `https://github.com/${b.repo}/commit/${b.commit}`);
  else $link.text('dev build').removeAttr('href');
  $('#buildMeta').text([b.branch, offline ? 'offline' : ''].filter(Boolean).join(' · '));
  const stale = !!(buildLive && buildLive.commit && BUILD_LOADED.commit && buildLive.commit !== BUILD_LOADED.commit);
  $('#buildReload').toggleClass('d-none', !stale).text(stale ? `New version ${buildLive.commit.slice(0, 7)} available. Tap to update` : '');
}
async function checkBuild() {
  try { buildLive = await (await fetch('/api/version', { cache: 'no-store' })).json(); paintBuild(false); } catch (e) { paintBuild(true); }
}
paintBuild(false);
checkBuild();
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkBuild(); });
window.addEventListener('online', checkBuild);
setInterval(checkBuild, 10 * 60 * 1000);
$('#buildReload').on('click', async (e) => {
  e.preventDefault();
  try { await Promise.all((await caches.keys()).map((k) => caches.delete(k))); } catch (err) { /* ignore */ }
  location.reload();
});

// ---- recipient pills, template prompt, bin actions, template manager ----
$('#cTo, #cCc, #cBcc').each(function () { initPillBox($(this)); });
$(document).on('click', '.pill-box', function () { $(this).find('.pill-input').trigger('focus'); });
$(document).on('click', '.pill-x', function (e) { e.preventDefault(); e.stopPropagation(); $(this).closest('.pill').remove(); queueDraft(); });
$(document).on('click', '.pill-text', function (e) { // tap a pill to edit it
  e.stopPropagation();
  const $p = $(this).closest('.pill'); const $box = $p.closest('.pill-box'); const addr = $p[0].dataset.addr;
  $p.remove(); $box.find('.pill-input').val(addr).trigger('focus');
});
$(document).on('keydown', '.pill-input', function (e) {
  if ([' ', ','].includes(e.key) && this.value.trim()) { e.preventDefault(); commitPill($(this)); }
  // Tab commit disabled
  else if (e.key === 'Backspace' && !this.value) { $(this).closest('.pill-box').find('.pill').last().remove(); queueDraft(); }
});
$(document).on('input', '.pill-input', function () { if (/[, ]$/.test(this.value)) commitPill($(this)); }); // phone keyboards
// focusout commit disabled
$(document).on('paste', '.pill-input', function (e) {
  const t = (e.originalEvent.clipboardData || window.clipboardData).getData('text');
  if (!t) return;
  e.preventDefault(); addPills($(this).closest('.pill-box'), t);
});
$('#cCcToggle').on('click', (e) => { e.preventDefault(); showCc(true); $('#cCc .pill-input').trigger('focus'); });
$('#cSubject, #cBody, #cFrom, #cHtml').on('input change', queueDraft);

$('#cTplAdd').on('click', () => {
  const t = (templates || []).find((x) => x.id === $('#cTplSel').val());
  if (t) { attachTemplate({ name: t.name, html: t.html }); queueDraft(); }
});
$('#cTplSkip').on('click', () => { $('.compose').data('tplSkipped', true); $('#cTpl').addClass('d-none'); });
$('#cTplRemove').on('click', () => { attachTemplate(null); $('.compose').data('tplSkipped', true); queueDraft(); });

$('#btnRestoreTop, #mnRestore').on('click', (e) => { e.preventDefault(); restoreMail(); });
$('#btnEmptyBin').on('click', (e) => { e.preventDefault(); emptyBin(); });

const TPL_EXAMPLE = '<table cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;font-size:13px;color:#202124;border:1px solid #dadce0;border-radius:6px;padding:14px;max-width:360px">\n'
  + '  <tr><td><div style="font-size:18px;font-weight:bold">Your Name</div>\n'
  + '  <div style="color:#5f6368;margin:4px 0 8px">Your role or school<br>City, Country</div>\n'
  + '  <a href="https://example.com" style="color:#5f6368">https://example.com</a></td></tr>\n</table>';
const tplModal = () => window.bootstrap.Modal.getOrCreateInstance(document.getElementById('tplModal'));
function fillTplPick(selectId) {
  $('#tplPick').html('<option value="">+ New template</option>' + (templates || []).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}${t.isDefault ? ' (first)' : ''}</option>`).join(''))
    .val(selectId && (templates || []).some((t) => t.id === selectId) ? selectId : (templates && templates[0] ? templates[0].id : ''));
  fillTplEditor();
}
function fillTplEditor() {
  const t = (templates || []).find((x) => x.id === $('#tplPick').val());
  $('#tplName').val(t ? t.name : ''); $('#tplHtml').val(t ? t.html : ''); $('#tplDefault').prop('checked', Boolean(t && t.isDefault));
  $('#tplDelete').toggleClass('d-none', !t); $('#tplPreview').html(cleanTpl($('#tplHtml').val()));
}
$('#navTemplates').on('click', async (e) => {
  e.preventDefault(); closeLayer('side');
  if (!navigator.onLine) return toast('Go online to manage templates.');
  await loadTemplates(true); fillTplPick(); tplModal().show();
});
$('#tplPick').on('change', fillTplEditor);
$('#tplHtml').on('input', () => $('#tplPreview').html(cleanTpl($('#tplHtml').val())));
$('#tplExample').on('click', () => { $('#tplHtml').val(TPL_EXAMPLE).trigger('input'); if (!$('#tplName').val()) $('#tplName').val('Signature'); });
$('#tplSave').on('click', async () => {
  const btn = $('#tplSave').prop('disabled', true);
  try {
    const r = await api('/api/templates', { method: 'POST', body: JSON.stringify({ id: $('#tplPick').val() || undefined, name: $('#tplName').val(), html: $('#tplHtml').val(), isDefault: $('#tplDefault').is(':checked') }) });
    await loadTemplates(true); fillTplPick(r.id); toast('Template saved');
  } catch (e) { toast(e.message); }
  btn.prop('disabled', false);
});
$('#tplDelete').on('click', async () => {
  const id = $('#tplPick').val(); if (!id) return;
  try { await api(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadTemplates(true); fillTplPick(); toast('Template deleted'); } catch (e) { toast(e.message); }
});
