const READY_URL = "http://127.0.0.1:17890/ready";
const WARMUP_RETRY_URL = "http://127.0.0.1:17890/warmup-retry";
const POLL_INTERVAL_MS = 1000;

let statusViewEl;
let setupStartMs = null;

function render(html) {
  statusViewEl.innerHTML = html;
}

function renderSettingUp(message) {
  if (setupStartMs === null) {
    setupStartMs = Date.now();
  }
  const elapsed = Math.floor((Date.now() - setupStartMs) / 1000);
  render(`
    <div class="status-row">
      <span class="spinner"></span>
      <span>${message}</span>
    </div>
    <div class="elapsed">${elapsed}s</div>
  `);
}

function renderReady() {
  setupStartMs = null;
  render(`
    <div class="status-row">
      <span class="status-dot status-dot--ok"></span>
      <span>Companion: running</span>
    </div>
  `);
}

function renderError(message) {
  setupStartMs = null;
  render(`
    <div class="status-row">
      <span class="status-dot status-dot--down"></span>
      <span>Setup failed: ${message}</span>
    </div>
    <button id="retry-button">Retry</button>
  `);
  document.querySelector("#retry-button").addEventListener("click", onRetry);
}

async function onRetry() {
  render(`<div class="status-row"><span class="spinner"></span><span>Retrying...</span></div>`);
  try {
    await fetch(WARMUP_RETRY_URL, { method: "POST" });
  } catch (_e) {
    // Companion isn't reachable at all; the next poll tick will show that.
  }
  checkReady();
}

async function checkReady() {
  try {
    const res = await fetch(READY_URL, { cache: "no-store" });
    if (!res.ok) {
      renderSettingUp("Starting companion server...");
      return;
    }
    const data = await res.json();
    if (data.stage === "ready") {
      renderReady();
    } else if (data.stage === "error") {
      renderError(data.error || "unknown error");
    } else {
      renderSettingUp(
        "Setting up StemForge — downloading the separation model (first launch only)…"
      );
    }
  } catch (_e) {
    renderSettingUp("Starting companion server...");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  statusViewEl = document.querySelector("#status-view");
  checkReady();
  setInterval(checkReady, POLL_INTERVAL_MS);
});
