// Dev builds only (see test-bridge.js). Sends one system alert. Run the app in the background
// (open -g) to see the banner: macOS files alerts quietly while their own app is in front.
(async () => {
  const n = window.jassiNative;
  const say = (label, value) => window.__TAURI_INTERNALS__.invoke("jn_dev_log", { args: { text: label + " " + JSON.stringify(value) } });
  await say("permissions", await n.permissions());
  await say("notify", await n.notify({ title: "J.A.S.S.I", body: "Test alert from the desktop app." }));
  await say("done", true);
})();
