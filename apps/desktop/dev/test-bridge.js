// Dev builds only. Run inside the loaded page with:
//   JASSI_DEV_SCRIPT=apps/desktop/dev/test-bridge.js <the dev binary>
// Calls every bridge method once and prints each answer on the shell's stdout as "[dev] …".
// Set window.__jassiDevPair = { server, deviceId, token } first (see test-pair.js) to also pair.
(async () => {
  const n = window.jassiNative;
  const say = (label, value) => window.__TAURI_INTERNALS__.invoke("jn_dev_log", { args: { text: label + " " + JSON.stringify(value) } });
  if (!n) return say("no bridge on", location.origin);

  window.addEventListener("jassi-native", e => say("event", e.detail));
  await say("page", { origin: location.origin, title: document.title, platform: n.platform, version: n.version, contract: n.contract });

  const apps = await n.listApps();
  await say("listApps", { ok: apps.ok, partial: apps.partial, count: (apps.apps || []).length, first: (apps.apps || []).slice(0, 4) });
  await say("permissions", await n.permissions());
  await say("setPolicy", await n.setPolicy({ blockedApps: ["com.apple.Notes"] }));
  await say("openExternal(bad link)", await n.openExternal("file:///etc/hosts"));
  await say("notify", await n.notify({ title: "J.A.S.S.I", body: "Test alert from the desktop app." }));
  await say("speak", await n.speak({ text: "J.A.S.S.I desktop test.", lang: "en-IN" }));
  await say("speakStop", await n.speakStop());
  await say("listenStop", await n.listenStop());
  await say("stop", await n.stop());
  await say("unpair", await n.unpair());
  const p = window.__jassiDevPair;
  if (p) await say("pair", await n.pair(p));
  await say("pair(plain http, not localhost)", await n.pair({ server: "http://example.com", deviceId: "x", token: "x" }));
  await say("done", true);
})();
