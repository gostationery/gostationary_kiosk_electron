#!/usr/bin/env node
/**
 * Copies gostationery_kiosk_frontend/dist → gostationery_kiosk_electron/kiosk-ui
 * Builds the frontend first when dist/ is missing.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

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

function validateBundle(rootDir) {
  const indexPath = path.join(rootDir, 'index.html')
  const html = fs.readFileSync(indexPath, 'utf8')
  const matches = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
  for (const [, assetPath] of matches) {
    const onDisk = path.join(rootDir, assetPath.replace(/^\//, ''))
    if (!fs.existsSync(onDisk)) {
      throw new Error(
        `Missing bundled asset ${assetPath}. Rebuild the frontend (npm run build:kiosk-ui).`,
      )
    }
  }
}

function ensureFrontendBuild() {
  if (fs.existsSync(path.join(srcDist, 'index.html'))) return
  console.log('[sync-kiosk-ui] No frontend dist/ found — running build:kiosk-ui…')
  const result = spawnSync('npm', ['run', 'build:kiosk-ui'], {
    cwd: electronRoot,
    stdio: 'inherit',
    shell: true,
  })
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
  if (!fs.existsSync(path.join(srcDist, 'index.html'))) {
    console.error('[sync-kiosk-ui] Build finished but dist/index.html is still missing.')
    process.exit(1)
  }
}

ensureFrontendBuild()

try {
  validateBundle(srcDist)
} catch (err) {
  console.error(`[sync-kiosk-ui] ${err.message}`)
  process.exit(1)
}

const distMtime = fs.statSync(path.join(srcDist, 'index.html')).mtimeMs
const destIndex = path.join(dest, 'index.html')
const destMtime = fs.existsSync(destIndex) ? fs.statSync(destIndex).mtimeMs : 0
if (destMtime && distMtime > destMtime) {
  console.log('[sync-kiosk-ui] Updating kiosk-ui (frontend build is newer)')
}

rmDir(dest)
copyDir(srcDist, dest)

try {
  validateBundle(dest)
} catch (err) {
  console.error(`[sync-kiosk-ui] ${err.message}`)
  process.exit(1)
}

console.log('[sync-kiosk-ui] Copied', srcDist, '→', dest)
