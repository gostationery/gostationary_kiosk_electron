/**
 * main.js – GoStationary Kiosk Electron main process
 *
 * Flow:
 *  1. On first launch → show setup.html (enter org_domain + machine_serial)
 *  2. After setup → load bundled kiosk UI at http://127.0.0.1:{port}/{domain}/{serial}?apiBase={backend}
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
const { createKioskStaticServer, KIOSK_UI_DIR } = require('./kiosk-static-server')
const { initAutoUpdater } = require('./auto-updater')

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8000'
const KIOSK_STATIC_PORT_PREFERRED = 47831

function getKioskFileLogger() {
  try {
    const log = require('electron-log')
    log.transports.file.level = 'info'
    log.transports.file.resolvePathFn = () =>
      path.join(app.getPath('userData'), 'logs', 'kiosk.log')
    return log
  } catch {
    return null
  }
}

const kioskFileLog = getKioskFileLogger()

function mainLog(message, detail) {
  const line = detail ? `${message} ${JSON.stringify(detail)}` : message
  console.log(`[GoStationary Kiosk] ${line}`)
  kioskFileLog?.info(line)
}

function attachKioskWebLogging(win) {
  const wc = win.webContents

  wc.on('did-start-loading', () => {
    mainLog('renderer: loading started', { url: wc.getURL() })
  })

  wc.on('did-finish-load', () => {
    mainLog('renderer: load finished', { url: wc.getURL() })
  })

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    mainLog('renderer: load failed', {
      errorCode,
      errorDescription,
      url: validatedURL,
    })
  })

  wc.on('did-navigate', (_event, url) => {
    mainLog('renderer: navigated', { url })
  })

  wc.on('did-navigate-in-page', (_event, url) => {
    mainLog('renderer: in-page navigation', { url })
  })

  wc.on('console-message', (_event, level, message, line, sourceId) => {
    const text = String(message ?? '')
    if (
      text.includes('[GoStationary Kiosk UI]') ||
      text.includes('[GoStationary Kiosk]') ||
      level >= 2
    ) {
      mainLog('renderer-console', {
        level,
        message: text,
        line,
        sourceId,
      })
    }
  })

  wc.on('render-process-gone', (_event, details) => {
    mainLog('renderer: process gone', details)
  })
}

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
  if (prev?.backendUrl) next.backendUrl = prev.backendUrl
  clearConfigFile()
  if (Object.keys(next).length) saveConfig(next)
}

/** @type {{ port: number, host: string, origin: string } | null} */
let kioskStaticServerInfo = null

function normalizeBackendUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return DEFAULT_BACKEND_URL
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('Backend URL must start with http:// or https://')
    }
    return u.origin
  } catch (e) {
    if (e instanceof TypeError) throw new Error('Invalid backend URL')
    throw e
  }
}

function kioskOrigin() {
  if (!kioskStaticServerInfo?.origin) {
    throw new Error('Kiosk UI server is not running')
  }
  return kioskStaticServerInfo.origin
}

function kioskURL(cfg) {
  const domain = encodeURIComponent(String(cfg.domain).trim())
  const serial = encodeURIComponent(String(cfg.serial).trim())
  const apiBase = encodeURIComponent(
    normalizeBackendUrl(cfg.backendUrl || DEFAULT_BACKEND_URL),
  )
  return `${kioskOrigin()}/${domain}/${serial}?apiBase=${apiBase}&electron=1`
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

/** Fixed 80 mm × 297 mm thermal roll — microns, no DOM measurement. */
const RECEIPT_WIDTH_MICRONS = 80000
const RECEIPT_HEIGHT_MICRONS = 4000_000
const PRINT_SETTLE_MS = 300
const TEST_PRINT_WINDOW_WIDTH = 420
/** 297 mm roll height in CSS px (+ headroom) — window sized by math, not DOM. */
const TEST_PRINT_WINDOW_HEIGHT = Math.ceil((297 / 25.4) * 96) + 200

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Off-screen window: invisible to the user but painted so Windows prints the full page. */
function createOffscreenPrintWindow() {
  return new BrowserWindow({
    show: false,
    x: -20000,
    y: -20000,
    width: TEST_PRINT_WINDOW_WIDTH,
    height: TEST_PRINT_WINDOW_HEIGHT,
    opacity: 0,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
}

async function ensureOffscreenPaint(win) {
  win.setBounds({
    x: -20000,
    y: -20000,
    width: TEST_PRINT_WINDOW_WIDTH,
    height: TEST_PRINT_WINDOW_HEIGHT,
  })
  win.setOpacity(0)
  win.showInactive()
  await sleep(process.platform === 'win32' ? 450 : 200)
}

function receiptPrintOptions(deviceName, overrides = {}) {
  return {
    silent: true,
    printBackground: overrides.printBackground ?? false,
    deviceName: deviceName || '',
    margins: {
      marginType: 'custom',
      top: 0.1,
      bottom: 0.1,
      left: 0.1,
      right: 0.1,
    },
    pageSize: { width: RECEIPT_WIDTH_MICRONS, height: RECEIPT_HEIGHT_MICRONS },
  }
}

function printWebContents(webContents, deviceName) {
  return new Promise((resolve) => {
    setTimeout(() => {
      webContents.print(receiptPrintOptions(deviceName), (success, errorType) => {
        resolve({
          success: Boolean(success),
          errorType: success ? undefined : errorType,
        })
      })
    }, PRINT_SETTLE_MS)
  })
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Test print HTML — plain <p> tags only (same pattern as the original working test).
 * Printed from an off-screen invisible window so setup stays on screen.
 */
function testPrintHtml() {
  const dateStr = escapeHtml(new Date().toLocaleDateString())
  const timeStr = escapeHtml(new Date().toLocaleTimeString())
  const when = escapeHtml(new Date().toLocaleString())

  const items = [
    { name: 'Test Coffee', qty: 2, price: 80 },
    { name: 'Veg Sandwich', qty: 1, price: 120 },
    { name: 'Cold Coffee Large with Whipped Cream', qty: 1, price: 180 },
    { name: 'Brownie', qty: 3, price: 75 },
    { name: 'Bottled Water 1L', qty: 2, price: 40 },
    { name: 'Cookie', qty: 4, price: 25 },
  ]
  const itemLines = items
    .map((it) => {
      const amount = (it.qty * it.price).toFixed(2)
      return `<p class="item">${escapeHtml(it.name)} &nbsp; ${it.qty} &nbsp; ${it.price.toFixed(2)} &nbsp; ${amount}</p>`
    })
    .join('\n')
  const subtotal = items.reduce((s, it) => s + it.qty * it.price, 0)
  const tax = +(subtotal * 0.05).toFixed(2)
  const grand = (subtotal + tax).toFixed(2)

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    html, body {
      margin: 0; padding: 0; color: #000; background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 14px;
      font-weight: 700;
      line-height: 1.5;
      padding: 3mm 2mm;
      width: 72mm;
      box-sizing: border-box;
    }
    h1 {
      font-size: 20px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 0 0 6px;
      text-align: center;
    }
    p { font-size: 13px; font-weight: 700; margin: 4px 0; line-height: 1.45; color: #000; }
    p.item { font-size: 14px; font-weight: 800; }
    p.label { font-size: 12px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }
    p.token-num { font-size: 48px; font-weight: 900; line-height: 1; letter-spacing: -1px; }
    p.token-name { font-size: 22px; font-weight: 900; }
    p.total { font-size: 16px; font-weight: 900; }
    .center { text-align: center; }
    .rule { border-top: 2px dashed #000; margin: 8px 0; height: 0; }
    .rule-solid { border-top: 2px solid #000; margin: 8px 0; height: 0; }
  </style></head><body>
    <p class="center label">TEST PRINT — not a sale</p>
    <h1>GoStationary</h1>
    <p class="center" style="font-weight:800;">Receipt Printer Diagnostic</p>
    <p class="center" style="font-weight:800;">GSTIN 27ABCDE1234F1Z5</p>
    <div class="rule-solid"></div>
    <p>Date ${dateStr} &nbsp;&nbsp; ${timeStr}</p>
    <p>Cashier: Kiosk &nbsp;&nbsp; Mode: Kiosk</p>
    <div class="rule"></div>
    <p style="font-weight:900;font-size:14px;">Item &nbsp; Qty &nbsp; Rate &nbsp; Amt</p>
    ${itemLines}
    <div class="rule"></div>
    <p>Subtotal: ${subtotal.toFixed(2)}</p>
    <p>Tax (5%): ${tax.toFixed(2)}</p>
    <p class="total">TOTAL: ₹${grand}</p>
    <div class="rule"></div>
    <p class="center label">★ Sample Token ★</p>
    <p class="center token-name">Test token item</p>
    <p class="center label">Your token number</p>
    <p class="center token-num">42</p>
    <div class="rule"></div>
    <p class="center label">Non-refundable • test</p>
    <div class="rule"></div>
    <p style="font-weight:800;">If you see all 6 items, totals, token block and this line — print is working.</p>
    <div class="rule"></div>
    <p class="center" style="font-weight:900;">Thank you!</p>
    <p class="center" style="font-weight:800;letter-spacing:0.3em;">★ ★ ★</p>
    <div class="rule-solid"></div>
    <p class="center" style="font-size:12px;font-weight:800;">Printed ${when}</p>
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

// ── Kiosk activity (suppress idle hard-refresh while in use) ─────────────────
let lastKioskActivityAt = Date.now()

// ── Window ───────────────────────────────────────────────────────────────────
let mainWindow
/** @type {ReturnType<createKioskStaticServer> | null} */
let kioskStaticServer = null

async function startKioskStaticServer() {
  if (kioskStaticServerInfo) return kioskStaticServerInfo
  kioskStaticServer = createKioskStaticServer(KIOSK_UI_DIR)
  kioskStaticServerInfo = await kioskStaticServer.listen(KIOSK_STATIC_PORT_PREFERRED)
  mainLog('UI static server started', {
    origin: kioskStaticServerInfo.origin,
    root: KIOSK_UI_DIR,
  })
  return kioskStaticServerInfo
}

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
  attachKioskWebLogging(mainWindow)

  const cfg = loadConfig()
  if (cfg?.domain && cfg?.serial) {
    const url = kioskURL(cfg)
    mainLog('loading kiosk URL', {
      url,
      domain: cfg.domain,
      serial: cfg.serial,
      backendUrl: cfg.backendUrl || DEFAULT_BACKEND_URL,
    })
    mainWindow.loadURL(url)
  } else {
    const setupPath = path.join(__dirname, 'setup.html')
    mainLog('loading setup (no domain/serial in config)', { setupPath })
    mainWindow.loadFile(setupPath)
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  applyOpenAtLoginFromConfig(loadConfig())
  try {
    await startKioskStaticServer()
  } catch (err) {
    console.error('[GoStationary Kiosk] Failed to start UI server:', err)
    app.quit()
    return
  }
  createWindow()
  initAutoUpdater()

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    mainLog('shortcut: returning to setup (Ctrl+Shift+L)')
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
  if (kioskStaticServer?.close) {
    void kioskStaticServer.close()
  }
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
    backendUrl: normalizeBackendUrl(cfg.backendUrl ?? prev.backendUrl),
  }
  if (cfg.printerName !== undefined) {
    merged.printerName = cfg.printerName ? String(cfg.printerName) : ''
  }
  if (typeof cfg.openAtLogin === 'boolean') {
    merged.openAtLogin = cfg.openAtLogin
  }
  saveConfig(merged)
  applyOpenAtLoginFromConfig(merged)
  const url = kioskURL(merged)
  mainLog('setup saved — launching kiosk', {
    url,
    domain: merged.domain,
    serial: merged.serial,
    backendUrl: merged.backendUrl,
  })
  mainWindow.loadURL(url)
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
    backendUrl: normalizeBackendUrl(cfg?.backendUrl),
  }
})

ipcMain.handle('notify-kiosk-activity', () => {
  lastKioskActivityAt = Date.now()
  return { ok: true, at: lastKioskActivityAt }
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

  const testPrintPath = path.join(app.getPath('temp'), 'gostationary-test-print.html')

  try {
    fs.writeFileSync(testPrintPath, testPrintHtml(), 'utf8')
  } catch (err) {
    return { success: false, errorType: `write-test-html:${err?.message || err}` }
  }

  return new Promise((resolve) => {
    const win = createOffscreenPrintWindow()

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        if (!win.isDestroyed()) win.close()
      } catch (_) {}
      resolve(result)
    }

    const timeout = setTimeout(() => {
      finish({ success: false, errorType: 'test-print-timeout' })
    }, 20000)

    win.webContents.once('did-fail-load', (_event, code, desc) => {
      clearTimeout(timeout)
      finish({ success: false, errorType: `load-failed:${code}:${desc}` })
    })

    win.loadFile(testPrintPath)
    win.webContents.once('did-finish-load', () => {
      ;(async () => {
        try {
          await ensureOffscreenPaint(win)
          mainLog('test-print', {
            pageHeightMicrons: RECEIPT_HEIGHT_MICRONS,
            deviceName,
            via: 'offscreen',
          })
          win.webContents.print(
            receiptPrintOptions(deviceName, { printBackground: true }),
            (success, errorType) => {
              clearTimeout(timeout)
              finish({
                success: Boolean(success),
                errorType: success ? undefined : errorType,
              })
            },
          )
        } catch (err) {
          clearTimeout(timeout)
          finish({ success: false, errorType: String(err?.message || err) })
        }
      })()
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
