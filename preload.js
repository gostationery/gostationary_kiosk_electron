/**
 * preload.js
 * Exposes window.electronAPI to setup.html and the kiosk web page.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  print: () => ipcRenderer.invoke('silent-print'),

  /** Full setup payload: domain, serial, optional printerName, openAtLogin */
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  getPrinters: () => ipcRenderer.invoke('get-printers'),

  getKioskPrefs: () => ipcRenderer.invoke('get-kiosk-prefs'),

  setPrinter: (printerName) => ipcRenderer.invoke('set-printer', printerName),

  setOpenAtLogin: (open) => ipcRenderer.invoke('set-open-at-login', open),

  /** Optional deviceName; falls back to saved or first physical printer */
  testPrint: (deviceName) => ipcRenderer.invoke('test-print', deviceName),
})
