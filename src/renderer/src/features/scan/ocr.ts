/**
 * "Recognize text" is a soft dependency: the OCR feature is built by someone else and may not exist in this build.
 * When the user ticked the option we run the command `ocr.run` for the new document; if there is no such command
 * nothing happens (and the option is not offered at all).
 */

export const OCR_COMMAND = 'ocr.run'

export interface OcrDeps {
  hasCommand(id: string): boolean
  runCommand(id: string, args?: unknown): Promise<void>
  /** Resolves when the document's tab has finished loading (so the command can read it). */
  waitReady?(docId: string): Promise<void>
}

export const isOcrAvailable = (deps: Pick<OcrDeps, 'hasCommand'>): boolean => deps.hasCommand(OCR_COMMAND)

/** Returns true if the command was started. Never throws: OCR problems must not hide a saved scan. */
export async function requestOcr(docId: string, deps: OcrDeps): Promise<boolean> {
  if (!deps.hasCommand(OCR_COMMAND)) return false
  try {
    await deps.waitReady?.(docId)
    await deps.runCommand(OCR_COMMAND, { docId })
    return true
  } catch {
    return false
  }
}
