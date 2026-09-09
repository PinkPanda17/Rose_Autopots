const HOTKEYS = ["F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"];

const $ = (id) => document.getElementById(id);

function fillHotkeys(selected) {
  const sel = $("hotkey");
  sel.innerHTML = "";
  for (const k of HOTKEYS) {
    const opt = document.createElement("option");
    opt.value = k; opt.textContent = k;
    if (k === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function load() {
  const cfg = await chrome.storage.local.get({
    enabled: false, calibrated: false, threshold: 50, hotkey: "F2",
    cooldownMs: 3000, dispatchMode: "page", lastPercent: null, lastStatus: "idle",
    refColor: null, emptyColor: null
  });
  fillHotkeys(cfg.hotkey);
  $("enabled").checked = cfg.enabled;
  $("threshold").value = cfg.threshold;
  $("cooldown").value = cfg.cooldownMs;
  $("dispatchMode").value = cfg.dispatchMode;
  renderStatus(cfg);
}

function rgbStr(c) {
  if (!c) return null;
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
}

function renderStatus(cfg) {
  // Calibration only counts once both reference colors exist — older
  // calibrations (before dual-color matching) are missing emptyColor and
  // need to be redone.
  const fullyCalibrated = !!(cfg.calibrated && cfg.refColor && cfg.emptyColor);
  const calEl = $("calStatus");
  calEl.textContent = fullyCalibrated ? "yes" : (cfg.calibrated ? "needs recalibration" : "no");
  calEl.className = "pill " + (fullyCalibrated ? "ok" : "off");
  $("lastPercent").textContent = cfg.lastPercent == null ? "—" : cfg.lastPercent.toFixed(1) + "%";
  $("lastStatus").textContent = cfg.lastStatus || "idle";

  const filled = rgbStr(cfg.refColor), empty = rgbStr(cfg.emptyColor);
  $("filledSwatch").style.background = filled || "#000";
  $("filledText").textContent = "filled: " + (filled || "—");
  $("emptySwatch").style.background = empty || "#000";
  $("emptyText").textContent = "empty: " + (empty || "—");
}

async function refreshStatus() {
  const cfg = await chrome.storage.local.get({
    calibrated: false, lastPercent: null, lastStatus: "idle", refColor: null, emptyColor: null
  });
  renderStatus(cfg);
}

$("enabled").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled });
});

// "input" (not "change") so this saves on every keystroke rather than
// waiting for the field to lose focus — a popup can close before a number
// field ever blurs, which was silently discarding edits.
$("threshold").addEventListener("input", (e) => {
  const n = Number(e.target.value);
  if (!Number.isFinite(n)) return;
  chrome.storage.local.set({ threshold: n });
});
$("cooldown").addEventListener("input", (e) => {
  const n = Number(e.target.value);
  if (!Number.isFinite(n)) return;
  chrome.storage.local.set({ cooldownMs: n });
});
$("hotkey").addEventListener("change", (e) => {
  chrome.storage.local.set({ hotkey: e.target.value });
});
$("dispatchMode").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "SET_DISPATCH_MODE", mode: e.target.value });
});

$("calibrate").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "START_CALIBRATION" });
    window.close();
  } catch (e) {
    alert("Couldn't reach the game tab. Make sure you're on alpharoseonline.com and reload that tab once after installing the extension.");
  }
});

$("testPress").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "TEST_PRESS" });
  if (!res || !res.ok) alert("Test press failed: " + (res && res.error || "not calibrated yet"));
});

$("preview").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "PREVIEW" });
  if (res && res.ok) {
    $("lastPercent").textContent = res.percent.toFixed(1) + "%";
  } else {
    alert("Preview failed: " + (res && res.error || "not calibrated yet"));
  }
});

load();
setInterval(refreshStatus, 1000);
