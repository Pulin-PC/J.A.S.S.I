// The start screen: try to reach J.A.S.S.I, and show "Can't reach J.A.S.S.I." when that fails.
const wait = document.getElementById("wait");
const off = document.getElementById("off");
let timer = 0;

function show(offline) {
  clearTimeout(timer);
  wait.hidden = offline;
  off.hidden = !offline;
}

async function connect() {
  show(false);
  let ok = false;
  try { ok = (await window.__TAURI_INTERNALS__.invoke("shell_connect")).ok === true; } catch (e) { ok = false; }
  if (!ok) return show(true);
  timer = setTimeout(() => show(true), 15000); // still on this screen: the page never arrived
}

document.getElementById("retry").addEventListener("click", connect);
if (location.hash === "#offline") show(true); else connect();
