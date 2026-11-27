# J.A.S.S.I — Just Another Smart System Interface

**One assistant for all your apps. You talk, it acts, and a safety guard in code decides what needs your OK.**

wHACKiest 2026 · Track 1: *Make MCP Matter* · Team J.A.S.S.I (MSRIT) — Round 1 prototype.

**Live:** https://jassi.pulin-chaudhari.workers.dev (Cloudflare Workers + Durable Objects)

![J.A.S.S.I dashboard](docs/dashboard.jpg)

> "Order my usual and put the delivery time in my calendar and WhatsApp Riya the ETA."
> → 3 apps, 1 Code Mode script, 12 ms. Safe steps start **while you are still talking**.

---

## Download

| Device | Get it | Needs |
|---|---|---|
| **Android** | [**JASSI-android.apk**](https://github.com/Pulin-PC/J.A.S.S.I/releases/latest/download/JASSI-android.apk) | Android 8.0 or newer |
| **Mac** (Apple silicon and Intel) | [**JASSI-macos.dmg**](https://github.com/Pulin-PC/J.A.S.S.I/releases/latest/download/JASSI-macos.dmg) | macOS 11 or newer |
| **Windows** (not yet tried on a real PC) | [**JASSI-windows-setup.exe**](https://github.com/Pulin-PC/J.A.S.S.I/releases/latest/download/JASSI-windows-setup.exe) | Windows 10 or 11, 64-bit |
| **iPhone** | No download yet: [build it with Xcode](#iphone) or [add the web app to your Home Screen](#iphone) | iOS 17 or newer for the app |
| **Any other device** (Linux, iPad, Chromebook…) | [Open the web app](https://jassi.pulin-chaudhari.workers.dev) | A modern browser (Chrome for voice) |

All versions are on the [Releases page](https://github.com/Pulin-PC/J.A.S.S.I/releases). Windows builds: [Code signing policy](CODE_SIGNING_POLICY.md). Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). Every app signs in with Google and is **invite only**: ask the owner for an invite link first.

These are **test builds**: they are not signed with a store or developer identity, so your device warns you once. Install them only from this page.

## Installation guides

### Android

1. On the phone, download [JASSI-android.apk](https://github.com/Pulin-PC/J.A.S.S.I/releases/latest/download/JASSI-android.apk).
2. Open the downloaded file. If Android asks, allow your browser (or Files app) to **install unknown apps**, then press **Install**. If Play Protect warns you, choose **More details → Install anyway**.
3. Open **J.A.S.S.I**, sign in with Google and follow the setup screens (microphone, alerts).
4. **For screen control** (optional): turn J.A.S.S.I on under **Settings → Accessibility**. On Android 13 or newer you may first see **Restricted setting**. Then open **Settings → Apps → J.A.S.S.I → ⋮ → Allow restricted settings**, confirm with your PIN or fingerprint, and go back to Accessibility.
5. Set up a fingerprint or face on the phone to approve payments with it.

Tested on an emulator (Android 16), not yet across real phone brands. Some phones' battery savers may stop screen control. Phones with Advanced Protection on will refuse it.

### Mac

1. Download [JASSI-macos.dmg](https://github.com/Pulin-PC/J.A.S.S.I/releases/latest/download/JASSI-macos.dmg), open it and drag **J.A.S.S.I** into **Applications**.
2. Open it once. macOS says it can't check the app: press **Done**, then go to **System Settings → Privacy & Security**, scroll down and press **Open Anyway**. (On macOS 14 or older: right-click the app → **Open**.)
3. If macOS says the app is **damaged**, run this in Terminal, then open it again:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/J.A.S.S.I.app"
   ```
4. Sign in with Google (it opens your browser and comes back to the app).
5. Allow **Microphone**, **Speech Recognition** and **Notifications** when asked. For screen control, turn J.A.S.S.I on under **System Settings → Privacy & Security → Accessibility**. After installing an update you may need to grant it again.

Payments are approved with Touch ID where the Mac has it. While J.A.S.S.I works another app, stop it with the **Stop** banner or **Control + Option + Esc**.

### Windows

> The Windows app is built automatically by GitHub and **has not been tested on a real PC yet**. If something fails, use the web app.

1. Download [JASSI-windows-setup.exe](https://github.com/Pulin-PC/J.A.S.S.I/releases/latest/download/JASSI-windows-setup.exe) and run it.
2. If **Windows protected your PC** appears, press **More info → Run anyway**.
3. Follow the installer, open **J.A.S.S.I** from the Start menu and sign in with Google.
4. Allow the microphone (**Settings → Privacy & security → Microphone**). Set up **Windows Hello** to approve payments with it.

Stop screen control with the **Stop** banner or **Ctrl + Alt + Esc**. J.A.S.S.I cannot click inside programs running as administrator.

### iPhone

**Quickest (no install):** open <https://jassi.pulin-chaudhari.workers.dev> in **Safari**, tap **Share → Add to Home Screen**. It opens like an app. Payments are approved by holding the on-screen button.

**Native app** (Face ID / Touch ID, Siri). Apple only allows installing it through Xcode or the App Store, so there is no file to download. You need a Mac with Xcode 16 or newer, a cable and an Apple ID (free works).

1. Get the code:
   ```bash
   git clone -b native-ios https://github.com/Pulin-PC/J.A.S.S.I.git jassi-ios
   ```
2. Open `jassi-ios/apps/ios/JASSI.xcodeproj` in Xcode.
3. Add your Apple ID under **Xcode → Settings → Accounts**. In the **JASSI** target's **Signing & Capabilities** tab, pick your **Team** and change the **Bundle Identifier** to something unique (for example `com.yourname.jassi`).
4. Connect the iPhone, turn on **Settings → Privacy & Security → Developer Mode** on it, choose it as the run destination and press **Run**.
5. If the app won't open, trust your certificate under **Settings → General → VPN & Device Management**.

With a free Apple ID the app stops opening after 7 days; press **Run** again to renew it. Apple does not let any iPhone app control other apps, so screen control is not available on iPhone. The app has been tested in the Simulator only.

---

## What works in this prototype

| Feature | What you see |
|---|---|
| **Acts mid-sentence** | A fast grammar parser reads your words *as you speak* and starts safe steps (open an app, search, set a timer) before you finish the sentence. Each one gets a **⚡ "1.4 s before you finished"** badge. Money never moves mid-sentence. |
| **Code Mode** | Several steps in one sentence become **one small script** that runs every tool call in a sandbox: no AI round trip per step. You watch the script run line by line. |
| **Safety guard (in code, not in a prompt)** | Reading → automatic. Messages you send yourself → app link, you tap Send. Anything that reaches other people → **Yes/No**. Payments under ₹5,000 → automatic. ₹5,000 or more, over the ₹10,000 daily limit, or started by something it *read* → **fingerprint**. Bank, UPI and ID apps → **locked**. |
| **Prompt-injection guard** | "Read my emails" flags the scam email that tries to give the AI orders. *Test the guard* shows what happens if the AI obeys it: the payment is stopped and needs your fingerprint. |
| **Official MCP connections** | In Settings → Apps → *More apps*, connect a company's own MCP server (Notion, Linear, Jira & Confluence, Zomato, Swiggy, Canva…) with your own login, or paste any MCP link. Every tool it offers passes the same guard: reading runs on its own, writing or sending asks first, anything that can spend needs your fingerprint. |
| **Gmail drafts and sending** | "Draft an email to Rahul saying…" leaves a real draft in your Gmail; nothing is sent. Sending always asks first. |
| **Screen control (native apps)** | Inside the desktop and Android apps, J.A.S.S.I can work apps that have no connection of their own: it reads the screen as text and taps for you, with a Stop banner. Bank, UPI, ID, password and system apps are locked; buttons that send or delete ask first; buttons that pay need your fingerprint. The interface the apps build against is `docs/native-contract.md`. |
| **MCP server** | Every J.A.S.S.I tool is also served over MCP at `/mcp`. Claude Code or any other MCP client gets **the same guard, approvals and diary**. |
| **Diary you own** | Every action (done, declined or blocked) is written as an Obsidian-style markdown note on your device: `data/diary/YYYY-MM-DD.md`. |
| **Business brief** | The first time you open it each day: sales vs monthly target (pace, with the working shown), orders and average order value, gross margin vs last week, complaints and returns, cash, overdue payments, low stock, quiet deals, meetings, and **3 next steps, one tap each**. |
| **Voice in and out** | Talk with the mic (Chrome speech recognition, en-IN). Replies are spoken back. Or type with *Like voice* on to watch mid-sentence actions without a mic. |
| **Thinking brain = Claude Code** | Questions and tasks the quick parser doesn't know go to **Claude Code running on your Mac** (your own login, no API key; Haiku 5.5, medium effort). One warm process, so answers are fast. It acts only through J.A.S.S.I's MCP tools, so the same guard checks everything. Once it has read an email or page, its payments need your fingerprint. |

### Honest notes (Round 1)
- **Payments are test mode**: a local ledger that follows the Razorpay / UPI Reserve Pay rules. No real money moves.
- **Swiggy/Zomato and business data use a demo menu and demo numbers** (`data/demo.json`). In the product these come from the companies' official MCP servers.
- WhatsApp, email, Maps, YouTube and search are **real links**: J.A.S.S.I fills them in and you tap the last button.
- Calendar events are stored locally and download as real `.ics` files.
- Code Mode from your sentence runs everywhere. Free-form scripts written by an AI client (`run_script`) run only in the local version (`node:vm` sandbox, prototype). Cloudflare Workers don't allow running new code at runtime.
- The brain runs on your Mac. If it's offline, everything except open questions still works.
- The native apps approve with the device's own fingerprint or face prompt. In a plain browser, or on a device with no sensor, it is a hold-to-approve button.

---

## Sign-in, setup and settings

- **Google sign-in, invite only.** The owner (set by `OWNER_EMAIL`) makes invite links in **⚙ Settings → Invites**. Nobody gets in without one.
- **Everyone gets their own private J.A.S.S.I**: their own apps, wallet, money rules, approvals and diary (one Durable Object per person).
- **First-time setup:** welcome → microphone and alerts → **connect your apps** (tick them; bank, UPI and ID apps stay locked) → **money rules** (sliders: auto-pay limit up to ₹5,000, daily limit) → try a first command.
- **Real Google Calendar and Gmail** once you press *Connect*: events go into your real calendar, and "read my emails" reads your real inbox (read-only; the scam check still applies).
- **⚙ Settings:** Account · Apps · Money rules · Brain (questions left today) · Voice · Invites (owner) · AI apps (your personal MCP link and key) · Diary & data.
- **Brain limits:** the owner has no limit; invited people get 30 questions a day. Each person gets their own Claude Code process, so conversations never mix.
- **Works on phones:** it's a web app. Use *Add to Home Screen* and it opens like an app.

## Run it

**Easiest:** open the live site, https://jassi.pulin-chaudhari.workers.dev, and sign in with Google (invite only).

**On your own computer** (no install, no dependencies). Needs **Node 20+** and **Chrome** (for voice).

```bash
git clone https://github.com/Pulin-PC/J.A.S.S.I.git
cd J.A.S.S.I
npm start
```

Open the address it prints in the terminal. Tap the glowing core (or press **Space**) and talk, or type a command.

`npm start` also starts the brain: Claude Code on this Mac with **your own login** (no API key). If Claude Code says you're logged out, run `claude` and type `/login`, or pin a long-lived token to your account with `zsh brain/link_claude.sh`. Model and effort: `JASSI_CLAUDE_MODEL` / `JASSI_CLAUDE_EFFORT` in `.env` (default Haiku 5.5, medium).

**Try:**
- `Order my usual and put the delivery time in my calendar and WhatsApp Riya the ETA`
- `Open YouTube and search for lofi beats and set a timer for 10 minutes`
- `Order lunch for the team` (₹6,840 → fingerprint)
- `Pay 250 to Rahul for chai` (auto)
- `Read my emails` (scam check) · `Open Google Pay` (locked) · `Send payment reminders` (needs your OK) · `Brief me`

### Hosted on Cloudflare

The same tools, guard and MCP code run on **Cloudflare Workers**. One **Durable Object** keeps the state, approvals, live updates and the diary (download it at `/api/diary.md`). The dashboard is served as static assets. No other database.

```bash
npx wrangler@4 login
npx wrangler@4 deploy
openssl rand -hex 24 | npx wrangler@4 secret put BRAIN_TOKEN   # private link for the brain
openssl rand -hex 32 | npx wrangler@4 secret put SESSION_SECRET  # signs sign-in cookies
npx wrangler@4 secret put GOOGLE_CLIENT_ID
npx wrangler@4 secret put GOOGLE_CLIENT_SECRET
npx wrangler@4 secret put OWNER_EMAIL                              # your Google email = owner
```

Then put `JASSI_CLOUD_URL=https://<your-worker>.workers.dev` and `JASSI_CLOUD_BRAIN_TOKEN=<same token>` in `.env`, and connect the brain from your Mac:

```bash
npm run brain:cloud
```

To start the brain by itself every time you log in to your Mac (macOS launchd): `zsh brain/autostart.sh` (turn off: `zsh brain/autostart.sh off`, log: `~/.jassi/brain.log`).

### Use J.A.S.S.I from Claude Code (MCP)

Sign in to the live site, open **⚙ Settings → AI apps**, and copy your personal command. It looks like this:

```bash
claude mcp add --transport http jassi https://jassi.pulin-chaudhari.workers.dev/mcp --header "Authorization: Bearer <your jk_ key from Settings>"
```

Then ask Claude Code to *"pay Aditi ₹6,000 for the hackathon parts using jassi"*. The fingerprint prompt pops up on the J.A.S.S.I dashboard, and Claude only gets the result after you approve.

### Tests

```bash
npm test
```

---

## How it works

```mermaid
flowchart LR
  V["You: voice or text"] --> P["Reflex parser<br/>(acts mid-sentence)"]
  V --> B["Thinking brain<br/>(Claude Code on your Mac)"]
  X["Any MCP client<br/>(Claude Code…)"] --> M["/mcp"]
  P --> G
  B -->|MCP| M
  P --> CM["Code Mode<br/>one script, many calls"]
  M --> G
  CM --> G{"Safety guard<br/>auto · yes/no · fingerprint · block"}
  G -->|needs OK| A["Approval on<br/>phone / dashboard"]
  A --> T
  G -->|auto| T["App plugs<br/>Swiggy · Calendar · WhatsApp · Gmail<br/>Maps · YouTube · J.A.S.S.I Pay · Business"]
  T --> D["Diary<br/>markdown on your device"]
  T --> R["Reply: voice + screen"]
```

| Folder | What's inside |
|---|---|
| `public/reflex.js` | The mid-sentence parser (runs in the browser and in Node). Splits a sentence into steps, decides which can start early, marks steps that depend on an earlier result. |
| `public/app.js`, `app.css`, `index.html` | The HUD: live speech, stability timer, action feed, Code Mode view, approvals, brief, timers. |
| `server/guard.js` | The safety guard. All the rules live here. |
| `server/tools.js` | The app plugs and `call()`, the single door every action goes through (guard → your OK → run → diary). |
| `server/codemode.js` | Builds Code Mode scripts from your sentence and runs them. |
| `server/sandbox.js` | Free-form Code Mode scripts in a `node:vm` sandbox (local only). |
| `server/brain.js` | Hands questions to the Claude Code brain and waits for its answer. |
| `brain/bridge.js` | The brain: one warm Claude Code process on your Mac (your login), acting through J.A.S.S.I's MCP tools. |
| `server/mcp.js` | MCP server (Streamable HTTP, JSON-RPC). |
| `server/api.js`, `server/runtime.js` | API routes and shared runtime used by both hosts. |
| `server/store.js`, `server/index.js` | Local host: files on your device, Node server. |
| `worker/index.js`, `wrangler.jsonc` | Cloudflare host: Worker + Durable Object. |
| `data/demo.json` | Demo contacts, menu, emails and business numbers. |

**How "mid-sentence" works:** every time the speech engine sends new words, the whole sentence is parsed again into clauses (`open youtube` | `search for lofi beats` | `set a timer…`). A clause starts as soon as it is safe:
- **finished clauses** (you have moved on: "… and \<verb\>") start right away;
- **the clause you're still saying** starts early only if it isn't free text and its meaning has held steady for 140 ms;
- **free text** ("saying …", "search …") waits until the clause ends;
- **money and dependent steps** ("the ETA") wait for the end of the sentence and run together as one Code Mode script.

## What's next (final round)
Real official MCP plugs (Swiggy, Zomato, Google, Razorpay test keys), signed store builds, approvals sent to your phone (AWS relay), ElevenLabs voice, and Graphify memory over the diary.

---
MIT licence · Built for wHACKiest 2026 (CodeRIT, Ramaiah Institute of Technology).
