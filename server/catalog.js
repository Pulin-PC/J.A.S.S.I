// The plug catalogue: what J.A.S.S.I may do with each app found on a device (see "App Connect Sheet").
// Looking an app up here takes no time and no AI. Tiers, best first:
//   official  the company's own MCP server            api     the company's own API (J.A.S.S.I plug)
//   link      J.A.S.S.I fills it in, you tap the last button
//   screen    J.A.S.S.I's custom plug: it works the app on screen for you (needs the native app + your OK)
//   avoid     real legal risk, not offered             locked  money, ID, passwords, health, system: never touched
//   skip      nothing useful to connect
// `plug` points at a built-in plug (data/demo.json apps) when one already covers the app.

// ---- never read, never controlled. Checked here AND in the guard AND on the device itself.
const LOCKED = [
  ["money apps", /\b(g ?pay|google pay|google wallet|phone ?pe|paytm|bhim|cred|mobikwik|freecharge|amazon pay|paypal|wallet|upi|net ?banking|razorpay|venmo|cash app|wise|revolut)\b/i,
    /(nbu\.paisa|walletnfcrel|phonepe|one97\.paytm|npci\.upiapp|dreamplug|paypal|mobikwik|freecharge|com\.apple\.passbook)/i],
  ["bank apps", /\b(bank|banking|sbi|yono|hdfc|icici|imobile|axis|kotak|baroda|bob world|pnb|canara|idfc|indusind|federal|rbl|citi|hsbc|chase|wells fargo)\b/i,
    /((^|[.\-_])(sbi|hdfc|icici|axis|kotak|baroda|pnb|canara|idfc|indusind|yesbank|rbl)([.\-_]|$)|bank)/i],
  ["government ID", /\b(digilocker|m?aadhaar|umang|voter|passport|parivahan|income tax|epfo|cowin)\b/i, /(digilocker|uidai|umang|eci\.citizen|mpassport)/i],
  ["trading and crypto apps", /\b(zerodha|kite|groww|upstox|angel one|5paisa|dhan|coin ?dcx|coinswitch|wazirx|binance|coinbase|metamask|robinhood|dream11|trading)\b/i, /(zerodha|groww|upstox|binance|coinbase|metamask|wazirx|dream11)/i],
  ["password apps", /\b(1password|bitwarden|lastpass|dashlane|keepass\w*|authenticator|authy|passwords|keychain access|credential manager)\b/i, /(1password|agilebits|bitwarden|lastpass|dashlane|authenticator|authy|com\.apple\.passwords|keychainaccess)/i],
  ["health records", /\b(abha|health records|health|eka care|loop health|acko|insurance)\b/i, /(com\.apple\.health|abha|loophealth|acko)/i],
  ["remote access and security apps", /\b(anydesk|teamviewer|tailscale|remote desktop|mygate|truecaller|find my|vpn)\b/i, /(anydesk|teamviewer|tailscale|mygate|truecaller|com\.apple\.findmy)/i],
  ["system apps", /\b(settings|system (settings|preferences)|terminal|console|powershell|command prompt|registry editor|task manager|activity monitor|disk utility|installer|control panel|device policy)\b/i,
    /(com\.android\.settings|systempreferences|com\.apple\.terminal|com\.apple\.console|powershell|cmd\.exe|regedit|packageinstaller|permissioncontroller|com\.googlecode\.iterm2|windowsterminal)/i],
];

// ---- known apps: [name pattern, tier, how it connects, extra]
const KNOWN = [
  [/^swiggy|instamart/i, "official", "Official MCP", { plug: "swiggy" }],
  [/^zomato/i, "official", "Official MCP", { plug: "zomato" }],
  [/^gmail/i, "api", "Google API", { plug: "gmail" }],
  [/^(google )?calendar/i, "api", "Google API", { plug: "calendar" }],
  [/^whatsapp( messenger)?$/i, "link", "App link · you tap Send", { plug: "whatsapp" }],
  [/^(google )?maps/i, "link", "App link", { plug: "maps" }],
  [/^youtube( music)?$/i, "link", "App link", { plug: "youtube" }],
  [/^amazon( shopping)?$/i, "avoid", "Not offered: Amazon forbids AI agents on its accounts"],
  [/^strava/i, "avoid", "Not offered: Strava forbids using its data with AI"],
  [/^(chatgpt|gemini|claude|perplexity|grok|copilot|meta ai|j\.?a\.?s\.?s\.?i)/i, "skip", "Another assistant"],
  [/^(app store|play store|google play|galaxy store|microsoft store|font book|migration assistant|siri|launchpad|mission control|boot camp)/i, "skip", "Built-in tool"],
];

import { officialFor } from "./mcpclient.js";

const norm = s => String(s || "").trim();

export function lockedReason(app) {
  const id = norm(app?.id).toLowerCase(), name = norm(app?.name);
  for (const [why, byName, byId] of LOCKED) if (byName.test(name) || byId.test(id)) return why;
  return "";
}

// One app from a device scan -> what J.A.S.S.I offers for it on that kind of device.
export function classify(app, platform = "") {
  const id = norm(app?.id).toLowerCase().slice(0, 120), name = norm(app?.name).slice(0, 60) || id;
  const base = { id, name };
  const why = lockedReason({ id, name });
  if (why) return { ...base, tier: "locked", how: "Locked: " + why };
  const mcp = officialFor(name);   // the company's own MCP server, when J.A.S.S.I can sign in to it
  for (const [pat, tier, how, extra] of KNOWN) if (pat.test(name)) return { ...base, tier, how, ...(extra || {}), ...(mcp ? { mcp } : {}) };
  if (mcp) return { ...base, tier: "official", how: "Official MCP", mcp };
  // No official route: J.A.S.S.I's own plug works the app on screen. iPhones don't allow that.
  return platform === "ios" ? { ...base, tier: "skip", how: "No connection on iPhone yet" }
    : { ...base, tier: "screen", how: "J.A.S.S.I plug · works the app on screen (beta)" };
}

const ORDER = { official: 0, api: 1, link: 2, screen: 3, avoid: 4, locked: 5, skip: 6 };
export function classifyAll(apps, platform = "") {
  const seen = new Set(), out = [];
  for (const a of Array.isArray(apps) ? apps.slice(0, 500) : []) {
    const c = classify(a, platform);
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id); out.push(c);
  }
  return out.sort((x, y) => ORDER[x.tier] - ORDER[y.tier] || x.name.localeCompare(y.name));
}
