import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { ChangeText } from './diff/enrich'
import { KIND_LABEL, primaryPage } from './diff/summary'
import type { Change, ChangeKind, CompareCounts, CompareOptions, CompareResult } from './diff/types'

/** Exports of a comparison: the change list as CSV and as a PDF report (pdf-lib). */

export interface ReportInput {
  oldName: string
  newName: string
  result: CompareResult
  texts: ChangeText[]
  opts: CompareOptions
  /** When the visual scan ran: the page pairs (new page numbers) that differ visually. */
  visualPages?: { old: number | null; new: number | null }[] | null
  /** Text of the report's date line; injected so tests are deterministic. */
  generatedAt?: Date
}

export interface ReportRow {
  number: number
  type: string
  oldPage: string
  newPage: string
  oldText: string
  newText: string
  note: string
}

const kindNote = (c: Change): string => (c.kind === 'moved' ? (c.edited ? 'Moved and edited' : 'Moved') : '')

/** One row per change, numbered from 1 in list order. */
export function reportRows(result: CompareResult, texts: ChangeText[]): ReportRow[] {
  return result.changes.map((c) => ({
    number: c.id + 1,
    type: KIND_LABEL[c.kind],
    oldPage: c.old ? String(c.old.page) : '',
    newPage: c.new ? String(c.new.page) : '',
    oldText: texts[c.id]?.oldText ?? '',
    newText: texts[c.id]?.newText ?? '',
    note: kindNote(c)
  }))
}

/**
 * A spreadsheet that opens a CSV cell starting with = + - @ as a formula; text from a PDF is untrusted, so such
 * cells get a leading apostrophe (a plain "-5" or "+3" stays a number).
 */
export function csvCell(value: string): string {
  let v = value.replace(/\r\n|\r|\n/g, ' ')
  if (/^[=+@\t]/.test(v) || /^-(?![\d.,]+$)/.test(v)) v = `'${v}`
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export const CSV_HEADER = ['Change', 'Type', 'Old page', 'New page', 'Old text', 'New text', 'Note']

/** The change list as CSV (UTF-8 with a byte-order mark so Excel reads accents and CJK correctly; CRLF line ends). */
export function changesToCsv(result: CompareResult, texts: ChangeText[]): string {
  const lines = [CSV_HEADER.join(',')]
  for (const r of reportRows(result, texts)) {
    lines.push([String(r.number), r.type, r.oldPage, r.newPage, r.oldText, r.newText, r.note].map(csvCell).join(','))
  }
  return String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n'
}

export const csvBytes = (result: CompareResult, texts: ChangeText[]): Uint8Array => new TextEncoder().encode(changesToCsv(result, texts))

// ---- PDF report -----------------------------------------------------------------------------------------------

const PAGE_W = 595.28
const PAGE_H = 841.89
const MARGIN = 48
const BODY = 9.5
const LEAD = 13

/** Standard fonts only cover WinAnsi: anything else prints as "?" instead of failing the whole report. */
export function toWinAnsi(text: string, font: PDFFont): string {
  const ok = new Set(font.getCharacterSet())
  let out = ''
  for (const ch of text.replace(/\s+/g, ' ')) {
    const cp = ch.codePointAt(0)!
    out += ok.has(cp) ? ch : cp === 0x2011 || cp === 0x2010 ? '-' : '?'
  }
  return out
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    let w = word
    // A single very long word is broken so it can never overflow the margin.
    while (font.widthOfTextAtSize(w, size) > width) {
      let cut = w.length - 1
      while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--
      if (line) {
        out.push(line)
        line = ''
      }
      out.push(w.slice(0, cut))
      w = w.slice(cut)
    }
    const candidate = line ? `${line} ${w}` : w
    if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate
    else {
      out.push(line)
      line = w
    }
  }
  if (line || out.length === 0) out.push(line)
  return out
}

const MAX_TEXT = 700
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)

const KIND_COLOR: Record<ChangeKind, [number, number, number]> = {
  removed: [0.78, 0.1, 0.1],
  added: [0.05, 0.5, 0.2],
  modified: [0.75, 0.5, 0],
  moved: [0.2, 0.3, 0.75]
}
const KIND_MARK: Record<ChangeKind, string> = { removed: '[-] REMOVED', added: '[+] ADDED', modified: '[~] MODIFIED', moved: '[>] MOVED' }

function countLine(c: CompareCounts): string {
  if (c.total === 0) return 'No text differences.'
  return `${c.total} ${c.total === 1 ? 'change' : 'changes'}: ${c.added} added, ${c.removed} removed, ${c.modified} modified, ${c.moved} moved.`
}

function optionsLine(o: CompareOptions): string {
  const on = [o.ignoreCase && 'case', o.ignorePunctuation && 'punctuation', o.ignoreWhitespace && 'spacing'].filter(Boolean)
  return on.length ? `Ignored while comparing: ${on.join(', ')}.` : 'Comparison is exact (case, punctuation and spacing count).'
}

/** Supplies the bytes of a Unicode font (Noto Sans) when the report has text that WinAnsi cannot hold. */
export type FontProvider = () => Promise<Uint8Array>


/**
 * A PDF report listing the changes page by page. Text that the standard Helvetica cannot encode (Greek, Cyrillic,
 * ...) is set in the bundled Noto Sans when `unicodeFont` is given; characters not even that font has (CJK) print
 * as "?" - a wrong glyph is better than a report that fails to build.
 */
export async function buildReportPdf(input: ReportInput, unicodeFont?: FontProvider): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const helvetica = await doc.embedFont(StandardFonts.Helvetica)
  const encodable = new Set(helvetica.getCharacterSet())
  const needsUnicode = [input.oldName, input.newName, ...input.texts.flatMap((t) => [t.oldText, t.newText])].some((s) => Array.from(s.replace(/\s+/g, ' ')).some((ch) => !encodable.has(ch.codePointAt(0)!)))
  let uni: PDFFont | null = null
  if (unicodeFont && needsUnicode) {
    try {
      doc.registerFontkit(fontkit)
      uni = await doc.embedFont(await unicodeFont(), { subset: true })
    } catch (err) {
      console.warn('Compare: the Unicode font for the report could not be loaded', err)
    }
  }
  const font = uni ?? helvetica
  const bold = uni ?? (await doc.embedFont(StandardFonts.HelveticaBold))
  const mono = uni ?? (await doc.embedFont(StandardFonts.Courier))
  const when = input.generatedAt ?? new Date()
  doc.setTitle('Epdf comparison report')
  doc.setProducer('Epdf')
  doc.setCreator('Epdf')
  doc.setCreationDate(when)
  doc.setModificationDate(when)
  doc.setSubject(`${input.oldName} compared with ${input.newName}`)

  const pages: PDFPage[] = []
  let page!: PDFPage
  let y = 0
  const ink = rgb(0.1, 0.1, 0.12)
  const muted = rgb(0.35, 0.37, 0.4)
  const newPage = (): void => {
    page = doc.addPage([PAGE_W, PAGE_H])
    pages.push(page)
    y = PAGE_H - MARGIN
  }
  const need = (h: number): void => {
    if (y - h < MARGIN + 16) newPage()
  }
  const text = (s: string, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; x?: number } = {}): void => {
    page.drawText(toWinAnsi(s, o.f ?? font), { x: o.x ?? MARGIN, y, size: o.size ?? BODY, font: o.f ?? font, color: o.color ?? ink })
  }
  const paragraph = (s: string, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; width?: number } = {}): void => {
    const size = o.size ?? BODY
    const f = o.f ?? font
    for (const line of wrap(toWinAnsi(s, f), f, size, o.width ?? PAGE_W - 2 * MARGIN - (o.x ? o.x - MARGIN : 0))) {
      need(LEAD)
      y -= LEAD
      text(line, { ...o, size, f })
    }
  }

  newPage()
  y -= 22
  text('Comparison report', { size: 22, f: bold })
  y -= 26
  paragraph(`Old version: ${input.oldName}`, { size: 11 })
  paragraph(`New version: ${input.newName}`, { size: 11 })
  paragraph(`Created ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC by Epdf`, { color: muted })
  paragraph(optionsLine(input.opts), { color: muted })
  y -= 8
  paragraph(countLine(input.result.counts), { size: 12, f: bold })
  const { pairs } = input.result
  const added = pairs.filter((p) => p.old === null).length
  const removed = pairs.filter((p) => p.new === null).length
  const moved = pairs.filter((p) => p.moved).length
  paragraph(`Pages: ${pairs.filter((p) => p.old !== null).length} old, ${pairs.filter((p) => p.new !== null).length} new; ${added} added, ${removed} removed, ${moved} moved.`)
  if (input.visualPages) {
    paragraph(
      input.visualPages.length
        ? `Visual differences (images, graphics, layout) on ${input.visualPages.length} page pair${input.visualPages.length === 1 ? '' : 's'}: ${input.visualPages
            .map((p) => (p.old !== null && p.new !== null && p.old !== p.new ? `${p.old}/${p.new}` : String(p.new ?? p.old)))
            .join(', ')}.`
        : 'No visual differences were found.'
    )
  }
  y -= 10

  // Changes grouped by page (new page, else old page).
  const byPage = new Map<number, Change[]>()
  for (const c of input.result.changes) byPage.set(primaryPage(c), [...(byPage.get(primaryPage(c)) ?? []), c])
  for (const [pageNo, list] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    need(LEAD * 4)
    y -= 6
    y -= LEAD + 2
    text(`Page ${pageNo}`, { size: 12, f: bold })
    page.drawLine({ start: { x: MARGIN, y: y - 3 }, end: { x: PAGE_W - MARGIN, y: y - 3 }, thickness: 0.6, color: muted })
    y -= 4
    for (const c of list) {
      const t = input.texts[c.id]
      const col = KIND_COLOR[c.kind]
      need(LEAD * 3)
      y -= LEAD + 3
      const head = `#${c.id + 1}  ${KIND_MARK[c.kind]}${c.kind === 'moved' ? ` (page ${c.old?.page} to page ${c.new?.page}${c.edited ? ', edited' : ''})` : ''}`
      const top = y
      const startPage = page
      text(head, { f: bold, color: rgb(col[0], col[1], col[2]), x: MARGIN + 8 })
      const body: [string, string][] = []
      if (c.kind === 'removed') body.push(['Old', t?.oldText ?? ''])
      else if (c.kind === 'added') body.push(['New', t?.newText ?? ''])
      else {
        body.push(['Old', t?.oldText ?? ''])
        body.push(['New', t?.newText ?? ''])
      }
      for (const [label, value] of body) {
        const lines = wrap(toWinAnsi(clip(value), mono), mono, BODY - 0.5, PAGE_W - 2 * MARGIN - 44)
        need(LEAD)
        y -= LEAD
        text(label, { x: MARGIN + 8, color: muted })
        lines.forEach((line, i) => {
          if (i > 0) {
            need(LEAD)
            y -= LEAD
          }
          text(line, { f: mono, size: BODY - 0.5, x: MARGIN + 44 })
        })
      }
      // A coloured bar next to the entry (the words above carry the meaning; the bar is decoration).
      if (page === startPage) page.drawRectangle({ x: MARGIN, y: y - 3, width: 3, height: top - y + LEAD, color: rgb(col[0], col[1], col[2]) })
    }
  }
  if (input.result.changes.length === 0) paragraph('The two documents have identical text.', { size: 11 })

  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`
    p.drawText(label, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, 8), y: 26, size: 8, font, color: muted })
    p.drawText(toWinAnsi(`${input.oldName} vs ${input.newName}`.slice(0, 110), font), { x: MARGIN, y: 26, size: 8, font, color: muted })
  })
  return doc.save()
}
