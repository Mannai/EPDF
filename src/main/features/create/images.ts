import { zlibSync } from 'fflate'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState, type PDFPage } from 'pdf-lib'
import * as UTIF from 'utif2'

/**
 * Image files to PDF pages: JPEG and PNG are embedded as they are (no re-compression), TIFF frames are
 * decoded with utif2 (MIT) and embedded as flate-compressed RGB (+ soft mask when there is transparency).
 * One page per image/frame; the page is the size of the image (or fits it on A4/Letter). EXIF orientation
 * (JPEG) and the TIFF orientation tag are honoured by transforming the image, not by rotating the page.
 */

export class ImageError extends Error {}

export type ImagePageSize = 'image' | 'a4' | 'letter'
export interface ImageOptions {
  pageSize: ImagePageSize
}

export type ImageFormat = 'jpeg' | 'png' | 'tiff'

export function sniffImageFormat(b: Uint8Array): ImageFormat | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b.length > 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'tiff'
  return null
}

export interface ImageInfo {
  width: number
  height: number
  /** EXIF orientation 1..8 (1 = as stored). */
  orientation: number
  /** Pixels per inch from the file's metadata, or null. */
  dpi: number | null
}

// ---------------------------------------------------------------------------------------------------
// JPEG / PNG headers
// ---------------------------------------------------------------------------------------------------

/** Reads size, EXIF orientation and resolution from a JPEG without decoding it. */
export function readJpegInfo(b: Uint8Array): ImageInfo {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length < 4 || dv.getUint16(0) !== 0xffd8) throw new ImageError('not a JPEG file')
  let pos = 2
  let width = 0
  let height = 0
  let orientation = 1
  let dpi: number | null = null
  let jfifDpi: number | null = null
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) {
      pos++ // tolerate junk between segments
      continue
    }
    let marker = b[pos + 1]
    while (marker === 0xff && pos + 2 < b.length) marker = b[++pos + 1] // fill bytes
    pos += 2
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue // no length
    if (marker === 0xd9) break
    if (pos + 2 > b.length) break
    const len = dv.getUint16(pos)
    const seg = pos + 2
    if (marker === 0xe1 && len >= 8 && b[seg] === 0x45 && b[seg + 1] === 0x78 && b[seg + 2] === 0x69 && b[seg + 3] === 0x66) {
      const exif = readExif(b.subarray(seg + 6, pos + len))
      if (exif.orientation) orientation = exif.orientation
      if (exif.dpi) dpi = exif.dpi
    } else if (marker === 0xe0 && len >= 14 && b[seg] === 0x4a && b[seg + 1] === 0x46 && b[seg + 2] === 0x49 && b[seg + 3] === 0x46) {
      const units = b[seg + 7]
      const xd = dv.getUint16(seg + 8)
      if (xd > 0 && units === 1) jfifDpi = xd
      else if (xd > 0 && units === 2) jfifDpi = xd * 2.54
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len >= 8) {
        height = dv.getUint16(seg + 1)
        width = dv.getUint16(seg + 3)
      }
      break // everything we need precedes the frame header
    }
    pos += len
  }
  if (!width || !height) throw new ImageError('the JPEG header is damaged')
  return { width, height, orientation, dpi: dpi ?? jfifDpi }
}

/** Minimal TIFF-structured EXIF reader: orientation, X resolution and unit. */
function readExif(t: Uint8Array): { orientation?: number; dpi?: number } {
  if (t.length < 12) return {}
  const le = t[0] === 0x49
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength)
  const u16 = (o: number): number => dv.getUint16(o, le)
  const u32 = (o: number): number => dv.getUint32(o, le)
  if (u16(2) !== 42) return {}
  const ifd = u32(4)
  if (ifd < 8 || ifd + 2 > t.length) return {}
  const n = u16(ifd)
  const out: { orientation?: number; dpi?: number } = {}
  let xres: number | null = null
  let unit = 2
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > t.length) break
    const tag = u16(e)
    const type = u16(e + 2)
    if (tag === 0x0112 && type === 3) {
      const v = u16(e + 8)
      if (v >= 1 && v <= 8) out.orientation = v
    } else if (tag === 0x011a && type === 5) {
      const off = u32(e + 8)
      if (off + 8 <= t.length) {
        const den = u32(off + 4)
        if (den) xres = u32(off) / den
      }
    } else if (tag === 0x0128 && type === 3) unit = u16(e + 8)
  }
  if (xres && xres > 0) out.dpi = unit === 3 ? xres * 2.54 : unit === 2 ? xres : undefined
  return out
}

export function readPngInfo(b: Uint8Array): ImageInfo {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length < 33 || sniffImageFormat(b) !== 'png') throw new ImageError('not a PNG file')
  const width = dv.getUint32(16)
  const height = dv.getUint32(20)
  if (!width || !height) throw new ImageError('the PNG header is damaged')
  let dpi: number | null = null
  let pos = 8
  while (pos + 8 <= b.length) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7])
    if (type === 'pHYs' && len >= 9 && dv.getUint8(pos + 16) === 1) {
      const ppm = dv.getUint32(pos + 8)
      if (ppm > 0) dpi = ppm * 0.0254
    }
    if (type === 'IDAT' || type === 'IEND') break
    pos += 12 + len
  }
  return { width, height, orientation: 1, dpi }
}

// ---------------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------------

export type Matrix = [number, number, number, number, number, number]

/**
 * Matrix (PDF image space, unit square, y up) that draws an image with EXIF `orientation` so that it
 * fills a `dw` x `dh` display box at the origin. `dw`/`dh` are the size AFTER orientation is applied.
 */
export function orientationMatrix(orientation: number, dw: number, dh: number): Matrix {
  switch (orientation) {
    case 2:
      return [-dw, 0, 0, dh, dw, 0]
    case 3:
      return [-dw, 0, 0, -dh, dw, dh]
    case 4:
      return [dw, 0, 0, -dh, 0, dh]
    case 5:
      return [0, -dh, -dw, 0, dw, dh]
    case 6:
      return [0, -dh, dw, 0, 0, dh]
    case 7:
      return [0, dh, dw, 0, 0, 0]
    case 8:
      return [0, dh, -dw, 0, dw, 0]
    default:
      return [dw, 0, 0, dh, 0, 0]
  }
}

const A4: [number, number] = [595.28, 841.89]
const LETTER: [number, number] = [612, 792]
const MAX_PAGE = 14400 // PDF's practical limit (200 inches)
const FIT_MARGIN = 36

export interface Placement {
  page: [number, number]
  matrix: Matrix
}

/** Page size and image matrix for one image, given its pixel size, orientation and resolution. */
export function placeImage(info: ImageInfo, opts: ImageOptions): Placement {
  const swap = info.orientation >= 5
  const pxW = swap ? info.height : info.width
  const pxH = swap ? info.width : info.height
  const dpi = info.dpi && info.dpi >= 20 && info.dpi <= 2400 ? info.dpi : 72
  let dw = (pxW * 72) / dpi
  let dh = (pxH * 72) / dpi
  if (opts.pageSize === 'image') {
    const k = Math.min(1, MAX_PAGE / Math.max(dw, dh))
    dw *= k
    dh *= k
    return { page: [dw, dh], matrix: orientationMatrix(info.orientation, dw, dh) }
  }
  const base = opts.pageSize === 'a4' ? A4 : LETTER
  const landscape = pxW > pxH
  const page: [number, number] = landscape ? [base[1], base[0]] : [base[0], base[1]]
  const k = Math.min((page[0] - 2 * FIT_MARGIN) / dw, (page[1] - 2 * FIT_MARGIN) / dh)
  dw *= k
  dh *= k
  const m = orientationMatrix(info.orientation, dw, dh)
  const tx = (page[0] - dw) / 2
  const ty = (page[1] - dh) / 2
  return { page, matrix: [m[0], m[1], m[2], m[3], m[4] + tx, m[5] + ty] }
}

function drawImageRef(page: PDFPage, ref: PDFRef, matrix: Matrix): void {
  const name = page.node.newXObject('Im', ref)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix), drawObject(name), popGraphicsState())
}

// ---------------------------------------------------------------------------------------------------
// Adding images to a document
// ---------------------------------------------------------------------------------------------------

/** Adds every frame of an image file as pages. Returns the number of pages added. */
export async function addImageToPdf(
  pdf: PDFDocument,
  displayName: string,
  bytes: Uint8Array,
  opts: ImageOptions,
  onFrame?: (done: number, total: number) => void
): Promise<number> {
  const fmt = sniffImageFormat(bytes)
  const wrap = (why: string): ImageError => new ImageError(`“${displayName}” could not be converted: ${why}.`)
  if (!fmt) throw wrap('it is not a JPEG, PNG or TIFF image')
  try {
    if (fmt === 'jpeg') {
      const info = readJpegInfo(bytes)
      const img = await pdf.embedJpg(bytes)
      const { page, matrix } = placeImage(info, opts)
      drawImageRef(pdf.addPage(page), img.ref, matrix)
      return 1
    }
    if (fmt === 'png') {
      const info = readPngInfo(bytes)
      const img = await pdf.embedPng(bytes)
      const { page, matrix } = placeImage(info, opts)
      drawImageRef(pdf.addPage(page), img.ref, matrix)
      return 1
    }
    return await addTiff(pdf, bytes, opts, onFrame)
  } catch (err) {
    if (err instanceof ImageError) throw wrap(err.message)
    const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : 'unknown error'
    throw wrap(`the image is damaged or uses an unsupported encoding (${msg})`)
  }
}

interface TiffIfd {
  width: number
  height: number
  data: Uint8Array
  [tag: string]: unknown
}

const firstNum = (v: unknown): number | undefined => (Array.isArray(v) && typeof v[0] === 'number' ? (v[0] as number) : undefined)

async function addTiff(pdf: PDFDocument, bytes: Uint8Array, opts: ImageOptions, onFrame?: (done: number, total: number) => void): Promise<number> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  let ifds: TiffIfd[]
  try {
    ifds = UTIF.decode(ab) as unknown as TiffIfd[]
  } catch (e) {
    throw new ImageError(`the TIFF structure is damaged (${String(e)})`)
  }
  // Skip thumbnails / reduced-resolution copies and entries without pixel data.
  const frames = ifds.filter((f) => {
    const sub = firstNum(f['t254']) ?? 0
    return (sub & 1) === 0 && !!firstNum(f['t256']) && !!firstNum(f['t257'])
  })
  if (frames.length === 0) throw new ImageError('the TIFF contains no images')
  let added = 0
  for (const ifd of frames) {
    UTIF.decodeImage(ab, ifd as never)
    const rgba = UTIF.toRGBA8(ifd as never)
    const w = ifd.width
    const h = ifd.height
    const ref = embedRgba(pdf, rgba, w, h)
    const res = firstNum(ifd['t282'] instanceof Array ? (ifd['t282'] as unknown[]).map((r) => (Array.isArray(r) ? r[0] / r[1] : r)) : undefined)
    const unit = firstNum(ifd['t296']) ?? 2
    const dpi = res ? (unit === 3 ? res * 2.54 : unit === 2 ? res : null) : null
    const orientation = firstNum(ifd['t274']) ?? 1
    const { page, matrix } = placeImage({ width: w, height: h, orientation: orientation >= 1 && orientation <= 8 ? orientation : 1, dpi }, opts)
    drawImageRef(pdf.addPage(page), ref, matrix)
    added++
    onFrame?.(added, frames.length)
    await new Promise((r) => setTimeout(r, 0)) // yield between frames of big multi-page files
  }
  return added
}

/** Embeds RGBA pixels as a flate-compressed DeviceRGB image (with a soft mask if any pixel is transparent). */
export function embedRgba(pdf: PDFDocument, rgba: Uint8Array, w: number, h: number): PDFRef {
  const n = w * h
  const rgb = new Uint8Array(n * 3)
  const alpha = new Uint8Array(n)
  let translucent = false
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    rgb[j] = rgba[i * 4]
    rgb[j + 1] = rgba[i * 4 + 1]
    rgb[j + 2] = rgba[i * 4 + 2]
    const a = rgba[i * 4 + 3]
    alpha[i] = a
    if (a !== 255) translucent = true
  }
  const ctx = pdf.context
  const dict = (cs: string): PDFDict =>
    ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: cs, BitsPerComponent: 8, Filter: 'FlateDecode' }) as unknown as PDFDict
  let smask: PDFRef | undefined
  if (translucent) {
    smask = ctx.register(PDFRawStream.of(dict('DeviceGray'), zlibSync(alpha)))
  }
  const main = dict('DeviceRGB')
  if (smask) main.set(PDFName.of('SMask'), smask)
  return ctx.register(PDFRawStream.of(main, zlibSync(rgb)))
}

/** Converts image files to one PDF. Used by the job worker and by unit tests. */
export async function imagesToPdf(
  inputs: { name: string; bytes: Uint8Array }[],
  opts: ImageOptions,
  onProgress?: (fraction: number, message?: string) => void
): Promise<{ bytes: Uint8Array; pages: number }> {
  const pdf = await PDFDocument.create()
  let pages = 0
  for (let i = 0; i < inputs.length; i++) {
    onProgress?.(i / inputs.length, `Converting ${inputs[i].name}`)
    pages += await addImageToPdf(pdf, inputs[i].name, inputs[i].bytes, opts)
    await new Promise((r) => setTimeout(r, 0))
  }
  pdf.setProducer('Epdf')
  pdf.setCreator('Epdf')
  return { bytes: await pdf.save(), pages }
}
