// State (on this device only), the action diary (Obsidian-style markdown), and the live event bus.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.join(ROOT, "data");
export const DIARY_DIR = process.env.JASSI_DIARY || path.join(DATA, "diary");
const STATE_FILE = path.join(DATA, "state.json");

export const demo = JSON.parse(fs.readFileSync(path.join(DATA, "demo.json"), "utf8"));

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD (local)

const fresh = () => ({ spent: { date: today(), amount: 0 }, payments: [], events: [], timers: [], outbox: [], lastOrder: null, orders: [] });
export const state = (() => {
  try { return { ...fresh(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch { return fresh(); }
})();

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {}), 50);
}

export function spentToday() {
  if (state.spent.date !== today()) state.spent = { date: today(), amount: 0 };
  return state.spent.amount;
}
export function addSpent(n) { spentToday(); state.spent.amount += n; save(); }

// ---------------------------------------------------------------- event bus (Server-Sent Events)
const clients = new Set();
export const bus = {
  add(res) { clients.add(res); res.on("close", () => clients.delete(res)); },
  emit(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  },
};

// ---------------------------------------------------------------- approvals ("needs your OK")
const pending = new Map();
let seq = 0;
export const approvals = {
  request({ level, title, detail, tool, args, origin, reason }) {
    const id = "ok_" + (++seq) + "_" + Date.now().toString(36);
    const item = { id, level, title, detail, tool, args, origin, reason, at: Date.now(), timeoutMs: 60000 };
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(false, "timed out"), item.timeoutMs);
      const finish = (yes, why) => {
        if (!pending.has(id)) return;
        clearTimeout(timer); pending.delete(id);
        bus.emit("approval_done", { id, yes, why });
        resolve(yes);
      };
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

// ---------------------------------------------------------------- diary
const pad = n => String(n).padStart(2, "0");
export function diary(entry) {
  const d = new Date();
  const file = path.join(DIARY_DIR, `${today()}.md`);
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `---\ntype: jassi-diary\ndate: ${today()}\ntags: [jassi, diary]\n---\n# J.A.S.S.I diary · ${d.toDateString()}\n`);
  }
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const lines = [`\n## ${t} · ${entry.title}`,
    `- tool: \`${entry.tool}\``,
    `- asked by: ${entry.origin}`,
    `- decision: ${entry.decision}${entry.reason ? " (" + entry.reason + ")" : ""}`];
  if (entry.result) lines.push(`- result: ${entry.result}`);
  fs.appendFileSync(file, lines.join("\n") + "\n");
  const item = { time: t, ts: d.getTime(), ...entry };
  bus.emit("diary", item);
  return item;
}

export function readDiary(days = 7) {
  if (!fs.existsSync(DIARY_DIR)) return [];
  return fs.readdirSync(DIARY_DIR).filter(f => f.endsWith(".md")).sort().slice(-days)
    .map(f => ({ file: f, text: fs.readFileSync(path.join(DIARY_DIR, f), "utf8") }));
}

// Today's entries as objects, newest first (for the dashboard on reload).
export function diaryToday() {
  const file = path.join(DIARY_DIR, `${today()}.md`);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const block of fs.readFileSync(file, "utf8").split("\n## ").slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [time, ...title] = head.split(" · ");
    const get = k => (rest.find(l => l.startsWith(`- ${k}: `)) || "").slice(k.length + 4);
    out.push({ time, title: title.join(" · "), tool: get("tool").replace(/`/g, ""), origin: get("asked by"),
      decision: get("decision").split(" (")[0], result: get("result") });
  }
  return out.reverse();
}
