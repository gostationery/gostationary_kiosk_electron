/**
 * pairing-reset-preload.js
 * Exposes window.pairingResetAPI to pairing-reset-confirm.html only.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pairingResetAPI', {
  timeoutSeconds: Number(process.argv.find((a) => a.startsWith('--pairing-reset-timeout-s='))?.split('=')[1] || 20),
  respond: (confirmed) => ipcRenderer.send('pairing-reset:response', confirmed),
})
