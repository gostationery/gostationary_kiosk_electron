/**
 * kiosk-config-store.js
 *
 * Single source of truth for reading/writing kiosk-config.json safely.
 * Both main.js (pairing/setup) and printer-monitor.js (print stats) write
 * to this same file, and a kiosk can lose power at any moment — so every
 * write here goes through the same atomic tmp-file+rename with an fsync,
 * plus a .bak of the last known-good file, so a power cut mid-write can
 * never truncate/corrupt it. Keeping this logic in one place means a future
 * fix only needs to happen once instead of drifting between callers.
 */

const fs = require('fs')
const path = require('path')

function createConfigStore(configPath, log = () => {}) {
  const CONFIG_PATH = configPath
  const BACKUP_PATH = configPath + '.bak'
  const TMP_PATH = configPath + '.tmp'

  function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  }

  /** Reads the config, falling back to the .bak copy if the primary is corrupt. */
  function load() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        return readJson(CONFIG_PATH)
      }
    } catch (err) {
      log('kiosk-config-store: primary config is corrupt, trying backup', { error: String(err) })
      try {
        if (fs.existsSync(BACKUP_PATH)) {
          const cfg = readJson(BACKUP_PATH)
          log('kiosk-config-store: recovered config from backup')
          return cfg
        }
      } catch (backupErr) {
        log('kiosk-config-store: backup config is also corrupt', { error: String(backupErr) })
      }
    }
    return null
  }

  /**
   * Writes via temp file + fsync + rename (atomic on the same volume), and
   * refreshes the .bak copy from the previous good file first.
   */
  function save(cfg) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    const json = JSON.stringify(cfg, null, 2)

    if (fs.existsSync(CONFIG_PATH)) {
      try {
        fs.copyFileSync(CONFIG_PATH, BACKUP_PATH)
      } catch (err) {
        log('kiosk-config-store: failed to update backup', { error: String(err) })
      }
    }

    const fd = fs.openSync(TMP_PATH, 'w')
    try {
      fs.writeFileSync(fd, json)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(TMP_PATH, CONFIG_PATH)
  }

  /** Read-modify-write convenience: mutator receives a copy of the current config (or {}), returns the config to persist. */
  function update(mutator) {
    const prev = load() || {}
    const next = mutator({ ...prev })
    save(next)
    return next
  }

  /** Deletes both the primary and backup files (used on pairing reset). */
  function clear() {
    try { fs.unlinkSync(CONFIG_PATH) } catch { }
    try { fs.unlinkSync(BACKUP_PATH) } catch { }
  }

  return { load, save, update, clear, CONFIG_PATH, BACKUP_PATH }
}

module.exports = { createConfigStore }
