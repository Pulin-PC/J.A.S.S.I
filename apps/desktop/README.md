# J.A.S.S.I for macOS and Windows

One Tauri 2 project. It is a thin shell around the same web app everyone else uses: one window that loads the J.A.S.S.I site, plus the things a browser can't do (see the list of apps on this computer, read and act in other apps, sign in through the default browser, Touch ID / Windows Hello, voice, alerts). The full interface is [docs/native-contract.md](../../docs/native-contract.md). Nothing in `server/`, `worker/`, `public/` or `brain/` is touched or copied.

## Build and run

You need Rust and, to make an installable app, the Tauri command-line tool. On a Mac:

```bash
brew install rustup && "$(brew --prefix rustup)/bin/rustup" default stable
```

```bash
cargo install tauri-cli --version "^2" --locked
```

(On Windows: install Rust from [rustup.rs](https://rustup.rs) with the "Desktop development with C++" build tools, then the same `cargo install`.)

Everything below runs from `apps/desktop/`. Start each terminal with this: it puts Homebrew's Rust on the PATH and keeps build output out of this synced folder (in `~/Library/Caches/jassi/desktop-target`, about 6 GB).

```bash
. dev/env.sh
```

Run the dev build. It loads the live site:

```bash
cargo run
```

Point it at a local server instead (the address `npm start` prints). `JASSI_URL` is a build setting: it must be `https`, except `http://localhost…` in dev builds.

```bash
JASSI_URL=http://localhost:3000 cargo run
```

Run the tests (every safety rule as plain logic):

```bash
cargo test
```

Once per Mac, make this Mac's own signing certificate (free, stays on this Mac). `dev/env.sh` then signs every build with it, so macOS keeps the Accessibility, microphone and speech permissions across rebuilds instead of treating each build as a new app:

```bash
sh dev/local-signing.sh
```

Make the app (`J.A.S.S.I.app` on a Mac, an installer on Windows). `--debug` keeps it a dev build; drop it for a release build.

```bash
. dev/env.sh && cargo tauri build --debug --bundles app
```

The app lands in `~/Library/Caches/jassi/desktop-target/debug/bundle/macos/J.A.S.S.I.app`. Use this, not `cargo run`, to try sign-in, alerts and listening: `jassi://` links, alert settings and the microphone prompt only exist for a real app bundle.

## What is where

| File | What it does |
|---|---|
| `src/main.rs`, `src/shell.rs` | The window, which links stay inside, events to the web app, `jassi://` links, the "Can't reach J.A.S.S.I." screen, the stop shortcut |
| `src/bridge.js`, `src/bridge.rs` | `window.jassiNative`, injected before the page's scripts, answered by native commands |
| `src/policy.rs` | Every safety rule as plain logic, with unit tests |
| `src/channel.rs`, `src/ops.rs` | The device channel (long-poll loop with back-off) and the guard around each screen action |
| `src/banner.rs`, `ui/` | The only two native screens: start / "Can't reach J.A.S.S.I." and the "J.A.S.S.I is working · Stop" banner |
| `src/store.rs` | The pairing token (Keychain / Windows Credential Manager) and the locked-apps list |
| `src/platform/macos*.rs` | macOS: Accessibility API + CGEvent, Touch ID, Apple Speech, alerts |
| `src/platform/win*.rs` | Windows: UI Automation + SendInput, Windows Hello, Windows speech, alerts |
| `dev/` | A throwaway stub server and test tools. Dev only, never shipped |

## Who may call the bridge

Only the main frame of a page whose origin is exactly `JASSI_URL`, in the main window. This is enforced three times: the bridge script refuses to install itself anywhere else, Tauri's access rules allow the commands for that origin only (`build.rs` + `src/shell.rs`), and every command checks the window's address again. Any other link opens in the default browser (`http`, `https`, `mailto` and `tel` links only).

## Safety rules, enforced in native code

Whatever the server asks:

1. **Locked apps** are never opened, read or acted in. `setPolicy({ blockedApps })` adds to a built-in list (password managers); it can never shrink it.
2. **Password boxes** never leave the device (`text` is empty) and cannot be typed into. Typing is also refused unless a text box has the keyboard (`not_editable`), so stray letters can never act as shortcuts in some other app.
3. **System settings, permission prompts, sign-in prompts, installers and J.A.S.S.I's own window** are never acted on.
4. While an action runs, an always-on-top **"J.A.S.S.I is working · Stop"** banner shows. Stop, the shortcut **Control + Option + Esc** (Ctrl + Alt + Esc on Windows), or simply moving the mouse or pressing a key cancels at once. After Stop, new actions are refused for 2 seconds so a queued one cannot slip through.
5. One action at a time, 15 seconds at most, only while paired and allowed.
6. HTTPS only (plain HTTP only to `localhost` in dev builds). The pairing token lives only in the Keychain / Windows Credential Manager, and a `401` from the server forgets it.
7. Nothing read from the screen is stored or logged.

## What a computer does differently from a phone

- `screen_act` `back` is Command-[ on a Mac and Alt-Left on Windows. `home` answers `unsupported`.
- `screen_act` `key` takes `enter`, `tab`, `escape`, `backspace`, `delete`, `space`, the arrows, `home`, `end`, `pageup`, `pagedown`, and combinations such as `cmd+a` or `ctrl+shift+t`. On Windows `cmd` means Ctrl.
- `n` in a `screen_read` is not 0, 1, 2…: it has gaps (it counts hidden elements too).
- Extra error words besides the contract's: `timeout`, `no_permission`, `not_paired`, `not_editable`, `stale` (the app in front changed, or `n` is unknown: read again), `not_found`, `bad_args`, `unknown_op`.
- macOS: closing the window keeps J.A.S.S.I running so screen control keeps working; the Dock icon brings the window back. Windows: closing the window quits.
- macOS shows an alert as a banner only when J.A.S.S.I is not the app in front (otherwise it goes quietly to Notification Centre). That is how macOS treats every app.

## Testing screen control without the real server

`dev/stub.mjs` is a throwaway stand-in for contract §4, and `dev/op.mjs` sends one op through it. The stub refuses `screen_act` unless the last `screen_read` saw TextEdit, Calculator or the test window: you are testing on a computer you are also using.

```bash
node dev/stub.mjs
```

In a second terminal, start the app and pair it with the stub:

```bash
. dev/env.sh && JASSI_DEV_SCRIPT=dev/test-pair.js cargo run
```

In a third:

```bash
node dev/op.mjs open_app '{"id":"com.apple.textedit"}' && node dev/op.mjs screen_read
```

`JASSI_DEV_SCRIPT=<file>` (dev builds only) runs a script inside the loaded page; the other `dev/test-*.js` files call every bridge method that way. `dev/fake-user.c` stands in for a person (moves the mouse at hardware level, presses the stop shortcut or the banner's Stop), and `dev/secure-test.m` is a small window with a password box.

## Release to-do (owner)

Nothing here is signed with a real identity. Dev builds run on your own Mac; other people's computers will warn or refuse until this is done.

**macOS**
1. Join the Apple Developer Program (paid, yearly) and create a **Developer ID Application** certificate.
2. Set `APPLE_SIGNING_IDENTITY` to that certificate's name (it wins over the local certificate and the `"-"` in `tauri.conf.json`), then `cargo tauri build`.
3. **Notarize** the app with Apple: with `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID` set, `cargo tauri build` does it. Ship the `.dmg`.
4. Build once on Apple silicon and once for Intel, or `--target universal-apple-darwin` for both in one.
5. Keep `entitlements.plist`: the app runs with Apple's hardened runtime, and without the microphone line in that file macOS refuses the microphone without asking.
6. Signing matters for more than warnings. macOS ties the Accessibility, microphone and speech permissions to the app's signature: a build signed ad hoc loses them every time it is rebuilt (the switch in Settings stays on but stops working). A build signed with your Developer ID keeps them across updates for every user. As a safety net for any build, the app clears its own stale Accessibility entry when it is not trusted and the person taps the permission button, so the system prompt and a fresh switch always come back (`src/platform/macos.rs`).

**Why it can't go in the Mac App Store.** App Store apps must run in Apple's sandbox, and a sandboxed app is not allowed to read or control other apps through the Accessibility API or to send clicks and keys to them. That is the whole point of this app, so it ships outside the store (signed + notarized), like other automation tools.

**Windows**
1. Buy a **code-signing certificate** (an OV certificate works; an EV certificate, or Microsoft's Azure Trusted Signing, avoids the SmartScreen "unknown publisher" warning from day one).
2. Put it in `bundle.windows` in `tauri.conf.json` (`certificateThumbprint`, `digestAlgorithm`, `timestampUrl`) and run `cargo tauri build` **on a Windows PC**. That makes the installer, which also registers `jassi://` links.
3. Test on a real PC first: see the next section.

**Both**
- Pick the final app id (`identifier` in `tauri.conf.json`, now `app.jassi.desktop`) before the first public release. Changing it later makes the system treat it as a new app (permissions and saved pairing start over).
- Updates: none built in. Add Tauri's updater, or ship new installers by hand.

## Not checked on Windows

The Windows code has never run. From a Mac it can only be compile-checked against the real Windows API, which passes with no errors or warnings:

```bash
sh dev/win-check.sh
```

That check does not link, make an `.exe` or run anything. On a real PC, check at least:

- it builds and the installer works; a `jassi://auth…` link reaches the running app;
- `listApps()` lists the Start menu, and the app in front is recognised by the same id (so locked apps really are locked), including Store apps;
- `screen_read` / `screen_act` in Notepad; a password box comes back empty and cannot be typed into; Settings and the UAC prompt are refused;
- the banner shows, and Stop, Ctrl + Alt + Esc, and moving the mouse each cancel;
- the token is in Credential Manager; Windows Hello, speaking, listening and alerts work.

Windows itself blocks one thing: a normal program cannot click or type into a window that runs "as administrator". Those actions fail with `failed`.

## Known limits

- Banks, UPI, brokers and health portals are web pages inside a browser on a computer, and `blockedApps` locks by app, not by web address. Until the contract can carry locked sites, lock the browser itself or nothing protects those pages.
- `listApps()` follows the contract (`/Applications` and `~/Applications`), so Apple's own apps in `/System/Applications` (Mail, Notes, Calendar, TextEdit…) are not listed. They can still be opened by id.
- A screen read covers the window in front (up to 1,500 elements walked, 300 sent), not menus or other windows.
- Windows Hello accepts the PIN the person set up for it as well as a fingerprint or face.
- No global hotkey for handing words in (the optional `ask` event): it would need a third native screen.
