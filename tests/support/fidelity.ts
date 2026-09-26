import type { PdfPageText } from './pdfText'

/**
 * Layout-fidelity numbers for the LibreOffice comparison tests (logged, so a change to the converter can be judged
 * before/after). `lineAgreement` is the share of LibreOffice's text lines (whitespace collapsed) that our PDF also has
 * as a whole line: it drops as soon as line breaks move, so it is far more sensitive than a word overlap.
 */

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

export function linesOf(pages: PdfPageText[]): string[] {
  const out: string[] = []
  for (const p of pages) for (const l of p.text.split('\n')) if (norm(l)) out.push(norm(l))
  return out
}

export function lineAgreement(ours: PdfPageText[], reference: PdfPageText[]): number {
  const mine = new Map<string, number>()
  for (const l of linesOf(ours)) mine.set(l, (mine.get(l) ?? 0) + 1)
  const ref = linesOf(reference)
  let hit = 0
  for (const l of ref) {
    const n = mine.get(l) ?? 0
    if (n > 0) {
      hit++
      mine.set(l, n - 1)
    }
  }
  return ref.length ? hit / ref.length : 1
}

export function logFidelity(label: string, ours: PdfPageText[], reference: PdfPageText[], jaccard?: number): void {
  const la = lineAgreement(ours, reference)
  console.log(`[fidelity] ${label}: pages built-in=${ours.length} LibreOffice=${reference.length}; lines equal=${(la * 100).toFixed(1)}%${jaccard === undefined ? '' : `; word jaccard=${jaccard.toFixed(3)}`}`)
}
