import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { buildPageText, type PageTextModel } from '../../../src/shared/pagetext'
import corpus from '../../fixtures/pagetext/corpus.json'

/** Shared helpers for the page text model tests (tests/unit/pagetext-*.test.ts). */

export { corpus }
export const FIXTURES = resolve('tests/fixtures/pagetext')

export const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)))
export const hasFixture = (name: string): boolean => existsSync(resolve(FIXTURES, name))

/** Documented comparison normalisation: Unicode NFC (canonical order of combining marks) and collapsed whitespace. */
export const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim()

export async function modelsOf(bytes: Uint8Array): Promise<PageTextModel[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  return pdf.getPages().map((_, i) => buildPageText(pdf, i))
}

export const linesOf = (m: PageTextModel): string[] => m.lines.map((l) => m.text.slice(l.start, l.end))

export const lineTexts = corpus.lines.map((l) => l.text)

/** What PDF.js (legacy build, the same library the app uses) extracts: items joined, one string per line break. */
export async function pdfjsText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true, standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replace(/\\/g, '/') + '/' })
  const doc = await task.promise
  try {
    let out = ''
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) out += (it.str ?? '') + (it.hasEOL ? '\n' : '')
      out += '\n'
    }
    return out
  } finally {
    await task.destroy()
  }
}
