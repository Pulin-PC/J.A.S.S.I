# J.A.S.S.I for iPhone

A thin shell around the same web app everyone else uses. One WebView loads J.A.S.S.I; the app adds only what a browser can't do on an iPhone. The full rules are in [`docs/native-contract.md`](../../docs/native-contract.md).

Swift, SwiftUI + WKWebView, no third-party code. Needs iOS 17 or newer.

## What the iPhone app adds

| The web app calls | What happens on the iPhone |
|---|---|
| `openExternal(url)` | J.A.S.S.I's own sign-in page opens in the system sign-in sheet and comes back through `jassi://auth…`. Any other link opens in Safari. |
| `permissions()`, `openPermission(kind)` | Microphone, speech and alerts. Shows the system question the first time, opens Settings after that. The page is told when an answer changes. |
| `biometric({ reason })` | Face ID or Touch ID. |
| `listenStart` / `listenStop` | Speech-to-text, sending words as they are heard. Default language `en-IN`. |
| `speak` / `speakStop` | Reads text aloud. |
| `notify({ title, body })` | A system alert. |
| `listApps()` | Looks for 50 well-known apps and returns the ones found, with `partial: true`. |
| `pair` / `unpair` | Keeps the device token in the Keychain. |
| `setPolicy`, `stop` | Accepted, nothing to do. |
| Siri / Shortcuts: "Ask J.A.S.S.I" | Opens the app and hands the words to the page as the `ask` event. |

**What an iPhone can't do.** Apple does not let any app read or control other apps. So `permissions().screen` is always `"unsupported"`, `openPermission("screen")` answers `{ ok: false, error: "unsupported" }`, and the app never runs the device channel (contract §4). Apple also does not let an app list the other apps on the phone, which is why `listApps()` can only check a fixed list ([`KnownApps.swift`](JassiCore/Sources/JassiCore/KnownApps.swift)).

## Where things are

```
apps/ios/
  JASSI.xcodeproj        the Xcode project (one app target, scheme "JASSI")
  Info.plist             permissions text, the jassi:// link, the app-link list
  JASSI/                 the app: WebView, bridge, sign-in, voice, Face ID, alerts, Siri
  JassiCore/             the rules that need no iPhone (a local Swift package) + their tests
  dev/                   a stand-in server and page for checking the bridge by hand
```

The safety-critical rules live in `JassiCore` so they can be tested without a phone: who may use the bridge ([`Origin.swift`](JassiCore/Sources/JassiCore/Origin.swift)), where a link opens ([`Links.swift`](JassiCore/Sources/JassiCore/Links.swift)), how a call is read ([`BridgeCall.swift`](JassiCore/Sources/JassiCore/BridgeCall.swift)).

## Build and run

You need a Mac with Xcode (16 or newer) and an iOS Simulator. No Apple developer account is needed for the simulator.

Open `apps/ios/JASSI.xcodeproj` in Xcode, pick an iPhone simulator, press Run. Or from Terminal, in `apps/ios/`:

```bash
xcodebuild -project JASSI.xcodeproj -scheme JASSI -destination 'generic/platform=iOS Simulator' -derivedDataPath ~/Library/Developer/Xcode/DerivedData/JASSI-ios build
```

```bash
xcrun simctl boot "iPhone 17"; open -a Simulator
```

```bash
xcrun simctl install booted ~/Library/Developer/Xcode/DerivedData/JASSI-ios/Build/Products/Debug-iphonesimulator/JASSI.app
```

```bash
xcrun simctl launch booted dev.workers.pulin-chaudhari.jassi
```

Build output stays in `~/Library`, outside this Google Drive folder.

### Tests

The rules in `JassiCore` have unit tests. They run on the Mac in a few seconds, no simulator needed:

```bash
swift test --package-path JassiCore --scratch-path ~/Library/Caches/jassi-ios-tests
```

Or on a simulator, through the project:

```bash
xcodebuild -project JASSI.xcodeproj -scheme JASSI -destination 'platform=iOS Simulator,name=iPhone 17' test
```

### Use a different server

`JASSI_URL` is a build setting. The default is the live site. To use the address `npm start` prints:

```bash
xcodebuild -project JASSI.xcodeproj -scheme JASSI -destination 'generic/platform=iOS Simulator' JASSI_URL=http://localhost:3000 build
```

Debug builds can also be pointed somewhere for one launch, without rebuilding:

```bash
xcrun simctl launch booted dev.workers.pulin-chaudhari.jassi -JASSI_URL http://localhost:3000
```

The bridge only ever answers pages on the `JASSI_URL` address. A real phone can't reach `localhost` on your Mac; use the Mac's network address instead.

### Check the bridge by hand

`dev/` has a stand-in server and a page that calls every bridge method and shows the answers and the events:

```bash
python3 dev/stub_server.py
```

```bash
xcrun simctl launch booted dev.workers.pulin-chaudhari.jassi -JASSI_URL http://localhost:8899
```

Test the sign-in link (the page should show an `auth` event):

```bash
xcrun simctl openurl booted "jassi://auth?code=test"
```

## Before this can go on a real iPhone or the App Store (owner's to-do)

1. **Join the Apple Developer Program** ($99 a year, developer.apple.com). Nothing below is possible without it, not even installing on your own phone for more than a week.
2. **Set the team and the app id.** In Xcode: the JASSI target → Signing & Capabilities → pick your team. The app id is `dev.workers.pulin-chaudhari.jassi`; change it now if you want a different one (also change the `simctl launch` commands above). It can't be changed after the first upload.
3. **Read the permission questions.** These are the exact words the phone shows, in `Info.plist`. Apple rejects vague ones:
   - Microphone (`NSMicrophoneUsageDescription`): "J.A.S.S.I listens when you tap the mic, so you can talk instead of typing."
   - Speech (`NSSpeechRecognitionUsageDescription`): "J.A.S.S.I turns what you say into words so it can understand you."
   - Face ID (`NSFaceIDUsageDescription`): "J.A.S.S.I uses Face ID to check it is really you before it does something important."
4. **Test on a real iPhone.** The simulator can't prove Face ID on real hardware, Siri, real speech recognition, or which of the 50 apps are found. See "Not proven yet" below.
5. **App Store listing.** Screenshots, description, a privacy policy web page, and the privacy answers (the app uses the microphone and speech; sign-in is with Google). Apple also needs a test account it can sign in with.
6. **Sign in with Apple.** If Google is the only way to sign in, Apple's rule 4.8 asks for another sign-in choice that keeps the email private (Sign in with Apple is the usual answer). That is a server and web change, not an app change.
7. **Upload.** Xcode → Product → Archive → Distribute App → App Store Connect. Try it with TestFlight first.

### The App Store risk: "it's just a website" (guideline 4.2)

Apple rejects apps that are only a web page in a wrapper ("minimum functionality"). This app is a WebView, so a reviewer may raise it. What it does that a web page can't, and what to say in the review notes:

- **Siri and Shortcuts.** "Ask J.A.S.S.I" works from Siri, the Shortcuts app and Spotlight, without opening the app first.
- **Face ID / Touch ID** before important actions.
- **Speech in and out** through the phone's own engine, in Indian English and Hindi among others. Web pages on iPhone can't do speech-to-text reliably.
- **System alerts** when a task is done.
- **Sign-in through the system sign-in sheet**, the way Apple asks for.
- **Finds the apps you already use**, to offer connecting them.
- **Its own "no internet" screen** instead of a blank page.

Honest view: this helps, but it is not a guarantee. The screen-control part of J.A.S.S.I, its main trick on Android and desktop, can't exist on iPhone, so the iPhone app is the lightest of the three. If Apple still says no, the usual fixes are more native pieces (a home-screen widget, a share-sheet action that sends text to J.A.S.S.I as an `ask`) rather than arguing.

## Not proven yet

Things the simulator can't show. Check them on a real iPhone:

- Face ID / Touch ID with a real face or finger (the simulator only pretends).
- Siri hearing "Ask J.A.S.S.I" and passing the words on.
- Speech-to-text with a real microphone and real speech, including `hi-IN`.
- The app list: the 50 app ids and link schemes are from public knowledge and have not been checked against a phone with those apps installed.
- The full Google sign-in round trip, which needs the server side of the contract (`/auth/google/start?app=…` sending the browser to `jassi://auth?code=…`).
