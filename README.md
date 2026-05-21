
# GoStationary Kiosk – Desktop App

Electron wrapper for the GoStationary kiosk web frontend. Runs in fullscreen kiosk mode and prints bills **silently** to the first physical printer found (no print-dialog, no "Save as PDF").

---

## Quick Start (Development)

```bash
cd gostationary_kiosk_electron
npm install
npm start
```

If `npm start` fails with **EACCES** on `kiosk-ui`, a previous build was likely run as root. Fix ownership once, then start again:

```bash
sudo chown -R "$USER:$USER" kiosk-ui
npm start
```

Avoid running `npm run build:linux` or `electron-builder` with `sudo` — that leaves root-owned files in `kiosk-ui` and `dist/`.

On first launch you'll see the **Setup screen** → enter your **Org Domain**, **Machine Serial Number**, and **Backend API URL** (default `http://127.0.0.1:8000`) → click **Launch Kiosk**.  
The app serves the **same kiosk UI** as the web app from a local bundle and talks to your backend directly (no hosted frontend). Credentials are stored locally and the kiosk auto-loads on every subsequent launch.

Before first run (or after frontend changes), bundle the UI into the app:

```bash
cd gostationary_kiosk_electron
npm run prepare:kiosk   # builds frontend + copies dist → kiosk-ui/
npm start
```

### Linux system dependencies (printer monitor)

On the **Setup** screen, the app shows live printer health (USB door/paper/error) and CUPS job logs (job started / completed / failed). Install these on each kiosk machine:

| Distro | Command |
|--------|---------|
| Fedora | `sudo dnf install python3-cups python3-usb` |
| Ubuntu / Debian | `sudo apt install python3-cups python3-usb` |
| Raspberry Pi OS | `sudo apt install python3-cups python3-usb` |

- **CUPS** must be running and the receipt printer configured in the OS print system.
- Without `python3-cups` / `python3-usb`, basic queue info may still appear via `lpstat`; USB door and paper alerts require the Python packages above.
- For **building** `.rpm` packages locally on Fedora, also install `rpm-build` and use **electron-builder ≥ 26** (see `npm run build:linux`).

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+L` / `⌘+Shift+L` | Return to Setup screen (clear stored config) |

---

## Building for Production

Install dependencies first (only once):

```bash
npm install
```

| Platform | Command | Output |
|---|---|---|
| macOS | `npm run build:mac` | `dist/GoStationary Kiosk-*.dmg` |
| Windows | `npm run build:win` | `dist/GoStationary Kiosk Setup *.exe` |
| Linux | `npm run build:linux` | `dist/*.deb` and `dist/*.rpm` (x64 + arm64) |
| All three | `npm run build:all` | All of the above |

Builds are placed in the `dist/` folder.

---

## Silent Printing – How It Works

1. The kiosk React page calls `window.electronAPI.print()` on order success (single receipt / invoice).
2. For **multi-token orders** (token-per-person layout), the webview uses verified sequential printing:
   - `beginTokenPrintJob({ jobId, slips })` — register expected slip ids
   - `printSlip({ jobId, slipId, index, total })` — print one slip; resolves when the printer callback completes
   - `getTokenPrintStatus(jobId)` — returns missing slip ids for reprint
3. The `preload.js` forwards these to the main process via IPC.
4. `main.js` serializes all print jobs in a queue, verifies `#kiosk-receipt-root[data-slip-id]` matches before printing, and calls `webContents.print({ silent: true, deviceName: ... })`.
5. No dialog appears – the bill goes straight to the printer.

Persistent print failures are logged to the backend (`POST .../print-events`) and shown on the kiosk success screen.

### Requirements
- At least **one physical printer** must be installed and set as the OS default, or the app will fall back to whatever `deviceName: ''` resolves to.
- 80 mm thermal receipt paper is recommended (the bill layout is sized for 80 mm width).
- On Linux kiosks, install [printer monitor dependencies](#linux-system-dependencies-printer-monitor) for full status and job logging on the Setup page.

---

## Assets

Place your app icons in the `assets/` folder before building:

| File | Used for |
|---|---|
| `assets/icon.icns` | macOS |
| `assets/icon.ico` | Windows |
| `assets/icon.png` | Linux |

A 1024×1024 PNG → use [electron-icon-maker](https://github.com/jaretburkett/electron-icon-maker) to generate all formats at once.

---

## Auto-update (GitHub Releases)

Installed `.deb` / `.rpm` builds check GitHub for new versions and download updates **silently** (no AppImage). See [packaging/AUTO_UPDATE.md](packaging/AUTO_UPDATE.md) for Pi 3/4, Ubuntu, Fedora, and publishing tags.

1. Bump `version` in `package.json`, commit, tag `v1.0.1`, push the tag.
2. GitHub Actions (`.github/workflows/release.yml`) builds and publishes installers + `latest-linux*.yml`.
3. Kiosks pick up the update on the next check (about 30s after launch, then every 4 hours) and install on quit/restart.

## GitHub Releases (for public downloads)

1. Repo: [gostationery/gostationary_kiosk_electron](https://github.com/gostationery/gostationary_kiosk_electron).
2. Tag push triggers CI (`.github/workflows/release.yml`).
3. Point landing-page Linux downloads at the `.deb` / `.rpm` assets for the user’s CPU (amd64 vs arm64).
