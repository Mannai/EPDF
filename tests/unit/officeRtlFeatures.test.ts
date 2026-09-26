import { resolve } from 'node:path'
import { strToU8 } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { formatNumber } from '../../src/main/features/create/office/docxNumbering'
import { splitComplex } from '../../src/main/features/create/office/docxStyles'
import { DEFAULT_TEXT_STYLE } from '../../src/main/features/create/office/flow'
import { FontCatalog, mapComplexFamily, mapFontFamily } from '../../src/main/features/create/office/fonts'
import { shapeLine } from '../../src/main/features/create/office/textline'
import { buildPageText, rangeBoxes, type PageTextModel } from '../../src/shared/pagetext'
import { docxDocument, T } from '../support/arabicCorpus'
import { buildDocx } from '../support/docxBuilder'
import { buildPptx, textBox } from '../support/pptxBuilder'
import { pdfjsLines } from './helpers/text'

/** Right-to-left and complex-script features of the built-in Office converter, one by one. */

const fontsDir = resolve('resources/fonts')
const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim()
const convert = (name: string, bytes: Uint8Array) => convertOffice({ name, bytes }, { fontsDir })

async function models(bytes: Uint8Array): Promise<{ pdf: PDFDocument; models: PageTextModel[] }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  return { pdf, models: pdf.getPages().map((_, i) => buildPageText(pdf, i)) }
}

/** Centre x of `word` in the first model line containing it, from the glyph boxes (independent of /ActualText order). */
function xOf(m: PageTextModel, word: string, lineText?: string): number {
  for (const l of m.lines) {
    const t = m.text.slice(l.start, l.end)
    if (lineText && norm(t) !== norm(lineText)) continue
    const k = t.indexOf(word)
    if (k < 0) continue
    const b = rangeBoxes(m, l.start + k, l.start + k + word.length)
    return (Math.min(...b.map((x) => x.x0)) + Math.max(...b.map((x) => x.x1))) / 2
  }
  throw new Error(`“${word}” not found`)
}

let cat: FontCatalog
beforeAll(async () => {
  cat = new FontCatalog(fontsDir)
  await cat.prepare()
})

describe('font mapping for Arabic Office fonts', () => {
  it('maps the common Arabic Office fonts onto the bundled Arabic faces', () => {
    const cases: [string, string, number][] = [
      ['Arial', 'NotoNaskhArabic', 0.92],
      ['Times New Roman', 'NotoNaskhArabic', 0.907],
      ['Calibri', 'NotoNaskhArabic', 0.935],
      ['Tahoma', 'NotoSansArabic', 1.063],
      ['Segoe UI', 'NotoSansArabic', 1.036],
      ['Simplified Arabic', 'NotoNaskhArabic', 1],
      ['Traditional Arabic', 'NotoNaskhArabic', 1],
      ['Arabic Typesetting', 'NotoNaskhArabic', 1],
      ['Sakkal Majalla', 'NotoNaskhArabic', 1],
      ['Dubai', 'NotoSansArabic', 1],
      ['Jameel Noori Nastaleeq', 'NotoNastaliqUrdu', 1]
    ]
    for (const [name, fam, scale] of cases) expect(mapComplexFamily(name), name).toMatchObject({ family: fam, scale })
    // Arabic fonts name the Latin face of their Latin characters; Latin mappings are unchanged
    expect(mapFontFamily('Simplified Arabic')).toBe('LiberationSerif')
    expect(mapFontFamily('Dubai')).toBe('LiberationSans')
    expect(mapFontFamily('Arial')).toBe('LiberationSans')
    expect(mapFontFamily('Calibri')).toBe('Carlito')
  })

  it('font stacks: Latin face first for Latin fonts, the Arabic face first for Arabic fonts; line metrics from the first', () => {
    const arial = cat.stack(cat.face('Arial', false, false)).map((e) => e.file)
    expect(arial.slice(0, 2)).toEqual(['LiberationSans-Regular.ttf', 'NotoNaskhArabic-Regular.ttf'])
    const tahomaBold = cat.stack(cat.face('Tahoma', true, false)).map((e) => e.file)
    expect(tahomaBold.slice(0, 2)).toEqual(['LiberationSans-Bold.ttf', 'NotoSansArabic-Bold.ttf'])
    const simplified = cat.stack(cat.face('Simplified Arabic', false, false)).map((e) => e.file)
    expect(simplified[0]).toBe('NotoNaskhArabic-Regular.ttf')
    // Arial: Liberation Sans line metrics (as Word uses Arial's for an Arabic run), not Noto Naskh's much taller ones
    expect(cat.metrics(cat.face('Arial', false, false)).ascent).toBeCloseTo(1854 / 2048, 3)
  })

  it('measures Arabic with shaping: joined forms are narrower than isolated letters', () => {
    const face = cat.face('Arial', false, false)
    const word = cat.measure(face, 'مرحبا')
    const letters = [...'مرحبا'].reduce((s, c) => s + cat.measure(face, c), 0)
    expect(word).toBeGreaterThan(0.5)
    expect(word).toBeLessThan(letters)
  })
})

describe('line building', () => {
  it('shapes an Arabic word across a style change with its joined forms (bold letter inside a word)', () => {
    const reg = { face: cat.face('Arial', false, false), size: 20, color: '#000000' }
    const bold = { face: cat.face('Arial', true, false), size: 20, color: '#000000' }
    const whole = shapeLine(cat, [{ text: 'كتاب', style: reg }], 'rtl')
    const split = shapeLine(cat, [{ text: 'ك', style: reg }, { text: 'ت', style: bold }, { text: 'اب', style: reg }], 'rtl')
    const kafWhole = whole.runs.flatMap((r) => r.glyphs).find((g) => g.cluster === 0)!.gid
    const kafSplit = split.runs.flatMap((r) => r.glyphs).find((g) => g.cluster === 0)!.gid
    expect(kafSplit).toBe(kafWhole) // initial form, not the isolated one
    const alefWhole = whole.runs.flatMap((r) => r.glyphs).find((g) => g.cluster === 2)!.gid
    const alefSplit = split.runs.flatMap((r) => r.glyphs).find((g) => g.cluster === 2)!.gid
    expect(alefSplit).toBe(alefWhole) // final form after the bold teh
  })

  it('orders runs right to left in a right-to-left line and keeps Latin and numbers left to right inside it', () => {
    const st = { face: cat.face('Arial', false, false), size: 12, color: '#000000' }
    const l = shapeLine(cat, [{ text: 'تأسست ', style: st }, { text: 'Epdf', style: { ...st, face: cat.face('Arial', true, false) } }, { text: ' في عام 2024', style: st }], 'rtl')
    const xs = l.items.map((it) => it.pieces[0]!.x)
    expect(xs[0]).toBeGreaterThan(xs[1]!) // first (Arabic) item on the right
    expect(xs[1]).toBeGreaterThan(xs[2]!) // the Latin word before the rest, further left
  })

  it('justifies Arabic with kashida (tatweel glyphs) before widening spaces', () => {
    const st = { face: cat.face('Arial', false, false), size: 14, color: '#000000' }
    const natural = shapeLine(cat, [{ text: 'يهدف هذا المشروع إلى تطوير برنامج متكامل', style: st }], 'rtl')
    const just = shapeLine(cat, [{ text: 'يهدف هذا المشروع إلى تطوير برنامج متكامل', style: st }], 'rtl', natural.width + 30)
    expect(just.width).toBeCloseTo(natural.width + 30, 1)
    const tatweels = just.runs.flatMap((r) => r.glyphs).filter((g) => g.chars === 0 && !g.space)
    expect(tatweels.length).toBeGreaterThan(0)
  })
})

describe('DOCX', () => {
  it('numbering formats for Arabic, Hindi and Hebrew lists', () => {
    expect([1, 2, 3, 29].map((n) => formatNumber('arabicAbjad', n))).toEqual(['أ', 'ب', 'ج', 'أأ'])
    expect([1, 2, 3, 4].map((n) => formatNumber('arabicAlpha', n))).toEqual(['أ', 'ب', 'ت', 'ث'])
    expect(formatNumber('hindiNumbers', 1024)).toBe('١٠٢٤')
    expect(formatNumber('hindiCounting', 12)).toBe('१२')
    expect(formatNumber('hebrew1', 15)).toBe('טו')
    expect(formatNumber('hebrew1', 123)).toBe('קכג')
    expect(formatNumber('hebrew2', 2)).toBe('ב')
    expect(formatNumber('thaiNumbers', 7)).toBe('๗')
  })

  it('splits runs between the Latin and complex-script properties as Word does', () => {
    const latin = { ...DEFAULT_TEXT_STYLE, family: 'Times New Roman', size: 12 }
    const cs = { ...latin, family: 'Arial', size: 14, bold: true }
    expect(splitComplex('abc مرحبا 12 def', {}, latin, cs).map((p) => [p.text, p.style === cs])).toEqual([
      ['abc ', false],
      ['مرحبا 12 ', true],
      ['def', false]
    ])
    expect(splitComplex('abc', { rtl: true }, latin, cs)[0]!.style).toBe(cs) // w:rtl run: all complex script
  })

  it('complex-script size (szCs) applies to Arabic runs; the mixed line shows its words in right-to-left order', async () => {
    const r = await convert('a.docx', docxDocument().bytes)
    const { models: ms } = await models(r.bytes)
    const m = ms[0]!
    const line = (t: string) => m.lines.find((l) => norm(m.text.slice(l.start, l.end)) === norm(t))!
    // T.big is szCs 40 (20 pt), the body is szCs 28 (14 pt): glyph sizes keep that ratio (both scaled by the Arial factor)
    expect(line(T.big).size / line(T.end).size).toBeCloseTo(20 / 14, 1)
    // visual order from the glyph boxes: تأسست (first) rightmost, then شركة, Epdf, في, عام, 2024
    const mixed = T.p2a + T.p2b + T.p2c
    const order = ['تأسست', 'شركة', 'Epdf', 'عام', '2024', 'المنامة'].map((w) => xOf(m, w, mixed))
    for (let i = 1; i < order.length; i++) expect(order[i], `word ${i}`).toBeLessThan(order[i - 1]!)
    // bidiVisual table: first column on the right
    expect(xOf(m, T.table[0]![0]!)).toBeGreaterThan(xOf(m, T.table[0]![1]!))
    expect(xOf(m, T.table[0]![1]!)).toBeGreaterThan(xOf(m, T.table[0]![2]!))
    // list markers on the right of their text
    expect(xOf(m, '•')).toBeGreaterThan(xOf(m, T.bullets[0]!.split(' ')[0]!))
  })

  it('PDF.js (ignores /ActualText) reads pure Arabic lines in logical order too', async () => {
    const r = await convert('a.docx', docxDocument().bytes)
    const got = (await pdfjsLines(r.bytes)).map(norm)
    // (lines with a Latin word or a list marker in their own run are not checked: PDF.js keeps runs in visual order,
    // a documented PDF.js quirk; the page text model and ActualText-aware readers read them logically)
    for (const t of [T.title, T.center, T.end, T.header, ...T.bullets, T.indented, T.big]) expect(got.some((l) => l.includes(norm(t))), t).toBe(true)
    // the justified paragraph: each line in logical order
    expect(got.some((l) => l.startsWith('يهدف هذا المشروع إلى تطوير'))).toBe(true)
  })

  it('a right-to-left section fills its columns from right to left', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t>سطر رقم ${i + 1}</w:t></w:r></w:p>`).join('')
    const bytes = buildDocx({ body: long, sectPr: '<w:sectPr><w:pgSz w:w="11906" w:h="8000"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360"/><w:cols w:num="2" w:space="720"/><w:bidi/></w:sectPr>' })
    const { models: ms } = await models((await convert('cols.docx', bytes)).bytes)
    const m = ms[0]!
    expect(xOf(m, 'سطر رقم 1', 'سطر رقم 1')).toBeGreaterThan(300) // first line in the right-hand column
    const lastOnPage = m.lines.map((l) => m.text.slice(l.start, l.end)).filter((t) => /^سطر رقم \d+$/.test(norm(t))).pop()!
    expect(xOf(m, norm(lastOnPage), lastOnPage)).toBeLessThan(300) // later lines in the left-hand column
  })

  it('no longer warns that right-to-left text may be wrong', async () => {
    const r = await convert('a.docx', docxDocument().bytes)
    expect(r.warnings.join(' ')).not.toMatch(/right-to-left|shaped/i)
  })
})

describe('PPTX', () => {
  it('a right-to-left table (a:tblPr rtl="1") has its first column on the right', async () => {
    const cell = (t: string): string => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr rtl="1"/><a:r><a:rPr lang="ar-BH"/><a:t>${t}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`
    const tbl = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="457200"/><a:ext cx="6000000" cy="800000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr rtl="1"/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid><a:tr h="400000">${cell('الأول')}${cell('الثاني')}${cell('الثالث')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const r = await convert('t.pptx', buildPptx({ slides: [{ shapes: tbl + textBox(5, 457200, 3000000, 4000000, 600000, ['x']) }] }))
    const { models: ms } = await models(r.bytes)
    expect(xOf(ms[0]!, 'الأول')).toBeGreaterThan(xOf(ms[0]!, 'الثاني'))
    expect(xOf(ms[0]!, 'الثاني')).toBeGreaterThan(xOf(ms[0]!, 'الثالث'))
  })
})

describe('RTF', () => {
  it('\\rtlrow tables have their first cell on the right; \\afs sets the Arabic size', async () => {
    const u = (s: string): string => [...s].map((c) => (c.charCodeAt(0) < 128 ? c : `\\u${c.charCodeAt(0)}?`)).join('')
    const row = `\\trowd\\rtlrow\\cellx3000\\cellx6000\\cellx9000\\pard\\intbl\\rtlpar{\\rtlch\\af1\\afs28 ${u('الأول')}}\\cell\\pard\\intbl\\rtlpar{\\rtlch\\af1\\afs28 ${u('الثاني')}}\\cell\\pard\\intbl\\rtlpar{\\rtlch\\af1\\afs28 ${u('الثالث')}}\\cell\\row`
    const doc = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}{\\f1 Arial;}}${row}\\pard\\rtlpar{\\rtlch\\af1\\afs48 ${u('كبير')}}\\par\\pard\\rtlpar{\\rtlch\\af1\\afs24 ${u('صغير')}}\\par}`
    const { models: ms } = await models((await convert('t.rtf', strToU8(doc))).bytes)
    const m = ms[0]!
    expect(xOf(m, 'الأول')).toBeGreaterThan(xOf(m, 'الثاني'))
    expect(xOf(m, 'الثاني')).toBeGreaterThan(xOf(m, 'الثالث'))
    const size = (t: string): number => m.lines.find((l) => norm(m.text.slice(l.start, l.end)) === t)!.size
    expect(size('كبير') / size('صغير')).toBeCloseTo(2, 1)
  })
})

describe('XLSX', () => {
  it('"General" alignment follows the text direction in a left-to-right sheet', async () => {
    const { xlsxDocument } = await import('../support/arabicCorpus')
    // flip the corpus sheet to left-to-right: Arabic text is still right-aligned in its cell, English left-aligned
    const src = xlsxDocument()
    const { unzipSync, zipSync } = await import('fflate')
    const files = unzipSync(src.bytes)
    files['xl/worksheets/sheet1.xml'] = strToU8(new TextDecoder().decode(files['xl/worksheets/sheet1.xml']).replace('rightToLeft="1" ', ''))
    const { models: ms } = await models((await convert('ltr.xlsx', zipSync(files))).bytes)
    const m = ms[0]!
    const box = (t: string) => {
      const l = m.lines.find((x) => norm(m.text.slice(x.start, x.end)).includes(t))!
      return l
    }
    // column A is on the left now; "تفاح" (right-aligned) ends further right than "Total" (left-aligned) starts
    expect(box('تفاح').x1).toBeGreaterThan(box('Total').x0 + 20)
    expect(box('Total').x0).toBeLessThan(box('تفاح').x0)
  })
})

describe('performance', () => {
  it('a 50-page Arabic DOCX converts in reasonable time', async () => {
    const doc = docxDocument({ pages: 50 })
    const t0 = performance.now()
    const r = await convert(doc.name, doc.bytes)
    const ms = performance.now() - t0
    console.log(`[perf] 50-block Arabic DOCX: ${r.pages} pages, ${(doc.bytes.length / 1024).toFixed(0)} KB in, ${(r.bytes.length / 1024).toFixed(0)} KB out, ${ms.toFixed(0)} ms`)
    expect(r.pages).toBeGreaterThanOrEqual(50)
    expect(ms).toBeLessThan(60_000)
  }, 120_000)
})
