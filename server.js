const path = require('path');
const fs = require('fs');
const express = require('express');
const { Resend } = require('resend');
const { Webhook } = require('svix');
const { simpleParser } = require('mailparser');
const admin = require('firebase-admin');
const crypto = require('crypto');
const webpush = require('web-push');

const app = express();

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
const port = process.env.PORT || 3000;

const resend = new Resend(process.env.RESEND_API_KEY);
const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;

// ---- Web Push (new-mail notifications) --------------------------------------
// Create the keys once with `npx web-push generate-vapid-keys`, then set
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. Without them mail still arrives; only the push is skipped.
let pushEnabled = false;
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    const contact = (process.env.ALLOWED_ALIASES || '').split(',')[0].trim() || 'admin@example.com';
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || `mailto:${contact}`,
      process.env.VAPID_PUBLIC_KEY.trim(),
      process.env.VAPID_PRIVATE_KEY.trim()
    );
    pushEnabled = true;
  } else {
    console.warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set - push notifications are off');
  }
} catch (err) {
  console.error('Web Push init failed - push notifications are off:', err.message);
}
// How long the push service keeps an undelivered push (a phone that is offline gets it on reconnect).
const PUSH_TTL = 7 * 24 * 3600;

// Each push carries a read token for that one mail, so the service worker can save the mail on the phone
// the moment the push arrives (it has no sign-in) and tapping the notification opens it at once.
// The token travels only inside the encrypted push, is bound to the mail id by an HMAC, and expires a day after the push does.
const MAIL_TOKEN_KEY = pushEnabled ? crypto.createHmac('sha256', process.env.VAPID_PRIVATE_KEY.trim()).update('mail-token-v1').digest() : null;
const mailTokenSig = (id, exp) => crypto.createHmac('sha256', MAIL_TOKEN_KEY).update(`${id}.${exp}`).digest();
const signMailToken = (id) => {
  if (!MAIL_TOKEN_KEY) return null;
  const exp = Date.now() + (PUSH_TTL + 24 * 3600) * 1000;
  return `${exp}.${mailTokenSig(id, exp).toString('base64url')}`;
};
const checkMailToken = (id, token) => {
  if (!MAIL_TOKEN_KEY || typeof token !== 'string') return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp < Date.now()) return false;
  const want = mailTokenSig(id, exp);
  const got = Buffer.from(sig, 'base64url');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

// Plain-text version of an HTML body (used for snippets and the text part of sent mail).
const htmlToText = (html) =>
  String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

// Drop link clutter from a preview: [text](url) keeps the text; [https://...], <https://...> and bare URLs go.
const cleanForSnippet = (s) =>
  String(s || '')
    .replace(/\[([^\]]+)\]\((?:https?:|cid:|mailto:)[^)]*\)/gi, '$1')
    .replace(/\[\s*(?:https?:\/\/|cid:)[^\]]*\]/gi, ' ')
    .replace(/\[(?:image|img)\b[^\]]*\]/gi, ' ')
    .replace(/<(?:https?:\/\/|mailto:)[^>]*>/gi, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\s+/g, ' ').trim();

// Uses the plain-text part; if that is only links, falls back to the readable text of the HTML part.
const makeSnippet = (parsed) => {
  for (const src of [parsed?.text, htmlToText(parsed?.html)]) {
    const c = cleanForSnippet(src);
    if (c) return c.slice(0, 160);
  }
  return '';
};

// ---- Firestore archive (optional) -------------------------------------------
// Set FIREBASE_SERVICE_ACCOUNT to the service-account JSON (raw or base64).
// Without it the server still forwards mail; it just skips the archive.
let db = null;
try {
  const rawAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (rawAccount) {
    const json = rawAccount.trim().startsWith('{')
      ? rawAccount
      : Buffer.from(rawAccount, 'base64').toString('utf8');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) });
    db = admin.firestore();
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT not set - mail will not be archived');
  }
} catch (err) {
  console.error('Firebase init failed - mail will not be archived:', err.message);
}

// Firestore documents are capped at ~1 MiB, so keep each body field well under it.
const MAX_BODY_CHARS = 250000;
const capBody = (value) => (value ? value.slice(0, MAX_BODY_CHARS) : null);

// Save one received mail, keyed by Resend's email ID. create() fails if the
// document exists, so a webhook retry never duplicates it or resets `read`.
const archiveEmail = async ({ emailId, from, to, subject, receivedAt, parsed, fetchError }) => {
  if (!db) return null;
  try {
    const doc = {
      from,
      to,
      subject,
      snippet: makeSnippet(parsed),
      html: capBody(parsed?.html),
      text: capBody(parsed?.text),
      truncated: (parsed?.html?.length || 0) > MAX_BODY_CHARS || (parsed?.text?.length || 0) > MAX_BODY_CHARS,
      receivedAt: admin.firestore.Timestamp.fromDate(receivedAt),
      resendEmailId: emailId,
      read: false,
      messageId: parsed?.messageId || null,
      inReplyTo: parsed?.inReplyTo || null,
      references: parsed?.references ? [].concat(parsed.references) : [],
      attachments: (parsed?.attachments || []).map((a) => ({
        filename: a.filename || 'attachment',
        contentType: a.contentType || null,
        size: a.size || 0,
      })),
      fetchError: fetchError || null,
    };
    await db.collection('mails').doc(emailId).create(doc);
    return doc; // newly saved
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message)) return null; // retry of a mail we already saved
    throw err;
  }
};

// ---- Push delivery ----------------------------------------------------------
const pushHash = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex');

// Send one payload to every saved device. Never throws: a push problem must not make
// the webhook answer 500, because Resend would retry and the mail would be pushed twice.
const pushToAll = async (payload) => {
  if (!db || !pushEnabled) return 0;
  let sent = 0;
  try {
    const subs = await db.collection('pushSubs').get();
    const body = JSON.stringify(payload);
    await Promise.all(subs.docs.map(async (doc) => {
      try {
        await webpush.sendNotification(doc.data().subscription, body, { TTL: PUSH_TTL, urgency: 'high', timeout: 8000 });
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await doc.ref.delete().catch(() => {}); // device is gone
        else console.error('Push failed:', err.statusCode || '', err.body || err.message);
      }
    }));
  } catch (err) {
    console.error('Push error:', err.message);
  }
  return sent;
};

const PUSH_INLINE_MAX = 3500; // Web Push allows about 4 KB; stay well under it
const sendPush = ({ emailId, from, subject, snippet, doc }) => {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from || '');
  const sender = (m ? m[1].trim() || m[2].trim() : String(from || '')).slice(0, 100);
  const payload = {
    title: sender || 'New mail',
    body: (subject + (snippet ? ' - ' + snippet : '')).slice(0, 200),
    id: emailId,
    t: signMailToken(emailId),
  };
  // A small mail travels inside the push itself, so the phone has it the moment the notification shows
  // and tapping it needs no request at all. Bigger mails are fetched with the token instead.
  if (doc) {
    const row = toFull(emailId, doc, 'inbox');
    if (Buffer.byteLength(JSON.stringify({ ...payload, m: row })) <= PUSH_INLINE_MAX) payload.m = row;
  }
  return pushToAll(payload);
};

// Resend's email.received webhook only carries metadata (no body, headers or
// attachments). Fetch the message itself via the Received Emails API.
const fetchFullEmail = async (emailId) => {
  const { data: received, error } = await resend.emails.receiving.get(emailId);
  if (error) throw new Error(`Could not retrieve received email: ${error.message}`);

  const downloadUrl = received?.raw?.download_url;
  if (!downloadUrl) throw new Error('Received email has no raw download URL');

  const rawResponse = await fetch(downloadUrl);
  if (!rawResponse.ok) throw new Error(`Raw email download failed (${rawResponse.status})`);

  const raw = Buffer.from(await rawResponse.arrayBuffer());
  return simpleParser(raw, { skipImageLinks: true });
};

app.post('/api/incoming', express.text({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body;
    const headers = {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature'],
    };

    const wh = new Webhook(webhookSecret);
    let event;
    
    try {
      event = wh.verify(rawBody, headers);
    } catch (err) {
      console.error(err.message);
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (event.type !== 'email.received') {
      return res.status(200).json({ message: 'Not an email event' });
    }

    const emailData = event.data;
    const originalSender = emailData.from;
    const originalRecipient = emailData.to[0].toLowerCase();
    const subject = emailData.subject || 'No Subject';

    const allowedString = process.env.ALLOWED_ALIASES || '';
    const allowedAliases = allowedString.split(',').map(alias => alias.trim().toLowerCase());

    if (!allowedAliases.includes(originalRecipient)) {
      return res.status(200).json({ success: true, message: 'Alias ignored' });
    }

    // Fetch the full message and store it. Firestore is the mailbox now, so if
    // either step fails the error handler answers 500 and Resend retries later.
    const created = new Date(emailData.created_at);
    const receivedAt = Number.isNaN(created.getTime()) ? new Date() : created;
    if (!db) {
      console.error('Firestore is not configured - cannot store incoming mail');
      return res.status(500).json({ error: 'Storage not configured' });
    }
    const parsed = await fetchFullEmail(emailData.email_id);
    const saved = await archiveEmail({
      emailId: emailData.email_id,
      from: originalSender,
      to: originalRecipient,
      subject,
      receivedAt,
      parsed,
    });
    // Push only for a mail that was newly saved, so a webhook retry does not notify twice.
    if (saved) await sendPush({ emailId: emailData.email_id, from: originalSender, subject, snippet: makeSnippet(parsed), doc: saved });
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---- Mailbox API (used by the web app in /public) ----------------------------
// Only the account in MAILBOX_OWNER_EMAIL may use it. Falls back to PERSONAL_GMAIL
// so an existing deployment keeps working; rename the variable when convenient.
const OWNER_EMAIL = (process.env.MAILBOX_OWNER_EMAIL || process.env.PERSONAL_GMAIL || '').trim().toLowerCase();
const SEND_ALIASES = (process.env.ALLOWED_ALIASES || '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
const FROM_NAME = (process.env.FROM_NAME || '').replace(/[<>"\\\r\n]/g, '').trim();

const FOLDERS = {
  inbox: { collection: 'mails', dateField: 'receivedAt' },
  sent: { collection: 'sent', dateField: 'sentAt' },
  drafts: { collection: 'drafts', dateField: 'updatedAt' },
  trash: { collection: 'trash', dateField: 'deletedAt' }, // deleted inbox/sent mail, kept TRASH_DAYS days
};
const TRASH_DAYS = 30;
const MAX_RECIPIENTS = 50; // to + cc + bcc
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const handle = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

const requireOwner = async (req, res, next) => {
  if (!db || !OWNER_EMAIL) return res.status(503).json({ error: 'Mailbox is not configured' });
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Sign in required' });
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    if (!decoded.email_verified || String(decoded.email || '').toLowerCase() !== OWNER_EMAIL) {
      return res.status(403).json({ error: 'This account is not allowed' });
    }
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired sign-in' });
  }
};

const folderOf = (req) => (FOLDERS[req.query.folder] ? req.query.folder : 'inbox');

const toSummary = (id, d, folder) => ({
  id,
  from: d.from || '',
  to: [].concat(d.to || []),
  cc: [].concat(d.cc || []),
  bcc: [].concat(d.bcc || []),
  origin: d.origin || null, // trash only: the folder the mail was deleted from
  subject: d.subject || '(no subject)',
  snippet: d.snippet || '',
  date: (d[FOLDERS[folder].dateField]?.toDate?.() || new Date()).toISOString(),
  resendId: d.resendId || null, // sent mail only; a received mail's document id already is its Resend id
  read: d.read !== false,
  attachmentCount: (d.attachments || []).length,
});

const toFull = (id, d, folder) => ({
  ...toSummary(id, d, folder),
  html: d.html || null,
  text: d.text || null,
  attachments: d.attachments || [],
  truncated: Boolean(d.truncated),
  templateHtml: d.templateHtml || null, // drafts only
  templateName: d.templateName || null,
  htmlMode: Boolean(d.htmlMode),
  replyToId: d.replyToId || null,
});

// Public, non-secret settings the web app needs to start.
app.get('/api/config', (req, res) => {
  let firebase = null;
  try { firebase = JSON.parse(process.env.FIREBASE_WEB_CONFIG || 'null'); } catch (err) { /* ignore */ }
  res.json({ firebase, aliases: SEND_ALIASES, fromName: FROM_NAME, vapidPublicKey: pushEnabled ? process.env.VAPID_PUBLIC_KEY.trim() : null });
});

// Removes bin mail older than TRASH_DAYS (checked whenever the bin is read, and every few hours).
async function purgeTrash() {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - TRASH_DAYS * 86400000);
  const snap = await db.collection('trash').where('deletedAt', '<', cutoff).select().limit(400).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}
if (db) setInterval(() => purgeTrash().catch((e) => console.error('purgeTrash', e)), 6 * 3600000).unref();

app.get('/api/mails', requireOwner, handle(async (req, res) => {
  const folder = folderOf(req);
  if (folder === 'trash') await purgeTrash().catch(() => {});
  const { collection, dateField } = FOLDERS[folder];
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  let query = db.collection(collection).orderBy(dateField, 'desc');
  const before = Number(req.query.before);
  if (before) query = query.startAfter(admin.firestore.Timestamp.fromMillis(before));
  const snap = await query
    .select('from', 'to', 'cc', 'bcc', 'origin', 'subject', 'snippet', 'read', 'attachments', dateField)
    .limit(limit + 1)
    .get();

  let unread = null;
  if (folder === 'inbox' && !before) {
    try { unread = (await db.collection('mails').where('read', '==', false).count().get()).data().count; } catch (err) { /* optional */ }
  }
  res.set('Cache-Control', 'no-store').json({
    mails: snap.docs.slice(0, limit).map((doc) => toSummary(doc.id, doc.data(), folder)),
    hasMore: snap.docs.length > limit,
    unread,
  });
}));

app.get('/api/mails/:id', requireOwner, handle(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const folder = folderOf(req);
  const snap = await db.collection(FOLDERS[folder].collection).doc(req.params.id).get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  return res.set('Cache-Control', 'no-store').json(toFull(snap.id, snap.data(), folder));
}));

// Incremental sync for the offline cache. Full messages, so the app can show them without the network.
//   ?since=<ms>   only mail newer than that, oldest first (what the app asks for after the first load)
//   ?before=<ms>  the next page of older mail, newest first ("load more")
//   neither       the newest page (first load on a new device)
//   &reconcile=1  also return the unread count and ids, so read state from other devices catches up
app.get('/api/sync', requireOwner, handle(async (req, res) => {
  const folder = folderOf(req);
  if (folder === 'trash') await purgeTrash().catch(() => {});
  const { collection, dateField } = FOLDERS[folder];
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
  const since = Number(req.query.since);
  const before = Number(req.query.before);
  const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);

  let query = db.collection(collection);
  if (since) {
    query = query.where(dateField, '>', ts(since)).orderBy(dateField, 'asc');
  } else {
    query = query.orderBy(dateField, 'desc');
    if (before) query = query.startAfter(ts(before));
  }
  const snap = await query.limit(limit + 1).get();

  const out = {
    mails: snap.docs.slice(0, limit).map((doc) => toFull(doc.id, doc.data(), folder)),
    hasMore: snap.docs.length > limit,
  };
  if (req.query.reconcile) {
    try {
      out.total = (await db.collection(collection).count().get()).data().count;
      // All ids, so a device can drop mail that was deleted somewhere else.
      out.ids = out.total <= 2000 ? (await db.collection(collection).select().get()).docs.map((d) => d.id) : null;
      if (folder === 'inbox') {
        const unread = db.collection('mails').where('read', '==', false);
        out.unread = (await unread.count().get()).data().count;
        out.unreadIds = out.unread <= 1000 ? (await unread.select().get()).docs.map((d) => d.id) : null;
      }
    } catch (err) { /* optional */ }
  }
  res.set('Cache-Control', 'no-store').json(out);
}));

app.post('/api/mails/:id/read', requireOwner, handle(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  try {
    await db.collection('mails').doc(req.params.id).update({ read: true });
  } catch (err) {
    if (err.code === 5) return res.status(404).json({ error: 'Not found' });
    throw err;
  }
  return res.json({ ok: true });
}));

app.post('/api/mails/:id/unread', requireOwner, handle(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  try {
    await db.collection('mails').doc(req.params.id).update({ read: false });
  } catch (err) {
    if (err.code === 5) return res.status(404).json({ error: 'Not found' });
    throw err;
  }
  return res.json({ ok: true });
}));

// Inbox/sent mail moves to the bin (restorable for TRASH_DAYS days). Deleting from the bin or from drafts is permanent.
app.delete('/api/mails/:id', requireOwner, handle(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const folder = folderOf(req);
  const ref = db.collection(FOLDERS[folder].collection).doc(req.params.id);
  if (folder === 'inbox' || folder === 'sent') {
    const snap = await ref.get();
    if (snap.exists) {
      const batch = db.batch();
      batch.set(db.collection('trash').doc(snap.id), { ...snap.data(), origin: folder, deletedAt: admin.firestore.Timestamp.now() });
      batch.delete(ref);
      await batch.commit();
    }
    return res.json({ ok: true, trashed: true });
  }
  await ref.delete(); // deleting a missing doc is fine
  return res.json({ ok: true });
}));

app.post('/api/mails/:id/restore', requireOwner, handle(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const ref = db.collection('trash').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  const { origin, deletedAt, ...rest } = snap.data(); // eslint-disable-line no-unused-vars
  const folder = origin === 'sent' ? 'sent' : 'inbox';
  const batch = db.batch();
  batch.set(db.collection(FOLDERS[folder].collection).doc(snap.id), rest);
  batch.delete(ref);
  await batch.commit();
  return res.json({ ok: true, folder, mail: toFull(snap.id, rest, folder) });
}));

app.delete('/api/trash', requireOwner, handle(async (req, res) => {
  let deleted = 0;
  for (;;) {
    const snap = await db.collection('trash').select().limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
  }
  return res.json({ ok: true, deleted });
}));

const addrList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map((a) => String(a).trim()).filter(Boolean);

// ---- drafts: saved as you type, one document per draft ----
app.post('/api/drafts', requireOwner, express.json({ limit: '1mb' }), handle(async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '');
  const templateHtml = String(b.templateHtml || '');
  if (text.length > 500000 || templateHtml.length > 200000) return res.status(413).json({ error: 'Draft too large' });
  const list = (v) => addrList(v).slice(0, MAX_RECIPIENTS).map((a) => a.slice(0, 320));
  const doc = {
    from: String(b.from || '').slice(0, 320),
    to: list(b.to), cc: list(b.cc), bcc: list(b.bcc),
    subject: String(b.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 500),
    text, html: null, templateHtml, templateName: String(b.templateName || '').slice(0, 80), htmlMode: Boolean(b.htmlMode),
    replyToId: b.replyToId && ID_RE.test(b.replyToId) ? b.replyToId : null,
    snippet: makeSnippet({ text: text || htmlToText(templateHtml) }),
    attachments: [], read: true,
    updatedAt: admin.firestore.Timestamp.now(),
  };
  if (b.id !== undefined && b.id !== null && b.id !== '') {
    if (!ID_RE.test(String(b.id))) return res.status(400).json({ error: 'Bad id' });
    const ref = db.collection('drafts').doc(String(b.id));
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Draft not found' }); // sent or discarded meanwhile
    await ref.set(doc);
    return res.json({ ok: true, id: ref.id });
  }
  const ref = await db.collection('drafts').add(doc);
  return res.json({ ok: true, id: ref.id });
}));

// ---- templates: reusable HTML blocks (signature, footer...) the composer offers to add ----
app.get('/api/templates', requireOwner, handle(async (req, res) => {
  const snap = await db.collection('templates').limit(50).get();
  const templates = snap.docs.map((d) => ({ id: d.id, name: d.data().name || '', html: d.data().html || '', isDefault: Boolean(d.data().isDefault) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.set('Cache-Control', 'no-store').json({ templates });
}));

app.post('/api/templates', requireOwner, express.json({ limit: '400kb' }), handle(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const html = String(b.html || '');
  if (!name || !html.trim()) return res.status(400).json({ error: 'A template needs a name and some HTML' });
  if (html.length > 200000) return res.status(413).json({ error: 'Template too large' });
  const col = db.collection('templates');
  let ref;
  if (b.id) {
    if (!ID_RE.test(String(b.id))) return res.status(400).json({ error: 'Bad id' });
    ref = col.doc(String(b.id));
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Not found' });
  } else {
    if ((await col.count().get()).data().count >= 20) return res.status(400).json({ error: 'At most 20 templates' });
    ref = col.doc();
  }
  const batch = db.batch();
  if (b.isDefault) { // only one default
    (await col.where('isDefault', '==', true).get()).docs.forEach((d) => { if (d.id !== ref.id) batch.update(d.ref, { isDefault: false }); });
  }
  batch.set(ref, { name, html, isDefault: Boolean(b.isDefault), updatedAt: admin.firestore.Timestamp.now() });
  await batch.commit();
  return res.json({ ok: true, id: ref.id });
}));

app.delete('/api/templates/:id', requireOwner, handle(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  await db.collection('templates').doc(req.params.id).delete();
  return res.json({ ok: true });
}));

const sendLog = []; // timestamps, a crude hourly cap in case the sign-in is ever abused
app.post('/api/send', requireOwner, express.json({ limit: '2mb' }), handle(async (req, res) => {
  const now = Date.now();
  while (sendLog.length && now - sendLog[0] > 3600000) sendLog.shift();
  if (sendLog.length >= 50) return res.status(429).json({ error: 'Hourly send limit reached' });

  const { to, cc, bcc, subject, html, text, replyToId, from, draftId } = req.body || {};
  const recipients = addrList(to); const ccList = addrList(cc); const bccList = addrList(bcc);
  const everyone = [...recipients, ...ccList, ...bccList];
  if (!recipients.length || everyone.length > MAX_RECIPIENTS || !everyone.every((a) => EMAIL_RE.test(a))) {
    return res.status(400).json({ error: 'Enter valid recipient address(es)' });
  }
  if (!html && !text) return res.status(400).json({ error: 'Message is empty' });
  if (String(html || '').length > 1000000 || String(text || '').length > 1000000) {
    return res.status(413).json({ error: 'Message too large' });
  }

  const fromAddress = SEND_ALIASES.includes(String(from || '').toLowerCase()) ? String(from).toLowerCase() : SEND_ALIASES[0];
  if (!fromAddress) return res.status(500).json({ error: 'No sender address configured (ALLOWED_ALIASES)' });

  const payload = {
    from: FROM_NAME ? `"${FROM_NAME}" <${fromAddress}>` : fromAddress,
    to: recipients,
    ...(ccList.length ? { cc: ccList } : {}),
    ...(bccList.length ? { bcc: bccList } : {}),
    subject: String(subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500) || '(no subject)',
  };
  if (html) { payload.html = String(html); payload.text = text ? String(text) : htmlToText(html); } else { payload.text = String(text); }

  // Replies keep the conversation threaded in the recipient's mail app.
  let inReplyTo = null;
  if (replyToId && ID_RE.test(replyToId)) {
    const orig = await db.collection('mails').doc(replyToId).get();
    if (orig.exists && orig.data().messageId) {
      inReplyTo = orig.data().messageId;
      payload.headers = {
        'In-Reply-To': inReplyTo,
        References: [...[].concat(orig.data().references || []), inReplyTo].join(' '),
      };
    }
  }

  const { data, error } = await resend.emails.send(payload);
  if (error) {
    console.error(error);
    return res.status(502).json({ error: error.message || 'Send failed' });
  }
  sendLog.push(now);
  const ref = await db.collection('sent').add({
    from: fromAddress,
    to: recipients, cc: ccList, bcc: bccList,
    subject: payload.subject,
    html: payload.html || null,
    text: payload.text || null,
    snippet: makeSnippet(payload),
    sentAt: admin.firestore.Timestamp.fromDate(new Date()),
    resendId: data?.id || null,
    inReplyTo,
    attachments: [],
  });
  if (draftId && ID_RE.test(String(draftId))) await db.collection('drafts').doc(String(draftId)).delete().catch(() => {}); // the draft became this mail
  return res.json({ ok: true, id: ref.id });
}));

// Forwards a saved message to the given address(es) as it is (no editing), then files a copy under Sent.
// Attachments are not stored with the message, so they are not forwarded.
app.post('/api/mails/:id/forward', requireOwner, express.json({ limit: '10kb' }), handle(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const now = Date.now();
  while (sendLog.length && now - sendLog[0] > 3600000) sendLog.shift();
  if (sendLog.length >= 50) return res.status(429).json({ error: 'Hourly send limit reached' });

  const raw = req.body && req.body.to;
  const recipients = (Array.isArray(raw) ? raw : String(raw || '').split(/[,;\s]+/)).map((a) => String(a).trim()).filter(Boolean);
  if (!recipients.length || recipients.length > 5 || !recipients.every((a) => EMAIL_RE.test(a))) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }

  const folder = folderOf(req);
  const { collection, dateField } = FOLDERS[folder];
  const snap = await db.collection(collection).doc(req.params.id).get();
  if (!snap.exists) return res.status(404).json({ error: 'Message not found' });
  const d = snap.data();

  const when = d[dateField] && d[dateField].toDate ? d[dateField].toDate().toUTCString() : '';
  const toList = [].concat(d.to || []).join(', ');
  const subject = String(d.subject || '(no subject)').replace(/[\r\n]+/g, ' ').trim();
  const head = ['---------- Forwarded message ----------', `From: ${d.from || ''}`, `Date: ${when}`, `Subject: ${subject}`, `To: ${toList}`];
  const escH = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const text = head.join('\n') + '\n\n' + (d.text || (d.html ? htmlToText(d.html) : ''));
  const html = `<div style="font:13px Arial,sans-serif;color:#555">${head.map(escH).join('<br>')}</div><br>`
    + (d.html || `<div style="white-space:pre-wrap">${escH(d.text || '')}</div>`);
  if (html.length > 1000000) return res.status(413).json({ error: 'Message too large to forward' });

  // Send from the address the mail came in on, if it is one of ours.
  const fromAddress = [].concat(d.to || []).map((a) => String(a).toLowerCase()).find((a) => SEND_ALIASES.includes(a)) || SEND_ALIASES[0];
  if (!fromAddress) return res.status(500).json({ error: 'No sender address configured (ALLOWED_ALIASES)' });

  const payload = {
    from: FROM_NAME ? `"${FROM_NAME}" <${fromAddress}>` : fromAddress,
    to: recipients,
    subject: (/^fwd?:/i.test(subject) ? subject : 'Fwd: ' + subject).slice(0, 500),
    html, text,
  };
  const { data, error } = await resend.emails.send(payload);
  if (error) {
    console.error(error);
    return res.status(502).json({ error: error.message || 'Forward failed' });
  }
  sendLog.push(now);
  const ref = await db.collection('sent').add({
    from: fromAddress, to: recipients, subject: payload.subject, html, text,
    snippet: makeSnippet({ text }), sentAt: admin.firestore.Timestamp.fromDate(new Date()),
    resendId: data?.id || null, inReplyTo: null, attachments: [],
  });
  return res.json({ ok: true, id: ref.id });
}));

// Read one inbox mail with the token from its push. Not behind sign-in on purpose: the service worker has no
// Firebase session. Without a valid token for this exact id it answers 403.
app.get('/api/push/mail/:id', handle(async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Mailbox is not configured' });
  if (!ID_RE.test(req.params.id) || !checkMailToken(req.params.id, req.get('x-push-token'))) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  const snap = await db.collection(FOLDERS.inbox.collection).doc(req.params.id).get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  return res.set('Cache-Control', 'no-store').json(toFull(snap.id, snap.data(), 'inbox'));
}));

// ---- Push subscriptions (one document per browser or phone) ------------------
app.post('/api/push/subscribe', requireOwner, express.json({ limit: '10kb' }), handle(async (req, res) => {
  const sub = req.body && req.body.subscription;
  const valid = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 2048
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
  if (!valid) return res.status(400).json({ error: 'Bad subscription' });
  await db.collection('pushSubs').doc(pushHash(sub.endpoint)).set({
    subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    updatedAt: admin.firestore.Timestamp.now(),
  });
  return res.json({ ok: true, push: pushEnabled });
}));

app.post('/api/push/unsubscribe', requireOwner, express.json({ limit: '10kb' }), handle(async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) return res.status(400).json({ error: 'Bad endpoint' });
  await db.collection('pushSubs').doc(pushHash(endpoint)).delete();
  return res.json({ ok: true });
}));

// Sends a test notification to every saved device.
app.post('/api/push/test', requireOwner, handle(async (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'Push is not configured (VAPID keys missing)' });
  const sent = await pushToAll({ title: 'Notifications are on', body: 'You will be notified when new mail arrives.', id: null });
  return res.json({ ok: true, sent });
}));

app.get('/ping', (req, res) => {
  res.status(200).send('Server is awake!');
});

// Which commit is running. Render sets RENDER_GIT_COMMIT / RENDER_GIT_BRANCH / RENDER_GIT_REPO_SLUG on every deploy.
const BUILD = (() => {
  const commit = (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').trim();
  const repo = (process.env.RENDER_GIT_REPO_SLUG || 'notamitgamer/mail-server').trim();
  const branch = (process.env.RENDER_GIT_BRANCH || '').trim();
  return {
    commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : '',
    repo: /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : 'notamitgamer/mail-server',
    branch: /^[\w./-]{1,100}$/.test(branch) ? branch : '',
  };
})();

app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(BUILD);
});

// app.js is served with the commit it was built from on its first line, so the code that is actually running
// knows its own version (a cached copy of an older app.js reports the older commit).
app.get('/assets/js/app.js', (req, res, next) => {
  fs.readFile(path.join(__dirname, 'public', 'assets', 'js', 'app.js'), 'utf8', (err, js) => {
    if (err) return next();
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript').send(`const __BUILD__ = ${JSON.stringify(BUILD)};\n${js}`);
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/(\.html|\.webmanifest|sw\.js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// `node server.js` (Render) starts the server; requiring this file for tests does not.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Email router listening on port ${port}`);
  });
}

module.exports = { app, archiveEmail };
