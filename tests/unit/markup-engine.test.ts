import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFName, PDFNumber } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { regenerateAppearance } from '../../src/renderer/src/features/markup/pdf/appearance'
import { addFreeText, updateAnnotation } from '../../src/renderer/src/features/markup/pdf/ops'
import { getNumbers, getString } from '../../src/renderer/src/features/markup/pdf/pdfobj'
import { appearanceModels, norm } from '../support/retrofit'
import { annotsOf, apOps, makePdf, reload, validateAnnotations } from './markupHelpers'

/** Text boxes (FreeText) with Arabic, Hebrew and mixed text: engine appearance, logical /Contents and /RC, /DS = /DA. */

const who = { author: 'Ada', now: new Date(Date.UTC(2026, 8, 26, 12, 0, 0)) }
const AR = 'ملاحظة: راجع الفقرة 3 من العقد'

describe('markup text boxes in any script', () => {
  it('Arabic text box: logical /Contents and /RC, /DS consistent with /DA, right-aligned engine appearance', async () => {
    const pdf = await makePdf()
    await addFreeText(pdf, 0, { ...who, rect: [100, 500, 360, 540], text: AR, fontSize: 14, color: [0.8, 0, 0], fill: null, borderWidth: 1 })
    const back = await reload(pdf)
    expect(validateAnnotations(back)).toEqual([])
    const [d] = annotsOf(back)
    expect(getString(d, 'Contents')).toBe(AR)
    const rc = getString(d, 'RC')!
    expect(rc).toContain(`<p dir="rtl">${AR}</p>`)
    const ds = getString(d, 'DS')!
    const da = getString(d, 'DA')!
    expect(da).toBe('0.8 0 0 rg /Helv 14 Tf')
    expect(ds).toContain('font: 14pt')
    expect(ds).toContain('color: #cc0000')
    expect(ds).toContain('text-align: start')
    expect(apOps(d)).toMatch(/\/EpdfTx0 Do/)
    const bytes = await back.save()
    const [m] = await appearanceModels(bytes)
    expect(norm(m.text)).toBe(norm(AR))
    const l = m.lines[0]
    expect(l.dir).toBe('rtl')
    // right edge of the text at the right padding of the box (display space: y down, x as user space here)
    expect(360 - l.x1).toBeLessThan(5)
    expect(l.x0 - 100).toBeGreaterThan(20)
  })

  it('multi-line Hebrew/Arabic grows the box and wraps in reading order; /Q 1 centres', async () => {
    const pdf = await makePdf()
    const text = 'שלום עולם — זו הערה ארוכה שצריכה להתפרס על כמה שורות בתוך התיבה\nوسطر عربي ثان'
    const id = await addFreeText(pdf, 0, { ...who, rect: [100, 500, 260, 520], text, fontSize: 12, color: [0, 0, 0], fill: [1, 1, 0.8], borderWidth: 1 })
    const [d0] = annotsOf(pdf)
    const r = getNumbers(d0, 'Rect')!
    expect(r[3] - r[1]).toBeGreaterThan(40) // grown to fit the lines
    const [m] = await appearanceModels(await pdf.save())
    expect(m.lines.length).toBeGreaterThan(2)
    expect(norm(m.text)).toBe(norm(text))
    // centre it
    d0.set(PDFName.of('Q'), PDFNumber.of(1))
    await regenerateAppearance(pdf, d0, 0)
    expect(getString(d0, 'DS')).toContain('text-align: center')
    const [c] = await appearanceModels(await pdf.save())
    const last = c.lines[c.lines.length - 1]
    const mid = (last.x0 + last.x1) / 2
    expect(Math.abs(mid - (r[0] + r[2]) / 2)).toBeLessThan(3)
    expect(id).toBeTruthy()
  })

  it('upright on a rotated page', async () => {
    const pdf = await makePdf({ rotation: 90 })
    await addFreeText(pdf, 0, { ...who, rect: [300, 300, 340, 500], text: AR, fontSize: 12, color: [0, 0, 0], fill: null, borderWidth: 0 })
    const [m] = await appearanceModels(await pdf.save())
    expect(norm(m.text)).toBe(norm(AR))
    expect(Math.abs(m.lines[0].angle)).toBeLessThan(1)
  })

  it('editing the text back to Latin returns to Helvetica and drops /RC and /DS', async () => {
    const pdf = await makePdf()
    const id = await addFreeText(pdf, 0, { ...who, rect: [100, 500, 360, 540], text: AR, fontSize: 12, color: [0, 0, 0], fill: null, borderWidth: 0 })
    await updateAnnotation(pdf, id, { contents: 'Plain note' })
    const [d] = annotsOf(await reload(pdf))
    expect(getString(d, 'RC')).toBeUndefined()
    expect(getString(d, 'DS')).toBeUndefined()
    expect(apOps(d)).toMatch(/Tj/)
    expect(apOps(d)).not.toMatch(/EpdfTx0/)
  })

  it('writes a sample file for other readers', async () => {
    const pdf = await makePdf()
    await addFreeText(pdf, 0, { ...who, rect: [72, 560, 400, 620], text: `${AR}\nשלום עולם, Hebrew and English 2026`, fontSize: 14, color: [0, 0, 0.6], fill: [1, 0.97, 0.7], borderWidth: 1 })
    mkdirSync(resolve('test-results/text-retrofit'), { recursive: true })
    writeFileSync(resolve('test-results/text-retrofit/markup-arabic.pdf'), await pdf.save())
  })
})
