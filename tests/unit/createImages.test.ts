import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFDict, PDFRef, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { addImageToPdf, ImageError, imagesToPdf, orientationMatrix, placeImage, readJpegInfo, readPngInfo, sniffImageFormat, type Matrix } from '../../src/main/features/create/images'
import { makeFakeJpeg, makePng, makeTiff, solid } from '../support/images'

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

describe('image format sniffing and headers', () => {
  it('recognises formats by content, not by name', () => {
    expect(sniffImageFormat(makeFakeJpeg(3, 2))).toBe('jpeg')
    expect(sniffImageFormat(makePng(2, 2, solid(1, 2, 3)))).toBe('png')
    expect(sniffImageFormat(makeTiff([{ w: 2, h: 2, px: solid(0, 0, 0) }]))).toBe('tiff')
    expect(sniffImageFormat(new TextEncoder().encode('hello world!'))).toBeNull()
  })

  it('reads JPEG size, EXIF orientation and JFIF density', () => {
    expect(readJpegInfo(makeFakeJpeg(640, 480))).toEqual({ width: 640, height: 480, orientation: 1, dpi: null })
    expect(readJpegInfo(makeFakeJpeg(640, 480, { orientation: 6 })).orientation).toBe(6)
    expect(readJpegInfo(makeFakeJpeg(300, 200, { dpi: 300 })).dpi).toBe(300)
  })

  it('reads PNG size and pHYs resolution', () => {
    const info = readPngInfo(makePng(30, 20, solid(0, 0, 0), { ppm: 11811 }))
    expect(info.width).toBe(30)
    expect(info.height).toBe(20)
    expect(info.dpi).toBeCloseTo(300, 0)
  })
})

describe('orientation matrices', () => {
  // Where do the stored top-left (0,1) and top-right (1,1) corners of the image land in a dw x dh box?
  const TL = 'top-left'
  const TR = 'top-right'
  const BR = 'bottom-right'
  const BL = 'bottom-left'
  const expected: Record<number, [string, string]> = {
    1: [TL, TR],
    2: [TR, TL],
    3: [BR, BL],
    4: [BL, BR],
    5: [TL, BL],
    6: [TR, BR],
    7: [BR, TR],
    8: [BL, TL]
  }
  const name = ([x, y]: [number, number], dw: number, dh: number): string => `${y > dh / 2 ? 'top' : 'bottom'}-${x > dw / 2 ? 'right' : 'left'}`
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`orientation ${o} puts the stored corners where EXIF says`, () => {
      const dw = 200
      const dh = 100
      const m = orientationMatrix(o, dw, dh)
      expect([name(apply(m, 0, 1), dw, dh), name(apply(m, 1, 1), dw, dh)]).toEqual(expected[o])
      // the whole unit square stays inside the display box
      for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const [px, py] = apply(m, x, y)
        expect(px).toBeGreaterThanOrEqual(-1e-9)
        expect(px).toBeLessThanOrEqual(dw + 1e-9)
        expect(py).toBeGreaterThanOrEqual(-1e-9)
        expect(py).toBeLessThanOrEqual(dh + 1e-9)
      }
    })
  }
})

describe('page placement', () => {
  it('sizes the page like the image, swapping width/height for rotated orientations', () => {
    expect(placeImage({ width: 400, height: 200, orientation: 1, dpi: null }, { pageSize: 'image' }).page).toEqual([400, 200])
    expect(placeImage({ width: 400, height: 200, orientation: 6, dpi: null }, { pageSize: 'image' }).page).toEqual([200, 400])
  })
  it('uses the resolution from the file when present', () => {
    const p = placeImage({ width: 600, height: 300, orientation: 1, dpi: 300 }, { pageSize: 'image' })
    expect(p.page[0]).toBeCloseTo(144)
    expect(p.page[1]).toBeCloseTo(72)
  })
  it('fits on A4/Letter with the orientation matching the picture', () => {
    const land = placeImage({ width: 3000, height: 2000, orientation: 1, dpi: null }, { pageSize: 'a4' })
    expect(land.page[0]).toBeGreaterThan(land.page[1])
    const letter = placeImage({ width: 1000, height: 2000, orientation: 1, dpi: null }, { pageSize: 'letter' })
    expect(letter.page).toEqual([612, 792])
    expect(letter.matrix[0]).toBeLessThanOrEqual(612 - 72 + 1e-6) // margin kept
  })
  it('never exceeds the PDF page size limit', () => {
    const p = placeImage({ width: 100000, height: 50000, orientation: 1, dpi: null }, { pageSize: 'image' })
    expect(Math.max(...p.page)).toBeLessThanOrEqual(14400 + 1e-6)
  })
})

describe('imagesToPdf', () => {
  it('makes one page per image, sized to the image, with the image embedded as an XObject', async () => {
    const { bytes, pages } = await imagesToPdf(
      [
        { name: 'a.jpg', bytes: makeFakeJpeg(400, 200) },
        { name: 'b.png', bytes: makePng(50, 80, solid(255, 0, 0)) }
      ],
      { pageSize: 'image' }
    )
    expect(pages).toBe(2)
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(2)
    expect(doc.getPage(0).getSize()).toEqual({ width: 400, height: 200 })
    expect(doc.getPage(1).getSize()).toEqual({ width: 50, height: 80 })
    const xobjs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    expect(xobjs.keys().length).toBe(1)
  })

  it('honours JPEG EXIF orientation by swapping the page and transforming the image', async () => {
    const { bytes } = await imagesToPdf([{ name: 'phone.jpg', bytes: makeFakeJpeg(400, 200, { orientation: 6 }) }], { pageSize: 'image' })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPage(0).getSize()).toEqual({ width: 200, height: 400 })
    const contents = doc.getPage(0).node.Contents() as unknown as PDFArray
    const content = Array.from({ length: contents.size() }, (_, i) =>
      Buffer.from(decodePDFRawStream(contents.lookup(i, PDFRawStream)).decode()).toString('latin1')
    ).join('\n')
    expect(content).toContain('0 -400 200 0 0 400 cm')
  })

  it('embeds PNG transparency as a soft mask', async () => {
    const { bytes } = await imagesToPdf([{ name: 't.png', bytes: makePng(4, 4, (x) => [10, 20, 30, x < 2 ? 0 : 255]) }], { pageSize: 'image' })
    const doc = await PDFDocument.load(bytes)
    const xobjs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const img = xobjs.lookup(xobjs.keys()[0], PDFRawStream as never) as PDFRawStream
    expect(img.dict.get(PDFName.of('SMask'))).toBeInstanceOf(PDFRef)
  })

  it('creates one page per frame of a multi-page TIFF, each with its own size', async () => {
    const tiff = makeTiff([
      { w: 60, h: 40, px: solid(255, 0, 0) },
      { w: 30, h: 90, px: solid(0, 255, 0) },
      { w: 20, h: 20, px: (x, y) => [x * 10, y * 10, 0, x < 10 ? 100 : 255], alpha: true }
    ])
    const { bytes, pages } = await imagesToPdf([{ name: 'scan.tif', bytes: tiff }], { pageSize: 'image' })
    expect(pages).toBe(3)
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(3)
    expect(doc.getPage(0).getSize()).toEqual({ width: 60, height: 40 })
    expect(doc.getPage(1).getSize()).toEqual({ width: 30, height: 90 })
    expect(doc.getPage(2).getSize()).toEqual({ width: 20, height: 20 })
    // the third frame had partly transparent pixels
    const x3 = doc.getPage(2).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const img = x3.lookup(x3.keys()[0], PDFRawStream as never) as PDFRawStream
    expect(img.dict.get(PDFName.of('SMask'))).toBeInstanceOf(PDFRef)
  })

  it('reports damaged or unsupported files with the file name', async () => {
    const pdf = await PDFDocument.create()
    await expect(addImageToPdf(pdf, 'notes.txt', new TextEncoder().encode('just some text'), { pageSize: 'image' })).rejects.toThrow(/“notes\.txt” could not be converted: it is not a JPEG, PNG or TIFF/)
    await expect(addImageToPdf(pdf, 'bad.png', makePng(2, 2, solid(0, 0, 0)).slice(0, 40), { pageSize: 'image' })).rejects.toBeInstanceOf(ImageError)
    await expect(addImageToPdf(pdf, 'bad.tif', makeTiff([{ w: 2, h: 2, px: solid(0, 0, 0) }]).slice(0, 30), { pageSize: 'image' })).rejects.toThrow(/bad\.tif/)
  })
})
