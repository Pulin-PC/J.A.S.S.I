// The caption beside the bubble: your words as you say them, then the reply. It never takes a click
// (the window ignores the mouse), shows two lines at most, and fades a few seconds after the last words.
(function () {
  "use strict";
  var box = document.getElementById("cap"), who = document.getElementById("who"), words = document.getElementById("words");
  var fade = 0;
  var LIVE_MS = 2600, REPLY_MS = 4200;
  window.cap = {
    say: function (text, from) {
      text = String(text || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      var mine = from !== "jassi";
      if (mine && text.length > 110) text = "…" + text.slice(-108);   // keep the newest words in view
      who.textContent = mine ? "You" : "J.A.S.S.I";
      words.textContent = text;
      box.classList.toggle("mine", mine);
      box.classList.add("on");
      clearTimeout(fade);
      fade = setTimeout(window.cap.clear, mine ? LIVE_MS : Math.min(9000, REPLY_MS + text.length * 25));
    },
    clear: function () { clearTimeout(fade); box.classList.remove("on"); },
    side: function (s) { document.body.classList.toggle("left", s === "left"); document.body.classList.toggle("right", s !== "left"); },
  };
})();
