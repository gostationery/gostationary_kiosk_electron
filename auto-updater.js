/**
 * Silent auto-update via GitHub Releases (electron-updater).
 * Linux: .deb (Ubuntu, Raspberry Pi OS) and .rpm (Fedora) — not AppImage.
 */

const { app } = require('electron')
const path = require('path')

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours
const INITIAL_DELAY_MS = 30 * 1000 // let kiosk UI settle after boot

let checkTimer = null

function setupLogger(autoUpdater) {
  try {
    const log = require('electron-log')
    log.transports.file.level = 'info'
    log.transports.file.resolvePathFn = () =>
      path.join(app.getPath('userData'), 'logs', 'updater.log')
    autoUpdater.logger = log
    return log
  } catch {
    return null
  }
}

function initAutoUpdater() {
  if (!app.isPackaged) return null

  const { autoUpdater } = require('electron-updater')

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.allowDowngrade = false

  const log = setupLogger(autoUpdater)

  autoUpdater.on('checking-for-update', () => {
    log?.info('[updater] Checking for updates…')
  })

  autoUpdater.on('update-available', (info) => {
    log?.info('[updater] Update available:', info.version)
  })

  autoUpdater.on('update-not-available', (info) => {
    log?.info('[updater] Up to date:', info.version)
  })

  autoUpdater.on('download-progress', (p) => {
    log?.info(
      `[updater] Download ${Math.round(p.percent)}% (${p.transferred}/${p.total})`,
    )
  })

  autoUpdater.on('update-downloaded', (info) => {
    log?.info(
      '[updater] Downloaded',
      info.version,
      '— will install silently on next app quit/restart',
    )
  })

  autoUpdater.on('error', (err) => {
    log?.error('[updater] Error:', err?.message || err)
  })

  const runCheck = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      log?.error('[updater] checkForUpdates failed:', err?.message || err)
    })
  }

  setTimeout(runCheck, INITIAL_DELAY_MS)
  checkTimer = setInterval(runCheck, CHECK_INTERVAL_MS)

  app.on('will-quit', () => {
    if (checkTimer) clearInterval(checkTimer)
  })

  return autoUpdater
}

module.exports = { initAutoUpdater }
