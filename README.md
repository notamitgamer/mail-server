<p align="center">
  <img src="assets/logo.png" alt="Mailbox logo" width="120">
</p>

<h1 align="center">Mailbox</h1>

<p align="center">
  A small, self-hosted mailbox for your own domain, with push notifications.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-d0bcff?labelColor=141316"></a>
  <img alt="Node.js 18 or newer" src="https://img.shields.io/badge/node-%3E%3D18-d0bcff?labelColor=141316">
  <a href="https://docs.amit.is-a.dev/mailbox"><img alt="Documentation" src="https://img.shields.io/badge/docs-read-d0bcff?labelColor=141316"></a>
</p>

[Resend](https://resend.com) receives the mail, the server stores it in [Firebase Firestore](https://firebase.google.com/docs/firestore), and an installable web app lets you read, reply, forward and send, with push notifications for new mail. Nothing is forwarded to a third-party inbox.

## Screenshots

Shown with made-up demo mail.

**Desktop**

<table>
  <tr>
    <td align="center"><img src="assets/screenshots/desktop-signed-in.png" alt="Desktop, signed in"><br><sub>Signed in</sub></td>
    <td align="center"><img src="assets/screenshots/desktop-signed-out.png" alt="Desktop, signed out"><br><sub>Signed out</sub></td>
  </tr>
</table>

**Mobile**

<table>
  <tr>
    <td align="center"><img src="assets/screenshots/mobile-signed-in.png" alt="Mobile, signed in" width="260"><br><sub>Signed in</sub></td>
    <td align="center"><img src="assets/screenshots/mobile-signed-out.png" alt="Mobile, signed out" width="260"><br><sub>Signed out</sub></td>
  </tr>
</table>

## Features

- Receives mail through a Resend webhook and keeps it in your own Firestore database
- Mobile-first web app (PWA) with offline cache, swipe actions and pull to refresh
- Reply, forward and compose from your own addresses
- Bin (restorable for 30 days), Drafts saved as you type, and reusable HTML templates offered when you write a mail
- To, Cc and Bcc fields that turn each address into a pill
- All / Unread filter, one-click reader actions and keyboard shortcuts (`j`/`k` move, `r` reply, `c` compose, `/` search)
- Web Push notifications that open the message straight away
- Optional Android app (APK) with native push, Mark read / Delete / Reply buttons, `mailto:` links and a share target
- Single-owner by design: sign in with one Google account

## Quick start

You need a domain on Resend with inbound mail enabled, a Firebase project (Firestore and Google sign-in) and Node.js 18 or newer.

```bash
git clone https://github.com/notamitgamer/mailbox.git
cd mailbox
npm install
cp .env.example .env     # then fill in the values
node --env-file=.env server.js   # Node 20.6+; or export the variables and run: npm start
```

The app is served at `http://localhost:3000`. For production, deploy it as a Node web service (for example on Render) with the same variables, build command `npm install`, start command `npm start` and health check path `/ping`.

## Android app

A signed APK built from `android-app/` (a thin [Capacitor](https://capacitorjs.com) shell around the web app) is attached to each GitHub release. It delivers notifications through FCM, so only the app needs a battery exemption instead of Chrome, and adds action buttons on notifications, `mailto:` links and Share to Mailbox. Set-up (Firebase Android app, signing key, three repository secrets) is in [android-app/README.md](android-app/README.md) and in the docs.

## Documentation

Step-by-step setup, every environment variable, usage and the API reference live in the docs:
**https://docs.amit.is-a.dev/mailbox**

## Contributing and security

Issues and pull requests are welcome. Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Amit Dutta. The interface is based on the MIT-licensed [SmartMail](https://github.com/themepixels/smartmail) template by ThemePixels, and the app bundles other open-source libraries. Their licenses and credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

