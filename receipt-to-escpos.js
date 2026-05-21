/**
 * POS printer: CUPS-matched receipt → ESC/POS (printToPDF when sharp works;
 * print-media capture + jimp on Windows / when sharp native binary is missing).
 */

const fs = require('fs')
const fsPromises = require('fs/promises')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { promisify } = require('util')
const {
  measureContentHeightMicrons,
  receiptPrintToPdfOptions,
  receiptWidthDots,
} = require('./receipt-cups-layout')

const execFileAsync = promisify(execFile)

function loadPrinterLib(name) {
  const bundled = path.join(__dirname, 'printer-lib', name)
  if (fs.existsSync(`${bundled}.js`)) {
    return require(bundled)
  }
  return require(
    path.join(__dirname, '..', 'gostationary_kiosk_printer_communication', 'src', name),
  )
}

const { cutCommand } = loadPrinterLib('escpos')
const { buildPrintPayloadFromImage, getSharp } = loadPrinterLib('image-to-escpos')

function getPngResize() {
  try {
    return require('./printer-lib/png-resize')
  } catch {
    return null
  }
}

async function resizePngBuffer(pngBuffer, widthPx) {
  const sharp = getSharp()
  if (sharp) {
    try {
      return sharp(pngBuffer)
        .resize(widthPx, null, {
          fit: 'inside',
          withoutEnlargement: false,
          kernel: sharp.kernel.lanczos3,
        })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer()
    } catch {
      /* fall through */
    }
  }
  const pngResize = getPngResize()
  if (pngResize) {
    return pngResize.resizePngBuffer(pngBuffer, widthPx)
  }
  return pngBuffer
}

async function waitForReceiptPaint(webContents) {
  try {
    await webContents.executeJavaScript(`(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    }))()`)
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 100))
}

async function getReceiptCaptureRect(webContents) {
  return webContents.executeJavaScript(`(() => {
    const el = document.getElementById('kiosk-receipt-root')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const w = Math.ceil(r.width)
    const h = Math.ceil(r.height)
    if (w < 1 || h < 1) return null
    return {
      x: Math.max(0, Math.floor(r.x)),
      y: Math.max(0, Math.floor(r.y)),
      width: w,
      height: h,
    }
  })()`)
}

/**
 * Windows-safe: @media print + capturePage (no sharp / no PDF raster).
 */
async function renderReceiptPngViaPrintMedia(webContents, options = {}) {
  const widthPx = options.widthPx ?? receiptWidthDots(options.dpi)
  await waitForReceiptPaint(webContents)
  let restored = false
  try {
    if (typeof webContents.emulateMediaType === 'function') {
      await webContents.emulateMediaType('print')
    }
    await waitForReceiptPaint(webContents)
    const rect = await getReceiptCaptureRect(webContents)
    if (!rect) {
      throw new Error('no-receipt-dom')
    }
    const image = await webContents.capturePage(rect)
    if (!image || image.isEmpty()) {
      throw new Error('receipt capture failed')
    }
    const png = image.toPNG()
    return resizePngBuffer(png, widthPx)
  } finally {
    if (!restored && typeof webContents.emulateMediaType === 'function') {
      await webContents.emulateMediaType('screen').catch(() => {})
      restored = true
    }
  }
}

async function renderReceiptPdfLikeCups(webContents) {
  await waitForReceiptPaint(webContents)
  const heightMicrons = await measureContentHeightMicrons(webContents)
  const pdfOpts = receiptPrintToPdfOptions(heightMicrons)
  const data = await webContents.printToPDF(pdfOpts)
  return Buffer.isBuffer(data) ? data : Buffer.from(data)
}

async function pdfToPngViaPoppler(pdfBuffer, widthPx, dpi) {
  const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gs-receipt-'))
  const pdfPath = path.join(tmp, 'receipt.pdf')
  const outBase = path.join(tmp, 'page')
  try {
    await fsPromises.writeFile(pdfPath, pdfBuffer)
    await execFileAsync('pdftoppm', [
      '-png',
      '-r',
      String(dpi),
      '-singlefile',
      pdfPath,
      outBase,
    ])
    const pngPath = `${outBase}.png`
    const raw = await fsPromises.readFile(pngPath)
    return resizePngBuffer(raw, widthPx)
  } finally {
    await fsPromises.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

async function pdfBufferToReceiptPng(pdfBuffer, options = {}) {
  const widthPx = options.widthPx ?? receiptWidthDots(options.dpi)
  const dpi = options.dpi ?? 203
  const sharp = getSharp()

  if (sharp) {
    try {
      return await sharp(pdfBuffer, { density: dpi, page: 0 })
        .resize(widthPx, null, {
          fit: 'inside',
          withoutEnlargement: false,
          kernel: sharp.kernel.lanczos3,
        })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer()
    } catch {
      /* poppler or print-media fallback */
    }
  }

  if (process.platform === 'win32') {
    throw new Error('PDF raster needs sharp on Windows — use print-media fallback')
  }

  try {
    return await pdfToPngViaPoppler(pdfBuffer, widthPx, dpi)
  } catch (popplerErr) {
    throw new Error(
      `PDF to PNG failed. Install poppler-utils or rebuild with sharp. ${popplerErr.message}`,
    )
  }
}

/**
 * Prefer printToPDF (matches CUPS) when sharp works; else print-media capture.
 */
async function renderReceiptPngLikeCups(webContents, options = {}) {
  if (!getSharp() || process.platform === 'win32') {
    return renderReceiptPngViaPrintMedia(webContents, options)
  }
  try {
    const pdf = await renderReceiptPdfLikeCups(webContents)
    return pdfBufferToReceiptPng(pdf, options)
  } catch (err) {
    console.warn('[receipt-to-escpos] PDF path failed, using print-media:', err.message)
    return renderReceiptPngViaPrintMedia(webContents, options)
  }
}

async function buildEscPosFromWebContents(webContents, options = {}) {
  const png = await renderReceiptPngLikeCups(webContents, {
    widthPx: options.widthPx,
    dpi: options.dpi ?? 203,
  })

  const { payload } = await buildPrintPayloadFromImage(png, {
    widthPx: options.widthPx ?? receiptWidthDots(options.dpi),
    threshold: options.threshold ?? 155,
    dither: options.dither !== false,
    maxSliceHeight: options.maxSliceHeight ?? 2400,
  })

  const cut = options.cut ?? 'full'
  const feed = options.feedLinesBeforeCut ?? 4
  return Buffer.concat([
    payload,
    Buffer.from(cutCommand(cut, feed), 'binary'),
  ])
}

module.exports = {
  buildEscPosFromWebContents,
  renderReceiptPngLikeCups,
  renderReceiptPngViaPrintMedia,
  renderReceiptPdfLikeCups,
  receiptWidthDots,
}
