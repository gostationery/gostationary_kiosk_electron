/**
 * Serves the bundled kiosk SPA (same UI as the web kiosk) for Electron.
 * SPA fallback: unknown paths → index.html (TanStack Router client routes).
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
}

function safeResolve(rootDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const rel = decoded.replace(/^\/+/, '') || 'index.html'
  const abs = path.resolve(rootDir, rel)
  if (!abs.startsWith(path.resolve(rootDir))) return null
  return abs
}

function createKioskStaticServer(rootDir, options = {}) {
  const root = path.resolve(rootDir)
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(
      `Kiosk UI not found at ${root}. Run: npm run sync:kiosk-ui (after building the frontend).`,
    )
  }

  const host = options.host || '127.0.0.1'

  const server = http.createServer((req, res) => {
    const urlPath = req.url || '/'
    let filePath = safeResolve(root, urlPath)

    const sendFile = (fp) => {
      const ext = path.extname(fp).toLowerCase()
      const type = MIME[ext] || 'application/octet-stream'
      fs.readFile(fp, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'no-store',
        })
        res.end(data)
      })
    }

    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      sendFile(filePath)
      return
    }

    const indexPath = path.join(root, 'index.html')
    sendFile(indexPath)
  })

  function listen(preferredPort) {
    return new Promise((resolve, reject) => {
      const tryPort = (port, attemptsLeft) => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
            tryPort(port + 1, attemptsLeft - 1)
            return
          }
          reject(err)
        })
        server.listen(port, host, () => {
          server.removeAllListeners('error')
          resolve({ port, host, origin: `http://${host}:${port}` })
        })
      }
      tryPort(preferredPort, 20)
    })
  }

  function close() {
    return new Promise((resolve) => {
      server.close(() => resolve())
    })
  }

  return { listen, close, root }
}

module.exports = { createKioskStaticServer, KIOSK_UI_DIR: path.join(__dirname, 'kiosk-ui') }
