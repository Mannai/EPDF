import { PDFDocument } from 'pdf-lib'
import { EditError, currentBytes, editPdf } from '../../edit/session'
import { askConfirm } from '../../state/confirm'
import { confirmDelete } from '../../state/confirmDelete'
import { startJob } from '../../state/jobs'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { useUi } from '../../state/ui'
import type { PickedPdf, SavedFile } from '@shared/features/pages'
import { planDelete, planDuplicate, planInsertBlank, planInsertExternal, planReorder, planRotate, type PagePlan } from '@shared/features/pages/order'
import { applyPageSpecs } from '@shared/features/pages/pdfOps'
import { stemOf } from '@shared/features/pages/filenames'
import { formatPageList } from '@shared/features/pages/ranges'

/**
 * High-level page operations shared by the organizer and the dialogs. Each one is a single undo step
 * (`editPdf`), reports problems as toasts and announces the result for screen readers.
 */

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
export const announce = (msg: string): void => useUi.getState().announce(msg)

/** Loads bytes with pdf-lib for inspection, turning "encrypted" into a plain-language error. */
export async function loadPdfLib(bytes: Uint8Array, what = 'This file'): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (err) {
    if (err instanceof Error && /encrypt/i.test(err.message)) {
      throw new Error(`${what} is password protected, so its pages can’t be used. Open it, remove the password, save a copy, and try again.`)
    }
    throw new Error(`${what} could not be read as a PDF: ${errorMessage(err)}`)
  }
}

/** Applies a page plan as one undoable edit. Resolves true on success; failures are shown to the user. */
export async function applyPlan(docId: string, label: string, plan: PagePlan, ext?: Uint8Array, extName?: string): Promise<boolean> {
  try {
    await editPdf(docId, label, async (pdf) => {
      const extDoc = ext ? await loadPdfLib(ext, extName ? `“${extName}”` : 'The other PDF') : undefined
      await applyPageSpecs(pdf, plan.specs, { ext: extDoc })
    })
    return true
  } catch (err) {
    notify('error', err instanceof EditError ? err.message : `Couldn’t change the pages: ${errorMessage(err)}`)
    return false
  }
}

/** "Rotate page clockwise" for one page (the label the core rotate commands always used), "Rotate 3 pages clockwise" otherwise. */
export const rotateLabel = (n: number, delta: number): string =>
  `Rotate ${n === 1 ? 'page' : `${n} pages`} ${delta === 180 ? '180°' : delta > 0 ? 'clockwise' : 'counterclockwise'}`

export async function rotatePages(docId: string, numPages: number, pages: number[], delta: 90 | -90 | 180): Promise<boolean> {
  if (pages.length === 0) return false
  const ok = await applyPlan(docId, rotateLabel(pages.length, delta), planRotate(numPages, pages, delta))
  if (ok) announce(`Rotated ${plural(pages.length, 'page')} ${delta === 180 ? '180 degrees' : delta > 0 ? 'clockwise' : 'counterclockwise'}.`)
  return ok
}

/**
 * Deletes pages after asking when it is many (unless the caller `asked` already). Refuses to remove every page.
 * Returns the plan applied (or null).
 */
export async function deletePages(
  docId: string,
  numPages: number,
  pages: number[],
  opts: { asked?: boolean } = {}
): Promise<PagePlan | null> {
  const unique = [...new Set(pages)].filter((p) => p >= 0 && p < numPages)
  if (unique.length === 0) return null
  const plan = planDelete(numPages, unique)
  if (!plan) {
    notify('error', 'A PDF needs at least one page, so not every page can be deleted.')
    return null
  }
  if (unique.length >= 5 && !opts.asked) {
    const answer = await askConfirm({
      title: `Delete ${unique.length} pages?`,
      message: `Pages ${formatPageList(unique)} will be removed from the document. You can undo this until you close it.`,
      buttons: [
        { label: 'Delete', value: 'delete', variant: 'danger' },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    })
    if (answer !== 'delete') return null
  }
  const label = unique.length === 1 ? `Delete page ${unique[0] + 1}` : `Delete ${unique.length} pages`
  if (!(await applyPlan(docId, label, plan))) return null
  announce(`Deleted ${plural(unique.length, 'page')}. ${plural(numPages - unique.length, 'page')} remain.`)
  return plan
}

/**
 * Delete / Backspace on selected pages (page thumbnails, the organizer): asks first, like deleting anything else by
 * key (see confirmDelete), then deletes.
 */
export async function deletePagesByKey(docId: string, numPages: number, pages: number[]): Promise<PagePlan | null> {
  const unique = [...new Set(pages)].filter((p) => p >= 0 && p < numPages)
  if (unique.length === 0) return null
  if (!planDelete(numPages, unique)) {
    notify('error', 'A PDF needs at least one page, so not every page can be deleted.')
    return null
  }
  const what = unique.length === 1 ? `page ${unique[0] + 1}` : `${unique.length} pages`
  if (!(await confirmDelete(what))) return null
  return deletePages(docId, numPages, unique, { asked: true })
}

export async function duplicatePages(docId: string, numPages: number, pages: number[]): Promise<PagePlan | null> {
  if (pages.length === 0) return null
  const plan = planDuplicate(numPages, pages)
  if (!(await applyPlan(docId, pages.length === 1 ? `Duplicate page ${pages[0] + 1}` : `Duplicate ${pages.length} pages`, plan))) return null
  announce(`Duplicated ${plural(pages.length, 'page')}.`)
  return plan
}

export async function movePages(docId: string, numPages: number, pages: number[], slot: number): Promise<PagePlan | null> {
  const plan = planReorder(numPages, pages, slot)
  if (!plan) return null
  const label = pages.length === 1 ? `Move page ${pages[0] + 1}` : `Move ${pages.length} pages`
  return (await applyPlan(docId, label, plan)) ? plan : null
}

export async function insertBlank(
  docId: string,
  numPages: number,
  slot: number,
  size: { width: number; height: number } | 'neighbour',
  count: number
): Promise<PagePlan | null> {
  const plan = planInsertBlank(numPages, slot, size, count)
  if (!(await applyPlan(docId, count === 1 ? 'Insert blank page' : `Insert ${count} blank pages`, plan))) return null
  announce(`Inserted ${plural(count, 'blank page')}.`)
  return plan
}

export async function insertFromPdf(docId: string, numPages: number, slot: number, source: PickedPdf, pages: number[]): Promise<PagePlan | null> {
  const plan = planInsertExternal(numPages, slot, pages)
  const label = `Insert ${plural(pages.length, 'page')} from ${source.name}`
  if (!(await applyPlan(docId, label, plan, source.bytes, source.name))) return null
  announce(`Inserted ${plural(pages.length, 'page')} from ${source.name}.`)
  return plan
}

/** Saves the given pages of the current document as a new PDF, then offers to open it. */
export async function extractPagesToFile(docId: string, name: string, pages: number[]): Promise<SavedFile | null> {
  try {
    const bytes = await currentBytes(docId)
    const { promise } = startJob<Uint8Array>('pages:extract', { bytes, pages, annotations: true })
    const out = await promise
    const saved = await window.epdf.call<SavedFile | null>('pages:saveExtract', {
      docId,
      bytes: out,
      suggestedName: `${stemOf(name)} - pages ${formatPageList(pages).replace(/, /g, ',')}`
    })
    if (!saved) return null
    announce(`Saved ${plural(pages.length, 'page')} to ${saved.name}.`)
    const choice = await askConfirm({
      title: 'Pages extracted',
      message: `Saved ${plural(pages.length, 'page')} as “${saved.name}”. Open it now?`,
      buttons: [
        { label: 'Open', value: 'open', variant: 'primary' },
        { label: 'Show in folder', value: 'reveal' },
        { label: 'Done', value: 'done' }
      ],
      cancelValue: 'done'
    })
    if (choice === 'open') await window.epdf.call('pages:openSaved', { token: saved.token })
    else if (choice === 'reveal') await window.epdf.call('pages:reveal', { token: saved.token })
    return saved
  } catch (err) {
    if (err instanceof Error && err.message === 'Cancelled') return null
    notify('error', `Couldn’t extract the pages: ${errorMessage(err)}`)
    return null
  }
}

export const tabOf = (docId: string): ReturnType<typeof useTabs.getState>['tabs'][number] | undefined =>
  useTabs.getState().tabs.find((t) => t.docId === docId)
