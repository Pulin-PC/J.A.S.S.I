document.getElementById("stop").addEventListener("click", () => {
  window.__TAURI_INTERNALS__.invoke("banner_stop");
});
