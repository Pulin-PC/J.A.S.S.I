// Dev builds only (see test-bridge.js). Checks contract §1.3: links that leave J.A.S.S.I open in
// the default browser and the window stays on J.A.S.S.I. Opens two example pages in your browser.
(async () => {
  const say = (label, value) => window.__TAURI_INTERNALS__.invoke("jn_dev_log", { args: { text: label + " " + JSON.stringify(value) } });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  window.addEventListener("jassi-native", e => say("event", e.detail));

  const a = document.createElement("a");
  a.href = "https://example.org/";
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  await wait(1500);
  await say("after clicking an outside link, the window is still on", location.origin);

  location.href = "https://example.net/"; // a page trying to navigate away
  await wait(2000);
  await say("after an outside navigation, the window is still on", location.origin);
  await say("done", true);
})();
