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

// {28d78fad-5a12-11d1-ae5b-0000f803a8c2} is GUID_DEVINTERFACE_USBPRINT — the
// standard Windows interface class that EVERY USB printer (any brand) registers
// under. We enumerate this generically so detection is not tied to one model.
const PRINTER_GUID = '{28d78fad-5a12-11d1-ae5b-0000f803a8c2}';

// The bundled CsnPrinterLibs.dll only speaks the CSN/POS protocol for printers
// built on the ICS-Advent (VID 0FE6) thermal chipset family. We discover any
// connected USB printer dynamically, but only attempt the DLL on devices whose
// USB Vendor ID is in this allowlist. Anything else is reported NOT_SUPPORTED
// rather than a misleading OFFLINE. Override per-machine via
// kiosk-config.json -> "compatibleVids": ["0fe6", "1234", ...].
const DEFAULT_COMPATIBLE_VIDS = ['0fe6'];
let COMPATIBLE_VIDS = new Set(DEFAULT_COMPATIBLE_VIDS);

/** Extract the 4-hex-digit USB VID from a "vid_0fe6&pid_811e" segment. */
function vidOf(vidpid) {
  const m = /vid_([0-9a-f]+)/i.exec(vidpid || '');
  return m ? m[1].toLowerCase() : '';
}
// When packed inside an asar archive, native DLLs must be loaded from the
// unpacked location (app.asar.unpacked). Electron-builder extracts anything
// matched by asarUnpack there. We detect the asar case by checking whether
// __dirname contains "app.asar" (but not already "app.asar.unpacked").
const _rawDllPath = path.join(__dirname, 'assets', 'CsnPrinterLibs.dll');
const DLL_PATH = _rawDllPath.includes('app.asar') && !_rawDllPath.includes('app.asar.unpacked')
  ? _rawDllPath.replace('app.asar', 'app.asar.unpacked')
  : _rawDllPath;
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

// Cache: windowsPrinterName (or '' for any) → resolved device path
const devicePathCache = new Map();

/**
 * Enumerates ALL currently-connected USB printers (any brand / VID / PID) by
 * reading the registered device-interface symbolic links under the standard
 * USBPRINT interface class GUID, then cross-checking each against the set of
 * PRESENT (plugged-in) USB devices reported by Get-PnpDevice.
 *
 * This is brand-agnostic: every USB printer that uses usbprint.sys registers an
 * interface under GUID_DEVINTERFACE_USBPRINT, so we no longer assume a single
 * hardcoded VID/PID. The DeviceClasses symbolic-link name IS the openable path
 * (only the "##?#" prefix differs from the "\\?\" CreateFile form).
 *
 *   registry key:  ##?#USB#VID_0FE6&PID_811E#<serial>#{GUID}
 *   → device path: \\?\usb#vid_0fe6&pid_811e#<serial>#{guid}
 *
 * Returns array of { path, instanceId, vidpid, present } objects.
 */
function enumDevicePaths() {
  if (process.platform !== 'win32') return [];

  const psScript = `
$guid = '${PRINTER_GUID}'
$present = @{}
try {
  Get-PnpDevice -PresentOnly -EA SilentlyContinue |
    Where-Object { $_.InstanceId -like 'USB\\*' } |
    ForEach-Object {
      $seg = ($_.InstanceId -split '\\\\')[-1]
      if ($seg) { $present[$seg.ToLower()] = $true }
    }
} catch {}
$results = @()
$base = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceClasses\\$guid"
if (Test-Path -LiteralPath $base) {
  Get-ChildItem -LiteralPath $base -EA SilentlyContinue | ForEach-Object {
    $leaf = $_.PSChildName
    if ($leaf -notmatch '^##\\?#USB#') { return }
    $path = ($leaf -replace '^##\\?#', '\\\\?\\').ToLower()
    $pp = $path -split '#'
    if ($pp.Count -lt 4) { return }
    $vidpid = $pp[1]
    $serial = $pp[2]
    $isPresent = if ($present.Count -eq 0) { $true } else { [bool]$present[$serial] }
    $results += [PSCustomObject]@{ path = $path; instanceId = $serial; vidpid = $vidpid; present = $isPresent }
  }
}
$results | ConvertTo-Json -Compress
`.trim();

  try {
    const { execFileSync } = require('child_process');
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 8000, encoding: 'utf8' }
    ).trim();

    if (!raw || raw === 'null') return [];

    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.filter(x => x && x.path && x.path.startsWith('\\\\'));
  } catch (err) {
    mainLog('[Printer Monitor] enumDevicePaths failed:', err.message || err);
    return [];
  }
}

/**
 * Uses PowerShell Get-PnpDevice to list all currently-present USB devices (any
 * brand) and the Windows printer names associated with each. Used only to
 * correlate a chosen Windows printer name to a USB device instance when more
 * than one compatible printer is plugged in.
 * Returns an array of { instanceId, friendlyName, printerName }.
 * printerName is the Windows spooler name (may be empty if not yet associated).
 */
function enumPnpPrinterDevices() {
  if (process.platform !== 'win32') return [];

  const psScript = `
$results = @()
try {
  $usbDevs = Get-PnpDevice -PresentOnly -EA SilentlyContinue |
    Where-Object { $_.InstanceId -like 'USB\\*' }
  $printers = Get-WmiObject Win32_Printer -EA SilentlyContinue | Select-Object Name, PortName
  foreach ($dev in $usbDevs) {
    # InstanceId looks like "USB\\VID_0FE6&PID_811E\\7666697e0b39"
    $instParts = $dev.InstanceId -split '\\\\'
    $instSeg   = if ($instParts.Count -ge 3) { $instParts[2].ToLower() } else { '' }
    # Try to find a printer whose port is tied to this device instance
    # Port names like USB001/USB002 are assigned sequentially; we correlate via
    # the USBPRINT enum which uses ParentIdPrefix derived from USB instance
    $matchPrinter = ''
    foreach ($p in $printers) {
      # The printer name often contains a substring of the driver/model name;
      # try matching on the USB instance segment embedded in the port or device path
      $portReg = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\USB Monitor\\Ports\\" + $p.PortName
      if (Test-Path $portReg) {
        $portDesc = (Get-ItemProperty $portReg -EA SilentlyContinue).'Port Description'
        if ($portDesc -and $portDesc -imatch $instSeg) { $matchPrinter = $p.Name; break }
      }
    }
    $results += [PSCustomObject]@{
      instanceId   = $instSeg
      friendlyName = $dev.FriendlyName
      printerName  = $matchPrinter
    }
  }
} catch {}
$results | ConvertTo-Json -Compress
`.trim();

  try {
    const { execFileSync } = require('child_process');
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 10000, encoding: 'utf8' }
    ).trim();

    if (!raw || raw === 'null') return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    mainLog('[Printer Monitor] enumPnpPrinterDevices failed:', err.message || err);
    return [];
  }
}

/**
 * Resolve the USB device interface path for the given Windows printer name.
 * Result is cached per printerName so subsequent calls are instant.
 *
 * Returns { path, anyPresent } where:
 *   - path        = device-interface path of a DLL-COMPATIBLE printer, or null.
 *   - anyPresent  = true if ANY USB printer (compatible or not) is plugged in.
 *
 * Callers map this to status:
 *   path != null            → try DLL → READY / PAPER_OUT / ... / OFF
 *   path == null & present   → NOT_SUPPORTED  (a printer is there, wrong chipset)
 *   path == null & !present  → OFF            (no printer connected at all)
 *
 * Strategy (in order):
 *  1. Return cached value if present.
 *  2. Enumerate ALL present USB printers (any brand) via the USBPRINT interface.
 *  3. Keep only those whose USB VID is in COMPATIBLE_VIDS (DLL can speak to them).
 *  4. One compatible → use it. Multiple → correlate by chosen Windows printer
 *     name, else DLL-probe, else first.
 */
function resolveDevicePath(windowsPrinterName) {
  const cacheKey = windowsPrinterName || '';
  if (devicePathCache.has(cacheKey)) return devicePathCache.get(cacheKey);

  const all = enumDevicePaths();
  const usable = all.some(p => p.present) ? all.filter(p => p.present) : all;
  const anyPresent = usable.length > 0;

  mainLog(`[Printer Monitor] USB-print scan found ${usable.length} present printer(s).`);
  usable.forEach(p => mainLog(`  → ${p.path}  (vid/pid: ${p.vidpid})`));

  const compatible = usable.filter(p => COMPATIBLE_VIDS.has(vidOf(p.vidpid)));

  const cacheAndReturn = (path) => {
    const result = { path, anyPresent };
    devicePathCache.set(cacheKey, result);
    return result;
  };

  if (compatible.length === 0) {
    if (anyPresent) {
      const vids = [...new Set(usable.map(p => vidOf(p.vidpid)))].join(', ');
      mainLog(`[Printer Monitor] ${usable.length} USB printer(s) present but none use a DLL-compatible chipset (VIDs seen: ${vids}; supported: ${[...COMPATIBLE_VIDS].join(', ')}). → NOT_SUPPORTED`);
    } else {
      mainLog('[Printer Monitor] No USB printer connected. → OFF');
    }
    return cacheAndReturn(null);
  }

  if (compatible.length === 1) {
    mainLog(`[Printer Monitor] Single compatible printer, using: ${compatible[0].path}`);
    return cacheAndReturn(compatible[0].path);
  }

  // Multiple compatible printers — correlate by the chosen Windows printer name.
  if (cacheKey) {
    const pnpDevs = enumPnpPrinterDevices();
    mainLog(`[Printer Monitor] ${compatible.length} compatible printers; correlating "${cacheKey}" via ${pnpDevs.length} PnP device(s)`);

    // First pass: exact printerName match from port registry
    for (const dev of pnpDevs) {
      if (dev.printerName && dev.printerName.toLowerCase() === cacheKey.toLowerCase()) {
        const match = compatible.find(p => p.instanceId === dev.instanceId);
        if (match) {
          mainLog(`[Printer Monitor] Matched "${cacheKey}" → instance ${dev.instanceId} → ${match.path}`);
          return cacheAndReturn(match.path);
        }
      }
    }

    // Second pass: partial / substring match on friendlyName
    for (const dev of pnpDevs) {
      const fn = (dev.friendlyName || '').toLowerCase();
      const wn = cacheKey.toLowerCase();
      if (fn && (fn.includes(wn) || wn.includes(fn))) {
        const match = compatible.find(p => p.instanceId === dev.instanceId);
        if (match) {
          mainLog(`[Printer Monitor] Partial-matched "${cacheKey}" via friendlyName "${dev.friendlyName}" → ${match.path}`);
          return cacheAndReturn(match.path);
        }
      }
    }

    mainLog(`[Printer Monitor] No PnP match for "${cacheKey}". Probing DLL for each compatible path…`);
  }

  // Probe each compatible path with the DLL (if loaded) and use first that opens
  if (Port_OpenUSBIO && Port_ClosePort) {
    for (const entry of compatible) {
      try {
        const h = Port_OpenUSBIO(entry.path);
        if (h) {
          try { Port_ClosePort(h); } catch (_) {}
          mainLog(`[Printer Monitor] DLL probe succeeded for: ${entry.path}`);
          return cacheAndReturn(entry.path);
        }
      } catch (_) {}
    }
  }

  // Fall back to first compatible path
  mainLog(`[Printer Monitor] Falling back to first compatible path: ${compatible[0].path}`);
  return cacheAndReturn(compatible[0].path);
}

let lastStatus = 'UNKNOWN';
let currentStatus = 'UNKNOWN';
let lastHeartbeatAt = 0;
let appConfig = null;
let activePrinterName = ''; // Windows spooler name of the currently monitored printer
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

/**
 * Attempt to open the active printer. Returns one of:
 *   'CONNECTED'      — DLL-compatible printer opened; status is queryable.
 *   'NOT_SUPPORTED'  — a USB printer is connected but the DLL can't talk to it.
 *   'OFF'            — no USB printer connected at all.
 */
function connectPrinter() {
  printerConnected = false;
  if (!Port_OpenUSBIO) {
    // DLL unavailable — fall back to presence only so we still distinguish
    // "wrong printer plugged in" from "nothing plugged in".
    const { anyPresent } = resolveDevicePath(activePrinterName);
    return anyPresent ? 'NOT_SUPPORTED' : 'OFF';
  }
  try {
    if (printerHandle) {
      try { Port_ClosePort(printerHandle); } catch(_){}
      printerHandle = null;
    }
    const { path: devPath, anyPresent } = resolveDevicePath(activePrinterName);
    if (!devPath) return anyPresent ? 'NOT_SUPPORTED' : 'OFF';
    // Compatible printer found — any DLL open failure here is transient (device
    // busy, bad port state, mid-replug). Return 'OFF' so the poll loop retries
    // on the next tick rather than treating it as a permanent NOT_SUPPORTED.
    const h = Port_OpenUSBIO(devPath);
    if (!h) return 'OFF';
    if (!Port_SetPort(h)) {
      try { Port_ClosePort(h); } catch(_){}
      return 'OFF';
    }
    printerHandle = h;
    printerConnected = true;
    mainLog('[Printer Monitor] USB printer connected.');
    return 'CONNECTED';
  } catch(e) {
    printerConnected = false;
    return 'OFF';
  }
}

/**
 * Close any existing handle and open a brand-new one from the (cached) device
 * path, leaving it as the active port. Returns true if a live handle is ready.
 *
 * Reusing one long-lived handle makes the CSN/POS DLL hand back buffered/stale
 * status, so paper-out/near-end never propagate — which is exactly why the setup
 * screen (fresh handle per query) reads correctly while the long-lived monitor
 * stayed stuck on its first reading. We therefore reopen before every read.
 *
 * The resolved device path is cached, so this is a cheap local USB open with no
 * PowerShell rescan. The monitor is single-threaded (synchronous DLL calls on the
 * Node event loop), so this never races with another read — there is never a
 * second *concurrent* handle to corrupt the DLL's internal active port.
 */
function reopenHandleFresh() {
  if (printerHandle && Port_ClosePort) {
    try { Port_ClosePort(printerHandle); } catch (_) {}
    printerHandle = null;
  }
  printerConnected = false;
  if (!Port_OpenUSBIO) return false;
  const { path: devPath } = resolveDevicePath(activePrinterName);
  if (!devPath) return false;
  try {
    const h = Port_OpenUSBIO(devPath);
    if (!h) return false;
    if (!Port_SetPort(h)) {
      try { Port_ClosePort(h); } catch (_) {}
      return false;
    }
    printerHandle = h;
    printerConnected = true;
    return true;
  } catch (_) {
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

  // Compatible chipset VIDs — overridable per-machine via config so new printer
  // models can be supported without a code change.
  if (config && Array.isArray(config.compatibleVids) && config.compatibleVids.length) {
    COMPATIBLE_VIDS = new Set(
      config.compatibleVids.map(v => String(v).toLowerCase().replace(/^0x/, '').replace(/^vid_/, ''))
    );
  } else {
    COMPATIBLE_VIDS = new Set(DEFAULT_COMPATIBLE_VIDS);
  }
  mainLog(`[Printer Monitor] DLL-compatible VIDs: ${[...COMPATIBLE_VIDS].join(', ')}`);

  // When printer selection changes, clear the path cache so the new printer
  // gets re-discovered instead of reusing the old one.
  const newPrinterName = (config && config.printerName) ? String(config.printerName) : '';
  if (newPrinterName !== activePrinterName) {
    devicePathCache.clear();
    activePrinterName = newPrinterName;
    mainLog(`[Printer Monitor] Active printer set to: "${activePrinterName || '(auto-detect)'}"`);
  } else {
    // Same printer name but re-started (e.g. config re-saved): drop the cache so
    // hardware that was swapped without renaming is re-discovered.
    devicePathCache.clear();
  }

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

  // Initial update — always send to backend so a status that never changes
  // (e.g. printer is at NEAR_END from the moment the app starts) still gets
  // reported and doesn't wait for the heartbeat.
  let initialStatus;
  if (hasDll) {
    const conn = connectPrinter();
    initialStatus = conn === 'CONNECTED' ? getPrinterStatus() : conn; // 'NOT_SUPPORTED' | 'OFF'
  } else {
    // No DLL: we can't read live status, but still distinguish wrong-printer
    // (NOT_SUPPORTED) from no-printer (OFF) by presence alone.
    const { anyPresent } = resolveDevicePath(activePrinterName);
    initialStatus = anyPresent ? 'NOT_SUPPORTED' : 'OFF';
  }
  lastStatus = initialStatus;
  currentStatus = initialStatus;
  lastHeartbeatAt = 0; // force first interval tick to send immediately
  let lastRediscoverAt = Date.now();
  sendUpdateToBackend(initialStatus, stats.printed, stats.failed);

  // Poll status every 5 seconds
  monitorIntervalId = setInterval(() => {
    checkDailyReset();

    if (!hasDll) {
      const { anyPresent } = resolveDevicePath(activePrinterName);
      currentStatus = anyPresent ? 'NOT_SUPPORTED' : 'OFF';
    } else if (reopenHandleFresh()) {
      // Reopen a FRESH handle every poll before reading so the DLL doesn't return
      // stale buffered status. The cached device path makes this a cheap local USB
      // open (no PowerShell rescan) on the healthy path.
      currentStatus = getPrinterStatus();
    } else {
      // No live handle: distinguish wrong-printer from nothing-connected, and
      // periodically drop the path cache so a (re)plugged printer is rediscovered
      // (bounded to once per 15s to cap the PowerShell scan cost).
      if (Date.now() - lastRediscoverAt >= 15_000) {
        devicePathCache.delete(activePrinterName);
        lastRediscoverAt = Date.now();
      }
      const { anyPresent } = resolveDevicePath(activePrinterName);
      currentStatus = anyPresent ? 'NOT_SUPPORTED' : 'OFF';
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
  // Immediately report job completion update to backend. Reopen a fresh handle so
  // the status reflects the printer right now (a reused handle can be stale, e.g.
  // paper that ran out on this very job).
  const status = reopenHandleFresh() ? getPrinterStatus() : 'OFF';
  sendUpdateToBackend(status, stats.printed, stats.failed, errorMsg);
}

/**
 * @param {boolean} [forceRefresh] - When true, always do a live DLL query even if the
 *   background monitor is running.  Use this for post-print verification so a paper-out
 *   that occurred *during* the print job is detected before the 5-second poll fires.
 * @param {string|null} [printerNameOverride] - Query a SPECIFIC Windows printer
 *   rather than the one the background monitor is watching. Used by the setup
 *   screen so the status badge reflects whichever printer is selected in the
 *   dropdown, even before it's saved as the active printer.
 */
function queryPrinterStatusOnDemand(forceRefresh = false, printerNameOverride = null) {
  const overriding =
    printerNameOverride !== null &&
    printerNameOverride !== undefined &&
    String(printerNameOverride) !== activePrinterName;

  // ── Monitor is running ───────────────────────────────────────────────────
  if (monitorIntervalId) {
    if (!overriding) {
      // Same printer the monitor is watching.
      if (!forceRefresh) return currentStatus;
      // Force-fresh: reopen a brand-new handle and read. A reused handle returns
      // stale/buffered status, so a paper-out that happened *during* a print job
      // would be missed. Safe to reopen — the monitor is single-threaded, so this
      // never races with the poll's own reopen (no concurrent second handle).
      if (Pos_QueryStstus && reopenHandleFresh()) {
        const fresh = getPrinterStatus();
        currentStatus = fresh;
        return fresh;
      }
      return currentStatus;
    }

    // Querying a DIFFERENT printer while monitor is running.
    // We must NOT open a second USB handle here for the same reason above.
    // Instead: check whether a compatible USB device with the requested name
    // is present — report NOT_SUPPORTED (different brand) or fall back to the
    // monitor's own cached status when the names actually resolve to the same
    // physical device (e.g. fallback vs. explicitly named).
    const nameForCheck = String(printerNameOverride);
    // Quick cache-free presence check using only what's already enumerated.
    const cached = devicePathCache.get(activePrinterName);
    // If the active monitor device has a path, the printer IS compatible.
    // Assume the override name resolves to the same hardware (common case in
    // setup screen before saving) and return the live monitor status.
    if (cached && cached.path) return currentStatus;
    // No compatible device in monitor — check presence for this specific name.
    const { path: p, anyPresent } = resolveDevicePath(nameForCheck);
    devicePathCache.delete(nameForCheck); // don't pollute monitor's cache
    return p ? currentStatus : (anyPresent ? 'NOT_SUPPORTED' : 'OFF');
  }

  // ── Monitor is NOT running (setup screen before first save, or stopped) ──
  if (process.platform !== 'win32') return 'UNKNOWN';

  if (!Port_OpenUSBIO) initDll();
  if (!Port_OpenUSBIO) {
    const name = overriding ? String(printerNameOverride) : activePrinterName;
    const { anyPresent } = resolveDevicePath(name);
    return anyPresent ? 'NOT_SUPPORTED' : 'OFF';
  }

  try {
    const name = overriding ? String(printerNameOverride) : activePrinterName;
    const { path: devPath, anyPresent } = resolveDevicePath(name);

    if (!devPath) return anyPresent ? 'NOT_SUPPORTED' : 'OFF';
    const h = Port_OpenUSBIO(devPath);
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
  queryPrinterStatusOnDemand,
  enumDevicePaths,       // exposed for diagnostics / tests
  enumPnpPrinterDevices, // exposed for diagnostics / tests
};
