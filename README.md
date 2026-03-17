<<<<<<< HEAD
# gostationary_kiosk_electron
Kiosk System APP 
=======
# GoStationary Kiosk – Desktop App

Electron wrapper for the GoStationary kiosk web frontend. Runs in fullscreen kiosk mode and prints bills **silently** to the first physical printer found (no print-dialog, no "Save as PDF").

---

## Quick Start (Development)

```bash
cd gostationary_kiosk_electron
npm install
npm start
```

On first launch you'll see the **Setup screen** → enter your **Org Domain** and **Machine Serial Number** → click **Launch Kiosk**.  
The app stores those credentials locally and auto-loads the kiosk on every subsequent launch.

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
| Linux | `npm run build:linux` | `dist/GoStationary Kiosk-*.AppImage` |
| All three | `npm run build:all` | All of the above |

Builds are placed in the `dist/` folder.

---

## Silent Printing – How It Works

1. The kiosk React page calls `window.electronAPI.print()` on order success.
2. The `preload.js` forwards this to the main process via IPC.
3. `main.js` calls `webContents.getPrintersAsync()`, finds the **first non-PDF physical printer**, and calls `webContents.print({ silent: true, deviceName: ... })`.
4. No dialog appears – the bill goes straight to the printer.

### Requirements
- At least **one physical printer** must be installed and set as the OS default, or the app will fall back to whatever `deviceName: ''` resolves to.
- 80 mm thermal receipt paper is recommended (the bill layout is sized for 80 mm width).

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

## GitHub Releases (for public downloads)

1. Push this folder to a GitHub repo (e.g. `gostationery/gostationary_kiosk_electron`).
2. Add the `.github/workflows/release.yml` CI workflow to auto-build on tag push.
3. Update the download links on the GoStationary landing page to point to the release assets.
>>>>>>> b3b82af (Initial commit)
