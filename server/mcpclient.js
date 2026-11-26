// J.A.S.S.I as an MCP *client*: connect a company's own MCP server (Notion, Linear, Zomato, Swiggy…) with the user's
// own login, the same way Claude's connectors do. Every tool such a server offers becomes usable, and every call
// still goes through call() in tools.js: reads run on their own, anything that writes or sends asks first,
// anything that can spend needs a fingerprint. What comes back is untrusted content, never instructions.
import { rt } from "./runtime.js";

const PROTO = "2025-06-18";
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
const friendly = msg => Object.assign(new Error(msg), { friendly: true });

// Official servers checked on 26 Nov 2026: each answers MCP sign-in and lets a new app register itself.
// (Left out on purpose: payment providers - money stays behind J.A.S.S.I Pay - and servers that only accept approved apps.)
export const OFFICIAL = [
  { id: "swiggy", name: "Swiggy Food", url: "https://mcp.swiggy.com/food", match: /^swiggy/i },
  { id: "instamart", name: "Swiggy Instamart", url: "https://mcp.swiggy.com/im", match: /instamart/i },
  { id: "zomato", name: "Zomato", url: "https://mcp-server.zomato.com/mcp", match: /^zomato/i },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", match: /^notion/i },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", match: /^linear/i },
  { id: "atlassian", name: "Jira & Confluence", url: "https://mcp.atlassian.com/v1/mcp", match: /^(jira|confluence|atlassian)/i },
  { id: "canva", name: "Canva", url: "https://mcp.canva.com/mcp", match: /^canva/i },
  { id: "monday", name: "monday.com", url: "https://mcp.monday.com/mcp", match: /^monday/i },
  { id: "intercom", name: "Intercom", url: "https://mcp.intercom.com/mcp", match: /^intercom/i },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", match: /^sentry/i },
  { id: "vercel", name: "Vercel", url: "https://mcp.vercel.com", match: /^vercel/i },
];
export const officialFor = name => OFFICIAL.find(o => o.match.test(String(name || "")))?.id || "";

// ---------------------------------------------------------------- which addresses we are willing to talk to
export function safeUrl(u, allowLocal = rt.host === "node") {
  let x;
  try { x = new URL(String(u)); } catch { return null; }
  if (x.username || x.password) return null;
  const h = x.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return allowLocal ? x : null;   // only when J.A.S.S.I runs on your own computer
  if (x.protocol !== "https:") return null;
  if (/^[\d.]+$/.test(h) || h.startsWith("[") || !h.includes(".") || /\.(local|internal|lan|home|corp|localhost)$/.test(h)) return null;   // no raw IPs, no inside-the-network names
  return x;
}
const must = u => { const x = safeUrl(u); if (!x) throw friendly("That link isn't one I can connect to."); return x.href; };

// ---------------------------------------------------------------- how careful to be with each tool
// A server's own hints can't be trusted, so the tool's NAME decides, and when in doubt it asks.
const READ = /^(get|list|search|read|fetch|find|query|view|show|describe|lookup|look up|check|count|whoami|retrieve|browse|track|status|resolve)\b/;
const MONEY = /(pay|order|checkout|purchase|buy|refund|transfer|payout|charge|invoice|subscri|place|book|tip|redeem|donat)/;
export function toolKind(t) {
  const n = String(t?.name || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (READ.test(n) && t?.annotations?.readOnlyHint !== false && t?.annotations?.destructiveHint !== true) return "read";
  if (MONEY.test(n)) return "spend";                         // place_order, checkout, create_invoice… -> fingerprint
  if (/\bdraft\b/.test(n) && !/\bsend\b/.test(n)) return "self";   // a draft only changes your own stuff
  return "send";                                             // everything else asks first
}

const cut = (s, n) => String(s ?? "").slice(0, n);
function cleanTools(list) {
  return (Array.isArray(list) ? list : []).slice(0, 80).filter(t => t && /^[\w.\-]{1,80}$/.test(t.name)).map(t => {
    const schema = t.inputSchema && JSON.stringify(t.inputSchema).length <= 6000 ? t.inputSchema : { type: "object" };
    return { name: t.name, title: cut(t.title || t.annotations?.title || "", 60), description: cut(t.description, 400), inputSchema: schema, kind: toolKind(t) };
  });
}

// ---------------------------------------------------------------- talking MCP (Streamable HTTP)
let seq = 0;
function send(url, token, body, session) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTO };
  if (token) headers.authorization = "Bearer " + token;
  if (session) headers["mcp-session-id"] = session;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
}
async function answerOf(res, id) {
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const block of (await res.text()).split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
      try { const m = JSON.parse(data); if (m.id === id) return m; } catch {}
    }
    return null;
  }
  return res.json().catch(() => null);
}
const INIT = () => ({ jsonrpc: "2.0", id: ++seq, method: "initialize", params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "jassi", title: "J.A.S.S.I", version: "1.0" } } });
async function hello(url, token) {   // -> { status, session }
  const body = INIT();
  const res = await send(url, token, body);
  if (!res.ok) return { status: res.status, www: res.headers.get("www-authenticate") || "" };
  await answerOf(res, body.id);
  const session = res.headers.get("mcp-session-id") || "";
  await send(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(() => {});
  return { status: 200, session };
}

const servers = () => ((rt.state.mcp ||= { servers: {} }).servers);
const auths = () => (rt.state.mcpAuth ||= {});
const live = () => (rt.mcpLive ||= new Map());   // open sessions, in memory only

async function rpc(id, method, params, again = true) {
  const srv = servers()[id], auth = auths()[id];
  if (!srv) throw friendly("That app isn't connected.");
  if (auth?.expires_at && auth.expires_at < Date.now() + 30000 && auth.refresh_token) await refresh(id);
  let session = live().get(id);
  if (session === undefined) {
    const h = await hello(srv.url, auths()[id]?.access_token);
    if (h.status === 401 && again && await refresh(id)) return rpc(id, method, params, false);
    if (h.status !== 200) throw h.status === 401 ? loggedOut(id) : friendly(`${srv.name} isn't answering right now.`);
    live().set(id, session = h.session);
  }
  const body = { jsonrpc: "2.0", id: ++seq, method, params };
  const res = await send(srv.url, auths()[id]?.access_token, body, session);
  if (again && (res.status === 401 ? await refresh(id) : res.status === 404 || res.status === 400)) { live().delete(id); return rpc(id, method, params, false); }   // new token, or the session ran out
  if (res.status === 401) throw loggedOut(id);
  if (!res.ok) throw friendly(`${srv.name} isn't answering right now.`);
  const msg = await answerOf(res, body.id);
  if (!msg) throw friendly(`${srv.name} didn't answer.`);
  if (msg.error) throw friendly(`${srv.name} said: ${cut(msg.error.message, 200)}`);
  return msg.result || {};
}
function loggedOut(id) {
  const srv = servers()[id];
  srv.needsLogin = true; live().delete(id); rt.save();
  return friendly(`${srv.name} needs you to sign in again. Reconnect it in Settings, under Apps.`);
}

// ---------------------------------------------------------------- sign-in (OAuth 2.1 with PKCE, the app registers itself)
const form = (url, params) => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20000) });
const getJson = async url => { try { const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) }); return r.ok ? await r.json() : null; } catch { return null; } };

// Where does this server want people to sign in? Read-only: asks the server's public "how to sign in" pages.
export async function findSignIn(url, www = "") {
  const u = new URL(url), path = u.pathname.replace(/\/$/, "");
  const hinted = /resource_metadata="([^"]+)"/.exec(www)?.[1];
  let res = null;
  for (const c of [hinted, `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`]) {
    if (c && safeUrl(c) && (res = await getJson(c))?.authorization_servers?.length) break;
  }
  const as = new URL(safeUrl(res?.authorization_servers?.[0])?.href || u.origin), asPath = as.pathname.replace(/\/$/, "");
  let meta = null;
  for (const c of [`${as.origin}/.well-known/oauth-authorization-server${asPath}`, `${as.origin}/.well-known/oauth-authorization-server`, `${as.origin}${asPath}/.well-known/openid-configuration`]) {
    if ((meta = await getJson(c))?.authorization_endpoint) break;
  }
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw friendly("I couldn't find how to sign in to that service.");
  const scope = /scope="([^"]+)"/.exec(www)?.[1] || (res?.scopes_supported || []).join(" ");
  return { authorize: must(meta.authorization_endpoint), token: must(meta.token_endpoint), register: meta.registration_endpoint ? must(meta.registration_endpoint) : "", scope };
}

// Step 1: the user pressed Connect. Either it just works (no sign-in), or we hand back the page to sign in on.
export async function connectStart({ id, url, name, app }) {
  const known = OFFICIAL.find(o => o.id === id);
  const target = must(known ? known.url : url);
  const sid = known ? known.id : "x" + rand(4).toLowerCase().replace(/[^a-z0-9]/g, "");
  const label = cut(known ? known.name : name || new URL(target).hostname.replace(/^(mcp|api|www)[.-]/, ""), 40);
  if (!known && Object.values(servers()).filter(s => !OFFICIAL.some(o => o.id === s.id)).length >= 10) throw friendly("You've reached 10 extra connections. Disconnect one first.");
  const h = await hello(target, "");
  if (h.status === 200) { live().set(sid, h.session); return finish(sid, label, target, null); }
  if (h.status !== 401 && h.status !== 403) throw friendly(`${label} isn't answering right now.`);
  const ep = await findSignIn(target, h.www);
  if (!ep.register) throw friendly(`${label} only lets approved apps connect, and J.A.S.S.I isn't on its list yet.`);
  const redirect = rt.origin + "/auth/mcp/callback";
  const reg = await (await fetch(ep.register, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ client_name: "J.A.S.S.I", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) })).json().catch(() => null);
  if (!reg?.client_id) throw friendly(`${label} didn't let J.A.S.S.I register. It may only allow approved apps.`);
  const verifier = rand(32), state = rand(24);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  const pending = (rt.state.mcpPending ||= {});
  for (const [k, p] of Object.entries(pending)) if (p.exp < Date.now()) delete pending[k];
  pending[state] = { sid, label, url: target, token: ep.token, client_id: reg.client_id, client_secret: reg.client_secret || "", verifier, redirect, app: /^[\w-]{43}$/.test(app || "") ? app : "", exp: Date.now() + 10 * 60e3 };
  rt.save();
  await rt.registerMcpState?.(state);   // Cloudflare: lets the Worker bring the sign-in back to this person's space
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256", resource: target });
  if (ep.scope) q.set("scope", ep.scope);
  return { ok: true, authUrl: ep.authorize + (ep.authorize.includes("?") ? "&" : "?") + q };
}

// Step 2: the sign-in page sent the user back with a code.
export async function connectFinish({ state, code, error }) {
  const p = rt.state.mcpPending?.[state];
  if (p) { delete rt.state.mcpPending[state]; rt.save(); }
  if (!p || p.exp < Date.now()) return { ok: false, say: "That sign-in took too long. Please try again.", app: p?.app || "" };
  if (error || !code) return { ok: false, say: `${p.label} wasn't connected.`, app: p.app };
  try {
    const res = await form(p.token, { grant_type: "authorization_code", code, redirect_uri: p.redirect, client_id: p.client_id, code_verifier: p.verifier, resource: p.url, ...(p.client_secret ? { client_secret: p.client_secret } : {}) });
    const t = await res.json().catch(() => ({}));
    if (!res.ok || !t.access_token) throw friendly(`${p.label} didn't finish the sign-in.`);
    const auth = { access_token: t.access_token, refresh_token: t.refresh_token || "", expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : 0, token: p.token, client_id: p.client_id, client_secret: p.client_secret };
    return { ...(await finish(p.sid, p.label, p.url, auth)), app: p.app };
  } catch (e) {
    return { ok: false, say: e.friendly ? e.message : `${p.label} wasn't connected.`, app: p.app };
  }
}
async function finish(sid, name, url, auth) {
  servers()[sid] = { id: sid, name, url, tools: [], at: Date.now() };
  if (auth) auths()[sid] = auth; else delete auths()[sid];
  try {
    servers()[sid].tools = cleanTools((await rpc(sid, "tools/list", {})).tools);
  } catch (e) { delete servers()[sid]; delete auths()[sid]; live().delete(sid); rt.save(); throw e; }
  rt.save();
  rt.diary({ title: `Connected ${name}`, tool: "connections", origin: "you", decision: "approved", result: `${servers()[sid].tools.length} tools` });
  return { ok: true, connected: name, id: sid, tools: servers()[sid].tools.length };
}
async function refresh(id) {
  const a = auths()[id], srv = servers()[id];
  if (!a?.refresh_token || !a.token) return false;
  try {
    const res = await form(a.token, { grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: a.client_id, resource: srv.url, ...(a.client_secret ? { client_secret: a.client_secret } : {}) });
    const t = await res.json().catch(() => ({}));
    if (!res.ok || !t.access_token) return false;
    Object.assign(a, { access_token: t.access_token, refresh_token: t.refresh_token || a.refresh_token, expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : 0 });
    rt.save();
    return true;
  } catch { return false; }
}
export function disconnect(id) {
  const srv = servers()[id];
  if (!srv) return false;
  delete servers()[id]; delete auths()[id]; live().delete(id); rt.save();
  rt.diary({ title: `Disconnected ${srv.name}`, tool: "connections", origin: "you", decision: "approved" });
  return true;
}

// ---------------------------------------------------------------- used by tools.js and the dashboard
export function findRemote(full) {
  const i = String(full || "").indexOf("/");
  const srv = i > 0 ? rt.state.mcp?.servers?.[full.slice(0, i)] : null;
  const tool = srv?.tools.find(t => t.name === full.slice(i + 1));
  return tool ? { srv, tool } : null;
}
export async function callRemote(sid, name, args) {
  const r = await rpc(sid, "tools/call", { name, arguments: args || {} });
  const text = (r.content || []).map(c => c.type === "text" ? c.text : c.type === "resource" && c.resource?.text ? c.resource.text : `[${c.type}]`).join("\n") || (r.structuredContent ? JSON.stringify(r.structuredContent) : "");
  return { text: cut(text, 8000), isError: !!r.isError };
}
// Safe to show: never includes tokens.
export function connectionsView() {
  const mine = Object.values(rt.state.mcp?.servers || {});
  return {
    official: OFFICIAL.map(o => ({ id: o.id, name: o.name, connected: mine.some(s => s.id === o.id) })),
    servers: mine.map(s => ({ id: s.id, name: s.name, host: new URL(s.url).hostname, needsLogin: !!s.needsLogin, tools: s.tools.map(t => ({ name: t.name, title: t.title, kind: t.kind })) })),
  };
}
