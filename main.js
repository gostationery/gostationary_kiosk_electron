/**
 * main.js – GoStationary Kiosk Electron main process
 *
 * Flow:
 *  1. On first launch → show setup.html (enter org_domain + machine_serial)
 *  2. After setup → load https://gostationary-kiosk-frontend.vercel.app/{domain}/{serial}
 *  3. Stores config in userData/kiosk-config.json (optional: printerName, openAtLogin)
 *  4. Ctrl/Cmd+Shift+L → clears domain/serial, returns to setup (keeps printer + boot prefs)
 *  5. IPC 'silent-print' → prints using saved printer or first physical printer
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
} = require('electron')
const path = require('path')
const fs = require('fs')

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

function clearConfigFile() {
  try {
    fs.unlinkSync(CONFIG_PATH)
  } catch {}
}

/** Remove pairing only; keep printerName + openAtLogin so kiosk staff shortcuts do not wipe device prefs. */
function clearMachinePairing() {
  const prev = loadConfig()
  const next = {}
  if (prev?.printerName) next.printerName = prev.printerName
  if (typeof prev?.openAtLogin === 'boolean') next.openAtLogin = prev.openAtLogin
  clearConfigFile()
  if (Object.keys(next).length) saveConfig(next)
}

function kioskURL(cfg) {
  return `https://www.gostationary.in//${cfg.domain}/${cfg.serial}`
}

function applyOpenAtLoginFromConfig(cfg) {
  const open = Boolean(cfg?.openAtLogin)
  try {
    app.setLoginItemSettings({ openAtLogin: open })
  } catch (err) {
    console.error('[GoStationary Kiosk] setLoginItemSettings:', err)
  }
}

function pickPhysicalPrinter(printers) {
  return printers.find((p) => {
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
}

function receiptPrintOptions(deviceName) {
  return {
    silent: true,
    printBackground: false,
    deviceName: deviceName || '',
    margins: {
      marginType: 'custom',
      top: 0.1,
      bottom: 0.1,
      left: 0.1,
      right: 0.1,
    },
    pageSize: { width: 80000, height: 297000 },
  }
}

function testPrintHtml() {
  const when = new Date().toLocaleString()
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    body { font-family: ui-monospace, monospace; padding: 12px; width: 72mm; margin: 0; color: #000; background: #fff; }
    h1 { font-size: 14px; margin: 0 0 8px; }
    p { font-size: 12px; margin: 6px 0; line-height: 1.4; }
    .rule { border-top: 2px dashed #000; margin: 10px 0; }
  </style></head><body>
    <h1>GoStationary — test print</h1>
    <p>This page confirms the kiosk can reach the selected printer when printing silently.</p>
    <div class="rule"></div>
    <p>${when}</p>
  </body></html>`
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
      webSecurity: true,
    },
  })

  mainWindow.setMenuBarVisibility(false)

  const cfg = loadConfig()
  if (cfg?.domain && cfg?.serial) {
    mainWindow.loadURL(kioskURL(cfg))
  } else {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'))
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  applyOpenAtLoginFromConfig(loadConfig())
  createWindow()

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    clearMachinePairing()
    mainWindow.loadFile(path.join(__dirname, 'setup.html'))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// ── IPC: Setup / prefs ──────────────────────────────────────────────────────
ipcMain.handle('save-config', (_event, cfg) => {
  if (!cfg?.domain || !cfg?.serial) {
    throw new Error('domain and serial are required')
  }
  const prev = loadConfig() || {}
  const merged = {
    ...prev,
    domain: String(cfg.domain).trim(),
    serial: String(cfg.serial).trim(),
  }
  if (cfg.printerName !== undefined) {
    merged.printerName = cfg.printerName ? String(cfg.printerName) : ''
  }
  if (typeof cfg.openAtLogin === 'boolean') {
    merged.openAtLogin = cfg.openAtLogin
  }
  saveConfig(merged)
  applyOpenAtLoginFromConfig(merged)
  mainWindow.loadURL(kioskURL(merged))
})

ipcMain.handle('get-printers', async () => {
  if (!mainWindow?.webContents) return []
  return mainWindow.webContents.getPrintersAsync()
})

ipcMain.handle('get-kiosk-prefs', () => {
  const cfg = loadConfig()
  return {
    printerName: cfg?.printerName || '',
    openAtLogin: Boolean(cfg?.openAtLogin),
  }
})

ipcMain.handle('set-printer', (_event, printerName) => {
  const prev = loadConfig() || {}
  saveConfig({ ...prev, printerName: printerName ? String(printerName) : '' })
})

ipcMain.handle('set-open-at-login', (_event, open) => {
  const prev = loadConfig() || {}
  const merged = { ...prev, openAtLogin: Boolean(open) }
  saveConfig(merged)
  applyOpenAtLoginFromConfig(merged)
})

ipcMain.handle('test-print', async (_event, deviceNameArg) => {
  const cfg = loadConfig()
  const fromArg = deviceNameArg != null && String(deviceNameArg).length > 0
  let deviceName = fromArg ? String(deviceNameArg) : cfg?.printerName || ''
  if (!deviceName && mainWindow?.webContents) {
    const printers = await mainWindow.webContents.getPrintersAsync()
    deviceName = pickPhysicalPrinter(printers)?.name || ''
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 420,
      height: 640,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    const url =
      'data:text/html;charset=utf-8,' + encodeURIComponent(testPrintHtml())
    win.loadURL(url)
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.print(receiptPrintOptions(deviceName), (success, errorType) => {
          win.close()
          resolve({ success, errorType: success ? undefined : errorType })
        })
      }, 300)
    })
  })
})

// ── IPC: Silent print (order receipt) ────────────────────────────────────────
ipcMain.handle('silent-print', async () => {
  try {
    const cfg = loadConfig()
    const printers = await mainWindow.webContents.getPrintersAsync()
    let deviceName = cfg?.printerName || ''
    if (deviceName && !printers.some((p) => p.name === deviceName)) {
      deviceName = ''
    }
    if (!deviceName) {
      deviceName = pickPhysicalPrinter(printers)?.name || ''
    }

    mainWindow.webContents.print(receiptPrintOptions(deviceName), (success, errorType) => {
      if (!success) {
        console.error('[GoStationary Kiosk] Print failed:', errorType)
      }
    })
  } catch (err) {
    console.error('[GoStationary Kiosk] silent-print error:', err)
  }
})
