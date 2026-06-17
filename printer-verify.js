// Verify the new bit logic against real printer bytes
// Run: node printer-verify.js

const koffi = require('koffi');

const DLL_PATH = 'C:\\gost-printer\\CsnPrinterLibs.dll';
const DEV_PATH = '\\\\?\\usb#vid_0fe6&pid_811e#7666697e0b39#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}';

function classify(t1, t4) {
  if (t1 === 0x00) return 'OFF';
  if ((t1 & 0x60) && (t4 & 0x04)) return 'COVER_OPEN';
  if ((t4 & 0x60) || (t1 & 0x60))  return 'PAPER_OUT';
  if (t1 & 0x08)                    return 'NEAR_END';
  return 'READY';
}

// Replay all states captured from live session
const cases = [
  { label: 'LOW PAPER, cover closed (initial)',  t1: 0x1e, t4: 0x12 },
  { label: 'Cover opening - path sensor fires',   t1: 0x1e, t4: 0x16 },
  { label: 'Cover open (low paper) - settling',   t1: 0x1e, t4: 0x76 },
  { label: 'Cover open (low paper) - stable',     t1: 0x7e, t4: 0x76 },
  { label: 'Cover open (low paper) - alternate',  t1: 0x7e, t4: 0x56 },
  { label: 'Cover closing - t1 clears first',     t1: 0x1e, t4: 0x52 },
  { label: 'Cover closing - almost done',         t1: 0x1e, t4: 0x12 },
  { label: 'READY state (full paper, cover closed)', t1: 0x12, t4: 0x12 },
  { label: 'Cover opening (full paper)',           t1: 0x12, t4: 0x56 },
  { label: 'Cover opening (full paper) step2',    t1: 0x12, t4: 0x76 },
  { label: 'Cover open (full paper)',              t1: 0x72, t4: 0x76 },
  { label: 'Cover open (full paper) alt1',        t1: 0x72, t4: 0x72 },
  { label: 'Cover open (full paper) alt2',        t1: 0x7e, t4: 0x76 },
  { label: 'Cover closing (full paper)',           t1: 0x72, t4: 0x56 },
  { label: 'Cover closing - t1 drops',            t1: 0x12, t4: 0x56 },
  { label: 'Cover closing - t4 residual',         t1: 0x12, t4: 0x52 },
  { label: 'LOW PAPER returns after close',       t1: 0x1e, t4: 0x52 },
  { label: 'LOW PAPER stable again',              t1: 0x1e, t4: 0x12 },
];

console.log('\n=== STATUS VERIFICATION ===\n');
console.log('t1      t4      RESULT         STATE LABEL');
console.log('------  ------  -------------  ----------------------');
let allOk = true;
for (const c of cases) {
  const result = classify(c.t1, c.t4);
  // Mark transition states separately (brief flickers during open/close)
  const transition = c.label.includes('opening') || c.label.includes('closing') || c.label.includes('settling') || c.label.includes('residual') || c.label.includes('clears');
  const mark = transition ? '~ ' : '  ';
  console.log(
    `0x${c.t1.toString(16).padStart(2,'0')}    0x${c.t4.toString(16).padStart(2,'0')}    ${(mark + result).padEnd(15)} ${c.label}`
  );
}

console.log('\nNow reading LIVE from printer...\n');

try {
  const lib = koffi.load(DLL_PATH);
  const Port_OpenUSBIO  = lib.func('__stdcall', 'Port_OpenUSBIO',  'void *', ['str']);
  const Port_SetPort    = lib.func('__stdcall', 'Port_SetPort',    'bool',   ['void *']);
  const Port_ClosePort  = lib.func('__stdcall', 'Port_ClosePort',  'void',   ['void *']);
  const Pos_QueryStstus = lib.func('__stdcall', 'Pos_QueryStstus', 'bool',   ['uint8 *', 'int', 'uint32']);

  const h = Port_OpenUSBIO(DEV_PATH);
  if (!h || !Port_SetPort(h)) { console.log('Cannot connect'); process.exit(1); }

  const t1 = Buffer.alloc(4); Pos_QueryStstus(t1, 1, 1500);
  const t2 = Buffer.alloc(4); Pos_QueryStstus(t2, 2, 1500);
  const t4 = Buffer.alloc(4); Pos_QueryStstus(t4, 4, 1500);
  Port_ClosePort(h);

  const status = classify(t1[0], t4[0]);
  console.log(`t1=0x${t1[0].toString(16).padStart(2,'0')} t2=0x${t2[0].toString(16).padStart(2,'0')} t4=0x${t4[0].toString(16).padStart(2,'0')}`);
  console.log(`\n>>> CURRENT STATUS: ${status} <<<\n`);
} catch(e) {
  console.error('Live read error:', e.message);
}
