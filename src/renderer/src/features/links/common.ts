import { PDFDocument } from 'pdf-lib'
import { EditError, currentBytes, editPdf, ensureEditable } from '../../edit/session'
import { errorMessage, notify } from '../../state/notify'
import { useUi } from '../../state/ui'

/** Helpers shared by the links and bookmarks features: announcements, edits with friendly errors, reading the current bytes. */

let flip = false
/** Speaks a status message through the app's live region (a changed string is re-read, so alternate a trailing space). */
export function announce(msg: string): void {
  flip = !flip
  useUi.getState().announce(msg + (flip ? '' : ' '))
}

/** Errors whose message is already written for the user (thrown by our pdf operations and the edit pipeline). */
export class UserError extends Error {}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

/**
 * Runs one edit through the pipeline (one undo step named `label`). Resolves with the callback's result, or
 * undefined after reporting why it failed. Encrypted documents are unlocked by the Security feature's hook.
 */
export async function runEdit<T>(
  docId: string,
  label: string,
  fn: (pdf: PDFDocument) => Promise<T> | T,
  isUserError: (err: unknown) => boolean = () => false
): Promise<T | undefined> {
  let out: T | undefined
  try {
    await editPdf(docId, label, async (pdf) => {
      out = await fn(pdf)
    })
    return out
  } catch (err) {
    const message = err instanceof EditError || err instanceof UserError || isUserError(err) ? (err as Error).message : `Couldn’t ${lowerFirst(label)}: ${errorMessage(err)}`
    notify('error', message)
    return undefined
  }
}

export type ReadResult = { ok: true; pdf: PDFDocument; bytes: Uint8Array } | { ok: false; reason: 'encrypted' | 'failed'; message: string }

/** Loads the document's current bytes with pdf-lib for READING (nothing is written). */
export async function readCurrent(docId: string): Promise<ReadResult> {
  let bytes: Uint8Array
  try {
    bytes = await currentBytes(docId)
  } catch (err) {
    return { ok: false, reason: 'failed', message: errorMessage(err) }
  }
  try {
    return { ok: true, pdf: await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false }), bytes }
  } catch (err) {
    const encrypted = err instanceof Error && /encrypt/i.test(err.message)
    return { ok: false, reason: encrypted ? 'encrypted' : 'failed', message: errorMessage(err) }
  }
}

/** Asks for the password when the document is protected (false = the user declined). */
export const unlock = (docId: string): Promise<boolean> => ensureEditable(docId)

export const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
