// Screen control: the server's end of the private line to a native app (docs/native-contract.md §4).
// The app asks "anything for me?" with short requests (/api/device/next), does one thing, and reports back
// (/api/device/result). Every screen tool in tools.js goes through deviceOp(), after the safety guard.
import { rt } from "./runtime.js";

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const rand = n => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const hashToken = async t => hex(await crypto.subtle.digest("SHA-256", enc.encode(String(t || ""))));

const PLATFORMS = ["android", "ios", "macos", "windows"];
const ONLINE_MS = 40000;      // the app polls every 25 s at most
const MAX_DEVICES = 8;
export const SESSION_MS = 10 * 60e3;   // "let me work in this app" lasts this long

// One per person, in memory only: nothing about a screen is ever stored.
export function makeDeviceHub() {
  return { queue: [], wakers: new Set(), waiting: new Map(), seen: new Map(), last: null, sessions: new Map() };
}

// ---------------------------------------------------------------- pairing
export async function pairDevice({ platform, name } = {}) {
  const devices = (rt.state.devices ||= {});
  const id = "dev_" + rand(6), token = "jd_" + rand(32);
  const old = Object.values(devices).sort((a, b) => a.at - b.at);
  while (old.length >= MAX_DEVICES) unpairDevice(old.shift().id);
  devices[id] = { id, platform: PLATFORMS.includes(platform) ? platform : "unknown", name: String(name || platform || "Device").slice(0, 40), hash: await hashToken(token), at: Date.now() };
  rt.save();
  await rt.registerDevice?.(devices[id].hash);   // Cloudflare: lets the Worker route this token to this person's space
  return { deviceId: id, token };                // the token is shown once and only its hash is kept
}
export function unpairDevice(id) {
  const d = rt.state.devices?.[id];
  if (!d) return false;
  delete rt.state.devices[id]; rt.save();
  rt.deviceHub?.seen.delete(id);
  rt.unregisterDevice?.(d.hash);
  return true;
}
export async function deviceFor(token) {
  if (!String(token || "").startsWith("jd_")) return null;
  const h = await hashToken(token);
  return Object.values(rt.state.devices || {}).find(d => d.hash === h) || null;
}
export function listDevices() {
  const seen = rt.deviceHub?.seen || new Map();
  return Object.values(rt.state.devices || {}).map(d => ({ id: d.id, platform: d.platform, name: d.name, online: Date.now() - (seen.get(d.id) || 0) < ONLINE_MS }));
}
function onlineDevice() {
  const hub = rt.deviceHub;
  let best = null;
  for (const d of Object.values(rt.state.devices || {})) {
    const at = hub.seen.get(d.id) || 0;
    if (Date.now() - at < ONLINE_MS && (!best || at > best.at)) best = { id: d.id, at };
  }
  return best;
}

// ---------------------------------------------------------------- the device's side
export async function nextOp(device, waitMs = 0) {
  const hub = rt.deviceHub;
  const take = () => {
    hub.seen.set(device.id, Date.now());
    const i = hub.queue.findIndex(o => o.device === device.id);
    return i < 0 ? null : hub.queue.splice(i, 1)[0];
  };
  let op = take();
  if (!op && waitMs > 0) {
    await new Promise(resolve => {
      const done = () => { clearTimeout(t); hub.wakers.delete(done); resolve(); };
      const t = setTimeout(done, waitMs);
      hub.wakers.add(done);
    });
    op = take();
  }
  return op ? { id: op.id, op: op.op, args: op.args } : null;
}
export function deviceResult(device, { id, ok, data, error } = {}) {
  const hub = rt.deviceHub;
  const w = hub.waiting.get(id);
  if (!w || w.device !== device.id) return false;   // only the device that was asked may answer
  hub.waiting.delete(id);
  w.done({ ok: !!ok, data: ok ? data : undefined, error: ok ? undefined : String(error || "failed").slice(0, 60), device: device.id });
  return true;
}

// ---------------------------------------------------------------- the brain's side
export function deviceOp(op, args = {}, timeoutMs = 20000) {
  const hub = rt.deviceHub;
  const dev = onlineDevice();
  if (!dev) return Promise.resolve({ ok: false, error: "offline" });
  const id = "op_" + rand(9);
  return new Promise(resolve => {
    const t = setTimeout(() => { hub.waiting.delete(id); hub.queue = hub.queue.filter(o => o.id !== id); resolve({ ok: false, error: "timeout" }); }, timeoutMs);
    hub.waiting.set(id, { device: dev.id, done: r => { clearTimeout(t); resolve(r); } });
    hub.queue.push({ id, op, args, device: dev.id });
    for (const w of [...hub.wakers]) w();
  });
}

// Plain words for every way a screen step can fail.
export const DEVICE_SAY = {
  offline: "I can't reach your device. Open the J.A.S.S.I app on your phone or computer and try again.",
  timeout: "Your device didn't answer in time.",
  stopped: "Okay, I stopped.",
  blocked_app: "That app is locked. I never work inside money, ID or password apps.",
  secure_field: "That's a password box. Please type it yourself.",
  protected_screen: "I'm not allowed to touch that screen. Please do this step yourself.",
  unsupported: "This device can't do that.",
};
export const deviceSay = e => DEVICE_SAY[e] || "That didn't work on your device.";
