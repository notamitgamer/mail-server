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
- Notifications are required: after sign-in the app asks for permission and shows a full-screen prompt until they are on
  (browsers that cannot do push, such as an iPhone browser tab, are not blocked). Every new mail triggers a Web Push to
  each device. Subscriptions are
  stored in the Firestore `pushSubs` collection (no extra Firestore rules needed; only the server touches it).
- Offline phones: the push service holds the notification for 7 days (`PUSH_TTL` in `server.js`) and delivers it
  when the phone reconnects, even if the app is closed.
- Turn it on: open the installed app, sign in, tap **Allow notifications**. A test notification is sent. The bell icon
  only shows the state; tap it to send another test.
- Tapping a notification opens the mail at once. A small mail (up to about 3.5 KB) travels inside the push itself;
  every push also carries a short-lived read token for that one mail (`/api/push/mail/:id`). The service worker
  saves the mail on the phone while it shows the notification. If you tap before that has finished, the app opens
  the reader straight away and fetches just that mail with the token (no sign-in, no sync). Only if that is not
  possible (for example the phone is offline) does it sync first and then open it.
- The app re-checks the subscription on every start and whenever it comes back to the front, and starts over if the
  server's VAPID key changed, so an update does not silently turn notifications off.
- Android: install the app from Chrome ("Install app"). On Vivo / Origin OS also set the app's battery to
  **Unrestricted** (or "High background power consumption" allowed), allow **Autostart** / background activity,
  and keep Chrome notifications on. Otherwise the system may hold pushes until the screen is turned on.
- iPhone: only works after "Add to Home Screen" (iOS 16.4+).
- A phone stops being notified if its browser data is cleared; open the app once and allow notifications again.

## Not built yet
HTML templates, attachments on sent mail.
