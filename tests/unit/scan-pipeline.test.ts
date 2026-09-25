import jsQR from 'jsqr'
import { unzlibSync } from 'fflate'
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { assemblePdf, encodeBilevel, encodeRaw, ScanPdfBuilder } from '../../src/shared/features/scan/assemble'
import { detectPage } from '../../src/shared/features/scan/detect'
import { A4_PT, LETTER_PT, planOutput, processPage } from '../../src/shared/features/scan/pipeline'
import { qrMatrix, qrRaster, qrSvgPath } from '../../src/shared/features/scan/qr'
import { createRgba, resizeRgba, rotateDegrees } from '../../src/shared/features/scan/image'
import { orderQuad } from '../../src/shared/features/scan/geometry'
import { makeFakeJpeg } from '../support/images'
import { meanAbsDiff, photographPage, renderTextPage } from '../support/scanImages'

describe('output planning (page size from dpi / paper)', () => {
  it('scanner pages: size in points = pixels / dpi * 72', () => {
    const p = planOutput({ width: 2480, height: 3508 }, { sourceDpi: 300, paper: 'auto', maxLongSide: 5000 })
    expect(p.pageWidthPt).toBeCloseTo(595.2, 1)
    expect(p.pageHeightPt).toBeCloseTo(841.92, 1)
    expect(p.dpi).toBe(300)
    const q = planOutput({ width: 1240, height: 1754 }, { sourceDpi: 150, paper: 'auto', maxLongSide: 5000 })
    expect(q.pageWidthPt).toBeCloseTo(595.2, 1)
    expect(q.pageHeightPt).toBeCloseTo(841.92, 1)
  })

  it('caps very large scans and keeps the physical size', () => {
    const p = planOutput({ width: 4960, height: 7016 }, { sourceDpi: 600, paper: 'auto', maxLongSide: 3508 })
    expect(Math.max(p.widthPx, p.heightPx)).toBe(3508)
    expect(p.pageWidthPt).toBeCloseTo(595.2, 0)
    expect(p.dpi).toBeCloseTo(300, 0)
  })

  it('camera pages snap to A4 / Letter when the shape is close, in either orientation', () => {
    const a4 = planOutput({ width: 1000, height: 1440 }, { paper: 'auto', maxLongSide: 3508 })
    expect([a4.pageWidthPt, a4.pageHeightPt]).toEqual([A4_PT.width, A4_PT.height])
    const letter = planOutput({ width: 1000, height: 1290 }, { paper: 'auto', maxLongSide: 3508 })
    expect([letter.pageWidthPt, letter.pageHeightPt]).toEqual([LETTER_PT.width, LETTER_PT.height])
    const land = planOutput({ width: 1450, height: 1000 }, { paper: 'auto', maxLongSide: 3508 })
    expect([land.pageWidthPt, land.pageHeightPt]).toEqual([A4_PT.height, A4_PT.width])
    expect(land.widthPx / land.heightPx).toBeCloseTo(A4_PT.height / A4_PT.width, 2)
  })

  it('an odd shape keeps its proportions and is fitted to an A4 long side; a forced paper always snaps', () => {
    const odd = planOutput({ width: 1000, height: 1000 }, { paper: 'auto', maxLongSide: 3508 })
    expect(odd.pageWidthPt).toBeCloseTo(odd.pageHeightPt, 3)
    expect(Math.max(odd.pageWidthPt, odd.pageHeightPt)).toBeCloseTo(A4_PT.height, 2)
    const forced = planOutput({ width: 1000, height: 1000 }, { paper: 'letter', maxLongSide: 3508 })
    expect([forced.pageWidthPt, forced.pageHeightPt]).toEqual([LETTER_PT.width, LETTER_PT.height])
  })
})

describe('processPage on a generated photo', () => {
  const page = renderTextPage(620, 877, 13)
  const photo = photographPage(page, { width: 900, height: 800, angle: 16, scale: 0.6, perspective: { g: 0.0002, h: -0.00015 }, background: 'wood', noise: 4, seed: 3 })
  const shaded = photographPage(page, { width: 900, height: 800, angle: 16, scale: 0.6, background: 'wood', shadow: { strength: 0.4, angle: 40 }, noise: 4, seed: 3 })

  it('detect -> rectify gives an upright A4 page that matches the original', () => {
    const found = detectPage(photo.image)!
    const out = processPage(photo.image, { quad: found.quad, preset: 'original', straighten: false, paper: 'auto', maxLongSide: 877 })
    expect([out.pageWidthPt, out.pageHeightPt]).toEqual([A4_PT.width, A4_PT.height])
    // compare against the flat page at the same size (shadow and detection error allow some difference)
    const truth = resizeRgba(page, out.image.width, out.image.height)
    expect(meanAbsDiff(out.image, truth)).toBeLessThan(45)
  })

  it('with the exact corners the result is close to the flat page', () => {
    const out = processPage(photo.image, { quad: orderQuad(photo.corners), preset: 'original', straighten: false, paper: 'a4', maxLongSide: 877 })
    const truth = resizeRgba(page, out.image.width, out.image.height)
    expect(meanAbsDiff(out.image, truth)).toBeLessThan(30)
  })

  it('B&W preset returns only black and white', () => {
    const out = processPage(shaded.image, { quad: orderQuad(shaded.corners), preset: 'bw', straighten: true, paper: 'auto', maxLongSide: 800 })
    for (let i = 0; i < out.image.data.length; i += 4) expect([0, 255]).toContain(out.image.data[i])
  })

  it('straighten removes a residual tilt after the crop', () => {
    const tilted = rotateDegrees(page, 3.5)
    const out = processPage(tilted, { quad: null, preset: 'original', straighten: true, paper: 'none', sourceDpi: 200 })
    expect(out.skewDegrees).toBeGreaterThan(3)
    expect(out.skewDegrees).toBeLessThan(4)
  })

  it('rotation is applied to the source first (quad stays valid for the rotated image)', () => {
    const img = createRgba(200, 100)
    const out = processPage(img, { quad: null, rotation: 1, preset: 'original', straighten: false, paper: 'none', sourceDpi: 100 })
    expect([out.image.width, out.image.height]).toEqual([100, 200])
    expect(out.pageWidthPt).toBeCloseTo(72, 3)
    expect(out.pageHeightPt).toBeCloseTo(144, 3)
  })

  it('a degenerate quad is refused with a helpful message', () => {
    const p = { x: 0.5, y: 0.5 }
    expect(() => processPage(photo.image, { quad: [p, p, p, p], preset: 'original', straighten: false, paper: 'auto' })).toThrow(/corners/i)
  })
})

describe('PDF assembly', () => {
  const streamsOf = (pdf: PDFDocument): PDFRawStream[] => pdf.context.enumerateIndirectObjects().map(([, o]) => o).filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))

  it('JPEG page: DCT image, page size from the encoded size', async () => {
    const bytes = await assemblePdf([{ kind: 'jpeg', bytes: makeFakeJpeg(1240, 1754), pageWidthPt: 595.2, pageHeightPt: 841.92 }], { title: 'Scan' })
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBe(1)
    const { width, height } = pdf.getPage(0).getSize()
    expect(width).toBeCloseTo(595.2, 1)
    expect(height).toBeCloseTo(841.92, 1)
    const imgs = streamsOf(pdf)
    expect(imgs).toHaveLength(1)
    expect(imgs[0].dict.get(PDFName.of('Filter'))).toEqual(PDFName.of('DCTDecode'))
    expect((imgs[0].dict.get(PDFName.of('Width')) as PDFNumber).asNumber()).toBe(1240)
    expect(pdf.getTitle()).toBe('Scan')
  })

  it('bilevel page: 1 bit per pixel, predictor, and the data decodes back to the packed image', async () => {
    const img = createRgba(37, 20, [255, 255, 255])
    for (let i = 0; i < 20; i++) img.data[(i * 37 + i) * 4] = img.data[(i * 37 + i) * 4 + 1] = img.data[(i * 37 + i) * 4 + 2] = 0
    const data = encodeBilevel(img)
    const bytes = await assemblePdf([{ kind: 'bilevel', data, widthPx: 37, heightPx: 20, pageWidthPt: 37 / 300 * 72, pageHeightPt: 20 / 300 * 72 }])
    const pdf = await PDFDocument.load(bytes)
    const [s] = streamsOf(pdf)
    expect(s.dict.get(PDFName.of('BitsPerComponent'))).toEqual(PDFNumber.of(1))
    expect(s.dict.get(PDFName.of('ColorSpace'))).toEqual(PDFName.of('DeviceGray'))
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(8.88, 2)
    const filtered = unzlibSync(s.contents)
    const rowBytes = 5
    const rows = filtered.length / (rowBytes + 1)
    expect(rows).toBe(20)
    const back = new Uint8Array(rowBytes * rows)
    for (let y = 0; y < rows; y++) for (let x = 0; x < rowBytes; x++) back[y * rowBytes + x] = (filtered[y * (rowBytes + 1) + 1 + x] + (y ? back[(y - 1) * rowBytes + x] : 0)) & 255
    // pixel (3,3) is black, (4,3) white
    expect((back[3 * rowBytes] >> (7 - 3)) & 1).toBe(0)
    expect((back[3 * rowBytes] >> (7 - 4)) & 1).toBe(1)
  })

  it('a full-size B&W text page is far smaller than the raw bitmap', () => {
    const page = renderTextPage(1240, 1754, 2)
    for (let i = 0; i < page.data.length; i += 4) page.data[i] = page.data[i + 1] = page.data[i + 2] = page.data[i] < 128 ? 0 : 255
    const data = encodeBilevel(page)
    expect(data.length).toBeLessThan((1240 * 1754) / 8 / 4)
  })

  it('gray8 / rgb8 raw pages and several pages with different sizes', async () => {
    const g = createRgba(8, 8, [10, 10, 10])
    const b = await ScanPdfBuilder.create()
    await b.addPage({ kind: 'gray8', data: encodeRaw(g, true), widthPx: 8, heightPx: 8, pageWidthPt: 100, pageHeightPt: 50 })
    await b.addPage({ kind: 'rgb8', data: encodeRaw(g, false), widthPx: 8, heightPx: 8, pageWidthPt: 60, pageHeightPt: 80 })
    expect(b.pageCount).toBe(2)
    const pdf = await PDFDocument.load(await b.save())
    expect(pdf.getPage(0).getSize()).toEqual({ width: 100, height: 50 })
    expect(pdf.getPage(1).getSize()).toEqual({ width: 60, height: 80 })
    const [s0, s1] = streamsOf(pdf)
    expect(unzlibSync(s0.contents)).toHaveLength(64)
    expect(unzlibSync(s1.contents)).toHaveLength(192)
  })

  it('refuses empty input and absurd page sizes', async () => {
    await expect(assemblePdf([])).rejects.toThrow(/no pages/i)
    await expect(assemblePdf([{ kind: 'jpeg', bytes: makeFakeJpeg(10, 10), pageWidthPt: 0, pageHeightPt: 10 }])).rejects.toThrow(/page size/i)
  })
})

describe('QR code', () => {
  const urls = [
    'http://192.168.1.23:51234/3xAbCdEfGhIjKlMnOpQrSt',
    'http://10.0.0.5:8080/aaaaaaaaaaaaaaaaaaaaaa',
    'http://172.16.254.253:65535/Zq9_-Zq9_-Zq9_-Zq9_-Zq'
  ]
  for (const url of urls) {
    it(`encodes and decodes ${url}`, () => {
      const m = qrMatrix(url)
      for (const scale of [3, 6]) {
        const r = qrRaster(m, scale)
        const decoded = jsQR(r.data, r.width, r.height)
        expect(decoded?.data).toBe(url)
      }
    })
  }

  it('svg path covers exactly the dark modules', () => {
    const m = qrMatrix('http://192.168.0.2:1234/abc')
    const { d, size } = qrSvgPath(m)
    expect(size).toBe(m.length + 8)
    const dark = m.flat().filter(Boolean).length
    // every run is "M x y h n v1 h-n z": sum the run lengths
    let sum = 0
    for (const mt of d.matchAll(/h(\d+)v1/g)) sum += Number(mt[1])
    expect(sum).toBe(dark)
  })
})
