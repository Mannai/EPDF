import { isAbsolute, resolve } from 'node:path'

/**
 * Command-line verbs used by the Explorer / Finder context-menu entries ("Convert to PDF", "Combine files"):
 *
 *   Epdf --convert-to-pdf <file> [<file>…]   convert each file to a PDF saved next to it, then open the results
 *   Epdf --combine <file> [<file>…]          open the Combine Files screen with these files preloaded
 *
 * A verb consumes every following argument up to the next `-`/`--` option. The verb and its files are removed
 * from the argv array IN PLACE so that the app's normal "open these PDFs" handling (which also reads argv)
 * does not open the same files as tabs.
 */

export type VerbName = 'convert' | 'combine'

export interface Verb {
  verb: VerbName
  /** Absolute paths, in the order given. */
  files: string[]
}

const FLAGS: Record<string, VerbName> = { '--convert-to-pdf': 'convert', '--combine': 'combine' }

/** Finds and removes the first verb (and its files) from `argv`. `cwd` resolves relative file names. Returns null if there is none. */
export function extractVerb(argv: string[], cwd: string = process.cwd()): Verb | null {
  let start = -1
  for (let i = 0; i < argv.length; i++) {
    if (Object.prototype.hasOwnProperty.call(FLAGS, argv[i].toLowerCase())) {
      start = i
      break
    }
  }
  if (start < 0) return null
  let end = start + 1
  while (end < argv.length && !argv[end].startsWith('-')) end++
  const verb = FLAGS[argv[start].toLowerCase()]
  const files = argv.slice(start + 1, end).filter((f) => f.length > 0).map((f) => (isAbsolute(f) ? f : resolve(cwd, f)))
  argv.splice(start, end - start)
  return { verb, files }
}

/** Non-mutating variant for tests and diagnostics. */
export function parseVerb(argv: string[], cwd?: string): { verb: Verb | null; rest: string[] } {
  const copy = [...argv]
  const verb = extractVerb(copy, cwd)
  return { verb, rest: copy }
}
