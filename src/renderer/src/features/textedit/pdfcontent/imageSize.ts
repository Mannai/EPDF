/** Pixel size and type of PNG / JPEG files, read from their headers (no decoding). */

export type PictureKind = 'png' | 'jpg'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function detectPicture(b: Uint8Array): PictureKind | null {
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'png'
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  return null
}

export function pictureSize(b: Uint8Array): { width: number; height: number } | null {
  const kind = detectPicture(b)
  if (kind === 'png') {
    if (b.length < 24) return null
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    const w = dv.getUint32(16)
    const h = dv.getUint32(20)
    return w > 0 && h > 0 ? { width: w, height: h } : null
  }
  if (kind === 'jpg') {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      if (marker === 0xff) {
        i++
        continue
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2
        continue
      }
      const len = (b[i + 2] << 8) | b[i + 3]
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (b[i + 5] << 8) | b[i + 6]
        const w = (b[i + 7] << 8) | b[i + 8]
        return w > 0 && h > 0 ? { width: w, height: h } : null
      }
      if (len < 2) return null
      i += 2 + len
    }
  }
  return null
}
