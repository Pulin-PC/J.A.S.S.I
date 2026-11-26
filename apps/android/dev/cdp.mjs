// Dev helper: run a line of JavaScript inside the app's WebView (debug builds only) and print the result.
// Usage: node dev/cdp.mjs 'window.jassiNative.permissions()'      (set ANDROID_SERIAL to pick a device)
import { execFileSync } from "node:child_process";

const adb = (...args) => execFileSync("adb", args, { encoding: "utf8" }).trim();
const pid = adb("shell", "pidof", "app.jassi.android");
const port = Number(process.env.CDP_PORT || 9333);
adb("forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find((p) => p.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({
  id: 1, method: "Runtime.evaluate",
  params: { expression: process.argv[2], awaitPromise: true, returnByValue: true, userGesture: true },
}));
ws.onmessage = (m) => {
  const r = JSON.parse(m.data);
  if (r.id !== 1) return;
  const v = r.result?.result;
  console.log(r.result?.exceptionDetails ? "ERROR " + JSON.stringify(r.result.exceptionDetails.exception?.description) : JSON.stringify(v?.value));
  process.exit(0);
};
setTimeout(() => { console.error("timed out"); process.exit(1); }, Number(process.env.CDP_TIMEOUT || 30000));
