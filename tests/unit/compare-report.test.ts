import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import type { ChangeText } from '../../src/renderer/src/features/compare/diff/enrich'
import type { Change, CompareResult } from '../../src/renderer/src/features/compare/diff/types'
import { buildReportPdf, changesToCsv, csvBytes, csvCell, reportRows, toWinAnsi } from '../../src/renderer/src/features/compare/report'
import { flattenText, readPdf } from '../support/pdfText'
import { opts } from './helpers/compareItems'

const loc = (page: number, pair = page - 1): NonNullable<Change['old']> => ({ pair, page, parts: [[0, 1]], span: [0, 1] })
const changes: Change[] = [
  { id: 0, kind: 'modified', pair: 0, old: loc(1), new: loc(1) },
  { id: 1, kind: 'removed', pair: 1, old: loc(2) },
  { id: 2, kind: 'added', pair: 2, new: loc(3) },
  { id: 3, kind: 'moved', pair: 2, old: loc(1), new: loc(3), edited: true }
]
const texts: ChangeText[] = [
  { oldText: '12.5%', newText: '15.5%', oldMarks: [], newMarks: [], before: '', after: '' },
  { oldText: 'This sentence, with "quotes" and\na newline', newText: '', oldMarks: [], newMarks: [], before: '', after: '' },
  { oldText: '', newText: '=HYPERLINK("http://evil","x")', oldMarks: [], newMarks: [], before: '', after: '' },
  { oldText: 'moved text here', newText: 'moved text here!', oldMarks: [], newMarks: [], before: '', after: '' }
]
const result: CompareResult = {
  changes,
  counts: { added: 1, removed: 1, modified: 1, moved: 1, total: 4 },
  changedPairs: 3,
  pairs: [
    { old: 1, new: 1, similarity: 0.9, moved: false, changes: 2 },
    { old: 2, new: null, similarity: 0, moved: false, changes: 1 },
    { old: null, new: 3, similarity: 0, moved: false, changes: 2 }
  ]
}

describe('CSV export', () => {
  it('quotes commas, quotes and line breaks; one row per change', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('line1 line2')
  })

  it('neutralises spreadsheet formulas but keeps plain negative numbers', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell('+1+1')).toBe("'+1+1")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('-5')).toBe('-5')
    expect(csvCell('-3.50')).toBe('-3.50')
    expect(csvCell('')).toBe('')
  })

  it('has a header, a BOM, CRLF line ends and the right columns', () => {
    const csv = changesToCsv(result, texts)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe('Change,Type,Old page,New page,Old text,New text,Note')
    expect(lines).toHaveLength(6) // header + 4 rows + trailing empty
    expect(lines[1]).toBe('1,Modified,1,1,12.5%,15.5%,')
    expect(lines[2]).toBe('2,Removed,2,,"This sentence, with ""quotes"" and a newline",,')
    expect(lines[3]).toBe('3,Added,,3,,"\'=HYPERLINK(""http://evil"",""x"")",')
    expect(lines[4]).toBe('4,Moved,1,3,moved text here,moved text here!,Moved and edited')
    const bytes = csvBytes(result, texts)
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]) // UTF-8 BOM, so Excel reads accents correctly
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toBe(csv)
  })

  it('reportRows numbers changes from 1', () => {
    expect(reportRows(result, texts).map((r) => r.number)).toEqual([1, 2, 3, 4])
  })

  it('an empty comparison is just the header', () => {
    expect(changesToCsv({ ...result, changes: [], counts: { added: 0, removed: 0, modified: 0, moved: 0, total: 0 } }, [])).toBe(String.fromCharCode(0xfeff) + 'Change,Type,Old page,New page,Old text,New text,Note\r\n')
  })
})

describe('PDF report', () => {
  it('is a valid PDF listing every change by page, with words for the kinds (not just colours)', async () => {
    const bytes = await buildReportPdf({ oldName: 'old.pdf', newName: 'new.pdf', result, texts, opts: opts({ ignoreCase: true }), generatedAt: new Date('2026-01-02T03:04:00Z'), visualPages: [{ old: 2, new: 2 }] })
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getTitle()).toBe('Epdf comparison report')
    expect(pdf.getPageCount()).toBe(1)
    const { pages } = await readPdf(bytes)
    const text = flattenText(pages)
    expect(text).toContain('Comparison report')
    expect(text).toContain('Old version: old.pdf')
    expect(text).toContain('New version: new.pdf')
    expect(text).toContain('4 changes: 1 added, 1 removed, 1 modified, 1 moved.')
    expect(text).toContain('Ignored while comparing: case.')
    expect(text).toContain('Visual differences')
    for (const label of ['[~] MODIFIED', '[-] REMOVED', '[+] ADDED', '[>] MOVED']) expect(text).toContain(label)
    expect(text).toContain('12.5%')
    expect(text).toContain('15.5%')
    expect(text).toContain('Page 1')
    expect(text).toContain('page 1 to page 3, edited')
    expect(text).toContain('Page 1 of 1')
  })

  it('paginates a long list and never overflows the margins', async () => {
    const many: Change[] = Array.from({ length: 300 }, (_, i) => ({ id: i, kind: 'modified', pair: 0, old: loc(1 + (i % 9)), new: loc(1 + (i % 9)) }))
    const t: ChangeText[] = many.map((_, i) => ({ oldText: `old value ${i} ` + 'word '.repeat(40), newText: 'Supercalifragilisticexpialidocious'.repeat(8) + i, oldMarks: [], newMarks: [], before: '', after: '' }))
    const bytes = await buildReportPdf({ oldName: 'a.pdf', newName: 'b.pdf', result: { ...result, changes: many, counts: { added: 0, removed: 0, modified: 300, moved: 0, total: 300 } }, texts: t, opts: opts() })
    const { pages } = await readPdf(bytes)
    expect(pages.length).toBeGreaterThan(5)
    for (const p of pages) for (const it of p.items) expect(it.x + it.w).toBeLessThan(p.width - 30)
    expect(flattenText(pages)).toContain('#300')
  })

  it('text outside the standard font\'s alphabet prints as "?" instead of failing', async () => {
    const t: ChangeText[] = [{ oldText: 'Привет мир 日本語 ok', newText: 'naïve café – “quoted”', oldMarks: [], newMarks: [], before: '', after: '' }]
    const bytes = await buildReportPdf({
      oldName: 'файл.pdf',
      newName: 'new.pdf',
      result: { ...result, changes: [{ id: 0, kind: 'modified', pair: 0, old: loc(1), new: loc(1) }], counts: { added: 0, removed: 0, modified: 1, moved: 0, total: 1 } },
      texts: t,
      opts: opts()
    })
    const text = flattenText((await readPdf(bytes)).pages)
    expect(text).toContain('?????? ??? ??? ok')
    expect(text).toContain('naïve café')
  })

  it('an empty comparison says the text is identical', async () => {
    const bytes = await buildReportPdf({ oldName: 'a.pdf', newName: 'b.pdf', result: { pairs: [], changes: [], counts: { added: 0, removed: 0, modified: 0, moved: 0, total: 0 }, changedPairs: 0 }, texts: [], opts: opts() })
    const text = flattenText((await readPdf(bytes)).pages)
    expect(text).toContain('No text differences.')
    expect(text).toContain('identical text')
  })

  it('toWinAnsi keeps encodable text and replaces the rest', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont('Helvetica')
    expect(toWinAnsi('Grüße €5 – ok', font)).toBe('Grüße €5 – ok')
    expect(toWinAnsi('a‑b', font)).toBe('a-b')
    expect(toWinAnsi('日本', font)).toBe('??')
  })
})
