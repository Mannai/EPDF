import { PDFDocument, PDFName, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { defaultHeaderFooter, defaultWatermark, type HeaderFooterSettings } from '../../src/shared/features/headerfooter'
import { applyHeaderFooter, applyOverlay } from '../../src/renderer/src/features/headerfooter/pdf/apply'
import { apply, geometryFor, geometryOf, invert, multiply, placeOverlay, readerMatrix, selectPages, visibleBox } from '../../src/renderer/src/features/headerfooter/pdf/geometry'
import { seePages } from './helpers/hfPdfjs'
import { setupText } from './helpers/text'

/**
 * Placement of marks on rotated pages, pages with CropBox/MediaBox offsets and mixed sizes. The judge is PDF.js: it
 * applies /Rotate and the crop box itself (its viewport), so if our reader-space matrix were wrong the header would not
 * come out upright at the top centre of what the reader sees.
 */
setupText()

type PageSpec = { media: [number, number, number, number]; crop?: [number, number, number, number]; rotate?: number }

const SPECS: PageSpec[] = [
  { media: [0, 0, 612, 792] },
  { media: [0, 0, 612, 792], rotate: 90 },
  { media: [0, 0, 612, 792], rotate: 180 },
  { media: [0, 0, 612, 792], rotate: 270 },
  { media: [-100, -50, 512, 742], crop: [20, 30, 420, 630] },
  { media: [0, 0, 842, 595], crop: [100, 50, 700, 545], rotate: 90 },
  { media: [0, 0, 300, 400], rotate: -90 },
  { media: [50, 60, 350, 460], crop: [0, 0, 1000, 1000], rotate: 180 } // crop larger than media: media wins
]

async function makeDoc(specs: PageSpec[]): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  for (const s of specs) {
    const p = pdf.addPage([s.media[2] - s.media[0], s.media[3] - s.media[1]])
    p.setMediaBox(s.media[0], s.media[1], s.media[2] - s.media[0], s.media[3] - s.media[1])
    if (s.crop) p.setCropBox(s.crop[0], s.crop[1], s.crop[2] - s.crop[0], s.crop[3] - s.crop[1])
    if (s.rotate) p.setRotation(degrees(s.rotate))
  }
  return pdf
}

const visible = (s: PageSpec): { w: number; h: number } => {
  const c = s.crop ?? s.media
  const x0 = Math.max(c[0], s.media[0])
  const y0 = Math.max(c[1], s.media[1])
  const x1 = Math.min(c[2], s.media[2])
  const y1 = Math.min(c[3], s.media[3])
  const w = x1 - x0
  const h = y1 - y0
  const r = (((s.rotate ?? 0) % 360) + 360) % 360
  return r === 90 || r === 270 ? { w: h, h: w } : { w, h }
}

describe('reader-space matrix', () => {
  it('maps the reader corners to the right user-space corners for every rotation', () => {
    const box: [number, number, number, number] = [10, 20, 110, 220] // 100 x 200
    // The corner the reader sees at the top-left, per /Rotate (clockwise display rotation).
    const topLeft = { 0: [10, 220], 90: [10, 20], 180: [110, 20], 270: [110, 220] } as const
    for (const r of [0, 90, 180, 270] as const) {
      const g = geometryFor(box, r)
      const m = readerMatrix(g)
      const [x, y] = apply(m, 0, g.height)
      expect([x, y], `rotate ${r}`).toEqual([...topLeft[r]])
      // determinant +1: no mirroring
      expect(m[0] * m[3] - m[1] * m[2]).toBe(1)
      // the whole reader rectangle covers exactly the box
      const pts = [apply(m, 0, 0), apply(m, g.width, 0), apply(m, 0, g.height), apply(m, g.width, g.height)]
      expect(Math.min(...pts.map((p) => p[0]))).toBe(10)
      expect(Math.max(...pts.map((p) => p[0]))).toBe(110)
      expect(Math.min(...pts.map((p) => p[1]))).toBe(20)
      expect(Math.max(...pts.map((p) => p[1]))).toBe(220)
    }
  })

  it('visible box = CropBox clipped to MediaBox; rotation normalised', async () => {
    const pdf = await makeDoc(SPECS)
    expect(visibleBox(pdf.getPage(4))).toEqual([20, 30, 420, 630])
    expect(visibleBox(pdf.getPage(7))).toEqual([50, 60, 350, 460])
    expect(geometryOf(pdf.getPage(6)).rotate).toBe(270)
    expect(geometryOf(pdf.getPage(5))).toMatchObject({ width: 495, height: 600 })
  })

  it('invert and multiply are consistent', () => {
    const m = readerMatrix(geometryFor([3, 4, 50, 90], 90))
    const id = multiply(m, invert(m))
    for (const [i, v] of [1, 0, 0, 1, 0, 0].entries()) expect(id[i]).toBeCloseTo(v, 9)
  })
})

describe('overlay placement', () => {
  it('relative scale fits the rotated box into the page; centred', () => {
    const p = placeOverlay(400, 100, 600, 800, { rotation: 0, scale: { mode: 'relative', percent: 50 }, position: { h: 'center', v: 'center', dx: 0, dy: 0 } })
    expect(p.scale).toBeCloseTo(0.75, 9) // 50 % of 600 / 400
    expect(p.bbox.map((v) => Math.round(v))).toEqual([150, 363, 450, 438])
    const r = placeOverlay(400, 100, 600, 800, { rotation: 90, scale: { mode: 'relative', percent: 100 }, position: { h: 'center', v: 'center', dx: 0, dy: 0 } })
    // rotated 90: the box is 100 x 400 -> limited by height: 800 / 400 = 2
    expect(r.scale).toBeCloseTo(2, 9)
    const [cx, cy] = apply(r.matrix, 200, 50)
    expect(cx).toBeCloseTo(300, 6)
    expect(cy).toBeCloseTo(400, 6)
  })

  it('anchors at edges and applies offsets (+ = right / up)', () => {
    const p = placeOverlay(100, 50, 600, 800, { rotation: 0, scale: { mode: 'absolute', percent: 100 }, position: { h: 'right', v: 'top', dx: -10, dy: -20 } })
    expect(p.bbox).toEqual([490, 730, 590, 780])
    const q = placeOverlay(100, 50, 600, 800, { rotation: 0, scale: { mode: 'absolute', percent: 200 }, position: { h: 'left', v: 'bottom', dx: 5, dy: 6 } })
    expect(q.bbox).toEqual([5, 6, 205, 106])
  })

  it('rotation is counter-clockwise as the reader sees it', () => {
    const p = placeOverlay(100, 10, 600, 800, { rotation: 45, scale: { mode: 'absolute', percent: 100 }, position: { h: 'center', v: 'center', dx: 0, dy: 0 } })
    const [x0, y0] = apply(p.matrix, 0, 5)
    const [x1, y1] = apply(p.matrix, 100, 5)
    expect(x1).toBeGreaterThan(x0)
    expect(y1).toBeGreaterThan(y0) // rises to the right
  })
})

describe('page selection', () => {
  it('ranges, odd and even pages', () => {
    expect(selectPages(10, { range: '', subset: 'all' })).toEqual({ ok: true, pages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })
    expect(selectPages(10, { range: '2-5, 9', subset: 'odd' })).toEqual({ ok: true, pages: [2, 4, 8] })
    expect(selectPages(10, { range: '5-, 1', subset: 'even' })).toEqual({ ok: true, pages: [5, 7, 9] })
    expect(selectPages(10, { range: '12', subset: 'all' }).ok).toBe(false)
    expect(selectPages(1, { range: '', subset: 'even' })).toEqual({ ok: false, error: 'The range has no even pages.' })
  })
})

function hf(over: Partial<HeaderFooterSettings> = {}): HeaderFooterSettings {
  const s = defaultHeaderFooter()
  s.slots = { topLeft: 'L{page}', topCenter: 'TOP {page}', topRight: 'R{page}', bottomLeft: '', bottomCenter: 'FOOT {page}', bottomRight: '' }
  s.font.size = 12
  s.margins = { top: 30, bottom: 40, left: 50, right: 60 }
  return { ...s, ...over }
}

describe('headers and footers land upright at the right place on rotated, offset and mixed-size pages (PDF.js viewport)', () => {
  it('every page: TOP centred at the top, FOOT at the bottom, L/R at the side margins, all upright', async () => {
    const pdf = await makeDoc(SPECS)
    await applyHeaderFooter(pdf, 'headerfooter', hf(), { fileName: 'x.pdf' })
    const pages = await seePages(await pdf.save())
    for (const [i, p] of pages.entries()) {
      const v = visible(SPECS[i]!)
      expect(p.width, `page ${i + 1} width`).toBeCloseTo(v.w, 3)
      expect(p.height).toBeCloseTo(v.h, 3)
      const find = (s: string): (typeof p.items)[number] => {
        const it = p.items.find((t) => t.str.includes(s))
        expect(it, `page ${i + 1}: "${s}" in ${JSON.stringify(p.items.map((t) => t.str))}`).toBeTruthy()
        return it!
      }
      const top = find(`TOP ${i + 1}`)
      const foot = find(`FOOT ${i + 1}`)
      const left = find(`L${i + 1}`)
      const right = find(`R${i + 1}`)
      for (const t of [top, foot, left, right]) {
        expect(t.dir[0], `page ${i + 1} "${t.str}" upright`).toBeCloseTo(1, 6)
        expect(t.dir[1]).toBeCloseTo(0, 6)
      }
      // centre of the top text = centre of the text area (between the side margins)
      const areaCenter = 50 + (v.w - 50 - 60) / 2
      expect(top.x + top.width / 2, `page ${i + 1} centred`).toBeCloseTo(areaCenter, 0)
      // baseline of the header: below the top margin by about the ascent (12 pt text)
      expect(top.y).toBeGreaterThan(30 + 6)
      expect(top.y).toBeLessThan(30 + 16)
      // footer baseline above the bottom margin
      expect(v.h - foot.y).toBeGreaterThan(40)
      expect(v.h - foot.y).toBeLessThan(40 + 8)
      expect(left.x).toBeCloseTo(50, 0)
      expect(right.x + right.width).toBeCloseTo(v.w - 60, 0)
    }
  })

  it('watermarks are centred on the visible page and rotated as the reader sees them', async () => {
    const pdf = await makeDoc(SPECS)
    const w = defaultWatermark()
    w.rotation = 0
    w.opacity = 1
    w.scale = { mode: 'absolute', percent: 100 }
    if (w.source.kind === 'text') {
      w.source.text = 'WMARK'
      w.source.font.size = 40
    }
    await applyOverlay(pdf, 'watermark', w, undefined, { fileName: 'x.pdf' })
    const pages = await seePages(await pdf.save())
    for (const [i, p] of pages.entries()) {
      const v = visible(SPECS[i]!)
      const it = p.items.find((t) => t.str.includes('WMARK'))!
      expect(it, `page ${i + 1}`).toBeTruthy()
      expect(it.dir[0]).toBeCloseTo(1, 6)
      expect(it.x + it.width / 2, `page ${i + 1} centre x`).toBeCloseTo(v.w / 2, 0)
      // baseline a little below the centre (cap height ~ 0.7 em of 40 pt)
      expect(it.y - v.h / 2).toBeGreaterThan(5)
      expect(it.y - v.h / 2).toBeLessThan(22)
    }
    // 45 degrees counter-clockwise: text runs up and to the right
    const pdf2 = await makeDoc([SPECS[1]!])
    w.rotation = 45
    await applyOverlay(pdf2, 'watermark', w, undefined, { fileName: 'x.pdf' })
    const [p2] = await seePages(await pdf2.save())
    const it2 = p2!.items.find((t) => t.str.includes('WMARK'))!
    expect(it2.dir[0]).toBeCloseTo(Math.SQRT1_2, 3)
    expect(it2.dir[1]).toBeCloseTo(-Math.SQRT1_2, 3) // viewport y is down: "up" = negative
  })

  it('pages that share geometry share one watermark form; different sizes get their own', async () => {
    const pdf = await makeDoc([SPECS[0]!, SPECS[0]!, SPECS[0]!, SPECS[1]!])
    await applyOverlay(pdf, 'watermark', defaultWatermark(), undefined, { fileName: 'x.pdf' })
    const formOf = (i: number): string => {
      const xo = pdf.getPage(i).node.Resources()!.lookup(PDFName.of('XObject')) as import('pdf-lib').PDFDict
      return xo.get(PDFName.of('EpdfMk0'))!.toString()
    }
    expect(formOf(0)).toBe(formOf(1))
    expect(formOf(1)).toBe(formOf(2))
    expect(formOf(3)).not.toBe(formOf(0))
  })
})
