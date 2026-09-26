import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { buildPageText, rangeBoxes } from '../../src/shared/pagetext'
import { allCorpus, docxDocument, T, type CorpusDoc, type ExpectedPara } from '../support/arabicCorpus'
import { actualTexts, contentOf } from '../support/pdfContent'
import { flattenText, readPdf } from '../support/pdfText'
import { HAVE_SOFFICE, libreOfficePdf } from '../support/soffice'

/**
 * The Arabic Office corpus (tests/support/arabicCorpus.ts), converted by Epdf's built-in converter:
 *
 *  1. read back with the page text model (logical order): every source paragraph is found, one-line paragraphs as
 *     exactly one line, wrapped ones as a contiguous run of lines;
 *  2. the side each paragraph is aligned to (what a reader sees) is the expected one;
 *  3. compared with LibreOffice's rendering of the same file (skipped without LibreOffice): same alignment side for
 *     every paragraph, same column order in tables and sheets, aligned edges within EDGE_TOL points, wrapped
 *     paragraphs within one line of LibreOffice's line count. LibreOffice has the real Arial/Times New Roman; Epdf
 *     draws Arabic with Noto Naskh/Sans Arabic scaled to the same average width, so individual lines can differ by a
 *     word (see docs/features/office-rtl.md, "Verification").
 *
 * `EPDF_WRITE_CORPUS=1` also writes every input, Epdf's PDF and LibreOffice's PDF to test-results/office-rtl/.
 */

const fontsDir = resolve('resources/fonts')
const OUT = resolve('test-results/office-rtl')
/** Tolerance for aligned edges vs LibreOffice: cell padding and indent rounding differ by up to ~4 pt between the two. */
const EDGE_TOL = 6
/** A line is "centred" when its left and right gaps differ by less than this (points). */
const CENTER_TOL = 6

/** Comparison normalisation: NFC, bidi/format marks and kashida (tatweel, LibreOffice writes it into its text) removed, whitespace collapsed. */
const norm = (s: string): string => s.normalize('NFC').replace(/[‎‏؜‪-‮⁦-⁩ـ]/g, '').replace(/\s+/g, ' ').trim()
const words = (s: string): string => norm(s).split(' ').sort().join(' ')

interface PLine {
  text: string
  page: number
  x0: number
  x1: number
  width: number
  y: number
  /** Centre x of the characters of `sub` inside this line (from the model's glyph boxes). */
  centerOf(sub: string): number | null
}

async function readLines(bytes: Uint8Array): Promise<PLine[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const out: PLine[] = []
  pdf.getPages().forEach((pg, i) => {
    const m = buildPageText(pdf, i)
    for (const l of m.lines) {
      const raw = m.text.slice(l.start, l.end)
      out.push({
        text: norm(raw),
        page: i,
        x0: l.x0,
        x1: l.x1,
        width: pg.getWidth(),
        y: l.y1,
        centerOf: (sub) => {
          const k = raw.normalize('NFC').indexOf(sub)
          if (k < 0) return null
          const boxes = rangeBoxes(m, l.start + k, l.start + k + sub.length)
          if (!boxes.length) return null
          return (Math.min(...boxes.map((b) => b.x0)) + Math.max(...boxes.map((b) => b.x1))) / 2
        }
      })
    }
  })
  return out
}

/** Physical side of a line inside the text area [left, right] of its page. */
function sideOf(l: PLine, area: { left: number; right: number }): 'left' | 'right' | 'center' {
  const gl = l.x0 - area.left
  const gr = area.right - l.x1
  if (Math.abs(gl - gr) < CENTER_TOL && gl > CENTER_TOL) return 'center'
  return gr < gl ? 'right' : 'left'
}

/** The text area: the extreme edges of the full-width (justified) lines, else of all lines. */
function areaOf(lines: PLine[]): { left: number; right: number } {
  return { left: Math.min(...lines.map((l) => l.x0)), right: Math.max(...lines.map((l) => l.x1)) }
}

/** Lines displaying a paragraph: one line (exact or, for cells, contained), or consecutive lines whose text joins to it. */
function find(lines: PLine[], p: ExpectedPara, loose = false): PLine[] | null {
  const t = norm(p.text)
  const eq = (a: string): boolean => (loose ? words(a) === words(t) : a === t)
  const one = lines.find((l) => eq(l.text))
  if (one) return [one]
  if (p.where === 'cell' || p.where === 'table') {
    const c = lines.find((l) => (loose ? words(l.text).includes(words(t)) : l.text.includes(t)))
    if (c) return [c]
  }
  if (p.oneLine && !loose) return null
  for (let i = 0; i < lines.length; i++) {
    let acc = ''
    for (let j = i; j < lines.length && j < i + 12; j++) {
      acc = norm(acc + ' ' + lines[j]!.text)
      if (eq(acc)) return lines.slice(i, j + 1)
      if (!loose && !t.startsWith(acc)) break
    }
  }
  return null
}

const cache = new Map<string, Promise<{ ours: Uint8Array; lo?: Uint8Array; warnings: string[] }>>()
function convertBoth(doc: CorpusDoc): Promise<{ ours: Uint8Array; lo?: Uint8Array; warnings: string[] }> {
  let p = cache.get(doc.name)
  if (!p) {
    p = (async () => {
      const r = await convertOffice({ name: doc.name, bytes: doc.bytes }, { fontsDir })
      const lo = HAVE_SOFFICE ? await libreOfficePdf(doc.name, doc.bytes) : undefined
      if (process.env['EPDF_WRITE_CORPUS']) {
        mkdirSync(OUT, { recursive: true })
        writeFileSync(resolve(OUT, doc.name), doc.bytes)
        writeFileSync(resolve(OUT, `${doc.name}.epdf.pdf`), r.bytes)
        if (lo) writeFileSync(resolve(OUT, `${doc.name}.libreoffice.pdf`), lo)
      }
      return { ours: r.bytes, lo, warnings: r.warnings }
    })()
    cache.set(doc.name, p)
  }
  return p
}

describe('Arabic Office corpus: Epdf output read back in logical order', () => {
  for (const doc of allCorpus()) {
    it(`${doc.name}: every paragraph in logical order, on the expected side`, async () => {
      const { ours, warnings } = await convertBoth(doc)
      expect(warnings.filter((w) => /not available|right-to-left/i.test(w))).toEqual([])
      const lines = await readLines(ours)
      const area = areaOf(lines.filter((l) => l.page === 0))
      for (const p of doc.paras) {
        const found = find(lines, p)
        expect(found, `${doc.name}: “${p.text}” not found in ${JSON.stringify(lines.map((l) => l.text))}`).not.toBeNull()
        if (p.oneLine) expect(found!.length, p.text).toBe(1)
        if (p.side && p.where !== 'header' && p.where !== 'footer' && p.where !== 'tab') expect(sideOf(found![found!.length - 1]!, area), `${doc.name}: side of “${p.text}”`).toBe(p.side)
      }
      // what other PDF.js-based readers extract: every Arabic word is there (PDF.js orders mixed lines by itself)
      const pdfjs = flattenText((await readPdf(ours)).pages)
      for (const p of doc.paras) for (const w of norm(p.text).split(' ')) if (/[؀-ۿ]{2,}/.test(w)) expect(pdfjs, `PDF.js text of ${doc.name}`).toContain(w.replace(/[.،:()]/g, ''))
    }, 120_000)
  }

  it('right-to-left lines carry /ActualText with their logical text; Latin-only documents keep descriptive font names', async () => {
    const { ours } = await convertBoth(docxDocument())
    const pdf = await PDFDocument.load(ours)
    const spans = actualTexts(contentOf(pdf, pdf.getPages()[0]!)).map(norm)
    // the mixed Arabic/English/number line and a list item, exactly as typed
    expect(spans).toContain(norm(T.p2a + T.p2b + T.p2c))
    expect(spans).toContain(norm(`1. ${T.steps[0]}`))
    // the header: a right-to-left paragraph in the header part
    expect(spans).toContain(norm(T.header))
    // no ActualText on the plain English line (left-to-right lines are extracted from ToUnicode alone)
    expect(spans).not.toContain(norm(T.latin))
    // one BaseFont for every font of a document with right-to-left text: PDF.js keeps mixed lines together
    expect((await readPdf(ours)).embeddedFonts.every((f) => f === 'EPDFTX+EpdfText')).toBe(true)
    const latin = await convertOffice({ name: 'latin.txt', bytes: new TextEncoder().encode('Plain English only.\n') }, { fontsDir })
    const lt = await readPdf(latin.bytes)
    expect(lt.embeddedFonts.some((f) => /LiberationMono/.test(f))).toBe(true)
  })
})

describe.skipIf(!HAVE_SOFFICE)('Arabic Office corpus compared with LibreOffice', () => {
  for (const doc of allCorpus()) {
    it(`${doc.name}: same alignment sides, column order and edges as LibreOffice`, async () => {
      const { ours, lo } = await convertBoth(doc)
      const a = await readLines(ours)
      const b = await readLines(lo!)
      const areaA = areaOf(a.filter((l) => l.page === 0))
      const areaB = areaOf(b.filter((l) => l.page === 0))
      let compared = 0
      const report: string[] = []
      for (const p of doc.paras) {
        if (p.where === 'header' || p.where === 'footer') continue
        const la = find(a, p)
        const lb = find(b, p, true)
        if (!la || !lb) {
          report.push(`not in LibreOffice's text: ${p.text}`)
          continue
        }
        const A = la[la.length - 1]!
        const B = lb[lb.length - 1]!
        if (p.side) {
          if (p.where !== 'tab') expect(sideOf(A, areaA), `Epdf side of “${p.text}”`).toBe(sideOf(B, areaB))
          const edge = p.side === 'right' ? [A.width - A.x1, B.width - B.x1] : p.side === 'left' ? [A.x0, B.x0] : [(A.x0 + A.x1) / 2, (B.x0 + B.x1) / 2]
          report.push(`${p.side.padEnd(6)} edge Epdf=${edge[0]!.toFixed(1)} LO=${edge[1]!.toFixed(1)} | ${p.text.slice(0, 40)}`)
          expect(Math.abs(edge[0]! - edge[1]!), `edge of “${p.text}”`).toBeLessThan(EDGE_TOL)
          compared++
        }
        if (!p.oneLine && p.where === undefined) {
          report.push(`lines Epdf=${la.length} LO=${lb.length} | ${p.text.slice(0, 40)}`)
          expect(Math.abs(la.length - lb.length), `line count of “${p.text.slice(0, 30)}…”`).toBeLessThanOrEqual(1)
        }
      }
      if (doc.columns) {
        // table / sheet header cells: logical order must be right to left in both renderings
        const xs = (lines: PLine[]): number[] =>
          doc.columns!.map((c) => {
            const l = lines.find((x) => x.text === norm(c)) ?? lines.find((x) => x.text.split(' ').includes(norm(c)))!
            return l.text === norm(c) ? (l.x0 + l.x1) / 2 : (l.centerOf(norm(c)) ?? (l.x0 + l.x1) / 2)
          })
        const xa = xs(a)
        const xb = xs(b)
        report.push(`columns Epdf=${xa.map((x) => x.toFixed(0)).join(',')} LO=${xb.map((x) => x.toFixed(0)).join(',')}`)
        const rtlCols = doc.name.endsWith('.csv') ? false : true
        for (let i = 1; i < xa.length; i++) {
          expect(rtlCols ? xa[i]! < xa[i - 1]! : xa[i]! > xa[i - 1]!, `Epdf column order ${doc.columns.join(' | ')}`).toBe(true)
          expect(rtlCols ? xb[i]! < xb[i - 1]! : xb[i]! > xb[i - 1]!, `LibreOffice column order`).toBe(true)
        }
      }
      console.log(`[rtl vs LibreOffice] ${doc.name}: ${compared} aligned paragraphs compared\n  ` + report.join('\n  '))
      expect(compared + (doc.columns ? 1 : 0)).toBeGreaterThan(0)
    }, 300_000)
  }
})
