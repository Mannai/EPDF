import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { MARKER_NEEDLE, embedMarker, hasMarker, makeProtection } from '../../src/renderer/src/features/security/crypto/document'
import { extractPages } from '../../src/shared/features/pages/pdfOps'
import { preparePrintPdf } from '../../src/shared/features/print/prepare'
import { fixtureBytes, openWith } from './helpers/securityHelpers'

/**
 * Security keeps an in-memory "protection marker" (which holds the file key) inside the plaintext working copy of
 * an unlocked, password-protected document, so saving can re-encrypt it. That marker must NEVER leave the app in
 * any file the user did not save as the protected document itself. Every feature that derives a NEW file from
 * the working copy (extract pages, split, Print to PDF, ...) must therefore strip it. This test builds a genuine
 * marker-carrying working copy from a qpdf-made encrypted fixture and runs those derivations.
 */

const NEEDLES = [MARKER_NEEDLE, 'EpdfSecurity']

async function markedWorkingCopy(): Promise<Uint8Array> {
  const opened = await openWith(fixtureBytes('aes-256-r6'), 'user256')
  const pdf = await PDFDocument.load(opened.plain, { updateMetadata: false })
  embedMarker(pdf, await makeProtection(pdf, { algorithm: 'aes256', userPassword: 'user256', ownerPassword: 'owner256', P: -4, encryptMetadata: true }))
  return pdf.save()
}

const leaked = (bytes: Uint8Array): string[] => {
  const text = Buffer.from(bytes).toString('latin1')
  return NEEDLES.filter((n) => text.includes(n))
}

describe('the protection marker never leaks into derived files', () => {
  it('sanity: the working copy really carries the marker (so the checks below are meaningful)', async () => {
    const bytes = await markedWorkingCopy()
    expect(hasMarker(bytes)).toBe(true)
    expect(leaked(bytes).length).toBeGreaterThan(0)
  })

  it('Extract Pages / Split (extractPages) produce files without the marker', async () => {
    const bytes = await markedWorkingCopy()
    const out = await extractPages(bytes, [0, 1])
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2)
    expect(leaked(out)).toEqual([])
  })

  it('Print to PDF (preparePrintPdf) produces a file without the marker', async () => {
    const bytes = await markedWorkingCopy()
    const out = await preparePrintPdf(bytes, { pages: [0, 1, 2], annotations: true })
    expect((await PDFDocument.load(out)).getPageCount()).toBeGreaterThan(0)
    expect(leaked(out)).toEqual([])
  })
})
