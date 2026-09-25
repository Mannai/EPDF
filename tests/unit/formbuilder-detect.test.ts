import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { detectPage, type DetectResult, type Proposal } from '../../src/renderer/src/features/formbuilder/logic/detect'
import { PageFrame } from '../../src/renderer/src/features/formbuilder/logic/frame'
import { readPageContent } from '../../src/renderer/src/features/formbuilder/logic/pageContent'
import {
  createBoxes,
  createChoices,
  createColumns,
  createCombs,
  createLeaders,
  createMixed,
  createNegatives,
  createScan,
  createScanWithOcrLayer,
  createTables,
  createUnderlines
} from '../fixtures/form-builder.mjs'

interface Expected {
  kind: string
  box: [number, number, number, number]
  label?: string
  header?: string
  multiline?: boolean
  cells?: number
  options?: string[]
}
interface Fixture {
  bytes: Uint8Array
  expected: Expected[]
}

const THRESHOLD = 0.5

async function run(bytes: Uint8Array): Promise<{ results: DetectResult[]; proposals: Proposal[] }> {
  const pdf = await PDFDocument.load(bytes)
  const results = pdf.getPages().map((_, i) => detectPage(readPageContent(pdf, i)))
  return { results, proposals: results.flatMap((r) => r.proposals).filter((p) => p.confidence >= THRESHOLD) }
}

const inside = (p: Proposal, e: Expected, slack = 6): boolean => {
  const cx = (p.rect.x0 + p.rect.x1) / 2
  const cy = (p.rect.y0 + p.rect.y1) / 2
  return cx >= e.box[0] - slack && cx <= e.box[2] + slack && cy >= e.box[1] - slack && cy <= e.box[3] + slack
}

/** Greedy one-to-one matching of proposals to expected fields (same kind, centre inside the expected box). */
function score(proposals: Proposal[], expected: Expected[]): { tp: number; fp: Proposal[]; fn: Expected[]; matched: [Proposal, Expected][] } {
  const used = new Set<Proposal>()
  const matched: [Proposal, Expected][] = []
  const fn: Expected[] = []
  for (const e of expected) {
    const p = proposals.find((q) => !used.has(q) && q.kind === e.kind && inside(q, e))
    if (p) {
      used.add(p)
      matched.push([p, e])
    } else fn.push(e)
  }
  return { tp: matched.length, fp: proposals.filter((p) => !used.has(p)), fn, matched }
}

const describeProps = (ps: Proposal[]): string => ps.map((p) => `${p.kind} ${Math.round(p.rect.x0)},${Math.round(p.rect.y0)}-${Math.round(p.rect.x1)},${Math.round(p.rect.y1)} c=${p.confidence} "${p.label ?? ''}" ${p.reason}`).join('\n')
const describeExp = (es: Expected[]): string => es.map((e) => `${e.kind} ${e.box.join(',')} ${e.label ?? e.header ?? ''}`).join('\n')

const stats: { name: string; tp: number; fp: number; fn: number }[] = []

async function check(name: string, make: (rotate?: number) => Promise<Fixture>, rotate = 0): Promise<{ proposals: Proposal[]; matched: [Proposal, Expected][] }> {
  const fx = await make(rotate)
  const { proposals } = await run(fx.bytes)
  const s = score(proposals, fx.expected)
  stats.push({ name: `${name}${rotate ? ` (rotate ${rotate})` : ''}`, tp: s.tp, fp: s.fp.length, fn: s.fn.length })
  expect(s.fn.length, `missed:\n${describeExp(s.fn)}\nproposals:\n${describeProps(proposals)}`).toBe(0)
  expect(s.fp.length, `unexpected:\n${describeProps(s.fp)}`).toBe(0)
  return { proposals, matched: s.matched }
}

describe('detection on generated flat forms (precision and recall per fixture)', () => {
  it('rules after labels, captions under rules, two columns; underlined headings and words are not fields', async () => {
    const { matched } = await check('underlines', createUnderlines)
    const byLabel = Object.fromEntries(matched.map(([p, e]) => [e.label, p]))
    expect(byLabel['Full name'].name).toBe('Full_name')
    expect(byLabel['Date of birth'].kind).toBe('date')
    expect(byLabel['Signed by'].kind).toBe('signature')
    expect(byLabel['Signature'].kind).toBe('signature')
    // The column layout: the label to the LEFT of each rule names it.
    expect(byLabel['City'].name).toBe('City')
    expect(byLabel['Postcode'].name).toBe('Postcode')
  })

  it('boxes with labels left, above and inside; shaded boxes; a framed paragraph is not a field', async () => {
    const { matched } = await check('boxes', createBoxes)
    const comments = matched.find(([, e]) => e.label === 'Comments')![0]
    expect(comments.multiline).toBe(true)
    expect(matched.find(([, e]) => e.label === 'Company name')![0].label).toBe('Company name')
  })

  it('checkboxes, radio groups (row and column), Yes/No boxes; bullets and a decorative circle are not fields', async () => {
    const { matched } = await check('choices', createChoices)
    const gender = matched.find(([, e]) => e.label === 'Gender')![0]
    expect(gender.buttons?.map((b) => b.value)).toEqual(['Male', 'Female', 'Other'])
    expect(gender.name).toBe('Gender')
    const contact = matched.find(([, e]) => e.label === 'Preferred contact')![0]
    expect(contact.buttons?.map((b) => b.label)).toEqual(['Email', 'Phone', 'Post'])
    const yn = matched.find(([, e]) => e.label === 'Are you a resident?')![0]
    expect(yn.buttons?.map((b) => b.value)).toEqual(['Yes', 'No'])
  })

  it('comb fields: adjacent cells and a box with tick marks', async () => {
    const { matched } = await check('combs', createCombs)
    expect(matched.find(([, e]) => e.label === 'Account number')![0].cells).toBe(10)
    expect(matched.find(([, e]) => e.label === 'Postcode')![0].cells).toBe(6)
  })

  it('tables: empty cells under headers, empty cells beside labels; a full table is not a field', async () => {
    const { matched, proposals } = await check('tables', createTables)
    expect(proposals).toHaveLength(15)
    const priceCells = matched.filter(([, e]) => e.header === 'Price').map(([p]) => p.name)
    expect(new Set(priceCells).size).toBe(4) // dedup: Price, Price_2, ...
    expect(matched.find(([, e]) => e.label === 'Email')![0].name).toBe('Email')
  })

  it('multi-column forms label each box with the text on its left', async () => {
    const { matched } = await check('columns', createColumns)
    expect(matched.find(([, e]) => e.label === 'Last name')![0].name).toBe('Last_name')
    expect(matched.find(([, e]) => e.label === 'Country')![0].label).toBe('Country')
  })

  it('leader characters in text: underscores, dots, spaced dots, ___/___/____ dates; prose ellipses are not fields', async () => {
    const { matched } = await check('leaders', createLeaders)
    expect(matched.find(([, e]) => e.label === 'Date')![0].kind).toBe('date')
    expect(matched.find(([, e]) => e.label === 'Age')![0].name).toBe('Age')
  })

  it('a page of pure negatives produces nothing at the default threshold', async () => {
    const fx = await createNegatives()
    const { proposals } = await run(fx.bytes)
    expect(proposals, describeProps(proposals)).toHaveLength(0)
    stats.push({ name: 'negatives', tp: 0, fp: proposals.length, fn: 0 })
  })

  for (const rotate of [90, 180, 270]) {
    it(`rotated pages (/Rotate ${rotate}) give the same fields, mapped back into user space`, async () => {
      await check('mixed', createMixed, rotate)
      await check('boxes', createBoxes, rotate)
      await check('choices', createChoices, rotate)
    })
  }

  it('the mixed form (used by the e2e test) is detected completely, with sensible unique names', async () => {
    const { proposals } = await check('mixed', createMixed)
    expect(proposals.map((p) => p.name).sort()).toEqual(
      ['City', 'Comments', 'Date_of_birth', 'Email', 'Full_name', 'I_agree_to_the_terms', 'Level', 'Send_me_the_newsletter', 'Signature'].sort()
    )
  })

  it('a scanned picture is reported as a scan with an OCR hint and no guessed fields', async () => {
    const { results } = await run((await createScan()).bytes)
    expect(results[0].status).toBe('scanned')
    expect(results[0].proposals).toHaveLength(0)
    expect(results[0].note).toMatch(/OCR/)
    const ocr = await run((await createScanWithOcrLayer()).bytes)
    expect(ocr.results[0].status).toBe('scanned')
    expect(ocr.results[0].proposals).toHaveLength(0)
  })

  it('an empty page says so', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([300, 300])
    const pdf = await PDFDocument.load(await doc.save())
    expect(detectPage(readPageContent(pdf, 0)).status).toBe('empty')
  })

  it('reports overall precision and recall', () => {
    const tp = stats.reduce((s, x) => s + x.tp, 0)
    const fp = stats.reduce((s, x) => s + x.fp, 0)
    const fn = stats.reduce((s, x) => s + x.fn, 0)
    const rows = stats.map((s) => `${s.name.padEnd(28)} tp=${s.tp} fp=${s.fp} fn=${s.fn}`).join('\n')
    console.log(`${rows}\nTOTAL precision=${(tp / (tp + fp || 1)).toFixed(3)} recall=${(tp / (tp + fn || 1)).toFixed(3)} (threshold ${THRESHOLD})`)
    expect(tp / (tp + fp || 1)).toBeGreaterThanOrEqual(0.95)
    expect(tp / (tp + fn || 1)).toBeGreaterThanOrEqual(0.95)
  })

  it('the page frame maps between visual and user space for every rotation', () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const f = new PageFrame([10, 20, 410, 320], rot)
      for (const [x, y] of [[10, 20], [410, 320], [200, 100], [55, 300]]) {
        const [vx, vy] = f.toVisual(x, y)
        const [ux, uy] = f.toUser(vx, vy)
        expect(ux).toBeCloseTo(x, 6)
        expect(uy).toBeCloseTo(y, 6)
        expect(vx).toBeGreaterThanOrEqual(-1e-9)
        expect(vx).toBeLessThanOrEqual(f.width + 1e-9)
        expect(vy).toBeLessThanOrEqual(f.height + 1e-9)
      }
    }
  })
})
