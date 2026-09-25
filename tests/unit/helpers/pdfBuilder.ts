import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, PDFName, PDFRef, StandardFonts, rgb, type PDFObject, type PDFPage } from 'pdf-lib'
import { analyzePage } from '../../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks } from '../../../src/renderer/src/features/textedit/pdfcontent/blocks'

/** Helpers that assemble PDFs the way real producers do, so tests exercise real-world shapes. */

export const NOTO_DIR = resolve('src/renderer/src/features/textedit/fonts')
export const notoBytes = (variant = 'Regular'): Uint8Array => new Uint8Array(readFileSync(resolve(NOTO_DIR, `NotoSans-${variant}.ttf`)))

export type Lit = Record<string, unknown>

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
export async function buildPdf(pages: PageSpec[], setup?: (doc: PDFDocument) => void): Promise<{ doc: PDFDocument; bytes: Uint8Array }> {
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
