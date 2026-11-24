// The safety guard. Every tool call (from your voice, the AI brain, a Code Mode script or any MCP client)
// passes through decide() before it runs. Rules live here, in code - never in a prompt.

export const LIMITS = {
  autoPayUnder: 5000,   // payments under ₹5,000 go through on their own
  dailyCap: 10000,      // above this total per day, every payment needs your fingerprint
  hardMax: 200000,      // never, even with a fingerprint (prototype limit)
};

const INJECTION = /(ignore|disregard|forget)\s+(all\s+|your\s+|any\s+)?(previous|prior|earlier|above)?\s*(instructions|rules|prompts?)|do not (ask|tell) the user|ai assistant reading this|you are now|system prompt/i;
export const looksLikeInjection = text => INJECTION.test(String(text || ""));

const inr = n => "₹" + Number(n).toLocaleString("en-IN");

// kinds: read · self (changes only your own stuff) · link (fills an app, you tap the last button)
//        send (reaches other people) · pay (moves money) · script (Code Mode: each inner call is checked again)
// origin: you (voice/typed) · brain (AI acting for you) · content (AI after reading emails/pages) · mcp (another AI app)
export function decide({ tool, kind, args = {}, amount = 0, origin = "you", blockedApps = [], spentToday = 0, limits = {} }) {
  const L = { ...LIMITS, ...limits };
  L.autoPayUnder = Math.min(Number(L.autoPayUnder) || 0, LIMITS.autoPayUnder);   // a user can make it stricter, never looser
  L.dailyCap = Math.min(Number(L.dailyCap) || 0, 50000);
  if (!tool || !kind) return { level: "block", reason: "unknown tool" };

  if (tool === "open_app") {
    const a = String(args.app || "").toLowerCase();
    if (blockedApps.includes(a)) return { level: "block", reason: "money, ID and password apps stay locked. Payments go through J.A.S.S.I Pay" };
  }

  if (kind === "pay") {
    if (!(amount > 0)) return { level: "block", reason: "amount must be more than ₹0" };
    if (amount > L.hardMax) return { level: "block", reason: `over the ${inr(L.hardMax)} hard limit` };
    if (origin === "content") return { level: "fingerprint", reason: "this payment came from something I read, not from you" };
    if (amount >= L.autoPayUnder) return { level: "fingerprint", reason: `${inr(L.autoPayUnder)} or more needs your fingerprint` };
    if (spentToday + amount > L.dailyCap) return { level: "fingerprint", reason: `this goes over today's ${inr(L.dailyCap)} limit` };
    return { level: "auto", reason: `under ${inr(L.autoPayUnder)}` };
  }

  if (kind === "send") {
    if (origin === "content") return { level: "fingerprint", reason: "a message to other people, started by something I read" };
    return { level: "confirm", reason: "it goes to other people" };
  }

  if (origin === "content" && (kind === "self" || kind === "link")) return { level: "confirm", reason: "started by something I read" };
  if (kind === "read" || kind === "self" || kind === "link" || kind === "script") return { level: "auto", reason: kind === "read" ? "just reading" : kind === "link" ? "you tap the last button" : kind === "script" ? "each step is checked" : "only changes your own stuff" };

  return { level: "block", reason: "unknown kind" };
}
