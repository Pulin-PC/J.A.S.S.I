// window.jassiNative (docs/native-contract.md §2). Runs before the page's own scripts.
// Only in the main frame, only on the J.A.S.S.I origin. The native side checks both again.
(function () {
  var ORIGIN = "__JASSI_ORIGIN__";
  if (window.top !== window || location.origin !== ORIGIN || window.jassiNative) return;

  function call(cmd, args) {
    try {
      return window.__TAURI_INTERNALS__.invoke(cmd, args ? { args: args } : {}).then(
        function (r) { return r; },
        function (e) { return { ok: false, error: String((e && e.message) || e || "failed") }; }
      );
    } catch (e) {
      return Promise.resolve({ ok: false, error: "unsupported" });
    }
  }
  function obj(o) { return o && typeof o === "object" ? o : {}; }
  function str(v) { return v == null ? "" : String(v); }

  window.jassiNative = Object.freeze({
    platform: "__PLATFORM__",
    version: "__VERSION__",
    contract: 1,
    listApps: function () { return call("jn_list_apps"); },
    permissions: function () { return call("jn_permissions"); },
    openPermission: function (kind) { return call("jn_open_permission", { kind: str(kind) }); },
    pair: function (o) { o = obj(o); return call("jn_pair", { server: str(o.server), deviceId: str(o.deviceId), token: str(o.token) }); },
    unpair: function () { return call("jn_unpair"); },
    setPolicy: function (o) { o = obj(o); return call("jn_set_policy", { blockedApps: Array.isArray(o.blockedApps) ? o.blockedApps.map(str) : [] }); },
    openExternal: function (url) { return call("jn_open_external", { url: str(url) }); },
    biometric: function (o) { return call("jn_biometric", { reason: str(obj(o).reason) }); },
    listenStart: function (o) { o = obj(o); return call("jn_listen_start", { lang: str(o.lang), onDevice: o.onDevice === true }); },
    listenStop: function () { return call("jn_listen_stop"); },
    speak: function (o) { o = obj(o); return call("jn_speak", { text: str(o.text), lang: str(o.lang) }); },
    speakStop: function () { return call("jn_speak_stop"); },
    notify: function (o) { o = obj(o); return call("jn_notify", { title: str(o.title), body: str(o.body) }); },
    stop: function () { return call("jn_stop"); },
    bubble: function (o) { o = obj(o); var a = {}; if (typeof o.visible === "boolean") a.visible = o.visible; if (typeof o.state === "string") a.state = o.state; if (typeof o.text === "string") { a.text = o.text; a.who = o.who === "jassi" ? "jassi" : "you"; } return call("jn_bubble", a); }
  });

  // Links that leave J.A.S.S.I open in the default browser, never in this window.
  function outside(href) {
    try { var u = new URL(href, location.href); return u.origin !== ORIGIN ? u.href : null; } catch (e) { return null; }
  }
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    var href = a && outside(a.href);
    if (!href) return;
    e.preventDefault();
    call("jn_open_external", { url: href });
  }, true);
  var pageOpen = window.open;
  window.open = function (url) {
    var href = url && outside(String(url));
    if (!href) return pageOpen.apply(window, arguments);
    call("jn_open_external", { url: href });
    return { closed: false, close: function () {}, focus: function () {} };
  };

  // Tell the shell the page is here (start) and ready for queued events (loaded).
  call("jn_page", { state: "start" });
  function loaded() { setTimeout(function () { call("jn_page", { state: "loaded" }); }, 0); }
  if (document.readyState === "complete") loaded(); else window.addEventListener("load", loaded);
})();
