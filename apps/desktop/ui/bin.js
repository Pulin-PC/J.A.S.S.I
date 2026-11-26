// The bin that appears while the bubble is dragged. Driven by the native side (src/bubble.rs).
(function () {
  "use strict";
  var el = document.getElementById("bin");
  window.bin = {
    show: function () { el.classList.remove("hot"); void el.offsetWidth; el.classList.add("on"); },
    hot: function (on) { el.classList.toggle("hot", !!on); },
    hide: function () { el.classList.remove("on", "hot"); },
  };
})();
