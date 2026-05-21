/**
 * Shared receipt page layout — must stay in sync with CUPS silent print (main.js).
 * POS raster path uses the same dimensions via printToPDF.
 */

/** CSS reference px → microns (1px = 1/96 in at 96dpi). */
const CSS_PX_TO_MICRONS = (25.4 / 96) * 1000
const RECEIPT_WIDTH_MICRONS = 80000 // 80 mm roll
const PAGE_HEIGHT_BUFFER_MICRONS = 4000
const PAGE_HEIGHT_MIN_MICRONS = 353
const PAGE_HEIGHT_MAX_MICRONS = 3_000_000

const RECEIPT_PAGE_WIDTH_MM = 80
const THERMAL_DPI = 203

function clampPageHeightMicrons(m) {
  const n = Number(m)
  if (!Number.isFinite(n)) return 150_000
  return Math.round(
    Math.min(PAGE_HEIGHT_MAX_MICRONS, Math.max(PAGE_HEIGHT_MIN_MICRONS, n)),
  )
}

function receiptWidthDots(dpi = THERMAL_DPI) {
  return Math.round((RECEIPT_PAGE_WIDTH_MM / 25.4) * dpi)
}

/** Height in microns from #kiosk-receipt-root (same script as CUPS). */
async function measureContentHeightMicrons(webContents) {
  try {
    const raw = await webContents.executeJavaScript(`(() => {
      const kiosk = document.getElementById('kiosk-receipt-root')
      const el = kiosk || document.body
      if (!el) return 150000
      const h = Math.ceil(
        Math.max(
          1,
          el.scrollHeight,
          el.getBoundingClientRect().height,
          document.documentElement.scrollHeight,
        ),
      )
      return Math.round(h * ${CSS_PX_TO_MICRONS}) + ${PAGE_HEIGHT_BUFFER_MICRONS}
    })()`)
    return clampPageHeightMicrons(raw)
  } catch {
    return clampPageHeightMicrons(150_000)
  }
}

/** Options for webContents.print() — CUPS driver path. */
function receiptPrintOptions(deviceName, heightMicrons) {
  const h = clampPageHeightMicrons(heightMicrons)
  return {
    silent: true,
    printBackground: false,
    deviceName: deviceName || '',
    margins: {
      marginType: 'custom',
      top: 0.1,
      bottom: 0.1,
      left: 0.1,
      right: 0.1,
    },
    pageSize: { width: RECEIPT_WIDTH_MICRONS, height: h },
  }
}

/** Same page + margins as CUPS, for printToPDF (POS ESC/POS raster). */
function receiptPrintToPdfOptions(heightMicrons) {
  const h = clampPageHeightMicrons(heightMicrons)
  return {
    printBackground: false,
    margins: {
      marginType: 'custom',
      top: 0.1,
      bottom: 0.1,
      left: 0.1,
      right: 0.1,
    },
    pageSize: { width: RECEIPT_WIDTH_MICRONS, height: h },
    preferCSSPageSize: false,
    landscape: false,
  }
}

module.exports = {
  CSS_PX_TO_MICRONS,
  RECEIPT_WIDTH_MICRONS,
  RECEIPT_PAGE_WIDTH_MM,
  THERMAL_DPI,
  clampPageHeightMicrons,
  measureContentHeightMicrons,
  receiptPrintOptions,
  receiptPrintToPdfOptions,
  receiptWidthDots,
}
