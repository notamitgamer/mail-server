# Security policy

This project handles email, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue for security problems. Email **mail@amit.is-a.dev** with a description, steps to reproduce and the impact you see. You will get a reply as soon as possible, and a fix will be released before details are made public.

## Notes for people running their own instance

- Keep `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `FIREBASE_SERVICE_ACCOUNT` and `VAPID_PRIVATE_KEY` secret. Never commit a `.env` file.
- Lock Firestore down so that only the server can read and write (the exact rules are in the setup docs).
- Set `MAILBOX_OWNER_EMAIL` to the single account that should have access.
