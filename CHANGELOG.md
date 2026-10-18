# Changelog

Tracks every released version of the Gostationery Kiosk desktop app and what changed.
Newest first. Bump `version` in `package.json` for each release and add an entry here.

## 1.0.13 — 2026-10-18
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
