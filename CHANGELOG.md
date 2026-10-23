# Changelog

Tracks every released version of the Gostationery Kiosk desktop app and what changed.
Newest first. Bump `version` in `package.json` for each release and add an entry here.

## 1.0.15 — 2026-10-23
**Fix: double token prints, without the freeze that broke 1.0.13**
- A slip already printed for an order is remembered on disk (`printed-slips.json`, 24 h) and is never printed again, even if the kiosk UI re-requests it, reloads or the app restarts.
- After each slip the printer is read once. If it reports paper-out / cover-open it is re-checked after 1.5 s: still faulty = the slip was cut short and is REPRINTED fresh once the printer is ready (real paper-out); cleared = a momentary sensor glitch after a good print, so it is NOT reprinted (this glitch caused the double token).
- Printer re-discovery no longer freezes the app: the PowerShell device scans (8-10 s each) ran synchronously on the main thread every 15 s whenever the printer could not be opened, stalling printing and the UI. They now run in the background.
- A printer that is unplugged, or a scan that cannot read USB presence, no longer makes the kiosk pick an old printer this PC once had (stuck on NOT_SUPPORTED, endless re-scans). Unplugged now reports OFF.
- One failed USB open right after a job no longer flips the status (and backend alert) to OFF; it must fail twice in a row.
- Fewer blocking printer reads: the pre-print check uses the monitor's latest reading (one forced read only if it is older than 2.5 s); the USB reopen after each job is gone and the result report runs off the print path; status query timeout 1500 → 700 ms. The re-check pause is an async sleep that never holds the main thread.

## 1.0.14 — 2026-10-22
**Revert: 1.0.13 printer re-check removed (app not responding / freezing)**
- `main.js` and `printer-monitor.js` are restored to the exact 1.0.12 code. Version is 1.0.14 only so the auto-updater (which never goes backwards) will deliver it.
- The 1.0.13 "paper-out blip" debounce is gone, so the double-token-print issue it addressed can come back.

## 1.0.13 — 2026-10-18 (reverted in 1.0.14)
**Fix: double token print when the printer glitched "paper out"**
- Cause: right after a slip printed, the paper sensor sometimes glitched to "paper out" for a split second. The app marked the already-printed slip as failed, retried it (second token) and sent a false "paper out" WhatsApp alert.
- A paper-out / cover-open / offline reading is now re-checked every 0.5 s for up to 5 s before it is trusted. If it clears, the slip counts as printed (no second print, no alert).
- If it persists for the full 5 s (real paper-out), the slip is still marked failed and the whole token is re-printed, as before.
- The same 5 s check applies before printing, and to the status sent to the backend (which triggers the WhatsApp alert).
- A slip already confirmed printed in a job is never printed again.
- Files: `main.js`, `printer-monitor.js`.

## 1.0.12 — 2026-09-29
- Ctrl+Shift+L pairing-reset shortcut made reliable; updater start-up guarded.

## 1.0.10 — 2026-09-29
- Test build for custom token print.

## 1.0.7 — 2026-06-21
- Forms and printer status on the kiosk machine; app named "gostationary".
