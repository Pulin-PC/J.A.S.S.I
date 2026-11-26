// J.A.S.S.I dashboard: live speech -> reflex parser (mid-sentence) -> server tools (through the safety guard).
import { Parser, STABLE_MS } from "./reflex.js";
import { initSetup, showSignin, openOnboarding, openSettings, closeSettings } from "./setup.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const inr = n => "₹" + Math.round(n).toLocaleString("en-IN");
const hhmm = ts => new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(r => r.json());
const LS = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let S = null;                 // server snapshot
let parser = new Parser();
const stats = { early: 0, fired: 0, times: [], actions: 0, blocked: 0 };
let talkBack = LS.get("jassi.voice") !== "off";

// ================================================================ sound (generated, no files)
let AC = null;
function beep(freqs, dur = .07, type = "sine", vol = .05) {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    let t = AC.currentTime;
    for (const f of [].concat(freqs)) {
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = type; o.frequency.value = f; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.connect(g).connect(AC.destination); o.start(t); o.stop(t + dur + .02); t += dur * .8;
    }
  } catch {}
}
const sfx = { fire: () => beep([1320, 1760], .05), ok: () => beep([880, 1320], .08), no: () => beep([220, 160], .12, "square", .03), alert: () => beep([660, 990, 660], .1, "triangle", .06), ring: () => beep([880, 0, 880, 0, 880], .15, "square", .04) };

// ================================================================ talk back (speech synthesis)
let voice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  voice = vs.find(v => /Daniel|Arthur|Oliver/i.test(v.name) && /en-GB/i.test(v.lang)) || vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /en-IN/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  if (!talkBack || !("speechSynthesis" in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/₹/g, "rupees ").replace(/J\.A\.S\.S\.I/g, "Jassi"));
  if (voice) u.voice = voice;
  u.rate = 1.06; u.pitch = .95;
  u.onstart = () => setMode("speaking");
  u.onend = () => { if (document.body.classList.contains("speaking")) setMode("idle"); };
  speechSynthesis.speak(u);
}

// ================================================================ UI state
const MODES = ["idle", "listening", "thinking", "speaking"];
const MODE_TXT = { idle: "Ready", listening: "Listening", thinking: "Working", speaking: "Talking" };
function setMode(m) {
  for (const x of MODES) document.body.classList.toggle(x, x === m);
  $("#state").textContent = MODE_TXT[m];
}
function reply(text, err = false) {
  const el = $("#reply");
  el.classList.toggle("err", err);
  el.textContent = "";
  let i = 0;
  clearInterval(reply.t);
  reply.t = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(reply.t); }, 12);
}
function toast(title, body, cls = "", action) {
  const t = document.createElement("div");
  t.className = "toast " + cls;
  t.innerHTML = `<b>${esc(title)}</b>${esc(body)}`;
  if (action) { const b = document.createElement("button"); b.className = "ghost"; b.textContent = action.label; b.onclick = () => { action.fn(); t.remove(); }; t.appendChild(b); }
  $("#toasts").appendChild(t);
  if (!action) setTimeout(() => t.remove(), 5000);
  return t;
}

// ================================================================ transcript with live clause highlighting
function renderHeard(text, steps, firedIdx) {
  if (!text) return;
  let html = "";
  let rest = text;
  steps.forEach((st, i) => {
    const c = st.clause;
    const at = c ? rest.toLowerCase().indexOf(c.toLowerCase()) : -1;
    if (at < 0) return;
    html += words(rest.slice(0, at));
    html += `<span class="cl ${firedIdx.has(i) ? "fired" : "wait"}">${words(rest.slice(at, at + c.length))}</span>`;
    rest = rest.slice(at + c.length);
  });
  html += words(rest);
  $("#heard").innerHTML = html;
}
const seenWords = new Set();
function words(s) {
  return s.split(/(\s+)/).map((w, i) => {
    if (!w.trim()) return w;
    const k = w + "@" + i;
    const fresh = !seenWords.has(k); seenWords.add(k);
    return `<span class="${fresh ? "w" : ""}">${esc(w)}</span>`;
  }).join("");
}

// ================================================================ the utterance engine (mid-sentence actions)
class Utterance {
  constructor(source) {
    this.source = source; this.t0 = performance.now(); this.fired = new Map(); this.firstSeen = new Map();
    this.text = ""; this.steps = []; this.ended = false; this.recheck = null; this.firedAt = [];
  }
  onText(text, ended) {
    if (this.ended) return;
    this.text = text;
    const steps = parser.parse(text);
    this.steps = steps;
    const now = performance.now();
    steps.forEach((st, i) => {
      if (this.fired.has(i)) return;
      const closed = ended || i < steps.length - 1;
      if (["unknown", "ask", "stop"].includes(st.kind) || st.dep || st.hold) return;   // handled at the end
      if (!closed) {
        if (st.free || !st.early) return;
        const key = i + "#" + st.sig;
        if (!this.firstSeen.has(key)) this.firstSeen.set(key, now);
        if (now - this.firstSeen.get(key) < STABLE_MS) { clearTimeout(this.recheck); this.recheck = setTimeout(() => this.onText(this.text, false), STABLE_MS + 20); return; }
      }
      if (st.kind === "unknown") return;
      this.fire(st, i, !ended);
    });
    renderHeard(text, steps, new Set(this.fired.keys()));
    if (ended) this.finish();
  }
  fire(st, i, early) {
    this.fired.set(i, st);
    const t = performance.now();
    this.firedAt.push({ i, t, early });
    sfx.fire();
    runStep(st, { early, u: this, t });
  }
  async finish() {
    this.ended = true;
    clearTimeout(this.recheck);
    const tEnd = performance.now();
    // "done before you finished" badges
    for (const f of this.firedAt) if (f.early && tEnd - f.t > 80) { stats.early++; markEarly(f.i, this, tEnd - f.t); }
    updateStats();
    const rest = this.steps.map((s, i) => [s, i]).filter(([, i]) => !this.fired.has(i));
    if (!rest.length) return;
    if (rest.some(([s]) => s.kind === "stop")) { speechSynthesis.cancel(); setMode("idle"); reply("Okay."); return; }
    // yes / no for an open approval (never for fingerprint ones)
    if (pendingOk && pendingOk.level === "confirm" && this.steps.length === 1) {
      if (/^(yes|yeah|yep|sure|do it|send it|go ahead|confirm|ok|okay)\b/i.test(this.text)) return answerOk(true);
      if (/^(no|nope|cancel|don't|stop)\b/i.test(this.text)) return answerOk(false);
    }
    const actions = rest.filter(([s]) => !["unknown", "ask"].includes(s.kind));
    const thinking = rest.filter(([s]) => ["unknown", "ask"].includes(s.kind));
    if (actions.length >= 2 || (actions.length && actions.some(([s]) => s.dep) && actions.some(([s]) => s.hold))) {
      actions.forEach(([, i]) => this.fired.set(i, true));
      renderHeard(this.text, this.steps, new Set(this.fired.keys()));
      await runCodeMode(actions.map(([s]) => s));
    } else {
      for (const [s, i] of actions) { this.fire(s, i, false); }
    }
    if (thinking.length) await askBrain(thinking.length === this.steps.length ? this.text : thinking.map(([s]) => s.clause).join(", "));
  }
}
let cur = null;
function markEarly(i, u, ms) {
  const el = document.querySelector(`.act[data-u="${u.t0}"][data-i="${i}"]`);
  if (!el) return;
  const tags = el.querySelector(".tags");
  const b = document.createElement("span");
  b.className = "tag early"; b.textContent = `⚡ ${(ms / 1000).toFixed(1)} s before you finished`;
  tags.prepend(b);
}

// ================================================================ running things
const KIND_LABEL = { order: "Order", pay: "Pay", message: "WhatsApp", email: "Email", event: "Calendar", timer: "Timer", reminder: "Reminder", note: "Note", search: "Search", play: "Play", directions: "Maps", open_app: "Open", brief: "Brief", read_email: "Email", recall: "Memory", calendar_list: "Calendar", chase_unpaid: "Reminders" };

async function runStep(st, { early, u, t }) {
  setMode("thinking");
  const card = actCard({ id: "local_" + Math.random(), title: (KIND_LABEL[st.kind] || st.kind) + " · " + (st.clause || ""), running: true, dataU: u?.t0, dataI: u ? [...u.fired.keys()].pop() : "" });
  const r = await post("/api/step", { step: st, early });
  bindCard(card, r);
  if (t) { stats.times.push(performance.now() - t); updateStats(); }
  afterResult(r);
}

async function runCodeMode(steps) {
  setMode("thinking");
  const r = await post("/api/run", { steps });
  for (const x of r.results || []) if (x.open) openLink(x.open, x);
  reply(r.say || "Done.", !r.ok);
  speak(r.say);
  if (!talkBack) setMode("idle");
  refresh();
}

async function askBrain(text) {
  setMode("thinking");
  reply("Thinking…");
  const r = await post("/api/ask", { text });
  reply(r.say || "…", !!r.error);
  speak(r.say);
  if (!talkBack) setMode("idle");
  refresh();
}

function afterResult(r) {
  if (r.needApp) toast("Not connected", r.say, "", { label: "Open Settings", fn: () => openSettings("apps") });
  if (r.say) { reply(r.say, !r.ok); speak(r.say); }
  if (!talkBack || !r.say) setMode("idle");
  if (r.ok && r.open) openLink(r.open, r);
  if (r.ok && r.tool === "business_brief") showBrief(r);
  refresh();
}

function openLink(url, r) {
  if (!LS.get("jassi.autoOpen") || LS.get("jassi.autoOpen") === "on") {
    const w = window.open(url, "_blank", "noopener");
    if (!w && !openLink.warned) { openLink.warned = true; toast("Pop-ups blocked", "Use the button on the action card, or allow pop-ups for this page."); }
  }
}

// ================================================================ action feed (fed by the live event stream too)
const cards = new Map();
function actCard(a) {
  $("#feed .empty")?.remove();
  const li = document.createElement("li");
  li.className = "act run";
  if (a.dataU) { li.dataset.u = a.dataU; li.dataset.i = a.dataI; }
  li.innerHTML = `<div class="row"><span class="ttl">${esc(a.title)}</span><span class="ms"></span></div><div class="say"></div><div class="tags"></div>`;
  $("#feed").prepend(li);
  while ($("#feed").children.length > 60) $("#feed").lastChild.remove();
  return li;
}
function bindCard(li, r) {
  if (!li) return;
  li.classList.remove("run");
  li.classList.add(r.ok ? "ok" : r.level === "need" ? "need" : "no");
  li.querySelector(".ttl").textContent = r.title || li.querySelector(".ttl").textContent;
  li.querySelector(".ms").textContent = r.ms != null ? r.ms + " ms" : "";
  li.querySelector(".say").textContent = r.say || "";
  const tags = li.querySelector(".tags");
  const lvl = r.level === "need" ? "" : r.declined ? `<span class="tag block">you said no</span>` : r.level ? `<span class="tag ${r.level}">${{ auto: "auto", confirm: "you said yes", fingerprint: "fingerprint", block: "blocked" }[r.level] || r.level}</span>` : "";
  tags.insertAdjacentHTML("beforeend", lvl + (r.via && r.via !== "voice" ? `<span class="tag via">${esc(r.via)}</span>` : "") + (r.reason && r.level !== "auto" ? `<span class="tag">${esc(r.reason)}</span>` : ""));
  if (r.ok && r.open) li.insertAdjacentHTML("beforeend", `<a class="open" href="${esc(r.open)}" target="_blank" rel="noopener">${esc(openLabel(r))} ↗</a>`);
  if (r.ok && r.reminders) li.insertAdjacentHTML("beforeend", r.reminders.map(x => `<a class="open" href="${esc(x.open)}" target="_blank" rel="noopener">${esc(x.customer)} ↗</a>`).join(""));
  if (r.ok && r.ics) li.insertAdjacentHTML("beforeend", `<a class="open" href="${esc(r.ics)}">Add to my calendar ↓</a>`);
  if (r.ok && r.emails) li.querySelector(".say").innerHTML = r.emails.map(m => `<div>• <b>${esc(m.from)}</b>: ${esc(m.subject)}${m.warning ? ` <span class="tag block">${esc(m.warning)}</span>` : ""}</div>`).join("");
  pulseApp(r.tool);
}
const openLabel = r => ({ draft_message: "Open WhatsApp · tap Send", send_email: "Open email", directions: "Start in Maps", play: "Play", web_search: "See results", open_app: "Open" })[r.tool] || "Open";
const TOOL_APP = { order_food: "swiggy", pay: "razorpay", add_event: "calendar", list_events: "calendar", draft_message: "whatsapp", send_email: "gmail", read_email: "gmail", directions: "maps", play: "youtube", web_search: "youtube", business_brief: "books", chase_unpaid: "books" };
function pulseApp(tool) {
  const el = document.querySelector(`.apps li[data-id="${TOOL_APP[tool]}"]`);
  if (!el) return;
  el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
}

// events from other sources (brain, Code Mode, MCP clients) get their own cards
function onAction(e) {
  if (e.via === "voice" || e.via === "tap") {
    if (e.phase === "end") { stats.actions++; if (e.level === "block") stats.blocked++; updateStats(); }
    return;
  }
  if (e.phase === "start") cards.set(e.id, actCard({ id: e.id, title: e.title }));
  else {
    stats.actions++; if (e.level === "block") stats.blocked++; updateStats();
    bindCard(cards.get(e.id) || actCard({ id: e.id, title: e.title }), e);
    cards.delete(e.id);
  }
}

// ================================================================ Code Mode panel
let codeLines = [];
function onCode(e) {
  const panel = $("#panel-code");
  if (e.phase === "start") {
    panel.classList.add("live");
    $("#code-meta").textContent = "running…";
    codeLines = e.code.split("\n");
    $("#code").innerHTML = codeLines.map((l, i) => `<span class="ln" data-n="${i}">${hl(l)}</span>`).join("");
    codeLines.callLines = codeLines.map((l, i) => /await tools\./.test(l) ? i : -1).filter(i => i >= 0);
    const first = $("#code").querySelector(`[data-n="${codeLines.callLines[0]}"]`); first?.classList.add("hot");
  } else if (e.phase === "call") {
    const n = codeLines.callLines?.[e.index];
    const el = $("#code").querySelector(`[data-n="${n}"]`);
    if (el) { el.classList.remove("hot"); el.classList.add(e.ok ? "done" : "bad"); }
    const next = $("#code").querySelector(`[data-n="${codeLines.callLines?.[e.index + 1]}"]`); next?.classList.add("hot");
  } else if (e.phase === "end") {
    panel.classList.remove("live");
    $("#code-meta").textContent = `${e.calls} calls · 1 script · ${e.ms} ms`;
    $("#code").insertAdjacentHTML("beforeend", `<span class="code-sum">${e.ok ? "✓" : "!"} ${e.calls} app actions in one go: no extra AI round trips.</span>`);
  }
}
function hl(l) {
  return esc(l).replace(/\b(const|await|return|if)\b/g, '<span class="c-k">$1</span>').replace(/(tools\.)(\w+)/g, '$1<span class="c-f">$2</span>')
    .replace(/(&quot;[^&]*?&quot;|`[^`]*`)/g, '<span class="c-s">$1</span>');
}

// ================================================================ approvals
let pendingOk = null;
function showOk(a) {
  pendingOk = a;
  $("#ok").hidden = false;
  document.body.classList.add(a.level === "fingerprint" ? "danger" : "alert");
  $("#ok-tag").textContent = a.level === "fingerprint" ? "Fingerprint needed" : "Needs your OK";
  $("#ok-title").textContent = a.title;
  $("#ok-detail").textContent = a.detail || "";
  $("#ok-why").textContent = "Why: " + (a.reason || "");
  $("#ok-confirm").hidden = a.level === "fingerprint";
  $("#ok-finger").hidden = a.level !== "fingerprint";
  $("#f-fill").style.strokeDashoffset = 339.3; $("#finger").classList.remove("done");
  sfx.alert();
  speak(a.level === "fingerprint" ? `${a.title}. I need your fingerprint.` : `${a.title}. Should I go ahead?`);
  clearInterval(showOk.t);
  const end = a.at + a.timeoutMs;
  showOk.t = setInterval(() => { const s = Math.max(0, Math.round((end - Date.now()) / 1000)); $("#ok-timer").textContent = s + " s"; }, 250);
  if (a.level === "confirm") setTimeout(() => $("#ok-yes").focus(), 50);
}
function hideOk() {
  pendingOk = null; $("#ok").hidden = true; clearInterval(showOk.t);
  document.body.classList.remove("alert", "danger");
}
async function answerOk(yes) {
  if (!pendingOk) return;
  const id = pendingOk.id;
  hideOk();
  yes ? sfx.ok() : sfx.no();
  await post("/api/approve", { id, yes });
}
$("#ok-yes").onclick = () => answerOk(true);
$("#ok-no").onclick = $("#ok-no2").onclick = () => answerOk(false);
// fingerprint: hold for 1.2 s (stands in for the phone's fingerprint prompt)
(() => {
  const f = $("#finger"); let raf = 0, start = 0;
  const HOLD = 1200;
  const tick = () => {
    const p = Math.min(1, (performance.now() - start) / HOLD);
    $("#f-fill").style.strokeDashoffset = 339.3 * (1 - p);
    if (p >= 1) { f.classList.remove("holding"); f.classList.add("done"); setTimeout(() => answerOk(true), 250); return; }
    raf = requestAnimationFrame(tick);
  };
  const down = e => { e.preventDefault(); if (f.classList.contains("done")) return; start = performance.now(); f.classList.add("holding"); beep(520, .05); raf = requestAnimationFrame(tick); };
  const up = () => { if (f.classList.contains("done")) return; cancelAnimationFrame(raf); f.classList.remove("holding"); $("#f-fill").style.strokeDashoffset = 339.3; };
  f.addEventListener("pointerdown", down); f.addEventListener("pointerup", up); f.addEventListener("pointerleave", up);
})();

// ================================================================ brief
function showBrief(b) {
  const h = new Date().getHours();
  $("#brief-part").textContent = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  $("#brief-name").textContent = S?.user?.name || "";
  const { pace: P, orders: O, margin: M, quality: Q } = b;
  const num = n => Number(n).toLocaleString("en-IN");
  const signed = n => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n);
  const arrow = (n, goodWhenUp = true) => n === 0 ? `<div class="s">` : `<div class="s ${(n > 0) === goodWhenUp ? "up" : "down"}">${n > 0 ? "▲" : "▼"} `;
  const paceCard = !P.elapsed
    ? `<div class="s">first day of the month</div><div class="calc">Need ${inr(P.target)} ÷ ${P.daysInMonth} days = ${inr(P.need_per_day)} a day</div>`
    : `${arrow(P.pace_pct)}${P.pace_pct === 0 ? "right on pace" : `${Math.abs(P.pace_pct)}% ${P.pace_pct > 0 ? "ahead of" : "behind"} pace`} · of ${inr(P.target)}</div>
      <div class="bar"><i style="width:${Math.min(100, P.done_pct)}%"></i><u style="left:${Math.min(100, P.expected / P.target * 100)}%"></u></div>
      <div class="calc">Expected by now = ${inr(P.target)} × ${P.elapsed}/${P.daysInMonth} days = ${inr(P.expected)}<br>
      Pace = ${inr(P.mtd)} ÷ ${inr(P.expected)} − 1 = ${signed(P.pace_pct)}%<br>
      At ${inr(P.run_rate)}/day you'll end at ${inr(P.projected)} · need ${inr(P.need_per_day)}/day for the last ${P.daysLeft} days</div>`;
  $("#brief-grid").innerHTML = `
    <div class="bx"><div class="k">Month to date vs target</div><div class="v">${inr(P.mtd)}</div>${paceCard}</div>
    <div class="bx"><div class="k">Orders · avg order value</div><div class="v">${num(O.orders)} orders</div>${arrow(O.aov_vs_week_pct)}AOV ${inr(O.aov)} · ${O.aov_vs_week_pct ? Math.abs(O.aov_vs_week_pct) + "% vs" : "same as"} 7-day ${inr(O.aov_week)}</div>
      <div class="calc">Yesterday: ${inr(O.sales)} ÷ ${num(O.orders)} orders = ${inr(O.aov)}<br>7 days: ${inr(O.week_sales)} ÷ ${num(O.week_orders)} orders = ${inr(O.aov_week)}</div></div>
    <div class="bx"><div class="k">Gross margin · this week</div><div class="v">${M.pct}%</div>${arrow(M.change_pts)}${M.change_pts ? Math.abs(M.change_pts) + " pts vs" : "same as"} last week ${M.prev_pct}%</div>
      <div class="calc">(${inr(M.week_sales)} sales − ${inr(M.week_cogs)} cost of goods) ÷ ${inr(M.week_sales)} = ${M.pct}%</div></div>
    <div class="bx"><div class="k">Complaints / returns · 7 days</div><div class="v"${Q.worse ? ' style="color:var(--amber)"' : ""}>${Q.total}</div>${arrow(Q.total - Q.prev_total, false)}${Q.complaints} complaints · ${Q.returns} returns · last week ${Q.prev_total}</div>
      <div class="calc">Per 100 orders: ${Q.total} ÷ ${num(O.week_orders)} × 100 = ${Q.per_100_orders} (last week ${Q.prev_per_100_orders})</div></div>
    <div class="bx"><div class="k">Cash in / out</div><div class="v">${inr(b.cash_in)}</div><div class="s">out ${inr(b.cash_out)} · net ${inr(b.cash_in - b.cash_out)}</div></div>
    <div class="bx"><div class="k">Overdue payments</div><div class="v" style="color:var(--amber)">${inr(b.due)}</div><div class="s">${b.overdue.length} customers</div></div>
    <div class="bx"><div class="k">Low stock</div><ul>${b.low_stock.map(x => `<li>${esc(x.item)} · ${x.left} left</li>`).join("")}</ul></div>
    <div class="bx"><div class="k">Gone quiet</div><ul>${b.quiet.map(x => `<li>${esc(x.name)} · ${x.days_quiet} days</li>`).join("")}</ul></div>
    <div class="bx"><div class="k">Meetings today</div><ul>${b.meetings.map(x => `<li>${esc(x.time)} · ${esc(x.title)}</li>`).join("")}</ul></div>`;
  $("#brief-steps").innerHTML = b.steps.map((s, i) => `<button class="step-btn" data-say="${esc(s.say)}"><b>${i + 1}</b>${esc(s.label)}<span>Do it →</span></button>`).join("");
  $("#brief").hidden = false;
  LS.set("jassi.briefDay", new Date().toDateString());
}
$("#brief-steps").onclick = e => { const b = e.target.closest(".step-btn"); if (!b) return; $("#brief").hidden = true; runText(b.dataset.say, false); };
$("#brief-x").onclick = () => { $("#brief").hidden = true; };
$("#btn-brief").onclick = () => runText("brief me", false);

// ================================================================ input: typed, simulated voice, real voice
function runText(text, likeVoice = $("#sim").checked) {
  text = text.trim();
  if (!text) return;
  speechSynthesis?.cancel();
  seenWords.clear();
  cur = new Utterance(likeVoice ? "sim" : "typed");
  setMode("listening");
  if (!likeVoice) { cur.onText(text, true); return; }
  const ws = text.split(/\s+/);
  let i = 0;
  const u = cur;
  const next = () => {
    if (u !== cur) return;
    i++;
    u.onText(ws.slice(0, i).join(" "), false);
    if (i < ws.length) setTimeout(next, 170 + Math.random() * 60);   // ~ speaking speed
    else setTimeout(() => u.onText(text, true), 380);
  };
  next();
}
$("#cmd").onsubmit = e => { e.preventDefault(); const v = $("#cmd-in").value; $("#cmd-in").value = ""; runText(v); };

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, silence = null, micStream = null, analyser = null;
async function startListening() {
  if (!SR) { toast("No voice here", "This browser can't listen. Use Chrome, or type instead."); return; }
  if (rec) return stopListening();
  speechSynthesis?.cancel();
  seenWords.clear();
  cur = new Utterance("voice");
  const u = cur;
  rec = new SR();
  rec.lang = "en-IN"; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
  rec.onresult = ev => {
    let text = "";
    for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
    text = text.replace(/\s+/g, " ").trim();
    u.onText(text, false);
    clearTimeout(silence);
    silence = setTimeout(() => { u.onText(text, true); stopListening(); }, 900);
  };
  rec.onerror = e => { if (e.error !== "no-speech" && e.error !== "aborted") toast("Mic problem", e.error); stopListening(); };
  rec.onend = () => { if (rec) { if (u.text && !u.ended) u.onText(u.text, true); stopListening(); } };
  try { rec.start(); } catch {}
  setMode("listening");
  $("#heard").innerHTML = `<span class="hint">Listening…</span>`;
  sfx.fire();
  if (!/Android/i.test(navigator.userAgent)) meter(); // Android: a getUserMedia stream steals the mic from SpeechRecognition
}
function stopListening() {
  const r = rec; rec = null; clearTimeout(silence);
  try { r?.stop(); } catch {}
  if (document.body.classList.contains("listening")) setMode("idle");
  document.documentElement.style.setProperty("--lvl", 0);
}
async function meter() {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    if (!micStream) { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); analyser = AC.createAnalyser(); analyser.fftSize = 256; AC.createMediaStreamSource(micStream).connect(analyser); }
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bars = [...document.querySelectorAll("#bars line")];
    const loop = () => {
      if (!rec) { bars.forEach(b => b.style.opacity = .15); return; }
      analyser.getByteFrequencyData(data);
      let sum = 0; for (const v of data) sum += v;
      document.documentElement.style.setProperty("--lvl", Math.min(1, sum / data.length / 90).toFixed(3));
      bars.forEach((b, i) => b.style.opacity = .15 + data[(i * 3) % data.length] / 300);
      requestAnimationFrame(loop);
    };
    loop();
  } catch {}
}
$("#mic").onclick = startListening;
$("#reactor").onclick = startListening;
$("#reactor").onkeydown = e => { if (e.key === "Enter") startListening(); };
document.addEventListener("keydown", e => {
  if (!$("#ok").hidden) {
    if (e.key === "Escape") answerOk(false);
    if (e.key === "Enter" && pendingOk?.level === "confirm") answerOk(true);
    return;
  }
  if (e.key === "Escape") { $("#brief").hidden = true; closeSettings(); speechSynthesis?.cancel(); stopListening(); }
  if (!$("#settings").hidden || !$("#onboard").hidden || !$("#signin").hidden) return;
  if (e.code === "Space" && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); startListening(); }
});
$("#btn-voice").onclick = () => {
  talkBack = !talkBack; LS.set("jassi.voice", talkBack ? "on" : "off");
  $("#btn-voice").setAttribute("aria-pressed", talkBack); $("#btn-voice").title = "Talk back: " + (talkBack ? "on" : "off");
  if (!talkBack) speechSynthesis?.cancel();
};
$("#btn-voice").setAttribute("aria-pressed", talkBack);
$("#btn-attack").onclick = async () => {
  reply("Pretending I read the scam email and it told me to pay ₹4,999…");
  const r = await post("/api/attack");
  reply(r.ok ? r.say : r.declined ? "Blocked. You said no, so the scam payment never happened." : r.say, !r.ok);
  refresh();
};

// ================================================================ panels from server state
function renderApps() {
  const on = S.settings?.apps || {};
  $("#apps").innerHTML = S.apps.map(a => {
    const g = S.google?.available && (a.id === "calendar" || a.id === "gmail");
    const isOn = g ? S.google[a.id] : on[a.id];
    const st = a.tier === "blocked" ? ["blocked", "LOCKED"] : isOn ? ["connect", g ? "GOOGLE" : a.tier === "link" ? "LINK" : "ON"] : ["off", "CONNECT"];
    return `<li data-id="${a.id}" class="${a.tier} ${isOn ? "" : a.tier === "blocked" ? "" : "dim"}"><span class="ic">${a.tier === "blocked" ? "✕" : esc(a.name[0])}</span>
    <span><span class="nm">${esc(a.name)}</span><span class="how">${esc(a.how)}</span></span>
    <span class="st ${st[0]}">${st[1]}</span></li>`;
  }).join("");
}
$("#apps").onclick = () => openSettings("apps");
function renderMoney() {
  const p = Math.min(1, S.spentToday / S.settings.dailyCap);
  $("#gauge-fg").style.strokeDashoffset = 314.16 * (1 - p);
  $("#gauge-fg").style.stroke = p > .8 ? "var(--red)" : p > .5 ? "var(--amber)" : "";
  $("#spent").textContent = inr(S.spentToday);
  $("#cap").textContent = inr(S.settings.dailyCap);
  const auto = S.settings.autoPayUnder;
  $(".rules").innerHTML = `<div><i class="dot g"></i>${auto > 0 ? `Under ${inr(auto)} · <b>pays on its own</b>` : `<b>Every payment asks you</b>`}</div>
    <div><i class="dot a"></i>${inr(auto)} or more · <b>your fingerprint</b></div><div><i class="dot r"></i>Bank &amp; UPI apps · <b>locked</b></div>`;
}
let timers = [];
function renderUpcoming() {
  const items = [
    ...timers.filter(t => t.fireAt > Date.now()).map(t => ({ t: t.fireAt, label: "⏱ " + t.label, live: true })),
    ...S.events.map(e => ({ t: e.when, label: "📅 " + e.title, ics: `/api/ics/${e.id}` })),
  ].sort((a, b) => a.t - b.t).slice(0, 6);
  $("#upcoming").innerHTML = items.length ? items.map(x => `<li><span>${esc(x.label)}${x.ics ? ` <a href="${x.ics}" title="Add to my calendar">.ics</a>` : ""}</span><span class="t">${x.live ? countdown(x.t) : hhmm(x.t)}</span></li>`).join("") : `<li class="empty">Nothing yet</li>`;
}
const countdown = t => { const s = Math.max(0, Math.round((t - Date.now()) / 1000)); return s >= 3600 ? hhmm(t) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function renderDiary() {
  $("#diary-path").textContent = S.diaryDir;
  $("#diary").innerHTML = S.diary.length ? S.diary.map(d => `<li><span class="t">${esc(d.time)}</span><span>${esc(d.title)}<div class="d">${esc(d.decision)} · ${esc(d.origin)}</div></span></li>`).join("") : `<li class="empty">Every action I take is written here.</li>`;
}
function updateStats() {
  $("#st-early").textContent = stats.early;
  const avg = stats.times.length ? stats.times.reduce((a, b) => a + b, 0) / stats.times.length : 0;
  $("#st-speed").textContent = avg ? Math.round(avg) + " ms" : "–";
  $("#st-actions").textContent = Math.max(stats.actions, S?.diary?.length || 0);
  $("#st-blocked").textContent = stats.blocked;
}
async function refresh() {
  const res = await fetch("/api/state");
  if (res.status === 401) { showSignin(await res.json()); throw new Error("signed out"); }
  S = await res.json();
  parser = new Parser(S.contacts, S.blocked);
  timers = S.timers;
  renderMoney(); renderUpcoming(); renderDiary(); updateStats(); renderApps(); renderMe();
  const b = $("#pill-brain");
  b.classList.toggle("on", S.brain.on); b.classList.toggle("warn", !S.brain.on);
  b.lastChild.textContent = S.brain.on ? "Brain: Claude Code" : "Brain: offline";
  return S;
}

// timers ring here
setInterval(() => {
  const now = Date.now();
  for (const t of timers) if (!t.rang && t.fireAt <= now) {
    t.rang = true; sfx.ring();
    const tt = toast(t.label === "Timer" ? "Time's up" : t.label === "Alarm" ? "Alarm" : "Reminder", t.label, "ring", { label: "OK", fn: () => {} });
    speak(t.label === "Timer" ? "Your timer is done." : `Reminder: ${t.label}`);
    setTimeout(() => tt.remove(), 30000);
  }
  if (S) renderUpcoming();
}, 1000);

// ================================================================ live events from the server
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", () => $("#pill-live").classList.add("on"));
  es.addEventListener("action", e => onAction(JSON.parse(e.data)));
  es.addEventListener("codemode", e => onCode(JSON.parse(e.data)));
  es.addEventListener("approval", e => showOk(JSON.parse(e.data)));
  es.addEventListener("approval_done", e => { const d = JSON.parse(e.data); if (pendingOk?.id === d.id) hideOk(); });
  es.addEventListener("diary", e => { const d = JSON.parse(e.data); S.diary.unshift(d); renderDiary(); });
  es.addEventListener("timer", e => { timers.push(JSON.parse(e.data)); renderUpcoming(); });
  es.addEventListener("calendar", () => refresh());
  es.addEventListener("thinking", () => setMode("thinking"));
  es.addEventListener("brain", () => refresh());
  es.onerror = () => $("#pill-live").classList.remove("on");
}

// ================================================================ decorations
function buildReactor() {
  const segs = $("#segs"), bars = $("#bars");
  for (let i = 0; i < 12; i++) segs.insertAdjacentHTML("beforeend", `<rect x="196" y="36" width="8" height="18" transform="rotate(${i * 30} 200 200)"/>`);
  for (let i = 0; i < 48; i++) {
    const a = i / 48 * Math.PI * 2, r1 = 96, r2 = 106;
    bars.insertAdjacentHTML("beforeend", `<line x1="${200 + Math.cos(a) * r1}" y1="${200 + Math.sin(a) * r1}" x2="${200 + Math.cos(a) * r2}" y2="${200 + Math.sin(a) * r2}" style="opacity:.15"/>`);
  }
}
function field() {
  const c = $("#field"), x = c.getContext("2d");
  let W, H, P;
  const size = () => { W = c.width = innerWidth * devicePixelRatio; H = c.height = innerHeight * devicePixelRatio; P = Array.from({ length: Math.round(innerWidth / 22) }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25, r: Math.random() * 1.6 + .4 })); };
  size(); addEventListener("resize", size);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const draw = () => {
    x.clearRect(0, 0, W, H);
    const col = getComputedStyle(document.body).getPropertyValue("--c1").trim() || "#46ecff";
    for (const p of P) {
      p.x = (p.x + p.vx + W) % W; p.y = (p.y + p.vy + H) % H;
      x.globalAlpha = .5; x.fillStyle = col; x.beginPath(); x.arc(p.x, p.y, p.r * devicePixelRatio, 0, 7); x.fill();
    }
    x.strokeStyle = col;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const d = Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y);
      if (d < 120 * devicePixelRatio) { x.globalAlpha = .12 * (1 - d / (120 * devicePixelRatio)); x.beginPath(); x.moveTo(P[i].x, P[i].y); x.lineTo(P[j].x, P[j].y); x.stroke(); }
    }
    requestAnimationFrame(draw);
  };
  draw();
}
function clock() {
  const d = new Date();
  $("#clock-time").textContent = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  $("#clock-date").textContent = d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}
async function boot() {
  const lines = ["Starting J.A.S.S.I", "Safety guard", "Your apps", "Diary", "MCP server", "Brain"];
  const log = $("#bootlog");
  let s;
  try { s = await refresh(); } catch (e) {
    if (e.message === "signed out") return;
    log.textContent = "Can't reach J.A.S.S.I right now. Check your internet and reload."; return;
  }
  const nOn = Object.values(s.settings.apps || {}).filter(Boolean).length + (s.google?.calendar ? 0 : 0);
  const res = [s.me?.name ? "Hi " + s.me.name.split(" ")[0] : "", "ON", nOn ? `${nOn} connected · ${s.apps.filter(a => a.tier === "blocked").length} locked` : "none yet", "OK", "/mcp ready", s.brain.on ? "Claude Code" : "offline"];
  requestAnimationFrame(() => $(".boot-bar i").style.width = "100%");
  const skip = LS.get("jassi.booted") === new Date().toDateString();
  for (let i = 0; i < lines.length; i++) {
    log.innerHTML += `> ${esc(lines[i])}${res[i] ? ` ... <span class="ok">${esc(res[i])}</span>` : ""}\n`;
    await new Promise(r => setTimeout(r, skip ? 60 : 230));
  }
  await new Promise(r => setTimeout(r, skip ? 100 : 350));
  $("#boot").classList.add("gone");
  LS.set("jassi.booted", new Date().toDateString());
  renderApps();
  for (const a of s.pending) showOk(a);
  const q = new URLSearchParams(location.search);
  const back = LS.get("jassi.return"); LS.set("jassi.return", "");
  if (q.get("connected")) toast("Connected", `${q.get("connected") === "gmail" ? "Gmail" : "Google Calendar"} is connected. I'll use your real one now.`);
  if (q.get("error")) toast("Something went wrong", q.get("error"));
  if (q.toString()) history.replaceState(null, "", location.pathname);
  if (!s.onboarded) return openOnboarding(back === "onboard" ? 2 : 0);
  if (back === "settings") return openSettings("apps");
  ready();
}
function ready() {
  if (LS.get("jassi.briefDay") !== new Date().toDateString() && !new URLSearchParams(location.search).has("nobrief") && S.settings.apps.books) setTimeout(() => runText("brief me", false), 500);
}
function renderMe() {
  const me = S.me || {};
  $("#btn-me").innerHTML = me.picture ? `<img src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer">` : esc((me.name || "?")[0]);
  $("#btn-me").title = (me.name || "") + (me.email ? " · " + me.email : "");
}
$("#btn-settings").onclick = () => openSettings();
$("#btn-me").onclick = () => openSettings("account");
initSetup({
  getS: () => S, refresh, toast, runText: t => runText(t), ready,
  prefs: { talkBack: () => talkBack, setTalkBack: v => { talkBack = v; LS.set("jassi.voice", v ? "on" : "off"); $("#btn-voice").setAttribute("aria-pressed", v); } },
});
if (LS.get("jassi.sim") === "off") $("#sim").checked = false;
$("#boot").onclick = () => $("#boot").classList.add("gone");

buildReactor(); field(); clock(); setInterval(clock, 1000); connect(); setMode("idle"); boot();
