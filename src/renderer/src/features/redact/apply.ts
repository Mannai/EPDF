import { PDFDocument } from 'pdf-lib'
import { EditError, currentBytes, editPdf, undo } from '../../edit/session'
import { useTabs } from '../../state/tabs'
import { pdfFor } from './doc'
import { RedactRefused, redactDocumentAsync, summarize, type MarkInput, type RedactOutcome, type RedactReport } from './logic/redact'
import { verifyRedaction, type Finding } from './logic/verify'
import { modelPageTexts, pdfjsPageTexts } from './pdfjsText'
import { settingsToOptions, useRedact, type UiMark } from './store'

export const APPLY_LABEL = 'Apply redactions'

export const toInputs = (marks: readonly UiMark[]): MarkInput[] => marks.map((m) => ({ id: m.id, pageIndex: m.pageIndex, rects: m.rects, quads: m.quads, text: m.text }))

export type ApplyResult =
  | { ok: true; report: RedactReport; summary: string }
  | { ok: false; kind: 'refused' | 'verify' | 'locked' | 'error'; message: string; findings?: Finding[] }

export interface PreviewResult {
  ok: true
  bytes: Uint8Array
  report: RedactReport
  findings: Finding[]
}

class VerifyFailed extends Error {
  constructor(readonly findings: Finding[]) {
    super('The self-check found redacted content that is still in the file.')
  }
}

const verifyInput = (outcome: RedactOutcome, bytes: Uint8Array): Parameters<typeof verifyRedaction>[0] => ({
  bytes,
  marksByPage: outcome.marksByPage,
  shapesByPage: outcome.shapesByPage,
  secrets: outcome.secrets,
  pdfjsPages: pdfjsPageTexts,
  modelPages: modelPageTexts
})

/**
 * Runs the whole redaction on a private copy of the document and returns the result without touching the open
 * document, so the user can look at exactly what will be removed. Never throws: problems come back as `ok:false`.
 */
export async function previewRedactions(docId: string, marks: readonly UiMark[], onProgress?: (done: number, total: number) => void): Promise<PreviewResult | Extract<ApplyResult, { ok: false }>> {
  try {
    const d = await pdfFor(docId)
    if (!d) return { ok: false, kind: 'locked', message: 'This document is password protected. Unlock it to redact it.' }
    const pdf = await PDFDocument.load(d.bytes, { updateMetadata: false })
    const outcome = await redactDocumentAsync(pdf, toInputs(marks), settingsToOptions(useRedact.getState().settings), onProgress)
    const bytes = await pdf.save()
    const findings = await verifyRedaction(verifyInput(outcome, bytes))
    return { ok: true, bytes, report: outcome.report, findings }
  } catch (e) {
    if (e instanceof RedactRefused) return { ok: false, kind: 'refused', message: e.message }
    return { ok: false, kind: 'error', message: `The redaction could not be prepared: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Applies the marks as ONE undo step through the edit pipeline. The result is verified twice before it is kept:
 * inside the edit (nothing is committed if anything of the redacted content is found) and again on the bytes that
 * were actually committed (rolled back if that ever fails).
 */
export async function applyRedactions(docId: string, marks: readonly UiMark[], onProgress?: (done: number, total: number) => void): Promise<ApplyResult> {
  const settings = useRedact.getState().settings
  const inputs = toInputs(marks)
  let outcome: RedactOutcome | undefined
  try {
    if (!(await pdfFor(docId))) return { ok: false, kind: 'locked', message: 'This document is password protected. Unlock it to redact it.' }
    await editPdf(docId, APPLY_LABEL, async (pdf) => {
      outcome = await redactDocumentAsync(pdf, inputs, settingsToOptions(settings), onProgress)
      const trial = await pdf.save()
      const findings = await verifyRedaction(verifyInput(outcome, trial))
      if (findings.length) throw new VerifyFailed(findings)
    }, { tags: ['redaction'] }) // REDACTION_TAG in ./purge: a save of this state offers the history purge
  } catch (e) {
    if (e instanceof VerifyFailed) return { ok: false, kind: 'verify', message: e.message, findings: e.findings }
    if (e instanceof RedactRefused) return { ok: false, kind: 'refused', message: e.message }
    if (e instanceof EditError) return { ok: false, kind: 'error', message: e.message }
    return { ok: false, kind: 'error', message: `The redaction failed and nothing was changed: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!outcome) return { ok: false, kind: 'error', message: 'The redaction did not run.' }
  // second, independent look at exactly what was committed
  const committed = await currentBytes(docId)
  const findings = await verifyRedaction(verifyInput(outcome, committed))
  if (findings.length) {
    await undo(docId)
    return { ok: false, kind: 'verify', message: 'The committed result failed the self-check and was rolled back.', findings }
  }
  const path = useTabs.getState().tabs.find((t) => t.docId === docId)?.path ?? ''
  useRedact.getState().markPending(docId, path)
  return { ok: true, report: outcome.report, summary: summarize(outcome.report) }
}
