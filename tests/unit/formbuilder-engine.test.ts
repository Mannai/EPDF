import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { createField } from '../../src/renderer/src/features/formbuilder/logic/create'
import { applyPatch } from '../../src/renderer/src/features/formbuilder/logic/edit'
import { readBuilderModel } from '../../src/renderer/src/features/formbuilder/logic/read'
import { applyFieldValue } from '../../src/renderer/src/features/forms/values'
import { appearanceTexts, norm, pdfjsAnnotations, type0Fonts } from '../support/retrofit'

/** Fields the form builder creates with Arabic / Hebrew defaults, options and captions are drawn by the text engine. */

const rect = (x: number, y: number, w: number, h: number) => ({ x1: x, y1: y, x2: x + w, y2: y + h })

async function doc(): Promise<PDFDocument> {
  const d = await PDFDocument.create()
  d.addPage([612, 792])
  return d
}

const daOf = (pdf: PDFDocument, name: string): string => (pdf.getForm().getField(name).acroField.dict.lookup(PDFName.of('DA')) as PDFString).decodeText()
const drFont = (pdf: PDFDocument, name: string): PDFDict | undefined =>
  pdf.getForm().acroForm.dict.lookup(PDFName.of('DR'), PDFDict).lookupMaybe(PDFName.of('Font'), PDFDict)?.lookupMaybe(PDFName.of(name), PDFDict)

describe('form builder: fields with right-to-left and other scripts', () => {
  it('creates Arabic/Hebrew defaults, options and captions with engine appearances and /DA fonts in /DR', async () => {
    const pdf = await doc()
    await createField(pdf, { kind: 'text', name: 'name_ar', pageIndex: 0, rect: rect(72, 700, 220, 24), value: 'محمد بن راشد', style: { fontName: 'TiBo', fontSize: 12 } })
    await createField(pdf, { kind: 'dropdown', name: 'city', pageIndex: 0, rect: rect(72, 650, 160, 22), options: ['المنامة', 'ירושלים', 'Paris'], value: 'المنامة' })
    await createField(pdf, { kind: 'list', name: 'langs', pageIndex: 0, rect: rect(72, 560, 160, 70), options: ['العربية', 'עברית', 'English'], multiSelect: true })
    await createField(pdf, { kind: 'button', name: 'send', pageIndex: 0, rect: rect(300, 700, 90, 26), caption: 'إرسال' })
    await createField(pdf, { kind: 'text', name: 'plain', pageIndex: 0, rect: rect(300, 650, 120, 22), value: 'Latin only' })
    const bytes = await pdf.save()
    const re = await PDFDocument.load(bytes)

    expect(re.getForm().getTextField('name_ar').getText()).toBe('محمد بن راشد')
    // the builder's font choice (Times bold) survives as the engine's serif bold family
    expect(daOf(re, 'name_ar')).toMatch(/^\/EpdfSerifBd(_\d+)? 12 Tf/)
    expect(drFont(re, /\/(\S+) /.exec(daOf(re, 'name_ar'))![1])?.get(PDFName.of('Subtype'))?.toString()).toBe('/Type0')
    // Latin stays on the standard font
    expect(daOf(re, 'plain')).toMatch(/Helv/)
    // what the appearances show, in logical order (one line per widget, page order)
    const [text] = await appearanceTexts(bytes)
    const lines = text.split('\n').map(norm)
    for (const want of ['محمد بن راشد', 'المنامة', 'العربية', 'עברית', 'English', 'إرسال', 'Latin only']) expect(lines).toContain(want)
    // PDF.js sees values and appearances
    const annots = await pdfjsAnnotations(bytes)
    expect(annots.find((a) => a.fieldName === 'name_ar')).toMatchObject({ fieldValue: 'محمد بن راشد', hasAppearance: true })
    expect(annots.find((a) => a.fieldName === 'city')).toMatchObject({ fieldValue: ['المنامة'], hasAppearance: true })
    // the builder model maps the engine font name back to the style the user chose
    const model = readBuilderModel(re)
    const f = model.fields.find((x) => x.name === 'name_ar')!
    expect(f.style.fontName).toBe('TiBo')
  })

  it('changing the style of an Arabic field redraws it with the new family; filling it later works', async () => {
    const pdf = await doc()
    await createField(pdf, { kind: 'text', name: 'n', pageIndex: 0, rect: rect(72, 700, 220, 24), value: 'نص' })
    await applyPatch(pdf, 'n', { style: { fontName: 'Cour', fontSize: 14, textColor: '#cc0000', align: 'center', borderColor: '#000000', backgroundColor: null, borderWidth: 1, borderStyle: 'solid' } })
    expect(daOf(pdf, 'n')).toMatch(/^\/EpdfMono(_\d+)? 14 Tf 0\.8 0 0 rg$/)
    await applyFieldValue(pdf, 'n', 'שלום 123')
    const bytes = await pdf.save()
    expect(norm((await appearanceTexts(bytes))[0])).toBe('שלום 123')
    expect(type0Fonts(await PDFDocument.load(bytes)).length).toBeGreaterThan(0)
    mkdirSync(resolve('test-results/text-retrofit'), { recursive: true })
    writeFileSync(resolve('test-results/text-retrofit/formbuilder-arabic.pdf'), bytes)
  })
})
