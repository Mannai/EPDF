/** Turns whatever PDF.js (or the password prompt) threw while opening an input into a sentence for the user. */

/** A problem with one of the inputs that the user can act on; the message is shown as is. */
export class CompareInputError extends Error {}

const nameOf = (err: unknown): string => (err as { name?: string } | null)?.name ?? ''
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err ?? ''))

/** PDF.js says "PasswordException"; Epdf's own prompt says the password was refused (declined) by the user. */
export const isPasswordError = (err: unknown): boolean =>
  nameOf(err) === 'PasswordException' || (err instanceof Error && err.constructor.name === 'PasswordCancelledError') || /password is required/i.test(messageOf(err))

export function describeOpenError(err: unknown, name: string): string {
  if (isPasswordError(err)) {
    return `“${name}” is password protected and no password was given. Open it in Epdf and enter its password, then choose it again from the open tabs.`
  }
  if (/InvalidPDF|Format|MissingPDF|UnexpectedResponse/i.test(nameOf(err)) || /Invalid PDF|not a PDF|XRef|Missing PDF|End of PDF/i.test(messageOf(err))) {
    return `“${name}” could not be read: it is damaged or is not a PDF file.`
  }
  return `“${name}” could not be opened: ${messageOf(err)}`
}
