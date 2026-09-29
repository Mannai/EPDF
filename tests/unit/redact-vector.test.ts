import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { parseContent } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import { DEFAULT_OPTIONS, RedactRefused, redactDocument, summarize, type MarkInput } from '../../src/renderer/src/features/redact/logic/redact'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { checkPageVectors } from '../../src/renderer/src/features/redact/logic/verifyVector'
import type { Rect } from '../../src/renderer/src/features/redact/logic/geom'

/**
 * Drawn shapes under a mark: every subpath that reaches a mark is removed with its operators (a filled rectangle is
 * cut along the mark), so no geometry under a mark survives in the file — not even hidden behind a clip — and what
 * remains never paints outside the original shape. The self-check re-reads the geometry and refuses anything else.
 */

const N = (s: string): PDFName => PDFName.of(s)

async function doc(content: string, setup?: (d: PDFDocument) => Record<string, unknown>): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const page = d.addPage([612, 792])
  page.node.set(N('Contents'), d.context.register(d.context.flateStream(content)))
  const extra = setup?.(d) ?? {}
  page.node.set(N('Resources'), d.context.obj(extra as never))
  return d.save()
}

const markOf = (r: Rect): MarkInput => ({ id: 'm', pageIndex: 0, rects: [r] })

async function redact(bytes: Uint8Array, rects: Rect[]) {
  const pdf = await PDFDocument.load(bytes)
  const res = redactDocument(pdf, rects.map(markOf), DEFAULT_OPTIONS)
  const out = await pdf.save()
  const findings = await verifyRedaction({ bytes: out, marksByPage: res.marksByPage, secrets: [] })
  return { ...res, out, findings, pdf: await PDFDocument.load(out) }
}

/** The page's content streams, decoded; the redaction overlay (last stream) separately. */
function streamsOf(pdf: PDFDocument, pageIndex = 0): string[] {
  const c = pdf.getPage(pageIndex).node.Contents()
  const list: PDFStream[] = []
  if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) list.push(c.lookup(i) as PDFStream)
  else if (c) list.push(c as PDFStream)
  return list.map((s) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString('latin1'))
}
const contentOf = (pdf: PDFDocument): string => streamsOf(pdf).slice(0, -1).join('\n')
const normalize = (s: string): string => s.replace(/\s+/g, ' ')

// ---- "1234" as seven-segment digits (four vector digits drawn as rectangles), as in the security review

const SEG: Record<string, [number, number, number, number]> = { a: [4, 36, 22, 4], b: [26, 20, 4, 16], c: [26, 4, 4, 16], d: [4, 0, 22, 4], e: [0, 4, 4, 16], f: [0, 20, 4, 16], g: [4, 18, 22, 4] }
const DIGITS = ['bc', 'abged', 'abgcd', 'fgbc']
const RECTS: { digit: number; seg: string; x: number; y: number; w: number; h: number }[] = DIGITS.flatMap((segs, i) =>
  [...segs].map((s) => {
    const [x, y, w, h] = SEG[s]
    return { digit: i, seg: s, x: x + 60 + i * 42, y: y + 470, w, h }
  })
)
const reOf = (r: { x: number; y: number; w: number; h: number }): string => `${r.x} ${r.y} ${r.w} ${r.h} re`
const polyOf = (r: { x: number; y: number; w: number; h: number }): string => `${r.x} ${r.y} m ${r.x + r.w} ${r.y} l ${r.x + r.w} ${r.y + r.h} l ${r.x} ${r.y + r.h} l h`
const SQUARE = '400 500 10 10 re'
const present = (content: string, rects: typeof RECTS, fmt = reOf): number => rects.filter((r) => ` ${normalize(content)} `.includes(` ${fmt(r)} `)).length

const onePath = (fmt = reOf): string => `q 0 g\n${RECTS.map(fmt).join('\n')}\n${SQUARE}\nf Q\n`
const separatePaths = (): string => `q 0 g\n${RECTS.map((r) => `${reOf(r)} f`).join('\n')}\n${SQUARE} f Q\n`
const ALL_DIGITS: Rect = { x0: 50, y0: 460, x1: 235, y1: 520 }

describe('the security review scenarios: digits drawn as rectangles', () => {
  it('(a) one path with the digits under the mark and a square outside: every digit rectangle is gone, the square stays', async () => {
    const r = await redact(await doc(onePath()), [ALL_DIGITS])
    const c = contentOf(r.pdf)
    expect(present(c, RECTS)).toBe(0)
    expect(normalize(c)).toContain(SQUARE)
    expect(c).not.toMatch(/W\*?\s/)
    expect(r.report.paths).toBe(16)
    expect(r.report.pathsCollateral).toBe(0)
    expect(r.findings).toEqual([])
  })

  it('(b) the same shapes as separate paths', async () => {
    const r = await redact(await doc(separatePaths()), [ALL_DIGITS])
    const c = contentOf(r.pdf)
    expect(present(c, RECTS)).toBe(0)
    expect(normalize(c)).toContain(`${SQUARE} f`)
    expect(r.report.paths).toBe(16)
    expect(r.report.pathsCollateral).toBe(0)
    expect(r.findings).toEqual([])
  })

  it('(c) one path, a mark over the first two digits only: those go, the other digits stay exactly as they were', async () => {
    const r = await redact(await doc(onePath()), [{ x0: 50, y0: 460, x1: 137, y1: 520 }])
    const c = contentOf(r.pdf)
    const under = RECTS.filter((x) => x.digit < 2)
    const outside = RECTS.filter((x) => x.digit >= 2)
    expect(present(c, under)).toBe(0)
    expect(present(c, outside)).toBe(outside.length)
    expect(normalize(c)).toContain(SQUARE)
    expect(r.report.paths).toBe(under.length)
    expect(r.report.pathsCollateral).toBe(0)
    expect(r.findings).toEqual([])
  })

  it('(c) a mark that cuts through the second digit: crossing rectangles are cut along the mark, nothing of them stays under it', async () => {
    const mark = { x0: 50, y0: 460, x1: 115, y1: 520 }
    const r = await redact(await doc(onePath()), [mark])
    const c = normalize(contentOf(r.pdf))
    expect(present(c, RECTS.filter((x) => x.digit < 2 && x.x < 115))).toBe(0)
    // the horizontal bars of the "2" (x 106..128) keep their part right of the mark
    for (const y of [506, 488, 470]) expect(c).toContain(`115 ${y} 13 4 re`)
    expect(present(c, RECTS.filter((x) => x.digit >= 2))).toBe(9)
    expect(r.report.pathsCollateral).toBe(0)
    expect(checkPageVectors(r.pdf, 0, [mark]).leaks).toBe(0)
    expect(r.findings).toEqual([])
  })

  it('(c) the same digits as outlines (m l l l h): outlines crossing the mark are removed entirely and reported', async () => {
    const mark = { x0: 50, y0: 460, x1: 115, y1: 520 }
    const r = await redact(await doc(onePath(polyOf)), [mark])
    const c = normalize(contentOf(r.pdf))
    const crossing = RECTS.filter((x) => x.digit === 1 && x.x < 115 && x.x + x.w > 115)
    expect(crossing.map((x) => x.seg).sort()).toEqual(['a', 'd', 'g'])
    expect(present(c, RECTS.filter((x) => x.x < 115), polyOf)).toBe(0)
    expect(present(c, RECTS.filter((x) => x.x >= 115), polyOf)).toBe(10)
    expect(r.report.pathsCollateral).toBe(3)
    expect(r.report.paths).toBe(RECTS.filter((x) => x.x < 115).length - 3)
    expect(r.report.warnings.join('\n')).toMatch(/Page 1: 3 drawn shapes that cross the edge of a mark were removed entirely/)
    expect(summarize(r.report)).toMatch(/3 drawn shapes that cross the edge of a mark were removed entirely/)
    expect(summarize(r.report, false)).not.toMatch(/removed entirely/)
    expect(r.findings).toEqual([])
  })

  it('recovery: with every clip and the overlay stripped from the result, no digit geometry is left', async () => {
    const r = await redact(await doc(onePath()), [ALL_DIGITS])
    const stripped = contentOf(r.pdf).replace(/\bW\*?(?=\s)/g, ' ')
    const again = await PDFDocument.load(await doc(stripped))
    expect(checkPageVectors(again, 0, [ALL_DIGITS]).leaks).toBe(0)
    expect(present(stripped, RECTS)).toBe(0)
    // and no path point of the stripped content lies in the digits' area
    for (const op of parseContent(new TextEncoder().encode(stripped)).ops) {
      if (!['m', 'l', 're'].includes(op.op)) continue
      const [x, y] = op.args.map((a) => (a.t === 'num' ? a.v : NaN))
      expect(x >= 86 && x <= 216 && y >= 470 && y <= 510).toBe(false)
    }
  })

  it('the self-check fails on a result that only clips the shapes away (the earlier behaviour)', async () => {
    const clipOnly = [
      'q 0 g q',
      '-100000 -100000 m 100000 -100000 l 100000 100000 l -100000 100000 l h',
      '50 460 m 235 460 l 235 520 l 50 520 l h W* n',
      RECTS.map(reOf).join('\n'),
      `${SQUARE} f Q Q`
    ].join('\n')
    const overlay = 'q /EpdfRdGS1 gs 0 0 0 rg 50 460 185 60 re f Q'
    const d = await PDFDocument.create()
    const page = d.addPage([612, 792])
    page.node.set(N('Contents'), d.context.obj([d.context.register(d.context.flateStream(clipOnly)), d.context.register(d.context.flateStream(overlay))]))
    page.node.set(N('Resources'), d.context.obj({ ExtGState: { EpdfRdGS1: { CA: 1, ca: 1 } } } as never))
    const bytes = await d.save()
    expect(checkPageVectors(await PDFDocument.load(bytes), 0, [ALL_DIGITS]).leaks).toBe(16)
    const findings = await verifyRedaction({ bytes, marksByPage: new Map([[0, [ALL_DIGITS]]]), secrets: [] })
    expect(findings.map((f) => f.detail).join('\n')).toMatch(/16 drawn shapes still have geometry under a redaction mark/)
    // the overlay itself is not counted: the same page without the digits passes
    const clean = await doc(`q 0 g ${SQUARE} f Q`)
    const c = await PDFDocument.load(clean)
    expect(checkPageVectors(c, 0, [ALL_DIGITS]).leaks).toBe(0)
  })
})

// ---- a tiny painter for the tests below: is a point painted by a fill, within the clips? (re m l h f f* W W* n q Q)

function paintedAt(content: string, x: number, y: number): boolean {
  type Poly = [number, number][]
  const inside = (polys: Poly[], evenOdd: boolean): boolean => {
    let wind = 0
    let cross = 0
    for (const p of polys) {
      for (let i = 0; i < p.length; i++) {
        const [ax, ay] = p[i]
        const [bx, by] = p[(i + 1) % p.length]
        if (ay <= y && by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) {
          wind++
          cross++
        } else if (ay > y && by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) {
          wind--
          cross++
        }
      }
    }
    return evenOdd ? cross % 2 === 1 : wind !== 0
  }
  let path: Poly[] = []
  let clips: { polys: Poly[]; eo: boolean }[] = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack: { clips: typeof clips; ctm: number[] }[] = []
  let pending: boolean | null = null
  let painted = false
  const T = (px: number, py: number): [number, number] => [px * ctm[0] + py * ctm[2] + ctm[4], px * ctm[1] + py * ctm[3] + ctm[5]]
  for (const op of parseContent(new TextEncoder().encode(content)).ops) {
    const n = op.args.map((a) => (a.t === 'num' ? a.v : NaN))
    switch (op.op) {
      case 'q':
        stack.push({ clips: [...clips], ctm })
        break
      case 'Q': {
        const s = stack.pop()
        clips = s?.clips ?? []
        ctm = s?.ctm ?? [1, 0, 0, 1, 0, 0]
        break
      }
      case 'cm':
        ctm = [n[0] * ctm[0] + n[1] * ctm[2], n[0] * ctm[1] + n[1] * ctm[3], n[2] * ctm[0] + n[3] * ctm[2], n[2] * ctm[1] + n[3] * ctm[3], n[4] * ctm[0] + n[5] * ctm[2] + ctm[4], n[4] * ctm[1] + n[5] * ctm[3] + ctm[5]]
        break
      case 're':
        path.push([T(n[0], n[1]), T(n[0] + n[2], n[1]), T(n[0] + n[2], n[1] + n[3]), T(n[0], n[1] + n[3])])
        break
      case 'm':
        path.push([T(n[0], n[1])])
        break
      case 'l':
        path[path.length - 1].push(T(n[0], n[1]))
        break
      case 'W':
      case 'W*':
        pending = op.op === 'W*'
        break
      case 'f':
      case 'f*':
      case 'n': {
        const within = clips.every((c) => inside(c.polys, c.eo))
        if (op.op !== 'n' && within && inside(path, op.op === 'f*')) painted = true
        if (pending !== null) clips.push({ polys: path, eo: pending })
        pending = null
        path = []
        break
      }
    }
  }
  return painted
}

function samplesOutside(marks: Rect[], box: Rect, step = 2.5): [number, number][] {
  const out: [number, number][] = []
  for (let x = box.x0 + 0.3; x < box.x1; x += step)
    for (let y = box.y0 + 0.7; y < box.y1; y += step) if (!marks.some((m) => x >= m.x0 - 0.01 && x <= m.x1 + 0.01 && y >= m.y0 - 0.01 && y <= m.y1 + 0.01)) out.push([x, y])
  return out
}

describe('what remains paints a subset of the original, never more', () => {
  it('even-odd hole (rectangles): the mark crosses the hole edge; the hole is cut, the outer square kept, nothing inverts', async () => {
    const src = '0 g 100 100 200 200 re 150 150 100 100 re f*'
    const mark = { x0: 140, y0: 190, x1: 160, y1: 210 }
    const r = await redact(await doc(src), [mark])
    const c = contentOf(r.pdf)
    expect(normalize(c)).toContain('100 100 200 200 re')
    for (const [x, y] of samplesOutside([mark], { x0: 90, y0: 90, x1: 310, y1: 310 })) expect(paintedAt(c, x, y), `${x},${y}`).toBe(paintedAt(src, x, y))
    expect(r.report.pathsCollateral).toBe(0)
    expect(r.findings).toEqual([])
  })

  it('even-odd hole (outlines): the hole outline crosses the mark, so the outer outline goes too instead of filling the hole', async () => {
    const src = '0 g 100 100 m 300 100 l 300 300 l 100 300 l h 150 150 m 250 150 l 250 250 l 150 250 l h f*'
    const mark = { x0: 140, y0: 190, x1: 160, y1: 210 }
    const r = await redact(await doc(src), [mark])
    const c = contentOf(r.pdf)
    for (const [x, y] of samplesOutside([mark], { x0: 90, y0: 90, x1: 310, y1: 310 }, 5)) if (paintedAt(c, x, y)) expect(paintedAt(src, x, y), `${x},${y}`).toBe(true)
    expect(paintedAt(c, 200, 200)).toBe(false) // the hole is not filled
    expect(r.report.pathsCollateral).toBe(2)
    expect(r.findings).toEqual([])
  })

  it('a mark inside a hole touches nothing', async () => {
    const src = '0 g 100 100 m 300 100 l 300 300 l 100 300 l h 150 150 m 250 150 l 250 250 l 150 250 l h f*'
    const r = await redact(await doc(src), [{ x0: 180, y0: 180, x1: 220, y1: 220 }])
    expect(normalize(contentOf(r.pdf))).toContain('150 150 m 250 150 l 250 250 l 150 250 l h f*')
    expect(r.report.paths + r.report.pathsCollateral).toBe(0)
  })

  it('a filled background that contains the mark stays (its outline is nowhere near it)', async () => {
    const src = '0.9 g 0 0 612 792 re f 0.8 g 20 20 m 590 20 l 590 770 l 20 770 l h f'
    const r = await redact(await doc(src), [{ x0: 100, y0: 100, x1: 200, y1: 130 }])
    const c = normalize(contentOf(r.pdf))
    expect(c).toContain('0 0 612 792 re f')
    expect(c).toContain('20 20 m 590 20 l 590 770 l 20 770 l h f')
    expect(r.findings).toEqual([])
  })

  it('a clip (outline) straddling a mark becomes an empty clip, placed outside the marks', async () => {
    const src = 'q 50 50 m 200 50 l 200 100 l 50 100 l h W n 0 1 0 rg 0 0 612 792 re f Q 0 0 1 rg 300 300 10 10 re f'
    const mark = { x0: 100, y0: 30, x1: 150, y1: 70 }
    const r = await redact(await doc(src), [mark])
    const c = contentOf(r.pdf)
    expect(normalize(c)).not.toContain('200 50 l')
    expect(normalize(c)).toMatch(/-?[\d.]+ -?[\d.]+ 0 0 re W n/)
    expect(normalize(c)).toContain('0 0 612 792 re f')
    for (const [x, y] of samplesOutside([mark], { x0: 40, y0: 40, x1: 210, y1: 110 }, 5)) expect(paintedAt(c, x, y)).toBe(false)
    expect(paintedAt(c, 305, 305)).toBe(true)
    expect(r.report.pathsCollateral).toBe(1)
    expect(r.findings).toEqual([])
  })

  it('a clip rectangle straddling a mark is cut along it: the clipped area is the same outside the mark', async () => {
    const src = 'q 50 50 150 50 re W n 0 1 0 rg 0 0 612 792 re f Q'
    const mark = { x0: 100, y0: 30, x1: 150, y1: 70 }
    const r = await redact(await doc(src), [mark])
    const c = contentOf(r.pdf)
    for (const [x, y] of samplesOutside([mark], { x0: 40, y0: 20, x1: 210, y1: 110 })) expect(paintedAt(c, x, y), `${x},${y}`).toBe(paintedAt(src, x, y))
    expect(r.report.pathsCollateral).toBe(0)
    expect(r.findings).toEqual([])
  })

  it('a rotated filled rectangle is cut along the mark into polygons; outside the mark nothing changes', async () => {
    const src = 'q 0.8660254 0.5 -0.5 0.8660254 200 200 cm 0 g 0 0 100 40 re f Q'
    const mark = { x0: 230, y0: 180, x1: 260, y1: 280 }
    const r = await redact(await doc(src), [mark])
    const c = contentOf(r.pdf)
    expect(normalize(c)).not.toContain('0 0 100 40 re')
    for (const [x, y] of samplesOutside([mark], { x0: 170, y0: 190, x1: 300, y1: 300 })) expect(paintedAt(c, x, y), `${x},${y}`).toBe(paintedAt(src, x, y))
    expect(r.report.pathsCollateral).toBe(0)
    expect(r.findings).toEqual([])
  })

  it('a removed image (format that cannot be edited) is replaced by a box outside the mark only, also when rotated', async () => {
    const bytes = await doc('q 86.6 50 -20 34.64 200 200 cm /Im1 Do Q', (d) => ({
      XObject: { Im1: d.context.register(d.context.stream(new Uint8Array(40), { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 4, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'JBIG2Decode' } as never)) }
    }))
    const mark = { x0: 230, y0: 200, x1: 260, y1: 260 }
    const r = await redact(bytes, [mark])
    expect(r.report.imagesRemoved).toBe(1)
    expect(r.findings).toEqual([])
    const c = contentOf(r.pdf)
    expect(paintedAt(c, 215, 215)).toBe(true) // the box is still drawn where the image was, outside the mark
    expect(paintedAt(c, 245, 230)).toBe(false)
  })

  it('a page-size clip around everything is left alone', async () => {
    const src = 'q 0 0 612 792 re W n 0 g 100 100 20 20 re f 300 300 20 20 re f Q'
    const r = await redact(await doc(src), [{ x0: 90, y0: 90, x1: 130, y1: 130 }])
    const c = normalize(contentOf(r.pdf))
    expect(c).toContain('0 0 612 792 re W n')
    expect(c).toContain('300 300 20 20 re f')
    expect(c).not.toContain('100 100 20 20 re')
  })
})

const circle = (cx: number, cy: number, r: number): string => {
  const k = 0.5523 * r
  return `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c h f`
}

describe('curves, strokes, transformations and forms', () => {
  it('curves: inside a mark removed, crossing it removed entirely, just touching its edge kept', async () => {
    const src = [circle(300, 300, 20), circle(400, 300, 20), circle(500, 300, 20)].join('\n')
    const r = await redact(await doc(src), [
      { x0: 270, y0: 270, x1: 330, y1: 330 },
      { x0: 410, y0: 280, x1: 450, y1: 320 },
      { x0: 520, y0: 280, x1: 540, y1: 320 }
    ])
    const c = normalize(contentOf(r.pdf))
    expect(c).not.toContain('320 300 m')
    expect(c).not.toContain('420 300 m')
    expect(c).toContain('520 300 m')
    expect(r.report.paths).toBe(1)
    expect(r.report.pathsCollateral).toBe(1)
    expect(r.findings).toEqual([])
  })

  it('an unpainted path reaching a mark is dropped whole', async () => {
    const r = await redact(await doc('100 100 m 300 120 l n 0 g 400 400 5 5 re f'), [{ x0: 90, y0: 90, x1: 130, y1: 130 }])
    const c = normalize(contentOf(r.pdf))
    expect(c).not.toContain('300 120 l')
    expect(c).toContain('400 400 5 5 re f')
  })

  const MARK = { x0: 100, y0: 100, x1: 200, y1: 200 }
  const kept = async (src: string): Promise<boolean> => {
    const r = await redact(await doc(src), [MARK])
    expect(r.findings).toEqual([])
    return normalize(contentOf(r.pdf)).includes(' l S') || normalize(contentOf(r.pdf)).includes(' l s')
  }

  it('a stroke next to a mark goes when its width reaches the mark', async () => {
    expect(await kept('4 w 150 201.5 m 180 201.5 l S')).toBe(false) // reaches 199.5
    expect(await kept('2 w 150 201.5 m 180 201.5 l S')).toBe(true) // reaches 200.5
  })

  it('square caps reach further than butt caps', async () => {
    expect(await kept('1.6 w 150 201 m 150 250 l S')).toBe(true)
    expect(await kept('1.6 w 2 J 150 201 m 150 250 l S')).toBe(false)
  })

  it('a sharp miter join reaches into the mark; round joins and a low miter limit do not', async () => {
    const v = '140 230 m 150 202.5 l 160 230 l S'
    expect(await kept(`2 w ${v}`)).toBe(false)
    expect(await kept(`2 w 1 j ${v}`)).toBe(true)
    expect(await kept(`2 w 2 M ${v}`)).toBe(true)
    // the same through a graphics state dictionary
    const r = await redact(await doc(`2 w /G1 gs ${v}`, () => ({ ExtGState: { G1: { LJ: 1 } } })), [MARK])
    expect(normalize(contentOf(r.pdf))).toContain(' l S')
  })

  it('a transformation scales the stroke width', async () => {
    expect(await kept('q 10 0 0 10 0 0 cm 15 20.3 m 18 20.3 l S Q')).toBe(false) // 1 unit = 10 pt wide
    expect(await kept('q 1 0 0 1 0 0 cm 150 203 m 180 203 l S Q')).toBe(true)
  })

  it('paths in nested forms with matrices are removed in the form copy; the rest of the form stays', async () => {
    const bytes = await doc('q /Fm1 Do Q', (d) => {
      const inner = d.context.register(d.context.flateStream('0 g 50 50 20 20 re f 1 w 60 90 m 70 90 l S', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 300] } as never))
      const outer = d.context.register(d.context.flateStream('/Fm2 Do', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 300], Matrix: [2, 0, 0, 2, 0, 0], Resources: { XObject: { Fm2: inner } } } as never))
      return { XObject: { Fm1: outer } }
    })
    const r = await redact(bytes, [{ x0: 90, y0: 90, x1: 150, y1: 150 }])
    expect(r.report.forms).toBe(2)
    expect(r.report.paths).toBe(1)
    let forms = ''
    for (const [, o] of r.pdf.context.enumerateIndirectObjects()) if (o instanceof PDFStream && String(o.dict.lookup(N('Subtype'))) === '/Form') forms += Buffer.from(decodePDFRawStream(o as PDFRawStream).decode()).toString('latin1')
    expect(forms).not.toContain('50 50 20 20 re')
    expect(normalize(forms)).toContain('60 90 m 70 90 l S')
    expect(r.findings).toEqual([])
  })
})

describe('patterns and shadings', () => {
  const textPattern = (d: PDFDocument) =>
    d.context.register(d.context.stream('BT /F1 8 Tf 0 0 Td (SECRETPAT) Tj ET', { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 60, 12], XStep: 60, YStep: 12, Resources: { Font: { F1: d.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }) } } } as never))

  it('a pattern that draws text, painted under a mark and elsewhere on the page, is refused', async () => {
    const bytes = await doc('/Pattern cs /P1 scn 100 100 100 50 re f 400 400 50 50 re f', (d) => ({ Pattern: { P1: textPattern(d) } }))
    const pdf = await PDFDocument.load(bytes)
    expect(() => redactDocument(pdf, [markOf({ x0: 90, y0: 90, x1: 150, y1: 120 })], DEFAULT_OPTIONS)).toThrow(RedactRefused)
  })

  it('a pattern paint that reaches a mark is removed whole, even a harmless one', async () => {
    const bytes = await doc('/Pattern cs /P2 scn 100 100 100 50 re f 0 g 400 400 5 5 re f', (d) => ({
      Pattern: { P2: d.context.register(d.context.stream('0 0 5 5 re f', { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: {} } as never)) }
    }))
    const r = await redact(bytes, [{ x0: 90, y0: 90, x1: 150, y1: 120 }])
    const c = normalize(contentOf(r.pdf))
    expect(c).not.toContain('100 100 100 50 re')
    expect(c).toContain('400 400 5 5 re f')
    expect(r.report.pathsCollateral).toBe(1)
    expect(r.findings).toEqual([])
  })
})
