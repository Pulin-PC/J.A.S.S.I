// Node only: free-form Code Mode scripts (written by an AI client through MCP `run_script`).
// The script sees only `tools.*`, `done()`, `stop()` and `console.log` - no files, no network, no keys.
// Prototype sandbox: node:vm with an empty global. node:vm is NOT a security boundary, so this runs only on your own
// computer, behind the local-only API check in server/index.js. Production plan: an isolated worker / V8 isolate.
import vm from "node:vm";
import { call, TOOLS } from "./tools.js";
import { rt } from "./runtime.js";

export async function runScript(code, { origin = "you", via = "code mode" } = {}) {
  const id = "cm_" + Date.now().toString(36);
  const results = [], log = [], tools = {};
  for (const t of TOOLS) {
    tools[t.name] = async (args = {}) => {
      const r = await call(t.name, args, { origin: rt.originFor?.(origin) || origin, via });
      results.push(r);
      rt.bus.emit("codemode", { id, phase: "call", tool: t.name, ok: r.ok, say: r.say, ms: r.ms, index: results.length - 1 });
      return Object.freeze({ ...r });
    };
  }
  let finalSay = "";
  const sandbox = {
    tools: Object.freeze(tools),
    console: { log: (...a) => log.push(a.map(String).join(" ")) },
    done: s => { finalSay = s || results.filter(r => r.ok).map(r => r.say).join(" "); return finalSay; },
    stop: s => { finalSay = (results.filter(r => r.ok).map(r => r.say).join(" ") + " Stopped: " + s).trim(); return finalSay; },
  };
  rt.bus.emit("codemode", { id, phase: "start", code });
  const t0 = Date.now();
  try {
    const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const p = vm.runInContext(`(async () => {\n${code}\n})()`, ctx, { timeout: 1000, filename: "codemode.js" });
    await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("script took too long")), 120000))]);
  } catch (e) {
    finalSay = (finalSay || "") + " Script error: " + e.message;
  }
  const out = { id, ok: results.length > 0 && results.every(r => r.ok), say: finalSay.trim(), calls: results.length, results, log, ms: Date.now() - t0 };
  rt.bus.emit("codemode", { id, phase: "end", ok: out.ok, say: out.say, ms: out.ms, calls: out.calls });
  return out;
}

rt.runScript = runScript;
