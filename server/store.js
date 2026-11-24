// Node host: state and the diary live as files on this device. Fills the shared runtime (server/runtime.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rt, today, freshState, makeBus, makeApprovals, diaryHeader, diaryEntry, parseDiary } from "./runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.join(ROOT, "data");
export const DIARY_DIR = process.env.JASSI_DIARY || path.join(DATA, "diary");
const STATE_FILE = path.join(DATA, "state.json");

export const demo = JSON.parse(fs.readFileSync(path.join(DATA, "demo.json"), "utf8"));
export const state = (() => {
  try { return { ...freshState(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch { return freshState(); }
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

const _bus = makeBus();
export const bus = _bus;
export const approvals = makeApprovals(_bus);

export function diary(entry) {
  const file = path.join(DIARY_DIR, `${today()}.md`);
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, diaryHeader());
  const { md, item } = diaryEntry(entry);
  fs.appendFileSync(file, md);
  _bus.emit("diary", item);
  return item;
}
export function readDiary(days = 7) {
  if (!fs.existsSync(DIARY_DIR)) return [];
  return fs.readdirSync(DIARY_DIR).filter(f => f.endsWith(".md")).sort().slice(-days)
    .map(f => ({ file: f, text: fs.readFileSync(path.join(DIARY_DIR, f), "utf8") }));
}
export function diaryToday() {
  const file = path.join(DIARY_DIR, `${today()}.md`);
  return fs.existsSync(file) ? parseDiary(fs.readFileSync(file, "utf8")) : [];
}

Object.assign(rt, { demo, state, save, spentToday, addSpent, approvals, bus: _bus, diary, readDiary, diaryToday,
  diaryLabel: "on this device · " + path.relative(ROOT, DIARY_DIR), host: "node",
  me: { name: demo.user.name, role: "owner", local: true } });
