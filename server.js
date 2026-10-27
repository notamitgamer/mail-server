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

// ---- Attachments ------------------------------------------------------------
// The file bytes are kept in Firestore as chunks (one document is capped near 1 MiB), in a collection of their
// own so they stay put when a mail moves to the bin and back. Without our own copy, Resend's temporary download
// links would be the only source, and they expire after an hour.
const ATT_CHUNK = 900 * 1024;
const MAX_ATT_BYTES = 15 * 1024 * 1024; // per file; bigger ones are listed but not kept
const MAX_ATT_TOTAL = 25 * 1024 * 1024; // per mail
const attId = (mailId, n, c) => `${mailId}_${n}_${c}`;

const storeAttachment = async (mailId, n, content) => {
  const chunks = Math.ceil(content.length / ATT_CHUNK) || 1;
  for (let c = 0; c < chunks; c += 3) { // about 2.7 MB per commit
    const batch = db.batch();
    for (let i = c; i < Math.min(c + 3, chunks); i++) {
      batch.set(db.collection('attachments').doc(attId(mailId, n, i)), {
        mailId, n, c: i, chunks, size: content.length,
        data: content.subarray(i * ATT_CHUNK, (i + 1) * ATT_CHUNK),
      });
    }
    await batch.commit();
  }
};

// Best effort: a failure here is not fatal, the file is fetched from Resend again when it is first opened.
const storeAttachments = async (mailId, attachments) => {
  let total = 0;
  for (let n = 0; n < attachments.length; n++) {
    const content = attachments[n].content;
    if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_ATT_BYTES || total + content.length > MAX_ATT_TOTAL) continue;
    total += content.length;
    try { await storeAttachment(mailId, n, content); } catch (err) { console.error('Attachment not stored:', err.message); }
  }
};

const readAttachment = async (mailId, n) => {
  const first = await db.collection('attachments').doc(attId(mailId, n, 0)).get();
  if (!first.exists) return null;
  const { chunks, size } = first.data();
  if (!(chunks >= 1 && chunks <= 64)) return null;
  const parts = [Buffer.from(first.data().data)];
  if (chunks > 1) {
    const refs = [];
    for (let i = 1; i < chunks; i++) refs.push(db.collection('attachments').doc(attId(mailId, n, i)));
    for (const snap of await db.getAll(...refs)) {
      if (!snap.exists) return null; // half-written: treat as missing so it is fetched again
      parts.push(Buffer.from(snap.data().data));
    }
  }
  const buf = Buffer.concat(parts);
  return buf.length === size ? buf : null;
};

const deleteAttachments = async (mailIds) => {
  for (const id of mailIds) {
    const snap = await db.collection('attachments').where('mailId', '==', id).select().get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
};
// Who owns the stored bytes of a mail: a received mail owns its own (keyed by its id); a draft or sent mail
// owns one upload per file (`fid`), which stays the same when a draft becomes the sent mail.
const attOwners = (id, d) => [...new Set(((d && d.attachments) || []).map((a) => (a && a.fid) || id))];
// owners of every mail in a query result (the query must select 'attachments')
const ownersOf = (snap) => [...new Set(snap.docs.flatMap((d) => attOwners(d.id, d.data())))];

// Files you attach while writing are uploaded first (POST /api/uploads) and wait as "pending" (an `uploads`
// document) until a draft or a sent mail takes them over. Pending files nobody took are swept after a day.
const FID_RE = /^up-[a-f0-9]{30}$/;
const MAX_FILES = 10;
const newFid = () => 'up-' + crypto.randomBytes(15).toString('hex');
const cleanName = (v) => String(v || '').replace(/[\\/:*?"<>|\r\n\0]+/g, '_').trim().slice(0, 150) || 'attachment';

// The attachment list a draft or sent mail ends up with. `refs` is what the app sent ([{ fid }]), `prev` the list
// the saved draft already had. Returns the files, the pending uploads this takes over (`claim`) and the files
// that were dropped (`removed`). Without a list from the app (an older client) the saved one is kept as it is.
const resolveFiles = async (refs, prev = []) => {
  if (!Array.isArray(refs)) return { files: prev, claim: [], removed: [] };
  const files = []; const claim = []; let total = 0;
  for (const r of refs) {
    const fid = String((r && r.fid) || '');
    if (!FID_RE.test(fid) || files.some((f) => f.fid === fid)) continue;
    let info = prev.find((p) => p && p.fid === fid);
    if (!info) {
      const u = await db.collection('uploads').doc(fid).get();
      if (!u.exists) return { error: 'An attached file expired. Attach it again.', status: 400 };
      info = u.data(); claim.push(fid);
    }
    total += Number(info.size) || 0;
    files.push({ fid, filename: cleanName(info.filename), contentType: info.contentType || null, size: Number(info.size) || 0 });
  }
  if (files.length > MAX_FILES) return { error: `At most ${MAX_FILES} attachments`, status: 400 };
  if (total > MAX_ATT_TOTAL) return { error: 'Attachments are over 25 MB in total', status: 413 };
  const removed = prev.filter((p) => p && p.fid && !files.some((f) => f.fid === p.fid)).map((p) => p.fid);
  return { files, claim, removed };
};
// After the draft or mail is saved: the pending marks go, and files that were taken off are deleted.
const settleFiles = async (r) => {
  await Promise.all(r.claim.map((fid) => db.collection('uploads').doc(fid).delete().catch(() => {})));
  if (r.removed.length) await deleteAttachments(r.removed).catch((e) => console.error('deleteAttachments', e.message));
};

// Bytes of attachment `n` of a saved mail, or null. A received mail from before files were kept (or whose saving
// failed) is fetched from Resend again, and kept from then on.
const getAttachmentBytes = async (id, d, folder, n) => {
  const info = (d.attachments || [])[n];
  if (!info) return null;
  let buf = await readAttachment(info.fid || id, info.fid ? 0 : n);
  const received = folder === 'inbox' || (folder === 'trash' && d.origin !== 'sent');
  if (!buf && !info.fid && received) {
    try {
      const a = (await fetchFullEmail(id)).attachments?.[n];
      if (a && Buffer.isBuffer(a.content) && (a.filename || 'attachment') === info.filename) {
        buf = a.content;
        if (buf.length <= MAX_ATT_BYTES) storeAttachment(id, n, buf).catch((e) => console.error('Attachment not stored:', e.message));
      }
    } catch (err) { console.error('Attachment fetch failed:', err.message); }
  }
  return buf;
};

// ---- Push delivery ----------------------------------------------------------
const pushHash = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex');

// ---- FCM delivery (the Android app) -------------------------------------------
// Phones running the Android app register an FCM token. A notification message (not data-only) is used so
// Android shows it itself while the app is closed; tapping it hands `id` and `t` to the app.
const fcmHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const fcmToAll = async (payload) => {
  try {
    const docs = (await db.collection('fcmTokens').get()).docs;
    if (!docs.length) return 0;
    const data = { title: String(payload.title || 'New mail'), body: String(payload.body || '') };
    if (payload.id) data.id = String(payload.id);
    if (payload.t) data.t = String(payload.t);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: docs.map((d) => d.data().token),
      data, // data-only: the app builds the notification itself (Mark read / Delete / Reply buttons)
      android: { priority: 'high', ttl: PUSH_TTL * 1000 },
    });
    await Promise.all(res.responses.map(async (r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        await docs[i].ref.delete().catch(() => {}); // app was uninstalled
      } else if (r.error) console.error('FCM failed:', code);
    }));
    return res.successCount;
  } catch (err) {
    console.error('FCM error:', err.message);
    return 0;
  }
};

// Send one payload to every saved device. Never throws: a push problem must not make
// the webhook answer 500, because Resend would retry and the mail would be pushed twice.
const pushToAll = async (payload) => {
  if (!db) return 0;
  let sent = await fcmToAll(payload); // the Android app
  if (!pushEnabled) return sent;
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
    // Keep the attachment files in the background: a big mail would hold this request open until Resend gives up
    // and retries (and a retry skips everything, because the mail already exists). If someone opens a file before
    // it is stored, the download endpoint fetches it from Resend again.
    if (saved && parsed?.attachments?.length) {
      storeAttachments(emailData.email_id, parsed.attachments).catch((err) => console.error('Attachments not stored:', err.message));
    }
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
  const snap = await db.collection('trash').where('deletedAt', '<', cutoff).select('attachments').limit(400).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  await deleteAttachments(ownersOf(snap)).catch((e) => console.error('deleteAttachments', e.message));
  return snap.size;
}
// Files that were uploaded for a message but never ended up in a draft or a sent mail (the page was closed first).
async function purgeUploads() {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 3600000);
  const snap = await db.collection('uploads').where('createdAt', '<', cutoff).limit(100).get();
  for (const d of snap.docs) {
    await deleteAttachments([d.id]);
    await d.ref.delete();
  }
  return snap.size;
}
if (db) {
  setInterval(() => {
    purgeTrash().catch((e) => console.error('purgeTrash', e));
    purgeUploads().catch((e) => console.error('purgeUploads', e));
  }, 6 * 3600000).unref();
}

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

// One attachment of a received mail, as raw bytes. The app saves it on the device (like Gmail's offline mode), so
// this is normally called once per file per device. Sent as a download, never rendered by the browser itself.
const safeMime = (t) => (/^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/i.test(String(t || '')) ? String(t).toLowerCase() : 'application/octet-stream');
app.get('/api/mails/:id/attachments/:n', requireOwner, handle(async (req, res) => {
  const n = Number(req.params.n);
  if (!ID_RE.test(req.params.id) || !Number.isInteger(n) || n < 0 || n > 99) return res.status(400).json({ error: 'Bad request' });
  const folder = folderOf(req);
  if (folder === 'drafts') return res.status(404).json({ error: 'Not found' });
  const snap = await db.collection(FOLDERS[folder].collection).doc(req.params.id).get();
  const info = snap.exists ? (snap.data().attachments || [])[n] : null;
  if (!info) return res.status(404).json({ error: 'Not found' });

  const buf = await getAttachmentBytes(req.params.id, snap.data(), folder, n);
  if (!buf) return res.status(404).json({ error: 'This attachment is no longer available' });
  const name = encodeURIComponent(info.filename || 'attachment').replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return res.set({
    'Content-Type': safeMime(info.contentType),
    'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  }).send(buf);
}));

// A file the owner attaches while writing: the raw bytes are the request body, the name and type are in the query.
// It waits as "pending" until a draft or a sent mail takes it over (see resolveFiles).
const uploadsFull = async () => (await db.collection('uploads').count().get()).data().count >= 40;
const makePending = async (buf, name, type) => {
  const fid = newFid();
  const info = { filename: cleanName(name), contentType: safeMime(type), size: buf.length };
  await storeAttachment(fid, 0, buf);
  await db.collection('uploads').doc(fid).set({ ...info, createdAt: admin.firestore.Timestamp.now() });
  return { fid, ...info };
};
app.post('/api/uploads', requireOwner, express.raw({ type: () => true, limit: MAX_ATT_BYTES + 1024 }), handle(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'The file is empty' });
  if (buf.length > MAX_ATT_BYTES) return res.status(413).json({ error: 'Files can be at most 15 MB' });
  if (await uploadsFull()) return res.status(429).json({ error: 'Too many files waiting. Send or discard a message first.' });
  return res.json({ ok: true, ...(await makePending(buf, req.query.name, req.query.type)) });
}));

// Copies a file of a saved mail into a new pending upload, so it can go into a message being written
// ("Edit & forward"). The original stays as it is.
app.post('/api/mails/:id/attachments/:n/copy', requireOwner, handle(async (req, res) => {
  const n = Number(req.params.n);
  if (!ID_RE.test(req.params.id) || !Number.isInteger(n) || n < 0 || n > 99) return res.status(400).json({ error: 'Bad request' });
  const folder = folderOf(req);
  if (folder === 'drafts') return res.status(404).json({ error: 'Not found' });
  const snap = await db.collection(FOLDERS[folder].collection).doc(req.params.id).get();
  const info = snap.exists ? (snap.data().attachments || [])[n] : null;
  if (!info) return res.status(404).json({ error: 'Not found' });
  if (await uploadsFull()) return res.status(429).json({ error: 'Too many files waiting. Send or discard a message first.' });
  const buf = await getAttachmentBytes(req.params.id, snap.data(), folder, n);
  if (!buf) return res.status(404).json({ error: 'This attachment is no longer available' });
  return res.json({ ok: true, ...(await makePending(buf, info.filename, info.contentType)) });
}));

// Drops a file that was attached but is no longer wanted. Only touches files nobody has taken over yet; a file
// that is part of a draft is removed when the draft is saved without it.
app.delete('/api/uploads/:fid', requireOwner, handle(async (req, res) => {
  if (!FID_RE.test(req.params.fid)) return res.status(400).json({ error: 'Bad id' });
  const ref = db.collection('uploads').doc(req.params.fid);
  if ((await ref.get()).exists) {
    await deleteAttachments([req.params.fid]);
    await ref.delete();
  }
  return res.json({ ok: true });
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
  const old = await ref.get();
  await ref.delete(); // deleting a missing doc is fine
  if (old.exists) await deleteAttachments(attOwners(old.id, old.data())).catch((e) => console.error('deleteAttachments', e.message));
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
    const snap = await db.collection('trash').select('attachments').limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    await deleteAttachments(ownersOf(snap)).catch((e) => console.error('deleteAttachments', e.message));
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
    snippet: makeSnippet({ text: text || htmlToText(templateHtml) }), // the preview line in the Drafts list
    read: true,
    updatedAt: admin.firestore.Timestamp.now(),
  };
  let ref = null; let prev = [];
  if (b.id !== undefined && b.id !== null && b.id !== '') {
    if (!ID_RE.test(String(b.id))) return res.status(400).json({ error: 'Bad id' });
    ref = db.collection('drafts').doc(String(b.id));
    const old = await ref.get();
    if (!old.exists) return res.status(404).json({ error: 'Draft not found' }); // sent or discarded meanwhile
    prev = old.data().attachments || [];
  }
  const fr = await resolveFiles(b.attachments, prev);
  if (fr.error) return res.status(fr.status).json({ error: fr.error });
  doc.attachments = fr.files;
  if (ref) await ref.set(doc); else ref = await db.collection('drafts').add(doc);
  await settleFiles(fr);
  return res.json({ ok: true, id: ref.id, attachments: fr.files });
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

  const { to, cc, bcc, subject, html, text, replyToId, from, draftId, attachments } = req.body || {};
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

  // Attached files: those picked while writing (uploaded earlier), plus whatever the draft already had.
  let prevFiles = [];
  if (draftId && ID_RE.test(String(draftId))) {
    const ds = await db.collection('drafts').doc(String(draftId)).get();
    if (ds.exists) prevFiles = ds.data().attachments || [];
  }
  const fr = await resolveFiles(attachments, prevFiles);
  if (fr.error) return res.status(fr.status).json({ error: fr.error });
  if (fr.files.length) {
    payload.attachments = [];
    for (const f of fr.files) {
      const content = await readAttachment(f.fid, 0);
      if (!content) return res.status(400).json({ error: `"${f.filename}" is missing. Attach it again.` });
      payload.attachments.push({ filename: f.filename, content, ...(f.contentType ? { contentType: f.contentType } : {}) });
    }
  }

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
    attachments: fr.files, // the stored files now belong to this sent mail
  });
  await settleFiles(fr);
  if (draftId && ID_RE.test(String(draftId))) await db.collection('drafts').doc(String(draftId)).delete().catch(() => {}); // the draft became this mail (its files moved with it)
  return res.json({ ok: true, id: ref.id });
}));

// Forwards a saved message to the given address(es) as it is (no editing), then files a copy under Sent.
// Its attachments go along, as far as the files were kept (see MAX_ATT_BYTES); `skipped` counts the ones that were not.
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

  // The files of the original, as far as we hold them and they fit (10 files, 25 MB).
  const files = []; let skipped = 0; let total = 0;
  const all = d.attachments || [];
  for (let n = 0; n < all.length; n++) {
    const buf = files.length < MAX_FILES ? await getAttachmentBytes(snap.id, d, folder, n) : null;
    if (!buf || total + buf.length > MAX_ATT_TOTAL) { skipped++; continue; }
    total += buf.length;
    files.push({ info: all[n], buf });
  }

  const payload = {
    from: FROM_NAME ? `"${FROM_NAME}" <${fromAddress}>` : fromAddress,
    to: recipients,
    subject: (/^fwd?:/i.test(subject) ? subject : 'Fwd: ' + subject).slice(0, 500),
    html, text,
  };
  if (files.length) {
    payload.attachments = files.map(({ info, buf }) => ({
      filename: cleanName(info.filename), content: buf, ...(info.contentType ? { contentType: info.contentType } : {}),
    }));
  }
  const { data, error } = await resend.emails.send(payload);
  if (error) {
    console.error(error);
    return res.status(502).json({ error: error.message || 'Forward failed' });
  }
  sendLog.push(now);
  // The Sent copy gets its own copy of the bytes, so deleting either mail never takes the other one's files.
  const kept = [];
  for (const { info, buf } of files) {
    const fid = newFid();
    try {
      await storeAttachment(fid, 0, buf);
      kept.push({ fid, filename: cleanName(info.filename), contentType: info.contentType || null, size: buf.length });
    } catch (err) { console.error('Attachment not stored:', err.message); }
  }
  const ref = await db.collection('sent').add({
    from: fromAddress, to: recipients, subject: payload.subject, html, text,
    snippet: makeSnippet({ text }), sentAt: admin.firestore.Timestamp.fromDate(new Date()),
    resendId: data?.id || null, inReplyTo: null, attachments: kept,
  });
  return res.json({ ok: true, id: ref.id, skipped });
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

// Android app: save this phone's FCM token (one document per token).
app.post('/api/push/fcm', requireOwner, express.json({ limit: '10kb' }), handle(async (req, res) => {
  const token = req.body && req.body.token;
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return res.status(400).json({ error: 'Bad token' });
  await db.collection('fcmTokens').doc(fcmHash(token)).set({ token, updatedAt: admin.firestore.Timestamp.now() });
  return res.json({ ok: true });
}));

// Notification buttons in the Android app: Mark read / Delete one mail with the push token (no sign-in; the token is bound to the mail id).
app.post('/api/push/action', express.json({ limit: '2kb' }), handle(async (req, res) => {
  const { id, t, op } = req.body || {};
  if (typeof id !== 'string' || !ID_RE.test(id) || !checkMailToken(id, t)) return res.status(403).json({ error: 'Bad token' });
  if (op === 'read') {
    await db.collection('mails').doc(id).update({ read: true }).catch((err) => { if (err.code !== 5) throw err; });
    return res.json({ ok: true });
  }
  if (op === 'delete') {
    const ref = db.collection('mails').doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      const batch = db.batch();
      batch.set(db.collection('trash').doc(snap.id), { ...snap.data(), origin: 'inbox', deletedAt: admin.firestore.Timestamp.now() });
      batch.delete(ref);
      await batch.commit();
    }
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: 'Bad op' });
}));

// Sends a test notification to every saved device.
app.post('/api/push/test', requireOwner, handle(async (req, res) => {
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

app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));

// Public, read-only demo with made-up mail. No sign-in, no Firestore, no /api calls.
app.get("/demo", (req, res) => res.sendFile(path.join(__dirname, "public", "demo.html")));

// Proxy Firebase Auth handler to the underlying Firebase app domain
app.get("/__/auth/*", async (req, res) => {
  const targetUrl = "https://mail-server-notamitgamer.firebaseapp.com" + req.originalUrl;
  try {
    const upstream = await fetch(targetUrl);
    res.status(upstream.status);
    for (const [k, v] of upstream.headers.entries()) {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error("Auth proxy error:", err);
    res.status(502).send("Auth proxy error");
  }
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
