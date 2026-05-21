#!/usr/bin/env node
/**
 * Copies gostationary_kiosk_frontend/dist → gostationary_kiosk_electron/kiosk-ui
 */

const fs = require('fs')
const path = require('path')

const electronRoot = path.join(__dirname, '..')
const srcDist = path.join(electronRoot, '..', 'gostationary_kiosk_frontend', 'dist')
const dest = path.join(electronRoot, 'kiosk-ui')

function isEacces(err) {
  return err && (err.code === 'EACCES' || err.code === 'EPERM')
}

function chownHint() {
  const user = process.env.USER || process.env.LOGNAME || 'your-user'
  return (
    `Fix ownership (often caused by running a build with sudo):\n` +
    `  sudo chown -R ${user}:${user} "${dest}"`
  )
}

function rmPath(target) {
  if (!fs.existsSync(target)) return
  const stat = fs.lstatSync(target)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      rmPath(path.join(target, name))
    }
    fs.rmdirSync(target)
  } else {
    fs.unlinkSync(target)
  }
}

function rmDir(dir) {
  if (!fs.existsSync(dir)) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    if (!isEacces(err)) throw err
    const err2 = new Error(
      `Cannot remove "${dir}" (${err.code}). ${chownHint()}`,
    )
    err2.cause = err
    throw err2
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name)
    const d = path.join(dst, name)
    if (fs.statSync(s).isDirectory()) {
      copyDir(s, d)
    } else {
      try {
        fs.copyFileSync(s, d)
      } catch (err) {
        if (!isEacces(err)) throw err
        const err2 = new Error(
          `Cannot write "${d}" (${err.code}). ${chownHint()}`,
        )
        err2.cause = err
        throw err2
      }
    }
  }
}

/** Merge sync when full replace is not possible (mixed root-owned files). */
function mergeCopyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  const srcNames = new Set(fs.readdirSync(src))

  for (const name of srcNames) {
    const s = path.join(src, name)
    const d = path.join(dst, name)
    if (fs.statSync(s).isDirectory()) {
      mergeCopyDir(s, d)
    } else {
      fs.copyFileSync(s, d)
    }
  }

  for (const name of fs.readdirSync(dst)) {
    if (srcNames.has(name)) continue
    const orphan = path.join(dst, name)
    try {
      rmPath(orphan)
    } catch (err) {
      if (isEacces(err)) {
        console.warn(
          `[sync-kiosk-ui] Skipping remove (permission denied): ${orphan}`,
        )
      } else {
        throw err
      }
    }
  }
}

if (!fs.existsSync(path.join(srcDist, 'index.html'))) {
  console.error(
    '[sync-kiosk-ui] Missing frontend build. From gostationary_kiosk_frontend run:\n' +
      '  pnpm install && pnpm run build\n' +
      'Or from electron: npm run build:kiosk-ui',
  )
  process.exit(1)
}

try {
  rmDir(dest)
  copyDir(srcDist, dest)
  console.log('[sync-kiosk-ui] Copied', srcDist, '→', dest)
} catch (err) {
  if (!isEacces(err) && !(err.cause && isEacces(err.cause))) {
    console.error('[sync-kiosk-ui]', err.message || err)
    process.exit(1)
  }
  console.warn('[sync-kiosk-ui] Full replace failed, merging into existing kiosk-ui…')
  console.warn(err.message || err)
  try {
    mergeCopyDir(srcDist, dest)
    console.log('[sync-kiosk-ui] Merged', srcDist, '→', dest)
    console.warn(
      '[sync-kiosk-ui] Run chown if warnings persist:\n' +
        `  sudo chown -R ${process.env.USER || 'you'}:${process.env.USER || 'you'} "${dest}"`,
    )
  } catch (mergeErr) {
    console.error('[sync-kiosk-ui]', mergeErr.message || mergeErr)
    process.exit(1)
  }
}
