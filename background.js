// background.js — service worker
// Owns: config storage, the periodic screen-capture + pixel analysis, and
// (optionally) trusted key-press dispatch via the debugger API.

const DEFAULTS = {
  enabled: false,
  calibrated: false,
  rect: null,           // {x,y,width,height} in CSS px, relative to viewport
  devicePixelRatio: 1,
  refColor: null,       // {r,g,b} sampled color of the "filled" part of the bar
  emptyColor: null,     // {r,g,b} sampled/derived color of the "empty" part of the bar
  threshold: 50,        // percent
  hotkey: "F2",
  cooldownMs: 3000,
  dispatchMode: "page",  // "page" | "debugger"
  tabId: null,
  windowId: null,
  lastPercent: null,
  lastPressAt: 0,
  lastStatus: "idle"
};

const KEY_MAP = {
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123
};

async function getConfig() {
  return await chrome.storage.local.get(DEFAULTS);
}

async function setConfig(patch) {
  await chrome.storage.local.set(patch);
}

function dist(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function darken(c, factor) {
  return { r: Math.round(c.r * factor), g: Math.round(c.g * factor), b: Math.round(c.b * factor) };
}

// --- Chrome enforces a small per-second quota on captureVisibleTab shared
// across the whole extension. Route every caller (monitor ticks, preview,
// calibration) through this single throttled queue instead of calling the
// API directly, so a manual Preview/Calibrate click never collides with the
// monitor loop and trips "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND". ---
let _captureQueue = Promise.resolve();
let _lastCaptureAt = 0;
const MIN_CAPTURE_GAP_MS = 700;

function throttledCapture(windowId, options) {
  const runPromise = _captureQueue.then(async () => {
    const wait = Math.max(0, MIN_CAPTURE_GAP_MS - (Date.now() - _lastCaptureAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _lastCaptureAt = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, options);
  });
  // Never let one failed capture poison the queue for the next caller.
  _captureQueue = runPromise.catch(() => {});
  return runPromise;
}

async function bitmapFromDataUrl(dataUrl) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  return await createImageBitmap(blob);
}

function cropImageData(bitmap, rect, dpr) {
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.max(1, Math.round(rect.width * dpr));
  const sh = Math.max(1, Math.round(rect.height * dpr));
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return ctx.getImageData(0, 0, sw, sh);
}

// Samples a small averaged block around a horizontal fraction of the rect
// (xFrac 0 = left edge, 1 = right edge), at vertical center. Averaging a
// block instead of one pixel smooths out JPEG artifacts / anti-aliasing.
async function sampleColorAvg(dataUrl, rect, dpr, xFrac) {
  const bitmap = await bitmapFromDataUrl(dataUrl);
  const img = cropImageData(bitmap, rect, dpr);
  const w = img.width, h = img.height;
  const cx = Math.max(1, Math.min(w - 2, Math.round(w * xFrac)));
  const cy = Math.floor(h / 2);
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const idx = (y * w + x) * 4;
      rs += img.data[idx]; gs += img.data[idx + 1]; bs += img.data[idx + 2]; n++;
    }
  }
  return { r: rs / n, g: gs / n, b: bs / n };
}

// Reads the calibrated rect left-to-right (averaging 3 rows around vertical
// center to reduce noise) and classifies each column as "filled" or "empty"
// by whichever of the two reference colors it's closer to — a relative
// nearest-neighbor test, which tolerates gradient shading and JPEG
// compression noise far better than a fixed absolute-distance threshold.
async function analyzePercent(dataUrl, rect, dpr, filledColor, emptyColor) {
  const bitmap = await bitmapFromDataUrl(dataUrl);
  const img = cropImageData(bitmap, rect, dpr);
  const w = img.width, h = img.height;
  if (w < 3 || h < 1) return null;
  const centerRow = Math.floor(h / 2);
  const rows = [];
  for (let dr = -1; dr <= 1; dr++) {
    const r = centerRow + dr;
    if (r >= 0 && r < h) rows.push(r);
  }
  let lastFilledX = -1;
  let miss = 0;
  for (let x = 0; x < w; x++) {
    let rs = 0, gs = 0, bs = 0;
    for (const r of rows) {
      const idx = (r * w + x) * 4;
      rs += img.data[idx]; gs += img.data[idx + 1]; bs += img.data[idx + 2];
    }
    const px = { r: rs / rows.length, g: gs / rows.length, b: bs / rows.length };
    if (dist(px, filledColor) <= dist(px, emptyColor)) {
      lastFilledX = x;
      miss = 0;
    } else {
      miss++;
      if (miss > 3) break;
    }
  }
  return Math.max(0, Math.min(100, ((lastFilledX + 1) / w) * 100));
}

async function pressViaDebugger(tabId, hotkey) {
  const keyCode = KEY_MAP[hotkey] || 113;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyDown", key: hotkey, code: hotkey,
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp", key: hotkey, code: hotkey,
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
    });
  } catch (e) {
    console.warn("HP Auto-Potion: debugger key press failed", e);
  }
}

async function ensureDebuggerAttached(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // Already attached (or attach race) — ignore.
  }
}

async function ensureDebuggerDetached(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {
    // Not attached — ignore.
  }
}

function isCalibrated(cfg) {
  return !!(cfg.calibrated && cfg.rect && cfg.refColor && cfg.emptyColor);
}

// --- Long-lived port from the content script's own timer. Keeping the tick
// driven by the page (rather than a background setInterval) avoids relying
// on the service worker staying alive between timer fires. ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "hp-monitor") return;

  port.onMessage.addListener(async (msg) => {
    const senderTab = port.sender && port.sender.tab;
    if (!senderTab) return;

    if (msg.type === "CALIBRATION_RECT") {
      try {
        const dataUrl = await throttledCapture(senderTab.windowId, { format: "png" });
        const filledColor = await sampleColorAvg(dataUrl, msg.rect, msg.devicePixelRatio, 0.03);
        let emptyColor = await sampleColorAvg(dataUrl, msg.rect, msg.devicePixelRatio, 0.97);
        // If the right edge looks basically the same as the fill (HP was
        // near 100% at calibration time), fall back to a darkened guess
        // rather than using two indistinguishable anchors.
        if (dist(filledColor, emptyColor) < 40) {
          emptyColor = darken(filledColor, 0.35);
        }
        await setConfig({
          rect: msg.rect,
          devicePixelRatio: msg.devicePixelRatio,
          refColor: filledColor,
          emptyColor,
          calibrated: true,
          tabId: senderTab.id,
          windowId: senderTab.windowId,
          lastStatus: "calibrated"
        });
        port.postMessage({ type: "CALIBRATION_DONE", refColor: filledColor, emptyColor });
      } catch (e) {
        port.postMessage({ type: "CALIBRATION_ERROR", error: String(e) });
      }
      return;
    }

    if (msg.type === "TICK") {
      const cfg = await getConfig();
      if (!cfg.enabled || !isCalibrated(cfg)) return;
      if (cfg.tabId !== senderTab.id) return; // only the calibrated tab drives presses

      let tab;
      try {
        tab = await chrome.tabs.get(cfg.tabId);
      } catch (e) {
        return;
      }
      if (!tab.active) {
        await setConfig({ lastStatus: "tab not focused" });
        port.postMessage({ type: "STATUS", status: "tab not focused" });
        return;
      }

      let dataUrl;
      try {
        dataUrl = await throttledCapture(tab.windowId, { format: "jpeg", quality: 80 });
      } catch (e) {
        return; // rate-limited or transient; just skip this tick
      }

      const percent = await analyzePercent(dataUrl, cfg.rect, cfg.devicePixelRatio, cfg.refColor, cfg.emptyColor);
      if (percent == null) return;

      await setConfig({ lastPercent: percent, lastStatus: "ok" });
      port.postMessage({ type: "STATUS", status: "ok", percent });

      const now = Date.now();
      if (percent < cfg.threshold && now - cfg.lastPressAt > cfg.cooldownMs) {
        await setConfig({ lastPressAt: now });
        if (cfg.dispatchMode === "debugger") {
          await pressViaDebugger(cfg.tabId, cfg.hotkey);
        } else {
          port.postMessage({ type: "PRESS", key: cfg.hotkey });
        }
      }
    }
  });
});

// --- One-off control messages from the popup ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SET_ENABLED") {
    (async () => {
      const cfg = await getConfig();
      if (cfg.tabId && cfg.dispatchMode === "debugger") {
        if (msg.enabled) await ensureDebuggerAttached(cfg.tabId);
        else await ensureDebuggerDetached(cfg.tabId);
      }
      await setConfig({ enabled: msg.enabled });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "SET_DISPATCH_MODE") {
    (async () => {
      const cfg = await getConfig();
      if (cfg.tabId) {
        if (msg.mode === "debugger" && cfg.enabled) await ensureDebuggerAttached(cfg.tabId);
        if (msg.mode === "page") await ensureDebuggerDetached(cfg.tabId);
      }
      await setConfig({ dispatchMode: msg.mode });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "TEST_PRESS") {
    (async () => {
      const cfg = await getConfig();
      if (!cfg.tabId || !isCalibrated(cfg)) {
        sendResponse({ ok: false, error: "Not calibrated yet" });
        return;
      }
      if (cfg.dispatchMode === "debugger") {
        await ensureDebuggerAttached(cfg.tabId);
        await pressViaDebugger(cfg.tabId, cfg.hotkey);
      } else {
        try {
          await chrome.tabs.sendMessage(cfg.tabId, { type: "PRESS_KEY_DIRECT", key: cfg.hotkey });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
          return;
        }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "PREVIEW") {
    (async () => {
      const cfg = await getConfig();
      if (!cfg.tabId || !isCalibrated(cfg)) {
        sendResponse({ ok: false, error: "Not calibrated yet (recalibrate if you set this up before an update)" });
        return;
      }
      try {
        const dataUrl = await throttledCapture(cfg.windowId, { format: "jpeg", quality: 80 });
        const percent = await analyzePercent(dataUrl, cfg.rect, cfg.devicePixelRatio, cfg.refColor, cfg.emptyColor);
        sendResponse({ ok: true, percent });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});
