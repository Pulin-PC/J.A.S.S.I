// Sign-in screen, first-time setup (onboarding) and Settings. Plain words everywhere.
import { native, nativeAuth } from "./native.js";
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
    let ctl;
    if (locked) ctl = `<span class="lock">🔒 Locked</span>`;
    else if (g) ctl = gOn ? `<button class="mini" data-gdis="${a.id}">Disconnect</button>` : `<button class="mini on" data-gcon="${a.id}">Connect</button>`;
    else ctl = `<label class="switch"><input type="checkbox" data-app="${a.id}" ${isOn ? "checked" : ""}><i></i></label>`;
    const note = locked ? esc(a.how.replace("Blocked: ", "")) + ". Payments go through J.A.S.S.I Pay."
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
  if (id === "allow") body.innerHTML = `
    <div class="ob-kick">Step 2 of 5</div><h2>Let me hear you</h2>
    <p class="ob-lead">These are optional. You can always type instead.</p>
    <div class="perm"><span><b>🎙 Microphone</b><small>So you can talk to me. I only listen after you tap the core or press Space.</small></span><button class="mini" id="p-mic">Allow</button></div>
    <div class="perm"><span><b>🔔 Alerts</b><small>For timers, reminders, and payments that need your OK.</small></span><button class="mini" id="p-notif">Allow</button></div>
    <div class="perm"><span><b>🔊 Talk back</b><small>I say my answers out loud.</small></span><label class="switch"><input type="checkbox" id="p-voice" ${ctx.prefs.talkBack() ? "checked" : ""}><i></i></label></div>`;
  if (id === "apps") { body.innerHTML = `<div class="ob-kick">Step 3 of 5</div><h2>Connect your apps</h2><p class="ob-lead">Tick the apps you use. I can only touch the ones you turn on. Change this any time in Settings.</p><div id="ob-apps"></div>`; appTiles($("#ob-apps")); }
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
    ${S.host === "cloudflare" ? `<div class="set-row"><span>Sign out<small>On this device.</small></span><a class="mini" href="/auth/logout">Sign out</a></div>` : ""}`;
  if (tab === "apps") { el.innerHTML = `<p class="set-lead">I can only use the apps you turn on here. Locked apps can never be turned on.</p><div id="st-apps"></div>`; appTiles($("#st-apps")); }
  if (tab === "money") { el.innerHTML = `<p class="set-lead">Checked in code before every payment. Test mode: no real money moves.</p><div id="st-money"></div>`; moneyRules($("#st-money")); }
  if (tab === "brain") {
    const b = S.brain || {};
    el.innerHTML = `<div class="set-row"><span>Thinking brain<small>Claude Code, running on the owner's Mac. It answers questions and handles tasks the quick parser doesn't know.</small></span><span class="pill ${b.on ? "on" : "warn"}"><b></b>${b.on ? "Online" : "Offline"}</span></div>
      <div class="set-row"><span>Questions left today<small>${b.limit ? `Invited people get ${b.limit} a day.` : "The owner has no daily limit."}</small></span><b class="big-n">${b.left == null ? "∞" : b.left}</b></div>
      <div class="set-row"><span>Works without the brain<small>Direct commands, Code Mode, payments, the brief and the diary all keep working when the brain is offline.</small></span></div>`;
  }
  if (tab === "voice") {
    el.innerHTML = [
      ["talk", "Talk back", "Say my answers out loud.", ctx.prefs.talkBack()],
      ["sim", "Type like you talk", "Typed commands arrive word by word, so you see steps start mid-sentence.", $("#sim").checked],
      ["open", "Open apps by themselves", "WhatsApp, Maps and YouTube open in a new tab when ready. Your browser may ask you to allow pop-ups.", LS.get("jassi.autoOpen") !== "off"],
    ].map(([id, t, d, on]) => `<div class="set-row"><span>${t}<small>${d}</small></span><label class="switch"><input type="checkbox" data-pref="${id}" ${on ? "checked" : ""}><i></i></label></div>`).join("");
    el.onchange = e => {
      const k = e.target.dataset.pref; if (!k) return;
      if (k === "talk") ctx.prefs.setTalkBack(e.target.checked);
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
