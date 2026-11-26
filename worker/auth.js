// Small, dependency-free helpers for sign-in: signed cookies (HMAC-SHA256), PKCE, Google OAuth.
const enc = new TextEncoder();

export const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export const randomId = (n = 24) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function sign(obj, secret) {
  const body = b64url(enc.encode(JSON.stringify(obj)));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}
export async function unsign(token, secret) {
  if (!token || !secret) return null;
  const [body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(body));
  if (!ok) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return obj.exp && obj.exp < Date.now() ? null : obj;
  } catch { return null; }
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
export function setCookie(name, value, { maxAge = 0, secure = true } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export async function pkce() {
  const verifier = randomId(32);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return { verifier, challenge };
}

export const SCOPES = {
  signin: ["openid", "email", "profile"],
  calendar: ["https://www.googleapis.com/auth/calendar.events"],
  // readonly = read your inbox; compose = write drafts and send (only ever after your yes). Older connections have readonly only.
  gmail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
};

export function googleAuthUrl({ clientId, redirectUri, state, challenge, connect }) {
  const scopes = [...SCOPES.signin, ...(connect ? SCOPES[connect] || [] : [])];
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: scopes.join(" "),
    state, code_challenge: challenge, code_challenge_method: "S256",
  });
  if (connect) { p.set("access_type", "offline"); p.set("prompt", "consent"); p.set("include_granted_scopes", "true"); }
  else p.set("prompt", "select_account");
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p;
}

export async function googleToken(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || "token exchange failed");
  return data;
}

// The id_token comes straight from Google's token endpoint over TLS; we still check who it is for and when it expires.
export function readIdToken(idToken, clientId) {
  const p = JSON.parse(new TextDecoder().decode(fromB64url(String(idToken).split(".")[1] || "")));
  if (p.aud !== clientId) throw new Error("token is for another app");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(p.iss)) throw new Error("token not from Google");
  if (p.exp * 1000 < Date.now()) throw new Error("token expired");
  return p;
}
