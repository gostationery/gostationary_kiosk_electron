/**
 * preload.js
 * Exposes window.electronAPI to setup.html and the kiosk web page.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  /** Legacy single receipt print (invoice / one job). */
  print: () => ipcRenderer.invoke('silent-print'),

  /** Register expected token slips before sequential printing. */
  beginTokenPrintJob: (payload) => ipcRenderer.invoke('begin-token-print-job', payload),

  /** Print one slip; returns when the printer callback completes. */
  printSlip: (meta) => ipcRenderer.invoke('print-slip', meta),

  /** Compare manifest vs successfully printed slips. */
  getTokenPrintStatus: (jobId) => ipcRenderer.invoke('get-token-print-status', jobId),

  /** Full setup payload: domain, serial, optional printerName, openAtLogin */
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  getPrinters: () => ipcRenderer.invoke('get-printers'),

  getKioskPrefs: () => ipcRenderer.invoke('get-kiosk-prefs'),

  setPrinter: (printerName) => ipcRenderer.invoke('set-printer', printerName),

  setOpenAtLogin: (open) => ipcRenderer.invoke('set-open-at-login', open),

  /** Query printer status from backend DLL */
  queryPrinterStatus: (printerName) => ipcRenderer.invoke('query-printer-status', printerName),

  /** Optional deviceName; falls back to saved or first physical printer */
  testPrint: (deviceName) => ipcRenderer.invoke('test-print', deviceName),

  /** Kiosk UI: activity ping so idle hard-refresh does not interrupt checkout */
  notifyKioskActivity: () => ipcRenderer.invoke('notify-kiosk-activity'),

  /** Print a complete HTML string from an offscreen window — for form receipts. */
  printHtml: (htmlContent) => ipcRenderer.invoke('print-html', htmlContent),
})
