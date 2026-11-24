// The thinking brain is Claude Code, running on the owner's Mac (brain/bridge.js), the same way the JARVIS dashboard does it.
// The server hands it a question, Claude Code acts through J.A.S.S.I's MCP tools (so every action passes the same
// safety guard), and its answer comes back here. No API key anywhere.
//   Local (Node):  rt.brainLink  -> the bridge connected to this server
//   Cloudflare:    rt.brainAsk   -> the shared brain router (one bridge serves every signed-in user, each in their own Claude process)
import { rt, TZ, today } from "./runtime.js";

export const MEMBER_DAILY_QUESTIONS = 30;
const waiting = new Map();
let seq = 0;

export const tokenOk = t => !!rt.brainToken && t === rt.brainToken;
export const bearer = h => String(h?.authorization || "").replace(/^Bearer\s+/i, "");

function used() {
  const s = rt.state;
  if (!s.brainUsed || s.brainUsed.date !== today()) s.brainUsed = { date: today(), count: 0 };
  return s.brainUsed;
}
const limit = () => (rt.me?.role === "owner" ? Infinity : MEMBER_DAILY_QUESTIONS);
const left = () => Math.max(0, limit() - used().count);

export async function brainInfo() {
  let on = false;
  try { on = rt.brainOnline ? await rt.brainOnline() : (rt.brainLink?.count() || 0) > 0; } catch {}
  const l = left();
  return { on, model: "Claude Code", left: l === Infinity ? null : l, limit: limit() === Infinity ? null : limit() };
}

// Tiny things answered here, instantly, brain or not.
function quick(text) {
  const t = text.toLowerCase();
  if (/^(what('s| is) the )?time( is it| now)?\??$/.test(t)) return `It's ${new Date().toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" })}.`;
  if (/^(what('s| is) )?(today'?s date|the date|what day is it)( today)?\??$/.test(t)) return `Today is ${new Date().toLocaleDateString("en-IN", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" })}.`;
  if (/what can you do|^help$/.test(t)) return "I can order food, pay, add to your calendar, write WhatsApp messages and emails, set timers, search, play music, give directions and brief you on your business. Try: order my usual and WhatsApp Riya the ETA.";
  return null;
}

export async function ask(text) {
  const q = quick(text);
  if (q) return { say: q, brain: "quick" };
  if (!(await brainInfo()).on) return { say: "My thinking brain is offline right now. Direct commands still work.", brain: "off" };
  if (left() <= 0) return { say: `You've used today's ${MEMBER_DAILY_QUESTIONS} questions. Direct commands still work, and questions come back tomorrow.`, brain: "limit" };
  used().count++; rt.save();
  const id = "q" + (++seq) + "_" + Date.now().toString(36);
  rt.brainCtx = { id, tainted: false };       // becomes tainted once the brain reads outside content
  rt.bus.emit("thinking", { id });
  if (rt.brainAsk) {
    const r = await rt.brainAsk({ id, text, now: Date.now() });
    return { say: r.say || "Done.", brain: "claude-code" };
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ say: "That took too long, so I stopped.", brain: "claude-code" }); }, 180000);
    waiting.set(id, say => { clearTimeout(timer); resolve({ say: say || "Done.", brain: "claude-code" }); });
    rt.brainLink.send({ id, text, now: Date.now() });
  });
}

export function answer(id, say) {
  const f = waiting.get(id);
  if (!f) return false;
  waiting.delete(id);
  f(String(say || ""));
  return true;
}
