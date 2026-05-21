#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# GoStationary Kiosk Launcher
# ─────────────────────────────────────────────────────────────────
# Run this script on the kiosk machine to launch Chrome in full
# kiosk mode with SILENT PRINTING (no print dialog, auto-prints
# to the default printer when window.print() is called).
#
# Before running:
#   1. Set your receipt printer as the DEFAULT printer in OS settings.
#   2. Confirm Chrome/Chromium is installed.
#   3. chmod +x launch-kiosk.sh && ./launch-kiosk.sh
# ─────────────────────────────────────────────────────────────────

KIOSK_URL="https://gostationary-kiosk-frontend.vercel.app"

# On macOS:
if [[ "$OSTYPE" == "darwin"* ]]; then
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    --kiosk \
    --kiosk-printing \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-translate \
    --no-first-run \
    --app="$KIOSK_URL"
fi

# On Linux:
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  google-chrome \
    --kiosk \
    --kiosk-printing \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-translate \
    --no-first-run \
    --app="$KIOSK_URL"
fi

# ─────────────────────────────────────────────────────────────────
# What --kiosk-printing does:
#   window.print() sends the job DIRECTLY to the OS default printer.
#   No dialog. No "Save as PDF". Fully silent.
#
# What --kiosk does:
#   Full-screen, no address bar, no tabs, no browser UI.
#
# What --app does:
#   Launches as an installed PWA window (no browser chrome).
# ─────────────────────────────────────────────────────────────────
