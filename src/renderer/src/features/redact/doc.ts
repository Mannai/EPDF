import { PDFDocument } from 'pdf-lib'
import { currentBytes, ensureEditable } from '../../edit/session'
import { useTabs } from '../../state/tabs'
import { extractPageText, type PageTextModel } from './logic/extract'

/**
 * The document as pdf-lib sees it, parsed once per version of its bytes (edits replace the bytes), plus the text
 * model of each page (text with glyph geometry) that marking by selection and search work from.
 */

interface Entry {
  bytes: Uint8Array
  doc: Promise<PDFDocument>
  models: Map<number, PageTextModel>
}

const entries = new Map<string, Entry>()

/** Null when the document is encrypted and the user declined to unlock it. */
export async function pdfFor(docId: string): Promise<{ pdf: PDFDocument; bytes: Uint8Array } | null> {
  if (!(await ensureEditable(docId))) return null
  const bytes = await currentBytes(docId)
  let e = entries.get(docId)
  if (!e || e.bytes !== bytes) {
    e = { bytes, doc: PDFDocument.load(bytes, { updateMetadata: false }), models: new Map() }
    e.doc.catch(() => undefined)
    entries.set(docId, e)
  }
  return { pdf: await e.doc, bytes }
}

export async function pageModel(docId: string, pageIndex: number): Promise<PageTextModel | null> {
  const d = await pdfFor(docId)
  if (!d) return null
  const e = entries.get(docId)!
  let m = e.models.get(pageIndex)
  if (!m) {
    m = extractPageText(d.pdf, pageIndex)
    e.models.set(pageIndex, m)
  }
  return m
}

useTabs.subscribe((state, prev) => {
  if (state.tabs.length >= prev.tabs.length) return
  const open = new Set(state.tabs.map((t) => t.docId))
  for (const id of [...entries.keys()]) if (!open.has(id)) entries.delete(id)
})
