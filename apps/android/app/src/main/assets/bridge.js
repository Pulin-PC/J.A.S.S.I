// window.jassiNative (docs/native-contract.md §2). Runs before the page's own scripts,
// only in the main frame of the J.A.S.S.I site. Talks to the app through __jassiHost.
(function () {
  if (window.jassiNative || window.top !== window) return;
  var host = window.__jassiHost;
  if (!host) return;
  var seq = 0, waiting = {}, held = [], loaded = document.readyState === "complete";

  function emit(detail) {
    window.dispatchEvent(new CustomEvent("jassi-native", { detail: detail }));
  }
  host.onmessage = function (e) {
    var m;
    try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.id) {
      var done = waiting[m.id];
      delete waiting[m.id];
      if (done) done(m.result);
    } else if (m.event) {
      if (loaded) emit(m.event); else held.push(m.event);   // keep events until the page has loaded
    }
  };
  window.addEventListener("load", function () {
    setTimeout(function () { loaded = true; held.splice(0).forEach(emit); }, 0);
  });

  function call(method, args) {
    return new Promise(function (resolve) {
      var id = ++seq;
      waiting[id] = resolve;
      try {
        host.postMessage(JSON.stringify({ id: id, method: method, args: args === undefined ? null : args }));
      } catch (_) {
        delete waiting[id];
        resolve({ ok: false, error: "unsupported" });
      }
    });
  }

  var api = { platform: "android", version: "__VERSION__", contract: 1 };
  ["listApps", "permissions", "openPermission", "pair", "unpair", "setPolicy", "openExternal", "biometric",
   "listenStart", "listenStop", "speak", "speakStop", "notify", "stop", "bubble"].forEach(function (name) {
    api[name] = function (args) { return call(name, args); };
  });
  Object.defineProperty(window, "jassiNative", { value: Object.freeze(api), writable: false, configurable: false });
  host.postMessage(JSON.stringify({ hello: 1 }));
})();
