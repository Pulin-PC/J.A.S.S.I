// J.A.S.S.I server: dashboard + API + live events + MCP endpoint. No dependencies (Node 20+).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// tiny .env loader (no dotenv)
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const { demo, state, bus, approvals, spentToday, diaryToday, DIARY_DIR } = await import("./store.js");
const { call, stepToCall, TOOLS } = await import("./tools.js");
const { buildScript, runScript } = await import("./codemode.js");
const { ask, brainInfo } = await import("./brain.js");
const { mcpHandler } = await import("./mcp.js");
const { LIMITS } = await import("./guard.js");

const PORT = +(process.env.PORT || 7777);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = path.join(ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ""; req.on("data", c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on("end", () => r(b)); });

function snapshot() {
  return {
    user: demo.user,
    apps: demo.apps,
    contacts: demo.contacts.map(c => ({ name: c.name, aliases: c.aliases })),
    blocked: demo.blocked_apps,
    limits: LIMITS,
    spentToday: spentToday(),
    events: state.events.filter(e => e.when > Date.now() - 3600e3).sort((a, b) => a.when - b.when),
    timers: state.timers.filter(t => t.fireAt > Date.now()),
    lastOrder: state.lastOrder,
    diary: diaryToday().slice(0, 40),
    pending: approvals.list(),
    brain: brainInfo(),
    tools: TOOLS.map(t => ({ name: t.name, kind: t.kind, app: t.app })),
    diaryDir: path.relative(ROOT, DIARY_DIR),
  };
}

const routes = {
  "GET /api/state": (req, res) => json(res, 200, snapshot()),
  "GET /api/events": (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    bus.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    res.on("close", () => clearInterval(ping));
  },
  "POST /api/step": async (req, res, body) => {
    const { step, early } = JSON.parse(body || "{}");
    const c = stepToCall(step || {});
    if (!c) return json(res, 200, { ok: false, say: "I didn't get that." });
    json(res, 200, await call(c[0], c[1], { origin: "you", early: !!early, via: "voice" }));
  },
  "POST /api/run": async (req, res, body) => {
    const { steps = [] } = JSON.parse(body || "{}");
    const code = buildScript(steps);
    json(res, 200, { code, ...(await runScript(code, { origin: "you" })) });
  },
  "POST /api/script": async (req, res, body) => {
    const { code = "" } = JSON.parse(body || "{}");
    json(res, 200, await runScript(String(code), { origin: "you" }));
  },
  "POST /api/tool": async (req, res, body) => {
    const { name, args } = JSON.parse(body || "{}");
    json(res, 200, await call(name, args || {}, { origin: "you", via: "tap" }));
  },
  "POST /api/ask": async (req, res, body) => {
    const { text = "" } = JSON.parse(body || "{}");
    try { json(res, 200, await ask(String(text))); } catch (e) { json(res, 200, { say: "My brain couldn't connect: " + e.message }); }
  },
  "POST /api/approve": (req, res, body) => {
    const { id, yes } = JSON.parse(body || "{}");
    json(res, 200, { ok: approvals.answer(id, yes) });
  },
  // Demo of the prompt-injection guard: the brain read the scam email and now "wants" to pay.
  "POST /api/attack": async (req, res) => {
    json(res, 200, await call("pay", { to: "refunds@okscam", amount: 4999, note: "refund claim (from an email)" }, { origin: "content", via: "brain" }));
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/mcp") return mcpHandler(req, res, await readBody(req));
    const ics = url.pathname.match(/^\/api\/ics\/([\w-]+)$/);
    if (ics) {
      const ev = state.events.find(e => e.id === ics[1]);
      if (!ev) return json(res, 404, { error: "not found" });
      const f = t => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      res.writeHead(200, { "content-type": "text/calendar", "content-disposition": `attachment; filename="${ev.id}.ics"` });
      return res.end(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//JASSI//EN", "BEGIN:VEVENT", `UID:${ev.id}@jassi`, `DTSTAMP:${f(Date.now())}`,
        `DTSTART:${f(ev.when)}`, `DTEND:${f(ev.when + 30 * 60e3)}`, `SUMMARY:${ev.title}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n"));
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res, req.method === "POST" ? await readBody(req) : "");
    if (req.method !== "GET") return json(res, 404, { error: "not found" });
    let file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false, say: "Server error: " + e.message });
  }
});

server.listen(PORT, HOST, () => {
  const b = brainInfo();
  console.log(`\n  J.A.S.S.I is running →  http://localhost:${PORT}`);
  console.log(`  MCP endpoint          →  http://localhost:${PORT}/mcp`);
  console.log(`  Brain                 →  ${b.on ? b.model : "off (add ANTHROPIC_API_KEY to .env for questions)"}`);
  console.log(`  Diary                 →  ${DIARY_DIR}\n`);
});
