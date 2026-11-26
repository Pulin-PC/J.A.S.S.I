// Dev builds only (see test-bridge.js). Speaks, stops speaking, tries to listen, then asks for Touch ID
// (touch the sensor, or press Cancel, when the system sheet appears).
(async () => {
  const n = window.jassiNative;
  const say = (label, value) => window.__TAURI_INTERNALS__.invoke("jn_dev_log", { args: { text: label + " " + JSON.stringify(value) } });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  window.addEventListener("jassi-native", e => say("event", e.detail));
  await say("permissions", await n.permissions());
  await say("speak", await n.speak({ text: "Hello. This is J.A.S.S.I on your Mac.", lang: "en-IN" }));
  await wait(3500);
  await say("speak (a long sentence, to be cut short)", await n.speak({ text: "This sentence is long on purpose, so that it can be stopped half way through, well before it would end.", lang: "en-IN" }));
  await wait(1200);
  await say("speakStop", await n.speakStop());
  await say("listenStart", await n.listenStart({ lang: "en-IN" }));
  await wait(6000);
  await say("listenStop", await n.listenStop());
  await wait(2500);
  await say("biometric: waiting for a finger on Touch ID", null);
  await say("biometric", await n.biometric({ reason: "test Touch ID for J.A.S.S.I" }));
  await say("done", true);
})();
