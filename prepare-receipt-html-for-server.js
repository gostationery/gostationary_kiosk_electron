/**
 * Normalize receipt HTML for the printer server (CUPS-aligned layout + larger type).
 * CUPS printing in Electron is unchanged.
 */

const RECEIPT_CONTENT_WIDTH_MM = 72
const RECEIPT_PAGE_WIDTH_MM = 80
const RECEIPT_LAYOUT_VIEWPORT_PX = 420
/** Match gostationary_kiosk_printer_communication/src/receipt-layout.js */
const RECEIPT_FONT_SCALE = 1.55
const RECEIPT_BASE_FONT_PX = 22

function buildCupsLayoutStyle(options = {}) {
  const fontScale = options.fontScale ?? RECEIPT_FONT_SCALE
  const basePx = options.baseFontPx ?? RECEIPT_BASE_FONT_PX
  return `<style id="gostationary-server-print">
html, body {
  margin: 0 !important;
  padding: 0 !important;
  width: ${RECEIPT_LAYOUT_VIEWPORT_PX}px !important;
  max-width: ${RECEIPT_LAYOUT_VIEWPORT_PX}px !important;
  background: #fff !important;
  color: #000 !important;
  font-size: ${basePx}px !important;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
#kiosk-receipt-root {
  width: ${RECEIPT_CONTENT_WIDTH_MM}mm !important;
  max-width: ${RECEIPT_PAGE_WIDTH_MM}mm !important;
  margin: 0 auto !important;
  box-sizing: border-box !important;
  background: #fff !important;
  color: #000 !important;
  font-size: ${basePx}px !important;
  zoom: ${fontScale} !important;
}
#kiosk-receipt-root img {
  max-width: 100% !important;
  height: auto !important;
}
</style>`
}

/**
 * @param {string} html
 * @returns {string}
 */
function prepareReceiptHtmlForServer(html, options = {}) {
  const raw = String(html || '').trim()
  if (!raw) return raw

  const overrideStyle = buildCupsLayoutStyle(options)
  const isFullDoc = /^\s*<!DOCTYPE|^\s*<html/i.test(raw)

  if (isFullDoc) {
    if (/<\/head>/i.test(raw)) {
      return raw.replace(/<\/head>/i, `${overrideStyle}\n</head>`)
    }
    if (/<body[^>]*>/i.test(raw)) {
      return raw.replace(/<body[^>]*>/i, (m) => `${m}\n${overrideStyle}`)
    }
    return `${overrideStyle}\n${raw}`
  }

  const rootOpen = '<' + 'div id="kiosk-receipt-root">'
  const rootClose = '</' + 'div>'
  const body = /id=["']kiosk-receipt-root["']/i.test(raw)
    ? raw
    : rootOpen + raw + rootClose

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
${overrideStyle}
</head>
<body>
${body}
</body>
</html>`
}

module.exports = {
  prepareReceiptHtmlForServer,
  RECEIPT_FONT_SCALE,
  RECEIPT_BASE_FONT_PX,
}
