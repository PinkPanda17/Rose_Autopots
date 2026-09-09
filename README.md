# HP Auto-Potion — Alpha Rose Online

A Chrome extension that watches your HP bar in the `alpharoseonline.com` game
tab and automatically presses a hotkey (default **F2**) when your HP drops
below a threshold (default **50%**).

It works by periodically taking a screenshot of just the game tab (via
Chrome's own `captureVisibleTab` API), cropping to the small box you drew
around your HP bar, and measuring how far the "filled" color extends from
left to right — by sampling a color near the box's left edge (filled) and
right edge (empty) at calibration time, then classifying each column by
whichever of the two it's closer to. This works whether the bar is drawn on
the WebGL canvas or as an HTML overlay, so no game-specific reverse
engineering is needed.

**Please read "Important caveats" below before using this on your real account.**

## Install (load as an unpacked extension)

1. Unzip this folder somewhere permanent (don't delete it — Chrome loads the
   extension from these files every time it starts).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder (`hp-autopotion-extension`).
5. Pin the extension (puzzle-piece icon → pin) so you can reach its popup
   quickly.

## Set it up

1. Log into Alpha Rose Online in a Chrome tab as you normally would, and get
   your character on-screen so the HP bar is visible.
2. Click the extension icon → **Calibrate HP bar**.
3. Your cursor becomes a crosshair. Click-drag a tight box around just the
   HP bar itself (not the whole HUD panel) — left edge of your box should
   line up with the left edge of the bar (0% HP), right edge with the bar's
   right edge (full HP).
4. Release the mouse. You'll see "Calibrated!" — the extension just sampled
   a "filled" reference color near the box's left edge and an "empty"
   reference color near its right edge.
5. Open the popup again and check the two color swatches at the bottom
   ("filled" / "empty"). They should visibly look like the bar's actual fill
   color and its actual background/empty color — if either swatch looks
   wrong (e.g. black, white, or a UI border color), your box wasn't tightly
   on the bar. Redo calibration: keep the box thin (just the fill track
   itself), stay inside the black border/outline around the bar, and avoid
   letting HP number text overlap the box.
6. Click **Preview current reading** — it should show a percentage close to
   your actual current HP%. If the swatches look right but the number is
   still off, your HP bar may use a gradient effect wide enough that a
   recalibration with a shorter box (closer to the vertical center of the
   bar, away from any glossy highlight near the top) usually fixes it.
7. Click **Test press hotkey** while safely out of combat and watch whether
   your potion actually gets used. If nothing happens:
   - Double-check F2 (or whichever key you configured) is actually bound to
     a healing item in-game.
   - Switch **Key dispatch mode** to "Debugger / trusted" and test again —
     some games ignore script-generated key presses unless they come through
     Chrome's debugger protocol. This mode shows a yellow "extension started
     debugging this browser" banner on the tab while active; that's expected.
8. Set your threshold %, cooldown, and hotkey, then flip the **Monitoring**
   toggle on.

## After updating the extension

If you already loaded a previous version: go to `chrome://extensions` and
hit the reload icon on this extension's card.

- If you're updating from the very first version, Chrome may prompt you to
  accept a permission update (this added `activeTab`, which
  `captureVisibleTab` actually requires — a permission scoped to just
  alpharoseonline.com isn't enough on its own).
- **This version needs you to recalibrate once** — it now samples both a
  "filled" and an "empty" reference color (see "Set it up" above) instead of
  just one, which fixes badly-off readings. The popup will show
  "Calibrated: needs recalibration" until you do.

Note on `activeTab`: it's granted each time you open the extension's popup
while the game tab is focused, and stays valid until that tab navigates or
reloads (e.g. you relog or refresh). If capture ever stops working, just
click the extension icon once while the game tab is active to re-grant it.

## While it's running

- Keep the Alpha Rose Online tab focused/visible (not minimized, not covered
  by switching to another tab) — Chrome's tab-capture API only captures the
  currently active tab, so the extension pauses (status: "tab not focused")
  if you switch away.
- The popup's status box shows the last HP reading and whether a press
  recently fired, so you can confirm it's working without staring at the
  game.
- If the game's UI moves (window resize, different zoom level, changed
  resolution), re-run calibration.

## Important caveats

- **Server rules / ban risk**: automating potion use is the kind of thing
  many game servers — including private ones — restrict as botting/macroing,
  regardless of how "harmless" it feels. Check Alpha Rose Online's rules or
  ask staff (Discord) before running this on your real account. This tool
  only automates your own client input; it doesn't read or modify the game's
  memory or network traffic.
- **Tab-capture rate limits**: Chrome limits how often a tab can be
  screenshotted per second, shared across the whole extension. The
  monitoring loop and the Preview/Calibrate buttons all go through the same
  internal throttle now (roughly 1 capture per 0.7s) so they can't collide
  and trip Chrome's own quota error — but it does mean readings aren't
  frame-perfect reaction time.
- **False triggers**: if the bar's empty/background color happens to be
  close to the filled color (low contrast), readings can be inaccurate — use
  **Preview current reading** and the color swatches after calibrating to
  sanity-check it against your actual HP.
- Nothing here reads your password or account — the extension only sees
  pixels in the tab you already have open and dispatches a key press into
  that same tab.

## Files

- `manifest.json` — Chrome extension manifest (Manifest V3)
- `background.js` — capture + pixel analysis + optional debugger-based key press
- `content.js` — calibration overlay UI + key dispatch inside the page
- `popup.html` / `popup.js` — the control panel
