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

// Screen control: what a button says decides how careful to be. The words come from the device, never from the AI.
const SPEND = /\b(pay|buy|purchase|place (the |your )?order|order now|check ?out|book( now| ride| a ride)?|subscribe|donate|transfer|send money|recharge|add money|top ?up|bid|confirm (and pay|order|payment|booking|purchase)|proceed to pay|slide to pay)\b/i;
const COMMIT = /\b(send|post|publish|share|reply|forward|submit|delete|remove|erase|discard|trash|confirm|accept|agree|allow|grant|install|uninstall|sign ?out|log ?out|unsubscribe|cancel|call|dial|invite|follow|unfollow|block|report|join|rsvp|comment|tweet|upload|approve|reject|merge|ok|okay|yes|continue|proceed)\b/i;
export const screenRisk = label => (SPEND.test(label) ? "spend" : COMMIT.test(label) ? "commit" : "");

// kinds: read · self (changes only your own stuff) · link (fills an app, you tap the last button)
//        send (reaches other people) · pay (moves money) · script (Code Mode: each inner call is checked again)
//        screen (works an app on your device: one tap, one line of typing, one scroll)
// origin: you (voice/typed) · brain (AI acting for you) · content (AI after reading emails/pages) · mcp (another AI app)
// screen: { app, appName, locked, allowed, action, label, key, session } - facts about the step, filled in by the server
export function decide({ tool, kind, args = {}, amount = 0, origin = "you", blockedApps = [], spentToday = 0, limits = {}, screen = null }) {
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

  if (kind === "screen") {
    const s = screen || {};
    if (s.locked) return { level: "block", reason: "money, ID and password apps stay locked" };
    if (!s.app) return { level: "block", reason: "I have to look at the screen first" };
    if (!s.allowed) return { level: "block", reason: `${s.appName || "that app"} isn't turned on. Turn it on in Settings, under Apps` };
    const press = s.action === "tap" || s.action === "key";
    if (press) {
      const risk = s.action === "key" ? "commit" : screenRisk(s.label);
      if (risk === "spend") return { level: "fingerprint", reason: "this button can spend money" };
      if (risk === "commit") return { level: "confirm", reason: "this can send or change something for good" };
      if (s.action === "tap" && !String(s.label || "").trim()) return { level: "confirm", reason: "this button has no name, so I can't tell what it does" };
    }
    if (!s.session) return { level: "confirm", reason: `first step in ${s.appName || "this app"} for this task` };
    return { level: "auto", reason: "you let me work in this app" };
  }

  // A connected app's tool that can move money: the amount can't be checked from here, so it always needs a fingerprint.
  if (kind === "spend") return { level: "fingerprint", reason: "this can spend money" };

  if (kind === "send") {
    if (origin === "content") return { level: "fingerprint", reason: "a message to other people, started by something I read" };
    return { level: "confirm", reason: "it goes to other people" };
  }

  if (origin === "content" && (kind === "self" || kind === "link")) return { level: "confirm", reason: "started by something I read" };
  if (kind === "read" || kind === "self" || kind === "link" || kind === "script") return { level: "auto", reason: kind === "read" ? "just reading" : kind === "link" ? "you tap the last button" : kind === "script" ? "each step is checked" : "only changes your own stuff" };

  return { level: "block", reason: "unknown kind" };
}
