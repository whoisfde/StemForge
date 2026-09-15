// No frontend bundler is used in this project (frontendDist serves src/ as-is),
// so the Tauri/plugin JS APIs come from the `withGlobalTauri` globals injected
// at runtime rather than from `@tauri-apps/*` module imports.
const { check } = window.__TAURI__.updater;
const { relaunch } = window.__TAURI__.process;
const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const READY_URL = "http://127.0.0.1:17890/ready";
const WARMUP_RETRY_URL = "http://127.0.0.1:17890/warmup-retry";
const POLL_INTERVAL_MS = 1000;

let statusViewEl;
let updateStatusViewEl;
let licenseViewEl;
let setupStartMs = null;
let updateCheckInFlight = false;
let readyPollHandle = null;

// --- License -----------------------------------------------------------

function renderLicenseForm(message, isError) {
  licenseViewEl.innerHTML = `
    ${message ? `<p class="${isError ? "license-error" : "status-row"}" style="margin:0 0 8px;">${message}</p>` : ""}
    <div class="license-form">
      <input id="license-input" type="text" placeholder="SF-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" />
      <button id="activate-button">Activate</button>
    </div>
  `;
  const input = document.querySelector("#license-input");
  const button = document.querySelector("#activate-button");
  button.addEventListener("click", () => onActivate(input, button));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onActivate(input, button);
  });
}

function renderLicenseActive() {
  licenseViewEl.innerHTML = `
    <div class="status-row">
      <span class="status-dot status-dot--ok"></span>
      <span>License: active</span>
    </div>
  `;
}

async function onActivate(input, button) {
  const key = input.value.trim();
  if (!key) return;
  button.disabled = true;
  button.textContent = "Activating...";
  try {
    const result = await invoke("activate_license", { key });
    if (result.valid) {
      renderLicenseActive();
      startReadyPolling();
    } else {
      renderLicenseForm(
        result.reason === "revoked" ? "That key has been revoked." : "That license key isn't valid.",
        true
      );
    }
  } catch (e) {
    renderLicenseForm(typeof e === "string" ? e : e?.message ?? "Activation failed.", true);
  } finally {
    const activeButton = document.querySelector("#activate-button");
    if (activeButton) {
      activeButton.disabled = false;
      activeButton.textContent = "Activate";
    }
  }
}

async function initLicenseView() {
  const hasLicense = await invoke("has_stored_license");
  if (hasLicense) {
    // Optimistic — the Rust side already spawned the companion server on
    // this assumption too. stemforge://license-revoked corrects this if
    // the background check disagrees.
    renderLicenseActive();
    startReadyPolling();
  } else {
    renderLicenseForm();
    renderWaitingForLicense();
  }
}

function render(html) {
  statusViewEl.innerHTML = html;
}

function renderWaitingForLicense() {
  setupStartMs = null;
  render(`
    <div class="status-row">
      <span class="status-dot"></span>
      <span>Waiting for license activation</span>
    </div>
  `);
}

function startReadyPolling() {
  if (readyPollHandle) return;
  checkReady();
  readyPollHandle = setInterval(checkReady, POLL_INTERVAL_MS);
}

function stopReadyPolling() {
  if (readyPollHandle) {
    clearInterval(readyPollHandle);
    readyPollHandle = null;
  }
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

function renderUpdate(html) {
  updateStatusViewEl.innerHTML = html;
}

function renderUpdateChecking() {
  renderUpdate(`
    <div class="status-row">
      <span class="spinner"></span>
      <span>Checking for updates...</span>
    </div>
  `);
}

function renderUpdateUpToDate() {
  renderUpdate(`
    <div class="status-row">
      <span class="status-dot status-dot--ok"></span>
      <span>You're up to date</span>
    </div>
  `);
}

function renderUpdateDownloading(version) {
  renderUpdate(`
    <div class="status-row">
      <span class="spinner"></span>
      <span>Downloading update ${version}...</span>
    </div>
  `);
}

function renderUpdateRestarting() {
  renderUpdate(`
    <div class="status-row">
      <span class="spinner"></span>
      <span>Restarting to finish updating...</span>
    </div>
  `);
}

function renderUpdateError(message) {
  renderUpdate(`
    <div class="status-row">
      <span class="status-dot status-dot--down"></span>
      <span>Update check failed: ${message}</span>
    </div>
  `);
}

async function checkForUpdates() {
  if (updateCheckInFlight) {
    return;
  }
  updateCheckInFlight = true;
  try {
    renderUpdateChecking();
    const update = await check();
    if (!update) {
      renderUpdateUpToDate();
      return;
    }
    renderUpdateDownloading(update.version);
    await update.downloadAndInstall((event) => {
      if (event.event === "Started" || event.event === "Progress") {
        renderUpdateDownloading(update.version);
      }
    });
    renderUpdateRestarting();
    await relaunch();
  } catch (e) {
    renderUpdateError(e?.message ?? String(e));
  } finally {
    updateCheckInFlight = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  statusViewEl = document.querySelector("#status-view");
  updateStatusViewEl = document.querySelector("#update-status-view");
  licenseViewEl = document.querySelector("#license-view");
  initLicenseView();
  listen("stemforge://license-revoked", (event) => {
    stopReadyPolling();
    renderWaitingForLicense();
    renderLicenseForm(
      event.payload === "revoked" ? "This license has been revoked." : "License check failed — activate again.",
      true
    );
  });
  listen("stemforge://license-ok", () => {
    renderLicenseActive();
    startReadyPolling();
  });
  listen("stemforge://check-for-updates", () => {
    checkForUpdates();
  });
});
