// Printer diagnostic - reads raw status bytes for ALL 4 query types
// Run: node printer-diag.js
// Do this ONCE with cover open, ONCE with cover closed + low paper, ONCE with paper OK

const koffi = require('koffi');

const DLL_PATH = 'C:\\gost-printer\\CsnPrinterLibs.dll';
const DEV_PATH = '\\\\?\\usb#vid_0fe6&pid_811e#7666697e0b39#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}';

function hexBin(v) {
  return '0x' + v.toString(16).padStart(2, '0') + '(' + v.toString(2).padStart(8, '0') + ')';
}

function printBits(label, byte0) {
  const bits = [];
  for (let b = 7; b >= 0; b--) {
    if ((byte0 >> b) & 1) bits.push('bit' + b);
  }
  console.log('  ' + label + ' byte0=' + hexBin(byte0) + '  SET_BITS=[' + bits.join(',') + ']');
}

try {
  const lib = koffi.load(DLL_PATH);
  const Port_OpenUSBIO  = lib.func('__stdcall', 'Port_OpenUSBIO',  'void *', ['str']);
  const Port_SetPort    = lib.func('__stdcall', 'Port_SetPort',    'bool',   ['void *']);
  const Port_ClosePort  = lib.func('__stdcall', 'Port_ClosePort',  'void',   ['void *']);
  const Pos_QueryStstus = lib.func('__stdcall', 'Pos_QueryStstus', 'bool',   ['uint8 *', 'int', 'uint32']);

  const h = Port_OpenUSBIO(DEV_PATH);
  if (!h) { console.log('FAIL: Port_OpenUSBIO returned null - printer not found'); process.exit(1); }
  const ok = Port_SetPort(h);
  if (!ok) { console.log('FAIL: Port_SetPort failed'); Port_ClosePort(h); process.exit(1); }

  console.log('\n=== PRINTER DIAGNOSTIC ===\n');

  for (let type = 1; type <= 4; type++) {
    const buf = Buffer.alloc(4, 0);
    const res = Pos_QueryStstus(buf, type, 2000);
    const bytes = [0,1,2,3].map(i => hexBin(buf[i])).join('  ');
    console.log('QueryStstus(type=' + type + ') ok=' + res);
    console.log('  ALL bytes: ' + bytes);
    printBits('byte[0]', buf[0]);
    printBits('byte[1]', buf[1]);
    console.log('');
  }

  Port_ClosePort(h);
  console.log('=== DONE ===');
} catch (e) {
  console.error('ERROR:', e.message || e);
}
