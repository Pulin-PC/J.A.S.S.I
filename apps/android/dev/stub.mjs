// Throwaway stand-in for the server side of docs/native-contract.md §4, for testing the Android app.
// Not part of the product. Run: node dev/stub.mjs   (PORT and TOKEN can be set in the environment)
//
//   GET  /                     a test page with one button per bridge method
//   GET  /api/device/next      the long-poll the app calls (contract §4)
//   POST /api/device/result    where the app posts results (contract §4)
//   POST /dev/op {op,args}     queue an op for the device and wait for its result
//   POST /dev/revoke           answer the next poll with 401 (the app must unpair)
//   POST /dev/down {seconds}   answer polls with 500 for a while (to watch the back-off)
//   GET  /dev/log              when the app polled, and what it got
import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.TOKEN || "dev-token";
const queue = [], polls = [], log = [];
const done = new Map();
let seq = 0, revoke = false, downUntil = 0;
const started = Date.now();
const note = (what) => { log.push({ t: ((Date.now() - started) / 1000).toFixed(1), what }); if (log.length > 200) log.shift(); };

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const read = (req) => new Promise((ok) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok({}); } }); });
const authed = (req) => req.headers.authorization === `Bearer ${TOKEN}`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PAGE); }
  if (url.pathname === "/frame") { res.writeHead(200, { "content-type": "text/html" }); return res.end(FRAME); }

  if (url.pathname === "/api/device/next") {
    if (revoke || !authed(req)) { revoke = false; note("poll → 401"); return json(res, 401, { error: "unauthorized" }); }
    if (Date.now() < downUntil) { note("poll → 500"); return json(res, 500, { error: "down" }); }
    if (queue.length) { const op = queue.shift(); note(`poll → ${op.op}`); return json(res, 200, op); }
    const wait = Math.min(Number(url.searchParams.get("wait") || 25), 25) * 1000;
    const poll = { res, timer: setTimeout(() => { polls.splice(polls.indexOf(poll), 1); note("poll → 204"); res.writeHead(204); res.end(); }, wait) };
    polls.push(poll);
    req.on("close", () => { clearTimeout(poll.timer); const i = polls.indexOf(poll); if (i >= 0) polls.splice(i, 1); });
    return;
  }
  if (url.pathname === "/api/device/result" && req.method === "POST") {
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });
    const body = await read(req);
    note(`result ${body.id} ok=${body.ok}${body.error ? " " + body.error : ""}`);
    done.get(body.id)?.(body);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/dev/op" && req.method === "POST") {
    const body = await read(req);
    const op = { id: `op${++seq}`, op: body.op, args: body.args || {} };
    const result = new Promise((ok) => { done.set(op.id, ok); setTimeout(() => ok({ id: op.id, ok: false, error: "no answer from the device in 25 s" }), 25000); });
    const poll = polls.shift();
    if (poll) { clearTimeout(poll.timer); note(`poll → ${op.op}`); json(poll.res, 200, op); } else queue.push(op);
    const out = await result;
    done.delete(op.id);
    return json(res, 200, out);
  }
  if (url.pathname === "/dev/revoke") { revoke = true; polls.splice(0).forEach((p) => { clearTimeout(p.timer); revoke = false; note("poll → 401"); json(p.res, 401, {}); }); return json(res, 200, { ok: true }); }
  if (url.pathname === "/dev/down") { const b = await read(req); downUntil = Date.now() + (b.seconds || 20) * 1000; polls.splice(0).forEach((p) => { clearTimeout(p.timer); note("poll → 500"); json(p.res, 500, {}); }); return json(res, 200, { ok: true }); }
  if (url.pathname === "/dev/log") return json(res, 200, log);
  json(res, 404, { error: "not found" });
}).listen(PORT, () => console.log(`stub on http://localhost:${PORT}  (token: ${TOKEN})`));

const FRAME = `<!doctype html><script>
parent.postMessage({ frame: { jassiNative: typeof window.jassiNative, host: typeof window.__jassiHost } }, "*");
</script>`;

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>J.A.S.S.I bridge test</title>
<style>body{font:14px system-ui;background:#01060c;color:#e8f4fa;margin:12px}button{margin:3px;padding:8px 10px;font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;background:#0a1622;padding:8px;border-radius:8px;font-size:11px}
input{width:95%;padding:8px;margin:6px 0}a{color:#3ce8ff}</style>
<h3>J.A.S.S.I bridge test</h3>
<div id="buttons"></div>
<input id="box" placeholder="Type here"><input id="secret" type="password" placeholder="Password">
<p><a href="https://example.com/">A link to another site</a></p>
<iframe src="/frame" style="display:none"></iframe>
<pre id="out"></pre>
<script>
const out = document.getElementById("out");
window.__events = []; window.__frame = null;
const show = (label, value) => { out.textContent = label + " → " + JSON.stringify(value) + "\\n" + out.textContent; };
addEventListener("jassi-native", (e) => { window.__events.push(e.detail); show("event", e.detail); });
addEventListener("message", (e) => { if (e.data && e.data.frame) { window.__frame = e.data.frame; show("iframe sees", e.data.frame); } });
const n = window.jassiNative;
const calls = {
  listApps: () => n.listApps().then((r) => ({ ok: r.ok, partial: r.partial, count: r.apps && r.apps.length, first: r.apps && r.apps.slice(0, 3) })),
  permissions: () => n.permissions(),
  "openPermission(screen)": () => n.openPermission("screen"),
  "openPermission(mic)": () => n.openPermission("mic"),
  "openPermission(notifications)": () => n.openPermission("notifications"),
  pair: () => n.pair({ server: location.origin, deviceId: "dev-phone", token: "${TOKEN}" }),
  unpair: () => n.unpair(),
  setPolicy: () => n.setPolicy({ blockedApps: ["com.google.android.deskclock"] }),
  "setPolicy(none)": () => n.setPolicy({ blockedApps: [] }),
  openExternal: () => n.openExternal("https://example.com/"),
  biometric: () => n.biometric({ reason: "Confirm it's you" }),
  listenStart: () => n.listenStart({ lang: "en-IN" }),
  listenStop: () => n.listenStop(),
  speak: () => n.speak({ text: "Hello, I am J.A.S.S.I", lang: "en-IN" }),
  speakStop: () => n.speakStop(),
  notify: () => n.notify({ title: "J.A.S.S.I", body: "This is a test alert." }),
  stop: () => n.stop(),
};
if (!n) show("window.jassiNative", "missing");
else {
  show("jassiNative", { platform: n.platform, version: n.version, contract: n.contract });
  for (const name of Object.keys(calls)) {
    const b = document.createElement("button"); b.textContent = name;
    b.onclick = () => calls[name]().then((r) => show(name, r), (e) => show(name + " threw", String(e)));
    document.getElementById("buttons").appendChild(b);
  }
}
</script>`;
