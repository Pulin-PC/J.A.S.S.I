// Dev builds only (see test-bridge.js). Prints every event the shell sends to the web app.
(() => {
  const say = (label, value) => window.__TAURI_INTERNALS__.invoke("jn_dev_log", { args: { text: label + " " + JSON.stringify(value) } });
  window.addEventListener("jassi-native", e => say("event", e.detail));
  say("listening on", location.origin);
})();
