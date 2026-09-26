// Image helpers for cover art: identify a picture from its bytes and make
// square JPEG thumbnails. Pure JS (jpeg-js, pngjs), used from the worker pool.

import jpeg from "jpeg-js"
import { PNG } from "pngjs"

export interface ImageInfo {
  mime: string
  width?: number
  height?: number
}

/** Recognise JPEG / PNG / WebP / GIF and read the dimensions from the header. */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length < 12) return null
  const u16 = (i: number) => (b[i] << 8) | b[i + 1]
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
  if (b[0] === 0xff && b[1] === 0xd8) {
    // Walk the JPEG segments to the first start-of-frame marker.
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", height: u16(i + 5), width: u16(i + 7) }
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      i += 2 + u16(i + 2)
    }
    return { mime: "image/jpeg" }
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", width: u32(16), height: u32(20) }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { mime: "image/gif", width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) }
  const riff = String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP"
  if (riff) {
    const chunk = String.fromCharCode(...b.subarray(12, 16))
    if (chunk === "VP8X") return { mime: "image/webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
    if (chunk === "VP8 ") return { mime: "image/webp", width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff }
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return { mime: "image/webp" }
  }
  return null
}

interface Rgba {
  width: number
  height: number
  data: Uint8Array
}

function decodeImage(bytes: Uint8Array, mime: string): Rgba | null {
  if (mime === "image/jpeg") return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 80, maxMemoryUsageInMB: 400 })
  if (mime === "image/png") return PNG.sync.read(Buffer.from(bytes))
  return null
}

/**
 * Centre-crop to a square and shrink to `size` pixels with an area average, as
 * a JPEG. Returns null for formats we can't decode (WebP, GIF) - callers serve
 * the original then.
 */
export function makeThumbnail(bytes: Uint8Array, size: number): Buffer | null {
  const info = sniffImage(bytes)
  if (!info) return null
  const img = decodeImage(bytes, info.mime)
  if (!img) return null
  const side = Math.min(img.width, img.height)
  const x0 = Math.floor((img.width - side) / 2)
  const y0 = Math.floor((img.height - side) / 2)
  const out = Math.min(size, side)
  const dst = Buffer.alloc(out * out * 4)
  const scale = side / out
  for (let oy = 0; oy < out; oy++) {
    const sy0 = y0 + Math.floor(oy * scale)
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor((oy + 1) * scale))
    for (let ox = 0; ox < out; ox++) {
      const sx0 = x0 + Math.floor(ox * scale)
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor((ox + 1) * scale))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * img.width + x) * 4
          // Flatten any transparency onto near-black, like the UI behind it.
          const a = img.data[i + 3] / 255
          r += img.data[i] * a + 17 * (1 - a)
          g += img.data[i + 1] * a + 17 * (1 - a)
          b += img.data[i + 2] * a + 17 * (1 - a)
          n++
        }
      }
      const o = (oy * out + ox) * 4
      dst[o] = r / n
      dst[o + 1] = g / n
      dst[o + 2] = b / n
      dst[o + 3] = 255
    }
  }
  return jpeg.encode({ data: dst, width: out, height: out }, 82).data
}
