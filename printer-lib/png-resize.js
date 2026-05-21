/**
 * Pure-JS PNG decode + resize (Windows-safe, no sharp/jimp native binaries).
 */

const { PNG } = require('pngjs')

function readPng(buffer) {
  return PNG.sync.read(buffer)
}

function writePng(png) {
  return PNG.sync.write(png)
}

/** Nearest-neighbor resize; returns new PNG instance. */
function resizePngNearest(src, targetWidth) {
  const sw = src.width
  const sh = src.height
  if (sw < 1 || sh < 1) {
    throw new Error('invalid png dimensions')
  }
  const tw = Math.max(1, Math.round(targetWidth))
  const th = Math.max(1, Math.round((sh * tw) / sw))
  const dst = new PNG({ width: tw, height: th })

  for (let y = 0; y < th; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / th))
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / tw))
      const si = (sy * sw + sx) * 4
      const di = (y * tw + x) * 4
      dst.data[di] = src.data[si]
      dst.data[di + 1] = src.data[si + 1]
      dst.data[di + 2] = src.data[si + 2]
      dst.data[di + 3] = 255
    }
  }
  return dst
}

function greyscalePng(png, threshold = 155) {
  for (let i = 0; i < png.data.length; i += 4) {
    const g = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3
    const v = g < threshold ? 0 : 255
    png.data[i] = v
    png.data[i + 1] = v
    png.data[i + 2] = v
    png.data[i + 3] = 255
  }
  return png
}

function resizePngBuffer(buffer, widthPx, threshold = 155) {
  let png = readPng(buffer)
  if (png.width !== widthPx) {
    png = resizePngNearest(png, widthPx)
  }
  greyscalePng(png, threshold)
  return writePng(png)
}

module.exports = {
  readPng,
  writePng,
  resizePngNearest,
  greyscalePng,
  resizePngBuffer,
}
