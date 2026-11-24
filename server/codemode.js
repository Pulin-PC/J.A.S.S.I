// Code Mode: run many tool calls as ONE script, instead of one AI round-trip per call.
// The script only sees `tools.*` (every call still goes through the safety guard) - no files, no network, no keys.
// Prototype sandbox: node:vm with an empty global. Production plan: an isolated worker / V8 isolate.
import vm from "node:vm";
import { call, stepToCall, TOOLS } from "./tools.js";
import { bus } from "./store.js";

const js = v => JSON.stringify(v);

// Turn reflex steps into a script. Steps that need an earlier result ("the ETA") point at it.
export function buildScript(steps) {
  const lines = [];
  let orderVar = null;
  steps.forEach((st, i) => {
    const c = stepToCall(st);
    if (!c) return;
    const [name, args] = c;
    const v = "r" + i;
    let argSrc = js(Object.fromEntries(Object.entries(args).filter(([, x]) => x !== undefined && x !== "")));
    if (st.dep && orderVar) {
      if (name === "add_event") argSrc = `{ title: ${js(args.title || "Food delivery")}, when: ${orderVar}.eta }`;
      if (name === "remind_me") argSrc = `{ text: ${js(args.text)}, when: ${orderVar}.eta }`;
      if (name === "draft_message") argSrc = `{ to: ${js(args.to)}, text: \`Hey! My food arrives at \${${orderVar}.eta_text}.\` }`;
    }
    lines.push(`const ${v} = await tools.${name}(${argSrc});`);
    lines.push(`if (!${v}.ok) return stop(${v}.say);`);
    if (name === "order_food") orderVar = v;
  });
  lines.push(`return done();`);
  return lines.join("\n");
}

export async function runScript(code, { origin = "you" } = {}) {
  const id = "cm_" + Date.now().toString(36);
  const results = [];
  const log = [];
  const tools = {};
  for (const t of TOOLS) {
    tools[t.name] = async (args = {}) => {
      const r = await call(t.name, args, { origin, via: "code mode" });
      results.push(r);
      bus.emit("codemode", { id, phase: "call", tool: t.name, ok: r.ok, say: r.say, ms: r.ms, index: results.length - 1 });
      return Object.freeze({ ...r });
    };
  }
  let finalSay = "";
  const sandbox = {
    tools: Object.freeze(tools),
    console: { log: (...a) => log.push(a.map(String).join(" ")) },
    done: (s) => { finalSay = s || results.filter(r => r.ok).map(r => r.say).join(" "); return finalSay; },
    stop: (s) => { finalSay = (results.filter(r => r.ok).map(r => r.say).join(" ") + " Stopped: " + s).trim(); return finalSay; },
  };
  bus.emit("codemode", { id, phase: "start", code });
  const t0 = Date.now();
  try {
    const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const p = vm.runInContext(`(async () => {\n${code}\n})()`, ctx, { timeout: 1000, filename: "codemode.js" });
    await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("script took too long")), 120000))]);
  } catch (e) {
    finalSay = (finalSay || "") + " Script error: " + e.message;
  }
  const out = { id, ok: results.length > 0 && results.every(r => r.ok), say: finalSay.trim(), calls: results.length, results, log, ms: Date.now() - t0 };
  bus.emit("codemode", { id, phase: "end", ok: out.ok, say: out.say, ms: out.ms, calls: out.calls });
  return out;
}
