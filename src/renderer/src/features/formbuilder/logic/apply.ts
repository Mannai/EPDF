import type { PDFDocument } from 'pdf-lib'
import type { DetectKind, DetectResult, Proposal } from './detect'
import { detectPage } from './detect'
import { BuilderError, fieldNames } from './edit'
import { createField, detectedStyle } from './create'
import { frameForPage } from './frame'
import { nameProblem, uniqueName } from './names'
import { readPageContent } from './pageContent'
import type { FieldSpec, URect } from './spec'

/**
 * From detected proposals to real form fields. `detectDocument` runs the heuristics over pages (yielding to
 * the event loop between pages so the UI stays responsive); `applyProposals` creates the accepted fields
 * inside one `editPdf` callback, so the whole batch is a single undo step.
 */

export interface DetectProgress {
  done: number
  total: number
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Detects fields on the given pages (all pages by default). Names are unique across the document and existing fields. */
export async function detectDocument(
  pdf: PDFDocument,
  opts: { pages?: number[]; onProgress?: (p: DetectProgress) => void; shouldCancel?: () => boolean } = {}
): Promise<DetectResult[]> {
  const pages = opts.pages ?? pdf.getPages().map((_, i) => i)
  const taken = new Set(fieldNames(pdf))
  const out: DetectResult[] = []
  for (let n = 0; n < pages.length; n++) {
    if (opts.shouldCancel?.()) break
    const pc = readPageContent(pdf, pages[n])
    out.push(detectPage(pc, taken))
    opts.onProgress?.({ done: n + 1, total: pages.length })
    await tick()
  }
  return out
}

const userRect = (pdf: PDFDocument, pageIndex: number, b: { x0: number; y0: number; x1: number; y1: number }): URect => {
  const u = frameForPage(pdf.getPage(pageIndex)).boxToUser(b)
  return { x1: u.x0, y1: u.y0, x2: u.x1, y2: u.y1 }
}

/** The field a proposal stands for, in user space. */
export function proposalToSpec(pdf: PDFDocument, p: Proposal): FieldSpec {
  if (p.pageIndex < 0 || p.pageIndex >= pdf.getPageCount()) throw new BuilderError('That page does not exist.')
  const rect = userRect(pdf, p.pageIndex, p.rect)
  const base = { name: p.name, pageIndex: p.pageIndex, rect, tooltip: p.label, style: detectedStyle() }
  const k: DetectKind = p.kind
  switch (k) {
    case 'checkbox':
      return { ...base, kind: 'checkbox' }
    case 'radio':
      return {
        ...base,
        kind: 'radio',
        buttons: (p.buttons ?? []).map((b) => ({ rect: userRect(pdf, p.pageIndex, b.rect), value: b.value }))
      }
    case 'signature':
      return { ...base, kind: 'signature' }
    case 'comb':
      return { ...base, kind: 'text', comb: true, maxLength: p.cells ?? 8, style: { ...detectedStyle(), align: 'center' } }
    case 'date':
      return { ...base, kind: 'text', format: { type: 'date', format: p.dateFormat ?? 'dd/mm/yyyy' } }
    default:
      return { ...base, kind: 'text', multiline: p.multiline }
  }
}

export interface ApplyReport {
  created: string[]
  skipped: { name: string; reason: string }[]
}

/** Creates the fields for `proposals` (in order). A proposal that cannot be created is skipped and reported. */
export async function applyProposals(pdf: PDFDocument, proposals: Proposal[]): Promise<ApplyReport> {
  const report: ApplyReport = { created: [], skipped: [] }
  const taken = new Set(fieldNames(pdf))
  for (const p of proposals) {
    try {
      const spec = proposalToSpec(pdf, p)
      let name = spec.name
      if (nameProblem(name) || taken.has(name)) name = uniqueName(nameProblem(name) ? 'Field' : name, taken)
      else taken.add(name)
      spec.name = name
      report.created.push(await createField(pdf, spec))
    } catch (err) {
      report.skipped.push({ name: p.name, reason: err instanceof BuilderError || err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}
