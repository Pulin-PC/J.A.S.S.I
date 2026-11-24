// Host-neutral runtime. The tools, brain and MCP code only talk to `rt`, so the same code runs in
// Node (server/store.js fills rt) and on Cloudflare (worker/index.js, a Durable Object, fills rt).
export const TZ = "Asia/Kolkata";

export const rt = {
  demo: null,        // data/demo.json
  state: null,       // { spent, payments, events, timers, outbox, lastOrder, orders }
  save() {},
  spentToday() { return 0; },
  addSpent() {},
  approvals: null,   // makeApprovals(bus)
  bus: null,         // makeBus()
  diary() {},        // write one diary entry
  readDiary() { return []; },  // [{file, text}] for recent days
  runScript: null,   // Code Mode runner (Node: sandbox; Cloudflare: off for free-form scripts)
  host: "node",
};

export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });           // YYYY-MM-DD
export const clock = () => new Date().toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false }); // HH:MM:SS
export const hhmm = ts => new Date(ts).toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });

export const freshState = () => ({ spent: { date: today(), amount: 0 }, payments: [], events: [], timers: [], outbox: [], lastOrder: null, orders: [] });

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
