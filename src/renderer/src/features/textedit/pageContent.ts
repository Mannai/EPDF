import { PDFDocument } from 'pdf-lib'
import { currentBytes } from '../../edit/session'
import { useTabs } from '../../state/tabs'
import { analyzePage, type PageAnalysis } from './pdfcontent/analyze'
import type { BlockSet } from './pdfcontent/blocks'
import { pageBlocks } from './pdfcontent/textEdit'

/**
 * Reads what is on a page (text blocks, images) from the document's current bytes, for the editing overlays.
 * One parsed pdf-lib document is kept per document version; pages are analysed on demand and cached until
 * the next edit replaces the bytes.
 */

export interface PageContent {
  analysis: PageAnalysis
  blocks: BlockSet
}

export type PageContentResult = { ok: true; content: PageContent } | { ok: false; message: string }

interface Entry {
  bytes: Uint8Array
  doc: Promise<PDFDocument>
  pages: Map<number, Promise<PageContentResult>>
}

const entries = new Map<string, Entry>()

const yieldToUi = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/encrypt/i.test(msg)) return 'This document is password protected. Remove the password before editing its content.'
  return `This page’s content could not be read safely, so it cannot be edited (${msg}).`
}

export async function loadPageContent(docId: string, pageIndex: number): Promise<PageContentResult> {
  const bytes = await currentBytes(docId)
  let e = entries.get(docId)
  if (!e || e.bytes !== bytes) {
    e = { bytes, doc: PDFDocument.load(bytes, { updateMetadata: false }), pages: new Map() }
    e.doc.catch(() => undefined)
    entries.set(docId, e)
  }
  let p = e.pages.get(pageIndex)
  if (!p) {
    const entry = e
    p = (async (): Promise<PageContentResult> => {
      try {
        const pdf = await entry.doc
        await yieldToUi()
        const analysis = analyzePage(pdf, pageIndex)
        return { ok: true, content: { analysis, blocks: pageBlocks(pdf, analysis) } }
      } catch (err) {
        return { ok: false, message: friendly(err) }
      }
    })()
    e.pages.set(pageIndex, p)
  }
  return p
}

// Free the parsed documents of closed tabs.
useTabs.subscribe((state, prev) => {
  if (state.tabs.length >= prev.tabs.length) return
  const open = new Set(state.tabs.map((t) => t.docId))
  for (const id of [...entries.keys()]) if (!open.has(id)) entries.delete(id)
})
