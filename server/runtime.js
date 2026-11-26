// Host-neutral runtime. The tools, brain and MCP code only talk to `rt`, so the same code runs in
// Node (server/store.js fills rt) and on Cloudflare (worker/index.js: one Durable Object per user fills rt).
// On Cloudflare several users' objects can share one isolate, so `rt` resolves per request through
// AsyncLocalStorage: withRt(userRuntime, fn) - nothing leaks between users.
import { AsyncLocalStorage } from "node:async_hooks";

export const TZ = "Asia/Kolkata";

const als = new AsyncLocalStorage();
const base = {
  demo: null,        // data/demo.json
  state: null,       // see freshState()
  save() {},
  spentToday() { return 0; },
  addSpent() {},
  approvals: null,   // makeApprovals(bus)
  bus: null,         // makeBus()
  diary() {},        // write one diary entry
  readDiary() { return []; },  // [{file, text}] for recent days
  diaryToday() { return []; },
  runScript: null,   // free-form Code Mode (Node only)
  google: null,      // real Google Calendar / Gmail (Cloudflare, when connected)
  deviceHub: null,   // makeDeviceHub(): the line to the native apps for screen control (server/device.js)
  me: { name: "You", role: "owner" },
  host: "node",
};
export const rt = new Proxy(base, {
  get(t, k) { const s = als.getStore(); return s && k in s ? s[k] : t[k]; },
  set(t, k, v) { const s = als.getStore(); (s || t)[k] = v; return true; },
});
export const withRt = (ctx, fn) => als.run(ctx, fn);

export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });           // YYYY-MM-DD
export const clock = () => new Date().toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false }); // HH:MM:SS
export const hhmm = ts => new Date(ts).toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });

export const DEFAULT_SETTINGS = { apps: {}, autoPayUnder: 5000, dailyCap: 10000 };
export const freshState = () => ({ spent: { date: today(), amount: 0 }, payments: [], events: [], timers: [], outbox: [], lastOrder: null, orders: [],
  settings: { ...DEFAULT_SETTINGS, apps: {} }, onboarded: false, brainUsed: { date: today(), count: 0 } });

// ---------------------------------------------------------------- live event bus
export function makeBus() {
  const clients = new Set();   // each: { send(text) } -> false when the client is gone
  return {
    add(c) { clients.add(c); return () => clients.delete(c); },
    emit(type, data) {
      const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of clients) { try { if (c.send(msg) === false) clients.delete(c); } catch { clients.delete(c); } }
    },
    get size() { return clients.size; },
  };
}

// ---------------------------------------------------------------- approvals ("needs your OK")
export function makeApprovals(bus) {
  const pending = new Map();
  let seq = 0;
  return {
    request({ level, title, detail, tool, args, origin, reason }) {
      const id = "ok_" + (++seq) + "_" + Date.now().toString(36);
      const item = { id, level, title, detail, tool, args, origin, reason, at: Date.now(), timeoutMs: 60000 };
      return new Promise(resolve => {
        const finish = (yes, why) => {
          if (!pending.has(id)) return;
          clearTimeout(timer); pending.delete(id);
          bus.emit("approval_done", { id, yes, why });
          resolve(yes);
        };
        const timer = setTimeout(() => finish(false, "timed out"), item.timeoutMs);
        pending.set(id, { item, finish });
        bus.emit("approval", item);
      });
    },
    answer(id, yes) {
      const p = pending.get(id);
      if (!p) return false;
      p.finish(!!yes, yes ? "approved" : "declined");
      return true;
    },
    list() { return [...pending.values()].map(p => p.item); },
  };
}

// ---------------------------------------------------------------- diary as Obsidian-style markdown
export const diaryHeader = () => `---\ntype: jassi-diary\ndate: ${today()}\ntags: [jassi, diary]\n---\n# J.A.S.S.I diary · ${today()}\n`;

export function diaryEntry(entry) {
  const time = clock();
  const lines = [`\n## ${time} · ${entry.title}`, `- tool: \`${entry.tool}\``, `- asked by: ${entry.origin}`,
    `- decision: ${entry.decision}${entry.reason ? " (" + entry.reason + ")" : ""}`];
  if (entry.result) lines.push(`- result: ${entry.result}`);
  return { md: lines.join("\n") + "\n", item: { time, ts: Date.now(), ...entry } };
}

export function parseDiary(text) {
  const out = [];
  for (const block of String(text || "").split("\n## ").slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [time, ...title] = head.split(" · ");
    const get = k => (rest.find(l => l.startsWith(`- ${k}: `)) || "").slice(k.length + 4);
    out.push({ time, title: title.join(" · "), tool: get("tool").replace(/`/g, ""), origin: get("asked by"),
      decision: get("decision").split(" (")[0], result: get("result") });
  }
  return out.reverse();
}
