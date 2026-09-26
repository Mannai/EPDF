import { PDFDocument } from 'pdf-lib'
import { EditError, currentBytes, editPdf, ensureEditable } from '../../edit/session'
import { errorMessage, notify } from '../../state/notify'
import { useUi } from '../../state/ui'
import type { GroupSettings, MarkGroup } from '@shared/features/headerfooter'
import { isTextEngineConfigured } from '@shared/text/env'
import { useRendererResources } from '@shared/text/renderer'
import { ApplyCancelled, type SourceInput } from './pdf/apply'
import { applyGroup, removeGroup } from './pdf/ops'
import { summarizeMarks, type MarkSummary } from './pdf/remove'
import { GROUP_NOUN } from './store'

/** The page-marks operations as the UI runs them: through the edit pipeline (one undo step each), with friendly errors. */

let flip = false
export function announce(msg: string): void {
  flip = !flip
  useUi.getState().announce(msg + (flip ? '' : ' '))
}

/** The text engine reads its fonts and WebAssembly from main; set that up once per window. */
export function ensureTextEngine(): void {
  if (!isTextEngineConfigured()) useRendererResources()
}

class NothingToRemove extends Error {}

export interface LoadedForDialog {
  pdf: PDFDocument
  summary: MarkSummary
}

/** Reads the document (unlocking it first if it is protected) for the dialog: preview pages and what is on it already. */
export async function loadForDialog(docId: string): Promise<LoadedForDialog | null> {
  if (!(await ensureEditable(docId))) return null
  const bytes = await currentBytes(docId)
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false })
  return { pdf, summary: summarizeMarks(pdf) }
}

const verb: Record<MarkGroup, string> = { headerfooter: 'header and footer', bates: 'Bates numbers', watermark: 'watermark', background: 'background' }

export function applyLabel(group: MarkGroup, mode: 'replace' | 'add', updating: boolean): string {
  if (updating && mode === 'replace') return `Update ${verb[group]}`
  return `Add ${verb[group]}`
}

export interface ApplyRequest {
  docId: string
  gs: GroupSettings
  mode: 'replace' | 'add'
  source?: SourceInput
  fileName: string
  label: string
  onProgress?(done: number, total: number): void
  isCancelled?(): boolean
}

export type ApplyOutcome = { ok: true; pages: number; missing: string[] } | { ok: false; cancelled: boolean; message: string }

export async function applyAction(r: ApplyRequest): Promise<ApplyOutcome> {
  ensureTextEngine()
  let pages = 0
  let missing: string[] = []
  try {
    await editPdf(r.docId, r.label, async (pdf) => {
      const res = await applyGroup(pdf, r.gs, { mode: r.mode, source: r.source, fileName: r.fileName, yieldEvery: 8, onProgress: r.onProgress, isCancelled: r.isCancelled })
      pages = res.pages
      missing = res.missing
    })
  } catch (err) {
    if (err instanceof ApplyCancelled || (err instanceof Error && err.message === 'Cancelled.')) return { ok: false, cancelled: true, message: 'Cancelled. The document was not changed.' }
    return { ok: false, cancelled: false, message: err instanceof EditError ? err.message : errorMessage(err) }
  }
  void window.epdf.call('headerfooter:setLast', { group: r.gs.group, settings: r.gs.settings }).catch(() => undefined)
  return { ok: true, pages, missing }
}

/** Removes a group's marks (Epdf's and, except for Bates, Acrobat-style ones) from the whole document. */
export async function removeAction(docId: string, group: MarkGroup): Promise<boolean> {
  if (!(await ensureEditable(docId))) return false
  const noun = GROUP_NOUN[group]
  let removed = 0
  try {
    await editPdf(docId, `Remove ${noun}`, async (pdf) => {
      const r = await removeGroup(pdf, group, { yieldEvery: 25 })
      removed = r.pages
      if (r.pages === 0) throw new NothingToRemove()
    })
  } catch (err) {
    if (err instanceof NothingToRemove) {
      notify('info', `This document has no ${noun} to remove.`)
      return false
    }
    notify('error', err instanceof EditError ? err.message : `Couldn’t remove the ${noun}: ${errorMessage(err)}`)
    return false
  }
  const msg = `Removed the ${noun} from ${removed} page${removed === 1 ? '' : 's'}.`
  notify('success', msg)
  announce(msg)
  return true
}
