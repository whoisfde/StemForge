const HEALTH_URL = "http://127.0.0.1:17890/health";
const POLL_INTERVAL_MS = 2500;

let statusDotEl;
let statusTextEl;

async function checkHealth() {
  try {
    const res = await fetch(HEALTH_URL, { cache: "no-store" });
    if (res.ok) {
      setStatus(true);
      return;
    }
    setStatus(false);
  } catch (_e) {
    setStatus(false);
  }
}

function setStatus(running) {
  statusTextEl.textContent = running
    ? "Companion: running"
    : "Companion: not responding";
  statusDotEl.classList.toggle("status-dot--ok", running);
  statusDotEl.classList.toggle("status-dot--down", !running);
}

window.addEventListener("DOMContentLoaded", () => {
  statusDotEl = document.querySelector("#status-dot");
  statusTextEl = document.querySelector("#status-text");
  checkHealth();
  setInterval(checkHealth, POLL_INTERVAL_MS);
});
