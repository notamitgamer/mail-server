# mail-server: setup

Resend receives mail for `mail@amit.is-a.dev` and calls `/api/incoming`. The server
stores each mail in Firestore, and the web app in `public/` (SmartMail template, MIT)
reads, sends and replies from it. Nothing is forwarded to Gmail.

## Render
- Language: **Node**. Build: `npm install`. Start: `npm start`. Health check path: `/ping`.
- Environment variables:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | Resend API key (needs send and receive access) |
| `RESEND_WEBHOOK_SECRET` | signing secret of the Resend webhook |
| `ALLOWED_ALIASES` | `mail@amit.is-a.dev` (comma-separated; also the allowed "From" addresses) |
| `MAILBOX_OWNER_EMAIL` | the one Google account allowed to sign in |
| `FROM_NAME` | optional display name on sent mail |
| `FIREBASE_SERVICE_ACCOUNT` | service-account JSON (Firebase console, Project settings, Service accounts, Node.js), raw or base64 |
| `FIREBASE_WEB_CONFIG` | web-app config as JSON: `{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}` (Project settings, Your apps, Web) |
| `VAPID_PUBLIC_KEY` | public key printed by `npx web-push generate-vapid-keys` (run once, on any computer) |
| `VAPID_PRIVATE_KEY` | private key from the same command; keep it secret |
| `VAPID_SUBJECT` | optional contact, e.g. `mailto:mail@amit.is-a.dev` (defaults to the first alias) |

## Firebase console
1. Authentication, Sign-in method: enable **Google**.
2. Authentication, Settings, Authorized domains: add `mail.amit.is-a.dev` and your `*.onrender.com` host.
3. Firestore rules: only the server touches the database, so lock it down:
   `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if false; } } }`

## Resend
- Webhook: `https://<your-domain>/api/incoming`, event `email.received`.

## Message menu (three dots in the reader)
Reply, Forward, Mark as unread, Save as PDF, Print, Share, Open in Resend, Delete.
- **Delete** removes the message from Firestore for good. Other devices drop their saved copy on their next refresh.
- **Share** uses the phone's share sheet (or copies the text). It is not a public link; the mailbox stays private.
- **Open in Resend** opens the message in the Resend dashboard (needs you to be signed in to Resend).

## Push notifications
- Every new mail triggers a Web Push to each device that turned on the bell icon in the app. Subscriptions are
  stored in the Firestore `pushSubs` collection (no extra Firestore rules needed; only the server touches it).
- Offline phones: the push service holds the notification for 7 days (`PUSH_TTL` in `server.js`) and delivers it
  when the phone reconnects, even if the app is closed.
- Turn it on: open the installed app, sign in, tap the bell, allow notifications. A test notification is sent.
- Android: install the app from Chrome ("Install app"). On Vivo / Origin OS also set the app's battery to
  **Unrestricted** (or "High background power consumption" allowed), allow **Autostart** / background activity,
  and keep Chrome notifications on. Otherwise the system may hold pushes until the screen is turned on.
- iPhone: only works after "Add to Home Screen" (iOS 16.4+).
- A phone stops being notified if its browser data is cleared; open the app once and tap the bell again.

## Not built yet
HTML templates, attachments on sent mail.
