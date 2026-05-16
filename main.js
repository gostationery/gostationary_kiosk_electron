/**
 * main.js – GoStationary Kiosk Electron main process
 *
 * Flow:
 *  1. On first launch → show setup.html (enter org_domain + machine_serial)
 *  2. After setup → load https://gostationary-kiosk-frontend.vercel.app/{domain}/{serial}
 *  3. Stores config in userData/kiosk-config.json (optional: printerName, openAtLogin)
 *  4. Ctrl/Cmd+Shift+L → clears domain/serial, returns to setup (keeps printer + boot prefs)
 *  5. IPC print-slip / silent-print → silent receipt print (serialized queue)
 *  6. Token print jobs → manifest + per-slip ack for multi-token orders
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

/** CSS reference px → microns (1px = 1/96 in at 96dpi). */
const CSS_PX_TO_MICRONS = (25.4 / 96) * 1000
const RECEIPT_WIDTH_MICRONS = 80000 // 80 mm roll
const PAGE_HEIGHT_BUFFER_MICRONS = 4000 // ~4 mm slack for driver rounding
const PAGE_HEIGHT_MIN_MICRONS = 353 // Chromium custom page minimum
const PAGE_HEIGHT_MAX_MICRONS = 3_000_000 // 3 m cap (single job)

function clampPageHeightMicrons(m) {
  const n = Number(m)
  if (!Number.isFinite(n)) return 150_000
  return Math.round(
    Math.min(PAGE_HEIGHT_MAX_MICRONS, Math.max(PAGE_HEIGHT_MIN_MICRONS, n)),
  )
}

/** Height in microns from #kiosk-receipt-root (kiosk), or scroll root (other pages). */
async function measureContentHeightMicrons(webContents) {
  try {
    const raw = await webContents.executeJavaScript(`(() => {
      const kiosk = document.getElementById('kiosk-receipt-root')
      const el = kiosk || document.body
      if (!el) return 150000
      const h = Math.ceil(
        Math.max(
          1,
          el.scrollHeight,
          el.getBoundingClientRect().height,
          document.documentElement.scrollHeight,
        ),
      )
      return Math.round(h * ${CSS_PX_TO_MICRONS}) + ${PAGE_HEIGHT_BUFFER_MICRONS}
    })()`)
    return clampPageHeightMicrons(raw)
  } catch {
    return clampPageHeightMicrons(150_000)
  }
}

function receiptPrintOptions(deviceName, heightMicrons) {
  const h = clampPageHeightMicrons(heightMicrons)
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
    pageSize: { width: RECEIPT_WIDTH_MICRONS, height: h },
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Sample dine-in token slip — same root id as kiosk receipts so height measurement matches silent-print. */
function testPrintHtml() {
  const dateStr = new Date().toLocaleDateString()
  const timeStr = new Date().toLocaleTimeString()
  const when = escapeHtml(new Date().toLocaleString())
  const sampleToken = '42'
  const sampleName = 'Test token item'
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    html, body { margin: 0; padding: 0; color: #000; background: #fff; }
    body { font-family: 'Courier New', Courier, monospace; font-size: 14px; font-weight: 600; }
    #kiosk-receipt-root {
      box-sizing: border-box;
      width: 72mm;
      max-width: 72mm;
      margin: 0;
      padding: 3mm 2mm;
    }
  </style></head><body>
    <div id="kiosk-receipt-root">
      <div style="text-align:center;font-size:11px;font-weight:700;margin-bottom:4px;">TEST PRINT — not a sale</div>
      <div style="text-align:center;font-size:18px;font-weight:900;letter-spacing:0.06em;text-transform:uppercase;">GoStationary</div>
      <div style="border-top:2px solid #000;margin:6px 0;"></div>
      <div style="text-align:center;font-size:14px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;">★ TOKEN ★</div>
      <div style="text-align:center;font-size:38px;font-weight:800;margin-top:4px;">${escapeHtml(sampleName)}</div>
      <div style="border-top:1px dashed #000;margin:6px 0;"></div>
      <div style="text-align:center;font-size:13px;font-weight:700;margin-bottom:2px;">YOUR TOKEN NUMBER</div>
      <div style="text-align:center;font-size:48px;font-weight:900;line-height:1;letter-spacing:-1px;margin:6px 0;">${escapeHtml(sampleToken)}</div>
      <div style="text-align:center;font-size:22px;font-weight:900;">₹1.00</div>
      <div style="border-top:1px dashed #000;margin:8px 0;"></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;"><span>Date</span><span>${escapeHtml(dateStr)}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;"><span>Time</span><span>${escapeHtml(timeStr)}</span></div>
      <div style="border-top:1px dashed #000;margin:6px 0;"></div>
      <div style="text-align:center;font-size:12px;font-weight:700;letter-spacing:0.06em;">NON-REFUNDABLE • TOKEN</div>
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-top:4px;"><span>Mode: Kiosk</span><span>Cashier: Kiosk</span></div>
      <div style="border-top:1px dashed #000;margin:6px 0;"></div>
      <div style="text-align:center;font-size:13px;font-weight:700;">Thank you!</div>
      <div style="text-align:center;font-size:13px;letter-spacing:0.3em;margin-top:4px;">★ ★ ★</div>
      <div style="border-top:2px dashed #000;margin:10px 0 0;padding-top:6px;font-size:11px;text-align:center;">Printed ${when}</div>
    </div>
  </body></html>`
}

// ── Token print jobs + serialized print queue ───────────────────────────────
const TOKEN_PRINT_JOB_TTL_MS = 30 * 60 * 1000
/** @type {Map<string, { expected: Set<string>, printed: Set<string>, createdAt: number }>} */
const tokenPrintJobs = new Map()
let printChain = Promise.resolve()

function pruneTokenPrintJobs() {
  const now = Date.now()
  for (const [jobId, job] of tokenPrintJobs) {
    if (now - job.createdAt > TOKEN_PRINT_JOB_TTL_MS) {
      tokenPrintJobs.delete(jobId)
    }
  }
}

function enqueuePrint(task) {
  const run = printChain.then(() => task())
  printChain = run.catch(() => {})
  return run
}

function escapeJsString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

/** Wait until #kiosk-receipt-root[data-slip-id] matches expected (token jobs only). */
async function waitForSlipDom(webContents, slipId, timeoutMs = 5000) {
  const expected = escapeJsString(slipId)
  const script = `(() => new Promise((resolve) => {
    const deadline = Date.now() + ${timeoutMs}
    const tick = () => {
      const el = document.getElementById('kiosk-receipt-root')
      if (el && el.dataset.slipId === '${expected}') {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  }))()`
  try {
    return Boolean(await webContents.executeJavaScript(script))
  } catch {
    return false
  }
}

async function resolvePrinterDeviceName() {
  const cfg = loadConfig()
  const printers = await mainWindow.webContents.getPrintersAsync()
  let deviceName = cfg?.printerName || ''
  if (deviceName && !printers.some((p) => p.name === deviceName)) {
    deviceName = ''
  }
  if (!deviceName) {
    deviceName = pickPhysicalPrinter(printers)?.name || ''
  }
  return deviceName
}

function printWebContents(webContents, deviceName) {
  return new Promise((resolve) => {
    measureContentHeightMicrons(webContents)
      .then((heightMicrons) => {
        webContents.print(
          receiptPrintOptions(deviceName, heightMicrons),
          (success, errorType) => {
            resolve({
              success: Boolean(success),
              errorType: success ? undefined : errorType,
            })
          },
        )
      })
      .catch((err) => {
        console.error('[GoStationary Kiosk] measure/print error:', err)
        resolve({ success: false, errorType: String(err?.message || err) })
      })
  })
}

/**
 * Print current main-window receipt. Optional jobId+slipId for verified token slips.
 * @param {{ jobId?: string, slipId?: string, index?: number, total?: number, tokenLabel?: string }} meta
 */
async function printReceiptSlip(meta = {}) {
  if (!mainWindow?.webContents) {
    return { success: false, errorType: 'no-window', slipId: meta.slipId }
  }

  const jobId = meta.jobId ? String(meta.jobId) : ''
  const slipId = meta.slipId ? String(meta.slipId) : ''

  if (jobId && slipId) {
    pruneTokenPrintJobs()
    const job = tokenPrintJobs.get(jobId)
    if (!job || !job.expected.has(slipId)) {
      console.error('[GoStationary Kiosk] print-slip: slip not in job manifest', jobId, slipId)
      return { success: false, errorType: 'slip-not-in-manifest', slipId }
    }
    const domOk = await waitForSlipDom(mainWindow.webContents, slipId)
    if (!domOk) {
      console.error('[GoStationary Kiosk] print-slip: DOM slip mismatch', slipId)
      return { success: false, errorType: 'dom-slip-mismatch', slipId }
    }
  }

  const deviceName = await resolvePrinterDeviceName()
  const result = await printWebContents(mainWindow.webContents, deviceName)

  if (result.success && jobId && slipId) {
    const job = tokenPrintJobs.get(jobId)
    if (job) job.printed.add(slipId)
  } else if (!result.success) {
    console.error('[GoStationary Kiosk] Print failed:', result.errorType, slipId || '')
  }

  return { ...result, slipId: slipId || undefined }
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
      setTimeout(async () => {
        const heightMicrons = await measureContentHeightMicrons(win.webContents)
        win.webContents.print(receiptPrintOptions(deviceName, heightMicrons), (success, errorType) => {
          win.close()
          resolve({ success, errorType: success ? undefined : errorType })
        })
      }, 300)
    })
  })
})

// ── IPC: Token print job + verified slip print ───────────────────────────────
ipcMain.handle('begin-token-print-job', (_event, payload) => {
  const jobId = payload?.jobId ? String(payload.jobId) : ''
  const slips = Array.isArray(payload?.slips) ? payload.slips : []
  if (!jobId || slips.length === 0) {
    throw new Error('jobId and slips are required')
  }
  pruneTokenPrintJobs()
  const expected = new Set()
  for (const s of slips) {
    if (s?.slipId) expected.add(String(s.slipId))
  }
  tokenPrintJobs.set(jobId, {
    expected,
    printed: new Set(),
    createdAt: Date.now(),
  })
  return { jobId, expected: expected.size }
})

ipcMain.handle('get-token-print-status', (_event, jobIdArg) => {
  const jobId = jobIdArg ? String(jobIdArg) : ''
  const job = tokenPrintJobs.get(jobId)
  if (!job) {
    return { expected: 0, printed: 0, missing: [] }
  }
  const missing = [...job.expected].filter((id) => !job.printed.has(id))
  return {
    expected: job.expected.size,
    printed: job.printed.size,
    missing,
  }
})

ipcMain.handle('print-slip', (_event, meta) =>
  enqueuePrint(() => printReceiptSlip(meta || {})),
)

/** Legacy single-shot print (invoice / one receipt). */
ipcMain.handle('silent-print', () =>
  enqueuePrint(() => printReceiptSlip({})),
)
