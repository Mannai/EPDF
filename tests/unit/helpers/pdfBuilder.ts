import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, PDFName, PDFRef, StandardFonts, rgb, type PDFObject, type PDFPage } from 'pdf-lib'
import { analyzePage } from '../../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks } from '../../../src/renderer/src/features/textedit/pdfcontent/blocks'

/** Helpers that assemble PDFs the way real producers do, so tests exercise real-world shapes. */

export const NOTO_DIR = resolve('src/renderer/src/features/textedit/fonts')
export const notoBytes = (variant = 'Regular'): Uint8Array => new Uint8Array(readFileSync(resolve(NOTO_DIR, `NotoSans-${variant}.ttf`)))

export type Lit = Record<string, unknown>
export interface Pdf {
  doc: PDFDocument
  bytes: Uint8Array
}

export interface PageSpec {
  size?: [number, number]
  /** One string per content stream (a page with several streams gets an array /Contents). */
  content: string | string[]
  fonts?: Record<string, PDFRef | Lit>
  xobjects?: Record<string, PDFRef | Lit>
  rotate?: number
}

export const str2bytes = (s: string): Uint8Array => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff))

export function register(doc: PDFDocument, lit: Lit | PDFObject): PDFRef {
  return doc.context.register(doc.context.obj(lit as never))
}

export function stream(doc: PDFDocument, content: string | Uint8Array, dict: Lit = {}, flate = true): PDFRef {
  const bytes = typeof content === 'string' ? str2bytes(content) : content
  const s = flate ? doc.context.flateStream(bytes, dict as never) : doc.context.stream(bytes, dict as never)
  return doc.context.register(s)
}

/** Builds a document from page specs, all objects hand-made (no pdf-lib drawing helpers). */
export async function buildPdf(pages: PageSpec[], setup?: (doc: PDFDocument) => void): Promise<Pdf> {
  const doc = await PDFDocument.create()
  setup?.(doc)
  for (const spec of pages) {
    const page = doc.addPage(spec.size ?? [612, 792])
    if (spec.rotate) page.node.set(PDFName.of('Rotate'), doc.context.obj(spec.rotate))
    const contents = Array.isArray(spec.content) ? spec.content : [spec.content]
    const refs = contents.map((c) => stream(doc, c))
    page.node.set(PDFName.of('Contents'), refs.length === 1 && !Array.isArray(spec.content) ? refs[0] : doc.context.obj(refs))
    const fonts: Record<string, PDFObject> = {}
    for (const [k, v] of Object.entries(spec.fonts ?? {})) fonts[k] = v instanceof PDFRef ? v : register(doc, v)
    const xo: Record<string, PDFObject> = {}
    for (const [k, v] of Object.entries(spec.xobjects ?? {})) xo[k] = v instanceof PDFRef ? v : register(doc, v)
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: fonts, XObject: xo }))
  }
  return { doc, bytes: await doc.save() }
}

// ---- font dictionaries ---------------------------------------------------------------------------------------

export const helvetica = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }
export const times = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: 'WinAnsiEncoding' }
export const courier = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier', Encoding: 'WinAnsiEncoding' }

/** A ToUnicode CMap for a 1-byte code → Unicode list. */
export function toUnicodeCMap(pairs: [number, string][], bytes = 1): string {
  const hex = (n: number): string => n.toString(16).padStart(bytes * 2, '0').toUpperCase()
  const u = (s: string): string => Array.from(s).map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase()
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    `<${'00'.repeat(bytes)}> <${'FF'.repeat(bytes)}>`,
    'endcodespacerange',
    `${pairs.length} beginbfchar`,
    ...pairs.map(([c, s]) => `<${hex(c)}> <${u(s)}>`),
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineResource pop',
    'end',
    'end'
  ].join('\n')
}

/**
 * A subset TrueType-style simple font as Word/LibreOffice write it: `ABCDEF+` name, /Widths for a code range,
 * WinAnsi + /Differences, /ToUnicode. Not embedded (no font program) so it renders with a substitute, which is
 * enough for text-level tests.
 */
export function subsetSimpleFont(doc: PDFDocument, opts: { name?: string; codes: Record<number, string>; width?: number; differences?: (number | string)[] }): PDFRef {
  const first = Math.min(...Object.keys(opts.codes).map(Number))
  const last = Math.max(...Object.keys(opts.codes).map(Number))
  const widths = Array.from({ length: last - first + 1 }, (_, i) => (opts.codes[first + i] !== undefined ? (opts.width ?? 500) : 0))
  const toUni = stream(doc, toUnicodeCMap(Object.entries(opts.codes).map(([c, s]) => [Number(c), s] as [number, string])))
  const desc = register(doc, {
    Type: 'FontDescriptor',
    FontName: opts.name ?? 'ABCDEF+Arial',
    Flags: 32,
    FontBBox: [-665, -325, 2000, 1006],
    ItalicAngle: 0,
    Ascent: 905,
    Descent: -212,
    CapHeight: 716,
    StemV: 80
  })
  return register(doc, {
    Type: 'Font',
    Subtype: 'TrueType',
    BaseFont: opts.name ?? 'ABCDEF+Arial',
    FirstChar: first,
    LastChar: last,
    Widths: widths,
    FontDescriptor: desc,
    ToUnicode: toUni,
    ...(opts.differences ? { Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: opts.differences.map((d) => (typeof d === 'string' ? PDFName.of(d) : d)) } } : { Encoding: 'WinAnsiEncoding' })
  })
}

/** A Chrome/Skia-style Type0 Identity-H font: 2-byte glyph ids, /W array, /ToUnicode bfrange. */
export function type0Font(doc: PDFDocument, opts: { name?: string; glyphs: Record<number, string>; width?: number; subset?: boolean }): PDFRef {
  const gids = Object.keys(opts.glyphs).map(Number).sort((a, b) => a - b)
  const wArr = gids.flatMap((g) => [g, [opts.width ?? 600]])
  const toUni = stream(doc, toUnicodeCMap(gids.map((g) => [g, opts.glyphs[g]] as [number, string]), 2))
  const name = `${opts.subset === false ? '' : 'AAAAAA+'}${opts.name ?? 'Roboto-Regular'}`
  const desc = register(doc, { Type: 'FontDescriptor', FontName: name, Flags: 4, FontBBox: [-100, -300, 1200, 1000], ItalicAngle: 0, Ascent: 927, Descent: -244, CapHeight: 711, StemV: 80 })
  const cid = register(doc, { Type: 'Font', Subtype: 'CIDFontType2', BaseFont: name, CIDSystemInfo: { Registry: 'Adobe' as unknown, Ordering: 'Identity', Supplement: 0 }, FontDescriptor: desc, DW: 1000, W: wArr, CIDToGIDMap: 'Identity' })
  return register(doc, { Type: 'Font', Subtype: 'Type0', BaseFont: name, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: toUni })
}

// ---- pdf-lib generated documents ---------------------------------------------------------------------

export async function pdfLibDoc(build: (doc: PDFDocument, page: PDFPage) => void | Promise<void>, size: [number, number] = [612, 792]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const page = doc.addPage(size)
  await build(doc, page)
  return doc.save()
}

export async function sampleTextPdf(): Promise<Uint8Array> {
  return pdfLibDoc(async (doc, page) => {
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('Hello world from Epdf', { x: 72, y: 700, size: 24, font, color: rgb(0, 0, 0) })
    page.drawText('The quick brown fox jumps over the lazy dog.', { x: 72, y: 640, size: 14, font })
  })
}

// ---- pictures ------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A valid solid-colour PNG (8-bit RGB), built by hand so tests need no image library. */
export function makePng(w: number, h: number, color: [number, number, number] = [200, 30, 30]): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = new Uint8Array((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(color, y * (w * 3 + 1) + 1 + x * 3)
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** A structurally valid baseline JPEG header + payload (enough for embedding; not meant to be decoded). */
export function makeFakeJpeg(w: number, h: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0x7f, 0x7f, 0xff, 0xd9
  ])
}

/** Adds a raw RGB image XObject to a document and returns its reference. */
export function addRawImage(doc: PDFDocument, w: number, h: number): PDFRef {
  return doc.context.register(
    doc.context.stream(new Uint8Array(w * h * 3).fill(120), { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 } as never)
  )
}

// ---- reading back --------------------------------------------------------------------------------------

/** All line texts on a page as the engine reads them (which is what a text extractor would return). */
export async function pageLines(bytes: Uint8Array, pageIndex = 0): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  const a = analyzePage(doc, pageIndex)
  return buildBlocks(a).lines.map((b) => b.text)
}

/** The raw text of every stream of a page (decoded), for asserting operators. */
export async function pageStreams(bytes: Uint8Array, pageIndex = 0): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  const a = analyzePage(doc, pageIndex)
  return [...a.sources.values()].flatMap((s) => s.slots.map((sl) => sl.ops.map((o) => o.op).join(' ')))
}
