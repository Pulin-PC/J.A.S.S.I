// The thinking brain is Claude Code, running on your Mac (brain/bridge.js), the same way the JARVIS dashboard does it.
// The server hands it a question over a private link, Claude Code acts through J.A.S.S.I's MCP tools
// (so every action passes the same safety guard), and its answer comes back here. No API key anywhere.
import { rt, TZ } from "./runtime.js";

const waiting = new Map();
let seq = 0;

export const brainInfo = () => ({ on: (rt.brainLink?.count() || 0) > 0, model: "Claude Code" });
export const tokenOk = t => !!rt.brainToken && t === rt.brainToken;
export const bearer = h => String(h?.authorization || "").replace(/^Bearer\s+/i, "");

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
  if (!brainInfo().on) return { say: "My thinking brain is offline. Start Claude Code on the Mac with: npm run brain.", brain: "off" };
  const id = "q" + (++seq) + "_" + Date.now().toString(36);
  rt.brainCtx = { id, tainted: false };       // becomes tainted once the brain reads outside content
  rt.bus.emit("thinking", { id });
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
