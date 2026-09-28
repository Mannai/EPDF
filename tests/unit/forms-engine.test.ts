import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, PDFString, PDFTextField, TextAlignment, decodePDFRawStream } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { familyOfFontName } from '../../src/renderer/src/features/forms/appearance'
import { applyFieldValue } from '../../src/renderer/src/features/forms/values'
import { createFormsPdf } from '../fixtures/forms-signing.mjs'
import { appearanceModels, appearanceTexts, norm, pdfjsAnnotations, type0Fonts } from '../support/retrofit'

/**
 * Form fields whose text the standard fonts cannot encode get their appearance from the text engine: /V stays the
 * logical string, /AP /N is engine output, /DA names an engine font that is in /DR, and every reader of the saved
 * file (pdf-lib, PDF.js, the page text model over the appearance) sees the logical text.
 */

const AR = 'الاسم الكامل'
const MIXED = 'فاتورة رقم 2026 لشركة Epdf'
const HE = 'שלום עולם'

let base: Uint8Array
beforeAll(async () => {
  base = await createFormsPdf()
})

async function fill(values: [string, string | boolean | string[]][], bytes = base): Promise<{ pdf: PDFDocument; bytes: Uint8Array }> {
  const pdf = await PDFDocument.load(bytes)
  for (const [n, v] of values) await applyFieldValue(pdf, n, v)
  const out = await pdf.save()
  return { pdf: await PDFDocument.load(out), bytes: out }
}

const widgetAP = (pdf: PDFDocument, name: string, i = 0): PDFStream => {
  const w = pdf.getForm().getField(name).acroField.getWidgets()[i]
  const n = w.getNormalAppearance()
  return (n instanceof PDFStream ? n : pdf.context.lookup(n)) as PDFStream
}
const contentOf = (s: PDFStream): string => Buffer.from(decodePDFRawStream(s as never).decode()).toString('latin1')

/** The widget's appearance drawn alone on a page (for the page text model and geometry). */
async function onlyField(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes)
  const form = pdf.getForm()
  for (const f of form.getFields()) if (f.getName() !== name) for (const w of f.acroField.getWidgets()) pdf.getPages().forEach((p) => p.node.removeAnnot(pdf.context.getObjectRef(w.dict)!))
  return pdf.save({ updateFieldAppearances: false })
}

const OUT = resolve('test-results/text-retrofit')

describe('form fields: Arabic, Hebrew, mixed and other scripts through the text engine', () => {
  it('Arabic value: /V logical, engine appearance, /DA font in /DR, PDF.js and the page text model read it', async () => {
    const { pdf, bytes } = await fill([['full_name', AR]])
    const field = pdf.getForm().getTextField('full_name')
    expect(field.getText()).toBe(AR)
    // the raw /V is the logical UTF-16 string
    expect(field.acroField.dict.lookup(PDFName.of('V'))?.toString()).toMatch(/^<FEFF/)
    const ap = widgetAP(pdf, 'full_name')
    expect(ap.dict.get(PDFName.of('EpdfTextAP'))).toBeDefined()
    const c = contentOf(ap)
    expect(c).toContain('/Tx BMC')
    expect(c).toMatch(/\/EpdfTx0 Do/)
    // /DA names a font that exists in /DR, and it is the engine's Type0 font
    const da = (field.acroField.dict.lookup(PDFName.of('DA')) as PDFString).decodeText()
    const fontName = /\/(\S+) [\d.]+ Tf/.exec(da)![1]
    expect(fontName).toMatch(/^EpdfSans(_\d+)?$/)
    const dr = pdf.getForm().acroForm.dict.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
    const font = dr.lookup(PDFName.of(fontName), PDFDict)
    expect(font.get(PDFName.of('Subtype'))?.toString()).toBe('/Type0')
    expect(font.get(PDFName.of('ToUnicode'))).toBeDefined()
    // NeedAppearances is not set: readers draw our appearance
    expect(pdf.getForm().acroForm.dict.get(PDFName.of('NeedAppearances'))).toBeUndefined()
    // PDF.js (another reader) sees the value and an appearance
    const annots = await pdfjsAnnotations(bytes)
    const a = annots.find((x) => x.fieldName === 'full_name')!
    expect(a.fieldValue).toBe(AR)
    expect(a.hasAppearance).toBe(true)
    // what the appearance shows, read back in logical order
    const [p1] = await appearanceTexts(await onlyField(bytes, 'full_name'))
    expect(norm(p1)).toBe(norm(AR))
  })

  it('right-to-left text is right-aligned by default (/Q 0); /Q 1 centres, /Q 2 right', async () => {
    const pos = async (q?: TextAlignment): Promise<{ x0: number; x1: number }> => {
      const pdf = await PDFDocument.load(base)
      if (q !== undefined) pdf.getForm().getTextField('full_name').setAlignment(q)
      await applyFieldValue(pdf, 'full_name', AR)
      const only = await onlyField(await pdf.save(), 'full_name')
      const w = (await PDFDocument.load(only)).getForm().getTextField('full_name').acroField.getWidgets()[0].getRectangle()
      const [m] = await appearanceModels(only)
      const l = m.lines.find((ln) => norm(m.text.slice(ln.start, ln.end)) === norm(AR))!
      expect(l.dir).toBe('rtl')
      // display space (y down): x is the same as user space on an unrotated page
      return { x0: l.x0 - w.x, x1: w.x + w.width - l.x1 }
    }
    const start = await pos()
    expect(start.x1).toBeLessThan(4) // flush right (1 pt padding + border)
    expect(start.x0).toBeGreaterThan(60)
    const center = await pos(TextAlignment.Center)
    expect(Math.abs(center.x0 - center.x1)).toBeLessThan(3)
    const left = await pos(TextAlignment.Left) // /Q 0 written explicitly: still "start"
    expect(left.x1).toBeLessThan(4)
  })

  it('mixed Arabic + English + numbers and Hebrew come back in logical order', async () => {
    const { pdf, bytes } = await fill([
      ['full_name', MIXED],
      ['page2_field', HE]
    ])
    expect(pdf.getForm().getTextField('full_name').getText()).toBe(MIXED)
    expect(pdf.getForm().getTextField('page2_field').getText()).toBe(HE)
    const texts = await appearanceTexts(await onlyField(bytes, 'full_name'))
    expect(norm(texts[0])).toBe(norm(MIXED))
    const t2 = await appearanceTexts(bytes)
    expect(norm(t2[1])).toBe(norm(HE))
  })

  it('a multiline Arabic value wraps inside the field, right-aligned, lines in reading order', async () => {
    const long = 'هذا نص عربي طويل يجب أن يلتف داخل الحقل متعدد الأسطر، ويبقى بالترتيب الصحيح عند قراءته مرة أخرى.'
    const { bytes } = await fill([['notes', long]])
    const [m] = await appearanceModels(await onlyField(bytes, 'notes'))
    expect(m.lines.length).toBeGreaterThan(1)
    expect(norm(m.text)).toBe(norm(long))
    for (const l of m.lines) expect(l.dir).toBe('rtl')
    // all lines end at the same right edge
    const rights = m.lines.map((l) => l.x1)
    expect(Math.max(...rights) - Math.min(...rights)).toBeLessThan(1.5)
  })

  it('auto font size (/DA 0 Tf) shrinks a long value to the field width and keeps /DA at 0', async () => {
    const pdf = await PDFDocument.load(base)
    const field = pdf.getForm().getTextField('full_name')
    field.acroField.setDefaultAppearance('/Helv 0 Tf 0 g')
    for (const w of field.acroField.getWidgets()) w.dict.delete(PDFName.of('DA'))
    const text = 'نص عربي طويل جدا جدا جدا جدا جدا جدا جدا جدا جدا جدا جدا جدا'
    await applyFieldValue(pdf, 'full_name', text)
    const out = await pdf.save()
    const re = await PDFDocument.load(out)
    const da = (re.getForm().getTextField('full_name').acroField.dict.lookup(PDFName.of('DA')) as PDFString).decodeText()
    expect(da).toMatch(/\/EpdfSans(_\d+)? 0 Tf/)
    const [m] = await appearanceModels(await onlyField(out, 'full_name'))
    const l = m.lines.find((x) => norm(m.text.slice(x.start, x.end)) === norm(text))!
    expect(l).toBeDefined()
    // it fits inside the 260 pt wide field at x = 72
    expect(l.x0).toBeGreaterThanOrEqual(72)
    expect(l.x1).toBeLessThanOrEqual(72 + 260)
    expect(l.size).toBeLessThan(12)
  })

  it('combo box and list box options in Arabic; Devanagari, Thai and CJK values', async () => {
    const pdf = await PDFDocument.load(base)
    const form = pdf.getForm()
    form.getDropdown('country').setOptions(['البحرين', 'مصر', 'Germany'])
    form.getOptionList('langs').setOptions(['العربية', 'עברית', 'English'])
    await applyFieldValue(pdf, 'country', 'البحرين')
    await applyFieldValue(pdf, 'langs', ['العربية', 'English'])
    await applyFieldValue(pdf, 'code', 'हिंदी')
    await applyFieldValue(pdf, 'readonly_id', 'x').catch(() => undefined) // read-only: refused, untouched
    await applyFieldValue(pdf, 'page2_field', 'สวัสดีครับ 你好 こんにちは')
    const bytes = await pdf.save()
    const re = await PDFDocument.load(bytes)
    expect(re.getForm().getDropdown('country').getSelected()).toEqual(['البحرين'])
    expect(re.getForm().getOptionList('langs').getSelected()).toEqual(['العربية', 'English'])
    const combo = norm((await appearanceTexts(await onlyField(bytes, 'country')))[0])
    expect(combo).toBe('البحرين')
    const list = (await appearanceTexts(await onlyField(bytes, 'langs')))[0]
    expect(list.split('\n').map(norm)).toEqual(['العربية', 'עברית', 'English'])
    expect(norm((await appearanceTexts(await onlyField(bytes, 'code')))[0])).toBe('हिंदी')
    expect(norm((await appearanceTexts(bytes))[1])).toBe(norm('สวัสดีครับ 你好 こんにちは'))
    const annots = await pdfjsAnnotations(bytes)
    expect(annots.find((a) => a.fieldName === 'country')!.fieldValue).toEqual(['البحرين'])
    expect(annots.find((a) => a.fieldName === 'country')!.hasAppearance).toBe(true)
  })

  it('a comb field puts one character per cell', async () => {
    const pdf = await PDFDocument.load(base)
    const f = pdf.getForm().getTextField('code')
    f.enableCombing()
    await applyFieldValue(pdf, 'code', '١٢٣٤٥')
    const bytes = await pdf.save()
    const re = await PDFDocument.load(bytes)
    const c = contentOf(widgetAP(re, 'code'))
    expect((c.match(/ Do Q/g) ?? []).length).toBe(5)
  })

  it('a comb field fills right to left for Arabic text (first letter in the rightmost cell); numbers still fill from the left', async () => {
    const xs = async (value: string): Promise<number[]> => {
      const pdf = await PDFDocument.load(base)
      const f = pdf.getForm().getTextField('code')
      f.setMaxLength(6)
      f.enableCombing()
      await applyFieldValue(pdf, 'code', value)
      const re = await PDFDocument.load(await pdf.save())
      const c = contentOf(widgetAP(re, 'code'))
      return [...c.matchAll(/1 0 0 1 ([-\d.]+) [-\d.]+ cm \/\S+ Do Q/g)].map((m) => Number(m[1]))
    }
    const ar = await xs('سلام')
    expect(ar).toHaveLength(4)
    for (let i = 1; i < ar.length; i++) expect(ar[i]).toBeLessThan(ar[i - 1]) // س right-most, then leftwards
    const digits = await xs('٢٠٢٦') // (Western digits take the plain Helvetica path, not the engine)
    for (let i = 1; i < digits.length; i++) expect(digits[i]).toBeGreaterThan(digits[i - 1])
    // The first Arabic letter sits in the last (6th) cell, the first digit in the first.
    expect(ar[0]).toBeGreaterThan(digits[digits.length - 1])
  })

  it('switching a field back to Latin text uses Helvetica again (no embedded font for it)', async () => {
    const first = await fill([['full_name', AR]])
    const second = await fill([['full_name', 'Ada Lovelace']], first.bytes)
    const c = contentOf(widgetAP(second.pdf, 'full_name'))
    expect(c.toUpperCase()).toContain(Buffer.from('Ada Lovelace').toString('hex').toUpperCase())
    expect(second.pdf.getForm().getTextField('full_name').getText()).toBe('Ada Lovelace')
  })

  it('Latin filling is unchanged: Helvetica, no embedded font, the same size as before', async () => {
    const { pdf, bytes } = await fill([
      ['full_name', 'Ada Lovelace'],
      ['notes', 'first line\nsecond line'],
      ['country', 'Germany']
    ])
    expect(type0Fonts(pdf)).toHaveLength(0)
    expect(widgetAP(pdf, 'full_name').dict.get(PDFName.of('EpdfTextAP'))).toBeUndefined()
    // Arabic adds one small subset font
    const ar = await fill([['full_name', AR]])
    expect(type0Fonts(ar.pdf).length).toBeGreaterThan(0)
    expect(ar.bytes.length - bytes.length).toBeLessThan(40_000)
  })

  it('maps /DA font names to a family for the engine stack', () => {
    expect(familyOfFontName('Helv')).toEqual({ family: 'sans', bold: false })
    expect(familyOfFontName('HeBo')).toEqual({ family: 'sans', bold: true })
    expect(familyOfFontName('TiRo')).toEqual({ family: 'serif', bold: false })
    expect(familyOfFontName('CoBo')).toEqual({ family: 'mono', bold: true })
    expect(familyOfFontName('EpdfSerifBd_2')).toEqual({ family: 'serif', bold: true })
    expect(familyOfFontName('Courier-Bold')).toEqual({ family: 'mono', bold: true })
    expect(familyOfFontName(undefined)).toEqual({ family: 'sans', bold: false })
  })

  it('rotated widgets (/MK /R 90) get a rotated appearance', async () => {
    const pdf = await PDFDocument.load(base)
    const w = pdf.getForm().getTextField('full_name').acroField.getWidgets()[0]
    w.getOrCreateAppearanceCharacteristics().dict.set(PDFName.of('R'), PDFNumber.of(90))
    await applyFieldValue(pdf, 'full_name', AR)
    const c = contentOf(widgetAP(await PDFDocument.load(await pdf.save()), 'full_name'))
    expect(c).toMatch(/^q\n0 1 -1 0 [\d.]+ 0 cm/)
  })

  it('writes sample files for other readers', async () => {
    mkdirSync(OUT, { recursive: true })
    const pdf = await PDFDocument.load(base)
    await applyFieldValue(pdf, 'full_name', MIXED)
    await applyFieldValue(pdf, 'notes', 'مرحبا بكم في Epdf\nשלום עולם — Hebrew line\nالسطر الثالث ١٢٣')
    await applyFieldValue(pdf, 'code', '12345')
    await applyFieldValue(pdf, 'page2_field', HE)
    const bytes = await pdf.save()
    writeFileSync(resolve(OUT, 'forms-arabic.pdf'), bytes)
    expect((await PDFDocument.load(bytes)).getForm().getField('full_name')).toBeInstanceOf(PDFTextField)
  })
})
