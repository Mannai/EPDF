import { pureCodec, type ImageCodec, type Raster } from './pdf/codec'
import type { JpegInfo } from './pdf/jpegInfo'

/**
 * JPEG decoding with Chromium's own codec (fast, handles every colour JPEG that browsers show), falling back to the in-house
 * decoder for anything the browser cannot give us as plain samples: CMYK / YCCK (no raw channel access) and files it refuses.
 * Runs inside the compression Web Worker (OffscreenCanvas + createImageBitmap exist there).
 */
export const browserCodec: ImageCodec = {
  async decodeJpeg(bytes: Uint8Array, info: JpegInfo): Promise<Raster> {
    if (info.ncomp === 4 || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return pureCodec.decodeJpeg(bytes, info)
    try {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), {
        imageOrientation: 'none',
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none'
      })
      try {
        const { width, height } = bmp
        if (width !== info.width || height !== info.height) throw new Error('size mismatch')
        const canvas = new OffscreenCanvas(width, height)
        const g = canvas.getContext('2d', { willReadFrequently: true })
        if (!g) throw new Error('no 2d context')
        g.drawImage(bmp, 0, 0)
        const rgba = g.getImageData(0, 0, width, height).data
        const n = width * height
        if (info.ncomp === 1) {
          const out = new Uint8Array(n)
          for (let i = 0; i < n; i++) out[i] = rgba[i * 4]
          return { width, height, ncomp: 1, data: out }
        }
        const out = new Uint8Array(n * 3)
        for (let i = 0; i < n; i++) {
          out[i * 3] = rgba[i * 4]
          out[i * 3 + 1] = rgba[i * 4 + 1]
          out[i * 3 + 2] = rgba[i * 4 + 2]
        }
        return { width, height, ncomp: 3, data: out }
      } finally {
        bmp.close()
      }
    } catch {
      return pureCodec.decodeJpeg(bytes, info)
    }
  }
}
