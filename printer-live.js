// Live printer status poller — run this, then change cover / paper state while it runs
// Ctrl+C to stop

const koffi = require('koffi');

const DLL_PATH = 'C:\\gost-printer\\CsnPrinterLibs.dll';
const DEV_PATH = '\\\\?\\usb#vid_0fe6&pid_811e#7666697e0b39#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}';

function hb(v) { return '0x' + v.toString(16).padStart(2, '0') + '(' + v.toString(2).padStart(8, '0') + ')'; }

const lib = koffi.load(DLL_PATH);
const Port_OpenUSBIO  = lib.func('__stdcall', 'Port_OpenUSBIO',  'void *', ['str']);
const Port_SetPort    = lib.func('__stdcall', 'Port_SetPort',    'bool',   ['void *']);
const Port_ClosePort  = lib.func('__stdcall', 'Port_ClosePort',  'void',   ['void *']);
const Pos_QueryStstus = lib.func('__stdcall', 'Pos_QueryStstus', 'bool',   ['uint8 *', 'int', 'uint32']);

let h = Port_OpenUSBIO(DEV_PATH);
if (!h || !Port_SetPort(h)) { console.log('Cannot connect to printer'); process.exit(1); }

let prev = '';
console.log('=== LIVE PRINTER POLL (Ctrl+C to stop) ===');
console.log('Change cover / paper state while this runs\n');

setInterval(() => {
  try {
    const t1 = Buffer.alloc(4, 0); Pos_QueryStstus(t1, 1, 800);
    const t2 = Buffer.alloc(4, 0); Pos_QueryStstus(t2, 2, 800);
    const t4 = Buffer.alloc(4, 0); Pos_QueryStstus(t4, 4, 800);

    const line = `t1=${hb(t1[0])} t2=${hb(t2[0])} t4=${hb(t4[0])}`;
    if (line !== prev) {
      const ts = new Date().toLocaleTimeString();
      const setBits = (b) => [...Array(8)].map((_,i)=>(b>>i)&1?'bit'+i:'').filter(Boolean).join(',') || 'none';
      console.log(`[${ts}] CHANGED: ${line}`);
      console.log(`        t1 bits: [${setBits(t1[0])}]`);
      console.log(`        t2 bits: [${setBits(t2[0])}]`);
      console.log(`        t4 bits: [${setBits(t4[0])}]`);
      console.log('');
      prev = line;
    }
  } catch(e) {
    console.log('Poll error:', e.message);
  }
}, 500);
