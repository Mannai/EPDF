import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import type { OcrLine, OcrWord } from '../../src/shared/features/ocr'
import { applyOcrLayers, geometryMismatch, visibleBox, type PageOcr } from '../../src/renderer/src/features/ocr/pdf/apply'
import { advanceOf, buildToUnicode, Charset, cleanWordText, toVisualOrder, utf16Hex } from '../../src/renderer/src/features/ocr/pdf/charset'
import { buildGlyphlessFont } from '../../src/renderer/src/features/ocr/pdf/glyphlessFont'
import {
  baselineSlope,
  baselineY,
  lineFontSizePx,
  normalizeRotation,
  pixelsPerUnit,
  pixelToUser,
  placeLine,
  undoDeskew,
  type LayoutOptions,
  type PageGeometry,
  type PlacedLine,
  type Rotation
} from '../../src/renderer/src/features/ocr/pdf/layout'
import { buildLayerStream, collectChars, LAYER_MARKER, lineScaling, naturalWidth, tiltedScaling } from '../../src/renderer/src/features/ocr/pdf/textLayer'
import { createScan1, createScanCropped, createScanRotated } from '../fixtures/ocr.mjs'

const word = (text: string, x0: number, y0: number, x1: number, y1: number, conf = 95): OcrWord => ({ text, x0, y0, x1, y1, conf })
const line = (words: OcrWord[], baseline: OcrLine['baseline'] = null, rowHeight = 0): OcrLine => ({
  words,
  baseline,
  rowHeight,
  bbox: { x0: Math.min(...words.map((w) => w.x0)), y0: Math.min(...words.map((w) => w.y0)), x1: Math.max(...words.map((w) => w.x1)), y1: Math.max(...words.map((w) => w.y1)) }
})
const near = (a: number, b: number, eps = 0.01, msg?: string): void => expect(Math.abs(a - b), msg ?? `${a} vs ${b}`).toBeLessThan(eps)

// ---- layout math ---------------------------------------------------------------------------------------------

describe('layout: picture pixels -> PDF user space', () => {
  // Visible box 200 wide x 100 high, origin (10, 20): x 10..210, y 20..120. A 10 px/unit picture.
  const view: [number, number, number, number] = [10, 20, 210, 120]
  const g = (rotate: Rotation): PageGeometry => ({
    view,
    rotate,
    width: rotate % 180 === 0 ? 2000 : 1000,
    height: rotate % 180 === 0 ? 1000 : 2000
  })

  it('normalizes any angle to 0/90/180/270', () => {
    expect([0, 90, 180, 270, 360, 450, -90, -180, -270, 89.9].map(normalizeRotation)).toEqual([0, 90, 180, 270, 0, 90, 270, 180, 90, 90])
  })

  it('scale is picture width over the visible width for upright pages and over the height for sideways ones', () => {
    near(pixelsPerUnit(g(0)), 10)
    near(pixelsPerUnit(g(180)), 10)
    near(pixelsPerUnit(g(90)), 10)
    near(pixelsPerUnit(g(270)), 10)
  })

  it('rotate 0: top-left pixel is (x0, y1); moving right increases x, moving down decreases y', () => {
    expect(pixelToUser(g(0), 0, 0)).toEqual({ x: 10, y: 120 })
    expect(pixelToUser(g(0), 2000, 1000)).toEqual({ x: 210, y: 20 })
    expect(pixelToUser(g(0), 100, 50)).toEqual({ x: 20, y: 115 })
  })

  it('rotate 90: the picture is the page turned clockwise', () => {
    // the page's bottom-left corner (x0, y0) is drawn at the picture's top-left
    expect(pixelToUser(g(90), 0, 0)).toEqual({ x: 10, y: 20 })
    // the page's top-left corner (x0, y1) is drawn at the picture's top-right
    expect(pixelToUser(g(90), 1000, 0)).toEqual({ x: 10, y: 120 })
    // the page's bottom-right corner (x1, y0) is drawn at the picture's bottom-left
    expect(pixelToUser(g(90), 0, 2000)).toEqual({ x: 210, y: 20 })
  })

  it('rotate 180 and 270', () => {
    expect(pixelToUser(g(180), 0, 0)).toEqual({ x: 210, y: 20 })
    expect(pixelToUser(g(180), 2000, 1000)).toEqual({ x: 10, y: 120 })
    // 270 = counterclockwise quarter turn: the page's top-right corner (x1, y1) is at the picture's top-left
    expect(pixelToUser(g(270), 0, 0)).toEqual({ x: 210, y: 120 })
    expect(pixelToUser(g(270), 1000, 0)).toEqual({ x: 210, y: 20 })
    expect(pixelToUser(g(270), 0, 2000)).toEqual({ x: 10, y: 120 })
  })

  const place = (r: Rotation, l: OcrLine, o?: LayoutOptions): PlacedLine => placeLine(g(r), l, l.words, o)!

  it('reading direction follows the page rotation', () => {
    const l = line([word('Hello', 100, 100, 300, 140)], { x0: 100, y0: 138, x1: 300, y1: 138 }, 40)
    const dirs = ([0, 90, 180, 270] as Rotation[]).map((r) => {
      const p = place(r, l)
      return [Math.round(p.ux), Math.round(p.uy)]
    })
    expect(dirs).toEqual([
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1]
    ])
  })

  it('a placed line starts at the first word on the baseline; the word spans its box width, in points', () => {
    const l = line([word('Hello', 100, 100, 300, 140)], { x0: 100, y0: 138, x1: 300, y1: 138 }, 40)
    const p = place(0, l)
    near(p.x, 10 + 100 / 10)
    near(p.y, 120 - 138 / 10)
    near(p.words[0].width, 200 / 10)
    near(p.words[0].offset, 0)
    near(p.fontSize, 40 / 10)
    // sideways page: the baseline runs up the page
    const q = place(90, l)
    near(q.x, 10 + 138 / 10)
    near(q.y, 20 + 100 / 10)
    near(q.words[0].width, 20)
  })

  it('later words are placed along the line: their offset is the distance from the first word', () => {
    const l = line([word('One', 100, 100, 200, 140), word('two', 300, 100, 420, 140), word('three', 500, 100, 700, 140)], { x0: 100, y0: 138, x1: 700, y1: 138 }, 40)
    expect(place(0, l).words.map((w) => Math.round(w.offset * 1e6) / 1e6)).toEqual([0, 20, 40]) // 200 px and 400 px at 10 px/unit
    // a right-to-left line reads leftwards: later words have negative offsets
    const rtl = line([word('b', 500, 100, 700, 140), word('a', 100, 100, 200, 140)], { x0: 100, y0: 138, x1: 700, y1: 138 }, 40)
    expect(place(0, rtl).words.map((w) => w.offset)).toEqual([0, -40])
    // on a page turned 90 degrees the offsets are still measured along the reading direction
    near(place(90, l).words[2].offset, 40, 1e-9)
  })

  it('font size comes from the line height, kept within bounds of the word boxes', () => {
    const w = word('x', 0, 100, 30, 130)
    expect(lineFontSizePx(line([w], null, 40), [w])).toBe(40)
    expect(lineFontSizePx(line([w], null, 5), [w])).toBe(18) // never smaller than 0.6 x the box
    expect(lineFontSizePx(line([w], null, 500), [w])).toBe(66) // never larger than 2.2 x the box
    expect(lineFontSizePx({ ...line([w]), rowHeight: 0 }, [w])).toBe(30) // falls back to the line box
  })

  it('a negligible baseline slope is written straight (it is recognition noise, and would split lines in readers)', () => {
    const noise = line([word('a', 100, 100, 130, 130)], { x0: 100, y0: 306, x1: 537, y1: 307 })
    expect(baselineSlope(noise)).toBe(0)
    expect(place(0, noise).uy).toBe(0)
    expect(baselineSlope(line([word('a', 0, 0, 1, 1)], { x0: 0, y0: 0, x1: 100, y1: 3 }))).toBeCloseTo(0.03, 6)
    expect(baselineSlope(line([word('a', 0, 0, 1, 1)], { x0: 0, y0: 0, x1: 100, y1: 300 }))).toBe(0) // beyond 45 degrees: not a baseline
  })

  it('baseline: uses the line baseline (with slope) or falls back to just above the box bottom', () => {
    const w = word('a', 100, 50, 130, 80)
    const sloped = line([w], { x0: 0, y0: 70, x1: 200, y1: 80 })
    near(baselineY(sloped, w, 100), 75)
    near(baselineY(line([w]), w, 100), 80 - 0.18 * 30)
  })

  it('a tilted baseline tilts the text, and the tilt survives page rotation', () => {
    const l = line([word('Tilt', 100, 100, 300, 160)], { x0: 100, y0: 150, x1: 300, y1: 150 + 200 * Math.tan((3 * Math.PI) / 180) }, 50)
    const p = place(0, l)
    // 3 degrees clockwise on screen = writing direction turned 3 degrees clockwise = negative angle in y-up space
    near(Math.atan2(p.uy, p.ux), (-3 * Math.PI) / 180, 0.002)
    const q = place(90, l)
    near(Math.atan2(q.uy, q.ux), Math.PI / 2 - (3 * Math.PI) / 180, 0.002)
  })

  it('undoing a deskew rotation maps points back to the original picture', () => {
    const d = { angle: (2 * Math.PI) / 180, cx: 500, cy: 400 }
    const p = undoDeskew(d, 500, 400)
    expect(p).toEqual({ x: 500, y: 400 }) // the centre does not move
    const back = undoDeskew(d, 600, 400)
    near(Math.atan2(back.y - 400, back.x - 500), d.angle, 1e-9)
    near(Math.hypot(back.x - 500, back.y - 400), 100, 1e-9)
  })

  it('deskew: a straight word in the corrected picture becomes a tilted word in the original', () => {
    const l = line([word('Straight', 100, 100, 300, 140)], { x0: 100, y0: 138, x1: 300, y1: 138 }, 40)
    const p = place(0, l, { deskew: { angle: (2 * Math.PI) / 180, cx: 1000, cy: 500 } })
    near(Math.atan2(p.uy, p.ux), (-2 * Math.PI) / 180, 0.002)
  })
})

// ---- characters, ToUnicode, font ----------------------------------------------------------------------------------

describe('charset and ToUnicode', () => {
  it('the ASCII width table covers U+0020..U+007E', () => {
    for (let cp = 0x20; cp <= 0x7e; cp++) expect(advanceOf(cp), String.fromCharCode(cp)).toBeGreaterThan(0)
    expect(advanceOf(0x49)).toBe(278) // I
    expect(advanceOf(0x57)).toBe(944) // W
    expect(advanceOf(0x4e2d)).toBe(1000) // CJK is full width
    expect(advanceOf(0x0301)).toBe(0) // combining accent
  })

  it('assigns CIDs in order of first use; the space is CID 1', () => {
    const cs = new Charset()
    cs.addText('abca')
    expect(cs.cid(0x20)).toBe(1)
    expect([...'abc'].map((c) => cs.cid(c.codePointAt(0)!))).toEqual([2, 3, 4])
    expect(cs.size).toBe(4)
    expect(cs.hex('ab c')).toBe('<0002000300010004>')
    expect(() => cs.cid(0x5a)).toThrow()
  })

  it('cleans recognized text: ligatures spelled out, controls and spaces dropped', () => {
    expect(cleanWordText('ﬁnal')).toBe('final')
    expect(cleanWordText('of​ fice\u0007')).toBe('of​fice') // zero-width space is kept, BEL and blank dropped
    expect(cleanWordText('  \n ')).toBe('')
  })

  it('stores right-to-left words in visual order (readers run the bidi algorithm to get logical order back)', () => {
    expect(toVisualOrder('Hello')).toBe('Hello')
    expect(toVisualOrder('שלום')).toBe('םולש')
    // digits and Latin letters inside an RTL word keep their own order; the runs swap places
    expect(toVisualOrder('שלום123')).toBe('123םולש')
    expect(toVisualOrder('abcשלום')).toBe('םולשabc')
  })

  it('builds a ToUnicode CMap that maps every CID, including characters beyond the BMP', () => {
    const cs = new Charset()
    cs.addText('Ab€中\u{1F600}')
    const cmap = buildToUnicode(cs)
    expect(cmap).toContain('begincmap')
    expect(cmap).toContain('<0000> <FFFF>')
    const entries = [...cmap.matchAll(/^<([0-9A-F]{4})> <([0-9A-F]+)>$/gm)].map((m) => [m[1], m[2]]).filter(([c]) => c !== '0000')
    expect(entries).toEqual([
      ['0001', '0020'],
      ['0002', '0041'],
      ['0003', '0062'],
      ['0004', '20AC'],
      ['0005', '4E2D'],
      ['0006', 'D83DDE00']
    ])
    expect(utf16Hex(0x1f600)).toBe('D83DDE00')
  })

  it('splits big maps into blocks of at most 100 entries', () => {
    const cs = new Charset()
    for (let i = 0; i < 250; i++) cs.add(0x4e00 + i)
    const blocks = [...buildToUnicode(cs).matchAll(/^(\d+) beginbfchar$/gm)].map((m) => Number(m[1]))
    expect(blocks.every((n) => n <= 100)).toBe(true)
    expect(blocks.reduce((a, b) => a + b, 0)).toBe(251)
  })
})

describe('glyphless font program', () => {
  it('is a well-formed TrueType file with the requested advances and no outlines', async () => {
    const fontkit = (await import('@pdf-lib/fontkit')).default
    const ttf = buildGlyphlessFont([278, 556, 1000])
    const font = fontkit.create(ttf as never) as unknown as { numGlyphs: number; unitsPerEm: number; getGlyph(i: number): { advanceWidth: number; path: { commands: unknown[] } } }
    expect(font.numGlyphs).toBe(4)
    expect(font.unitsPerEm).toBe(1000)
    expect([1, 2, 3].map((i) => font.getGlyph(i).advanceWidth)).toEqual([278, 556, 1000])
    expect(font.getGlyph(2).path.commands).toHaveLength(0)
  })

  it('has valid table checksums and head.checkSumAdjustment', () => {
    const ttf = buildGlyphlessFont(Array.from({ length: 300 }, () => 500))
    const view = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength)
    const sum = (start: number, len: number): number => {
      let s = 0
      for (let i = 0; i < Math.ceil(len / 4) * 4; i += 4) {
        let v = 0
        for (let k = 0; k < 4; k++) v = v * 256 + (start + i + k < start + len ? ttf[start + i + k] : 0)
        s = (s + v) >>> 0
      }
      return s
    }
    const n = view.getUint16(4)
    let headOffset = 0
    for (let i = 0; i < n; i++) {
      const rec = 12 + i * 16
      const tag = String.fromCharCode(...ttf.slice(rec, rec + 4))
      const off = view.getUint32(rec + 8)
      const len = view.getUint32(rec + 12)
      if (tag === 'head') {
        headOffset = off
        continue // its checksum is computed with the adjustment field zeroed
      }
      expect(view.getUint32(rec + 4), tag).toBe(sum(off, len))
    }
    expect(view.getUint32(headOffset + 12)).toBe(0x5f0f3cf5)
    expect(sum(0, ttf.length)).toBe(0xb1b0afba)
  })

  it('refuses more glyphs than a font can hold', () => {
    expect(() => buildGlyphlessFont(new Array(70000).fill(500))).toThrow(/Too many/)
  })
})

// ---- content stream -----------------------------------------------------------------------------------------------

describe('text layer content stream', () => {
  const w = (text: string, offset: number, width: number) => ({ text, offset, width, conf: 90 })
  const ln = (words: PlacedLine['words'], o: Partial<PlacedLine> = {}): PlacedLine => ({ x: 72, y: 700, ux: 1, uy: 0, fontSize: 10, tilted: false, words, ...o })

  it('uses render mode 3, one text matrix per line, moves between words and character spacing that fits each word', () => {
    const cs = new Charset()
    const lines = collectChars([ln([w('Hello', 0, 30), w('world', 38, 33)])], cs)
    const s = buildLayerStream('F1', cs, lines)
    expect(s.startsWith(LAYER_MARKER)).toBe(true)
    expect(s).toContain('3 Tr')
    expect(s.match(/ Tm$/gm)).toHaveLength(1) // a single matrix: readers keep the line together
    expect(s).toContain('1 0 0 1 72 700 Tm')
    expect(s).toContain('38 0 Td') // the second word is 38 units further along the line
    expect(s).toContain('/F1 10 Tf')
    // natural width of "Hello" at 10pt with Helvetica-like advances: (722+556+222+222+556)/1000*10 = 22.78 -> Tz = 3000/22.78
    const tz = Number(/([\d.]+) Tz/.exec(s)![1])
    near(tz, (100 * 30) / 22.78, 0.01)
    // "Hello" is followed by a space (another word follows on the line), "world" is not
    expect(s).toContain(cs.hex('Hello '))
    expect(s).toContain(cs.hex('world'))
    expect(s).not.toContain(cs.hex('world '))
    // balanced graphics state and text objects
    expect(s.match(/^q$/gm)).toHaveLength(1)
    expect(s.match(/^Q$/gm)).toHaveLength(1)
    expect(s.match(/^BT$/gm)).toHaveLength(1)
    expect(s.match(/^ET$/gm)).toHaveLength(1)
  })

  it('writes a rotated text matrix for sideways or tilted words', () => {
    const cs = new Charset()
    const s = buildLayerStream('F1', cs, collectChars([ln([w('Up', 0, 20)], { x: 50, y: 60, ux: 0, uy: 1 })], cs))
    expect(s).toContain('0 1 -1 0 50 60 Tm')
  })

  it('a word ending up empty is dropped from its line, and an empty line disappears', () => {
    const cs = new Charset()
    const lines = collectChars([ln([w('  ', 0, 5), w('A', 10, 5)]), ln([w('\u0007', 0, 5)])], cs)
    expect(lines).toHaveLength(1)
    expect(lines[0].words.map((x) => x.text)).toEqual(['A'])
  })

  it('clamps extreme horizontal scaling', () => {
    const cs = new Charset()
    const lines = collectChars([ln([w('WWWW', 0, 1), w('ii', 5, 9999)])], cs)
    expect(lines[0].words.map((x) => x.text)).toEqual(['WWWW', 'ii'])
    const tzs = [...buildLayerStream('F1', cs, lines).matchAll(/([\d.]+) Tz/g)].map((m) => Number(m[1]))
    expect(tzs).toEqual([20, 500])
  })

  it('upright lines fit every word to its own box; tilted lines all share ONE scaling (per page)', () => {
    const cs = new Charset()
    const words = [w('Hello', 0, 30), w('there', 40, 12), w('you', 60, 50)]
    const upright = collectChars([ln(words)], cs)
    const tilted = collectChars([ln(words, { tilted: true }), ln(words, { tilted: true, y: 650 })], cs)
    expect(new Set(lineScaling(cs, upright[0], 100)).size).toBe(3)
    const shared = tiltedScaling(cs, tilted)
    // the mean: total width over total natural width
    const natural = words.reduce((sum, x) => sum + naturalWidth(cs, x.text, 10), 0)
    near(shared, (100 * 92) / natural, 1e-9)
    expect(lineScaling(cs, tilted[0], shared)).toEqual([shared, shared, shared])
    // PDF.js takes words or lines with different Tz for separate lines when they are tilted, so only one Tz is written
    expect(buildLayerStream('F1', cs, tilted).match(/ Tz$/gm)).toHaveLength(1)
    expect(buildLayerStream('F1', cs, upright).match(/ Tz$/gm)).toHaveLength(3)
    expect(tiltedScaling(cs, upright)).toBe(100) // no tilted lines: nothing to average
  })
})

// ---- applying to a PDF + reading back with PDF.js ----------------------------------------------------------------

interface Item {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

async function pdfjsText(bytes: Uint8Array, pageNo = 1): Promise<Item[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  try {
    const page = await doc.getPage(pageNo)
    const tc = await page.getTextContent()
    return (tc.items as Array<Item & { str?: string }>).filter((i) => typeof i.str === 'string' && i.str !== '') as Item[]
  } finally {
    await task.destroy()
  }
}

const geometryOf = (page: ReturnType<PDFDocument['getPage']>, w: number, h: number): PageGeometry => ({
  view: visibleBox(page),
  rotate: normalizeRotation(page.getRotation().angle),
  width: w,
  height: h
})

describe('applyOcrLayers', () => {
  it('adds invisible, extractable text at the right place and leaves the picture untouched', async () => {
    const src = await createScan1()
    const pdf = await PDFDocument.load(src)
    const g = geometryOf(pdf.getPage(0), 1700, 2200)
    const l = line([word('Invoice', 202, 275, 340, 307), word('number', 356, 274, 510, 307), word('48213', 522, 275, 639, 307)], { x0: 202, y0: 306, x1: 639, y1: 306 }, 41)
    const res = applyOcrLayers(pdf, [{ pageIndex: 0, geometry: g, lines: [l] }])
    expect(res).toMatchObject({ pages: [0], words: 3, skipped: [] })
    near(res.confidence, 95, 0.001)
    const out = await pdf.save()

    const items = await pdfjsText(out)
    expect(items.map((i) => i.str).join('').replace(/\s+/g, ' ').trim()).toBe('Invoice number 48213')
    const first = items[0]
    near(first.transform[4], (202 * 72) / 200, 0.05) // x in points
    near(first.transform[5], 792 - (306 * 72) / 200, 0.05) // baseline y in points
    // the layer is invisible and the original picture object is still there
    const raw = new TextDecoder('latin1').decode(await PDFDocument.load(out).then((d) => d.save({ useObjectStreams: false })))
    expect(raw).toContain('/Subtype /Image')
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPage(0).node.Resources()!.has(reloaded.context.obj('XObject') as never)).toBe(true)
  })

  const lineCases = [0, 90, 180, 270].flatMap((rot) => [0, 0.13, 3, -4].map((deg): [number, number] => [rot, deg]))
  it.each(lineCases)('page /Rotate %i, line tilted by %f degrees: the words stay ONE line in extracted text; the next line starts a new one', async (rot, deg) => {
    const pdf = await PDFDocument.load(rot === 0 ? await createScan1() : await createScanRotated(rot))
    const sideways = rot % 180 !== 0
    const g = geometryOf(pdf.getPage(0), sideways ? 2200 : 1700, sideways ? 1700 : 2200)
    const slope = Math.tan((deg * Math.PI) / 180)
    const mk = (y: number, texts: string[]): OcrLine => {
      const ws = texts.map((t, i) => {
        const x0 = 200 + i * 260
        const yy = y + (x0 - 200) * slope
        return word(t, x0, yy - 32, x0 + t.length * 21, yy) // about 0.5 em per letter at 41 px, like the real scan
      })
      return line(ws, { x0: 200, y0: y, x1: 200 + 260 * texts.length, y1: y + 260 * texts.length * slope }, 41)
    }
    applyOcrLayers(pdf, [{ pageIndex: 0, geometry: g, lines: [mk(300, ['Invoice', 'number', '48213']), mk(500, ['Payment', 'is', 'due'])] }])
    const items = await pdfjsText(await pdf.save())
    const text = items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join('')
    expect(text.replace(/[ ]+\n/g, '\n').trim()).toBe('Invoice number 48213\nPayment is due')
  })

  it('extracts the right Unicode for every script (Latin, Cyrillic, Greek, CJK, Arabic, Devanagari, Hangul)', async () => {
    const samples = ['Grüße Übung', 'Привет мир', 'Καλημέρα κόσμε', '你好世界', 'こんにちは', '안녕하세요', 'مرحبا بالعالم', 'नमस्ते दुनिया', 'ﬁnal ﬂow']
    const expected = ['Grüße Übung', 'Привет мир', 'Καλημέρα κόσμε', '你好世界', 'こんにちは', '안녕하세요', 'مرحبا بالعالم', 'नमस्ते दुनिया', 'final flow']
    const pdf = await PDFDocument.load(await createScan1())
    const g = geometryOf(pdf.getPage(0), 1700, 2200)
    const lines = samples.map((s, i) => {
      const y = 300 + i * 120
      const ws = s.split(' ').map((t, k) => word(t, 200 + k * 400, y - 40, 500 + k * 400, y))
      return line(ws, { x0: 200, y0: y, x1: 900, y1: y }, 40)
    })
    applyOcrLayers(pdf, [{ pageIndex: 0, geometry: g, lines }])
    const out = await pdf.save()
    const text = (await pdfjsText(out)).map((i) => i.str)
    const joined = text.join('\n')
    for (const e of expected) for (const part of e.split(' ')) expect(joined, part).toContain(part)
  })

  it.each([0, 90, 180, 270])('a page with /Rotate %i: words keep their on-screen position and direction', async (rot) => {
    const src = rot === 0 ? await createScan1() : await createScanRotated(rot)
    const pdf = await PDFDocument.load(src)
    const page = pdf.getPage(0)
    const displayW = rot % 180 === 0 ? 612 : 792
    const displayH = rot % 180 === 0 ? 792 : 612
    const W = Math.round((displayW * 200) / 72)
    const H = Math.round((displayH * 200) / 72)
    const g = geometryOf(page, W, H)
    const l = line([word('Invoice', 202, 275, 340, 307)], { x0: 202, y0: 306, x1: 340, y1: 306 }, 41)
    applyOcrLayers(pdf, [{ pageIndex: 0, geometry: g, lines: [l] }])
    const items = await pdfjsText(await pdf.save())
    expect(items).toHaveLength(1)
    expect(items[0].str.trim()).toBe('Invoice')
    // PDF.js reports the text-space matrix in user space: the writing direction is (a, b)
    const [a, b, , , e, f] = items[0].transform
    const dir = rot === 0 ? [1, 0] : rot === 90 ? [0, 1] : rot === 180 ? [-1, 0] : [0, -1]
    near(a / Math.hypot(a, b), dir[0], 0.001)
    near(b / Math.hypot(a, b), dir[1], 0.001)
    // ... and the origin is the on-screen point (202, 306) px mapped through the page rotation
    const p = pixelToUser(g, 202, 306)
    near(e, p.x, 0.05)
    near(f, p.y, 0.05)
  })

  it('honours a MediaBox that does not start at the origin and a CropBox inside it', async () => {
    const pdf = await PDFDocument.load(await createScanCropped())
    const page = pdf.getPage(0)
    const box = visibleBox(page)
    expect(box).toEqual([60, 90, 652, 822])
    const g: PageGeometry = { view: box, rotate: 0, width: Math.round(((652 - 60) * 200) / 72), height: Math.round(((822 - 90) * 200) / 72) }
    const l = line([word('Invoice', 100, 100, 300, 140)], { x0: 100, y0: 138, x1: 300, y1: 138 }, 40)
    applyOcrLayers(pdf, [{ pageIndex: 0, geometry: g, lines: [l] }])
    const items = await pdfjsText(await pdf.save())
    near(items[0].transform[4], 60 + (100 * 72) / 200, 0.05)
    near(items[0].transform[5], 822 - (138 * 72) / 200, 0.05)
  })

  it('refuses pages whose geometry changed since they were recognized, and applies the rest', async () => {
    const pdf = await PDFDocument.load(await createScan1())
    pdf.addPage([300, 300])
    const good = geometryOf(pdf.getPage(0), 1700, 2200)
    const stale = { ...geometryOf(pdf.getPage(1), 833, 833), rotate: 90 as Rotation }
    const l = line([word('Hello', 100, 100, 300, 140)])
    const res = applyOcrLayers(pdf, [
      { pageIndex: 0, geometry: good, lines: [l] },
      { pageIndex: 1, geometry: stale, lines: [l] },
      { pageIndex: 7, geometry: good, lines: [l] }
    ])
    expect(res.pages).toEqual([0])
    expect(res.skipped.map((s) => s.pageIndex)).toEqual([1, 7])
    expect(res.skipped[0].reason).toMatch(/rotated/)
    expect(geometryMismatch(pdf.getPage(0), good)).toBeNull()
    expect(geometryMismatch(pdf.getPage(0), { ...good, view: [0, 0, 500, 500] })).toMatch(/size changed/)
  })

  it('drops low-confidence words and writes nothing when nothing is left', async () => {
    const pdf = await PDFDocument.load(await createScan1())
    const g = geometryOf(pdf.getPage(0), 1700, 2200)
    const l = line([word('noise', 100, 100, 300, 140, 5), word('word', 320, 100, 400, 140, 90)])
    const res = applyOcrLayers(pdf, [{ pageIndex: 0, geometry: g, lines: [l] }])
    expect(res.words).toBe(1)
    const none = applyOcrLayers(await PDFDocument.load(await createScan1()), [{ pageIndex: 0, geometry: g, lines: [line([word('x', 1, 1, 9, 9, 3)])] }])
    expect(none).toMatchObject({ pages: [], words: 0 })
  })

  it('running again replaces the earlier layer instead of stacking a second one', async () => {
    let bytes = await createScan1()
    const runOnce = async (text: string): Promise<Uint8Array> => {
      const pdf = await PDFDocument.load(bytes)
      const g = geometryOf(pdf.getPage(0), 1700, 2200)
      applyOcrLayers(pdf, [{ pageIndex: 0, geometry: g, lines: [line([word(text, 202, 275, 340, 307)], { x0: 202, y0: 306, x1: 340, y1: 306 }, 41)] }])
      return pdf.save()
    }
    bytes = await runOnce('First')
    bytes = await runOnce('Second')
    const items = await pdfjsText(bytes)
    expect(items.map((i) => i.str.trim())).toEqual(['Second'])
  })

  it('output is a valid PDF pdf-lib can load again, with a Type0 font that carries a ToUnicode map', async () => {
    const pdf = await PDFDocument.load(await createScan1())
    const g = geometryOf(pdf.getPage(0), 1700, 2200)
    const a: PageOcr = { pageIndex: 0, geometry: g, lines: [line([word('Hello', 202, 275, 340, 307)])] }
    applyOcrLayers(pdf, [a])
    const out = await pdf.save({ useObjectStreams: false })
    const raw = new TextDecoder('latin1').decode(out)
    expect(raw).toContain('/Subtype /Type0')
    expect(raw).toContain('/ToUnicode')
    expect(raw).toContain('/CIDToGIDMap /Identity')
    expect(raw).toContain('/FontFile2')
    await PDFDocument.load(out)
  })
})
