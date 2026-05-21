const { INIT, ALIGN_CENTER } = require('./escpos')

let _sharp = undefined

function getSharp() {
  if (_sharp !== undefined) return _sharp
  try {
    _sharp = require('sharp')
  } catch {
    _sharp = null
  }
  return _sharp
}

function getPngResize() {
  try {
    return require('./png-resize')
  } catch {
    return null
  }
}

/**
 * Pack greyscale rows into ESC/POS raster (GS v 0).
 */
function packRasterBits(pixels, width, height) {
  const bytesPerRow = Math.ceil(width / 8)
  const out = Buffer.alloc(bytesPerRow * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = pixels[y * width + x]
      if (px < 128) {
        const byteIndex = y * bytesPerRow + (x >> 3)
        out[byteIndex] |= 0x80 >> (x & 7)
      }
    }
  }
  return { data: out, bytesPerRow, height }
}

function pixelsFromPng(png, threshold = 155) {
  const w = png.width
  const h = png.height
  const pixels = Buffer.alloc(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4
      const grey =
        (png.data[idx] + png.data[idx + 1] + png.data[idx + 2]) / 3
      pixels[y * w + x] = grey < threshold ? 0 : 255
    }
  }
  return { pixels, w, h }
}

async function imageBufferToEscPosRasterPngjs(imageBuffer, opts = {}) {
  const pngResize = getPngResize()
  if (!pngResize) {
    throw new Error('pngjs is required when sharp is unavailable')
  }
  const widthPx = opts.widthPx || 576
  const threshold = opts.threshold ?? 155
  const resized = pngResize.resizePngBuffer(imageBuffer, widthPx, threshold)
  const png = pngResize.readPng(resized)
  const { pixels, w, h } = pixelsFromPng(png, threshold)

  const maxSlice = opts.maxSliceHeight || 2400
  const buffers = []
  let y0 = 0
  let pages = 0

  while (y0 < h) {
    const sliceH = Math.min(maxSlice, h - y0)
    const slice = Buffer.alloc(w * sliceH)
    pixels.copy(slice, 0, y0 * w, y0 * w + w * sliceH)
    const { data: raster, bytesPerRow, height } = packRasterBits(slice, w, sliceH)
    const header = Buffer.from([
      0x1d,
      0x76,
      0x30,
      0x00,
      bytesPerRow & 0xff,
      (bytesPerRow >> 8) & 0xff,
      height & 0xff,
      (height >> 8) & 0xff,
    ])
    buffers.push(Buffer.concat([header, raster]))
    pages++
    y0 += sliceH
  }

  return { buffers, width: w, height: h, pages }
}

async function imageBufferToEscPosRasterSharp(imageBuffer, opts = {}) {
  const sharp = getSharp()
  const widthPx = opts.widthPx || 576
  const threshold = opts.threshold ?? 155
  const dither = opts.dither !== false

  let pipeline = sharp(imageBuffer, { failOn: 'none' })
    .rotate()
    .resize(widthPx, null, {
      fit: 'inside',
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
    })
    .flatten({ background: '#ffffff' })
    .greyscale()

  if (dither) {
    pipeline = pipeline.png({ colours: 2, dither: 1.0 })
    const dithered = await pipeline.toBuffer()
    pipeline = sharp(dithered).greyscale()
  } else {
    pipeline = pipeline.normalise().threshold(threshold, { grayscale: true })
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true })

  const w = info.width
  const h = info.height
  const pixels = Buffer.alloc(w * h)
  for (let i = 0; i < w * h; i++) {
    pixels[i] = data[i] < 128 ? 0 : 255
  }

  const maxSlice = opts.maxSliceHeight || 2400
  const buffers = []
  let y0 = 0
  let pages = 0

  while (y0 < h) {
    const sliceH = Math.min(maxSlice, h - y0)
    const slice = Buffer.alloc(w * sliceH)
    pixels.copy(slice, 0, y0 * w, y0 * w + w * sliceH)
    const { data: raster, bytesPerRow, height } = packRasterBits(slice, w, sliceH)
    const header = Buffer.from([
      0x1d,
      0x76,
      0x30,
      0x00,
      bytesPerRow & 0xff,
      (bytesPerRow >> 8) & 0xff,
      height & 0xff,
      (height >> 8) & 0xff,
    ])
    buffers.push(Buffer.concat([header, raster]))
    pages++
    y0 += sliceH
  }

  return { buffers, width: w, height: h, pages }
}

async function imageBufferToEscPosRaster(imageBuffer, opts = {}) {
  if (getSharp()) {
    try {
      return await imageBufferToEscPosRasterSharp(imageBuffer, opts)
    } catch (err) {
      console.warn('[receipt-raster] sharp failed, using jimp:', err.message)
    }
  }
  return imageBufferToEscPosRasterPngjs(imageBuffer, opts)
}

async function buildPrintPayloadFromImage(imageBuffer, opts = {}) {
  const { buffers, width, height, pages } = await imageBufferToEscPosRaster(
    imageBuffer,
    opts,
  )
  const parts = [Buffer.from(INIT, 'binary')]
  if (opts.center) parts.push(Buffer.from(ALIGN_CENTER, 'binary'))
  for (const b of buffers) parts.push(b)
  return {
    payload: Buffer.concat(parts),
    meta: { width, height, pages, mode: 'raster' },
  }
}

module.exports = {
  imageBufferToEscPosRaster,
  buildPrintPayloadFromImage,
  packRasterBits,
  getSharp,
}
