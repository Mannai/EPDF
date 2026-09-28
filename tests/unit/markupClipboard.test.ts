import { PDFDict, PDFName, PDFRef, PDFStream, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { listLocated } from '../../src/renderer/src/features/markup/pdf/annots'
import { copyAnnotation, keepOnPage, pasteAnnotation } from '../../src/renderer/src/features/markup/pdf/clipboard'
import { addFillSignature, addNote, addReply, addShape } from '../../src/renderer/src/features/markup/pdf/ops'
import { getNumbers } from '../../src/renderer/src/features/markup/pdf/pdfobj'
import { readAnnotations } from '../../src/renderer/src/features/markup/pdf/read'
import { annotsOf, makePdf, reload, validateAnnotations } from './markupHelpers'

const who = { author: 'Ada Lovelace', now: new Date(Date.UTC(2026, 8, 28, 9, 0, 0)) }
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
const nm = (d: PDFDict): string | undefined => d.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText()
const apRef = (d: PDFDict): PDFRef | undefined => (d.lookup(PDFName.of('AP'), PDFDict) as PDFDict).get(PDFName.of('N')) as PDFRef | undefined

describe('copy and paste of placed items', () => {
  it('a pasted shape is a separate annotation, offset, with its own name and appearance, on the right page', async () => {
    const pdf = await makePdf({ pages: 2 })
    const id = await addShape(pdf, 0, { ...who, kind: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0], fill: null, width: 2, opacity: 1, dashed: false })
    const clip = await copyAnnotation(pdf, id)
    const copyId = pasteAnnotation(pdf, 0, clip, 12, -12, who.now)
    expect(copyId).not.toBe(id)
    const back = await reload(pdf)
    expect(validateAnnotations(back)).toEqual([])
    const [a, b] = annotsOf(back, 0)
    expect(getNumbers(b, 'Rect')).toEqual([112, 88, 212, 148])
    expect(getNumbers(a, 'Rect')).toEqual([100, 100, 200, 160])
    expect(nm(b)).toMatch(/^epdf-/)
    expect(nm(b)).not.toBe(nm(a))
    // Its own appearance stream: restyling the copy leaves the original alone.
    expect(apRef(b)?.toString()).not.toBe(apRef(a)?.toString())
    expect(back.context.lookup(apRef(b)!)).toBeInstanceOf(PDFStream)
    expect((b.get(PDFName.of('P')) as PDFRef).toString()).toBe(back.getPages()[0].ref.toString())
  })

  it('pastes into another document and onto another page, with the picture of a signature copied along', async () => {
    const src = await makePdf()
    const id = await addFillSignature(src, 0, { ...who, png: PNG, center: [300, 200], width: 150, label: 'Signature' })
    const clip = await copyAnnotation(src, id)
    const dst = await makePdf({ pages: 3 })
    pasteAnnotation(dst, 2, clip, 0, 0, who.now)
    const back = await reload(dst)
    expect(validateAnnotations(back)).toEqual([])
    const infos = readAnnotations(back)
    expect(infos).toHaveLength(1)
    expect(infos[0].pageIndex).toBe(2)
    expect(infos[0].fillSign).toBe('Signature')
  })

  it('a copied comment does not bring its replies or pop-up; the copy starts its own thread', async () => {
    const pdf = await makePdf()
    const note = await addNote(pdf, 0, { ...who, center: [100, 700], contents: 'Check this', color: [1, 0.8, 0], icon: 'Comment' })
    addReply(pdf, note, { ...who, text: 'Done' })
    const clip = await copyAnnotation(pdf, note)
    const copyId = pasteAnnotation(pdf, 0, clip, 12, -12, who.now)
    const copy = listLocated(pdf).find((l) => l.id === copyId)!.dict
    for (const k of ['IRT', 'Popup']) expect(copy.has(PDFName.of(k))).toBe(false)
    const back = await reload(pdf)
    const all = readAnnotations(back)
    expect(all.filter((a) => a.irt === null && a.subtype === 'Text')).toHaveLength(2)
    expect(all.filter((a) => a.irt !== null)).toHaveLength(1) // only the original's reply
  })

  it('keeps the pasted copy on the page when the offset would push it off', () => {
    const box: [number, number, number, number] = [0, 0, 612, 792]
    expect(keepOnPage([100, 100, 200, 160], 12, -12, box)).toEqual([12, -12])
    expect(keepOnPage([550, 10, 610, 40], 12, -12, box)).toEqual([2, -10])
    // Bigger than the page: no clamping.
    expect(keepOnPage([-10, 0, 700, 50], 12, 0, box)).toEqual([12, 0])
  })
})
