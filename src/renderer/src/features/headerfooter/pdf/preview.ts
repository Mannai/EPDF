import { PDFDocument, PDFObjectCopier, PDFRef } from 'pdf-lib'
import type { GroupSettings } from '../../../../../shared/features/headerfooter'
import type { SourceInput } from './apply'
import { applyGroup } from './ops'

/**
 * The PDF half of the live preview: the chosen page is copied into a one-page document and the settings are applied
 * to it exactly as Apply would (same code, numbered as that page of the real document).
 */

export interface PreviewRequest {
  base: PDFDocument
  pageIndex: number
  gs: GroupSettings
  mode: 'replace' | 'add'
  source?: SourceInput
  fileName: string
  /** Draw the marks (false: the page as it is, e.g. outside the page range). */
  withMarks: boolean
  now?: Date
}

export async function previewBytes(r: PreviewRequest): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const [copy] = await doc.copyPages(r.base, [r.pageIndex])
  doc.addPage(copy)
  if (r.withMarks) {
    let source = r.source
    if (source && 'ref' in source) {
      // The earlier picture lives in the real document: copy it over.
      const copied = PDFObjectCopier.for(r.base.context, doc.context).copy(source.ref)
      source = copied instanceof PDFRef ? { ref: copied } : undefined
    }
    await applyGroup(doc, r.gs, { mode: r.mode, source, fileName: r.fileName, now: r.now, numPages: r.base.getPageCount(), only: [{ index: r.pageIndex, page: doc.getPage(0) }] })
  }
  return doc.save()
}
