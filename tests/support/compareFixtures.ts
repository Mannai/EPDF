import fontkit from '@pdf-lib/fontkit'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PDFDocument, PDFHexString, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { makePng, solid } from './images'

/**
 * Fixture pairs for the compare feature, built with pdf-lib so every position is known exactly.
 * Page size is US Letter (612 x 792). `y` values below are PDF coordinates (origin bottom-left).
 */

export const PAGE_W = 612
export const PAGE_H = 792
export const SIZE = 12
export const LEAD = 16

export const S = {
  revenueOld: 'Revenue grew by 12.5% in 2023 to 4,300 units across all of the regions we serve.',
  revenueNew: 'Revenue grew by 15.5% in 2023 to 4,300 units across all of the regions we serve.',
  committeeOld: 'The committee met on Monday to review the annual budget and agreed that spending on travel should be reduced.',
  committeeNew: 'The committee met on Tuesday to review the annual budget and agreed that spending on travel should be reduced.',
  removed: 'This sentence will be removed entirely from the final version of the document.',
  added: 'A brand new paragraph was added to explain the revised schedule for the coming year.',
  moved: 'The warehouse in Rotterdam will close at the end of the quarter and its inventory will be transferred to the main distribution centre.',
  intro: 'Welcome to the annual review. This document summarises the results, the decisions taken by the board and the plans for the next twelve months.',
  filler: 'All figures are unaudited and expressed in thousands of euros unless stated otherwise. Comparatives have been restated where necessary.'
}

export interface Ctx {
  doc: PDFDocument
  font: PDFFont
  bold: PDFFont
}

/** The lines `para` breaks a paragraph into. */
export function wrapLines(font: PDFFont, text: string, maxWidth = 468, size = SIZE): string[] {
  const lines: string[] = []
  let cur = ''
  for (const w of text.split(' ')) {
    const next = cur ? `${cur} ${w}` : w
    if (font.widthOfTextAtSize(next, size) > maxWidth && cur) {
      lines.push(cur)
      cur = w
    } else cur = next
  }
  if (cur) lines.push(cur)
  return lines
}

/** Draws wrapped text; returns the y below the paragraph. Each line is one text run (one PDF.js item). */
export function para(page: PDFPage, font: PDFFont, text: string, x: number, y: number, maxWidth = 468, size = SIZE): number {
  const lines = wrapLines(font, text, maxWidth, size)
  for (const l of lines) {
    page.drawText(l, { x, y, size, font })
    y -= LEAD
  }
  return y - LEAD * 0.6
}

async function ctx(): Promise<Ctx> {
  const doc = await PDFDocument.create()
  return { doc, font: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) }
}

export interface BookOptions {
  /** Build the NEW version. */
  next: boolean
}

/**
 * The "report" pair. Differences of the new version against the old one:
 *   page 1: "12.5%" -> "15.5%" (modified), the Rotterdam paragraph is gone from this page,
 *   page 2: "Monday" -> "Tuesday" (modified), one sentence removed, one paragraph added, the Rotterdam paragraph
 *           appears here (moved, from page 1),
 *   an appendix page is inserted after page 2 (added page; it becomes new page 3),
 *   old page 3 / new page 4: two columns; in the RIGHT column "quarterly" -> "monthly" (modified),
 *   the old page 4 is deleted (removed page).
 * Exact counts: 3 modified, 2 removed (sentence + old page 4), 2 added (paragraph + appendix), 1 moved = 8.
 */
export async function reportBook({ next }: BookOptions): Promise<Uint8Array> {
  const { doc, font, bold } = await ctx()
  const p1 = doc.addPage([PAGE_W, PAGE_H])
  p1.drawText('Annual review', { x: 72, y: 720, size: 24, font: bold })
  let y = para(p1, font, S.intro, 72, 680)
  y = para(p1, font, next ? S.revenueNew : S.revenueOld, 72, y)
  y = para(p1, font, S.filler, 72, y)
  if (!next) para(p1, font, S.moved, 72, y)

  const p2 = doc.addPage([PAGE_W, PAGE_H])
  p2.drawText('Decisions', { x: 72, y: 720, size: 20, font: bold })
  y = para(p2, font, next ? S.committeeNew : S.committeeOld, 72, 680)
  if (!next) y = para(p2, font, S.removed, 72, y)
  y = para(p2, font, 'The board also thanked the finance team for delivering the closing process two days ahead of the plan.', 72, y)
  if (next) y = para(p2, font, S.added, 72, y)
  y = para(p2, font, 'Next steps are to finalise the hiring plan, to confirm the supplier contracts and to publish the updated policy.', 72, y)
  if (next) para(p2, font, S.moved, 72, y)

  if (next) {
    const ap = doc.addPage([PAGE_W, PAGE_H])
    ap.drawText('Appendix', { x: 72, y: 720, size: 20, font: bold })
    para(ap, font, 'The appendix lists the glossary of terms used in this review together with the definitions agreed by the audit committee.', 72, 680)
  }

  const p3 = doc.addPage([PAGE_W, PAGE_H])
  p3.drawText('Regional notes', { x: 72, y: 720, size: 20, font: bold })
  const left = [
    'North region: sales were steady across',
    'all product lines and the new store in',
    'Utrecht opened on schedule in March.',
    'Customer satisfaction stayed above',
    'the target for the second quarter in a row.'
  ]
  const right = [
    'South region: the quarterly review of',
    'suppliers identified three contracts',
    next ? 'that need to be renegotiated before' : 'that need to be renegotiated before',
    'the end of the year, and one supplier',
    'was replaced with a local partner.'
  ]
  if (next) right[0] = 'South region: the monthly review of'
  left.forEach((l, i) => p3.drawText(l, { x: 60, y: 680 - i * LEAD, size: SIZE, font }))
  right.forEach((l, i) => p3.drawText(l, { x: 330, y: 680 - i * LEAD, size: SIZE, font }))
  para(p3, font, 'Footnote: both columns are reproduced from the regional managers reports without changes.', 72, 560)

  if (!next) {
    const p4 = doc.addPage([PAGE_W, PAGE_H])
    p4.drawText('Superseded page', { x: 72, y: 720, size: 20, font: bold })
    para(p4, font, 'This page contains the transitional arrangements that no longer apply and will not be part of the next release.', 72, 680)
  }
  return doc.save()
}

/** Where the report fixtures draw the changed words (PDF points, origin bottom-left), for geometry checks. */
export async function wordRect(font: PDFFont, line: string, word: string, x: number, baselineY: number, size = SIZE): Promise<{ x0: number; x1: number; baseline: number }> {
  const at = line.indexOf(word)
  const x0 = x + plainWidth(font, line.slice(0, at), size)
  return { x0, x1: x0 + plainWidth(font, word, size), baseline: baselineY }
}

/**
 * Advance width without kerning. pdf-lib's widthOfTextAtSize applies kerning pairs, but drawText writes a plain
 * `Tj` string, so a reader lays the glyphs out WITHOUT kerning: sum the single-character widths instead.
 */
export const plainWidth = (font: PDFFont, text: string, size = SIZE): number => Array.from(text).reduce((s, ch) => s + font.widthOfTextAtSize(ch, size), 0)

/** Two documents whose text is identical but whose pictures/graphics differ (a red vs a blue logo and rule). */
export async function visualPair(next: boolean): Promise<Uint8Array> {
  const { doc, font } = await ctx()
  const page = doc.addPage([PAGE_W, PAGE_H])
  para(page, font, S.intro, 72, 700)
  const png = await doc.embedPng(makePng(40, 40, next ? solid(0, 60, 220) : solid(220, 30, 30)))
  page.drawImage(png, { x: 72, y: 500, width: 120, height: 120 })
  page.drawRectangle({ x: 72, y: 460, width: 300, height: 10, color: next ? rgb(0, 0, 0) : rgb(0.6, 0.6, 0.6) })
  para(page, font, S.filler, 72, 430)
  return doc.save()
}

const VOCAB = ['ledger', 'account', 'balance', 'invoice', 'supplier', 'contract', 'payment', 'forecast', 'budget', 'audit', 'report', 'policy', 'review', 'schedule', 'delivery', 'quarter', 'margin', 'revenue', 'expense', 'asset', 'liability', 'reserve', 'tax', 'growth', 'target', 'variance', 'summary', 'approval', 'record', 'process']

/**
 * N dense pages (60 lines of about fifteen words each, all different); every page in `edited` gets one changed word, so
 * the two versions differ on exactly those pages. Dense enough that reading 2 x 500 pages takes a few seconds.
 */
export async function largeBook(pages: number, edited: number[] = []): Promise<Uint8Array> {
  const { doc, font } = await ctx()
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([PAGE_W, PAGE_H])
    p.drawText(`Large comparison page ${i}`, { x: 72, y: 760, size: 18, font })
    let seed = i * 2654435761
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    for (let line = 0; line < 60; line++) {
      const words = Array.from({ length: 12 }, () => VOCAB[Math.floor(next() * VOCAB.length)])
      if (edited.includes(i) && line === 7) words[4] = 'EDITED'
      p.drawText(`Line ${line + 1} of ${i}: ${words.join(' ')} ref ${i * 100 + line}`, { x: 50, y: 735 - line * 11.6, size: 9, font })
    }
  }
  return doc.save()
}

/** The same sentence with different case and punctuation; only the ignore-case / ignore-punctuation modes see it as equal. */
export async function caseBook(next: boolean): Promise<Uint8Array> {
  const { doc, font } = await ctx()
  const page = doc.addPage([PAGE_W, PAGE_H])
  para(page, font, next ? 'the quick brown fox jumps over the lazy dog while the cat sleeps on the warm windowsill all afternoon' : 'The Quick Brown Fox, jumps over the Lazy Dog. While the cat sleeps on the warm windowsill, all afternoon!', 72, 700)
  return doc.save()
}

/** Text in scripts outside WinAnsi (Cyrillic), set in an embedded Noto Sans, so extraction, tokenising and the report are exercised. */
export async function unicodeBook(next: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(readFileSync(resolve('src/renderer/src/features/textedit/fonts/NotoSans-Regular.ttf')), { subset: false })
  const page = doc.addPage([PAGE_W, PAGE_H])
  const text = `Квартальный отчёт: продажи выросли на ${next ? 'двадцать' : 'десять'} процентов по сравнению с прошлым годом, а расходы остались прежними.`
  para(page, font, text, 72, 700)
  return doc.save()
}

/** A PDF with an /Encrypt dictionary PDF.js cannot open without the (unknown) password. */
export async function fakeEncrypted(): Promise<Uint8Array> {
  const { doc, font } = await ctx()
  const page = doc.addPage([PAGE_W, PAGE_H])
  page.drawText('secret', { x: 72, y: 700, size: 12, font })
  const enc = doc.context.register(
    doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4, O: PDFHexString.of('01'.repeat(32)), U: PDFHexString.of('02'.repeat(32)) })
  )
  doc.context.trailerInfo.Encrypt = enc
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of('aa'.repeat(16)), PDFHexString.of('aa'.repeat(16))])
  return doc.save()
}

/** Writes the standard fixture set into `dir`. */
export async function writeCompareFixtures(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cmp-report-old.pdf'), await reportBook({ next: false }))
  writeFileSync(join(dir, 'cmp-report-new.pdf'), await reportBook({ next: true }))
  writeFileSync(join(dir, 'cmp-report-copy.pdf'), await reportBook({ next: false }))
  writeFileSync(join(dir, 'cmp-visual-old.pdf'), await visualPair(false))
  writeFileSync(join(dir, 'cmp-visual-new.pdf'), await visualPair(true))
  writeFileSync(join(dir, 'cmp-large-old.pdf'), await largeBook(500))
  writeFileSync(join(dir, 'cmp-large-new.pdf'), await largeBook(500, [50, 250, 450]))
  writeFileSync(join(dir, 'cmp-case-old.pdf'), await caseBook(false))
  writeFileSync(join(dir, 'cmp-case-new.pdf'), await caseBook(true))
  writeFileSync(join(dir, 'cmp-unicode-old.pdf'), await unicodeBook(false))
  writeFileSync(join(dir, 'cmp-unicode-new.pdf'), await unicodeBook(true))
  writeFileSync(join(dir, 'cmp-broken.pdf'), 'this is definitely not a PDF file')
  writeFileSync(join(dir, 'cmp-encrypted.pdf'), await fakeEncrypted())
}
