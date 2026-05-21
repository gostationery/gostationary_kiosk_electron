const cheerio = require('cheerio')
const {
  ALIGN_LEFT,
  ALIGN_CENTER,
  ALIGN_RIGHT,
  BOLD_ON,
  BOLD_OFF,
  DOUBLE_SIZE,
  TRIPLE_SIZE,
  NORMAL_SIZE,
  LINE_FEED,
} = require('./escpos')

function wrapLine(text, width) {
  const lines = []
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ')
  let line = ''
  for (const w of words) {
    if (!w) continue
    if ((line + ' ' + w).trim().length <= width) {
      line = (line ? line + ' ' : '') + w
    } else {
      if (line) lines.push(line)
      line = w.length > width ? w.slice(0, width) : w
    }
  }
  if (line) lines.push(line)
  return lines
}

function parseFontSizePx(style = '') {
  const m = String(style).match(/font-size:\s*([\d.]+)px/i)
  return m ? parseFloat(m[1]) : null
}

function parseTextAlign(style = '') {
  const s = String(style).toLowerCase()
  if (s.includes('text-align:center')) return ALIGN_CENTER
  if (s.includes('text-align:right')) return ALIGN_RIGHT
  return null
}

function styleToPrintOpts(style = '', baseWidth = 48) {
  const px = parseFontSizePx(style)
  const align = parseTextAlign(style) || ALIGN_CENTER
  const opts = { align }

  if (px != null && px >= 40) {
    opts.triple = true
    opts.bold = true
    opts.width = Math.max(16, Math.floor(baseWidth / 3))
  } else if (px != null && px >= 28) {
    opts.double = true
    opts.bold = true
    opts.width = Math.max(24, Math.floor(baseWidth / 2))
  } else if (px != null && px >= 18) {
    opts.double = true
    opts.width = Math.max(24, Math.floor(baseWidth / 2))
  } else if (px != null && px >= 15) {
    opts.bold = true
    opts.width = baseWidth
  } else if (String(style).includes('font-weight:900') || String(style).includes('font-weight: 900')) {
    opts.bold = true
    opts.width = baseWidth
  } else {
    opts.width = baseWidth
  }

  return opts
}

function isFlexRow($el) {
  const style = ($el.attr('style') || '').toLowerCase()
  return style.includes('display:flex') || style.includes('display: flex')
}

function printFlexRow($, el, writeln, width) {
  const cells = []
  $(el)
    .children()
    .each((_, child) => {
      const t = $(child).text().replace(/\s+/g, ' ').trim()
      if (t) cells.push(t)
    })
  if (cells.length === 0) return
  if (cells.length === 1) {
    writeln(cells[0])
    return
  }
  const style = ($(el).attr('style') || '').toLowerCase()
  if (style.includes('space-between') && cells.length === 2) {
    const [left, right] = cells
    const gap = Math.max(1, width - left.length - right.length)
    writeln(left + ' '.repeat(gap) + right, { width })
    return
  }
  writeln(cells.join('  '), { width })
}

function isSeparatorBorder(style = '') {
  const s = String(style).toLowerCase()
  return s.includes('border-top') || s.includes('border-bottom')
}

function htmlToEscPos(html, options = {}) {
  const width = options.widthChars || 42
  const boldHeaders = options.boldHeaders !== false
  const $ = cheerio.load(html, { decodeEntities: true })
  let out = ''
  let align = ALIGN_LEFT

  function writeln(text, opts = {}) {
    const t = String(text || '').trim()
    const lineWidth = opts.width || width
    if (!t) {
      out += LINE_FEED
      return
    }
    if (opts.align) out += opts.align
    if (opts.bold) out += BOLD_ON
    if (opts.triple) out += TRIPLE_SIZE
    else if (opts.double) out += DOUBLE_SIZE
    for (const line of wrapLine(t, lineWidth)) {
      out += line + LINE_FEED
    }
    if (opts.triple || opts.double) out += NORMAL_SIZE
    if (opts.bold) out += BOLD_OFF
    if (opts.align) out += ALIGN_LEFT
  }

  function walk(el) {
    if (!el || el.type === 'root') {
      $(el)
        .children()
        .each((_, child) => walk(child))
      return
    }

    if (el.type === 'text') {
      const t = $(el).text()
      if (t.trim()) writeln(t)
      return
    }

    if (el.type !== 'tag') return
    const tag = el.name?.toLowerCase()
    const $el = $(el)
    const style = ($el.attr('style') || '').toLowerCase()

    if (tag === 'img') {
      const alt = $el.attr('alt')
      if (alt) writeln(alt, { align: ALIGN_CENTER, bold: true })
      return
    }

    if (tag === 'br') {
      out += LINE_FEED
      return
    }

    if (tag === 'hr' || (tag === 'div' && isSeparatorBorder(style))) {
      const ch = style.includes('dashed') ? '-' : '='
      writeln(ch.repeat(Math.min(width, 42)), { align: ALIGN_CENTER })
      return
    }

    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
      writeln($el.text(), {
        align: ALIGN_CENTER,
        bold: boldHeaders,
        double: tag === 'h1' || tag === 'h2',
        width: Math.floor(width / 2),
      })
      return
    }

    if (['p', 'div', 'section', 'article', 'span'].includes(tag)) {
      if (tag === 'span' && $el.children().length > 0) {
        $el.children().each((_, child) => walk(child))
        return
      }

      if (isFlexRow($el)) {
        printFlexRow($, el, writeln, width)
        out += LINE_FEED
        return
      }

      const childTags = $el.children().filter((_, c) => c.type === 'tag')
      if (childTags.length === 0) {
        const text = $el.text().replace(/\s+/g, ' ').trim()
        if (text) {
          const opts = styleToPrintOpts($el.attr('style') || '', width)
          if (!opts.align || parseTextAlign($el.attr('style') || '')) {
            opts.align = parseTextAlign($el.attr('style') || '') || opts.align
          }
          writeln(text, opts)
        }
        return
      }

      const textAlign = parseTextAlign(style)
      const prev = align
      if (textAlign) align = textAlign
      $el.contents().each((_, child) => walk(child))
      align = prev
      if (['p', 'div', 'section', 'article'].includes(tag)) out += LINE_FEED
      return
    }

    if (tag === 'strong' || tag === 'b') {
      writeln($el.text(), { bold: true })
      return
    }

    if (tag === 'table') {
      $el.find('tr').each((_, tr) => {
        const cells = []
        $(tr)
          .find('th, td')
          .each((_, td) => {
            cells.push($(td).text().trim())
          })
        if (cells.length) writeln(cells.join(' | '))
      })
      return
    }

    if (tag === 'tr') return

    if (tag === 'li') {
      writeln('• ' + $el.text())
      return
    }

    $el.contents().each((_, child) => walk(child))
  }

  const root =
    $('#kiosk-receipt-root')[0] ||
    $('body')[0] ||
    $.root()[0]
  walk(root)

  if (!out.trim()) {
    const plain = $.root().text()
    for (const line of wrapLine(plain, width)) {
      out += line + LINE_FEED
    }
  }

  return out
}

module.exports = { htmlToEscPos, wrapLine, parseFontSizePx, styleToPrintOpts }
