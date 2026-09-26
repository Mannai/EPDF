import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ACCEPT, classify, detectHeadings, nestHeadings, normalizeForRepeat, type HeadingCandidate, type PageText } from '../../src/shared/features/bookmarks/headings'
import { buildLines, visualToLogical, type RunLike } from '../../src/shared/features/textlines'
import { pageLines } from '../../src/renderer/src/features/bookmarks/pdf/pageLines'
import { arabicBook, boldOnlyManual, capsHeadings, cjkReport, englishReport, hardReport, noHeadings, twoColumn } from './helpers/lbHeadingDocs'
import type { Doc } from './helpers/lbDocs'
import { toVisual } from './helpers/lbDocs'

async function detect(doc: Doc, minConfidence?: number): Promise<HeadingCandidate[]> {
  const pdf = await PDFDocument.load(doc.bytes)
  const pages = pdf.getPages().map((_, i) => {
    const p = pageLines(pdf, i)
    return { pageIndex: i, box: p.box, lines: p.lines }
  })
  return detectHeadings(pages, { minConfidence }).candidates
}

const norm = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '')

interface Score {
  precision: number
  recall: number
  tp: number
  found: number
  expected: number
  levelAccuracy: number
}

/** Matches by page + text; a decoy that is returned counts as a false positive like any other extra. */
function score(found: HeadingCandidate[], truth: Doc['truth']): Score {
  const remaining = [...truth]
  let tp = 0
  let levelOk = 0
  for (const f of found) {
    const i = remaining.findIndex((t) => t.pageIndex === f.pageIndex && norm(t.text) === norm(f.text))
    if (i >= 0) {
      tp++
      if (remaining[i].level === f.level) levelOk++
      remaining.splice(i, 1)
    }
  }
  return {
    precision: found.length ? tp / found.length : truth.length === 0 ? 1 : 0,
    recall: truth.length ? tp / truth.length : 1,
    tp,
    found: found.length,
    expected: truth.length,
    levelAccuracy: tp ? levelOk / tp : 1
  }
}

const accepted = (c: HeadingCandidate[]): HeadingCandidate[] => c.filter((x) => x.confidence >= DEFAULT_ACCEPT)

describe('heading detection: precision and recall on generated documents', () => {
  const totals = { tp: 0, found: 0, expected: 0 }
  const report: string[] = []
  const check = (name: string, s: Score): void => {
    totals.tp += s.tp
    totals.found += s.found
    totals.expected += s.expected
    report.push(`${name}: precision ${(s.precision * 100).toFixed(0)}%  recall ${(s.recall * 100).toFixed(0)}%  levels ${(s.levelAccuracy * 100).toFixed(0)}%  (${s.tp}/${s.found} found, ${s.expected} expected)`)
  }

  it('English report: chapters, sections and subsections; ignores running header, page numbers, captions, bullets and footnotes', async () => {
    const doc = await englishReport()
    const found = accepted(await detect(doc))
    const s = score(found, doc.truth)
    check(doc.name, s)
    expect(s.recall).toBeGreaterThanOrEqual(0.95)
    expect(s.precision).toBeGreaterThanOrEqual(0.95)
    expect(s.levelAccuracy).toBeGreaterThanOrEqual(0.95)
    for (const d of doc.decoys) expect(found.map((f) => f.text)).not.toContain(d)
    expect(found.map((f) => f.text).join('|')).not.toMatch(/ACME Corp - Annual|Page \d/)
    // Reading order and nesting follow the document.
    expect(found[0]).toMatchObject({ text: '1 Introduction', level: 1, pageIndex: 1 })
    const tree = nestHeadings(found)
    expect(tree.map((n) => n.candidate.text)).toEqual(['1 Introduction', '2 System Architecture', '3 Implementation', '4 Evaluation', '5 Conclusion'])
    expect(tree[0].children.map((n) => n.candidate.text)).toEqual(['1.1 Background', '1.2 Objectives', '1.3 Scope of this Report'])
    expect(tree[0].children[0].children.map((n) => n.candidate.text)).toEqual(['1.1.1 Details'])
  })

  it('harder report: contents page with dot leaders, wrapped chapter titles, bold table header and note, pull quote', async () => {
    const doc = await hardReport()
    const found = accepted(await detect(doc))
    const s = score(found, doc.truth)
    check(doc.name, s)
    expect(found.map((f) => f.text)).toContain('Chapter 3: Backup and Recovery Procedures for Production Databases in Regulated Environments')
    expect(s.recall).toBeGreaterThanOrEqual(0.9)
    expect(s.precision).toBeGreaterThanOrEqual(0.9)
    for (const d of doc.decoys) expect(found.map((f) => f.text)).not.toContain(d)
  })

  it('manual whose headings are only bold at body size', async () => {
    const doc = await boldOnlyManual()
    const s = score(accepted(await detect(doc)), doc.truth)
    check(doc.name, s)
    expect(s.recall).toBeGreaterThanOrEqual(0.9)
    expect(s.precision).toBeGreaterThanOrEqual(0.9)
  })

  it('unnumbered ALL-CAPS headings at almost the body size', async () => {
    const doc = await capsHeadings()
    const s = score(accepted(await detect(doc)), doc.truth)
    check(doc.name, s)
    expect(s.recall).toBeGreaterThanOrEqual(0.8)
    expect(s.precision).toBeGreaterThanOrEqual(0.9)
  })

  it('prose without headings produces (almost) no headings', async () => {
    const doc = await noHeadings()
    const found = accepted(await detect(doc))
    check(doc.name, score(found, doc.truth))
    expect(found).toEqual([])
  })

  it('two-column paper: headings in both columns, in reading order, title kept out', async () => {
    const doc = await twoColumn()
    const found = accepted(await detect(doc))
    const s = score(found, doc.truth)
    check(doc.name, s)
    expect(s.recall).toBeGreaterThanOrEqual(0.9)
    expect(s.precision).toBeGreaterThanOrEqual(0.9)
    expect(found.map((f) => f.text)).toEqual(doc.truth.map((t) => t.text).filter((t) => found.some((f) => f.text === t)))
    for (const d of doc.decoys) expect(found.map((f) => f.text)).not.toContain(d)
    expect(found.find((f) => f.text === '3.1 Data Collection')!.level).toBe(2)
  })

  for (const order of ['visual', 'logical'] as const) {
    it(`Arabic right-to-left book (text stored in ${order} order)`, async () => {
      const doc = await arabicBook(order)
      const found = accepted(await detect(doc))
      const s = score(found, doc.truth)
      check(doc.name, s)
      expect(s.recall).toBeGreaterThanOrEqual(0.9)
      expect(s.precision).toBeGreaterThanOrEqual(0.9)
      expect(s.levelAccuracy).toBeGreaterThanOrEqual(0.9)
      for (const d of doc.decoys) expect(found.map((f) => f.text)).not.toContain(d)
      expect(found.some((f) => f.rtl)).toBe(true)
      // The destination sits at the heading's top on the right-hand side of the page.
      const first = found[0]
      expect(first.x).toBeGreaterThan(200)
    })
  }

  it('Chinese report: 第N章 chapters and numbered sections', async () => {
    const doc = await cjkReport()
    const s = score(accepted(await detect(doc)), doc.truth)
    check(doc.name, s)
    expect(s.recall).toBeGreaterThanOrEqual(0.85)
    expect(s.precision).toBeGreaterThanOrEqual(0.85)
  })

  it('summary: overall precision and recall at the default acceptance threshold', () => {
    const precision = totals.tp / totals.found
    const recall = totals.tp / totals.expected
    // Printed so the numbers can be quoted; asserted so a regression is caught.
    console.log(`\nHeading detection (confidence >= ${DEFAULT_ACCEPT}):\n  ${report.join('\n  ')}\n  TOTAL: precision ${(precision * 100).toFixed(1)}%  recall ${(recall * 100).toFixed(1)}%`)
    expect(precision).toBeGreaterThanOrEqual(0.93)
    expect(recall).toBeGreaterThanOrEqual(0.93)
  })
})

describe('heading detection: text as Chromium writes Arabic', () => {
  // Real /ToUnicode output of a Chromium "print to PDF" of an Arabic page: shaped presentation forms (U+FE70..FEFF),
  // stored in visual order (leftmost glyph first). Taken from an actual file, not made up.
  const VISUAL = {
    chapter1: 'ﻦﻣﻷا ﻦﻋ ﺔﻣﺪﻘﻣ :لوﻷا ﻞﺼﻔﻟا',
    chapter2: 'ﺔﯿﺳﺎﺳﻷا ﻢﯿھﺎﻔﻤﻟا :ﻲﻧﺎﺜﻟا ﻞﺼﻔﻟا',
    section1: 'ﺔﻣﺎﻋ ةﺮﻈﻧ 1.1',
    section2: 'ﻞﺼﻔﻟا فاﺪھأ 1.2',
    header: 'ﻲﻧاﺮﺒﯿﺴﻟا ﻦﻣﻷا بﺎﺘﻛ'
  }
  const run = (text: string, y: number, size: number, bold: boolean): RunLike => ({
    glyphs: Array.from(text).map((ch, i) => ({ text: ch, x0: 100 + i * size * 0.5, x1: 100 + (i + 1) * size * 0.5 })),
    baseline: y,
    y0: y - size * 0.2,
    y1: y + size * 0.8,
    size,
    bold,
    italic: false,
    fontKey: bold ? 'Tahoma-Bold' : 'Tahoma'
  })

  it('turns presentation forms back into letters, and keeps heading-sized text that repeats at the page foot', () => {
    const pages: PageText[] = []
    for (let c = 0; c < 3; c++) {
      const runs: RunLike[] = [run(VISUAL.header, 828, 6.7, false), run('1', 22, 6.7, false)]
      runs.push(run(c === 0 ? VISUAL.chapter1 : VISUAL.chapter2, 780, 26, true))
      for (let i = 0; i < 10; i++) runs.push(run('ﺐﻠط ﻞﻛ ﻦﻣ ﻖﻘﺤﺘﻟا ﻢﺘﻳو ةدﺪﺤﻣ تﺎﮫﺟاو ﺮﺒﻋ ةﺪﺣو ﻞﻛ ﻞﺻاﻮﺘﺗ ﺚﯿﺣ', 740 - i * 20, 12, false))
      runs.push(run(VISUAL.section1, 430, 17, true))
      for (let i = 0; i < 10; i++) runs.push(run('ﺐﻠط ﻞﻛ ﻦﻣ ﻖﻘﺤﺘﻟا ﻢﺘﻳو ةدﺪﺤﻣ تﺎﮫﺟاو ﺮﺒﻋ ةﺪﺣو ﻞﻛ ﻞﺻاﻮﺘﺗ ﺚﯿﺣ', 400 - i * 20 + (i > 6 ? -10 : 0), 12, false))
      runs.push(run(VISUAL.section2, 64, 17, true)) // inside the bottom 10 % of an A4 page, at the same height on every page
      pages.push({ pageIndex: c * 2 + 1, box: [0, 0, 595.92, 842.88], lines: buildLines(runs) })
    }
    const found = detectHeadings(pages).candidates.filter((c) => c.confidence >= 0.55)
    expect(found.map((c) => c.text)).toEqual([
      'الفصل الأول: مقدمة عن الأمن',
      '1.1 نظرة عامة',
      '1.2 أهداف الفصل',
      'الفصل الثاني: المفاهيم الأساسية',
      '1.1 نظرة عامة',
      '1.2 أهداف الفصل',
      'الفصل الثاني: المفاهيم الأساسية',
      '1.1 نظرة عامة',
      '1.2 أهداف الفصل'
    ])
    expect(found.map((c) => c.level)).toEqual([1, 2, 2, 1, 2, 2, 1, 2, 2])
    expect(found.some((c) => c.text.includes('كتاب'))).toBe(false) // the running header is gone
  })
})

describe('heading detection: pieces', () => {
  it('recognises numbering and keyword patterns in several scripts', () => {
    const kinds = (s: string): string | undefined => classify(s)?.kind
    expect(classify('1.2 Background')).toMatchObject({ kind: 'number', depth: 2, label: '1.2' })
    expect(classify('3. Results')).toMatchObject({ kind: 'number', depth: 1 })
    expect(classify('2.1.4 Deep')).toMatchObject({ kind: 'number', depth: 3 })
    expect(classify('١.٢ نظرة عامة')).toMatchObject({ kind: 'number', depth: 2, label: '1.2' })
    expect(kinds('IV. Discussion')).toBe('roman')
    expect(kinds('Chapter 3: Design')).toBe('keyword')
    expect(kinds('CHAPTER TWO')).toBe('keyword')
    expect(kinds('Appendix A')).toBe('keyword')
    expect(kinds('الفصل الأول: المقدمة')).toBe('keyword')
    expect(kinds('الباب الثاني')).toBe('keyword')
    expect(kinds('الفَصْلُ الثالث')).toBe('keyword') // with diacritics? (tashkeel is stripped first)
    expect(kinds('פרק ראשון')).toBe('keyword')
    expect(kinds('第三章 系统设计')).toBe('cjk')
    expect(kinds('Introduction')).toBe('standalone')
    expect(kinds('المراجع')).toBe('standalone')
    expect(kinds('This sentence merely mentions a section of the report in passing and goes on')).toBeUndefined()
    expect(classify('A. Preliminaries')).toMatchObject({ kind: 'letter' })
    expect(classify('Part II')).toMatchObject({ kind: 'keyword', partLike: true })
  })

  it('reorders visual right-to-left text into logical order, keeping numbers and Latin words intact', () => {
    const cases = ['الفصل الأول: مقدمة', '3.1 نظرة عامة', 'مرحبا (world) بالعالم 2024', 'פרק ראשון – מבוא', 'الأمن Security 2.0']
    for (const logical of cases) {
      expect(visualToLogical(toVisual(logical))).toBe(logical)
    }
    expect(visualToLogical('plain english')).toBe('plain english')
  })

  it('normalises text for spotting repeated headers (digits, case, diacritics)', () => {
    expect(normalizeForRepeat('Page 12 of 40')).toBe('page # of #')
    expect(normalizeForRepeat('صفحة ٣')).toBe('صفحة #')
    expect(normalizeForRepeat('اَلْكِتَابُ')).toBe(normalizeForRepeat('الكتاب'))
  })

  it('a document with no text or only a few lines never throws', () => {
    expect(detectHeadings([]).candidates).toEqual([])
    expect(detectHeadings([{ pageIndex: 0, box: [0, 0, 612, 792], lines: [] }]).candidates).toEqual([])
  })

  it('nesting never jumps more than one level down', () => {
    const mk = (level: number, i: number): HeadingCandidate => ({ id: i, pageIndex: 0, text: `h${i}`, level, confidence: 1, reasons: [], size: 12, bold: true, rtl: false, x: 0, top: 0 })
    const tree = nestHeadings([mk(1, 0), mk(2, 1), mk(2, 2), mk(1, 3), mk(2, 4)])
    expect(tree.map((n) => n.children.length)).toEqual([2, 1])
  })
})
