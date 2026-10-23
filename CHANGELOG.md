# Changelog

Tracks every released version of the Gostationery Kiosk desktop app and what changed.
Newest first. Bump `version` in `package.json` for each release and add an entry here.

## 1.0.15 — 2026-10-23
**Fix: double token prints, without the freeze that broke 1.0.13**
- A slip already printed for an order is remembered on disk (`printed-slips.json`, 24 h) and is never printed again, even if the kiosk UI re-requests it, reloads or the app restarts.
- A printer "paper out / cover open" reading right AFTER a slip was accepted no longer fails that slip (this glitch caused the retry that printed a second token). The slip counts as printed and the org is alerted that it may be incomplete.
- Fewer blocking printer reads: the pre-print check uses the monitor's latest reading (one forced read only if it is older than 2.5 s); the post-print forced read and the USB reopen after each job are gone; status query timeout 1500 → 700 ms. Nothing is added to the print path that waits or polls.

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
