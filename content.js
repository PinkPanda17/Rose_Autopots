// content.js — runs inside the game page.
// Responsibilities: draw the calibration selection box, drive the tick
// timer that asks the background service worker to capture+analyze, and
// dispatch the actual key press into the page.

let port = null;
let tickInterval = null;

function startTicking() {
  if (port) return;
  try {
    port = chrome.runtime.connect({ name: "hp-monitor" });
  } catch (e) {
    return;
  }
  port.onMessage.addListener((msg) => {
    if (msg.type === "PRESS") dispatchKey(msg.key);
  });
  port.onDisconnect.addListener(() => {
    port = null;
  });
  tickInterval = setInterval(() => {
    if (port) {
      try {
        port.postMessage({ type: "TICK" });
      } catch (e) {
        // port may have gone stale (e.g. extension reloaded); stop cleanly
        stopTicking();
      }
    }
  }, 1000);
}

function stopTicking() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = null;
  if (port) {
    try { port.disconnect(); } catch (e) {}
    port = null;
  }
}

chrome.storage.local.get(["enabled"], ({ enabled }) => {
  if (enabled) startTicking();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) {
    if (changes.enabled.newValue) startTicking();
    else stopTicking();
  }
});

function dispatchKey(hotkey) {
  const map = { F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123 };
  const keyCode = map[hotkey] || 113;
  const opts = { key: hotkey, code: hotkey, keyCode, which: keyCode, bubbles: true, cancelable: true };
  const targets = [document, window, document.activeElement].filter(Boolean);
  for (const t of targets) {
    t.dispatchEvent(new KeyboardEvent("keydown", opts));
    t.dispatchEvent(new KeyboardEvent("keyup", opts));
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_CALIBRATION") {
    beginCalibration();
    sendResponse({ ok: true });
  }
  if (msg.type === "PRESS_KEY_DIRECT") {
    dispatchKey(msg.key);
    sendResponse({ ok: true });
  }
});

// --- Calibration overlay: drag a box around the HP bar ---
function beginCalibration() {
  if (document.getElementById("__hpbot_overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "__hpbot_overlay";
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", zIndex: 2147483647,
    cursor: "crosshair", background: "rgba(0,0,0,0.15)"
  });
  document.documentElement.appendChild(overlay);

  const hint = document.createElement("div");
  hint.textContent = "Drag a box tightly around your HP bar (left edge = 0%, right edge = full). Esc to cancel.";
  Object.assign(hint.style, {
    position: "fixed", top: "10px", left: "50%", transform: "translateX(-50%)",
    background: "#111", color: "#fff", padding: "8px 14px", borderRadius: "6px",
    font: "13px/1.4 sans-serif", zIndex: 2147483647, pointerEvents: "none"
  });
  overlay.appendChild(hint);

  let startPt = null;
  let box = null;

  function onKeydown(e) {
    if (e.key === "Escape") cleanup();
  }
  function onMouseDown(e) {
    startPt = { x: e.clientX, y: e.clientY };
    box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed", border: "2px solid #ff3355",
      background: "rgba(255,51,85,0.15)", zIndex: 2147483647, pointerEvents: "none"
    });
    overlay.appendChild(box);
  }
  function onMouseMove(e) {
    if (!startPt || !box) return;
    const x = Math.min(startPt.x, e.clientX), y = Math.min(startPt.y, e.clientY);
    const w = Math.abs(e.clientX - startPt.x), h = Math.abs(e.clientY - startPt.y);
    Object.assign(box.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  }
  function onMouseUp(e) {
    if (!startPt) return;
    const x = Math.min(startPt.x, e.clientX), y = Math.min(startPt.y, e.clientY);
    const w = Math.abs(e.clientX - startPt.x), h = Math.abs(e.clientY - startPt.y);
    startPt = null;
    if (w < 4 || h < 2) { cleanup(); return; }

    const rect = { x, y, width: w, height: h };
    let calPort;
    try {
      calPort = chrome.runtime.connect({ name: "hp-monitor" });
    } catch (err) {
      hint.textContent = "Calibration failed to reach the extension. Try again.";
      setTimeout(cleanup, 1800);
      return;
    }
    calPort.postMessage({ type: "CALIBRATION_RECT", rect, devicePixelRatio: window.devicePixelRatio });
    calPort.onMessage.addListener((msg) => {
      if (msg.type === "CALIBRATION_DONE") {
        hint.textContent = "Calibrated! Open the extension popup to enable monitoring.";
        pointerEventsOff();
        setTimeout(cleanup, 1600);
      } else if (msg.type === "CALIBRATION_ERROR") {
        hint.textContent = "Calibration failed: " + msg.error;
        setTimeout(cleanup, 2200);
      }
    });
  }
  function pointerEventsOff() {
    overlay.style.pointerEvents = "none";
  }
  function cleanup() {
    document.removeEventListener("keydown", onKeydown, true);
    overlay.removeEventListener("mousedown", onMouseDown);
    overlay.removeEventListener("mousemove", onMouseMove);
    overlay.removeEventListener("mouseup", onMouseUp);
    overlay.remove();
  }

  document.addEventListener("keydown", onKeydown, true);
  overlay.addEventListener("mousedown", onMouseDown);
  overlay.addEventListener("mousemove", onMouseMove);
  overlay.addEventListener("mouseup", onMouseUp);
}
