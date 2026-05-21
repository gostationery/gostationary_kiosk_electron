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
const {
  startPrinterMonitor,
  stopPrinterMonitor,
  getPrinterMonitorSnapshot,
  waitForPrintQueueIdle,
  pushLog: pushPrinterLog,
} = require('./printer-monitor')
const { buildEscPosFromWebContents } = require('./receipt-to-escpos')
const {
  measureContentHeightMicrons,
  receiptPrintOptions,
} = require('./receipt-cups-layout')
const {
  DEFAULT_URL: DEFAULT_PRINTER_SERVER_URL,
  isServerAvailable,
  printEscPos,
  fetchHealth,
  assertPrinterReady,
} = require('./printer-server-client')

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8000'
const KIOSK_STATIC_PORT_PREFERRED = 47831

// Linux: suppress GL/vsync noise (GetVSyncParametersIfAvailable) on Wayland / some drivers.
// Software rendering is fine for kiosk UI + printToPDF receipts.
if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-features', 'Vulkan,VulkanFromANGLE')
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
  if (typeof prev?.usePrinterServer === 'boolean') {
    next.usePrinterServer = prev.usePrinterServer
  }
  if (prev?.printerServerUrl) next.printerServerUrl = prev.printerServerUrl
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
    @media print {
      * { margin: 0; padding: 0; }
      html, body { margin: 0 !important; padding: 0 !important; width: 80mm !important; height: auto !important; }
      body > *:not(#kiosk-receipt-root) { display: none !important; }
      #kiosk-receipt-root {
        display: block !important;
        position: static !important;
        opacity: 1 !important;
        color: #000 !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        width: 72mm !important;
        max-width: 72mm !important;
        margin: 0 !important;
        padding: 3mm 2mm !important;
        box-sizing: border-box !important;
        font-family: 'Courier New', Courier, monospace !important;
        font-size: 14px !important;
        font-weight: 600 !important;
      }
      #kiosk-receipt-root img {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      @page { size: 80mm auto; margin: 0mm 4mm; }
    }
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
/** @type {boolean | null} */
let printerServerReachable = null

function isPrinterServerEnabled() {
  return loadConfig()?.usePrinterServer === true
}

function resetPrinterServerCache() {
  printerServerReachable = null
}

function getPrinterServerUrl() {
  if (!isPrinterServerEnabled()) return null
  const cfg = loadConfig()
  return (
    cfg?.printerServerUrl ||
    process.env.PRINTER_SERVER_URL ||
    DEFAULT_PRINTER_SERVER_URL
  )
}

async function probePrinterServer(url = getPrinterServerUrl()) {
  if (!url) return false
  let ok = false
  try {
    const health = await fetchHealth(url)
    ok = health?.status === 'ok'
    if (ok) {
      const connected = health?.printer?.connected
      console.log(
        '[GoStationary Kiosk] POS printer service reachable:',
        url,
        connected === false ? '(USB printer offline)' : '',
      )
    }
  } catch {
    ok = await isServerAvailable(url)
  }
  printerServerReachable = ok
  return ok
}

async function usePrinterServer() {
  if (!isPrinterServerEnabled()) return false
  const url = getPrinterServerUrl()
  if (!url) return false
  if (printerServerReachable === null) {
    await probePrinterServer(url)
  }
  return Boolean(printerServerReachable)
}

function printerServerUnavailableResult(slipId) {
  return {
    success: false,
    errorType: 'printer-server-unavailable',
    slipId: slipId || undefined,
  }
}

function remainingTokenSlips(jobId, excludingSlipId) {
  const job = tokenPrintJobs.get(String(jobId))
  if (!job) return 0
  return [...job.expected].filter(
    (id) => !job.printed.has(id) && id !== String(excludingSlipId || ''),
  ).length
}

/** Cut between token slips vs final slip (matches prior printer-communication behaviour). */
function slipCutOptions(meta = {}) {
  const jobId = meta.jobId ? String(meta.jobId) : ''
  const slipId = meta.slipId ? String(meta.slipId) : ''
  if (!jobId || !slipId) {
    return {
      cut: meta.cut || 'full',
      feedLinesBeforeCut: meta.feedLinesBeforeCut ?? 4,
    }
  }
  const isLast = remainingTokenSlips(jobId, slipId) <= 0
  return {
    cut: meta.cut ?? (isLast ? 'full' : 'partial'),
    feedLinesBeforeCut: meta.feedLinesBeforeCut ?? (isLast ? 4 : 2),
  }
}

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
    const domOk = await waitForSlipDom(mainWindow.webContents, slipId)
    if (!domOk) {
      console.error('[GoStationary Kiosk] print-slip: DOM slip mismatch', slipId)
      return { success: false, errorType: 'dom-slip-mismatch', slipId }
    }
    pruneTokenPrintJobs()
    const job = tokenPrintJobs.get(jobId)
    if (!job || !job.expected.has(slipId)) {
      console.error('[GoStationary Kiosk] print-slip: slip not in job manifest', jobId, slipId)
      return { success: false, errorType: 'slip-not-in-manifest', slipId }
    }
  }

  if (isPrinterServerEnabled()) {
    if (!(await usePrinterServer())) {
      return printerServerUnavailableResult(slipId)
    }
  }

  if (isPrinterServerEnabled()) {
    try {
      const url = getPrinterServerUrl()
      await assertPrinterReady(url)
      const escpos = await buildEscPosFromWebContents(
        mainWindow.webContents,
        slipCutOptions(meta),
      )
      const result = await printEscPos(url, escpos)
      if (result.success) {
        if (jobId && slipId) {
          const job = tokenPrintJobs.get(jobId)
          if (job) job.printed.add(slipId)
        }
        pushPrinterLog(
          'info',
          slipId ? `Printed via POS service (slip ${slipId})` : 'Printed via POS service',
        )
      } else {
        pushPrinterLog('error', `POS print failed: ${result.errorType || 'unknown'}`)
      }
      return {
        success: Boolean(result.success),
        errorType: result.success ? undefined : result.errorType,
        slipId: slipId || undefined,
      }
    } catch (err) {
      pushPrinterLog('error', `POS print: ${err.message}`)
      return {
        success: false,
        errorType: err.errorType || String(err.message || err),
        slipId: slipId || undefined,
      }
    }
  }

  const deviceName = await resolvePrinterDeviceName()
  const result = await printWebContents(mainWindow.webContents, deviceName)

  if (result.success) {
    pushPrinterLog(
      'info',
      slipId ? `Print job sent (slip ${slipId})` : 'Print job sent',
    )
    if (process.platform === 'linux') {
      const queue = await waitForPrintQueueIdle(60000)
      if (queue.ok === false) {
        pushPrinterLog('warn', queue.error)
        return {
          success: false,
          errorType: 'cups-queue-timeout',
          slipId: slipId || undefined,
        }
      }
    }
  } else {
    pushPrinterLog(
      'error',
      `Print failed: ${result.errorType || 'unknown'}${slipId ? ` (${slipId})` : ''}`,
    )
  }

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
  console.log(
    '[GoStationary Kiosk] UI server:',
    kioskStaticServerInfo.origin,
    '→',
    KIOSK_UI_DIR,
  )
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

  const cfg = loadConfig()
  if (cfg?.domain && cfg?.serial) {
    mainWindow.loadURL(kioskURL(cfg))
  } else {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'))
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
  startPrinterMonitor()

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
  stopPrinterMonitor()
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
  if (typeof cfg.usePrinterServer === 'boolean') {
    merged.usePrinterServer = cfg.usePrinterServer
    resetPrinterServerCache()
  }
  if (cfg.printerServerUrl !== undefined) {
    const u = String(cfg.printerServerUrl).trim()
    merged.printerServerUrl = u || DEFAULT_PRINTER_SERVER_URL
    resetPrinterServerCache()
  }
  saveConfig(merged)
  applyOpenAtLoginFromConfig(merged)
  mainWindow.loadURL(kioskURL(merged))
})

ipcMain.handle('get-printers', async () => {
  if (!mainWindow?.webContents) return []
  return mainWindow.webContents.getPrintersAsync()
})

ipcMain.handle('get-printer-monitor', () => getPrinterMonitorSnapshot())

ipcMain.handle('get-kiosk-prefs', async () => {
  const cfg = loadConfig()
  const usePrinterServer = cfg?.usePrinterServer === true
  const printerServerUrl =
    cfg?.printerServerUrl ||
    process.env.PRINTER_SERVER_URL ||
    DEFAULT_PRINTER_SERVER_URL
  let printerServerReachable = false
  if (usePrinterServer) {
    printerServerReachable = await probePrinterServer(printerServerUrl)
  } else {
    resetPrinterServerCache()
  }
  return {
    printerName: cfg?.printerName || '',
    openAtLogin: Boolean(cfg?.openAtLogin),
    backendUrl: normalizeBackendUrl(cfg?.backendUrl),
    usePrinterServer,
    printerServerUrl,
    printerServerReachable,
    posPrinterConnected: printerServerReachable
      ? (await fetchHealth(printerServerUrl).catch(() => null))?.printer?.connected
      : undefined,
  }
})

ipcMain.handle('set-print-backend', async (_event, opts) => {
  const prev = loadConfig() || {}
  const merged = { ...prev }
  if (typeof opts?.usePrinterServer === 'boolean') {
    merged.usePrinterServer = opts.usePrinterServer
  }
  if (opts?.printerServerUrl !== undefined) {
    const u = String(opts.printerServerUrl).trim()
    merged.printerServerUrl = u || DEFAULT_PRINTER_SERVER_URL
  }
  saveConfig(merged)
  resetPrinterServerCache()
  const usePrinterServer = merged.usePrinterServer === true
  const printerServerUrl =
    merged.printerServerUrl ||
    process.env.PRINTER_SERVER_URL ||
    DEFAULT_PRINTER_SERVER_URL
  const printerServerReachable = usePrinterServer
    ? await probePrinterServer(printerServerUrl)
    : false
  return { usePrinterServer, printerServerUrl, printerServerReachable }
})

ipcMain.handle('check-printer-server', async (_event, urlArg) => {
  const cfg = loadConfig()
  const url =
    (urlArg && String(urlArg).trim()) ||
    cfg?.printerServerUrl ||
    process.env.PRINTER_SERVER_URL ||
    DEFAULT_PRINTER_SERVER_URL
  resetPrinterServerCache()
  const printerServerReachable = await probePrinterServer(url)
  let posPrinterConnected
  if (printerServerReachable) {
    try {
      const health = await fetchHealth(url)
      posPrinterConnected = health?.printer?.connected
    } catch {
      posPrinterConnected = undefined
    }
  }
  return { printerServerUrl: url, printerServerReachable, posPrinterConnected }
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

/** Test receipt via POS service — same hidden Chromium page as CUPS test print. */
async function printTestReceiptViaPosService(baseUrl) {
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
  try {
    await win.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(testPrintHtml()),
    )
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('test page load timeout')), 15000)
      win.webContents.once('did-finish-load', () => {
        clearTimeout(t)
        setTimeout(resolve, 300)
      })
      win.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(t)
        reject(new Error(desc || `load failed ${code}`))
      })
    })
    const escpos = await buildEscPosFromWebContents(win.webContents, {
      cut: 'full',
      feedLinesBeforeCut: 4,
    })
    return await printEscPos(baseUrl, escpos)
  } finally {
    win.close()
  }
}

ipcMain.handle('test-print', async (_event, deviceNameArg) => {
  const cfg = loadConfig()
  if (cfg?.usePrinterServer === true) {
    const url = getPrinterServerUrl()
    resetPrinterServerCache()
    if (!(await probePrinterServer(url))) {
      pushPrinterLog('error', 'Printer server not reachable: ' + url)
      return {
        success: false,
        errorType: 'printer-server-unavailable',
        via: 'server',
        printerServerUrl: url,
      }
    }
    try {
      await assertPrinterReady(url)
      const testResult = await printTestReceiptViaPosService(url)
      if (testResult?.success) {
        pushPrinterLog('info', 'Test print sent via POS printer service')
      } else {
        pushPrinterLog(
          'error',
          'POS test print failed: ' + (testResult?.errorType || 'unknown'),
        )
      }
      return { ...testResult, via: 'server' }
    } catch (err) {
      pushPrinterLog('error', 'POS printer test print: ' + err.message)
      return {
        success: false,
        errorType: String(err.message || err),
        via: 'server',
      }
    }
  }

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
        win.webContents.print(receiptPrintOptions(deviceName, heightMicrons), async (success, errorType) => {
          win.close()
          if (!success) {
            pushPrinterLog('error', 'Test print failed: ' + (errorType || 'unknown'))
            resolve({ success: false, errorType })
            return
          }
          pushPrinterLog('info', 'Test print sent to printer')
          const queue = await waitForPrintQueueIdle(90000)
          resolve({
            success: success && queue.ok !== false,
            errorType: queue.ok === false ? queue.error : undefined,
            queueCompleted: queue.completed,
            incompleteJobs: queue.incompleteJobs,
          })
        })
      }, 300)
    })
  })
})

// ── IPC: Token print job + verified slip print ───────────────────────────────
ipcMain.handle('begin-token-print-job', async (_event, payload) => {
  if (isPrinterServerEnabled() && !(await usePrinterServer())) {
    throw new Error('POS printer service is not reachable')
  }
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

ipcMain.handle('get-token-print-status', async (_event, jobIdArg) => {
  const jobId = jobIdArg ? String(jobIdArg) : ''
  if (isPrinterServerEnabled() && !(await usePrinterServer())) {
    return { expected: 0, printed: 0, missing: [], errorType: 'printer-server-unavailable' }
  }
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
  enqueuePrint(async () => {
    if (isPrinterServerEnabled()) {
      if (!(await usePrinterServer())) {
        return printerServerUnavailableResult()
      }
      const url = getPrinterServerUrl()
      await assertPrinterReady(url)
      const escpos = await buildEscPosFromWebContents(mainWindow.webContents, {
        cut: 'full',
        feedLinesBeforeCut: 4,
      })
      return printEscPos(url, escpos)
    }
    return printReceiptSlip({})
  }),
)
