const path = require('path');
const express = require('express');
const { Resend } = require('resend');
const { Webhook } = require('svix');
const { simpleParser } = require('mailparser');
const admin = require('firebase-admin');

const app = express();

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
const port = process.env.PORT || 3000;

const resend = new Resend(process.env.RESEND_API_KEY);
const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;

// Plain-text version of an HTML body (used for snippets and the text part of sent mail).
const htmlToText = (html) =>
  String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

const makeSnippet = (parsed) =>
  (parsed?.text || htmlToText(parsed?.html) || '').replace(/\s+/g, ' ').trim().slice(0, 160);

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
  if (!db) return;
  try {
    await db.collection('mails').doc(emailId).create({
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
    });
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message)) return; // retry of a mail we already saved
    throw err;
  }
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
    await archiveEmail({
      emailId: emailData.email_id,
      from: originalSender,
      to: originalRecipient,
      subject,
      receivedAt,
      parsed,
    });
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
};
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
  subject: d.subject || '(no subject)',
  snippet: d.snippet || '',
  date: (d[FOLDERS[folder].dateField]?.toDate?.() || new Date()).toISOString(),
  read: d.read !== false,
  attachmentCount: (d.attachments || []).length,
});

const toFull = (id, d, folder) => ({
  ...toSummary(id, d, folder),
  html: d.html || null,
  text: d.text || null,
  attachments: d.attachments || [],
  truncated: Boolean(d.truncated),
});

// Public, non-secret settings the web app needs to start.
app.get('/api/config', (req, res) => {
  let firebase = null;
  try { firebase = JSON.parse(process.env.FIREBASE_WEB_CONFIG || 'null'); } catch (err) { /* ignore */ }
  res.json({ firebase, aliases: SEND_ALIASES, fromName: FROM_NAME });
});

app.get('/api/mails', requireOwner, handle(async (req, res) => {
  const folder = folderOf(req);
  const { collection, dateField } = FOLDERS[folder];
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  let query = db.collection(collection).orderBy(dateField, 'desc');
  const before = Number(req.query.before);
  if (before) query = query.startAfter(admin.firestore.Timestamp.fromMillis(before));
  const snap = await query
    .select('from', 'to', 'subject', 'snippet', 'read', 'attachments', dateField)
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
  if (folder === 'inbox' && req.query.reconcile) {
    try {
      const unread = db.collection('mails').where('read', '==', false);
      out.unread = (await unread.count().get()).data().count;
      out.unreadIds = out.unread <= 1000 ? (await unread.select().get()).docs.map((d) => d.id) : null;
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

const sendLog = []; // timestamps, a crude hourly cap in case the sign-in is ever abused
app.post('/api/send', requireOwner, express.json({ limit: '2mb' }), handle(async (req, res) => {
  const now = Date.now();
  while (sendLog.length && now - sendLog[0] > 3600000) sendLog.shift();
  if (sendLog.length >= 50) return res.status(429).json({ error: 'Hourly send limit reached' });

  const { to, subject, html, text, replyToId, from } = req.body || {};
  const recipients = (Array.isArray(to) ? to : String(to || '').split(/[,;\s]+/))
    .map((a) => String(a).trim()).filter(Boolean);
  if (!recipients.length || recipients.length > 20 || !recipients.every((a) => EMAIL_RE.test(a))) {
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
    to: recipients,
    subject: payload.subject,
    html: payload.html || null,
    text: payload.text || null,
    snippet: makeSnippet(payload),
    sentAt: admin.firestore.Timestamp.fromDate(new Date()),
    resendId: data?.id || null,
    inReplyTo,
    attachments: [],
  });
  return res.json({ ok: true, id: ref.id });
}));

app.get('/ping', (req, res) => {
  res.status(200).send('Server is awake!');
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
