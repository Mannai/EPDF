import { PDFName, PDFRef, type PDFDocument } from 'pdf-lib'

/**
 * Catalog key under which the Security feature keeps its in-memory "protection marker" inside the plaintext
 * working copy of an unlocked, password-protected document. The marker holds the file's encryption key and
 * parameters so that saving the SAME document can re-encrypt it. It is not part of any real PDF.
 */
export const PROTECTION_MARKER_KEY = 'EpdfSecurity'

/**
 * Removes the protection marker (and its stream) from a document. Call this on every NEW file derived from a
 * document's working copy — extracted or split pages, Print to PDF, exports — because that file is not the
 * protected document and must never carry its encryption key. Do NOT call it on in-place edits of the document
 * itself: the marker is what makes Save re-encrypt. Returns true if a marker was present.
 */
export function stripProtectionMarker(pdf: PDFDocument): boolean {
  const key = PDFName.of(PROTECTION_MARKER_KEY)
  const value = pdf.catalog.get(key)
  if (value === undefined) return false
  pdf.catalog.delete(key)
  if (value instanceof PDFRef) pdf.context.delete(value)
  return true
}
