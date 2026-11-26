// Dev builds only (see test-bridge.js). Pairs the shell with the stub server (node dev/stub.mjs),
// locks Calculator so the locked-app rule can be seen, and prints every event.
(async () => {
  const n = window.jassiNative;
  const say = (label, value) => window.__TAURI_INTERNALS__.invoke("jn_dev_log", { args: { text: label + " " + JSON.stringify(value) } });
  window.addEventListener("jassi-native", e => say("event", e.detail));
  await say("permissions", await n.permissions());
  await say("setPolicy(lock Calculator)", await n.setPolicy({ blockedApps: ["com.apple.calculator"] }));
  await say("pair", await n.pair({ server: "http://localhost:8911", deviceId: "dev-mac", token: "dev-token" }));
})();
