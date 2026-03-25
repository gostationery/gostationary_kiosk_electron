/**
 * preload.js
 * Runs in the renderer process with access to both Node.js and the DOM.
 * contextBridge.exposeInMainWorld makes these APIs available as
 * window.electronAPI inside the kiosk web page.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Called by the kiosk React app on order success.
   * Triggers a silent print on the desktop app using the default printer
   * (set via OS / browser kiosk config – avoids the PDF dialog).
   */
  print: () => ipcRenderer.invoke('silent-print'),

  /**
   * Fetch physical printers for the setup screen dropdown.
   */
  getPrinters: () => ipcRenderer.invoke('get-printers'),

  /**
   * Print a known test receipt using the selected printer name.
   * Pass '' to use OS default.
   */
  printTestPage: (deviceName) => ipcRenderer.invoke('print-test-page', { deviceName }),

  /**
   * Called by setup.html after the user enters org domain + serial.
   */
  saveConfig: (domain, serial, printerName = '') =>
    ipcRenderer.invoke('save-config', { domain, serial, printerName }),
})
