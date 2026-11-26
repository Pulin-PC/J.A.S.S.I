# Native apps: shared contract (v1)

One web app, three shells: **desktop** (macOS + Windows), **Android**, **iPhone**.
Each native app is a thin shell around the *same* web app (`public/`, served by the live site). The shell adds only what a browser can't do: screen control, the list of installed apps, sign-in through the system browser, real fingerprint, voice, alerts.

- Shells live in `apps/desktop/`, `apps/android/`, `apps/ios/`. A shell never edits `server/`, `worker/`, `public/` or `brain/`.
- The server side of this contract is live on `main` and on the live site: the sign-in hand-off (§3), `POST /api/device/pair` (signed in) → `{ deviceId, token }`, the device channel (§4), and `POST /api/device/apps` (the app scan). Test a shell against it, or against the address `npm start` prints.
- Need a change to this contract? Don't work around it: say what you need and why.

## 1. Shell rules

1. The window is one WebView that loads `JASSI_URL` (default `https://jassi.pulin-chaudhari.workers.dev`; a build setting can point it at the address `npm start` prints).
2. No feature, screen or wording is rebuilt natively. Same code, same UI. The only native screens are: "Can't reach J.A.S.S.I. Check your internet." with **Try again**, and the "J.A.S.S.I is working · Stop" banner.
3. The bridge exists only for the main frame of pages whose origin equals the `JASSI_URL` origin. Every other link opens in the system browser, never in the WebView.
4. Plain words in anything the user reads. The product name is written **J.A.S.S.I**.

## 2. Bridge: `window.jassiNative`

Injected before the page's scripts run. Every method returns a Promise and always exists. Not possible on this device → resolve `{ ok: false, error: "unsupported" }` (never throw).

Fields: `platform` (`"android" | "ios" | "macos" | "windows"`), `version` (shell version), `contract: 1`.

| Method | Result | Notes |
|---|---|---|
| `listApps()` | `{ ok, apps: [{ id, name }], partial }` | Apps the user can open. `id` = Android package name, Apple bundle id, or Windows AppUserModelID (lower case). `partial: true` when the OS only lets us detect some (iPhone). |
| `permissions()` | `{ screen, mic, speech, notifications }` | Each is `"granted" | "denied" | "ask" | "unsupported"`. `screen` = can read and act in other apps. |
| `openPermission(kind)` | `{ ok }` | Shows the system prompt, or opens the exact settings page for it. |
| `pair({ server, deviceId, token })` | `{ ok }` | Save the token in OS secure storage and start the device channel (§4). |
| `unpair()` | `{ ok }` | Forget the token, stop the channel. |
| `setPolicy({ blockedApps })` | `{ ok }` | App ids the shell must never read or act in (§4). Kept on the device. |
| `openExternal(url)` | `{ ok }` | System browser or auth session (Custom Tabs, ASWebAuthenticationSession, default browser). |
| `biometric({ reason })` | `{ ok }` | Real fingerprint, face, Touch ID or Windows Hello. |
| `listenStart({ lang, onDevice })` / `listenStop()` | `{ ok }` | Native speech-to-text. Sends `speech` events. `onDevice: true` (hands-free): recognise on the device when it can, so an always-on microphone never streams audio off the device. |
| `bubble({ visible?, state?, text?, who? })` | `{ ok }` | Optional. The small floating J.A.S.S.I bubble that stays over other apps. `visible: true` shows it (also after the user binned it), `false` hides it. `text` + `who` (`"you"` live words, `"jassi"` the reply) show in a small caption beside it that never takes a click or focus and fades a few seconds after the last words (only while the bubble is shown). `state`: `"sleep"` (dim, waiting for “Jassi”), `"listening"`, `"thinking"`, `"speaking"`. Draggable; dragging it onto the bin that appears hides it and sends `bubble` `dismissed`. Never takes focus from the app the user is in. iPhone: a Live Activity instead (iOS allows no window over other apps). |
| `wake({ on, words })` | `{ ok }` | Optional, later. A dedicated on-device wake-word engine (Picovoice). Until a shell has it, the web app spots “Jassi” in `listenStart` transcripts. |
| `speak({ text, lang })` / `speakStop()` | `{ ok }` | Native text-to-speech. |
| `notify({ title, body })` | `{ ok }` | System notification. |
| `stop()` | `{ ok }` | Abort any running screen action now. |

Events, shell → web: `window.dispatchEvent(new CustomEvent("jassi-native", { detail }))`.

| `detail.type` | Extra fields | When |
|---|---|---|
| `permission` | `permissions` (same shape as above) | A permission changed. While the web app is in front, check once a second so setup moves on by itself. |
| `speech` | `text`, `final` | Words heard so far (send partial results). |
| `speech-end` | `error?` | Listening stopped. |
| `bubble` | `action`: `"tap"` or `"dismissed"` | The user tapped the bubble (talk now / stop), or dragged it to the bin. |
| `auth` | `url` | A `jassi://auth…` link opened the app. Queue it until the page has loaded. |
| `ask` | `text` | Words handed in from outside the app (Siri / Shortcuts, a share sheet, a global hotkey). Queue it until the page has loaded. |
| `stopped` | `by: "user"` | The user pressed Stop, or took over the mouse/keyboard/screen. |

## 3. Sign-in

Google refuses sign-in inside a WebView, so it runs in the system browser.

1. The web app calls `openExternal(JASSI_URL + "/auth/google/start?app=<challenge>…")`. The challenge is the SHA-256 of a secret the web app keeps.
2. After Google, the server sends the browser to `jassi://auth?code=<one-time code, 60 s>`.
3. The shell registers the `jassi://` scheme, brings the app to the front and sends the `auth` event. The web app swaps code + secret for the session cookie.

The shell does nothing else with the link, and nothing but that one-time code ever travels in it.

## 4. Device channel (screen control): shell ↔ server

This runs in native code, not in WebView JavaScript, so it keeps working while another app is in front.

- `GET {server}/api/device/next?wait=25` with `Authorization: Bearer <token>` → `200 { id, op, args }`, or `204` (nothing to do, ask again).
- `POST {server}/api/device/result` with the same header and `{ id, ok, data?, error? }`.
- On errors wait 2 s, doubling up to 30 s. On `401`, unpair and stop.

| `op` | `args` | `data` |
|---|---|---|
| `screen_read` | `{}` | `{ app: { id, name }, nodes: [{ n, role, text, hint?, editable?, clickable?, focused?, secure?, bounds: [x, y, w, h] }] }`. Visible nodes only, at most 300, text cut at 200 characters. `n` is valid until the next read. |
| `screen_act` | `{ action: "tap" | "type" | "scroll" | "back" | "home" | "key", n?, text?, dir?, key? }` | `{ done: true }` |
| `open_app` | `{ id }` | `{ done: true }` |
| `list_apps` | `{}` | same as `listApps()` |

Safety the shell enforces in native code, whatever the server asks:

1. **Locked apps.** If the app in front is in `blockedApps`: `screen_read` returns `{ app, nodes: [], blocked: true }` and `screen_act` fails with `blocked_app`.
2. **Secrets.** Password and other secure fields never leave the device (`secure: true`, `text: ""`). Typing into one fails with `secure_field`.
3. **Protected screens.** Never act on system settings, permission prompts, install prompts, or J.A.S.S.I's own permission page: `protected_screen`.
4. **Always visible, always stoppable.** While an op runs, show "J.A.S.S.I is working · Stop". Stop, or the user touching the screen / moving the mouse / typing, cancels at once: the op fails with `stopped` and the shell sends the `stopped` event.
5. One op at a time, 15 s limit each, and only while paired with `screen` granted.
6. HTTPS only (plain HTTP only for `localhost` in dev builds). The token lives only in secure storage (Android Keystore, Apple Keychain, Windows Credential Manager) and never in logs.
7. Screen content is never stored or logged on the device.

## 5. Setup the user sees (web, the same everywhere)

hello → sign in → **allow** (microphone, alerts, and "Let J.A.S.S.I see and tap your screen" where the device supports it) → **apps** (scan with `listApps()`, tick to connect, locked apps greyed out) → money rules → done.

The shell's whole job in setup is `permissions()`, `openPermission()` and the `permission` event. The web screen has one button, **Open Settings**, and moves on by itself when the permission arrives. There is no "I'm done" button.

## 6. What each device can do

| | Android | macOS | Windows | iPhone |
|---|---|---|---|---|
| `screen` | Accessibility service | Accessibility permission | Always granted (UI Automation) | `unsupported` |
| `listApps` | Apps with a launcher icon (no `QUERY_ALL_PACKAGES`) | `/Applications`, `~/Applications` | Start menu apps | Known apps found by URL scheme, `partial: true` |
| Device channel | Yes | Yes | Yes | No (never pairs for screen ops) |
| `biometric` | BiometricPrompt | Touch ID | Windows Hello | Face ID / Touch ID |

Screens are read as text (the accessibility tree). v1 takes no screenshots, so macOS needs no Screen Recording permission.
