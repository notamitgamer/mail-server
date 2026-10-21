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

## Firebase console
1. Authentication, Sign-in method: enable **Google**.
2. Authentication, Settings, Authorized domains: add `mail.amit.is-a.dev` and your `*.onrender.com` host.
3. Firestore rules: only the server touches the database, so lock it down:
   `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if false; } } }`

## Resend
- Webhook: `https://<your-domain>/api/incoming`, event `email.received`.

## Not built yet
Push notifications, HTML templates, attachments on sent mail.
