import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFContext, type PDFObject } from 'pdf-lib'
import type { ImageCodec } from './codec'
import { encodeJpeg } from './jpegEncode'
import { estimateJpegQuality, parseJpegInfo } from './jpegInfo'
import type { CompressOptions } from './options'
import { applyPngPredictor, isPhotographic, packSamples, resizeBox, rowBytes as rowRawBytes, unpackSamples } from './raster'
import type { ImageUse } from './scan'
import { N, decodeStream, deflateMax, encodedBytes, filterNames, hasImageCodec, nameOf, numArray, numOf, resolve } from './streams'

/**
 * Image recompression: finds what can be made smaller without visible harm and produces the replacement stream.
 * Rules (each protects something a naive "recompress everything" tool would destroy):
 *  - resolution comes from the placement (see scan.ts); images used where it is unknown are never resampled;
 *  - lossy JPEG only for photographic DeviceGray / DeviceRGB / DeviceCMYK / ICCBased(1|3|4) images without colour-key masks;
 *  - soft masks (SMask), explicit masks and stencil masks are resampled on their own, never turned into JPEG;
 *  - /Decode, /ColorSpace (ICC, Cal*, Separation, DeviceN, Lab), /Intent, /Interpolate are kept as they were;
 *  - Indexed images are only touched when they must be resampled, and then expanded to their base colour space;
 *  - the replacement is used only if it is smaller.
 */

export type CsKind = 'gray' | 'rgb' | 'cmyk' | 'indexed' | 'other'

export interface CsInfo {
  kind: CsKind
  ncomp: number
  /** Indexed only. */
  base?: CsInfo
  baseObj?: PDFObject
  hival?: number
  palette?: Uint8Array
}

export function csInfo(ctx: PDFContext, o: PDFObject | undefined, depth = 0): CsInfo | null {
  const v = resolve(ctx, o)
  if (depth > 3) return null
  if (v instanceof PDFName) {
    const n = nameOf(ctx, v)
    if (n === 'DeviceGray' || n === 'G' || n === 'CalGray') return { kind: 'gray', ncomp: 1 }
    if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB') return { kind: 'rgb', ncomp: 3 }
    if (n === 'DeviceCMYK' || n === 'CMYK') return { kind: 'cmyk', ncomp: 4 }
    return null
  }
  if (!(v instanceof PDFArray) || v.size() < 1) return null
  const head = nameOf(ctx, v.get(0))
  switch (head) {
    case 'CalGray':
      return { kind: 'gray', ncomp: 1 }
    case 'CalRGB':
      return { kind: 'rgb', ncomp: 3 }
    case 'Lab':
      return { kind: 'other', ncomp: 3 }
    case 'Separation':
      return { kind: 'other', ncomp: 1 }
    case 'DeviceN': {
      const names = resolve(ctx, v.get(1))
      return names instanceof PDFArray && names.size() > 0 ? { kind: 'other', ncomp: names.size() } : null
    }
    case 'ICCBased': {
      const st = resolve(ctx, v.get(1))
      const n = st instanceof PDFStream ? numOf(ctx, st.dict.get(N('N'))) : undefined
      if (n === 1) return { kind: 'gray', ncomp: 1 }
      if (n === 3) return { kind: 'rgb', ncomp: 3 }
      if (n === 4) return { kind: 'cmyk', ncomp: 4 }
      return n && n > 0 && n <= 32 ? { kind: 'other', ncomp: n } : null
    }
    case 'Indexed':
    case 'I': {
      const base = csInfo(ctx, v.get(1), depth + 1)
      const hival = numOf(ctx, v.get(2))
      const lk = resolve(ctx, v.get(3))
      let palette: Uint8Array | undefined
      if (lk instanceof PDFString || lk instanceof PDFHexString) palette = lk.asBytes()
      else if (lk instanceof PDFStream) palette = decodeStream(ctx, lk) ?? undefined
      if (!base || base.kind === 'indexed' || hival === undefined || !palette) return null
      return { kind: 'indexed', ncomp: 1, base, baseObj: v.get(1), hival, palette }
    }
  }
  return null
}

export interface ImageDesc {
  w: number
  h: number
  bpc: number
  isMask: boolean
  cs: CsInfo | null
  decode: number[] | null
  filters: string[]
  /** Colour-key mask (/Mask given as an array): sample values are significant, so no resampling / lossy coding. */
  colorKey: boolean
  smaskRef: PDFRef | null
  /** This image is a soft mask with a /Matte (premultiplied colours): left alone together with its parent. */
  matte: boolean
  bytes: number
}

const isImage = (ctx: PDFContext, st: PDFStream): boolean => nameOf(ctx, st.dict.get(N('Subtype'))) === 'Image'

/** Reads the parts of an image dictionary the optimiser cares about (null if it is not a usable image). */
export function describeImage(ctx: PDFContext, st: PDFStream): ImageDesc | null {
  if (!isImage(ctx, st)) return null
  const d = st.dict
  const w = numOf(ctx, d.get(N('Width')))
  const h = numOf(ctx, d.get(N('Height')))
  if (!w || !h || w < 1 || h < 1 || w > 65535 * 4 || h > 65535 * 4 || w * h > 1.2e9) return null
  const im = resolve(ctx, d.get(N('ImageMask')))
  const isMask = im instanceof PDFBool && im.asBoolean()
  const bpc = isMask ? 1 : (numOf(ctx, d.get(N('BitsPerComponent'))) ?? 8)
  const mask = resolve(ctx, d.get(N('Mask')))
  const sm = d.get(N('SMask'))
  return {
    w,
    h,
    bpc,
    isMask,
    cs: isMask ? { kind: 'gray', ncomp: 1 } : csInfo(ctx, d.get(N('ColorSpace'))),
    decode: numArray(ctx, d.get(N('Decode'))),
    filters: filterNames(ctx, d),
    colorKey: mask instanceof PDFArray,
    smaskRef: sm instanceof PDFRef ? sm : null,
    matte: d.has(N('Matte')),
    bytes: encodedBytes(st).length
  }
}

export type ImageRole = 'image' | 'smask'

export type ImageOutcome =
  | { kind: 'replaced'; stream: PDFRawStream; downsampled: boolean; coding: 'jpeg' | 'flate'; before: number; after: number }
  | { kind: 'skipped'; reason: string }

const skip = (reason: string): ImageOutcome => ({ kind: 'skipped', reason })

/** Target size when the image is used at a resolution above the threshold, else null. */
export function downsampleTarget(desc: ImageDesc, use: ImageUse | null, maxDpi: number, factor: number): { nw: number; nh: number } | null {
  if (!use) return null
  const over = use.dpiX > maxDpi * factor || use.dpiY > maxDpi * factor
  if (!over) return null
  const nw = Math.max(1, Math.min(desc.w, Math.round(desc.w * Math.min(1, maxDpi / use.dpiX))))
  const nh = Math.max(1, Math.min(desc.h, Math.round(desc.h * Math.min(1, maxDpi / use.dpiY))))
  return nw < desc.w || nh < desc.h ? { nw, nh } : null
}

const MONO_INK_THRESHOLD = 0.35 * 255

function buildDict(ctx: PDFContext, src: PDFDict, set: Record<string, PDFObject | number | string>, drop: string[] = []): PDFDict {
  const out = ctx.obj({}) as PDFDict
  const skipKeys = new Set(['Length', 'Filter', 'DecodeParms', 'F', 'DP', 'DL', ...Object.keys(set), ...drop])
  for (const [k, v] of src.entries()) {
    const key = k.decodeText()
    if (!skipKeys.has(key)) out.set(k, v)
  }
  for (const [k, v] of Object.entries(set)) out.set(N(k), typeof v === 'object' ? v : (ctx.obj(v as never) as PDFObject))
  return out
}

function finish(dict: PDFDict, bytes: Uint8Array): PDFRawStream {
  dict.set(N('Length'), PDFNumber.of(bytes.length))
  return PDFRawStream.of(dict, bytes)
}

/** Flate data for 8-bit interleaved samples, using the best of "PNG filters" and "none". */
function flateSamples(ctx: PDFContext, px: Uint8Array, w: number, ncomp: number): { bytes: Uint8Array; parms: PDFDict } {
  const rb = w * ncomp
  const filtered = applyPngPredictor(px, rb, ncomp)
  const parms = ctx.obj({ Predictor: 15, Colors: ncomp, BitsPerComponent: 8, Columns: w }) as PDFDict
  return { bytes: deflateMax(filtered), parms }
}

/** Expands Indexed samples to the base colour space (8-bit components). */
function expandIndexed(idx: Uint8Array, cs: CsInfo, npix: number): Uint8Array | null {
  const base = cs.base!
  const n = base.ncomp
  const pal = cs.palette!
  const hival = Math.min(255, cs.hival ?? 255)
  const out = new Uint8Array(npix * n)
  for (let i = 0; i < npix; i++) {
    const k = Math.min(idx[i], hival)
    const o = k * n
    for (let c = 0; c < n; c++) out[i * n + c] = pal[o + c] ?? 0
  }
  return out
}

function rawSamples(ctx: PDFContext, st: PDFStream, desc: ImageDesc): Uint8Array | null {
  const raw = decodeStream(ctx, st)
  if (!raw) return null
  const need = rowRawBytes(desc.w, desc.cs?.ncomp ?? 1, desc.bpc) * desc.h
  return raw.length >= need ? raw : null
}

/** Decides and (if worthwhile) builds a replacement for one image. Never throws for bad image data: returns a skip. */
export async function optimizeImage(
  ctx: PDFContext,
  st: PDFStream,
  desc: ImageDesc,
  use: ImageUse | null,
  role: ImageRole,
  opts: CompressOptions,
  codec: ImageCodec
): Promise<ImageOutcome> {
  try {
    return await optimizeImageInner(ctx, st, desc, use, role, opts, codec)
  } catch (err) {
    return skip(`error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function optimizeImageInner(
  ctx: PDFContext,
  st: PDFStream,
  desc: ImageDesc,
  use: ImageUse | null,
  role: ImageRole,
  opts: CompressOptions,
  codec: ImageCodec
): Promise<ImageOutcome> {
  if (desc.bytes < opts.minImageBytes) return skip('small')
  if (desc.matte) return skip('matte')
  const filters = desc.filters
  const isDct = filters.length === 1 && filters[0] === 'DCTDecode'
  if (filters.includes('DCTDecode') && !isDct) return skip('chained-dct')
  if (!isDct && hasImageCodec(filters)) return skip('codec')
  const cs = desc.cs
  if (!cs) return skip('colorspace')
  if (desc.bpc !== 1 && desc.bpc !== 2 && desc.bpc !== 4 && desc.bpc !== 8) return skip('bit-depth')
  const inkDecode = desc.decode && desc.decode.length >= 2 && desc.decode[0] > desc.decode[1]
  const mono = desc.isMask || (desc.bpc === 1 && cs.kind === 'gray')
  const maxDpi = mono ? opts.monoDpi : opts.colorDpi
  const target = desc.colorKey ? null : downsampleTarget(desc, use, maxDpi, opts.downsampleFactor)
  const before = desc.bytes
  const d = st.dict

  // ---- stencil masks and 1-bit gray images -------------------------------------------------------------
  if (mono) {
    if (!target || isDct) return skip('mono-nochange')
    const raw = rawSamples(ctx, st, desc)
    if (!raw) return skip('undecodable')
    const bits = unpackSamples(raw, desc.w, desc.h, 1, 1, false)
    const inkValue = inkDecode ? 1 : 0
    const map = new Uint8Array(desc.w * desc.h)
    for (let i = 0; i < map.length; i++) map[i] = bits[i] === inkValue ? 255 : 0
    const small = resizeBox(map, desc.w, desc.h, 1, target.nw, target.nh)
    const out = new Uint8Array(small.length)
    for (let i = 0; i < out.length; i++) out[i] = small[i] >= MONO_INK_THRESHOLD ? inkValue : 1 - inkValue
    const bytes = deflateMax(packSamples(out, target.nw, target.nh, 1, 1))
    if (bytes.length >= before) return skip('not-smaller')
    const dict = buildDict(ctx, d, { Width: target.nw, Height: target.nh, BitsPerComponent: 1, Filter: N('FlateDecode') })
    return { kind: 'replaced', stream: finish(dict, bytes), downsampled: true, coding: 'flate', before, after: bytes.length }
  }

  // ---- colour / gray / other -----------------------------------------------------------------------------
  if (cs.kind === 'indexed') {
    if (!target || isDct) return skip('indexed-nochange')
    if (cs.base!.kind === 'other' || desc.decode) return skip('indexed-unsupported')
  }
  const lossyCs = cs.kind === 'gray' || cs.kind === 'rgb' || cs.kind === 'cmyk'
  const lossy = role === 'image' && lossyCs && !desc.colorKey

  let px: Uint8Array
  let ncomp = cs.kind === 'indexed' ? cs.base!.ncomp : cs.ncomp
  let w = desc.w
  let h = desc.h
  let photo = false
  let srcQuality = 100

  if (isDct) {
    const bytes = encodedBytes(st)
    const info = parseJpegInfo(bytes)
    if (!info || info.unsupported || info.precision !== 8) return skip('jpeg-unsupported')
    if (info.width !== desc.w || info.height !== desc.h || info.ncomp !== cs.ncomp) return skip('jpeg-mismatch')
    if (!lossy) return skip('jpeg-not-lossy')
    const parms = resolve(ctx, d.get(N('DecodeParms')))
    if (parms instanceof PDFDict && parms.has(N('ColorTransform'))) return skip('jpeg-colortransform')
    srcQuality = estimateJpegQuality(info.quant0)
    const wantRequant = opts.recompressJpeg && srcQuality >= opts.jpegQuality + 8
    if (!target && !wantRequant) return skip('jpeg-ok')
    const r = await codec.decodeJpeg(bytes, info)
    if (r.width !== desc.w || r.height !== desc.h || r.ncomp !== cs.ncomp) return skip('jpeg-decode-mismatch')
    px = r.data
    photo = true
  } else {
    const raw = rawSamples(ctx, st, desc)
    if (!raw) return skip('undecodable')
    px = unpackSamples(raw, desc.w, desc.h, cs.ncomp, desc.bpc, cs.kind !== 'indexed')
    if (cs.kind === 'indexed') {
      const e = expandIndexed(px, cs, desc.w * desc.h)
      if (!e) return skip('indexed-unsupported')
      px = e
    }
    photo = lossy && isPhotographic(px, desc.w * desc.h, ncomp)
    if (!target && !photo) return skip('nochange')
  }

  if (target) {
    px = resizeBox(px, w, h, ncomp, target.nw, target.nh)
    w = target.nw
    h = target.nh
  }

  const colorSpaceSet: Record<string, PDFObject> = {}
  const drop: string[] = []
  if (cs.kind === 'indexed') {
    colorSpaceSet['ColorSpace'] = cs.baseObj!
    drop.push('Decode')
  }

  let bytes: Uint8Array
  let dict: PDFDict
  let coding: 'jpeg' | 'flate'
  if (photo && lossy) {
    bytes = encodeJpeg(w, h, ncomp as 1 | 3 | 4, px, { quality: opts.jpegQuality })
    dict = buildDict(ctx, d, { Width: w, Height: h, BitsPerComponent: 8, Filter: N('DCTDecode'), ...colorSpaceSet }, drop)
    coding = 'jpeg'
    const gain = isDct && !target ? 0.9 : 0.98
    if (bytes.length >= before * gain) return skip('not-smaller')
  } else {
    const f = flateSamples(ctx, px, w, ncomp)
    bytes = f.bytes
    dict = buildDict(ctx, d, { Width: w, Height: h, BitsPerComponent: 8, Filter: N('FlateDecode'), DecodeParms: f.parms, ...colorSpaceSet }, drop)
    coding = 'flate'
    if (bytes.length >= before * 0.98) return skip('not-smaller')
  }
  return { kind: 'replaced', stream: finish(dict, bytes), downsampled: !!target, coding, before, after: bytes.length }
}

/** Sanity check used by tests and the pipeline: dictionary of an image stream is consistent with its (decodable) data. */
export function imageDataIsConsistent(ctx: PDFContext, st: PDFStream): boolean {
  const desc = describeImage(ctx, st)
  if (!desc || !desc.cs) return false
  if (desc.filters.length === 1 && desc.filters[0] === 'DCTDecode') {
    const info = parseJpegInfo(encodedBytes(st))
    return !!info && info.width === desc.w && info.height === desc.h && info.ncomp === desc.cs.ncomp
  }
  const raw = decodeStream(ctx, st)
  return !!raw && raw.length >= rowRawBytes(desc.w, desc.cs.ncomp, desc.bpc) * desc.h
}
