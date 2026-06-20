/**
 * Printer USB device discovery + connection test
 * Run: node printer-discover-test.js [windows-printer-name]
 *
 * What this tests:
 *  1. Registry scan  — can we find USB device paths by VID/PID?
 *  2. PnP enumeration — what devices + printer names does Windows see?
 *  3. DLL connection  — can Port_OpenUSBIO / Port_SetPort open each path?
 *  4. Status query    — what does Pos_QueryStstus return for each printer?
 *
 * Pass an optional Windows printer name argument to simulate the
 * multi-printer selection path, e.g.:
 *   node printer-discover-test.js "XP-58"
 */

'use strict';

const { execFileSync } = require('child_process');
const path   = require('path');
const fs     = require('fs');

// GUID_DEVINTERFACE_USBPRINT — the interface class EVERY USB printer registers
// under, regardless of brand. Discovery is no longer tied to a single VID/PID.
const PRINTER_GUID = '{28d78fad-5a12-11d1-ae5b-0000f803a8c2}';
// USB VIDs the bundled CsnPrinterLibs.dll can actually talk to.
const COMPATIBLE_VIDS = new Set(['0fe6']);
const vidOf = (v) => { const m = /vid_([0-9a-f]+)/i.exec(v || ''); return m ? m[1].toLowerCase() : ''; };
const DLL_PATH     = path.join(__dirname, 'assets', 'CsnPrinterLibs.dll');

const selectedPrinterName = process.argv[2] || '';

// ── helpers ──────────────────────────────────────────────────────────────────

function hr(ch = '─', w = 60) { return ch.repeat(w); }
function hb(v) { return `0x${v.toString(16).padStart(2,'0')} (${v.toString(2).padStart(8,'0')})`; }
function pass(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }
function info(msg) { console.log(`    ${msg}`); }

function runPS(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 12000, encoding: 'utf8' }
  ).trim();
}

// ── STEP 1: Registry scan ────────────────────────────────────────────────────

console.log(hr());
console.log('STEP 1 — Registry scan (DeviceClasses)');
console.log(hr());

// Brand-agnostic discovery — same logic as printer-monitor.js enumDevicePaths():
// enumerate every present USB printer via the USBPRINT DeviceClasses interface.
const psDeviceScan = `
$guid = '${PRINTER_GUID}'
$present = @{}
try {
  Get-PnpDevice -PresentOnly -EA SilentlyContinue |
    Where-Object { $_.InstanceId -like 'USB\\*' } |
    ForEach-Object { $seg = ($_.InstanceId -split '\\\\')[-1]; if ($seg) { $present[$seg.ToLower()] = $true } }
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
    $isPresent = if ($present.Count -eq 0) { $true } else { [bool]$present[$pp[2]] }
    if (-not $isPresent) { return }
    $results += [PSCustomObject]@{ path = $path; instanceId = $pp[2]; vidpid = $pp[1] }
  }
}
$results | ConvertTo-Json -Compress
`.trim();

let discoveredPaths = [];

try {
  const raw = runPS(psDeviceScan);
  if (!raw || raw === 'null') {
    fail('No connected USB printers found.');
    console.log('\n  Possible causes:');
    console.log('  • Printer is not connected / powered off');
    console.log('  • Printer driver not installed (no USBPRINT interface registered)');
  } else {
    const parsed = JSON.parse(raw);
    const items = (Array.isArray(parsed) ? parsed : [parsed]).filter(x => x && x.path);
    discoveredPaths = items.map(x => x.path);
    pass(`Found ${items.length} connected USB printer(s):`);
    items.forEach((x, i) => {
      const vid = vidOf(x.vidpid);
      const compat = COMPATIBLE_VIDS.has(vid) ? 'COMPATIBLE (DLL)' : 'NOT_SUPPORTED — DLL cannot read this chipset';
      info(`[${i+1}] ${x.path}`);
      info(`     vid/pid:      ${x.vidpid}  → ${compat}`);
      info(`     instance:     ${x.instanceId}`);
    });
    if (!items.some(x => COMPATIBLE_VIDS.has(vidOf(x.vidpid)))) {
      console.log('');
      info(`No printer matches a DLL-compatible VID (${[...COMPATIBLE_VIDS].join(', ')}).`);
      info('Live status will report NOT_SUPPORTED. Add the VID above to');
      info('kiosk-config.json -> "compatibleVids" only if the DLL truly supports it.');
    }
  }
} catch (err) {
  fail(`Device scan threw: ${err.message}`);
}

// ── STEP 2: PnP device enumeration ──────────────────────────────────────────

console.log('\n' + hr());
console.log('STEP 2 — PnP device + Windows printer enumeration');
console.log(hr());

const psPnp = `
$results = @()
try {
  $usbDevs = Get-PnpDevice -PresentOnly -EA SilentlyContinue |
    Where-Object { $_.InstanceId -like 'USB\\*' }
  $printers = Get-WmiObject Win32_Printer -EA SilentlyContinue | Select-Object Name, PortName
  foreach ($dev in $usbDevs) {
    $instParts = $dev.InstanceId -split '\\\\'
    $instSeg   = if ($instParts.Count -ge 3) { $instParts[2].ToLower() } else { '' }
    $matchPrinter = ''
    foreach ($p in $printers) {
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
  # Also list all Windows printers for reference
  foreach ($p in $printers) {
    $results += [PSCustomObject]@{
      instanceId   = ''
      friendlyName = "(Windows printer) port=$($p.PortName)"
      printerName  = $p.Name
    }
  }
} catch { Write-Error $_.Exception.Message }
$results | ConvertTo-Json -Compress
`.trim();

let pnpDevices = [];
try {
  const raw2 = runPS(psPnp);
  if (raw2 && raw2 !== 'null') {
    const parsed2 = JSON.parse(raw2);
    pnpDevices = Array.isArray(parsed2) ? parsed2 : [parsed2];

    const usbDevs = pnpDevices.filter(d => d.instanceId);
    const winPrinters = pnpDevices.filter(d => !d.instanceId);

    if (usbDevs.length === 0) {
      fail('No PnP USB devices found with matching VID/PID.');
    } else {
      pass(`Found ${usbDevs.length} USB PnP device(s):`);
      usbDevs.forEach((d, i) => {
        info(`[${i+1}] instanceId:   ${d.instanceId}`);
        info(`     friendlyName: ${d.friendlyName}`);
        info(`     printerName:  ${d.printerName || '(not matched to a Windows printer)'}`);
      });
    }

    if (winPrinters.length > 0) {
      console.log('');
      info('Windows printers currently installed:');
      winPrinters.forEach(d => info(`  • "${d.printerName}"  ${d.friendlyName}`));
    }
  } else {
    fail('PnP enumeration returned no results.');
  }
} catch (err) {
  fail(`PnP enumeration threw: ${err.message}`);
}

// ── STEP 3: DLL connection test ──────────────────────────────────────────────

console.log('\n' + hr());
console.log('STEP 3 — DLL connection test (Port_OpenUSBIO / Port_SetPort)');
console.log(hr());

if (!fs.existsSync(DLL_PATH)) {
  fail(`DLL not found at: ${DLL_PATH}`);
  console.log('  Cannot run DLL tests. Make sure the app is run from the my-electron directory.');
  process.exit(1);
}

let koffi, lib, Port_OpenUSBIO, Port_SetPort, Port_ClosePort, Pos_QueryStstus;
try {
  koffi = require('koffi');
  lib = koffi.load(DLL_PATH);
  Port_OpenUSBIO  = lib.func('__stdcall', 'Port_OpenUSBIO',  'void *',  ['str']);
  Port_SetPort    = lib.func('__stdcall', 'Port_SetPort',    'bool',    ['void *']);
  Port_ClosePort  = lib.func('__stdcall', 'Port_ClosePort',  'void',    ['void *']);
  Pos_QueryStstus = lib.func('__stdcall', 'Pos_QueryStstus', 'bool',    ['uint8 *', 'int', 'uint32']);
  pass(`DLL loaded: ${DLL_PATH}`);
} catch (err) {
  fail(`Failed to load DLL: ${err.message}`);
  process.exit(1);
}

if (discoveredPaths.length === 0) {
  fail('No device paths to test — skipping DLL connection tests.');
} else {
  discoveredPaths.forEach((devPath, i) => {
    console.log(`\n  Testing path [${i+1}]: ${devPath}`);
    let h = null;
    try {
      h = Port_OpenUSBIO(devPath);
      if (!h) { fail('Port_OpenUSBIO returned null — printer not responding on this path'); return; }
      pass('Port_OpenUSBIO succeeded');
    } catch (e) {
      fail(`Port_OpenUSBIO threw: ${e.message}`); return;
    }

    try {
      const ok = Port_SetPort(h);
      if (!ok) {
        fail('Port_SetPort returned false');
        try { Port_ClosePort(h); } catch (_) {}
        return;
      }
      pass('Port_SetPort succeeded — printer is connected and responsive');
    } catch (e) {
      fail(`Port_SetPort threw: ${e.message}`);
      try { Port_ClosePort(h); } catch (_) {}
      return;
    }

    // ── STEP 4: Status query ────────────────────────────────────────────────
    console.log('');
    console.log('  STEP 4 — Status query (Pos_QueryStstus types 1, 2, 4)');
    try {
      const t1 = Buffer.alloc(4, 0); Pos_QueryStstus(t1, 1, 1500);
      const t2 = Buffer.alloc(4, 0); Pos_QueryStstus(t2, 2, 1500);
      const t4 = Buffer.alloc(4, 0); Pos_QueryStstus(t4, 4, 1500);

      info(`t1[0] = ${hb(t1[0])}`);
      info(`t2[0] = ${hb(t2[0])}`);
      info(`t4[0] = ${hb(t4[0])}`);

      let status;
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

      pass(`Printer status: ${status}`);
    } catch (e) {
      fail(`Status query threw: ${e.message}`);
    }

    try { Port_ClosePort(h); } catch (_) {}
  });
}

// ── STEP 5: Multi-printer selection simulation ───────────────────────────────

if (selectedPrinterName) {
  console.log('\n' + hr());
  console.log(`STEP 5 — Multi-printer selection: "${selectedPrinterName}"`);
  console.log(hr());

  // Match by PnP instanceId
  const usbDevs = pnpDevices.filter(d => d.instanceId);
  let matched = null;

  // Exact match
  matched = usbDevs.find(d => d.printerName && d.printerName.toLowerCase() === selectedPrinterName.toLowerCase());
  if (matched) {
    const pathEntry = discoveredPaths.find(p => p.toLowerCase().includes(matched.instanceId));
    pass(`Exact match on port registry: instance=${matched.instanceId}`);
    info(`Device path: ${pathEntry || '(not found in registry scan)'}`);
  } else {
    // Partial match on friendlyName
    matched = usbDevs.find(d => {
      const fn = (d.friendlyName || '').toLowerCase();
      const wn = selectedPrinterName.toLowerCase();
      return fn.includes(wn) || wn.includes(fn);
    });
    if (matched) {
      const pathEntry = discoveredPaths.find(p => p.toLowerCase().includes(matched.instanceId));
      pass(`Partial friendlyName match: "${matched.friendlyName}" → instance=${matched.instanceId}`);
      info(`Device path: ${pathEntry || '(not found in registry scan)'}`);
    } else {
      fail(`No PnP match found for "${selectedPrinterName}"`);
      info('DLL probe fallback: will try each discovered path and use first that opens.');

      if (discoveredPaths.length > 0 && Port_OpenUSBIO) {
        for (const dp of discoveredPaths) {
          try {
            const h = Port_OpenUSBIO(dp);
            if (h) {
              try { Port_ClosePort(h); } catch (_) {}
              pass(`DLL probe succeeded → using: ${dp}`);
              break;
            }
          } catch (_) {}
        }
      }
    }
  }
}

console.log('\n' + hr());
console.log('Discovery test complete.');
console.log(hr());
