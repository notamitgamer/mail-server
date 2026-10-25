# Android app

A small [Capacitor](https://capacitorjs.com) shell around the live web app, with native Google sign-in and
FCM push, so notifications reach the phone without Chrome. The UI is the same `public/` app served by the
server, so web updates reach the app without a new APK.

## One-time setup

1. In the Firebase console (same project as the server), add an **Android app** with package name
   `dev.amit.mail`, add the **SHA-1** of your signing key, then download `google-services.json`.
   Make sure Google is enabled under Authentication → Sign-in method.
2. Create a signing key (keep it safe; a different key can't update an installed app):
   ```sh
   keytool -genkeypair -v -keystore release.jks -alias mail -keyalg RSA -keysize 2048 -validity 10000
   keytool -list -v -keystore release.jks -alias mail   # shows the SHA-1 for step 1
   ```
   Use the same password for the keystore and the key.
3. Add these repository secrets (Settings → Secrets and variables → Actions):
   - `GOOGLE_SERVICES_JSON`: `base64 -w0 google-services.json`
   - `KEYSTORE_BASE64`: `base64 -w0 release.jks`
   - `KEYSTORE_PASSWORD`: the keystore password
4. Settings → Actions → General → Workflow permissions: **Read and write**.

## Build

Run the **Android APK** workflow from the Actions tab (or push a tag like `android-v1.0`). The signed
`mailbox.apk` is attached to a new release.

On Vivo, Oppo and Xiaomi phones also allow autostart and unrestricted battery for the app, and don't
swipe it away from recent apps, or the system may hold back notifications.
