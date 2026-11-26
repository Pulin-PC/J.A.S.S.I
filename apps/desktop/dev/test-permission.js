// Dev builds only (see test-bridge.js). Asks for the alerts and screen permissions the way setup does,
// then prints every `permission` event, so you can watch it arrive when you flip the switch.
(async () => {
  const n = window.jassiNative;
  const say = (label, value) => window.__TAURI_INTERNALS__.invoke("jn_dev_log", { args: { text: label + " " + JSON.stringify(value) } });
  window.addEventListener("jassi-native", e => say("event", e.detail));
  await say("before", await n.permissions());
  await say("openPermission(notifications)", await n.openPermission("notifications"));
  await say("openPermission(screen)", await n.openPermission("screen"));
  await say("done", true);
})();
