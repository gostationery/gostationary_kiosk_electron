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

function isVirtualOrExcludedPrinterName(name) {
  if (!name) return true
  const n = String(name).toLowerCase()
  return (
    n.includes('pdf') ||
    n.includes('xps') ||
    n.includes('microsoft') ||
    n.includes('onenote') ||
    n.includes('fax') ||
    n.includes('send to') ||
    n.includes('adobe')
  )
}

function pickPhysicalPrinter(printers) {
  return printers.find((p) => !isVirtualOrExcludedPrinterName(p.name)) || null
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
  // printerName is optional; when unset we fall back to OS default / first physical printer.
  saveConfig({
    domain: cfg.domain,
    serial: cfg.serial,
    printerName: cfg.printerName || '',
  })
  mainWindow.loadURL(kioskURL(cfg))
})

// ── IPC: Printers list ──────────────────────────────────────────────────────
ipcMain.handle('get-printers', async () => {
  const printers = await mainWindow.webContents.getPrintersAsync()
  const physical = printers
    .filter((p) => p?.name && !isVirtualOrExcludedPrinterName(p.name))
    .map((p) => ({ name: p.name, description: p.description }))

  return physical
})

// ── IPC: Silent print ─────────────────────────────────────────────────────────
ipcMain.handle('silent-print', async () => {
  try {
    const cfg = loadConfig() || {}

    // Get all available printers
    const printers = await mainWindow.webContents.getPrintersAsync()

    const physicalPrinter = pickPhysicalPrinter(printers)
    const selectedFromConfig = cfg.printerName
    const selectedPrinter =
      selectedFromConfig && printers.find((p) => p?.name === selectedFromConfig && !isVirtualOrExcludedPrinterName(p.name))
        ? { name: selectedFromConfig }
        : null

    const printerToUse = selectedPrinter?.name || physicalPrinter?.name || ''

    const printOptions = {
      silent: true,           // No dialog
      printBackground: false,
      deviceName: printerToUse, // '' = OS default printer
      margins: {
        marginType: 'custom',
        top: 0.1, bottom: 0.1, left: 0.1, right: 0.1,
      },
      pageSize: { width: 80000, height: 297000 }, // 80mm wide receipt paper (µm)
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

// ── IPC: Print test page ────────────────────────────────────────────────────
ipcMain.handle('print-test-page', async (_event, { deviceName } = {}) => {
  let printWindow
  try {
    const cfg = loadConfig() || {}
    const printers = await mainWindow.webContents.getPrintersAsync()

    const physicalPrinter = pickPhysicalPrinter(printers)
    const selected = deviceName || cfg.printerName || ''

    const printerToUse =
      selected && printers.find((p) => p?.name === selected && !isVirtualOrExcludedPrinterName(p.name))
        ? selected
        : physicalPrinter?.name || ''

    const testHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>GoStationary - Test Print</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 0; margin: 0; }
      .receipt {
        width: 80mm;
        padding: 10mm 6mm;
        box-sizing: border-box;
      }
      h1 { font-size: 18px; margin: 0 0 10px; }
      p { font-size: 12px; margin: 0 0 6px; }
      .line { border-top: 1px dashed #777; margin: 10px 0; }
      .small { font-size: 10px; color: #444; }
      @media print {
        body { -webkit-print-color-adjust: exact; }
      }
    </style>
  </head>
  <body>
    <div class="receipt">
      <h1>GoStationary Kiosk</h1>
      <p><strong>TEST PRINT</strong></p>
      <div class="line"></div>
      <p>Printer: ${String(printerToUse || 'OS default').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
      <p>Date: ${new Date().toLocaleString()}</p>
      <p class="small">If you can read this receipt, printing is working.</p>
    </div>
  </body>
</html>`

    // Hidden window used to print a known HTML receipt, independent of the current screen.
    printWindow = new BrowserWindow({
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    const printOptions = {
      silent: true,
      printBackground: true,
      deviceName: printerToUse,
      margins: {
        marginType: 'custom',
        top: 0.1,
        bottom: 0.1,
        left: 0.1,
        right: 0.1,
      },
      pageSize: { width: 80000, height: 297000 },
    }

    const result = await new Promise((resolve) => {
      printWindow.webContents.once('did-finish-load', () => {
        printWindow.webContents.print(printOptions, (success, errorType) => {
          resolve({ success, errorType })
        })
      })

      printWindow.webContents.once('did-fail-load', (_event, errorCode, errorDesc) => {
        resolve({ success: false, errorType: `${errorCode || 'unknown'}: ${errorDesc || ''}` })
      })

      printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(testHtml)}`)
    })

    if (!result?.success) {
      console.error('[GoStationary Kiosk] Test print failed:', result?.errorType)
      throw new Error('Test print failed. Check the selected printer.')
    }

    return true
  } catch (err) {
    console.error('[GoStationary Kiosk] print-test-page error:', err)
    throw err
  } finally {
    try { if (printWindow && !printWindow.isDestroyed()) printWindow.destroy() } catch {}
  }
})
