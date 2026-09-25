import * as jpegjs from 'jpeg-js'
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocument,
  type PDFObject
} from 'pdf-lib'
import type { Matrix } from '../../textedit/pdfcontent/matrix'
import { N, dget, nameText, streamBytes } from '../../textedit/pdfcontent/pdfutil'
import type { Rect } from './geom'

/**
 * Destroys the pixels of an image that lie under redaction marks.
 *
 *   * The image is decoded (Flate/LZW/ASCII85/ASCIIHex/RunLength, or baseline/progressive 8-bit JPEG), every
 *     pixel whose square touches a mark is set to black, and the result is re-encoded (lossless Flate; JPEG for
 *     JPEG). Soft masks and stencil masks are cleared in the same region so they cannot carry the shape.
 *   * Anything we cannot do with certainty (JPEG 2000, JBIG2, CCITT, CMYK/Lab/Separation JPEGs, odd bit depths,
 *     unknown colour spaces, huge images, decode errors) is reported as `{ fail }`; the caller then removes the
 *     whole image and paints a solid box instead (fail closed).
 */

export type ImageResult = { ref: PDFRef; pixels: number } | { fail: string }

const MAX_PIXELS = 120_000_000
/** High enough that a re-encoded JPEG stays visually identical (and its blacked-out blocks stay black). */
export const JPEG_QUALITY = 95

const num = (o: PDFObject | undefined): number | undefined => (o instanceof PDFNumber ? o.asNumber() : undefined)

// ---------------------------------------------------------------------------------------------------------
// Which pixels are covered

export interface Span {
  y: number
  x0: number
  /** Exclusive. */
  x1: number
}

/**
 * The pixel rows/ranges of a `w`×`h` image drawn with `ctm` (unit square -> user space) whose squares overlap the
 * marks (disjoint rects, user space). Returns null when the transform is degenerate.
 */
export function pixelSpans(w: number, h: number, ctm: Matrix, marks: readonly Rect[]): Span[] | null {
  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const inv = [ctm[3] / det, -ctm[1] / det, -ctm[2] / det, ctm[0] / det, (ctm[2] * ctm[5] - ctm[3] * ctm[4]) / det, (ctm[1] * ctm[4] - ctm[0] * ctm[5]) / det]
  // user-space origin of pixel (0,0) (its top-left corner) and the per-pixel steps
  const ox = ctm[2] + ctm[4]
  const oy = ctm[3] + ctm[5]
  const sxx = ctm[0] / w
  const sxy = ctm[1] / w
  const syx = -ctm[2] / h
  const syy = -ctm[3] / h
  const spans: Span[] = []
  for (const m of marks) {
    // mark corners -> unit square -> pixel coordinates
    let minPx = Infinity
    let maxPx = -Infinity
    let minPy = Infinity
    let maxPy = -Infinity
    for (const [x, y] of [
      [m.x0, m.y0],
      [m.x1, m.y0],
      [m.x0, m.y1],
      [m.x1, m.y1]
    ]) {
      const u = x * inv[0] + y * inv[2] + inv[4]
      const v = x * inv[1] + y * inv[3] + inv[5]
      const px = u * w
      const py = (1 - v) * h
      minPx = Math.min(minPx, px)
      maxPx = Math.max(maxPx, px)
      minPy = Math.min(minPy, py)
      maxPy = Math.max(maxPy, py)
    }
    const x0 = Math.max(0, Math.floor(minPx) - 1)
    const x1 = Math.min(w, Math.ceil(maxPx) + 1)
    const y0 = Math.max(0, Math.floor(minPy) - 1)
    const y1 = Math.min(h, Math.ceil(maxPy) + 1)
    for (let py = y0; py < y1; py++) {
      let runStart = -1
      for (let px = x0; px < x1; px++) {
        // bounding box of the pixel square in user space
        const cx = ox + px * sxx + py * syx
        const cy = oy + px * sxy + py * syy
        const ax = cx + sxx
        const ay = cy + sxy
        const bx = cx + syx
        const by = cy + syy
        const dx = cx + sxx + syx
        const dy = cy + sxy + syy
        const bx0 = Math.min(cx, ax, bx, dx)
        const bx1 = Math.max(cx, ax, bx, dx)
        const by0 = Math.min(cy, ay, by, dy)
        const by1 = Math.max(cy, ay, by, dy)
        const hit = bx0 < m.x1 - 1e-7 && m.x0 + 1e-7 < bx1 && by0 < m.y1 - 1e-7 && m.y0 + 1e-7 < by1
        if (hit) {
          if (runStart < 0) runStart = px
        } else if (runStart >= 0) {
          spans.push({ y: py, x0: runStart, x1: px })
          runStart = -1
        }
      }
      if (runStart >= 0) spans.push({ y: py, x0: runStart, x1 })
    }
  }
  return spans
}

// ---------------------------------------------------------------------------------------------------------
// Colour spaces

type CsKind = 'gray' | 'rgb' | 'cmyk'

interface Cs {
  kind: CsKind
  n: number
  /** The PDF object to write back as /ColorSpace. */
  obj: PDFObject
  indexed?: { hival: number; lookup: Uint8Array; base: Cs }
}

function lookupBytes(ctx: PDFDocument['context'], o: PDFObject | undefined): Uint8Array | null {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o
  if (v instanceof PDFString || v instanceof PDFHexString) return v.asBytes()
  if (v instanceof PDFStream) {
    try {
      return streamBytes(v)
    } catch {
      return null
    }
  }
  return null
}

function parseCs(pdf: PDFDocument, raw: PDFObject | undefined, resources: PDFDict | undefined, depth = 0): Cs | null {
  if (!raw || depth > 4) return null
  const ctx = pdf.context
  const o = raw instanceof PDFRef ? ctx.lookup(raw) : raw
  if (o instanceof PDFName) {
    switch (nameText(o)) {
      case 'DeviceGray':
      case 'G':
      case 'CalGray':
        return { kind: 'gray', n: 1, obj: N('DeviceGray') }
      case 'DeviceRGB':
      case 'RGB':
      case 'CalRGB':
        return { kind: 'rgb', n: 3, obj: N('DeviceRGB') }
      case 'DeviceCMYK':
      case 'CMYK':
        return { kind: 'cmyk', n: 4, obj: N('DeviceCMYK') }
    }
    // a named colour space from the resources (inline images)
    const named = resources ? dget(dget(resources, 'ColorSpace') as PDFDict | undefined, nameText(o)) : undefined
    return named ? parseCs(pdf, named, resources, depth + 1) : null
  }
  if (o instanceof PDFArray && o.size() > 0) {
    const head = o.lookup(0)
    const kind = head instanceof PDFName ? nameText(head) : ''
    if (kind === 'ICCBased') {
      const s = o.lookup(1)
      const nComp = s instanceof PDFStream ? num(dget(s.dict, 'N')) : undefined
      if (nComp === 1) return { kind: 'gray', n: 1, obj: raw }
      if (nComp === 3) return { kind: 'rgb', n: 3, obj: raw }
      if (nComp === 4) return { kind: 'cmyk', n: 4, obj: raw }
      return null
    }
    if (kind === 'CalGray') return { kind: 'gray', n: 1, obj: raw }
    if (kind === 'CalRGB') return { kind: 'rgb', n: 3, obj: raw }
    if (kind === 'Indexed' || kind === 'I') {
      const base = parseCs(pdf, o.get(1), resources, depth + 1)
      const hival = num(o.lookup(2))
      const lookup = lookupBytes(ctx, o.get(3))
      if (!base || base.indexed || hival === undefined || !lookup || hival < 0 || hival > 255) return null
      if (lookup.length < (hival + 1) * base.n) return null
      return { kind: 'gray', n: 1, obj: o, indexed: { hival, lookup, base } }
    }
  }
  return null
}

/** Sample value (0..max) whose decoded value is `desired`, given a Decode pair. */
function sampleFor(desired: number, dmin: number, dmax: number, max: number): number {
  if (dmax === dmin) return 0
  const s = ((desired - dmin) / (dmax - dmin)) * max
  return Math.max(0, Math.min(max, Math.round(s)))
}

function decodePairs(dict: PDFDict, n: number): number[][] | null | 'default' {
  const d = dget(dict, 'Decode')
  if (!(d instanceof PDFArray)) return 'default'
  if (d.size() !== 2 * n) return null
  const out: number[][] = []
  for (let i = 0; i < n; i++) {
    const a = num(d.lookup(2 * i))
    const b = num(d.lookup(2 * i + 1))
    if (a === undefined || b === undefined) return null
    out.push([a, b])
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Raw sample buffers

interface Layout {
  w: number
  h: number
  n: number
  bpc: number
  rowBytes: number
}

const layoutOf = (w: number, h: number, n: number, bpc: number): Layout => ({ w, h, n, bpc, rowBytes: Math.ceil((w * n * bpc) / 8) })

function fillSpans(data: Uint8Array, l: Layout, spans: readonly Span[], sample: readonly number[]): number {
  let pixels = 0
  for (const s of spans) {
    if (s.y < 0 || s.y >= l.h) continue
    const rowStart = s.y * l.rowBytes
    for (let x = s.x0; x < s.x1; x++) {
      pixels++
      if (l.bpc === 8) {
        const o = rowStart + x * l.n
        for (let c = 0; c < l.n; c++) data[o + c] = sample[c]
      } else if (l.bpc === 16) {
        const o = rowStart + x * l.n * 2
        for (let c = 0; c < l.n; c++) {
          data[o + 2 * c] = (sample[c] >> 8) & 255
          data[o + 2 * c + 1] = sample[c] & 255
        }
      } else {
        // 1, 2 or 4 bits per component, components packed MSB first
        let bit = x * l.n * l.bpc
        for (let c = 0; c < l.n; c++) {
          const byte = rowStart + (bit >> 3)
          const shift = 8 - l.bpc - (bit & 7)
          const mask = ((1 << l.bpc) - 1) << shift
          data[byte] = (data[byte] & ~mask) | ((sample[c] << shift) & mask)
          bit += l.bpc
        }
      }
    }
  }
  return pixels
}

function readSample(data: Uint8Array, l: Layout, x: number, y: number, c: number): number {
  const rowStart = y * l.rowBytes
  if (l.bpc === 8) return data[rowStart + x * l.n + c] ?? 0
  if (l.bpc === 16) return ((data[rowStart + (x * l.n + c) * 2] ?? 0) << 8) | (data[rowStart + (x * l.n + c) * 2 + 1] ?? 0)
  const bit = (x * l.n + c) * l.bpc
  const shift = 8 - l.bpc - (bit & 7)
  return ((data[rowStart + (bit >> 3)] ?? 0) >> shift) & ((1 << l.bpc) - 1)
}

// ---------------------------------------------------------------------------------------------------------
// JPEG

interface JpegInfo {
  width: number
  height: number
  components: number
  precision: number
}

/** Frame header of a JPEG (SOF0..SOF2) or null. */
function jpegInfo(b: Uint8Array): JpegInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
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
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = (b[i + 2] << 8) | b[i + 3]
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { precision: b[i + 4], height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], components: b[i + 9] }
    }
    // other SOF (lossless, arithmetic, hierarchical): not supported
    if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return null
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

function encodeJpeg(rgba: Uint8Array, width: number, height: number): Uint8Array {
  // jpeg-js returns `Buffer.from(...)` when a CommonJS `module` exists; the sandboxed renderer has no Buffer.
  const g = globalThis as unknown as { Buffer?: { from(a: ArrayLike<number>): Uint8Array } }
  const shim = typeof g.Buffer === 'undefined'
  if (shim) g.Buffer = { from: (a) => Uint8Array.from(a) }
  try {
    const out = jpegjs.encode({ data: rgba, width, height }, JPEG_QUALITY)
    return new Uint8Array(out.data as unknown as ArrayLike<number>)
  } finally {
    if (shim) delete g.Buffer
  }
}

// ---------------------------------------------------------------------------------------------------------
// The image object

const STRIP_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms', 'Alternates', 'OPI', 'Metadata', 'Thumb', 'PieceInfo', 'LastModified', 'StructParent'])

function filtersOf(dict: PDFDict): string[] {
  const f = dget(dict, 'Filter')
  if (f instanceof PDFName) return [nameText(f)]
  if (f instanceof PDFArray) {
    const out: string[] = []
    for (let i = 0; i < f.size(); i++) {
      const x = f.lookup(i)
      if (x instanceof PDFName) out.push(nameText(x))
    }
    return out
  }
  return []
}

type Mode = 'image' | 'alpha' | 'stencil'

interface Job {
  pdf: PDFDocument
  ctm: Matrix
  marks: readonly Rect[]
  resources: PDFDict | undefined
}

function copyDict(src: PDFDict, extra: Record<string, PDFObject | null>): Record<string, PDFObject> {
  const lit: Record<string, PDFObject> = {}
  for (const [k, v] of src.entries()) {
    const key = nameText(k)
    if (!STRIP_KEYS.has(key)) lit[key] = v
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete lit[k]
    else lit[k] = v
  }
  return lit
}

/** Redacts one image-like object (image, soft mask or stencil mask). Returns the new object's ref. */
function processOne(job: Job, stream: PDFStream, mode: Mode): ImageResult {
  const { pdf } = job
  const dict = stream.dict
  const w = num(dget(dict, 'Width'))
  const h = num(dget(dict, 'Height'))
  if (!w || !h || !Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return { fail: 'the image has no valid size' }
  if (w * h > MAX_PIXELS) return { fail: 'the image is too large to process safely' }
  const spans = pixelSpans(w, h, job.ctm, job.marks)
  if (!spans) return { fail: 'the image is drawn with a degenerate transform' }
  const filters = filtersOf(dict)
  const stencil = mode === 'stencil' || (dget(dict, 'ImageMask') instanceof PDFBool && (dget(dict, 'ImageMask') as PDFBool).asBoolean())

  for (const f of filters) {
    if (f === 'JPXDecode' || f === 'CCITTFaxDecode' || f === 'CCF' || f === 'JBIG2Decode' || f === 'Crypt') return { fail: `the image uses ${f}, which cannot be edited pixel by pixel` }
  }

  // ---- JPEG
  if (filters.includes('DCTDecode') || filters.includes('DCT')) {
    if (mode !== 'image' || stencil) return { fail: 'a JPEG mask cannot be edited' }
    if (filters.length !== 1) return { fail: 'the image combines JPEG with another filter' }
    if (dget(dict, 'Decode') instanceof PDFArray) return { fail: 'the JPEG image has a Decode array' }
    const cs = parseCs(pdf, dict.get(N('ColorSpace')), job.resources)
    if (!cs || cs.indexed || cs.kind === 'cmyk') return { fail: 'the JPEG image has an unsupported colour space' }
    const bytes = stream instanceof PDFRawStream ? stream.contents : null
    if (!bytes) return { fail: 'the JPEG data could not be read' }
    const info = jpegInfo(bytes)
    if (!info || info.precision !== 8 || (info.components !== 1 && info.components !== 3)) return { fail: 'the JPEG variant is not supported' }
    if (info.width !== w || info.height !== h) return { fail: 'the JPEG size differs from the image dictionary' }
    if ((info.components === 1) !== (cs.kind === 'gray')) return { fail: 'the JPEG components do not match its colour space' }
    let dec: { width: number; height: number; data: Uint8Array }
    try {
      dec = jpegjs.decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: 100, maxMemoryUsageInMB: 700 })
    } catch (e) {
      return { fail: `the JPEG could not be decoded (${e instanceof Error ? e.message : String(e)})` }
    }
    if (dec.width !== w || dec.height !== h) return { fail: 'the decoded JPEG has an unexpected size' }
    let pixels = 0
    for (const s of spans) {
      if (s.y < 0 || s.y >= h) continue
      for (let x = s.x0; x < s.x1; x++) {
        const o = (s.y * w + x) * 4
        dec.data[o] = dec.data[o + 1] = dec.data[o + 2] = 0
        dec.data[o + 3] = 255
        pixels++
      }
    }
    const out = encodeJpeg(dec.data, w, h)
    const lit = copyDict(dict, {
      Filter: N('DCTDecode'),
      ColorSpace: cs.kind === 'gray' ? N('DeviceRGB') : cs.obj,
      BitsPerComponent: PDFNumber.of(8)
    })
    const s2 = pdf.context.stream(out, lit as never)
    return { ref: pdf.context.register(s2), pixels }
  }

  // ---- everything else: decode to raw samples
  let data: Uint8Array
  try {
    if (filters.some((f) => !['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx', 'RunLengthDecode', 'RL'].includes(f))) {
      return { fail: 'the image uses an unsupported filter' }
    }
    data = Uint8Array.from(streamBytes(stream))
  } catch (e) {
    return { fail: `the image data could not be decoded (${e instanceof Error ? e.message : String(e)})` }
  }

  let n = 1
  let bpc = num(dget(dict, 'BitsPerComponent')) ?? (stencil ? 1 : 0)
  let cs: Cs | null = null
  if (stencil) bpc = 1
  else if (mode === 'alpha') {
    n = 1
    if (![1, 2, 4, 8, 16].includes(bpc)) return { fail: 'the soft mask has an unsupported bit depth' }
  } else {
    cs = parseCs(pdf, dict.get(N('ColorSpace')), job.resources)
    if (!cs) return { fail: 'the image colour space is not supported for safe editing' }
    n = cs.indexed ? 1 : cs.n
    if (![1, 2, 4, 8, 16].includes(bpc)) return { fail: 'the image has an unsupported bit depth' }
    if (cs.indexed && bpc > 8) return { fail: 'the image has an unsupported bit depth' }
  }
  const l = layoutOf(w, h, n, bpc)
  if (data.length < l.rowBytes * h) {
    // truncated data: pad so every covered pixel can be written (missing rows show as black anyway)
    const grown = new Uint8Array(l.rowBytes * h)
    grown.set(data)
    data = grown
  }
  const maxv = 2 ** bpc - 1
  const dec = decodePairs(dict, n)
  if (dec === null) return { fail: 'the image has an unusual Decode array' }

  let sample: number[]
  let colorSpaceOverride: PDFObject | undefined
  if (stencil) {
    // painted samples are 0 with the default Decode [0 1], 1 with [1 0]
    const d = dec === 'default' ? [0, 1] : dec[0]
    sample = [d[0] === 1 && d[1] === 0 ? 1 : 0]
  } else if (mode === 'alpha') {
    const d = dec === 'default' ? [0, 1] : dec[0]
    sample = [sampleFor(1, d[0], d[1], maxv)]
  } else if (cs!.indexed) {
    if (dec !== 'default') return { fail: 'an indexed image has a Decode array' }
    const ix = cs!.indexed
    const bn = ix.base.n
    const isBlack = (i: number): boolean => {
      const o = i * bn
      switch (ix.base.kind) {
        case 'gray':
          return ix.lookup[o] === 0
        case 'rgb':
          return ix.lookup[o] === 0 && ix.lookup[o + 1] === 0 && ix.lookup[o + 2] === 0
        case 'cmyk':
          return ix.lookup[o] === 0 && ix.lookup[o + 1] === 0 && ix.lookup[o + 2] === 0 && ix.lookup[o + 3] === 255
      }
    }
    let idx = -1
    for (let i = 0; i <= ix.hival; i++) {
      if (isBlack(i)) {
        idx = i
        break
      }
    }
    if (idx >= 0) sample = [idx]
    else if (ix.hival + 1 <= maxv) {
      // add black to the palette (nothing else changes)
      const black = new Uint8Array(bn)
      if (ix.base.kind === 'cmyk') black[3] = 255
      const lookup = new Uint8Array((ix.hival + 2) * bn)
      lookup.set(ix.lookup.subarray(0, (ix.hival + 1) * bn))
      lookup.set(black, (ix.hival + 1) * bn)
      const arr = pdf.context.obj([N('Indexed'), (cs!.obj as PDFArray).get(1), ix.hival + 1, PDFHexString.of(Array.from(lookup, (b) => b.toString(16).padStart(2, '0')).join(''))] as never)
      colorSpaceOverride = arr
      sample = [ix.hival + 1]
    } else {
      // no room: expand to the base colour space (8 bits per component)
      const bl = layoutOf(w, h, bn, 8)
      const outData = new Uint8Array(bl.rowBytes * h)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = Math.min(readSample(data, l, x, y, 0), ix.hival)
          for (let c = 0; c < bn; c++) outData[y * bl.rowBytes + x * bn + c] = ix.lookup[i * bn + c]
        }
      }
      data = outData
      const black = new Array<number>(bn).fill(0)
      if (ix.base.kind === 'cmyk') black[3] = 255
      const pixels = fillSpans(data, bl, spans, black)
      const lit = copyDict(dict, { ColorSpace: ix.base.obj, BitsPerComponent: PDFNumber.of(8), Decode: null })
      return finishRaw(job, lit, data, pixels)
    }
  } else {
    const kind = cs!.kind
    const desired = kind === 'cmyk' ? [0, 0, 0, 1] : new Array<number>(n).fill(0)
    sample = desired.map((v, i) => {
      const d = dec === 'default' ? [0, 1] : dec[i]
      return sampleFor(v, d[0], d[1], maxv)
    })
  }
  const pixels = fillSpans(data, l, spans, sample)
  const extra: Record<string, PDFObject | null> = {}
  if (colorSpaceOverride) extra['ColorSpace'] = colorSpaceOverride
  return finishRaw(job, copyDict(dict, extra), data, pixels)
}

function finishRaw(job: Job, lit: Record<string, PDFObject>, data: Uint8Array, pixels: number): ImageResult {
  const s = job.pdf.context.flateStream(data, lit as never)
  return { ref: job.pdf.context.register(s), pixels }
}

/**
 * Redacts the image `stream` as drawn with `ctm` under `marks`. On success the returned reference is a NEW
 * image object (the original is left alone, so images shared with other pages or uses are unaffected).
 */
export function redactImage(pdf: PDFDocument, stream: PDFStream, ctm: Matrix, marks: readonly Rect[], resources?: PDFDict): ImageResult {
  const job: Job = { pdf, ctm, marks, resources }
  const main = processOne(job, stream, 'image')
  if ('fail' in main) return main
  const created: PDFRef[] = [main.ref]
  const fail = (reason: string): ImageResult => {
    for (const r of created) pdf.context.delete(r)
    return { fail: reason }
  }
  const obj = pdf.context.lookup(main.ref)
  if (!(obj instanceof PDFStream)) return fail('internal error')
  // Soft mask and explicit stencil mask: clear the same region so they cannot carry the shape.
  for (const [key, mode] of [['SMask', 'alpha'], ['Mask', 'stencil']] as const) {
    const raw = obj.dict.get(N(key))
    const target = raw instanceof PDFRef ? pdf.context.lookup(raw) : raw
    if (target instanceof PDFStream) {
      const r = processOne(job, target, mode)
      if ('fail' in r) return fail(`its ${key === 'SMask' ? 'soft mask' : 'mask'}: ${r.fail}`)
      created.push(r.ref)
      obj.dict.set(N(key), r.ref)
    } else if (key === 'SMask' && raw) obj.dict.delete(N(key))
  }
  // Nested masks inside a soft mask (Matte etc.) are not followed; a soft mask with its own /SMask is unsupported.
  return { ref: main.ref, pixels: main.pixels }
}

/** Reads the (decoded) sample of pixel (x,y) of a non-JPEG image object; used by the verifier and tests. */
export interface DecodedImage {
  width: number
  height: number
  /** Per pixel: colour components normalised 0..255 (gray = 1 value, rgb = 3, cmyk = 4). */
  components: number
  data: Uint8Array
}

/**
 * Decodes an image object into 8-bit samples for inspection (Flate-family and JPEG; Indexed is expanded to its
 * base space). Returns null when the image cannot be decoded here.
 */
export function decodeImage(pdf: PDFDocument, stream: PDFStream, resources?: PDFDict): DecodedImage | null {
  const dict = stream.dict
  const w = num(dget(dict, 'Width'))
  const h = num(dget(dict, 'Height'))
  if (!w || !h) return null
  const filters = filtersOf(dict)
  if (filters.includes('DCTDecode')) {
    try {
      const d = jpegjs.decode(stream instanceof PDFRawStream ? stream.contents : streamBytes(stream), { useTArray: true, formatAsRGBA: true })
      const out = new Uint8Array(w * h * 3)
      for (let i = 0; i < w * h; i++) {
        out[i * 3] = d.data[i * 4]
        out[i * 3 + 1] = d.data[i * 4 + 1]
        out[i * 3 + 2] = d.data[i * 4 + 2]
      }
      return { width: d.width, height: d.height, components: 3, data: out }
    } catch {
      return null
    }
  }
  let data: Uint8Array
  try {
    data = streamBytes(stream)
  } catch {
    return null
  }
  const stencil = dget(dict, 'ImageMask') instanceof PDFBool && (dget(dict, 'ImageMask') as PDFBool).asBoolean()
  const bpc = stencil ? 1 : (num(dget(dict, 'BitsPerComponent')) ?? 8)
  const cs = stencil ? ({ kind: 'gray', n: 1, obj: N('DeviceGray') } as Cs) : parseCs(pdf, dict.get(N('ColorSpace')), resources)
  if (!cs) return null
  const n = cs.indexed ? 1 : cs.n
  const l = layoutOf(w, h, n, bpc)
  const maxv = 2 ** bpc - 1
  const outN = cs.indexed ? cs.indexed.base.n : n
  const out = new Uint8Array(w * h * outN)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < outN; c++) {
        if (cs.indexed) {
          const i = Math.min(readSample(data, l, x, y, 0), cs.indexed.hival)
          out[(y * w + x) * outN + c] = cs.indexed.lookup[i * outN + c]
        } else out[(y * w + x) * outN + c] = Math.round((readSample(data, l, x, y, c) / maxv) * 255)
      }
    }
  }
  return { width: w, height: h, components: outN, data: out }
}
