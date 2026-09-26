import fontkit from '@pdf-lib/fontkit'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, PDFName, degrees } from 'pdf-lib'
import { analyzeBidi, reorderVisual } from '../../../src/shared/text/bidi'
import { drawParagraph, drawText } from '../../../src/shared/text/pdf/draw'
import corpus from './corpus.json'

/**
 * Page text fixtures made by Epdf's text engine and by plain pdf-lib (the "old producer" style: pre-shaped Arabic
 * presentation forms stored in visual order). Used by the unit tests directly (in memory) and written to disk by
 * generate.mjs for the end-to-end tests. The caller configures the engine's resources (useNodeResources).
 */

const A4: [number, number] = [595.28, 841.89]

export async function engineLines(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage(A4)
  let y = 800
  for (const l of corpus.lines) {
    const rtl = l.dir === 'rtl'
    await drawText(page, l.text, { x: rtl ? 555 : 40, y, size: 16, fontStack: [l.font], direction: l.dir as 'rtl' | 'ltr', anchor: rtl ? 'right' : undefined })
    y -= 34
  }
  return pdf.save()
}

export async function enginePara(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage(A4)
  let y = 800
  for (const p of corpus.paragraphs) {
    const r = await drawParagraph(page, p.text, { x: 40, y, width: 515, size: 20, fontStack: [p.font], direction: p.dir as 'rtl' | 'ltr', align: 'start', lineSpacing: 1.6 })
    y -= r.height + 30
  }
  return pdf.save()
}

export async function engineColumns(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage(A4)
  const c = corpus.columns
  await drawParagraph(page, c.first, { x: 315, y: 800, width: 240, size: 16, fontStack: [c.font], direction: 'rtl', align: 'start', lineSpacing: 1.5 })
  await drawParagraph(page, c.second, { x: 40, y: 800, width: 240, size: 16, fontStack: [c.font], direction: 'rtl', align: 'start', lineSpacing: 1.5 })
  return pdf.save()
}

export async function engineRotatedText(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage(A4)
  const hello = corpus.lines.find((l) => l.id === 'ar-hello')!
  const date = corpus.lines.find((l) => l.id === 'ar-date')!
  await drawText(page, hello.text, { x: 100, y: 300, size: 18, fontStack: [hello.font], direction: 'rtl', rotate: degrees(90) })
  await drawText(page, date.text, { x: 200, y: 600, size: 16, fontStack: [date.font], direction: 'rtl', rotate: degrees(-30) })
  await drawText(page, 'Rotated Latin text', { x: 500, y: 200, size: 14, fontStack: ['Noto Sans'], rotate: degrees(180) })
  return pdf.save()
}

/** A copy of `bytes` whose pages carry /Rotate `angle` (the content is untouched). */
export async function withRotation(bytes: Uint8Array, angle: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  for (const p of pdf.getPages()) p.setRotation(degrees(angle))
  return pdf.save()
}

// ---- the old-producer style: presentation forms in visual order ------------------------------------------------------

/** [isolated, final, initial, medial] presentation forms; right-joining letters have only the first two. */
const FORMS: Record<string, number[]> = {
  'ء': [0xfe80], 'آ': [0xfe81, 0xfe82], 'أ': [0xfe83, 0xfe84], 'ؤ': [0xfe85, 0xfe86], 'إ': [0xfe87, 0xfe88], 'ئ': [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c],
  'ا': [0xfe8d, 0xfe8e], 'ب': [0xfe8f, 0xfe90, 0xfe91, 0xfe92], 'ة': [0xfe93, 0xfe94], 'ت': [0xfe95, 0xfe96, 0xfe97, 0xfe98], 'ث': [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  'ج': [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0], 'ح': [0xfea1, 0xfea2, 0xfea3, 0xfea4], 'خ': [0xfea5, 0xfea6, 0xfea7, 0xfea8], 'د': [0xfea9, 0xfeaa], 'ذ': [0xfeab, 0xfeac],
  'ر': [0xfead, 0xfeae], 'ز': [0xfeaf, 0xfeb0], 'س': [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4], 'ش': [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8], 'ص': [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  'ض': [0xfebd, 0xfebe, 0xfebf, 0xfec0], 'ط': [0xfec1, 0xfec2, 0xfec3, 0xfec4], 'ظ': [0xfec5, 0xfec6, 0xfec7, 0xfec8], 'ع': [0xfec9, 0xfeca, 0xfecb, 0xfecc],
  'غ': [0xfecd, 0xfece, 0xfecf, 0xfed0], 'ف': [0xfed1, 0xfed2, 0xfed3, 0xfed4], 'ق': [0xfed5, 0xfed6, 0xfed7, 0xfed8], 'ك': [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  'ل': [0xfedd, 0xfede, 0xfedf, 0xfee0], 'م': [0xfee1, 0xfee2, 0xfee3, 0xfee4], 'ن': [0xfee5, 0xfee6, 0xfee7, 0xfee8], 'ه': [0xfee9, 0xfeea, 0xfeeb, 0xfeec],
  'و': [0xfeed, 0xfeee], 'ى': [0xfeef, 0xfef0], 'ي': [0xfef1, 0xfef2, 0xfef3, 0xfef4]
}
const LAM_ALEF: Record<string, number[]> = { 'آ': [0xfef5, 0xfef6], 'أ': [0xfef7, 0xfef8], 'إ': [0xfef9, 0xfefa], 'ا': [0xfefb, 0xfefc] }

const dual = (ch: string | undefined): boolean => !!ch && (FORMS[ch]?.length ?? 0) === 4
const joins = (ch: string | undefined): boolean => !!ch && FORMS[ch] !== undefined && ch !== 'ء'

/** Minimal Arabic shaping to presentation forms (letters of the corpus lines; no marks), in LOGICAL order. */
export function toPresentationForms(text: string): string {
  const cs = [...text]
  let out = ''
  for (let i = 0; i < cs.length; i++) {
    const ch = cs[i]
    const prevJoins = dual(cs[i - 1])
    if (ch === 'ل' && LAM_ALEF[cs[i + 1]]) {
      out += String.fromCharCode(LAM_ALEF[cs[i + 1]][prevJoins ? 1 : 0])
      i++
      continue
    }
    const f = FORMS[ch]
    if (!f) {
      out += ch
      continue
    }
    const nextJoins = f.length === 4 && joins(cs[i + 1])
    const form = prevJoins ? (nextJoins ? 3 : 1) : nextJoins ? 2 : 0
    out += String.fromCharCode(f[Math.min(form, f.length - 1)] ?? f[0])
  }
  return out
}

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '«': '»', '»': '«' }

/** What an old visual-order producer stores: the shaped line reordered for display, mirrored brackets as the shapes drawn. */
export function visualString(logical: string, dir: 'rtl' | 'ltr'): string {
  const info = analyzeBidi(logical, dir)
  const order = reorderVisual(info.levels)
  return order.map((i) => ((info.levels[i] & 1) === 1 ? (MIRROR[logical[i]] ?? logical[i]) : logical[i])).join('')
}

export const PRESENTATION_IDS = ['ar-hello', 'ar-date', 'ar-indic-digits', 'ar-sans', 'ar-latin']

type PdfFontLike = { widthOfTextAtSize(t: string, s: number): number }

/** Draws a visual-order string glyph by glyph, left to right, ending at `xRight` (like a legacy producer: no shaping). */
function drawVisual(page: ReturnType<PDFDocument['addPage']>, font: PdfFontLike, vis: string, xRight: number, y: number, size: number, fallback?: PdfFontLike): void {
  const chars = [...vis]
  const fontFor = (ch: string): PdfFontLike => (fallback && /[A-Za-z0-9()[\]{}.,:%-]/.test(ch) ? fallback : font)
  const total = chars.reduce((s, ch) => s + fontFor(ch).widthOfTextAtSize(ch, size), 0)
  let x = xRight - total
  for (const ch of chars) {
    const f = fontFor(ch)
    if (ch !== ' ') page.drawText(ch, { x, y, size, font: f as never })
    x += f.widthOfTextAtSize(ch, size)
  }
}

/**
 * `toUnicode: false` removes every /ToUnicode, so the text must come from the embedded fonts' own cmaps; that needs
 * the full fonts (`subset: false`), because pdf-lib's subsets keep neither a cmap nor glyph names (such a file is
 * genuinely unreadable and must be reported as such).
 */
export async function presentationForms(opts: { toUnicode: boolean; fontsDir: string; subset?: boolean }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const subset = opts.subset ?? true
  const font = await pdf.embedFont(readFileSync(join(opts.fontsDir, 'textfonts', 'NotoNaskhArabic-Regular.ttf')), { subset })
  const latin = await pdf.embedFont(readFileSync(join(opts.fontsDir, 'fonts', 'NotoSans-Regular.ttf')), { subset })
  const page = pdf.addPage(A4)
  let y = 780
  for (const id of PRESENTATION_IDS) {
    const l = corpus.lines.find((x) => x.id === id)!
    drawVisual(page, font, visualString(toPresentationForms(l.text), 'rtl'), 555, y, 18, latin)
    y -= 40
  }
  // Hebrew stored in visual order, one glyph per letter (no presentation forms needed)
  const he = corpus.lines.find((x) => x.id === 'he')!
  const heFont = await pdf.embedFont(readFileSync(join(opts.fontsDir, 'textfonts', 'NotoSansHebrew-Regular.ttf')), { subset })
  drawVisual(page, heFont, visualString(he.text, 'rtl'), 555, y, 18, latin)
  const bytes = await pdf.save()
  if (opts.toUnicode) return bytes
  // the same file without /ToUnicode: text must come from the embedded font's own cmap
  const doc = await PDFDocument.load(bytes)
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const d = obj as unknown as { get?(k: PDFName): unknown; delete?(k: PDFName): void }
    if (d && typeof d.get === 'function' && d.get(PDFName.of('ToUnicode'))) d.delete!(PDFName.of('ToUnicode'))
  }
  return doc.save()
}

export async function writeAll(outDir: string, fontsDir: string, write: (name: string, bytes: Uint8Array) => void): Promise<void> {
  write('engine-lines.pdf', await engineLines())
  write('engine-para.pdf', await enginePara())
  write('engine-columns.pdf', await engineColumns())
  write('engine-rotated-text.pdf', await engineRotatedText())
  write('engine-rotated-page.pdf', await withRotation(await engineLines(), 90))
  write('pdflib-presentation.pdf', await presentationForms({ toUnicode: true, fontsDir }))
  void outDir
}
