import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from 'pdf-lib'
import { name as nameObj, parseContent, serializeContent, type Op, type PdfObj } from '../../textedit/pdfcontent/content'
import { N, decodeStream, deflateMax, nameOf, refKey, resolve } from './streams'

/**
 * Large inline images (BI ... ID ... EI) cannot be resampled in place, and their size on the page is only known from the
 * content stream. They are turned into ordinary image XObjects (byte-for-byte the same pixel data, same colour space, same
 * placement) so that the normal image pipeline treats them like any other picture. Small inline images (icons, glyph
 * bitmaps) are left alone: converting them would not pay for itself.
 */

const KEY: Record<string, string> = {
  W: 'Width',
  H: 'Height',
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  D: 'Decode',
  DP: 'DecodeParms',
  F: 'Filter',
  IM: 'ImageMask',
  I: 'Interpolate'
}
const FILTER: Record<string, string> = { AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode' }
const CS_NAME: Record<string, string> = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' }

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

function toPdf(ctx: PDFContext, o: PdfObj, mapName: (n: string) => string): PDFObject {
  switch (o.t) {
    case 'num':
      return PDFNumber.of(o.v)
    case 'bool':
      return ctx.obj(o.v)
    case 'null':
      return ctx.obj(null)
    case 'name':
      return PDFName.of(mapName(o.v))
    case 'str':
      return PDFHexString.of(hex(o.b))
    case 'arr': {
      const a = ctx.obj([]) as PDFArray
      for (const x of o.v) a.push(toPdf(ctx, x, mapName))
      return a
    }
    case 'dict': {
      const d = ctx.obj({}) as PDFDict
      for (const [k, v] of o.v) d.set(PDFName.of(k), toPdf(ctx, v, mapName))
      return d
    }
  }
}

function hasBI(b: Uint8Array): boolean {
  for (let i = 1; i + 2 < b.length; i++) {
    if (b[i] === 0x42 && b[i + 1] === 0x49 && (b[i - 1] <= 32 || b[i - 1] === 0x3e || b[i - 1] === 0x5d) && b[i + 2] <= 32) return true
  }
  return b.length >= 2 && b[0] === 0x42 && b[1] === 0x49
}

function convertStream(ctx: PDFContext, ref: PDFRef, st: PDFStream, getRes: () => PDFDict, minBytes: number, counter: { n: number }): number {
  if (st.dict.has(N('F')) && !st.dict.has(N('Filter'))) return 0
  const bytes = decodeStream(ctx, st)
  if (!bytes || !hasBI(bytes)) return 0
  let parsed
  try {
    parsed = parseContent(bytes)
  } catch {
    return 0
  }
  if (!parsed.ops.some((o) => o.op === 'BI' && o.inline && o.inline.data.length >= minBytes)) return 0
  const res = getRes()
  const existing = resolve(ctx, res.get(N('XObject')))
  const xo: PDFDict = existing instanceof PDFDict ? existing : (ctx.obj({}) as PDFDict)
  if (xo !== existing) res.set(N('XObject'), xo)
  const csDict = resolve(ctx, res.get(N('ColorSpace')))
  const mapName = (n: string): string => CS_NAME[n] ?? FILTER[n] ?? n
  let converted = 0
  const ops: Op[] = parsed.ops.map((op) => {
    if (op.op !== 'BI' || !op.inline || op.inline.data.length < minBytes) return op
    const dict = ctx.obj({}) as PDFDict
    dict.set(N('Type'), N('XObject'))
    dict.set(N('Subtype'), N('Image'))
    for (const [k, v] of op.inline.dict) {
      const full = KEY[k] ?? k
      if (full === 'ColorSpace' && v.t === 'name' && !CS_NAME[v.v] && v.v !== 'DeviceGray' && v.v !== 'DeviceRGB' && v.v !== 'DeviceCMYK') {
        // a named colour space from the resource dictionary
        const named = csDict instanceof PDFDict ? csDict.get(N(v.v)) : undefined
        if (!named) return op // cannot resolve: leave this image inline
        dict.set(N('ColorSpace'), named)
      } else if (full === 'Filter') {
        dict.set(N('Filter'), toPdf(ctx, v, (n) => FILTER[n] ?? n))
      } else dict.set(N(full), toPdf(ctx, v, mapName))
    }
    if (!dict.has(N('Width')) || !dict.has(N('Height'))) return op
    dict.set(N('Length'), PDFNumber.of(op.inline.data.length))
    const img = ctx.register(PDFRawStream.of(dict, op.inline.data.slice()))
    let nm: string
    do nm = `EpdfInl${++counter.n}`
    while (xo.has(N(nm)))
    xo.set(N(nm), img)
    converted++
    return { op: 'Do', args: [nameObj(nm)], pre: op.pre, raw: null } satisfies Op
  })
  if (!converted) return 0
  const out = deflateMax(serializeContent(ops, parsed.tail))
  const d = ctx.obj({}) as PDFDict
  for (const [k, v] of st.dict.entries()) {
    const key = k.decodeText()
    if (key !== 'Length' && key !== 'Filter' && key !== 'DecodeParms' && key !== 'F' && key !== 'DP') d.set(k, v)
  }
  d.set(N('Filter'), N('FlateDecode'))
  d.set(N('Length'), PDFNumber.of(out.length))
  ctx.assign(ref, PDFRawStream.of(d, out))
  return converted
}

/** A conversion problem must never abort the whole job: that stream simply keeps its inline images. */
function safely(fn: () => number): number {
  try {
    return fn()
  } catch {
    return 0
  }
}

/** Converts inline images of at least `minBytes` data into XObjects on every page and form. Returns how many were converted. */
export function convertInlineImages(pdf: PDFDocument, minBytes = 4096): number {
  const ctx = pdf.context
  const counter = { n: 0 }
  const done = new Set<string>()
  let total = 0
  let pages: ReturnType<PDFDocument['getPages']> = []
  try {
    pages = pdf.getPages()
  } catch {
    return 0
  }
  const contentRefs = (node: PDFDict): PDFRef[] => {
    const c = node.get(N('Contents'))
    const refs: PDFRef[] = []
    if (c instanceof PDFRef) {
      const v = ctx.lookup(c)
      if (v instanceof PDFArray) for (const x of v.asArray()) x instanceof PDFRef && refs.push(x)
      else refs.push(c)
    } else if (c instanceof PDFArray) for (const x of c.asArray()) x instanceof PDFRef && refs.push(x)
    return refs
  }
  // A content stream shared by several pages has one set of resources per page: leave those alone.
  const uses = new Map<string, number>()
  for (const page of pages) for (const r of contentRefs(page.node)) uses.set(refKey(r), (uses.get(refKey(r)) ?? 0) + 1)
  for (const page of pages) {
    const node = page.node
    for (const r of contentRefs(node)) {
      const k = refKey(r)
      if (done.has(k) || (uses.get(k) ?? 0) > 1) continue
      done.add(k)
      const st = ctx.lookup(r)
      if (!(st instanceof PDFStream)) continue
      // Use the page's (possibly inherited) resources; only create an own dictionary when there is none at all.
      const getRes = (): PDFDict => {
        const inherited = node.Resources()
        if (inherited) return inherited
        const fresh = ctx.obj({}) as PDFDict
        node.set(N('Resources'), fresh)
        return fresh
      }
      total += safely(() => convertStream(ctx, r, st, getRes, minBytes, counter))
    }
  }
  // Form XObjects (own resources only).
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream) || nameOf(ctx, obj.dict.get(N('Subtype'))) !== 'Form') continue
    const own = resolve(ctx, obj.dict.get(N('Resources')))
    if (!(own instanceof PDFDict)) continue
    const k = refKey(ref)
    if (done.has(k)) continue
    done.add(k)
    total += safely(() => convertStream(ctx, ref, obj, () => own, minBytes, counter))
  }
  return total
}
