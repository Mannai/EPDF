import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { listLocated } from '../../src/renderer/src/features/markup/pdf/annots'
import { infoOfDict } from '../../src/renderer/src/features/markup/pdf/appearance'
import { parsePdfDate } from '../../src/renderer/src/features/markup/pdf/basics'
import {
  addFreeText,
  addImageStamp,
  addInk,
  addLine,
  addNote,
  addReply,
  addShape,
  addStamp,
  addTextMarkup,
  countReplies,
  deleteAnnotation,
  moveAnnotation,
  resizeAnnotation,
  setReviewState,
  updateAnnotation
} from '../../src/renderer/src/features/markup/pdf/ops'
import { get, getDict, getName, getNumbers, getString } from '../../src/renderer/src/features/markup/pdf/pdfobj'
import { readAnnotations } from '../../src/renderer/src/features/markup/pdf/read'
import { STAMPS } from '../../src/renderer/src/features/markup/pdf/stamps'
import { viewRectToQuad } from '../../src/renderer/src/features/markup/pdf/quads'
import {
  annotsOf,
  apBBox,
  apMatrix,
  apOps,
  apResources,
  makePdf,
  nameOf,
  reload,
  subtypes,
  validateAnnotations
} from './markupHelpers'

const who = { author: 'Ada Lovelace', now: new Date(Date.UTC(2026, 8, 25, 12, 0, 0)) }
const quadAt = (x: number, y: number, w = 100, h = 14): number[] => [x, y + h, x + w, y + h, x, y, x + w, y]
const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
)

/** Saves and reloads so assertions run against what another reader would parse. */
async function roundTrip(pdf: PDFDocument): Promise<PDFDocument> {
  const back = await reload(pdf)
  expect(validateAnnotations(back)).toEqual([])
  return back
}

describe('text markup annotations', () => {
  it('Highlight: dictionary, QuadPoints, colour, opacity and a multiply-blend appearance', async () => {
    const pdf = await makePdf()
    const id = await addTextMarkup(pdf, 0, { ...who, subtype: 'Highlight', quads: [quadAt(72, 700), quadAt(72, 684, 60)], color: [1, 0.9, 0.2], opacity: 0.6 })
    expect(id).toMatch(/^\d+ \d+$/)
    const [d] = annotsOf(await roundTrip(pdf))
    expect(nameOf(d, 'Type')).toBe('Annot')
    expect(nameOf(d, 'Subtype')).toBe('Highlight')
    expect(getNumbers(d, 'QuadPoints')).toEqual([...quadAt(72, 700), ...quadAt(72, 684, 60)])
    expect(getNumbers(d, 'Rect')).toEqual([72, 684, 172, 714])
    expect(getNumbers(d, 'C')).toEqual([1, 0.9, 0.2])
    expect(d.lookup(PDFName.of('CA'))).toMatchObject({ numberValue: 0.6 })
    expect(getString(d, 'T')).toBe('Ada Lovelace')
    expect(getString(d, 'NM')).toMatch(/^epdf-/)
    expect(parsePdfDate(getString(d, 'M'))).toBe(who.now.getTime())
    expect(parsePdfDate(getString(d, 'CreationDate'))).toBe(who.now.getTime())
    expect(d.lookup(PDFName.of('F')).toString()).toBe('4')
    expect(apBBox(d)).toEqual([72, 684, 172, 714]) // BBox == Rect: identity mapping
    expect(apMatrix(d)).toBeUndefined()
    const ops = apOps(d)
    expect(ops).toContain('/GS0 gs')
    expect(ops).toContain('1 0.9 0.2 rg')
    expect(ops.match(/ f\n/g)).toHaveLength(2) // one filled polygon per quad
    const gs = getDict(getDict(apResources(d), 'ExtGState')!, 'GS0')!
    expect(getName(gs, 'BM')).toBe('Multiply')
    expect(gs.lookup(PDFName.of('ca'))).toMatchObject({ numberValue: 0.6 })
    expect(gs.lookup(PDFName.of('CA'))).toMatchObject({ numberValue: 0.6 })
  })

  it('Underline and StrikeOut draw stroked lines in the chosen colour without blend mode', async () => {
    const pdf = await makePdf()
    await addTextMarkup(pdf, 0, { ...who, subtype: 'Underline', quads: [quadAt(72, 700)], color: [1, 0, 0], opacity: 1 })
    await addTextMarkup(pdf, 0, { ...who, subtype: 'StrikeOut', quads: [quadAt(72, 680)], color: [0, 0, 1], opacity: 1 })
    const [u, s] = annotsOf(await roundTrip(pdf))
    expect(apOps(u)).toContain('1 0 0 RG')
    expect(apOps(u)).toMatch(/ S\n/)
    expect(apOps(u)).not.toMatch(/ f\n/)
    // strikeout line at half height: y = 680 + 7
    expect(apOps(s)).toContain('72 687 m 172 687 l S')
    expect(getDict(getDict(apResources(u), 'ExtGState')!, 'GS0')!.get(PDFName.of('BM'))).toBeUndefined()
    // CA is omitted at full opacity
    expect(u.get(PDFName.of('CA'))).toBeUndefined()
  })

  it('Squiggly draws a zig-zag polyline', async () => {
    const pdf = await makePdf()
    await addTextMarkup(pdf, 0, { ...who, subtype: 'Squiggly', quads: [quadAt(72, 700, 200)], color: [0, 0.5, 0], opacity: 1 })
    const [d] = annotsOf(await roundTrip(pdf))
    expect((apOps(d).match(/ l /g) ?? []).length).toBeGreaterThan(10)
  })

  it('rejects an empty selection', async () => {
    const pdf = await makePdf()
    await expect(addTextMarkup(pdf, 0, { ...who, subtype: 'Highlight', quads: [], color: [1, 1, 0], opacity: 1 })).rejects.toThrow()
  })

  it('quads built from view rects on a rotated, cropped page land inside the page /Rect', async () => {
    const pdf = await makePdf({ rotation: 90, cropBox: [20, 30, 500, 700] })
    const g = { box: [20, 30, 500, 700] as [number, number, number, number], rotation: 90 as const }
    const q = viewRectToQuad(g, [50, 40, 150, 60])
    await addTextMarkup(pdf, 0, { ...who, subtype: 'Highlight', quads: [q], color: [1, 1, 0], opacity: 1 })
    const [d] = annotsOf(await roundTrip(pdf))
    const [x0, y0, x1, y1] = getNumbers(d, 'Rect')!
    expect(x0).toBeGreaterThanOrEqual(20)
    expect(x1).toBeLessThanOrEqual(500)
    expect(y0).toBeGreaterThanOrEqual(30)
    expect(y1).toBeLessThanOrEqual(700)
    expect(x1 - x0).toBeCloseTo(20) // 20 view points tall = 20 PDF points wide after rotation
    expect(y1 - y0).toBeCloseTo(100)
  })
})

describe('sticky notes', () => {
  it('Text annotation with icon name, contents and a 24pt appearance', async () => {
    const pdf = await makePdf()
    await addNote(pdf, 0, { ...who, center: [200, 300], contents: 'Check this figure', color: [1, 0.85, 0.2], icon: 'Note' })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(nameOf(d, 'Subtype')).toBe('Text')
    expect(nameOf(d, 'Name')).toBe('Note')
    expect(getString(d, 'Contents')).toBe('Check this figure')
    expect(getNumbers(d, 'Rect')).toEqual([188, 288, 212, 312])
    expect(apBBox(d)).toEqual([0, 0, 24, 24])
    expect(apMatrix(d)).toEqual([1, 0, 0, 1, 0, 0])
    expect(apOps(d)).toContain('re B')
  })

  it('keeps the icon inside the page and supports the Comment icon', async () => {
    const pdf = await makePdf()
    await addNote(pdf, 0, { ...who, center: [-50, 9999], contents: '', color: [1, 0.85, 0.2], icon: 'Comment' })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(getNumbers(d, 'Rect')).toEqual([0, 768, 24, 792])
    expect(nameOf(d, 'Name')).toBe('Comment')
  })
})

describe('text boxes (FreeText)', () => {
  it('has /DA, /BS, /Q and an appearance with wrapped text and the Helvetica font resource', async () => {
    const pdf = await makePdf()
    await addFreeText(pdf, 0, {
      ...who,
      rect: [100, 500, 220, 560],
      text: 'The quick brown fox jumps over the lazy dog',
      fontSize: 12,
      color: [0, 0, 0.8],
      fill: [1, 1, 0.8],
      borderWidth: 1
    })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(nameOf(d, 'Subtype')).toBe('FreeText')
    expect(getString(d, 'DA')).toBe('0 0 0.8 rg /Helv 12 Tf')
    expect(getString(d, 'Contents')).toBe('The quick brown fox jumps over the lazy dog')
    expect(getNumbers(d, 'C')).toEqual([1, 1, 0.8])
    expect(getDict(d, 'BS')!.lookup(PDFName.of('W')).toString()).toBe('1')
    const ops = apOps(d)
    expect(ops).toContain('/Helv 12 Tf')
    expect((ops.match(/ Tj/g) ?? []).length).toBeGreaterThanOrEqual(3) // wrapped onto several lines
    expect(ops).toContain('1 1 0.8 rg 0 0 120 60 re f') // background fill
    expect(ops).toContain('0 0 0.8 RG 1 w') // border colour = text colour
    expect(apBBox(d)).toEqual([0, 0, 120, 60])
    const font = get(apResources(d), 'Font') as PDFDict
    const helv = (font as PDFDict).lookup(PDFName.of('Helv'))
    expect(helv).toBeInstanceOf(PDFDict)
    expect(getName(helv as PDFDict, 'BaseFont')).toBe('Helvetica')
  })

  it('grows the box downwards when the text does not fit', async () => {
    const pdf = await makePdf()
    await addFreeText(pdf, 0, {
      ...who,
      rect: [100, 500, 160, 520],
      text: 'one two three four five six seven eight nine ten',
      fontSize: 12,
      color: [0, 0, 0],
      fill: null,
      borderWidth: 0
    })
    const [d] = annotsOf(await roundTrip(pdf))
    const r = getNumbers(d, 'Rect')!
    expect(r[3]).toBe(520) // top is fixed
    expect(r[1]).toBeLessThan(500) // grew downwards
    expect(d.get(PDFName.of('C'))).toBeUndefined() // no fill
  })

  it('on a page rotated 90° the appearance is authored upright and rotated back by /Matrix', async () => {
    const pdf = await makePdf({ rotation: 90 })
    // Displayed 200 wide x 50 tall = PDF rect 50 wide x 200 tall.
    await addFreeText(pdf, 0, { ...who, rect: [300, 300, 350, 500], text: 'Sideways', fontSize: 12, color: [0, 0, 0], fill: null, borderWidth: 1 })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(apBBox(d)).toEqual([0, 0, 200, 50])
    expect(apMatrix(d)).toEqual([0, 1, -1, 0, 50, 0])
    const info = infoOfDict(d)!
    expect(info.rect).toEqual([300, 300, 350, 500])
  })

  it('replaces characters the standard font cannot show instead of failing', async () => {
    const pdf = await makePdf()
    await addFreeText(pdf, 0, { ...who, rect: [100, 500, 300, 560], text: '日本語 ok', fontSize: 12, color: [0, 0, 0], fill: null, borderWidth: 0 })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(getString(d, 'Contents')).toBe('日本語 ok') // the comment text itself keeps Unicode
    expect(apOps(d)).toMatch(/<[0-9a-fA-F]+> Tj/)
  })
})

describe('freehand drawing (Ink)', () => {
  it('has /InkList, /BS width, colour, opacity and a stroked polyline appearance', async () => {
    const pdf = await makePdf()
    await addInk(pdf, 0, {
      ...who,
      strokes: [
        [[100, 100], [120, 130], [150, 110], [180, 160]],
        [[300, 300], [310, 320]]
      ],
      color: [0.9, 0.1, 0.1],
      width: 3,
      opacity: 0.7
    })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(nameOf(d, 'Subtype')).toBe('Ink')
    const list = d.lookup(PDFName.of('InkList')) as PDFArray
    expect(list.size()).toBe(2)
    expect(getNumbers(d, 'C')).toEqual([0.9, 0.1, 0.1])
    expect(getDict(d, 'BS')!.lookup(PDFName.of('W')).toString()).toBe('3')
    // stroke bounds [100,100,310,320] padded by width/2 + 1
    expect(getNumbers(d, 'Rect')).toEqual([97.5, 97.5, 312.5, 322.5])
    expect(apBBox(d)).toEqual([97.5, 97.5, 312.5, 322.5])
    expect(apOps(d)).toContain('0.9 0.1 0.1 RG 3 w 1 J 1 j')
    expect(apOps(d)).toContain('100 100 m 120 130 l 150 110 l 180 160 l S')
    expect(d.lookup(PDFName.of('CA'))).toMatchObject({ numberValue: 0.7 })
  })

  it('rejects an empty drawing', async () => {
    const pdf = await makePdf()
    await expect(addInk(pdf, 0, { ...who, strokes: [[[1, 1]]], color: [0, 0, 0], width: 1, opacity: 1 })).rejects.toThrow()
  })
})

describe('shapes', () => {
  it('Rectangle: /Square with /IC, dashed /BS and a filled+stroked appearance inset by half the width', async () => {
    const pdf = await makePdf()
    await addShape(pdf, 0, { ...who, kind: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0], fill: [1, 1, 0], width: 4, opacity: 0.5, dashed: true })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(nameOf(d, 'Subtype')).toBe('Square')
    expect(getNumbers(d, 'IC')).toEqual([1, 1, 0])
    const bs = getDict(d, 'BS')!
    expect(getName(bs, 'S')).toBe('D')
    expect(getNumbers(bs, 'D')).toEqual([3, 2])
    const ops = apOps(d)
    expect(ops).toContain('102 102 96 56 re')
    expect(ops).toContain('[12 8] 0 d')
    expect(ops.trim().endsWith('B')).toBe(true)
    expect(apBBox(d)).toEqual([100, 100, 200, 160])
  })

  it('Ellipse: /Circle drawn with four Bézier curves; no fill means stroke only', async () => {
    const pdf = await makePdf()
    await addShape(pdf, 0, { ...who, kind: 'Circle', rect: [100, 100, 200, 160], color: [0, 0, 1], fill: null, width: 2, opacity: 1, dashed: false })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(nameOf(d, 'Subtype')).toBe('Circle')
    expect(d.get(PDFName.of('IC'))).toBeUndefined()
    const ops = apOps(d)
    expect((ops.match(/ c /g) ?? []).length).toBe(4)
    expect(ops.trim().endsWith('S')).toBe(true)
    expect(ops).toContain('[] 0 d')
  })

  it('Line: /L, /LE and an appearance with the shaft', async () => {
    const pdf = await makePdf()
    await addLine(pdf, 0, { ...who, from: [100, 100], to: [300, 100], arrow: false, color: [0, 0, 0], width: 2, opacity: 1, dashed: false })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(nameOf(d, 'Subtype')).toBe('Line')
    expect(getNumbers(d, 'L')).toEqual([100, 100, 300, 100])
    expect((d.lookup(PDFName.of('LE')) as PDFArray).asArray().map((o) => (o as PDFName).decodeText())).toEqual(['None', 'None'])
    expect(apOps(d)).toContain('100 100 m 300 100 l S')
  })

  it('Arrow: /LE [/None /OpenArrow], /IT /LineArrow and arrowhead strokes; /Rect contains the head', async () => {
    const pdf = await makePdf()
    await addLine(pdf, 0, { ...who, from: [100, 100], to: [300, 200], arrow: true, color: [0.8, 0, 0], width: 2, opacity: 1, dashed: false })
    const [d] = annotsOf(await roundTrip(pdf))
    expect((d.lookup(PDFName.of('LE')) as PDFArray).asArray().map((o) => (o as PDFName).decodeText())).toEqual(['None', 'OpenArrow'])
    expect(nameOf(d, 'IT')).toBe('LineArrow')
    // shaft + two head strokes
    expect(apOps(d).match(/ S\n/g)).toHaveLength(2)
    const [x0, y0, x1, y1] = getNumbers(d, 'Rect')!
    expect(x0).toBeLessThan(100)
    expect(x1).toBeGreaterThan(300)
    expect(y0).toBeLessThan(100)
    expect(y1).toBeGreaterThan(200)
    // the appearance's bbox equals the annotation rect (absolute coordinates)
    expect(apBBox(d)).toEqual([x0, y0, x1, y1])
  })
})

describe('stamps', () => {
  it.each(STAMPS.map((s) => s.name))('built-in stamp %s: /Name, label, font resource, vector appearance', async (name) => {
    const pdf = await makePdf()
    await addStamp(pdf, 0, { ...who, name, center: [300, 400] })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(nameOf(d, 'Subtype')).toBe('Stamp')
    expect(nameOf(d, 'Name')).toBe(name)
    const bb = apBBox(d)
    const r = getNumbers(d, 'Rect')!
    expect(bb).toEqual([0, 0, r[2] - r[0], r[3] - r[1]])
    expect(apOps(d)).toMatch(/\/HelvB [\d.]+ Tf/)
    expect(apOps(d)).toMatch(/<[0-9a-fA-F]+> Tj/)
    const f = (get(apResources(d), 'Font') as PDFDict).lookup(PDFName.of('HelvB')) as PDFDict
    expect(getName(f, 'BaseFont')).toBe('Helvetica-Bold')
    // centred on the click
    expect((r[0] + r[2]) / 2).toBeCloseTo(300, 0)
    expect((r[1] + r[3]) / 2).toBeCloseTo(400, 0)
  })

  it('rejects an unknown stamp name', async () => {
    const pdf = await makePdf()
    await expect(addStamp(pdf, 0, { ...who, name: 'Bogus', center: [1, 1] })).rejects.toThrow(/Unknown stamp/)
  })

  it('stamps stay inside the page and swap dimensions on a rotated page', async () => {
    const pdf = await makePdf({ rotation: 90 })
    await addStamp(pdf, 0, { ...who, name: 'Approved', center: [0, 0] })
    const [d] = annotsOf(await roundTrip(pdf))
    const r = getNumbers(d, 'Rect')!
    expect(r[0]).toBeGreaterThanOrEqual(0)
    expect(r[1]).toBeGreaterThanOrEqual(0)
    expect(r[2] - r[0]).toBe(44) // upright height becomes the PDF-space width
    expect(apMatrix(d)![0]).toBe(0)
  })

  it('custom image stamp: image XObject in the appearance, scaled to fit, embedded once', async () => {
    const pdf = await makePdf()
    await addImageStamp(pdf, 0, { ...who, kind: 'png', bytes: PNG, label: 'logo.png', center: [300, 400], maxSize: 100 })
    const back = await roundTrip(pdf)
    const [d] = annotsOf(back)
    expect(nameOf(d, 'Name')).toBe('Image')
    expect(getString(d, 'Contents')).toBe('logo.png')
    expect(apOps(d)).toContain('/Im0 Do')
    const xo = getDict(apResources(d), 'XObject')!
    const im = xo.lookup(PDFName.of('Im0')) as PDFStream
    expect(getName(im.dict, 'Subtype')).toBe('Image')
    expect(getNumbers(d, 'Rect')).toEqual([250, 350, 350, 450])
  })
})

describe('/Annots handling', () => {
  it('adds to a page without /Annots, to a direct array and to an indirect array, preserving what was there', async () => {
    for (const variant of [{}, { directAnnots: true }, { indirectAnnots: true }] as const) {
      const pdf = await makePdf(variant)
      await addNote(pdf, 0, { ...who, center: [100, 100], contents: 'x', color: [1, 1, 0], icon: 'Note' })
      const back = await roundTrip(pdf)
      const expected = 'directAnnots' in variant || 'indirectAnnots' in variant ? ['Link', 'Text'] : ['Text']
      expect(subtypes(back)).toEqual(expected)
      if ('indirectAnnots' in variant) {
        // the array stayed an indirect object
        expect(back.getPage(0).node.get(PDFName.of('Annots'))).toBeInstanceOf(PDFRef)
      }
    }
  })

  it('deleting removes only the target (and its appearance), keeping links and other annotations', async () => {
    const pdf = await makePdf({ indirectAnnots: true })
    const a = await addNote(pdf, 0, { ...who, center: [100, 100], contents: 'first', color: [1, 1, 0], icon: 'Note' })
    await addNote(pdf, 0, { ...who, center: [200, 100], contents: 'second', color: [1, 1, 0], icon: 'Note' })
    const objectsBefore = pdf.context.enumerateIndirectObjects().length
    deleteAnnotation(pdf, a)
    expect(pdf.context.enumerateIndirectObjects().length).toBeLessThan(objectsBefore - 1) // dict + AP stream gone
    const back = await roundTrip(pdf)
    expect(subtypes(back)).toEqual(['Link', 'Text'])
    expect(getString(annotsOf(back)[1], 'Contents')).toBe('second')
    expect(back.getPage(0).node.get(PDFName.of('Annots'))).toBeInstanceOf(PDFRef)
  })

  it('handles direct dictionaries in /Annots (ids by position) and skips junk entries', async () => {
    const pdf = await makePdf({ directAnnots: true })
    const arr = pdf.getPage(0).node.get(PDFName.of('Annots')) as PDFArray
    arr.push(pdf.context.obj(null))
    arr.push(pdf.context.obj(42))
    arr.push(
      pdf.context.obj({ Type: 'Annot', Subtype: 'Caret', Rect: [50, 50, 60, 60], Contents: PDFString.of('insert here'), T: PDFString.of('Other') })
    )
    arr.push(pdf.context.obj({ Type: 'Annot', Subtype: 'Highlight' })) // no /Rect: ignored, not fatal
    const all = readAnnotations(pdf)
    expect(all).toHaveLength(1)
    expect(all[0].subtype).toBe('Caret')
    expect(all[0].id).toBe('p0.3')
    await updateAnnotation(pdf, all[0].id, { contents: 'changed' })
    moveAnnotation(pdf, all[0].id, 10, 10)
    const back = await reload(pdf)
    const caret = readAnnotations(back)[0]
    expect(caret.contents).toBe('changed')
    expect(caret.rect).toEqual([60, 60, 70, 70])
    deleteAnnotation(back, caret.id)
    expect(readAnnotations(back)).toEqual([])
    expect(subtypes(await reload(back))).toEqual(['Link', 'Highlight'])
  })

  it('creates annotations on the right page of a multi-page document', async () => {
    const pdf = await makePdf({ pages: 3 })
    await addNote(pdf, 2, { ...who, center: [100, 100], contents: 'on three', color: [1, 1, 0], icon: 'Note' })
    const back = await roundTrip(pdf)
    expect(subtypes(back, 0)).toEqual([])
    expect(subtypes(back, 2)).toEqual(['Text'])
    expect(readAnnotations(back)[0].pageIndex).toBe(2)
    await expect(addNote(pdf, 9, { ...who, center: [1, 1], contents: '', color: [1, 1, 0], icon: 'Note' })).rejects.toThrow(/Page 10/)
  })
})

describe('replies and review state', () => {
  it('a reply is a Text annotation with /IRT and /RT /R, without an appearance', async () => {
    const pdf = await makePdf()
    const parent = await addNote(pdf, 0, { ...who, center: [100, 100], contents: 'question', color: [1, 1, 0], icon: 'Note' })
    const reply = addReply(pdf, parent, { author: 'Bob', text: 'answer', now: new Date(who.now.getTime() + 1000) })
    const back = await roundTrip(pdf)
    const all = readAnnotations(back)
    const p = all.find((a) => a.id === parent)!
    const r = all.find((a) => a.id === reply)!
    expect(r.irt).toBe(parent)
    expect(r.replyType).toBe('R')
    expect(r.author).toBe('Bob')
    expect(r.contents).toBe('answer')
    expect(r.hasAppearance).toBe(false)
    expect(p.irt).toBeNull()
    const d = listLocated(back).find((l) => l.id === reply)!.dict
    expect(d.get(PDFName.of('IRT'))).toBeInstanceOf(PDFRef)
    expect(nameOf(d, 'RT')).toBe('R')
    expect(d.lookup(PDFName.of('F')).toString()).toBe('28')
  })

  it('resolve/reopen are state-change annotations (/StateModel /Review); the newest wins', async () => {
    const pdf = await makePdf()
    const parent = await addNote(pdf, 0, { ...who, center: [100, 100], contents: 'todo', color: [1, 1, 0], icon: 'Note' })
    setReviewState(pdf, parent, 'Completed', { author: 'Bob', now: new Date(who.now.getTime() + 1000) })
    const back = await roundTrip(pdf)
    const st = readAnnotations(back).find((a) => a.stateModel === 'Review')!
    expect(st.state).toBe('Completed')
    expect(st.irt).toBe(parent)
    const d = listLocated(back).find((l) => l.id === st.id)!.dict
    expect(getString(d, 'StateModel')).toBe('Review')
    expect(getString(d, 'State')).toBe('Completed')
  })

  it('deleting a comment removes its replies and state records; counts them for the confirmation', async () => {
    const pdf = await makePdf()
    const parent = await addNote(pdf, 0, { ...who, center: [100, 100], contents: 'thread', color: [1, 1, 0], icon: 'Note' })
    const keep = await addNote(pdf, 0, { ...who, center: [300, 100], contents: 'keep', color: [1, 1, 0], icon: 'Note' })
    const r1 = addReply(pdf, parent, { ...who, text: 'r1' })
    addReply(pdf, r1, { ...who, text: 'nested' })
    setReviewState(pdf, parent, 'Accepted', who)
    expect(countReplies(pdf, parent)).toBe(3)
    expect(countReplies(pdf, keep)).toBe(0)
    deleteAnnotation(pdf, parent)
    const back = await roundTrip(pdf)
    expect(readAnnotations(back).map((a) => a.contents)).toEqual(['keep'])
  })

  it('refuses to reply to something that no longer exists', async () => {
    const pdf = await makePdf()
    expect(() => addReply(pdf, '999 0', { ...who, text: 'x' })).toThrow(/no longer exists/)
    expect(() => setReviewState(pdf, '999 0', 'Completed', who)).toThrow()
  })
})

describe('editing annotations', () => {
  it('changing contents updates /Contents and /M, and drops stale rich text', async () => {
    const pdf = await makePdf()
    const id = await addNote(pdf, 0, { ...who, center: [100, 100], contents: 'old', color: [1, 1, 0], icon: 'Note' })
    listLocated(pdf).find((l) => l.id === id)!.dict.set(PDFName.of('RC'), PDFString.of('<body><p>old</p></body>'))
    await updateAnnotation(pdf, id, { contents: 'new text' }, { now: new Date(who.now.getTime() + 60000) })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(getString(d, 'Contents')).toBe('new text')
    expect(d.get(PDFName.of('RC'))).toBeUndefined()
    expect(parsePdfDate(getString(d, 'M'))).toBe(who.now.getTime() + 60000)
    expect(parsePdfDate(getString(d, 'CreationDate'))).toBe(who.now.getTime())
  })

  it('recolouring a highlight rewrites both /C and the appearance; opacity changes /CA and the graphics state', async () => {
    const pdf = await makePdf()
    const id = await addTextMarkup(pdf, 0, { ...who, subtype: 'Highlight', quads: [quadAt(72, 700)], color: [1, 1, 0], opacity: 1 })
    const before = listLocated(pdf).find((l) => l.id === id)!.dict.get(PDFName.of('AP'))
    await updateAnnotation(pdf, id, { color: [0, 1, 0], opacity: 0.4 })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(getNumbers(d, 'C')).toEqual([0, 1, 0])
    expect(apOps(d)).toContain('0 1 0 rg')
    expect(apOps(d)).not.toContain('1 1 0 rg')
    expect(d.lookup(PDFName.of('CA'))).toMatchObject({ numberValue: 0.4 })
    expect(before).toBeDefined()
    // the replaced appearance stream of our own annotation does not linger
    const streams = pdf.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Form')
    expect(streams).toHaveLength(1)
  })

  it('FreeText: editing text regenerates the appearance and grows the box; colour changes /DA', async () => {
    const pdf = await makePdf()
    const id = await addFreeText(pdf, 0, { ...who, rect: [100, 500, 200, 530], text: 'short', fontSize: 12, color: [0, 0, 0], fill: null, borderWidth: 1 })
    await updateAnnotation(pdf, id, { contents: 'a much longer text that certainly needs several lines to be displayed', color: [1, 0, 0] })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(getString(d, 'DA')).toBe('1 0 0 rg /Helv 12 Tf')
    expect(apOps(d)).toContain('1 0 0 rg')
    expect((apOps(d).match(/ Tj/g) ?? []).length).toBeGreaterThan(2)
    expect(getNumbers(d, 'Rect')![1]).toBeLessThan(500)
    expect(infoOfDict(d)!.contents).toContain('several lines')
  })

  it('shape options: width, dash, fill and removing the fill', async () => {
    const pdf = await makePdf()
    const id = await addShape(pdf, 0, { ...who, kind: 'Square', rect: [100, 100, 200, 160], color: [1, 0, 0], fill: [1, 1, 0], width: 1, opacity: 1, dashed: false })
    await updateAnnotation(pdf, id, { borderWidth: 6, dashed: true, fill: null })
    const [d] = annotsOf(await roundTrip(pdf))
    expect(d.get(PDFName.of('IC'))).toBeUndefined()
    expect(getDict(d, 'BS')!.lookup(PDFName.of('W')).toString()).toBe('6')
    expect(getName(getDict(d, 'BS')!, 'S')).toBe('D')
    expect(apOps(d)).toContain('103 103 94 54 re')
    expect(apOps(d).trim().endsWith('S')).toBe(true)
  })

  it('moving translates /Rect and every geometry entry (QuadPoints, InkList, L) together', async () => {
    const pdf = await makePdf()
    const h = await addTextMarkup(pdf, 0, { ...who, subtype: 'Highlight', quads: [quadAt(72, 700)], color: [1, 1, 0], opacity: 1 })
    const ink = await addInk(pdf, 0, { ...who, strokes: [[[10, 10], [20, 30]]], color: [0, 0, 0], width: 1, opacity: 1 })
    const ln = await addLine(pdf, 0, { ...who, from: [100, 100], to: [200, 100], arrow: false, color: [0, 0, 0], width: 1, opacity: 1, dashed: false })
    for (const id of [h, ink, ln]) moveAnnotation(pdf, id, 15, -5)
    const back = await roundTrip(pdf)
    const [dh, di, dl] = annotsOf(back)
    expect(getNumbers(dh, 'QuadPoints')).toEqual(quadAt(72, 700).map((v, i) => (i % 2 ? v - 5 : v + 15)))
    expect(getNumbers(dh, 'Rect')).toEqual([87, 695, 187, 709])
    expect((di.lookup(PDFName.of('InkList')) as PDFArray).lookup(0, PDFArray).asArray().map((n) => n.toString())).toEqual(['25', '5', '35', '25'])
    expect(getNumbers(dl, 'L')).toEqual([115, 95, 215, 95])
    // the appearance still maps onto the (moved) rect
    expect(apBBox(dh)).toEqual([72, 700, 172, 714])
    expect(infoOfDict(dh)!.rect).toEqual([87, 695, 187, 709])
  })

  it('resizing a text box regenerates its appearance for the new size; a drawing is scaled with its rect', async () => {
    const pdf = await makePdf()
    const box = await addFreeText(pdf, 0, { ...who, rect: [100, 500, 200, 560], text: 'hello', fontSize: 12, color: [0, 0, 0], fill: null, borderWidth: 1 })
    const ink = await addInk(pdf, 0, { ...who, strokes: [[[100, 100], [200, 200]]], color: [0, 0, 0], width: 2, opacity: 1 })
    await resizeAnnotation(pdf, box, [100, 480, 300, 560])
    const inkRect = infoOfDict(listLocated(pdf).find((l) => l.id === ink)!.dict)!.rect
    await resizeAnnotation(pdf, ink, [inkRect[0], inkRect[1], inkRect[0] + (inkRect[2] - inkRect[0]) * 2, inkRect[1] + (inkRect[3] - inkRect[1])])
    const back = await roundTrip(pdf)
    const [db, di] = annotsOf(back)
    expect(getNumbers(db, 'Rect')).toEqual([100, 480, 300, 560])
    expect(apBBox(db)).toEqual([0, 0, 200, 80])
    const stroke = infoOfDict(di)!.ink[0]
    expect(stroke[2] - stroke[0]).toBeCloseTo(200) // twice as wide as before
    expect(stroke[3] - stroke[1]).toBeCloseTo(100)
  })

  it('refuses to resize things that cannot be resized, and absurdly small sizes', async () => {
    const pdf = await makePdf()
    const note = await addNote(pdf, 0, { ...who, center: [100, 100], contents: '', color: [1, 1, 0], icon: 'Note' })
    const box = await addFreeText(pdf, 0, { ...who, rect: [100, 500, 200, 560], text: 'x', fontSize: 12, color: [0, 0, 0], fill: null, borderWidth: 0 })
    await expect(resizeAnnotation(pdf, note, [0, 0, 100, 100])).rejects.toThrow(/cannot be resized/)
    await expect(resizeAnnotation(pdf, box, [0, 0, 1, 1])).rejects.toThrow(/too small/)
    await expect(updateAnnotation(pdf, '999 0', { contents: 'x' })).rejects.toThrow(/no longer exists/)
  })
})

describe('annotations from other software', () => {
  /** A Highlight, a Stamp and a Caret written the way other readers do, with their own appearance streams. */
  async function foreign(): Promise<{ pdf: PDFDocument; ids: { hl: string; stamp: string; caret: string; sq: string } }> {
    const pdf = await makePdf()
    const ctx = pdf.context
    const form = (bbox: number[], ops: string): PDFRef =>
      ctx.register(ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: bbox, Resources: {} }))
    const add = (d: Record<string, unknown>): PDFRef => {
      const ref = ctx.register(ctx.obj(d as never))
      const page = pdf.getPage(0)
      const arr = page.node.get(PDFName.of('Annots'))
      if (arr instanceof PDFArray) arr.push(ref)
      else page.node.set(PDFName.of('Annots'), ctx.obj([ref]))
      return ref
    }
    const hl = add({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [72, 700, 172, 714],
      QuadPoints: [72, 714, 172, 714, 72, 700, 172, 700],
      C: [1, 0.5, 0],
      T: PDFString.of('Alice'),
      Contents: PDFString.of('foreign highlight'),
      AP: { N: form([72, 700, 172, 714], '1 0.5 0 rg 72 700 100 14 re f') }
    })
    const stamp = add({
      Type: 'Annot',
      Subtype: 'Stamp',
      Name: 'Draft',
      Rect: [300, 300, 400, 340],
      AP: { N: form([0, 0, 100, 40], '0 0 1 rg 0 0 100 40 re f') }
    })
    const caret = add({ Type: 'Annot', Subtype: 'Caret', Rect: [50, 50, 60, 60], T: PDFString.of('Alice'), Contents: PDFString.of('insert') })
    const sq = add({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [400, 400, 480, 460],
      C: [0, 0, 1],
      BE: { S: 'C', I: 1 },
      AP: { N: form([400, 400, 480, 460], '0 0 1 RG 400 400 80 60 re S') }
    })
    add({ Type: 'Annot', Subtype: 'Link', Rect: [1, 1, 5, 5] })
    add({ Type: 'Annot', Subtype: 'Widget', Rect: [1, 1, 5, 5], FT: 'Tx' })
    const id = (r: PDFRef): string => `${r.objectNumber} ${r.generationNumber}`
    return { pdf, ids: { hl: id(hl), stamp: id(stamp), caret: id(caret), sq: id(sq) } }
  }

  it('lists markup annotations only (Link and Widget are left alone) with author and contents', async () => {
    const { pdf } = await foreign()
    const all = readAnnotations(await reload(pdf))
    expect(all.map((a) => a.subtype)).toEqual(['Highlight', 'Stamp', 'Caret', 'Square'])
    expect(all[0]).toMatchObject({ author: 'Alice', contents: 'foreign highlight', ours: false, hasAppearance: true })
    expect(all[3].complex).toBe(true)
  })

  it('moves a foreign stamp without touching its appearance stream, and deletes it cleanly', async () => {
    const { pdf, ids } = await foreign()
    const before = get(getDict(listLocated(pdf).find((l) => l.id === ids.stamp)!.dict, 'AP')!, 'N')
    moveAnnotation(pdf, ids.stamp, 100, 0)
    const back = await roundTrip(pdf)
    const stamp = annotsOf(back).find((d) => nameOf(d, 'Subtype') === 'Stamp')!
    expect(getNumbers(stamp, 'Rect')).toEqual([400, 300, 500, 340])
    expect(apOps(stamp)).toBe('0 0 1 rg 0 0 100 40 re f')
    expect(before).toBeInstanceOf(PDFStream)
    const remaining = readAnnotations(back).find((a) => a.subtype === 'Stamp')!
    deleteAnnotation(back, remaining.id)
    expect(subtypes(back)).toEqual(['Highlight', 'Caret', 'Square', 'Link', 'Widget'])
  })

  it('edits the comment of a foreign annotation without regenerating its appearance', async () => {
    const { pdf, ids } = await foreign()
    await updateAnnotation(pdf, ids.caret, { contents: 'edited', color: [1, 0, 0] }) // colour is not supported for Caret
    await updateAnnotation(pdf, ids.stamp, { opacity: 0.5, color: [1, 0, 0] }) // not ours: no redraw
    const back = await roundTrip(pdf)
    const all = readAnnotations(back)
    expect(all.find((a) => a.subtype === 'Caret')!.contents).toBe('edited')
    expect(all.find((a) => a.subtype === 'Caret')!.color).toBeNull()
    const stamp = annotsOf(back).find((d) => nameOf(d, 'Subtype') === 'Stamp')!
    expect(apOps(stamp)).toBe('0 0 1 rg 0 0 100 40 re f')
  })

  it('recolours a foreign highlight from its QuadPoints (standard semantics) but never redraws a cloud-bordered square', async () => {
    const { pdf, ids } = await foreign()
    await updateAnnotation(pdf, ids.hl, { color: [0, 1, 0] })
    await updateAnnotation(pdf, ids.sq, { color: [1, 0, 0], borderWidth: 5 })
    const back = await roundTrip(pdf)
    const hl = annotsOf(back).find((d) => nameOf(d, 'Subtype') === 'Highlight')!
    expect(apOps(hl)).toContain('0 1 0 rg')
    const sq = annotsOf(back).find((d) => nameOf(d, 'Subtype') === 'Square')!
    expect(apOps(sq)).toBe('0 0 1 RG 400 400 80 60 re S')
    expect(getNumbers(sq, 'C')).toEqual([0, 0, 1])
  })

  it('a foreign square resized keeps its own appearance (scaled by /Rect), an Epdf one is redrawn', async () => {
    const { pdf, ids } = await foreign()
    const mine = await addShape(pdf, 0, { ...who, kind: 'Square', rect: [10, 10, 60, 60], color: [1, 0, 0], fill: null, width: 2, opacity: 1, dashed: false })
    await resizeAnnotation(pdf, ids.sq, [400, 400, 560, 520])
    await resizeAnnotation(pdf, mine, [10, 10, 110, 60])
    const back = await roundTrip(pdf)
    const sq = annotsOf(back).find((d) => nameOf(d, 'Subtype') === 'Square' && getString(d, 'NM') === undefined)!
    expect(getNumbers(sq, 'Rect')).toEqual([400, 400, 560, 520])
    expect(apBBox(sq)).toEqual([400, 400, 480, 460])
    const own = annotsOf(back).find((d) => getString(d, 'NM')?.startsWith('epdf-'))!
    expect(apBBox(own)).toEqual([10, 10, 110, 60])
  })
})

describe('robustness', () => {
  it('a broken annotation elsewhere does not stop creating new ones', async () => {
    const pdf = await makePdf()
    pdf.getPage(0).node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.obj(7), PDFRef.of(9999, 0)]))
    await addNote(pdf, 0, { ...who, center: [100, 100], contents: 'ok', color: [1, 1, 0], icon: 'Note' })
    const all = readAnnotations(await reload(pdf))
    expect(all).toHaveLength(1)
  })

  it('encrypted or unusual /Annots (not an array) is treated as empty and replaced only when we add', async () => {
    const pdf = await makePdf()
    pdf.getPage(0).node.set(PDFName.of('Annots'), pdf.context.obj(5))
    expect(readAnnotations(pdf)).toEqual([])
    await addNote(pdf, 0, { ...who, center: [100, 100], contents: 'ok', color: [1, 1, 0], icon: 'Note' })
    expect(readAnnotations(await reload(pdf))).toHaveLength(1)
  })
})
