// J.A.S.S.I on your computer: dashboard + API + live events + MCP endpoint + Claude Code brain. No dependencies (Node 20+).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try { // tiny .env loader
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const { rt, makeBus } = await import("./runtime.js");
await import("./store.js");
await import("./sandbox.js");
const { api } = await import("./api.js");
const { tokenOk, bearer } = await import("./brain.js");

const PORT = +(process.env.PORT || 7777);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = path.join(ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json" };

// the private link to the Claude Code brain
rt.brainToken = process.env.BRAIN_TOKEN || crypto.randomBytes(24).toString("hex");
const brainBus = makeBus();
rt.brainLink = { count: () => brainBus.size, send: q => brainBus.emit("ask", q) };

const readBody = req => new Promise(r => { let b = ""; req.on("data", c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on("end", () => r(b)); });

function stream(req, res, bus, hello) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
  const off = bus.add({ send: m => res.write(m) });
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  return new Promise(done => res.on("close", () => { off(); clearInterval(ping); done(); }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/events") return stream(req, res, rt.bus, { at: Date.now() });
    if (url.pathname === "/api/brain/listen") {
      if (!tokenOk(bearer(req.headers))) { res.writeHead(401); return res.end(); }
      rt.bus.emit("brain", { on: true });
      await stream(req, res, brainBus, { at: Date.now() });
      return rt.bus.emit("brain", { on: brainBus.size > 0 });
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
      const r = await api(req.method, url.pathname, req.method === "POST" ? await readBody(req) : "", req.headers);
      if (r) { res.writeHead(r.status, { "content-type": r.type, ...(r.headers || {}) }); return res.end(r.body); }
      res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":"not found"}');
    }
    if (req.method !== "GET") { res.writeHead(405); return res.end(); }
    const file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, say: "Server error: " + e.message })); }
  }
});

server.listen(PORT, HOST, () => {
  const local = `http://localhost:${PORT}`;
  console.log(`\n  J.A.S.S.I is running →  ${local}`);
  console.log(`  MCP endpoint          →  ${local}/mcp`);
  console.log(`  Diary                 →  ${rt.diaryLabel}`);
  if (process.env.JASSI_BRAIN === "off") return console.log("  Brain                 →  off (JASSI_BRAIN=off)\n");
  console.log("  Brain                 →  starting Claude Code…\n");
  // Same idea as the JARVIS dashboard: one warm Claude Code process is the brain.
  const child = spawn(process.execPath, [path.join(ROOT, "brain", "bridge.js")], {
    env: { ...process.env, JASSI_URL: local, JASSI_BRAIN_TOKEN: rt.brainToken }, stdio: ["ignore", "inherit", "inherit"],
  });
  const stop = () => { try { child.kill(); } catch {} process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
});
