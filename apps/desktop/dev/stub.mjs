// Throwaway stub of the device channel (docs/native-contract.md §4). Dev only, never deployed.
//
//   node apps/desktop/dev/stub.mjs            → http://localhost:8799, token "dev-token"
//   PORT=9000 TOKEN=abc node apps/desktop/dev/stub.mjs
//
// The shell talks to:   GET  /api/device/next?wait=25      POST /api/device/result
// You drive it with:    POST /dev/op   {"op":"screen_read","args":{}}   → waits for the shell, returns its result
//                       GET  /dev/log                                    → everything the shell sent so far
//                       GET  /                                           → a blank page, so JASSI_URL can point here
import http from "node:http";

const PORT = Number(process.env.PORT || 8799);
const TOKEN = process.env.TOKEN || "dev-token";

let seq = 0;
const queue = [];            // ops waiting for the shell
const waiters = [];          // shell long-polls waiting for an op
const pending = new Map();   // op id → resolve(result)
const log = [];

const json = (res, code, body) => {
  const s = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(code, body === undefined ? {} : { "content-type": "application/json" });
  res.end(s);
};
const readBody = req => new Promise(done => {
  let s = "";
  req.on("data", c => (s += c));
  req.on("end", () => { try { done(s ? JSON.parse(s) : {}); } catch { done(null); } });
});
const authed = req => req.headers.authorization === `Bearer ${TOKEN}`;

function hand(op) {
  const w = waiters.shift();
  if (!w) return queue.push(op);
  clearTimeout(w.timer);
  json(w.res, 200, op);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/device/next" && req.method === "GET") {
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });
    if (queue.length) return json(res, 200, queue.shift());
    const wait = Math.min(Number(url.searchParams.get("wait")) || 25, 25);
    const w = { res, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); json(res, 204); }, wait * 1000) };
    waiters.push(w);
    req.on("close", () => { const i = waiters.indexOf(w); if (i >= 0) { clearTimeout(w.timer); waiters.splice(i, 1); } });
    return;
  }

  if (url.pathname === "/api/device/result" && req.method === "POST") {
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });
    const body = await readBody(req);
    if (!body || !body.id) return json(res, 400, { error: "bad_result" });
    log.push({ at: new Date().toISOString(), result: body });
    pending.get(body.id)?.(body);
    pending.delete(body.id);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/dev/op" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || !body.op) return json(res, 400, { error: "need { op, args }" });
    const op = { id: `op${++seq}`, op: body.op, args: body.args || {} };
    const result = await new Promise(done => {
      pending.set(op.id, done);
      hand(op);
      setTimeout(() => done({ id: op.id, ok: false, error: "stub: the shell did not answer in 30 s" }), 30000);
    });
    return json(res, 200, result);
  }

  if (url.pathname === "/dev/log") return json(res, 200, log);

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><meta charset=utf-8><title>J.A.S.S.I stub</title><body style='font:16px system-ui;background:#01060c;color:#d9f7ff;padding:40px'>J.A.S.S.I stub page</body>");
  }

  json(res, 404, { error: "not_found" });
}).listen(PORT, "127.0.0.1", () => console.log(`stub on http://localhost:${PORT}  token=${TOKEN}`));
