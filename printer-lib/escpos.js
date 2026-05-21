const ESC = '\x1b'
const GS = '\x1d'

const INIT = ESC + '@'
const ALIGN_LEFT = ESC + 'a' + '\x00'
const ALIGN_CENTER = ESC + 'a' + '\x01'
const ALIGN_RIGHT = ESC + 'a' + '\x02'
const BOLD_ON = ESC + 'E' + '\x01'
const BOLD_OFF = ESC + 'E' + '\x00'
const DOUBLE_SIZE = GS + '!' + '\x11'
/** ~3× width and height (Epson GS !) */
const TRIPLE_SIZE = GS + '!' + '\x22'
const NORMAL_SIZE = GS + '!' + '\x00'
const LINE_FEED = '\n'

/** ESC/POS character scale (1–8). */
function charSize(widthMul = 1, heightMul = 1) {
  const w = Math.min(8, Math.max(1, widthMul)) - 1
  const h = Math.min(8, Math.max(1, heightMul)) - 1
  return GS + '!' + String.fromCharCode((w << 4) | h)
}

/** Full cut — GS V 0 */
const CUT_FULL = GS + 'V' + '\x00'
/** Partial / half cut — GS V 1 */
const CUT_PARTIAL = GS + 'V' + '\x01'
/** Feed n lines then partial cut — GS V 66 n */
function cutPartialFeed(n = 3) {
  return GS + 'V' + '\x42' + String.fromCharCode(Math.min(255, n))
}

function cutCommand(mode, feedLines = 4) {
  const feed = LINE_FEED.repeat(Math.max(0, feedLines))
  switch (String(mode || 'full').toLowerCase()) {
    case 'none':
    case 'off':
      return feed
    case 'partial':
    case 'half':
      return feed + CUT_PARTIAL
    case 'partial_feed':
    case 'half_feed':
      return feed + cutPartialFeed(feedLines)
    case 'full':
    default:
      return feed + CUT_FULL
  }
}

module.exports = {
  ESC,
  GS,
  INIT,
  ALIGN_LEFT,
  ALIGN_CENTER,
  ALIGN_RIGHT,
  BOLD_ON,
  BOLD_OFF,
  DOUBLE_SIZE,
  TRIPLE_SIZE,
  NORMAL_SIZE,
  charSize,
  LINE_FEED,
  CUT_FULL,
  CUT_PARTIAL,
  cutCommand,
  cutPartialFeed,
}
