// Dev builds only (see test-bridge.js). Asks for the microphone and speech permissions (press Allow on
// the two system prompts), then listens for 12 seconds and prints the words it hears.
(async () => {
  const n = window.jassiNative;
  const say = (label, value) => window.__TAURI_INTERNALS__.invoke("jn_dev_log", { args: { text: label + " " + JSON.stringify(value) } });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  window.addEventListener("jassi-native", e => say("event", e.detail));
  let p = await n.permissions();
  await say("permissions", p);
  if (p.mic !== "granted") await say("openPermission(mic)", await n.openPermission("mic"));
  for (let i = 0; i < 90 && (await n.permissions()).mic === "ask"; i++) await wait(1000);
  if ((await n.permissions()).speech !== "granted") await say("openPermission(speech)", await n.openPermission("speech"));
  for (let i = 0; i < 90 && (await n.permissions()).speech === "ask"; i++) await wait(1000);
  p = await n.permissions();
  await say("permissions now", p);
  const started = await n.listenStart({ lang: "en-US" });
  await say("listenStart", started);
  if (started.ok) {
    await wait(12000);
    await say("listenStop", await n.listenStop());
    await wait(3000);
  }
  await say("done", true);
})();
