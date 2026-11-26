# J.A.S.S.I for Android

A thin Android app around the same J.A.S.S.I web app everyone else uses. It adds only what a browser can't do: the list of installed apps, sign-in through the browser, fingerprint, voice, alerts, and screen control (reading the screen as text and tapping for you) with the safety rules enforced on the phone.

The interface it implements is [`docs/native-contract.md`](../../docs/native-contract.md). Nothing in `server/`, `worker/`, `public/` or `brain/` is touched by this folder.

## Build and install

You need a JDK (17 or newer) and the Android SDK (platform 36). No Android Studio needed.

```bash
cd apps/android
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home   # any JDK 17+
export ANDROID_HOME=$HOME/Library/Android/sdk
./gradlew --project-cache-dir ~/Library/Caches/jassi/android/.gradle assembleDebug testDebugUnitTest
adb install -r ~/Library/Caches/jassi/android/app/outputs/apk/debug/app-debug.apk
```

- Build output goes to `~/Library/Caches/jassi/android/` (outside the synced folder). Change it with `-Pjassi.buildRoot=/some/folder`.
- The app opens the live site by default. To point it at a local server: add `-PjassiUrl=http://localhost:8787` (plain HTTP works for `localhost` in debug builds only) and run `adb reverse tcp:8787 tcp:8787` so the phone's `localhost` is your computer.
- Installed with `adb`, the app can be switched on under Settings → Accessibility straight away. Installed from an APK file, see "Restricted settings" below.

## Try it without the real server

`dev/stub.mjs` is a throwaway stand-in for contract §4 plus a test page with one button per bridge method.

```bash
node dev/stub.mjs                         # http://localhost:8787, token "dev-token"
adb reverse tcp:8787 tcp:8787
./gradlew --project-cache-dir ~/Library/Caches/jassi/android/.gradle assembleDebug -PjassiUrl=http://localhost:8787
# install, open the app, tap "openPermission(screen)", switch J.A.S.S.I on, come back, tap "pair". Then:
curl -s -X POST localhost:8787/dev/op -d '{"op":"open_app","args":{"id":"com.google.android.deskclock"}}'
curl -s -X POST localhost:8787/dev/op -d '{"op":"screen_read"}'
curl -s -X POST localhost:8787/dev/op -d '{"op":"screen_act","args":{"action":"tap","n":7}}'
```

`node dev/cdp.mjs 'window.jassiNative.permissions()'` runs a line of JavaScript inside the app's page (debug builds only), which is handy for calling the bridge on the live site.

## What is where

| File | Job |
|---|---|
| `MainActivity.kt` | The one screen: WebView, "Can't reach J.A.S.S.I" screen, `jassi://auth` links, permission prompts. |
| `Bridge.kt`, `assets/bridge.js` | `window.jassiNative`. Reaches the app only from the main frame of the J.A.S.S.I site. |
| `ScreenService.kt`, `Banner.kt` | The accessibility service: read the screen, tap, type, scroll, and the "J.A.S.S.I is working · Stop" banner. |
| `DeviceChannel.kt`, `Backoff.kt` | The long-poll loop of contract §4, in native code. |
| `Policy.kt`, `Nodes.kt`, `Origins.kt` | The safety rules as plain logic (unit tested). |
| `Vault.kt` | Pairing token, encrypted with a key held in the Android Keystore. |
| `Apps.kt`, `Perms.kt`, `Notify.kt`, `Voice.kt`, `Biometric.kt`, `External.kt` | The rest of the bridge methods. |

## Safety rules (contract §4) and where they live

| Rule | Where |
|---|---|
| 1. Locked apps are never read or controlled | `Policy.isLocked` (the list from `setPolicy`, plus a built-in list of well-known money / ID / password apps and apps named like a bank, wallet or UPI app) |
| 2. Passwords never leave the phone | `Nodes.isSecure`, `Nodes.toJson`, `ScreenService.type` |
| 3. Settings, permission and install screens are off limits | `Policy.isProtected` (also the keyboard, the lock screen and J.A.S.S.I's own window) |
| 4. Banner always visible; Stop or a touch cancels at once | `Banner.kt`, `ScreenService.stoppedByUser` |
| 5. One op at a time, 15 s each, only while paired and switched on | `ScreenService.run`, `DeviceChannel.refresh` |
| 6. HTTPS only; token only in secure storage, never logged | `Origins.serverAllowed`, `res/xml/network_security_config.xml`, `Vault.kt` |
| 7. Screen content never stored or logged | Nothing writes it anywhere. Debug builds log op names and result codes only (`adb logcat -s jassi`). |

## Choices worth knowing

- **Taps use the app's own "click" action**, not a simulated finger. That is why the service does not ask Android for the "perform gestures" ability. Things on screen that offer no click action answer `not_clickable`. `key` takes `enter`, `tab` (next box) and `escape` (same as Back).
- **Steps only run in the app J.A.S.S.I last looked at.** Anything else in front answers `stale`. If the user came back to J.A.S.S.I to tap "Yes, do it", J.A.S.S.I's window steps out of the way first and the step runs where it was looking.
- **Typing puts the cursor in the box**, so a following Enter or Tab applies to it.
- **Permission prompts**: one Android prompt at a time. `denied` is only reported when Android refuses to show its prompt; `openPermission` then opens the Settings page instead.
- **The banner stays up for 8 seconds after each step** so it bridges the steps of one job. If the user touches the screen or taps Stop in that time, the next step is refused with `stopped`.
- **The device channel only talks to the site the app was built for** (`JASSI_URL`), or to `localhost` in debug builds. `pair()` with any other server answers `bad_server`.
- `listApps()` adds `locked: true` to apps this phone will always refuse, so the setup screen can grey them out.
- `screen_read` on a protected screen answers `{ app, nodes: [], protected: true }`.
- **Error words** (kept the same as the desktop and iPhone shells). Bridge: `unsupported`, `unknown_method`, `bad_args`, `permission`, `cancelled`, `failed`, plus `bad_server`, `bad_url`, `not_set_up` (no fingerprint saved). Device ops: `blocked_app`, `secure_field`, `protected_screen`, `stopped`, `timeout`, `stale`, `unknown_op`, `bad_args`, `not_found`, `unsupported`, `failed`, plus `not_clickable`, `not_editable`, `no_field`, `not_scrollable`, `cant_scroll`, `not_opened`, `no_screen`, `no_banner`.
- **Node roles**: `text`, `field`, `button`, `checkbox`, `radio`, `switch`, `image`, `scroll`, `item`, `group`. Tick boxes and switches say `on` / `off` in `hint`.
- **`no_banner`** means Android would not let the service draw the Stop banner, so it refuses to act. Seen once, when Android had flagged the service as crashed; switching J.A.S.S.I off and on under Accessibility cleared it.

## Before release: the owner's to-do

Nothing here is signed for release. Debug builds only.

1. **Pick the app id for good.** It is `app.jassi.android` now (`app/build.gradle.kts`). It can never change once the app is on Google Play.
2. **Create a signing key** and keep it safe (lose it and you can't update the app). Then build with `./gradlew bundleRelease` and a `signingConfig`.
3. **Google Play Console account** (one-time fee, identity check). New personal accounts must run a closed test with real testers for two weeks before they can publish: check the current numbers in the Console.
4. **Read Google's accessibility rules before anything else. This may block the Play Store.**
   - Policy: <https://support.google.com/googleplay/android-developer/answer/10964491> and the policy preview at <https://support.google.com/googleplay/android-developer/answer/13986130>.
   - As of the October 2025 update, Google says the Accessibility API must not be used to let an app "autonomously initiate, plan, and execute actions". Simple fixed rules ("if X then Y") are allowed, and so are real accessibility tools for people with disabilities. J.A.S.S.I's screen control is an AI agent acting on the screen, so **read the current text and decide before submitting**. The wording has been changing, and I could not open the full English text.
   - If it is not allowed, the choices are: (a) hand out the APK yourself instead of using Play, (b) put a Play version in the store without the screen service (everything else still works; `permissions().screen` would be `unsupported`), or (c) ask Google for a ruling.
5. **If you do submit with the service:**
   - Fill in the **Accessibility API declaration** in Play Console (what it is used for, and a short video showing it).
   - Keep `isAccessibilityTool="false"`. It is only for apps whose main purpose is helping people with disabilities.
   - **Prominent disclosure and consent.** Before sending the user to Settings, the app must show its own clear screen saying what it reads (the text on screen), why, and that it is sent to the J.A.S.S.I server, with an explicit "I agree". This belongs on the web setup step "Let J.A.S.S.I see and tap your screen" (contract §5), so it is the web app's job. It can't be hidden in a privacy policy.
   - A privacy policy link, and the **Data safety** form: screen text, the list of installed apps and voice are collected / sent.
6. **"Restricted settings" when installed from an APK file.** On Android 13 and newer, an app installed from a downloaded APK (not from Play, not with `adb`) can't be switched on under Accessibility at first: Android shows "Restricted setting". The user then has to open Settings → Apps → J.A.S.S.I → the ⋮ menu (top right) → **Allow restricted settings**, confirm with their PIN or fingerprint, and go back to Accessibility. Newer Android versions and some phone makers make this harder still, and phones with Advanced Protection switched on refuse it. Test it on a real phone and write the steps for users in plain words.
7. **Test on real phones.** Only an emulator (Android 16) was used so far. Check at least one Samsung and one Xiaomi / Realme: their battery savers can stop the service, and the Accessibility page sits in a different place.
8. Set `versionCode` / `versionName` for each release.
