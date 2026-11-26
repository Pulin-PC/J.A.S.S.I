// J.A.S.S.I on Cloudflare.
//   Worker      : Google sign-in, invite links, sessions; routes each person to THEIR OWN space.
//   JassiHub    : one Durable Object per person - state, approvals, live events, diary, Google Calendar/Gmail.
//   JassiDirectory : one Durable Object for accounts, invites, personal MCP keys, and the Claude Code brain router.
// Same tools, guard and MCP code as the Node version (server/*).
import { DurableObject } from "cloudflare:workers";
import demo from "../data/demo.json";
import { withRt, makeBus, makeApprovals, freshState, today, hhmm, diaryHeader, diaryEntry, parseDiary } from "../server/runtime.js";
import { api } from "../server/api.js";
import { makeDeviceHub, hashToken } from "../server/device.js";
import { rawEmail } from "../server/mime.js";
import { cookies, setCookie, sign, unsign, randomId, pkce, b64url, googleAuthUrl, googleToken, readIdToken, SCOPES } from "./auth.js";

const enc = new TextEncoder();
const SESSION = "jassi_s", OAUTH = "jassi_o", INVITE = "jassi_inv";
const DAY = 86400e3;

function sse(bus, onClose) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  let off = () => {}, ping = 0, closed = false;
  const close = () => { if (closed) return; closed = true; off(); clearInterval(ping); onClose?.(); };
  const send = m => { w.write(enc.encode(m)).catch(close); };
  off = bus.add({ send });
  send(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  ping = setInterval(() => send(": ping\n\n"), 10000);
  return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
const json = (obj, status = 200, headers = {}) => Response.json(obj, { status, headers });

// ================================================================ one person's J.A.S.S.I
export class JassiHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const state = freshState();
    const diaryDays = new Map();
    this.google = null;   // { access_token, refresh_token, expires_at, scopes, email }
    this.me = null;
    ctx.blockConcurrencyWhile(async () => {
      Object.assign(state, (await ctx.storage.get("state")) || {});
      state.settings = { ...freshState().settings, ...(state.settings || {}) };
      for (const [k, v] of await ctx.storage.list({ prefix: "diary:" })) diaryDays.set(k.slice(6), v);
      this.google = (await ctx.storage.get("google")) || null;
      this.me = (await ctx.storage.get("me")) || null;
    });
    const bus = makeBus();
    const save = () => ctx.storage.put("state", state);
    const spentToday = () => { if (state.spent.date !== today()) state.spent = { date: today(), amount: 0 }; return state.spent.amount; };
    const dir = () => env.DIR.get(env.DIR.idFromName("directory"));
    this.r = {
      demo, state, bus, approvals: makeApprovals(bus), host: "cloudflare", deviceHub: makeDeviceHub(),
      // device tokens: the directory only learns "this hash belongs to this person", so the Worker can route the device here
      registerDevice: hash => dir().fetch("https://dir/devkey/put", { method: "POST", body: JSON.stringify({ hash, sub: this.me?.sub }) }),
      unregisterDevice: hash => dir().fetch("https://dir/devkey/delete", { method: "POST", body: JSON.stringify({ hash }) }),
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
      diaryLabel: "kept in your private Cloudflare space · download: /api/diary.md",
      brainToken: env.BRAIN_TOKEN || "",
      brainOnline: async () => (await (await dir().fetch("https://dir/brain/status")).json()).on,
      brainAsk: async q => (await dir().fetch("https://dir/brain/ask", { method: "POST", body: JSON.stringify({ ...q, uid: this.me?.sub, role: this.me?.role, name: (this.me?.name || "").split(" ")[0] }) })).json(),
      runScript: null,      // Workers can't run new code at runtime; Code Mode from your sentence still works
      google: env.GOOGLE_CLIENT_ID ? this.googleApi() : null,
      me: { name: "You", role: "member" },
    };
  }

  // ---------------------------------------------------------------- real Google Calendar + Gmail
  googleApi() {
    const hub = this;
    const has = k => !!hub.google?.refresh_token && (hub.google.scopes || []).some(s => s === SCOPES[k][0]);
    async function token() {
      const g = hub.google;
      if (g.access_token && g.expires_at > Date.now() + 60e3) return g.access_token;
      const t = await googleToken({ client_id: hub.env.GOOGLE_CLIENT_ID, client_secret: hub.env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: g.refresh_token });
      g.access_token = t.access_token; g.expires_at = Date.now() + (t.expires_in || 3600) * 1000;
      hub.ctx.storage.put("google", g);
      return g.access_token;
    }
    async function call(url, opts = {}) {
      const res = await fetch(url, { ...opts, headers: { authorization: "Bearer " + await token(), "content-type": "application/json", ...(opts.headers || {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error("Google said: " + (data.error?.message || res.status));
      return data;
    }
    const unescape = s => String(s || "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const gmail = (path, mail) => call("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { method: "POST", body: JSON.stringify(path === "drafts" ? { message: { raw: rawEmail(mail) } } : { raw: rawEmail(mail) }) });
    return {
      has,
      canWrite: () => has("gmail") && (hub.google.scopes || []).includes(SCOPES.gmail[1]),
      draftEmail: mail => gmail("drafts", mail),            // sits in your Drafts until you send it
      sendEmail: mail => gmail("messages/send", mail),      // only ever called after your yes (guard kind "send")
      get email() { return hub.google?.email || ""; },
      async addEvent(title, when) {
        const iso = t => new Date(t).toISOString();
        return call("https://www.googleapis.com/calendar/v3/calendars/primary/events", { method: "POST",
          body: JSON.stringify({ summary: title, start: { dateTime: iso(when), timeZone: "Asia/Kolkata" }, end: { dateTime: iso(when + 30 * 60e3), timeZone: "Asia/Kolkata" } }) });
      },
      async listEvents() {
        const q = new URLSearchParams({ timeMin: new Date().toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "5" });
        const d = await call("https://www.googleapis.com/calendar/v3/calendars/primary/events?" + q);
        return (d.items || []).map(e => { const when = Date.parse(e.start?.dateTime || e.start?.date); return { title: e.summary || "(no title)", when, when_text: hhmm(when), link: e.htmlLink }; });
      },
      async latestEmails() {
        const d = await call("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=in%3Ainbox");
        const out = [];
        for (const m of d.messages || []) {
          const x = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
          const h = n => (x.payload?.headers || []).find(y => y.name === n)?.value || "";
          out.push({ from: h("From").replace(/\s*<.*>$/, "").replace(/"/g, ""), subject: h("Subject"), body: unescape(x.snippet) });
        }
        return out;
      },
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const meHeader = request.headers.get("x-jassi-me");
    if (meHeader) {
      const me = JSON.parse(meHeader);
      if (!this.me || this.me.sub !== me.sub || this.me.role !== me.role || this.me.name !== me.name) { this.me = me; this.ctx.storage.put("me", me); }
    }
    if (this.me) this.r.me = { name: this.me.name, email: this.me.email, picture: this.me.picture, role: this.me.role };
    return withRt(this.r, () => this.handle(request, url));
  }

  async handle(request, url) {
    // ---- internal calls from the Worker (never reachable from the internet: the Worker only forwards /api/* and /mcp)
    if (url.pathname === "/internal/google") {
      const g = await request.json();
      this.google = g; await this.ctx.storage.put("google", g);
      for (const k of ["calendar", "gmail"]) if ((g.scopes || []).includes(SCOPES[k][0])) this.r.state.settings.apps[k] = true;
      this.r.save();
      return json({ ok: true });
    }
    if (url.pathname === "/api/google/disconnect" && request.method === "POST") {
      const { which } = await request.json().catch(() => ({}));
      if (this.google) {
        const left = (this.google.scopes || []).filter(s => !(which ? SCOPES[which] : [...SCOPES.calendar, ...SCOPES.gmail]).includes(s));
        if (!which || !left.some(s => s.includes("calendar") || s.includes("gmail"))) {
          fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(this.google.refresh_token), { method: "POST" }).catch(() => {});
          this.google = null; await this.ctx.storage.delete("google");
        } else { this.google.scopes = left; await this.ctx.storage.put("google", this.google); }
      }
      for (const k of which ? [which] : ["calendar", "gmail"]) this.r.state.settings.apps[k] = false;
      this.r.save();
      return json({ ok: true });
    }
    if (url.pathname === "/api/events") return sse(this.r.bus);
    const headers = Object.fromEntries(request.headers);
    const r = await api(request.method, url.pathname, request.method === "POST" ? await request.text() : "", headers, url.searchParams);
    if (!r) return json({ error: "not found" }, 404);
    return new Response(r.body, { status: r.status, headers: { "content-type": r.type, ...(r.headers || {}) } });
  }
}

// ================================================================ accounts, invites, MCP keys, brain router
export class JassiDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // The brain on the Mac asks for work with short requests (/brain/poll), so a redeploy can never strand it on an old
    // copy of this object: its very next poll lands on the new one. "Online" = a poll is open or one finished recently.
    this.queue = [];
    this.wake = null;
    this.polling = 0;
    this.lastPoll = 0;
    this.waiting = new Map();
  }
  get brainOn() { return this.polling > 0 || Date.now() - this.lastPoll < 45000; }
  async fetch(request) {
    const url = new URL(request.url);
    const S = this.ctx.storage;
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    switch (url.pathname) {
      case "/signin": {   // {sub, email, email_verified, name, picture, invite}
        const owner = String(this.env.OWNER_EMAIL || "").trim().toLowerCase();
        const email = String(body.email || "").toLowerCase();
        let user = await S.get("user:" + body.sub);
        if (user) {
          Object.assign(user, { name: body.name, picture: body.picture, email: body.email });
          if (owner && email === owner && body.email_verified && user.role !== "owner") user.role = "owner";
        } else if (owner && email === owner && body.email_verified) {
          user = { sub: body.sub, email: body.email, name: body.name, picture: body.picture, role: "owner", createdAt: Date.now(), invite: null };
        } else {
          const inv = body.invite && await S.get("invite:" + body.invite);
          if (!inv || !inv.active || inv.uses >= inv.maxUses) return json({ ok: false, reason: inv ? "This invite link is used up or switched off." : "J.A.S.S.I is invite only. Ask the owner for an invite link." });
          inv.uses++; await S.put("invite:" + inv.code, inv);
          user = { sub: body.sub, email: body.email, name: body.name, picture: body.picture, role: "member", createdAt: Date.now(), invite: inv.code };
        }
        await S.put("user:" + user.sub, user);
        return json({ ok: true, user });
      }
      case "/invite": {   // ?code= -> is it valid?
        const inv = await S.get("invite:" + url.searchParams.get("code"));
        return json({ valid: !!(inv && inv.active && inv.uses < inv.maxUses), label: inv?.label || "" });
      }
      case "/invites": {
        if (request.method === "POST") {
          const code = randomId(6).replace(/[-_]/g, "x");
          const inv = { code, label: String(body.label || "Invite").slice(0, 60), maxUses: Math.max(1, Math.min(100, +body.maxUses || 5)), uses: 0, active: true, createdAt: Date.now() };
          await S.put("invite:" + code, inv);
          return json({ ok: true, invite: inv });
        }
        const list = [...(await S.list({ prefix: "invite:" })).values()].sort((a, b) => b.createdAt - a.createdAt);
        const users = [...(await S.list({ prefix: "user:" })).values()].map(u => ({ name: u.name, email: u.email, role: u.role, invite: u.invite, createdAt: u.createdAt }));
        return json({ invites: list, users });
      }
      case "/invites/toggle": {
        const inv = await S.get("invite:" + body.code);
        if (!inv) return json({ ok: false }, 404);
        inv.active = !!body.active; await S.put("invite:" + inv.code, inv);
        return json({ ok: true, invite: inv });
      }
      case "/mcpkey": {   // {sub, regen}
        let key = await S.get("usermcp:" + body.sub);
        if (!key || body.regen) {
          if (key) await S.delete("mcpkey:" + key);
          key = "jk_" + randomId(24);
          await S.put("mcpkey:" + key, body.sub); await S.put("usermcp:" + body.sub, key);
        }
        return json({ key });
      }
      // ---- one-time codes that hand a sign-in from the system browser back to a native app (60 s, single use)
      case "/authcode/put": {
        await S.put("authcode:" + body.code, { challenge: body.challenge, data: body.data, exp: Date.now() + 60000 });
        return json({ ok: true });
      }
      case "/authcode/take": {
        const k = "authcode:" + String(body.code || "");
        const a = await S.get(k);
        if (a) await S.delete(k);
        return json(a && a.exp > Date.now() ? { ok: true, challenge: a.challenge, data: a.data } : { ok: false });
      }
      // ---- native app device tokens (only the SHA-256 is ever stored)
      case "/devkey/put": { if (body.hash && body.sub) await S.put("devkey:" + body.hash, body.sub); return json({ ok: true }); }
      case "/devkey/delete": { await S.delete("devkey:" + body.hash); return json({ ok: true }); }
      case "/devkey/lookup": return json({ sub: (await S.get("devkey:" + url.searchParams.get("h"))) || null });
      case "/mcpkey/lookup": return json({ sub: (await S.get("mcpkey:" + url.searchParams.get("key"))) || null });
      // ---- the Claude Code brain (one bridge on the owner's Mac serves everyone, one Claude process per person)
      case "/brain/status": return json({ on: this.brainOn });
      case "/brain/poll": {   // the brain's long-ish poll: returns at once if a question is waiting, else after 20 s with nothing
        this.polling++; this.lastPoll = Date.now();
        try {
          if (!this.queue.length) await new Promise(resolve => {
            const t = setTimeout(finish, 20000);
            this.wake = finish;
            function finish() { clearTimeout(t); resolve(); }
          });
        } finally { this.polling--; this.lastPoll = Date.now(); }
        return json({ asks: this.queue.splice(0) });
      }
      case "/brain/ask": {
        for (let i = 0; i < 120 && !this.brainOn; i++) await new Promise(r => setTimeout(r, 250));   // up to 30 s: the brain's next poll lands within seconds of any redeploy
        if (!this.brainOn) return json({ say: "My thinking brain is offline right now. Direct commands still work." });
        const say = await new Promise(resolve => {
          const t = setTimeout(() => { this.waiting.delete(body.id); this.queue = this.queue.filter(q => q.id !== body.id); resolve("That took too long, so I stopped."); }, 180000);
          this.waiting.set(body.id, s => { clearTimeout(t); resolve(s); });
          this.queue.push({ id: body.id, uid: body.uid, role: body.role, name: body.name, text: body.text, now: body.now });
          this.wake?.();
        });
        return json({ say });
      }
      case "/brain/answer": {
        const f = this.waiting.get(body.id);
        if (f) { this.waiting.delete(body.id); f(String(body.say || "")); }
        return json({ ok: !!f });
      }
    }
    return json({ error: "not found" }, 404);
  }
}

// ================================================================ the Worker: sign-in + routing
const hubFor = (env, sub) => env.HUB.get(env.HUB.idFromName("user:" + sub));
const dirOf = env => env.DIR.get(env.DIR.idFromName("directory"));
const bearerOf = req => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

async function forward(req, stub, extra = {}) {
  const h = new Headers(req.headers);
  for (const k of [...h.keys()]) if (k.startsWith("x-jassi-")) h.delete(k);   // never trust these from the internet
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return stub.fetch(new Request(req.url, { method: req.method, headers: h, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer() }));
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
};
function hardened(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}

export default {
  async fetch(req, env) { return hardened(await route(req, env)); },
};

async function route(req, env) {
  {
    const url = new URL(req.url);
    const p = url.pathname;
    const secure = url.protocol === "https:";
    const secret = env.SESSION_SECRET || env.BRAIN_TOKEN;
    const c = cookies(req);
    const session = await unsign(c[SESSION], secret);
    const redirectUri = url.origin + "/auth/google/callback";
    const back = (to, setCookies = []) => { const h = new Headers({ location: to }); for (const s of setCookies) h.append("set-cookie", s); return new Response(null, { status: 302, headers: h }); };

    const appChallenge = v => (/^[\w-]{43}$/.test(v || "") ? v : "");
    const appLink = async (challenge, data) => {   // jassi://auth?code=<one-time code>: the only thing that ever travels in the link
      const code = randomId(24);
      await dirOf(env).fetch("https://dir/authcode/put", { method: "POST", body: JSON.stringify({ code, challenge, data }) });
      return "jassi://auth?code=" + code;
    };

    // ---------------------------------------------------------- sign-in with Google
    if (p === "/auth/google/start") {
      if (!env.GOOGLE_CLIENT_ID) return back("/?error=" + encodeURIComponent("Google sign-in isn't set up yet."));
      const connect = ["calendar", "gmail"].includes(url.searchParams.get("connect")) ? url.searchParams.get("connect") : "";
      // Native apps sign in through the system browser (Google refuses WebViews). "app" is the SHA-256 of a secret only the
      // app's own page knows, so a one-time code that leaks through the jassi:// link is useless to anyone else.
      const app = appChallenge(url.searchParams.get("app"));
      const ticket = app ? await unsign(url.searchParams.get("ticket"), secret) : null;   // who is connecting, when the browser has no session
      const sub = ticket?.t === "connect" ? ticket.sub : connect ? session?.sub : "";
      if (connect && !sub) return back("/");
      const { verifier, challenge } = await pkce();
      const state = randomId(16);
      const o = await sign({ state, verifier, connect, app, sub: connect ? sub : "", exp: Date.now() + 10 * 60e3 }, secret);
      return back(googleAuthUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri, state, challenge, connect }), [setCookie(OAUTH, o, { maxAge: 600, secure })]);
    }
    if (p === "/auth/google/callback") {
      const o = await unsign(c[OAUTH], secret);
      const clear = setCookie(OAUTH, "", { maxAge: 0, secure });
      // Back to the native app with a one-time code, or (in a browser) straight to the page.
      const done = async (data, to, extra = []) => o?.app ? back(await appLink(o.app, data), [clear]) : back(to, [clear, ...extra]);
      const fail = msg => done({ error: msg }, "/?error=" + encodeURIComponent(msg));
      if (url.searchParams.get("error")) return fail("Google sign-in was cancelled.");
      if (!o || o.state !== url.searchParams.get("state")) return back("/?error=" + encodeURIComponent("Sign-in expired. Please try again."), [clear]);
      try {
        const t = await googleToken({ code: url.searchParams.get("code"), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: o.verifier });
        const id = readIdToken(t.id_token, env.GOOGLE_CLIENT_ID);
        if (o.connect) {
          if (!o.sub) return back("/", [clear]);
          if (!t.refresh_token) return fail("Google didn't give access. Please try again.");
          await hubFor(env, o.sub).fetch("https://hub/internal/google", { method: "POST", body: JSON.stringify({
            access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, scopes: String(t.scope || "").split(" "), email: id.email }) });
          return done({ connected: o.connect }, "/?connected=" + o.connect);
        }
        const r = await (await dirOf(env).fetch("https://dir/signin", { method: "POST", body: JSON.stringify({ sub: id.sub, email: id.email, email_verified: id.email_verified, name: id.name || id.email, picture: id.picture || "", invite: c[INVITE] || "" }) })).json();
        if (!r.ok) return fail(r.reason);
        const who = { sub: r.user.sub, email: r.user.email, name: r.user.name, picture: r.user.picture, role: r.user.role };
        const s = await sign({ ...who, exp: Date.now() + 30 * DAY }, secret);
        return done({ session: who }, "/", [setCookie(SESSION, s, { maxAge: 30 * 86400, secure }), setCookie(INVITE, "", { maxAge: 0, secure })]);
      } catch (e) {
        return fail("Google sign-in failed: " + e.message);
      }
    }
    // The native app's own page swaps the one-time code (plus its secret) for the session cookie.
    if (p === "/auth/app") {
      const r = await (await dirOf(env).fetch("https://dir/authcode/take", { method: "POST", body: JSON.stringify({ code: url.searchParams.get("code") || "" }) })).json();
      const proof = b64url(await crypto.subtle.digest("SHA-256", enc.encode(url.searchParams.get("v") || "")));
      if (!r.ok || r.challenge !== proof) return back("/?error=" + encodeURIComponent("Sign-in expired. Please try again."));
      if (r.data.error) return back("/?error=" + encodeURIComponent(r.data.error));
      if (r.data.connected) return back("/?connected=" + r.data.connected);
      const s = await sign({ ...r.data.session, exp: Date.now() + 30 * DAY }, secret);
      return back("/", [setCookie(SESSION, s, { maxAge: 30 * 86400, secure })]);
    }
    if (p === "/auth/logout") return back("/", [setCookie(SESSION, "", { maxAge: 0, secure })]);
    // Local testing only (wrangler dev with DEV_LOGIN=1): sign in without Google.
    if (p === "/auth/dev" && env.DEV_LOGIN === "1" && url.hostname === "localhost") {
      const email = url.searchParams.get("email") || "owner@example.com";
      const r = await (await dirOf(env).fetch("https://dir/signin", { method: "POST", body: JSON.stringify({ sub: "dev_" + email, email, email_verified: true, name: url.searchParams.get("name") || email.split("@")[0], picture: "", invite: c[INVITE] || "" }) })).json();
      if (!r.ok) return back("/?error=" + encodeURIComponent(r.reason));
      const who = { sub: r.user.sub, email, name: r.user.name, picture: "", role: r.user.role };
      if (appChallenge(url.searchParams.get("app"))) return back(await appLink(url.searchParams.get("app"), { session: who }));
      const s = await sign({ ...who, exp: Date.now() + DAY }, secret);
      return back("/", [setCookie(SESSION, s, { maxAge: 86400, secure })]);
    }
    const join = p.match(/^\/join\/([\w-]+)$/);
    if (join) return back("/?invite=" + join[1], [setCookie(INVITE, join[1], { maxAge: 3 * 86400, secure })]);

    // ---------------------------------------------------------- the brain (owner's Mac) - needs the brain token
    const brainOk = !!env.BRAIN_TOKEN && bearerOf(req) === env.BRAIN_TOKEN;
    if (p === "/api/brain/health") {   // for the brain on the Mac: does the site see me?
      if (!brainOk) return json({ ok: false }, 401);
      return dirOf(env).fetch("https://dir/brain/status");
    }
    if (p === "/api/brain/poll" || p === "/api/brain/answer") {
      if (!brainOk) return json({ ok: false }, 401);
      return dirOf(env).fetch(new Request("https://dir/brain/" + (p.endsWith("poll") ? "poll" : "answer"), { method: req.method, body: req.method === "POST" ? await req.text() : undefined }));
    }

    // ---------------------------------------------------------- MCP: the brain (per person) or your own AI app (personal key)
    if (p === "/mcp") {
      if (brainOk && req.headers.get("x-jassi-user")) return forward(req, hubFor(env, req.headers.get("x-jassi-user")));
      const key = bearerOf(req);
      const sub = key.startsWith("jk_") ? (await (await dirOf(env).fetch("https://dir/mcpkey/lookup?key=" + encodeURIComponent(key))).json()).sub : null;
      if (!sub) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Sign in to J.A.S.S.I and copy your MCP link from Settings." } }, 401);
      const h = new Headers(req.headers); h.delete("authorization");
      return forward(new Request(req.url, { method: req.method, headers: h, body: req.method === "POST" ? await req.arrayBuffer() : undefined }), hubFor(env, sub));
    }

    // ---------------------------------------------------------- a paired native app asking for / reporting screen work (its token is the key)
    if (p === "/api/device/next" || p === "/api/device/result") {
      const tok = bearerOf(req);
      const sub = tok.startsWith("jd_") ? (await (await dirOf(env).fetch("https://dir/devkey/lookup?h=" + await hashToken(tok))).json()).sub : null;
      if (!sub) return json({ ok: false }, 401);
      return forward(req, hubFor(env, sub));   // the person's own space checks the token again
    }

    // ---------------------------------------------------------- everything else under /api needs you to be signed in
    if (p.startsWith("/api/")) {
      if (!session) {
        let invite = null;
        const code = c[INVITE];
        if (code) invite = await (await dirOf(env).fetch("https://dir/invite?code=" + encodeURIComponent(code))).json();
        return json({ signin: true, google: !!env.GOOGLE_CLIENT_ID, invite, dev: env.DEV_LOGIN === "1" && url.hostname === "localhost" }, 401);
      }
      // A 5-minute ticket that says who is connecting an app, for flows that continue in the system browser.
      if (p === "/api/auth/ticket") return json({ ticket: await sign({ t: "connect", sub: session.sub, exp: Date.now() + 5 * 60e3 }, secret) });
      if (p === "/api/invites" || p === "/api/invites/toggle") {
        if (session.role !== "owner") return json({ error: "owner only" }, 403);
        return dirOf(env).fetch(new Request("https://dir" + p.replace("/api", ""), { method: req.method, body: req.method === "POST" ? await req.text() : undefined }));
      }
      if (p === "/api/mcpkey") {
        const b = req.method === "POST" ? await req.json().catch(() => ({})) : {};
        const r = await (await dirOf(env).fetch("https://dir/mcpkey", { method: "POST", body: JSON.stringify({ sub: session.sub, regen: !!b.regen }) })).json();
        return json({ url: url.origin + "/mcp", key: r.key });
      }
      return forward(req, hubFor(env, session.sub), { "x-jassi-me": JSON.stringify({ sub: session.sub, email: session.email, name: session.name, picture: session.picture, role: session.role }) });
    }
    return env.ASSETS.fetch(req);
  }
}
