// Host-neutral API routes (Node server and Cloudflare Durable Object both use this).
// Live streams (/api/events, /api/brain/listen) and static files are handled by each host.
import { rt, freshState } from "./runtime.js";
import { call, stepToCall, TOOLS } from "./tools.js";
import { buildScript, runPlan } from "./codemode.js";
import { ask, answer, brainInfo, tokenOk, bearer } from "./brain.js";
import { mcpRespond } from "./mcp.js";
import { LIMITS } from "./guard.js";

const J = (status, obj) => ({ status, type: "application/json", body: JSON.stringify(obj) });
const parse = t => { try { return JSON.parse(t || "{}") || {}; } catch { return {}; } };

export async function snapshot() {
  const { demo, state } = rt;
  return {
    me: rt.me, settings: state.settings, onboarded: !!state.onboarded,
    google: rt.google ? { available: true, calendar: rt.google.has("calendar"), gmail: rt.google.has("gmail"), email: rt.google.email || "" } : { available: false },
    user: demo.user, apps: demo.apps,
    contacts: demo.contacts.map(c => ({ name: c.name, aliases: c.aliases })),
    blocked: demo.blocked_apps, limits: LIMITS, spentToday: rt.spentToday(),
    events: state.events.filter(e => e.when > Date.now() - 3600e3).sort((a, b) => a.when - b.when),
    timers: state.timers.filter(t => t.fireAt > Date.now()),
    lastOrder: state.lastOrder,
    diary: rt.diaryToday().slice(0, 40),
    pending: rt.approvals.list(),
    brain: await brainInfo(),
    tools: TOOLS.map(t => ({ name: t.name, kind: t.kind, app: t.app })),
    diaryDir: rt.diaryLabel, host: rt.host,
  };
}

function ics(id) {
  const ev = rt.state.events.find(e => e.id === id);
  if (!ev) return J(404, { error: "not found" });
  const f = t => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { status: 200, type: "text/calendar", headers: { "content-disposition": `attachment; filename="${ev.id}.ics"` },
    body: ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//JASSI//EN", "BEGIN:VEVENT", `UID:${ev.id}@jassi`, `DTSTAMP:${f(Date.now())}`,
      `DTSTART:${f(ev.when)}`, `DTEND:${f(ev.when + 30 * 60e3)}`, `SUMMARY:${ev.title}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n") };
}

// returns { status, type, body, headers? } or null when the path isn't an API route
export async function api(method, path, bodyText, headers = {}) {
  if (path === "/mcp") return mcpRespond(method, bodyText, headers);
  const m = path.match(/^\/api\/ics\/([\w-]+)$/);
  if (m) return ics(m[1]);
  if (method === "GET" && path === "/api/diary.md") return { status: 200, type: "text/markdown; charset=utf-8", body: rt.readDiary(1).map(d => d.text).join("\n") || "# Diary is empty\n" };
  const b = method === "POST" ? parse(bodyText) : {};
  switch (`${method} ${path}`) {
    case "GET /api/state": return J(200, await snapshot());
    // Settings: which apps are connected, money rules, onboarding done. Money rules are clamped by the guard too.
    case "POST /api/settings": {
      const st = rt.state.settings;
      if (b.apps && typeof b.apps === "object") {
        const ok = new Set(rt.demo.apps.filter(a => a.tier !== "blocked").map(a => a.id));
        for (const [k, v] of Object.entries(b.apps)) if (ok.has(k)) st.apps[k] = !!v;
      }
      if (b.autoPayUnder !== undefined) st.autoPayUnder = Math.max(0, Math.min(LIMITS.autoPayUnder, Math.round(+b.autoPayUnder || 0)));
      if (b.dailyCap !== undefined) st.dailyCap = Math.max(500, Math.min(50000, Math.round(+b.dailyCap || 0)));
      if (b.onboarded !== undefined) rt.state.onboarded = !!b.onboarded;
      rt.save();
      return J(200, { ok: true, settings: st, onboarded: rt.state.onboarded });
    }
    // Start over with fresh demo data (keeps your apps and money rules).
    case "POST /api/reset": {
      const keep = { settings: rt.state.settings, onboarded: rt.state.onboarded, brainUsed: rt.state.brainUsed };
      for (const k of Object.keys(rt.state)) delete rt.state[k];
      Object.assign(rt.state, freshState(), keep);
      rt.save();
      return J(200, { ok: true });
    }
    case "POST /api/step": {
      const c = stepToCall(b.step || {});
      if (!c) return J(200, { ok: false, say: "I didn't get that." });
      return J(200, await call(c[0], c[1], { origin: "you", early: !!b.early, via: "voice" }));
    }
    case "POST /api/run": {
      const { code, plan } = buildScript(b.steps || []);
      return J(200, { code, ...(await runPlan(code, plan, { origin: "you" })) });
    }
    case "POST /api/tool": return J(200, await call(b.name, b.args || {}, { origin: "you", via: "tap" }));
    case "POST /api/ask": return J(200, await ask(String(b.text || "")));
    case "POST /api/approve": return J(200, { ok: rt.approvals.answer(b.id, b.yes) });
    // Demo of the prompt-injection guard: the brain read the scam email and now "wants" to pay.
    case "POST /api/attack": return J(200, await call("pay", { to: "refunds@okscam", amount: 4999, note: "refund claim (from an email)" }, { origin: "content", via: "brain" }));
    // The Claude Code bridge posts its answers here (needs the brain token).
    case "POST /api/brain/answer":
      if (!tokenOk(bearer(headers))) return J(401, { ok: false });
      return J(200, { ok: answer(b.id, b.say) });
  }
  return null;
}
