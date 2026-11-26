// Screen control: catalogue, guard rules, the device line, and the tools end to end against a pretend device.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { rt, freshState, makeBus, makeApprovals } from "../server/runtime.js";
import { decide, screenRisk } from "../server/guard.js";
import { classify, classifyAll, lockedReason } from "../server/catalog.js";
import { makeDeviceHub, pairDevice, unpairDevice, deviceFor, nextOp, deviceResult, deviceOp, listDevices } from "../server/device.js";
import { call } from "../server/tools.js";
import { api } from "../server/api.js";

const demo = JSON.parse(fs.readFileSync(new URL("../data/demo.json", import.meta.url), "utf8"));
function fresh() {
  const bus = makeBus();
  Object.assign(rt, { demo, state: freshState(), bus, approvals: makeApprovals(bus), deviceHub: makeDeviceHub(), save() {}, diary() {}, spentToday: () => 0, addSpent() {}, registerDevice: null, unregisterDevice: null });
}
// Answer every "needs your OK" the same way, and remember what was asked.
function autoAnswer(yes) {
  const asked = [];
  rt.bus.add({ send(msg) { if (msg.startsWith("event: approval\n")) { const a = JSON.parse(msg.split("data: ")[1]); asked.push(a); queueMicrotask(() => rt.approvals.answer(a.id, yes)); } } });
  return asked;
}
// A pretend native app: polls for work and answers from a script.
function pretendDevice(dev, answer) {
  let on = true;
  (async () => { while (on) { const op = await nextOp(dev, 200); if (op) deviceResult(dev, { id: op.id, ...answer(op) }); } })();
  return () => { on = false; };
}
const SCREEN = { app: { id: "com.whatsapp", name: "WhatsApp" }, nodes: [
  { n: 0, role: "text", text: "Riya" }, { n: 1, role: "textfield", text: "", hint: "Message", editable: true },
  { n: 2, role: "button", text: "Send", clickable: true }, { n: 3, role: "button", text: "Pay ₹200", clickable: true },
  { n: 4, role: "button", text: "", clickable: true }, { n: 5, role: "textfield", text: "hunter2", secure: true, editable: true },
  { n: 6, role: "button", text: "Emoji", clickable: true } ] };

test("catalogue: money, ID, password and system apps are locked on every device", () => {
  for (const a of [{ id: "com.google.android.apps.nbu.paisa.user", name: "GPay" }, { id: "com.phonepe.app", name: "PhonePe" }, { id: "com.sbi.lotusintouch", name: "YONO SBI" },
    { id: "com.digilocker.android", name: "DigiLocker" }, { id: "com.1password.1password", name: "1Password" }, { id: "com.apple.systempreferences", name: "System Settings" },
    { id: "com.apple.terminal", name: "Terminal" }, { id: "com.android.settings", name: "Settings" }, { id: "x", name: "Zerodha Kite" }])
    assert.equal(classify(a).tier, "locked", a.name);
  assert.equal(lockedReason({ id: "com.taxis.rides", name: "City Taxis" }), "");          // "axis" inside another word is not a bank
  assert.equal(lockedReason({ id: "com.healthifyme.basic", name: "HealthifyMe" }), "");
});

test("catalogue: official and built-in plugs first, everything else gets the J.A.S.S.I screen plug (not on iPhone)", () => {
  assert.deepEqual(classify({ id: "in.swiggy.android", name: "Swiggy" }), { id: "in.swiggy.android", name: "Swiggy", tier: "official", how: "Official MCP", plug: "swiggy", mcp: "swiggy" });
  assert.equal(classify({ id: "com.whatsapp", name: "WhatsApp" }).plug, "whatsapp");
  assert.equal(classify({ id: "com.amazon.mShop.android.shopping", name: "Amazon Shopping" }).tier, "avoid");
  assert.equal(classify({ id: "com.blinkit", name: "Blinkit" }, "android").tier, "screen");
  assert.equal(classify({ id: "com.blinkit", name: "Blinkit" }, "ios").tier, "skip");
  const all = classifyAll([{ id: "B", name: "Blinkit" }, { id: "b", name: "Blinkit again" }, { id: "p", name: "PhonePe" }, { id: "s", name: "Swiggy" }, {}], "android");
  assert.deepEqual(all.map(a => a.tier), ["official", "screen", "locked"]);                 // same id once, empty rows dropped, best first
});

test("guard: screen steps", () => {
  const step = (o = {}) => decide({ tool: "screen_act", kind: "screen", screen: { app: "x", appName: "X", allowed: true, session: true, action: "tap", label: "Emoji", ...o } }).level;
  assert.equal(step(), "auto");
  assert.equal(step({ session: false }), "confirm");                  // first step in an app asks
  assert.equal(step({ label: "Send" }), "confirm");
  assert.equal(step({ label: "Delete chat" }), "confirm");
  assert.equal(step({ label: "" }), "confirm");                       // a button with no name
  assert.equal(step({ label: "Pay ₹200" }), "fingerprint");
  assert.equal(step({ label: "Place order" }), "fingerprint");
  assert.equal(step({ action: "key", key: "enter", label: "" }), "confirm");
  assert.equal(step({ action: "type", label: "Message" }), "auto");
  assert.equal(step({ action: "scroll" }), "auto");
  assert.equal(step({ allowed: false }), "block");
  assert.equal(step({ locked: true }), "block");
  assert.equal(decide({ tool: "screen_act", kind: "screen", screen: {} }).level, "block");   // nothing read yet
  assert.equal(screenRisk("Add to cart"), "");
});

test("device line: pair, ask, answer; only the right device and token count", async () => {
  fresh();
  const { deviceId, token } = await pairDevice({ platform: "android", name: "Nothing Phone" });
  assert.ok(token.startsWith("jd_") && !JSON.stringify(rt.state).includes(token));          // only the hash is kept
  const dev = await deviceFor(token);
  assert.equal(dev.id, deviceId);
  assert.equal(await deviceFor("jd_wrong"), null);
  assert.deepEqual(await deviceOp("screen_read"), { ok: false, error: "offline" });         // it has never called in
  const waiting = nextOp(dev, 2000);                                                         // the app's long poll
  const asked = deviceOp("screen_read", {}, 1000);
  const op = await waiting;
  assert.equal(op.op, "screen_read");
  assert.equal(listDevices()[0].online, true);
  const other = (await deviceFor((await pairDevice({ platform: "macos" })).token));
  assert.equal(deviceResult(other, { id: op.id, ok: true, data: {} }), false);              // another device can't answer for it
  assert.equal(deviceResult(dev, { id: op.id, ok: true, data: { x: 1 } }), true);
  assert.deepEqual(await asked, { ok: true, data: { x: 1 }, error: undefined, device: deviceId });
  assert.deepEqual(await deviceOp("screen_read", {}, 50), { ok: false, error: "timeout" }); // asked, nobody answered
  assert.equal(unpairDevice(deviceId), true);
  assert.equal(await deviceFor(token), null);
});

test("api: device routes need the device token; the scan sorts apps and keeps locked ones out", async () => {
  fresh();
  const q = new URLSearchParams("wait=0");
  assert.equal((await api("GET", "/api/device/next", "", {}, q)).status, 401);
  assert.equal((await api("GET", "/api/device/next", "", { authorization: "Bearer jd_nope" }, q)).status, 401);
  const { token } = JSON.parse((await api("POST", "/api/device/pair", JSON.stringify({ platform: "android" }))).body);
  assert.equal((await api("GET", "/api/device/next", "", { authorization: "Bearer " + token }, q)).status, 204);
  const scan = JSON.parse((await api("POST", "/api/device/apps", JSON.stringify({ platform: "android", apps: [{ id: "com.blinkit", name: "Blinkit" }, { id: "com.phonepe.app", name: "PhonePe" }] }))).body).scan;
  assert.deepEqual(scan.apps.map(a => a.tier), ["screen", "locked"]);
  await api("POST", "/api/settings", JSON.stringify({ screenApps: { "com.blinkit": true, "com.phonepe.app": true, "made.up": true } }));
  assert.deepEqual(rt.state.settings.screenApps, {});                                        // on is the default; locked and unknown apps aren't stored
  await api("POST", "/api/settings", JSON.stringify({ screenApps: { "com.blinkit": false } }));
  assert.deepEqual(rt.state.settings.screenApps, { "com.blinkit": false });                 // turning one off is remembered
});

test("screen tools: open, look, act - with the guard in between", async () => {
  fresh();
  rt.state.scan = { apps: classifyAll([{ id: "com.whatsapp.w4b", name: "WA Business" }, { id: "com.blinkit", name: "Blinkit" }, { id: "com.phonepe.app", name: "PhonePe" }], "android") };
  rt.state.settings.screenApps = { "com.blinkit": false };   // every app is on unless turned off
  const dev = await deviceFor((await pairDevice({ platform: "android" })).token);
  let screen = { ...SCREEN, app: { id: "com.whatsapp.w4b", name: "WA Business" } };
  const ops = [];
  const stop = pretendDevice(dev, op => { ops.push(op); return op.op === "screen_read" ? { ok: true, data: screen } : op.args.n === 6 ? { ok: false, error: "stopped" } : { ok: true, data: { done: true } }; });
  const asked = autoAnswer(true);
  try {
    assert.equal((await call("screen_act", { action: "tap", n: 2 }, { origin: "brain" })).level, "need");           // must look first
    assert.equal((await call("screen_open", { app: "Blinkit" }, { origin: "brain" })).level, "block");                // turned off
    assert.equal((await call("screen_open", { app: "PhonePe" }, { origin: "brain" })).level, "block");                // locked
    const opened = await call("screen_open", { app: "WA Business" }, { origin: "brain" });
    assert.equal(opened.ok, true); assert.equal(opened.level, "confirm");                                             // asked once for the app
    const read = await call("screen_read", {}, { origin: "brain" });
    assert.equal(read.ok, true); assert.equal(read.untrusted, true);
    assert.ok(read.screen.includes('[2] button "Send"') && read.screen.includes("password box, hidden") && !read.screen.includes("hunter2"));
    assert.equal((await call("screen_act", { action: "type", n: 1, text: "On my way" }, { origin: "content" })).level, "auto");
    assert.equal((await call("screen_act", { action: "tap", n: 2 }, { origin: "content" })).level, "confirm");        // Send
    assert.equal((await call("screen_act", { action: "tap", n: 3 }, { origin: "content" })).level, "fingerprint");    // Pay
    assert.equal((await call("screen_act", { action: "tap", n: 4 }, { origin: "content" })).level, "confirm");        // no name
    const secret = await call("screen_act", { action: "type", n: 5, text: "x" }, { origin: "content" });
    assert.equal(secret.level, "need"); assert.match(secret.say, /password box/);
    const stopped = await call("screen_act", { action: "tap", n: 6 }, { origin: "content" });
    assert.equal(stopped.ok, false); assert.equal(stopped.say, "Okay, I stopped.");
    assert.ok(!ops.some(o => o.op === "screen_act" && o.args.n === 5));                                               // the password box never reached the device
    assert.deepEqual(asked.map(a => a.level), ["confirm", "confirm", "fingerprint", "confirm"]);
    // a locked app in front: nothing is read
    screen = { app: { id: "com.phonepe.app", name: "PhonePe" }, nodes: [{ n: 0, role: "text", text: "Balance ₹9,000" }] };
    const locked = await call("screen_read", {}, { origin: "brain" });
    assert.equal(locked.ok, false); assert.ok(!JSON.stringify(locked).includes("9,000"));
    assert.equal((await call("screen_act", { action: "tap", n: 0 }, { origin: "brain" })).level, "need");             // and nothing can be tapped
  } finally { stop(); }
});

test("screen tools: saying no stops the step", async () => {
  fresh();
  rt.state.scan = { apps: classifyAll([{ id: "com.blinkit", name: "Blinkit" }], "android") };
  rt.state.settings.screenApps = { "com.blinkit": true };
  const dev = await deviceFor((await pairDevice({ platform: "android" })).token);
  const ops = [];
  const stop = pretendDevice(dev, op => { ops.push(op); return { ok: true, data: { done: true } }; });
  autoAnswer(false);
  try {
    const r = await call("screen_open", { app: "Blinkit" }, { origin: "brain" });
    assert.equal(r.declined, true);
    assert.equal(ops.length, 0);
  } finally { stop(); }
});

test("email: drafts never send, sends ask first, addresses can't smuggle headers", async () => {
  const { rawEmail, isEmail } = await import("../server/mime.js");
  const { Parser } = await import("../public/reflex.js");
  const p = new Parser([{ name: "Rahul", aliases: [] }], []);
  assert.deepEqual(p.parse("draft an email to Rahul saying the deck is ready").map(s => [s.kind, s.args]), [["draft_email", { to: "Rahul", text: "the deck is ready" }]]);
  assert.equal(p.parse("email Rahul saying the deck is ready")[0].kind, "email");
  assert.equal(p.parse("read my emails and draft a reply to Rahul saying thanks").map(s => s.kind).join(), "read_email,draft_email");
  assert.ok(isEmail("a.b@example.co.in") && !isEmail("a@b.com\r\nBcc: x@y.com") && !isEmail("Rahul <r@x.com>") && !isEmail("nobody"));
  assert.throws(() => rawEmail({ to: "x@y.com\nBcc: z@y.com", text: "hi" }));
  const mail = Buffer.from(rawEmail({ to: "r@example.com", subject: "Deck ₹\r\nBcc: evil@x.com", text: "Ready.\r\nBcc: evil@x.com" }), "base64url").toString();
  assert.equal(mail.split("\r\n").filter(l => /^bcc:/i.test(l)).length, 0);                // nothing typed can become a header
  assert.ok(mail.startsWith("To: r@example.com\r\nSubject: =?UTF-8?B?"));

  fresh();
  rt.state.settings.apps.gmail = true;
  const sent = [], drafted = [];
  const asked = autoAnswer(true);
  // not connected to Google: a draft is a link you open, and nothing asks
  const d0 = await call("draft_email", { to: "Rahul", text: "The deck is ready" }, { origin: "you" });
  assert.equal(d0.level, "auto"); assert.ok(d0.open.startsWith("mailto:"));
  // connected, reading only: say how to fix it
  rt.google = { has: k => k === "gmail", canWrite: () => false, draftEmail: m => drafted.push(m), sendEmail: m => sent.push(m) };
  assert.match((await call("draft_email", { to: "Rahul", text: "Hi" }, { origin: "you" })).say, /Reconnect Gmail/);
  // connected with writing: a real draft, still no question; a send asks first
  rt.google.canWrite = () => true;
  const d1 = await call("draft_email", { to: "Rahul", subject: "Deck", text: "The deck is ready" }, { origin: "brain" });
  assert.equal(d1.ok, true); assert.equal(d1.level, "auto"); assert.equal(drafted.length, 1); assert.equal(sent.length, 0);
  assert.equal(asked.length, 0);
  const s1 = await call("send_email", { to: "someone@example.com", text: "Hello" }, { origin: "brain" });
  assert.equal(s1.level, "confirm"); assert.equal(s1.sent, true); assert.equal(sent[0].to, "someone@example.com");
  assert.equal((await call("draft_email", { to: "Rahul", text: "x" }, { origin: "content" })).level, "confirm");      // started by something it read
  assert.equal((await call("send_email", { to: "Bob <b@x.com>", text: "x" }, { origin: "you" })).level, "need");       // not a plain address
  rt.google = null;
});

test("open_app: the installed app on the device first, then the website, otherwise it says it couldn't find it", async () => {
  fresh();
  rt.state.scan = { apps: classifyAll([{ id: "com.google.Chrome", name: "Google Chrome" }, { id: "com.microsoft.VSCode", name: "Visual Studio Code" }, { id: "com.phonepe.app", name: "PhonePe" }], "macos") };
  const dev = await deviceFor((await pairDevice({ platform: "macos" })).token);
  const ops = [];
  const stop = pretendDevice(dev, op => { ops.push(op); return { ok: true, data: {} }; });
  try {
    const chrome = await call("open_app", { app: "chrome" }, { origin: "voice" });
    assert.equal(chrome.ok, true); assert.equal(chrome.open, undefined);
    assert.deepEqual(ops.map(o => [o.op, o.args.id]), [["open_app", "com.google.chrome"]]);
    assert.equal((await call("open_app", { app: "vscode" }, { origin: "voice" })).ok, true);
    const insta = await call("open_app", { app: "Instagram" }, { origin: "voice" });
    assert.equal(insta.ok, true); assert.equal(insta.open, "https://www.instagram.com");
    const nope = await call("open_app", { app: "zzqx" }, { origin: "voice" });
    assert.equal(nope.ok, false); assert.match(nope.say, /couldn't find "zzqx"/);
    assert.equal((await call("open_app", { app: "phonepe" }, { origin: "voice" })).ok, false);   // locked: never opened
    assert.equal(ops.length, 2);
  } finally { stop(); }
});
