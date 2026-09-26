import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildPageText, pageGeometry, rangeBoxes, rangeQuads, type Box } from '../../src/shared/pagetext'
import { engineLines, withRotation } from '../fixtures/pagetext/engine'
import { FIXTURES, fixtureBytes, modelsOf } from './helpers/pagetext'
import { setupText } from './helpers/text'

/**
 * Geometry of the page text model against INDEPENDENT ground truth: when the Chromium fixtures were printed, the
 * box of every word was read from Chromium's own layout (getClientRects of a <span> per word, CSS px -> points). The
 * model's box of the same word, found in its logical text, must cover the same glyphs. Also: display space equals a
 * PDF.js viewport at scale 1 on rotated pages.
 */
setupText()

interface WordBox {
  line: string
  k: number
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

const union = (bs: Box[]): Box => ({ x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) })

for (const name of ['lines', 'para', 'columns']) {
  describe(`Chromium ${name}: word boxes of the model vs Chromium's layout`, () => {
    it('every word is found in logical order and its glyph box matches (horizontal edges within 1.5 pt, vertical overlap)', async () => {
      const truth = JSON.parse(readFileSync(resolve(FIXTURES, `chromium-${name}.boxes.json`), 'utf8')) as WordBox[]
      const [m] = await modelsOf(fixtureBytes(`chromium-${name}.pdf`))
      const text = m.text.normalize('NFC')
      let from = 0
      let worst = 0
      const misses: string[] = []
      for (const w of truth) {
        const word = w.text.normalize('NFC')
        const at = text.indexOf(word, from)
        if (at < 0) {
          misses.push(`${w.line}#${w.k} ${word}`)
          continue
        }
        from = at + word.length
        const b = union(rangeBoxes(m, at, at + word.length))
        const dx = Math.max(Math.abs(b.x0 - w.x0), Math.abs(b.x1 - w.x1))
        worst = Math.max(worst, dx)
        if (dx > 1.5) misses.push(`${w.line}#${w.k} ${word}: model x ${b.x0.toFixed(1)}..${b.x1.toFixed(1)}, Chromium ${w.x0.toFixed(1)}..${w.x1.toFixed(1)}`)
        const overlap = Math.min(b.y1, w.y1) - Math.max(b.y0, w.y0)
        if (overlap < 0.6 * (b.y1 - b.y0)) misses.push(`${w.line}#${w.k} ${word}: vertical ${b.y0.toFixed(1)}..${b.y1.toFixed(1)} vs ${w.y0.toFixed(1)}..${w.y1.toFixed(1)}`)
      }
      console.log(`chromium-${name}: ${truth.length} words, worst horizontal edge difference ${worst.toFixed(2)} pt`)
      expect(misses).toEqual([])
      expect(truth.length).toBeGreaterThan(20)
    })
  })
}

describe('display space', () => {
  it('equals the PDF.js viewport transform at scale 1 for every page rotation', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const base = await engineLines()
    for (const angle of [0, 90, 180, 270]) {
      const bytes = await withRotation(base, angle)
      const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
      const doc = await task.promise
      const vp = (await doc.getPage(1)).getViewport({ scale: 1 })
      const g = pageGeometry(await PDFDocument.load(bytes), 0)
      expect(g.transform.map((v) => Math.round(v * 1000) / 1000), `rotation ${angle}`).toEqual((vp.transform as number[]).map((v) => Math.round(v * 1000) / 1000))
      expect([g.width, g.height]).toEqual([vp.width, vp.height])
      await task.destroy()
    }
  })
  it('on a /Rotate 90 page, the boxes of a word are the rotated boxes of the unrotated page', async () => {
    const base = await engineLines()
    const rotated = await withRotation(base, 90)
    const [a] = await modelsOf(base)
    const [b] = await modelsOf(rotated)
    expect(b.text).toBe(a.text)
    const i = a.text.indexOf('بالعالم')
    const qa = rangeQuads(a, i, i + 7)[0]
    const qb = rangeQuads(b, i, i + 7)[0]
    // rotating the display by 90 degrees clockwise: (x, y) -> (H - y, x)
    const H = a.height
    for (let k = 0; k < 8; k += 2) {
      expect(qb[k]).toBeCloseTo(H - qa[k + 1], 3)
      expect(qb[k + 1]).toBeCloseTo(qa[k], 3)
    }
    expect(b.lines.find((l) => b.text.slice(l.start, l.end).includes('بالعالم'))!.angle).toBe(90)
  })
  it('model is pure data: structured-cloneable (worker transfer) with typed arrays', async () => {
    const pdf = await PDFDocument.load(fixtureBytes('lo-lines.pdf'))
    const m = buildPageText(pdf, 0)
    const copy = structuredClone(m)
    expect(copy.text).toBe(m.text)
    expect(copy.quads).toBeInstanceOf(Float32Array)
    expect(copy.charQuad.length).toBe(m.text.length)
  })
})
