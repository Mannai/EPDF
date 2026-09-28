import { PDFArray, PDFDict, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { flattenFillItems } from '../../src/renderer/src/features/markup/pdf/flatten'
import { addFillMark, addFillSignature, addFillText, addShape, resizeAnnotation, updateAnnotation } from '../../src/renderer/src/features/markup/pdf/ops'
import { readAnnotations } from '../../src/renderer/src/features/markup/pdf/read'
import { buildThreads } from '../../src/renderer/src/features/markup/pdf/threads'
import { capabilities } from '../../src/renderer/src/features/markup/pdf/model'
import { annotsOf, apOps, makePdf, reload } from './markupHelpers'

const who = { author: 'Ada Lovelace', now: new Date(Date.UTC(2026, 8, 28, 9, 0, 0)) }
// 1x1 opaque PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))

const name = (d: PDFDict, k: string): string | undefined => (d.get(PDFName.of(k)) as PDFName | undefined)?.decodeText()

async function pageText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: bytes.slice(), useSystemFonts: false }).promise
  const tc = await (await doc.getPage(1)).getTextContent()
  return tc.items.map((i) => ('str' in i ? i.str : '')).join(' ')
}

describe('Fill & sign items are annotations until locked', () => {
  it('marks: a square Stamp with its own vector appearance in /C; recolourable, resizable; not a comment', async () => {
    const pdf = await makePdf()
    const id = await addFillMark(pdf, 0, { ...who, kind: 'check', center: [200, 400], size: 14, color: [0, 0, 1] })
    let [d] = annotsOf(await reload(pdf))
    expect(name(d, 'Subtype')).toBe('Stamp')
    expect(name(d, 'Name')).toBe('EpdfCheck')
    expect(name(d, 'EpdfFill')).toBe('Mark')
    expect(apOps(d)).toContain('0 0 1 RG')
    expect(apOps(d)).toMatch(/ m .* l .* l S/)
    const info = readAnnotations(pdf).find((a) => a.id === id)!
    expect(info.fillSign).toBe('Mark')
    expect(capabilities(info)).toMatchObject({ recolor: true, resize: true, move: true })
    expect(buildThreads(readAnnotations(pdf))).toHaveLength(0) // not listed as a comment

    await updateAnnotation(pdf, id, { color: [1, 0, 0] })
    await resizeAnnotation(pdf, id, [190, 390, 230, 430])
    ;[d] = annotsOf(await reload(pdf))
    expect(apOps(d)).toContain('1 0 0 RG')
    // the stroke scales with the box: 0.13 x 40
    expect(apOps(d)).toContain('5.2 w')
  })

  it('cross and dot draw their own shapes', async () => {
    const pdf = await makePdf()
    await addFillMark(pdf, 0, { ...who, kind: 'cross', center: [100, 100], size: 12, color: [0, 0, 0] })
    await addFillMark(pdf, 0, { ...who, kind: 'dot', center: [150, 100], size: 12, color: [0, 0, 0] })
    const [cross, dot] = annotsOf(await reload(pdf))
    expect((apOps(cross).match(/ S/g) ?? []).length).toBe(2)
    expect(apOps(dot)).toMatch(/ c f/)
  })

  it('text: a borderless typewriter FreeText (Arabic through the text engine)', async () => {
    const pdf = await makePdf()
    await addFillText(pdf, 0, { ...who, rect: [72, 500, 300, 530], text: 'Ada Lovelace', size: 12, color: [0, 0, 0] })
    await addFillText(pdf, 0, { ...who, rect: [72, 450, 300, 480], text: 'مرحبا بالعالم', size: 14, color: [0, 0, 0] })
    const [latin, arabic] = annotsOf(await reload(pdf))
    expect(name(latin, 'Subtype')).toBe('FreeText')
    expect(name(latin, 'IT')).toBe('FreeTextTypeWriter')
    expect(name(latin, 'EpdfFill')).toBe('Text')
    expect(name(arabic, 'EpdfFill')).toBe('Text')
    expect(readAnnotations(pdf).every((a) => a.borderWidth === 0 && a.fill === null)).toBe(true)
  })

  it('signature: an image stamp of the requested width with the image aspect ratio', async () => {
    const pdf = await makePdf()
    await addFillSignature(pdf, 0, { ...who, png: PNG, center: [300, 200], width: 150, label: 'Signature' })
    const [d] = annotsOf(await reload(pdf))
    expect(name(d, 'EpdfFill')).toBe('Signature')
    const r = d.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => Number(n.toString()))
    expect(r[2] - r[0]).toBeCloseTo(150, 3)
    expect(r[3] - r[1]).toBeCloseTo(150, 3) // 1x1 image: square
    expect(apOps(d)).toContain('/Im0 Do')
  })

  it('locking draws every Fill & sign item into the page and removes it; other annotations stay; text stays readable', async () => {
    const pdf = await makePdf()
    await addFillMark(pdf, 0, { ...who, kind: 'check', center: [200, 400], size: 14, color: [0, 0, 0] })
    await addFillText(pdf, 0, { ...who, rect: [72, 500, 300, 530], text: 'Signed by Ada', size: 12, color: [0, 0, 0] })
    await addFillSignature(pdf, 0, { ...who, png: PNG, center: [300, 200], width: 150, label: 'Signature' })
    await addShape(pdf, 0, { ...who, kind: 'Square', rect: [10, 10, 50, 50], color: [1, 0, 0], fill: null, width: 1, opacity: 1, dashed: false })
    expect(flattenFillItems(pdf)).toBe(3)
    const back = await reload(pdf)
    expect(annotsOf(back).map((d) => name(d, 'Subtype'))).toEqual(['Square'])
    const page = back.getPage(0)
    const xo = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    expect(xo.keys().filter((k) => k.decodeText().startsWith('EpdfFl'))).toHaveLength(3)
    // Another reader (PDF.js) now finds the typed text in the page itself.
    expect(await pageText(await back.save())).toContain('Signed by Ada')
    // Nothing left to lock.
    expect(flattenFillItems(back)).toBe(0)
  })
})
