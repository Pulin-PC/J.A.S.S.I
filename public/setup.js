// Sign-in screen, first-time setup (onboarding) and Settings. Plain words everywhere.
import { native, nativeAuth, authChallenge, onNative } from "./native.js";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const inr = n => "₹" + Math.round(n).toLocaleString("en-IN");
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(r => r.json());
const LS = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let ctx = null;   // { getS, refresh, toast, runText, prefs }
export function initSetup(c) { ctx = c; }

// ================================================================ sign in
export function showSignin(info) {
  const q = new URLSearchParams(location.search);
  $("#signin").hidden = false;
  $("#boot").classList.add("gone");
  const inv = info.invite;
  if (inv) {
    $("#signin-invite").hidden = false;
    $("#signin-invite").textContent = inv.valid ? `You're invited${inv.label ? " (" + inv.label + ")" : ""}. Sign in to get your own J.A.S.S.I.` : "This invite link is used up or switched off. Ask for a new one.";
  }
  if (!info.google) { $("#google-btn").classList.add("off"); $("#google-btn").removeAttribute("href"); $("#google-btn").lastChild.textContent = "Google sign-in is being set up"; }
  $("#dev-login").hidden = !info.dev;
  if (native) $("#google-btn").onclick = e => { e.preventDefault(); if (info.google) nativeAuth("/auth/google/start"); };
  const err = q.get("error");
  if (err) { $("#signin-error").hidden = false; $("#signin-error").textContent = err; }
}

// ================================================================ shared pieces: app tiles + money rules
const ICON = { swiggy: "S", zomato: "Z", calendar: "📅", gmail: "✉", whatsapp: "W", maps: "M", youtube: "▶", razorpay: "₹", books: "B" };

export function appTiles(el) {
  const S = ctx.getS();
  const on = S.settings.apps || {};
  const google = S.google || {};
  el.innerHTML = `<div class="tiles">${S.apps.map(a => {
    const locked = a.tier === "blocked";
    const g = google.available && (a.id === "calendar" || a.id === "gmail");
    const gOn = g && google[a.id];
    const isOn = !!on[a.id];
    const readOnly = gOn && a.id === "gmail" && !google.gmailWrite;   // connected before J.A.S.S.I could write drafts
    let ctl;
    if (locked) ctl = `<span class="lock">🔒 Locked</span>`;
    else if (g) ctl = readOnly ? `<button class="mini on" data-gcon="${a.id}">Reconnect</button>` : gOn ? `<button class="mini" data-gdis="${a.id}">Disconnect</button>` : `<button class="mini on" data-gcon="${a.id}">Connect</button>`;
    else ctl = `<label class="switch"><input type="checkbox" data-app="${a.id}" ${isOn ? "checked" : ""}><i></i></label>`;
    const note = locked ? esc(a.how.replace("Blocked: ", "")) + ". Payments go through J.A.S.S.I Pay."
      : readOnly ? "Reading only. Reconnect so I can write drafts, and send when you say yes."
      : g ? (gOn ? `✓ Your real ${a.name}${google.email ? " · " + esc(google.email) : ""}` : `Your real ${a.name}, with your Google account`)
      : esc(a.how) + (["swiggy", "zomato", "books", "razorpay"].includes(a.id) ? " · demo data" : "");
    return `<div class="tile ${locked ? "locked" : ""} ${isOn || gOn ? "is-on" : ""}"><span class="t-ic">${ICON[a.id] || esc(a.name[0])}</span><span class="t-txt"><b>${esc(a.name)}</b><small>${note}</small></span>${ctl}</div>`;
  }).join("")}</div>
  <button class="ghost small" id="tiles-all">Turn on all the safe ones</button>`;
  el.onchange = async e => {
    const id = e.target.dataset.app;
    if (!id) return;
    await post("/api/settings", { apps: { [id]: e.target.checked } });
    await ctx.refresh(); appTiles(el);
  };
  el.onclick = async e => {
    if (e.target.id === "tiles-all") {
      const apps = {};
      for (const a of S.apps) if (a.tier !== "blocked" && !(google.available && (a.id === "calendar" || a.id === "gmail"))) apps[a.id] = true;
      await post("/api/settings", { apps }); await ctx.refresh(); appTiles(el); return;
    }
    const con = e.target.dataset.gcon, dis = e.target.dataset.gdis;
    if (con) {
      LS.set("jassi.return", $("#onboard").hidden ? "settings" : "onboard");
      if (!native) location.href = "/auth/google/start?connect=" + con;
      else { const { ticket } = await fetch("/api/auth/ticket").then(r => r.json()); nativeAuth(`/auth/google/start?connect=${con}&ticket=${encodeURIComponent(ticket)}`); }
    }
    if (dis) { await post("/api/google/disconnect", { which: dis }); await ctx.refresh(); appTiles(el); ctx.toast("Disconnected", `${dis === "gmail" ? "Gmail" : "Google Calendar"} is no longer connected.`); }
  };
}

// ---- official connections: the company's own MCP server, with your own login (the way Claude's connectors work)
async function connectMcp(body, btn) {
  if (btn) btn.textContent = "Connecting…";
  LS.set("jassi.return", $("#onboard").hidden ? "settings" : "onboard");
  const r = await post("/api/mcp/connect", { ...body, app: native ? await authChallenge() : "" });
  if (r.authUrl) return void (native ? native.openExternal(r.authUrl) : (location.href = r.authUrl));   // sign in there, then come back
  LS.set("jassi.return", "");
  await ctx.refresh();
  ctx.toast(r.ok ? "Connected" : "Not connected", r.ok ? `${r.connected} is connected.` : r.say || "Please try again.");
}
export function moreApps(el) {
  const C = ctx.getS().connections || { official: [], servers: [] };
  const mine = Object.fromEntries(C.servers.map(s => [s.id, s]));
  const row = (id, name, s, official) => `<div class="tile ${s && !s.needsLogin ? "is-on" : ""}"><span class="t-ic">${esc(name[0])}</span><span class="t-txt"><b>${esc(name)}</b><small>${
    s ? (s.needsLogin ? "Please sign in again" : `✓ Connected · it can do ${s.tools.length} things`) : "Official connection · sign in with your own account"}</small></span>${
    s && !(s.needsLogin && official) ? `<button class="mini" data-mdis="${esc(id)}">Disconnect</button>` : `<button class="mini on" data-mcon="${esc(id)}">${s ? "Sign in" : "Connect"}</button>`}</div>`;
  el.innerHTML = `<h4 class="tiles-h">More apps <small>the company's own connection, with your own login</small></h4>
    <div class="tiles">${C.official.map(o => row(o.id, o.name, mine[o.id], true)).join("")}${C.servers.filter(s => !C.official.some(o => o.id === s.id)).map(s => row(s.id, s.name, s, false)).join("")}</div>
    <div class="inv-new"><input id="mcp-url" placeholder="Have a connection link (MCP)? Paste it here" inputmode="url" maxlength="300"><button class="mini on" id="mcp-add">Connect</button></div>
    <p class="ob-foot">Reading runs on its own. Anything that writes or sends asks you first. Anything that can spend needs your fingerprint.</p>`;
  el.onclick = async e => {
    const t = e.target;
    if (t.dataset.mcon) { await connectMcp({ id: t.dataset.mcon }, t); moreApps(el); }
    if (t.dataset.mdis) { await post("/api/mcp/disconnect", { id: t.dataset.mdis }); await ctx.refresh(); moreApps(el); }
    if (t.id === "mcp-add" && $("#mcp-url").value.trim()) { await connectMcp({ url: $("#mcp-url").value.trim() }, t); moreApps(el); }
  };
}

// ---- apps found on this device (native apps only). The server sorts them; locked ones can never be turned on.
const PLATFORM_NAME = { android: "phone", ios: "iPhone", macos: "Mac", windows: "PC" };
export async function scanDevice() {
  if (!native) return null;
  const r = await native.listApps().catch(() => null);
  if (!r?.ok) return null;
  const d = await post("/api/device/apps", { platform: native.platform, partial: !!r.partial, apps: (r.apps || []).map(a => ({ id: a.id, name: a.name })) });
  await ctx.refresh();
  native.setPolicy({ blockedApps: (d.scan?.apps || []).filter(a => a.tier === "locked").map(a => a.id) });   // the device refuses these too
  return d.scan;
}
export function deviceApps(el) {
  if (!native) { el.innerHTML = ""; return; }
  const S = ctx.getS(), scan = S.scan, where = PLATFORM_NAME[native.platform] || "device";
  if (!scan) { el.innerHTML = `<h4 class="tiles-h">On this ${where}</h4><p class="ob-foot" id="dev-scan-msg">Looking at the apps on this ${where}…</p>`; scanDevice().then(sc => sc ? deviceApps(el) : ($("#dev-scan-msg").textContent = `I couldn't read the app list on this ${where}.`)); return; }
  const on = S.settings.screenApps || {}, builtIn = Object.fromEntries(S.apps.map(a => [a.id, a.name]));
  const rows = scan.apps.filter(a => a.tier !== "skip"), hidden = scan.apps.length - rows.length;
  const canScreen = native.platform !== "ios";
  el.innerHTML = `<h4 class="tiles-h">On this ${where} <small>${scan.apps.length} apps found${scan.partial ? " (iPhones only let me see well-known apps)" : ""}</small></h4>
    <div class="tiles">${rows.map(a => {
      const locked = a.tier === "locked", off = a.tier === "avoid";
      const ctl = locked ? `<span class="lock">🔒 Locked</span>` : off ? `<span class="lock">Not offered</span>`
        : a.mcp ? (S.connections?.servers.some(x => x.id === a.mcp) ? `<span class="pill-s">✓ Connected</span>` : `<button class="mini on" data-mcon="${esc(a.mcp)}">Connect</button>`)
        : a.plug ? `<span class="pill-s">${esc(builtIn[a.plug] || "Built in")} ↑</span>`
        : `<label class="switch"><input type="checkbox" data-screen="${esc(a.id)}" ${on[a.id] !== false ? "checked" : ""}><i></i></label>`;
      const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
      const note = locked ? esc(cap(a.how.replace("Locked: ", ""))) + ". I never open these." : a.mcp ? "Official connection · sign in with your own account" : a.plug ? "Uses the connection above" : esc(a.how);
      return `<div class="tile ${locked || off ? "locked" : ""} ${on[a.id] !== false ? "is-on" : ""}"><span class="t-ic">${esc(a.name[0] || "?")}</span><span class="t-txt"><b>${esc(a.name)}</b><small>${note}</small></span>${ctl}</div>`;
    }).join("")}</div>
    <p class="ob-foot">${canScreen ? "For apps with a switch, I work the app on your screen, the way you would. You see a banner while I work and can stop me any time. Buttons that send, delete or pay always ask you first." : ""}${hidden ? ` ${hidden} other ${hidden === 1 ? "app isn't" : "apps aren't"} shown.` : ""}</p>
    <button class="ghost small" id="dev-rescan">Look again</button>`;
  el.onchange = async e => {
    const id = e.target.dataset.screen;
    if (!id) return;
    await post("/api/settings", { screenApps: { [id]: e.target.checked } });
    await ctx.refresh(); deviceApps(el);
  };
  el.onclick = async e => {
    if (e.target.id === "dev-rescan") { e.target.textContent = "Looking…"; await scanDevice(); deviceApps(el); }
    if (e.target.dataset.mcon) { await connectMcp({ id: e.target.dataset.mcon }, e.target); deviceApps(el); }
  };
}

// ---- permissions inside a native app: one button each, and the row ticks itself when the permission arrives
const PERMS = [
  ["screen", "👆 See and tap your screen", "So I can work in apps that have no connection of their own. A banner shows while I work and you can stop me any time. Bank, UPI, ID and password apps stay locked.", "Open Settings"],
  ["mic", "🎙 Microphone", "So you can talk to me. I only listen after you tap the core.", "Allow"],
  ["speech", "🗣 Understand speech", "Turns what you say into words.", "Allow"],
  ["notifications", "🔔 Alerts", "For timers, reminders, and things that need your OK.", "Allow"],
];
let permWait = "";   // the permission the user just went to switch on
function nativePerms(el, perms) {
  el.innerHTML = PERMS.filter(([k]) => perms[k] && perms[k] !== "unsupported").map(([k, t, d, btn]) =>
    `<div class="perm"><span><b>${t}</b><small>${d}</small></span>${perms[k] === "granted" ? `<button class="mini on" disabled>✓ Allowed</button>` : `<button class="mini" data-perm="${k}">${btn}</button>`}</div>`).join("");
  el.onclick = e => { const k = e.target.dataset.perm; if (!k) return; permWait = k; e.target.textContent = "Waiting…"; native.openPermission(k); };
}
onNative("permission", d => {
  const el = $("#ob-perms") || $("#st-perms");
  if (!el || !d.permissions) return;
  nativePerms(el, d.permissions);
  if (permWait === "screen" && d.permissions.screen === "granted" && $("#ob-perms")) { permWait = ""; step++; renderStep(); }   // setup moves on by itself
  else if (d.permissions[permWait] === "granted") permWait = "";
});

export function moneyRules(el) {
  const S = ctx.getS();
  const st = S.settings;
  el.innerHTML = `
    <div class="rule">
      <div class="rule-top"><span>Pay on its own when it's under</span><b id="r-auto">${inr(st.autoPayUnder)}</b></div>
      <input type="range" id="s-auto" min="0" max="5000" step="250" value="${st.autoPayUnder}">
      <small>Anything this much or more needs your fingerprint. Set it to ₹0 to approve every payment yourself. It can't go above ₹5,000.</small>
    </div>
    <div class="rule">
      <div class="rule-top"><span>Most it can spend in a day</span><b id="r-cap">${inr(st.dailyCap)}</b></div>
      <input type="range" id="s-cap" min="1000" max="50000" step="1000" value="${st.dailyCap}">
      <small>After this, every payment needs your fingerprint, whatever the amount.</small>
    </div>
    <div class="rule fixed"><span>🔒 Always on, can't be switched off</span><small>Messages to other people ask you first · Bank, UPI and ID apps stay locked · Instructions hidden in emails and websites are ignored</small></div>`;
  const save = async () => { await post("/api/settings", { autoPayUnder: +$("#s-auto").value, dailyCap: +$("#s-cap").value }); await ctx.refresh(); };
  $("#s-auto").oninput = e => $("#r-auto").textContent = inr(e.target.value);
  $("#s-cap").oninput = e => $("#r-cap").textContent = inr(e.target.value);
  $("#s-auto").onchange = save; $("#s-cap").onchange = save;
}

// ================================================================ first-time setup
const STEPS = ["hello", "allow", "apps", "money", "done"];
let step = 0;
export function openOnboarding(at = 0) {
  step = at;
  $("#onboard").hidden = false;
  renderStep();
}
function renderStep() {
  const S = ctx.getS();
  const first = (S.me?.name || "there").split(" ")[0];
  $("#ob-dots").innerHTML = STEPS.map((_, i) => `<i class="${i === step ? "on" : i < step ? "done" : ""}"></i>`).join("");
  $("#ob-back").style.visibility = step ? "visible" : "hidden";
  $("#ob-next").textContent = step === STEPS.length - 1 ? "Start using J.A.S.S.I" : step === 0 ? "Let's go" : "Next";
  const body = $("#ob-body");
  const id = STEPS[step];
  if (id === "hello") body.innerHTML = `
    <div class="ob-kick">Step 1 of 5</div><h2>Hi ${esc(first)}. I'm J.A.S.S.I.</h2>
    <p class="ob-lead">I do things in your apps when you ask, out loud or by typing. Setup takes about a minute.</p>
    <ul class="ob-list"><li><b>Talk normally.</b> "Order my usual and tell Riya when it arrives."</li><li><b>I start while you're still talking</b>, so simple things are done before you finish.</li><li><b>You stay in charge.</b> Money and messages to other people always ask you first.</li></ul>`;
  if (id === "allow" && native) {
    body.innerHTML = `<div class="ob-kick">Step 2 of 5</div><h2>Let me help in your apps</h2>
      <p class="ob-lead">Each one is your choice. Tap the button and I'll take you to the right place.</p>
      <div id="ob-perms"></div>
      <div class="perm"><span><b>🔊 Talk back</b><small>I say my answers out loud.</small></span><label class="switch"><input type="checkbox" id="p-voice" ${ctx.prefs.talkBack() ? "checked" : ""}><i></i></label></div>`;
    native.permissions().then(p => $("#ob-perms") && nativePerms($("#ob-perms"), p));
  } else if (id === "allow") body.innerHTML = `
    <div class="ob-kick">Step 2 of 5</div><h2>Let me hear you</h2>
    <p class="ob-lead">These are optional. You can always type instead.</p>
    <div class="perm"><span><b>🎙 Microphone</b><small>So you can talk to me. I only listen after you tap the core or press Space.</small></span><button class="mini" id="p-mic">Allow</button></div>
    <div class="perm"><span><b>🔔 Alerts</b><small>For timers, reminders, and payments that need your OK.</small></span><button class="mini" id="p-notif">Allow</button></div>
    <div class="perm"><span><b>🔊 Talk back</b><small>I say my answers out loud.</small></span><label class="switch"><input type="checkbox" id="p-voice" ${ctx.prefs.talkBack() ? "checked" : ""}><i></i></label></div>`;
  if (id === "apps") { body.innerHTML = `<div class="ob-kick">Step 3 of 5</div><h2>Connect your apps</h2><p class="ob-lead">Tick the apps you use. I can only touch the ones you turn on. Change this any time in Settings.</p><div id="ob-apps"></div><div id="ob-more"></div><div id="ob-dev"></div>`; appTiles($("#ob-apps")); moreApps($("#ob-more")); deviceApps($("#ob-dev")); }
  if (id === "money") { body.innerHTML = `<div class="ob-kick">Step 4 of 5</div><h2>Set your money rules</h2><p class="ob-lead">Payments are in test mode, so no real money moves. These rules are checked in code, every time.</p><div id="ob-money"></div>`; moneyRules($("#ob-money")); }
  if (id === "done") {
    const tries = ["Order my usual and put the delivery time in my calendar and WhatsApp Riya the ETA", "Open YouTube and search for lofi beats and set a timer for 10 minutes", "Brief me"];
    body.innerHTML = `<div class="ob-kick">Step 5 of 5</div><h2>You're all set, ${esc(first)}.</h2>
      <p class="ob-lead">Tap the glowing core, or press Space, and talk. Or pick one to try now:</p>
      <div class="ob-try">${tries.map(t => `<button class="step-btn" data-try="${esc(t)}"><b>▶</b>${esc(t)}</button>`).join("")}</div>
      <p class="ob-foot">Settings (⚙, top right) is where you add apps, change money rules and see your diary.</p>`;
  }
  const mic = $("#p-mic"), notif = $("#p-notif"), voice = $("#p-voice");
  if (mic) mic.onclick = async () => { try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); mic.textContent = "✓ Allowed"; mic.classList.add("on"); } catch { mic.textContent = "Blocked: allow it in the browser"; } };
  if (notif) notif.onclick = async () => { try { const p = await Notification.requestPermission(); notif.textContent = p === "granted" ? "✓ Allowed" : "Not allowed"; if (p === "granted") notif.classList.add("on"); } catch { notif.textContent = "Not available here"; } };
  if (voice) voice.onchange = () => ctx.prefs.setTalkBack(voice.checked);
  body.querySelectorAll("[data-try]").forEach(b => b.onclick = () => finish(b.dataset.try));
}
async function finish(tryText) {
  await post("/api/settings", { onboarded: true });
  $("#onboard").hidden = true;
  LS.set("jassi.briefDay", new Date().toDateString());
  await ctx.refresh();
  ctx.ready();
  if (tryText) setTimeout(() => ctx.runText(tryText), 400);
}
$("#ob-next").onclick = () => { if (step >= STEPS.length - 1) return finish(); step++; renderStep(); };
$("#ob-back").onclick = () => { if (step > 0) { step--; renderStep(); } };

// ================================================================ settings
const TABS = [
  ["account", "Account"], ["apps", "Apps"], ["money", "Money rules"], ["brain", "Brain"], ["voice", "Voice"],
  ["invites", "Invites"], ["ai", "AI apps (MCP)"], ["data", "Diary & data"],
];
export function openSettings(tab = "account") {
  const S = ctx.getS();
  const tabs = TABS.filter(([id]) => id !== "invites" || (S.host === "cloudflare" && S.me?.role === "owner"));
  $("#settings").hidden = false;
  $("#settings-tabs").innerHTML = tabs.map(([id, l]) => `<button data-tab="${id}" class="${id === tab ? "on" : ""}">${l}</button>`).join("");
  $("#settings-tabs").onclick = e => { const b = e.target.closest("[data-tab]"); if (b) openSettings(b.dataset.tab); };
  const el = $("#settings-body");
  el.onclick = el.onchange = null;
  const me = S.me || {};
  if (tab === "account") el.innerHTML = `
    <div class="acct">${me.picture ? `<img src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="acct-i">${esc((me.name || "?")[0])}</span>`}
      <div><b>${esc(me.name || "You")}</b><small>${esc(me.email || (S.host === "node" ? "Running on this computer" : ""))}</small><span class="badge">${me.role === "owner" ? "Owner" : "Invited"}</span></div></div>
    <div class="set-row"><span>Run the setup again<small>Apps, money rules, permissions.</small></span><button class="mini" id="st-rerun">Start setup</button></div>
    ${S.host === "cloudflare" ? `<div class="set-row"><span>Sign out<small>On this device.</small></span><a class="mini" href="/auth/logout" id="st-signout">Sign out</a></div>` : ""}`;
  if (tab === "apps") { el.innerHTML = `<p class="set-lead">I can only use the apps you turn on here. Locked apps can never be turned on.</p><div id="st-apps"></div><div id="st-more"></div><div id="st-dev"></div>${native ? `<h4 class="tiles-h">Permissions</h4><div id="st-perms"></div>` : ""}`; appTiles($("#st-apps")); moreApps($("#st-more")); deviceApps($("#st-dev")); if (native) native.permissions().then(p => $("#st-perms") && nativePerms($("#st-perms"), p)); }
  if (tab === "money") { el.innerHTML = `<p class="set-lead">Checked in code before every payment. Test mode: no real money moves.</p><div id="st-money"></div>`; moneyRules($("#st-money")); }
  if (tab === "brain") {
    const b = S.brain || {};
    el.innerHTML = `<div class="set-row"><span>Thinking brain<small>Claude Code, running on the owner's Mac. It answers questions and handles tasks the quick parser doesn't know.</small></span><span class="pill ${b.on ? "on" : "warn"}"><b></b>${b.on ? "Online" : "Offline"}</span></div>
      <div class="set-row"><span>Questions left today<small>${b.limit ? `Invited people get ${b.limit} a day.` : "The owner has no daily limit."}</small></span><b class="big-n">${b.left == null ? "∞" : b.left}</b></div>
      <div class="set-row"><span>Works without the brain<small>Direct commands, Code Mode, payments, the brief and the diary all keep working when the brain is offline.</small></span></div>`;
  }
  if (tab === "voice") {
    el.innerHTML = [
      ["wake", "Say “Jassi” to talk", "I listen for my name, then keep listening 5 seconds after I answer so you can just keep talking. After 5 quiet seconds I wait for “Jassi” again.", ctx.prefs.handsFree()],
      ["talk", "Talk back", "Say my answers out loud.", ctx.prefs.talkBack()],
      ["sim", "Type like you talk", "Typed commands arrive word by word, so you see steps start mid-sentence.", $("#sim").checked],
      ["open", "Open apps by themselves", "WhatsApp, Maps and YouTube open in a new tab when ready. Your browser may ask you to allow pop-ups.", LS.get("jassi.autoOpen") !== "off"],
    ].map(([id, t, d, on]) => `<div class="set-row"><span>${t}<small>${d}</small></span><label class="switch"><input type="checkbox" data-pref="${id}" ${on ? "checked" : ""}><i></i></label></div>`).join("");
    el.onchange = e => {
      const k = e.target.dataset.pref; if (!k) return;
      if (k === "talk") ctx.prefs.setTalkBack(e.target.checked);
      if (k === "wake") ctx.prefs.setHandsFree(e.target.checked);
      if (k === "sim") { $("#sim").checked = e.target.checked; LS.set("jassi.sim", e.target.checked ? "on" : "off"); }
      if (k === "open") LS.set("jassi.autoOpen", e.target.checked ? "on" : "off");
    };
    return;
  }
  if (tab === "invites") { el.onchange = null; return invites(el); }   // these tabs set their own click handlers
  if (tab === "ai") { el.onclick = el.onchange = null; return aiApps(el, S); }
  if (tab === "data") el.innerHTML = `
    <div class="set-row"><span>Today's diary<small>Every action I took, as a markdown note (works in Obsidian). ${esc(S.diaryDir || "")}</small></span><a class="mini" href="/api/diary.md" download="jassi-diary.md">Download</a></div>
    <div class="set-row"><span>Start over with fresh demo data<small>Clears orders, payments, events and timers. Keeps your apps and money rules.</small></span><button class="mini danger" id="st-reset">Reset</button></div>`;
  el.onclick = async e => {
    if (e.target.id === "st-rerun") { closeSettings(); openOnboarding(1); }
    if (e.target.id === "st-signout" && native) { e.preventDefault(); await ctx.unpair(); location.href = "/auth/logout"; }
    if (e.target.id === "st-reset") {
      if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "Tap again to reset"; return; }
      await post("/api/reset"); await ctx.refresh(); ctx.toast("Fresh start", "Demo data is reset."); e.target.textContent = "Done"; e.target.dataset.sure = "";
    }
  };
}
export function closeSettings() { $("#settings").hidden = true; }
$("#settings-x").onclick = closeSettings;
$("#settings").onclick = e => { if (e.target.id === "settings") closeSettings(); };

async function invites(el) {
  el.innerHTML = `<p class="set-lead">J.A.S.S.I is invite only. Make a link, send it, and that person signs in with Google to get their own private J.A.S.S.I.</p>
    <div class="inv-new"><input id="inv-label" placeholder="Who is it for? e.g. Judges" maxlength="60"><input id="inv-max" type="number" min="1" max="100" value="5" title="How many people can use it"><button class="mini on" id="inv-make">Make link</button></div>
    <div id="inv-list" class="inv-list">Loading…</div>`;
  const load = async () => {
    const d = await fetch("/api/invites").then(r => r.json());
    const link = c => `${location.origin}/join/${c}`;
    $("#inv-list").innerHTML = (d.invites || []).map(i => `<div class="inv ${i.active ? "" : "off"}"><span><b>${esc(i.label)}</b><small>${i.uses} of ${i.maxUses} used · ${link(i.code)}</small></span>
      <button class="mini" data-copy="${link(i.code)}">Copy</button><label class="switch" title="On/off"><input type="checkbox" data-inv="${i.code}" ${i.active ? "checked" : ""}><i></i></label></div>`).join("") || "<small>No invites yet.</small>";
    $("#inv-list").insertAdjacentHTML("beforeend", (d.users || []).length ? `<h4>People with access</h4>` + d.users.map(u => `<div class="inv"><span><b>${esc(u.name)}</b><small>${esc(u.email)} · ${u.role === "owner" ? "Owner" : "Invited"}</small></span></div>`).join("") : "");
  };
  el.onclick = async e => {
    if (e.target.id === "inv-make") {
      const r = await post("/api/invites", { label: $("#inv-label").value || "Invite", maxUses: +$("#inv-max").value || 5 });
      const l = `${location.origin}/join/${r.invite.code}`;
      try { await navigator.clipboard.writeText(l); ctx.toast("Invite link copied", l); } catch { ctx.toast("Invite link", l); }
      $("#inv-label").value = ""; load();
    }
    if (e.target.dataset.copy) { try { await navigator.clipboard.writeText(e.target.dataset.copy); e.target.textContent = "Copied"; } catch {} }
  };
  el.onchange = async e => { if (e.target.dataset.inv) { await post("/api/invites/toggle", { code: e.target.dataset.inv, active: e.target.checked }); load(); } };
  load();
}

async function aiApps(el, S) {
  if (S.host !== "cloudflare") {
    el.innerHTML = `<p class="set-lead">Let another AI app (Claude Code, Claude Desktop…) use your J.A.S.S.I. It gets the same safety guard: anything risky still pops up here for your OK.</p>
      <pre class="cmd-box">claude mcp add --transport http jassi ${esc(location.origin)}/mcp</pre>`;
    return;
  }
  const show = d => {
    const cmd = `claude mcp add --transport http jassi ${d.url} --header "Authorization: Bearer ${d.key}"`;
    el.innerHTML = `<p class="set-lead">Let another AI app (Claude Code, Claude Desktop…) use your J.A.S.S.I. It gets the same safety guard: anything risky still pops up here for your OK. Keep this key private, like a password.</p>
      <div class="set-row"><span>Your MCP link<small>${esc(d.url)}</small></span></div>
      <pre class="cmd-box" id="mcp-cmd">${esc(cmd)}</pre>
      <div class="set-row"><button class="mini on" id="mcp-copy">Copy command</button><button class="mini danger" id="mcp-regen">Make a new key (the old one stops working)</button></div>`;
    $("#mcp-copy").onclick = async () => { try { await navigator.clipboard.writeText(cmd); $("#mcp-copy").textContent = "Copied"; } catch {} };
    $("#mcp-regen").onclick = async () => show(await post("/api/mcpkey", { regen: true }));
  };
  el.innerHTML = "Loading…";
  show(await fetch("/api/mcpkey").then(r => r.json()));
}
