/**
 * Field names. A PDF field's fully qualified name is its parents' names joined with "."; a dot inside a
 * name therefore creates a hierarchy, so builder-made names never contain one. Names are derived from the
 * nearest printed label ("Date of birth:" -> `Date_of_birth`) and made unique within the document.
 * Pure TypeScript.
 */

export const MAX_NAME_LENGTH = 48

const LIST_MARKER = /^\s*(?:\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|[•▪▫□☐■○●◦·*–—-])\s+/
const LETTERS = /[^\p{L}\p{N}_-]+/gu

/** Why a field name cannot be used, or null if it is fine (used by the properties panel). */
export function nameProblem(name: string): string | null {
  if (name === '') return 'The name cannot be empty.'
  if (/[.]/.test(name)) return 'A field name cannot contain a period (it separates parent and child fields).'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A field name cannot contain control characters.'
  if (name !== name.trim()) return 'A field name cannot start or end with a space.'
  if (name.length > 128) return 'That name is too long (128 characters at most).'
  return null
}

export const isValidFieldName = (name: string): boolean => nameProblem(name) === null

/** Turns printed label text into a tidy, valid field name (may return '' when nothing usable is left). */
export function sanitizeName(label: string, max = MAX_NAME_LENGTH): string {
  let s = label.replace(LIST_MARKER, '').trim()
  s = s.replace(/[:：*?!]+\s*$/u, '').replace(/\s*\((?:optional|required|please print|print)\)\s*$/i, '').trim()
  s = s.replace(/[\s/\\]+/g, '_').replace(LETTERS, '').replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, '')
  if (s.length > max) {
    const cut = s.slice(0, max)
    const i = cut.lastIndexOf('_')
    s = (i > max * 0.5 ? cut.slice(0, i) : cut).replace(/[_-]+$/, '')
  }
  return s
}

/** `base`, or `base_2`, `base_3`, ... that is not in `taken` (case-insensitive). Adds the result to `taken`. */
export function uniqueName(base: string, taken: Set<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  let name = base
  let n = 2
  while (lower.has(name.toLowerCase())) name = `${base}_${n++}`
  taken.add(name)
  return name
}

/** The name for a new field: from its label when there is one, else `<fallback><n>` (e.g. `Text1`). */
export function nameFor(label: string | undefined, fallback: string, taken: Set<string>): string {
  const base = label ? sanitizeName(label) : ''
  if (base) return uniqueName(base, taken)
  let n = 1
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  while (lower.has(`${fallback}${n}`.toLowerCase())) n++
  const name = `${fallback}${n}`
  taken.add(name)
  return name
}

/** An export value for a radio button / checkbox option, from its printed label. */
export function exportValueFor(label: string | undefined, index: number, taken: Set<string>): string {
  const base = label ? sanitizeName(label, 32) : ''
  if (!base) {
    let v = `Choice${index + 1}`
    let n = index + 1
    while (taken.has(v)) v = `Choice${++n}`
    taken.add(v)
    return v
  }
  let v = base
  let n = 2
  while (taken.has(v)) v = `${base}_${n++}`
  taken.add(v)
  return v
}
