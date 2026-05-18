#!/usr/bin/env node
/**
 * Copies gostationary_kiosk_frontend/dist → gostationary_kiosk_electron/kiosk-ui
 */

const fs = require('fs')
const path = require('path')

const electronRoot = path.join(__dirname, '..')
const srcDist = path.join(electronRoot, '..', 'gostationary_kiosk_frontend', 'dist')
const dest = path.join(electronRoot, 'kiosk-ui')

function rmDir(dir) {
  if (!fs.existsSync(dir)) return
  fs.rmSync(dir, { recursive: true, force: true })
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name)
    const d = path.join(dst, name)
    if (fs.statSync(s).isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
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

rmDir(dest)
copyDir(srcDist, dest)
console.log('[sync-kiosk-ui] Copied', srcDist, '→', dest)
