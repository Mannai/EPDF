import { decodeJpeg } from './jpegDecode'
import type { JpegInfo } from './jpegInfo'

/** Interleaved 8-bit pixels. `ncomp` 1 = gray, 3 = RGB, 4 = raw CMYK components. */
export interface Raster {
  width: number
  height: number
  ncomp: number
  data: Uint8Array
}

/**
 * How the optimiser turns JPEG bytes into pixels. Encoding is always done by our own encoder, decoding is pluggable: the
 * app uses Chromium's decoder (fast, robust) with this module's pure decoder as the fallback; unit tests use the pure one.
 */
export interface ImageCodec {
  decodeJpeg(bytes: Uint8Array, info: JpegInfo): Promise<Raster>
}

/** Pure-TypeScript codec (works everywhere, slower). */
export const pureCodec: ImageCodec = {
  decodeJpeg: async (bytes) => decodeJpeg(bytes)
}
