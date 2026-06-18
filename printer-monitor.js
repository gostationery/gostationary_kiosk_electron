const fs = require('fs');
const http = require('http');
const https = require('https');
const { app } = require('electron');
const path = require('path');

let koffi = null;
let lib = null;
let Port_OpenUSBIO = null;
let Port_SetPort = null;
let Port_ClosePort = null;
let Pos_Cmd = null;
let Pos_QueryStstus = null;

const DEV_PATH = '\\\\?\\usb#vid_0fe6&pid_811e#7666697e0b39#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}';
const DLL_PATH = path.join(__dirname, 'assets', 'CsnPrinterLibs.dll');
const CONFIG_PATH = path.join(app.getPath('userData'), 'kiosk-config.json');

let printerHandle = null;
let printerConnected = false;
let monitorIntervalId = null;

// Local stats (persisted locally with daily reset at midnight local time)
const stats = {
  printed: 0,
  failed: 0,
  date: new Date().toLocaleDateString('en-CA') // YYYY-MM-DD local
};

function saveStatsToConfig() {
  try {
    let cfg = {};
    if (fs.existsSync(CONFIG_PATH)) {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
    cfg.jobs_printed = stats.printed;
    cfg.jobs_failed = stats.failed;
    cfg.stats_date = stats.date;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    mainLog('[Printer Monitor] Failed to save stats to config:', err.message || err);
  }
}

function checkDailyReset() {
  const todayStr = new Date().toLocaleDateString('en-CA');
  if (stats.date !== todayStr) {
    mainLog(`[Printer Monitor] Date changed from ${stats.date} to ${todayStr}. Resetting daily print stats.`);
    stats.printed = 0;
    stats.failed = 0;
    stats.date = todayStr;
    saveStatsToConfig();
  }
}

let lastStatus = 'UNKNOWN';
let currentStatus = 'UNKNOWN';
let lastHeartbeatAt = 0;
let appConfig = null;
let mainLog = console.log;

// Dynamically and safely load DLL
function initDll() {
  if (process.platform !== 'win32') {
    mainLog('[Printer Monitor] Non-Windows platform. DLL polling disabled.');
    return false;
  }
  if (!fs.existsSync(DLL_PATH)) {
    mainLog(`[Printer Monitor] DLL not found at ${DLL_PATH}. Polling disabled.`);
    return false;
  }
  try {
    koffi = require('koffi');
    lib = koffi.load(DLL_PATH);
    Port_OpenUSBIO  = lib.func('__stdcall','Port_OpenUSBIO','void *',['str']);
    Port_SetPort    = lib.func('__stdcall','Port_SetPort','bool',['void *']);
    Port_ClosePort  = lib.func('__stdcall','Port_ClosePort','void',['void *']);
    Pos_Cmd         = lib.func('__stdcall','Pos_Cmd','bool',['uint8 *','int']);
    Pos_QueryStstus = lib.func('__stdcall','Pos_QueryStstus','bool',['uint8 *','int','uint32']);
    mainLog('[Printer Monitor] DLL loaded successfully.');
    return true;
  } catch (err) {
    mainLog('[Printer Monitor] Failed to load DLL:', err.message || err);
    return false;
  }
}

function connectPrinter() {
  if (!Port_OpenUSBIO) return false;
  try {
    if (printerHandle) {
      try { Port_ClosePort(printerHandle); } catch(_){}
      printerHandle = null;
    }
    const h = Port_OpenUSBIO(DEV_PATH);
    if (!h) return false;
    if (!Port_SetPort(h)) return false;
    printerHandle = h;
    printerConnected = true;
    mainLog('[Printer Monitor] USB printer connected.');
    return true;
  } catch(e) {
    printerConnected = false;
    return false;
  }
}

function getPrinterStatus() {
  if (!Pos_QueryStstus) return 'OFF';
  try {
    const t1 = Buffer.alloc(4); Pos_QueryStstus(t1, 1, 1500);
    const t2 = Buffer.alloc(4); Pos_QueryStstus(t2, 2, 1500); // queried for protocol; not used for detection
    const t4 = Buffer.alloc(4); Pos_QueryStstus(t4, 4, 1500);

    mainLog(`[Printer Status] t1=0x${t1[0].toString(16).padStart(2,'0')} t2=0x${t2[0].toString(16).padStart(2,'0')} t4=0x${t4[0].toString(16).padStart(2,'0')}`);

    if (t1[0] === 0x00) return 'OFF';

    // The DLL shifts which query type carries status depending on connection state.
    // t2 is the reliable cover/paper distinguisher in current mode:
    //   error bits (0x60) + path sensor (0x04) in t2 → COVER_OPEN
    //   error bits (0x60) in t2 but no path sensor   → PAPER_OUT
    // t4 is the fallback for old-mode cover-open (t4 has error+path but NOT bit3,
    // which would indicate accumulated near-end bits rather than a real cover signal).
    const t2CoverOpen = (t2[0] & 0x60) && (t2[0] & 0x04);
    const t4CoverOpen = (t4[0] & 0x60) && (t4[0] & 0x04) && !(t4[0] & 0x08);
    if (t2CoverOpen || t4CoverOpen) return 'COVER_OPEN';

    const hasError = (t1[0] & 0x60) || (t2[0] & 0x60) || (t4[0] & 0x60);
    if (hasError) return 'PAPER_OUT';

    const hasNearEnd = (t1[0] & 0x08) || (t4[0] & 0x08);
    if (hasNearEnd) return 'NEAR_END';

    return 'READY';
  } catch(e) {
    mainLog(`[Printer Status] Error reading status: ${e.message || e}`);
    return 'UNKNOWN';
  }
}



function sendUpdateToBackend(status, printed, failed, lastError = null) {
  if (!appConfig || !appConfig.domain || !appConfig.serial) {
    return;
  }

  const backendUrl = appConfig.backendUrl || 'http://127.0.0.1:8000';
  const domain = encodeURIComponent(appConfig.domain);
  const serial = encodeURIComponent(appConfig.serial);
  const urlString = `${backendUrl}/public/org/${domain}/machines/${serial}/printer-status`;

  try {
    const parsedUrl = new URL(urlString);
    const postData = JSON.stringify({
      status,
      jobs_printed: printed,
      jobs_failed: failed,
      last_error: lastError
    });

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const reqLib = parsedUrl.protocol === 'https:' ? https : http;
    const req = reqLib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          mainLog('[Printer Monitor] Failed to post status to backend:', res.statusCode, data);
        }
      });
    });

    req.on('error', (err) => {
      mainLog('[Printer Monitor] Error posting status to backend:', err.message || err);
    });

    req.write(postData);
    req.end();
  } catch (err) {
    mainLog('[Printer Monitor] Invalid URL or parse error:', err.message || err);
  }
}

function sendPrinterStatusLog(eventType, message = '') {
  if (!appConfig || !appConfig.domain || !appConfig.serial) return;

  const backendUrl = appConfig.backendUrl || 'http://127.0.0.1:8000';
  const domain = encodeURIComponent(appConfig.domain);
  const serial = encodeURIComponent(appConfig.serial);
  const urlString = `${backendUrl}/public/org/${domain}/machines/${serial}/printer-status-log`;

  try {
    const parsedUrl = new URL(urlString);
    const postData = JSON.stringify({ event_type: eventType, message });
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const reqLib = parsedUrl.protocol === 'https:' ? https : http;
    const req = reqLib.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode >= 400) {
          mainLog(`[Printer Monitor] Failed to log printer status event (${eventType}):`, res.statusCode);
        }
      });
    });
    req.on('error', (err) => {
      mainLog(`[Printer Monitor] Error logging printer status event (${eventType}):`, err.message || err);
    });
    req.write(postData);
    req.end();
  } catch (err) {
    mainLog('[Printer Monitor] Invalid URL for printer status log:', err.message || err);
  }
}

function sendPrintJobLog(success, errorMsg = null) {
  if (!appConfig || !appConfig.domain || !appConfig.serial) return;

  const backendUrl = appConfig.backendUrl || 'http://127.0.0.1:8000';
  const domain = encodeURIComponent(appConfig.domain);
  const serial = encodeURIComponent(appConfig.serial);
  const urlString = `${backendUrl}/public/org/${domain}/machines/${serial}/printer-job-log`;

  try {
    const parsedUrl = new URL(urlString);
    const postData = JSON.stringify({ success, error_msg: errorMsg || null });
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const reqLib = parsedUrl.protocol === 'https:' ? https : http;
    const req = reqLib.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode >= 400) {
          mainLog('[Printer Monitor] Failed to log print job to backend:', res.statusCode);
        }
      });
    });
    req.on('error', (err) => {
      mainLog('[Printer Monitor] Error logging print job to backend:', err.message || err);
    });
    req.write(postData);
    req.end();
  } catch (err) {
    mainLog('[Printer Monitor] Invalid URL for print job log:', err.message || err);
  }
}

function startPrinterMonitor(config, loggerFn) {
  if (loggerFn) mainLog = loggerFn;
  appConfig = config;

  // Load daily print stats from disk config
  const todayStr = new Date().toLocaleDateString('en-CA');
  stats.date = todayStr;
  if (config && config.stats_date === todayStr) {
    if (typeof config.jobs_printed === 'number') stats.printed = config.jobs_printed;
    if (typeof config.jobs_failed === 'number') stats.failed = config.jobs_failed;
    mainLog(`[Printer Monitor] Loaded daily print stats: printed=${stats.printed}, failed=${stats.failed}`);
  } else {
    stats.printed = 0;
    stats.failed = 0;
    saveStatsToConfig();
    mainLog(`[Printer Monitor] Daily reset or first setup initialized for ${todayStr}.`);
  }

  if (monitorIntervalId) {
    clearInterval(monitorIntervalId);
  }

  const hasDll = initDll();
  if (hasDll) {
    connectPrinter();
  }

  // Initial update — always send to backend so a status that never changes
  // (e.g. printer is at NEAR_END from the moment the app starts) still gets
  // reported and doesn't wait for the 30-second heartbeat.
  const initialStatus = hasDll ? (printerConnected ? getPrinterStatus() : 'OFF') : 'OFF';
  lastStatus = initialStatus;
  currentStatus = initialStatus;
  lastHeartbeatAt = 0; // force first interval tick to send immediately
  sendUpdateToBackend(initialStatus, stats.printed, stats.failed);

  // Poll status every 5 seconds
  monitorIntervalId = setInterval(() => {
    checkDailyReset();
    if (hasDll) {
      if (!printerConnected) {
        connectPrinter();
      }
      if (printerConnected) {
        currentStatus = getPrinterStatus();
        if (currentStatus === 'OFF' || currentStatus === 'UNKNOWN' || currentStatus === 'ERROR') {
          mainLog(`[Printer Monitor] Connection lost (status: ${currentStatus}). Resetting handle for reconnect retry.`);
          printerConnected = false;
          if (printerHandle && Port_ClosePort) {
            try { Port_ClosePort(printerHandle); } catch(_){}
            printerHandle = null;
          }
        }
      } else {
        currentStatus = 'OFF';
      }
    } else {
      currentStatus = 'OFF';
    }

    const statusChanged = currentStatus !== lastStatus;

    if (statusChanged) {
      mainLog(`[Printer Monitor] Status changed from ${lastStatus} to ${currentStatus}`);

      // Log meaningful state transitions
      if (currentStatus === 'OFF' && lastStatus !== 'UNKNOWN') {
        sendPrinterStatusLog('PRINTER_OFFLINE', `Was ${lastStatus}`);
      } else if (lastStatus === 'OFF' && currentStatus !== 'OFF') {
        sendPrinterStatusLog('PRINTER_ONLINE', `Now ${currentStatus}`);
      } else if (currentStatus === 'COVER_OPEN') {
        sendPrinterStatusLog('COVER_OPEN', 'Printer cover was opened');
      } else if (currentStatus === 'NEAR_END') {
        sendPrinterStatusLog('PAPER_LOW', 'Paper level is low');
      } else if (currentStatus === 'READY' && (lastStatus === 'NEAR_END' || lastStatus === 'PAPER_OUT')) {
        sendPrinterStatusLog('PAPER_REFILLED', 'Paper refilled, printer ready');
      }

      lastStatus = currentStatus;
      lastHeartbeatAt = Date.now();
      sendUpdateToBackend(currentStatus, stats.printed, stats.failed);
    } else if (Date.now() - lastHeartbeatAt >= 10_000) {
      // Periodic heartbeat every 10s — re-send even if status unchanged
      lastHeartbeatAt = Date.now();
      sendUpdateToBackend(currentStatus, stats.printed, stats.failed);
    }
  }, 5000);
}

function stopPrinterMonitor() {
  if (monitorIntervalId) {
    clearInterval(monitorIntervalId);
    monitorIntervalId = null;
  }
  if (printerHandle && Port_ClosePort) {
    try { Port_ClosePort(printerHandle); } catch(_){}
    printerHandle = null;
  }
  printerConnected = false;
}

function reportPrintJobResult(success, errorMsg = null) {
  checkDailyReset();
  if (success) {
    stats.printed++;
  } else {
    stats.failed++;
  }
  saveStatsToConfig();
  sendPrintJobLog(success, errorMsg);
  // Immediately report job completion update to backend
  const status = getPrinterStatus();
  if (status === 'OFF' || status === 'UNKNOWN' || status === 'ERROR') {
    printerConnected = false;
    if (printerHandle && Port_ClosePort) {
      try { Port_ClosePort(printerHandle); } catch(_){}
      printerHandle = null;
    }
  }
  sendUpdateToBackend(status, stats.printed, stats.failed, errorMsg);
}

/**
 * @param {boolean} [forceRefresh] - When true, always do a live DLL query even if the
 *   background monitor is running.  Use this for post-print verification so a paper-out
 *   that occurred *during* the print job is detected before the 5-second poll fires.
 */
function queryPrinterStatusOnDemand(forceRefresh = false) {
  // If the background monitor is running, return its cached status —
  // UNLESS the caller needs a guaranteed fresh reading (e.g. post-print check).
  if (monitorIntervalId && !forceRefresh) {
    return currentStatus;
  }

  // If we have an active DLL connection we can query it directly.
  if (monitorIntervalId && forceRefresh && Pos_QueryStstus && printerConnected) {
    const fresh = getPrinterStatus();
    // Keep the cached status in sync so the background loop sees the update.
    currentStatus = fresh;
    return fresh;
  }

  if (process.platform !== 'win32') {
    return 'UNKNOWN';
  }

  if (!Port_OpenUSBIO) {
    initDll();
  }
  if (!Port_OpenUSBIO) {
    return 'UNKNOWN';
  }

  try {
    // On fresh connections, if Port_OpenUSBIO or Port_SetPort fail the printer is OFF
    const h = Port_OpenUSBIO(DEV_PATH);
    if (!h) return 'OFF';
    if (!Port_SetPort(h)) {
      try { Port_ClosePort(h); } catch(_){}
      return 'OFF';
    }

    let status = 'READY';
    if (Pos_QueryStstus) {
      const t1 = Buffer.alloc(4); Pos_QueryStstus(t1, 1, 1500);
      const t2 = Buffer.alloc(4); Pos_QueryStstus(t2, 2, 1500);
      const t4 = Buffer.alloc(4); Pos_QueryStstus(t4, 4, 1500);

      mainLog(`[Printer OnDemand] Raw: t1=0x${t1[0].toString(16).padStart(2,'0')} t2=0x${t2[0].toString(16).padStart(2,'0')} t4=0x${t4[0].toString(16).padStart(2,'0')}`);

      if (t1[0] === 0x00) {
        status = 'OFF';
      } else {
        const t2CoverOpen = (t2[0] & 0x60) && (t2[0] & 0x04);
        const t4CoverOpen = (t4[0] & 0x60) && (t4[0] & 0x04) && !(t4[0] & 0x08);
        const hasError    = (t1[0] & 0x60) || (t2[0] & 0x60) || (t4[0] & 0x60);
        const hasNearEnd  = (t1[0] & 0x08) || (t4[0] & 0x08);
        if (t2CoverOpen || t4CoverOpen) status = 'COVER_OPEN';
        else if (hasError)              status = 'PAPER_OUT';
        else if (hasNearEnd)            status = 'NEAR_END';
        else                            status = 'READY';
      }
    }

    try { Port_ClosePort(h); } catch(_){}
    return status;
  } catch (err) {
    return 'UNKNOWN';
  }
}

module.exports = {
  startPrinterMonitor,
  stopPrinterMonitor,
  reportPrintJobResult,
  queryPrinterStatusOnDemand
};
