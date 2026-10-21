// Mailbox front end: SmartMail template markup wired to the /api endpoints.
const $ = window.jQuery;
const FIREBASE_VER = '11.10.0';

const state = { folder: 'inbox', mails: [], hasMore: false, loading: false, openId: null, openMail: null, unread: 0 };
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

// ---------- sign-in ----------
function showSignin(msg, button) {
  $('#signin').removeClass('d-none');
  $('#signinMsg').text(msg);
  $('#btnSignin').toggleClass('d-none', !button);
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
    if (res.status === 403) { await signOutFn(); showSignin(err.message, true); }
    throw err;
  }
  return data;
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    config = await (await fetch('/api/config')).json();
  } catch (e) { return showSignin('Cannot reach the server.', false); }
  if (!config.firebase) return showSignin('FIREBASE_WEB_CONFIG is not set on the server.', false);
  try {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VER}`;
    const [{ initializeApp }, fa] = await Promise.all([import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`)]);
    const auth = fa.getAuth(initializeApp(config.firebase));
    getToken = () => auth.currentUser.getIdToken();
    signOutFn = () => fa.signOut(auth);
    $('#btnSignin').on('click', () => fa.signInWithPopup(auth, new fa.GoogleAuthProvider()).catch((e) => showSignin('Sign-in failed: ' + e.message, true)));
    fa.onAuthStateChanged(auth, (user) => (user ? start(user) : showSignin('Sign in to continue', true)));
  } catch (e) { showSignin('Could not load sign-in. Are you offline?', false); }
}

function start(user) {
  $('#signin').addClass('d-none');
  $('#avatar span').text((user.email || 'm').charAt(0).toLowerCase());
  loadList(true);
}

// ---------- list ----------
const COLORS = ['', 'green', 'blue', 'indigo', 'red', 'yellow'];
function avatar(who) {
  const l = label(who); let h = 0;
  for (const c of l) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<div class="mail-avatar"><span class="${COLORS[h % COLORS.length]}">${esc(l.charAt(0).toLowerCase())}</span></div>`;
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
  $('#countText').text(state.mails.length ? `${state.mails.length} loaded` : '');
  ps.update();
}

async function loadList(reset) {
  if (state.loading) return;
  state.loading = true;
  if (reset) { state.mails = []; state.hasMore = false; renderList(); }
  try {
    const last = state.mails[state.mails.length - 1];
    const before = !reset && last ? '&before=' + new Date(last.date).getTime() : '';
    const data = await api(`/api/mails?folder=${state.folder}&limit=30${before}`);
    state.mails = reset ? data.mails : state.mails.concat(data.mails);
    state.hasMore = data.hasMore;
    if (data.unread !== null && data.unread !== undefined) setUnread(data.unread);
  } catch (e) { toast(e.message); }
  state.loading = false;
  renderList();
}

// ---------- reader ----------
const CLEAN = { WHOLE_DOCUMENT: true, FORBID_TAGS: ['meta', 'base', 'link', 'form', 'iframe', 'object', 'embed', 'script'] };
const FRAME_HEAD = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:"><base target="_blank">`
  + '<style>html{background:#fff}body{margin:0;padding:12px 4px;font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#202124;word-wrap:break-word;overflow-x:auto}img{max-width:100%;height:auto}</style>';

function showReader() {
  $('.mailcontent-placeholder').addClass('d-none').siblings().removeClass('d-none');
  if (window.matchMedia('(max-width: 1199px)').matches) $('body').addClass('mailcontent-show');
}

function hideReader() {
  state.openId = null; state.openMail = null;
  $('.mailcontent-placeholder').removeClass('d-none').siblings().addClass('d-none');
  $('body').removeClass('mailcontent-show');
}

function renderBody(m) {
  const doc = m.html
    ? window.DOMPurify.sanitize(m.html, CLEAN)
    : `<html><head></head><body><div style="white-space:pre-wrap">${esc(m.text || '(empty message)')}</div></body></html>`;
  const frame = document.createElement('iframe');
  // Scripts stay off; same-origin is only so we can measure the height.
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (t) => t + FRAME_HEAD) : FRAME_HEAD + doc;
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
  $('#rAvatar').text(label(sent ? m.to[0] : m.from).charAt(0).toLowerCase());
  $('#rFrom').html(sent ? `Me <span>&lt;${esc(m.from)}&gt;</span>` : `${esc(p.name || p.addr)}${p.name ? ` <span>&lt;${esc(p.addr)}&gt;</span>` : ''}`);
  $('#rTo').text('to: ' + m.to.join(', '));
  $('#rTime').text(fullDate(m.date));
  $('#btnReplyTop, #btnReply').toggleClass('d-none', sent);
  $('#rAttach').html((m.attachments || []).map((a) => `<span class="attach-chip"><i class="ri-attachment-2"></i> ${esc(a.filename)}${a.size ? ' (' + fmtSize(a.size) + ')' : ''}</span>`).join(''));
  renderBody(m);
  mc.update();
}

async function openMail(id) {
  state.openId = id;
  $('#mailGroup .mail-item').removeClass('active').filter((i, el) => el.dataset.id === id).addClass('active');
  showReader();
  $('#rSubject').text('Loading…'); $('#rBody').empty(); $('#rAttach').empty();
  try {
    const m = await api(`/api/mails/${encodeURIComponent(id)}?folder=${state.folder}`);
    if (state.openId !== id) return;
    state.openMail = m;
    renderReader(m);
    const item = state.mails.find((x) => x.id === id);
    if (state.folder === 'inbox' && item && !item.read) {
      item.read = true;
      $('#mailGroup .mail-item').filter((i, el) => el.dataset.id === id).removeClass('unread');
      setUnread(state.unread - 1);
      api(`/api/mails/${encodeURIComponent(id)}/read`, { method: 'POST' }).catch(() => {});
    }
  } catch (e) { toast(e.message); }
}

// ---------- PDF (print dialog -> "Save as PDF") ----------
function savePdf() {
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
  const payload = { to: $('#cTo').val(), subject: $('#cSubject').val(), from: $('#cFrom').val() || undefined, replyToId: $('.compose').data('replyToId') || undefined };
  payload[$('#cHtml').is(':checked') ? 'html' : 'text'] = $('#cBody').val();
  $('#cSend').prop('disabled', true);
  try {
    await api('/api/send', { method: 'POST', body: JSON.stringify(payload) });
    closeCompose(); toast('Sent');
    if (state.folder === 'sent') loadList(true);
  } catch (e) { toast(e.message); }
  $('#cSend').prop('disabled', false);
}

// ---------- events ----------
$('#mailGroup').on('click', '.mail-item', function (e) { e.preventDefault(); openMail(this.dataset.id); });
$('#mailGroup').on('click', '#loadMore', () => loadList(false));
$('#search').on('input', renderList);
$('#refresh').on('click', (e) => { e.preventDefault(); loadList(true); });
$('#btnPdf').on('click', (e) => { e.preventDefault(); savePdf(); });
$('#btnReply, #btnReplyTop').on('click', (e) => { e.preventDefault(); startReply(); });
$('#mailBack').on('click', (e) => { e.preventDefault(); $('body').removeClass('mailcontent-show'); });
$('#avatar').on('click', (e) => { e.preventDefault(); if (window.confirm('Sign out?')) signOutFn().then(() => location.reload()); });

$('#folders').on('click', '.nav-link', function (e) {
  e.preventDefault();
  $(this).addClass('active').siblings().removeClass('active');
  state.folder = this.dataset.folder;
  $('#folderTitle').text(state.folder === 'sent' ? 'Sent' : 'Inbox');
  $('#search').val('');
  hideReader();
  $('body').removeClass('sidebar-show');
  loadList(true);
});

// template behaviours (sidebar, compose window)
$('.mailbox-menu').on('click', (e) => {
  e.preventDefault();
  $('body').toggleClass(window.matchMedia('(max-width: 767px)').matches ? 'sidebar-show' : 'sidebar-hide');
  mc.update();
});
$('.backdrop').on('click', () => $('body').removeClass('sidebar-show'));
$('.mailbox-search .form-control').on('focusin focusout', function (e) { $(this).parent().toggleClass('onfocus', e.type === 'focusin'); });
$('.menu-compose').on('click', (e) => { e.preventDefault(); openCompose(); });
$('.compose-title, .nav-link-minimize').on('click', function (e) { e.preventDefault(); $(this).closest('.compose').toggleClass('minimize'); });
$('.nav-link-fullscreen').on('click', function (e) { e.preventDefault(); $(this).closest('.compose').toggleClass('fullscreen'); });
$('.nav-link-close, #cDiscard').on('click', (e) => { e.preventDefault(); closeCompose(); });
$('#cSend').on('click', sendMail);

boot();
