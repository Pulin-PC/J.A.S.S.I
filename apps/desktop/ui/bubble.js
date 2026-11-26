// The floating bubble: tap to talk (or stop), drag anywhere, drop on the bin to put it away.
// The app follows the real mouse during a drag (src/bubble.rs, bubble_grab): a window that never takes focus
// can't count on the page's own drag events. This page draws the states and animates the settle.
(function () {
  "use strict";
  var invoke = function (cmd, args) { try { return window.__TAURI_INTERNALS__.invoke(cmd, args || {}); } catch (e) { return Promise.resolve({ ok: false }); } };
  var orb = document.getElementById("orb");
  var settle = 0;

  window.jb = {
    shown: function () {
      orb.classList.remove("gone", "bye", "pop");
      document.body.classList.remove("drag", "hot");
      void orb.offsetWidth;
      orb.classList.add("pop");
      setTimeout(function () { orb.classList.remove("pop"); }, 600);
    },
    state: function (s) { document.body.dataset.state = s; },
    drag: function (on) { cancelAnimationFrame(settle); document.body.classList.toggle("drag", !!on); },
    hot: function (on) { document.body.classList.toggle("hot", !!on); },
    bye: function () {
      orb.classList.add("bye");
      setTimeout(function () { document.body.classList.remove("hot", "drag"); orb.classList.add("gone"); orb.classList.remove("bye"); }, 260);
    },
    // Spring-like settle (ease-out-back) to the side it was flung towards, one move per frame.
    settle: function (fx, fy, tx, ty) {
      cancelAnimationFrame(settle);
      var t0 = performance.now(), dur = 420;
      var ease = function (t) { var c = 1.3; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
      (function step() {
        var t = Math.min(1, (performance.now() - t0) / dur), k = ease(t);
        invoke("bubble_move", { x: fx + (tx - fx) * k, y: fy + (ty - fy) * k }).catch(function () {});
        if (t < 1) settle = requestAnimationFrame(step);
      })();
    },
  };

  orb.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    cancelAnimationFrame(settle);
    invoke("bubble_grab").then(function (r) {
      if (r && r.ok === false) invoke("bubble_tap");   // no mouse tracking on this system: a press is a tap
    }, function () {});
  });
})();
