// Code Mode: run many tool calls as ONE script, instead of one AI round-trip per call.
// Every call still goes through the safety guard. The script you see is exactly what runs:
//   * runPlan   - scripts built from your sentence (buildScript). Works everywhere, including Cloudflare.
//   * rt.runScript - free-form scripts written by an AI client (Node only: node:vm sandbox, see server/sandbox.js).
import { call, stepToCall } from "./tools.js";
import { rt } from "./runtime.js";

const js = v => JSON.stringify(v);
const clean = o => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined && x !== ""));

// Turn reflex steps into a script + the same thing as data (a plan). Steps that need "the ETA" point at the order.
export function buildScript(steps) {
  const lines = [], plan = [];
  let orderVar = null;
  steps.forEach((st, i) => {
    const c = stepToCall(st);
    if (!c) return;
    const [tool, raw] = c;
    const v = "r" + i;
    const args = clean(raw);
    const item = { v, tool, args, refs: {} };
    let src = js(args);
    if (st.dep && orderVar) {
      if (tool === "add_event") { item.args = { title: raw.title || "Food delivery" }; item.refs = { when: [orderVar, "eta"] }; src = `{ title: ${js(item.args.title)}, when: ${orderVar}.eta }`; }
      if (tool === "remind_me") { item.args = { text: raw.text }; item.refs = { when: [orderVar, "eta"] }; src = `{ text: ${js(raw.text)}, when: ${orderVar}.eta }`; }
      if (tool === "draft_message") { item.args = { to: raw.to }; item.refs = { text: [orderVar, "eta_text", "Hey! My food arrives at {}."] }; src = `{ to: ${js(raw.to)}, text: \`Hey! My food arrives at \${${orderVar}.eta_text}.\` }`; }
    }
    lines.push(`const ${v} = await tools.${tool}(${src});`, `if (!${v}.ok) return stop(${v}.say);`);
    plan.push(item);
    if (tool === "order_food") orderVar = v;
  });
  lines.push("return done();");
  return { code: lines.join("\n"), plan };
}

export async function runPlan(code, plan, { origin = "you" } = {}) {
  const id = "cm_" + Date.now().toString(36);
  const results = [], vars = {};
  const t0 = Date.now();
  rt.bus.emit("codemode", { id, phase: "start", code });
  let stopped = "";
  for (const it of plan) {
    const args = { ...it.args };
    for (const [k, [v, field, tpl]] of Object.entries(it.refs || {})) {
      const val = vars[v]?.[field];
      args[k] = tpl ? tpl.replace("{}", val) : val;
    }
    const r = await call(it.tool, args, { origin, via: "code mode" });
    results.push(r); vars[it.v] = r;
    rt.bus.emit("codemode", { id, phase: "call", tool: it.tool, ok: r.ok, say: r.say, ms: r.ms, index: results.length - 1 });
    if (!r.ok) { stopped = r.say; break; }
  }
  const said = results.filter(r => r.ok).map(r => r.say).join(" ");
  const out = { id, ok: results.length > 0 && !stopped, say: (said + (stopped ? " Stopped: " + stopped : "")).trim(), calls: results.length, results, ms: Date.now() - t0 };
  rt.bus.emit("codemode", { id, phase: "end", ok: out.ok, say: out.say, ms: out.ms, calls: out.calls });
  return out;
}
