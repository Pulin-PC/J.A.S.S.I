// Reflex parser: turns a *partial* transcript into steps while you are still talking.
// Ported from the JARVIS macOS core (core/reflex.py) and adapted to J.A.S.S.I's plugs.
// Runs in the browser (live speech) and in Node (tests, typed commands). No dependencies.
//
// How a step fires (see app.js -> Utterance):
//   * closed clauses (you moved on: "... and <verb>") fire at once
//   * the last, still-open clause fires early only if it is not free text and its meaning held for STABLE_MS
//   * free text ("saying ...", "search ...") waits until the clause closes or you stop talking
//   * steps that depend on an earlier result ("the ETA") are bundled into one Code Mode script at the end

export const STABLE_MS = 140;

const VERBS = "email|open|launch|start|close|search|google|look up|find|play|pause|resume|skip|message|text|whatsapp|send|tell|" +
  "set|remind|note|order|get me|pay|transfer|navigate|take me|directions|add|put|schedule|create|make|book|read|check|" +
  "show|give|stop|call|save|write|brief|what|how";
const SPLIT = new RegExp(
  "\\s*(?:[,.;]\\s*)?\\b(?:and then|and also|and after that|after that|and|then)\\b[,]?\\s+(?=(?:" + VERBS + ")\\b)" +
  "|(?:[.;!?]|,)\\s+(?=(?:" + VERBS + ")\\b)", "i");
const POLITE = /^(?:(?:hey|hi|ok|okay|so|now|also|and|then|um+|uh+|please|jassi|jessie|jassie|can you|could you|would you|will you|i want you to|i need you to|go ahead and|just|kindly)[\s,]+)+/i;
const QUESTION = /^(what|who|whom|whose|when|where|why|how|which|is|are|am|was|were|do|does|did|can i|should|would|will|tell me about|explain|define|calculate|translate|summari[sz]e|describe)\b/i;
const BRIEF = /\b(morning brief|daily brief|brief me|my brief|what'?s (on )?my day|how did we do|how('s| is| was) (the )?business|today'?s brief|business update)\b/i;
const DEP = /\b(the eta|eta|delivery time|when (it|the food|the order) (arrives|comes)|the order|it arrives)\b/i;

export const SITES = {
  youtube: "https://www.youtube.com", gmail: "https://mail.google.com", "google calendar": "https://calendar.google.com",
  calendar: "https://calendar.google.com", maps: "https://maps.google.com", "google maps": "https://maps.google.com",
  github: "https://github.com", spotify: "https://open.spotify.com", swiggy: "https://www.swiggy.com",
  zomato: "https://www.zomato.com", instamart: "https://www.swiggy.com/instamart", whatsapp: "https://web.whatsapp.com",
  linkedin: "https://www.linkedin.com", drive: "https://drive.google.com", "google drive": "https://drive.google.com",
  sheets: "https://sheets.google.com", netflix: "https://www.netflix.com", hotstar: "https://www.hotstar.com",
  "prime video": "https://www.primevideo.com", telegram: "https://web.telegram.org", chatgpt: "https://chatgpt.com",
  uber: "https://m.uber.com", ola: "https://book.olacabs.com", "youtube music": "https://music.youtube.com",
  google: "https://www.google.com", notion: "https://www.notion.so", razorpay: "https://dashboard.razorpay.com",
};

const ENGINES = "google|youtube|amazon|flipkart|wikipedia|github|reddit|linkedin|spotify|maps|google maps|swiggy|zomato";

export class Step {
  constructor(kind, args = {}, opts = {}) {
    this.kind = kind;
    this.args = args;
    this.free = !!opts.free;        // free text: wait until the clause is closed
    this.early = opts.early ?? true; // may fire before the clause closes (when not free)
    this.dep = !!opts.dep;          // needs an earlier step's result (Code Mode)
    this.hold = !!opts.hold;        // wait for the end of the sentence
    this.clause = opts.clause || "";
  }
  get sig() {
    return this.kind + "|" + Object.keys(this.args).sort().map(k => k + "=" + this.args[k]).join("|");
  }
}

export function stripText(s) {
  return String(s || "").trim().replace(/^["“”']+|["“”']+$/g, "").replace(/[.]+$/, "").trim();
}

export function splitClauses(text) {
  return text.split(SPLIT).map(p => (p || "").replace(/^[\s,]+|[\s,]+$/g, "")).filter(p => p && p.replace(/[\s,.]/g, ""));
}

// "at 6 pm", "in 10 minutes", "tomorrow at 9", "for 5 minutes" -> {text, when(ms epoch)|null, seconds|null}
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30, "forty five": 45, "half an": 30, an: 1, a: 1 };
const num = s => { s = String(s).trim().toLowerCase(); return /^\d+$/.test(s) ? +s : WORDNUM[s]; };

export function parseWhen(text, now = new Date()) {
  let t = ` ${text} `;
  let when = null, seconds = null, day = new Date(now);
  let m = t.match(/\b(day after tomorrow|tomorrow|tonight|today)\b/i);
  if (m) {
    const w = m[1].toLowerCase();
    day.setDate(day.getDate() + (w.startsWith("day after") ? 2 : w === "tomorrow" ? 1 : 0));
    t = t.replace(m[0], " ");
    if (w === "tonight") { when = new Date(day); when.setHours(20, 0, 0, 0); }
  }
  m = t.match(/\b(?:in|for|after)\s+(\d+|[a-z]+(?: an)?)\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i);
  if (m && num(m[1]) !== undefined) {
    const n = num(m[1]); const u = m[2].toLowerCase();
    seconds = u.startsWith("h") ? n * 3600 : u.startsWith("s") ? n : n * 60;
    when = new Date(now.getTime() + seconds * 1000);
    t = t.replace(m[0], " ");
  }
  m = t.match(/\b(?:at|by|around)\s+(\d{1,2}|[a-z]+)(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|in the morning|in the evening|at night|o'?clock)?(?=\s|$)/i);
  if (m && num(m[1]) !== undefined && num(m[1]) <= 24) {
    let h = num(m[1]); const mi = +(m[2] || 0); const ap = (m[3] || "").toLowerCase().replace(/\./g, "");
    if (ap.startsWith("pm") || ap.includes("evening") || ap.includes("night")) h = (h % 12) + 12;
    else if (ap.startsWith("am") || ap.includes("morning")) h = h % 12;
    else if (h < 8) h += 12;
    const cand = new Date(day); cand.setHours(h % 24, mi, 0, 0);
    if (cand < now && day.toDateString() === now.toDateString()) cand.setTime(cand.getTime() + (h < 12 ? 12 : 24) * 3600e3);
    when = cand; seconds = null;
    t = t.replace(m[0], " ");
  } else if (!when && day.toDateString() !== now.toDateString()) {
    when = new Date(day); when.setHours(9, 0, 0, 0);
  }
  return { text: t.replace(/\s+/g, " ").trim().replace(/^[\s,.]+|[\s,.]+$/g, ""), when: when ? when.getTime() : null, seconds };
}

export class Parser {
  constructor(contacts = [], blocked = []) {
    this.setContacts(contacts);
    this.blocked = blocked.map(b => b.toLowerCase());
  }
  setContacts(contacts) {
    this.contacts = [];
    for (const c of contacts) for (const n of [c.name, ...(c.aliases || [])]) this.contacts.push([n.toLowerCase(), c.name]);
    this.contacts.sort((a, b) => b[0].length - a[0].length);
  }

  parse(text) {
    text = String(text || "").trim().replace(POLITE, "");
    if (!text) return [];
    if (BRIEF.test(text)) return [new Step("brief", {}, { clause: text })];
    if (QUESTION.test(text) && !/^(can|could|would|will) you\b/i.test(text) && !/^what did i\b|^what'?s my usual/i.test(text))
      return [new Step("ask", { text }, { free: true, clause: text })];
    const steps = [];
    for (let c of splitClauses(text)) steps.push(...this.clause(c.replace(POLITE, "")));
    // Money never moves mid-sentence: it waits until you finish talking (a later clause may depend on it, or correct it).
    for (const s of steps) if (s.kind === "order" || s.kind === "pay") s.hold = true;
    // "open youtube and search for X" -> search YouTube, not Google
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1], st = steps[i];
      if (st.kind === "search" && prev.kind === "open_app" && !/\bon\s+google\b/i.test(st.clause) && ENGINES.split("|").includes(prev.args.app)) st.args.engine = prev.args.app;
    }
    return steps;
  }

  clause(c) {
    const lc = c.toLowerCase().replace(/^[\s.!?,]+|[\s.!?,]+$/g, "");
    if (!lc) return [];
    const S = (k, a = {}, o = {}) => [new Step(k, a, { clause: c, ...o })];
    let m;

    if (/^(stop|cancel|never ?mind|be quiet|shut up|quiet|that'?s all)$/.test(lc)) return S("stop");
    if (BRIEF.test(lc)) return S("brief");
    if (/^(read|check|open|show)\s+(me\s+)?(my\s+)?(latest\s+|last\s+|new\s+)?(e-?mails?|mail|inbox)$/.test(lc)) return S("read_email");
    if (/^(what'?s|show|check)\s+(on\s+)?my\s+(calendar|schedule)/.test(lc)) return S("calendar_list");
    if ((m = lc.match(/^(?:what did i|when did i|what'?s my usual|remember|recall)\s*(.*)$/))) return S("recall", { q: stripText(m[1] || lc) }, { free: true });

    // ---- money
    if ((m = c.match(/^(?:pay|send|transfer)\s+(?:rs\.?|₹|inr|rupees)?\s*([\d,]+)\s*(?:rs|rupees|₹|inr)?\s+to\s+(.+?)(?:\s+for\s+(.+))?$/i))
      || (m = c.match(/^pay\s+(.+?)\s+(?:rs\.?|₹|inr)?\s*([\d,]+)(?:\s*(?:rs|rupees))?(?:\s+for\s+(.+))?$/i))) {
      const [amt, to] = /^[\d,]+$/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
      return S("pay", { to: stripText(to), amount: +amt.replace(/,/g, ""), note: stripText(m[3] || "") }, { free: true });
    }
    if ((m = c.match(/^(?:order|get me|buy)\s+(.+?)(?:\s+(?:from|on)\s+(swiggy|zomato|instamart))?$/i)))
      return S("order", { item: stripText(m[1]).replace(/^(my|the|a|an|some)\s+/i, ""), from: (m[2] || "swiggy").toLowerCase() }, { free: true });

    // ---- messages
    if ((m = c.match(/^(?:send\s+(?:a\s+)?(?:whatsapp\s+)?(?:message|text|msg)\s+to|whatsapp|message|text|msg|tell|send)\s+(.+)$/i))
      && !/^(send|tell)\s+(an?\s+)?(e-?mail|mail)\b/i.test(lc) && !/^send\s+(payment\s+)?reminders?\b/i.test(lc))
      return this._message(m[1], c);
    if ((m = c.match(/^(?:(?:send|write)\s+(?:an?\s+)?(?:e-?mail|mail)\s+to|e-?mail)\s+(\S+(?:\s\S+)?)\s+(?:saying|that|about|:)\s+(.+)$/i)))
      return S("email", { to: stripText(m[1]), text: stripText(m[2]) }, { free: true });
    if (/^send\s+(the\s+)?(payment\s+)?reminders?/.test(lc)) return S("chase_unpaid", {}, { free: true });

    // ---- calendar, reminders, timers, notes
    if ((m = c.match(/^(?:put|add|save)\s+(?:the\s+|my\s+)?(.+?)\s+(?:in|on|to|into)\s+(?:my\s+|the\s+)?calendar$/i))) {
      const dep = DEP.test(m[1]); const p = parseWhen(m[1]);
      return S("event", { title: dep ? "Food delivery" : stripText(p.text) || "Event", when: p.when || 0 }, { free: true, dep, early: false });
    }
    if ((m = c.match(/^(?:add|create|schedule|put|make|book)\s+(?:an?\s+)?(?:event|meeting|calendar event|appointment|call)\s+(.+)$/i))) {
      const p = parseWhen(m[1]);
      let title = stripText(p.text) || "Meeting";
      if (/^(with|for|about)\b/i.test(title)) title = "Meeting " + title;
      return S("event", { title, when: p.when || 0 }, { free: true });
    }
    if ((m = c.match(/^(?:set\s+(?:a\s+|an\s+)?)?timer\s+(?:for\s+)?(.+)$/i)) || (m = c.match(/^(\d+|[a-z]+)\s+(minute|second|hour)s?\s+timer$/i))) {
      const p = parseWhen("for " + (m[2] ? `${m[1]} ${m[2]}s` : m[1]));
      if (p.seconds) return S("timer", { seconds: p.seconds, label: "Timer" });
      return S("unknown", { text: c }, { free: true });
    }
    if ((m = c.match(/^(?:set\s+(?:an?\s+)?alarm|wake me up)\s*(?:for|at)?\s*(.+)$/i))) {
      const p = parseWhen("at " + m[1].replace(/^at\s+/i, ""));
      if (p.when && /\d|o'?clock|am|pm|morning|evening/i.test(m[1])) return S("timer", { at: p.when, label: "Alarm" }, { free: true });
      return S("unknown", { text: c }, { free: true });
    }
    if ((m = c.match(/^remind me(?:\s+to)?\s+(.+)$/i)) || (m = c.match(/^(?:add|create|set)\s+(?:a\s+)?reminder(?:\s+to)?\s+(.+)$/i))) {
      const dep = DEP.test(m[1]); const p = parseWhen(m[1]);
      return S("reminder", { text: stripText(p.text), when: p.when || 0 }, { free: true, dep, early: !dep });
    }
    if ((m = c.match(/^(?:take|make|create|add|write)\s+(?:a\s+)?(?:new\s+)?note(?:\s+(?:saying|that|to say|about|:))?\s*(.*)$/i)) || (m = c.match(/^note(?:\s+down)?\s+(.+)$/i)))
      return S("note", { text: stripText(m[1]) }, { free: true });

    // ---- search, music, maps
    if ((m = c.match(new RegExp(`^(?:search\\s+(?:on\\s+)?)?(${ENGINES})\\s+for\\s+(.+)$`, "i"))))
      return S("search", { q: stripText(m[2]), engine: m[1].toLowerCase() }, { free: true });
    if ((m = c.match(new RegExp(`^(?:search|google|look up|lookup)(?:\\s+for)?\\s+(.+?)(?:\\s+(?:on|in|using)\\s+(${ENGINES}))?$`, "i"))))
      return S("search", { q: stripText(m[1]), engine: (m[2] || "google").toLowerCase() }, { free: true });
    if ((m = c.match(/^play\s+(.+?)(?:\s+(?:on|in|from)\s+(spotify|youtube|youtube music))?$/i)))
      return S("play", { q: stripText(m[1]), where: (m[2] || "youtube").toLowerCase() }, { free: true });
    if ((m = c.match(/^(?:navigate|take me|directions|get directions|drive|how do i get)\s+(?:to\s+)?(.+)$/i)))
      return S("directions", { to: stripText(m[1]) }, { free: true });

    // ---- open app / site
    if ((m = c.match(/^(?:open|launch|start|go to|bring up|show|pull up)\s+(?:up\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+app)?$/i))) {
      const t = stripText(m[1]).toLowerCase();
      // "open google" may still become "open google pay" (locked) or "open google maps": don't fire early on a prefix.
      const longer = [...Object.keys(SITES), ...this.blocked].some(k => k.startsWith(t + " "));
      if (this.blocked.includes(t)) return S("open_app", { app: t });
      if (SITES[t]) return S("open_app", { app: t }, { early: !longer });
      if (/^[\w-]+\.(com|in|org|io|dev|ai|net|co)(\/\S*)?$/.test(t)) return S("open_app", { app: t });
      return S("open_app", { app: t }, { early: false, free: true });
    }
    return S("unknown", { text: c }, { free: true });
  }

  _message(rest, c) {
    // "<name> [on whatsapp] [saying|that|:] <text>"  or  "<name> <text>"
    let r = rest.replace(/^(?:it|this|that)\s+to\s+/i, "").replace(/^to\s+/i, "");
    const lr = r.toLowerCase();
    let name = null, text = "";
    for (const [n, canon] of this.contacts) {
      if (lr === n || lr.startsWith(n + " ") || lr.startsWith(n + ",")) { name = canon; text = r.slice(n.length); break; }
    }
    if (!name) {
      const m = r.match(/^(.+?)(?:\s+on\s+whatsapp)?(?:\s*[,:]\s*|\s+(?:saying|that says|that|to say|and say)\s+)(.+)$/i);
      if (m) { name = stripText(m[1]); text = m[2]; } else { name = r.split(/\s+/)[0]; text = r.slice(name.length); }
    }
    text = text.replace(/^\s*(?:on\s+whatsapp)?\s*(?:[,:]|saying|that says|that|to say|and say)?\s*/i, "");
    const dep = DEP.test(text);
    return [new Step("message", { to: name, text: stripText(text) }, { clause: c, free: true, dep, early: !dep })];
  }
}
