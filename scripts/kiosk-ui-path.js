/**
 * Resolves bundled kiosk UI directory (handles root-owned kiosk-ui from sudo runs).
 */

const fs = require('fs')
const path = require('path')

const MARKER_FILE = '.kiosk-ui-active'
const FALLBACK_DIR = 'kiosk-ui.next'
const PRIMARY_DIR = 'kiosk-ui'

function readActiveName(electronRoot) {
  const marker = path.join(electronRoot, MARKER_FILE)
  if (!fs.existsSync(marker)) return null
  const name = fs.readFileSync(marker, 'utf8').trim()
  return name || null
}

function writeActiveName(electronRoot, dirName) {
  fs.writeFileSync(
    path.join(electronRoot, MARKER_FILE),
    `${dirName}\n`,
    'utf8',
  )
}

/** @param {string} [electronRoot] */
function resolveKioskUiDir(electronRoot = path.join(__dirname, '..')) {
  const names = []
  const active = readActiveName(electronRoot)
  if (active) names.push(active)
  if (!names.includes(FALLBACK_DIR)) names.push(FALLBACK_DIR)
  if (!names.includes(PRIMARY_DIR)) names.push(PRIMARY_DIR)

  for (const name of names) {
    const dir = path.join(electronRoot, name)
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir
  }
  return path.join(electronRoot, PRIMARY_DIR)
}

module.exports = {
  MARKER_FILE,
  FALLBACK_DIR,
  PRIMARY_DIR,
  readActiveName,
  writeActiveName,
  resolveKioskUiDir,
}
