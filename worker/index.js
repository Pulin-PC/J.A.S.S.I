// J.A.S.S.I on Cloudflare: static dashboard (assets) + one Durable Object that holds state, approvals,
// live events, the diary and the link to the Claude Code brain. Same tools, guard and MCP code as the Node version.
import { DurableObject } from "cloudflare:workers";
import demo from "../data/demo.json";
import { rt, makeBus, makeApprovals, freshState, today, diaryHeader, diaryEntry, parseDiary } from "../server/runtime.js";
import { api } from "../server/api.js";
import { tokenOk, bearer } from "../server/brain.js";

const enc = new TextEncoder();

export class JassiHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const state = freshState();
    const diaryDays = new Map();          // "YYYY-MM-DD" -> markdown
    ctx.blockConcurrencyWhile(async () => {
      Object.assign(state, (await ctx.storage.get("state")) || {});
      for (const [k, v] of await ctx.storage.list({ prefix: "diary:" })) diaryDays.set(k.slice(6), v);
    });
    const bus = makeBus();
    this.brainBus = makeBus();
    const save = () => ctx.storage.put("state", state);
    const spentToday = () => { if (state.spent.date !== today()) state.spent = { date: today(), amount: 0 }; return state.spent.amount; };
    Object.assign(rt, {
      demo, state, bus, approvals: makeApprovals(bus), host: "cloudflare",
      save, spentToday, addSpent: n => { spentToday(); state.spent.amount += n; save(); },
      diary: entry => {
        const day = today();
        const { md, item } = diaryEntry(entry);
        const text = (diaryDays.get(day) || diaryHeader()) + md;
        diaryDays.set(day, text);
        ctx.storage.put("diary:" + day, text);
        bus.emit("diary", item);
        return item;
      },
      readDiary: (days = 7) => [...diaryDays.keys()].sort().slice(-days).map(d => ({ file: d + ".md", text: diaryDays.get(d) })),
      diaryToday: () => parseDiary(diaryDays.get(today())),
      diaryLabel: "kept in Cloudflare · download: /api/diary.md",
      brainToken: env.BRAIN_TOKEN || "",
      brainLink: { count: () => this.brainBus.size, send: q => this.brainBus.emit("ask", q) },
      runScript: null,                    // Workers can't run new code at runtime; Code Mode from your sentence still works
    });
  }

  stream(bus, onClose) {
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    let off = () => {};
    const close = () => { off(); clearInterval(ping); onClose?.(); };
    const send = m => { w.write(enc.encode(m)).catch(close); };
    off = bus.add({ send });
    send(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    const ping = setInterval(() => send(": ping\n\n"), 15000);
    return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/events") return this.stream(rt.bus);
    if (url.pathname === "/api/brain/listen") {
      if (!tokenOk(bearer({ authorization: request.headers.get("authorization") }))) return new Response("no", { status: 401 });
      const res = this.stream(this.brainBus, () => rt.bus.emit("brain", { on: this.brainBus.size > 0 }));
      rt.bus.emit("brain", { on: true });
      return res;
    }
    const headers = Object.fromEntries(request.headers);
    const r = await api(request.method, url.pathname, request.method === "POST" ? await request.text() : "", headers);
    if (!r) return Response.json({ error: "not found" }, { status: 404 });
    return new Response(r.body, { status: r.status, headers: { "content-type": r.type, ...(r.headers || {}) } });
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/") || pathname === "/mcp") return env.HUB.get(env.HUB.idFromName("main")).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
