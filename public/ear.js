// Hands-free listening: wait for "Jassi", hear the request, then keep a 5 second window open for a follow-up,
// the way a person keeps listening after they answer. Silence for 5 s → back to sleep until "Jassi" again.
//
// It sits on the speech engine the device already has: the browser's (Chrome) or the native app's own
// listenStart / speech events. The wake word is spotted on the device's own transcript. Swapping in a
// dedicated wake-word engine (Picovoice) later only changes how "wake" is detected, not this flow.
//
//   wake    listening only for "Jassi"
//   follow  "Jassi" (or an answer) just happened: any words now are a request. 5 s of nothing → wake
//   req     a request is being heard; ~0.9 s of silence ends it
//   paused  J.A.S.S.I is working or talking (not listening, so it never hears itself)
//   off     hands-free is turned off

export const WAKE = /\b(?:hey|hi|ok|okay)?\s*(?:jassi|jassie|jassy|jessie|jessi|jessy|jasi|jaasi|jassee|jaci|jacy|jazzy|chassi|jassi's)\b[\s,.!?]*/i;
export const FOLLOW_MS = 5000;
const SILENCE_MS = 900, FINAL_MS = 300;

// The speech engine: one session at a time, cumulative transcript per session.
function browserEngine(SR, lang) {
  let rec = null;
  return {
    start(onText, onEnd) {
      if (rec) return;
      const r = rec = new SR();
      r.lang = lang; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
      r.onresult = ev => {
        let text = "", final = true;
        for (let i = 0; i < ev.results.length; i++) { text += ev.results[i][0].transcript; final = ev.results[i].isFinal; }
        if (rec === r) onText(text.replace(/\s+/g, " ").trim(), final);
      };
      r.onerror = e => { if (rec === r && (e.error === "not-allowed" || e.error === "service-not-allowed")) { rec = null; onEnd("denied"); } };
      r.onend = () => { if (rec === r) { rec = null; onEnd(); } };
      try { r.start(); } catch { rec = null; setTimeout(() => onEnd(), 300); }
    },
    stop() { const r = rec; rec = null; try { r?.abort(); } catch {} },
  };
}
function nativeEngine(native, onNative, lang) {
  let live = false, handlers = null;
  onNative("speech", d => { if (live && handlers) handlers.onText(String(d.text || "").replace(/\s+/g, " ").trim(), !!d.final); });
  onNative("speech-end", d => { if (live && handlers) { live = false; handlers.onEnd(d?.error === "no_permission" ? "denied" : undefined); } });
  return {
    async start(onText, onEnd) {
      if (live) return;
      live = true; handlers = { onText, onEnd };
      const r = await native.listenStart({ lang, onDevice: true }).catch(() => ({ ok: false }));
      if (!r.ok && live) { live = false; onEnd(r.error === "no_permission" ? "denied" : "failed"); }
    },
    stop() { if (!live) return; live = false; handlers = null; native.listenStop().catch(() => {}); },
  };
}

export function createEar({ native, onNative, SR, lang = "en-IN", engine: given, followMs = FOLLOW_MS, onWake, onText, onSleep, onState, onDenied }) {
  const engine = given || (native ? nativeEngine(native, onNative, lang) : SR ? browserEngine(SR, lang) : null);
  let mode = "off", base = 0, reqStart = 0, last = "", silence = null, follow = null, retry = 0, running = false;

  const set = m => { mode = m; onState?.(m); };
  const clear = () => { clearTimeout(silence); clearTimeout(follow); };

  function run() {
    if (!engine || running) return;
    running = true; base = 0; last = "";
    engine.start(heard, why => {
      running = false;
      if (why === "denied") { set("off"); onDenied?.(); return; }
      if (mode === "req") return finish();
      if (mode === "wake" || mode === "follow") {   // the device closed its session (silence, time limit): open a new one
        const wait = Math.min(4000, 150 * 2 ** retry++);
        setTimeout(() => { if ((mode === "wake" || mode === "follow") && !running) run(); }, wait);
      }
    });
  }
  function heard(text, final) {
    retry = 0;
    last = text;
    if (mode === "wake") {
      const seen = text.slice(base), m = WAKE.exec(seen);
      if (m) { const at = base + m.index + m[0].length; onWake?.(); openFollow(at); heard(text, final); return; }
      if (seen.length > 160) { engine.stop(); running = false; run(); }   // keep the session light while waiting
      return;
    }
    if (mode === "follow") {
      if (!text.slice(base).trim()) return;
      clearTimeout(follow); reqStart = base; set("req");
    }
    if (mode !== "req") return;
    const req = text.slice(reqStart).trim();
    if (!req) return;
    onText(req, false);
    clearTimeout(silence);
    silence = setTimeout(finish, final ? FINAL_MS : SILENCE_MS);
  }
  function finish() {
    clearTimeout(silence);
    const req = last.slice(reqStart).trim();
    pause();
    if (req) onText(req, true); else ear.follow();
  }
  // Listen for a request starting at transcript position `at`, for up to 5 s.
  function openFollow(at) {
    clearTimeout(follow);
    base = at; set("follow");
    follow = setTimeout(() => { if (mode === "follow") { base = last.length; set("wake"); onSleep?.(); } }, followMs);
  }
  function pause() { clear(); if (running) { engine.stop(); running = false; } if (mode !== "off") set("paused"); }

  const ear = {
    get mode() { return mode; },
    supported: !!engine,
    start() { if (!engine) return false; if (mode === "off") { set("wake"); run(); } return true; },
    stop() { clear(); if (running) { engine.stop(); running = false; } set("off"); },
    pause,
    // After J.A.S.S.I answers: 5 s to say something else, no "Jassi" needed.
    follow() {
      if (mode === "off") return;
      clear();
      if (running) { engine.stop(); running = false; }
      set("follow"); run(); openFollow(0);
    },
    // The mic button or a tap on the bubble: listen right now, no wake word.
    now() { if (mode === "off") return false; onWake?.(); ear.follow(); return true; },
  };
  return ear;
}
