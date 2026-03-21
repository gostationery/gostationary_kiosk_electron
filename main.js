/**
 * main.js – GoStationary Kiosk Electron main process
 *
 * Flow:
 *  1. On first launch → show setup.html (enter org_domain + machine_serial)
 *  2. After setup → load https://gostationary-kiosk-frontend.vercel.app/{domain}/{serial}
 *  3. Stores config in userData/kiosk-config.json
 *  4. Ctrl/Cmd+Shift+L → clears config, returns to setup screen
 *  5. IPC 'silent-print' → prints the current page to the first non-PDF printer
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  session,
} = require('electron')
const path = require('path')
const fs   = require('fs')

// ── Config helpers ──────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'kiosk-config.json')

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    }
  } catch {}
  return null
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

function clearConfig() {
  try { fs.unlinkSync(CONFIG_PATH) } catch {}
}

function kioskURL(cfg) {
  return `https://gostationary-kiosk-frontend.vercel.app/${cfg.domain}/${cfg.serial}`
}

// ── Window ───────────────────────────────────────────────────────────────────
let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow the kiosk Vercel URL to load without mixed-content issues
      webSecurity: true,
    },
  })

  // Hide menu bar completely in kiosk mode
  mainWindow.setMenuBarVisibility(false)

  const cfg = loadConfig()
  if (cfg?.domain && cfg?.serial) {
    mainWindow.loadURL(kioskURL(cfg))
  } else {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'))
  }

  // ── Dev-tools shortcut (Ctrl/Cmd+Shift+I) ─── remove for production build
  // mainWindow.webContents.openDevTools()
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow()

  // ── Logout shortcut: Ctrl+Shift+L / Cmd+Shift+L ─────────────────────────
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    clearConfig()
    mainWindow.loadFile(path.join(__dirname, 'setup.html'))
  })

  app.on('activate', () => {
    // macOS: re-create window when clicking dock icon
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// ── IPC: Setup form submitted ─────────────────────────────────────────────────
ipcMain.handle('save-config', (_event, cfg) => {
  if (!cfg.domain || !cfg.serial) throw new Error('domain and serial are required')
  saveConfig(cfg)
  mainWindow.loadURL(kioskURL(cfg))
})

// ── IPC: Silent print ─────────────────────────────────────────────────────────
ipcMain.handle('silent-print', async () => {
  try {
    // Get all available printers
    const printers = await mainWindow.webContents.getPrintersAsync()

    // Pick first physical printer (exclude PDF writers / virtual printers)
    const physicalPrinter = printers.find((p) => {
      const n = p.name.toLowerCase()
      return (
        !n.includes('pdf') &&
        !n.includes('xps') &&
        !n.includes('microsoft') &&
        !n.includes('onenote') &&
        !n.includes('fax') &&
        !n.includes('send to') &&
        !n.includes('adobe')
      )
    })

    // Thermal “heat” / density is usually set in the printer driver. We still bias
    // Chromium toward a darker B&W raster: monochrome, backgrounds on, DPI where supported.
    const printOptions = {
      silent: true,
      printBackground: true,
      color: false,
      deviceName: physicalPrinter?.name || '',
      // Chromium requires each margin ≥ ~352 µm; tiny values caused bad layout / drift.
      margins: {
        marginType: 'custom',
        top: 1000,
        bottom: 1000,
        left: 1500,
        right: 1500,
      },
      pageSize: { width: 80000, height: 297000 }, // 80mm wide receipt paper (µm)
    }

    // Raster step for thermal (203 dpi is typical for 80mm); supported on Windows/Linux in Electron.
    if (process.platform === 'win32' || process.platform === 'linux') {
      printOptions.dpi = { horizontal: 203, vertical: 203 }
    }

    mainWindow.webContents.print(printOptions, (success, errorType) => {
      if (!success) {
        console.error('[GoStationary Kiosk] Print failed:', errorType)
      }
    })
  } catch (err) {
    console.error('[GoStationary Kiosk] silent-print error:', err)
  }
})
