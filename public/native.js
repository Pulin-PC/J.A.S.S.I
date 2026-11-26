// The native apps (Android, iPhone, desktop) wrap this same page and add window.jassiNative (docs/native-contract.md).
// In a normal browser it is missing, `native` is null, and the page behaves exactly as before.
const n = window.jassiNative;
export const native = n && n.contract === 1 ? n : null;

const subs = {};
export function onNative(type, fn) { (subs[type] ||= []).push(fn); }
window.addEventListener("jassi-native", e => { const d = e.detail || {}; for (const f of subs[d.type] || []) { try { f(d); } catch {} } });

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const AUTHV = "jassi.authv";

// Sign-in and "connect" pages can't run inside the app (Google refuses WebViews), so they open in the system browser.
// The app keeps a secret; the browser only ever sees its hash, and the one-time code that comes back is useless without the secret.
export async function nativeAuth(path) {
  const v = b64url(crypto.getRandomValues(new Uint8Array(32)));
  try { localStorage.setItem(AUTHV, v); } catch {}
  const u = new URL(path, location.origin);
  u.searchParams.set("app", b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
  return native.openExternal(u.href);
}
onNative("auth", d => {
  let code = "", v = "";
  try { code = new URL(d.url).searchParams.get("code") || ""; v = localStorage.getItem(AUTHV) || ""; localStorage.removeItem(AUTHV); } catch {}
  if (code && v) location.href = `/auth/app?code=${encodeURIComponent(code)}&v=${encodeURIComponent(v)}`;
});
